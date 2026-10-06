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
