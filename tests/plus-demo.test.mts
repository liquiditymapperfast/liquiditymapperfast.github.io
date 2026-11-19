import test from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, HH, NOW_PRICE, ROWS, SEED, SNAPS, bandIndex, createData, demoData, mulberry32 } from '../src/app/plus/demo/data.ts';
import { DEMO_START, createDemoStore, kindsOn, lastOn, type DemoLevels } from '../src/app/plus/demo/store.ts';
import { bucketsOf, depthColumns, depthTable, levelsAt, weightsOf, windowEnd } from '../src/app/plus/demo/model.ts';

/* ==== the made-up numbers ============================================================================================================= */

const round = (v: number, digits = 4): number => Number(v.toPrecision(digits));
const sum = (a: ArrayLike<number>): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]!; return s; };

test('the demo\'s numbers come from one seed: the same numbers every time, others for another seed', () => {
  const a = createData(SEED), b = createData(SEED), other = createData(SEED + 1);
  for (const key of ['price', 'liqL', 'liqS', 'stopL', 'stopS', 'tpL', 'tpS', 'pfLiq', 'pfStop', 'pfTp', 'band'] as const) {
    assert.deepEqual(Buffer.from(a[key].buffer), Buffer.from(b[key].buffer), `${key}: the same bytes`);
  }
  assert.notDeepEqual(Buffer.from(a.liqL.buffer), Buffer.from(other.liqL.buffer), 'another seed, other levels');
  assert.equal(demoData(), demoData(), 'built once and shared');
  // The generator itself, and a few numbers pinned (to four figures: the trace goes through Math.exp and Math.log).
  const r = mulberry32(1);
  assert.deepEqual([r(), r(), r()].map(v => round(v, 6)), GOLDEN.mulberry);
  assert.equal(a.price.length, HH);
  assert.equal(a.price[HH - 1], NOW_PRICE, 'the trace ends at the price now');
  assert.deepEqual([a.price[0], a.price[300], a.price[700]].map(v => round(v!)), GOLDEN.prices);
  assert.deepEqual([sum(a.liqL), sum(a.liqS), sum(a.stopL), sum(a.stopS), sum(a.tpL), sum(a.tpS)].map(v => round(v)), GOLDEN.sums);
  assert.deepEqual([a.band[bandIndex(SNAPS - 1, 0, 0, 0, 4)], a.band[bandIndex(SNAPS - 1, 1, 0, 1, 2)]].map(v => round(v!)), GOLDEN.bands);
  for (const key of ['pfLiq', 'pfStop', 'pfTp'] as const) for (const v of a[key]) assert.ok(v > 0 && v < 1, `${key}: a share`);
});

/** Pinned from the generator as ported from the approved prototype (seed 20261118; its arrays were byte-identical to the prototype's). */
const GOLDEN = { mulberry: [0.627074, 0.00273572, 0.527447], prices: [65_230, 66_720, 66_450], sums: [4.311e10, 3.629e10, 5.163e9, 5.75e9, 7.19e9, 7.714e9], bands: [1.155e8, 5.238e6] };

/* ==== the store ======================================================================================================================= */

test('the store: one kind always stays on, judged on the whole patch; other values are left out; told only of real changes', () => {
  const store = createDemoStore();
  const told: DemoLevels[] = [];
  const stop = store.subscribe(s => told.push(s));
  assert.deepEqual(store.get(), DEMO_START, 'every kind, everyone');
  assert.equal(store.set({ liq: false }), true);
  assert.equal(store.set({ stops: false }), true);
  assert.deepEqual(store.get(), { liq: false, stops: false, takes: true, traders: 'everyone' });
  assert.equal(lastOn(store.get(), 'takes'), true);
  assert.equal(store.set({ takes: false }), false, 'the last kind on stays on');
  assert.deepEqual(store.get(), { liq: false, stops: false, takes: true, traders: 'everyone' });
  assert.equal(store.set({ takes: false, stops: true }), true, 'one off and another on at once is fine');
  assert.deepEqual(store.get(), { liq: false, stops: true, takes: false, traders: 'everyone' });
  assert.equal(store.set({ liq: false, stops: false, takes: false, traders: 'profitable' }), true, 'all off: the kinds stay, the traders change');
  assert.deepEqual(store.get(), { liq: false, stops: true, takes: false, traders: 'profitable' });
  assert.equal(store.set({ stops: true }), false, 'no change, nobody told');
  const n = told.length;
  assert.equal(store.set({ liq: 'yes' as unknown as boolean, traders: 'nobody' as unknown as DemoLevels['traders'] }), false, 'values of the wrong kind are left out');
  assert.equal(told.length, n);
  assert.equal(told.length, 4);
  assert.ok(Object.isFrozen(store.get()), 'a frozen choice: kept and compared, never changed in place');
  stop();
  store.set({ liq: true });
  assert.equal(told.length, 4, 'unsubscribed');
  assert.deepEqual(createDemoStore({ liq: false, stops: false, takes: false, traders: 'profitable' }).get(), DEMO_START, 'a start with no kind on is the usual start');
  assert.equal(kindsOn({ liq: true, stops: false, takes: true, traders: 'everyone' }), 2);
});

/* ==== the curve =========================================================================================================================== */

const COMBOS: DemoLevels[] = [];
for (const traders of ['everyone', 'profitable'] as const) for (let m = 1; m < 8; m++) COMBOS.push({ liq: !!(m & 1), stops: !!(m & 2), takes: !!(m & 4), traders });

test('the curve adds up the liquidations and/or stops that are on, never take profits; take profits alone get their own curve', () => {
  const d = demoData(), bk = bucketsOf(1), n = bk.length;
  for (const end of [windowEnd(1), windowEnd(0.3), windowEnd(0)]) {
    for (const s of COMBOS) {
      const L = levelsAt(d, bk, end, weightsOf(s)), pb = L.pb, label = `${JSON.stringify(s)} at ${end}`;
      const alone = s.takes && !s.liq && !s.stops;
      let up = 0, upT = 0;
      for (let b = pb; b < n; b++) {
        up += (s.liq ? L.lS[b]! : 0) + (s.stops ? L.sS[b]! : 0); upT += L.tL[b]!;
        assert.ok(Math.abs(L.cU[b]! - up) <= 1e-6 * Math.max(1, up), `${label}: the curve above at ${b}`);
        assert.ok(Math.abs(L.tU[b]! - (alone ? upT : 0)) <= 1e-6 * Math.max(1, upT), `${label}: take profits' own curve above at ${b}`);
      }
      let dn = 0, dnT = 0;
      for (let b = pb; b >= 0; b--) {
        dn += (s.liq ? L.lL[b]! : 0) + (s.stops ? L.sL[b]! : 0); dnT += L.tS[b]!;
        assert.ok(Math.abs(L.cD[b]! - dn) <= 1e-6 * Math.max(1, dn), `${label}: the curve below at ${b}`);
        assert.ok(Math.abs(L.tD[b]! - (alone ? dnT : 0)) <= 1e-6 * Math.max(1, dnT), `${label}: take profits' own curve below at ${b}`);
      }
      if (alone) assert.equal(Math.max(...L.cU, ...L.cD), 0, `${label}: take profits alone: no solid curve`);
      // Take profits never change the solid curve.
      if (s.liq || s.stops) {
        const other = levelsAt(d, bk, end, weightsOf({ ...s, takes: !s.takes }));
        assert.deepEqual([...other.cU], [...L.cU], `${label}: the curve above, take profits on or off`);
        assert.deepEqual([...other.cD], [...L.cD], `${label}: the curve below, take profits on or off`);
      }
      assert.ok(L.cumMax >= Math.max(...L.cU, ...L.cD, ...L.tU, ...L.tD) - 1e-6);
    }
  }
});

test('the profitable traders are drawn as precisely as everyone, price by price, with their own smaller amounts', () => {
  const d = demoData(), bk = bucketsOf(1), end = windowEnd(1);
  const all = levelsAt(d, bk, end, weightsOf(DEMO_START)), pf = levelsAt(d, bk, end, weightsOf({ ...DEMO_START, traders: 'profitable' }));
  const ratios: number[] = [];
  for (let b = 0; b < bk.length; b++) {
    for (const k of ['lS', 'lL', 'sS', 'sL', 'tL', 'tS'] as const) {
      assert.ok(pf[k][b]! <= all[k][b]! + 1e-6, `${k} ${b}: no more than everyone`);
      if (all[k][b]! > 1e5) ratios.push(pf[k][b]! / all[k][b]!);
    }
  }
  assert.ok(ratios.length > 50);
  assert.ok(Math.max(...ratios) - Math.min(...ratios) > 0.3, 'a shape of their own, not everyone scaled down');
  const table = depthTable(d, end, weightsOf(DEMO_START)), pfTable = depthTable(d, end, weightsOf({ ...DEMO_START, traders: 'profitable' }));
  BANDS.forEach((_, k) => { assert.ok(pfTable.up[k]! < table.up[k]!); assert.ok(pfTable.dn[k]! < table.dn[k]!); });
  for (let k = 1; k < BANDS.length; k++) assert.ok(table.up[k]! >= table.up[k - 1]!, 'a wider distance holds at least as much');
  const depth = depthColumns(d, end - 336, end, weightsOf(DEMO_START));
  assert.equal(depth.cols.length, 85, 'a column for each snapshot of the week (the first one partly in it)');
  assert.ok(depth.cols.every(c => c.up.length === BANDS.length && c.dn.length === BANDS.length));
  assert.equal(ROWS * SNAPS, d.liqL.length);
});
