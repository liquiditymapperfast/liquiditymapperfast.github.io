import test from 'node:test';
import assert from 'node:assert/strict';
import { TRAP_PARAMS, canonicalStep, detectSide, scanTraps, trapText, typicalDelta, typicalRange } from '../src/app/traps.ts';
import type { Bar } from '../src/app/panes/footprint.ts';
import type { CandleRow } from '../src/app/store.ts';

const TF = 3_600_000, T0 = 1_000 * TF;
type Rows = [number, number, number][];
const bar = (t: number, rows: Rows, minutes = 60): Bar => ({ t, rows, buyUsd: rows.reduce((s, r) => s + r[1], 0), sellUsd: rows.reduce((s, r) => s + r[2], 0), minutes });
const candle = (t: number, o: number, h: number, l: number, c: number): CandleRow => [t, o, h, l, c, 1, 1];

/** `n` ordinary candles before the event: range `range`, a net delta of 1M each. */
function history(n: number, range = 7): { candles: CandleRow[]; bars: Map<number, Bar> } {
  const candles: CandleRow[] = [], bars = new Map<number, Bar>();
  for (let k = 0; k < n; k++) {
    const t = T0 + k * TF;
    candles.push(candle(t, 100, 100 + range / 2 + 0.5, 100 - range / 2 + 0.5, 101));
    bars.set(t, bar(t, [[100, 3e6, 2e6]]));
  }
  return { candles, bars };
}

/** Rows 106-109 carry 2.5M of net buying each (10M in all) in the upper wick of a candle that opened at 100 and closed at 99. */
const trappedBuyerRows = (): Rows => [[98, 1e5, 2e5], [99, 1e5, 3e5], ...[100, 101, 102, 103, 104, 105].map((p): [number, number, number] => [p, 2e5, 2e5]), ...[106, 107, 108, 109].map((p): [number, number, number] => [p, 3e6, 5e5])];
const buyersCandle = (t: number): CandleRow => candle(t, 100, 110, 98, 99);

function scan(event: { candle: CandleRow; bar: Bar }, setup: { candles: CandleRow[]; bars: Map<number, Bar> }, extra: CandleRow[] = [], now?: number) {
  const candles = [...setup.candles, event.candle, ...extra], bars = new Map(setup.bars); bars.set(event.bar.t, event.bar);
  const last = candles[candles.length - 1]!;
  return scanTraps({ candles, bars, step: 1, tfMs: TF, now: now ?? last[0] + TF + 20_000, from: event.candle[0], to: event.candle[0] + TF });
}

test('a wick that out-bought the rest of the candle, in a candle that closed far below, is flagged as possible trapped buyers', () => {
  const setup = history(24), t = T0 + 24 * TF;
  const [trap, ...others] = scan({ candle: buyersCandle(t), bar: bar(t, trappedBuyerRows()) }, setup);
  assert.equal(others.length, 0);
  assert.equal(trap!.side, 'buyers');
  assert.equal(trap!.t, t);
  assert.equal(trap!.zoneLow, 100); assert.equal(trap!.zoneHigh, 110);
  assert.ok(trap!.zoneDelta > 1e7 - 1, `zone delta ${trap!.zoneDelta}`);
  assert.ok(trap!.multiple > 9, `multiple ${trap!.multiple}`);
  assert.ok(trap!.entry > 105 && trap!.entry < 109, `entry ${trap!.entry}`);
  assert.ok(trap!.excursion > 0.5);
  assert.equal(trap!.state, 'active');
});

test('the lower wick is judged the same way with the sides swapped', () => {
  const setup = history(24), t = T0 + 24 * TF;
  // Opened at 100, fell to 90 on 10M of net selling in rows 90-93, closed at 101.
  const rows: Rows = [...[90, 91, 92, 93].map((p): [number, number, number] => [p, 5e5, 3e6]), ...[94, 95, 96, 97, 98, 99].map((p): [number, number, number] => [p, 2e5, 2e5]), [100, 3e5, 1e5], [101, 3e5, 1e5]];
  const found = scan({ candle: candle(t, 100, 102, 90, 101), bar: bar(t, rows) }, setup);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.side, 'sellers');
  assert.equal(found[0]!.zoneHigh, 100); assert.equal(found[0]!.zoneLow, 90);
  assert.ok(found[0]!.entry > 90 && found[0]!.entry < 94);
  assert.ok(found[0]!.excursion > 0.5);
});

test('buying that is not concentrated in the wick is not flagged', () => {
  const setup = history(24), t = T0 + 24 * TF;
  // The same wick, but a stretch of the body below the open out-bought it: 6 rows of 4M net each.
  const rows: Rows = [...[90, 91, 92, 93, 94, 95].map((p): [number, number, number] => [p, 5e6, 1e6]), ...[96, 97, 98, 99].map((p): [number, number, number] => [p, 1e5, 1e5]), ...trappedBuyerRows().filter(r => r[0] >= 100)];
  assert.deepEqual(scan({ candle: candle(t, 100, 110, 88, 99), bar: bar(t, rows) }, setup), []);
});

test('a close that is near where the wick bought is not flagged', () => {
  const setup = history(24, 20), t = T0 + 24 * TF; // a typical range of 20, so a drop of 8 is under half an ATR
  assert.deepEqual(scan({ candle: buyersCandle(t), bar: bar(t, trappedBuyerRows()) }, setup), []);
});

test('a candle seen only in part, or with too little history to compare against, is not flagged', () => {
  const setup = history(24), t = T0 + 24 * TF;
  assert.deepEqual(scan({ candle: buyersCandle(t), bar: bar(t, trappedBuyerRows(), 30) }, setup), [], 'half the minutes recorded');
  assert.deepEqual(scan({ candle: buyersCandle(t), bar: bar(t, trappedBuyerRows()) }, history(10)), [], 'too few candles for an ATR and a baseline');
  const partial = history(24); for (const [k, b] of partial.bars) partial.bars.set(k, { ...b, minutes: 10 });
  assert.deepEqual(scan({ candle: buyersCandle(t), bar: bar(t, trappedBuyerRows()) }, partial), [], 'the baseline candles were recorded only in part');
});

test('a candle is judged only once it has settled, and never while it forms', () => {
  const setup = history(24), t = T0 + 24 * TF, event = { candle: buyersCandle(t), bar: bar(t, trappedBuyerRows()) };
  assert.deepEqual(scan(event, setup, [], t + TF - 1), [], 'still forming');
  assert.deepEqual(scan(event, setup, [], t + TF + TRAP_PARAMS.settleMs - 1), [], 'just closed, late prints may still arrive');
  assert.equal(scan(event, setup, [], t + TF + TRAP_PARAMS.settleMs).length, 1);
});

test('a trap is reclaimed when a later candle closes back above the entry, and goes static once it is old', () => {
  const setup = history(24), t = T0 + 24 * TF, event = { candle: buyersCandle(t), bar: bar(t, trappedBuyerRows()) };
  const later = (k: number, close: number): CandleRow => candle(t + k * TF, 100, 112, 95, close);
  assert.equal(scan(event, setup, [later(1, 98)])[0]!.state, 'active');
  assert.equal(scan(event, setup, [later(1, 98), later(2, 110)])[0]!.state, 'reclaimed');
  const old = Array.from({ length: TRAP_PARAMS.pulseBars + 1 }, (_, k) => later(k + 1, 98));
  assert.equal(scan(event, setup, old)[0]!.state, 'static');
});

test('detection is a pure function of the rows it is given: the same rows give the same trap', () => {
  const setup = history(24), t = T0 + 24 * TF, c = buyersCandle(t);
  const a = detectSide('buyers', c, trappedBuyerRows(), 1, 7, 1e6), b = detectSide('buyers', c, [...trappedBuyerRows()].reverse(), 1, 7, 1e6);
  assert.ok(a);
  assert.deepEqual(a, b, 'the order the rows arrive in does not matter');
  assert.equal(detectSide('sellers', c, trappedBuyerRows(), 1, 7, 1e6), null, 'buying in an upper wick says nothing about trapped sellers');
  void setup;
});

test('the canonical step keeps a typical candle within the row limit and is a power-of-two multiple of the recorded step', () => {
  assert.equal(canonicalStep(0.5, 8), 0.5);
  assert.equal(canonicalStep(0.5, 32), 0.5);
  assert.equal(canonicalStep(0.5, 33), 1);
  assert.equal(canonicalStep(0.5, 100), 2);
  assert.equal(canonicalStep(0, 100), 0);
  for (const range of [3, 17, 80, 400, 5000]) { const s = canonicalStep(0.5, range); assert.ok(range / s <= TRAP_PARAMS.maxRows); assert.ok(Number.isInteger(Math.log2(s / 0.5))); }
});

test('typical range and typical delta need enough candles', () => {
  const { candles, bars } = history(24);
  assert.equal(typicalRange(candles, 24), 7);
  assert.equal(typicalRange(candles, 5), null);
  assert.equal(typicalDelta(bars, T0 + 24 * TF, TF), 1e6);
  assert.equal(typicalDelta(bars, T0 + 5 * TF, TF), null, 'only five candles before it');
});

test('the pop-up states the facts and what is not known', () => {
  const setup = history(24), t = T0 + 24 * TF;
  const trap = scan({ candle: buyersCandle(t), bar: bar(t, trappedBuyerRows()) }, setup)[0]!;
  const text = trapText(trap);
  assert.equal(text[0], 'Possible trapped buyers');
  assert.match(text[1]!, /net aggressive buying in the upper wick/);
  assert.match(text[2]!, /closed .* ATR below/);
  assert.match(text.join(' '), /underwater/);
  assert.equal(text.at(-1), 'Untested pattern, not a forecast.');
  assert.match(trapText({ ...trap, state: 'reclaimed' }).join(' '), /closed back through/);
});
