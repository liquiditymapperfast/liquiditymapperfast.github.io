// The buy row at the top of the Plus page (Karl, 2026-11-20: "I want that people only have to click once to purchase the $10 plan ... make
// the row a bit more thinner"): while Plus is on sale it lives in the hero's line of pills and nothing is sold further down; while it is not on
// sale the page is as it was. The pure decision (page-flow.ts `topRow`), then the row drawn on a fake document by the page's own render path
// (page-top.ts `drawPageParts` and `drawBuyRows`, which page.ts calls on every drawing: the hero's row and the same row once more at the end of
// the page), then the page's wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { el } from '../src/app/dom.ts';
import { PADDLE, type PlusPrice } from '../src/app/plus/config.ts';
import { topRow } from '../src/app/plus/page-flow.ts';
import { buyingFor, drawBuyRows, drawPageParts, type TopParts } from '../src/app/plus/page-top.ts';
import type { Paid } from '../src/app/plus/paid.ts';
import type { PlusMode, PlusState } from '../src/app/plus/pass.ts';
import { FakePage } from './fake-dom.mts';

const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const row = (o: { onSale?: boolean; stands?: PlusState; buying?: boolean; mode?: PlusMode; paidReady?: boolean; waiting?: boolean } = {}) =>
  topRow({ onSale: true, stands: 'none', buying: true, mode: 'idb', paidReady: true, waiting: false, ...o });

/**
 * A Plus page in miniature on a fake document: the hero's pieces, a membership and payments that change, and `render`, which draws it the way
 * page.ts does on every change (`drawPageParts`, the rows drawn by `drawBuyRows`). `end` is the row at the end of the page; `rest` records what
 * the rest of the page was drawn for.
 */
function miniPage(onSale = true) {
  const parts = {
    pricePill: el('span', { class: 'px-pill', textContent: '$10 a month' }), onPill: el('span', { class: 'px-pill on', hidden: true }),
    cta: el('button', { type: 'button', class: 'px-cta' }), top: el('div', { class: 'px-top', hidden: true }), topFine: el('div', { class: 'px-top-fine', hidden: true }),
  };
  const endTop = el('div', { class: 'px-top', hidden: true }), endFine = el('div', { class: 'px-top-fine', hidden: true });
  const end: TopParts = { top: endTop, topFine: endFine, box: el('section', { class: 'buy-end', hidden: true }, endTop, endFine) };
  const member = { state: 'none' as PlusState, why: '', mode: 'idb' as PlusMode };
  const pay = { ready: true, list: [] as Paid[] };
  const bought: PlusPrice[] = [], pressed: string[] = [], rest: boolean[] = [];
  const render = (): boolean => drawPageParts(member, {
    top: buying => drawBuyRows(parts, end, { onSale, stands: member.state, buying, mode: member.mode, paidReady: pay.ready, pending: pay.list[0], busy: false, tried: () => false, said: [] },
      { buy: price => { bought.push(price); }, press: id => { pressed.push(id); } }),
    rest: buying => { rest.push(buying); },
  });
  type Found = { click(): void; textContent: string; hidden: boolean; id: string } | null;
  const find = (selector: string): Found => parts.top.querySelector(selector) as unknown as Found;
  const findEnd = (selector: string): Found => end.box!.querySelector(selector) as unknown as Found;
  const ids = (): string[] => [parts.top, parts.topFine, end.box!].flatMap(box => (box.querySelectorAll('[id]') as unknown as { id: string }[]).map(e => e.id)).filter(Boolean);
  return { parts, end, member, pay, bought, pressed, rest, render, find, findEnd, ids };
}

test('the decision: on sale with no membership the price button; a waiting payment its note; on the pill only; not on sale as it was', () => {
  assert.deepEqual(row(), { pill: false, on: false, activate: false, buy: 'price', lower: null });
  assert.deepEqual(row({ waiting: true }), { pill: false, on: false, activate: false, buy: 'waiting', lower: null });
  assert.deepEqual(row({ stands: 'on', buying: false }), { pill: false, on: true, activate: false, buy: 'nothing', lower: null });
  assert.deepEqual(row({ stands: 'checking', buying: false }), { pill: false, on: false, activate: false, buy: 'nothing', lower: null });
  assert.deepEqual(row({ mode: 'opening' }), { pill: true, on: false, activate: false, buy: 'nothing', lower: null });
  assert.deepEqual(row({ paidReady: false }), { pill: true, on: false, activate: false, buy: 'nothing', lower: null });
  assert.equal(row({ mode: 'plain' }).buy, 'cannot-buy');
  assert.equal(row({ mode: 'unusable' }).buy, 'cannot-here');
  assert.deepEqual(row({ onSale: false }), { pill: true, on: false, activate: true, buy: 'nothing', lower: 'not-on-sale' });
  assert.deepEqual(row({ onSale: false, stands: 'on', buying: false }), { pill: true, on: true, activate: false, buy: 'nothing', lower: null });
  assert.equal(buyingFor('none', ''), true); assert.equal(buyingFor('ended', 'canceled'), true);
  assert.equal(buyingFor('ended', 'replaced'), false); assert.equal(buyingFor('on', ''), false); assert.equal(buyingFor('checking', ''), false);
});

test('the row is drawn on every drawing and follows the state: price, then the on pill, then a waiting payment, with one click to the checkout', () => {
  const done = new FakePage().install();
  try {
    const page = miniPage();
    page.render();
    const price = page.find('#plus-monthly');
    assert.ok(price, 'the price button in the top row');
    assert.equal(price.textContent, 'Get Plus$10 a month');
    assert.equal(page.parts.pricePill!.hidden, true, 'the price not written twice');
    assert.equal(page.parts.topFine.hidden, false, 'the small print under it');
    // ONE line of small print under the row (Karl, 2026-11-20): the renewal said, and Paddle.com named as the Merchant of Record (Paddle's
    // review looks for both).
    const lines = page.parts.topFine.querySelectorAll('p');
    assert.equal(lines.length, 1, 'one line');
    const line = lines[0]!.textContent ?? '';
    assert.equal(line, 'Renews monthly until you end it · before tax · sold by Paddle.com, Merchant of Record');
    for (const words of ['Renews monthly', 'Paddle.com', 'Merchant of Record']) assert.ok(line.includes(words), words);
    price.click();
    assert.deepEqual(page.bought, [PADDLE.monthly], 'one click opens the checkout');
    // Plus comes on (another tab, the checkout): the next drawing shows the on pill only.
    page.member.state = 'on';
    page.render();
    assert.equal(page.find('#plus-monthly'), null, 'no price button once Plus is on');
    assert.equal(page.parts.top.hidden, true);
    assert.equal(page.parts.onPill.hidden, false);
    assert.equal(page.parts.pricePill!.hidden, true);
    // The key removed, a payment waiting: its note and button at the top, and no price anywhere.
    page.member.state = 'none';
    page.pay.list = [{ id: 'txn_waitingaaaaaaaaaaaaaaaaaaaaa', at: 1, memory: false }];
    page.render();
    assert.equal(page.find('#plus-monthly'), null, 'no price while a payment waits');
    assert.equal(page.parts.pricePill!.hidden, true);
    const setUp = page.find('#plus-paid-again');
    assert.equal(setUp?.textContent, 'Set up Plus');
    assert.match(page.parts.top.textContent ?? '', /A payment made in this browser is still being set up\./);
    setUp!.click();
    assert.deepEqual(page.pressed, ['txn_waitingaaaaaaaaaaaaaaaaaaaaa']);
    assert.deepEqual(page.rest, [true, false, true], 'the rest of the page drawn each time, for the same decision');
  } finally { done(); }
});

test('a yearly price, once it has an id, is a second button in the top row (set here for the test only, never committed)', () => {
  const done = new FakePage().install();
  const yearly = PADDLE.yearly as { id: string; usd: number }, was = { id: yearly.id, usd: yearly.usd };
  try {
    yearly.id = 'pri_test_yearly_only'; yearly.usd = 100;
    const page = miniPage();
    page.render();
    const second = page.find('#plus-yearly');
    assert.ok(page.find('#plus-monthly') && second, 'both buttons');
    assert.equal(second.textContent, '$100 a year');
    second.click();
    assert.deepEqual(page.bought, [PADDLE.yearly], 'its click opens the yearly checkout');
    assert.equal(page.parts.topFine.querySelectorAll('p').length, 1, 'still one line of small print');
  } finally { yearly.id = was.id; yearly.usd = was.usd; done(); }
  assert.equal(PADDLE.yearly.id, '', 'no yearly price is set in the configuration');
});

test('a key replaced by newer ones is offered no purchase (the receipt brings Plus back); one that ended otherwise is offered Renew', () => {
  const done = new FakePage().install();
  try {
    const page = miniPage();
    page.member.state = 'ended'; page.member.why = 'replaced';
    assert.equal(page.render(), false);
    assert.equal(page.find('#plus-monthly'), null, 'no price button for a replaced key');
    assert.equal(page.parts.top.hidden, true);
    assert.deepEqual(page.rest, [false]);
    page.member.why = 'canceled';
    assert.equal(page.render(), true);
    assert.equal(page.find('#plus-monthly')?.textContent, 'Renew Plus$10 a month');
  } finally { done(); }
});

test('not on sale (today): the pill "Gift keys only today", "Activate a key", nothing in the row; the lower "Not on sale yet" section stays', () => {
  const done = new FakePage().install();
  try {
    const page = miniPage(false);
    page.render();
    assert.equal(page.parts.pricePill!.hidden, false);
    assert.equal(page.parts.cta.hidden, false);
    assert.equal(page.parts.cta.textContent, 'Activate a key');
    assert.equal(page.parts.top.hidden, true);
    assert.equal(page.find('#plus-monthly'), null);
    page.member.state = 'on';
    page.render();
    assert.equal(page.parts.cta.hidden, true);
    assert.equal(page.parts.onPill.hidden, false);
  } finally { done(); }
  assert.match(read('src/app/plus/present.ts'), /t\('Gift keys only today'\)/);
  const source = read('src/app/plus/page.ts');
  const section = source.slice(source.indexOf('function notOnSaleSection()'), source.indexOf('function drawTop('));
  assert.ok(section.includes('if (!plusOnSale()) {'));
  assert.match(section, /el\('h2', \{ textContent: t\('Not on sale yet'\) \}\)/);
  assert.match(section, /t\('Plus is being set up, and the checkout opens on this page soon\. Prices are before tax\.'\)/);
  assert.ok(!/el\('button'/.test(section), 'no button before the checkout exists');
  assert.match(source, /const target = keyBox\.input\.isConnected \? keyBox\.input : null;/, 'Activate a key scrolls to the key box');
});

test('the page draws through that path on every change, sells nothing further down on sale, and says Renew without "below"', () => {
  const source = read('src/app/plus/page.ts');
  assert.match(source, /drawPageParts\(member, \{ top: drawTop, rest: drawRest \}\);/, 'drawPage draws the row and the rest');
  assert.match(source, /function drawTop\(buying: boolean\): void \{[\s\S]*?drawBuyRows\(\{ pricePill, onPill, cta, top, topFine \}, \{ top: endTop, topFine: endFine, box: endBox \},/);
  // The end row's section stands before "Already have Plus?" on sale only, and only while it holds something.
  assert.match(source, /\.\.\.\(plusOnSale\(\) && !endBox\.hidden \? \[endBox\] : \[\]\),\s*\.\.\.\(stands !== 'on' \? \[deviceSection\(\)\] : \[\]\),/);
  assert.match(source, /member\.subscribe\(render\);\s*paid\.subscribe\(render\);/, 'a change of membership or payments draws the page again');
  assert.match(source, /\.\.\.\(buying && !plusOnSale\(\) \? \[notOnSaleSection\(\)\] : \[\]\),/);
  assert.ok(!/price-main|price-plain|function buySection|'plus-monthly'/.test(source), 'no price button of the page\'s own below');
  assert.ok(!/price-main|\.prices \{/.test(read('src/app/plus/page.css')));
  assert.match(source, /t\('Subscribing again brings Plus back, with a new key\.'\)/);
  assert.ok(!/again below/.test(source));
  for (const lang of ['de', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'tr', 'uk', 'zh']) {
    const pack = JSON.parse(read(`src/app/i18n/${lang}.json`)) as Record<string, string>;
    assert.ok(pack['Subscribing again brings Plus back, with a new key.'], lang);
    assert.ok(!('Subscribing again below brings Plus back, with a new key.' in pack), `${lang}: the old sentence is gone`);
  }
});

// ---- The row once more at the end of the page, and how it works without an account (Karl, 2026-11-20) ----

test('both rows follow one state change: price in both, then a waiting payment in both with no price anywhere; the ids stay unique', () => {
  const done = new FakePage().install();
  try {
    const page = miniPage();
    page.render();
    assert.ok(page.find('#plus-monthly') && page.findEnd('#plus-monthly-end'), 'the price button at the top and at the end');
    assert.equal(page.end.box!.hidden, false);
    page.findEnd('#plus-monthly-end')!.click();
    assert.deepEqual(page.bought, [PADDLE.monthly], 'the end button opens the checkout too');
    let ids = page.ids();
    assert.equal(new Set(ids).size, ids.length, `unique ids: ${ids.join(', ')}`);
    page.pay.list = [{ id: 'txn_bothrowsaaaaaaaaaaaaaaaaaaaa', at: 1, memory: false }];
    page.render();
    for (const box of [page.parts.top, page.end.box!]) {
      assert.match(box.textContent ?? '', /A payment made in this browser is still being set up\./, 'the note in both rows');
      assert.equal(box.querySelector('.px-buy'), null, 'no price button');
      assert.ok(!/\$10 a month/.test(box.textContent ?? ''), 'no price');
    }
    assert.equal(page.parts.pricePill!.hidden, true);
    assert.ok(page.find('#plus-paid-again') && page.findEnd('#plus-paid-again-end'));
    ids = page.ids();
    assert.equal(new Set(ids).size, ids.length, `unique ids: ${ids.join(', ')}`);
  } finally { done(); }
});

test('the end row is absent while Plus is on and while Plus is not on sale (the page then stays as it was)', () => {
  const done = new FakePage().install();
  try {
    const on = miniPage();
    on.member.state = 'on';
    on.render();
    assert.equal(on.end.box!.hidden, true, 'Plus on: nothing at the end');
    on.member.state = 'checking';
    on.render();
    assert.equal(on.end.box!.hidden, true, 'being checked: nothing at the end');
    const closed = miniPage(false);
    closed.render();
    assert.equal(closed.end.box!.hidden, true, 'not on sale: nothing at the end');
    const opening = miniPage();
    opening.pay.ready = false;
    opening.render();
    assert.equal(opening.end.box!.hidden, true, 'before the first payment read: nothing to press');
  } finally { done(); }
});

test('while on sale the hero says how it works without an account, beside the button; the end row stays as thin and leaves it out', () => {
  const done = new FakePage().install();
  try {
    const page = miniPage();
    page.render();
    const howTo = page.parts.top.querySelector('.px-top-howto') as unknown as { textContent: string } | null;
    assert.equal(howTo?.textContent, 'No account: paying turns Plus on in this browser and gives you a key for your other devices.');
    assert.equal(page.end.box!.querySelector('.px-top-howto'), null, 'not in the end row');
    assert.equal(page.end.topFine.querySelectorAll('p').length, 1, 'the end row keeps its one line of small print');
    page.pay.list = [{ id: 'txn_howtoaaaaaaaaaaaaaaaaaaaaaaa', at: 1, memory: false }];
    page.render();
    assert.equal(page.parts.top.querySelector('.px-top-howto'), null, 'only beside the price button');
  } finally { done(); }
  for (const lang of ['de', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'tr', 'uk', 'zh']) {
    const pack = JSON.parse(read(`src/app/i18n/${lang}.json`)) as Record<string, string>;
    assert.ok(pack['No account: paying turns Plus on in this browser and gives you a key for your other devices.'], lang);
    assert.ok(pack['Renews monthly until you end it · before tax · sold by Paddle.com, Merchant of Record']?.includes('Paddle.com'), lang);
  }
});
