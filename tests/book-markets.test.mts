import test from 'node:test';
import assert from 'node:assert/strict';
import { bookEmptyMessage, bookIds, bookMarketIds, bookPickOf, bookPickOptions, readBookMarkets } from '../src/app/book-markets.ts';
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

test('chosen markets are the picks\' books in the feed\'s order, whatever the chips and the filter say', () => {
  const s = state({ bookMarkets: 'custom', bookPicks: ['coinbase/spot', 'okx/perp', 'binance/spot', 'kraken/spot'], disabledVenues: ['okx', 'coinbase'], scope: 'perp' });
  assert.deepEqual(bookIds(s), ['okx:BTC-USDT-SWAP', 'binancespot:BTCUSDT', 'coinbase:BTC-USD']);
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
  // Another choice than All switched on is not the filter's: Spot with no spot venue on says nothing while the chosen books are there.
  assert.equal(bookEmptyMessage(state({ bookMarkets: 'custom', bookPicks: ['okx/perp'], scope: 'spot', disabledVenues: ['binancespot', 'coinbase'] })), '');
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

/** Walls and the balance over two perpetual books: `a` lopsided to the bids from `lopsidedAt` on, `b` even. */
function balanceRun(over: Partial<AppState>, lopsidedAt: number, until = 30_000): { kinds: string[]; at: number[] } {
  const s = initialState(false, false);
  s.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }, { instrumentId: 'b:BTC', venue: 'b', marketType: 'perpetual' }] as AppState['markets'];
  s.marketId = 'a:BTC'; s.mark = { price: MARK, asOf: T };
  s.sounds = readSounds({ on: true, volume: 1, panels: { ...DEFAULT_PANEL_SOUNDS, book: { wall: true, usd: 50_000_000 }, depth: { imbalance: true, pct: 60 } } });
  Object.assign(s, over);
  const alerts = new Alerts({ state: s }, new FlowBook(), new FakePlayer(), () => T);
  for (let t = 0; t <= until; t += 2_000) {
    const heavy = t >= lopsidedAt ? 12_000_000 : 1_000_000;
    s.levels = { asOf: T + t, books: [book('a:BTC', [[99_900, heavy]], [[100_100, 1_000_000]], T + t), book('b:BTC', [[99_900, 1_000_000]], [[100_100, 1_000_000]], T + t)] } as LevelsFrame;
    alerts.tick(T + t);
  }
  return { kinds: alerts.log.map(e => e.kind), at: alerts.log.map(e => e.at - T) };
}

test('picks that are exactly the venues switched on sound exactly when All switched on does', () => {
  const all = balanceRun({}, 14_000), picked = balanceRun({ bookMarkets: 'custom', bookPicks: ['a/perp', 'b/perp'] }, 14_000);
  assert.deepEqual(picked, all);
  assert.deepEqual(all.kinds, ['imbalance'], 'a + b: 13M of bids against 2M of asks is 73 %, past 60 %, after the warm-up');
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

test('the depth sound reads the recording of the markets the Depth pane counts', async () => {
  const s = initialState(false, false);
  s.markets = MARKETS; s.marketId = 'binance:BTCUSDT:spot';
  s.sounds = readSounds({ on: true, volume: 1, panels: { ...DEFAULT_PANEL_SOUNDS, depthPane: { extreme: true, range: 0.2, pct: 99, hours: 2 } } });
  const asked: string[] = [];
  const alerts = new Alerts({ state: s }, new FlowBook(), new FakePlayer(), () => T, undefined, ids => { asked.push(ids.join(',')); return new Promise(() => {}); });
  s.bookMarkets = 'chart'; alerts.tick(T);
  assert.deepEqual(asked, ['binance:BTCUSDT:spot,binancespot:BTCUSDT']);
});
