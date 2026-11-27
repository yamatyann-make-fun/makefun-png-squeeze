// Unit check for the deflate encoder: every output must inflate (node zlib) back to the exact input.
import { inflateSync, deflateSync } from 'node:zlib';
import { deflateOptimal } from '../src/deflate.mjs';

let state = 12345;
const rnd = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296;
const cases = {
  empty1: Uint8Array.of(7),
  hello: Uint8Array.from(Buffer.from('hello hello hello hello world')),
  flat: new Uint8Array(100000).fill(7),
  noise: Uint8Array.from({ length: 50000 }, () => (rnd() * 256) | 0),
  skewed: Uint8Array.from({ length: 200000 }, () => (rnd() < 0.9 ? 0 : (rnd() * 4) | 0)),
  periodic: Uint8Array.from({ length: 150000 }, (_, i) => (i % 37) * 3 + (rnd() < 0.01 ? 1 : 0)),
};
let bad = 0;
for (const [name, data] of Object.entries(cases)) {
  const z = deflateOptimal(data, { iterations: 3 });
  const ok = Buffer.compare(inflateSync(z), Buffer.from(data)) === 0;
  const again = Buffer.compare(deflateOptimal(data, { iterations: 3 }), z) === 0;
  console.log(name.padEnd(9), String(data.length).padStart(7), '->', String(z.length).padStart(6), 'zlib9', String(deflateSync(data, { level: 9 }).length).padStart(6), ok ? 'ok' : 'MISMATCH', again ? 'det' : 'NONDET');
  if (!ok || !again) bad++;
}
process.exit(bad ? 1 : 0);
