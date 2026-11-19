// Sol's review of the Plus page (2026-11-19, after the presentation sheet): the page's own key box, its checkout and restore, and its phone layout
// missed what the app's pop-up already had. Each finding's case; the page before the fixes failed every one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUS_STORE, Plus, type Post } from '../src/app/plus/pass.ts';
import { besideMembership, keySettling, keyShownFor, passFor, planPayment, restoreBy, restoreSettling, setUpPayment, type Answer, type Ask, type PaidPlan } from '../src/app/plus/page-flow.ts';
import { PAID_STORE, PaidStore } from '../src/app/plus/paid.ts';
import { keyEntry } from '../src/app/plus/key.ts';
import { FakePage } from './fake-dom.mts';

const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const passOf = (sub: string, exp: number): string => `v1.${b64url(JSON.stringify({ sub, exp }))}.c2lnbmF0dXJl`;
const HOUR = 3_600_000, NOW = Date.UTC(2026, 10, 19, 7), UNTIL = Date.UTC(2027, 1, 19);
const KEY_A = 'gift_aaaa'.padEnd(43, 'a'), KEY_B = 'paid_bbbb'.padEnd(43, 'b'), KEY_C = 'gift_cccc'.padEnd(43, 'c');
/** One `localStorage` two tabs share (no storage events: a tab sees the other's writes when it reads). */
function shared(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
}
const stored = (s: ReturnType<typeof shared>): string | null => { const raw = s.data.get(PLUS_STORE); return raw ? (JSON.parse(raw) as { key: string }).key : null; };
/** What the server answers a checkout or a receipt with: the new key and its pass. */
const issuedFor = (key: string): Answer => ({ status: 200, body: { key, pass: passOf(key.slice(0, 9), NOW + 24 * HOUR), paidUntil: UNTIL, now: NOW } });
/** A Plus server whose answers wait until the test gives them. */
function slow(): { ask: Ask; asked: { path: string; answer: (a: Answer | null) => void }[] } {
  const asked: { path: string; answer: (a: Answer | null) => void }[] = [];
  return { asked, ask: (p: string) => new Promise(resolve => { asked.push({ path: p, answer: resolve }); }) };
}
const noPost: Post = async () => { throw new Error('not asked'); };
const tabs = (): { storage: ReturnType<typeof shared>; here: Plus; there: Plus } => {
  const storage = shared();
  return { storage, here: new Plus(storage, noPost, () => NOW), there: new Plus(storage, noPost, () => NOW) };
};
const give = (member: Plus, key: string): void => { member.accept({ key, pass: passOf(key.slice(0, 9), NOW + 24 * HOUR), until: UNTIL }); };
/** Paddle's transactions. */
const TXN_A = 'txn_01hzaaaaaaaaaaaaaaaaaaaaaa', TXN_B = 'txn_01hzbbbbbbbbbbbbbbbbbbbbbb', TXN_X = 'txn_01hzxxxxxxxxxxxxxxxxxxxxxx';
/** The membership a payment is asked for (`planPayment` said to ask). */
const askFor = (plan: PaidPlan): number => { assert.equal(plan.kind, 'ask'); return plan.kind === 'ask' ? plan.generation : -1; };
/** The Plus server's address in these tests, and a key's renewal sent to the slow server by its path. */
const API = 'https://plus.test/v1';
const postVia = (server: ReturnType<typeof slow>): Post => async url => { const a = await server.ask(url.slice(API.length), null); if (!a) throw new Error('not reached'); return a; };
/**
 * The key kept here as the server's refusal leaves it (`why`: `replaced`, newer keys pushed it out; `canceled`), as a pass that ran out does
 * (null: checking), or as a renewal that answered again leaves it (`revive`: in force); none of them is a new generation.
 */
const endKept = (s: ReturnType<typeof shared>, why: string | null): void => {
  const held = JSON.parse(s.data.get(PLUS_STORE)!) as Record<string, unknown>;
  s.data.set(PLUS_STORE, JSON.stringify(why ? { ...held, pass: '', ended: true, why } : { ...held, pass: '' }));
};
const revive = (s: ReturnType<typeof shared>): void => {
  const held = JSON.parse(s.data.get(PLUS_STORE)!) as { key: string } & Record<string, unknown>;
  s.data.set(PLUS_STORE, JSON.stringify({ ...held, pass: passOf(held.key.slice(0, 9), NOW + 24 * HOUR), ended: false, why: '' }));
};

test('Sol 1 (P1): a checkout\'s key that arrives after another tab stored key C, or removed the key here, never replaces C or brings it back', async () => {
  // Another tab stores C while the checkout's pass is on its way.
  {
    const { storage, here, there } = tabs(), server = slow();
    const out = passFor('txn_01hz0000000000000000000000', { ask: server.ask, member: here });
    give(there, KEY_C);
    server.asked[0]!.answer(issuedFor(KEY_B));
    assert.deepEqual(await out, { kind: 'stale' });
    assert.equal(stored(storage), KEY_C, 'C stays'); here.reload(); assert.equal(here.key, KEY_C);
  }
  // Another tab removes the (ended) key this page showed while the pass is on its way: Plus stays removed.
  {
    const { storage, here, there } = tabs(), server = slow();
    give(here, KEY_A); there.reload();
    const out = passFor('txn_01hz0000000000000000000000', { ask: server.ask, member: here });
    there.forget();
    server.asked[0]!.answer(issuedFor(KEY_B));
    assert.deepEqual(await out, { kind: 'stale' });
    assert.equal(stored(storage), null, 'nothing written back'); here.reload(); assert.equal(here.state, 'none');
  }
  // A pass asked for again (not there yet, then there) for a membership that did not change: taken, kept.
  {
    const { storage, here } = tabs(), server = slow();
    const waits: number[] = [];
    const out = passFor('txn_01hz0000000000000000000000', { ask: server.ask, member: here, wait: async ms => { waits.push(ms); } });
    server.asked[0]!.answer({ status: 409, body: { error: 'not_ready' } });
    await new Promise(resolve => setImmediate(resolve));
    server.asked[1]!.answer(issuedFor(KEY_B));
    const done = await out;
    assert.equal(done.kind, 'ok'); assert.equal(done.kind === 'ok' && done.kept, true);
    assert.equal(stored(storage), KEY_B); assert.equal(waits.length, 1);
  }
});

test('Sol 1 (P1): a membership found by the receipt that arrives after another tab stored C, or removed the key, changes nothing', async () => {
  for (const other of ['stored', 'removed'] as const) {
    const { storage, here, there } = tabs(), server = slow();
    if (other === 'removed') { give(here, KEY_A); there.reload(); }
    const out = restoreBy('buyer@example.com', 'INV-1234', { ask: server.ask, member: here });
    assert.equal(server.asked[0]!.path, '/restore');
    if (other === 'stored') give(there, KEY_C); else there.forget();
    server.asked[0]!.answer(issuedFor(KEY_B));
    assert.deepEqual(await out, { kind: 'stale' }, other);
    assert.equal(stored(storage), other === 'stored' ? KEY_C : null, `${other}: the other tab's choice stands`);
  }
  // Nothing changed meanwhile: taken. A malformed email is refused before anything is asked.
  const { storage, here } = tabs(), server = slow();
  const out = restoreBy('buyer@example.com', 'INV-1234', { ask: server.ask, member: here });
  server.asked[0]!.answer(issuedFor(KEY_B));
  assert.equal((await out).kind, 'ok'); assert.equal(stored(storage), KEY_B);
  assert.equal((await restoreBy('not an email', 'INV-1234', { ask: server.ask, member: here })).kind, 'no'); assert.equal(server.asked.length, 1);
});

test('Sol 1 (P1): the page takes a key, a checkout\'s pass and a receipt\'s membership only through the guarded paths, never member.accept itself', () => {
  const page = read('src/app/plus/page.ts');
  assert.ok(!/member\.accept\(/.test(page), 'no unconditional accept on the page');
  assert.match(page, /keyEntry\(\{ activate: \(text, deps\) => keySettling\(text, \{ \.\.\.deps, paid \}\), onSuccess:/, 'the key box is the app\'s key form (activateKey: acceptIf)');
  assert.match(page, /await setUpPayment\(transactionId, plan\.generation, \{ ask: post, member, paid \}\)/, 'passFor, for the membership planPayment names');
  assert.match(page, /await restoreSettling\(email, invoice, \{ ask: post, member, paid \}\)/, 'restoreBy');
  assert.ok(!/\/pass\/renew/.test(page), 'the page sends no key of its own');
  assert.ok(!/localStorage\.(setItem|removeItem)\('lmf\.plus\.paid'/.test(page) && !/PAID_STORE/.test(page), 'the payments waiting are kept by paid.ts alone');
});

test('Sol 1 (P1): a paid checkout dropped because another key came in is not lost: it waits beside the membership with Try again, across a reload', async () => {
  const { storage, here, there } = tabs(), server = slow(), paidHere = new PaidStore(storage, () => NOW);
  const plan = planPayment(TXN_B, 'checkout', { member: here, paid: paidHere });
  assert.equal(plan.kind, 'ask');
  const paying = setUpPayment(TXN_B, askFor(plan), { ask: server.ask, member: here, paid: paidHere });
  give(there, KEY_C);
  server.asked[0]!.answer(issuedFor(KEY_B));
  assert.deepEqual(await paying, { kind: 'stale' });
  // Kept, in the storage both tabs share; beside C's membership with its Try again; a reload does not ask for it by itself.
  const reloaded = new PaidStore(storage, () => NOW);
  assert.deepEqual(reloaded.list().map(p => [p.id, p.at, p.stale]), [[TXN_B, NOW, true]]);
  assert.equal(besideMembership(null, KEY_C, reloaded.list()).waiting?.id, TXN_B);
  here.reload();
  assert.deepEqual(planPayment(TXN_B, 'resume', { member: here, paid: reloaded }), { kind: 'waits' });
  // Its Try again asks for it for the membership as it is now, and takes it.
  const again = planPayment(TXN_B, 'retry', { member: here, paid: reloaded });
  assert.deepEqual(again, { kind: 'ask', generation: here.generation() });
  const retried = setUpPayment(TXN_B, askFor(again), { ask: server.ask, member: here, paid: reloaded });
  server.asked[1]!.answer(issuedFor(KEY_B));
  assert.equal((await retried).kind, 'ok');
  assert.equal(stored(storage), KEY_B); assert.deepEqual(reloaded.list(), [], 'settled');
});

// Sol's final round on the payment flow (2026-11-19): how a payment waiting in this browser is kept, settled and asked for again. Each case
// failed on the page's logic before the fix (its single record cleared by any settlement, stamped again by every attempt, asked for again by
// a reload whatever changed, and hidden behind any earlier thanks).
test('Sol final 1 (P1): a restore or a key that began before another tab\'s payment settles only what was waiting then: the later payment keeps its record and its Try again', async () => {
  for (const how of ['restore', 'key'] as const) {
    const { storage, here, there } = tabs(), server = slow();
    const paidHere = new PaidStore(storage, () => NOW), paidThere = new PaidStore(storage, () => NOW);
    // Tab A asks for a membership (the receipt's, or a key's); meanwhile tab B's checkout completes and asks for its key.
    const taking = how === 'restore' ? restoreSettling('buyer@example.com', 'INV-1234', { ask: server.ask, member: here, paid: paidHere })
      : keySettling(KEY_A, { post: postVia(server), api: () => API, member: here, paid: paidHere });
    const plan = planPayment(TXN_B, 'checkout', { member: there, paid: paidThere });
    const paying = setUpPayment(TXN_B, askFor(plan), { ask: server.ask, member: there, paid: paidThere });
    assert.deepEqual(server.asked.map(a => a.path), [how === 'restore' ? '/restore' : '/pass/renew', '/pass'], how);
    // A's membership comes first: taken, and it settles nothing that was not waiting when it was asked for.
    server.asked[0]!.answer(issuedFor(KEY_A));
    assert.equal((await taking).kind, 'ok', how);
    assert.deepEqual(paidThere.ids(), [TXN_B], `${how}: B's record stands`);
    // B's key comes after the membership changed: dropped, and B waits with its Try again, seen from either tab.
    server.asked[1]!.answer(issuedFor(KEY_B));
    assert.deepEqual(await paying, { kind: 'stale' }, how);
    assert.equal(stored(storage), KEY_A, how);
    assert.deepEqual(paidHere.list().map(p => [p.id, p.stale]), [[TXN_B, true]], how);
    assert.equal(besideMembership(null, here.key, paidHere.list()).waiting?.id, TXN_B, `${how}: beside the membership`);
  }
  // A payment that was waiting when the receipt was asked for is settled by it (the visitor took that membership), and only that one.
  const { storage, here } = tabs(), server = slow(), paidHere = new PaidStore(storage, () => NOW);
  paidHere.begin(TXN_X, here.generation());
  const taking = restoreSettling('buyer@example.com', 'INV-1234', { ask: server.ask, member: here, paid: paidHere });
  paidHere.begin(TXN_B, here.generation());
  server.asked[0]!.answer(issuedFor(KEY_A));
  assert.equal((await taking).kind, 'ok');
  assert.deepEqual(paidHere.ids(), [TXN_B], 'X settled, B (paid after the receipt was asked for) kept');
});

test('Sol final 2 (P2): a payment dropped for another key is not set up by a reload once that key is removed, checking or ended (replaced): only its Try again asks', async () => {
  for (const after of ['removed', 'checking', 'replaced'] as const) {
    const { storage, here, there } = tabs(), server = slow(), paidHere = new PaidStore(storage, () => NOW);
    const paying = setUpPayment(TXN_B, askFor(planPayment(TXN_B, 'checkout', { member: here, paid: paidHere })), { ask: server.ask, member: here, paid: paidHere });
    give(there, KEY_C);
    server.asked[0]!.answer(issuedFor(KEY_B));
    assert.deepEqual(await paying, { kind: 'stale' }, after);
    if (after === 'removed') there.forget();
    else endKept(storage, after === 'replaced' ? 'replaced' : null);
    // The page comes back: nothing is asked and nothing taken; the payment waits for its Try again.
    const page = new Plus(storage, noPost, () => NOW), paidPage = new PaidStore(storage, () => NOW);
    assert.equal(page.state === 'on', false, after);
    assert.deepEqual(planPayment(TXN_B, 'resume', { member: page, paid: paidPage }), { kind: 'waits' }, after);
    assert.equal(server.asked.length, 1, `${after}: not asked again`);
    assert.equal(stored(storage), after === 'removed' ? null : KEY_C, `${after}: the membership as the visitor left it`);
  }
  // Never answered (the tab closed) while another key came and went: the membership's generation alone keeps it waiting.
  {
    const { storage, here, there } = tabs(), paidHere = new PaidStore(storage, () => NOW);
    planPayment(TXN_B, 'checkout', { member: here, paid: paidHere });
    give(there, KEY_C); there.forget();
    const page = new Plus(storage, noPost, () => NOW);
    assert.deepEqual(planPayment(TXN_B, 'resume', { member: page, paid: new PaidStore(storage, () => NOW) }), { kind: 'waits' });
  }
  // Paid while the key here had ended (the prices are drawn then), never answered; the key comes back to life (its renewal answers again,
  // no new generation): a reload does not replace Plus in force unasked. Its Try again still asks.
  {
    const { storage, here } = tabs(), paidHere = new PaidStore(storage, () => NOW);
    give(here, KEY_C); endKept(storage, 'canceled'); here.reload();
    assert.equal(here.state, 'ended');
    planPayment(TXN_B, 'checkout', { member: here, paid: paidHere });
    revive(storage);
    const page = new Plus(storage, noPost, () => NOW), paidPage = new PaidStore(storage, () => NOW);
    assert.equal(page.state, 'on'); assert.equal(paidPage.get(TXN_B)?.generation, page.generation(), 'the same generation');
    assert.deepEqual(planPayment(TXN_B, 'resume', { member: page, paid: paidPage }), { kind: 'waits' });
    assert.deepEqual(planPayment(TXN_B, 'retry', { member: page, paid: paidPage }), { kind: 'ask', generation: page.generation() });
  }
  // Nothing changed since its checkout (its answer late): a reload asks again, for the membership of the checkout, and takes it.
  {
    const { storage, here } = tabs(), server = slow(), paidHere = new PaidStore(storage, () => NOW);
    const plan = planPayment(TXN_B, 'checkout', { member: here, paid: paidHere });
    const page = new Plus(storage, noPost, () => NOW), paidPage = new PaidStore(storage, () => NOW);
    assert.deepEqual(planPayment(TXN_B, 'resume', { member: page, paid: paidPage }), plan);
    const paying = setUpPayment(TXN_B, askFor(plan), { ask: server.ask, member: page, paid: paidPage });
    server.asked[0]!.answer(issuedFor(KEY_B));
    assert.equal((await paying).kind, 'ok'); assert.equal(stored(storage), KEY_B); assert.deepEqual(paidPage.list(), []);
  }
});

test('Sol final 3 (P2): the thanks after a checkout belong to its key: once it is removed and another tab\'s key takes its place, a later payment that waits is in sight with its Try again', async () => {
  const { storage, here, there } = tabs(), server = slow(), paidHere = new PaidStore(storage, () => NOW);
  // Checkout A is set up here: thanked for.
  const a = setUpPayment(TXN_A, askFor(planPayment(TXN_A, 'checkout', { member: here, paid: paidHere })), { ask: server.ask, member: here, paid: paidHere });
  server.asked[0]!.answer(issuedFor(KEY_A));
  const done = await a;
  assert.equal(done.kind, 'ok');
  const fresh = { id: TXN_A, key: done.kind === 'ok' ? done.grant.key : '' };
  assert.deepEqual(besideMembership(fresh, here.key, paidHere.list()), { thanks: true, waiting: null });
  // A is removed; checkout B completes; another tab stores C before B's key comes: B waits.
  here.forget();
  const b = setUpPayment(TXN_B, askFor(planPayment(TXN_B, 'checkout', { member: here, paid: paidHere })), { ask: server.ask, member: here, paid: paidHere });
  give(there, KEY_C);
  server.asked[1]!.answer(issuedFor(KEY_B));
  assert.deepEqual(await b, { kind: 'stale' });
  here.reload();
  const beside = besideMembership(fresh, here.key, paidHere.list());
  assert.equal(beside.thanks, false, 'no thanks for a key no longer held');
  assert.equal(beside.waiting?.id, TXN_B, 'B in sight, with its Try again');
  // An unrelated payment waiting beside the thanks for the key held stays in sight too.
  assert.equal(besideMembership({ id: TXN_X, key: KEY_C }, KEY_C, paidHere.list()).waiting?.id, TXN_B);
});

test('Sol final 4 (P2): Try again a day after its checkout asks nothing and keeps nothing; an attempt never dates a payment again, only a checkout completing does', async () => {
  const clock = { now: NOW }, now = (): number => clock.now;
  const storage = shared(), here = new Plus(storage, noPost, now), paidHere = new PaidStore(storage, now), server = slow();
  // Checkout B: the server looks and will not set it up (it waits, with what was said and its Try again).
  const first = setUpPayment(TXN_B, askFor(planPayment(TXN_B, 'checkout', { member: here, paid: paidHere })), { ask: server.ask, member: here, paid: paidHere });
  server.asked[0]!.answer({ status: 403, body: { error: 'not_active' } });
  assert.equal((await first).kind, 'no');
  // Pressed again five hours on: asked, and still dated by its checkout.
  clock.now = NOW + 5 * HOUR;
  const again = setUpPayment(TXN_B, askFor(planPayment(TXN_B, 'retry', { member: here, paid: paidHere })), { ask: server.ask, member: here, paid: paidHere });
  server.asked[1]!.answer({ status: 403, body: { error: 'not_active' } });
  assert.equal((await again).kind, 'no');
  assert.equal(paidHere.get(TXN_B)?.at, NOW, 'not dated again');
  // The page left open past the day: its Try again asks nothing and leaves no record.
  clock.now = NOW + 25 * HOUR;
  assert.deepEqual(planPayment(TXN_B, 'retry', { member: here, paid: paidHere }), { kind: 'gone' });
  assert.equal(server.asked.length, 2, 'not asked');
  assert.equal(storage.data.get(PAID_STORE), undefined, 'nothing kept');
  assert.deepEqual(planPayment(TXN_B, 'resume', { member: here, paid: paidHere }), { kind: 'gone' }, 'nor by a reload');
  // A new checkout completing starts its own day.
  assert.equal(planPayment(TXN_X, 'checkout', { member: here, paid: paidHere }).kind, 'ask');
  assert.deepEqual(paidHere.list().map(p => [p.id, p.at]), [[TXN_X, NOW + 25 * HOUR]]);
});

test('Sol 2 (P2): the page\'s key field is the app\'s masked one: a password field with Reveal / Hide, no text field of its own', () => {
  const page = read('src/app/plus/page.ts');
  assert.ok(!/id: 'plus-key'/.test(page) && !/type: 'text', id: 'plus-key'/.test(page), 'the page\'s own text field is gone');
  assert.match(page, /import \{ keyEntry, type KeyEntry \} from '\.\/key\.ts';/);
  const done = new FakePage().install();
  try {
    const box = keyEntry();
    assert.equal(box.input.type, 'password', 'typed or pasted, the key is masked');
    const show = box.root.querySelector('.key-show') as unknown as { click(): void; textContent: string };
    show.click(); assert.equal(box.input.type, 'text'); show.click(); assert.equal(box.input.type, 'password');
  } finally { done(); }
  // Its styles come with it: one file the app and the page both load.
  assert.match(page, /import '\.\/key\.css';/); assert.match(read('src/app/main.ts'), /import '\.\/plus\/key\.css';/);
  assert.ok(!/^\.key-in \{/m.test(read('src/app/styles.css')) && /^\.key-form \.key-in \{/m.test(read('src/app/plus/key.css')));
});

test('Sol 3 (P2): the page\'s Reveal holds for the key it was pressed for: a key another tab puts in its place is masked, and so is the old key back', () => {
  assert.equal(keyShownFor(KEY_A, KEY_A), true);
  assert.equal(keyShownFor(KEY_A, KEY_C), false, 'C, stored by another tab, is masked');
  assert.equal(keyShownFor(null, KEY_A), false); assert.equal(keyShownFor(KEY_A, null), false);
  const page = read('src/app/plus/page.ts');
  // What was shown is a key, cleared once another key is this browser's (so A coming back later starts masked too).
  assert.match(page, /shown: string \| null;/);
  assert.match(page, /if \(state\.shown !== null && state\.shown !== member\.key\) state\.shown = null;/);
  assert.match(page, /const shown = keyShownFor\(state\.shown, member\.key\);/);
  // The showing after a checkout or a restore is for the key they issued, and only when it was taken.
  assert.equal((page.match(/state\.shown = out\.grant\.key;/g) ?? []).length, 2);
  assert.ok(!/state\.shown = true/.test(page) && !/state\.shown = !state\.shown/.test(page));
});

test('Sol 4 (P2): the feature sections stack on a narrow page as in the sheet: one rule in the shared styles, both declaring the container', () => {
  const present = read('src/app/plus/present.css'), sheet = read('src/app/plus/sheet.css'), page = read('src/app/plus/page.css');
  assert.match(present, /@container px \(max-width: 600px\) \{\s*\.px-feat \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(page, /\.plus-page \{[^}]*container: px \/ inline-size;/, 'the page is the container');
  assert.match(sheet, /\.px-body \{[^}]*container: px \/ inline-size;/, 'so is the sheet\'s body');
  assert.ok(!/\.px-feat \{/.test(sheet), 'the rule lives in one place');
  // The hero's phone sizes are shared too.
  assert.match(present, /@media \(max-width: 639\.98px\) \{[\s\S]*\.px-hero h1 \{ font-size: 30px;/);
  assert.match(read('src/app/plus/page.ts'), /import '\.\/present\.css';/);
});
