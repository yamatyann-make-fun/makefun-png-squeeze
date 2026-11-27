// Dev benchmark: compare deflate settings on the filtered data of a few practice images (needs MAKEFUN_KIT).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { decodePng } from '../src/png.mjs';
import { buildModes } from '../src/modes.mjs';
import { assembleRows, chooseMinSum, filterAll } from '../src/filter.mjs';
import { deflateOptimal } from '../src/deflate.mjs';

const KIT = resolve(process.env.MAKEFUN_KIT ?? '../kitwork/png-squeeze-01-run-20261127-kit');
const ids = (process.argv[2] ?? 'i001,i004').split(',');
const variants = JSON.parse(process.argv[3] ?? '[{"chain":64,"iterations":3},{"chain":256,"iterations":3}]');
for (const id of ids) {
  const img = decodePng(new Uint8Array(readFileSync(join(KIT, 'practice/input', id, 'image.png'))));
  const mode = buildModes(img.rgba, img.width, img.height)[0];
  const rl = img.width * mode.bpp + 1;
  const all = filterAll(mode.samples, img.width, img.height, mode.bpp);
  const raw = assembleRows(all, chooseMinSum(all, img.height, rl), rl);
  console.log(id, mode.name, 'raw', raw.length, 'zlib9', deflateSync(raw, { level: 9 }).length);
  for (const v of variants) {
    const t0 = process.hrtime.bigint();
    const z = deflateOptimal(raw, v);
    console.log('  ', JSON.stringify(v), z.length, (Number(process.hrtime.bigint() - t0) / 1e9).toFixed(2) + 's');
  }
}
