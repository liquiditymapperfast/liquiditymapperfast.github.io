import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { logicalRetainedBytes } from '../src/core/retained-bytes.mts';

function fixture(physicalBlocked = false) {
  return createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }),
    restoreState: false, fixtureTickAutostart: false,
    ...(physicalBlocked ? { retainedProviders: { ramLimits: { physicalSoftLimitBytes: 1, physicalHardLimitBytes: 1 } } } : {}),
  });
}
function measure(app: ReturnType<typeof createLocalServer>) {
  const value = app.retainedProviders.measureStateComponents?.();
  assert.ok(value); return value;
}
function message(id: string) {
  return { kind: 'trade' as const, venue: 'hyperliquid' as const, instrumentId: 'hyperliquid:BTC-PERP', tradeId: id,
    price: 100, amount: 1, notionalUsd: 100, side: 'buy' as const, sourceTimestamp: 1_700_000_000_000, receivedAt: 1_700_000_000_001,
    annotations: { source: 'caller', notes: ['initial'] } };
}

function candle(start: number) {
  return { kind: 'candle' as const, instrumentId: 'hyperliquid:BTC-PERP', interval: '1m', start, end: start + 60_000,
    open: 100, high: 102, low: 99, close: 101, volume: 3, closed: true,
    sourceTimestamp: start + 60_000, receivedAt: start + 60_001, provenance: { source: 'caller' } };
}
