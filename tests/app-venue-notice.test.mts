import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedVenues, nameList, noticeText } from '../src/app/venue-notice.ts';
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
