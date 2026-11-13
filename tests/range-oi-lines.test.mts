import test from 'node:test';
import assert from 'node:assert/strict';
import { OiRangeSummary, durationPair, type OiPaneHeld } from '../src/app/range/oi-lines.ts';
import { chainedOi, oiSumOf, type OiPart } from '../src/app/oi-change.ts';
import { oiCohorts } from '../src/app/panes/lower-panes.ts';
import type { OiBar } from '../src/app/store.ts';
import type { NlnsCandle } from '../src/app/delta/nlns.ts';
import type { RangeSelection } from '../src/app/range/selection.ts';
import type { Liquidation } from '../src/shared/liquidations.ts';

const H = 3_600_000, T = Date.UTC(2026, 10, 12, 0), KEY = 'binance:BTCUSDT|1h|all';
const bars = (values: number[], from = T): OiBar[] => values.map((v, i) => [from + i * H, v, v, v, v]);
const sel = (t0: number, t1: number, extra: Partial<RangeSelection> = {}): RangeSelection => ({ t0, t1, p0: null, p1: null, live: false, draft: false, pane: 'oi', step: H, ...extra });
const one = (oi: OiBar[], extra: Partial<OiPaneHeld> = {}): OiPaneHeld => ({ key: KEY, oi, tfMs: H, tf: '1h', venues: null, counted: null, cohorts: null, parts: [], who: null, whoOn: false, flag: null, candles: [], ownPrice: false, priceMarket: 'Binance BTCUSDT', coin: 'BTC', market: 'Binance BTCUSDT', ids: ['binance:BTCUSDT'], usdAt: 0, seam: null, replayAt: null, ...extra });
const text = (lines: ReturnType<OiRangeSummary['lines']>, key: string): string | undefined => lines.find(l => l.key === key)?.cells.join(' | ');
const NOW = T + 100 * H;

test('one market: the known change with its percentage, the level, and nothing pretended where nothing is known', () => {
  const summary = new OiRangeSummary();
  const lines = summary.lines(sel(T + H, T + 3 * H), one(bars([100, 104, 110, 98])), true, null, KEY, NOW);
  assert.equal(text(lines, 'oi-known'), 'Known change | +10 BTC · +10.00%');
  assert.equal(text(lines, 'oi-level'), 'Level | 100 → 110 BTC');
  assert.match(text(lines, 'oi-title')!, /2 candles of 1h$/);
  // Only the first bar held: its change is unknown, so there is no change to give (not "+0").
  const first = summary.lines(sel(T, T + H), one(bars([100, 104])), true, null, KEY, NOW);
  assert.equal(text(first, 'oi-known'), 'Known change | unavailable: no candle with a reading before it');
  assert.equal(text(first, 'oi-level'), undefined);
  assert.match(text(first, 'oi-status')!, /1 candle's change unknown/);
});

test('a snapshot of another market or timeframe is not summed up as this one', () => {
  const lines = new OiRangeSummary().lines(sel(T + H, T + 3 * H), one(bars([100, 104, 110])), false, null, 'binance:BTCUSDT|4h|all', NOW);
  assert.equal(text(lines, 'oi-stale'), 'The OI pane last drew another market or timeframe: show it to sum up this selection.');
  assert.equal(text(new OiRangeSummary().lines(sel(T, T + H), null, false, null, KEY, NOW), 'oi-none'), 'The OI pane has not drawn open interest for this market yet: show it to sum up this selection.');
  assert.equal(text(new OiRangeSummary().lines(sel(T, T + H), null, true, null, KEY, NOW), 'oi-none'), 'No open-interest history for this market yet.', 'a pane shown is not told to show itself');
  assert.equal(text(lines, 'oi-known'), undefined);
});

test('venues added together: the percentage only while the same venues make every change and the newest bar, levels and changes said apart', () => {
  // Bybit's readings begin at the third bar: the chained level's start holds it, the change of the first two bars does not.
  const parts: OiPart[] = [{ id: 'binance:BTCUSDT', bars: bars([100, 102, 101, 105, 107]) }, { id: 'bybit:BTCUSDT', bars: bars([50, 53, 54], T + 2 * H) }];
  const sum = oiSumOf(parts, H), oi = chainedOi(sum);
  const held: OiPaneHeld = { ...one(oi), venues: sum.venues, counted: oi.map(b => sum.counted.get(b[0]) ?? 0), cohorts: oiCohorts(oi, parts, H), parts, market: null, ids: parts.map(p => p.id) };
  const summary = new OiRangeSummary();
  const early = summary.lines(sel(T + H, T + 3 * H), held, true, null, KEY, NOW);
  assert.equal(text(early, 'oi-known'), 'Known change | +1.0 BTC', 'made of Binance alone while the newest bar holds both: no percentage');
  assert.equal(text(early, 'oi-level'), 'Combined level | 150 → 151 BTC');
  assert.match(text(early, 'oi-status')!, /^OI from 1–2 of 2 venues \(changes from 1\)/);
  const late = summary.lines(sel(T + 3 * H, T + 5 * H), held, true, null, KEY, NOW);
  assert.match(text(late, 'oi-known')!, /^Known change \| \+10 BTC · \+6\.\d\d%$/, 'both venues throughout, as at the newest bar: Binance +4 +2, Bybit +3 +1');
  assert.equal(text(late, 'oi-status'), '2 venues added together');
  assert.deepEqual(late.filter(l => l.kind === 'signed').map(l => l.cells[1]), ['+6.0', '+4.0']);
});

test('a venue with no candle of the stretch it could be counted in is unavailable, not 0', () => {
  const parts: OiPart[] = [{ id: 'binance:BTCUSDT', bars: bars([100, 102, 101, 105]) }, { id: 'okx:BTC-USDT-SWAP', bars: bars([30], T + 3 * H) }];
  const sum = oiSumOf(parts, H), oi = chainedOi(sum);
  const held: OiPaneHeld = { ...one(oi), venues: sum.venues, counted: oi.map(b => sum.counted.get(b[0]) ?? 0), cohorts: oiCohorts(oi, parts, H), parts, market: null, ids: parts.map(p => p.id) };
  const lines = new OiRangeSummary().lines(sel(T + H, T + 4 * H), held, true, null, KEY, NOW);
  assert.equal(text(lines, 'oi-v-okx:BTC-USDT-SWAP'), 'OKX | unavailable');
});

test('NL/NS: added and reduced on one scale with their shares, the difference from the known change, and the result kept once the candles leave the view', () => {
  const oi = bars([100, 110, 105]);
  const c = (t: number, lo: number, so: number, lc: number, sc: number): NlnsCandle => ({ t, dOi: lo + so - lc - sc, oiStart: 0, longOpened: lo, shortOpened: so, longClosed: lc, shortClosed: sc, unassigned: 0, unknown: 0, unsidedUp: 0, unsidedDown: 0, longs: 0, shorts: 0, v: 0, kind: null, side: 0, byPrice: false, coarse: false, covered: 1, counted: 1, fine: 1, cum: 0, cumLongs: 0, cumShorts: 0, run: 0 });
  const who = new Map([c(T + H, 9, 3, 1, 1), c(T + 2 * H, 1, 0, 4, 2)].map(x => [x.t, x] as const));
  const summary = new OiRangeSummary(), s = sel(T + H, T + 3 * H);
  const lines = summary.lines(s, one(oi, { who }), true, null, KEY, NOW);
  assert.equal(text(lines, 'oi-added'), 'Added | +13');
  assert.equal(text(lines, 'oi-reduced'), 'Reduced | −8.0');
  assert.deepEqual(lines.find(l => l.key === 'oi-reduced')!.parts!.map(p => [p.tone, p.closed, +p.size.toFixed(3)]), [['up', true, 0.231], ['down', true, 0.385], ['none', true, 0], ['gap', undefined, 0.385]], 'on the scale of the larger, Added, and runs on to its end hatched: the net');
  const gap = lines.find(l => l.key === 'oi-reduced')!.parts!.at(-1)!;
  assert.equal(gap.text, 'net +5.0', 'its figure inside');
  assert.equal(lines.find(l => l.key === 'oi-added')!.parts!.some(p => p.tone === 'gap'), false, 'the longer bar has none');
  assert.equal(text(lines, 'oi-opened'), 'New longs · new shorts | +10 BTC (77%) · +3.0 BTC (23%)');
  assert.equal(text(lines, 'oi-who-diff'), undefined, 'the estimate\'s net +5 is the known change');
  // The view moved on: the pane's model holds one of the two candles. The full result stays, said so.
  const partial = new Map([[T + 2 * H, who.get(T + 2 * H)!]]);
  const later = summary.lines(s, one(oi, { who: partial }), true, null, KEY, NOW);
  assert.equal(text(later, 'oi-added'), 'Added | +13');
  assert.equal(text(later, 'oi-who-kept'), 'As worked out while these candles were in view.');
  // Another selection has no result kept: what the model holds now, and how much of the stretch it covers.
  const other = new OiRangeSummary().lines(s, one(oi, { who: partial }), true, null, KEY, NOW);
  assert.equal(text(other, 'oi-who-candles'), 'NL/NS for 1 of the 2 candles (worked out for those in view).');
  assert.equal(text(other, 'oi-who-diff'), undefined, 'the one candle held agrees with its bar (review: it was compared with the whole stretch)');
  // Over the candles it holds, an estimate that parts from the bars says so, of those candles.
  const off = new Map([[T + 2 * H, { ...who.get(T + 2 * H)!, longOpened: 3, dOi: -3 }]]);
  assert.equal(text(new OiRangeSummary().lines(s, one(oi, { who: off }), true, null, KEY, NOW), 'oi-who-diff'), 'Over those candles: estimate net −3.0 BTC; known change −5.0 BTC; difference +2.0 BTC.');
  // Bars on NL/NS but no candle of the stretch in view: not the Net hint.
  const away = new OiRangeSummary().lines(s, one(oi, { who: null, whoOn: true }), true, null, KEY, NOW);
  assert.equal(text(away, 'oi-who-none'), 'NL/NS is worked out for the candles in view: none of this stretch is in view.');
  assert.equal(text(new OiRangeSummary().lines(s, one(oi), true, null, KEY, NOW), 'oi-who-off'), "Set the OI pane's Bars to NL/NS for what was added and reduced.");
});

test('a live stretch is forming and not compared; the half of the movement says so far', () => {
  const oi = bars([100, 101, 103, 104, 110, 112, 111]);
  const now = T + 6 * H + 600_000, live = sel(T + 4 * H, T + 7 * H, { live: true });
  const lines = new OiRangeSummary().lines(live, one(oi), true, null, KEY, now);
  assert.match(text(lines, 'oi-title')!, / · forming$/);
  assert.equal(text(lines, 'oi-before'), undefined);
  assert.equal(text(lines, 'oi-rank'), undefined);
  assert.equal(text(lines, 'oi-half'), 'Half the movement came in | 1 of 3 candles so far');
  const closed = new OiRangeSummary().lines(sel(T + 3 * H, T + 5 * H), one(oi), true, null, KEY, now);
  assert.equal(text(closed, 'oi-before'), 'Previous 2 candles (2 h) | +3.0 BTC');
  assert.equal(text(closed, 'oi-rank'), 'Rank among the 2-candle windows held | #2 of 4 by size of change (closed, overlapping windows)', 'the forming candle is in no window: (1,2) +3, (2,3) +3, this +7, (4,5) +8');
});

test('review r3: comparable windows are made of the same markets, not merely as many; liquidations only where they were read', () => {
  // Market A's readings end where market B's begin: each window of one candle is made of one market, but not the same one.
  const parts: OiPart[] = [{ id: 'a:X', bars: bars([100, 101, 103, 104]) }, { id: 'b:X', bars: bars([50, 52, 55, 56], T + 6 * H) }];
  const sum = oiSumOf(parts, H), oi = chainedOi(sum);
  const held: OiPaneHeld = { ...one(oi), venues: sum.venues, counted: oi.map(b => sum.counted.get(b[0]) ?? 0), cohorts: oiCohorts(oi, parts, H), parts, market: null, ids: parts.map(p => p.id) };
  const late = new OiRangeSummary().lines(sel(T + 8 * H, T + 9 * H), held, true, null, KEY, NOW);
  assert.equal(text(late, 'oi-rank'), 'Rank among the 1-candle windows held | #1 of 3 by size of change (closed, overlapping windows)', "only market B's three one-candle windows (+2, this +3, +1), none of A's (counting venues alone took six)");
  // Liquidations: read for a window that does not reach the stretch, nothing is said of them but that.
  const liq = { items: [], version: 0, min: 1000, held: { t0: T + 7 * H, t1: T + 20 * H, min: 1000, cut: false, live: false } };
  assert.equal(text(new OiRangeSummary().lines(sel(T + 6 * H, T + 9 * H), held, true, liq, KEY, NOW), 'oi-liq'), 'Liquidations reported | not held for this stretch');
  assert.equal(text(new OiRangeSummary().lines(sel(T + 8 * H, T + 9 * H), held, true, liq, KEY, NOW), 'oi-liq'), 'Liquidations reported | none reported from $1K');
});

test('review cr2: the percentage needs the same markets throughout, not as many; a liquidation added in place shows within the second', () => {
  // Market A alone makes the stretch, market B alone the newest bar: one venue each, but the chained start is built back from B's total.
  const parts: OiPart[] = [{ id: 'a:X', bars: bars([100, 101, 103, 104]) }, { id: 'b:X', bars: bars([50, 52, 55, 56], T + 6 * H) }];
  const sum = oiSumOf(parts, H), oi = chainedOi(sum);
  const held: OiPaneHeld = { ...one(oi), venues: sum.venues, counted: oi.map(b => sum.counted.get(b[0]) ?? 0), cohorts: oiCohorts(oi, parts, H), parts, market: null, ids: parts.map(p => p.id) };
  const lines = new OiRangeSummary().lines(sel(T + H, T + 4 * H), held, true, null, KEY, NOW);
  assert.equal(text(lines, 'oi-known'), 'Known change | +4.0 BTC', 'no percentage of a level made of another market (it read +8.70%)');
  // In-place growth of the liquidation book within the same second: its version says so.
  const items: Liquidation[] = [], window = { t0: T, t1: T + 20 * H, min: 1000, cut: false, live: false }, summary = new OiRangeSummary();
  const at = (version: number) => text(summary.lines(sel(T + H, T + 4 * H), held, true, { items, version, min: 1000, held: window }, KEY, NOW), 'oi-liq');
  assert.equal(at(1), 'Liquidations reported | none reported from $1K');
  items.push({ t: T + 2 * H, id: 'a:X', side: 'long', price: 100, usd: 5_000_000, reported: 100, kind: 'fill' } as Liquidation);
  assert.equal(at(2), 'Liquidations reported | $5M longs · $0 shorts (from $1K)');
});

test('a covered part and its span in one unit: hours with hours, days with days, a sliver under a minute', () => {
  const H = 3_600_000;
  assert.deepEqual(durationPair(21 * H, 51 * H), { k: '0.9 days', n: '2.1 days' }, 'never 21 h of 2.1 days');
  assert.deepEqual(durationPair(23 * H, 40 * H), { k: '23 h', n: '40 h' });
  assert.deepEqual(durationPair(30 * 60_000, 90 * 60_000), { k: '30 min', n: '90 min' });
  assert.deepEqual(durationPair(20_000, 40 * H), { k: 'under 1 min', n: '40 h' });
  assert.deepEqual(durationPair(2 * 60_000, 40 * H), { k: '2 min', n: '40 h' }, 'a part too small for the unit says its own size, never 0 h');
  assert.deepEqual(durationPair(70 * 60_000, 51 * H), { k: '70 min', n: '2.1 days' }, 'never 0.0 days');
});
