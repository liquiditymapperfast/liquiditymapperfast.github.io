/**
 * One browser for the membership's tests (src/app/plus/pass.ts in IDB mode, spec section 2): a shared `localStorage` with `storage` events
 * delivered to the other tabs a task later (as browsers do), a `BroadcastChannel` between the tabs, one in-memory IndexedDB
 * (tests/plus-db-fake.mts), a clock, and tabs (`Plus` instances) opened over them.
 */
import { PLUS_STORE, Plus, type Post } from '../src/app/plus/pass.ts';
import { PlusDb } from '../src/app/plus/plus-db.ts';
import { FakeIdb } from './plus-db-fake.mts';

export const HOUR = 3_600_000, NOW = Date.UTC(2026, 10, 20, 12), UNTIL = NOW + 30 * 24 * HOUR;
export const API = 'https://plus.test/v1';
/** How long a test tab waits for its database to open. */
export const OPEN_WAIT_MS = 200;
const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
/** A pass of the server's shape for `sub`, running out at `exp`. */
export const passOf = (sub: string, exp: number): string => `v1.${b64url(JSON.stringify({ sub, exp }))}.c2lnbmF0dXJl`;
export const KEY_A = 'gift_aaaa'.padEnd(43, 'a'), KEY_B = 'sub_bbbbbb'.padEnd(43, 'b'), KEY_C = 'gift_cccc'.padEnd(43, 'c');
/** What a server gives with `key`: a pass for a day (or until `exp`). */
export const grantOf = (key: string, exp = NOW + 24 * HOUR): { key: string; pass: string; until: number; now: number; renews: boolean } => ({ key, pass: passOf(key.slice(0, 9), exp), until: UNTIL, now: NOW, renews: true });
export const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
/** Waits (a task at a time) until `ready` holds. */
export async function until(ready: () => boolean, tasks = 400): Promise<void> {
  for (let i = 0; i < tasks; i++) { if (ready()) return; await tick(); }
  throw new Error('never came');
}
export async function settle(tasks = 40): Promise<void> { for (let i = 0; i < tasks; i++) await tick(); }
/** A renewal server whose answers wait for the test. */
export function slowPost(): { post: Post; asked: { url: string; body: unknown; answer: (a: { status: number; body: unknown; retryAfter?: number } | null) => void }[] } {
  const asked: { url: string; body: unknown; answer: (a: { status: number; body: unknown; retryAfter?: number } | null) => void }[] = [];
  return { asked, post: (url, body) => new Promise((resolve, reject) => { asked.push({ url, body, answer: a => { if (a) resolve(a); else reject(new TypeError('Failed to fetch')); } }); }) };
}
export const noPost: Post = async () => { throw new Error('not asked'); };

export interface Browser {
  readonly idb: FakeIdb;
  readonly data: Map<string, string>;
  /** Every `setItem` / `removeItem` that changed something, by key, in order. */
  readonly writes: string[];
  readonly clock: { t: number };
  /** `setItem` throws for the keys it accepts (a full storage), `getItem` throws while `unreadable`. */
  refuse: ((key: string) => boolean) | null;
  unreadable: boolean;
  /** Whether `storage` events reach the other tabs (on by default). */
  events: boolean;
  /** Whether the tabs have a BroadcastChannel (on by default; off: only storage events tell them). */
  channel: boolean;
  tabs: Plus[];
  /** Each tab's own `PlusDb` (null for a tab without one), by the tab's place in `tabs`. */
  dbs: (PlusDb | null)[];
  /** A new tab: its own `PlusDb` over the browser's IndexedDB (or none: `db: false`), the shared storage and channel. */
  open(o?: { post?: Post; db?: boolean }): Plus;
  /** The membership in the mirror, by key (null: none). */
  mirrorKey(): string | null;
}

export function browser(idb: FakeIdb = new FakeIdb()): Browser {
  const data = new Map<string, string>(), writes: string[] = [];
  const b: Browser = {
    idb, data, writes, clock: { t: NOW }, refuse: null, unreadable: false, events: true, channel: true, tabs: [], dbs: [],
    open: (o = {}) => {
      const index = b.tabs.length;
      const emit = (key: string): void => {
        if (!b.events) return;
        // The event carries the value written (its `newValue`), as a browser's does.
        const value = data.get(key) ?? null;
        setImmediate(() => { b.tabs.forEach((t, j) => { if (j !== index && key === PLUS_STORE) t.mirrorChanged(value); }); });
      };
      const storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
        getItem: k => { if (b.unreadable) throw new DOMException('denied', 'SecurityError'); return data.get(k) ?? null; },
        setItem: (k, v) => {
          if (b.refuse?.(k)) throw new DOMException('full', 'QuotaExceededError');
          if (data.get(k) === v) return;
          data.set(k, v); writes.push(k); emit(k);
        },
        removeItem: k => { if (!data.has(k)) return; data.delete(k); writes.push(k); emit(k); },
      };
      const channel = b.channel ? { postMessage: (): void => { setImmediate(() => { b.tabs.forEach((t, j) => { if (j !== index) t.heard(); }); }); } } : null;
      // The open's wait is short here (3 s in the page), so a held open turns a marked tab not ready quickly.
      const db = o.db === false ? null : new PlusDb(idb.factory, undefined, OPEN_WAIT_MS);
      const tab = new Plus(storage, o.post ?? noPost, () => b.clock.t, () => API, { db, channel });
      b.tabs.push(tab); b.dbs.push(db);
      return tab;
    },
    mirrorKey: () => { const raw = data.get(PLUS_STORE); return raw ? (JSON.parse(raw) as { key: string }).key : null; },
  };
  return b;
}
