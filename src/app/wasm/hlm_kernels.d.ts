/* tslint:disable */
/* eslint-disable */

/**
 * Smooth a raster (`w * h * 2` values, row-major, two channels) vertically with a Gaussian of `sigma` rows, as three box passes.
 * Mass is conserved away from the top and bottom edges. A `sigma` under a third of a row returns the input unchanged.
 */
export function blur_rows(data: Float32Array, w: number, h: number, sigma: number): Float32Array;

/**
 * `mergeByDistance` for a point side (`lo`, `usd`, nearest first; the caller has checked there are no bands): its levels in buckets
 * that widen with distance from `mid`, each reported at its farthest member and in the order a bucket was first met (the TypeScript
 * Map's), the USD added in the same order, so the result is the same to the last bit; levels past `MAX_DISTANCE` dropped. Returned
 * packed: the buckets' prices, then their USD (`2 * buckets` numbers). A key is `floor(price / width)` in twentieths of a step: a
 * positive double, so its bit pattern is never the table's empty mark.
 */
export function merge_by_distance(lo: Float64Array, usd: Float64Array, mid: number, step: number, is_bid: boolean): Float64Array;

/**
 * Rasterise recorded minute columns into a `w x h` grid of interleaved `[bid, ask]` USD values.
 *
 * Row 0 is the lowest price `p0`; column 0 is time `t0`. Per pixel column each instrument's value is the
 * mean over the time it was actually observed (gaps do not dim a neighbour). Per row the value is the USD
 * that falls inside the row's price band. `steps[i]` is instrument `i`'s grid step; `col_inst[c]` names a
 * column's instrument; `bins/bid/ask` hold every column's entries back to back (`col_count[c]` each).
 *
 * A pixel column that lies wholly inside one recorded column takes that column's value with weight exactly 1, so
 * the sum over instruments is computed once per recorded time slot and written to all of the slot's interior
 * pixel columns; only the (at most two) pixel columns that straddle a slot boundary need per-instrument weights.
 * Zoomed out, a slot spans dozens of pixel columns, which is where the time used to go.
 *
 * `sigma` (rows; 0 for none) smooths the result vertically as `blur_rows` would, but on the per-slot sums and the few boundary
 * columns instead of on every pixel column: identical pixel columns are blurred once.
 */
export function raster_columns(steps: Float64Array, col_inst: Uint32Array, col_time: Float64Array, col_count: Uint32Array, bins: Int32Array, bid: Float32Array, ask: Float32Array, step_ms: number, t0: number, t1: number, p0: number, p1: number, w: number, h: number, sigma: number): Float32Array;

/**
 * Spread USD levels over a fixed price grid, one output row of `nbins` bins per instrument.
 *
 * A level `[lo, hi)` contributes `usd * overlap / (hi - lo)` to each bin it touches; a point level
 * (`hi <= lo`) lands wholly in `floor(lo / step)`. Bins outside `[bin0, bin0 + nbins)` are dropped. An overlap under
 * a billionth of the band is rounding (a band edge on a bin edge at a small price), not overlap, as in `accumulateSide`.
 * Output is instrument-major: `out[inst * nbins + (bin - bin0)]`.
 */
export function spread_levels(lo: Float64Array, hi: Float64Array, usd: Float64Array, inst: Uint32Array, n_inst: number, step: number, bin0: number, nbins: number): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly blur_rows: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly merge_by_distance: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly raster_columns: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number) => void;
    readonly spread_levels: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
