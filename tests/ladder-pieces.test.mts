import test from 'node:test';
import assert from 'node:assert/strict';
import { VENUE_CODES, barPieces, pieceAt, pieceLabel, rankVenues, venueCode } from '../src/app/panes/ladder-pieces.ts';
import { levelLines, smallerVenuesLines, type LevelFacts } from '../src/app/panes/ladder-info.ts';

test('a Compact bar keeps the venue order, and venues too narrow to see share one piece at its end', () => {
  const ids = ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP', 'kraken:BTC/USD', 'bitget:BTCUSDT'];
  // A 200 px bar for a level of up to 100: Binance 40 -> 80 px, Bybit 0 (nothing there), OKX 1 -> 2 px, Kraken 20 -> 40 px, Bitget 0.5 -> 1 px.
  const pieces = barPieces(ids, [40, 0, 1, 20, 0.5], 100, 300, 200, 3);
  assert.deepEqual(pieces.map(p => [p.id, p.x, p.w, p.rank]), [['binance:BTCUSDT', 300, 80, 0], ['kraken:BTC/USD', 380, 40, 3], [null, 420, 3, -1]]);
  assert.deepEqual(pieces[2]!.merged, [{ id: 'okx:BTC-USDT-SWAP', usd: 1 }, { id: 'bitget:BTCUSDT', usd: 0.5 }], 'the smaller venues, largest first');
  assert.equal(pieces.reduce((sum, p) => sum + p.usd, 0), 61.5, 'nothing is lost');
  assert.equal(pieceAt(pieces, 379)?.id, 'binance:BTCUSDT'); assert.equal(pieceAt(pieces, 380)?.id, 'kraken:BTC/USD');
  assert.equal(pieceAt(pieces, 421)?.id, null); assert.equal(pieceAt(pieces, 500), null, 'past the bar');
  assert.deepEqual(barPieces(ids, [0, 0, 0, 0, 0], 100, 0, 200, 3), []);
});

test('the venue order is the most liquidity first, ties in their own order; a label says as much as fits', () => {
  assert.deepEqual(rankVenues(['a:X', 'b:X', 'c:X'], id => ({ 'a:X': 5, 'b:X': 9, 'c:X': 5 })[id] ?? 0), ['b:X', 'a:X', 'c:X']);
  assert.equal(venueCode('binance:BTCUSDT'), 'BIN'); assert.equal(venueCode('binancespot:BTCUSDT'), 'BIN·S');
  assert.deepEqual(['bitget:BTCUSDT', 'bitstamp:BTCUSD', 'bitfinex:BTCUSD', 'bitmex:XBTUSD', 'bitunix:BTCUSDT', 'hyperliquid:BTC-PERP'].map(venueCode), ['BGT', 'BST', 'BFX', 'BMX', 'BTU', 'HL'], 'no two Bit- venues alike');
  assert.equal(new Set(Object.values(VENUE_CODES)).size, Object.keys(VENUE_CODES).length, 'no code is used twice');
  const measure = (text: string): number => text.length * 6;            // 6 px a character
  assert.equal(pieceLabel('binance:BTCUSDT', '14.2M', 200, measure), 'Binance 14.2M');
  assert.equal(pieceLabel('binance:BTCUSDT', '14.2M', 70, measure), 'BIN 14.2M', 'the code and the size');
  assert.equal(pieceLabel('binance:BTCUSDT', '14.2M', 50, measure), 'Binance');
  assert.equal(pieceLabel('binance:BTCUSDT', '14.2M', 26, measure), 'BIN');
  assert.equal(pieceLabel('binance:BTCUSDT', '14.2M', 20, measure), null, 'not even the code');
});

test('Compact names every venue of a level, and the smaller venues\' piece names each of them', () => {
  const venues = Array.from({ length: 7 }, (_, i) => ({ name: `V${i}`, usd: 70 - i * 10 }));
  const facts: LevelFacts = { low: 83_000, step: 100, mark: 82_950, ask: true, size: 280, cumulative: 500, venues };
  const named = (lines: { label?: string }[]) => lines.filter(l => l.label?.startsWith('V')).length;
  assert.equal(named(levelLines(facts)), 4, 'Aggregated: the largest four');
  assert.equal(named(levelLines(facts, 12)), 7, 'Compact: all of them');
  const small = smallerVenuesLines(facts, [{ name: 'V5', usd: 20 }, { name: 'V6', usd: 10 }]);
  assert.equal(small[0]!.text, '2 smaller venues');
  assert.equal(small.find(l => l.label === 'Share of level')!.text, '11%', '30 of 280');
  assert.deepEqual(small.filter(l => l.label?.startsWith('V')).map(l => l.text), ['$20 · 7%', '$10 · 4%']);
});
