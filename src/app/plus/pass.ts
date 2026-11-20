/**
 * A Plus membership as this browser holds it. There is no account: after the checkout the server gives the browser a **key** (kept here,
 * and shown to its owner so that another device can be given it) and a **pass**, a short-lived signed note the page sends with each request
 * for a Plus file. The key renews the pass while the subscription is paid.
 *
 * Where it is kept (the checkout recovery, page build spec section 2, 2026-11-20): in a browser whose Plus database opens (`plus-db.ts`), the
 * database is the authority (IDB mode, marked by `lmf.plus.idb` in `localStorage`), and every write is one transaction that checks what the
 * operation began with (`commit`): the stored baseline `{ seed, gen }` inside the transaction, the tab's revision `rev` before it. The
 * membership is mirrored to `localStorage` (`lmf.plus`, `lmf.plus.gen`) after each commit, for the app's synchronous reads and for other tabs
 * (a `storage` event). Where IndexedDB is missing or refuses to open and no marker is set (plain mode), the membership lives in
 * `localStorage` as it always did, synchronously; such a tab never issues a key. A tab whose database is not open yet, or will not open,
 * while the marker is set reads the mirror, renews in memory and takes no key. A membership this tab took but could not store is held as an
 * overlay for as long as the tab lives, and Try again stores it (`keepAgain`).
 *
 * The page cannot check a pass's signature (only the server can) and does not need to: it reads the expiry to know when to ask again, and the
 * server decides. A pass the server refuses is dropped and asked for again.
 */
import { plusApi } from './config.ts';
import { PAID_PREFIX, PlusDbUnavailable, SEED_KEY, SEED_SHAPE, plusDbIfAny, seedIn, type PlusDb } from './plus-db.ts';
import { withTimeout } from './request-timeout.ts';

/** Where the membership is kept (`{ v, key, pass, until, ended, why, renews, skew, next }`). */
export const PLUS_STORE = 'lmf.plus';
/**
 * The membership's generation: a count bumped whenever the key held in this browser changes (a key taken, a key removed), kept beside it so
 * every tab and the Plus page share it. An answer to a key sent under an older generation is not taken (`acceptIf`), and nothing but a new
 * key is written over a generation this tab has not read (Sol, review 2026-11-19: a late answer undid a Remove, or wrote over another tab's key).
 */
export const PLUS_GEN_STORE = 'lmf.plus.gen';
/** A pass with less than this left is renewed. */
const RENEW_BEFORE_MS = 6 * 3_600_000;
/** A pass counts while it has at least this long to run, so a request sent now is not refused on arrival. */
const MARGIN_MS = 30_000;
/**
 * At most one renewal a minute per tab, whatever the last one answered (the wait is kept beside the membership, so tabs that see each
 * other's storage share it). One the server refused, or one it turned down for another reason, waits an hour; a busy server's Retry-After
 * is kept within a minute and an hour.
 */
const RETRY_MS = 60_000, LONG_RETRY_MS = 3_600_000, SHORT_PASS_RETRY_MS = 5 * 60_000;
/** The device's clock and the server's count as agreeing within this much (an answer takes a moment to arrive). */
const CLOCK_SLACK_MS = 5 * 60_000;
/** A server time below this is not milliseconds (seconds, or nonsense) and is not believed. */
const MIN_EPOCH_MS = 1e11;

export interface Held {
  /** The key that renews the pass: the membership itself, as far as this browser goes. */
  key: string;
  /** The pass in force, or '' when the last renewal was refused (the subscription ended) or none has come yet. */
  pass: string;
  /** When the paid period ends, as the server last said. */
  until: number;
  /** The server refused to renew: the subscription is not in good standing, or the key was replaced. */
  ended: boolean;
  /** Why, as the server said (`canceled`, `replaced`, `unknown`, `gift_ended`, …), or ''. */
  why: string;
  /** Whether the membership renews by itself, as the server last said (null: it did not say). */
  renews: boolean | null;
  /** The server's clock minus this device's when the pass came, where they differ by more than a few minutes: a pass's end is judged by the server's clock. */
  skew: number;
  /** No renewal is asked for before this, in any tab that has seen it. */
  next: number;
}
/** What the server grants, as the page reads it. */
export interface Grant { pass: string; until: number; key?: string; renews?: boolean; now?: number }

const b64 = (text: string): string | null => {
  try { return atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')); } catch { return null; }
};

/** What a pass says about itself (`v1.<base64url JSON>.<signature>`): whose it is and when it runs out. Null for anything else. */
export function parsePass(text: unknown): { sub: string; exp: number } | null {
  if (typeof text !== 'string' || text.length > 2_000) return null;
  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null;
  const json = b64(parts[1]); if (json === null) return null;
  try {
    const body = JSON.parse(json) as { sub?: unknown; exp?: unknown };
    return typeof body.sub === 'string' && body.sub !== '' && typeof body.exp === 'number' && Number.isFinite(body.exp) ? { sub: body.sub, exp: body.exp } : null;
  } catch { return null; }
}
const expOf = (pass: string): number => parsePass(pass)?.exp ?? 0;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const reason = (value: unknown): string => typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : '';

/** What is kept, checked; anything malformed reads as no membership. */
export function readHeld(raw: string | null): Held | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { v?: unknown; key?: unknown; pass?: unknown; until?: unknown; ended?: unknown; why?: unknown; renews?: unknown; skew?: unknown; next?: unknown };
    if (o.v !== 1 || typeof o.key !== 'string' || o.key.length < 16 || o.key.length > 200) return null;
    return {
      key: o.key, pass: typeof o.pass === 'string' && parsePass(o.pass) ? o.pass : '', until: finite(o.until) ? o.until : 0,
      ended: o.ended === true, why: reason(o.why), renews: typeof o.renews === 'boolean' ? o.renews : null, skew: finite(o.skew) ? o.skew : 0, next: finite(o.next) ? o.next : 0,
    };
  } catch { return null; }
}

/**
 * The server's answer to a checkout, a restore or a renewal, checked. `until` is when the paid period ends (the server's `paidUntil`;
 * its own `until` is the pass's expiry, which the pass says itself); `now` is the server's clock when it answered, in milliseconds.
 */
export function readGrant(raw: unknown): Grant | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { pass?: unknown; until?: unknown; paidUntil?: unknown; key?: unknown; renews?: unknown; now?: unknown };
  const until = typeof o.paidUntil === 'number' ? o.paidUntil : o.until;
  if (typeof o.pass !== 'string' || !parsePass(o.pass) || !finite(until)) return null;
  return {
    pass: o.pass, until,
    ...(typeof o.key === 'string' && o.key.length >= 16 && o.key.length <= 200 ? { key: o.key } : {}),
    ...(typeof o.renews === 'boolean' ? { renews: o.renews } : {}),
    ...(finite(o.now) && o.now > MIN_EPOCH_MS ? { now: o.now } : {}),
  };
}

/** The server's clock minus the device's, or 0 while they agree (or the server did not say). */
const skewOf = (serverNow: number | undefined, now: number): number => serverNow !== undefined && Math.abs(serverNow - now) > CLOCK_SLACK_MS ? serverNow - now : 0;

/** A request to the Plus server: its status, its body, and how long the server asked to wait (`Retry-After`, in seconds) when it did. */
export type Post = (url: string, body: unknown, signal?: AbortSignal) => Promise<{ status: number; body: unknown; retryAfter?: number }>;
type Kept = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The error code of a JSON answer (`{"error":"…"}`), or ''. */
export const errorOf = (body: unknown): string => { const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : null; return typeof e === 'string' ? e : ''; };

/** A request to the Plus server, given up by the caller (a key form closed) or after 20 s in every browser (`request-timeout.ts`). */
export const webPost: Post = (url, body, given) => withTimeout(async signal => {
  const answer = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal });
  let parsed: unknown = null;
  try { parsed = await answer.json(); } catch (error) {
    // Given up while the body was read (the timeout or the caller): no answer at all, as when the request never came back (Sol, C2-7).
    if (signal.aborted) throw signal.reason ?? error;
    /* an answer without a JSON body says enough with its status */
  }
  const wait = Number(answer.headers.get('retry-after'));
  return { status: answer.status, body: parsed, ...(Number.isFinite(wait) && wait > 0 ? { retryAfter: wait } : {}) };
}, given);

/** Set (`'1'`) once the Plus database is this browser's authority for the membership: from then on every tab goes through it. */
export const PLUS_IDB_MARKER = 'lmf.plus.idb';
/** A commit waits this long for the database (reopening after an upgrade elsewhere, say); after that it has failed. */
const COMMIT_WAIT_MS = 10_000;

/**
 * Where this tab stands (spec 2.1): opening its database (every tab with IndexedDB starts here), IDB mode (open: the database is the
 * authority), not ready (the marker set, its database not open yet), unusable here (the marker set, its open failed), or plain (no marker,
 * and no IndexedDB or its open failed: `localStorage` as before, nothing issued).
 */
export type PlusMode = 'opening' | 'idb' | 'notready' | 'unusable' | 'plain';
/** The stored baseline: the database's seed (its epoch: a reset makes a new one; null while none was made) and the membership's generation. */
export interface Baseline { readonly seed: string | null; readonly gen: number }
/**
 * What an operation captured when it began (`capture`): the stored baseline, this tab's revision, and the payments waiting then (what a key
 * or a receipt's membership settles when it is taken). Opaque to its callers.
 */
export interface Capture { readonly base: Baseline; readonly rev: number; readonly waiting: readonly string[] }
/**
 * How taking or removing a membership went: stored (`kept`), held by this tab only because the browser would not store it (`unkept`: the
 * overlay), dropped because the membership changed since the operation began (`stale`), or not done because this tab takes no key (`refused`:
 * its database is not open, or will not open, while the browser's membership lives there).
 */
export type Taken = 'kept' | 'unkept' | 'stale' | 'refused';
/** The membership as the database keeps it (`member`): its generation and what is held, written together. */
export interface StoredMember { gen: number; held: Held | null }
/** A `BroadcastChannel('lmf.plus')`, or a test's stand-in: told after each commit. */
export interface PlusChannel { postMessage(message: unknown): void }
/** The database and the channel a membership works with (none: plain mode, as in Node). */
export interface PlusOptions { db?: PlusDb | null; channel?: PlusChannel | null }
/** A grant to take: the key, its pass and what the server said with it. */
export interface GrantIn { key: string; pass: string; until: number; renews?: boolean; now?: number }

/** A membership this tab holds but could not store (spec 2.4): what it holds, the baseline it began with, its settlement, and why it failed. */
interface Overlay { held: Held | null; base: Baseline; settle: readonly string[]; quota: boolean }
const NOCHANGE = Symbol('no change');
/** What a commit writes, from what the database holds now (`NOCHANGE`: nothing, and the commit is stale). */
type Change = (current: Held | null) => Held | null | typeof NOCHANGE;
/**
 * A commit: an operation (it takes or removes a key, guarded by its baseline and revision; a grant may use the same-key exception) or a
 * renewal's write (guarded by its own change, which checks the key).
 */
interface CommitOp {
  kind: 'operation' | 'renewal'; expect: Baseline | null; rev: number | null; change: Change; settle: readonly string[]; grant?: Held;
  /** A renewal's result: where this tab does not store (an overlay's key, no database open) it is applied in memory at the queue's head. */
  local?: boolean;
  /** "Try again": the stored wait is the tab's too (not merged with a later wait this tab held). */
  resetWait?: boolean;
}
type Committed = { kind: 'ok'; stored: StoredMember; seed: string | null } | { kind: 'stale' } | { kind: 'failed'; error: unknown } | { kind: 'local' };

/** The stored membership, checked (anything malformed reads as none, at generation 0). */
export function storedMember(value: unknown): StoredMember {
  if (!value || typeof value !== 'object') return { gen: 0, held: null };
  const o = value as { gen?: unknown; held?: unknown };
  const gen = typeof o.gen === 'number' && Number.isSafeInteger(o.gen) && o.gen >= 0 ? o.gen : 0;
  const held = o.held && typeof o.held === 'object' ? readHeld(JSON.stringify({ ...(o.held as object), v: 1 })) : null;
  return { gen, held };
}
const seedOf = (value: unknown): string | null => typeof value === 'string' && SEED_SHAPE.test(value) ? value : null;
const isQuota = (error: unknown): boolean => error instanceof DOMException && error.name === 'QuotaExceededError';
/** `held` with the later pass of `from` (the same key): its pass, end, renewal, clock and wait, and no end of its own any more. */
const withPass = (held: Held, from: Held): Held => ({ ...held, pass: from.pass, until: from.until, renews: from.renews, skew: from.skew, next: from.next, ended: false, why: '' });
/** Whether two memberships show the same (what the listeners are told about). */
const sameHeld = (a: Held | null, b: Held | null): boolean => a?.key === b?.key && a?.pass === b?.pass && a?.until === b?.until && a?.ended === b?.ended && a?.renews === b?.renews && a?.why === b?.why;

/**
 * A renewal's answer applied to the membership `cur` (the key `key`, renewed from the pass `sent`) at `at`, by the rules of the plain renewal:
 * the new membership and whether Plus could not be verified, or null when it changes nothing (another key held, or a newer pass got meanwhile).
 */
function renewed(cur: Held | null, key: string, sent: string, answer: { status: number; body: unknown; retryAfter?: number }, at: number): { held: Held; unverified: boolean } | null {
  if (cur?.key !== key) return null;
  const newer = cur.pass !== sent && expOf(cur.pass) - (at + cur.skew) > MARGIN_MS;
  const grant = answer.status === 200 ? readGrant(answer.body) : null;
  if (grant) {
    if (newer && expOf(cur.pass) >= expOf(grant.pass)) return null;
    const skew = skewOf(grant.now, at), left = expOf(grant.pass) - (at + skew);
    const wait = left >= RENEW_BEFORE_MS + CLOCK_SLACK_MS ? RETRY_MS : left > 0 ? Math.min(LONG_RETRY_MS, Math.max(SHORT_PASS_RETRY_MS, left / 2)) : LONG_RETRY_MS;
    return { held: { key, pass: grant.pass, until: grant.until, ended: false, why: '', renews: grant.renews ?? null, skew, next: at + wait }, unverified: false };
  }
  if (answer.status === 403 && errorOf(answer.body) === 'not_active') {
    if (newer) return null;
    return { held: { ...cur, pass: '', ended: true, why: reason((answer.body as { status?: unknown }).status), next: at + LONG_RETRY_MS }, unverified: false };
  }
  const busy = answer.status === 429 || answer.status >= 500;
  const wait = busy ? Math.min(LONG_RETRY_MS, Math.max(RETRY_MS, (answer.retryAfter ?? 0) * 1_000)) : LONG_RETRY_MS;
  return { held: { ...cur, next: Math.max(cur.next, at + wait) }, unverified: true };
}

/** `localStorage`, or nothing where the browser refuses it (a private window of some browsers): the page then simply has no membership. */
function kept(): Kept | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** Where a membership stands in this browser: none, in force, being asked for (no pass at hand yet, or the server not reached), or ended. */
export type PlusState = 'none' | 'on' | 'checking' | 'ended';

export class Plus {
  #held: Held | null;
  #listeners = new Set<() => void>();
  /** The key a renewal is under way for (one at a time per key; a membership accepted meanwhile renews on its own). */
  #renewing: string | null = null;
  /** Whether Plus was in force when the listeners were last told (`tick`). */
  #wasOn = false;
  /**
   * The last renewal did not reach the server or found it busy or down (no answer, a 5xx, a 429): the membership could not be verified, which
   * says nothing about the key. Cleared by any answer of the server's own and by `retry`.
   */
  #unverified = false;
  /** The generation this tab last read (or wrote, with a key); where the browser keeps nothing, this tab's own count. */
  #seenGen = 0;
  #memGen = 0;
  /** The Plus database (null: plain mode, or unusable here when the marker is set) and the channel other tabs hear commits on. */
  readonly #db: PlusDb | null;
  readonly #channel: PlusChannel | null;
  #mode: PlusMode;
  #selecting: Promise<void> | null = null;
  /** The stored baseline as this tab last read or wrote it (IDB mode). */
  #known: Baseline | null = null;
  /** This tab's revision: increased whenever an overlay is taken, replaced or dropped; never decreased or reset (spec 2.2). */
  #rev = 0;
  #overlay: Overlay | null = null;
  /**
   * The pass this tab got from a renewal and could not store (not ready or unusable here, or its commit failed): the only pass of its own that
   * may win over the stored one (spec 2.4). A pass this tab merely read from the store or the mirror never does: a refusal another tab
   * stored (no pass, ended) stands.
   */
  #memoryPass: string | null = null;
  /**
   * The first open's wait ran out without an answer (an unmarked browser stays opening): the key shown renews in memory only from then on,
   * as a tab not ready does, until the open answers (Sol, code review C1-1, 2026-11-20: renewal must not stop for an open that hangs).
   */
  #openWaited = false;
  /** A renewal asked while the tab was still within its first open's wait: run once the mode settles. */
  #renewWanted = false;
  /** The membership commits of this tab, one at a time. */
  #queue: Promise<unknown> = Promise.resolve();
  constructor(private storage: Kept | null = kept(), private post: Post = webPost, private now: () => number = Date.now, private api: () => string = () => plusApi(), options: PlusOptions = {}) {
    this.#held = this.#read() ?? null;
    this.#seenGen = this.#readGen();
    this.#wasOn = this.#valid(this.now());
    this.#db = options.db ?? null;
    this.#channel = options.channel ?? null;
    // The mirror stands until the database answers; without a database the mode is known at once (plain, or unusable when marked).
    this.#mode = this.#db ? 'opening' : this.#marker() ? 'unusable' : 'plain';
    if (this.#db) void this.#reselect();
  }
  /** The generation as kept now (this tab's own count where the browser keeps nothing). */
  #readGen(): number {
    if (!this.storage) return this.#memGen;
    try { const v = Number(this.storage.getItem(PLUS_GEN_STORE) ?? 0); return Number.isSafeInteger(v) && v >= 0 ? v : 0; } catch { return this.#memGen; }
  }
  /** Another key held from now on (taken or removed): a new generation, read by this tab as it writes it. */
  #bumpGen(): void {
    const next = Math.max(this.#readGen(), this.#memGen) + 1;
    this.#memGen = next; this.#seenGen = next;
    try { this.storage?.setItem(PLUS_GEN_STORE, String(next)); } catch { /* this tab's own count stands */ }
  }
  /**
   * The membership's generation now, read again from where it is kept: what a key sent now is checked against when its answer comes
   * (`acceptIf`), in plain mode. In IDB mode an operation captures its baseline with `capture` instead; this is the stored generation as last
   * seen.
   */
  generation(): number { return this.#mode === 'plain' || !this.#known ? this.#readGen() : this.#known.gen; }
  /** What is kept: the membership, null for none, undefined when it could not be read (what this tab holds then stands). */
  #read(): Held | null | undefined {
    if (!this.storage) return null;
    try { return readHeld(this.storage.getItem(PLUS_STORE)); } catch { return undefined; }
  }
  /**
   * Whether what is held was written where it is kept (false: a browser that will not keep it, the membership lasting as long as this tab; or,
   * for anything but a new key, another tab changed the key since this tab read it: then nothing is written and this tab takes the other's).
   */
  #write(newKey = false): boolean {
    try {
      if (!this.storage) return false;
      if (!newKey && this.#readGen() !== this.#seenGen) { this.reload(); return false; }
      if (this.#held) this.storage.setItem(PLUS_STORE, JSON.stringify({ v: 1, ...this.#held }));
      else this.storage.removeItem(PLUS_STORE);
      return true;
    } catch { return false; }
  }
  #changed(): void { this.#wasOn = this.#valid(this.now()); for (const listener of [...this.#listeners]) listener(); }
  /** Whether the pass held has time to run at `now`, by the server's clock. */
  #valid(now: number, held: Held | null = this.#held): boolean {
    return held !== null && expOf(held.pass) - (now + held.skew) > MARGIN_MS;
  }

  /** The pass to send with a request for a Plus file, or null: no membership here, or its pass has run out. Asking keeps it fresh. */
  pass(now: number = this.now()): string | null {
    const held = this.#held;
    if (!held) return null;
    if (expOf(held.pass) - (now + held.skew) < RENEW_BEFORE_MS) this.renew();
    const fresh = this.#held;
    return fresh && this.#valid(now, fresh) ? fresh.pass : null;
  }
  /** Whether Plus is in force in this browser now. */
  get on(): boolean { return this.pass() !== null; }
  /** Whether a membership was ever set up in this browser (in force or ended). */
  get known(): boolean { return this.#held !== null; }
  /** Where the membership stands. A pass that ran out is `checking` until the server answers: only the server's refusal is `ended`. */
  get state(): PlusState { return !this.#held ? 'none' : this.on ? 'on' : this.#held.ended ? 'ended' : 'checking'; }
  /** Why it ended, as the server said (`replaced`: newer keys pushed this one out), or ''. */
  get why(): string { return this.#held?.ended ? this.#held.why : ''; }
  /** When the paid period ends, as last heard, or null. */
  get until(): number | null { return this.#held && this.#held.until > 0 ? this.#held.until : null; }
  /** Whether it renews by itself, as the server last said (null: not said). */
  get renews(): boolean | null { return this.#held?.renews ?? null; }
  /** The key, for its owner to copy to another device. */
  get key(): string | null { return this.#held?.key ?? null; }
  /** Whether a renewal is under way for the key held. */
  get renewing(): boolean { return this.#held !== null && this.#renewing === this.#held.key; }
  /** Whether the last renewal could not reach the server (or found it busy or down): Plus could not be verified, the key may be fine. */
  get unverified(): boolean { return this.#unverified; }
  /**
   * "Try again": a renewal now, whatever wait the last one left (one at a time still: none while one is under way). What is kept is read first:
   * a key another tab removed or replaced meanwhile is not tried again, nor written back (Sol, review 2026-11-19).
   */
  retry(): void {
    if (this.#mode !== 'plain') { void this.#retryHere(); return; }
    if (this.#plainBlocked()) return;
    const was = this.#held?.key ?? null;
    this.reload();
    const held = this.#held;
    if (!held || held.key !== was || this.#renewing === held.key) return;
    this.#held = { ...held, next: 0 }; this.#write();
    if (this.#unverified) { this.#unverified = false; this.#changed(); }
    this.renew();
  }
  /** Tell the listeners when the verification's state changes (it changes no pass). */
  #verified(unverified: boolean): void { if (this.#unverified !== unverified) { this.#unverified = unverified; this.#changed(); } }

  /** A checkout, a restore or a key typed in gave this browser a membership. False when the browser would not keep it (it lasts as long as this tab). */
  accept(grant: GrantIn): boolean {
    if (this.#mode === 'plain' && this.#plainBlocked()) return false;
    const now = this.now();
    this.#held = { key: grant.key, pass: parsePass(grant.pass) ? grant.pass : '', until: grant.until, ended: false, why: '', renews: grant.renews ?? null, skew: skewOf(grant.now, now), next: 0 };
    this.#unverified = false;
    this.#bumpGen();
    const stored = this.#write(true); this.#changed();
    return stored;
  }
  /**
   * A key's grant taken only while the membership is the one the key was sent under (what `capture` gave when it was sent): a key another tab
   * stored meanwhile, or the key here removed, wins, and the grant is dropped (`stale`). In plain mode (a number from `generation`) it is
   * synchronous, as `accept`: `kept`, or `unkept` (this tab only). In IDB mode (a `Capture`) it is one commit, settling the payments `settle`
   * names in the same transaction: a promise of `kept`, `stale`, or `unkept` (held as the overlay). A tab that takes no key: `refused`.
   */
  acceptIf(generation: number | Capture | null, grant: GrantIn, settle: readonly string[] = []): Taken | Promise<Taken> {
    if (typeof generation === 'number') {
      if (this.#mode !== 'plain') return 'stale';
      // The marker appeared (another tab moved the browser to its database): nothing is taken here; if this tab's database opens now, the
      // grant is taken again as a new operation (its baseline read now).
      if (this.#marker()) return this.#reselected(async () => { const cap = await this.capture(); return cap === null || typeof cap === 'number' ? 'refused' : this.#take(cap, grant, settle); });
      this.reload();
      if (this.#readGen() !== generation) return 'stale';
      return this.accept(grant) ? 'kept' : 'unkept';
    }
    if (generation === null || this.#mode !== 'idb') return 'refused';
    return this.#take(generation, grant, settle);
  }
  /**
   * This browser lets its membership go (the subscription itself is not touched). Synchronous in plain mode; in IDB mode one commit (a
   * promise of how it went), which also drops an overlay; a tab that takes no key removes nothing (`refused`).
   */
  forget(): void | Promise<Taken> {
    if (this.#mode !== 'plain') return this.#mode === 'idb' ? this.#remove() : Promise.resolve<Taken>('refused');
    if (this.#marker()) return this.#reselected(() => this.#remove());
    if (!this.#held) return; this.#held = null; this.#unverified = false; this.#bumpGen(); this.#write(true); this.#changed();
  }
  /**
   * The server refused a pass it was sent (`pass`: which one; a late answer about a pass since replaced says nothing about the new one).
   * It is dropped and a new one asked for, within the one-a-minute rule: a server that refuses even the pass it has just given (its two
   * halves disagreeing) is not asked in a circle, by this tab or by two tabs taking turns.
   */
  refused(pass?: string | null): void {
    if (this.#mode !== 'plain') { void this.#refusedHere(pass); return; }
    if (this.#plainBlocked()) return;
    this.reload();
    const held = this.#held;
    if (!held || held.pass === '' || (pass != null && pass !== held.pass)) return;
    this.#held = { ...held, pass: '' };
    this.#write(); this.#changed();
    this.renew();
  }
  /**
   * What is kept changed elsewhere (another tab, the Plus page after a checkout), or is read before this tab writes. A storage that cannot
   * be read leaves what this tab holds; another tab's wait is this tab's too, and this tab's own is not forgotten for it.
   */
  reload(): void {
    if (this.#mode === 'idb') { void this.#enqueue(() => this.#refresh()); return; }
    const next = this.#read(), was = this.#held;
    if (next === undefined) return;
    this.#seenGen = this.#readGen();
    if (next && was && next.key === was.key) next.next = Math.max(next.next, was.next);
    // A tab without its database keeps a renewal it could not store (memory only) over an older pass of the same key in the mirror.
    if (this.#mode !== 'plain' && next && was && next.key === was.key && this.#memoryPass !== null && was.pass === this.#memoryPass && expOf(was.pass) > expOf(next.pass)) Object.assign(next, withPass(next, was));
    this.#held = next;
    if (next?.key === was?.key && next?.pass === was?.pass && next?.until === was?.until && next?.ended === was?.ended && next?.renews === was?.renews && next?.why === was?.why) return;
    this.#changed();
  }
  /** A pass that ran out says nothing when it does: called now and then, this tells the listeners when Plus went off (or on) unannounced. */
  tick(): void { if (this.on !== this.#wasOn) this.#changed(); }
  /** Ask the server for a fresh pass with the key, unless one is being asked for or the last was asked too recently. */
  renew(): void {
    if (this.#mode !== 'plain') {
      // Within the first open's wait the renewal waits for the mode (and is then asked once); after it, it runs in memory.
      if (this.#mode === 'opening' && !this.#openWaited) { this.#renewWanted = true; return; }
      void this.#renewHere(); return;
    }
    if (this.#plainBlocked()) return;
    // What another tab wrote counts first: a frozen tab waking up must not write its old pass over a newer one.
    this.reload();
    const held = this.#held, now = this.now();
    // A wait further off than the longest there is was written by a clock since set back: it does not hold.
    if (!held || this.#renewing === held.key || (now < held.next && held.next - now <= LONG_RETRY_MS)) return;
    // Another tab may have renewed meanwhile: a pass with time to spare is not renewed again.
    if (expOf(held.pass) - (now + held.skew) >= RENEW_BEFORE_MS) return;
    const key = held.key, sent = held.pass;
    this.#renewing = key;
    this.#held = { ...held, next: now + RETRY_MS }; this.#write();
    void this.post(`${this.api()}/pass/renew`, { key }).then(answer => {
      this.reload();
      const cur = this.#held, at = this.now();
      if (cur?.key !== key) return;
      // Another tab got a newer pass for this key meanwhile: that answer is the later one.
      const newer = cur.pass !== sent && this.#valid(at, cur);
      const grant = answer.status === 200 ? readGrant(answer.body) : null;
      if (grant) {
        if (newer && expOf(cur.pass) >= expOf(grant.pass)) return;
        const skew = skewOf(grant.now, at), left = expOf(grant.pass) - (at + skew);
        // A pass that comes already near its end (the last hours of a membership): asked again at half its time left, within five minutes
        // and an hour (a membership paid again meanwhile is seen before the pass runs out); one that comes already run out, in an hour.
        const wait = left >= RENEW_BEFORE_MS + CLOCK_SLACK_MS ? RETRY_MS : left > 0 ? Math.min(LONG_RETRY_MS, Math.max(SHORT_PASS_RETRY_MS, left / 2)) : LONG_RETRY_MS;
        this.#held = { key, pass: grant.pass, until: grant.until, ended: false, why: '', renews: grant.renews ?? null, skew, next: at + wait };
        this.#unverified = false;
        this.#write(); this.#changed(); return;
      }
      // The server's refusal: the subscription is not in good standing, or the key was replaced. The key stays (a subscription paid again
      // may renew with it); the pass goes. Any other 403 (a firewall's page, a challenge) says nothing about the membership.
      if (answer.status === 403 && errorOf(answer.body) === 'not_active') {
        if (newer) return;
        const why = reason((answer.body as { status?: unknown }).status), news = cur.pass !== '' || !cur.ended || cur.why !== why || this.#unverified;
        this.#held = { ...cur, pass: '', ended: true, why, next: at + LONG_RETRY_MS };
        this.#unverified = false;
        this.#write(); if (news) this.#changed();
        return;
      }
      // Busy or down (429, 5xx): again when it said, within a minute and an hour. Turned down for another reason (another 4xx, a page that
      // is not the server's): the pass is kept and the server asked again in an hour. Either way Plus could not be verified.
      const busy = answer.status === 429 || answer.status >= 500;
      const wait = busy ? Math.min(LONG_RETRY_MS, Math.max(RETRY_MS, (answer.retryAfter ?? 0) * 1_000)) : LONG_RETRY_MS;
      this.#held = { ...cur, next: Math.max(cur.next, at + wait) }; this.#write();
      this.#verified(true);
    }, () => { if (this.#held?.key === key) this.#verified(true); /* not reached (or given up): the minute already set stands */ }).finally(() => { if (this.#renewing === key) this.#renewing = null; });
  }
  /** Told whenever the membership here changes (a pass came, went, or was replaced), and when the mode or the overlay changes. */
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }

  // ---- The modes (spec 2.1) ----

  /** Where this tab stands with its database. */
  get mode(): PlusMode { return this.#mode; }
  /** Whether this tab may issue (open a checkout, ask for a payment's key, send the receipt): only in IDB mode (spec 0, 4). */
  get issues(): boolean { return this.#mode === 'idb'; }
  /** Whether this tab takes a key typed in and removes one: in IDB mode and in plain mode (not while opening, not ready or unusable here). */
  get takesKeys(): boolean { return this.#mode === 'idb' || this.#mode === 'plain'; }
  /** Whether this tab holds a membership it could not store (the overlay): it lasts until the tab closes. */
  get unstored(): boolean { return this.#overlay !== null; }
  /** The payments the overlay settles when it is stored (`keepAgain`): what the page's list drops then. */
  get overlaySettle(): readonly string[] { return this.#overlay?.settle ?? []; }
  /** Whether storing it failed for another reason than a full storage: then Try again (`keepAgain`) is offered. */
  get saveFailed(): boolean { return this.#overlay !== null && !this.#overlay.quota; }
  #setMode(mode: PlusMode): void {
    if (this.#mode !== mode) { this.#mode = mode; this.#changed(); }
    if (mode !== 'opening') this.#runWanted();
  }
  /** A renewal asked while the first open was awaited runs once the mode has settled (or the wait ran out), if it is still due. */
  #runWanted(): void {
    if (!this.#renewWanted) return;
    this.#renewWanted = false;
    queueMicrotask(() => { this.renew(); });
  }
  #marker(): boolean { try { return this.storage?.getItem(PLUS_IDB_MARKER) === '1'; } catch { return false; } }
  #setMarker(): boolean {
    try {
      if (!this.storage) return false;
      if (this.storage.getItem(PLUS_IDB_MARKER) !== '1') this.storage.setItem(PLUS_IDB_MARKER, '1');
      return true;
    } catch { return false; }
  }
  /** A plain tab about to write finds the marker: it writes nothing and selects its mode again (spec 2.1). */
  #plainBlocked(): boolean {
    if (!this.#marker()) return false;
    void this.#reselect();
    return true;
  }
  #reselect(): Promise<void> {
    this.#selecting ??= this.#select().finally(() => { this.#selecting = null; });
    return this.#selecting;
  }
  /** After selecting the mode again: `run` as a new operation in IDB mode, else nothing (`refused`). */
  async #reselected(run: () => Promise<Taken>): Promise<Taken> {
    await this.#reselect();
    return this.#mode === 'idb' ? run() : 'refused';
  }
  /** Opening: the database's answer within 3 s decides; a timeout leaves a marked tab not ready and an unmarked one opening, both waiting on. */
  async #select(): Promise<void> {
    const db = this.#db;
    if (!db) { this.#setMode(this.#marker() ? 'unusable' : 'plain'); return; }
    this.#setMode('opening');
    const outcome = await db.open();
    if (outcome === 'error') { this.#setMode(this.#marker() ? 'unusable' : 'plain'); return; }
    if (outcome === 'timeout') {
      this.#openWaited = true;
      if (this.#marker()) this.#setMode('notready');
      else this.#runWanted();
      await new Promise<void>(resolve => {
        const off = db.subscribe(state => { if (state === 'open' || state === 'failed') { off(); resolve(); } });
        if (db.state === 'open' || db.state === 'failed') { off(); resolve(); }
      });
      if (db.state !== 'open') { this.#setMode(this.#marker() ? 'unusable' : 'plain'); return; }
    }
    await this.#enter();
  }
  /** The database opened: the browser's already (`migrated`), or moved to it now, marker first, then the one-time import (spec 2.1, 2.3). */
  async #enter(): Promise<void> {
    const db = this.#db!;
    let migrated: boolean;
    try { migrated = await db.tx('readonly', async kv => (await kv.get('migrated')) === true, COMMIT_WAIT_MS); } catch { this.#setMode(this.#marker() ? 'unusable' : 'plain'); return; }
    if (migrated) {
      // `localStorage` cleared alone: the marker is written again (and again after each commit while it fails); never back to plain mode.
      this.#setMarker();
    } else {
      // The marker first: a browser whose marker cannot be written stays in plain mode, and nothing is imported.
      if (!this.#setMarker()) { this.#setMode('plain'); return; }
      try {
        await db.tx('readwrite', async kv => {
          if ((await kv.get('member')) === undefined) {
            // Read inside the transaction; a storage that cannot be read throws, and nothing is set (the next load runs it again).
            const raw = this.storage ? this.storage.getItem(PLUS_STORE) : null, gen = Number(this.storage ? this.storage.getItem(PLUS_GEN_STORE) ?? 0 : 0);
            await kv.put('member', { gen: Number.isSafeInteger(gen) && gen >= 0 ? gen : 0, held: readHeld(raw) } satisfies StoredMember);
          }
          await kv.put('migrated', true);
        }, COMMIT_WAIT_MS);
      } catch { this.#setMode('unusable'); return; }
    }
    // What is stored is adopted before the tab says it is in IDB mode, and only once it has been read: a read that fails is tried again,
    // then the tab is unusable here (it shows the mirror) rather than showing no membership over a stored one (Sol, code review C1-2).
    let read = false;
    for (let attempt = 0; attempt < 3 && !read; attempt++) read = await this.#enqueue(() => this.#refresh(true));
    if (!read) { this.#setMode('unusable'); return; }
    this.#setMode('idb');
  }

  // ---- IDB mode: reads, adoption and the mirror ----

  /** One step of this tab's commits and reads, after the ones before it. */
  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }
  /** The stored membership read again and adopted (another tab's commit, the page shown again). Whether it was read. */
  async #refresh(entering = false): Promise<boolean> {
    const db = this.#db;
    if ((this.#mode !== 'idb' && !entering) || !db) return false;
    let read: { stored: StoredMember; seed: string | null };
    try { read = await db.tx('readonly', async kv => ({ stored: storedMember(await kv.get('member')), seed: seedOf(await kv.get(SEED_KEY)) }), COMMIT_WAIT_MS); } catch { return false; }
    this.#adopt(read.stored, read.seed);
    return true;
  }
  /**
   * The stored membership is the one in force here, unless this tab holds an overlay over the very baseline it began with. Another tab's
   * commit (another generation or seed) drops the overlay. A renewal this tab could not store that runs out later than the stored pass of the
   * same key is applied by one commit (the adoption rule, spec 2.3 and 2.4). The mirror is written from what is stored.
   */
  #adopt(stored: StoredMember, seed: string | null): void {
    this.#known = { seed, gen: stored.gen };
    this.#writeMirror(stored);
    this.#ensureMarker();
    let told = false;
    if (this.#overlay) {
      if (this.#overlay.base.gen === stored.gen && this.#overlay.base.seed === seed) return;
      this.#overlay = null; this.#rev++; told = true;
    }
    const was = this.#held;
    let next = stored.held;
    if (next && was && next.key === was.key) {
      if (this.#memoryPass !== null && was.pass === this.#memoryPass && expOf(was.pass) > expOf(next.pass)) { const memory = was; next = withPass(next, memory); void this.#adoptPass(memory); }
      else this.#memoryPass = null;
      next = { ...next, next: Math.max(next.next, was.next) };
    }
    this.#held = next;
    if (told || !sameHeld(next, was)) this.#changed();
  }
  /** A later pass for the key the database holds (kept in memory here), written by one commit if it is still later. */
  async #adoptPass(from: Held): Promise<Committed> {
    const out = await this.#commit({ kind: 'renewal', expect: null, rev: null, settle: [], change: cur => cur && cur.key === from.key && expOf(from.pass) > expOf(cur.pass) ? withPass(cur, from) : NOCHANGE });
    if (out.kind !== 'failed' && this.#memoryPass === from.pass) this.#memoryPass = null;
    return out;
  }
  /** The mirror, a function of the stored membership alone; written only where it differs (so tabs answering each other's events stop). */
  #writeMirror(stored: StoredMember): void {
    if (!this.storage) return;
    try {
      const text = stored.held ? JSON.stringify({ v: 1, ...stored.held }) : null, gen = String(stored.gen);
      if (this.storage.getItem(PLUS_STORE) !== text) { if (text === null) this.storage.removeItem(PLUS_STORE); else this.storage.setItem(PLUS_STORE, text); }
      if (this.storage.getItem(PLUS_GEN_STORE) !== gen) this.storage.setItem(PLUS_GEN_STORE, gen);
    } catch { /* repaired at the next load or commit */ }
  }
  #ensureMarker(): void { if (this.#db?.state === 'open' && !this.#marker()) this.#setMarker(); }

  /**
   * `lmf.plus` changed in another tab (its `storage` event). In IDB mode a previous build's write is never adopted on its counter: one commit
   * compares it with the stored membership inside the transaction, and takes only a later pass for the same key (an old tab renewed it);
   * anything else leaves the database as it is and the mirror is written again from it (spec 2.3). Elsewhere the mirror is read. `value` is
   * the event's own value (`newValue`), taken now: a mirror repair queued earlier can then not erase it before it is compared (Sol, code
   * review C1-5); without one, the mirror is read now.
   */
  mirrorChanged(value?: string | null): void {
    if (this.#mode !== 'idb') { this.reload(); return; }
    let seen: Held | null = null;
    try { seen = readHeld(value !== undefined ? value : this.storage?.getItem(PLUS_STORE) ?? null); } catch { seen = null; }
    // No candidate (another tab removed the membership, or a value that is not one): the stored membership is read and adopted, so this tab
    // ends holding what is stored (Sol, code review C3-3). A candidate's commit adopts it too, whether it takes the candidate or not.
    if (!seen) { void this.#enqueue(() => this.#refresh()); return; }
    const candidate = seen;
    // Never over a stored refusal (no pass): an event may carry a value a tab of this build wrote before that refusal, and a stored pass of
    // one key only ever moves later otherwise.
    void this.#commit({ kind: 'renewal', expect: null, rev: null, settle: [],
      change: cur => cur && cur.pass !== '' && !cur.ended && candidate.key === cur.key && expOf(candidate.pass) > expOf(cur.pass) ? withPass(cur, candidate) : NOCHANGE });
  }
  /** Another tab committed (its message on the channel): read again. */
  heard(): void { this.reload(); }

  // ---- IDB mode: the commit (spec 2.2) ----

  /**
   * One readwrite transaction, after this tab's earlier commits: stale without a transaction when the tab's revision changed since the
   * operation began; inside it, stale when the seed differs (an answer from before a reset), or the generation differs (save for a grant of
   * the key already held, which keeps the stored membership and only applies a later pass); else `change` decides what is written, the
   * generation moving on when the key changes, and the payments named in `settle` are removed in the same transaction. After it completes:
   * the mirror, this tab's memory, its listeners and the other tabs. A transaction that fails writes nothing: `failed`.
   */
  #commit(op: CommitOp): Promise<Committed> {
    return this.#enqueue(async (): Promise<Committed> => {
      if (op.rev !== null && op.rev !== this.#rev) return { kind: 'stale' };
      if (op.local && !this.#stores()) {
        // Serialised with the commits: an overlay's renewal never races its Try again (Sol, code review C1-3).
        const next = op.change(this.#held);
        if (next === NOCHANGE || next === null) return { kind: 'stale' };
        const sent = this.#held?.pass ?? '';
        this.#memoryPass = next.pass !== '' && next.pass !== sent ? next.pass : next.pass === '' ? null : this.#memoryPass;
        this.#memory(next);
        return { kind: 'local' };
      }
      const db = this.#db;
      if (!db) return { kind: 'failed', error: new PlusDbUnavailable('error') };
      let out: { ok: boolean; stored: StoredMember; seed: string | null };
      try {
        out = await db.tx('readwrite', async kv => {
          const seed = seedOf(await kv.get(SEED_KEY)), member = storedMember(await kv.get('member'));
          const settle = async (): Promise<void> => { for (const id of op.settle) await kv.delete(`paid:${id}`); };
          if (op.expect) {
            if (seed !== op.expect.seed) return { ok: false, stored: member, seed };
            if (member.gen !== op.expect.gen) {
              if (!op.grant || !member.held || member.held.key !== op.grant.key) return { ok: false, stored: member, seed };
              // Another tab took the same key: this grant counts as taken; the stored membership stays, with this grant's pass if it is later.
              const held = expOf(op.grant.pass) > expOf(member.held.pass) ? withPass(member.held, op.grant) : member.held;
              const stored: StoredMember = { gen: member.gen, held };
              if (held !== member.held) await kv.put('member', stored);
              await settle();
              return { ok: true, stored, seed };
            }
          }
          const next = op.change(member.held);
          if (next === NOCHANGE) return { ok: false, stored: member, seed };
          const stored: StoredMember = { gen: (next?.key ?? null) !== (member.held?.key ?? null) ? member.gen + 1 : member.gen, held: next };
          await kv.put('member', stored);
          await settle();
          return { ok: true, stored, seed };
        }, COMMIT_WAIT_MS);
      } catch (error) { return { kind: 'failed', error }; }
      if (!out.ok) { this.#adopt(out.stored, out.seed); return { kind: 'stale' }; }
      this.#committed(op, out.stored, out.seed);
      return { kind: 'ok', stored: out.stored, seed: out.seed };
    });
  }
  /** After a commit: the mirror (best effort), memory (an operation replaces an overlay), the listeners and the other tabs. */
  #committed(op: CommitOp, stored: StoredMember, seed: string | null): void {
    this.#known = { seed, gen: stored.gen };
    this.#writeMirror(stored);
    this.#ensureMarker();
    const had = this.#overlay !== null;
    if (op.kind === 'operation' && had) { this.#overlay = null; this.#rev++; }
    if (!this.#overlay) {
      const was = this.#held, next = stored.held;
      let held = next && was && next.key === was.key ? { ...next, next: op.resetWait ? next.next : Math.max(next.next, was.next) } : next;
      // A renewal this tab got and could not store that runs out later survives (and is written by one more commit). After Try again the
      // reset wait stands, in memory and in that write: the memory pass keeps no wait of its own (Sol, code review C3-1).
      if (held && was && held.key === was.key && this.#memoryPass !== null && was.pass === this.#memoryPass && expOf(was.pass) > expOf(held.pass)) {
        const from = op.resetWait ? { ...was, next: held.next } : was;
        held = withPass(held, from);
        void this.#adoptPass(from);
      }
      this.#held = held;
      if ((op.kind === 'operation' && had) || !sameHeld(this.#held, was)) this.#changed();
    }
    try { this.#channel?.postMessage({ kind: 'member' }); } catch { /* the mirror's storage event still tells them */ }
  }

  // ---- IDB mode: operations (spec 2.2, 2.4) ----

  /**
   * What an operation that may write the membership captures when it begins: in plain mode the generation (a number, synchronously); in IDB
   * mode the stored baseline read in a transaction (or the overlay's, while one is held) and this tab's revision; null where this tab takes
   * no key (opening, not ready, unusable here) or the transaction failed. The transaction makes the seed when there is none, so every
   * operation has an epoch: a database cleared and made again while it runs has another seed (Sol, code review C1-6).
   */
  capture(): number | Promise<Capture | null> {
    if (this.#mode === 'plain') return this.generation();
    const db = this.#db;
    if (this.#mode !== 'idb' || !db) return Promise.resolve(null);
    const rev = this.#rev, overlay = this.#overlay;
    return db.tx('readwrite', async kv => ({
      base: { seed: await seedIn(kv), gen: storedMember(await kv.get('member')).gen },
      waiting: (await kv.keys()).filter(key => key.startsWith(PAID_PREFIX)).map(key => key.slice(PAID_PREFIX.length)),
    }), COMMIT_WAIT_MS).then(read => ({ base: overlay ? overlay.base : read.base, rev, waiting: read.waiting }), () => null);
  }
  /** A membership this tab could not store is held (spec 2.4): in force here, the revision moved on. */
  #hold(overlay: Overlay): void {
    this.#overlay = overlay; this.#rev++;
    this.#held = overlay.held; this.#unverified = false;
    this.#changed();
  }
  async #take(cap: Capture, grant: GrantIn, settle: readonly string[]): Promise<Taken> {
    const now = this.now();
    const held: Held = { key: grant.key, pass: parsePass(grant.pass) ? grant.pass : '', until: grant.until, ended: false, why: '', renews: grant.renews ?? null, skew: skewOf(grant.now, now), next: 0 };
    const out = await this.#commit({ kind: 'operation', expect: cap.base, rev: cap.rev, change: () => held, settle, grant: held });
    if (out.kind === 'ok') { if (this.#unverified) { this.#unverified = false; this.#changed(); } return 'kept'; }
    if (out.kind === 'stale') return 'stale';
    this.#hold({ held, base: cap.base, settle, quota: isQuota(out.kind === 'failed' ? out.error : null) });
    return 'unkept';
  }
  /** Remove: one commit against the baseline (an overlay's, which it drops; if that fails too, the overlay holds "none"). */
  async #remove(): Promise<Taken> {
    const cap = this.#overlay ? { base: this.#overlay.base, rev: this.#rev, waiting: [] } : await this.capture();
    if (cap === null || typeof cap === 'number') return 'refused';
    const out = await this.#commit({ kind: 'operation', expect: cap.base, rev: cap.rev, change: () => null, settle: [] });
    if (out.kind === 'ok') { if (this.#unverified) { this.#unverified = false; this.#changed(); } return 'kept'; }
    if (out.kind === 'stale') return 'stale';
    this.#hold({ held: null, base: cap.base, settle: [], quota: isQuota(out.kind === 'failed' ? out.error : null) });
    return 'unkept';
  }
  /**
   * Try again for a membership this tab could not store: the overlay committed again against its own baseline, with its settlement, and no
   * request to the server. Stored: the overlay goes. Stale (another tab changed the membership since): the overlay goes and the stored one is
   * in force. Failed again: it stays.
   */
  async keepAgain(): Promise<Taken> {
    const overlay = this.#overlay;
    if (!overlay) return 'stale';
    if (this.#mode !== 'idb') return 'refused';
    // The overlay as it is when the commit runs (its renewal may have replaced its pass meanwhile, through the same queue).
    const out = await this.#commit({ kind: 'operation', expect: overlay.base, rev: this.#rev, change: () => (this.#overlay ?? overlay).held, settle: overlay.settle });
    if (out.kind === 'ok') return 'kept';
    if (out.kind === 'stale') return 'stale';
    if (this.#overlay === overlay) { this.#overlay = { ...overlay, quota: isQuota(out.kind === 'failed' ? out.error : null) }; this.#changed(); }
    return 'unkept';
  }

  // ---- The renewal outside plain mode ----

  /** Whether a renewal's writes go to the database: in IDB mode with no overlay (the overlay's key renews in memory only). */
  #stores(): boolean { return this.#mode === 'idb' && !this.#overlay; }
  /** A renewal's result kept in memory only (the overlay's key, a tab without its database, or a commit that failed). */
  #memory(held: Held): void {
    const was = this.#held;
    if (this.#overlay && this.#overlay.held?.key === held.key) this.#overlay = { ...this.#overlay, held };
    this.#held = held;
    if (!sameHeld(held, was)) this.#changed();
  }
  /**
   * The renewal in IDB mode, not ready, unusable here, or opening after its first wait. In IDB mode the wait is reserved inside a transaction
   * (one renewal a minute across tabs, as the stored wait did before) and the result is one commit that checks the key; elsewhere (and when
   * a commit fails) it is kept in memory only: no baseline, no overlay, no write (spec 2.4).
   *
   * THE EXCEPTION (Sol, code review C1-7): a tab whose reservation write fails (a full storage) still sends, on its own wait in memory, so
   * Plus does not go off because the browser will not write. Such a tab sends at most one renewal a minute by itself, beside the one a minute
   * the storing tabs share; it does not coordinate with them (tests/app-plus-db.test.mts pins the bound).
   */
  async #renewHere(): Promise<void> {
    const held = this.#held, now = this.now();
    if (!held || this.#renewing === held.key || (now < held.next && held.next - now <= LONG_RETRY_MS)) return;
    if (expOf(held.pass) - (now + held.skew) >= RENEW_BEFORE_MS) return;
    const key = held.key, sent = held.pass, stores = this.#stores();
    this.#renewing = key;
    try {
      if (stores) {
        const reserved = await this.#commit({ kind: 'renewal', expect: null, rev: null, settle: [],
          change: cur => cur?.key === key && !(now < cur.next && cur.next - now <= LONG_RETRY_MS) && expOf(cur.pass) - (now + cur.skew) < RENEW_BEFORE_MS ? { ...cur, next: now + RETRY_MS } : NOCHANGE });
        // Another tab renews it or renewed it, or the key changed: nothing is asked here.
        if (reserved.kind === 'stale') return;
        if (reserved.kind === 'failed') this.#memory({ ...held, next: now + RETRY_MS });
      } else this.#memory({ ...held, next: now + RETRY_MS });
      let answer: Awaited<ReturnType<Post>>;
      try { answer = await this.post(`${this.api()}/pass/renew`, { key }); } catch { if (this.#held?.key === key) this.#verified(true); return; }
      const at = this.now();
      // One step of the queue: stored where this tab stores, else applied in memory at the queue's head (an overlay's key: never beside its
      // Try again).
      let unverified = false;
      const out = await this.#commit({ kind: 'renewal', expect: null, rev: null, settle: [], local: true, change: cur => { const r = renewed(cur, key, sent, answer, at); if (!r) return NOCHANGE; unverified = r.unverified; return r.held; } });
      if (out.kind === 'ok' || out.kind === 'local') { this.#verified(unverified); return; }
      if (out.kind === 'stale') return;
      const r = renewed(this.#held, key, sent, answer, at);
      if (r) {
        // A pass the server gave and this tab could not store: kept, and applied to the store when it opens (or the next commit runs).
        this.#memoryPass = r.held.pass !== '' && r.held.pass !== sent ? r.held.pass : r.held.pass === '' ? null : this.#memoryPass;
        this.#memory(r.held); this.#verified(r.unverified);
      }
    } finally { if (this.#renewing === key) this.#renewing = null; }
  }
  /** "Try again" outside plain mode: the stored wait cleared for the key held (never another tab's), then a renewal. */
  async #retryHere(): Promise<void> {
    const held = this.#held;
    if (!held || this.#renewing === held.key) return;
    if (this.#stores()) {
      // The tab's own wait goes too (Sol, code review C1-4): not merged back from memory.
      const out = await this.#commit({ kind: 'renewal', expect: null, rev: null, settle: [], resetWait: true, change: cur => cur?.key === held.key ? { ...cur, next: 0 } : NOCHANGE });
      if (out.kind === 'stale') return;
      if (out.kind === 'failed') this.#memory({ ...held, next: 0 });
    } else this.#memory({ ...held, next: 0 });
    if (this.#unverified) { this.#unverified = false; this.#changed(); }
    this.renew();
  }
  /** A pass the server refused, outside plain mode: dropped (stored when it can be), then a renewal. */
  async #refusedHere(pass?: string | null): Promise<void> {
    const held = this.#held;
    if (!held || held.pass === '' || (pass != null && pass !== held.pass)) return;
    if (this.#stores()) {
      const out = await this.#commit({ kind: 'renewal', expect: null, rev: null, settle: [], change: cur => cur && cur.key === held.key && cur.pass !== '' && (pass == null || pass === cur.pass) ? { ...cur, pass: '' } : NOCHANGE });
      if (out.kind === 'stale') return;
      if (out.kind === 'failed') this.#memory({ ...held, pass: '' });
    } else this.#memory({ ...held, pass: '' });
    this.renew();
  }
}

let channel: (PlusChannel & Pick<BroadcastChannel, 'addEventListener'>) | null | undefined;
/** The channel the page's tabs tell each other on (`BroadcastChannel('lmf.plus')`: a commit, a payment record), or null where there is none. */
export function plusChannel(): (PlusChannel & Pick<BroadcastChannel, 'addEventListener'>) | null {
  if (channel === undefined) { try { channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('lmf.plus') : null; } catch { channel = null; } }
  return channel;
}

let shared: Plus | null = null;
/**
 * The page's one membership: on the Plus database where the browser has IndexedDB (and then heard on the tabs' channel), else plain. Its
 * first use starts listening for other tabs.
 */
export function plus(): Plus {
  if (shared) return shared;
  const db = plusDbIfAny(), told = db ? plusChannel() : null;
  shared = new Plus(kept(), webPost, Date.now, () => plusApi(), { db, channel: told });
  told?.addEventListener('message', () => { shared?.heard(); });
  if (typeof addEventListener === 'function') {
    addEventListener('storage', event => { if (event.key === PLUS_STORE || event.key === null) shared?.mirrorChanged(event.key === PLUS_STORE ? event.newValue : undefined); });
    // A tab shown again after a long while may hold a pass that ran out meanwhile; one left open sees its pass run out without a word.
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { shared?.reload(); shared?.tick(); } });
    if (typeof setInterval === 'function') setInterval(() => { shared?.tick(); }, 60_000);
  }
  return shared;
}
