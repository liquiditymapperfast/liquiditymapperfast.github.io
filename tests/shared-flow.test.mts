import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_RING, FlowRecorder, FlowSeries, decodeFlowFrame, encodeFlowFrame, type FlowFrame, type FlowMinuteRow, type FlowStore } from '../src/shared/flow.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const trade = (id: string, key: string, side: 'buy' | 'sell', usd: number, t: number) => ({ instrumentId: id, tradeId: key, side, price: 100_000, notionalUsd: usd, sourceTimestamp: t });

class MemoryStore implements FlowStore {
  rows = new Map<string, FlowMinuteRow>(); saved = 0; expired: number[] = [];
  load(since: number) { return [...this.rows.values()].filter(r => r.t >= since); }
  save(rows: FlowMinuteRow[], expireBefore: number) { this.saved += rows.length; this.expired.push(expireBefore); for (const r of rows) this.rows.set(`${r.inst}|${r.t}`, r); }
  close() { /* nothing */ }
}

test('the recorder sums taker buys and sells per second and counts a trade once', () => {
  const r = new FlowRecorder(null, () => T0 + 5_000);
  assert.equal(r.ingest([trade('a', '1', 'buy', 1_000, T0 + 100), trade('a', '2', 'sell', 400, T0 + 900), trade('a', '3', 'buy', 50, T0 + 1_200)]), 3);
  assert.equal(r.ingest([trade('a', '1', 'buy', 1_000, T0 + 100)]), 0, 'a replayed trade id is not counted again');
  assert.deepEqual(r.take(), [['a', T0, 1_000, 400, 100_000], ['a', T0 + 1_000, 50, 0, 100_000]]);
  assert.deepEqual(r.take(), [], 'nothing changed since the last look');
});

test('a late trade changes a second already reported and is reported again with the new total', () => {
  const r = new FlowRecorder(null, () => T0 + 10_000);
  r.ingest([trade('a', '1', 'buy', 1_000, T0 + 2_100)]); r.take();
  r.ingest([trade('a', '2', 'sell', 300, T0 + 2_900), trade('a', '3', 'buy', 5, T0 + 800)]);
  const [early, later] = r.take();
  assert.deepEqual(early, ['a', T0, 5, 0, 100_000]);
  assert.deepEqual(later!.slice(0, 4), ['a', T0 + 2_000, 1_000, 300]);
  assert.ok(Math.abs(later![4]! - 100_000) < 1e-6, 'a price is a quotient: equal to rounding');
});

test('seconds and minutes land on their own index, across a minute boundary', () => {
  const r = new FlowRecorder(null, () => T0 + 2 * MIN);
  r.ingest([trade('a', '1', 'buy', 10, T0 + MIN - 1), trade('a', '2', 'sell', 20, T0 + MIN), trade('a', '3', 'buy', 30, T0 + MIN + 59_999)]);
  const frame = r.frame(['a'], T0, T0 + 2 * MIN);
  assert.equal(frame.instruments.length, 1);
  const s = frame.instruments[0]!;
  assert.equal(s.t0, T0);
  assert.equal(s.buy.length, 120);
  assert.equal(s.buy[59], 10); assert.equal(s.sell[60], 20); assert.equal(s.buy[119], 30);
  assert.equal(s.buy.reduce((a, b) => a + b, 0), 40); assert.equal(s.sell.reduce((a, b) => a + b, 0), 20);
});

test('a frame starts at the first minute with data and leaves out instruments with none in range', () => {
  const r = new FlowRecorder(null, () => T0 + 10 * MIN);
  r.ingest([trade('a', '1', 'buy', 1, T0 + 3 * MIN + 5_000), trade('b', '1', 'buy', 1, T0 - 5 * MIN)]);
  const frame = r.frame(['a', 'b', 'c'], T0, T0 + 6 * MIN);
  assert.deepEqual(frame.instruments.map(i => [i.id, i.t0, i.buy.length]), [['a', T0 + 3 * MIN, 180]]);
});

test('trades that cannot count are ignored', () => {
  const r = new FlowRecorder(null, () => T0);
  const bad = [trade('', '1', 'buy', 1, T0), trade('a', '', 'buy', 1, T0), trade('a', '2', 'buy', 0, T0), trade('a', '3', 'buy', -5, T0), { ...trade('a', '4', 'buy', 1, T0), side: 'flat' }, { ...trade('a', '5', 'buy', 1, T0), sourceTimestamp: NaN }];
  assert.equal(r.ingest(bad), 0);
  assert.deepEqual(r.take(), []);
});

test('only whole minutes older than the open one are written, and a rewritten minute is written again', () => {
  const store = new MemoryStore(); let now = T0 + 30_000;
  const r = new FlowRecorder(store, () => now);
  r.ingest([trade('a', '1', 'buy', 100, T0 + 1_000)]);
  r.flush();
  assert.equal(store.saved, 0, 'the open minute waits');
  now = T0 + MIN + 1_000; r.flush();
  assert.equal(store.saved, 1);
  r.flush(); assert.equal(store.saved, 1, 'nothing changed, nothing written');
  r.ingest([trade('a', '2', 'sell', 40, T0 + 2_000)]); r.flush();
  assert.equal(store.saved, 2, 'a late trade rewrites its minute');
  const row = store.rows.get(`a|${T0}`)!;
  assert.equal(row.buy[1], 100); assert.equal(row.sell[2], 40);
  assert.ok(store.expired.every(e => e < now), 'the store is told what to expire');
});

test('a recorder started on a store loads its minutes', () => {
  const store = new MemoryStore();
  const buy = new Float32Array(60), sell = new Float32Array(60); buy[7] = 12; sell[8] = 3;
  store.rows.set(`a|${T0}`, { inst: 'a', t: T0, buy, sell });
  const r = new FlowRecorder(store, () => T0 + 5 * MIN);
  const s = r.frame(['a'], T0, T0 + MIN).instruments[0]!;
  assert.equal(s.buy[7], 12); assert.equal(s.sell[8], 3);
  assert.deepEqual(r.coverage(), { a: { first: T0, last: T0 } });
});

test('what is older than memory keeps is dropped and counted; so is an instrument past the limit', () => {
  const r = new FlowRecorder(null, () => T0 + 40 * 3_600_000);
  assert.equal(r.ingest([trade('a', '1', 'buy', 1, T0)]), 0);
  assert.equal(r.dropped, 1);
});

// ---- FlowSeries -------------------------------------------------------------------------------------------------------------------

/** What the series must say, computed the slow way. */
class Model {
  bins = new Map<number, [number, number]>();
  set(sec: number, buy: number, sell: number) { this.bins.set(sec, [buy, sell]); }
  sum(from: number, to: number) { let buy = 0, sell = 0; for (const [s, [b, k]] of this.bins) if (s >= from && s <= to) { buy += b; sell += k; } return { buy, sell, delta: buy - sell, gross: buy + sell }; }
}
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)), `${what}: ${a} vs ${b}`);
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

test('window sums match a brute-force model through appends, gaps, re-sets and late seconds', () => {
  const series = new FlowSeries(), model = new Model();
  let sec = 1_000_000; const touched: number[] = [];
  for (let i = 0; i < 4_000; i++) {
    const action = rnd();
    if (action < 0.6) sec += 1 + Math.floor(rnd() * (rnd() < 0.05 ? 400 : 3));      // forward, sometimes across a gap
    const target = action < 0.8 ? sec : Math.max(series.span?.first ?? sec, sec - Math.floor(rnd() * 40)); // mostly now, sometimes a late second
    const buy = Math.round(rnd() * 5_000), sell = Math.round(rnd() * 5_000);
    assert.equal(series.set(target, buy, sell), true);
    model.set(target, buy, sell); touched.push(target);
    if (i % 97 === 0) {
      const span = series.span!;
      for (let k = 0; k < 6; k++) {
        const a = span.first + Math.floor(rnd() * (span.last - span.first)), b = a + Math.floor(rnd() * 3_000);
        const m = model.sum(a, b);
        near(series.delta(a, b), m.delta, `delta ${a}..${b}`); near(series.gross(a, b), m.gross, 'gross'); near(series.buy(a, b), m.buy, 'buy'); near(series.sell(a, b), m.sell, 'sell');
      }
    }
  }
});

test('load gives the same series as setting second by second', () => {
  const a = new FlowSeries(), b = new FlowSeries(), buy: number[] = [], sell: number[] = [];
  for (let i = 0; i < 2_000; i++) { buy.push(Math.round(rnd() * 900)); sell.push(Math.round(rnd() * 900)); }
  a.load(500, buy, sell);
  for (let i = 0; i < 2_000; i++) b.set(500 + i, buy[i]!, sell[i]!);
  assert.deepEqual(a.span, b.span);
  for (const [x, y] of [[500, 2_499], [900, 1_000], [1_999, 2_300], [499, 600]] as const) { near(a.delta(x, y), b.delta(x, y), `delta ${x}..${y}`); near(a.gross(x, y), b.gross(x, y), 'gross'); }
  // live seconds go on from a loaded history
  a.set(2_500, 100, 0); near(a.delta(2_500, 2_500), 100, 'a second after the history');
  assert.equal(a.span!.last, 2_500);
});

test('the ring forgets the oldest seconds and the running sums stay continuous', () => {
  const series = new FlowSeries();
  const n = FLOW_RING + 500;
  for (let i = 0; i < n; i++) series.set(i, 3, 1);                    // delta 2 per second
  const span = series.span!;
  assert.equal(span.last, n - 1);
  assert.equal(span.last - span.first + 1, FLOW_RING);
  near(series.delta(span.first, span.last), 2 * FLOW_RING, 'the whole ring');
  near(series.delta(n - 100, n - 1), 200, 'the newest 100 s');
  assert.equal(series.set(span.first - 1, 5, 5), false, 'older than the ring holds');
  assert.equal(series.tooOld, 1);
  near(series.cumDelta(span.first - 10), series.cumDelta(span.first - 1), 'before the ring reads the base');
});

test('a gap longer than the ring restarts it without breaking the running sums', () => {
  const series = new FlowSeries();
  series.set(10, 100, 0); series.set(11, 0, 40);
  const before = series.cumDelta(11);
  series.set(11 + FLOW_RING + 5, 7, 2);
  assert.equal(series.span!.first, 11 + FLOW_RING + 5);
  near(series.cumDelta(11 + FLOW_RING + 5) - before, 5, 'continues from where it stood');
});

test('loading more than the ring holds keeps the newest seconds and counts the rest into the base', () => {
  const series = new FlowSeries(), n = FLOW_RING + 1_000;
  series.load(0, new Float32Array(n).fill(2), new Float32Array(n).fill(1));
  assert.equal(series.span!.first, 1_000);
  near(series.delta(1_000, n - 1), FLOW_RING, 'the delta over what is held');
});

test('decimate gives the lowest, highest and last running delta of each slice, and NaN before the series starts', () => {
  const series = new FlowSeries(), model: number[] = [];
  let run = 0;
  for (let i = 0; i < 600; i++) { const b = Math.round(rnd() * 100), s = Math.round(rnd() * 100); series.set(1_000 + i, b, s); run += b - s; model.push(run); }
  const from = 900, to = 1_700, columns = 37, out = new Float64Array(columns * 3);
  series.decimate(from, to, columns, out);
  for (let c = 0; c < columns; c++) {
    const a = from + Math.floor((to - from) * c / columns), b = Math.max(a + 1, from + Math.floor((to - from) * (c + 1) / columns));
    const values: number[] = [];
    for (let s = a; s < b; s++) { const i = Math.min(s, 1_599) - 1_000; if (i >= 0) values.push(model[i]!); }
    if (!values.length) { assert.ok(Number.isNaN(out[c * 3]!), `column ${c} is empty`); continue; }
    assert.equal(out[c * 3], Math.min(...values), `min ${c}`); assert.equal(out[c * 3 + 1], Math.max(...values), `max ${c}`); assert.equal(out[c * 3 + 2], values[values.length - 1], `last ${c}`);
  }
  assert.ok(Number.isNaN(out[0]!), 'the first slice is before the first second');
  const last = out[(columns - 1) * 3 + 2]!; assert.equal(last, model[599], 'past the end it holds the newest value');
});

test('an empty series says zero and decimates to NaN', () => {
  const series = new FlowSeries(), out = new Float64Array(6);
  assert.equal(series.cumDelta(5), 0); assert.equal(series.delta(0, 100), 0); assert.equal(series.span, null);
  series.decimate(0, 10, 2, out); assert.ok(out.every(Number.isNaN));
});

test('a frame survives its bytes, including a header that needs padding and a view that starts off the 4-byte grid', () => {
  const frame: FlowFrame = { from: T0, to: T0 + 3_000, instruments: [
    { id: 'binance:BTCUSDT', t0: T0, buy: Float32Array.from([1, 2, 3]), sell: Float32Array.from([4, 5, 6]) },
    { id: 'x', t0: T0 + 1_000, buy: Float32Array.from([7, 8]), sell: Float32Array.from([9, 10]) },
  ] };
  const bytes = encodeFlowFrame(frame);
  for (const input of [bytes, bytes.buffer.slice(0) as ArrayBuffer, (() => { const shifted = new Uint8Array(bytes.length + 3); shifted.set(bytes, 3); return shifted.subarray(3); })()]) {
    const back = decodeFlowFrame(input);
    assert.equal(back.from, frame.from); assert.equal(back.to, frame.to);
    assert.deepEqual(back.instruments.map(i => [i.id, i.t0, [...i.buy], [...i.sell]]), frame.instruments.map(i => [i.id, i.t0, [...i.buy], [...i.sell]]));
  }
  assert.throws(() => decodeFlowFrame(bytes.subarray(0, bytes.length - 4)), /cut off/);
  assert.throws(() => decodeFlowFrame(new Uint8Array(2)), /too short/);
  assert.deepEqual(decodeFlowFrame(encodeFlowFrame({ from: 0, to: 0, instruments: [] })).instruments, []);
});

test('an instrument past the limit is not recorded and is counted, so memory stays bounded', () => {
  const r = new FlowRecorder(null, () => T0 + 5_000);
  for (let i = 0; i < 48; i++) r.ingest([trade(`i${i}`, '1', 'buy', 1, T0)]);
  assert.equal(r.instruments.length, 48);
  assert.equal(r.ingest([trade('one-too-many', '1', 'buy', 1, T0)]), 0);
  assert.equal(r.dropped, 1);
  assert.equal(r.ingest([trade('i3', '2', 'sell', 1, T0)]), 1, 'an instrument already recorded still takes trades');
});

// ---- the price of each second ---------------------------------------------------------------------------------------------------------

const at = (id: string, key: string, side: 'buy' | 'sell', usd: number, price: number, t: number) => ({ instrumentId: id, tradeId: key, side, price, notionalUsd: usd, sourceTimestamp: t });

test('a second\'s price is volume-weighted over its trades, buys and sells alike, and a second with no trade has none', () => {
  const r = new FlowRecorder(null, () => T0 + 10_000);
  // 1000 USD at 100 is 10 units and 1000 USD at 200 is 5: 2000 USD over 15 units.
  r.ingest([at('a', '1', 'buy', 1_000, 100, T0 + 100), at('a', '2', 'sell', 1_000, 200, T0 + 400), at('a', '3', 'buy', 10, 50, T0 + 3_000)]);
  const [first, second] = r.take();
  assert.ok(Math.abs(first![4]! - 2_000 / 15) < 1e-9, `volume-weighted, not the last or the mean: ${first![4]}`);
  assert.equal(second![4], 50);
  const frame = r.frame(['a'], T0, T0 + MIN).instruments[0]!;
  assert.ok(frame.px instanceof Float32Array && frame.px.length === 60);
  assert.ok(Math.abs(frame.px![0]! - 2_000 / 15) < 1e-4); assert.equal(frame.px![1], 0, 'nothing traded in second 1'); assert.equal(frame.px![3], 50);
  r.ingest([at('a', '4', 'buy', 100, 0, T0 + 5_000)]);                       // a trade with no usable price counts as volume, not as a price
  const [priceless] = r.take();
  assert.deepEqual(priceless!.slice(2), [100, 0, 0]);
});

test('prices are written with the minute and come back with it, and a late trade still averages in', () => {
  const store = new MemoryStore();
  let now = T0 + 30_000;
  const first = new FlowRecorder(store, () => now);
  first.ingest([at('a', '1', 'buy', 1_000, 100, T0 + 100)]);
  now = T0 + 2 * MIN; first.flush();
  const row = store.rows.get(`a|${T0}`)!;
  assert.equal(row.px![0], 100); assert.equal(row.px![1], 0);
  const again = new FlowRecorder(store, () => now);
  again.ingest([at('a', '2', 'sell', 1_000, 200, T0 + 200)]);                // arrives late, for the minute that was read back
  const [update] = again.take();
  assert.ok(Math.abs(update![4]! - 2_000 / 15) < 1e-4, 'the quantity was worked back from the stored price');
});

test('a minute stored before prices were kept loads with none, and its seconds have no price', () => {
  const store = new MemoryStore();
  store.rows.set(`a|${T0}`, { inst: 'a', t: T0, buy: Float32Array.from({ length: 60 }, (_, i) => i === 3 ? 500 : 0), sell: new Float32Array(60) });
  const r = new FlowRecorder(store, () => T0 + 2 * MIN);
  const s = r.frame(['a'], T0, T0 + MIN).instruments[0]!;
  assert.equal(s.buy[3], 500); assert.ok(s.px!.every(v => v === 0));
});

test('the page\'s series reads the price forward from the last second that traded, and NaN before one did', () => {
  const s = new FlowSeries(), base = Math.floor(T0 / 1000);
  s.set(base + 2, 100, 0, 101); s.set(base + 3, 0, 0, 0); s.set(base + 6, 50, 0, 105);
  assert.ok(Number.isNaN(s.priceAt(base + 1)), 'before the series');
  assert.equal(s.priceAt(base + 2), 101); assert.equal(s.priceAt(base + 3), 101, 'no trade: the price carries');
  assert.equal(s.priceAt(base + 5), 101); assert.equal(s.priceAt(base + 6), 105); assert.equal(s.priceAt(base + 600), 105, 'past the newest second: the last price');
  const out = new Float64Array(8);
  s.priceColumns(base, base + 8, 8, out);
  assert.deepEqual([...out].map(v => Number.isNaN(v) ? 'none' : v), ['none', 'none', 101, 101, 101, 101, 105, 105]);
  s.priceColumns(base + 2, base + 10, 2, out);                                  // slices of four seconds
  assert.deepEqual([out[0], out[1]], [101, 105]);
  s.set(base + 4, 10, 0, 103);                                                  // a late second changes what follows it until the next price
  assert.equal(s.priceAt(base + 5), 103); assert.equal(s.priceAt(base + 6), 105);
  // a series that holds no price at all
  const none = new FlowSeries(); none.set(base, 1, 0); assert.ok(Number.isNaN(none.priceAt(base)));
  none.priceColumns(base, base + 4, 2, out); assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[1]));
});

test('load gives the same prices as setting second by second, and a series loaded without prices has none', () => {
  const base = Math.floor(T0 / 1000), buy = [5, 0, 7, 0], sell = [0, 0, 1, 2], px = [100, 0, 102, 0];
  const a = new FlowSeries(), b = new FlowSeries(), c = new FlowSeries();
  a.load(base, buy, sell, px);
  for (let i = 0; i < 4; i++) b.set(base + i, buy[i]!, sell[i]!, px[i]!);
  c.load(base, buy, sell);
  for (let i = 0; i < 6; i++) { assert.equal(a.priceAt(base + i), b.priceAt(base + i)); assert.ok(Number.isNaN(c.priceAt(base + i))); }
  assert.equal(a.priceAt(base + 1), 100); assert.equal(a.priceAt(base + 3), 102);
});

test('a frame carries its prices through the bytes, and one from a source that keeps none still reads', () => {
  const frame: FlowFrame = { from: T0, to: T0 + MIN, instruments: [
    { id: 'priced', t0: T0, buy: Float32Array.of(1, 2, 3), sell: Float32Array.of(4, 5, 6), px: Float32Array.of(100.5, 0, 101.25) },
    { id: 'plain', t0: T0, buy: Float32Array.of(7, 8), sell: Float32Array.of(9, 10) },
    { id: 'priced2', t0: T0, buy: Float32Array.of(1), sell: Float32Array.of(2), px: Float32Array.of(7) },
  ] };
  const back = decodeFlowFrame(encodeFlowFrame(frame));
  assert.deepEqual(back.instruments.map(i => [i.id, [...i.buy], [...i.sell], i.px ? [...i.px] : null]), [
    ['priced', [1, 2, 3], [4, 5, 6], [100.5, 0, 101.25]], ['plain', [7, 8], [9, 10], null], ['priced2', [1], [2], [7]],
  ]);
  const bytes = encodeFlowFrame(frame);
  assert.throws(() => decodeFlowFrame(bytes.subarray(0, bytes.length - 4)), /cut off/, 'a price array that is cut off is an error too');
});
