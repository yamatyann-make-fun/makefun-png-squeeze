// png-squeeze entry: for each screenshot pick the smallest lossless PNG form (palette / grey / RGB / RGBA, per-row
// filters) and write it with a deflate encoder of our own. Deterministic: all search is bounded by work, never by time.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, constants } from 'node:zlib';
import { assemblePng, decodePng } from './src/png.mjs';
import { buildModes } from './src/modes.mjs';
import { assembleRows, chooseAdaptive, chooseEntropy, chooseMinSum, constant, filterAll } from './src/filter.mjs';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function zlibOf(raw: Uint8Array): Uint8Array {
  return deflateSync(raw, { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY });
}

function squeeze(rgba: Uint8Array, width: number, height: number): Uint8Array {
  let best: { size: number; png: Uint8Array } | null = null;
  for (const mode of buildModes(rgba, width, height)) {
    const rl = width * mode.bpp + 1;
    const all = filterAll(mode.samples, width, height, mode.bpp);
    const choices = [0, 1, 2, 3, 4].map((t) => constant(height, t));
    choices.push(chooseMinSum(all, height, rl), chooseEntropy(all, height, rl), chooseAdaptive(all, height, rl));
    for (const choice of choices) {
      const z = zlibOf(assembleRows(all, choice, rl));
      const png = assemblePng(width, height, mode.ctype, mode.plte ?? null, mode.trns ?? null, z);
      if (best === null || png.length < best.size) best = { size: png.length, png };
    }
  }
  return best!.png;
}

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
