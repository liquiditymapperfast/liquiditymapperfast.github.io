import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BOOK_HOLD_MS, flowIds, instrumentShown, liquidationIds, mapVenues, nextBookGone, oiFlowIds, pinChoices, shownKey } from '../src/app/cvd/ids.ts';
import { MEASURES } from '../src/app/measures/registry.ts';
import type { LevelsFrame } from '../src/app/wire.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { aggregateIds } from '../src/app/cvd/model.ts';
import { kindOf } from '../src/app/scope.ts';

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

test('liquidations count the perpetuals of the ALL VENUES lines whatever the Spot / Perp filter says; the chips and the map still count', () => {
  // Karl, 2026-11-21: with the Spot filter on, the Flow history's liquidations and open interest rows stayed empty.
  const flow = new FlowBook(), t = Date.UTC(2026, 10, 21, 12);
  flow.apply(['a:BTC', 'aspot:BTC', 'b:BTC', 'c:BTC'].map(id => [id, t, 1_000, 900] as [string, number, number, number]));
  const kind = (id: string) => kindOf(markets, id);
  const state = { markets, disabledVenues: [] as string[], scope: 'spot' as const, levels: levels('a:BTC', 'aspot:BTC') };
  assert.deepEqual(liquidationIds(state, flow, kind), ['a:BTC'], 'Spot: the perpetual a, not its spot market (b and c have no book)');
  assert.deepEqual(liquidationIds({ ...state, scope: 'all' }, flow, kind), ['a:BTC'], 'the same list under Both: one list for the shared loader');
  assert.deepEqual(liquidationIds({ ...state, scope: 'perp' }, flow, kind), ['a:BTC']);
  assert.deepEqual(liquidationIds({ ...state, disabledVenues: ['a'] }, flow, kind), [], 'a chip switched off');
  assert.deepEqual(liquidationIds({ ...state, levels: null }, flow, kind), ['a:BTC', 'b:BTC'], 'before the first frame every perpetual counts; c, which the market list does not classify, does not');
  // Under Both it is what the footprint's Aggregated markets held of the perpetuals, as before.
  const both = { ...state, scope: 'all' as const, levels: null };
  assert.deepEqual(liquidationIds(both, flow, kind), aggregateIds(flow, flowIds(both, flow.ids), kind).filter(id => kind(id) === 'perp').sort());
  // A venue whose book left the map moments ago still counts (BOOK_HOLD_MS), not past the hold.
  const at = (asOf: number, ...ids: string[]): LevelsFrame => ({ asOf, books: ids.map(book) });
  assert.deepEqual(liquidationIds({ ...state, levels: at(10_000, 'aspot:BTC'), bookGone: { a: 10_000 - 1_000 } }, flow, kind), ['a:BTC'], 'held');
  assert.deepEqual(liquidationIds({ ...state, levels: at(10_000 + BOOK_HOLD_MS + 1, 'aspot:BTC'), bookGone: { a: 10_000 } }, flow, kind), [], 'past the hold');
  // One perpetual a venue, as the ALL VENUES lines add them: the first with flow; an unclassified one never takes its place.
  const two = [...markets, { instrumentId: 'a:BTC-2', venue: 'a', marketType: 'perpetual' }], kind2 = (id: string) => kindOf(two, id);
  const flow2 = new FlowBook();
  flow2.apply(['a:ETH', 'a:BTC', 'a:BTC-2'].map(id => [id, t, 1_000, 900] as [string, number, number, number]));
  assert.deepEqual(liquidationIds({ ...state, markets: two, levels: at(0, 'a:BTC') }, flow2, kind2), ['a:BTC'], 'a:ETH, another coin\'s left in the flow book, does not take a\'s lane; a:BTC-2 is a second perpetual');
  assert.deepEqual(aggregateIds(flow2, flowIds({ ...state, markets: two, scope: 'all', levels: at(0, 'a:BTC') }, flow2.ids), kind2).filter(id => kind2(id) !== 'spot'), ['a:ETH'], 'what an unclassified id did to the lane before');
});

test('the Flow history and the Bar stats ask the one liquidation loader with one list, whatever the filter; the perpetual measures count oiFlowIds', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', 'app', ...p), 'utf8');
  const sizes = read('panes', 'size-history-pane.ts'), bars = read('panes', 'lower-panes.ts'), heat = read('panes', 'heat-pane.ts'), strip = read('measures', 'strip.ts');
  for (const [name, source, caller] of [['Flow history', sizes, 'sizes'], ['Bar stats', bars, 'bars']] as const) {
    assert.match(source, /liqMarkets = this\.heat\.liquidationMarkets\(state\)/, name);
    assert.match(source, new RegExp(`liqDays\\.ensure\\('${caller}', liqMarkets\\.join\\(','\\)`), name);
    assert.doesNotMatch(source, /liqDays\.ensure\([^)]*\bmarkets\.join/, `${name}: never the footprint's markets`);
  }
  assert.match(bars, /liqPerps = liqMarkets\.some\(id => kindOf\(state\.markets, id\) !== 'spot'\)/, 'Bar stats: no perpetual, no liquidations (empty cells, not 0)');
  const start = heat.indexOf('liquidationMarkets(state: AppState)'), body = heat.slice(start, heat.indexOf('\n  }\n', start));
  assert.ok(start > 0 && body.includes('liquidationIds(') && !/state\.scope/.test(body), 'the list does not depend on the filter');
  assert.match(heat, /\(measureDef\(metric\)\.perpetualsOnly \? oiFlowIds : flowIds\)/, 'the columns beside the map');
  assert.match(strip, /\(measureDef\(this\.metric\)\.perpetualsOnly \? oiFlowIds : flowIds\)/, 'the bands along the top');
  assert.deepEqual(MEASURES.filter(m => m.perpetualsOnly).map(m => m.id), ['oi', 'liquidations'], 'only perpetuals have open interest and liquidations');
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

test('shownKey changes whenever instrumentShown can answer differently, and not otherwise (the map keeps its largest prints by it)', () => {
  const at = (asOf: number, ...ids: string[]): LevelsFrame => ({ asOf, books: ids.map(book) });
  const frame = at(10_000, 'a:BTC', 'aspot:BTC');
  const base = shownKey({ disabledVenues: [], levels: frame });
  assert.equal(shownKey({ disabledVenues: [], levels: at(20_000, 'aspot:BTC', 'a:BTC') }), base, 'the same books in another order and frame: the same key');
  assert.notEqual(shownKey({ disabledVenues: ['aspot'], levels: frame }), base, 'a chip switched off');
  assert.notEqual(shownKey({ disabledVenues: [], levels: at(10_000, 'a:BTC') }), base, 'a book gone from the map');
  assert.notEqual(shownKey({ disabledVenues: [], levels: frame, bookGone: { b: 10_000 - BOOK_HOLD_MS } }), base, 'a book held moments after it left');
  assert.equal(shownKey({ disabledVenues: [], levels: frame, bookGone: { b: 10_000 - BOOK_HOLD_MS - 1 } }), base, 'past the hold it adds nothing');
  assert.notEqual(shownKey({ disabledVenues: [], levels: null }), base, 'before the first frame every venue is drawn');
});
