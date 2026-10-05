/**
 * The stretch of time a candle is drawn over. A closed candle covers its whole slot, centred in it. The one still forming covers only
 * what has happened so far (its start up to now), so it sits where its own trades are and fills its slot as the period goes on, instead
 * of being centred on a future that the trades have not reached: the newest trade bubbles then land on the newest candle, not behind it.
 * When the period ends the two are the same, so nothing jumps.
 */
export interface CandleSpan { from: number; to: number; forming: boolean }

export function candleSpan(start: number, tfMs: number, now: number): CandleSpan {
  const end = start + tfMs;
  if (now >= end) return { from: start, to: end, forming: false };
  // A clock a little behind the exchange's would put "now" before the start: keep a sliver so the candle still has somewhere to be.
  return { from: start, to: Math.max(start + 1, now), forming: true };
}
