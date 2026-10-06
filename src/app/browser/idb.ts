import type { Column, ColumnStore } from '../../shared/recorder.ts';
import type { FootprintMinuteRow, FootprintStore } from '../../shared/footprint.ts';
import type { Print, PrintStore } from '../../shared/prints.ts';
import type { FlowMinuteRow, FlowStore } from '../../shared/flow.ts';

/**
 * Recordings kept in this browser (IndexedDB): the same four stores the server keeps in SQLite. The recorders read everything they
 * need once at start (`load` is synchronous), so the database is read before the engine is built, and writes are queued and applied in
 * one transaction every half second or so. A write that fails turns writing off for the session rather than disturbing the live view.
 */

const DB_NAME = 'lmf-recordings', VERSION = 2, WRITE_DELAY_MS = 500;
type Name = 'columns' | 'footprint' | 'prints' | 'flow';
interface ColumnRow { inst: string; t: number; step: number; n: number; bins: Int32Array; bid: Float32Array; ask: Float32Array }
interface PrintRow extends Print { k: string }

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Version 2 added the flow store: a database from version 1 keeps what it has and gains only that.
      if (!db.objectStoreNames.contains('columns')) db.createObjectStore('columns', { keyPath: ['inst', 't'] }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('footprint')) db.createObjectStore('footprint', { keyPath: ['inst', 't'] }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('prints')) db.createObjectStore('prints', { keyPath: 'k' }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('flow')) db.createObjectStore('flow', { keyPath: ['inst', 't'] }).createIndex('t', 't');
    };
    request.onsuccess = () => resolve(request.result);
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
  columns: ColumnStore; footprint: FootprintStore; prints: PrintStore; flow: FlowStore;
  /** Apply what is queued now instead of at the next half second. */
  flush(): Promise<void>;
  close(): void;
}

/**
 * Open the database, read what is still inside the retention window, and return stores for the recorders. `canWrite` says whether this
 * tab is the one allowed to write (only one tab records, so two open pages do not write the same minutes twice).
 */
export async function openRecordings(since: number, canWrite: () => boolean, onError: (error: unknown) => void = () => {}): Promise<Recordings> {
  const db = await openDatabase();
  const [columnRows, footprintRows, printRows, flowRows] = await Promise.all([readSince<ColumnRow>(db, 'columns', since), readSince<FootprintMinuteRow>(db, 'footprint', since), readSince<PrintRow>(db, 'prints', since), readSince<FlowMinuteRow>(db, 'flow', since)]);
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
      const tx = db.transaction(['columns', 'footprint', 'prints', 'flow'], 'readwrite');
      for (const op of ops) op(tx);
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    } catch (error) { failed = true; onError(error); }
  };
  const enqueue = (op: (tx: IDBTransaction) => void): void => {
    if (failed || closed || !canWrite()) return;
    queue.push(op);
    if (!timer) timer = setTimeout(() => { void write(); }, WRITE_DELAY_MS);
  };

  const columns: ColumnStore = {
    load: () => columnRows.map(row => ({ instrumentId: row.inst, step: row.step, column: { t: row.t, n: row.n, bins: row.bins, bid: row.bid, ask: row.ask } satisfies Column })),
    save: (instrumentId, column, step) => enqueue(tx => { tx.objectStore('columns').put({ inst: instrumentId, t: column.t, step, n: column.n, bins: own(column.bins), bid: own(column.bid), ask: own(column.ask) } satisfies ColumnRow); }),
    prune: before => enqueue(tx => prune(tx, 'columns', before)),
  };
  const footprint: FootprintStore = {
    load: () => footprintRows,
    save: (rows, expireBefore) => enqueue(tx => { const store = tx.objectStore('footprint'); for (const row of rows) store.put(row); prune(tx, 'footprint', expireBefore); }),
    close: () => {},
  };
  const prints: PrintStore = {
    load: (_since, limit) => printRows.slice(-limit),
    save: (rows, expireBefore) => enqueue(tx => { const store = tx.objectStore('prints'); for (const row of rows) store.put({ ...row, k: `${row.id}|${row.t}|${row.price}|${row.usd}` } satisfies PrintRow); prune(tx, 'prints', expireBefore); }),
    close: () => {},
  };
  const flow: FlowStore = {
    load: () => flowRows,
    save: (rows, expireBefore) => enqueue(tx => { const store = tx.objectStore('flow'); for (const row of rows) store.put({ inst: row.inst, t: row.t, buy: own(row.buy), sell: own(row.sell), ...(row.px ? { px: own(row.px) } : {}) } satisfies FlowMinuteRow); prune(tx, 'flow', expireBefore); }),
    close: () => {},
  };
  return {
    columns, footprint, prints, flow,
    flush() { if (timer) clearTimeout(timer); return write(); },
    close() { if (timer) clearTimeout(timer); void write().finally(() => { closed = true; db.close(); }); },
  };
}
