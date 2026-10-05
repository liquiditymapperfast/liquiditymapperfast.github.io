import test from 'node:test';
import assert from 'node:assert/strict';
import { applyKrakenDepthSessionMessage, createKrakenDepthSession, krakenBookChecksum, normalizeKrakenDepth } from '../src/adapters/index.mts';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';

const level = (price: string, qty: string) => ({ price, qty });
const frame = (type: 'snapshot' | 'update', bids: ReturnType<typeof level>[], asks: ReturnType<typeof level>[], whole: { bids: ReturnType<typeof level>[]; asks: ReturnType<typeof level>[] }) =>
  ({ channel: 'book', type, data: [{ symbol: 'BTC/USD', bids, asks, checksum: krakenBookChecksum(whole), timestamp: '2026-10-05T12:00:00.000000Z' }] });

test('a level that leaves a checksum venue\'s book leaves the runtime state too (the session\'s whole book replaces the state, it is not merged into it)', () => {
  const bids = [level('100.0', '1.0'), level('99.9', '2.0')], asks = [level('100.1', '1.0'), level('100.2', '2.0'), level('100.3', '3.0')];
  const session = createKrakenDepthSession({ topic: 'book:BTC/USD', instrumentId: 'kraken:BTC/USD', sessionToken: 't', depth: 100 });
  const first = applyKrakenDepthSessionMessage(session, { topic: 'book:BTC/USD', sessionToken: 't', update: normalizeKrakenDepth(frame('snapshot', bids, asks, { bids, asks }), { symbol: 'BTC/USD' }) });
  // The market trades through the best ask: Kraken sends it with a zero quantity.
  const afterAsks = [level('100.2', '2.0'), level('100.3', '3.0')];
  const second = applyKrakenDepthSessionMessage(first.session, { topic: 'book:BTC/USD', sessionToken: 't', update: normalizeKrakenDepth(frame('update', [], [level('100.1', '0')], { bids, asks: afterAsks }), { symbol: 'BTC/USD' }) });
  assert.equal(first.accepted && second.accepted, true);
  assert.equal(second.session.book?.kind, 'depthSnapshot', 'the book handed on is complete, so it must be labelled as such');

  const app = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  try {
    app.applyMessage(first.session.book!, 'kraken');
    assert.deepEqual(app.state.books['kraken:BTC/USD'].asks.map((row: [number, number]) => row[0]), [100.1, 100.2, 100.3]);
    app.applyMessage(second.session.book!, 'kraken');
    assert.deepEqual(app.state.books['kraken:BTC/USD'].asks.map((row: [number, number]) => row[0]), [100.2, 100.3], 'the ask that was filled is gone; merged as a delta it stayed and the book crossed as the market moved');
    assert.deepEqual(app.state.books['kraken:BTC/USD'].bids.map((row: [number, number]) => row[0]), [100, 99.9]);
  } finally { app.close(); }
});
