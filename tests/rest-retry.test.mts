import test from 'node:test';
import assert from 'node:assert/strict';
import { createRestRequestCoordinator, RestBudgetError } from '../src/core/rest-retry.mts';

const request = { method: 'GET', url: 'https://example.test/data?symbol=BTC' };

test('REST coordinator shares one in-flight request by venue and request key', async () => {
  let calls = 0; let release: (value: unknown) => void = () => { throw Error('Request has not started'); };
  const coordinator = createRestRequestCoordinator({
    transport: async () => { calls += 1; return new Promise(resolve => { release = resolve; }); },
  });
  const first = coordinator.request(request, { venue: 'binance' });
  const second = coordinator.request({ ...request }, { venue: 'binance' });
  assert.strictEqual(first, second);
  assert.equal(coordinator.inFlight, 1);
  const retained = coordinator.retainedSnapshot();
  assert.deepEqual(retained.inFlightKeys, ['binance|binance|GET|https://example.test/data?symbol=BTC|']);
  assert.deepEqual(retained.inFlightRequests, [request]);
  assert.equal(retained.budgetWindows instanceof Map, true);
  release({ ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.equal(calls, 1);
  assert.equal(coordinator.inFlight, 0);
  assert.deepEqual(coordinator.retainedSnapshot().inFlightKeys, []);
  assert.deepEqual(coordinator.retainedSnapshot().inFlightRequests, []);
});

test('transient REST failures use bounded exponential jitter and retry only within the venue budget', async () => {
  let calls = 0; const waits: number[] = [];
  const coordinator = createRestRequestCoordinator({
    transport: async () => { calls += 1; if (calls < 3) throw Object.assign(new Error('busy'), { status: 503 }); return { ok: true }; },
    random: () => .5,
    schedule: (resolve, delay) => { waits.push(delay); resolve(); },
    policies: { binance: { maxAttempts: 3, maxAttemptsPerWindow: 3, windowMs: 60_000, baseDelayMs: 10, maxDelayMs: 15, jitterRatio: 0 } },
  });
  assert.deepEqual(await coordinator.request(request, { venue: 'binance' }), { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 15]);
});

test('non-transient failures do not consume retry attempts and exhausted budgets fail closed', async () => {
  let calls = 0;
  const nonTransient = createRestRequestCoordinator({ transport: async () => { calls += 1; throw Object.assign(new Error('bad request'), { status: 400 }); }, policies: { hyperliquid: { maxAttempts: 3, maxAttemptsPerWindow: 3 } } });
  await assert.rejects(nonTransient.request(request, { venue: 'hyperliquid' }), /bad request/);
  assert.equal(calls, 1);

  let budgetCalls = 0;
  const exhausted = createRestRequestCoordinator({
    transport: async () => { budgetCalls += 1; throw Object.assign(new Error('busy'), { status: 503 }); },
    schedule: (resolve) => resolve(),
    policies: { hyperliquid: { maxAttempts: 4, maxAttemptsPerWindow: 2, windowMs: 60_000, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
  });
  await assert.rejects(exhausted.request(request, { venue: 'hyperliquid' }), error => error instanceof RestBudgetError);
  assert.equal(budgetCalls, 2);
});

test('late local admission failure cannot refund a newer provider budget window', async () => {
  let at = 0;
  let rejectFirst: (error: Error) => void = () => { throw Error('Request has not started'); };
  const coordinator = createRestRequestCoordinator({
    transport: (pendingRequest) => String(pendingRequest.url).endsWith('/first')
      ? new Promise((resolve, reject) => { rejectFirst = reject; })
      : Promise.resolve({ ok: true }),
    now: () => at,
    policies: { default: { maxAttempts: 1, maxAttemptsPerWindow: 1, windowMs: 10 } },
  });
  const first = coordinator.request({ url: 'https://example.test/first' });
  const firstFailure = assert.rejects(first, (error: unknown) => (error as { code?: unknown }).code === 'PROCESS_MEMORY_LIMIT');
  at = 10;
  assert.deepEqual(await coordinator.request({ url: 'https://example.test/second' }), { ok: true });
  rejectFirst(Object.assign(new Error('local admission failed'), { code: 'PROCESS_MEMORY_LIMIT', providerRequestStarted: false }));
  await firstFailure;
  assert.equal(coordinator.budgetSnapshot().default.attempts, 1);
});
