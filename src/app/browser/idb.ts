import type { Column, ColumnStore } from '../../shared/recorder.ts';
import type { FootprintMinuteRow, FootprintStore } from '../../shared/footprint.ts';
import { largestPrints, type Print, type PrintStore } from '../../shared/prints.ts';
import type { FlowMinuteRow, FlowStore } from '../../shared/flow.ts';
import { fullerColumn, fullerFlowMinute, fullerFootprintMinute } from '../../shared/recording-merge.ts';
import { peakOf, type AbsorptionGroup, type AbsorptionMinute, type AbsorptionStore } from '../../shared/absorption.ts';

/**
 * Recordings kept in this browser (IndexedDB): the same four stores the server keeps in SQLite. The recorders read everything they
 * need once at start (`load` is synchronous), so the database is read before the engine is built, and writes are queued and applied in
 * one transaction every half second or so. A write that fails turns writing off for the session rather than disturbing the live view.
 */

const VERSION = 3, WRITE_DELAY_MS = 500;
type Name = 'columns' | 'footprint' | 'prints' | 'flow' | 'absorption' | 'absorptionMinutes';
const STORES: Name[] = ['columns', 'footprint', 'prints', 'flow', 'absorption', 'absorptionMinutes'];
/** Absorption groups held in memory by the recorder (older ones are read on demand). */
const ABSORPTION_MEMORY_MS = 2 * 3_600_000;
interface AbsorptionRow { inst: string; t0: number; side: 'buy' | 'sell'; price: number; peak: number; steps: AbsorptionGroup['steps'] }
interface AbsorptionMinuteRow { inst: string; t: number; n: number; mean: number; m2: number; floor: number }
interface ColumnRow { inst: string; t: number; step: number; n: number; bins: Int32Array; bid: Float32Array; ask: Float32Array }
interface PrintRow extends Print { k: string }

/** `name` is the coin's database (app/coin.ts recordingsName): each coin's recordings are kept and read apart. */
function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Version 2 added the flow store, version 3 the absorption stores: an older database keeps what it has and gains only those.
      if (!db.objectStoreNames.contains('columns')) db.createObjectStore('columns', { keyPath: ['inst', 't'] }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('footprint')) db.createObjectStore('footprint', { keyPath: ['inst', 't'] }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('prints')) db.createObjectStore('prints', { keyPath: 'k' }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('flow')) db.createObjectStore('flow', { keyPath: ['inst', 't'] }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('absorption')) db.createObjectStore('absorption', { keyPath: ['inst', 't0', 'side', 'price'] }).createIndex('t', 't0');
      if (!db.objectStoreNames.contains('absorptionMinutes')) db.createObjectStore('absorptionMinutes', { keyPath: ['inst', 't'] }).createIndex('t', 't');
    };
    request.onsuccess = () => {
      const db = request.result;
      // A newer page that needs another version asks this one to let go; holding on would leave that page without recordings until this tab closes.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

/** Every row of a store whose time is at or after `since`, oldest first. */
function readSince<T>(db: IDBDatabase, name: Name, since: number): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const out: T[] = [], request = db.transaction(name, 'readonly').objectStore(name).index('t').openCursor(IDBKeyRange.lowerBound(since));
    request.onsuccess = () => { const cursor = request.result; if (cursor) { out.push(cursor.value as T); cursor.continue(); } else resolve(out); };
    request.onerror = () => reject(request.error);
  });
}

/** Structured clone keeps a typed array's whole buffer, so a view onto a larger one is copied out first. */
const own = <A extends Int32Array | Float32Array>(array: A): A => array.byteLength === array.buffer.byteLength ? array : array.slice() as A;

export interface Recordings {
  columns: ColumnStore; footprint: FootprintStore; prints: PrintStore; flow: FlowStore; absorption: AbsorptionStore;
  /** Apply what is queued now instead of at the next half second. */
  flush(): Promise<void>;
  close(): void;
}

/**
 * Open the database, read what is still inside the retention window, and return stores for the recorders. `canWrite` says whether this
 * tab is the one allowed to write (only one tab records, so two open pages do not write the same minutes twice).
 */
export async function openRecordings(name: string, since: number, canWrite: () => boolean, onError: (error: unknown) => void = () => {}): Promise<Recordings> {
  const db = await openDatabase(name);
  const absorptionSince = Math.max(since, Date.now() - ABSORPTION_MEMORY_MS);
  const [columnRows, footprintRows, printRows, flowRows, absorptionRows, absorptionMinuteRows] = await Promise.all([readSince<ColumnRow>(db, 'columns', since), readSince<FootprintMinuteRow>(db, 'footprint', since), readSince<PrintRow>(db, 'prints', since), readSince<FlowMinuteRow>(db, 'flow', since),
    readSince<AbsorptionRow>(db, 'absorption', absorptionSince), readSince<AbsorptionMinuteRow>(db, 'absorptionMinutes', absorptionSince)]);
  let queue: ((tx: IDBTransaction) => void)[] = [], timer: ReturnType<typeof setTimeout> | null = null, failed = false, closed = false;

  const prune = (tx: IDBTransaction, name: Name, before: number): void => {
    const store = tx.objectStore(name), request = store.index('t').openKeyCursor(IDBKeyRange.upperBound(before, true));
    request.onsuccess = () => { const cursor = request.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
  };
  const write = async (): Promise<void> => {
    timer = null;
    const ops = queue; queue = [];
    if (!ops.length || failed || closed) return;
    try {
      const tx = db.transaction(STORES, 'readwrite');
      for (const op of ops) op(tx);
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    } catch (error) { failed = true; onError(error); }
  };
  /**
   * Store `row` under `key` unless the row already there is the fuller one. Another tab may have been writing the same minutes (this one
   * took over when it closed), and this tab's copy of a minute it joined part-way through is thinner than what was stored: a plain put would
   * replace the whole with its tail. The read and the write are one transaction, so two writers cannot interleave.
   */
  const putFuller = <Row>(tx: IDBTransaction, name: Name, key: IDBValidKey, row: Row, fuller: (kept: Row | undefined, next: Row) => Row | null): void => {
    const store = tx.objectStore(name), request = store.get(key);
    request.onsuccess = () => { const chosen = fuller(request.result as Row | undefined, row); if (chosen) store.put(chosen); };
  };
  const enqueue = (op: (tx: IDBTransaction) => void): void => {
    if (failed || closed || !canWrite()) return;
    queue.push(op);
    if (!timer) timer = setTimeout(() => { void write(); }, WRITE_DELAY_MS);
  };

  const columns: ColumnStore = {
    load: () => columnRows.map(row => ({ instrumentId: row.inst, step: row.step, column: { t: row.t, n: row.n, bins: row.bins, bid: row.bid, ask: row.ask } satisfies Column })),
    save: (instrumentId, column, step) => enqueue(tx => {
      const row = { inst: instrumentId, t: column.t, step, n: column.n, bins: own(column.bins), bid: own(column.bid), ask: own(column.ask) } satisfies ColumnRow;
      putFuller<ColumnRow>(tx, 'columns', [instrumentId, column.t], row, fullerColumn);
    }),
    prune: before => enqueue(tx => prune(tx, 'columns', before)),
  };
  const footprint: FootprintStore = {
    load: () => footprintRows,
    save: (rows, expireBefore) => enqueue(tx => { for (const row of rows) putFuller<FootprintMinuteRow>(tx, 'footprint', [row.inst, row.t], row, fullerFootprintMinute); prune(tx, 'footprint', expireBefore); }),
    close: () => {},
  };
  // Every print still inside the retention window, by its key. The print stream keeps only the newest 20,000 in memory (that is all `load`
  // hands it), so a window further back than that is answered from here: the rows are in this worker already, read when the database opened.
  const printKey = (row: Print): string => `${row.id}|${row.t}|${row.price}|${row.usd}`;
  const everyPrint = new Map<string, PrintRow>(printRows.map(row => [row.k, row]));
  const prints: PrintStore = {
    load: (_since, limit) => printRows.slice(-limit),
    query: (from, to, minUsd, limit) => {
      const out: Print[] = [];
      for (const row of everyPrint.values()) if (row.t >= from && row.t < to && row.usd >= minUsd) out.push({ t: row.t, id: row.id, side: row.side, price: row.price, usd: row.usd, ...(row.n !== undefined && row.lo !== undefined && row.hi !== undefined ? { lo: row.lo, hi: row.hi, n: row.n } : {}) });
      out.sort((a, b) => a.t - b.t);
      // The largest `limit` are kept when more match, as the stream's contract says.
      return largestPrints(out, limit);
    },
    save: (rows, expireBefore) => {
      for (const row of rows) everyPrint.set(printKey(row), { ...row, k: printKey(row) });
      for (const [key, row] of everyPrint) if (row.t < expireBefore) everyPrint.delete(key);
      enqueue(tx => { const store = tx.objectStore('prints'); for (const row of rows) store.put({ ...row, k: printKey(row) } satisfies PrintRow); prune(tx, 'prints', expireBefore); });
    },
    close: () => {},
  };
  const flow: FlowStore = {
    load: () => flowRows,
    save: (rows, expireBefore) => enqueue(tx => {
      for (const row of rows) putFuller<FlowMinuteRow>(tx, 'flow', [row.inst, row.t], { inst: row.inst, t: row.t, buy: own(row.buy), sell: own(row.sell), ...(row.px ? { px: own(row.px) } : {}) }, fullerFlowMinute);
      prune(tx, 'flow', expireBefore);
    }),
    close: () => {},
  };
  // Absorption: the recorder holds the last two hours; older groups and minutes are read when the page asks for them, a cursor over the time index.
  const toGroup = (row: AbsorptionRow): AbsorptionGroup => ({ id: row.inst, side: row.side, price: row.price, t0: row.t0, steps: row.steps });
  const toMinute = (row: AbsorptionMinuteRow): AbsorptionMinute => ({ id: row.inst, t: row.t, n: row.n, mean: row.mean, m2: row.m2, floor: row.floor });
  const scan = <Row>(name: Name, from: number, to: number, keep: (row: Row) => boolean): Promise<Row[]> => new Promise((resolve, reject) => {
    const out: Row[] = [], range = IDBKeyRange.bound(from, Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER, false, true);
    const request = db.transaction(name, 'readonly').objectStore(name).index('t').openCursor(range);
    request.onsuccess = () => { const cursor = request.result; if (cursor) { const row = cursor.value as Row; if (keep(row)) out.push(row); cursor.continue(); } else resolve(out); };
    request.onerror = () => reject(request.error);
  });
  const absorption: AbsorptionStore = {
    load: () => ({ groups: absorptionRows.map(toGroup), minutes: absorptionMinuteRows.map(toMinute) }),
    save: (groups, minutes, expireBefore) => enqueue(tx => {
      const store = tx.objectStore('absorption'), perMinute = tx.objectStore('absorptionMinutes');
      for (const g of groups) store.put({ inst: g.id, t0: g.t0, side: g.side, price: g.price, peak: peakOf(g), steps: g.steps } satisfies AbsorptionRow);
      for (const m of minutes) perMinute.put({ inst: m.id, t: m.t, n: m.n, mean: m.mean, m2: m.m2, floor: m.floor } satisfies AbsorptionMinuteRow);
      prune(tx, 'absorption', expireBefore); prune(tx, 'absorptionMinutes', expireBefore);
    }),
    query: async (ids, mins, from, to, limit) => {
      const min = new Map(ids.map((id, i) => [id, mins[i] ?? Infinity]));
      const rows = await scan<AbsorptionRow>('absorption', from, to, row => row.peak >= (min.get(row.inst) ?? Infinity));
      const byId = new Map<string, AbsorptionRow[]>();
      for (const row of rows) { let list = byId.get(row.inst); if (!list) { list = []; byId.set(row.inst, list); } list.push(row); }
      return [...byId.values()].flatMap(list => list.sort((a, b) => b.peak - a.peak).slice(0, limit).map(toGroup));
    },
    minutes: async (ids, from, to) => { const wanted = new Set(ids); return (await scan<AbsorptionMinuteRow>('absorptionMinutes', from, to, row => wanted.has(row.inst))).map(toMinute); },
    close: () => {},
  };
  return {
    columns, footprint, prints, flow, absorption,
    flush() { if (timer) clearTimeout(timer); return write(); },
    close() { if (timer) clearTimeout(timer); void write().finally(() => { closed = true; db.close(); }); },
  };
}
