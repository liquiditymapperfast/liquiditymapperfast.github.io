/**
 * Bybit's full-depth book (`Research_Findings.md`, 2026-11-11): the REST snapshot `GET /v5/market/full_orderbook` and the WebSocket
 * stream `orderbook.full.<symbol>`, which sends deltas only (every 200 ms when the book changed, no snapshot of its own). This module is
 * the whole synchronisation, pure: no socket, no request, no timer. The connector (shared/venues.ts) feeds it frames and snapshot answers
 * and asks it what to do; the history recorder ports the same rules.
 *
 * Seeding is Bybit's documented procedure (docs: websocket/public/full-ob), strictly: the deltas are held from the moment of subscribing;
 * a snapshot is taken only on a held delta with its own `(seq, u)` (its anchor), and the held deltas after the anchor are applied, each `u`
 * one more than the last. A snapshot behind everything held, or one whose anchor carries another `seq`, is read again; one ahead of
 * everything held waits for the stream to reach it (and is read again if the stream passes it without an anchor). Live: `u = 1` starts a
 * new numbering (a restart, a tick change, a delisting) and synchronises again; a `u` already held is ignored; a delta whose `seq` went back
 * is discarded without moving `u` on (the next one then proves continuity or shows a gap); a skipped `u` withdraws the book and
 * synchronises again on the same socket.
 *
 * What a snapshot covers. Bybit documents at most 10,000 levels a side; measured, the linear book came whole (~30,000 / 42,000 for BTC)
 * and now and then much shorter, and spot comes at exactly 10,000 a side. A price beyond the snapshot's deepest level on a side was never
 * seen, and a delta there names only the levels that changed: kept, it would draw a partial book as if it were whole. So each side keeps
 * the deepest price its snapshot reached (its frontier), and every delta row beyond it is left out. Deleting the level at the frontier does
 * not move it: what was observed does not shrink. Levels farther than `GUARD` of the mid are not kept at all (the frontier moves in to it).
 *
 * Extending the coverage. As the price walks toward a frontier inside the drawn band (50 % either side, shared/merge.ts), the band reaches
 * past what is known. A new snapshot is then read while the book stays live; it is caught up with the deltas applied meanwhile (they are
 * kept whole, before any frontier filter) to the live book's own `(seq, u)`, and only its levels beyond the live frontiers are added, in
 * place. Inside its window the live book stays as the stream kept it: in every matched check the stream-kept book equalled the snapshot at
 * the same `u`, while REST answers come from replicas that disagree on a few far levels (two ETH asks present in six reads of ten, absent in
 * four), so a snapshot's absence never deletes a level the stream keeps. There is no refresh on a clock.
 */

/** One side of a book: price -> size in the venue's own unit (coins, for Bybit's linear and spot markets). */
export type Side = Map<number, number>;

/** A delta as validated: the side rows parsed, `u` and `seq` safe integers. */
export interface FullDelta { u: number; seq: number; ts: number; b: [number, number][]; a: [number, number][] }
/** A snapshot as validated: bids best first, asks best first, no zero sizes, not crossed. */
export interface FullSnapshot { u: number; seq: number; ts: number; b: [number, number][]; a: [number, number][] }

/** The snapshot's address (a plain GET: no credentials are ever sent). */
export function fullSnapshotUrl(category: 'linear' | 'spot' | 'inverse', symbol: string): string {
  return `https://api.bybit.com/v5/market/full_orderbook?category=${category}&symbol=${encodeURIComponent(symbol)}`;
}
/** The stream's topic. */
export const fullTopic = (symbol: string): string => `orderbook.full.${symbol}`;

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** A safe non-negative integer from a number or a decimal string, or null. */
function counter(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
/**
 * Rows `[price, size]` as Bybit sends them (decimal strings, read with `Number`). Every row must read: a price that is finite and
 * positive, a size that is finite and not negative (zero deletes, in a delta). One bad row makes the whole list unreadable (null): a frame
 * is applied whole or not at all, never with a row skipped while its `u` is taken. A price named twice in one delta: the later row wins.
 */
function rowsOf(value: unknown, allowZero: boolean): [number, number][] | null {
  if (!Array.isArray(value)) return null;
  const out: [number, number][] = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const row = value[i];
    if (!Array.isArray(row) || row.length < 2) return null;
    const price = Number(row[0]), size = Number(row[1]);
    if (!(price > 0) || !Number.isFinite(price) || !Number.isFinite(size) || size < 0 || (!allowZero && size === 0)) return null;
    out[i] = [price, size];
  }
  return out;
}

/** A stream frame for `symbol`: the delta, `null` for a frame of another topic, or `'bad'` for one of this topic that does not read. */
export function parseFullDelta(message: unknown, symbol: string): FullDelta | null | 'bad' {
  const m = record(message); if (!m || m.topic !== fullTopic(symbol)) return null;
  const d = record(m.data);
  if (m.type !== 'delta' || !d || d.s !== symbol) return 'bad';
  const u = counter(d.u), seq = counter(d.seq), b = rowsOf(d.b, true), a = rowsOf(d.a, true), ts = Number(m.ts);
  if (u === null || u < 1 || seq === null || !b || !a) return 'bad';
  return { u, seq, ts: Number.isFinite(ts) ? ts : 0, b, a };
}

/** A REST answer for `symbol`: the snapshot, or the reason it cannot be used. */
export function parseFullSnapshot(body: unknown, symbol: string): FullSnapshot | string {
  const m = record(body); if (!m) return 'not an object';
  if (m.retCode !== 0) return `retCode ${String(m.retCode)} ${String(m.retMsg ?? '')}`.trim().slice(0, 120);
  const r = record(m.result); if (!r) return 'no result';
  if (r.s !== symbol) return 'another symbol';
  const u = counter(r.u), seq = counter(r.seq), b = rowsOf(r.b, false), a = rowsOf(r.a, false), ts = Number(r.ts);
  if (u === null || seq === null) return 'no sequence';
  if (!b || !a) return 'unreadable levels';
  // Best first on each side, strictly: the frontier is the last row, and a repeated price would make the book ambiguous.
  for (let i = 1; i < b.length; i++) if (!(b[i]![0] < b[i - 1]![0])) return 'bids out of order';
  for (let i = 1; i < a.length; i++) if (!(a[i]![0] > a[i - 1]![0])) return 'asks out of order';
  if (b.length && a.length && b[0]![0] >= a[0]![0]) return 'crossed';
  return { u, seq, ts: Number.isFinite(ts) ? ts : 0, b, a };
}

/** What the connector should do after feeding a frame. */
export type FullAction =
  /** Nothing to do. */
  | 'none'
  /** Read a snapshot for the book (it is not live, or is no longer, or a waiting snapshot can no longer be anchored). */
  | 'snapshot'
  /** The book's numbering is broken over and over: drop the socket and connect again. */
  | 'reconnect';

/**
 * The answer to a snapshot: `seeded` (the book is live), `extended` (a refresh added coverage), `unchanged` (a refresh added nothing),
 * `retry` (read another: behind the stream, or not anchored), `wait` (kept until the stream reaches it), `stale` (asked for in an earlier
 * epoch, or no longer wanted), `rejected` (a refresh that cannot be caught up with the live book).
 */
export type SnapshotResult = 'seeded' | 'extended' | 'unchanged' | 'retry' | 'wait' | 'stale' | 'rejected';

/** The drawn band reaches this share of the price either side (shared/merge.ts MAX_DISTANCE). */
export const BAND = 0.5;
/** Levels farther than this share of the mid are not kept: a margin past the band, so the price can move before a refresh is due. */
export const GUARD = 0.6;
/** A refresh is due once the price has used up this share of a frontier's distance at the seed (or crossed it). */
export const REFRESH_USED = 0.25;
/** At most one refresh a minute, and after one that failed or added nothing an exponential pause up to a quarter of an hour. */
export const REFRESH_MIN_MS = 60_000, REFRESH_MAX_BACKOFF_MS = 900_000;
/** Bybit's documented most levels a snapshot holds on a side: a side with fewer whose frontier is inside the band may have come cut short. */
export const SNAPSHOT_CAP = 10_000;
/** Three resynchronisations within a minute mean the socket itself is bad. */
const RESYNC_LIMIT = 3, RESYNC_WINDOW_MS = 60_000;

export interface FullBookOptions {
  /** How a side is made (the connector's sides keep a sorted copy for valuation, shared/connector.ts). */
  makeSide?: () => Side;
  /** Deltas held while a snapshot is read (5 minutes at Bybit's 200 ms); past it the oldest go, so a slow snapshot is read again. */
  bufferMax?: number;
  /** Delta rows held at most in that buffer (a busy book sends a hundred a frame): past it the oldest frames go too. */
  bufferRowsMax?: number;
  /** Deltas applied recently, kept whole for catching a refresh snapshot up with the live book (30 s at 200 ms). */
  recentMax?: number;
}

/**
 * What is known of one side: the frontier (the deepest price inside which the side is whole; null for a side that came empty, which has
 * nothing anywhere), its distance from the mid when it was set, and how many levels the snapshot that set it had on this side.
 */
interface Coverage { frontier: number | null; seedDistance: number; levels: number }

/**
 * One instrument's full-depth book. `bids` and `asks` are the live sides: replaced whole when a snapshot seeds, changed in place by deltas
 * and by an extension. Read them from the object each time. Times are passed in, so tests and replays drive it with their own clock.
 */
export class FullBook {
  bids: Side; asks: Side;
  /** The book's `u` and `seq` once live (0 before). */
  u = 0; seq = 0;
  /** Bumped on every resynchronisation: an answer to a snapshot asked for in an earlier epoch is not this book's. */
  epoch = 0;
  /** Bumped whenever what the book covers changes (a seed, a withdrawal, an extension): what compares the book over time starts again. */
  coverageEpoch = 0;
  /** When the last delta was applied or the book seeded (the book's own freshness: trades say nothing about it). */
  appliedAt = 0;
  /** Levels inside the live window on which the last refresh snapshot disagreed with the stream-kept book (kept as the stream has them). */
  disagreements = 0;
  #live = false;
  #lastSeq = 0;
  #buffer: FullDelta[] = []; #bufferRows = 0;
  /** A snapshot ahead of everything held, waiting for the stream to reach its anchor. */
  #waiting: FullSnapshot | null = null;
  /** The deltas applied most recently, whole and contiguous by `u`, for catching a refresh snapshot up with the live book. */
  #recent: FullDelta[] = [];
  #bid: Coverage = noCoverage(); #ask: Coverage = noCoverage();
  /** A refresh under way, and a snapshot of it ahead of the live book waiting for the book to reach it. */
  #refresh: { waiting: FullSnapshot | null } | null = null;
  #nextRefreshAt = 0; #refreshFailures = 0;
  #resyncs: number[] = [];
  /** Why the book last stopped being live (for the status line). */
  lastFault: string | null = null;
  readonly #makeSide: () => Side; readonly #bufferMax: number; readonly #bufferRowsMax: number; readonly #recentMax: number;

  constructor(options: FullBookOptions = {}) {
    this.#makeSide = options.makeSide ?? (() => new Map());
    this.#bufferMax = options.bufferMax ?? 1_500; this.#bufferRowsMax = options.bufferRowsMax ?? 300_000; this.#recentMax = options.recentMax ?? 150;
    this.bids = this.#makeSide(); this.asks = this.#makeSide();
  }

  /** Synchronised: the sides are the venue's book at `(seq, u)`, whole inside the frontiers. */
  get live(): boolean { return this.#live; }
  /** The frontier of each side (null: none, the side came empty). */
  get frontiers(): { bid: number | null; ask: number | null } { return { bid: this.#bid.frontier, ask: this.#ask.frontier }; }
  /** A refresh is being read. */
  get refreshing(): boolean { return this.#refresh !== null; }
  /** A snapshot is waiting for the stream to reach its anchor. */
  get waiting(): boolean { return this.#waiting !== null; }
  /** Deltas held for the snapshot (for tests and the status line). */
  get buffered(): number { return this.#buffer.length; }

  /** A new connection: everything is forgotten (its deltas will be held for a new snapshot). */
  reset(): void {
    this.#withdraw(null);
    this.#buffer = []; this.#bufferRows = 0; this.#lastSeq = 0; this.#resyncs = []; this.#refreshFailures = 0; this.#nextRefreshAt = 0;
  }

  /** One delta from the stream, in arrival order. */
  delta(d: FullDelta, now: number): FullAction {
    // A new numbering comes first: what is held belongs to the old one, and this delta starts the new buffer.
    if (d.u === 1 && (this.#live || this.#buffer.length > 0 || this.#waiting)) return this.#restart(d, 'numbering restarted (u = 1)', now);
    if (!this.#live) return this.#hold(d);
    if (d.u <= this.u) return 'none';
    // Bybit: a delta whose seq went back is discarded; `u` does not move, so the next one shows whether anything was missed.
    if (d.seq < this.#lastSeq) return 'none';
    if (d.u !== this.u + 1) return this.#restart(d, `sequence gap ${this.u} -> ${d.u}`, now);
    this.#apply(d, now);
    const waiting = this.#refresh?.waiting;
    if (waiting && this.u >= waiting.u) { this.#refresh!.waiting = null; this.#finishRefresh(waiting, now); }
    return 'none';
  }

  /** A frame of the book's topic that did not read (`parseFullDelta` said 'bad'): the book is withdrawn and synchronised again. */
  fault(reason: string, now: number): FullAction {
    this.#withdraw(reason);
    this.#buffer = []; this.#bufferRows = 0;
    return this.#counted(now);
  }

  /** The answer to a snapshot asked for in `epoch` (a seed while not live, a refresh while live). */
  snapshot(s: FullSnapshot, epoch: number, now: number): SnapshotResult {
    if (epoch !== this.epoch) return 'stale';
    if (!this.#live) return this.#seedFrom(s, now);
    if (!this.#refresh || this.#refresh.waiting) return 'stale';
    if (s.u > this.u) { this.#refresh.waiting = s; return 'wait'; }
    return this.#finishRefresh(s, now);
  }

  /**
   * Whether a refresh should be read now, at `mid` (the last traded price): a frontier inside the band that the price has come a quarter
   * of the way toward, or crossed (directed distances: a jump past a frontier counts), or one on a side whose snapshot held fewer than
   * Bybit's 10,000 levels (an answer that may have come cut short: refreshed once a minute at most, then less and less often while that adds
   * nothing).
   */
  refreshDue(mid: number, now: number): boolean {
    if (!this.#live || this.#refresh || now < this.#nextRefreshAt || !(mid > 0)) return false;
    const due = (c: Coverage, left: number): boolean => c.frontier !== null && left < mid * BAND && (left <= c.seedDistance * (1 - REFRESH_USED) || c.levels < SNAPSHOT_CAP);
    return due(this.#bid, this.#bid.frontier === null ? Infinity : mid - this.#bid.frontier) || due(this.#ask, this.#ask.frontier === null ? Infinity : this.#ask.frontier - mid);
  }
  /** A refresh is being read for the current epoch: the connector asks for the snapshot and hands the answer to `snapshot`. */
  beginRefresh(now: number): number { this.#refresh = { waiting: null }; this.#nextRefreshAt = now + REFRESH_MIN_MS; return this.epoch; }
  /** The refresh's request failed (or added nothing): the live book stays, the next try waits longer. */
  failRefresh(now: number): void {
    this.#refresh = null; this.#refreshFailures++;
    this.#nextRefreshAt = now + Math.min(REFRESH_MAX_BACKOFF_MS, REFRESH_MIN_MS * 2 ** (this.#refreshFailures - 1));
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------------

  /** Hold a delta while not live; a snapshot waiting for the stream is judged once the stream reaches it. */
  #hold(d: FullDelta): FullAction {
    const last = this.#buffer[this.#buffer.length - 1];
    let lost = false;
    if (last) {
      if (d.u <= last.u) return 'none';
      if (d.seq < this.#lastSeq) return 'none';
      // A gap inside the buffer: Bybit's procedure starts holding again from here. A waiting snapshot can no longer be anchored.
      if (d.u !== last.u + 1) { this.#buffer = []; this.#bufferRows = 0; lost = this.#waiting !== null; this.#waiting = null; }
    }
    this.#buffer.push(d); this.#bufferRows += d.b.length + d.a.length; this.#lastSeq = Math.max(this.#lastSeq, d.seq);
    while (this.#buffer.length > this.#bufferMax || (this.#bufferRows > this.#bufferRowsMax && this.#buffer.length > 1)) { const old = this.#buffer.shift()!; this.#bufferRows -= old.b.length + old.a.length; }
    const waiting = this.#waiting;
    if (waiting && d.u >= waiting.u) { this.#waiting = null; return this.#seedFrom(waiting, 0) === 'seeded' ? 'none' : 'snapshot'; }
    return lost ? 'snapshot' : 'none';
  }

  /** Bybit's seeding rule: the snapshot is taken only on a held delta with its own `(seq, u)`; every delta after it must have a larger `seq`. */
  #seedFrom(s: FullSnapshot, now: number): SnapshotResult {
    const buffer = this.#buffer, first = buffer[0], last = buffer[buffer.length - 1];
    // Ahead of everything held (or nothing held yet): wait for the stream to reach it.
    if (!first || !last || s.u > last.u) { this.#waiting = s; return 'wait'; }
    // Behind the first delta held: its anchor is gone.
    if (s.u < first.u) return 'retry';
    const anchor = buffer[s.u - first.u]!;
    if (anchor.u !== s.u || anchor.seq !== s.seq) return 'retry';
    const after = buffer.slice(s.u - first.u + 1);
    if (after.some(d => d.seq <= s.seq)) return 'retry';
    const book = this.#build(s);
    for (const d of after) applyRows(book, d);
    this.bids = book.bids; this.asks = book.asks; this.#bid = book.bid; this.#ask = book.ask; this.coverageEpoch++;
    this.u = last.u; this.seq = last.seq; this.#lastSeq = Math.max(this.#lastSeq, last.seq);
    this.#live = true; this.lastFault = null; this.disagreements = 0; this.appliedAt = Math.max(this.appliedAt, now);
    this.#buffer = []; this.#bufferRows = 0; this.#waiting = null; this.#recent = [anchor, ...after].slice(-this.#recentMax);
    return 'seeded';
  }

  /**
   * A refresh snapshot at or behind the live book: anchored on the live book's own `(seq, u)` (or on a recent delta's), caught up with the
   * deltas since by its own frontiers, and its levels beyond the live frontiers added in place. Inside the live window nothing changes.
   */
  #finishRefresh(s: FullSnapshot, now: number): SnapshotResult {
    const recent = this.#recent, first = recent[0];
    let after: FullDelta[];
    if (s.u === this.u) { if (s.seq !== this.seq) { this.failRefresh(now); return 'rejected'; } after = []; }
    else {
      // The anchor must still be among the recent deltas (contiguous by `u`, ending at the live `u`).
      const anchor = first && s.u >= first.u ? recent[s.u - first.u] : undefined;
      if (!anchor || anchor.u !== s.u || anchor.seq !== s.seq) { this.failRefresh(now); return 'rejected'; }
      after = recent.slice(s.u - first!.u + 1);
    }
    const book = this.#build(s);
    for (const d of after) applyRows(book, d);
    // Disagreements inside both windows are counted (the stream-kept levels stay); coverage past the live frontiers is added.
    this.disagreements = differences(this.bids, book.bids, this.#bid.frontier, book.bid.frontier, true) + differences(this.asks, book.asks, this.#ask.frontier, book.ask.frontier, false);
    const mid = midOf(this.bids, this.asks);
    let grew = false;
    const bidEdge = this.#bid.frontier, newBid = book.bid.frontier;
    if (bidEdge !== null && newBid !== null && newBid < bidEdge) {
      const floor = mid > 0 ? Math.max(newBid, mid * (1 - GUARD)) : newBid;
      if (floor < bidEdge) { for (const [p, q] of book.bids) if (p < bidEdge && p >= floor) this.bids.set(p, q); this.#bid = { ...this.#bid, frontier: floor }; grew = true; }
    }
    const askEdge = this.#ask.frontier, newAsk = book.ask.frontier;
    if (askEdge !== null && newAsk !== null && newAsk > askEdge) {
      const ceiling = mid > 0 ? Math.min(newAsk, mid * (1 + GUARD)) : newAsk;
      if (ceiling > askEdge) { for (const [p, q] of book.asks) if (p > askEdge && p <= ceiling) this.asks.set(p, q); this.#ask = { ...this.#ask, frontier: ceiling }; grew = true; }
    }
    // What the next refresh is judged against: the distances now, and the snapshot's own counts.
    this.#bid = { ...this.#bid, seedDistance: this.#bid.frontier !== null && mid > 0 ? mid - this.#bid.frontier : this.#bid.seedDistance, levels: Math.max(this.#bid.levels, s.b.length) };
    this.#ask = { ...this.#ask, seedDistance: this.#ask.frontier !== null && mid > 0 ? this.#ask.frontier - mid : this.#ask.seedDistance, levels: Math.max(this.#ask.levels, s.a.length) };
    if (!grew) { this.failRefresh(now); return 'unchanged'; }
    this.coverageEpoch++;
    this.#refresh = null; this.#refreshFailures = 0; this.#nextRefreshAt = now + REFRESH_MIN_MS;
    return 'extended';
  }

  /** A snapshot's sides with their frontiers (each side's deepest price), cut at `GUARD` of its mid. */
  #build(s: FullSnapshot): { bids: Side; asks: Side; bid: Coverage; ask: Coverage } {
    const bids = this.#makeSide(), asks = this.#makeSide();
    const mid = s.b.length && s.a.length ? (s.b[0]![0] + s.a[0]![0]) / 2 : NaN;
    const low = mid > 0 ? mid * (1 - GUARD) : -Infinity, high = mid > 0 ? mid * (1 + GUARD) : Infinity;
    for (const [p, q] of s.b) if (p >= low) bids.set(p, q);
    for (const [p, q] of s.a) if (p <= high) asks.set(p, q);
    // Beyond the cut nothing is kept (the linear book's asks run to a billion), and the frontier moves in to it: inside, the side is whole.
    const bidEdge = s.b.length ? Math.max(s.b[s.b.length - 1]![0], low) : null, askEdge = s.a.length ? Math.min(s.a[s.a.length - 1]![0], high) : null;
    return {
      bids, asks,
      bid: { frontier: bidEdge, seedDistance: bidEdge !== null && mid > 0 ? mid - bidEdge : 0, levels: s.b.length },
      ask: { frontier: askEdge, seedDistance: askEdge !== null && mid > 0 ? askEdge - mid : 0, levels: s.a.length },
    };
  }

  /** A delta onto the live sides; kept whole among the recent ones (before any frontier filter) for a refresh to be caught up with. */
  #apply(d: FullDelta, now: number): void {
    applyRows({ bids: this.bids, asks: this.asks, bid: this.#bid, ask: this.#ask }, d);
    this.u = d.u; this.seq = d.seq; this.#lastSeq = Math.max(this.#lastSeq, d.seq); this.appliedAt = now;
    this.#recent.push(d); if (this.#recent.length > this.#recentMax) this.#recent.shift();
  }

  /** The book is no longer the venue's: withdrawn, a new epoch, `d` starts the new buffer, and a snapshot is wanted (or a new socket). */
  #restart(d: FullDelta, reason: string, now: number): FullAction {
    this.#withdraw(reason);
    this.#buffer = [d]; this.#bufferRows = d.b.length + d.a.length; this.#lastSeq = d.seq;
    return this.#counted(now);
  }
  /** One more resynchronisation: a snapshot is wanted, or a new socket when this is the third within a minute. */
  #counted(now: number): FullAction {
    this.#resyncs = this.#resyncs.filter(t => now - t < RESYNC_WINDOW_MS); this.#resyncs.push(now);
    return this.#resyncs.length >= RESYNC_LIMIT ? 'reconnect' : 'snapshot';
  }
  #withdraw(reason: string | null): void {
    this.#live = false; this.epoch++; this.u = 0; this.seq = 0; this.lastFault = reason;
    this.bids = this.#makeSide(); this.asks = this.#makeSide(); this.coverageEpoch++;
    this.#waiting = null; this.#refresh = null; this.#recent = [];
    this.#bid = noCoverage(); this.#ask = noCoverage();
  }
}

const noCoverage = (): Coverage => ({ frontier: null, seedDistance: 0, levels: 0 });

/** A delta's rows inside the frontiers. */
function applyRows(book: { bids: Side; asks: Side; bid: Coverage; ask: Coverage }, d: FullDelta): void {
  const bidEdge = book.bid.frontier, askEdge = book.ask.frontier, bids = book.bids, asks = book.asks;
  for (const [p, q] of d.b) { if (bidEdge !== null && p < bidEdge) continue; if (q > 0) bids.set(p, q); else bids.delete(p); }
  for (const [p, q] of d.a) { if (askEdge !== null && p > askEdge) continue; if (q > 0) asks.set(p, q); else asks.delete(p); }
}

/** Levels on which two sides disagree inside both their frontiers (a size that differs, or a level only one of them has). */
function differences(live: Side, snap: Side, liveEdge: number | null, snapEdge: number | null, isBid: boolean): number {
  const inside = (p: number): boolean => isBid ? (liveEdge === null || p >= liveEdge) && (snapEdge === null || p >= snapEdge) : (liveEdge === null || p <= liveEdge) && (snapEdge === null || p <= snapEdge);
  let n = 0;
  for (const [p, q] of snap) if (inside(p) && live.get(p) !== q) n++;
  for (const p of live.keys()) if (inside(p) && !snap.has(p)) n++;
  return n;
}

/** The mid of the best bid and ask (NaN when a side is empty). One pass over each side: used only when a refresh is caught up. */
function midOf(bids: Side, asks: Side): number {
  let bid = -Infinity, ask = Infinity;
  for (const p of bids.keys()) if (p > bid) bid = p;
  for (const p of asks.keys()) if (p < ask) ask = p;
  return Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : NaN;
}
