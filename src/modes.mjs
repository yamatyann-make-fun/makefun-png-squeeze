// Representations of one RGBA image: every way it can be stored losslessly as a PNG sample array.
// Each mode: { name, ctype, bpp, samples (width*height*bpp bytes), plte, trns }.
import { assemblePng } from './png.mjs';

export function analyse(rgba, n) {
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true, grey = true;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
  }
  const map = new Map();
  let many = false;
  for (let i = 0; i < n && !many; i++) {
    const c = u32[i];
    const e = map.get(c);
    if (e === undefined) {
      if (map.size === 256) many = true;
      else map.set(c, { word: c, count: 1, first: i });
    } else e.count++;
  }
  return { opaque, grey, colours: many ? null : [...map.values()] };
}

function paletteModes(rgba, n, colours) {
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const info = colours.map((c) => {
    const b = new Uint8Array(Uint32Array.of(c.word).buffer);
    return { ...c, r: b[0], g: b[1], b: b[2], a: b[3], luma: b[0] * 299 + b[1] * 587 + b[2] * 114 };
  });
  const orders = {
    count: (x, y) => x.count !== y.count ? y.count - x.count : x.word - y.word,
    luma: (x, y) => x.luma !== y.luma ? x.luma - y.luma : x.word - y.word,
    first: (x, y) => x.first - y.first,
  };
  const out = [];
  for (const [oname, cmp] of Object.entries(orders)) {
    // non-opaque entries first, so the tRNS chunk stops at the last of them
    const sorted = [...info].sort((x, y) => ((x.a === 255) - (y.a === 255)) || cmp(x, y));
    const index = new Map(sorted.map((c, k) => [c.word, k]));
    const samples = new Uint8Array(n);
    for (let i = 0; i < n; i++) samples[i] = index.get(u32[i]);
    const plte = new Uint8Array(sorted.length * 3);
    sorted.forEach((c, k) => { plte[k * 3] = c.r; plte[k * 3 + 1] = c.g; plte[k * 3 + 2] = c.b; });
    let last = -1;
    sorted.forEach((c, k) => { if (c.a !== 255) last = k; });
    const trns = Uint8Array.from(sorted.slice(0, last + 1), (c) => c.a);
    out.push({ name: 'pal-' + oname, ctype: 3, bpp: 1, samples, plte, trns });
  }
  return out;
}

export function buildModes(rgba, width, height) {
  const n = width * height;
  const a = analyse(rgba, n);
  const modes = [];
  if (a.colours) modes.push(...paletteModes(rgba, n, a.colours));
  if (a.grey) {
    if (a.opaque) {
      const s = new Uint8Array(n);
      for (let i = 0; i < n; i++) s[i] = rgba[i * 4];
      modes.push({ name: 'grey', ctype: 0, bpp: 1, samples: s });
    } else {
      const s = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) { s[i * 2] = rgba[i * 4]; s[i * 2 + 1] = rgba[i * 4 + 3]; }
      modes.push({ name: 'grey-alpha', ctype: 4, bpp: 2, samples: s });
    }
  }
  // Full colour is only worth building when no palette or grey form exists (they are always smaller).
  if (!a.colours && !a.grey) {
    if (a.opaque) {
      const s = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) { s[i * 3] = rgba[i * 4]; s[i * 3 + 1] = rgba[i * 4 + 1]; s[i * 3 + 2] = rgba[i * 4 + 2]; }
      modes.push({ name: 'rgb', ctype: 2, bpp: 3, samples: s });
    } else modes.push({ name: 'rgba', ctype: 6, bpp: 4, samples: rgba });
  }
  return modes;
}

export { assemblePng };
