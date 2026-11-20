// Sol's code review C2 of the checkout recovery (2026-11-20): each finding's scenario, on the flows (page-flow.ts), the request sender
// (pass.ts webPost), the key form (key.ts) and the app's pop-up (panel.ts), against the Worker's stand-in, tabs over one in-memory IndexedDB
// and virtual clocks. (The page's own gates, F1 and F8, are in tests/app-plus-page-gates.test.mts.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Capture, Plus } from '../src/app/plus/pass.ts';
import { webPost } from '../src/app/plus/pass.ts';
import { keyEntry } from '../src/app/plus/key.ts';
import { popView, type PopUi } from '../src/app/plus/panel.ts';
import { lateText, keySettling, restoreBy, setUpPayment, type AttemptDeps } from '../src/app/plus/page-flow.ts';
import { keepAgainSettling } from '../src/app/plus/page-flow.ts';
import { PaidStore } from '../src/app/plus/paid.ts';
import { PlusDb, readSeed } from '../src/app/plus/plus-db.ts';
import { TabWaits } from '../src/app/plus/schedule.ts';
import { FakePage } from './fake-dom.mts';
import { OPEN_WAIT_MS, browser, settle, until, type Browser } from './plus-browser-double.mts';
import { PlusServer, subId, txnId, type Answer } from './plus-server-double.mts';

const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const SUB = subId('reviewctwo'), TXN = txnId('reviewctwoa'), TXN_2 = txnId('reviewctwob');
interface Page { member: Plus; db: PlusDb; paid: PaidStore; waits: TabWaits; mono: { t: number }; deps: AttemptDeps }
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
  server.transaction(TXN, SUB, { invoice: '325-301' });
  server.transaction(TXN_2, SUB, { invoice: '325-302' });
  return { b, server };
}
const paidIn = async (p: Page, txn = TXN): Promise<void> => { await p.paid.begin(txn, await readSeed(p.db)); };
const err = (status: number, error: string, retryAfter?: number): Answer => ({ status, body: { error }, ...(retryAfter ? { retryAfter } : {}) });

test('C2-3: a gate transaction that ends past the deadline sends nothing', async () => {
  const { b, server } = world(), p = await page(b, server);
  await paidIn(p);
  await settle(); await p.paid.refresh();
  // The gate's read of the record (after its seed read) is held until the clock shows 95 s.
  const held = b.idb.hold(info => info.mode === 'readwrite' && info.op === 'get' && info.key === `paid:${TXN}`);
  const running = setUpPayment(TXN, p.deps);
  await held.reached;
  p.mono.t = 95_000; b.clock.t += 95_000;
  held.release();
  const out = await running;
  assert.equal(out.kind, 'late');
  assert.equal(server.asked('/v1/pass'), 0, 'nothing sent at 95 s');
});

test('C2-4: the receipt honours the server\'s waits: after 429 Retry-After 300 a press sends nothing and says the wait, then asks', async () => {
  const { b, server } = world(), p = await page(b, server);
  server.plan({ reply: err(429, 'rate_limited', 300) });
  const first = await restoreBy('buyer@example.com', '325-301', p.deps);
  assert.deepEqual(first, { kind: 'no', text: 'Too many tries. Try again in 5 min.' });
  const asked = server.asked('/v1/restore');
  const again = await restoreBy('buyer@example.com', '325-301', p.deps);
  assert.deepEqual(again, { kind: 'no', text: 'Too many tries. Try again in 5 min.' });
  assert.equal(server.asked('/v1/restore'), asked, 'nothing sent during the wait');
  p.mono.t += 300_000;
  assert.equal((await restoreBy('buyer@example.com', '325-301', p.deps)).kind, 'ok');
});

test('C2-5: a key or a receipt settles this tab\'s own records that waited when it began, not one made after', async () => {
  for (const how of ['restore', 'key'] as const) {
    const { b, server } = world(), p = await page(b, server);
    const seed = await readSeed(p.db);
    b.idb.failNextPut('QuotaExceededError');
    await p.paid.begin(TXN, seed);
    assert.deepEqual(p.paid.list().map(x => [x.id, x.memory]), [[TXN, true]], how);
    let gift = '';
    if (how === 'key') {
      const other = await page(b, server);
      const made = await restoreBy('buyer@example.com', '325-302', other.deps);
      gift = made.kind === 'ok' ? made.grant.key : '';
      assert.equal(await other.member.forget(), 'kept');
      await until(() => p.member.key === null);
    }
    // A record made after the action began (its write refused too) stays.
    const late = (async () => { await settle(); b.idb.failNextPut('QuotaExceededError'); await p.paid.begin(TXN_2, seed); })();
    const out = how === 'restore' ? await restoreBy('buyer@example.com', '325-301', p.deps)
      : await keySettling(gift, { post: server.post, api: () => 'https://plus.test/v1', member: p.member, paid: p.paid });
    await late;
    assert.equal(out.kind, 'ok', how);
    await p.paid.refresh();
    assert.deepEqual(p.paid.list().map(x => x.id), [TXN_2], `${how}: the earlier tab-local record settled, the later one kept`);
  }
});

test('C2-7: an answer whose body is cut off by the timeout or the caller is a lost answer, not an empty refusal', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => ({
    status: 200, headers: new Headers(),
    json: () => new Promise((_, reject) => { init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); }); }),
  })) as unknown as typeof fetch;
  try {
    const caller = new AbortController();
    const sent = webPost('https://plus.test/v1/pass', {}, caller.signal);
    await new Promise(resolve => { setImmediate(resolve); });
    caller.abort(new DOMException('given up', 'AbortError'));
    await assert.rejects(sent, 'rejected like a request with no answer');
  } finally { globalThis.fetch = real; }
});

test('C2-9 and C2-10: a 503 wait past the deadline says the receipt text; too many keys says the wait it was given', async () => {
  {
    const { b, server } = world(), p = await page(b, server);
    await paidIn(p);
    server.plan({ reply: err(503, 'unavailable', 300) });
    assert.deepEqual(await setUpPayment(TXN, p.deps), { kind: 'late', text: lateText() }, 'a server outage is not "too many tries"');
    assert.deepEqual(await setUpPayment(TXN, p.deps), { kind: 'late', text: lateText() }, 'nor is a press during its wait');
    assert.equal(server.asked('/v1/pass'), 1);
  }
  {
    const { b, server } = world(), p = await page(b, server);
    await paidIn(p);
    server.plan({ reply: err(429, 'too_many_keys', 7_200) });
    assert.deepEqual(await setUpPayment(TXN, p.deps), { kind: 'no', text: 'This subscription was given 5 keys within a day. Use one of them, or try again in 2 h.' });
    server.plan({ reply: err(429, 'too_many_keys', 1_500) });
    assert.deepEqual(await restoreBy('buyer@example.com', '325-301', { ...p.deps, waits: new TabWaits({ mono: () => 0, wall: () => b.clock.t }) }), { kind: 'no', text: 'This subscription was given 5 keys within a day. Use one of them, or try again in 25 min.' });
  }
});

test('C1-6 at the gate: a reset between the capture and the request\'s transaction sends nothing (another seed, another epoch)', async () => {
  const { b, server } = world(), p = await page(b, server);
  await readSeed(p.db);
  const member = {
    issues: true,
    capture: async (): Promise<Capture | null> => { const cap = await p.member.capture(); b.idb.wipe(); await settle(); return cap as Capture | null; },
    acceptIf: (...args: Parameters<Plus['acceptIf']>) => p.member.acceptIf(...args),
  };
  const out = await restoreBy('buyer@example.com', '325-301', { ...p.deps, member });
  assert.equal(out.kind, 'stale');
  assert.equal(server.log.length, 0, 'nothing sent');
  assert.equal(b.idb.peek('member'), undefined, 'nothing taken into the new database');
});

test('C2-6: an unstored Remove in the pop-up is said as removed in this tab only, with Try again, never "Key removed from this browser"', () => {
  const ui: PopUi = { mode: 'idle', revealed: null, removed: true };
  const view = popView({ state: 'none', until: null, key: null, unverified: false, unstored: true, saveFailed: true }, ui);
  assert.notEqual(view.status?.text, 'Key removed from this browser.');
  assert.equal(view.status?.text, 'Removed in this tab only: this browser still keeps the key.');
  assert.deepEqual(view.actions, ['save']);
  assert.ok(view.notes.includes('Plus could not be saved in this browser just now.'));
  // Stored: as before.
  assert.equal(popView({ state: 'none', until: null, key: null, unverified: false }, ui).status?.text, 'Key removed from this browser.');
  // The Plus page shows the warning and Try again for it.
  const source = read('src/app/plus/page.ts');
  assert.match(source, /t\('Removed in this tab only: this browser still keeps the key\.'\)/);
});

test('C2-11: the key form stays disabled with no word while the tab\'s database is opening (the app\'s pop-up passes the block)', () => {
  const done = new FakePage().install();
  try {
    let blocked = true, sent = 0;
    const box = keyEntry({ blocked: () => blocked, activate: async () => { sent++; return { kind: 'stale' }; } });
    box.input.value = 'gift_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    box.refresh?.();
    const go = box.root.querySelector('.key-go') as unknown as { disabled: boolean };
    assert.equal(go.disabled, true, 'Activate disabled');
    assert.equal(box.input.disabled, true);
    (box.root as unknown as { requestSubmit(): void }).requestSubmit();
    assert.equal(sent, 0, 'nothing sent');
    assert.equal((box.root.querySelector('.key-msg') as unknown as { textContent: string }).textContent, '', 'no word');
    blocked = false; box.refresh?.();
    assert.equal(go.disabled, false);
  } finally { done(); }
  assert.match(read('src/app/plus/panel.ts'), /blocked: \(\) => member\.mode === 'opening'/);
});

test('C2-2: the Plus page reads its payments again on focus, beside visibilitychange', () => {
  const source = read('src/app/plus/page.ts');
  assert.match(source, /addEventListener\('focus', \(\) => \{[^}]*paid\.refresh\(\)[^}]*member\.reload\(\)/);
});

test('C3-2: a key or a receipt held as an overlay settles the payments only this tab holds when Try again stores it; their button cannot replace it', async () => {
  for (const how of ['restore', 'key'] as const) {
    const { b, server } = world();
    const SUB2 = subId('reviewgift'), TXN_G = txnId('reviewgifta');
    server.subscription(SUB2); server.transaction(TXN_G, SUB2, { invoice: '325-777' });
    const p = await page(b, server);
    // A payment whose record this browser would not store (tab-local).
    const seed = await readSeed(p.db);
    b.idb.failNextPut('QuotaExceededError');
    await p.paid.begin(TXN, seed);
    assert.deepEqual(p.paid.list().map(x => [x.id, x.memory]), [[TXN, true]], how);
    let chosen = '';
    if (how === 'key') {
      // A key of another subscription, from another browser (its own seed).
      const elsewhere = browser(), there = await page(elsewhere, server);
      const made = await restoreBy('buyer@example.com', '325-777', there.deps);
      chosen = made.kind === 'ok' ? made.grant.key : '';
      b.idb.failNextCommit('UnknownError');
      const out = await keySettling(chosen, { post: server.post, api: () => 'https://plus.test/v1', member: p.member, paid: p.paid });
      assert.deepEqual(out.kind === 'ok' ? out.kept : out.kind, false, `${how}: held as an overlay`);
    } else {
      b.idb.failNextCommit('UnknownError');
      const out = await restoreBy('buyer@example.com', '325-777', p.deps);
      assert.equal(out.kind === 'ok' && !out.kept, true, `${how}: held as an overlay`);
      chosen = out.kind === 'ok' ? out.grant.key : '';
    }
    assert.equal(p.member.unstored, true);
    assert.equal(await keepAgainSettling(p.member, p.paid), 'kept');
    await p.paid.refresh();
    assert.deepEqual(p.paid.list(), [], `${how}: the tab-local payment does not wait`);
    const asked = server.asked('/v1/pass');
    assert.deepEqual(await setUpPayment(TXN, p.deps), { kind: 'gone' }, `${how}: its button asks nothing`);
    assert.equal(server.asked('/v1/pass'), asked);
    assert.equal(p.member.key, chosen, `${how}: the chosen membership stands`);
  }
});
