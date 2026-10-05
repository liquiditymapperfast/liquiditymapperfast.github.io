import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeBinanceKline, normalizeHyperliquidCandle } from '../src/adapters/index.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { LiveFeedManager } from '../src/server/live-feeds.mts';

test('native candle normalizers reject malformed OHLC and preserve interval timing', () => {
  assert.throws(() => normalizeHyperliquidCandle([1_700_000_000_000, 1_700_003_600_000, '100', '90', '80', '85', '1'], { interval: '1h' }), /OHLC ordering/);
  const candle = normalizeBinanceKline({ t: 1_700_000_000_000, T: 1_700_003_600_000, o: '100', h: '110', l: '90', c: '105', v: '42', x: true }, { symbol: 'BTCUSDT', interval: '1h' });
  assert.deepEqual({ start: candle.start, end: candle.end, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume, closed: candle.closed }, { start: 1_700_000_000_000, end: 1_700_003_600_000, open: 100, high: 110, low: 90, close: 105, volume: 42, closed: true });
  assert.equal(candle.sourceTimestamp, 1_700_003_600_000);
});

test('native candle adapters keep inferred interval end separate from provider source time', () => {
  const start = 1_700_000_000_000;
  const hyperliquid = normalizeHyperliquidCandle({ t: start, o: '100', h: '110', l: '90', c: '105', v: '42', x: true }, { interval: '1m' });
  const binance = normalizeBinanceKline({ t: start, o: '100', h: '110', l: '90', c: '105', v: '42', x: true }, { symbol: 'BTCUSDT', interval: '1m' });
  for (const candle of [hyperliquid, binance]) {
    assert.equal(candle.end, start + 60_000);
    assert.equal(candle.sourceTimestamp, null);
    assert.equal(candle.closed, true);
  }
  assert.equal(normalizeHyperliquidCandle({ t: 0, o: '100', h: '110', l: '90', c: '105', v: '42' }, { interval: '1m' }).start, 0);
  assert.equal(normalizeBinanceKline({ t: 0, o: '100', h: '110', l: '90', c: '105', v: '42' }, { symbol: 'BTCUSDT', interval: '1m' }).start, 0);
  for (const malformedEnd of [true, [start + 60_000], '0x10']) {
    assert.throws(() => normalizeHyperliquidCandle({ t: start, T: malformedEnd, o: '100', h: '110', l: '90', c: '105', v: '42' }, { interval: '1m' }), /end timestamp/);
    assert.throws(() => normalizeBinanceKline({ t: start, T: malformedEnd, o: '100', h: '110', l: '90', c: '105', v: '42' }, { symbol: 'BTCUSDT', interval: '1m' }), /end timestamp/);
  }
});

test('closed candle without explicit provider time stays live but does not become exchange-timed history', async () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  const app = createLocalServer({ history, quota: new QuotaLedger() });
  const start = 1_700_000_000_000;
  const base = { kind: 'candle', instrumentId: 'hyperliquid:BTC-PERP', interval: '1m', start, end: start + 60_000, open: 100, high: 110, low: 90, close: 105, volume: 42, receivedAt: start + 60_100, closed: true, source: 'live' };
  try {
    for (const sourceTimestamp of [undefined, null, true, [start + 60_000], '0x10']) {
      assert.equal(history.recordCandle({ ...base, sourceTimestamp }), false);
    }
    app.applyMessage(base, 'hyperliquid');
    assert.equal(app.state.candles[base.instrumentId][0].sourceTimestamp, null);
    assert.equal(app.state.sourceTimestamps['hyperliquid:candle'], undefined);
    assert.equal(history.listCandles(base.instrumentId, { interval: '1m' }).length, 0);
    for (const [index, sourceTimestamp] of [true, [start + 60_000], '0x10'].entries()) {
      app.applyMessage({ ...base, sourceTimestamp, receivedAt: start + 60_101 + index }, 'hyperliquid');
      assert.equal(app.state.candles[base.instrumentId][0].sourceTimestamp, null);
      assert.equal(app.state.sourceTimestamps['hyperliquid:candle'], undefined);
      assert.equal(history.listCandles(base.instrumentId, { interval: '1m' }).length, 0);
    }
    app.applyMessage({ ...base, close: 104, source: 'history', sourceTimestamp: start + 60_000, receivedAt: start + 60_050 }, 'hyperliquid');
    assert.equal(app.state.candles[base.instrumentId][0].close, 105);
    assert.equal(history.listCandles(base.instrumentId, { interval: '1m' }).length, 0);
    app.applyMessage({ ...base, close: 106, source: 'history', sourceTimestamp: start + 60_000, receivedAt: start + 60_200 }, 'hyperliquid');
    assert.equal(app.state.candles[base.instrumentId][0].close, 106);
    assert.equal(app.state.sourceTimestamps['hyperliquid:candle'], start + 60_000);
    assert.equal(history.listCandles(base.instrumentId, { interval: '1m' }).length, 1);
    app.applyMessage({ ...base, close: 107, sourceTimestamp: null, receivedAt: start + 60_300 }, 'hyperliquid');
    assert.equal(app.state.candles[base.instrumentId][0].close, 106);
  } finally { await app.close(); }
});

test('live candle hydration uses both public history descriptors and emits normalized rows', async () => {
  const start = 1_700_000_000_000; const requests: ExchangeRestRequest[] = []; const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    restTransport: { request: async (request) => { requests.push(request); if (request.url.includes('api.hyperliquid.xyz')) return [{ t: start, T: start + 3_600_000, o: '100', h: '110', l: '90', c: '105', v: '42' }]; return [[start, '100', '110', '90', '105', '42', start + 3_600_000]]; } },
    onMessage: (event) => messages.push(event),
    now: () => start + 7_200_000,
  });
  const hl = await manager.syncCandleHistory({ venue: 'hyperliquid', coin: 'BTC', interval: '1h', startTime: start, endTime: start + 3_600_000, limit: 2 });
  const binance = await manager.syncCandleHistory({ venue: 'binance', symbol: 'BTCUSDT', marketType: 'perpetual', interval: '1h', startTime: start, endTime: start + 3_600_000, limit: 2 });
  assert.equal(hl.length, 1); assert.equal(binance.length, 1); assert.equal(messages.length, 2); assert.ok(textValue(requests[0].body).includes('candleSnapshot')); assert.match(requests[1].url, /fapi\.binance\.com\/fapi\/v1\/klines/);
  assert.equal(messages[0].message.source, 'history'); assert.equal(messages[0].message.closed, true);
});

test('delayed REST response does not finalize a row that was open at request cutoff', async () => {
  const start = 1_700_000_000_000; let clock = start + 30_000; const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    restTransport: { request: async () => { clock = start + 90_000; return [{ t: start, T: start + 60_000, o: '100', h: '110', l: '90', c: '105', v: '42' }]; } },
    onMessage: (event) => messages.push(event),
    now: () => clock,
  });
  const candles = await manager.syncCandleHistory({ venue: 'hyperliquid', coin: 'BTC', interval: '1m', startTime: start, endTime: start + 30_000, limit: 2 });
  assert.equal(candles.length, 1);
  assert.equal(candles[0].sourceTimestamp, start + 60_000);
  assert.equal(candles[0].closed, false);
  assert.equal(messages[0].message.closed, false);
});

test('native history requests cover every supported interval and reject a contradictory source row', async () => {
  const start = 1_700_000_000_000; const requests: ExchangeRestRequest[] = [];
  const intervalDuration: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000 };
  const manager = new LiveFeedManager({
    networkEnabled: true,
    restTransport: { request: async request => {
      requests.push(request);
      const interval = request.body ? textValue(fields(fields(JSON.parse(textValue(request.body))).req).interval) : new URL(request.url).searchParams.get('interval');
      const duration = intervalDuration[defined(interval)];
      return [[start, '100', '110', '90', '105', '42', start + duration]];
    } },
    onMessage: () => {}, now: () => start + 7_200_000,
  });
  for (const interval of ['1m', '5m', '15m', '30m', '1h']) {
    const rows = await manager.syncCandleHistory({ venue: 'binance', symbol: 'BTCUSDT', interval, startTime: start, endTime: start + 3_600_000, limit: 2 });
    assert.equal(rows.length, 1, interval);
    assert.equal(rows[0].interval, interval);
  }
  const mismatch = new LiveFeedManager({
    networkEnabled: true,
    restTransport: { request: async () => [[start, '100', '110', '90', '105', '42', start + 3_600_000]] },
    now: () => start + 7_200_000,
  });
  assert.deepEqual(await mismatch.syncCandleHistory({ venue: 'binance', symbol: 'BTCUSDT', interval: '5m', startTime: start, endTime: start + 3_600_000, limit: 2 }), []);
  assert.equal(mismatch.status()['binance-kline-history'].state, 'unavailable');
  assert.equal(requests.length, 5);
});

test('a candle response already in flight is discarded when a new feed selection starts', async () => {
  const start = 1_700_000_000_000; let resolveOld: ((rows: unknown) => void) | undefined; const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    restTransport: { request: async request => {
      if (request.body != null && textValue(request.body).includes('candleSnapshot')) return new Promise<unknown>(resolve => { resolveOld = resolve; });
      return [{ universe: [{ name: 'BTC', szDecimals: 5 }] }, [{ openInterest: '1', markPx: '100' }]];
    } },
    onMessage: event => messages.push(event), now: () => start + 60_000,
  });
  const oldResponse = manager.syncCandleHistory({ venue: 'hyperliquid', coin: 'BTC', interval: '1m', startTime: start, endTime: start + 60_000, limit: 1 });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(manager.start(), /transportFactory/);
  defined(resolveOld)([{ t: start, T: start + 60_000, o: '100', h: '110', l: '90', c: '105', v: '1' }]);
  assert.deepEqual(await oldResponse, []);
  assert.equal(messages.filter(item => item.message?.kind === 'candle').length, 0);
});

test('closed REST history completes an older live candle while stale history does not', () => {
  const history = new HistoryStore({ filePath: ':memory:' }); const app = createLocalServer({ history, quota: new QuotaLedger() }); const start = 1_700_000_000_000;
  try {
    const base = { kind: 'candle', instrumentId: 'hyperliquid:BTC-PERP', interval: '1h', start, end: start + 3_600_000, open: 100, high: 110, low: 90, volume: 42 };
    app.applyMessage({ ...base, close: 108, source: 'live', sourceTimestamp: start + 3_600_000, receivedAt: 20, closed: false }, 'hyperliquid');
    app.applyMessage({ ...base, close: 102, source: 'history', sourceTimestamp: start + 3_600_000, receivedAt: 30, closed: true }, 'hyperliquid');
    assert.equal(app.state.candles['hyperliquid:BTC-PERP'][0].close, 102);
    assert.equal(history.listCandles('hyperliquid:BTC-PERP', { interval: '1h', from: start, to: start + 3_600_001 })[0].close, 102);
    app.applyMessage({ ...base, close: 101, source: 'history', sourceTimestamp: start + 3_500_000, receivedAt: 40, closed: true }, 'hyperliquid');
    assert.equal(app.state.candles['hyperliquid:BTC-PERP'][0].close, 102);
    app.applyMessage({ ...base, close: 109, source: 'live', sourceTimestamp: start + 3_600_000, receivedAt: 50, closed: true }, 'hyperliquid');
    assert.equal(app.state.candles['hyperliquid:BTC-PERP'][0].close, 109);
  } finally { app.close(); }
});
