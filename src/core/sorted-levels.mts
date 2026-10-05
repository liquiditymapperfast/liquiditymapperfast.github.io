/**
 * Book sides built by this codebase are strictly best-first by construction (merged into a sorted array or sorted once).
 * Recording that lets later messages skip re-verifying order and read price bounds off the ends instead of scanning
 * thousands of levels on every update. A side that is not recorded here is simply verified or scanned as before.
 */
const bestFirst = new WeakMap<object, boolean>();

/** Mark `rows` as strictly best-first: descending prices for bids, ascending for asks. Returns `rows`. */
export function markBestFirst<T extends object>(rows: T, descending: boolean): T { bestFirst.set(rows, descending); return rows; }

/** True when `rows` is recorded as strictly best-first in the given direction. */
export function isBestFirst(rows: object, descending: boolean): boolean { return bestFirst.get(rows) === descending; }

/** The recorded direction (true = descending), or undefined when `rows` is not known to be sorted. */
export function bestFirstDirection(rows: object): boolean | undefined { return bestFirst.get(rows); }
