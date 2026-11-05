import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PICKS, oiMarketIds, pickOptions, readCustomMarkets, readPicks, resolvePicks } from '../src/app/market-choice.ts';
import { readSettings, type Market } from '../src/app/store.ts';

const market = (id: string, marketType: 'spot' | 'perpetual'): Market => ({ id, instrumentId: id, venue: id.split(':')[0], marketType });
const BTC: Market[] = [market('binance:BTCUSDT', 'perpetual'), market('binance:BTCUSDT:spot', 'spot'), market('binancespot:BTCUSDT', 'spot'), market('bybit:BTCUSDT', 'perpetual'),
  market('bybitspot:BTCUSDT', 'spot'), market('okx:BTC-USDT-SWAP', 'perpetual'), market('coinbase:BTC-USD', 'spot'), market('deribit:BTC-PERPETUAL', 'perpetual'), market('mexc:BTC_USDT', 'perpetual')];
const ETH: Market[] = [market('binance:ETHUSDT', 'perpetual'), market('binance:ETHUSDT:spot', 'spot'), market('bybit:ETHUSDT', 'perpetual'), market('okx:ETH-USDT-SWAP', 'perpetual')];
const state = (markets: Market[], extra: object = {}) => ({ markets, disabledVenues: [], scope: 'all' as const, levels: null, oiMarkets: 'custom' as const, customMarkets: { footprint: [], oi: [] }, ...extra });

test('picks are exchanges and kinds, never ids: the same picks give BTC\'s markets on BTC and ETH\'s on ETH, never BTC\'s on ETH', () => {
  const picks = ['binance/perp', 'binance/spot', 'bybit/spot', 'coinbase/spot'];
  assert.deepEqual(resolvePicks(state(BTC), null, picks, false), ['binance:BTCUSDT', 'binance:BTCUSDT:spot', 'bybitspot:BTCUSDT', 'coinbase:BTC-USD']);
  assert.deepEqual(resolvePicks(state(ETH), null, picks, false), ['binance:ETHUSDT', 'binance:ETHUSDT:spot'], 'ETH lists no Bybit spot and no Coinbase: those count nothing');
  // Binance spot comes over two feeds (binance:…:spot and binancespot:…): one pick, one market, as the ALL VENUES lines count it.
  assert.equal(pickOptions(state(BTC), null, [], false).filter(o => o.pick === 'binance/spot').length, 1);
  assert.deepEqual(resolvePicks(state(BTC), null, [], false), [], 'an empty list counts none');
});

test('the picker lists one row per exchange and kind, perpetuals of OI venues only for open interest, and keeps a pick this coin lacks', () => {
  const rows = pickOptions(state(ETH), null, ['coinbase/spot'], false);
  assert.deepEqual(rows.map(r => [r.pick, r.id]), [['binance/perp', 'binance:ETHUSDT'], ['binance/spot', 'binance:ETHUSDT:spot'], ['bybit/perp', 'bybit:ETHUSDT'], ['okx/perp', 'okx:ETH-USDT-SWAP'], ['coinbase/spot', null]]);
  assert.deepEqual(pickOptions(state(BTC), null, [], true).map(r => r.pick), ['binance/perp', 'bybit/perp', 'deribit/perp', 'okx/perp'], 'no spot, no MEXC (its open interest is not read)');
  assert.deepEqual(resolvePicks(state(BTC), null, ['binance/spot', 'mexc/perp', 'okx/perp'], true), ['okx:BTC-USDT-SWAP']);
});

test('custom open interest: the picked perpetuals whatever the chips and the filter say; chart is not a list', () => {
  const s = state(BTC, { disabledVenues: ['okx', 'binance'], scope: 'spot' as const, customMarkets: { footprint: [], oi: ['okx/perp', 'binance/perp'] } });
  const flow = { ids: [], get: () => undefined, track: () => undefined } as never;
  assert.deepEqual(oiMarketIds(s, flow), ['binance:BTCUSDT', 'okx:BTC-USDT-SWAP']);
  assert.deepEqual(oiMarketIds({ ...s, customMarkets: { footprint: [], oi: [] } }, flow), [], 'none picked: none, not every one');
  assert.equal(oiMarketIds({ ...s, oiMarkets: 'chart' as const }, flow), null);
});

test('All perpetuals counts the perpetuals whatever the Spot / Perp filter says (spot markets have no open interest); the chips still count', () => {
  const ids = BTC.map(m => m.instrumentId!);
  const flow = { ids, get: () => ({ empty: false }), track: () => undefined } as never;
  const all = (extra: object) => oiMarketIds(state(BTC, { oiMarkets: 'all' as const, ...extra }), flow);
  const both = all({});
  assert.deepEqual(both, ['binance:BTCUSDT', 'bybit:BTCUSDT', 'deribit:BTC-PERPETUAL', 'okx:BTC-USDT-SWAP'], 'no spot, no MEXC (its open interest is not read)');
  assert.deepEqual(all({ scope: 'spot' as const }), both, 'Spot: the same perpetuals, not none (the pane said it had no history)');
  assert.deepEqual(all({ scope: 'perp' as const }), both);
  assert.deepEqual(all({ scope: 'spot' as const, disabledVenues: ['okx'] }), ['binance:BTCUSDT', 'bybit:BTCUSDT', 'deribit:BTC-PERPETUAL'], 'a venue switched off stays out');
});

test('saved lists are checked: the right form only, each once, at most the limit; layouts and pages read them the same way', () => {
  assert.deepEqual(readPicks(['binance/perp', 'binance/perp', 'binance:BTCUSDT', 7, 'okx/spot', 'x/y'], false), ['binance/perp', 'okx/spot']);
  assert.deepEqual(readPicks(['binance/spot', 'mexc/perp', 'okx/perp'], true), ['okx/perp']);
  assert.equal(readPicks(Array.from({ length: 80 }, (_, i) => `v${i}/perp`), false).length, MAX_PICKS);
  assert.deepEqual(readCustomMarkets('junk'), { footprint: [], oi: [] });
  const saved = readSettings({ oiMarkets: 'custom', customMarkets: { footprint: ['bybit/spot'], oi: ['bybit/perp'] }, footprint: { markets: 'custom' } });
  assert.deepEqual([saved.oiMarkets, saved.footprint.markets, saved.customMarkets], ['custom', 'custom', { footprint: ['bybit/spot'], oi: ['bybit/perp'] }]);
  assert.equal(readSettings({ oiMarkets: 'everything' }).oiMarkets, 'all');
});
