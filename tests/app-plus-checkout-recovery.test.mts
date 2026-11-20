// The checkout's recovery, Option B (page build spec, 2026-11-20): every key this browser asks for is named by its seed, so two tabs, a lost
// answer, a late request, a press and a receipt all end with the same key, and the key kept renews. Against a stand-in for the Worker with its
// rules (tests/plus-server-double.mts), tabs over one in-memory IndexedDB (tests/plus-db-fake.mts, tests/plus-browser-double.mts) and virtual
// clocks. Also: the answers of design 6.4 as the spec keeps them, the window of a payment's record, the seed across a reset, the gate, and the
// page's source rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Plus } from '../src/app/plus/pass.ts';
import { activateKey } from '../src/app/plus/key.ts';
import { cannotHere, lateText, notFoundText, restoreBy, setUpPayment, type AttemptDeps, type PassOutcome } from '../src/app/plus/page-flow.ts';
import { PaidStore } from '../src/app/plus/paid.ts';
import { PAID_WINDOW_MS, PlusDb, passRequest, readSeed } from '../src/app/plus/plus-db.ts';
import { MAX_ASKS, TabWaits } from '../src/app/plus/schedule.ts';
import { OPEN_WAIT_MS, browser, settle, until, type Browser } from './plus-browser-double.mts';
import { PlusServer, derivedKey, secretOf, subId, txnId, type Answer } from './plus-server-double.mts';

const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const SUB = subId('recovery'), TXN = txnId('recoverya'), TXN_2 = txnId('recoveryb');
const API = 'https://plus.test/v1';
interface Page { member: Plus; db: PlusDb; paid: PaidStore; waits: TabWaits; mono: { t: number }; deps: AttemptDeps }
/** A Plus page on a tab of `b`: its membership, its own connection to the database, its payments, its waits (virtual clocks). */
async function page(b: Browser, server: PlusServer): Promise<Page> {
  const member = b.open({ post: server.post });
  await until(() => member.mode === 'idb');
  const db = new PlusDb(b.idb.factory, undefined, OPEN_WAIT_MS), paid = new PaidStore(db, () => b.clock.t);
  const mono = { t: 0 };
  const waits = new TabWaits({ mono: () => mono.t, wall: () => b.clock.t });
  const sleep = async (ms: number): Promise<void> => { mono.t += ms; b.clock.t += ms; };
  return { member, db, paid, waits, mono, deps: { db, member, paid, ask: server.ask, waits, sleep, now: () => b.clock.t } };
}
function world(): { b: Browser; server: PlusServer } {
  const b = browser(), server = new PlusServer(() => b.clock.t);
  server.subscription(SUB);
  server.transaction(TXN, SUB, { invoice: '325-100' });
  server.transaction(TXN_2, SUB, { invoice: '325-200' });
  return { b, server };
}
const gate = (): { wait: Promise<void>; open: () => void } => { let open!: () => void; const wait = new Promise<void>(r => { open = r; }); return { wait, open }; };
const keyOf = (out: PassOutcome | { kind: string }): string => (out as { grant?: { key: string } }).grant?.key ?? '';
const renewStatus = async (server: PlusServer, key: string): Promise<number | string> => {
  const a = await server.ask('/pass/renew', { key });
  return a?.status === 200 ? 200 : ((a?.body as { status?: string } | null)?.status ?? String(a?.status));
};
/** Paid in `p`'s tab: the checkout's record written with the seed read before it opened. */
const paidIn = async (p: Page, txn = TXN): Promise<void> => { await p.paid.begin(txn, await readSeed(p.db)); };

test('N1: two tabs asking for the same payment at once, even across isolates, end with one key, and that key renews', async () => {
  // The old path, without a seed: the second ask replaces the first tab's key, which then renews as replaced (N1).
  {
    const { server } = world();
    const first = await server.ask('/pass', { transactionId: TXN }), second = await server.ask('/pass', { transactionId: TXN });
    assert.equal(await renewStatus(server, (first?.body as { key: string }).key), 'replaced', 'the old path loses a key');
    assert.equal(await renewStatus(server, (second?.body as { key: string }).key), 200);
  }
  const { b, server } = world(), a = await page(b, server), c = await page(b, server);
  await paidIn(a);
  await c.paid.refresh();
  // Both read the key list before either writes (two isolates): with one seed, both write the same key.
  server.lostUpdate('arrival');
  const [outA, outC] = await Promise.all([setUpPayment(TXN, a.deps), setUpPayment(TXN, c.deps)]);
  assert.equal(outA.kind, 'ok'); assert.equal(outC.kind, 'ok');
  assert.equal(keyOf(outA), keyOf(outC), 'one key');
  await until(() => a.member.key === keyOf(outA) && c.member.key === keyOf(outA));
  assert.equal(await renewStatus(server, keyOf(outA)), 200, 'the kept key renews');
  assert.equal(b.idb.peek(`paid:${TXN}`), undefined, 'settled');
});

test('a lost answer is asked again and gives the same key; a request that lands after the success changes nothing; pass and restore name one key', async () => {
  const { b, server } = world(), p = await page(b, server);
  await paidIn(p);
  server.plan({ lose: true });
  const out = await setUpPayment(TXN, p.deps);
  assert.equal(out.kind, 'ok');
  assert.deepEqual(server.log.filter(s => s.path === '/v1/pass').map(s => s.outcome), ['mint', 'hit'], 'made once, then asked again as a hit');
  assert.equal(await renewStatus(server, keyOf(out)), 200);

  // A request still on its way when the page's next one succeeded (given up as a lost answer: a timeout in the browser): it lands later,
  // as a hit, and the key kept still renews.
  const { b: b2, server: s2 } = world(), q = await page(b2, s2);
  await paidIn(q);
  const late = gate();
  s2.plan({ before: late.wait }, {});
  let first = true;
  const ask: AttemptDeps['ask'] = (path, body) => { const sent = s2.ask(path, body); if (first) { first = false; return Promise.resolve(null); } return sent; };
  const done = await setUpPayment(TXN, { ...q.deps, ask });
  assert.equal(done.kind, 'ok');
  late.open();
  await until(() => s2.log.length === 2);
  assert.deepEqual(s2.log.map(x => x.outcome), ['mint', 'hit'], 'the late one landed after the success, as a hit');
  assert.equal(await renewStatus(s2, keyOf(done)), 200);
  assert.equal(s2.keys(SUB).length, 1);

  // /v1/pass and /v1/restore from one browser: the same key.
  const { b: b3, server: s3 } = world(), r = await page(b3, s3);
  await paidIn(r);
  const paidOut = await setUpPayment(TXN, r.deps);
  assert.equal(await r.member.forget(), 'kept');
  const restored = await restoreBy('buyer@example.com', '325-100', r.deps);
  assert.equal(keyOf(restored), keyOf(paidOut));
  assert.equal(s3.keys(SUB).length, 1, 'no second key made');
});

test('the seed: a tab left open across a reset uses the new seed, finds its record gone and drops an answer sent with the old seed', async () => {
  const { b, server } = world(), p = await page(b, server);
  await paidIn(p);
  const oldSeed = await readSeed(p.db);
  const held = gate();
  server.plan({ answer: held.wait });
  const running = setUpPayment(TXN, p.deps);
  await settle();
  b.idb.wipe();
  await settle();
  held.open();
  assert.deepEqual(await running, { kind: 'stale' }, 'an answer from before the reset is never taken');
  assert.equal(b.idb.peek('member'), undefined, 'nothing written into the new database');
  const newSeed = await readSeed(p.db);
  assert.notEqual(newSeed, oldSeed);
  const asked = server.log.length;
  assert.deepEqual(await setUpPayment(TXN, p.deps), { kind: 'gone' }, 'its record went with the reset');
  assert.equal(server.log.length, asked, 'nothing sent');
  // The receipt then restores Plus with the new seed: the key that seed names.
  const restored = await restoreBy('buyer@example.com', '325-100', p.deps);
  assert.equal(keyOf(restored), derivedKey(SUB, newSeed));
});

test('a seed that cannot be written means no issuance: nothing is sent', async () => {
  const { b, server } = world(), p = await page(b, server);
  await paidIn(p);
  b.idb.wipe();
  await settle();
  await p.db.open();
  b.idb.failNextPut('QuotaExceededError');
  assert.equal(await passRequest(p.db, TXN, b.clock.t), null, 'the gate gives no request');
  b.idb.failNextPut('QuotaExceededError');
  assert.deepEqual(await restoreBy('buyer@example.com', '325-100', p.deps), { kind: 'refused', text: cannotHere() });
  assert.equal(server.log.length, 0);
});

test('a record the browser would not store keeps this tab\'s attempt working, and is discarded at the next ask after a reset', async () => {
  const { b, server } = world(), p = await page(b, server);
  const seed = await readSeed(p.db);
  b.idb.failNextPut('QuotaExceededError');
  await p.paid.begin(TXN, seed);
  assert.equal(b.idb.peek(`paid:${TXN}`), undefined, 'not stored');
  assert.deepEqual(p.paid.list().map(x => [x.id, x.memory]), [[TXN, true]], 'kept by this tab');
  const ok = await setUpPayment(TXN, p.deps);
  assert.equal(ok.kind, 'ok', 'its attempt still works');
  // Another one, then the database is reset: the memory record of the old seed is gone at the next ask, and nothing is sent.
  assert.equal(await p.member.forget(), 'kept');
  const seed2 = await readSeed(p.db);
  b.idb.failNextPut('QuotaExceededError');
  await p.paid.begin(TXN_2, seed2);
  b.idb.wipe();
  await settle();
  const asked = server.log.length;
  assert.deepEqual(await setUpPayment(TXN_2, p.deps), { kind: 'gone' });
  assert.equal(server.log.length, asked);
  assert.equal(p.paid.memory(TXN_2), null, 'discarded');
});

test('R1 with the cap: a stale /v1/pass write drops the key a restore just listed, and the next restore meets too_many_keys and says so', async () => {
  const { b, server } = world();
  // Four keys made in the last hours (other browsers' restores).
  for (let i = 0; i < 4; i++) assert.equal((await server.ask('/restore', { email: 'buyer@example.com', invoice: '325-200', secret: secretOf(`other ${i}`) }))?.status, 200);
  const a = await page(b, server);
  await paidIn(a);
  // A's /v1/pass reads the list first; the site data is cleared; a fresh tab restores with the new seed; the restore writes first, A's last.
  server.lostUpdate('reverse');
  const running = setUpPayment(TXN, a.deps);
  await settle();
  b.idb.wipe();
  await settle();
  const fresh = await page(b, server);
  const restored = await restoreBy('buyer@example.com', '325-100', fresh.deps);
  assert.equal(restored.kind, 'ok');
  assert.deepEqual(await running, { kind: 'stale' }, 'A\'s answer belongs to the old seed');
  const k2 = keyOf(restored);
  assert.equal(await renewStatus(server, k2), 'replaced', 'the restored key was dropped by the stale write');
  const again = await restoreBy('buyer@example.com', '325-100', fresh.deps);
  assert.equal(again.kind, 'no');
  assert.match((again as { text: string }).text, /^This subscription was given 5 keys within a day\. Use one of them, or try again in \d+ h\.$/, 'the cap text with its wait');
});

test('the answers of design 6.4: taken, dropped, asked again, ran out, too many keys, refused (N3), turned down, gone', async () => {
  const run = async (plans: (Answer | null)[], o: { before?: (p: Page, b: Browser) => Promise<void> } = {}) => {
    const { b, server } = world(), p = await page(b, server);
    await paidIn(p);
    await o.before?.(p, b);
    server.plan(...plans.map(reply => reply === null ? { lose: true } : { reply }));
    const out = await setUpPayment(TXN, p.deps);
    return { out, b, server, p, asks: server.asked('/v1/pass'), record: b.idb.peek(`paid:${TXN}`) };
  };
  const err = (status: number, error: string, retryAfter?: number, extra: Record<string, unknown> = {}): Answer => ({ status, body: { error, ...extra }, ...(retryAfter ? { retryAfter } : {}) });
  // Taken: the record goes.
  { const r = await run([]); assert.equal(r.out.kind, 'ok'); assert.equal(r.record, undefined); }
  // A grant whose commit is stale (another tab removed the key held after the attempt began): the record and its button stay.
  {
    const { b, server } = world(), p = await page(b, server), other = await page(b, server);
    assert.equal((await restoreBy('buyer@example.com', '325-200', p.deps)).kind, 'ok');
    await until(() => other.member.key !== null);
    await paidIn(p);
    const held = gate();
    server.plan({ answer: held.wait });
    const out = setUpPayment(TXN, p.deps);
    await settle();
    assert.equal(await other.member.forget(), 'kept');
    held.open();
    assert.deepEqual(await out, { kind: 'stale' });
    assert.ok(b.idb.peek(`paid:${TXN}`));
  }
  // Asked again: no answer, 409 pending, 429 rate_limited, 503 busy / upstream / storage / unavailable, 500 internal; then taken.
  {
    const r = await run([null, err(409, 'pending', 3), err(429, 'rate_limited', 4), err(503, 'busy', 2), err(503, 'upstream', 5), err(503, 'storage', 6), err(500, 'internal')]);
    assert.equal(r.out.kind, 'ok'); assert.equal(r.asks, 8);
  }
  // Ran out: eight asks answered 409, then the late text; the record stays.
  {
    const r = await run(Array.from({ length: 10 }, () => err(409, 'pending', 3)));
    assert.deepEqual(r.out, { kind: 'late', text: lateText() }); assert.equal(r.asks, MAX_ASKS); assert.ok(r.record);
  }
  // A 429 whose wait reaches past the deadline: the wait is said, and a press during it sends nothing.
  {
    const r = await run([err(429, 'rate_limited', 300)]);
    assert.deepEqual(r.out, { kind: 'late', text: 'Too many tries. Try again in 5 min.' }); assert.equal(r.asks, 1);
    const press = await setUpPayment(TXN, r.p.deps);
    assert.equal(press.kind, 'late'); assert.equal(r.server.asked('/v1/pass'), 1, 'nothing sent during the cooldown');
    r.p.mono.t += 300_000;
    assert.equal((await setUpPayment(TXN, r.p.deps)).kind, 'ok', 'after it, a press asks');
  }
  // Too many keys: said, its wait becomes the cooldown, the record stays.
  {
    const r = await run([err(429, 'too_many_keys', 7_200)]);
    assert.deepEqual(r.out, { kind: 'no', text: 'This subscription was given 5 keys within a day. Use one of them, or try again in 2 h.' });
    assert.ok(r.record); assert.equal(r.p.waits.cooldownLeft(), 7_200_000);
  }
  // The server would not set Plus up for it (N3): write in with the receipt.
  for (const answer of [err(403, 'not_active', undefined, { status: 'canceled' }), err(403, 'not_paid', undefined, { status: 'draft' }), err(403, 'wrong_price'), err(403, 'no_subscription'), err(404, 'not_found')]) {
    const r = await run([answer]);
    assert.deepEqual(r.out, { kind: 'no', text: 'The payment went through, but the server would not set up Plus for it. Write to support@liquiditymapper.com with your receipt; nothing is lost.' }, JSON.stringify(answer.body));
    assert.ok(r.record);
  }
  // Turned down: 400, another 4xx, a refusal without the server's JSON.
  for (const answer of [err(400, 'bad_request'), { status: 418, body: null }, { status: 403, body: null }]) {
    const r = await run([answer]);
    assert.deepEqual(r.out, { kind: 'no', text: 'The server turned the request down. Try again later, or without a VPN or blocker.' });
  }
  // Gone: settled elsewhere before the ask; nothing is sent.
  {
    const r = await run([], { before: async (_p, b) => { b.idb.wipe(); await settle(); } });
    assert.deepEqual(r.out, { kind: 'gone' }); assert.equal(r.asks, 0);
  }
});

test('a payment\'s record waits from a day before its checkout\'s time to a day after it, both edges included, and not a millisecond more', async () => {
  const { b, server } = world(), p = await page(b, server);
  const at = b.clock.t;
  await paidIn(p);
  for (const [offset, waits] of [[-PAID_WINDOW_MS, true], [PAID_WINDOW_MS, true], [PAID_WINDOW_MS + 1, false]] as const) {
    const out = await passRequest(p.db, TXN, at + offset);
    assert.equal(out !== null && out !== 'gone', waits, String(offset));
  }
  assert.equal(b.idb.peek(`paid:${TXN}`), undefined, 'read outside its window: removed');
  b.idb.set(`paid:${TXN}`, { at });
  assert.equal(await passRequest(p.db, TXN, at - PAID_WINDOW_MS - 1), 'gone', 'a clock set back more than a day');
  // The page's list follows the same rule.
  b.idb.set(`paid:${TXN}`, { at });
  b.clock.t = at + PAID_WINDOW_MS;
  await p.paid.refresh();
  assert.equal(p.paid.list().length, 1);
  b.clock.t = at + PAID_WINDOW_MS + 1;
  assert.equal(p.paid.list().length, 0);
});

test('the receipt\'s refusal is hedged (a payment of the last few minutes may not show yet), and a pending payment meets it', async () => {
  const { b, server } = world(), p = await page(b, server);
  server.transaction(txnId('pendingone'), SUB, { invoice: '325-900', state: 'pending' });
  assert.deepEqual(await restoreBy('buyer@example.com', '325-900', p.deps), { kind: 'no', text: notFoundText() });
  assert.equal(notFoundText(), 'No subscription in good standing was found for that email and invoice number. A payment from the last few minutes may not show yet.');
  for (const lang of ['de', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'tr', 'uk', 'zh']) {
    const pack = JSON.parse(read(`src/app/i18n/${lang}.json`)) as Record<string, string>;
    assert.ok(!('No subscription in good standing was found for that email and invoice number.' in pack), `${lang}: the old refusal is retired`);
    for (const key of ['Set up Plus', notFoundText(), 'Plus could not be saved in this browser just now.', cannotHere(), 'Plus cannot be bought in this browser. Use another browser; a key bought elsewhere works here.']) assert.ok(pack[key], `${lang}: ${key}`);
  }
});

test('a tab that may not issue sends nothing: plain mode, not ready and unusable here refuse the checkout\'s ask, the receipt and a key typed in', async () => {
  // Plain mode (no IndexedDB): no attempt, no receipt; a key typed in still works.
  const b = browser(), server = new PlusServer(() => b.clock.t);
  server.subscription(SUB); server.transaction(TXN, SUB, { invoice: '325-100' });
  const plain = b.open({ db: false, post: server.post });
  assert.equal(plain.mode, 'plain');
  const waits = new TabWaits({ mono: () => 0, wall: () => b.clock.t });
  const deps: AttemptDeps = { db: null, member: plain, paid: new PaidStore(null), ask: server.ask, waits };
  assert.deepEqual(await setUpPayment(TXN, deps), { kind: 'refused', text: cannotHere() });
  assert.deepEqual(await restoreBy('buyer@example.com', '325-100', deps), { kind: 'refused', text: cannotHere() });
  assert.equal(server.log.length, 0);
  // Unusable here (the marker set, the open refused): the key typed in is refused without a request.
  const u = browser();
  u.idb.opens = 'refuse';
  u.data.set('lmf.plus.idb', '1');
  const tab = u.open({ post: server.post });
  await until(() => tab.mode === 'unusable');
  assert.deepEqual(await activateKey(derivedKey(SUB, secretOf('x')), { post: server.post, api: () => API, member: tab }), { kind: 'refused', text: cannotHere() });
  assert.deepEqual(await setUpPayment(TXN, { ...deps, db: new PlusDb(u.idb.factory, undefined, OPEN_WAIT_MS), member: tab }), { kind: 'refused', text: cannotHere() });
  assert.equal(server.log.length, 0, 'nothing sent');
});

test('source rules: nothing asked on load, the checkout opens only after a seed read, the gate builds every issuing request, accept and lmf.plus stay in pass.ts', () => {
  const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const plusDir = 'src/app/plus';
  const files = fs.readdirSync(plusDir).filter(f => f.endsWith('.ts')).map(f => ({ f, code: strip(read(`${plusDir}/${f}`)) }));
  for (const { f, code } of files) {
    if (f === 'plus-db.ts') continue;
    assert.ok(!/\/pass'|\/restore'/.test(code), `${f}: an issuing path outside the gate`);
    assert.ok(!/\bsecret\b/.test(code), `${f}: the seed sent outside the gate`);
  }
  const gate = files.find(x => x.f === 'plus-db.ts')!.code;
  assert.match(gate, /path: '\/pass', body: \{ transactionId: txn, secret: seed \}/);
  assert.match(gate, /path: '\/restore', body: \{ email, invoice, secret: seed \}/);
  // No production file outside pass.ts calls `.accept(`, and none but pass.ts writes a Plus key to localStorage.
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [path.join(dir, d.name)] : []);
  for (const file of walk('src')) {
    const rel = file.split(path.sep).join('/');
    if (rel === 'src/app/plus/pass.ts') continue;
    const code = strip(fs.readFileSync(file, 'utf8'));
    assert.ok(!/[\w)\]]\.accept\(/.test(code), `${rel}: .accept( outside pass.ts`);
    assert.ok(!/setItem\([^)]*lmf\.plus|PLUS_STORE|PLUS_GEN_STORE|PLUS_IDB_MARKER/.test(code), `${rel}: writes a Plus key`);
  }
  // The page: nothing asked by itself; the checkout opens only after this tab read the seed; the receipt form by offersReceipt.
  const page = read('src/app/plus/page.ts');
  assert.ok(!/void completed\([^)]*'resume'\)/.test(page) && !/planPayment/.test(page));
  const buy = page.slice(page.indexOf('async function buy('), page.indexOf('async function completed('));
  assert.ok(buy.indexOf('await readSeed(db)') > 0 && buy.indexOf('await readSeed(db)') < buy.indexOf('api.Checkout.open('), 'the seed read before the checkout opens');
  assert.match(buy, /if \(!seed\) \{ state\.said = \{ where: 'buy', text: cannotHere\(\) \}; render\(\); return; \}/);
  assert.match(page, /\.\.\.\(offersReceipt\(\) && member\.mode !== 'plain' \? \[/);
  // Strings 4 and 5 replace only the buying controls of an open sale: the not-on-sale page is the same in every mode.
  const notOnSale = page.slice(page.indexOf('function notOnSaleSection()'), page.indexOf('function drawTop('));
  assert.ok(notOnSale.includes('if (!plusOnSale()) {'));
  assert.ok(!/member\.mode|cannotBuy|cannotHere|member\.issues/.test(notOnSale));
  // The request timeout without AbortSignal.timeout.
  const pass = strip(read('src/app/plus/pass.ts'));
  assert.ok(!/AbortSignal\.timeout/.test(pass) && /withTimeout\(/.test(pass));
});
