/**
 * What the Plus page (`plus/page.ts`) asks its server for besides a key, which goes through the app's own key form (`key.ts`): the key for a
 * checkout just paid, and a membership found by the receipt's email and invoice number (the checkout recovery, page build spec sections 4-6,
 * 2026-11-20). Both are issued for this browser, named by its seed: every request from this browser for one subscription names the same key,
 * so repeats, two tabs, lost answers and late requests all end with that key. Their requests are built only by the gate in `plus-db.ts`,
 * from the seed read in a transaction; a tab that may not issue (plain mode, not ready, unusable here, a seed that cannot be read) sends
 * nothing. Their grants are taken like a key: one commit against the baseline the operation began with (`Plus.acceptIf`), so an answer that
 * comes after another tab stored a key, after the key here was removed, or after the browser's data was cleared, changes nothing. No styles
 * and no page: the tests drive it with a stand-in for the Worker, two tabs over one in-memory database, and virtual clocks.
 */
import { t } from '../i18n.ts';
import { PLUS_CONTACT, PLUS_KEYS } from './config.ts';
import { activateKey, type ActivateDeps, type KeyOutcome } from './key.ts';
import type { Paid, PaidStore } from './paid.ts';
import { errorOf, readGrant, type Capture, type Grant, type Plus, type Taken } from './pass.ts';
import { passRequest, restoreRequest, type PlusDb } from './plus-db.ts';
import type { TabWaits, WaitWhy } from './schedule.ts';
import type { PlusMode } from './pass.ts';

/** An answer of the Plus server: its status, its body, and the wait it asked for (`Retry-After`, in seconds). */
export type Answer = { status: number; body: unknown; retryAfter?: number };
/** A request to the Plus server (a path under its address), or null when no answer came. */
export type Ask = (path: string, body: unknown) => Promise<Answer | null>;

/** The server's own refusals (it looked, and found nothing it could open); any other refusal is not the server's word on the membership. */
export const LOOKED: ReadonlySet<string> = new Set(['not_active', 'not_found', 'wrong_price']);
/** What a tab that may not issue says where the buying controls, a payment's button or the receipt would be (spec 8, string 4). */
export const cannotHere = (): string => t('Plus cannot be set up in this tab. Reload the page, or use another tab.');
/** What plain mode says in the place of the prices (spec 8, string 5). */
export const cannotBuy = (): string => t('Plus cannot be bought in this browser. Use another browser; a key bought elsewhere works here.');
/** The receipt's refusal: hedged, since a payment of the last few minutes may not have its invoice yet (spec 6, string 2). */
export const notFoundText = (): string => t('No subscription in good standing was found for that email and invoice number. A payment from the last few minutes may not show yet.');
/** The attempt ran out without Plus: the receipt brings it back (design 6.4, `late`). */
export const lateText = (): string => t('The payment went through, but Plus could not be set up here yet. Use the email and the invoice number from your receipt below in a few minutes; nothing is lost.');
/** A wait the server named: when to try again. */
export const waitText = (ms: number): string => t('Too many tries. Try again in {n} min.', { n: Math.max(1, Math.ceil(ms / 60_000)) });
/** Too many keys in a day, with the wait the server gave when it gave one (Sol, code review C2-10). */
export function capText(ms?: number): string {
  if (!ms || ms <= 0) return t('This subscription was given {n} keys within a day. Use one of them, or try again tomorrow.', { n: PLUS_KEYS });
  return ms >= 2 * 3_600_000 ? t('This subscription was given {n} keys within a day. Use one of them, or try again in {h} h.', { n: PLUS_KEYS, h: Math.ceil(ms / 3_600_000) })
    : t('This subscription was given {n} keys within a day. Use one of them, or try again in {m} min.', { n: PLUS_KEYS, m: Math.max(1, Math.ceil(ms / 60_000)) });
}
/** What a wait of `ms` says, by why it was named: too many tries, too many keys, or (the server busy or down) that it could not be reached. */
const waitSaid = (ms: number, why: WaitWhy): string => why === 'limited' ? waitText(ms) : why === 'keys' ? capText(ms) : t('The server could not be reached. Try again in a moment.');

/**
 * What an answer that gave no membership means, in the visitor's words: the server not reached or in trouble, too many tries (with the
 * wait it asked for), too many keys in a day; `refusal` is said for the rest (the server looked and found nothing it could open).
 */
export function problem(answer: Answer | null, refusal: string): string {
  if (!answer || answer.status >= 500) return t('The server could not be reached. Try again in a moment.');
  if (answer.status === 429 && errorOf(answer.body) === 'too_many_keys') return capText(answer.retryAfter ? answer.retryAfter * 1_000 : undefined);
  if (answer.status === 429) return answer.retryAfter ? t('Too many tries. Try again in {n} min.', { n: Math.max(1, Math.ceil(answer.retryAfter / 60)) }) : t('Too many tries. Try again later.');
  // A refusal that is not the server's own (a firewall's or a challenge page, a 400 or 404): it says nothing about the key or the payment.
  return LOOKED.has(errorOf(answer.body)) ? refusal : t('The server turned the request down. Try again later, or without a VPN or blocker.');
}

/**
 * A membership the server issued: taken (`kept`: false when this tab holds it only, the overlay of `pass.ts`), or dropped because the
 * membership changed since it was asked for.
 */
export type Issued = { kind: 'ok'; grant: Grant & { key: string }; kept: boolean } | { kind: 'stale' };
const issued = (grant: Grant | null): (Grant & { key: string }) | null => grant?.key ? { ...grant, key: grant.key } : null;
/**
 * The grant taken against `cap`, the baseline the operation began with (never the request's seed: a request whose seed is not the capture's
 * is not sent at all; Sol, code review C1-6).
 */
async function takeIssued(member: Pick<Plus, 'acceptIf'>, cap: Capture, grant: Grant & { key: string }, settle: readonly string[]): Promise<Issued | { kind: 'refused'; text: string }> {
  const taken = await member.acceptIf(cap, { key: grant.key, pass: grant.pass, until: grant.until, ...(grant.renews !== undefined ? { renews: grant.renews } : {}), ...(grant.now !== undefined ? { now: grant.now } : {}) }, settle);
  if (taken === 'refused') return { kind: 'refused', text: cannotHere() };
  return taken === 'stale' ? { kind: 'stale' } : { kind: 'ok', grant, kept: taken === 'kept' };
}
/** The baseline an operation begins with, or null where this tab may not issue (spec 4). */
async function begin(member: Pick<Plus, 'capture' | 'issues'>): Promise<Capture | null> {
  if (!member.issues) return null;
  const cap = await member.capture();
  return cap === null || typeof cap === 'number' ? null : cap;
}

/** What setting up a paid checkout came to (design 6.4 as the spec keeps it). */
export type PassOutcome = Issued
  /** The server will not set Plus up for it (with the words to say); the record stays. */
  | { kind: 'no'; text: string }
  /** The attempt ran out (`text`: the receipt, or the wait after a 429); the record stays. */
  | { kind: 'late'; text: string }
  /** The record is gone (settled elsewhere, given up after its window, or of a database since reset). */
  | { kind: 'gone' }
  /** This tab may not issue: nothing was sent. */
  | { kind: 'refused'; text: string };

/** What an attempt is given: the database, the membership, the payments, the server, the tab's waits, and how to sleep. */
export interface AttemptDeps {
  db: PlusDb | null;
  member: Pick<Plus, 'capture' | 'acceptIf' | 'issues'>;
  paid: Pick<PaidStore, 'memory' | 'settled' | 'localIds'>;
  ask: Ask;
  waits: TabWaits;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
/**
 * The checkout `txn` is paid (its checkout completed, or its "Set up Plus" / "Try again" was pressed): the server is asked for its key on the
 * schedule (`schedule.ts`) until a grant, an answer that will not change, or the attempt's end. Before every ask, the first included, one
 * transaction reads the seed and confirms the record still waits (the gate, `passRequest`). The grant is committed against the generation
 * when the attempt began and the seed it was sent with, and settles this payment in the same transaction.
 */
export async function setUpPayment(txn: string, deps: AttemptDeps): Promise<PassOutcome> {
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const cap = deps.db ? await begin(deps.member) : null;
  if (!cap || !deps.db) return { kind: 'refused', text: cannotHere() };
  const attempt = deps.waits.attempt(), waits = deps.waits;
  let last: Answer | null = null;
  // The words when the attempt ends: a cooldown says its wait by why it was named (a 503's is the receipt text, not "too many tries"; Sol,
  // code review C2-9); else after a 429 its wait, else the receipt text.
  const ended = (step: Extract<ReturnType<typeof attempt.next>, { kind: 'end' }>): PassOutcome => {
    if (step.cooldownMs > 0) return { kind: 'late', text: waits.cooldownWhy === 'limited' ? waitText(step.cooldownMs) : waits.cooldownWhy === 'keys' ? capText(step.cooldownMs) : lateText() };
    return { kind: 'late', text: last?.status === 429 && errorOf(last.body) !== 'too_many_keys' && last.retryAfter ? waitText(last.retryAfter * 1_000) : lateText() };
  };
  for (;;) {
    const step = attempt.next();
    if (step.kind === 'end') return ended(step);
    if (step.kind === 'wait') { await sleep(step.ms); continue; }
    const request = await passRequest(deps.db, txn, now(), deps.paid.memory(txn));
    if (request === null) return { kind: 'refused', text: cannotHere() };
    if (request === 'gone') { deps.paid.settled([txn]); return { kind: 'gone' }; }
    // Another seed than the capture's: the database was reset since the attempt began; nothing is sent (Sol, code review C1-6).
    if (request.seed !== cap.base.seed) return { kind: 'stale' };
    // The gate took its time: the schedule is asked again right before the send (deadline, wall clock; Sol, code review C2-3).
    const now2 = attempt.next();
    if (now2.kind === 'end') return ended(now2);
    if (now2.kind === 'wait') { await sleep(now2.ms); continue; }
    attempt.sent();
    const answer = await deps.ask(request.path, request.body);
    if (!answer) { attempt.lost(); continue; }
    attempt.answered(answer.retryAfter, answer.status === 429 ? 'limited' : 'other');
    last = answer;
    const grant = issued(answer.status === 200 ? readGrant(answer.body) : null);
    if (grant) {
      const out = await takeIssued(deps.member, cap, grant, [txn]);
      if (out.kind === 'ok' && out.kept) deps.paid.settled([txn]);
      return out;
    }
    const error = errorOf(answer.body);
    // Not there yet, the server busy, slowed or down: asked again on the schedule.
    if (answer.status === 409 || answer.status >= 500 || (answer.status === 429 && error !== 'too_many_keys')) continue;
    if (answer.status === 429) {
      // Too many keys in a day: its wait becomes this tab's cooldown, and is said.
      if (answer.retryAfter) deps.waits.coolFor(answer.retryAfter, 'keys');
      return { kind: 'no', text: capText(answer.retryAfter ? answer.retryAfter * 1_000 : undefined) };
    }
    if ((answer.status === 403 && (LOOKED.has(error) || error === 'not_paid' || error === 'no_subscription')) || (answer.status === 404 && error === 'not_found')) {
      return { kind: 'no', text: t('The payment went through, but the server would not set up Plus for it. Write to {email} with your receipt; nothing is lost.', { email: PLUS_CONTACT }) };
    }
    return { kind: 'no', text: t('The server turned the request down. Try again later, or without a VPN or blocker.') };
  }
}

/** What looking a membership up by its receipt came to: Plus on, dropped (the membership changed meanwhile), or why not. */
export type RestoreOutcome = Issued | { kind: 'no'; text: string } | { kind: 'refused'; text: string };
/**
 * The membership paid with `email`, by the receipt's `invoice` number, named by this browser's seed (the same key a checkout here would get).
 * Taken only if the membership did not change while it was looked up, and then it settles the payments that were waiting when it was sent:
 * the stored ones and this tab's own (Sol, code review C2-5). The server's waits hold here too: a press during one sends nothing and says it,
 * and its answers' waits are kept (C2-4).
 */
export async function restoreBy(email: string, invoice: string, deps: Pick<AttemptDeps, 'db' | 'member' | 'ask'> & { paid?: Pick<PaidStore, 'settled' | 'localIds'>; waits?: TabWaits }): Promise<RestoreOutcome> {
  if (!/^\S+@\S+\.\S+$/.test(email.trim()) || invoice.trim().length < 3) return { kind: 'no', text: t('Enter the email you paid with and the invoice number from your receipt.') };
  const held = deps.waits?.waitLeft();
  if (held && held.ms > 0) return { kind: 'no', text: waitSaid(held.ms, held.why) };
  const local = deps.paid?.localIds() ?? [];
  const cap = deps.db ? await begin(deps.member) : null;
  const request = cap && deps.db ? await restoreRequest(deps.db, email.trim(), invoice.trim()) : null;
  if (!cap || !request) return { kind: 'refused', text: cannotHere() };
  if (request.seed !== cap.base.seed) return { kind: 'stale' };
  const answer = await deps.ask(request.path, request.body);
  if (answer) {
    const keys = answer.status === 429 && errorOf(answer.body) === 'too_many_keys';
    deps.waits?.heard(answer.retryAfter, answer.status === 429 ? (keys ? 'keys' : 'limited') : 'other');
    if (keys && answer.retryAfter) deps.waits?.coolFor(answer.retryAfter, 'keys');
  }
  const grant = issued(answer?.status === 200 ? readGrant(answer.body) : null);
  if (grant) {
    // Stored and tab-local payments together, also in an overlay's settlement (its Try again settles them; Sol, code review C3-2).
    const settle = [...cap.waiting, ...local];
    const out = await takeIssued(deps.member, cap, grant, settle);
    if (out.kind === 'ok' && out.kept) deps.paid?.settled(settle);
    return out;
  }
  return { kind: 'no', text: problem(answer, notFoundText()) };
}

/**
 * A key entered on the page (`activateKey`): taken, it settles the payments that were waiting when it was sent, as a receipt's does (this
 * tab's own records too, those it held when the key was sent).
 */
export async function keySettling(text: string, deps: ActivateDeps & { paid: Pick<PaidStore, 'settled' | 'localIds'> }): Promise<KeyOutcome> {
  return activateKey(text, { ...deps, local: deps.paid.localIds(), settled: ids => { deps.paid.settled(ids); } });
}

/**
 * Try again for a membership this tab could not store, and its payments' list kept current: a checkout's key stored now settles its record
 * in the commit, and this tab's list (and its own records) at once (Sol, code review C2-8).
 */
export async function keepAgainSettling(member: Pick<Plus, 'keepAgain' | 'overlaySettle'>, paid: Pick<PaidStore, 'settled'>): Promise<Taken> {
  const settle = [...member.overlaySettle];
  const taken = await member.keepAgain();
  if (taken === 'kept' && settle.length) paid.settled(settle);
  return taken;
}

/**
 * What the buying part of an open sale shows: nothing yet while this tab's database is opening or its payments have not been read once (no
 * price may show over a payment still waiting; Sol, code review C2-1), a payment's button, the words of a tab that may not issue or of a
 * browser that cannot buy, or the prices.
 */
export function buyView(mode: PlusMode, paidReady: boolean, pending: boolean): 'opening' | 'pending' | 'cannot-here' | 'cannot-buy' | 'prices' {
  if (mode === 'plain') return 'cannot-buy';
  if (mode === 'notready' || mode === 'unusable') return pending ? 'pending' : 'cannot-here';
  if (mode === 'opening' || !paidReady) return 'opening';
  return pending ? 'pending' : 'prices';
}

/** The thanks after a checkout: the payment it was and the key it issued. */
export type Fresh = { id: string; key: string };
/**
 * What the page shows beside the membership: the thanks after a checkout while the key that checkout issued is the one held, and a payment
 * still waiting whatever was thanked for (an unrelated one stays in sight with its button; Sol, review 2026-11-19).
 */
export function besideMembership(fresh: Fresh | null, key: string | null, waiting: readonly Paid[]): { thanks: boolean; waiting: Paid | null } {
  return { thanks: fresh !== null && key !== null && fresh.key === key, waiting: waiting.find(p => p.id !== fresh?.id) ?? null };
}

/**
 * Whether the page shows the key in clear: Reveal holds for the key it was pressed for (`shown`), and so does the showing that follows a
 * checkout or a restore for the key they issued. Another key in its place (another tab's, a key entered again) is masked until Reveal is
 * pressed for it.
 */
export const keyShownFor = (shown: string | null, key: string | null): boolean => shown !== null && key !== null && shown === key;
