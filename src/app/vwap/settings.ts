import { MAX_BACK_MS, type PeriodKind } from '../keylevels/levels.ts';
import { WHALE_BANDS_USD } from '../../shared/print-sums.ts';

/**
 * The VWAP's settings: whether it shows; the session VWAP (restarting each day, week or month in the Volume profile's zone) and its bands;
 * the anchored VWAPs, kept per coin as the moments they start at; and the labels at the lines' ends and on the price axis.
 */
export interface VwapSettings {
  on: boolean;
  session: boolean;
  period: PeriodKind;
  /** Bands around the session VWAP: none, ±1 standard deviation, or ±1 and ±2. */
  bands: 0 | 1 | 2;
  /** Each coin's anchors (ms), oldest first, at most MAX_ANCHORS. */
  anchors: Record<string, number[]>;
  labels: boolean;
  tags: boolean;
  /** The whale VWAP: the average price the large market orders paid since the session began, buys and sells apart. */
  whale: boolean;
  /** The smallest order it averages: one of the whale bands, as BTC's (scaled for the coin on the page). */
  whaleUsd: number;
}

export const MAX_ANCHORS = 4;
/** Coins whose anchors are kept (a person tries many coins; the anchors of the oldest go first). */
const MAX_ANCHOR_COINS = 20;

/** Off until switched on; then the day's session VWAP, no bands, no anchors, no whale VWAP (from $1M when it is switched on). */
export const VWAP_DEFAULTS: Readonly<VwapSettings> = { on: false, session: true, period: 'day', bands: 0, anchors: {}, labels: true, tags: true, whale: false, whaleUsd: 1_000_000 };

const flag = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;

/** Settings from storage, field by field: whatever is missing or not valid falls back to the default; anchors must be times, at most four a coin. */
export function readVwap(saved: unknown): VwapSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof VwapSettings, unknown>>, d = VWAP_DEFAULTS;
  const anchors: Record<string, number[]> = {};
  if (s.anchors && typeof s.anchors === 'object') {
    for (const [coin, list] of Object.entries(s.anchors as Record<string, unknown>).slice(-MAX_ANCHOR_COINS)) {
      if (!/^[A-Z0-9]{1,20}$/.test(coin) || !Array.isArray(list)) continue;
      const times = [...new Set(list.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0))].sort((a, b) => a - b).slice(-MAX_ANCHORS);
      if (times.length) anchors[coin] = times;
    }
  }
  return {
    on: flag(s.on, d.on), session: flag(s.session, d.session),
    period: s.period === 'week' || s.period === 'month' ? s.period : 'day',
    bands: s.bands === 1 || s.bands === 2 ? s.bands : 0,
    anchors, labels: flag(s.labels, d.labels), tags: flag(s.tags, d.tags),
    whale: flag(s.whale, d.whale), whaleUsd: typeof s.whaleUsd === 'number' && WHALE_BANDS_USD.includes(s.whaleUsd) ? s.whaleUsd : d.whaleUsd,
  };
}

/** A coin's anchors still inside what the history can reach (older ones are dropped: their VWAP could not be worked out). */
export const anchorsOf = (s: VwapSettings, coin: string, now: number): number[] => (s.anchors[coin] ?? []).filter(t => t >= now - MAX_BACK_MS && t <= now);

/** The settings with an anchor added for `coin` at `t` (to the minute); refused (unchanged) when the coin has MAX_ANCHORS already. */
export function withAnchor(s: VwapSettings, coin: string, t: number, now: number): VwapSettings {
  const at = Math.floor(t / 60_000) * 60_000, list = anchorsOf(s, coin, now);
  if (list.length >= MAX_ANCHORS || list.includes(at) || at > now) return s;
  const { [coin]: _old, ...others } = s.anchors;
  return { ...s, anchors: { ...others, [coin]: [...list, at].sort((a, b) => a - b) } };
}

/** The settings with the anchor at `t` of `coin` removed. */
export function withoutAnchor(s: VwapSettings, coin: string, t: number): VwapSettings {
  const list = (s.anchors[coin] ?? []).filter(x => x !== t);
  const { [coin]: _old, ...others } = s.anchors;
  return { ...s, anchors: list.length ? { ...others, [coin]: list } : others };
}
