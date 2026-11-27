// png-squeeze entry: for each screenshot pick the smallest lossless PNG form (palette / grey / RGB / RGBA, per-row
// filters) and write it with a deflate encoder of our own. Deterministic: all search is bounded by work, never by time.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, constants } from 'node:zlib';
import { assemblePng, decodePng } from './src/png.mjs';
import { deflateOptimal } from './src/deflate.mjs';
import { buildModes } from './src/modes.mjs';
import { assembleRows, chooseBrute, chooseEntropy, chooseMinSum, constant, filterAll } from './src/filter.mjs';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DEBUG = !!process.env.SQUEEZE_DEBUG;

const FINAL = { bt: 1024, iterations: 40, patience: 2, chunk: 250, resplit: 3 };
const LIGHT = { bt: 64, iterations: 1, chunk: 800 };
const LIGHT_BIG = { bt: 24, iterations: 1, chunk: 2000 };
const SETTLE = 1.03;
const BRUTES = [[0, 2], [40, 0]]; // [row-to-row filter stickiness in bytes, filter row 0 prefers] tried by the brute-force selector

function zlibSize(raw: Uint8Array): number {
  return deflateSync(raw, { level: 5, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY }).length;
}

interface Cand { name: string; mode: any; raw: Uint8Array; size: number }

function squeeze(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const png = (c: { mode: any; raw: Uint8Array }, opts: object) =>
    assemblePng(width, height, c.mode.ctype, c.mode.plte ?? null, c.mode.trns ?? null, deflateOptimal(c.raw, opts));

  // Stage A: every representation with the cheap filter strategies, weighed by zlib.
  const modes = buildModes(rgba, width, height).map((mode: any) => {
    const rl = width * mode.bpp + 1;
    const all = filterAll(mode.samples, width, height, mode.bpp);
    const cheap: [string, Uint8Array][] = [
      ['f0', constant(height, 0)], ['f2', constant(height, 2)], ['f4', constant(height, 4)],
      ['min', chooseMinSum(all, height, rl)], ['ent', chooseEntropy(all, height, rl)],
    ];
    const cands: Cand[] = cheap.map(([name, choice]) => {
      const raw = assembleRows(all, choice, rl);
      return { name: mode.name + '/' + name, mode, raw, size: zlibSize(raw) + (mode.plte?.length ?? 0) };
    });
    return { mode, rl, all, cands, best: Math.min(...cands.map((c) => c.size)) };
  });
  modes.sort((a: any, b: any) => a.best - b.best);
  const bigImage = modes[0].mode.samples.length > 1e6;
  const keep = modes.filter((m: any, k: number) => k < (bigImage ? 1 : 3) && m.best <= modes[0].best * 1.03);

  // Stage B: brute-force row filters for the leading representations, then zlib screens all the candidates and the
  // real encoder (at light strength) settles the ones within a few percent of the best, since the zlib ranking is
  // only good to about that.
  const pool: Cand[] = [];
  for (const m of keep) {
    m.cands.sort((a: Cand, b: Cand) => a.size - b.size);
    pool.push(m.cands[0]);
    if (!m.cands[0].name.endsWith('/f0')) pool.push(m.cands.find((c: Cand) => c.name.endsWith('/f0')) as Cand);
    // two brute-force flavours: free to switch filters (starting on Paeth), and sticky on unfiltered rows
    for (const [bias, first] of BRUTES) {
      const raw = assembleRows(m.all, chooseBrute(m.all, height, m.rl, 6, bias, first), m.rl);
      pool.push({ name: m.mode.name + '/brute' + bias, mode: m.mode, raw, size: zlibSize(raw) + (m.mode.plte?.length ?? 0) });
    }
  }
  pool.sort((a, b) => a.size - b.size);
  // small images are judged by the real encoder, and the plain unfiltered form is tried first (zlib undervalues it)
  const order = bigImage ? pool.filter((c) => c.name.includes('/brute')).sort((a, b) => a.size - b.size) : [...pool].sort((a, b) => Number(!a.name.endsWith('/f0')) - Number(!b.name.endsWith('/f0')) || a.size - b.size);
  let win: Cand | null = null, winSize = Infinity;
  const tried: Cand[] = [];
  // (zlib ranks the row-filter flavours of a big image wrongly by up to 3%, so the two best go to the real encoder)
  // (a big image whose two flavours zlib puts more than 1% apart is not worth the seconds: zlib's order is trusted)
  const settled = bigImage && order.length > 1 && order[1].size > order[0].size * 1.01;
  if (settled) { win = order[0]; winSize = order[0].size; }
  else for (const c of order) {
    if (c.size > pool[0].size * 1.3 || tried.length >= (bigImage ? 2 : 6)) continue;
    if (tried.some((t) => t.mode === c.mode && Buffer.compare(t.raw, c.raw) === 0)) continue; // same bytes already weighed
    tried.push(c);
    const size = deflateOptimal(c.raw, bigImage ? LIGHT_BIG : LIGHT).length + (c.mode.plte?.length ?? 0);
    if (DEBUG) console.error('  ', c.name, c.size, size);
    if (size < winSize) { winSize = size; win = c; }
  }
  // Stage C: the winner at full strength.
  if (DEBUG) console.error((win as unknown as Cand).name, winSize);
  return png(win as unknown as Cand, FINAL);
}

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
