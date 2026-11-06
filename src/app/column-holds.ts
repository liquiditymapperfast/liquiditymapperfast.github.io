import type { Bounds } from './view.ts';

const MINUTE = 60_000;
/**
 * A window of recorded columns is complete once its last minute has ended and the recorder has taken that minute's last sample (seconds
 * later); this much room also covers a source whose clock is a little off.
 */
export const COLUMNS_SETTLE_MS = 2 * MINUTE;
/** Every window of `stepMs` that ends at or before this time was complete at `now` (the source's clock) and stays as it is. */
export const settledBefore = (now: number, stepMs: number): number => Math.floor((now - COLUMNS_SETTLE_MS) / stepMs) * stepMs;
/**
 * An instrument's whole window is asked for again at least this often, refreshes or not: a source lets go of what passes its retention (the
 * browser keeps a day), and columns held from before that would otherwise pile up behind a wide view for days. An instrument the view no
 * longer lists is forgotten once its window is this old (it would be asked for whole again if it came back).
 */
export const COLUMNS_FULL_EVERY_MS = 3_600_000;
/**
 * How many column steps are held at once (the worker keeps each step's columns for the instruments listed): a zoom through three steps and
 * back asks the source once for each. A column step holds about a screen of columns whatever its size, some 20 MB for 27 markets.
 */
export const COLUMN_STEPS_HELD = 3;

/**
 * What the page knows of one instrument's recorded columns at one step (the worker holds the columns): the window they were asked for
 * (`to` reaches past now: where the view may move into), the time before which every window was complete when they were asked for
 * (`settled`: a refresh asks only from there), when the whole window was last asked for (`whole`) and when last answered at all (`asked`),
 * and the price grid they were recorded on (0: not told).
 */
export interface ColumnHold { from: number; to: number; settled: number; whole: number; asked: number; grid: number }
/**
 * A hold not answered for this long is refreshed at once, without waiting for the clock's next refresh mark (every 30 s): a book that was
 * away, or a step that was not read, is minutes behind the others.
 */
export const COLUMNS_BEHIND_MS = 90_000;
/** One question to the source: these instruments over [from, to). A `tail` is the refresh of columns held (from where they settled); the rest is the whole window. */
export interface ColumnAsk { ids: string[]; from: number; to: number; tail: boolean }
/** What to tell the worker to forget: these instruments' columns at this step, or all of the step's (`ids` null). */
export interface ColumnDrop { stepMs: number; ids: string[] | null }

/**
 * The long history's finest level (app/archive/) for BTC: its tiles start at two-minute windows; a minute is the hour files', read for the
 * page's own day only. A coin whose books the service keeps as tiles alone (ETH, SOL) starts coarser: its `latest.json` names its levels.
 */
export const ARCHIVE_MIN_STEP_MS = 2 * MINUTE;

/**
 * The column step for a view: about two pixels a column, in minutes that double from one level to the next, so zooming moves between a few
 * steps merged before. Where the view reaches before the page's own day (`since`: its oldest recorded minute, 0 when it has none) and the
 * long history is there to draw it (`archive`: its first window, null when there is none), the step is at least the archive's finest level
 * (`archiveStepMs`: two minutes for BTC, eight for ETH and SOL), so old ranges always draw; a view wholly inside the day keeps its minutes,
 * and so does one that includes now (`now`, the source's clock), whose newest column the live overlay draws a minute at a time: BTC's day
 * comes from the hour files at a minute. A coin whose hours carry no book minutes (`liveToo`: ETH, SOL) has nothing but the tiles before the
 * page's own recording, so its live views reaching before it are lifted as well, until the tab has recorded the whole view: their newest
 * column is then the open window as recorded so far, refreshed with the map, as at any coarser zoom.
 */
export function columnStepFor(view: Pick<Bounds, 't0' | 't1'>, widthPx: number, archive: number | null, since: number, now: number, archiveStepMs = ARCHIVE_MIN_STEP_MS, liveToo = false): number {
  const span = view.t1 - view.t0;
  const step = MINUTE * 2 ** Math.max(0, Math.round(Math.log2(span / Math.max(1, widthPx) * 2 / MINUTE)));
  if (step >= archiveStepMs || archive === null) return step;
  const beforeDay = since <= 0 || view.t0 < since, live = view.t1 >= now - MINUTE;
  return beforeDay && (!live || liveToo) ? archiveStepMs : step;
}

/** The window of whole steps a view may move into: half its span further each way. A window cut by the question would be kept as the part of it that was asked for. */
export function columnReach(view: Bounds, stepMs: number): { from: number; to: number } {
  const span = view.t1 - view.t0;
  return { from: Math.floor((view.t0 - span * 0.5) / stepMs) * stepMs, to: Math.ceil((view.t1 + span * 0.5) / stepMs) * stepMs };
}

/**
 * The page's record of the recorded columns the worker holds, by step and instrument (`RecordedColumns` there). Each instrument is asked
 * for on its own account: one the view has not held, or holds for another window, is asked for whole; one held is refreshed from where it
 * settled; a book that leaves and comes back costs the minutes it missed, and a step held before costs nothing at all.
 */
export class ColumnHolds {
  #steps = new Map<number, Map<string, ColumnHold>>();
  /** When each step was last wanted (a counter: the oldest goes first). */
  #used = new Map<number, number>();
  #tick = 0;

  /** The instruments held at this step. */
  at(stepMs: number): ReadonlyMap<string, ColumnHold> { return this.#steps.get(stepMs) ?? new Map(); }
  /** The steps held. */
  steps(): number[] { return [...this.#steps.keys()]; }

  /** Whether every one of `ids` has columns at this step for the whole view, however old (what is drawn is then at the right step). */
  covers(ids: readonly string[], view: Bounds, stepMs: number): boolean {
    const held = this.#steps.get(stepMs);
    if (!held) return false;
    for (const id of ids) { const hold = held.get(id); if (!hold || hold.from > view.t0 || hold.to < view.t1) return false; }
    return true;
  }

  /**
   * What to ask the source for the view at this step, the refreshes first. `now`: the source's clock, `clock` the page's; `stale`: the clock
   * says new minutes may have been recorded. An instrument held for the view is left alone unless stale, and then asked from where it settled
   * (not at all when that is as far as its window goes: a view wholly in the past); any other is asked for the reach of the view, up to now.
   */
  plan(ids: readonly string[], view: Bounds, stepMs: number, now: number, clock: number, stale: boolean): ColumnAsk[] {
    const held = this.#steps.get(stepMs), reach = columnReach(view, stepMs);
    const tails = new Map<string, ColumnAsk>(), wholes = new Map<string, ColumnAsk>();
    const add = (into: Map<string, ColumnAsk>, id: string, from: number, to: number, tail: boolean): void => {
      const key = `${from}|${to}`, ask = into.get(key);
      if (ask) ask.ids.push(id); else into.set(key, { ids: [id], from, to, tail });
    };
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const hold = held?.get(id);
      if (!hold || hold.from > view.t0 || hold.to < view.t1 || clock - hold.whole >= COLUMNS_FULL_EVERY_MS) { add(wholes, id, reach.from, Math.min(now + MINUTE, reach.to), false); continue; }
      if (!stale && clock - hold.asked < COLUMNS_BEHIND_MS) continue;
      const end = Math.min(now + MINUTE, hold.to);
      if (hold.settled < end) add(tails, id, hold.settled, end, true);
    }
    return [...tails.values(), ...wholes.values()];
  }

  /** Of these answers to a refresh, the instruments whose price grid is not the one their columns held were recorded on (a server started again and chose another): their bins mean other prices. */
  gridChanged(stepMs: number, sets: readonly { id: string; step: number }[]): string[] {
    const held = this.#steps.get(stepMs);
    return sets.filter(set => { const grid = held?.get(set.id)?.grid ?? 0; return set.step > 0 && grid > 0 && grid !== set.step; }).map(set => set.id);
  }

  /**
   * These markets' price grid has changed (the answers at `stepMs` say so): what is held for them at every other step was recorded on the old
   * one and would be read as it is when that step comes back. Forgets it, and returns what to tell the worker to forget.
   */
  forgetElsewhere(stepMs: number, ids: readonly string[]): ColumnDrop[] {
    const drops: ColumnDrop[] = [];
    for (const [step, held] of this.#steps) {
      if (step === stepMs) continue;
      const gone = ids.filter(id => held.delete(id));
      if (gone.length) drops.push({ stepMs: step, ids: gone });
      if (!held.size) { this.#steps.delete(step); this.#used.delete(step); }
    }
    return drops;
  }

  /** The whole window `reach` was answered for these instruments (up to `settled` it was complete). */
  recordWhole(stepMs: number, sets: readonly { id: string; step: number }[], reach: { from: number; to: number }, settled: number, clock: number): void {
    const held = this.#at(stepMs);
    for (const set of sets) held.set(set.id, { from: reach.from, to: reach.to, settled, whole: clock, asked: clock, grid: set.step > 0 ? set.step : 0 });
    this.touch(stepMs);
  }

  /** A refresh was answered for these instruments, complete up to `settled`. */
  recordTail(stepMs: number, sets: readonly { id: string; step: number }[], settled: number, clock: number): void {
    const held = this.#steps.get(stepMs);
    if (!held) return;
    for (const set of sets) {
      const hold = held.get(set.id);
      if (hold) held.set(set.id, { ...hold, settled: Math.max(hold.settled, settled), asked: clock, grid: set.step > 0 ? set.step : hold.grid });
    }
    this.touch(stepMs);
  }

  /**
   * Everything held is to be asked for whole again at the next load (the long history has more of it now), while the worker keeps drawing
   * what it holds until the answers replace it.
   */
  expireWhole(): void { for (const held of this.#steps.values()) for (const [id, hold] of held) held.set(id, { ...hold, whole: -Infinity }); }

  /** These instruments at `stepMs` are to be asked for whole again at the next load (the worker keeps drawing what it holds meanwhile). */
  expire(stepMs: number, ids: readonly string[]): void {
    const held = this.#steps.get(stepMs);
    for (const id of ids) { const hold = held?.get(id); if (hold) held!.set(id, { ...hold, whole: -Infinity }); }
  }

  /** This step is wanted now. */
  touch(stepMs: number): void { if (this.#steps.has(stepMs)) this.#used.set(stepMs, ++this.#tick); }

  /**
   * Forget what has been held an hour without being asked for whole: any instrument at a step that is not the wanted one or the one drawn
   * (nothing there is read soon), and any the view no longer lists at those two (a book that has gone, or one a day gone is asked for whole
   * again when it comes back). Returns what to tell the worker to forget.
   */
  sweep(clock: number, wanted: number, drawn: number, ids: ReadonlySet<string>): ColumnDrop[] {
    const drops: ColumnDrop[] = [];
    for (const [stepMs, held] of this.#steps) {
      const read = stepMs === wanted || stepMs === drawn, gone: string[] = [];
      for (const [id, hold] of held) if (clock - hold.whole >= COLUMNS_FULL_EVERY_MS && !(read && ids.has(id))) gone.push(id);
      for (const id of gone) held.delete(id);
      if (gone.length) drops.push({ stepMs, ids: gone });
      if (!held.size) { this.#steps.delete(stepMs); this.#used.delete(stepMs); }
    }
    return drops;
  }

  /**
   * Forget the steps beyond `COLUMN_STEPS_HELD`, least recently wanted first, never the one being loaded, the one drawn or the one the view
   * wants now (a zoom since the load began). Returns what to tell the worker to forget.
   */
  evict(loading: number, drawn: number, wanted: number): ColumnDrop[] {
    const drops: ColumnDrop[] = [];
    while (this.#steps.size > COLUMN_STEPS_HELD) {
      let oldest = -1, at = Infinity;
      for (const stepMs of this.#steps.keys()) { const used = this.#used.get(stepMs) ?? 0; if (stepMs !== loading && stepMs !== drawn && stepMs !== wanted && used < at) { oldest = stepMs; at = used; } }
      if (oldest < 0) break;
      this.#steps.delete(oldest); this.#used.delete(oldest);
      drops.push({ stepMs: oldest, ids: null });
    }
    return drops;
  }

  #at(stepMs: number): Map<string, ColumnHold> {
    let held = this.#steps.get(stepMs);
    if (!held) { held = new Map(); this.#steps.set(stepMs, held); }
    return held;
  }
}
