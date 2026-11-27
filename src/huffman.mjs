// Length-limited Huffman code lengths, canonical codes, and the dynamic-block header (with run-length coding).

/** Code lengths (<= maxBits) for a frequency table. A lone symbol gets length 1; no symbols gives all zeros. */
export function huffLengths(freq, n, maxBits, out) {
  out.fill(0, 0, n);
  const used = [];
  for (let s = 0; s < n; s++) if (freq[s] > 0) used.push(s);
  const m = used.length;
  if (m === 0) return;
  if (m === 1) { out[used[0]] = 1; return; }
  used.sort((a, b) => freq[a] - freq[b] || a - b);
  // two-queue Huffman construction over the sorted leaves
  const w = new Float64Array(2 * m), parent = new Int32Array(2 * m);
  for (let i = 0; i < m; i++) w[i] = freq[used[i]];
  let leaf = 0, node = m, next = m;
  for (let k = 0; k < m - 1; k++) {
    const pick = () => (leaf < m && (next >= node || w[leaf] <= w[next])) ? leaf++ : next++;
    const a = pick(), b = pick();
    w[node] = w[a] + w[b];
    parent[a] = node; parent[b] = node;
    node++;
  }
  const depth = new Int32Array(2 * m);
  let maxDepth = 0;
  for (let i = node - 2; i >= 0; i--) { depth[i] = depth[parent[i]] + 1; }
  for (let i = 0; i < m; i++) { out[used[i]] = depth[i]; if (depth[i] > maxDepth) maxDepth = depth[i]; }
  if (maxDepth <= maxBits) return;
  // Too deep (rare): cap, then lengthen the longest short codes until the Kraft sum fits.
  const lim = 1 << maxBits;
  let kraft = 0;
  for (const s of used) { if (out[s] > maxBits) out[s] = maxBits; kraft += 1 << (maxBits - out[s]); }
  while (kraft > lim) {
    let pickSym = -1;
    for (let i = 0; i < m; i++) { // used is ascending by frequency: prefer lightest symbol among the longest sub-max codes
      const s = used[i];
      if (out[s] < maxBits && (pickSym < 0 || out[s] > out[pickSym])) pickSym = s;
    }
    kraft -= 1 << (maxBits - out[pickSym] - 1);
    out[pickSym]++;
  }
  // an under-full code is invalid for decoders: spend the slack on the most frequent symbols that can shorten
  for (;;) {
    let pickSym = -1;
    for (let i = m - 1; i >= 0; i--) {
      const s = used[i];
      if (out[s] > 1 && kraft + (1 << (maxBits - out[s])) <= lim) { pickSym = s; break; }
    }
    if (pickSym < 0) break;
    kraft += 1 << (maxBits - out[pickSym]);
    out[pickSym]--;
  }
}

/** Canonical codes, bit-reversed for an LSB-first writer. */
export function makeCodes(lengths, n, codes) {
  const count = new Int32Array(16), nextCode = new Int32Array(16);
  for (let s = 0; s < n; s++) count[lengths[s]]++;
  count[0] = 0;
  let code = 0;
  for (let b = 1; b < 16; b++) { code = (code + count[b - 1]) << 1; nextCode[b] = code; }
  for (let s = 0; s < n; s++) {
    const len = lengths[s];
    if (!len) { codes[s] = 0; continue; }
    let c = nextCode[len]++, r = 0;
    for (let i = 0; i < len; i++) { r = (r << 1) | (c & 1); c >>= 1; }
    codes[s] = r;
  }
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Run-length code a length sequence into [symbol, extraValue] pairs. Flags allow each of 16, 17, 18 to be unused. */
function rle(seq, use16, use17, use18) {
  const out = [];
  const n = seq.length;
  for (let i = 0; i < n; ) {
    const v = seq[i];
    let run = 1;
    while (i + run < n && seq[i + run] === v) run++;
    let left = run;
    if (v === 0) {
      while (left >= 3 && (use17 || use18)) {
        if (use18 && left >= 11) { const c = Math.min(left, 138); out.push([18, c - 11]); left -= c; }
        else if (use17) { const c = Math.min(left, 10); if (c < 3) break; out.push([17, c - 3]); left -= c; }
        else break;
      }
    } else if (use16 && left >= 4) {
      out.push([v, 0]); left--;
      while (left >= 3) { const c = Math.min(left, 6); out.push([16, c - 3]); left -= c; }
    }
    while (left-- > 0) out.push([v, 0]);
    i += run;
  }
  return out;
}

const CL_EXTRA = { 16: 2, 17: 3, 18: 7 };

/**
 * The cheapest dynamic header for the given lit/len and distance code lengths. Returns
 * { bits, hlit, hdist, hclen, items, clLengths } where items are the run-length symbols to emit.
 */
export function bestHeader(litLen, distLen) {
  let hlit = 286; while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30; while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const seq = new Uint8Array(hlit + hdist);
  seq.set(litLen.subarray(0, hlit), 0); seq.set(distLen.subarray(0, hdist), hlit);
  let best = null;
  const freq = new Int32Array(19), clLen = new Uint8Array(19);
  for (let mask = 0; mask < 8; mask++) {
    const items = rle(seq, !!(mask & 1), !!(mask & 2), !!(mask & 4));
    freq.fill(0);
    for (const [s] of items) freq[s]++;
    huffLengths(freq, 19, 7, clLen);
    let hclen = 19; while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
    let bits = 14 + hclen * 3;
    for (const [s] of items) bits += clLen[s] + (CL_EXTRA[s] ?? 0);
    if (best === null || bits < best.bits) best = { bits, hlit, hdist, hclen, items, clLengths: Uint8Array.from(clLen) };
  }
  return best;
}

export { CL_ORDER, CL_EXTRA };
