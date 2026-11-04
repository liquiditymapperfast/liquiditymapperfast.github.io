import type { OiReading } from './engine.ts';

/**
 * Open interest on one side of every contract, as Binance, OKX, Bitget and Deribit report it and Bybit's `singleOpenInterest` says.
 * Hyperliquid's `openInterest` (its asset contexts: `activeAssetCtx`, `metaAndAssetCtxs`) counts both sides, longs plus shorts. One side
 * can move at most the volume traded, and Hyperliquid's moved up to twice it: between one-second contexts of its public socket by exactly
 * twice and never more (measured 2026-11-03), and over 15 minutes of this page's own BTC recordings by more than the coins traded in
 * 2.3 % of windows, where Binance's, Bybit's and OKX's never did (2026-11-04). So every reader takes half of it, and the venues add up.
 */
export const hyperliquidOneSide = (openInterest: number): number => openInterest / 2;

/**
 * A stored reading on one side. What a build from 2026-11-04 on writes is marked (`sides: 1`): its own readings, and an hour file's
 * readings, whose Hyperliquid figure is halved where the file is decoded (`app/browser/history-import.ts`). An unmarked Hyperliquid row
 * was written before, with Hyperliquid's own figure, and is read as half of it; the stored row stays as it was, so nothing is halved
 * twice. Every other venue's rows are on one side already (Bybit's since 2026-10-14, and a page keeps a day).
 */
export function oneSidedReading(row: OiReading): OiReading {
  if (row.sides === 1 || row.venue !== 'hyperliquid') return row;
  return { ...row, base: hyperliquidOneSide(row.base), ...(row.quote === undefined ? {} : { quote: hyperliquidOneSide(row.quote) }), sides: 1 };
}
