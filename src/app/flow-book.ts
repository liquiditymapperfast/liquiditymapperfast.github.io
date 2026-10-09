import { FlowMinutes, FlowSeries, type FlowFrame, type FlowMinutesFrame, type FlowUpdate } from '../shared/flow.ts';
import { FlowTrack } from './cvd/track.ts';

/**
 * The page's taker flow: one `FlowSeries` per instrument, fed by the history a source answers and by the seconds it pushes. The two meet
 * without a seam: while an instrument's history is on its way, what the live stream says is held and put on top of it afterwards (a push
 * carries absolute totals for a second, so putting it on twice does no harm).
 */
export class FlowBook {
  readonly #series = new Map<string, FlowSeries>();
  /** Older flow a minute at a time, and the window each instrument's minutes were asked for (answered or not). */
  readonly #minutes = new Map<string, FlowMinutes>();
  readonly #minutesAsked = new Map<string, { from: number; to: number }>();
  readonly #held = new Map<string, FlowUpdate[]>();
  /** inst -> the earliest millisecond its history was asked from (answered or not: an instrument with nothing recorded is not asked again). */
  readonly #from = new Map<string, number>();
  /** Counts the times what was loaded stopped being trustworthy (the live stream broke), and the count each held instrument's request began under. */
  #epoch = 0;
  readonly #began = new Map<string, number>();
  /** Bumped whenever anything changed, for whoever redraws. */
  version = 0;

  get ids(): string[] { return [...this.#series.keys()]; }
  get(id: string): FlowSeries | undefined { return this.#series.get(id); }
  has(id: string): boolean { return this.#series.has(id); }
  /** The instrument's line for the column: its seconds and, before them, its minutes (undefined when it has neither). */
  track(id: string): FlowTrack | undefined {
    const seconds = this.#series.get(id), minutes = this.#minutes.get(id);
    return seconds || minutes ? new FlowTrack(seconds, minutes) : undefined;
  }

  /** Seconds from the live stream. */
  apply(items: readonly FlowUpdate[]): void {
    for (const item of items) {
      const held = this.#held.get(item[0]);
      if (held) { held.push(item); continue; }
      this.#put(item);
    }
    this.version++;
  }
  #put([id, t, buy, sell, px]: FlowUpdate): void {
    let series = this.#series.get(id); if (!series) { series = new FlowSeries(); this.#series.set(id, series); }
    const sec = Math.floor(t / 1000);
    // A push is the running total of its second, and a second's total only grows. One that is below what the series holds was sent before the
    // history in it was taken (it was in flight, or held while the history came), and putting it on would take the second back.
    if (series.gross(sec, sec) > buy + sell) return;
    series.set(sec, buy, sell, px ?? 0);
  }

  /** Which of `ids` still need history reaching back to `from` (never asked, or asked from later). */
  missing(ids: readonly string[], from: number): string[] { return ids.filter(id => !((this.#from.get(id) ?? Infinity) <= from)); }

  /** History for `ids` is being fetched: hold their live seconds until `load` or `fail`. */
  begin(ids: readonly string[]): void { for (const id of ids) { this.#began.set(id, this.#epoch); if (!this.#held.has(id)) this.#held.set(id, []); } }

  /**
   * What was loaded no longer covers everything (the live stream broke, and the seconds it missed are in the history and not in the book):
   * every instrument is asked for again at the next look. A request that is on its way began before this, so its answer does not count as
   * having covered anything.
   */
  invalidate(): void { this.#epoch++; this.#from.clear(); }
  /** The answer: replace each instrument's series with its history, then put the held live seconds on top. */
  load(frame: FlowFrame, ids: readonly string[], from: number): void {
    for (const s of frame.instruments) {
      let series = this.#series.get(s.id); if (!series) { series = new FlowSeries(); this.#series.set(s.id, series); }
      series.load(Math.floor(s.t0 / 1000), s.buy, s.sell, s.px);
    }
    for (const id of ids) {
      if (this.#began.get(id) === this.#epoch) this.#from.set(id, from);
      this.#began.delete(id);
      for (const item of this.#held.get(id) ?? []) this.#put(item);
      this.#held.delete(id);
    }
    this.version++;
  }
  /** Which of `ids` still need minutes over [from, to] (never asked, or asked for less). */
  minutesMissing(ids: readonly string[], from: number, to: number): string[] {
    return ids.filter(id => { const asked = this.#minutesAsked.get(id); return !(asked && asked.from <= from && asked.to >= to); });
  }
  /** Minutes answered for `ids` over [from, to]: each instrument's replace what it had (one with none keeps none). */
  loadMinutes(frame: FlowMinutesFrame, ids: readonly string[], from: number, to: number): void {
    for (const id of ids) { this.#minutes.delete(id); this.#minutesAsked.set(id, { from, to }); }
    for (const s of frame.instruments) if (ids.includes(s.id)) this.#minutes.set(s.id, new FlowMinutes(s));
    this.version++;
  }

  /** The request failed: let the live seconds in again and allow another try. */
  fail(ids: readonly string[]): void {
    for (const id of ids) { for (const item of this.#held.get(id) ?? []) this.#put(item); this.#held.delete(id); this.#began.delete(id); }
    this.version++;
  }
}
