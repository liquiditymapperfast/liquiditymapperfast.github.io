/** Exact decimal, zero-origin execution grouping. This is never L2 bid/ask grouping. */
export const FOOTPRINT_DECIMAL_MAX_DIGITS = 48;
export const FOOTPRINT_DECIMAL_MAX_SCALE = 24;
export const FOOTPRINT_GROUPING_MAX_CELLS = 32_768;
export const FOOTPRINT_GROUPING_CELL_WORK_BYTES = 1_024;
export interface FootprintDecimal { readonly key: string; readonly value: number; readonly coefficient: bigint; readonly scale: number }
export interface FootprintPriceBin { readonly priceLow: number; readonly priceHigh: number; readonly priceLowKey: string; readonly priceHighKey: string; readonly grouping: string }
export interface FootprintVolume {
  buyBase: number; sellBase: number; unknownBase: number;
  buyUsd: number; sellUsd: number; unknownUsd: number; records: number;
}
export interface FootprintTotals extends FootprintVolume {
  readonly knownBase: number; readonly observedBase: number; readonly knownUsd: number; readonly observedUsd: number;
  readonly deltaBase: number; readonly deltaUsd: number; readonly deltaPercent: number | null;
}
export interface FootprintCanonicalCell extends Readonly<FootprintVolume> { readonly price: number; readonly priceKey: string }
export interface FootprintGroupedCell extends Readonly<FootprintVolume>, FootprintPriceBin {}

function decimalKey(coefficient: bigint, scale: number): string {
  if (coefficient === 0n) return '0';
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale -= 1; }
  const digits = String(coefficient);
  return scale === 0 ? digits : digits.length > scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : '0.' + '0'.repeat(scale - digits.length) + digits;
}
/** Number input means its explicit Float64 value, not an invented exchange tick. */
export function canonicalFootprintDecimal(value: unknown): FootprintDecimal {
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError('invalid-decimal');
  if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) throw new TypeError('invalid-decimal');
  const text = String(value);
  if (text.length > 96) throw new RangeError('decimal-capacity');
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) throw new TypeError('invalid-decimal');
  const fraction = match[2] ?? '', exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > FOOTPRINT_DECIMAL_MAX_DIGITS) throw new RangeError('decimal-exponent');
  let scale = fraction.length - exponent;
  let digits = (match[1] + fraction).replace(/^0+/, '') || '0';
  if (scale < 0) { digits += '0'.repeat(-scale); scale = 0; }
  while (scale > 0 && digits.endsWith('0')) { digits = digits.slice(0, -1); scale -= 1; }
  if (!digits || digits === '0' || digits.length > FOOTPRINT_DECIMAL_MAX_DIGITS || scale > FOOTPRINT_DECIMAL_MAX_SCALE) throw new RangeError('decimal-capacity-or-zero');
  const coefficient = BigInt(digits), key = decimalKey(coefficient, scale), number = Number(key);
  if (!(number > 0) || !Number.isFinite(number)) throw new TypeError('invalid-decimal-number');
  return Object.freeze({ key, value: number, coefficient, scale });
}
export function footprintPriceBin(price: unknown, step: unknown): FootprintPriceBin {
  const native = canonicalFootprintDecimal(price), grouping = canonicalFootprintDecimal(step);
  const scale = Math.max(native.scale, grouping.scale);
  const priceUnits = native.coefficient * 10n ** BigInt(scale - native.scale);
  const stepUnits = grouping.coefficient * 10n ** BigInt(scale - grouping.scale);
  const low = priceUnits / stepUnits * stepUnits;
  const priceLowKey = decimalKey(low, scale), priceHighKey = decimalKey(low + stepUnits, scale);
  const priceLow = Number(priceLowKey), priceHigh = Number(priceHighKey);
  if (!Number.isFinite(priceHigh) || !(priceHigh > priceLow)) throw new RangeError('unrepresentable-price-bin');
  return Object.freeze({ priceLow, priceHigh, priceLowKey, priceHighKey, grouping: grouping.key });
}
export function emptyFootprintVolume(): FootprintVolume { return { buyBase: 0, sellBase: 0, unknownBase: 0, buyUsd: 0, sellUsd: 0, unknownUsd: 0, records: 0 }; }
export function addFootprintVolume(target: FootprintVolume, source: Readonly<FootprintVolume>): void {
  for (const key of ['buyBase', 'sellBase', 'unknownBase', 'buyUsd', 'sellUsd', 'unknownUsd', 'records'] as const) {
    const amount = source[key], result = target[key] + amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || !Number.isFinite(result) || (key === 'records' && !Number.isSafeInteger(result))) throw new RangeError('volume-overflow-or-invalid');
    target[key] = result;
  }
}
export function footprintTotals(volume: Readonly<FootprintVolume>): FootprintTotals {
  const result = emptyFootprintVolume(); addFootprintVolume(result, volume);
  const knownBase = result.buyBase + result.sellBase, observedBase = knownBase + result.unknownBase;
  const knownUsd = result.buyUsd + result.sellUsd, observedUsd = knownUsd + result.unknownUsd;
  if (![knownBase, observedBase, knownUsd, observedUsd].every(Number.isFinite)) throw new RangeError('total-overflow');
  return Object.freeze({ ...result, knownBase, observedBase, knownUsd, observedUsd, deltaBase: result.buyBase - result.sellBase, deltaUsd: result.buyUsd - result.sellUsd, deltaPercent: knownUsd > 0 ? (result.buyUsd - result.sellUsd) / knownUsd * 100 : null });
}
export function footprintGroupingAllowance(cellCount: number): number {
  if (!Number.isSafeInteger(cellCount) || cellCount < 0 || cellCount > FOOTPRINT_GROUPING_MAX_CELLS) throw new RangeError('grouping-capacity');
  return 2_048 + cellCount * FOOTPRINT_GROUPING_CELL_WORK_BYTES;
}
/** Caller holds this full working reservation before maps/output allocation. */
export function groupFootprintCells(cells: readonly FootprintCanonicalCell[], step: unknown, { reservedWorkingBytes }: { reservedWorkingBytes: number }): readonly FootprintGroupedCell[] {
  const required = footprintGroupingAllowance(cells.length);
  if (!Number.isSafeInteger(reservedWorkingBytes) || reservedWorkingBytes < required) throw new RangeError('grouping-reservation-required');
  canonicalFootprintDecimal(step);
  const grouped = new Map<string, FootprintGroupedCell & FootprintVolume>();
  for (const cell of cells) {
    const decimal = canonicalFootprintDecimal(cell.priceKey);
    if (decimal.key !== cell.priceKey || decimal.value !== cell.price) throw new TypeError('invalid-canonical-cell');
    const bin = footprintPriceBin(cell.priceKey, step), key = bin.priceLowKey;
    let target = grouped.get(key);
    if (!target) { target = { ...bin, ...emptyFootprintVolume() }; grouped.set(key, target); }
    addFootprintVolume(target, cell);
  }
  return Object.freeze([...grouped.values()].sort((a, b) => a.priceLow - b.priceLow).map(cell => Object.freeze(cell)));
}
