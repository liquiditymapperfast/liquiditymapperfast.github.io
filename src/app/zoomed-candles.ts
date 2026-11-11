import type { CandleRow } from './store.ts';

/**
 * Candles longer than the chart's, for a view zoomed out until the chart's own would be narrower than CANDLE_LINE_PX (a user, 2026-11-11:
 * "need to be able to see candles on higher zoom outs, and color them accordingly"; until then they turned into the line through the closes,
 * which shows neither a candle's range nor which way it went). The chart's candles are added up into the longer ones (the open of the first,
 * the highest high, the lowest low, the close of the last, the volumes summed), and before them stand the price history's own bars of that
 * length, or added up into it.
 *
 * Which of the two a longer candle is made of (Sol, review 2026-11-11: a hole in the chart's candles made a whole-looking candle that
 * overrode the history's complete one): the one under way at `now` (the page's clock, a replay's moment) is the chart's, live; otherwise the one whose bars cover all of its time, the
 * chart's first; otherwise the one covering more of it. A longer candle that a series begins inside (the chart's first candle, or the
 * history's, is later than its start) would open at that candle's price, not its own: it is not used, so where nothing else has it, it is
 * left out. In a replay the price history's bars that close after the moment shown are left out, so no candle shows what came after (the
 * chart's own candles are cut to the moment already).
 */

/** Bars sorted by start, each `ms` long: [start, open, high, low, close, volume, ...]. */
export interface Bars { readonly rows: readonly Row[]; readonly ms: number }
/** A bar as the chart and the price history keep it (the fields after the volume are optional). */
type Row = readonly (number | undefined)[];

/** A longer candle added up: how much of its time its bars cover, whether one starts with it, and whether it is its series' first. */
interface Bucket { row: CandleRow; covered: number; head: boolean; first: boolean }

/** `rows` (sorted by start, each `rowMs` long) added up into candles of `tf`. */
function addUp(rows: readonly Row[], tf: number, rowMs: number): Bucket[] {
  const out: Bucket[] = [];
  let b: Bucket | null = null;
  for (const c of rows) {
    const start = Math.floor(c[0]! / tf) * tf;
    if (!b || b.row[0] !== start) {
      b = { row: [start, c[1]!, c[2]!, c[3]!, c[4]!, Number.isFinite(c[5]) ? c[5]! : 0], covered: rowMs, head: c[0] === start, first: out.length === 0 };
      out.push(b);
      continue;
    }
    const r = b.row;
    r[2] = Math.max(r[2], c[2]!); r[3] = Math.min(r[3], c[3]!); r[4] = c[4]!;
    if (Number.isFinite(c[5])) r[5] += c[5]!;
    b.covered += rowMs;
  }
  return out;
}

/** Whether a longer candle opens at its own price: not one its series begins inside. */
const opens = (b: Bucket | null): b is Bucket => b !== null && (b.head || !b.first);

/**
 * The candles of `tf` drawn while zoomed out: the chart's (`drawn`, sorted, each `drawnMs` long) added up, and the price history's
 * (`history`, of the chart's market, coarser than the chart's candles) where the chart's do not cover them better; `now`: the page's clock
 * (a replay's moment), which says which candle is under way (the chart's newest is not: a market quiet since, or a feed that stopped; Sol,
 * round 5); `cut`: in a replay, the moment shown.
 */
export function zoomedCandles(drawn: readonly CandleRow[], drawnMs: number, tf: number, history: Bars | null, now: number, cut = Infinity): CandleRow[] {
  const own = addUp(drawn, tf, drawnMs);
  const ext = history ? addUp(Number.isFinite(cut) ? history.rows.filter(c => c[0]! + history.ms <= cut) : history.rows, tf, history.ms) : [];
  const forming = Math.floor(now / tf) * tf, out: CandleRow[] = [];
  let i = 0, j = 0;
  while (i < own.length || j < ext.length) {
    const s = Math.min(own[i]?.row[0] ?? Infinity, ext[j]?.row[0] ?? Infinity);
    const mine = own[i]?.row[0] === s ? own[i++]! : null, theirs = ext[j]?.row[0] === s ? ext[j++]! : null;
    let pick: Bucket | null;
    if (opens(mine) && s === forming) pick = mine;
    else if (mine && mine.covered >= tf) pick = mine;
    else if (opens(theirs) && theirs.covered >= tf) pick = theirs;
    else { const a = opens(mine) ? mine : null, b = opens(theirs) ? theirs : null; pick = a && b ? (b.covered > a.covered ? b : a) : a ?? b; }
    if (pick) out.push(pick.row);
  }
  return out;
}

/** The newest candle of `tf` made of the chart's candles (`drawn`, sorted): those from the start of the one holding the last of them. */
export function newestCandle(drawn: readonly CandleRow[], tf: number): CandleRow {
  const start = Math.floor(drawn[drawn.length - 1]![0] / tf) * tf;
  let k = drawn.length - 1;
  while (k > 0 && drawn[k - 1]![0] >= start) k--;
  return addUp(drawn.slice(k), tf, 0)[0]!.row;
}

/** Whether `next` is `prev` with its last candle moved (a live update): as long, and every row but the last the same one. */
export function sameButLast(prev: readonly CandleRow[], next: readonly CandleRow[]): boolean {
  const n = next.length;
  if (!n || prev.length !== n || prev[n - 1]![0] !== next[n - 1]![0]) return false;
  for (let k = 0; k < n - 1; k++) if (prev[k] !== next[k]) return false;
  return true;
}

/** The candle of `rows` (sorted, each `tf` long) that holds `t`, or undefined. */
export function candleHolding(rows: readonly CandleRow[], tf: number, t: number): CandleRow | undefined {
  let lo = 0, hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, c = rows[mid]!;
    if (t < c[0]) hi = mid - 1; else if (t >= c[0] + tf) lo = mid + 1; else return c;
  }
  return undefined;
}
