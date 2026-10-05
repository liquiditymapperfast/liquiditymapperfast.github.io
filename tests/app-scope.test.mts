import test from 'node:test';
import assert from 'node:assert/strict';
import { activeIds, chipClick, emptyScopeMessage, inScope, kindOf, scopeCounts, scopedOut } from '../src/app/scope.ts';
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

test('a venue the filter hides is dimmed, and a click on its chip shows it instead of flipping a switch nobody can see', () => {
  const spot = state('spot');
  assert.equal(scopedOut(spot, 'binance'), true, 'a perpetual venue under Spot');
  assert.equal(scopedOut(spot, 'coinbase'), false);
  assert.equal(scopedOut(spot, 'mystery'), true, 'a venue the market list does not classify is hidden by Spot and Perp, shown by Both');
  assert.equal(scopedOut(state('all'), 'mystery'), false);
  assert.equal(scopedOut(spot, 'nowhere'), true, 'a venue with no book at all has nothing in the filter');
  // dimmed and enabled: the click shows it
  assert.deepEqual(chipClick(spot, 'binance'), { disabledVenues: [], scope: 'all' });
  // dimmed and switched off: the click switches it on as well
  assert.deepEqual(chipClick(state('spot', ['binance', 'kraken']), 'binance'), { disabledVenues: ['kraken'], scope: 'all' });
  // not dimmed: an ordinary switch, and the filter is left alone
  assert.deepEqual(chipClick(spot, 'coinbase'), { disabledVenues: ['coinbase'] });
  assert.deepEqual(chipClick(state('spot', ['coinbase']), 'coinbase'), { disabledVenues: [] });
  assert.deepEqual(chipClick(state('all'), 'bybit'), { disabledVenues: ['bybit'] });
});
