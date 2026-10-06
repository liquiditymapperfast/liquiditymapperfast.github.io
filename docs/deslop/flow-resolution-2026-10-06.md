# Taker flow at one second: JavaScript, not WebAssembly (2026-10-06)

The flow column keeps every instrument's taker buys and sells **per second** (`src/shared/flow.ts`) and draws any span from five minutes to a
day from that one series, so "fast", "slow" and "high resolution" are the same data at different spans, not three stores.

## What it costs

- Memory: a ring of 2^17 seconds (a little over 36 h) with two Float64 running sums (delta and gross) is 2 MB per instrument; 20 instruments are 40 MB.
- The recorder keeps 36 h of minutes in memory (60 buy and 60 sell seconds each, 960 B in memory, 480 B on disk as Float32) and 7 days in SQLite, 24 h in the browser's IndexedDB.
- A window's delta, volume and share are two reads of the running sums, whatever the window is (ranking and labels cost nothing).
- Drawing needs, per pixel column, the lowest, highest and last running delta: `FlowSeries.decimate`, a scan of the seconds the column covers.

## Why the scan is not a WebAssembly kernel

`AGENTS.md` allows a kernel only where it pays for itself, so it was built as a throwaway (`wasm32`, `wasm-bindgen`, the same loop, results compared bit for bit with
the JavaScript, which agree) and timed on 20 lanes of 86,400 random seconds, 300 columns, Node 22, per frame of the whole column:

| span | JavaScript | WebAssembly (window copied in) |
|---|---|---|
| 5 min | 0.13 ms | 0.25 ms |
| 1 h | 0.72 ms | 0.83 ms |
| 4 h | 2.04 ms | 1.93 ms |
| 24 h | 8.03 ms | 7.42 ms |

The loop is memory-bound and a kernel has to be handed the same bytes (a typed-array view is copied into the module's memory), so it does not win: at most 7 %
at a day, and it loses at short spans. Keeping the ring inside the module's memory would remove the copy, but a view of that memory is detached whenever the module
grows it, which is a class of bug this does not justify at a worst case of 8 ms **once a second** (the model is rebuilt when new seconds arrive or the window moves by
a pixel, not on every pointer move). So there is no kernel and one implementation of the scan, with its tests in `tests/shared-flow.test.mts`.

If a day of data at 40 or more lanes ever shows up in a profile, the next step is a min/max pyramid (a coarse level for long spans), not WebAssembly.

## What the column costs the page (measured 2026-10-06)

Headless Chrome 1700 x 950, the browser source (every venue), 10 lanes of flow, the same session with the column switched off and on, main-thread time as a share of wall time
(`Performance.getMetrics`, `TaskDuration`):

| | column off | column on | cost |
|---|---|---|---|
| idle, 20 s (Map span) | 6.7 % | 7.8 % | +1.0 point |
| idle, 24 h span | 6.7 % | 7.5 % | +0.7 point |
| pointer scrubbing the map, 10 s | 37.9 % | 39.3 % | +1.3 points |

The first version redrew the column on every map frame (+4.5 points while scrubbing); it now redraws only when the map's window has moved by one pixel of the column's own plot
(`CvdPane.followMap`), and a hover on the map costs it nothing. Layout work is unchanged (no DOM is written per frame; the column is one canvas).

## A price a second, and what the Map span showed (2026-10-06, later)

Two things looked wrong in the first screenshots of the column, and one of them was a bug.

**The flat Map line was mostly the future.** The map runs about 8 % of its span past *now*, and in Map mode the column took the map's window as it was, so the right 15 columns
held nothing but the last value repeated; the minutes of flow a freshly started server had recorded then shared one or two 16-minute columns of a 53-hour map (a vertical jump
and a flat run). The Map span now ends at *now*, starts where the flow starts when that is later (never under a minute long), and says "Flow recorded since 14:10"; a span chosen
by hand keeps its length and gets the note. The rules are `cvd/window.ts` (`tests/app-cvd-window.test.mts`).

**The price steps were a bug in `PriceTrack.load`.** The candle still open is stamped at *now*, and the old `load` kept only marks newer than its last candle, so every candle
reload (once a minute) turned the live per-second marks into minute closes. Candle closes and marks are now kept apart and the later of the two wins at any moment
(`tests/app-cvd.test.mts`: "reloading the minute candles does not flatten the live marks").

**A price for every second, from the same trades as the flow.** The recorder keeps, per instrument and second, the base quantity next to the buy and sell USD, so a second's price
is its volume-weighted price (USD over quantity: order-independent, and a replayed trade is already ignored by the seen-set). It is written with the minute, pushed with each second
(`[inst, second, buy, sell, price]`), sent in frames (a `px` flag per instrument in the header, so a frame without prices still decodes), kept by the page in a ring beside the delta
sums, and read forward from the last second that traded (at most two hours back); a second with no trade has none, never 0. The strip uses it where the market on screen has
recorded seconds and falls back to candle closes and marks before them (or entirely, for a market the recorder does not hold, such as Binance's `:spot` id, which maps to the flow
feeds' `binancespot:`).

Compatibility: SQLite rows are 720 bytes (buys, sells, prices); a 480-byte row from before loads with no prices (`tests/v2-flow.test.mts`). IndexedDB rows gain an optional `px`.
A server that predates the change answers frames without `px` and the page then uses candles.

Memory: the recorder's bins went from 120 to 180 doubles a minute (the quantity), +50 %. A day and a half of one instrument is 2160 minutes: 2.07 MB before, 3.11 MB now, so 27
instruments are about 84 MB (56 MB before) and the 48-instrument cap about 149 MB (100 MB before). The page's ring adds 0.5 MB per instrument it holds.

## The shared time cursor costs nothing measurable (2026-10-06)

Pointing at the map or at another pane now draws a vertical line at the same moment on the flow column (and the column's own pointer is shared back through `store.hover`, `source: 'cvd'`),
so the column repaints when that line moves a pixel (`CvdPane.syncHover`; the model is not rebuilt). Measured as the earlier cost was: headless Chrome 1700 x 950, the browser
source, the pointer scrubbing the map for 10 s, the column switched off and on alternately four times each after a warm-up (`Performance.getMetrics`, `TaskDuration` over wall time):

| | runs | mean |
|---|---|---|
| column off | 21.4, 21.8, 18.3, 18.7 | 20.1 % (sd 1.6) |
| column on | 22.1, 17.8, 20.8, 17.9 | 19.6 % (sd 1.9) |

The difference (-0.4 points) is inside the noise of the runs, so the shared line adds less than about 2 points of a core while scrubbing, against the +1.3 measured before it
existed. (A first, single run, started while another script was running, read 20.8 % off and 16.7 % on: an order effect, which is why the alternating runs above were made.)
