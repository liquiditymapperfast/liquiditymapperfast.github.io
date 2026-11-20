// Sol's review of the Plus page (2026-11-19, after the presentation sheet): the page's own key box, its checkout and restore, and its phone layout
// missed what the app's pop-up already had. Each finding's case; the page before the fixes failed every one. The checkout's recovery was
// rebuilt on the Plus database on 2026-11-20 (Option B, the page build spec): the flow cases below run on it (two tabs over one in-memory
// database, a stand-in for the Worker), with the same findings as their subject.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Plus } from '../src/app/plus/pass.ts';
import { besideMembership, keySettling, keyShownFor, restoreBy, setUpPayment, type AttemptDeps } from '../src/app/plus/page-flow.ts';
import { PaidStore } from '../src/app/plus/paid.ts';
import { PlusDb } from '../src/app/plus/plus-db.ts';
import { TabWaits } from '../src/app/plus/schedule.ts';
import { keyEntry } from '../src/app/plus/key.ts';
import { FakePage } from './fake-dom.mts';
import { OPEN_WAIT_MS, browser, settle, until, type Browser } from './plus-browser-double.mts';
import { PlusServer, subId, txnId } from './plus-server-double.mts';

const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const HOUR = 3_600_000;
const SUB = subId('review'), TXN_A = txnId('reviewa'), TXN_B = txnId('reviewb'), TXN_X = txnId('reviewx');
const KEY_A = 'gift_aaaa'.padEnd(43, 'a'), KEY_C = 'gift_cccc'.padEnd(43, 'c');
/** A Plus page in tab `i` of `b`: its membership, its own connection to the database, its payments and its waits, on the browser's clock. */
interface Page { member: Plus; db: PlusDb; paid: PaidStore; waits: TabWaits; deps: (server: PlusServer) => AttemptDeps }
async function page(b: Browser, server: PlusServer): Promise<Page> {
  const member = b.open({ post: server.post });
  await until(() => member.mode === 'idb');
  const db = new PlusDb(b.idb.factory, undefined, OPEN_WAIT_MS), paid = new PaidStore(db, () => b.clock.t);
  const mono = { t: 0 };
  const waits = new TabWaits({ mono: () => mono.t, wall: () => b.clock.t });
  const sleep = async (ms: number): Promise<void> => { mono.t += ms; b.clock.t += ms; };
  return { member, db, paid, waits, deps: s => ({ db, member, paid, ask: s.ask, waits, sleep, now: () => b.clock.t }) };
}
/** A browser and a Worker stand-in on its clock, with one subscription and its transactions. */
function world(): { b: Browser; server: PlusServer } {
  const b = browser(), server = new PlusServer(() => b.clock.t);
  server.subscription(SUB);
  for (const [txn, invoice] of [[TXN_A, '325-1'], [TXN_B, '325-2'], [TXN_X, '325-3']] as const) server.transaction(txn, SUB, { invoice });
  return { b, server };
}
/** A gate the test opens. */
const gate = (): { wait: Promise<void>; open: () => void } => { let open!: () => void; const wait = new Promise<void>(r => { open = r; }); return { wait, open }; };
const recordOf = (b: Browser, txn: string): unknown => b.idb.peek(`paid:${txn}`);
/** Another tab stores key C (a gift key typed there). */
const storeC = async (there: Plus): Promise<void> => {
  const cap = await there.capture();
  assert.ok(cap !== null && typeof cap !== 'number');
  assert.equal(await there.acceptIf(cap, { key: KEY_C, pass: `v1.${Buffer.from(JSON.stringify({ sub: 'gift_cccc', exp: Date.now() + 24 * HOUR })).toString('base64url')}.c2ln`, until: Date.now() + 30 * 24 * HOUR }), 'kept');
};

test('Sol 1 (P1): a checkout\'s key that arrives after another tab stored key C, or removed the key here, never replaces C or brings it back', async () => {
  for (const other of ['stored', 'removed'] as const) {
    const { b, server } = world(), here = await page(b, server), there = await page(b, server);
    if (other === 'removed') { await storeC(here.member); await until(() => there.member.key === KEY_C); }
    await here.paid.begin(TXN_A, 'unused');
    const held = gate();
    server.plan({ answer: held.wait });
    const out = setUpPayment(TXN_A, here.deps(server));
    await until(() => server.log.length === 0 && b.idb.log.some(i => i.key === 'seed'));
    await settle();
    if (other === 'stored') await storeC(there.member); else assert.equal(await there.member.forget(), 'kept');
    held.open();
    assert.deepEqual(await out, { kind: 'stale' }, other);
    await until(() => here.member.key === (other === 'stored' ? KEY_C : null));
    assert.equal(b.mirrorKey(), other === 'stored' ? KEY_C : null, `${other}: the other tab's choice stands`);
    assert.ok(recordOf(b, TXN_A), `${other}: the payment keeps its record and its button`);
  }
});

test('Sol 1 (P1): a membership found by the receipt that arrives after another tab stored C, or removed the key, changes nothing', async () => {
  for (const other of ['stored', 'removed'] as const) {
    const { b, server } = world(), here = await page(b, server), there = await page(b, server);
    if (other === 'removed') { await storeC(here.member); await until(() => there.member.key === KEY_C); }
    const held = gate();
    server.plan({ answer: held.wait });
    const out = restoreBy('buyer@example.com', '325-1', here.deps(server));
    await settle();
    if (other === 'stored') await storeC(there.member); else await there.member.forget();
    held.open();
    assert.deepEqual(await out, { kind: 'stale' }, other);
    await until(() => b.mirrorKey() === (other === 'stored' ? KEY_C : null));
  }
  // Nothing changed meanwhile: taken. A malformed email is refused before anything is asked.
  const { b, server } = world(), here = await page(b, server);
  assert.equal((await restoreBy('buyer@example.com', '325-1', here.deps(server))).kind, 'ok');
  assert.equal(here.member.state, 'on');
  const asked = server.log.length;
  assert.equal((await restoreBy('not an email', '325-1', here.deps(server))).kind, 'no');
  assert.equal(server.log.length, asked);
  void b;
});

test('Sol 1 (P1): the page takes a key, a checkout\'s key and a receipt\'s membership only through the guarded paths, never member.accept itself', () => {
  const page = read('src/app/plus/page.ts');
  assert.ok(!/member\.accept\(/.test(page), 'no unconditional accept on the page');
  assert.match(page, /keyEntry\(\{ activate: \(text, deps\) => keySettling\(text, \{ \.\.\.deps, paid \}\), onSuccess:/, 'the key box is the app\'s key form (activateKey: acceptIf)');
  assert.match(page, /await setUpPayment\(transactionId, \{ db, member, paid, ask: post, waits \}\)/, 'the attempt, through the gate');
  assert.match(page, /await restoreBy\(email, invoice, \{ db, member, ask: post, paid, waits \}\)/, 'restoreBy, with the waits of this tab');
  assert.ok(!/\/pass\/renew/.test(page), 'the page sends no key of its own');
  assert.ok(!/lmf\.plus/.test(page) && !/PAID_STORE/.test(page), 'the payments waiting are kept by paid.ts alone');
});

test('Sol 1 (P1): a paid checkout dropped because another key came in is not lost: it waits beside the membership with its button, across a reload', async () => {
  const { b, server } = world(), here = await page(b, server), there = await page(b, server);
  await here.paid.begin(TXN_B, 'unused');
  const held = gate();
  server.plan({ answer: held.wait });
  const paying = setUpPayment(TXN_B, here.deps(server));
  await settle();
  await storeC(there.member);
  held.open();
  assert.deepEqual(await paying, { kind: 'stale' });
  // Kept in the database both tabs share; beside C's membership with its button; a reload asks nothing by itself.
  const reloaded = await page(b, server);
  await reloaded.paid.refresh();
  assert.deepEqual(reloaded.paid.list().map(p => p.id), [TXN_B]);
  assert.equal(besideMembership(null, KEY_C, reloaded.paid.list()).waiting?.id, TXN_B);
  const asked = server.asked('/v1/pass');
  await settle();
  assert.equal(server.asked('/v1/pass'), asked, 'nothing asked by a reload');
  // Its button asks for it for the membership as it is now, and takes it.
  const pressed = await setUpPayment(TXN_B, reloaded.deps(server));
  assert.equal(pressed.kind, 'ok');
  assert.equal(reloaded.member.key, pressed.kind === 'ok' ? pressed.grant.key : '');
  await reloaded.paid.refresh();
  assert.deepEqual(reloaded.paid.list(), [], 'settled');
  assert.equal(recordOf(b, TXN_B), undefined);
});

// Sol's final round on the payment flow (2026-11-19): how a payment waiting in this browser is kept, settled and asked for again. Rebuilt on
// the Plus database (2026-11-20): a payment's record lives there, a commit settles in its own transaction, and nothing is asked by itself.
test('Sol final 1 (P1): a restore or a key that began before another tab\'s payment settles only what was waiting then: the later payment keeps its record and its button', async () => {
  for (const how of ['restore', 'key'] as const) {
    const { b, server } = world(), here = await page(b, server), there = await page(b, server);
    // A gift key the server knows, for the key case.
    const gift = await restoreBy('buyer@example.com', '325-3', there.deps(server));
    assert.equal(gift.kind, 'ok');
    const giftKey = gift.kind === 'ok' ? gift.grant.key : '';
    assert.equal(await there.member.forget(), 'kept');
    await until(() => here.member.key === null);
    // Tab A asks for a membership (the receipt's, or a key's), held at the server; meanwhile tab B's checkout completes.
    const held = gate();
    server.plan({ answer: held.wait });
    const taking = how === 'restore' ? restoreBy('buyer@example.com', '325-1', here.deps(server))
      : keySettling(giftKey, { post: server.post, api: () => 'https://plus.test/v1', member: here.member, paid: here.paid });
    await settle();
    await there.paid.begin(TXN_B, 'unused');
    // A's membership comes: taken, and it settles nothing that was not waiting when it was asked for.
    held.open();
    assert.equal((await taking).kind, 'ok', how);
    await there.paid.refresh();
    assert.deepEqual(there.paid.list().map(p => p.id), [TXN_B], `${how}: B's record stands`);
    assert.ok(recordOf(b, TXN_B), how);
  }
  // A payment that was waiting when the receipt was asked for is settled by it (the visitor took that membership), and only that one.
  const { b, server } = world(), here = await page(b, server);
  await here.paid.begin(TXN_X, 'unused');
  const held = gate();
  server.plan({ answer: held.wait });
  const taking = restoreBy('buyer@example.com', '325-1', here.deps(server));
  await settle();
  await here.paid.begin(TXN_B, 'unused');
  held.open();
  assert.equal((await taking).kind, 'ok');
  await here.paid.refresh();
  assert.deepEqual(here.paid.list().map(p => p.id), [TXN_B], 'X settled, B (paid after the receipt was asked for) kept');
});

test('Sol final 2 (P2): nothing asks for a payment by itself; only its button does, for the membership as it is then', async () => {
  const source = read('src/app/plus/page.ts');
  assert.ok(!/'resume'/.test(source) && !/planPayment/.test(source), 'no resume on load');
  const calls = [...source.matchAll(/completed\(/g)].length;
  assert.equal(calls, 4, 'the function, the checkout event, and the button (beside a membership, and in the top row)');
  assert.match(source, /eventCallback: event => \{ if \(event\.name === 'checkout\.completed' && event\.data\?\.transaction_id\) void completed\(event\.data\.transaction_id, 'checkout'\); \}/);
  assert.equal(source.split("id => { void completed(id, 'press'); }").length - 1, 2, 'both buttons press, nothing else asks');
  // A page loaded with a payment waiting: the record shows, nothing is sent.
  const { b, server } = world(), here = await page(b, server);
  await here.paid.begin(TXN_B, 'unused');
  const later = await page(b, server);
  await later.paid.refresh();
  await settle();
  assert.deepEqual(later.paid.list().map(p => p.id), [TXN_B]);
  assert.equal(server.asked('/v1/pass'), 0, 'nothing sent');
});

test('Sol final 3 (P2): the thanks after a checkout belong to its key: once it is removed and another tab\'s key takes its place, a later payment that waits is in sight with its button', async () => {
  const { b, server } = world(), here = await page(b, server), there = await page(b, server);
  await here.paid.begin(TXN_A, 'unused');
  const done = await setUpPayment(TXN_A, here.deps(server));
  assert.equal(done.kind, 'ok');
  const fresh = { id: TXN_A, key: done.kind === 'ok' ? done.grant.key : '' };
  await here.paid.refresh();
  assert.deepEqual(besideMembership(fresh, here.member.key, here.paid.list()), { thanks: true, waiting: null });
  // A is removed; checkout B completes; another tab stores C before B's key comes: B waits.
  assert.equal(await here.member.forget(), 'kept');
  await here.paid.begin(TXN_B, 'unused');
  const held = gate();
  server.plan({ answer: held.wait });
  const paying = setUpPayment(TXN_B, here.deps(server));
  await settle();
  await storeC(there.member);
  held.open();
  assert.deepEqual(await paying, { kind: 'stale' });
  await until(() => here.member.key === KEY_C);
  await here.paid.refresh();
  const beside = besideMembership(fresh, here.member.key, here.paid.list());
  assert.equal(beside.thanks, false, 'no thanks for a key no longer held');
  assert.equal(beside.waiting?.id, TXN_B, 'B in sight, with its button');
  assert.equal(besideMembership({ id: TXN_X, key: KEY_C }, KEY_C, here.paid.list()).waiting?.id, TXN_B, 'beside an unrelated thanks too');
});

test('Sol final 4 (P2): a press a day after its checkout asks nothing and keeps nothing; an attempt never dates a payment again, only a checkout completing does', async () => {
  const { b, server } = world(), here = await page(b, server);
  const t0 = b.clock.t;
  await here.paid.begin(TXN_B, 'unused');
  server.plan({ reply: { status: 403, body: { error: 'not_active', status: 'canceled' } } });
  assert.equal((await setUpPayment(TXN_B, here.deps(server))).kind, 'no');
  b.clock.t = t0 + 5 * HOUR;
  server.plan({ reply: { status: 403, body: { error: 'not_active', status: 'canceled' } } });
  assert.equal((await setUpPayment(TXN_B, here.deps(server))).kind, 'no');
  await here.paid.refresh();
  assert.equal(here.paid.get(TXN_B)?.at, t0, 'not dated again');
  assert.deepEqual(recordOf(b, TXN_B), { at: t0 });
  // Past the day: its button asks nothing and leaves no record.
  b.clock.t = t0 + 25 * HOUR;
  const asked = server.log.length;
  assert.deepEqual(await setUpPayment(TXN_B, here.deps(server)), { kind: 'gone' });
  assert.equal(server.log.length, asked, 'not asked');
  assert.equal(recordOf(b, TXN_B), undefined, 'nothing kept');
  // A new checkout completing starts its own day.
  await here.paid.begin(TXN_X, 'unused');
  await here.paid.refresh();
  assert.deepEqual(here.paid.list().map(p => [p.id, p.at]), [[TXN_X, t0 + 25 * HOUR]]);
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
