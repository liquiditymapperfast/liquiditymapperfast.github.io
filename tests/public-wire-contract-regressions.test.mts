import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager, liveFeedMessageLimitBytes, MAX_LIVE_FEED_MESSAGE_BYTES, MAX_COINBASE_L2_MESSAGE_BYTES } from '../src/server/live-feeds.mts';
import type { LiveFeedEvent, LiveFeedSocket, LiveFeedStartOptions, LiveFeedTransportOptions } from '../src/server/live-feeds.mts';
import { ProcessMemoryMonitor } from '../src/server/process-memory.mts';
import { buildCoinbaseSubscription } from '../src/adapters/coinbase.mts';
import { buildGateRequest, normalizeGateContractInfo } from '../src/adapters/gateio.mts';
import { buildMexcSubscription, normalizeMexcContractInfo, normalizeMexcDepth } from '../src/adapters/mexc.mts';
import { normalizeCryptocomInstrument } from '../src/adapters/cryptocom.mts';
import { normalizeKrakenAssetPairs, normalizeKrakenDepth, parseKrakenBookJson } from '../src/adapters/kraken.mts';
import { KRAKEN_V2_PUBLIC_SNAPSHOT } from './fixtures/kraken-v2-public-2026-10-01.mts';
import { defined, fields } from './server-test-helpers.mts';

class Socket implements LiveFeedSocket {
  onMessage?: (raw: unknown) => void; onClose?: (reason: unknown) => void; onError?: (reason: unknown) => void;
  closed = false; sent: string[] = [];
  constructor(readonly spec: LiveFeedTransportOptions) {}
  async open() {}
  send(raw: string) { this.sent.push(raw); }
  close() { this.closed = true; }
  emit(raw: unknown) { this.onMessage?.(raw); }
}
const largeCoinbaseSnapshot = () => JSON.stringify({ type: 'snapshot', product_id: 'BTC-USD', bids: [['100', '2']], asks: [['101', '3']], publicPadding: 'x'.repeat(MAX_LIVE_FEED_MESSAGE_BYTES) });
const coinbaseAck = { type: 'subscriptions', channels: [{ name: 'level2_batch', product_ids: ['BTC-USD'] }] };

test('selected Gate metadata uses the documented single-contract object endpoint', () => {
  assert.equal(buildGateRequest('contracts', { contract: 'BTC_USDT' }).url, 'https://api.gateio.ws/api/v4/futures/usdt/contracts/BTC_USDT');
  const metadata = normalizeGateContractInfo({ name: 'BTC_USDT', status: 'trading', type: 'direct', order_price_round: '0.1', quanto_multiplier: '0.0001', order_size_min: '1' });
  assert.equal(metadata.assets.length, 1); assert.equal(metadata.assets[0].contractValue, 0.0001);
  assert.throws(() => normalizeGateContractInfo({}), /array or one contract object/);
});

test('MEXC selected contract object and actual full channel retain native contract value', () => {
  const row = { symbol: 'BTC_USDT', state: 0, baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', contractSize: 0.0001, priceUnit: 0.1, volUnit: 1 };
  const metadata = normalizeMexcContractInfo({ success: true, code: 0, data: row }, { symbol: 'BTC_USDT' });
  assert.equal(metadata.assets.length, 1); assert.equal(metadata.assets[0].contractValue, 0.0001);
  assert.throws(() => normalizeMexcContractInfo({ success: true, code: 0, data: { ...row, symbol: 'ETH_USDT' } }, { symbol: 'BTC_USDT' }), /symbol mismatch/);
  assert.throws(() => normalizeMexcContractInfo({ success: true, code: 0, data: {} }), /array or one contract object/);
  assert.equal(buildMexcSubscription('depth').channel, 'push.depth.full');
  const frame = { channel: 'push.depth.full', symbol: 'BTC_USDT', ts: 1_790_897_063_918, data: { version: 42_283_948_720, bids: [[100, 2, 1]], asks: [[101, 3, 1]] } };
  const book = normalizeMexcDepth(frame, { symbol: 'BTC_USDT', snapshot: true, contractValue: metadata.assets[0].contractValue });
  assert.equal(book.kind, 'depthSnapshot'); assert.equal(book.units, 'contract'); assert.equal(book.contractValue, 0.0001);
  assert.throws(() => normalizeMexcDepth({ ...frame, channel: 'push.depth' }, { symbol: 'BTC_USDT', snapshot: true }), /channel unsupported/);
});

test('Crypto.com ignores unrelated malformed catalog symbols and requires an explicit selected symbol', () => {
  const selected = { symbol: 'BTCUSD-PERP', inst_type: 'PERPETUAL_SWAP', base_ccy: 'BTC', quote_ccy: 'USD', price_tick_size: '0.1', qty_tick_size: '0.0001', tradable: true };
  const metadata = normalizeCryptocomInstrument({ code: 0, result: { data: [{ symbol: '股票/foreign', price_tick_size: null }, selected, { inst_type: 'PERPETUAL_SWAP', tradable: true }] } });
  assert.equal(metadata.assets.length, 1); assert.equal(metadata.assets[0].nativeSymbol, 'BTCUSD-PERP');
  assert.throws(() => normalizeCryptocomInstrument({ code: 0, result: { data: [{ ...selected, price_tick_size: '-1' }] } }), /must be positive/);
  assert.equal(normalizeCryptocomInstrument({ code: 0, result: { data: [{ ...selected, symbol: 'ETHUSD-PERP' }] } }).assets.length, 0);
});

test('Kraken v2 REST naming is explicit and captured numeric decimals retain the actual CRC32', () => {
  const payload = { error: [], result: { XXBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', pair_decimals: 1, lot_decimals: 8, status: 'online' } } };
  const legacy = normalizeKrakenAssetPairs(payload); assert.equal(legacy.assets[0].nativeSymbol, 'XBT/USD');
  const v2 = normalizeKrakenAssetPairs(payload, { websocketVersion: 2 });
  assert.equal(v2.assets[0].nativeSymbol, 'BTC/USD'); assert.equal(v2.assets[0].base, 'BTC'); assert.equal(v2.assets[0].quote, 'USD');
  assert.equal(v2.assets[0].restNativeSymbol, 'XBT/USD');
  const parsed = parseKrakenBookJson(KRAKEN_V2_PUBLIC_SNAPSHOT);
  const book = normalizeKrakenDepth(parsed, { symbol: 'BTC/USD', receivedAt: 1 });
  assert.equal(book.checksum, 1_202_034_029); assert.equal(book.bids.length, 100); assert.equal(book.asks.length, 100);
  assert.equal(book.sourceTimestamp, Date.parse('2026-10-01T23:24:27.002886Z'));
  assert.throws(() => normalizeKrakenDepth(JSON.parse(KRAKEN_V2_PUBLIC_SNAPSHOT), { symbol: 'BTC/USD' }), /checksum mismatch|Invalid Kraken/);
  const malformed = fields(parsed); const first = fields((fields(malformed).data as unknown[])[0]); first.timestamp = 'broken';
  assert.throws(() => normalizeKrakenDepth(malformed, { symbol: 'BTC/USD' }), /timestamp missing or invalid/);
});

test('Coinbase profile alone receives the explicit 2MiB frame bound', () => {
  const request = buildCoinbaseSubscription('depth', { productId: 'BTC-USD', channel: 'level2_batch' });
  const selected = { venue: 'coinbase', marketType: 'spot', channel: 'level2_batch', request };
  assert.equal(liveFeedMessageLimitBytes(selected), MAX_COINBASE_L2_MESSAGE_BYTES);
  for (const other of [{ ...selected, venue: 'kraken' }, { ...selected, channel: 'level2' }, { ...selected, request: { ...request, url: 'wss://unverified.invalid' } }]) {
    assert.equal(liveFeedMessageLimitBytes(other), MAX_LIVE_FEED_MESSAGE_BYTES);
  }
});
