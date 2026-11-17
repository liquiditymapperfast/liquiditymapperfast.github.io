import type { BarInputs } from './inputs.ts';
import type { ScriptError } from './lang/lexer.ts';
import type { OptionValue } from './records.ts';
import type { DepthMessage, DepthTag } from './depth.ts';

/** The messages between the page and the script worker, and what a run answers for each script. */

/** One script to run: its text, the values set for its options, and the version of the language it was written for. */
export interface ScriptJob { id: string; source: string; options: Record<string, OptionValue>; api: number }
/** `depth`: the depth the run reads, as the page sent it before (`DepthMessage`); absent for a run in which no script reads depth. */
export interface RunRequest { t: 'run'; seq: number; jobs: ScriptJob[]; inputs: BarInputs; depth?: DepthTag }
/** What the page posts to the script worker: a run, or what changed of the depth (posted in order, before the runs that read it). */
export type WorkerMessage = RunRequest | DepthMessage;
/**
 * A run's answer, or the worker saying it has loaded and can take runs (sent once, first). `depthBehind`: the run was told of depth the
 * worker does not hold (a fresh worker), so depth read NaN in it; the page sends what it holds and runs again.
 */
export type RunResponse = { t: 'result'; seq: number; results: ScriptResult[]; depthBehind?: boolean } | { t: 'ready' };

/**
 * What a plot draws: a line, an area under a line, bars, a line with a baseline, candles or bars of four prices, a band between two lines,
 * marks (a label or a shape at a value, with a text to read when the pointer is on it), or levels (a price held from one candle on, to a
 * later one or to the right edge, named at its right end).
 */
export type PlotKind = 'line' | 'area' | 'histogram' | 'baseline' | 'candlestick' | 'bar' | 'cloudarea' | 'brokenarea' | 'mark' | 'level';

/** The numbers each kind of plot holds per candle. */
export const PLOT_FIELDS: Readonly<Record<PlotKind, readonly string[]>> = {
  line: ['value'], area: ['value'], histogram: ['value'], baseline: ['value'],
  candlestick: ['open', 'high', 'low', 'close'], bar: ['open', 'high', 'low', 'close'],
  cloudarea: ['lowerValue', 'higherValue'], brokenarea: ['lowerValue', 'higherValue'],
  mark: ['value'], level: ['value'],
};

/** The longest text a mark shows on the chart, and the longest it says when the pointer is on it. */
export const MARK_TEXT = 24, MARK_TIP = 600;

/**
 * One plot of a script over every candle: NaN where it has no point; `colors[i]` a colour the script gave candle i ('' for the plot's own).
 * A mark also has `texts[i]`, what it shows at candle i, and `tips[i]`, what it says there when the pointer is on it ('' for none).
 */
export interface PlotOut {
  kind: PlotKind;
  title: string;
  /** Its style: the named arguments of its call and the script's options for it (colours, line width, ...). */
  style: Record<string, OptionValue>;
  fields: Record<string, Float64Array>;
  colors: string[] | null;
  texts?: string[] | null;
  tips?: string[] | null;
  /**
   * A level's: each level is held at the candle it starts from (`fields.value[s]` its price, `texts[s]` its name, `colors[s]` its colour),
   * and `ends[s]` is the candle it ends at, NaN for one that runs on to the right edge.
   */
  ends?: Float64Array | null;
}

/** The candle a level starting at `s` ends at: its own end, or the newest of `n` candles for one that runs on. */
export const levelEnd = (p: PlotOut, s: number, n: number): number => { const e = p.ends?.[s] ?? NaN; return Number.isFinite(e) ? e : n - 1; };

/** The prices of the levels of `p` standing at candle `i` (started at or before it, not ended before it), the newest first; at most `most`. */
export function levelsAt(p: PlotOut, i: number, most = Infinity): number[] {
  const v = p.fields.value, out: number[] = [];
  if (!v || i < 0) return out;
  const n = v.length;
  for (let s = Math.min(i, n - 1); s >= 0 && out.length < most; s--) if (Number.isFinite(v[s]!) && levelEnd(p, s, n) >= i) out.push(v[s]!);
  return out;
}

/** What a plot reads at candle `i`: its fields there, or for levels the prices of those standing at it. */
export const valuesAt = (p: PlotOut, i: number): number[] => p.kind === 'level' ? levelsAt(p, i, 8) : PLOT_FIELDS[p.kind].map(f => p.fields[f]?.[i] ?? NaN);

/** The sounds a script's alert can make (`alert(text, sound=...)`); `none` is an alert with no sound, kept in the list. */
export const ALERT_SOUNDS = ['chime', 'rise', 'fall', 'tick', 'none'] as const;
export type AlertSound = typeof ALERT_SOUNDS[number];
/** The most alerts a run hands back for one candle, and the longest text of one. */
export const MAX_ALERTS = 16, ALERT_TEXT = 160;

/**
 * An `alert(...)` the script made at one of the newest candles (the one under way and the last one closed; older ones are history and are
 * never handed back): the call's place in the text, the candle's start (ms), its text and sound, and when it is meant to sound: `bar` as soon
 * as it is made during the candle, `close` once the candle has closed with it made. `forming` is whether its candle was under way.
 */
export interface AlertOut { site: number; t: number; text: string; sound: AlertSound; when: 'bar' | 'close'; forming: boolean }

/** An option a script declares (`option(...)`), for the panel to show. */
export interface OptionDecl { name: string; type: 'number' | 'color' | 'text' | 'boolean' | 'list' | 'range'; value: OptionValue; label?: string; min?: number; max?: number; step?: number; choices?: OptionValue[] }

export interface Warning { code: string; detail?: string }

export type ScriptResult =
  | { id: string; ok: true; plots: PlotOut[]; warnings: Warning[]; steps: number; ms: number; candleColors?: string[]; alerts?: AlertOut[] }
  | { id: string; ok: false; error: ScriptError };

/** A plot's newest values: its fields at the last of its first `upTo` candles where any of them is a number ([NaN] for a plot that drew none). */
export function newestOf(p: PlotOut, upTo = Infinity): number[] {
  if (p.kind === 'level') { const at = Math.min(p.fields.value?.length ?? 0, upTo) - 1, standing = levelsAt(p, at, 8); return standing.length ? standing : [NaN]; }
  const fields = PLOT_FIELDS[p.kind];
  let i = Math.min(p.fields[fields[0]!]?.length ?? 0, upTo) - 1;
  while (i >= 0 && !fields.some(f => Number.isFinite(p.fields[f]?.[i] ?? NaN))) i--;
  return i >= 0 ? fields.map(f => p.fields[f]?.[i] ?? NaN) : [NaN];
}
