// WebAssembly kernels for the two hot loops of the deflate encoder (binary-tree match search and the optimal-parse
// relaxation), assembled here from opcodes by a tiny assembler of our own: no toolchain, no binary blob. Both
// kernels are integer / IEEE-754 double code, so they give the same bytes on every run and every machine.

// ---- assembler ----------------------------------------------------------------------------------------------------
const uleb = (v) => { const o = []; do { let b = v & 127; v >>>= 7; if (v) b |= 128; o.push(b); } while (v); return o; };
const sleb = (v) => {
  const o = [];
  for (;;) { const b = v & 127; v >>= 7; if ((v === 0 && !(b & 64)) || (v === -1 && (b & 64))) { o.push(b); return o; } o.push(b | 128); }
};
const str = (s) => [...uleb(s.length), ...Buffer.from(s, 'utf8')];
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => [id, ...uleb(body.length), ...body];

const I32 = 0x7f, F64 = 0x7c, VOID = 0x40;
// instructions (each returns an array of bytes; nested arrays are flattened)
const op = {
  block: (...b) => [0x02, VOID, ...b.flat(Infinity), 0x0b],
  loop: (...b) => [0x03, VOID, ...b.flat(Infinity), 0x0b],
  if_: (...b) => [0x04, VOID, ...b.flat(Infinity), 0x0b],
  ifElse: (a, b) => [0x04, VOID, ...a.flat(Infinity), 0x05, ...b.flat(Infinity), 0x0b],
  br: (d) => [0x0c, ...uleb(d)],
  brIf: (d) => [0x0d, ...uleb(d)],
  ret: [0x0f],
  get: (i) => [0x20, ...uleb(i)],
  set: (i) => [0x21, ...uleb(i)],
  tee: (i) => [0x22, ...uleb(i)],
  i32: (v) => [0x41, ...sleb(v | 0)],
  f64: (v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return [0x44, ...b]; },
  ld32: [0x28, 2, 0], ld8: [0x2d, 0, 0], ld16: [0x2f, 1, 0], ldf: [0x2b, 3, 0],
  st32: [0x36, 2, 0], st16: [0x3b, 1, 0], stf: [0x39, 3, 0],
  eqz: [0x45], eq: [0x46], ne: [0x47], lt_s: [0x48], lt_u: [0x49], gt_s: [0x4a], ge_s: [0x4e], ge_u: [0x4f], le_s: [0x4c],
  flt: [0x63],
  add: [0x6a], sub: [0x6b], mul: [0x6c], and: [0x71], or: [0x72], shl: [0x74], shr_u: [0x76],
  fadd: [0xa0],
  select: [0x1b],
};
const { block, loop, if_, ifElse, br, brIf, get, set, tee, i32, ld32, ld8, ld16, ldf, st32, st16, stf, eqz, eq, ne, lt_u, lt_s, gt_s, ge_s, ge_u, flt, add, sub, mul, and, or, shl, shr_u, fadd, select } = op;

/** A module importing env.mem and exporting the given functions ({name, params, locals: [[count, type]...], body}). */
function moduleOf(funcs) {
  const types = funcs.map((f) => [0x60, ...vec(f.params.map((t) => [t])), ...vec(f.result ? [[f.result]] : [])]);
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(2, vec([[...str('env'), ...str('mem'), 0x02, 0x00, ...uleb(1)]])),
    ...section(3, vec(funcs.map((_, k) => uleb(k)))),
    ...section(7, vec(funcs.map((f, k) => [...str(f.name), 0x00, ...uleb(k)]))),
    ...section(10, vec(funcs.map((f) => {
      const body = [...vec(f.locals.map(([c, t]) => [...uleb(c), t])), ...f.body.flat(Infinity), 0x0b];
      return [...uleb(body.length), ...body];
    }))),
  ];
  return new Uint8Array(bytes);
}

// ---- kernel 1: binary-tree match search ----------------------------------------------------------------------------
// bt(data, n, cut, head, son, off, pool, cap) -> number of pool entries, or -1 when `cap` is too small.
// Same algorithm as findMatchesBT in deflate.mjs: off[i] .. off[i+1] index pool entries ((dist-1) << 9 | (len-3)).
const BT = (() => {
  // params 0..7, locals from 8
  const [DATA, N, CUT, HEAD, SON, OFF, POOL, CAP] = [0, 1, 2, 3, 4, 5, 6, 7];
  const [Ii, TOP, H, LIM, CUR, PL, PM, LL, LM, BEST, CNT, CM, DELTA, NS, LEN, A, B] = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const byte = (addrExpr) => [get(DATA), addrExpr, add, ld8];
  const son = (idxExpr) => [get(SON), idxExpr, i32(2), shl, add]; // address of son[idx]
  const body = [
    i32(0), set(Ii), i32(0), set(TOP),
    block(loop(
      get(Ii), get(N), ge_s, brIf(1),
      // off[i] = top
      get(OFF), get(Ii), i32(2), shl, add, get(TOP), st32,
      block( // skip when fewer than 3 bytes remain
        get(Ii), i32(2), add, get(N), ge_s, brIf(0),
        // h = imul(d[i]<<16 | d[i+1]<<8 | d[i+2], 0x9e3779b1) >>> 16
        byte(get(Ii)), i32(16), shl, byte([get(Ii), i32(1), add]), i32(8), shl, or, byte([get(Ii), i32(2), add]), or,
        i32(0x9e3779b1 | 0), mul, i32(16), shr_u, set(H),
        // lim = min(258, n - i)
        get(N), get(Ii), sub, tee(LIM), i32(258), get(LIM), i32(258), lt_s, select, set(LIM),
        // cur = head[h]; head[h] = i + 1
        get(HEAD), get(H), i32(2), shl, add, tee(A), ld32, set(CUR),
        get(A), get(Ii), i32(1), add, st32,
        // ptrLess / ptrMore as son indices
        get(Ii), i32(32767), and, i32(1), shl, tee(PL), i32(1), add, set(PM),
        i32(0), set(LL), i32(0), set(LM), i32(2), set(BEST), get(CUT), set(CNT),
        block(loop(
          get(CUR), i32(1), sub, set(CM), get(Ii), get(CM), sub, set(DELTA),
          // stop: empty, out of work, or out of the window
          get(CUR), eqz, get(CNT), eqz, or, get(DELTA), i32(32768), ge_s, or,
          if_(son(get(PL)), i32(0), st32, son(get(PM)), i32(0), st32, br(2)),
          get(CNT), i32(1), sub, set(CNT),
          get(CM), i32(32767), and, i32(1), shl, set(NS),
          get(LL), get(LM), get(LL), get(LM), lt_s, select, set(LEN),
          byte([get(CM), get(LEN), add]), byte([get(Ii), get(LEN), add]), eq,
          if_(
            block(loop(
              get(LEN), i32(1), add, tee(LEN), get(LIM), ge_s, brIf(1),
              byte([get(CM), get(LEN), add]), byte([get(Ii), get(LEN), add]), eq, brIf(0),
            )),
            get(LEN), get(BEST), gt_s,
            if_(
              get(LEN), set(BEST),
              get(TOP), get(CAP), ge_s, if_(i32(-1), [0x0f]),
              get(POOL), get(TOP), i32(2), shl, add, get(DELTA), i32(1), sub, i32(9), shl, get(LEN), i32(3), sub, or, st32,
              get(TOP), i32(1), add, set(TOP),
              get(LEN), get(LIM), eq,
              if_(son(get(PL)), son(get(NS)), ld32, st32, son(get(PM)), son([get(NS), i32(1), add]), ld32, st32, br(4)),
            ),
          ),
          byte([get(CM), get(LEN), add]), byte([get(Ii), get(LEN), add]), lt_u,
          ifElse(
            [son(get(PL)), get(CUR), st32, get(NS), i32(1), add, tee(PL), set(A), son(get(A)), ld32, set(CUR), get(LEN), set(LL)],
            [son(get(PM)), get(CUR), st32, get(NS), tee(PM), set(A), son(get(A)), ld32, set(CUR), get(LEN), set(LM)],
          ),
          br(0),
        )),
      ),
      get(Ii), i32(1), add, set(Ii), br(0),
    )),
    get(OFF), get(N), i32(2), shl, add, get(TOP), st32,
    get(TOP),
  ];
  return { name: 'bt', params: Array(8).fill(I32), result: I32, locals: [[17, I32]], body };
})();

// ---- kernel 2: one optimal-parse relaxation pass -------------------------------------------------------------------
// parse(data, n, off, pool, cost, plen, pdist, tabs, bstart, nb, dsym): cost[] must be +Inf from 1 on, cost[0] = 0.
// tabs: per block 545 doubles (lit[256], len[259], dist[30]); bstart[k]: first position of block k; dsym: DIST_SYM.
const PARSE = (() => {
  const [DATA, N, OFF, POOL, COST, PLEN, PDIST, TABS, BSTART, NB, DSYM] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const [Ii, BI, NEXTB, TAB, K, E, V, LEN, DIST, FROM, L, A] = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
  const [CI, DC, C] = [23, 24, 25];
  const costAt = (idx) => [get(COST), idx, i32(3), shl, add];
  const body = [
    i32(0), set(BI), get(TABS), set(TAB),
    // nextB = nb > 1 ? bstart[1] : n + 1
    get(NB), i32(1), gt_s,
    ifElse([get(BSTART), i32(4), add, ld32, set(NEXTB)], [get(N), i32(1), add, set(NEXTB)]),
    i32(0), set(Ii),
    block(loop(
      get(Ii), get(N), ge_s, brIf(1),
      get(Ii), get(NEXTB), ge_s,
      if_(
        get(BI), i32(1), add, set(BI), get(TABS), get(BI), i32(4360), mul, add, set(TAB),
        get(BI), i32(1), add, get(NB), lt_s,
        ifElse([get(BSTART), get(BI), i32(1), add, i32(2), shl, add, ld32, set(NEXTB)], [get(N), i32(1), add, set(NEXTB)]),
      ),
      costAt(get(Ii)), ldf, set(CI),
      // literal
      get(CI), get(TAB), get(DATA), get(Ii), add, ld8, i32(3), shl, add, ldf, fadd, tee(C),
      costAt([get(Ii), i32(1), add]), ldf, flt,
      if_(
        costAt([get(Ii), i32(1), add]), get(C), stf,
        get(PLEN), get(Ii), i32(1), add, i32(1), shl, add, i32(1), st16,
        get(PDIST), get(Ii), i32(1), add, i32(1), shl, add, i32(0), st16,
      ),
      // matches
      i32(3), set(FROM),
      get(OFF), get(Ii), i32(2), shl, add, tee(A), ld32, set(K), get(A), i32(4), add, ld32, set(E),
      block(loop(
        get(K), get(E), ge_s, brIf(1),
        get(POOL), get(K), i32(2), shl, add, ld32, tee(V), i32(511), and, i32(3), add, set(LEN),
        get(V), i32(9), shr_u, i32(1), add, set(DIST),
        // dc = ci + distT[dsym[dist]]   (distT at tab + (256 + 259) * 8)
        get(CI), get(TAB), get(DSYM), get(DIST), add, ld8, i32(3), shl, add, i32(4120), add, ldf, fadd, set(DC),
        get(LEN), i32(258), eq, if_(i32(258), set(FROM)),
        get(FROM), set(L),
        block(loop(
          get(L), get(LEN), gt_s, brIf(1),
          // c = dc + lenT[l]   (lenT at tab + 256 * 8)
          get(DC), get(TAB), get(L), i32(3), shl, add, i32(2048), add, ldf, fadd, tee(C),
          costAt([get(Ii), get(L), add]), ldf, flt,
          if_(
            costAt([get(Ii), get(L), add]), get(C), stf,
            get(PLEN), get(Ii), get(L), add, i32(1), shl, add, get(L), st16,
            get(PDIST), get(Ii), get(L), add, i32(1), shl, add, get(DIST), i32(1), sub, st16,
          ),
          get(L), i32(1), add, set(L), br(0),
        )),
        get(LEN), i32(1), add, set(FROM),
        get(K), i32(1), add, set(K), br(0),
      )),
      get(Ii), i32(1), add, set(Ii), br(0),
    )),
  ];
  return { name: 'parse', params: Array(11).fill(I32), result: null, locals: [[12, I32], [3, F64]], body };
})();

// ---- runtime -------------------------------------------------------------------------------------------------------
let inst = null, mem = null;
function ready() {
  if (inst) return true;
  try {
    mem = new WebAssembly.Memory({ initial: 16 });
    inst = new WebAssembly.Instance(new WebAssembly.Module(moduleOf([BT, PARSE])), { env: { mem } }).exports;
    return true;
  } catch {
    inst = null;
    return false;
  }
}
export const wasmAvailable = () => ready();

/** Make sure the memory holds `bytes`; returns the buffer (views must be made after this). */
function reserve(bytes) {
  const need = Math.ceil(bytes / 65536) - mem.buffer.byteLength / 65536;
  if (need > 0) mem.grow(need);
  return mem.buffer;
}

/**
 * A workspace for one data array: data, match lists and parse arrays in WASM memory.
 * Layout (bytes, 8-aligned): data | dsym | head | son | off | pool | cost | plen | pdist | tabs | bstart
 */
export function workspace(data, cut, DIST_SYM) {
  ready();
  const n = data.length, al = (x) => (x + 7) & ~7;
  const L = {};
  let p = 0;
  L.data = p; p = al(p + n + 8);
  L.dsym = p; p = al(p + 32769);
  L.head = p; p = al(p + 4 * 65536);
  L.son = p; p = al(p + 4 * 65536);
  L.off = p; p = al(p + 4 * (n + 1));
  let cap = Math.max(1024, n * 3);
  L.pool = p;
  const rest = (cap) => {
    let q = al(L.pool + 4 * cap);
    L.cost = q; q = al(q + 8 * (n + 1));
    L.plen = q; q = al(q + 2 * (n + 1));
    L.pdist = q; q = al(q + 2 * (n + 1));
    L.tabs = q;
    return q;
  };
  let top;
  for (;;) {
    const end = rest(cap);
    const buf = reserve(end);
    new Uint8Array(buf, L.data, n).set(data);
    new Uint8Array(buf, L.dsym, 32769).set(DIST_SYM);
    new Int32Array(buf, L.head, 65536).fill(0);
    new Int32Array(buf, L.son, 65536).fill(0);
    top = inst.bt(L.data, n, cut, L.head, L.son, L.off, L.pool, cap);
    if (top >= 0) break;
    cap *= 2;
  }
  const view = () => {
    const b = mem.buffer;
    return {
      off: new Int32Array(b, L.off, n + 1), pool: new Uint32Array(b, L.pool, top),
      cost: new Float64Array(b, L.cost, n + 1), plen: new Uint16Array(b, L.plen, n + 1), pdist: new Uint16Array(b, L.pdist, n + 1),
    };
  };
  return {
    n, top, view,
    /** One relaxation pass with per-block tables ({lit, len, dist} Float64Arrays) starting at blockStart positions. */
    parse(tables, blockStart) {
      const nb = tables.length;
      const tabBytes = nb * 545 * 8;
      const end = L.tabs + tabBytes + 4 * nb + 8;
      const buf = reserve(end);
      const tabs = new Float64Array(buf, L.tabs, nb * 545);
      tables.forEach((t, k) => { tabs.set(t.lit, k * 545); tabs.set(t.len, k * 545 + 256); tabs.set(t.dist, k * 545 + 515); });
      const bs = al(L.tabs + tabBytes);
      new Int32Array(buf, bs, nb).set(blockStart);
      const cost = new Float64Array(buf, L.cost, n + 1);
      cost.fill(Infinity); cost[0] = 0;
      inst.parse(L.data, n, L.off, L.pool, L.cost, L.plen, L.pdist, L.tabs, bs, nb, L.dsym);
      return view();
    },
  };
}
