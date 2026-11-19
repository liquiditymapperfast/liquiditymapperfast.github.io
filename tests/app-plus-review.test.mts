// Sol's review of the Plus pop-up and key entry (round 1, 2026-11-19): each finding's case, which the code before the fixes failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLUS_STORE, Plus, type Post } from '../src/app/plus/pass.ts';
import { activateKey } from '../src/app/plus/key.ts';

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const passFor = (sub: string, exp: number): string => `v1.${b64url(JSON.stringify({ sub, exp }))}.c2lnbmF0dXJl`;
const HOUR = 3_600_000, NOW = Date.UTC(2026, 10, 19, 7), UNTIL = Date.UTC(2027, 1, 19);
const KEY_A = 'gift_aaaa'.padEnd(43, 'a'), KEY_B = 'gift_bbbb'.padEnd(43, 'b'), KEY_C = 'gift_cccc'.padEnd(43, 'c');
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
/** One `localStorage` two tabs share (no storage events: a tab sees the other's writes only when it reads). */
function shared(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
}
const grantFor = (key: string, now = NOW): { status: number; body: unknown } => ({ status: 200, body: { pass: passFor(key.slice(0, 9), now + 24 * HOUR), paidUntil: UNTIL, now } });
/** A server whose answers wait until the test gives them. */
function deferred(): { post: Post; asked: { key: string; signal?: AbortSignal; answer: (a: { status: number; body: unknown }) => void }[] } {
  const asked: { key: string; signal?: AbortSignal; answer: (a: { status: number; body: unknown }) => void }[] = [];
  return { asked, post: (_url, body, signal) => new Promise(resolve => { asked.push({ key: (body as { key: string }).key, ...(signal ? { signal } : {}), answer: resolve }); }) };
}
const stored = (s: ReturnType<typeof shared>): string | null => { const raw = s.data.get(PLUS_STORE); return raw ? (JSON.parse(raw) as { key: string }).key : null; };

test('Sol 1 (P1): a key given up before its answer is never taken: Replace with B, Cancel, Remove A, then B\'s answer: Plus stays removed', async () => {
  const storage = shared(), server = deferred();
  const tab = new Plus(storage, server.post, () => NOW);
  tab.accept({ key: KEY_A, pass: passFor('gift_a', NOW + 24 * HOUR), until: UNTIL });
  const given = new AbortController();
  const outcome = activateKey(KEY_B, { post: server.post, member: tab, signal: given.signal });
  given.abort(); tab.forget();
  server.asked[0]!.answer(grantFor(KEY_B));
  assert.deepEqual(await outcome, { kind: 'abandoned' });
  assert.equal(tab.state, 'none'); assert.equal(stored(storage), null, 'nothing written back');
});

test('Sol 1 (P1): a newer key another tab stored wins over a late answer here; an answer for the same membership is taken', async () => {
  const storage = shared(), server = deferred();
  const here = new Plus(storage, server.post, () => NOW), there = new Plus(storage, server.post, () => NOW);
  const outcome = activateKey(KEY_B, { post: server.post, member: here });
  there.accept({ key: KEY_C, pass: passFor('gift_c', NOW + 24 * HOUR), until: UNTIL });
  server.asked[0]!.answer(grantFor(KEY_B));
  assert.deepEqual(await outcome, { kind: 'stale' });
  assert.equal(stored(storage), KEY_C, 'C stays'); here.reload(); assert.equal(here.key, KEY_C);
  // Nothing changed meanwhile: taken.
  const again = activateKey(KEY_B, { post: server.post, member: here });
  server.asked[1]!.answer(grantFor(KEY_B));
  assert.equal((await again).kind, 'ok'); assert.equal(stored(storage), KEY_B);
});

test('Sol 2 (P1): Try again never brings back a key another tab removed or replaced before this tab heard of it', async () => {
  for (const other of ['removed', 'replaced'] as const) {
    const storage = shared(), sent: string[] = [];
    const post: Post = async (_url, body) => { sent.push((body as { key: string }).key); throw new TypeError('Failed to fetch'); };
    const here = new Plus(storage, post, () => NOW), there = new Plus(storage, post, () => NOW);
    here.accept({ key: KEY_A, pass: passFor('gift_a', NOW - HOUR), until: UNTIL });
    here.renew(); await flush();
    assert.equal(here.unverified, true, `${other}: could not verify`);
    there.reload();
    if (other === 'removed') there.forget(); else there.accept({ key: KEY_C, pass: passFor('gift_c', NOW + 24 * HOUR), until: UNTIL });
    sent.length = 0;
    here.retry(); await flush();
    assert.equal(stored(storage), other === 'removed' ? null : KEY_C, `${other}: what the other tab left stays`);
    assert.ok(!sent.includes(KEY_A), `${other}: the old key is not asked about again`);
    assert.equal(here.key, other === 'removed' ? null : KEY_C, `${other}: this tab follows`);
  }
});
