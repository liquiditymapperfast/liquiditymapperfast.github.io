/** Decoders for the v2 binary frames (see src/server/v2/wire.mts for the layout). */
import type { ColumnSet, ColumnsFrame } from '../shared/columns.ts';
import { LT_FIELDS, LT_LENGTH } from '../shared/lt-sample.ts';
import { checkTape, type TapeBatch } from '../shared/tape.ts';
import { usableEpoch, usableStep } from '../shared/levels.ts';
export type { ColumnSet, ColumnsFrame };
type PartKind = 'f64' | 'f32' | 'i32';
interface PartSpec { kind: PartKind; offset: number; length: number }
interface FrameHeader { type: string; parts: PartSpec[] }

export interface SideArrays { lo: Float64Array; hi: Float64Array; usd: Float64Array }
/**
 * `touch`: a grouped book's top-group span, where its touch may be (`ValuedBook.touch`). `step`: the grid step the book's far levels were
 * merged on, so out to about 250 steps from its mid it keeps its USD per bin of that grid (`ValuedBook.step`); none from an older server,
 * for a grouped book, or for one nothing merged.
 */
export interface LiveBook { id: string; venue: string; timestamp: number; coarse: boolean; bids: SideArrays; asks: SideArrays; touch?: { lo: number; hi: number }; step?: number; epoch?: number }
export interface LevelsFrame { asOf: number; books: LiveBook[] }

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

/** A trade-dust batch (server/v2/wire.mts `encodeTape`), checked with shared/tape.ts `checkTape`; null when malformed. */
export function decodeTape(buffer: ArrayBuffer): TapeBatch | null {
  const { header, part } = open(buffer);
  if (header.type !== 'tape') throw new Error(`Expected a tape frame, got ${header.type}`);
  return checkTape({ seq: header.seq, dropped: header.dropped, ids: header.ids, inst: part(0), t: part(1), price: part(2), usd: part(3), lo: part(4), hi: part(5) });
}

/**
 * One part of the answer to a Liquidity Tracker question (server/v2/wire.mts `encodeLt`): per market the starts of its windows over
 * [from, to) at `stepMs`, and LT_FIELDS numbers each of the half-life asked (NaN where the tracker does not cover the window). `done`: the last.
 */
export interface LtFrame { id: number; from: number; to: number; stepMs: number; half: number; done: boolean; instruments: { id: string; times: Float64Array; values: Float32Array }[] }
export function decodeLt(buffer: ArrayBuffer): LtFrame {
  const { header, part } = open(buffer);
  if (header.type !== 'lt') throw new Error(`Expected a tracker frame, got ${header.type}`);
  const raw = header.instruments as { id: string; windows: number }[];
  const frame = { id: Number(header.id), from: Number(header.from), to: Number(header.to), stepMs: Number(header.stepMs), half: Number(header.half), done: header.done === true };
  if (![frame.id, frame.from, frame.to, frame.stepMs, frame.half].every(Number.isFinite) || !Array.isArray(raw)) throw new Error('Malformed tracker frame');
  return { ...frame, instruments: raw.map((item, i) => {
    const times = part(i * 2), values = part(i * 2 + 1);
    if (!(times instanceof Float64Array) || !(values instanceof Float32Array)) throw new Error('Malformed tracker frame');
    if (typeof item.id !== 'string' || times.length !== item.windows || values.length !== times.length * LT_FIELDS) throw new Error('Malformed tracker frame');
    return { id: item.id, times, values };
  }) };
}

export function decodeColumns(buffer: ArrayBuffer): ColumnsFrame {
  const { header, part } = open(buffer);
  if (header.type !== 'columns') throw new Error(`Expected a columns frame, got ${header.type}`);
  const raw = header.instruments as { id: string; step: number; times: number[]; counts: number[]; samples: number[]; lt?: unknown; at?: unknown }[];
  return { from: Number(header.from), to: Number(header.to), stepMs: Number(header.stepMs), instruments: raw.map((item, i) => {
    const { lt: ltPart, at, ...rest } = item;
    // The minute each window's book is of, in an answer for each window's close (`ColumnSet.at`): one that is not a time for every window
    // fails the answer (it is never read as the averages a server from before sends without it).
    if (at !== undefined && !(Array.isArray(at) && at.length === item.times.length && at.every(m => Number.isSafeInteger(m)))) throw new Error('Malformed columns frame: at');
    // The tracker kept with the columns, when the server sends it: a part of LT_LENGTH floats per column (an older server sends none).
    const lt = typeof ltPart === 'number' && Number.isInteger(ltPart) ? part(ltPart) : null;
    return { ...rest, ...(at !== undefined ? { at: at as number[] } : {}), bins: part(i * 3) as Int32Array, bid: part(i * 3 + 1) as Float32Array, ask: part(i * 3 + 2) as Float32Array,
      ...(lt instanceof Float32Array && lt.length === item.times.length * LT_LENGTH ? { lt } : {}) };
  }) };
}

export function decodeLevels(buffer: ArrayBuffer): LevelsFrame {
  const { header, part } = open(buffer);
  if (header.type !== 'levels') throw new Error(`Expected a levels frame, got ${header.type}`);
  const raw = header.instruments as { id: string; venue: string; timestamp: number; coarse: boolean; touch?: unknown; step?: unknown; epoch?: unknown }[];
  const side = (at: number): SideArrays => ({ lo: part(at) as Float64Array, hi: part(at + 1) as Float64Array, usd: part(at + 2) as Float64Array });
  // A touch span is taken only when it is two ordered finite prices (an older server sends none).
  const touchOf = (value: unknown): { lo: number; hi: number } | undefined =>
    Array.isArray(value) && value.length === 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) && value[1] > value[0] ? { lo: value[0], hi: value[1] } : undefined;
  return { asOf: Number(header.asOf), books: raw.map((item, i) => {
    const touch = touchOf(item.touch), step = item.step;
    // A merge step is taken only when it is a finite number above zero (an older server sends none): a reader that compares books on this grid
    // would divide by anything else, so a malformed one is left out, not thrown on, and the reader falls back to the grid it can infer.
    return { id: item.id, venue: item.venue, timestamp: item.timestamp, coarse: item.coarse, bids: side(i * 6), asks: side(i * 6 + 3), ...(touch ? { touch } : {}), ...(usableStep(step) ? { step } : {}), ...(usableEpoch(item.epoch) ? { epoch: item.epoch } : {}) };
  }) };
}
