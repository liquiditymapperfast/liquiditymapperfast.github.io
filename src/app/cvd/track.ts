import type { FlowMinutes, FlowSeries } from '../../shared/flow.ts';

/**
 * One instrument's flow as the column draws it: the seconds the page holds and, before them, its minutes, joined into one running delta.
 * The minutes are shifted to meet the seconds at the first whole minute the seconds hold (`join`), so the line runs on without a step. A
 * window inside the seconds reads only them, as it always did; one reaching further back reads the minutes there, a minute at a time.
 * Ranking, the quiet flag and the dot rows count the seconds alone (their windows end now).
 */
export class FlowTrack {
  /** The second from which the seconds are read (a minute boundary); null when there is one kind only. */
  readonly join: number | null;
  /** What is added to a minute's running delta to put it on the seconds' scale. */
  readonly #shift: number;
  /** The minutes, when the line reads them (joined to the seconds, or alone when there are no seconds). */
  readonly #m: FlowMinutes | null;

  constructor(readonly seconds: FlowSeries | undefined, readonly minutes: FlowMinutes | undefined) {
    const span = seconds?.span ?? null, held = minutes !== undefined && minutes.length > 0;
    let join: number | null = null, shift = 0;
    if (span && held) {
      const j = Math.ceil(span.first / 60) * 60;
      // The minutes must reach the join (or there would be a stretch neither holds) and begin before it (or they add nothing).
      if (minutes.t0 < j * 1000 && minutes.end >= j * 1000) { join = j; shift = seconds!.cumDelta(j - 1) - minutes.deltaAt(minutes.indexOf(j) - 1); }
    }
    this.join = join; this.#shift = shift; this.#m = join !== null || (!span && held) ? minutes! : null;
  }

  /** The first second held, or null when there is nothing. */
  get first(): number | null {
    if (this.#m) return Math.floor(this.#m.t0 / 1000);
    return this.seconds?.span?.first ?? null;
  }

  /** The running delta at the end of second `sec` (in the minutes, at the end of the minute it falls in). */
  cumDelta(sec: number): number {
    if (this.#m && (this.join === null || sec < this.join)) return this.#m.deltaAt(this.#m.indexOf(sec)) + this.#shift;
    return this.seconds?.cumDelta(sec) ?? 0;
  }

  /** The price at the end of second `sec`: the seconds' where they hold one, else the last minute's at or before it; NaN when neither has one. */
  priceAt(sec: number): number {
    const m = this.#m;
    if (!m) return this.seconds?.priceAt(sec) ?? NaN;
    if (this.join !== null && sec >= this.join) { const v = this.seconds!.priceAt(sec); if (v === v) return v; }
    return m.priceAt(m.indexOf(this.join !== null ? Math.min(sec, this.join - 1) : sec));
  }

  /** As FlowSeries.decimate (the same slices, [min, max, last] per column, NaN where nothing is held), over both. */
  decimate(from: number, to: number, columns: number, out: Float64Array): void {
    const m = this.#m;
    if (!m || (this.join !== null && from >= this.join)) {
      if (this.seconds) this.seconds.decimate(from, to, columns, out); else out.fill(NaN, 0, columns * 3);
      return;
    }
    const n = m.length, join = this.join, shift = this.#shift, span = to - from, part = new Float64Array(3);
    for (let c = 0; c < columns; c++) {
      const a = from + Math.floor(span * c / columns), b = Math.max(a + 1, from + Math.floor(span * (c + 1) / columns)), o = c * 3;
      let lo = Infinity, hi = -Infinity, last = NaN;
      const minutesEnd = join === null ? b : Math.min(b, join);
      if (a < minutesEnd) {
        const i0 = m.indexOf(a), i1 = m.indexOf(minutesEnd - 1);
        if (i1 >= 0) {
          // Past the last minute the line holds its last value, as the seconds do past their newest.
          if (i0 > n - 1) { last = lo = hi = m.deltaAt(n - 1) + shift; }
          else for (let i = Math.max(0, i0); i <= Math.min(i1, n - 1); i++) { lo = Math.min(lo, m.lowAt(i) + shift); hi = Math.max(hi, m.highAt(i) + shift); last = m.deltaAt(i) + shift; }
        }
      }
      if (join !== null && b > join) {
        this.seconds!.decimate(Math.max(a, join), b, 1, part);
        if (part[2] === part[2]) { lo = Math.min(lo, part[0]!); hi = Math.max(hi, part[1]!); last = part[2]!; }
      }
      if (last === last) { out[o] = lo; out[o + 1] = hi; out[o + 2] = last; } else { out[o] = NaN; out[o + 1] = NaN; out[o + 2] = NaN; }
    }
  }

  /** As FlowSeries.priceColumns: the price at the end of each column's slice, NaN where there is none. */
  priceColumns(from: number, to: number, columns: number, out: Float64Array): void {
    if (!this.#m || (this.join !== null && from >= this.join)) {
      if (this.seconds) this.seconds.priceColumns(from, to, columns, out); else out.fill(NaN, 0, columns);
      return;
    }
    const span = to - from;
    for (let c = 0; c < columns; c++) {
      const a = from + Math.floor(span * c / columns), b = Math.max(a + 1, from + Math.floor(span * (c + 1) / columns));
      out[c] = this.priceAt(b - 1);
    }
  }
}
