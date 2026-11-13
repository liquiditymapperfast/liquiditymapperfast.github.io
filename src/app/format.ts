import { language, t } from './i18n.ts';
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const usd = (value: number): string => !Number.isFinite(value) ? '–' : value === 0 ? '0' : Math.abs(value) < 1000 ? value.toFixed(0) : compact.format(value);

/** One formatter per number of decimals: `toLocaleString` builds a new Intl object on every call, which is slow enough to show when a frame prints hundreds of prices. */
const fixed: Intl.NumberFormat[] = [];
export const fixedFormat = (decimals: number): Intl.NumberFormat => fixed[decimals] ??= new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** The decimals a step is written with (0.25 has two, 2.5 one, 25 none), up to twelve. */
export function stepDecimals(step: number): number {
  let k = 0;
  // Relative to the value: a step of 2.5e-9 is not "whole" at k = 0 however small its remainder is.
  while (k < 12 && Math.abs(step * 10 ** k - Math.round(step * 10 ** k)) > 1e-6 * Math.abs(step * 10 ** k)) k++;
  return k;
}

export function price(value: number, step = 0): string {
  if (!Number.isFinite(value)) return '–';
  // As many decimals as the step is written with, up to twelve: a coin priced in millionths of a dollar (PEPE) moves in billionths and
  // less, and a step of 0.25 needs two however coarse it is.
  const decimals = step > 0 ? Math.min(12, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9), stepDecimals(step)))
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
const monthFormats = new Map<string, Intl.DateTimeFormat>();
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
const yearFormats = new Map<string, Intl.DateTimeFormat>();
/**
 * A moment as an anchor gives it, on the page's clock: "Nov 4 14:23" this year, "Nov 4, 2024 14:23" in another (an anchor reaches ten years
 * back, and a date without its year would be read as this year's).
 */
export function clockYear(t: number, now = Date.now()): string {
  const d = onWall(t);
  if (d.getUTCFullYear() === onWall(now).getUTCFullYear()) return clock(t, true);
  const code = language(), time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  if (code === 'en') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${time}`;
  let format = yearFormats.get(code);
  if (!format) { format = new Intl.DateTimeFormat(code, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }); yearFormats.set(code, format); }
  return `${format.format(d)} ${time}`;
}
/** A moment as a date field and a time field show it, on the page's clock: "2026-11-04" and "14:23". */
export function wallFields(t: number): { date: string; time: string } {
  const iso = onWall(t).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}
/**
 * The moment a date field and a time field name on the page's clock ("2026-11-04" and "14:23"; an empty time is midnight), as the chart's time
 * axis reads (a user, 2026-11-10: "so i can enter a date instead of clicking"); 'date' for a date that does not exist (Feb 30 is refused, not
 * rolled on to March), 'time' for one that cannot be read or that a clock change skips (02:30 the night the clocks go forward: refused, not
 * moved to 03:30; Sol, review 2026-11-11).
 */
/**
 * The moment a date field names: `own` itself while the fields still say it (in the hour a clock change repeats, one wall time names two moments
 * and reading it again gave the first: an anchor at the second 01:30 moved an hour back when its editor was confirmed unchanged; Sol, review
 * 2026-11-11), else the fields read as `fromWallFields` does (a time typed new in that hour takes the first, as a clock's own reading does).
 */
export function typedMoment(own: number | null | undefined, date: string, time: string): number | 'date' | 'time' {
  if (own != null) { const w = wallFields(own); if (w.date === date && w.time === time) return own; }
  return fromWallFields(date, time);
}

export function fromWallFields(date: string, time: string): number | 'date' | 'time' {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date), h = time === '' ? ['', '00', '00'] : /^(\d{2}):(\d{2})$/.exec(time);
  if (!d) return 'date';
  if (!h) return 'time';
  const y = Number(d[1]), mo = Number(d[2]) - 1, day = Number(d[3]), hh = Number(h[1]), mi = Number(h[2]);
  if (hh > 23 || mi > 59) return 'time';
  const t = zone === 'utc' ? Date.UTC(y, mo, day, hh, mi) : new Date(y, mo, day, hh, mi).getTime();
  if (!Number.isFinite(t)) return 'date';
  const back = onWall(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo || back.getUTCDate() !== day) return 'date';
  return back.getUTCHours() === hh && back.getUTCMinutes() === mi ? t : 'time';
}
/** A fixed anchor's day alone ("Nov 9"; "Nov 9, 2024" in another year), for its tag on the price axis, which has room for little. */
export function anchorDay(t: number, now = Date.now()): string { const s = clockYear(t, now); return s.slice(0, s.lastIndexOf(' ')); }
/** A fixed anchor's date as its line is named on the chart ("Nov 9 06:00"; "Nov 9" at midnight; with its year in another year). */
export function anchorDate(t: number, now = Date.now()): string {
  const s = clockYear(t, now), d = onWall(t);
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? s.slice(0, s.lastIndexOf(' ')) : s;
}
/** The time with its seconds ("13:42:05") on the page's clock, for a window of minutes, where the minute alone says too little. */
export function clockSeconds(t: number): string {
  const d = onWall(t);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

/**
 * A time-axis tick's label: a tick on a midnight of the zone's clock is its date alone ("Oct 7", never "Oct 7 00:00": zoomed out to days, every
 * tick is one); elsewhere the time, with the date before it on a tick that marks a new day (`marksDay`). Calendar ticks show a month
 * (with its year when `marksDay`) or a year alone.
 */
export function tickLabel(t: number, marksDay: boolean, unit: 'time' | 'month' | 'year' = 'time'): string {
  if (unit === 'year') return String(onWall(t).getUTCFullYear());
  if (unit === 'month') {
    const code = language(), key = code + '|' + marksDay;
    let format = monthFormats.get(key);
    if (!format) { format = new Intl.DateTimeFormat(code, { month: 'short', ...(marksDay ? { year: 'numeric' } : {}), timeZone: 'UTC' }); monthFormats.set(key, format); }
    return format.format(onWall(t));
  }
  if ((t + zoneOffsetMs(t)) % DAY === 0) return monthDay(onWall(t));
  return clock(t, marksDay);
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? t('{n}s ago', { n: s }) : s < 5400 ? t('{n}m ago', { n: Math.round(s / 60) }) : s < 129600 ? t('{n}h ago', { n: Math.round(s / 3600) }) : t('{n}d ago', { n: Math.round(s / 86400) });
}
