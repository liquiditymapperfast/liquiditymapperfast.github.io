import test from 'node:test';
import assert from 'node:assert/strict';
import { clampGoTo, countdown, formatDateTime, lineSide, parseDateTime } from '../src/app/price-line.ts';
import type { CandleRow } from '../src/app/store.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

test('the countdown: time left in the candle under way, mm:ss below an hour and h:mm:ss from one', () => {
  const T = Date.UTC(2026, 9, 9, 14, 0, 0);
  assert.equal(countdown(T + 12_300, MIN), '00:48', '12.3 s into a minute: 47.7 s left, shown rounded up');
  assert.equal(countdown(T + 45 * MIN, HOUR), '15:00');
  assert.equal(countdown(T + 1_000, 4 * HOUR), '1:59:59', '4h candles open at 12:00 and 16:00 UTC');
  assert.equal(countdown(Date.UTC(2026, 9, 9, 22, 30), DAY), '1:30:00', 'a day closes at midnight UTC');
  assert.equal(countdown(Date.UTC(2026, 9, 9), DAY), '24:00:00', 'at the open, the whole day');
});

test('the price line follows the candle under way, and no candle or another market\'s means the plain colour', () => {
  const up: CandleRow = [0, 100, 110, 95, 105, 1], down: CandleRow = [0, 100, 110, 95, 99, 1];
  assert.equal(lineSide([down, up], 'x:BTC', 'x:BTC'), 'up');
  assert.equal(lineSide([up, down], 'x:BTC', 'x:BTC'), 'down');
  assert.equal(lineSide([[0, 100, 100, 100, 100, 0]], 'x:BTC', 'x:BTC'), 'up', 'unchanged counts as up, as the candles draw it');
  assert.equal(lineSide([], 'x:BTC', 'x:BTC'), null);
  assert.equal(lineSide([up], 'ref:BTC', 'x:BTC'), null, 'a borrowed reference series');
});

test('the date box reads and writes the page\'s clock, UTC or this computer\'s', () => {
  assert.equal(parseDateTime('2026-10-09T14:30', 'utc'), Date.UTC(2026, 9, 9, 14, 30));
  assert.equal(parseDateTime('2026-10-09T14:30', 'local'), new Date(2026, 9, 9, 14, 30).getTime());
  assert.equal(formatDateTime(Date.UTC(2026, 9, 9, 14, 30, 59), 'utc'), '2026-10-09T14:30');
  const t = Date.UTC(2026, 2, 29, 1, 15);
  assert.equal(parseDateTime(formatDateTime(t, 'local'), 'local'), t, 'round trip on this computer\'s clock');
  assert.equal(parseDateTime('', 'utc'), null);
  assert.equal(parseDateTime('9 Oct 2026', 'utc'), null);
});

test('go to: the moment, the start of what is held when earlier, the live edge when it is to come', () => {
  const now = Date.UTC(2026, 9, 9, 20), earliest = now - 3 * DAY;
  assert.deepEqual(clampGoTo(now - DAY, earliest, now), { t: now - DAY, clamped: null });
  assert.deepEqual(clampGoTo(now - 9 * DAY, earliest, now), { t: earliest, clamped: 'before' });
  assert.deepEqual(clampGoTo(now + HOUR, earliest, now), { t: now, clamped: 'live' });
  assert.deepEqual(clampGoTo(now - 9 * DAY, null, now), { t: now - 9 * DAY, clamped: null }, 'nothing known about the start: as asked');
});
