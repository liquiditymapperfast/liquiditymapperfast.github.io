import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterTransportError, type AdapterOptions, type WireRecord } from '../src/adapters/common.mts';
import { OkxConnector, buildOkxRequest, buildOkxSubscription, normalizeOkxDepth, normalizeOkxInstrumentInfo, okxInstrumentId } from '../src/adapters/okx.mts';
import { BitgetConnector, bitgetInstrumentId, buildBitgetRequest, buildBitgetSubscription, normalizeBitgetDepth, normalizeBitgetRestDepth, normalizeBitgetInstrumentInfo } from '../src/adapters/bitget.mts';
import { usdBookLevels } from '../src/core/book-valuation.mts';

const NOW = 1_700_000_000_100;
const OKX_OPTIONS = { instId: 'BTC-USDT', instType: 'SPOT', marketType: 'spot', receivedAt: NOW + 1 };
const BITGET_OPTIONS = { symbol: 'BTCUSDT', instType: 'spot', category: 'spot', marketType: 'spot', receivedAt: NOW + 1 };
const okxRow = { instId: 'BTC-USDT', instType: 'SPOT', state: 'live', baseCcy: 'BTC', quoteCcy: 'USDT', tickSz: '0.01', lotSz: '0.00001', minSz: '0.0001' };
const bitgetRow = { symbol: 'BTCUSDT', category: 'SPOT', status: 'online', baseCoin: 'BTC', quoteCoin: 'USDT', pricePrecision: '2', quantityPrecision: '5', quotePrecision: '2', minOrderQty: '0.0001', minOrderAmount: '5' };
function okxMetadata(overrides: WireRecord = {}) { return normalizeOkxInstrumentInfo({ code: '0', data: [{ ...okxRow, ...overrides }] }, OKX_OPTIONS).assets[0]; }
function bitgetMetadata(overrides: WireRecord = {}) { return normalizeBitgetInstrumentInfo({ code: '00000', requestTime: NOW, data: [{ ...bitgetRow, ...overrides }] }, BITGET_OPTIONS).assets[0]; }
function okxWire(action = 'snapshot', changes: WireRecord = {}) { return { action, arg: { channel: 'books', instId: 'BTC-USDT' }, data: [{ asks: [['101', '0.5']], bids: [['100', '0.25']], ts: String(NOW), seqId: '10', ...changes }] }; }
function bitgetWire(action = 'snapshot', changes: WireRecord = {}) { return { action, arg: { instType: 'spot', topic: 'books', symbol: 'BTCUSDT' }, data: [{ asks: [['101', '0.5']], bids: [['100', '0.25']], ts: String(NOW), seq: '9007199254740993', ...changes }] }; }

test('spot descriptors select only the public instrument family and books endpoints', () => {
  assert.equal(buildOkxRequest('instruments', OKX_OPTIONS).url, 'https://www.okx.com/api/v5/public/instruments?instType=SPOT&instId=BTC-USDT');
  assert.equal(buildOkxRequest('depth', { ...OKX_OPTIONS, size: 400 }).url, 'https://www.okx.com/api/v5/market/books?instId=BTC-USDT&sz=400');
  assert.deepEqual(buildOkxSubscription('depth', OKX_OPTIONS).args, [{ channel: 'books', instId: 'BTC-USDT' }]);
  assert.equal(buildBitgetRequest('instruments', BITGET_OPTIONS).url, 'https://api.bitget.com/api/v3/market/instruments?category=SPOT&symbol=BTCUSDT');
  assert.equal(buildBitgetRequest('depth', BITGET_OPTIONS).url, 'https://api.bitget.com/api/v3/market/orderbook?category=SPOT&symbol=BTCUSDT&limit=200');
  assert.deepEqual(buildBitgetSubscription('depth', BITGET_OPTIONS).args, [{ instType: 'spot', topic: 'books', symbol: 'BTCUSDT' }]);
  assert.throws(() => buildOkxSubscription('depth', { ...OKX_OPTIONS, instId: 'BTC-USDT-SWAP' }), /family mismatch/);
  assert.throws(() => buildOkxRequest('instruments', { ...OKX_OPTIONS, instType: 'SWAP' }), /Inconsistent/);
  assert.throws(() => buildBitgetSubscription('depth', { ...BITGET_OPTIONS, category: 'usdt-futures' }), /mismatch/);
  assert.throws(() => buildBitgetRequest('instruments', { ...BITGET_OPTIONS, instType: 'usdt-futures', category: 'usdt-futures' }), /mismatch/);
});

test('spot identity is distinct from the same native Bitget futures symbol', () => {
  assert.equal(bitgetInstrumentId('btcusdt'), 'bitget:BTCUSDT');
  assert.equal(bitgetInstrumentId('btcusdt', 'SPOT'), 'bitget:BTCUSDT:spot');
  assert.equal(bitgetInstrumentId('btcusdt', 'USDT_FUTURES'), 'bitget:BTCUSDT');
  assert.equal(okxInstrumentId('btc-usdt'), 'okx:BTC-USDT');
  assert.notEqual(okxInstrumentId('BTC-USDT'), okxInstrumentId('BTC-USDT-SWAP'));
});

test('OKX spot metadata verifies active currency identity and keeps base tick/lot/minimum', () => {
  const metadata = okxMetadata({ ctVal: '100' });
  assert.equal(metadata.instrumentId, 'okx:BTC-USDT'); assert.equal(metadata.nativeSymbol, 'BTC-USDT');
  assert.equal(metadata.quantityUnit, 'base'); assert.equal(metadata.marketType, 'spot');
  assert.equal(metadata.base, 'BTC'); assert.equal(metadata.quote, 'USDT');
  assert.equal(metadata.tickSize, 0.01); assert.equal(metadata.lotSize, 0.00001); assert.equal(metadata.qtyStep, 0.00001);
  assert.equal(metadata.minOrderSize, 0.0001); assert.equal(metadata.contractValue, undefined);
  assert.equal(metadata.status, 'live'); assert.equal(metadata.isDelisted, false); assert.equal(metadata.instType, 'SPOT');
  const filtered = normalizeOkxInstrumentInfo({ code: '0', data: [okxRow, { ...okxRow, instId: 'ETH-USDT', baseCcy: 'ETH' }, { ...okxRow, state: 'suspend' }, { ...okxRow, instType: 'SWAP', instId: 'BTC-USDT-SWAP' }] }, OKX_OPTIONS);
  assert.equal(filtered.assets.length, 1);
  assert.throws(() => okxMetadata({ baseCcy: '' }), /Invalid exchange symbol/);
  assert.throws(() => okxMetadata({ quoteCcy: 'USDC' }), /currency identity/);
  for (const field of ['tickSz', 'lotSz']) for (const value of [0, -1, '', null, true, 'Infinity']) assert.throws(() => okxMetadata({ [field]: value }), /missing|positive|finite/);
});

test('Bitget spot decimal precision defines increments independently of minimums and futures multipliers', () => {
  const metadata = bitgetMetadata({ priceMultiplier: '9', quantityMultiplier: '8' });
  assert.equal(metadata.instrumentId, 'bitget:BTCUSDT:spot'); assert.equal(metadata.marketType, 'spot');
  assert.equal(metadata.quantityUnit, 'base'); assert.equal(metadata.tickSize, 0.01); assert.equal(metadata.qtyStep, 0.00001); assert.equal(metadata.lotSize, 0.00001);
  assert.equal(metadata.minOrderQty, 0.0001); assert.equal(metadata.minOrderAmount, 5); assert.equal(metadata.quantityMultiplier, undefined);
  assert.equal(metadata.category, 'SPOT'); assert.equal(metadata.instType, 'spot'); assert.equal(metadata.status, 'online'); assert.equal(metadata.isDelisted, false);
  const filtered = normalizeBitgetInstrumentInfo({ code: '00000', data: [bitgetRow, { ...bitgetRow, symbol: 'ETHUSDT', baseCoin: 'ETH' }, { ...bitgetRow, status: 'offline' }, { ...bitgetRow, category: 'USDT-FUTURES' }, { ...bitgetRow, category: undefined }, { ...bitgetRow, status: undefined }] }, BITGET_OPTIONS);
  assert.equal(filtered.assets.length, 1);
  for (const field of ['pricePrecision', 'quantityPrecision']) for (const value of [undefined, null, '', true, -1, 1.5, '19', 'Infinity']) assert.throws(() => bitgetMetadata({ [field]: value }), /precision|Precision/);
  assert.throws(() => bitgetMetadata({ baseCoin: '' }), /Invalid exchange symbol/);
  assert.throws(() => bitgetMetadata({ quoteCoin: 'USDC' }), /currency identity/);
});

test('verified spot snapshots value the wire amount as base size without a contract multiplier', () => {
  const okx = normalizeOkxDepth(okxWire(), { ...OKX_OPTIONS, metadata: okxMetadata() });
  const bitget = normalizeBitgetDepth(bitgetWire(), { ...BITGET_OPTIONS, metadata: bitgetMetadata() });
  for (const book of [okx, bitget]) {
    assert.equal(book.units, 'base'); assert.equal(book.market.quantityUnit, 'base'); assert.equal(book.market.tickSize, 0.01);
    assert.equal(book.market.base, 'BTC'); assert.equal(book.market.quote, 'USDT'); assert.equal(book.market.contractValue ?? null, null);
    const levels = usdBookLevels(book); assert.equal(levels.length, 2);
    const bid = levels.find(row => row.side === 'bid'); assert.ok(bid);
    assert.equal(bid.baseAmount, 0.25); assert.equal(bid.notionalUsd, 25); assert.equal(bid.contractAmount, undefined);
    assert.equal(bid.valuation.units, 'base'); assert.equal(bid.valuation.contractType, null);
  }
});

test('spot depth fails closed before verified matching metadata is available', () => {
  assert.throws(() => normalizeOkxDepth(okxWire(), OKX_OPTIONS), /verified active instrument metadata/);
  assert.throws(() => normalizeBitgetDepth(bitgetWire(), BITGET_OPTIONS), /verified active instrument metadata/);
  assert.throws(() => normalizeOkxDepth(okxWire(), { ...OKX_OPTIONS, metadata: okxMetadata(), contractValue: 1 }), /cannot use a contract value/);
  assert.throws(() => normalizeBitgetDepth(bitgetWire(), { ...BITGET_OPTIONS, metadata: bitgetMetadata(), contractValue: 1 }), /cannot use a contract value/);
});

test('spot depth rejects stale-family, foreign, inactive or malformed selected metadata', () => {
  const cases: WireRecord[] = [{ venue: 'other' }, { nativeSymbol: 'ETHUSDT' }, { instrumentId: 'wrong' }, { marketType: 'perpetual' }, { quantityUnit: 'contract' }, { isDelisted: true }, { status: 'offline' }, { base: 'ETH' }, { quote: 'USDC' }, { tickSize: 0 }, { lotSize: 0 }];
  for (const change of cases) {
    assert.throws(() => normalizeOkxDepth(okxWire(), { ...OKX_OPTIONS, metadata: { ...okxMetadata(), ...change } }), /metadata|tickSize|lotSize/);
    assert.throws(() => normalizeBitgetDepth(bitgetWire(), { ...BITGET_OPTIONS, metadata: { ...bitgetMetadata(), ...change } }), /metadata|tickSize|lotSize/);
  }
  assert.throws(() => normalizeBitgetDepth(bitgetWire(), { ...BITGET_OPTIONS, metadata: { ...bitgetMetadata(), category: 'USDT-FUTURES' } }), /verified active/);
});

test('spot updates preserve predecessor tokens and zero-quantity deletion', () => {
  const okx = normalizeOkxDepth(okxWire('update', { asks: [['101', '0']], bids: [], seqId: '11', prevSeqId: '10' }), { ...OKX_OPTIONS, metadata: okxMetadata() });
  const bitget = normalizeBitgetDepth(bitgetWire('update', { asks: [['101', '0']], bids: [], seq: '9007199254740994', pseq: '9007199254740993' }), { ...BITGET_OPTIONS, metadata: bitgetMetadata() });
  assert.ok(okx.kind === 'depthDelta'); assert.equal(okx.previousSequence, 10); assert.deepEqual(okx.asks, [{ price: 101, amount: 0 }]);
  assert.ok(bitget.kind === 'depthDelta'); assert.equal(bitget.previousSequence, '9007199254740993'); assert.deepEqual(bitget.asks, [{ price: 101, amount: 0 }]);
  assert.throws(() => normalizeOkxDepth(okxWire('snapshot', { seqId: Number.MAX_SAFE_INTEGER + 2 }), { ...OKX_OPTIONS, metadata: okxMetadata() }), /unsafe numeric/);
  assert.throws(() => normalizeBitgetDepth(bitgetWire('snapshot', { seq: Number.MAX_SAFE_INTEGER + 2 }), { ...BITGET_OPTIONS, metadata: bitgetMetadata() }), /unsafe numeric/);
});

test('explicit spot subscriptions reject mismatched wire instrument or family', () => {
  assert.throws(() => normalizeOkxDepth({ ...okxWire(), arg: { instId: 'ETH-USDT' } }, { ...OKX_OPTIONS, metadata: okxMetadata() }), /instrument mismatch/);
  assert.throws(() => normalizeBitgetDepth({ ...bitgetWire(), arg: { instType: 'usdt-futures', symbol: 'BTCUSDT' } }, { ...BITGET_OPTIONS, metadata: bitgetMetadata() }), /family mismatch/);
  assert.throws(() => normalizeBitgetDepth({ ...bitgetWire(), arg: { instType: 'spot', symbol: 'ETHUSDT' } }, { ...BITGET_OPTIONS, metadata: bitgetMetadata() }), /instrument mismatch/);
  assert.throws(() => normalizeOkxDepth(okxWire('snapshot', { instId: 'ETH-USDT' }), { ...OKX_OPTIONS, metadata: okxMetadata() }), /instrument mismatch/);
  assert.throws(() => normalizeBitgetDepth(bitgetWire('snapshot', { symbol: 'ETHUSDT' }), { ...BITGET_OPTIONS, metadata: bitgetMetadata() }), /instrument mismatch/);
});

test('Bitget spot REST snapshots retain base metadata without claiming a sequence bridge', () => {
  const book = normalizeBitgetRestDepth({ code: '00000', requestTime: NOW, data: { asks: [['101', '0.5']], bids: [['100', '0.25']], ts: String(NOW) } }, { ...BITGET_OPTIONS, metadata: bitgetMetadata() });
  assert.equal(book.instrumentId, 'bitget:BTCUSDT:spot'); assert.equal(book.units, 'base'); assert.equal(book.continuity, 'rest-snapshot');
  assert.equal(Object.hasOwn(book, 'sequence'), false); assert.equal(usdBookLevels(book)[0].notionalUsd, 25);
  assert.throws(() => normalizeBitgetRestDepth({ data: { asks: [], bids: [] } }, BITGET_OPTIONS), /verified active/);
  assert.throws(() => normalizeBitgetRestDepth({ data: { symbol: 'ETHUSDT', asks: [], bids: [] } }, { ...BITGET_OPTIONS, metadata: bitgetMetadata() }), /instrument mismatch/);
});

test('spot non-stable quotes remain unvalued until an explicit USD conversion is supplied', () => {
  const options = { ...OKX_OPTIONS, instId: 'BTC-EUR' };
  const metadata = normalizeOkxInstrumentInfo({ data: [{ ...okxRow, instId: 'BTC-EUR', quoteCcy: 'EUR' }] }, options).assets[0];
  const book = normalizeOkxDepth({ action: 'snapshot', arg: { instId: 'BTC-EUR' }, data: [{ asks: [], bids: [['100', '0.25']], seqId: '1' }] }, { ...options, metadata });
  assert.equal(usdBookLevels(book).length, 0);
  assert.equal(usdBookLevels(book, { quoteToUsd: 1.1 })[0].notionalUsd, 27.500000000000004);
});

test('public spot connectors perform no transport calls without explicit opt-in', async () => {
  let requests = 0; let subscriptions = 0;
  const transport = { request: () => { requests++; return {}; }, subscribe: () => { subscriptions++; return {}; } };
  const options: AdapterOptions = { transport };
  await assert.rejects(() => new OkxConnector(options).request('instruments', OKX_OPTIONS), AdapterTransportError);
  await assert.rejects(() => new BitgetConnector(options).subscribe('depth', BITGET_OPTIONS), AdapterTransportError);
  assert.equal(requests, 0); assert.equal(subscriptions, 0);
});


test('actual Bitget futures metadata permits an empty optional quote precision without changing units or increments', () => {
  // Public /api/v3/market/instruments BTCUSDT USDT-FUTURES response observed
  // 2026-10-01 requestTime1790896923525: quotePrecision is an empty string.
  const row = { symbol: 'BTCUSDT', category: 'USDT-FUTURES', status: 'online', baseCoin: 'BTC', quoteCoin: 'USDT',
    pricePrecision: '1', quantityPrecision: '4', priceMultiplier: '0.1', quantityMultiplier: '0.0001',
    quotePrecision: '', minOrderQty: '0.0001', minOrderAmount: '5', type: 'perpetual' };
  for (const quotePrecision of ['', '  ', null, undefined]) {
    const asset = normalizeBitgetInstrumentInfo({ code: '00000', requestTime: NOW, data: [{ ...row, quotePrecision }] }, { symbol: 'BTCUSDT', instType: 'usdt-futures', category: 'usdt-futures', marketType: 'perpetual' }).assets[0];
    assert.equal(asset.quotePrecision, undefined); assert.equal(asset.instrumentId, 'bitget:BTCUSDT');
    assert.equal(asset.marketType, 'perpetual'); assert.equal(asset.quantityUnit, 'base'); assert.equal(asset.contractValue, null);
    assert.equal(asset.tickSize, 0.1); assert.equal(asset.lotSize, 0.0001); assert.equal(asset.qtyStep, 0.0001);
    assert.equal(asset.status, 'online'); assert.equal(asset.isDelisted, false);
  }
  assert.throws(() => bitgetMetadata({ quotePrecision: '' }), /quotePrecision/);
});


test('Bitget USDT futures decimal depth preserves native base quantity and price times base USD', () => {
  const options = { symbol: 'BTCUSDT', category: 'usdt-futures', instType: 'usdt-futures', marketType: 'perpetual', receivedAt: NOW };
  const metadata = normalizeBitgetInstrumentInfo({ code: '00000', requestTime: NOW, data: [{
    symbol: 'BTCUSDT', category: 'USDT-FUTURES', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'online', type: 'perpetual',
    pricePrecision: '1', quantityPrecision: '4', priceMultiplier: '0.1', quantityMultiplier: '0.0001', quotePrecision: '',
  }] }, options).assets[0];
  const book = normalizeBitgetDepth({ action: 'snapshot', arg: { instType: 'usdt-futures', symbol: 'BTCUSDT' }, data: [{
    bids: [['100000', '0.0004']], asks: [['100001', '0.0012']], seq: '10', ts: String(NOW),
  }] }, { ...options, metadata });
  assert.equal(metadata.quantityUnit, 'base'); assert.equal(metadata.contractValue, null);
  assert.equal(book.units, 'base'); assert.equal(book.market.quantityUnit, 'base'); assert.equal(book.market.contractValue, null);
  assert.deepEqual(book.bids, [{ price: 100000, amount: 0.0004 }]);
  const levels = usdBookLevels(book, book.market);
  assert.equal(levels[0].amount, 0.0004); assert.equal(levels[0].notionalUsd, 40);
  assert.ok(Math.abs(levels[1].notionalUsd - 120.0012) < 1e-10);
  assert.equal(levels[0].valuation.units, 'base'); assert.equal(levels[0].valuation.contractType, null);
  assert.throws(() => normalizeBitgetDepth({ action: 'snapshot', data: [{ bids: [], asks: [], seq: '10' }] }, { ...options, contractValue: 0.0001 }), /cannot use a contract value/);
  for (const family of ['coin-futures', 'usdc-futures', 'margin']) {
    assert.throws(() => buildBitgetRequest('instruments', { category: family }), /Unsupported shipped Bitget category/);
    assert.throws(() => buildBitgetSubscription('depth', { symbol: 'BTCUSDT', instType: family }), /Unsupported shipped Bitget category/);
    assert.throws(() => bitgetInstrumentId('BTCUSDT', family), /Unsupported shipped Bitget category/);
  }
});


test('OKX inverse SWAP selected metadata supplies USD face and price-independent native contract valuation', () => {
  const options = { instId: 'BTC-USD-SWAP', instType: 'SWAP', marketType: 'perpetual', receivedAt: NOW };
  const metadata = normalizeOkxInstrumentInfo({ code: '0', data: [{ instId: options.instId, instType: 'SWAP', state: 'live',
    baseCcy: '', quoteCcy: '', ctType: 'inverse', ctVal: '100', ctValCcy: 'USD', settleCcy: 'BTC', tickSz: '0.1', lotSz: '1' }] }, options).assets[0];
  assert.equal(metadata.contractType, 'inverse'); assert.equal(metadata.inverse, true);
  assert.equal(metadata.contractValueCurrency, 'USD'); assert.equal(metadata.contractValue, 100); assert.equal(metadata.settleCoin, 'BTC');
  for (const price of ['100000', '50000']) {
    const book = normalizeOkxDepth({ action: 'snapshot', arg: { instId: options.instId }, data: [{
      bids: [[price, '2']], asks: [], seqId: '10', ts: String(NOW),
    }] }, { ...options, metadata });
    assert.equal(book.units, 'contract'); assert.equal(book.market.inverse, true); assert.equal(book.market.contractType, 'inverse');
    const level = usdBookLevels(book)[0];
    assert.equal(level.notionalUsd, 200); assert.equal(level.amount, 200 / Number(price)); assert.equal(level.contractAmount, 2);
  }
});

test('OKX missing contract type can infer only from explicit valid face currency and matching settlement', () => {
  const options = { instId: 'BTC-USDT-SWAP', instType: 'SWAP', marketType: 'perpetual', receivedAt: NOW };
  const row = { instId: options.instId, instType: 'SWAP', state: 'live', baseCcy: '', quoteCcy: '',
    ctVal: '0.01', ctValCcy: 'BTC', settleCcy: 'USDT', tickSz: '0.1', lotSz: '1' };
  const metadata = normalizeOkxInstrumentInfo({ code: '0', data: [row] }, options).assets[0];
  assert.equal(metadata.contractType, 'linear'); assert.equal(metadata.inverse, false); assert.equal(metadata.contractValueCurrency, 'BTC');
  const book = normalizeOkxDepth({ action: 'snapshot', data: [{ bids: [['100000', '2']], asks: [], seqId: '10' }] }, { ...options, metadata });
  assert.equal(usdBookLevels(book)[0].notionalUsd, 2000);
  for (const change of [{ ctValCcy: '' }, { ctValCcy: 'ETH' }, { ctType: 'inverse' }, { ctType: 'quanto' },
    { settleCcy: 'BTC' }, { ctVal: '0' }, { baseCcy: 'ETH' }, { tickSz: '0' }, { lotSz: '0' }]) {
    assert.throws(() => normalizeOkxInstrumentInfo({ code: '0', data: [{ ...row, ...change }] }, options), /contract|metadata|symbol|tickSz|lotSz/i);
  }
  assert.throws(() => normalizeOkxDepth({ action: 'snapshot', data: [{ bids: [], asks: [], seqId: '10' }] }, { ...options, metadata, contractValue: 100 }), /override mismatch/);
  assert.throws(() => normalizeOkxDepth({ action: 'snapshot', data: [{ bids: [], asks: [], seqId: '10' }] }, { ...options, metadata: { ...metadata, inverse: true } }), /face\/settlement metadata mismatch/);
});
