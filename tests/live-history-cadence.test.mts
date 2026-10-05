import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { defined, fields, list, numeric } from './server-test-helpers.mts';

const instrumentId = 'binance:BTCUSDT';
const start = 1_800_000_000_000;
const environmentKeys = ['HISTORY_DB', 'QUOTA_FILE', 'ENABLE_LIVE_FEEDS', 'HEATMAP_HISTORY_INTERVAL_MS', 'HEATMAP_HISTORY_PRICE_STEP'] as const;
type LocalApp = ReturnType<typeof createLocalServer>;
type CadenceEnvironment = { live?: string; interval?: string; priceStep?: string };

/** Exercise the actual HTTP factory defaults without starting its listener or any feed. */
async function withInMemoryApp(environment: CadenceEnvironment, use: (app: LocalApp) => void | Promise<void>): Promise<void> {
  const original = new Map(environmentKeys.map(key => [key, process.env[key]]));
  let app: LocalApp | undefined;
  try {
    process.env.HISTORY_DB = ':memory:';
    process.env.QUOTA_FILE = ':memory:';
    if (environment.live === undefined) delete process.env.ENABLE_LIVE_FEEDS;
    else process.env.ENABLE_LIVE_FEEDS = environment.live;
    if (environment.interval === undefined) delete process.env.HEATMAP_HISTORY_INTERVAL_MS;
    else process.env.HEATMAP_HISTORY_INTERVAL_MS = environment.interval;
    if (environment.priceStep === undefined) delete process.env.HEATMAP_HISTORY_PRICE_STEP;
    else process.env.HEATMAP_HISTORY_PRICE_STEP = environment.priceStep;
    app = createLocalServer({ persistFixture: false, fixtureTickAutostart: false });
    assert.equal(app.history.filePath, ':memory:');
    assert.equal(app.quota.filePath, null, 'the :memory: quota must never create a ledger file');
    assert.equal(app.server.listening, false);
    assert.equal(app.server.address(), null);
    assert.equal(columnCount(app.history), 0, 'factory construction must not persist fixture books');
    await use(app);
    assert.equal(app.server.listening, false);
    assert.equal(app.server.address(), null);
    assert.equal(app.quota.snapshot().used, 0);
    assert.deepEqual(app.quota.snapshot().requests, []);
  } finally {
    try { if (app) await app.close(); }
    finally {
      for (const key of environmentKeys) {
        const value = original.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
        assert.equal(process.env[key], value, key + ' must be restored');
      }
    }
  }
}

function columnCount(history: HistoryStore): number {
  return numeric(fields(history.db.prepare('SELECT COUNT(*) AS count FROM heatmap_columns').get()).count);
}
function segment(offsetStart: number, offsetEnd: number, amount: number) {
  return { start: start + offsetStart, end: start + offsetEnd, amount, notionalUsd: 100 * amount };
}
function observedSegments(sample: unknown): unknown[] {
  return list(fields(sample).cellMeta).flatMap(cell => list(fields(cell).observedSegments));
}
function weightedTotal(samples: unknown[], field: 'amount' | 'notionalUsd'): number {
  return samples.flatMap(observedSegments).reduce<number>((total, value) => {
    const row = fields(value);
    return total + numeric(row[field]) * (numeric(row.end) - numeric(row.start));
  }, 0);
}

// These top-level tests run serially because each restores process-wide factory inputs.
test('native live HTTP history factory defaults to closed 60-second buckets', async () => {
  await withInMemoryApp({ live: 'true' }, app => { assert.equal(app.history.heatmap.intervalMs, 60_000); });
});

test('explicit 25-minute history cadence remains honored for live and fixture modes', async () => {
  for (const live of ['true', 'false']) await withInMemoryApp({ live, interval: '1500000' }, app => {
    assert.equal(app.history.heatmap.intervalMs, 1_500_000);
  });
});

test('fixture and unset live-feed modes retain the original 25-minute history default', async () => {
  for (const live of [undefined, 'false']) await withInMemoryApp({ live }, app => {
    assert.equal(app.history.heatmap.intervalMs, 1_500_000);
  });
});
function priceBounds(sample: unknown): unknown[] {
  return list(fields(sample).cellMeta).map(value => {
    const cell = fields(value); return [cell.side, cell.priceLow, cell.priceHigh];
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

test('unset and invalid recording overrides fall back to deterministic mode defaults', async () => {
  for (const live of [undefined, 'false', 'true']) {
    for (const priceStep of [undefined, '', '0', '-1', 'NaN', 'Infinity', '1e309', 'invalid'])
      await withInMemoryApp({ live, priceStep }, app => {
        assert.equal(app.history.heatmap.priceStep, live === 'true' ? 10 : 50);
        assert.equal(app.history.heatmap.maxCellsPerBucket, 2_000);
      });
  }
  const direct = new HistoryStore();
  try { assert.equal(direct.heatmap.priceStep, 50, 'the direct HistoryStore compatibility default is unchanged'); }
  finally { direct.close(); }
});
