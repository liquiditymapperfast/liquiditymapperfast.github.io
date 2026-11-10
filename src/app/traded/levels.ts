import type { ProfileAnswer } from '../../shared/footprint.ts';
import { levelsOf, rowOf, type ValueLevels } from '../../shared/profile.ts';
import type { CandleRow } from '../store.ts';
import { carryPairs, type Carry } from './carry.ts';
import { dayWindows, lastWindows, minutesOf, monthWindows, sessionWindows, weekWindows, type ProfileWindow } from './sessions.ts';
import { linesSource, recordedCount, resolveZone, type KindSettings, type LineKind, type TradedSettings } from './settings.ts';

/**
 * The step the traded column asks its rows on: one that both its display rows and the point of control's rows are whole multiples of (and
 * of the recorder's own step, `fine`), so the bars and the levels are each read exactly from the same answer.
 */
export function requestStep(display: number, poc: number, fine: number): number {
  const a = Math.max(1, Math.round(display / fine)), b = Math.max(1, Math.round(poc / fine));
  let x = a, y = b; while (y) [x, y] = [y, x % y];
  return x * fine;
}

/** The point of control and the value area of a traded-volume answer: every instrument's rows on rows of `step`, every price that traded. */
export function answerLevels(answer: ProfileAnswer, step: number, share: number): ValueLevels | null {
  const rows = new Map<number, number>();
  for (const inst of answer.instruments) for (const [low, buy, sell] of inst.rows) {
    // A recorded row lies inside one level row (its step divides the level's): its middle says which.
    const key = rowOf(low + inst.step / 2, step);
    rows.set(key, (rows.get(key) ?? 0) + buy + sell);
  }
  return levelsOf(rows, step, share);
}

/**
 * When a past point of control was first traded through after its window ended: the first candle from `after` whose range reaches it,
 * `tolerance` either side (half a row: the levels are read from every venue, the candles are one market's, a little apart). Null when no
 * candle held reaches it: the level is still naked as far as the candles go. In a replay (`closed`: the moment shown and the candles' size) only
 * candles over by then count: one still forming carries a high and low from after the moment.
 */
export function touchedAt(price: number, after: number, candles: readonly CandleRow[], tolerance: number, closed?: { by: number; barMs: number }): number | null {
  for (const c of candles) {
    if (c[0] < after) continue;
    if (closed && c[0] + closed.barMs > closed.by) break;
    if (c[3] - tolerance <= price && price <= c[2] + tolerance) return c[0];
  }
  return null;
}

/** Every window of one kind that touches [t0, t1], oldest first, however many: days and weeks start in the settings' zone (`page`: the page's clock). */
export function periodWindows(s: Pick<KindSettings, 'period' | 'zone' | 'sessions'>, pageZone: 'local' | 'utc', t0: number, t1: number): ProfileWindow[] {
  const zone = resolveZone(s.zone, pageZone);
  return s.period === 'day' ? dayWindows(zone, t0, t1) : s.period === 'week' ? weekWindows(zone, t0, t1) : s.period === 'month' ? monthWindows(zone, t0, t1)
    : sessionWindows(s.sessions, t0, t1, z => resolveZone(z, pageZone));
}

/**
 * The windows of one kind drawn on the chart (days, weeks, months or sessions): the last `count` of each that have begun, of those that touch
 * [t0, t1]. Days and weeks start in the settings' zone (`page`: the page's clock).
 */
export function linesWindows(s: KindSettings, pageZone: 'local' | 'utc', t0: number, t1: number, now: number, count = s.count): ProfileWindow[] {
  if (count < 1) return [];
  return lastWindows(periodWindows(s, pageZone, t0, Math.min(t1, now)), count, now);
}

/** How far back from now the calendar is laid out to find a window under way and the one before it: a month and a half is more than the longest. */
const CARRY_BACK: Readonly<Record<LineKind, number>> = { day: 3 * 86_400_000, week: 15 * 86_400_000, month: 65 * 86_400_000, sessions: 6 * 86_400_000 };

/**
 * The previous windows to carry across the ones under way at `now` (`carryPairs`) for one kind, from the whole calendar around now and before
 * any gate: how many are drawn (`count` does not matter: a single day drawn still carries yesterday's) or whether the source can still be
 * worked out (the caller gates the source with `recordedWindows` and the coverage rules, and a source that fails them is no carry: the one
 * before it is never put in its place).
 */
export function carriesOf(s: Pick<KindSettings, 'period' | 'zone' | 'sessions'>, pageZone: 'local' | 'utc', now: number): Carry[] {
  return carryPairs(periodWindows(s, pageZone, now - CARRY_BACK[s.period], now + 1), now);
}

/**
 * The carries to draw at `now` for the kinds whose lines are on (`s.lines`): each kind's pairs (`carriesOf`) kept only where the source can
 * still be worked out. From the recording that is a kind it can hold two windows of at all (`recordedCount`: a week never, it holds the one
 * under way; a page that keeps a day no previous day) and a source that began inside what it keeps (`recordedWindows`, on the real clock
 * `real`); from candles always (a month's too). A source that fails is dropped and nothing takes its place.
 */
export function gatedCarries(s: Pick<TradedSettings, 'lines' | 'source' | 'zone' | 'sessions'>, pageZone: 'local' | 'utc', now: number, real: number, keepsMs: number): Carry[] {
  const out: Carry[] = [];
  for (const period of s.lines) {
    const k = { ...s, period }, recorded = linesSource(k) === 'recorded';
    if (recorded && recordedCount(period, keepsMs) < 2) continue;
    for (const c of carriesOf(k, pageZone, now)) if (!recorded || recordedWindows([c.source], real, keepsMs).length) out.push(c);
  }
  return out;
}

/** What a value-area answer of the recording says of a window, as the lines draw it. */
export interface HeldValueArea { from: number; to: number; minutes: number; covered?: number; poc: number | null; vah: number | null; val: number | null; asOf: number }
/**
 * A window's levels from the recording's answer, and how far it reaches, or null when they are not drawn: no answer yet, no trade in the
 * window, an answer from before the window ended (one that may lack its last trades waits for the next), or under `DRAWN_SHARE` of it
 * recorded. An answer revised later (late trades) replaces this one; until it comes an answer that fails the first rules draws nothing.
 */
export function recordedWindowLevels(held: HeldValueArea | undefined, w: { to: number }, now: number): { levels: ValueLevels; upTo: number } | null {
  if (!held || held.poc === null || held.vah === null || held.val === null || (w.to <= now && held.asOf < w.to) || recordedShare(held, held.asOf) < DRAWN_SHARE) return null;
  return { levels: { poc: held.poc, vah: held.vah, val: held.val }, upTo: held.asOf };
}

/** A window's kind, from its key (`day|…`, `week|…`, `month|…`, `session|…`). */
export function windowKind(w: Pick<ProfileWindow, 'key'>): LineKind {
  const kind = w.key.slice(0, w.key.indexOf('|'));
  return kind === 'session' ? 'sessions' : kind === 'week' || kind === 'month' ? kind : 'day';
}

/** The windows the recording can still work out: those that began inside what it keeps (`retentionMs` back from the real clock `now`). */
export function recordedWindows<W extends { from: number }>(windows: readonly W[], now: number, retentionMs: number): W[] {
  return windows.filter(w => w.from >= now - retentionMs);
}

/** A day, week or session is drawn only when it was seen for at least this share of it (its minutes, weighted by each venue's volume). */
export const DRAWN_SHARE = 0.9;
/**
 * How much of a window up to `asOf` the recording holds, as a share: the source's own estimate where it gives one (each venue's minutes
 * weighted by its volume, `ValueAreaWindow.covered`), else the minutes of the best-recorded venue (an older source).
 */
export function recordedShare(w: { from: number; to: number; minutes: number; covered?: number }, asOf: number): number {
  if (w.covered !== undefined) return w.covered;
  const span = (Math.min(w.to, asOf) - w.from) / 60_000;
  return span > 0 ? w.minutes / span : 0;
}

/**
 * The candle size days, weeks and sessions are worked out on, from the settings alone (so the page and its panel always agree): five
 * minutes, on which every day and week starts (no zone is off the hour by other than quarters), unless a session switched on starts or
 * ends off the five (09:17), then a minute.
 */
export function candleBarMs(s: Pick<KindSettings, 'period' | 'sessions'>): number {
  const off = (time: string): boolean => (minutesOf(time) ?? 0) % 5 !== 0;
  return s.period === 'sessions' && s.sessions.some(x => x.on && (off(x.start) || off(x.end))) ? 60_000 : 5 * 60_000;
}

/**
 * The point of control and the value area of [from, to) from candles of `barMs` (start, open, high, low, close, volume in coins), each bar's
 * volume in USD (its coins at the bar's typical price) spread evenly over its low to high, on rows of `step`: an estimate, since a candle
 * does not say where inside its range it traded. Only bars that lie wholly inside the window count; `heldTo` is how far the candles are
 * known, so a window under way is worked out up to there. Null levels when nothing traded. `covered` is the share of the window's bars, up
 * to `heldTo`, that are there (a venue that sends no bar for a minute nobody traded has one missing). `rows` is the estimate itself: USD by
 * row (the row's index on `step`), what a past window's profile on the chart draws; `buys` the part of it bought at market, each bar's taker
 * buys spread as its volume is, or null where a bar with volume did not say (a venue that does not report them).
 */
export interface CandleProfile { levels: ValueLevels | null; covered: number; rows: Map<number, number>; buys: Map<number, number> | null }
/**
 * The most rows one bar may be spread over, and one window may hold: a step far finer than the prices (before the first price is known the grid
 * step is a billionth) would make millions of rows a bar. A bar a coin that fell 99 % has in its history is 20 times today's price high at most.
 */
export const MAX_BAR_ROWS = 100_000, MAX_WINDOW_ROWS = 4_000_000;
/**
 * The widest span of rows a window is added up on in flat arrays (about 37 bytes a row, so 37 MB at most); a wider one (a step far finer than
 * its prices) keeps the row by row map. `levelsOf` finds no levels over a wider span either.
 */
const DENSE_ROWS = 1_000_001;
const takerOf = (b: CandleRow): number | undefined => (b as readonly (number | undefined)[])[7];

/**
 * `candleLevelsByRow`'s answer, worked out in flat arrays (2026-11-10, for anchored profiles, whose window can be 21 weeks at the finest rows):
 * a bar spread evenly over its rows gives every row between its first and its last the same part, so each bar adds its two end rows and marks
 * where its middle begins and ends, and one pass over the rows adds the middles up. BTC's perpetual and spot 5-minute bars over 21 weeks
 * (2026-11-10): 86 ms instead of 1,373 at $0.50 rows, 175 instead of 3,141 at $0.25, 14 instead of 33 at $20; the same rows as the row by row
 * loop (tests/volume-profile.test.mts holds them to a part in 10^9). A span wider than `DENSE_ROWS` rows is left to the row by row loop.
 */
export function candleLevels(bars: readonly CandleRow[], from: number, to: number, barMs: number, step: number, share: number, heldTo: number): CandleProfile {
  const end = Math.min(to, Math.floor(heldTo / barMs) * barMs);
  // First the bars that count, whether every one says what was bought, and the rows they span (a bar over MAX_BAR_ROWS refuses the window).
  let n = 0, split = true, any = false, lo = Infinity, hi = -Infinity;
  for (const b of bars) {
    const [t, , high, low, , volume] = b;
    if (t < from || t + barMs > end) continue;
    n++;
    if (!(volume > 0) || !(high >= low) || !(low > 0)) continue;
    any = true;
    const taker = takerOf(b);
    if (taker === undefined || !Number.isFinite(taker)) split = false;
    const a = rowOf(low, step), z = rowOf(high, step);
    if (!(z - a <= MAX_BAR_ROWS)) return { levels: null, covered: 0, rows: new Map(), buys: null };
    if (a < lo) lo = a;
    if (z > hi) hi = z;
  }
  if (any && !(hi - lo + 1 <= DENSE_ROWS)) return candleLevelsByRow(bars, from, to, barMs, step, share, heldTo);
  const rows = new Map<number, number>(), buys = new Map<number, number>();
  if (any) {
    const span = hi - lo + 1, edge = new Float64Array(span), middle = new Float64Array(span + 1), inside = new Int32Array(span + 1), touched = new Uint8Array(span);
    const edgeBought = split ? new Float64Array(span) : null, middleBought = split ? new Float64Array(span + 1) : null;
    for (const b of bars) {
      const [t, , high, low, close, volume] = b;
      if (t < from || t + barMs > end || !(volume > 0) || !(high >= low) || !(low > 0)) continue;
      const usd = volume * (high + low + close) / 3, bought = split ? usd * Math.min(1, Math.max(0, takerOf(b)! / volume)) : 0;
      const a = rowOf(low, step), z = rowOf(high, step), i = a - lo, j = z - lo;
      if (a === z) { edge[i] += usd; touched[i] = 1; if (edgeBought) edgeBought[i] += bought; continue; }
      // The end rows' parts as the row by row loop has them; each row between holds a step's share of the range.
      const range = high - low, first = (Math.min(high, (a + 1) * step) - Math.max(low, a * step)) / range, last = (Math.min(high, (z + 1) * step) - Math.max(low, z * step)) / range;
      if (first > 0) { edge[i] += usd * first; touched[i] = 1; if (edgeBought) edgeBought[i] += bought * first; }
      if (last > 0) { edge[j] += usd * last; touched[j] = 1; if (edgeBought) edgeBought[j] += bought * last; }
      if (j - i > 1) {
        const part = step / range;
        middle[i + 1] += usd * part; middle[j] -= usd * part; inside[i + 1]++; inside[j]--;
        if (middleBought) { middleBought[i + 1] += bought * part; middleBought[j] -= bought * part; }
      }
    }
    // A row is the estimate's where a bar's middle covers it or a bar's end row had a part there, as in the row by row loop.
    let run = 0, runBought = 0, covers = 0;
    for (let k = 0; k < span; k++) {
      run += middle[k]!; covers += inside[k]!; if (middleBought) runBought += middleBought[k]!;
      if (covers <= 0 && !touched[k]) continue;
      rows.set(k + lo, (covers > 0 ? run : 0) + edge[k]!);
      if (edgeBought) buys.set(k + lo, (covers > 0 ? runBought : 0) + edgeBought[k]!);
    }
  }
  const expected = Math.max(0, Math.floor((end - from) / barMs));
  return { levels: levelsOf(rows, step, share), covered: expected > 0 ? Math.min(1, n / expected) : 0, rows, buys: split && any ? buys : null };
}

/** The estimate row by row (each bar's every row in a map): `candleLevels` past its span of flat arrays, and its reference in the tests. */
export function candleLevelsByRow(bars: readonly CandleRow[], from: number, to: number, barMs: number, step: number, share: number, heldTo: number): CandleProfile {
  const rows = new Map<number, number>(), buys = new Map<number, number>(), end = Math.min(to, Math.floor(heldTo / barMs) * barMs);
  let n = 0, split = true, any = false;
  for (const b of bars) {
    const [t, , high, low, close, volume] = b;
    if (t < from || t + barMs > end) continue;
    n++;
    if (!(volume > 0) || !(high >= low) || !(low > 0)) continue;
    const usd = volume * (high + low + close) / 3, taker = (b as readonly (number | undefined)[])[7];
    any = true;
    if (taker === undefined || !Number.isFinite(taker)) split = false;
    const bought = split ? usd * Math.min(1, Math.max(0, taker! / volume)) : 0;
    const a = rowOf(low, step), z = rowOf(high, step);
    if (!(z - a <= MAX_BAR_ROWS) || rows.size > MAX_WINDOW_ROWS) return { levels: null, covered: 0, rows: new Map(), buys: null };
    if (a === z) { rows.set(a, (rows.get(a) ?? 0) + usd); if (split) buys.set(a, (buys.get(a) ?? 0) + bought); continue; }
    for (let k = a; k <= z; k++) {
      const part = (Math.min(high, (k + 1) * step) - Math.max(low, k * step)) / (high - low);
      if (part > 0) { rows.set(k, (rows.get(k) ?? 0) + usd * part); if (split) buys.set(k, (buys.get(k) ?? 0) + bought * part); }
    }
  }
  const expected = Math.max(0, Math.floor((end - from) / barMs));
  return { levels: levelsOf(rows, step, share), covered: expected > 0 ? Math.min(1, n / expected) : 0, rows, buys: split && any ? buys : null };
}

/**
 * Two markets' candle profiles of one window as one (the perpetual's and the spot market's): their rows and buys added up, the levels read
 * from the sum, as covered as the less covered; buys only where both have them.
 */
export function mergeCandleProfiles(a: CandleProfile, b: CandleProfile, step: number, share: number): CandleProfile {
  const rows = new Map(a.rows), buys = a.buys && b.buys ? new Map(a.buys) : null;
  for (const [k, v] of b.rows) rows.set(k, (rows.get(k) ?? 0) + v);
  if (buys) for (const [k, v] of b.buys!) buys.set(k, (buys.get(k) ?? 0) + v);
  return { levels: levelsOf(rows, step, share), covered: Math.min(a.covered, b.covered), rows, buys };
}

/**
 * Whether a column should show the candles' estimate of its window in place of the recording: when the recording holds less than
 * `DRAWN_SHARE` of the window (`since` is where it begins, the later of the start it was asked from and every venue's first minute: null
 * when it holds all of it). One source for the whole column, never the two added: the recording counts every venue, a candle one market, so
 * a sum would be a mixture of two scales, and its point of control and value area a reading of neither (AGENTS.md: no setting may claim to
 * work out what can no longer be worked out). Karl, 2026-10-24: zoomed out to months, the column showed only the last days.
 */
export function loadedColumnWanted(since: number | null, from: number, to: number): boolean {
  if (since === null || !(to > from)) return false;
  return (to - Math.max(from, Math.min(since, to))) / (to - from) < DRAWN_SHARE;
}

/**
 * Where the recording behind the traded-volume column begins inside `window` (null: it holds all of it, or nothing is known yet): the later of
 * the start it can be asked from (`asked`, `askedSpan`) and the first minute of each venue it counts (`earliest` is the first minute recorded
 * at all, so the answer of another window says the same), or, while no answer is held, where the hub knows the recording began. An answer
 * whose venues never recorded anything leaves `since` at the window's end: the recording holds none of it (a page that has only just started,
 * a scope the server does not record), so the candles' estimate is wanted wherever they hold the window. Only the instruments of `ids` (those
 * the column counts now) are read from the held answer. It does not depend on the window
 * the held answer was asked for: a zoom out that has not been answered yet does not flash the estimate on for a window the recording holds.
 */
export function recordingStart(window: { from: number; to: number }, asked: number, held: readonly { id: string; earliest: number | null }[] | null, hubSince: number, ids?: readonly string[]): number | null {
  // An answer for other instruments (a scope or a chip changed, and the answer for the new ones has not come) says nothing about these: none of
  // its instruments counted, it is as if none were held.
  const mine = held && ids ? held.filter(inst => ids.includes(inst.id)) : held;
  let since = asked;
  if (mine && mine.length) {
    let any = false;
    for (const inst of mine) if (inst.earliest !== null) { any = true; if (inst.earliest > since) since = inst.earliest; }
    if (!any) since = window.to;
  } else if (hubSince > since) since = hubSince;
  return since > window.from + 60_000 ? since : null;
}

/**
 * A candle estimate (`candleLevels`) as the answer a column reads, so its bars, levels, header and boxes are drawn by the same code as the
 * recording's: one instrument whose rows are on `step`, each `[low price, bought, sold]`. Where the candles do not say what was bought
 * (`buys` null) a row's whole volume is in `bought` and `split` is false: the column draws it unsplit, in grey. The instrument says it
 * was there for the whole window (`earliest` = `from`), so nothing reads it as a recording that began late.
 */
export function candleAnswer(rows: ReadonlyMap<number, number>, buys: ReadonlyMap<number, number> | null, step: number, from: number, to: number): { answer: ProfileAnswer; split: boolean } {
  const out: [number, number, number][] = [];
  for (const [row, usd] of [...rows].sort((a, b) => a[0] - b[0])) {
    if (!(usd > 0)) continue;
    const bought = buys ? Math.min(usd, Math.max(0, buys.get(row) ?? 0)) : usd;
    out.push([row * step, bought, usd - bought]);
  }
  const minutes = Math.max(0, Math.round((to - from) / 60_000));
  return { answer: { from, to, instruments: [{ id: 'candles', step, rows: out, minutes, first: from, earliest: from }] }, split: buys !== null };
}

/** The zone a window's dates are read in: a session's own (its start is a date there), else the zone days and weeks start in. */
export function windowZone(w: ProfileWindow, s: TradedSettings, pageZone: 'local' | 'utc'): string {
  if (w.key.startsWith('session|')) {
    const def = s.sessions.find(x => x.id === w.key.split('|')[1]);
    if (def) return resolveZone(def.zone, pageZone);
  }
  return resolveZone(s.zone, pageZone);
}

/**
 * What the column's header calls its window: a session by its name and date, a week by "Week" and the date of its first day, a month by its
 * month and year, a day by its date. `date` writes a time as a date in the window's zone, `month` as a month and year (absent: `date`);
 * `week` is the word for a week.
 */
export function windowLabel(w: ProfileWindow, date: (t: number) => string, week: string, month: (t: number) => string = date): string {
  const kind = w.key.slice(0, w.key.indexOf('|'));
  if (kind === 'session') return w.name ? `${w.name} ${date(w.from)}` : date(w.from);
  if (kind === 'month') return month(w.from);
  return kind === 'week' ? `${week} ${date(w.from)}` : date(w.from);
}
