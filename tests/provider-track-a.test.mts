import test from 'node:test';
import assert from 'node:assert/strict';
import { HyperTrackerClient, MAX_HYPERTRACKER_CURSOR_BYTES, hyperTrackerCompleteness, hyperTrackerSourceTimestamp, normalizeHyperTrackerSnapshot, validateHyperTrackerPayload, type HyperTrackerOrderSnapshotOptions } from '../src/adapters/hypertracker.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { AdapterTransportError } from '../src/adapters/common.mts';

const SNAPSHOT = Date.parse('2026-10-01T12:00:00.000Z');
const CREATED = '2023-09-29T09:59:26.471Z';
const PATH = '/api/external/orders/5m-snapshots/latest';
function order(oid: string | number, fields: Record<string, unknown> = {}) {
  return { oid, coin: 'BTC', side: 'A', orderType: 'Stop Market', triggerPx: 76_000, sz: 2, timestamp: CREATED, snapshotTs: SNAPSHOT, ...fields };
}
function page(orders: unknown[], nextCursor: unknown, fields: Record<string, unknown> = {}) { return { orders, nextCursor, snapshotTs: SNAPSHOT, units: 'base', ...fields }; }
function clientFor(pages: unknown[], limit = 100) {
  const urls: URL[] = [], ledger = new QuotaLedger({ limit });
  const client = new HyperTrackerClient({ token: 'injected-test-token', ledger, networkEnabled: true, fetchImpl: async input => {
    urls.push(new URL(String(input)));
    const payload = pages[urls.length - 1];
    if (payload instanceof Response) return payload;
    if (payload instanceof Error) throw payload;
    assert.notEqual(payload, undefined, 'unexpected additional provider request');
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  } });
  return { client, urls, ledger };
}

test('pagination declarations reject malformed tokens and never complete contradictory missing-row claims', () => {
  for (const nextCursor of [false, 0, {}, [], '', ' ', ' token ', '\u0000', 'x'.repeat(MAX_HYPERTRACKER_CURSOR_BYTES + 1)]) {
    assert.throws(() => hyperTrackerCompleteness({ orders: [], nextCursor }), AdapterTransportError);
  }
  assert.equal(hyperTrackerCompleteness({ orders: [], nextCursor: null, hasMore: true, complete: true }), false);
  assert.equal(hyperTrackerCompleteness({ orders: [], nextCursor: null, complete: false }), false);
  assert.equal(hyperTrackerCompleteness({ orders: [], nextCursor: 'next', complete: true }), false);
  assert.throws(() => hyperTrackerCompleteness({ orders: [], nextCursor: null, meta: { nextCursor: 'other' } }), /contradictory/);
  assert.throws(() => hyperTrackerCompleteness({ orders: [], nextCursor: null, hasMore: 'false' }), /invalid pagination/);
});

test('documented snapshotTs supplies order observation time independently of order creation time', () => {
  const raw = page([order('old-order')], null);
  assert.equal(hyperTrackerSourceTimestamp(raw), SNAPSHOT);
  const normalized = normalizeHyperTrackerSnapshot(raw, { layer: 'stopLoss', sourceKind: 'orders', complete: true });
  assert.equal(normalized.sourceTimestamp, SNAPSHOT);
  assert.equal(normalized.levels[0].sourceTimestamp, SNAPSHOT);
  assert.equal(normalized.levels[0].notionalUsd, 152_000);
  assert.throws(() => validateHyperTrackerPayload(page([order('a'), order('b', { snapshotTs: SNAPSHOT + 300_000 })], null), { kind: 'orders' }), /mixes snapshot/);
  assert.throws(() => validateHyperTrackerPayload(page([order('a')], null, { sourceTimestamp: SNAPSHOT + 300_000 }), { kind: 'orders' }), /mixes snapshot/);
  assert.throws(() => validateHyperTrackerPayload(page([order('a', { snapshotTs: false })], null), { kind: 'orders' }), /snapshotTs/);
});

test('provider wire numbers and sides reject coercible substitutes for actual levels', () => {
  for (const price of [true, [], {}, '', '0x10']) assert.throws(() => validateHyperTrackerPayload({ levels: [{ price, notionalUsd: 1, side: 'long' }] }), /invalid level/);
  for (const notionalUsd of [false, [], {}, '']) assert.throws(() => validateHyperTrackerPayload({ levels: [{ price: 100, notionalUsd, side: 'long' }] }), /invalid level/);
  for (const side of ['not-short', 'long-or-short', true]) assert.throws(() => validateHyperTrackerPayload({ levels: [{ price: 100, notionalUsd: 1, side }] }), /invalid level/);
});

test('complete orders collect coherent pages once, pin latest time and share a bounded normalization source', async () => {
  const cursor = 'opaque&cursor?=1';
  const { client, ledger, urls } = clientFor([page([order('sl')], cursor), page([order('tp', { orderType: 'Take Profit Limit', side: 'B', triggerPx: 79_000, sz: 3 })], null)]);
  const raw = await client.requestOrdersSnapshot({ path: PATH, maxCost: 10 });
  assert.equal(raw.complete, true); assert.equal(raw.nextCursor, null); assert.equal(raw.pages, 2); assert.equal(raw.requestCost, 10);
  assert.equal(ledger.snapshot().used, 10); assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get('coin'), 'BTC'); assert.equal(urls[1].searchParams.get('coin'), 'BTC');
  assert.equal(urls[1].searchParams.get('nextCursor'), cursor);
  assert.equal(decodeURIComponent(urls[1].pathname), '/api/external/orders/5m-snapshots/' + new Date(SNAPSHOT).toISOString());
  const stop = normalizeHyperTrackerSnapshot(raw, { layer: 'stopLoss', sourceKind: 'orders', complete: true });
  const profit = normalizeHyperTrackerSnapshot(raw, { layer: 'takeProfit', sourceKind: 'orders', complete: true });
  assert.deepEqual(stop.levels.map(row => [row.id, row.notionalUsd]), [['stopLoss-BTC-sell-sl', 152_000]]);
  assert.deepEqual(profit.levels.map(row => [row.id, row.notionalUsd]), [['takeProfit-BTC-buy-tp', 237_000]]);
  assert.equal(stop.sourceTimestamp, SNAPSHOT); assert.equal(profit.sourceTimestamp, SNAPSHOT);
});

test('complete-order default spend ceiling rejects an unfinished first page without sending another', async () => {
  const { client, ledger, urls } = clientFor([page([order('a')], 'next')]);
  await assert.rejects(client.requestOrdersSnapshot({ path: PATH }), /budget exhausted before pagination/);
  assert.equal(urls.length, 1); assert.equal(ledger.snapshot().used, 5);
});

test('bounded order pages fail closed for repeated cursors and missing continuation identity', async t => {
  await t.test('cursor repetition', async () => {
    const { client, ledger, urls } = clientFor([page([order('a')], 'same'), page([order('b')], 'same')]);
    await assert.rejects(client.requestOrdersSnapshot({ path: PATH, maxCost: 20 }), /cursor repeated/);
    assert.equal(urls.length, 2); assert.equal(ledger.snapshot().used, 10);
  });
  await t.test('bounded page limit', async () => {
    const { client, urls } = clientFor([page([order('a')], 'next')]);
    await assert.rejects(client.requestOrdersSnapshot({ path: PATH, maxCost: 20, maxPages: 1 }), /page limit/);
    assert.equal(urls.length, 1);
  });
  await t.test('unknown snapshot observation', async () => {
    const { client, urls } = clientFor([{ orders: [order('a', { snapshotTs: undefined })], nextCursor: 'next' }]);
    await assert.rejects(client.requestOrdersSnapshot({ path: PATH, maxCost: 20 }), /no usable cursor or snapshot/);
    assert.equal(urls.length, 1);
  });
  await t.test('has-more with terminal cursor', async () => {
    const { client, urls } = clientFor([page([order('a')], null, { hasMore: true })]);
    await assert.rejects(client.requestOrdersSnapshot({ path: PATH, maxCost: 20 }), /no usable cursor or snapshot/);
    assert.equal(urls.length, 1);
  });
});

test('changed snapshots, units, identities, coins and malformed later rows never produce a complete replacement', async t => {
  const cases = [
    ['snapshot changed', page([order('b', { snapshotTs: SNAPSHOT + 300_000 })], null, { snapshotTs: SNAPSHOT + 300_000 }), /does not match its pinned request timestamp/],
    ['units changed', page([order('b')], null, { units: 'quote' }), /envelope units/],
    ['duplicate identity', page([order('a')], null), /duplicate provider identity/],
    ['unsafe identity', page([order(Number.MAX_SAFE_INTEGER + 1)], null), /safe provider identity/],
    ['foreign coin', page([order('b', { coin: 'ETH' })], null), /coin filter/],
    ['coin suffix alias', page([order('b', { coin: 'BTCUSDT' })], null), /coin filter/],
    ['coin prefix alias', page([order('b', { coin: 'OTHER:BTCJUNK' })], null), /coin filter/],
    ['missing documented coin', page([order('b', { coin: undefined, symbol: 'BTC' })], null), /coin filter/],
    ['invalid later row', page([order('b', { triggerPx: false })], null), /invalid level row/],
  ] as const;
  for (const [name, second, message] of cases) await t.test(name, async () => {
    const { client, ledger, urls } = clientFor([page([order('a')], 'next'), second]);
    await assert.rejects(client.requestOrdersSnapshot({ path: PATH, maxCost: 10 }), message);
    assert.equal(urls.length, 2); assert.equal(ledger.snapshot().used, 10, 'sent error pages remain charged locally');
  });
});

test('total row and decoded-body limits apply across the complete order operation', async t => {
  await t.test('rows', async () => {
    const { client, ledger } = clientFor([page([order('a')], 'next'), page([order('b')], null)]);
    await assert.rejects(client.requestOrdersSnapshot({ path: PATH, maxCost: 10, maxRows: 1 }), /total row limit/);
    assert.equal(ledger.snapshot().used, 10);
  });
  await t.test('decoded bytes', async () => {
    const first = page([order('a')], 'next'), second = page([order('b')], null);
    const ceiling = Buffer.byteLength(JSON.stringify(first), 'utf8') + Buffer.byteLength(JSON.stringify(second), 'utf8') - 1;
    const { client, ledger } = clientFor([first, second]);
    await assert.rejects(client.requestOrdersSnapshot({ path: PATH, maxCost: 10, maxBytes: ceiling }), /exceeds .* bytes/);
    assert.equal(ledger.snapshot().used, 10);
  });
});

test('rate-limit and transport failures stay charged with no implicit retry and dispose their response bodies', async t => {
  await t.test('429', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
    const { client, ledger, urls } = clientFor([page([order('a')], 'next'), new Response(body, { status: 429 })]);
    await assert.rejects(client.requestOrdersSnapshot({ path: PATH, maxCost: 20 }), /HTTP 429/);
    assert.equal(ledger.snapshot().used, 10); assert.equal(urls.length, 2); assert.equal(canceled, true);
  });
  await t.test('transport rejection', async () => {
    const { client, ledger, urls } = clientFor([new Error('injected offline')]);
    await assert.rejects(client.requestOrdersSnapshot({ path: PATH, maxCost: 20 }), /injected offline/);
    assert.equal(ledger.snapshot().used, 5); assert.equal(urls.length, 1);
  });
});

test('durable automatic half-budget admission blocks an extra page even with a larger operation ceiling', async () => {
  const { client, ledger, urls } = clientFor([page([order('a')], 'next'), page([order('b')], 'third')], 20);
  await assert.rejects(client.requestOrdersSnapshot({ path: PATH, maxCost: 15, automatic: true }), /automatic budget reserved/);
  assert.equal(ledger.snapshot().used, 10); assert.equal(urls.length, 2);
  assert.equal(ledger.snapshot().requests.reduce((total, entry) => total + (entry.automatic ? entry.cost : 0), 0), 10);
});

test('provider generation cancellation runs before every page and prevents another charge', async () => {
  const { client, ledger, urls } = clientFor([page([order('a')], 'next')]);
  let admittedPages = 0;
  await assert.rejects(client.requestOrdersSnapshot({ path: PATH, maxCost: 10, beforePage() { if (++admittedPages === 2) throw new Error('provider changed'); } }), /provider changed/);
  assert.equal(urls.length, 1); assert.equal(ledger.snapshot().used, 5);
});

test('invalid pagination options and mid-page paths reject without transport or charge', async () => {
  const { client, ledger, urls } = clientFor([]);
  const cases: HyperTrackerOrderSnapshotOptions[] = [{ maxCost: 0 }, { maxPages: 17 }, { maxRows: 8193 }, { maxBytes: 1_048_577 }, { path: PATH + '?nextCursor=middle' }, { path: '//other.invalid/orders' }];
  for (const options of cases) await assert.rejects(client.requestOrdersSnapshot({ path: PATH, ...options }), AdapterTransportError);
  assert.equal(urls.length, 0); assert.equal(ledger.snapshot().used, 0);
  const disabled = new HyperTrackerClient({ token: 'injected-test-token', ledger, networkEnabled: false, fetchImpl: async () => { throw new Error('unexpected network'); } });
  await assert.rejects(disabled.requestOrdersSnapshot({ path: PATH }), /disabled/);
  assert.equal(ledger.snapshot().used, 0);
});

test('a coherent empty terminal order snapshot remains an explicit empty success', async () => {
  const { client, ledger } = clientFor([page([], null)]);
  const raw = await client.requestOrdersSnapshot({ path: PATH });
  assert.equal(raw.complete, true); assert.deepEqual(raw.orders, []); assert.equal(raw.sourceTimestamp, SNAPSHOT);
  assert.deepEqual(normalizeHyperTrackerSnapshot(raw, { layer: 'takeProfit', sourceKind: 'orders', complete: true }).levels, []);
  assert.equal(ledger.snapshot().used, 5);
});

test('complete order envelopes cannot hide invalid orders behind another valid row collection', async () => {
  const { client, ledger } = clientFor([{ levels: [], orders: [order('hidden')], nextCursor: null, snapshotTs: SNAPSHOT }]);
  await assert.rejects(client.requestOrdersSnapshot({ path: PATH }), /ambiguous row collections/);
  assert.equal(ledger.snapshot().used, 5);
});

test('documented pinned empty final pages preserve the first snapshot identity and unknown latest empties fail closed', async () => {
  const { client, ledger } = clientFor([page([order('a')], 'next'), { orders: [], nextCursor: null, units: 'base' }]);
  const raw = await client.requestOrdersSnapshot({ path: PATH, maxCost: 10 });
  assert.equal(raw.complete, true); assert.equal(raw.sourceTimestamp, SNAPSHOT); assert.equal(raw.pages, 2);
  assert.equal(normalizeHyperTrackerSnapshot(raw, { layer: 'stopLoss', sourceKind: 'orders', complete: true }).levels.length, 1);
  assert.equal(ledger.snapshot().used, 10);
  const unverified = clientFor([{ orders: [], nextCursor: null }]);
  await assert.rejects(unverified.client.requestOrdersSnapshot({ path: PATH }), /did not declare a snapshot observation/);
  assert.equal(unverified.ledger.snapshot().used, 5);
});
