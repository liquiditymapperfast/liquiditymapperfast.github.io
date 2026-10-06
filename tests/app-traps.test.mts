import test from 'node:test';
import assert from 'node:assert/strict';
import { TRAP_PARAMS, TRAP_VERSION, TrapData, canonicalStep, detectSide, factsOf, imbalanceOf, judgeCandle, recordedShare, scanTraps, stepFor, trapStatusText, trapText, trapVerdict, typicalDelta, typicalRange, wickShareOf, type BarFacts } from '../src/app/traps.ts';
import type { Bar } from '../src/app/panes/footprint.ts';
import type { CandleRow } from '../src/app/store.ts';

const TF = 3_600_000, T0 = 1_000 * TF;
type Rows = [number, number, number][];
/** What the exchange would report as the candle's volume for these rows at a step of 1: the base units the footprint holds. */
const baseOf = (rows: Rows): number => rows.reduce((s, [low, buy, sell]) => s + (buy + sell) / (low + 0.5), 0);
const bar = (t: number, rows: Rows, minutes = 60): Bar => ({ t, rows, buyUsd: rows.reduce((s, r) => s + r[1], 0), sellUsd: rows.reduce((s, r) => s + r[2], 0), minutes });
/** A candle whose reported volume is `volume` (by default exactly what its rows hold). */
const candle = (t: number, o: number, h: number, l: number, c: number, volume = 1): CandleRow => [t, o, h, l, c, volume, 1];
const facts = (setup: { candles: CandleRow[]; bars: Map<number, Bar> }, step = 1): Map<number, BarFacts> => { const at = new Map(setup.candles.map(c => [c[0], c] as const)); return new Map([...setup.bars].map(([t, b]) => [t, factsOf(b, at.get(t), step)] as const)); };

const HISTORY_ROWS: Rows = [[100, 3e6, 2e6]];
/** `n` ordinary candles before the event: range `range`, a net delta of 1M each, all recorded in full. */
function history(n: number, range = 7, t0 = T0): { candles: CandleRow[]; bars: Map<number, Bar> } {
  const candles: CandleRow[] = [], bars = new Map<number, Bar>();
  for (let k = 0; k < n; k++) {
    const t = t0 + k * TF;
    candles.push(candle(t, 100, 100 + range / 2 + 0.5, 100 - range / 2 + 0.5, 101, baseOf(HISTORY_ROWS)));
    bars.set(t, bar(t, HISTORY_ROWS));
  }
  return { candles, bars };
}

/** Rows 106-109 carry 2.5M of net buying each (10M in all) in the upper wick of a candle that opened at 100 and closed at 99. */
const trappedBuyerRows = (): Rows => [[98, 1e5, 2e5], [99, 1e5, 3e5], ...[100, 101, 102, 103, 104, 105].map((p): [number, number, number] => [p, 2e5, 2e5]), ...[106, 107, 108, 109].map((p): [number, number, number] => [p, 3e6, 5e5])];
const buyersCandle = (t: number, rows: Rows = trappedBuyerRows(), volume = baseOf(rows)): CandleRow => candle(t, 100, 110, 98, 99, volume);

function scan(event: { candle: CandleRow; bar: Bar }, setup: { candles: CandleRow[]; bars: Map<number, Bar> }, extra: CandleRow[] = [], now?: number) {
  const candles = [...setup.candles, event.candle, ...extra], bars = new Map(setup.bars); bars.set(event.bar.t, event.bar);
  const last = candles[candles.length - 1]!;
  return scanTraps({ candles, bars, step: 1, tfMs: TF, now: now ?? last[0] + TF + 20_000, from: event.candle[0], to: event.candle[0] + TF });
}
const eventAt = (t: number, rows: Rows = trappedBuyerRows(), volume?: number) => ({ candle: buyersCandle(t, rows, volume), bar: bar(t, rows) });

test('a wick that out-bought the rest of the candle, in a candle that closed far below, is flagged as rejected aggressive buying', () => {
  const setup = history(24), t = T0 + 24 * TF;
  const [trap, ...others] = scan(eventAt(t), setup);
  assert.equal(others.length, 0);
  assert.equal(trap!.side, 'buyers');
  assert.equal(trap!.t, t);
  assert.equal(trap!.zoneLow, 100); assert.equal(trap!.zoneHigh, 110);
  assert.ok(trap!.zoneDelta > 1e7 - 1, `zone delta ${trap!.zoneDelta}`);
  assert.ok(trap!.multiple > 9, `multiple ${trap!.multiple}`);
  assert.ok(trap!.entry > 105 && trap!.entry < 109, `entry ${trap!.entry}`);
  assert.ok(trap!.excursion > 0.5);
  assert.equal(trap!.state, 'active');
});

test('the lower wick is judged the same way with the sides swapped', () => {
  const setup = history(24), t = T0 + 24 * TF;
  // Opened at 100, fell to 90 on 10M of net selling in rows 90-93, closed at 101.
  const rows: Rows = [...[90, 91, 92, 93].map((p): [number, number, number] => [p, 5e5, 3e6]), ...[94, 95, 96, 97, 98, 99].map((p): [number, number, number] => [p, 2e5, 2e5]), [100, 3e5, 1e5], [101, 3e5, 1e5]];
  const found = scan({ candle: candle(t, 100, 102, 90, 101, baseOf(rows)), bar: bar(t, rows) }, setup);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.side, 'sellers');
  assert.equal(found[0]!.zoneHigh, 100); assert.equal(found[0]!.zoneLow, 90);
  assert.ok(found[0]!.entry > 90 && found[0]!.entry < 94);
  assert.ok(found[0]!.excursion > 0.5);
});

test('buying that is not concentrated in the wick is not flagged', () => {
  const setup = history(24), t = T0 + 24 * TF;
  // The same wick, but a stretch of the body below the open out-bought it: 6 rows of 4M net each.
  const rows: Rows = [...[90, 91, 92, 93, 94, 95].map((p): [number, number, number] => [p, 5e6, 1e6]), ...[96, 97, 98, 99].map((p): [number, number, number] => [p, 1e5, 1e5]), ...trappedBuyerRows().filter(r => r[0] >= 100)];
  assert.deepEqual(scan({ candle: candle(t, 100, 110, 88, 99, baseOf(rows)), bar: bar(t, rows) }, setup), []);
});

test('a close that is near where the wick bought is not flagged', () => {
  const setup = history(24, 20), t = T0 + 24 * TF; // a typical range of 20, so a drop of 8 is under half an ATR
  assert.deepEqual(scan(eventAt(t), setup), []);
});

test('a candle with too little history to compare against is not flagged', () => {
  const t = T0 + 24 * TF;
  assert.deepEqual(scan(eventAt(t), history(10)), [], 'too few candles for an ATR and a baseline');
  const partial = history(24); for (const [k, b] of partial.bars) partial.bars.set(k, { ...b, rows: [[100, 1e5, 1e5]], buyUsd: 1e5, sellUsd: 1e5 });
  assert.deepEqual(scan(eventAt(t), partial), [], 'the baseline candles were recorded only in part');
});

test('a footprint is complete when it holds the candle\'s volume, not when trades were seen in enough minutes', () => {
  const setup = history(24), t = T0 + 24 * TF, rows = trappedBuyerRows(), full = baseOf(rows);
  const judge = (volume: number, bars: Rows = rows, minutes = 60) => judgeCandle({ candles: [...setup.candles, candle(t, 100, 110, 98, 99, volume)], index: 24, bar: bar(t, bars, minutes), step: 1, facts: facts(setup), tfMs: TF });
  assert.equal(judge(full).verdict, 'trap');
  // The review's case: five trades in five different minutes. The old rule counted minutes with trades and called that complete.
  const five: Rows = [[106, 1e5, 0], [107, 0, 1e5], [108, 1e5, 0], [109, 0, 1e5], [100, 1e5, 0]];
  const sparse = judge(full, five, 5);
  assert.equal(sparse.verdict, 'insufficient'); assert.ok(sparse.share! < 0.05, `share ${sparse.share}`);
  // Healthy inactivity: only two minutes of the hour had trades, and the exchange's own volume says there were no others.
  const quiet = judge(full, rows, 2);
  assert.equal(quiet.verdict, 'trap', 'the minute count says nothing; the volume does');
  // A first minute seen in part: a tenth of the candle missing is the edge, a fifth is too much.
  assert.equal(judge(full / 0.95).verdict, 'trap'); assert.equal(judge(full / 0.8).verdict, 'insufficient');
  // Units that do not match (contracts, or another market's candles) fall outside the band instead of passing by luck.
  assert.equal(judge(full * 100).verdict, 'insufficient'); assert.equal(judge(full / 100).verdict, 'insufficient');
  assert.equal(judge(0).verdict, 'insufficient', 'no volume to compare with: nothing can be said');
  assert.equal(recordedShare(bar(t, rows), undefined, 1), null);
  assert.equal(judgeCandle({ candles: [...setup.candles, candle(t, 100, 110, 98, 99, full)], index: 24, bar: undefined, step: 1, facts: facts(setup), tfMs: TF }).verdict, 'insufficient', 'no footprint at all');
});

test('no event, no data and no history yet are three different answers', () => {
  const setup = history(24), t = T0 + 24 * TF;
  const flat: Rows = [[100, 1e5, 1e5], [101, 1e5, 1e5]];
  const decide = (index: number, candles: CandleRow[], b: Bar | undefined, f = facts(setup)) => judgeCandle({ candles, index, bar: b, step: 1, facts: f, tfMs: TF }).verdict;
  assert.equal(decide(24, [...setup.candles, candle(t, 100, 101, 99, 100.5, baseOf(flat))], bar(t, flat)), 'none', 'complete, compared, nothing met the rule');
  assert.equal(decide(24, [...setup.candles, candle(t, 100, 101, 99, 100.5, 5)], bar(t, flat)), 'insufficient', 'the recording does not cover the candle');
  assert.equal(decide(10, history(24).candles, bar(setup.candles[10]![0], flat)), 'warmup', 'too few candles before it for an ATR');
  assert.equal(decide(24, [...setup.candles, candle(t, 100, 101, 99, 100.5, baseOf(flat))], bar(t, flat), new Map()), 'warmup', 'nothing recorded before it to compare with');
  assert.equal(trapStatusText(undefined), null);
  assert.equal(trapStatusText({ t, verdict: 'none', traps: [], step: 1, share: 1, version: TRAP_VERSION }), 'No rejected aggressive flow');
  assert.equal(trapStatusText({ t, verdict: 'insufficient', traps: [], step: 1, share: 0.1, version: TRAP_VERSION }), 'Not enough recorded data to check');
  assert.equal(trapStatusText({ t, verdict: 'warmup', traps: [], step: 1, share: 1, version: TRAP_VERSION }), 'Still collecting the history to compare with');
});

test('a candle is judged only once it has settled, and never while it forms', () => {
  const setup = history(24), t = T0 + 24 * TF, event = eventAt(t);
  assert.deepEqual(scan(event, setup, [], t + TF - 1), [], 'still forming');
  assert.deepEqual(scan(event, setup, [], t + TF + TRAP_PARAMS.settleMs - 1), [], 'just closed, late prints may still arrive');
  assert.equal(scan(event, setup, [], t + TF + TRAP_PARAMS.settleMs).length, 1);
});

test('a flag is reclaimed when a later candle closes back above the entry, and goes static once it is old', () => {
  const setup = history(24), t = T0 + 24 * TF, event = eventAt(t);
  const later = (k: number, close: number): CandleRow => candle(t + k * TF, 100, 112, 95, close);
  assert.equal(scan(event, setup, [later(1, 98)])[0]!.state, 'active');
  assert.equal(scan(event, setup, [later(1, 98), later(2, 110)])[0]!.state, 'reclaimed');
  const old = Array.from({ length: TRAP_PARAMS.pulseBars + 1 }, (_, k) => later(k + 1, 98));
  assert.equal(scan(event, setup, old)[0]!.state, 'static');
});

test('detection is a pure function of the rows it is given: the same rows give the same flag', () => {
  const t = T0 + 24 * TF, c = buyersCandle(t);
  const a = detectSide('buyers', c, trappedBuyerRows(), 1, 7, 1e6), b = detectSide('buyers', c, [...trappedBuyerRows()].reverse(), 1, 7, 1e6);
  assert.ok(a);
  assert.deepEqual(a, b, 'the order the rows arrive in does not matter');
  assert.equal(detectSide('sellers', c, trappedBuyerRows(), 1, 7, 1e6), null, 'buying in an upper wick says nothing about sellers');
});

test('a flag carries what the wick bought and sold, not only the net: dominance and the wick\'s share of the candle', () => {
  const t = T0 + 24 * TF, rows = trappedBuyerRows(), trap = detectSide('buyers', buyersCandle(t), rows, 1, 7, 1e6)!;
  assert.equal(trap.zoneBuy, 6 * 2e5 + 4 * 3e6); assert.equal(trap.zoneSell, 6 * 2e5 + 4 * 5e5);
  assert.equal(trap.barGross, rows.reduce((s, r) => s + r[1] + r[2], 0));
  assert.ok(Math.abs(imbalanceOf(trap) - 10e6 / 16.4e6) < 1e-12, 'net over gross');
  assert.ok(Math.abs(wickShareOf(trap) - 16.4e6 / trap.barGross) < 1e-12);
  assert.ok(wickShareOf(trap) > 0.9 && wickShareOf(trap) < 1);
  // The same net with far more selling around it is a less one-sided wick, and says so.
  const noisy = trappedBuyerRows().map((r): [number, number, number] => r[0] >= 106 ? [r[0], r[1] + 3e6, r[2] + 3e6] : r);
  assert.ok(imbalanceOf(detectSide('buyers', buyersCandle(t), noisy, 1, 7, 1e6)!) < imbalanceOf(trap));
});

test('the canonical step keeps a typical candle within the row limit and is a power-of-two multiple of the recorded step', () => {
  assert.equal(canonicalStep(0.5, 8), 0.5);
  assert.equal(canonicalStep(0.5, 32), 0.5);
  assert.equal(canonicalStep(0.5, 33), 1);
  assert.equal(canonicalStep(0.5, 100), 2);
  assert.equal(canonicalStep(0, 100), 0);
  for (const range of [3, 17, 80, 400, 5000]) { const s = canonicalStep(0.5, range); assert.ok(range / s <= TRAP_PARAMS.maxRows); assert.ok(Number.isInteger(Math.log2(s / 0.5))); }
});

test('typical range and typical delta need enough candles', () => {
  const setup = history(24);
  assert.equal(typicalRange(setup.candles, 24), 7);
  assert.equal(typicalRange(setup.candles, 5), null);
  assert.equal(typicalDelta(facts(setup), T0 + 24 * TF, TF), 1e6);
  assert.equal(typicalDelta(facts(setup), T0 + 5 * TF, TF), null, 'only five candles before it');
});

test('a candle\'s grid comes from the volatility before it, so what the market did afterwards does not move it', () => {
  const calm = history(30, 7), late = history(30, 7), early = history(30, 7);
  for (let k = 24; k < 30; k++) { const c = late.candles[k]!; late.candles[k] = candle(c[0], 100, 400, -200, 101, c[5]); }
  for (let k = 10; k < 30; k++) { const c = early.candles[k]!; early.candles[k] = candle(c[0], 100, 400, -200, 101, c[5]); }
  assert.equal(stepFor(late.candles, 24, 0.5), stepFor(calm.candles, 24, 0.5), 'the candles before the 25th are the same, so is its grid, whatever came after');
  assert.ok(stepFor(early.candles, 29, 0.5) > stepFor(calm.candles, 29, 0.5), 'a candle after a volatile stretch follows it');
  assert.equal(stepFor(calm.candles, 5, 0.5), 0, 'no grid until there is enough history');
});

test('the pop-up states the facts, calls nothing a trap, and does not say who is holding what', () => {
  const setup = history(24), t = T0 + 24 * TF;
  const trap = scan(eventAt(t), setup)[0]!;
  const text = trapText(trap);
  assert.equal(text[0], 'Rejected aggressive buying');
  assert.match(text[1]!, /net aggressive buying in the upper wick/);
  assert.match(text[2]!, /Wick volume: \$.* bought and \$.* sold at market \(61% net\); 9\d% of the candle's volume/);
  assert.match(text[3]!, /^estimated average aggressor price .*; the candle closed .* ATR below$/);
  assert.doesNotMatch(text.join(' '), /underwater|trapped|losing|entry/i);
  assert.equal(text.at(-1), 'Not validated for this market and timeframe. Not a forecast.', 'with no market to speak of, it claims nothing');
  const reclaimed = trapText({ ...trap, state: 'reclaimed' });
  assert.match(reclaimed.join(' '), /closed back through that price\. That is a price event only\./);
  assert.equal(trapText({ ...trap, side: 'sellers' })[0], 'Rejected aggressive selling');
});

test('the pop-up says what the offline study found only where the study looked', () => {
  const tested = trapVerdict({ market: 'binance:BTCUSDT', timeframe: '15m' });
  assert.match(tested, /^Tested on Binance BTCUSDT perpetual history: no reliable direction/);
  assert.match(tested, /revisited somewhat less often than look-alike candles/);
  assert.match(tested, /Not a forecast\.$/);
  for (const scope of [{ market: 'binance:BTCUSDT', timeframe: '5m' }, { market: 'binance:BTCUSDT', timeframe: '1h' }, { market: 'hyperliquid:BTC-PERP', timeframe: '15m' },
    { market: 'binance:BTCUSDT:spot', timeframe: '15m' }, undefined])
    assert.equal(trapVerdict(scope), 'Not validated for this market and timeframe. Not a forecast.', JSON.stringify(scope));
  const setup = history(24), t = T0 + 24 * TF;
  const trap = scan(eventAt(t), setup)[0]!;
  assert.equal(trapText(trap, { market: 'binance:BTCUSDT', timeframe: '15m' }).at(-1), tested);
  assert.doesNotMatch(trapText(trap).join(' '), /Untested/, 'the old wording is gone');
});

// ---- decisions are made once -------------------------------------------------------------------------------------------------------------

/** A page's worth of candles that closed long ago, ending a few minutes before now, with the event candle well inside the settled part. */
function live(eventBack = 3) {
  const end = Math.floor(Date.now() / TF) * TF, first = end - 30 * TF, setup = history(30, 7, first), eventT = end - eventBack * TF;
  const candles = setup.candles.map(c => c[0] === eventT ? buyersCandle(eventT) : c);
  const bars = new Map(setup.bars); bars.set(eventT, bar(eventT, trappedBuyerRows()));
  return { candles, bars, eventT, end, first };
}
/** A footprint source: answers each request from `bars`, writing down what was asked and giving the grid back as asked. */
function source(bars: Map<number, Bar>, asked: { step: number; from: number; to: number }[] = []) {
  return { asked, load: async (_inst: string, _tf: string, from: number, to: number, step: number) => { asked.push({ step, from, to }); return { step, bars: [...bars.values()].filter(b => b.t >= from && b.t < to) }; } };
}
const view = (l: { first: number; end: number }) => ({ t0: l.first, t1: l.end + TF });
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

test('a candle is decided once: when it is final, the zoom, the finest step and the market afterwards do not flip it', async () => {
  const l = live(), s = source(l.bars), data = new TrapData(0);
  const args = { inst: 'x:BTC', tf: '1h', tfMs: TF, candles: l.candles, fine: 1, view: view(l), load: s.load, onLoad: () => { /* redraw */ } };
  data.ensure(args); await settle();
  assert.equal(data.traps.length, 1); assert.equal(data.traps[0]!.t, l.eventT);
  assert.equal(data.decisionOf(l.eventT)?.verdict, 'trap');
  // A volatile hour arrives (the grid from the latest volatility would now be much coarser), and the finest recorded step changes.
  const wild = [...l.candles, candle(l.end, 100, 900, -700, 101, 1), candle(l.end + TF, 100, 900, -700, 101, 1)];
  const before = s.asked.length;
  data.ensure({ ...args, candles: wild, fine: 0.25, view: { t0: l.first, t1: l.end + 2 * TF } }); await settle();
  assert.equal(data.traps.length, 1, 'still there'); assert.equal(data.traps[0]!.t, l.eventT);
  assert.equal(data.decisionOf(l.eventT)?.step, 1, 'on the grid it was decided on, not the one the latest volatility or the new finest step would give');
  assert.ok(s.asked.length > before, 'and the candles still waiting for an answer were looked at');
});

test('a "nothing" is final too, and a candle that could not be judged is tried again when more has been recorded', async () => {
  const l = live(), s = source(new Map([...l.bars].filter(([t]) => t !== l.eventT)));            // the event candle has no footprint yet
  const data = new TrapData(0), args = { inst: 'x:BTC', tf: '1h', tfMs: TF, candles: l.candles, fine: 1, view: view(l), load: s.load, onLoad: () => { /* redraw */ } };
  data.ensure(args); await settle();
  assert.equal(data.decisionOf(l.eventT)?.verdict, 'insufficient'); assert.equal(data.traps.length, 0);
  assert.equal(data.decisionOf(l.eventT - TF)?.verdict, 'none', 'the candle before it was recorded and nothing met the rule');
  s.asked.length = 0; l.bars.set(l.eventT, bar(l.eventT, trappedBuyerRows()));
  const s2 = source(l.bars); data.ensure({ ...args, load: s2.load }); await settle();
  assert.equal(data.decisionOf(l.eventT)?.verdict, 'trap', 'a later look finds what was recorded since');
  assert.equal(data.traps.length, 1);
});

test('a response that arrives after the market was given up is dropped', async () => {
  const l = live(); let release: () => void = () => { /* set below */ };
  const gate = new Promise<void>(resolve => { release = resolve; });
  const data = new TrapData(0), s = source(l.bars);
  data.ensure({ inst: 'x:BTC', tf: '1h', tfMs: TF, candles: l.candles, fine: 1, view: view(l), load: async (...a) => { await gate; return s.load(...a); }, onLoad: () => { /* redraw */ } });
  data.clear();                                                                                 // the chart moved to another market while it was loading
  release(); await settle();
  assert.deepEqual(data.traps, [], 'nothing comes back after clear()');
  assert.equal(data.decisionOf(l.eventT), undefined);
  // and the same for a change of market without a clear in between
  let release2: () => void = () => { /* set below */ }; const gate2 = new Promise<void>(resolve => { release2 = resolve; });
  data.ensure({ inst: 'x:BTC', tf: '1h', tfMs: TF, candles: l.candles, fine: 1, view: view(l), load: async (...a) => { await gate2; return s.load(...a); }, onLoad: () => { /* redraw */ } });
  data.ensure({ inst: 'y:BTC', tf: '1h', tfMs: TF, candles: l.candles, fine: 1, view: view(l), load: s.load, onLoad: () => { /* redraw */ } });
  await settle(); release2(); await settle();
  assert.equal(data.decisionOf(l.eventT)?.verdict, 'trap'); assert.equal(data.traps.length, 1, 'the new market\'s answer stands, the old one did not overwrite it');
});

test('a candle is read on the grid its own volatility gave it, one request per grid', async () => {
  const l = live(), s = source(l.bars), data = new TrapData(0);
  // From the thirteenth candle on the market is volatile, so the later candles need a coarser grid than the earlier ones.
  const candles = l.candles.map((c, i) => i >= 12 ? candle(c[0], 100, 100 + 400, 100 - 400, 101, c[5]) : c);
  const dense = [...candles, candle(l.end, 100, 101, 99, 100, 1)];
  data.ensure({ inst: 'x:BTC', tf: '1h', tfMs: TF, candles: dense, fine: 0.5, view: view(l), load: s.load, onLoad: () => { /* redraw */ } }); await settle();
  const grids = new Set(s.asked.map(a => a.step));
  assert.ok(grids.size >= 2, `more than one grid was asked for: ${[...grids].join(', ')}`);
  assert.equal(data.decisionOf(l.eventT)?.step, stepFor(dense, dense.findIndex(c => c[0] === l.eventT), 0.5));
});
