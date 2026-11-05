#!/usr/bin/env node
/*
 * Dependency-free tests (Node 22+: uses the built-in WebSocket client and node:test).
 *   node server/test/run-tests.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const S = require('../../web/listener/syncspeaker.js');
const { createServer } = require('../server');
const { readWav, generators } = require('../test-sources');

// Deterministic pseudo-random numbers.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ------------------------------------------------------------------------------------ ClockSync

test('ClockSync finds the offset despite jittery, asymmetric delays', () => {
  const rand = rng(42);
  const trueOffset = 123456.789; // host - local
  const cs = new S.ClockSync();
  let local = 1000;
  for (let i = 0; i < 40; i++) {
    local += 100;
    const ping = cs.makePing(local);
    // Uplink 2-4 ms, downlink sometimes stuck behind audio packets (up to +40 ms).
    const up = 2 + rand() * 2;
    const down = 2 + rand() * 2 + (rand() < 0.6 ? rand() * 40 : 0);
    const t1 = local + up + trueOffset;
    const t2 = t1 + 0.2;
    const t3 = local + up + 0.2 + down;
    assert.ok(cs.handlePong({ type: 'pong', id: ping.id, t0: ping.t0, t1, t2 }, t3));
  }
  assert.ok(cs.ready);
  assert.ok(Math.abs(cs.offset - trueOffset) < 1.5, `offset error ${cs.offset - trueOffset}`);
  assert.ok(cs.minRtt < 6);
});

test('ClockSync ignores unknown pongs and follows slow drift', () => {
  const cs = new S.ClockSync();
  assert.equal(cs.handlePong({ id: 999, t0: 0, t1: 0, t2: 0 }, 1), false);
  const rand = rng(7);
  const drift = 50e-6; // host clock runs 50 ppm fast
  let local = 0;
  let maxErr = 0;
  for (let i = 0; i < 150; i++) { // 5 minutes, one ping every 2 s
    local += 2000;
    const ping = cs.makePing(local);
    const up = 1 + rand() * 3, down = 1 + rand() * 3;
    const hostAt = (l) => 5000 + l * (1 + drift);
    const t1 = hostAt(local + up);
    const t3 = local + up + 0.1 + down;
    cs.handlePong({ id: ping.id, t0: ping.t0, t1, t2: t1 + 0.1 }, t3);
    if (i > 10) maxErr = Math.max(maxErr, Math.abs(cs.localToHost(t3) - hostAt(t3)));
  }
  assert.ok(maxErr < 3, `drift tracking error ${maxErr}`);
});

// ------------------------------------------------------------------------------ PlaybackScheduler

function simulate({ chunks = 3000, jitterMs = 1, driftPpm = 100, networkJitterMs = 30, seed = 1, offsetJumpAt = -1, jumpMs = 0 }) {
  const rand = rng(seed);
  const sch = new S.PlaybackScheduler();
  const durS = 0.02;
  const delayS = 1.0;
  const out = { errs: [], rates: [], drops: 0, gaps: 0 };
  let lastEnd = null;
  for (let i = 0; i < chunks; i++) {
    const tsMs = 1e6 + i * 20;
    // Chunk arrives after network jitter; "now" in context seconds (context started at host 1e6 ms).
    const arrival = (tsMs - 1e6) / 1000 + rand() * networkJitterMs / 1000;
    let ideal = (tsMs - 1e6) / 1000 * (1 + driftPpm * 1e-6) + delayS + (rand() - 0.5) * 2 * jitterMs / 1000;
    if (offsetJumpAt >= 0 && i >= offsetJumpAt) ideal += jumpMs / 1000;
    const plan = sch.plan(tsMs, durS, ideal, arrival);
    if (plan.action !== 'play') { out.drops++; lastEnd = null; continue; }
    if (lastEnd !== null && Math.abs(plan.when - lastEnd) > 1e-9) out.gaps++;
    lastEnd = plan.when + durS / plan.rate;
    const trueIdeal = (tsMs - 1e6) / 1000 * (1 + driftPpm * 1e-6) + delayS + (offsetJumpAt >= 0 && i >= offsetJumpAt ? jumpMs / 1000 : 0);
    out.errs.push((plan.when - trueIdeal) * 1000);
    out.rates.push(plan.rate);
  }
  out.resyncs = sch.stats.resyncs;
  return out;
}

test('Scheduler plays gaplessly and tracks drift + measurement noise', () => {
  const r = simulate({});
  assert.equal(r.drops, 0);
  assert.equal(r.gaps, 0, 'chunks must be back to back');
  const late = r.errs.slice(500).map(Math.abs);
  assert.ok(Math.max(...late) < 4, `max error ${Math.max(...late)} ms`);
  assert.ok(r.rates.every((x) => Math.abs(x - 1) <= 0.005 + 1e-12));
});

test('Scheduler gently absorbs a small offset change and hard re-syncs a big one', () => {
  const small = simulate({ offsetJumpAt: 1000, jumpMs: 10 });
  assert.equal(small.resyncs, 0);
  assert.ok(Math.abs(small.errs[small.errs.length - 1]) < 3, 'small jump corrected smoothly');
  const big = simulate({ offsetJumpAt: 1000, jumpMs: 200 });
  assert.equal(big.resyncs, 1);
  assert.ok(Math.abs(big.errs[big.errs.length - 1]) < 3);
});

test('Scheduler drops chunks that arrive too late', () => {
  const sch = new S.PlaybackScheduler();
  assert.equal(sch.plan(0, 0.02, 1.0, 0.99).action, 'drop');
  assert.equal(sch.stats.dropped, 1);
  const p = sch.plan(20, 0.02, 2.0, 0.5);
  assert.equal(p.action, 'play');
  assert.equal(p.when, 2.0);
});

// ------------------------------------------------------------------------------ misc engine bits

test('Packet encode/decode round trip', () => {
  const pcm = new Int16Array([1, -2, 32767, -32768]);
  const buf = S.encodePacket(987654.321, pcm);
  assert.equal(buf.byteLength, 8 + 8);
  const d = S.decodePacket(buf);
  assert.equal(d.timestampMs, 987654.321);
  assert.deepEqual(Array.from(d.pcm), [1, -2, 32767, -32768]);
});

test('ChunkTimestamper (JS twin of the Kotlin one) is continuous under jitter', () => {
  const ts = new S.ChunkTimestamper(48000);
  const rand = rng(3);
  let prev = NaN;
  for (let i = 0; i < 500; i++) {
    const t = ts.timestampFor(i * 960, 1000 + i * 20 + (rand() - 0.5) * 6);
    if (!Number.isNaN(prev)) assert.ok(Math.abs(t - prev - 20) < 0.1);
    prev = t;
  }
  assert.equal(ts.discontinuities, 0);
  // One spike is ignored; a persistent jump re-anchors after 3 chunks.
  const spike = ts.timestampFor(500 * 960, 1000 + 500 * 20 + 90);
  assert.ok(Math.abs(spike - (prev + 20)) < 0.5);
  let t;
  for (let k = 501; k <= 503; k++) t = ts.timestampFor(k * 960, 1000 + k * 20 + 300);
  assert.equal(t, 1000 + 503 * 20 + 300);
  assert.equal(ts.discontinuities, 1);
});

test('WAV reader + generators', () => {
  const file = path.join(os.tmpdir(), `ss-test-${process.pid}.wav`);
  const n = 480;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(192000, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n * 2; i++) b.writeInt16LE(i, 44 + i * 2);
  fs.writeFileSync(file, b);
  const wav = readWav(file);
  fs.unlinkSync(file);
  assert.equal(wav.sampleRate, 48000);
  assert.equal(wav.channels, 2);
  assert.equal(wav.samples[5], 5);
  const looped = generators.wav(wav)(n - 1, 2);
  assert.deepEqual(Array.from(looped), [958, 959, 0, 1]);
  const beeps = generators.beeps(48000, 2)(0, 960);
  assert.ok(Math.abs(beeps[2]) > 1000 || Math.abs(beeps[4]) > 1000, 'beep starts at frame 0');
  const quiet = generators.beeps(48000, 2)(24000, 960);
  assert.ok(quiet.every((x) => x === 0));
});

// ------------------------------------------------------------------------------ server integration

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject);
  });
}

function wsClient(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const queue = [];
  const waiters = [];
  ws.onmessage = (ev) => {
    const item = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
    const w = waiters.findIndex((x) => x.pred(item));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(item);
    else queue.push(item);
  };
  ws.next = (pred, timeout = 3000) => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { pred, resolve };
      waiters.push(entry);
      setTimeout(() => {
        const idx = waiters.indexOf(entry);
        if (idx >= 0) { waiters.splice(idx, 1); reject(new Error('timeout waiting for message')); }
      }, timeout);
    });
  };
  ws.opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return ws;
}

const isText = (type) => (m) => !(m instanceof ArrayBuffer) && m.type === type;
const isBinary = (m) => m instanceof ArrayBuffer;

test('Server: static files and path traversal', async () => {
  const app = createServer({ port: 0, host: '127.0.0.1', quiet: true });
  const port = await app.listen();
  try {
    const root = await get(port, '/');
    assert.equal(root.status, 200);
    assert.match(root.type, /text\/html/);
    assert.match(root.body, /Join Party/);
    const host = await get(port, '/host');
    assert.equal(host.status, 200);
    assert.match(host.body, /Share audio/);
    assert.equal((await get(port, '/syncspeaker.js')).status, 200);
    assert.equal((await get(port, '/host/syncspeaker.js')).status, 200);
    assert.notEqual((await get(port, '/..%2f..%2fpackage.json')).status, 200);
    assert.notEqual((await get(port, '/../server/server.js')).status, 200);
    assert.equal((await get(port, '/nope.js')).status, 404);
    const info = JSON.parse((await get(port, '/api/info')).body);
    assert.equal(info.listeners, 0);
  } finally {
    await app.close();
  }
});

test('Server test source: hello, pong, continuous timestamped chunks', async () => {
  const app = createServer({ port: 0, host: '127.0.0.1', quiet: true, source: 'tone', delayMs: 800 });
  const port = await app.listen();
  const ws = wsClient(`ws://127.0.0.1:${port}/ws`);
  try {
    await ws.opened;
    const hello = await ws.next(isText('hello'));
    assert.equal(hello.sampleRate, 48000);
    assert.equal(hello.channels, 2);
    assert.equal(hello.delayMs, 800);
    assert.equal(hello.codec, 'pcm_s16le');

    ws.send(JSON.stringify({ type: 'ping', id: 1, t0: 42.5 }));
    const pong = await ws.next(isText('pong'));
    assert.equal(pong.id, 1);
    assert.equal(pong.t0, 42.5);
    assert.ok(pong.t2 >= pong.t1);

    const a = S.decodePacket(await ws.next(isBinary));
    const b = S.decodePacket(await ws.next(isBinary));
    assert.equal(a.pcm.length, 960 * 2);
    assert.ok(Math.abs(b.timestampMs - a.timestampMs - 20) < 1e-6, 'chunks are 20 ms apart');
  } finally {
    ws.close();
    await app.close();
  }
});

test('Server PC-host relay: format -> hello, audio relayed byte for byte, listener count', async () => {
  const app = createServer({ port: 0, host: '127.0.0.1', quiet: true });
  const port = await app.listen();
  const host = wsClient(`ws://127.0.0.1:${port}/ws?role=host`);
  const listener = wsClient(`ws://127.0.0.1:${port}/ws`);
  try {
    await host.opened;
    await host.next(isText('welcome'));
    await listener.opened;
    await listener.next(isText('hello'));
    const count = await host.next((m) => isText('listeners')(m) && m.count === 1);
    assert.equal(count.count, 1);

    host.send(JSON.stringify({ type: 'format', codec: 'pcm_s16le', sampleRate: 44100, channels: 2 }));
    const hello2 = await listener.next(isText('hello'));
    assert.equal(hello2.sampleRate, 44100);

    host.send(JSON.stringify({ type: 'config', delayMs: 1500 }));
    assert.equal((await listener.next(isText('hello'))).delayMs, 1500);

    const pkt = S.encodePacket(5555.5, new Int16Array([1, 2, 3, 4, 5, 6]));
    host.send(pkt);
    const got = S.decodePacket(await listener.next(isBinary));
    assert.equal(got.timestampMs, 5555.5);
    assert.deepEqual(Array.from(got.pcm), [1, 2, 3, 4, 5, 6]);

    // Listener status reports reach the host page.
    listener.send(JSON.stringify({ type: 'report', name: 'Test phone', state: 'playing', syncMs: 2.5 }));
    const people = await host.next((m) => isText('listeners')(m) && m.list && m.list[0] && m.list[0].name === 'Test phone', 4000);
    assert.deepEqual(people.list[0], { name: 'Test phone', state: 'playing', syncMs: 2.5 });

    // Listeners cannot inject audio.
    listener.send(S.encodePacket(1, new Int16Array([9, 9])));
    await assert.rejects(host.next(isBinary, 300));
  } finally {
    host.close();
    listener.close();
    await app.close();
  }
});
