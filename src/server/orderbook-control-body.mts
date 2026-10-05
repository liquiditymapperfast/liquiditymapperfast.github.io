import type { IncomingMessage } from 'node:http';
import { scanBoundedJsonComplexity } from '../core/bounded-json-response.mts';

export const ORDERBOOK_CONTROL_BODY_BYTES = 4096;
export const ORDERBOOK_CONTROL_PARSE_BYTES = 65_536;
export interface OrderbookControlBody { instrumentId: string; venues: string[]; }
/** The parsed provider-independent request has only bounded scalar fields. */
export function parseOrderbookControlBody(text: string): OrderbookControlBody | null {
  if (Buffer.byteLength(text, 'utf8') > ORDERBOOK_CONTROL_BODY_BYTES) return null;
  try {
    scanBoundedJsonComplexity(text, { maxTokens: 128, maxDepth: 4 });
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 2 || !keys.includes('instrumentId') || !keys.includes('venues')
      || typeof record.instrumentId !== 'string' || !record.instrumentId || record.instrumentId.length > 128
      || !Array.isArray(record.venues) || record.venues.length > 32) return null;
    const venues: string[] = [];
    for (const value of record.venues) {
      if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value) || venues.includes(value)) return null;
      venues.push(value);
    }
    return { instrumentId: record.instrumentId, venues };
  } catch { return null; }
}
/** Caller owns a fresh parse grant. Oversized input is drained without retention;
 * all raw chunks/listeners are released before returning the scalar request. */
export function readOrderbookControlBody(req: IncomingMessage): Promise<OrderbookControlBody | null> {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > ORDERBOOK_CONTROL_BODY_BYTES)) { req.resume(); return Promise.resolve(null); }
  return new Promise(resolve => {
    let chunks: Buffer[] = [], bytes = 0, finished = false;
    const finish = (value: OrderbookControlBody | null) => {
      if (finished) return; finished = true;
      req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', error); req.removeListener('aborted', error);
      req.once('error', () => {}); // A later aborted socket must not emit an unhandled error.
      chunks = []; resolve(value);
    };
    const error = () => finish(null);
    const data = (value: unknown) => {
      if (!Buffer.isBuffer(value) || chunks.length >= 32 || value.byteLength > ORDERBOOK_CONTROL_BODY_BYTES - bytes) {
        finish(null); req.resume(); return;
      }
      bytes += value.byteLength; chunks.push(value);
    };
    const end = () => { const value = parseOrderbookControlBody(Buffer.concat(chunks, bytes).toString('utf8')); finish(value); };
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', error);
  });
}
