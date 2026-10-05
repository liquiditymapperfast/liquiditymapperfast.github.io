import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anchorProduct, loadFeedSelection, restoreFeedSelection, saveFeedSelection } from '../src/server/feed-selection-store.mts';
import { PUBLIC_ORDERBOOK_VENUE_IDS } from '../src/server/public-orderbook-selection.mts';

function tempFile(): { file: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-feedsel-'));
  return { file: path.join(dir, 'v2-feed-venues.json'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const markets = [{ instrumentId: 'binance:BTCUSDT:spot', quote: 'USDT', marketType: 'spot' }, { instrumentId: 'bitmex:XBTUSD', quote: 'USD', marketType: 'perpetual' }, { instrumentId: 'binance:BTCUSDT', quote: 'USDT', marketType: 'perpetual' }];
const instant = async () => {};

test('a saved selection round-trips and unknown or duplicate venues are dropped', () => {
  const { file, done } = tempFile();
  try {
    assert.equal(loadFeedSelection(file), null, 'no file yet');
    saveFeedSelection(file, { instrumentId: 'binance:BTCUSDT', venues: ['binance', 'bybit', 'bybit', 'not-a-venue', 'okx'] });
    assert.deepEqual(loadFeedSelection(file), { instrumentId: 'binance:BTCUSDT', venues: ['binance', 'bybit', 'okx'] });
    fs.writeFileSync(file, '{"instrumentId":"x"');
    assert.equal(loadFeedSelection(file), null, 'a corrupt file is ignored');
    fs.writeFileSync(file, JSON.stringify({ instrumentId: 'binance:BTCUSDT', venues: ['nope'] }));
    assert.equal(loadFeedSelection(file), null, 'a selection with no known venue is ignored');
    assert.equal(loadFeedSelection(null), null);
    assert.doesNotThrow(() => saveFeedSelection(null, { instrumentId: 'a', venues: ['binance'] }));
  } finally { done(); }
});

test('the anchor product is a stable-quoted perpetual when one exists', () => {
  assert.equal(anchorProduct(markets), 'binance:BTCUSDT');
  assert.equal(anchorProduct(markets.slice(0, 1)), 'binance:BTCUSDT:spot');
  assert.equal(anchorProduct([{ instrumentId: 'bitmex:XBTUSD', quote: 'USD' }]), null);
  assert.equal(anchorProduct([]), null);
});

test('restart restores the saved venues on the saved product, retrying while metadata loads', async () => {
  const { file, done } = tempFile();
  try {
    saveFeedSelection(file, { instrumentId: 'okx:BTC-USDT-SWAP', venues: ['okx', 'kraken', 'dydx'] });
    const calls: [string, string[]][] = []; let failures = 2;
    const outcome = await restoreFeedSelection({ file, markets: () => [], defaultVenues: ['hyperliquid'], sleep: instant,
      select: async (product, venues) => { if (failures-- > 0) throw new Error('unavailable metadata'); calls.push([product, venues]); } });
    assert.equal(outcome, 'restored');
    assert.deepEqual(calls, [['okx:BTC-USDT-SWAP', ['okx', 'kraken', 'dydx']]]);
  } finally { done(); }
});

test('with nothing saved every supported venue is selected on the anchor product', async () => {
  const { file, done } = tempFile();
  try {
    const calls: [string, string[]][] = []; let known = false;
    const outcome = await restoreFeedSelection({ file, markets: () => known ? markets : [], defaultVenues: [...PUBLIC_ORDERBOOK_VENUE_IDS], sleep: async () => { known = true; },
      select: async (product, venues) => { calls.push([product, venues]); } });
    assert.equal(outcome, 'defaulted');
    assert.deepEqual(calls, [['binance:BTCUSDT', [...PUBLIC_ORDERBOOK_VENUE_IDS]]], 'waits for a market to exist, then selects them all');
    assert.ok(calls[0]![1].length >= 20);
  } finally { done(); }
});

test('null defaults leave the configured venues alone, and a permanent failure gives up without throwing', async () => {
  const { file, done } = tempFile();
  try {
    let called = false;
    assert.equal(await restoreFeedSelection({ file, markets: () => markets, defaultVenues: null, sleep: instant, select: async () => { called = true; } }), 'skipped');
    assert.equal(called, false);
    const logs: string[] = [];
    const outcome = await restoreFeedSelection({ file, markets: () => markets, defaultVenues: ['binance'], attempts: 3, sleep: instant, log: m => logs.push(m),
      select: async () => { throw new Error('metadata never arrives'); } });
    assert.equal(outcome, 'gave-up');
    assert.match(logs[0] ?? '', /metadata never arrives/);
  } finally { done(); }
});
