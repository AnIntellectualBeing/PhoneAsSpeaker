/*
 * Minimal RFC 6455 WebSocket server (no dependencies). Supports text/binary messages,
 * fragmentation, ping/pong and close. No extensions (permessage-deflate is not negotiated).
 */
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    socket.setNoDelay(true); // pongs must not wait for Nagle
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
  }

  get bufferedAmount() { return this.socket.writableLength; }

  sendText(text) { this._send(0x1, Buffer.from(text, 'utf8')); }
  sendBinary(buf) { this._send(0x2, Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._send(0x8, payload);
    this.socket.end();
    this._finish();
  }

  _send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.cork();
    this.socket.write(header);
    this.socket.write(payload);
    process.nextTick(() => this.socket.uncork());
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    if (!this.socket.destroyed) this.socket.destroy();
    this.emit('close');
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) { this.close(1009, 'too big'); return; }
        len = Number(big); off = 10;
      }
      if (!masked) { this.close(1002, 'client frames must be masked'); return; }
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.from(b.subarray(off, off + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(off + len);
      this._onFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode === 0x8) { // close
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      this.close(code === 1005 ? 1000 : code);
      return;
    }
    if (opcode === 0x9) { this._send(0xA, payload); return; } // ping -> pong
    if (opcode === 0xA) return; // pong
    if (opcode === 0x0) { // continuation
      this.fragments.push(payload);
      if (fin) {
        const msg = Buffer.concat(this.fragments);
        this.fragments = [];
        this._emitMessage(this.fragmentOpcode, msg);
      }
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) this._emitMessage(opcode, payload);
      else { this.fragmentOpcode = opcode; this.fragments = [payload]; }
      return;
    }
    this.close(1002, 'unknown opcode');
  }

  _emitMessage(opcode, payload) {
    if (opcode === 0x1) this.emit('text', payload.toString('utf8'));
    else this.emit('binary', payload);
  }
}

class WebSocketServer extends EventEmitter {
  constructor(httpServer, { path = '/ws' } = {}) {
    super();
    this.connections = new Set();
    httpServer.on('upgrade', (req, socket) => {
      const urlPath = req.url.split('?')[0];
      const key = req.headers['sec-websocket-key'];
      if (urlPath !== path || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      const ws = new WsConnection(socket);
      this.connections.add(ws);
      ws.on('close', () => this.connections.delete(ws));
      this.emit('connection', ws, req);
    });
  }

  closeAll() {
    for (const ws of this.connections) ws.close(1001, 'server shutting down');
  }
}

module.exports = { WebSocketServer, WsConnection };
