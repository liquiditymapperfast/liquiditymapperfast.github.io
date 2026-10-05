import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedVenues, idleText, idleVenues, nameList, noticeText, stateOfStatus } from '../src/app/venue-notice.ts';
import type { VenueEntry } from '../src/app/source.ts';

const entry = (id: string, name: string, state: VenueEntry['state'], selected = true): VenueEntry => ({ id, name, supported: true, recommended: true, selected, status: '', state });

test('only chosen venues that the location cannot reach count as blocked', () => {
  const list = [entry('binance', 'Binance', 'blocked'), entry('bybit', 'Bybit', 'blocked', false), entry('okx', 'OKX', 'live'), entry('bitget', 'Bitget', 'error')];
  assert.deepEqual(blockedVenues(list).map(v => v.id), ['binance']);
});

test('names are joined the way a sentence would', () => {
  assert.equal(nameList([]), '');
  assert.equal(nameList(['Binance']), 'Binance');
  assert.equal(nameList(['Binance', 'Bybit']), 'Binance and Bybit');
  assert.equal(nameList(['Binance', 'Bybit', 'OKX']), 'Binance, Bybit and OKX');
});

test('the banner names the venues, says why and says what to do, with the right number', () => {
  assert.equal(noticeText([]), null);
  assert.equal(noticeText([entry('binance', 'Binance', 'blocked')]), 'Binance is unavailable from your location. A VPN set to another country may enable it.');
  assert.equal(noticeText([entry('binance', 'Binance', 'blocked'), entry('bybit', 'Bybit', 'blocked')]), 'Binance and Bybit are unavailable from your location. A VPN set to another country may enable them.');
});

const withStatus = (id: string, name: string, status: string, o: Partial<VenueEntry> = {}): VenueEntry => ({ id, name, supported: true, recommended: false, selected: true, status, ...o });

test('a server status line is read for what it says', () => {
  assert.equal(stateOfStatus('live'), 'live');
  assert.equal(stateOfStatus('connecting'), 'connecting');
  assert.equal(stateOfStatus('reconnecting'), 'connecting');
  assert.equal(stateOfStatus('available'), 'off', 'a venue that is not chosen');
  assert.equal(stateOfStatus('live, book crossed by 123 bp, left off the map'), 'error', 'live, but its book is faulty');
  assert.equal(stateOfStatus('unavailable'), 'error');
  assert.equal(stateOfStatus('error: KuCoin public websocket token unavailable'), 'error');
});

test('a chosen venue with no book on the map gets a chip, whatever the reason, and a venue that is drawn or not chosen does not', () => {
  const venues = [
    withStatus('binance', 'Binance', 'live, book crossed by 123 bp, left off the map'),
    withStatus('kucoin', 'KuCoin', 'unavailable'),
    withStatus('bybit', 'Bybit', 'connecting'),
    withStatus('okx', 'OKX', 'live'),
    withStatus('bitget', 'Bitget', 'available', { selected: false }),
    withStatus('deribit', 'Deribit', 'live', { state: 'blocked' }),
    withStatus('mexc', 'MEXC', 'available', { supported: false }),
  ];
  const idle = idleVenues(venues, new Set(['okx']));
  assert.deepEqual(idle.map(v => `${v.id}:${v.kind}`), ['binance:faulty', 'kucoin:faulty', 'bybit:connecting']);
  assert.deepEqual(idleVenues(venues, new Set(['okx', 'binance'])).map(v => v.id), ['kucoin', 'bybit'], 'once its book is back the chip goes');
});

test('the chip says why the venue is not on the map', () => {
  const crossed = idleVenues([withStatus('binance', 'Binance', 'live, book crossed by 123 bp, left off the map')], new Set())[0]!;
  assert.match(idleText(crossed), /Binance: live, book crossed by 123 bp, left off the map\. A crossed book is a fault in the exchange feed/);
  const failing = idleVenues([withStatus('kucoin', 'KuCoin', 'unavailable')], new Set())[0]!;
  assert.match(idleText(failing), /KuCoin: unavailable\. It is not on the map\./);
  const slow = idleVenues([withStatus('bybit', 'Bybit', 'connecting')], new Set())[0]!;
  assert.match(idleText(slow), /Bybit is still connecting/);
});
