// Property check: code lengths from huffLengths are always a complete prefix code within the limit.
import { huffLengths } from '../src/huffman.mjs';
let state = 99;
const rnd = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
let bad = 0;
for (let t = 0; t < 3000; t++) {
  const n = 2 + ((rnd() * 286) | 0), maxBits = t % 3 === 0 ? 7 : 15;
  const f = new Int32Array(n);
  const skew = 1 + rnd() * 6;
  for (let i = 0; i < n; i++) f[i] = rnd() < 0.7 ? Math.floor(Math.pow(rnd(), skew * 4) * 1e6) : 0;
  const used = f.filter((x) => x > 0).length;
  if (used > (1 << maxBits)) continue;
  const out = new Uint8Array(n);
  huffLengths(f, n, maxBits, out);
  let kraft = 0, cnt = 0;
  for (let i = 0; i < n; i++) { if (out[i]) { kraft += 2 ** (maxBits - out[i]); cnt++; } if (out[i] > maxBits || (f[i] > 0) !== (out[i] > 0)) bad++; }
  if (cnt >= 2 && kraft !== 2 ** maxBits) { bad++; console.log('incomplete/oversubscribed', t, n, maxBits, kraft); }
}
console.log(bad ? 'FAIL ' + bad : 'huffman ok');
process.exit(bad ? 1 : 0);
