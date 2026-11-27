// Our own DEFLATE encoder: hash-chain match search, cost-model optimal parsing (iterated), adaptive block splitting,
// per-block dynamic Huffman codes. Everything is bounded by work, never by the clock, so output is deterministic.
import { adler32 } from './png.mjs';
import { wasmAvailable, workspace } from './wasm.mjs';
import { bestHeader, CL_ORDER, CL_EXTRA, huffLengths, makeCodes } from './huffman.mjs';

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_XB = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_XB = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_SYM = new Uint16Array(259); // match length -> length symbol index 0..28
for (let s = 0; s < 29; s++) for (let l = LEN_BASE[s]; l < (s < 28 ? LEN_BASE[s + 1] : 259); l++) LEN_SYM[l] = s;
LEN_SYM[258] = 28;
// NEXT_TOP[l]: the smallest length >= l that is the last of its length code
const NEXT_TOP = new Uint16Array(261);
for (let l = 260; l >= 0; l--) NEXT_TOP[l] = l >= 258 ? 258 : (l >= 3 && LEN_SYM[l + 1] !== LEN_SYM[l]) ? l : NEXT_TOP[l + 1];
const DIST_SYM = new Uint8Array(32769);
for (let s = 0; s < 30; s++) for (let d = DIST_BASE[s]; d < (s < 29 ? DIST_BASE[s + 1] : 32769); d++) DIST_SYM[d] = s;

// ---------------------------------------------------------------------------------------------------------------
// Match search: for every position, the (length, distance) pairs where a longer match first appears (smallest dist).

function findMatches(data, maxChain, nice) {
  const n = data.length;
  const head = new Int32Array(1 << 15).fill(-1), prev = new Int32Array(32768).fill(-1);
  const off = new Int32Array(n + 1);
  let pool = new Uint32Array(Math.max(1024, n * 2)), top = 0;
  for (let i = 0; i < n; i++) {
    off[i] = top;
    if (i + 2 < n) {
      const h = Math.imul((data[i] << 16) | (data[i + 1] << 8) | data[i + 2], 0x9e3779b1) >>> 17;
      let cand = head[h], chain = maxChain, best = 2, last = i;
      const maxLen = Math.min(258, n - i);
      while (cand >= 0 && cand < last && chain-- > 0) {
        const dist = i - cand;
        if (dist > 32768) break;
        if (data[cand + best] === data[i + best]) {
          let l = 0;
          while (l < maxLen && data[cand + l] === data[i + l]) l++;
          if (l > best) {
            if (top === pool.length) { const g = new Uint32Array(pool.length * 2); g.set(pool); pool = g; }
            pool[top++] = ((dist - 1) << 9) | (l - 3);
            best = l;
            if (l >= maxLen || l >= nice) break;
            if (l >= 32 && chain > (maxChain >> 2)) chain = maxChain >> 2;
          }
        }
        last = cand;
        cand = prev[cand & 32767];
      }
      prev[i & 32767] = head[h]; head[h] = i;
    }
  }
  off[n] = top;
  return { off, pool };
}

/**
 * Binary-tree match search (as in LZ-family encoders): every position is inserted in a tree keyed on the bytes that
 * follow it, so one descent reports, for each length that first becomes possible, the nearest distance, without a
 * chain limit on what can be found (only `cut` bounds the work per position). Same output shape as findMatches.
 */
function findMatchesBT(data, cut) {
  const n = data.length, W = 32768;
  const head = new Int32Array(1 << 16); // position + 1 of the newest suffix with this 3-byte hash; 0 = empty
  const son = new Int32Array(2 * W);    // per window slot: [smaller child, larger child], positions + 1
  const off = new Int32Array(n + 1);
  let pool = new Uint32Array(Math.max(1024, n * 2)), top = 0;
  for (let i = 0; i < n; i++) {
    off[i] = top;
    if (i + 2 >= n) continue;
    const h = Math.imul((data[i] << 16) | (data[i + 1] << 8) | data[i + 2], 0x9e3779b1) >>> 16;
    const lenLimit = Math.min(258, n - i);
    let cur = head[h];
    head[h] = i + 1;
    const slot = i & (W - 1);
    let ptrLess = slot * 2, ptrMore = slot * 2 + 1; // where the next smaller / larger subtree hangs
    let lenLess = 0, lenMore = 0, best = 2, count = cut;
    for (;;) {
      const cm = cur - 1; // candidate position
      const delta = i - cm;
      if (cur === 0 || count-- === 0 || delta >= W) { son[ptrLess] = 0; son[ptrMore] = 0; break; }
      const nslot = cm & (W - 1);
      let len = lenLess < lenMore ? lenLess : lenMore;
      if (data[cm + len] === data[i + len]) {
        while (++len < lenLimit && data[cm + len] === data[i + len]);
        if (len > best) {
          best = len;
          if (top === pool.length) { const g = new Uint32Array(pool.length * 2); g.set(pool); pool = g; }
          pool[top++] = ((delta - 1) << 9) | (len - 3);
          if (len === lenLimit) { son[ptrLess] = son[nslot * 2]; son[ptrMore] = son[nslot * 2 + 1]; break; }
        }
      }
      if (data[cm + len] < data[i + len]) { son[ptrLess] = cur; ptrLess = nslot * 2 + 1; cur = son[ptrLess]; lenLess = len; }
      else { son[ptrMore] = cur; ptrMore = nslot * 2; cur = son[ptrMore]; lenMore = len; }
    }
  }
  off[n] = top;
  return { off, pool };
}

// ---------------------------------------------------------------------------------------------------------------
// Cost model from symbol statistics (entropy based, as in zopfli).

function newTables() {
  return { lit: new Float64Array(256), len: new Float64Array(259), dist: new Float64Array(30) };
}

let UNUSED = 99;
export function setUnused(v) { UNUSED = v; }
function tablesFrom(litHist, distHist, tab) {
  let tl = 0, td = 0;
  for (let s = 0; s < 286; s++) tl += litHist[s];
  for (let s = 0; s < 30; s++) td += distHist[s];
  tl = Math.max(tl, 1); td = Math.max(td, 1);
  const bitsL = (c) => (c > 0 ? Math.log2(tl / c) : Math.min(UNUSED, Math.log2(tl) + 1));
  const bitsD = (c) => (c > 0 ? Math.log2(td / c) : Math.min(UNUSED, Math.log2(td) + 1));
  for (let b = 0; b < 256; b++) tab.lit[b] = bitsL(litHist[b]);
  for (let l = 3; l <= 258; l++) { const s = LEN_SYM[l]; tab.len[l] = bitsL(litHist[257 + s]) + LEN_XB[s]; }
  for (let s = 0; s < 30; s++) tab.dist[s] = bitsD(distHist[s]) + DIST_XB[s];
  return tab;
}

// ---------------------------------------------------------------------------------------------------------------
// Optimal parse: forward shortest path over positions with per-block cost tables.
// blockStart[k] is the first position governed by tables[k]. Returns tokens { tl, td, tp, count }:
// tl = match length (0 for a literal), td = literal byte or match distance, tp = start position.

function parse(data, mm, tables, blockStart, sparse = 258, scratch = null) {
  const n = data.length, { off, pool } = mm;
  // the big work arrays are reused from round to round (fresh ones each round only cost page faults and GC)
  const cost = scratch ? scratch.cost.fill(Infinity) : new Float64Array(n + 1).fill(Infinity);
  const pLen = scratch ? scratch.pLen : new Uint16Array(n + 1), pDist = scratch ? scratch.pDist : new Uint16Array(n + 1);
  cost[0] = 0;
  let bi = 0, tab = tables[0], nextB = blockStart.length > 1 ? blockStart[1] : Infinity;
  for (let i = 0; i < n; i++) {
    if (i >= nextB) { bi++; tab = tables[bi]; nextB = bi + 1 < blockStart.length ? blockStart[bi + 1] : Infinity; }
    const ci = cost[i];
    const lc = ci + tab.lit[data[i]];
    if (lc < cost[i + 1]) { cost[i + 1] = lc; pLen[i + 1] = 1; pDist[i + 1] = 0; }
    let from = 3;
    for (let k = off[i], e = off[i + 1]; k < e; k++) {
      const v = pool[k], len = (v & 511) + 3, dist = (v >>> 9) + 1;
      const dc = ci + tab.dist[DIST_SYM[dist]];
      // a maximal match inside a long run: only the full length is worth relaxing (keeps flat areas cheap)
      if (len === 258) from = 258;
      const full = len < sparse ? len : sparse;
      for (let l = from; l <= full; l++) {
        const c = dc + tab.len[l];
        if (c < cost[i + l]) { cost[i + l] = c; pLen[i + l] = l; pDist[i + l] = dist - 1; }
      }
      if (len > full) {
        // past `sparse`, only the last length of each length code (they all cost the same) and the match's own
        // length are relaxed: the dropped ones would land on positions a longer step reaches for the same price
        for (let l = NEXT_TOP[from > full ? from : full + 1]; l < len; l = NEXT_TOP[l + 1]) {
          const c = dc + tab.len[l];
          if (c < cost[i + l]) { cost[i + l] = c; pLen[i + l] = l; pDist[i + l] = dist - 1; }
        }
        const c = dc + tab.len[len];
        if (c < cost[i + len]) { cost[i + len] = c; pLen[i + len] = len; pDist[i + len] = dist - 1; }
      }
      from = len + 1;
    }
  }
  return traceback(data, pLen, pDist);
}

/** Tokens of the cheapest path, read back from the step lengths and distances that reach each position. */
function traceback(data, pLen, pDist) {
  const n = data.length;
  let cnt = 0;
  for (let p = n; p > 0; p -= pLen[p]) cnt++;
  const tl = new Uint16Array(cnt), td = new Uint16Array(cnt), tp = new Int32Array(cnt);
  for (let p = n, k = cnt - 1; p > 0; k--) {
    const l = pLen[p];
    p -= l;
    tp[k] = p;
    if (l === 1) { tl[k] = 0; td[k] = data[p]; } else { tl[k] = l; td[k] = pDist[p + l] + 1; }
  }
  return { tl, td, tp, count: cnt };
}

// ---------------------------------------------------------------------------------------------------------------
// Block statistics, exact block cost, and splitting.

function histogram(tok, a, b, lit, dist) {
  lit.fill(0); dist.fill(0);
  for (let k = a; k < b; k++) {
    const l = tok.tl[k];
    if (l === 0) lit[tok.td[k]]++;
    else { lit[257 + LEN_SYM[l]]++; dist[DIST_SYM[tok.td[k]]]++; }
  }
  lit[256] = 1;
}

const FIXED_LIT = new Uint8Array(288), FIXED_DIST = new Uint8Array(30).fill(5);
for (let i = 0; i < 288; i++) FIXED_LIT[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;

// block costs while splitting use one run-length variant of the header (the exact best one is written): ~2 s saved
let QUICK_HEADER = true;
export function setQuickHeader(v) { QUICK_HEADER = v; }
const scratchL = new Uint8Array(288), scratchD = new Uint8Array(30);
/** Exact bit cost of a block (best of dynamic and fixed) for its histograms. */
function blockBits(lit, dist, quick = QUICK_HEADER) {
  huffLengths(lit, 286, 15, scratchL);
  huffLengths(dist, 30, 15, scratchD);
  let data = 0, fixed = 0;
  for (let s = 0; s < 286; s++) {
    if (!lit[s]) continue;
    const xb = s >= 257 ? LEN_XB[s - 257] : 0;
    data += lit[s] * (scratchL[s] + xb);
    fixed += lit[s] * (FIXED_LIT[s] + xb);
  }
  for (let s = 0; s < 30; s++) { if (!dist[s]) continue; data += dist[s] * (scratchD[s] + DIST_XB[s]); fixed += dist[s] * (5 + DIST_XB[s]); }
  const dyn = 3 + bestHeader(scratchL, scratchD, quick ? 1 : 8).bits + data;
  return Math.min(dyn, 3 + fixed);
}

/** Merge small fixed-size token chunks greedily while the merged block is not larger. Returns token-index starts. */
function splitBlocks(tok, chunk) {
  const m = Math.ceil(tok.count / chunk);
  if (m <= 1) return [0];
  const L = [], D = [], start = [], alive = [], bits = [];
  for (let c = 0; c < m; c++) {
    const l = new Int32Array(288), d = new Int32Array(30);
    histogram(tok, c * chunk, Math.min(tok.count, (c + 1) * chunk), l, d);
    L.push(l); D.push(d); start.push(c * chunk); alive.push(true);
    bits.push(blockBits(l, d));
  }
  const nxt = Array.from({ length: m }, (_, i) => (i + 1 < m ? i + 1 : -1));
  const prv = Array.from({ length: m }, (_, i) => i - 1);
  const mergedL = new Int32Array(288), mergedD = new Int32Array(30);
  const gain = new Float64Array(m).fill(-Infinity); // gain[i]: bits saved by merging block i with its successor
  const calc = (i) => {
    const j = nxt[i];
    if (j < 0) { gain[i] = -Infinity; return; }
    for (let s = 0; s < 288; s++) mergedL[s] = L[i][s] + L[j][s];
    for (let s = 0; s < 30; s++) mergedD[s] = D[i][s] + D[j][s];
    mergedL[256] = 1;
    gain[i] = bits[i] + bits[j] - blockBits(mergedL, mergedD);
  };
  for (let i = 0; i < m; i++) calc(i);
  for (;;) {
    let bi = -1, bg = 0;
    for (let i = 0; i < m; i++) if (alive[i] && gain[i] > bg) { bg = gain[i]; bi = i; }
    if (bi < 0) break;
    const j = nxt[bi];
    for (let s = 0; s < 288; s++) L[bi][s] += L[j][s];
    for (let s = 0; s < 30; s++) D[bi][s] += D[j][s];
    L[bi][256] = 1;
    bits[bi] = bits[bi] + bits[j] - bg;
    alive[j] = false; nxt[bi] = nxt[j];
    if (nxt[j] >= 0) prv[nxt[j]] = bi;
    gain[j] = -Infinity;
    calc(bi);
    if (prv[bi] >= 0) calc(prv[bi]);
  }
  const out = [];
  for (let i = 0; i < m; i++) if (alive[i]) out.push(start[i]);
  return out;
}

/**
 * Local boundary refinement: each boundary between two blocks is slid over steps of `step` tokens within `radius`
 * steps either way, wherever that makes the two blocks together cheaper (exact block costs); repeated while it helps.
 */
function refineSplits(tok, starts, step, radius) {
  if (starts.length < 2) return starts;
  const s = starts.slice();
  const L1 = new Int32Array(288), D1 = new Int32Array(30), L2 = new Int32Array(288), D2 = new Int32Array(30);
  const cost = (a, b, L, D) => { histogram(tok, a, b, L, D); return blockBits(L, D); };
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let k = 1; k < s.length; k++) {
      const a = s[k - 1], b = k + 1 < s.length ? s[k + 1] : tok.count;
      let best = cost(a, s[k], L1, D1) + cost(s[k], b, L2, D2), bestPos = s[k];
      for (let d = -radius; d <= radius; d++) {
        const p = s[k] + d * step;
        if (d === 0 || p <= a || p >= b) continue;
        const c = cost(a, p, L1, D1) + cost(p, b, L2, D2);
        if (c < best) { best = c; bestPos = p; }
      }
      if (bestPos !== s[k]) { s[k] = bestPos; moved = true; }
    }
    if (!moved) break;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Bit output.

class Bits {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.acc = 0; this.n = 0; }
  put(v, nb) {
    this.acc |= v << this.n; this.n += nb;
    while (this.n >= 8) {
      if (this.pos === this.buf.length) { const g = new Uint8Array(this.buf.length * 2); g.set(this.buf); this.buf = g; }
      this.buf[this.pos++] = this.acc & 255; this.acc >>>= 8; this.n -= 8;
    }
  }
  flush() { if (this.n > 0) this.put(0, 8 - this.n); }
}

function writeBlock(w, tok, a, b, last, lit, dist) {
  histogram(tok, a, b, lit, dist);
  const litLen = new Uint8Array(288), distLen = new Uint8Array(30);
  huffLengths(lit, 286, 15, litLen);
  huffLengths(dist, 30, 15, distLen);
  let data = 0, fixed = 0;
  for (let s = 0; s < 286; s++) { if (!lit[s]) continue; const xb = s >= 257 ? LEN_XB[s - 257] : 0; data += lit[s] * (litLen[s] + xb); fixed += lit[s] * (FIXED_LIT[s] + xb); }
  for (let s = 0; s < 30; s++) { if (!dist[s]) continue; data += dist[s] * (distLen[s] + DIST_XB[s]); fixed += dist[s] * (5 + DIST_XB[s]); }
  const hdr = bestHeader(litLen, distLen);
  const useFixed = fixed <= hdr.bits + data;
  w.put(last ? 1 : 0, 1);
  const lc = new Uint16Array(288), dc = new Uint16Array(30);
  let LL = litLen, DL = distLen;
  if (useFixed) {
    w.put(1, 2); LL = FIXED_LIT; DL = FIXED_DIST;
  } else {
    w.put(2, 2);
    w.put(hdr.hlit - 257, 5); w.put(hdr.hdist - 1, 5); w.put(hdr.hclen - 4, 4);
    for (let i = 0; i < hdr.hclen; i++) w.put(hdr.clLengths[CL_ORDER[i]], 3);
    const clc = new Uint16Array(19);
    makeCodes(hdr.clLengths, 19, clc);
    for (const [s, x] of hdr.items) { w.put(clc[s], hdr.clLengths[s]); if (CL_EXTRA[s]) w.put(x, CL_EXTRA[s]); }
  }
  makeCodes(LL, 288, lc); makeCodes(DL, 30, dc);
  for (let k = a; k < b; k++) {
    const l = tok.tl[k];
    if (l === 0) { const s = tok.td[k]; w.put(lc[s], LL[s]); }
    else {
      const ls = LEN_SYM[l], sy = 257 + ls;
      w.put(lc[sy], LL[sy]);
      if (LEN_XB[ls]) w.put(l - LEN_BASE[ls], LEN_XB[ls]);
      const d = tok.td[k], ds = DIST_SYM[d];
      w.put(dc[ds], DL[ds]);
      if (DIST_XB[ds]) w.put(d - DIST_BASE[ds], DIST_XB[ds]);
    }
  }
  w.put(lc[256], LL[256]);
}

// ---------------------------------------------------------------------------------------------------------------

/** Compress `data` into a zlib stream. opts: { chain, iterations, chunk }. */
export function deflateOptimal(data, opts = {}) {
  const patience = opts.patience ?? 1e9;
  const chain = opts.chain ?? 64, iterations = opts.iterations ?? 3, chunk = opts.chunk ?? 600;
  const n = data.length;
  // the WASM kernels (same algorithm, about twice as fast) when the runtime has WebAssembly, else the JS ones
  const ws = opts.bt && opts.wasm !== false && wasmAvailable() ? workspace(data, opts.bt, DIST_SYM) : null;
  const mm = ws ? ws.view() : opts.bt ? findMatchesBT(data, opts.bt) : findMatches(data, chain, opts.nice ?? 258);
  const runParse = (tables, blockStart) => {
    if (!ws) return parse(data, mm, tables, blockStart, opts.sparse ?? 258, scratch);
    const v = ws.parse(tables, blockStart);
    return traceback(data, v.plen, v.pdist);
  };
  const lit = new Int32Array(288), dist = new Int32Array(30);
  // first model: statistics of a greedy (longest match) parse
  const tab0 = newTables();
  {
    const hl = new Int32Array(288), hd = new Int32Array(30);
    for (let i = 0; i < n; ) {
      const e = mm.off[i + 1];
      if (e > mm.off[i]) { const v = mm.pool[e - 1], l = (v & 511) + 3; hl[257 + LEN_SYM[l]]++; hd[DIST_SYM[(v >>> 9) + 1]]++; i += l; }
      else { hl[data[i]]++; i++; }
    }
    hl[256] = 1;
    tablesFrom(hl, hd, tab0);
    if (opts.init === 'lit') {
      // literal-heavy start: literals priced by their own order-0 statistics, every match made dearer
      const lh = new Int32Array(288), z = new Int32Array(30);
      for (let i = 0; i < n; i++) lh[data[i]]++;
      for (let s2 = 257; s2 < 286; s2++) lh[s2] = hl[s2];
      lh[256] = 1;
      const t = tablesFrom(lh, hd, newTables());
      tab0.lit.set(t.lit);
      for (let l = 3; l <= 258; l++) tab0.len[l] += opts.litPenalty ?? 2;
    }
  }
  const scratch = ws ? null : { cost: new Float64Array(n + 1), pLen: new Uint16Array(n + 1), pDist: new Uint16Array(n + 1) };
  let tok = runParse([tab0], [0]);
  let best = null, bestIt = 0, prevPos = null;
  const resplit = opts.resplit ?? 1;
  for (let it = 0; ; it++) {
    // Re-split only every few rounds (it is the costly step); in between keep the previous block boundaries.
    let starts;
    if (prevPos === null || it % resplit === 0) { starts = splitBlocks(tok, chunk); if (opts.refine) starts = refineSplits(tok, starts, opts.refine[0], opts.refine[1]); }
    else {
      starts = [];
      for (const pos of prevPos) {
        let lo = 0, hi = tok.count;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (tok.tp[mid] < pos) lo = mid + 1; else hi = mid; }
        if (starts.length === 0 || lo > starts[starts.length - 1]) starts.push(lo);
      }
    }
    prevPos = starts.map((k) => tok.tp[k]);
    const ends = starts.map((s, k) => (k + 1 < starts.length ? starts[k + 1] : tok.count));
    let bits = 0;
    for (let k = 0; k < starts.length; k++) { histogram(tok, starts[k], ends[k], lit, dist); bits += blockBits(lit, dist); }
    if (opts.trace) console.error('iter', it, Math.round(bits / 8), 'blocks', starts.length);
    if (best === null || bits < best.bits) { best = { bits, tok, starts, ends }; bestIt = it; }
    if (it + 1 >= iterations || it - bestIt >= patience) break;
    // per-block cost tables from this parse, then parse again
    const tables = [], blockStart = [];
    for (let k = 0; k < starts.length; k++) {
      histogram(tok, starts[k], ends[k], lit, dist);
      tables.push(tablesFrom(lit, dist, newTables()));
      blockStart.push(tok.tp[starts[k]]);
    }
    tok = runParse(tables, blockStart);
  }
  const w = new Bits(Math.max(1024, n >> 2));
  w.put(0x78, 8); w.put(0xda, 8);
  let { tok: bt, starts, ends } = best;
  if (opts.refineEnd) {
    starts = refineSplits(bt, starts, opts.refineEnd[0], opts.refineEnd[1]);
    ends = starts.map((s, k) => (k + 1 < starts.length ? starts[k + 1] : bt.count));
  }
  for (let k = 0; k < starts.length; k++) writeBlock(w, bt, starts[k], ends[k], k === starts.length - 1, lit, dist);
  w.flush();
  const out = new Uint8Array(w.pos + 4);
  out.set(w.buf.subarray(0, w.pos));
  const ad = adler32(data);
  out[w.pos] = ad >>> 24; out[w.pos + 1] = (ad >>> 16) & 255; out[w.pos + 2] = (ad >>> 8) & 255; out[w.pos + 3] = ad & 255;
  return out;
}
