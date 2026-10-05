import test from 'node:test';
import assert from 'node:assert/strict';
import { fields } from './server-test-helpers.mts';
import { ASTER_DEPTH_LEVELS, buildAsterSubscription, normalizeAsterDepth, normalizeAsterMarkets, isAsterLinearDepthMetadata } from '../src/adapters/aster.mts';

function frame(overrides: Record<string, unknown> = {}) {
  return { e: 'depthUpdate', E: 1_789_902_444_600, T: 1_789_902_444_599, s: 'BTCUSDT', U: 10, u: 12, pu: 9,
    b: [['100', '2']], a: [['101', '3']], ...overrides };
}
function metadata() {
  return normalizeAsterMarkets({ symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT',
    filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001' }] }] }).assets[0];
}

test('Aster depth subscribes to its native top20 snapshots and preserves partial coverage/provenance', () => {
  assert.equal(ASTER_DEPTH_LEVELS, 20);
  assert.deepEqual(buildAsterSubscription('depth', { symbol: 'btcusdt', id: 2 }), {
    url: 'wss://fstream.asterdex.com/ws', method: 'SUBSCRIBE', params: ['btcusdt@depth20@100ms'], id: 2,
    stream: 'btcusdt@depth20@100ms', topic: 'btcusdt@depth20@100ms', symbol: 'BTCUSDT', depth: 20, snapshot: true,
  });
  const payload = { stream: 'btcusdt@depth20@100ms', data: frame({ unknownProvider: { raw: ['kept'] } }) };
  const native = { ...metadata(), unknownUnitsProof: { margin: 'USDT' } };
  const book = normalizeAsterDepth(payload, { metadata: native, receivedAt: 321 });
  assert.equal(book.kind, 'depthSnapshot');
  assert.equal(book.instrumentId, 'aster:BTCUSDT');
  assert.deepEqual(book.bids, [{ price: 100, amount: 2 }]);
  assert.deepEqual(book.asks, [{ price: 101, amount: 3 }]);
  assert.equal(book.sequence, 12);
  assert.equal(book.previousSequence, 9);
  assert.equal(book.firstUpdate, 10);
  assert.equal(book.sourceTimestamp, 1_789_902_444_599);
  assert.equal(book.receivedAt, 321);
  assert.equal(book.market.quantityUnit, 'base');
  assert.equal(book.market.quote, 'USDT');
  assert.equal(fields(book.market).tickSize, 0.1);
  assert.strictEqual(fields(book.market).unknownUnitsProof, native.unknownUnitsProof);
  assert.equal(book.sourceDepth, 20);
  assert.equal(book.coverage, 'partial');
  assert.equal(book.complete, true);
  assert.equal(book.continuity, 'provider-snapshot');
  assert.strictEqual(book.payload, payload);
});

test('Aster depth keeps exact tokens, raw frames, zero rows and provider millisecond clocks', () => {
  const book = normalizeAsterDepth(frame({ U: '9007199254740993', u: '9007199254740995', pu: '9007199254740992', b: [['100', '0']], T: undefined }), { metadata: metadata() });
  assert.equal(book.sequence, '9007199254740995');
  assert.equal(book.previousSequence, '9007199254740992');
  assert.equal(book.firstUpdate, '9007199254740993');
  assert.deepEqual(book.bids, [{ price: 100, amount: 0 }]);
  assert.equal(book.sourceTimestamp, 1_789_902_444_600);
});

test('Aster partial depth rejects oversized domains instead of clipping and rejects unsupported scalar/stream/unit input', () => {
  for (const overrides of [
    { s: 'ETHUSDT' }, { e: 'aggTrade' }, { U: 13 }, { pu: 13 }, { u: Number.MAX_SAFE_INTEGER + 1 }, { u: '1.2' },
    { b: Array.from({ length: 21 }, (_, index) => [String(100 - index), '1']) }, { a: null }, { b: [['100', '2', 'extra']] },
    { b: [['100', null]] }, { b: [['100', -1]] }, { b: [['NaN', '1']] }, { b: [[true, '1']] },
    { E: null }, { E: '' }, { T: false }, { T: Infinity },
  ]) assert.throws(() => normalizeAsterDepth(frame(overrides), { metadata: metadata() }), Error, JSON.stringify(overrides));
  assert.throws(() => normalizeAsterDepth({ stream: 'btcusdt@depth', data: frame() }), /stream mismatch/);
  assert.throws(() => normalizeAsterDepth({ stream: 'btcusdt@depth20@100ms' }), /stream mismatch/);
  assert.throws(() => normalizeAsterDepth({ data: frame() }), /stream mismatch/);
  assert.throws(() => normalizeAsterDepth(frame({ s: 'BTCUSD' }), { symbol: 'BTCUSD' }), /USDT/);
  for (const overrides of [{ quantityUnit: 'contract' }, { quote: 'USD' }, { venue: 'dydx' }, { isDelisted: true }]) {
    assert.throws(() => normalizeAsterDepth(frame(), { metadata: { ...metadata(), ...overrides } }), /metadata mismatch/);
  }
});

test('Aster depth independently refuses contradictory base, quote or settlement metadata instead of replacing it with ticker guesses', () => {
  const native = metadata();
  assert.equal(isAsterLinearDepthMetadata(native, 'BTCUSDT'), true);
  assert.throws(() => normalizeAsterDepth(frame()), /metadata mismatch/);
  for (const correction of [
    { base: 'ETH' }, { base: '' }, { base: 1 }, { quote: 'USDC' }, { settleCoin: 'BTC' }, { settleCoin: undefined },
    { nativeSymbol: 'ETHUSDT' }, { symbol: 'ETHUSDT' }, { instrumentId: 'aster:ETHUSDT' },
    { baseAsset: 'ETH' }, { quoteAsset: 'USD' }, { marginAsset: 'BTC' }, { marginAsset: undefined },
    { inverse: true }, { contractType: 'CURRENT_QUARTER' }, { tickSize: 0 }, { lotSize: Infinity },
  ]) {
    const contradictory = { ...native, ...correction };
    assert.equal(isAsterLinearDepthMetadata(contradictory, 'BTCUSDT'), false, JSON.stringify(correction));
    assert.throws(() => normalizeAsterDepth(frame(), { metadata: contradictory }), /metadata mismatch/, JSON.stringify(correction));
  }
  const corroborated = { ...native, baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', inverse: false };
  assert.equal(isAsterLinearDepthMetadata(corroborated, 'BTCUSDT'), true);
  const book = normalizeAsterDepth(frame(), { metadata: corroborated });
  assert.equal(book.market.base, corroborated.base);
  assert.equal(book.market.settleCoin, corroborated.marginAsset);
});

test('Aster linear-depth family proof rejects contradictory exchangeInfo rows and preserves legitimate ETH native units', () => {
  const raw = { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT',
    filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001' }] };
  for (const correction of [{ baseAsset: 'ETH' }, { marginAsset: 'BTC' }, { quoteAsset: 'USD' }, { baseAsset: 'ETH', marginAsset: 'BTC' }]) {
    const normalized = normalizeAsterMarkets({ symbols: [{ ...raw, ...correction }] }).assets[0];
    assert.equal(isAsterLinearDepthMetadata(normalized, 'BTCUSDT'), false);
    assert.throws(() => normalizeAsterDepth(frame(), { metadata: normalized }), /metadata mismatch/);
  }
  const eth = normalizeAsterMarkets({ symbols: [{ ...raw, symbol: 'ETHUSDT', baseAsset: 'ETH' }] }).assets[0];
  const book = normalizeAsterDepth(frame({ s: 'ETHUSDT' }), { symbol: 'ETHUSDT', metadata: eth });
  assert.equal(book.market.base, 'ETH'); assert.equal(book.market.quote, 'USDT'); assert.equal(book.market.settleCoin, 'USDT');
  assert.equal(book.units, 'base'); assert.equal(book.instrumentId, 'aster:ETHUSDT');
});
