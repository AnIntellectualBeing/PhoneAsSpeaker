#!/usr/bin/env node
/*
 * SyncSpeaker PC server. Zero dependencies (Node 18+).
 *
 *  - Serves the listener page (web/listener) at  /        -> the same page the Android app serves
 *  - Serves the PC host page   (web/pc-host)  at  /host   -> "Share audio" from Chrome
 *  - WebSocket at /ws: answers clock pings, relays timestamped audio from the host page to all
 *    listeners (same protocol as the Android app; see PROTOCOL.md).
 *  - Test sources (--tone, --beeps, --wav FILE): the server itself generates timestamped audio,
 *    imitating the Android host so you can test listeners without a phone.
 *
 * Usage:
 *   node server/server.js                 # PC host mode: open http://localhost:8080/host
 *   node server/server.js --beeps         # test: a short beep every second (great for checking sync)
 *   node server/server.js --tone 440      # test: continuous sine tone
 *   node server/server.js --wav song.wav  # test: loop a 16-bit PCM WAV file
 *   Options: --port 8080  --delay 1000  --host 0.0.0.0
 *            --jitter 40   (testing: delay every message to listeners by 0-40 ms, like bad Wi-Fi)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { WebSocketServer } = require('./ws-lite');
const { generators, readWav } = require('./test-sources');

const ROOT = path.resolve(__dirname, '..');
const LISTENER_DIR = path.join(ROOT, 'web', 'listener');
const HOST_DIR = path.join(ROOT, 'web', 'pc-host');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** Monotonic server clock in ms: the "host clock" in PC mode. */
const hostNow = () => performance.now();

function parseArgs(argv) {
  const opts = { port: 8080, host: '0.0.0.0', delayMs: 1000, source: null, toneHz: 440, wav: null, quiet: false, jitterMs: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') opts.port = parseInt(next(), 10);
    else if (a === '--host') opts.host = next();
    else if (a === '--delay') opts.delayMs = parseInt(next(), 10);
    else if (a === '--beeps') opts.source = 'beeps';
    else if (a === '--tone') {
      opts.source = 'tone';
      if (argv[i + 1] && /^\d/.test(argv[i + 1])) opts.toneHz = parseFloat(next());
    } else if (a === '--wav') { opts.source = 'wav'; opts.wav = next(); }
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--jitter') opts.jitterMs = parseFloat(next());
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function createServer(options = {}) {
  const opts = Object.assign(parseArgs([]), options);
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  const sessionId = crypto.randomBytes(4).toString('hex');

  let format = { codec: 'pcm_s16le', sampleRate: 48000, channels: 2 };
  let delayMs = opts.delayMs;
  const listeners = new Set();
  let hostSocket = null;
  let testTimer = null;
  let testStart = null;

  // ---------------------------------------------------------------- HTTP
  function sendFile(res, file, head) {
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Length': data.length,
      });
      res.end(head ? undefined : data);
    });
  }

  function resolveStatic(urlPath) {
    let p;
    try { p = decodeURIComponent(urlPath.split('?')[0]); } catch (e) { return null; }
    let dir = LISTENER_DIR;
    if (p === '/host' || p === '/host/') p = '/host/host.html';
    if (p.startsWith('/host/')) { dir = HOST_DIR; p = p.slice('/host'.length); }
    if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(dir, p));
    if (!file.startsWith(dir + path.sep)) return null; // path traversal
    return file;
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    const urlPath = req.url.split('?')[0];
    if (urlPath === '/status.json' || urlPath === '/api/info') {
      const body = JSON.stringify({
        listeners: listeners.size,
        listenerList: listenerList(),
        session: sessionId,
        hostConnected: !!hostSocket,
        testSource: opts.source,
        delayMs,
        format,
        port: server.address() && server.address().port,
        addresses: lanAddresses(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(body);
      return;
    }
    // Shared engine: the host page loads the very same file as listeners.
    const file = resolveStatic(urlPath === '/host/syncspeaker.js' ? '/syncspeaker.js' : urlPath);
    if (!file) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    sendFile(res, file, req.method === 'HEAD');
  });

  // ---------------------------------------------------------------- WebSocket
  const helloMessage = () => JSON.stringify({
    type: 'hello', protocol: 1, codec: format.codec, sampleRate: format.sampleRate,
    channels: format.channels, delayMs, session: sessionId, serverTime: hostNow(),
  });

  // Optional network-jitter simulation (in-order, random extra delay per message).
  function deliver(ws, fn) {
    if (!opts.jitterMs || ws === hostSocket) { fn(); return; }
    const now = Date.now();
    const due = Math.max(ws.jitterDue || 0, now + Math.random() * opts.jitterMs);
    ws.jitterDue = due;
    setTimeout(fn, due - now);
  }

  function broadcastText(text) {
    for (const l of listeners) deliver(l, () => l.sendText(text));
  }

  function broadcastAudio(buf) {
    for (const l of listeners) {
      // Drop audio for a listener whose socket is backed up (weak Wi-Fi); it will re-sync.
      if (l.bufferedAmount > 3 * 192000) { l.dropped = (l.dropped || 0) + 1; continue; }
      deliver(l, () => l.sendBinary(buf));
    }
  }

  function listenerList() {
    return [...listeners].map((l) => Object.assign({ name: 'Phone', state: 'connecting', syncMs: null }, l.report || {}));
  }

  function notifyHost() {
    if (hostSocket) hostSocket.sendText(JSON.stringify({ type: 'listeners', count: listeners.size, list: listenerList() }));
  }
  const notifyTimer = setInterval(notifyHost, 2000);

  const wss = new WebSocketServer(server, { path: '/ws' });
  wss.on('connection', (ws, req) => {
    const role = /[?&]role=host\b/.test(req.url) ? 'host' : 'listener';
    const remote = req.socket.remoteAddress;

    if (role === 'host') {
      if (opts.source) {
        ws.sendText(JSON.stringify({ type: 'error', message: 'Server is running a test source (--' + opts.source + '); restart it without that option to share audio.' }));
        ws.close(1008, 'test source active');
        return;
      }
      if (hostSocket) {
        hostSocket.sendText(JSON.stringify({ type: 'error', message: 'Another host page took over.' }));
        hostSocket.close(1000, 'replaced');
      }
      hostSocket = ws;
      log(`Host page connected (${remote})`);
      ws.sendText(JSON.stringify({ type: 'welcome', session: sessionId, delayMs, addresses: lanAddresses() }));
      notifyHost();
    } else {
      listeners.add(ws);
      log(`Listener connected: ${remote} (total ${listeners.size})`);
      ws.sendText(helloMessage());
      notifyHost();
    }

    ws.on('text', (text) => {
      const t1 = hostNow();
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (msg.type === 'report' && role === 'listener') {
        ws.report = {
          name: String(msg.name || 'Phone').slice(0, 24),
          state: String(msg.state || 'unknown').slice(0, 16),
          syncMs: Number.isFinite(msg.syncMs) ? msg.syncMs : null,
        };
      } else if (msg.type === 'ping') {
        deliver(ws, () => ws.sendText(JSON.stringify({ type: 'pong', id: msg.id, t0: msg.t0, t1, t2: hostNow() })));
      } else if (role === 'host' && ws === hostSocket) {
        if (msg.type === 'format') {
          format = { codec: msg.codec || 'pcm_s16le', sampleRate: msg.sampleRate | 0, channels: msg.channels | 0 };
          log(`Host format: ${format.codec} ${format.sampleRate} Hz x${format.channels}`);
          broadcastText(helloMessage());
        } else if (msg.type === 'config' && Number.isFinite(msg.delayMs)) {
          delayMs = Math.max(200, Math.min(5000, Math.round(msg.delayMs)));
          log(`Delay set to ${delayMs} ms`);
          broadcastText(helloMessage());
        }
      }
    });

    ws.on('binary', (buf) => {
      if (role === 'host' && ws === hostSocket && buf.length > 8) broadcastAudio(buf);
    });

    ws.on('close', () => {
      if (role === 'host') {
        if (hostSocket === ws) hostSocket = null;
        log('Host page disconnected');
      } else {
        listeners.delete(ws);
        log(`Listener disconnected: ${remote} (total ${listeners.size})`);
        notifyHost();
      }
    });
  });

  // ---------------------------------------------------------------- Test sources
  function startTestSource() {
    if (!opts.source) return;
    let gen;
    if (opts.source === 'wav') {
      const wav = readWav(opts.wav);
      format = { codec: 'pcm_s16le', sampleRate: wav.sampleRate, channels: wav.channels };
      gen = generators.wav(wav);
    } else {
      gen = generators[opts.source](format.sampleRate, format.channels, { hz: opts.toneHz });
    }
    const chunkFrames = Math.round(format.sampleRate / 50); // 20 ms
    const chunkMs = chunkFrames * 1000 / format.sampleRate;
    const start = hostNow();
    testStart = start;
    let frameIndex = 0;
    // Send every chunk whose capture time has passed. Timestamps are exact multiples of the
    // chunk length, like a perfect capture clock (the Android app smooths real ones similarly).
    const tick = () => {
      const now = hostNow();
      while (start + (frameIndex + chunkFrames) * 1000 / format.sampleRate <= now) {
        const ts = start + frameIndex * 1000 / format.sampleRate;
        const pcm = gen(frameIndex, chunkFrames, ts);
        frameIndex += chunkFrames;
        const buf = Buffer.alloc(8 + pcm.byteLength);
        buf.writeDoubleLE(ts, 0);
        Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 8);
        broadcastAudio(buf);
      }
    };
    testTimer = setInterval(tick, Math.max(5, chunkMs / 4));
    log(`Test source: ${opts.source}${opts.source === 'tone' ? ' ' + opts.toneHz + ' Hz' : ''}${opts.wav ? ' ' + opts.wav : ''}`);
  }

  return {
    server,
    get listenerCount() { return listeners.size; },
    /** Host-clock time of frame 0 of the test source (beeps start on every whole second after it). */
    get testStart() { return testStart; },
    get delayMs() { return delayMs; },
    sessionId,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host, () => {
          startTestSource();
          resolve(server.address().port);
        });
      });
    },
    close() {
      clearInterval(testTimer);
      clearInterval(notifyTimer);
      wss.closeAll();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 20).join('\n'));
    return;
  }
  const app = createServer(opts);
  let port;
  try {
    port = await app.listen();
  } catch (e) {
    console.error(`Cannot listen on port ${opts.port}: ${e.message}`);
    process.exit(1);
  }
  console.log('\nSyncSpeaker server is running.\n');
  if (!opts.source) console.log(`  PC host page (open on THIS computer):  http://localhost:${port}/host`);
  else console.log(`  Test source:  ${opts.source}  (no host page needed)`);
  console.log('  Listeners (phones on the same Wi-Fi):');
  const addrs = lanAddresses();
  if (!addrs.length) console.log(`    http://localhost:${port}/   (no LAN address found)`);
  for (const a of addrs) console.log(`    http://${a.address}:${port}/   (${a.name})`);
  console.log('');
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createServer, parseArgs, lanAddresses };
