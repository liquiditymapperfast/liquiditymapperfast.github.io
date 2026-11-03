import type { Column, ColumnStore } from '../../shared/recorder.ts';
import type { FootprintMinuteRow, FootprintStore } from '../../shared/footprint.ts';
import { largestPrints, type Print, type PrintStore } from '../../shared/prints.ts';
import type { FlowMinuteRow, FlowStore } from '../../shared/flow.ts';
import { fullerColumn, fullerFlowMinute, fullerFootprintMinute } from '../../shared/recording-merge.ts';
import { hoursOf, peakOf, type AbsorptionGroup, type AbsorptionMinute, type AbsorptionStore } from '../../shared/absorption.ts';
import type { CoverageRow, CoverageStore } from '../../shared/coverage.ts';
import { largestLiquidations, liquidationKey, type Liquidation, type LiquidationStore } from '../../shared/liquidations.ts';
import type { OiReading, OiStore } from '../../shared/engine.ts';
import { clipCoverage, ownsTime, planAbsorption, planCoverage, planFootprint, tradeImport, type HistoryRows } from './history-import.ts';

/**
 * Recordings kept in this browser (IndexedDB): the same four stores the server keeps in SQLite. The recorders read everything they
 * need once at start (`load` is synchronous), so the database is read before the recorders are built (an engine that started without them
 * builds them again when they come: shared/engine.ts `attach`), and writes are queued and applied every half second or so, in short
 * transactions (`SLICE_MS`). A write that fails is let go and writing is tried again after a growing pause (the connection
 * opened again if the browser closed it), so a page open for days keeps saving; only a newer page taking the database over ends it.
 */

const VERSION = 6, WRITE_DELAY_MS = 500;
type Name = 'columns' | 'footprint' | 'prints' | 'flow' | 'absorption' | 'absorptionMinutes' | 'coverage' | 'liquidations' | 'oi';
const STORES: Name[] = ['columns', 'footprint', 'prints', 'flow', 'absorption', 'absorptionMinutes', 'coverage', 'liquidations', 'oi'];
/** Absorption groups read when the database opens: the recorder starts with these and reads the rest of its day back after (`AbsorptionRecorder.hydrate`). */
const ABSORPTION_MEMORY_MS = 2 * 3_600_000;
interface AbsorptionRow { inst: string; t0: number; side: 'buy' | 'sell'; price: number; peak: number; steps: AbsorptionGroup['steps'] }
interface AbsorptionMinuteRow { inst: string; t: number; n: number; mean: number; m2: number; floor: number }
/** `lt`/`ltN`: the Liquidity Tracker kept with the minute (`Column.lt`), absent in rows written before it was kept. */
interface ColumnRow { inst: string; t: number; step: number; n: number; bins: Int32Array; bid: Float32Array; ask: Float32Array; lt?: Float32Array; ltN?: number }
interface PrintRow extends Print { k: string }
interface LiquidationRow extends Liquidation { k: string }
/** An open-interest reading (shared/engine.ts `OiReading`): about one a minute for each of six venues, some 8,600 a day. */
type OiRow = OiReading;
/**
 * A stretch of the coverage record, with its end as `t` (the time index every store prunes by). Metric `history` (never handed to the
 * recorders) marks an hour of the recorded history read whole (`markImported`): an hour already taken is not read again.
 */
interface CoverRow extends Omit<CoverageRow, 'metric'> { metric: CoverageRow['metric'] | 'history'; t: number }
/**
 * The mark of an hour of the recorded history read whole is a coverage row of metric `history` whose instrument names the reader's version:
 * `v2` reads the footprint and absorption too. An hour an older page read (instrument '') is read again once, for what that page passed over.
 */
const IMPORTED = 'history', IMPORTED_INST = 'v2', HOUR = 3_600_000, MINUTE = 60_000;

/** `name` is the coin's database (app/coin.ts recordingsName): each coin's recordings are kept and read apart. */
function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Version 2 added the flow store, version 3 the absorption stores, version 4 the coverage record, version 5 the liquidations, version 6
      // the open-interest readings: an older
      // database keeps what it has and gains only those.
      if (!db.objectStoreNames.contains('columns')) db.createObjectStore('columns', { keyPath: ['inst', 't'] }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('footprint')) db.createObjectStore('footprint', { keyPath: ['inst', 't'] }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('prints')) db.createObjectStore('prints', { keyPath: 'k' }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('flow')) db.createObjectStore('flow', { keyPath: ['inst', 't'] }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('absorption')) db.createObjectStore('absorption', { keyPath: ['inst', 't0', 'side', 'price'] }).createIndex('t', 't0');
      if (!db.objectStoreNames.contains('absorptionMinutes')) db.createObjectStore('absorptionMinutes', { keyPath: ['inst', 't'] }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('coverage')) db.createObjectStore('coverage', { keyPath: ['inst', 'metric', 'from'] }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('liquidations')) db.createObjectStore('liquidations', { keyPath: 'k' }).createIndex('t', 't');
      if (!db.objectStoreNames.contains('oi')) db.createObjectStore('oi', { keyPath: ['venue', 't'] }).createIndex('t', 't');
    };
    request.onsuccess = () => {
      const db = request.result;
      // A newer page that needs another version asks this one to let go; holding on would leave that page without recordings until this tab closes.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
    // An older page holds the database open at its version: the request waits, and succeeds once that page lets go (each page closes its
    // connection when asked, `onversionchange` above). Giving up here kept the recordings from this page even when it let go a moment later.
    request.onblocked = () => console.warn('the recordings wait for another tab of this page to let go of them');
  });
}

/** `work`, or `late` once it has taken `ms`. */
const withTimeout = <T>(work: Promise<T>, ms: number, late: Error): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(late), ms))]);
/** How long the database may take to open: a tab that never lets go of it would otherwise keep this page without recordings and without a word. */
const OPEN_TIMEOUT_MS = 10_000;
/** After a failed write the next waits twice as long each time, up to this. */
const RETRY_MAX_MS = 60_000;
/**
 * How long a write issues its requests before that slice is committed and the rest waits for the next task. The worker that writes runs
 * the live feeds too: the recorded history read in made batches of thousands of requests, each holding the book and the flow still for
 * most of a second (2026-11-03).
 */
const SLICE_MS = 8;
/** At most this many rows are put by one queued write (`SLICE_MS` can cut only between writes). */
const PUTS_PER_WRITE = 250;

/**
 * What becomes of the writing: `failed` after a write that did not go through (`fatal`: a newer page took the database over, and this one
 * writes no more), `recovered` when a write goes through again after failures.
 */
export interface RecordingEvents { failed?: (error: unknown, fatal: boolean) => void; recovered?: () => void }

/**
 * Every row of a store whose time is at or after `since`, oldest first: one request for all of them. A cursor walked them one round trip a
 * row, and a day of the default venues' minutes read that way outlasted the time the page gave the recordings to open, so the page started
 * with none and saved none (2026-10-19).
 */
function readSince<T>(db: IDBDatabase, name: Name, since: number): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(name, 'readonly').objectStore(name).index('t').getAll(IDBKeyRange.lowerBound(since));
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

/** Structured clone keeps a typed array's whole buffer, so a view onto a larger one is copied out first. */
const own = <A extends Int32Array | Float32Array>(array: A): A => array.byteLength === array.buffer.byteLength ? array : array.slice() as A;

export interface Recordings {
  columns: ColumnStore; footprint: FootprintStore; prints: PrintStore; flow: FlowStore; absorption: AbsorptionStore; coverage: CoverageStore; liquidations: LiquidationStore; oi: OiStore;
  /**
   * Adds minutes recorded elsewhere (the recorded history, app/browser/history-import.ts) before the recorders start: each joins what `load`
   * hands them, in place of a thinner copy of the same minute, and is stored as this tab's own recordings are. Returns how many it took.
   */
  importColumns(columns: readonly { inst: string; step: number; column: Column }[]): number;
  /**
   * The same for the other recordings: a flow minute joins second by second where it is the fuller copy, a liquidation or an open-interest
   * reading the page does not hold is added, a large trade only outside the stretches this page recorded itself (where its own are the ones
   * to keep: an order rebuilt from the same fills elsewhere may differ in its price), a footprint minute or an absorption minute (with its
   * groups) only where this page did not record the whole minute itself; the service's stretches of trade coverage join the page's own for
   * the instruments whose footprint minutes were taken (see `importRows`).
   */
  importRows(rows: HistoryRows): number;
  /** The hours of the recorded history read whole (kept as the coverage record is, so they go with it), and marking more. */
  importedHours(): number[];
  /** `since`: `writeEpoch()` before the import; the hours are marked only when every write since went through. */
  markImported(hours: readonly number[], since: number): Promise<void>;
  writeEpoch(): number;
  /** Apply what is queued now instead of at the next half second. */
  flush(): Promise<void>;
  close(): void;
}

/**
 * Open the database, read what is still inside the retention window, and return stores for the recorders. `canWrite` says whether this
 * tab is the one allowed to write (only one tab records, so two open pages do not write the same minutes twice).
 */
export async function openRecordings(name: string, since: number, canWrite: () => boolean, events: RecordingEvents = {}): Promise<Recordings> {
  // Only the opening is timed: reading a day back takes as long as it takes (it is what the page is for), and a page that gave up on it
  // started with nothing and saved nothing.
  let db = await withTimeout(openDatabase(name), OPEN_TIMEOUT_MS, new Error(`opening the recordings took longer than ${OPEN_TIMEOUT_MS} ms`));
  /** The connection was closed under this page (by the browser, or for a newer page): it is opened again before the next write. */
  let lost = false;
  const watch = (connection: IDBDatabase): void => { connection.onclose = () => { lost = true; }; };
  watch(db);
  const absorptionSince = Math.max(since, Date.now() - ABSORPTION_MEMORY_MS), started = performance.now();
  const [columnRows, footprintRows, printRows, flowRows, absorptionRows, absorptionMinuteRows, coverRows, liquidationRows, oiRows] = await Promise.all([readSince<ColumnRow>(db, 'columns', since), readSince<FootprintMinuteRow>(db, 'footprint', since), readSince<PrintRow>(db, 'prints', since), readSince<FlowMinuteRow>(db, 'flow', since),
    readSince<AbsorptionRow>(db, 'absorption', absorptionSince), readSince<AbsorptionMinuteRow>(db, 'absorptionMinutes', absorptionSince), readSince<CoverRow>(db, 'coverage', since), readSince<LiquidationRow>(db, 'liquidations', since), readSince<OiRow>(db, 'oi', since)]);
  console.info(`recordings read back in ${Math.round(performance.now() - started)} ms: ${columnRows.length} map minutes, ${footprintRows.length} footprint minutes, ${printRows.length} trades, ${liquidationRows.length} liquidations, ${oiRows.length} open-interest readings`);
  let queue: ((tx: IDBTransaction) => void)[] = [], timer: ReturnType<typeof setTimeout> | null = null, failed = false, closed = false, failures = 0;
  // Counts every write let go (not this tab's to make, or a batch that failed): a mark that an hour was imported is kept only when nothing
  // was let go while it was imported (`markImported`). `writing` is the batch in flight.
  let epoch = 0, writing: Promise<void> = Promise.resolve();
  const schedule = (): void => { if (!timer) timer = setTimeout(() => { void write(); }, failures ? Math.min(RETRY_MAX_MS, WRITE_DELAY_MS * 2 ** failures) : WRITE_DELAY_MS); };

  const prune = (tx: IDBTransaction, name: Name, before: number): void => {
    const store = tx.objectStore(name), request = store.index('t').openKeyCursor(IDBKeyRange.upperBound(before, true));
    request.onsuccess = () => { const cursor = request.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
  };
  const write = (): Promise<void> => { const run = writing.then(writeNow); writing = run; return run; };
  /** A batch is written a slice at a time (`SLICE_MS`), each slice its own transaction. */
  const writeNow = async (): Promise<void> => {
    timer = null;
    const ops = queue; queue = [];
    if (!ops.length || failed || closed) return;
    try {
      if (lost) {
        try { db = await withTimeout(openDatabase(name), OPEN_TIMEOUT_MS, new Error(`opening the recordings again took longer than ${OPEN_TIMEOUT_MS} ms`)); }
        catch (error) {
          // A newer page has moved the database to its version: that page records now, and this one lets go for good.
          if (error instanceof DOMException && error.name === 'VersionError') { failed = true; events.failed?.(error, true); return; }
          throw error;
        }
        lost = false; watch(db);
      }
      for (let at = 0; at < ops.length;) {
        const tx = db.transaction(STORES, 'readwrite'), started = performance.now();
        do ops[at++]!(tx); while (at < ops.length && performance.now() - started < SLICE_MS);
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      }
      if (failures) { failures = 0; events.recovered?.(); }
    } catch (error) {
      // The batch is let go (what it held stays on screen, and a minute that changes again is written again) and writing goes on after a
      // pause that grows. One failed write used to end saving for the session, so a page left open for days could reload to nothing.
      if (error instanceof DOMException && error.name === 'InvalidStateError') lost = true;
      failures++; epoch++;
      events.failed?.(error, false);
      if (queue.length) schedule();
    }
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
    if (failed || closed || !canWrite()) { epoch++; return; }
    queue.push(op);
    schedule();
  };

  const columns: ColumnStore = {
    load: () => columnRows.map(row => ({ instrumentId: row.inst, step: row.step, column: {
      t: row.t, n: row.n, bins: row.bins, bid: row.bid, ask: row.ask, ...(row.lt instanceof Float32Array && (row.ltN ?? 0) > 0 ? { lt: row.lt, ltN: row.ltN! } : {}) } satisfies Column })),
    save: (instrumentId, column, step) => enqueue(tx => {
      const row = { inst: instrumentId, t: column.t, step, n: column.n, bins: own(column.bins), bid: own(column.bid), ask: own(column.ask),
        ...(column.lt && (column.ltN ?? 0) > 0 ? { lt: own(column.lt), ltN: column.ltN! } : {}) } satisfies ColumnRow;
      // The fuller copy wins; if it has no tracker (a tab on an older page) the other copy's tracker stays with the minute.
      putFuller<ColumnRow>(tx, 'columns', [instrumentId, column.t], row, (kept, next) => {
        const fuller = fullerColumn(kept, next), winner = fuller ?? kept!, loser = fuller ? kept : next;
        return !winner.lt && loser?.lt && (loser.ltN ?? 0) > 0 ? { ...winner, lt: loser.lt, ltN: loser.ltN! } : fuller;
      });
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
    each: (since, minUsd, take) => { for (const row of everyPrint.values()) if (row.t >= since && row.usd >= minUsd) take({ t: row.t, id: row.id, side: row.side, price: row.price, usd: row.usd }); },
    eachIn: (from, to, take) => { for (const row of everyPrint.values()) if (row.t >= from && row.t < to) take({ t: row.t, id: row.id, side: row.side, price: row.price, usd: row.usd }); },
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
      // A few hundred to a write: an hour of the recorded history brings thousands, and a write is cut into slices only between them.
      for (let i = 0; i < rows.length; i += PUTS_PER_WRITE) {
        const part = rows.slice(i, i + PUTS_PER_WRITE);
        enqueue(tx => { const store = tx.objectStore('prints'); for (const row of part) store.put({ ...row, k: printKey(row) } satisfies PrintRow); });
      }
      enqueue(tx => prune(tx, 'prints', expireBefore));
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
  // Absorption: the recorder opens with the last two hours and reads the rest of its day back in the background; until then older groups
  // and minutes are read when the page asks for them. Either way an hour of the time index at a time, one request each. A cursor walked them one round trip a row: a day of 100,000 groups took 1.9 s that way, 0.9 s in one
  // request (Chromium, 2026-10-19), and an hour holds at most the per-minute cap's 600 groups an instrument, so no request holds a day.
  const toGroup = (row: AbsorptionRow): AbsorptionGroup => ({ id: row.inst, side: row.side, price: row.price, t0: row.t0, steps: row.steps });
  const toMinute = (row: AbsorptionMinuteRow): AbsorptionMinute => ({ id: row.inst, t: row.t, n: row.n, mean: row.mean, m2: row.m2, floor: row.floor });
  /** The ranges of [from, to) an hour at a time, from the retention's start on; a range reaching past the next hour (or open) is read in one. */
  const hourRanges = (from: number, to: number): IDBKeyRange[] => {
    const out: IDBKeyRange[] = [], start = Math.max(from, since), end = Math.min(to, Date.now() + 3_600_000);
    for (const hour of hoursOf(start, end)) out.push(IDBKeyRange.bound(hour.from, hour.to, false, true));
    const rest = Math.max(start, end);
    if (to > rest) out.push(IDBKeyRange.bound(rest, Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER, false, true));
    return out;
  };
  /** Each range's rows, with the range's own bounds [lo, hi). */
  const readHours = async <Row>(name: Name, from: number, to: number, take: (rows: Row[], lo: number, hi: number) => void): Promise<void> => {
    for (const range of hourRanges(from, to)) take(await new Promise<Row[]>((resolve, reject) => {
      const request = db.transaction(name, 'readonly').objectStore(name).index('t').getAll(range);
      request.onsuccess = () => resolve(request.result as Row[]);
      request.onerror = () => reject(request.error);
    }), range.lower as number, range.upper as number);
  };
  /**
   * Absorption minutes taken from the recorded history, with their groups (`inst|minute`), kept for the session: the recorder reads what is
   * older than its first two hours back from the store (`eachHour`, `query`, `minutes`), and a tab that may not write never stores them.
   * Every read lays them over what the store answers: the store's rows of such a minute (the page's own part of it, or the same rows once
   * written) give way to them.
   */
  const overlay = new Map<string, { minute: AbsorptionMinute; groups: AbsorptionGroup[] }>();
  const minuteKey = (inst: string, t: number): string => `${inst}|${Math.floor(t / MINUTE) * MINUTE}`;
  const groupRow = (g: AbsorptionGroup): AbsorptionRow => ({ inst: g.id, t0: g.t0, side: g.side, price: g.price, peak: peakOf(g), steps: g.steps });
  const minuteRow = (m: AbsorptionMinute): AbsorptionMinuteRow => ({ inst: m.id, t: m.t, n: m.n, mean: m.mean, m2: m.m2, floor: m.floor });
  const overlaid = (groups: readonly AbsorptionRow[], from: number, to: number, minutes: readonly AbsorptionMinuteRow[] = []): { groups: AbsorptionRow[]; minutes: AbsorptionMinuteRow[] } => {
    if (!overlay.size) return { groups: [...groups], minutes: [...minutes] };
    const outGroups = groups.filter(row => !overlay.has(minuteKey(row.inst, row.t0))), outMinutes = minutes.filter(row => !overlay.has(minuteKey(row.inst, row.t)));
    for (const { minute, groups: list } of overlay.values()) {
      if (minute.t >= from && minute.t < to) outMinutes.push(minuteRow(minute));
      for (const g of list) if (g.t0 >= from && g.t0 < to) outGroups.push(groupRow(g));
    }
    return { groups: outGroups, minutes: outMinutes };
  };
  const absorption: AbsorptionStore = {
    load: () => ({ groups: absorptionRows.map(toGroup), minutes: absorptionMinuteRows.map(toMinute) }),
    save: (groups, minutes, expireBefore) => enqueue(tx => {
      const store = tx.objectStore('absorption'), perMinute = tx.objectStore('absorptionMinutes');
      for (const g of groups) store.put({ inst: g.id, t0: g.t0, side: g.side, price: g.price, peak: peakOf(g), steps: g.steps } satisfies AbsorptionRow);
      for (const m of minutes) perMinute.put({ inst: m.id, t: m.t, n: m.n, mean: m.mean, m2: m.m2, floor: m.floor } satisfies AbsorptionMinuteRow);
      prune(tx, 'absorption', expireBefore); prune(tx, 'absorptionMinutes', expireBefore);
    }),
    query: async (ids, mins, from, to, limit) => {
      const min = new Map(ids.map((id, i) => [id, mins[i] ?? Infinity])), byId = new Map<string, AbsorptionRow[]>();
      const take = (row: AbsorptionRow): void => { if (row.peak >= (min.get(row.inst) ?? Infinity)) { let list = byId.get(row.inst); if (!list) { list = []; byId.set(row.inst, list); } list.push(row); } };
      await readHours<AbsorptionRow>('absorption', from, to, (rows, lo, hi) => { for (const row of overlaid(rows, lo, hi).groups) take(row); });
      return [...byId.values()].flatMap(list => list.sort((a, b) => b.peak - a.peak).slice(0, limit).map(toGroup));
    },
    minutes: async (ids, from, to) => {
      const wanted = new Set(ids), out: AbsorptionMinute[] = [];
      await readHours<AbsorptionMinuteRow>('absorptionMinutes', from, to, (rows, lo, hi) => { for (const row of overlaid([], lo, hi, rows).minutes) if (wanted.has(row.inst)) out.push(toMinute(row)); });
      return out;
    },
    // The column's read, and the recorder's reading its day back (`ids` null): each hour's groups and minutes in one transaction, so they are
    // of one moment of the store.
    eachHour: async (ids, mins, from, to, take) => {
      const min = ids ? new Map(ids.map((id, i) => [id, mins[i] ?? Infinity])) : null;
      const passes = (inst: string, value: number): boolean => !min || value >= (min.get(inst) ?? Infinity);
      for (const range of hourRanges(from, to)) {
        const [rows, minuteRows] = await new Promise<[AbsorptionRow[], AbsorptionMinuteRow[]]>((resolve, reject) => {
          const tx = db.transaction(['absorption', 'absorptionMinutes'], 'readonly');
          const groups = tx.objectStore('absorption').index('t').getAll(range), minutes = tx.objectStore('absorptionMinutes').index('t').getAll(range);
          tx.oncomplete = () => resolve([groups.result as AbsorptionRow[], minutes.result as AbsorptionMinuteRow[]]);
          const failed = (): void => reject(tx.error ?? new Error('the absorption read was aborted'));
          tx.onerror = failed; tx.onabort = failed;
        });
        const groups: AbsorptionGroup[] = [], minutes: AbsorptionMinute[] = [], held = overlaid(rows, range.lower as number, range.upper as number, minuteRows);
        for (const row of held.groups) if (passes(row.inst, row.peak)) groups.push(toGroup(row));
        for (const row of held.minutes) if (passes(row.inst, row.floor)) minutes.push(toMinute(row));
        take(groups, minutes);
      }
    },
    close: () => {},
  };
  // The coverage record: a stretch is written again as it grows (its start is its key), cut at the minute still open (shared/coverage.ts).
  const coverage: CoverageStore = {
    load: () => coverRows.flatMap(({ t: _t, ...row }) => row.metric === IMPORTED ? [] : [row as CoverageRow]),
    save: (rows, expireBefore) => enqueue(tx => { const store = tx.objectStore('coverage'); for (const row of rows) store.put({ ...row, t: row.to } satisfies CoverRow); prune(tx, 'coverage', expireBefore); }),
    close: () => {},
  };
  // Liquidations, kept as the prints are: every one inside the retention, by the content it is known by (shared/liquidations.ts). They are
  // few (BTC on the server: 900 to 3,500 a day across the venues, 2026-10-12 to 19), so a day of them is a small part of what is kept.
  const toLiquidation = ({ k: _k, ...row }: LiquidationRow): Liquidation => row;
  const everyLiquidation = new Map<string, LiquidationRow>(liquidationRows.map(row => [row.k, row]));
  const liquidations: LiquidationStore = {
    load: (_since, limit) => liquidationRows.slice(-limit).map(toLiquidation),
    query: (from, to, minUsd, limit) => {
      const out: Liquidation[] = [];
      for (const row of everyLiquidation.values()) if (row.t >= from && row.t < to && row.usd >= minUsd) out.push(toLiquidation(row));
      out.sort((a, b) => a.t - b.t);
      return largestLiquidations(out, limit);
    },
    save: (rows, expireBefore) => {
      for (const row of rows) everyLiquidation.set(liquidationKey(row), { ...row, k: liquidationKey(row) });
      for (const [key, row] of everyLiquidation) if (row.t < expireBefore) everyLiquidation.delete(key);
      enqueue(tx => { const store = tx.objectStore('liquidations'); for (const row of rows) store.put({ ...row, k: liquidationKey(row) } satisfies LiquidationRow); prune(tx, 'liquidations', expireBefore); });
    },
    close: () => {},
  };
  // Open-interest readings, one a venue a minute: read at start, each new one written as it comes.
  const oi: OiStore = {
    load: () => oiRows,
    save: (rows, expireBefore) => enqueue(tx => { const store = tx.objectStore('oi'); for (const row of rows) store.put({ ...row } satisfies OiRow); prune(tx, 'oi', expireBefore); }),
    close: () => {},
  };
  // What the import of the trade side judges by (history-import.ts `TradeImport`): taken now, before anything is imported.
  const trade = tradeImport(coverRows, footprintRows);
  /**
   * The hours read in this import, those of them whose file held footprint minutes, each market's first footprint minute in them (on its
   * step), and the service's stretches waiting to join the page's coverage.
   */
  const hoursRead = new Set<number>(), footprintHours = new Set<number>(), firstFootprint = new Map<string, number>(), pendingCover: CoverageRow[] = [];
  const footprintAt = new Map<string, number>();
  footprintRows.forEach((row, i) => footprintAt.set(`${row.inst}|${row.t}`, i));
  // Minutes recorded elsewhere join the rows `load` hands the recorder (a thinner copy of the same minute is replaced) and are stored like
  // the recorder's own (by the tab that writes; another tab shows them and stores nothing, as it does with what it records).
  const importColumns =(incoming: readonly { inst: string; step: number; column: Column }[]): number => {
    const at = new Map<string, number>();
    columnRows.forEach((row, i) => at.set(`${row.inst}|${row.t}`, i));
    let taken = 0;
    for (const { inst, step, column } of incoming) {
      const key = `${inst}|${column.t}`, i = at.get(key), kept = i === undefined ? undefined : columnRows[i];
      const row = { inst, t: column.t, step, n: column.n, bins: own(column.bins), bid: own(column.bid), ask: own(column.ask), ...(column.lt && (column.ltN ?? 0) > 0 ? { lt: own(column.lt), ltN: column.ltN! } : {}) } satisfies ColumnRow;
      if (kept && (kept.step !== step || !fullerColumn(kept, row) || kept.n === row.n)) continue;
      if (i === undefined) { at.set(key, columnRows.length); columnRows.push(row); } else columnRows[i] = row;
      columns.save(inst, column, step);
      taken++;
    }
    return taken;
  };
  const importRows = (incoming: HistoryRows): number => {
    let taken = 0;
    // Flow: second by second, the fuller copy (as two tabs' copies of a minute are merged).
    const flowAt = new Map<string, number>();
    flowRows.forEach((row, i) => flowAt.set(`${row.inst}|${row.t}`, i));
    for (const row of incoming.flow) {
      const i = flowAt.get(`${row.inst}|${row.t}`), merged = fullerFlowMinute(i === undefined ? undefined : flowRows[i], row);
      if (!merged) continue;
      if (i === undefined) { flowAt.set(`${row.inst}|${row.t}`, flowRows.length); flowRows.push(merged); } else flowRows[i] = merged;
      taken++;
    }
    if (incoming.flow.length) flow.save(incoming.flow, since);
    // Liquidations and open-interest readings the page does not hold (a liquidation is known by the venue's own facts).
    const newLiquidations = incoming.liquidations.filter(row => !everyLiquidation.has(liquidationKey(row)));
    for (const row of newLiquidations) { const k = liquidationKey(row); everyLiquidation.set(k, { ...row, k }); liquidationRows.push({ ...row, k }); }
    if (newLiquidations.length) { liquidationRows.sort((a, b) => a.t - b.t); liquidations.save(newLiquidations, since); taken += newLiquidations.length; }
    // An open-interest minute keeps its newest reading (the minute's last, as the recorders keep it): the service's when it was read later.
    const oiAt = new Map(oiRows.map((row, i) => [`${row.venue}|${row.t}`, i]));
    const newOi: OiRow[] = [];
    for (const row of incoming.oi) {
      const key = `${row.venue}|${row.t}`, i = oiAt.get(key);
      if (i === undefined) { oiAt.set(key, oiRows.length); oiRows.push(row); newOi.push(row); }
      else if ((row.at ?? 0) > (oiRows[i]!.at ?? 0)) { oiRows[i] = row; newOi.push(row); }
    }
    if (newOi.length) { oi.save(newOi, since); taken += newOi.length; }
    // Large trades only where this page did not record the trades itself.
    const newPrints = incoming.prints.filter(row => !ownsTime(trade, row.id, row.t) && !everyPrint.has(printKey(row)));
    if (newPrints.length) {
      for (const row of newPrints) printRows.push({ ...row, k: printKey(row) });
      printRows.sort((a, b) => a.t - b.t);
      prints.save(newPrints, since); taken += newPrints.length;
    }
    // Footprint minutes where this page did not record the whole minute, on its step, the fuller copy (`planFootprint`).
    const newFootprint = planFootprint(trade, incoming.footprint, key => { const i = footprintAt.get(key); return i === undefined ? undefined : footprintRows[i]; });
    for (const row of newFootprint) {
      const key = `${row.inst}|${row.t}`, i = footprintAt.get(key);
      if (i === undefined) { footprintAt.set(key, footprintRows.length); footprintRows.push(row); } else footprintRows[i] = row;
    }
    if (newFootprint.length) { footprint.save(newFootprint, since); taken += newFootprint.length; }
    // Absorption minutes where this page did not record the whole minute, with their groups (`planAbsorption`). The page's own groups of
    // such a minute, found in a part of it, go first: no group is counted twice.
    const absorbed = planAbsorption(trade, incoming.absorptionMinutes, incoming.absorption);
    if (absorbed.size) {
      // What the recorder opens with (the last two hours) is changed the same way; the older part is laid over the store (`overlay`).
      const keptGroups = absorptionRows.filter(row => !absorbed.has(minuteKey(row.inst, row.t0)));
      absorptionRows.length = 0; absorptionRows.push(...keptGroups);
      const minuteAt = new Map(absorptionMinuteRows.map((row, i) => [`${row.inst}|${row.t}`, i]));
      for (const [key, { minute, groups }] of absorbed) {
        // Every one is laid over the store too: the recorder's own cut (two hours before it starts, a moment after this) can leave a
        // minute of the opening arrays out, and a tab that may not write keeps no copy in the store.
        overlay.set(key, { minute, groups });
        // A minute that reaches past the opening cut goes into the arrays too: the recorder answers its later part from memory.
        if (minute.t + MINUTE <= absorptionSince) continue;
        const i = minuteAt.get(key);
        if (i === undefined) absorptionMinuteRows.push(minuteRow(minute)); else absorptionMinuteRows[i] = minuteRow(minute);
        for (const g of groups) absorptionRows.push(groupRow(g));
      }
      enqueue(tx => {
        const store = tx.objectStore('absorption'), perMinute = tx.objectStore('absorptionMinutes');
        for (const { minute, groups } of absorbed.values()) {
          perMinute.put(minuteRow(minute));
          // The minute's groups go in once the page's own are deleted: a cursor still walking the minute would delete them too.
          const request = store.index('t').openCursor(IDBKeyRange.bound(minute.t, minute.t + MINUTE, false, true));
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) { if ((cursor.value as AbsorptionRow).inst === minute.id) cursor.delete(); cursor.continue(); return; }
            for (const g of groups) store.put(groupRow(g));
          };
        }
      });
      taken += absorbed.size;
    }
    // The service's stretches of trade coverage join the page's own where its footprint minutes were taken (`planCoverage`), only over the
    // hours whose footprint this page holds (`clipCoverage`): read in this import, or marked read whole by an earlier one, and the hour
    // after them too (a minute's rows can be written into the next hour), or that hour not over yet. A stretch is written again as it grows
    // (its start is its key): the longest copy stays.
    if (incoming.hour !== null) { hoursRead.add(incoming.hour); if (incoming.footprint.length) footprintHours.add(incoming.hour); }
    for (const row of incoming.footprint) if (row.step === trade.steps.get(row.inst) && !(row.t >= (firstFootprint.get(row.inst) ?? Infinity))) firstFootprint.set(row.inst, row.t);
    pendingCover.push(...planCoverage(trade, incoming));
    // An hour counts when its own file held footprint minutes, and the next hour was read too (or marked read earlier, or is not over).
    const known = new Set([...hoursRead, ...importedHours()]), now = Date.now();
    const holds = (hour: number): boolean => footprintHours.has(hour) && (known.has(hour + HOUR) || hour + 2 * HOUR > now);
    // From the minute after a market's first footprint minute: the run that recorded it may have started inside that minute.
    const coverAt = new Map(coverRows.map((row, i) => [`${row.inst}|${row.metric}|${row.from}`, i]));
    const newCover: CoverRow[] = [];
    for (const row of clipCoverage(pendingCover, holds, inst => { const t = firstFootprint.get(inst); return t === undefined ? undefined : t + MINUTE; })) {
      const key = `${row.inst}|${row.metric}|${row.from}`, i = coverAt.get(key);
      if (i !== undefined && coverRows[i]!.to >= row.to) continue;
      const stored: CoverRow = { ...row, t: row.to };
      if (i === undefined) { coverAt.set(key, coverRows.length); coverRows.push(stored); } else coverRows[i] = stored;
      newCover.push(stored);
    }
    if (newCover.length) { enqueue(tx => { const store = tx.objectStore('coverage'); for (const row of newCover) store.put(row); }); taken += newCover.length; }
    return taken;
  };
  const importedHours = (): number[] => coverRows.filter(row => row.metric === IMPORTED && row.inst === IMPORTED_INST).map(row => row.from);
  // Written once what the import queued has been written (or let go), and only when nothing was let go since `since` (`writeEpoch()`
  // before the import): a mark without its rows would keep the hour from being read again.
  const markImported = async (hours: readonly number[], since: number): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    await write();
    if (epoch !== since || failed || closed || !canWrite()) return;
    const held = new Set(importedHours()), rows = hours.filter(h => !held.has(h)).map(h => ({ inst: IMPORTED_INST, metric: IMPORTED, from: h, to: h + HOUR, kind: 'live' as const, t: h + HOUR }) satisfies CoverRow);
    if (!rows.length) return;
    enqueue(tx => { const store = tx.objectStore('coverage'); for (const row of rows) store.put(row); });
    await write();
    if (epoch === since) coverRows.push(...rows);
  };
  return {
    columns, footprint, prints, flow, absorption, coverage, liquidations, oi, importColumns, importRows, importedHours, markImported, writeEpoch: () => epoch,
    flush() { if (timer) clearTimeout(timer); return write(); },
    close() { if (timer) clearTimeout(timer); void write().finally(() => { closed = true; db.close(); }); },
  };
}
