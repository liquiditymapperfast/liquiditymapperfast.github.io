// Sol's review of the Plus page (2026-11-19, after the presentation sheet): the page's own key box, its checkout and restore, and its phone layout
// missed what the app's pop-up already had. Each finding's case; the page before the fixes failed every one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUS_STORE, Plus, type Post } from '../src/app/plus/pass.ts';
import { keyShownFor, passFor, restoreBy, type Answer, type Ask } from '../src/app/plus/page-flow.ts';
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
  assert.match(page, /keyEntry\(\{ onSuccess:/, 'the key box is the app\'s key form (activateKey: acceptIf)');
  assert.match(page, /await passFor\(transactionId, \{ ask: post, member \}\)/);
  assert.match(page, /await restoreBy\(email, invoice, \{ ask: post, member \}\)/);
  assert.ok(!/\/pass\/renew/.test(page), 'the page sends no key of its own');
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
