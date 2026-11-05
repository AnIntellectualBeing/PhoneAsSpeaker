/*
 * SyncSpeaker shared sync engine (listener page, PC host page and Node tests).
 * No dependencies, no build step. Works over plain http (no AudioWorklet needed for playback).
 *
 * How sync works, in short:
 *  1. Every audio chunk carries the host-clock time at which it was captured.
 *  2. ClockSync measures the offset between this device's clock and the host clock with
 *     NTP-style pings, keeping only the samples with the lowest round-trip time.
 *  3. Each chunk should come out of the speaker at  hostTime + delay (+ local nudge).
 *     We convert that to AudioContext time (via getOutputTimestamp or currentTime with
 *     outputLatency/baseLatency) and schedule an AudioBufferSourceNode there.
 *  4. Chunks wait in a small queue and are handed to Web Audio ~350 ms before they are due.
 *     Consecutive chunks are scheduled back to back (gapless). Small drift is corrected
 *     smoothly with a tiny playbackRate change; errors over 15 ms trigger a hard re-sync with
 *     a short fade; chunks that arrive too late are dropped.
 *
 * Wire protocol: see PROTOCOL.md. Binary frame = [float64 LE host-time ms][PCM s16le].
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SyncSpeaker = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PROTOCOL_VERSION = 1;
  const HEADER_BYTES = 8;

  const nowMs = () => performance.now();

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function median(values) {
    if (!values.length) return NaN;
    const s = values.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // ---------------------------------------------------------------------------------------------
  // Packets
  // ---------------------------------------------------------------------------------------------

  /** Builds a binary audio frame: [float64 LE timestamp][Int16 PCM]. */
  function encodePacket(timestampMs, int16) {
    const buf = new ArrayBuffer(HEADER_BYTES + int16.byteLength);
    new DataView(buf).setFloat64(0, timestampMs, true);
    new Int16Array(buf, HEADER_BYTES).set(int16);
    return buf;
  }

  /** Parses a binary audio frame. The PCM view shares memory with the input buffer. */
  function decodePacket(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const timestampMs = view.getFloat64(0, true);
    const pcm = new Int16Array(arrayBuffer, HEADER_BYTES, (arrayBuffer.byteLength - HEADER_BYTES) >> 1);
    return { timestampMs, pcm };
  }

  // ---------------------------------------------------------------------------------------------
  // Clock sync (NTP style)
  // ---------------------------------------------------------------------------------------------

  /**
   * Estimates offset = hostClock - localClock.
   * ping:  t0 (local send)          pong: t1 (host receive), t2 (host send)     t3 (local receive)
   *   rtt    = (t3 - t0) - (t2 - t1)
   *   offset = ((t1 - t0) + (t2 - t3)) / 2
   * Network delays are noisy and asymmetric when queues fill up, so we only trust the samples
   * with the lowest round-trip time (their error is at most rtt/2) and take their median.
   */
  class ClockSync {
    constructor(opts = {}) {
      this.maxSamples = opts.maxSamples || 40;
      this.maxAgeMs = opts.maxAgeMs || 60000;
      this.bestFraction = opts.bestFraction || 0.3;
      this.reset();
    }

    reset() {
      this.samples = [];
      this.pending = new Map();
      this.nextId = 1;
      this.offset = 0;
      this.minRtt = Infinity;
      this.bestRtt = Infinity;
      this.count = 0;
    }

    /** Minimum number of samples before we trust the estimate enough to start playback. */
    get ready() { return this.samples.length >= 3; }

    makePing(t0 = nowMs()) {
      const id = this.nextId++;
      this.pending.set(id, t0);
      if (this.pending.size > 50) {
        // Forget pings whose pong never came (e.g. after a reconnect).
        const oldest = this.pending.keys().next().value;
        this.pending.delete(oldest);
      }
      return { type: 'ping', id, t0 };
    }

    /** @returns {boolean} true if the pong matched a ping we sent. */
    handlePong(msg, t3 = nowMs()) {
      if (!this.pending.has(msg.id)) return false;
      const t0 = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      const t1 = msg.t1, t2 = msg.t2;
      const rtt = Math.max(0, (t3 - t0) - (t2 - t1));
      const offset = ((t1 - t0) + (t2 - t3)) / 2;
      this.addSample(rtt, offset, t3);
      return true;
    }

    addSample(rtt, offset, at) {
      this.samples.push({ rtt, offset, at });
      this.count++;
      while (this.samples.length > this.maxSamples) this.samples.shift();
      while (this.samples.length > 5 && at - this.samples[0].at > this.maxAgeMs) this.samples.shift();
      this.recompute();
    }

    recompute() {
      const byRtt = this.samples.slice().sort((a, b) => a.rtt - b.rtt);
      const n = Math.max(Math.min(3, byRtt.length), Math.ceil(byRtt.length * this.bestFraction));
      const best = byRtt.slice(0, n);
      this.offset = median(best.map((s) => s.offset));
      this.minRtt = byRtt.length ? byRtt[0].rtt : Infinity;
      this.bestRtt = median(best.map((s) => s.rtt));
    }

    hostToLocal(hostMs) { return hostMs - this.offset; }
    localToHost(localMs) { return localMs + this.offset; }
    hostNow() { return nowMs() + this.offset; }
  }

  // ---------------------------------------------------------------------------------------------
  // Continuous timestamps for captured chunks (used by the PC host page; Kotlin twin on Android)
  // ---------------------------------------------------------------------------------------------

  class ChunkTimestamper {
    constructor(sampleRate, reanchorThresholdMs = 40, slewFactor = 0.02, persistChunks = 3) {
      this.sampleRate = sampleRate;
      this.threshold = reanchorThresholdMs;
      this.slew = slewFactor;
      this.persist = persistChunks; // a jump must persist this many chunks (spikes are ignored)
      this.overCount = 0;
      this.anchorMs = NaN;
      this.anchorFrame = 0;
      this.discontinuities = 0;
    }

    timestampFor(frameIndex, measuredMs) {
      if (Number.isNaN(this.anchorMs)) {
        this.anchorMs = measuredMs;
        this.anchorFrame = frameIndex;
        return measuredMs;
      }
      const predicted = this.anchorMs + (frameIndex - this.anchorFrame) * 1000 / this.sampleRate;
      const error = measuredMs - predicted;
      if (Math.abs(error) > this.threshold) {
        if (++this.overCount < this.persist) return predicted;
        this.overCount = 0;
        this.discontinuities++;
        this.anchorMs = measuredMs;
        this.anchorFrame = frameIndex;
        return measuredMs;
      }
      this.overCount = 0;
      const correction = error * this.slew;
      this.anchorMs += correction;
      return predicted + correction;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduling decisions (pure, unit-tested in Node)
  // ---------------------------------------------------------------------------------------------

  const SCHED_DEFAULTS = {
    lateMarginS: 0.025,   // a chunk must be scheduled at least this far in the future
    hardResyncS: 0.015,   // larger errors: jump straight to the ideal time (short fade)
    deadbandS: 0.0015,    // smaller errors: leave alone
    gain: 0.5,            // playbackRate change per second of error (proportional control)
    maxRateAdj: 0.005,    // max +-0.5 % speed change (~9 cents: hard to hear)
    contiguityMs: 2.5,    // chunks whose timestamps follow within this are played back to back
  };

  class PlaybackScheduler {
    constructor(opts = {}) {
      this.o = Object.assign({}, SCHED_DEFAULTS, opts);
      this.reset();
      this.stats = { played: 0, dropped: 0, resyncs: 0, lastErrMs: 0, avgAbsErrMs: 0 };
    }

    reset() {
      this.nextT = null;       // context time at which the next contiguous chunk starts
      this.expectedTs = null;  // host timestamp of the next contiguous chunk
    }

    /**
     * @param tsMs     host timestamp of the chunk
     * @param durS     chunk duration in seconds (at rate 1)
     * @param idealT   context time at which the chunk should start playing
     * @param nowT     current context time
     * @returns {{action:'play', when:number, rate:number, errS:number} | {action:'drop', reason:string}}
     */
    plan(tsMs, durS, idealT, nowT) {
      const o = this.o;
      const contiguous = this.nextT !== null && Math.abs(tsMs - this.expectedTs) <= o.contiguityMs;
      let when = idealT;
      let rate = 1;
      let errS = 0;
      if (contiguous) {
        errS = this.nextT - idealT; // > 0: we are behind (late) and must speed up
        if (Math.abs(errS) > o.hardResyncS) {
          this.stats.resyncs++;
          when = idealT;
          errS = 0;
        } else {
          when = this.nextT;
          if (Math.abs(errS) > o.deadbandS) rate = 1 + clamp(errS * o.gain, -o.maxRateAdj, o.maxRateAdj);
        }
      }
      if (when < nowT + o.lateMarginS) {
        this.stats.dropped++;
        this.reset();
        return { action: 'drop', reason: 'late' };
      }
      this.nextT = when + durS / rate;
      this.expectedTs = tsMs + durS * 1000;
      this.stats.played++;
      this.stats.lastErrMs = errS * 1000;
      this.stats.avgAbsErrMs = this.stats.avgAbsErrMs * 0.95 + Math.abs(errS * 1000) * 0.05;
      return { action: 'play', when, rate, errS };
    }
  }

  // ---------------------------------------------------------------------------------------------
  // AudioContext time <-> performance.now() mapping
  // ---------------------------------------------------------------------------------------------

  /**
   * Maps "when should this be heard (performance.now() ms)" to AudioContext time.
   * Prefers getOutputTimestamp() (already includes output latency); otherwise uses currentTime
   * minus outputLatency + baseLatency where the browser reports them.
   */
  class AudioClock {
    constructor(ctx) {
      this.ctx = ctx;
      this.offsetMs = null; // perfMs at which ctx time 0 is heard
      this.source = 'none';
      this.devCount = 0;
      this.devSign = 0;
      this.steps = 0; // detected audio clock steps (diagnostics)
    }

    latencyS() {
      const ctx = this.ctx;
      return (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    }

    sample() {
      const ctx = this.ctx;
      const perfNow = nowMs();
      let off = null;
      let source = 'currentTime';
      if (typeof ctx.getOutputTimestamp === 'function') {
        const ts = ctx.getOutputTimestamp();
        if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
          const candidate = ts.performanceTime - ts.contextTime * 1000;
          // Sanity: currentTime must map to "now .. now + 1 s" (it is rendered ahead of output).
          const heardAt = candidate + ctx.currentTime * 1000;
          if (heardAt > perfNow - 50 && heardAt < perfNow + 1000) {
            off = candidate;
            source = 'outputTimestamp';
          }
        }
      }
      if (off === null) off = perfNow + this.latencyS() * 1000 - ctx.currentTime * 1000;
      const dev = this.offsetMs === null ? Infinity : off - this.offsetMs;
      // A persistent deviation (same sign, > 8 ms, 5 samples in a row = ~0.1 s) is a real step
      // of the audio clock (output underrun, device change), not callback jitter: follow it now.
      if (Math.abs(dev) > 8 && Math.sign(dev) === this.devSign) this.devCount++;
      else this.devCount = Math.abs(dev) > 8 ? 1 : 0;
      this.devSign = Math.sign(dev);
      if (this.offsetMs === null || Math.abs(dev) > 30 || this.devCount >= 5 || source !== this.source) {
        this.offsetMs = off;
        this.devCount = 0;
        if (Number.isFinite(dev)) this.steps++;
      } else {
        this.offsetMs += dev * 0.05; // smooth out callback jitter
      }
      this.source = source;
    }

    ctxTimeForPerf(perfMs) { return (perfMs - this.offsetMs) / 1000; }
    perfForCtxTime(t) { return t * 1000 + this.offsetMs; }
  }

  // ---------------------------------------------------------------------------------------------
  // Web Audio player
  // ---------------------------------------------------------------------------------------------

  const decoders = {
    /** Interleaved little-endian 16-bit PCM -> per-channel Float32 written into an AudioBuffer. */
    pcm_s16le(ctx, pcm, channels, sampleRate) {
      const frames = Math.floor(pcm.length / channels);
      const buffer = ctx.createBuffer(channels, frames, sampleRate);
      for (let c = 0; c < channels; c++) {
        const out = buffer.getChannelData(c);
        for (let i = 0, j = c; i < frames; i++, j += channels) out[i] = pcm[j] / 32768;
      }
      return buffer;
    },
    // TODO(opus): 'opus' decoder. WebCodecs AudioDecoder needs a secure context (HTTPS), so a
    // small WASM Opus decoder is the realistic option for pages served over http on the LAN.
  };

  class SyncPlayer {
    /**
     * @param ctx     AudioContext (created inside a user gesture)
     * @param clock   ClockSync (host <-> local) or an object with hostToLocal() and ready
     *
     * Incoming chunks wait in a small JS queue and are handed to Web Audio only when they are
     * due within `lookaheadS`. Keeping the Web Audio schedule short means that if the audio
     * clock hiccups (device underrun, CPU spike) or the clock estimate changes, the correction
     * takes effect within ~lookahead instead of after the whole delay (1 s).
     */
    constructor(ctx, clock, opts = {}) {
      this.ctx = ctx;
      this.clock = clock;
      this.audioClock = new AudioClock(ctx);
      this.scheduler = new PlaybackScheduler(opts.scheduler);
      this.delayMs = opts.delayMs || 1000;
      this.nudgeMs = opts.nudgeMs || 0;
      this.lookaheadS = opts.lookaheadS || 0.35;
      this.fadeS = 0.004;
      this.format = { codec: 'pcm_s16le', sampleRate: 48000, channels: 2 };
      this.gain = ctx.createGain();
      this.gain.connect(ctx.destination);
      this.output = this.gain; // tests may tap this node
      this.queue = [];
      this.active = new Set(); // scheduled, not yet finished: {src, g, end}
      this.lastPlayedAt = 0;
      this.lastChunkAt = 0;
      this.onChunkScheduled = null; // optional hook(info)
      this.timer = setInterval(() => this.pump(), 25);
    }

    setFormat(f) {
      const changed = f.sampleRate !== this.format.sampleRate || f.channels !== this.format.channels || f.codec !== this.format.codec;
      this.format = { codec: f.codec || 'pcm_s16le', sampleRate: f.sampleRate, channels: f.channels };
      if (changed) this.reset();
    }

    setDelay(ms) { this.delayMs = ms; }
    setNudge(ms) { this.nudgeMs = ms; }
    setVolume(v) { this.gain.gain.value = v; }

    /** Forget queued audio and silence what is already scheduled (reconnect, format change). */
    reset() {
      this.queue = [];
      this.scheduler.reset();
      const t = this.ctx.currentTime;
      for (const a of this.active) {
        try {
          a.g.gain.setValueAtTime(a.g.gain.value, t);
          a.g.gain.linearRampToValueAtTime(0, t + this.fadeS);
          a.src.stop(t + this.fadeS);
        } catch (e) { /* already stopped */ }
      }
      this.active.clear();
    }

    destroy() {
      clearInterval(this.timer);
      this.reset();
      try { this.gain.disconnect(); } catch (e) { /* ignore */ }
    }

    /** Handles one binary audio frame (ArrayBuffer). */
    push(arrayBuffer) {
      const { timestampMs, pcm } = decodePacket(arrayBuffer);
      this.pushDecoded(timestampMs, pcm);
    }

    pushDecoded(timestampMs, pcm) {
      this.lastChunkAt = nowMs();
      if (!this.clock.ready) return; // still measuring the clock offset
      const q = this.queue;
      if (q.length && timestampMs < q[q.length - 1].ts) {
        // Out of order (should not happen on TCP, but be safe): insert sorted.
        let i = q.length - 1;
        while (i > 0 && q[i - 1].ts > timestampMs) i--;
        q.splice(i, 0, { ts: timestampMs, pcm });
      } else {
        q.push({ ts: timestampMs, pcm });
      }
      if (q.length > 500) q.splice(0, q.length - 500); // > 10 s backlog: something is off
      this.pump();
    }

    /** Moves due chunks from the queue into the Web Audio schedule. */
    pump() {
      if (!this.queue.length || this.ctx.state === 'closed') return;
      const decode = decoders[this.format.codec];
      if (!decode) return;
      const { channels, sampleRate } = this.format;
      this.audioClock.sample();
      const now = this.ctx.currentTime;
      while (this.queue.length) {
        const { ts, pcm } = this.queue[0];
        const targetPerf = this.clock.hostToLocal(ts + this.delayMs + this.nudgeMs);
        const idealT = this.audioClock.ctxTimeForPerf(targetPerf);
        if (idealT > now + this.lookaheadS) break; // not due yet
        this.queue.shift();
        const durS = Math.floor(pcm.length / channels) / sampleRate;
        const prevNext = this.scheduler.nextT;
        const plan = this.scheduler.plan(ts, durS, idealT, now);
        if (plan.action !== 'play') continue;
        const jumped = prevNext === null || Math.abs(plan.when - prevNext) > 1e-6;
        this.schedule(decode(this.ctx, pcm, channels, sampleRate), plan, jumped);
        if (this.onChunkScheduled) {
          this.onChunkScheduled({ timestampMs: ts, when: plan.when, rate: plan.rate, errS: plan.errS, idealT, durS });
        }
      }
    }

    schedule(buffer, plan, jumped) {
      const ctx = this.ctx;
      if (jumped) {
        // Discontinuity: fade out whatever is still scheduled after this point, fade in.
        for (const a of this.active) {
          if (a.end > plan.when) {
            try {
              a.g.gain.setValueAtTime(1, Math.max(ctx.currentTime, plan.when - this.fadeS));
              a.g.gain.linearRampToValueAtTime(0, Math.max(ctx.currentTime, plan.when) + this.fadeS);
              a.src.stop(Math.max(ctx.currentTime, plan.when) + this.fadeS);
            } catch (e) { /* ignore */ }
          }
        }
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      if (plan.rate !== 1) src.playbackRate.value = plan.rate;
      const g = ctx.createGain();
      if (jumped) {
        g.gain.setValueAtTime(0, plan.when);
        g.gain.linearRampToValueAtTime(1, plan.when + this.fadeS);
      }
      src.connect(g);
      g.connect(this.gain);
      src.start(plan.when);
      const entry = { src, g, end: plan.when + buffer.duration / plan.rate };
      this.active.add(entry);
      src.onended = () => {
        this.active.delete(entry);
        try { g.disconnect(); } catch (e) { /* ignore */ }
      };
      this.lastPlayedAt = nowMs();
    }

    /** Estimated total sync uncertainty in ms (clock offset uncertainty + scheduling error). */
    syncErrorMs() {
      const rttPart = Number.isFinite(this.clock.bestRtt) ? this.clock.bestRtt / 2 : 0;
      return rttPart + this.scheduler.stats.avgAbsErrMs;
    }

    get playing() { return nowMs() - this.lastPlayedAt < 1500; }
  }

  function qualityLabel(errMs) {
    if (errMs <= 10) return 'Excellent';
    if (errMs <= 25) return 'Good';
    if (errMs <= 50) return 'Fair';
    return 'Poor';
  }

  // ---------------------------------------------------------------------------------------------
  // WebSocket connection with clock pings and auto-reconnect
  // ---------------------------------------------------------------------------------------------

  class Connection {
    /**
     * handlers: onStatus(status), onHello(msg), onAudio(arrayBuffer), onMessage(msg)
     * status: 'connecting' | 'open' | 'reconnecting' | 'closed'
     */
    constructor(url, clock, handlers = {}) {
      this.url = url;
      this.clock = clock;
      this.h = handlers;
      this.ws = null;
      this.closedByUser = false;
      this.retry = 0;
      this.timers = [];
      this.lastMessageAt = 0;
    }

    connect() {
      this.closedByUser = false;
      this._open();
    }

    close() {
      this.closedByUser = true;
      this._clearTimers();
      if (this.ws) try { this.ws.close(); } catch (e) { /* ignore */ }
      this.ws = null;
      this._status('closed');
    }

    send(obj) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    }

    sendBinary(buf) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(buf);
    }

    get bufferedAmount() { return this.ws ? this.ws.bufferedAmount : 0; }

    _status(s) { if (this.h.onStatus) this.h.onStatus(s); }

    _clearTimers() {
      for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
      this.timers = [];
    }

    _open() {
      this._clearTimers();
      this._status(this.retry === 0 ? 'connecting' : 'reconnecting');
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        this._scheduleReconnect();
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onopen = () => {
        this.retry = 0;
        this.lastMessageAt = nowMs();
        this.clock.reset();
        this._status('open');
        // Burst of pings to get a quick estimate, then one every 2 s to follow drift.
        for (let i = 0; i < 10; i++) this.timers.push(setTimeout(() => this.ping(), i * 60));
        this.timers.push(setInterval(() => this.ping(), 2000));
        // Watchdog: the host sends audio or pongs constantly; silence means a dead link.
        this.timers.push(setInterval(() => {
          if (nowMs() - this.lastMessageAt > 6000) {
            try { ws.close(); } catch (e) { /* ignore */ }
          }
        }, 1000));
      };

      ws.onmessage = (ev) => {
        this.lastMessageAt = nowMs();
        if (typeof ev.data === 'string') {
          let msg;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          if (msg.type === 'pong') {
            this.clock.handlePong(msg, nowMs());
          } else if (msg.type === 'hello') {
            if (this.h.onHello) this.h.onHello(msg);
          }
          if (this.h.onMessage) this.h.onMessage(msg);
        } else if (this.h.onAudio) {
          this.h.onAudio(ev.data);
        }
      };

      ws.onerror = () => { /* onclose follows */ };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this._clearTimers();
        this.ws = null;
        if (!this.closedByUser) this._scheduleReconnect();
      };
    }

    ping() {
      this.send(this.clock.makePing(nowMs()));
    }

    _scheduleReconnect() {
      this.retry++;
      this._status('reconnecting');
      const wait = Math.min(5000, 500 * Math.pow(2, this.retry - 1));
      this.timers.push(setTimeout(() => this._open(), wait));
    }
  }

  return {
    PROTOCOL_VERSION,
    HEADER_BYTES,
    encodePacket,
    decodePacket,
    ClockSync,
    ChunkTimestamper,
    PlaybackScheduler,
    AudioClock,
    SyncPlayer,
    Connection,
    decoders,
    qualityLabel,
    median,
    clamp,
  };
});
