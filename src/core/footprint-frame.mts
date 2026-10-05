import type { FootprintWindow } from './footprint-model.mts';
import { scanBoundedJsonComplexity } from './bounded-json-response.mts';

export const FOOTPRINT_FRAME_LIMITS = Object.freeze({
  maxWireBytes: 512 * 1_024, maxCells: 8_192, maxMinutes: 180, maxSources: 16,
  maxJsonDepth: 8, maxJsonTokens: 180_000, maxString: 192, maxWindowKey: 1_024,
});
export const FOOTPRINT_INTERVALS: readonly number[] = Object.freeze([60_000, 300_000, 900_000, 1_800_000, 3_600_000]);
const volumeKeys = ['buyBase', 'sellBase', 'unknownBase', 'buyUsd', 'sellUsd', 'unknownUsd', 'records'] as const;
const totalKeys = [...volumeKeys, 'knownBase', 'observedBase', 'knownUsd', 'observedUsd', 'deltaBase', 'deltaUsd', 'deltaPercent'];
const cellKeys = [...volumeKeys, 'priceLow', 'priceHigh', 'priceLowKey', 'priceHighKey', 'grouping'];


