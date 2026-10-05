import test from 'node:test';
import assert from 'node:assert/strict';
import { candleSpan } from '../src/app/candle-span.ts';

const HOUR = 3_600_000, START = 1_791_237_600_000;

test('a closed candle covers its whole slot', () => {
  assert.deepEqual(candleSpan(START - HOUR, HOUR, START + 5), { from: START - HOUR, to: START, forming: false });
  assert.deepEqual(candleSpan(START, HOUR, START + HOUR), { from: START, to: START + HOUR, forming: false }, 'at the instant its period ends');
});

test('the candle still forming covers only what has happened, so its own trades are on it', () => {
  const now = START + 52 * 60_000;
  const span = candleSpan(START, HOUR, now);
  assert.deepEqual(span, { from: START, to: now, forming: true });
  // centred on the elapsed part: a trade a minute ago is within the candle's span
  assert.ok(now - 60_000 >= span.from && now - 60_000 <= span.to);
  assert.ok(span.from + (span.to - span.from) / 2 < now, 'its centre is not in the future');
});

test('when the period ends the forming candle and the closed one are the same, so nothing jumps', () => {
  const justBefore = candleSpan(START, HOUR, START + HOUR - 1), closed = candleSpan(START, HOUR, START + HOUR);
  assert.equal(justBefore.from, closed.from);
  assert.ok(Math.abs(justBefore.to - closed.to) <= 1);
});

test('a clock behind the exchange keeps a sliver rather than a candle that ends before it starts', () => {
  const span = candleSpan(START, HOUR, START - 5_000);
  assert.equal(span.forming, true);
  assert.ok(span.to > span.from);
});
