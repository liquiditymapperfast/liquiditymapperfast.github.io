import test from 'node:test';
import assert from 'node:assert/strict';
import { DeltaRangeSummary, deltaStretch, usdPair, type DeltaPaneHeld } from '../src/app/range/delta-lines.ts';
import { oiStretch } from '../src/app/range/oi-summary.ts';
import { deltaCandles, type CandleFlow } from '../src/app/delta/candles.ts';
import type { NlnsCandle } from '../src/app/delta/nlns.ts';
import type { CandleRow, OiBar } from '../src/app/store.ts';
import type { RangeSelection } from '../src/app/range/selection.ts';
import { readFileSync } from 'node:fs';

const H = 3_600_000, T = Date.UTC(2026, 10, 12, 0), KEY = 'binance:BTCUSDT|1h|cvd|net|day|UTC|a,b';
const sel = (t0: number, t1: number, extra: Partial<RangeSelection> = {}): RangeSelection => ({ t0, t1, p0: null, p1: null, live: false, draft: false, pane: 'delta', step: H, ...extra });
const flow = (delta: number, gross: number): CandleFlow => ({ delta, gross, low: Math.min(0, delta), high: Math.max(0, delta) });
/** A held snapshot of candles an hour apart from T: their deltas and volumes (null: no flow), one run per `keys` value, two markets. */
function held(rows: ([number, number] | null)[], extra: Partial<DeltaPaneHeld> = {}, keys = rows.map(() => 0)): DeltaPaneHeld {
  const starts = rows.map((_, i) => T + i * H), flows = rows.map(r => r ? flow(r[0], r[1]) : null);
  return { key: KEY, mode: 'cvd', tfMs: H, tf: '1h', reset: 'day', starts, flows, raw: flows, candles: new Map(deltaCandles(starts, flows, keys).map(c => [c.t, c] as const)), support: rows.map(() => 2), markets: 2, earliest: T, firsts: [0, 0],
    candlesPrice: [], ownPrice: false, priceMarket: 'Binance BTCUSDT', nlns: null, whose: '', coin: 'BTC', replayAt: null, ...extra };
}
const text = (lines: ReturnType<DeltaRangeSummary['lines']>, key: string): string | undefined => lines.find(l => l.key === key)?.cells.join(' | ');
const NOW = T + 100 * H;

test('the flow of the candles that start in the selection: delta and volume added up, bought and sold made of them, how the delta was spread', () => {
  const h = held([[5, 50], [10, 100], [-4, 40], [20, 200], [1, 10]]);
  const s = deltaStretch(h, { t0: T + H, t1: T + 4 * H })!;
  assert.deepEqual([s.bars, s.held, s.delta, s.volume, s.bought, s.sold], [3, 3, 26, 340, 183, 157]);
  assert.deepEqual([s.buying, s.selling, s.flat, s.half, s.movement], [2, 1, 0, 1, 34], 'the +20 alone is more than half of 34');
  assert.deepEqual(s.largest, { t: T + 3 * H, delta: 20 });
  assert.equal(s.before, null, 'three candles before do not exist (one only)');
  const lines = new DeltaRangeSummary().lines(sel(T + H, T + 4 * H), h, true, KEY, NOW);
  assert.equal(text(lines, 'dl-delta'), 'Delta | +$26 · +7.6% of the volume');
  assert.equal(text(lines, 'dl-split'), 'Bought $183 | Sold $157');
  assert.equal(text(lines, 'dl-offset'), 'Cancellation between candle deltas | 24%', '1 − 26/34');
  assert.equal(text(lines, 'dl-count'), 'Candle delta signs | 2 buying · 1 selling · 0 flat');
  assert.equal(text(lines, 'dl-status'), 'Recorded taker flow of 2 markets of the flow column');
});

test('the CVD level is given only inside one daily or weekly run; from the left edge or across a restart, the change alone', () => {
  const rows: [number, number][] = [[5, 50], [10, 100], [-4, 40], [20, 200]];
  const one = new DeltaRangeSummary().lines(sel(T + H, T + 3 * H), held(rows), true, KEY, NOW);
  assert.equal(text(one, 'dl-cvd'), 'Recorded CVD, before → after selection | +$5 → +$11', 'opens where the run stood (+5), closes after +10 −4');
  assert.equal(text(new DeltaRangeSummary().lines(sel(T + H, T + 3 * H), held(rows, { reset: 'none' }), true, KEY, NOW), 'dl-cvd'), undefined, 'from the left edge the level moves with the view');
  const across = new DeltaRangeSummary().lines(sel(T + H, T + 3 * H), held(rows, {}, [0, 0, 1, 1]), true, KEY, NOW);
  assert.equal(text(across, 'dl-cvd'), undefined);
  assert.match(text(across, 'dl-status')!, /the CVD starts again inside it/);
});

test('the candles just before count only with the same markets, each a candle apart and all with flow; a forming stretch has none', () => {
  const h = held([[1, 10], [2, 20], [3, 30], [4, 40]]);
  assert.equal(deltaStretch(h, { t0: T + 2 * H, t1: T + 4 * H })!.before, 3);
  assert.equal(deltaStretch({ ...h, support: [1, 2, 2, 2] }, { t0: T + 2 * H, t1: T + 4 * H })!.before, null, 'one market fewer before');
  assert.equal(deltaStretch({ ...h, flows: [h.flows[0]!, null, h.flows[2]!, h.flows[3]!] }, { t0: T + 2 * H, t1: T + 4 * H })!.before, null);
  const live = new DeltaRangeSummary().lines(sel(T + 2 * H, T + 4 * H, { live: true }), h, true, KEY, T + 3 * H + 60_000);
  assert.equal(text(live, 'dl-before'), undefined);
  assert.match(text(live, 'dl-title')!, / · forming$/);
});

test('a closed selection keeps its result when the pane holds fewer of its candles (the view moved); another key is not summed up', () => {
  const summary = new DeltaRangeSummary(), s = sel(T + H, T + 3 * H), h = held([[5, 50], [10, 100], [-4, 40]]);
  assert.equal(text(summary.lines(s, h, true, KEY, NOW), 'dl-delta'), 'Delta | +$6 · +4.2% of the volume');
  const moved = held([[-4, 40]].map(r => r as [number, number]), { starts: [T + 2 * H] });
  const later = summary.lines(s, { ...moved, flows: [flow(-4, 40)], raw: [flow(-4, 40)], support: [2] }, true, KEY, NOW);
  assert.equal(text(later, 'dl-delta'), 'Delta | +$6 · +4.2% of the volume', 'the two candles as they were held');
  assert.equal(text(later, 'dl-kept'), 'As worked out while these candles were in view.');
  assert.match(text(summary.lines(s, h, true, 'binance:BTCUSDT|4h|cvd|net|day|UTC|a,b', NOW), 'dl-stale')!, /another market, timeframe or setting/);
});

test('delta against the price: said where they went opposite ways and the delta is at least 5 % of the volume, as no proof of absorption', () => {
  const price: CandleRow[] = [[T + H, 100, 101, 98, 99, 1], [T + 2 * H, 99, 99, 96, 97, 1]];
  const h = held([[0, 0], [10, 100], [5, 50]], { candlesPrice: price, ownPrice: true });
  const lines = new DeltaRangeSummary().lines(sel(T + H, T + 3 * H), h, true, KEY, NOW);
  assert.equal(text(lines, 'dl-price'), 'Price, Binance BTCUSDT | 100.00 → 97.00 · −3.00%');
  assert.equal(text(lines, 'dl-against'), 'Net buying while the price fell: taker flow against the price, not proof that resting orders absorbed it.');
  const thin = held([[0, 0], [1, 100], [1, 100]], { candlesPrice: price, ownPrice: true });
  assert.equal(text(new DeltaRangeSummary().lines(sel(T + H, T + 3 * H), thin, true, KEY, NOW), 'dl-against'), undefined, '1 % of the volume is no reading');
});

test('NL/NS: the Delta pane gives the same added and reduced as the OI pane for the same candles, and the longs\' and shorts\' net', () => {
  const c = (t: number, lo: number, so: number, lc: number, sc: number): NlnsCandle => ({ t, dOi: lo + so - lc - sc, oiStart: 0, longOpened: lo, shortOpened: so, longClosed: lc, shortClosed: sc, unassigned: 0, unknown: 0, unsidedUp: 0, unsidedDown: 0, longs: lo - lc, shorts: so - sc, v: 0, kind: null, side: 0, byPrice: false, coarse: false, covered: 1, counted: 1, fine: 1, cum: 0, cumLongs: 0, cumShorts: 0, run: 0 });
  const model = [c(T + H, 9, 3, 1, 1), c(T + 2 * H, 1, 0, 4, 2)], byStart = new Map(model.map(x => [x.t, x] as const));
  const h: DeltaPaneHeld = { ...held([null, null, null]), mode: 'nlns', starts: [T, T + H, T + 2 * H], flows: [], raw: [], support: [], nlns: byStart, whose: '6 venues added together' };
  const d = deltaStretch(h, { t0: T + H, t1: T + 3 * H })!.who!;
  const oi: OiBar[] = [[T, 100, 100, 100, 100], [T + H, 110, 110, 110, 110], [T + 2 * H, 105, 105, 105, 105]];
  const o = oiStretch({ oi, change: new Map([[T + H, 10], [T + 2 * H, -5]]), i0: 1, i1: 2, tfMs: H, venues: null, counted: null, parts: [], who: byStart, candles: [], ownPrice: false, usd: null, flag: null })!.who!;
  assert.deepEqual([d.added, d.reduced, d.longOpened, d.shortClosed], [o.added, o.reduced, o.longOpened, o.shortClosed], 'one sum (sumWho) for both panes');
  const lines = new DeltaRangeSummary().lines(sel(T + H, T + 3 * H), h, true, KEY, NOW);
  assert.equal(text(lines, 'dl-added'), 'Added | +13');
  assert.equal(text(lines, 'dl-nets'), 'Longs net · shorts net | +5.0 BTC · 0 BTC');
  assert.equal(text(lines, 'dl-status'), '6 venues added together');
});

test('review: a replay counts only candles closed by its moment; a stretch with a candle without flow is kept; NL/NS candles without open interest are not "outside the view"', () => {
  // Replay at 03:20 (the bar under way starts 03:00): a selection 01:00-06:00 holds 01:00 and 02:00 only, and nothing is outside the view.
  const h = held([[1, 10], [2, 20], [3, 30], [4, 40]], { replayAt: T + 3 * H });
  const s = deltaStretch(h, { t0: T + H, t1: T + 6 * H })!;
  assert.deepEqual([s.bars, s.expected, s.delta], [2, 2, 5]);
  const lines = new DeltaRangeSummary().lines(sel(T + H, T + 6 * H), h, true, KEY, T + 3 * H + 20 * 60_000);
  assert.equal(text(lines, 'dl-partial'), undefined);
  assert.match(text(lines, 'dl-status')!, /replay: candles closed by/);
  // A candle without flow inside: the result is still kept when the view moves away.
  const summary = new DeltaRangeSummary(), gap = held([[1, 10], null, [3, 30]]);
  assert.equal(text(summary.lines(sel(T, T + 3 * H), gap, true, KEY, NOW), 'dl-delta'), 'Delta | +$4 · +10% of the volume');
  const moved = { ...gap, starts: [T + 2 * H], flows: [gap.flows[2]!], raw: [gap.raw[2]!], support: [2] };
  const later = summary.lines(sel(T, T + 3 * H), moved, true, KEY, NOW);
  assert.equal(text(later, 'dl-delta'), 'Delta | +$4 · +10% of the volume');
  assert.equal(text(later, 'dl-kept'), 'As worked out while these candles were in view.');
  // NL/NS: the snapshot is on the candles asked for; one with no open interest is a candle without NL/NS, not one outside the view.
  const c = (t: number): NlnsCandle => ({ t, dOi: 1, oiStart: 0, longOpened: 1, shortOpened: 0, longClosed: 0, shortClosed: 0, unassigned: 0, unknown: 0, unsidedUp: 0, unsidedDown: 0, longs: 1, shorts: 0, v: 0, kind: null, side: 0, byPrice: false, coarse: false, covered: 1, counted: 1, fine: 1, cum: 0, cumLongs: 0, cumShorts: 0, run: 0 });
  const nl: DeltaPaneHeld = { ...held([null, null, null]), mode: 'nlns', flows: [], raw: [], support: [], nlns: new Map([[T + 2 * H, c(T + 2 * H)]]), whose: 'x' };
  const nlLines = new DeltaRangeSummary().lines(sel(T, T + 3 * H), nl, true, KEY, NOW);
  assert.equal(text(nlLines, 'dl-partial'), undefined);
  assert.equal(text(nlLines, 'dl-who-candles'), 'NL/NS for 1 of the 3 candles: the others have no change of open interest held.');
});

test('Sol r4: kept even when the pane holds none of the candles; the opposite note and the stretch before need the whole selection; the CVD pair in one unit', () => {
  const summary = new DeltaRangeSummary(), s = sel(T, T + 2 * H), h = held([[5, 50], [10, 100], [1, 10], [1, 10]]);
  assert.equal(text(summary.lines(s, h, true, KEY, NOW), 'dl-delta'), 'Delta | +$15 · +10% of the volume');
  const away = { ...h, starts: [T + 3 * H], flows: [h.flows[3]!], raw: [h.raw[3]!], support: [2] };
  const later = summary.lines(s, away, true, KEY, NOW);
  assert.equal(text(later, 'dl-delta'), 'Delta | +$15 · +10% of the volume', 'no candle of it in view: still the kept result');
  assert.equal(text(later, 'dl-kept'), 'As worked out while these candles were in view.');
  // Partial: two of three candles held (no kept result): no opposite note, no stretch before.
  const price: CandleRow[] = [[T + H, 100, 101, 98, 99, 1], [T + 2 * H, 99, 99, 96, 97, 1]];
  const part = held([[0, 0], [10, 100], [5, 50]], { candlesPrice: price, ownPrice: true });
  const partial = { ...part, starts: part.starts.slice(1), flows: part.flows.slice(1), raw: part.raw.slice(1), support: part.support.slice(1) };
  const lines = new DeltaRangeSummary().lines(sel(T + H, T + 4 * H), partial, true, KEY, NOW);
  assert.equal(text(lines, 'dl-against'), undefined, 'the third candle is not held');
  assert.match(text(lines, 'dl-partial')!, /holds 2 of the 3 candles/);
  assert.equal(usdPair(-763_800_000, -1_390_000_000), '−$763.8M → −$1,390.0M');
  assert.equal(usdPair(5, 11), '+$5 → +$11');
});

test('review dcr2: a kept result with flowless candles gives way once older flow loaded; NL/NS without open interest says so; the replay key holds a stretch before it', () => {
  // Kept with two of three candles without flow; a market's first recorded second then moves back and the view moves: the old figure is not shown.
  const summary = new DeltaRangeSummary(), s = sel(T, T + 3 * H), early = held([null, null, [5, 50]]);
  assert.equal(text(summary.lines(s, early, true, KEY, NOW), 'dl-delta'), 'Delta | +$5 · +10% of the volume');
  const moved = { ...early, firsts: [-3600, 0], starts: [T + 2 * H], flows: [early.flows[2]!], raw: [early.raw[2]!], support: [2] };
  const later = summary.lines(s, moved, true, KEY, NOW);
  assert.equal(text(later, 'dl-kept'), undefined, 'the result from before the load is dropped');
  assert.match(text(later, 'dl-partial')!, /holds 1 of the 3 candles/);
  // NL/NS, a market with no change of open interest held: no empty status, no "in view".
  const nl: DeltaPaneHeld = { ...held([null, null, null]), mode: 'nlns', flows: [], raw: [], support: [], nlns: new Map(), whose: '' };
  const nlLines = new DeltaRangeSummary().lines(sel(T, T + 3 * H), nl, true, KEY, NOW);
  assert.equal(text(nlLines, 'dl-status'), undefined);
  assert.equal(text(nlLines, 'dl-who-none'), 'No change of open interest is held for these candles yet.');
  // Replay: a closed stretch before the moment keeps its result when the replay moves on a candle with the view partial.
  const r = new DeltaRangeSummary(), rs = sel(T, T + 2 * H), full = held([[1, 10], [2, 20], [3, 30], [4, 40]], { replayAt: T + 3 * H });
  r.lines(rs, full, true, KEY, NOW);
  const on = { ...full, replayAt: T + 4 * H, starts: [T + H, T + 2 * H, T + 3 * H], flows: full.flows.slice(1), raw: full.raw.slice(1), support: full.support.slice(1) };
  assert.equal(text(r.lines(rs, on, true, KEY, NOW), 'dl-kept'), 'As worked out while these candles were in view.');
  // The shares are cut to one decimal, never rounded up over the 5 % rule.
  const edge = held([[0, 0], [499, 10_000]]);
  assert.equal(text(new DeltaRangeSummary().lines(sel(T + H, T + 2 * H), edge, true, KEY, NOW), 'dl-delta'), 'Delta | +$499 · +4.9% of the volume');
});

test('every pack keeps the en dash between {lo} and {hi} (the "3 of 4 markets" wording collapses an equal range on it)', () => {
  const key = "Recorded taker flow of {lo}–{hi} of the flow column's {n} markets";
  for (const code of ['de', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'tr', 'uk', 'zh']) {
    const pack = JSON.parse(readFileSync(`src/app/i18n/${code}.json`, 'utf8')) as Record<string, string>;
    assert.ok(pack[key]?.includes('{lo}–{hi}'), `${code}: ${pack[key]}`);
  }
});

test('review dcr3: a kept result stays through unrelated loads (NL/NS always; flow while no market reaches back further); the view wholly elsewhere says so', () => {
  // CVD with candles that can never have flow: something unrelated loads (firsts unchanged), the view moves wholly away: still kept.
  const summary = new DeltaRangeSummary(), s = sel(T, T + 3 * H), h = held([null, null, [5, 50], [1, 10]]);
  assert.equal(text(summary.lines(s, h, true, KEY, NOW), 'dl-delta'), 'Delta | +$5 · +10% of the volume');
  const away = { ...h, starts: [T + 3 * H], flows: [h.flows[3]!], raw: [h.raw[3]!], support: [2] };
  assert.equal(text(summary.lines(s, away, true, KEY, NOW), 'dl-kept'), 'As worked out while these candles were in view.');
  // NL/NS: kept, then the view wholly away: still kept.
  const c = (t: number): NlnsCandle => ({ t, dOi: 2, oiStart: 0, longOpened: 2, shortOpened: 0, longClosed: 0, shortClosed: 0, unassigned: 0, unknown: 0, unsidedUp: 0, unsidedDown: 0, longs: 2, shorts: 0, v: 0, kind: null, side: 0, byPrice: false, coarse: false, covered: 1, counted: 1, fine: 1, cum: 0, cumLongs: 0, cumShorts: 0, run: 0 });
  const nl: DeltaPaneHeld = { ...held([null, null, null, null]), mode: 'nlns', flows: [], raw: [], support: [], firsts: [], nlns: new Map([0, 1, 2].map(i => [T + i * H, c(T + i * H)] as const)), whose: 'x' };
  const ns = new DeltaRangeSummary();
  assert.equal(text(ns.lines(s, nl, true, KEY, NOW), 'dl-added'), 'Added | +6.0');
  const nlAway = { ...nl, starts: [T + 3 * H], nlns: new Map([[T + 3 * H, c(T + 3 * H)]]) };
  assert.equal(text(ns.lines(s, nlAway, true, KEY, NOW), 'dl-added'), 'Added | +6.0');
  // Never kept (live) and the view wholly elsewhere: the candles are outside the view, not missing.
  const live = new DeltaRangeSummary().lines(sel(T, T + 3 * H, { live: true }), away, true, KEY, T + 2 * H + 60_000);
  assert.equal(text(live, 'dl-none'), 'The pane holds 0 of the 3 candles: the rest are outside the view.');
  // The CVD pair: a run opening at 0, and a small first value.
  assert.equal(usdPair(0, 1_390_000_000), '$0 → +$1.4B');
  assert.equal(usdPair(12_300, 763_800_000), '+$12.3K → +$763.8M', 'a thousand times apart: each as usual');
  assert.equal(usdPair(500, 763_800_000), '+$500 → +$763.8M');
});

test('review dcr4: only a first reaching back drops a kept result (not one moving later, nor a drawing that held nothing); partial markets count; the CVD pair never reads the same twice', () => {
  const summary = new DeltaRangeSummary(), s = sel(T, T + 3 * H), h = held([null, [2, 20], [5, 50], [1, 10]], { support: [0, 1, 1, 2] });
  summary.lines(s, h, true, KEY, NOW);
  const later = { ...h, firsts: [3600, 0], starts: [T + 3 * H], flows: [h.flows[3]!], raw: [h.raw[3]!], support: [2] };
  assert.equal(text(summary.lines(s, later, true, KEY, NOW), 'dl-kept'), 'As worked out while these candles were in view.', 'a first moving later');
  const nothing = { ...h, firsts: [] as number[], starts: [], flows: [], raw: [], support: [] };
  assert.equal(text(summary.lines(s, nothing, true, KEY, NOW), 'dl-kept'), 'As worked out while these candles were in view.', 'a drawing that held nothing');
  // Every candle had flow but not from every market: once the second market reaches back, the kept figure gives way.
  const p = new DeltaRangeSummary(), part = held([[1, 10], [2, 20], [3, 30]], { support: [1, 1, 2] });
  p.lines(sel(T, T + 3 * H), part, true, KEY, NOW);
  const back = { ...part, firsts: [0, -7200], starts: [T + 2 * H], flows: [part.flows[2]!], raw: [part.raw[2]!], support: [2] };
  assert.equal(text(p.lines(sel(T, T + 3 * H), back, true, KEY, NOW), 'dl-kept'), undefined);
  assert.equal(usdPair(12_345_678, 12_300_000), '+$12.35M → +$12.30M');
});
