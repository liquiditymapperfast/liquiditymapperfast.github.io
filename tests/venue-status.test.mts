import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFeedStatus, venueForFeedId } from '../src/core/venue-status.mts';

test('feed status ownership is explicit and isolated by venue', () => {
  assert.equal(venueForFeedId('hl-activeAssetCtx'), 'hyperliquid');
  assert.equal(venueForFeedId('binance-depth'), 'binance');
  assert.equal(venueForFeedId('bybit-depth'), 'bybit');
  assert.equal(venueForFeedId('bitmex-depth'), 'bitmex');
  assert.equal(venueForFeedId('cryptocom-depth'), 'cryptocom');
  assert.equal(venueForFeedId('bitstamp-depth'), 'bitstamp');
  assert.equal(venueForFeedId('whitebit-depth'), 'whitebit');
  assert.equal(venueForFeedId('phemex-depth'), 'phemex');
  assert.equal(venueForFeedId('dydx-trades'), 'dydx');
  assert.equal(venueForFeedId('aster-trades'), 'aster');
  assert.equal(venueForFeedId('provider-refresh'), null);
  const before = { hyperliquid: { state: 'live' }, binance: { state: 'live' } };
  const after = applyFeedStatus(before, 'hl-activeAssetCtx', { state: 'backoff', lastError: 'socket closed' });
  assert.equal(after.hyperliquid.state, 'backoff');
  assert.equal(after.binance.state, 'live');
  assert.equal(before.hyperliquid.state, 'live');
});

test('Bitstamp feed status is retained under the Bitstamp venue key', () => {
  const after = applyFeedStatus({}, 'bitstamp-depth', { state: 'live', lastError: null });
  assert.deepEqual(after.bitstamp, { state: 'live', lastError: null, venue: 'bitstamp' });
});

test('WhiteBIT feed status is retained under the WhiteBIT venue key', () => {
  const after = applyFeedStatus({}, 'whitebit-depth', { state: 'live', lastError: null });
  assert.deepEqual(after.whitebit, { state: 'live', lastError: null, venue: 'whitebit' });
});

test('Phemex feed status is retained under the Phemex venue key', () => {
  const after = applyFeedStatus({}, 'phemex-depth', { state: 'live', lastError: null });
  assert.deepEqual(after.phemex, { state: 'live', lastError: null, venue: 'phemex' });
});

test('dYdX feed status is retained under the dYdX venue key', () => {
  const after = applyFeedStatus({}, 'dydx-trades', { state: 'live', lastError: null });
  assert.deepEqual(after.dydx, { state: 'live', lastError: null, venue: 'dydx' });
});

test('Aster feed status is retained under the Aster venue key', () => {
  const after = applyFeedStatus({}, 'aster-trades', { state: 'live', lastError: null });
  assert.deepEqual(after.aster, { state: 'live', lastError: null, venue: 'aster' });
});
