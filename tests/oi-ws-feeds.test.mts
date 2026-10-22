import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBybitTicker, buildBybitSubscription, BYBIT_INVERSE_WS_URL, BYBIT_LINEAR_WS_URL } from '../src/adapters/bybit.mts';
import { normalizeOkxOpenInterest, buildOkxSubscription } from '../src/adapters/okx.mts';

const AT = 1_700_000_000_000;

test('a Bybit ticker snapshot is a one-sided native reading stamped with the exchange push time', () => {
  const sample = normalizeBybitTicker({ topic: 'tickers.BTCUSDT', type: 'snapshot', ts: AT, data: { symbol: 'BTCUSDT', openInterest: '200', singleOpenInterest: '100' } }, { symbol: 'BTCUSDT', receivedAt: AT + 500 });
  assert.deepEqual(sample, { kind: 'openInterest', instrumentId: 'bybit:BTCUSDT', sourceTimestamp: AT, receivedAt: AT + 500, base: 100, quality: 'native', units: 'base', inverse: false });
});

test('a Bybit ticker delta changes the reading only when it carries the open-interest fields, and never reads one as zero', () => {
  assert.deepEqual(normalizeBybitTicker({ topic: 'tickers.BTCUSDT', type: 'delta', ts: AT, data: { symbol: 'BTCUSDT', markPrice: '80000' } }, { symbol: 'BTCUSDT', receivedAt: AT }), null, 'no open interest in the delta: no reading');
  assert.deepEqual(normalizeBybitTicker({ topic: 'tickers.BTCUSDT', type: 'delta', ts: AT, data: { symbol: 'BTCUSDT', openInterest: '0', singleOpenInterest: '0' } }, { symbol: 'BTCUSDT', receivedAt: AT }), null, 'a zero reading is none');
  const half = normalizeBybitTicker({ topic: 'tickers.BTCUSDT', type: 'delta', ts: AT, data: { symbol: 'BTCUSDT', openInterest: '246' } }, { symbol: 'BTCUSDT', receivedAt: AT });
  assert.equal(half?.base, 123, 'half of the two-sided figure where the single one is absent');
});

test('a Bybit coin-margined ticker keeps its value in coins and its USD as the quote', () => {
  const metadata = { venue: 'bybit', instrumentId: 'bybit:BTCUSD', nativeSymbol: 'BTCUSD', symbol: 'BTCUSD', category: 'inverse', base: 'BTC', quote: 'USD', settleCoin: 'BTC', marketType: 'perpetual', tickSize: 0.5, qtyStep: 1, lotSize: 1, quantityUnit: 'quote', inverse: true, contractType: 'InversePerpetual', status: 'Trading', isDelisted: false };
  const sample = normalizeBybitTicker({ topic: 'tickers.BTCUSD', type: 'snapshot', ts: AT, data: { symbol: 'BTCUSD', openInterest: '1028908580', singleOpenInterest: '514454290', openInterestValue: '12504.7', singleOpenInterestValue: '6252.35', markPrice: '82281.8' } }, { symbol: 'BTCUSD', category: 'inverse', metadata, receivedAt: AT });
  assert.equal(sample?.instrumentId, 'bybit:BTCUSD');
  assert.equal(sample?.base, 6252.35); assert.equal(sample?.quote, 514454290);
  assert.equal(sample?.quality, 'native');
});

test('Bybit ticker messages are fenced by their topic, symbol and market', () => {
  assert.throws(() => normalizeBybitTicker({ topic: 'tickers.ETHUSDT', type: 'snapshot', ts: AT, data: { symbol: 'ETHUSDT', singleOpenInterest: '1' } }, { symbol: 'BTCUSDT' }), /topic/);
  assert.throws(() => normalizeBybitTicker({ topic: 'tickers.BTCUSDT', type: 'snapshot', ts: AT, data: { symbol: 'ETHUSDT', singleOpenInterest: '1' } }, { symbol: 'BTCUSDT' }), /mismatch/);
  assert.throws(() => normalizeBybitTicker({ topic: 'tickers.BTCUSDT', type: 'snapshot', ts: AT, data: { symbol: 'BTCUSDT', singleOpenInterest: '1' } }, { symbol: 'BTCUSDT', category: 'spot' }), /spot/);
  assert.deepEqual(normalizeBybitTicker({ op: 'subscribe', success: true, retCode: 0 }, { symbol: 'BTCUSDT', receivedAt: AT }), null, 'an acknowledgement is no reading');
  assert.throws(() => normalizeBybitTicker({ topic: 'tickers.BTCUSDT', type: 'snapshot', ts: AT, data: { symbol: 'BTCUSDT', singleOpenInterest: 'nope' } }, { symbol: 'BTCUSDT', receivedAt: AT }), /openInterest/, 'an unreadable field fails the frame');
});

test('the Bybit ticker subscription names its topic on the family address', () => {
  assert.deepEqual(buildBybitSubscription('ticker', { symbol: 'BTCUSDT', category: 'linear' }), { url: BYBIT_LINEAR_WS_URL, method: 'subscribe', args: ['tickers.BTCUSDT'], topic: 'tickers.BTCUSDT' });
  assert.deepEqual(buildBybitSubscription('ticker', { symbol: 'BTCUSD', category: 'inverse' }), { url: BYBIT_INVERSE_WS_URL, method: 'subscribe', args: ['tickers.BTCUSD'], topic: 'tickers.BTCUSD' });
});

test('an OKX open-interest push is the swap reading in coins, stamped with the exchange time', () => {
  const sample = normalizeOkxOpenInterest({ arg: { channel: 'open-interest', instId: 'BTC-USDT-SWAP' }, data: [{ instId: 'BTC-USDT-SWAP', instType: 'SWAP', oi: '2990937', oiCcy: '29909.37', oiUsd: '2477295037', ts: String(AT) }] }, { instId: 'BTC-USDT-SWAP', receivedAt: AT + 500 });
  assert.deepEqual(sample, { kind: 'openInterest', instrumentId: 'okx:BTC-USDT-SWAP', sourceTimestamp: AT, receivedAt: AT + 500, base: 29909.37, quality: 'native' });
});

test('OKX open-interest frames are fenced by channel and instrument, and spot has none', () => {
  assert.throws(() => normalizeOkxOpenInterest({ arg: { channel: 'tickers', instId: 'BTC-USDT-SWAP' }, data: [{ oiCcy: '1', ts: String(AT) }] }, { instId: 'BTC-USDT-SWAP' }), /channel/);
  assert.throws(() => normalizeOkxOpenInterest({ arg: { channel: 'open-interest', instId: 'ETH-USDT-SWAP' }, data: [{ oiCcy: '1', ts: String(AT) }] }, { instId: 'BTC-USDT-SWAP' }), /instrument/);
  assert.throws(() => normalizeOkxOpenInterest({ arg: { channel: 'open-interest', instId: 'BTC-USDT-SWAP' }, data: [{ instId: 'BTC-USDT-SWAP', oiCcy: '', ts: String(AT) }] }, { instId: 'BTC-USDT-SWAP' }), /oiCcy/);
  assert.deepEqual(buildOkxSubscription('open-interest', { instId: 'BTC-USDT-SWAP', marketType: 'perpetual' }), { url: 'wss://ws.okx.com:8443/ws/v5/public', method: 'subscribe', args: [{ channel: 'open-interest', instId: 'BTC-USDT-SWAP' }], topic: 'open-interest:BTC-USDT-SWAP', channel: 'open-interest', instId: 'BTC-USDT-SWAP' });
  assert.throws(() => buildOkxSubscription('open-interest', { instId: 'BTC-USDT', marketType: 'spot' }), /spot/);
});
