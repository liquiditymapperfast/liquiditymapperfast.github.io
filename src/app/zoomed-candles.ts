import type { CandleRow } from './store.ts';

/**
 * Candles longer than the chart's, for a view zoomed out until the chart's own would be narrower than CANDLE_LINE_PX (a user, 2026-11-11:
 * "need to be able to see candles on higher zoom outs, and color them accordingly"; until then they turned into the line through the closes,
 * which shows neither a candle's range nor which way it went). The chart's candles are added up into the longer ones (the open of the first,
 * the highest high, the lowest low, the close of the last, the volumes summed), and before them stand the price history's own bars of that
 * length, or added up into it. A longer candle that the chart's candles begin inside would hold part of its time only, with the wrong open:
 * the price history's stands in for it where it has it, and otherwise it is left out. In a replay the price history's bars that close after
 * the moment shown are left out, so no candle shows what came after (the chart's own candles are cut to the moment already).
 */

/** Bars sorted by start, each `ms` long: [start, open, high, low, close, volume, ...]. */
export interface Bars { readonly rows: readonly Row[]; readonly ms: number }
/** A bar as the chart and the price history keep it (the fields after the volume are optional). */
type Row = readonly (number | undefined)[];

interface Bucket { row: CandleRow; whole: boolean }

/** `rows` (sorted by start) added up into candles of `tf`; the first is not whole where the rows begin inside it. */
function addUp(rows: readonly Row[], tf: number): Bucket[] {
  const out: Bucket[] = [];
  let b: Bucket | null = null;
  for (const c of rows) {
    const start = Math.floor(c[0]! / tf) * tf;
    if (!b || b.row[0] !== start) {
      b = { row: [start, c[1]!, c[2]!, c[3]!, c[4]!, Number.isFinite(c[5]) ? c[5]! : 0], whole: out.length > 0 || c[0] === start };
      out.push(b);
      continue;
    }
    const r = b.row;
    r[2] = Math.max(r[2], c[2]!); r[3] = Math.min(r[3], c[3]!); r[4] = c[4]!;
    if (Number.isFinite(c[5])) r[5] += c[5]!;
  }
  return out;
}

/**
 * The candles of `tf` drawn while zoomed out: the chart's (`drawn`, sorted) added up, the price history's (`history`, of the chart's market,
 * coarser than the chart's candles) where those do not reach whole; `cut`: in a replay, the moment shown.
 */
export function zoomedCandles(drawn: readonly CandleRow[], tf: number, history: Bars | null, cut = Infinity): CandleRow[] {
  const own = addUp(drawn, tf);
  const ext = history ? addUp(Number.isFinite(cut) ? history.rows.filter(c => c[0]! + history.ms <= cut) : history.rows, tf) : [];
  const out: CandleRow[] = [];
  let i = 0, j = 0;
  while (i < own.length || j < ext.length) {
    const s = Math.min(own[i]?.row[0] ?? Infinity, ext[j]?.row[0] ?? Infinity);
    const mine = own[i]?.row[0] === s ? own[i++]! : null, theirs = ext[j]?.row[0] === s ? ext[j++]! : null;
    const pick = mine?.whole ? mine : theirs?.whole ? theirs : null;
    if (pick) out.push(pick.row);
  }
  return out;
}

/** The newest candle of `tf` made of the chart's candles (`drawn`, sorted): those from the start of the one holding the last of them. */
export function newestCandle(drawn: readonly CandleRow[], tf: number): CandleRow {
  const start = Math.floor(drawn[drawn.length - 1]![0] / tf) * tf;
  let k = drawn.length - 1;
  while (k > 0 && drawn[k - 1]![0] >= start) k--;
  return addUp(drawn.slice(k), tf)[0]!.row;
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
