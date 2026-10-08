import { t } from '../i18n.ts';
import { knownZone, localZone, minutesOf, type SessionDef } from './sessions.ts';

/**
 * The Traded feature's settings (the column itself is switched on and off with `show.traded`):
 * - the column's bars: buys and sells side by side, or the difference (delta);
 * - whether the column marks the point of control and the value area, which share of the volume the value area holds, and the size of the
 *   price rows they are read from (a multiple of the map's grid step: the column's own rows follow the zoom, these must not);
 * - the lines on the chart: the point of control, the value area high and low, their labels, and what they are worked out over: what is on
 *   the chart, each day or week of a zone, or sessions; how many past ones are drawn, and whether a point of control nobody has traded
 *   through since (a naked one) runs on to the right.
 */
export interface TradedSettings {
  bars: 'split' | 'delta';
  valueArea: boolean;
  /** The value area's share of the volume, in percent. */
  share: number;
  /** Row size for the point of control and the value area, as a multiple of the map's grid step. */
  rows: number;
  poc: boolean; va: boolean; labels: boolean;
  period: 'view' | 'day' | 'week' | 'sessions';
  /** The zone days and weeks start in: `page` (the page's clock, UTC or this computer's), `local`, `UTC` or an IANA name. */
  zone: string;
  /** How many past days, weeks or sessions (of each session) are drawn, the open one among them. */
  count: number;
  naked: boolean;
  sessions: SessionDef[];
}

export const ROW_MULTIPLES = [0.25, 0.5, 1, 2, 5, 10] as const;
export const SHARES = [50, 60, 68, 70, 75, 80, 85, 90, 95] as const;
export const MAX_SESSIONS = 8, MAX_COUNT = 20;

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
  bars: 'split', valueArea: true, share: 70, rows: 1, poc: true, va: true, labels: true,
  period: 'view', zone: 'page', count: 5, naked: true,
  sessions: [preset(0, 's1'), preset(1, 's2'), preset(2, 's3')],
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

/** Settings from storage, field by field: whatever is missing or not valid falls back to the default. */
export function readTraded(saved: unknown): TradedSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>, d = TRADED_DEFAULTS;
  const count = typeof s.count === 'number' && Number.isFinite(s.count) ? Math.max(1, Math.min(MAX_COUNT, Math.round(s.count))) : d.count;
  const sessions = Array.isArray(s.sessions) ? s.sessions.slice(0, MAX_SESSIONS).flatMap((x, i) => { const r = readSession(x, i); return r ? [r] : []; }) : d.sessions.map(x => ({ ...x }));
  // Ids are what a window's key is made of: two sessions must not share one.
  const seen = new Set<string>();
  for (const x of sessions) { while (seen.has(x.id)) x.id = `${x.id}x`.slice(-24); seen.add(x.id); }
  return {
    bars: oneOf(['split', 'delta'] as const, s.bars, d.bars),
    valueArea: flag(s.valueArea, d.valueArea), share: oneOf(SHARES, s.share, d.share), rows: oneOf(ROW_MULTIPLES, s.rows, d.rows),
    poc: flag(s.poc, d.poc), va: flag(s.va, d.va), labels: flag(s.labels, d.labels),
    period: oneOf(['view', 'day', 'week', 'sessions'] as const, s.period, d.period),
    zone: zoneOk(s.zone) ? s.zone : d.zone, count, naked: flag(s.naked, d.naked), sessions,
  };
}

/** A new session's id: one no session in the list has. */
export function newSessionId(sessions: readonly SessionDef[]): string {
  for (let i = 1; ; i++) if (!sessions.some(s => s.id === `s${i}`)) return `s${i}`;
}
