import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdapterTransportError,
  BitgetConnector, OkxConnector,
  buildBitgetRequest, buildBitgetSubscription, buildOkxRequest, buildOkxSubscription,
  normalizeBitgetDepth, normalizeBitgetRestDepth, normalizeBitgetInstrumentInfo, normalizeOkxDepth, normalizeOkxInstrumentInfo,
  createPublicDepthSession, applyPublicDepthSessionMessage, invalidatePublicDepthSession,
} from '../src/adapters/index.mts';

const NOW = 1_700_000_000_100;

test('OKX public descriptors target swap books and stable sequencing fields', () => {
  assert.match(buildOkxRequest('instruments', { instType: 'SWAP' }).url, /api\/v5\/public\/instruments\?instType=SWAP$/);
  assert.match(buildOkxRequest('instruments', { instType: 'SWAP', instId: 'BTC-USDT-SWAP' }).url, /api\/v5\/public\/instruments\?instType=SWAP&instId=BTC-USDT-SWAP$/);
  assert.match(buildOkxRequest('depth', { instId: 'BTC-USDT-SWAP', size: 400 }).url, /api\/v5\/market\/books\?instId=BTC-USDT-SWAP&sz=400$/);
  assert.deepEqual(buildOkxSubscription('depth', { instId: 'BTC-USDT-SWAP' }), { url: 'wss://ws.okx.com:8443/ws/v5/public', method: 'subscribe', args: [{ channel: 'books', instId: 'BTC-USDT-SWAP' }], topic: 'books:BTC-USDT-SWAP', channel: 'books', instId: 'BTC-USDT-SWAP' });
});

test('OKX snapshot/update normalize contract quantities and sequence continuity', () => {
  const snapshot = normalizeOkxDepth({ action: 'snapshot', arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, data: [{ asks: [['101', '3', '0', '2']], bids: [['100', '2', '0', '1']], ts: String(NOW), seqId: '10', prevSeqId: '-1' }] }, { receivedAt: NOW + 1 });
  assert.equal(snapshot.instrumentId, 'okx:BTC-USDT-SWAP'); assert.equal(snapshot.market.quantityUnit, 'contract'); assert.equal(snapshot.sequence, 10); assert.equal(snapshot.market.base, 'BTC');
  const delta = normalizeOkxDepth({ action: 'update', arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, data: [{ asks: [['101', '0', '0', '0']], bids: [['99', '4', '0', '1']], ts: String(NOW + 1), seqId: '11', prevSeqId: '10' }] });
  assert.ok(delta.kind === 'depthDelta'); assert.equal(delta.previousSequence, 10); assert.deepEqual(delta.bids, [{ price: 99, amount: 4 }]); assert.deepEqual(delta.asks, [{ price: 101, amount: 0 }]);
  assert.throws(() => normalizeOkxDepth({ action: 'update', data: [{ asks: [], bids: [], seqId: '3', prevSeqId: '2' }] }), /instrument missing/);
});

test('OKX instrument metadata keeps tick and contract value explicit', () => {
  const metadata = normalizeOkxInstrumentInfo({ code: '0', ts: NOW, data: [{ instType: 'SWAP', instId: 'BTC-USDT-SWAP', state: 'live', baseCcy: 'BTC', quoteCcy: 'USDT', tickSz: '0.1', lotSz: '1', ctVal: '0.01', ctValCcy: 'BTC', ctType: 'linear', settleCcy: 'USDT' }, { instType: 'SWAP', instId: 'ETH-USDT-SWAP', state: 'suspend', tickSz: '0.01' }] }, { receivedAt: NOW + 1 });
  assert.equal(metadata.assets.length, 1); assert.equal(metadata.assets[0].tickSize, 0.1); assert.equal(metadata.assets[0].contractValue, 0.01); assert.equal(metadata.assets[0].quantityUnit, 'contract');
});

test('OKX empty swap currency metadata falls back to the instrument id', () => {
  const metadata = normalizeOkxInstrumentInfo({ code: '0', ts: NOW, data: [{ instType: 'SWAP', instId: 'BTC-USDT-SWAP', state: 'live', baseCcy: '', quoteCcy: '', tickSz: '0.1', lotSz: '1', ctVal: '0.01', ctValCcy: 'BTC', ctType: 'linear', settleCcy: 'USDT' }] }, { receivedAt: NOW + 1 });
  assert.equal(metadata.assets[0].base, 'BTC');
  assert.equal(metadata.assets[0].quote, 'USDT');
});

test('Bitget UTA public descriptors use the full books topic', () => {
  assert.match(buildBitgetRequest('depth', { symbol: 'BTCUSDT', category: 'usdt-futures', limit: 200 }).url, /api\/v3\/market\/orderbook\?category=USDT-FUTURES&symbol=BTCUSDT&limit=200$/);
  assert.match(buildBitgetRequest('instruments', { symbol: 'BTCUSDT', category: 'usdt-futures' }).url, /api\/v3\/market\/instruments\?category=USDT-FUTURES&symbol=BTCUSDT$/);
  assert.deepEqual(buildBitgetSubscription('depth', { symbol: 'BTCUSDT' }), { url: 'wss://ws.bitget.com/v3/ws/public', method: 'subscribe', args: [{ instType: 'usdt-futures', topic: 'books', symbol: 'BTCUSDT' }], topic: 'books:BTCUSDT', channel: 'books', instType: 'usdt-futures', symbol: 'BTCUSDT' });
});

test('Bitget instrument metadata keeps futures lot increment separate from face value', () => {
  const metadata = normalizeBitgetInstrumentInfo({ code: '00000', requestTime: NOW, data: [{ category: 'USDT-FUTURES', symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'online', priceMultiplier: '0.1', quantityMultiplier: '0.0001', pricePrecision: '1', quantityPrecision: '4' }] }, { category: 'usdt-futures', receivedAt: NOW + 1 });
  assert.equal(metadata.assets.length, 1);
  assert.equal(metadata.assets[0].instrumentId, 'bitget:BTCUSDT');
  assert.equal(metadata.assets[0].quantityUnit, 'base');
  assert.equal(metadata.assets[0].contractValue, null);
  assert.equal(metadata.assets[0].lotSize, 0.0001);
  assert.equal(metadata.assets[0].quantityMultiplier, 0.0001);
  assert.equal(metadata.assets[0].tickSize, 0.1);
});

test('Bitget snapshot/update normalize futures quantities and large sequence IDs', () => {
  const snapshot = normalizeBitgetDepth({ code: '00000', action: 'snapshot', arg: { instType: 'usdt-futures', topic: 'books', symbol: 'BTCUSDT' }, data: [{ a: [['101', '3']], b: [['100', '2']], ts: String(NOW), seq: '1304314508780744705' }] }, { receivedAt: NOW + 1 });
  assert.equal(snapshot.instrumentId, 'bitget:BTCUSDT'); assert.equal(snapshot.market.quantityUnit, 'base'); assert.equal(snapshot.sequence, '1304314508780744705');
  const delta = normalizeBitgetDepth({ action: 'update', arg: { instType: 'usdt-futures', topic: 'books', symbol: 'BTCUSDT' }, data: [{ a: [['101', '0']], b: [['99', '4']], ts: String(NOW + 1), seq: '1304314508780744706', pseq: '1304314508780744705' }] });
  assert.ok(delta.kind === 'depthDelta'); assert.equal(delta.previousSequence, '1304314508780744705'); assert.deepEqual(delta.bids, [{ price: 99, amount: 4 }]);
  assert.throws(() => normalizeBitgetDepth({ action: 'snapshot', arg: { symbol: 'BTCUSDT' }, data: [{ a: [], b: [], seq: Number.MAX_SAFE_INTEGER + 2 }] }), /unsafe numeric/);
});

test('Bitget REST snapshots stay distinct from sequenced websocket snapshots', () => {
  const rest = normalizeBitgetRestDepth({ code: '00000', requestTime: NOW, data: { a: [['101', '3']], b: [['100', '2']], ts: String(NOW) } }, { symbol: 'BTCUSDT', category: 'USDT-FUTURES', receivedAt: NOW + 1 });
  assert.equal(Object.hasOwn(rest, 'sequence'), false); assert.equal(rest.continuity, 'rest-snapshot'); assert.equal(rest.complete, true);
  assert.throws(() => normalizeBitgetRestDepth({ code: '10001', data: {} }, { symbol: 'BTCUSDT' }), /provider error/);
});

test('public depth session requires exact predecessors and rejects gaps until resnapshot', () => {
  let session = createPublicDepthSession({ venue: 'bitget', topic: 'books:BTCUSDT', instrumentId: 'bitget:BTCUSDT', sessionToken: 's1' });
  const snap = normalizeBitgetDepth({ action: 'snapshot', arg: { symbol: 'BTCUSDT' }, data: [{ a: [['101', '3']], b: [['100', '2']], seq: '9007199254740993' }] });
  let routed = applyPublicDepthSessionMessage(session, { topic: 'books:BTCUSDT', sessionToken: 's1', update: snap }); session = routed.session; assert.equal(routed.accepted, true);
  const exact = normalizeBitgetDepth({ action: 'update', arg: { symbol: 'BTCUSDT' }, data: [{ a: [], b: [['99', '1']], seq: '9007199254740994', pseq: '9007199254740993' }] });
  routed = applyPublicDepthSessionMessage(session, { topic: 'books:BTCUSDT', sessionToken: 's1', update: exact }); assert.equal(routed.accepted, true); session = routed.session;
  const missing = normalizeBitgetDepth({ action: 'update', arg: { symbol: 'BTCUSDT' }, data: [{ a: [], b: [['99', '1']], seq: '9007199254740995' }] });
  routed = applyPublicDepthSessionMessage(session, { topic: 'books:BTCUSDT', sessionToken: 's1', update: missing }); assert.equal(routed.reason, 'resync-required'); assert.equal(routed.session.invalidated, true);
  const strict = normalizeBitgetDepth({ action: 'update', arg: { symbol: 'BTCUSDT' }, data: [{ a: [], b: [['99', '1']], seq: '9007199254740995', pseq: '9007199254740993' }] });
  session = routed.session; routed = applyPublicDepthSessionMessage(session, { topic: 'books:BTCUSDT', sessionToken: 's1', update: strict }); assert.equal(routed.reason, 'fresh-snapshot-required');
  const gap = normalizeBitgetDepth({ action: 'update', arg: { symbol: 'BTCUSDT' }, data: [{ a: [], b: [], seq: '9007199254741000', pseq: '9007199254740998' }] });
  assert.equal(applyPublicDepthSessionMessage(routed.session, { topic: 'books:BTCUSDT', sessionToken: 's1', update: gap }).reason, 'fresh-snapshot-required');
  const invalid = invalidatePublicDepthSession(routed.session, 'socket closed'); assert.ok(invalid.book); assert.equal(invalid.book.complete, false);
  assert.equal(applyPublicDepthSessionMessage(invalid, { topic: 'books:BTCUSDT', sessionToken: 's1', update: strict }).reason, 'fresh-snapshot-required');
});

test('OKX maintenance sequence reset is explicit', () => {
  const update = normalizeOkxDepth({ action: 'update', arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, data: [{ asks: [], bids: [], seqId: '1', prevSeqId: '-1' }] });
  assert.ok(update.kind === 'depthDelta'); assert.equal(update.sequenceReset, true); assert.equal(update.previousSequence, undefined);
});

test('OKX and Bitget connectors remain disabled without explicit network opt-in', async () => {
  await assert.rejects(() => new OkxConnector({ transport: { request: async request => request } }).request('depth', { instId: 'BTC-USDT-SWAP' }), AdapterTransportError);
  await assert.rejects(() => new BitgetConnector({ transport: { request: async request => request } }).request('depth', { symbol: 'BTCUSDT' }), AdapterTransportError);
});
