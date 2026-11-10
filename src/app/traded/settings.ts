import { t } from '../i18n.ts';
import { knownZone, localZone, minutesOf, type SessionDef } from './sessions.ts';
import { PROFILE_METRICS, isMetric, type ProfileMetric } from '../measures/registry.ts';
import { defaultSet, readProfileSet, setFromLegacy, type ProfileSet } from './profiles.ts';
import { ANCHOR_BAR_MS, ANCHOR_EVERY, ANCHOR_EVERY_DEFAULT } from './anchor.ts';

/**
 * The Traded feature's settings (the column itself is switched on and off with `show.traded`):
 * - the column's bars: buys and sells side by side, or the difference (delta);
 * - whether the column marks the point of control and the value area, which share of the volume the value area holds, and the size of the
 *   price rows they are read from (a multiple of the map's grid step: the column's own rows follow the zoom, these must not);
 * - the lines on the chart: the point of control, the value area high and low, their labels and tags; across the chart what the columns add
 *   up, which is always what is on the chart, and on it the periods chosen (each day, week or month of a zone, or sessions) with their past
 *   ones, the profiles of one kind of them, what they are worked out from (the recording, as far back as it keeps trades, or the most traded
 *   venue's candles, an estimate that reaches back further), and whether a point of control nobody has traded through since (a naked one)
 *   runs on to the right;
 * - where each measure's profile is drawn: right or left of the map by price, or along the top by time (traded/profiles.ts), over the same
 *   stretch and in the same look.
 */
/** A kind of window drawn on the chart. */
export type LineKind = 'day' | 'week' | 'month' | 'sessions';
export const LINE_KINDS: readonly LineKind[] = ['day', 'week', 'month', 'sessions'];

export interface TradedSettings {
  /**
   * Where each measure's profile is drawn (traded/profiles.ts): a column right of the map, a column left of it, or a band along the top, any
   * measure of the registry (measures/registry.ts) in any of them, each over what is on the chart in the look set below.
   */
  placements: ProfileSet;
  bars: 'split' | 'delta';
  /** Split bars draw the stronger side of each row a little brighter and the weaker dimmer, the more one-sided the more (traded/emphasis.ts). */
  emphasis: boolean;
  valueArea: boolean;
  /** The value area's share of the volume, in percent. */
  share: number;
  /** Row size for the point of control and the value area, as a multiple of the map's grid step. */
  rows: number;
  poc: boolean; va: boolean; labels: boolean;
  /**
   * The periods drawn on the chart (Karl, 2026-10-19: the columns always add up what is on the chart, so the fixed column at the side is in
   * step with it; days, weeks, months and sessions are drawn over their own time): each kind's point-of-control and value-area lines, its
   * past ones, names and untouched runs.
   */
  lines: LineKind[];
  /**
   * Whether the chart window's own lines are drawn: the point of control and value area of everything on the chart, the columns' levels
   * (Karl, 2026-10-20: a row of the periods grid of its own, on by default and independent of the period lines, so no lines at all is a choice
   * the grid can show).
   */
  windowLines: boolean;
  /** The one kind whose traded-volume profiles are drawn on the chart, over each window's own time (one, so they never lie over each other); null: none. */
  profiles: LineKind | null;
  /**
   * What days, weeks and sessions are worked out from: `recorded`, the recording's trades on the flow column's venues (only as far back as
   * the recording keeps them: `recordedCount`), or `candles`, one venue's candles with each one's volume spread over its range (`candleLevels`).
   */
  source: 'recorded' | 'candles';
  /** The zone days and weeks start in: `page` (the page's clock, UTC or this computer's), `local`, `UTC` or an IANA name. */
  zone: string;
  /** How many past days, weeks or sessions (of each session) are drawn, the open one among them (from the recording, at most `recordedCount`). */
  count: number;
  naked: boolean;
  /**
   * Whether the previous period's point of control and value area are carried across the one under way, dashed and fainter, whether or not
   * price has traded through them (Karl, 2026-10-25): for each kind whose lines are on, from the recording only while it still holds that
   * period, else from candles.
   */
  carry: boolean;
  /** Whether the lines that reach the right edge (the window under way, an untouched point of control running on) are named on the price axis. */
  tags: boolean;
  sessions: SessionDef[];
  /**
   * What the columns by price add up (Karl, 2026-11-10): what is on the chart (the default, as since 2026-10-19), or from the coin's anchor
   * up to now (`anchors`, `traded/anchor.ts`), worked out again every `every` minutes. The bands along the top stay with the chart.
   */
  columns: 'chart' | 'anchor';
  /** Each coin's anchor (ms, on five minutes), at most `MAX_ANCHOR_COINS` coins: like the VWAP's, the chart's own, not a layout's. */
  anchors: Record<string, number>;
  /** How often an anchored window is worked out again, in minutes (`ANCHOR_EVERY`). */
  every: number;
}

/**
 * The profile along the top as saves from 2026-10-20 held it, before it was one of the places a measure can be drawn: one measure, on or
 * off. Read into `placements` (`setFromLegacy`).
 */
export interface LegacyTop { on: boolean; metric: ProfileMetric }
const LEGACY_TOP: LegacyTop = { on: true, metric: 'volume' };

export const ROW_MULTIPLES = [0.25, 0.5, 1, 2, 5, 10] as const;
export const SHARES = [50, 60, 68, 70, 75, 80, 85, 90, 95] as const;
export const MAX_SESSIONS = 8, MAX_COUNT = 20, MAX_MONTHS = 4;

const DAY = 86_400_000;
/**
 * How many days, weeks or sessions (of each) the recording can still work out, the open one among them, when it keeps `retentionMs` of
 * trades: those that began inside it (`recordedWindows`). Days and sessions: one a day kept. Weeks: the one under way, which began at most
 * seven days ago, and none when less than a week is kept (a page reading the exchanges itself keeps a day). Older ones are no longer there.
 */
export function recordedCount(period: LineKind, retentionMs: number): number {
  if (period === 'month') return 0;
  if (period === 'week') return retentionMs >= 7 * DAY ? 1 : 0;
  return Math.max(0, Math.floor(retentionMs / DAY));
}
/** The settings as they apply to one kind of window: what the helpers below read. */
export type KindSettings = Pick<TradedSettings, 'source' | 'count' | 'zone' | 'sessions'> & { period: LineKind };
/** How many past ones are drawn: the setting, and from the recording no more than it can still work out. */
export function linesCount(s: KindSettings, retentionMs: number): number {
  return linesSource(s) === 'candles' ? Math.min(s.count, mostCount(s)) : Math.min(s.count, recordedCount(s.period, retentionMs));
}
/**
 * The kinds of window drawn on the chart: those whose lines are on, then the profiles' kind when its lines are not, each once (a profile is
 * drawn on its window's levels, so its windows are worked out either way).
 */
export function chartKinds(s: Pick<TradedSettings, 'lines' | 'profiles'>): LineKind[] {
  return [...s.lines, ...(s.profiles && !s.lines.includes(s.profiles) ? [s.profiles] : [])];
}
/**
 * What the lines of past days, weeks, months or sessions are worked out from: the setting, but a month always from candles (it is longer
 * than the recording keeps, so no month can be worked out from it; the panel says so rather than offer the choice).
 */
export const linesSource = (s: Pick<KindSettings, 'period' | 'source'>): TradedSettings['source'] => s.period === 'month' ? 'candles' : s.source;
/** How many past ones candles can draw: twenty weeks of them hold four whole months. */
export const mostCount = (s: Pick<KindSettings, 'period'>): number => s.period === 'month' ? MAX_MONTHS : MAX_COUNT;

/** The zones offered by name: the page's clock, UTC, this computer, and the cities whose markets set the usual sessions. */
export const ZONES: readonly { zone: string; label: string }[] = [
  { zone: 'page', label: t("The page's clock") }, { zone: 'UTC', label: 'UTC' }, { zone: 'local', label: t('This computer') },
  { zone: 'America/New_York', label: t('New York') }, { zone: 'America/Chicago', label: t('Chicago') }, { zone: 'Europe/London', label: t('London') },
  { zone: 'Europe/Berlin', label: t('Frankfurt') }, { zone: 'Asia/Tokyo', label: t('Tokyo') }, { zone: 'Asia/Hong_Kong', label: t('Hong Kong') },
  { zone: 'Asia/Singapore', label: t('Singapore') }, { zone: 'Australia/Sydney', label: t('Sydney') },
];

/** The usual sessions, each in its market's own time: what the Add buttons put in the list. */
export const SESSION_PRESETS: readonly Omit<SessionDef, 'id' | 'on'>[] = [
  { name: t('Asia'), zone: 'Asia/Tokyo', start: '09:00', end: '18:00', weekdays: false },
  { name: t('London'), zone: 'Europe/London', start: '08:00', end: '17:00', weekdays: false },
  { name: t('New York'), zone: 'America/New_York', start: '08:00', end: '17:00', weekdays: false },
  { name: t('US stocks'), zone: 'America/New_York', start: '09:30', end: '16:00', weekdays: true },
  { name: t('UTC day'), zone: 'UTC', start: '00:00', end: '00:00', weekdays: false },
];

const preset = (i: number, id: string): SessionDef => ({ ...SESSION_PRESETS[i]!, id, on: true });

export const TRADED_DEFAULTS: Readonly<TradedSettings> = {
  placements: defaultSet(), bars: 'split', emphasis: true, valueArea: true, share: 70, rows: 1, poc: true, va: true, labels: true, tags: true,
  // Each day's lines on the chart from the first visit (Karl, 2026-10-20: what is new must show without hunting for it); its profiles no
  // longer (Karl, 2026-10-28: the daily profile off by default, the profiles at the side kept): one click in the panel's Profiles row.
  lines: ['day'], windowLines: true, profiles: null, source: 'recorded', zone: 'page', count: 5, naked: true, carry: true,
  sessions: [preset(0, 's1'), preset(1, 's2'), preset(2, 's3')],
  columns: 'chart', anchors: {}, every: ANCHOR_EVERY_DEFAULT,
};

/** The IANA name of a stored zone: `page` follows the page's clock setting, `local` is this computer's. */
export function resolveZone(zone: string, pageZone: 'local' | 'utc'): string {
  if (zone === 'page') return pageZone === 'utc' ? 'UTC' : localZone();
  if (zone === 'local') return localZone();
  return zone;
}

const oneOf = <T extends string | number>(list: readonly T[], value: unknown, fallback: T): T => list.includes(value as T) ? value as T : fallback;
const flag = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;
const zoneOk = (value: unknown): value is string => typeof value === 'string' && (value === 'page' || value === 'local' || value === 'UTC' || (value.length <= 64 && knownZone(value)));

/** One stored session, checked: a name, a zone the browser knows, two times; anything else is dropped. */
function readSession(value: unknown, index: number): SessionDef | null {
  const s = value as Partial<Record<keyof SessionDef, unknown>> | null;
  if (!s || typeof s !== 'object' || typeof s.start !== 'string' || typeof s.end !== 'string' || minutesOf(s.start) === null || minutesOf(s.end) === null || !zoneOk(s.zone) || s.zone === 'page') return null;
  const name = typeof s.name === 'string' ? s.name.slice(0, 40) : '';
  const id = typeof s.id === 'string' && /^[\w-]{1,24}$/.test(s.id) ? s.id : `s${index + 1}`;
  return { id, name, zone: s.zone, start: s.start, end: s.end, on: flag(s.on, true), weekdays: flag(s.weekdays, false) };
}

/** The measures of an older save's list of columns this page knows, each once, in the registry's order; null when none is left. */
export function readMetrics(saved: readonly unknown[]): ProfileMetric[] | null {
  const kept = PROFILE_METRICS.filter(m => saved.includes(m));
  return kept.length ? kept : null;
}

/**
 * Settings from storage, field by field: whatever is missing or not valid falls back to the default. A save from before the places (its
 * columns' `metrics`, or one `metric`, and its profile along the top, `top`, or a measure strip beside it, `strip`) has each column right
 * of the map and its profile along the top as it was, switched off where it was off; read again, the places read as themselves.
 */
export function readTraded(saved: unknown, strip: LegacyTop | null = null): TradedSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>, d = TRADED_DEFAULTS;
  const count = typeof s.count === 'number' && Number.isFinite(s.count) ? Math.max(1, Math.min(MAX_COUNT, Math.round(s.count))) : d.count;
  const sessions = Array.isArray(s.sessions) ? s.sessions.slice(0, MAX_SESSIONS).flatMap((x, i) => { const r = readSession(x, i); return r ? [r] : []; }) : d.sessions.map(x => ({ ...x }));
  // Ids are what a window's key is made of: two sessions must not share one.
  const seen = new Set<string>();
  for (const x of sessions) { while (seen.has(x.id)) x.id = `${x.id}x`.slice(-24); seen.add(x.id); }
  // A save from when the columns could add up a day, week, month or sessions (`period`): that kind is drawn on the chart instead, with its
  // profiles there when they were drawn (`pastProfiles`).
  const kind = (v: unknown): LineKind | null => LINE_KINDS.includes(v as LineKind) ? v as LineKind : null;
  const old = kind(s.period), wanted = Array.isArray(s.lines) ? s.lines as unknown[] : old ? [] : [...d.lines];
  // A save from before the places says what its columns and its profile along the top were; one that says nothing gets the first visit's.
  const legacy = s.metrics !== undefined || s.metric !== undefined || s.top !== undefined || strip !== null;
  return {
    // A save from when the column showed one measure (`metric`) reads as that one column.
    placements: readProfileSet(s.placements) ?? (legacy ? setFromLegacy(readMetrics(Array.isArray(s.metrics) ? s.metrics : [s.metric]) ?? ['volume'], readTop(s.top) ?? strip ?? LEGACY_TOP) : defaultSet()),
    bars: oneOf(['split', 'delta'] as const, s.bars, d.bars), emphasis: flag(s.emphasis, d.emphasis),
    valueArea: flag(s.valueArea, d.valueArea), share: oneOf(SHARES, s.share, d.share), rows: oneOf(ROW_MULTIPLES, s.rows, d.rows),
    poc: flag(s.poc, d.poc), va: flag(s.va, d.va), labels: flag(s.labels, d.labels), tags: flag(s.tags, d.tags),
    lines: LINE_KINDS.filter(k => wanted.includes(k) || k === old), windowLines: flag(s.windowLines, d.windowLines),
    profiles: s.profiles === null ? null : kind(s.profiles) ?? (s.pastProfiles === true ? old : s.profiles === undefined ? d.profiles : null),
    source: oneOf(['recorded', 'candles'] as const, s.source, d.source),
    zone: zoneOk(s.zone) ? s.zone : d.zone, count, naked: flag(s.naked, d.naked), carry: flag(s.carry, d.carry), sessions,
    columns: s.columns === 'anchor' ? 'anchor' : 'chart', anchors: readAnchors(s.anchors), every: oneOf(ANCHOR_EVERY, s.every, d.every),
  };
}

/** Coins whose profile anchors are kept (a person tries many coins; the oldest coins' go first). */
const MAX_ANCHOR_COINS = 20;
/** Saved profile anchors, checked: a coin's name, a time on five minutes. */
function readAnchors(saved: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
  for (const [coin, at] of Object.entries(saved as Record<string, unknown>).slice(-MAX_ANCHOR_COINS)) {
    if (/^[A-Z0-9]{1,20}$/.test(coin) && typeof at === 'number' && Number.isFinite(at) && at > 0) out[coin] = Math.floor(at / ANCHOR_BAR_MS) * ANCHOR_BAR_MS;
  }
  return out;
}

/** A coin's profile anchor while the candle estimate can still reach it (`backMs`) and it has begun, else null. */
export const profileAnchorOf = (s: Pick<TradedSettings, 'anchors'>, coin: string, now: number, backMs: number): number | null => {
  const at = s.anchors[coin];
  return at !== undefined && at >= now - backMs && at <= now ? at : null;
};
/** The settings with `coin`'s profile anchor at `at` (the coin's last), or without one (`at` null). */
export function withProfileAnchor(s: TradedSettings, coin: string, at: number | null): TradedSettings {
  const { [coin]: _old, ...others } = s.anchors;
  return { ...s, anchors: at === null ? others : { ...others, [coin]: at } };
}

/** An older save's profile along the top, or null when it has none to read (a save from before it, or junk). */
function readTop(saved: unknown): LegacyTop | null {
  if (!saved || typeof saved !== 'object') return null;
  const s = saved as Record<string, unknown>;
  return { on: flag(s.on, LEGACY_TOP.on), metric: isMetric(s.metric) ? s.metric : LEGACY_TOP.metric };
}

/**
 * The profile along the top from the measure strip it replaced (`measureStrip`, saved from 2026-10-19 to 2026-10-20), or null when a save
 * has none: its switch as it was, open interest as open interest, and delta as traded volume (the bars' Delta setting draws the delta, and
 * `bars` is left as it was chosen).
 */
export function topFromStrip(saved: unknown): LegacyTop | null {
  if (!saved || typeof saved !== 'object') return null;
  const s = saved as Record<string, unknown>;
  return { on: s.on === true, metric: s.kind === 'oi' ? 'oi' : 'volume' };
}

/** Whether stored Volume profile settings say where the profile along the top is already (then a measure strip beside them is not read). */
export const hasTop = (saved: unknown): boolean => !!saved && typeof saved === 'object' && ((saved as Record<string, unknown>).top !== undefined || (saved as Record<string, unknown>).placements !== undefined);

/** A new session's id: one no session in the list has. */
export function newSessionId(sessions: readonly SessionDef[]): string {
  for (let i = 1; ; i++) if (!sessions.some(s => s.id === `s${i}`)) return `s${i}`;
}
