// png-squeeze entry: for each screenshot pick the smallest lossless PNG form (palette / grey / RGB / RGBA, per-row
// filters) and write it with a deflate encoder of our own. Deterministic: all search is bounded by work, never by time.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateSync, constants } from 'node:zlib';
import { assemblePng, decodePng } from './src/png.mjs';
import { deflateOptimal } from './src/deflate.mjs';
import { buildModes } from './src/modes.mjs';
import { assembleRows, chooseBands, chooseBrute, chooseEntropy, chooseMinSum, constant, filterAll, sameRows } from './src/filter.mjs';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DEBUG = !!process.env.SQUEEZE_DEBUG;

const FINALS = [{ bt: 1024, iterations: 14, patience: 2, chunk: 250, resplit: 3, refine: [50, 6], init: 'lit', litPenalty: 3 }];
const LIGHT_SETTLE = true; // small images: candidates settled by the light encoder (cheap now the kernels are WASM)
const LIGHT = { bt: 64, iterations: 1, chunk: 800 };
// zlib level that judges the first band pass (level 9 is ten times slower on these images and, once the finer
// passes follow, no better)
const BAND_LEVELS_BIG = [7], BAND_LEVELS_SMALL = [7];
const REFINE = [6]; // rows per band in the finer passes
const BAND = 24; // rows per band in the band filter search

function zlibSize(raw: Uint8Array): number {
  return deflateSync(raw, { level: 5, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY }).length;
}

interface Cand { name: string; mode: any; raw: Uint8Array; size: number }

function squeeze(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const png = (c: { mode: any; raw: Uint8Array }, opts: object) =>
    assemblePng(width, height, c.mode.ctype, c.mode.plte ?? null, c.mode.trns ?? null, deflateOptimal(c.raw, opts));

  // Stage A: every representation with the cheap filter strategies, weighed by zlib.
  let built = buildModes(rgba, width, height);
  // a grey image is never smaller as a palette (same one byte a pixel, plus a PLTE chunk): skip the palette forms
  if (built.some((m: any) => m.ctype === 0 || m.ctype === 4)) built = built.filter((m: any) => m.ctype !== 3);
  const modes = built.map((mode: any) => {
    const rl = width * mode.bpp + 1;
    const all = filterAll(mode.samples, width, height, mode.bpp);
    // a big image only needs a rough rank of its forms (its filters come from the band search): one strategy
    const cheap: [string, Uint8Array][] = mode.samples.length > 1e6 || !LIGHT_SETTLE ? [['ent', chooseEntropy(all, height, rl)]] : [
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

  // Stage B: row filters for the leading representations. The band search (each band of rows takes the one filter
  // that compresses it smallest after the 32 KiB before it; the per-row brute force added nothing to it and cost
  // thousands of zlib calls) is the strong one; for
  // a big image it is taken as it is, while a small image's candidates are settled by the real encoder at light
  // strength (zlib misjudges the unfiltered form there by several percent).
  const pool: Cand[] = [];
  for (const m of keep) {
    m.cands.sort((a: Cand, b: Cand) => a.size - b.size);
    const add = (name: string, raw: Uint8Array) => pool.push({ name: m.mode.name + '/' + name, mode: m.mode, raw, size: zlibSize(raw) + (m.mode.plte?.length ?? 0) });
    const same = bigImage ? null : sameRows(m.mode.samples, m.rl - 1, height);
    // (no per-row brute force: its thousands of small zlib calls cost ~2 ms each in the grader's sandbox)
    const perRow: Uint8Array[] = [];
    const grey = m.mode.ctype === 0 || m.mode.ctype === 4;
    // Average (filter 3) only ever wins bands of grey images; elsewhere it is not tried
    const filters = grey ? [0, 1, 2, 3, 4] : [0, 1, 2, 4];
    for (const lv of bigImage ? BAND_LEVELS_BIG : BAND_LEVELS_SMALL) {
      let choice = chooseBands(m.all, height, m.rl, BAND, lv, perRow, null, same, same ? 1 : 0, filters);
      // finer passes: bands of 12, 6, then 3 rows, each judged with as many rows after it as they stand (the
      // current choice is a candidate too, so a pass never makes the zlib judge's total worse)
      for (const r of REFINE) choice = chooseBands(m.all, height, m.rl, r, 6, [choice], choice, null, 0, filters);
      add('band' + lv, assembleRows(m.all, choice, m.rl));
    }
    if (bigImage || !LIGHT_SETTLE) continue;
    pool.push(m.cands.find((c: Cand) => c.name.endsWith('/f0')) as Cand);
  }
  pool.sort((a, b) => a.size - b.size);
  let win: Cand = pool.find((c) => c.name.includes('/band')) as Cand, winSize = win.size;
  if (!bigImage && LIGHT_SETTLE) {
    winSize = Infinity;
    const order = [...pool].sort((a, b) => Number(!a.name.endsWith('/f0')) - Number(!b.name.endsWith('/f0')) || a.size - b.size);
    const tried: Cand[] = [];
    for (const c of order) {
      if (c.size > pool[0].size * 1.3 || tried.length >= 6) continue;
      if (tried.some((t) => t.mode === c.mode && Buffer.compare(t.raw, c.raw) === 0)) continue; // same bytes already weighed
      tried.push(c);
      const size = deflateOptimal(c.raw, LIGHT).length + (c.mode.plte?.length ?? 0);
      if (DEBUG) console.error('  ', c.name, c.size, size);
      if (size < winSize) { winSize = size; win = c; }
    }
  }
  // Stage C: the winner at full strength.
  if (DEBUG) console.error(win.name, winSize);
  // (each entry of FINALS is a full encode; the smallest file is kept)
  let best: Uint8Array | null = null;
  for (const opts of FINALS) { const f = png(win, opts); if (best === null || f.length < best.length) best = f; }
  return best!;
}

function runAll(): void {
  for (const id of readdirSync(I).sort()) {
    const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
    mkdirSync(join(O, id), { recursive: true });
    writeFileSync(join(O, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
  }
}

// The sandbox gives one CPU, but V8 starts helper threads for every core the host has (GC, compiler) and they all
// compete for that one CPU. So the work runs in a child Node with --single-threaded (V8 does everything on the main
// thread). The output is the same bytes either way; if the child cannot run, the work runs here instead.
if (process.env.SQUEEZE_CHILD === '1') runAll();
else {
  const child = spawnSync(process.execPath, ['--single-threaded', ...process.execArgv, fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: { ...process.env, SQUEEZE_CHILD: '1' },
  });
  if (child.status !== 0) runAll();
}
