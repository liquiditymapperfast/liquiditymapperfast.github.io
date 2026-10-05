import test from 'node:test';
import assert from 'node:assert/strict';
import { MockHyperTrackerClient, hyperTrackerMode, type MockSnapshot } from '../src/adapters/hypertracker-mock.mts';
import { normalizeHyperTrackerSnapshot, hyperTrackerCompleteness } from '../src/adapters/hypertracker.mts';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { createMockReferencePrice } from '../src/core/mock-provider-provenance.mts';

const NOW = 1700000000000;
const LAYERS = ['liquidation', 'stopLoss', 'takeProfit'] as const;
function normalize(raw: MockSnapshot | Record<string, unknown>, layer: 'liquidation' | 'stopLoss' | 'takeProfit', coin = 'BTC') {
  return normalizeHyperTrackerSnapshot(raw, { layer, coin, referencePrice: 100, revision: String(raw.revision), complete: hyperTrackerCompleteness(raw) });
}
function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12, `${actual} != ${expected}`);
}

test('mock provider generates stable identities, exact sides and USD values, and both trigger-order subtypes', async () => {
  let mark = 100;
  const client = new MockHyperTrackerClient({ now: () => NOW, referencePrice: () => mark });
  for (const layer of LAYERS) {
    mark = 100;
    const raw = await client.request(layer);
    const message = normalize(raw, layer);
    assert.equal(message.levels.length, 96);
    assert.equal(raw.mock, true); assert.equal(raw.source, 'hypertracker-mock');
    assert.equal(raw.generatedAt, NOW); assert.equal(raw.sourceTimestamp, Number(raw.revision));
    assert.equal(message.sourceTimestamp, raw.sourceTimestamp); assert.equal(message.complete, true);
    assert.equal(message.units, 'USD notional'); assert.equal(new Set(message.levels.map(row => row.id)).size, 96);
    if (layer !== 'liquidation') {
      assert.ok(raw.orders);
      const types = layer === 'stopLoss' ? ['Stop Market', 'Stop Limit'] : ['Take Profit Market', 'Take Profit Limit'];
      assert.deepEqual(new Set(raw.orders.map(row => row.orderType)), new Set(types));
      assert.ok(raw.orders.filter(row => row.orderType.endsWith('Limit')).every(row => row.limitPx !== row.triggerPx));
    }
    const rows = raw.levels ?? raw.orders;
    assert.ok(rows);
    for (let index = 0; index < message.levels.length; index++) {
      const row = message.levels[index]; const source: NonNullable<MockSnapshot['levels']>[number] | NonNullable<MockSnapshot['orders']>[number] = rows[index];
      const below = row.price < mark;
      const expectedSide = layer === 'liquidation' ? (below ? 'long' : 'short')
        : layer === 'stopLoss' ? (below ? 'sell' : 'buy') : (below ? 'buy' : 'sell');
      assert.equal(row.side, expectedSide);
      if ('price' in source) { assert.equal(row.price, source.price); near(row.notionalUsd, source.liquidationValue); }
      else { assert.equal(row.price, source.triggerPx); near(row.notionalUsd, source.sz * source.triggerPx); }
      const position = index % 48;
      const wall = position % 11 === 0 ? 9 : position % 5 === 0 ? 3 : 1;
      near(row.notionalUsd, (70_000 + (position % 7) * 17_000) * wall);
    }
    mark = 101;
    const refreshed = await client.request(layer);
    assert.ok(Number(refreshed.revision) > Number(raw.revision));
    const next = normalize(refreshed, layer);
    assert.deepEqual(next.levels.map(row => row.id), message.levels.map(row => row.id));
    assert.ok(next.levels.every((row, index) => row.price > message.levels[index].price));
  }
});

test('shared mock orders preserve coin and subtype filtering with trigger prices and base-to-USD conversion', async () => {
  const client = new MockHyperTrackerClient({ now: () => NOW, referencePrice: () => .000003 });
  const raw = await client.request('orders', { coin: 'ETH', path: 'unused-development-path', automatic: true });
  assert.ok(raw.orders);
  assert.equal(raw.orders.length, 192); assert.equal(raw.units, 'base');
  for (const layer of ['stopLoss', 'takeProfit'] as const) {
    const message = normalize(raw, layer, 'ETH');
    assert.equal(message.levels.length, 96);
    assert.equal(normalize(raw, layer, 'BTC').levels.length, 0);
    assert.ok(message.levels.every(row => Number.isFinite(row.price) && row.price > 0 && row.notionalUsd > 0));
    const matching: NonNullable<MockSnapshot['orders']> = raw.orders.filter(row => row.orderType.startsWith(layer === 'stopLoss' ? 'Stop ' : 'Take Profit '));
    assert.deepEqual(message.levels.map(row => row.price), matching.map(row => row.triggerPx));
    matching.forEach((row, index) => near(message.levels[index].notionalUsd, row.sz * row.triggerPx));
  }
  const mixed = { ...raw, orders: [...raw.orders,
    { oid: 'ordinary', coin: 'ETH', orderType: 'Limit', limitPx: 1, sz: 1000000, side: 'buy', sizeUnit: 'base' },
    { oid: 'other-coin', coin: 'BTC', orderType: 'Stop Market', triggerPx: 100, sz: 1000000, side: 'sell', sizeUnit: 'base' },
  ] };
  assert.equal(normalize(mixed, 'stopLoss', 'ETH').levels.length, 96);
  assert.equal(normalize(mixed, 'takeProfit', 'ETH').levels.length, 96);
  assert.throws(() => normalize(raw, 'liquidation', 'ETH'), /cannot populate/);
  assert.throws(() => normalize({ ...raw, sourceKind: 'stopLoss' }, 'takeProfit', 'ETH'), /cannot populate/);
});

test('mock revisions advance through repeated/backward clocks, empty removal, and recovery', async () => {
  let now = NOW;
  const client = new MockHyperTrackerClient({ now: () => now, referencePrice: () => 100 });
  const ready = await client.request('liquidation');
  const repeated = await client.request('liquidation');
  now -= 10000;
  const backward = await client.request('liquidation');
  client.setScenario('error');
  await assert.rejects(client.request('liquidation'), /refresh failure/);
  client.setScenario('empty');
  const empty = await client.request('liquidation');
  client.setScenario('ready');
  const recovered = await client.request('liquidation');
  assert.deepEqual([ready, repeated, backward, empty, recovered].map(raw => Number(raw.revision)), [NOW, NOW + 1, NOW + 2, NOW + 3, NOW + 4]);
  assert.equal(backward.generatedAt, now); assert.equal(empty.generatedAt, now);
  assert.equal(empty.complete, true); assert.equal(empty.nextCursor, null); assert.deepEqual(empty.levels, []);
  assert.ok(recovered.levels); assert.ok(ready.levels);
  assert.deepEqual(recovered.levels.map(row => row.id), ready.levels.map(row => row.id));
});

test('invalid mock inputs fail safely and complete empty snapshots need no reference price', async () => {
  for (const now of [NaN, Infinity, 0, -1, 1.5, Number.MAX_VALUE]) {
    const client = new MockHyperTrackerClient({ now: () => now });
    await assert.rejects(client.request('liquidation'), /clock unavailable/);
  }
  const exhausted = new MockHyperTrackerClient({ now: () => Number.MAX_SAFE_INTEGER });
  await exhausted.request('liquidation');
  await assert.rejects(exhausted.request('liquidation'), /clock exhausted/);
  for (const mark of [NaN, Infinity, 0, -1, Number.MAX_VALUE, Number.MIN_VALUE]) {
    const client = new MockHyperTrackerClient({ now: () => NOW, referencePrice: () => mark });
    await assert.rejects(client.request('orders'), /reference price/);
  }
  const client = new MockHyperTrackerClient({ now: () => NOW, referencePrice: () => { throw new Error('no reference'); }, scenario: 'empty' });
  for (const kind of [...LAYERS, 'orders']) {
    const raw = await client.request(kind);
    assert.equal(raw.complete, true); assert.equal(hyperTrackerCompleteness(raw), true);
    assert.deepEqual(raw.levels ?? raw.orders, []);
  }
  await assert.rejects(client.request('segments'), /Unsupported/);
  for (const coin of ['../BTC', '', 'btc', 'BTC-PERP', 'X'.repeat(17)]) await assert.rejects(client.request('liquidation', { coin }), /Invalid/);
  assert.throws(() => client.setScenario('unknown'), /Unknown/);
});

test('shared mock order resource refreshes both visual layers in one normal provider flight', async (t) => {
  const client = new MockHyperTrackerClient();
  const requests = t.mock.method(client, 'request');
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), provider: client, providerPaths: { orders: 'unused-development-path' }, persistFixture: false });
  try {
    const results = await Promise.all(['stopLoss', 'takeProfit'].map(kind => app.refreshProvider(kind)));
    assert.ok(results.every(result => result.ok && result.levels === 96));
    assert.equal(requests.mock.callCount(), 1); assert.equal(requests.mock.calls[0].arguments[0], 'orders');
    assert.equal(app.state.layerMeta.stopLoss.revision, app.state.layerMeta.takeProfit.revision);
    assert.equal(app.state.layerMeta.stopLoss.mock, true); assert.equal(app.state.layerMeta.takeProfit.mock, true);
  } finally { await app.close(); }
});

test('provider mode is explicit, preserves the legacy opt-in, and mock overrides an enabled paid flag', () => {
  assert.equal(hyperTrackerMode(undefined, undefined), 'disabled');
  assert.equal(hyperTrackerMode('', 'false'), 'disabled');
  assert.equal(hyperTrackerMode(undefined, 'true'), 'live');
  assert.equal(hyperTrackerMode('disabled', 'true'), 'disabled');
  assert.equal(hyperTrackerMode('mock', 'true'), 'mock');
  assert.equal(hyperTrackerMode('mock', undefined), 'mock');
  assert.equal(hyperTrackerMode('live', 'true'), 'live');
  for (const enabled of [undefined, 'false', true]) assert.throws(() => hyperTrackerMode('live', enabled), /requires/);
  assert.throws(() => hyperTrackerMode('typo', 'true'), /must be/);
});

test('startup demo reference is used only until the first observed live mark and never hides later invalid marks', async (t) => {
  let state = { markPrice: 0, markObserved: false };
  const reference = createMockReferencePrice(() => state);
  assert.equal(reference(), 77300);
  state = { markPrice: 99999, markObserved: false };
  assert.equal(reference(), 77300);
  const quota = new QuotaLedger();
  const spend = t.mock.method(quota, 'spend', () => { throw new Error('mock startup must never spend quota'); });
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('mock startup must never request network'); });
  const client = new MockHyperTrackerClient({ referencePrice: reference });
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota, provider: client, liveMode: true, persistFixture: false });
  try {
    for (const kind of LAYERS) {
      const result = await app.refreshProvider(kind);
      assert.equal(result.ok, true); assert.equal(result.levels, 96); assert.equal(app.state.layerMeta[kind].mock, true);
    }
    state = { markPrice: 500, markObserved: true };
    assert.equal(reference(), 500);
    assert.equal((await app.refreshProvider('liquidation')).ok, true);
    assert.ok(app.state.layers.liquidation.every(row => row.price > 450 && row.price < 550));
    const good = structuredClone(app.state.layers.liquidation);
    state = { markPrice: 0, markObserved: true };
    assert.ok(Number.isNaN(reference()));
    assert.equal((await app.refreshProvider('liquidation')).ok, false);
    assert.deepEqual(app.state.layers.liquidation, good);
    state = { markPrice: 500, markObserved: false };
    assert.ok(Number.isNaN(reference()));
    assert.equal(spend.mock.callCount(), 0); assert.equal(network.mock.callCount(), 0);
  } finally { await app.close(); }
  assert.throws(() => createMockReferencePrice(() => state, 0), /Invalid mock demo/);
});


test('history candle reads omit malformed persisted OHLC rows', () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  try {
    const candle = { instrumentId: 'hyperliquid:BTC-PERP', interval: '1m', start: NOW, end: NOW + 60_000, open: 105, high: 110, low: 100, close: 108, volume: 10, closed: true, sourceTimestamp: NOW + 60_000, receivedAt: NOW + 60_001 };
    assert.equal(history.recordCandle(candle), true);
    assert.equal(history.listCandles(candle.instrumentId)[0]?.close, 108);
    history.db.prepare('UPDATE candle_samples SET low = ? WHERE instrument_id = ?').run(120, candle.instrumentId);
    assert.deepEqual(history.listCandles(candle.instrumentId), []);
  } finally { history.close(); }
});
