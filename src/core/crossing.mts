import type { LevelRecord } from '../domain/contracts.ts';

const DOWNWARD = new Set(['long', 'sell']);
const UPWARD = new Set(['short', 'buy']);

export interface CrossingLevel extends LevelRecord {
  instrumentId?: string;
  priceLow?: number;
  priceHigh?: number;
}

export function crossingDirection(level: Pick<CrossingLevel, 'layer' | 'side'>): 'down' | 'up' | null {
  if (level.layer === 'liquidation') return level.side === 'long' ? 'down' : 'up';
  if (level.layer === 'stopLoss') return DOWNWARD.has(level.side) ? 'down' : 'up';
  if (level.layer === 'takeProfit') return level.side === 'sell' ? 'up' : 'down';
  return null;
}

export function crossed(level: CrossingLevel, previousPrice: number, nextPrice: number): boolean {
  if (!Number.isFinite(previousPrice) || !Number.isFinite(nextPrice) || previousPrice === nextPrice) return false;
  const direction = crossingDirection(level);
  const rawPrice = Number(level.price);
  const rawTo = Number(level.priceTo);
  const rawLow = Number(level.priceLow);
  const rawHigh = Number(level.priceHigh);
  const low = Number.isFinite(rawLow) ? rawLow : Number.isFinite(rawTo) ? Math.min(rawPrice, rawTo) : rawPrice;
  const high = Number.isFinite(rawHigh) ? rawHigh : Number.isFinite(rawTo) ? Math.max(rawPrice, rawTo) : rawPrice;
  if (!(Number.isFinite(low) && Number.isFinite(high))) return false;
  // A coarse provider bucket is only fully taken after the whole interval is crossed.
  return direction === 'down' ? previousPrice > high && nextPrice <= low : direction === 'up' ? previousPrice < low && nextPrice >= high : false;
}

/** Bind provisional crossings to the full target, independent of provider ID reuse. */
export function crossingTargetKey(level: CrossingLevel, instrumentId: string): string | null {
  const price = Number(level.price);
  const bounds = [level.priceTo, level.priceLow, level.priceHigh];
  if (!level.layer || !level.side || !instrumentId || !Number.isFinite(price) || price <= 0
    || bounds.some(value => value != null && !Number.isFinite(Number(value)))) return null;
  return JSON.stringify([level.layer, level.instrumentId || instrumentId, level.side, price, ...bounds.map(value => value == null ? null : Number(value))]);
}

export function applyMarkPrice<T extends CrossingLevel>(levels: T[], previousPrice: number, nextPrice: number, timestamp: number, instrumentId?: string): T[] {
  return levels.map((level) => {
    if ((instrumentId && level.instrumentId && level.instrumentId !== instrumentId) || level.active === false || !crossed(level, previousPrice, nextPrice)) return level;
    return { ...level, active: false, provisional: true, takenAt: timestamp };
  });
}