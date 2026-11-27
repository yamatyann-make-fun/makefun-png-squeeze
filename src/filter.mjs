import { deflateRawSync } from 'node:zlib';
// PNG scanline filters and per-row filter selection strategies.
const abs = Math.abs;

/** All five filtered versions of every row: result[t] is height*(1+stride) bytes, each row led by its filter byte t. */
export function filterAll(samples, width, height, bpp) {
  const stride = width * bpp, rl = stride + 1;
  const out = [0, 1, 2, 3, 4].map(() => new Uint8Array(rl * height));
  for (let y = 0; y < height; y++) {
    const cur = y * stride, up = cur - stride, o = y * rl;
    for (let t = 0; t < 5; t++) out[t][o] = t;
    for (let x = 0; x < stride; x++) {
      const v = samples[cur + x];
      const a = x >= bpp ? samples[cur + x - bpp] : 0;
      const b = y > 0 ? samples[up + x] : 0;
      const c = x >= bpp && y > 0 ? samples[up + x - bpp] : 0;
      const p = a + b - c, pa = abs(p - a), pb = abs(p - b), pc = abs(p - c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const i = o + 1 + x;
      out[0][i] = v; out[1][i] = (v - a) & 255; out[2][i] = (v - b) & 255;
      out[3][i] = (v - ((a + b) >> 1)) & 255; out[4][i] = (v - pr) & 255;
    }
  }
  return out;
}

/** Build the output from a per-row filter choice (Uint8Array of 0..4 per row). */
export function assembleRows(all, choice, rl) {
  const out = new Uint8Array(choice.length * rl);
  for (let y = 0; y < choice.length; y++) out.set(all[choice[y]].subarray(y * rl, (y + 1) * rl), y * rl);
  return out;
}

const LOG = new Float64Array(65537);
for (let i = 1; i < LOG.length; i++) LOG[i] = Math.log2(i);

/** Strategy: each row takes the filter whose bytes (as signed values) have the smallest sum of magnitudes. */
export function chooseMinSum(all, height, rl) {
  const choice = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      let s = 0;
      const row = all[t], o = y * rl + 1, e = (y + 1) * rl;
      for (let i = o; i < e; i++) { const v = row[i]; s += v < 128 ? v : 256 - v; }
      if (s < best) { best = s; choice[y] = t; }
    }
  }
  return choice;
}

/** Strategy: each row takes the filter with the smallest order-0 entropy of its own bytes. */
export function chooseEntropy(all, height, rl) {
  const choice = new Uint8Array(height), hist = new Int32Array(256);
  for (let y = 0; y < height; y++) {
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      hist.fill(0);
      const row = all[t], o = y * rl + 1, e = (y + 1) * rl;
      for (let i = o; i < e; i++) hist[row[i]]++;
      const n = e - o;
      let bits = 0;
      for (let s = 0; s < 256; s++) if (hist[s]) bits -= hist[s] * (LOG[hist[s]] - LOG[n]);
      if (bits < best) { best = bits; choice[y] = t; }
    }
  }
  return choice;
}

/** Strategy: greedy against a running histogram of every byte written so far (an adaptive entropy cost). */
export function chooseAdaptive(all, height, rl) {
  const choice = new Uint8Array(height), total = new Float64Array(256).fill(0.5);
  let sum = 128;
  for (let y = 0; y < height; y++) {
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      const row = all[t], o = y * rl + 1, e = (y + 1) * rl;
      let bits = 0;
      for (let i = o; i < e; i++) bits += Math.log2(sum / total[row[i]]);
      if (bits < best) { best = bits; choice[y] = t; }
    }
    const row = all[choice[y]];
    for (let i = y * rl + 1; i < (y + 1) * rl; i++) { total[row[i]]++; sum++; }
  }
  return choice;
}

export function constant(height, t) { return new Uint8Array(height).fill(t); }

/**
 * Strategy: brute force. Each row is compressed with every filter, as raw deflate primed with the 32 KiB written
 * before it, and takes the filter whose output is smallest (ties: the lower filter number). `bias` bytes are knocked
 * off the filter the previous row used, so runs of one filter (which keep LZ matches between rows valid) win ties of
 * a few bytes; `first` is the filter that row 0 prefers.
 */
export function chooseBrute(all, height, rl, level = 6, bias = 0, first = 0) {
  const choice = new Uint8Array(height);
  let prev = first;
  const hist = new Uint8Array(32768 + rl);
  let have = 0; // bytes of history kept at the front of `hist`
  const dictOf = () => hist.subarray(0, have);
  for (let y = 0; y < height; y++) {
    let best = Infinity;
    const dict = have > 0 ? Uint8Array.from(dictOf()) : undefined;
    for (let t = 0; t < 5; t++) {
      const row = all[t].subarray(y * rl, (y + 1) * rl);
      const z = deflateRawSync(row, { level, memLevel: 8, dictionary: dict });
      const cost = z.length - (t === prev ? bias : 0);
      if (cost < best) { best = cost; choice[y] = t; }
    }
    prev = choice[y];
    // append the chosen row to the history window
    const row = all[choice[y]].subarray(y * rl, (y + 1) * rl);
    if (have + rl > 32768) {
      const keep = Math.max(0, 32768 - rl);
      hist.copyWithin(0, have - keep, have);
      have = keep;
    }
    hist.set(row, have); have += rl;
  }
  return choice;
}

/**
 * Band search: rows are taken in bands of `band` rows. For each band every candidate filtering of it (each filter for
 * the whole band, and the per-row brute-force choice) is compressed as raw deflate primed with the 32 KiB written
 * before it, and the smallest is kept. A band of one filter keeps rows matching each other; the brute-force rows
 * win where the content changes inside the band.
 */
export function chooseBands(all, height, rl, band = 16, level = 9, perRow = null, ahead = null, same = null, upMode = 0) {
  const choice = new Uint8Array(height);
  const hist = new Uint8Array(32768);
  let have = 0;
  const buf = new Uint8Array(band * rl * 2);
  const opts = (dict) => ({ level, memLevel: 8, dictionary: dict });
  for (let y0 = 0; y0 < height; y0 += band) {
    const y1 = Math.min(height, y0 + band), rows = y1 - y0;
    const dict = have > 0 ? hist.slice(0, have) : undefined;
    const fill = (pick) => { for (let y = y0; y < y1; y++) buf.set(all[pick(y)].subarray(y * rl, (y + 1) * rl), (y - y0) * rl); };
    let best = Infinity, bestPick = null;
    let cands = [0, 1, 2, 3, 4].map((t) => () => t);
    for (const pr of perRow ? (Array.isArray(perRow) ? perRow : [perRow]) : []) cands.push((y) => pr[y]);
    // upMode 1: rows identical to the row above are also tried as Up (all zeros) in every candidate; 2: only that
    if (same && upMode) { const up = cands.map((p) => (y) => (same[y] ? 2 : p(y))); cands = upMode === 1 ? cands.concat(up) : up; }
    const y2 = ahead ? Math.min(height, y1 + band) : y1;
    for (const pick of cands) {
      fill(pick);
      for (let y = y1; y < y2; y++) buf.set(all[ahead[y]].subarray(y * rl, (y + 1) * rl), (y - y0) * rl);
      const z = deflateRawSync(buf.subarray(0, (y2 - y0) * rl), opts(dict)).length;
      if (z < best) { best = z; bestPick = pick; }
    }
    for (let y = y0; y < y1; y++) choice[y] = bestPick(y);
    fill(bestPick);
    // slide the history window
    const add = rows * rl;
    if (have + add > 32768) {
      const keep = Math.max(0, 32768 - add);
      hist.copyWithin(0, have - keep, have);
      have = keep;
    }
    const src = buf.subarray(Math.max(0, add - 32768), add);
    hist.set(src, have); have += src.length;
  }
  return choice;
}

/** 1 for each row whose samples equal the row above (where Up writes all zeros), else 0. */
export function sameRows(samples, stride, height) {
  const same = new Uint8Array(height);
  for (let y = 1; y < height; y++) {
    const a = y * stride, b = a - stride;
    let eq = 1;
    for (let x = 0; x < stride; x++) if (samples[a + x] !== samples[b + x]) { eq = 0; break; }
    same[y] = eq;
  }
  return same;
}
