// The Plus database (src/app/plus/plus-db.ts, spec section 1 of the checkout recovery, 2026-11-20): opened once with a 3 s wait reported as its
// own outcome, one transaction per `tx` that resolves after its commit, atomic read-check-write across tabs, the seed made once and never kept
// in the tab, closed by an upgrade elsewhere or by the browser and opened again by the next use. Against the in-memory IndexedDB of
// tests/plus-db-fake.mts, whose own fidelity (serialised transactions, auto-commit, failures) is checked here too.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { KV_STORE, OPEN_TIMEOUT_MS, PLUS_DB, PLUS_DB_VERSION, PlusDb, PlusDbUnavailable, SEED_KEY, SEED_SHAPE, newSeed, readSeed, seedIn, type DbState } from '../src/app/plus/plus-db.ts';
import { FakeIdb, settle } from './plus-db-fake.mts';

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
