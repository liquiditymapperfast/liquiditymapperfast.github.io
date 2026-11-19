// Sol's review of the Plus pop-up and key entry (round 1, 2026-11-19): each finding's case, which the code before the fixes failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLUS_STORE, Plus, type Post } from '../src/app/plus/pass.ts';
import { activateKey, keyEntry, maskKey, type KeyOutcome } from '../src/app/plus/key.ts';
import { createStatusPop, popPress, popView, restoreFocus, type PopUi } from '../src/app/plus/panel.ts';
import { FakeElement, FakeEvent, FakePage } from './fake-dom.mts';

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const passFor = (sub: string, exp: number): string => `v1.${b64url(JSON.stringify({ sub, exp }))}.c2lnbmF0dXJl`;
const HOUR = 3_600_000, NOW = Date.UTC(2026, 10, 19, 7), UNTIL = Date.UTC(2027, 1, 19);
const KEY_A = 'gift_aaaa'.padEnd(43, 'a'), KEY_B = 'gift_bbbb'.padEnd(43, 'b'), KEY_C = 'gift_cccc'.padEnd(43, 'c');
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
/** One `localStorage` two tabs share (no storage events: a tab sees the other's writes only when it reads). */
function shared(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
}
const grantFor = (key: string, now = NOW): { status: number; body: unknown } => ({ status: 200, body: { pass: passFor(key.slice(0, 9), now + 24 * HOUR), paidUntil: UNTIL, now } });
/** A server whose answers wait until the test gives them. */
function deferred(): { post: Post; asked: { key: string; signal?: AbortSignal; answer: (a: { status: number; body: unknown }) => void }[] } {
  const asked: { key: string; signal?: AbortSignal; answer: (a: { status: number; body: unknown }) => void }[] = [];
  return { asked, post: (_url, body, signal) => new Promise(resolve => { asked.push({ key: (body as { key: string }).key, ...(signal ? { signal } : {}), answer: resolve }); }) };
}
const stored = (s: ReturnType<typeof shared>): string | null => { const raw = s.data.get(PLUS_STORE); return raw ? (JSON.parse(raw) as { key: string }).key : null; };

test('Sol 1 (P1): a key given up before its answer is never taken: Replace with B, Cancel, Remove A, then B\'s answer: Plus stays removed', async () => {
  const storage = shared(), server = deferred();
  const tab = new Plus(storage, server.post, () => NOW);
  tab.accept({ key: KEY_A, pass: passFor('gift_a', NOW + 24 * HOUR), until: UNTIL });
  const given = new AbortController();
  const outcome = activateKey(KEY_B, { post: server.post, member: tab, signal: given.signal });
  given.abort(); tab.forget();
  server.asked[0]!.answer(grantFor(KEY_B));
  assert.deepEqual(await outcome, { kind: 'abandoned' });
  assert.equal(tab.state, 'none'); assert.equal(stored(storage), null, 'nothing written back');
});

test('Sol 1 (P1): a newer key another tab stored wins over a late answer here; an answer for the same membership is taken', async () => {
  const storage = shared(), server = deferred();
  const here = new Plus(storage, server.post, () => NOW), there = new Plus(storage, server.post, () => NOW);
  const outcome = activateKey(KEY_B, { post: server.post, member: here });
  there.accept({ key: KEY_C, pass: passFor('gift_c', NOW + 24 * HOUR), until: UNTIL });
  server.asked[0]!.answer(grantFor(KEY_B));
  assert.deepEqual(await outcome, { kind: 'stale' });
  assert.equal(stored(storage), KEY_C, 'C stays'); here.reload(); assert.equal(here.key, KEY_C);
  // Nothing changed meanwhile: taken.
  const again = activateKey(KEY_B, { post: server.post, member: here });
  server.asked[1]!.answer(grantFor(KEY_B));
  assert.equal((await again).kind, 'ok'); assert.equal(stored(storage), KEY_B);
});

test('Sol 2 (P1): Try again never brings back a key another tab removed or replaced before this tab heard of it', async () => {
  for (const other of ['removed', 'replaced'] as const) {
    const storage = shared(), sent: string[] = [];
    const post: Post = async (_url, body) => { sent.push((body as { key: string }).key); throw new TypeError('Failed to fetch'); };
    const here = new Plus(storage, post, () => NOW), there = new Plus(storage, post, () => NOW);
    here.accept({ key: KEY_A, pass: passFor('gift_a', NOW - HOUR), until: UNTIL });
    here.renew(); await flush();
    assert.equal(here.unverified, true, `${other}: could not verify`);
    there.reload();
    if (other === 'removed') there.forget(); else there.accept({ key: KEY_C, pass: passFor('gift_c', NOW + 24 * HOUR), until: UNTIL });
    sent.length = 0;
    here.retry(); await flush();
    assert.equal(stored(storage), other === 'removed' ? null : KEY_C, `${other}: what the other tab left stays`);
    assert.ok(!sent.includes(KEY_A), `${other}: the old key is not asked about again`);
    assert.equal(here.key, other === 'removed' ? null : KEY_C, `${other}: this tab follows`);
  }
});

test('Sol 3 (P2): the key form masks what is typed or pasted; Reveal shows it, Hide masks it, and a key taken leaves it masked and empty', async () => {
  const page = new FakePage(), done = page.install();
  try {
    let answer: (o: KeyOutcome) => void = () => {};
    const form = keyEntry({ activate: () => new Promise(resolve => { answer = resolve; }) });
    page.body.append(form.root as unknown as FakeElement);
    const input = form.input as unknown as FakeElement, show = (form.root as unknown as FakeElement).querySelector('.key-show')!;
    assert.equal(input.type, 'password', 'masked from the start');
    input.value = KEY_A; input.dispatchEvent(new FakeEvent('input'));
    assert.equal(input.type, 'password', 'a pasted key stays masked');
    show.click(); assert.equal(input.type, 'text'); assert.equal(show.getAttribute('aria-pressed'), 'true'); assert.equal(show.textContent, 'Hide');
    show.click(); assert.equal(input.type, 'password'); assert.equal(show.textContent, 'Reveal');
    show.click();
    (form.root as unknown as FakeElement).requestSubmit();
    answer({ kind: 'ok', grant: { pass: passFor('gift_a', NOW + HOUR), until: UNTIL }, kept: true }); await flush();
    assert.equal(input.value, ''); assert.equal(input.type, 'password', 'masked again once taken');
  } finally { done(); }
});

/** A membership for the pop-up's tests: a key, a state, listeners, and what was done to it. */
function membership(key: string | null, state: 'on' | 'ended' | 'checking' | 'none' = 'on') {
  const listeners = new Set<() => void>();
  const m = {
    key, state, until: UNTIL as number | null, unverified: false, forgot: 0, retried: 0,
    forget() { m.forgot++; m.key = null; m.state = 'none'; for (const l of [...listeners]) l(); },
    retry() { m.retried++; },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    change(next: Partial<{ key: string | null; state: 'on' | 'ended' | 'checking' | 'none' }>) { Object.assign(m, next); for (const l of [...listeners]) l(); },
    get listening() { return listeners.size; },
  };
  return m;
}
/** The pop-up in a body on the fake page, drawn again as a panel draws (emptied, built, the focused control's `data-focus` given back). */
function mounted(page: FakePage, m: ReturnType<typeof membership>, more: Partial<Parameters<typeof createStatusPop>[0]> = {}) {
  const body = new FakeElement('DIV');
  page.body.append(body);
  let closed = 0;
  const render = (): void => {
    const active = page.activeElement, keep = active && body.contains(active) ? active.dataset.focus : undefined;
    body.replaceChildren();
    pop.build(body as unknown as HTMLElement);
    if (keep) body.all().find(x => x.dataset.focus === keep)?.focus();
  };
  const pop = createStatusPop({ member: m as never, redraw: render, close: () => { closed++; }, see: () => {}, ...more });
  render();
  const press = (focus: string): void => { const b = body.querySelector(`[data-focus="${focus}"]`); assert.ok(b, `no ${focus}`); b!.focus(); b!.click(); };
  return { body, pop, press, render, closed: () => closed, keyShown: () => (body.querySelector('.pp-key') as FakeElement | null)?.value ?? null };
}

test('Sol 4 (P2): Reveal holds for the key it was pressed for: another key coming in is masked again', () => {
  const ui: PopUi = { mode: 'idle', revealed: KEY_A, removed: false };
  assert.equal(popView({ state: 'on', until: UNTIL, key: KEY_B, unverified: false }, ui).key, maskKey(KEY_B), 'B was never revealed');
  assert.equal(popView({ state: 'on', until: UNTIL, key: KEY_A, unverified: false }, ui).key, KEY_A);
  assert.equal(popPress({ ...ui, revealed: null }, 'reveal', KEY_B).ui.revealed, KEY_B);
  const page = new FakePage(), done = page.install();
  try {
    const m = membership(KEY_A), p = mounted(page, m);
    p.press('reveal'); assert.equal(p.keyShown(), KEY_A);
    m.change({ key: KEY_B });
    assert.equal(p.keyShown(), maskKey(KEY_B), 'another tab\'s key is not shown unasked');
  } finally { done(); }
});

test('Sol 4 (P2): a clipboard refusal that comes after Hide, another key or the pop-up\'s closing shows nothing', async () => {
  const page = new FakePage(), done = page.install();
  try {
    for (const then of ['hide', 'key', 'close'] as const) {
      const m = membership(KEY_A);
      let refuse: (r: 'copied' | 'select') => void = () => {};
      const p = mounted(page, m, { copy: () => new Promise(resolve => { refuse = resolve; }) });
      p.press('reveal'); p.press('copy');
      if (then === 'hide') p.press('reveal'); else if (then === 'key') m.change({ key: KEY_B }); else p.pop.destroy();
      refuse('select'); await flush();
      if (then !== 'close') assert.equal(p.keyShown(), maskKey(m.key!), `${then}: still masked`);
      assert.ok(!p.body.textContent.includes('Key selected'), `${then}: nothing said`);
      p.pop.destroy(); p.body.remove();
    }
    // Not given up: the key shown and selected, for copying by hand.
    const m = membership(KEY_A);
    let refuse: (r: 'copied' | 'select') => void = () => {};
    const p = mounted(page, m, { copy: () => new Promise(resolve => { refuse = resolve; }) });
    p.press('copy'); refuse('select'); await flush();
    assert.equal(p.keyShown(), KEY_A); assert.ok(p.body.textContent.includes('Key selected. Copy it now.'));
  } finally { done(); }
});

test('Sol 5 (P2): the pop-up takes the keyboard as it opens, moves it with its presses, and gives it back to its button when it closes', async () => {
  const page = new FakePage(), done = page.install();
  try {
    const anchor = new FakeElement('BUTTON'); page.body.append(anchor); anchor.focus();
    const m = membership(KEY_A), p = mounted(page, m);
    p.pop.focusFirst(p.body as unknown as HTMLElement);
    assert.ok(p.body.contains(page.activeElement), 'the keyboard is in the pop-up');
    p.press('remove'); await flush();
    assert.equal(page.activeElement?.dataset.focus, 'remove-no', 'Remove asks: the keyboard on Keep');
    p.press('remove-no'); await flush();
    assert.equal(page.activeElement?.dataset.focus, 'remove', 'Keep: back on Remove');
    p.press('remove'); await flush(); p.press('remove-yes'); await flush();
    assert.equal(page.activeElement?.dataset.focus, 'see', 'removed: on See what Plus adds, not lost');
    // Closed with the keyboard inside it: the panel goes, the focus with it, and it comes back to the button.
    p.body.remove(); p.pop.destroy();
    restoreFocus(anchor as unknown as HTMLElement);
    assert.equal(page.activeElement, anchor);
    // Closed by a press elsewhere that took the keyboard: it is not taken back.
    const other = new FakeElement('INPUT'); page.body.append(other); other.focus();
    restoreFocus(anchor as unknown as HTMLElement);
    assert.equal(page.activeElement, other);
  } finally { done(); }
});

test('Sol 6 (P2): Replace key keeps its field, its answer and a key being checked through every redraw; Cancel gives the check up', async () => {
  const page = new FakePage(), done = page.install();
  try {
    const m = membership(KEY_A);
    const checks: { signal: AbortSignal; answer: (o: KeyOutcome) => void }[] = [];
    const p = mounted(page, m, { entry: o => keyEntry({ ...o, activate: (_text, d) => new Promise(resolve => { checks.push({ signal: d.signal, answer: resolve }); }) }) });
    p.press('replace'); await flush();
    const input = p.body.querySelector('.key-in')!;
    input.value = KEY_B;
    p.press('reveal');
    assert.equal(p.body.querySelector('.key-in'), input, 'the same field after Reveal\'s redraw'); assert.equal(input.value, KEY_B, 'what was typed stays');
    (input.form as FakeElement).requestSubmit();
    assert.equal(checks.length, 1);
    m.change({ state: 'on' });   // a renewal elsewhere draws the pop-up again
    assert.equal(p.body.querySelector('.key-in'), input);
    assert.ok(p.body.textContent.includes('Checking Plus with the server…'), 'the check under way is still said');
    assert.equal((p.body.querySelector('.key-go') as FakeElement).disabled, true);
    p.press('cancel');
    assert.equal(checks[0]!.signal.aborted, true, 'Cancel gives the check up');
    assert.equal(p.body.querySelector('.key-in'), null);
    checks[0]!.answer({ kind: 'abandoned' }); await flush();
    assert.equal(p.body.querySelector('.key-in'), null, 'its late answer brings nothing back');
    p.pop.destroy();
    assert.equal(m.listening, 0, 'closed: no listener left');
  } finally { done(); }
});
