// Every representation built by buildModes must decode back to the exact RGBA input (checked on synthetic images
// that exercise palette+tRNS, grey, grey+alpha, tRNS colour keys, RGB and RGBA).
import { buildModes } from '../src/modes.mjs';
import { assemblePng, decodePng } from '../src/png.mjs';
import { deflateSync } from 'node:zlib';
import { assembleRows, constant, filterAll } from '../src/filter.mjs';

let state = 7;
const rnd = (n) => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) >>> 8) % n;
const W = 37, H = 29, N = W * H;
const make = (px) => { const a = new Uint8Array(N * 4); for (let i = 0; i < N; i++) a.set(px(i), i * 4); return a; };
const images = {
  flat: make(() => [[10, 20, 30, 255], [200, 0, 0, 255], [0, 200, 0, 255]][rnd(3)]),
  paletteAlpha: make(() => [[10, 20, 30, 255], [0, 0, 0, 0], [5, 5, 5, 99]][rnd(3)]),
  grey: make(() => { const g = rnd(256); return [g, g, g, 255]; }),
  greyAlpha: make(() => { const g = rnd(256); return [g, g, g, rnd(2) ? 255 : rnd(256)]; }),
  greyKey: make(() => { const g = 1 + rnd(255); return rnd(4) ? [g, g, g, 255] : [0, 0, 0, 0]; }),
  rgbKey: make(() => (rnd(4) ? [1 + rnd(255), rnd(256), rnd(256), 255] : [0, 0, 0, 0])),
  rgbKeyBlocked: make(() => (rnd(4) ? [rnd(256), rnd(256), rnd(256), 255] : [0, 0, 0, 0])).map((v, i) => (i === 3 ? 0 : v)),
  rgb: make(() => [rnd(256), rnd(256), rnd(256), 255]),
  rgba: make(() => [rnd(256), rnd(256), rnd(256), rnd(256)]),
};
let bad = 0;
for (const [name, rgba] of Object.entries(images)) {
  const names = [];
  for (const mode of buildModes(rgba, W, H)) {
    const rl = W * mode.bpp + 1;
    for (const t of [0, 4]) {
      const raw = assembleRows(filterAll(mode.samples, W, H, mode.bpp), constant(H, t), rl);
      const png = assemblePng(W, H, mode.ctype, mode.plte ?? null, mode.trns ?? null, deflateSync(raw));
      const back = decodePng(new Uint8Array(png));
      if (Buffer.compare(Buffer.from(back.rgba), Buffer.from(rgba)) !== 0) { bad++; console.log('MISMATCH', name, mode.name, 'filter', t); }
    }
    names.push(mode.name);
  }
  console.log(name.padEnd(14), names.join(' '));
}
console.log(bad ? 'FAIL' : 'modes ok');
process.exit(bad ? 1 : 0);
