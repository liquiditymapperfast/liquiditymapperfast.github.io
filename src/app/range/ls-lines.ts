import { HOLD_PERIODS, populationText, stepEnd } from '../panes/ls-window.ts';
import { venueLabel } from '../venues.ts';
import { clock } from '../format.ts';
import { t, tn } from '../i18n.ts';
import { durationText, spanText } from './oi-lines.ts';
import type { RangeSelection } from './selection.ts';
import type { GridItem, RangeLine } from './stats.ts';
import type { LsPopulation, LsSeries, LsStatus } from '../../shared/long-short.ts';

/**
 * What the Long/Short pane drew last, handed to its Range summary (provider.ts): each venue's series as drawn (the markets shown, cut at a
 * replay's moment), the window asked for and answered, and what it was drawn for. The same object while none of that changes.
 */
export interface LsPaneHeld {
  /** What it was drawn for (`lsHeldKey`): the coin, timeframe, series chosen and markets; another is not summed up as this one. */
  key: string;
  tf: string; tfMs: number;
  /** The markets shown: a venue that has not answered yet has no series. */
  ids: readonly string[];
  series: readonly LsSeries[];
  /** The window the venues were asked for and have answered, [from, to); null before a round answered. */
  asked: { from: number; to: number } | null;
  /** A round under way. */
  loading: boolean;
  /** In a replay, its moment (the readings published by then are drawn), else null. */
  replayAt: number | null;
}

/** The context a Long/Short snapshot stands for: the chart market, timeframe, series chosen and markets shown. */
export const lsHeldKey = (state: { marketId: string; timeframe: string; lsMetric: string }, ids: readonly string[]): string => `${state.marketId}|${state.timeframe}|${state.lsMetric}|${ids.join(',')}`;

/** One drawn step of a series: its reading, from its time to where the line drawn for it ends. */
interface Step { t0: number; t1: number; long: number }

/** A series' steps as the pane draws them (`stepEnd`: until the next reading within the hold, else one period). */
function stepsOf(s: Pick<LsSeries, 'points' | 'periodMs'>): Step[] {
  return s.points.map((q, i) => ({ t0: q.t, t1: stepEnd(s, i), long: q.long }));
}

/** One venue over the selection. Durations in ms; shares 0..1; null where no step covers the selection. */
export interface LsVenueStretch {
  id: string; population: LsPopulation | null; periodMs: number; status: LsStatus; pending: boolean;
  /** Whether it holds any reading at all (for any time), and the time of its oldest. */
  holds: boolean; oldest: number | null;
  /** The time its drawn steps cover, of the selection's; the readings they come from. */
  covered: number; span: number; readings: number;
  first: { t: number; long: number } | null; last: { t: number; long: number } | null;
  low: number | null; high: number | null;
  /** The drawn share weighted by the time each step covers. */
  mean: number | null;
  /** Covered time with the share above, below and at 50 %, and the longest unbroken covered stretch above and below (a gap breaks it). */
  above: number; below: number; even: number; longestAbove: number; longestBelow: number;
  /** Whether a reading still to come could lengthen its last step into the selection (its next reading not yet due). */
  settled: boolean;
}

/** Venues of one population covered together at two moments: their shares then and the spread between the highest and the lowest. */
/** `one[i]`: the venue's two moments fall in one reading, so it has no change to give there. */
export interface LsSpread { population: LsPopulation; ids: string[]; t0: number; t1: number; start: number; end: number; changes: number[]; one: boolean[] }

export interface LsStretch {
  /** The selection as summed up: its start and its end (cut at the clock live, at the moment in a replay). */
  t0: number; t1: number;
  venues: LsVenueStretch[];
  spreads: LsSpread[];
  /** Every venue settled, none being read, and the window asked covers the selection. */
  settled: boolean;
}

/** The share at `time` on the drawn line (a step covering it), or null in a gap. */
function shareAt(steps: readonly Step[], time: number): number | null {
  for (const s of steps) if (s.t0 <= time && time < s.t1) return s.long;
  return null;
}

/** The time a series' steps cover inside [A, B), as disjoint intervals in order (steps that meet are joined). */
function coveredIn(steps: readonly Step[], A: number, B: number): [number, number][] {
  const out: [number, number][] = [];
  for (const step of steps) {
    const from = Math.max(A, step.t0), to = Math.min(B, step.t1);
    if (!(to > from)) continue;
    const last = out[out.length - 1];
    if (last && last[1] >= from) last[1] = Math.max(last[1], to); else out.push([from, to]);
  }
  return out;
}
/** Where two sets of disjoint ordered intervals overlap. */
function intersect(a: [number, number][], b: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    const from = Math.max(a[i]![0], b[j]![0]), to = Math.min(a[i]![1], b[j]![1]);
    if (to > from) out.push([from, to]);
    if (a[i]![1] < b[j]![1]) i++; else j++;
  }
  return out;
}

/** Each venue over [A, B) as the pane draws it, and the spreads of the venues of one population covered together. */
export function lsStretch(held: LsPaneHeld, sel: Pick<RangeSelection, 't0' | 't1'>, now: number): LsStretch {
  const A = sel.t0, B = Math.min(sel.t1, held.replayAt ?? now), span = Math.max(0, B - A);
  const stepsBy = new Map<string, Step[]>();
  const venues = held.series.map((s): LsVenueStretch => {
    const steps = stepsOf(s); stepsBy.set(s.id, steps);
    let covered = 0, readings = 0, weighted = 0, above = 0, below = 0, even = 0, longestAbove = 0, longestBelow = 0, runSide = 0, run = 0, runEnd = -Infinity;
    let low: number | null = null, high: number | null = null, first: LsVenueStretch['first'] = null, last: LsVenueStretch['last'] = null;
    steps.forEach(step => {
      const from = Math.max(A, step.t0), to = Math.min(B, step.t1), dt = to - from;
      if (!(dt > 0)) return;
      covered += dt; readings++; weighted += dt * step.long;
      low = low === null ? step.long : Math.min(low, step.long); high = high === null ? step.long : Math.max(high, step.long);
      first ??= { t: step.t0, long: step.long }; last = { t: step.t0, long: step.long };
      const side = step.long > 0.5 ? 1 : step.long < 0.5 ? -1 : 0;
      if (side > 0) above += dt; else if (side < 0) below += dt; else even += dt;
      // A run goes on across steps that meet (no gap) on the same side of 50 %.
      run = side !== 0 && side === runSide && runEnd === from ? run + dt : side !== 0 ? dt : 0;
      runSide = side; runEnd = to;
      if (side > 0) longestAbove = Math.max(longestAbove, run); else if (side < 0) longestBelow = Math.max(longestBelow, run);
    });
    // Settled once nothing still to come can change what covers the selection: every reading inside it is out (a period after it), and the
    // newest reading before its end, where its step stops short of the end, is past the time its next reading would have been due (that one
    // would lengthen the step into the selection), whether or not any step covers the selection yet.
    const clock = held.replayAt ?? now, before = steps.filter(step => step.t0 < B), tail = before[before.length - 1];
    const open = !!tail && tail === steps[steps.length - 1] && tail.t1 < B && clock < tail.t0 + (HOLD_PERIODS + 1) * s.periodMs;
    const settled = s.status === 'serverOnly' || (clock >= B + s.periodMs && !open);
    return { id: s.id, population: s.population, periodMs: s.periodMs, status: s.status, pending: !!s.pending, holds: s.points.length > 0, oldest: s.points[0]?.t ?? null, covered, span, readings, first, last, low, high,
      mean: covered > 0 ? weighted / covered : null, above, below, even, longestAbove, longestBelow, settled };
  });
  // Shared moments: the venues of one population with fresh readings (not stale, not being read), at the first and the last instant all of
  // them are drawn (the intersection of their covered time, which can have gaps).
  const spreads: LsSpread[] = [];
  const populations = [...new Set(venues.map(v => v.population))].filter((p): p is LsPopulation => p !== null);
  for (const population of populations) {
    const set = venues.filter(v => v.population === population && v.status === 'ok' && !v.pending && v.covered > 0);
    if (set.length < 2) continue;
    const together = set.map(v => coveredIn(stepsBy.get(v.id)!, A, B)).reduce(intersect);
    if (!together.length) continue;
    const t0 = together[0]![0], t1 = together[together.length - 1]![1] - 1;
    const at = (time: number): (number | null)[] => set.map(v => shareAt(stepsBy.get(v.id)!, time));
    const a = at(t0), b = at(t1);
    if (!(t1 > t0) || a.some(x => x === null) || b.some(x => x === null)) continue;
    const spread = (xs: (number | null)[]): number => Math.max(...(xs as number[])) - Math.min(...(xs as number[]));
    const stepAt = (id: string, time: number): Step | undefined => stepsBy.get(id)!.find(s => s.t0 <= time && time < s.t1);
    spreads.push({ population, ids: set.map(v => v.id), t0, t1, start: spread(a), end: spread(b), changes: set.map((_, i) => b[i]! - a[i]!), one: set.map(v => stepAt(v.id, t0) === stepAt(v.id, t1)) });
  }
  const asked = held.asked, settled = !held.loading && venues.every(v => v.settled && !v.pending) && asked !== null && asked.from <= A && asked.to >= B && B === sel.t1;
  return { t0: A, t1: B, venues, spreads, settled };
}

const pct = (x: number, d = 1): string => `${(x * 100).toFixed(d)}%`;
/** Percentage points, with `d` decimals (a sign only where the written figure is not zero). */
const pp = (x: number, d = 1, signed = true): string => {
  const v = x * 100, n = Math.abs(v).toFixed(d), zero = Number(n) === 0;
  return t('{n} pp', { n: `${signed && !zero ? (v > 0 ? '+' : '−') : ''}${n}` });
};
/** A change in percentage points with the decimals (two to three) that show it as something where it is; under 0.001 pp, in words. */
const ppChange = (x: number): string => {
  if (Math.abs(x) < 1e-12) x = 0; // the time mean of equal readings differs from them by rounding alone
  let d = 2;
  while (d < 3 && x !== 0 && Number(Math.abs(x * 100).toFixed(d)) === 0) d++;
  return x !== 0 && Number(Math.abs(x * 100).toFixed(d)) === 0 ? (x > 0 ? t('increase under 0.001 pp') : t('decrease under 0.001 pp')) : pp(x, d);
};
/** The decimals (one to three) that keep every gap that is not none from reading zero. */
const gapDigits = (...xs: number[]): number => { let d = 1; while (d < 3 && xs.some(x => Math.abs(x) >= 1e-12 && Number((x * 100).toFixed(d)) === 0)) d++; return d; };
/** A gap in percentage points with `d` decimals; under 0.001 pp in words. */
const gapText = (x: number, d: number): string => Math.abs(x) >= 1e-12 && Number((x * 100).toFixed(d)) === 0 ? t('under 0.001 pp') : pp(x, d, false);
/** A width in percentage points, with the digits that show it as something where it is (under 0.001 pp in words, 0 only when none). */
const ppSize = (x: number): string => {
  if (Math.abs(x) < 1e-12) return pp(0, 2, false);
  let d = 2;
  while (d < 3 && Number((x * 100).toFixed(d)) === 0) d++;
  return Number((x * 100).toFixed(d)) === 0 ? t('under 0.001 pp') : pp(x, d, false);
};
/**
 * A move from `a` to `b` as shares and percentage points, with the decimals (one to three) that show both ends apart and the change as
 * something where it is; a change too small for three, in words.
 */
function moveText(a: number, b: number): { shares: string; change: string } {
  let d = 1;
  const hidden = (k: number): boolean => a !== b && (pct(a, k) === pct(b, k) || Number(((b - a) * 100).toFixed(k)) === 0);
  while (d < 3 && hidden(d)) d++;
  const change = hidden(d) ? (b > a ? t('increase under 0.001 pp') : t('decrease under 0.001 pp')) : pp(b - a, d);
  return { shares: `${pct(a, d)} → ${pct(b, d)}`, change };
}
/** A reading period as the venues name it ("5m", "1h", "1d"). */
const periodText = (ms: number): string => ms >= 86_400_000 && ms % 86_400_000 === 0 ? `${ms / 86_400_000}d` : ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`;
const share = (part: number, of: number): string => of > 0 ? `${Math.round(part / of * 100)}%` : '–';
/** The populations in the order the pane's popup gives them. */
const POPULATIONS: readonly (LsPopulation | null)[] = ['accounts', 'topAccounts', 'topPositions', 'activeAccounts', null];

/** Why a venue has no figure: its status, or no reading held for the selection. */
function noFigure(v: LsVenueStretch): string {
  if (v.status === 'serverOnly') return t('not readable by a web page');
  if (v.pending && !v.covered) return t('being read');
  if (v.status === 'failed') return t('could not be read');
  if (v.status === 'unsupported') return t('not published for this market');
  return t('no reading held for this time');
}

/**
 * The Long/Short pane's Range summary (provider.ts): each venue over the selection as the pane draws it (a reading counts for the time its step
 * covers), grouped by who it counts; never one share for all venues (their populations and denominators differ). The pane holds the readings
 * around the view, so a settled result of a closed selection is kept when the view moves away, and is not replaced by one in coarser readings
 * or covering less.
 */
export class LsRangeSummary {
  #kept: { current: string; t0: number; t1: number; replayAt: number | null; at: number; s: LsStretch; tf: string } | null = null;
  #last: { held: LsPaneHeld | null; sel: RangeSelection; shown: boolean; current: string; minute: number; zone: string; noMarkets: boolean; lines: RangeLine[] } | null = null;

  /** `noMarkets`: none of the open interest markets is on an exchange that publishes a ratio (the pane then holds nothing). */
  lines(sel: RangeSelection, held: LsPaneHeld | null, shown: boolean, current: string, now: number, zone = '', noMarkets = false): RangeLine[] {
    const last = this.#last, minute = Math.floor(now / 60_000);
    if (last && last.held === held && last.sel === sel && last.shown === shown && last.current === current && last.minute === minute && last.zone === zone && last.noMarkets === noMarkets) return last.lines;
    const lines = this.#lines(sel, held, shown, current, now, noMarkets);
    this.#last = { held, sel, shown, current, minute, zone, noMarkets, lines };
    return lines;
  }

  #lines(sel: RangeSelection, held: LsPaneHeld | null, shown: boolean, current: string, now: number, noMarkets: boolean): RangeLine[] {
    const title = (text: string): RangeLine => ({ key: 'ls-title', kind: 'title', cells: [text] });
    const note = (key: string, text: string): RangeLine => ({ key, kind: 'note', tone: 'muted', cells: [text] });
    if (noMarkets) return [title(spanText(sel.t0, sel.t1)), note('ls-none', t('None of the open-interest markets is on an exchange that publishes a long/short ratio (Binance, Bybit, OKX, Bitget, Gate).'))];
    if (held && held.key !== current) return [title(spanText(sel.t0, sel.t1)), note('ls-stale', t('The Long/Short pane last drew another market, timeframe or series: show it to sum up this selection.'))];
    const now0 = held ? lsStretch(held, sel, now) : null;
    // Kept: a settled result of this selection and context, shown while what is held now says less of it (the view moved away, coarser
    // readings for a wider view, a venue being read again). Only in the same mode and at the same replay moment: a result worked out live, or
    // later in a replay, holds readings a rewound replay has not reached.
    const replayAt = held?.replayAt ?? null, k = this.#kept;
    const same = k !== null && k.current === current && k.t0 === sel.t0 && k.t1 === sel.t1 && k.at <= now
      && (held === null || (replayAt === null ? k.replayAt === null : k.replayAt !== null && k.replayAt <= replayAt));
    const poorer = (s: LsStretch, than: LsStretch): boolean => than.venues.some(kv => { const v = s.venues.find(x => x.id === kv.id); return !v || v.covered < kv.covered || (v.periodMs > kv.periodMs && kv.covered > 0); });
    if (held && now0?.settled && !(same && poorer(now0, k.s))) this.#kept = { current, t0: sel.t0, t1: sel.t1, replayAt, at: now, s: now0, tf: held.tf };
    // Shown while what is held says less of the selection (not merely while it is unsettled: a fuller result still settling is the better one).
    const kept = same && (!now0 || poorer(now0, k.s)) ? k : null;
    if (!held && !kept) return [title(spanText(sel.t0, sel.t1)), note('ls-none', shown ? t('Reading the long/short ratios…') : t('The Long/Short pane has not drawn this market yet: show it to sum up this selection.'))];
    const s = kept?.s ?? now0!;
    if (!(s.t1 > s.t0)) return [title(spanText(sel.t0, sel.t1)), note('ls-none', t('This selection has not begun yet.'))];
    const live = !kept && replayAt === null && sel.t1 > now;
    const lines: RangeLine[] = [title(`${spanText(s.t0, s.t1)} · ${durationText(s.t1 - s.t0)}${live ? ` · ${t('forming')}` : ''}`)];
    // What it reads: each venue's share, and the period of the readings (they coarsen for a wider view).
    const reads = s.venues.filter(v => v.holds && v.periodMs > 0), periods = [...new Set(reads.map(v => v.periodMs))];
    const status: string[] = [t('Long share by venue')];
    if (periods.length === 1) status.push(t('readings of {period}', { period: periodText(periods[0]!) }));
    else if (periods.length > 1) status.push(reads.map(v => `${venueLabel(v.id)} ${periodText(v.periodMs)}`).join(', '));
    if (replayAt !== null && !kept) status.push(t('replay: readings published by {time}', { time: clock(replayAt, true) }));
    lines.push(note('ls-status', status.join(' · ')));
    if (!shown) lines.push(note('ls-hidden', t('The Long/Short pane is hidden: these are the readings it last held.')));
    if (sel.p0 !== null && sel.p1 !== null) lines.push(note('ls-prices', t('Long/short ratios are for all prices.')));
    if (kept) lines.push(note('ls-kept', t('As worked out while the pane held these readings.')));
    const reading = !!held && (held.series.some(v => v.pending)
      || (held.loading && (held.series.length < held.ids.length || held.series.some(v => !v.points.length && v.status !== 'serverOnly' && v.status !== 'unsupported'))));
    if (reading) lines.push(note('ls-reading', t('Some venues are still being read.')));
    // By population: a share of accounts and a share of position size are not the same quantity, and are never put together.
    const maxChange = Math.max(1e-9, ...s.venues.map(v => v.first && v.last && v.readings > 1 ? Math.abs(v.last.long - v.first.long) : 0));
    for (const population of POPULATIONS) {
      const group = s.venues.filter(v => v.population === population);
      if (!group.length) continue;
      lines.push({ key: `h-ls-${population ?? 'none'}`, kind: 'heading', cells: [population ? populationText(population) : t('venues not read')] });
      lines.push(note(`ls-rows-${population ?? 'none'}`, t('First → last held long share over each venue\'s own readings, and the change in percentage points.')));
      for (const v of group) {
        const name = venueLabel(v.id), staleNote = v.status === 'stale' ? t('earlier readings: the last update could not be read') : '';
        if (!v.covered || !v.first || !v.last) {
          lines.push({ key: `ls-${v.id}`, kind: 'signed', tone: 'muted', mark: v.id, signed: 0, cells: [name, noFigure(v), staleNote] });
          continue;
        }
        const one = v.readings < 2, move = moveText(v.first.long, v.last.long), part = v.covered < v.span ? t('{covered} of {span} covered', { covered: durationText(v.covered), span: durationText(v.span) }) : '';
        lines.push({ key: `ls-${v.id}`, kind: 'signed', mark: v.id, signed: one ? 0 : (v.last.long - v.first.long) / maxChange, ...(one ? { tone: 'muted' as const } : {}),
          cells: [name, one ? t('one reading') : move.change, [one ? pct(v.first.long) : move.shares, part, staleNote].filter(Boolean).join(' · ')] });
      }
      // A tile a venue: its drawn range and how wide it was, its time mean and the last share against it, how long it leaned which way, and
      // what its readings cover.
      const items: GridItem[] = group.filter(v => v.covered > 0 && v.low !== null && v.high !== null && v.mean !== null && v.last !== null).map(v => {
        const sides = v.above > 0 && !v.below && !v.even ? [{ label: t('Above 50 % throughout covered time'), value: '', tone: 'buy' as const }]
          : v.below > 0 && !v.above && !v.even ? [{ label: t('Below 50 % throughout covered time'), value: '', tone: 'sell' as const }]
          : [
            ...(v.above > 0 ? [{ label: t('Above 50 % long share'), value: t('{time} · {share} of covered time', { time: durationText(v.above), share: share(v.above, v.covered) }), tone: 'buy' as const }] : []),
            ...(v.below > 0 ? [{ label: t('Below 50 % long share'), value: t('{time} · {share} of covered time', { time: durationText(v.below), share: share(v.below, v.covered) }), tone: 'sell' as const }] : []),
            // The longest unbroken stretch where that is not all of it (a gap or a turn broke it).
            ...(v.longestAbove > 0 && v.longestAbove < v.above ? [{ label: t('Longest stretch above 50 %'), value: durationText(v.longestAbove) }] : []),
            ...(v.longestBelow > 0 && v.longestBelow < v.below ? [{ label: t('Longest stretch below 50 %'), value: durationText(v.longestBelow) }] : []),
          ];
        return {
          key: v.id, label: venueLabel(v.id), value: '', tip: t('From the readings drawn: each counts for the time its step covers, as the line draws it.'),
          rows: [
            { label: t('Drawn range'), value: moveText(v.low!, v.high!).shares.replace(' → ', ' – ') },
            { label: t('Range width'), value: ppSize(v.high! - v.low!) },
            { label: t('Time mean over covered time'), value: pct(v.mean!, 2) },
            { label: t('Last held share against the time mean'), value: ppChange(v.last!.long - v.mean!) },
            ...sides,
            { label: t('Covered by readings'), value: t('{k} of {n}', { k: durationText(v.covered), n: durationText(v.span) }) },
          ],
          note: `${tn(v.readings, '{n} reading · nominal period {period}', '{n} readings · nominal period {period}', { period: periodText(v.periodMs) })}${v.even > 0 ? ` · ${t('at 50 %: {time}', { time: durationText(v.even) })}` : ''}`,
        };
      });
      if (items.length) lines.push({ key: `ls-grid-${population ?? 'none'}`, kind: 'grid', cells: [], grid: items });
      // The venues of this population compared with themselves over the same two moments (the rows above each use their own readings).
      const spread = population ? s.spreads.find(x => x.population === population) : undefined;
      const sharedNote = (sp: LsSpread): RangeLine => note(`ls-shared-note-${population}`, t('Compared at {start} and just before {end}, the same venues at both: {venues}. The rows above use each venue\'s own readings.', {
        start: clock(sp.t0, true), end: clock(sp.t1 + 1, true), venues: sp.ids.map(venueLabel).join(', '),
      }));
      if (spread && spread.one.every(Boolean)) {
        // Every venue on one reading there: the gap alone, with the moments where they are not the whole selection.
        lines.push({ key: `ls-spread-${population}`, kind: 'stat', cells: [t('Highest minus lowest long share'), gapText(spread.end, gapDigits(spread.end))] });
        if (spread.t0 > s.t0 || spread.t1 + 1 < s.t1) lines.push(sharedNote(spread));
      } else if (spread) {
        lines.push({ key: `h-ls-shared-${population}`, kind: 'heading', cells: [t('Changes over shared moments')] });
        lines.push(sharedNote(spread));
        const most = Math.max(1e-9, ...spread.changes.filter((_, i) => !spread.one[i]).map(Math.abs));
        spread.ids.forEach((id, i) => lines.push(spread.one[i]
          ? { key: `ls-shared-${population}-${id}`, kind: 'signed', tone: 'muted', mark: id, signed: 0, cells: [venueLabel(id), t('one reading')] }
          : { key: `ls-shared-${population}-${id}`, kind: 'signed', mark: id, signed: spread.changes[i]! / most, cells: [venueLabel(id), ppChange(spread.changes[i]!)] }));
        const d = gapDigits(spread.start, spread.end);
        lines.push({ key: `ls-spread-${population}`, kind: 'stat', cells: [t('Highest minus lowest long share at those moments'), `${gapText(spread.start, d)} → ${gapText(spread.end, d)}`] });
      } else if (population && reading && group.length > 1) lines.push(note(`ls-shared-wait-${population}`, t('Shared-moment comparison unavailable while venues are being read.')));
    }
    // What the numbers count, as the pane's popup says it.
    if (s.venues.some(v => v.population && v.population !== 'topPositions')) lines.push(note('ls-accounts', t('Accounts as each exchange counts them, not coins: L/S 1.25 is 1.25 long accounts for each short one, not 25 % more BTC long. In coins the two sides are always equal.')));
    if (s.venues.some(v => v.population === 'topPositions')) lines.push(note('ls-positions', t('By positions: the share of the top traders\' position size that is long, not of accounts. L/S 1.25 is 1.25 times as much held long as short among them; across the whole market the two sides are always equal.')));
    if (s.venues.some(v => v.id.startsWith('bitget:') && v.oldest !== null && v.oldest > s.t0)) lines.push(note('ls-bitget', t('Bitget\'s endpoint returns only its newest 30 readings; older ones appear only where already held.')));
    lines.push(note('ls-how', t('Each venue on its own: their populations differ, so no share of all venues is given. A share counts for the time its drawn step covers; time with no step is left out, never taken as 50 %.')));
    return lines;
  }
}
