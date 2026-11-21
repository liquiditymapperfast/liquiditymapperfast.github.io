import type { ProfileAnswer } from '../../shared/footprint.ts';
import type { DataSource } from '../source.ts';
import type { ColumnWords, TradedRows } from '../traded.ts';
import type { AppState, OiBar } from '../store.ts';
import type { Liquidation } from '../liquidations.ts';
import type { AbsorptionMark } from '../absorption.ts';
import type { FlowLoader } from '../delta/flows.ts';
import type { BucketLimit, TimeRows } from './model.ts';

/**
 * What a measure is, in one place: everything the profiles need of it wherever they are drawn (a column right or left of the map, a band
 * along the top), so a measure added later is one registration (measures/defs/, listed in measures/registry.ts) and shows in every place at
 * once. A profile instance (traded/profiles.ts) says where a measure is drawn; nothing here knows about places. The two projections are
 * asked apart and each keyed only by what changes its answer (the measure, the instruments, the window, the rows or buckets, the
 * thresholds): a measure on both sides of the map reads one answer by price, and moving a profile from one edge to another asks nothing new.
 */

/**
 * What an answer leaves out: `cut`, its record was cut at a limit (the smallest left out); `incomplete`, some minutes keep only their largest
 * groups; `unplaced`, the change in open interest that could not be put at a price (USD, signed).
 */
export interface MetricFlags { cut: boolean; incomplete: boolean; unplaced?: number }
export const NO_FLAGS: MetricFlags = { cut: false, incomplete: false };

/**
 * What a measure's header can say about how complete it is: `partial`, the window reaches back before the recording; `cut`, the record was
 * cut at a limit; `incomplete`, some minutes keep only part; `unplaced`, an amount could not be put at a price or a time.
 */
export type Completeness = 'partial' | 'cut' | 'incomplete' | 'unplaced';

/** The thresholds the absorption marks are judged at, by instrument (null: none yet). */
export type Thresholds = ReadonlyMap<string, number | null>;

/**
 * A measure by price: on which of the columns' instruments it is asked, how an instrument is named in the question (a new threshold is a new
 * question), and how the source answers it, as rows of the map's grid with two sides each (bid colour, then ask colour).
 */
export interface PriceProvider {
  instruments(ids: readonly string[], thresholds: Thresholds): string[];
  keyOf(id: string, thresholds: Thresholds): string;
  ask(source: DataSource, ids: string[], from: number, to: number, step: number, thresholds: Thresholds): Promise<{ answer: ProfileAnswer; flags: MetricFlags }>;
}

/**
 * What a band needs of the hub: the flow and its loaders, a market's open interest by the minute, the source's liquidations (as the
 * liquidation column asks for them), and the absorption marks held.
 */
export interface BandHub extends FlowLoader {
  oiSeries(id: string, tf: string, from: number, to: number): Promise<{ bars: OiBar[]; usdAt?: number }>;
  readonly source: { liquidations?(from: number, to: number): Promise<Liquidation[]> };
  readonly absorption: {
    marks(ids: readonly string[], thresholds: Thresholds, t0: number, t1: number, p0: number, p1: number): AbsorptionMark[];
    readonly version: number; readonly cover: { readonly from: number; readonly to: number } | null;
    floorIn(id: string, from: number, to: number): number | undefined;
  };
  readonly absorptionCut: ReadonlyMap<string, number>;
  readonly absorptionState: 'ready' | 'unavailable' | 'failed';
}

/** The absorption marks' thresholds by instrument (heat-pane.ts `#absorptionContext`). */
export interface AbsorptionContext { thresholds: Thresholds }

/**
 * One frame's question for a measure by time: the columns' window (`win`) and the part of it a source answers up to now (`from`, `to`) or
 * whole (`whole`), where its numbers begin when that is after the chart's left edge (`since`), the view's span on `pw` pixels for the
 * buckets, the page's clock and its whole second, the columns' markets, whether the window follows the live edge, the marks' thresholds
 * (read only by a measure judged at them) and what to call when something asked for has come.
 */
export interface TimeQuery {
  state: AppState; hub: BandHub;
  win: { from: number; to: number }; from: number; to: number; whole: { from: number; to: number }; since: number | null;
  span: number; pw: number; now: number; second: number;
  ids: readonly string[]; live: boolean;
  absorption(): AbsorptionContext; loaded(): void;
}

/** One measure added up by time for a window, and what it was worked out from. */
export interface Worked {
  /** What it was worked out from: the same key (and the same `refs`) is the same answer. */
  key: string; refs: readonly unknown[];
  rows: TimeRows; limit: BucketLimit;
  /** Where the record is cut (the column's flags), how often open interest is read. */
  flags: MetricFlags; spacingMs: number;
  /** Where the numbers begin when that is after the chart's left edge: a source answers eight days at most, as the columns say (`askedSpan`). */
  since: number | null;
  /** The source cannot answer for this measure (an older server). */
  unavailable: boolean;
}

/** A measure's worker by time: kept per measure (never per band), it holds what the measure loads and returns `last` while nothing changed. */
export interface TimeWorker { work(q: TimeQuery, last: Worked | null): Worked }

/** What a measure is worked out from, with the defaults filled in: no flags, the query's start, the source answering. */
export function worked(q: TimeQuery, key: string, refs: readonly unknown[], rows: TimeRows, limit: BucketLimit, extra: Partial<Worked> = {}): Worked {
  return { key, refs, rows, limit, flags: NO_FLAGS, spacingMs: 0, since: q.since, unavailable: false, ...extra };
}

/** An empty answer for a window: what a measure with no instrument to count answers. */
export const emptyAnswer = (from: number, to: number): ProfileAnswer => ({ from, to, instruments: [] });

/**
 * One measure's registration. Its amounts are dollars (`unit`), its two sides are added up apart and never netted (the bid colour's first,
 * then the ask colour's: `words`), and how each amount is valued is the providers' work, said in full in its notes (`priceNotes`,
 * `timeNote`), which the panel shows while it is drawn anywhere.
 */
export interface MeasureDef<Id extends string = string> {
  readonly id: Id;
  /** Its name where it is chosen (a row of the grid), and a short one for the panel's small picture of the chart. */
  name(): string;
  short(): string;
  /** What it shows, in a few words (the grid row's tip). */
  tip(): string;
  /** What a row's two sides, their difference and its share are called by price, and a window with nothing in it. */
  words(): ColumnWords;
  /** What a stretch of time with nothing in it is called. */
  stretchNone(): string;
  readonly unit: 'usd';
  /** What its header can say about how complete it is. */
  readonly completeness: readonly Completeness[];
  /** Its header's two lines over rows by price or by time: the total, then where its record is cut (`warn`: said in amber), or the largest row. */
  header(rows: TradedRows | null, flags: MetricFlags): { head: string; sub: string; warn: boolean };
  /** What its column shows and cannot say, by price (`browser`: the page reads the exchanges itself); empty for none. */
  priceNotes(o: { browser: boolean }): string[];
  /** What its band along the top adds up, from where, and what it cannot say. */
  timeNote(): string;
  /**
   * Whether it is judged at the absorption marks' thresholds: the marks' recent minutes are loaded for them while it is drawn by price, and
   * the marks' groups for the window while it is drawn by time, the marks on or off.
   */
  readonly judgedByMarks: boolean;
  /** Whether a drag on its column adds up its own rows in the Range panel (the panel adds up traded volume at those prices). */
  readonly rangeAddsUp: boolean;
  /**
   * Whether only perpetuals have it (open interest, liquidations): its column and its band count the markets `oiFlowIds` counts, whatever
   * the Spot / Perp filter says, so a Spot filter left on does not empty them (Karl, 2026-11-05 for open interest, 2026-11-21 liquidations).
   */
  readonly perpetualsOnly: boolean;
  readonly byPrice: PriceProvider;
  readonly byTime: { worker(): TimeWorker };
}

/**
 * One question at a time for what a band reads by time and the page does not hold, as the columns ask theirs (`Hub.ensureTraded`): again
 * when it changes, and while it reaches the present at most every five seconds, twenty times what the last answer took, five minutes at the
 * longest; a question that only slid with the live edge waits for that spacing, and so does one whose end only crept on, followed live or not
 * (a window cut at a clock that runs: the page's while the view is scrolled back from the live edge, or a replay's), which used to be asked
 * again on every frame. The last answer is kept, and drawn, while the next comes.
 */
export class Asked<T> {
  held: T | null = null;
  /** The window `held` answers: what the band may count as read (a window grown since is not, until its own answer comes). */
  answered: { from: number; to: number } | null = null;
  /** Bumped with each answer, so what was worked out from the last one is known to be stale. */
  version = 0;
  failed = false;
  #asked: { base: string; from: number; to: number; at: number } | null = null;
  #loading = false; #ms = 0; #retryAt = 0;

  ensure(base: string, from: number, to: number, live: boolean, load: () => Promise<T>, loaded: () => void): void {
    const now = Date.now(), spacing = Math.min(300_000, Math.max(5_000, 20 * this.#ms)), a = this.#asked;
    if (this.#loading || now < this.#retryAt) return;
    const same = a !== null && a.base === base && a.from === from && a.to === to;
    const slid = live && a !== null && a.base === base && from >= a.from && to >= a.to && from - a.from <= spacing && to - a.to <= spacing;
    // Crept: by about the clock's run since (not a window widened by a zoom or a jump, which is asked at once).
    const crept = a !== null && a.base === base && a.from === from && to > a.to && to - a.to <= spacing;
    if ((same || slid || crept) && !((live || crept) && now - a!.at >= spacing)) return;
    this.#loading = true; this.#asked = { base, from, to, at: now };
    const started = performance.now();
    load().then(value => { this.#ms = performance.now() - started; this.held = value; this.answered = { from, to }; this.failed = false; this.version++; loaded(); },
      () => { this.failed = true; this.#asked = null; this.#retryAt = Date.now() + 60_000; this.version++; loaded(); })
      .finally(() => { this.#loading = false; });
  }
}
