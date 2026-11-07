import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBybitTicker, buildBybitSubscription, BYBIT_INVERSE_WS_URL, BYBIT_LINEAR_WS_URL, type BybitTickerHeld } from '../src/adapters/bybit.mts';
import { normalizeOkxOpenInterest, buildOkxSubscription } from '../src/adapters/okx.mts';
import { BybitConnector, OkxConnector } from '../src/shared/venues.ts';
import type { OiEvent } from '../src/shared/connector.ts';

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
  assert.deepEqual(buildOkxSubscription('open-interest', { instId: 'BTC-USDT-SWAP', marketType: 'perpetual' }), { url: 'wss://ws.okx.com/ws/v5/public', method: 'subscribe', args: [{ channel: 'open-interest', instId: 'BTC-USDT-SWAP' }], topic: 'open-interest:BTC-USDT-SWAP', channel: 'open-interest', instId: 'BTC-USDT-SWAP' });
  assert.throws(() => buildOkxSubscription('open-interest', { instId: 'BTC-USDT', marketType: 'spot' }), /spot/);
});

test("an OKX open-interest row of another market in this market's frame is refused, never read as this one's", () => {
  assert.throws(() => normalizeOkxOpenInterest({ arg: { channel: 'open-interest', instId: 'BTC-USDT-SWAP' }, data: [{ instId: 'ETH-USDT-SWAP', oiCcy: '1', ts: String(AT) }] }, { instId: 'BTC-USDT-SWAP' }), /instrument/);
  assert.equal(normalizeOkxOpenInterest({ arg: { channel: 'open-interest', instId: 'BTC-USDT-SWAP' }, data: [{ instId: 'BTC-USDT-SWAP', oiCcy: '5', ts: '-1' }] }, { instId: 'BTC-USDT-SWAP', receivedAt: AT }).sourceTimestamp, AT, 'a time that is no time keeps the receipt');
});

test('a Bybit coin-margined delta that carries open interest without its value is read with the value it left unchanged', () => {
  const held: BybitTickerHeld = { openInterest: null, openInterestValue: null }, opts = { symbol: 'BTCUSD', category: 'inverse' as const, metadata: { venue: 'bybit', instrumentId: 'bybit:BTCUSD', nativeSymbol: 'BTCUSD', symbol: 'BTCUSD', category: 'inverse', base: 'BTC', quote: 'USD', settleCoin: 'BTC', marketType: 'perpetual', tickSize: 0.5, qtyStep: 1, lotSize: 1, quantityUnit: 'quote', inverse: true, contractType: 'InversePerpetual', status: 'Trading', isDelisted: false } };
  const frame = (type: string, data: Record<string, string>, ts = AT) => normalizeBybitTicker({ topic: 'tickers.BTCUSD', type, ts, data: { symbol: 'BTCUSD', ...data } }, { ...opts, receivedAt: ts }, held);
  const first = frame('snapshot', { singleOpenInterest: '500000000', singleOpenInterestValue: '6000' });
  assert.deepEqual([first?.base, first?.quote], [6000, 500_000_000]);
  assert.equal(frame('delta', { singleOpenInterestValue: '6100' }, AT + 100), null, 'the mark alone moved: no reading');
  const opened = frame('delta', { singleOpenInterest: '510000000' }, AT + 200);
  assert.deepEqual([opened?.base, opened?.quote], [6100, 510_000_000], 'the USD changed; its coins are the value last heard');
  assert.equal(frame('snapshot', { singleOpenInterest: '520000000' }, AT + 300), null, 'a snapshot starts afresh: no value heard since, no reading');
});

/** The readings a browser connector reports for the frames it is given. */
function readings(connector: BybitConnector | OkxConnector, frames: unknown[]): OiEvent[] {
  const out: OiEvent[] = []; connector.onOi = event => out.push(event);
  for (const frame of frames) connector.onMessage(JSON.stringify(frame));
  return out;
}

test("a page's Bybit ticker reading is one side, its own market's only, and never a value that is not a finite number", () => {
  const ticker = (data: Record<string, string>, ts: unknown = AT) => ({ topic: 'tickers.BTCUSDT', type: 'delta', ts, data: { symbol: 'BTCUSDT', ...data } });
  assert.deepEqual(readings(new BybitConnector(), [ticker({ singleOpenInterest: '100' }), ticker({ openInterest: '300' }, AT + 1), ticker({ markPrice: '80000' }, AT + 2)]).map(r => [r.instrumentId, r.t, r.base]),
    [['bybit:BTCUSDT', AT, 100], ['bybit:BTCUSDT', AT + 1, 150]]);
  assert.deepEqual(readings(new BybitConnector(), [ticker({ singleOpenInterest: 'Infinity' }), ticker({ singleOpenInterest: '1e400' }), ticker({ singleOpenInterest: '100' }, 'soon'), { topic: 'tickers.BTCUSDT', ts: AT, data: { symbol: 'ETHUSDT', singleOpenInterest: '5' } }]), [], 'no reading from an infinite value, a time that is none or another market');
});

test("a page's OKX open interest is its own swap's only", () => {
  const frame = (arg: string, row: string, oiCcy = '29909.37', ts = String(AT)) => ({ arg: { channel: 'open-interest', instId: arg }, data: [{ instId: row, oiCcy, ts }] });
  assert.deepEqual(readings(new OkxConnector(), [frame('BTC-USDT-SWAP', 'BTC-USDT-SWAP')]).map(r => [r.instrumentId, r.t, r.base]), [['okx:BTC-USDT-SWAP', AT, 29909.37]]);
  assert.deepEqual(readings(new OkxConnector(), [frame('ETH-USDT-SWAP', 'ETH-USDT-SWAP'), frame('BTC-USDT-SWAP', 'ETH-USDT-SWAP'), frame('BTC-USDT-SWAP', 'BTC-USDT-SWAP', 'Infinity')]), [], "another market's frame or row, or an infinite value, is no reading");
});
