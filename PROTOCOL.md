# SyncSpeaker wire protocol (v1)

The same protocol is spoken by the Android host (`app/.../server/StreamServer.kt`) and the Node server
(`server/server.js`). The listener engine is `web/listener/syncspeaker.js`.

## Transport

- HTTP on the host (default port **8080**). `GET /` serves the listener page; `GET /status.json` returns a small status object.
- WebSocket at **`/ws`**. Listeners connect to `ws://<host>:<port>/ws`.
  In PC mode, the host page connects to `/ws?role=host`.

## Clocks

The **host clock** is a monotonic millisecond clock:
- Android: `System.nanoTime() / 1e6` (same time base as `AudioTimestamp.TIMEBASE_MONOTONIC`).
- Node server: `performance.now()`.

In PC mode the host *page* synchronizes to the server clock with the same ping/pong exchange
and timestamps its chunks in server time.

## Messages

### Binary: audio chunk (host → listener)

```
offset  size  type                 meaning
0       8     float64 LE           host-clock time (ms) at which the first sample was captured
8       n     codec payload        v1 codec "pcm_s16le": interleaved signed 16-bit little-endian PCM
```

Chunks are 20 ms long (960 frames at 48 kHz). Consecutive chunks have contiguous timestamps
(`next = ts + frames / sampleRate * 1000`). A gap or jump marks a discontinuity.

### Text (JSON)

| type | direction | fields |
|---|---|---|
| `hello` | host → listener | `protocol` (1), `codec`, `sampleRate`, `channels`, `delayMs`, `session`, `serverTime`. Sent on connect and again whenever the format or delay changes. |
| `ping` | listener → host | `id`, `t0` (listener clock, ms) |
| `pong` | host → listener | `id`, `t0` (echo), `t1` (host receive time), `t2` (host send time) |
| `format` | PC host page → server | `codec`, `sampleRate`, `channels` |
| `config` | PC host page → server | `delayMs` |
| `welcome` | server → PC host page | `session`, `delayMs`, `addresses` (LAN IPs) |
| `listeners` | server → PC host page | `count` |
| `error` | server → PC host page | `message` |

## Listener algorithm

```
rtt    = (t3 - t0) - (t2 - t1)
offset = ((t1 - t0) + (t2 - t3)) / 2          # host - local
```

1. Keep the last ≤ 40 samples (≤ 60 s). Use the median offset of the ~30 % with the lowest RTT.
   Start playing after 3 samples.
2. A chunk with timestamp `ts` should be heard at local time `ts + delayMs + nudgeMs - offset`.
3. Convert that to AudioContext time with `getOutputTimestamp()` (which includes output latency).
   Otherwise use `currentTime` and `outputLatency + baseLatency`.
4. Queue chunks; hand them to Web Audio (`AudioBufferSourceNode.start(when)`) ≈ 350 ms before they are due.
5. Contiguous chunks are scheduled back to back. With error `e = scheduled - ideal`:
   - `|e| ≤ 1.5 ms`: rate 1;
   - `|e| ≤ 15 ms`: `playbackRate = 1 + clamp(0.5·e, ±0.5 %)`;
   - otherwise: hard re-sync to the ideal time with 4 ms fades.
   - Chunks that cannot start at least 25 ms in the future are dropped.

## Future: Opus

`codec` exists so that compressed audio can be added without breaking v1 listeners:
- the Android side has an `AudioEncoder` interface (`PcmEncoder` today);
- the web side has a `decoders` table in `syncspeaker.js`.

WebCodecs needs a secure context, so a plain-http LAN page would need a WASM Opus decoder.
