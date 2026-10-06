import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBitfinexSubscription } from '../src/adapters/bitfinex.mts';

// What an independent review found wrong in the exchange adapters.

test('Bitfinex: a lower-case t marks the trading pair, and a capital T is a letter of the symbol', () => {
  const symbol = (value: string): string => buildBitfinexSubscription('depth', { symbol: value }).symbol as string;
  assert.equal(symbol('BTCUSD'), 'tBTCUSD');
  assert.equal(symbol('tBTCUSD'), 'tBTCUSD', 'the native form is accepted as it is');
  assert.equal(symbol('TRXUSD'), 'tTRXUSD', 'TRON was turned into "tRXUSD"');
  assert.equal(symbol('TONUSD'), 'tTONUSD');
  assert.equal(symbol('tTRXUSD'), 'tTRXUSD');
  assert.equal(symbol('tTONUSD'), 'tTONUSD');
  assert.equal(symbol('ETH-USD'), 'tETHUSD');
});
