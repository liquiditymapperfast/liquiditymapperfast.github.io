import type { Print } from '../prints.ts';
import { SIZE_MAX_USD } from '../sizes.ts';

/**
 * Time & sales: the large market orders as a list, newest on top, made of the orders the page is sent live anyway (the trade bubbles'
 * orders). Nothing is asked for: the list begins when the page opens (or the coin changes) and holds what arrived since, so it costs
 * no request. This file is the arithmetic (no page): the orders kept, the gaps where some may be missing, and the rows a filter and the
 * merge make of them. `panes/tns-view.ts` puts the rows on the screen.
 */

/** The views the flow column can show: the taker flow lines, or Time & sales. */
export type FlowView = 'flow' | 'tns';
export const FLOW_VIEWS: readonly FlowView[] = ['flow', 'tns'];
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
/** The rows made at most (the list shows the newest; older ones are in the orders held, back when a filter is loosened). */
export const TNS_ROWS = 300;
/**
 * A page hidden this long with no order arriving says some may be missing (a tablet suspends a page in the background). Longer than the phone
 * Tape's 5 s: these are orders from $25K, which can be seconds apart in a quiet market, and a desktop window keeps receiving while hidden.
 */
export const TNS_GAP_MS = 30_000;

/** Why some orders may be missing before a point: the stream broke and came back, or the page was in the background. */
export type GapWhy = 'reconnect' | 'hidden';
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
/** A mark between rows: orders may be missing before it (`at`: when it was seen, wall clock; `ms`: how long, when known). */
export interface TnsGap { k: 'gap'; key: string; why: GapWhy; at: number; ms: number }
export type TnsLine = TnsRow | TnsGap;

const keyOf = (p: Print): string => `${p.t}|${p.id}|${p.side}|${p.price}|${p.usd}`;

/**
 * The orders that arrived, in the order they arrived (not sorted by exchange time: a venue's clock or a late batch must not reshuffle what
 * was already read), each once, bounded to `TNS_HOLD` (the oldest go), with the gaps where orders may be missing between them.
 */
export class TnsBook {
  #entries: Entry[] = [];
  #keys = new Set<string>();
  #orders = 0;
  /** Since when the list holds every order: the page's opening, or the oldest order kept once the hold is full. */
  since: number;

  constructor(now: number, private hold = TNS_HOLD) { this.since = now; }

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
    if (!last) return;
    if (last.k === 'gap') { this.#entries[this.#entries.length - 1] = { k: 'gap', why: last.why === 'reconnect' ? 'reconnect' : why, at, ms: last.ms + ms }; }
    else this.#entries.push({ k: 'gap', why, at, ms });
  }

  get orders(): number { return this.#orders; }

  /** Drop the oldest orders past `hold`, with any gap before the first order kept (a list starting with a gap says nothing). */
  #trim(): void {
    let drop = this.#orders - this.hold, cut = 0;
    while (cut < this.#entries.length && drop > 0) { const e = this.#entries[cut++]!; if (e.k === 'order') { this.#keys.delete(keyOf(e.p)); drop--; this.#orders--; } }
    while (cut < this.#entries.length && this.#entries[cut]!.k === 'gap') cut++;
    this.#entries = this.#entries.slice(cut);
    const first = this.#entries[0];
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
    for (const e of this.#entries) {
      if (e.k === 'gap') {
        open.clear(); qty = new Map();
        if (out.length && out[out.length - 1]!.k !== 'gap') out.push({ k: 'gap', key: `gap|${e.at}`, why: e.why, at: e.at, ms: e.ms });
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
