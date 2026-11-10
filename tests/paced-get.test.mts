import test from 'node:test';
import assert from 'node:assert/strict';
import { pacedFetcher, saysTooMany } from '../src/app/paced-get.ts';

const tick = (ms = 0): Promise<void> => new Promise(r => setTimeout(r, ms));

test('one host has at most a few requests out at a time; another host has its own queue', async () => {
  let out = 0, most = 0;
  const started: string[] = [];
  const get = async (url: string): Promise<unknown> => { started.push(url); out++; most = Math.max(most, out); await tick(5); out--; return []; };
  const paced = pacedFetcher(get, { perHost: 2 });
  await Promise.all([...Array.from({ length: 6 }, (_, i) => paced(`https://api.a.test/k?${i}`)), paced('https://api.b.test/k')]);
  assert.equal(started.length, 7, 'every request goes, in turn');
  assert.ok(most <= 3, `two of one host and one of the other at most: ${most}`);
  assert.ok(started.indexOf('https://api.b.test/k') < 3, 'the other host does not wait behind the first one\'s queue');
});

test('after a venue says it was asked too often, its host waits, longer each time, and is back to the shortest after a request goes through', async () => {
  let clock = 0, limited = 2;
  const at: number[] = [];
  const get = async (): Promise<unknown> => { at.push(clock); if (limited > 0) { limited--; throw Object.assign(new Error('HTTP 429'), { status: 429 }); } return { retCode: 0 }; };
  const paced = pacedFetcher(get, { perHost: 1, cooldownMs: 20, maxCooldownMs: 1_000, now: () => clock });
  await assert.rejects(paced('https://x.test/1'), /429/);
  // Its refusal is expected now, so it is not taken for one nobody handled while the test waits.
  const second = assert.rejects(paced('https://x.test/2'), /429/);
  await tick(5); assert.equal(at.length, 1, 'waits out the first cooldown');
  clock = 25; await tick(30); await second;
  assert.equal(at.length, 2);
  const third = paced('https://x.test/3');
  clock = 50; await tick(30); assert.equal(at.length, 2, 'the second wait is twice as long (40 ms from 25)');
  clock = 70; await tick(30); assert.deepEqual(await third, { retCode: 0 });
  assert.equal(at.length, 3);
  // An answer that says it inside a 200 counts the same; the request still answers (its page then fails on the code).
  const said = pacedFetcher(async () => ({ retCode: 10006, result: {} }), { perHost: 1, cooldownMs: 50, now: () => clock });
  assert.deepEqual(await said('https://y.test/1'), { retCode: 10006, result: {} });
  let waited = true;
  void said('https://y.test/2').then(() => { waited = false; });
  await tick(20); assert.equal(waited, true, 'the next one waits');
  clock += 100; await tick(80); assert.equal(waited, false, 'then goes');
});

test('what counts as a venue saying it was asked too often', () => {
  for (const yes of [{ status: 429 }, { status: 418 }, { retCode: 10006 }, { retCode: 10018 }, { code: '50011' }, { code: '50061' }, { code: '429' }]) assert.equal(saysTooMany(yes), true, JSON.stringify(yes));
  for (const no of [null, [], { status: 500 }, { retCode: 0 }, { retCode: 10001 }, { code: '0' }, { code: '00000' }, { code: -1121 }, 'x']) assert.equal(saysTooMany(no), false, JSON.stringify(no));
});

test('a request given up while it waits its turn leaves the queue at once and is never sent (Sol, code review 2026-11-10)', async () => {
  let release: () => void = () => {};
  const sent: string[] = [];
  const get = async (url: string): Promise<unknown> => { sent.push(url); if (url.endsWith('/1')) await new Promise<void>(r => { release = r; }); return []; };
  const paced = pacedFetcher(get, { perHost: 1 });
  const first = paced('https://z.test/1');
  const stop = new AbortController();
  const second = paced('https://z.test/2', { signal: stop.signal });
  await tick(5);
  stop.abort();
  await assert.rejects(second, /abort/i);
  release(); await first;
  await tick(5);
  assert.deepEqual(sent, ['https://z.test/1'], 'the one given up was never sent');
  const done = new AbortController(); done.abort();
  await assert.rejects(paced('https://z.test/3', { signal: done.signal }), /abort/i, 'one given up before it was asked is not queued');
});
