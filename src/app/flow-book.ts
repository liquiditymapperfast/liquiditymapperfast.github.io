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
  /**
   * inst -> from when (ms) the last answer held its flow: the later of where it was asked from and where the answer reached (its earliest
   * second of any instrument: a market quiet for hours was recorded quiet, not missing; each market's own record is the coverage record's
   * business). None when the answer held nothing. Not cleared when the stream breaks: what was answered stays answered until the next.
   */
  readonly #answered = new Map<string, number>();
  /** Counts the times what was loaded stopped being trustworthy (the live stream broke), and the count each held instrument's request began under. */
  #epoch = 0;
  readonly #began = new Map<string, number>();
  /** Bumped whenever anything changed, for whoever redraws. */
  version = 0;
  /** Bumped when history is loaded, fails or stops counting (not for a live second): what is worked out from older flow keys on it. */
  loads = 0;

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

  /** From when (ms) the instrument's history is held (the last answer's, see `#answered`), Infinity when no answer held any of it. */
  heldFrom(id: string): number { return this.#answered.get(id) ?? Infinity; }
  /** Which of `ids` still need history reaching back to `from` (never asked, or asked from later). */
  missing(ids: readonly string[], from: number): string[] { return ids.filter(id => !((this.#from.get(id) ?? Infinity) <= from)); }

  /** History for `ids` is being fetched: hold their live seconds until `load` or `fail`. */
  begin(ids: readonly string[]): void { for (const id of ids) { this.#began.set(id, this.#epoch); if (!this.#held.has(id)) this.#held.set(id, []); } }

  /**
   * What was loaded no longer covers everything (the live stream broke, and the seconds it missed are in the history and not in the book):
   * every instrument is asked for again at the next look. A request that is on its way began before this, so its answer does not count as
   * having covered anything.
   */
  invalidate(): void { this.#epoch++; this.#from.clear(); this.loads++; }
  /** The answer: replace each instrument's series with its history, then put the held live seconds on top. */
  load(frame: FlowFrame, ids: readonly string[], from: number): void {
    let reach = Infinity;
    for (const s of frame.instruments) {
      let series = this.#series.get(s.id); if (!series) { series = new FlowSeries(); this.#series.set(s.id, series); }
      series.load(Math.floor(s.t0 / 1000), s.buy, s.sell, s.px);
      if (s.buy.length && s.t0 < reach) reach = s.t0;
    }
    for (const id of ids) {
      if (this.#began.get(id) === this.#epoch) {
        this.#from.set(id, from);
        if (Number.isFinite(reach)) this.#answered.set(id, Math.max(from, reach)); else this.#answered.delete(id);
      }
      this.#began.delete(id);
      for (const item of this.#held.get(id) ?? []) this.#put(item);
      this.#held.delete(id);
    }
    this.version++; this.loads++;
  }
  /** Which of `ids` still need minutes over [from, to] (never asked, or asked for less). */
  minutesMissing(ids: readonly string[], from: number, to: number): string[] {
    return ids.filter(id => { const asked = this.#minutesAsked.get(id); return !(asked && asked.from <= from && asked.to >= to); });
  }
  /**
   * Minutes answered for `ids` over [from, to]: each instrument's replace what it had (one with none keeps none). An answer that begins later
   * than asked (by more than the minute it is rounded to) is a source that keeps no older minutes up to `to` (the server answers the last
   * eight days): nothing older is asked for again, where a zoom out asked for the same days at each of its steps.
   */
  loadMinutes(frame: FlowMinutesFrame, ids: readonly string[], from: number, to: number): void {
    const reach = frame.from > from + 60_000 ? -Infinity : from;
    for (const id of ids) { this.#minutes.delete(id); this.#minutesAsked.set(id, { from: reach, to }); }
    for (const s of frame.instruments) if (ids.includes(s.id)) this.#minutes.set(s.id, new FlowMinutes(s));
    this.version++; this.loads++;
  }

  /** The request failed: let the live seconds in again and allow another try. */
  fail(ids: readonly string[]): void {
    for (const id of ids) { for (const item of this.#held.get(id) ?? []) this.#put(item); this.#held.delete(id); this.#began.delete(id); }
    this.version++; this.loads++;
  }
}
