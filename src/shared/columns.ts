/** Recorded or live columns of one instrument as the page reads them: column `c` holds `counts[c]` bins starting where the previous one ended. */
export interface ColumnSet {
  id: string; step: number;
  times: number[]; counts: number[]; samples: number[];
  bins: Int32Array; bid: Float32Array; ask: Float32Array;
}
export interface ColumnsFrame { from: number; to: number; stepMs: number; instruments: ColumnSet[] }

/** Most instruments one /api/v2/columns request serves; the client splits a longer list into requests of this size. */
export const COLUMNS_PER_REQUEST = 12;
