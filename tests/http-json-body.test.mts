import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { MockHyperTrackerClient } from '../src/adapters/hypertracker-mock.mts';

function postRefresh(base: string, body: string): Promise<{ status: number; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(`${base}/api/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body, 'utf8') },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.once('error', reject);
      response.once('end', () => {
        try {
          const payload: unknown = JSON.parse(text);
          resolve({ status: response.statusCode ?? 0, payload });
        } catch (error) { reject(error); }
      });
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

test('refresh POST rejects invalid JSON bodies before provider or quota work and preserves object/manual requests', { timeout: 10_000 }, async t => {
  const quota = new QuotaLedger({ filePath: ':memory:' });
  const provider = new MockHyperTrackerClient();
  const app = createLocalServer({
    quota, provider, history: new HistoryStore({ filePath: ':memory:' }),
    liveMode: false, persistFixture: false, fixtureTickAutostart: false,
    retainedBudgetIntervalMs: 60_000,
  });
  try {
    const address = await app.start(0);
    const base = `http://${address.address}:${address.port}`;
    const beforeQuota = quota.snapshot();
    const beforeStatus = structuredClone(app.state.statuses);
    const beforeLayers = structuredClone(app.state.layers);
    const requests = t.mock.method(provider, 'request');
    const snapshots = t.mock.method(quota, 'snapshot');
    const spend = t.mock.method(quota, 'spend', () => { throw new Error('Local mock refresh must not spend paid quota'); });
    const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Local mock refresh must not request external traffic'); });

    for (const body of ['null', '[]', '[{}]', '0', '1', '"BTC"', 'true', 'false', '{', '{"kind":', '   ']) {
      const response = await postRefresh(base, body);
      assert.equal(response.status, 400, body);
      assert.deepEqual(response.payload, { error: 'Refresh request body must be a JSON object' }, body);
      assert.equal(requests.mock.callCount(), 0, body);
      assert.equal(snapshots.mock.callCount(), 0, body);
      assert.equal(spend.mock.callCount(), 0, body);
      assert.equal(network.mock.callCount(), 0, body);
    }
    assert.deepEqual(app.state.statuses, beforeStatus);
    assert.deepEqual(app.state.layers, beforeLayers);

    const expectedDefaultCoin = (process.env.HL_DEFAULT_COIN || 'BTC').trim().toUpperCase();
    for (const [body, kind, coin, requestKind] of [
      ['', 'heatmap', expectedDefaultCoin, 'liquidation'],
      ['{}', 'heatmap', expectedDefaultCoin, 'liquidation'],
      ['{"kind":"takeProfit","coin":"BTC"}', 'takeProfit', 'BTC', 'takeProfit'],
    ]) {
      const response = await postRefresh(base, body);
      assert.equal(response.status, 202, body);
      const payload = response.payload;
      assert.ok(payload !== null && typeof payload === 'object' && 'ok' in payload && payload.ok === true);
      assert.ok('kind' in payload && payload.kind === kind);
      assert.ok('levels' in payload && payload.levels === 96);
      const call = requests.mock.calls.at(-1);
      assert.ok(call);
      assert.equal(call.arguments[0], requestKind);
      assert.equal(call.arguments[1]?.coin, coin);
    }
    assert.equal(requests.mock.callCount(), 3);
    assert.equal(spend.mock.callCount(), 0);
    assert.equal(network.mock.callCount(), 0);
    assert.deepEqual(quota.snapshot(), beforeQuota);
  } finally { await app.close(); }
});
