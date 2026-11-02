import test from 'node:test';
import assert from 'node:assert/strict';
import { clipCoverage, decodeHour, footprintVolume, fullerFootprint, ownsMinute, ownsTime, planAbsorption, planCoverage, planFootprint, tradeImport, within } from '../src/app/browser/history-import.ts';
import type { FootprintMinuteRow } from '../src/shared/footprint.ts';
import type { AbsorptionGroup, AbsorptionMinute } from '../src/shared/absorption.ts';
import type { CoverageRow } from '../src/shared/coverage.ts';
import { HOUR_MS } from '../src/app/browser/history-import.ts';

const HOUR = 1_793_574_000_000;

/** One hour file of hand-made records of kinds 7, 8 and 9, laid out as hlm-history's rows.rs writes them. */
function footprintFile(hour: number): ArrayBuffer {
  const file: number[] = [0x48, 0x4c, 0x4d, 0x43, 1, 0, 0, 0];
  let out = file;
  const put = (size: number, set: (view: DataView) => void): void => { const b = new Uint8Array(size); set(new DataView(b.buffer)); out.push(...b); };
  const u8 = (v: number): void => { out.push(v & 255); };
  const u32 = (v: number): void => put(4, d => d.setUint32(0, v, true));
  const i32 = (v: number): void => put(4, d => d.setInt32(0, v, true));
  const i64 = (v: number): void => put(8, d => d.setBigInt64(0, BigInt(v), true));
  const f64 = (v: number): void => put(8, d => d.setFloat64(0, v, true));
  i64(hour);
  const record = (kind: number, id: string, body: () => void): void => {
    const rec: number[] = []; out = rec;
    u8(kind); u8(id.length); for (const c of id) u8(c.charCodeAt(0)); body();
    out = file; u32(rec.length); file.push(...rec);
  };
  record(7, 'bybit:BTCUSDT', () => {
    i64(hour + 60_000); f64(0.5); u32(2);
    i32(156_000); f64(30_000); f64(0); u32(1); u32(0);
    i32(156_001); f64(0); f64(1_250.5); u32(0); u32(2);
    u8(1); u32(1); u32(2);
    for (let i = 0; i < 8; i++) f64(i === 1 ? 30_000 : 0);
    for (let i = 0; i < 8; i++) f64(i === 0 ? 1_250.5 : 0);
    u32(1); f64(30_000);
  });
  record(7, 'okx:BTC-USDT-SWAP', () => { i64(hour + 120_000); f64(0.5); u32(1); i32(156_010); f64(10); f64(20); u32(0); u32(0); u8(0); });
  record(8, 'bybit:BTCUSDT', () => {
    i64(hour + 61_000); u8(0); f64(78_000.5); u32(2);
    f64(60_000); f64(40_000); u32(2); i64(hour + 61_000); i64(hour + 61_004);
    f64(30_000); f64(70_000); u32(3); i64(hour + 61_000); i64(hour + 61_009);
  });
  record(9, 'bybit:BTCUSDT', () => { i64(hour + 60_000); u32(12); f64(5_000.25); f64(1e9); f64(25_000); });
  // Not sane: a step of 0, a group whose credits rise, a minute off the minute.
  record(7, 'bad:a', () => { i64(hour); f64(0); u32(1); i32(1); f64(1); f64(1); u32(0); u32(0); u8(0); });
  record(8, 'bad:b', () => { i64(hour); u8(1); f64(1); u32(2); f64(10); f64(10); u32(1); i64(hour); i64(hour); f64(20); f64(30); u32(2); i64(hour); i64(hour); });
  record(9, 'bad:c', () => { i64(hour + 1); u32(1); f64(1); f64(0); f64(1); });
  return Uint8Array.from(file).buffer;
}

test('footprint minutes and absorption groups and minutes read back as the page stores them; insane ones are left out', () => {
  const rows = decodeHour(footprintFile(HOUR))!.rows;
  assert.equal(rows.footprint.length, 2);
  assert.equal(rows.hour, HOUR);
  const [a, b] = rows.footprint;
  assert.deepEqual(a, {
    inst: 'bybit:BTCUSDT', t: HOUR + 60_000, step: 0.5, bins: [[156_000, 30_000, 0, 1, 0], [156_001, 0, 1_250.5, 0, 2]],
    stats: { buyN: 1, sellN: 2, buy: [0, 30_000, 0, 0, 0, 0, 0, 0], sell: [1_250.5, 0, 0, 0, 0, 0, 0, 0], v: 2, big: [30_000] },
  });
  assert.equal(b!.stats, null);
  assert.deepEqual(rows.absorption, [{ id: 'bybit:BTCUSDT', side: 'sell', price: 78_000.5, t0: HOUR + 61_000, steps: [[60_000, 40_000, 2, HOUR + 61_000, HOUR + 61_004], [30_000, 70_000, 3, HOUR + 61_000, HOUR + 61_009]] }]);
  assert.deepEqual(rows.absorptionMinutes, [{ id: 'bybit:BTCUSDT', t: HOUR + 60_000, n: 12, mean: 5_000.25, m2: 1e9, floor: 25_000 }]);
  // A group is kept with the minute of its first fill.
  assert.equal(within(rows, HOUR + 60_000, HOUR + 120_000).absorption.length, 1);
  assert.equal(within(rows, HOUR + 62_000, Infinity).absorption.length, 0);
});

const fpRow = (inst: string, t: number, usd: number, step = 0.5): FootprintMinuteRow => ({ inst, t, step, bins: [[156_000, usd, 0, 1, 0]], stats: null });

test('footprint minutes are taken where the page did not record the whole minute, on its step, and only when fuller', () => {
  const t0 = HOUR;
  // The page recorded bybit from 00:01:30 on, on a step of 0.5.
  const state = tradeImport([{ inst: 'bybit:BTCUSDT', metric: 'trades', from: t0 + 90_000, to: t0 + 600_000 }, { inst: 'x', metric: 'depth', from: 0, to: Infinity }], [{ inst: 'bybit:BTCUSDT', step: 0.5 }]);
  const held = new Map([[`bybit:BTCUSDT|${t0 + 60_000}`, fpRow('bybit:BTCUSDT', t0 + 60_000, 500)]]);
  const taken = planFootprint(state, [
    fpRow('bybit:BTCUSDT', t0, 100), // before the page: taken
    fpRow('bybit:BTCUSDT', t0 + 60_000, 400), // the page's part of the minute holds more: not taken
    fpRow('bybit:BTCUSDT', t0 + 60_000, 900), // more than the page's part: taken
    fpRow('bybit:BTCUSDT', t0 + 120_000, 900), // the page recorded the whole minute: not taken
    fpRow('bybit:BTCUSDT', t0 + 180_000, 9, 1), // another step: never re-binned
    fpRow('okx:BTC-USDT-SWAP', t0, 50, 2), // no rows of okx on the page: the service's step is taken
    fpRow('okx:BTC-USDT-SWAP', t0 + 60_000, 50, 0.5),
    fpRow('okx:BTC-USDT-SWAP', t0, 40, 2), // a second, thinner copy of a minute (a restart): the fuller stays
  ], key => held.get(key));
  assert.deepEqual(taken.map(r => [r.inst, r.t - t0, footprintVolume(r)]), [['bybit:BTCUSDT', 0, 100], ['bybit:BTCUSDT', 60_000, 900], ['okx:BTC-USDT-SWAP', 0, 50]]);
  assert.equal(state.steps.get('okx:BTC-USDT-SWAP'), 2);
  assert.ok(ownsTime(state, 'bybit:BTCUSDT', t0 + 90_000) && !ownsTime(state, 'bybit:BTCUSDT', t0 + 89_999));
  assert.ok(ownsMinute(state, 'bybit:BTCUSDT', t0 + 120_000) && !ownsMinute(state, 'bybit:BTCUSDT', t0 + 60_000));
});

test('absorption minutes come with their own groups, only where the page did not record the whole minute', () => {
  const state = tradeImport([{ inst: 'a', metric: 'trades', from: HOUR + 60_000, to: HOUR + 120_000 }], []);
  const minute = (id: string, t: number): AbsorptionMinute => ({ id, t, n: 1, mean: 1, m2: 0, floor: 25_000 });
  const group = (id: string, t0: number): AbsorptionGroup => ({ id, side: 'buy', price: 1, t0, steps: [[30_000, 30_000, 1, t0, t0]] });
  const plan = planAbsorption(state, [minute('a', HOUR), minute('a', HOUR + 60_000), minute('b', HOUR + 60_000)], [group('a', HOUR + 59_999), group('a', HOUR + 60_000), group('b', HOUR + 60_500), group('b', HOUR + 120_000)]);
  assert.deepEqual([...plan.keys()], [`a|${HOUR}`, `b|${HOUR + 60_000}`]);
  assert.deepEqual(plan.get(`a|${HOUR}`)!.groups.map(g => g.t0), [HOUR + 59_999]);
  assert.deepEqual(plan.get(`b|${HOUR + 60_000}`)!.groups.map(g => g.t0), [HOUR + 60_500], 'a group of a minute not sent stays out');
});

test('the service coverage joins only for markets whose footprint it records on the page step, in hours that carry the footprint', () => {
  const stretch = (inst: string): CoverageRow => ({ inst, metric: 'trades', from: HOUR, to: HOUR + 600_000, kind: 'live' });
  const state = tradeImport([], [{ inst: 'a', step: 0.5 }]);
  // An hour from before the service recorded the footprint: nothing joins.
  assert.deepEqual(planCoverage(state, { coverage: [stretch('a')], footprint: [] }), []);
  const rows = { coverage: [stretch('a'), stretch('b'), stretch('c'), stretch('q')], footprint: [fpRow('a', HOUR, 1), fpRow('b', HOUR, 1, 1), fpRow('c', HOUR, 1)] };
  // `b` lies on another step than the page's here; `c` was taken (its step is the service's); `q` has no minute in this hour: it waits for
  // `clipCoverage`, which takes it only once a footprint minute of it on the page's step is seen (Sol round 4: a quiet market in a newer
  // hour whose step an older hour gives).
  planFootprint(state, rows.footprint.filter(r => r.inst !== 'b'), () => undefined);
  state.steps.set('b', 0.5);
  assert.deepEqual(planCoverage(state, rows).map(r => r.inst), ['a', 'c', 'q']);
  // An hour in which `a` traded nothing: its stretch is kept for the clip too.
  assert.deepEqual(planCoverage(state, { coverage: [stretch('a')], footprint: [fpRow('c', HOUR, 1)] }).map(r => r.inst), ['a']);
});

test('of two copies of a minute with the same trades, the one with more of its orders counted is the fuller (Sol round 1)', () => {
  const stats = (n: number) => ({ buyN: n, sellN: 0, buy: [30_000 * n, 0, 0, 0, 0, 0, 0, 0], sell: [0, 0, 0, 0, 0, 0, 0, 0], v: 2, big: [] });
  const early: FootprintMinuteRow = { inst: 'a', t: HOUR, step: 0.5, bins: [[1, 30_000, 0, 0, 0]], stats: stats(0) };
  const late: FootprintMinuteRow = { ...early, bins: [[1, 30_000, 0, 1, 0]], stats: stats(1) };
  assert.ok(fullerFootprint(early, late) && !fullerFootprint(late, early) && !fullerFootprint(late, late));
  assert.ok(fullerFootprint(late, { ...early, bins: [[1, 30_001, 0, 0, 0]] }), 'more volume wins first');
  // Within one hour (the later copy second) and against the page's copy.
  const state = tradeImport([], []);
  assert.deepEqual(planFootprint(state, [early, late], () => undefined), [late]);
  assert.deepEqual(planFootprint(tradeImport([], []), [late, early], () => undefined), [late]);
  assert.deepEqual(planFootprint(tradeImport([], []), [late], () => early), [late]);
  assert.deepEqual(planFootprint(tradeImport([], []), [early], () => late), []);
});

test('the service coverage joins only over hours whose footprint the page holds (Sol round 1)', () => {
  const H = HOUR_MS;
  const stretch: CoverageRow = { inst: 'a', metric: 'trades', from: HOUR + 600_000, to: HOUR + 4 * H, kind: 'live', first: { id: 'f', t: HOUR + 600_001 }, last: { id: 'l', t: HOUR + 4 * H - 1 } };
  // Hours 0, 2 and 3 are held (1 is not): two parts, each keeping only the seam inside it.
  const held = new Set([HOUR, HOUR + 2 * H, HOUR + 3 * H]);
  const any = (): number => 0;
  assert.deepEqual(clipCoverage([stretch], h => held.has(h), any), [
    { inst: 'a', metric: 'trades', from: HOUR + 600_000, to: HOUR + H, kind: 'live', first: { id: 'f', t: HOUR + 600_001 } },
    { inst: 'a', metric: 'trades', from: HOUR + 2 * H, to: HOUR + 4 * H, kind: 'live', last: { id: 'l', t: HOUR + 4 * H - 1 } },
  ]);
  assert.deepEqual(clipCoverage([stretch], () => false, any), []);
  assert.deepEqual(clipCoverage([stretch], () => true, any), [stretch]);
  // A market with no footprint minute seen gets nothing.
  assert.deepEqual(clipCoverage([stretch], () => true, () => undefined), []);
});

test('a restart onto the footprint build: the old run\'s stretch is claimed only from the new run\'s first footprint minute on (advisor)', () => {
  const H = HOUR_MS;
  // The old run (no footprint) recorded from hour 0 to 2:10; its last stretch lands in hour 2's file, written by the new run, whose
  // footprint begins at 2:10 (minute 2:10 is its first). Hours 0 and 1 were read, but their files held no footprint.
  const old: CoverageRow = { inst: 'a', metric: 'trades', from: HOUR, to: HOUR + 2 * H + 600_000, kind: 'live' };
  const fresh: CoverageRow = { inst: 'a', metric: 'trades', from: HOUR + 2 * H + 600_500, to: HOUR + 3 * H, kind: 'live' };
  const footprintHours = new Set([HOUR + 2 * H]);
  const firstMinute = HOUR + 2 * H + 600_000;
  const parts = clipCoverage([old, fresh], h => footprintHours.has(h), () => firstMinute + 60_000);
  // Nothing of the old run's stretch (it ends before the new run's second minute), and the new one from its second minute on.
  assert.deepEqual(parts.map(r => [r.from - HOUR, r.to - HOUR]), [[2 * H + 660_000, 3 * H]]);
});
