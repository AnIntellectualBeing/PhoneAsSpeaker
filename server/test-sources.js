/*
 * Test audio for the desktop harness: imitates what the Android host would capture.
 * Every generator returns an Int16Array of interleaved samples for frames [frameIndex, +count).
 */
'use strict';

const fs = require('fs');

function toInt16(v) { return Math.max(-32768, Math.min(32767, Math.round(v * 32767))); }

const generators = {
  /** Continuous sine tone (left) with a fifth above it (right) so stereo is audible. */
  tone(sampleRate, channels, { hz = 440 } = {}) {
    return (frameIndex, count) => {
      const out = new Int16Array(count * channels);
      for (let i = 0; i < count; i++) {
        const n = frameIndex + i;
        const t = n / sampleRate;
        const fade = Math.min(1, n / (sampleRate * 0.05));
        for (let c = 0; c < channels; c++) {
          const f = c === 0 ? hz : hz * 1.5;
          out[i * channels + c] = toInt16(0.3 * fade * Math.sin(2 * Math.PI * f * t));
        }
      }
      return out;
    };
  },

  /**
   * A 60 ms 1 kHz beep at the start of every second of stream time, with a sharp onset.
   * Several phones playing this make sync problems obvious ("flam" instead of one click).
   * Every 4th beep is an octave higher, like a metronome's downbeat.
   */
  beeps(sampleRate, channels) {
    const beepFrames = Math.round(sampleRate * 0.06);
    return (frameIndex, count) => {
      const out = new Int16Array(count * channels);
      for (let i = 0; i < count; i++) {
        const n = frameIndex + i;
        const second = Math.floor(n / sampleRate);
        const k = n - second * sampleRate;
        if (k < beepFrames) {
          const f = second % 4 === 0 ? 2000 : 1000;
          const env = Math.exp(-k / (sampleRate * 0.02));
          const v = toInt16(0.8 * env * Math.sin(2 * Math.PI * f * k / sampleRate));
          for (let c = 0; c < channels; c++) out[i * channels + c] = v;
        }
      }
      return out;
    };
  },

  /** Loops a decoded WAV file. */
  wav(wav) {
    const total = wav.samples.length / wav.channels;
    return (frameIndex, count) => {
      const out = new Int16Array(count * wav.channels);
      for (let i = 0; i < count; i++) {
        const src = ((frameIndex + i) % total) * wav.channels;
        for (let c = 0; c < wav.channels; c++) out[i * wav.channels + c] = wav.samples[src + c];
      }
      return out;
    };
  },
};

/** Reads a 16-bit PCM WAV file (mono or stereo). */
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file: ' + file);
  }
  let off = 12;
  let fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV: data before fmt');
      if (fmt.audioFormat !== 1 || fmt.bits !== 16) throw new Error('WAV must be 16-bit PCM');
      const len = Math.min(size, b.length - body) & ~1;
      const samples = new Int16Array(len / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = b.readInt16LE(body + i * 2);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV: no data chunk');
}

module.exports = { generators, readWav };
