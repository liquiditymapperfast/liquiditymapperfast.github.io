import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { FootprintRecorder, MAX_RANGE_ROWS, parseRange, type FootprintMinuteRow, type FootprintStore } from '../src/shared/footprint.ts';

const MIN = 60_000, T0 = 1_800_000_000_000;
/** A fill of `usd` at `price` and `t` (BTC rows are 0.5 USD apart at this price). */
const fill = (tradeId: string, side: 'buy' | 'sell', price: number, usd: number, t: number, inst = 'x:BTC') => ({ instrumentId: inst, tradeId, side, price, notionalUsd: usd, sourceTimestamp: t });
/** A market order over some fills, as the order builder hands it over: first fill's time, USD, lowest and highest price, average price. */
const orderOf = (fills: ReturnType<typeof fill>[]) => {
  const usd = fills.reduce((s, f) => s + f.notionalUsd, 0), base = fills.reduce((s, f) => s + f.notionalUsd / f.price, 0);
  return { instrumentId: fills[0]!.instrumentId, side: fills[0]!.side, t: Math.min(...fills.map(f => f.sourceTimestamp)), usd, price: usd / base, lo: Math.min(...fills.map(f => f.price)), hi: Math.max(...fills.map(f => f.price)) };
};
/** A store in memory that keeps what it is given, so a second recorder can read the first one's minutes back. */
class MemoryStore implements FootprintStore {
  rows = new Map<string, FootprintMinuteRow>();
  load(since: number): Iterable<FootprintMinuteRow> { return [...this.rows.values()].filter(r => r.t >= since).map(r => structuredClone(r)); }
  save(rows: FootprintMinuteRow[]): void { for (const row of rows) this.rows.set(`${row.inst}|${row.t}`, structuredClone(row)); }
  close(): void {}
}

test('an order is counted once, in the row of the price it started at, and never makes a row of its own', () => {
  const recorder = new FootprintRecorder(null, () => T0 + 10 * MIN);
  // A buy that swept three prices up from 85,000, and a sell that swept two down from 85,010.
  const buy = [fill('b1', 'buy', 85_000, 40_000, T0 + 1_000), fill('b2', 'buy', 85_001, 30_000, T0 + 1_000), fill('b3', 'buy', 85_002, 30_000, T0 + 1_000)];
  const sell = [fill('s1', 'sell', 85_010, 20_000, T0 + 2_000), fill('s2', 'sell', 85_009, 10_000, T0 + 2_000)];
  recorder.ingest([...buy, ...sell]); recorder.countOrders([orderOf(buy), orderOf(sell)]);
  const answer = recorder.range(['x:BTC'], T0, T0 + MIN, null, 0.5);
  const at = (price: number) => answer.rows.find(r => r[0] === price);
  assert.deepEqual(at(85_000), [85_000, 40_000, 0, 1, 0], 'the buy is counted at its lowest fill, the first price it took');
  assert.deepEqual(at(85_001), [85_001, 30_000, 0, 0, 0]);
  assert.deepEqual(at(85_010), [85_010, 0, 20_000, 0, 1], 'the sell at its highest');
  assert.deepEqual(answer.instruments[0]!.band, { buy: 100_000, sell: 30_000, buyN: 1, sellN: 1 });
  // An order whose first price has no row in its minute (it ran on into the next one) counts in the nearest row of that minute.
  recorder.ingest([fill('c1', 'buy', 85_100, 5_000, T0 + MIN + 59_990), fill('c2', 'buy', 85_103, 5_000, T0 + 2 * MIN + 10)]);
  recorder.countOrders([{ instrumentId: 'x:BTC', side: 'buy', t: T0 + MIN + 59_990, usd: 10_000, price: 85_101.5, lo: 85_090, hi: 85_103 }]);
  assert.deepEqual(recorder.range(['x:BTC'], T0 + MIN, T0 + 2 * MIN, null, 0.5).rows, [[85_100, 5_000, 0, 1, 0]]);
  // The footprint and the traded column see only rows with volume.
  for (const bar of recorder.query('x:BTC', T0, T0 + 3 * MIN, MIN, 0.5).bars) for (const row of bar.rows) assert.ok(row[1] + row[2] > 0, `row ${row[0]} has volume`);
  for (const row of recorder.profile(['x:BTC'], T0, T0 + 3 * MIN, 0.5).instruments[0]!.rows) assert.ok(row[1] + row[2] > 0);
});

test('a minute keeps its counts through a restart, and a minute stored without them stays uncounted', () => {
  let now = T0 + 10 * MIN;
  const store = new MemoryStore();
  // A minute stored by a recorder from before counts were kept: three numbers a row.
  store.rows.set(`x:BTC|${T0}`, { inst: 'x:BTC', t: T0, step: 0.5, bins: [[170_000, 10_000, 5_000]], stats: { buyN: 1, sellN: 1, buy: [10_000, 0, 0, 0, 0, 0, 0, 0], sell: [5_000, 0, 0, 0, 0, 0, 0, 0], v: 2 } });
  const first = new FootprintRecorder(store, () => now);
  const late = fill('l1', 'buy', 85_000, 7_000, T0 + 30_000);
  first.ingest([late]); first.countOrders([orderOf([late])]);
  const fresh = [fill('f1', 'sell', 85_000, 9_000, T0 + MIN + 1_000)];
  first.ingest(fresh); first.countOrders([orderOf(fresh)]);
  const old = first.range(['x:BTC'], T0, T0 + MIN, null, 0.5).instruments[0]!;
  assert.equal(old.counted, 0, 'the old minute does not count orders by price');
  assert.deepEqual(old.band, { buy: 17_000, sell: 5_000, buyN: 0, sellN: 0 }, 'an order arriving later is not counted in it either');
  first.flush(true);
  assert.equal(store.rows.get(`x:BTC|${T0}`)!.bins.every(b => b.length === 3), true, 'it is stored as it was, without counts');
  assert.deepEqual(store.rows.get(`x:BTC|${T0 + MIN}`)!.bins, [[170_000, 0, 9_000, 0, 1]], 'a counted minute stores five numbers a row');
  now += 1;
  const again = new FootprintRecorder(store, () => now);
  const both = again.range(['x:BTC'], T0, T0 + 2 * MIN, null, 0.5).instruments[0]!;
  assert.deepEqual([both.minutes, both.counted, both.countedFrom], [2, 1, T0 + MIN]);
  assert.deepEqual(both.band, { buy: 17_000, sell: 14_000, buyN: 0, sellN: 1 });
  assert.deepEqual(both.countedUsd, { buy: 0, sell: 9_000 }, 'the counts are measured against the counted minutes only');
});

test('a box sums the rows inside its band; every price and the same length before are summed for comparison', () => {
  const recorder = new FootprintRecorder(null, () => T0 + 60 * MIN);
  const rows: ReturnType<typeof fill>[] = [];
  // Before the selection (two minutes back): 50K at 84,000. In it: buys at 85,000 and 85,020, a sell at 86,000 (outside the band).
  rows.push(fill('p1', 'buy', 84_000, 50_000, T0 - 2 * MIN + 1_000), fill('a1', 'buy', 85_000, 10_000, T0 + 1_000), fill('a2', 'buy', 85_020, 20_000, T0 + MIN + 1_000),
    fill('a3', 'sell', 86_000, 30_000, T0 + MIN + 2_000), fill('y1', 'sell', 85_010, 4_000, T0 + 1_000, 'y:BTC'));
  recorder.ingest(rows); recorder.countOrders(rows.map(r => orderOf([r])));
  const box = recorder.range(['x:BTC', 'y:BTC', 'ghost:BTC'], T0, T0 + 2 * MIN, { p0: 84_990, p1: 85_100 }, 10);
  const [x, y, ghost] = box.instruments;
  assert.deepEqual(x!.band, { buy: 30_000, sell: 0, buyN: 2, sellN: 0 }, 'the sell at 86,000 is outside the band');
  assert.deepEqual(x!.all, { buy: 30_000, sell: 30_000 }, 'every price');
  assert.deepEqual(x!.before, { buy: 50_000, sell: 0, minutes: 1 }, 'the two minutes before');
  assert.deepEqual([x!.minutes, x!.counted], [2, 2]);
  assert.deepEqual(y!.band, { buy: 0, sell: 4_000, buyN: 0, sellN: 1 });
  assert.deepEqual([ghost!.minutes, ghost!.all.buy], [0, 0], 'an instrument with nothing recorded is answered, empty');
  assert.deepEqual(box.rows, [[85_000, 10_000, 0, 1, 0], [85_010, 0, 4_000, 0, 1], [85_020, 20_000, 0, 1, 0]], 'rows of both instruments on the step asked for');
  assert.equal(box.step, 10);
  // The edges: a row is inside when its low price is, so a band ending at 85,020 leaves that row out.
  assert.deepEqual(recorder.range(['x:BTC'], T0, T0 + 2 * MIN, { p0: 85_000, p1: 85_020 }, 0.5).instruments[0]!.band.buy, 10_000);
  // A minute is in the selection when it starts in [from, to).
  assert.equal(recorder.range(['x:BTC'], T0 + 1, T0 + 2 * MIN, null, 10).instruments[0]!.minutes, 1);
});

test('a range with more rows than an answer carries doubles its step until they fit', () => {
  const recorder = new FootprintRecorder(null, () => T0 + 10 * MIN);
  const many = Array.from({ length: 1_000 }, (_, i) => fill(`m${i}`, 'buy', 80_000 + i * 5, 1_000, T0 + 1_000 + i));
  recorder.ingest(many);
  const answer = recorder.range(['x:BTC'], T0, T0 + MIN, null, 0.5);
  assert.ok(answer.rows.length <= MAX_RANGE_ROWS);
  assert.equal(answer.step, 16, 'fills five dollars apart stay 1,000 rows up to a step of 4, then 625 at 8 and 313 at 16');
  assert.equal(answer.rows.reduce((s, r) => s + r[1], 0), 1_000_000, 'nothing is lost by merging');
  assert.equal(answer.rows.every(r => r[0] % answer.step === 0), true, 'every row starts on the step');
});

test('a range answer is checked field by field', () => {
  const recorder = new FootprintRecorder(null, () => T0 + 10 * MIN);
  recorder.ingest([fill('a', 'buy', 85_000, 10_000, T0 + 1_000)]);
  const answer = JSON.parse(JSON.stringify(recorder.range(['x:BTC'], T0, T0 + MIN, { p0: 84_000, p1: 86_000 }, 10)));
  assert.deepEqual(parseRange(answer, ['x:BTC']), answer, 'the answer is exactly the shape the page checks for');
  assert.equal(parseRange(answer, ['y:BTC']), null, 'an instrument nobody asked about');
  assert.equal(parseRange({ ...answer, p1: null }, ['x:BTC']), null, 'a band is both prices or neither');
  assert.equal(parseRange({ ...answer, rows: [[85_000, 1, 2, 3]] }, ['x:BTC']), null, 'a row of four');
  assert.equal(parseRange({ ...answer, rows: [[85_000, 1, 2, 0.5, 0]] }, ['x:BTC']), null, 'a count that is not whole');
  assert.equal(parseRange({ ...answer, instruments: [{ ...answer.instruments[0], counted: 5, minutes: 1 }] }, ['x:BTC']), null, 'more counted minutes than minutes');
  assert.equal(parseRange(null, ['x:BTC']), null); assert.equal(parseRange('<html>', ['x:BTC']), null);
});

test('/api/v2/range answers a box and a stretch of time, and refuses what it cannot answer', async () => {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 50, heartbeatMs: 500 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, now = Math.floor(Date.now() / MIN) * MIN;
    const fills = [fill('r1', 'buy', 85_000, 10_000, now - 5 * MIN), fill('r2', 'sell', 90_000, 20_000, now - 5 * MIN)];
    v2.footprint.ingest(fills); v2.footprint.countOrders(fills.map(f => orderOf([f])));
    const get = async (query: string) => { const r = await fetch(`${base}/api/v2/range?${query}`); return { status: r.status, body: await r.json() as unknown }; };
    const box = await get(`inst=x:BTC&from=${now - 10 * MIN}&to=${now}&p0=84000&p1=86000&step=10`);
    assert.equal(box.status, 200);
    assert.deepEqual(parseRange(box.body, ['x:BTC'])!.instruments[0]!.band, { buy: 10_000, sell: 0, buyN: 1, sellN: 0 });
    const time = parseRange((await get(`inst=x:BTC&from=${now - 10 * MIN}&to=${now}&step=10`)).body, ['x:BTC'])!;
    assert.deepEqual([time.p0, time.p1, time.instruments[0]!.band.sell], [null, null, 20_000], 'without prices: every price');
    for (const query of ['', `inst=x:BTC&from=${now - MIN}&to=${now}`, `inst=x:BTC&from=${now - MIN}&to=${now}&step=0`, `inst=x:BTC&from=${now - MIN}&to=${now}&step=10&p0=1`,
      `inst=x:BTC&from=${now - MIN}&to=${now}&step=10&p0=5&p1=4`, `inst=x:BTC&from=${now - 9 * 86_400_000}&to=${now}&step=10`]) {
      const refused = await get(query);
      assert.equal(refused.status, 400, query); assert.ok(typeof (refused.body as { error?: unknown }).error === 'string', `${query} says why`);
    }
  } finally { v2.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close(); }
});
