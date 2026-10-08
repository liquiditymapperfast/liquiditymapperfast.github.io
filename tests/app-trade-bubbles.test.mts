import test from 'node:test';
import assert from 'node:assert/strict';
import { BUBBLE_DEFAULTS, PrintBook, bubbleHidden, readBubbles, topPrints, type Print } from '../src/app/prints.ts';
import { PRINTS_PER_ANSWER, PrintStream, largestPrints } from '../src/shared/prints.ts';
import { Hub } from '../src/app/hub.ts';
import { Store, initialState } from '../src/app/store.ts';

const MIN = 60_000, T0 = 1_800_000_000_000;

test('saved bubble settings are read field by field: a minimum that is not a choice is the nearest under it', () => {
  assert.deepEqual(readBubbles(undefined), BUBBLE_DEFAULTS);
  assert.deepEqual(readBubbles({ minUsd: 300_000, side: 'sell', scale: 1.34, opacity: 0.33, labels: true }), { minUsd: 250_000, side: 'sell', scale: 1.3, opacity: 0.35, labels: true });
  assert.deepEqual(readBubbles({ minUsd: 10, side: 'left', scale: 9, opacity: 0, labels: 'yes' }), { minUsd: 25_000, side: 'both', scale: 2, opacity: 0.1, labels: false });
  assert.equal(readBubbles({ minUsd: 5e9 }).minUsd, 2_500_000);
  assert.equal(readBubbles({ minUsd: Number.NaN }).minUsd, 25_000);
});

test('the side and the smallest order are applied before the largest are chosen, so the places go to bubbles that are drawn', () => {
  const p = (t: number, side: 'buy' | 'sell', usd: number): Print => ({ t, id: 'binance:BTC', side, price: 100, usd });
  const items = [p(1, 'buy', 900_000), p(2, 'sell', 40_000), p(3, 'buy', 800_000), p(4, 'sell', 60_000), p(5, 'buy', 700_000)];
  const sells = { ...BUBBLE_DEFAULTS, side: 'sell' as const };
  assert.deepEqual(topPrints(items, 0, 10, 0, 1_000, 2, q => bubbleHidden(q, sells)).map(q => q.usd), [40_000, 60_000], 'the two sells, not the two largest buys left out afterwards');
  const big = { ...BUBBLE_DEFAULTS, minUsd: 750_000 };
  assert.deepEqual(topPrints(items, 0, 10, 0, 1_000, 10, q => bubbleHidden(q, big)).map(q => q.usd), [900_000, 800_000]);
  assert.equal(bubbleHidden(p(1, 'buy', 25_000), BUBBLE_DEFAULTS), false, 'the defaults hide nothing the recording keeps');
});

test('the hub asks for the bubbles again when the smallest order changes, and once per window otherwise', async () => {
  class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  const asked: { from: number; to: number; min: number | undefined; settle: () => void }[] = [];
  const source = { prints: (from: number, to: number, min?: number) => new Promise<Print[]>(resolve => { asked.push({ from, to, min, settle: () => resolve([]) }); }) };
  const hub = new Hub(new Store(initialState()), source as never);
  const realNow = Date.now; Date.now = () => T0;
  const view = { t0: T0 - 60 * MIN, t1: T0 - MIN, p0: 0, p1: 1 } as never;
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    hub.ensurePrints(view, 25_000); assert.equal(asked.length, 1); assert.equal(asked[0]!.min, 25_000);
    asked[0]!.settle(); await turn();
    hub.ensurePrints(view, 25_000); assert.equal(asked.length, 1, 'the window is held');
    hub.ensurePrints(view, 1_000_000); assert.equal(asked.length, 2, 'a larger smallest order reaches further back: asked again');
    assert.equal(asked[1]!.min, 1_000_000);
    asked[1]!.settle(); await turn();
    hub.ensurePrints(view, 25_000); assert.equal(asked.length, 3, 'and back');
  } finally { Date.now = realNow; }
});


test('a window with more orders than an answer carries is answered with its largest, so a day reaches back to its start', () => {
  // A day of BTC is 70,000 to 120,000 orders from $25,000: an answer of the newest 5,000 reached 45 minutes back.
  const HOUR = 3_600_000, start = T0 - 24 * HOUR;
  const stream = new PrintStream(null, () => T0, 7 * 24 * HOUR);
  stream.ingest(Array.from({ length: 2_400 }, (_, i) => ({ instrumentId: 'binance:BTCUSDT', tradeId: String(i), side: 'buy', price: 100, notionalUsd: i % 100 === 0 ? 5_000_000 : 30_000 + (i % 7), sourceTimestamp: start + i * 36_000 })));
  const day = stream.query(start, T0, 25_000, 30);
  assert.equal(day.length, 30);
  assert.equal(day.filter(p => p.usd === 5_000_000).length, 24, 'every hour\'s whale, the first hour\'s too');
  assert.ok(day[0]!.t < start + HOUR, 'the answer starts in the first hour');
  assert.ok(day.every((p, i) => i === 0 || p.t >= day[i - 1]!.t), 'in time order');
  assert.deepEqual(largestPrints([{ t: 1, id: 'a', side: 'buy', price: 1, usd: 5 }, { t: 2, id: 'a', side: 'buy', price: 1, usd: 5 }], 1).map(p => p.t), [2], 'a tie goes to the newest');
  assert.equal(PRINTS_PER_ANSWER, 5_000);
});

test('a book whose window alone holds more than it keeps lets the smallest go, not the oldest', () => {
  const p = (t: number, usd: number): Print => ({ t, id: 'binance:BTC', side: 'buy', price: 100, usd });
  const book = new PrintBook(3);
  book.add([p(1, 900_000), p(2, 30_000), p(3, 40_000), p(4, 50_000), p(5, 60_000)], { from: 0, to: 10 });
  assert.deepEqual(book.items.map(q => q.usd), [900_000, 50_000, 60_000]);
});

test('the hub asks again for a view zoomed well into a window whose answer was cut to its largest', async () => {
  class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  const asked: { from: number; to: number; settle: (rows: Print[]) => void }[] = [];
  const source = { prints: (from: number, to: number) => new Promise<Print[]>(resolve => { asked.push({ from, to, settle: resolve }); }) };
  const hub = new Hub(new Store(initialState()), source as never);
  const realNow = Date.now; Date.now = () => T0;
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  const full = (from: number, to: number): Print[] => Array.from({ length: PRINTS_PER_ANSWER }, (_, i) => ({ t: from + Math.floor(i * (to - from) / PRINTS_PER_ANSWER), id: 'binance:BTC', side: 'buy', price: 100, usd: 30_000 + i }));
  try {
    const day = { t0: T0 - 24 * 60 * MIN, t1: T0, p0: 0, p1: 1e6 } as never;
    hub.ensurePrints(day, 25_000); asked[0]!.settle(full(asked[0]!.from, asked[0]!.to)); await turn();
    const half = { t0: T0 - 12 * 60 * MIN, t1: T0, p0: 0, p1: 1e6 } as never;
    hub.ensurePrints(half, 25_000); assert.equal(asked.length, 1, 'half the day is still well covered by its largest');
    const hour = { t0: T0 - 60 * MIN, t1: T0, p0: 0, p1: 1e6 } as never;
    hub.ensurePrints(hour, 25_000); assert.equal(asked.length, 2, 'an hour of a cut day: asked again for its smaller orders');
    asked[1]!.settle([]); await turn();
    hub.ensurePrints(hour, 25_000); assert.equal(asked.length, 2, 'an answer that was not cut covers its window');
  } finally { Date.now = realNow; }
});
