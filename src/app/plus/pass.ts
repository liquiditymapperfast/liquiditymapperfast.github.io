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

/** Where the membership is kept (`{ v, key, pass, until }`). */
export const PLUS_STORE = 'lmf.plus';
/** A pass with less than this left is renewed. */
const RENEW_BEFORE_MS = 6 * 3_600_000;
/** A pass counts while it has at least this long to run, so a request sent now is not refused on arrival. */
const MARGIN_MS = 30_000;
/** A renewal that failed (the network, the server) is tried again this soon; one the server refused, this much later. */
const RETRY_MS = 60_000, REFUSED_RETRY_MS = 3_600_000;

export interface Held {
  /** The key that renews the pass: the membership itself, as far as this browser goes. */
  key: string;
  /** The pass in force, or '' when the last renewal was refused (the subscription ended) or none has come yet. */
  pass: string;
  /** When the paid period ends, as the server last said. */
  until: number;
}

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

/** What is kept, checked; anything malformed reads as no membership. */
export function readHeld(raw: string | null): Held | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { v?: unknown; key?: unknown; pass?: unknown; until?: unknown };
    if (o.v !== 1 || typeof o.key !== 'string' || o.key.length < 16 || o.key.length > 200) return null;
    return { key: o.key, pass: typeof o.pass === 'string' && parsePass(o.pass) ? o.pass : '', until: typeof o.until === 'number' && Number.isFinite(o.until) ? o.until : 0 };
  } catch { return null; }
}

/**
 * The server's answer to a checkout, a restore or a renewal, checked. `until` is when the paid period ends (the server's `paidUntil`;
 * its own `until` is the pass's expiry, which the pass says itself).
 */
export function readGrant(raw: unknown): { pass: string; until: number; key?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { pass?: unknown; until?: unknown; paidUntil?: unknown; key?: unknown };
  const until = typeof o.paidUntil === 'number' ? o.paidUntil : o.until;
  if (typeof o.pass !== 'string' || !parsePass(o.pass) || typeof until !== 'number' || !Number.isFinite(until)) return null;
  return { pass: o.pass, until, ...(typeof o.key === 'string' && o.key.length >= 16 && o.key.length <= 200 ? { key: o.key } : {}) };
}

export type Post = (url: string, body: unknown) => Promise<{ status: number; body: unknown }>;
type Kept = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const webPost: Post = async (url, body) => {
  const answer = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  let parsed: unknown = null;
  try { parsed = await answer.json(); } catch { /* an answer without a body says enough with its status */ }
  return { status: answer.status, body: parsed };
};

/** `localStorage`, or nothing where the browser refuses it (a private window of some browsers): the page then simply has no membership. */
function kept(): Kept | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export class Plus {
  #held: Held | null;
  #listeners = new Set<() => void>();
  #renewing = false;
  #retryAt = 0;
  /** When a refused pass last led to a renewal (`refused`). */
  #refusedAt = -Infinity;
  constructor(private storage: Kept | null = kept(), private post: Post = webPost, private now: () => number = Date.now, private api: () => string = () => plusApi()) {
    this.#held = this.#read();
  }
  #read(): Held | null { try { return readHeld(this.storage?.getItem(PLUS_STORE) ?? null); } catch { return null; } }
  #write(): void {
    try {
      if (this.#held) this.storage?.setItem(PLUS_STORE, JSON.stringify({ v: 1, ...this.#held }));
      else this.storage?.removeItem(PLUS_STORE);
    } catch { /* a browser that will not keep it: the membership lasts as long as this tab */ }
  }
  #changed(): void { for (const listener of [...this.#listeners]) listener(); }

  /** The pass to send with a request for a Plus file, or null: no membership here, or its pass has run out. Asking keeps it fresh. */
  pass(now: number = this.now()): string | null {
    const held = this.#held;
    if (!held) return null;
    const exp = parsePass(held.pass)?.exp ?? 0;
    if (exp - now < RENEW_BEFORE_MS) this.renew();
    return exp - now > MARGIN_MS ? held.pass : null;
  }
  /** Whether Plus is in force in this browser now. */
  get on(): boolean { return this.pass() !== null; }
  /** Whether a membership was ever set up in this browser (in force or ended). */
  get known(): boolean { return this.#held !== null; }
  /** When the paid period ends, as last heard, or null. */
  get until(): number | null { return this.#held && this.#held.until > 0 ? this.#held.until : null; }
  /** The key, for its owner to copy to another device. */
  get key(): string | null { return this.#held?.key ?? null; }

  /** A checkout or a restore gave this browser a membership. */
  accept(grant: { key: string; pass: string; until: number }): void {
    this.#held = { key: grant.key, pass: parsePass(grant.pass) ? grant.pass : '', until: grant.until };
    this.#retryAt = 0;
    this.#write(); this.#changed();
  }
  /** This browser lets its membership go (the subscription itself is not touched). */
  forget(): void { if (!this.#held) return; this.#held = null; this.#write(); this.#changed(); }
  /**
   * The server refused the pass it was sent: it is dropped, and a new one asked for, at most once a minute. A server that refuses even
   * the pass it has just given (its two halves disagreeing) must not be asked in a circle: renew, be refused, renew.
   */
  refused(): void {
    const held = this.#held;
    if (!held || held.pass === '') return;
    this.#held = { ...held, pass: '' };
    this.#write(); this.#changed();
    const now = this.now();
    if (now - this.#refusedAt >= RETRY_MS) { this.#refusedAt = now; this.renew(); }
    else this.#retryAt = Math.max(this.#retryAt, this.#refusedAt + RETRY_MS);
  }
  /** What is kept changed elsewhere (another tab, the Plus page after a checkout). */
  reload(): void {
    const next = this.#read(), was = this.#held;
    if (next?.key === was?.key && next?.pass === was?.pass && next?.until === was?.until) return;
    this.#held = next; this.#retryAt = 0;
    this.#changed();
  }
  /** Ask the server for a fresh pass with the key, unless one is being asked for or the last try was too recent. */
  renew(): void {
    const held = this.#held, now = this.now();
    if (!held || this.#renewing || now < this.#retryAt) return;
    this.#renewing = true;
    const key = held.key;
    void this.post(`${this.api()}/pass/renew`, { key }).then(answer => {
      if (this.#held?.key !== key) return;
      const grant = answer.status === 200 ? readGrant(answer.body) : null;
      if (grant) { this.#held = { key, pass: grant.pass, until: grant.until }; this.#retryAt = 0; this.#write(); this.#changed(); return; }
      // Refused: the subscription is not in good standing. The key stays (a subscription paid again renews with it); the pass goes.
      if (answer.status === 403) {
        this.#retryAt = this.now() + REFUSED_RETRY_MS;
        const had = this.#held.pass !== '';
        this.#held = { key, pass: '', until: this.#held.until };
        this.#write(); if (had) this.#changed();
        return;
      }
      this.#retryAt = this.now() + RETRY_MS;
    }, () => { this.#retryAt = this.now() + RETRY_MS; }).finally(() => { this.#renewing = false; });
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
    // A tab shown again after a long while may hold a pass that ran out meanwhile.
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') shared?.pass(); });
  }
  return shared;
}
