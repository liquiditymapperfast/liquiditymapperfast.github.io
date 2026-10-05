/** Decoders for the v2 binary frames (see src/server/v2/wire.mts for the layout). */
type PartKind = 'f64' | 'f32' | 'i32';
interface PartSpec { kind: PartKind; offset: number; length: number }
interface FrameHeader { type: string; parts: PartSpec[] }

export interface SideArrays { lo: Float64Array; hi: Float64Array; usd: Float64Array }
export interface LiveBook { id: string; venue: string; timestamp: number; coarse: boolean; bids: SideArrays; asks: SideArrays }
export interface LevelsFrame { asOf: number; books: LiveBook[] }
export interface ColumnSet {
  id: string; step: number;
  times: number[]; counts: number[]; samples: number[];
  bins: Int32Array; bid: Float32Array; ask: Float32Array;
}
export interface ColumnsFrame { from: number; to: number; stepMs: number; instruments: ColumnSet[] }

function open(buffer: ArrayBuffer): { header: FrameHeader & Record<string, unknown>; part(index: number): Float64Array | Float32Array | Int32Array } {
  const view = new DataView(buffer);
  const length = view.getUint32(0, true);
  if (length === 0 || 4 + length > buffer.byteLength) throw new Error('Malformed frame header length');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as FrameHeader & Record<string, unknown>;
  if (!Array.isArray(header.parts)) throw new Error('Frame has no part table');
  const base = (4 + length + 7) & ~7;
  return { header, part(index) {
    const spec = header.parts[index];
    if (!spec) throw new Error(`Frame part ${index} is missing`);
    const bytes = spec.kind === 'f32' || spec.kind === 'i32' ? 4 : 8;
    if (base + spec.offset + spec.length * bytes > buffer.byteLength) throw new Error('Frame part exceeds the buffer');
    return spec.kind === 'f64' ? new Float64Array(buffer, base + spec.offset, spec.length)
      : spec.kind === 'f32' ? new Float32Array(buffer, base + spec.offset, spec.length) : new Int32Array(buffer, base + spec.offset, spec.length);
  } };
}

export function frameType(buffer: ArrayBuffer): string { return open(buffer).header.type; }

export function decodeColumns(buffer: ArrayBuffer): ColumnsFrame {
  const { header, part } = open(buffer);
  if (header.type !== 'columns') throw new Error(`Expected a columns frame, got ${header.type}`);
  const raw = header.instruments as { id: string; step: number; times: number[]; counts: number[]; samples: number[] }[];
  return { from: Number(header.from), to: Number(header.to), stepMs: Number(header.stepMs), instruments: raw.map((item, i) => ({
    ...item, bins: part(i * 3) as Int32Array, bid: part(i * 3 + 1) as Float32Array, ask: part(i * 3 + 2) as Float32Array })) };
}

export function decodeLevels(buffer: ArrayBuffer): LevelsFrame {
  const { header, part } = open(buffer);
  if (header.type !== 'levels') throw new Error(`Expected a levels frame, got ${header.type}`);
  const raw = header.instruments as { id: string; venue: string; timestamp: number; coarse: boolean }[];
  const side = (at: number): SideArrays => ({ lo: part(at) as Float64Array, hi: part(at + 1) as Float64Array, usd: part(at + 2) as Float64Array });
  return { asOf: Number(header.asOf), books: raw.map((item, i) => ({ id: item.id, venue: item.venue, timestamp: item.timestamp, coarse: item.coarse, bids: side(i * 6), asks: side(i * 6 + 3) })) };
}
