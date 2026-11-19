import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, FREE_DAYS, freeFrom, plusApi, PLUS_API } from '../src/app/plus/config.ts';
import { PLUS_STORE, Plus, parsePass, readGrant, readHeld, type Post } from '../src/app/plus/pass.ts';
import { ARRIVAL_SECONDS, Arrival, countsDown, placeOf, stopOnActivity, type ArrivalDocument, type ArrivalPlace, type ArrivalState } from '../src/app/plus/arrival.ts';

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
/** The answers already resolved are handed on (no timer: many steps stay quick). */
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

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
  const rest = { ended: false, why: '', renews: null, skew: 0, next: 0 };
  assert.deepEqual(readHeld(JSON.stringify({ v: 1, key: KEY, pass, until: 77 })), { key: KEY, pass, until: 77, ...rest });
  assert.deepEqual(readHeld(JSON.stringify({ v: 1, key: KEY, pass, until: 77, ended: true, why: 'replaced', renews: false, skew: -5, next: 9 })), { key: KEY, pass, until: 77, ended: true, why: 'replaced', renews: false, skew: -5, next: 9 });
  assert.deepEqual(readHeld(JSON.stringify({ v: 1, key: KEY, pass: 'junk' })), { key: KEY, pass: '', until: 0, ...rest }, 'a pass that is none reads as none');
  for (const bad of [null, '', 'x', '{}', JSON.stringify({ v: 2, key: KEY }), JSON.stringify({ v: 1, key: 'short' })]) assert.equal(readHeld(bad), null);
  assert.deepEqual(readGrant({ pass, until: 5, key: KEY }), { pass, until: 5, key: KEY });
  assert.deepEqual(readGrant({ pass, until: 5 }), { pass, until: 5 }, 'a renewal carries no key');
  assert.deepEqual(readGrant({ pass, until: 5, paidUntil: 900 }), { pass, until: 900 }, 'the end of the paid period, where the server says it, not the expiry of the pass');
  assert.deepEqual(readGrant({ pass, until: 5, renews: false, now: 1_800_000_000_000, gift: true }), { pass, until: 5, renews: false, now: 1_800_000_000_000 }, 'whether it renews, and the clock of the server');
  assert.deepEqual(readGrant({ pass, until: 5, now: 1_800_000_000 }), { pass, until: 5 }, 'a time in seconds is not believed');
  assert.deepEqual(readGrant({ pass, until: 5, renews: 'yes', now: 'soon' }), { pass, until: 5 });
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
  assert.deepEqual(JSON.parse(data.get(PLUS_STORE)!), { v: 1, key: KEY, pass: passFor('sub_1', now + 24 * HOUR), until: now + 20 * DAY_MS, ended: false, why: '', renews: null, skew: 0, next: 0 });
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

test('two tabs do not take turns asking: one renewal a minute between them, however often the pass is refused', async () => {
  let now = 1_000_000_000_000;
  const { store } = memory();
  let renewals = 0;
  const post: Post = () => { renewals++; return Promise.resolve({ status: 200, body: { pass: passFor('sub_1', now + 24 * HOUR + renewals), until: now + DAY_MS } }); };
  const a = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  const b = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  a.accept({ key: KEY, pass: passFor('sub_1', now + 20 * HOUR), until: now + DAY_MS }); b.reload();
  // Each tab's request is refused; what one tab stores reaches the other as a storage event before the other's next step.
  for (let frame = 0; frame < 600; frame++) {
    const [one, other] = frame % 2 ? [b, a] : [a, b];
    one.refused(); other.reload(); await flush(); other.reload(); one.reload();
    one.pass(); other.pass(); await flush(); one.reload(); other.reload();
    now += 100;
  }
  assert.equal(renewals, 1, 'sixty seconds, two tabs, one renewal');
  now += 1_000;
  a.pass(); await flush(); b.reload(); b.pass(); await flush();
  assert.equal(renewals, 2, 'and one more a minute after the first');
});

test('a pass the server gives already near its end is not asked for again each frame', async () => {
  let now = 1_000_000_000_000;
  const { store } = memory();
  let renewals = 0, told = 0;
  // The last hours of a membership: the server gives no pass past its end.
  const end = now + 3 * HOUR;
  const post: Post = () => { renewals++; return Promise.resolve({ status: 200, body: { pass: passFor('sub_1', end), until: end, renews: false } }); };
  const plus = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  plus.accept({ key: KEY, pass: passFor('sub_1', end), until: end });
  plus.subscribe(() => { told++; });
  for (let frame = 0; frame < 20; frame++) { assert.ok(plus.pass()); await settle(); now += 16; }
  assert.equal(renewals, 1); assert.equal(told, 1);
  assert.equal(plus.renews, false);
  now += HOUR;
  plus.pass(); await settle();
  assert.equal(renewals, 2, 'again an hour later');
});

test('a pass is judged by the clock of the server where the device is off', async () => {
  // The device's clock runs 25 hours ahead of the server's.
  const server = 1_000_000_000_000; let now = server + 25 * HOUR;
  const { store } = memory();
  let withClock = true, renewals = 0;
  const post: Post = () => { renewals++; return Promise.resolve({ status: 200, body: { pass: passFor('sub_1', server + 24 * HOUR), until: server + 20 * DAY_MS, ...(withClock ? { now: server } : {}) } }); };
  const plus = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  assert.equal(plus.accept({ key: KEY, pass: passFor('sub_1', server + 24 * HOUR), until: server + 20 * DAY_MS, now: server }), true);
  assert.equal(plus.state, 'on', 'the server said what time it is');
  assert.equal(renewals, 0, 'and a day-long pass is not renewed');
  // A copy in another tab reads the same correction.
  assert.equal(new Plus(store, post, () => now, () => 'https://plus.test/v1').on, true);
  // A server that does not say: the pass looks run out; the membership is being checked, never called ended, and is asked for once an hour.
  withClock = false;
  plus.accept({ key: KEY, pass: passFor('sub_1', server + 24 * HOUR), until: server + 20 * DAY_MS });
  assert.equal(plus.state, 'checking'); await settle();
  for (let i = 0; i < 10; i++) { plus.pass(); await settle(); now += 1_000; }
  assert.equal(renewals, 1); assert.equal(plus.state, 'checking');
  // Agreeing clocks leave no correction (an answer's travel time is not a clock error).
  now = server + 2_000;
  plus.accept({ key: KEY, pass: passFor('sub_1', server + 24 * HOUR), until: server + 20 * DAY_MS, now: server });
  assert.equal((JSON.parse(store.getItem(PLUS_STORE)!) as { skew: number }).skew, 0);
});

test('only a refusal by the server ends a membership: a pass that ran out, or a busy server, is being checked', async () => {
  let now = 1_000_000_000_000;
  const { store } = memory();
  const calls: number[] = [];
  let answer: { status: number; body: unknown; retryAfter?: number } = { status: 429, body: { error: 'slow_down' }, retryAfter: 600 };
  const post: Post = () => { calls.push(now); return Promise.resolve(answer); };
  const plus = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  assert.equal(plus.state, 'none');
  plus.accept({ key: KEY, pass: passFor('sub_1', now + 24 * HOUR), until: now + 20 * DAY_MS, renews: true });
  assert.equal(plus.state, 'on'); assert.equal(plus.renews, true);
  // Back after thirty hours: the pass ran out, the server is busy and says to wait ten minutes.
  now += 30 * HOUR;
  assert.equal(plus.state, 'checking'); await settle();
  assert.equal(calls.length, 1);
  now += 5 * 60_000; plus.pass(); await settle();
  assert.equal(calls.length, 1, 'not before the server said');
  now += 5 * 60_000 + 1; answer = { status: 403, body: { error: 'not_active' } };
  plus.pass(); await settle();
  assert.equal(calls.length, 2); assert.equal(plus.state, 'ended'); assert.equal(plus.key, KEY);
  assert.equal(new Plus(store, post, () => now, () => 'https://plus.test/v1').state, 'ended', 'kept: another tab reads it');
});

test('a late refusal of a pass since replaced does not drop the new one', () => {
  const now = 1_000_000_000_000;
  const { store } = memory();
  const plus = new Plus(store, () => Promise.resolve({ status: 500, body: null }), () => now, () => 'https://plus.test/v1');
  const fresh = passFor('sub_1', now + 24 * HOUR), old = passFor('sub_1', now + 7 * HOUR);
  plus.accept({ key: KEY, pass: fresh, until: now + DAY_MS });
  plus.refused(old);
  assert.equal(plus.pass(), fresh);
  plus.refused(fresh);
  assert.equal(plus.pass(), null);
});

test('a browser that will not keep the membership says so, and a pass that runs out in an open tab is told', () => {
  let now = 1_000_000_000_000;
  const full: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  const plus = new Plus(full, () => new Promise(() => {}), () => now, () => 'https://plus.test/v1');
  assert.equal(plus.accept({ key: KEY, pass: passFor('sub_1', now + 24 * HOUR), until: now + DAY_MS }), false);
  assert.equal(plus.on, true, 'on for as long as this tab lives');
  let told = 0; plus.subscribe(() => { told++; });
  plus.tick(); assert.equal(told, 0, 'nothing changed, nothing told');
  now += 25 * HOUR;
  plus.tick(); assert.equal(told, 1, 'the pass ran out');
  plus.tick(); assert.equal(told, 1);
});

test('only the server’s own refusal ends a membership; any other 403 or 4xx keeps the pass and asks again in an hour', async () => {
  let now = 1_000_000_000_000;
  const { store } = memory();
  const calls: number[] = [];
  let answer: { status: number; body: unknown } = { status: 403, body: null };
  const post: Post = () => { calls.push(now); return Promise.resolve(answer); };
  const plus = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  plus.accept({ key: KEY, pass: passFor('sub_1', now + 5 * HOUR), until: now + 20 * DAY_MS });
  // A firewall's page (403 without the server's body): the membership stands, the pass is kept.
  plus.pass(); await settle();
  assert.equal(plus.state, 'on'); assert.equal(calls.length, 1);
  now += 30 * 60_000; plus.pass(); await settle();
  assert.equal(calls.length, 1, 'not asked again within the hour');
  for (const status of [400, 401, 404]) {
    now += HOUR + 1; answer = { status, body: { error: 'x' } };
    plus.pass(); await settle();
    assert.equal(plus.state, 'on', `a ${status} says nothing about the membership`);
  }
  assert.equal(calls.length, 4);
  // The server's refusal, with why.
  now += HOUR + 1; answer = { status: 403, body: { error: 'not_active', status: 'replaced' } };
  plus.pass(); await settle();
  assert.equal(plus.state, 'ended'); assert.equal(plus.why, 'replaced');
});

test('a frozen tab that wakes does not write its old pass over a newer one another tab stored', async () => {
  let now = 1_000_000_000_000;
  const { store } = memory();
  let n = 0;
  const post: Post = () => { n++; return Promise.resolve({ status: 200, body: { pass: passFor('sub_1', now + 24 * HOUR + n), until: now + DAY_MS } }); };
  const a = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  a.accept({ key: KEY, pass: passFor('sub_1', now + 5 * HOUR), until: now + DAY_MS });
  const b = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  // B renews; A is frozen and never saw the storage event.
  b.pass(); await settle();
  const fresh = b.pass();
  assert.ok(fresh && parsePass(fresh)!.exp > now + 23 * HOUR);
  // A wakes past the minute and asks first thing: it reads what B stored before it writes, and keeps it.
  now += 2 * 60_000;
  a.pass(); await settle();
  assert.equal(JSON.parse(store.getItem(PLUS_STORE)!).pass, fresh, 'storage still holds the newer pass');
  assert.equal(a.pass(), fresh); assert.equal(b.pass(), fresh);
  assert.equal(n, 1, 'and nothing was asked again: the newer pass is a day long');
});

test('a late refusal of an older renewal does not end a membership another tab has just renewed', async () => {
  let now = 1_000_000_000_000;
  const { store } = memory();
  let release: (v: { status: number; body: unknown }) => void = () => {};
  const slow: Post = () => new Promise(resolve => { release = resolve; });
  const quick: Post = () => Promise.resolve({ status: 200, body: { pass: passFor('sub_1', now + 24 * HOUR), until: now + DAY_MS } });
  const a = new Plus(store, slow, () => now, () => 'https://plus.test/v1');
  a.accept({ key: KEY, pass: passFor('sub_1', now + 5 * HOUR), until: now + DAY_MS });
  a.pass();
  // Another tab, past the shared wait, renews at once.
  now += 61_000;
  const b = new Plus(store, quick, () => now, () => 'https://plus.test/v1');
  b.pass(); await settle();
  // The older request now comes back refused.
  release({ status: 403, body: { error: 'not_active', status: 'canceled' } }); await settle();
  assert.equal(a.state, 'on', 'the later answer stands');
});

test('a request that never answers for one key does not stop a key accepted afterwards from renewing', async () => {
  let now = 1_000_000_000_000;
  const { store } = memory();
  const asked: string[] = [];
  const post: Post = (_url, body) => {
    const key = (body as { key: string }).key; asked.push(key);
    return key === KEY ? new Promise(() => {}) : Promise.resolve({ status: 200, body: { pass: passFor('sub_2', now + 24 * HOUR), until: now + DAY_MS } });
  };
  const plus = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  plus.accept({ key: KEY, pass: passFor('sub_1', now + 5 * HOUR), until: now + DAY_MS });
  plus.pass(); await settle();
  const other = 'o'.repeat(43);
  plus.accept({ key: other, pass: passFor('sub_2', now + 5 * HOUR), until: now + DAY_MS });
  plus.pass(); await settle();
  assert.deepEqual(asked, [KEY, other]);
  assert.equal(parsePass(plus.pass())!.exp, now + 24 * HOUR);
});

test('a storage that cannot be read for a moment does not drop the membership', () => {
  const now = 1_000_000_000_000;
  const { store, data } = memory();
  const flaky = { ...store, fail: false, getItem(key: string) { if (this.fail) throw new Error('busy'); return store.getItem(key); } };
  const plus = new Plus(flaky, () => Promise.resolve({ status: 500, body: null }), () => now, () => 'https://plus.test/v1');
  plus.accept({ key: KEY, pass: passFor('sub_1', now + 24 * HOUR), until: now + DAY_MS });
  flaky.fail = true; plus.reload();
  assert.equal(plus.state, 'on');
  flaky.fail = false; data.delete(PLUS_STORE); plus.reload();
  assert.equal(plus.state, 'none', 'a real removal is still taken over');
});

test('a short pass near a membership’s end is asked again within the hour, sooner when it is very short', async () => {
  let now = 1_000_000_000_000;
  const { store } = memory();
  const times: number[] = [];
  const end = now + 20 * 60_000;
  const post: Post = () => { times.push(now); return Promise.resolve({ status: 200, body: { pass: passFor('sub_1', end), until: end, renews: false } }); };
  const plus = new Plus(store, post, () => now, () => 'https://plus.test/v1');
  plus.accept({ key: KEY, pass: passFor('sub_1', end), until: end });
  plus.pass(); await settle();
  for (let i = 0; i < 30; i++) { now += 60_000; plus.pass(); await settle(); }
  // Twenty minutes left: the next ask is about ten minutes later, not an hour (when the pass is long gone) and not each minute.
  assert.ok(times.length >= 2 && times.length <= 4, `asked ${times.length} times in 30 minutes`);
});

/** A clock the test moves, with the page's interval timers on it. */
function fakeClock(start = 0) {
  let now = start;
  const timers = new Map<number, { every: number; next: number; run: () => void }>();
  let id = 0;
  return {
    clock: { now: () => now, every: (ms: number, run: () => void) => { const n = ++id; timers.set(n, { every: ms, next: now + ms, run }); return () => { timers.delete(n); }; } },
    timers,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.values()].filter(t => t.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next; due.next += due.every; due.run();
      }
      now = end;
    },
  };
}

test('right after Plus came on, the confirmation counts down to the map, which "Stay here" stops and nothing else starts', () => {
  const c = fakeClock(1_000_000), went: number[] = [], drawn: (ArrivalState | null)[] = [];
  const a = new Arrival(c.clock, () => { went.push(c.clock.now()); }, () => { drawn.push(a.state && { ...a.state }); });
  // Read through a function: an assertion that it is null would otherwise hold for the type ever after.
  const st = (): ArrivalState | null => a.state;
  assert.equal(a.state, null, 'nothing until the page says Plus came on');
  const until = Date.UTC(2026, 11, 18);
  a.start(until);
  assert.deepEqual(a.state, { until, left: ARRIVAL_SECONDS, counting: true });
  assert.equal(a.started, 1);
  c.advance(1_100);
  assert.equal(st()!.left, ARRIVAL_SECONDS - 1, 'a second gone');
  c.advance(2_000);
  assert.equal(st()!.left, 2);
  assert.deepEqual(drawn.map(d => d?.left), [5, 4, 3, 2], 'drawn again once a second, not at every tick');
  c.advance(2_000);
  assert.deepEqual(went, [1_000_000 + ARRIVAL_SECONDS * 1_000], 'to the map after the five seconds, once');
  assert.equal(a.state, null, 'gone before leaving: a page shown again from the browser\'s history holds no countdown');
  assert.equal(c.timers.size, 0, 'and its timer with it');
  c.advance(10_000);
  assert.equal(went.length, 1);

  // Stay here: the confirmation stays, the countdown stops, the map is never opened by itself; Close takes it away.
  a.start(null);
  assert.equal(a.started, 2, 'a new confirmation is drawn afresh');
  c.advance(2_500);
  a.stay();
  assert.deepEqual(a.state, { until: null, left: 3, counting: false });
  assert.equal(c.timers.size, 0);
  c.advance(30_000);
  assert.equal(went.length, 1, 'stayed');
  a.dismiss();
  assert.equal(a.state, null);

  // A browser that would not keep Plus: no countdown at all (leaving would lose it).
  a.start(until, false);
  assert.equal(st()!.counting, false); assert.equal(c.timers.size, 0);
  c.advance(30_000);
  assert.equal(went.length, 1);
  a.dismiss();

  // Following the link: nothing more is counted, and the page kept by the browser comes back still (pageshow: stay).
  a.start(until);
  c.advance(1_000);
  a.leaving();
  assert.equal(c.timers.size, 0);
  c.advance(30_000);
  assert.equal(went.length, 1);
  a.stay();
  assert.equal(st()!.counting, false);
});

test('the return to the map counts down only after a key typed into the key box: after a checkout or a restore the new key is shown, to be copied first', () => {
  assert.equal(countsDown('key', false, true, false), true, 'a key typed or pasted: back to the map in five seconds');
  assert.equal(countsDown('checkout', true, true, false), false, 'a checkout: the page shows the new key, and waits');
  assert.equal(countsDown('checkout', false, true, false), false, 'a checkout never counts down, the key shown or not');
  assert.equal(countsDown('restore', true, true, false), false, 'a restore shows the key too');
  assert.equal(countsDown('key', true, true, false), false, 'a key typed while the page shows the key (revealed before): it waits');
  assert.equal(countsDown('key', false, false, false), false, 'a browser that would not keep Plus: leaving would lose it');
  assert.equal(countsDown('key', false, true, true), false, 'the tab hidden when the answer comes: it waits for the visitor');
});

/** The page's document as the countdown listens to it: the listeners it adds, the view's scroll position, events fired at named targets. */
function fakeDocument() {
  const listeners = new Map<string, ((event: { type: string; target: unknown; key?: string }) => void)[]>();
  const doc: ArrivalDocument & { hidden: boolean; scrollY: number } = {
    hidden: false, scrollY: 0,
    addEventListener(type, listener) { const list = listeners.get(type) ?? []; list.push(listener); listeners.set(type, list); },
  };
  const fire = (type: string, target: unknown = 'page', key?: string): void => { for (const l of listeners.get(type) ?? []) l({ type, target, ...(key === undefined ? {} : { key }) }); };
  return { doc, types: () => [...listeners.keys()].sort(), fire };
}
/** An element as the countdown reads it: `closest` finds it for a list of selectors that names its tag (all these tests' elements need). */
const element = (tag: string): { tag: string; closest(selectors: string): unknown } => ({
  tag, closest(selectors: string) { return selectors.split(',').some(s => s.trim() === tag) ? this : null; },
});
/** The confirmation: its region, its Stay here button and its Open the map link. */
const BANNER = element('section'), STAY = element('button'), OPEN = element('a');
const ON_BANNER = new Set<unknown>([BANNER, STAY, OPEN]);
const place = (target: unknown): ArrivalPlace => placeOf(target, t => ON_BANNER.has(t));
const named = (target: unknown): string => typeof target === 'string' ? target : target === BANNER ? 'the confirmation' : target === STAY ? 'Stay here' : target === OPEN ? 'Open the map' : String(target);

test('on the page: a key accepted, then Reveal pressed within the five seconds: the key shows and the page stays', () => {
  const c = fakeClock(5_000_000), went: number[] = [];
  const a = new Arrival(c.clock, () => { went.push(c.clock.now()); }, () => {});
  const page = fakeDocument();
  stopOnActivity(page.doc, a, place, () => page.doc.scrollY);
  assert.deepEqual(page.types(), ['keydown', 'pointerdown', 'scroll', 'touchstart', 'visibilitychange', 'wheel']);
  a.start(Date.UTC(2026, 11, 18), countsDown('key', false, true, page.doc.hidden));
  c.advance(2_000);
  page.fire('pointerdown', BANNER); page.fire('pointerdown', STAY); page.fire('keydown', BANNER, 'Tab'); page.fire('keydown', STAY, ' ');
  assert.equal(a.state!.counting, true, 'its own presses and keys are the confirmation\'s: its buttons do what they say (Space presses Stay here)');
  page.fire('pointerdown', 'Reveal');
  assert.equal(a.state!.counting, false, 'Reveal pressed: the countdown stops');
  c.advance(30_000);
  assert.deepEqual(went, [], 'and the page never leaves by itself');
  assert.ok(a.state, 'the confirmation stays, the map a press away');
});

test('on the page: a key, a touch, the wheel or a scroll stops the countdown at once, the wheel and scrolling keys over the confirmation too', () => {
  const c = fakeClock(6_000_000), went: number[] = [];
  const a = new Arrival(c.clock, () => { went.push(c.clock.now()); }, () => {});
  const page = fakeDocument(), activity = stopOnActivity(page.doc, a, place, () => page.doc.scrollY);
  const fresh = (): void => { a.start(null, true); c.advance(100); assert.equal(a.state!.counting, true); };
  for (const [type, target, key] of [['keydown', 'the key field', 'a'], ['touchstart', 'Copy', undefined], ['wheel', 'page', undefined], ['wheel', BANNER, undefined],
    ['keydown', BANNER, 'PageDown'], ['keydown', OPEN, 'ArrowDown'], ['keydown', BANNER, ' '], ['keydown', OPEN, 'End']] as const) {
    fresh(); page.fire(type, target, key);
    assert.equal(a.state!.counting, false, `${type} ${named(target)} ${key ?? ''}`);
  }
  // The drawing's own scroll (the page grew shorter and the browser moved the view) lands where the drawing left the view: let pass, once.
  fresh(); activity.redraw(() => { page.doc.scrollY = 380; }); page.fire('scroll', page.doc);
  assert.equal(a.state!.counting, true, 'the page\'s own scroll');
  page.doc.scrollY = 420; page.fire('scroll', page.doc);
  assert.equal(a.state!.counting, false, 'a scroll anywhere else is the visitor\'s, however early');
  fresh(); activity.redraw(() => {}); page.doc.scrollY += 40; page.fire('scroll', page.doc);
  assert.equal(a.state!.counting, false, 'a scroll right after the confirmation came, not the drawing\'s: stops it');
  fresh(); page.fire('scroll', 'a scrolling box');
  assert.equal(a.state!.counting, false, 'a box scrolled inside the page');
  c.advance(30_000);
  assert.deepEqual(went, []);
});

test('on the page: a drawing that comes between the visitor\'s swipe and its scroll event does not swallow the swipe', () => {
  const c = fakeClock(7_000_000), went: number[] = [];
  const a = new Arrival(c.clock, () => { went.push(c.clock.now()); }, () => {});
  const page = fakeDocument(), activity = stopOnActivity(page.doc, a, place, () => page.doc.scrollY);
  const fresh = (): void => { a.start(null, true); c.advance(100); assert.equal(a.state!.counting, true); };
  // A swipe moves the view and its scroll event waits for the next frame; a server's answer draws the page first, leaving the view where it is.
  fresh(); page.doc.scrollY = 300; activity.redraw(() => {}); page.fire('scroll', page.doc);
  assert.equal(a.state!.counting, false, 'the swipe stops the countdown');
  // The same, the drawing moving the view too (the page grew shorter): the swipe was under way first, so the one scroll event counts.
  fresh(); page.doc.scrollY = 900; activity.redraw(() => { page.doc.scrollY = 850; }); page.fire('scroll', page.doc);
  assert.equal(a.state!.counting, false, 'a movement under way before the drawing counts, wherever the view ends');
  // Nothing under way: the drawing's own move is let pass, once, and a second drawing that leaves the view alone keeps it so.
  fresh(); activity.redraw(() => { page.doc.scrollY = 700; }); activity.redraw(() => {}); page.fire('scroll', page.doc);
  assert.equal(a.state!.counting, true, 'the drawing\'s own scroll');
  page.doc.scrollY = 690; page.fire('scroll', page.doc);
  assert.equal(a.state!.counting, false, 'once only');
  // Scrolls made while no countdown runs are followed too: a countdown started afterwards does not take them for a movement under way.
  page.doc.scrollY = 1_200; page.fire('scroll', page.doc);
  fresh(); activity.redraw(() => { page.doc.scrollY = 1_100; }); page.fire('scroll', page.doc);
  assert.equal(a.state!.counting, true, 'the drawing\'s own scroll after the visitor scrolled with no countdown');
  assert.deepEqual(went, []);
  c.advance(ARRIVAL_SECONDS * 1_000 + 300);
  assert.equal(went.length, 1, 'that countdown, left alone, takes the page to the map');
});

test('on the confirmation: Space presses its button but scrolls from its link, so on the link it stops the countdown, at the page\'s foot too', () => {
  const c = fakeClock(8_000_000), went: number[] = [];
  const a = new Arrival(c.clock, () => { went.push(c.clock.now()); }, () => {});
  const page = fakeDocument();
  stopOnActivity(page.doc, a, place, () => page.doc.scrollY);
  assert.deepEqual([place(STAY), place(OPEN), place(BANNER), place(element('button')), place('page')], ['control', 'confirmation', 'confirmation', 'page', 'page'],
    'its button is a control Space presses; its link is not (Space scrolls from a link); a button of the page is the page');
  // Its button: Space presses it (Stay here, whose own press decides), so the key alone does not stop the countdown.
  a.start(null, true); c.advance(100);
  page.fire('keydown', STAY, ' ');
  assert.equal(a.state!.counting, true, 'Space on the button');
  // Its link, the page free to scroll: Space scrolls it, and the key stops the countdown before the scroll comes.
  page.fire('keydown', OPEN, ' ');
  assert.equal(a.state!.counting, false, 'Space on the link');
  page.doc.scrollY += 600; page.fire('scroll', page.doc);
  assert.equal(a.state!.counting, false);
  // Its link, the page already at its foot: Space moves nothing and no scroll follows; the key alone stops the countdown.
  a.start(null, true); c.advance(100);
  page.fire('keydown', OPEN, ' ');
  assert.equal(a.state!.counting, false, 'Space on the link at the page\'s foot, no scroll after it');
  // Enter on the link opens the map: that is the link's own press, not something else done on the page.
  a.start(null, true); c.advance(100);
  page.fire('keydown', OPEN, 'Enter');
  assert.equal(a.state!.counting, true, 'Enter on the link');
  assert.deepEqual(went, []);
});

test('on the page: the tab hidden while the countdown runs stops it, and showing the tab again does not start it again', () => {
  const c = fakeClock(9_000_000), went: number[] = [];
  const a = new Arrival(c.clock, () => { went.push(c.clock.now()); }, () => {});
  const page = fakeDocument();
  stopOnActivity(page.doc, a, () => 'page', () => page.doc.scrollY);
  a.start(null, true);
  c.advance(1_500);
  page.doc.hidden = true; page.fire('visibilitychange', page.doc);
  assert.equal(a.state!.counting, false);
  c.advance(60_000);
  page.doc.hidden = false; page.fire('visibilitychange', page.doc);
  assert.equal(a.state!.counting, false, 'not resumed');
  c.advance(60_000);
  assert.deepEqual(went, [], 'the page stays where the visitor left it');
  // Without any of it, the countdown still takes the page back to the map.
  a.start(null, true); c.advance(ARRIVAL_SECONDS * 1_000 + 300);
  assert.equal(went.length, 1);
});

test('on the page: a key sent, the tab hidden before the server answers: the confirmation comes without a countdown, and stays', () => {
  const c = fakeClock(12_000_000), went: number[] = [];
  const a = new Arrival(c.clock, () => { went.push(c.clock.now()); }, () => {});
  const page = fakeDocument();
  stopOnActivity(page.doc, a, place, () => page.doc.scrollY);
  page.doc.hidden = true; page.fire('visibilitychange', page.doc);
  // The answer comes while the tab is hidden: the page starts the confirmation as it does (page.ts `arrived`).
  a.start(Date.UTC(2026, 11, 18), countsDown('key', false, true, page.doc.hidden));
  assert.ok(a.state && !a.state.counting, 'shown, not counting');
  page.doc.hidden = false; page.fire('visibilitychange', page.doc);
  c.advance(60_000);
  assert.deepEqual(went, [], 'the visitor comes back to the confirmation, not to the map');
  assert.ok(a.state);
});
