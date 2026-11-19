/**
 * What the Plus page (`plus/page.ts`) asks its server for besides a key, which goes through the app's own key form (`key.ts`): the pass for
 * a checkout just paid, and a membership found by the receipt's email and invoice number. Both are memberships issued for this browser, and
 * both are taken the way a key is: only while the membership is still the one it was when the request went out (`Plus.acceptIf`). An answer
 * that comes after another tab stored a key, or after the key here was removed, changes nothing (Sol, review 2026-11-19). A payment whose
 * setting-up did not end in Plus waits in this browser (`paid.ts`): when it is asked for again and for which membership (`planPayment`),
 * and which payments a key or a receipt's membership settles. It also holds the rules for the page's Reveal (pressed for one key) and its
 * thanks (for one checkout's key). No styles and no page: the tests drive it with a server that answers late and two tabs over one storage.
 */
import { t } from '../i18n.ts';
import { PLUS_CONTACT, PLUS_KEYS } from './config.ts';
import { activateKey, type ActivateDeps, type KeyOutcome } from './key.ts';
import type { Paid, PaidStore } from './paid.ts';
import { errorOf, readGrant, type Grant, type Plus } from './pass.ts';

/** An answer of the Plus server: its status, its body, and the wait it asked for (`Retry-After`, in seconds). */
export type Answer = { status: number; body: unknown; retryAfter?: number };
/** A request to the Plus server (a path under its address), or null when it could not be reached. */
export type Ask = (path: string, body: unknown) => Promise<Answer | null>;

/** The server's own refusals (it looked, and found nothing it could open); any other refusal is not the server's word on the membership. */
export const LOOKED: ReadonlySet<string> = new Set(['not_active', 'not_found', 'wrong_price']);

/**
 * What an answer that gave no membership means, in the visitor's words: the server not reached or in trouble, too many tries (with the
 * wait it asked for), too many keys in a day; `refusal` is said for the rest (the server looked and found nothing it could open).
 */
export function problem(answer: Answer | null, refusal: string): string {
  if (!answer || answer.status >= 500) return t('The server could not be reached. Try again in a moment.');
  if (answer.status === 429 && errorOf(answer.body) === 'too_many_keys') return t('This subscription was given {n} keys within a day. Use one of them, or try again tomorrow.', { n: PLUS_KEYS });
  if (answer.status === 429) return answer.retryAfter ? t('Too many tries. Try again in {n} min.', { n: Math.max(1, Math.ceil(answer.retryAfter / 60)) }) : t('Too many tries. Try again later.');
  // A refusal that is not the server's own (a firewall's or a challenge page, a 400 or 404): it says nothing about the key or the payment.
  return LOOKED.has(errorOf(answer.body)) ? refusal : t('The server turned the request down. Try again later, or without a VPN or blocker.');
}

/** A membership the server issued: taken (and whether the browser keeps it), or dropped because the membership changed since it was asked for. */
export type Issued = { kind: 'ok'; grant: Grant & { key: string }; kept: boolean } | { kind: 'stale' };
function takeIssued(member: Pick<Plus, 'acceptIf'>, generation: number, grant: Grant & { key: string }): Issued {
  const taken = member.acceptIf(generation, { key: grant.key, pass: grant.pass, until: grant.until, ...(grant.renews !== undefined ? { renews: grant.renews } : {}), ...(grant.now !== undefined ? { now: grant.now } : {}) });
  return taken === 'stale' ? { kind: 'stale' } : { kind: 'ok', grant, kept: taken === 'kept' };
}
const issued = (grant: Grant | null): (Grant & { key: string }) | null => grant?.key ? { ...grant, key: grant.key } : null;

/**
 * What the page's flows are given: the server, the membership, and (for the tests) the clock and the wait between two asks. `generation`:
 * the membership a checkout's key is taken for, where it is not the one now (`planPayment`).
 */
export interface FlowDeps { ask: Ask; member: Pick<Plus, 'acceptIf' | 'generation'>; now?: () => number; wait?: (ms: number) => Promise<void>; generation?: number }

/** After a checkout the subscription can take a few seconds to exist on Paddle's side: the pass is asked for this often, this long. */
export const PASS_RETRY_MS = 2_500, PASS_WAIT_MS = 90_000;

/** What setting up a paid checkout came to: Plus on, dropped (the membership changed meanwhile), refused with the words to say, or not yet. */
export type PassOutcome = Issued | { kind: 'no'; text: string } | { kind: 'late' };
/**
 * The checkout `transactionId` is paid: the server is asked for the key and the pass until the subscription exists on Paddle's side, and the
 * membership it gives is taken only if the membership here is still the one it was when the payment went through (`deps.generation`, else
 * the one now).
 */
export async function passFor(transactionId: string, deps: FlowDeps): Promise<PassOutcome> {
  const now = deps.now ?? Date.now, wait = deps.wait ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const generation = deps.generation ?? deps.member.generation(), started = now();
  for (;;) {
    const answer = await deps.ask('/pass', { transactionId });
    const grant = issued(answer?.status === 200 ? readGrant(answer.body) : null);
    if (grant) return takeIssued(deps.member, generation, grant);
    // Asked again while the subscription may still be on its way (not there yet, the server busy or not reached); an answer that will
    // not change (the server looked and refused) ends the wait at once.
    const waiting = !answer || answer.status === 409 || answer.status >= 500 || (answer.status === 429 && errorOf(answer.body) !== 'too_many_keys');
    if (!waiting) {
      return { kind: 'no', text: answer.status === 429 ? problem(answer, '') : LOOKED.has(errorOf(answer.body)) ? t('The payment went through, but the server would not set up Plus for it. Write to {email} with your receipt; nothing is lost.', { email: PLUS_CONTACT }) : problem(answer, '') };
    }
    if (now() - started > PASS_WAIT_MS) return { kind: 'late' };
    await wait(Math.min(30_000, Math.max(PASS_RETRY_MS, (answer?.retryAfter ?? 0) * 1_000)));
  }
}

/** What looking a membership up by its receipt came to: Plus on, dropped (the membership changed meanwhile), or why not. */
export type RestoreOutcome = Issued | { kind: 'no'; text: string };
/** The membership paid with `email`, by the receipt's `invoice` number: taken only if the membership here did not change while it was looked up. */
export async function restoreBy(email: string, invoice: string, deps: FlowDeps): Promise<RestoreOutcome> {
  if (!/^\S+@\S+\.\S+$/.test(email.trim()) || invoice.trim().length < 3) return { kind: 'no', text: t('Enter the email you paid with and the invoice number from your receipt.') };
  const generation = deps.member.generation();
  const answer = await deps.ask('/restore', { email: email.trim(), invoice: invoice.trim() });
  const grant = issued(answer?.status === 200 ? readGrant(answer.body) : null);
  if (grant) return takeIssued(deps.member, generation, grant);
  return { kind: 'no', text: problem(answer, t('No subscription in good standing was found for that email and invoice number.')) };
}

/** How a payment's setting-up starts: its checkout completing, the page coming back to it (a reload), or its Try again. */
export type PaidVia = 'checkout' | 'resume' | 'retry';
/** Whether a payment is asked for now, and for which membership (`ask`), or not: it waits for its Try again, or it is gone. */
export type PaidPlan = { kind: 'ask'; generation: number } | { kind: 'waits' } | { kind: 'gone' };
/**
 * Whether the payment `id` is asked for now, and for which membership (Sol, review 2026-11-19). Its checkout completing writes its record
 * (once: `PaidStore.begin`) and asks for the membership as it is then. The page coming back to it asks only while nothing changed since that
 * checkout: the same membership (its generation), no answer dropped for a change, and no Plus in force here (a key that had ended when the
 * payment was made can come back to life without a new generation, and is not replaced unasked); else it waits for its Try again. Try again
 * asks for the membership as it is then, while the record is kept: one given up a day after its checkout, or settled elsewhere, is gone, and
 * nothing but a checkout completing writes a record.
 */
export function planPayment(id: string, via: PaidVia, deps: { member: Pick<Plus, 'generation' | 'state'>; paid: PaidStore }): PaidPlan {
  const now = deps.member.generation(), known = deps.paid.get(id);
  if (!known) return via === 'checkout' ? { kind: 'ask', generation: deps.paid.begin(id, now).generation } : { kind: 'gone' };
  if (via === 'retry') return { kind: 'ask', generation: now };
  return known.stale || known.generation !== now || deps.member.state === 'on' ? { kind: 'waits' } : { kind: 'ask', generation: known.generation };
}
/** The payment `id` asked for the membership `generation` (`planPayment`): taken, its record is settled; dropped for a change, it is marked so. */
export async function setUpPayment(id: string, generation: number, deps: FlowDeps & { paid: PaidStore }): Promise<PassOutcome> {
  const out = await passFor(id, { ...deps, generation });
  if (out.kind === 'ok') deps.paid.settle([id]);
  else if (out.kind === 'stale') deps.paid.markStale(id);
  return out;
}
/**
 * A membership found by the receipt (`restoreBy`). Taken, it settles the payments that were waiting when it was asked for, and only those:
 * one paid meanwhile, in another tab, keeps its record and its Try again (Sol, review 2026-11-19).
 */
export async function restoreSettling(email: string, invoice: string, deps: FlowDeps & { paid: PaidStore }): Promise<RestoreOutcome> {
  const waiting = deps.paid.ids();
  const out = await restoreBy(email, invoice, deps);
  if (out.kind === 'ok') deps.paid.settle(waiting);
  return out;
}
/** A key entered on the page (`activateKey`). Taken, it settles as a receipt's membership does: the payments that were waiting when it was sent. */
export async function keySettling(text: string, deps: ActivateDeps & { paid: PaidStore }): Promise<KeyOutcome> {
  const waiting = deps.paid.ids();
  const out = await activateKey(text, deps);
  if (out.kind === 'ok') deps.paid.settle(waiting);
  return out;
}

/** The thanks after a checkout: the payment it was and the key it issued. */
export type Fresh = { id: string; key: string };
/**
 * What the page shows beside the membership: the thanks after a checkout while the key that checkout issued is the one held, and a payment
 * still waiting whatever was thanked for (an unrelated one stays in sight with its Try again; Sol, review 2026-11-19).
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
