import { MAX_BACK_MS, type PeriodKind } from '../keylevels/levels.ts';
import { WHALE_BANDS_USD } from '../../shared/print-sums.ts';
import { readVwapPicks, type VwapSource } from './markets.ts';

/**
 * The VWAP's settings: whether it shows; the session VWAP (restarting each day, week or month in the Volume profile's zone) and its bands;
 * the rolling VWAPs (each over the last days up to now); the anchored VWAPs, kept per coin as the moments they start at; the labels at the
 * lines' ends and on the price axis; and whose candles the session, rolling and anchored lines are worked out from.
 */
export interface VwapSettings {
  on: boolean;
  session: boolean;
  period: PeriodKind;
  /** Minutes after midnight of the zone the day's session VWAP starts at (null: midnight, the day's own start). */
  startMinute: number | null;
  /** Bands around the session VWAP: none, ±1 standard deviation, or ±1 and ±2. */
  bands: 0 | 1 | 2;
  /** The rolling VWAPs shown: each a window of days of `ROLLING_DAYS`, shortest first (none by default). */
  rolling: number[];
  /** Each coin's anchors (ms), oldest first, at most MAX_ANCHORS. */
  anchors: Record<string, number[]>;
  labels: boolean;
  tags: boolean;
  /** The whale VWAP: the average price the large market orders paid since the session began, buys and sells apart. */
  whale: boolean;
  /** The smallest order it averages: one of the whale bands, as BTC's (scaled for the coin on the page). */
  whaleUsd: number;
  /** Whose candles the session, rolling and anchored lines add up: the chart's market, or the markets chosen (`picks`, `vwap/markets.ts`). */
  source: VwapSource;
  /** The markets chosen, as exchange and kind (`binance/spot`), at most `MAX_VWAP_MARKETS`: kept when the source is the chart's again. */
  picks: string[];
}

export const MAX_ANCHORS = 4;
/** The rolling VWAPs' windows, in days: a day, a week, a month, a quarter, half a year and a year. */
export const ROLLING_DAYS: readonly number[] = [1, 7, 30, 90, 180, 365];

/** The choices of a day's start ("HH:MM" shown as the zone's clock reads it): midnight by default, or the hour an exchange's or a market's day opens. */
export const VWAP_STARTS: readonly [string, string][] = [
  ['', '00:00'], ['60', '01:00'], ['120', '02:00'], ['180', '03:00'], ['240', '04:00'], ['300', '05:00'], ['360', '06:00'],
  ['420', '07:00'], ['480', '08:00'], ['540', '09:00'], ['600', '10:00'], ['660', '11:00'], ['720', '12:00'], ['780', '13:00'],
  ['840', '14:00'], ['900', '15:00'], ['960', '16:00'], ['1020', '17:00'], ['1080', '18:00'], ['1140', '19:00'],
  ['1200', '20:00'], ['1260', '21:00'], ['1320', '22:00'], ['1380', '23:00'],
];
/** Coins whose anchors are kept (a person tries many coins; the anchors of the oldest go first). */
const MAX_ANCHOR_COINS = 20;

/**
 * Off until switched on; then the day's session VWAP, no bands, no rolling VWAP, no anchors, no whale VWAP (from $1M when it is switched on),
 * from the chart market's candles.
 */
export const VWAP_DEFAULTS: Readonly<VwapSettings> = { on: false, session: true, period: 'day', startMinute: null, bands: 0, rolling: [], anchors: {}, labels: true, tags: true, whale: false, whaleUsd: 1_000_000, source: 'chart', picks: [] };

const flag = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;

/**
 * Settings from storage, field by field: whatever is missing or not valid falls back to the default; rolling windows must be among
 * `ROLLING_DAYS` (each once, shortest first); anchors must be times, at most four a coin.
 */
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
    startMinute: typeof s.startMinute === 'number' && Number.isInteger(s.startMinute) && s.startMinute >= 0 && s.startMinute < 1_440 ? s.startMinute : null,
    bands: s.bands === 1 || s.bands === 2 ? s.bands : 0,
    rolling: Array.isArray(s.rolling) ? ROLLING_DAYS.filter(days => (s.rolling as unknown[]).includes(days)) : [],
    anchors, labels: flag(s.labels, d.labels), tags: flag(s.tags, d.tags),
    whale: flag(s.whale, d.whale), whaleUsd: typeof s.whaleUsd === 'number' && WHALE_BANDS_USD.includes(s.whaleUsd) ? s.whaleUsd : d.whaleUsd,
    source: s.source === 'chosen' ? 'chosen' : 'chart', picks: readVwapPicks(s.picks),
  };
}

/** The settings with the rolling VWAP of `days` shown or not (a window that is not one of `ROLLING_DAYS` changes nothing). */
export function withRolling(s: VwapSettings, days: number, on: boolean): VwapSettings {
  if (!ROLLING_DAYS.includes(days)) return s;
  return { ...s, rolling: ROLLING_DAYS.filter(d => d === days ? on : s.rolling.includes(d)) };
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
