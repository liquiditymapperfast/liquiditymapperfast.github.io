import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaLedger } from '../src/core/quota.mts';
import { HyperTrackerClient, MAX_HYPERTRACKER_RESPONSE_BYTES, MAX_HYPERTRACKER_RESPONSE_ROWS, buildHyperTrackerRequest, hyperTrackerCompleteness, hyperTrackerSourceTimestamp, normalizeHyperTrackerSnapshot, validateHyperTrackerPayload } from '../src/adapters/hypertracker.mts';
import { AdapterTransportError } from '../src/adapters/common.mts';

const jsonResponse = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });

test('HyperTracker descriptors require explicit paths for unverified layer exports', () => {
  const positions = buildHyperTrackerRequest('positionsHeatmap');
  assert.match(positions.pathname, /positions\/heatmap/);
  assert.equal(positions.kind, 'positionsHeatmap');
  assert.throws(() => buildHyperTrackerRequest('heatmap'), RangeError);
  assert.throws(() => buildHyperTrackerRequest('liquidation'), AdapterTransportError);
  assert.equal(buildHyperTrackerRequest('orders', { path: '/api/external/orders/latest' }).cost, 5);
});

test('positions heatmap cannot populate liquidation, stop-loss, or take-profit state', () => {
  const payload = { levels: [{ price: 80_000, positionValue: 10, side: 'long' }] };
  assert.equal(validateHyperTrackerPayload(payload, { kind: 'positionsHeatmap' }).rows.length, 1);
  const state = { layers: { liquidation: [], stopLoss: [], takeProfit: [] } };
  for (const layer of Object.keys(state.layers)) {
    assert.throws(
      () => normalizeHyperTrackerSnapshot(payload, { layer, sourceKind: 'positionsHeatmap' }),
      new RegExp(`positionsHeatmap data cannot populate ${layer} levels`),
    );
  }
  assert.deepEqual(state.layers, { liquidation: [], stopLoss: [], takeProfit: [] });
});

test('client request provenance reaches the normalizer and blocks position heatmap promotion', async () => {
  const client = new HyperTrackerClient({
    token: 'test-token', networkEnabled: true, ledger: new QuotaLedger({ limit: 5 }),
    fetchImpl: async () => (jsonResponse({ levels: [{ price: 80_000, positionValue: 10, side: 'long' }] }))
  });
  const payload = await client.request('positionsHeatmap');
  assert.equal(payload.sourceKind, 'positionsHeatmap');
  for (const layer of ['liquidation', 'stopLoss', 'takeProfit']) {
    assert.throws(() => normalizeHyperTrackerSnapshot(payload, { layer }), /positionsHeatmap data cannot populate/);
  }
});

test('client provenance preserves array responses for normalizer envelopes', async () => {
  const rows = [{ price: 80_000, notionalUsd: 10, side: 'short' }];
  let payload = rows;
  const client = new HyperTrackerClient({
    token: 'test-token', networkEnabled: true, ledger: new QuotaLedger({ limit: 10 }),
    fetchImpl: async () => (jsonResponse(payload))
  });
  const tagged = await client.request('liquidation', { path: '/verified/liquidation' });
  assert.deepEqual(tagged.levels, rows);
  assert.equal(tagged.sourceKind, 'liquidation');
  assert.equal(normalizeHyperTrackerSnapshot(tagged, { layer: 'liquidation' }).levels.length, 1);
  payload = [];
  const empty = await client.request('liquidation', { path: '/verified/liquidation' });
  assert.deepEqual(empty, { levels: [], sourceKind: 'liquidation' });
  assert.equal(normalizeHyperTrackerSnapshot(empty, { layer: 'liquidation' }).levels.length, 0);
});

test('legacy heatmap request fails before transport or quota spend', async () => {
  const ledger = new QuotaLedger({ limit: 5 });
  let fetchCalls = 0;
  const client = new HyperTrackerClient({
    token: 'test-token', networkEnabled: true, ledger,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
  });
  await assert.rejects(() => client.request('heatmap'), RangeError);
  assert.equal(fetchCalls, 0);
  assert.equal(ledger.snapshot().used, 0);
});

test('HyperTracker normalizer preserves bins, sides, USD units, and incompleteness', () => {
  const snapshot = normalizeHyperTrackerSnapshot({ levels: [
    { priceBinStart: '76000', priceBinEnd: '76100', liquidationValue: '1200000', positionsCount: 12, side: 'long' },
    { price: '78000', notionalUsd: '900000', positionsCount: 4, side: 'short' },
  ] }, { coin: 'BTC', layer: 'liquidation', referencePrice: 77300, complete: false, revision: 'r1' });
  assert.equal(snapshot.complete, false); assert.equal(snapshot.coverage, 'provider-sampled'); assert.equal(snapshot.units, 'USD notional'); assert.equal(snapshot.levels.length, 2); assert.equal(snapshot.levels[0].priceLow, 76000); assert.equal(snapshot.levels[0].side, 'long'); assert.equal(snapshot.levels[1].side, 'short');
});

test('HyperTracker normalizer filters other coins and preserves provider identities', () => {
  const snapshot = normalizeHyperTrackerSnapshot({ levels: [
    { id: 'pos-a', coin: 'BTC', price: 80000, notionalUsd: 10, side: 'short' },
    { id: 'pos-b', coin: 'BTC', price: 80000, notionalUsd: 20, side: 'short' },
    { id: 'other', coin: 'ETH', price: 80000, notionalUsd: 999, side: 'short' },
    { price: 81000, notionalUsd: 5, side: 'short' },
  ] }, { coin: 'BTC', layer: 'liquidation' });
  assert.equal(snapshot.levels.length, 3);
  assert.equal(new Set(snapshot.levels.map(level => level.id)).size, 3);
  const identified = snapshot.levels.find(level => level.id.includes('pos-a')); assert.ok(identified); assert.equal(identified.notionalUsd, 10);
  const anonymous = snapshot.levels.find(level => level.price === 81000); assert.ok(anonymous); assert.equal(anonymous.id, 'liquidation-BTC-short-81000-single-single');
});

test('HyperTracker normalizer preserves unknown source time as null', () => {
  const snapshot = normalizeHyperTrackerSnapshot({ levels: [{ price: 80000, notionalUsd: 10, side: 'short' }] }, { coin: 'BTC', layer: 'liquidation', sourceTimestamp: null, receivedAt: 1234, revision: 'unverified' });
  assert.equal(snapshot.sourceTimestamp, null); assert.equal(snapshot.levels[0].sourceTimestamp, undefined);
});

test('HyperTracker provenance rejects coercible malformed times but preserves decimal and ISO times', () => {
  for (const sourceTimestamp of [true, false, [], {}, '0x10', '', 'not-a-time', '2026-09-19T12:00:00', '2026-09-19 12:00:00', '2026-02-31T12:00:00Z', '2025-02-29T12:00:00Z', '2026-09-19T24:00:00Z']) {
    assert.equal(hyperTrackerSourceTimestamp({ sourceTimestamp }), null);
    assert.throws(() => normalizeHyperTrackerSnapshot({ sourceTimestamp, levels: [] }, { layer: 'liquidation' }), AdapterTransportError);
  }
  assert.equal(hyperTrackerSourceTimestamp({ sourceTimestamp: '1700000000000' }), 1_700_000_000_000);
  assert.equal(hyperTrackerSourceTimestamp({ timestamp: '2026-09-19T12:00:00.000Z' }), Date.parse('2026-09-19T12:00:00.000Z'));
  assert.equal(hyperTrackerSourceTimestamp({ timestamp: '2026-09-19T12:00:00+02:00' }), Date.parse('2026-09-19T12:00:00+02:00'));
  assert.equal(hyperTrackerSourceTimestamp({ timestamp: '2024-02-29T12:00:00Z' }), Date.parse('2024-02-29T12:00:00Z'));
});

test('HyperTracker validator rejects malformed envelopes, units, timestamps, and rows', () => {
  assert.throws(() => validateHyperTrackerPayload({ ok: true }, { kind: 'stopLoss' }), AdapterTransportError);
  assert.throws(() => validateHyperTrackerPayload({ levels: [], units: 'base' }, { kind: 'takeProfit' }), AdapterTransportError);
  assert.throws(() => validateHyperTrackerPayload({ levels: [], sourceTimestamp: 'not-a-time' }), AdapterTransportError);
  assert.throws(() => validateHyperTrackerPayload({ levels: [null] }), AdapterTransportError);
  assert.throws(() => validateHyperTrackerPayload({ levels: [{}] }, { kind: 'liquidation' }), AdapterTransportError);
  assert.throws(() => validateHyperTrackerPayload({ levels: [{ price: Infinity, notionalUsd: 1, side: 'short' }] }, { kind: 'liquidation' }), AdapterTransportError);
  assert.throws(() => validateHyperTrackerPayload({ levels: [{ price: 80_000, notionalUsd: Infinity, side: 'short' }] }, { kind: 'liquidation' }), AdapterTransportError);
});

test('HyperTracker validator distinguishes a valid empty snapshot', () => {
  const result = validateHyperTrackerPayload({ levels: [], complete: true, units: 'USD', sourceTimestamp: 1_700_000_000_000 }, { kind: 'liquidation' });
  assert.deepEqual(result, { rows: [], empty: true, units: 'USD notional' });
});

test('documented order snapshots filter ordinary orders and convert size at trigger price', () => {
  const payload = {
    orders: [
      { oid: 'sl-a', coin: 'BTC', side: 'A', orderType: 'Stop Market', triggerPx: '76000', sz: '2', timestamp: '2026-09-19T12:00:00.000Z' },
      { oid: 'tp-a', coin: 'BTC', side: 'B', orderType: 'Take Profit Limit', triggerPx: '79000', sz: '3' },
      { oid: 'ordinary', coin: 'BTC', side: 'A', orderType: 'Limit', limitPx: '75500', sz: '99' },
      { oid: 'other-coin', coin: 'ETH', side: 'A', orderType: 'Stop Market', triggerPx: '2000', sz: '5' },
    ],
    nextCursor: null,
  };
  const snapshot = normalizeHyperTrackerSnapshot(payload, { layer: 'stopLoss', sourceKind: 'stopLoss', coin: 'BTC', complete: hyperTrackerCompleteness(payload, { kind: 'stopLoss' }) });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.levels.map(({ id, side, price, amount, notionalUsd }) => ({ id, side, price, amount, notionalUsd })), [{ id: 'stopLoss-BTC-sell-sl-a', side: 'sell', price: 76000, amount: 2, notionalUsd: 152000 }]);
  assert.equal(snapshot.sourceTimestamp, Date.parse('2026-09-19T12:00:00.000Z'));
});

test('order rows retain their own ISO source timestamps when the envelope has none', () => {
  const payload = {
    orders: [
      { oid: 'sl-1', coin: 'BTC', side: 'A', orderType: 'Stop Market', triggerPx: 76_000, sz: 1, timestamp: '2026-09-19T12:00:00.000Z' },
      { oid: 'sl-2', coin: 'BTC', side: 'B', orderType: 'Stop Limit', triggerPx: 75_000, sz: 1, timestamp: '2026-09-19T12:05:00.000Z' },
    ],
    nextCursor: null,
  };
  const snapshot = normalizeHyperTrackerSnapshot(payload, { layer: 'stopLoss', sourceKind: 'stopLoss', complete: true });
  assert.equal(snapshot.sourceTimestamp, Date.parse('2026-09-19T12:05:00.000Z'));
  assert.deepEqual(snapshot.levels.map((row) => row.sourceTimestamp), [Date.parse('2026-09-19T12:00:00.000Z'), Date.parse('2026-09-19T12:05:00.000Z')]);
});

test('take-profit order normalization accepts contract sizes only with a contract value', () => {
  const payload = { orders: [{ oid: 'tp-contract', coin: 'BTC', side: 'B', orderType: 'Take Profit Market', triggerPx: 79_000, sz: 4, sizeUnit: 'contract', contractValue: 0.001 }], nextCursor: null };
  const snapshot = normalizeHyperTrackerSnapshot(payload, { layer: 'takeProfit', sourceKind: 'takeProfit', complete: true });
  assert.equal(snapshot.levels[0].side, 'buy');
  assert.equal(snapshot.levels[0].amount, 4);
  assert.equal(snapshot.levels[0].notionalUsd, 316);
});

test('order envelope units apply when rows omit a size unit', () => {
  const quote = normalizeHyperTrackerSnapshot({ units: 'quote', orders: [{ oid: 'quote', side: 'A', orderType: 'Stop Market', triggerPx: 76_000, sz: 2 }], nextCursor: null }, { layer: 'stopLoss', complete: true });
  assert.equal(quote.levels[0].notionalUsd, 2);
  const contracts = normalizeHyperTrackerSnapshot({ units: 'contracts', contractValue: 0.001, orders: [{ oid: 'contracts', side: 'B', orderType: 'Take Profit Market', triggerPx: 79_000, sz: 4 }], nextCursor: null }, { layer: 'takeProfit', complete: true });
  assert.equal(contracts.levels[0].notionalUsd, 316);
});

test('shared order validation uses limit price for an ordinary row with an inert trigger field', () => {
  assert.doesNotThrow(() => validateHyperTrackerPayload({ orders: [{ oid: 'ordinary', side: 'A', orderType: 'Limit', triggerPx: '0', isTrigger: false, limitPx: 75_000, sz: 1 }], nextCursor: null }, { kind: 'orders' }));
});

test('empty complete order envelopes retain declared units and clear safely', () => {
  const snapshot = normalizeHyperTrackerSnapshot({ units: 'quote', orders: [], nextCursor: null }, { layer: 'stopLoss', complete: true });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.levels, []);
});

test('order snapshots reject relevant rows without a trigger price or valid size', () => {
  assert.throws(() => validateHyperTrackerPayload({ orders: [{ oid: 'bad', side: 'A', orderType: 'Stop Limit', sz: 1 }] }, { kind: 'stopLoss' }), AdapterTransportError);
  assert.throws(() => validateHyperTrackerPayload({ orders: [{ oid: 'bad', side: 'A', orderType: 'Take Profit Limit', triggerPx: 79_000, sz: 1, sizeUnit: 'contract' }] }, { kind: 'takeProfit' }), AdapterTransportError);
});

test('order pagination is explicit and never silently marked complete', () => {
  assert.equal(hyperTrackerCompleteness({ orders: [], nextCursor: 'cursor-2' }, { kind: 'stopLoss' }), false);
  assert.equal(hyperTrackerCompleteness({ orders: [], nextCursor: null }, { kind: 'takeProfit' }), true);
  assert.equal(hyperTrackerCompleteness({ orders: [], complete: true, nextCursor: 'cursor-2' }, { kind: 'stopLoss' }), false);
  assert.throws(() => hyperTrackerCompleteness({ orders: [] }, { kind: 'stopLoss' }), AdapterTransportError);
});

test('HyperTracker payload validation rejects row collections above the bounded limit', () => {
  const rows = Array.from({ length: MAX_HYPERTRACKER_RESPONSE_ROWS + 1 }, () => ({ price: 1, notionalUsd: 1, side: 'long' }));
  assert.throws(() => validateHyperTrackerPayload({ levels: rows }, { kind: 'liquidation' }), new RegExp(`${MAX_HYPERTRACKER_RESPONSE_ROWS} rows`));
});

test('HyperTracker client rejects an oversized streamed body and cancels the reader', async () => {
  const ledger = new QuotaLedger({ limit: 10 });
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(MAX_HYPERTRACKER_RESPONSE_BYTES + 1))); },
    cancel() { canceled = true; },
  });
  const client = new HyperTrackerClient({ token: 'test-token', networkEnabled: true, ledger, fetchImpl: async () => new Response(body, { headers: new Headers() }) });
  await assert.rejects(() => client.request('orders', { path: '/api/external/orders/latest' }), (error) => error instanceof AdapterTransportError && error.message.includes(`${MAX_HYPERTRACKER_RESPONSE_BYTES} bytes`));
  assert.equal(canceled, true);
  assert.equal(ledger.snapshot().used, 5, 'failed response bodies remain charged under the existing quota contract');
});

test('HyperTracker client rejects an oversized declared body before reading it', async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{}')); },
    cancel() { canceled = true; },
  });
  const client = new HyperTrackerClient({ token: 'test-token', networkEnabled: true, ledger: new QuotaLedger({ limit: 10 }), fetchImpl: async () => new Response(body, { headers: new Headers({ 'content-length': String(MAX_HYPERTRACKER_RESPONSE_BYTES + 1) }) }) });
  await assert.rejects(() => client.request('orders', { path: '/api/external/orders/latest' }), (error) => error instanceof AdapterTransportError && error.message.includes(`${MAX_HYPERTRACKER_RESPONSE_BYTES} bytes`));
  assert.equal(canceled, true);
});
test('HyperTracker client spends before transport and charges failures', async () => {
  const ledger = new QuotaLedger({ limit: 5 }); let seen: { url: RequestInfo | URL; options?: RequestInit } | undefined;
  const client = new HyperTrackerClient({ token: 'test-token', networkEnabled: true, ledger, fetchImpl: async (url, options) => { seen = { url, options }; return jsonResponse({ levels: [] }); } });
  await client.request('orders', { path: '/api/external/orders/latest' }); assert.equal(ledger.snapshot().used, 5); assert.ok(seen?.options); assert.match(new Headers(seen.options.headers).get('authorization') ?? '', /^Bearer /); await assert.rejects(() => client.request('orders', { path: '/api/external/orders/latest' }), AdapterTransportError);
});
