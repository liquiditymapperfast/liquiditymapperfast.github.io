import { defined, fields, list, numeric, textValue, fieldMap, injectMapFixture, injectArrayFixture } from './server-test-helpers.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../src/server/history.mts';
import { HISTORY_DEPTH_LEVELS_PER_SIDE } from '../src/core/representation-limits.mts';
import { logicalRetainedBytes } from '../src/core/retained-bytes.mts';

test('SQLite WAL history preserves OI observations and crossing provenance', () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  try {
    const start = 1_700_000_040_000;
    history.recordOi({ instrumentId: 'binance:BTCUSDT', sourceTimestamp: start + 1000, receivedAt: start + 1010, base: 12, quote: 1200, quality: 'native' });
    history.recordOi({ instrumentId: 'binance:BTCUSDT', sourceTimestamp: start + 2000, receivedAt: start + 2010, base: 13, quality: 'native' });
    assert.deepEqual(history.listOi('binance:BTCUSDT'), [{
      instrumentId: 'binance:BTCUSDT', interval: '1m', start, end: start + 60_000,
      observationTimestamp: start, sourceTimestamp: start + 2000, timeBasis: 'exchange', receivedAt: start + 2010,
      base: 13, quote: null, open: 12, high: 13, low: 12, close: 13,
      quoteOpen: 1200, quoteHigh: 1200, quoteLow: 1200, quoteClose: null,
      samples: 2, sampleCount: 2, quality: 'sampled',
    }]);
    history.recordCrossing({ levelId: 'liq-1', observedAt: 3000, layer: 'liquidation', markPrice: 77000, direction: 'down', provisional: true });
    history.recordCrossing({ levelId: 'liq-1', observedAt: 3000, layer: 'liquidation', markPrice: 77000, direction: 'down', provisional: true });
  } finally { history.close(); }
});

test('receipt-timed OI remains distinct without an exchange timestamp', () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  try {
    const start = 1_700_000_000_000;
    for (let i = 1; i <= 100; i += 1) history.recordOi({ instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: null, observationTimestamp: start + 10_000 + i, receivedAt: start + 10_000 + i, base: i, quality: 'sampled' });
    const rows = history.listOi('hyperliquid:BTC-PERP');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sourceTimestamp, null);
    assert.equal(rows[0].timeBasis, 'receipt');
    assert.equal(rows[0].open, 1);
    assert.equal(rows[0].high, 100);
    assert.equal(rows[0].close, 100);
    assert.equal(rows[0].samples, 100);
    history.recordOi({ instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: 0, receivedAt: 20_000, base: 1, quality: 'native' });
    history.recordOi({ instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: -1, receivedAt: 20_001, base: 1, quality: 'native' });
    history.recordOi({ instrumentId: 'hyperliquid:BTC-PERP', sourceTimestamp: null, observationTimestamp: 0, receivedAt: 20_002, base: 1, quality: 'sampled' });
    assert.equal(history.listOi('hyperliquid:BTC-PERP').length, 1);
  } finally { history.close(); }
});

test('old OI rows are migrated or quarantined before they are exposed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-oi-migrate-')); const filePath = path.join(directory, 'history.sqlite');
  const db = new DatabaseSync(filePath);
  db.exec('CREATE TABLE oi_samples (instrument_id TEXT NOT NULL, source_timestamp INTEGER NOT NULL, received_at INTEGER NOT NULL, base REAL NOT NULL, quote REAL, quality TEXT NOT NULL, PRIMARY KEY (instrument_id, source_timestamp));');
  db.prepare('INSERT INTO oi_samples VALUES (?, ?, ?, ?, ?, ?)').run('legacy:bad', 0, 10, 1, null, 'native');
  db.prepare('INSERT INTO oi_samples VALUES (?, ?, ?, ?, ?, ?)').run('legacy:good', 100, 110, 2, null, 'native');
  db.close();
  const history = new HistoryStore({ filePath });
  try {
    assert.deepEqual(history.listOi('legacy:bad'), []);
    assert.equal(history.listOi('legacy:good')[0].sourceTimestamp, 100);
    assert.equal(history.listOi('legacy:good')[0].timeBasis, 'exchange');
    assert.equal(history.listOi('legacy:good')[0].samples, 1);
    assert.equal(fields(history.db.prepare('SELECT COUNT(*) AS count FROM oi_samples_quarantine').get()).count, 1);
  } finally { history.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('state snapshots keep books and other high-frequency arrays out of the singleton', () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  try {
    history.recordState({ asOf: 100, markPrice: 10, markets: [], books: { x: { bids: [[1, 2]] } }, oi: [{ base: 1 }], candles: { x: [] }, trades: [{ price: 1 }], layers: {}, statuses: {} });
    const payload = history.latestState();
    assert.equal(Object.hasOwn(defined(payload), 'books'), false);
    assert.equal(Object.hasOwn(defined(payload), 'oi'), false);
    assert.equal(Object.hasOwn(defined(payload), 'candles'), false);
    assert.equal(Object.hasOwn(defined(payload), 'trades'), false);
    assert.equal(Object.hasOwn(defined(payload), 'layers'), false);
    assert.equal(Object.hasOwn(defined(payload), 'layerSummary'), true);
    assert.ok(JSON.stringify(payload).length < 20_000);
    const many = Array.from({ length: 500 }, (_, index) => ({ instrumentId: `x:${index}`, bids: Array.from({ length: 500 }, () => [1, 1]) }));
    history.recordState({ asOf: 101, markets: many, layers: { liquidation: many }, statuses: { huge: { lastError: 'x'.repeat(10_000) } } });
    const bounded = history.latestState();
    assert.ok(list(defined(bounded).markets).length <= 256);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= 64 * 1024);
    assert.equal(fields(fields(defined(bounded).layerSummary).liquidation).sourceTimestamp, null);
  } finally { history.close(); }
});

test('layer snapshots reject unknown source times', () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  try {
    history.recordLayer({ layer: 'liquidation', instrumentId: 'hyperliquid:BTC-PERP', revision: 'missing-time', sourceTimestamp: null, receivedAt: 1000, complete: false, levels: [] });
    assert.equal(fields(history.db.prepare('SELECT COUNT(*) AS count FROM layer_snapshots').get()).count, 0);
    history.recordLayer({ layer: 'liquidation', instrumentId: 'hyperliquid:BTC-PERP', revision: 'known-time', sourceTimestamp: 2000, receivedAt: 2100, complete: false, levels: [] });
    assert.equal(fields(history.db.prepare('SELECT COUNT(*) AS count FROM layer_snapshots').get()).count, 1);
  } finally { history.close(); }
});

test('busy readers suspend persistence instead of claiming a hard-cap repair', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-budget-busy-'));
  const filePath = path.join(directory, 'history.sqlite');
  const history = new HistoryStore({ filePath, maxCacheBytes: 200_000, maxMainBytes: 160_000, maxWalBytes: 40_000 });
  let reader;
  try {
    for (let index = 1; index <= 100; index += 1) history.recordOi({ instrumentId: 'busy:BTC', sourceTimestamp: index * 60_000, receivedAt: index * 60_000 + 1, base: index, quality: 'sampled' });
    reader = new DatabaseSync(filePath);
    reader.exec('BEGIN; SELECT COUNT(*) FROM oi_bars;');
    const result = history.enforceStorageBudget({ compact: true, maxPasses: 2 });
    assert.equal(result.checkpointBusy, true);
    assert.equal(fields(result).persistenceSuspended, true);
    assert.equal(result.suspensionReason, 'long-reader-or-checkpoint-busy');
    reader.exec('ROLLBACK');
    const recovered = history.enforceStorageBudget({ compact: true, maxPasses: 2 });
    assert.equal(recovered.checkpointBusy, false);
    assert.equal(recovered.persistenceSuspended, false);
    assert.equal(recovered.suspensionReason, null);
  } finally {
    try { reader?.exec('ROLLBACK'); } catch {}
    try { reader?.close(); } catch {}
    history.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('history retained diagnostics grow with the actual in-memory failure payload', () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  try {
    const before = history.retainedDiagnostics();
    assert.strictEqual(history.retainedDiagnostics({ cached: true }), before);
    injectArrayFixture(history.pendingDepthFailures, { instrumentId: 'binance:BTCUSDT', timestamp: 1, payload: '€'.repeat(2_048) });
    const after = history.retainedDiagnostics();
    assert.ok(defined(after.logicalComponents).pendingDepthFailures > defined(before.logicalComponents).pendingDepthFailures);
    assert.ok(defined(after.logicalComponents).diagnosticsCache > defined(before.logicalComponents).diagnosticsCache);
    assert.equal(defined(after.logicalComponents).diagnosticsCache, logicalRetainedBytes(history.retainedDiagnosticsCache));
    assert.ok(defined(after.logicalBytes) > defined(before.logicalBytes));
    assert.equal(after.logicalBytes, Object.values(defined(after.logicalComponents)).reduce((sum, bytes) => sum + bytes, 0));
    assert.ok(defined(history.retainedDiagnostics({ cached: true }).logicalBytes) > defined(before.logicalBytes));
  } finally { history.close(); }
});

test('legacy positive OI promotion is bounded across multiple migration batches', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-oi-batch-')); const filePath = path.join(directory, 'history.sqlite');
  const db = new DatabaseSync(filePath);
  db.exec('CREATE TABLE oi_samples (instrument_id TEXT NOT NULL, source_timestamp INTEGER NOT NULL, received_at INTEGER NOT NULL, base REAL NOT NULL, quote REAL, quality TEXT NOT NULL, PRIMARY KEY (instrument_id, source_timestamp));');
  const insert = db.prepare('INSERT INTO oi_samples VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  try { for (let index = 1; index <= 1_201; index += 1) insert.run('legacy:batch', index, index + 1, index, null, 'native'); db.exec('COMMIT'); }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  db.close();
  const history = new HistoryStore({ filePath });
  try {
    assert.equal(history.listOi('legacy:batch').length, 1);
    assert.equal(history.listOi('legacy:batch')[0].samples, 1_201);
    assert.equal(history.listOi('legacy:batch')[0].open, 1);
    assert.equal(history.listOi('legacy:batch')[0].close, 1_201);
    assert.equal(fields(history.db.prepare('SELECT COUNT(*) AS count FROM oi_samples').get()).count, 0);
  } finally { history.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('legacy OI migration freezes its rowid cutoff and preserves later receipt-time rows', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-oi-cutoff-')); const filePath = path.join(directory, 'history.sqlite');
  const legacyCount = 5_005;
  const db = new DatabaseSync(filePath);
  db.exec('CREATE TABLE oi_samples (instrument_id TEXT NOT NULL, source_timestamp INTEGER NOT NULL, received_at INTEGER NOT NULL, base REAL NOT NULL, quote REAL, quality TEXT NOT NULL, PRIMARY KEY (instrument_id, source_timestamp));');
  const insert = db.prepare('INSERT INTO oi_samples VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  try { for (let index = 1; index <= legacyCount; index += 1) insert.run('legacy:cutoff', index, index + 1, index, null, 'native'); db.exec('COMMIT'); }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  db.close();
  let first; let second; let third;
  try {
    first = new HistoryStore({ filePath, legacyOiMigrationMaxRows: 1 });
    assert.equal(fields(first.db.prepare("SELECT COUNT(*) AS count FROM oi_samples WHERE source_time IS NULL AND (time_basis IS NULL OR time_basis = 'exchange')").get()).count, legacyCount - 1);
    assert.equal(fields(first.db.prepare("SELECT value FROM migration_state WHERE key = 'oi-legacy-pending'").get() ?? {}).value, '1');
    first.recordOi({ instrumentId: 'receipt:cutoff', sourceTimestamp: null, observationTimestamp: 99_999, receivedAt: 100_000, base: 42, quality: 'sampled' });
    first.close(); first = null;
    second = new HistoryStore({ filePath, legacyOiMigrationMaxRows: 1 });
    assert.equal(fields(second.db.prepare("SELECT COUNT(*) AS count FROM oi_samples WHERE source_time IS NULL AND (time_basis IS NULL OR time_basis = 'exchange')").get()).count, legacyCount - 2);
    assert.equal(second.listOi('receipt:cutoff')[0].sourceTimestamp, null);
    assert.equal(second.listOi('receipt:cutoff')[0].timeBasis, 'receipt');
    second.close(); second = null;
    third = new HistoryStore({ filePath, legacyOiMigrationMaxRows: 1 });
    assert.equal(third.listOi('receipt:cutoff')[0].sourceTimestamp, null);
    assert.equal(third.listOi('receipt:cutoff')[0].timeBasis, 'receipt');
    assert.equal(fields(third.db.prepare("SELECT value FROM migration_state WHERE key = 'oi-legacy-pending'").get() ?? {}).value, '1');
  } finally {
    for (const store of [third, second, first]) { try { store?.close(); } catch {} }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('durable candles strip provider payloads while retaining closed/native provenance', () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  try {
    assert.equal(history.recordCandle({ instrumentId: 'x:BTC', interval: '1m', start: 0, end: 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 2, sourceTimestamp: 60_000, receivedAt: 60_001, closed: false, quality: 'forming' }), false);
    assert.equal(fields(history.db.prepare('SELECT COUNT(*) AS count FROM candle_samples').get()).count, 0);
    assert.equal(history.recordCandle({ instrumentId: 'x:BTC', interval: '1m', start: 60_000, end: 120_000, open: 100, high: 101, low: 99, close: 100.5, volume: 2, sourceTimestamp: 120_000, receivedAt: 120_001, closed: true, quality: 'native', payload: { raw: 'x'.repeat(100_000), rows: Array(1000).fill(1) } }), true);
    const row = history.db.prepare('SELECT payload_json AS payload FROM candle_samples').get();
    assert.ok(textValue(fields(row).payload).length < 2_000);
    assert.equal(JSON.parse(textValue(fields(row).payload)).closed, true);
  } finally { history.close(); }
});

test('modern receipt-time OI keeps nullable exchange provenance across restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-oi-receipt-')); const filePath = path.join(directory, 'history.sqlite');
  try {
    const first = new HistoryStore({ filePath });
    first.recordOi({ instrumentId: 'receipt:BTC', sourceTimestamp: null, observationTimestamp: 123_000, receivedAt: 123_010, base: 42, quality: 'sampled' });
    first.close();
    const second = new HistoryStore({ filePath });
    try {
      const [row] = second.listOi('receipt:BTC');
      assert.equal(row.sourceTimestamp, null);
      assert.equal(row.timeBasis, 'receipt');
      assert.equal(fields(second.db.prepare("SELECT value FROM migration_state WHERE key = 'oi-legacy-pending'").get() ?? {}).value ?? '0', '0');
    } finally { second.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('prior-schema migration preserves valid durable observations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-schema-preserve-'));
  const filePath = path.join(directory, 'history.sqlite');
  const legacy = new DatabaseSync(filePath);
  legacy.exec('CREATE TABLE oi_samples (instrument_id TEXT NOT NULL, source_timestamp INTEGER NOT NULL, received_at INTEGER NOT NULL, base REAL NOT NULL, quote REAL, quality TEXT NOT NULL, PRIMARY KEY (instrument_id, source_timestamp));');
  legacy.prepare('INSERT INTO oi_samples VALUES (?, ?, ?, ?, ?, ?)').run('legacy:keep', 123_000, 123_010, 42, 5_000, 'native');
  legacy.close();
  const history = new HistoryStore({ filePath });
  try {
    assert.deepEqual(history.listOi('legacy:keep'), [{
      instrumentId: 'legacy:keep', interval: '1m', start: 120_000, end: 180_000,
      observationTimestamp: 120_000, sourceTimestamp: 123_000, timeBasis: 'exchange', receivedAt: 123_010,
      base: 42, quote: 5_000, open: 42, high: 42, low: 42, close: 42,
      quoteOpen: 5_000, quoteHigh: 5_000, quoteLow: 5_000, quoteClose: 5_000,
      samples: 1, sampleCount: 1, quality: 'native',
    }]);
    assert.equal(fields(history.db.prepare('SELECT COUNT(*) AS count FROM oi_samples_quarantine').get()).count, 0);
  } finally { history.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
