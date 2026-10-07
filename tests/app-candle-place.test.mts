import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMING_GAP_PX, candleBody, candleCentre } from '../src/app/candle-place.ts';

const HOUR = 3_600_000, START = 1_791_237_600_000;

/** A chart where one hour is `slotPx` px wide: ms per px, the body of a candle in ms, and the gap to keep in ms. */
function chart(slotPx: number) {
  const msPerPx = HOUR / slotPx, body = candleBody(slotPx);
  return { msPerPx, body, bodyMs: body * msPerPx, gapMs: FORMING_GAP_PX * msPerPx };
}
const centreAt = (slotPx: number, elapsedMs: number): number => { const c = chart(slotPx); return candleCentre(START, HOUR, START + elapsedMs, c.bodyMs, c.gapMs); };

test('every candle has the same body: most of its slot, never more than 40 px', () => {
  assert.equal(candleBody(50), 36);
  assert.equal(candleBody(120), 40, 'wide slots stop at 40 px');
  assert.equal(candleBody(0.5), 1, 'and a candle is never narrower than a pixel');
});

test('a closed candle is in the middle of its slot', () => {
  const c = chart(62);
  assert.equal(candleCentre(START - HOUR, HOUR, START + 5, c.bodyMs, c.gapMs), START - HOUR / 2);
  assert.equal(candleCentre(START, HOUR, START + HOUR, c.bodyMs, c.gapMs), START + HOUR / 2, 'at the instant its period ends');
});

test('the candle still forming starts packed against the one before it, and does not overlap it', () => {
  for (const slotPx of [20, 62, 100, 400]) {
    const c = chart(slotPx), centre = candleCentre(START, HOUR, START + 1, c.bodyMs, c.gapMs);
    const left = centre - c.bodyMs / 2, previousRight = START - HOUR / 2 + c.bodyMs / 2;
    assert.ok(left >= previousRight + c.gapMs - 1e-3 || centre === START + HOUR / 2, `slot ${slotPx}px: left edge ${left} against ${previousRight}`);
  }
});

test('it follows the newest trade: its right edge is "now" until it reaches the middle of its slot, then it stays', () => {
  const slotPx = 120, c = chart(slotPx), right = (elapsed: number) => centreAt(slotPx, elapsed) + c.bodyMs / 2;
  assert.ok(Math.abs(right(0.4 * HOUR) - (START + 0.4 * HOUR)) < 1, 'the right edge is at now');
  assert.ok(Math.abs(right(0.6 * HOUR) - (START + 0.6 * HOUR)) < 1);
  const middle = START + HOUR / 2;
  assert.equal(centreAt(slotPx, 0.95 * HOUR), middle, 'late in the period it is where a closed candle is');
  assert.ok(centreAt(slotPx, 0.2 * HOUR) <= middle);
});

test('where candles are close together the new one is packed and its trades are under it, never to its left', () => {
  const slotPx = 62, c = chart(slotPx), elapsed = 0.1 * HOUR, centre = centreAt(slotPx, elapsed);
  const left = centre - c.bodyMs / 2, now = START + elapsed;
  assert.ok(left <= START, 'its left edge is not past the start of its period, so no trade of the period is left of it');
  assert.ok(centre + c.bodyMs / 2 >= now, 'and its right edge is not before the newest trade');
});

test('the centre only moves right, and arrives at the middle of the slot as the period ends, so nothing jumps', () => {
  for (const slotPx of [30, 62, 120, 500]) {
    let previous = -Infinity;
    for (let step = 0; step <= 100; step++) {
      const centre = centreAt(slotPx, HOUR * step / 100 * 0.9999);
      assert.ok(centre >= previous - 1e-3, `slot ${slotPx}px, step ${step}`);
      previous = centre;
    }
    const c = chart(slotPx), last = candleCentre(START, HOUR, START + HOUR - 1, c.bodyMs, c.gapMs), closed = candleCentre(START, HOUR, START + HOUR, c.bodyMs, c.gapMs);
    assert.ok(Math.abs(last - closed) < 1, `slot ${slotPx}px: ${last} against ${closed}`);
  }
});

test('a slot too narrow for a body and a gap keeps the candle in the middle, and a clock behind the exchange keeps it packed', () => {
  const narrow = chart(3);
  assert.equal(candleCentre(START, HOUR, START + 100, narrow.bodyMs, narrow.gapMs), START + HOUR / 2);
  const c = chart(100), early = candleCentre(START, HOUR, START - 5_000, c.bodyMs, c.gapMs), packed = candleCentre(START, HOUR, START, c.bodyMs, c.gapMs);
  assert.equal(early, packed);
});
