import { t } from '../i18n.ts';
import { clock, usd } from '../format.ts';
import type { InfoLine } from '../infobox.ts';
import type { OiBar } from '../store.ts';
import type { CandleFlow } from './candles.ts';
import { OI_HOLD_MS, heldOiAt } from '../oi-change.ts';

/**
 * NL/NS: an estimate of who opened and closed positions. Every position has a long and a short holder, so open interest cannot say which
 * side was new; this gives each change of open interest to the side that traded at market on the same market over the same stretch (its
 * taker delta, or, where its flow is not recorded, the way the chart's price went). Up with buyers: longs opened; up with sellers: shorts
 * opened; down with sellers: longs closed; down with buyers: shorts closed.
 *
 * A market's change is measured between its own readings (its bars), never between values carried from one: a venue read every five minutes
 * (or hourly, in older history) changes once, by the whole step, in the candle of its new reading, and that step is given to its takers over
 * the whole stretch since the reading before, and marked coarse when that stretch is longer than a candle. Markets are each classified first
 * and then added up, so in one candle a venue's new longs and another's new shorts both show, and new longs beside shorts closed are +2 for
 * the longs side even when the open interest did not change.
 *
 * Where a market's minute readings and its flow each minute cover a candle (`NlnsFine`), the candle's parts are those of its minute pieces
 * added up: each minute's change given to that minute's takers. Inside a long candle an episode of longs opening at market sits beside closes
 * and hand-overs on the other side, and the candle's one net delta mixes them; the pieces keep each episode's own side. Measured against every
 * Hyperliquid trade's own change of open interest (Research OIF-1, 2026-11-06, BTC and ETH, 30 days each): the side that added more of the new
 * contracts was named for 90-91 % of the rise per 15-minute candle by the candle's delta and 94-95 % by its minute pieces (a significant gain on
 * both coins); per hour 87-88 % against 93-96 % (significant on ETH, not on BTC's 30 days). A candle a market's minute readings do not cover
 * keeps the reading per candle.
 */

export type NlnsKind = 'newLongs' | 'newShorts' | 'longsClosed' | 'shortsClosed';
export interface NlnsCandle {
  t: number;
  /** The change of open interest attributed in this candle (coins) and what it was before, over the markets counted. */
  dOi: number; oiStart: number;
  /**
   * The four parts (coins, none negative); changes that went to neither side because the takers came out even (`unassigned`), and because
   * nothing said which way they went (`unknown`: the flow did not cover the whole stretch and the chart's price could not stand in).
   */
  longOpened: number; longClosed: number; shortOpened: number; shortClosed: number; unassigned: number; unknown: number;
  /** Of `unassigned` and `unknown`, what came while open interest rose and what while it fell (the OI pane draws them on the side they came on). */
  unsidedUp: number; unsidedDown: number;
  /** Longs opened less closed, shorts opened less closed, and the net of the two (`v = longs − shorts`). */
  longs: number; shorts: number; v: number;
  /** The largest part, or `mixed` when parts pulled both ways (new longs or shorts closed beside new shorts or longs closed); null when nothing was attributed. */
  kind: NlnsKind | 'mixed' | null;
  /** +1 the net went to longs, −1 to shorts, 0 neither; `byPrice`: some market was classified by the chart's price; `coarse`: some change
   *  covered more than this candle (readings further apart than a candle). */
  side: 1 | -1 | 0; byPrice: boolean; coarse: boolean;
  /** Markets whose open interest is known at this candle, and those with a change attributed in it; `fine`: those worked out on minute pieces. */
  covered: number; counted: number; fine: number;
  /** Running sums from the last restart (of `v`, `longs`, `shorts`) and which run it is in. */
  cum: number; cumLongs: number; cumShorts: number; run: number;
}

/**
 * A market's minute readings for NL/NS: its open-interest bars a minute apart where it was read that often (a venue read every five minutes
 * has a bar every fifth minute), `starts` a minute apart (oldest first), and its taker flow each minute (aligned to `starts`; null where not
 * recorded).
 */
export interface NlnsFine { starts: readonly number[]; bars: readonly OiBar[]; flows: readonly (CandleFlow | null)[] }
/**
 * One market for NL/NS: its open-interest bars on the chart's timeframe, its taker flow per candle (aligned to the candle starts; null where not
 * recorded), and its minute readings where it has them (`fine`).
 */
export interface NlnsMarket { bars: readonly OiBar[]; flows: readonly (CandleFlow | null)[]; fine?: NlnsFine | null }

/**
 * One market's share of one candle (`up`/`down`: the unassigned and unknown that came while its open interest rose / fell; `gap`: a reading in
 * it whose reading before was further back than the hold, its change counted nowhere).
 */
interface Parts { dOi: number; oiStart: number; lo: number; lc: number; so: number; sc: number; un: number; unknown: number; up: number; down: number; byPrice: boolean; coarse: boolean; gap: boolean; counted: number }
const noParts = (): Parts => ({ dOi: 0, oiStart: 0, lo: 0, lc: 0, so: 0, sc: 0, un: 0, unknown: 0, up: 0, down: 0, byPrice: false, coarse: false, gap: false, counted: 0 });

/**
 * One market's parts in each candle of `starts` (`tfMs` apart, `index` by start; `bars` sorted): each change between two of its readings at
 * most `holdMs` apart lands in the candle of the newer, given to its takers over the whole stretch since the older where every candle of it is
 * recorded (`flows`), else to the way the price went (`closeAt`), else to no side. A stretch longer than `coarseMs` is marked coarse.
 */
function marketParts(starts: readonly number[], index: ReadonlyMap<number, number>, bars: readonly OiBar[], flows: readonly (CandleFlow | null)[],
  closeAt: ((t: number) => number | undefined) | null, tfMs: number, holdMs: number, coarseMs: number): Parts[] {
  const parts = starts.map(noParts);
  for (let k = 1; k < bars.length; k++) {
    const before = bars[k - 1]!, now = bars[k]!, i = index.get(now[0]);
    if (i === undefined) continue;
    if (now[0] - before[0] > holdMs) { parts[i]!.gap = true; continue; }
    const d = now[4] - before[4], p = parts[i]!;
    p.counted++; p.dOi += d; p.oiStart += before[4];
    if (now[0] - before[0] > coarseMs) p.coarse = true;
    if (d === 0) continue;
    // The market's takers over the whole stretch since its reading before (the candles after it, up to and including this one), only when
    // every one of them is recorded: flow over part of the stretch (a start or a gap inside it) says nothing of the rest, which could turn it.
    let delta = 0, whole = true, first = i;
    for (let j = i; j >= 0 && starts[j]! > before[0]; j--) { const f = flows[j]; first = j; if (f) delta += f.delta; else whole = false; }
    if (starts[first]! - tfMs > before[0]) whole = false;
    let side = whole ? Math.sign(delta) : 0, known = whole;
    if (!whole && closeAt) { const a = closeAt(before[0]), b = closeAt(now[0]); if (a !== undefined && b !== undefined) { side = Math.sign(b - a); known = true; if (side) p.byPrice = true; } }
    const size = Math.abs(d);
    if (!known || side === 0) { if (known) p.un += size; else p.unknown += size; if (d > 0) p.up += size; else p.down += size; }
    else if (d > 0) { if (side > 0) p.lo += size; else p.so += size; }
    else if (side < 0) p.lc += size; else p.sc += size;
  }
  return parts;
}

/** How far before a candle's end a market's newest minute reading may be for its pieces to stand for the candle (a venue read every five minutes). */
export const FINE_FRESH_MS = 10 * 60_000;

/**
 * A market's parts in the chart's candles from its minute pieces, or null where they do not stand for a candle: worked out on its minute bars
 * and flow (no price: a minute with no flow says nothing), each minute's parts added into the candle it falls in. They stand for a candle when
 * the minute readings began before it and go on past it (or reach `now`), no reading in it came after a silence longer than the hold (its
 * change would be counted nowhere, where the reading per candle counts it), and every piece in it that changed open interest had its takers
 * recorded; elsewhere the candle keeps the reading per candle.
 */
function fineParts(starts: readonly number[], index: ReadonlyMap<number, number>, fine: NlnsFine, tfMs: number, holdMs: number, now: number): (Parts | null)[] {
  const bars = [...fine.bars].sort((a, b) => a[0] - b[0]), out: (Parts | null)[] = starts.map(() => null);
  if (bars.length < 2 || !fine.starts.length) return out;
  const minute = fine.starts.length > 1 ? fine.starts[1]! - fine.starts[0]! : 60_000;
  const pieces = marketParts(fine.starts, new Map(fine.starts.map((s, j) => [s, j] as const)), bars, fine.flows, null, minute, holdMs, tfMs);
  const sums = starts.map(noParts);
  pieces.forEach((q, j) => {
    if (!q.counted && !q.gap) return;
    const i = index.get(Math.floor(fine.starts[j]! / tfMs) * tfMs); if (i === undefined) return;
    const p = sums[i]!; p.gap ||= q.gap;
    if (!q.counted) return;
    // The candle starts from the reading before its first piece; it counts the market once.
    if (!p.counted) p.oiStart = q.oiStart;
    p.counted = 1; p.dOi += q.dOi; p.lo += q.lo; p.lc += q.lc; p.so += q.so; p.sc += q.sc; p.un += q.un; p.unknown += q.unknown; p.up += q.up; p.down += q.down;
    p.coarse ||= q.coarse;
  });
  const first = bars[0]![0], newest = bars[bars.length - 1]![0];
  starts.forEach((s, i) => { const p = sums[i]!; if (p.counted && !p.gap && first < s && p.unknown === 0 && newest >= Math.min(s + tfMs, now) - FINE_FRESH_MS) out[i] = p; });
  return out;
}

/**
 * One market's new longs and new shorts in each candle of `starts` (`tfMs` apart) from its minute pieces alone, null where they do not stand
 * for the candle (`fineParts`): the Funding pane's share of new positions opened by buyers, hour by hour.
 */
export function minuteOpens(starts: readonly number[], fine: NlnsFine, tfMs: number, now: number, holdMs = OI_HOLD_MS): ({ longOpened: number; shortOpened: number } | null)[] {
  return fineParts(starts, new Map(starts.map((s, i) => [s, i] as const)), fine, tfMs, holdMs, now).map(p => p ? { longOpened: p.lo, shortOpened: p.so } : null);
}

/**
 * The candles from `starts` (the chart's candle starts, oldest first): `closes` are the chart's candle closes by start (the price's way where a
 * market's flow is not recorded; empty when the chart's candles are another market's), `keys` the running sums' restart keys (they restart
 * where the key changes, and after a candle no market covers). `now`: how far the newest candle has come (a market's minute pieces stand
 * for it while they reach that far).
 */
export function nlnsModel(starts: readonly number[], markets: readonly NlnsMarket[], closes: ReadonlyMap<number, number>, keys: readonly number[], tfMs: number,
  holdMs = OI_HOLD_MS, now = Infinity): NlnsCandle[] {
  // Bars a candle apart are consecutive readings however long the candle (a 4-hour or daily chart's bars are 4 h or a day apart).
  const fineHold = holdMs;
  holdMs = Math.max(holdMs, tfMs);
  const index = new Map(starts.map((s, i) => [s, i] as const));
  const parts = starts.map(noParts), fine = new Array<number>(starts.length).fill(0);
  const carry = Math.max(2 * tfMs, 10 * 60_000), covered = new Array<number>(starts.length).fill(0);
  const closeAt = (time: number): number | undefined => { let best: number | undefined; for (let s = time; s >= time - holdMs; s -= tfMs) { best = closes.get(s); if (best !== undefined) break; } return best; };
  for (const market of markets) {
    const bars = [...market.bars].sort((a, b) => a[0] - b[0]);
    starts.forEach((s, i) => { if (heldOiAt(bars, s, carry, holdMs)) covered[i]!++; });
    const coarse = marketParts(starts, index, bars, market.flows, closeAt, tfMs, holdMs, tfMs);
    // Minute pieces only where a candle is longer than a minute: on a one-minute chart the candle is the piece.
    const pieces = market.fine && tfMs > 60_000 ? fineParts(starts, index, market.fine, tfMs, fineHold, now) : null;
    coarse.forEach((c, i) => {
      const q = pieces?.[i] ?? null, p = parts[i]!, use = q ?? c;
      if (q) fine[i]!++;
      p.counted += use.counted; p.dOi += use.dOi; p.oiStart += use.oiStart; p.lo += use.lo; p.lc += use.lc; p.so += use.so; p.sc += use.sc;
      p.un += use.un; p.unknown += use.unknown; p.up += use.up; p.down += use.down; p.byPrice ||= use.byPrice; p.coarse ||= use.coarse;
    });
  }
  const out: NlnsCandle[] = [];
  let cum = 0, cumLongs = 0, cumShorts = 0, key = NaN, gap = true, run = -1;
  starts.forEach((s, i) => {
    if (!covered[i]) { gap = true; return; }
    // As the CVD: a new day or week starts the sums again; after a candle not covered they carry on, in a run of their own.
    if (keys[i] !== key) { cum = 0; cumLongs = 0; cumShorts = 0; key = keys[i]!; gap = false; run++; }
    else if (gap) { gap = false; run++; }
    const p = parts[i]!, longs = p.lo - p.lc, shorts = p.so - p.sc, v = longs - shorts;
    const named: [NlnsKind, number][] = [['newLongs', p.lo], ['longsClosed', p.lc], ['newShorts', p.so], ['shortsClosed', p.sc]];
    const nonzero = named.filter(([, x]) => x > 0), bothWays = (p.lo + p.sc > 0) && (p.so + p.lc > 0);
    const kind: NlnsCandle['kind'] = !nonzero.length ? null : bothWays ? 'mixed' : nonzero.sort((a, b) => b[1] - a[1])[0]![0];
    cum += v; cumLongs += longs; cumShorts += shorts;
    out.push({ t: s, dOi: p.dOi, oiStart: p.oiStart, longOpened: p.lo, longClosed: p.lc, shortOpened: p.so, shortClosed: p.sc, unassigned: p.un, unknown: p.unknown,
      unsidedUp: p.up, unsidedDown: p.down, longs, shorts, v, kind,
      side: Math.sign(v) as 1 | -1 | 0, byPrice: p.byPrice, coarse: p.coarse, covered: covered[i]!, counted: p.counted, fine: fine[i]!, cum, cumLongs, cumShorts, run });
  });
  return out;
}

/**
 * The candles NL/NS works out for the view's `starts`: those of one hold before them first (a reading's change is given to the takers since
 * the reading before, which can be before the view), with restart keys that put them in a run of their own so the sums still start at the
 * view. Drop the candles before `starts[0]` from the model.
 */
export function withLead(starts: readonly number[], keys: readonly number[], tfMs: number, holdMs = OI_HOLD_MS): { all: number[]; keys: number[] } {
  if (!starts.length) return { all: [], keys: [] };
  const lead = Math.ceil(Math.max(holdMs, tfMs) / tfMs);
  return { all: [...Array.from({ length: lead }, (_, k) => starts[0]! - (lead - k) * tfMs), ...starts], keys: [...Array.from({ length: lead }, () => -Infinity), ...keys] };
}

/** An amount of coins, signed and short: "+325 BTC", "−1.2M DOGE". */
export function coinText(v: number, coin: string): string {
  const a = Math.abs(v), body = a === 0 ? '0' : a >= 1_000 ? usd(a) : a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(1) : a.toPrecision(2);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${body}${coin ? ` ${coin}` : ''}`;
}

/**
 * What a candle's change of open interest was made of, for the OI pane's bar: on a rise, the new longs (buyers opened), the new shorts (sellers
 * opened) and what went to no side; on a fall, the shorts closed (buyers closed), the longs closed (sellers closed) and what went to no side.
 */
export function whoParts(c: NlnsCandle, rising: boolean): { buy: number; sell: number; none: number } {
  return rising ? { buy: c.longOpened, sell: c.shortOpened, none: c.unsidedUp } : { buy: c.shortClosed, sell: c.longClosed, none: c.unsidedDown };
}

/** The OI pane's popup lines for who made a candle's change (NL/NS): its parts, what went to no side, and how it was read. */
export function nlnsWhoLines(c: NlnsCandle, coin: string): InfoLine[] {
  const lines: InfoLine[] = [];
  for (const [label, x, color] of [[t('New longs'), c.longOpened, 'buy'], [t('New shorts'), c.shortOpened, 'sell'], [t('Longs closed'), -c.longClosed, 'sell'], [t('Shorts closed'), -c.shortClosed, 'buy']] as const)
    if (x !== 0) lines.push({ label, text: coinText(x, coin), color });
  if (c.unassigned > 0) lines.push({ label: t('Takers even'), text: coinText(c.unassigned, coin), color: 'muted' });
  if (c.unknown > 0) lines.push({ label: t('Side unknown'), text: coinText(c.unknown, coin), color: 'muted' });
  if (lines.length) lines[0] = { ...lines[0]!, rule: true };
  if (c.fine > 0) lines.push({ text: c.fine < c.counted ? t('Minute by minute for {n} of {m} venues: each minute\'s change given to that minute\'s takers.', { n: c.fine, m: c.counted }) : t('Minute by minute: each minute\'s change given to that minute\'s takers.'), color: 'muted', wrap: true });
  if (c.byPrice) lines.push({ text: t('Where a market\'s flow is not recorded, the way the price went decides.'), color: 'muted', wrap: true });
  return lines;
}

const KIND_TEXT: Record<NlnsKind | 'mixed', () => string> = {
  newLongs: () => t('New longs'), newShorts: () => t('New shorts'), longsClosed: () => t('Longs closed'), shortsClosed: () => t('Shorts closed'), mixed: () => t('Both ways'),
};

/**
 * The popup of one candle: the change of open interest (and its share of it), its parts, what they come to for each side, the running sums,
 * and how it was read (the price where no flow was recorded, a stretch longer than the candle, markets that had no reading in it).
 */
export function nlnsCardLines(c: NlnsCandle, tf: string, coin: string, market: string, markets = 1): InfoLine[] {
  const share = c.oiStart > 0 ? ` · ${c.dOi >= 0 ? '+' : '−'}${(Math.abs(c.dOi) / c.oiStart * 100).toFixed(2)}%` : '';
  const lines: InfoLine[] = [
    { text: `${clock(c.t, true)} · ${tf}`, bold: true },
    { label: t('Open interest'), text: `${coinText(c.dOi, coin)}${share}`, bold: true },
    { label: t('Read as'), text: c.kind ? KIND_TEXT[c.kind]() : c.unassigned > 0 ? t('takers even') : c.unknown > 0 ? t('side unknown') : t('no change'), color: c.v > 0 ? 'buy' : c.v < 0 ? 'sell' : 'text' },
  ];
  for (const [label, x, color] of [[t('New longs'), c.longOpened, 'buy'], [t('Longs closed'), -c.longClosed, 'sell'], [t('New shorts'), c.shortOpened, 'sell'], [t('Shorts closed'), -c.shortClosed, 'buy']] as const)
    if (x !== 0) lines.push({ label, text: coinText(x, coin), color });
  if (c.unassigned > 0) lines.push({ label: t('Takers even'), text: coinText(c.unassigned, coin), color: 'muted' });
  // Neither the flow (not recorded over the whole stretch) nor the price (another market's candles) said which way.
  if (c.unknown > 0) lines.push({ label: t('Side unknown'), text: coinText(c.unknown, coin), color: 'muted' });
  lines.push(
    { label: t('Longs'), text: `${coinText(c.longs, coin)} · ${t('since the start')} ${coinText(c.cumLongs, coin)}`, color: c.longs > 0 ? 'buy' : c.longs < 0 ? 'sell' : 'text', rule: true },
    { label: t('Shorts'), text: `${coinText(c.shorts, coin)} · ${t('since the start')} ${coinText(c.cumShorts, coin)}`, color: c.shorts > 0 ? 'sell' : c.shorts < 0 ? 'buy' : 'text' },
    { label: t('Net'), text: `${coinText(c.v, coin)} · ${t('since the start')} ${coinText(c.cum, coin)}`, color: c.cum > 0 ? 'buy' : c.cum < 0 ? 'sell' : 'text' },
  );
  if (markets > 1 && c.covered < markets) lines.push({ text: t('{n} of {m} venues', { n: c.covered, m: markets }), color: 'muted' });
  // How it was worked out: minute by minute where the market's minute readings and flow cover the candle, else once for the candle.
  if (c.fine > 0) lines.push({ text: c.fine < c.counted ? t('Minute by minute for {n} of {m} venues: each minute\'s change given to that minute\'s takers.', { n: c.fine, m: c.counted }) : t('Minute by minute: each minute\'s change given to that minute\'s takers.'), color: 'muted', wrap: true });
  if (c.coarse) lines.push({ text: t('A market read less often than every candle: its change since its last reading is given to its takers over that whole stretch.'), color: 'muted', wrap: true });
  if (c.byPrice) lines.push({ text: t('Where a market\'s flow is not recorded, the way the price went decides.'), color: 'muted', wrap: true });
  lines.push({ text: t('An estimate for {market}: the change of open interest given to the side that traded at market.', { market }), color: 'muted', wrap: true });
  return lines;
}
