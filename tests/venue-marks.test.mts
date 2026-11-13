import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkLayer, VENUE_MARKS, markCorner, marksKey, markOf, monogramPx, useMarkets, type PaintedMark } from '../src/app/venue-marks.ts';
import { paintAt } from '../src/app/pixel-ratio.ts';
import { MARK, layoutInfo } from '../src/app/infobox.ts';

const luminance = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16), lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255);
};
const contrast = (a: string, b: string): number => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };

test('every exchange has a mark of its own: a spot market is its exchange\'s mark with a notch, an unknown one a plain mark from its name', () => {
  assert.deepEqual({ ...markOf('binance:BTCUSDT') }, { ...VENUE_MARKS.binance, spot: false, family: 'binance' });
  assert.deepEqual([markOf('binancespot:BTCUSDT').spot, markOf('binancespot:BTCUSDT').family, markOf('binancespot:BTCUSDT').text], [true, 'binance', 'B']);
  assert.deepEqual([markOf('okxspot').family, markOf('okx').spot], ['okx', false], 'a venue alone works too');
  const unknown = markOf('newdex:BTC-USD');
  assert.deepEqual([unknown.text, unknown.spot, unknown.family], ['NE', false, 'newdex']);
  const seen = new Set(Object.values(VENUE_MARKS).map(m => `${m.bg}|${m.text}`));
  assert.equal(seen.size, Object.keys(VENUE_MARKS).length, 'no two exchanges look alike');
  for (const [venue, m] of Object.entries(VENUE_MARKS)) {
    assert.ok(contrast(m.bg, m.fg) >= 3, `${venue}: its letters read on its colour (${contrast(m.bg, m.fg).toFixed(2)})`);
    assert.ok(m.text.length >= 1 && m.text.length <= 2, `${venue}: one or two letters`);
  }
  assert.ok(monogramPx(14, 'B') > monogramPx(14, 'BY'), 'one letter is drawn larger than two');
});

test('a line with a mark makes room for it before its first text', () => {
  const measure = (text: string): number => text.length * 6;
  const plain = layoutInfo(measure, [{ text: 'Binance BTCUSDT' }]), marked = layoutInfo(measure, [{ text: 'Binance BTCUSDT', mark: 'binance:BTCUSDT' }]);
  assert.equal(marked.width - plain.width, MARK.room);
  assert.equal(marked.rows[0]!.mark, 'binance:BTCUSDT');
  const labelled = layoutInfo(measure, [{ label: 'Bybit BTCUSDT', text: '$20.6M · 25%', mark: 'bybit:BTCUSDT' }]);
  assert.equal(labelled.labelW, 'Bybit BTCUSDT'.length * 6 + MARK.room, 'on a labelled line the mark goes before the label');
});

test('a market the market list calls spot has the notch, whatever its venue is called', () => {
  let markets = [
    { instrumentId: 'binance:BTCUSDT', marketType: 'perpetual' }, { instrumentId: 'binance:BTCUSDT:spot', marketType: 'spot' },
    { instrumentId: 'coinbase:BTC-USD', marketType: 'spot' }, { instrumentId: 'kraken:BTC/USD', marketType: 'spot' },
  ];
  useMarkets(() => markets);
  try {
    assert.equal(markOf('binance:BTCUSDT:spot').spot, true);
    assert.equal(markOf('binance:BTCUSDT:spot').family, 'binance', 'still Binance\'s mark');
    assert.equal(markOf('coinbase:BTC-USD').spot, true);
    assert.equal(markOf('binance:BTCUSDT').spot, false);
    assert.equal(markOf('coinbase').spot, true, 'a venue that lists only spot markets');
    assert.equal(markOf('binance').spot, false, 'a venue with both');
    assert.equal(markOf('binancespot:BTCUSDT').spot, true, 'the alias still says so with no list');
    markets = [{ instrumentId: 'coinbase:BTC-USD', marketType: 'perpetual' }];
    assert.equal(markOf('coinbase:BTC-USD').spot, false, 'a new list is read as it is');
  } finally { useMarkets(() => []); }
});

test('marks paint the same pixels when they land on the same whole pixels, at the same opacity step, with the same bitmaps', () => {
  const mark: PaintedMark = { id: 'binance:BTCUSDT', x: 100.2, y: 40.4, size: 10, a: 0.8 };
  assert.equal(markCorner(100.2, 10), 95, 'drawVenueMark\'s corner');
  const key = marksKey([mark]);
  assert.equal(marksKey([{ ...mark, x: 100.4, y: 40.2 }]), key, 'a fifth of a pixel either way lands on the same pixel');
  assert.equal(marksKey([{ ...mark, a: 0.8 + 0.4 / 255 }]), key, 'less than a 255th of opacity is the same ink');
  assert.notEqual(marksKey([{ ...mark, x: 100.6 }]), key, 'a pixel to the right');
  assert.notEqual(marksKey([{ ...mark, a: 0.8 + 1 / 255 }]), key, 'a step fainter');
  assert.notEqual(marksKey([{ ...mark, size: 11 }]), key);
  assert.notEqual(marksKey([{ ...mark, id: 'okx:BTC-USDT-SWAP' }]), key);
  assert.notEqual(marksKey([mark, mark]), key, 'one more');
  assert.equal(marksKey([{ ...mark, a: 1.2 }]), marksKey([{ ...mark, a: 1 }]), 'the pane lays no more than full opacity, as the key reads it');
  // An 11 px mark (the rail's flashes) starts half a pixel off a 10 px one's: 100.2 and 100.6 both land on 95, 101 on 96.
  const flash: PaintedMark = { ...mark, size: 11 };
  assert.equal(marksKey([{ ...flash, x: 100.6 }]), marksKey([flash]));
  assert.notEqual(marksKey([{ ...flash, x: 101 }]), marksKey([flash]));
  // A market the list calls spot is drawn from the notched bitmap.
  const id = 'okx:BTC-USDT', plain = marksKey([{ ...mark, id }]), spotList = [{ instrumentId: id, marketType: 'spot' }];
  useMarkets(() => spotList);
  try { assert.notEqual(marksKey([{ ...mark, id }]), plain, 'the spot mark is another bitmap'); } finally { useMarkets(() => []); }
  paintAt(3);
  try { assert.notEqual(marksKey([mark]), key, 'another pixel ratio paints another bitmap'); } finally { paintAt(null); }
  assert.equal(marksKey([mark]), key);
});

test('a mark layer paints again only when its marks would change the canvas, clearing first only what it painted', () => {
  const layer = new MarkLayer(), log: string[] = [];
  const paint = (marks: PaintedMark[]): boolean => layer.paint(marks, clear => log.push(clear ? 'clear' : 'begin'), m => log.push(`draw ${Math.round(m.x)}`));
  const mark: PaintedMark = { id: 'binance:BTCUSDT', x: 100.2, y: 40, size: 10, a: 0.8 };
  assert.equal(paint([]), false, 'nothing on a clear canvas: nothing to do');
  assert.equal(paint([mark]), true); assert.deepEqual(log.splice(0), ['begin', 'draw 100']);
  assert.equal(paint([{ ...mark, x: 100.4 }]), false, 'the same pixels'); assert.deepEqual(log, []);
  assert.equal(paint([{ ...mark, x: 101.2 }]), true); assert.deepEqual(log.splice(0), ['clear', 'draw 101']);
  layer.reset();
  assert.equal(paint([{ ...mark, x: 101.2 }]), true, 'a canvas sized afresh is painted though its marks did not move'); assert.deepEqual(log.splice(0), ['begin', 'draw 101']);
  assert.equal(paint([]), true, 'the last mark gone: cleared once'); assert.deepEqual(log.splice(0), ['clear']);
  assert.equal(paint([]), false); assert.deepEqual(log, []);
});
