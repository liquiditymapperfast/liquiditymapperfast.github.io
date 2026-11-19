import test from 'node:test';
import assert from 'node:assert/strict';
import { Plus, type Post } from '../src/app/plus/pass.ts';
import { activateKey, keyAnswer, keyShaped, maskKey, onText, plusDate } from '../src/app/plus/key.ts';
import { copyKey, plusButtonAction, popPress, popView, type PopUi } from '../src/app/plus/panel.ts';

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const passFor = (sub: string, exp: number): string => `v1.${b64url(JSON.stringify({ sub, exp }))}.c2lnbmF0dXJl`;
const KEY = 'gift_k'.padEnd(43, 'x');
const HOUR = 3_600_000, NOW = Date.UTC(2026, 10, 19, 6), UNTIL = Date.UTC(2027, 1, 19);
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const memory = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => { const data = new Map<string, string>(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } }; };
const IDLE: PopUi = { mode: 'idle', revealed: null, removed: false };

test('the toolbar\'s Plus button: a browser without a key gets the presentation; one with a key, on, ended or being checked, its status', () => {
  assert.equal(plusButtonAction('none'), 'sheet');
  for (const s of ['on', 'ended', 'checking'] as const) assert.equal(plusButtonAction(s), 'status', s);
});

test('the status pop-up for each state: on with the key masked, ended with a key field, checking, could not verify with Try again, removed', () => {
  const on = popView({ state: 'on', until: UNTIL, key: KEY, unverified: false }, IDLE);
  assert.deepEqual(on.status, { tone: 'ok', text: `Plus is on in this browser, until ${plusDate(UNTIL)}.` });
  assert.equal(on.key, maskKey(KEY)); assert.ok(!on.key!.includes(KEY.slice(6, 30)), 'the key masked until Reveal');
  assert.deepEqual(on.actions, ['replace', 'remove']); assert.equal(on.entry, false); assert.equal(on.confirm, null);
  assert.equal(popView({ state: 'on', until: UNTIL, key: KEY, unverified: false }, { ...IDLE, revealed: KEY }).key, KEY, 'revealed');
  assert.equal(popView({ state: 'on', until: null, key: KEY, unverified: false }, IDLE).status!.text, 'Plus is on in this browser.', 'no date said: none written');
  const ended = popView({ state: 'ended', until: UNTIL, key: KEY, unverified: false }, IDLE);
  assert.deepEqual(ended.status, { tone: 'plain', text: `Plus ended on ${plusDate(UNTIL)}. Everything free stays.` });
  assert.equal(ended.key, null, 'a key that opens nothing is not offered for copying'); assert.equal(ended.entry, true, 'a key field for another key');
  assert.equal(popView({ state: 'ended', until: null, key: KEY, unverified: false }, IDLE).status!.text, 'Plus has ended in this browser. Everything free stays.');
  const checking = popView({ state: 'checking', until: UNTIL, key: KEY, unverified: false }, IDLE);
  assert.deepEqual(checking.status, { tone: 'checking', text: 'Checking Plus with the server…' }); assert.deepEqual(checking.actions, []);
  const failed = popView({ state: 'checking', until: UNTIL, key: KEY, unverified: true }, IDLE);
  assert.deepEqual(failed.status, { tone: 'error', text: 'Couldn\'t verify Plus. Check your connection.' }, 'never "ended": the key may be fine');
  assert.deepEqual(failed.actions, ['retry']);
  assert.deepEqual(popView({ state: 'none', until: null, key: null, unverified: false }, { ...IDLE, removed: true }).status, { tone: 'ok', text: 'Key removed from this browser.' });
});

test('Remove asks first, saying it does not cancel a subscription; Keep and Cancel go back; Reveal shows and hides the key', () => {
  let ui = popPress(IDLE, 'remove').ui;
  const asking = popView({ state: 'on', until: UNTIL, key: KEY, unverified: false }, ui);
  assert.equal(asking.confirm, 'Remove your key from this browser? This doesn\'t cancel a subscription.');
  assert.deepEqual(asking.actions, ['remove-yes', 'remove-no']);
  assert.deepEqual(popPress(ui, 'remove-no'), { ui: IDLE, effect: null }, 'Keep: nothing removed');
  const yes = popPress(ui, 'remove-yes');
  assert.equal(yes.effect, 'forget'); assert.deepEqual(yes.ui, { mode: 'idle', revealed: null, removed: true });
  ui = popPress(IDLE, 'replace').ui;
  const replacing = popView({ state: 'on', until: UNTIL, key: KEY, unverified: false }, ui);
  assert.equal(replacing.entry, true); assert.deepEqual(replacing.actions, ['cancel']);
  assert.deepEqual(popPress(ui, 'cancel').ui, IDLE);
  assert.equal(popPress(IDLE, 'reveal', KEY).ui.revealed, KEY); assert.equal(popPress({ ...IDLE, revealed: KEY }, 'reveal', KEY).ui.revealed, null);
  assert.equal(popPress(IDLE, 'retry').effect, 'retry');
});

test('Copy puts the key on the clipboard where the browser allows it, else the key is shown selected for the person to copy', async () => {
  const wrote: string[] = [];
  assert.equal(await copyKey(KEY, { writeText: async (s: string) => { wrote.push(s); } }), 'copied');
  assert.deepEqual(wrote, [KEY]);
  assert.equal(await copyKey(KEY, { writeText: () => Promise.reject(new Error('NotAllowedError')) }), 'select', 'refused: selected instead');
  assert.equal(await copyKey(KEY, undefined), 'select', 'no clipboard at all');
});

test('what the server answers to a key: on, not recognized, no longer opens Plus, not reached, too many tries, or a refusal that is not the server\'s', () => {
  const grant = { pass: passFor('gift_x', NOW + 24 * HOUR), paidUntil: UNTIL, renews: false, now: NOW };
  assert.equal(keyAnswer({ status: 200, body: grant }).kind, 'grant');
  assert.deepEqual(keyAnswer(null), { kind: 'offline', text: 'Couldn\'t verify Plus. Check your connection.' });
  assert.equal(keyAnswer({ status: 502, body: null }).kind, 'offline');
  assert.deepEqual(keyAnswer({ status: 400, body: { error: 'bad_request' } }), { kind: 'invalid', text: 'That key wasn\'t recognized. Check it and try again.' });
  assert.equal(keyAnswer({ status: 403, body: { error: 'not_active', status: 'unknown' } }).kind, 'invalid');
  for (const status of ['replaced', 'canceled', 'gift_ended']) assert.equal(keyAnswer({ status: 403, body: { error: 'not_active', status } }).kind, 'ended', status);
  assert.deepEqual(keyAnswer({ status: 429, body: null, retryAfter: 90 }), { kind: 'busy', text: 'Too many tries. Try again in 2 min.' });
  assert.deepEqual(keyAnswer({ status: 429, body: null }), { kind: 'busy', text: 'Too many tries. Try again later.' });
  for (const a of [{ status: 403, body: '<html>challenge</html>' }, { status: 404, body: null }, { status: 400, body: null }, { status: 200, body: { pass: 'nonsense' } }]) assert.equal(keyAnswer(a).kind, 'refused', JSON.stringify(a));
});

test('a key entered in the app is sent to the renewal alone, taken as the membership on a grant, and a key of no key\'s shape is never sent', async () => {
  const sent: { url: string; body: unknown }[] = [];
  const grant = { pass: passFor('gift_x', NOW + 24 * HOUR), paidUntil: UNTIL, renews: false, now: NOW };
  const post: Post = async (url, body) => { sent.push({ url, body }); return { status: 200, body: grant }; };
  const accepted: unknown[] = [];
  const member = { generation: () => 0, acceptIf: (_gen: number, g: unknown) => { accepted.push(g); return 'kept' as const; } };
  const ok = await activateKey(`  ${KEY}  `, { post, api: () => 'http://127.0.0.1:8799/v1', member });
  assert.equal(ok.kind, 'ok');
  assert.deepEqual(sent, [{ url: 'http://127.0.0.1:8799/v1/pass/renew', body: { key: KEY } }], 'trimmed, to the renewal, nothing else');
  assert.deepEqual(accepted, [{ key: KEY, pass: grant.pass, until: UNTIL, renews: false, now: NOW }]);
  assert.equal(onText(ok.kind === 'ok' ? ok.grant.until : null), `Plus is on in this browser, until ${plusDate(UNTIL)}.`);
  assert.equal((await activateKey('short', { post, member })).kind, 'invalid');
  assert.equal((await activateKey('has a space in it, sixteen+', { post, member })).kind, 'invalid');
  assert.equal(sent.length, 1, 'neither was sent');
  assert.ok(keyShaped(KEY) && !keyShaped('x'.repeat(15)) && !keyShaped('x'.repeat(201)));
  const offline = await activateKey(KEY, { post: () => Promise.reject(new TypeError('Failed to fetch')), member });
  assert.equal(offline.kind, 'offline');
  const kept = await activateKey(KEY, { post, member: { generation: () => 0, acceptIf: () => 'unkept' as const } });
  assert.deepEqual(kept.kind === 'ok' && kept.kept, false, 'a browser that will not keep it is said');
});

test('a renewal that cannot reach the server leaves Plus unverified (never ended); Try again asks at once, and an answer clears it', async () => {
  let now = NOW, answer: 'down' | 'grant' | 'throw' = 'throw';
  const post: Post = async () => {
    if (answer === 'throw') throw new TypeError('Failed to fetch');
    if (answer === 'down') return { status: 503, body: null };
    return { status: 200, body: { pass: passFor('gift_x', now + 24 * HOUR), paidUntil: UNTIL, now } };
  };
  const member = new Plus(memory(), post, () => now, () => 'http://127.0.0.1:8799/v1');
  member.accept({ key: KEY, pass: passFor('gift_x', now - HOUR), until: UNTIL });
  assert.equal(member.state, 'checking'); assert.equal(member.unverified, false);
  let told = 0; member.subscribe(() => { told++; });
  member.renew(); assert.equal(member.renewing, true);
  await flush();
  assert.equal(member.renewing, false); assert.equal(member.unverified, true); assert.equal(member.state, 'checking', 'not ended');
  assert.ok(told >= 1, 'the pop-up is told');
  answer = 'down'; now += 5_000;
  member.renew(); await flush();
  assert.equal(member.unverified, true, 'a minute has not passed: not asked again by itself');
  member.retry(); assert.equal(member.unverified, false, 'Try again: checking again'); await flush();
  assert.equal(member.unverified, true, 'a server that is down: still unverified');
  answer = 'grant';
  member.retry(); await flush();
  assert.equal(member.state, 'on'); assert.equal(member.unverified, false);
  member.forget(); assert.equal(member.state, 'none'); assert.equal(member.unverified, false);
});
