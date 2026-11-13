import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clipCoverage, decodeHour, footprintVolume, fullerFootprint, heldOf, hoursToRead, ownsMinute, ownsTime, planAbsorption, planCoverage, planFootprint, tradeImport, within } from '../src/app/browser/history-import.ts';
import { statsText, type FootprintMinuteRow } from '../src/shared/footprint.ts';
import { importedMark, staleMark } from '../src/app/browser/idb.ts';
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
  const held = new Map([[`bybit:BTCUSDT|${t0 + 60_000}`, fpRow('bybit:BTCUSDT', t0 + 60_000, 500)], [`bybit:BTCUSDT|${t0 + 120_000}`, fpRow('bybit:BTCUSDT', t0 + 120_000, 1_000)]]);
  const taken = planFootprint(state, [
    fpRow('bybit:BTCUSDT', t0, 100), // before the page: taken
    fpRow('bybit:BTCUSDT', t0 + 60_000, 400), // the page's part of the minute holds more: not taken
    fpRow('bybit:BTCUSDT', t0 + 60_000, 900), // more than the page's part: taken
    fpRow('bybit:BTCUSDT', t0 + 120_000, 900), // the page recorded the whole minute and holds it: not taken
    fpRow('bybit:BTCUSDT', t0 + 240_000, 700), // its coverage holds the minute, it holds no copy: taken
    fpRow('bybit:BTCUSDT', t0 + 180_000, 9, 1), // another step: never re-binned
    fpRow('okx:BTC-USDT-SWAP', t0, 50, 2), // no rows of okx on the page: the service's step is taken
    fpRow('okx:BTC-USDT-SWAP', t0 + 60_000, 50, 0.5),
    fpRow('okx:BTC-USDT-SWAP', t0, 40, 2), // a second, thinner copy of a minute (a restart): the fuller stays
  ], key => held.get(key));
  assert.deepEqual(taken.map(r => [r.inst, r.t - t0, footprintVolume(r)]), [['bybit:BTCUSDT', 0, 100], ['bybit:BTCUSDT', 60_000, 900], ['bybit:BTCUSDT', 240_000, 700], ['okx:BTC-USDT-SWAP', 0, 50]]);
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

/** The hour hlm-history's own encoder writes for this test (rows.rs `page_fixture_hour_with_both_footprint_layouts`, bytes pinned there). */
const f32Fixture = (): ArrayBuffer => { const b = fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'history-hour-footprint-f32.bin')); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const F32_HOUR = 1_794_492_000_000;
const sizes = (first: number, second: number): number[] => [first, second, 0, 0, 0, 0, 0, 0];

test('kind 11 (f32 USD, no list) reads back from the recorder\'s own bytes, each list rebuilt from the same file\'s large trades where it adds up; kind 7 keeps its own', () => {
  const rows = decodeHour(f32Fixture())!.rows;
  assert.equal(rows.hour, F32_HOUR);
  assert.equal(rows.prints.length, 4);
  const [a, b, c, d] = rows.footprint;
  assert.equal(rows.footprint.length, 4);
  // USD to 7 significant digits (55,618.1234567 is kept as 55,618.125); the sums by size whole.
  assert.deepEqual(a, {
    inst: 'binance:BTCUSDT', t: F32_HOUR, step: 0.25, bins: [[400_123, 55_618.125, 0, 1, 0], [400_131, 1_234.5, 60_000.25, 2, 1]],
    stats: { buyN: 3, sellN: 1, buy: sizes(1_234.5, 55_618.123_456_7), sell: [0, 0, 60_000.25, 0, 0, 0, 0, 0], v: 2, big: [55_618.123_456_7, -60_000.25] },
  });
  assert.equal(Math.fround(55_618.123_456_7), 55_618.125);
  // Its large buy is in no large trade of this file (the next hour's has it): no list, for the engine to fill from every print it holds.
  assert.equal(b!.inst, 'binance:BTCUSDT');
  assert.equal(b!.t, F32_HOUR + 60_000);
  assert.ok(b!.stats && b!.stats.big === undefined && !('big' in b!.stats));
  // No large order: an empty list, known (the large trade of another market in its minute is not its own).
  assert.equal(c!.inst, 'okx:BTC-USDT-SWAP');
  assert.deepEqual(c!.stats!.big, []);
  // Kind 7 as written before: f64 to the last bit, its own list.
  assert.deepEqual(d, {
    inst: 'binance:BTCUSDT', t: F32_HOUR + 120_000, step: 0.25, bins: [[400_200, 40_000.123_456_7, 0, 1, 0]],
    stats: { buyN: 1, sellN: 0, buy: sizes(0, 40_000.123_456_7), sell: sizes(0, 0), v: 2, big: [40_000.123_456_7] },
  });
  // The list is the minute's own (not shared with the prints' grouping), and stored as the page stores any list.
  assert.equal(statsText(a!.stats!), JSON.stringify([3, 1, sizes(1_234.5, 55_618.123_456_7), [0, 0, 60_000.25, 0, 0, 0, 0, 0], 2, [55_618.123_456_7, -60_000.25]]));
  // A record cut short or claiming rows it does not hold is left out, as for kind 7.
  const bytes = new Uint8Array(f32Fixture()), view = new DataView(bytes.buffer);
  const firstFootprint = (): number => { for (let at = 16; at + 4 <= bytes.length; at += 4 + view.getUint32(at, true)) if (bytes[at + 4] === 11) return at; return -1; };
  const at = firstFootprint(), rowsAt = at + 4 + 2 + 'binance:BTCUSDT'.length + 16;
  view.setUint32(rowsAt, 3, true);
  assert.equal(decodeHour(bytes.buffer)!.rows.footprint.length, 3, 'the minute with a wrong row count is left out, the rest kept');
});

test('a minute the page holds part of (the tab opened inside it): the service\'s copy is taken with the list rebuilt from its own file', () => {
  const rows = decodeHour(f32Fixture())!.rows;
  const own: CoverageRow = { inst: 'binance:BTCUSDT', metric: 'trades', from: F32_HOUR + 30_000, to: F32_HOUR + 3_600_000, kind: 'live' };
  const pageCopy: FootprintMinuteRow = { inst: 'binance:BTCUSDT', t: F32_HOUR, step: 0.25, bins: [[400_131, 1_234.5, 60_000.25, 2, 1]], stats: { buyN: 2, sellN: 1, buy: sizes(1_234.5, 0), sell: [0, 0, 60_000.25, 0, 0, 0, 0, 0], v: 2, big: [-60_000.25] } };
  const state = tradeImport([own], [pageCopy]);
  const whole: FootprintMinuteRow = { ...pageCopy, t: F32_HOUR + 60_000 };
  const chosen = planFootprint(state, rows.footprint, key => key === `binance:BTCUSDT|${F32_HOUR}` ? pageCopy : key === `binance:BTCUSDT|${F32_HOUR + 60_000}` ? whole : undefined);
  const seam = chosen.find(r => r.t === F32_HOUR && r.inst === 'binance:BTCUSDT')!;
  assert.deepEqual(seam.stats!.big, [55_618.123_456_7, -60_000.25], 'the whole minute\'s list, not the page\'s half');
  assert.ok(!chosen.some(r => r.t === F32_HOUR + 60_000 && r.inst === 'binance:BTCUSDT'), 'a minute the page recorded whole and holds stays its own');
});

test('copies of a minute that differ only by f32 rounding hold the same volume: the orders counted decide, and a tie keeps the copy held', () => {
  const stats = (n: number) => ({ buyN: n, sellN: 0, buy: sizes(0, 55_618.123_456_7), sell: sizes(0, 0), v: 2 });
  const page: FootprintMinuteRow = { inst: 'a', t: HOUR, step: 0.25, bins: [[1, 55_618.123_456_7, 0, 1, 0], [2, 0.1, 1_234.567_891, 0, 0]], stats: stats(1) };
  const service: FootprintMinuteRow = { ...page, bins: page.bins.map(([bin, buy, sell, b, s]) => [bin, Math.fround(buy), Math.fround(sell!), b, s] as FootprintMinuteRow['bins'][number]) };
  assert.notEqual(footprintVolume(service), footprintVolume(page), 'rounding moved the sum');
  assert.ok(!fullerFootprint(page, service) && !fullerFootprint(service, page), 'neither is fuller');
  assert.ok(fullerFootprint(page, { ...service, stats: stats(2) }), 'more of its orders counted');
  assert.ok(fullerFootprint(page, { ...service, bins: [...service.bins, [3, 1, 0, 0, 0]] }), 'a dollar more is a trade more');
  assert.deepEqual(planFootprint(tradeImport([], []), [service], () => page), [], 'the page keeps its own copy');
});

test('an hour a page from before kind 11 marked as read is read again from the hour this page was built in; before it the mark stands', () => {
  const built = 1_794_520_800_000;
  assert.ok(importedMark({ inst: 'v3', from: built + 5 * HOUR_MS }));
  assert.ok(importedMark({ inst: 'v3', from: built - 5 * HOUR_MS }));
  assert.ok(importedMark({ inst: 'v2', from: built - HOUR_MS }));
  assert.ok(!importedMark({ inst: 'v2', from: built }));
  assert.ok(!importedMark({ inst: '', from: built - HOUR_MS }));
});

/** An hour file of large trades (kind 5) and footprint minutes (kind 11, or 7 with its own list), in the order given, as rows.rs writes them. */
type Rec = { print: { t: number; usd: number } } | { minute: { t: number; buy1: number; usd: number; orders: number; list?: number[] } };
function copiesFile(hour: number, records: Rec[], inst = 'binance:BTCUSDT'): ArrayBuffer {
  const out: number[] = [];
  const put = (size: number, set: (view: DataView) => void, to: number[]): void => { const b = new Uint8Array(size); set(new DataView(b.buffer)); to.push(...b); };
  put(16, d => { d.setUint32(0, 0x484c4d43, false); d.setUint16(4, 1, true); d.setBigInt64(8, BigInt(hour), true); }, out);
  for (const r of records) {
    const body: number[] = [];
    const u8 = (v: number): void => { body.push(v); }, u32 = (v: number): void => put(4, d => d.setUint32(0, v, true), body);
    const i32 = (v: number): void => put(4, d => d.setInt32(0, v, true), body), i64 = (v: number): void => put(8, d => d.setBigInt64(0, BigInt(v), true), body);
    const f64 = (v: number): void => put(8, d => d.setFloat64(0, v, true), body), f32 = (v: number): void => put(4, d => d.setFloat32(0, v, true), body);
    if ('print' in r) {
      u8(5); u8(inst.length); for (const c of inst) u8(c.charCodeAt(0));
      i64(r.print.t); u8(1); f64(100_000); f64(r.print.usd); u8(0); f64(0); f64(0); u32(0);
    } else {
      const m = r.minute, old = m.list !== undefined;
      u8(old ? 7 : 11); u8(inst.length); for (const c of inst) u8(c.charCodeAt(0));
      i64(m.t); f64(0.25); u32(1); i32(400_000); (old ? f64 : f32)(m.usd); (old ? f64 : f32)(0); u32(m.orders); u32(0);
      u8(1); u32(m.orders); u32(0);
      for (let i = 0; i < 8; i++) f64(i === 0 ? m.usd - m.buy1 : i === 1 ? m.buy1 : 0);
      for (let i = 0; i < 8; i++) f64(0);
      if (old) { u32(m.list!.length); for (const v of m.list!) f64(v); }
    }
    put(4, d => d.setUint32(0, body.length, true), out); out.push(...body);
  }
  return Uint8Array.from(out).buffer;
}

test('two copies of a minute in one file each get the list of the orders they counted: the trades written before each copy, else since the one before', () => {
  const m = HOUR;
  // Written while its second large order was still open, then again once it was counted.
  const late = decodeHour(copiesFile(HOUR, [
    { print: { t: m + 1_000, usd: 30_000 } }, { minute: { t: m, buy1: 30_000, usd: 30_500, orders: 2 } },
    { print: { t: m + 59_900, usd: 40_000 } }, { minute: { t: m, buy1: 70_000, usd: 70_500, orders: 3 } },
  ]))!.rows.footprint;
  assert.deepEqual(late.map(r => r.stats!.big), [[30_000], [30_000, 40_000]]);
  // Before a restart and after it: the copy the new run wrote counts only its own orders.
  const restart = decodeHour(copiesFile(HOUR, [
    { print: { t: m + 1_000, usd: 30_000 } }, { minute: { t: m, buy1: 30_000, usd: 30_500, orders: 2 } },
    { print: { t: m + 40_000, usd: 40_000 } }, { minute: { t: m, buy1: 40_000, usd: 40_100, orders: 1 } },
  ]))!.rows.footprint;
  assert.deepEqual(restart.map(r => r.stats!.big), [[30_000], [40_000]]);
  // A copy whose orders add up to no run of the file's trades keeps no list, and never a wrong one.
  const none = decodeHour(copiesFile(HOUR, [
    { print: { t: m + 1_000, usd: 30_000 } }, { minute: { t: m, buy1: 55_000, usd: 55_500, orders: 2 } },
  ]))!.rows.footprint;
  assert.equal(none[0]!.stats!.big, undefined);
  // The planned copy is the fuller one, with its own list.
  assert.deepEqual(planFootprint(tradeImport([], []), late, () => undefined).map(r => r.stats!.big), [[30_000, 40_000]]);
});

test('the hour of the service\'s restart onto kind 11: a minute written once as kind 7 and once as kind 11, the fuller copy taken whichever kind it is', () => {
  const m = HOUR + 60_000;
  const rows = decodeHour(copiesFile(HOUR, [
    { print: { t: m + 1_000, usd: 30_000 } }, { minute: { t: m, buy1: 30_000, usd: 30_500, orders: 2, list: [30_000] } },
    { print: { t: m + 50_000, usd: 26_000 } }, { minute: { t: m, buy1: 26_000, usd: 26_000, orders: 1 } },
  ]))!.rows;
  assert.deepEqual(rows.footprint.map(r => r.stats!.big), [[30_000], [26_000]], 'kind 7 keeps its own list, kind 11 rebuilds its run');
  const chosen = planFootprint(tradeImport([], []), rows.footprint, () => undefined);
  assert.equal(chosen.length, 1);
  assert.deepEqual(chosen[0]!.stats!.big, [30_000], 'the kind-7 copy before the restart is the fuller');
});

test('a run that wrote two copies of a minute after a restart: each copy gets the orders of its own run, found after the copy before the run', () => {
  const m = HOUR;
  const rows = decodeHour(copiesFile(HOUR, [
    { print: { t: m + 1_000, usd: 30_000 } }, { minute: { t: m, buy1: 30_000, usd: 30_500, orders: 2 } },
    { print: { t: m + 30_000, usd: 40_000 } }, { minute: { t: m, buy1: 40_000, usd: 40_100, orders: 1 } },
    { print: { t: m + 59_000, usd: 26_000 } }, { minute: { t: m, buy1: 66_000, usd: 66_100, orders: 2 } },
  ]))!.rows.footprint;
  assert.deepEqual(rows.map(r => r.stats!.big), [[30_000], [40_000], [40_000, 26_000]]);
});

test('an hour a page from before kind 11 read from the hour this page was built in is read again whatever the page holds; once read here it is not', () => {
  const built = 1_794_520_800_000, now = built + 3 * HOUR_MS + 30 * 60_000;
  const latest = { v: 1 as const, coin: 'BTC', first: built - 5 * HOUR_MS, last: built + 2 * HOUR_MS, open: built + 3 * HOUR_MS, steps: { 'a:BTC': 20 } };
  // The page holds every minute of every hour.
  const rows = Array.from({ length: 9 * 60 }, (_, i) => ({ instrumentId: 'a:BTC', step: 20, column: { t: built - 5 * HOUR_MS + i * 60_000, n: 12 } }));
  assert.deepEqual(hoursToRead(latest, heldOf(rows), built - 5 * HOUR_MS, now), []);
  const marks = [{ inst: 'v2', from: built - HOUR_MS }, { inst: 'v2', from: built }, { inst: 'v2', from: built + HOUR_MS }, { inst: 'v3', from: built + HOUR_MS }];
  const imported = marks.filter(importedMark).map(r => r.from), again = marks.filter(staleMark).map(r => r.from);
  assert.deepEqual(again, [built, built + HOUR_MS]);
  assert.deepEqual(hoursToRead(latest, heldOf(rows, [], imported, again), built - 5 * HOUR_MS, now), [built], 'the restart hour is read again; the hour this page already read is not');
});

test('the hour of the service restart, read by a page from before kind 11 that claimed its trades: read again, its kind-11 minutes are taken', () => {
  const m0 = HOUR;
  const rows = decodeHour(copiesFile(HOUR, [
    { print: { t: m0 + 1_000, usd: 30_000 } }, { minute: { t: m0, buy1: 30_000, usd: 30_500, orders: 2, list: [30_000] } },
    { print: { t: m0 + 61_000, usd: 40_000 } }, { minute: { t: m0 + 60_000, buy1: 40_000, usd: 40_100, orders: 1 } },
    { minute: { t: m0 + 120_000, buy1: 0, usd: 900, orders: 1 } },
  ]))!.rows;
  // That page took the kind-7 minute and joined the service's coverage over the whole hour.
  const claimed: CoverageRow = { inst: 'binance:BTCUSDT', metric: 'trades', from: m0, to: m0 + HOUR_MS, kind: 'live' };
  const kept = rows.footprint[0]!, state = tradeImport([claimed], [kept]);
  const taken = planFootprint(state, rows.footprint, key => key === `binance:BTCUSDT|${m0}` ? kept : undefined);
  assert.deepEqual(taken.map(r => [r.t - m0, r.stats!.big]), [[60_000, [40_000]], [120_000, []]]);
});

test('a minute the coverage holds but the page did not as it opened: a thin copy taken from a newer hour gives way to a fuller one in an older hour', () => {
  const t0 = HOUR;
  const state = tradeImport([{ inst: 'bybit:BTCUSDT', metric: 'trades', from: t0, to: t0 + HOUR_MS }], []);
  const taken = new Map<string, FootprintMinuteRow>(), atOpen = new Set<string>();
  const plan = (rows: FootprintMinuteRow[]): void => { for (const row of planFootprint(state, rows, key => taken.get(key), key => atOpen.has(key))) taken.set(`${row.inst}|${row.t}`, row); };
  plan([fpRow('bybit:BTCUSDT', t0 + HOUR_MS - 60_000, 400)]); // the newer hour's file, read first
  plan([fpRow('bybit:BTCUSDT', t0 + HOUR_MS - 60_000, 900)]); // the older hour's
  assert.equal(footprintVolume(taken.get(`bybit:BTCUSDT|${t0 + HOUR_MS - 60_000}`)!), 900);
  // A minute the page held as it opened stays its own.
  atOpen.add(`bybit:BTCUSDT|${t0}`); taken.set(`bybit:BTCUSDT|${t0}`, fpRow('bybit:BTCUSDT', t0, 100));
  plan([fpRow('bybit:BTCUSDT', t0, 900)]);
  assert.equal(footprintVolume(taken.get(`bybit:BTCUSDT|${t0}`)!), 100);
});
