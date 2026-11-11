import { usableEpoch, usableStep, type ValuedBook } from '../../shared/levels.ts';
import type { LevelsFrame, SideArrays } from '../wire.ts';

/** Structured clone keeps a typed array's whole buffer, so a view onto a larger one is copied out first. */
const compact = (array: Float64Array): Float64Array => array.byteLength === array.buffer.byteLength ? array : array.slice();
function side(levels: ValuedBook['bids']): SideArrays {
  const lo = compact(levels.lo);
  // Point levels share one array for both edges; keep it shared so it is sent once.
  return { lo, hi: levels.hi === levels.lo ? lo : compact(levels.hi), usd: compact(levels.usd) };
}

/**
 * The page's levels frame from the engine's valued books: the arrays the server's `encodeLevels` puts on its wire, posted by the feeds
 * worker instead. `touch`, `step` and `epoch` go with a book that has them (`ValuedBook.touch`, `ValuedBook.step`, `ValuedBook.epoch`, the step only as a usable number,
 * as the wire sends it), so the page reads the same book from either source.
 */
export function frameOf(books: readonly ValuedBook[], asOf: number): LevelsFrame {
  return { asOf, books: books.map(b => ({ id: b.instrumentId, venue: b.venue, timestamp: b.timestamp, coarse: b.coarse, bids: side(b.bids), asks: side(b.asks), ...(b.touch ? { touch: b.touch } : {}), ...(usableStep(b.step) ? { step: b.step } : {}), ...(usableEpoch(b.epoch) ? { epoch: b.epoch } : {}) })) };
}
