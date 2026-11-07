import test from 'node:test';
import assert from 'node:assert/strict';
import { openRecordings } from '../src/app/browser/idb.ts';

/**
 * A returning page reads its recordings back newest first (app/browser/idb.ts `openRecordings`, `head`): the map's newest minutes are asked
 * for alone and handed over before anything else is asked, and the rest of the day after them, so the whole is read once, oldest first,
 * with no minute twice at the cut. Against an IndexedDB stand-in that answers each request a task later, in the order asked, as Chromium does.
 */

const MIN = 60_000, HOUR = 60 * MIN;

/** A key range on the time index, with the browser's refusal of an empty bound. */
class Range {
  constructor(readonly lower: number, readonly upper: number, readonly lowerOpen: boolean, readonly upperOpen: boolean) {}
  includes(t: number): boolean { return (this.lowerOpen ? t > this.lower : t >= this.lower) && (this.upperOpen ? t < this.upper : t <= this.upper); }
}
const keyRange = {
  bound: (lower: number, upper: number, lowerOpen = false, upperOpen = false): Range => {
    if (lower > upper || (lower === upper && (lowerOpen || upperOpen))) throw new DOMException('the range is empty', 'DataError');
    return new Range(lower, upper, lowerOpen, upperOpen);
  },
  lowerBound: (lower: number, open = false): Range => new Range(lower, Infinity, open, false),
  upperBound: (upper: number, open = false): Range => new Range(-Infinity, upper, false, open),
};

interface Row { inst: string; t: number; [key: string]: unknown }
/** The stores' rows and every request made, in order. */
function standIn(rows: Record<string, Row[]>, asked: { store: string; lower: number; upper: number }[]) {
  const request = <T,>(result: () => T) => {
    const r: { result?: T; onsuccess: (() => void) | null; onerror: (() => void) | null } = { onsuccess: null, onerror: null };
    setTimeout(() => { r.result = result(); r.onsuccess?.(); }, 0);
    return r;
  };
  const db = {
    objectStoreNames: { contains: () => true },
    onversionchange: null as unknown, onclose: null as unknown,
    close() {},
    transaction: () => ({
      objectStore: (store: string) => ({
        index: () => ({
          getAll: (range: Range) => {
            asked.push({ store, lower: range.lower, upper: range.upper });
            return request(() => (rows[store] ?? []).filter(row => range.includes(row.t)).sort((a, b) => a.t - b.t));
          },
        }),
      }),
    }),
  };
  return { open: () => request(() => db) };
}

test('the map\'s newest minutes are read first and alone, handed over, then the rest: the day once, oldest first, nothing twice at the cut', async () => {
  const now = Date.now(), since = now - 24 * HOUR, cut = Math.floor((now - 3 * HOUR) / MIN) * MIN;
  const column = (inst: string, t: number): Row => ({ inst, t, step: 10, n: 12, bins: Int32Array.of(1), bid: Float32Array.of(1), ask: Float32Array.of(0) });
  const times = [cut - 5 * HOUR, cut - MIN, cut, cut + MIN, Math.floor(now / MIN) * MIN - MIN];
  const rows = { columns: ['a:BTC', 'b:BTC'].flatMap(inst => times.map(t => column(inst, t))) };
  const asked: { store: string; lower: number; upper: number }[] = [];
  const realDb = (globalThis as { indexedDB?: unknown }).indexedDB, realRange = (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange, info = console.info;
  Object.assign(globalThis, { indexedDB: standIn(rows, asked), IDBKeyRange: keyRange });
  console.info = () => {};
  try {
    // (`take` runs inside the read's own try: what it saw is checked after.)
    let handed: number[] = [], askedWhenHanded = -1, opened = false, openedWhenHanded: boolean | null = null;
    const recordings = await openRecordings('test', since, () => false, {}, { since: cut, take: columns => { handed = columns.map(c => c.column.t); askedWhenHanded = asked.length; openedWhenHanded = opened; } });
    opened = true;
    assert.deepEqual(asked[0], { store: 'columns', lower: cut, upper: Infinity }, 'the newest minutes are the first request');
    assert.equal(askedWhenHanded, 1, 'and handed over before anything else is asked');
    assert.equal(openedWhenHanded, false, 'before the recordings are given back');
    assert.deepEqual(handed, [cut, cut, cut + MIN, cut + MIN, times[4], times[4]], 'from the cut on, the minute at the cut among them');
    assert.deepEqual(asked.filter(a => a.store === 'columns').slice(1), [{ store: 'columns', lower: since, upper: cut }], 'the rest of the day up to the cut');
    const day = [...recordings.columns.load(since)].map(c => c.column.t);
    assert.deepEqual(day, times.flatMap(t => [t, t]), 'the whole day once, oldest first');
    // A head that reaches back past the retention reads the day as the newest and asks nothing before it (an empty range would throw).
    asked.length = 0;
    await openRecordings('test', since, () => false, {}, { since: since - HOUR, take: () => {} });
    assert.deepEqual(asked.filter(a => a.store === 'columns'), [{ store: 'columns', lower: since, upper: Infinity }]);
  } finally {
    Object.assign(globalThis, { indexedDB: realDb, IDBKeyRange: realRange });
    console.info = info;
  }
});
