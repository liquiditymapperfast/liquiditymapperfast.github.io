import test from 'node:test';
import assert from 'node:assert/strict';
import { activeIds, emptyScopeMessage, inScope, kindOf, scopeCounts } from '../src/app/scope.ts';
import type { AppState, Market } from '../src/app/store.ts';
import type { LiveBook } from '../src/app/wire.ts';

const markets: Market[] = [
  { instrumentId: 'binance:BTCUSDT', marketType: 'perpetual' }, { instrumentId: 'bybit:BTCUSDT', marketType: 'perpetual' },
  { instrumentId: 'coinbase:BTC-USD', marketType: 'spot' }, { instrumentId: 'kraken:BTC/USD', marketType: 'spot' },
];
const book = (id: string): LiveBook => ({ id, venue: id.split(':')[0]!, timestamp: 0, coarse: false, bids: { lo: new Float64Array(), hi: new Float64Array(), usd: new Float64Array() }, asks: { lo: new Float64Array(), hi: new Float64Array(), usd: new Float64Array() } });
const state = (scope: AppState['scope'], disabledVenues: string[] = [], ids = ['binance:BTCUSDT', 'bybit:BTCUSDT', 'coinbase:BTC-USD', 'kraken:BTC/USD', 'mystery:X']) =>
  ({ levels: { asOf: 0, books: ids.map(book) }, disabledVenues, scope, markets });

test('markets are spot or perpetual by their market type, unknown ones are neither', () => {
  assert.equal(kindOf(markets, 'coinbase:BTC-USD'), 'spot');
  assert.equal(kindOf(markets, 'bybit:BTCUSDT'), 'perp');
  assert.equal(kindOf(markets, 'mystery:X'), null);
  assert.equal(inScope('all', markets, 'mystery:X'), true, 'Both includes everything');
  assert.equal(inScope('spot', markets, 'mystery:X'), false);
});

test('the filter narrows the enabled venues and never widens them', () => {
  assert.deepEqual(activeIds(state('all')), ['binance:BTCUSDT', 'bybit:BTCUSDT', 'coinbase:BTC-USD', 'kraken:BTC/USD', 'mystery:X']);
  assert.deepEqual(activeIds(state('spot')), ['coinbase:BTC-USD', 'kraken:BTC/USD']);
  assert.deepEqual(activeIds(state('perp')), ['binance:BTCUSDT', 'bybit:BTCUSDT']);
  assert.deepEqual(activeIds(state('spot', ['coinbase'])), ['kraken:BTC/USD'], 'a venue switched off by its chip stays off under Spot');
});

test('counts and the empty-view message describe what the filter leaves', () => {
  assert.deepEqual(scopeCounts(state('all', ['bybit'])), { spot: 2, perp: 1 });
  assert.equal(emptyScopeMessage(state('spot')), null);
  const onlyPerps = state('spot', [], ['binance:BTCUSDT', 'bybit:BTCUSDT']);
  assert.match(emptyScopeMessage(onlyPerps)!, /No spot venues are enabled/);
  assert.equal(emptyScopeMessage({ ...onlyPerps, scope: 'all' }), null, 'Both never reports an empty filter');
  assert.equal(emptyScopeMessage({ ...onlyPerps, levels: null }), null, 'nothing is loaded yet, so there is nothing to blame on the filter');
});
