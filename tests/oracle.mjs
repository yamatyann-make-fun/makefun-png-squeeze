// Dev experiment: for each practice image, size every (representation x filter strategy) with a mid-strength
// optimal-parse deflate, to see how far the zlib-screened choice in main.ts is from the best of all of them.
// Usage: MAKEFUN_KIT=... node tests/oracle.mjs i001,i002
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodePng } from '../src/png.mjs';
import { buildModes } from '../src/modes.mjs';
import { assembleRows, chooseAdaptive, chooseBrute, chooseEntropy, chooseMinSum, constant, filterAll } from '../src/filter.mjs';
import { deflateOptimal } from '../src/deflate.mjs';

const KIT = resolve(process.env.MAKEFUN_KIT ?? '../kitwork/png-squeeze-01-run-20261127-kit');
for (const id of (process.argv[2] ?? 'i001').split(',')) {
  const img = decodePng(new Uint8Array(readFileSync(join(KIT, 'practice/input', id, 'image.png'))));
  const rows = [];
  for (const mode of buildModes(img.rgba, img.width, img.height)) {
    const rl = img.width * mode.bpp + 1, h = img.height;
    const all = filterAll(mode.samples, img.width, h, mode.bpp);
    const strat = {
      f0: constant(h, 0), f1: constant(h, 1), f2: constant(h, 2), f3: constant(h, 3), f4: constant(h, 4),
      min: chooseMinSum(all, h, rl), ent: chooseEntropy(all, h, rl), ada: chooseAdaptive(all, h, rl),
      b0: chooseBrute(all, h, rl, 6, 0, 2), b40: chooseBrute(all, h, rl, 6, 40, 0),
    };
    for (const [k, c] of Object.entries(strat)) {
      const z = deflateOptimal(assembleRows(all, c, rl), { chain: 48, iterations: 3, chunk: 500 });
      rows.push([z.length + (mode.plte?.length ?? 0), mode.name + '/' + k]);
    }
  }
  rows.sort((a, b) => a[0] - b[0]);
  console.log(id, rows.slice(0, 6).map((r) => r.join(' ')).join(' | '));
}
