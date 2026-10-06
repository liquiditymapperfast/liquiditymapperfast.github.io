import test from 'node:test';
import assert from 'node:assert/strict';
import { INFO, layoutInfo, type InfoLine } from '../src/app/infobox.ts';
import { placeCard } from '../src/app/hovercard.ts';
import { statCellLines, type StatCell } from '../src/app/panes/bar-stats.ts';
import { rowCellAt, rowCellLines, type Bar } from '../src/app/panes/footprint.ts';
import { distanceText, levelLines, venueCellLines, type LevelFacts } from '../src/app/panes/ladder-info.ts';

/** Six pixels a character, a bold one a pixel more, so widths are predictable without a canvas. */
const measure = (text: string, bold: boolean): number => text.length * (bold ? 7 : 6);
const texts = (lines: readonly InfoLine[]): string[] => lines.map(l => (l.label ? `${l.label}: ` : '') + l.text);

test('a label and its value share a row and the box is as wide as the widest of each plus the gap and padding', () => {
  const laid = layoutInfo(measure, [{ label: 'Size', text: '$12M' }, { label: 'Share of level', text: '40%' }]);
  assert.equal(laid.rows.length, 2);
  assert.equal(laid.labelW, 'Share of level'.length * 6);
  assert.equal(laid.width, 'Share of level'.length * 6 + INFO.gap + '$12M'.length * 6 + INFO.pad * 2);
});

test('a long sentence marked to wrap is broken into rows no wider than the wrap width, and a plain one is left whole', () => {
  const text = 'one two three four five six seven eight nine ten eleven twelve';
  const wrapped = layoutInfo(measure, [{ text, wrap: true, color: 'muted' }], 100);
  assert.ok(wrapped.rows.length > 1);
  for (const row of wrapped.rows) assert.ok(measure(row.text, false) <= 100, row.text);
  assert.equal(wrapped.rows.map(r => r.text).join(' '), text, 'no word is lost or reordered');
  assert.ok(wrapped.rows.every(r => r.color === 'muted'));
  assert.equal(layoutInfo(measure, [{ text }], 100).rows.length, 1);
});

test('a rule adds height once, above the first row of a wrapped sentence only', () => {
  const plain = layoutInfo(measure, [{ text: 'a' }, { text: 'b' }]).height;
  const ruled = layoutInfo(measure, [{ text: 'a' }, { text: 'b', rule: true }]).height;
  assert.equal(ruled - plain, INFO.rule);
  const wrapped = layoutInfo(measure, [{ text: 'alpha beta gamma delta epsilon zeta', wrap: true, rule: true }], 60);
  assert.equal(wrapped.rows.filter(r => r.rule).length, 1);
  assert.equal(wrapped.rows[0]!.rule, true);
});

test('a bar-stat popup names the statistic, the candle and the value, and only adds what is known', () => {
  const cell: StatCell = { label: 'delta', title: 'Buy minus sell volume of the bar (USD)', value: '-2.1M', tone: 'sell', time: 'Oct 5 21:00', previous: '+0.4M', rank: 3, of: 24, sigma: 2.14 };
  const lines = statCellLines(cell);
  assert.deepEqual(texts(lines).slice(0, 6), ['delta', 'Candle: Oct 5 21:00', 'Value: -2.1M', 'Candle before: +0.4M', 'Rank in view: 3 of 24', 'Unusual: 2.1σ above its baseline']);
  assert.equal(lines[2]!.color, 'sell');
  const last = lines[lines.length - 1]!;
  assert.equal(last.text, cell.title);
  assert.equal(last.wrap, true);
  assert.equal(last.color, 'muted');
  assert.deepEqual(texts(statCellLines({ ...cell, previous: null, rank: null, sigma: null })), ['delta', 'Candle: Oct 5 21:00', 'Value: -2.1M', cell.title]);
  assert.ok(!texts(statCellLines({ ...cell, of: 1 })).some(l => l.startsWith('Rank')), 'a rank among one is not a rank');
});

const bar: Bar = { t: Date.UTC(2026, 9, 5, 21), rows: [[85700, 1e6, 3e6], [85750, 3e6, 1e6], [85800, 0.5e6, 0.5e6]], buyUsd: 4.5e6, sellUsd: 4.5e6 };

test('a footprint row is found by its price span, and knows its share of the candle and whether it is the busiest', () => {
  assert.equal(rowCellAt(bar, 50, 85749.9)!.low, 85700);
  assert.equal(rowCellAt(bar, 50, 85750)!.low, 85750);
  assert.equal(rowCellAt(bar, 50, 85850), null, 'no executions at that price');
  const a = rowCellAt(bar, 50, 85720)!, b = rowCellAt(bar, 50, 85760)!, c = rowCellAt(bar, 50, 85810)!;
  assert.ok(a.poc && b.poc, 'two rows tie for the most');
  assert.ok(!c.poc);
  assert.ok(Math.abs(a.share - 4 / 9) < 1e-9);
});

test('the footprint popup gives the price span, both sides, the delta, the heavier side and the candle around it', () => {
  const cell = rowCellAt(bar, 50, 85760)!;
  const lines = rowCellLines(cell, bar, 50, '1h');
  const said = texts(lines);
  assert.equal(said[0], '85,750 – 85,800');
  assert.ok(said.includes('Sold: $1.0M'));
  assert.ok(said.includes('Bought: $3.0M'));
  assert.ok(said.includes('Delta: +2.0M'));
  assert.ok(said.includes('Heavier side: buyers 3.0×'));
  assert.ok(said.includes('Share of candle: 44%'));
  assert.ok(said.includes('Candle volume: $9.0M'));
  assert.ok(said.some(l => l.startsWith('Candle delta: ')), 'the candle\'s own delta is there');
  assert.equal(lines.find(l => l.label === 'Bought')!.color, 'buy');
  assert.equal(lines.find(l => l.label === 'Sold')!.color, 'sell');
  assert.ok(texts(rowCellLines(rowCellAt(bar, 50, 85810)!, bar, 50, '1h')).includes('Heavier side: balanced'));
  assert.ok(texts(rowCellLines({ ...cell, buy: 2e6, sell: 0 }, bar, 50, '1h')).includes('Heavier side: buyers only'), 'no ratio against nothing');
});

const level: LevelFacts = { low: 85750, step: 50, mark: 85794, ask: false, size: 54.8e6, cumulative: 150e6, venues: [{ name: 'Binance BTCUSDT', usd: 20e6 }, { name: 'Bybit BTCUSDT', usd: 30e6 }, { name: 'OKX BTC-USDT-SWAP', usd: 4.8e6 }] };

test('how far a level is from the mark carries the sign and both units', () => {
  assert.equal(distanceText(85794 * 1.0042, 85794), '+0.42% · 42 bp');
  assert.equal(distanceText(85794 * 0.9, 85794), '−10.0% · 1000 bp');
  assert.equal(distanceText(85819.7382, 85794), '+0.03% · 3.0 bp');
  assert.ok(distanceText(85794, 85794).startsWith('0.00%'));
});

test('a level popup lists the venues behind it, largest first, with their shares', () => {
  const said = texts(levelLines(level));
  assert.equal(said[0], 'Order book level');
  assert.ok(said.includes('Price: 85,750 – 85,800'));
  assert.ok(said.includes('Side: Bid: buyers waiting'));
  assert.ok(said.includes('Size: $54.8M'));
  assert.ok(said.includes('From the mark: $150M'));
  assert.deepEqual(said.filter(l => /BTC/.test(l) && /%/.test(l)), ['Bybit BTCUSDT: $30M · 55%', 'Binance BTCUSDT: $20M · 36%', 'OKX BTC-USDT-SWAP: $4.8M · 9%']);
  assert.ok(texts(levelLines({ ...level, venues: Array.from({ length: 7 }, (_, i) => ({ name: `V${i}`, usd: 10 - i })) })).includes('+3 more venues'));
  assert.equal(texts(levelLines({ ...level, title: 'Binance BTCUSDT', venues: [] }))[0], 'Binance BTCUSDT');
  assert.ok(!texts(levelLines({ ...level, venues: [{ name: 'Only', usd: 54.8e6 }] })).some(l => l.startsWith('Only')), 'one venue is not a breakdown');
});

test('a venue cell popup says that venue\'s size, its share and its rank at the price', () => {
  const said = texts(venueCellLines(level, level.venues[0]!));
  assert.equal(said[0], 'Binance BTCUSDT');
  for (const line of ['Size: $20M', 'Share of level: 36%', 'Rank at this price: 2 of 3', 'All venues here: $54.8M']) assert.ok(said.includes(line), line);
  const ask = texts(venueCellLines({ ...level, ask: true }, level.venues[1]!));
  assert.ok(ask.includes('Side: Ask: sellers waiting'));
  assert.ok(ask.includes('Rank at this price: 1 of 3'));
});

test('a hover card goes above and right of the pointer, flips to the left near the edge, drops below near the top, and never leaves the page', () => {
  const view = { w: 1000, h: 700 }, size = { w: 200, h: 120 };
  assert.deepEqual(placeCard(400, 400, size, view), { left: 414, top: 266 });
  assert.equal(placeCard(900, 400, size, view).left, 900 - 14 - 200, 'no room on the right');
  assert.equal(placeCard(400, 60, size, view).top, 74, 'no room above');
  const corner = placeCard(995, 695, size, view);
  assert.ok(corner.left >= 6 && corner.left + size.w <= view.w - 6 && corner.top >= 6 && corner.top + size.h <= view.h - 6);
  const tiny = placeCard(10, 10, { w: 2000, h: 2000 }, view);
  assert.ok(tiny.left >= 6 && tiny.top >= 6, 'a card larger than the page is still pinned to its corner');
});
