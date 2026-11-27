// png-squeeze entry: for each screenshot pick the smallest lossless PNG form (palette / grey / RGB / RGBA, per-row
// filters) and write it with a deflate encoder of our own. Deterministic: all search is bounded by work, never by time.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, constants } from 'node:zlib';
import { assemblePng, decodePng } from './src/png.mjs';
import { deflateOptimal } from './src/deflate.mjs';
import { buildModes } from './src/modes.mjs';
import { assembleRows, chooseAdaptive, chooseBrute, chooseEntropy, chooseMinSum, constant, filterAll } from './src/filter.mjs';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const SCREEN = 4; // candidates that go from the zlib screen to the quick optimal-parse round
const QUICK = { chain: 24, iterations: 1, chunk: 500 };
const FINAL = { chain: 256, iterations: 8, chunk: 300, nice: 258 };

function zlibOf(raw: Uint8Array): Uint8Array {
  return deflateSync(raw, { level: 5, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
}

interface Cand { name: string; mode: any; raw: Uint8Array; est: number }

function squeeze(rgba: Uint8Array, width: number, height: number): Uint8Array {
  // 1. every (representation, filter strategy), screened by zlib
  const cands: Cand[] = [];
  for (const mode of buildModes(rgba, width, height)) {
    const rl = width * mode.bpp + 1;
    const all = filterAll(mode.samples, width, height, mode.bpp);
    const choices: [string, Uint8Array][] = [
      ['f0', constant(height, 0)], ['f2', constant(height, 2)], ['f4', constant(height, 4)],
      ['min', chooseMinSum(all, height, rl)], ['ent', chooseEntropy(all, height, rl)], ['ada', chooseAdaptive(all, height, rl)],
      ['brute6', chooseBrute(all, height, rl, 6)],
    ];
    for (const [name, choice] of choices) {
      const raw = assembleRows(all, choice, rl);
      cands.push({ name: mode.name + '/' + name, mode, raw, est: zlibOf(raw).length + (mode.plte?.length ?? 0) });
    }
  }
  cands.sort((a, b) => a.est - b.est);
  const make = (c: Cand, opts: object) => assemblePng(width, height, c.mode.ctype, c.mode.plte ?? null, c.mode.trns ?? null, deflateOptimal(c.raw, opts));
  // 2. a quick optimal parse of the best few picks the winner
  let win: Cand = cands[0], winSize = Infinity;
  for (const c of cands.slice(0, SCREEN)) {
    const size = make(c, QUICK).length;
    if (size < winSize) { winSize = size; win = c; }
  }
  // 3. the winner at full strength
  if (process.env.SQUEEZE_DEBUG) console.error(win.name, winSize);
  return make(win, FINAL);
}

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
