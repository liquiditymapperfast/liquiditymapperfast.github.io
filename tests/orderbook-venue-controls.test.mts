import test from 'node:test';
import assert from 'node:assert/strict';
import { readOrderbookVenueCatalog, validateOrderbookVenueChoice, orderbookVenueStatus, boundedText, ORDERBOOK_VENUE_MAX_SELECTED, ORDERBOOK_VENUE_STATUS_MAX } from '../src/core/orderbook-venue-controls.mts';
import { readBoundedJsonResponse } from '../src/core/bounded-json-response.mts';
import { publicOrderbookVenueCatalog } from '../src/server/public-orderbook-selection.mts';
import { VENUE_REGISTRY } from '../src/domain/venue-registry.mts';

function catalog() { return { ok: true, maxSelected: ORDERBOOK_VENUE_MAX_SELECTED, selectedVenues: ['hyperliquid', 'binance', 'bybit', 'okx'],
  venues: publicOrderbookVenueCatalog().map(venue => ({ ...venue, status: 'available' })) }; }

test('all twenty selectable depth integrations agree with the runtime capability registry', () => {
  const value = readOrderbookVenueCatalog(catalog());
  assert.equal(value.venues.length, 20); assert.equal(ORDERBOOK_VENUE_MAX_SELECTED, 32);
  for (const venue of value.venues) { assert.equal(venue.supported, true, venue.id);
    assert.equal(VENUE_REGISTRY.find(entry => entry.venue === venue.id)?.capabilities.l2.state, 'supported', venue.id); }
  assert.deepEqual(value.selectedVenues, ['hyperliquid', 'binance', 'bybit', 'okx']);
});

test('finite public selector payload fits the bounded browser reader without dropping venue rows', async () => {
  const raw = await readBoundedJsonResponse(new Response(JSON.stringify(catalog())),
    { maxBytes: 16_384, maxChunks: 64, maxJsonTokens: 512, maxJsonDepth: 8 });
  assert.equal(readOrderbookVenueCatalog(raw).venues.length, 20);
});

test('empty, eight and nine venue selections are valid; duplicate, unsupported and oversized selections are refused', () => {
  const value = readOrderbookVenueCatalog(catalog());
  assert.deepEqual(validateOrderbookVenueChoice(value, []), []);
  const eight = value.venues.slice(0, 8).map(venue => venue.id);
  assert.deepEqual(validateOrderbookVenueChoice(value, eight), eight);
  assert.deepEqual(validateOrderbookVenueChoice(value, eight.concat('kraken')), eight.concat('kraken'));
  for (const invalid of [null, {}, 'binance', ['binance', 'binance'], ['unknown'], Array.from({ length: ORDERBOOK_VENUE_MAX_SELECTED + 1 }, (_, i) => 'venue' + i)])
    assert.throws(() => validateOrderbookVenueChoice(value, invalid));
  value.venues[0].supported = false;
  assert.throws(() => validateOrderbookVenueChoice(value, ['hyperliquid']));
});

test('catalog validation rejects false limits, unbounded text, duplicate IDs and fabricated selection', () => {
  const valid = catalog();
  for (const patch of [{ maxSelected: 9 }, { selectedVenues: ['unknown'] }, { selectedVenues: ['binance', 'binance'] },
    { venues: [] }, { venues: [...valid.venues, valid.venues[0]] }, { selectedVenues: Array(9).fill('binance') },
    { venues: [{ ...valid.venues[0], name: 'x'.repeat(81) }] }, { venues: [{ ...valid.venues[0], supported: 'true' }] }])
    assert.throws(() => readOrderbookVenueCatalog({ ...valid, ...patch }));
  assert.throws(() => readOrderbookVenueCatalog({ ok: false, error: 'unavailable' }), /unavailable/);
});

test('the reason a venue is degraded is carried in its status, and however long it is the catalogue stays valid', () => {
  const crossed = 'book crossed by 123 bp, left off the map';
  assert.equal(orderbookVenueStatus({ selected: true, depthStates: ['live'], fault: crossed }), `live, ${crossed}`);
  assert.ok(`live, ${crossed}`.length > 40, 'the case that used to make the whole catalogue throw');
  const value = catalog();
  value.venues[1]!.status = orderbookVenueStatus({ selected: true, depthStates: ['live'], fault: crossed });
  assert.equal(readOrderbookVenueCatalog(value).venues[1]!.status, `live, ${crossed}`, 'it now fits the bound as it is');
  const long = orderbookVenueStatus({ selected: true, depthStates: ['live'], fault: 'x'.repeat(500) });
  assert.ok(long.length <= ORDERBOOK_VENUE_STATUS_MAX && long.endsWith('…'), long);
  value.venues[2]!.status = long;
  assert.doesNotThrow(() => readOrderbookVenueCatalog(value), 'a runaway reason is cut, not rejected');
});

test('a venue status names where its depth feed is, and is never empty', () => {
  assert.equal(orderbookVenueStatus({ selected: false, depthStates: ['live'] }), 'available', 'a venue that is not selected is only available');
  assert.equal(orderbookVenueStatus({ selected: true, depthStates: ['reconnecting', 'live'] }), 'live');
  assert.equal(orderbookVenueStatus({ selected: true, depthStates: ['reconnecting'] }), 'reconnecting');
  assert.equal(orderbookVenueStatus({ selected: true, depthStates: [], fallback: 'unavailable' }), 'unavailable');
  assert.equal(orderbookVenueStatus({ selected: true, depthStates: [] }), 'connecting');
  assert.equal(orderbookVenueStatus({ selected: true, depthStates: ['live'], fault: '   ' }), 'live', 'a blank reason adds nothing');
  assert.equal(boundedText('  a  \n b ', 10), 'a b', 'whitespace is tidied');
  assert.equal(boundedText('abcdef', 4), 'abc…');
});
