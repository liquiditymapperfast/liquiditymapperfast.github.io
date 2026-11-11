import type { Column } from './recorder.mts';
import { packLt } from '../../shared/columns.ts';
import type { ValuedBook } from './levels.mts';
import { usableEpoch, usableStep } from '../../shared/levels.ts';
import type { TapeBatch } from '../../shared/tape.ts';
import type { LtWindows } from '../../shared/lt-windows.ts';

/**
 * Binary frame: u32 header length, UTF-8 JSON header, zero padding to 8 bytes, then typed-array payloads
 * in the order the header declares them. Offsets in the header are relative to the payload start.
 */
export const WIRE_COLUMNS = 'columns';
export const WIRE_LEVELS = 'levels';
export const WIRE_TAPE = 'tape';
export const WIRE_LT = 'lt';

type Part = { kind: 'f64' | 'f32' | 'i32'; data: Float64Array | Float32Array | Int32Array };

function frame(header: Record<string, unknown>, parts: Part[]): Buffer {
  let offset = 0;
  const layout = parts.map(part => { const at = offset; offset += part.data.byteLength; offset = (offset + 7) & ~7; return { kind: part.kind, offset: at, length: part.data.length }; });
  const json = Buffer.from(JSON.stringify({ ...header, parts: layout }));
  const headerEnd = (4 + json.length + 7) & ~7;
  const out = Buffer.alloc(headerEnd + offset);
  out.writeUInt32LE(json.length, 0);
  json.copy(out, 4);
  parts.forEach((part, i) => Buffer.from(part.data.buffer, part.data.byteOffset, part.data.byteLength).copy(out, headerEnd + layout[i]!.offset));
  return out;
}

export interface ColumnsRequestResult { step: number; instrumentId: string; columns: Column[] }

/**
 * All instruments' columns in one frame: three typed arrays (bins, bid, ask) per instrument, concatenated across columns. The Liquidity
 * Tracker kept with the columns (`packLt`) follows after every instrument's three, its part's index in the instrument's `lt` field, so a
 * page that does not know it reads the frame as before.
 */
export function encodeColumns(results: ColumnsRequestResult[], from: number, to: number, stepMs: number, close = false): Buffer {
  const parts: Part[] = [], trackers: Float32Array[] = [];
  const instruments = results.map(({ instrumentId, step, columns }) => {
    const total = columns.reduce((sum, c) => sum + c.bins.length, 0);
    const bins = new Int32Array(total), bid = new Float32Array(total), ask = new Float32Array(total);
    let at = 0;
    for (const c of columns) { bins.set(c.bins, at); bid.set(c.bid, at); ask.set(c.ask, at); at += c.bins.length; }
    parts.push({ kind: 'i32', data: bins }, { kind: 'f32', data: bid }, { kind: 'f32', data: ask });
    const lt = packLt(columns), ltPart = lt ? 3 * results.length + trackers.length : undefined;
    if (lt) trackers.push(lt);
    // An answer for each window's close says the minute each is of (`Column.at`): a page tells it from an older server's averages by it.
    return { id: instrumentId, step, times: columns.map(c => c.t), counts: columns.map(c => c.bins.length), samples: columns.map(c => c.n), ...(ltPart !== undefined ? { lt: ltPart } : {}), ...(close ? { at: columns.map(c => c.at ?? c.t) } : {}) };
  });
  for (const lt of trackers) parts.push({ kind: 'f32', data: lt });
  return frame({ type: WIRE_COLUMNS, from, to, stepMs, instruments }, parts);
}

/**
 * One part of the answer to a Liquidity Tracker question on the live socket (`{t:'lt', id}`), over [from, to) at `stepMs`: per instrument the
 * starts of its windows (f64) and four numbers each for the half-life asked (f32, NaN where its tracker does not cover the window). The
 * answer is a few such frames, the newest stretch first; `done` is on the last.
 */
export function encodeLt(id: number, from: number, to: number, stepMs: number, half: number, done: boolean, results: { instrumentId: string; windows: LtWindows }[]): Buffer {
  const parts: Part[] = [];
  const instruments = results.map(({ instrumentId, windows }) => {
    parts.push({ kind: 'f64', data: Float64Array.from(windows.times) }, { kind: 'f32', data: windows.values });
    return { id: instrumentId, windows: windows.times.length };
  });
  return frame({ type: WIRE_LT, id, from, to, stepMs, half, done, instruments }, parts);
}

/** Every market order completed since the last batch (shared/tape.ts): the ids in the header, six columns as parts. */
export function encodeTape(batch: TapeBatch): Buffer {
  return frame({ type: WIRE_TAPE, seq: batch.seq, dropped: batch.dropped, ids: batch.ids }, [{ kind: 'i32', data: batch.inst }, { kind: 'f64', data: batch.t }, { kind: 'f64', data: batch.price }, { kind: 'f32', data: batch.usd }, { kind: 'f64', data: batch.lo }, { kind: 'f64', data: batch.hi }]);
}

/** Live valued books: per instrument bid/ask lo, hi, usd (6 float64 arrays). */
export function encodeLevels(books: ValuedBook[], asOf: number): Buffer {
  const parts: Part[] = [];
  const instruments = books.map(book => {
    for (const side of [book.bids, book.asks]) parts.push({ kind: 'f64', data: side.lo }, { kind: 'f64', data: side.hi }, { kind: 'f64', data: side.usd });
    // `touch`: a grouped book's top-group span (`ValuedBook.touch`), only where there is one; a page that does not know it ignores it.
    // `step`: the grid its far levels were merged on (`ValuedBook.step`), only where something merged and only a usable number (JSON would turn
    // NaN or Infinity into null); a page that does not know it ignores it, and an older server sends none. `epoch`: what the book covers
    // (`ValuedBook.epoch`), only where the book has one, so a page's walls and cues start again when more of it became visible.
    return { id: book.instrumentId, venue: book.venue, timestamp: book.timestamp, coarse: book.coarse, bids: book.bids.usd.length, asks: book.asks.usd.length, ...(book.touch ? { touch: [book.touch.lo, book.touch.hi] } : {}), ...(usableStep(book.step) ? { step: book.step } : {}), ...(usableEpoch(book.epoch) ? { epoch: book.epoch } : {}) };
  });
  return frame({ type: WIRE_LEVELS, asOf, instruments }, parts);
}
