import test from 'node:test';
import assert from 'node:assert/strict';
import { VENUE_MARKS, markOf, monogramPx } from '../src/app/venue-marks.ts';
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
