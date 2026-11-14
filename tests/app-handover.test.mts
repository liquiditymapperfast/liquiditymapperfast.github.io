import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildIn } from '../src/app/update-check.ts';
import { DONE_KEY, MAX_CHARS, OLD_ORIGIN, PREFIX, decide, decode, encode, handedKey, itemsOf, write } from '../src/app/handover.ts';

const REFERRER = `${OLD_ORIGIN}/`;
const pack = (items: Record<string, unknown>, v: unknown = 1): string => PREFIX + encode(JSON.stringify({ v, items }));
const none = (): boolean => false;

test('the fragment form round-trips any text, multi-byte included, in URL-safe characters with no padding', () => {
  for (const text of ['', 'a', '{"x":"€ 日本 🚀"}', 'x'.repeat(100_000)]) {
    const data = encode(text);
    assert.match(data, /^[A-Za-z0-9_-]*$/);
    assert.equal(decode(data), text);
  }
  assert.equal(decode('a+b/'), null, 'standard base64 is not the form');
  assert.equal(decode('_w'), null, 'bytes that are not UTF-8');
});

test('a hand-over writes only the page\'s own keys, never the cached coin list, the stale marks or the marker', () => {
  for (const key of ['hlm-app-v2', 'hlm-drawings-v1', 'hlm-scripts-v1', 'lmf.coin', 'lmf.coin.saved', 'lmf.venues.known']) assert.ok(handedKey(key), key);
  for (const key of ['lmf.coins', 'hlm-stale', 'hlm-stale-reload', DONE_KEY, 'other', 'HLM-app', 'hlm-', 'lmf.', `hlm-${'x'.repeat(81)}`, '__proto__']) assert.equal(handedKey(key), false, key);
  assert.equal(itemsOf(JSON.stringify({ v: 1, items: { 'hlm-app-v2': '{}', 'lmf.coins': '[]' } })), null, 'one key it may not write refuses all');
  assert.equal(itemsOf(JSON.stringify({ v: 1, items: { 'hlm-app-v2': 3 } })), null, 'values are strings');
  assert.equal(itemsOf(JSON.stringify({ v: 2, items: { 'hlm-app-v2': '{}' } })), null, 'another version');
  assert.equal(itemsOf(JSON.stringify({ v: 1, items: {} })), null, 'nothing to take');
  assert.equal(itemsOf(JSON.stringify({ v: 1, items: ['x'] })), null);
  assert.equal(itemsOf('not json'), null);
  assert.deepEqual(itemsOf(JSON.stringify({ v: 1, items: { 'hlm-app-v2': '{"a":1}', 'lmf.coin': 'ETH' } })), { 'hlm-app-v2': '{"a":1}', 'lmf.coin': 'ETH' });
});

test('it is taken only from the old address, once, into a browser with no layouts, drawings or scripts of its own, whole', () => {
  const hash = pack({ 'hlm-app-v2': '{"timeframe":"5m"}', 'hlm-scripts-v1': '[]' });
  assert.deepEqual(decide(hash, REFERRER, none), { take: { 'hlm-app-v2': '{"timeframe":"5m"}', 'hlm-scripts-v1': '[]' } });
  assert.deepEqual(decide(hash, OLD_ORIGIN, none), { take: { 'hlm-app-v2': '{"timeframe":"5m"}', 'hlm-scripts-v1': '[]' } }, 'the bare origin');
  assert.deepEqual(decide(hash, `${OLD_ORIGIN}/some/path?x=1`, none).hasOwnProperty('take'), true, 'any page of it');
  for (const referrer of ['', 'https://evil.example/', 'https://liquiditymapperfast.github.io.evil.example/', 'http://liquiditymapperfast.github.io/', 'https://liquiditymapper.com/']) {
    assert.deepEqual(decide(hash, referrer, none), { skip: 'referrer' }, referrer || '(no referrer)');
  }
  assert.deepEqual(decide(hash, REFERRER, key => key === DONE_KEY), { skip: 'done' });
  for (const own of ['hlm-layouts-v1', 'hlm-drawings-v1', 'hlm-scripts-v1']) assert.deepEqual(decide(hash, REFERRER, key => key === own), { skip: 'own-work' }, own);
  assert.deepEqual(decide(hash, REFERRER, key => key === 'hlm-app-v2'), decide(hash, REFERRER, none), 'settings alone are not work: they are replaced');
  assert.deepEqual(decide('#guide', REFERRER, none), { skip: 'none' });
  assert.deepEqual(decide('', REFERRER, none), { skip: 'none' });
  assert.deepEqual(decide(`${PREFIX}%%%`, REFERRER, none), { skip: 'malformed' });
  assert.deepEqual(decide(pack({ 'lmf.coins': '[]' }), REFERRER, none), { skip: 'malformed' });
  assert.deepEqual(decide(PREFIX + 'A'.repeat(MAX_CHARS + 4), REFERRER, none), { skip: 'malformed' }, 'too long is not read');
});

test('the items are written all or none, then the marker; a full storage gets back what each key held before', () => {
  const of = (store: Map<string, string>, tooBig = '') => ({
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { if (v === tooBig) throw new Error('quota'); store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  const store = new Map<string, string>();
  assert.equal(write(of(store), { 'hlm-app-v2': 'a', 'lmf.coin': 'ETH' }, 1_800_000_000_000), true);
  assert.deepEqual([...store], [['hlm-app-v2', 'a'], ['lmf.coin', 'ETH'], [DONE_KEY, '1800000000000']]);

  const full = new Map<string, string>([['hlm-lang', 'de'], ['hlm-app-v2', 'old']]);
  const tight = of(full, 'b');
  assert.equal(write(tight, { 'hlm-app-v2': 'new', 'hlm-scripts-v1': 'b' }, 1), false);
  assert.deepEqual(Object.fromEntries(full), { 'hlm-lang': 'de', 'hlm-app-v2': 'old' }, 'what was there is as it was, nothing new stays');
  assert.equal(full.has(DONE_KEY), false, 'no marker: a later visit may try again');
});

test('the old address\'s page sends what the new one takes: same keys, same form, the coin list and stale marks left behind', () => {
  for (const file of ['moved-site/index.html', 'moved-site/404.html']) {
    const html = readFileSync(file, 'utf8');
    assert.equal(buildIn(html), 'moved-v1a2026.js', `${file}: an open tab on the old site is offered Reload`);
    const code = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const context: Record<string, unknown> = { TextEncoder, btoa };
    vm.runInNewContext(code, context);
    const moved = context.Moved as { target(loc: { pathname: string; search: string; hash: string }, storage: unknown): string };
    const entries: [string, string][] = [['hlm-app-v2', '{"tf":"5m","name":"日本 🚀"}'], ['lmf.coins', '[big]'], ['hlm-stale', '1'], ['lmf.coin', 'ETH'], ['other', 'x'], ['hlm-handover-v1', '1']];
    const storage = { length: entries.length, key: (i: number) => entries[i]?.[0] ?? null, getItem: (k: string) => entries.find(e => e[0] === k)?.[1] ?? null };
    const to = moved.target({ pathname: '/', search: '?coin=ETH', hash: '' }, storage);
    const url = new URL(to);
    assert.equal(url.origin + url.pathname + url.search, 'https://liquiditymapper.com/?coin=ETH');
    assert.deepEqual(decide(url.hash, `${OLD_ORIGIN}/`, none), { take: { 'hlm-app-v2': '{"tf":"5m","name":"日本 🚀"}', 'lmf.coin': 'ETH' } });
    const empty = { length: 0, key: () => null, getItem: () => null };
    assert.equal(moved.target({ pathname: '/', search: '', hash: '#guide/ladder' }, empty), 'https://liquiditymapper.com/#guide/ladder', 'a guide link keeps its place when there is nothing to carry');
    assert.equal(moved.target({ pathname: '/llms.txt', search: '', hash: '' }, storage), 'https://liquiditymapper.com/llms.txt', 'other paths go to the same path, carrying nothing');
    assert.equal(moved.target({ pathname: '/index.html', search: '', hash: '#x' }, empty), 'https://liquiditymapper.com/');
  }
  assert.equal(readFileSync('moved-site/index.html', 'utf8'), readFileSync('moved-site/404.html', 'utf8'), 'one page for both');
});
