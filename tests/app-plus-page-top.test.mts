// The buy row at the top of the Plus page (Karl, 2026-11-20: "I want that people only have to click once to purchase the $10 plan ... make
// the row a bit more thinner"): while Plus is on sale it lives in the hero's line of pills (page-flow.ts `topRow`, page.ts `drawTop`) and
// nothing is sold further down; while it is not on sale the page is as it was. The pure part, then the page's own use of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { topRow } from '../src/app/plus/page-flow.ts';
import type { PlusMode, PlusState } from '../src/app/plus/pass.ts';

const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const row = (o: { onSale?: boolean; stands?: PlusState; buying?: boolean; mode?: PlusMode; paidReady?: boolean; waiting?: boolean } = {}) =>
  topRow({ onSale: true, stands: 'none', buying: true, mode: 'idb', paidReady: true, waiting: false, ...o });
const page = read('src/app/plus/page.ts');
const drawTop = page.slice(page.indexOf('function drawTop('), page.indexOf('/** A Remove this browser did not store'));
const count = (text: string, part: string): number => text.split(part).length - 1;

test('on sale with no membership: the price button in the top row (the pill not written twice), and nothing sold below', () => {
  assert.deepEqual(row(), { pill: false, on: false, activate: false, buy: 'price', lower: null });
  assert.deepEqual(row({ stands: 'ended' }), { pill: false, on: false, activate: false, buy: 'price', lower: null }, 'Renew: the price button too');
  // The page: the price button (id plus-monthly) is made in the top row alone and opens the checkout with one click.
  assert.ok(drawTop.length > 0);
  assert.equal(count(page, `'plus-monthly'`), 1, 'one price button on the page');
  assert.match(drawTop, /if \(row\.buy === 'price'\) \{[\s\S]*price\(PADDLE\.monthly, t\('\{price\} a month', \{ price: money\(PADDLE\.monthly\.usd\) \}\), true, 'plus-monthly'\)/);
  assert.match(drawTop, /onclick: \(\) => \{ void buy\(p\); \}/, 'the checkout at once, no scrolling');
  assert.match(drawTop, /ended \? t\('Renew Plus'\) : t\('Get Plus'\)/);
  // The tax line and Paddle's Merchant-of-Record line right under the row.
  assert.match(drawTop, /t\('Prices are before tax; the checkout shows the total in your currency\./);
  assert.match(drawTop, /t\('Our order process is conducted by our online reseller Paddle\.com\. Paddle\.com is the Merchant of Record for all our orders\./);
  assert.match(page, /heroBox\.querySelector\('\.px-avail'\)\?\.after\(topFine\);/, 'the small print right under the row');
  // Nothing sold below while on sale: the lower section is the not-on-sale one alone.
  assert.match(page, /\.\.\.\(buying && !plusOnSale\(\) \? \[notOnSaleSection\(\)\] : \[\]\),/);
  assert.ok(!/price-main|price-plain|function buySection/.test(page), 'the old lower price block is gone');
  assert.ok(!/price-main|\.prices \{/.test(read('src/app/plus/page.css')));
});

test('a waiting payment: its note and "Set up Plus" at the top, and no price anywhere', () => {
  assert.deepEqual(row({ waiting: true }), { pill: false, on: false, activate: false, buy: 'waiting', lower: null });
  assert.match(drawTop, /\} else if \(row\.buy === 'waiting' && pending\) \{\s*parts\.push\(waitingButton\(pending\), el\('span', \{ class: 'px-top-note', textContent: WAITING_NOTE\(\) \}\)\);/);
  assert.equal(count(page, `id: 'plus-paid-again'`), 1, 'one button for it, the same in the top row and beside a membership');
  // Below, while buying, the member section says no waiting payment (the top row does).
  assert.match(page, /besideMembership\(state\.fresh, member\.key, buying \? \[\] : paid\.list\(\)\)/);
  // Not ready or unusable here with a payment only this tab holds: the same.
  assert.equal(row({ mode: 'notready', waiting: true }).buy, 'waiting');
});

test('Plus on or being checked: the on pill only; opening or before the first payment read: nothing to press; cannot buy here: the words', () => {
  assert.deepEqual(row({ stands: 'on', buying: false }), { pill: false, on: true, activate: false, buy: 'nothing', lower: null });
  assert.deepEqual(row({ stands: 'checking', buying: false }), { pill: false, on: false, activate: false, buy: 'nothing', lower: null });
  assert.deepEqual(row({ mode: 'opening' }), { pill: true, on: false, activate: false, buy: 'nothing', lower: null });
  assert.deepEqual(row({ paidReady: false }), { pill: true, on: false, activate: false, buy: 'nothing', lower: null });
  assert.equal(row({ mode: 'plain' }).buy, 'cannot-buy');
  assert.equal(row({ mode: 'unusable' }).buy, 'cannot-here');
  assert.match(drawTop, /if \(pricePill\) pricePill\.hidden = !row\.pill;\s*onPill\.hidden = !row\.on;\s*cta\.hidden = !row\.activate;/);
});

test('not on sale (today): the page is unchanged: "Gift keys only today", "Activate a key" to the key box, and the lower "Not on sale yet" section', () => {
  assert.deepEqual(row({ onSale: false }), { pill: true, on: false, activate: true, buy: 'nothing', lower: 'not-on-sale' });
  assert.deepEqual(row({ onSale: false, stands: 'on', buying: false }), { pill: true, on: true, activate: false, buy: 'nothing', lower: null });
  assert.deepEqual(row({ onSale: false, stands: 'ended' }), { pill: true, on: false, activate: true, buy: 'nothing', lower: 'not-on-sale' });
  assert.match(drawTop, /cta\.textContent = t\('Activate a key'\);/);
  assert.match(page, /const target = keyBox\.input\.isConnected \? keyBox\.input : null;/, 'Activate a key scrolls to the key box');
  assert.match(read('src/app/plus/present.ts'), /t\('Gift keys only today'\)/);
  const section = page.slice(page.indexOf('function notOnSaleSection()'), page.indexOf('function drawTop('));
  assert.match(section, /el\('h2', \{ textContent: t\('Not on sale yet'\) \}\)/);
  assert.match(section, /t\('Plus is being set up, and the checkout opens on this page soon\. Prices are before tax\.'\)/);
  assert.ok(!/el\('button'/.test(section), 'no button before the checkout exists');
});
