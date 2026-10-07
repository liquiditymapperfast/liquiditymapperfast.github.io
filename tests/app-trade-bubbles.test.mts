import test from 'node:test';
import assert from 'node:assert/strict';
import { BUBBLE_DEFAULTS, bubbleHidden, readBubbles, topPrints, type Print } from '../src/app/prints.ts';
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
