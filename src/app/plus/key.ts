/**
 * A Plus key entered in the app (the toolbar's Plus pop-up, the presentation sheet): sent to the Plus server's renewal, the request the Plus
 * page's key box makes, which answers with a pass when the key opens Plus (`pass.ts`). Nothing else is sent and nothing navigates away.
 * What the form says: checking, Plus on (until when), a key the server does not know, a key that no longer opens Plus, the server not
 * reached, too many tries, or a refusal that is not the server's own (a firewall's page). The key is masked as it is typed or pasted;
 * Reveal shows it. An answer that comes after the form was given up, or after the membership changed meanwhile (another tab's key, a key
 * removed), is dropped (Sol, review 2026-11-19).
 */
import { el } from '../dom.ts';
import { language, t } from '../i18n.ts';
import { plusApi } from './config.ts';
import { errorOf, plus, readGrant, webPost, type Grant, type Plus, type Post } from './pass.ts';

/** A key's date (when Plus runs until or ended) in the visitor's language, as the Plus page writes it. */
export const plusDate = (time: number): string => new Intl.DateTimeFormat(language(), { dateStyle: 'long', timeZone: 'UTC' }).format(time);

/** What an answer means for a key: a grant, or why there is none (with the words to say). */
export type KeyAnswer = { kind: 'grant'; grant: Grant } | { kind: 'invalid' | 'ended' | 'offline' | 'busy' | 'refused'; text: string };
/**
 * What entering a key came to: Plus on (and whether the browser keeps it), why not, or nothing to say: the form was given up before the
 * answer came (`abandoned`), or the membership changed while the key was being checked (`stale`: another tab's key, a key removed here).
 */
export type KeyOutcome = { kind: 'ok'; grant: Grant; kept: boolean } | Exclude<KeyAnswer, { kind: 'grant' }> | { kind: 'abandoned' } | { kind: 'stale' };

export const invalidText = (): string => t('That key wasn\'t recognized. Check it and try again.');
export const offlineText = (): string => t('Couldn\'t verify Plus. Check your connection.');

/**
 * The server's answer to a key (null: not reached). Not reached or down: offline. Too many tries: when to try again, as it said. A key of
 * the wrong shape (400 `bad_request`) or one it has no record of (403 `not_active`, `unknown`): not recognized. A key it knows that opens
 * nothing now (its subscription ended, or newer keys replaced it): said so. Anything else (a firewall's or a challenge page, a body that is
 * not a grant) is not the server's word on the key.
 */
export function keyAnswer(answer: { status: number; body: unknown; retryAfter?: number } | null): KeyAnswer {
  if (!answer || answer.status >= 500) return { kind: 'offline', text: offlineText() };
  if (answer.status === 200) {
    const grant = readGrant(answer.body);
    if (grant) return { kind: 'grant', grant };
  }
  if (answer.status === 429) return { kind: 'busy', text: answer.retryAfter ? t('Too many tries. Try again in {n} min.', { n: Math.max(1, Math.ceil(answer.retryAfter / 60)) }) : t('Too many tries. Try again later.') };
  const error = errorOf(answer.body), status = answer.body && typeof answer.body === 'object' ? (answer.body as { status?: unknown }).status : undefined;
  if ((answer.status === 400 && error === 'bad_request') || (answer.status === 403 && error === 'not_active' && status === 'unknown')) return { kind: 'invalid', text: invalidText() };
  if (answer.status === 403 && error === 'not_active') return { kind: 'ended', text: t('This key no longer opens Plus: its subscription has ended, or the key was replaced by newer ones.') };
  return { kind: 'refused', text: t('The server turned the request down. Try again later, or without a VPN or blocker.') };
}

/** A key as the browser keeps one (`readHeld`): 16 to 200 characters, no spaces. */
export const keyShaped = (key: string): boolean => key.length >= 16 && key.length <= 200 && !/\s/.test(key);

/** What `activateKey` may be given instead of the page's own: the server, its address, the membership, and a signal that gives the key up. */
export interface ActivateDeps { post?: Post; api?: () => string; member?: Pick<Plus, 'acceptIf' | 'generation'>; signal?: AbortSignal }
/**
 * Enter `text` as this browser's key: checked for its shape, sent to the Plus server's renewal, and on a grant taken as the membership,
 * unless the key was given up meanwhile (`signal`) or the membership changed since it was sent (`Plus.acceptIf`: another tab stored a key,
 * or the key here was removed): such an answer is dropped without a word.
 */
export async function activateKey(text: string, deps: ActivateDeps = {}): Promise<KeyOutcome> {
  const key = text.trim();
  if (!keyShaped(key)) return { kind: 'invalid', text: invalidText() };
  const member = deps.member ?? plus(), signal = deps.signal;
  // The membership as it stands when the key is sent: an answer for an older one is not taken.
  const generation = member.generation();
  let answer: Awaited<ReturnType<Post>> | null = null;
  try { answer = await (deps.post ?? webPost)(`${(deps.api ?? plusApi)()}/pass/renew`, { key }, signal); } catch { answer = null; }
  if (signal?.aborted) return { kind: 'abandoned' };
  const said = keyAnswer(answer);
  if (said.kind !== 'grant') return said;
  const g = said.grant;
  const taken = member.acceptIf(generation, { key, pass: g.pass, until: g.until, ...(g.renews !== undefined ? { renews: g.renews } : {}), ...(g.now !== undefined ? { now: g.now } : {}) });
  return taken === 'stale' ? { kind: 'stale' } : { kind: 'ok', grant: g, kept: taken === 'kept' };
}

/** What the form says after a success: Plus on, until when where the server said. */
export const onText = (until: number | null): string => until ? t('Plus is on in this browser, until {date}.', { date: plusDate(until) }) : t('Plus is on in this browser.');

/** A key masked for showing: its first five and last four characters around a run of dots, so its owner can tell keys apart. */
export const maskKey = (key: string): string => key.length > 12 ? `${key.slice(0, 5)}${'•'.repeat(10)}${key.slice(-4)}` : '•'.repeat(12);

let uid = 0;
export interface KeyEntry {
  readonly root: HTMLFormElement;
  readonly input: HTMLInputElement;
  /** Give the form up: a key being checked is dropped with its answer, and nothing more is said. */
  destroy(): void;
}
/**
 * The key form: a field (masked; Reveal shows what is in it), Activate, a status line (checking, on, not recognized, not reached ...) and the
 * line that a key is entered once per browser and address. `onSuccess` runs once Plus is on (the membership's own listeners have been told by
 * then). Its controls carry `data-focus` keys, so a panel drawn again around the same form gives the keyboard back to the same control.
 */
export function keyEntry(o: { onSuccess?: (outcome: Extract<KeyOutcome, { kind: 'ok' }>) => void; activate?: (text: string, deps: { signal: AbortSignal }) => Promise<KeyOutcome> } = {}): KeyEntry {
  const id = `plus-key-${++uid}`;
  const input = el('input', { type: 'password', id, class: 'key-in', autocomplete: 'off', spellcheck: false, placeholder: t('Paste your key') });
  input.setAttribute('autocapitalize', 'off'); input.setAttribute('aria-describedby', `${id}m ${id}n`);
  input.dataset.focus = 'key-in';
  const show = el('button', { type: 'button', class: 'key-show', textContent: t('Reveal') });
  show.setAttribute('aria-pressed', 'false'); show.setAttribute('aria-controls', id); show.dataset.focus = 'key-show';
  const go = el('button', { type: 'submit', class: 'key-go', textContent: t('Activate') });
  go.dataset.focus = 'key-go';
  const msg = el('p', { class: 'key-msg', id: `${id}m`, role: 'status' });
  const label = el('label', { class: 'vh', htmlFor: id, textContent: t('Your key') });
  const form = el('form', { class: 'key-form' }, label, el('div', { class: 'key-row' }, input, show, go), msg,
    el('p', { class: 'key-note', id: `${id}n`, textContent: t('Enter your key once on each browser and address you use.') }));
  form.noValidate = true;
  let busy = false, gone = false, pending: AbortController | null = null;
  const mask = (shown: boolean): void => { input.type = shown ? 'text' : 'password'; show.textContent = shown ? t('Hide') : t('Reveal'); show.setAttribute('aria-pressed', String(shown)); };
  show.addEventListener('click', () => { mask(input.type === 'password'); });
  const sync = (): void => { go.disabled = busy || !input.value.trim(); };
  const say = (tone: '' | 'checking' | 'ok' | 'err', text: string, more = ''): void => {
    msg.className = `key-msg${tone ? ` ${tone}` : ''}`;
    msg.replaceChildren(...(tone ? [el('span', { class: tone === 'checking' ? 'spin' : 'key-mark', ariaHidden: 'true' }), el('span', { textContent: text })] : []));
    if (more) msg.append(el('span', { class: 'key-more', textContent: more }));
  };
  input.addEventListener('input', () => { if (busy) return; input.removeAttribute('aria-invalid'); say('', ''); sync(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || busy || gone) return;
    const asked = new AbortController();
    pending = asked; busy = true; input.readOnly = true; sync(); say('checking', t('Checking Plus with the server…'));
    void (o.activate ?? ((k, d) => activateKey(k, d)))(text, { signal: asked.signal }).then(outcome => {
      if (gone || pending !== asked || outcome.kind === 'abandoned') return;
      pending = null; busy = false; input.readOnly = false;
      if (outcome.kind === 'stale') { say('', ''); sync(); return; }
      if (outcome.kind === 'ok') {
        input.value = ''; mask(false);
        say('ok', onText(outcome.grant.until), outcome.kept ? '' : t('This browser would not keep Plus: it lasts until this tab closes. Copy the key now and enter it again next time.'));
        sync(); o.onSuccess?.(outcome);
        return;
      }
      if (outcome.kind === 'invalid' || outcome.kind === 'ended') input.setAttribute('aria-invalid', 'true');
      say('err', outcome.text);
      sync();
      if (form.isConnected) input.focus({ preventScroll: true });
    });
  });
  sync();
  return { root: form, input, destroy: () => { gone = true; pending?.abort(); pending = null; } };
}
