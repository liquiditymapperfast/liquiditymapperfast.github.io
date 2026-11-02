import test from 'node:test';
import assert from 'node:assert/strict';
import { DeribitConnector } from '../src/shared/venues.ts';

test('Deribit is sent a small request a minute (it closes a socket that only listens every 10 minutes), and its answer changes nothing', () => {
  const deribit = new DeribitConnector(), ka = deribit.keepalive();
  assert.ok(ka);
  assert.equal(ka.everyMs, 60_000);
  assert.deepEqual(ka.frame(), { jsonrpc: '2.0', id: 2, method: 'public/test' });
  // The answer to it (no `params`) is passed over: no throw, no book.
  deribit.onMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { version: '1.2.26' }, usIn: 1, usOut: 2, usDiff: 1, testnet: false }));
  assert.equal(deribit.valued(Date.now()), null);
});
