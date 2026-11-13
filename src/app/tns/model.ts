import type { Print } from '../prints.ts';
import { SIZE_MAX_USD } from '../sizes.ts';

/**
 * Time & sales: the large market orders as a list, newest on top, made of the orders the page is sent live anyway (the trade bubbles'
 * orders), and, when it first shows, of those the recording already holds for the stretch it covered without a hole up to now (read from
 * the page's own recording or the local server, never from an exchange: Karl, 2026-11-12, "forward only, except if it's free"). This
 * file is the arithmetic (no page): the orders kept, the gaps where some may be missing, the stretch the recording covered, and the rows
 * a filter and the merge make of them. `panes/tns-view.ts` puts the rows on the screen.
 */

/** The views the flow column can show: the taker flow lines, Time & sales (large orders), or All trades (every order, `panes/trades-view.ts`). */
export type FlowView = 'flow' | 'tns' | 'all';
export const FLOW_VIEWS: readonly FlowView[] = ['flow', 'tns', 'all'];
export const readFlowView = (saved: unknown): FlowView => FLOW_VIEWS.includes(saved as FlowView) ? saved as FlowView : 'flow';

export interface TnsSettings {
  /** The smallest order listed (BTC's dollars; scaled for a coin that trades less, as every size setting is). */
  minUsd: number;
  side: 'both' | 'buy' | 'sell';
  /** A burst of orders on one exchange and side is one row (`MERGE_GAP_MS`, `MERGE_SPAN_MS`). */
  merge: boolean;
}
/** The orders recorded start here: the list cannot go lower. */
export const TNS_FLOOR_USD = 25_000;
/** The sizes offered in the menu (BTC's; any size from the floor can be typed). */
export const TNS_MINIMUMS: readonly number[] = [25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000];
/**
 * $100K: a week of BTC orders on the eleven default venues made 13 rows a minute at the median, 47 at the 90th percentile and 141 at the
 * 99th with the merge on; at $25K it was 54 / 156 / 354 merged and 71 / 248 / 906 not (Research_Findings.md, time-and-sales-2026-11-12).
 */
export const TNS_DEFAULTS: Readonly<TnsSettings> = { minUsd: 100_000, side: 'both', merge: true };
export function readTns(saved: unknown): TnsSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>, d = TNS_DEFAULTS;
  const min = typeof s.minUsd === 'number' && Number.isFinite(s.minUsd) && s.minUsd >= TNS_FLOOR_USD && s.minUsd <= SIZE_MAX_USD ? s.minUsd : d.minUsd;
  return { minUsd: min, side: s.side === 'buy' || s.side === 'sell' ? s.side : 'both', merge: typeof s.merge === 'boolean' ? s.merge : d.merge };
}

/** An order joins the open row of its exchange and side when it comes this soon after that row's last order (exchange time)... */
export const MERGE_GAP_MS = 500;
/** ...and no later than this after the row's first, so a busy exchange still gets a new row every few seconds. */
export const MERGE_SPAN_MS = 3_000;
/** The orders held (from the floor up, every side and venue: the filter is applied when the rows are made). */
export const TNS_HOLD = 5_000;
/** How far past the seam a recorded order is still the recording's: one the stream had not sent when it opened (the stream's own are kept once). */
export const SEAM_SLACK_MS = 5_000;
/** The rows made at most (the list shows the newest; older ones are in the orders held, back when a filter is loosened). */
export const TNS_ROWS = 500;
/** How far back the list fills itself from the recording when it first shows. */
export const TNS_LOOKBACK_MS = 60 * 60_000;
/**
 * How short a hole in the coverage of every market at once is passed over as no hole, per source. The 8787 server's loop pauses for seconds
 * at a time and its record marks a pass more than 2.5 s after the one before as uncovered (holes of 8 to 25 s every few minutes, at the same
 * moments on every market, 2026-11-12), but the feeds' trades wait in their sockets meanwhile: its recording held 2.2 large orders a second
 * inside those holes against 2.9 outside them. In the browser a hole is a page closed or reloaded (the history service's hour files end a
 * minute or so before the visit, then nothing until the page's own recording starts): those orders are not anywhere. It is also the shortest
 * line the list draws, once the orders the recording holds inside a hole are counted (`TnsBook.prefill`).
 */
export const TNS_HOLE_MS: Readonly<Record<'server' | 'browser', number>> = { server: 2 * 60_000, browser: 5_000 };

/**
 * What the recording covered of [from, until), from each instrument's covered stretches (`CoverageInstrument.spans`): from when (the first
 * moment some instrument was recorded, no earlier than `from`) and the holes in it, stretches of `minHole` or more in which no instrument was
 * recorded (a single venue reconnecting is no hole: the live list does not mark that either), the last one running to `until` when the
 * recording stops before it. Null when nothing of the window was recorded.
 */
export function recordedStretch(spans: readonly (readonly (readonly [number, number])[])[], from: number, until: number, minHole: number): { since: number; holes: [number, number][] } | null {
  const all = spans.flat().map(s => [Math.max(from, s[0]), Math.min(until, s[1])] as [number, number]).filter(s => s[1] > s[0]).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of all) { const last = merged[merged.length - 1]; if (last && a < last[1] + minHole) last[1] = Math.max(last[1], b); else merged.push([a, b]); }
  if (!merged.length) return null;
  const holes: [number, number][] = [];
  for (let i = 1; i < merged.length; i++) holes.push([merged[i - 1]![1], merged[i]![0]]);
  const tail = merged[merged.length - 1]!;
  if (until - tail[1] >= minHole) holes.push([tail[1], until]);
  return { since: merged[0]![0], holes };
}

/** How long after a hole starts the recording can still hold orders: coverage is stored cut at the minute still open (`shared/coverage.ts`). */
const OPEN_MINUTE_MS = 60_000;

/** The time of the newest of `held` (orders in ascending time) in [from, to), or null. */
function newestIn(from: number, to: number, held: readonly Print[]): number | null {
  let lo = 0, hi = held.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (held[mid]!.t < to) lo = mid + 1; else hi = mid; }
  return lo > 0 && held[lo - 1]!.t >= from ? held[lo - 1]!.t : null;
}

/**
 * The longest stretch of [from, to) in which none of `held` (orders in ascending time) falls, as [start, end]: the whole of it when none does.
 * The earliest wins a tie.
 */
function longestFree(from: number, to: number, held: readonly Print[]): [number, number] {
  let lo = 0, hi = held.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (held[mid]!.t < from) lo = mid + 1; else hi = mid; }
  let best: [number, number] = [from, from], start = from;
  for (let i = lo; i < held.length && held[i]!.t < to; i++) {
    const t = held[i]!.t;
    if (t - start > best[1] - best[0]) best = [start, t];
    start = t;
  }
  if (to - start > best[1] - best[0]) best = [start, to];
  return best;
}

/**
 * A page hidden this long with no order arriving says some may be missing (a tablet suspends a page in the background). Longer than the phone
 * Tape's 5 s: these are orders from $25K, which can be seconds apart in a quiet market, and a desktop window keeps receiving while hidden.
 */
export const TNS_GAP_MS = 30_000;

/** Why some orders may be missing before a point: the stream broke and came back, the page was in the background, or nothing recorded that stretch. */
export type GapWhy = 'reconnect' | 'hidden' | 'unrecorded';
type Entry = { k: 'order'; p: Print } | { k: 'gap'; why: GapWhy; at: number; ms: number };

/** One row of the list: an order, or a burst of them on one exchange and side (`orders` > 1), at its volume-weighted price. */
export interface TnsRow {
  k: 'row';
  /** Stable while orders join the row (its first order's key), so the page can keep the element. */
  key: string;
  id: string; side: 'buy' | 'sell';
  /** The first order's exchange time, and the last's. */
  t: number; last: number;
  usd: number; price: number; lo: number; hi: number;
  orders: number;
}
/** A mark between rows: orders may be missing before it (`at`: when it was seen or, unrecorded, when the hole ended; `ms`: how long, when known). */
export interface TnsGap { k: 'gap'; key: string; why: GapWhy; at: number; ms: number }
export type TnsLine = TnsRow | TnsGap;

const keyOf = (p: Print): string => `${p.t}|${p.id}|${p.side}|${p.price}|${p.usd}`;

/**
 * The orders that arrived, in the order they arrived (not sorted by exchange time: a venue's clock or a late batch must not reshuffle what
 * was already read), each once, bounded to `TNS_HOLD` (the oldest go), with the gaps where orders may be missing between them; and before
 * them the orders the recording held from before the page opened, in exchange-time order, with the holes in the recording.
 */
export class TnsBook {
  #entries: Entry[] = [];
  /** Live orders were let go to the hold: the list no longer holds every order since the seam, so a fill must not claim it does. */
  #liveCut = false;
  /** The recording's orders from before the seam, oldest first, with its holes as gaps (`prefill`). */
  #history: Entry[] = [];
  #keys = new Set<string>();
  #orders = 0;
  /**
   * Where the recording's orders end and the live stream's begin: when the stream opened (`open`), not when the list was made, which is
   * seconds earlier on a page that opens on the list (the server recorded those seconds; the stream did not send them).
   */
  seam: number;
  /** Since when the list holds every order (holes in the recording aside, which it shows): the page's opening, the recording's start, or the oldest order kept once the hold is full. */
  since: number;

  constructor(now: number, private hold = TNS_HOLD) { this.since = now; this.seam = now; }

  /** The live stream opened at `at`: the seam moves there (the list holds every order from it, or from the recording's start once filled). */
  open(at: number): void { this.seam = at; if (!this.#history.length) this.since = at; }

  /** Add the orders that arrived; returns how many were new. */
  add(prints: readonly Print[]): number {
    let added = 0;
    for (const p of prints) {
      const key = keyOf(p);
      if (this.#keys.has(key)) continue;
      this.#keys.add(key); this.#entries.push({ k: 'order', p }); this.#orders++; added++;
    }
    if (!added) return 0;
    if (this.#orders > this.hold) this.#trim();
    return added;
  }

  /** Orders may be missing before now. A second gap with no order since the last one replaces it (the longer story wins). */
  gap(why: GapWhy, at: number, ms = 0): void {
    const last = this.#entries[this.#entries.length - 1];
    // With nothing before it yet the line is kept all the same: a fill may still bring the recording's orders before it, and a list never
    // starts with a line anyway (`rows` and `#trim` leave a leading one out).
    if (last?.k === 'gap') { this.#entries[this.#entries.length - 1] = { k: 'gap', why: last.why === 'reconnect' ? 'reconnect' : why, at, ms: last.ms + ms }; }
    else this.#entries.push({ k: 'gap', why, at, ms });
  }

  get orders(): number { return this.#orders; }

  /**
   * The orders the recording held from `since` to a little past the seam (when the stream opened), before everything that arrived live, in
   * exchange-time order, each once (those the stream sent too are its own), and the recording's `holes` among them as gaps (each a line where
   * it fell; one running up to the seam sits between the recording and the live orders). A hole's line says nothing was recorded, so it starts
   * after the last order placed from the recording in the hole's first minute (coverage is stored cut at the minute still open, while the
   * orders stored with that minute run up to when its piece was written; orders within `SEAM_SLACK_MS` of the hole's end are left out of this,
   * as the next stretch's first orders can be stamped a moment before it starts), and from there it is the longest stretch in which none of
   * those orders falls, never a quiet patch of a minute that was recorded. None when that is shorter than `minHole` (the source's,
   * `TNS_HOLE_MS`): the server's loop pauses are full of orders. A fill replaces the one before it: each answer is the whole of its window at
   * its own smallest order (the list fills again when its smallest order is lowered). Returns how many orders it holds.
   */
  prefill(prints: readonly Print[], since: number, holes: readonly (readonly [number, number])[] = [], minHole = 0): number {
    for (const e of this.#history) if (e.k === 'order') { this.#keys.delete(keyOf(e.p)); this.#orders--; }
    this.#history = [];
    // Since: from the seam (or the oldest live order kept, if earlier), unless live orders were already let go to the hold: then from the
    // oldest one kept, whatever the recording held (it cannot reach back over what the list dropped).
    const live = this.#entries.flatMap(e => e.k === 'order' ? [e.p.t] : []);
    this.since = this.#liveCut ? Math.min(...live, this.since) : live.length ? Math.min(this.seam, ...live) : this.seam;
    const held: Print[] = [];
    let added = 0;
    for (const p of prints) {
      const key = keyOf(p);
      if (p.t < since || p.t >= this.seam + SEAM_SLACK_MS || this.#keys.has(key)) continue;
      this.#keys.add(key); held.push(p); added++;
    }
    held.sort((a, b) => a.t - b.t);
    const gaps = holes.filter(h => h[1] > since && h[0] < this.seam)
      .flatMap(h => {
        const from = Math.max(h[0], since), to = Math.min(h[1], this.seam);
        const open = newestIn(from, Math.min(h[0] + OPEN_MINUTE_MS, to - SEAM_SLACK_MS), held) ?? from;
        const free = longestFree(open, to, held);
        return free[1] > free[0] && free[1] - free[0] >= minHole ? [free] : [];
      })
      .sort((a, b) => a[0] - b[0]);
    const block: Entry[] = [];
    let g = 0;
    const gapAt = (h: readonly [number, number]): Entry => ({ k: 'gap', why: 'unrecorded', at: h[1], ms: h[1] - h[0] });
    for (const p of held) {
      while (g < gaps.length && gaps[g]![1] <= p.t) block.push(gapAt(gaps[g++]!));
      block.push({ k: 'order', p });
    }
    while (g < gaps.length) block.push(gapAt(gaps[g++]!));
    this.#history = block; this.#orders += added;
    if (!this.#liveCut) this.since = Math.min(this.since, since);
    if (this.#orders > this.hold) this.#trim();
    return added;
  }

  /** Drop the oldest orders past `hold` (the recording's first), with any gap before the first order kept (a list starting with a gap says nothing). */
  #trim(): void {
    let drop = this.#orders - this.hold;
    const cutFrom = (list: Entry[]): Entry[] => {
      let cut = 0;
      while (cut < list.length && drop > 0) { const e = list[cut++]!; if (e.k === 'order') { this.#keys.delete(keyOf(e.p)); drop--; this.#orders--; } }
      return list.slice(cut);
    };
    this.#history = cutFrom(this.#history);
    if (drop > 0) { this.#entries = cutFrom(this.#entries); this.#liveCut = true; }
    if (!this.#history.some(e => e.k === 'order')) this.#history = [];
    const lead = this.#history.length ? this.#history : this.#entries;
    let skip = 0;
    while (skip < lead.length && lead[skip]!.k === 'gap') skip++;
    if (this.#history.length) this.#history = this.#history.slice(skip); else this.#entries = this.#entries.slice(skip);
    const first = (this.#history.length ? this.#history : this.#entries)[0];
    // Never ahead of the page's clock: an exchange whose clock runs fast would otherwise put Since in the future for the session.
    if (first?.k === 'order') this.since = Math.max(this.since, Math.min(first.p.t, Date.now()));
  }

  /**
   * The rows for a filter, newest first and at most `limit`: an order is listed when its instrument is `shown`, it is on the side asked
   * for and it is at least `minUsd` (the coin's dollars); with `merge`, an order joins the open row of its exchange and side when it falls
   * within `MERGE_GAP_MS` of the row's time span (before its first order or after its last: arrival order is not time order) and the row
   * then spans no more than `MERGE_SPAN_MS`. A gap closes every open row and is listed where it fell, unless no row comes before it; the
   * oldest line is never a gap.
   */
  rows(o: { minUsd: number; side: TnsSettings['side']; merge: boolean; shown: (id: string) => boolean; limit?: number }): TnsLine[] {
    const out: TnsLine[] = [], open = new Map<string, TnsRow>();
    let qty = new Map<TnsRow, number>();
    for (const e of [...this.#history, ...this.#entries]) {
      if (e.k === 'gap') {
        open.clear(); qty = new Map();
        // Each hole its own line, even with no row shown between two (the filter can hide the orders between them); none before the first row.
        if (out.length) out.push({ k: 'gap', key: `gap|${e.why}|${e.at}`, why: e.why, at: e.at, ms: e.ms });
        continue;
      }
      const p = e.p;
      if (p.usd < o.minUsd || (o.side !== 'both' && p.side !== o.side) || !o.shown(p.id)) continue;
      const lane = `${p.id}|${p.side}`, row = o.merge ? open.get(lane) : undefined;
      const lo = p.lo ?? p.price, hi = p.hi ?? p.price;
      if (row && p.t >= row.t - MERGE_GAP_MS && p.t <= row.last + MERGE_GAP_MS && Math.max(row.last, p.t) - Math.min(row.t, p.t) <= MERGE_SPAN_MS) {
        const q = (qty.get(row) ?? 0) + p.usd / p.price;
        qty.set(row, q);
        row.usd += p.usd; row.price = row.usd / q; row.orders++;
        row.lo = Math.min(row.lo, lo); row.hi = Math.max(row.hi, hi);
        row.t = Math.min(row.t, p.t); row.last = Math.max(row.last, p.t);
        continue;
      }
      const fresh: TnsRow = { k: 'row', key: keyOf(p), id: p.id, side: p.side, t: p.t, last: p.t, usd: p.usd, price: p.price, lo, hi, orders: 1 };
      qty.set(fresh, p.usd / p.price);
      out.push(fresh);
      // A far-late order makes a row of its own without closing the lane's open row, which the next order in time order still joins.
      if (o.merge && (!row || fresh.t >= row.last)) open.set(lane, fresh);
    }
    // A gap at the end is the newest thing that happened: it stays, so the top of the list says orders may be missing just now.
    const limit = o.limit ?? TNS_ROWS;
    let kept = out.slice(-limit);
    while (kept[0]?.k === 'gap') kept = kept.slice(1);
    return kept.reverse();
  }
}

/**
 * How long the page missed while it was hidden, as the phone's Tape counts it (`candle/model.ts` TapeGaps): the time hidden inside a
 * stretch of more than `TNS_GAP_MS` with no order arriving, said when an order comes again. A desktop window goes on receiving orders while
 * hidden, so being hidden alone says nothing.
 */
export class HiddenGaps {
  #arrived: number; #hiddenAt: number | null; #hiddenMs = 0;
  constructor(now: number, hidden: boolean) { this.#arrived = now; this.#hiddenAt = hidden ? now : null; }
  hide(now: number): void { if (this.#hiddenAt === null) this.#hiddenAt = now; }
  show(now: number): void {
    if (this.#hiddenAt === null) return;
    this.#hiddenMs += Math.max(0, now - Math.max(this.#hiddenAt, this.#arrived)); this.#hiddenAt = null;
  }
  /** Orders came in at `now`: the time missed before them (0 when none). */
  arrived(now: number): number {
    const hidden = this.#hiddenMs + (this.#hiddenAt === null ? 0 : Math.max(0, now - Math.max(this.#hiddenAt, this.#arrived)));
    const missed = now - this.#arrived > TNS_GAP_MS && hidden > TNS_GAP_MS ? hidden : 0;
    this.#arrived = now; this.#hiddenMs = 0;
    return missed;
  }
}
