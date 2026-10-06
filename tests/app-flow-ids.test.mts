import test from 'node:test';
import assert from 'node:assert/strict';
import { flowIds } from '../src/app/cvd/ids.ts';
import type { LevelsFrame } from '../src/app/wire.ts';

const book = (id: string) => ({ id, venue: id.split(':')[0]!, timestamp: 0, coarse: false, bids: { lo: new Float64Array(), hi: new Float64Array(), usd: new Float64Array() }, asks: { lo: new Float64Array(), hi: new Float64Array(), usd: new Float64Array() } });
const levels = (...ids: string[]): LevelsFrame => ({ asOf: 0, books: ids.map(book) });
const markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }, { instrumentId: 'aspot:BTC', venue: 'aspot', marketType: 'spot' }, { instrumentId: 'b:BTC', venue: 'b', marketType: 'perpetual' }];

test('the flow views count venues with a book on the map, their chips left on, inside the Spot / Perp filter', () => {
  const state = { markets, disabledVenues: [] as string[], scope: 'all' as const, levels: levels('a:BTC', 'aspot:BTC') };
  assert.deepEqual(flowIds(state, ['b:BTC', 'a:BTC', 'c:BTC']).sort(), ['a:BTC', 'aspot:BTC'], 'b and c have flow but no book');
  assert.deepEqual(flowIds({ ...state, disabledVenues: ['a'] }, []).sort(), ['aspot:BTC'], 'a chip switched off');
  assert.deepEqual(flowIds({ ...state, scope: 'spot' }, []), ['aspot:BTC'], 'the filter');
  assert.deepEqual(flowIds({ ...state, levels: null }, ['c:BTC']).sort(), ['a:BTC', 'aspot:BTC', 'b:BTC', 'c:BTC'], 'before the first frame nothing is excluded');
});
