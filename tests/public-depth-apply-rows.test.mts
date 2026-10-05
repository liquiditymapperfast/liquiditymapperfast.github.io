import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRows } from '../src/adapters/public-depth-session.mts';

type Level = { price: number; amount: number };

/** The implementation this replaced: a Map of the whole book, a full sort and fresh objects on every message. */
function reference(rows: Level[] | null | undefined, existing: Level[] | null | undefined, descending: boolean, depth: number | null = null): Level[] {
  const next = new Map<number, number>((existing ?? []).map(row => [row.price, row.amount]));
  for (const row of rows ?? []) {
    const price = Number(row?.price); const amount = Number(row?.amount);
    if (!(price > 0) || !Number.isFinite(amount) || amount < 0) continue;
    if (amount === 0) next.delete(price); else next.set(price, amount);
  }
  const sorted = [...next].sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]).map(([price, amount]) => ({ price, amount }));
  return depth == null ? sorted : sorted.slice(0, depth);
}

/** Small deterministic generator so a failure reproduces. */
function lcg(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

test('merging updates into a sorted book gives exactly what a full rebuild gave', () => {
  const rand = lcg(20261004);
  for (let round = 0; round < 3000; round++) {
    const descending = rand() < 0.5, depth = rand() < 0.4 ? null : 1 + Math.floor(rand() * 30);
    const levels = Math.floor(rand() * 40);
    const prices = new Set<number>(); while (prices.size < levels) prices.add(1 + Math.floor(rand() * 60));
    const start = reference([...prices].map(price => ({ price, amount: 1 + Math.floor(rand() * 9) })), [], descending, null);
    const updates: Level[] = [];
    for (let k = Math.floor(rand() * (rand() < 0.1 ? 130 : 14)); k > 0; k--) {
      const roll = rand();
      const price = roll < 0.05 ? 0 : roll < 0.1 ? -3 : 1 + Math.floor(rand() * 64);
      const amount = rand() < 0.3 ? 0 : rand() < 0.05 ? Number.NaN : rand() < 0.04 ? -1 : 1 + Math.floor(rand() * 9);
      updates.push({ price, amount });
    }
    const merged = applyRows(updates, start, descending, depth), expected = reference(updates, start, descending, depth);
    assert.deepEqual(merged, expected, `round ${round}: ${JSON.stringify({ descending, depth, start, updates })}`);
  }
});

test('an empty start sorts a snapshot once, no updates copies the book, and untouched levels keep their objects', () => {
  const snapshot = applyRows([{ price: 3, amount: 1 }, { price: 1, amount: 2 }, { price: 2, amount: 0 }], [], true, null);
  assert.deepEqual(snapshot, [{ price: 3, amount: 1 }, { price: 1, amount: 2 }]);
  const same = applyRows([], snapshot, true, 1);
  assert.deepEqual(same, [{ price: 3, amount: 1 }]);
  assert.notStrictEqual(same, snapshot, 'callers never share the array');
  const updated = applyRows([{ price: 2, amount: 5 }], snapshot, true, null);
  assert.deepEqual(updated, [{ price: 3, amount: 1 }, { price: 2, amount: 5 }, { price: 1, amount: 2 }]);
  assert.strictEqual(updated[0], snapshot[0], 'unchanged levels are reused rather than reallocated');
  assert.deepEqual(applyRows(null, null, true, 5), []);
});

test('a very large update (beyond the edit-in-place limit) still matches a full rebuild', () => {
  const start = reference(Array.from({ length: 300 }, (_, i) => ({ price: 1000 - i, amount: 1 + (i % 7) })), [], true, null);
  const updates: Level[] = Array.from({ length: 700 }, (_, i) => ({ price: 1 + ((i * 37) % 1100), amount: i % 5 === 0 ? 0 : 1 + (i % 9) }));
  for (const depth of [null, 50, 800]) assert.deepEqual(applyRows(updates, start, true, depth), reference(updates, start, true, depth));
});
