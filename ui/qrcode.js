"use strict";

// Minimal, dependency-free QR Code encoder — enough for wallet addresses.
//
// Scope: byte mode, error-correction level M (~15% recovery), versions 1-10
// (up to 213 bytes). Every address the app shows fits with room to spare, and
// the narrow scope keeps this file small enough to audit. Structure follows
// ISO/IEC 18004. No dependency and no network: the renderer runs under a
// strict CSP (script-src 'self') and must work offline.
//
// Loaded as a plain <script> by ui/index.html, and importable from node for
// the test suite.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QRCode = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // ---- error-correction level M: EC codewords per block, and block layout ----
  // g1/g2 are [blockCount, dataCodewordsPerBlock]; g2 is absent when all
  // blocks are the same size.
  const EC_M = {
    1: { ec: 10, g1: [1, 16] },
    2: { ec: 16, g1: [1, 28] },
    3: { ec: 26, g1: [1, 44] },
    4: { ec: 18, g1: [2, 32] },
    5: { ec: 24, g1: [2, 43] },
    6: { ec: 16, g1: [4, 27] },
    7: { ec: 18, g1: [4, 31] },
    8: { ec: 22, g1: [2, 38], g2: [2, 39] },
    9: { ec: 22, g1: [3, 36], g2: [2, 37] },
    10: { ec: 26, g1: [4, 43], g2: [1, 44] },
  };
  // Alignment-pattern centre coordinates per version (empty for version 1).
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  const MAX_VERSION = 10;
  const ECL_M_FORMAT_BITS = 0; // L=01, M=00, Q=11, H=10

  // ---- GF(256), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d) ----
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGf() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
  }

  // Reed-Solomon generator polynomial of the given degree, highest term first.
  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j]; // multiply by x
        next[j + 1] ^= gfMul(poly[j], EXP[i]); // ... and by alpha^i
      }
      poly = next;
    }
    return poly;
  }

  // Remainder of data * x^ecLen divided by the generator polynomial.
  function rsRemainder(data, ecLen) {
    const gen = rsGenerator(ecLen);
    const res = new Uint8Array(ecLen);
    for (const b of data) {
      const factor = b ^ res[0];
      res.copyWithin(0, 1);
      res[ecLen - 1] = 0;
      for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
    return res;
  }

  // ---- data encoding ----
  function dataCodewords(version) {
    const t = EC_M[version];
    return t.g1[0] * t.g1[1] + (t.g2 ? t.g2[0] * t.g2[1] : 0);
  }
  function countBits(version) {
    return version < 10 ? 8 : 16; // byte mode: 8 bits for v1-9, 16 for v10-26
  }
  function chooseVersion(byteLen) {
    for (let v = 1; v <= MAX_VERSION; v++) {
      if (4 + countBits(v) + byteLen * 8 <= dataCodewords(v) * 8) return v;
    }
    const max = Math.floor((dataCodewords(MAX_VERSION) * 8 - 4 - 16) / 8);
    throw new Error(`QR: ${byteLen} bytes is too long (max ${max})`);
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
    const out = [];
    for (const ch of String(text)) {
      let cp = ch.codePointAt(0);
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return Uint8Array.from(out);
  }

  // Byte-mode bit stream -> padded data codewords for the chosen version.
  function dataCodewordsFor(bytes, version) {
    const capacity = dataCodewords(version) * 8;
    const bits = [];
    const push = (value, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };
    push(0b0100, 4); // byte mode
    push(bytes.length, countBits(version));
    for (const b of bytes) push(b, 8);
    for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0); // terminator
    while (bits.length % 8 !== 0) bits.push(0);

    const out = new Uint8Array(dataCodewords(version));
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      out[i / 8] = byte;
    }
    for (let i = bits.length / 8, pad = 0; i < out.length; i++, pad++) {
      out[i] = pad % 2 === 0 ? 0xec : 0x11; // spec-mandated pad bytes
    }
    return out;
  }

  // Split into blocks, add EC codewords, then interleave both halves.
  function interleave(data, version) {
    const t = EC_M[version];
    const groups = t.g2 ? [t.g1, t.g2] : [t.g1];
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (const [count, len] of groups) {
      for (let i = 0; i < count; i++) {
        const block = data.subarray(offset, offset + len);
        offset += len;
        dataBlocks.push(block);
        ecBlocks.push(rsRemainder(block, t.ec));
      }
    }
    const out = [];
    const maxData = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxData; i++) {
      for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
    }
    for (let i = 0; i < t.ec; i++) {
      for (const b of ecBlocks) out.push(b[i]);
    }
    return Uint8Array.from(out);
  }

  // ---- BCH-protected metadata ----
  function formatBits(mask) {
    const data = (ECL_M_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }
  function versionBits(version) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (version << 12) | rem;
  }

  // ---- matrix ----
  function newGrid(size) {
    const g = [];
    for (let i = 0; i < size; i++) g.push(new Uint8Array(size));
    return g;
  }

  function buildMatrix(version, codewords) {
    const size = version * 4 + 17;
    const m = newGrid(size);
    const fn = newGrid(size); // 1 = function module, not available for data
    const set = (r, c, dark) => {
      m[r][c] = dark ? 1 : 0;
      fn[r][c] = 1;
    };

    // Timing patterns first; the finders overwrite their ends.
    for (let i = 0; i < size; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    // Finder patterns (with separators) at three corners.
    for (const [cr, cc] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
      for (let dr = -4; dr <= 4; dr++) {
        for (let dc = -4; dc <= 4; dc++) {
          const r = cr + dr, c = cc + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const d = Math.max(Math.abs(dr), Math.abs(dc));
          set(r, c, d !== 2 && d !== 4);
        }
      }
    }
    // Alignment patterns, skipping the three that collide with finders.
    const centers = ALIGN[version];
    const last = centers.length - 1;
    for (let i = 0; i < centers.length; i++) {
      for (let j = 0; j < centers.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            set(centers[i] + dr, centers[j] + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
          }
        }
      }
    }
    // Reserve the format area (rewritten with the real mask further down) and
    // place the always-dark module.
    drawFormat(m, fn, size, 0);
    set(size - 8, 8, true);
    // Version information, versions 7 and up.
    if (version >= 7) {
      const bits = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = (bits >>> i) & 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        set(b, a, bit);
        set(a, b, bit);
      }
    }

    // Zigzag data placement, right to left in column pairs, skipping the
    // vertical timing column; leftover modules stay light.
    let bitIndex = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - vert : vert;
          if (fn[r][c] || bitIndex >= codewords.length * 8) continue;
          m[r][c] = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
      }
    }

    // Pick the mask with the lowest penalty, then write the real format bits.
    let best = 0;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(m, fn, size, mask);
      drawFormat(m, fn, size, mask);
      const score = penalty(m, size);
      if (score < bestScore) {
        bestScore = score;
        best = mask;
      }
      applyMask(m, fn, size, mask); // xor again to undo
    }
    applyMask(m, fn, size, best);
    drawFormat(m, fn, size, best);
    return { size, modules: m, version, mask: best };
  }

  function drawFormat(m, fn, size, mask) {
    const bits = formatBits(mask);
    const set = (r, c, v) => {
      m[r][c] = v;
      fn[r][c] = 1;
    };
    for (let i = 0; i < 15; i++) {
      const bit = (bits >>> i) & 1;
      // First copy, around the top-left finder.
      if (i < 6) set(i, 8, bit);
      else if (i === 6) set(7, 8, bit);
      else if (i === 7) set(8, 8, bit);
      else if (i === 8) set(8, 7, bit);
      else set(8, 14 - i, bit);
      // Second copy, split between the other two finders.
      if (i < 8) set(8, size - 1 - i, bit);
      else set(size - 15 + i, 8, bit);
    }
  }

  function maskBit(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }
  function applyMask(m, fn, size, mask) {
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!fn[r][c] && maskBit(mask, r, c)) m[r][c] ^= 1;
      }
    }
  }

  // Penalty rules from the spec: long runs, 2x2 blocks, finder-like patterns,
  // and overall dark/light imbalance.
  const FINDER_RUN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  function penalty(m, size) {
    let score = 0;
    const line = new Array(size);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) line[j] = pass === 0 ? m[i][j] : m[j][i];
        // Rule 1: runs of five or more identical modules.
        let run = 1;
        for (let j = 1; j < size; j++) {
          if (line[j] === line[j - 1]) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score += 1;
          } else run = 1;
        }
        // Rule 3: 1:1:3:1:1 finder-like pattern with four light modules beside it.
        for (let j = 0; j + 11 <= size; j++) {
          let fwd = true, rev = true;
          for (let k = 0; k < 11; k++) {
            if (line[j + k] !== FINDER_RUN[k]) fwd = false;
            if (line[j + k] !== FINDER_RUN[10 - k]) rev = false;
          }
          if (fwd || rev) score += 40;
        }
      }
    }
    // Rule 2: 2x2 blocks of one colour.
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }
    // Rule 4: deviation from a 50% dark ratio.
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  // ---- public API ----
  // encode(text) -> { size, version, mask, modules } where modules[row][col]
  // is 1 for a dark module. The quiet zone is not included.
  function encode(text) {
    const bytes = utf8Bytes(text);
    if (bytes.length === 0) throw new Error("QR: nothing to encode");
    const version = chooseVersion(bytes.length);
    return buildMatrix(version, interleave(dataCodewordsFor(bytes, version), version));
  }

  // Renders to an <svg> element: one path for all dark modules, so it stays
  // crisp at any size. Always dark-on-white — scanners need the light ground,
  // whatever theme the app is in.
  function toSvg(text, opts) {
    if (typeof document === "undefined") throw new Error("QR: toSvg needs a DOM");
    const o = opts || {};
    const margin = o.margin == null ? 4 : o.margin; // spec asks for 4 modules
    const { size, modules } = encode(text);
    const dim = size + margin * 2;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${dim} ${dim}`);
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", o.label || "QR code");
    const bg = document.createElementNS(NS, "rect");
    bg.setAttribute("width", String(dim));
    bg.setAttribute("height", String(dim));
    bg.setAttribute("fill", o.light || "#ffffff");
    svg.appendChild(bg);
    let d = "";
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (modules[r][c]) d += `M${c + margin} ${r + margin}h1v1h-1z`;
      }
    }
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", o.dark || "#000000");
    svg.appendChild(path);
    return svg;
  }

  return { encode, toSvg };
});
