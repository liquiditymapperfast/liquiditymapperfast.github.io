import { HEIGHT_MODES, type HeightMode } from './layout.ts';

/** How much time the column shows: the map's own span, or a fixed one ending now. */
export const CVD_SPANS = ['map', '5m', '15m', '1h', '4h', '24h'] as const;
export type CvdSpan = typeof CVD_SPANS[number];
export const CVD_SPAN_MS: Readonly<Record<Exclude<CvdSpan, 'map'>, number>> = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '24h': 86_400_000 };

/** The window the ranking, the share and the label figures are taken over. */
export const RANK_WINDOWS = ['15m', '1h', '24h'] as const;
export type RankWindow = typeof RANK_WINDOWS[number];
export const RANK_MS: Readonly<Record<RankWindow, number>> = { '15m': 900_000, '1h': 3_600_000, '24h': 86_400_000 };

export interface CvdSettings {
  span: CvdSpan;
  rank: RankWindow;
  /** How many exchange rows; 0 shows every exchange that has traded. */
  top: number;
  heights: HeightMode;
  /** Re-rank every `refreshMin` minutes (off: the first layout stays). */
  auto: boolean; refreshMin: number;
  /** Exchanges (family keys such as `hyperliquid`, `binance`) kept in the list even when they are not among the biggest; they take the last places. */
  pinned: string[];
  /** Flag an exchange that has not traded in the last five completed minutes. */
  quietFlag: boolean;
  /** Draw each line from zero at the left edge (off: the running total since the history began). */
  rebase: boolean;
}

export const CVD_DEFAULTS: Readonly<CvdSettings> = { span: 'map', rank: '1h', top: 8, heights: 'golden', auto: true, refreshMin: 1, pinned: [], quietFlag: true, rebase: true };

/** The most exchanges that can be pinned (there are about twenty venues; this is a bound on what a damaged save can hold). */
export const MAX_PINNED = 32;

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T => list.includes(value as T) ? value as T : fallback;
const bounded = (value: unknown, min: number, max: number, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;

/** The pinned list: strings only, no repeats, no more than `MAX_PINNED`. A save from before the list existed had one switch, for Hyperliquid. */
function readPinned(s: Record<string, unknown>): string[] {
  if (Array.isArray(s.pinned)) return [...new Set(s.pinned.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 40))].slice(0, MAX_PINNED);
  return s.pinHyperliquid === true ? ['hyperliquid'] : [];
}

/** Settings from storage, field by field: whatever is missing or not valid falls back to the default. */
export function readCvd(saved: unknown): CvdSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>, d = CVD_DEFAULTS;
  const top = bounded(s.top, 0, 32, d.top);
  return {
    span: oneOf(CVD_SPANS, s.span, d.span), rank: oneOf(RANK_WINDOWS, s.rank, d.rank), top: top > 0 && top < 3 ? 3 : top,
    heights: oneOf(HEIGHT_MODES, s.heights, d.heights),
    auto: typeof s.auto === 'boolean' ? s.auto : d.auto, refreshMin: bounded(s.refreshMin, 1, 60, d.refreshMin),
    pinned: readPinned(s),
    quietFlag: typeof s.quietFlag === 'boolean' ? s.quietFlag : d.quietFlag,
    rebase: typeof s.rebase === 'boolean' ? s.rebase : d.rebase,
  };
}
