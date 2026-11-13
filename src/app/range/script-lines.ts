import type { PlotKind, PlotOut } from '../script/protocol.ts';
import { clock, fixedFormat } from '../format.ts';
import { t, tn } from '../i18n.ts';
import { durationText, spanText } from './oi-lines.ts';
import type { RangeSelection } from './selection.ts';
import type { GridItem, RangeLine } from './stats.ts';

/**
 * One script of the Scripts pane as its row was last drawn: hidden, waiting for an answer for the chart as it is, an error, or drawn with
 * its last answer (the candles it ran over, how many of them had closed when it ran, as far as a replay shows them, and the moment it was
 * worked out at: Infinity live, the replay's moment in a replay, -Infinity for an error met on the page, which holds everywhere).
 */
export type ScriptRowHeld =
  | { id: string; name: string; state: 'hidden' | 'running' }
  | { id: string; name: string; state: 'error'; error: string; at: number }
  | { id: string; name: string; state: 'drawn'; time: Float64Array; tfMs: number; closed: number; at: number; plots: readonly PlotOut[]; warnings: number };

/**
 * What the Scripts pane drew last, handed to its Range summary (provider.ts): its rows (only the scripts that are on and draw in the pane, in
 * its order), and what they were drawn for. The same object while none of that changes.
 */
export interface ScriptPaneHeld {
  /** What it was drawn for (`scriptHeldKey`): the chart's instrument and timeframe, and the scripts as they were then. */
  key: string;
  tf: string; tfMs: number;
  rows: readonly ScriptRowHeld[];
  /** What it was built from (`scriptPaneHeld`): equal inputs keep the object. */
  sig: string;
}

/** The context a Scripts snapshot stands for: the chart's instrument and timeframe, and the scripts' version (any edit, switch or reorder). */
export const scriptHeldKey = (state: { seriesInstrument: string; timeframe: string }, version: number): string => `${state.seriesInstrument}|${state.timeframe}|${version}`;

/**
 * A row as the pane hands it over: hidden, and its answer when one may be drawn now (`ScriptPane.#fresh`), else null; a drawn answer's
 * `closed` is already cut at a replay's moment (`shownCount`).
 */
export interface ScriptRowInput {
  id: string; name: string; hidden: boolean; warnings: number;
  held: { ok: true; time: Float64Array; tf: number; closed: number; at: number; plots: readonly PlotOut[] } | { ok: false; error: string; at: number } | null;
}

/**
 * The pane's snapshot of its rows, `prev` itself while nothing it says changed. The pane draws on every pointer move, so its rows are signed
 * by what changes them: the answers (`gen`, a new one at every run and every change of the scripts), the context, and each row's state, closed
 * candles (a replay moving a candle), moment and warnings.
 */
export function scriptPaneHeld(prev: ScriptPaneHeld | null, gen: number, key: string, tf: string, tfMs: number, rows: readonly ScriptRowInput[]): ScriptPaneHeld {
  const state = (r: ScriptRowInput): string => r.hidden ? 'h' : !r.held ? 'r' : !r.held.ok ? `e@${r.held.at}` : `d${r.held.closed}@${r.held.at}`;
  const sig = `${gen}|${key}|${tf}|${rows.map(r => `${r.id}:${state(r)}:${r.warnings}`).join(',')}`;
  if (prev && prev.sig === sig) return prev;
  return {
    key, tf, tfMs, sig,
    rows: rows.map((r): ScriptRowHeld => {
      if (r.hidden) return { id: r.id, name: r.name, state: 'hidden' };
      if (!r.held) return { id: r.id, name: r.name, state: 'running' };
      if (!r.held.ok) return { id: r.id, name: r.name, state: 'error', error: r.held.error, at: r.held.at };
      return { id: r.id, name: r.name, state: 'drawn', time: r.held.time, tfMs: r.held.tf, closed: r.held.closed, at: r.held.at, plots: r.held.plots, warnings: r.warnings };
    }),
  };
}

/** The plots summed up: one value a candle. A histogram is one too: nothing says its values add up, so it gets the same figures as a line. */
const SCALAR: ReadonlySet<PlotKind> = new Set(['line', 'area', 'histogram', 'baseline']);

/** A plot's name, as its popup gives it. */
const plotLabel = (plot: PlotOut, j: number): string => plot.title || `${plot.kind} ${j + 1}`;

/** One scalar plot over the selection's closed candles: how many had a value, the first and last, the lowest and highest. */
export interface PlotStretch { j: number; label: string; values: number; first: { t: number; v: number } | null; last: { t: number; v: number } | null; low: number; high: number }

/**
 * A drawn row over the selection. `slots`: the candles of its timeframe that start in the selection and had closed by now; `held`: those its
 * answer holds as closed (the rest before its first candle, missing from it, or after its newest closed one: closed since it ran, or under way
 * when it ran); `forming`: the candle under way now starts in the selection.
 */
export interface ScriptStretch {
  slots: number; held: number; before: number; gaps: number; after: number; forming: boolean;
  plots: PlotStretch[];
  /** Plots of several fields (candles, bars, bands): named, not summed up yet. */
  compound: string[];
  /** Mark plots: how many marks each placed on the closed candles. */
  marks: { j: number; label: string; count: number }[];
  /** Plots set invisible. */
  invisible: number;
}

/** The first index of `time` at or after `t`. */
function firstAtOrAfter(time: Float64Array, t: number): number {
  let lo = 0, hi = time.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (time[m]! < t) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * A drawn row's figures over `sel`, on the candles that start in it and that its answer holds as closed (never the one under way when it
 * ran, never one closed after `now`, the clock's or a replay's moment).
 */
export function scriptStretch(row: Extract<ScriptRowHeld, { state: 'drawn' }>, sel: Pick<RangeSelection, 't0' | 't1'>, now: number): ScriptStretch {
  const { time, tfMs: tf } = row, closed = Math.max(0, Math.min(row.closed, time.length));
  // The candles of the selection that had closed by now, on the timeframe's grid (whole minutes to whole days: the epoch's multiples).
  const first = Math.ceil(sel.t0 / tf) * tf, openNow = Math.floor(now / tf) * tf;
  const slotEnd = Math.min(sel.t1, openNow);
  const slots = Math.max(0, Math.ceil((slotEnd - first) / tf));
  // The candle under way now (a replay's too: its runs read only the candles closed by its moment).
  const forming = openNow >= first && openNow < sel.t1;
  // The answer's closed candles in the selection: [i0, i1).
  const i0 = firstAtOrAfter(time, sel.t0);
  let i1 = Math.min(firstAtOrAfter(time, sel.t1), closed);
  while (i1 > i0 && time[i1 - 1]! + tf > now) i1--;
  const held = Math.max(0, i1 - i0);
  // Where the rest of the slots are: before the answer's first candle, after its newest closed one, or missing between.
  const oldest = time.length ? time[0]! : Infinity, newestClosed = closed > 0 ? time[closed - 1]! : -Infinity;
  const countIn = (a: number, b: number): number => Math.max(0, Math.ceil((Math.min(b, slotEnd) - Math.max(a, first)) / tf));
  const before = Number.isFinite(oldest) ? countIn(first, oldest) : slots;
  const after = !Number.isFinite(oldest) ? 0 : countIn(Number.isFinite(newestClosed) ? newestClosed + tf : oldest, slotEnd);
  const gaps = Math.max(0, slots - held - before - after);
  const out: ScriptStretch = { slots, held, before, gaps, after, forming, plots: [], compound: [], marks: [], invisible: 0 };
  // Two plots shown under one name are told apart by their place (a plot set invisible is not shown, so it makes no twin).
  const labels = row.plots.map(plotLabel), seen = labels.filter((_, k) => row.plots[k]!.style.visible !== false);
  const twice = new Set(seen.filter((l, k) => seen.indexOf(l) !== k));
  row.plots.forEach((plot, j) => {
    if (plot.style.visible === false) { out.invisible++; return; }
    const label = twice.has(labels[j]!) ? t('{plot} ({n})', { plot: labels[j]!, n: j + 1 }) : labels[j]!;
    if (plot.kind === 'mark') {
      const v = plot.fields.value; let count = 0;
      if (v) for (let i = i0; i < i1 && i < v.length; i++) if (Number.isFinite(v[i]!)) count++;
      out.marks.push({ j, label, count });
      return;
    }
    if (!SCALAR.has(plot.kind)) { out.compound.push(label); return; }
    const v = plot.fields.value, p: PlotStretch = { j, label, values: 0, first: null, last: null, low: Infinity, high: -Infinity };
    if (v) for (let i = i0; i < i1 && i < v.length; i++) {
      const x = v[i]!;
      if (!Number.isFinite(x)) continue;
      p.values++;
      p.first ??= { t: time[i]!, v: x };
      p.last = { t: time[i]!, v: x };
      if (x < p.low) p.low = x;
      if (x > p.high) p.high = x;
    }
    out.plots.push(p);
  });
  return out;
}

/**
 * How a tile writes its values: one unit and one number of decimals for all of them, enough to tell its lowest from its highest and its first
 * from its last (three significant digits of the smaller of the two gaps), less the decimals that are zero in every one of them (`also`: its
 * other values, its first and last), so whole numbers stay whole. Billions and millions are written short where the gap is large enough to
 * read in them (a cumulative line at -4.86 billion that moved 9 million reads in millions); nothing else is (its unit is the script's,
 * undeclared, so no price or dollar format applies). `signed`: a change, with its sign.
 */
export function valueFormat(low: number, high: number, change = high - low, also: readonly number[] = []): (v: number, signed?: boolean) => string {
  const mag = Math.max(Math.abs(low), Math.abs(high));
  const gap = Math.min(...[high - low, Math.abs(change)].filter(x => x > 0), Infinity);
  const [scale, unit] = mag >= 1e9 && !(gap < 1e8) ? [1e9, 'B'] : mag >= 1e6 && !(gap < 1e5) ? [1e6, 'M'] : [1, ''];
  const ref = Number.isFinite(gap) ? gap / scale : 0;
  const want = ref > 0 ? 3 - Math.ceil(Math.log10(ref)) : mag > 0 ? 4 - Math.ceil(Math.log10(mag / scale)) : 0;
  if (!Number.isFinite(mag)) return v => Number.isFinite(v) ? String(v) : '–';
  // Values too small for eight decimals to tell apart (or to write at all), or past a thousand trillion: in powers of ten, with the digits
  // the gap needs.
  if (want > 8 || mag >= 1e15) {
    const digits = Math.max(2, Math.min(12, (Number.isFinite(gap) ? Math.floor(Math.log10(mag)) - Math.floor(Math.log10(gap)) : 0) + 2));
    return (v, signed = false) => !Number.isFinite(v) ? '–' : v === 0 ? '0' : `${v < 0 ? '−' : signed ? '+' : ''}${Math.abs(v).toExponential(digits)}`;
  }
  const clamp = (d: number): number => Math.max(0, Math.min(8, d));
  let decimals = clamp(want);
  const all = [low, high, change, ...also].map(v => Math.abs(v) / scale);
  while (decimals > 0 && all.every(v => Math.round(v * 10 ** decimals) % 10 === 0)) decimals--;
  const f = fixedFormat(decimals);
  return (v, signed = false) => {
    if (!Number.isFinite(v)) return '–';
    const body = f.format(Math.abs(v) / scale), zero = Number(body.replace(/,/g, '')) === 0;
    return `${!zero && v < 0 ? '−' : !zero && signed && v > 0 ? '+' : ''}${body}${unit}`;
  };
}

/**
 * Whether a row waits, as the pane draws it (`ScriptPane.#current`): no answer yet, or one worked out after a replay's moment, or a live one in
 * a replay (an error met on the page, at -Infinity, holds everywhere).
 */
const waits = (row: ScriptRowHeld, now: number, replay: boolean): boolean =>
  row.state === 'running' || ((row.state === 'drawn' || row.state === 'error') && row.at > (replay ? now : Infinity));

/**
 * The Scripts pane's Range summary (provider.ts): each script drawn in the pane, each of its visible plots of one value a candle over the
 * selection's closed candles, in the plot's own values: first and last, change, lowest and highest, and how many candles had a value. Nothing
 * is summed and no unit is named: a script declares neither. It reads only what the pane drew (it never starts a run), and a row the pane
 * shows waiting is waiting here too.
 */
export class ScriptRangeSummary {
  #last: { held: ScriptPaneHeld | null; sel: RangeSelection; shown: boolean; current: string; minute: number; replay: boolean; due: string; zone: string; noScripts: boolean; lines: RangeLine[] } | null = null;

  /** `replay`: whether `now` is a replay's moment; `noScripts`: no script that is on draws in the pane. */
  lines(sel: RangeSelection, held: ScriptPaneHeld | null, shown: boolean, current: string, now: number, replay: boolean, zone = '', noScripts = false): RangeLine[] {
    // Which rows a replay may show now (`waits`) changes at their own moments, not on the minute.
    const last = this.#last, minute = Math.floor(now / 60_000), due = held ? held.rows.map(r => waits(r, now, replay) ? '1' : '0').join('') : '';
    if (last && last.held === held && last.sel === sel && last.shown === shown && last.current === current && last.minute === minute && last.replay === replay && last.due === due && last.zone === zone && last.noScripts === noScripts) return last.lines;
    const lines = this.#lines(sel, held, shown, current, now, replay, noScripts);
    this.#last = { held, sel, shown, current, minute, replay, due, zone, noScripts, lines };
    return lines;
  }

  #lines(sel: RangeSelection, held: ScriptPaneHeld | null, shown: boolean, current: string, now: number, replay: boolean, noScripts: boolean): RangeLine[] {
    const title = (text: string): RangeLine => ({ key: 'sc-title', kind: 'title', cells: [text] });
    const note = (key: string, text: string): RangeLine => ({ key, kind: 'note', tone: 'muted', cells: [text] });
    const span = title(spanText(sel.t0, sel.t1));
    if (noScripts) return [span, note('sc-none', t('No script is both on and set to "In its own row". Open Scripts… to change this.'))];
    // Another context: a pane in view draws again within a frame or a run (a live selection's refresh can come between), a hidden one does not.
    if (held && held.key !== current) return [span, shown ? note('sc-wait', t('Waiting for a run for this chart.')) : note('sc-stale', t('The Scripts pane last drew another market, timeframe or set of scripts: show it to sum up this selection.'))];
    if (!held) return [span, note('sc-none', shown ? t('Waiting for a run for this chart.') : t('The Scripts pane has not drawn yet: show it to sum up this selection.'))];
    if (sel.t0 >= now) return [span, note('sc-none', t('This selection has not begun yet.'))];
    // No closed candle starts in the selection (a minute stretch inside one candle, or a replay's candle under way alone): said, no tiles.
    const tf = held.tfMs, first = Math.ceil(sel.t0 / tf) * tf, openNow = Math.floor(now / tf) * tf;
    if (Math.min(sel.t1, openNow) <= first) {
      const under = openNow >= first && openNow < sel.t1;
      return [span, note(under ? 'sc-forming' : 'sc-none', under ? t('The candle under way is left out.') : t('No {tf} candle of the Scripts pane starts in this range.', { tf: held.tf }))];
    }
    const lines: RangeLine[] = [title(`${spanText(sel.t0, sel.t1)} · ${durationText(sel.t1 - sel.t0)}${!replay && sel.t1 > now ? ` · ${t('forming')}` : ''}`)];
    const status = [t('Visible plots over the closed {tf} candles held by each script\'s last run', { tf: held.tf })];
    if (replay) status.push(t('replay: candles closed by {time}', { time: clock(Math.floor(now / held.tfMs) * held.tfMs, true) }));
    lines.push(note('sc-status', status.join(' · ')));
    if (!shown) lines.push(note('sc-hidden', t('The Scripts pane is hidden: these are the values it last drew.')));
    if (sel.p0 !== null && sel.p1 !== null) lines.push(note('sc-prices', t('Script values are for all prices.')));
    let forming = false;
    for (const row of held.rows) {
      // As the pane draws its row: an answer (or a run's error) worked out after a replay's moment, or a live one in a replay, waits.
      const waiting = waits(row, now, replay);
      lines.push({ key: `h-sc-${row.id}`, kind: 'heading', cells: [row.state === 'hidden' ? `${row.name} · ${t('hidden')}` : row.name] });
      if (row.state === 'hidden') { lines.push(note(`sc-hidden-${row.id}`, t('Hidden in the pane: left out.'))); continue; }
      if (waiting) { lines.push(note(`sc-wait-${row.id}`, t('Waiting for a run for this chart.'))); continue; }
      if (row.state === 'error') { lines.push(note(`sc-error-${row.id}`, row.error)); continue; }
      if (row.state !== 'drawn') continue;
      const s = scriptStretch(row, sel, now);
      forming ||= s.forming;
      // The closed candles of the selection its answer does not hold: said, and left out of every figure.
      if (s.held < s.slots) {
        const why = [
          ...(s.before > 0 && row.time.length ? [t('the run begins at {time}', { time: clock(row.time[0]!, true) })] : []),
          ...(s.gaps > 0 ? [tn(s.gaps, '{n} candle missing', '{n} candles missing')] : []),
          ...(s.after > 0 ? [t('newer closed candles are not in its last run')] : []),
        ];
        lines.push(note(`sc-cover-${row.id}`, [t('Its last run holds {k} of the {n} closed candles in this selection', { k: s.held, n: s.slots }), ...why].join(' · ')));
      }
      const items: GridItem[] = s.plots.map(p => {
        const key = `${row.id}-${p.j}`;
        if (!p.first || !p.last) return { key, label: p.label, value: t('No value in this selection'), ...(s.held ? { rows: [{ label: t('Candles with a value'), value: t('{k} of {n}', { k: 0, n: s.held }) }] } : {}) };
        const fmt = valueFormat(p.low, p.high, p.last.v - p.first.v, [p.first.v, p.last.v]);
        const support = { label: t('Candles with a value'), value: t('{k} of {n}', { k: p.values, n: s.held }) };
        if (p.values === 1) return { key, label: p.label, value: '', rows: [{ label: t('Value'), value: fmt(p.first.v) }, support], note: clock(p.first.t, true) };
        return {
          key, label: p.label, value: '',
          rows: [
            { label: t('First → last'), value: `${fmt(p.first.v)} → ${fmt(p.last.v)}` },
            { label: t('Change'), value: fmt(p.last.v - p.first.v, true) },
            { label: t('Lowest – highest'), value: `${fmt(p.low)} – ${fmt(p.high)}` },
            support,
          ],
          // When its first or last value may not be on the selection's first or last closed candle: some had no value, or the run lacks some.
          ...(p.values < s.slots ? { note: t('First value {start} · last {end}', { start: clock(p.first.t, true), end: clock(p.last.t, true) }) } : {}),
        };
      });
      if (items.length) lines.push({ key: `sc-grid-${row.id}`, kind: 'grid', cells: [], grid: items });
      // A plot of marks that placed none here (labels at the newest candle, say) says nothing.
      for (const m of s.marks) if (m.count > 0) lines.push({ key: `sc-marks-${row.id}-${m.j}`, kind: 'stat', cells: [t('{plot}: marks in the script output', { plot: m.label }), String(m.count)] });
      if (s.compound.length) lines.push(note(`sc-compound-${row.id}`, t('{plots}: plots of several fields; a range summary is not available for them yet.', { plots: s.compound.join(', ') })));
      if (s.invisible) lines.push(note(`sc-invisible-${row.id}`, tn(s.invisible, '{n} plot set invisible is left out.', '{n} plots set invisible are left out.')));
      if (row.warnings) lines.push(note(`sc-warn-${row.id}`, tn(row.warnings, '{n} warning in its last run: see the Scripts panel.', '{n} warnings in its last run: see the Scripts panel.')));
      if (items.length) lines.push(note(`sc-unit-${row.id}`, t('Unit not declared by this script.')));
    }
    if (forming) lines.push(note('sc-forming', t('The candle under way is left out.')));
    lines.push(note('sc-how', t('Values are not added up. Shown values and changes are rounded on their own.')));
    return lines;
  }
}
