import test from 'node:test';
import assert from 'node:assert/strict';
import { explainMissing, noticeRows } from '../src/app/cvd/missing.ts';
import { flowIds, flowLoadIds } from '../src/app/cvd/ids.ts';
import type { AppState, Market } from '../src/app/store.ts';

// A flow column that shows fewer exchanges than a person has switched on has to say why.

const markets: Market[] = [
  { instrumentId: 'hyperliquid:BTC-PERP', venue: 'hyperliquid', marketType: 'perpetual' },
  { instrumentId: 'binance:BTCUSDT', venue: 'binance', marketType: 'perpetual' },
  { instrumentId: 'binancespot:BTCUSDT', venue: 'binancespot', marketType: 'spot' },
  { instrumentId: 'bybit:BTCUSDT', venue: 'bybit', marketType: 'perpetual' },
  { instrumentId: 'okx:BTC-USDT-SWAP', venue: 'okx', marketType: 'perpetual' },
  { instrumentId: 'deribit:BTC-PERPETUAL', venue: 'deribit', marketType: 'perpetual' },
  { instrumentId: 'bitget:BTCUSDT', venue: 'bitget', marketType: 'perpetual' },
  { instrumentId: 'coinbase:BTC-USD', venue: 'coinbase', marketType: 'spot' },
];
const ids = markets.map(m => m.instrumentId!);
const book = (venue: string) => ({ id: `${venue}:x`, venue }) as never;
const levels = (venues: string[]): AppState['levels'] => ({ asOf: 0, books: venues.map(book) });
const all = ['hyperliquid', 'binance', 'binancespot', 'bybit', 'okx', 'deribit', 'bitget', 'coinbase'];
const state = (over: Partial<Pick<AppState, 'disabledVenues' | 'scope' | 'levels'>> = {}) => ({ markets, disabledVenues: [] as string[], scope: 'all' as AppState['scope'], levels: levels(all), ...over });
const busy = () => 1_000_000;
const label = (key: string): string => key[0]!.toUpperCase() + key.slice(1);

test('with the Spot filter on, the five exchanges that have no spot market are said to be hidden by it, and one click puts them back', () => {
  // Eight venues are on and flow is recorded for all of them; the column shows two rows: exactly what a person reported.
  const missing = explainMissing(state({ scope: 'spot' }), ids, new Set(['binance', 'coinbase']), busy);
  assert.deepEqual(missing.map(m => [m.key, m.why]), [['hyperliquid', 'filter'], ['bybit', 'filter'], ['okx', 'filter'], ['deribit', 'filter'], ['bitget', 'filter']]);
  const rows = noticeRows(missing, label, 2, 'spot');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.text, 'Hidden by the Spot filter: Hyperliquid, Bybit, Okx, Deribit, Bitget.');
  assert.deepEqual([rows[0]!.action?.label, rows[0]!.action?.run], ['Show both', { kind: 'both' }]);
  assert.match(noticeRows(explainMissing(state({ scope: 'perp' }), ids, new Set(['hyperliquid', 'binance', 'bybit', 'okx', 'deribit', 'bitget']), busy), label, 6, 'perp')[0]!.text, /^Hidden by the Perp filter: Coinbase\.$/, 'a perpetual filter leaves out the exchange that has only a spot market');
  assert.deepEqual(explainMissing(state(), ids, new Set(['hyperliquid', 'binance', 'bybit', 'okx', 'deribit', 'bitget', 'coinbase']), busy), [], 'nothing is missing when every exchange is a row');
});

test('a venue whose chip is off, one with no order book on the map, and one past the row limit each have their own words', () => {
  const off = explainMissing(state({ disabledVenues: ['okx', 'bitget'] }), ids, new Set(['hyperliquid', 'binance', 'bybit', 'deribit', 'coinbase']), busy);
  assert.deepEqual(off.map(m => [m.key, m.why]), [['okx', 'off'], ['bitget', 'off']]);
  const offRows = noticeRows(off, label, 5, 'perp');
  assert.equal(offRows[0]!.text, 'Switched off: Okx, Bitget.');
  assert.deepEqual(offRows[0]!.action?.run, { kind: 'on', venues: ['okx', 'bitget'] }, 'the button switches exactly those venues back on');

  const nobook = explainMissing(state({ levels: levels(all.filter(v => v !== 'bybit')) }), ids, new Set(['hyperliquid', 'binance', 'okx', 'deribit', 'bitget', 'coinbase']), busy);
  assert.deepEqual(nobook.map(m => [m.key, m.why]), [['bybit', 'nobook']]);
  assert.equal(noticeRows(nobook, label, 6, 'perp')[0]!.text, 'Not on the map yet (no order book): Bybit.');
  assert.equal(noticeRows(nobook, label, 6, 'perp')[0]!.action, undefined, 'there is nothing to click for a book that has not arrived');

  const cut = explainMissing(state(), ids, new Set(['hyperliquid', 'binance', 'bybit', 'okx', 'coinbase']), busy);
  assert.deepEqual(cut.map(m => [m.key, m.why]), [['deribit', 'cut'], ['bitget', 'cut']]);
  const cutRows = noticeRows(cut, label, 5, 'all');
  assert.equal(cutRows[0]!.text, 'Showing the biggest 5 of 7 exchanges.');
  assert.equal(cutRows[0]!.full, 'Showing the biggest 5 of 7 exchanges. Deribit, Bitget', 'the tooltip names them');
  assert.deepEqual(cutRows[0]!.action?.run, { kind: 'all' });
});

test('an exchange that has not traded in the ranking window is quiet, not cut, and with several reasons the easiest to undo comes first', () => {
  const quiet = explainMissing(state(), ids, new Set(['hyperliquid', 'binance', 'bybit', 'okx', 'deribit', 'coinbase']), id => id.startsWith('bitget') ? 0 : 5);
  assert.deepEqual(quiet.map(m => [m.key, m.why]), [['bitget', 'quiet']]);
  assert.equal(noticeRows(quiet, label, 6, 'perp')[0]!.text, 'No trades in this window: Bitget.');

  // Binance: its perp chip is off and its spot lane is outside the Perp filter. The filter is the one to say, and Show both is a click away.
  const both = explainMissing(state({ scope: 'perp', disabledVenues: ['binance'] }), ['binance:BTCUSDT', 'binancespot:BTCUSDT'], new Set(), busy);
  assert.deepEqual(both.map(m => [m.key, m.why]), [['binance', 'filter']]);
  // Reasons are listed in the order a person would act on them.
  const mixed = explainMissing(state({ scope: 'spot', disabledVenues: ['coinbase'] }), ids, new Set(['binance']), busy);
  const rows = noticeRows(mixed, label, 1, 'spot');
  assert.deepEqual(rows.map(r => r.action?.label), ['Show both', 'Turn on']);
});

test('a long list of names is cut short in the line and whole in the tooltip', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ key: `venue${i}`, why: 'filter' as const, venues: [`venue${i}`] }));
  const [row] = noticeRows(many, label, 1, 'spot');
  assert.match(row!.text, /Venue0, Venue1, Venue2, Venue3, Venue4, Venue5, …\.$/);
  assert.match(row!.full, /Venue8\.$/);
});

test('the page asks for the flow of every market it knows, whatever the filter and the chips say; what is drawn is chosen from that', () => {
  assert.deepEqual([...flowLoadIds({ markets }, ['extra:BTC'])].sort(), [...ids, 'extra:BTC'].sort());
  const spotOnly = state({ scope: 'spot', disabledVenues: ['coinbase'] });
  assert.deepEqual(flowIds(spotOnly, []), ['binancespot:BTCUSDT'], 'the drawn list is what the filter and the chips leave');
  assert.equal(flowLoadIds(spotOnly, []).length, ids.length, 'the loaded list is all of them');
});
