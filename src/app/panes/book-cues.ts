import type { SideArrays } from '../wire.ts';
import { gridStepFor } from '../../shared/grid.ts';
import { binOf } from '../../shared/footprint.ts';

/**
 * Observed changes of displayed depth, venue by venue: what the order book's cues are made from (Karl, 2026-10-22: "its cell would flash
 * brighter, and if it is decreasing, it would dim"; design by Claude, its advisor and Sol 6.1 over two rounds and two studies on live data,
 * `Research_Results/notes/order-book-physics-2026-10-22.md`).
 *
 * WHAT IT MEASURES. The difference of one venue's displayed USD in one price cell between two DISTINCT publications of that venue's book.
 * Nothing else: a decrease may be a trade, a cancellation or both, an increase a new order or a re-quote, and between two snapshots a
 * venue's gross adds and removes cancel inside the cell. The book carries no order ids and no ages, so the "heat" it keeps (`heat`) is an
 * ESTIMATE of recent net increases under a stated convention (a decrease takes proportionally from the fresh and the old), never an age.
 *
 * WHY IT IS BUILT THIS WAY (each point is a number from the live study, 25 minutes of BTC on 11 books, 2026-10-22):
 *  - A book is compared with its own previous PUBLICATION, not with the previous frame. 63.9 % of venue-frames repeat the book as it was
 *    (the server sends every cached book in every frame; eight of eleven deep books are re-valued once a second, Hyperliquid's 40 bands
 *    every 5.4 s). A "confirm on the next frame" rule was confirmed by a repeated frame 78.5 % of the time.
 *  - The cell is a bin of the book's own MERGE GRID, never of the ladder's row. The server (and the browser engine) merge far levels into
 *    buckets that widen with the distance from the mid (`shared/merge.ts`) and report a bucket at its farthest member, so a $10 add can
 *    move a $100k bucket across a ladder row's edge with nothing changed in the native book. A bucket is never wider than one grid step
 *    within 250 steps of the mid, and then it never straddles a grid bin, so the merged book holds the native USD per grid bin there
 *    exactly: a property test (`Research_Files/order_book_physics_20261022/merge-bin-invariance.mjs`, repeated in the tests of this
 *    module) found 0 bins changed on grids that are multiples of the merge step and 13 to 54 % on a $50 or $25 row grid beyond $500 from
 *    the mid. So the comparison is made on the grid, within `ZONE_STEPS` of the mid, and `rowEvents` puts a cell on the rows afterwards.
 *  - Near the mid, a cell keeps the levels it is made of (`CueEvent.lv`: the price and USD of each point level of the bin, in both publications).
 *    The merge keeps the touch at a twentieth of the grid step: out to `LV_STEPS` (12.5) grid steps from the mid a lone level keeps its exact
 *    price and a bucket is a twentieth of a step wide, aligned to multiples of that width (`FINEST` and `DISTANCE_SHARE` of `shared/merge.ts`,
 *    mirrored here as `MERGE_FINEST` and `MERGE_DISTANCE_SHARE`, and pinned against `bucketWidth` by the tests, so a change there fails them). So
 *    a bin holds up to twenty prices where the ladder's rows are finer than the grid ($10 or $5 zoomed in) or straddle its edge (the default $50
 *    rows over a $20 grid: one bin in five), the ladder's own bars are built from those prices, and a bucket never straddles a row edge whose
 *    step is a multiple of its width (every nice step: $1, $2, $5, $10, $25, $50 at a $20 grid). A bin's net says nothing of which row moved
 *    which way: +$2M at 81,021 and -$500K at 81,031 in one bin read as +$750K on both $10 rows when the net was shared by overlap (Sol,
 *    2026-10-22), where the bars show +$2M and -$500K. `rowEvents` places each level in its row as the kernel does (`spread_levels`: the floor
 *    of price / step), so there a row's change is the bar's change. Beyond that distance the buckets widen and a bucket is reported at its
 *    farthest member, so a member that goes moves the whole bucket, and its bar, across a row edge: a $60K cancellation in a $5M bucket that
 *    hops reads as -$5M on one row and +$4.94M on the next, two cues at full strength for a change of $60K. So there the event is a share of
 *    the bin's net by overlap, never the wrong way by more than the change (`CueTuning.lvSteps` moves the limit; 0 keeps no levels). A band
 *    level (a share of a bin, not a price) in either publication of a side, or a weak change whose first publication was not kept, leaves the
 *    event to the share too.
 *  - A cell counts only where the book covers it in BOTH publications (a depth limit moving with the price is not a pull): a bin past the
 *    lowest bid level or the highest ask level is unknown, not empty, and so is the edge bin that holds that level and may be cut; the
 *    bins in the spread are known to be empty. Bins that enter the zone or the book's reach start again, with no event.
 *  - Per-venue cadence: a gap is `max(MIN_GAP_MS, GAP_CADENCES x the venue's own cadence)`, so a 5.4 s book is not a gap and a 1 s book
 *    that went quiet for 20 s is one. Nothing is reset by another venue's rhythm.
 *
 * WHAT IT DOES NOT CLAIM. No "pull", no "cancel", no "iceberg", no cause: the Tape's rule that a removal the price passed is not a pull
 * is about the word, and a generic decrease is shown. Beyond `ZONE_STEPS` grid steps from a book's mid (about 6 % at BTC's $20 grid) and
 * for a grid the book did not publish (`approx`: inferred from the mid, which can differ from the recorder's, stale after a big move)
 * the merge guarantee does not hold, and the cells there are not compared or are flagged. Banded books (Hyperliquid) are compared band
 * by band where the same band exists in both publications, never inside their touch span (a split that moves with the trades is not
 * liquidity coming or going). A change that nets to zero inside one bin (a level moving between two prices of the bin) raises no event, however
 * far it moves the bar between two rows finer than the grid. Within `lvSteps` of the mid a row finer than the merge's bucket (below $1 at a $20
 * grid) hops with the bucket's price, and so does the cue: the bar's own truth. Beyond it the bar hops with a bucket's reported price and the
 * cue does not: the row is a share of the bin's net, by overlap. The limit is a bin's far edge from the mid, in the publication that holds the
 * levels, so it can be off by the finest width (the mid is worked out from the merged book, not the native one): a bucket there may be twice as wide.
 *
 * Pure: no DOM, no WASM (the step costs 0.07 ms for 12 books x 120 bins, and JavaScript matched or beat a Rust kernel in the study, which
 * copies across the boundary), no text. State is typed arrays of 2 x `ZONE_STEPS` + 20 cells (518) a side a book, reused, and `CUE_HISTORY` (4)
 * references to the last events of each cell for the hover (`recentEvents` goes back as many publications: a newer event of a bin need not
 * touch the row an older one did); once a book is warm a frame allocates the events it returns, the short lists of levels they keep, the array
 * that holds them and a few iterators, nothing sized by the books. Measured in Node (`Research_Files/order_book_physics_20261022/tracker-bench.mts`, synthetic books that raise about three
 * times the events the live ones do, 79 % of them near the mid as the live ones were): the eleven default books at about 430 levels a side with
 * four new publications a frame take 0.24 ms without levels (`lvSteps` 0) and 0.28 ms with them near the mid (a frame that repeats them all,
 * 0.07 ms); 25 books at 500 levels with eight, 0.51 and 0.63 ms. A bin beyond `lvSteps` is told apart by two comparisons, before anything is listed.
 */

/** Estimated recent net increase cools with this time constant; recent activity (adds and removes) with the second. */
export const TAU_FRESH_MS = 45_000, TAU_ACTIVITY_MS = 20_000;
/** Grid steps either side of a book's mid inside which the merged book holds the native USD per grid bin (`shared/merge.ts`: width <= step to 250 steps). */
export const ZONE_STEPS = 249;
/**
 * The merge's finest bucket, a twentieth of the grid step, holds while a level's distance from the mid times 0.4 % is no more than that width
 * (`bucketWidth` in `shared/merge.ts`, which exports neither constant): so out to `LV_STEPS` = 1 / 20 / 0.004 = 12.5 grid steps from the mid (about
 * $250 at BTC's $20 grid) a lone level keeps its exact price and a bucket is aligned to multiples of its width. The two are mirrored here, and the
 * tests pin the distance they give against `bucketWidth` itself, so a change there fails them instead of leaving the tracker behind.
 */
export const MERGE_FINEST = 20, MERGE_DISTANCE_SHARE = 0.004;
export const LV_STEPS = 1 / MERGE_FINEST / MERGE_DISTANCE_SHARE;
/** Opposite changes within this many bins whose sum is under this share of the larger are flagged as one re-quote. */
export const PAIR_BINS = 2, PAIR_TOLERANCE = 0.15;
/** A change of this many gates or more is raised at once; a weaker one waits for the next publication to agree. */
export const CONFIRM_RATIO = 3;
/** The noise (the mean change over the non-empty cells) forgets with this half-life, as the Tape's does. */
export const NOISE_HALF_LIFE_MS = 20_000;
/** A venue silent for more than `max(MIN_GAP_MS, GAP_CADENCES x its cadence)` starts again; one not asked for for `FORGET_MS` is forgotten. */
export const MIN_GAP_MS = 8_000, GAP_CADENCES = 4, FORGET_MS = 30_000;
/** The gate is `max(floor, MEAN_SHARE x the side's mean non-empty cell, NOISE_MULTIPLE x its noise)`; a change counts at most `NOISE_CLIP` noises towards the noise. */
export const MEAN_SHARE = 0.05, NOISE_MULTIPLE = 3, NOISE_CLIP = 5;
/** A provider stamp may jitter back by this much without starting the book again. */
export const BACK_TOLERANCE_MS = 1_000;
/** A band that went empty is kept this long (so its return is an add, not a new band). */
export const GHOST_MS = 60_000;
/**
 * How many events a cell keeps for the hover, and how many publications `recentEvents` goes back. A newer event of a bin need not touch every display row
 * the bin holds (with levels it moves one row and not the next), so the older ones stay: the state is `CUE_HISTORY` references a cell, no more, however many
 * publications there are.
 */
export const CUE_HISTORY = 4;
/** The cadence a book's interval is learned from counts at most this much (an outage is not a rhythm). */
const CADENCE_CAP_MS = 30_000;
/** Cells either side of the window's edge kept spare when it follows the mid, so it moves only every few bins. */
const PAD = 8;

export interface CueTuning {
  tauFreshMs: number; tauActivityMs: number; zoneSteps: number; pairBins: number; pairTolerance: number; confirmRatio: number;
  noiseHalfLifeMs: number; minGapMs: number; gapCadences: number; forgetMs: number; meanShare: number; noiseMultiple: number; noiseClip: number;
  backToleranceMs: number; ghostMs: number;
  /**
   * Whether an increase under the gate counts towards the recent net increase. It does by default, as the brief says, and a cell that jitters
   * (adds and takes back a little each second) then fills up with recent increases whatever its quantity does: a decrease takes from them in
   * proportion, so its share of fresh climbs towards 1. With `true` only increases that were worth an event count, and a jittering cell stays
   * as it was.
   */
  freshGated: boolean;
  /**
   * Grid steps from the book's mid within which an event keeps the levels it is made of (`CueEvent.lv`): a bin counts only when all of it is that near, in
   * the publication that holds the levels (and so in both, for a change measured from the one before). Beyond, the merge's buckets are wider than a
   * twentieth of the grid step and a bucket is reported at its farthest member, so a member that goes moves the whole bucket, and its bar, across a row
   * edge: levels would show that as two cues of the bucket's size for a change of the member's, where the share by overlap is never the wrong way by
   * more than the change. `LV_STEPS` (12.5) is where the merge's buckets are at their finest; 0 keeps no levels, a large number keeps them everywhere.
   */
  lvSteps: number;
}
export const DEFAULT_TUNING: CueTuning = {
  tauFreshMs: TAU_FRESH_MS, tauActivityMs: TAU_ACTIVITY_MS, zoneSteps: ZONE_STEPS, pairBins: PAIR_BINS, pairTolerance: PAIR_TOLERANCE, confirmRatio: CONFIRM_RATIO,
  noiseHalfLifeMs: NOISE_HALF_LIFE_MS, minGapMs: MIN_GAP_MS, gapCadences: GAP_CADENCES, forgetMs: FORGET_MS, meanShare: MEAN_SHARE, noiseMultiple: NOISE_MULTIPLE,
  noiseClip: NOISE_CLIP, backToleranceMs: BACK_TOLERANCE_MS, ghostMs: GHOST_MS, freshGated: false, lvSteps: LV_STEPS,
};

/** What the tracker reads of a `LiveBook` (structural: a `LiveBook` is one). `step` is the grid the server merged the book on (`ValuedBook.step`). */
export interface CueBook { id: string; timestamp: number; coarse: boolean; step?: number; epoch?: number; touch?: { lo: number; hi: number }; bids: SideArrays; asks: SideArrays }
export type CueSide = 'bid' | 'ask';

/**
 * The point levels a cell was made of, flat `[price, usd, price, usd, ...]`: those of the venue's side whose price lies in the cell, in the publication
 * the change is measured from (`prev`) and in the one that raised it (`cur`). The cell's `usd` is the sum of `cur` less the sum of `prev`.
 */
export interface CueLevels { readonly prev: readonly number[]; readonly cur: readonly number[] }

/**
 * One cell of one side of one book that changed between two publications. `lo`..`hi` is the price interval of the cell (a grid bin, or a
 * venue's band); the object is shared with the tracker (`recent`), so a reader never changes it.
 */
export interface CueEvent {
  id: string; side: CueSide; lo: number; hi: number;
  /** The grid step the cell is a bin of (0 for a band). */
  grid: number;
  sign: 1 | -1;
  /** The signed USD change of the cell between the two publications it rests on (since the value before a weak change, once confirmed). */
  usd: number;
  before: number; after: number;
  /** 1 - exp(-|usd| / scale), identical for both signs. */
  strength: number;
  /** `Date.now()` of the publication that raised it, and an increasing id over every event of the tracker. */
  wall: number; seq: number;
  /** The publication that raised it: a number that increases over the tracker's publications (the events of one share it). The page's clock may step back, so `wall` neither orders publications nor tells two apart. */
  pub: number;
  /**
   * `Date.now()` of the publication the change is measured from (of the one before the weak change, once confirmed): a trade that explains it
   * happened in [prevWall, wall].
   */
  prevWall: number;
  /** The cell emptied / the cell was empty. */
  removed: boolean; added: boolean;
  /** A nearby opposite change of about the same size came with it (a re-quote or a row-edge crossing): kept and flagged, never netted away. */
  pair: boolean;
  /** The grid was inferred from the mid (`gridStepFor`), not published by the book. */
  approx: boolean;
  band: boolean;
  /** Raised by a second publication that agreed with a weak first one. */
  confirmed: boolean;
  /**
   * The point levels the cell is made of, in the two publications it rests on (the one before the weak change, once confirmed), so `rowEvents` can
   * place the change on the rows the way the ladder's bars were: a bin's net says nothing of which of two finer rows moved which way. Kept only
   * for a bin that lies wholly within `CueTuning.lvSteps` grid steps of the book's mid, in both publications (where the merge has not widened its
   * buckets). Absent on a band, on a side that has a band level in either publication, on a bin farther than that, and on a confirmed change whose
   * first publication was not kept.
   */
  lv?: CueLevels;
}

/** What a cell holds of the estimates: shares of its displayed USD, each 0 to 1. */
export interface CueHeat {
  /** Estimated recent net increase (cooling with `TAU_FRESH_MS`). */
  fresh: number;
  /** Quantity of unknown provenance: what the first snapshot showed, or what was in the cell when it entered the zone. */
  unknown: number;
  /** Recent change, adds and removes together, against the cell's size: 1 - exp(-A / Q). */
  activity: number;
}

/** What `observe` needs from the caller: the page's clock, the display reference size (about $1M at BTC) and the smallest change worth a cue. */
export interface CueContext { wall: number; scale: number; floorUsd: number }

/**
 * One display row of an event (`rowEvents`): `usd` is the row's own signed change, which is the share of the event's USD that falls in the row, or,
 * for an event that keeps its levels (`CueEvent.lv`), what those levels did in the row (so it can be the opposite sign to the bin's net).
 */
export interface RowEvent { id: string; side: CueSide; row: number; usd: number; strength: number; wall: number; prevWall: number; seq: number; removed: boolean; added: boolean; pair: boolean; band: boolean }

/**
 * Counters: `observations` is books looked at (every book of every frame), `distinct` the publications among them (a book that differs from its
 * last and was compared from), `hints` the frames of a banded book that changed with its stamp unchanged (revalued by the touch hint: no publication).
 */
export interface CueStats { frames: number; observations: number; distinct: number; hints: number; baselines: number; events: number; weakDropped: number; pairs: number; errors: number }

const sizeFor = (len: number): number => { let n = 16; while (n < len) n *= 2; return n; };
/** USD figures and prices the arithmetic can use: finite, and no bigger than something real. */
const MAX_VALUE = 1e15;
const same = (a: number, b: number): boolean => a === b || (a !== a && b !== b);
/** The first `n` elements of `a` (the copy) and `b` (the frame's) are equal, NaN to NaN. */
function equal(a: Float64Array, b: ArrayLike<number>, n: number): boolean {
  for (let i = 0; i < n; i++) { const x = a[i]!, y = b[i]!; if (x !== y && (x === x || y === y)) return false; }
  return true;
}

/** An owned copy of one side's arrays (the frames' own would be pinned for as long as the copy is the comparison). */
class SideCopy {
  lo = new Float64Array(16); hi = new Float64Array(16); usd = new Float64Array(16);
  nLo = 0; nHi = 0; nUsd = 0; sharedHi = false;
  /** How many levels the copy holds (its arrays are larger). */
  get len(): number { return Math.min(this.nLo, this.nHi, this.nUsd); }
  copy(side: SideArrays): void {
    this.nLo = side.lo.length; this.nHi = side.hi.length; this.nUsd = side.usd.length;
    if (this.lo.length < this.nLo) this.lo = new Float64Array(sizeFor(this.nLo));
    if (this.hi.length < this.nHi) this.hi = new Float64Array(sizeFor(this.nHi));
    if (this.usd.length < this.nUsd) this.usd = new Float64Array(sizeFor(this.nUsd));
    this.lo.set(side.lo); this.hi.set(side.hi); this.usd.set(side.usd);
    this.sharedHi = side.hi === side.lo;
  }
  same(side: SideArrays): boolean {
    if (this.nLo !== side.lo.length || this.nHi !== side.hi.length || this.nUsd !== side.usd.length) return false;
    // The sizes first (they change the most), then the prices; NaN equals NaN (a broken book is not a new one every frame).
    if (!equal(this.usd, side.usd, this.nUsd) || !equal(this.lo, side.lo, this.nLo)) return false;
    // A point book sends one array for both edges: it was the same array then, and equal now when the edges are one array again.
    return (this.sharedHi && side.hi === side.lo) || equal(this.hi, side.hi, this.nHi);
  }
}

/** The previous publication of a book, kept to tell a new one from a repeat (`BookCueTracker.observe`). */
class Publication {
  valid = false; stamp = NaN; coarse = false; touchLo = NaN; touchHi = NaN;
  readonly bids = new SideCopy(); readonly asks = new SideCopy();
  matches(book: CueBook): boolean {
    if (!this.valid || !same(this.stamp, book.timestamp) || this.coarse !== book.coarse) return false;
    const lo = book.touch ? book.touch.lo : NaN, hi = book.touch ? book.touch.hi : NaN;
    return same(this.touchLo, lo) && same(this.touchHi, hi) && this.bids.same(book.bids) && this.asks.same(book.asks);
  }
  store(book: CueBook): void {
    this.valid = true; this.stamp = book.timestamp; this.coarse = book.coarse;
    this.touchLo = book.touch ? book.touch.lo : NaN; this.touchHi = book.touch ? book.touch.hi : NaN;
    this.bids.copy(book.bids); this.asks.copy(book.asks);
  }
}

type Typed = Float64Array | Uint8Array | Int8Array;

/** Slide the references of a window `d` cells towards its start (a negative `d`: towards its end), leaving null where the window has nothing. */
function shiftRefs<T>(arr: (T | null)[], d: number): void {
  const n = arr.length;
  if (d > 0) { for (let i = 0; i < n - d; i++) arr[i] = arr[i + d]!; for (let i = n - d; i < n; i++) arr[i] = null; }
  else { for (let i = n - 1; i >= -d; i--) arr[i] = arr[i + d]!; for (let i = 0; i < -d; i++) arr[i] = null; }
}

/** Make `ev` the newest of the `CUE_HISTORY` events kept in `h` from `at` (newest first): the oldest of them goes. No allocation. */
function remember(h: (CueEvent | null)[], at: number, ev: CueEvent): void {
  for (let k = CUE_HISTORY - 1; k > 0; k--) h[at + k] = h[at + k - 1]!;
  h[at] = ev;
}

/** One side of a point book on its grid: the cells of a window of `n` bins that follows the mid, and the estimates kept per cell. */
class Fine {
  base = 0; placed = false;
  readonly q: Float64Array; readonly m: Float64Array; readonly u: Float64Array; readonly a: Float64Array; readonly pre: Float64Array; readonly preWall: Float64Array;
  /** 1 where the cell held a comparable value at the last publication (inside the zone and the book's reach). */
  readonly known: Uint8Array;
  /** The sign of a weak change waiting for the next publication to agree, and the value before it. */
  readonly pend: Int8Array;
  /** The last `CUE_HISTORY` events of each cell, newest first: the cell's slots start at `cell * CUE_HISTORY`. */
  readonly hist: (CueEvent | null)[];
  /** The levels of the publication the value before a waiting weak change was in (`pre`), flat `[price, usd, ...]`: set only while a change waits, and only when they could be listed. */
  readonly preLv: (number[] | null)[];
  /** Whether the side of the last publication had a band level (a share of a bin, not a price): the levels behind its cells cannot be listed. */
  hadBand = false;
  /** Which way the prices of the side of the last publication ran (1 rising, -1 falling, 0 neither): whether its levels can be found by a search. */
  dir = 0;
  noise = 0; noiseWall = 0;
  readonly n: number;
  constructor(n: number) {
    this.n = n;
    this.q = new Float64Array(n); this.m = new Float64Array(n); this.u = new Float64Array(n); this.a = new Float64Array(n); this.pre = new Float64Array(n); this.preWall = new Float64Array(n);
    this.known = new Uint8Array(n); this.pend = new Int8Array(n); this.hist = new Array<CueEvent | null>(n * CUE_HISTORY).fill(null); this.preLv = new Array<number[] | null>(n).fill(null);
  }
  /** Keep `ev` as the newest event of cell `i`: the oldest of its `CUE_HISTORY` goes. */
  remember(i: number, ev: CueEvent): void { remember(this.hist, i * CUE_HISTORY, ev); }
  /** Every cell unknown again; how many weak changes that dropped. */
  wipe(): number {
    let dropped = 0;
    for (let i = 0; i < this.n; i++) if (this.pend[i] !== 0) dropped++;
    this.q.fill(0); this.m.fill(0); this.u.fill(0); this.a.fill(0); this.pre.fill(0); this.preWall.fill(0); this.known.fill(0); this.pend.fill(0); this.hist.fill(null); this.preLv.fill(null);
    this.placed = false; this.hadBand = false; this.dir = 0;
    return dropped;
  }
  /** One cell no longer comparable (outside the zone or the reach); true when it dropped a weak change. */
  drop(i: number): boolean {
    const was = this.pend[i] !== 0;
    this.known[i] = 0; this.q[i] = 0; this.m[i] = 0; this.u[i] = 0; this.a[i] = 0; this.pend[i] = 0; this.preLv[i] = null;
    return was;
  }
  /** Move the window so it starts at `base`, keeping the cells both windows hold. */
  rebase(base: number): void {
    if (!this.placed) { this.base = base; this.placed = true; return; }
    const d = base - this.base, n = this.n;
    if (d === 0) return;
    if (Math.abs(d) >= n) { this.wipe(); this.base = base; this.placed = true; return; }
    const move = (arr: Typed): void => { if (d > 0) { arr.copyWithin(0, d, n); arr.fill(0, n - d, n); } else { arr.copyWithin(-d, 0, n + d); arr.fill(0, 0, -d); } };
    move(this.q); move(this.m); move(this.u); move(this.a); move(this.pre); move(this.preWall); move(this.known); move(this.pend);
    shiftRefs(this.hist, d * CUE_HISTORY); shiftRefs(this.preLv, d);
    this.base = base;
  }
}

/** One band of a banded book; `hist` is its last `CUE_HISTORY` events, newest first. */
interface Cell { lo: number; hi: number; q: number; m: number; u: number; a: number; pend: number; pre: number; preWall: number; zero: number; hist: (CueEvent | null)[] }
/** The history of a band that has none yet. */
const newHistory = (): (CueEvent | null)[] => new Array<CueEvent | null>(CUE_HISTORY).fill(null);
/** One side of a banded book: its bands by edges, the price range its book reached, and the noise. */
class Bands {
  readonly cells = new Map<string, Cell>();
  reachLo = NaN; reachHi = NaN;
  noise = 0; noiseWall = 0;
  /** Every band forgotten; how many weak changes that dropped. */
  wipe(): number {
    let dropped = 0;
    for (const c of this.cells.values()) if (c.pend !== 0) dropped++;
    this.cells.clear(); this.reachLo = NaN; this.reachHi = NaN;
    return dropped;
  }
}

interface Book {
  id: string;
  /** The wall time it was last asked for and present. */
  seen: number;
  /** The number of the last frame it was in, asked for or not. */
  frame: number;
  pub: Publication;
  /** Whether the last publication could be compared from (a usable mid, or bands). */
  usable: boolean;
  mode: 'point' | 'band' | null;
  grid: number; approx: boolean;
  lastWall: number; lastStamp: number; cadence: number; observations: number;
  zoneLo: number; zoneHi: number;
  /** The mid of the last publication compared from, in grid steps (NaN when there is none): where the levels of that publication were merged around. */
  midSteps: number;
  fine: [Fine, Fine] | null;
  bands: [Bands, Bands] | null;
  touchLo: number; touchHi: number;
  /** What the book covered when its baseline began (`ValuedBook.epoch`, 0 for a book that is whole as it comes). */
  epoch: number;
}

/** What `judge` decided about one cell: the kind, the value before the change, and the change. Module scratch: no allocation per cell. */
const verdict = { kind: 0, before: 0, usd: 0 };
const NONE = 0, LARGE = 1, CONFIRMED = 2, WEAK = 3;

/**
 * One cell's change against the gate. `pend` is the sign of a weak change waiting (0: none) and `pre` the value before it. A waiting change
 * is raised, with the change since that value, when the cell still moved that way by at least the gate. Otherwise it is dropped (`dropped`
 * set) and the cell is judged from `pre`, the last value nobody was shown a change from: a quote that came back (+$100k, then -$100k) is
 * no change, where judging the second step alone would have raised a decrease from a value the reader never saw. A change of `confirmRatio`
 * gates or more is raised at once, a weaker one waits.
 */
function judge(gate: number, qp: number, qn: number, pend: number, pre: number, confirmRatio: number): boolean {
  verdict.kind = NONE; let dropped = false, from = qp;
  if (!(gate > 0)) return false;
  if (pend !== 0) {
    const since = qn - pre;
    if (Math.sign(since) === pend && Math.abs(since) >= gate) { verdict.kind = CONFIRMED; verdict.before = pre; verdict.usd = since; return false; }
    dropped = true; from = pre;
  }
  const d = qn - from, ad = d < 0 ? -d : d;
  if (ad >= gate) { verdict.kind = ad >= confirmRatio * gate ? LARGE : WEAK; verdict.before = from; verdict.usd = d; }
  return dropped;
}

/**
 * The estimates after a change from `qp` to `qn`: the recent increase and the activity cool by the factors `fresh` and `active` (of the time since the
 * last publication), the recent increase takes the gain (when `gain`: see `CueTuning.freshGated`) or its share of the loss, the unknown share its share of the loss.
 */
const est = { m: 0, u: 0, a: 0 };
function advance(m: number, u: number, a: number, qp: number, qn: number, fresh: number, active: number, gain: boolean): void {
  const d = qn - qp;
  m *= fresh; a *= active;
  if (d > 0) { if (gain) m += d; } else if (d < 0) { const keep = qp > 0 ? qn / qp : 0; m *= keep; u *= keep; }
  a += d < 0 ? -d : d;
  if (m > qn) m = qn;
  if (u > qn - m) u = qn - m > 0 ? qn - m : 0;
  est.m = m; est.u = u; est.a = a;
}

const overlaps = (lo: number, hi: number, spanLo: number, spanHi: number): boolean => spanLo === spanLo && hi > spanLo && lo < spanHi;
/** Whether two bands cover some of the same prices (a band of no width covers its one price). */
function sharePrices(alo: number, ahi: number, blo: number, bhi: number): boolean {
  if (ahi > alo && bhi > blo) return ahi > blo && alo < bhi;
  if (ahi > alo) return blo >= alo && blo < ahi;
  if (bhi > blo) return alo >= blo && alo < bhi;
  return alo === blo;
}

/**
 * What `#fineSide` reads of one side of the publication: the frame's arrays and how many levels of them count, whether any level is a band, which way
 * the prices run (`dir`: 1 rising, -1 falling, 0 neither), the previous publication's copy, and the mid of this publication and of the previous one in
 * grid steps (where each was merged around).
 */
interface SideNow { arrays: SideArrays; len: number; bands: number; dir: number; prev: SideCopy; mid: number; prevMid: number }
/** The levels a cell needs listed: those of the previous publication (`LV_PREV`), those of this one (`LV_CUR`). */
const LV_PREV = 1, LV_CUR = 2;

/** The first index of `lo[0, len)` whose price is at or past `p` in the order the prices run: `dir` 1 (rising) the first at or above it, -1 (falling) the first below it. */
function firstFrom(lo: Float64Array, len: number, dir: number, p: number): number {
  let a = 0, b = len;
  while (a < b) { const m = (a + b) >>> 1; if (dir === 1 ? lo[m]! >= p : lo[m]! < p) b = m; else a = m + 1; }
  return a;
}

/**
 * Append `[price, usd]` of every usable level of one side that lies in a flagged bin (`mask` set in `flags`) to that bin's list in `into`: bins on the
 * grid `g`, the window starting at bin `base`, the flagged ones in `cells`. A side whose prices run one way (`dir`) is searched for each bin, which costs
 * the levels in it and a few steps, however long the book; any other is passed over in full, and levels outside the price span [wLo, wHi) of the
 * flagged bins on two comparisons. Levels are filtered and binned as `#scan` does, and listed in the order of the array.
 */
function listLevels(lo: Float64Array, hi: Float64Array, usd: Float64Array, len: number, dir: number, g: number, base: number, n: number, cells: readonly number[], flags: Uint8Array, mask: number,
  into: (number[] | null)[], wLo: number, wHi: number): void {
  if (dir === 0) {
    for (let j = 0; j < len; j++) {
      const p = lo[j]!;
      if (p < wLo || p >= wHi) continue;
      const h = hi[j]!, u = usd[j]!;
      if (!(u > 0 && u < MAX_VALUE && p > 0 && h >= p && h < MAX_VALUE)) continue;
      const k = binOf(p, g) - base;
      if (k < 0 || k >= n || (flags[k]! & mask) === 0) continue;
      into[k]!.push(p, u);
    }
    return;
  }
  for (let c = 0; c < cells.length; c++) {
    const i = cells[c]!;
    if ((flags[i]! & mask) === 0) continue;
    // The bin's prices, with a sliver of margin for `binOf`'s own (a price on the edge may be counted in the bin below).
    const pLo = (base + i) * g - g * 1e-6, pHi = (base + i + 1) * g + g * 1e-6, list = into[i]!;
    for (let j = firstFrom(lo, len, dir, dir === 1 ? pLo : pHi); j < len; j++) {
      const p = lo[j]!;
      if (dir === 1 ? p >= pHi : p < pLo) break;
      const h = hi[j]!, u = usd[j]!;
      if (!(u > 0 && u < MAX_VALUE && p > 0 && h >= p && h < MAX_VALUE) || binOf(p, g) - base !== i) continue;
      list.push(p, u);
    }
  }
}

/**
 * The tracker of a set of books (one per instrument id). `observe` takes every levels frame the page gets; a book that did not change
 * since its last publication costs one comparison and nothing else.
 */
export class BookCueTracker {
  readonly stats: CueStats = { frames: 0, observations: 0, distinct: 0, hints: 0, baselines: 0, events: 0, weakDropped: 0, pairs: 0, errors: 0 };
  readonly #t: CueTuning;
  readonly #n: number;
  readonly #books = new Map<string, Book>();
  readonly #want = new Set<string>();
  readonly #done = new Set<string>();
  /** The number of the frame being read: a book in it, asked for or not, is stamped with it (`Book.frame`). */
  #frame = 0;
  readonly #sq: Float64Array; readonly #sa: Float64Array;
  #seq = 0;
  /** The number of the publication being read (`CueEvent.pub`). */
  #pub = 0;
  #bins: number[] = [];
  /** What `#scan` found: the usable levels of a side, its best price and its reach, how many of them are bands, and which way its prices run. */
  readonly #sc = { valid: 0, best: 0, reach: 0, bands: 0, dir: 0 };
  /** The side `#fineSide` is reading (refilled for each side, never allocated). */
  readonly #now: SideNow = { arrays: { lo: new Float64Array(0), hi: new Float64Array(0), usd: new Float64Array(0) }, len: 0, bands: 0, dir: 0, prev: new SideCopy(), mid: NaN, prevMid: NaN };
  /** The cells of the side being read whose levels are being listed: what is wanted of each, and the lists (by window cell, each null unless wanted). */
  readonly #lvFlag: Uint8Array;
  readonly #lvPrev: (number[] | null)[]; readonly #lvCur: (number[] | null)[];
  readonly #lvCells: number[] = [];

  constructor(tuning: Partial<CueTuning> = {}) {
    this.#t = { ...DEFAULT_TUNING, ...tuning };
    // The window holds the zone (2 x zoneSteps bins) and PAD spare cells each side, which is 518 bins at the default.
    this.#n = 2 * Math.ceil(this.#t.zoneSteps) + 2 * PAD + 4;
    this.#sq = new Float64Array(this.#n); this.#sa = new Float64Array(this.#n);
    this.#lvFlag = new Uint8Array(this.#n); this.#lvPrev = new Array<number[] | null>(this.#n).fill(null); this.#lvCur = new Array<number[] | null>(this.#n).fill(null);
  }

  /** Forget everything (a reconnect, a replay, another coin): the next publication of every book is a baseline. */
  reset(): void { this.#books.clear(); this.#done.clear(); }

  /**
   * How many cells the state holds in all, and the references to events they can keep for the hover (`slots`: `CUE_HISTORY` a cell): constant once the
   * books are warm, however many publications there are (the tests pin it).
   */
  size(): { books: number; bins: number; bands: number; slots: number } {
    let bins = 0, bands = 0;
    for (const b of this.#books.values()) { if (b.fine) bins += 2 * this.#n; if (b.bands) bands += b.bands[0].cells.size + b.bands[1].cells.size; }
    return { books: this.#books.size, bins, bands, slots: (bins + bands) * CUE_HISTORY };
  }

  /**
   * One levels frame: every book of `ids` that is in it. Returns the events this frame raised (ordered by the books' order in the frame, bids
   * before asks, price ascending; `seq` increases along it). A book unchanged since its last publication raises nothing, confirms nothing
   * and costs one comparison. A book that is not in the frame has left the feed (a venue reconnecting does not change the page's own connection
   * state, and a reader's `ids` are made from the frame, so a book that vanishes from the frame vanishes from `ids` with it): what it publishes
   * next is a baseline, whether or not its id is in `ids`. A book that is in the frame and not in `ids` (the reader hid it) is kept as it was, and
   * judged by the gap rule when it returns. A book is forgotten once it has been out of `ids` or the frames for `forgetMs`.
   */
  observe(books: readonly CueBook[], ids: readonly string[], ctx: CueContext): CueEvent[] {
    const out: CueEvent[] = [];
    this.stats.frames++;
    const wall = ctx.wall;
    if (!Number.isFinite(wall)) return out;
    this.#want.clear(); for (const id of ids) this.#want.add(id);
    const frame = ++this.#frame;
    for (const book of books) {
      if (!book) continue;
      let st = this.#books.get(book.id);
      // A book whose coverage changed (seeded again, or more of it became visible) starts over as on first sight: its new levels are not
      // liquidity placed, nor its withdrawn ones liquidity pulled.
      if (st && st.epoch !== (book.epoch ?? 0)) { this.#books.delete(book.id); st = undefined; }
      if (st) st.frame = frame;
      if (!this.#want.has(book.id) || this.#done.has(book.id)) continue;
      this.#done.add(book.id);
      this.stats.observations++;
      if (!st) {
        st = { id: book.id, seen: wall, frame, pub: new Publication(), usable: false, mode: null, grid: 0, approx: false, lastWall: wall, lastStamp: NaN, cadence: 0, observations: 0,
          zoneLo: NaN, zoneHi: NaN, midSteps: NaN, fine: null, bands: null, touchLo: NaN, touchHi: NaN, epoch: book.epoch ?? 0 };
        this.#books.set(book.id, st);
      }
      st.seen = wall;
      try {
        if (st.pub.matches(book)) continue;
        this.#publish(st, book, ctx, out);
      } catch {
        // A frame the tracker cannot read is a frame it does not compare from: the next one starts again.
        this.stats.errors++; st.usable = false; st.pub.valid = false;
      }
    }
    for (const st of this.#books.values()) {
      // A book that is not in the frame is gone from the feed (a reconnect of the venue, which the page's own connection state does not show): what it
      // publishes next is a baseline. It does not matter whether its id is asked for: a reader that builds `ids` from the frame drops it from both.
      if (st.frame !== frame && (st.usable || st.pub.valid)) { st.usable = false; st.pub.valid = false; this.#invalidate(st); }
      if (!this.#done.has(st.id) && wall - st.seen > this.#t.forgetMs) this.#books.delete(st.id);
    }
    this.#done.clear();
    return out;
  }

  /** What the tracker knows of a book: its grid, the price span it compares, when it last published and how often, or null for a book it does not hold. */
  info(id: string): { grid: number; approx: boolean; zone: { lo: number; hi: number }; lastWall: number; cadenceMs: number; observations: number; usable: boolean } | null {
    const st = this.#books.get(id);
    if (!st || st.observations === 0) return null;
    return { grid: st.grid, approx: st.approx, zone: { lo: st.zoneLo, hi: st.zoneHi }, lastWall: st.lastWall, cadenceMs: st.cadence, observations: st.observations, usable: st.usable };
  }

  /**
   * The estimates of the cells of `id` on one side whose centre lies in [lo, hi) (a cell finer than the grid takes the bin it lies in; a band counts
   * for the share of it the interval covers), weighted by their USD, cooled to `wall`. Null where the book is not held, was not usable, or no
   * cell of the interval is comparable (outside the zone or the reach).
   */
  heat(id: string, side: CueSide, lo: number, hi: number, wall: number): CueHeat | null {
    const st = this.#books.get(id);
    if (!st || !st.usable || !(hi > lo)) return null;
    const dt = Math.max(0, wall - st.lastWall), fresh = Math.exp(-dt / this.#t.tauFreshMs), active = Math.exp(-dt / this.#t.tauActivityMs);
    let q = 0, m = 0, u = 0, a = 0, any = false;
    if (st.mode === 'point' && st.fine && st.grid > 0) {
      const s = st.fine[side === 'bid' ? 0 : 1], g = st.grid;
      let b0: number, b1: number;
      if (hi - lo < g) { b0 = b1 = binOf((lo + hi) / 2, g); }
      else { b0 = Math.ceil(lo / g - 0.5); b1 = Math.ceil(hi / g - 0.5) - 1; }
      for (let b = Math.max(b0, s.base); b <= Math.min(b1, s.base + s.n - 1); b++) {
        const i = b - s.base;
        if (!s.known[i]) continue;
        any = true; q += s.q[i]!; m += s.m[i]! * fresh; u += s.u[i]!; a += s.a[i]! * active;
      }
    } else if (st.mode === 'band' && st.bands) {
      for (const c of st.bands[side === 'bid' ? 0 : 1].cells.values()) {
        if (!(c.hi > lo && c.lo < hi)) continue;
        const w = c.hi > c.lo ? (Math.min(hi, c.hi) - Math.max(lo, c.lo)) / (c.hi - c.lo) : 1;
        any = true; q += c.q * w; m += c.m * w * fresh; u += c.u * w; a += c.a * w * active;
      }
    }
    if (!any) return null;
    if (!(q > 0)) return { fresh: 0, unknown: 0, activity: 0 };
    return { fresh: Math.min(1, m / q), unknown: Math.min(1, u / q), activity: 1 - Math.exp(-a / q) };
  }

  /** The newest event of `id` on one side that overlaps [lo, hi), or null (the hover's "last change"). */
  recent(id: string, side: CueSide, lo: number, hi: number): CueEvent | null {
    const st = this.#books.get(id);
    if (!st || !(hi > lo)) return null;
    let best: CueEvent | null = null;
    const take = (e: CueEvent | null): void => { if (e && e.hi > lo && e.lo < hi && (!best || e.seq > best.seq)) best = e; };
    if (st.mode === 'point' && st.fine && st.grid > 0) {
      const s = st.fine[side === 'bid' ? 0 : 1], g = st.grid;
      for (let b = Math.max(binOf(lo, g), s.base); b <= Math.min(binOf(hi, g), s.base + s.n - 1); b++) take(s.hist[(b - s.base) * CUE_HISTORY]!);
    } else if (st.mode === 'band' && st.bands) {
      for (const c of st.bands[side === 'bid' ? 0 : 1].cells.values()) take(c.hist[0]!);
    }
    return best;
  }

  /**
   * The events kept for [lo, hi) on one side, those of the newest `CUE_HISTORY` publications (by the order they were made in) that touched it: newest publication first, the
   * events of one publication together, price ascending in it. A newer event of a bin need not have touched every display row the bin holds (with levels
   * it moves one row and not the next), so a reader tries each publication from the newest (`rowEventAt` over its events, or `rowEvents` for the figure
   * a row was lit with) until a row has a change. `recent` is the single newest. Empty when nothing overlaps.
   */
  recentEvents(id: string, side: CueSide, lo: number, hi: number): CueEvent[] {
    const st = this.#books.get(id), found: CueEvent[] = [];
    if (!st || !(hi > lo)) return found;
    const take = (e: CueEvent | null): void => { if (e && e.hi > lo && e.lo < hi) found.push(e); };
    if (st.mode === 'point' && st.fine && st.grid > 0) {
      const s = st.fine[side === 'bid' ? 0 : 1], from = Math.max(binOf(lo, st.grid), s.base), to = Math.min(binOf(hi, st.grid), s.base + s.n - 1);
      for (let b = from; b <= to; b++) for (let k = 0; k < CUE_HISTORY; k++) take(s.hist[(b - s.base) * CUE_HISTORY + k]!);
    } else if (st.mode === 'band' && st.bands) {
      for (const c of st.bands[side === 'bid' ? 0 : 1].cells.values()) for (const e of c.hist) take(e);
    }
    // One publication's events share its number, and publications go by it (the order they were made in), not by the page's clock: the clock may step back a little (inside `backToleranceMs`) and a wall may come round again.
    const groups = new Map<number, CueEvent[]>();
    for (const e of found) { let g = groups.get(e.pub); if (!g) { g = []; groups.set(e.pub, g); } g.push(e); }
    const out: CueEvent[] = [];
    for (const pub of [...groups.keys()].sort((a, b) => b - a).slice(0, CUE_HISTORY)) { const g = groups.get(pub)!; g.sort((a, b) => a.lo - b.lo || a.seq - b.seq); out.push(...g); }
    return out;
  }

  /** One publication of a book that differs from its last: the time rules, then the comparison by the book's kind. */
  #publish(st: Book, book: CueBook, ctx: CueContext, out: CueEvent[]): void {
    const t = this.#t, wall = ctx.wall, mode = book.coarse ? 'band' : 'point';
    // A banded book whose stamp did not move was revalued by the touch hint (the cut inside its top groups follows the trades), not published
    // again (Hyperliquid: about three of these to each real refresh in the live check): it says nothing new of its bands, so it neither confirms
    // nor drops a waiting change and is no step of its rhythm. What it holds is kept, so it is not looked at again.
    if (mode === 'band' && st.mode === 'band' && st.usable && Number.isFinite(book.timestamp) && book.timestamp === st.lastStamp) { this.stats.hints++; st.pub.store(book); return; }
    this.stats.distinct++; this.#pub++;
    let baseline = !st.usable || st.mode !== mode;
    let dt = 0;
    if (st.observations > 0) {
      dt = wall - st.lastWall;
      const limit = Math.max(t.minGapMs, t.gapCadences * st.cadence);
      const gap = dt > limit, clockBack = dt < -t.backToleranceMs;
      const stamped = Number.isFinite(book.timestamp) && Number.isFinite(st.lastStamp), back = stamped && book.timestamp < st.lastStamp - t.backToleranceMs;
      if (gap || clockBack || back) baseline = true;
      if (dt > 0) {
        // The book's own rhythm: an outage moves it a quarter of the way at most, so one silence does not teach a minute's gap.
        const target = Math.min(dt, CADENCE_CAP_MS);
        st.cadence = st.cadence > 0 ? st.cadence + (gap ? 0.25 : 0.2) * (target - st.cadence) : target;
      }
      if (dt < 0) dt = 0;
    }
    let usable: boolean;
    if (mode === 'point') usable = this.#point(st, book, ctx, baseline, dt, out);
    else usable = this.#band(st, book, ctx, baseline, dt, out);
    st.usable = usable; st.mode = mode;
    if (!usable) this.#invalidate(st);
    st.pub.store(book);
    st.lastWall = wall; st.lastStamp = Number.isFinite(book.timestamp) ? book.timestamp : NaN; st.observations++;
  }

  /** The book cannot be compared from: every cell unknown, so the next usable publication is a baseline. */
  #invalidate(st: Book): void {
    if (st.fine) for (const s of st.fine) this.stats.weakDropped += s.wipe();
    if (st.bands) for (const s of st.bands) this.stats.weakDropped += s.wipe();
    st.zoneLo = NaN; st.zoneHi = NaN; st.midSteps = NaN;
  }

  /** A point book: its levels binned on the merge grid inside the zone, each side compared cell by cell where both publications cover it. */
  #point(st: Book, book: CueBook, ctx: CueContext, baseline: boolean, dt: number, out: CueEvent[]): boolean {
    const t = this.#t, n = this.#n, bids = book.bids, asks = book.asks, sq = this.#sq, sa = this.#sa, sc = this.#sc;
    const nb = Math.min(bids.lo.length, bids.hi.length, bids.usd.length), na = Math.min(asks.lo.length, asks.hi.length, asks.usd.length);
    const published = book.step !== undefined && Number.isFinite(book.step) && book.step > 0;
    // One pass over each side finds the best price and the reach and, when the book has its window and grid already (nearly always), bins the
    // levels into it at the same time; a book that needs another window or grid is binned again below.
    const held = st.fine, spec = !baseline && held !== null && held[0].placed && st.grid > 0 && (!published || book.step === st.grid);
    const gSpec = spec ? st.grid : 0, baseSpec = spec ? held![0].base : 0;
    if (spec) { sq.fill(0); sa.fill(0); }
    this.#scan(bids, nb, true, gSpec, baseSpec, sq);
    const vb = sc.valid, bestBid = sc.best, bidLo = sc.reach, bandsB = sc.bands, dirB = sc.dir;
    this.#scan(asks, na, false, gSpec, baseSpec, sa);
    const va = sc.valid, bestAsk = sc.best, askHi = sc.reach, bandsA = sc.bands, dirA = sc.dir;
    if (!vb || !va || !(bestBid <= bestAsk)) return false;
    const mid = (bestBid + bestAsk) / 2;
    const g = published ? book.step! : gridStepFor(mid);
    if (!(g > 0) || !Number.isFinite(g)) return false;
    if (st.grid > 0 && Math.abs(g - st.grid) > st.grid * 1e-9) baseline = true;
    const m = mid / g, z0 = Math.ceil(m - t.zoneSteps), z1 = Math.floor(m + t.zoneSteps) - 1;
    if (!(z1 >= z0) || z1 - z0 + 1 > n - 2 * PAD) return false;
    if (baseline) this.stats.baselines++;
    st.grid = g; st.approx = !published; st.zoneLo = z0 * g; st.zoneHi = (z1 + 1) * g;
    const prevMid = st.midSteps; st.midSteps = m;
    const fine = st.fine ??= [new Fine(n), new Fine(n)];
    const binned = spec && g === gSpec && z0 >= baseSpec && z1 < baseSpec + n;
    for (const s of fine) {
      if (baseline) this.stats.weakDropped += s.wipe();
      if (!s.placed || z0 < s.base || z1 >= s.base + n) s.rebase(z0 - PAD);
    }
    if (!binned) { sq.fill(0); sa.fill(0); this.#bin(bids, nb, g, fine[0].base, sq); this.#bin(asks, na, g, fine[1].base, sa); }
    // What each side covers, in grid bins: bids from just above the bin holding the lowest bid level (that bin may be cut) up to the best ask's
    // bin (a bid cannot rest higher, and the spread is known empty); asks from the best bid's bin to just below the bin holding the highest ask.
    const bidFrom = binOf(bidLo, g) + 1, bidTo = binOf(bestAsk, g), askFrom = binOf(bestBid, g), askTo = binOf(askHi, g) - 1;
    // The previous publication is still the one `st.pub` holds (it is stored once this returns), which is where the levels behind a cell's old value are.
    const now = this.#now;
    now.mid = m; now.prevMid = prevMid;
    now.arrays = bids; now.len = nb; now.bands = bandsB; now.dir = dirB; now.prev = st.pub.bids;
    this.#fineSide(st, fine[0], sq, Math.max(bidFrom, z0), Math.min(bidTo, z1), 'bid', ctx, baseline, dt, out, now);
    now.arrays = asks; now.len = na; now.bands = bandsA; now.dir = dirA; now.prev = st.pub.asks;
    this.#fineSide(st, fine[1], sa, Math.max(askFrom, z0), Math.min(askTo, z1), 'ask', ctx, baseline, dt, out, now);
    return true;
  }

  /**
   * One pass over one side: how many of its levels are usable and how many of those are bands, the best price (a bid's upper edge, an ask's lower)
   * and the price it reaches to (the lowest bid, the highest ask edge), which way its prices run (all of them, usable or not: rising, falling, or
   * neither, which a search by price needs), into `this.#sc`; and, when `g` > 0, the levels binned into `dst` on that grid from `base`.
   */
  #scan(side: SideArrays, len: number, bid: boolean, g: number, base: number, dst: Float64Array): void {
    const n = this.#n, slo = side.lo, shi = side.hi, susd = side.usd, sc = this.#sc;
    let valid = 0, bands = 0, best = bid ? -Infinity : Infinity, reach = bid ? Infinity : -Infinity, up = true, down = true, before = NaN;
    for (let i = 0; i < len; i++) {
      const lo = slo[i]!, hi = shi[i]!, usd = susd[i]!;
      if (i > 0) { if (!(lo >= before)) up = false; if (!(lo <= before)) down = false; }
      before = lo;
      if (!(usd > 0 && usd < MAX_VALUE && lo > 0 && hi >= lo && hi < MAX_VALUE)) continue;
      valid++;
      if (bid) { if (hi > best) best = hi; if (lo < reach) reach = lo; } else { if (lo < best) best = lo; if (hi > reach) reach = hi; }
      if (hi > lo) bands++;
      if (g > 0) {
        if (hi > lo) this.#spread(lo, hi, usd, g, base, dst);
        else { const k = binOf(lo, g) - base; if (k >= 0 && k < n) dst[k]! += usd; }
      }
    }
    sc.valid = valid; sc.bands = bands; sc.best = best; sc.reach = reach; sc.dir = up ? 1 : down ? -1 : 0;
  }

  /** Add the levels of one side into `dst`, a window of bins starting at `base`; a level that is a band is shared over the bins it covers. */
  #bin(side: SideArrays, len: number, g: number, base: number, dst: Float64Array): void {
    const n = this.#n, slo = side.lo, shi = side.hi, susd = side.usd;
    for (let i = 0; i < len; i++) {
      const lo = slo[i]!, hi = shi[i]!, usd = susd[i]!;
      if (!(usd > 0 && usd < MAX_VALUE && lo > 0 && hi >= lo && hi < MAX_VALUE)) continue;
      if (hi > lo) this.#spread(lo, hi, usd, g, base, dst);
      else { const k = binOf(lo, g) - base; if (k >= 0 && k < n) dst[k]! += usd; }
    }
  }

  /** A level that is a band of prices: its USD shared over the grid bins it covers in proportion to the overlap. */
  #spread(lo: number, hi: number, usd: number, g: number, base: number, dst: Float64Array): void {
    const b0 = binOf(lo, g), width = hi - lo;
    let b1 = binOf(hi, g);
    if (b1 > b0 && b1 * g >= hi * (1 - 1e-12)) b1--;
    for (let b = Math.max(b0, base); b <= Math.min(b1, base + this.#n - 1); b++) {
      const share = (Math.min(hi, (b + 1) * g) - Math.max(lo, b * g)) / width;
      if (share > 0) dst[b - base]! += usd * share;
    }
  }

  /** One side of a point book: the cells in [from, to] (absolute bins, inside the zone and the reach) are compared, the rest become unknown. */
  #fineSide(st: Book, s: Fine, sq: Float64Array, from: number, to: number, side: CueSide, ctx: CueContext, baseline: boolean, dt: number, out: CueEvent[], now: SideNow): void {
    const t = this.#t, n = this.#n, wall = ctx.wall, g = st.grid;
    // The levels behind a cell can be listed when this side has no band level now (a band is shared over bins: its share is no price a row can be
    // told by) and, for the previous publication's, had none then.
    const prevBand = s.hadBand, prevDir = s.dir; s.hadBand = now.bands > 0; s.dir = now.dir;
    const lvNow = now.bands === 0, lvPrev = lvNow && !prevBand;
    // And only for a bin that lies wholly within `lvSteps` grid steps of the book's mid in the publication that holds the levels, [mid - lvSteps, mid +
    // lvSteps - 1] in bins: farther, the merge's buckets are wider and a bucket's price hops with its members. Far bins are told apart here, before
    // anything is listed or searched for.
    const reach = t.lvSteps, nearLo = now.mid - reach, nearHi = now.mid + reach - 1, backLo = now.prevMid - reach, backHi = now.prevMid + reach - 1;
    const fl = this.#lvFlag, lp = this.#lvPrev, lc = this.#lvCur, cells = this.#lvCells; cells.length = 0;
    const iLo = from - s.base, iHi = to - s.base;
    const has = iHi >= iLo, known = s.known, pend = s.pend;
    // Cells outside the range become unknown; a cell that already is has nothing to clear (known and waiting are the only things set on one).
    for (let i = 0; i < n; i++) if ((known[i]! | pend[i]!) !== 0 && (!has || i < iLo || i > iHi)) { if (s.drop(i)) this.stats.weakDropped++; }
    if (!has) return;
    let sum = 0, cnt = 0;
    for (let i = iLo; i <= iHi; i++) { const v = sq[i]!; if (v > 0) { sum += v; cnt++; } }
    const floor = Number.isFinite(ctx.floorUsd) ? ctx.floorUsd : 0, share = t.meanShare * (cnt ? sum / cnt : 0);
    const gate = Math.max(floor, share, t.noiseMultiple * s.noise);
    const fresh = Math.exp(-dt / t.tauFreshMs), active = Math.exp(-dt / t.tauActivityMs);
    // A change counts at most `noiseClip` noises towards the noise; before there is any (the first comparison), against the gate's share term, so
    // one large first change does not become the book's noise (on a banded book's fifteen cells it would hold the gate up for a minute).
    const base = Math.max(s.noise, share), cap = base > 0 ? t.noiseClip * base : Infinity;
    let nSum = 0, nCnt = 0;
    const first = out.length, bins = this.#bins; bins.length = 0;
    for (let i = iLo; i <= iHi; i++) {
      const qn = sq[i]!;
      if (!baseline && known[i]) {
        const qp = s.q[i]!, d = qn - qp, ad = d < 0 ? -d : d;
        // Nothing changed and nothing waits (nearly every cell, nearly every time): the estimates only cool.
        if (d === 0 && pend[i] === 0) { s.m[i]! *= fresh; s.a[i]! *= active; if (qn > 0) nCnt++; continue; }
        advance(s.m[i]!, s.u[i]!, s.a[i]!, qp, qn, fresh, active, !t.freshGated || d >= gate);
        s.m[i] = est.m; s.u[i] = est.u; s.a[i] = est.a;
        if (qp > 0 || qn > 0) { nSum += ad < cap ? ad : cap; nCnt++; }
        // A change measured from the value before a weak one rests on the publication that value was in, and on the levels it listed then.
        const waiting = s.pend[i] !== 0, prevWall = waiting ? s.preWall[i]! : st.lastWall, bin = s.base + i;
        const dropped = judge(gate, qp, qn, s.pend[i]!, s.pre[i]!, t.confirmRatio);
        if (dropped) this.stats.weakDropped++;
        s.pend[i] = 0;
        if (verdict.kind === WEAK) {
          s.pend[i] = verdict.usd > 0 ? 1 : -1; s.pre[i] = verdict.before; s.preWall[i] = prevWall;
          // The levels of the publication before the change wait on the cell for the one that confirms it (a change that waits already has them). They
          // are the previous publication's alone, whatever this one holds: the event measures from them to the confirming publication's. A bin that
          // was not near the mid then keeps none.
          if (!waiting && !prevBand && bin >= backLo && bin <= backHi) { fl[i] = LV_PREV; lp[i] = []; cells.push(i); }
        } else if (verdict.kind !== NONE) {
          const ev = this.#event(st.id, side, bin * g, (bin + 1) * g, g, verdict.usd, verdict.before, qn, ctx, false, st.approx, verdict.kind === CONFIRMED, prevWall);
          s.remember(i, ev); out.push(ev); bins.push(bin);
          if (waiting) {
            const kept = s.preLv[i]!; s.preLv[i] = null;
            if (kept !== null && lvNow && bin >= nearLo && bin <= nearHi) { fl[i] = LV_CUR; lp[i] = kept; lc[i] = []; cells.push(i); }
          } else if (lvPrev && bin >= nearLo && bin <= nearHi && bin >= backLo && bin <= backHi) { fl[i] = LV_PREV | LV_CUR; lp[i] = []; lc[i] = []; cells.push(i); }
        } else if (waiting) s.preLv[i] = null;
      } else {
        if (s.pend[i] !== 0) { this.stats.weakDropped++; s.pend[i] = 0; s.preLv[i] = null; }
        s.m[i] = 0; s.a[i] = 0; s.u[i] = qn; s.known[i] = 1;
      }
      s.q[i] = qn;
    }
    if (nCnt) {
      const mean = nSum / nCnt, decay = s.noiseWall ? 1 - 2 ** (-(wall - s.noiseWall) / t.noiseHalfLifeMs) : 1;
      s.noise += (mean - s.noise) * decay; s.noiseWall = wall;
    }
    if (out.length - first > 1) this.#pair(out, first, bins);
    if (cells.length > 0) this.#levels(s, now, prevDir, g, out, first, bins);
  }

  /**
   * The point levels behind the cells `#fineSide` flagged, from the frame's side for the cells that need this publication's levels and from the
   * previous publication's copy for those that need that one's (`listLevels`: a search for each cell where the prices run in order, as the merge
   * sends them, one pass over the side where they do not). They go on the events just raised (`lv`), and the levels a weak change's first
   * publication held stay on the cell (`preLv`) for the event that confirms it.
   */
  #levels(s: Fine, now: SideNow, prevDir: number, g: number, out: CueEvent[], first: number, bins: number[]): void {
    const n = this.#n, base = s.base, fl = this.#lvFlag, lp = this.#lvPrev, lc = this.#lvCur, cells = this.#lvCells;
    let needPrev = false, needCur = false, lo = Infinity, hi = -Infinity;
    for (let c = 0; c < cells.length; c++) {
      const i = cells[c]!, f = fl[i]!;
      if ((f & LV_PREV) !== 0) needPrev = true;
      if ((f & LV_CUR) !== 0) needCur = true;
      if (i < lo) lo = i;
      if (i > hi) hi = i;
    }
    // The price span of the flagged cells, with a sliver of margin for `binOf`'s own: a level outside it is none of theirs.
    const wLo = (base + lo) * g - g * 1e-6, wHi = (base + hi + 1) * g + g * 1e-6;
    if (needCur) listLevels(now.arrays.lo, now.arrays.hi, now.arrays.usd, now.len, now.dir, g, base, n, cells, fl, LV_CUR, lc, wLo, wHi);
    if (needPrev) { const p = now.prev; listLevels(p.lo, p.hi, p.usd, p.len, prevDir, g, base, n, cells, fl, LV_PREV, lp, wLo, wHi); }
    for (let j = first; j < out.length; j++) {
      const i = bins[j - first]! - base, p = lp[i], c = lc[i];
      if (p !== null && c !== null) out[j]!.lv = { prev: p!, cur: c! };
    }
    for (let c = 0; c < cells.length; c++) {
      const i = cells[c]!;
      if (fl[i] === LV_PREV) s.preLv[i] = lp[i]!;
      fl[i] = 0; lp[i] = null; lc[i] = null;
    }
    cells.length = 0;
  }

  /** Flag opposite changes of about the same size within `pairBins` bins of each other, nearest first, each event in at most one pair. */
  #pair(out: CueEvent[], first: number, bins: number[]): void {
    const t = this.#t;
    for (let dist = 1; dist <= t.pairBins; dist++) {
      for (let i = first; i < out.length; i++) {
        const a = out[i]!;
        if (a.pair) continue;
        let best = -1, bestErr = Infinity;
        for (let j = first; j < out.length; j++) {
          const b = out[j]!;
          if (j === i || b.pair || b.sign === a.sign || Math.abs(bins[j - first]! - bins[i - first]!) !== dist) continue;
          const err = Math.abs(a.usd + b.usd), ref = Math.max(Math.abs(a.usd), Math.abs(b.usd));
          if (err < t.pairTolerance * ref && err < bestErr) { best = j; bestErr = err; }
        }
        if (best >= 0) { a.pair = true; out[best]!.pair = true; this.stats.pairs++; }
      }
    }
  }

  #event(id: string, side: CueSide, lo: number, hi: number, grid: number, usd: number, before: number, after: number, ctx: CueContext, band: boolean, approx: boolean, confirmed: boolean, prevWall: number): CueEvent {
    this.stats.events++;
    const ref = ctx.scale > 0 && Number.isFinite(ctx.scale) ? ctx.scale : 1e6;
    return { id, side, lo, hi, grid, sign: usd > 0 ? 1 : -1, usd, before, after, strength: 1 - Math.exp(-Math.abs(usd) / ref), wall: ctx.wall, prevWall, seq: ++this.#seq, pub: this.#pub,
      removed: after === 0 && before > 0, added: before === 0 && after > 0, pair: false, approx, band, confirmed };
  }

  /** A banded book (a venue's own grouping: Hyperliquid's 40 bands every 5.4 s): compared band by band where the same band is in both publications. */
  #band(st: Book, book: CueBook, ctx: CueContext, baseline: boolean, dt: number, out: CueEvent[]): boolean {
    const bands = st.bands ??= [new Bands(), new Bands()];
    const touchNowLo = book.touch ? book.touch.lo : NaN, touchNowHi = book.touch ? book.touch.hi : NaN;
    const sides: [SideArrays, SideArrays] = [book.bids, book.asks];
    // Gather each side once: the bands by edges, and the span the book reaches.
    const gathered: Map<string, { lo: number; hi: number; usd: number }>[] = [new Map(), new Map()];
    const reach: [number, number][] = [[Infinity, -Infinity], [Infinity, -Infinity]];
    for (let s = 0; s < 2; s++) {
      const side = sides[s]!, len = Math.min(side.lo.length, side.hi.length, side.usd.length), map = gathered[s]!;
      for (let i = 0; i < len; i++) {
        const lo = side.lo[i]!, hi = side.hi[i]!, usd = side.usd[i]!;
        if (!(usd > 0 && usd < MAX_VALUE && lo > 0 && hi >= lo && hi < MAX_VALUE)) continue;
        const key = `${lo}|${hi}`, held = map.get(key);
        if (held) held.usd += usd; else map.set(key, { lo, hi, usd });
        if (lo < reach[s]![0]) reach[s]![0] = lo; if (hi > reach[s]![1]) reach[s]![1] = hi;
      }
    }
    if (!gathered[0]!.size || !gathered[1]!.size) return false;
    // A representation change (the venue's grouping changed: another set of edges) is not a pull of everything: a baseline.
    for (let s = 0; s < 2 && !baseline; s++) {
      let live = 0, matched = 0;
      for (const c of bands[s]!.cells.values()) if (c.q > 0) live++;
      for (const key of gathered[s]!.keys()) if (bands[s]!.cells.has(key)) matched++;
      if (live >= 4 && gathered[s]!.size >= 4 && matched < 0.5 * Math.min(live, gathered[s]!.size)) baseline = true;
    }
    if (baseline) this.stats.baselines++;
    st.grid = 0; st.approx = false;
    st.zoneLo = Math.min(reach[0]![0], reach[1]![0]); st.zoneHi = Math.max(reach[0]![1], reach[1]![1]);
    for (let s = 0; s < 2; s++) {
      if (baseline) this.stats.weakDropped += bands[s]!.wipe();
      this.#bandSide(st, bands[s]!, gathered[s]!, reach[s]!, s === 0 ? 'bid' : 'ask', touchNowLo, touchNowHi, ctx, baseline, dt, out);
    }
    st.touchLo = touchNowLo; st.touchHi = touchNowHi;
    return true;
  }

  #bandSide(st: Book, bs: Bands, now: Map<string, { lo: number; hi: number; usd: number }>, reach: [number, number], side: CueSide, touchLo: number, touchHi: number,
    ctx: CueContext, baseline: boolean, dt: number, out: CueEvent[]): void {
    const t = this.#t, wall = ctx.wall, bid = side === 'bid';
    const prevReachLo = bs.reachLo, prevReachHi = bs.reachHi;
    const suppressed = (lo: number, hi: number): boolean => overlaps(lo, hi, touchLo, touchHi) || overlaps(lo, hi, st.touchLo, st.touchHi);
    let sum = 0;
    for (const b of now.values()) sum += b.usd;
    const floor = Number.isFinite(ctx.floorUsd) ? ctx.floorUsd : 0, share = t.meanShare * (now.size ? sum / now.size : 0);
    const gate = Math.max(floor, share, t.noiseMultiple * bs.noise);
    const fresh = Math.exp(-dt / t.tauFreshMs), active = Math.exp(-dt / t.tauActivityMs);
    const base = Math.max(bs.noise, share), cap = base > 0 ? t.noiseClip * base : Infinity;
    let nSum = 0, nCnt = 0;
    const first = out.length;
    // A band in one of the two publications only, overlapping a band that is in the other only, is one region the venue grouped differently (it moved
    // an edge, split a band or joined two): no addition and no pull. The new bands start as unknown and the old ones go without an event. "In the
    // previous publication" is a live quantity, not a key of the map: a band that went empty stays as a ghost (so its return is an addition), and a
    // ghost is no band that publication held, so a band of the same edges as a ghost is as new as one of other edges.
    let freshKeys: Set<string> | null = null, goneKeys: Set<string> | null = null;
    if (!baseline) {
      const gone: [string, Cell][] = [], fresh: [string, { lo: number; hi: number }][] = [];
      for (const [key, c] of bs.cells) if (c.q > 0 && !now.has(key)) gone.push([key, c]);
      if (gone.length) for (const [key, b] of now) { const held = bs.cells.get(key); if (held === undefined || held.q === 0) fresh.push([key, b]); }
      for (const [gk, c] of gone) for (const [fk, b] of fresh) if (sharePrices(c.lo, c.hi, b.lo, b.hi)) { (goneKeys ??= new Set()).add(gk); (freshKeys ??= new Set()).add(fk); }
    }
    const visit = (cell: Cell, qn: number): void => {
      const qp = cell.q, d = qn - qp, ad = d < 0 ? -d : d;
      advance(cell.m, cell.u, cell.a, qp, qn, fresh, active, !t.freshGated || d >= gate);
      cell.m = est.m; cell.u = est.u; cell.a = est.a;
      if (qp > 0 || qn > 0) { nSum += ad < cap ? ad : cap; nCnt++; }
      const from = cell.pend !== 0 ? cell.preWall : st.lastWall;
      const dropped = judge(gate, qp, qn, cell.pend, cell.pre, t.confirmRatio);
      if (dropped) this.stats.weakDropped++;
      cell.pend = 0;
      if (verdict.kind === WEAK) { cell.pend = verdict.usd > 0 ? 1 : -1; cell.pre = verdict.before; cell.preWall = from; }
      else if (verdict.kind !== NONE) {
        const ev = this.#event(st.id, side, cell.lo, cell.hi, 0, verdict.usd, verdict.before, qn, ctx, true, false, verdict.kind === CONFIRMED, from);
        remember(cell.hist, 0, ev); out.push(ev);
      }
      cell.q = qn;
      if (qn === 0 && cell.zero === 0) cell.zero = wall; else if (qn > 0) cell.zero = 0;
    };
    // The bands in this publication.
    for (const [key, b] of now) {
      if (freshKeys !== null && freshKeys.has(key)) {
        // It takes the place of a ghost of the same edges, if there is one: a change waiting on the ghost is dropped, what the ghost last showed stays.
        const ghost = bs.cells.get(key);
        if (ghost !== undefined && ghost.pend !== 0) this.stats.weakDropped++;
        bs.cells.set(key, { lo: b.lo, hi: b.hi, q: b.usd, m: 0, u: b.usd, a: 0, pend: 0, pre: 0, preWall: 0, zero: 0, hist: ghost !== undefined ? ghost.hist : newHistory() });
        continue;
      }
      const held = bs.cells.get(key);
      const cutByTouch = suppressed(b.lo, b.hi);
      if (!baseline && held && !cutByTouch) { visit(held, b.usd); continue; }
      // A band the previous publication did not hold, inside the range it reached, was known to be empty there: it is new liquidity, not a new band.
      const insideBefore = prevReachLo === prevReachLo && (bid ? b.lo >= prevReachLo : b.hi <= prevReachHi);
      if (!baseline && !held && !cutByTouch && insideBefore) {
        const cell: Cell = { lo: b.lo, hi: b.hi, q: 0, m: 0, u: 0, a: 0, pend: 0, pre: 0, preWall: 0, zero: wall, hist: newHistory() };
        bs.cells.set(key, cell); visit(cell, b.usd); continue;
      }
      if (held && held.pend !== 0) this.stats.weakDropped++;
      bs.cells.set(key, { lo: b.lo, hi: b.hi, q: b.usd, m: 0, u: b.usd, a: 0, pend: 0, pre: 0, preWall: 0, zero: 0, hist: held ? held.hist : newHistory() });
    }
    // The bands that are not: inside the range the book reaches now they went empty, outside it they are unknown (a depth limit moving with the price).
    for (const [key, c] of bs.cells) {
      if (now.has(key)) continue;
      if (goneKeys !== null && goneKeys.has(key)) { if (c.pend !== 0) this.stats.weakDropped++; bs.cells.delete(key); continue; }
      const inside = bid ? c.lo >= reach[0] : c.hi <= reach[1];
      if (!baseline && inside && !suppressed(c.lo, c.hi)) {
        // A band that went empty with a weak removal waiting is visited too: this publication confirms it or drops it.
        if (c.q > 0 || c.pend !== 0) visit(c, 0);
        if (wall - c.zero > t.ghostMs) bs.cells.delete(key);
      } else { if (c.pend !== 0) this.stats.weakDropped++; bs.cells.delete(key); }
    }
    if (nCnt) {
      const mean = nSum / nCnt, decay = bs.noiseWall ? 1 - 2 ** (-(wall - bs.noiseWall) / t.noiseHalfLifeMs) : 1;
      bs.noise += (mean - bs.noise) * decay; bs.noiseWall = wall;
    }
    bs.reachLo = reach[0]; bs.reachHi = reach[1];
    // Price ascending, as the bins' events are (the bands came in the book's order and the ones that went after them), and `seq` along it.
    if (out.length - first > 1) {
      const part = out.splice(first), seqs = part.map(e => e.seq).sort((a, b) => a - b);
      part.sort((a, b) => a.lo - b.lo);
      part.forEach((e, i) => { e.seq = seqs[i]!; out.push(e); });
    }
  }
}

/** The most rows one event makes on a display grid (after the window). */
const MAX_ROWS = 4_096;

/**
 * Cell events on display rows of `step` (row `k` is [k x step, (k + 1) x step)). An event that keeps its levels (`CueEvent.lv`) is placed by them,
 * as the ladder's bars were: each level of the new publication adds its USD to the row of its price and each of the old takes its USD from the row
 * of its price (the floor of price / step, as `spread_levels` and `accumulateSide` place a point level), so a row's USD is its own signed change,
 * which can be the opposite sign to the bin's net (+$2M at 81,021 and -$500K at 81,031 in one $20 bin are +$2M on one $10 row and -$500K on the
 * next), and a row where the levels cancel has none. The USD of any other event is shared over the rows its interval overlaps in proportion to the
 * overlap (a band spreads as `spread_levels` spreads it, a grid bin finer than a row lies in one row or two, a row finer than the grid takes its
 * part). The events of one venue, side and publication that meet in a row are summed, their strength worked out again from the sum. `removed` and
 * `added` are true when every event that meets in the row says so (for an event with levels, by that row's own old and new USD): for a row of
 * several bins that is a hint, and the reader looks at the cell; `pair` and `band` are true when any of them is, `seq` is the newest and
 * `prevWall` the earliest. `window` keeps the rows of that price range and one row beyond it each side, by the same integer bounds for both rules
 * (the floor of price / step): a row that the rule of whoever asks (`binOf` forgives a division that comes out a hair under a whole number) gives an
 * edge price is never lost, and whoever asks cuts the rest; an event never makes more than 4,096 rows.
 */
export function rowEvents(events: readonly CueEvent[], step: number, scale: number, window?: { lo: number; hi: number }): RowEvent[] {
  if (!(step > 0) || !Number.isFinite(step)) return [];
  return project(events, step, scale, window ? Math.floor(window.lo / step) - 1 : -Infinity, window ? Math.floor(window.hi / step) + 1 : Infinity);
}

/**
 * What `rowEvents` gives for ONE display row, from the row's own integer index (`[row x step, (row + 1) x step)`): nothing is worked out from a price, so
 * a decimal step cannot move the row (65,536.2 / 0.1 is 655,361.9999999999: the kernel's floor puts a level at that price in row 655,361, and `binOf`
 * in 655,362). A level is in the row if its price floors to it, an event without levels shares its USD by its overlap with the row; the events of one
 * venue, side and publication are summed as `rowEvents` sums them, and with several of those mixed in, the first in the order of `events` is the one
 * returned, as `rowEvents(...).find(...)` would. Null where no event reaches the row.
 */
export function rowEventAt(events: readonly CueEvent[], row: number, step: number, scale: number): RowEvent | null {
  if (!Number.isInteger(row) || !(step > 0) || !Number.isFinite(step)) return null;
  return project(events, step, scale, row, row)[0] ?? null;
}

/** The rows of `step` from `wk0` to `wk1` (integers, inclusive) that `events` reach, as `rowEvents` explains. */
function project(events: readonly CueEvent[], step: number, scale: number, wk0: number, wk1: number): RowEvent[] {
  if (events.length === 0) return [];
  const ref = scale > 0 && Number.isFinite(scale) ? scale : 1e6;
  const out: RowEvent[] = [], at = new Map<string, RowEvent>();
  // The old and the new USD of each row an event's levels reach (refilled for each event), within the window.
  const rows = new Map<number, { before: number; after: number }>();
  const addLevels = (list: readonly number[], after: boolean): void => {
    for (let j = 0; j + 1 < list.length; j += 2) {
      const price = list[j]!, usd = list[j + 1]!;
      if (!(price > 0 && price < MAX_VALUE && usd > 0 && usd < MAX_VALUE)) continue;
      const k = Math.floor(price / step);
      if (k < wk0 || k > wk1) continue;
      let cell = rows.get(k);
      if (cell === undefined) { cell = { before: 0, after: 0 }; rows.set(k, cell); }
      if (after) cell.after += usd; else cell.before += usd;
    }
  };
  const put = (e: CueEvent, k: number, usd: number, removed: boolean, added: boolean): void => {
    // One publication's events share its number; its wall alone does not tell it from another (the page's clock may come back to it).
    const key = `${e.id}|${e.side}|${k}|${e.pub}|${e.wall}`, held = at.get(key);
    if (held) {
      held.usd += usd; held.removed &&= removed; held.added &&= added; held.pair ||= e.pair; held.band ||= e.band;
      if (e.seq > held.seq) held.seq = e.seq;
      if (e.prevWall < held.prevWall) held.prevWall = e.prevWall;
    } else {
      const row: RowEvent = { id: e.id, side: e.side, row: k, usd, strength: 0, wall: e.wall, prevWall: e.prevWall, seq: e.seq, removed, added, pair: e.pair, band: e.band };
      at.set(key, row); out.push(row);
    }
  };
  for (const e of events) {
    const width = e.hi - e.lo;
    if (!(width > 0) || !Number.isFinite(width)) continue;
    if (e.lv !== undefined) {
      rows.clear(); addLevels(e.lv.prev, false); addLevels(e.lv.cur, true);
      const ks = [...rows.keys()].sort((a, b) => a - b);
      if (ks.length > MAX_ROWS) ks.length = MAX_ROWS;
      for (const k of ks) {
        const { before, after } = rows.get(k)!, d = after - before;
        // Two levels that cancel in a row leave float dust, not a change.
        if (!(Math.abs(d) > 1e-9 * (before + after))) continue;
        put(e, k, d, after === 0 && before > 0, before === 0 && after > 0);
      }
      continue;
    }
    // The rows the interval can reach, as the kernel counts them, inside the bounds; the overlap decides which it does.
    const k0 = Math.max(Math.floor(e.lo / step), wk0);
    let k1 = Math.min(Math.floor(e.hi / step), wk1);
    if (k1 - k0 >= MAX_ROWS) k1 = k0 + MAX_ROWS - 1;
    for (let k = k0; k <= k1; k++) {
      const overlap = Math.min(e.hi, (k + 1) * step) - Math.max(e.lo, k * step);
      if (!(overlap > width * 1e-9)) continue;
      put(e, k, e.usd * (overlap / width), e.removed, e.added);
    }
  }
  for (const r of out) r.strength = 1 - Math.exp(-Math.abs(r.usd) / ref);
  return out;
}
