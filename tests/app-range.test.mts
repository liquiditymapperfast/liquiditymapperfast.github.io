import test from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, draftOf, follow, refreshMs, rowStep, selects, snap, type RangeSelection } from '../src/app/range/selection.ts';
import { draftLabel, rangeLines, type RangeInput, type RangeLine } from '../src/app/range/stats.ts';
import type { RangeAnswer, RangeInstrument } from '../src/shared/footprint.ts';
import type { AbsorptionMark } from '../src/app/absorption.ts';

const T0 = Date.UTC(2026, 9, 8, 14, 0, 0);

test('a drag becomes the whole minutes it touches; one that reaches the open minute is live and follows the clock', () => {
  const draft = draftOf({ t: T0 + 10 * MINUTE + 20_000, p: 81_900 }, { t: T0 + 2 * MINUTE + 5_000, p: 81_200 });
  assert.deepEqual([draft.t0, draft.t1, draft.p0, draft.p1, draft.draft], [T0 + 2 * MINUTE + 5_000, T0 + 10 * MINUTE + 20_000, 81_200, 81_900, true], 'either way round');
  const made = snap(draft, T0 + 60 * MINUTE);
  assert.deepEqual([made.t0, made.t1, made.live, made.draft], [T0 + 2 * MINUTE, T0 + 11 * MINUTE, false, false]);
  assert.equal(snap(draftOf({ t: T0 + 1_000, p: null }, { t: T0 + 2_000, p: null }), T0 + 60 * MINUTE).t1, T0 + MINUTE, 'a click-sized drag is one minute');
  assert.deepEqual([snap(draftOf({ t: T0, p: 81_000 }, { t: T0 + 5 * MINUTE, p: 81_000 }), T0 + 60 * MINUTE).p0], [null], 'a band with no height is every price');
  // Into the open minute (now is 14:30:40): live, ending with that minute, and moving on with it.
  const now = T0 + 30 * MINUTE + 40_000, live = snap(draftOf({ t: T0 + 20 * MINUTE, p: null }, { t: now + 5 * MINUTE, p: null }), now);
  assert.deepEqual([live.live, live.t1], [true, T0 + 31 * MINUTE]);
  assert.equal(follow(live, now + 10_000), live, 'the same minute: nothing moves');
  assert.equal(follow(live, now + 30_000).t1, T0 + 32 * MINUTE);
  assert.equal(follow(made, now + 10 * MINUTE), made, 'a selection in the past stays');
});

test('a press selects with the tool armed or Ctrl / Cmd held, only with the main button; a live selection is asked again at a pace its answers allow', () => {
  assert.equal(selects(true, { ctrlKey: false, metaKey: false, button: 0 }), true);
  assert.equal(selects(false, { ctrlKey: true, metaKey: false, button: 0 }), true);
  assert.equal(selects(false, { ctrlKey: false, metaKey: true, button: 0 }), true);
  assert.equal(selects(false, { ctrlKey: false, metaKey: false, button: 0 }), false);
  assert.equal(selects(true, { ctrlKey: false, metaKey: false, button: 2 }), false, 'the right button still zooms');
  assert.deepEqual([refreshMs(5), refreshMs(300), refreshMs(5_000)], [2_000, 6_000, 30_000]);
  assert.equal(rowStep({ p0: 81_000, p1: 82_200 }, 20), 10, 'about 120 rows across a box, on a round step');
  assert.equal(rowStep({ p0: null, p1: null }, 20), 20, 'the map\'s grid for every price');
  assert.equal(rowStep({ p0: 81_000, p1: 81_001 }, 20), 0.5, 'never finer than the recording');
});

const sel = (over: Partial<RangeSelection> = {}): RangeSelection => ({ t0: T0, t1: T0 + 30 * MINUTE, p0: 81_000, p1: 82_000, live: false, draft: false, ...over });
const inst = (id: string, over: Partial<RangeInstrument> = {}): RangeInstrument => ({
  id, band: { buy: 0, sell: 0, buyN: 0, sellN: 0 }, minutes: 30, counted: 30, countedFrom: T0, countedUsd: { buy: 0, sell: 0 }, all: { buy: 0, sell: 0 }, before: { buy: 0, sell: 0, minutes: 30 }, ...over,
});
const answer = (instruments: RangeInstrument[], rows: RangeAnswer['rows'] = []): RangeAnswer => ({ from: T0, to: T0 + 30 * MINUTE, p0: 81_000, p1: 82_000, step: 10, rows, instruments });
const input = (over: Partial<RangeInput> = {}): RangeInput => ({ sel: sel(), answer: null, error: null, marks: [], resting: null, prints: null, kind: id => id.includes('spot') ? 'spot' : 'perp', ...over });
const line = (lines: RangeLine[], key: string): RangeLine | undefined => lines.find(l => l.key === key);

test('the panel adds up the market orders of one set of instruments, the orders behind them and who traded them', () => {
  const lines = rangeLines(input({ answer: answer([
    inst('binance:BTCUSDT', { band: { buy: 6_000_000, sell: 2_000_000, buyN: 300, sellN: 100 }, countedUsd: { buy: 6_000_000, sell: 2_000_000 }, all: { buy: 10_000_000, sell: 6_000_000 }, before: { buy: 4_000_000, sell: 4_000_000, minutes: 30 } }),
    inst('binancespot:BTCUSDT', { band: { buy: 1_000_000, sell: 1_000_000, buyN: 50, sellN: 50 }, countedUsd: { buy: 1_000_000, sell: 1_000_000 }, all: { buy: 2_000_000, sell: 2_000_000 }, before: { buy: 1_000_000, sell: 1_000_000, minutes: 30 } }),
    inst('okx:BTC-USDT-SWAP', { band: { buy: 0, sell: 0, buyN: 0, sellN: 0 } }),
  ], [[81_500, 3_000_000, 1_000_000, 120, 40], [81_600, 500_000, 200_000, 10, 5]]) }));
  assert.equal(line(lines, 'split')!.share, 0.7, 'bought 7M of 10M');
  assert.deepEqual(line(lines, 'delta')!.cells, ['Delta', '+$4M']);
  assert.deepEqual(line(lines, 'orders')!.cells, ['Orders', '350 buys · 150 sells']);
  assert.deepEqual(line(lines, 'average')!.cells, ['Average order', '$20K buy · $20K sell']);
  assert.equal(line(lines, 'orders-from'), undefined, 'every minute counted: no note');
  assert.deepEqual(line(lines, 'band')!.cells[1], '50% of all market volume in these minutes', '10M of the 20M traded at every price');
  assert.deepEqual(line(lines, 'before')!.cells, ['Against the 30 min before', '×2.0 the volume']);
  // One exchange however many markets: Binance's perpetual and spot together, and an exchange that traded nothing in the band is no row.
  assert.deepEqual(line(lines, 'who-binance')!.cells, ['Binance', '$7M', '$3M', '100%']);
  assert.equal(line(lines, 'who-okx'), undefined);
  assert.deepEqual(line(lines, 'lanes')!.cells, ['Spot · perpetual', '20% · 80%']);
  // Where they were filled: the busiest price first in price order, with the orders that began there.
  assert.deepEqual(line(lines, 'filled-81500')!.cells, ['81,500', '$3M', '$1M', '160']);
});

test('order counts that cover part of the selection say since when, none say so, and an older server says to restart it', () => {
  const partial = rangeLines(input({ answer: answer([inst('a:BTC', { band: { buy: 100, sell: 100, buyN: 1, sellN: 1 }, counted: 12, countedFrom: T0 + 18 * MINUTE, countedUsd: { buy: 100, sell: 100 } })]) }));
  assert.match(line(partial, 'orders-from')!.cells[0]!, /\(12 of 30 minutes\)/);
  const none = rangeLines(input({ answer: answer([inst('a:BTC', { band: { buy: 100, sell: 100, buyN: 0, sellN: 0 }, counted: 0, countedFrom: null })]) }));
  assert.ok(line(none, 'orders-none'));
  assert.equal(line(none, 'average'), undefined, 'no average without counts');
  const gappy = rangeLines(input({ answer: answer([inst('a:BTC', { band: { buy: 100, sell: 0, buyN: 1, sellN: 0 }, minutes: 20, counted: 20 })]) }));
  assert.match(line(gappy, 'coverage')!.cells[0]!, /20 of its 30 minutes/);
  assert.equal(line(gappy, 'before'), undefined, 'no comparison when the selection itself is not all recorded');
  assert.match(line(rangeLines(input({ error: 'older' })), 'market-wait')!.cells[0]!, /restart it/);
});

test('absorption marks are added up against what traded there, and resting orders are given for a box only', () => {
  const mark = (side: 'buy' | 'sell', usd: number, price: number, id = 'binance:BTCUSDT'): AbsorptionMark => ({ id, side, price, t0: T0 + MINUTE, t1: T0 + MINUTE + 5, usd, fills: 3, peak: usd, threshold: 100_000 });
  const lines = rangeLines(input({
    answer: answer([inst('binance:BTCUSDT', { band: { buy: 4_000_000, sell: 2_000_000, buyN: 0, sellN: 0 } })]),
    marks: [mark('sell', 500_000, 81_500), mark('sell', 300_000, 81_500), mark('buy', 400_000, 81_700, 'bybit:BTCUSDT')],
    resting: [{ id: 'binance:BTCUSDT', bid: 3_000_000, ask: 1_000_000 }],
  }));
  assert.deepEqual(line(lines, 'abs-buyers')!.cells, ['Passive buyers took', '$800K of market sells (40% of them)'], 'market sells taken by passive buyers, against the 2M sold');
  assert.deepEqual(line(lines, 'abs-sellers')!.cells, ['Passive sellers took', '$400K of market buys (10% of them)']);
  assert.deepEqual(line(lines, 'abs-price-81500')!.cells, ['81,500.0', '$800K taken by passive buyers'], 'one price, its marks together');
  assert.deepEqual(line(lines, 'rest-split')!.cells, ['Bids $3M', 'Asks $1M']);
  assert.ok(line(rangeLines(input({ marks: null })), 'abs-off'), 'Absorption off says so');
  const time = rangeLines(input({ sel: sel({ p0: null, p1: null }), answer: answer([inst('a:BTC', { band: { buy: 1, sell: 1, buyN: 0, sellN: 0 } })]) }));
  assert.equal(line(time, 'h-resting'), undefined, 'a stretch of time has no box to rest in');
  assert.equal(line(time, 'prices')!.cells[0], 'Every price');
});

test('the tag beside a selection being dragged gives its minutes, and a box its height', () => {
  assert.equal(draftLabel({ ...sel(), t1: T0 + 12 * MINUTE }), '12 min · 1.23%');
  assert.equal(draftLabel({ ...sel({ p0: null, p1: null }), t1: T0 + 3 * 60 * MINUTE }), '3 h');
});
