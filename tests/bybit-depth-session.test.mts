import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBybitDepthSessionMessage, createBybitDepthSession, invalidateBybitDepthSession } from '../src/adapters/bybit-depth-session.mts';
import { normalizeBybitDepth, normalizeBybitDepthDelta } from '../src/adapters/bybit.mts';

const topic = 'orderbook.1000.BTCUSDT'; const token = 'session-a'; const instrumentId = 'bybit:BTCUSDT';
function snapshot(u = 1, bid = '100') { return normalizeBybitDepth({ type: 'snapshot', ts: 1_700_000_000_000, data: { category: 'linear', s: 'BTCUSDT', u, b: [[bid, '2']], a: [['101', '3']] } }); }
function delta(u = 2) { return normalizeBybitDepthDelta({ type: 'delta', ts: 1_700_000_000_100, data: { category: 'linear', s: 'BTCUSDT', u, b: [['100', '0'], ['99', '1']], a: [] } }); }

function deltaWithRows(u = 2) { return normalizeBybitDepthDelta({ type: 'delta', ts: 1_700_000_000_100, data: { category: 'linear', s: 'BTCUSDT', u, seq: u + 100, b: [['100', '0'], ['98', '4']], a: [['101', '0'], ['102', '5']] } }); }

test('Bybit depth session accepts same-topic/session snapshots and deltas', () => {
  let session = createBybitDepthSession({ topic, instrumentId, sessionToken: token });
  const first = applyBybitDepthSessionMessage(session, { topic, sessionToken: token, update: snapshot() }); assert.equal(first.accepted, true); session = first.session;
  const next = applyBybitDepthSessionMessage(session, { topic, sessionToken: token, update: delta() }); assert.equal(next.accepted, true); assert.ok(next.session.book); assert.equal(next.session.book.sequence, 2);
  const duplicate = applyBybitDepthSessionMessage(next.session, { topic, sessionToken: token, update: delta(2) }); assert.equal(duplicate.accepted, false); assert.equal(duplicate.ignored, true); assert.equal(duplicate.reason, 'old-or-duplicate'); assert.strictEqual(duplicate.session, next.session); assert.strictEqual(duplicate.session.book, next.session.book);
  const older = applyBybitDepthSessionMessage(next.session, { topic, sessionToken: token, update: delta(1) }); assert.equal(older.accepted, false); assert.equal(older.reason, 'old-or-duplicate'); assert.strictEqual(older.session, next.session);
});

test('wrong topic, cross-session, and wrong instrument packets do not mutate session', () => {
  const session = createBybitDepthSession({ topic, instrumentId, sessionToken: token });
  for (const packet of [{ topic: 'orderbook.1000.ETHUSDT', sessionToken: token, reason: 'wrong-topic' }, { topic, sessionToken: 'session-b', reason: 'cross-session' }, { topic, sessionToken: token, reason: 'wrong-instrument' }]) {
    const result = applyBybitDepthSessionMessage(session, { ...packet, update: packet.reason === 'wrong-instrument' ? { ...snapshot(), instrumentId: 'bybit:ETHUSDT' } : snapshot() }); assert.equal(result.accepted, false); assert.equal(result.reason, packet.reason); assert.strictEqual(result.session, session);
  }
});

test('disconnect invalidates session and blocks deltas until a fresh snapshot resets state', () => {
  let session = createBybitDepthSession({ topic, instrumentId, sessionToken: token }); session = applyBybitDepthSessionMessage(session, { topic, sessionToken: token, update: snapshot(5) }).session;
  session = invalidateBybitDepthSession(session, 'socket closed'); assert.equal(session.status, 'resync-required'); assert.ok(session.book); assert.equal(session.book.resyncRequired, true);
  const blocked = applyBybitDepthSessionMessage(session, { topic, sessionToken: token, update: delta(6) }); assert.equal(blocked.accepted, false); assert.equal(blocked.reason, 'fresh-snapshot-required'); assert.strictEqual(blocked.session, session);
  const reset = applyBybitDepthSessionMessage(session, { topic, sessionToken: token, update: snapshot(1, '90') }); assert.equal(reset.accepted, true); assert.equal(reset.session.status, 'live'); assert.ok(reset.session.book); assert.equal(reset.session.book.sequence, 1); assert.equal(reset.session.book.resyncRequired, false); assert.deepEqual(reset.session.book.bids, [{ price: 90, amount: 2 }]);
});

test('pre-snapshot and retired-session frames cannot mutate the accepted book', () => {
  const fresh = createBybitDepthSession({ topic, instrumentId, sessionToken: token });
  const before = applyBybitDepthSessionMessage(fresh, { topic, sessionToken: token, update: deltaWithRows() });
  assert.equal(before.accepted, false); assert.equal(before.reason, 'fresh-snapshot-required'); assert.strictEqual(before.session, fresh);
  let live = applyBybitDepthSessionMessage(fresh, { topic, sessionToken: token, update: snapshot(10) }).session;
  const applied = applyBybitDepthSessionMessage(live, { topic, sessionToken: token, update: deltaWithRows(11) });
  assert.equal(applied.accepted, true); live = applied.session;
  assert.ok(live.book); const bidsBefore = structuredClone(live.book.bids); const asksBefore = structuredClone(live.book.asks);
  const retired = applyBybitDepthSessionMessage(live, { topic, sessionToken: 'retired-session', update: deltaWithRows(12) });
  assert.equal(retired.accepted, false); assert.equal(retired.reason, 'cross-session'); assert.strictEqual(retired.session, live);
  assert.ok(retired.session.book); assert.deepEqual(retired.session.book.bids, bidsBefore); assert.deepEqual(retired.session.book.asks, asksBefore);
  const wrongTopic = applyBybitDepthSessionMessage(live, { topic: 'orderbook.1000.ETHUSDT', sessionToken: token, update: deltaWithRows(12) });
  assert.equal(wrongTopic.accepted, false); assert.equal(wrongTopic.reason, 'wrong-topic'); assert.strictEqual(wrongTopic.session, live);
});
