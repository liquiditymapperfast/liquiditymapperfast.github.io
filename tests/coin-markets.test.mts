import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BTC, COIN_VENUES, OPTIONAL_VENUES, instrumentIdFor, parseCatalogue, type Coin } from '../src/shared/coins.ts';
import { BinancePerpConnector, BinancePerpTrades, BinanceSpotBook, DeribitConnector, HyperliquidConnector, MexcConnector, OkxConnector, browserVenues, BROWSER_VENUES } from '../src/shared/venues.ts';
import { buildMexcSubscription } from '../src/adapters/mexc.mts';
import { FlowSources } from '../src/server/v2/flow-sources.mts';
import type { BookConnector, Market, TradeEvent } from '../src/shared/connector.ts';
import { Engine } from '../src/shared/engine.ts';
import type { BrowserVenue } from '../src/shared/venues.ts';
import { fetchCandles, fetchOiHistory, fetchOiSample } from '../src/shared/history.ts';
import { forCoin, tierFor } from '../src/app/coin.ts';
import { price as fmtPrice, stepDecimals } from '../src/app/format.ts';
import { GROUPS, groupsFor } from '../src/app/panes/ladder-zoom.ts';
import { sizeBucketLabels } from '../src/app/panes/bar-stats.ts';
import { matchCoins, scaleText } from '../src/app/coin-dialog.ts';
import { keptChoice } from '../src/app/browser-source.ts';
import { restoreSelection } from '../src/shared/venues.ts';

type Inside = { url(): string; open(send: (p: unknown) => void): void; usdOf(price: number, size: number): number };
const inside = (c: BookConnector): Inside => c as unknown as Inside;
const trades = (c: BookConnector): TradeEvent[] => { const out: TradeEvent[] = []; c.onTrade = t => { out.push(t); }; return out; };
const msg = (value: unknown): string => JSON.stringify(value);
const shipped = parseCatalogue(JSON.parse(fs.readFileSync('src/app/public/coins.json', 'utf8')))!;
const coin = (name: string): Coin => shipped.coins.find(c => c.coin === name)!;
/** Connectors whose open() asks a REST endpoint (a snapshot or the contract size) are only looked at by address here. */
const fetchesOnOpen = (c: BookConnector): boolean => c instanceof BinancePerpConnector || c instanceof BinanceSpotBook || c instanceof OkxConnector;
function frames(c: BookConnector): unknown[] { const sent: unknown[] = []; if (!fetchesOnOpen(c)) inside(c).open(p => sent.push(p)); return sent; }

test('BTC is read exactly as before: the same instruments, addresses and subscriptions', () => {
  const made = BROWSER_VENUES.map(v => v.make());
  assert.deepEqual(made.map(m => m.book.instrumentId), ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP', 'bitget:BTCUSDT', 'hyperliquid:BTC-PERP', 'deribit:BTC-PERPETUAL', 'binancespot:BTCUSDT', 'coinbase:BTC-USD', 'bybitspot:BTCUSDT', 'okxspot:BTC-USDT', 'bitgetspot:BTCUSDT', 'mexc:BTC_USDT'], 'the eleven as they were, and MEXC after them');
  assert.deepEqual(made.flatMap(m => [m.book, ...m.feeds]).map(c => inside(c).url()), [
    'wss://fstream.binance.com/public/ws/btcusdt@depth@100ms', 'wss://fstream.binance.com/market/ws/btcusdt@aggTrade', 'wss://stream.bybit.com/v5/public/linear', 'wss://ws.okx.com:8443/ws/v5/public',
    'wss://ws.bitget.com/v2/ws/public', 'wss://api.hyperliquid.xyz/ws', 'wss://www.deribit.com/ws/api/v2', 'wss://stream.binance.com:9443/ws/btcusdt@depth@100ms', 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade',
    'wss://ws-feed.exchange.coinbase.com', 'wss://stream.bybit.com/v5/public/spot', 'wss://ws.okx.com:8443/ws/v5/public', 'wss://ws.bitget.com/v2/ws/public', 'wss://contract.mexc.com/edge']);
  const sent = Object.fromEntries(made.map(m => [m.book.id, frames(m.book)]));
  assert.deepEqual(sent.bybit, [{ op: 'subscribe', args: ['orderbook.1000.BTCUSDT', 'publicTrade.BTCUSDT', 'allLiquidation.BTCUSDT'] }], 'and its liquidations on the same socket');
  assert.deepEqual(made.flatMap(m => m.liquidations ?? []).map(c => inside(c).url()), ['wss://fstream.binance.com/market/stream?streams=btcusdt@forceOrder/btcusdt@markPrice@1s'], 'Binance liquidations on a socket of their own');
  assert.deepEqual(sent.bitget, [{ op: 'subscribe', args: [{ instType: 'USDT-FUTURES', channel: 'books', instId: 'BTCUSDT' }, { instType: 'USDT-FUTURES', channel: 'trade', instId: 'BTCUSDT' }] }]);
  assert.deepEqual(sent.hyperliquid, [{ method: 'subscribe', subscription: { type: 'l2Book', coin: 'BTC', nSigFigs: 3 } }, { method: 'subscribe', subscription: { type: 'trades', coin: 'BTC' } }]);
  assert.deepEqual(sent.deribit, [{ jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: ['book.BTC-PERPETUAL.10.20.100ms', 'trades.BTC-PERPETUAL.100ms'] } }]);
  assert.deepEqual(sent.coinbase, [{ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['level2_batch', 'matches'] }]);
  assert.deepEqual(sent.okxspot, [{ op: 'subscribe', args: [{ channel: 'books', instId: 'BTC-USDT' }, { channel: 'trades', instId: 'BTC-USDT' }] }]);
  assert.equal((made[2]!.book as OkxConnector).contract, 0.01);
  assert.equal(inside(made[5]!.book).usdOf(80_000, 10), 10, 'Deribit BTC is sized in USD');
  for (const m of made) assert.equal(m.book.base, 'BTC');
});

test('every other coin is subscribed by its own names: nothing it asks for says BTC', () => {
  let checked = 0;
  for (const c of shipped.coins) {
    if (c.coin === 'BTC' || c.coin.includes('BTC')) continue;
    for (const venue of browserVenues(c)) {
      if (!venue.listed) { assert.equal(c.markets[venue.id as keyof Coin['markets']], undefined); assert.throws(() => venue.make()); continue; }
      const { book, feeds, liquidations } = venue.make();
      assert.equal(book.instrumentId, instrumentIdFor(venue.id, c), `${c.coin} ${venue.id}`);
      assert.equal(book.base, c.coin);
      for (const connector of [book, ...feeds, ...(liquidations ?? [])]) {
        const said = JSON.stringify([inside(connector).url(), frames(connector), connector.instrumentId]);
        assert.ok(!said.includes('BTC') && !said.includes('btc'), `${c.coin} ${venue.id}: ${said}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 1000, `${checked} connectors`);
});

const pepe: Market = { coin: 'PEPE', symbol: '1000PEPEUSDT', unit: 1000 };

test('a market that lists in thousands is drawn and counted in single coins: book, trades and their USD', () => {
  const book = new BinancePerpConnector(pepe);
  book.state = 'connecting';
  book.seed(10, [[0.004, 500_000]], [[0.0041, 200_000]]);
  const valued = book.valued(Date.now())!;
  assert.ok(valued, 'a live book');
  assert.equal(valued.bids.lo[0], 0.004 / 1000); assert.equal(valued.asks.lo[0], 0.0041 / 1000);
  assert.equal(valued.bids.usd[0], 0.004 * 500_000, 'USD is the same in either unit');
  const feed = new BinancePerpTrades(pepe), got = trades(feed);
  feed.onMessage(msg({ e: 'aggTrade', a: 7, p: '0.004', q: '250000', T: 1_700_000_000_000, m: false }));
  assert.deepEqual(got.map(t => [t.instrumentId, t.price, t.amount, t.notionalUsd]), [['binance:1000PEPEUSDT', 0.004 / 1000, 250_000 * 1000, 0.004 * 250_000]]);
  assert.equal(inside(feed).url(), 'wss://fstream.binance.com/market/ws/1000pepeusdt@aggTrade');
});

test('Hyperliquid subscribes and names trades by its own name for the coin, and counts its thousands', () => {
  const hl = new HyperliquidConnector({ coin: 'PEPE', symbol: 'kPEPE', unit: 1000 }), got = trades(hl);
  assert.equal(hl.instrumentId, 'hyperliquid:kPEPE-PERP');
  hl.onMessage(msg({ channel: 'trades', data: [{ coin: 'kPEPE', side: 'B', px: '0.004', sz: '1000', time: 1_700_000_000_000, tid: 5, hash: '0xabc' }] }));
  assert.deepEqual(got.map(t => [t.tradeId, t.price, t.amount, t.notionalUsd]), [['1700000000000:kPEPE:5', 0.004 / 1000, 1_000_000, 4]]);
});

test('Deribit: ETH is sized in USD like BTC, the USDC perpetuals in coins, and neither is grouped like BTC', () => {
  const eth = new DeribitConnector({ coin: 'ETH', symbol: 'ETH-PERPETUAL', unit: 1, inverse: true }), ethTrades = trades(eth);
  assert.deepEqual(frames(eth), [{ jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: ['book.ETH-PERPETUAL.none.20.100ms', 'trades.ETH-PERPETUAL.100ms'] } }]);
  assert.equal(inside(eth).usdOf(2500, 1000), 1000);
  eth.onMessage(msg({ params: { channel: 'trades.ETH-PERPETUAL.100ms', data: [{ trade_id: 'e1', price: 2500, amount: 5000, timestamp: 1_700_000_000_000, direction: 'buy' }] } }));
  assert.deepEqual(ethTrades.map(t => [t.amount, t.notionalUsd]), [[2, 5000]]);
  const doge = new DeribitConnector({ coin: 'DOGE', symbol: 'DOGE_USDC-PERPETUAL', unit: 1 }), dogeTrades = trades(doge);
  assert.equal(inside(doge).usdOf(0.1, 1000), 100);
  doge.onMessage(msg({ params: { channel: 'trades.DOGE_USDC-PERPETUAL.100ms', data: [{ trade_id: 'd1', price: 0.1, amount: 3000, timestamp: 1_700_000_000_000, direction: 'sell' }] } }));
  assert.deepEqual(dogeTrades.map(t => [t.side, t.amount, t.notionalUsd]), [['sell', 3000, 300]]);
  doge.state = 'connecting';
  doge.onMessage(msg({ params: { channel: 'book.DOGE_USDC-PERPETUAL.none.20.100ms', data: { bids: [[0.0999, 100]], asks: [[0.1001, 100]] } } }));
  const book = doge.valued(Date.now())!;
  assert.equal(book.coarse, false, 'ungrouped levels are exact');
});

test('OKX swaps are sized by the contract the coin list carries', () => {
  const doge = new OkxConnector({ coin: 'DOGE', symbol: 'DOGE-USDT-SWAP', unit: 1, contract: 1000 }), got = trades(doge);
  doge.onMessage(msg({ arg: { channel: 'trades' }, data: [{ tradeId: 't', px: '0.1', sz: '2', side: 'buy', ts: '1700000000000' }] }));
  assert.deepEqual(got.map(t => [t.amount, t.notionalUsd]), [[2000, 200]]);
});

test('candles and open interest are asked for by the coin\'s own symbols and converted to single coins', async () => {
  const asked: string[] = [];
  const candles = await fetchCandles('binance:1000PEPEUSDT', 3_600_000, 0, 3_600_000, async url => { asked.push(url); return [[0, '0.004', '0.005', '0.003', '0.0045', '2000']]; }, pepe);
  assert.match(asked[0]!, /symbol=1000PEPEUSDT&/);
  assert.deepEqual(candles[0]!.slice(1, 6), [0.004 / 1000, 0.005 / 1000, 0.003 / 1000, 0.0045 / 1000, 2_000_000]);
  const oi = await fetchOiHistory('binance:1000PEPEUSDT', 3_600_000, 0, 3_600_000, async url => { asked.push(url); return [{ timestamp: 0, sumOpenInterest: '5' }]; }, pepe);
  assert.match(asked[1]!, /openInterestHist\?symbol=1000PEPEUSDT&/); assert.equal(oi[0]!.close, 5000);
  const ctx = [{ universe: [{ name: 'BTC' }, { name: 'kPEPE' }] }, [{ openInterest: '1' }, { openInterest: '7' }]];
  assert.equal(await fetchOiSample('hyperliquid', async () => ctx, { symbol: 'kPEPE', unit: 1000 }), 7000);
  assert.equal(await fetchOiSample('hyperliquid', async () => ctx), 1, 'BTC unless told otherwise');
});

test('the engine starts only the markets that list the coin, says which do not, and keeps the coin\'s smaller floors', () => {
  const started: string[] = [];
  class Fake {
    state = 'stopped'; onTrade = () => {}; everLive = false; failures = 0; lastError = null; lastFailure = null; constructor(readonly id: string) {}
    get instrumentId() { return `${this.id}:X`; } start() { started.push(this.id); } stop() {} valued() { return null; }
  }
  const venues: BrowserVenue[] = [
    { id: 'binance', name: 'Binance', kind: 'perp', recommended: true, listed: true, probe: { url: 'https://x.example' }, make: () => ({ book: new Fake('binance') as unknown as BookConnector, feeds: [] }) },
    { id: 'coinbase', name: 'Coinbase', kind: 'spot', recommended: true, listed: false, probe: { url: 'https://x.example' }, make: () => { throw new Error('not listed'); } },
  ];
  const engine = new Engine({ coin: { ...BTC, coin: 'AAA', tier: 2 }, venues, get: async () => { throw new Error('offline'); }, ping: async () => true });
  engine.select(['binance', 'coinbase']);
  assert.deepEqual(started, ['binance']); assert.deepEqual(engine.selected, ['binance']);
  assert.deepEqual(engine.venueStatus().map(v => [v.id, v.listed, v.state]), [['binance', true, 'connecting'], ['coinbase', false, 'off']]);
  assert.equal(engine.printStream.floorUsd, 2_500); assert.equal(engine.footprints.sizeScale, 0.1);
  assert.equal(new Engine({ venues: [], get: async () => [] }).printStream.floorUsd, 25_000, 'BTC keeps its floors');
});

test('a coin\'s tier stays what its recordings were made at while they last, and saved choices move to the coin\'s instrument', () => {
  const now = Date.UTC(2026, 9, 7);
  const aaa = { ...BTC, coin: 'AAA', tier: 3 };
  assert.equal(tierFor(aaa, now, {}), 3);
  assert.equal(tierFor(aaa, now, { AAA: { at: now - 3_600_000, tier: 2 } }), 2, 'recordings made at tier 2 are still kept');
  assert.equal(tierFor(aaa, now, { AAA: { at: now - 2 * 86_400_000, tier: 2 } }), 3, 'nothing left from then');
  assert.equal(tierFor(BTC, now, { BTC: { at: now, tier: 3 } }), 0);
  const moved = forCoin({ heatmapSource: 'binance:BTCUSDT', ladderVenue: 'hyperliquid:BTC-PERP', ladderVenues: ['coinbase:BTC-USD', 'okx:BTC-USDT-SWAP'] }, coin('LIT'), BTC);
  assert.deepEqual(moved, { heatmapSource: 'binance:LITUSDT', ladderVenue: 'hyperliquid:LIT-PERP', ladderVenues: ['coinbase:BTC-USD', 'okx:LIT-USDT-SWAP'] }, 'a market without the coin keeps the old choice');
  assert.deepEqual(forCoin({ heatmapSource: 'aggregated', ladderVenue: '', ladderVenues: [] }, coin('LIT'), BTC), { heatmapSource: 'aggregated', ladderVenue: '', ladderVenues: [] });
  assert.deepEqual(forCoin(moved, BTC, coin('LIT')).heatmapSource, 'binance:BTCUSDT', 'and back');
  // A server's own instruments (a server set to a spot market) are nobody's browser instrument: they never move, and on the coin the
  // choices were made on nothing moves at all.
  const server = { heatmapSource: 'binance:BTCUSDT:spot', ladderVenue: 'okx:BTC-USDT', ladderVenues: ['bybit:BTCUSDT:spot'] };
  assert.deepEqual(forCoin(server, BTC, null), server);
  assert.deepEqual(forCoin(server, coin('LIT'), BTC), server);
});

test('a venue choice applied on a coin some markets do not list leaves those markets as the saved choice had them', () => {
  const all = BROWSER_VENUES.map(v => v.id), unlisted = new Set(['binancespot', 'coinbase']), listedOnly = all.filter(id => !unlisted.has(id));
  const noBitget = listedOnly.filter(id => id !== 'bitget');
  // Nothing saved before: the two stay unseen, so BTC starts them as recommended ones.
  const first = keptChoice(noBitget, all, unlisted, { selected: null, known: null });
  assert.deepEqual(first.known.filter(id => unlisted.has(id)), []);
  assert.deepEqual(restoreSelection(first.selected, first.known)!.sort(), all.filter(id => id !== 'bitget').sort(), 'on BTC: every market but the one left out');
  // A choice that had left Coinbase out keeps it out, and keeps Binance spot in.
  const before = { selected: all.filter(id => id !== 'coinbase'), known: all };
  const later = keptChoice(noBitget, all, unlisted, before);
  assert.deepEqual(restoreSelection(later.selected, later.known)!.sort(), all.filter(id => id !== 'coinbase' && id !== 'bitget').sort());
  assert.deepEqual(later.known.sort(), [...all].sort());
  // A choice saved before the seen list was kept knew the first eight.
  const old = keptChoice(listedOnly, all, unlisted, { selected: ['binance', 'binancespot'], known: null });
  assert.ok(old.selected.includes('binancespot') && !old.selected.includes('coinbase'));
  assert.ok(old.known.includes('coinbase'), 'Coinbase was among the first eight, so it was seen and left out');
});

test('the order book steps, the size buckets and the coin search follow the coin', () => {
  assert.equal(groupsFor(83_000), GROUPS); assert.equal(groupsFor(0), GROUPS);
  assert.deepEqual(groupsFor(2_500).slice(0, 3), [0.001, 0.002, 0.005]);
  assert.equal(groupsFor(0.000004)[0], 1e-11);
  assert.deepEqual(sizeBucketLabels(), ['< $25K', '$25K-50K', '$50K-100K', '$100K-250K', '$250K-500K', '$500K-1M', '$1M-5M', '$5M+'], 'BTC\'s are as they were');
  const found = matchCoins(shipped.coins, 'pe'), starts = found.filter(c => c.coin.startsWith('PE')).length;
  assert.ok(starts > 0 && found.every((c, i) => c.coin.includes('PE') && (i < starts) === c.coin.startsWith('PE')), 'names that start with it first, then the rest that contain it');
  assert.equal(matchCoins(shipped.coins, '').length, shipped.coins.length);
  assert.equal(scaleText(0.1), '×0.1'); assert.equal(scaleText(0.04), '×0.04');
  assert.deepEqual(BROWSER_VENUES.map(v => v.id).sort(), [...COIN_VENUES, ...OPTIONAL_VENUES].sort(), 'the eleven of the coin list, and the optional ones');
});


test('MEXC: the best 20 levels and trades on one socket, sizes in contracts of 0.0001 BTC, optional, and no probe a page cannot read', () => {
  const mexc = new MexcConnector(), got = trades(mexc);
  assert.equal(mexc.instrumentId, 'mexc:BTC_USDT');
  assert.deepEqual(frames(mexc), [{ method: 'sub.depth.full', param: { symbol: 'BTC_USDT', limit: 20 } }, { method: 'sub.deal', param: { symbol: 'BTC_USDT' } }]);
  mexc.state = 'connecting';
  mexc.onMessage(msg({ symbol: 'BTC_USDT', channel: 'push.depth.full', data: { asks: [[81_260.4, 5_380, 1]], bids: [[81_260.3, 10_000, 2]] }, ts: 1 }));
  const book = mexc.valued(Date.now())!;
  assert.equal(book.bids.usd[0], 81_260.3 * 10_000 * 0.0001, '10,000 contracts are one BTC');
  mexc.onMessage(msg({ symbol: 'BTC_USDT', channel: 'push.deal', data: [{ p: 81_260.4, v: 21, T: 1, O: 1, M: 2, t: 1_791_474_003_558, i: '16532415089' }, { p: 81_260.3, v: 300, T: 2, t: 1_791_474_003_560, i: '16532415090' }], ts: 1 }));
  assert.deepEqual(got.map(t => [t.tradeId, t.side, t.amount, t.notionalUsd]), [['16532415089', 'buy', 21 * 0.0001, 81_260.4 * (21 * 0.0001)], ['16532415090', 'sell', 300 * 0.0001, 81_260.3 * (300 * 0.0001)]]);
  mexc.onMessage(msg({ symbol: 'ETH_USDT', channel: 'push.deal', data: [{ p: 1, v: 1, T: 1, t: 1, i: 'x' }] }));
  assert.equal(got.length, 2, 'another symbol is not this book');
  mexc.onMessage(msg({ channel: 'rs.error', data: 'symbol not exist' }));
  assert.equal(mexc.state, 'error');
  const venue = BROWSER_VENUES.find(v => v.id === 'mexc')!;
  assert.equal(venue.recommended, false); assert.equal(venue.probe, null); assert.equal(venue.kind, 'perp');
  assert.equal(BROWSER_VENUES[BROWSER_VENUES.length - 1]!.id, 'mexc', 'last: the reference price is taken in this order');
  assert.equal(browserVenues(coin('PEPE')).find(v => v.id === 'mexc')!.listed, false, 'other coins until the coin list carries MEXC');
});

test('the server takes MEXC trades from this connector when it has the MEXC book the feed manager names the same way', () => {
  const request = buildMexcSubscription('depth', { symbol: 'BTC_USDT', limit: 20 });
  assert.equal(`mexc:${String(request.symbol).toUpperCase()}`, new MexcConnector().instrumentId, 'the feed manager\'s instrument id');
  const started: string[] = [];
  const venues: BrowserVenue[] = [{ ...BROWSER_VENUES.find(v => v.id === 'mexc')!, make: () => { const book = new MexcConnector(); book.start = () => { started.push(book.instrumentId); }; return { book, feeds: [] }; } }];
  const sources = new FlowSources(() => {}, () => 0, venues);
  sources.sync(new Set(['binance:BTCUSDT']));
  assert.deepEqual(started, [], 'no MEXC book on the server: no MEXC trades');
  sources.sync(new Set(['mexc:BTC_USDT']));
  assert.deepEqual(started, ['mexc:BTC_USDT']);
});

test('a venue with no probe that never connects is reported as failing, never as refusing this country', () => {
  class Fake {
    state = 'error'; onTrade = () => {}; everLive = false; failures = 3; lastError = 'socket closed'; lastFailure = 'socket closed';
    get instrumentId() { return 'mexc:BTC_USDT'; } start() {} stop() {} valued() { return null; }
  }
  class Live extends Fake { override state = 'live'; override everLive = true; override failures = 0; override get instrumentId() { return 'binance:BTCUSDT'; } }
  let pinged = 0;
  const venues: BrowserVenue[] = [
    { id: 'binance', name: 'Binance', kind: 'perp', recommended: true, listed: true, probe: { url: 'https://x.example' }, make: () => ({ book: new Live() as unknown as BookConnector, feeds: [] }) },
    { id: 'mexc', name: 'MEXC', kind: 'perp', recommended: false, listed: true, probe: null, make: () => ({ book: new Fake() as unknown as BookConnector, feeds: [] }) },
  ];
  const engine = new Engine({ venues, get: async () => { throw new Error('offline'); }, ping: async () => { pinged++; return false; }, now: () => 1e12 });
  engine.select(['binance', 'mexc']);
  for (let i = 0; i < 3; i++) engine.step(1e12 + i * 20_000);
  assert.equal(engine.venueStatus().find(v => v.id === 'mexc')!.state, 'error');
  assert.equal(pinged, 0, 'nothing asked');
});


test('a price is written with as many decimals as its step needs, up to twelve, and BTC\'s steps read as they did', () => {
  assert.equal(stepDecimals(0.25), 2); assert.equal(stepDecimals(2.5), 1); assert.equal(stepDecimals(25), 0); assert.equal(stepDecimals(2.5e-9), 10);
  assert.equal(fmtPrice(2_572.5, 2.5), '2,572.5', 'a step of 2.5 keeps its half');
  assert.equal(fmtPrice(2_570.25, 0.25), '2,570.25');
  assert.equal(fmtPrice(0.000004065, 1e-11), '0.00000406500');
  assert.equal(fmtPrice(83_545, 25), '83,545'); assert.equal(fmtPrice(83_545.5, 0.5), '83,545.5'); assert.equal(fmtPrice(83_545, 10), '83,545');
});
