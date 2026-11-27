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
 * before it, and takes the filter whose output is smallest (ties: the lower filter number).
 */
export function chooseBrute(all, height, rl, level = 6) {
  const choice = new Uint8Array(height);
  const hist = new Uint8Array(32768 + rl);
  let have = 0; // bytes of history kept at the front of `hist`
  const dictOf = () => hist.subarray(0, have);
  for (let y = 0; y < height; y++) {
    let best = Infinity;
    const dict = have > 0 ? Uint8Array.from(dictOf()) : undefined;
    for (let t = 0; t < 5; t++) {
      const row = all[t].subarray(y * rl, (y + 1) * rl);
      const z = deflateRawSync(row, { level, memLevel: 9, dictionary: dict });
      if (z.length < best) { best = z.length; choice[y] = t; }
    }
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
