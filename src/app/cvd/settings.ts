import { HEIGHT_MODES, type HeightMode } from './layout.ts';
import { DEFAULT_STAT_OPTIONS } from '../stat-options.ts';

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
  /** How many exchange rows; 0 (the default) shows every exchange that has traded. */
  top: number;
  /**
   * Set on every save since showing every exchange became the default: a top of 8 in a save without it is the old default, not a choice,
   * and reads as 0 once (an 8 chosen since stays 8).
   */
  v: 2;
  heights: HeightMode;
  /** Re-rank every `refreshMin` minutes (off: the first layout stays). */
  auto: boolean; refreshMin: number;
  /** Exchanges (family keys such as `hyperliquid`, `binance`) kept in the list even when they are not among the biggest; they take the last places. */
  pinned: string[];
  /** Flag an exchange that has not traded in the last five completed minutes. */
  quietFlag: boolean;
  /** Draw each line from zero at the left edge (off: the running total since the history began). */
  rebase: boolean;
  /**
   * The strip of dot rows above the exchanges (buys against sells over the last minutes, and by trade size): whether it shows; the size
   * bands it splits the trades into, as the numbers of the footprint's size buckets (retail is up to `stripRetailMax`, whales from
   * `stripWhaleMin`, and the first bucket on a row of its own when `stripSmall`); and whether the leading dot of a size row blinks when
   * a trade of that size prints. The Bar stats' own limits are the starting values.
   */
  strip: boolean; stripRetailMax: number; stripWhaleMin: number; stripSmall: boolean; stripBlink: boolean;
}

export const CVD_DEFAULTS: Readonly<CvdSettings> = { span: 'map', rank: '1h', top: 0, v: 2, heights: 'golden', auto: true, refreshMin: 1, pinned: [], quietFlag: true, rebase: true,
  strip: true, stripRetailMax: DEFAULT_STAT_OPTIONS.retailMax, stripWhaleMin: DEFAULT_STAT_OPTIONS.whaleMin, stripSmall: true, stripBlink: true };

/** The settings that decide which exchanges are rows and in what order: when only the others change, the rows stay where they are. */
export const rankingKey = (c: CvdSettings): string => [c.span, c.rank, c.top, c.heights, c.auto, c.refreshMin, c.pinned.join(','), c.quietFlag, c.rebase].join('|');

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
  const top = s.v !== 2 && s.top === 8 ? 0 : bounded(s.top, 0, 32, d.top);
  // Retail ends in one of the first seven buckets and whales start in a later one, whatever a damaged save says.
  const stripRetailMax = bounded(s.stripRetailMax, 0, 6, d.stripRetailMax), stripWhaleMin = Math.max(stripRetailMax + 1, bounded(s.stripWhaleMin, 1, 7, d.stripWhaleMin));
  return {
    span: oneOf(CVD_SPANS, s.span, d.span), rank: oneOf(RANK_WINDOWS, s.rank, d.rank), top: top > 0 && top < 3 ? 3 : top, v: 2,
    heights: oneOf(HEIGHT_MODES, s.heights, d.heights),
    auto: typeof s.auto === 'boolean' ? s.auto : d.auto, refreshMin: bounded(s.refreshMin, 1, 60, d.refreshMin),
    pinned: readPinned(s),
    quietFlag: typeof s.quietFlag === 'boolean' ? s.quietFlag : d.quietFlag,
    rebase: typeof s.rebase === 'boolean' ? s.rebase : d.rebase,
    strip: typeof s.strip === 'boolean' ? s.strip : d.strip, stripRetailMax, stripWhaleMin,
    stripSmall: typeof s.stripSmall === 'boolean' ? s.stripSmall : d.stripSmall, stripBlink: typeof s.stripBlink === 'boolean' ? s.stripBlink : d.stripBlink,
  };
}
