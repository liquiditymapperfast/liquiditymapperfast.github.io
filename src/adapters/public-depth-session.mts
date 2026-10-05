import { isBestFirst, markBestFirst } from '../core/sorted-levels.mts';
import { arrayValue, type AdapterOptions, type BookSessionFlags, type DepthSessionIdentity, type DepthSessionMessageOptions, type DepthSessionResult } from './common.mts';
import type { DepthSnapshot, DepthDelta, PriceAmount } from '../domain/contracts.ts';
export type PublicDepthUpdate = (DepthSnapshot | DepthDelta) & { sequenceReset?: boolean; continuity?: string; previousSequence?: number | string; };
export interface PublicDepthSession extends DepthSessionIdentity { book: (PublicDepthUpdate & BookSessionFlags) | null; providerRangePending: boolean; allowUnsequenced: boolean; depth: number | null; }
/** Generic in-memory public depth session for venues with snapshot/update feeds.
 * It enforces session ownership and provider sequence continuity without doing
 * I/O. A fresh snapshot is required after a gap, reconnect, or malformed frame.
 */
function asSequence(value: unknown, field: string = 'sequence', { allowZero = true }: AdapterOptions = {}) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`${field} is unsafe numeric; preserve the provider token as a string`);
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new TypeError(`${field} is missing or invalid`);
  const integer = BigInt(text);
  if ((!allowZero && integer <= 0n) || integer < 0n) throw new TypeError(`${field} is missing or invalid`);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}

function compareSequence(left: unknown, right: unknown) {
  try {
    const a = BigInt(String(left)); const b = BigInt(String(right));
    return a < b ? -1 : a > b ? 1 : 0;
  } catch { return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0; }
}

/**
 * Apply update rows (amount 0 deletes) to a book that is already sorted best-first and cap it at `depth` levels.
 * Updates are merged into the sorted array and untouched levels keep their objects: books of 1,000-2,000 levels see dozens
 * of updates per message, so re-sorting and re-allocating the whole book each time dominated the server's CPU.
 * Because versions of a book share level objects, they are frozen: an in-place write would corrupt older retained states.
 */
export function applyRows(rows: PriceAmount[] | null | undefined, existing: readonly PriceAmount[] | null | undefined, descending: boolean, depth: number | null = null): PriceAmount[] {
  const updates = new Map<number, number>();
  for (const row of rows ?? []) {
    const price = Number(row?.price); const amount = Number(row?.amount);
    if (!(price > 0) || !Number.isFinite(amount) || amount < 0) continue;
    updates.set(price, amount);
  }
  const base = existing ?? [], limit = depth == null ? Infinity : depth;
  if (updates.size === 0) return base.length > limit ? base.slice(0, limit) : base.slice();
  let ordered = base.length > 0 && updates.size <= 400;
  if (!isBestFirst(base, descending)) for (let i = 1; i < base.length && ordered; i++) ordered = descending ? base[i]!.price < base[i - 1]!.price : base[i]!.price > base[i - 1]!.price;
  if (!ordered) {
    // First snapshot, a very large update, or a retained side that is not strictly best-first: rebuild with one sort.
    const rebuilt = new Map<number, number>(base.map(row => [Number(row.price), Number(row.amount)]));
    for (const [price, amount] of updates) { if (amount > 0) rebuilt.set(price, amount); else rebuilt.delete(price); }
    const sorted = [...rebuilt].sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]).map(([price, amount]) => Object.freeze({ price, amount }));
    return markBestFirst(sorted.length > limit ? sorted.slice(0, limit) : sorted, descending);
  }
  // Edit a copy of the sorted array by binary search and splice: the cost follows the updates, not the 2,000-level book.
  const out = base.slice();
  for (const [price, amount] of updates) {
    let lo = 0, hi = out.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (descending ? out[mid]!.price > price : out[mid]!.price < price) lo = mid + 1; else hi = mid; }
    const hit = lo < out.length && out[lo]!.price === price;
    if (amount > 0) { const level = Object.freeze({ price, amount }); if (hit) out[lo] = level; else out.splice(lo, 0, level); } else if (hit) out.splice(lo, 1);
  }
  if (out.length > limit) out.length = limit;
  return markBestFirst(out, descending);
}

export function createPublicDepthSession({ venue, topic, instrumentId, sessionToken, allowUnsequenced = false, depth = null }: AdapterOptions): PublicDepthSession {
  if (!venue || !topic || !instrumentId || !sessionToken) throw new TypeError('public depth session venue, topic, instrument, and token are required');
  const limit = depth == null ? null : Number(depth);
  if (limit != null && (!Number.isSafeInteger(limit) || limit < 1)) throw new TypeError('public depth session depth must be a positive integer');
  return { venue: String(venue), topic: String(topic), instrumentId: String(instrumentId), sessionToken: String(sessionToken), status: 'awaiting-snapshot', book: null, invalidated: false, providerRangePending: String(venue).toLowerCase() === 'bitget', allowUnsequenced: Boolean(allowUnsequenced) || String(venue).toLowerCase() === 'coinbase', depth: limit };
}

export function applyPublicDepthSessionMessage(session: PublicDepthSession, { topic, sessionToken, update }: DepthSessionMessageOptions<PublicDepthUpdate> = {}): DepthSessionResult<PublicDepthSession> {
  if (!session || !update) throw new TypeError('public depth session and update are required');
  if (topic !== session.topic) return { session, accepted: false, ignored: true, reason: 'wrong-topic' };
  if (sessionToken !== session.sessionToken) return { session, accepted: false, ignored: true, reason: 'cross-session' };
  if (update.instrumentId !== session.instrumentId) return { session, accepted: false, ignored: true, reason: 'wrong-instrument' };
  if (update.kind === 'depthSnapshot') {
    if (session.allowUnsequenced) {
      const book = { ...update, sequence: undefined, complete: true, gap: false, invalidated: false, resyncRequired: false, continuity: update.continuity ?? 'provider-guaranteed', status: 'live', bids: applyRows(update.bids, [], true, session.depth), asks: applyRows(update.asks, [], false, session.depth) };
      return { session: { ...session, book, status: 'live', invalidated: false }, accepted: true, ignored: false, reason: null };
    }
    const sequence = asSequence(update.sequence, 'snapshot sequence');
    const book = { ...update, sequence, complete: true, gap: false, invalidated: false, resyncRequired: false, status: 'live', bids: applyRows(update.bids, [], true, session.depth), asks: applyRows(update.asks, [], false, session.depth) };
    return { session: { ...session, book, status: 'live', invalidated: false, providerRangePending: session.venue === 'bitget' }, accepted: true, ignored: false, reason: null };
  }
  if (update.kind !== 'depthDelta') throw new TypeError('unsupported public depth update');
  if (!session.book || session.status !== 'live' || session.invalidated) return { session, accepted: false, ignored: true, reason: 'fresh-snapshot-required' };
  if (session.allowUnsequenced) {
    const nextBook = {
      ...session.book,
      ...update,
      complete: true,
      gap: false,
      invalidated: false,
      resyncRequired: false,
      continuity: update.continuity ?? 'provider-guaranteed',
      status: 'live',
      bids: applyRows(update.bids, arrayValue(session.book.bids), true, session.depth),
      asks: applyRows(update.asks, arrayValue(session.book.asks), false, session.depth),
    };
    return { session: { ...session, book: nextBook, status: 'live', invalidated: false }, accepted: true, ignored: false, reason: null };
  }
  const liveBook = session.book;
  const sequence = asSequence(update.sequence, 'delta sequence');
  const current = session.book.sequence;
  const previous = update.previousSequence == null ? null : asSequence(update.previousSequence, 'previous sequence');
  const breakSession = (reason: string) => {
    const broken = { ...liveBook, complete: false, gap: true, invalidated: true, resyncRequired: true, status: 'resync-required', invalidReason: reason };
    return { session: { ...session, book: broken, status: 'resync-required', invalidated: true, invalidReason: reason }, accepted: false, ignored: false, reason: 'resync-required' };
  };
  if (update.sequenceReset === true) return breakSession('provider sequence reset');
  if (previous == null) return breakSession('missing previous sequence');
  if (session.venue === 'bitget' && compareSequence(previous, 0) === 0) return breakSession('provider sequence reset');
  const ordering = compareSequence(sequence, current);
  if (ordering < 0) return breakSession('provider sequence reset or rewind');
  if (ordering === 0) {
    if (compareSequence(previous, current) === 0) return { session, accepted: false, ignored: true, reason: 'old-or-duplicate' };
    return breakSession('depth sequence gap');
  }
  const previousOrdering = compareSequence(previous, current);
  // Bitget permits one first-update range bridge after a snapshot: the
  // snapshot sequence must lie within [pseq, seq]. Once consumed, pseq must
  // equal the last accepted sequence just like the other public books.
  const bitgetRangeBridge = session.venue === 'bitget'
    && session.providerRangePending === true
    && previousOrdering < 0
    && compareSequence(previous, 0) > 0
    && compareSequence(previous, current) < 0
    && compareSequence(current, sequence) < 0;
  if (previousOrdering !== 0 && !bitgetRangeBridge) return breakSession('depth sequence gap');
  const sequenceBridge = bitgetRangeBridge;
  const nextBook = {
    ...session.book,
    ...update,
    sequence,
    previousSequence: previous,
    bids: applyRows(update.bids, arrayValue(session.book.bids), true, session.depth),
    asks: applyRows(update.asks, arrayValue(session.book.asks), false, session.depth),
    complete: true,
    gap: false,
    invalidated: false,
    resyncRequired: false,
    sequenceBridge,
    continuity: sequenceBridge ? 'provider-range' : 'strict',
    status: 'live',
  };
  return { session: { ...session, book: nextBook, status: 'live', invalidated: false, providerRangePending: false }, accepted: true, ignored: false, reason: null };
}

export function invalidatePublicDepthSession(session: PublicDepthSession, reason: string = 'disconnect'): PublicDepthSession {
  if (!session) throw new TypeError('public depth session is required');
  const book = session.book ? { ...session.book, complete: false, gap: true, invalidated: true, resyncRequired: true, status: 'resync-required', invalidReason: String(reason) } : null;
  return { ...session, book, status: 'resync-required', invalidated: true, invalidReason: String(reason) };
}
