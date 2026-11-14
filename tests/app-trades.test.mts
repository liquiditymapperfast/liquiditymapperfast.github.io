import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BLOCK, BOUNDARY, TapeRing } from '../src/app/tape/ring.ts';
import type { TapeBatch } from '../src/shared/tape.ts';
import { TradeIndex, readRecord } from '../src/app/trades/index.ts';
import { ORDER_TINT, ROW_GAP, ROW_MARK, ROW_PAD, TIERS, amountText, clockForm, orderBarFull, priceWidth, rowGeom, rowInk, tierOf } from '../src/app/trades/style.ts';
import { TRADES_DEFAULTS, readTrades } from '../src/app/trades/settings.ts';
import { PALETTES, contrastRatio } from '../src/app/theme.ts';
import { price } from '../src/app/format.ts';
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

test('size is told by four tiers and a bar whose full dollars follow the smallest order', () => {
  const same = (x: number): number => x, whale = 400_000;
  assert.deepEqual([500, 15_000, 150_000, 450_000, -2_000_000].map(u => tierOf(u, same, whale)), [0, 1, 2, 3, 3]);
  assert.ok(TIERS.every((tier, i) => i === 0 || (tier.row > TIERS[i - 1]!.row && tier.amountPx > TIERS[i - 1]!.amountPx)));
  // A coin that trades less: its edges scale with it.
  assert.equal(tierOf(15_000, x => x / 10, 40_000), 2);
  // About the order one in ten is larger than at each floor of the menu, rounded; never under ten floors from $100K.
  assert.deepEqual([0, 1_000, 5_000, 10_000, 25_000, 100_000, 250_000].map(orderBarFull), [20_000, 50_000, 100_000, 150_000, 250_000, 1_000_000, 2_500_000]);
  let last = 0;
  for (let f = 0; f < 2e6; f = f * 1.4 + 100) { const v = orderBarFull(f); assert.ok(v >= last && v > f, `full rises past the floor at ${f}`); last = v; }
});

test('every theme\'s text reads on every tint the list draws', () => {
  for (const [name, p] of Object.entries(PALETTES)) {
    for (const tint of [0.02, ORDER_TINT, 0.12, 0.18, 0.3, 0.42]) for (const buy of [true, false]) {
      const ink = rowInk(p, buy, tint);
      assert.ok(contrastRatio(ink.text, ink.bg) >= 4.5, `${name} ${buy ? 'buy' : 'sell'} ${tint}: text ${contrastRatio(ink.text, ink.bg).toFixed(2)}`);
      assert.ok(contrastRatio(ink.muted, ink.bg) >= 2.5, `${name} ${buy ? 'buy' : 'sell'} ${tint}: muted ${contrastRatio(ink.muted, ink.bg).toFixed(2)}`);
      const side = buy ? p.candleUp : p.candleDown;
      assert.ok(ink.glyph === (contrastRatio(side, ink.bg) >= 3 ? side : ink.text), `${name} ${buy ? 'buy' : 'sell'} ${tint}: the side glyph in its colour only where it reads`);
      assert.ok(contrastRatio(ink.bar, ink.bg) > 1 && ink.bar !== ink.bg, `${name} ${buy ? 'buy' : 'sell'} ${tint}: the bar stands off its row`);
    }
  }
});

test('a price is counted as wide as it is written, without writing it', () => {
  // Across magnitudes, the rounding edges (9,999.96 is written 10,000.0; 9.995 is written 10.00), the decimals' own edges ($1, $1,000)
  // and what is not a price.
  const values: number[] = [0, -0, -1, NaN, Infinity, -Infinity, 1e21, 1e24, 1e25, Number.MAX_VALUE];
  for (let e = -9; e <= 7; e++) for (const m of [1, 1.5, 2, 5, 9, 9.5, 9.94, 9.949, 9.95, 9.951, 9.96, 9.994, 9.995, 9.996, 9.9995, 9.99995, 9.999995]) values.push(m * 10 ** e);
  values.push(999.995, 999.996, 999.9949, 9_999.95, 9_999.949, 99_999.95, 0.999995, 0.9999949, 68_277.4, 100_000, 99_999.94);
  let seed = 7; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 4000; i++) values.push(10 ** (rand() * 16 - 9));
  for (const v of values) assert.equal(priceWidth(v), price(v).length, `${v}: "${price(v)}"`);
  // A coin that just crossed $1 upward still shows rows below it, three characters wider: the column is sized for them.
  assert.equal(Math.max(priceWidth(1.0001), priceWidth(0.99991)), price(0.99991).length);
});

test('an order row\'s parts never meet: the widest price, the bar, the mark past full, a count and the widest amount', () => {
  // Three monospace fonts' advances (Consolas 0.55 em; Courier New and Lucida Console about 0.6), every width a column can have, grouping
  // off and on, price columns of 4 to 13 characters.
  for (const [name, em] of [['consolas', 0.55], ['courier', 0.6], ['lucida', 0.6021]] as const) {
    const m = { hms: 8 * 11 * em, ms: 5 * 11 * em, digit11: 11 * em, digit13: 13 * em, digitBig: TIERS[TIERS.length - 1]!.amountPx * em, more: 12 * em };
    for (let w = 240; w <= 900; w += 7) for (const group of [false, true]) for (let chars = 4; chars <= 13; chars++) {
      const g = rowGeom(w, m, group, chars, 50_000), tag = `${name} at ${w} px, grouping ${group}, ${chars}-character prices`;
      if (g.clockW) assert.ok(ROW_PAD + g.clockW + ROW_GAP <= g.xMark - ROW_MARK / 2 + 1e-9, `${tag}: the clock clears the venue mark`);
      assert.ok(g.xBar - (g.xPrice + chars * m.digit13) >= ROW_GAP - 0.5, `${tag}: the widest price clears the bar`);
      assert.ok(g.barRoom === 0 || g.barRoom >= 24, `${tag}: a bar has its room, or none is drawn`);
      if (!g.barRoom) continue;
      // The count ("×999", grouping) is drawn a gap left of the amount; the mark past full ends a gap before whichever comes first.
      const amountLeft = g.xRight - 7 * m.digitBig, next = group ? amountLeft - ROW_GAP - 4 * m.digit11 : amountLeft;
      assert.ok(g.xMore + m.more <= next - ROW_GAP + 1e-9, `${tag}: the mark clears the count and the amount`);
      assert.equal(g.xMore, g.xBar + g.barRoom + 2);
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
  assert.equal(TRADES_DEFAULTS.unit, 1, 'a second a row at first (Karl, 2026-11-13)');
  assert.deepEqual(readTrades({ minUsd: 5_000, side: 'buy', group: true }), { unit: 1, minUsd: 5_000, side: 'buy', group: true });
  assert.deepEqual(readTrades({ minUsd: -1, side: 'x', group: 1 }), TRADES_DEFAULTS);
  assert.ok((LAYOUT_KEYS as readonly string[]).includes('trades'));
  assert.equal(readSettings({ flowView: 'all' }).flowView, 'trades');
});

test('the view takes the tape only while it shows, and asks no source', () => {
  const main = fs.readFileSync('src/app/main.ts', 'utf8');
  // The refresh and the redraw stay a pair (review r1, 2026-11-12: an else-if between two lists made one's redraw unreachable).
  assert.match(main, /cvd\.trades\.refresh\(\);\n\s*else if \(changed\.has\('sounds'\) \|\| changed\.has\('replay'\) \|\| changed\.has\('timeZone'\)\) cvd\.trades\.redraw\(\);/);
  // On screen: the column shown and not folded, and on a phone its Flow tab open (a phone hides tabs by its stylesheet, not by `hidden`).
  assert.match(main, /const tradesShown = \(\): boolean => !cvd\.root\.hidden && !cvd\.covered\(\) && store\.state\.flowView === 'trades';/);
  assert.match(main, /cvd\.covered = \(\) => isPhone\(\) && dock\.tab !== 'flow';/);
  assert.match(main, /\|\| tradesShown\(\);/);
  assert.match(main, /cvd\.trades\.tapeArrived\(\)/);
  for (const f of ['src/app/panes/trades-view.ts', 'src/app/panes/trades-orders.ts', 'src/app/panes/trades-blocks.ts']) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /source\.|fetch\(|recentPrints|\.prints\(/, `${f} never asks a source`);
  }
  // A venue joining the map lets its orders in: the index and the tally start over when the venues they were made for change (review r1).
  assert.match(fs.readFileSync('src/app/panes/trades-orders.ts', 'utf8'), /this\.#filterKeyNow\(\) !== this\.#filterKey/);
  assert.match(fs.readFileSync('src/app/panes/trades-view.ts', 'utf8'), /this\.#filterKeyNow\(\) !== this\.#filterKey/);
});

test('nothing in the code or the docs names another product used for reference (AGENTS.md)', () => {
  for (const f of ['README.md', 'src/app/panes/trades-view.ts', 'src/app/panes/trades-orders.ts', 'src/app/panes/trades-blocks.ts', 'src/app/panes/trades-inspector.ts', 'src/app/trades/style.ts', 'src/app/trades/index.ts', 'src/app/trades/settings.ts', 'src/app/trades/tally.ts', 'src/app/trades/blocks.ts', 'src/app/tape/ring.ts', 'src/app/guide/content.ts', 'src/app/help.ts']) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\baggr(\.trade)?\b/i, f);
  }
});
