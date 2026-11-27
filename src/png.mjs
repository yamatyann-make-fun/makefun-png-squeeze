// PNG container: read a screenshot (any filter, colour type 6 or otherwise) into RGBA bytes, and write chunks.
import { inflateSync } from 'node:zlib';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

export function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return ~c;
}

export function adler32(buf) {
  let a = 1, b = 0;
  const n = buf.length;
  for (let i = 0; i < n; ) {
    const e = Math.min(i + 5552, n);
    for (; i < e; i++) { a += buf[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Decode a PNG of bit depth 8 into { width, height, rgba }. Handles every filter and colour types 0, 2, 3, 4, 6. */
export function decodePng(file) {
  for (let i = 0; i < 8; i++) if (file[i] !== SIG[i]) throw new Error('not a png');
  const dv = new DataView(file.buffer, file.byteOffset, file.length);
  let width = 0, height = 0, depth = 0, ctype = 0, plte = null, trns = null;
  const idat = [];
  for (let o = 8; o + 8 <= file.length; ) {
    const len = dv.getUint32(o);
    const name = String.fromCharCode(file[o + 4], file[o + 5], file[o + 6], file[o + 7]);
    const body = file.subarray(o + 8, o + 8 + len);
    if (name === 'IHDR') {
      width = dv.getUint32(o + 8); height = dv.getUint32(o + 12); depth = file[o + 16]; ctype = file[o + 17];
      if (file[o + 20] !== 0) throw new Error('interlaced');
    } else if (name === 'PLTE') plte = body;
    else if (name === 'tRNS') trns = body;
    else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8) throw new Error('bit depth ' + depth);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0;
      const b = y > 0 ? px[up + x] : 0;
      const c = x >= ch && y > 0 ? px[up + x - ch] : 0;
      const r = raw[src + x];
      px[dst + x] = (ft === 0 ? r : ft === 1 ? r + a : ft === 2 ? r + b : ft === 3 ? r + ((a + b) >> 1) : r + paeth(a, b, c)) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * ch, d = i * 4;
    let r, g, b, a = 255;
    if (ctype === 6) { r = px[s]; g = px[s + 1]; b = px[s + 2]; a = px[s + 3]; }
    else if (ctype === 2) { r = px[s]; g = px[s + 1]; b = px[s + 2]; }
    else if (ctype === 0) r = g = b = px[s];
    else if (ctype === 4) { r = g = b = px[s]; a = px[s + 1]; }
    else { const k = px[s]; r = plte[k * 3]; g = plte[k * 3 + 1]; b = plte[k * 3 + 2]; a = trns && k < trns.length ? trns[k] : 255; }
    rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b; rgba[d + 3] = a;
  }
  return { width, height, rgba };
}

function chunk(name, body) {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out, 4, 8 + body.length) >>> 0);
  return out;
}

/** Assemble a PNG from the colour type, optional PLTE / tRNS bodies and an already-built zlib stream. */
export function assemblePng(width, height, ctype, plte, trns, zlibStream) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = ctype;
  const parts = [Uint8Array.from(SIG), chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns && trns.length) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', zlibStream), chunk('IEND', new Uint8Array(0)));
  return Buffer.concat(parts);
}
