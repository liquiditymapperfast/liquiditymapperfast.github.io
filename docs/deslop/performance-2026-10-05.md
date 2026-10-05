# Performance round, 2026-10-05

Method as in [baseline-2026-10-04.md](./baseline-2026-10-04.md): isolated, visible headless Chrome over CDP on the real GPU path (ANGLE / Direct3D 11,
NVIDIA RTX 4070), Node `--inspect` CPU profiles of the server, and side-by-side runs on the same live markets for any server comparison. Numbers are
medians of the stated number of runs unless noted.

## What the app is made of (the question asked before this round)

The browser client has no framework and no virtual DOM. The toolbar, panels and menus are built imperatively with `el()` and patched in place (`sync()` only
assigns attributes that changed); everything that costs anything is a canvas 2D pane, the WebGL2 heatmap, a Web Worker, or the wasm kernels. Under 30 s of
zoom / pan interaction with 24 venues the frame time is vsync-bound (p50 16.7 ms, p95 16.9 ms); the toolbar and panels do not appear in the profile. A
framework (Svelte included) compiles to the same direct DOM calls, so it could only touch the part that is not a measured cost, at the price of rewriting every
panel, the build and the harness. Not adopted. If panel state ever hurts, the place for a fix is a small derived-value helper on the existing `Store`.

## Server

Profile of the session-start build (40 s, 24 venues, one browser attached): `usdBookLevels` 9.5 % self time plus `valueBook` 3 %, because every changed book
was re-valued in full on every loop tick. The deep-book work of this session (distance-merged buckets, a 10,000-level raw cap so that Coinbase's whole book
is kept) first raised that to 17 % self (22 % inclusive in `refreshBooks`) and the server from about 56 % to about 78 % of a core.

Changes:

* `valueBook` has a fast path for plain books (tuples, base-size units, known USD conversion, no metadata, no coarse bands): `price x amount x rate` straight
  into typed arrays, then the distance merge in the same function. Anything else keeps the general `usdBookLevels` path; a test compares the two exactly on a
  random 6,000-level book and checks that supplied notionals, quote-sized books and unconvertible quotes still take the general path.
* Books with 2,000 or more raw levels are re-valued at most once a second (the recorder samples every 5 s).
* `runRetainedAdmission` no longer evaluates its allocation estimate: the price handler's estimate walked every layer level on each price tick and the result was
  discarded.
* Recorded columns drop bins under $10,000 (bid + ask, minute mean) once a column has more than 300 bins, never keeping fewer than the 300 largest, and the
  distance merge widens its buckets at 0.4 % of the distance from the mark (power-of-two multiples of the grid step beyond the step, capped at 16 steps).
  Before, bytes per recorded column were Phemex 26-30 KB, HitBTC 14-19 KB, Bitunix 14 KB, Coinbase 12 KB, Binance US 9 KB, Binance spot 7.6 KB; of the merged live
  levels 67 % (Bitunix, Binance spot), 85 % (Phemex) and 46 % (Coinbase) were under $5k. Measured over the same venues for 16 minutes on the final settings:
  95 KB to 47 KB per minute summed over venues (50 %), about 68 MB a day and 0.48 GB over the 7-day retention instead of about 1 GB; several venues now sit at the
  300-bin floor (3.6 KB per column).

Side by side, same live markets, same 40 s window, one browser attached to each, profiler attached to both (so both include sampling overhead):

| build | CPU, % of one core | working set |
| --- | --- | --- |
| session start | 80.4 | 238 MB |
| this round | 76.4 | 224 MB |

The remaining cost is feed handling: socket parsing, `merge` / `applyRows` / `applySortedDelta` for the retained books, and the snapshot-venue connectors.
Nothing in valuation is left in the top of the profile.

## Client

Raster worker, 24 venues, view of 40 minutes at about +-10 % of price (rows far under 15 px, so the vertical smoothing is on), medians of 14 rasters:

| step | before | after |
| --- | --- | --- |
| kernel (`raster_columns`) | 95 ms | 57 ms |
| vertical smoothing | 46 ms | folded into the kernel (about 0 extra) |
| quantiles | 6 ms | 6 ms |
| total, smoothing auto | 151 ms | 64.5 ms |
| total, smoothing off | 103 ms | 63.7 ms |

The kernel used to splat every recorded minute's row vector across all the pixel columns it spans (about 37 zoomed out), summing the same vector many times.
Pixel columns wholly inside one recorded column take its value with weight exactly 1, so the sum over instruments is now computed once per recorded time slot and
written to the slot's interior pixel columns; only the (at most two) boundary columns per column need per-instrument weights. The smoothing is linear and
column-wise, so it is applied to the slot sums and the boundary columns instead of every pixel column. Per-bin divisions became reciprocals. The previous
rasteriser is kept in the crate's tests and compared on 40 random cases; the in-kernel smoothing is compared against `blur_rows` of the unsmoothed raster, and
both are covered again by a Node contract test against the shipped wasm.

Main thread under 30 s of interaction (profile, unminified build to see names), medians of 2 runs:

| | before | after |
| --- | --- | --- |
| idle | 48 % | 64 % |
| `price()` | 6.1 % | not in the top 30 |
| `worker.postMessage` (history frames) | 3.2 % | not in the top 30 |
| `topPrints` | 2.4 % | 1.5 % (second round of changes brought it lower still) |
| worst frame | 100-117 ms | 67 ms |
| frame p50 / p95 | 16.7 / 16.9 ms | 16.7 / 16.9 ms |

* `price()` built a new `Intl.NumberFormat` on every call through `toLocaleString`; there is now one formatter per number of decimals. `clock()` took month names
  the same way and now uses a table.
* History frames were structured-cloned to the worker (tens of MB); the underlying buffers are handed over instead, since nothing on the main thread reads them
  again.
* Prints are held in time order, so the visible window is found by bisection and the largest few hundred are picked with a native typed-array sort.
* Texture upload: `texSubImage2D` was benchmarked against `texImage2D` for the 2000 x 1400 RG32F raster on this GPU and is not faster (median 8.3 ms against
  4.7 ms, worst 10 ms against 19 ms), so the upload is unchanged.

## Left as it is, and why

* The server is not moved to wasm: its cost is object churn from arrays of tuples and parsing, which copying into wasm would only move.
* The raster kernel's remaining time is the per-bin row mapping (about 1 million bins per raster at this zoom). It could be cached per (instrument, minute) across
  rasters, but the kernel is deliberately stateless, and the cache would help only when the view does not change.
* Deep far-book history grows with time; per-column storage is now bounded by the floor, which is the lever to turn if disk or memory matter more than faint
  far levels.

## The browser-only page (2026-10-05, later)

No server: the engine (connectors, valuation, recording, history requests) runs in a Web Worker next to the raster worker. Measured with headless Chrome on this machine (software GL, so
the GPU number is a ceiling), page idle after 30 s warm-up, eight default venues live, the 1h chart, no footprint, 63 s window, `?persist=0`:

| Process | CPU (share of one core) | Working set |
| --- | --- | --- |
| renderer (main thread + feeds worker + raster worker) | 23.9 % | 301 MB |
| of which main thread tasks | 4.7 % (script 2.3 %) | JS heap 4 MB |
| GPU process | 8.4 % | 157 MB |
| browser + utility | 2.1 % | |

So the engine and the raster worker together take about 19 % of a core, close to what the server used for the same venues (about 17 %). The main thread, which draws, is nearly idle.
Recordings in IndexedDB add a transaction every half second and structured-cloned reads once at start; they were not measured separately. Retention is 24 hours (the server keeps seven days),
which at the 47 KB per minute of columns measured above is about 68 MB for the depth columns; the footprint maps and large-trade lists after a full day were not measured.
