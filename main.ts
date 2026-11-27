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

const FINAL = { chain: 256, iterations: 24, patience: 3, chunk: 300, resplit: 3, nice: 258 };
const BIASES = [0, 40]; // row-to-row filter stickiness tried by the brute-force selector (bytes)

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
  const keep = modes.filter((m: any, k: number) => k < 2 && m.best <= modes[0].best * 1.015);

  // Stage B: for the leading representation(s), brute-force row filters at several stickiness levels, plus the
  // best cheap strategy, each weighed by zlib; the smallest goes on.
  let win: Cand | null = null, winSize = Infinity;
  const consider = (c: Cand) => {
    const size = zlibSize(c.raw) + (c.mode.plte?.length ?? 0);
    if (DEBUG) console.error('  ', c.name, size);
    if (size < winSize) { winSize = size; win = c; }
  };
  for (const m of keep) {
    m.cands.sort((a: Cand, b: Cand) => a.size - b.size);
    consider(m.cands[0]);
    const firstFilter = m.cands[0].name.endsWith('/f0') ? 0 : 2;
    for (const bias of BIASES) {
      const raw = assembleRows(m.all, chooseBrute(m.all, height, m.rl, 6, bias, firstFilter), m.rl);
      consider({ name: m.mode.name + '/brute' + bias, mode: m.mode, raw, size: 0 });
    }
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
