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
 *
 * Auditing the seed. About one linear answer in twenty (measured 2026-11-11: 4 of 66 matched checks, BTC and ETH; no spot answer) is
 * degraded: whole near the price (about 6.5 %), but beyond it holding only some 40 % of the levels, while still reaching the true deepest
 * prices, so nothing in the answer itself shows it. A book seeded from one would stay sparse far out for good (the stream names only the
 * levels that change). So every seed is followed, `AUDIT_DELAY_MS` later, by a second snapshot caught up to the same `(seq, u)` and compared
 * inside both windows: one side missing many levels the other has, and not the reverse, is the degraded one. A degraded live book is
 * replaced by the audit's (`repaired`); a degraded audit is ignored; two answers each missing many of the other's levels mean another audit.
 * The same comparison keeps a degraded snapshot from extending the coverage, and an extension (or a repair) is audited in turn: what a
 * refresh adds past the old frontiers was checked against nothing.
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
/** Bybit's numbers in a book: plain decimal strings (all 622,352 of seven full answers, 2026-11-11), no sign, no exponent. */
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
/** At most this many rows in one delta (Bybit's carry a few hundred at most): more is a protocol fault, not a book. */
export const MAX_FRAME_ROWS = 50_000;
/**
 * Rows `[price, size]` as Bybit sends them: two decimal strings (`DECIMAL`; a number, a null or anything else is no row), read with
 * `Number`. A price above zero, a size of zero or more (zero deletes, in a delta). One bad row makes the whole list unreadable (null): a
 * frame is applied whole or not at all, never with a row skipped while its `u` is taken. A price named twice in one delta: the later row
 * wins.
 */
function rowsOf(value: unknown, allowZero: boolean): [number, number][] | null {
  if (!Array.isArray(value)) return null;
  const out: [number, number][] = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const row = value[i];
    if (!Array.isArray(row) || row.length < 2) return null;
    const p = row[0], s = row[1];
    if (typeof p !== 'string' || typeof s !== 'string' || !DECIMAL.test(p) || !DECIMAL.test(s)) return null;
    const price = Number(p), size = Number(s);
    if (!(price > 0) || !Number.isFinite(price) || !Number.isFinite(size) || (!allowZero && size === 0)) return null;
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
  if (u === null || u < 1 || seq === null || !b || !a || b.length + a.length > MAX_FRAME_ROWS) return 'bad';
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
 * The answer to a snapshot: `seeded` (the book is live), `extended` (a refresh added coverage), `repaired` (an audit or refresh found the
 * live book degraded and replaced it), `unchanged` (a refresh added nothing),
 * `retry` (read another: behind the stream, or not anchored), `wait` (kept until the stream reaches it), `stale` (asked for in an earlier
 * epoch, or no longer wanted), `rejected` (a refresh that cannot be caught up with the live book).
 */
export type SnapshotResult = 'seeded' | 'extended' | 'repaired' | 'unchanged' | 'retry' | 'wait' | 'stale' | 'rejected';

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
/**
 * A side's snapshot is a full answer when it holds at least this share of the levels the side's frontier was set from: a perpetual's
 * answers vary by well under 1 % (30,861 to 30,981 bid levels on BTC, 2026-11-11), spot's are the cap every time, and one cut to its
 * nearest levels (to the cap, on a perpetual of 30,000) holds far fewer. Only a full answer renews what a side is judged to reach.
 */
export const FULL_SHARE = 0.9;
/** The audit after a seed is read this long after it (once the stream has run a little). */
export const AUDIT_DELAY_MS = 10_000;
/**
 * A snapshot is degraded against another (both at the same `(seq, u)`) when it lacks at least `DEGRADED_MIN` levels the other has inside
 * both windows, at least `DEGRADED_SHARE` of the other's levels there, while the other lacks no more than `ONE_WAY` as many of its own. The
 * replicas' ordinary disagreement is a few levels; a degraded answer lacks thousands.
 */
export const DEGRADED_MIN = 200, DEGRADED_SHARE = 0.02, ONE_WAY = 0.1;
/** A refresh snapshot ahead of the live book waits this long for the stream to reach it (frames come every 5 s at most). */
export const ANCHOR_WAIT_MS = 10_000;
/** Three resynchronisations within a minute mean the socket itself is bad. */
const RESYNC_LIMIT = 3, RESYNC_WINDOW_MS = 60_000;
/**
 * Coverage epochs come from one counter for every book in this thread, so a book made anew for the same instrument (a connector
 * replaced) never repeats a number an earlier one published: a reader comparing the instrument over time always sees the change.
 */
let coverageCount = 0;
const nextCoverage = (): number => ++coverageCount;

export interface FullBookOptions {
  /** How a side is made (the connector's sides keep a sorted copy for valuation, shared/connector.ts). */
  makeSide?: () => Side;
  /** Deltas held while a snapshot is read (5 minutes at Bybit's 200 ms); past it the oldest go, so a slow snapshot is read again. */
  bufferMax?: number;
  /** Delta rows held at most in that buffer (a busy book sends a hundred a frame): past it the oldest frames go too. */
  bufferRowsMax?: number;
  /** Deltas applied recently, kept whole for catching a refresh snapshot up with the live book (30 s at 200 ms). */
  recentMax?: number;
  /** Rows held at most among those recent deltas: past it the oldest go (a refresh whose anchor went with them is rejected). */
  recentRowsMax?: number;
  /** How long after a seed its audit is read (`AUDIT_DELAY_MS`; a test's fast-changing book uses less). */
  auditDelayMs?: number;
  /** The levels a side a snapshot holds at most (`SNAPSHOT_CAP`; a test's small book uses less). */
  snapshotCap?: number;
  /** The fewest missing levels that make a snapshot degraded (`DEGRADED_MIN`; small books in tests use fewer). */
  degradedMin?: number;
}

/**
 * What is known of one side: the frontier (the deepest price inside which the side is whole; null only for a book with neither side),
 * how far the venue's snapshots reach on this side (from their own middle to their frontier, as a share of that middle: measured from
 * the snapshot alone, set at the seed and a repair, then renewed by every full answer that passes the comparison: one holding at least
 * `FULL_SHARE` of the levels its side was set from, so an answer cut to its nearest levels, even to the cap, never shortens it), and
 * how many levels the snapshot that set the frontier had on this side.
 */
interface Coverage { frontier: number | null; reach: number; levels: number }

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
  /**
   * A new number whenever what the book covers changes (a seed, a repair, a withdrawal, an extension; unique across books, `nextCoverage`):
   * what compares the book over time starts again. 0 before the first.
   */
  coverageEpoch = 0;
  /** When the last delta was applied or the book seeded (the book's own freshness: trades say nothing about it). */
  appliedAt = 0;
  /**
   * When the book last made progress: a delta applied or held for a snapshot, or a seed. The book channel's deadline is judged on it
   * (shared/venues.ts): frames that only repeat what is held (a `u` already applied) are no progress.
   */
  progressAt = 0;
  /**
   * How the last refresh snapshot disagreed with the stream-kept book inside both windows: levels only it had, levels only the live book
   * had, sizes that differed (the live book keeps its own, unless it was found degraded).
   */
  disagreements = { snapshotOnly: 0, liveOnly: 0, sizes: 0 };
  #live = false;
  #lastSeq = 0;
  #buffer: FullDelta[] = []; #bufferRows = 0;
  /** A snapshot ahead of everything held, waiting for the stream to reach its anchor. */
  #waiting: FullSnapshot | null = null;
  /** The deltas applied most recently, whole and contiguous by `u`, for catching a refresh snapshot up with the live book. */
  #recent: FullDelta[] = [];
  #bid: Coverage = noCoverage(); #ask: Coverage = noCoverage();
  /** A refresh under way, and a snapshot of it ahead of the live book waiting for the book to reach it. */
  /** The refresh being read: its snapshot when it is ahead of the book, since when, and whether it was asked for as the audit. */
  #refresh: { waiting: FullSnapshot | null; since: number; audit: boolean } | null = null;
  #nextRefreshAt = 0; #refreshFailures = 0;
  /** When the audit of the current seed is due (0: none pending). */
  #auditAt = 0;
  #resyncs: number[] = [];
  /** Why the book last stopped being live (for the status line). */
  lastFault: string | null = null;
  readonly #makeSide: () => Side; readonly #bufferMax: number; readonly #bufferRowsMax: number; readonly #recentMax: number; readonly #degradedMin: number;
  readonly #recentRowsMax: number; readonly #auditDelayMs: number; readonly #snapshotCap: number;
  #recentRows = 0;

  constructor(options: FullBookOptions = {}) {
    this.#makeSide = options.makeSide ?? (() => new Map());
    this.#bufferMax = options.bufferMax ?? 1_500; this.#bufferRowsMax = options.bufferRowsMax ?? 300_000; this.#recentMax = options.recentMax ?? 150;
    this.#degradedMin = options.degradedMin ?? DEGRADED_MIN;
    this.#recentRowsMax = options.recentRowsMax ?? 100_000; this.#auditDelayMs = options.auditDelayMs ?? AUDIT_DELAY_MS;
    this.#snapshotCap = options.snapshotCap ?? SNAPSHOT_CAP;
    this.bids = this.#makeSide(); this.asks = this.#makeSide();
  }

  /** Synchronised: the sides are the venue's book at `(seq, u)`, whole inside the frontiers. */
  get live(): boolean { return this.#live; }
  /** The frontier of each side (null: none, the side came empty). */
  get frontiers(): { bid: number | null; ask: number | null } { return { bid: this.#bid.frontier, ask: this.#ask.frontier }; }
  /** A refresh is being read. */
  get refreshing(): boolean { return this.#refresh !== null; }
  /** The seed's audit has not been passed yet. */
  get auditing(): boolean { return this.#auditAt > 0; }
  /** A snapshot is waiting for the stream to reach its anchor. */
  get waiting(): boolean { return this.#waiting !== null; }
  /** Deltas held for the snapshot (for tests and the status line). */
  get buffered(): number { return this.#buffer.length; }

  /** The mid of the live book's best bid and ask (NaN when a side is empty): one pass over each side, for the occasional refresh check. */
  mid(): number { return midOf(this.bids, this.asks); }

  /** A new connection: everything is forgotten (its deltas will be held for a new snapshot). */
  reset(): void {
    this.#withdraw(null);
    this.#buffer = []; this.#bufferRows = 0; this.#lastSeq = 0; this.#resyncs = []; this.#refreshFailures = 0; this.#nextRefreshAt = 0;
  }

  /** One delta from the stream, in arrival order. */
  delta(d: FullDelta, now: number): FullAction {
    // A new numbering comes first: what is held belongs to the old one, and this delta starts the new buffer.
    if (d.u === 1 && (this.#live || this.#buffer.length > 0 || this.#waiting)) return this.#restart(d, 'numbering restarted (u = 1)', now);
    if (!this.#live) return this.#hold(d, now);
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
    // What follows the bad frame is judged on its own: an old watermark would discard valid frames of a numbering that started again.
    this.#buffer = []; this.#bufferRows = 0; this.#lastSeq = 0;
    return this.#counted(now);
  }

  /** The answer to a snapshot asked for in `epoch` (a seed while not live, a refresh while live). */
  snapshot(s: FullSnapshot, epoch: number, now: number): SnapshotResult {
    if (epoch !== this.epoch) return 'stale';
    // An answer with no level on either side is no book to seed from: it gives no middle for a cut, so its frontiers would stay open
    // and every delta row, to a billion, would be kept. Read again (paced like any retry).
    if (!this.#live) return s.b.length || s.a.length ? this.#seedFrom(s, now) : 'retry';
    if (!this.#refresh || this.#refresh.waiting) return 'stale';
    if (s.u > this.u) { this.#refresh.waiting = s; this.#refresh.since = now; return 'wait'; }
    return this.#finishRefresh(s, now);
  }

  /**
   * Whether a refresh should be read now, at `mid` (the last traded price): a frontier inside the band that the price has come a quarter
   * of the way toward, or crossed (directed distances: a jump past a frontier counts), or one on a side whose snapshot held fewer than
   * Bybit's 10,000 levels (an answer that may have come cut short: refreshed once a minute at most, then less and less often while that adds
   * nothing). And the seed's audit, `AUDIT_DELAY_MS` after it, whatever the price.
   */
  refreshDue(mid: number, now: number): boolean {
    // A refresh snapshot ahead of the book that the stream has not reached in `ANCHOR_WAIT_MS` is given up (and paused like a failure).
    if (this.#refresh?.waiting && now - this.#refresh.since > ANCHOR_WAIT_MS) this.failRefresh(now);
    if (!this.#live || this.#refresh || now < this.#nextRefreshAt) return false;
    if (this.#auditAt && now >= this.#auditAt) return true;
    // A side left with no level inside its frontier (its last ones deleted, new ones past it left out) gives no mid to judge by and
    // draws nothing: it is due (paced like any refresh), and the refresh brings back what lies past the frontier.
    if (this.bids.size === 0 || this.asks.size === 0) return true;
    if (!(mid > 0)) return false;
    // Inside the band, a frontier is refreshed once what is left of it is a quarter short of what a snapshot reaches, at once when the
    // snapshot that set it ran short of the cap (the whole side), or at once when snapshots reach past the band (cut at the guard: the
    // perpetual's, which the band passes after a move of a fifteenth). What a snapshot reaches is the venue's, never the live book's, so
    // no refresh (an audit, one that added nothing, one from before a move) can make a frontier the band needs look covered.
    const due = (c: Coverage, left: number): boolean => c.frontier !== null && left < mid * BAND && (left <= c.reach * mid * (1 - REFRESH_USED) || c.levels < this.#snapshotCap || c.reach >= BAND);
    return due(this.#bid, this.#bid.frontier === null ? Infinity : mid - this.#bid.frontier) || due(this.#ask, this.#ask.frontier === null ? Infinity : this.#ask.frontier - mid);
  }
  /** A refresh is being read for the current epoch: the connector asks for the snapshot and hands the answer to `snapshot`. */
  beginRefresh(now: number): number { this.#refresh = { waiting: null, since: now, audit: this.#auditAt > 0 && now >= this.#auditAt }; this.#nextRefreshAt = now + REFRESH_MIN_MS; return this.epoch; }
  /** The refresh's request failed (or added nothing): the live book stays, the next try waits longer. */
  failRefresh(now: number, epoch: number = this.epoch): void {
    // A failure of a request made for an earlier epoch (the book was seeded again since) is not this book's: its audit is not held back.
    if (epoch !== this.epoch) return;
    this.#refresh = null; this.#refreshFailures++;
    this.#nextRefreshAt = now + Math.min(REFRESH_MAX_BACKOFF_MS, REFRESH_MIN_MS * 2 ** (this.#refreshFailures - 1));
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------------

  /** Hold a delta while not live; a snapshot waiting for the stream is judged once the stream reaches it. */
  #hold(d: FullDelta, now: number): FullAction {
    const last = this.#buffer[this.#buffer.length - 1];
    let lost = false;
    if (last) {
      if (d.u <= last.u) return 'none';
      if (d.seq < this.#lastSeq) return 'none';
      // A gap inside the buffer: Bybit's procedure starts holding again from here. A waiting snapshot can no longer be anchored.
      if (d.u !== last.u + 1) { this.#buffer = []; this.#bufferRows = 0; lost = this.#waiting !== null; this.#waiting = null; }
    }
    this.#buffer.push(d); this.#bufferRows += d.b.length + d.a.length; this.#lastSeq = Math.max(this.#lastSeq, d.seq); this.progressAt = now;
    while (this.#buffer.length > this.#bufferMax || (this.#bufferRows > this.#bufferRowsMax && this.#buffer.length > 1)) { const old = this.#buffer.shift()!; this.#bufferRows -= old.b.length + old.a.length; }
    const waiting = this.#waiting;
    if (waiting && d.u >= waiting.u) { this.#waiting = null; return this.#seedFrom(waiting, now) === 'seeded' ? 'none' : 'snapshot'; }
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
    this.bids = book.bids; this.asks = book.asks; this.#bid = book.bid; this.#ask = book.ask; this.coverageEpoch = nextCoverage();
    this.u = last.u; this.seq = last.seq; this.#lastSeq = Math.max(this.#lastSeq, last.seq);
    this.#live = true; this.lastFault = null; this.disagreements = { snapshotOnly: 0, liveOnly: 0, sizes: 0 }; this.appliedAt = now; this.progressAt = now;
    // A new seed is new coverage: the refresh pauses of the book before it do not hold its audit back (a late audit finds a degraded seed
    // already half healed by the stream, below what shows it).
    this.#auditAt = now + this.#auditDelayMs; this.#refreshFailures = 0; this.#nextRefreshAt = 0;
    this.#buffer = []; this.#bufferRows = 0; this.#waiting = null; this.#recent = []; this.#recentRows = 0;
    for (const d of [anchor, ...after]) this.#remember(d);
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
    // Compared inside both windows, at the same (seq, u).
    const bid = differences(this.bids, book.bids, this.#bid.frontier, book.bid.frontier, true), ask = differences(this.asks, book.asks, this.#ask.frontier, book.ask.frontier, false);
    const d = { snapshotOnly: bid.snapshotOnly + ask.snapshotOnly, liveOnly: bid.liveOnly + ask.liveOnly, sizes: bid.sizes + ask.sizes };
    this.disagreements = d;
    const many = (missing: number, of: number, other: number): boolean => missing >= Math.max(this.#degradedMin, DEGRADED_SHARE * of) && other <= ONE_WAY * missing;
    if (many(d.snapshotOnly, bid.snapshotLevels + ask.snapshotLevels, d.liveOnly)) {
      // The live book lacks many levels the snapshot has, and not the reverse: it was seeded from a degraded answer. The snapshot, caught up
      // to the same (seq, u), becomes the book.
      this.bids = book.bids; this.asks = book.asks; this.#bid = book.bid; this.#ask = book.ask; this.coverageEpoch = nextCoverage();
      // The repaired book is audited in turn (a snapshot less degraded than the live book is still not known whole).
      this.#auditAt = now + this.#auditDelayMs; this.#refresh = null; this.#refreshFailures = 0; this.#nextRefreshAt = now + REFRESH_MIN_MS;
      return 'repaired';
    }
    if (many(d.liveOnly, bid.liveLevels + ask.liveLevels, d.snapshotOnly)) {
      // The snapshot is the degraded one: nothing is taken from it, and the live book has passed its audit.
      this.#auditAt = 0; this.failRefresh(now); return 'unchanged';
    }
    if (d.snapshotOnly >= this.#degradedMin && d.liveOnly >= this.#degradedMin) {
      // Each lacks many of the other's levels: which is whole is not known. Nothing is taken, and another audit follows (after the pause).
      this.#auditAt = now; this.failRefresh(now); return 'unchanged';
    }
    // The two agree (a replica's few levels aside). An audit is passed and only checks: it adds nothing past the live frontiers, or a
    // frontier at the guard's cut (the perpetual's, whose snapshot runs far past it) would move with the mid at every audit, each move an
    // extension audited again: the whole book read every minute, and a new coverage epoch each time. A refresh asked for by the frontiers
    // adds the coverage past them.
    const audit = this.#auditAt > 0, asked = this.#refresh?.audit === true;
    this.#auditAt = 0;
    const mid = midOf(this.bids, this.asks);
    let bidGrew = false, askGrew = false;
    const bidEdge = this.#bid.frontier, newBid = book.bid.frontier;
    if (!asked && bidEdge !== null && newBid !== null && newBid < bidEdge) {
      const floor = mid > 0 ? Math.max(newBid, mid * (1 - GUARD)) : newBid;
      if (floor < bidEdge) { for (const [p, q] of book.bids) if (p < bidEdge && p >= floor) this.bids.set(p, q); this.#bid = { ...this.#bid, frontier: floor }; bidGrew = true; }
    }
    const askEdge = this.#ask.frontier, newAsk = book.ask.frontier;
    if (!asked && askEdge !== null && newAsk !== null && newAsk > askEdge) {
      const ceiling = mid > 0 ? Math.min(newAsk, mid * (1 + GUARD)) : newAsk;
      if (ceiling > askEdge) { for (const [p, q] of book.asks) if (p > askEdge && p <= ceiling) this.asks.set(p, q); this.#ask = { ...this.#ask, frontier: ceiling }; askGrew = true; }
    }
    const grew = bidGrew || askGrew;
    // What the next refresh is judged against: this snapshot's reach on a side where it is a full answer (it passed the comparison, audit
    // or not; one cut to its nearest levels holds far fewer and says nothing of what lies past them), and the count of a side whose
    // frontier it set (an audit, or a side it did not extend, cut nothing from it: a short side stays short).
    const full = (rows: number, levels: number): boolean => rows >= FULL_SHARE * levels;
    this.#bid = { ...this.#bid, reach: full(s.b.length, this.#bid.levels) ? book.bid.reach : this.#bid.reach, levels: bidGrew ? s.b.length : this.#bid.levels };
    this.#ask = { ...this.#ask, reach: full(s.a.length, this.#ask.levels) ? book.ask.reach : this.#ask.reach, levels: askGrew ? s.a.length : this.#ask.levels };
    // A passed audit that adds nothing is no failed refresh: the next one waits only the usual minute.
    if (!grew && audit) { this.#refresh = null; this.#nextRefreshAt = now + REFRESH_MIN_MS; return 'unchanged'; }
    if (!grew) { this.failRefresh(now); return 'unchanged'; }
    this.coverageEpoch = nextCoverage();
    // What was added past the old frontiers was checked against nothing (the live book did not reach there): a degraded answer can agree
    // inside the window and bring a sparse tail. The widened book is audited like a seed, AUDIT_DELAY_MS on, against a fresh snapshot.
    this.#auditAt = now + this.#auditDelayMs;
    this.#refresh = null; this.#refreshFailures = 0; this.#nextRefreshAt = now + REFRESH_MIN_MS;
    return 'extended';
  }

  /**
   * A snapshot's sides with their frontiers (each side's deepest price), cut at `GUARD` of its middle: its mid, or the best price of its
   * one side when the other came empty (that side is then whole, and empty, out to the cut, so no delta past it is taken either).
   */
  #build(s: FullSnapshot): { bids: Side; asks: Side; bid: Coverage; ask: Coverage } {
    const bids = this.#makeSide(), asks = this.#makeSide();
    const center = s.b.length && s.a.length ? (s.b[0]![0] + s.a[0]![0]) / 2 : s.b.length ? s.b[0]![0] : s.a.length ? s.a[0]![0] : NaN;
    const low = center > 0 ? center * (1 - GUARD) : -Infinity, high = center > 0 ? center * (1 + GUARD) : Infinity;
    for (const [p, q] of s.b) if (p >= low) bids.set(p, q);
    for (const [p, q] of s.a) if (p <= high) asks.set(p, q);
    // Beyond the cut nothing is kept (the linear book's asks run to a billion), and the frontier moves in to it: inside, the side is whole.
    const bidEdge = s.b.length ? Math.max(s.b[s.b.length - 1]![0], low) : center > 0 ? low : null;
    const askEdge = s.a.length ? Math.min(s.a[s.a.length - 1]![0], high) : center > 0 ? high : null;
    return {
      bids, asks,
      bid: { frontier: bidEdge, reach: bidEdge !== null && center > 0 ? (center - bidEdge) / center : 0, levels: s.b.length },
      ask: { frontier: askEdge, reach: askEdge !== null && center > 0 ? (askEdge - center) / center : 0, levels: s.a.length },
    };
  }

  /** A delta onto the live sides; kept whole among the recent ones (before any frontier filter) for a refresh to be caught up with. */
  #apply(d: FullDelta, now: number): void {
    applyRows({ bids: this.bids, asks: this.asks, bid: this.#bid, ask: this.#ask }, d);
    this.u = d.u; this.seq = d.seq; this.#lastSeq = Math.max(this.#lastSeq, d.seq); this.appliedAt = now; this.progressAt = now;
    this.#remember(d);
  }
  /** One delta among the recent ones, the oldest let go past `recentMax` frames or `recentRowsMax` rows. */
  #remember(d: FullDelta): void {
    this.#recent.push(d); this.#recentRows += d.b.length + d.a.length;
    while (this.#recent.length > this.#recentMax || (this.#recentRows > this.#recentRowsMax && this.#recent.length > 1)) { const old = this.#recent.shift()!; this.#recentRows -= old.b.length + old.a.length; }
  }

  /** The book is no longer the venue's: withdrawn, a new epoch, `d` starts the new buffer, and a snapshot is wanted (or a new socket). */
  #restart(d: FullDelta, reason: string, now: number): FullAction {
    this.#withdraw(reason);
    this.#buffer = [d]; this.#bufferRows = d.b.length + d.a.length; this.#lastSeq = d.seq; this.progressAt = now;
    return this.#counted(now);
  }
  /** One more resynchronisation: a snapshot is wanted, or a new socket when this is the third within a minute. */
  #counted(now: number): FullAction {
    this.#resyncs = this.#resyncs.filter(t => now - t < RESYNC_WINDOW_MS); this.#resyncs.push(now);
    return this.#resyncs.length >= RESYNC_LIMIT ? 'reconnect' : 'snapshot';
  }
  #withdraw(reason: string | null): void {
    this.#live = false; this.epoch++; this.u = 0; this.seq = 0; this.lastFault = reason;
    this.bids = this.#makeSide(); this.asks = this.#makeSide(); this.coverageEpoch = nextCoverage();
    this.#waiting = null; this.#refresh = null; this.#recent = []; this.#recentRows = 0; this.#auditAt = 0;
    this.#bid = noCoverage(); this.#ask = noCoverage();
  }
}

const noCoverage = (): Coverage => ({ frontier: null, reach: 0, levels: 0 });

/** A delta's rows inside the frontiers. */
function applyRows(book: { bids: Side; asks: Side; bid: Coverage; ask: Coverage }, d: FullDelta): void {
  const bidEdge = book.bid.frontier, askEdge = book.ask.frontier, bids = book.bids, asks = book.asks;
  for (const [p, q] of d.b) { if (bidEdge !== null && p < bidEdge) continue; if (q > 0) bids.set(p, q); else bids.delete(p); }
  for (const [p, q] of d.a) { if (askEdge !== null && p > askEdge) continue; if (q > 0) asks.set(p, q); else asks.delete(p); }
}

/** How two sides disagree inside both frontiers: levels only the snapshot has, only the live side has, sizes that differ; and how many levels each has there. */
function differences(live: Side, snap: Side, liveEdge: number | null, snapEdge: number | null, isBid: boolean): { snapshotOnly: number; liveOnly: number; sizes: number; snapshotLevels: number; liveLevels: number } {
  const inside = (p: number): boolean => isBid ? (liveEdge === null || p >= liveEdge) && (snapEdge === null || p >= snapEdge) : (liveEdge === null || p <= liveEdge) && (snapEdge === null || p <= snapEdge);
  let snapshotOnly = 0, liveOnly = 0, sizes = 0, snapshotLevels = 0, liveLevels = 0;
  for (const [p, q] of snap) { if (!inside(p)) continue; snapshotLevels++; const mine = live.get(p); if (mine === undefined) snapshotOnly++; else if (mine !== q) sizes++; }
  for (const p of live.keys()) { if (!inside(p)) continue; liveLevels++; if (!snap.has(p)) liveOnly++; }
  return { snapshotOnly, liveOnly, sizes, snapshotLevels, liveLevels };
}

/** The mid of the best bid and ask (NaN when a side is empty). One pass over each side: used only when a refresh is caught up. */
function midOf(bids: Side, asks: Side): number {
  let bid = -Infinity, ask = Infinity;
  for (const p of bids.keys()) if (p > bid) bid = p;
  for (const p of asks.keys()) if (p < ask) ask = p;
  return Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : NaN;
}
