import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer, MAX_PROVIDER_REFRESH_FLIGHTS } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { MockHyperTrackerClient } from '../src/adapters/hypertracker-mock.mts';
import { HyperTrackerClient } from '../src/adapters/hypertracker.mts';
import { crossingTargetKey, type CrossingLevel } from '../src/core/crossing.mts';
import { arrayValue, recordValue } from '../src/adapters/common.mts';
import type { LayerKind, LayerSide } from '../src/domain/contracts.ts';

const LAYERS = ['liquidation', 'stopLoss', 'takeProfit'] as const;
function makeApp() { return createLocalServer({ liveMode: true, persistFixture: false, fixtureTickAutostart: false, history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }) }); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('provisional crossing belongs to the source level target and cannot migrate to another price, side, instrument or layer', async t => {
  const cases: readonly (readonly [string, { price?: number; side?: LayerSide; instrumentId?: string; layer?: LayerKind }])[] = [
    ['price', { price: 105 }],
    ['side', { side: 'buy' as LayerSide }],
    ['instrument', { instrumentId: 'hyperliquid:ETH-PERP' }],
    ['layer', { layer: 'liquidation' as LayerKind, side: 'long' as LayerSide }],
  ] as const;
  for (const [name, changed] of cases) await t.test(name, async () => {
    const app = makeApp(), at = Date.now() - 5_000, instrumentId = app.state.markInstrumentId;
    const level = { id: 'shared-provider-id', layer: 'stopLoss' as const, side: 'sell' as const, price: 100, notionalUsd: 200, active: true };
    try {
      assert.equal(app.applyMessage({ kind: 'layerSnapshot', layer: 'stopLoss', instrumentId, revision: 'r1', sourceTimestamp: at, receivedAt: at, complete: true, levels: [level] }, 'hypertracker'), true);
      app.applyMessage({ kind: 'price', instrumentId, price: 110, sourceTimestamp: at + 1, receivedAt: at + 1 }, 'hyperliquid');
      app.applyMessage({ kind: 'price', instrumentId, price: 90, sourceTimestamp: at + 3, receivedAt: at + 3 }, 'hyperliquid');
      assert.equal(app.state.layers.stopLoss[0].provisional, true); assert.equal(app.state.layers.stopLoss[0].takenAt, at + 3);
      const layer = changed.layer ?? 'stopLoss', nextInstrument = changed.instrumentId ?? instrumentId;
      const incoming = { ...level, ...changed, layer };
      assert.equal(app.applyMessage({ kind: 'layerSnapshot', layer, instrumentId: nextInstrument, revision: 'r2', sourceTimestamp: at + 2, receivedAt: at + 4, complete: true, levels: [incoming] }, 'hypertracker'), true);
      const result = app.state.layers[layer][0];
      assert.equal(result.active, true); assert.notEqual(result.provisional, true); assert.equal(result.takenAt, undefined);
      assert.equal(app.quota.snapshot().used, 0);
    } finally { await app.close(); }
  });
});

test('shared complete-order resource retains both last-good layers after a later page fails and clears both on coherent newer empty success', async () => {
  const app = createLocalServer({ liveMode: true, persistFixture: false, fixtureTickAutostart: false, providerPaths: { orders: '/test/orders' }, quota: new QuotaLedger({ limit: 30 }), history: new HistoryStore({ filePath: ':memory:' }) });
  const at = Date.parse('2026-10-01T12:00:00.000Z');
  const row = (oid: string, orderType = 'Stop Market', snapshotTs = at) => ({ oid, coin: 'BTC', side: 'A', orderType, triggerPx: 100, sz: 2, timestamp: '2023-09-29T09:59:26.471Z', snapshotTs });
  const pages = [
    { orders: [row('sl'), row('tp', 'Take Profit Market')], nextCursor: null, snapshotTs: at },
    { orders: [row('changed', 'Stop Market', at + 300_000)], nextCursor: 'tail', snapshotTs: at + 300_000 },
    new Response('injected-rate-limit', { status: 429 }),
    { orders: [], nextCursor: null, snapshotTs: at + 600_000 },
  ];
  let calls = 0;
  const client = new HyperTrackerClient({ token: 'injected-test-token', networkEnabled: true, ledger: app.quota, fetchImpl: async () => {
    const payload = pages[calls++];
    assert.notEqual(payload, undefined, 'no unplanned retries');
    return payload instanceof Response ? payload : new Response(JSON.stringify(payload));
  } });
  try {
    app.setProvider(client);
    const seed = await Promise.all([app.refreshProvider('stopLoss'), app.refreshProvider('takeProfit')]);
    assert.ok(seed.every(result => result.ok)); assert.equal(calls, 1); assert.equal(app.quota.snapshot().used, 5);
    const good = structuredClone({ stop: app.state.layers.stopLoss, profit: app.state.layers.takeProfit, stopMeta: app.state.layerMeta.stopLoss, profitMeta: app.state.layerMeta.takeProfit });
    const failed = await Promise.all([app.refreshProvider('stopLoss'), app.refreshProvider('takeProfit')]);
    assert.ok(failed.every(result => !result.ok && result.statusCode === 503));
    assert.deepEqual({ stop: app.state.layers.stopLoss, profit: app.state.layers.takeProfit, stopMeta: app.state.layerMeta.stopLoss, profitMeta: app.state.layerMeta.takeProfit }, good);
    assert.equal(app.state.statuses.hypertracker.state, 'unavailable'); assert.equal(calls, 3); assert.equal(app.quota.snapshot().used, 15);
    const empty = await Promise.all([app.refreshProvider('stopLoss'), app.refreshProvider('takeProfit')]);
    assert.ok(empty.every(result => result.ok && result.complete && result.levels === 0));
    assert.equal(app.state.layers.stopLoss.length, 0); assert.equal(app.state.layers.takeProfit.length, 0);
    assert.equal(app.state.layerMeta.stopLoss.empty, true); assert.equal(app.state.layerMeta.takeProfit.empty, true);
    assert.equal(app.state.layerMeta.stopLoss.sourceTimestamp, at + 600_000); assert.equal(app.state.layerMeta.takeProfit.sourceTimestamp, at + 600_000);
    assert.equal(calls, 4); assert.equal(app.quota.snapshot().used, 20);
  } finally { await app.close(); }
});

test('a provider switch fences pagination before the next page charge and preserves current mock provenance', async () => {
  const app = createLocalServer({ liveMode: true, persistFixture: false, fixtureTickAutostart: false, providerPaths: { orders: '/test/orders' }, quota: new QuotaLedger({ limit: 30 }), history: new HistoryStore({ filePath: ':memory:' }) });
  const pending = deferred();
  let calls = 0;
  const client = new HyperTrackerClient({ token: 'injected-test-token', networkEnabled: true, ledger: app.quota, fetchImpl: async () => {
    calls++; await pending.promise;
    return new Response(JSON.stringify({ orders: [{ oid: 'old', coin: 'BTC', side: 'A', orderType: 'Stop Market', triggerPx: 100, sz: 2, snapshotTs: Date.parse('2026-10-01T12:00:00.000Z') }], nextCursor: 'next' }));
  } });
  try {
    app.setProvider(client);
    const oldStop = app.refreshProvider('stopLoss'), oldProfit = app.refreshProvider('takeProfit');
    assert.equal(calls, 1);
    app.setProvider(new MockHyperTrackerClient());
    const current = await Promise.all([app.refreshProvider('stopLoss'), app.refreshProvider('takeProfit')]);
    assert.ok(current.every(result => result.ok));
    const good = structuredClone({ layers: app.state.layers, meta: app.state.layerMeta });
    pending.resolve(); const retired = await Promise.all([oldStop, oldProfit]);
    assert.ok(retired.every(result => result.statusCode === 409));
    assert.deepEqual({ layers: app.state.layers, meta: app.state.layerMeta }, good);
    assert.equal(app.state.statuses.hypertracker.mock, true); assert.equal(app.state.statuses.hypertracker.state, 'mock');
    assert.equal(calls, 1); assert.equal(app.quota.snapshot().used, 5);
  } finally { pending.resolve(); await app.close(); }
});
test('crossing target signatures bind price, side, layer, instrument and coarse range while ignoring display and provisional fields', () => {
  const instrumentId = 'hyperliquid:BTC-PERP';
  const target: CrossingLevel = { id: 'provider-id', layer: 'stopLoss', side: 'buy', price: 100, notionalUsd: 200, active: true };
  const key = crossingTargetKey(target, instrumentId);
  assert.equal(key, '["stopLoss","hyperliquid:BTC-PERP","buy",100,null,null,null]');
  assert.equal(crossingTargetKey({ ...target, id: 'different-provider-id', notionalUsd: 400, active: false, provisional: true, takenAt: 123 }, instrumentId), key);
  const changes: Partial<CrossingLevel>[] = [
    { price: 101 }, { side: 'sell' }, { layer: 'takeProfit' },
    { instrumentId: 'hyperliquid:ETH-PERP' }, { priceTo: 110 }, { priceLow: 99 }, { priceHigh: 101 },
  ];
  for (const changed of changes) assert.notEqual(crossingTargetKey({ ...target, ...changed }, instrumentId), key);
  assert.equal(crossingTargetKey({ ...target, instrumentId }, 'hyperliquid:ETH-PERP'), key, 'explicit retained instrument owns the target');
  assert.notEqual(crossingTargetKey(target, 'hyperliquid:ETH-PERP'), key, 'fallback instrument is part of an unbound target');
  assert.equal(crossingTargetKey(target, ''), null);
  for (const price of [0, -1, NaN, Infinity]) assert.equal(crossingTargetKey({ ...target, price }, instrumentId), null);
  for (const changed of [{ priceTo: Infinity }, { priceLow: NaN }, { priceHigh: -Infinity }]) assert.equal(crossingTargetKey({ ...target, ...changed }, instrumentId), null);
});
test('older mark source times cannot cross a current provider level or move the accepted price basis', async () => {
  const app = makeApp(), at = Date.now() - 5_000, instrumentId = app.state.markInstrumentId;
  try {
    app.applyMessage({ kind: 'layerSnapshot', layer: 'stopLoss', instrumentId, revision: 'r1', sourceTimestamp: at, receivedAt: at, complete: true, levels: [{ id: 'basis', layer: 'stopLoss', side: 'buy', price: 100, notionalUsd: 200, active: true }] }, 'hypertracker');
    app.applyMessage({ kind: 'price', instrumentId, price: 90, sourceTimestamp: at + 2, receivedAt: at + 2 }, 'hyperliquid');
    const sequence = app.metrics.markSequence;
    app.applyMessage({ kind: 'price', instrumentId, price: 110, sourceTimestamp: at + 1, receivedAt: at + 3 }, 'hyperliquid');
    assert.equal(app.state.markPrice, 90); assert.equal(app.state.layers.stopLoss[0].active, true);
    assert.notEqual(app.state.layers.stopLoss[0].provisional, true); assert.equal(app.metrics.markSequence, sequence);
    assert.equal(app.quota.snapshot().used, 0);
  } finally { await app.close(); }
});

test('gap, resync and reanchor prices establish a fresh basis before subsequent continuous observations can cross', async t => {
  for (const flag of ['gap', 'resyncRequired', 'reanchor']) await t.test(flag, async () => {
    const app = makeApp(), at = Date.now() - 5_000, instrumentId = app.state.markInstrumentId;
    try {
      app.applyMessage({ kind: 'layerSnapshot', layer: 'stopLoss', instrumentId, revision: 'r1', sourceTimestamp: at, receivedAt: at, complete: true, levels: [{ id: 'basis', layer: 'stopLoss', side: 'buy', price: 100, notionalUsd: 200, active: true }] }, 'hypertracker');
      app.applyMessage({ kind: 'price', instrumentId, price: 90, sourceTimestamp: at + 1, receivedAt: at + 1 }, 'hyperliquid');
      app.applyMessage({ kind: 'price', instrumentId, price: 110, sourceTimestamp: at + 2, receivedAt: at + 2, ...(flag === 'reanchor' ? { continuity: 'reanchor' } : { [flag]: true }) }, 'hyperliquid');
      assert.equal(app.state.layers.stopLoss[0].active, true); assert.notEqual(app.state.layers.stopLoss[0].provisional, true);
      app.applyMessage({ kind: 'price', instrumentId, price: 90, sourceTimestamp: at + 3, receivedAt: at + 3 }, 'hyperliquid');
      app.applyMessage({ kind: 'price', instrumentId, price: 110, sourceTimestamp: at + 4, receivedAt: at + 4 }, 'hyperliquid');
      assert.equal(app.state.layers.stopLoss[0].active, false); assert.equal(app.state.layers.stopLoss[0].provisional, true);
      assert.equal(app.state.layers.stopLoss[0].takenAt, at + 4); assert.equal(app.quota.snapshot().used, 0);
    } finally { await app.close(); }
  });
});

test('mark crossings do not affect a retained provider level from another instrument', async () => {
  const app = makeApp(), at = Date.now() - 5_000, instrumentId = app.state.markInstrumentId;
  try {
    app.applyMessage({ kind: 'layerSnapshot', layer: 'stopLoss', instrumentId: 'hyperliquid:ETH-PERP', revision: 'r1', sourceTimestamp: at, receivedAt: at, complete: true, levels: [{ id: 'foreign', layer: 'stopLoss', side: 'buy', price: 100, notionalUsd: 200, active: true }] }, 'hypertracker');
    app.applyMessage({ kind: 'price', instrumentId, price: 90, sourceTimestamp: at + 1, receivedAt: at + 1 }, 'hyperliquid');
    app.applyMessage({ kind: 'price', instrumentId, price: 110, sourceTimestamp: at + 2, receivedAt: at + 2 }, 'hyperliquid');
    assert.equal(app.state.layers.stopLoss[0].active, true); assert.notEqual(app.state.layers.stopLoss[0].provisional, true);
    app.applyMessage({ kind: 'price', instrumentId: 'hyperliquid:ETH-PERP', price: 90, sourceTimestamp: at + 3, receivedAt: at + 3 }, 'hyperliquid');
    assert.equal(app.state.markPrice, 110); assert.equal(app.state.layers.stopLoss[0].active, true);
    assert.equal(app.quota.snapshot().used, 0);
  } finally { await app.close(); }
});
