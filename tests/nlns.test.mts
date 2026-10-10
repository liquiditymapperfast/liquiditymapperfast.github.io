import test from 'node:test';
import assert from 'node:assert/strict';
import { coinText, nlnsCandles, nlnsCardLines, oiDeltas } from '../src/app/delta/nlns.ts';
import { readDelta } from '../src/app/delta/settings.ts';
import type { OiBar } from '../src/app/store.ts';

const H = 3_600_000, T = Date.UTC(2026, 9, 9, 10);
const flow = (delta: number) => ({ delta, low: Math.min(0, delta), high: Math.max(0, delta), gross: Math.abs(delta) + 1 });
/** One sample a candle, as a minute bar holds: open = close. */
const bar = (t: number, oi: number): OiBar => [t, oi, oi, oi, oi];

test('the change of open interest is close to close of consecutive candles, even when each holds one sample; a gap has none', () => {
  const starts = [T, T + H, T + 2 * H, T + 3 * H];
  const d = oiDeltas([bar(T - H, 100), bar(T, 110), bar(T + H, 105), bar(T + 3 * H, 120)], starts, H);
  assert.deepEqual(d, [{ dOi: 10, oiStart: 100 }, { dOi: -5, oiStart: 110 }, null, null], 'the 2h bar is missing: no change there nor after it');
});

test('the four readings: open interest up or down, given to buyers or sellers at market', () => {
  const starts = [T, T + H, T + 2 * H, T + 3 * H], keys = starts.map(() => 0);
  const deltas = [{ dOi: 10, oiStart: 100 }, { dOi: 8, oiStart: 110 }, { dOi: -4, oiStart: 118 }, { dOi: -6, oiStart: 114 }];
  const c = nlnsCandles(starts, deltas, [flow(5e6), flow(-3e6), flow(-1e6), flow(2e6)], [0, 0, 0, 0], keys);
  assert.deepEqual(c.map(x => [x.kind, x.v, x.cum]), [['newLongs', 10, 10], ['newShorts', -8, 2], ['longsClosed', -4, -2], ['shortsClosed', 6, 4]]);
  assert.ok(c.every(x => !x.byPrice));
});

test('without the market\'s flow the price\'s way decides, and says so; a restart or a gap starts the sum again', () => {
  const starts = [T, T + H, T + 2 * H, T + 3 * H];
  const deltas = [{ dOi: 10, oiStart: 100 }, { dOi: 5, oiStart: 110 }, null, { dOi: 3, oiStart: 120 }];
  const c = nlnsCandles(starts, deltas, [null, flow(0), null, null], [-1, 1, 1, 1], [0, 0, 0, 0]);
  assert.deepEqual(c.map(x => [x.t, x.v, x.byPrice, x.cum, x.run]), [[T, -10, true, -10, 0], [T + H, 5, true, -5, 0], [T + 3 * H, 3, true, 3, 1]]);
  const daily = nlnsCandles(starts.slice(0, 2), deltas.slice(0, 2), [flow(1), flow(1)], [0, 0], [0, 1]);
  assert.deepEqual(daily.map(x => x.cum), [10, 5], 'a new day starts at 0');
});

test('the words: coins, signed and short; the popup gives the share of open interest and names the market', () => {
  assert.deepEqual([coinText(325.4, 'BTC'), coinText(-1_234_567, 'DOGE'), coinText(0.042, 'BTC'), coinText(0, '')], ['+325 BTC', '−1.2M DOGE', '+0.042 BTC', '0']);
  const [c] = nlnsCandles([T], [{ dOi: 92, oiStart: 92_000 }], [flow(-1)], [0], [0]);
  const lines = nlnsCardLines(c!, '1h', 'BTC', 'Binance BTCUSDT');
  assert.deepEqual(lines.slice(1, 5).map(l => [l.label, l.text]), [['Open interest', '+92 BTC · +0.10%'], ['Read as', 'New shorts'], ['Side', 'sellers at market'], ['Since the start', '−92 BTC']]);
  assert.match(lines[5]!.text, /Binance BTCUSDT/);
  assert.equal(readDelta({ style: 'nlns' }).style, 'nlns');
});
