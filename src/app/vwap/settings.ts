import type { PeriodKind } from '../keylevels/levels.ts';
import { ANCHOR_REACH_MS } from './vwap.ts';
import { WHALE_BANDS_USD } from '../../shared/print-sums.ts';
import { readVwapPicks, type VwapSource } from './markets.ts';
import { freeSlot, newAnchorId, readAnchor, readColor, ruleKey, type Anchor, type AnchorRule } from '../anchors/anchors.ts';

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
  /** Each coin's anchors, fixed or live (`anchors/anchors.ts`), in the order they were added, at most MAX_ANCHORS. */
  anchors: Record<string, Anchor[]>;
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
  /**
   * Colours chosen instead of the theme's (a user, 2026-11-10: "i need the coloring to be able to make amazing screenshots"): the session
   * VWAP's (its bands follow it) and each rolling window's, by its days. An anchor's own is kept with it. Layouts carry these; not the anchors.
   */
  colors: VwapColors;
}

/** The VWAP lines' own colours (`#rrggbb`); a line with none takes its default from the theme. */
export interface VwapColors { session?: string; rolling: Record<string, string> }

/** Anchors a coin can have at once: the period highs and lows a person anchors at come several at a time (4 until 2026-11-11). */
export const MAX_ANCHORS = 6;
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
export const VWAP_DEFAULTS: Readonly<VwapSettings> = { on: false, session: true, period: 'day', startMinute: null, bands: 0, rolling: [], anchors: {}, labels: true, tags: true, whale: false, whaleUsd: 1_000_000, source: 'chart', picks: [], colors: { rolling: {} } };

const flag = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;

/**
 * Settings from storage, field by field: whatever is missing or not valid falls back to the default; rolling windows must be among
 * `ROLLING_DAYS` (each once, shortest first); anchors must be times, at most four a coin.
 */
export function readVwap(saved: unknown): VwapSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof VwapSettings, unknown>>, d = VWAP_DEFAULTS;
  const anchors: Record<string, Anchor[]> = {};
  if (s.anchors && typeof s.anchors === 'object') {
    for (const [coin, list] of Object.entries(s.anchors as Record<string, unknown>).slice(-MAX_ANCHOR_COINS)) {
      if (!/^[A-Z0-9]{1,20}$/.test(coin) || !Array.isArray(list)) continue;
      // Saved before 2026-11-11 as bare times, oldest first: read as fixed anchors at those very times.
      const read = list.map((x, i) => readAnchor(x, i)).filter((a): a is Anchor => a !== null), seen = new Set<string>();
      const kept = read.filter(a => {
        const same = a.rule ? `r${ruleKey(a.rule)}` : `t${a.at}`;
        if (seen.has(a.id) || seen.has(same)) return false;
        seen.add(a.id); seen.add(same); return true;
      }).slice(-MAX_ANCHORS);
      if (kept.length) anchors[coin] = kept;
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
    source: s.source === 'chosen' ? 'chosen' : 'chart', picks: readVwapPicks(s.picks), colors: readVwapColors(s.colors),
  };
}

/** The settings with the rolling VWAP of `days` shown or not (a window that is not one of `ROLLING_DAYS` changes nothing). */
export function withRolling(s: VwapSettings, days: number, on: boolean): VwapSettings {
  if (!ROLLING_DAYS.includes(days)) return s;
  return { ...s, rolling: ROLLING_DAYS.filter(d => d === days ? on : s.rolling.includes(d)) };
}

/** The VWAP lines' colours as kept, each a `#rrggbb` or none, the rolling ones by a window of `ROLLING_DAYS`. */
export function readVwapColors(saved: unknown): VwapColors {
  const c = (saved && typeof saved === 'object' ? saved : {}) as { session?: unknown; rolling?: unknown };
  const rolling: Record<string, string> = {};
  if (c.rolling && typeof c.rolling === 'object') {
    for (const [days, value] of Object.entries(c.rolling as Record<string, unknown>)) { const color = readColor(value); if (color && ROLLING_DAYS.includes(Number(days))) rolling[days] = color; }
  }
  const session = readColor(c.session);
  return { ...(session ? { session } : {}), rolling };
}

/** A coin's anchors: the live ones, and the fixed ones within what an anchored VWAP reaches (`ANCHOR_REACH_MS`, ten years) and not after now. */
export const anchorsOf = (s: VwapSettings, coin: string, now: number): Anchor[] =>
  (s.anchors[coin] ?? []).filter(a => a.rule !== undefined || (a.at !== undefined && a.at >= now - ANCHOR_REACH_MS && a.at <= now));

/**
 * The settings with an anchor added for `coin`: fixed at `add.at` (to the minute) or live by `add.rule`, with a new id and the lowest colour
 * slot free. Unchanged when the coin has MAX_ANCHORS already, when the same minute or the same rule is there, or for a time to come or
 * further back than an anchor reaches.
 */
export function withAnchor(s: VwapSettings, coin: string, add: { at: number } | { rule: AnchorRule }, now: number): VwapSettings {
  // A fixed anchor no longer drawn (further back than an anchor reaches) is dropped here, not counted: six such would refuse every new one
  // while the list showed none (Sol, review 2026-11-11).
  const list = anchorsOf(s, coin, now);
  if (list.length >= MAX_ANCHORS) return s;
  let anchor: Anchor;
  if ('at' in add) {
    const at = Math.floor(add.at / 60_000) * 60_000;
    if (at > now || at < now - ANCHOR_REACH_MS || list.some(a => a.at === at)) return s;
    anchor = { id: newAnchorId(now), at, slot: freeSlot(list) };
  } else {
    if (list.some(a => a.rule && ruleKey(a.rule) === ruleKey(add.rule))) return s;
    anchor = { id: newAnchorId(now), rule: add.rule, slot: freeSlot(list) };
  }
  const { [coin]: _old, ...others } = s.anchors;
  return { ...s, anchors: { ...others, [coin]: [...list, anchor] } };
}

/**
 * The settings with `anchor` put back into `coin`'s list at `index` (Undo after a remove), as it was: its id, colour and slot. Unchanged when
 * the list is full again, or holds it, or an anchor at the same minute or by the same rule.
 */
export function restoreAnchor(s: VwapSettings, coin: string, anchor: Anchor, index: number): VwapSettings {
  const list = s.anchors[coin] ?? [];
  const same = (a: Anchor): boolean => a.id === anchor.id || (anchor.rule ? a.rule !== undefined && ruleKey(a.rule) === ruleKey(anchor.rule) : a.at === anchor.at);
  if (list.length >= MAX_ANCHORS || list.some(same)) return s;
  // An anchor added since may hold its colour slot: it takes a free one then, so no two lines share a default colour (Sol, review 2026-11-11).
  const back = list.some(a => a.slot === anchor.slot) ? { ...anchor, slot: freeSlot(list) } : anchor;
  const copy = [...list]; copy.splice(Math.max(0, Math.min(index, copy.length)), 0, back);
  return { ...s, anchors: { ...s.anchors, [coin]: copy } };
}

/**
 * The settings with the anchor `was` put back as it was before a move or a freeze (Undo), only while it is still as that left it (`now`): a
 * change since (another move, a colour, a remove) leaves it alone. Unchanged too when putting it back would make it the same as another.
 */
export function putBackAnchor(s: VwapSettings, coin: string, now: Anchor, was: Anchor): VwapSettings {
  const list = s.anchors[coin] ?? [], i = list.findIndex(a => a.id === was.id);
  if (i < 0 || JSON.stringify(list[i]) !== JSON.stringify(now)) return s;
  const clash = list.some((a, k) => k !== i && (was.rule ? a.rule !== undefined && ruleKey(a.rule) === ruleKey(was.rule) : a.at === was.at));
  if (clash) return s;
  const copy = [...list]; copy[i] = was;
  return { ...s, anchors: { ...s.anchors, [coin]: copy } };
}

/** Whether any VWAP line has a colour of its own (the panel then offers Reset colours). */
export const hasOwnColors = (s: VwapSettings, coin: string): boolean =>
  s.colors.session !== undefined || Object.keys(s.colors.rolling).length > 0 || (s.anchors[coin] ?? []).some(a => a.color !== undefined);
/** The settings with every VWAP line back to its theme colour: the session's, the rolling ones' and `coin`'s anchors'. */
export function withThemeColors(s: VwapSettings, coin: string): VwapSettings {
  const list = s.anchors[coin];
  return { ...s, colors: { rolling: {} }, ...(list ? { anchors: { ...s.anchors, [coin]: list.map(({ color: _c, ...a }) => a) } } : {}) };
}

/** The settings with the anchor `id` of `coin` removed. */
export function withoutAnchor(s: VwapSettings, coin: string, id: string): VwapSettings {
  const list = (s.anchors[coin] ?? []).filter(a => a.id !== id);
  const { [coin]: _old, ...others } = s.anchors;
  return { ...s, anchors: list.length ? { ...others, [coin]: list } : others };
}

/**
 * The settings with the anchor `id` of `coin` changed: moved to a moment (`at`: fixed from then on, the rule it followed dropped), set to
 * follow a rule (its moment dropped), its colour (null: back to its default) or whether it is drawn. Unchanged when there is no such anchor,
 * or when the change would make it the same as another.
 */
export function changeAnchor(s: VwapSettings, coin: string, id: string, change: { at?: number; rule?: AnchorRule; color?: string | null; hidden?: boolean }): VwapSettings {
  const list = s.anchors[coin] ?? [], i = list.findIndex(a => a.id === id);
  if (i < 0) return s;
  let next: Anchor = { ...list[i]! };
  if (change.at !== undefined) {
    const at = Math.floor(change.at / 60_000) * 60_000;
    if (list.some((a, k) => k !== i && a.at === at)) return s;
    const { rule: _rule, ...rest } = next; next = { ...rest, at };
  } else if (change.rule) {
    const key = ruleKey(change.rule);
    if (list.some((a, k) => k !== i && a.rule !== undefined && ruleKey(a.rule) === key)) return s;
    const { at: _at, ...rest } = next; next = { ...rest, rule: change.rule };
  }
  if (change.color === null) { const { color: _c, ...rest } = next; next = rest; }
  else if (change.color !== undefined) { const color = readColor(change.color); if (color) next = { ...next, color }; }
  if (change.hidden !== undefined) { const { hidden: _h, ...rest } = next; next = change.hidden ? { ...rest, hidden: true } : rest; }
  const copy = [...list]; copy[i] = next;
  return { ...s, anchors: { ...s.anchors, [coin]: copy } };
}
