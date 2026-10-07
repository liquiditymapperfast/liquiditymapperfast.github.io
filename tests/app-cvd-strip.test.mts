import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowBook } from '../src/app/flow-book.ts';
import { Ranker } from '../src/app/cvd/rank.ts';
import { buildModel } from '../src/app/cvd/model.ts';
import { CVD_DEFAULTS, readCvd, rankingKey, type CvdSettings } from '../src/app/cvd/settings.ts';
import { DEFAULT_STAT_OPTIONS } from '../src/app/stat-options.ts';
import { SIZE_EDGES, type SizesAnswer, type SizesWindow } from '../src/shared/footprint.ts';
import { GEOMETRY, PULSE_MINUTES, askedWindows, bandOf, buildStrip, coverageNote, flashBands, heading, isPartial, ledRow, percent, pulseRows, rankMinutes, rowAt, rowLines, sizeBands, sizeRows, stripHeight, weightDots, weightText } from '../src/app/cvd/strip.ts';

const NOW = Date.UTC(2026, 9, 6, 12, 30, 0), SEC = NOW / 1000;
const kinds: Record<string, 'spot' | 'perp'> = { 'binance:BTCUSDT': 'perp', 'binancespot:BTCUSDT': 'spot', 'coinbase:BTC-USD': 'spot', 'bybit:BTCUSDT': 'perp', 'okx:BTC-USDT-SWAP': 'perp', 'okx:BTC-USD-SWAP': 'perp' };
const kindOf = (id: string) => kinds[id] ?? null;
/** Per second: `buy` and `sell` USD for `seconds` seconds ending at NOW. */
function feed(book: FlowBook, id: string, buy: number, sell: number, seconds = 7_200): void {
  const items: [string, number, number, number][] = [];
  for (let i = seconds - 1; i >= 0; i--) items.push([id, (SEC - i) * 1000, buy, sell]);
  book.apply(items);
}
const settings = (over: Partial<CvdSettings> = {}): CvdSettings => ({ ...CVD_DEFAULTS, span: '1h', rank: '1h', ...over });

/** A sizes window whose bucket i holds `i + 1` thousand USD of buys and `(i + 1) * 2` thousand of sells. */
const window = (minutes: number, seen = minutes, stats = minutes, extra: Partial<SizesWindow> = {}): SizesWindow => ({
  minutes, seen, stats, buyN: 100, sellN: 120, buy: SIZE_EDGES.map((_, i) => (i + 1) * 1_000), sell: SIZE_EDGES.map((_, i) => (i + 1) * 2_000), ...extra,
});
const answer = (rank: number, over: Record<number, Partial<SizesWindow>> = {}): SizesAnswer => ({ windows: askedWindows(rank).map(m => window(m, m, m, over[m])) });

test('the default bands are the four of the sample: under 25K, the rest of retail, the middle, and whales', () => {
  const bands = sizeBands(CVD_DEFAULTS);
  assert.deepEqual(bands.map(b => [b.from, b.to, b.label]), [[0, 0, '< 25K'], [1, 2, '25K–100K'], [3, 4, '100K–500K'], [5, 7, '500K+']]);
  assert.equal(CVD_DEFAULTS.stripRetailMax, DEFAULT_STAT_OPTIONS.retailMax, 'the Bar stats limits are the starting values');
  assert.equal(CVD_DEFAULTS.stripWhaleMin, DEFAULT_STAT_OPTIONS.whaleMin);
});

test('the bands follow the limits: no empty band, never overlapping, always covering every bucket', () => {
  const edge = (o: Partial<CvdSettings>) => sizeBands({ ...CVD_DEFAULTS, ...o }).map(b => `${b.from}-${b.to}`);
  assert.deepEqual(edge({ stripSmall: false }), ['0-2', '3-4', '5-7'], 'retail on one row: three bands');
  assert.deepEqual(edge({ stripRetailMax: 4, stripWhaleMin: 5 }), ['0-0', '1-4', '5-7'], 'nothing between retail and whales: no middle band');
  assert.deepEqual(edge({ stripRetailMax: 0 }), ['0-0', '1-4', '5-7'], 'retail is the first bucket alone: it is not split from itself');
  assert.deepEqual(edge({ stripRetailMax: 6, stripWhaleMin: 7 }), ['0-0', '1-6', '7-7']);
  for (const retail of [0, 1, 2, 3, 4, 5, 6]) for (const whale of [1, 2, 3, 4, 5, 6, 7]) for (const small of [true, false]) {
    const bands = sizeBands({ stripRetailMax: retail, stripWhaleMin: whale, stripSmall: small });
    const covered = bands.flatMap(b => Array.from({ length: b.to - b.from + 1 }, (_, i) => b.from + i));
    assert.deepEqual(covered, [0, 1, 2, 3, 4, 5, 6, 7], `${retail}/${whale}/${small}: every bucket once, in order`);
    assert.ok(bands.length >= 2 && bands.length <= 4);
  }
});

test('a trade belongs to the band of its size bucket, and a trade under the first bucket is on the first band', () => {
  const bands = sizeBands(CVD_DEFAULTS);
  assert.equal(bandOf(bands, 10_000), 0); assert.equal(bandOf(bands, 25_000), 1); assert.equal(bandOf(bands, 99_999), 1);
  assert.equal(bandOf(bands, 100_000), 2); assert.equal(bandOf(bands, 499_999), 2); assert.equal(bandOf(bands, 500_000), 3); assert.equal(bandOf(bands, 12_000_000), 3);
});

test('a trade makes the row of its size light, for the instruments the aggregate counts and no others', () => {
  const bands = sizeBands(CVD_DEFAULTS), counted = new Set(['binance:BTCUSDT', 'binancespot:BTCUSDT']);
  const trade = (id: string, usd: number) => ({ id, usd });
  assert.deepEqual(flashBands(bands, counted, [trade('binance:BTCUSDT', 150_000)]), [2]);
  assert.deepEqual(flashBands(bands, counted, [trade('binance:BTCUSDT', 30_000), trade('binancespot:BTCUSDT', 4_000_000), trade('binance:BTCUSDT', 60_000)]).sort(), [1, 3], 'one row for the two trades of the same size');
  assert.deepEqual(flashBands(bands, counted, [trade('bybit:BTCUSDT', 150_000)]), [], 'a venue the aggregate does not count: its trade says nothing about these rows');
  assert.deepEqual(flashBands(bands, counted, [trade('binance:BTCUSDT', 10_000)]), [], 'under the first bucket: the print stream does not report it, and no row waits for it');
  assert.deepEqual(flashBands(bands, counted, []), []);
  const merged = sizeBands({ ...CVD_DEFAULTS, stripSmall: false });
  assert.deepEqual(flashBands(merged, counted, [trade('binance:BTCUSDT', 30_000)]), [0], 'with retail on one row a trade of 30K lights it');
});

test('a window is partial when under nine in ten of its minutes were recorded, and one lost minute is a clock edge, not a gap', () => {
  assert.equal(isPartial(47, 60), true); assert.equal(isPartial(53, 60), true); assert.equal(isPartial(54, 60), false);
  assert.equal(isPartial(13, 15), true); assert.equal(isPartial(14, 15), false); assert.equal(isPartial(15, 15), false);
  assert.equal(isPartial(0, 1), false, 'a one-minute window cannot lose more than the edge'); assert.equal(isPartial(3, 5), true); assert.equal(isPartial(4, 5), false);
  assert.equal(isPartial(1295, 1440), true); assert.equal(isPartial(1296, 1440), false);
  assert.equal(isPartial(null, 60), false, 'not known is not partial');
});

test('the windows asked for are the flow rows and the ranking window, each once, in order', () => {
  assert.deepEqual(askedWindows(15), [1, 5, 15, 60]); assert.deepEqual(askedWindows(60), [1, 5, 15, 60]); assert.deepEqual(askedWindows(1_440), [1, 5, 15, 60, 1_440]);
  assert.equal(rankMinutes(settings({ rank: '24h' })), 1_440);
});

test('the strip is 118 px tall with four size rows, and each row is where the pointer finds it', () => {
  assert.equal(stripHeight(4), 118, 'the height of the sample');
  assert.equal(stripHeight(3), 108);
  const g = GEOMETRY, first = g.pad + 1 + g.headH;
  for (let i = 0; i < 4; i++) assert.deepEqual(rowAt(first + i * g.rowH + 3, 4), { group: 'pulse', index: i });
  const sizes = first + 4 * g.rowH + g.groupGap + g.headH;
  for (let i = 0; i < 4; i++) assert.deepEqual(rowAt(sizes + i * g.rowH + 3, 4), { group: 'size', index: i });
  assert.equal(rowAt(2, 4), null, 'the padding'); assert.equal(rowAt(g.pad + 3, 4), null, 'the first heading'); assert.equal(rowAt(sizes - 3, 4), null, 'the second heading'); assert.equal(rowAt(stripHeight(4), 4), null);
  assert.deepEqual(rowAt(sizes + 3 * g.rowH + 3, 4), { group: 'size', index: 3 }); assert.equal(rowAt(sizes + 3 * g.rowH + 3, 3), null, 'with three size rows there is no fourth');
});

test('the dots: buys fill from the left, sells from the right, the side that is ahead is lit and the other dim, and two dots mark the middle', () => {
  const row = ledRow(0.73, 30), n = (kind: string) => row.dots.filter(d => d === kind).length;
  assert.equal(row.dots.length, 30);
  assert.deepEqual(row.dots.slice(14, 16), ['mid-on', 'mid-on'], 'the middle two');
  assert.equal(n('mid-on'), 2);
  assert.equal(n('buy-on'), 22 - 2, 'round(30 x 0.73) = 22 dots of buys, two of them the middle ones');
  assert.equal(n('sell-dim'), 8); assert.equal(n('buy-dim'), 0); assert.equal(n('sell-on'), 0);
  assert.equal(row.lead, 21, 'the last buy dot wears the ring');
  const sells = ledRow(0.25, 20);
  assert.equal(sells.dots.filter(d => d === 'sell-on').length, 13, 'round(20 x 0.25) = 5 buy dots, so 15 sell dots less the two middle ones'); assert.equal(sells.lead, 5, 'the first sell dot wears it');
  assert.equal(sells.dots[0], 'buy-dim');
  const even = ledRow(0.5, 20); assert.equal(even.lead, -1); assert.ok(even.dots.every(d => d.endsWith('-on')), 'an even split lights both sides');
  const none = ledRow(null, 20); assert.equal(none.lead, -1); assert.ok(none.dots.every(d => d.endsWith('-off')), 'nothing traded: dark throughout'); assert.deepEqual(none.dots.slice(9, 11), ['mid-off', 'mid-off']);
  assert.equal(ledRow(1, 20).dots.filter(d => d === 'buy-on').length, 18); assert.equal(ledRow(0, 20).dots.filter(d => d === 'sell-on').length, 18);
});

test('the numbers beside the rows: whole percent, a share too small to round to one says so, and ten weight dots', () => {
  assert.equal(percent(0.734), '73%'); assert.equal(percent(null), '–');
  assert.equal(weightText(0.07), '7%'); assert.equal(weightText(0.001), '<1%'); assert.equal(weightText(0), '0%'); assert.equal(weightText(null), '–');
  assert.equal(weightDots(0.35), 4); assert.equal(weightDots(0.07), 1); assert.equal(weightDots(0), 0); assert.equal(weightDots(1), 10); assert.equal(weightDots(null), 0);
});

test('the flow rows add the same instruments over the same seconds as ALL VENUES, so a one-hour row is the aggregate row\'s hour', () => {
  const book = new FlowBook();
  feed(book, 'binance:BTCUSDT', 60_000, 40_000); feed(book, 'binancespot:BTCUSDT', 12_000, 18_000); feed(book, 'coinbase:BTC-USD', 5_000, 4_000); feed(book, 'bybit:BTCUSDT', 20_000, 30_000);
  feed(book, 'okx:BTC-USDT-SWAP', 7_000, 3_000); feed(book, 'okx:BTC-USD-SWAP', 900_000, 100_000);      // a second perpetual of an exchange is not a lane of the aggregate
  const ids = ['binance:BTCUSDT', 'binancespot:BTCUSDT', 'coinbase:BTC-USD', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP', 'okx:BTC-USD-SWAP', 'nodata:BTC'];
  const model = buildModel({ flow: book, ids, kindOf, t0: NOW - 3_600_000, t1: NOW, columns: 60, now: NOW, settings: settings(), ranker: new Ranker() });
  assert.deepEqual([...model.counted].sort(), ['binance:BTCUSDT', 'binancespot:BTCUSDT', 'bybit:BTCUSDT', 'coinbase:BTC-USD', 'okx:BTC-USDT-SWAP'], 'the lanes of the aggregate: no second perpetual, nothing without flow');
  const rows = pulseRows(book, model.counted, SEC, () => null), hour = rows[3]!;
  const buy = (model.spot?.buy ?? 0) + (model.perp?.buy ?? 0), sell = (model.spot?.sell ?? 0) + (model.perp?.sell ?? 0);
  assert.ok(Math.abs(hour.buy - buy) <= 1e-6 * buy, `${hour.buy} against ${buy}`); assert.ok(Math.abs(hour.sell - sell) <= 1e-6 * sell);
  assert.equal(hour.label, '1h'); assert.deepEqual(rows.map(r => r.minutes), [...PULSE_MINUTES]);
  // each shorter row is the same per-second flow over fewer seconds
  const perSecond = 60_000 + 12_000 + 5_000 + 20_000 + 7_000;
  assert.equal(rows[0]!.buy, perSecond * 60, 'one minute is sixty seconds'); assert.equal(rows[1]!.buy, perSecond * 300);
  assert.ok(Math.abs(rows[3]!.share! - perSecond / (perSecond + 40_000 + 18_000 + 4_000 + 30_000 + 3_000)) < 1e-12);
});

test('the strip knows where it stands: rows from the answer, idle while it waits, and a plain failure with nothing made up', () => {
  const book = new FlowBook(); feed(book, 'binance:BTCUSDT', 3_000, 1_000);
  const counted = ['binance:BTCUSDT'], input = { flow: book, counted, nowSec: SEC, settings: settings(), scope: 'all' as const };
  const ready = buildStrip({ ...input, sizes: answer(60), state: 'ready' });
  assert.equal(ready.size.state, 'ready'); assert.equal(ready.window, '1H'); assert.equal(ready.heading, 'ALL VENUES');
  assert.deepEqual(ready.size.rows.map(r => r.label), ['< 25K', '25K–100K', '100K–500K', '500K+']);
  assert.deepEqual(ready.size.rows.map(r => r.range), ['< $25K', '$25K–$100K', '$100K–$500K', '$500K+'], 'a sentence says the dollars');
  // the sample's buckets: band two holds buckets 1 and 2 = (2 + 3) thousand of buys and (4 + 6) thousand of sells
  assert.equal(ready.size.rows[1]!.buy, 5_000); assert.equal(ready.size.rows[1]!.sell, 10_000);
  assert.equal(ready.size.rows[3]!.buy, (6 + 7 + 8) * 1_000);
  assert.ok(Math.abs(ready.size.rows.reduce((s, r) => s + (r.weight ?? 0), 0) - 1) < 1e-12, 'the shares of the volume add up to all of it');
  assert.equal(ready.size.partial, false); assert.equal(ready.pulse.every(r => !r.partial), true);

  const loading = buildStrip({ ...input, sizes: null, state: 'loading' });
  assert.equal(loading.size.state, 'loading'); assert.ok(loading.size.rows.every(r => r.share === null && r.weight === null && r.covered === null), 'idle rows, no numbers');
  assert.ok(loading.pulse.every(r => r.covered === null && !r.partial), 'the flow rows need nothing from the sizes: they say what they have and make no claim about the recording');
  assert.ok(loading.pulse[0]!.share !== null, 'and they are not idle');
  const failed = buildStrip({ ...input, sizes: null, state: 'unavailable' });
  assert.equal(failed.size.state, 'unavailable'); assert.ok(failed.size.rows.every(r => r.share === null));
  const nothing = buildStrip({ ...input, counted: [], sizes: null, state: 'loading' });
  assert.equal(nothing.size.state, 'empty'); assert.equal(nothing.pulse[0]!.share, null);
  // an answer that has no window for this rank is a question still to ask
  const wrongRank = buildStrip({ ...input, settings: settings({ rank: '24h' }), sizes: answer(60), state: 'ready' });
  assert.equal(wrongRank.size.state, 'loading');
});

test('a partly recorded window is marked on the rows it spans and nowhere else', () => {
  const book = new FlowBook(); feed(book, 'binance:BTCUSDT', 3_000, 1_000);
  // the sample: the hour is recorded for 47 of its 60 minutes, the quarter hour for 11 of 15, the last five minutes whole
  const sizes: SizesAnswer = { windows: [window(1, 1, 1), window(5, 5, 5), window(15, 11, 11), window(60, 47, 47)] };
  const data = buildStrip({ flow: book, counted: ['binance:BTCUSDT'], nowSec: SEC, settings: settings(), scope: 'all', sizes, state: 'ready' });
  assert.deepEqual(data.pulse.map(r => r.partial), [false, false, true, true]);
  assert.deepEqual(data.pulse.map(r => r.covered), [1, 5, 11, 47]);
  assert.equal(data.size.partial, true); assert.equal(data.size.covered, 47); assert.equal(data.size.minutes, 60);
  assert.ok(data.size.rows.every(r => r.partial && r.covered === 47 && r.minutes === 60));
  assert.equal(coverageNote(47, 60), '47/60 MIN');
  // the size rows' recording is the statistics, which a minute recorded before they were kept does not have
  const old: SizesAnswer = { windows: [window(1), window(5), window(15), window(60, 60, 20)] };
  const legacy = buildStrip({ flow: book, counted: ['binance:BTCUSDT'], nowSec: SEC, settings: settings(), scope: 'all', sizes: old, state: 'ready' });
  assert.equal(legacy.pulse[3]!.partial, false, 'the flow row spans sixty recorded minutes'); assert.equal(legacy.size.partial, true, 'the size rows have statistics for twenty');
});

test('the heading says which kind of market the filter leaves in, in the aggregate row\'s own words', () => {
  assert.equal(heading('all'), 'ALL VENUES'); assert.equal(heading('spot'), 'ALL SPOT VENUES'); assert.equal(heading('perp'), 'ALL PERP VENUES');
});

test('what the pointer is told on a row: the figures, the share, and what the recording covers', () => {
  const book = new FlowBook(); feed(book, 'binance:BTCUSDT', 3_000, 1_000);
  const sizes: SizesAnswer = { windows: [window(1), window(5), window(15, 11, 11), window(60, 47, 47)] };
  const data = buildStrip({ flow: book, counted: ['binance:BTCUSDT'], nowSec: SEC, settings: settings(), scope: 'all', sizes, state: 'ready' });
  const flow = rowLines(data.pulse[2]!, data), text = (lines: ReturnType<typeof rowLines>) => lines.map(l => `${l.label ?? ''}|${l.text}`);
  assert.deepEqual(text(flow).slice(0, 6), ['|Taker flow, 15m', '|ALL VENUES', 'Buys / sells|$2.7M / $900K', 'Net|+$1.8M', 'Buy share|75%', 'Recorded|11 of 15 minutes']);
  assert.match(flow.at(-1)!.text, /Part of this window was not recorded/); assert.equal(flow.find(l => l.label === 'Recorded')!.bold, true);
  const size = rowLines(data.size.rows[3]!, data);
  assert.equal(size[0]!.text, 'Trades $500K+, 1H'); assert.ok(size.some(l => l.label === 'Share of volume'));
  assert.ok(size.some(l => l.label === 'Recorded' && l.text === '47 of 60 minutes'));
  const whole = buildStrip({ flow: book, counted: ['binance:BTCUSDT'], nowSec: SEC, settings: settings(), scope: 'all', sizes: answer(60), state: 'ready' });
  const clean = rowLines(whole.pulse[3]!, whole);
  assert.equal(clean.some(l => /not recorded/.test(l.text)), false, 'a whole window says nothing about gaps'); assert.equal(clean.find(l => l.label === 'Recorded')!.bold, false);
  const empty = new FlowBook(), quiet = buildStrip({ flow: empty, counted: [], nowSec: SEC, settings: settings(), scope: 'all', sizes: null, state: 'loading' });
  assert.equal(rowLines(quiet.pulse[0]!, quiet)[2]!.text, 'Nothing traded in this window.');
  assert.deepEqual(sizeRows(sizeBands(CVD_DEFAULTS), null, 60).map(r => r.share), [null, null, null, null]);
});

test('the strip\'s settings: the Bar stats limits to start with, damaged saves repaired, and the limits kept apart', () => {
  assert.deepEqual([CVD_DEFAULTS.strip, CVD_DEFAULTS.stripSmall, CVD_DEFAULTS.stripBlink], [true, true, true]);
  const read = (saved: unknown) => readCvd(saved);
  assert.equal(read(undefined).stripRetailMax, 2); assert.equal(read(undefined).stripWhaleMin, 5);
  assert.equal(read({ stripRetailMax: 4, stripWhaleMin: 6 }).stripWhaleMin, 6);
  const crossed = read({ stripRetailMax: 5, stripWhaleMin: 2 });
  assert.ok(crossed.stripWhaleMin > crossed.stripRetailMax, 'whales start above retail');
  assert.equal(read({ stripRetailMax: 99 }).stripRetailMax, 6); assert.equal(read({ stripRetailMax: 'x', stripWhaleMin: NaN }).stripRetailMax, 2);
  assert.equal(read({ stripWhaleMin: 99 }).stripWhaleMin, 7); assert.equal(read({ strip: 'yes', stripBlink: 1, stripSmall: null }).strip, true, 'a value of the wrong kind is the default');
  assert.equal(read({ strip: false }).strip, false);
  // changing only the strip's own settings leaves the ranking key alone, and changing one of the ranking's does not
  const base = settings();
  for (const patch of [{ strip: false }, { stripRetailMax: 4, stripWhaleMin: 6 }, { stripSmall: false }, { stripBlink: false }] satisfies Partial<CvdSettings>[]) assert.equal(rankingKey({ ...base, ...patch }), rankingKey(base), JSON.stringify(patch));
  for (const patch of [{ rank: '24h' }, { top: 5 }, { span: '4h' }, { pinned: ['okx'] }, { rebase: false }, { quietFlag: false }] satisfies Partial<CvdSettings>[]) assert.notEqual(rankingKey({ ...base, ...patch }), rankingKey(base), JSON.stringify(patch));
});
