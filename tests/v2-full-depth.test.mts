import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsClient } from 'ws';
import { BookConnector, type Market } from '../src/shared/connector.ts';
import type { ValuedBook } from '../src/shared/levels.ts';
import { FullDepthBooks, ownedMarket } from '../src/server/v2/full-depth.mts';
import { FlowSources } from '../src/server/v2/flow-sources.mts';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { decodeLevels } from '../src/app/wire.ts';
import type { BrowserVenue } from '../src/shared/venues.ts';

const SPEC = { instrumentId: 'bybit:BTCUSDT', symbol: 'BTCUSDT', category: 'linear' };
const side = (rows: [number, number][]) => { const lo = Float64Array.from(rows, r => r[0]); return { lo, hi: lo, usd: Float64Array.from(rows, r => r[1]) }; };

/** A connector that opens no socket: live at once, its valued book what the test sets. */
class FakeBook extends BookConnector {
  static made: FakeBook[] = [];
  readonly id = 'bybit'; readonly name = 'Bybit'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  book: ValuedBook | null = null; started = 0; stopped = 0;
  constructor(market: Market) { super(market); FakeBook.made.push(this); }
  get symbol(): string { return this.market!.symbol; }
  protected url() { return 'wss://nowhere.example'; }
  protected open() {}
  onMessage() {}
  override start(): void { this.started++; this.state = 'live'; this.lastUpdate = Date.now(); }
  override stop(): void { this.stopped++; this.state = 'stopped'; }
  override valued(): ValuedBook | null { return this.book ? { ...this.book, timestamp: Date.now() } : null; }
  override bookDetail(): string | null { return this.book ? null : 'loading the full book'; }
}

test('full depth: only a linear USDT perpetual of one coin a unit is owned', () => {
  assert.deepEqual(ownedMarket(SPEC), { coin: 'BTC', symbol: 'BTCUSDT', unit: 1 });
  assert.equal(ownedMarket(null), null, 'Bybit not selected');
  assert.equal(ownedMarket({ ...SPEC, category: 'inverse' }), null);
  assert.equal(ownedMarket({ instrumentId: 'bybit:BTCUSD', symbol: 'BTCUSD', category: 'linear' }), null, 'another quote');
  assert.equal(ownedMarket({ instrumentId: 'bybit:1000PEPEUSDT', symbol: '1000PEPEUSDT', category: 'linear' }), null, 'a unit of 1,000: the feed manager keeps it');
  assert.equal(ownedMarket({ ...SPEC, instrumentId: 'bybit:BTCUSDT:spot' }), null, 'the id must be the connector\'s own');
});

test('full depth: the owner is made, replaced (the old one stopped first) and stopped with the spec', () => {
  FakeBook.made = [];
  const order: string[] = [];
  const owner = new FullDepthBooks(() => {}, () => {}, market => { const c = new FakeBook(market); const start = c.start.bind(c), stop = c.stop.bind(c); c.start = () => { order.push(`start ${market.symbol}`); start(); }; c.stop = () => { order.push(`stop ${market.symbol}`); stop(); }; return c; });
  owner.sync(SPEC); owner.sync(SPEC);
  assert.equal(FakeBook.made.length, 1, 'the same spec makes nothing new'); assert.equal(owner.ownedId, 'bybit:BTCUSDT');
  owner.sync({ instrumentId: 'bybit:ETHUSDT', symbol: 'ETHUSDT', category: 'linear' });
  assert.deepEqual(order, ['start BTCUSDT', 'stop BTCUSDT', 'start ETHUSDT'], 'no two connectors at once');
  assert.equal(owner.states(Date.now()).get('bybit')?.state, 'connecting', 'no book valued yet');
  FakeBook.made[1]!.book = { instrumentId: 'bybit:ETHUSDT', venue: 'bybit', timestamp: 0, coarse: false, bids: side([[99, 1]]), asks: side([[101, 1]]) };
  assert.ok(owner.book(Date.now()));
  assert.deepEqual(owner.states(Date.now()).get('bybit'), { state: 'live', detail: null });
  owner.sync(null);
  assert.equal(owner.ownedId, null); assert.equal(FakeBook.made[1]!.stopped, 1);
  assert.equal(owner.states(Date.now()).size, 0);
});

test('flow sources: an excluded venue stops at once and does not start while excluded', () => {
  const made: FakeBook[] = [];
  const venue: BrowserVenue = { id: 'bybit', name: 'Bybit', kind: 'perp', recommended: true, listed: true, probe: null, make: () => { const c = new FakeBook({ coin: 'BTC', symbol: 'BTCUSDT', unit: 1 }); made.push(c); return { book: c, feeds: [] }; } };
  const sources = new FlowSources(() => {}, () => 0, [venue]);
  sources.sync(new Set(['bybit:BTCUSDT']));
  assert.deepEqual(sources.active, ['bybit']);
  sources.exclude('bybit', true);
  assert.deepEqual(sources.active, [], 'stopped at once, not after the grace');
  assert.equal(made[0]!.stopped, 1);
  sources.sync(new Set(['bybit:BTCUSDT']));
  assert.deepEqual(sources.active, [], 'not started while excluded');
  sources.exclude('bybit', false); sources.sync(new Set(['bybit:BTCUSDT']));
  assert.deepEqual(sources.active, ['bybit'], 'started again once released');
  sources.close();
});

test('full depth on the server: the owner\'s book replaces the feed manager\'s, one book per instrument, and the chip says its state', async () => {
  FakeBook.made = [];
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 20, heartbeatMs: 1_000, fullDepthMake: market => new FakeBook(market) });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const id = 'bybit:BTCUSDT';
  // The feed manager's shallow book of the same instrument.
  (app.state.books as Record<string, unknown>)[id] = { venue: 'bybit', bids: [[100, 1], [99.5, 2]], asks: [[100.5, 1], [101, 2]], units: 'base', market: { venue: 'bybit', quote: 'USDT' }, sourceTimestamp: Date.now(), receivedAt: Date.now() };
  const seen: { deepest: number; epoch: number | undefined; count: number }[] = [];
  const socket = new WsClient(`ws://127.0.0.1:${port}/api/v2/ws`);
  socket.on('message', (data: unknown) => {
    if (!Buffer.isBuffer(data)) return;
    try {
      const frame = decodeLevels(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      const mine = frame.books.filter(b => b.id === id);
      if (mine.length) seen.push({ deepest: mine[0]!.bids.lo[mine[0]!.bids.lo.length - 1]!, epoch: mine[0]!.epoch, count: mine.length });
    } catch { /* another frame type */ }
  });
  const until = async (ok: () => boolean, ms = 4_000): Promise<void> => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20)); };
  try {
    await until(() => seen.some(s => s.deepest === 99.5));
    assert.ok(seen.some(s => s.deepest === 99.5), 'before an owner: the feed manager\'s book');
    // Not owned before the feed manager has accepted the market (no market row for it yet).
    const rows = app.state.markets ?? [], kept = rows.slice();
    app.state.markets = rows.filter(m => (m.instrumentId ?? m.id) !== id);
    v2.setFullDepthSource(() => SPEC);
    assert.equal(FakeBook.made.length, 0, 'no owner without an accepted market row');
    app.state.markets = kept;
    v2.setFullDepthSource(() => SPEC);
    const owner = FakeBook.made[0]!;
    assert.ok(owner, 'made at once'); assert.equal(owner.started, 1);
    // Loading: no Bybit book at all (no fallback to the shallow one), and the chip says so.
    seen.length = 0;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(seen.every(s => s.deepest !== 99.5), 'the shallow book is not drawn once the owner holds the instrument');
    assert.equal(v2.ownedBookStates().get('bybit')?.state, 'connecting');
    // Seeded: the owner's deep book, alone, with its coverage epoch.
    owner.book = { instrumentId: id, venue: 'bybit', timestamp: 0, coarse: false, bids: side([[100, 1_000], [50, 5_000]]), asks: side([[100.5, 1_000], [150, 5_000]]), epoch: 9 };
    await until(() => seen.some(s => s.deepest === 50));
    const last = seen.at(-1)!;
    assert.equal(last.deepest, 50); assert.equal(last.epoch, 9); assert.equal(last.count, 1, 'one book for the instrument');
    assert.deepEqual(v2.ownedBookStates().get('bybit'), { state: 'live', detail: null });
    // Bybit no longer selected: the owner stops and the feed manager's book is drawn again.
    v2.setFullDepthSource(() => null);
    assert.equal(owner.stopped, 1);
    seen.length = 0;
    await until(() => seen.some(s => s.deepest === 99.5));
    assert.ok(seen.some(s => s.deepest === 99.5));
  } finally {
    socket.terminate(); v2.close();
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
});
