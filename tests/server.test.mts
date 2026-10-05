import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalServer, MAX_DIAGNOSTICS_CACHE_BYTES, MAX_PROVIDER_REFRESH_FLIGHTS } from '../src/server/http.mts';
import { MAX_QUOTA_LEDGER_FILE_BYTES, MAX_QUOTA_LEDGER_REQUESTS, QuotaLedger } from '../src/core/quota.mts';
import { HistoryStore } from '../src/server/history.mts';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import { HyperTrackerClient, MAX_HYPERTRACKER_RESPONSE_BYTES } from '../src/adapters/hypertracker.mts';
import { normalizeHyperliquidBook } from '../src/adapters/hyperliquid.mts';
import { usdBookLevels } from '../src/core/book-valuation.mts';
import { logicalRetainedBytes } from '../src/core/retained-bytes.mts';
import { bookKey } from '../src/core/book-key.mts';

import type { RuntimeBook, RuntimeLevel, RuntimeCandle } from '../src/domain/runtime-state.mts';
import type { MutationResult } from '../src/server/http-contracts.mts';
import type { PublishedRetainedBudget, RetainedBudgetCoordinator } from '../src/server/retained-budget.mts';
import { defined, fields, list, numeric, textValue, fieldMap, injectMapFixture, injectSetFixture, injectArrayFixture } from './server-test-helpers.mts';

const jsonResponse = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });

async function readFirstState(response: Response, { timeoutMs = 5_000 } = {}) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('SSE response has no readable body');
  const decoder = new TextDecoder();
  const marker = 'event: state\ndata: ';
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  const parseFrame = () => {
    const start = buffer.indexOf(marker);
    if (start < 0) return null;
    const end = buffer.indexOf('\n\n', start + marker.length);
    if (end < 0) return null;
    return JSON.parse(buffer.slice(start + marker.length, end));
  };
  try {
    while (true) {
      const parsed = parseFrame();
      if (parsed != null) return parsed;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for complete SSE state frame after ${timeoutMs}ms`);
      let timer;
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out reading SSE state after ${timeoutMs}ms`)), remaining); }),
        ]);
        if (result.done) {
          buffer += decoder.decode();
          const completed = parseFrame();
          if (completed != null) return completed;
          throw new Error('SSE ended before a complete state frame');
        }
        buffer += decoder.decode(result.value, { stream: true });
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

test('SSE state reader waits for a complete frame split across chunks', async () => {
  const chunks = [
    'event: status\ndata: {"connected":true}\n\nevent: state\ndata: {"marker":"',
    'split',
    '"}\n',
    '\n',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  assert.deepEqual(await readFirstState(new Response(stream)), { marker: 'split' });
});

test('persistent quota ledger survives a new process instance', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-quota-')); const filePath = path.join(directory, 'quota.json'); const start = new Date(); start.setUTCHours(10, 0, 0, 0); const firstAt = start.getTime(); const secondAt = firstAt + 60 * 60 * 1000;
  try { const first = new QuotaLedger({ limit: 20, filePath }); assert.equal(first.spend(7, 'snapshot', firstAt), true); const second = new QuotaLedger({ limit: 20, filePath }); assert.equal(second.snapshot(secondAt).used, 7); assert.equal(second.spend(14, 'retry', secondAt), false); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('quota ledger rejects oversized persisted files before reading their contents', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-quota-oversized-'));
  const filePath = path.join(directory, 'quota.json');
  const oversized = Buffer.alloc(MAX_QUOTA_LEDGER_FILE_BYTES + 1, 0x20);
  try {
    fs.writeFileSync(filePath, oversized);
    assert.throws(() => new QuotaLedger({ filePath }), /quota ledger file exceeds the .*byte limit/);
    assert.equal(fs.statSync(filePath).size, oversized.length);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('quota ledger refuses persisted usage that disagrees with its request costs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-quota-inconsistent-'));
  const filePath = path.join(directory, 'quota.json');
  const now = Date.now();
  const inconsistent = {
    day: new Date(now).toISOString().slice(0, 10),
    used: 0,
    requests: [{ at: now, cost: 7, label: 'snapshot' }],
  };
  const originalFile = Buffer.from(JSON.stringify(inconsistent), 'utf8');
  try {
    fs.writeFileSync(filePath, originalFile);
    assert.throws(() => new QuotaLedger({ limit: 20, filePath }), /Provider quota ledger is unreadable; refusing to reset usage/);
    assert.deepEqual(fs.readFileSync(filePath), originalFile);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('normalized live messages update the same state used by the browser', () => {
  const app = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  try {
    app.applyMessage({ kind: 'depthSnapshot', instrumentId: 'hyperliquid:BTC-PERP', sequence: 9, sourceTimestamp: 1, receivedAt: 2, complete: true, bids: [{ price: 100, amount: 2 }], asks: [{ price: 101, amount: 3 }] }, 'hyperliquid');
    assert.deepEqual(app.state.books['hyperliquid:BTC-PERP'].coverageBounds, { bids: { min: 100, max: 100 }, asks: { min: 101, max: 101 } });
    assert.deepEqual(app.state.books['hyperliquid:BTC-PERP'].bids, [[100, 2]]);
    app.applyMessage({ kind: 'price', price: 79000, receivedAt: 3 }, 'hyperliquid');
    assert.equal(defined(app.state.layers.takeProfit.find((level) => level.id === 'tp-sell-79000')).active, false);
  } finally { app.close(); }
});

test('server commits manager last-price state inside an admitted mark update', async () => {
  const app = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  const price = Number(app.state.markPrice) + 1;
  let managerPriceCommitted = false;
  try {
    app.applyMessage({
      kind: 'price', instrumentId: app.state.markInstrumentId,
      price, sourceTimestamp: Date.now(), receivedAt: Date.now(),
    }, 'hyperliquid', { retainedMutation: {
      candidate: { kind: 'feed-last-price', feedId: 'hl-activeAssetCtx', instrumentId: app.state.markInstrumentId, price },
      commit() { managerPriceCommitted = true; },
    } });
    assert.equal(managerPriceCommitted, true);
    assert.equal(app.state.markPrice, price);
  } finally { await app.close(); }
});

test('accepted complete depth snapshot clears a prior resync requirement', async () => {
  const app = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  const instrumentId = 'hyperliquid:BTC-PERP';
  try {
    app.applyMessage({ kind: 'depthSnapshot', instrumentId, sequence: 1, complete: true, bids: [{ price: 77_299, amount: 1 }], asks: [{ price: 77_301, amount: 1 }], receivedAt: 1, sourceTimestamp: 1 }, 'hyperliquid');
    app.applyMessage({ kind: 'depthDelta', instrumentId, sequence: 3, previousSequence: 2, bids: [{ price: 77_299, amount: 2 }], asks: [], receivedAt: 2, sourceTimestamp: 2 }, 'hyperliquid');
    assert.equal(app.state.statuses.hyperliquid.resyncRequired, true);
    app.applyMessage({ kind: 'depthSnapshot', instrumentId, sequence: 3, complete: true, bids: [{ price: 77_299, amount: 2 }], asks: [{ price: 77_301, amount: 1 }], receivedAt: 3, sourceTimestamp: 3 }, 'hyperliquid');
    assert.equal(app.state.statuses.hyperliquid.resyncRequired, false);
    assert.equal(app.state.statuses.hyperliquid.state, 'live');
  } finally { await app.close(); }
});

test('source timestamp ledger advances only from accepted provider timestamps', async () => {
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  const instrumentId = 'hyperliquid:BTC-PERP';
  try {
    app.applyMessage({ kind: 'openInterest', instrumentId, base: 10, sourceTimestamp: null, receivedAt: 1_700_000_000_100 }, 'hyperliquid');
    assert.equal(defined(app.state.oi.at(-1)).sourceTimestamp, null);
    assert.equal(defined(app.state.oi.at(-1)).observationTimestamp, 1_700_000_000_100);
    assert.equal(defined(app.state.oi.at(-1)).timeBasis, 'receipt');
    assert.equal(app.state.sourceTimestamps['hyperliquid:openInterest'], undefined);

    app.applyMessage({ kind: 'openInterest', instrumentId, base: 11, sourceTimestamp: 1_700_000_000_200, receivedAt: 1_700_000_000_300 }, 'hyperliquid');
    assert.equal(app.state.sourceTimestamps['hyperliquid:openInterest'], 1_700_000_000_200);
    app.applyMessage({ kind: 'openInterest', instrumentId, base: 12, receivedAt: 1_700_000_000_400 }, 'hyperliquid');
    assert.equal(app.state.sourceTimestamps['hyperliquid:openInterest'], 1_700_000_000_200);

    app.applyMessage({ kind: 'price', instrumentId: 'other:BTC-PERP', price: 100, sourceTimestamp: 1_700_000_000_500, receivedAt: 1_700_000_000_600 }, 'hyperliquid');
    assert.equal(app.state.sourceTimestamps['hyperliquid:price'], undefined);
    app.applyMessage({ kind: 'price', instrumentId, price: 100, sourceTimestamp: 1_700_000_000_700, receivedAt: 1_700_000_000_800 }, 'hyperliquid');
    assert.equal(app.state.sourceTimestamps['hyperliquid:price'], 1_700_000_000_700);
  } finally { await app.close(); }
});

test('layer source ledger and history reject malformed timestamps even when marked known', async () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history });
  const instrumentId = 'hyperliquid:BTC-PERP';
  const base = { kind: 'layerSnapshot', layer: 'liquidation', instrumentId, complete: true, provenanceKnown: true, sourceTimestampKnown: true, revisionKnown: true, levels: [{ id: 'bad-time', price: 80_000, notionalUsd: 10, side: 'short', active: true }] };
  try {
    for (const [index, sourceTimestamp] of [true, [1_700_000_000_100], {}, '0x10'].entries()) {
      app.applyMessage({ ...base, revision: `r${index + 1}`, sourceTimestamp, receivedAt: 1_700_000_000_200 + index }, 'hypertracker');
      assert.equal(app.state.layerMeta.liquidation.sourceTimestamp, null);
      assert.equal(app.state.layerMeta.liquidation.sourceTimestampKnown, false);
      assert.equal(app.state.sourceTimestamps.hypertracker, undefined);
      assert.equal(app.state.sourceTimestamps['hypertracker:layerSnapshot'], undefined);
      assert.deepEqual(app.state.layerSourceTimestamps, {});
      assert.equal(fields(history.db.prepare('SELECT COUNT(*) AS count FROM layer_snapshots').get()).count, 0);
    }
    app.applyMessage({ ...base, revision: 'r5', sourceTimestampKnown: false, sourceTimestamp: 1_700_000_000_300, receivedAt: 1_700_000_000_400 }, 'hypertracker');
    assert.equal(app.state.layerMeta.liquidation.sourceTimestamp, null);
    assert.equal(app.state.sourceTimestamps.hypertracker, undefined);
    assert.equal(app.state.sourceTimestamps['hypertracker:layerSnapshot'], undefined);
    assert.equal(fields(history.db.prepare('SELECT COUNT(*) AS count FROM layer_snapshots').get()).count, 0);
    app.applyMessage({ ...base, revision: 'r6', sourceTimestamp: 1_700_000_000_300, receivedAt: 1_700_000_000_500 }, 'hypertracker');
    assert.equal(app.state.sourceTimestamps.hypertracker, 1_700_000_000_300);
    assert.equal(app.state.sourceTimestamps['hypertracker:layerSnapshot'], 1_700_000_000_300);
    assert.equal(fields(history.db.prepare('SELECT COUNT(*) AS count FROM layer_snapshots').get()).count, 1);
  } finally { await app.close(); }
});

test('live candle restoration protects configured feeds before manager specs exist and restores the newest rows', async () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  const now = Date.now();
  const interval = String(process.env.CANDLE_INTERVAL ?? '1m');
  const activeId = 'binance:ACTIVEUSDT:spot';
  const rowCount = 5_201;
  const restoredCount = 2_000;
  const firstStart = now - (rowCount + 60) * 60_000;
  const otherIds = Array.from({ length: 64 }, (_, index) => `binance:RESTORE${String(index).padStart(2, '0')}USDT`);
  const markets = [activeId, ...otherIds].map((instrumentId) => ({ instrumentId, id: instrumentId, venue: 'binance', symbol: instrumentId }));
  let app: ReturnType<typeof createLocalServer> | undefined;
  try {
    history.recordState({ asOf: now, markPrice: 0, markInstrumentId: 'hyperliquid:MARK-PERP', markObserved: false, liveMode: true, dataMode: 'live', markets });
    for (let index = 0; index < rowCount; index += 1) {
      const start = firstStart + index * 60_000;
      assert.equal(history.recordCandle({ kind: 'candle', instrumentId: activeId, interval, start, end: start + 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 1, sourceTimestamp: start + 60_000, receivedAt: start + 60_100, closed: true, source: 'live', quality: 'native' }), true);
    }
    const recentStart = now - 5 * 60_000;
    for (let index = 0; index < otherIds.length; index += 1) {
      const instrumentId = otherIds[index];
      const start = recentStart;
      assert.equal(history.recordCandle({ kind: 'candle', instrumentId, interval, start, end: start + 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 1, sourceTimestamp: start + 60_000, receivedAt: start + 60_100, closed: true, source: 'live', quality: 'native' }), true);
    }

    app = createLocalServer({ liveMode: true, persistFixture: false, restoreState: true, activeCandleInstrumentIds: [activeId], quota: new QuotaLedger(), history });
    assert.equal(Object.keys(app.state.candles).length, 64);
    assert.equal(app.state.candles[activeId]?.length, restoredCount);
    assert.equal(app.state.candles[activeId][0].start, firstStart + (rowCount - restoredCount) * 60_000);
    assert.equal(app.state.candles[otherIds[0]], undefined);
    assert.ok(app.state.candles[defined(otherIds.at(-1))]);
  } finally { if (app) await app.close(); else history.close(); }
});

test('depth market registration preserves unknown provider tick metadata', () => {
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  try {
    app.applyMessage({ kind: 'depthSnapshot', instrumentId: 'bybit:1000SHIBUSDT', marketType: 'perpetual', market: { venue: 'bybit', nativeSymbol: '1000SHIBUSDT', base: '1000SHIB', quote: 'USDT', tickSize: null, quantityUnit: 'base' }, sequence: 1, sourceTimestamp: 1, receivedAt: 2, complete: true, coverage: 'partial', bids: [{ price: 0.00001234, amount: 2 }], asks: [{ price: 0.00001289, amount: 3 }] }, 'bybit');
    const market = app.state.markets.find((item) => item.instrumentId === 'bybit:1000SHIBUSDT');
    assert.ok(market); assert.equal(market.tickSize, null); assert.equal(market.base, '1000SHIB');
  } finally { app.close(); }
});

test('retained Binance deltas preserve the initial partial coverage boundary', () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  // The book holds 2,001 levels per side, one more than this limit keeps (the default limit is far larger).
  const savedLimit = process.env.BOOK_LEVEL_LIMIT; process.env.BOOK_LEVEL_LIMIT = '2000';
  const app = createLocalServer({ quota: new QuotaLedger(), history });
  if (savedLimit === undefined) delete process.env.BOOK_LEVEL_LIMIT; else process.env.BOOK_LEVEL_LIMIT = savedLimit;
  const bids = Array.from({ length: 2_001 }, (_, index) => ({ price: 10_000 - index, amount: 1 }));
  const asks = Array.from({ length: 2_001 }, (_, index) => ({ price: 10_001 + index, amount: 1 }));
  try {
    app.applyMessage({
      kind: 'depthSnapshot', instrumentId: 'binance:BTCUSDT', sequence: 1, sourceTimestamp: 1, receivedAt: 2,
      complete: true, coverage: 'partial', resolution: 'native', units: 'base',
      sourceLevelCount: { bids: 2_001, asks: 2_001 },
      coverageBounds: { bids: { min: 8_000, max: 10_000 }, asks: { min: 10_001, max: 12_001 } }, bids, asks,
    }, 'binance');
    app.applyMessage({ kind: 'depthDelta', instrumentId: 'binance:BTCUSDT', sequence: 2, previousSequence: 1, sourceTimestamp: 2, receivedAt: 3, bids: [{ price: 1, amount: 5 }], asks: [{ price: 20_000, amount: 5 }] }, 'binance');
    const book = app.state.books['binance:BTCUSDT'];
    assert.equal(book.complete, true);
    assert.equal(book.coverage, 'partial');
    assert.deepEqual(book.sourceLevelCount, { bids: 2_001, asks: 2_001 });
    assert.deepEqual(book.coverageBounds, { bids: { min: 8_000, max: 10_000 }, asks: { min: 10_001, max: 12_001 } });
    assert.equal(book.retentionTruncated, true);
    assert.ok(numeric(fields(fields(book.observedBounds).bids).min) > 1);
    assert.ok(numeric(fields(fields(book.observedBounds).asks).max) < 20_000);
  } finally { app.close(); }
});

test('retained far Binance deltas widen observed rows without claiming full depth', () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  const app = createLocalServer({ quota: new QuotaLedger(), history });
  try {
    app.applyMessage({
      kind: 'depthSnapshot', instrumentId: 'binance:BTCUSDT', sequence: 1, sourceTimestamp: 1, receivedAt: 2,
      complete: true, coverage: 'partial', resolution: 'native', units: 'base',
      sourceLevelCount: { bids: 100, asks: 100 },
      coverageBounds: { bids: { min: 90, max: 100 }, asks: { min: 101, max: 110 } },
      bids: [{ price: 100, amount: 1 }, { price: 99, amount: 1 }],
      asks: [{ price: 101, amount: 1 }, { price: 102, amount: 1 }],
    }, 'binance');
    app.applyMessage({ kind: 'depthDelta', instrumentId: 'binance:BTCUSDT', sequence: 2, previousSequence: 1, sourceTimestamp: 2, receivedAt: 3, bids: [{ price: 80, amount: 5 }], asks: [{ price: 120, amount: 5 }] }, 'binance');
    const book = app.state.books['binance:BTCUSDT'];
    assert.equal(book.complete, true);
    assert.equal(book.coverage, 'partial');
    assert.deepEqual(book.sourceLevelCount, { bids: 100, asks: 100 });
    assert.deepEqual(book.coverageBounds, { bids: { min: 90, max: 100 }, asks: { min: 101, max: 110 } });
    assert.deepEqual(book.observedBounds, { bids: { min: 80, max: 100 }, asks: { min: 101, max: 120 } });
    assert.equal(book.retentionTruncated, true);
  } finally { app.close(); }
});

test('active Hyperliquid representation replacement retires obsolete coarse variants', () => {
  const app = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  try {
    const message = (resolutionKey: string, bid: number, nSigFigs?: number) => ({ kind: 'depthSnapshot', instrumentId: 'hyperliquid:BTC-PERP', sequence: bid, sourceTimestamp: bid * 60_000, receivedAt: bid * 60_000 + 1, complete: true, resolution: resolutionKey === 'native' ? 'native' : 'coarse', resolutionKey, bookKey: `hyperliquid:BTC-PERP|${resolutionKey}`, nSigFigs, bids: [{ price: bid, amount: 1 }], asks: [{ price: bid + 1, amount: 1 }] });
    app.applyMessage(message('native', 100), 'hyperliquid');
    app.applyMessage(message('sig:2', 200, 2), 'hyperliquid');
    app.setActiveBookKeys('hyperliquid:BTC-PERP', ['hyperliquid:BTC-PERP|native', 'hyperliquid:BTC-PERP|sig:3']);
    assert.equal(app.state.booksByKey['hyperliquid:BTC-PERP|sig:2'], undefined);
    assert.equal(app.state.books['hyperliquid:BTC-PERP'].bookKey, 'hyperliquid:BTC-PERP|native');
    app.applyMessage(message('sig:2', 250, 2), 'hyperliquid');
    assert.equal(app.state.booksByKey['hyperliquid:BTC-PERP|sig:2'], undefined);
    app.applyMessage(message('sig:3', 300, 3), 'hyperliquid');
    assert.equal(app.state.books['hyperliquid:BTC-PERP'].bookKey, 'hyperliquid:BTC-PERP|sig:3');
    app.setActiveBookKeys('hyperliquid:BTC-PERP', ['hyperliquid:BTC-PERP|native']);
    assert.equal(app.state.booksByKey['hyperliquid:BTC-PERP|sig:3'], undefined);
    assert.equal(app.state.books['hyperliquid:BTC-PERP'].bookKey, 'hyperliquid:BTC-PERP|native');
  } finally { app.close(); }
});

test('active book selection status events are admitted without retaining their full control payload', () => {
  const app = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  try {
    const hlInstrumentId = 'hyperliquid:ETH-PERP';
    const hlBookKey = `${hlInstrumentId}|sig:3`;
    assert.equal(app.applyActiveBookSelectionStatus({ id: 'hl-book-set', instrumentId: hlInstrumentId, state: 'live', activeBookKeys: [hlBookKey], resolutionKeys: ['sig:3'] }), true);
    assert.deepEqual(app.state.activeBookKeys[hlInstrumentId], [hlBookKey]);
    assert.equal(app.state.feedStatuses['hl-book-set'], undefined);

    const binanceInstrumentId = 'binance:ETHUSDT';
    const binanceBookKey = `${binanceInstrumentId}|native`;
    assert.equal(app.applyActiveBookSelectionStatus({ id: 'active-book-set', state: 'live', activeBookSets: { [binanceInstrumentId]: [binanceBookKey] } }), true);
    assert.deepEqual(app.state.activeBookKeys[binanceInstrumentId], [binanceBookKey]);
    assert.equal(app.state.feedStatuses['active-book-set'], undefined);
    assert.equal(app.applyActiveBookSelectionStatus({ id: 'binance-depth', state: 'live' }), false);
  } finally { app.close(); }
});

test('active book set eviction removes preexisting untracked venue books', () => {
  const app = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  try {
    const binance = { instrumentId: 'binance:BTCUSDT', bookKey: 'binance:BTCUSDT|native', complete: true, bids: [], asks: [] };
    const bybit = { instrumentId: 'bybit:BTCUSDT', bookKey: 'bybit:BTCUSDT|native', complete: true, bids: [], asks: [] };
    app.state.books = { [binance.instrumentId]: binance, [bybit.instrumentId]: bybit };
    app.state.booksByKey = { [binance.bookKey]: binance, [bybit.bookKey]: bybit };
    app.setActiveBookSets({});
    assert.deepEqual(app.state.books, {});
    assert.deepEqual(app.state.booksByKey, {});
    assert.deepEqual(app.state.activeBookKeys, {});
    assert.equal(app.applyMessage({ kind: 'depthSnapshot', instrumentId: binance.instrumentId, bookKey: binance.bookKey, complete: true, sequence: 1, receivedAt: 1, sourceTimestamp: 1, bids: [{ price: 100, amount: 1 }], asks: [] }, 'binance'), false);
    assert.equal(app.state.booksByKey[binance.bookKey], undefined);
  } finally { app.close(); }
});

test('retired active-book symbols leave no tombstones and fence late direct snapshots and deltas', () => {
  const app = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  const instrumentId = 'binance:CHURNUSDT';
  const bookKey = `${instrumentId}|native`;
  const snapshot = (sequence: number) => ({ kind: 'depthSnapshot', instrumentId, bookKey, sequence, sourceTimestamp: sequence, receivedAt: sequence, complete: true, bids: [{ price: 100, amount: sequence }], asks: [] });
  try {
    app.setActiveBookSets({ [instrumentId]: [bookKey] });
    assert.equal(app.applyMessage(snapshot(1), 'binance'), true);
    assert.equal(app.state.booksByKey[bookKey].sequence, 1);

    app.setActiveBookSets({});
    assert.deepEqual(app.state.activeBookKeys, {});
    assert.equal(app.applyMessage(snapshot(2), 'binance'), false);
    assert.equal(app.applyMessage({ kind: 'depthDelta', instrumentId, bookKey, sequence: 2, previousSequence: 1, receivedAt: 2, sourceTimestamp: 2, bids: [{ price: 100, amount: 2 }], asks: [] }, 'binance'), false);
    assert.equal(app.state.booksByKey[bookKey], undefined);

    for (let index = 0; index < 64; index += 1) app.setActiveBookSets({ [`binance:RETIRED${index}USDT`]: [] });
    assert.deepEqual(app.state.activeBookKeys, {});
    assert.equal(app.applyMessage(snapshot(3), 'binance'), false);

    app.setActiveBookSets({ [instrumentId]: [bookKey] });
    assert.equal(app.applyMessage(snapshot(4), 'binance'), true);
    assert.equal(fields(fields(app.state.booksByKey)[bookKey]).sequence, 4);
  } finally { app.close(); }
});

test('live mode anchors the first mark and does not cross through an unobserved gap', () => {
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  try {
    app.applyMessage({ kind: 'layerSnapshot', layer: 'takeProfit', instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: 1, receivedAt: 1, revision: '1', complete: true, levels: [{ id: 'tp-gap', layer: 'takeProfit', side: 'sell', price: 79000, amount: 1, notionalUsd: 1, active: true }] }, 'hypertracker');
    app.applyMessage({ kind: 'price', instrumentId: 'hyperliquid:BTC-PERP', price: 78000, receivedAt: 2 }, 'hyperliquid');
    assert.equal(app.state.layers.takeProfit[0].active, true);
    app.applyMessage({ kind: 'price', instrumentId: 'hyperliquid:BTC-PERP', price: 80000, receivedAt: 3 }, 'hyperliquid');
    assert.equal(app.state.layers.takeProfit[0].active, false);
  } finally { app.close(); }
});

test('restart restores the latest state snapshot and newer provider snapshots reconcile levels', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-history-')); const filePath = path.join(directory, 'history.sqlite');
  let first: ReturnType<typeof createLocalServer> | undefined; let second: ReturnType<typeof createLocalServer> | undefined;
  try {
    first = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath }) });
    first.applyMessage({ kind: 'price', instrumentId: 'hyperliquid:BTC-PERP', price: 79000, receivedAt: 10 }, 'hyperliquid');
    assert.equal(defined(first.state.layers.takeProfit.find(level => level.id === 'tp-sell-79000')).active, false);
    await first.close(); first = undefined;
    second = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath }), restoreState: true });
    assert.equal(second.state.markPrice, 79000);
    assert.equal(defined(second.state.layers.takeProfit.find(level => level.id === 'tp-sell-79000')).active, false);
    second.applyMessage({ kind: 'layerSnapshot', layer: 'takeProfit', instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: 20, receivedAt: 20, revision: '2', complete: true, levels: [{ id: 'tp-sell-79000', layer: 'takeProfit', side: 'sell', price: 79000, amount: 40, notionalUsd: 3_160_000, active: true }] }, 'hypertracker');
    assert.equal(defined(second.state.layers.takeProfit.find(level => level.id === 'tp-sell-79000')).active, true);
    second.applyMessage({ kind: 'layerSnapshot', layer: 'takeProfit', instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: 19, receivedAt: 19, revision: '1', complete: true, levels: [] }, 'hypertracker');
    assert.equal(second.state.layers.takeProfit.length, 1);
  } finally { await first?.close(); await second?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('live restart fences restored provider state until fresh observations arrive', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-live-restart-fence-')); const filePath = path.join(directory, 'history.sqlite');
  let first; let second;
  try {
    first = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath }) });
    first.applyMessage({ kind: 'price', instrumentId: 'hyperliquid:BTC-PERP', price: 81234, sourceTimestamp: 100, receivedAt: 100 }, 'hyperliquid');
    first.applyMessage({ kind: 'depthSnapshot', instrumentId: 'hyperliquid:BTC-PERP', sequence: 99, sourceTimestamp: 101, receivedAt: 101, complete: true, bids: [{ price: 81200, amount: 2 }], asks: [{ price: 81250, amount: 3 }] }, 'hyperliquid');
    await first.close(); first = undefined;

    second = createLocalServer({ liveMode: true, persistFixture: false, restoreState: true, quota: new QuotaLedger(), history: new HistoryStore({ filePath }) });
    assert.equal(second.state.dataMode, 'live');
    assert.equal(second.state.asOf, 0);
    assert.equal(second.state.markPrice, 0);
    assert.equal(second.state.markObserved, false);
    assert.equal(defined(second.state.markContinuity).state, 'reanchor');
    assert.equal(second.state.statuses.hyperliquid.state, 'unavailable');
    assert.deepEqual(second.state.feedStatuses, {});
    assert.deepEqual(second.state.layers, { liquidation: [], stopLoss: [], takeProfit: [] });
    assert.deepEqual(second.state.layerMeta, {});
    assert.deepEqual(second.state.layerRevisions, {});
    assert.deepEqual(second.state.layerSourceTimestamps, {});
    assert.deepEqual(second.state.oi, []);
    assert.deepEqual(second.state.trades, []);
    assert.deepEqual(second.state.sourceTimestamps, {});
    for (const book of Object.values(second.state.books)) {
      assert.equal(book.complete, false);
      assert.equal(book.gap, false);
      assert.equal(book.sequence, null);
      assert.equal(book.coverage, 'unknown');
      assert.deepEqual(book.coverageBounds, null);
      assert.deepEqual(book.observedBounds, { bids: null, asks: null });
      assert.deepEqual(book.sourceLevelCount, { bids: 0, asks: 0 });
      assert.deepEqual(book.retainedLevelCount, { bids: 0, asks: 0 });
      assert.equal(book.retentionTruncated, false);
      assert.deepEqual(book.levelMetadata, { bids: {}, asks: {} });
      assert.deepEqual(book.bids, []);
      assert.deepEqual(book.asks, []);
    }
    for (const book of Object.values(second.state.booksByKey)) {
      assert.equal(book.complete, false);
      assert.equal(book.gap, false);
      assert.equal(book.sequence, null);
      assert.equal(book.coverage, 'unknown');
      assert.deepEqual(book.coverageBounds, null);
      assert.deepEqual(book.observedBounds, { bids: null, asks: null });
      assert.deepEqual(book.sourceLevelCount, { bids: 0, asks: 0 });
      assert.deepEqual(book.retainedLevelCount, { bids: 0, asks: 0 });
      assert.equal(book.retentionTruncated, false);
      assert.deepEqual(book.levelMetadata, { bids: {}, asks: {} });
      assert.deepEqual(book.bids, []);
      assert.deepEqual(book.asks, []);
    }
    assert.ok(Object.values(second.state.candles).every((rows) => Array.isArray(rows) && rows.length === 0));
  } finally { await first?.close(); await second?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('provider response captured before a local crossing cannot resurrect the level', () => {
  const app = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  try {
    app.applyMessage({ kind: 'layerSnapshot', layer: 'takeProfit', instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: 20, receivedAt: 20, revision: '2', complete: true, levels: [{ id: 'tp-cross-later', layer: 'takeProfit', side: 'sell', price: 80000, amount: 1, notionalUsd: 100, active: true }] }, 'hypertracker');
    app.applyMessage({ kind: 'price', instrumentId: 'hyperliquid:BTC-PERP', price: 81000, receivedAt: 30 }, 'hyperliquid');
    assert.equal(defined(app.state.layers.takeProfit.find(level => level.id === 'tp-cross-later')).active, false);
    app.applyMessage({ kind: 'layerSnapshot', layer: 'takeProfit', instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: 25, receivedAt: 40, revision: '3', complete: true, levels: [{ id: 'tp-cross-later', layer: 'takeProfit', side: 'sell', price: 80000, amount: 9, notionalUsd: 900, active: true }] }, 'hypertracker');
    assert.equal(defined(app.state.layers.takeProfit.find(level => level.id === 'tp-cross-later')).active, false);
  } finally { app.close(); }
});

test('all provider layers preserve both directional local crossings until a newer authoritative snapshot', () => {
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  try {
    const instrumentId = 'hyperliquid:BTC-PERP';
    const anchor = Number(app.state.markPrice) > 0 ? Number(app.state.markPrice) : 77_300;
    app.applyMessage({ kind: 'price', instrumentId, price: anchor, sourceTimestamp: Date.now(), receivedAt: Date.now() }, 'hyperliquid');
    const cases = [
      ['liquidation', 'long', 'short'],
      ['stopLoss', 'sell', 'buy'],
      ['takeProfit', 'buy', 'sell'],
    ];
    cases.forEach(([layer, downSide, upSide], index) => {
      const source = Date.now() + index * 10_000;
      const downId = `m516-server-${layer}-down`;
      const upId = `m516-server-${layer}-up`;
      const levels = [
        { id: downId, layer, side: downSide, price: anchor - 200, amount: 1, notionalUsd: 100, active: true },
        { id: upId, layer, side: upSide, price: anchor + 200, amount: 1, notionalUsd: 200, active: true },
      ];
      const snapshot = (sourceTimestamp: number, revision: string | number) => ({ kind: 'layerSnapshot', layer, instrumentId, sourceTimestamp, receivedAt: sourceTimestamp, revision: String(revision), complete: true, levels });
      app.applyMessage(snapshot(source, 1), 'hypertracker');
      app.applyMessage({ kind: 'price', instrumentId, price: anchor - 500, sourceTimestamp: source + 1, receivedAt: source + 1 }, 'hyperliquid');
      assert.equal(defined(app.state.layers[layer].find((level) => level.id === downId)).active, false, `${layer} downward crossing`);
      app.applyMessage(snapshot(source - 1, 0), 'hypertracker');
      assert.equal(defined(app.state.layers[layer].find((level) => level.id === downId)).active, false, `${layer} stale downward snapshot`);
      app.applyMessage(snapshot(source + 2, 2), 'hypertracker');
      assert.equal(defined(app.state.layers[layer].find((level) => level.id === downId)).active, true, `${layer} newer downward restoration`);
      app.applyMessage({ kind: 'price', instrumentId, price: anchor, sourceTimestamp: source + 3, receivedAt: source + 3 }, 'hyperliquid');
      app.applyMessage({ kind: 'price', instrumentId, price: anchor + 500, sourceTimestamp: source + 4, receivedAt: source + 4 }, 'hyperliquid');
      assert.equal(defined(app.state.layers[layer].find((level) => level.id === upId)).active, false, `${layer} upward crossing`);
      app.applyMessage(snapshot(source + 5, 3), 'hypertracker');
      assert.equal(defined(app.state.layers[layer].find((level) => level.id === upId)).active, true, `${layer} newer upward restoration`);
    });
  } finally { app.close(); }
});

test('unprovenanced provider refresh preserves a locally crossed level', async () => {
  const app = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  app.setProvider({ request: async () => ({ levels: [{ id: 'liquidation-BTC-short-80000-single-single', price: 80000, notionalUsd: 100, side: 'short' }] }) });
  try {
    app.applyMessage({ kind: 'layerSnapshot', layer: 'liquidation', instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: 20, receivedAt: 20, revision: '2', complete: false, levels: [{ id: 'liquidation-BTC-short-80000-single-single', layer: 'liquidation', side: 'short', price: 80000, amount: 1, notionalUsd: 100, active: true }] }, 'hypertracker');
    app.applyMessage({ kind: 'price', instrumentId: 'hyperliquid:BTC-PERP', price: 81000, receivedAt: 30 }, 'hyperliquid');
    await app.refreshProvider('heatmap');
    assert.equal(defined(app.state.layers.liquidation.find(level => level.id === 'liquidation-BTC-short-80000-single-single')).active, false);
  } finally { app.close(); }
});

test('stopping an in-flight provider poll prevents rescheduling', async () => {
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger({ limit: 50 }), history: new HistoryStore({ filePath: ':memory:' }) });
  let calls = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  app.setProvider({ request: async () => { calls += 1; await pending; return { levels: [], complete: true, sourceTimestamp: Date.now(), revision: String(calls), units: 'USD' }; } });
  try {
    assert.equal(app.startProviderPolling(5, 'heatmap', { initialDelayMs: 0 }), true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(calls, 1);
    app.stopProviderPolling();
    defined(release)();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls, 1);
  } finally { release?.(); app.stopProviderPolling(); await app.close(); }
});

test('duplicate provider polling start is rejected while the current request is in flight', async () => {
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger({ limit: 50 }), history: new HistoryStore({ filePath: ':memory:' }) });
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  app.setProvider({ request: async () => { await pending; return { levels: [], complete: true, sourceTimestamp: Date.now(), revision: 'one', units: 'USD' }; } });
  try {
    assert.equal(app.startProviderPolling(5, 'heatmap', { initialDelayMs: 0 }), true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(app.startProviderPolling(5, 'heatmap', { initialDelayMs: 0 }), false);
  } finally { release?.(); app.stopProviderPolling(); await app.close(); }
});

test('opaque numeric provider revisions use numeric suffix ordering', () => {
  const app = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  try {
    app.applyMessage({ kind: 'layerSnapshot', layer: 'liquidation', instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: null, receivedAt: 1, revision: 'r9', complete: true, provenanceKnown: true, sourceTimestampKnown: false, revisionKnown: true, levels: [{ id: 'rev', price: 80000, notionalUsd: 9, side: 'short', active: true }] }, 'hypertracker');
    app.applyMessage({ kind: 'layerSnapshot', layer: 'liquidation', instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: null, receivedAt: 2, revision: 'r10', complete: true, provenanceKnown: true, sourceTimestampKnown: false, revisionKnown: true, levels: [{ id: 'rev', price: 80000, notionalUsd: 10, side: 'short', active: true }] }, 'hypertracker');
    assert.equal(app.state.layers.liquidation[0].notionalUsd, 10);
  } finally { app.close(); }
});

test('fixture startup does not restore a live snapshot', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-mode-')); const filePath = path.join(directory, 'history.sqlite');
  try {
    const live = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath }) });
    live.applyMessage({ kind: 'price', instrumentId: 'hyperliquid:BTC-PERP', price: 81234, receivedAt: 10 }, 'hyperliquid');
    live.close();
    const fixture = createLocalServer({ liveMode: false, persistFixture: true, restoreState: true, quota: new QuotaLedger(), history: new HistoryStore({ filePath }) });
    assert.equal(fixture.state.dataMode, 'fixture');
    assert.equal(fixture.state.markPrice, 77300);
    fixture.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
