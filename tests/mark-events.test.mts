import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeMarkPayload, } from '../src/core/mark-events.mts';

const valid = (overrides = {}) => ({ markInstrumentId: 'hyperliquid:BTC-PERP', markPrice: 77_300, sessionId: 's1', sequence: 1, markObserved: true, ...overrides });

test('coalesced marks preserve distinct crossings and declare overflow', () => {
  const first = { event: 'mark', payload: valid({ sequence: 1, crossings: [{ levelId: 'a' }], crossingSequenceStart: 1 }) };
  const second = { event: 'mark', payload: valid({ sequence: 2, crossings: [{ levelId: 'b' }], crossingSequenceStart: 2 }) };
  const merged = mergeMarkPayload(first, second, 200);
  assert.deepEqual(merged.payload.crossings.map((row) => (row as { levelId: string }).levelId), ['a', 'b']);
  assert.equal(merged.payload.crossingsComplete, true);
  const overflow = mergeMarkPayload(merged, { event: 'mark', payload: valid({ sequence: 3, crossings: Array.from({ length: 205 }, (_, index) => ({ levelId: `x-${index}` })) }) }, 200);
  assert.equal(overflow.payload.crossings.length, 200);
  assert.equal(overflow.payload.crossingsComplete, false);
  assert.equal(overflow.payload.crossingsOverflow, true);
});

test('coalesced marks never carry crossings across a session or instrument change', () => {
  const oldSession = { event: 'mark', payload: valid({ sequence: 9, crossings: [{ levelId: 'old' }], crossingSequenceStart: 9, crossingSequenceEnd: 9 }) };
  const newSession = { event: 'mark', payload: valid({ sessionId: 's2', sequence: 1, crossings: [{ levelId: 'new' }], crossingSequenceStart: 1, crossingSequenceEnd: 1 }) };
  const merged = mergeMarkPayload(oldSession, newSession);
  assert.deepEqual(merged.payload.crossings.map((row) => (row as { levelId: string }).levelId), ['new']);
  assert.equal(merged.payload.crossingSequenceStart, 1);
  const newInstrument = { event: 'mark', payload: valid({ sequence: 2, markInstrumentId: 'binance:BTCUSDT', crossings: [{ levelId: 'other' }], crossingSequenceStart: 2, crossingSequenceEnd: 2 }) };
  const instrumentMerged = mergeMarkPayload(oldSession, newInstrument);
  assert.deepEqual(instrumentMerged.payload.crossings.map((row) => (row as { levelId: string }).levelId), ['other']);
});
