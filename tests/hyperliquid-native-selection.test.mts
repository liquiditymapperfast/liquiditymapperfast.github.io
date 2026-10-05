import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHyperliquidInfoRequest, buildHyperliquidSubscription, hyperliquidCoin, hyperliquidNativeCoin, matchesHyperliquidSubscriptionResponse, matchesHyperliquidSubscriptionData } from '../src/adapters/hyperliquid.mts';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import type { LiveFeedEvent, LiveFeedRestTransport, LiveFeedSocket, LiveFeedTransportOptions } from '../src/server/live-feeds.mts';
import { defined, fields } from './server-test-helpers.mts';
const NOW = 1_700_000_060_120, START = 1_699_999_980_000;
const ids = ['hl-l2Book-native', 'hl-l2Book', 'hl-activeAssetCtx', 'hl-candle', 'hl-trades'];
const candle = (coin: string) => ({ s: coin, i: '1m', t: START, T: START + 59_999, o: '100', h: '101', l: '99', c: '100', v: '2' });
class Socket implements LiveFeedSocket {
  onMessage?: (raw: unknown) => void; onClose?: (reason: unknown) => void; onError?: (reason: unknown) => void;
  sent: string[] = []; closed = false;
  constructor(readonly spec: LiveFeedTransportOptions) {}
  async open() {} send(raw: string) { this.sent.push(raw); } close() { this.closed = true; }
  emit(raw: unknown) { this.onMessage?.(raw); }
  closeWith() { this.closed = true; this.onClose?.('client-induced native case fixture close'); }
}
function fixture({ rows = [{ name: 'kBONK', szDecimals: 0 }], reject = false }: { rows?: Record<string, unknown>[]; reject?: boolean } = {}) {
  const sockets: Socket[] = [], messages: LiveFeedEvent[] = [], requests: Record<string, unknown>[] = [], retries: (() => unknown)[] = [];
  const rest: LiveFeedRestTransport = { request: async request => {
    if (typeof request.body === 'string') { const body = fields(JSON.parse(request.body)); requests.push(body); return body.type === 'metaAndAssetCtxs' ? [{ universe: rows }, rows.map(() => ({ openInterest: '2', markPx: '100' }))] : [candle('kBONK'), candle('KBONK'), candle('BTC')]; }
    if (request.url.includes('exchangeInfo')) return { symbols: [] };
    if (request.url.includes('/depth')) return { lastUpdateId: 1, bids: [['100', '1']], asks: [['101', '1']] };
    return [];
  } };
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: async spec => { const socket = new Socket(spec); sockets.push(socket); return socket; }, restTransport: rest,
    now: () => NOW, oiPollMs: 0, oiHistoryLimit: 0, candleHistoryLimit: 3, schedule: fn => { retries.push(fn); return {}; }, cancel: () => {}, heartbeatSchedule: () => ({}), heartbeatCancel: () => {},
    transportPolicies: { hyperliquid: { subscribeIntervalMs: 0 }, binance: { subscribeIntervalMs: 0 } },
    onMessage: event => { if (reject && event.id === 'hl-metadata') return false; messages.push(event); } });
  return { manager, sockets, messages, requests, retries, selected: (id: string) => defined(sockets.filter(socket => socket.spec.id === id).at(-1)) };
}
const ack = (socket: Socket, coin = 'kBONK') => ({ channel: 'subscriptionResponse', data: { ...socket.spec.request, subscription: { ...fields(socket.spec.request.subscription), coin } } });
const book = (coin = 'kBONK') => ({ channel: 'l2Book', data: { coin, time: NOW, levels: [[{ px: '100', sz: '2' }], [{ px: '101', sz: '3' }]] } });

test('Hyperliquid native override preserves API case with unchanged canonical IDs', () => {
  assert.equal(hyperliquidCoin('kBONK'), 'KBONK'); assert.equal(hyperliquidNativeCoin('KBONK-PERP', 'kBONK'), 'kBONK');
  for (const type of ['l2Book', 'candle', 'activeAssetCtx', 'trades']) assert.equal(buildHyperliquidSubscription(type, { coin: 'KBONK', nativeCoin: 'kBONK' }).subscription.coin, 'kBONK');
  assert.equal(fields(JSON.parse(buildHyperliquidInfoRequest('l2Book', { coin: 'KBONK', nativeCoin: 'kBONK' }).body)).coin, 'kBONK');
  assert.equal(fields(fields(JSON.parse(buildHyperliquidInfoRequest('candleSnapshot', { coin: 'KBONK', nativeCoin: 'kBONK', startTime: START }).body)).req).coin, 'kBONK');
  for (const native of ['kBONK-PERP', 'hyperliquid:kBONK', 'k BONK', 'BTC', '']) assert.throws(() => hyperliquidNativeCoin('KBONK', native), /native coin/);
});

test('Hyperliquid native ACK and data identities reject the uppercase counterpart', () => {
  const request = buildHyperliquidSubscription('l2Book', { coin: 'KBONK', nativeCoin: 'kBONK' });
  assert.equal(matchesHyperliquidSubscriptionResponse({ channel: 'subscriptionResponse', data: request }, request), true);
  assert.equal(matchesHyperliquidSubscriptionResponse({ channel: 'subscriptionResponse', data: { ...request, subscription: { ...request.subscription, coin: 'KBONK' } } }, request), false);
  assert.equal(matchesHyperliquidSubscriptionData(book(), request), true); assert.equal(matchesHyperliquidSubscriptionData(book('KBONK'), request), false);
});

test('Hyperliquid native override reconfirms exact active metadata before any subscription or history', async () => {
  for (const rows of [[], [{ name: 'KBONK', szDecimals: 0 }], [{ name: 'kBONK', szDecimals: 0, isDelisted: true }], [{ name: 'kBONK', szDecimals: -1 }], [{ name: 'kBONK', szDecimals: 0 }, { name: 'kBONK', szDecimals: 0 }]]) {
    const h = fixture({ rows }); try {
      await h.manager.start({ coin: 'KBONK', hlNativeCoin: 'kBONK' });
      assert.equal(h.sockets.some(socket => socket.spec.venue === 'hyperliquid'), false); assert.equal(h.requests.some(request => request.type === 'candleSnapshot'), false);
      for (const id of ids) assert.match(String(h.manager.status()[id].lastError), /active exact public metadata/);
    } finally { h.manager.stop(); }
  }
  const rejected = fixture({ reject: true }); try { await rejected.manager.start({ coin: 'KBONK', hlNativeCoin: 'kBONK' }); assert.equal(rejected.sockets.some(socket => socket.spec.venue === 'hyperliquid'), false); } finally { rejected.manager.stop(); }
});

test('native startup, history refresh and reconnect preserve case and fence stale frames', async () => {
  const h = fixture(); try {
    await h.manager.start({ coin: 'KBONK', hlNativeCoin: 'kBONK' });
    for (const id of ids) assert.equal(fields(h.selected(id).spec.request.subscription).coin, 'kBONK');
    const first = h.selected('hl-l2Book'); first.emit(ack(first, 'KBONK')); first.emit(book('KBONK')); assert.equal(h.manager.status()['hl-l2Book'].subscriptionAcked, false); assert.equal(h.messages.filter(event => event.id === 'hl-l2Book').length, 0);
    first.emit(ack(first)); first.emit(book('KBONK')); assert.equal(h.manager.status()['hl-l2Book'].subscriptionAcked, true); assert.equal(h.messages.filter(event => event.id === 'hl-l2Book').length, 0);
    first.emit(book()); assert.equal(h.manager.status()['hl-l2Book'].state, 'live');
    assert.equal(defined(h.messages.filter(event => event.id === 'hl-l2Book').at(-1)).message.instrumentId, 'hyperliquid:KBONK-PERP');
    const history = h.messages.filter(event => event.id === 'hl-candle-history'); assert.equal(history.length, 1); assert.equal(history[0].message.instrumentId, 'hyperliquid:KBONK-PERP');
    await h.manager.syncCandleHistory({ coin: 'KBONK', startTime: START, endTime: NOW });
    for (const request of h.requests.filter(request => request.type === 'candleSnapshot')) assert.equal(fields(request.req).coin, 'kBONK');
    first.closeWith(); await defined(h.retries.at(-1))(); const replacement = h.selected('hl-l2Book'); assert.notEqual(replacement, first);
    assert.equal(fields(replacement.spec.request.subscription).coin, 'kBONK'); replacement.emit(ack(replacement)); replacement.emit(book());
    const count = h.messages.length; first.emit(book()); assert.equal(h.messages.length, count);
    await h.manager.start({ coin: 'BTC' }); const before = h.messages.length; replacement.emit(book()); assert.equal(h.messages.length, before);
  } finally { h.manager.stop(); }
});
