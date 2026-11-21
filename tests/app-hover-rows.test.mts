// The map's column boxes (Karl's pick of 2026-11-20 from the hover-box proposal): the profile column's box leads with the row under the
// pointer, then the band and how far the feeds reach; the liquidation column's card; the seam cut down; pieces of a line with their marks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Held, ROW_HOLD_MS, booksReaching, depthBand, depthBandLines, depthBandVerdict, depthHereLine, depthRow, depthRowLines, liqBandVerdict, liqCardLines, liqCardRow, ratioWords, seamCardLines, seamSpan, wholeShares } from '../src/app/hover-rows.ts';
import { binsBetween, liqStanding, standingBins, type LiqLevels } from '../src/app/liq-levels.ts';
import type { Grouped } from '../src/app/panes/levels-data.ts';
import type { LevelsFrame, LiveBook } from '../src/app/wire.ts';
import { INFO, MARK, layoutInfo, type InfoLine } from '../src/app/infobox.ts';
import { liqSubBoxFrame } from '../src/app/panes/heat-pane.ts';

const measure = (text: string, bold: boolean): number => text.length * (bold ? 7 : 6);
const text = (lines: readonly InfoLine[]): string[] => lines.map(l => (l.label !== undefined ? `${l.label}: ` : '') + l.text);
/** A grouping of $50 rows from 58,000 with three books' bid and ask rows. */
function grouping(): Grouped {
  const n = 40, mk = (vals: Record<number, number>): Float32Array => { const a = new Float32Array(n); for (const [i, v] of Object.entries(vals)) a[Number(i)] = v; return a; };
  const bid = [mk({ 8: 20_400_000, 9: 1_000_000 }), mk({ 8: 2_100_000 }), mk({ 8: 4_800_000 })], ask = [mk({ 30: 500_000 }), mk({ 30: 1_500_000 }), mk({})];
  const total = (rows: Float32Array[]): Float32Array => { const t = new Float32Array(n); for (const r of rows) for (let i = 0; i < n; i++) t[i]! += r[i]!; return t; };
  return { ids: ['binance:BTCUSDT', 'hyperliquid:BTC-PERP', 'okx:BTC-USDT-SWAP'], step: 50, bin0: 1160, nBins: n, bid, ask, totalBid: total(bid), totalAsk: total(ask) };
}
const side = (lo: number[], hi: number[], usd: number[]) => ({ lo: Float64Array.from(lo), hi: Float64Array.from(hi), usd: Float64Array.from(usd) });
const book = (id: string, bidLo: number, askHi: number): LiveBook => ({ id, venue: id.split(':')[0]!, timestamp: 0, coarse: false, bids: side([bidLo, 58_900], [bidLo + 10, 58_910], [1, 1]), asks: side([59_010, askHi - 10], [59_020, askHi], [1, 1]) });

test('shares round together to 100 by the largest remainders, and a ratio prints two decimals below ten, one up to a thousand, no more past it', () => {
  assert.deepEqual(wholeShares([74.715, 7.585, 17.7], 100), [75, 7, 18]);
  for (const vals of [[1, 1, 1], [5, 3, 2], [0.4, 0.4, 0.2], [10, 0, 0]]) assert.equal(wholeShares(vals, vals.reduce((s, x) => s + x, 0)).reduce((s, x) => s + x, 0), 100, String(vals));
  assert.deepEqual(wholeShares([1, 2], 0), [0, 0]);
  assert.equal(ratioWords(729, 721), '1.01×');
  assert.equal(ratioWords(130, 10), '13.0×');
  assert.equal(ratioWords(999, 1), '999.0×');
  assert.equal(ratioWords(1000, 1), '≥1000×');
  assert.equal(ratioWords(5e6, 1e-9), '≥1000×', 'a side all but empty: no sixteen digits');
  assert.equal(ratioWords(5, 0), '–');
});

test('the row under the pointer: its side, prices, size and the two books holding most of it', () => {
  const g = grouping(), row = depthRow(g, 8, 'bid');
  assert.equal(row.lo, 58_400); assert.equal(row.hi, 58_450);
  assert.equal(Math.round(row.total), 27_300_000);
  assert.deepEqual(row.top.map(x => x.id), ['binance:BTCUSDT', 'okx:BTC-USDT-SWAP']);
  assert.equal(Math.round(row.rest), 2_100_000);
  const lines = depthRowLines(row, g.step);
  assert.equal(lines[0]!.text, 'Bids 58,400–58,450 · $27.3M');
  assert.deepEqual(lines[0]!.runs!.map(r => r.color ?? null), ['below', null, null], 'only the side word in the side colour');
  const venues = lines[1]!;
  assert.deepEqual(venues.runs!.filter(r => r.mark).map(r => r.mark), ['binance:BTCUSDT', 'okx:BTC-USDT-SWAP'], 'each named book with its mark');
  assert.match(venues.text, /^Binance 75%\s+OKX 17%\s+others 8%$/, 'shares by the largest remainders: 74.7, 17.6, 7.7');
  const pcts = venues.runs!.filter(r => r.value).map(r => Number(r.text.replace('%', '')));
  assert.equal(pcts.reduce((s, x) => s + x, 0), 100);
  // One book alone: no "others"; an empty row: its size alone.
  assert.equal(depthRowLines(depthRow(g, 9, 'bid'), 50)[1]!.text, 'Binance 100%');
  assert.deepEqual(text(depthRowLines(depthRow(g, 20, 'bid'), 50)), ['Bids 59,000–59,050 · $0']);
  assert.equal(depthRowLines(depthRow(g, 30, 'ask'), 50)[0]!.text, 'Asks 59,500–59,550 · $2M');
});

test('a line in pieces measures as its pieces and marks, and with wrap breaks only at a gap, never leaving a gap at the start of a row', () => {
  const line = depthRowLines(depthRow(grouping(), 8, 'bid'), 50)[1]!;
  const one = layoutInfo(measure, [line]);
  assert.equal(one.rows.length, 1);
  const runsW = line.runs!.reduce((s, r) => s + measure(r.text, false) + (r.mark ? MARK.room : 0), 0);
  assert.equal(one.width, runsW + INFO.pad * 2);
  const narrow = layoutInfo(measure, [line], 120);
  assert.ok(narrow.rows.length >= 2, `${narrow.rows.length} rows`);
  for (const row of narrow.rows) assert.ok(!row.runs![0]!.gap, 'no gap starts a row');
  assert.equal(narrow.rows.map(r => r.runs!.filter(x => !x.gap).map(x => x.text).join('')).join(''), line.runs!.filter(x => !x.gap).map(x => x.text).join(''), 'nothing lost or reordered');
  // Without wrap it stays one row, however narrow.
  assert.equal(layoutInfo(measure, [{ ...line, wrap: false }], 60).rows.length, 1);
});

test('how many books send data as far as a row: a book whose feed stops nearer the price does not count', () => {
  const frame: LevelsFrame = { asOf: 0, books: [book('binance:BTCUSDT', 52_000, 66_000), book('hyperliquid:BTC-PERP', 57_100, 60_900), book('okx:BTC-USDT-SWAP', 58_000, 60_000)] };
  const ids = frame.books.map(b => b.id);
  assert.equal(booksReaching(frame, ids, 59_000, 58_850, 50, 'bid'), 3, 'near the price every feed reaches');
  assert.equal(booksReaching(frame, ids, 59_000, 57_500, 50, 'bid'), 2, 'OKX stops at 58,000');
  assert.equal(booksReaching(frame, ids, 59_000, 56_000, 50, 'bid'), 1, 'Hyperliquid at 57,100');
  assert.equal(booksReaching(frame, ids, 59_000, 60_950, 50, 'ask'), 1, 'only Binance past 60,900 on the asks');
  assert.equal(booksReaching(frame, [...ids, 'gone:BTC'], 59_000, 58_850, 50, 'bid'), 3, 'a book not in the frame counts as not reaching');
  assert.deepEqual(text([depthHereLine(2, 3)]), ['Depth coverage here: 2/3 books']);
});

test('the band says which side is heavier in one line, its totals only where no pill shows them, how far the feeds reach, and when part is outside', () => {
  const base = { bid: 729_900_000, ask: 721_000_000, pct: '0.93%', reach: { bid: 15, ask: 14, of: 24 }, totals: false, clipped: false };
  assert.deepEqual(text(depthBandLines(base)), ['Within ≈±0.93%: bids and asks about even', 'Depth coverage: bids 15/24 · asks 14/24']);
  assert.deepEqual(text(depthBandLines({ ...base, ask: 517_000_000 })).slice(0, 1), ['Within ≈±0.93%: bids 1.41× the asks']);
  const phone = depthBandLines({ ...base, totals: true, clipped: true });
  assert.deepEqual(text(phone), ['Within ≈±0.93%: bids and asks about even', 'Bids $729.9M  ·  Asks $721M', 'Depth coverage: bids 15/24 · asks 14/24', 'part of the range is outside the data']);
  assert.deepEqual(phone[1]!.runs!.map(r => r.color), ['below', 'below', 'muted', 'above', 'above']);
});

test('the liquidation card: the row\'s levels, what still stands there, the snapshot\'s count and largest, then which side of the band is heavier', () => {
  const f = { kind: 'liq' as const, side: 'long' as const, lo: 51_850, hi: 51_900, step: 50, level: 53_944_068, total: 53_944_068, split: null, positions: 30, top: 51_861_076,
    below: 277e6, above: 173e6, pct: '12.1%', totals: false, bandSplit: null };
  assert.deepEqual(text(liqCardLines(f)), ['Long liquidations 51,850–51,900', 'At this level: $53.9M', 'Positions: 30', 'Largest position: $51.9M', 'Within ≈±12.1%: longs 1.60× the shorts']);
  assert.deepEqual([liqCardLines(f).at(-1)!.color, liqCardLines(f).at(-1)!.bold, liqCardLines(f).at(-1)!.rule], ['below', true, true], 'the heavier side in its colour, under a rule');
  assert.equal(liqCardLines(f)[0]!.runs![0]!.color, 'below', 'the side in the colour the column draws it');
  // A row price has taken (a wick through it): what stands of what the snapshot put there, so the snapshot's count and largest still agree.
  assert.deepEqual(text(liqCardLines({ ...f, level: 0, total: 5_200_000, positions: 14, top: 2_000_000 })).slice(1, 4), ['At this level: $0 of $5.2M', 'Positions: 14', 'Largest position: $2M']);
  // Liq + stops: the row's two parts under it, and each side's band total in its two parts (it says the totals, so no totals line).
  const both = liqCardLines({ ...f, kind: 'both', split: { liq: 50e6, stops: 3_944_068 }, totals: true, bandSplit: { long: 'Total $277M = liquidations $250M + stops $27M', short: 'Total $173M = liquidations $160M + stops $13M' } });
  assert.ok(text(both).includes('Total $53.9M = liquidations $50M + stops $3.9M'), text(both).join(' | '));
  assert.deepEqual(text(both).slice(-2), ['Longs: Total $277M = liquidations $250M + stops $27M', 'Shorts: Total $173M = liquidations $160M + stops $13M']);
  // Take profits on their own keep the shorts' below the price (the arrays' long side) and the longs' above: the band says whose they are.
  const takes = liqCardLines({ ...f, kind: 'takes', below: 50, above: 10, totals: true });
  assert.ok(text(takes).includes('Within ≈±12.1%: shorts 5.00× the longs'), text(takes).join(' | '));
  assert.equal(takes.find(l => l.text.startsWith('Within'))!.color, 'below', 'the shorts\' take profits stand below the price, in its colour');
  assert.equal(takes.at(-1)!.text, 'Longs $10  ·  Shorts $50');
  assert.deepEqual(takes.at(-1)!.runs!.map(r => r.color), ['above', 'above', 'muted', 'below', 'below'], 'each in the colour of where it stands');
  // A strip or sub-column: the band's totals; an empty row of an empty snapshot: no count or largest.
  assert.equal(liqCardLines({ ...f, totals: true }).at(-1)!.text, 'Longs $277M  ·  Shorts $173M');
  assert.deepEqual(text(liqCardLines({ ...f, side: 'short', level: 0, total: 0, positions: 0, top: 0 })), ['Short liquidations 51,850–51,900', 'At this level: $0', 'Within ≈±12.1%: longs 1.60× the shorts']);
});

test('the band counts from the price: from a grouping that holds the price and the mirror where the view\'s does not, clipped only where none can', () => {
  // A view grouping of 40 rows from 58,000 and a wider one from 54,000 to 66,000, each row holding $1M of bids and of asks.
  const flat = (bin0: number, n: number): Grouped => { const a = new Float32Array(n).fill(1e6); return { ids: ['x:BTC'], step: 50, bin0, nBins: n, bid: [a], ask: [a], totalBid: a, totalAsk: a }; };
  const view = flat(1160, 40), wide = flat(1080, 240);
  const near = depthBand(view, 59_025, 1170 - 1160, () => wide)!;
  assert.equal(near.grid, view, 'price and mirror inside the view: the view\'s grouping');
  assert.deepEqual([near.below, near.above, near.clipped], [11e6, 11e6, false], 'the price\'s row and ten more each way');
  // The price above the view (61,025): the hovered row 58,500 is 50 rows below it; the bids count from the price, not from the view's top.
  const above = depthBand(view, 61_025, 1170 - 1160, () => wide)!;
  assert.equal(above.grid, wide);
  assert.deepEqual([above.below, above.above, above.clipped], [51e6, 51e6, false]);
  assert.equal(above.grid.bin0 + above.loBin, 1170); assert.equal(above.grid.bin0 + above.hiBin, 1270, 'the far rows: the hovered one and its mirror');
  // The price below the view (57,025): every visible row is an ask row.
  const below = depthBand(view, 57_025, 1190 - 1160, () => wide)!;
  assert.deepEqual([below.below, below.above, below.clipped], [51e6, 51e6, false]);
  // The price on screen but the mirror row off it (price 59,925, row 58,250: mirror 61,600).
  const mirror = depthBand(view, 59_925, 1165 - 1160, () => wide)!;
  assert.equal(mirror.grid, wide); assert.deepEqual([mirror.below, mirror.above], [34e6, 34e6]);
  // No grouping can hold it: the view's, clamped, and said to be clipped (the old behaviour).
  const refused = depthBand(view, 61_025, 1170 - 1160, () => null)!;
  assert.equal(refused.grid, view); assert.equal(refused.clipped, true); assert.ok(refused.below < 51e6, String(refused.below));
  // The price's own row has no band.
  assert.equal(depthBand(view, 59_025, 1180 - 1160, () => wide), null);
});

test('the seam weighs the book against the levels per side, says how far the feeds reach and how old the levels are, and gives no verdict', () => {
  const f = { kind: 'liq' as const, pct: '0.95%', above: { book: 699.5e6, liq: 5.5e6 }, below: { book: 706.7e6, liq: 1.9e6 }, reach: { bid: 15, ask: 15, of: 24 }, minutes: { positions: 74.6, orders: 31.2 }, clipped: false };
  const lines = text(seamCardLines(f));
  assert.deepEqual(lines, ['Book against liquidations, ±0.95%', 'Above the price', 'Asks: $699.5M', 'Short liquidations: $5.5M', 'Below the price', 'Bids: $706.7M', 'Long liquidations: $1.9M',
    'Depth coverage: bids 15/24 · asks 15/24', 'Positions: 75 min ago · book: now']);
  assert.ok(!lines.some(l => /cover the|exceed|rank|neighbour|on screen/i.test(l)), 'no cover verdicts, correlations, neighbour ratios or whole-screen lines');
  assert.equal(text(seamCardLines({ ...f, kind: 'stops' })).at(-1), 'Orders: 31 min ago · book: now', 'stops: the orders\' own snapshot');
  assert.equal(text(seamCardLines({ ...f, kind: 'both' })).at(-1), 'Positions: 75 min ago · orders: 31 min ago · book: now', 'Liq + stops: each snapshot its own age');
  assert.equal(text(seamCardLines({ ...f, kind: 'both', minutes: { positions: 74.6, orders: null } })).at(-1), 'Positions: 75 min ago · book: now');
  assert.equal(text(seamCardLines({ ...f, minutes: { positions: null, orders: null } })).at(-1), 'Depth coverage: bids 15/24 · asks 15/24');
  // A band past the view that no grouping could hold says its amounts are partial; the long age line may wrap on a phone.
  assert.ok(text(seamCardLines({ ...f, clipped: true })).includes('part of the range is outside the data'));
  assert.equal(seamCardLines({ ...f, kind: 'both' }).at(-1)!.wrap, true);
});

test('a reading is kept for a second on the same row, and read again at once for another row or after the second', () => {
  assert.equal(ROW_HOLD_MS, 1000);
  const held = new Held<number>(ROW_HOLD_MS);
  let reads = 0; const read = (v: number) => () => { reads++; return v; };
  assert.equal(held.get('a', 0, read(1)), 1);
  assert.equal(held.get('a', 999, read(2)), 1, 'the same row within the second keeps its reading');
  assert.equal(held.get('b', 1000, read(3)), 3, 'another row reads at once');
  assert.equal(held.get('b', 1999, read(4)), 3);
  assert.equal(held.get('b', 2000, read(5)), 5, 'the second up: read again');
  assert.equal(reads, 3);
});

test('the right half of a split liquidation column has its box against its own edge, over the left half; the left half\'s stays at the map\'s edge', () => {
  const pw = 487, ph = 876, x1 = pw + 100;
  assert.deepEqual(liqSubBoxFrame(0, pw, pw, ph, 97, 72), { x: pw, bounds: { x0: 0, y0: 0, x1: pw, y1: ph } });
  assert.deepEqual(liqSubBoxFrame(1, x1, pw, ph, 97, 72), { x: x1, bounds: { x0: 0, y0: 97, x1, y1: ph } }, 'below the heading where it fits');
  assert.equal(liqSubBoxFrame(1, x1, pw, 160, 97, 72).bounds.y0, 0, 'a map too short for that: from the top');
});

test('the map draws these boxes: the profile from its row and band, the band from the price when scrolled away, the split\'s right half in its frame', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  const body = (name: string): string => { const start = heat.indexOf(`  ${name}(`), end = heat.indexOf('\n  }\n', start); assert.ok(start > 0, name); return heat.slice(start, end); };
  const profile = body('#paintProfileMirror');
  assert.match(profile, /depthRowLines\(row, step\)/);
  assert.match(profile, /groupSpan\(v\.p0, v\.p1, mark, step\)/);
  assert.match(profile, /depthBandLines\(/);
  assert.match(profile, /depthHereLine\(/);
  assert.match(body('#paintLiqColumnMirror'), /liqCardLines\(/);
  assert.match(body('#paintSeam'), /seamCardLines\(/);
  assert.match(body('#paintSeam'), /seamSpan\(v\.p0, v\.p1, price, d, step, Math\.min\(MAX_BINS, LIQ_PROFILE_ROWS\)\)/, 'the whole band, within what both groupings hold');
  assert.match(body('#paintSeam'), /const clipped = past && !span;/);
  assert.match(body('#paintLiqColumnMirror'), /standingBins\(s, side, row\.kLo, row\.kHi\)/);
  assert.match(body('#paintLiqColumnMirror'), /binsBetween\(set\.levels, side, row\.kLo, row\.kHi\)/);
  assert.match(body('#paintLiqSplit'), /mirrorFrame\(ctx, box\.lines, h => liqSubBoxFrame\(at, subs\[at\]\.x0, pw, ph, this\.#liqHeadH, h\)\)/, 'measured as drawn, wrapped to its frame');
  // The book's band reaches the verdict the right way round: the bids below the price, the asks above it (`depthBand`'s below and above).
  assert.match(profile, /const G = b\.grid, \{ above, below, loBin, hiBin \} = b;/);
  assert.match(profile, /depthBandLines\(\{ bid: below, ask: above, /);
});

test('the liquidation card speaks of whole snapshot bins, by number: the column\'s row where it is made of them, the bin itself where narrower', () => {
  assert.deepEqual(liqCardRow(58_472, 50, 10), { lo: 58_450, hi: 58_500, kLo: 5845, kHi: 5850 }, 'a $50 row of $10 bins');
  assert.deepEqual(liqCardRow(58_452.3, 0.5, 10), { lo: 58_450, hi: 58_460, kLo: 5845, kHi: 5846 }, 'zoomed far in: the $10 bin, so its count and largest match its amount');
  assert.deepEqual(liqCardRow(58_512, 25, 10), { lo: 58_500, hi: 58_530, kLo: 5850, kHi: 5853 }, 'a row that is no whole number of bins: the bins that start in it');
  assert.deepEqual(liqCardRow(58_472, 50, 0), { lo: 58_450, hi: 58_500, kLo: null, kHi: null }, 'no bin size known: the column\'s own row');
  // Quotients a hair off a whole number are that number (Sol, review 2026-11-20): no bin skipped, none borrowed from below.
  const fine = liqCardRow(50_000.125, 0.05, 0.001);
  assert.deepEqual([fine.kLo, fine.kHi], [50_000_100, 50_000_150]);
  const tiny = liqCardRow(4.32, 0.02, 0.1);
  assert.deepEqual([tiny.kLo, tiny.kHi], [43, 44]);
  // A real boundary a third of a bin inside the row is not snapped down, however many bins (Sol, round 4: 16,666,733.33 bins).
  const many = liqCardRow(50_000.175, 0.05, 0.003);
  assert.deepEqual([many.kLo, many.kHi], [16_666_717, 16_666_734]);
});

test('the card reads whole bins by number: what stands, and the snapshot\'s count and largest, of the same bins', () => {
  // Two bins of $0.10: 42 holds $1M of 90 positions, 43 holds $10K of one.
  const levels = { step: 0.1, k: Int32Array.from([42, 43]), longIso: Float64Array.from([1e6, 1e4]), longCross: Float64Array.from([0, 0]), shortIso: Float64Array.from([0, 0]), shortCross: Float64Array.from([0, 0]),
    longWallets: Uint32Array.from([90, 1]), shortWallets: Uint32Array.from([0, 0]), longTop: Float64Array.from([1e6, 1e4]), shortTop: Float64Array.from([0, 0]) } as unknown as LiqLevels;
  const s = liqStanding(levels, null);
  assert.equal(standingBins(s, 'long', 43, 44), 1e4);
  assert.deepEqual(binsBetween(levels, 'long', 43, 44), { positions: 1, top: 1e4 }, 'not bin 42\'s 90 positions and $1M');
  assert.equal(standingBins(s, 'long', 42, 44), 1_010_000);
  assert.equal(standingBins(s, 'long', 44, 44), 0);
});

test('the seam spans the view and its whole band, from the price itself, within what the groupings hold', () => {
  // Sol's case: the price above the view; the band reaches 79,630, past where a span mirrored about the price's row stopped (79,595).
  const span = seamSpan(58_455, 68_455, 69_045, 69_045 - 58_460, 50, 5_000)!;
  assert.ok(span.lo <= 58_455 && span.hi >= 69_045 + (69_045 - 58_460), JSON.stringify(span));
  assert.equal(seamSpan(58_000, 58_100, 59_350, 1_300, 0.2, 5_000), null, 'more rows than a profile holds: none (the box says part is outside)');
});

test('the band names the heavier side and how many times the other it is; about even under 1.02×; only one side where the other has nothing (Karl, 2026-11-21)', () => {
  // The old box said it ("This side has 1.4× more"); a ratio in one fixed order ("longs / shorts 0.20×") had him work it out.
  const v = (b: number, a: number) => depthBandVerdict(b, a, '1%');
  assert.deepEqual([v(141, 100).text, v(141, 100).color, v(141, 100).bold], ['Within ≈±1%: bids 1.41× the asks', 'below', true]);
  assert.deepEqual([v(100, 141).text, v(100, 141).color], ['Within ≈±1%: asks 1.41× the bids', 'above']);
  assert.equal(v(101.9, 100).text, 'Within ≈±1%: bids and asks about even', 'under the Mirror\'s balance');
  assert.equal(v(100, 101.9).color, undefined, 'in the text\'s ink');
  assert.equal(v(102.1, 100).text, 'Within ≈±1%: bids 1.02× the asks', 'just past it, named');
  assert.equal(v(1_250, 100).text, 'Within ≈±1%: bids 12.5× the asks');
  assert.deepEqual([v(5, 0).text, v(5, 0).color], ['Within ≈±1%: only bids', 'below']);
  assert.deepEqual([v(0, 5).text, v(0, 5).color], ['Within ≈±1%: only asks', 'above']);
  assert.deepEqual([v(0, 0).text, v(0, 0).color], ['Within ≈±1%: no bids or asks', 'muted']);
  assert.equal(v(NaN, 5).text, 'Within ≈±1%: only asks', 'a side not known counts as nothing');
  assert.equal(v(-5, 5).text, 'Within ≈±1%: only asks', 'nor one below zero');
  assert.equal(v(Infinity, 5).text, 'Within ≈±1%: only asks', 'nor an endless one');
  assert.equal(v(Infinity, Infinity).text, 'Within ≈±1%: no bids or asks');
  assert.equal(v(102, 100).text, 'Within ≈±1%: bids 1.02× the asks', 'at the balance itself, named');
  assert.deepEqual([v(100, 101.9).text, v(100, 101.9).bold], ['Within ≈±1%: bids and asks about even', true], 'about even, said as plainly as a side');
  assert.equal(v(5e6, 1e-9).text, 'Within ≈±1%: bids ≥1000× the asks', 'a side all but empty: no sixteen digits');
  const l = (a: number, b: number) => liqBandVerdict(a, b, '5%', 'below', 'above');
  assert.deepEqual([l(10, 50).text, l(10, 50).color], ['Within ≈±5%: shorts 5.00× the longs', 'above']);
  assert.deepEqual([l(50, 10).text, l(50, 10).color], ['Within ≈±5%: longs 5.00× the shorts', 'below']);
  assert.deepEqual([l(100, 101).text, l(100, 101).color, l(100, 101).bold], ['Within ≈±5%: longs and shorts about even', undefined, true]);
  assert.equal(l(102, 100).text, 'Within ≈±5%: longs 1.02× the shorts', 'at the balance itself, named');
  assert.deepEqual([l(3, 0).text, l(0, 3).text, l(0, 0).text], ['Within ≈±5%: only longs', 'Within ≈±5%: only shorts', 'Within ≈±5%: no longs or shorts']);
  assert.deepEqual([l(3, 0).color, l(0, 3).color, l(0, 0).color], ['below', 'above', 'muted'], 'only one side: in that side\'s colour');
  assert.deepEqual([l(-1, 3).text, l(Infinity, 3).text], ['Within ≈±5%: only shorts', 'Within ≈±5%: only shorts']);
  assert.ok([l(3, 0), l(0, 3), l(0, 0), l(100, 101), l(10, 50)].every(x => x.rule === true), 'under the card\'s rule whatever it says');
  // Every case wraps: in German or Russian the sentence is wider than a phone's map leaves the box (review 2026-11-21).
  assert.ok([v(141, 100), v(100, 141), v(101.9, 100), v(5, 0), v(0, 5), v(0, 0), l(3, 0), l(0, 3), l(0, 0), l(100, 101), l(10, 50), l(50, 10)].every(x => x.wrap === true));
  // Take profits: the colours follow whose orders they are, where they stand.
  assert.equal(liqBandVerdict(10, 50, '5%', 'above', 'below').color, 'below');
});

test('the band reaches the verdict the right way round: more bids than asks says bids, from the grouping to the line', () => {
  // Bids $2M a row and asks $1M: the price's row and ten more each way hold $22M of bids and $11M of asks.
  const bid = new Float32Array(40).fill(2e6), ask = new Float32Array(40).fill(1e6);
  const g: Grouped = { ids: ['x:BTC'], step: 50, bin0: 1160, nBins: 40, bid: [bid], ask: [ask], totalBid: bid, totalAsk: ask };
  const b = depthBand(g, 59_025, 1170 - 1160, () => null)!;
  assert.deepEqual([b.below, b.above], [22e6, 11e6]);
  const reach = { bid: 1, ask: 1, of: 1 };
  assert.equal(depthBandLines({ bid: b.below, ask: b.above, pct: '1%', reach, totals: false, clipped: false })[0]!.text, 'Within ≈±1%: bids 2.00× the asks');
  assert.equal(depthBandLines({ bid: b.below, ask: b.above, pct: '1%', reach, totals: false, clipped: false })[0]!.color, 'below');
});
