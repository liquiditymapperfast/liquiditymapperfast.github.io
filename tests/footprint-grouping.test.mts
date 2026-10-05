import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalFootprintDecimal, emptyFootprintVolume, footprintGroupingAllowance, footprintPriceBin, footprintTotals, groupFootprintCells, type FootprintCanonicalCell } from '../src/core/footprint-grouping.mts';
function cell(price: number, buy: number, sell: number): FootprintCanonicalCell { return { ...emptyFootprintVolume(), price, priceKey: canonicalFootprintDecimal(price).key, buyBase: buy, sellBase: sell, buyUsd: buy * price, sellUsd: sell * price, records: Number(buy > 0) + Number(sell > 0) }; }
function sum(cells: readonly FootprintCanonicalCell[]) { return cells.reduce((total, value) => { for (const name of ['buyBase', 'sellBase', 'unknownBase', 'buyUsd', 'sellUsd', 'unknownUsd', 'records'] as const) total[name] += value[name]; return total; }, emptyFootprintVolume()); }

test('zero-origin exact half-open boundary bins are identical for both aggressor sides', () => {
  for (const [price, step, low, high] of [['100', '1', '100', '101'], ['100.5', '1', '100', '101'], ['101', '1', '101', '102'], ['0.3', '0.1', '0.3', '0.4'], ['0.29999999999999999', '.1', '0.2', '0.3'], ['0.000019', '0.00001', '0.00001', '0.00002']] as const) {
    const bin = footprintPriceBin(price, step === '.1' ? '0.1' : step); assert.equal(bin.priceLowKey, low); assert.equal(bin.priceHighKey, high);
  }
  const rows = [cell(100, 2, 0), cell(100.5, 0, 1), cell(101, .5, 0)];
  const grouped = groupFootprintCells(rows, 1, { reservedWorkingBytes: footprintGroupingAllowance(rows.length) });
  assert.equal(grouped.length, 2); assert.equal(grouped[0].buyUsd, 200); assert.equal(grouped[0].sellUsd, 100.5); assert.equal(grouped[1].buyUsd, 50.5);
  const total = footprintTotals(sum(rows)); assert.equal(total.observedUsd, 351); assert.equal(total.deltaUsd, 150); assert.equal(total.observedBase, 3.5);
});
test('canonical decimal preserves low prices and exact native boundary keys without inventing tick', () => {
  assert.equal(canonicalFootprintDecimal(1e-8).key, '0.00000001'); assert.equal(canonicalFootprintDecimal('00100.5000').key, '100.5');
  assert.equal(footprintPriceBin('0.00000003', '0.00000001').priceLowKey, '0.00000003');
  assert.equal(footprintPriceBin('100.00000000000000001', '1').priceLowKey, '100');
  for (const invalid of [0, -1, Infinity, NaN, null, '', ' 1 ', 'NaN', '1e999', '0.00000000000000000000000001']) assert.throws(() => canonicalFootprintDecimal(invalid));
  assert.throws(() => footprintPriceBin(1e20, 1e-10), /unrepresentable/);
});
test('unknown side stays observed neutral volume and percentage is unavailable at zero known denominator', () => {
  const unknown = footprintTotals({ ...emptyFootprintVolume(), unknownBase: 3, unknownUsd: 30, records: 2 });
  assert.equal(unknown.knownUsd, 0); assert.equal(unknown.observedUsd, 30); assert.equal(unknown.deltaUsd, 0); assert.equal(unknown.deltaPercent, null);
  const mixed = footprintTotals({ ...emptyFootprintVolume(), buyUsd: 40, sellUsd: 10, unknownUsd: 20 });
  assert.equal(mixed.observedUsd, 70); assert.equal(mixed.deltaUsd, 30); assert.equal(mixed.deltaPercent, 60);
});
test('grouping scratch, cell limits and total arithmetic fail closed before output adoption', () => {
  const rows = [cell(100, 1, 0)];
  assert.throws(() => groupFootprintCells(rows, 1, { reservedWorkingBytes: footprintGroupingAllowance(1) - 1 }), /reservation/);
  assert.throws(() => footprintGroupingAllowance(32_769)); assert.throws(() => footprintGroupingAllowance(Infinity));
  assert.throws(() => footprintTotals({ ...emptyFootprintVolume(), buyUsd: Number.MAX_VALUE, sellUsd: Number.MAX_VALUE }), /overflow/);
  assert.throws(() => groupFootprintCells([{ ...rows[0], buyUsd: NaN }], 1, { reservedWorkingBytes: 10_000 }));
});
