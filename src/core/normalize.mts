import { isBestFirst, markBestFirst } from './sorted-levels.mts';
export interface MarketNormalizationInput {
  venue?: unknown;
  exchange?: unknown;
  nativeSymbol?: unknown;
  symbol?: unknown;
  base?: unknown;
  baseNormalized?: unknown;
  quote?: unknown;
  quoteNormalized?: unknown;
  marketType?: unknown;
  id?: unknown;
  tickSize?: unknown;
  quantityUnit?: unknown;
  isFree?: unknown;
  aggregationId?: unknown;
}

export interface NormalizedMarketCandidate {
  id: string;
  instrumentId: string;
  venue: 'hyperliquid' | 'binance';
  exchange: 'hyperliquid' | 'binance';
  nativeSymbol: string;
  symbol: string;
  base: string;
  quote: string;
  baseNormalized: string;
  quoteNormalized: string;
  marketType: string;
  tickSize: number;
  quantityUnit: string;
  isFree: boolean;
  aggregationId: number;
}

export type BookMetadata = Record<string, unknown>;
export type BookMetadataContainer = Map<number, unknown> | Record<string, unknown>;
export interface NormalizedBookState {
  bids: Map<number, number>;
  asks: Map<number, number>;
  levelMetadata?: { bids?: BookMetadataContainer; asks?: BookMetadataContainer };
  sequence: unknown;
  status: 'live' | 'snapshot' | 'gap';
  gap: boolean;
}

interface MutableBookState extends NormalizedBookState {
  levelMetadata: { bids: Map<number, unknown>; asks: Map<number, unknown> };
}
interface BookDeltaInput {
  previousSequence?: unknown;
  sequence?: unknown;
  bids?: unknown;
  asks?: unknown;
}

interface BookSnapshotInput {
  bids?: unknown;
  asks?: unknown;
  sequence?: unknown;
  complete?: unknown;
  levelMetadata?: { bids?: unknown; asks?: unknown };
}

interface BookEntry {
  price: unknown;
  amount: unknown;
  metadata: BookMetadata | null;
}

export function instrumentId(venue: unknown, symbol: unknown): string {
  return `${venue}:${symbol}`;
}

export function normalizeMarket(input: unknown): NormalizedMarketCandidate {
  const fields = input as MarketNormalizationInput;
  const venue = fields.venue ?? fields.exchange;
  const symbol = fields.nativeSymbol ?? fields.symbol;
  const base = String(fields.base ?? fields.baseNormalized ?? symbol).toUpperCase();
  const quote = String(fields.quote ?? fields.quoteNormalized ?? 'USD').toUpperCase();
  const marketType = fields.marketType === 'derivatives' ? 'perpetual' : (fields.marketType ?? 'spot');
  if (typeof symbol !== 'string' || !symbol || typeof venue !== 'string' || !['hyperliquid', 'binance'].includes(venue)) throw new Error('market venue/symbol missing');
  const supportedVenue = venue as 'hyperliquid' | 'binance';
  if (fields.id != null && (typeof fields.id !== 'string' || !fields.id)) throw new Error('market id invalid');
  if (typeof marketType !== 'string') throw new Error('market type invalid');
  if (fields.quantityUnit != null && typeof fields.quantityUnit !== 'string') throw new Error('market quantity unit invalid');
  const id = fields.id ?? `${instrumentId(supportedVenue, symbol)}${supportedVenue === 'binance' && marketType === 'spot' ? ':spot' : ''}`;
  return { id, instrumentId: id, venue: supportedVenue, exchange: supportedVenue, nativeSymbol: symbol,
    symbol, base, quote, baseNormalized: base, quoteNormalized: quote, marketType,
    tickSize: Number(fields.tickSize ?? 0.1), quantityUnit: fields.quantityUnit ?? 'base',
    isFree: Boolean(fields.isFree ?? true), aggregationId: Number(fields.aggregationId ?? 0) };
}

function metadataMap(value: unknown): Map<number, unknown> {
  return value instanceof Map
    ? new Map<number, unknown>(value as Map<number, unknown>)
    : new Map<number, unknown>(Object.entries((value ?? {}) as Record<string, unknown>).map(([price, metadata]) => [Number(price), metadata]));
}

function bookEntries(rows: unknown): BookEntry[] {
  return ((rows ?? []) as unknown[]).map((row: unknown) => {
    if (Array.isArray(row)) return { price: row[0], amount: row[1], metadata: null };
    const { price, amount, ...metadata } = (row ?? {}) as Record<string, unknown>;
    return { price, amount, metadata: Object.keys(metadata).length ? metadata : null };
  });
}

function stripValuation(value: unknown): BookMetadata {
  if (!value || typeof value !== 'object') return {};
  const { notionalUsd: _notionalUsd, notionalEstimated: _notionalEstimated, ...stable } = value as Record<string, unknown>;
  return stable;
}

export function applyBookDelta(book: NormalizedBookState, delta: unknown, { strictSequence = true }: { strictSequence?: unknown } = {}): NormalizedBookState {
  const update = delta as BookDeltaInput;
  if (strictSequence && update.previousSequence != null && book.sequence != null && update.previousSequence !== book.sequence)
    return { ...book, status: 'gap', gap: true };
  const next: MutableBookState = {
    bids: new Map(book.bids), asks: new Map(book.asks),
    levelMetadata: { bids: metadataMap(book.levelMetadata?.bids), asks: metadataMap(book.levelMetadata?.asks) },
    sequence: update.sequence ?? book.sequence, status: 'live', gap: false,
  };
  const apply = (side: 'bids' | 'asks', rows: unknown): void => {
    for (const { price, amount, metadata } of bookEntries(rows)) {
      const key = Number(price);
      if ((amount as number) > 0) {
        const nextAmount = Number(amount);
        const previousAmount = next[side].get(key);
        next[side].set(key, Number(amount));
        const prior = next.levelMetadata[side].get(key);
        if (metadata) {
          const merged = { ...stripValuation(prior), ...metadata };
          if (!Object.hasOwn(metadata, 'notionalUsd')) {
            delete merged.notionalUsd; delete merged.notionalEstimated;
          } else if (!Object.hasOwn(metadata, 'notionalEstimated')) {
            delete merged.notionalEstimated;
          }
          next.levelMetadata[side].set(key, merged);
        } else if (previousAmount !== nextAmount) {
          // A tuple/price+amount delta carries no replacement source
          // notional. Remove a stale one while retaining stable coarse-bound
          // provenance for the level.
          const stable = stripValuation(prior);
          if (Object.keys(stable).length) next.levelMetadata[side].set(key, stable);
          else next.levelMetadata[side].delete(key);
        }
      } else {
        next[side].delete(key); next.levelMetadata[side].delete(key);
      }
    }
  };
  apply('bids', update.bids); apply('asks', update.asks);
  return next;
}

export function bookFromSnapshot(snapshot: unknown): NormalizedBookState {
  const fields = snapshot as BookSnapshotInput;
  const side = (rows: unknown, persistedMetadata: unknown): { levels: Map<number, number>; metadata: Map<number, unknown> } => {
    const levels = new Map<number, number>(); const metadata = metadataMap(persistedMetadata);
    for (const row of ((rows ?? []) as Iterable<unknown>)) {
      const value = row as { price?: unknown; amount?: unknown } | null | undefined;
      const price = Number(Array.isArray(row) ? row[0] : value?.price);
      const amount = Number(Array.isArray(row) ? row[1] : value?.amount);
      if (!Number.isFinite(price) || !Number.isFinite(amount)) continue;
      levels.set(price, amount);
      if (!Array.isArray(row) && row && typeof row === 'object') {
        const { price: _price, amount: _amount, ...rest } = row as Record<string, unknown>;
        if (Object.keys(rest).length) metadata.set(price, rest);
      }
    }
    return { levels, metadata };
  };
  const bids = side(fields.bids, fields.levelMetadata?.bids);
  const asks = side(fields.asks, fields.levelMetadata?.asks);
  return { bids: bids.levels, asks: asks.levels, levelMetadata: { bids: bids.metadata, asks: asks.metadata },
    sequence: fields.sequence, status: fields.complete ? 'live' : 'snapshot', gap: false };
}

export interface SortedBook {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  levelMetadata?: { bids: Record<string, unknown>; asks: Record<string, unknown> };
}

export function sortedBook(book: NormalizedBookState, { includeMetadata = false }: { includeMetadata?: unknown } = {}): SortedBook {
  const result: SortedBook = { bids: markBestFirst([...book.bids].sort((a, b) => b[0] - a[0]), true), asks: markBestFirst([...book.asks].sort((a, b) => a[0] - b[0]), false) };
  if (includeMetadata) {
    const serialize = (side: 'bids' | 'asks'): Record<string, unknown> => {
      const value = book.levelMetadata?.[side];
      const entries: Array<[number | string, unknown]> = value instanceof Map
        ? [...value.entries()]
        : Object.entries(value ?? {});
      return Object.fromEntries(entries.map(([price, metadata]) => [String(price), metadata]));
    };
    result.levelMetadata = { bids: serialize('bids'), asks: serialize('asks') };
  }
  return result;
}

const hasEntries = (value: unknown): boolean => value instanceof Map ? value.size > 0 : value != null && typeof value === 'object' && Object.keys(value).length > 0;

/** A row that is just a price and an amount (tuple or plain object, no per-level metadata), or null. */
function plainRow(row: unknown): [number, unknown] | null {
  if (Array.isArray(row)) return row.length === 2 ? [Number(row[0]), row[1]] : null;
  if (row === null || typeof row !== 'object') return null;
  for (const key in row) if (key !== 'price' && key !== 'amount') return null;
  const { price, amount } = row as { price?: unknown; amount?: unknown };
  return [Number(price), amount];
}

/**
 * sortedBook(bookFromSnapshot(snapshot), { includeMetadata: true }) without the Maps and the re-sort, for the common case of a
 * snapshot whose rows are plain prices and amounts already in best-first order (every depth session emits one). Returns null
 * whenever anything needs the general path: level metadata, extra row fields, invalid, duplicate or unsorted rows.
 */
export function sortedBookFromSortedSnapshot(snapshot: unknown): SortedBook | null {
  const fields = snapshot as BookSnapshotInput;
  if (hasEntries(fields.levelMetadata?.bids) || hasEntries(fields.levelMetadata?.asks)) return null;
  const side = (rows: unknown, descending: boolean): Array<[number, number]> | null => {
    if (rows == null) return [];
    if (!Array.isArray(rows)) return null;
    const out: Array<[number, number]> = new Array(rows.length);
    let previous = descending ? Infinity : -Infinity;
    for (let i = 0; i < rows.length; i++) {
      const plain = plainRow(rows[i]);
      if (!plain) return null;
      const price = plain[0], amount = Number(plain[1]);
      if (!Number.isFinite(price) || !Number.isFinite(amount) || (descending ? price >= previous : price <= previous)) return null;
      previous = price; out[i] = [price, amount];
    }
    return out;
  };
  const bids = side(fields.bids, true), asks = side(fields.asks, false);
  return bids && asks ? { bids: markBestFirst(bids, true), asks: markBestFirst(asks, false), levelMetadata: { bids: {}, asks: {} } } : null;
}

/** Beyond this many updated levels per side the general rebuild is cheaper than editing the sorted array. */
const MAX_SPLICE_UPDATES = 400;

export type SortedDeltaResult = { gap: true } | { gap: false; sequence: unknown; bids: Array<[number, number]>; asks: Array<[number, number]>; levelMetadata: { bids: Record<string, unknown>; asks: Record<string, unknown> } };

/**
 * applyBookDelta on a retained sorted book followed by sortedBook and a cap at \`limit\` levels, as one merge of the updated levels into
 * the sorted arrays (untouched [price, amount] pairs are reused). Only for books and deltas without level metadata; returns null when
 * the general path is needed, including when a retained side is not strictly best-first.
 */
export function applySortedDelta(previous: { bids: Array<[number, number]>; asks: Array<[number, number]>; sequence?: unknown; levelMetadata?: unknown },
  delta: unknown, limit: number): SortedDeltaResult | null {
  const update = delta as BookDeltaInput;
  const retained = previous.levelMetadata as { bids?: unknown; asks?: unknown } | null | undefined;
  if (hasEntries(retained?.bids) || hasEntries(retained?.asks)) return null;
  if (update.previousSequence != null && previous.sequence != null && update.previousSequence !== previous.sequence) return { gap: true };
  const changes = (rows: unknown): Map<number, number> | null => {
    const out = new Map<number, number>();
    if (rows == null) return out;
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
      const plain = plainRow(row);
      if (!plain) return null;
      const price = plain[0], raw = plain[1];
      if (!Number.isFinite(price) || (typeof raw !== 'number' && typeof raw !== 'string')) return null;
      out.set(price, Number(raw) > 0 ? Number(raw) : 0);
    }
    return out;
  };
  const merge = (base: Array<[number, number]>, updates: Map<number, number>, descending: boolean): Array<[number, number]> | null => {
    if (!isBestFirst(base, descending)) for (let i = 1; i < base.length; i++) if (!(descending ? base[i]![0] < base[i - 1]![0] : base[i]![0] > base[i - 1]![0])) return null;
    // Edit a copy of the sorted array by binary search and splice: the cost follows the updates, not the 1,500-level book. (A walk
    // over every level was the top server cost under load: each level is a separate heap object, so it is cache-cold per message.)
    const out = base.slice();
    for (const [price, amount] of updates) {
      let lo = 0, hi = out.length; // first index at or after `price` in best-first order
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (descending ? out[mid]![0] > price : out[mid]![0] < price) lo = mid + 1; else hi = mid; }
      const hit = lo < out.length && out[lo]![0] === price;
      if (amount > 0) { if (hit) out[lo] = [price, amount]; else out.splice(lo, 0, [price, amount]); } else if (hit) out.splice(lo, 1);
    }
    if (out.length > limit) out.length = limit;
    return markBestFirst(out, descending);
  };
  const bidChanges = changes(update.bids), askChanges = changes(update.asks);
  if (!bidChanges || !askChanges || bidChanges.size > MAX_SPLICE_UPDATES || askChanges.size > MAX_SPLICE_UPDATES) return null;
  const bids = merge(previous.bids, bidChanges, true), asks = merge(previous.asks, askChanges, false);
  if (!bids || !asks) return null;
  return { gap: false, sequence: update.sequence ?? previous.sequence, bids, asks, levelMetadata: { bids: {}, asks: {} } };
}
