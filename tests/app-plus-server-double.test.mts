// The Plus Worker's stand-in (tests/plus-server-double.mts) keeps the Worker's rules: a few self-tests, so the checkout recovery's tests that
// lean on it lean on the right thing. Its grants read as the page reads a real one (`readGrant`, `parsePass`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePass, readGrant } from '../src/app/plus/pass.ts';
import { DAY_MS, DOUBLE_API, PlusServer, derivedKey, secretOf, subId, txnId, type Answer } from './plus-server-double.mts';

const T0 = Date.UTC(2026, 10, 20, 12);
const SUB = subId('alpha'), TXN = txnId('alpha1'), S1 = secretOf('browser one'), S2 = secretOf('browser two');
const keyOf = (a: Answer | null): string => (a?.body as { key: string }).key;
const errorOf = (a: Answer | null): string => (a?.body as { error?: string } | null)?.error ?? '';
const statusOf = (a: Answer | null): string => (a?.body as { status?: string } | null)?.status ?? '';
function server(): { s: PlusServer; clock: { t: number } } {
  const clock = { t: T0 };
  const s = new PlusServer(() => clock.t);
  s.subscription(SUB);
  s.transaction(TXN, SUB, { invoice: '325-10001', email: 'Buyer@Example.com' });
  return { s, clock };
}
const gate = (): { wait: Promise<void>; open: () => void } => { let open!: () => void; const wait = new Promise<void>(r => { open = r; }); return { wait, open }; };
const tick = (): Promise<void> => new Promise(r => { setImmediate(r); });

test('without a secret a repeat replaces the transaction\'s key; with one, a repeat and a restore from the same browser are hits on one key', async () => {
  const { s } = server();
  const first = await s.ask('/pass', { transactionId: TXN });
  const second = await s.ask('/pass', { transactionId: TXN });
  assert.notEqual(keyOf(first), keyOf(second));
  assert.deepEqual(s.keys(SUB), [keyOf(second)], 'one slot per transaction');
  assert.equal(statusOf(await s.ask('/pass/renew', { key: keyOf(first) })), 'replaced');
  assert.equal(s.mints(SUB).length, 2, 'each counted');

  const a = await s.ask('/pass', { transactionId: TXN, secret: S1 });
  assert.equal(keyOf(a), derivedKey(SUB, S1));
  assert.equal((a?.body as { idem?: boolean }).idem, true);
  const grant = readGrant(a?.body);
  assert.ok(grant?.key && parsePass(grant.pass)?.sub === SUB, 'the page reads it as a grant');
  assert.equal(grant.until, (a?.body as { paidUntil: number }).paidUntil, 'until is the paid period');
  assert.deepEqual(s.keys(SUB), [keyOf(a)], 'a miss with a secret replaces the slot too');
  const again = await s.ask('/pass', { transactionId: TXN, secret: S1 });
  const restored = await s.ask('/restore', { email: ' buyer@example.com ', invoice: '#325-10001', secret: S1 });
  assert.equal(keyOf(again), keyOf(a)); assert.equal(keyOf(restored), keyOf(a));
  assert.deepEqual(s.log.slice(-2).map(x => x.outcome), ['hit', 'hit']);
  assert.equal(s.mints(SUB).length, 3, 'hits are not counted');
  assert.equal((await s.ask('/pass/renew', { key: keyOf(a) }))?.status, 200);
  const other = await s.ask('/restore', { email: 'buyer@example.com', invoice: '325-10001', secret: S2 });
  assert.deepEqual(s.keys(SUB), [keyOf(a), keyOf(other)], 'a restore miss adds');
  assert.equal(errorOf(await s.ask('/pass', { transactionId: TXN, secret: 'short' })), 'bad_request');
  assert.equal(statusOf(await s.ask('/pass/renew', { key: derivedKey(subId('nobody'), S1) })), 'unknown', 'no list at all');
});

test('at most 5 keys made a day (429 too_many_keys with the wait), never for a hit; past five the oldest is pushed out', async () => {
  const { s, clock } = server();
  const made: string[] = [];
  for (let i = 0; i < 5; i++) { clock.t = T0 + i * 60_000; made.push(keyOf(await s.ask('/restore', { email: 'buyer@example.com', invoice: '325-10001', secret: secretOf(`b${i}`) }))); }
  clock.t = T0 + 10 * 60_000;
  const capped = await s.ask('/pass', { transactionId: TXN, secret: secretOf('b5') });
  assert.equal(capped?.status, 429); assert.equal(errorOf(capped), 'too_many_keys');
  assert.equal(capped?.retryAfter, (DAY_MS - 10 * 60_000) / 1000, 'until the oldest of the five is a day old');
  assert.equal((await s.ask('/pass', { transactionId: TXN, secret: secretOf('b2') }))?.status, 200, 'a hit is never capped');
  clock.t = T0 + DAY_MS;
  const sixth = await s.ask('/pass', { transactionId: TXN, secret: secretOf('b5') });
  assert.equal(sixth?.status, 200);
  assert.deepEqual(s.keys(SUB), [...made.slice(1), keyOf(sixth)], 'the oldest pushed out');
  assert.equal(statusOf(await s.ask('/pass/renew', { key: made[0] })), 'replaced');
});

test('pending until Paddle finishes (and restore not_found then); busy within one isolate; a lost answer was still processed', async () => {
  const { s } = server();
  const late = txnId('late1');
  s.transaction(late, SUB, { state: 'pending', invoice: '325-20002' });
  const pending = await s.ask('/pass', { transactionId: late, secret: S1 });
  assert.equal(pending?.status, 409); assert.equal(pending?.retryAfter, 3);
  assert.equal(errorOf(await s.ask('/restore', { email: 'buyer@example.com', invoice: '325-20002', secret: S1 })), 'not_found');
  s.finish(late);
  assert.equal((await s.ask('/pass', { transactionId: late, secret: S1 }))?.status, 200);

  const held = gate();
  s.plan({ read: held.wait }, {}, { isolate: 'other' });
  const slow = s.ask('/pass', { transactionId: TXN, secret: S1 });
  await tick();
  const busy = await s.ask('/pass', { transactionId: TXN, secret: S1 });
  assert.equal(busy?.status, 503); assert.equal(errorOf(busy), 'busy'); assert.equal(busy?.retryAfter, 2, 'a hit waits its turn too');
  assert.equal((await s.ask('/pass', { transactionId: TXN, secret: S1 }))?.status, 200, 'another isolate does not see it');
  held.open();
  assert.equal((await slow)?.status, 200);

  s.plan({ lose: true });
  assert.equal(await s.ask('/pass', { transactionId: TXN, secret: S2 }), null, 'the answer is lost');
  assert.ok(s.keys(SUB).includes(derivedKey(SUB, S2)), 'but the key was made');
  assert.equal((await s.ask('/pass/renew', { key: derivedKey(SUB, S2) }))?.status, 200);
  await assert.rejects(s.post(`${DOUBLE_API}/pass`, { transactionId: TXN }, AbortSignal.abort()), 'an aborted request is not sent');
  s.plan({ reply: { status: 429, body: { error: 'rate_limited' }, retryAfter: 300 } });
  assert.equal((await s.ask('/pass', { transactionId: TXN }))?.retryAfter, 300, 'a canned answer');
});

test('two misses that read the list before either writes: the later write drops the other\'s key (a cross-isolate lost update)', async () => {
  for (const order of ['arrival', 'reverse'] as const) {
    const { s } = server();
    s.lostUpdate(order);
    const [a, b] = await Promise.all([s.ask('/pass', { transactionId: TXN, secret: S1 }), s.ask('/restore', { email: 'buyer@example.com', invoice: '325-10001', secret: S2 })]);
    assert.equal(a?.status, 200); assert.equal(b?.status, 200);
    const lost = order === 'arrival' ? keyOf(a) : keyOf(b), kept = order === 'arrival' ? keyOf(b) : keyOf(a);
    assert.deepEqual(s.keys(SUB), [kept], order);
    assert.equal(statusOf(await s.ask('/pass/renew', { key: lost })), 'replaced', order);
    assert.equal(s.mints(SUB).length, 1, 'the mints written last are the later writer\'s');
  }
});
