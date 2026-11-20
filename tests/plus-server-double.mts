/**
 * A stand-in for the Plus Worker (HyperLiquidMap_Plus `src/api.js` `pass`, `renew`, `restore`, `admit`, `mint`; `src/store.js` `mintWait`,
 * `addKey`), for the checkout recovery's tests. Its rules are the Worker's, ported from its code:
 * - one key slot per transaction: a `/v1/pass` miss replaces the key made for that transaction before; a `/v1/restore` miss adds a key;
 * - with `secret`, the key is the one the secret names for the subscription (`<sub>.<base64url(HMAC-SHA256(secret, sub))>`), the same on
 *   every ask: when it is listed already (a hit), the answer is that key with a fresh pass and nothing is written, never capped and never
 *   counted; a grant made from a secret carries `idem: true`;
 * - at most 5 keys per subscription (the oldest pushed out) and at most 5 made within 24 h (`429 too_many_keys`, `Retry-After` the seconds
 *   until the oldest of the five is a day old), decided from one read of the list, before anything is written;
 * - `503 busy` (`Retry-After: 2`) while another request of the same isolate makes a key for the same subscription (hits included);
 * - `409 pending` (`Retry-After: 3`) while a transaction is unfinished, and `/v1/restore` `403 not_found` then (every restore refusal looks
 *   the same);
 * - renew answers `200`, or `403 not_active` with `replaced` (the subscription has a list without the key) or `unknown` (no list).
 *
 * What a test can make happen to the next requests (`plan`, one plan per request, in order): run them in another isolate, answer at once with
 * a canned answer, hold them before they are processed, between the read of the key list and its write (still processing when a later
 * request arrives), or after they were processed, and lose the answer after the server processed the request. `lostUpdate` makes the next
 * two misses read the same list before either writes, in two isolates (KV has no compare-and-swap): the later write drops the other's key.
 * The double keeps the key texts (the Worker keeps their hashes) so tests can name them.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { Post } from '../src/app/plus/pass.ts';

export const DOUBLE_API = 'https://plus.test/v1';
export const DAY_MS = 86_400_000;
export const MAX_KEYS = 5;
const TXN_ID = /^txn_[a-z\d]{26}$/;
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const KEY_SHAPE = /^(sub_[a-z\d]{26}|gift_[0-9a-f]{32})\.[A-Za-z0-9_-]{43}$/;

/** An answer of the server: its status, its JSON body and its `Retry-After` (seconds), as `webPost` reads them. */
export interface Answer { status: number; body: unknown; retryAfter?: number }
export interface Subscription { id: string; status: string; paidUntil: number; renews: boolean }
/** A Paddle transaction: finished (`completed`), not finished (`pending`), or one the Worker refuses. */
export interface Transaction { id: string; sub: string; state: 'completed' | 'pending' | 'not_paid' | 'wrong_price' | 'no_subscription'; invoice: string; email: string }
export interface KeyEntry { key: string; at: number; src: string | null }
export interface KeyList { keys: KeyEntry[]; mints: number[] }
/** A wait: a promise the test resolves, or milliseconds (`setTimeout`). */
export type Wait = Promise<void> | number;
/** What the next request meets. */
export interface Plan {
  /** The isolate it runs in (default `main`): `busy` is per isolate, and requests in two isolates do not see each other. */
  isolate?: string;
  /** Answered at once with this, nothing processed (a `429 rate_limited`, a `503 upstream`, ...). */
  reply?: Answer;
  /** Held on the way, before it is processed. */
  before?: Wait;
  /** Held after it read the key list and before it writes (the Paddle calls between them): still processing when a later request arrives. */
  read?: Wait;
  /** Held after it was processed, before its answer arrives. */
  answer?: Wait;
  /** Processed, but its answer never arrives: the page sees a network error. */
  lose?: boolean;
}
/** One request as the server saw it. `outcome`: a key made (`mint`), a listed key answered again (`hit`), a pass renewed (`renew`). */
export interface Seen { path: string; isolate: string; status: number; error: string; outcome: 'mint' | 'hit' | 'renew' | null; key: string | null; secret: boolean }

const b64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');
const errorAnswer = (status: number, error: string, extra: Record<string, unknown> = {}, retryAfter?: number): Answer => ({ status, body: { error, ...extra }, ...(retryAfter ? { retryAfter } : {}) });
const pause = (wait: Wait | undefined): Promise<void> | null => wait === undefined ? null : typeof wait === 'number' ? new Promise(resolve => { setTimeout(resolve, wait); }) : wait;
const object = (body: unknown): Record<string, unknown> => body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};

/** The key a browser's secret names for a subscription (the Worker's `derivedKey`). */
export const derivedKey = (sub: string, secret: string): string => `${sub}.${b64url(createHmac('sha256', secret).update(sub).digest())}`;
/** Ids of the shapes the Worker accepts: `sub_` / `txn_` and 26 of a-z 0-9. */
export const subId = (tag: string): string => `sub_${tag.toLowerCase().replace(/[^a-z\d]/g, '').padEnd(26, '0').slice(0, 26)}`;
export const txnId = (tag: string): string => `txn_${tag.toLowerCase().replace(/[^a-z\d]/g, '').padEnd(26, '0').slice(0, 26)}`;
/** A secret of the shape the Worker accepts (43 characters of base64url). */
export const secretOf = (tag: string): string => b64url(createHmac('sha256', 'secret').update(tag).digest());

/** A race of two misses that both read the list before either writes; their writes then land in `order`. */
class Race {
  readonly #turns: (() => void)[] = [];
  readonly #gates: Promise<void>[] = [];
  #arrived = 0;
  constructor(readonly order: 'arrival' | 'reverse') {
    for (let i = 0; i < 2; i++) this.#gates.push(new Promise(resolve => { this.#turns.push(resolve); }));
  }
  get full(): boolean { return this.#arrived >= 2; }
  /** A miss read the list: its turn to write (0 or 1) and the wait for it. */
  join(): { turn: number; go: Promise<void> } {
    const at = this.#arrived++;
    const turn = this.order === 'arrival' ? at : 1 - at;
    if (this.#arrived === 2) this.#turns[0]!();
    return { turn, go: this.#gates[turn]! };
  }
  /** The one whose turn it was wrote (or left without writing): the next may. */
  done(turn: number): void { if (turn === 0) this.#turns[1]!(); }
}

export class PlusServer {
  readonly subs = new Map<string, Subscription>();
  readonly txns = new Map<string, Transaction>();
  readonly lists = new Map<string, KeyList>();
  readonly log: Seen[] = [];
  #plans: Plan[] = [];
  #minting = new Map<string, Set<string>>();
  #race: Race | null = null;
  #raceIsolates = 0;
  #signed = 0;
  constructor(public now: () => number = Date.now) {}

  /** A subscription in good standing unless said otherwise. */
  subscription(id: string, opts: Partial<Omit<Subscription, 'id'>> = {}): Subscription {
    const sub: Subscription = { id, status: 'active', paidUntil: this.now() + 30 * DAY_MS, renews: true, ...opts };
    this.subs.set(id, sub);
    return sub;
  }
  /** A transaction of `sub`, completed unless said otherwise. */
  transaction(id: string, sub: string, opts: Partial<Omit<Transaction, 'id' | 'sub'>> = {}): Transaction {
    const txn: Transaction = { id, sub, state: 'completed', invoice: `325-${this.txns.size + 10000}`, email: 'buyer@example.com', ...opts };
    this.txns.set(id, txn);
    return txn;
  }
  /** Paddle finished the transaction (its subscription exists now). */
  finish(id: string): void { const txn = this.txns.get(id); if (txn) txn.state = 'completed'; }
  /** What the next requests meet, one plan each, in order. */
  plan(...plans: Plan[]): void { this.#plans.push(...plans); }
  /** The next two misses read the same key list before either writes, each in an isolate of its own; their writes land in `order`. */
  lostUpdate(order: 'arrival' | 'reverse' = 'arrival'): void { this.#race = new Race(order); }

  /** The keys listed for `sub` now, oldest first. */
  keys(sub: string): string[] { return (this.lists.get(sub)?.keys ?? []).map(entry => entry.key); }
  /** The times of the keys made for `sub` that still count (at most 5). */
  mints(sub: string): number[] { return [...(this.lists.get(sub)?.mints ?? [])]; }
  /** How many requests reached `path` (`/v1/pass`, `/v1/pass/renew`, `/v1/restore`), whatever they met. */
  asked(path: string): number { return this.log.filter(seen => seen.path === path).length; }

  /** The server as the page's `Post` sees it: a lost answer, or one given up by `signal`, rejects (the request may still be processed). */
  readonly post: Post = (url, body, signal) => {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    const plan = this.#plans.shift() ?? {};
    const work = this.#handle(new URL(url).pathname, structuredClone(body), plan);
    const delivered = work.then(async answer => {
      await pause(plan.answer);
      if (plan.lose) throw new TypeError('Failed to fetch');
      return answer;
    });
    if (!signal) return delivered;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { reject(signal.reason ?? new DOMException('aborted', 'AbortError')); };
      signal.addEventListener('abort', onAbort, { once: true });
      delivered.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort); });
    });
  };
  /** The server as page-flow's `Ask` sees it (a path under the address): null when the answer did not arrive. */
  readonly ask = async (path: string, body: unknown): Promise<Answer | null> => {
    try { return await this.post(`${DOUBLE_API}${path}`, body); } catch { return null; }
  };

  async #handle(path: string, body: unknown, plan: Plan): Promise<Answer> {
    await pause(plan.before);
    const isolate = plan.isolate ?? 'main';
    const seen: Seen = { path, isolate, status: 0, error: '', outcome: null, key: null, secret: Object.hasOwn(object(body), 'secret') };
    let answer: Answer;
    if (plan.reply) answer = plan.reply;
    else if (path === '/v1/pass') answer = await this.#pass(object(body), isolate, plan, seen);
    else if (path === '/v1/pass/renew') answer = this.#renew(object(body), seen);
    else if (path === '/v1/restore') answer = await this.#restore(object(body), isolate, plan, seen);
    else answer = errorAnswer(404, 'not_found');
    seen.status = answer.status;
    seen.error = typeof (answer.body as { error?: unknown } | null)?.error === 'string' ? (answer.body as { error: string }).error : '';
    this.log.push(seen);
    return answer;
  }

  async #pass(body: Record<string, unknown>, isolate: string, plan: Plan, seen: Seen): Promise<Answer> {
    const id = body.transactionId;
    if (typeof id !== 'string' || !TXN_ID.test(id)) return errorAnswer(400, 'bad_request');
    const secret = readSecret(body);
    if (secret === false) return errorAnswer(400, 'bad_request');
    const txn = this.txns.get(id);
    if (!txn) return errorAnswer(404, 'not_found');
    if (txn.state === 'pending') return errorAnswer(409, 'pending', { status: 'paid' }, 3);
    if (txn.state === 'not_paid') return errorAnswer(403, 'not_paid', { status: 'draft' });
    if (txn.state !== 'completed') return errorAnswer(403, txn.state);
    const out = await this.#admit(txn.sub, id, secret, isolate, plan, seen);
    return 'answer' in out ? out.answer : errorAnswer(403, 'not_active', { status: out.refused });
  }

  async #restore(body: Record<string, unknown>, isolate: string, plan: Plan, seen: Seen): Promise<Answer> {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const invoice = typeof body.invoice === 'string' ? body.invoice.trim().replace(/^#\s*/, '') : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(invoice)) return errorAnswer(400, 'bad_request');
    const secret = readSecret(body);
    if (secret === false) return errorAnswer(400, 'bad_request');
    const rows = [...this.txns.values()].filter(txn => txn.invoice === invoice);
    const txn = rows.length === 1 ? rows[0]! : null;
    // Every refusal looks the same: no such invoice, another email, a payment not finished, a subscription not in good standing.
    if (!txn || txn.state !== 'completed' || txn.email.trim().toLowerCase() !== email) return errorAnswer(403, 'not_found');
    const out = await this.#admit(txn.sub, null, secret, isolate, plan, seen);
    return 'answer' in out ? out.answer : errorAnswer(403, 'not_found');
  }

  /** The Worker's `admit` and `mint`: alone per isolate and subscription, one read of the list, a hit or a miss, then the write. */
  async #admit(sub: string, source: string | null, secret: string | undefined, isolate: string, plan: Plan, seen: Seen): Promise<{ answer: Answer } | { refused: string }> {
    const racing = this.#race && !this.#race.full ? this.#race : null;
    const where = racing ? `race-${++this.#raceIsolates}` : isolate;
    let minting = this.#minting.get(where);
    if (!minting) { minting = new Set(); this.#minting.set(where, minting); }
    if (minting.has(sub)) return { answer: errorAnswer(503, 'busy', {}, 2) };
    minting.add(sub);
    let turn: { turn: number; go: Promise<void> } | null = null;
    try {
      const read = this.lists.get(sub);
      const record: KeyList = { keys: (read?.keys ?? []).map(entry => ({ ...entry })), mints: [...(read?.mints ?? [])] };
      const named = secret === undefined ? null : derivedKey(sub, secret);
      const hit = named !== null && record.keys.some(entry => entry.key === named);
      if (!hit) {
        const wait = mintWait(record, this.now());
        if (wait > 0) return { answer: errorAnswer(429, 'too_many_keys', {}, wait) };
      }
      await pause(plan.read);
      if (!hit && racing) { turn = racing.join(); await turn.go; }
      const subscription = this.subs.get(sub);
      const now = this.now();
      if (!subscription || !standing(subscription, now)) return { refused: subscription?.status ?? 'unknown' };
      const key = named ?? `${sub}.${b64url(randomBytes(32))}`;
      if (!hit) this.lists.set(sub, addKey(record, key, source, now));
      seen.outcome = hit ? 'hit' : 'mint';
      seen.key = key;
      return { answer: { status: 200, body: { ...this.#grant(subscription, now), key, ...(named === null ? {} : { idem: true }) } } };
    } finally {
      minting.delete(sub);
      if (turn && racing) racing.done(turn.turn);
      if (racing?.full && this.#race === racing) this.#race = null;
    }
  }

  #renew(body: Record<string, unknown>, seen: Seen): Answer {
    const key = body.key;
    const match = typeof key === 'string' ? KEY_SHAPE.exec(key) : null;
    if (!match) return errorAnswer(400, 'bad_request');
    const sub = match[1]!, record = this.lists.get(sub);
    if (!record || !record.keys.some(entry => entry.key === key)) {
      const known = !!record && (record.keys.length > 0 || record.mints.length > 0);
      return errorAnswer(403, 'not_active', { status: known ? 'replaced' : 'unknown' });
    }
    const subscription = this.subs.get(sub), now = this.now();
    if (!subscription || !standing(subscription, now)) return errorAnswer(403, 'not_active', { status: subscription?.status ?? 'unknown' });
    seen.outcome = 'renew';
    seen.key = key as string;
    return { status: 200, body: this.#grant(subscription, now) };
  }

  /** A grant: a pass signed now (`v1.<payload>.<signature>`, expiring at the earlier of a day from now and the paid period plus 3 days). */
  #grant(sub: Subscription, now: number): Record<string, unknown> {
    const until = Math.min(now + DAY_MS, sub.paidUntil + 3 * DAY_MS);
    const payload = b64url(JSON.stringify({ sub: sub.id, exp: until, env: 'sandbox' }));
    const pass = `v1.${payload}.${b64url(createHmac('sha256', 'pass-key').update(`v1.${payload}.${++this.#signed}`).digest())}`;
    return { pass, until, paidUntil: sub.paidUntil, status: sub.status, now, renews: sub.status === 'active' && sub.renews };
  }
}

/** The request's secret: absent (undefined), well-formed, or false (a bad request). */
function readSecret(body: Record<string, unknown>): string | undefined | false {
  if (!Object.hasOwn(body, 'secret')) return undefined;
  return typeof body.secret === 'string' && SECRET_SHAPE.test(body.secret) ? body.secret : false;
}
function standing(sub: Subscription, now: number): boolean {
  return (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due') && now < sub.paidUntil + 3 * DAY_MS;
}
/** The Worker's `mintWait`: 0 when a key may be made now, else the seconds until the oldest of the newest five is a day old. */
export function mintWait(record: KeyList, now: number): number {
  const recent = record.mints.filter(at => now - at < DAY_MS);
  if (recent.length < MAX_KEYS) return 0;
  const deciding = recent.sort((a, b) => a - b).slice(-MAX_KEYS)[0]!;
  return Math.min(DAY_MS / 1000, Math.max(1, Math.ceil((deciding + DAY_MS - now) / 1000)));
}
/** The Worker's `addKey`, written from the list as it was read: a transaction's slot replaced, a restore added, the oldest past five dropped. */
export function addKey(record: KeyList, key: string, source: string | null, now: number): KeyList {
  const kept = record.keys.filter(entry => source === null || entry.src !== source);
  kept.push({ key, at: now, src: source });
  while (kept.length > MAX_KEYS) kept.shift();
  const mints = [...record.mints.filter(at => now - at < DAY_MS), now].sort((a, b) => a - b).slice(-MAX_KEYS);
  return { keys: kept, mints };
}
