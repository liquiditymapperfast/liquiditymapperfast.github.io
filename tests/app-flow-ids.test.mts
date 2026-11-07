import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BOOK_HOLD_MS, flowIds, instrumentShown, mapVenues, nextBookGone, oiFlowIds, pinChoices } from '../src/app/cvd/ids.ts';
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

test('open interest counts the same markets whatever the Spot / Perp filter says (only perpetuals have it); the chips and the map still count', () => {
  const state = { markets, disabledVenues: [] as string[], scope: 'spot' as const, levels: levels('a:BTC', 'aspot:BTC') };
  assert.deepEqual(oiFlowIds(state, ['b:BTC']).sort(), ['a:BTC', 'aspot:BTC'], 'Spot: the perpetual a as under Both (b has no book)');
  assert.deepEqual(oiFlowIds({ ...state, scope: 'perp' }, []).sort(), ['a:BTC', 'aspot:BTC']);
  assert.deepEqual(oiFlowIds({ ...state, disabledVenues: ['a'] }, []), ['aspot:BTC'], 'a chip switched off');
});

test('a venue whose book leaves the map for a reconnect keeps counting for BOOK_HOLD_MS, then drops; back on the map it is no longer held', () => {
  // Binance spot's feed reconnected for 105 s (2026-10-15) and its flow line vanished from the column, the ALL VENUES lines moving with it.
  const at = (asOf: number, ...ids: string[]): LevelsFrame => ({ asOf, books: ids.map(book) });
  const f0 = at(1_000, 'a:BTC', 'aspot:BTC'), f1 = at(2_000, 'a:BTC');
  const gone = nextBookGone(f0, f1, {});
  assert.deepEqual(gone, { aspot: 1_000 }, 'held from the last frame it was on');
  const s = (levels: LevelsFrame, bookGone: Record<string, number>) => ({ markets, disabledVenues: [] as string[], scope: 'all' as const, levels, bookGone });
  assert.deepEqual(flowIds(s(f1, gone), []).sort(), ['a:BTC', 'aspot:BTC'], 'still counted during the reconnect');
  assert.deepEqual(flowIds(s(f1, {}), []), ['a:BTC'], 'without the hold it was dropped at once (the bug)');

  const late = at(1_000 + BOOK_HOLD_MS + 1, 'a:BTC');
  assert.deepEqual(flowIds(s(late, gone), []), ['a:BTC'], 'gone for longer than the hold: no longer counted');
  assert.deepEqual(nextBookGone(f1, late, gone), {}, 'and dropped from the held list');

  const back = at(3_000, 'a:BTC', 'aspot:BTC');
  assert.deepEqual(nextBookGone(f1, back, gone), {}, 'back on the map');
  assert.equal(nextBookGone(f1, at(2_500, 'a:BTC'), gone), gone, 'nothing changed: the same object, so the store is not told');
  assert.deepEqual(mapVenues(s(f1, gone)), new Set(['a', 'aspot']));
  assert.deepEqual(flowIds({ ...s(f1, gone), disabledVenues: ['aspot'] }, []), ['a:BTC'], 'a chip switched off still drops it at once');
});

test('the exchanges that can be pinned are every one the page knows, spot twins merged, plus those already pinned, sorted by name', () => {
  assert.deepEqual(pinChoices({ markets }, ['c:BTC'], []), ['a', 'b', 'c'], 'a market or flow is enough, chips and books do not matter');
  assert.deepEqual(pinChoices({ markets: [{ instrumentId: 'binance:BTC', venue: 'binance', marketType: 'perpetual' }, { instrumentId: 'binancespot:BTC', venue: 'binancespot', marketType: 'spot' }, { instrumentId: 'okx:BTC', venue: 'okx', marketType: 'perpetual' }] }, ['hyperliquid:BTC'], []), ['binance', 'hyperliquid', 'okx'], 'Binance and Binance spot are one exchange');
  assert.deepEqual(pinChoices({ markets: [] }, [], ['kraken']), ['kraken'], 'a pin on an exchange that is gone can still be taken off');
});

test("the map draws and sounds an instrument's orders by the flow views' rule: its chip on and its book on the map, or there moments ago", () => {
  // Karl, 2026-11-07: Deribit's chip alone on, and OKX's bubbles still drawn: OKX's book was down, so it had no chip to switch off.
  const at = (asOf: number, ...ids: string[]): LevelsFrame => ({ asOf, books: ids.map(book) });
  const frame = at(10_000, 'a:BTC', 'aspot:BTC');
  const shown = (state: Parameters<typeof instrumentShown>[0], ids: string[]): string[] => ids.filter(instrumentShown(state));
  const ids = ['a:BTC', 'aspot:BTC', 'b:BTC-SWAP', 'c:BTC'];
  assert.deepEqual(shown({ disabledVenues: [], levels: frame }, ids), ['a:BTC', 'aspot:BTC'], 'b and c have orders but no book: not drawn with every chip on');
  assert.deepEqual(shown({ disabledVenues: ['aspot'], levels: frame }, ids), ['a:BTC'], 'a chip switched off');
  assert.deepEqual(shown({ disabledVenues: ['a', 'aspot'], levels: frame }, ids), [], 'every chip off: none, the bookless included');
  assert.deepEqual(shown({ disabledVenues: [], levels: frame, bookGone: { b: 10_000 - BOOK_HOLD_MS } }, ids), ['a:BTC', 'aspot:BTC', 'b:BTC-SWAP'], 'b left the map within the hold: still drawn');
  assert.deepEqual(shown({ disabledVenues: [], levels: frame, bookGone: { b: 10_000 - BOOK_HOLD_MS - 1 } }, ids), ['a:BTC', 'aspot:BTC'], 'past the hold: no longer');
  assert.deepEqual(shown({ disabledVenues: ['b'], levels: frame, bookGone: { b: 10_000 } }, ids), ['a:BTC', 'aspot:BTC'], 'held, but its chip off');
  assert.deepEqual(shown({ disabledVenues: [], levels: null }, ids), ids, 'before the first frame nothing is left out');
  assert.deepEqual(shown({ disabledVenues: ['c'], levels: null }, ids), ['a:BTC', 'aspot:BTC', 'b:BTC-SWAP'], 'but a chip switched off is');
  const one = instrumentShown({ disabledVenues: ['aspot'], levels: frame });
  assert.deepEqual([one('aspot:BTC'), one('aspot:ETH'), one('a:ETH'), one('a:BTC'), one('aspot:BTC')], [false, false, true, true, false], 'one predicate answers the same for every instrument of a venue, asked again too');
  assert.deepEqual([one('a'), one('aspot'), one('b')], [true, false, false], 'an id without a market is its venue, as venueOfInstrument reads it');
});

test("the map's marks of orders all go through instrumentShown: none is left filtering by the chips alone", () => {
  // Bubbles, dust, venue lines, absorption and liquidations. A filter by `disabledVenues` alone drew a venue whose book was down (no chip).
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'panes', 'heat-pane.ts'), 'utf8');
  assert.equal([...source.matchAll(/instrumentShown\(state\)/g)].length, 5, 'the dust mask, the venue lines, the bubbles, absorption and the diamonds');
  // And each painter uses it (absorption's use is the call itself, counted above).
  assert.match(source, /bubbleHidden\(print, s\) \|\| !shown\(print\.id\)/, 'the bubbles');
  assert.match(source, /liquidationHidden\(l, s\) \|\| !shown\(l\.id\)/, 'the diamonds');
  assert.match(source, /dust\.setMask\(tape\.ids\.flatMap\(\(id, i\) => shown\(id\) \? \[\] : \[i\]\)\)/, 'the live dust');
  assert.match(source, /i !== chart && shown\(id\)/, 'the venue lines');
  assert.equal([...source.matchAll(/\boff\.includes\(/g)].length, 0, 'no mark filters by the chips alone');
  // The one other reader of the chips counts markets for the candle history estimate (chips and the Spot / Perp filter), not marks.
  assert.equal([...source.matchAll(/disabledVenues\.includes\(/g)].length, 1, 'only the history estimate reads the chips itself');
  const sounds = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'sound', 'sounds.ts'), 'utf8');
  assert.match(sounds, /shown = instrumentShown\(s\)/, 'the trade sounds too');
  assert.doesNotMatch(sounds, /disabledVenues\.includes\(/);
});
