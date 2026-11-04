/*
 * Tiny QR code generator (byte mode, error correction level M, versions 1-10: up to 213 bytes).
 * Enough for "http://192.168.x.x:8080/" style URLs. No dependencies, works offline.
 *
 *   const m = QR.encode('http://192.168.1.20:8080/');  // m.size, m.get(x, y) -> true = dark
 *   QR.toSvg(m)  // SVG string
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // [ecCodewordsPerBlock, blocksInGroup1, dataCodewordsGroup1, blocksInGroup2, dataCodewordsGroup2]
  const EC_M = [null,
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // ---- GF(256) arithmetic for Reed-Solomon
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function rsGenerator(degree) {
    let g = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= mul(g[j], EXP[i]);
      }
      g = next;
    }
    return g;
  }

  function rsRemainder(data, degree) {
    const gen = rsGenerator(degree);
    const res = new Array(degree).fill(0);
    for (const d of data) {
      const factor = d ^ res.shift();
      res.push(0);
      for (let i = 0; i < degree; i++) res[i] ^= mul(gen[i + 1], factor);
    }
    return res;
  }

  function dataCapacity(v) {
    const e = EC_M[v];
    return e[1] * e[2] + e[3] * e[4];
  }

  // ---- bit stream
  function buildCodewords(bytes, v) {
    const bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0b0100, 4); // byte mode
    put(bytes.length, v < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    const capBits = dataCapacity(v) * 8;
    put(0, Math.min(4, capBits - bits.length)); // terminator
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    for (let pad = 0xec; data.length < dataCapacity(v); pad ^= 0xec ^ 0x11) data.push(pad);

    // split into blocks, add EC, interleave
    const [ec, b1, d1, b2, d2] = EC_M[v];
    const blocks = [];
    let off = 0;
    for (let i = 0; i < b1 + b2; i++) {
      const len = i < b1 ? d1 : d2;
      const d = data.slice(off, off + len);
      off += len;
      blocks.push({ d, e: rsRemainder(d, ec) });
    }
    const out = [];
    const maxD = Math.max(d1, d2);
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
    return out;
  }

  // ---- matrix
  function makeMatrix(v) {
    const size = 17 + 4 * v;
    const dark = new Uint8Array(size * size);
    const fn = new Uint8Array(size * size); // function-pattern modules (not data)
    const set = (x, y, d) => { dark[y * size + x] = d ? 1 : 0; fn[y * size + x] = 1; };

    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    for (let i = 8; i < size - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }

    const al = ALIGN[v];
    for (const ay of al) for (const ax of al) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === al[al.length - 1]) || (ax === al[al.length - 1] && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    // reserve format areas + dark module
    for (let i = 0; i < 9; i++) { fn[8 * size + i] = 1; fn[i * size + 8] = 1; }
    for (let i = 0; i < 8; i++) { fn[8 * size + (size - 1 - i)] = 1; fn[(size - 1 - i) * size + 8] = 1; }
    set(8, size - 8, true);

    // version info (v >= 7)
    if (v >= 7) {
      let rem = v;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (v << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(a, b, bit); set(b, a, bit);
      }
    }
    return { size, dark, fn };
  }

  function placeData(m, codewords) {
    const { size, dark, fn } = m;
    let bitIndex = 0;
    const total = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (fn[y * size + x]) continue;
          if (bitIndex < total) {
            dark[y * size + x] = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
            bitIndex++;
          }
        }
      }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function applyMask(m, k) {
    const { size, dark, fn } = m;
    const out = dark.slice();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!fn[y * size + x] && MASKS[k](x, y)) out[y * size + x] ^= 1;
    }
    return out;
  }

  function drawFormat(size, dark, mask) {
    const data = (0b00 << 3) | mask; // EC level M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => (bits >>> i) & 1;
    const set = (x, y, b) => { dark[y * size + x] = b; };
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, 1);
  }

  function penalty(size, d) {
    let score = 0;
    const at = (x, y) => d[y * size + x];
    // N1: runs of 5+ same color in rows/cols
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          const cur = pass ? at(a, b) : at(b, a);
          const prev = pass ? at(a, b - 1) : at(b - 1, a);
          if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
          else run = 1;
        }
      }
    }
    // N2: 2x2 blocks
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
    }
    // N3: finder-like patterns 1011101 with 4 light on one side
    const pat = [1, 0, 1, 1, 1, 0, 1];
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        for (let b = 0; b + 7 <= size; b++) {
          let ok = true;
          for (let k = 0; k < 7 && ok; k++) ok = (pass ? at(a, b + k) : at(b + k, a)) === pat[k];
          if (!ok) continue;
          const light = (from, to) => {
            for (let k = from; k < to; k++) {
              if (k < 0 || k >= size) continue;
              if ((pass ? at(a, k) : at(k, a)) !== 0) return false;
            }
            return true;
          };
          if (light(b - 4, b) || light(b + 7, b + 11)) score += 40;
        }
      }
    }
    // N4: dark proportion
    let darkCount = 0;
    for (let i = 0; i < d.length; i++) darkCount += d[i];
    score += Math.floor(Math.abs(darkCount * 20 - d.length * 10) / d.length) * 10;
    return score;
  }

  function encode(text, opts = {}) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let v = 1;
    while (v <= 10 && dataCapacity(v) < bytes.length + (v < 10 ? 2 : 3)) v++;
    if (v > 10) throw new Error('Text too long for this QR encoder (max ~210 bytes)');
    if (opts.version) v = opts.version;
    const m = makeMatrix(v);
    placeData(m, buildCodewords(bytes, v));
    let best = null;
    const masks = opts.mask !== undefined ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
    for (const k of masks) {
      const d = applyMask(m, k);
      drawFormat(m.size, d, k);
      const p = penalty(m.size, d);
      if (!best || p < best.p) best = { d, p, k };
    }
    const size = m.size;
    return { size, version: v, mask: best.k, modules: best.d, get: (x, y) => best.d[y * size + x] === 1 };
  }

  function toSvg(qr, { border = 4, dark = '#000', light = '#fff' } = {}) {
    const n = qr.size + border * 2;
    let path = '';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
      if (qr.get(x, y)) path += `M${x + border} ${y + border}h1v1h-1z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
      `<rect width="${n}" height="${n}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
  }

  return { encode, toSvg };
});
