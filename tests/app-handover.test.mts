import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildIn } from '../src/app/update-check.ts';
import { DONE_KEY, MAX_BYTES, MAX_CHARS, OLD_ORIGIN, PREFIX, decode, encode, gate, guideOf, handedKey, itemsOf, takeHandover, withHash, write } from '../src/app/handover.ts';

const NEW = 'https://liquiditymapper.com/';
const REFERRER = `${OLD_ORIGIN}/`;
const none = (): boolean => false;

test('the fragment form round-trips any text, compressed or not, in URL-safe characters with no padding', async () => {
  for (const text of ['', 'a', '{"x":"€ 日本 🚀"}', 'x'.repeat(200_000), JSON.stringify({ v: 1, items: { 'hlm-app-v2': '{"timeframe":"5m"}'.repeat(500) } })]) {
    const data = await encode(text);
    assert.match(data, /^z[A-Za-z0-9_-]*$/, 'Node compresses');
    assert.equal(await decode(data), text);
  }
  assert.ok((await encode('{"timeframe":"5m"}'.repeat(500))).length < 200, 'a repetitive settings object shrinks');
  const plain = `j${Buffer.from('{"a":"日本"}').toString('base64url')}`;
  assert.equal(await decode(plain), '{"a":"日本"}', 'the uncompressed form, from a browser without CompressionStream');
  assert.equal(await decode('ja+b/'), null, 'standard base64 is not the form');
  assert.equal(await decode('j_w'), null, 'bytes that are not UTF-8');
  assert.equal(await decode('zAAAA'), null, 'not a deflate stream');
  assert.equal(await decode('qAAAA'), null, 'an unknown mode');
  const bomb = await encode('0'.repeat(MAX_BYTES + 1));
  assert.ok(bomb.length < 20_000, 'a small fragment');
  assert.equal(await decode(bomb), null, 'that unpacks past the bound is refused');
});

test('a hand-over writes only the page\'s own keys, never the cached coin list, the stale marks or the marker', () => {
  for (const key of ['hlm-app-v2', 'hlm-drawings-v1', 'hlm-scripts-v1', 'lmf.coin', 'lmf.coin.saved', 'lmf.venues.known', `hlm-${'x'.repeat(80)}`]) assert.ok(handedKey(key), key);
  for (const key of ['lmf.coins', 'hlm-stale', 'hlm-stale-reload', DONE_KEY, 'other', 'HLM-app', 'hlm-', 'lmf.', `hlm-${'x'.repeat(81)}`, '__proto__']) assert.equal(handedKey(key), false, key);
  assert.equal(itemsOf(JSON.stringify({ v: 1, items: { 'hlm-app-v2': '{}', 'lmf.coins': '[]' } })), null, 'one key it may not write refuses all');
  assert.equal(itemsOf('{"v":1,"items":{"__proto__":"x"}}'), null);
  assert.equal(itemsOf(JSON.stringify({ v: 1, items: { 'hlm-app-v2': 3 } })), null, 'values are strings');
  assert.equal(itemsOf(JSON.stringify({ v: 2, items: { 'hlm-app-v2': '{}' } })), null, 'another version');
  assert.equal(itemsOf(JSON.stringify({ v: 1, items: {} })), null, 'nothing to take');
  assert.equal(itemsOf(JSON.stringify({ v: 1, items: ['x'] })), null);
  assert.equal(itemsOf('not json'), null);
  assert.deepEqual(itemsOf(JSON.stringify({ v: 1, items: { 'hlm-app-v2': '{"a":1}', 'lmf.coin': 'ETH' } })), { 'hlm-app-v2': '{"a":1}', 'lmf.coin': 'ETH' });
});

test('a guide section rides after the data and is the only thing put back in the address', () => {
  assert.equal(guideOf(`${PREFIX}zABC~guide/ladder`), '#guide/ladder');
  assert.equal(guideOf(`${PREFIX}zABC~guide`), '#guide');
  assert.equal(guideOf(`${PREFIX}zABC`), '');
  for (const bad of ['~javascript:x', '~guide/Ladder', '~guide/../x', '~guidex', '~']) assert.equal(guideOf(`${PREFIX}zABC${bad}`), '', bad);
  assert.deepEqual(gate(`${NEW}${PREFIX}zABC~guide/ladder`, 'navigate', REFERRER, none), { data: 'zABC' }, 'the data stops at the section');
});

test('it is read only from the address the document was loaded with, by a plain navigation from the old address, once, into a browser with no work of its own', () => {
  const url = `${NEW}${PREFIX}zABC`;
  assert.deepEqual(gate(url, 'navigate', REFERRER, none), { data: 'zABC' });
  assert.deepEqual(gate(url, 'navigate', OLD_ORIGIN, none), { data: 'zABC' }, 'the bare origin');
  assert.deepEqual(gate(`${NEW}?coin=ETH${PREFIX}zABC`, 'navigate', `${OLD_ORIGIN}/x?y=1`, none), { data: 'zABC' }, 'a query, any page of the old address');
  for (const type of ['reload', 'back_forward', 'prerender', '']) assert.deepEqual(gate(url, type, REFERRER, none), { skip: 'not-navigate' }, type || '(none)');
  for (const referrer of ['', 'https://evil.example/', 'https://liquiditymapperfast.github.io.evil.example/', 'http://liquiditymapperfast.github.io/', NEW]) {
    assert.deepEqual(gate(url, 'navigate', referrer, none), { skip: 'referrer' }, referrer || '(no referrer)');
  }
  assert.deepEqual(gate(NEW, 'navigate', REFERRER, none), { skip: 'none' }, 'loaded without one: a fragment set later is never read');
  assert.deepEqual(gate(`${NEW}#guide${PREFIX}zABC`, 'navigate', REFERRER, none), { skip: 'none' }, 'the prefix must open the fragment');
  assert.deepEqual(gate(url, 'navigate', REFERRER, (key: string) => key === DONE_KEY), { skip: 'done' });
  for (const own of ['hlm-layouts-v1', 'hlm-drawings-v1', 'hlm-scripts-v1']) assert.deepEqual(gate(url, 'navigate', REFERRER, (key: string) => key === own), { skip: 'own-work' }, own);
  assert.deepEqual(gate(url, 'navigate', REFERRER, (key: string) => key === 'hlm-app-v2'), { data: 'zABC' }, 'settings alone are not work: they are replaced');
  assert.deepEqual(gate(`${NEW}${PREFIX}${'A'.repeat(MAX_CHARS + 1)}`, 'navigate', REFERRER, none), { skip: 'too-long' });
});

test('the fragment is replaced on the whole address, so an odd path stays this origin\'s', () => {
  assert.equal(withHash(`${NEW}?coin=ETH${PREFIX}zABC`, ''), `${NEW}?coin=ETH`);
  assert.equal(withHash(`${NEW}${PREFIX}zABC`, '#guide/ladder'), `${NEW}#guide/ladder`);
  assert.equal(withHash(`https://liquiditymapper.com//evil.example/x${PREFIX}z`, ''), 'https://liquiditymapper.com//evil.example/x');
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
  assert.equal(write(of(full, 'b'), { 'hlm-app-v2': 'new', 'hlm-scripts-v1': 'b' }, 1), false);
  assert.deepEqual(Object.fromEntries(full), { 'hlm-lang': 'de', 'hlm-app-v2': 'old' }, 'what was there is as it was, nothing new stays');
  assert.equal(full.has(DONE_KEY), false, 'no marker: a later visit may try again');
});

test('the old address\'s page sends what the new one takes: same keys, same form, the coin list and stale marks left behind', async () => {
  const html = readFileSync('moved-site/index.html', 'utf8');
  assert.equal(readFileSync('moved-site/404.html', 'utf8'), html, 'one page for both');
  assert.equal(buildIn(html), 'moved-v1a2026.js', 'an open tab on the old site is offered Reload');
  const code = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const context: Record<string, unknown> = { TextEncoder, btoa, Blob, Response, CompressionStream, Uint8Array, Promise, JSON };
  vm.runInNewContext(code, context);
  type Loc = { pathname: string; search: string; hash: string };
  const moved = context.Moved as { target(loc: Loc, storage: unknown): Promise<string> };
  const entries: [string, string][] = [['hlm-app-v2', '{"tf":"5m","name":"日本 🚀"}'], ['lmf.coins', '[big]'], ['hlm-stale', '1'], ['lmf.coin', 'ETH'], ['other', 'x'], [DONE_KEY, '1']];
  const storage = { length: entries.length, key: (i: number) => entries[i]?.[0] ?? null, getItem: (k: string) => entries.find(e => e[0] === k)?.[1] ?? null };
  const empty = { length: 0, key: () => null, getItem: () => null };
  const take = async (to: string) => {
    const verdict = gate(to, 'navigate', REFERRER, none);
    assert.ok('data' in verdict, to.slice(0, 80));
    return itemsOf((await decode(verdict.data))!);
  };

  const to = await moved.target({ pathname: '/', search: '?coin=ETH', hash: '#guide/ladder' }, storage);
  assert.ok(to.startsWith(`${NEW}?coin=ETH${PREFIX}z`), to.slice(0, 80));
  assert.deepEqual(await take(to), { 'hlm-app-v2': '{"tf":"5m","name":"日本 🚀"}', 'lmf.coin': 'ETH' });
  assert.ok(to.endsWith('~guide/ladder') && guideOf(new URL(to).hash) === '#guide/ladder', 'the guide section rides after the data');
  for (const pathname of ['/index.html', '/index', '/404.html', '//evil.example/x']) assert.ok((await moved.target({ pathname, search: '', hash: '' }, storage)).startsWith(`${NEW}${PREFIX}`), pathname);
  assert.equal(await moved.target({ pathname: '/', search: '', hash: '#guide/ladder' }, empty), `${NEW}#guide/ladder`, 'nothing to carry: the guide link keeps its place');
  assert.equal(await moved.target({ pathname: '/', search: '', hash: '#hlm-handover=zEVIL' }, empty), NEW, 'no other fragment is passed on');
  assert.equal(await moved.target({ pathname: '/llms.txt', search: '', hash: '' }, storage), `${NEW}llms.txt`, 'other paths go to the same path, carrying nothing');

  const huge: [string, string][] = [['hlm-drawings-v1', Array.from({ length: 120_000 }, (_, i) => ((i * 2654435761) >>> 0).toString(36)).join(',')]];
  const big = { length: 1, key: (i: number) => huge[i]?.[0] ?? null, getItem: () => huge[0]![1] };
  const capped = await moved.target({ pathname: '/', search: '', hash: '#guide' }, big);
  assert.ok(capped === `${NEW}#guide` || capped.length <= 1_000_000, 'never an address Firefox refuses');

  const refusing: Record<string, unknown> = { ...context, CompressionStream: class { constructor() { throw new TypeError('deflate-raw unsupported'); } } };
  delete refusing.Moved;
  vm.runInNewContext(code, refusing);
  const old = refusing.Moved as typeof moved;
  const plainTo = await old.target({ pathname: '/', search: '', hash: '' }, storage);
  assert.ok(plainTo.startsWith(`${NEW}${PREFIX}j`), 'a browser that refuses the format sends the plain form');
  assert.deepEqual(await take(plainTo), { 'hlm-app-v2': '{"tf":"5m","name":"日本 🚀"}', 'lmf.coin': 'ETH' });
});

test('on the page it takes what the navigation entry says, puts the guide back, and leaves no fragment', async () => {
  const items = { 'hlm-app-v2': '{"tf":"5m"}', 'lmf.coin': 'ETH' };
  const data = await encode(JSON.stringify({ v: 1, items }));
  const g = globalThis as Record<string, unknown>;
  const saved = { location: g.location, history: g.history, window: g.window, document: g.document, performance: g.performance };
  const run = async (opts: { loaded: string; now?: string; type?: string; referrer?: string; store?: Map<string, string> }) => {
    const store = opts.store ?? new Map<string, string>();
    let address = opts.now ?? opts.loaded;
    const url = () => new URL(address);
    Object.defineProperty(g, 'location', { configurable: true, get: () => ({ get origin() { return url().origin; }, get hash() { return url().hash; }, get href() { return url().href; } }) });
    Object.defineProperty(g, 'history', { configurable: true, value: { state: null, replaceState: (_s: unknown, _t: string, to: string) => { address = to; } } });
    Object.defineProperty(g, 'window', { configurable: true, value: { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } } } });
    Object.defineProperty(g, 'document', { configurable: true, value: { referrer: opts.referrer ?? REFERRER } });
    Object.defineProperty(g, 'performance', { configurable: true, value: { getEntriesByType: () => [{ name: opts.loaded, type: opts.type ?? 'navigate' }] } });
    try { await takeHandover(); } finally { for (const [k, v] of Object.entries(saved)) Object.defineProperty(g, k, { configurable: true, writable: true, value: v }); }
    return { store, address };
  };
  const first = await run({ loaded: `${NEW}?coin=ETH${PREFIX}${data}~guide/ladder` });
  assert.equal(first.address, `${NEW}?coin=ETH#guide/ladder`);
  assert.deepEqual(Object.fromEntries([...first.store].filter(([k]) => k !== DONE_KEY)), items);
  assert.ok(first.store.has(DONE_KEY));

  const again = await run({ loaded: `${NEW}${PREFIX}${data}~guide`, store: new Map([[DONE_KEY, '1']]) });
  assert.equal(again.address, `${NEW}#guide`, 'after the first, the guide still opens');
  assert.deepEqual([...again.store], [[DONE_KEY, '1']], 'and nothing is written');

  const planted = await run({ loaded: NEW, now: `${NEW}${PREFIX}${data}` });
  assert.equal(planted.store.size, 0, 'a fragment set after the load is never read');
  assert.equal(planted.address, NEW, 'and is removed');

  assert.equal((await run({ loaded: `${NEW}${PREFIX}${data}`, type: 'reload' })).store.size, 0, 'a reload takes nothing');
  assert.equal((await run({ loaded: `${NEW}${PREFIX}${data}`, referrer: 'https://evil.example/' })).store.size, 0, 'another referrer takes nothing');
});
