/**
 * The Plus database (2026-11-20, the checkout's recovery, Option B): its own IndexedDB database `lmf-plus`, version 1, with one object store
 * `kv` of out-of-line keys. It holds the browser's seed (the secret every key this browser asks for is named by), the membership and its
 * generation, the payments whose Plus is not set up yet, and the mark of the one-time import from `localStorage`. It never touches the
 * recordings' database (`browser/idb.ts`): a version bump there can be blocked by an old tab.
 *
 * IndexedDB runs the readwrite transactions on one store one at a time, across every tab of the browser, so a read, a check and a write inside
 * ONE transaction (`tx`) are atomic: that is what two tabs asking at once rely on. Inside a transaction nothing but IndexedDB's own requests may
 * be awaited (the transaction commits by itself as soon as no request is pending at the end of a task).
 *
 * The page opens it once (`plusDb`), within `OPEN_TIMEOUT_MS`; an open that has not answered by then is reported as such, and goes on: its
 * answer, when it comes, still opens the database (or says it failed) and tells the listeners. A later build that upgrades the database, or
 * the browser closing it (site data cleared), closes this tab's connection; the next use opens it again.
 */

/** The database, its version and its one store. */
export const PLUS_DB = 'lmf-plus', PLUS_DB_VERSION = 1, KV_STORE = 'kv';
/** How long an open is waited for before it is reported as not answered (it goes on). */
export const OPEN_TIMEOUT_MS = 3_000;
/** The seed's entry, and its shape: 32 random bytes in base64url, 43 characters (what the Worker accepts as `secret`). */
export const SEED_KEY = 'seed';
export const SEED_SHAPE = /^[A-Za-z0-9_-]{43}$/;

// The parts of IndexedDB used here, narrow enough that the browser's `indexedDB` is one and a test's stand-in needs no cast. A handler's event is
// `never`: none is read (the browser's handlers take more specific events than `Event`).
type Handler = ((event: never) => unknown) | null;
export interface DbRequest<T> { readonly result: T; readonly error: DOMException | null; onsuccess: Handler; onerror: Handler }
export interface DbOpenRequest extends DbRequest<Db> { onupgradeneeded: Handler; onblocked: Handler }
export interface DbStore {
  get(key: string): DbRequest<unknown>;
  put(value: unknown, key: string): DbRequest<unknown>;
  delete(key: string): DbRequest<unknown>;
  getAllKeys(): DbRequest<unknown[]>;
}
export interface DbTransaction { readonly error: DOMException | null; objectStore(name: string): DbStore; abort(): void; oncomplete: Handler; onerror: Handler; onabort: Handler }
export interface Db {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(store: string, mode: 'readonly' | 'readwrite'): DbTransaction;
  close(): void;
  onversionchange: Handler;
  onclose: Handler;
}
export interface DbFactory { open(name: string, version: number): DbOpenRequest }

/** The store as a transaction's body sees it: each call is one request of that transaction. */
export interface Kv {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key in the store (it holds a handful). */
  keys(): Promise<string[]>;
}

/** How an open went within its wait: open, failed (no IndexedDB here, or it refused), or not answered yet (it goes on). */
export type OpenOutcome = 'open' | 'error' | 'timeout';
/** Where this tab's connection stands. `failed`: the last open answered with an error (a later use tries again). */
export type DbState = 'closed' | 'opening' | 'open' | 'failed';

/** A transaction was asked for and the database did not open within its wait: the body never ran and never will. */
export class PlusDbUnavailable extends Error {
  /** `error`: it cannot be opened here; `timeout`: it did not open within the wait. */
  constructor(readonly outcome: 'error' | 'timeout') { super(outcome); this.name = 'PlusDbUnavailable'; }
}

/** The timers waits are measured with (tests may give their own). */
export interface Timers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>); } };

/** The browser's IndexedDB, or null where there is none (Node) or touching it throws (some private windows, blocked site data). */
function browserFactory(): DbFactory | null {
  try { return typeof indexedDB === 'undefined' ? null : indexedDB ?? null; } catch { return null; }
}

/** One request as a promise. A request that cannot even be made (the transaction no longer active, a read-only one) rejects. */
function ask<T>(make: () => DbRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = make();
    request.onsuccess = () => { resolve(request.result); };
    // Not prevented: a failed request aborts its transaction, so `tx` rejects even when the body catches this.
    request.onerror = () => { reject(request.error ?? new DOMException('the request failed', 'UnknownError')); };
  });
}
function kvOf(store: DbStore): Kv {
  return {
    get: key => ask(() => store.get(key)),
    put: async (key, value) => { await ask(() => store.put(value, key)); },
    delete: async key => { await ask(() => store.delete(key)); },
    keys: async () => (await ask(() => store.getAllKeys())).filter((k): k is string => typeof k === 'string'),
  };
}

const isInvalidState = (error: unknown): boolean => error instanceof DOMException && error.name === 'InvalidStateError';

export class PlusDb {
  #db: Db | null = null;
  /** The open under way, and which one it is (a close meanwhile makes its answer stale). */
  #opening: Promise<Db | null> | null = null;
  #epoch = 0;
  #state: DbState = 'closed';
  #listeners = new Set<(state: DbState) => void>();
  constructor(private readonly factory: DbFactory | null = browserFactory(), private readonly timers: Timers = realTimers, private readonly openWaitMs: number = OPEN_TIMEOUT_MS) {}

  get state(): DbState { return this.#state; }
  /** Told whenever `state` changes: an open that answers late, a connection closed by an upgrade elsewhere or by the browser. */
  subscribe(listener: (state: DbState) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #set(state: DbState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of [...this.#listeners]) listener(state);
  }

  /** The connection, or the open under way, or a new open (after a close or a failed open). Resolves with the connection, or null on an error. */
  #start(): Promise<Db | null> {
    if (this.#db) return Promise.resolve(this.#db);
    if (this.#opening) return this.#opening;
    const epoch = ++this.#epoch;
    this.#set('opening');
    const opening = new Promise<Db | null>(resolve => {
      let request: DbOpenRequest;
      try {
        if (!this.factory) { resolve(null); return; }
        request = this.factory.open(PLUS_DB, PLUS_DB_VERSION);
      } catch { resolve(null); return; }
      request.onupgradeneeded = () => {
        // A throw here aborts the upgrade, and the open answers with an error.
        const db = request.result;
        if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      };
      request.onsuccess = () => { resolve(request.result); };
      request.onerror = () => { resolve(null); };
      // Blocked (an older tab holds the database at another version): the open keeps waiting, and its wait reports it.
      request.onblocked = () => {};
    }).then(db => {
      if (epoch !== this.#epoch) { db?.close(); return null; }
      this.#opening = null;
      if (!db) { this.#set('failed'); return null; }
      db.onversionchange = () => { db.close(); this.#drop(db); };
      db.onclose = () => { this.#drop(db); };
      this.#db = db;
      this.#set('open');
      return db;
    });
    this.#opening = opening;
    return opening;
  }
  /** `db` is closed (by this tab or the browser): the next use opens again. */
  #drop(db: Db): void {
    if (this.#db !== db) return;
    this.#db = null;
    this.#set('closed');
  }

  /**
   * Opens the database unless it is open or opening. Resolves with the open's answer, or with `timeout` after `waitMs`; then the open goes on,
   * and its answer still changes `state` and tells the listeners.
   */
  open(waitMs: number = this.openWaitMs): Promise<OpenOutcome> {
    const started = this.#start();
    return new Promise<OpenOutcome>(resolve => {
      const timer = this.timers.set(() => { resolve('timeout'); }, waitMs);
      void started.then(db => { this.timers.clear(timer); resolve(db ? 'open' : 'error'); });
    });
  }
  /** The connection within `waitMs`, or `PlusDbUnavailable`. */
  async #connection(waitMs: number): Promise<Db> {
    const outcome = this.#db ? 'open' : await this.open(waitMs);
    if (outcome !== 'open' || !this.#db) throw new PlusDbUnavailable(outcome === 'open' ? 'error' : outcome);
    return this.#db;
  }

  /**
   * Runs `fn` inside ONE transaction on the store and resolves with what it returned once the transaction has committed (`complete`). Rejects
   * when the transaction fails or aborts (nothing it wrote is kept), with the first error: the failed request's (`QuotaExceededError`, ...),
   * `fn`'s own throw (which aborts it), or the transaction's. `fn` may await only the `Kv` requests. When the database is not open, it is
   * opened (again) and waited for up to `waitMs`; if it does not open by then, `PlusDbUnavailable`, and `fn` never runs, not even later.
   */
  async tx<T>(mode: 'readonly' | 'readwrite', fn: (kv: Kv) => T | Promise<T>, waitMs: number = this.openWaitMs): Promise<T> {
    let db = await this.#connection(waitMs);
    let transaction: DbTransaction;
    try {
      transaction = db.transaction(KV_STORE, mode);
    } catch (error) {
      // Closed under this tab (the browser closed it and its `close` has not arrived yet): opened again, once.
      if (!isInvalidState(error)) throw error;
      this.#drop(db);
      db = await this.#connection(waitMs);
      transaction = db.transaction(KV_STORE, mode);
    }
    return run(transaction, fn);
  }

  /** Closes this tab's connection (and makes an open under way close as it answers). */
  close(): void {
    this.#epoch++;
    this.#opening = null;
    const db = this.#db;
    if (db) { db.close(); this.#drop(db); } else this.#set('closed');
  }
}

/** `fn` inside `transaction`, settled when both have: its value after `complete`, or the first error. */
function run<T>(transaction: DbTransaction, fn: (kv: Kv) => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let failure: { error: unknown } | null = null, value: { of: T } | null = null, complete = false, settled = false;
    const settle = (): void => {
      if (settled) return;
      if (failure) { settled = true; reject(failure.error); } else if (value && complete) { settled = true; resolve(value.of); }
    };
    const fail = (error: unknown): void => {
      failure ??= { error };
      try { transaction.abort(); } catch { /* finished already (aborting, or committed before `fn` failed) */ }
      // A transaction that committed before `fn` failed (a body that awaited something else) has no abort to wait for.
      if (complete) settle();
    };
    transaction.oncomplete = () => { complete = true; settle(); };
    transaction.onabort = () => {
      failure ??= { error: transaction.error ?? new DOMException('the transaction was aborted', 'AbortError') };
      settle();
    };
    let out: T | Promise<T>;
    try { out = fn(kvOf(transaction.objectStore(KV_STORE))); } catch (error) { fail(error); return; }
    Promise.resolve(out).then(of => { value = { of }; settle(); }, fail);
  });
}

const toBase64Url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A new seed: 32 bytes from `random` (the browser's `crypto.getRandomValues`), base64url, 43 characters. */
export function newSeed(random: (bytes: Uint8Array) => Uint8Array = bytes => crypto.getRandomValues(bytes)): string {
  return toBase64Url(random(new Uint8Array(32)));
}
/**
 * Inside a caller's readwrite transaction: the stored seed, or a new one put now. A stored value of another shape (never written by this page)
 * is replaced: no key was ever named by it, since the server refuses a malformed secret.
 */
export async function seedIn(kv: Kv, random?: (bytes: Uint8Array) => Uint8Array): Promise<string> {
  const stored = await kv.get(SEED_KEY);
  if (typeof stored === 'string' && SEED_SHAPE.test(stored)) return stored;
  const made = newSeed(random);
  await kv.put(SEED_KEY, made);
  return made;
}
/**
 * The browser's seed, read (or created, when there is none) in one readwrite transaction of its own: two tabs creating it at once end with one.
 * Never kept in the tab: every use reads it again, so a tab left open across a reset of the database uses the new one.
 */
export function readSeed(db: PlusDb, waitMs?: number): Promise<string> {
  return db.tx('readwrite', kv => seedIn(kv), waitMs);
}

let page: PlusDb | null = null;
/** The page's one Plus database (opened on first use). */
export function plusDb(): PlusDb { return page ??= new PlusDb(); }
/** The page's one Plus database where the browser has IndexedDB, else null (Node; a browser that hides it): then the membership is plain. */
export function plusDbIfAny(): PlusDb | null { return browserFactory() ? plusDb() : null; }

// ---- Payment records and the gate (spec sections 3 and 4) ----

/** A payment's record (`paid:<txn>` = `{ at }`) waits from this long before its checkout's time to this long after it, on this device's clock. */
export const PAID_WINDOW_MS = 86_400_000;
export const PAID_PREFIX = 'paid:';
/** Whether a record dated `at` waits at `now` (both edges included). */
export const paidWaits = (at: number, now: number): boolean => at - PAID_WINDOW_MS <= now && now <= at + PAID_WINDOW_MS;
/** When a stored record's checkout completed, or null for anything else. */
export function paidAt(value: unknown): number | null {
  const at = value && typeof value === 'object' ? (value as { at?: unknown }).at : undefined;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}
/** A record this tab keeps in memory because the browser refused to store it: when its checkout completed, and the seed it belongs to. */
export interface MemoryRecord { readonly at: number; readonly epoch: string }
/** A request that issues a key: its path under the Plus server's address, its body, and the seed it carries (its answer's epoch). */
export interface Issue { readonly path: string; readonly body: Readonly<Record<string, unknown>>; readonly seed: string }

/**
 * THE GATE: the one place where the bodies of the Plus server's `/v1/pass` and `/v1/restore` are built (a source test pins it). One readwrite
 * transaction reads the seed (making one when there is none) and confirms that the payment's record still waits: stored here, or this tab's
 * memory record of the same seed, within its window (a stored one outside it is removed). `gone` when it does not wait; null when the
 * database cannot be used: then nothing is sent.
 */
export async function passRequest(db: PlusDb, txn: string, now: number, memory: MemoryRecord | null = null): Promise<Issue | 'gone' | null> {
  try {
    return await db.tx('readwrite', async (kv): Promise<Issue | 'gone'> => {
      const seed = await seedIn(kv), key = `${PAID_PREFIX}${txn}`, at = paidAt(await kv.get(key));
      if (at !== null && !paidWaits(at, now)) await kv.delete(key);
      const waits = (at !== null && paidWaits(at, now)) || (memory !== null && memory.epoch === seed && paidWaits(memory.at, now));
      return waits ? { path: '/pass', body: { transactionId: txn, secret: seed }, seed } : 'gone';
    });
  } catch { return null; }
}
/** The gate for a receipt: the request that finds the membership paid with `email` by `invoice`, carrying the seed read now. */
export async function restoreRequest(db: PlusDb, email: string, invoice: string): Promise<Issue | null> {
  try {
    return await db.tx('readwrite', async (kv): Promise<Issue> => { const seed = await seedIn(kv); return { path: '/restore', body: { email, invoice, secret: seed }, seed }; });
  } catch { return null; }
}
