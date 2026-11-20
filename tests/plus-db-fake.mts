/**
 * An in-memory IndexedDB for the Plus database's tests (`src/app/plus/plus-db.ts`), faithful where the Plus code depends on it: each `PlusDb`
 * over one `FakeIdb` is a tab with its own connection; transactions on a store run in the order they were made, readwrite ones alone and
 * readonly ones beside each other; each request is answered a task later; a transaction stays active only while it is being made and while a
 * request's answer (and the microtasks after it) runs, and commits by itself once nothing is pending, so a request after an awaited non-IDB
 * promise throws `TransactionInactiveError`, as in a browser. Writes are kept by the transaction and applied at its commit, so a failed or
 * aborted one leaves nothing.
 *
 * What a test can make happen: hold a request until it says (`hold`), fail the next `put` request or the next commit (`QuotaExceededError` or
 * any other name), refuse or hold opens (`opens`), fire `versionchange` on every connection (a later build upgrading), and wipe the browser's
 * site data (`wipe`: open connections are closed by the browser and their unfinished transactions aborted; the next open creates the database
 * again). Timing uses `setImmediate`, so tests that mock `setTimeout` do not stop it.
 */
import type { Db, DbFactory, DbOpenRequest, DbRequest, DbStore, DbTransaction } from '../src/app/plus/plus-db.ts';

interface FakeEvent { readonly type: string; readonly target: unknown; defaultPrevented: boolean; preventDefault(): void }
type On = ((event: FakeEvent) => unknown) | null;
const eventOf = (type: string, target: unknown): FakeEvent => ({ type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
const later = (fn: () => void): void => { setImmediate(fn); };
const nextTask = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
const dom = (name: string, message: string = name): DOMException => new DOMException(message, name);

/** What a held or watched request is: which tab (connection, in the order opened, from 1), which transaction, what it does. */
export interface RequestInfo { readonly tab: number; readonly tx: number; readonly mode: 'readonly' | 'readwrite'; readonly op: 'get' | 'put' | 'delete' | 'getAllKeys'; readonly key?: string; readonly value?: unknown }
/** A held request: `reached` once it waits, answered after `release`. */
export interface Hold { readonly reached: Promise<void>; release(): void }

interface Database { version: number; stores: Map<string, Map<string, unknown>>; connections: Set<FakeConnection>; queue: FakeTransaction[] }

class FakeRequest<T> implements DbRequest<T> {
  result!: T;
  error: DOMException | null = null;
  done = false;
  onsuccess: On = null;
  onerror: On = null;
}
class FakeOpenRequest extends FakeRequest<Db> implements DbOpenRequest {
  onupgradeneeded: On = null;
  onblocked: On = null;
}

interface Pending { readonly req: FakeRequest<unknown>; readonly info: RequestInfo }

class FakeTransaction implements DbTransaction {
  error: DOMException | null = null;
  oncomplete: On = null;
  onerror: On = null;
  onabort: On = null;
  active = true;
  started = false;
  finished = false;
  #busy: Pending | null = null;
  #requests: Pending[] = [];
  /** Writes kept until the commit (`null`: deleted). */
  #writes = new Map<string, { value: unknown } | null>();
  constructor(readonly idb: FakeIdb, readonly db: Database, readonly conn: FakeConnection, readonly id: number, readonly store: string, readonly mode: 'readonly' | 'readwrite') {}

  objectStore(name: string): DbStore {
    if (this.finished) throw dom('InvalidStateError', 'the transaction has finished');
    if (name !== this.store) throw dom('NotFoundError', `no store ${name} in this transaction`);
    const place = (op: RequestInfo['op'], key?: string, value?: unknown): FakeRequest<never> => {
      if (this.finished || !this.active) throw dom('TransactionInactiveError', 'the transaction is not active');
      if (this.mode === 'readonly' && (op === 'put' || op === 'delete')) throw dom('ReadOnlyError', 'the transaction is read-only');
      if (op !== 'getAllKeys' && typeof key !== 'string') throw dom('DataError', 'not a valid key');
      const req = new FakeRequest<never>();
      const cloned = op === 'put' ? structuredClone(value) : undefined;
      this.#requests.push({ req, info: { tab: this.conn.tab, tx: this.id, mode: this.mode, op, ...(key !== undefined ? { key } : {}), ...(op === 'put' ? { value: cloned } : {}) } });
      this.advance();
      return req;
    };
    return {
      get: key => place('get', key),
      put: (value, key) => place('put', key, value),
      delete: key => place('delete', key),
      getAllKeys: () => place('getAllKeys'),
    };
  }
  abort(): void {
    if (this.finished) throw dom('InvalidStateError', 'the transaction has finished');
    this.fail(null);
  }

  /** Starts when every earlier transaction it must wait for has finished, then answers its requests one at a time; commits when idle and inactive. */
  advance(): void {
    if (this.finished || this.#busy) return;
    if (!this.started) {
      if (!this.idb.mayStart(this)) return;
      this.started = true;
    }
    const next = this.#requests.shift();
    if (next) { this.#busy = next; void this.#answer(next); return; }
    if (!this.active) this.#commit();
  }
  /** What the store holds for `key` as this transaction sees it. */
  #read(key: string): unknown {
    const own = this.#writes.get(key);
    if (own !== undefined) return own === null ? undefined : structuredClone(own.value);
    return structuredClone(this.db.stores.get(this.store)?.get(key));
  }
  async #answer(pending: Pending): Promise<void> {
    await this.idb.reach(pending.info);
    await nextTask();
    if (this.finished || pending.req.done) return;
    const { req, info } = pending;
    let failed: DOMException | null = null;
    const planned = this.idb.takeFailure(info);
    if (planned) failed = dom(planned, 'the request failed');
    else if (info.op === 'put' && this.idb.takePutFailure()) failed = dom(this.idb.lastPutFailure, 'the put request failed');
    else if (info.op === 'get') req.result = this.#read(info.key!) as never;
    else if (info.op === 'put') { this.#writes.set(info.key!, { value: info.value }); req.result = info.key as never; }
    else if (info.op === 'delete') { this.#writes.set(info.key!, null); req.result = undefined as never; }
    else {
      const keys = new Set([...(this.db.stores.get(this.store)?.keys() ?? [])]);
      for (const [key, write] of this.#writes) { if (write) keys.add(key); else keys.delete(key); }
      req.result = [...keys].sort() as never;
    }
    req.done = true;
    this.active = true;
    let event: FakeEvent | null = null;
    if (failed) {
      req.error = failed;
      event = eventOf('error', req);
      req.onerror?.(event);
      // The error bubbles to the transaction.
      this.onerror?.(event);
    } else {
      req.onsuccess?.(eventOf('success', req));
    }
    // The microtasks after the answer run before the transaction is inactive again (and before an unprevented error aborts it), as in a browser.
    later(() => {
      if (failed && event && !event.defaultPrevented && !this.finished) this.fail(failed);
      this.active = false;
      this.#busy = null;
      this.advance();
    });
  }
  #commit(): void {
    // A quota or an abort at commit concerns a transaction that wrote something.
    const failure = this.mode === 'readwrite' && this.#writes.size > 0 ? this.idb.takeCommitFailure() : null;
    if (failure) { this.fail(dom(failure, 'the transaction could not commit')); return; }
    let store = this.db.stores.get(this.store);
    if (!store) { store = new Map(); this.db.stores.set(this.store, store); }
    for (const [key, write] of this.#writes) { if (write) store.set(key, write.value); else store.delete(key); }
    this.#writes.clear();
    this.finished = true;
    later(() => { this.oncomplete?.(eventOf('complete', this)); this.idb.ended(this); });
  }
  /** Aborted (by the page, an unprevented request error, a failed commit, or the browser): nothing it wrote is kept. */
  fail(error: DOMException | null): void {
    if (this.finished) return;
    this.finished = true;
    this.error = error;
    this.#writes.clear();
    const pending = [...(this.#busy && !this.#busy.req.done ? [this.#busy] : []), ...this.#requests.splice(0)];
    for (const p of pending) p.req.done = true;
    later(() => {
      for (const p of pending) { p.req.error = dom('AbortError', 'the transaction was aborted'); p.req.onerror?.(eventOf('error', p.req)); }
      this.onabort?.(eventOf('abort', this));
      this.idb.ended(this);
    });
  }
}

class FakeConnection implements Db {
  onversionchange: On = null;
  onclose: On = null;
  closed = false;
  upgrading = false;
  constructor(readonly idb: FakeIdb, readonly db: Database, readonly tab: number) {}
  get objectStoreNames(): { contains(name: string): boolean } { return { contains: name => this.db.stores.has(name) }; }
  createObjectStore(name: string): unknown {
    if (!this.upgrading) throw dom('InvalidStateError', 'not in an upgrade');
    if (this.db.stores.has(name)) throw dom('ConstraintError', `store ${name} exists`);
    this.db.stores.set(name, new Map());
    return {};
  }
  transaction(store: string, mode: 'readonly' | 'readwrite'): DbTransaction {
    if (this.closed) throw dom('InvalidStateError', 'the connection is closed');
    if (!this.db.stores.has(store)) throw dom('NotFoundError', `no store ${store}`);
    if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError(`mode ${String(mode)}`);
    return this.idb.begin(this, store, mode);
  }
  /** As in a browser: no new transaction from now on; the ones made already finish. */
  close(): void { this.closed = true; this.db.connections.delete(this); }
}

export class FakeIdb {
  /** Opens: answered (the default), refused with an error, or held until `releaseOpens`. */
  opens: 'answer' | 'refuse' | 'hang' = 'answer';
  /** The error a refused open answers with. */
  refusal = 'UnknownError';
  /** How many times `open` was called. */
  opened = 0;
  /** Every request answered or held, in order (for tests that check what was read and written). */
  readonly log: RequestInfo[] = [];
  lastPutFailure = 'QuotaExceededError';
  #databases = new Map<string, Database>();
  #heldOpens: (() => void)[] = [];
  #holds: { match: (info: RequestInfo) => boolean; reached: () => void; gate: Promise<void> }[] = [];
  #putFailure: string | null = null;
  #commitFailure: string | null = null;
  #tabs = 0;
  #failures: { match: (info: RequestInfo) => boolean; name: string; left: number }[] = [];
  #txs = 0;

  /** The factory a `PlusDb` is given. */
  readonly factory: DbFactory = { open: (name, version) => this.#open(name, version) };

  #open(name: string, version: number): DbOpenRequest {
    this.opened++;
    if (!Number.isInteger(version) || version < 1) throw new TypeError(`version ${version}`);
    const req = new FakeOpenRequest();
    const answer = (): void => { this.#answerOpen(req, name, version); };
    if (this.opens === 'hang') this.#heldOpens.push(answer); else later(answer);
    return req;
  }
  #answerOpen(req: FakeOpenRequest, name: string, version: number): void {
    const error = (e: DOMException): void => { req.error = e; req.done = true; req.onerror?.(eventOf('error', req)); };
    if (this.opens === 'refuse') { error(dom(this.refusal, 'the open was refused')); return; }
    let db = this.#databases.get(name);
    if (!db) { db = { version: 0, stores: new Map(), connections: new Set(), queue: [] }; this.#databases.set(name, db); }
    if (version < db.version) { error(dom('VersionError', 'the database is newer')); return; }
    const conn = new FakeConnection(this, db, ++this.#tabs);
    req.result = conn;
    if (version > db.version) {
      const before = { version: db.version, stores: [...db.stores.keys()] };
      db.version = version;
      conn.upgrading = true;
      try { req.onupgradeneeded?.(eventOf('upgradeneeded', req)); } catch {
        conn.upgrading = false;
        db.version = before.version;
        for (const store of [...db.stores.keys()]) if (!before.stores.includes(store)) db.stores.delete(store);
        error(dom('AbortError', 'the upgrade was aborted'));
        return;
      }
      conn.upgrading = false;
    }
    db.connections.add(conn);
    req.done = true;
    req.onsuccess?.(eventOf('success', req));
  }
  /** Answers the held opens now, by the rule in force (`opens`: set it to `answer` or `refuse` first). */
  releaseOpens(): void { for (const answer of this.#heldOpens.splice(0)) later(answer); }

  begin(conn: FakeConnection, store: string, mode: 'readonly' | 'readwrite'): FakeTransaction {
    const t = new FakeTransaction(this, conn.db, conn, ++this.#txs, store, mode);
    conn.db.queue.push(t);
    // Active while it is being made: until the end of this task.
    later(() => { t.active = false; t.advance(); });
    return t;
  }
  /** Whether `t` may start: no earlier unfinished transaction it overlaps (readonly ones overlap only readwrite ones). */
  mayStart(t: FakeTransaction): boolean {
    for (const other of t.db.queue) {
      if (other === t) return true;
      if (!other.finished && other.store === t.store && (other.mode === 'readwrite' || t.mode === 'readwrite')) return false;
    }
    return true;
  }
  /** `t` finished: the ones waiting behind it may start. */
  ended(t: FakeTransaction): void {
    const queue = t.db.queue, at = queue.indexOf(t);
    if (at >= 0) queue.splice(at, 1);
    for (const other of [...queue]) other.advance();
  }
  /** Before a request is answered: logged, and held while a matching `hold` says so. */
  async reach(info: RequestInfo): Promise<void> {
    this.log.push(info);
    const at = this.#holds.findIndex(h => h.match(info));
    if (at < 0) return;
    const [hold] = this.#holds.splice(at, 1);
    hold!.reached();
    await hold!.gate;
  }

  /** Holds the next request that `match` accepts (once) until `release`; `reached` resolves when it waits. */
  hold(match: (info: RequestInfo) => boolean): Hold {
    let reached!: () => void, release!: () => void;
    const reachedP = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.#holds.push({ match, reached, gate });
    return { reached: reachedP, release };
  }
  /** The next `put` request fails with this error (and, unprevented, aborts its transaction). */
  failNextPut(name = 'QuotaExceededError'): void { this.#putFailure = name; }
  /** The next `times` requests that `match` accepts fail with this error (and, unprevented, abort their transactions). */
  fail(match: (info: RequestInfo) => boolean, name = 'UnknownError', times = 1): void { this.#failures.push({ match, name, left: times }); }
  takeFailure(info: RequestInfo): string | null {
    const f = this.#failures.find(x => x.left > 0 && x.match(info));
    if (!f) return null;
    f.left--;
    return f.name;
  }
  /** Every planned failure (`fail`) given up: requests succeed again. */
  clearFailures(): void { this.#failures.length = 0; }
  /** The tab number of the connection opened last (requests carry it as `tab`). */
  get lastTab(): number { return this.#tabs; }
  takePutFailure(): boolean { if (this.#putFailure === null) return false; this.lastPutFailure = this.#putFailure; this.#putFailure = null; return true; }
  /** The next transaction that wrote something aborts at its commit instead, with this error as its `error` (a quota found at commit, or `AbortError`). */
  failNextCommit(name = 'QuotaExceededError'): void { this.#commitFailure = name; }
  takeCommitFailure(): string | null { const name = this.#commitFailure; this.#commitFailure = null; return name; }

  /** A later build opens the database at a higher version: every open connection is told (`versionchange`). How many stay open. */
  versionChange(name = 'lmf-plus'): number {
    const db = this.#databases.get(name);
    if (!db) return 0;
    for (const conn of [...db.connections]) if (!conn.closed) conn.onversionchange?.(eventOf('versionchange', conn));
    return [...db.connections].filter(c => !c.closed).length;
  }
  /**
   * The browser's site data cleared (or the database evicted): unfinished transactions abort, open connections are closed by the browser (a
   * `close` event a task later; meanwhile `transaction()` throws), and the data is gone. The next open creates the database again.
   */
  wipe(): void {
    for (const db of this.#databases.values()) {
      for (const t of [...db.queue]) t.fail(dom('AbortError', 'the database was deleted'));
      for (const conn of [...db.connections]) {
        conn.closed = true;
        later(() => { conn.onclose?.(eventOf('close', conn)); });
      }
      db.connections.clear();
    }
    this.#databases.clear();
  }

  /** What the store holds for `key` now (committed), or undefined. */
  peek(key: string, name = 'lmf-plus', store = 'kv'): unknown { return structuredClone(this.#databases.get(name)?.stores.get(store)?.get(key)); }
  /** Every committed key of the store. */
  keys(name = 'lmf-plus', store = 'kv'): string[] { return [...(this.#databases.get(name)?.stores.get(store)?.keys() ?? [])].sort(); }
  /** Writes `value` under `key` as if it had been committed (the database must exist). */
  set(key: string, value: unknown, name = 'lmf-plus', store = 'kv'): void {
    const s = this.#databases.get(name)?.stores.get(store);
    if (!s) throw new Error(`no database ${name} with store ${store} yet`);
    s.set(key, structuredClone(value));
  }
  /** Open connections to `name`. */
  connections(name = 'lmf-plus'): number { return [...(this.#databases.get(name)?.connections ?? [])].filter(c => !c.closed).length; }
}

/** Lets every pending request, answer and commit run (a few tasks). */
export async function settle(tasks = 20): Promise<void> { for (let i = 0; i < tasks; i++) await nextTask(); }
