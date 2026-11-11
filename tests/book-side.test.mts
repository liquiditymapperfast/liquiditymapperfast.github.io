import test from 'node:test';
import assert from 'node:assert/strict';
import { BookSide } from '../src/shared/book-side.ts';

/** The oracle: what valuation always did, every price sorted and its size looked up. */
const oracle = (m: Map<number, number>): [number[], number[]] => { const p = [...m.keys()].sort((a, b) => a - b); return [p, p.map(x => m.get(x)!)]; };
const view = (s: BookSide): [number[], number[]] => { const { prices, sizes, n } = s.sorted(); return [[...prices.subarray(0, n)], [...sizes.subarray(0, n)]]; };
function rng(seed: number): () => number {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('book side: it is a Map in every way a connector uses one', () => {
  const s = new BookSide();
  assert.ok(s instanceof Map);
  assert.equal(s.set(10, 1), s, 'set returns the side');
  s.set(9, 2); s.set(11, 3);
  assert.deepEqual([...s], [[10, 1], [9, 2], [11, 3]], 'insertion order, as a Map');
  assert.equal(s.delete(9), true); assert.equal(s.delete(9), false);
  assert.equal(s.get(11), 3); assert.equal(s.has(9), false); assert.equal(s.size, 2);
  // Mutation during iteration behaves as a Map's.
  for (const [p] of s) if (p === 10) s.set(12, 4);
  assert.deepEqual([...s.keys()], [10, 11, 12]);
  s.clear(); assert.equal(s.size, 0); assert.deepEqual(view(s), [[], []]);
});

test('book side: sorted after any mix of sets, updates and deletes, the same as sorting the whole side', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(seed), s = new BookSide(), m = new Map<number, number>();
    for (let i = 0; i < 2_000; i++) { const p = Math.round(r() * 1e6) / 100; s.set(p, i); m.set(p, i); }
    for (let round = 0; round < 40; round++) {
      // Some rounds change a few prices, some many (past the log's cap, a whole sort), some none.
      const changes = round % 7 === 3 ? 6_000 : Math.floor(r() * 300);
      for (let c = 0; c < changes; c++) {
        const p = r() < 0.5 ? Math.round(r() * 1e6) / 100 : [...m.keys()][Math.floor(r() * m.size)] ?? 1;
        const op = r();
        if (op < 0.3) { s.delete(p); m.delete(p); }
        else if (op < 0.4) { s.set(p, m.get(p) ?? 1); m.set(p, m.get(p) ?? 1); }   // a set to the size it has
        else { const q = Math.round(r() * 1e4) / 10 + 0.1; s.set(p, q); m.set(p, q); }
      }
      if (round % 11 === 5) { s.clear(); m.clear(); for (let i = 0; i < 500; i++) { const p = i * 0.5 + 1; s.set(p, i + 1); m.set(p, i + 1); } }
      assert.deepEqual(view(s), oracle(m), `seed ${seed} round ${round}`);
    }
  }
});

test('book side: a price set and deleted between sorts, and sets to the same size, leave nothing behind', () => {
  const s = new BookSide();
  s.set(1, 1); s.set(2, 2); view(s);
  s.set(3, 3); s.delete(3); s.set(2, 2); s.delete(99);
  assert.deepEqual(view(s), [[1, 2], [1, 2]]);
  s.set(2, 5); s.delete(1); s.set(0.5, 7);
  assert.deepEqual(view(s), [[0.5, 2], [7, 5]]);
});

test('book side: a side never sorted, or changed past the cap, holds no log and no sorted arrays', () => {
  const s = new BookSide();
  for (let i = 0; i < 100_000; i++) s.set(i, 1);
  // Never sorted: nothing is remembered (the first sort is a whole one anyway).
  assert.equal((s as unknown as { logCap(): number }).logCap(), 25_000);
  view(s);
  for (let i = 0; i < 30_000; i++) s.set(i, 2);
  const { n } = s.sorted();
  assert.equal(n, 100_000); assert.equal(s.sorted().sizes[29_999], 2); assert.equal(s.sorted().sizes[30_000], 1);
});
