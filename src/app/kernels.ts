import init, { blur_rows, raster_columns, spread_levels } from './wasm/hlm_kernels.js';

export interface Kernels {
  spreadLevels(lo: Float64Array, hi: Float64Array, usd: Float64Array, inst: Uint32Array, nInst: number, step: number, bin0: number, nBins: number): Float32Array;
  rasterColumns(args: RasterArgs): Float32Array;
  /** Vertical Gaussian smoothing of a `w * h * 2` raster, `sigma` in rows (under a third of a row returns the input). */
  blurRows(data: Float32Array, w: number, h: number, sigma: number): Float32Array;
}
export interface RasterArgs {
  steps: Float64Array; colInst: Uint32Array; colTime: Float64Array; colCount: Uint32Array;
  bins: Int32Array; bid: Float32Array; ask: Float32Array;
  stepMs: number; t0: number; t1: number; p0: number; p1: number; w: number; h: number;
  /** Vertical smoothing in rows applied inside the kernel (0 for none). */
  sigma: number;
}

let loading: Promise<Kernels> | null = null;
/** Instantiate the wasm kernels once per thread. */
export function loadKernels(): Promise<Kernels> {
  loading ??= init().then(() => ({
    spreadLevels: (lo, hi, usd, inst, nInst, step, bin0, nBins) => spread_levels(lo, hi, usd, inst, nInst, step, bin0, nBins),
    blurRows: (data, w, h, sigma) => blur_rows(data, w, h, sigma),
    rasterColumns: a => raster_columns(a.steps, a.colInst, a.colTime, a.colCount, a.bins, a.bid, a.ask, a.stepMs, a.t0, a.t1, a.p0, a.p1, a.w, a.h, a.sigma),
  }));
  return loading;
}
