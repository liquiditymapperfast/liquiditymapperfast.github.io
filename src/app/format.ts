import { language, t } from './i18n.ts';
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const usd = (value: number): string => !Number.isFinite(value) ? '–' : value === 0 ? '0' : Math.abs(value) < 1000 ? value.toFixed(0) : compact.format(value);

/** One formatter per number of decimals: `toLocaleString` builds a new Intl object on every call, which is slow enough to show when a frame prints hundreds of prices. */
const fixed: Intl.NumberFormat[] = [];
const fixedFormat = (decimals: number): Intl.NumberFormat => fixed[decimals] ??= new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

export function price(value: number, step = 0): string {
  if (!Number.isFinite(value)) return '–';
  // Up to ten decimals: a coin priced in millionths of a dollar (PEPE) moves in billionths.
  const decimals = step > 0 ? Math.min(10, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)))
    : value >= 1000 ? 1 : value >= 1 ? 2 : value > 0 ? Math.min(10, Math.max(5, Math.ceil(-Math.log10(value)) + 3)) : 5;
  return fixedFormat(decimals).format(value);
}
const two = (n: number) => String(n).padStart(2, '0');

/**
 * The clock the page's times are on: the computer's own, or UTC (the one the exchanges' candles and most other charts keep). One setting for
 * the whole page, read by everything that writes a time or places a tick on a time axis.
 */
export type TimeZone = 'local' | 'utc';
let zone: TimeZone = 'local';
export function setTimeZone(next: TimeZone): void { zone = next === 'utc' ? 'utc' : 'local'; }
export const timeZone = (): TimeZone => zone;
/** Milliseconds to add to a time to get the wall clock of the zone at that moment (nothing for UTC; an hour more or less across a clock change). */
export const zoneOffsetMs = (t: number, which: TimeZone = zone): number => which === 'utc' ? 0 : -new Date(t).getTimezoneOffset() * 60_000;
/** A time moved onto the zone's wall clock, so that its UTC fields (`getUTCHours` and the rest) read as the clock on the wall. */
const onWall = (t: number): Date => new Date(t + zoneOffsetMs(t));
/** The day of the month `t` falls on, on the zone's clock. */
export const dayOfMonth = (t: number): number => onWall(t).getUTCDate();
const DAY = 86_400_000;
/** The start of the day `t` falls in, on the zone's clock (to the hour on the days the clocks change). */
export const startOfDay = (t: number): number => t - (((t + zoneOffsetMs(t)) % DAY) + DAY) % DAY;

const names = new Map<string, string>();
/** The short name of a zone for a label: "UTC", or the computer's own ("GMT+2", "CEST", "EDT": whatever its language calls it). */
export function zoneName(which: TimeZone = zone, at = Date.now()): string {
  if (which === 'utc') return 'UTC';
  const key = `${language()}|${Math.floor(at / 3_600_000)}`;
  let name = names.get(key);
  if (name === undefined) {
    try { name = new Intl.DateTimeFormat(language(), { timeZoneName: 'short' }).formatToParts(new Date(at)).find(part => part.type === 'timeZoneName')?.value ?? ''; } catch { name = ''; }
    if (names.size > 50) names.clear();
    names.set(key, name);
  }
  return name || t('Local');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const dayFormats = new Map<string, Intl.DateTimeFormat>();
/** "Oct 5" in English, and the date as the language writes it ("5. Okt.", "10月5日") in the others; `wall` is a time moved onto the zone's clock. */
function monthDay(wall: Date): string {
  const code = language();
  if (code === 'en') return `${MONTHS[wall.getUTCMonth()]} ${wall.getUTCDate()}`;
  let format = dayFormats.get(code);
  if (!format) { format = new Intl.DateTimeFormat(code, { month: 'short', day: 'numeric', timeZone: 'UTC' }); dayFormats.set(code, format); }
  return format.format(wall);
}
export function clock(t: number, withDate = false): string {
  const d = onWall(t);
  const time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  return withDate ? `${monthDay(d)} ${time}` : time;
}

/**
 * A time-axis tick's label: a tick on a midnight of the zone's clock is its date alone ("Oct 7", never "Oct 7 00:00": zoomed out to days, every
 * tick is one); elsewhere the time, with the date before it on a tick that marks a new day (`marksDay`).
 */
export function tickLabel(t: number, marksDay: boolean): string {
  if ((t + zoneOffsetMs(t)) % DAY === 0) return monthDay(onWall(t));
  return clock(t, marksDay);
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? t('{n}s ago', { n: s }) : s < 5400 ? t('{n}m ago', { n: Math.round(s / 60) }) : s < 129600 ? t('{n}h ago', { n: Math.round(s / 3600) }) : t('{n}d ago', { n: Math.round(s / 86400) });
}
