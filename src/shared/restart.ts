import { FLOW_SEC, type FlowRecorder } from './flow.ts';
import type { FootprintRecorder } from './footprint.ts';

const MINUTE = 60_000;

/**
 * How far the recordings reach, per instrument, when a process starts: a trade stamped at or before it was counted by the run that
 * recorded it. Some venues send their recent trades again when a feed connects (dYdX sends hundreds, hours of them), and the duplicate
 * checks are in memory, so a restart used to add those trades a second time to minutes already written: the footprint, the flow, the
 * bubbles and absorption all counted them twice. Taken from the flow recorder's seconds (the end of the last second with a trade), or, for
 * an instrument it does not hold, the footprint's minutes (the end of the last minute with a trade). Trades after that, a gap's backfill
 * among them, count as ever. Build it before the first trade arrives: it reads what was loaded, not what is recorded since.
 */
export class RecordedBefore {
  readonly #until = new Map<string, number>();

  constructor(flow: Pick<FlowRecorder, 'instruments' | 'lastSecond'>, footprint: Pick<FootprintRecorder, 'instruments' | 'lastMinute'>) {
    for (const id of new Set([...flow.instruments, ...footprint.instruments])) {
      const second = flow.lastSecond(id), minute = footprint.lastMinute(id);
      // The second is the finer mark; the minute stands in when the flow holds nothing as late (an instrument past its limit).
      const until = second > 0 && second >= minute ? second + FLOW_SEC - 1 : minute > 0 ? minute + MINUTE - 1 : 0;
      if (until > 0) this.#until.set(id, until);
    }
  }

  /** Whether a trade of `id` stamped `t` is one the recordings already hold. */
  holds(id: string, t: number): boolean {
    const until = this.#until.get(id);
    return until !== undefined && t <= until;
  }
}
