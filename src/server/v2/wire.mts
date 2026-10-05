import type { Column } from './recorder.mts';
import type { ValuedBook } from './levels.mts';

/**
 * Binary frame: u32 header length, UTF-8 JSON header, zero padding to 8 bytes, then typed-array payloads
 * in the order the header declares them. Offsets in the header are relative to the payload start.
 */
export const WIRE_COLUMNS = 'columns';
export const WIRE_LEVELS = 'levels';

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

/** All instruments' columns in one frame: three typed arrays (bins, bid, ask) per instrument, concatenated across columns. */
export function encodeColumns(results: ColumnsRequestResult[], from: number, to: number, stepMs: number): Buffer {
  const parts: Part[] = [];
  const instruments = results.map(({ instrumentId, step, columns }) => {
    const total = columns.reduce((sum, c) => sum + c.bins.length, 0);
    const bins = new Int32Array(total), bid = new Float32Array(total), ask = new Float32Array(total);
    let at = 0;
    for (const c of columns) { bins.set(c.bins, at); bid.set(c.bid, at); ask.set(c.ask, at); at += c.bins.length; }
    parts.push({ kind: 'i32', data: bins }, { kind: 'f32', data: bid }, { kind: 'f32', data: ask });
    return { id: instrumentId, step, times: columns.map(c => c.t), counts: columns.map(c => c.bins.length), samples: columns.map(c => c.n) };
  });
  return frame({ type: WIRE_COLUMNS, from, to, stepMs, instruments }, parts);
}

/** Live valued books: per instrument bid/ask lo, hi, usd (6 float64 arrays). */
export function encodeLevels(books: ValuedBook[], asOf: number): Buffer {
  const parts: Part[] = [];
  const instruments = books.map(book => {
    for (const side of [book.bids, book.asks]) parts.push({ kind: 'f64', data: side.lo }, { kind: 'f64', data: side.hi }, { kind: 'f64', data: side.usd });
    return { id: book.instrumentId, venue: book.venue, timestamp: book.timestamp, coarse: book.coarse, bids: book.bids.usd.length, asks: book.asks.usd.length };
  });
  return frame({ type: WIRE_LEVELS, asOf, instruments }, parts);
}
