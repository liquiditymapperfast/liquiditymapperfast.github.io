import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowBook } from '../src/app/flow-book.ts';
import { ScriptData, barsAt, setSides, wholeHistory, type TakerCandles } from '../src/app/script/data.ts';
import { initialState, type CandleRow, type Market } from '../src/app/store.ts';
import { scriptStart } from '../src/app/script/bars.ts';

/**
 * Where the page recorded no flow, a script's sets read who bought from the own candles of their Binance markets, spot and perpetual, as far
 * back as the scripts read (Karl, 2026-11-10: a user's CVD script drew the perpetual's history and only the recorded part of spot's).
 */

const HOUR = 3_600_000;
/** A Binance candle with its quote volume and the part of it bought at market (the exact figures `candleSides` reads). */
const taker = (t: number, quote: number, bought: number): CandleRow => [t, 100, 101, 99, 100, quote / 100, 1, bought / 100, 10, quote, bought];

test('a set\'s Binance markets are added up, and the set is unknown where one of them is: never a sum short of a market', () => {
  const perp: TakerCandles = { get: t => t === 0 ? taker(0, 100, 60) : undefined, listedFrom: null };
  const spot: TakerCandles = { get: t => t === 0 ? taker(0, 50, 20) : t === HOUR ? taker(HOUR, 10, 5) : undefined, listedFrom: null };
  assert.deepEqual(setSides([perp, spot], 0), [80, 70]);
  assert.equal(setSides([perp, spot], HOUR), null, 'the perpetual\'s candle not read');
  // A coin whose spot market came later than its perpetual: before the spot market's first candle (its read reached it) it adds nothing.
  const young: TakerCandles = { get: t => t === 2 * HOUR ? taker(t, 10, 10) : undefined, listedFrom: 2 * HOUR };
  assert.deepEqual(setSides([perp, young], 0), [60, 40], 'the perpetual alone before the spot market was listed');
  assert.deepEqual(setSides([young], 0), [0, 0], 'a market not listed yet bought and sold nothing');
  assert.equal(setSides([young], 3 * HOUR), null, 'after its first candle, one missing is unknown (a gap)');
  const silent: TakerCandles = { get: () => [0, 100, 101, 99, 100, 5], listedFrom: null };
  assert.equal(setSides([silent], 0), null, 'a candle that does not say who bought is unknown');
});

test('bars are found by start, asked in order (a cursor) or not', () => {
  const bars = [0, 1, 2, 4, 5].map(h => taker(h * HOUR, 1, 1));
  const at = barsAt(bars);
  assert.equal(at(0)?.[0], 0);
  assert.equal(at(3 * HOUR), undefined, 'a gap');
  assert.equal(at(4 * HOUR)?.[0], 4 * HOUR);
  assert.equal(at(HOUR)?.[0], HOUR, 'asked again from an earlier start (another set)');
  assert.equal(at(5 * HOUR)?.[0], 5 * HOUR);
  assert.equal(at(6 * HOUR), undefined, 'after the last');
  assert.equal(at(-HOUR), undefined, 'before the first');
  assert.equal(barsAt([])(0), undefined);
});

test('a history is read only once whole: of the market and timeframe asked, reaching the start or holding all the exchange has', () => {
  const h = (over: Partial<Parameters<typeof wholeHistory>[0]>) => ({ id: 'binancespot:BTCUSDT', barMs: HOUR, reach: () => 'yes' as const, exhausted: false, limited: false, bars: [taker(0, 1, 1)], ...over });
  assert.equal(wholeHistory(h({}), 'binancespot:BTCUSDT', HOUR, 0), true);
  assert.equal(wholeHistory(h({ reach: () => 'coming' }), 'binancespot:BTCUSDT', HOUR, 0), false, 'still being read: parts are never handed over');
  assert.equal(wholeHistory(h({ reach: () => 'never', exhausted: true }), 'binancespot:BTCUSDT', HOUR, 0), true, 'the market\'s history begins later');
  assert.equal(wholeHistory(h({ reach: () => 'never' }), 'binancespot:BTCUSDT', HOUR, 0), false, 'a read that failed');
  assert.equal(wholeHistory(h({ reach: () => 'never', exhausted: true, bars: [] }), 'binancespot:BTCUSDT', HOUR, 0), false, 'nothing held');
  assert.equal(wholeHistory(h({}), 'binance:BTCUSDT', HOUR, 0), false, 'another market\'s');
  assert.equal(wholeHistory(h({ barMs: 60_000 }), 'binancespot:BTCUSDT', HOUR, 0), false, 'another timeframe\'s');
});

test('a spot set reads Binance spot\'s own candles before the recording, the perpetual set the perpetual\'s, the default set both added up', () => {
  const now = Date.now(), last = Math.floor(now / HOUR) * HOUR;
  const candles: CandleRow[] = Array.from({ length: 30 }, (_, i) => [last - (29 - i) * HOUR, 100, 101, 99, 100, 5]);
  const markets: Market[] = [
    { instrumentId: 'binance:BTCUSDT', venue: 'binance', marketType: 'perpetual', quote: 'USDT' },
    { instrumentId: 'binancespot:BTCUSDT', venue: 'binancespot', marketType: 'spot', quote: 'USDT' },
  ];
  // The recording begins in the newest candle: every candle before reads the exchange's candles.
  const flow = new FlowBook();
  flow.apply([['binance:BTCUSDT', last + 1_000, 5, 3, 100], ['binancespot:BTCUSDT', last + 1_000, 2, 1, 100]]);
  type Fake = { id: string; barMs: number; bars: CandleRow[]; exhausted: boolean; limited: boolean; heldFrom: number; listedFrom: number | null; version: number; reach(from: number): 'yes' | 'coming' | 'never'; ensure(target: { id: string }, from: number): void };
  const asked: { id: string; from: number }[] = [];
  const fake = (id: string, quote: number, bought: number, over: Partial<Fake> = {}): Fake => {
    const bars = candles.map(c => taker(c[0], quote, bought));
    return { id, barMs: HOUR, bars, exhausted: false, limited: false, heldFrom: bars[0]![0], listedFrom: null, version: 1, reach: () => 'yes', ensure: (target, from) => { asked.push({ id: target.id, from }); }, ...over };
  };
  const histories = new Map<string, Fake>([['binance:BTCUSDT', fake('binance:BTCUSDT', 100, 60)], ['binancespot:BTCUSDT', fake('binancespot:BTCUSDT', 50, 20)]]);
  let pending = false;
  const hub = {
    flow, recordedSince: 0, source: { kind: 'server' },
    ensureFlow: async () => {}, ensureFlowMinutes: async () => {},
    candleTaker: () => ({ id: 'binance:BTCUSDT', barMs: HOUR, version: 0, bars: [], ensure: () => {} }),
    scriptHistory: (_tf: number, _bars: number, id: string) => histories.get(id),
    firstColumnsPending: () => pending,
  };
  const state = { ...initialState(), timeframe: '1h', candles, markets, marketId: 'binance:BTCUSDT', seriesInstrument: 'binance:BTCUSDT', scriptBars: 2_000 } as never;
  const filters = new Map([['', {}], ['spot', { kinds: ['spot' as const] }], ['perp', { kinds: ['perp' as const] }]]);
  const data = new ScriptData(hub as never, () => {});
  const read = () => data.inputs(state, filters, false, true, candles, false)!;

  let r = read();
  assert.deepEqual([r.sources.spot!.vbuy[0], r.sources.spot!.vsell[0], r.sources.spot!.recorded![0]], [20, 30, 0], 'spot: Binance spot\'s candle, said to be one');
  assert.deepEqual([r.sources.perp!.vbuy[0], r.sources.perp!.vsell[0]], [60, 40], 'perpetual: Binance\'s perpetual\'s');
  assert.deepEqual([r.sources['']!.vbuy[0], r.sources['']!.vsell[0]], [80, 70], 'the default set: both added up');
  assert.ok(asked.length && asked.every(a => a.from >= scriptStart(Date.now(), HOUR, 2_000)), 'never asked further back than the setting reaches');

  // The spot market's history still on its way: the spot set and the default set read nothing there rather than a sum short of it.
  histories.set('binancespot:BTCUSDT', fake('binancespot:BTCUSDT', 50, 20, { reach: () => 'coming' }));
  r = read();
  assert.ok(Number.isNaN(r.sources.spot!.vbuy[0]!) && Number.isNaN(r.sources['']!.vbuy[0]!), 'nothing handed over in parts, no sum short of spot');
  assert.equal(r.sources.perp!.vbuy[0], 60, 'the perpetual set as before');

  // A spot market listed after the first candles (its read reached its first candle): it adds nothing before it.
  const listed = fake('binancespot:BTCUSDT', 50, 20, { reach: () => 'never', exhausted: true });
  listed.bars = listed.bars.slice(10); listed.heldFrom = listed.listedFrom = listed.bars[0]![0];
  histories.set('binancespot:BTCUSDT', listed);
  r = read();
  assert.deepEqual([r.sources.spot!.vbuy[0], r.sources.spot!.vsell[0]], [0, 0], 'spot: nothing traded before its listing');
  assert.deepEqual([r.sources['']!.vbuy[0], r.sources['']!.vsell[0]], [60, 40], 'the default set: the perpetual alone before it');
  assert.deepEqual([r.sources['']!.vbuy[10], r.sources['']!.vsell[10]], [80, 70], 'and both after it');

  // Before the map's first columns nothing is asked of the exchange for the scripts.
  asked.length = 0; pending = true;
  read();
  assert.equal(asked.length, 0, 'the map\'s first columns come first');
});

test('a Binance market the page reads is in the sets before any trade of it is recorded, under its own name only (Sol, code review round 4)', () => {
  const now = Date.now(), last = Math.floor(now / HOUR) * HOUR;
  const candles: CandleRow[] = Array.from({ length: 30 }, (_, i) => [last - (29 - i) * HOUR, 100, 101, 99, 100, 5]);
  // The chart's own alias of Binance spot (`binance:BTCUSDT:spot`) is listed beside the feeds' name: counted under both, spot would double.
  const markets: Market[] = [
    { instrumentId: 'binance:BTCUSDT', venue: 'binance', marketType: 'perpetual', quote: 'USDT' },
    { instrumentId: 'binance:BTCUSDT:spot', venue: 'binance', marketType: 'spot', quote: 'USDT' },
    { instrumentId: 'binancespot:BTCUSDT', venue: 'binancespot', marketType: 'spot', quote: 'USDT' },
  ];
  // Only the perpetual has a trade recorded: a visitor's first seconds.
  const flow = new FlowBook();
  flow.apply([['binance:BTCUSDT', last + 1_000, 5, 3, 100]]);
  const taker = (t: number, quote: number, bought: number): CandleRow => [t, 100, 101, 99, 100, quote / 100, 1, bought / 100, 10, quote, bought];
  const fake = (id: string, quote: number, bought: number) => ({ id, barMs: HOUR, bars: candles.map(c => taker(c[0], quote, bought)), exhausted: false, limited: false, heldFrom: candles[0]![0], listedFrom: null, version: 1, reach: () => 'yes' as const, ensure: () => {} });
  const histories = new Map([['binance:BTCUSDT', fake('binance:BTCUSDT', 100, 60)], ['binancespot:BTCUSDT', fake('binancespot:BTCUSDT', 50, 20)]]);
  const hub = {
    flow, recordedSince: 0, source: { kind: 'server' }, ensureFlow: async () => {}, ensureFlowMinutes: async () => {},
    candleTaker: () => ({ id: 'binance:BTCUSDT', barMs: HOUR, version: 0, bars: [], ensure: () => {} }),
    scriptHistory: (_tf: number, _bars: number, id: string) => histories.get(id), firstColumnsPending: () => false,
  };
  const state = { ...initialState(), timeframe: '1h', candles, markets, marketId: 'binance:BTCUSDT', seriesInstrument: 'binance:BTCUSDT', scriptBars: 2_000 } as never;
  const filters = new Map([['', {}], ['spot', { kinds: ['spot' as const] }]]);
  const data = new ScriptData(hub as never, () => {});
  assert.deepEqual(data.markets(state, filters).get('spot'), ['binancespot:BTCUSDT'], 'Binance spot, once, under the feeds\' name');
  const r = data.inputs(state, filters, false, true, candles, false)!;
  assert.deepEqual([r.sources.spot!.vbuy[0], r.sources.spot!.vsell[0]], [20, 30], 'spot reads its own candles from the first look');
  assert.deepEqual([r.sources['']!.vbuy[0], r.sources['']!.vsell[0]], [80, 70], 'and the default set both markets, spot once');
});

test('a Binance market joins a set only where its exchange and kind are not held yet, and an alias reads the same history (Sol, round 5)', () => {
  const now = Date.now(), last = Math.floor(now / HOUR) * HOUR;
  const candles: CandleRow[] = Array.from({ length: 30 }, (_, i) => [last - (29 - i) * HOUR, 100, 101, 99, 100, 5]);
  const taker = (t: number, quote: number, bought: number): CandleRow => [t, 100, 101, 99, 100, quote / 100, 1, bought / 100, 10, quote, bought];
  const fake = (id: string, quote: number, bought: number) => ({ id, barMs: HOUR, bars: candles.map(c => taker(c[0], quote, bought)), exhausted: false, limited: false, heldFrom: candles[0]![0], listedFrom: null, version: 1, reach: () => 'yes' as const, ensure: () => {} });
  const histories = new Map([['binance:BTCUSDT', fake('binance:BTCUSDT', 100, 60)], ['binancespot:BTCUSDT', fake('binancespot:BTCUSDT', 50, 20)]]);
  const hubOf = (flow: FlowBook) => ({
    flow, recordedSince: 0, source: { kind: 'server' }, ensureFlow: async () => {}, ensureFlowMinutes: async () => {},
    candleTaker: () => ({ id: 'binance:BTCUSDT', barMs: HOUR, version: 0, bars: [], ensure: () => {} }),
    scriptHistory: (_tf: number, _bars: number, id: string) => histories.get(id), firstColumnsPending: () => false,
  });
  const filters = new Map([['', {}], ['spot', { kinds: ['spot' as const] }]]);
  const markets: Market[] = [
    { instrumentId: 'binance:BTCUSDT', venue: 'binance', marketType: 'perpetual', quote: 'USDT' },
    { instrumentId: 'binance:BTCUSDT:spot', venue: 'binance', marketType: 'spot', quote: 'USDT' },
    { instrumentId: 'binancespot:BTCUSDT', venue: 'binancespot', marketType: 'spot', quote: 'USDT' },
    { instrumentId: 'binance:BTCUSDC', venue: 'binance', marketType: 'perpetual', quote: 'USDC' },
  ];
  const state = { ...initialState(), timeframe: '1h', candles, markets, marketId: 'binance:BTCUSDT', seriesInstrument: 'binance:BTCUSDT', scriptBars: 2_000 } as never;

  // Binance spot's flow recorded under the chart's alias: the ALL VENUES lines hold the alias, and the feeds' name does not join beside it.
  const aliased = new FlowBook();
  aliased.apply([['binance:BTCUSDT', last + 1_000, 5, 3, 100], ['binance:BTCUSDT:spot', last + 1_000, 2, 1, 100]]);
  const a = new ScriptData(hubOf(aliased) as never, () => {});
  assert.deepEqual(a.markets(state, filters).get('spot'), ['binance:BTCUSDT:spot'], 'one spot market, no second name of it');
  const ra = a.inputs(state, filters, false, true, candles, false)!;
  assert.deepEqual([ra.sources.spot!.vbuy[0], ra.sources.spot!.vsell[0]], [20, 30], 'the alias reads Binance spot\'s candles');
  assert.deepEqual([ra.sources['']!.vbuy[0], ra.sources['']!.vsell[0]], [80, 70], 'each market once in the default set');

  // Another quote's perpetual holds Binance's perpetual lane: BTCUSDT does not join beside it.
  const usdc = new FlowBook();
  usdc.apply([['binance:BTCUSDC', last + 1_000, 5, 3, 100]]);
  const u = new ScriptData(hubOf(usdc) as never, () => {});
  const all = u.markets(state, filters).get('')!;
  assert.ok(all.includes('binance:BTCUSDC') && !all.includes('binance:BTCUSDT'), `one Binance perpetual: ${all.join(', ')}`);
  assert.ok(all.includes('binancespot:BTCUSDT'), 'the empty spot lane still takes Binance spot');
});
