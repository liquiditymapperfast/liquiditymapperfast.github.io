/**
 * The liquidation levels' history (hlm-levels `history.rs`, 2026-11-05): every snapshot HyperTracker made of Hyperliquid's BTC positions,
 * reduced to the long and the short dollars at each distance from that snapshot's own mark in fixed buckets, read a UTC day at a time for
 * the Depth pane's Liquidations view. A snapshot comes about every 29 minutes and describes positions some 35 minutes older than it; a row
 * is placed at the moment the service fetched it (`fetchedAt`), when the page could first have shown it.
 *
 * Plus (2026-11-17) adds three families of files beside the free one, read the same way: the same days of HyperTracker's profitable
 * traders, the stop and take-profit orders' days (only snapshots an order file was read with have a row, about one of two), and
 * for views wider than `MAX_DAYS` days one file a family holding a row per four hours over the whole history (the rollups). A view of
 * liquidations and stops ("both") joins a family's row to the orders' by the snapshot (`createdAt`), so it has a row only where the
 * snapshot has both.
 *
 * What it says is where the money would be liquidated (or the orders would trigger), as the positions stood: not what happened, and not
 * where price will go.
 */
import { DUE_EVERY_MS, MAX_LEAD_MS, ON_TIME_MS, clockSetBack, nextAskAt, placeSnapshot } from './liq-schedule.ts';
import { liqLevelsUrl, plusUrls } from './liq-url.ts';
import { FREE_VIEW, groupApplies, viewKey, type LiqView } from './liq-view.ts';

/**
 * Who may read which days (Plus, `plus/config.ts`): the days from `freeFrom` on are everyone's; an older one is asked for only with a
 * pass, which the server checks. `refused` is told when the server would not take the pass it was sent. The Plus families (groups, orders,
 * rollups) are paid whatever the day: asked for only with a pass.
 */
export interface LiqAccess {
  freeFrom(now: number): number; pass(now: number): string | null; refused(pass: string): void;
  /**
   * Whether Plus is on sale (absent: it is). While it is not, the page closes no day by itself and asks for every one (a member's with the
   * pass all the same); only the gate's refusal closes a day, and the days before it.
   */
  onSale?(): boolean;
}
/** Everything open: a service with no paid part (and the tests of what does not depend on one). */
const OPEN: LiqAccess = { freeFrom: () => -Infinity, pass: () => null, refused: () => {} };
/**
 * What the gate says when it refuses a Plus file (HTTP 403 with `{"error":"plus_required"}`), as the reader throws it. Any other 403 (a
 * firewall's, a rate limit's) is a failed read like the rest: it says nothing about Plus.
 */
export const LIQ_REFUSED = 'plus_required';

/** An answer of the levels service or its gate: its status, its body (JSON, or null), and how long it asked to wait (`Retry-After`, s). */
export interface LiqAnswer { status: number; body: unknown; retryAfter?: number }
/** A read that gives the answer whatever its status (a failure to reach the server rejects): the address, and the pass to send with it. */
export type LiqFetch = (url: string, pass?: string | null) => Promise<LiqAnswer>;
/** A read of the levels service or its gate is given up after this long (a rollup is the largest file, a few MB). */
const READ_TIMEOUT_MS = 30_000;
export const webFetch: LiqFetch = async (url, pass) => {
  const answer = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(READ_TIMEOUT_MS), ...(pass ? { headers: { authorization: `Bearer ${pass}` } } : {}) });
  let body: unknown = null;
  try { body = await answer.json(); } catch { /* a body that is not JSON (a 503's plain text) says nothing more than its status */ }
  const wait = Number(answer.headers.get('retry-after'));
  return { status: answer.status, body, ...(Number.isFinite(wait) && wait > 0 ? { retryAfter: wait } : {}) };
};
/** Whether an answer is the gate's refusal of a Plus file: a 403 whose body is `{"error":"plus_required"}`. */
export const isRefusal = (answer: LiqAnswer): boolean =>
  answer.status === 403 && !!answer.body && typeof answer.body === 'object' && (answer.body as { error?: unknown }).error === LIQ_REFUSED;

/**
 * Whether a failed read was answered for that file by the server: a 4xx other than the gate's refusal and a rate limit (a day the service
 * has no file for). The pass then got through, and the file is not asked again for a while. A 5xx, a 429 or no answer says nothing of the
 * file.
 */
const answeredMissing = (error: unknown): boolean => {
  const status = error instanceof Error && /^\d{3}$/.test(error.message) ? Number(error.message) : 0;
  return status >= 400 && status < 500 && status !== 429;
};

/** A read: the address, and the pass to send with it when the file is a Plus one. It throws `LIQ_REFUSED` for the gate's refusal, else the status (with `retryAfter` where the server said one). */
export type LiqGet = (url: string, pass?: string | null) => Promise<unknown>;
const webRead: LiqGet = async (url, pass) => {
  const answer = await webFetch(url, pass);
  if (answer.status >= 200 && answer.status < 300) return answer.body;
  throw Object.assign(new Error(isRefusal(answer) ? LIQ_REFUSED : String(answer.status)), answer.retryAfter !== undefined ? { retryAfter: answer.retryAfter } : {});
};

const DAY_MS_ = 86_400_000;
export const DAY_MS = DAY_MS_;
/** How often the index (what the service holds) is asked again; a day still being written is asked when its next snapshot can be there (`liq-schedule.ts`). */
const INDEX_EVERY_MS = 5 * 60_000;
/** How often a rollup (a row per four hours, one file for the whole history) is asked again. */
const ROLLUP_EVERY_MS = 30 * 60_000;
/** A failed read waits this long before it is asked again. */
const RETRY_MS = 60_000;
/** A 503's `Retry-After` is kept within these bounds. */
const WAIT_MIN_MS = 30_000, WAIT_MAX_MS = 15 * 60_000;
/**
 * A free day the gate refused (the page's clock and the server's disagree about which days are free) closes the days up to it for this
 * long, then is asked again; and only a day within this much of the page's own boundary is believed: a clock is off by hours or a day,
 * so a refusal of a day far inside the free week is the server's fault, not a boundary.
 */
const REFUSAL_HOLDS_MS = 10 * 60_000, REFUSAL_REACH_MS = 2 * DAY_MS_;
/** At most this many days are held: a view wider than that shows the newest of them, or (with Plus) reads the rollups. */
export const MAX_DAYS = 120;
/** How long a snapshot stands for when no later one comes: about three of their periods (one comes every ~29 minutes); after that, a gap. */
export const LIQ_HOLD_MS = 90 * 60_000;

export interface LiqIndex { edges: readonly number[]; first: number | null; last: number | null }
/**
 * One snapshot: `long[i]` and `short[i]` are the dollars within bucket `i`'s upper edge of the mark (each bucket holds the ones inside it),
 * `longCoin` / `shortCoin` the same in coins, each bucket's dollars over the price at its middle (below the mark for longs, above for shorts).
 */
export interface LiqRow { asOf: number; createdAt: number; fetchedAt: number; mark: number; long: Float32Array; short: Float32Array; longCoin: Float32Array; shortCoin: Float32Array }

/** One part of a history row as the service writes it: its dollars in each bucket (not added up), below the mark (long) and above (short). */
export interface HistPart { long: Float64Array; short: Float64Array }
/** A history row of any family: its snapshot's times and mark, and its parts (free: all positions; groups: the profitable traders; orders: stops, takes). */
export interface HistRow { asOf: number; createdAt: number; fetchedAt: number; mark: number; parts: (HistPart | null)[] }
/** The families of files: all positions (free days, paid before the free week), by group, and the stop and take-profit orders. */
export type LiqFamily = 'free' | 'groups' | 'orders';

/** The history's two addresses beside the levels file's (`…/liquidations.json`), or null when there is no levels service. */
export function historyUrls(levelsUrl: string): { index: string; day: (day: string) => string } | null {
  if (!/\/liquidations\.json$/.test(levelsUrl)) return null;
  const base = levelsUrl.replace(/\/liquidations\.json$/, '/liquidation-history');
  return { index: `${base}.json`, day: (day: string) => `${base}/${day}.json` };
}

/** A UTC day as the service names it (YYYY-MM-DD). */
export const dayText = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Edges ascending positive percentages (1 to 1,000 of them), or null. */
function readEdges(edges: unknown): number[] | null {
  if (!Array.isArray(edges) || edges.length < 1 || edges.length > 1_000) return null;
  for (let i = 0; i < edges.length; i++) if (typeof edges[i] !== 'number' || !(edges[i] > (i ? edges[i - 1] : 0))) return null;
  return edges as number[];
}

/** The index, checked: edges ascending positive percentages (1 to 1,000 of them), first and last times or null. */
export function readIndex(raw: unknown): LiqIndex | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>, edges = readEdges(o.edges);
  if (!edges) return null;
  const time = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
  return { edges, first: time(o.first), last: time(o.last) };
}

/** A part `[beyondLong, beyondShort, long[n], short[n]]` (or the free row's last two fields), checked: dollars finite and not negative. */
function readPart(long: unknown, short: unknown, n: number): HistPart | null {
  if (!Array.isArray(long) || !Array.isArray(short) || long.length !== n || short.length !== n) return null;
  if (!long.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0) || !short.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) return null;
  return { long: Float64Array.from(long as number[]), short: Float64Array.from(short as number[]) };
}

/**
 * A day's (or a rollup's) rows of a family, checked against the buckets (`n` of them): a row of the wrong shape is left out, never drawn.
 * Free: `[asOf, createdAt, fetchedAt, mark, beyondLong, beyondShort, long[n], short[n]]`. Orders: `[asOf, createdAt, fetchedAt, mark, stops,
 * takes]`, a part `[beyondLong, beyondShort, long[n], short[n]]` or null. Groups: the same times and mark, then a part a group, of which only
 * HyperTracker's profitable traders' is read, at its place among the file's `groups` names where it names them (none of them it: no rows),
 * else the first; whatever else a row holds is left unread and never kept. Ordered by fetch time.
 */
export function readHistRows(raw: unknown, n: number, family: LiqFamily): HistRow[] {
  const doc = raw && typeof raw === 'object' ? raw as { rows?: unknown; groups?: unknown } : null, rows = doc?.rows;
  if (!Array.isArray(rows)) return [];
  const names = family === 'groups' && Array.isArray(doc?.groups) ? doc.groups as unknown[] : null, named = names ? names.indexOf('profitable') : 0;
  if (named < 0) return [];
  const at = 4 + named;
  const out: HistRow[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < (family === 'free' ? 8 : family === 'groups' ? at + 1 : 6)) continue;
    const [asOf, createdAt, fetchedAt, mark] = row as unknown[];
    if (![asOf, createdAt, fetchedAt, mark].every(v => typeof v === 'number' && Number.isFinite(v)) || !((mark as number) > 0)) continue;
    let parts: (HistPart | null)[] | null;
    if (family === 'free') { const p = readPart(row[6], row[7], n); parts = p ? [p] : null; }
    else {
      parts = [];
      for (const raw of family === 'groups' ? [row[at]] : [row[4], row[5]]) {
        if (raw === null) { parts.push(null); continue; }
        const p = Array.isArray(raw) && raw.length === 4 ? readPart(raw[2], raw[3], n) : null;
        if (!p) { parts = null; break; }
        parts.push(p);
      }
    }
    if (parts) out.push({ asOf: asOf as number, createdAt: createdAt as number, fetchedAt: fetchedAt as number, mark: mark as number, parts });
  }
  return out.sort((a, b) => a.fetchedAt - b.fetchedAt);
}

/**
 * A row's part added up from the mark outward, in dollars and in coins (each bucket's dollars over the price at its middle). `swap` reads
 * the part's sides the other way round, for take profits: the part's `long` (what closes longs: sells above the mark) becomes the row's
 * short side, above the mark, before the coins are worked out.
 */
export function cumulate(row: Pick<HistRow, 'asOf' | 'createdAt' | 'fetchedAt' | 'mark'>, part: HistPart, edges: readonly number[], swap = false): LiqRow {
  const n = edges.length, mark = row.mark, below = swap ? part.short : part.long, above = swap ? part.long : part.short;
  const cumL = new Float32Array(n), cumS = new Float32Array(n), coinL = new Float32Array(n), coinS = new Float32Array(n);
  let l = 0, s = 0, lc = 0, sc = 0;
  for (let i = 0; i < n; i++) {
    const mid = ((i ? edges[i - 1]! : 0) + edges[i]!) / 200;
    l += below[i]!; s += above[i]!;
    lc += below[i]! / (mark * Math.max(0.01, 1 - mid)); sc += above[i]! / (mark * (1 + mid));
    cumL[i] = l; cumS[i] = s; coinL[i] = lc; coinS[i] = sc;
  }
  return { asOf: row.asOf, createdAt: row.createdAt, fetchedAt: row.fetchedAt, mark, long: cumL, short: cumS, longCoin: coinL, shortCoin: coinS };
}

/** Two parts added bucket by bucket (liquidations and stops: both lie below the mark for longs and above it for shorts). */
export function addParts(a: HistPart, b: HistPart): HistPart {
  const long = new Float64Array(a.long.length), short = new Float64Array(a.short.length);
  for (let i = 0; i < long.length; i++) { long[i] = a.long[i]! + (b.long[i] ?? 0); short[i] = a.short[i]! + (b.short[i] ?? 0); }
  return { long, short };
}

/** A day's rows of all positions, checked against the index's buckets: a row of the wrong shape is left out, never drawn. Ordered by fetch time. */
export function readDay(raw: unknown, edges: readonly number[]): LiqRow[] {
  return readHistRows(raw, edges.length, 'free').map(r => cumulate(r, r.parts[0]!, edges));
}

/** A rollup (`…-4h.json`): its 13 bucket edges, how many hours a row stands for, and its rows. Null when malformed. */
export function readRollup(raw: unknown, family: LiqFamily): { edges: readonly number[]; hours: number; rows: HistRow[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>, edges = readEdges(o.edges), hours = o.hours;
  if (!edges || typeof hours !== 'number' || !(hours > 0 && hours <= 24)) return null;
  return { edges, hours, rows: readHistRows(raw, edges.length, family) };
}

/** The bucket a band of `radius` (a fraction of the price) ends on: the last edge within it, or -1 when the band is narrower than the first bucket. */
export function bandIndex(edges: readonly number[], radius: number): number {
  const pct = radius * 100 * (1 + 1e-9);
  let at = -1;
  for (let i = 0; i < edges.length && edges[i]! <= pct; i++) at = i;
  return at;
}
/** The bucket a band ends on exactly, or -1: a rollup's buckets are wide, so a band between two edges would read a narrower one. */
export function bandOnEdge(edges: readonly number[], radius: number): number {
  const i = bandIndex(edges, radius);
  return i >= 0 && Math.abs(edges[i]! - radius * 100) <= 1e-6 * Math.max(1, radius * 100) ? i : -1;
}

/** The families a view reads, the first being the one its levels come from: its liquidations' (all positions or groups), and the orders' for stops and take profits. */
export function familiesFor(view: LiqView): LiqFamily[] {
  const out: LiqFamily[] = [];
  if (view.kind !== 'stops') out.push(groupApplies(view.kind) && view.group !== 'all' ? 'groups' : 'free');
  if (view.kind !== 'liq' || view.takes) out.push('orders');
  return out;
}

/**
 * What the Depth pane draws for a view over a stretch of time: the rows of its levels in force over it (every row fetched in it, and the last
 * one before it), the take profits' rows where the view shows them, the buckets they are in, how long a row stands without a later one, and
 * whether they come from the rollups (`wide`).
 */
export interface HistSeries { rows: LiqRow[]; takes: LiqRow[] | null; edges: readonly number[] | null; holdMs: number; wide: boolean }

interface DayEntry { rows: HistRow[]; at: number; busy: boolean; failed: number; wait: number; newest: number; created: number; lead: number; due: number; missing?: boolean }
interface RollupEntry { edges: readonly number[]; hours: number; rows: HistRow[]; at: number; busy: boolean; failed: number; wait: number }

/** The rows in force over [t0, t1] of rows ordered by fetch time: every row fetched in it, and the last one before it. */
function inForce<T extends { fetchedAt: number }>(all: readonly T[], t0: number, t1: number): T[] {
  let from = 0;
  while (from + 1 < all.length && all[from + 1]!.fetchedAt <= t0) from++;
  let to = all.length;
  while (to > 0 && all[to - 1]!.fetchedAt > t1) to--;
  return all.slice(from, Math.max(from, to));
}

/**
 * The history as the page holds it: the index, and the days the view has asked for, each read once (the day still being written again when
 * its next snapshot can be there: `due`, from when its newest row was created, `created`, on the page's clock), per family; and the rollups
 * a wide view with Plus reads. Kept here so the pane only says which stretch of time it shows and what it shows, and draws what has come.
 */
export class LiqHistory {
  #index: LiqIndex | null = null;
  #indexAt = 0; #indexBusy = false; #indexFailed = 0;
  /** The page's clock when last read, to see it set back. */
  #lastNow = -Infinity;
  /** Counts the clock's steps back: an answer to a read made before one carries the old clock's times and is dropped (it is read again). */
  #steps = 0;
  /** The days held, by family and day (`free|<ms>`). */
  #days = new Map<string, DayEntry>();
  #rollups = new Map<LiqFamily, RollupEntry>();
  /** The rows of a view worked out from the parts held, kept while the parts they came from are the same (`#memo`). */
  #cum = new Map<string, { deps: readonly unknown[]; rows: LiqRow[] }>();
  /** Whether the last `ensure` read the rollups (a view wider than `MAX_DAYS` days, with Plus). */
  #wide = false;
  /**
   * Days before this were refused without a pass by the gate: closed like the rest (on sale: where the page's clock called them free, a
   * clock that is off; not on sale: the only days the page closes).
   */
  #refusedBefore = -Infinity;
  /** When that was last learned: it holds for a while (`REFUSAL_HOLDS_MS`), then the newest refused day is asked again, the days staying closed meanwhile. */
  #refusedAt = -Infinity;
  /**
   * Whether files with a pass may be asked for (the gate may refuse every pass, even fresh ones: each grant would then re-ask every paid day
   * at once). After the pass changed, and at the start, one paid file goes first (`probe`), the newest; only when it is answered are the
   * rest asked (`open`). `probing`: that one is on its way. A failed one waits `#probeWait`.
   */
  #paid: 'probe' | 'probing' | 'open' = 'probe';
  #probeWait = -Infinity;
  /** The page's clock minus HyperTracker's, once a snapshot was seen appear (`placeSnapshot`). */
  #offset: number | null = null;
  /** Goes up whenever something new has come. */
  version = 0;
  constructor(private get: LiqGet = webRead, private access: LiqAccess = OPEN) {}
  get index(): LiqIndex | null { return this.#index; }

  /** Whether Plus is on sale: while it is not, the page closes nothing by itself, only what the gate refused. */
  #onSale(): boolean { return this.access.onSale?.() ?? true; }
  /** Whether the hold of the gate's last refusal is over (or the clock went back past it): the newest refused day is asked again. */
  #holdOver(now: number): boolean { return this.#refusedBefore > -Infinity && (now - this.#refusedAt > REFUSAL_HOLDS_MS || now < this.#refusedAt); }

  /**
   * Up to when the history is closed to this visitor, or null when all of it is open (a pass is held, or the service has no paid part):
   * the pane draws nothing before it and says why. On sale that is the page's own rule, or later where the gate refused a day the page called
   * free; not on sale only what the gate refused. Only the free family has a free part: a Plus view is drawn only with a pass.
   */
  closedBefore(now: number): number | null {
    if (this.access.pass(now) !== null) return null;
    const at = this.#onSale() ? Math.max(this.access.freeFrom(now), this.#refusedBefore) : this.#refusedBefore;
    return Number.isFinite(at) ? at : null;
  }
  /**
   * Who may read what changed (a pass came or went): what is held stays, and the days now open are asked for as the view needs them, the
   * newest paid one first (`#paid`): a day that was refused a moment ago does not wait out a failed read's minute. What the gate refused
   * although the page called it free stays known (it is about the two clocks, not about the pass): such a day is then asked for with the pass.
   */
  accessChanged(): void {
    for (const entry of this.#days.values()) { entry.failed = -Infinity; entry.wait = -Infinity; }
    for (const entry of this.#rollups.values()) { entry.failed = -Infinity; entry.wait = -Infinity; }
    this.#paid = 'probe'; this.#probeWait = -Infinity;
    this.version++;
  }
  /** The first file with a pass after the pass changed was answered (all of them may follow), or not (the next waits a minute). */
  #probed(ok: boolean, now: number): void {
    if (ok) { if (this.#paid !== 'open') { this.#paid = 'open'; this.version++; } return; }
    this.#paid = 'probe'; this.#probeWait = now + RETRY_MS;
  }

  /**
   * Ask for what [t0, t1] needs for `view` (the effective one: the free view without Plus) that is not held (or is due again); `changed` is
   * called when an answer lands. Times are kept as of `now`, when they were asked. With a pass, a view wider than `MAX_DAYS` days reads the
   * rollups instead of the days.
   */
  ensure(t0: number, t1: number, now: number, changed: () => void, view: LiqView = FREE_VIEW): void {
    const levelsUrl = liqLevelsUrl(), urls = historyUrls(levelsUrl); if (!urls) return;
    const plusAt = plusUrls(levelsUrl);
    // The page's clock went back since it was last read: what the old clock placed and planned is no good (`clockSetBack`), the index's and
    // the failed reads' waits included.
    if (clockSetBack(this.#lastNow, now)) {
      // Every day is read once more: a day the old clock (ahead) counted as read after it ended may not have been, and no read times of the old
      // clock may bracket a snapshot.
      this.#offset = null; this.#indexAt = -Infinity; this.#indexFailed = -Infinity; this.#steps++; this.#probeWait = -Infinity;
      for (const entry of this.#days.values()) { entry.created = now; entry.lead = MAX_LEAD_MS; entry.due = now; entry.failed = -Infinity; entry.wait = -Infinity; entry.at = -Infinity; }
      for (const entry of this.#rollups.values()) { entry.at = -Infinity; entry.failed = -Infinity; entry.wait = -Infinity; }
    }
    this.#lastNow = now;
    const families = familiesFor(view), pass = this.access.pass(now);
    // Nothing paid is asked for without a pass: a Plus view without one is not drawn (the page shows the free view then).
    const wide = pass !== null && !!plusAt && t1 - t0 > MAX_DAYS * DAY_MS;
    if (wide !== this.#wide) { this.#wide = wide; this.version++; }
    // Files with a pass: every one once the first after a change was answered, else the newest alone (`#paid`).
    const asks: { day: number; go: (probe: boolean) => void }[] = [];
    if (wide) {
      for (const family of families) if (this.#rollupDue(family, now)) asks.push({ day: Infinity, go: probe => this.#ensureRollup(family, plusAt!.rollup[family === 'orders' ? 'triggers' : family], pass!, now, changed, probe) });
      this.#askPaid(asks, now);
      return;
    }
    if (!this.#indexBusy && now - this.#indexFailed > RETRY_MS && (!this.#index || now - this.#indexAt > INDEX_EVERY_MS)) {
      this.#indexBusy = true;
      const steps = this.#steps;
      this.get(urls.index).then(raw => {
        const index = readIndex(raw);
        if (index) { if (this.#index && this.#index.edges.length !== index.edges.length) { this.#days.clear(); this.#cum.clear(); } this.#index = index; if (steps === this.#steps) this.#indexAt = now; this.version++; changed(); }
        else if (steps === this.#steps) this.#indexFailed = now;
      }, () => { if (steps === this.#steps) this.#indexFailed = now; }).finally(() => { this.#indexBusy = false; });
    }
    const index = this.#index; if (!index || index.first === null || index.last === null) return;
    const lastDay = Math.floor(Math.min(t1, Math.max(index.last, now)) / DAY_MS) * DAY_MS;
    // The day before the view as well: the row in force at its left edge may have come the evening before.
    const firstDay = Math.max(Math.floor(index.first / DAY_MS) * DAY_MS, Math.floor(t0 / DAY_MS) * DAY_MS - DAY_MS, lastDay - (MAX_DAYS - 1) * DAY_MS);
    // The server's rule as the page knows it (sale or no sale: it decides what is sent with a pass), and what the gate refused.
    const real = this.access.freeFrom(now), onSale = this.#onSale();
    if (onSale && this.#refusedBefore > -Infinity && this.#refusedBefore <= real) this.#refusedBefore = -Infinity;
    const refused = this.#refusedBefore, recheck = this.#holdOver(now) ? refused - DAY_MS : NaN;
    // Not on sale and without a pass, the days before the boundary that the gate has not refused are asked newest first, and the older ones
    // only once it was served: a gate that refuses them meets one request, not a view's worth of them.
    const lead = Math.min(lastDay, Math.floor((real - 1) / DAY_MS) * DAY_MS);
    const leadEntry = this.#days.get(`free|${lead}`);
    const waitLead = !onSale && pass === null && lead >= firstDay && lead >= refused && !((leadEntry?.at ?? -Infinity) > -Infinity || leadEntry?.missing === true);
    for (const family of families) {
      if (family !== 'free' && (pass === null || !plusAt)) continue;
      const dayUrl = family === 'free' ? urls.day : family === 'groups' ? plusAt!.groupsDay : plusAt!.triggersDay;
      for (let day = firstDay; day <= lastDay; day += DAY_MS) {
        if (!this.#dayDue(family, day, now)) continue;
        // Any day of a Plus family, and a free family's day before the boundary, goes with a pass when there is one. Without one: a day the
        // gate refused waits out its hold (then the newest of them is asked again, the rest staying closed); on sale a day before the
        // boundary is not asked for at all (the pane says it is closed, `closedBefore`); not on sale it is asked, and only the gate's
        // refusal closes it.
        const paid = family !== 'free' || day < real || day < refused;
        if (paid && pass !== null) { asks.push({ day, go: probe => this.#ensureDay(family, day, dayUrl, pass, index.edges, now, changed, probe) }); continue; }
        if (day < refused && day !== recheck) continue;
        if (day < real && onSale && day >= refused) continue;
        if (waitLead && family === 'free' && day < lead) continue;
        this.#ensureDay(family, day, dayUrl, null, index.edges, now, changed, false);
      }
    }
    this.#askPaid(asks, now);
    // Days outside the view are let go, the farthest first, so a long session does not hold the whole history; a day the view needs never is.
    if (this.#days.size > (MAX_DAYS + 4) * families.length) {
      const dayOf = (key: string): number => Number(key.slice(key.indexOf('|') + 1));
      const away = (day: number): number => day < firstDay ? firstDay - day : day - lastDay;
      for (const key of [...this.#days.keys()].filter(k => dayOf(k) < firstDay || dayOf(k) > lastDay).sort((a, b) => away(dayOf(b)) - away(dayOf(a)))) {
        if (this.#days.size <= (MAX_DAYS + 4) * families.length) break;
        this.#days.delete(key);
      }
    }
    if (this.#cum.size > 4 * (MAX_DAYS + 4)) this.#cum.clear();
  }

  /** The files with a pass that are due: all of them once the first after a change was answered, else only the newest (and not while it waits). */
  #askPaid(asks: { day: number; go: (probe: boolean) => void }[], now: number): void {
    if (!asks.length) return;
    if (this.#paid === 'open') { for (const a of asks) a.go(false); return; }
    if (this.#paid === 'probing' || now < this.#probeWait) return;
    this.#paid = 'probing';
    asks.reduce((best, a) => a.day > best.day ? a : best).go(true);
  }

  /** Whether a day is to be asked for now: not held, or still being written and due, and not on its way or waiting after a failure. */
  #dayDue(family: LiqFamily, day: number, now: number): boolean {
    const held = this.#days.get(`${family}|${day}`);
    // A day read after it ended (and the hour after, for a late fetch) does not change; one read before that is asked again when its next
    // snapshot can be there (while it has none yet, when the day before's newest says so, else each minute).
    const settled = held !== undefined && held.at >= day + DAY_MS + 3_600_000;
    return !(held && (held.busy || now - held.failed < RETRY_MS || now < held.wait || settled || now < held.due));
  }

  #ensureDay(family: LiqFamily, day: number, dayUrl: (day: string) => string, pass: string | null, edges: readonly number[], now: number, changed: () => void, probe: boolean): void {
    const key = `${family}|${day}`, held = this.#days.get(key);
    const entry: DayEntry = held ?? { rows: [], at: -Infinity, busy: false, failed: 0, wait: -Infinity, newest: -Infinity, created: 0, lead: 0, due: 0 };
    entry.busy = true; this.#days.set(key, entry);
    const steps = this.#steps, before = entry.at, onTime = entry.due > 0 && now - entry.due <= ON_TIME_MS && !(entry.failed > entry.at);
    this.get(dayUrl(dayText(day)), pass).then(raw => {
      if (probe) this.#probed(true, now);
      if (this.#index?.edges !== edges || steps !== this.#steps) return;
      entry.rows = readHistRows(raw, edges.length, family); entry.at = now; entry.missing = false; this.version++;
      // A day the gate had refused is open now (its rule or the page's clock changed): the days from it on are, and the ones before it are
      // asked again in turn.
      if (pass === null && family === 'free' && day < this.#refusedBefore) this.#refusedBefore = this.#onSale() && day <= this.access.freeFrom(now) ? -Infinity : day;
      const top = entry.rows.reduce<HistRow | null>((best, row) => !best || row.createdAt > best.createdAt ? row : best, null);
      if (top && top.createdAt > entry.newest) {
        // Seen appear between this read and the one before: placed by when it was published, else by its age (`placeSnapshot`).
        entry.newest = top.createdAt;
        ({ created: entry.created, lead: entry.lead, offset: this.#offset } = placeSnapshot(top.createdAt, top.fetchedAt, before, now, entry.lead, this.#offset, onTime));
      }
      const prev = this.#days.get(`${family}|${day - DAY_MS}`);
      entry.due = entry.rows.length ? nextAskAt(entry.created, now, entry.lead) : prev && prev.rows.length ? nextAskAt(prev.created, now, prev.lead) : now + DUE_EVERY_MS;
      changed();
    }, (error: unknown) => {
      entry.failed = now;
      const missing = answeredMissing(error);
      if (probe) this.#probed(missing, now);
      const wait = (error as { retryAfter?: unknown } | null)?.retryAfter;
      if (typeof wait === 'number' && wait > 0) entry.wait = now + Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, wait * 1_000));
      if (missing) { entry.missing = true; entry.wait = Math.max(entry.wait, now + REFUSAL_HOLDS_MS); this.version++; changed(); return; }
      if (!(error instanceof Error) || error.message !== LIQ_REFUSED) return;
      // Refused by the gate. With a pass: that pass is no good any more (it is asked for again, and the day with it). Without one: the
      // server calls the day a Plus one where the page called it free (a clock that is off, or Plus not on sale here), so it and the days
      // before it are closed for a while; believed for any day before the boundary and near it, since a clock is off by hours or a day. A
      // refusal not believed (a day far inside the free week: the server's fault) waits as long, so it is not asked each minute.
      if (pass !== null) this.access.refused(pass);
      else if (family === 'free' && day < this.access.freeFrom(now) + REFUSAL_REACH_MS) {
        this.#refusedBefore = Math.max(this.#refusedBefore, day + DAY_MS); this.#refusedAt = now;
        // A member's page asks again at once, now with the pass (the day counts as a Plus one from here on).
        if (this.access.pass(now) !== null) entry.failed = -Infinity;
      } else { entry.wait = Math.max(entry.wait, now + REFUSAL_HOLDS_MS); return; }
      this.version++; changed();
    }).finally(() => { entry.busy = false; });
  }

  /** Whether a rollup is to be asked for now: not held or old enough, and not on its way or waiting after a failure. */
  #rollupDue(family: LiqFamily, now: number): boolean {
    const held = this.#rollups.get(family);
    return !(held && (held.busy || now - held.failed < RETRY_MS || now < held.wait || now - held.at < ROLLUP_EVERY_MS));
  }

  #ensureRollup(family: LiqFamily, url: string, pass: string, now: number, changed: () => void, probe: boolean): void {
    const entry: RollupEntry = this.#rollups.get(family) ?? { edges: [], hours: 4, rows: [], at: -Infinity, busy: false, failed: 0, wait: -Infinity };
    entry.busy = true; this.#rollups.set(family, entry);
    const steps = this.#steps;
    this.get(url, pass).then(raw => {
      if (probe) this.#probed(true, now);
      if (steps !== this.#steps) return;
      const read = readRollup(raw, family);
      if (!read) { entry.failed = now; return; }
      entry.edges = read.edges; entry.hours = read.hours; entry.rows = read.rows; entry.at = now; this.version++;
      changed();
    }, (error: unknown) => {
      entry.failed = now;
      const missing = answeredMissing(error);
      if (probe) this.#probed(missing, now);
      const wait = (error as { retryAfter?: unknown } | null)?.retryAfter;
      if (typeof wait === 'number' && wait > 0) entry.wait = now + Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, wait * 1_000));
      if (missing) entry.wait = Math.max(entry.wait, now + REFUSAL_HOLDS_MS);
      if (error instanceof Error && error.message === LIQ_REFUSED) { this.access.refused(pass); this.version++; changed(); }
    }).finally(() => { entry.busy = false; });
  }

  /** Rows worked out from parts held, kept while those parts are the same objects. */
  #memo(key: string, deps: readonly unknown[], make: () => LiqRow[]): LiqRow[] {
    const held = this.#cum.get(key);
    if (held && held.deps.length === deps.length && held.deps.every((d, i) => d === deps[i])) return held.rows;
    const rows = make();
    this.#cum.set(key, { deps, rows });
    return rows;
  }

  /**
   * A view's rows from one set of history rows of each family it reads (a day's, or a rollup's): its liquidations (all positions or the
   * profitable traders'; a row without that part has no row), its stops, or both added where the snapshot has both (joined by `createdAt`,
   * or within a rollup by its four-hour block); and the take profits, sides swapped.
   */
  #viewRows(view: LiqView, by: Partial<Record<LiqFamily, HistRow[]>>, edges: readonly number[], block: number | null): { rows: LiqRow[]; takes: LiqRow[] } {
    const liq: { row: HistRow; part: HistPart }[] = [];
    if (view.kind !== 'stops') {
      const fam = groupApplies(view.kind) && view.group !== 'all' ? 'groups' : 'free';
      for (const row of by[fam] ?? []) { const part = row.parts[0]; if (part) liq.push({ row, part }); }
    }
    const orders = by.orders ?? [];
    let main: { row: HistRow; part: HistPart }[];
    if (view.kind === 'liq') main = liq;
    else if (view.kind === 'stops') main = orders.flatMap(row => row.parts[0] ? [{ row, part: row.parts[0] }] : []);
    else {
      // Both: a snapshot with both parts. A rollup's rows are each part's state at its block's end, which may be two snapshots of one block.
      const join = (r: HistRow): number => block ? Math.floor(r.fetchedAt / block) : r.createdAt;
      const stops = new Map<number, HistPart>();
      for (const row of orders) if (row.parts[0]) stops.set(join(row), row.parts[0]);
      main = liq.flatMap(({ row, part }) => { const s = stops.get(join(row)); return s ? [{ row, part: addParts(part, s) }] : []; });
    }
    return {
      rows: main.map(({ row, part }) => cumulate(row, part, edges)),
      takes: view.takes ? orders.flatMap(row => row.parts[1] ? [cumulate(row, row.parts[1], edges, true)] : []) : [],
    };
  }

  /** The buckets the rows for `view` are in (null while not read), how long a row stands, and whether they come from the rollups: what `series` will say, without its rows. */
  shape(view: LiqView = FREE_VIEW): Omit<HistSeries, 'rows' | 'takes'> {
    if (!this.#wide) return { edges: this.#index?.edges ?? null, holdMs: LIQ_HOLD_MS, wide: false };
    const held = familiesFor(view).map(f => this.#rollups.get(f)), first = held[0];
    const ready = !!first && held.every(e => e && e.at > -Infinity && e.edges.length === first.edges.length);
    return { edges: ready ? first.edges : null, holdMs: first ? first.hours * 3_600_000 + LIQ_HOLD_MS : LIQ_HOLD_MS, wide: true };
  }

  /** The rows in force over [t0, t1] for `view`, with the take profits, the buckets, and how long a row stands (see `HistSeries`). */
  series(t0: number, t1: number, view: LiqView = FREE_VIEW): HistSeries {
    const families = familiesFor(view), vk = viewKey(view);
    if (this.#wide) {
      const held = families.map(f => this.#rollups.get(f));
      const first = held[0];
      if (!first || held.some(e => !e || e.at === -Infinity) || held.some(e => e!.edges.length !== first.edges.length)) return { rows: [], takes: view.takes ? [] : null, edges: first && first.at > -Infinity ? first.edges : null, holdMs: first ? first.hours * 3_600_000 + LIQ_HOLD_MS : LIQ_HOLD_MS, wide: true };
      const by: Partial<Record<LiqFamily, HistRow[]>> = {};
      families.forEach((f, i) => { by[f] = held[i]!.rows; });
      const block = first.hours * 3_600_000;
      const deps = held.map(e => e!.rows);
      const rows = this.#memo(`4h|${vk}`, deps, () => this.#viewRows(view, by, first.edges, block).rows);
      const takes = view.takes ? this.#memo(`4h|takes`, [by.orders], () => this.#viewRows(view, by, first.edges, block).takes) : null;
      return { rows: inForce(rows, t0, t1), takes: takes ? inForce(takes, t0, t1) : null, edges: first.edges, holdMs: block + LIQ_HOLD_MS, wide: true };
    }
    const index = this.#index;
    if (!index) return { rows: [], takes: view.takes ? [] : null, edges: null, holdMs: LIQ_HOLD_MS, wide: false };
    const days = new Set<number>();
    for (const key of this.#days.keys()) {
      const family = key.slice(0, key.indexOf('|')) as LiqFamily, day = Number(key.slice(key.indexOf('|') + 1));
      if (families.includes(family) && day + DAY_MS > t0 - DAY_MS && day <= t1) days.add(day);
    }
    const rows: LiqRow[] = [], takes: LiqRow[] = [];
    for (const day of days) {
      const by: Partial<Record<LiqFamily, HistRow[]>> = {}, deps: unknown[] = [];
      for (const f of families) { const e = this.#days.get(`${f}|${day}`); by[f] = e?.rows ?? []; deps.push(e?.rows); }
      rows.push(...this.#memo(`${day}|${vk}`, deps, () => this.#viewRows(view, by, index.edges, null).rows));
      if (view.takes) takes.push(...this.#memo(`${day}|takes`, [by.orders], () => this.#viewRows(view, by, index.edges, null).takes));
    }
    rows.sort((a, b) => a.fetchedAt - b.fetchedAt); takes.sort((a, b) => a.fetchedAt - b.fetchedAt);
    return { rows: inForce(rows, t0, t1), takes: view.takes ? inForce(takes, t0, t1) : null, edges: index.edges, holdMs: LIQ_HOLD_MS, wide: false };
  }

  /** The rows held that are in force over [t0, t1] for `view`: every row fetched in it, and the last one before it. Ordered by fetch time. */
  rows(t0: number, t1: number, view: LiqView = FREE_VIEW): LiqRow[] { return this.series(t0, t1, view).rows; }
}
