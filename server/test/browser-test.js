#!/usr/bin/env node
/*
 * End-to-end sync test in headless Chromium (no phone needed):
 *   1. starts the server with the "beeps" test source (a beep on every whole second),
 *   2. opens several listener pages (each is its own "phone" with its own clock),
 *   3. records, inside each page, the exact AudioContext time each beep is rendered,
 *   4. converts those to the host clock using the TRUE clock offset (all pages run on this
 *      machine, so performance.timeOrigin tells us the truth) and checks:
 *        - clock-sync error  (estimated offset vs true offset)
 *        - playback error    (beep heard at host time  vs  beep time + delay + nudge)
 *        - spread between listeners for the same beep  (what your ears care about)
 *
 * With --pc-host the audio comes from the PC host page instead (host.html?testsource: a looping
 * beep fed through the real capture worklet -> timestamps -> server relay path). Then we check
 * clock sync, a steady 1 s beat and the spread between listeners.
 *
 * Add --real-capture to go through the real getDisplayMedia() call instead (Chromium's fake
 * capture device supplies a periodic beep as "system audio").
 *
 * Usage: node server/test/browser-test.js [--pc-host [--real-capture]] [--listeners 3] [--seconds 12]
 *                                         [--nudge 0] [--jitter 0]
 * Needs Playwright with Chromium (pre-installed in CI images / `npx playwright install chromium`).
 */
'use strict';

const path = require('path');
const { performance } = require('perf_hooks');
const { createServer } = require('../server');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  try { return require(require.resolve('playwright', { paths: [process.cwd(), path.join(__dirname, '..')] })); } catch (e) {
    console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
}

function stats(values) {
  const v = values.slice().sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const p = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { n: v.length, mean, min: v[0], max: v[v.length - 1], p50: p(0.5), p95: p(0.95) };
}

const fmt = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);

async function main() {
  const N = arg('listeners', 3);
  const seconds = arg('seconds', 12);
  const nudge = arg('nudge', 0);
  const { chromium } = loadPlaywright();

  const realCapture = process.argv.includes('--real-capture');
  const pcHost = realCapture || process.argv.includes('--pc-host');
  const jitterMs = arg('jitter', 0);
  const app = createServer({ port: 0, host: '127.0.0.1', source: pcHost ? null : 'beeps', quiet: true, delayMs: 1000, jitterMs });
  const port = await app.listen();
  const hostOrigin = performance.timeOrigin;
  console.log(`Server on :${port}, ${realCapture ? 'PC host page (real getDisplayMedia, fake device)' : pcHost ? 'PC host page (test beeps)' : 'beeps test source'}, delay ${app.delayMs} ms, ${N} listeners, ${seconds}s${jitterMs ? `, network jitter 0-${jitterMs} ms` : ''}`);

  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox',
      ...(realCapture ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : [])],
  });
  const pages = [];
  let hostPage = null;
  try {
    if (pcHost) {
      hostPage = await (await browser.newContext()).newPage();
      hostPage.on('pageerror', (e) => console.error('[host] error:', e.message));
      await hostPage.goto(`http://localhost:${port}/host${realCapture ? '' : '?testsource'}`);
      await hostPage.waitForFunction(() => window.__ssHost && window.__ssHost.clock.ready, null, { timeout: 5000 });
      await hostPage.click('#share');
      await hostPage.waitForFunction(() => window.__ssHost.stats.sent > 10, null, { timeout: 5000 });
      console.log('Host page is streaming.');
    }
    for (let i = 0; i < N; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('pageerror', (e) => console.error(`[page ${i}] error:`, e.message));
      // Give each "phone" a different extra nudge-free start time so their clocks differ.
      await page.goto(`http://127.0.0.1:${port}/?test&autojoin&nudge=${nudge}`);
      pages.push(page);
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, seconds * 1000));

    let failures = 0;
    const perPage = [];
    for (let i = 0; i < N; i++) {
      const data = await pages[i].evaluate(() => ({ state: window.__ssTest.state(), onsets: window.__ssTest.onsets, ready: window.__ssTest.ready, error: window.__ssTest.error }));
      const trueOffset = data.state.timeOrigin - hostOrigin; // hostClock - pageClock
      const clockErr = data.state.offset - trueOffset;
      // Playback error for each beep heard after the first 3 s (let things settle).
      const errs = [];
      const heard = new Map();
      if (realCapture) {
        // Unknown beep pattern from the fake device: just collect onsets after warm-up.
        const first = data.onsets.length ? data.onsets[0].perf : 0;
        for (const o of data.onsets) if (o.perf - first > 2000) heard.set(heard.size, o.perf + trueOffset - data.state.nudgeMs);
      }
      const origin = realCapture ? NaN : pcHost ? (data.onsets.length ? data.onsets[0].perf + trueOffset - data.state.delayMs : 0) : app.testStart;
      for (const o of data.onsets) {
        const hostHeard = o.perf + trueOffset;             // true host time the beep is heard
        const beepTs = hostHeard - data.state.delayMs - data.state.nudgeMs;
        const k = Math.round((beepTs - origin) / 1000);
        const expected = origin + k * 1000 + data.state.delayMs + data.state.nudgeMs;
        const e = hostHeard - expected;
        if (Math.abs(e) > 400) continue; // not a beep onset
        if (hostHeard - origin > 3000 + data.state.delayMs) {
          heard.set(heard.size, hostHeard - data.state.nudgeMs);
          errs.push(e);
        }
      }
      perPage.push(heard);
      const s = errs.length ? stats(errs) : null;
      console.log(`listener ${i}: worklet=${data.ready} clock offset err ${fmt(clockErr)} ms (rtt ${data.state.minRtt.toFixed(2)} ms, ${data.state.samples} samples), ` +
        `played ${data.state.stats.played} dropped ${data.state.stats.dropped} resyncs ${data.state.stats.resyncs}, audio clock: ${data.state.audioClockSource}, ctx ${data.state.sampleRate} Hz`);
      if (s && process.env.VERBOSE) console.log('            errors: ' + errs.map((e) => e.toFixed(1)).join(' '));
      if (s) console.log(`            ${pcHost ? 'beat regularity (vs. 1 s grid)' : 'beep playback error'}: mean ${fmt(s.mean)} ms, p50 ${fmt(s.p50)}, p95 ${fmt(s.p95)}, min ${fmt(s.min)}, max ${fmt(s.max)} (${s.n} beeps)`);
      if (data.error) console.log('            worklet error:', data.error);
      if (Math.abs(clockErr) > 2) { failures++; console.log('  FAIL: clock offset error > 2 ms'); }
      if (realCapture) {
        console.log(`            heard ${heard.size} onsets from the captured fake device`);
        if (heard.size < 3) { failures++; console.log('  FAIL: too few onsets heard'); }
      } else if (!s || s.n < seconds - 5) { failures++; console.log('  FAIL: too few beeps heard'); }
      else if ((!pcHost && Math.abs(s.mean) > 5) || s.max - s.min > 10) { failures++; console.log('  FAIL: playback error too large: ' + errs.map((e) => e.toFixed(1)).join(' ')); }
    }

    // Spread between listeners for the same beep.
    // Match every onset heard by listener 0 with the nearest onset of each other listener.
    const spreads = [];
    for (const t0 of perPage[0].values()) {
      const ts = perPage.map((m) => {
        let best;
        for (const t of m.values()) if (best === undefined || Math.abs(t - t0) < Math.abs(best - t0)) best = t;
        return best;
      }).filter((t) => t !== undefined && Math.abs(t - t0) < 100);
      if (ts.length === N) spreads.push(Math.max(...ts) - Math.min(...ts));
    }
    if (spreads.length) {
      const s = stats(spreads);
      console.log(`\nSpread between ${N} listeners for the same beep: mean ${s.mean.toFixed(2)} ms, p95 ${s.p95.toFixed(2)} ms, max ${s.max.toFixed(2)} ms (${s.n} beeps)`);
      if (s.max > 10) { failures++; console.log('FAIL: listeners are more than 10 ms apart'); }
    } else {
      failures++;
      console.log('FAIL: no common beeps between listeners');
    }

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll sync checks passed ✓');
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (hostPage) {
      const h = await hostPage.evaluate(() => ({ sent: window.__ssHost.stats.sent, skipped: window.__ssHost.stats.skipped }));
      console.log(`Host page sent ${h.sent} chunks (${h.skipped} skipped).`);
    }
    await browser.close();
    await app.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
