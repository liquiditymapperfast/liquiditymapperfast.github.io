import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, FREE_DAYS, freeFrom, plusApi, PLUS_API } from '../src/app/plus/config.ts';
import { PLUS_STORE, Plus, parsePass, readGrant, readHeld, type Post } from '../src/app/plus/pass.ts';

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A pass as the server writes one (the signature is the server's business: the page reads only the middle part). */
const passFor = (sub: string, exp: number): string => `v1.${b64url(JSON.stringify({ sub, exp }))}.c2lnbmF0dXJl`;
const KEY = 'k'.repeat(43);
const HOUR = 3_600_000;

/** A `localStorage` that is a plain map. */
function memory(initial: Record<string, string> = {}): { store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, store: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } } };
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

test('the free days are today and the seven UTC days before it, whatever the hour', () => {
  const day = Date.UTC(2026, 10, 17);
  assert.equal(FREE_DAYS, 7);
  assert.equal(freeFrom(day), day - 7 * DAY_MS, 'at midnight');
  assert.equal(freeFrom(day + 23 * HOUR + 59 * 60_000), day - 7 * DAY_MS, 'a minute before the next');
  assert.equal(freeFrom(day + DAY_MS), day - 6 * DAY_MS, 'the next day opens one day and closes one');
});

test('a local stand-in may answer for the Plus server while testing, and nothing else may', () => {
  assert.equal(plusApi(''), PLUS_API);
  assert.equal(plusApi('?plus=http://127.0.0.1:8799/v1'), 'http://127.0.0.1:8799/v1');
  assert.equal(plusApi('?plus=http://localhost:8799/v1/'), 'http://localhost:8799/v1', 'no slash at its end');
  assert.equal(plusApi('?plus=https://evil.example/v1'), PLUS_API, 'another host is not taken');
  assert.equal(plusApi('?plus=javascript:alert(1)'), PLUS_API);
});

test('a pass says whose it is and when it runs out; anything else is no pass', () => {
  assert.deepEqual(parsePass(passFor('sub_1', 123)), { sub: 'sub_1', exp: 123 });
  for (const bad of ['', 'v1.x', 'v2.e30.sig', `v1.${b64url('{"sub":"","exp":1}')}.s`, `v1.${b64url('{"sub":"a"}')}.s`, `v1.${b64url('not json')}.s`, 'v1.!!!.s', 5, null, undefined, 'x'.repeat(3_000)]) {
    assert.equal(parsePass(bad), null, String(bad).slice(0, 30));
  }
});

test('what the browser keeps and what the server answers are checked before they are believed', () => {
  const pass = passFor('sub_1', 9);
  assert.deepEqual(readHeld(JSON.stringify({ v: 1, key: KEY, pass, until: 77 })), { key: KEY, pass, until: 77 });
  assert.deepEqual(readHeld(JSON.stringify({ v: 1, key: KEY, pass: 'junk' })), { key: KEY, pass: '', until: 0 }, 'a pass that is none reads as none');
  for (const bad of [null, '', 'x', '{}', JSON.stringify({ v: 2, key: KEY }), JSON.stringify({ v: 1, key: 'short' })]) assert.equal(readHeld(bad), null);
  assert.deepEqual(readGrant({ pass, until: 5, key: KEY }), { pass, until: 5, key: KEY });
  assert.deepEqual(readGrant({ pass, until: 5 }), { pass, until: 5 }, 'a renewal carries no key');
  assert.deepEqual(readGrant({ pass, until: 5, paidUntil: 900 }), { pass, until: 900 }, 'the end of the paid period, where the server says it, not the expiry of the pass');
  for (const bad of [null, {}, { pass: 'junk', until: 5 }, { pass, until: 'soon' }]) assert.equal(readGrant(bad), null);
});

test('a membership is in force while its pass has time to run, and is kept where the app and the Plus page both read it', () => {
  let now = 1_000_000_000_000;
  const { store, data } = memory();
  const calls: unknown[] = [];
  const post: Post = (url, body) => { calls.push([url, body]); return Promise.resolve({ status: 500, body: null }); };
  const plus = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  assert.equal(plus.on, false); assert.equal(plus.known, false); assert.equal(plus.pass(), null); assert.equal(calls.length, 0, 'no membership, nothing asked');
  let told = 0; plus.subscribe(() => { told++; });
  plus.accept({ key: KEY, pass: passFor('sub_1', now + 24 * HOUR), until: now + 20 * DAY_MS });
  assert.equal(told, 1);
  assert.equal(plus.on, true); assert.equal(plus.key, KEY); assert.equal(plus.until, now + 20 * DAY_MS);
  assert.deepEqual(JSON.parse(data.get(PLUS_STORE)!), { v: 1, key: KEY, pass: passFor('sub_1', now + 24 * HOUR), until: now + 20 * DAY_MS });
  assert.equal(calls.length, 0, 'a fresh pass is not renewed');
  // Another tab reads the same storage.
  const other = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  assert.equal(other.on, true);
  // Run out: no pass is handed over, though the membership is still known.
  now += 25 * HOUR;
  assert.equal(plus.pass(), null); assert.equal(plus.known, true);
  plus.forget();
  assert.equal(plus.known, false); assert.equal(data.has(PLUS_STORE), false);
});

test('a pass is renewed with the key before it runs out, once at a time, and a refusal ends it without losing the key', async () => {
  let now = 1_000_000_000_000;
  const { store } = memory();
  const calls: [string, unknown][] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { pass: passFor('sub_1', now + 30 * HOUR), until: now + 30 * DAY_MS } };
  const post: Post = (url, body) => { calls.push([url, body]); return Promise.resolve(answer); };
  const plus = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  plus.accept({ key: KEY, pass: passFor('sub_1', now + 5 * HOUR), until: now + DAY_MS });
  let told = 0; plus.subscribe(() => { told++; });
  // Under six hours left: still handed over, and a new one asked for; asking again meanwhile does not ask twice.
  assert.ok(plus.pass()); assert.ok(plus.pass());
  assert.deepEqual(calls, [['https://plus.test/v1/pass/renew', { key: KEY }]]);
  await settle();
  assert.equal(told, 1, 'the new pass is told once');
  assert.equal(parsePass(plus.pass())!.exp, now + 30 * HOUR); assert.equal(plus.until, now + 30 * DAY_MS);
  // The subscription ended: the renewal is refused, the pass goes when it runs out, the key stays for a subscription paid again.
  now += 26 * HOUR;
  answer = { status: 403, body: { error: 'not_active', status: 'canceled' } };
  assert.ok(plus.pass(), 'four hours left: still good');
  await settle();
  assert.equal(plus.on, false); assert.equal(plus.known, true); assert.equal(plus.key, KEY);
  const asked = calls.length;
  assert.equal(plus.pass(), null); await settle();
  assert.equal(calls.length, asked, 'not asked again right after a refusal');
  now += HOUR + 1;
  answer = { status: 200, body: { pass: passFor('sub_1', now + 24 * HOUR), until: now + 30 * DAY_MS } };
  plus.pass(); await settle();
  assert.equal(plus.on, true, 'paid again: the same key renews');
});

test('a pass the server refuses is dropped and asked for again; a failed renewal is tried again a minute later', async () => {
  let now = 1_000_000_000_000;
  const { store } = memory();
  let fail = true; const calls: unknown[] = [];
  const post: Post = (_url, body) => { calls.push(body); return fail ? Promise.reject(new Error('offline')) : Promise.resolve({ status: 200, body: { pass: passFor('sub_1', now + 24 * HOUR), until: now + DAY_MS } }); };
  const plus = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  plus.accept({ key: KEY, pass: passFor('sub_1', now + 20 * HOUR), until: now + DAY_MS });
  plus.refused();
  assert.equal(plus.on, false, 'dropped at once'); assert.equal(calls.length, 1);
  await settle();
  plus.pass(); await settle();
  assert.equal(calls.length, 1, 'not hammered while the server cannot be reached');
  now += 61_000; fail = false;
  plus.pass(); await settle();
  assert.equal(calls.length, 2); assert.equal(plus.on, true);
});

test('a server that refuses the pass it has just given is not asked in a circle', async () => {
  let now = 1_000_000_000_000;
  const { store } = memory();
  let renewals = 0;
  const post: Post = () => { renewals++; return Promise.resolve({ status: 200, body: { pass: passFor('sub_1', now + 24 * HOUR), until: now + DAY_MS } }); };
  const plus = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  plus.accept({ key: KEY, pass: passFor('sub_1', now + 20 * HOUR), until: now + DAY_MS });
  // Each new pass is refused the moment it is used.
  for (let i = 0; i < 6; i++) { plus.refused(); await settle(); plus.pass(); await settle(); now += 1_000; }
  assert.equal(renewals, 1, 'one renewal in the first seconds, however often the pass is refused');
  now += 60_000;
  plus.pass(); await settle();
  assert.equal(renewals, 2, 'and again a minute later');
});

test('what another tab stored is taken over, and only a change is told', () => {
  const now = 1_000_000_000_000;
  const { store, data } = memory();
  const plus = new Plus(store, () => Promise.resolve({ status: 500, body: null }), () => now, () => 'https://plus.test/v1');
  let told = 0; plus.subscribe(() => { told++; });
  plus.reload(); assert.equal(told, 0, 'nothing there, nothing new');
  data.set(PLUS_STORE, JSON.stringify({ v: 1, key: KEY, pass: passFor('sub_9', now + 24 * HOUR), until: now + DAY_MS }));
  plus.reload();
  assert.equal(told, 1); assert.equal(plus.on, true);
  plus.reload(); assert.equal(told, 1, 'the same again is no news');
  data.delete(PLUS_STORE); plus.reload();
  assert.equal(told, 2); assert.equal(plus.known, false);
});
