import test from 'node:test';
import assert from 'node:assert/strict';
import { buysAndSells, candleArrays, filterKey, liquidationOrderSide, marketInfo, marketsMatching, sourceInputs, transferables, type BarInputs, type SourceInputs } from '../src/app/script/inputs.ts';
import { liquidationBuckets } from '../src/app/panes/bar-stats.ts';
import type { CandleRow } from '../src/app/store.ts';
import type { CandleFlow } from '../src/app/delta/candles.ts';
import { candleSides } from '../src/app/measures/volume-strip.ts';
import { analyze, runScript, sameCandles } from '../src/app/script/lang/engine.ts';
import { examples } from '../src/app/script/examples.ts';

test('a candle\'s buys and sells come from its delta and gross volume, and an unrecorded one is unknown, not zero', () => {
  assert.deepEqual(buysAndSells({ delta: 20, gross: 100, low: 0, high: 0 }), [60, 40]);
  assert.deepEqual(buysAndSells({ delta: -100, gross: 100, low: 0, high: 0 }), [0, 100]);
  const [b, s] = buysAndSells(null);
  assert.ok(Number.isNaN(b) && Number.isNaN(s));
});

test('a liquidated short is a forced buy and a liquidated long a forced sell, as the Bar stats count them', () => {
  assert.equal(liquidationOrderSide('short'), 'buy');
  assert.equal(liquidationOrderSide('long'), 'sell');
  const day = Date.UTC(2026, 9, 26), tf = 60_000;
  const rows = [{ t: day + 5_000, id: 'binance:BTCUSDT', side: 'short' as const, price: 1, usd: 1_000, reported: 1, kind: 'fill' as const }, { t: day + 65_000, id: 'binance:BTCUSDT', side: 'long' as const, price: 1, usd: 300, reported: 1, kind: 'fill' as const }];
  const b = liquidationBuckets(new Map([[day, { rows, cut: false, to: day + 86_400_000 }]]), ['binance:BTCUSDT'], [day, day + tf], tf, 0, day + 86_400_000);
  assert.equal(b.buy.get(day), 1_000, liquidationOrderSide('short'));
  assert.equal(b.sell.get(day + tf), 300, liquidationOrderSide('long'));
});

test('a filter keeps markets by kind, exchange and quote, and has one key whatever its order', () => {
  const all = [
    { id: 'binance:BTCUSDT', venue: 'binance', kind: 'perp' as const, quote: 'USDT' },
    { id: 'binancespot:BTCUSDT', venue: 'binancespot', kind: 'spot' as const, quote: 'USDT' },
    { id: 'coinbase:BTC-USD', venue: 'coinbase', kind: 'spot' as const, quote: 'USD' },
  ];
  assert.deepEqual(marketsMatching(all, {}), all.map(m => m.id));
  assert.deepEqual(marketsMatching(all, { kinds: ['spot'] }), ['binancespot:BTCUSDT', 'coinbase:BTC-USD']);
  assert.deepEqual(marketsMatching(all, { kinds: ['spot'], quotes: ['usd'] }), ['coinbase:BTC-USD']);
  assert.deepEqual(marketsMatching(all, { venues: ['BINANCE'] }), ['binance:BTCUSDT', 'binancespot:BTCUSDT'], 'an exchange is its family, spot and perpetual');
  assert.deepEqual(marketsMatching(all, { venues: ['binance/perp'] }), ['binance:BTCUSDT']);
  assert.deepEqual(marketsMatching(all, { venues: ['binance/spot', 'coinbase'] }), ['binancespot:BTCUSDT', 'coinbase:BTC-USD']);
  assert.equal(filterKey({ venues: ['b', 'a'], kinds: ['spot'] }), filterKey({ kinds: ['spot'], venues: ['A', 'B', 'a'] }));
  assert.equal(filterKey({}), '');
  assert.deepEqual(marketInfo([{ instrumentId: 'coinbase:BTC-USD', venue: 'coinbase', marketType: 'spot', quote: 'usd' }], 'coinbase:BTC-USD'), { id: 'coinbase:BTC-USD', venue: 'coinbase', kind: 'spot', quote: 'USD' });
  assert.equal(marketInfo([], 'okx:BTC-USDT-SWAP').kind, 'perp', 'a market the list does not hold counts as a perpetual');
});

test('candles become arrays, oldest first, and the newest is under way until its timeframe has passed', () => {
  const rows: CandleRow[] = [[0, 1, 2, 0.5, 1.5, 10], [60_000, 1.5, 3, 1, 2, 20], [60_000, 9, 9, 9, 9, 9], [120_000, 2, 2, 2, 2, 0]];
  const c = candleArrays(rows, 60_000, 150_000);
  assert.deepEqual([...c.time], [0, 60_000, 120_000]);
  assert.deepEqual([...c.close], [1.5, 2, 2]);
  assert.equal(c.forming, true);
  assert.equal(candleArrays(rows, 60_000, 180_000).forming, false);
});

test('one set of markets\' inputs: flows by candle, liquidations where answered, NaN elsewhere', () => {
  const time = Float64Array.from([0, 60_000, 120_000]);
  const s = sourceInputs(time, ['a', 'b'], {
    flows: () => [{ delta: 10, gross: 30, low: 0, high: 0 }, null, { delta: 0, gross: 0, low: 0, high: 0 }],
    liquidations: () => ({ buy: new Map([[0, 5], [60_000, 0]]), sell: new Map([[0, 0]]) }),
  });
  assert.deepEqual([...s.vbuy].map(v => Number.isNaN(v) ? 'na' : v), [20, 'na', 0]);
  assert.deepEqual([...s.lbuy].map(v => Number.isNaN(v) ? 'na' : v), [5, 0, 'na']);
  assert.deepEqual([...s.lsell].map(v => Number.isNaN(v) ? 'na' : v), [0, 'na', 'na']);
  assert.equal(s.markets, 2);
  const none = sourceInputs(time, [], { flows: () => assert.fail('no markets, nothing read'), liquidations: () => undefined });
  assert.ok([...none.vbuy, ...none.lsell].every(v => v === 0), 'a set with no market on the page reads 0, as scripts for it expect');
  assert.equal(none.markets, 0);
  const inputs: BarInputs = { tf: 60_000, time, open: time, high: time, low: time, close: time, volume: time, sources: { '': s }, forming: false };
  assert.equal(transferables(inputs).length, 6, 'the candles share one buffer here; each buffer is named once, where the flow came from too');
});

const shown = (a: Float64Array | undefined): (number | string)[] => [...(a ?? [])].map(v => Number.isNaN(v) ? 'na' : v);

test('a candle the page did not record takes the chart market\'s own candle in a set that holds that market, and says so', () => {
  const time = Float64Array.from([0, 60_000, 120_000, 180_000]);
  const flows = (): (CandleFlow | null)[] => [null, { delta: 10, gross: 30, low: 0, high: 0 }, { delta: 0, gross: 50, low: 0, high: 0 }, null];
  const own = new Map<number, readonly [number, number]>([[0, [7, 3]], [60_000, [100, 100]], [120_000, [9, 9]], [180_000, [4, 6]]]);
  const candle = (from: number | null) => () => ({ from, sides: (t: number) => own.get(t) ?? null });
  const s = sourceInputs(time, ['binance:BTCUSDT'], { flows, liquidations: () => undefined, candle: candle(60_000) });
  assert.deepEqual(shown(s.vbuy), [7, 20, 25, 4], 'before the recording and in its gap, the candle; the recording where it reaches');
  assert.deepEqual(shown(s.vsell), [3, 10, 25, 6]);
  assert.deepEqual(shown(s.recorded), [0, 1, 1, 0]);
  // The recording began inside the second candle: it holds only its end, and the candle says the whole of it.
  const inside = sourceInputs(time, ['binance:BTCUSDT'], { flows, liquidations: () => undefined, candle: candle(90_000) });
  assert.deepEqual(shown(inside.vbuy), [7, 100, 25, 4]);
  assert.deepEqual(shown(inside.recorded), [0, 0, 1, 0]);
  // A set without the chart's market, or a market whose candles do not say who bought: unknown there, as before.
  for (const read of [() => null, () => ({ from: 60_000, sides: () => null })]) {
    const other = sourceInputs(time, ['okx:BTC-USDT-SWAP'], { flows, liquidations: () => undefined, candle: read });
    assert.deepEqual(shown(other.vbuy), ['na', 20, 25, 'na']);
    assert.deepEqual(shown(other.recorded), ['na', 1, 1, 'na']);
  }
  const old = sourceInputs(time, ['x'], { flows, liquidations: () => undefined });
  assert.deepEqual(shown(old.vbuy), ['na', 20, 25, 'na'], 'a reader with no candles: the recording alone');
});

test('a candle\'s sides: its quote volume and the part bought at market where it reports them, else its dollars by its taker buys\' share', () => {
  assert.deepEqual(candleSides([0, 100, 110, 90, 100, 2, 1, 0.5, 10, 210, 80], 200), { buy: 80, sell: 130, exact: true });
  assert.deepEqual(candleSides([0, 100, 110, 90, 100, 2, 1, 0.5], 200), { buy: 50, sell: 150, exact: false });
  assert.deepEqual(candleSides([0, 100, 110, 90, 100, 2, 1, 0.5, 10, 210, 300], 200), { buy: 210, sell: 0, exact: true }, 'more bought than traded: all of it');
  assert.equal(candleSides([0, 100, 110, 90, 100, 2], 200), null, 'no taker buys: nobody knows who bought');
  assert.equal(candleSides(undefined, 200), null);
});

test('bar.recorded says where the flow came from, a script that reads the flow through bar asks for it, and a run tells the two apart', () => {
  const time = Float64Array.from([0, 60_000, 120_000]);
  const src = (recorded: number[]): SourceInputs => ({ vbuy: Float64Array.from([1, 2, 3]), vsell: Float64Array.from([1, 1, 1]), lbuy: new Float64Array(3), lsell: new Float64Array(3), recorded: Float64Array.from(recorded), markets: 1 });
  const inputs = (recorded: number[]): BarInputs => ({ tf: 60_000, time, open: time, high: time, low: time, close: time, volume: time, sources: { '': src(recorded) }, forming: false });
  const r = runScript('x', 'line(bar.recorded)', {}, inputs([0, 1, NaN]));
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error));
  assert.deepEqual(shown(r.plots[0]!.fields.value), [0, 1, 'na']);
  for (const source of ['line(bar.vbuy)', 'line(bar.vsell)', 'line(bar.recorded)', 'line(avg_ohlc(bar))']) {
    const a = analyze(source);
    assert.ok(a.inputs.has('vbuy') || a.inputs.has('vsell') || a.inputs.has('recorded'), source);
  }
  assert.ok(!analyze('line(bar.close)').inputs.has('vbuy'), 'the candle alone asks for no flow');
  // The liquidations, which the page loads only for a script that reads them (script-pane.ts `readsLiquidations`): through `bar`, by name,
  // or with `bar` handed on whole (marked 'bar': loaded, though not counted as a read of lbuy for the missing-rows warning).
  const readsLiquidations = (source: string): boolean => ['lbuy', 'lsell', 'bar'].some(k => analyze(source).inputs.has(k));
  for (const source of ['line(bar.lbuy - bar.lsell)', 'line(lbuy)', 'line(bar["lsell"])', 'var b = bar\nline(b.lbuy)']) assert.ok(readsLiquidations(source), source);
  assert.ok(!readsLiquidations('line(bar.close)'), 'the candle alone asks for no liquidations');
  assert.ok(!['lbuy', 'lsell'].some(k => analyze('line(avg_ohlc(bar))').inputs.has(k)), 'bar handed on whole is no read of lbuy (no warning about its rows)');
  assert.ok(!sameCandles(inputs([0, 1, 1]), inputs([1, 1, 1]), 3), 'the same numbers from another place are other inputs');
  assert.ok(sameCandles(inputs([0, 1, 1]), inputs([0, 1, 1]), 3));
});

test('every flow example draws over a chart the page never recorded, from the chart market\'s own candles', () => {
  const n = 60, time = Float64Array.from({ length: n }, (_, i) => i * 3_600_000), close = Float64Array.from(time, (_, i) => 80_000 + 100 * Math.sin(i / 5));
  // Buys never equal sells: a delta of exactly 0 is a histogram bar of nothing.
  const sides = (t: number): readonly [number, number] => { const i = t / 3_600_000; return [1e6 * (3 + (i % 3)), 1e6 * (1 + (i % 2))]; };
  const all = sourceInputs(time, ['binance:BTCUSDT'], { flows: () => [], liquidations: () => undefined, candle: () => ({ from: null, sides }) });
  const inputs: BarInputs = { tf: 3_600_000, time, open: close, high: close.map(c => c + 50), low: close.map(c => c - 50), close, volume: Float64Array.from(time, () => 10), sources: { '': all }, forming: false };
  for (const name of ['Cumulative delta', 'Delta histogram', 'Buy share', 'Buyer and seller VWAPs']) {
    const ex = examples().find(e => e.name === name)!;
    const r = runScript('x', ex.source, {}, inputs);
    assert.ok(r.ok, `${name}: ${r.ok ? '' : JSON.stringify(r.error)}`);
    const drawn = r.plots.filter(p => p.fields.value && [...p.fields.value].slice(30).every(v => Number.isFinite(v)));
    assert.ok(drawn.length > 0, `${name} draws over the candles the page never recorded`);
  }
});
