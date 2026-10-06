import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowRecorder, type FlowMinuteRow, type FlowStore } from '../src/shared/flow.ts';
import { FootprintRecorder, type FootprintMinuteRow, type FootprintStore } from '../src/shared/footprint.ts';
import { DepthRecorder, COLUMN_MS, type Column, type ColumnStore } from '../src/shared/recorder.ts';
import type { ValuedBook, SideLevels } from '../src/shared/levels.ts';

const MIN = 60_000;
const T0 = Math.floor(Date.UTC(2026, 9, 6, 12, 0, 0) / MIN) * MIN;
const trade = (id: string, tradeId: string, side: 'buy' | 'sell', price: unknown, usd: number, t: number) => ({ instrumentId: id, tradeId, side, price, notionalUsd: usd, sourceTimestamp: t });

/** A store in memory that can be told to fail, and that starts with whatever rows the test hands it. */
class FlowMemory implements FlowStore {
  initial: FlowMinuteRow[] = []; rows = new Map<string, FlowMinuteRow>(); failNext = 0;
  load(): Iterable<FlowMinuteRow> { return this.initial; }
  save(rows: FlowMinuteRow[]): void { if (this.failNext > 0) { this.failNext--; throw new Error('disk full'); } for (const row of rows) this.rows.set(`${row.inst}|${row.t}`, row); }
  close(): void { /* nothing to release */ }
}
class FootprintMemory implements FootprintStore {
  initial: FootprintMinuteRow[] = []; rows = new Map<string, FootprintMinuteRow>();
  load(): Iterable<FootprintMinuteRow> { return this.initial; }
  save(rows: FootprintMinuteRow[]): void { for (const row of rows) this.rows.set(`${row.inst}|${row.t}`, row); }
  close(): void { /* nothing to release */ }
}

// ---- the open minute at shutdown ---------------------------------------------------------------------------------------------------------------

test('flow: closing writes the minute that is still open, and a recorder that starts in that minute carries on adding to it', () => {
  let now = T0 + 10_000;
  const store = new FlowMemory(), first = new FlowRecorder(store, () => now);
  first.ingest([trade('x:BTC', '1', 'buy', 100, 500, T0 + 5_000), trade('x:BTC', '2', 'sell', 100, 200, T0 + 20_000)]);
  first.flush();
  assert.equal(store.rows.size, 0, 'an ordinary flush leaves the minute that is still filling');
  now = T0 + 30_000; first.close();
  const saved = store.rows.get(`x:BTC|${T0}`);
  assert.ok(saved, 'closing writes it');
  assert.equal(saved.buy[5], 500); assert.equal(saved.sell[20], 200); assert.equal(saved.px?.[5], 100);

  const restart = new FlowMemory(); restart.initial = [saved];
  const second = new FlowRecorder(restart, () => now);
  second.ingest([trade('x:BTC', '3', 'buy', 102, 300, T0 + 5_500)]);
  const series = second.frame(['x:BTC'], T0, T0 + MIN).instruments[0]!;
  assert.equal(series.buy[5], 800, 'what was written and what came after are one second');
  assert.ok(Math.abs(series.px![5]! - 800 / (500 / 100 + 300 / 102)) < 1e-3, `the price averages both (${series.px![5]})`);
});

test('flow: the open minute written at shutdown is written again, whole, once it has ended', () => {
  let now = T0 + 30_000;
  const store = new FlowMemory(), recorder = new FlowRecorder(store, () => now);
  recorder.ingest([trade('x:BTC', '1', 'buy', 100, 500, T0 + 5_000)]);
  recorder.flush(true);
  assert.equal(store.rows.get(`x:BTC|${T0}`)!.buy[5], 500);
  recorder.ingest([trade('x:BTC', '2', 'buy', 100, 250, T0 + 45_000)]);   // the page came back and the minute went on
  now = T0 + MIN + 2_000; recorder.flush();
  assert.equal(store.rows.get(`x:BTC|${T0}`)!.buy[45], 250, 'the finished minute replaces the partial one');
});

test('flow: a store that fails keeps the minute for the next try', () => {
  let now = T0 + 30_000;
  const store = new FlowMemory(), recorder = new FlowRecorder(store, () => now);
  recorder.ingest([trade('x:BTC', '1', 'buy', 100, 500, T0 + 5_000)]);
  now = T0 + MIN + 1_000; store.failNext = 1;
  assert.throws(() => recorder.flush(), /disk full/);
  assert.equal(store.rows.size, 0);
  recorder.flush();
  assert.equal(store.rows.get(`x:BTC|${T0}`)!.buy[5], 500, 'the next flush writes what the failed one could not');
});

test('footprint: closing writes the minute that is still open, statistics included', () => {
  let now = T0 + 10_000;
  const store = new FootprintMemory(), first = new FootprintRecorder(store, () => now);
  first.ingest([trade('x:BTC', '1', 'buy', 85_000, 30_000, T0 + 5_000)]);
  first.flush();
  assert.equal(store.rows.size, 0, 'an ordinary flush leaves the minute that is still filling');
  now = T0 + 30_000; first.close();
  const saved = store.rows.get(`x:BTC|${T0}`);
  assert.ok(saved, 'closing writes it');
  assert.equal(saved.stats?.buyN, 1);

  const restart = new FootprintMemory(); restart.initial = [saved];
  const second = new FootprintRecorder(restart, () => now);
  second.ingest([trade('x:BTC', '2', 'sell', 85_000, 40_000, T0 + 40_000)]);
  const bar = second.query('x:BTC', T0, T0 + MIN, MIN, second.step('x:BTC')!).bars[0]!;
  assert.equal(bar.buyUsd, 30_000); assert.equal(bar.sellUsd, 40_000);
  assert.deepEqual([bar.stats?.buyN, bar.stats?.sellN], [1, 1], 'the statistics carry on too');
});

// ---- minutes restored from before prices and statistics were kept -------------------------------------------------------------------------------

test('flow: USD restored without a price stays out of the price of a trade that comes later', () => {
  const store = new FlowMemory();
  store.initial = [{ inst: 'x:BTC', t: T0, buy: Float32Array.from({ length: 60 }, (_, i) => i === 5 ? 100 : 0), sell: new Float32Array(60) }];   // no `px`: an older store
  const recorder = new FlowRecorder(store, () => T0 + 5 * MIN);
  recorder.ingest([trade('x:BTC', '9', 'buy', 100, 100, T0 + 5_200)]);
  const series = recorder.frame(['x:BTC'], T0, T0 + MIN).instruments[0]!;
  assert.equal(series.buy[5], 200, 'both amounts count as flow');
  assert.equal(series.px![5], 100, 'the price is that of the part whose price is known (it was 200)');
  assert.equal(series.px![6], 0, 'a second nothing traded in has no price');
  recorder.flush(true);
  assert.equal(store.rows.get(`x:BTC|${T0}`)!.px![5], 100);
});

test('flow: a trade that comes without a price counts as flow but leaves the price of its second as it was', () => {
  const recorder = new FlowRecorder(null, () => T0 + 5 * MIN);
  recorder.ingest([trade('x:BTC', 'a', 'buy', 100, 100, T0 + 1_000), trade('x:BTC', 'b', 'sell', undefined, 50, T0 + 1_500)]);
  const series = recorder.frame(['x:BTC'], T0, T0 + MIN).instruments[0]!;
  assert.equal(series.buy[1], 100); assert.equal(series.sell[1], 50);
  assert.equal(series.px![1], 100);
  const first = new FlowRecorder(null, () => T0 + 5 * MIN);
  first.ingest([trade('x:BTC', 'a', 'sell', undefined, 50, T0 + 2_000), trade('x:BTC', 'b', 'buy', 100, 100, T0 + 2_500)]);
  assert.equal(first.frame(['x:BTC'], T0, T0 + MIN).instruments[0]!.px![2], 100, 'whichever came first');
});

test('footprint: a restored minute without statistics does not get statistics from a late trade', () => {
  const store = new FootprintMemory();
  store.initial = [{ inst: 'x:BTC', t: T0, step: 0.5, bins: [[170_000, 100, 0]], stats: null }];
  const recorder = new FootprintRecorder(store, () => T0 + 5 * MIN);
  recorder.ingest([trade('x:BTC', '1', 'buy', 85_000.2, 25, T0 + 30_000)]);
  const bar = recorder.query('x:BTC', T0, T0 + MIN, MIN, 0.5).bars[0]!;
  assert.equal(bar.buyUsd + bar.sellUsd, 125, 'the late trade is volume');
  assert.equal(bar.stats, undefined, 'but the statistics would cover a fifth of it, so the bar does not claim them');
  const fresh = new FootprintRecorder(null, () => T0 + 5 * MIN);
  fresh.ingest([trade('x:BTC', '1', 'buy', 85_000.2, 25, T0 + 30_000)]);
  assert.equal(fresh.query('x:BTC', T0, T0 + MIN, MIN, 0.5).bars[0]!.stats?.buyN, 1, 'a minute recorded here has them');
});

test('footprint: a price that is a whole number of steps belongs to the row that starts there', () => {
  const recorder = new FootprintRecorder(null, () => T0);
  recorder.ingest([trade('x:ETH', '1', 'buy', 3_000, 100, T0 + 1_000), trade('x:ETH', '2', 'buy', 3_000.0125, 100, T0 + 2_000)]);
  const step = recorder.step('x:ETH')!;
  const rows = recorder.query('x:ETH', T0, T0 + MIN, MIN, step).bars[0]!.rows;
  assert.deepEqual(rows.map(row => Math.round(row[0] / step)), [240_000, 240_001], '3000.0125 / 0.0125 is 240000.99999999997 in floating point');
});

// ---- depth columns ----------------------------------------------------------------------------------------------------------------------------

const side = (rows: [number, number, number][]): SideLevels => ({ lo: Float64Array.from(rows.map(r => r[0])), hi: Float64Array.from(rows.map(r => r[1])), usd: Float64Array.from(rows.map(r => r[2])) });
const book = (timestamp: number, bids: [number, number, number][]): ValuedBook => ({ instrumentId: 'x:BTC', venue: 'x', timestamp, coarse: false, bids: side(bids), asks: side([]) });

test('depth: a minute read back from the store takes the samples that follow it into its mean', () => {
  const saved: { column: Column }[] = [];
  const stored: Column = { t: T0, n: 1, bins: Int32Array.of(Math.floor(85_000 / 20)), bid: Float32Array.of(100), ask: Float32Array.of(0) };
  const store: ColumnStore = { load: () => [{ instrumentId: 'x:BTC', column: stored, step: 20 }], save: (_id, column) => { saved.push({ column }); }, prune: () => {} };
  const recorder = new DepthRecorder({ store, now: () => T0 + 10_000 });
  recorder.sample([book(T0 + 10_000, [[85_000, 85_000, 900]])], T0 + 10_000);
  const open = recorder.query('x:BTC', T0, T0 + COLUMN_MS);
  assert.equal(open.length, 1, 'one column for the minute, not the stored one and a new one');
  assert.equal(open[0]!.n, 2); assert.equal(open[0]!.bid[0], 500, 'count 2, mean 500 (it was count 1, mean 100: the new sample was dropped)');
  recorder.sample([book(T0 + COLUMN_MS, [[85_000, 85_000, 10]])], T0 + COLUMN_MS);
  const written = saved.at(-1)!.column;
  assert.equal(written.t, T0); assert.equal(written.n, 2); assert.equal(written.bid[0], 500);
});

test('depth: a column the store refused is offered again with the next one, and sampling goes on meanwhile', () => {
  const warn = console.warn; console.warn = () => {};
  try {
    let failing = true; const saved: number[] = [];
    const store: ColumnStore = { load: () => [], save: (_id, column) => { if (failing) throw new Error('read-only'); saved.push(column.t); }, prune: () => {} };
    const recorder = new DepthRecorder({ store, now: () => T0 });
    recorder.steps.set('x:BTC', 20);
    recorder.sample([book(T0, [[85_000, 85_000, 100]])], T0);
    recorder.sample([book(T0 + COLUMN_MS, [[85_000, 85_000, 100]])], T0 + COLUMN_MS);   // commits T0: refused
    assert.equal(recorder.saveFailures, 1); assert.deepEqual(saved, []);
    failing = false;
    recorder.sample([book(T0 + 2 * COLUMN_MS, [[85_000, 85_000, 100]])], T0 + 2 * COLUMN_MS);   // commits T0 + 1 min: both go
    assert.deepEqual(saved, [T0, T0 + COLUMN_MS]);
    assert.equal(recorder.lastSaveError, '');
  } finally { console.warn = warn; }
});

// ---- two tabs writing the same minutes ------------------------------------------------------------------------------------------------------------

import { fullerColumn, fullerFlowMinute, fullerFootprintMinute } from '../src/shared/recording-merge.ts';

const flowRow = (cells: Record<number, [number, number, number]>): FlowMinuteRow => {
  const buy = new Float32Array(60), sell = new Float32Array(60), px = new Float32Array(60);
  for (const [second, [b, s, p]] of Object.entries(cells)) { buy[Number(second)] = b; sell[Number(second)] = s; px[Number(second)] = p; }
  return { inst: 'x:BTC', t: T0, buy, sell, px };
};

test('a tab that joined part-way through a minute does not replace the whole minute with its tail', () => {
  const kept = flowRow({ 10: [125, 0, 100], 20: [0, 40, 101] });
  assert.equal(fullerFlowMinute(kept, flowRow({ 20: [0, 25, 102] })), null, 'a thinner copy writes nothing');
  assert.equal(fullerFlowMinute(kept, flowRow({ 10: [25, 0, 100] })), null);
  const richer = flowRow({ 10: [125, 0, 100], 20: [0, 90, 103] });
  assert.equal(fullerFlowMinute(kept, richer), richer, 'a copy that has seen at least as much replaces it');
  assert.equal(fullerFlowMinute(undefined, richer), richer, 'and the first copy is stored as it is');
  const mixed = fullerFlowMinute(kept, flowRow({ 10: [25, 0, 99], 50: [30, 0, 105] }))!;
  assert.deepEqual([mixed.buy[10], mixed.px![10]], [125, 100], 'a second the stored copy saw more of stays as it was, with its price');
  assert.deepEqual([mixed.buy[50], mixed.px![50]], [30, 105], 'a second only the new copy saw is added');
  assert.deepEqual([mixed.sell[20], mixed.px![20]], [40, 101]);
});

test('a footprint minute and a depth column are replaced only by the fuller copy', () => {
  const minute = (volume: number): FootprintMinuteRow => ({ inst: 'x:BTC', t: T0, step: 0.5, bins: [[1, volume, 0]], stats: null });
  assert.equal(fullerFootprintMinute(minute(125), minute(25)), null);
  const more = minute(130);
  assert.equal(fullerFootprintMinute(minute(125), more), more);
  assert.equal(fullerFootprintMinute(undefined, more), more);
  const column = (n: number) => ({ n, t: T0 });
  assert.equal(fullerColumn(column(7), column(3)), null);
  const next = column(7);
  assert.equal(fullerColumn(column(7), next), next, 'the same count is the same minute written again');
});

// ---- prints --------------------------------------------------------------------------------------------------------------------------------------

import { PrintStream } from '../src/shared/prints.ts';

test('prints: what has outlived the retention window leaves memory when it leaves the store', () => {
  let now = T0;
  const stream = new PrintStream(null, () => now, 7 * 24 * 3_600_000);
  stream.ingest([trade('x:BTC', '1', 'buy', 100, 40_000, T0 - 8 * 24 * 3_600_000), trade('x:BTC', '2', 'sell', 100, 50_000, T0 - 60_000)]);
  assert.equal(stream.query(0, T0 + MIN).length, 2);
  stream.flush();
  assert.deepEqual(stream.query(0, T0 + MIN).map(p => p.usd), [50_000], 'the print from eight days ago is gone, the recent one stays');
  now += 7 * 24 * 3_600_000; stream.flush();
  assert.equal(stream.query(0, now + MIN).length, 0);
});
