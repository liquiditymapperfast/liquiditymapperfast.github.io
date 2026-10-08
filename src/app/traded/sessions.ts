/**
 * Time windows for volume profiles: days and weeks in a time zone, and sessions (a daily stretch of wall-clock time in a market's zone, such as
 * London 08:00 to 17:00). Times are wall-clock times in their zone, so a session follows that zone's daylight saving: a London session starts
 * at 07:00 UTC in summer and 08:00 UTC in winter. Crypto trades every day, so every day has its sessions unless one is set to weekdays.
 */

const MINUTE = 60_000, DAY = 86_400_000;

/** The zone the computer is set to, by its IANA name (UTC when the browser will not say). */
export function localZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formats.set(zone, f);
  }
  return f;
}

/** Whether the browser knows a zone by this name. */
export function knownZone(zone: string): boolean { try { format(zone); return true; } catch { return false; } }

/** The wall clock of `zone` at instant `t`, as milliseconds read as if UTC, and the day of the week there (0 Sunday). */
export function wallOf(zone: string, t: number): { wall: number; weekday: number } {
  const parts = format(zone).formatToParts(new Date(t)), get = (type: string): string => parts.find(p => p.type === type)?.value ?? '0';
  const wall = Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')), Number(get('hour')) % 24, Number(get('minute')), Number(get('second')));
  return { wall, weekday: new Date(wall).getUTCDay() };
}

/** How far `zone`'s clock is ahead of UTC at instant `t` (whole seconds). */
export const offsetMs = (zone: string, t: number): number => wallOf(zone, t).wall - Math.floor(t / 1000) * 1000;

/**
 * The instant at which `zone`'s clock reads `wall` (milliseconds read as if UTC). A time the clock skips (the hour lost when daylight saving
 * starts) lands as far after the jump as it was meant to be after the hour before it; a time the clock shows twice (the hour repeated when
 * it ends) is the first of the two.
 */
export function fromWall(zone: string, wall: number): number {
  const before = offsetMs(zone, wall - DAY), after = offsetMs(zone, wall + DAY);
  const a = wall - before, b = wall - after;
  const okA = offsetMs(zone, a) === before, okB = offsetMs(zone, b) === after;
  if (okA && okB) return Math.min(a, b);
  if (okB) return b;
  return a;
}

/** A session: a daily stretch of wall-clock time in a zone ("HH:MM" to "HH:MM"; an end at or before the start runs past midnight). */
export interface SessionDef { id: string; name: string; zone: string; start: string; end: string; on: boolean; weekdays: boolean }
/** One window of a profile: a day, a week or a session, its instants, and which definition it came from. */
export interface ProfileWindow { key: string; name: string; from: number; to: number }

/** Minutes after midnight of "HH:MM" (null for anything else). */
export function minutesOf(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h <= 24 && min < 60 && h * 60 + min <= 1_440 ? h * 60 + min : null;
}

/** Midnight (wall time, read as UTC) of every day of `zone` whose day could touch [t0, t1], oldest first. */
function days(zone: string, t0: number, t1: number): { midnight: number; weekday: number }[] {
  const first = Math.floor(wallOf(zone, t0 - DAY).wall / DAY) * DAY, last = Math.floor(wallOf(zone, t1).wall / DAY) * DAY;
  const out: { midnight: number; weekday: number }[] = [];
  for (let d = first; d <= last && out.length < 400; d += DAY) out.push({ midnight: d, weekday: new Date(d).getUTCDay() });
  return out;
}

/** The days of `zone` that touch [t0, t1]: midnight to midnight (23 or 25 hours on the days its clocks change). */
export function dayWindows(zone: string, t0: number, t1: number): ProfileWindow[] {
  const out: ProfileWindow[] = [];
  for (const { midnight } of days(zone, t0, t1)) {
    const from = fromWall(zone, midnight), to = fromWall(zone, midnight + DAY);
    if (to > t0 && from < t1) out.push({ key: `day|${zone}|${from}`, name: '', from, to });
  }
  return out;
}

/** The weeks of `zone` (Monday 00:00 to Monday 00:00) that touch [t0, t1]. */
export function weekWindows(zone: string, t0: number, t1: number): ProfileWindow[] {
  const out: ProfileWindow[] = [];
  for (const { midnight, weekday } of days(zone, t0 - 7 * DAY, t1)) {
    if (weekday !== 1) continue;
    const from = fromWall(zone, midnight), to = fromWall(zone, midnight + 7 * DAY);
    if (to > t0 && from < t1) out.push({ key: `week|${zone}|${from}`, name: '', from, to });
  }
  return out;
}

/** The windows of the sessions that are on and touch [t0, t1], oldest first; `resolve` turns a stored zone into an IANA name. */
export function sessionWindows(defs: readonly SessionDef[], t0: number, t1: number, resolve: (zone: string) => string = z => z): ProfileWindow[] {
  const out: ProfileWindow[] = [];
  for (const def of defs) {
    const start = minutesOf(def.start), end = minutesOf(def.end), zone = resolve(def.zone);
    if (!def.on || start === null || end === null || !knownZone(zone)) continue;
    for (const { midnight, weekday } of days(zone, t0, t1)) {
      if (def.weekdays && (weekday === 0 || weekday === 6)) continue;
      const from = fromWall(zone, midnight + start * MINUTE), to = fromWall(zone, midnight + (end > start ? end : end + 1_440) * MINUTE);
      if (to > t0 && from < t1) out.push({ key: `session|${def.id}|${from}`, name: def.name, from, to });
    }
  }
  return out.sort((a, b) => a.from - b.from || a.key.localeCompare(b.key));
}

/**
 * The most recent `count` windows of each kind (each session, or the days, or the weeks) that have begun by `now` (an open one among them),
 * oldest first.
 */
export function lastWindows(windows: readonly ProfileWindow[], count: number, now: number): ProfileWindow[] {
  const groups = new Map<string, ProfileWindow[]>();
  for (const w of windows) {
    if (w.from > now) continue;
    const group = w.key.slice(0, w.key.lastIndexOf('|')), list = groups.get(group);
    if (list) list.push(w); else groups.set(group, [w]);
  }
  return [...groups.values()].flatMap(list => list.sort((a, b) => a.from - b.from).slice(-Math.max(1, count))).sort((a, b) => a.from - b.from || a.key.localeCompare(b.key));
}
