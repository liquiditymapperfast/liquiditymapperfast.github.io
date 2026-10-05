import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { MockHyperTrackerClient } from '../src/adapters/hypertracker-mock.mts';
import type { LocalServerOptions } from '../src/server/http-contracts.mts';
async function eventually(predicate: () => boolean): Promise<void> { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise<void>(resolve => setTimeout(resolve, 2)); } throw Error('provider flight did not start'); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function makeApp(options: LocalServerOptions = {}) { return createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false, ...options }); }
test('a superseded mock layer flight cannot overwrite the new provider or its status', async () => {
  const app = makeApp(), oldGenerator = new MockHyperTrackerClient(), newGenerator = new MockHyperTrackerClient({ now: () => Date.now() + 100 }), pending = deferred(); let started = false;
  const old = { mock: true, request: async (kind: string) => { started = true; await pending.promise; return oldGenerator.request(kind); } };
  try {
    app.setProvider(old); const stale = app.refreshProvider('liquidation'); await eventually(() => started);
    app.setProvider({ request: async (kind: string) => ({ ...await newGenerator.request(kind), mock: false }) }); assert.equal((await app.refreshProvider('liquidation')).ok, true);
    const good = structuredClone(app.state.layerMeta.liquidation); pending.resolve(); const staleResult = await stale;
    assert.equal(staleResult.statusCode, 409); assert.deepEqual(app.state.layerMeta.liquidation, good); assert.equal(app.state.statuses.hypertracker.mock, false); assert.equal(app.state.statuses.hypertracker.state, 'live');
  } finally { pending.resolve(); await app.close(); }
});
test('shared orders from a superseded provider are fenced and do not deduplicate with the new provider generation', async () => {
  const app = makeApp({ providerPaths: { orders: '/test/orders' } }), oldGenerator = new MockHyperTrackerClient(), newGenerator = new MockHyperTrackerClient({ now: () => Date.now() + 100 }), pending = deferred(); let started = false, newRequests = 0;
  try {
    app.setProvider({ mock: true, request: async (kind: string) => { started = true; await pending.promise; return oldGenerator.request(kind); } });
    const staleStop = app.refreshProvider('stopLoss'), staleProfit = app.refreshProvider('takeProfit'); await eventually(() => started);
    app.setProvider({ request: async (kind: string) => { newRequests++; return { ...await newGenerator.request(kind), mock: false }; } });
    const current = await Promise.all([app.refreshProvider('stopLoss'), app.refreshProvider('takeProfit')]); assert.ok(current.every(result => result.ok)); assert.equal(newRequests, 1);
    const good = structuredClone(app.state.layerMeta); pending.resolve(); assert.ok((await Promise.all([staleStop, staleProfit])).every(result => result.statusCode === 409));
    assert.deepEqual(app.state.layerMeta, good); assert.equal(app.state.statuses.hypertracker.mock, false);
  } finally { pending.resolve(); await app.close(); }
});
test('a rejected older provider layer preserves last-good levels, metadata, and source timestamps', async () => {
  const at = Date.now(), app = makeApp({ provider: new MockHyperTrackerClient({ now: () => at }) });
  try {
    assert.equal((await app.refreshProvider('liquidation')).ok, true);
    const good = structuredClone({ levels: app.state.layers.liquidation, meta: app.state.layerMeta.liquidation, timestamps: app.state.layerSourceTimestamps });
    app.setProvider(new MockHyperTrackerClient({ now: () => at - 10_000 }));
    const rejected = await app.refreshProvider('liquidation');
    assert.equal(rejected.ok, false); assert.equal(rejected.statusCode, 503); assert.match(rejected.error ?? '', /provider layer rejected/);
    assert.deepEqual({ levels: app.state.layers.liquidation, meta: app.state.layerMeta.liquidation, timestamps: app.state.layerSourceTimestamps }, good);
    assert.equal(app.state.statuses.hypertracker.state, 'unavailable');
  } finally { await app.close(); }
});
