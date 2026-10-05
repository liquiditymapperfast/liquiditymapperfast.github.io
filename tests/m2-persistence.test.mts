import { defined, fields, list, numeric, textValue, injectArrayFixture } from './server-test-helpers.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QuotaLedger } from '../src/core/quota.mts';
import { HistoryStore } from '../src/server/history.mts';

test('native closed candles, observed OI, and quota survive restart without raw duplication', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-m2-persistence-'));
  const historyPath = path.join(directory, 'history.sqlite');
  const quotaPath = path.join(directory, 'quota.json');
  const candleStart = 1_700_000_000_000;
  const candle = {
    instrumentId: 'hyperliquid:BTC-PERP', interval: '1m', start: candleStart,
    end: candleStart + 60_000, open: 70_000, high: 70_120, low: 69_950,
    close: 70_080, volume: 12, sourceTimestamp: candleStart + 60_000,
    closed: true, quality: 'native', source: 'live',
    providerPayload: { rows: Array.from({ length: 2_000 }, () => 'must-not-persist') },
  };
  const oiStart = candleStart + 61_000;
  const forming = { ...candle, closed: false, sourceTimestamp: candleStart + 30_000 };
  const firstQuotaAt = Date.now();
  try {
    const first = new HistoryStore({ filePath: historyPath });
    try {
      assert.equal(first.recordCandle(forming, { receivedAt: firstQuotaAt, source: 'live' }), false);
      assert.equal(first.recordCandle(candle, { receivedAt: firstQuotaAt, source: 'live' }), true);
      assert.equal(fields(first.db.prepare('SELECT COUNT(*) AS count FROM candle_samples').get()).count, 1);
      const storedPayload = textValue(fields(first.db.prepare('SELECT payload_json AS payload FROM candle_samples').get()).payload);
      assert.ok(Buffer.byteLength(storedPayload) < 1_000);
      assert.doesNotMatch(storedPayload, /must-not-persist/);

      first.recordOi({ instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: oiStart + 5_000, receivedAt: oiStart + 5_010, base: 100, quote: 7_000_000, quality: 'native' });
      first.recordOi({ instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: oiStart + 5_000, receivedAt: oiStart + 5_020, base: 101, quote: 7_070_000, quality: 'native' });
      first.recordOi({ instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: null, observationTimestamp: oiStart + 6_000, receivedAt: oiStart + 6_010, base: 102, quality: 'sampled' });
      first.recordOi({ instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: oiStart + 125_000, receivedAt: oiStart + 125_010, base: 104, quote: 7_200_000, quality: 'native' });
      assert.equal(fields(first.db.prepare('SELECT COUNT(*) AS count FROM oi_samples').get()).count, 0);
      assert.equal(fields(first.db.prepare('SELECT COUNT(*) AS count FROM oi_bars').get()).count, 1);
      const oiColumns = new Set(first.db.prepare('PRAGMA table_info(oi_bars)').all().map((row) => String(fields(row).name)));
      assert.equal(oiColumns.has('observations_json'), false);
      assert.equal(oiColumns.has('first_observation_timestamp'), true);
      const liveOiBars = first.listOi('hyperliquid:BTC-PERP');
      assert.equal(liveOiBars.length, 2);
      assert.deepEqual({ open: liveOiBars[0].open, high: liveOiBars[0].high, low: liveOiBars[0].low, close: liveOiBars[0].close, samples: liveOiBars[0].samples }, { open: 101, high: 102, low: 101, close: 102, samples: 2 });
    } finally {
      first.close();
    }

    const second = new HistoryStore({ filePath: historyPath });
    try {
      const restoredCandles = second.listCandles('hyperliquid:BTC-PERP', { interval: '1m', from: candleStart, to: candleStart + 60_001 });
      const restoredOi = second.listOi('hyperliquid:BTC-PERP');
      assert.equal(restoredCandles.length, 1);
      assert.equal(restoredCandles[0].closed, true);
      assert.equal(restoredCandles[0].source, 'live');
      assert.equal(restoredOi.length, 2);
      assert.deepEqual({ open: restoredOi[0].open, high: restoredOi[0].high, low: restoredOi[0].low, close: restoredOi[0].close, samples: restoredOi[0].samples, quoteOpen: restoredOi[0].quoteOpen, quoteClose: restoredOi[0].quoteClose }, { open: 101, high: 102, low: 101, close: 102, samples: 2, quoteOpen: 7_070_000, quoteClose: null });
      assert.equal(restoredOi[0].timeBasis, 'mixed');
      assert.equal(restoredOi[1].close, 104);
      assert.equal(restoredOi[1].sourceTimestamp, oiStart + 125_000);
      assert.equal(restoredOi[1].samples, 1);
      assert.equal(restoredOi[0].sourceTimestamp, oiStart + 5_000);
      assert.equal(numeric(restoredOi[0].start) + 120_000, restoredOi[1].start);
      assert.equal(second.recordOi({ instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: oiStart + 5_000, receivedAt: oiStart + 30_000, base: 999, quality: 'native' }), false);
      assert.equal(second.recordOi({ instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: oiStart + 20_000, receivedAt: oiStart + 30_001, base: 103, quote: 7_100_000, quality: 'native' }), true);
      const sealedUpdate = second.listOi('hyperliquid:BTC-PERP')[0];
      assert.deepEqual({ open: sealedUpdate.open, high: sealedUpdate.high, low: sealedUpdate.low, close: sealedUpdate.close, samples: sealedUpdate.samples }, { open: 101, high: 103, low: 101, close: 103, samples: 3 });
      assert.equal(second.recordCandle({ ...candle, close: 70_081, sourceTimestamp: candleStart + 59_000 }, { receivedAt: firstQuotaAt + 1 }), false);
      assert.equal(fields(second.db.prepare('SELECT COUNT(*) AS count FROM candle_samples').get()).count, 1);
    } finally {
      second.close();
    }

    const firstQuota = new QuotaLedger({ limit: 20, filePath: quotaPath });
    assert.equal(firstQuota.spend(7, 'snapshot', firstQuotaAt), true);
    const secondQuota = new QuotaLedger({ limit: 20, filePath: quotaPath });
    assert.equal(secondQuota.snapshot(firstQuotaAt + 60_000).used, 7);
    assert.equal(secondQuota.snapshot(firstQuotaAt + 60_000).remaining, 13);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('OI bars sort out-of-order observations and retain a bounded pending set', () => {
  const history = new HistoryStore({ filePath: ':memory:', maxPendingOiBars: 2 });
  try {
    const start = Math.floor(1_700_100_000_000 / 60_000) * 60_000;
    history.recordOi({ instrumentId: 'order:BTC', sourceTimestamp: start + 50_000, receivedAt: start + 50_001, base: 200, quality: 'native' });
    history.recordOi({ instrumentId: 'order:BTC', sourceTimestamp: start + 10_000, receivedAt: start + 10_001, base: 100, quality: 'native' });
    history.recordOi({ instrumentId: 'order:BTC', sourceTimestamp: start + 20_000, receivedAt: start + 20_001, base: 150, quality: 'native' });
    const [row] = history.listOi('order:BTC');
    assert.deepEqual({ open: row.open, high: row.high, low: row.low, close: row.close, samples: row.samples }, { open: 100, high: 200, low: 100, close: 200, samples: 3 });
    for (let index = 0; index < 6; index += 1) history.recordOi({ instrumentId: `order:${index}`, sourceTimestamp: start + index * 60_000, receivedAt: start + index * 60_000 + 1, base: index + 1, quality: 'native' });
    const diagnostics = history.retentionBudget().oiBars;
    assert.ok(diagnostics.pendingRows <= 2);
    assert.ok(diagnostics.droppedPendingRows >= 1);
  } finally { history.close(); }
});

test('OI flush keeps pending rows after a transaction failure and retries them', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-oi-flush-'));
  const filePath = path.join(directory, 'history.sqlite');
  const history = new HistoryStore({ filePath });
  const blocker = new DatabaseSync(filePath);
  try {
    const start = 1_700_200_000_000;
    history.recordOi({ instrumentId: 'rollback:BTC', sourceTimestamp: start, receivedAt: start + 1, base: 10, quality: 'native' });
    blocker.exec('BEGIN IMMEDIATE');
    assert.equal(history.flushOiBars({ force: true }), 0);
    assert.equal(history.retentionBudget().oiBars.pendingRows, 1);
    assert.equal(history.retentionBudget().oiBars.writes.failedWrites, 1);
    blocker.exec('ROLLBACK');
    assert.equal(history.flushOiBars({ force: true }), 1);
    assert.equal(history.retentionBudget().oiBars.pendingRows, 0);
    assert.equal(fields(history.db.prepare('SELECT COUNT(*) AS count FROM oi_bars').get()).count, 1);
  } finally {
    try { blocker.close(); } catch {}
    history.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reopened OI bars keep their sealed prefix while the RAM correction window stays bounded', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-oi-correction-window-'));
  const filePath = path.join(directory, 'history.sqlite');
  const intervalMs = 3_600_000;
  const start = Math.floor(1_700_300_000_000 / intervalMs) * intervalMs;
  try {
    const first = new HistoryStore({ filePath, oiBarIntervalMs: intervalMs });
    try {
      first.recordOi({ instrumentId: 'sealed:BTC', sourceTimestamp: start + 1_000, receivedAt: start + 1_001, base: 100, quality: 'native' });
      first.recordOi({ instrumentId: 'sealed:BTC', sourceTimestamp: start + 2_000, receivedAt: start + 2_001, base: 101, quality: 'native' });
      assert.equal(first.flushOiBars({ force: true }), 1);
    } finally { first.close(); }

    const second = new HistoryStore({ filePath, oiBarIntervalMs: intervalMs });
    try {
      // Two post-restart samples must extend the sealed scalar history rather
      // than rebuilding the bar from only the in-memory correction window.
      second.recordOi({ instrumentId: 'sealed:BTC', sourceTimestamp: start + 3_000, receivedAt: start + 3_001, base: 102, quality: 'native' });
      second.recordOi({ instrumentId: 'sealed:BTC', sourceTimestamp: start + 4_000, receivedAt: start + 4_001, base: 103, quality: 'native' });
      let [bar] = second.listOi('sealed:BTC');
      assert.deepEqual({ open: bar.open, high: bar.high, low: bar.low, close: bar.close, samples: bar.samples }, { open: 100, high: 103, low: 100, close: 103, samples: 4 });

      for (let index = 0; index < 300; index += 1) {
        const base = index === 100 ? 10_000 : (index === 200 ? 50 : 200 + index);
        second.recordOi({ instrumentId: 'sealed:BTC', sourceTimestamp: start + 5_000 + index * 100, receivedAt: start + 5_001 + index * 100, base, quality: 'native' });
      }
      const pending = second.pendingOiBars.get(`sealed:BTC|${intervalMs}|${start}`);
      assert.ok(pending);
      assert.equal(pending.correctionTruncated, true);
      assert.ok(pending.observations.length <= 256);
      assert.deepEqual({ open: pending.openBase, high: pending.highBase, low: pending.lowBase, close: pending.closeBase, samples: pending.sampleCount }, { open: 100, high: 10_000, low: 50, close: 499, samples: 304 });
      assert.equal(pending.firstObservationTimestamp, start + 1_000);
      assert.equal(pending.lastObservationTimestamp, start + 34_900);

      assert.equal(second.flushOiBars({ force: true }), 1);
      [bar] = second.listOi('sealed:BTC');
      assert.deepEqual({ open: bar.open, high: bar.high, low: bar.low, close: bar.close, samples: bar.samples }, { open: 100, high: 10_000, low: 50, close: 499, samples: 304 });
    } finally { second.close(); }

    const third = new HistoryStore({ filePath, oiBarIntervalMs: intervalMs });
    try {
      const [bar] = third.listOi('sealed:BTC');
      assert.deepEqual({ open: bar.open, high: bar.high, low: bar.low, close: bar.close, samples: bar.samples }, { open: 100, high: 10_000, low: 50, close: 499, samples: 304 });
    } finally { third.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
