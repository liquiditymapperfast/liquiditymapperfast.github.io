import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dayKey, MAX_QUOTA_LEDGER_REQUESTS, QuotaLedger } from '../src/core/quota.mts';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
function disposableLedgerDirectory(): string {
  const root = path.resolve(process.cwd(), 'data', 'runtime');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'provider-quota-safety-'));
}

test('automatic eligibility reports the local UTC reset while manual reserve remains eligible now', () => {
  const ledger = new QuotaLedger({ limit: 20, now: NOW });
  assert.equal(ledger.spend(5, 'stopLoss', NOW, { automatic: true }), true);
  assert.equal(ledger.spend(5, 'takeProfit', NOW, { automatic: true }), true);
  const automatic = ledger.eligibility(5, NOW, { automatic: true });
  assert.equal(automatic.eligible, false); assert.equal(automatic.reason, 'automatic-budget');
  assert.equal(automatic.nextEligibleAt, Date.parse('2026-10-02T00:00:00.000Z'));
  assert.equal(automatic.remaining, 10); assert.equal(automatic.automaticRemaining, 0);
  const manual = ledger.eligibility(5, NOW);
  assert.equal(manual.eligible, true); assert.equal(manual.nextEligibleAt, NOW);
  assert.equal(ledger.state.used, 10); assert.equal(ledger.state.requests.length, 2);
});

test('clock-regressed eligibility waits for durable high-water day or its exhausted reset', () => {
  const ledger = new QuotaLedger({ limit: 20, now: NOW + 86_400_000 });
  assert.equal(ledger.spend(15, 'future-day', NOW + 86_400_000), true);
  const waiting = ledger.eligibility(5, NOW);
  assert.equal(waiting.reason, 'clock-regression'); assert.equal(waiting.eligible, false);
  assert.equal(waiting.nextEligibleAt, Date.parse('2026-10-02T00:00:00.000Z'));
  assert.equal(ledger.spend(5, 'exhaust-future-day', NOW + 86_400_000), true);
  const exhausted = ledger.eligibility(5, NOW);
  assert.equal(exhausted.reason, 'clock-regression');
  assert.equal(exhausted.nextEligibleAt, Date.parse('2026-10-03T00:00:00.000Z'));
  assert.equal(ledger.state.day, '2026-10-02'); assert.equal(ledger.state.used, 20);
});

test('request-history capacity has a truthful future eligibility even for zero-cost requests', () => {
  const ledger = new QuotaLedger({ limit: 20, now: NOW });
  for (let index = 0; index < MAX_QUOTA_LEDGER_REQUESTS; index++) assert.equal(ledger.spend(0, 'local-' + index, NOW), true);
  const result = ledger.eligibility(0, NOW);
  assert.equal(result.reason, 'request-history-capacity'); assert.equal(result.eligible, false);
  assert.equal(result.nextEligibleAt, Date.parse('2026-10-02T00:00:00.000Z'));
  assert.equal(ledger.state.requests.length, MAX_QUOTA_LEDGER_REQUESTS);
});

test('impossible endpoint costs do not invent tomorrow eligibility and total/manual limits stay distinct', () => {
  const ledger = new QuotaLedger({ limit: 4, now: NOW });
  const impossible = ledger.eligibility(5, NOW);
  assert.equal(impossible.reason, 'cost-exceeds-limit'); assert.equal(impossible.nextEligibleAt, null);
  const automatic = ledger.eligibility(3, NOW, { automatic: true });
  assert.equal(automatic.reason, 'automatic-budget'); assert.equal(automatic.nextEligibleAt, null);
  assert.equal(ledger.eligibility(3, NOW).eligible, true);
  assert.equal(ledger.spend(4, 'manual', NOW), true);
  const total = ledger.eligibility(1, NOW, { automatic: true });
  assert.equal(total.reason, 'token-budget'); assert.equal(total.nextEligibleAt, Date.parse('2026-10-02T00:00:00.000Z'));
});