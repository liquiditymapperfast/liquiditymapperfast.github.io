import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHECK_EVERY_MS, FIRST_CHECK_MS, QUIET_MS, SHOWN_AGAIN_MS, answerFor, buildIn, buildOf, dueWhenShown, mayOffer, watchBuild, type BuildAnswer } from '../src/app/update-check.ts';

test('a build is named by its first script, a hashed file under assets/; the development server\'s scripts name none', () => {
  assert.equal(buildOf('./assets/index-NYsfP7Ku.js'), 'index-NYsfP7Ku.js');
  assert.equal(buildOf('https://liquiditymapperfast.github.io/assets/index-Bkgn6_qH.js'), 'index-Bkgn6_qH.js', 'the address the DOM gives');
  assert.equal(buildOf('/project/assets/index-9FRy6JJ-.js?v=1'), 'index-9FRy6JJ-.js', 'a project path, a query');
  assert.equal(buildOf('./boot.ts'), null, 'the source page');
  assert.equal(buildOf('/@vite/client'), null);
  assert.equal(buildOf('./assets/index.js'), null, 'not hashed');
  assert.equal(buildOf(''), null);
  assert.equal(buildOf(null), null);
});

test('the build a page names is its first module script that is a build\'s, however the tag is written', () => {
  const built = '<head>\n  <script type="module" crossorigin src="./assets/index-Bkgn6_qH.js"></script>\n  <link rel="modulepreload" crossorigin href="./assets/main-OJqbL8zx.js">\n</head>';
  assert.equal(buildIn(built), 'index-Bkgn6_qH.js');
  assert.equal(buildIn("<script crossorigin src='./assets/index-Bkgn6_qH.js' type='module'></script>"), 'index-Bkgn6_qH.js', 'other order, single quotes');
  assert.equal(buildIn('<SCRIPT TYPE=module SRC=./assets/index-Bkgn6_qH.js></SCRIPT>'), 'index-Bkgn6_qH.js', 'unquoted, upper case');
  assert.equal(buildIn('<script src="./assets/old-AAAAAAAA.js"></script><script type="module" src="./assets/index-BBBBBBBB.js"></script>'), 'index-BBBBBBBB.js', 'a classic script is not the build');
  assert.equal(buildIn('<script data-type="module" src="./assets/x-AAAAAAAA.js"></script>'), null, 'an attribute that only ends in type');
  assert.equal(buildIn('<script type="module" src="/@vite/client"></script><script type="module" src="/boot.ts"></script>'), null, 'the development server');
  assert.equal(buildIn('<html><body>Not Found</body></html>'), null, 'a page that is not the site');
});

test('the page has one module script, its first: what a build names it by', () => {
  const html = readFileSync('src/app/index.html', 'utf8');
  const modules = [...html.matchAll(/<script\b[^>]*>/gi)].filter(m => /\stype\s*=\s*["']?module/i.test(m[0]));
  assert.equal(modules.length, 1, 'vite turns this one into assets/index-<hash>.js');
});

test('an answer offers a newer build, takes the offer back on the tab\'s own, and changes nothing when nothing is known', () => {
  assert.equal(answerFor('index-A1234567.js', 'index-B1234567.js'), 'offer');
  assert.equal(answerFor('index-A1234567.js', 'index-A1234567.js'), 'withdraw', 'the site is back on this build');
  assert.equal(answerFor('index-A1234567.js', null), 'none', 'no answer, or one that names no build');
  assert.equal(answerFor(null, 'index-B1234567.js'), 'none', 'a page that is not a build');
});

test('a notice put away stays away a day, whatever is deployed meanwhile', () => {
  const now = 1_800_000_000_000;
  assert.equal(mayOffer(0, now), true, 'never put away');
  assert.equal(mayOffer(now - 60_000, now), false);
  assert.equal(mayOffer(now - QUIET_MS + 1, now), false);
  assert.equal(mayOffer(now - QUIET_MS, now), true, 'a day later it is said again');
  assert.equal(QUIET_MS, 86_400_000);
});

test('a tab shown again asks at once only when its last question is five minutes old', () => {
  assert.equal(dueWhenShown(0, SHOWN_AGAIN_MS - 1), false);
  assert.equal(dueWhenShown(0, SHOWN_AGAIN_MS), true);
});

/** A page for `watchBuild`: its first script, whether it is shown, and its visibility listeners. */
function fakePage(src: string | null): { doc: Document; show(on: boolean): void } {
  let state: DocumentVisibilityState = 'visible';
  const listeners: (() => void)[] = [];
  const doc = {
    get visibilityState() { return state; },
    querySelectorAll: () => (src ? [{ getAttribute: (name: string) => (name === 'src' ? src : null) }] : []),
    addEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') listeners.push(fn); },
  } as unknown as Document;
  return { doc, show(on) { state = on ? 'visible' : 'hidden'; for (const fn of listeners) fn(); } };
}

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('the page asks a couple of minutes in, then every quarter of an hour while shown, and when shown again after five minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  const asked: { url: string; cache: RequestCache | undefined }[] = [];
  let html = '<script type="module" src="./assets/index-A1234567.js"></script>';
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => { asked.push({ url: String(url), cache: init?.cache }); return new Response(html); });
  Object.defineProperty(globalThis, 'location', { value: { href: 'https://site.test/app/?coin=ETH' }, configurable: true });
  t.after(() => { delete (globalThis as { location?: unknown }).location; });
  const page = fakePage('./assets/index-A1234567.js'), answers: [BuildAnswer, string | null][] = [];
  const watch = watchBuild((meaning, deployed) => answers.push([meaning, deployed]), page.doc);
  assert.equal(watch.own, 'index-A1234567.js');

  t.mock.timers.tick(FIRST_CHECK_MS - 1); await settle();
  assert.equal(asked.length, 0, 'nothing at the start');
  t.mock.timers.tick(1); await settle();
  assert.deepEqual(asked, [{ url: 'https://site.test/app/', cache: 'no-cache' }], 'the page itself, past the cache');
  assert.deepEqual(answers, [['withdraw', 'index-A1234567.js']], 'the same build');

  html = '<script type="module" src="./assets/index-B1234567.js"></script>';
  t.mock.timers.tick(CHECK_EVERY_MS - FIRST_CHECK_MS); await settle();
  assert.equal(asked.length, 2, 'a quarter of an hour from the start');
  assert.deepEqual(answers.at(-1), ['offer', 'index-B1234567.js']);

  page.show(false);
  t.mock.timers.tick(CHECK_EVERY_MS); await settle();
  assert.equal(asked.length, 2, 'a hidden tab asks nothing');
  page.show(true); await settle();
  assert.equal(asked.length, 3, 'shown again, the last question a quarter of an hour old');
  page.show(false); t.mock.timers.tick(SHOWN_AGAIN_MS - 1); page.show(true); await settle();
  assert.equal(asked.length, 3, 'shown again within five minutes of the last question');
});

test('one question at a time, and one that fails or names no build changes nothing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let release: (r: Response) => void = () => {};
  const calls: number[] = [];
  t.mock.method(globalThis, 'fetch', () => { calls.push(1); return new Promise<Response>(resolve => { release = resolve; }); });
  Object.defineProperty(globalThis, 'location', { value: { href: 'https://site.test/' }, configurable: true });
  t.after(() => { delete (globalThis as { location?: unknown }).location; });
  const answers: BuildAnswer[] = [];
  const watch = watchBuild(meaning => answers.push(meaning), fakePage('./assets/index-A1234567.js').doc);
  const first = watch.check(), second = watch.check();
  assert.equal(calls.length, 1, 'the second waits for the first');
  release(new Response('<html><body>Not Found</body></html>'));
  assert.equal(await first, null); assert.equal(await second, null);
  assert.deepEqual(answers, ['none']);
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
  assert.equal(await watch.check(), null);
  t.mock.method(globalThis, 'fetch', async () => new Response('gone', { status: 404 }));
  assert.equal(await watch.check(), null);
  assert.deepEqual(answers, ['none', 'none', 'none']);
});

test('a page that is not a build asks nothing and listens to nothing', async () => {
  const page = fakePage('./boot.ts');
  let listened = false;
  (page.doc as unknown as { addEventListener: () => void }).addEventListener = () => { listened = true; };
  const watch = watchBuild(() => assert.fail('no answer'), page.doc);
  assert.equal(watch.own, null);
  assert.equal(await watch.check(), null);
  assert.equal(listened, false);
});
