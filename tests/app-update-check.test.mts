import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHECK_EVERY_MS, FIRST_CHECK_MS, QUIET_MS, SHOWN_AGAIN_MS, answerFor, buildIn, buildOf, dueWhenShown, mayOffer, ownBuild, watchBuild, type BuildAnswer } from '../src/app/update-check.ts';
import { STALE_EVENT } from '../src/app/lazy.ts';

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

test('a question is due five minutes after the last one', () => {
  assert.equal(dueWhenShown(0, SHOWN_AGAIN_MS - 1), false);
  assert.equal(dueWhenShown(0, SHOWN_AGAIN_MS), true);
});

const ORIGIN = 'https://site.test';

/** A page for `watchBuild`: its address, its module scripts (absolute, as the DOM gives them), whether it is shown, and its listeners. */
function fakePage(scripts: string[], href = `${ORIGIN}/app/?coin=ETH`): { doc: Document; show(on: boolean): void; send(type: string): void } {
  let state: DocumentVisibilityState = 'visible';
  const listeners = new Map<string, (() => void)[]>();
  const url = new URL(href);
  const doc = {
    location: { href: url.href, origin: url.origin, protocol: url.protocol },
    get visibilityState() { return state; },
    querySelectorAll: () => scripts.map(src => ({ src })),
    addEventListener: (type: string, fn: () => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
  } as unknown as Document;
  const send = (type: string): void => { for (const fn of listeners.get(type) ?? []) fn(); };
  return { doc, show(on) { state = on ? 'visible' : 'hidden'; send('visibilitychange'); }, send };
}

test('the page\'s own build is its own origin\'s first build script, and only a page served over HTTP has one', () => {
  assert.equal(ownBuild(fakePage([`${ORIGIN}/app/assets/index-A1234567.js`]).doc), 'index-A1234567.js');
  assert.equal(ownBuild(fakePage(['chrome-extension://abc/assets/index-EXT12345.js', `${ORIGIN}/app/assets/index-A1234567.js`]).doc), 'index-A1234567.js', 'an extension\'s script before it is not the build');
  assert.equal(ownBuild(fakePage(['https://cdn.test/assets/index-CDN12345.js']).doc), null, 'another origin\'s build is not this page\'s');
  assert.equal(ownBuild(fakePage([`${ORIGIN}/@vite/client`, `${ORIGIN}/boot.ts`]).doc), null, 'the development server');
  assert.equal(ownBuild(fakePage(['file:///C:/share/site/assets/index-A1234567.js'], 'file:///C:/share/site/index.html').doc), null, 'a page opened from a file share asks nothing');
});

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** A stubbed site: what it serves (an HTML text, or a failure), and the questions it was asked. */
function fakeSite(t: TestContext, first: string): { asked: { url: string; cache: RequestCache | undefined }[]; serve(reply: string | Error | number): void; hold(): () => void } {
  let reply: string | Error | number = first, held: Promise<void> | null = null;
  const asked: { url: string; cache: RequestCache | undefined }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init?: RequestInit) => {
    asked.push({ url: String(url), cache: init?.cache });
    if (held) await held;
    if (reply instanceof Error) throw reply;
    return typeof reply === 'number' ? new Response('gone', { status: reply }) : new Response(reply);
  });
  return { asked, serve(next) { reply = next; }, hold() { let release = (): void => {}; held = new Promise<void>(resolve => { release = resolve; }); return () => { held = null; release(); }; } };
}
const page = (name: string): string => `<script type="module" src="./assets/${name}"></script>`;

test('the page asks a couple of minutes in, then every quarter of an hour while shown, and when shown again after five minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  const site = fakeSite(t, page('index-A1234567.js')), tab = fakePage([`${ORIGIN}/app/assets/index-A1234567.js`]), answers: [BuildAnswer, string | null][] = [];
  const watch = watchBuild((meaning, deployed) => answers.push([meaning, deployed]), tab.doc);
  assert.equal(watch.own, 'index-A1234567.js');

  tab.show(true); await settle();
  assert.equal(site.asked.length, 0, 'nothing at the start, shown or not');
  t.mock.timers.tick(FIRST_CHECK_MS - 1); await settle();
  assert.equal(site.asked.length, 0);
  t.mock.timers.tick(1); await settle();
  assert.deepEqual(site.asked, [{ url: `${ORIGIN}/app/`, cache: 'no-cache' }], 'the page itself, past the cache');
  assert.deepEqual(answers, [['withdraw', 'index-A1234567.js']], 'the same build');

  site.serve(page('index-B1234567.js'));
  t.mock.timers.tick(CHECK_EVERY_MS - FIRST_CHECK_MS); await settle();
  assert.equal(site.asked.length, 2, 'a quarter of an hour from the start');
  assert.deepEqual(answers.at(-1), ['offer', 'index-B1234567.js']);

  tab.show(false);
  t.mock.timers.tick(CHECK_EVERY_MS); await settle();
  assert.equal(site.asked.length, 2, 'a hidden tab asks nothing');
  tab.show(true); await settle();
  assert.equal(site.asked.length, 3, 'shown again, the last question a quarter of an hour old');
  tab.show(false); t.mock.timers.tick(SHOWN_AGAIN_MS - 1); tab.show(true); await settle();
  assert.equal(site.asked.length, 3, 'shown again within five minutes of the last question');
  tab.show(false); t.mock.timers.tick(7 * 60_000); tab.show(true); await settle();
  assert.equal(site.asked.length, 4, 'shown again twelve minutes after it');
  t.mock.timers.tick(3 * 60_000 + 1); await settle();
  assert.equal(site.asked.length, 4, 'the quarter-hourly question three minutes after a shown-again one waits for the next quarter');
  t.mock.timers.tick(CHECK_EVERY_MS); await settle();
  assert.equal(site.asked.length, 5);
});

test('a tab hidden when its first question was due asks when it is shown again, not a quarter of an hour later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  const site = fakeSite(t, page('index-B1234567.js')), tab = fakePage([`${ORIGIN}/app/assets/index-A1234567.js`]), answers: BuildAnswer[] = [];
  watchBuild(meaning => answers.push(meaning), tab.doc);
  tab.show(false);
  t.mock.timers.tick(FIRST_CHECK_MS); await settle();
  assert.equal(site.asked.length, 0, 'hidden at two minutes');
  t.mock.timers.tick(60_000); tab.show(true); await settle();
  assert.equal(site.asked.length, 1, 'shown at three minutes: a page opened from the cache is told then');
  assert.deepEqual(answers, ['offer']);
});

test('a part of the page that could not be fetched makes it ask at once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  const site = fakeSite(t, page('index-B1234567.js')), tab = fakePage([`${ORIGIN}/app/assets/index-A1234567.js`]), answers: BuildAnswer[] = [];
  watchBuild(meaning => answers.push(meaning), tab.doc);
  tab.send(STALE_EVENT); await settle();
  assert.equal(site.asked.length, 1, 'before the first question\'s time');
  assert.deepEqual(answers, ['offer']);
});

test('one question at a time, and one that fails or names no build changes nothing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const site = fakeSite(t, '<html><body>Not Found</body></html>'), answers: BuildAnswer[] = [];
  const watch = watchBuild(meaning => answers.push(meaning), fakePage([`${ORIGIN}/app/assets/index-A1234567.js`]).doc);
  const release = site.hold();
  const first = watch.check(), second = watch.check();
  await settle();
  assert.equal(site.asked.length, 1, 'the second waits for the first');
  release();
  assert.equal(await first, null); assert.equal(await second, null);
  site.serve(new TypeError('offline'));
  assert.equal(await watch.check(), null);
  site.serve(404);
  assert.equal(await watch.check(), null);
  assert.deepEqual(answers, ['none', 'none', 'none']);
});

test('a page that is not a build asks nothing and listens to nothing', async () => {
  const tab = fakePage([`${ORIGIN}/boot.ts`]);
  let listened = false;
  (tab.doc as unknown as { addEventListener: () => void }).addEventListener = () => { listened = true; };
  const watch = watchBuild(() => assert.fail('no answer'), tab.doc);
  assert.equal(watch.own, null);
  assert.equal(await watch.check(), null);
  assert.equal(listened, false);
});
