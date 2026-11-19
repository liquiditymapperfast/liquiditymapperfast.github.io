/**
 * A Plus membership as this browser holds it. There is no account: after the checkout the server gives the browser a **key** (kept here,
 * and shown to its owner so that another device can be given it) and a **pass**, a short-lived signed note the page sends with each request
 * for a Plus file. The key renews the pass while the subscription is paid. Both live in `localStorage` of the page's own origin, which the
 * app and the Plus page (`plus/`) share, so a tab of the app is unlocked the moment the Plus page stores them (a `storage` event).
 *
 * The page cannot check a pass's signature (only the server has the secret) and does not need to: it reads the expiry to know when to ask
 * again, and the server decides. A pass the server refuses is dropped and asked for again.
 */
import { plusApi } from './config.ts';

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
/** A request to the Plus server that has not answered by then is given up (the tab can ask again). */
const POST_TIMEOUT_MS = 20_000;
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

export const webPost: Post = async (url, body, given) => {
  // Given up by the caller (a key form closed) or after POST_TIMEOUT_MS, whichever comes first.
  const timeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(POST_TIMEOUT_MS) : undefined;
  const signal = given && timeout && typeof AbortSignal.any === 'function' ? AbortSignal.any([given, timeout]) : given ?? timeout;
  const answer = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', ...(signal ? { signal } : {}) });
  let parsed: unknown = null;
  try { parsed = await answer.json(); } catch { /* an answer without a JSON body says enough with its status */ }
  const wait = Number(answer.headers.get('retry-after'));
  return { status: answer.status, body: parsed, ...(Number.isFinite(wait) && wait > 0 ? { retryAfter: wait } : {}) };
};

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
  constructor(private storage: Kept | null = kept(), private post: Post = webPost, private now: () => number = Date.now, private api: () => string = () => plusApi()) {
    this.#held = this.#read() ?? null;
    this.#seenGen = this.#readGen();
    this.#wasOn = this.#valid(this.now());
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
  /** The membership's generation now, read again from where it is kept: what a key sent now is checked against when its answer comes (`acceptIf`). */
  generation(): number { return this.#readGen(); }
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
  accept(grant: { key: string; pass: string; until: number; renews?: boolean; now?: number }): boolean {
    const now = this.now();
    this.#held = { key: grant.key, pass: parsePass(grant.pass) ? grant.pass : '', until: grant.until, ended: false, why: '', renews: grant.renews ?? null, skew: skewOf(grant.now, now), next: 0 };
    this.#unverified = false;
    this.#bumpGen();
    const stored = this.#write(true); this.#changed();
    return stored;
  }
  /**
   * A key's grant taken only while the membership is the one the key was sent under (`generation` when it was sent): a key another tab stored
   * meanwhile, or the key here removed, wins, and the grant is dropped (`stale`). Else as `accept`: `kept`, or `unkept` (this tab only).
   */
  acceptIf(generation: number, grant: { key: string; pass: string; until: number; renews?: boolean; now?: number }): 'kept' | 'unkept' | 'stale' {
    this.reload();
    if (this.#readGen() !== generation) return 'stale';
    return this.accept(grant) ? 'kept' : 'unkept';
  }
  /** This browser lets its membership go (the subscription itself is not touched). */
  forget(): void { if (!this.#held) return; this.#held = null; this.#unverified = false; this.#bumpGen(); this.#write(true); this.#changed(); }
  /**
   * The server refused a pass it was sent (`pass`: which one; a late answer about a pass since replaced says nothing about the new one).
   * It is dropped and a new one asked for, within the one-a-minute rule: a server that refuses even the pass it has just given (its two
   * halves disagreeing) is not asked in a circle, by this tab or by two tabs taking turns.
   */
  refused(pass?: string | null): void {
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
    const next = this.#read(), was = this.#held;
    if (next === undefined) return;
    this.#seenGen = this.#readGen();
    if (next && was && next.key === was.key) next.next = Math.max(next.next, was.next);
    this.#held = next;
    if (next?.key === was?.key && next?.pass === was?.pass && next?.until === was?.until && next?.ended === was?.ended && next?.renews === was?.renews && next?.why === was?.why) return;
    this.#changed();
  }
  /** A pass that ran out says nothing when it does: called now and then, this tells the listeners when Plus went off (or on) unannounced. */
  tick(): void { if (this.on !== this.#wasOn) this.#changed(); }
  /** Ask the server for a fresh pass with the key, unless one is being asked for or the last was asked too recently. */
  renew(): void {
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
  /** Told whenever the membership here changes (a pass came, went, or was replaced). */
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
}

let shared: Plus | null = null;
/** The page's one membership; its first use starts listening for other tabs. */
export function plus(): Plus {
  if (shared) return shared;
  shared = new Plus();
  if (typeof addEventListener === 'function') {
    addEventListener('storage', event => { if (event.key === PLUS_STORE || event.key === null) shared?.reload(); });
    // A tab shown again after a long while may hold a pass that ran out meanwhile; one left open sees its pass run out without a word.
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { shared?.reload(); shared?.tick(); } });
    if (typeof setInterval === 'function') setInterval(() => { shared?.tick(); }, 60_000);
  }
  return shared;
}
