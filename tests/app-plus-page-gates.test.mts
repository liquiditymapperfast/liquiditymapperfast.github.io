// The Plus page's gates after Sol's code review C2 (2026-11-20): no prices until the payments were read (C2-1, its slow-open scenario), and a
// Try again for a membership this tab could not store keeps the page's payments current (C2-8). Pure parts of page-flow.ts, against tabs over
// one in-memory IndexedDB; the page's own use of them is pinned by its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Capture } from '../src/app/plus/pass.ts';
import { buyView, keepAgainSettling } from '../src/app/plus/page-flow.ts';
import { PaidStore } from '../src/app/plus/paid.ts';
import { PlusDb, readSeed } from '../src/app/plus/plus-db.ts';
import { OPEN_WAIT_MS, browser, grantOf, KEY_A, until } from './plus-browser-double.mts';

const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const TXN = 'txn_gatesaaaaaaaaaaaaaaaaaaaaaa';

test('C2-1: a slow first open never offers prices over a payment still waiting: buying waits for the first read of the payments', async () => {
  const b = browser();
  // A payment recorded earlier in this browser.
  {
    const first = b.open();
    await until(() => first.mode === 'idb');
    b.idb.set(`paid:${TXN}`, { at: b.clock.t });
  }
  b.idb.opens = 'hang';
  const member = b.open(), db = new PlusDb(b.idb.factory, undefined, OPEN_WAIT_MS), paid = new PaidStore(db, () => b.clock.t);
  assert.equal(await paid.refresh(), false, 'the read gives up with the open');
  assert.equal(paid.ready, false);
  assert.equal(buyView(member.mode, paid.ready, paid.list().length > 0), 'cannot-here', 'a marked tab not ready: no prices');
  assert.equal(buyView('opening', false, false), 'opening', 'an unmarked tab still opening: no prices either');
  b.idb.opens = 'answer'; b.idb.releaseOpens();
  await until(() => member.mode === 'idb');
  assert.equal(buyView(member.mode, paid.ready, paid.list().length > 0), 'opening', 'IDB mode, payments not read yet: still no prices');
  assert.equal(await paid.refresh(), true);
  assert.equal(buyView(member.mode, paid.ready, paid.list().length > 0), 'pending', 'the payment and its button, not prices');
  assert.equal(buyView('idb', true, false), 'prices');
  assert.equal(buyView('plain', false, false), 'cannot-buy');
  assert.equal(buyView('unusable', false, false), 'cannot-here');
  // The page draws from it, reads the payments again when the mode changes, and tries a failed read again.
  const source = read('src/app/plus/page.ts');
  assert.match(source, /buyView\(member\.mode, paid\.ready, /);
  assert.match(source, /if \(member\.mode !== lastMode\) \{ lastMode = member\.mode; void settlePaid\(\); \}/);
  assert.match(source, /async function settlePaid\(\): Promise<void> \{/);
});

test('C2-8: Try again for a checkout\'s unstored key settles its payment in this tab\'s list too', async () => {
  const b = browser(), member = b.open();
  await until(() => member.mode === 'idb');
  const db = new PlusDb(b.idb.factory, undefined, OPEN_WAIT_MS), paid = new PaidStore(db, () => b.clock.t);
  await paid.begin(TXN, await readSeed(db));
  const cap = await member.capture() as Capture;
  b.idb.failNextCommit('UnknownError');
  assert.equal(await member.acceptIf(cap, grantOf(KEY_A), [TXN]), 'unkept');
  assert.equal(paid.list().length, 1);
  assert.equal(await keepAgainSettling(member, paid), 'kept');
  assert.equal(b.idb.peek(`paid:${TXN}`), undefined);
  assert.deepEqual(paid.list(), [], 'the list is current at once');
  assert.match(read('src/app/plus/page.ts'), /keepAgainSettling\(member, paid\)/);
});

test('C3-4: a first payment read that timed out, a late open and an empty read: readiness is told, and the sale shows', async () => {
  const b = browser();
  b.idb.opens = 'hang';
  const member = b.open(), db = new PlusDb(b.idb.factory, undefined, OPEN_WAIT_MS), paid = new PaidStore(db, () => b.clock.t);
  let view = '';
  const render = (): void => { view = buyView(member.mode, paid.ready, paid.list().length > 0); };
  member.subscribe(render); paid.subscribe(render); render();
  assert.equal(await paid.refresh(), false);
  assert.equal(view, 'opening');
  b.idb.opens = 'answer'; b.idb.releaseOpens();
  await until(() => member.mode === 'idb');
  assert.equal(view, 'opening', 'IDB mode, payments not read yet');
  assert.equal(await paid.refresh(), true);
  assert.deepEqual(paid.list(), []);
  assert.equal(view, 'prices', 'the last view drawn shows the sale');
  assert.match(read('src/app/plus/page.ts'), /if \(await paid\.refresh\(\)\) \{ render\(\); return; \}/, 'the page draws after a read too');
});
