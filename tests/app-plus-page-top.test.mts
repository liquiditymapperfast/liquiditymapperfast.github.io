// The buy row at the top of the Plus page (Karl, 2026-11-20: "I want that people only have to click once to purchase the $10 plan ... make
// the row a bit more thinner"): while Plus is on sale it lives in the hero's line of pills and nothing is sold further down; while it is not on
// sale the page is as it was. The pure decision (page-flow.ts `topRow`), then the row drawn on a fake document by the page's own render path
// (page-top.ts `drawPageParts` and `drawTopRow`, which page.ts calls on every drawing), then the page's wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { el } from '../src/app/dom.ts';
import { PADDLE, type PlusPrice } from '../src/app/plus/config.ts';
import { topRow } from '../src/app/plus/page-flow.ts';
import { buyingFor, drawPageParts, drawTopRow, type TopParts } from '../src/app/plus/page-top.ts';
import type { Paid } from '../src/app/plus/paid.ts';
import type { PlusMode, PlusState } from '../src/app/plus/pass.ts';
import { FakePage } from './fake-dom.mts';

const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const row = (o: { onSale?: boolean; stands?: PlusState; buying?: boolean; mode?: PlusMode; paidReady?: boolean; waiting?: boolean } = {}) =>
  topRow({ onSale: true, stands: 'none', buying: true, mode: 'idb', paidReady: true, waiting: false, ...o });

/**
 * A Plus page in miniature on a fake document: the hero's pieces, a membership and payments that change, and `render`, which draws it the way
 * page.ts does on every change (`drawPageParts` with the row drawn by `drawTopRow`). `rest` records what the rest of the page was drawn for.
 */
function miniPage(onSale = true) {
  const parts: TopParts = {
    pricePill: el('span', { class: 'px-pill', textContent: '$10 a month' }), onPill: el('span', { class: 'px-pill on', hidden: true }),
    cta: el('button', { type: 'button', class: 'px-cta' }), top: el('div', { class: 'px-top', hidden: true }), topFine: el('div', { class: 'px-top-fine', hidden: true }),
  };
  const member = { state: 'none' as PlusState, why: '', mode: 'idb' as PlusMode };
  const pay = { ready: true, list: [] as Paid[] };
  const bought: PlusPrice[] = [], pressed: string[] = [], rest: boolean[] = [];
  const render = (): boolean => drawPageParts(member, {
    top: buying => drawTopRow(parts, { onSale, stands: member.state, buying, mode: member.mode, paidReady: pay.ready, pending: pay.list[0], busy: false, tried: () => false, said: [] },
      { buy: price => { bought.push(price); }, press: id => { pressed.push(id); } }),
    rest: buying => { rest.push(buying); },
  });
  const find = (selector: string) => parts.top.querySelector(selector) as unknown as ({ click(): void; textContent: string; hidden: boolean } | null);
  return { parts, member, pay, bought, pressed, rest, render, find };
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
    assert.match(page.parts.topFine.textContent ?? '', /Paddle\.com is the Merchant of Record/);
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
  const section = source.slice(source.indexOf('function notOnSaleSection()'), source.indexOf('/** The hero\'s buy row while the page is drawn'));
  assert.ok(section.includes('if (!plusOnSale()) {'));
  assert.match(section, /el\('h2', \{ textContent: t\('Not on sale yet'\) \}\)/);
  assert.match(section, /t\('Plus is being set up, and the checkout opens on this page soon\. Prices are before tax\.'\)/);
  assert.ok(!/el\('button'/.test(section), 'no button before the checkout exists');
  assert.match(source, /const target = keyBox\.input\.isConnected \? keyBox\.input : null;/, 'Activate a key scrolls to the key box');
});

test('the page draws through that path on every change, sells nothing further down on sale, and says Renew without "below"', () => {
  const source = read('src/app/plus/page.ts');
  assert.match(source, /drawPageParts\(member, \{ top: drawTop, rest: drawRest \}\);/, 'drawPage draws the row and the rest');
  assert.match(source, /function drawTop\(buying: boolean\): void \{[\s\S]*?drawTopRow\(\{ pricePill, onPill, cta, top, topFine \},/);
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
