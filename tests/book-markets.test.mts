import test from 'node:test';
import assert from 'node:assert/strict';
import { bookEmptyMessage, bookIds, bookMarketIds, bookPickOf, bookPickOptions, booksAskedAgain, readBookMarkets } from '../src/app/book-markets.ts';
import { activeIds, marketIds } from '../src/app/scope.ts';
import { LAYOUT_KEYS, initialState, readSettings, type AppState } from '../src/app/store.ts';
import { Alerts, type Player } from '../src/app/sound/alerts.ts';
import { DEFAULT_PANEL_SOUNDS, readSounds, type Note } from '../src/app/sound/rules.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import type { LevelsFrame, LiveBook } from '../src/app/wire.ts';

// The local server's BTC markets, in part: Binance spot's book is `binancespot:…`, listed apart from the market its trades come from.
const MARKETS: AppState['markets'] = [
  { instrumentId: 'hyperliquid:BTC-PERP', venue: 'hyperliquid', marketType: 'perpetual' },
  { instrumentId: 'binance:BTCUSDT', venue: 'binance', marketType: 'perpetual' },
  { instrumentId: 'binance:BTCUSDT:spot', venue: 'binance', marketType: 'spot' },
  { instrumentId: 'okx:BTC-USDT-SWAP', venue: 'okx', marketType: 'perpetual' },
  { instrumentId: 'coinbase:BTC-USD', venue: 'coinbase', marketType: 'spot' },
  { instrumentId: 'binancespot:BTCUSDT', venue: 'binancespot', marketType: 'spot' },
] as AppState['markets'];
const side = (levels: [number, number][]) => ({ lo: Float64Array.from(levels.map(l => l[0])), hi: Float64Array.from(levels.map(l => l[0])), usd: Float64Array.from(levels.map(l => l[1])) });
const book = (id: string, bids: [number, number][] = [[99_900, 1_000_000]], asks: [number, number][] = [[100_100, 1_000_000]], asOf = 0): LiveBook =>
  ({ id, venue: id.split(':')[0]!, timestamp: asOf, coarse: false, bids: side(bids), asks: side(asks) }) as LiveBook;
// The feed's books, in its order (not sorted): every market but Binance spot's trades.
const FEED = ['okx:BTC-USDT-SWAP', 'binance:BTCUSDT', 'hyperliquid:BTC-PERP', 'binancespot:BTCUSDT', 'coinbase:BTC-USD'];

function state(over: Partial<AppState> = {}): AppState {
  const s = initialState(false, false);
  s.markets = MARKETS; s.marketId = 'binance:BTCUSDT';
  s.levels = { asOf: 0, books: FEED.map(id => book(id)) };
  return Object.assign(s, over);
}

test('a book stands for its exchange and kind: Binance spot\'s book and its trades are one pick', () => {
  assert.equal(bookPickOf(MARKETS, 'binancespot:BTCUSDT'), 'binance/spot');
  assert.equal(bookPickOf(MARKETS, 'binance:BTCUSDT:spot'), 'binance/spot');
  assert.equal(bookPickOf(MARKETS, 'binance:BTCUSDT'), 'binance/perp');
  assert.equal(bookPickOf(MARKETS, 'unknown:X'), 'unknown/perp', 'a market the list does not type counts as a perpetual, as the flow lines say');
});

test('All switched on is exactly the venues switched on inside the Spot / Perp filter, in the same order', () => {
  const s = state({ disabledVenues: ['okx'], scope: 'perp' });
  assert.deepEqual(bookIds(s), activeIds(s));
  assert.deepEqual(bookIds(s), ['binance:BTCUSDT', 'hyperliquid:BTC-PERP']);
  assert.deepEqual(bookMarketIds(s), marketIds(s));
});

test('the chart market is its own book, whatever the chips and the filter say; a Binance spot chart counts the spot book', () => {
  const perp = state({ bookMarkets: 'chart', disabledVenues: ['binance'], scope: 'spot' });
  assert.deepEqual(bookIds(perp), ['binance:BTCUSDT']);
  assert.deepEqual(bookMarketIds(perp), ['binance:BTCUSDT']);
  const spot = state({ bookMarkets: 'chart', marketId: 'binance:BTCUSDT:spot' });
  assert.deepEqual(bookIds(spot), ['binancespot:BTCUSDT'], 'the book, not the market of the trades (which has none)');
  assert.deepEqual(bookMarketIds(spot), ['binance:BTCUSDT:spot', 'binancespot:BTCUSDT'], 'the recording is read for both: the one with no book reads nothing');
  assert.deepEqual(bookIds(state({ bookMarkets: 'chart', marketId: '' })), []);
});

test('chosen markets are the picks\' books, sorted, whatever the chips and the filter say', () => {
  const s = state({ bookMarkets: 'custom', bookPicks: ['coinbase/spot', 'okx/perp', 'binance/spot', 'kraken/spot'], disabledVenues: ['okx', 'coinbase'], scope: 'perp' });
  assert.deepEqual(bookIds(s), ['binancespot:BTCUSDT', 'coinbase:BTC-USD', 'okx:BTC-USDT-SWAP']);
  assert.deepEqual(bookMarketIds(s), ['binance:BTCUSDT:spot', 'binancespot:BTCUSDT', 'coinbase:BTC-USD', 'okx:BTC-USDT-SWAP']);
  assert.deepEqual(bookIds(state({ bookMarkets: 'custom', bookPicks: [] })), [], 'none ticked counts none, never every book');
});

test('the panes say why they have no book to add up', () => {
  assert.equal(bookEmptyMessage(state()), '');
  assert.equal(bookEmptyMessage(state({ disabledVenues: FEED.map(id => id.split(':')[0]!) })), 'No venue is on: switch one on to sum up the order books.');
  assert.match(bookEmptyMessage(state({ scope: 'spot', disabledVenues: ['binancespot', 'coinbase'] })), /No spot venues are enabled/);
  assert.equal(bookEmptyMessage(state({ bookMarkets: 'custom', bookPicks: [] })), 'No market is chosen: tick some under Choose….');
  assert.equal(bookEmptyMessage(state({ bookMarkets: 'custom', bookPicks: ['kraken/spot'] })), 'None of the chosen markets has an order book on this coin.');
  assert.equal(bookEmptyMessage(state({ bookMarkets: 'chart', marketId: 'kraken:BTC/USD' })), 'The chart market has no order book here.');
  assert.equal(bookEmptyMessage(state({ bookMarkets: 'custom', bookPicks: [], levels: null })), '', 'nothing is said before the first books come');
  assert.equal(bookEmptyMessage(state({ bookMarkets: 'chart', markets: [] })), '', 'nor before the market list comes (a spot chart could not be told from a perpetual)');
  // Another choice than All switched on is not the filter's: Spot with no spot venue on says nothing while the chosen books are there.
  assert.equal(bookEmptyMessage(state({ bookMarkets: 'custom', bookPicks: ['okx/perp'], scope: 'spot', disabledVenues: ['binancespot', 'coinbase'] })), '');
});

test('a counted book away from the feed for a moment is still asked for, so the series is the same one with a gap', () => {
  // Binance spot's feed reconnects: its book leaves the frame and `bookGone` holds the venue (cvd/ids.ts) for BOOK_HOLD_MS.
  const levels = { asOf: 1_000_000, books: FEED.filter(id => !id.startsWith('binancespot')).map(id => book(id)) };
  const away = state({ bookMarkets: 'chart', marketId: 'binance:BTCUSDT:spot', levels, bookGone: { binancespot: 1_000_000 - 60_000 } });
  assert.deepEqual(bookIds(away), ['binancespot:BTCUSDT'], 'the book, by its listed market, never the market of the trades');
  assert.equal(bookEmptyMessage(away), '');
  const later = { ...away, bookGone: { binancespot: 1_000_000 - 11 * 60_000 } };
  assert.deepEqual(bookIds(later), []);
  assert.equal(bookEmptyMessage(later), 'The chart market has no order book here.', 'gone longer than the hold: said');
  const picked = { ...away, bookMarkets: 'custom' as const, bookPicks: ['okx/perp', 'binance/spot'] };
  assert.deepEqual(bookIds(picked), ['binancespot:BTCUSDT', 'okx:BTC-USDT-SWAP'], 'sorted, and the same once the book is back: the same key, not asked again');
  assert.deepEqual(bookIds({ ...picked, levels: { asOf: 1_000_000, books: FEED.map(id => book(id)) }, bookGone: {} }), bookIds(picked));
  assert.equal(bookEmptyMessage({ ...away, bookMarkets: 'custom', bookPicks: ['kraken/spot'] }), 'None of the chosen markets has an order book on this coin.', 'another venue held says nothing for the picks');
  // A spot chart whose book never streams (no `binancespot` venue on): the Binance perpetual's feed reconnecting does not stand for it.
  const noSpotBook = { asOf: 1_000_000, books: FEED.filter(id => !id.startsWith('binance')).map(id => book(id)) };
  const perpAway = state({ bookMarkets: 'chart', marketId: 'binance:BTCUSDT:spot', levels: noSpotBook, bookGone: { binance: 1_000_000 - 60_000 } });
  assert.deepEqual(bookIds(perpAway), []);
  assert.equal(bookEmptyMessage(perpAway), 'The chart market has no order book here.');
});

test('the panes ask again when what they count may have changed, and only then', () => {
  const ask = (bookMarkets: AppState['bookMarkets'], ...keys: string[]) => booksAskedAgain({ bookMarkets }, new Set(keys));
  for (const mode of ['all', 'chart', 'custom'] as const) { assert.ok(ask(mode, 'bookMarkets'), mode); assert.ok(ask(mode, 'bookPicks'), mode); }
  assert.ok(ask('all', 'disabledVenues') && ask('all', 'scope') && ask('all', 'heatmapSource'), 'the chips and the filter are what All counts');
  assert.ok(!ask('custom', 'disabledVenues') && !ask('chart', 'scope') && !ask('custom', 'heatmapSource'), 'not what the others count');
  assert.ok(ask('custom', 'scope', 'bookMarkets'), 'a layout changing the choice and the filter together');
  assert.ok(ask('chart', 'marketId') && !ask('custom', 'marketId') && !ask('all', 'marketId'), 'the chart market only for its own book');
  assert.ok(ask('custom', 'markets') && ask('chart', 'markets') && !ask('all', 'markets'), 'the market list decides the picks\' books');
  assert.ok(!ask('all', 'levels') && !ask('custom', 'levels'), 'never every frame');
});

test('the picker lists one row per exchange and kind with a book, perpetual before spot, then the picks kept with none here', () => {
  const rows = bookPickOptions(state(), ['kraken/spot', 'okx/perp']);
  assert.deepEqual(rows.map(r => [r.pick, r.id]), [
    ['binance/perp', 'binance:BTCUSDT'], ['binance/spot', 'binancespot:BTCUSDT'], ['coinbase/spot', 'coinbase:BTC-USD'],
    ['hyperliquid/perp', 'hyperliquid:BTC-PERP'], ['okx/perp', 'okx:BTC-USDT-SWAP'], ['kraken/spot', null]]);
  assert.deepEqual(bookPickOptions(state({ levels: null }), []), []);
});

test('the choice and the picks are saved, read back checked, and part of a layout', () => {
  const s = readSettings({ bookMarkets: 'custom', bookPicks: ['okx/perp', 'okx/perp', 'Binance/Spot', 7, 'binance/spot'] } as never);
  assert.equal(s.bookMarkets, 'custom');
  assert.deepEqual(s.bookPicks, ['okx/perp', 'binance/spot']);
  assert.equal(readSettings({ bookMarkets: 'everything' } as never).bookMarkets, 'all');
  assert.equal(readSettings({}).bookMarkets, 'all');
  assert.deepEqual(readSettings({}).bookPicks, []);
  assert.equal(readBookMarkets('chart'), 'chart');
  for (const key of ['bookMarkets', 'bookPicks']) assert.ok((LAYOUT_KEYS as readonly string[]).includes(key), key);
});

// ---- The sounds count the same books --------------------------------------------------------------------------------------------

class FakePlayer implements Player { played: Note[][] = []; running = true; play(notes: readonly Note[]): boolean { this.played.push([...notes]); return true; } async unlock(): Promise<void> {} }
const T = Date.UTC(2026, 10, 13, 12, 0, 0), MARK = 100_000;

/**
 * Walls and the balance over two perpetual books: `a` lopsided to the bids from `lopsidedAt` on, `b` even. The balance tips at `pct` (60:
 * a and b together, 73 %, tip; 80: only a alone, 85 %, does). `change` is set on the state at `changeAt`.
 */
function balanceRun(over: Partial<AppState>, lopsidedAt: number, until = 30_000, pct = 60, changeAt = Infinity, change: Partial<AppState> = {}, price = MARK): { kinds: string[]; at: number[] } {
  const s = initialState(false, false);
  s.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }, { instrumentId: 'b:BTC', venue: 'b', marketType: 'perpetual' }] as AppState['markets'];
  s.marketId = 'a:BTC'; s.mark = { price, asOf: T };
  s.sounds = readSounds({ on: true, volume: 1, panels: { ...DEFAULT_PANEL_SOUNDS, book: { wall: true, usd: 50_000_000 }, depth: { imbalance: true, pct } } });
  Object.assign(s, over);
  const alerts = new Alerts({ state: s }, new FlowBook(), new FakePlayer(), () => T);
  for (let t = 0; t <= until; t += 2_000) {
    if (t === changeAt) Object.assign(s, change);
    const heavy = t >= lopsidedAt ? 12_000_000 : 1_000_000;
    s.levels = { asOf: T + t, books: [book('a:BTC', [[price - 100, heavy]], [[price + 100, 1_000_000]], T + t), book('b:BTC', [[price - 100, 1_000_000]], [[price + 100, 1_000_000]], T + t)] } as LevelsFrame;
    alerts.tick(T + t);
  }
  return { kinds: alerts.log.map(e => e.kind), at: alerts.log.map(e => e.at - T) };
}

test('picks that are exactly the venues switched on sound as All switched on does, but for a grid step', () => {
  const all = balanceRun({}, 14_000), picked = balanceRun({ bookMarkets: 'custom', bookPicks: ['a/perp', 'b/perp'] }, 14_000);
  assert.deepEqual(picked, all);
  assert.deepEqual(all.kinds, ['imbalance'], 'a + b: 13M of bids against 2M of asks is 73 %, past 60 %, after the warm-up');
  // The mark crosses a step of the 1-2-5 grid (75,000: bins of 20 below 10): the walls start over and, under All, the balance with them; the
  // balance's own sums do not depend on the bins, so under another choice it goes on.
  const step = { mark: { price: 74_990, asOf: T } };
  assert.deepEqual(balanceRun({}, 24_000, 40_000, 60, 20_000, step, 75_010).kinds, []);
  const own = balanceRun({ bookMarkets: 'custom', bookPicks: ['a/perp', 'b/perp'] }, 24_000, 40_000, 60, 20_000, step, 75_010);
  assert.deepEqual(own.kinds, ['imbalance']); assert.equal(own.at[0], 24_000);
});

test('over other books the balance has its own warm-up, and tips on them alone', () => {
  // Over a and b together the balance is (13 - 2) / 15 = 73 %; over b alone it never moves; over a alone it is (12 - 1) / 13 = 85 %.
  const both = balanceRun({}, 14_000), onlyB = balanceRun({ bookMarkets: 'custom', bookPicks: ['b/perp'] }, 14_000), onlyA = balanceRun({ bookMarkets: 'custom', bookPicks: ['a/perp'] }, 14_000);
  assert.ok(both.kinds.includes('imbalance'), 'both books tip');
  assert.ok(!onlyB.kinds.includes('imbalance'), 'the even book alone never tips');
  assert.ok(onlyA.kinds.includes('imbalance'), 'the lopsided book alone tips');
  // Lopsided from the first look: the book as it was found is not news, over the books picked as over the walls'.
  assert.ok(!balanceRun({ bookMarkets: 'custom', bookPicks: ['a/perp'] }, 0).kinds.includes('imbalance'), 'found lopsided during its own warm-up: only watched');
  assert.ok(!balanceRun({}, 0).kinds.includes('imbalance'));
});

test('a change of the books the balance counts is a warm-up of its own, both ways', () => {
  // Chosen b (even) for 20 s, then back to every venue switched on while a and b together are already past the line (73 % > 60 %): the book as
  // it was found, not news, though the walls' own warm-up is long over.
  const back = balanceRun({ bookMarkets: 'custom', bookPicks: ['b/perp'] }, 0, 40_000, 60, 20_000, { bookMarkets: 'all' });
  assert.deepEqual(back.kinds, [], 'no tip on the switch back');
  // Every venue at 80 % (a and b together never reach it), then a alone, already past it (85 %): only watched for its warm-up.
  const away = balanceRun({}, 0, 40_000, 80, 20_000, { bookMarkets: 'custom', bookPicks: ['a/perp'] });
  assert.deepEqual(away.kinds, [], 'no tip on the switch away');
  // The same switch with a turning lopsided after the warm-up: it tips then.
  const later = balanceRun({}, 34_000, 40_000, 80, 20_000, { bookMarkets: 'custom', bookPicks: ['a/perp'] });
  assert.deepEqual(later.kinds, ['imbalance']); assert.equal(later.at[0], 34_000);
  // The chart market's book is its own set too: a's, as the pick of a.
  assert.deepEqual(balanceRun({ bookMarkets: 'chart' }, 14_000, 30_000, 80).kinds, ['imbalance']);
  // Chosen a, with b's chip switched off just before a crosses the line: the chips are not what it counts, so nothing starts over.
  const chip = balanceRun({ bookMarkets: 'custom', bookPicks: ['a/perp'] }, 20_000, 30_000, 80, 18_000, { disabledVenues: ['b'] });
  assert.deepEqual(chip.kinds, ['imbalance']); assert.equal(chip.at[0], 20_000);
});

test('the depth sound with no market to read loads nothing and says nothing', () => {
  const s = initialState(false, false);
  s.markets = MARKETS; s.marketId = 'binance:BTCUSDT';
  s.sounds = readSounds({ on: true, volume: 1, panels: { ...DEFAULT_PANEL_SOUNDS, depthPane: { extreme: true, range: 0.2, pct: 99, hours: 2 } } });
  const asked: string[] = [];
  const alerts = new Alerts({ state: s }, new FlowBook(), new FakePlayer(), () => T, undefined, ids => { asked.push(ids.join(',')); return new Promise(() => {}); });
  s.bookMarkets = 'custom'; s.bookPicks = []; alerts.tick(T);
  assert.deepEqual(asked, []); assert.equal(alerts.depthState, null, 'the Sounds panel does not say it is loading');
});

test('the depth sound reads the recording of the markets the Depth pane counts', async () => {
  const s = initialState(false, false);
  s.markets = MARKETS; s.marketId = 'binance:BTCUSDT:spot';
  s.sounds = readSounds({ on: true, volume: 1, panels: { ...DEFAULT_PANEL_SOUNDS, depthPane: { extreme: true, range: 0.2, pct: 99, hours: 2 } } });
  const asked: string[] = [];
  const alerts = new Alerts({ state: s }, new FlowBook(), new FakePlayer(), () => T, undefined, ids => { asked.push(ids.join(',')); return new Promise(() => {}); });
  s.bookMarkets = 'chart'; alerts.tick(T);
  assert.deepEqual(asked, ['binance:BTCUSDT:spot,binancespot:BTCUSDT']);
});
