import test from 'node:test';
import assert from 'node:assert/strict';
import { fields } from './server-test-helpers.mts';
import { buildDydxSubscription, normalizeDydxDepth, normalizeDydxMarkets } from '../src/adapters/dydx.mts';

function snapshot(overrides: Record<string, unknown> = {}) {
  return { type: 'subscribed', channel: 'v4_orderbook', id: 'BTC-USD', connection_id: 'native-connection', message_id: 2,
    contents: { bids: [{ price: '100', size: '2' }], asks: [{ price: '101', size: '3' }] }, ...overrides };
}
function metadata() {
  return normalizeDydxMarkets({ markets: { 'BTC-USD': { ticker: 'BTC-USD', status: 'ACTIVE', tickSize: '1', stepSize: '0.001', atomicResolution: -10 } } }).assets[0];
}

test('dYdX depth uses the exact unbatched native channel and complete price/size snapshot', () => {
  assert.deepEqual(buildDydxSubscription('depth', { symbol: 'btc_usd' }), {
    url: 'wss://indexer.dydx.trade/v4/ws', type: 'subscribe', channel: 'v4_orderbook', id: 'BTC-USD',
    topic: 'v4_orderbook:BTC-USD', symbol: 'BTC-USD', batched: false,
  });
  const payload = snapshot({ unknownProvider: { source: 'original', nested: [1, 2] } });
  const native = { ...metadata(), unknownUnitsProof: { atomic: -10 } };
  const book = normalizeDydxDepth(payload, { symbol: 'BTC-USD', metadata: native, receivedAt: 1234 });
  assert.equal(book.kind, 'depthSnapshot');
  assert.deepEqual(book.bids, [{ price: 100, amount: 2 }]);
  assert.deepEqual(book.asks, [{ price: 101, amount: 3 }]);
  assert.equal(book.instrumentId, 'dydx:BTC-USD');
  assert.equal(book.units, 'base');
  assert.equal(book.market.quantityUnit, 'base');
  assert.equal(book.market.quote, 'USD');
  assert.equal(fields(book.market).tickSize, 1);
  assert.strictEqual(fields(book.market).unknownUnitsProof, native.unknownUnitsProof);
  assert.equal(book.sequence, 2);
  assert.equal(book.sourceTimestamp, null);
  assert.equal(book.receivedAt, 1234);
  assert.equal(book.coverage, 'unknown');
  assert.strictEqual(book.payload, payload);
});

test('dYdX channel_data updates may carry [price, size] pairs', () => {
  const update = normalizeDydxDepth(snapshot({ type: 'channel_data', contents: { bids: [['100', '0'], ['99', '4']], asks: [['102', '1.5']] } }));
  assert.deepEqual(update.bids, [{ price: 100, amount: 0 }, { price: 99, amount: 4 }]);
  assert.deepEqual(update.asks, [{ price: 102, amount: 1.5 }]);
  assert.throws(() => normalizeDydxDepth(snapshot({ contents: { bids: [['100', '']], asks: [] } })));
});

test('dYdX depth preserves exact large connection counters and zero deletion amounts', () => {
  const book = normalizeDydxDepth(snapshot({ type: 'channel_data', message_id: '9007199254740993', contents: { bids: [{ price: '100', size: '0' }] } }));
  assert.equal(book.kind, 'depthDelta');
  assert.equal(book.sequence, '9007199254740993');
  assert.equal(book.previousSequence, '9007199254740992');
  assert.deepEqual(book.bids, [{ price: 100, amount: 0 }]);
  assert.deepEqual(book.asks, []);
  assert.equal(book.complete, false);
  assert.equal(book.continuity, 'strict');
  assert.equal(book.sourceTimestamp, null);
});

test('dYdX depth rejects wrong native identity, unsupported rows and unsafe numeric metadata', () => {
  for (const overrides of [
    { channel: 'v4_trades' }, { id: 'ETH-USD' }, { type: 'channel_batch_data' }, { connection_id: '' },
    { message_id: 0 }, { message_id: Number.MAX_SAFE_INTEGER + 1 }, { message_id: true }, { message_id: '1.5' },
    { contents: { bids: [['100']], asks: [] } }, { contents: { bids: [['100', '2', '3']], asks: [] } }, { contents: { bids: [{ price: '100', size: null }], asks: [] } },
    { contents: { bids: [{ price: '', size: '1' }], asks: [] } }, { contents: { bids: [{ price: 0, size: 1 }], asks: [] } },
    { contents: { bids: [{ price: 100, size: -1 }], asks: [] } }, { contents: { bids: [], asks: [{ price: 'Infinity', size: '1' }] } },
    { contents: { bids: [] } },
  ]) assert.throws(() => normalizeDydxDepth(snapshot(overrides)), Error, JSON.stringify(overrides));
  for (const overrides of [{ quantityUnit: 'contract' }, { quote: 'USDT' }, { venue: 'aster' }, { status: 'offline' }, { isDelisted: true }]) {
    assert.throws(() => normalizeDydxDepth(snapshot(), { metadata: { ...metadata(), ...overrides } }), /metadata mismatch/);
  }
});
