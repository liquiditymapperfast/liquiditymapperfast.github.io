import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordedBefore } from '../src/shared/restart.ts';
import { BookConnector, type TradeEvent } from '../src/shared/connector.ts';
import { Engine } from '../src/shared/engine.ts';
import type { BrowserVenue } from '../src/shared/venues.ts';
import type { FootprintMinuteRow, FootprintStore } from '../src/shared/footprint.ts';
import type { FlowMinuteRow, FlowStore } from '../src/shared/flow.ts';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { peakOf } from '../src/shared/absorption.ts';

const MIN = 60_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await sleep(30); }
  assert.fail(`timed out waiting for ${what}`);
}

test('the recordings reach to the end of the last second the flow holds, or of the last minute the footprint holds', () => {
  const flow = { instruments: ['a', 'b', 'old'], lastSecond: (id: string) => ({ a: 10_000, b: 5_000, old: 1_000 } as Record<string, number>)[id] ?? 0 };
  const footprint = { instruments: ['a', 'c', 'old'], lastMinute: (id: string) => ({ a: 0, c: 2 * MIN, old: 3 * MIN } as Record<string, number>)[id] ?? 0 };
  const recorded = new RecordedBefore(flow, footprint);
  assert.equal(recorded.holds('a', 10_999), true); assert.equal(recorded.holds('a', 11_000), false, 'the flow second is the finer mark');
  assert.equal(recorded.holds('b', 5_999), true); assert.equal(recorded.holds('b', 6_000), false);
  assert.equal(recorded.holds('c', 3 * MIN - 1), true, 'an instrument the flow does not hold: its last footprint minute');
  assert.equal(recorded.holds('c', 3 * MIN), false);
  assert.equal(recorded.holds('old', 4 * MIN - 1), true, 'a footprint minute later than the flow holds anything: the minute stands');
  assert.equal(recorded.holds('new', 0), false, 'nothing recorded, nothing held');
});

type Row = { instrumentId: string; tradeId: string; side: 'buy' | 'sell'; price: number; notionalUsd: number; sourceTimestamp: number; receivedAt: number };
const row = (id: string, n: number, side: 'buy' | 'sell', price: number, usd: number, t: number): Row => ({ instrumentId: id, tradeId: `${id}-${n}`, side, price, notionalUsd: usd, sourceTimestamp: t, receivedAt: t });

test('after a server restart, trades a venue sends again are counted nowhere a second time, and newer ones count as ever', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const start = () => {
    const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
    return { app, v2: installV2(app, { dataDir: dir, persist: true, liveMs: 20, heartbeatMs: 500 }) };
  };
  const stop = async (run: ReturnType<typeof start>) => { run.v2.close(); await run.app.close(); };
  const t = Date.now() - 20_000, from = Math.floor(t / MIN) * MIN - MIN, to = Date.now() + 2 * MIN;
  // One market order of two fills (a venue without an order key: one millisecond, one side).
  const burst = [row('x:BTC', 1, 'buy', 100, 30_000, t), row('x:BTC', 2, 'buy', 100, 30_000, t)];
  const trades = (run: ReturnType<typeof start>, rows: Row[]) => { (run.app.state as { trades?: unknown[] }).trades = rows; };
  const totals = (run: ReturnType<typeof start>) => {
    const fp = run.v2.footprint.profile(['x:BTC'], from, to, 1).instruments[0]!.rows;
    const flow = run.v2.flow.frame(['x:BTC'], from, to).instruments[0]!;
    return { footprint: fp.map(([price, buy, sell]) => [price, buy, sell]), flowBuy: flow.buy.reduce((a, x) => a + x, 0), flowSell: flow.sell.reduce((a, x) => a + x, 0) };
  };
  let run = start();
  trades(run, burst);
  await until(() => run.v2.flow.lastSecond('x:BTC') > 0, 'the first run to take the burst');
  await sleep(700);   // the order completes, and the instrument goes quiet so absorption closes the burst
  await stop(run);

  run = start();
  try {
    trades(run, [...burst, row('x:BTC', 3, 'sell', 101, 40_000, Date.now())]);   // the burst sent again, and a new trade
    await until(() => totals(run).flowSell > 0, 'the second run to take the new trade');
    await sleep(700);
    const after = totals(run);
    assert.deepEqual(after.footprint, [[100, 60_000, 0], [101, 0, 40_000]], 'the burst once, the new trade once');
    assert.equal(after.flowBuy, 60_000); assert.equal(after.flowSell, 40_000);
    const prints = run.v2.prints.query(from, to, 25_000, 100).map(p => [p.side, p.usd]);
    assert.deepEqual(prints.filter(([side]) => side === 'buy'), [['buy', 60_000]], 'one bubble for the burst');
    const groups = (await run.v2.absorption.query(['x:BTC'], [25_000], from, to, 10, from)).groups.filter(g => g.side === 'buy');
    assert.deepEqual(groups.map(peakOf), [60_000], 'one absorption group for the burst');
  } finally { await stop(run); fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A connector with no socket: the test says what it trades. */
class Fake extends BookConnector {
  readonly name: string; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  constructor(readonly id: string) { super(); this.name = id; }
  override start(): void { this.state = 'connecting'; }
  override stop(): void { this.state = 'stopped'; }
  protected url() { return 'ws://127.0.0.1:1'; }
  protected open() {}
  onMessage() {}
  trade(t: Partial<TradeEvent> & { tradeId: string }) { const price = t.price ?? 100, amount = t.amount ?? 1; this.onTrade({ instrumentId: this.instrumentId, side: 'buy', price, amount, notionalUsd: price * amount, t: Date.now(), ...t }); }
}

/** Stores kept in memory, written and read back the way the browser's are. */
function memoryStores(): { footprint: FootprintStore; flow: FlowStore } {
  const fp = new Map<string, FootprintMinuteRow>(), fl = new Map<string, FlowMinuteRow>();
  return {
    footprint: { load: since => [...fp.values()].filter(r => r.t >= since), save: rows => { for (const r of rows) fp.set(`${r.inst}|${r.t}`, structuredClone(r)); }, close() {} },
    flow: { load: since => [...fl.values()].filter(r => r.t >= since), save: rows => { for (const r of rows) fl.set(`${r.inst}|${r.t}`, structuredClone(r)); }, close() {} },
  };
}

test('in the browser, a reload does not count again what a venue sends again', () => {
  const stores = memoryStores(), t = Date.now() - 20_000;
  const open = () => {
    const fakes = new Map<string, Fake>();
    const venues: BrowserVenue[] = [{ id: 'binance', name: 'binance', kind: 'perp', recommended: true, listed: true, probe: { url: 'https://binance.example/ping' }, make: () => { const book = new Fake('binance'); fakes.set('binance', book); return { book, feeds: [] }; } }];
    const engine = new Engine({ venues, ping: async () => true, get: async () => { throw new Error('offline'); }, footprint: stores.footprint, flow: stores.flow });
    engine.select(['binance']);
    return { engine, venue: fakes.get('binance')! };
  };
  const burst = (venue: Fake) => { venue.trade({ tradeId: 'b1', side: 'sell', price: 100, amount: 300, t }); venue.trade({ tradeId: 'b2', side: 'sell', price: 100, amount: 300, t: t + 3 }); };
  const first = open();
  burst(first.venue);
  first.engine.stop();   // the page goes away: everything is written
  const second = open();
  burst(second.venue);   // the venue sends the same trades again
  second.venue.trade({ tradeId: 'n1', side: 'buy', price: 101, amount: 100, t: Date.now() });
  const id = 'binance:BTCUSDT', from = Math.floor(t / MIN) * MIN - MIN, to = Date.now() + MIN;
  assert.deepEqual(second.engine.footprints.profile([id], from, to, 1).instruments[0]!.rows, [[100, 0, 60_000], [101, 10_100, 0]]);
  const flow = second.engine.flows.frame([id], from, to).instruments[0]!;
  assert.equal(flow.sell.reduce((a, x) => a + x, 0), 60_000); assert.equal(flow.buy.reduce((a, x) => a + x, 0), 10_100);
  second.engine.stop();
});
