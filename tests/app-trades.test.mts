import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BLOCK, BOUNDARY, TapeRing } from '../src/app/tape/ring.ts';
import type { TapeBatch } from '../src/shared/tape.ts';
import { TradeIndex, readRecord } from '../src/app/trades/index.ts';
import { TIERS, amountText, clockForm, rowInk, tierOf, tintOf, tintStops } from '../src/app/trades/style.ts';
import { TRADES_DEFAULTS, readTrades } from '../src/app/trades/settings.ts';
import { PALETTES, contrastRatio } from '../src/app/theme.ts';
import { LAYOUT_KEYS, readSettings } from '../src/app/store.ts';

/** A batch of orders: [market, exchange time, price, signed usd]. */
function batch(seq: number, rows: [string, number, number, number][], dropped = 0): TapeBatch {
  const ids = [...new Set(rows.map(r => r[0]))], n = rows.length;
  const b: TapeBatch = { seq, dropped, ids, inst: new Int32Array(n), t: new Float64Array(n), price: new Float64Array(n), usd: new Float32Array(n), lo: new Float64Array(n), hi: new Float64Array(n) };
  rows.forEach(([id, t, price, usd], i) => { b.inst[i] = ids.indexOf(id); b.t[i] = t; b.price[i] = price; b.usd[i] = usd; b.lo[i] = price; b.hi[i] = price; });
  return b;
}
const all = { minUsd: 0, side: 'both' as const, shown: () => true };

test('the ring records where orders may be missing by write number: the start, a reconnect, a skip an empty batch carried, a trim', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [['binance:BTCUSDT', 1_000, 71_000, 500]]), 1, 0);
  ring.add(batch(2, [['binance:BTCUSDT', 1_100, 71_001, -300]]), 1, 0);
  // An empty batch after a skipped one: the skip belongs before the next order written.
  ring.add(batch(4, []), 1, 0);
  ring.add(batch(5, [['okx:BTC-USDT-SWAP', 1_300, 71_002, 900]]), 1, 0);
  ring.add(batch(1, [['okx:BTC-USDT-SWAP', 1_400, 71_003, 900]]), 2, 0); // another connection
  ring.add(batch(2, [['okx:BTC-USDT-SWAP', 1_500, 71_004, 900]], 7), 2, 0); // trimmed
  assert.deepEqual(ring.boundaries.map(b => [b.before, b.reasons]), [[0, BOUNDARY.start], [2, BOUNDARY.skipped], [3, BOUNDARY.reconnect], [4, BOUNDARY.trimmed]]);
  // A trim on an empty batch is kept for the next order too.
  ring.add(batch(3, [], 4), 2, 0);
  ring.add(batch(4, [['okx:BTC-USDT-SWAP', 1_600, 71_005, 900]]), 2, 0);
  assert.equal(ring.boundaries[ring.boundaries.length - 1]!.reasons, BOUNDARY.trimmed);
  assert.equal(ring.boundaries[ring.boundaries.length - 1]!.before, 5);
});

test('boundaries go with the orders the ring wraps past; a clear starts another generation', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [['binance:BTCUSDT', 1_000, 71_000, 500]]), 1, 0);
  ring.add(batch(1, [['binance:BTCUSDT', 1_001, 71_000, 500]]), 2, 0); // reconnect before write 1
  let seq = 2;
  for (let i = 0; i < BLOCK + 10; i++) ring.add(batch(seq++, [['binance:BTCUSDT', 2_000 + i, 71_000, 100]]), 2, 0);
  assert.ok(ring.first > 1);
  assert.equal(ring.boundaries.length, 0, 'the start and the reconnect were before the oldest order held');
  const gen = ring.generation;
  ring.clear();
  assert.equal(ring.generation, gen + 1);
  ring.add(batch(1, [['binance:BTCUSDT', 9_000, 71_000, 100]]), 3, 0);
  assert.equal(ring.boundaries[0]!.reasons & BOUNDARY.cleared, BOUNDARY.cleared);
});

test('the index finds the newest matches back from the end, in steps, and keeps current batch by batch', () => {
  const ring = new TapeRing(BLOCK);
  let seq = 1;
  for (let i = 0; i < 200; i++) ring.add(batch(seq++, [['binance:BTCUSDT', 1_000 + i, 71_000, i % 2 ? 50_000 : -200]]), 1, 0);
  const index = new TradeIndex();
  index.reset(ring, { minUsd: 10_000, side: 'both', shown: () => true });
  assert.equal(index.length, 0);
  assert.equal(index.scanBack(5), 5, 'five matches found going back');
  assert.deepEqual([0, 1, 2, 3, 4].map(i => index.at(i)), [191, 193, 195, 197, 199], 'ascending, the newest at the end');
  assert.equal(index.moreBehind, true);
  // A bounded step: at most `budget` records examined, the cursor moving over the rejected ones too.
  assert.equal(index.scanBack(1_000, 3), 1);
  ring.add(batch(seq++, [['binance:BTCUSDT', 5_000, 71_000, 80_000], ['binance:BTCUSDT', 5_001, 71_000, -10]]), 1, 0);
  assert.equal(index.update(), 1);
  assert.equal(index.newest, 200);
  // Sides and markets.
  const sells = new TradeIndex(); sells.reset(ring, { minUsd: 0, side: 'sell', shown: () => true }); sells.scanBack(3);
  assert.ok([0, 1, 2].every(i => readRecord(ring, sells.at(i)).usd < 0));
  const none = new TradeIndex(); none.reset(ring, { minUsd: 0, side: 'both', shown: id => id !== 'binance:BTCUSDT' });
  assert.equal(none.scanBack(10), 0); assert.equal(none.moreBehind, false);
});

test('the hold counts what arrives as it comes, and a write the ring wrapped past is never read as the order now in its slot', () => {
  const ring = new TapeRing(BLOCK);
  let seq = 1;
  const add = (n: number, usd: number): void => { for (let i = 0; i < n; i++) ring.add(batch(seq++, [['bybit:BTCUSDT', seq, 71_000, usd]]), 1, 0); };
  add(10, 1_000);
  const index = new TradeIndex(); index.reset(ring, all); index.scanBack(10);
  const old = index.at(0);
  index.hold();
  add(3, 1_000); index.update();
  assert.equal(index.newSinceHold, 3);
  add(BLOCK, 2_000); index.update();
  assert.equal(index.valid(old), false, 'wrapped past');
  assert.ok(index.at(0) >= ring.first, 'the start of the index went with the ring');
  assert.equal(index.newSinceHold, 3 + BLOCK, 'counted as they came, not from the index length, which eviction shrinks');
  index.release(); assert.equal(index.newSinceHold, 0);
  // A cleared ring is another generation: the index starts over.
  ring.clear(); add(2, 500);
  index.update();
  assert.equal(index.length, 0);
});

test('boundaries between two rows: a reconnect between their writes, even when the write at the boundary is filtered out', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [['binance:BTCUSDT', 1_000, 71_000, 50_000]]), 1, 0);
  ring.add(batch(1, [['binance:BTCUSDT', 1_100, 71_000, -5]]), 2, 0); // reconnect before write 1 (a small order the filter leaves out)
  ring.add(batch(2, [['binance:BTCUSDT', 1_200, 71_000, 60_000]]), 2, 0);
  const index = new TradeIndex(); index.reset(ring, { minUsd: 10_000, side: 'both', shown: () => true }); index.scanBack(10);
  assert.deepEqual([index.at(0), index.at(1)], [0, 2]);
  assert.equal(index.boundariesBetween(0, 2) & BOUNDARY.reconnect, BOUNDARY.reconnect);
  assert.equal(index.boundariesBetween(2, 2), 0);
});

test('size is told on a fixed scale: four tiers and a log tint, the same whatever the floor', () => {
  const same = (x: number): number => x, whale = 400_000, stops = tintStops(same, whale, 1_500_000, 0.42);
  assert.deepEqual([500, 15_000, 150_000, 450_000, -2_000_000].map(u => tierOf(u, same, whale)), [0, 1, 2, 3, 3]);
  assert.ok(TIERS.every((tier, i) => i === 0 || (tier.row > TIERS[i - 1]!.row && tier.amountPx > TIERS[i - 1]!.amountPx)));
  assert.equal(tintOf(10, stops), 0.02);
  assert.equal(tintOf(10_000, stops), 0.06);
  assert.equal(tintOf(5_000_000, stops), 0.42);
  let last = 0;
  for (let u = 100; u < 3e6; u *= 1.3) { const k = tintOf(u, stops); assert.ok(k >= last - 1e-12, `rises with size at ${u}`); last = k; }
  // A coin that trades less: its edges scale with it.
  assert.equal(tierOf(15_000, x => x / 10, 40_000), 2);
  // A Whale size set under $100K in Sounds: the stops stay in order and the tint never weakens for a larger order.
  const low = tintStops(same, 30_000, 1_500_000, 0.42);
  let prev = 0;
  for (let u = 100; u < 3e6; u *= 1.2) { const k = tintOf(u, low); assert.ok(k >= prev - 1e-12, `rises at ${u}`); prev = k; }
});

test('every theme\'s text reads on every tint the list draws', () => {
  for (const [name, p] of Object.entries(PALETTES)) {
    for (const tint of [0.02, 0.12, 0.18, 0.3, 0.42]) for (const buy of [true, false]) {
      const ink = rowInk(p, buy, tint);
      assert.ok(contrastRatio(ink.text, ink.bg) >= 4.5, `${name} ${buy ? 'buy' : 'sell'} ${tint}: text ${contrastRatio(ink.text, ink.bg).toFixed(2)}`);
      assert.ok(contrastRatio(ink.muted, ink.bg) >= 2.5, `${name} ${buy ? 'buy' : 'sell'} ${tint}: muted ${contrastRatio(ink.muted, ink.bg).toFixed(2)}`);
    }
  }
});

test('sizes, clocks and settings as the list writes and reads them', () => {
  assert.equal(amountText(0.37), '$0.37');
  assert.equal(amountText(42.6), '$43');
  assert.equal(amountText(1_250), '$1.3K');
  assert.equal(amountText(999.6), amountText(1_000), 'no "$1000" next to "$1K"');
  assert.equal(amountText(0.004), '<$0.01');
  assert.deepEqual([240, 280, 320].map(clockForm), ['none', 'ms', 'hms']);
  assert.deepEqual(readTrades(undefined), TRADES_DEFAULTS);
  assert.equal(TRADES_DEFAULTS.minUsd, 0, 'any size at first: every trade');
  assert.deepEqual(readTrades({ minUsd: 5_000, side: 'buy', group: true }), { minUsd: 5_000, side: 'buy', group: true });
  assert.deepEqual(readTrades({ minUsd: -1, side: 'x', group: 1 }), TRADES_DEFAULTS);
  assert.ok((LAYOUT_KEYS as readonly string[]).includes('trades'));
  assert.equal(readSettings({ flowView: 'all' }).flowView, 'all');
});

test('the view takes the tape only while it shows, and asks no source', () => {
  const main = fs.readFileSync('src/app/main.ts', 'utf8');
  // Each list's refresh and redraw stay a pair (review r1: an else-if between them made Time & sales' redraw unreachable).
  assert.match(main, /cvd\.tns\.refresh\(\);\n\s*else if \(changed\.has\('sounds'\) \|\| changed\.has\('replay'\) \|\| changed\.has\('timeZone'\)\) cvd\.tns\.redraw\(\);/);
  assert.match(main, /cvd\.trades\.refresh\(\);\n\s*else if \(changed\.has\('sounds'\) \|\| changed\.has\('replay'\) \|\| changed\.has\('timeZone'\)\) cvd\.trades\.redraw\(\);/);
  // On screen: the column shown and not folded, and on a phone its Flow tab open (a phone hides tabs by its stylesheet, not by `hidden`).
  assert.match(main, /const allTradesShown = \(\): boolean => !cvd\.root\.hidden && !cvd\.covered\(\) && store\.state\.flowView === 'all';/);
  assert.match(main, /cvd\.covered = \(\) => isPhone\(\) && dock\.tab !== 'flow';/);
  assert.match(main, /\|\| allTradesShown\(\);/);
  assert.match(main, /cvd\.trades\.tapeArrived\(\)/);
  const view = fs.readFileSync('src/app/panes/trades-view.ts', 'utf8');
  assert.doesNotMatch(view, /source\.|fetch\(|recentPrints|\.prints\(/, 'All trades never asks a source');
  // A venue joining the map lets its orders in: the index is found again when the venues it was found for change (review r1).
  assert.match(view, /this\.#filterKeyNow\(\) !== this\.#filterKey/);
});

test('nothing in the code or the docs names another product used for reference (AGENTS.md)', () => {
  for (const f of ['README.md', 'src/app/panes/trades-view.ts', 'src/app/trades/style.ts', 'src/app/trades/index.ts', 'src/app/trades/settings.ts', 'src/app/tape/ring.ts', 'src/app/guide/content.ts', 'src/app/help.ts']) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\baggr(\.trade)?\b/i, f);
  }
});
