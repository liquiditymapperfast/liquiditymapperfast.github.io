// The Plus database (src/app/plus/plus-db.ts, spec section 1 of the checkout recovery, 2026-11-20): opened once with a 3 s wait reported as its
// own outcome, one transaction per `tx` that resolves after its commit, atomic read-check-write across tabs, the seed made once and never kept
// in the tab, closed by an upgrade elsewhere or by the browser and opened again by the next use. Against the in-memory IndexedDB of
// tests/plus-db-fake.mts, whose own fidelity (serialised transactions, auto-commit, failures) is checked here too.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { KV_STORE, OPEN_TIMEOUT_MS, PLUS_DB, PLUS_DB_VERSION, PlusDb, PlusDbUnavailable, SEED_KEY, SEED_SHAPE, newSeed, readSeed, seedIn, type DbState } from '../src/app/plus/plus-db.ts';
import { FakeIdb, settle } from './plus-db-fake.mts';
import { PLUS_GEN_STORE, PLUS_IDB_MARKER, PLUS_STORE, storedMember, type Capture, type Plus, type StoredMember, type Taken } from '../src/app/plus/pass.ts';
import { HOUR, KEY_A, KEY_B, KEY_C, NOW, OPEN_WAIT_MS, UNTIL, browser, grantOf, passOf, slowPost, until, type Browser } from './plus-browser-double.mts';

const tab = (idb: FakeIdb): PlusDb => new PlusDb(idb.factory);
const nameOf = (error: unknown): string => (error as { name?: string }).name ?? '';

test('the database is lmf-plus, version 1, one store kv; an open answers open, error, or timeout after 3 s while it goes on', async () => {
  assert.equal(PLUS_DB, 'lmf-plus'); assert.equal(PLUS_DB_VERSION, 1); assert.equal(KV_STORE, 'kv'); assert.equal(OPEN_TIMEOUT_MS, 3_000);
  const idb = new FakeIdb(), db = tab(idb);
  assert.equal(db.state, 'closed');
  assert.equal(await db.open(), 'open');
  assert.equal(db.state, 'open');
  assert.equal(await db.open(), 'open', 'once per page: open again is the same connection');
  assert.equal(idb.opened, 1);
  assert.deepEqual(idb.keys(), [], 'the store exists and is empty');

  assert.equal(await new PlusDb(null).open(), 'error', 'no IndexedDB here (Node, blocked storage)');
  const throwing = new PlusDb({ open: () => { throw new DOMException('denied', 'SecurityError'); } });
  assert.equal(await throwing.open(), 'error', 'an open that throws');
  assert.equal(throwing.state, 'failed');

  const refusing = new FakeIdb(); refusing.opens = 'refuse';
  const r = tab(refusing);
  assert.equal(await r.open(), 'error');
  assert.equal(r.state, 'failed');
  refusing.opens = 'answer';
  assert.equal(await r.open(), 'open', 'a failed open is tried again by the next use');
});

test('an open that does not answer is reported after exactly 3 s, goes on, and its late answer opens the database for the next transaction', async () => {
  const idb = new FakeIdb(); idb.opens = 'hang';
  const db = tab(idb), seen: DbState[] = [];
  db.subscribe(state => { seen.push(state); });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let outcome: string | null = null;
    void db.open().then(o => { outcome = o; });
    await settle(3);
    mock.timers.tick(OPEN_TIMEOUT_MS - 1);
    await settle(3);
    assert.equal(outcome, null, 'not before 3 s');
    mock.timers.tick(1);
    await settle(3);
    assert.equal(outcome, 'timeout');
    assert.equal(db.state, 'opening', 'still waiting for the open\'s own answer');
  } finally { mock.timers.reset(); }
  idb.opens = 'answer'; idb.releaseOpens();
  await settle();
  assert.equal(db.state, 'open', 'the late answer opens it');
  assert.deepEqual(seen, ['opening', 'open'], 'and tells the listeners');
  assert.equal(await db.tx('readwrite', async kv => { await kv.put('x', 1); return 'ran'; }), 'ran');
  assert.equal(idb.opened, 1, 'without a second open');
});

test('a transaction that cannot get the database within its wait rejects and its body never runs, not even when the open answers later', async () => {
  const idb = new FakeIdb(); idb.opens = 'hang';
  const db = tab(idb);
  let ran = false;
  await assert.rejects(db.tx('readwrite', async kv => { ran = true; await kv.put('x', 1); }, 20), (e: unknown) => e instanceof PlusDbUnavailable && e.outcome === 'timeout');
  idb.opens = 'answer'; idb.releaseOpens();
  await settle();
  assert.equal(db.state, 'open');
  assert.equal(ran, false);
  assert.equal(idb.peek('x'), undefined, 'nothing written late');
  const refusing = new FakeIdb(); refusing.opens = 'refuse';
  await assert.rejects(tab(refusing).tx('readonly', kv => kv.get('x')), (e: unknown) => e instanceof PlusDbUnavailable && e.outcome === 'error');
});

test('tx runs its body in one transaction and resolves after the commit with its value', async () => {
  const idb = new FakeIdb(), db = tab(idb);
  const out = await db.tx('readwrite', async kv => {
    await kv.put('member', { gen: 1, held: null });
    await kv.put('paid:txn_a', { at: 5 });
    const read = await kv.get('member');
    return { read, keys: await kv.keys() };
  });
  assert.deepEqual(out, { read: { gen: 1, held: null }, keys: ['member', 'paid:txn_a'] });
  assert.deepEqual(idb.peek('member'), { gen: 1, held: null }, 'committed when tx resolved');
  await db.tx('readwrite', kv => kv.delete('paid:txn_a'));
  assert.deepEqual(idb.keys(), ['member']);
  assert.deepEqual(await db.tx('readonly', kv => kv.get('member')), { gen: 1, held: null });
  await assert.rejects(db.tx('readonly', kv => kv.put('x', 1)), (e: unknown) => nameOf(e) === 'ReadOnlyError');
  const value = { nested: [1, 2] };
  await db.tx('readwrite', kv => kv.put('clone', value));
  value.nested.push(3);
  assert.deepEqual(idb.peek('clone'), { nested: [1, 2] }, 'values are stored as copies');
});

test('a read, a check and a write in one transaction are atomic across two tabs (readwrite transactions run one at a time)', async () => {
  const idb = new FakeIdb(), a = tab(idb), b = tab(idb);
  await a.open(); await b.open();
  const bump = (db: PlusDb) => db.tx('readwrite', async kv => { const n = (await kv.get('n') as number | undefined) ?? 0; await kv.put('n', n + 1); return n + 1; });
  // Tab A is held between its read and its write; tab B's transaction starts meanwhile and must wait for A's commit.
  const held = idb.hold(info => info.tab === 1 && info.op === 'put');
  const first = bump(a);
  await held.reached;
  let secondDone = false;
  const second = bump(b).then(n => { secondDone = true; return n; });
  await settle();
  assert.equal(secondDone, false, 'B waits behind A');
  assert.equal(idb.log.filter(i => i.tab === 2).length, 0, 'B has not even read');
  held.release();
  assert.deepEqual([await first, await second], [1, 2], 'no update lost');
  assert.equal(idb.peek('n'), 2);
  // Readonly transactions do not wait for each other.
  const slow = idb.hold(info => info.tab === 1 && info.op === 'get');
  const r1 = a.tx('readonly', kv => kv.get('n'));
  await slow.reached;
  assert.equal(await b.tx('readonly', kv => kv.get('n')), 2, 'a second reader runs beside a held one');
  slow.release();
  assert.equal(await r1, 2);
});

test('two tabs creating the seed at once end with one seed; it is 43 characters of base64url and read again every time, never kept', async () => {
  const idb = new FakeIdb(), a = tab(idb), b = tab(idb);
  await a.open(); await b.open();
  const held = idb.hold(info => info.tab === 1 && info.op === 'put' && info.key === SEED_KEY);
  const fromA = readSeed(a);
  await held.reached;
  const fromB = readSeed(b);
  await settle();
  held.release();
  const [sa, sb] = [await fromA, await fromB];
  assert.match(sa, SEED_SHAPE);
  assert.equal(sa.length, 43);
  assert.equal(sb, sa, 'B found A\'s seed');
  assert.equal(idb.peek(SEED_KEY), sa);
  assert.equal(idb.log.filter(i => i.op === 'put' && i.key === SEED_KEY).length, 1, 'only one was ever written');
  assert.equal(await readSeed(a), sa, 'stable while the database lasts');

  // A reset (site data cleared): the next read in the same tab, which never kept the old one, makes a new seed.
  idb.wipe();
  await settle();
  assert.equal(a.state, 'closed', 'the browser closed the connection');
  const after = await readSeed(a);
  assert.match(after, SEED_SHAPE);
  assert.notEqual(after, sa, 'a new seed, not one remembered by the tab');
  assert.equal(await readSeed(b), after, 'the other tab reads the new one too');

  // Inside a caller's transaction, and a stored value of another shape replaced.
  idb.set(SEED_KEY, 'too-short');
  const made = await a.tx('readwrite', async kv => ({ seed: await seedIn(kv), member: await kv.get('member') }));
  assert.match(made.seed, SEED_SHAPE);
  assert.equal(idb.peek(SEED_KEY), made.seed);
  assert.equal(newSeed(bytes => bytes.fill(255)), Buffer.alloc(32, 255).toString('base64url'), '32 bytes, base64url, no padding');
});

test('an upgrade elsewhere closes the connection, and the next use opens it again; so does the browser closing it', async () => {
  const idb = new FakeIdb(), db = tab(idb), seen: DbState[] = [];
  await db.tx('readwrite', kv => kv.put('member', { gen: 3, held: null }));
  db.subscribe(state => { seen.push(state); });
  assert.equal(idb.versionChange(), 0, 'it closed its connection');
  assert.equal(db.state, 'closed');
  assert.deepEqual(await db.tx('readonly', kv => kv.get('member')), { gen: 3, held: null }, 'the next use reopens');
  assert.equal(idb.opened, 2);
  assert.deepEqual(seen, ['closed', 'opening', 'open']);

  // A transaction under way when the upgrade is announced still completes.
  const held = idb.hold(info => info.op === 'put');
  const running = db.tx('readwrite', kv => kv.put('member', { gen: 4, held: null }));
  await held.reached;
  idb.versionChange();
  held.release();
  await running;
  assert.deepEqual(idb.peek('member'), { gen: 4, held: null });

  // The browser closes it (site data cleared): its transaction aborts, the next use opens a new, empty database.
  await db.open();
  const cut = idb.hold(info => info.op === 'put');
  const lost = db.tx('readwrite', kv => kv.put('member', { gen: 5, held: null }));
  await cut.reached;
  idb.wipe();
  cut.release();
  await assert.rejects(lost, (e: unknown) => nameOf(e) === 'AbortError');
  await settle();
  assert.equal(db.state, 'closed');
  assert.equal(await db.tx('readonly', kv => kv.get('member')), undefined, 'a new database');
  // `transaction()` throwing before the `close` arrives: opened again once.
  await db.open();
  idb.wipe();
  assert.equal(await db.tx('readwrite', async kv => { await kv.put('x', 1); return 'again'; }), 'again', 'reopened at once');
});

test('a failed or aborted transaction writes nothing and rejects with its error', async () => {
  const idb = new FakeIdb(), db = tab(idb);
  await db.tx('readwrite', kv => kv.put('member', { gen: 1 }));
  const write = (fn?: () => void) => db.tx('readwrite', async kv => { await kv.put('member', { gen: 2 }); fn?.(); await kv.put('paid:txn_a', { at: 1 }); });

  idb.failNextPut('QuotaExceededError');
  await assert.rejects(write(), (e: unknown) => nameOf(e) === 'QuotaExceededError', 'a put refused for quota');
  idb.failNextPut('UnknownError');
  await assert.rejects(db.tx('readwrite', async kv => { await kv.put('member', { gen: 2 }); }), (e: unknown) => nameOf(e) === 'UnknownError', 'another error keeps its name');
  // The body catching the request's error does not save the transaction.
  idb.failNextPut();
  await assert.rejects(db.tx('readwrite', async kv => { try { await kv.put('member', { gen: 2 }); } catch { /* ignored */ } return 'swallowed'; }), (e: unknown) => nameOf(e) === 'QuotaExceededError');
  idb.failNextCommit('QuotaExceededError');
  await assert.rejects(write(), (e: unknown) => nameOf(e) === 'QuotaExceededError', 'quota found at commit');
  idb.failNextCommit('AbortError');
  await assert.rejects(write(), (e: unknown) => nameOf(e) === 'AbortError', 'aborted by the browser');
  const mine = new Error('changed my mind');
  await assert.rejects(write(() => { throw mine; }), (e: unknown) => e === mine, 'the body\'s own throw aborts it');
  await assert.rejects(db.tx('readwrite', () => { throw mine; }), (e: unknown) => e === mine, 'a synchronous throw too');
  assert.deepEqual(idb.peek('member'), { gen: 1 }, 'nothing was written by any of them');
  assert.deepEqual(idb.keys(), ['member']);
  assert.deepEqual(await db.tx('readonly', kv => kv.get('member')), { gen: 1 }, 'and the database still works');
});

test('the stand-in commits by itself when nothing is pending: a request after an awaited timer is refused, as in a browser', async () => {
  const idb = new FakeIdb(), db = tab(idb);
  await assert.rejects(db.tx('readwrite', async kv => {
    await kv.put('a', 1);
    await new Promise(resolve => { setTimeout(resolve, 5); });
    await kv.put('b', 2);
  }), (e: unknown) => nameOf(e) === 'TransactionInactiveError');
  assert.equal(idb.peek('a'), 1, 'what came before had committed');
  assert.equal(idb.peek('b'), undefined);
  // A chain of IDB requests through awaits keeps it active.
  await db.tx('readwrite', async kv => { for (let i = 0; i < 5; i++) await kv.put(`k${i}`, (await kv.get(`k${i - 1}`) as number | undefined ?? 0) + 1); });
  assert.equal(idb.peek('k4'), 5);
});

// ---- The membership on the database (src/app/plus/pass.ts, spec sections 2.1-2.4) ----

const memberIn = (idb: FakeIdb): StoredMember => storedMember(idb.peek('member'));
const keyIn = (idb: FakeIdb): string | null => memberIn(idb).held?.key ?? null;
const capOf = async (t: Plus): Promise<Capture> => { const c = await t.capture(); assert.ok(c !== null && typeof c !== 'number', 'a capture'); return c as Capture; };
const take = async (t: Plus, key: string, settle: string[] = [], exp?: number): Promise<Taken> => t.acceptIf(await capOf(t), grantOf(key, exp), settle);
/** A browser whose first tab is in IDB mode (the database opened, the marker written, the import run), with its seed made unless not `seeded`. */
async function idbBrowser(seeded = true): Promise<{ b: Browser; a: Plus }> {
  const b = browser(), a = b.open();
  await until(() => a.mode === 'idb');
  if (seeded) await readSeed(new PlusDb(b.idb.factory));
  return { b, a };
}

test('a browser moves to its database once: the marker first, then the import of today\'s stored shape, a gift kept whole', async () => {
  const b = browser();
  const gift = { v: 1, key: KEY_A, pass: passOf('gift_aaaa', NOW + 20 * HOUR), until: UNTIL, ended: false, why: '', renews: false, skew: 120_000, next: NOW + 60_000 };
  b.data.set(PLUS_STORE, JSON.stringify(gift)); b.data.set(PLUS_GEN_STORE, '7');
  const a = b.open();
  assert.equal(a.mode, 'opening', 'every tab starts by opening');
  assert.equal(a.state, 'on', 'the mirror shows the membership at once');
  await until(() => a.mode === 'idb');
  assert.equal(b.data.get(PLUS_IDB_MARKER), '1');
  assert.ok(b.writes.indexOf(PLUS_IDB_MARKER) === 0, 'the marker was the first write');
  const { v: _v, ...held } = gift;
  assert.deepEqual(memberIn(b.idb), { gen: 7, held }, 'imported whole: key, pass, until, ended, why, renews, skew, next');
  assert.equal(b.idb.peek('migrated'), true);
  assert.equal(a.state, 'on'); assert.equal(a.key, KEY_A); assert.equal(a.renews, false);
  // A second tab finds the browser moved already and imports nothing again.
  b.data.set(PLUS_STORE, JSON.stringify({ ...gift, key: KEY_C }));
  const c = b.open();
  await until(() => c.mode === 'idb');
  assert.equal(c.key, KEY_A, 'the database is the authority, not the mirror');
  assert.equal(b.mirrorKey(), KEY_A, 'and the mirror is repaired');
});

test('a marker that cannot be written leaves a tab in plain mode with nothing imported; once migrated, it never goes back to plain', async () => {
  const b = browser();
  b.data.set(PLUS_STORE, JSON.stringify({ v: 1, key: KEY_A, pass: passOf('gift_aaaa', NOW + 20 * HOUR), until: UNTIL }));
  b.refuse = key => key === PLUS_IDB_MARKER;
  const a = b.open();
  await until(() => a.mode !== 'opening');
  assert.equal(a.mode, 'plain');
  assert.equal(b.idb.peek('migrated'), undefined, 'nothing imported');
  assert.equal(b.idb.peek('member'), undefined);
  assert.equal(a.issues, false); assert.equal(a.takesKeys, true, 'plain mode takes keys as today');

  // Migrated, then `localStorage` cleared alone: IDB mode at once, the marker written again, and while it fails, retried at each commit.
  b.refuse = null;
  const { b: m, a: first } = await idbBrowser();
  assert.equal(await take(first, KEY_B), 'kept');
  m.data.clear();
  m.refuse = key => key === PLUS_IDB_MARKER;
  const again = m.open();
  await until(() => again.mode !== 'opening');
  assert.equal(again.mode, 'idb', 'a failed marker write never demotes a migrated browser');
  assert.equal(again.key, KEY_B);
  m.refuse = null;
  assert.equal(await again.forget(), 'kept');
  assert.equal(m.data.get(PLUS_IDB_MARKER), '1', 'written again after a commit');
});

test('both half-states: a marker with no finished import runs the import; a migrated browser with no marker writes it again', async () => {
  const b = browser();
  b.data.set(PLUS_IDB_MARKER, '1');
  b.data.set(PLUS_STORE, JSON.stringify({ v: 1, key: KEY_A, pass: passOf('gift_aaaa', NOW + 20 * HOUR), until: UNTIL }));
  b.data.set(PLUS_GEN_STORE, '2');
  const a = b.open();
  await until(() => a.mode === 'idb');
  assert.deepEqual([memberIn(b.idb).gen, keyIn(b.idb), b.idb.peek('migrated')], [2, KEY_A, true]);

  // A storage that cannot be read while importing: nothing is set (the next load runs it again).
  const u = browser();
  u.data.set(PLUS_STORE, JSON.stringify({ v: 1, key: KEY_A, pass: passOf('gift_aaaa', NOW + 20 * HOUR), until: UNTIL }));
  const t = u.open();
  u.unreadable = true;
  await until(() => t.mode !== 'opening');
  assert.notEqual(t.mode, 'idb');
  assert.equal(u.idb.peek('migrated'), undefined, 'migrated is not set');
  assert.equal(u.idb.peek('member'), undefined);
});

test('not ready and unusable here: the mirror shows Plus at once, renews in memory only, takes no key and writes nothing', async () => {
  // Unusable here: the marker set, the open refused.
  const b = browser();
  b.idb.opens = 'refuse';
  b.data.set(PLUS_IDB_MARKER, '1');
  b.data.set(PLUS_STORE, JSON.stringify({ v: 1, key: KEY_A, pass: passOf('gift_aaaa', NOW + 2 * HOUR), until: UNTIL }));
  const server = slowPost();
  const a = b.open({ post: server.post });
  assert.equal(a.state, 'on', 'Plus on at once from the mirror');
  await until(() => a.mode === 'unusable');
  assert.equal(a.issues, false); assert.equal(a.takesKeys, false);
  assert.equal(await a.capture(), null, 'no operation begins');
  assert.equal(await a.acceptIf(null, grantOf(KEY_B)), 'refused');
  assert.equal(await a.acceptIf(0, grantOf(KEY_B)), 'stale', 'a plain capture is not taken here');
  assert.equal(await a.forget(), 'refused', 'nor is the key removed');
  const before = b.writes.length;
  a.pass();
  await until(() => server.asked.length === 1);
  server.asked[0]!.answer({ status: 200, body: { pass: passOf('gift_aaaa', NOW + 24 * HOUR), paidUntil: UNTIL, now: NOW } });
  await settleTasks();
  assert.equal(a.state, 'on'); assert.equal(a.key, KEY_A);
  assert.ok(a.pass()!.length > 0 && a.pass() !== passOf('gift_aaaa', NOW + 2 * HOUR), 'renewed in memory');
  assert.equal(b.writes.length, before, 'nothing written, not even the mirror');
  assert.equal(b.mirrorKey(), KEY_A);

  // Not ready: the marker set, the open hangs; the late open adopts the stored membership and applies the later memory pass by one commit.
  const n = browser();
  const { a: seeded } = await (async () => { const t = n.open(); await until(() => t.mode === 'idb'); return { a: t }; })();
  assert.equal(await take(seeded, KEY_A, [], NOW + 2 * HOUR), 'kept');
  n.idb.opens = 'hang';
  const late = slowPost();
  const slow = n.open({ post: late.post });
  // The open's wait (OPEN_WAIT_MS) runs on real time.
  await new Promise(resolve => { setTimeout(resolve, OPEN_WAIT_MS * 3); });
  await until(() => slow.mode === 'notready');
  slow.pass();
  await until(() => late.asked.length === 1);
  late.asked[0]!.answer({ status: 200, body: { pass: passOf('gift_aaaa', NOW + 24 * HOUR), paidUntil: UNTIL, now: NOW } });
  await settleTasks();
  assert.equal(memberIn(n.idb).held?.pass, passOf('gift_aaaa', NOW + 2 * HOUR), 'nothing stored while not ready');
  n.idb.opens = 'answer'; n.idb.releaseOpens();
  await until(() => slow.mode === 'idb');
  await until(() => memberIn(n.idb).held?.pass === passOf('gift_aaaa', NOW + 24 * HOUR));
  assert.equal(memberIn(n.idb).gen, 1, 'the same key: no new generation');
});
async function settleTasks(): Promise<void> { for (let i = 0; i < 60; i++) await new Promise(r => { setImmediate(r); }); }

test('opening without a marker: a slow open keeps the tab opening (no key taken), and its late answer brings IDB mode', async () => {
  const b = browser();
  b.idb.opens = 'hang';
  const a = b.open();
  await settleTasks();
  assert.equal(a.mode, 'opening');
  assert.equal(a.takesKeys, false);
  assert.equal(await a.capture(), null);
  b.idb.opens = 'answer'; b.idb.releaseOpens();
  await until(() => a.mode === 'idb');
  assert.equal(b.data.get(PLUS_IDB_MARKER), '1');
});

test('a plain tab that finds the marker before a write writes nothing and selects its mode again (unusable here when its open fails)', async () => {
  const b = browser();
  b.idb.opens = 'refuse';
  const a = b.open();
  await until(() => a.mode === 'plain');
  const gen = a.generation();
  b.data.set(PLUS_IDB_MARKER, '1');
  const before = b.writes.length;
  const out = a.acceptIf(gen, grantOf(KEY_B));
  assert.ok(out instanceof Promise, 'not taken at once');
  assert.equal(await out, 'refused');
  assert.equal(a.mode, 'unusable');
  assert.equal(b.writes.length, before, 'nothing written');
  assert.equal(a.key, null);
  // Its database opening now: the grant is taken as a new operation.
  const c = browser();
  c.idb.opens = 'refuse';
  const p = c.open();
  await until(() => p.mode === 'plain');
  c.data.set(PLUS_IDB_MARKER, '1');
  c.idb.opens = 'answer';
  assert.equal(await p.acceptIf(p.generation(), grantOf(KEY_B)), 'kept');
  assert.equal(p.mode, 'idb');
  assert.equal(keyIn(c.idb), KEY_B);
});

test('commit guards: an answer from before a reset is stale even for the same key; the same-key exception keeps the member and only a later pass', async () => {
  const { b, a } = await idbBrowser();
  await readSeed(new PlusDb(b.idb.factory));
  const before = await capOf(a);
  b.idb.wipe();
  await settleTasks();
  // The browser's data cleared while the answer was on its way: a new seed is made, and the old answer is never taken.
  await readSeed(new PlusDb(b.idb.factory));
  assert.equal(await a.acceptIf(before, grantOf(KEY_A)), 'stale');
  assert.equal(keyIn(b.idb), null);

  // Same seed, another generation: another tab took the same key meanwhile; this grant counts as taken and applies only a later pass.
  const { b: s, a: one } = await idbBrowser();
  const two = s.open();
  await until(() => two.mode === 'idb');
  const capOne = await capOf(one);
  assert.equal(await take(two, KEY_A, [], NOW + 24 * HOUR), 'kept');
  const genAfter = memberIn(s.idb).gen;
  assert.equal(await one.acceptIf(capOne, grantOf(KEY_A, NOW + 20 * HOUR)), 'kept', 'the same key counts as taken');
  assert.equal(memberIn(s.idb).held?.pass, passOf('gift_aaaa', NOW + 24 * HOUR), 'an earlier pass is not applied');
  assert.equal(memberIn(s.idb).gen, genAfter, 'the member kept as it is');
  const capLater = await capOf(one);
  assert.equal(await take(two, KEY_B), 'kept');
  assert.equal(await take(two, KEY_A), 'kept');
  assert.equal(await one.acceptIf(capLater, grantOf(KEY_A, NOW + 30 * HOUR)), 'kept');
  assert.equal(memberIn(s.idb).held?.pass, passOf('gift_aaaa', NOW + 30 * HOUR), 'a later pass is applied');
  // A different key at another generation is stale.
  const capOld = await capOf(one);
  assert.equal(await take(two, KEY_C), 'kept');
  assert.equal(await one.acceptIf(capOld, grantOf(KEY_B)), 'stale');
  assert.equal(keyIn(s.idb), KEY_C);
  await until(() => one.key === KEY_C);
});

test('commit: two grants at one generation, one kept and one stale; Remove against a grant either way; a renewal for an old key writes nothing over a newer one', async () => {
  const { b, a } = await idbBrowser();
  const c = b.open();
  await until(() => c.mode === 'idb');
  const [ca, cc] = [await capOf(a), await capOf(c)];
  const outs = await Promise.all([a.acceptIf(ca, grantOf(KEY_A), ['txn_a']), c.acceptIf(cc, grantOf(KEY_B), ['txn_b'])]);
  assert.deepEqual([...outs].sort(), ['kept', 'stale']);

  // Remove between another tab's capture and its commit: the grant is stale and Remove holds; then the reverse.
  const capGrant = await capOf(c);
  assert.equal(await a.forget(), 'kept');
  assert.equal(await c.acceptIf(capGrant, grantOf(KEY_C)), 'stale');
  assert.equal(keyIn(b.idb), null);
  assert.equal(await take(c, KEY_C), 'kept');
  await until(() => a.key === KEY_C);
  const capRemove = await capOf(a);
  assert.equal(await take(c, KEY_B), 'kept');
  void capRemove;
  assert.equal(await a.forget(), 'kept', 'Remove captured after: it removes the key in force');
  assert.equal(keyIn(b.idb), null);

  // A renewal answer for the old key when a newer key was committed meanwhile.
  const server = slowPost();
  const r = b.open({ post: server.post });
  await until(() => r.mode === 'idb');
  assert.equal(await take(r, KEY_A, [], NOW + 2 * HOUR), 'kept');
  r.pass();
  await until(() => server.asked.length === 1);
  assert.equal(await take(c, KEY_B), 'kept');
  server.asked[0]!.answer({ status: 200, body: { pass: passOf('gift_aaaa', NOW + 24 * HOUR), paidUntil: UNTIL, now: NOW } });
  await settleTasks();
  assert.equal(keyIn(b.idb), KEY_B, 'never overwritten');
  assert.equal(r.key, KEY_B);
});

test('settlement: a kept grant removes the payments it names in the same transaction; a failed one removes nothing', async () => {
  const { b, a } = await idbBrowser();
  b.idb.set('paid:txn_a', { at: NOW }); b.idb.set('paid:txn_b', { at: NOW });
  assert.equal(await take(a, KEY_A, ['txn_a']), 'kept');
  assert.deepEqual(b.idb.keys().filter(k => k.startsWith('paid:')), ['paid:txn_b']);
  b.idb.failNextPut('UnknownError');
  assert.equal(await take(a, KEY_B, ['txn_b']), 'unkept');
  assert.deepEqual(b.idb.keys().filter(k => k.startsWith('paid:')), ['paid:txn_b'], 'kept with the membership that failed');
});

test('the overlay: a commit that fails holds the key in this tab; Try again stores it without a request and settles; quota or not', async () => {
  const { b, a } = await idbBrowser();
  b.idb.set('paid:txn_a', { at: NOW });
  b.idb.failNextCommit('QuotaExceededError');
  assert.equal(await take(a, KEY_A, ['txn_a']), 'unkept');
  assert.equal(a.state, 'on'); assert.equal(a.key, KEY_A, 'the buyer sees Plus and the key');
  assert.equal(a.unstored, true); assert.equal(a.saveFailed, false, 'a full storage: no Try again');
  assert.equal(keyIn(b.idb), null, 'nothing stored');
  assert.ok(b.idb.peek('paid:txn_a'), 'the record stays');
  b.idb.failNextCommit('UnknownError');
  assert.equal(await a.keepAgain(), 'unkept');
  assert.equal(a.saveFailed, true, 'another failure: Try again offered');
  assert.equal(await a.keepAgain(), 'kept');
  assert.equal(a.unstored, false);
  assert.equal(keyIn(b.idb), KEY_A);
  assert.equal(b.idb.peek('paid:txn_a'), undefined, 'settled with it');
  assert.equal(b.mirrorKey(), KEY_A);
});

test('the overlay\'s two guards: a key answer captured before the overlay changed is stale on the revision, which never resets', async () => {
  const { b, a } = await idbBrowser();
  const early = await capOf(a);
  b.idb.failNextCommit('UnknownError');
  assert.equal(await take(a, KEY_A), 'unkept');
  assert.equal(await a.acceptIf(early, grantOf(KEY_B)), 'stale', 'captured before the overlay came');
  // A key entered while the overlay exists commits against its baseline and replaces it.
  assert.equal(await take(a, KEY_C), 'kept');
  assert.equal(a.unstored, false);
  assert.equal(keyIn(b.idb), KEY_C);
  // An overlay that came and went: the store looks unchanged for a grant captured before it, yet the revision refuses it.
  const { b: s, a: t } = await idbBrowser();
  const before = await capOf(t);
  s.idb.failNextCommit('UnknownError');
  assert.equal(await t.forget(), 'unkept', 'an unstored Remove');
  assert.equal(t.unstored, true); assert.equal(t.state, 'none', 'holds "none"');
  assert.equal(await t.keepAgain(), 'kept');
  assert.equal(await t.acceptIf(before, grantOf(KEY_B)), 'stale');
  assert.equal(keyIn(s.idb), null);
});

test('the overlay goes when another tab commits; a renewal of the overlay\'s key writes nothing', async () => {
  const { b, a } = await idbBrowser();
  const server = slowPost();
  const r = b.open({ post: server.post });
  await until(() => r.mode === 'idb');
  b.idb.failNextCommit('UnknownError');
  assert.equal(await take(r, KEY_A, [], NOW + 2 * HOUR), 'unkept');
  const writes = b.writes.length, puts = b.idb.log.filter(i => i.op === 'put').length;
  r.pass();
  await until(() => server.asked.length === 1);
  server.asked[0]!.answer({ status: 200, body: { pass: passOf('gift_aaaa', NOW + 24 * HOUR), paidUntil: UNTIL, now: NOW } });
  await settleTasks();
  assert.equal(r.unstored, true); assert.equal(r.key, KEY_A);
  assert.equal(r.pass(), passOf('gift_aaaa', NOW + 24 * HOUR), 'renewed in memory');
  assert.equal(b.writes.length, writes); assert.equal(b.idb.log.filter(i => i.op === 'put').length, puts, 'no write at all');
  assert.equal(await take(a, KEY_B), 'kept');
  await until(() => !r.unstored);
  assert.equal(r.key, KEY_B, 'the other tab\'s act was later');
});

test('a previous build\'s write to localStorage: another key or a removal is not adopted and the mirror is repaired; a later pass for the same key is', async () => {
  const { b, a } = await idbBrowser();
  const c = b.open();
  await until(() => c.mode === 'idb');
  assert.equal(await take(a, KEY_A, [], NOW + 2 * HOUR), 'kept');
  await until(() => b.mirrorKey() === KEY_A && c.key === KEY_A);
  const old = (held: object): void => { b.data.set(PLUS_STORE, JSON.stringify(held)); b.tabs.forEach(t => { t.mirrorChanged(); }); };
  old({ v: 1, key: KEY_C, pass: passOf('gift_cccc', NOW + 24 * HOUR), until: UNTIL });
  await until(() => b.mirrorKey() === KEY_A);
  assert.equal(keyIn(b.idb), KEY_A); assert.equal(a.key, KEY_A);
  b.data.delete(PLUS_STORE); b.tabs.forEach(t => { t.mirrorChanged(); });
  await until(() => b.mirrorKey() === KEY_A);
  assert.equal(keyIn(b.idb), KEY_A, 'a removal is not adopted either');
  old({ v: 1, key: KEY_A, pass: passOf('gift_aaaa', NOW + 24 * HOUR), until: UNTIL + 1, ended: true, why: 'canceled' });
  await until(() => memberIn(b.idb).held?.pass === passOf('gift_aaaa', NOW + 24 * HOUR));
  assert.deepEqual([memberIn(b.idb).held?.ended, memberIn(b.idb).held?.why, memberIn(b.idb).held?.until], [false, '', UNTIL + 1], 'adopted, ended and why cleared');
});

test('the mirror stops: tabs answering each other\'s storage events write nothing more once it matches the database', async () => {
  const { b, a } = await idbBrowser();
  const c = b.open(), d = b.open();
  await until(() => c.mode === 'idb' && d.mode === 'idb');
  assert.equal(await take(a, KEY_A), 'kept');
  await settleTasks();
  const writes = b.writes.length;
  await settleTasks();
  assert.equal(b.writes.length, writes, 'no ping-pong');
  assert.ok([a, c, d].every(t => t.key === KEY_A));
});

test('a renewal is reserved inside a transaction: two tabs renewing at once send one request', async () => {
  const { b, a } = await idbBrowser();
  assert.equal(await take(a, KEY_A, [], NOW + 2 * HOUR), 'kept');
  const server = slowPost();
  const x = b.open({ post: server.post }), y = b.open({ post: server.post });
  await until(() => x.mode === 'idb' && y.mode === 'idb' && x.key === KEY_A && y.key === KEY_A);
  x.pass(); y.pass();
  await settleTasks();
  assert.equal(server.asked.length, 1, 'one renewal a minute across tabs');
  server.asked[0]!.answer({ status: 200, body: { pass: passOf('gift_aaaa', NOW + 24 * HOUR), paidUntil: UNTIL, now: NOW } });
  await until(() => y.pass() === passOf('gift_aaaa', NOW + 24 * HOUR));
  assert.equal(memberIn(b.idb).held?.pass, passOf('gift_aaaa', NOW + 24 * HOUR));
});

test('plain mode stays as it was: synchronous key entry, Remove and renewal, and no database is touched', async () => {
  const b = browser();
  const a = b.open({ db: false });
  assert.equal(a.mode, 'plain');
  assert.equal(a.capture(), 0, 'a number, at once');
  assert.equal(a.acceptIf(a.generation(), grantOf(KEY_A)), 'kept', 'synchronous');
  assert.equal(a.key, KEY_A); assert.equal(b.mirrorKey(), KEY_A);
  assert.equal(a.forget(), undefined, 'Remove is synchronous');
  assert.equal(a.key, null);
  assert.equal(b.idb.opened, 0);
  // Marked but without IndexedDB: unusable here at once.
  b.data.set(PLUS_IDB_MARKER, '1');
  assert.equal(b.open({ db: false }).mode, 'unusable');
});

test('a refusal another tab stored stands: a pass this tab only read from the store is never written back over it', async () => {
  for (const how of ['ended', 'refused'] as const) {
    const { b, a } = await idbBrowser();
    assert.equal(await take(a, KEY_A, [], NOW + 2 * HOUR), 'kept');
    const server = slowPost();
    const x = b.open({ post: server.post }), y = b.open();
    await until(() => x.mode === 'idb' && y.mode === 'idb' && x.key === KEY_A && y.key === KEY_A);
    if (how === 'ended') {
      x.pass();
      await until(() => server.asked.length === 1);
      server.asked[0]!.answer({ status: 403, body: { error: 'not_active', status: 'canceled' } });
      await until(() => memberIn(b.idb).held?.ended === true);
    } else {
      x.refused(passOf('gift_aaaa', NOW + 2 * HOUR));
      await until(() => memberIn(b.idb).held?.pass === '');
    }
    await settleTasks(); await settleTasks();
    assert.equal(memberIn(b.idb).held?.pass, '', `${how}: the stored refusal stands`);
    if (how === 'ended') { assert.equal(memberIn(b.idb).held?.ended, true); await until(() => y.state === 'ended' && a.state === 'ended'); }
    else await until(() => y.pass() === null && a.pass() === null);
    assert.equal(b.mirrorKey(), KEY_A);
  }
});

// ---- Sol's code review C1 (2026-11-20), each finding's scenario ----

const giftMirror = (exp: number): string => JSON.stringify({ v: 1, key: KEY_A, pass: passOf('gift_aaaa', exp), until: UNTIL, ended: false, why: '', renews: false, skew: 0, next: 0 });
const realWait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

test('C1-1: an unmarked tab whose open never answers renews the key it shows in memory after the open wait; a late open stores that pass', async () => {
  const b = browser();
  b.idb.opens = 'hang';
  b.data.set(PLUS_STORE, giftMirror(NOW + 2 * HOUR));
  const server = slowPost();
  const t = b.open({ post: server.post });
  await realWait(OPEN_WAIT_MS * 3);
  assert.equal(t.mode, 'opening', 'no marker: still opening');
  // (a) the pass near its end: a renewal goes, and Plus stays on.
  t.pass();
  await until(() => server.asked.length === 1);
  const fresh = passOf('gift_aaaa', NOW + 24 * HOUR);
  server.asked[0]!.answer({ status: 200, body: { pass: fresh, paidUntil: UNTIL, now: NOW } });
  await until(() => t.pass() === fresh);
  assert.equal(t.state, 'on');
  assert.equal(JSON.parse(b.data.get(PLUS_STORE)!).pass, passOf('gift_aaaa', NOW + 2 * HOUR), 'nothing written');
  assert.equal(t.takesKeys, false); assert.equal(t.issues, false);
  assert.equal(await t.capture(), null, 'no key entry');
  assert.equal(await t.forget(), 'refused', 'no Remove');
  // (b) the open answers late: the memory pass lands in the database and the mirror.
  b.idb.opens = 'answer'; b.idb.releaseOpens();
  await until(() => t.mode === 'idb');
  await until(() => memberIn(b.idb).held?.pass === fresh);
  await until(() => JSON.parse(b.data.get(PLUS_STORE)!).pass === fresh);
});

test('C1-1: a renewal asked while the first open is awaited is honoured once the mode settles (the open answering, or its wait running out)', async () => {
  for (const how of ['answers', 'hangs'] as const) {
    const b = browser();
    b.idb.opens = 'hang';
    b.data.set(PLUS_STORE, giftMirror(NOW + 2 * HOUR));
    const server = slowPost();
    const t = b.open({ post: server.post });
    t.pass();
    await settleTasks();
    assert.equal(server.asked.length, 0, `${how}: nothing yet`);
    if (how === 'answers') { b.idb.opens = 'answer'; b.idb.releaseOpens(); await until(() => t.mode === 'idb'); } else await realWait(OPEN_WAIT_MS * 3);
    await until(() => server.asked.length === 1);
  }
});

test('C1-2: a membership read that fails while entering is tried again; it never shows "none" over a stored gift in IDB mode', async () => {
  const { b, a } = await idbBrowser();
  assert.equal(await take(a, KEY_A), 'kept');
  b.data.delete(PLUS_STORE); b.data.delete(PLUS_GEN_STORE);
  b.idb.fail(info => info.mode === 'readonly' && info.op === 'get' && info.key === 'member', 'UnknownError', 1);
  const c = b.open();
  await until(() => c.mode !== 'opening');
  assert.equal(c.mode, 'idb');
  assert.equal(c.key, KEY_A, 'the stored gift, read again');
  // A read that keeps failing: unusable here, never IDB mode with nothing shown.
  b.data.delete(PLUS_STORE);
  b.idb.fail(info => info.mode === 'readonly' && info.op === 'get' && info.key === 'member', 'UnknownError', 10);
  const d = b.open();
  await until(() => d.mode !== 'opening');
  assert.equal(d.mode, 'unusable');
});

test('C1-3: Try again on an overlay while its renewal answers keeps the fresh pass (stored, and Plus still on ten minutes later)', async () => {
  const { b } = await idbBrowser();
  const server = slowPost();
  const r = b.open({ post: server.post });
  await until(() => r.mode === 'idb');
  b.idb.failNextCommit('UnknownError');
  assert.equal(await take(r, KEY_A, [], NOW + 5 * 60_000), 'unkept', 'an overlay whose pass runs out in five minutes');
  r.pass();
  await until(() => server.asked.length === 1);
  const paused = b.idb.hold(info => info.op === 'put' && info.key === 'member');
  const saving = r.keepAgain();
  await paused.reached;
  const fresh = passOf('gift_aaaa', NOW + 2 * HOUR);
  server.asked[0]!.answer({ status: 200, body: { pass: fresh, paidUntil: UNTIL, now: NOW } });
  await settleTasks();
  paused.release();
  assert.equal(await saving, 'kept');
  await until(() => memberIn(b.idb).held?.pass === fresh && r.pass() === fresh);
  b.clock.t += 10 * 60_000;
  assert.equal(r.state, 'on', 'ten minutes later Plus is on');
  assert.equal(r.pass(), fresh);
});

test('C1-4: Try again after a renewal answered 429 Retry-After 600 asks again at once (the tab\'s wait cleared too)', async () => {
  const { b, a } = await idbBrowser();
  assert.equal(await take(a, KEY_A, [], NOW + 2 * HOUR), 'kept');
  const server = slowPost();
  const r = b.open({ post: server.post });
  await until(() => r.mode === 'idb' && r.key === KEY_A);
  r.pass();
  await until(() => server.asked.length === 1);
  server.asked[0]!.answer({ status: 429, body: { error: 'rate_limited' }, retryAfter: 600 });
  await until(() => r.unverified);
  r.retry();
  await until(() => server.asked.length === 2);
});

test('C1-5: an old build\'s newer same-key pass is adopted even when a mirror repair was queued before its event', async () => {
  const { b, a } = await idbBrowser();
  assert.equal(await take(a, KEY_A, [], NOW + 2 * HOUR), 'kept');
  const y = b.open();
  await until(() => y.mode === 'idb' && y.key === KEY_A);
  b.events = false;
  const paused = b.idb.hold(info => info.mode === 'readonly' && info.op === 'get' && info.key === 'member');
  y.reload();
  await paused.reached;
  const newer = giftMirror(NOW + 24 * HOUR);
  b.data.set(PLUS_STORE, newer);
  y.mirrorChanged(newer);
  paused.release();
  await until(() => memberIn(b.idb).held?.pass === passOf('gift_aaaa', NOW + 24 * HOUR));
  await until(() => JSON.parse(b.data.get(PLUS_STORE)!).pass === passOf('gift_aaaa', NOW + 24 * HOUR));
});

test('C1-6: every operation has an epoch: a key answer captured before the site data was cleared is stale even where no seed existed', async () => {
  const { b, a } = await idbBrowser(false);
  assert.equal(b.idb.peek(SEED_KEY), undefined, 'no seed was ever made');
  const cap = await capOf(a);
  assert.match(String(b.idb.peek(SEED_KEY)), SEED_SHAPE, 'the capture made one');
  b.idb.wipe();
  await settleTasks();
  assert.equal(await a.acceptIf(cap, grantOf(KEY_A)), 'stale');
  assert.equal(keyIn(b.idb), null);
});

test('C1-7 (the exception): a tab whose reservation write fails still renews, at most once a minute, beside the storing tabs\' once a minute', async () => {
  const { b, a } = await idbBrowser();
  assert.equal(await take(a, KEY_A, [], NOW + 2 * HOUR), 'kept');
  const asked: { tab: 'A' | 'B'; at: number }[] = [];
  const postFor = (tab: 'A' | 'B') => async (): Promise<{ status: number; body: unknown; retryAfter: number }> => { asked.push({ tab, at: b.clock.t }); return { status: 503, body: { error: 'busy' }, retryAfter: 1 }; };
  const A = b.open({ post: postFor('A') });
  await until(() => A.mode === 'idb' && A.key === KEY_A);
  const tabA = b.idb.lastTab;
  b.idb.fail(info => info.tab === tabA && info.op === 'put', 'QuotaExceededError', 1e9);
  const B = b.open({ post: postFor('B') });
  await until(() => B.mode === 'idb' && B.key === KEY_A);
  for (let step = 0; step <= 18; step++) {
    A.pass(); B.pass();
    await settleTasks();
    b.clock.t += 10_000;
  }
  for (const tab of ['A', 'B'] as const) {
    const times = asked.filter(x => x.tab === tab).map(x => x.at);
    assert.ok(times.length >= 2, `${tab} renews`);
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= 60_000, `${tab}: ${times[i]! - times[i - 1]!} ms apart`);
  }
});

// ---- Sol's code review C3 (round 2, 2026-11-20) ----

test('C3-1: Try again after renewals whose writes failed (the last answered 429 Retry-After 600) asks at once and stores no memory wait', async () => {
  const { b, a } = await idbBrowser();
  assert.equal(await take(a, KEY_A, [], NOW + 2 * HOUR), 'kept');
  const server = slowPost();
  const r = b.open({ post: server.post });
  await until(() => r.mode === 'idb' && r.key === KEY_A);
  r.pass();
  await until(() => server.asked.length === 1);
  // Writes fail from here: the renewal's pass is kept in memory only.
  b.idb.fail(info => info.op === 'put', 'QuotaExceededError', 1e9);
  const kept = passOf('gift_aaaa', NOW + 3 * HOUR);
  server.asked[0]!.answer({ status: 200, body: { pass: kept, paidUntil: UNTIL, now: NOW } });
  await until(() => r.pass() === kept);
  b.clock.t += 2 * HOUR;
  r.pass();
  await until(() => server.asked.length === 2);
  server.asked[1]!.answer({ status: 429, body: { error: 'rate_limited' }, retryAfter: 600 });
  await until(() => r.unverified);
  // Writes recover; Try again.
  b.idb.clearFailures();
  r.retry();
  await until(() => server.asked.length === 3);
  const stored = memberIn(b.idb).held!;
  assert.equal(stored.pass, kept, 'the memory pass stored');
  assert.ok(stored.next <= b.clock.t + 60_000, `no memory wait written back (next ${stored.next - b.clock.t} ms ahead)`);
});

test('C3-3: a removal in another tab reaches this one through its storage event alone (no BroadcastChannel)', async () => {
  const b = browser();
  b.channel = false;
  const a = b.open();
  await until(() => a.mode === 'idb');
  await readSeed(new PlusDb(b.idb.factory));
  assert.equal(await take(a, KEY_A), 'kept');
  const c = b.open();
  await until(() => c.mode === 'idb' && c.key === KEY_A);
  assert.equal(c.state, 'on');
  assert.equal(await a.forget(), 'kept');
  await until(() => c.key === null);
  assert.equal(c.state, 'none', 'no longer on');
  // A value the candidate check rejects (another key) also leaves this tab holding what is stored.
  assert.equal(await take(a, KEY_B), 'kept');
  await until(() => c.key === KEY_B);
  c.mirrorChanged(JSON.stringify({ v: 1, key: KEY_C, pass: passOf('gift_cccc', NOW + 24 * HOUR), until: UNTIL }));
  await settleTasks();
  assert.equal(c.key, KEY_B);
});
