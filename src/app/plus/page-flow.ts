/**
 * What the Plus page (`plus/page.ts`) asks its server for besides a key, which goes through the app's own key form (`key.ts`): the pass for
 * a checkout just paid, and a membership found by the receipt's email and invoice number. Both are memberships issued for this browser, and
 * both are taken the way a key is: only while the membership is still the one it was when the request went out (`Plus.acceptIf`). An answer
 * that comes after another tab stored a key, or after the key here was removed, changes nothing (Sol, review 2026-11-19). It also holds the
 * rule for the page's Reveal: it is pressed for one key. No styles and no page: the tests drive it with a server that answers late.
 */
import { t } from '../i18n.ts';
import { PLUS_CONTACT, PLUS_KEYS } from './config.ts';
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

/** What the page's flows are given: the server, the membership, and (for the tests) the clock and the wait between two asks. */
export interface FlowDeps { ask: Ask; member: Pick<Plus, 'acceptIf' | 'generation'>; now?: () => number; wait?: (ms: number) => Promise<void> }

/** After a checkout the subscription can take a few seconds to exist on Paddle's side: the pass is asked for this often, this long. */
export const PASS_RETRY_MS = 2_500, PASS_WAIT_MS = 90_000;

/** What setting up a paid checkout came to: Plus on, dropped (the membership changed meanwhile), refused with the words to say, or not yet. */
export type PassOutcome = Issued | { kind: 'no'; text: string } | { kind: 'late' };
/**
 * The checkout `transactionId` is paid: the server is asked for the key and the pass until the subscription exists on Paddle's side, and the
 * membership it gives is taken only if the membership here is still the one it was when the payment went through.
 */
export async function passFor(transactionId: string, deps: FlowDeps): Promise<PassOutcome> {
  const now = deps.now ?? Date.now, wait = deps.wait ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const generation = deps.member.generation(), started = now();
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

/**
 * Whether the page shows the key in clear: Reveal holds for the key it was pressed for (`shown`), and so does the showing that follows a
 * checkout or a restore for the key they issued. Another key in its place (another tab's, a key entered again) is masked until Reveal is
 * pressed for it.
 */
export const keyShownFor = (shown: string | null, key: string | null): boolean => shown !== null && key !== null && shown === key;
