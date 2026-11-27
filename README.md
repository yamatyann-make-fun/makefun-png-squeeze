# makefun-png-squeeze

Entry for make.fun's "Squeeze screenshots into the smallest PNG, 27 November 2026" bounty.
`main.ts` reads each `/input/<id>/image.png` and writes the smallest lossless PNG it can find to
`/output/<id>/image.png` (bit depth 8, no interlacing, only IHDR / PLTE / tRNS / IDAT / IEND).

## How it works

1. **Representation** (`src/modes.mjs`): palette (three index orders, transparent entries first so tRNS stays short),
   grey, grey + alpha, RGB or RGBA, and RGB / grey with a tRNS colour key when transparency allows it.
2. **Row filters** (`src/filter.mjs`): constant filters, min-sum, entropy, and a brute-force selector that compresses
   each row with every filter primed by the 32 KiB written before it (with a "stay on the previous filter" bias).
   Candidates are screened with zlib.
3. **Deflate** (`src/deflate.mjs`, `src/huffman.mjs`): our own encoder — hash-chain match search, cost-model optimal
   parsing iterated until it stops improving, greedy block merging, length-limited Huffman codes and a cheapest
   run-length-coded dynamic header.

All search is bounded by work, never by the clock, so two runs write identical bytes (about 37 s for a set on one
modern core; the limit is 60 s).

## Tests

`MAKEFUN_KIT=<unpacked kit dir>` points the checks at the kit (practice set, checker, baseline).

```
node tests/verify.mjs          # pixel-exact (kit checker), format, determinism, time, score vs fixed-paeth
node tests/deflate-roundtrip.mjs
node tests/huffman-check.mjs
node tests/modes-check.mjs
```

Practice set: 763,399 against the fixed-paeth baseline's 420,399.

MIT licensed.
