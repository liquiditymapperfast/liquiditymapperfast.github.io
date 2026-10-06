import test from 'node:test';
import assert from 'node:assert/strict';
import { BookConnector, type TradeEvent } from '../src/shared/connector.ts';
import type { BrowserVenue } from '../src/shared/venues.ts';
import { FlowSources } from '../src/server/v2/flow-sources.mts';

/** A connector with no socket that counts its starts and stops. */
class Fake extends BookConnector {
  readonly name: string; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  starts = 0; stops = 0;
  constructor(readonly id: string) { super(); this.name = id; }
  override start(): void { this.starts++; this.state = 'connecting'; }
  override stop(): void { this.stops++; this.state = 'stopped'; }
  protected url() { return 'ws://127.0.0.1:1'; }
  protected open() {}
  onMessage() {}
  say(tradeId: string) { this.emitTrade({ tradeId, side: 'buy', price: 100, amount: 1, notionalUsd: 100, t: 1 }); }
}

const venue = (id: string, withFeed = false): BrowserVenue & { made: Fake[] } => {
  const made: Fake[] = [];
  return { id, name: id, kind: 'perp', recommended: true, probe: { url: 'https://x.example' }, made, make: () => { const book = new Fake(id), feeds = withFeed ? [new Fake(id + '-trades')] : []; made.push(book, ...feeds); return { book, feeds }; } };
};

test('a venue with a book on the server gets its trade socket, one that the feed manager already covers does not, and one with a feed of its own runs only that feed', () => {
  let now = 0;
  const bybit = venue('bybit'), spot = venue('binancespot', true), binance = venue('binance'), hl = venue('hyperliquid');
  const seen: TradeEvent[] = [];
  const sources = new FlowSources(t => seen.push(t), () => now, [bybit, spot, binance, hl]);
  sources.sync(new Set(['bybit', 'binancespot', 'binance', 'hyperliquid', 'nobody']));
  assert.deepEqual(sources.active.sort(), ['binancespot', 'bybit']);
  assert.equal(binance.made.length + hl.made.length, 0, 'their trades come from the feed manager');
  assert.equal(bybit.made[0]!.starts, 1, 'the book connector carries the trades');
  assert.equal(spot.made[0]!.starts, 0, 'the spot book is the extra venue\'s, not started here'); assert.equal(spot.made[1]!.starts, 1);
  bybit.made[0]!.say('t1'); spot.made[1]!.say('s1');
  assert.deepEqual(seen.map(t => t.tradeId), ['t1', 's1']);
  sources.sync(new Set(['bybit', 'binancespot']));
  assert.equal(bybit.made.length, 1, 'already running: not made again');
});

test('a venue that is no longer wanted keeps its socket for a minute and goes after it; one that comes back in time is not reconnected', () => {
  let now = 0;
  const a = venue('okx'), b = venue('coinbase'), sources = new FlowSources(() => {}, () => now, [a, b]);
  sources.sync(new Set(['okx', 'coinbase']));
  now = 10_000; sources.sync(new Set(['okx']));
  now = 69_000; sources.sync(new Set(['okx']));
  assert.deepEqual(sources.active.sort(), ['coinbase', 'okx'], 'under a minute: still there');
  now = 71_000; sources.sync(new Set(['okx']));
  assert.deepEqual(sources.active, ['okx']); assert.equal(b.made[0]!.stops, 1);
  now = 80_000; sources.sync(new Set(['okx', 'coinbase']));
  assert.equal(b.made.length, 2, 'a new connector after it was stopped');
  now = 90_000; sources.sync(new Set(['okx'])); now = 120_000; sources.sync(new Set(['okx', 'coinbase']));
  assert.equal(b.made.length, 2, 'wanted again before the minute was up: kept');
  sources.close();
  assert.deepEqual(sources.active, []); assert.equal(a.made[0]!.stops, 1);
});
