/*
 * SyncSpeaker PC host page.
 *
 * Captures audio with getDisplayMedia (tab audio, or system audio on Windows/ChromeOS),
 * cuts it into 20 ms chunks, timestamps every chunk with the SERVER clock (found with the same
 * ClockSync used by listeners) and sends [float64 timestamp][PCM s16le] frames to the server,
 * which relays them to every listener. Exactly the protocol the Android host speaks.
 */
(function () {
  'use strict';
  const S = window.SyncSpeaker;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const clock = new S.ClockSync();
  let ctx = null, stream = null, sourceNode = null, captureNode = null, sink = null, testSource = null;
  let timestamper = null, localPlayer = null, sharing = false, surface = null;
  let delayMs = 1000, addresses = [], selectedUrl = null;
  const stats = { sent: 0, skipped: 0, level: 0 };

  function load(key, fallback) {
    try { const v = localStorage.getItem('syncspeaker.host.' + key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem('syncspeaker.host.' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ server connection
  const conn = new S.Connection(`ws://${location.host}/ws?role=host`, clock, {
    onStatus: (st) => {
      $('conn').textContent = st;
      if (st === 'open' && sharing) sendFormat();
    },
    onMessage: (msg) => {
      if (msg.type === 'welcome') {
        addresses = msg.addresses || [];
        renderJoin();
        conn.send({ type: 'config', delayMs });
      } else if (msg.type === 'listeners') {
        $('count').textContent = msg.count + (msg.count === 1 ? ' listener' : ' listeners');
        renderPeople(msg.list || []);
      } else if (msg.type === 'error') {
        showWarn(msg.message);
      }
    },
  });
  conn.connect();

  // ------------------------------------------------------------------ join info + QR
  function listenerUrls() {
    const port = location.port || '80';
    const urls = addresses.map((a) => `http://${a.address}:${port}/`);
    if (!urls.length) urls.push(`http://${location.hostname}:${port}/`);
    return urls;
  }

  function renderJoin() {
    const urls = listenerUrls();
    if (!selectedUrl || !urls.includes(selectedUrl)) selectedUrl = urls[0];
    $('url').textContent = selectedUrl;
    try { $('qr').innerHTML = window.QR.toSvg(window.QR.encode(selectedUrl)); } catch (e) { $('qr').textContent = ''; }
    const others = $('others');
    others.textContent = '';
    if (urls.length > 1) {
      for (const u of urls) {
        const b = document.createElement('button');
        b.textContent = u.replace(/^http:\/\//, '').replace(/\/$/, '');
        b.className = u === selectedUrl ? 'active' : '';
        b.title = 'Show QR code for this network';
        b.onclick = () => { selectedUrl = u; renderJoin(); };
        others.append(b);
      }
    }
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      showWarn('Open this page as http://localhost:' + (location.port || 80) + '/host on the computer running the server: browsers only allow audio sharing on localhost or HTTPS.');
    }
  }

  // ------------------------------------------------------------------ settings
  delayMs = load('delay', 1000);
  $('delay').value = delayMs;
  $('delay-val').textContent = delayMs + ' ms';
  $('delay').addEventListener('input', (e) => {
    delayMs = Number(e.target.value);
    $('delay-val').textContent = delayMs + ' ms';
  });
  $('delay').addEventListener('change', () => {
    save('delay', delayMs);
    conn.send({ type: 'config', delayMs });
    if (localPlayer) localPlayer.setDelay(delayMs);
  });
  $('mute-tab').checked = load('muteTab', true);
  $('mute-tab').addEventListener('change', (e) => save('muteTab', e.target.checked));
  $('play-here').checked = load('playHere', false);
  $('play-here').addEventListener('change', (e) => {
    save('playHere', e.target.checked);
    updateLocalPlayer();
  });

  function describe(l) {
    if (l.state === 'playing' && Number.isFinite(l.syncMs)) {
      const ms = Math.max(1, Math.round(l.syncMs));
      return `±${ms} ms ${l.syncMs <= 10 ? '✓' : l.syncMs <= 25 ? '· good' : l.syncMs <= 50 ? '· fair' : '· poor'}`;
    }
    return { syncing: 'syncing…', connecting: 'syncing…', waiting: 'waiting for audio', suspended: 'paused (tap needed on that phone)' }[l.state] || l.state;
  }

  function renderPeople(list) {
    const ul = $('people');
    ul.textContent = '';
    for (const l of list) {
      const li = document.createElement('li');
      li.textContent = `${l.name} · ${describe(l)}`;
      ul.append(li);
    }
  }

  function showWarn(text) {
    $('warn').hidden = !text;
    $('warn').textContent = text || '';
  }

  function setStatus(text, cls) {
    const el = $('status');
    el.textContent = text;
    el.className = 'status ' + (cls || 'muted');
  }

  // ------------------------------------------------------------------ capture
  $('share').addEventListener('click', () => (sharing ? stopSharing() : startSharing()));

  async function startSharing() {
    showWarn('');
    const useTestSource = params.has('testsource');
    if (!useTestSource && !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
      showWarn('This browser cannot share audio. Use Chrome or Edge on a computer, and open the page via http://localhost.');
      return;
    }
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    } catch (e) {
      ctx = new AudioContext();
    }
    await ctx.resume();

    let input;
    if (useTestSource) {
      // Automated tests: a looping beep instead of getDisplayMedia (same pipeline after this).
      input = makeTestSource(ctx);
      surface = 'test';
    } else {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
            channelCount: 2, sampleRate: 48000,
            suppressLocalAudioPlayback: $('mute-tab').checked,
            restrictOwnAudio: true,
          },
          systemAudio: 'include',
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          monitorTypeSurfaces: 'include',
        });
      } catch (e) {
        ctx.close();
        ctx = null;
        setStatus('Sharing was cancelled.', 'muted');
        return;
      }
      const audio = stream.getAudioTracks();
      const video = stream.getVideoTracks()[0];
      surface = video && video.getSettings ? video.getSettings().displaySurface : null;
      if (!audio.length) {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
        ctx = null;
        showWarn('No audio was shared. Try again and turn on “Also share tab audio” (tab) or “Also share system audio” (entire screen, Windows).');
        return;
      }
      // We only need the sound. Keep the video track (stopping it can end the share in some
      // browsers) but disable it so it costs almost nothing.
      if (video) video.enabled = false;
      audio[0].addEventListener('ended', stopSharing);
      input = ctx.createMediaStreamSource(new MediaStream([audio[0]]));
      sourceNode = input;
    }

    const chunkFrames = Math.round(ctx.sampleRate / 50); // 20 ms
    timestamper = new S.ChunkTimestamper(ctx.sampleRate);
    sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);

    if (ctx.audioWorklet) {
      await ctx.audioWorklet.addModule('/host/capture-worklet.js');
      captureNode = new AudioWorkletNode(ctx, 'syncspeaker-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit',
        processorOptions: { chunkFrames },
      });
      captureNode.port.onmessage = (e) => onChunk(e.data.frame, e.data.left, e.data.right);
    } else {
      // Fallback for very old browsers.
      const sp = ctx.createScriptProcessor(1024, 2, 2);
      let frame = 0;
      sp.onaudioprocess = (e) => {
        const l = e.inputBuffer.getChannelData(0), r = e.inputBuffer.getChannelData(1);
        onChunk(frame, new Float32Array(l), new Float32Array(r));
        frame += l.length;
      };
      captureNode = sp;
    }
    input.connect(captureNode);
    captureNode.connect(sink);

    sharing = true;
    sendFormat();
    $('share').textContent = 'Stop sharing';
    $('share').classList.add('stop');
    setStatus('Sharing audio' + (surface ? ' (' + surfaceName(surface) + ')' : '') + '…', 'ok');
    updateLocalPlayer();
  }

  function surfaceName(s) {
    return { browser: 'tab', window: 'window', monitor: 'entire screen', test: 'test beeps' }[s] || s;
  }

  function makeTestSource(c) {
    const sr = c.sampleRate;
    const buf = c.createBuffer(2, sr, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < sr * 0.06; i++) d[i] = 0.8 * Math.exp(-i / (sr * 0.02)) * Math.sin(2 * Math.PI * 1000 * i / sr);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start(c.currentTime + 0.1);
    testSource = src;
    return src;
  }

  function sendFormat() {
    if (!ctx) return;
    conn.send({ type: 'format', codec: 'pcm_s16le', sampleRate: ctx.sampleRate, channels: 2 });
    conn.send({ type: 'config', delayMs });
  }

  function onChunk(frame, left, right) {
    const n = left.length;
    const pcm = new Int16Array(n * 2);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const l = left[i], r = right[i];
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
      pcm[2 * i] = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
      pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(r * 32767)));
    }
    stats.level = Math.max(peak, stats.level * 0.85);
    if (!clock.ready) return;

    // When was the first frame of this chunk captured, in server-clock time? The worklet just
    // rendered up to ctx.currentTime, i.e. "now"; earlier frames are proportionally older.
    const ageMs = (ctx.currentTime - frame / ctx.sampleRate) * 1000;
    const measuredHost = clock.localToHost(performance.now() - ageMs);
    const ts = timestamper.timestampFor(frame, measuredHost);

    if (conn.bufferedAmount < 1000000) {
      conn.sendBinary(S.encodePacket(ts, pcm));
      stats.sent++;
    } else {
      stats.skipped++;
    }
    if (localPlayer) localPlayer.pushDecoded(ts, pcm);
  }

  function updateLocalPlayer() {
    const want = sharing && $('play-here').checked;
    if (want && surface === 'monitor') {
      showWarn('“Play on this computer too” is off while sharing the entire screen: the computer would capture its own sound and echo forever.');
      return;
    }
    if (want && !localPlayer && ctx) {
      // The host page is a listener too: same ClockSync (this page <-> server), same delay.
      localPlayer = new S.SyncPlayer(ctx, clock, { delayMs });
      localPlayer.setFormat({ codec: 'pcm_s16le', sampleRate: ctx.sampleRate, channels: 2 });
    } else if (!want && localPlayer) {
      localPlayer.destroy();
      localPlayer = null;
    }
  }

  function stopSharing() {
    if (!sharing) return;
    sharing = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (testSource) try { testSource.stop(); } catch (e) { /* ignore */ }
    if (localPlayer) localPlayer.destroy();
    if (ctx) ctx.close().catch(() => {});
    ctx = stream = sourceNode = captureNode = sink = testSource = localPlayer = null;
    $('share').textContent = 'Share audio';
    $('share').classList.remove('stop');
    setStatus('Not sharing.', 'muted');
    $('meter').style.width = '0%';
  }

  // ------------------------------------------------------------------ UI loop
  setInterval(() => {
    if (!sharing) return;
    const db = 20 * Math.log10(Math.max(stats.level, 1e-5));
    $('meter').style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
    if (!clock.ready) setStatus('Syncing with the server…', 'warn');
    else if (stats.level < 0.001) setStatus('Sharing, but it is silent. Play something (and check that audio sharing was ticked).', 'warn');
    else setStatus('Streaming ' + surfaceName(surface) + ' audio ✓', 'ok');
  }, 100);

  window.__ssHost = { stats, clock, get sharing() { return sharing; }, start: startSharing, stop: stopSharing };
  renderJoin();
})();
