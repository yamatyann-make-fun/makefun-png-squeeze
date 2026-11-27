// Local verification: run main.ts on the kit's practice set and check (1) exact pixels via the kit's own checker,
// (2) PNG format limits, (3) determinism (two runs, identical bytes), (4) time, (5) score vs the fixed-paeth baseline.
// Usage: MAKEFUN_KIT=<unpacked kit dir> node tests/verify.mjs [--skip-baseline]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const KIT = resolve(process.env.MAKEFUN_KIT ?? '../kitwork/png-squeeze-01-run-20261127-kit');
const ROOT = resolve(import.meta.dirname, '..');
const { points } = await import(pathToFileURL(join(KIT, 'program/scorer/checker/check.mjs')).href);
const png = await import(pathToFileURL(join(KIT, 'program/scorer/checker/png.mjs')).href);
const manifest = JSON.parse(readFileSync(join(KIT, 'practice/reference/manifest.json'), 'utf8'));
const INPUT = join(KIT, 'practice/input');
let failed = 0;
const fail = (m) => { failed++; console.log('FAIL', m); };

function run(main, label) {
  const out = mkdtempSync(join(tmpdir(), 'sq-'));
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', main], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: INPUT, MAKEFUN_OUTPUT_DIR: out },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const sec = Number(process.hrtime.bigint() - t0) / 1e9;
  if (r.status !== 0) fail(`${label}: exit ${r.status}`);
  return { out, sec };
}

function score(out, label) {
  let sum = 0;
  const sizes = [];
  for (const inst of manifest.instances) {
    const p = join(out, inst.id, 'image.png');
    if (!existsSync(p)) { fail(`${label} ${inst.id}: missing`); sizes.push(0); continue; }
    const bytes = new Uint8Array(readFileSync(p));
    // chunk whitelist, bit depth 8, no interlace
    const names = []; let o = 8;
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    while (o < bytes.length) { const n = dv.getUint32(o); names.push(String.fromCharCode(...bytes.subarray(o + 4, o + 8))); o += 12 + n; }
    if (names.some((n) => !png.CHUNKS.includes(n))) fail(`${label} ${inst.id}: chunk ${names}`);
    if (bytes[24] !== 8 || bytes[28] !== 0) fail(`${label} ${inst.id}: depth/interlace`);
    const files = { 'image.png': new Uint8Array(readFileSync(join(INPUT, inst.id, 'image.png'))) };
    const res = points(files, inst.key, { 'image.png': bytes });
    if (!res.valid || res.points === 0) fail(`${label} ${inst.id}: ${res.detail}`);
    sum += res.points; sizes.push(bytes.length);
    console.log(`  ${label} ${inst.id} ${inst.key.theme.padEnd(5)} ${String(bytes.length).padStart(7)} B  ${res.points.toFixed(1)} pts  (ref scale ${inst.key.scale_bytes})`);
  }
  return { total: (sum / manifest.instances.length) * 1000, sizes };
}

const a = run(join(ROOT, 'main.ts'), 'run1');
const b = run(join(ROOT, 'main.ts'), 'run2');
console.log(`time: ${a.sec.toFixed(1)}s, ${b.sec.toFixed(1)}s (limit 60s; aim < 35s locally)`);
if (a.sec > 40) fail('too slow for a safe margin');
const mine = score(a.out, 'mine');
for (const inst of manifest.instances) {
  const x = readFileSync(join(a.out, inst.id, 'image.png')), y = readFileSync(join(b.out, inst.id, 'image.png'));
  if (Buffer.compare(x, y) !== 0) fail(`${inst.id}: nondeterministic`);
}
console.log(`score: ${Math.round(mine.total)}`);
if (!process.argv.includes('--skip-baseline')) {
  const base = run(join(KIT, 'baselines/fixed-paeth/main.ts'), 'base');
  const bs = score(base.out, 'base');
  console.log(`baseline fixed-paeth: ${Math.round(bs.total)}  -> diff ${Math.round(mine.total - bs.total)}`);
  if (mine.total <= bs.total) fail('does not beat the baseline');
  rmSync(base.out, { recursive: true, force: true });
}
rmSync(a.out, { recursive: true, force: true }); rmSync(b.out, { recursive: true, force: true });
console.log(failed ? `${failed} FAILURE(S)` : 'ALL OK');
process.exit(failed ? 1 : 0);
