import test from 'node:test';
import assert from 'node:assert/strict';
import { LiqLevelsSource, STALE_MS, binsPerRow, heatScale, liqCurves, liqProfile, liqRows, onTheWay, liqStanding, parseLiqLevels, seamStats, spearman, standingBelow, takenByCandles, paintLiqStripe, type LiqLevels, type LiqRow } from '../src/app/liq-levels.ts';
import { View } from '../src/app/view.ts';
import { LIQ_LEVELS_URL, liqLevelsUrl, readLiqLevels } from '../src/app/liq-url.ts';
import { FIRST_LEAD_MS, LATE_EVERY_MS, SNAPSHOT_DUE_MS, SNAPSHOT_LATE_MS, createdOnPageClock, nextAskAt } from '../src/app/liq-schedule.ts';
import { BTC, type Coin } from '../src/shared/coins.ts';
import type { CandleRow } from '../src/app/store.ts';

const MIN = 60_000;
const AS_OF = Date.UTC(2026, 10, 1, 16, 4, 18);
const NOW = AS_OF + 45 * MIN;

/** A file as the service writes it (format 2): bins [k, longIso, longCross, shortIso, shortCross, longWallets, shortWallets, longTop, shortTop]. */
function doc(bins: number[][], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 2, coin: 'BTC', venue: 'hyperliquid', attribution: 'Powered by HyperTracker',
    snapshot: { id: 'a52ae475', asOf: AS_OF, createdAt: AS_OF + 35 * MIN, completedAt: AS_OF + 40 * MIN, fetchedAt: AS_OF + 41 * MIN },
    mark: 100, positions: 10, withLiquidation: 8, longSize: 5, shortSize: 5, step: 10, bins, beyond: { longUsd: 0, shortUsd: 0 }, ...over };
}

// Bin 8 [80, 90): longs 150, the largest 60. Bin 9 [90, 100): longs 200, the largest 150. Bin 11 [110, 120): one short of 300. Bin 12: shorts 40, the largest 25.
const SAMPLE = [[8, 100, 50, 0, 0, 3, 0, 60, 0], [9, 0, 200, 0, 0, 2, 0, 150, 0], [11, 0, 0, 300, 0, 0, 1, 0, 300], [12, 0, 0, 0, 40, 0, 2, 0, 25]];
const levels = (): LiqLevels => parseLiqLevels(doc(SAMPLE), 'BTC')!;
/** One-minute candles from the snapshot's minute: [start, open, high, low, close, volume]. */
const candles = (path: [number, number][]): CandleRow[] => path.map(([h, l], i) => [Math.floor(AS_OF / MIN) * MIN + i * MIN, (h + l) / 2, h, l, (h + l) / 2, 1] as CandleRow);
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

test('the file is read field by field, and refused whole when any part is off', () => {
  const l = levels();
  assert.deepEqual([...l.k], [8, 9, 11, 12]);
  assert.equal(l.longCross[1], 200);
  assert.equal(l.shortTop[2], 300);
  assert.equal(l.createdAt, AS_OF + 35 * MIN);
  assert.equal(l.attribution, 'Powered by HyperTracker');
  for (const bad of [
    doc(SAMPLE, { v: 1 }),
    doc(SAMPLE, { coin: 'ETH' }),
    doc([[9, 1, 1, 0, 0, 1, 0, 1, 0], [8, 1, 1, 0, 0, 1, 0, 1, 0]]), // not sorted
    doc([[9, -1, 1, 0, 0, 1, 0, 0, 0]]),
    doc([[9, 1, 1, 0, 0, 1.5, 0, 0, 0]]),
    doc([[9, 1, 1, 0, 0, 1, 0, 5, 0]]), // a largest position bigger than its side
    doc([[9, 1, 1, 0, 0, 1, 0, 1]]), // the format 1 row
    doc(SAMPLE, { step: 0 }),
    doc(SAMPLE, { snapshot: { asOf: AS_OF, createdAt: AS_OF - MIN, fetchedAt: AS_OF + MIN } }),
    doc(SAMPLE, { snapshot: { asOf: AS_OF, createdAt: AS_OF, fetchedAt: AS_OF - MIN } }),
    { ...doc(SAMPLE), bins: 'x' },
    null, 'text', 42,
  ]) assert.equal(parseLiqLevels(bad, 'BTC'), null, JSON.stringify(bad)?.slice(0, 80));
  // The service's times are checked against each other, never against the visitor's clock.
  const later = AS_OF + 400 * 86_400_000;
  assert.ok(parseLiqLevels(doc(SAMPLE, { snapshot: { asOf: later, createdAt: later, fetchedAt: later } }), 'BTC'));
});

test('a level is taken as the lows (longs) or highs (shorts) trade through it after the snapshot', () => {
  const l = levels();
  // The low reaches 95 in the second minute (half of bin 9, [90, 100)) and 89 in the fourth (through bin 9, into bin 8 [80, 90)).
  const tk = takenByCandles(l, candles([[101, 99], [100, 95], [100, 96], [99, 89], [112, 98]]));
  const minute = (i: number): number => Math.floor(AS_OF / MIN) * MIN + i * MIN + MIN / 2;
  assert.equal(tk.long.first[1], minute(0), 'bin 9 is entered by the first low');
  assert.equal(tk.long.gone[1], minute(3));
  assert.equal(tk.long.frac[1], 1);
  assert.equal(tk.long.first[0], minute(3));
  assert.ok(Number.isNaN(tk.long.gone[0]!));
  assert.ok(Math.abs(tk.long.frac[0]! - 0.1) < 1e-9, 'bin 8: 1 of its 10 dollars of width crossed');
  // The high reaches 112 in the last minute: through bin 11 ([110, 120)) by a fifth.
  assert.equal(tk.short.first[2], minute(4));
  assert.ok(Number.isNaN(tk.short.gone[2]!));
  assert.ok(Math.abs(tk.short.frac[2]! - 0.2) < 1e-9);
  assert.ok(Number.isNaN(tk.short.first[3]!));
  // Candles before the snapshot's minute do not count.
  const before: CandleRow[] = [[Math.floor(AS_OF / MIN) * MIN - MIN, 100, 130, 50, 100, 1]];
  const none = takenByCandles(l, before);
  assert.ok(Number.isNaN(none.long.first[1]!) && none.long.frac[1] === 0);
});

test('what the page saw itself takes levels without the candles, at the snapshot\'s time for the way there and its own time after', () => {
  const l = levels(), seenAt = AS_OF + 50 * MIN;
  // No candles at all (Hyperliquid unreadable): the chart's price went from the mark (100) to below 90, so bin 9 is gone, from an unknown time.
  const way = takenByCandles(l, [], { low: 89, high: 100, lowAt: AS_OF, highAt: AS_OF });
  assert.equal(way.long.gone[1], AS_OF, 'gone, with the snapshot\'s time: its band is not drawn');
  assert.ok(Math.abs(way.long.frac[0]! - 0.1) < 1e-9);
  // A new high seen later takes the short bin it reaches at the time it was seen.
  const later = takenByCandles(l, candles([[101, 99]]), { low: 99, high: 121, lowAt: AS_OF, highAt: seenAt });
  assert.equal(later.short.gone[2], seenAt);
  assert.equal(later.short.first[3], seenAt);
  // Where a candle reached as far, the candle's time stands.
  const both = takenByCandles(l, candles([[101, 99], [100, 85]]), { low: 85, high: 101, lowAt: seenAt, highAt: AS_OF });
  assert.equal(both.long.gone[1], Math.floor(AS_OF / MIN) * MIN + MIN + MIN / 2);
});

test('rows group whole bins on the fixed grid, add up dollars and wallets, and say when one position holds most of a row', () => {
  const l = levels();
  const one = liqRows(l, null, 1, 0, 1000);
  assert.equal(one.length, 4);
  assert.equal(one[1]!.long, 200);
  assert.equal(one[1]!.longOne, true, '150 of 200');
  assert.equal(one[0]!.longOne, false, '60 of 150');
  assert.equal(one[3]!.shortOne, true, '25 of 40');
  // Three bins a row: bin 8 falls in group 2 ([60, 90)), 9 and 11 in group 3 ([90, 120)), 12 in group 4.
  const three = liqRows(l, null, 3, 0, 1000);
  assert.deepEqual(three.map(r => [r.p0, r.p1]), [[60, 90], [90, 120], [120, 150]]);
  const mid = three[1]!;
  assert.equal(mid.long, 200);
  assert.equal(mid.short, 300);
  assert.equal(mid.longOne, true);
  assert.equal(mid.shortOne, true);
  // Two bins a row: [80, 100) holds bins 8 and 9, 350 of longs whose largest position is 150: not one position's, though bin 9 alone is.
  const two = liqRows(l, null, 2, 0, 1000);
  assert.equal(two[0]!.long, 350);
  assert.equal(two[0]!.longTop, 150, 'the largest position of the row is the largest in any of its bins');
  assert.equal(two[0]!.longOne, false);
  // Taken: the row's long side is gone once every one of its bins is.
  const tk = takenByCandles(l, candles([[101, 99], [100, 85]]));
  const rows = liqRows(l, tk, 1, 0, 1000);
  assert.ok(Number.isFinite(rows[1]!.longGone));
  assert.equal(rows[1]!.longLeft, 0);
  assert.ok(Number.isNaN(rows[0]!.longGone), 'bin 8 is only half crossed');
  assert.ok(Math.abs(rows[0]!.longLeft - 75) < 1e-9);
});

test('the profile column adds up what stands, row by row and from the price outward', () => {
  const l = levels(), s = liqStanding(l, null);
  assert.equal(standingBelow(s, 'long', 1000), 350);
  assert.equal(standingBelow(s, 'long', 95), 250, 'bin 8 and half of bin 9');
  assert.equal(standingBelow(s, 'short', 115), 150);
  // Rows of 10 from 80 with the price at 105.
  const p = liqProfile(s, 10, 80, 130, 105);
  assert.equal(p.row0, 8);
  assert.deepEqual([...p.long], [150, 200, 0, 0, 0, 0]);
  assert.deepEqual([...p.short], [0, 0, 0, 300, 40, 0]);
  assert.deepEqual([...p.cumLong], [350, 200, 0, 0, 0, 0], 'everything between the row and the price');
  assert.deepEqual([...p.cumShort], [0, 0, 0, 300, 340, 340]);
  assert.equal(p.maxLevel, 300);
  assert.equal(p.maxCum, 350);
  // What price has traded through no longer stands: half of bin 9 gone leaves 100 there.
  const after = liqStanding(l, takenByCandles(l, candles([[101, 95]])));
  assert.equal(standingBelow(after, 'long', 1000), 250);
});

test('what goes on the way to a price: the longs below the price, the shorts above, a cut bin in proportion', () => {
  const s = liqStanding(levels(), null);
  assert.deepEqual(onTheWay(s, 105, 85), { side: 'long', usd: 275 }, 'bin 9 and half of bin 8');
  assert.deepEqual(onTheWay(s, 105, 125), { side: 'short', usd: 320 }, 'bin 11 and half of bin 12');
  assert.deepEqual(onTheWay(s, 105, 102), { side: 'long', usd: 0 });
  assert.equal(onTheWay(s, 105, 105), null, 'nothing at the price itself');
  assert.equal(onTheWay(s, NaN, 90), null);
  assert.equal(onTheWay(s, 0, 90), null);
});

test('the cumulative curves run from the price out through every row\'s far edge, and read what goes on the way there', () => {
  const s = liqStanding(levels(), null), p = liqProfile(s, 10, 80, 130, 105), c = liqCurves(p, 105);
  // Rows [80, 90) to [130, 140), the price inside [100, 110): longs down from it, shorts up.
  assert.deepEqual(c.long, [{ p: 105, usd: 0 }, { p: 100, usd: 0 }, { p: 90, usd: 200 }, { p: 80, usd: 350 }]);
  assert.deepEqual(c.short, [{ p: 105, usd: 0 }, { p: 110, usd: 0 }, { p: 120, usd: 300 }, { p: 130, usd: 340 }, { p: 140, usd: 340 }]);
  // Every point is what the pointer would read there (the stripe's "If price gets here" uses the same sum), and the widest is the column's scale.
  for (const q of [...c.long, ...c.short]) if (q.p !== 105) assert.equal(onTheWay(s, 105, q.p)!.usd, q.usd, String(q.p));
  assert.equal(Math.max(...[...c.long, ...c.short].map(q => q.usd)), p.maxCum);
  // A price above the rows in view: the long curve starts at their top edge with what lies between it and the price already counted.
  const high = liqCurves(liqProfile(s, 10, 80, 85, 95), 95);
  assert.deepEqual(high.long, [{ p: 90, usd: 100 }, { p: 80, usd: 250 }]);
  assert.equal(high.short.length, 0);
  // And below them: the short curve starts at their bottom edge with the half of bin 11 above the price already counted.
  const low = liqCurves(liqProfile(s, 10, 120, 125, 115), 115);
  assert.deepEqual(low.short, [{ p: 120, usd: 150 }, { p: 130, usd: 190 }]);
  assert.equal(low.long.length, 0);
  assert.deepEqual(liqCurves(p, NaN), { long: [], short: [] });
});

test('rows are at least two pixels tall, and the colour scale ignores the dust', () => {
  assert.equal(binsPerRow(10, { p0: 0, p1: 1000 }, 600), 1);
  assert.equal(binsPerRow(10, { p0: 0, p1: 10_000 }, 600), 4);
  const heat = heatScale([1e6, 2e6, 5e6, 1e7]);
  assert.equal(heat(1e5), 0);
  assert.ok(heat(1e7) > heat(1e6));
  assert.ok(heat(1e9) <= 0.9);
  assert.equal(heat(5e5), 0, 'under 6% of the strong levels is dust');
});

test('only a local service may stand in for the configured address, and a save from before the feature reads as on', () => {
  assert.equal(liqLevelsUrl(''), LIQ_LEVELS_URL);
  assert.equal(liqLevelsUrl('?levels=http://127.0.0.1:8790/v1/btc/liquidations.json'), 'http://127.0.0.1:8790/v1/btc/liquidations.json');
  assert.equal(liqLevelsUrl('?levels=http://localhost:8790/x.json'), 'http://localhost:8790/x.json');
  assert.equal(liqLevelsUrl('?levels=https://evil.example/x.json'), LIQ_LEVELS_URL);
  assert.equal(liqLevelsUrl('?levels=javascript:alert(1)'), LIQ_LEVELS_URL);
  assert.deepEqual(readLiqLevels(undefined), { on: true, column: true });
  assert.deepEqual(readLiqLevels({ on: false }), { on: false, column: true });
  assert.deepEqual(readLiqLevels({ on: 'yes', column: false }), { on: true, column: false });
});

test('the source asks for the file, says when it cannot, retries sooner, keeps the newest snapshot and stays away from other coins', async () => {
  let now = NOW, answer: unknown = doc(SAMPLE), fail = false, asked = 0;
  const get = async (url: string): Promise<unknown> => {
    if (url.includes('hyperliquid')) return [];
    asked++;
    if (fail) throw new Error('down');
    return answer;
  };
  const src = new LiqLevelsSource(get, () => now, () => 'http://127.0.0.1:8790/v1/btc/liquidations.json');
  const other: Coin = { ...BTC, coin: 'ETH' };
  src.ensure(other, () => {});
  assert.equal(src.state, 'other-coin');
  assert.equal(asked, 0);
  let changed = 0;
  src.ensure(BTC, () => { changed++; });
  await tick();
  assert.equal(src.state, 'ready');
  assert.ok(changed >= 1);
  assert.equal(src.levels!.k.length, 4);
  // Nothing is asked again before the next snapshot can be there (HyperTracker created the held one 10 minutes before; the first wait after
  // the page opens is cut by the first lead); then a failure keeps the levels held, and the next try comes after 30 s.
  src.ensure(BTC, () => {});
  now += SNAPSHOT_DUE_MS - FIRST_LEAD_MS - 11 * MIN; src.ensure(BTC, () => {});
  assert.equal(asked, 1);
  now += MIN + 1_000; fail = true;
  src.ensure(BTC, () => {});
  await tick();
  assert.equal(asked, 2);
  assert.equal(src.state, 'ready');
  now += 31_000; fail = false;
  src.ensure(BTC, () => {});
  await tick();
  assert.equal(asked, 3);
  // An older copy (an edge's) never replaces a newer snapshot.
  const newer = AS_OF + 29 * MIN;
  answer = doc(SAMPLE, { snapshot: { asOf: newer, createdAt: newer + 35 * MIN, fetchedAt: newer + 41 * MIN } });
  now += 61_000; src.ensure(BTC, () => {}); await tick();
  assert.equal(src.levels!.asOf, newer);
  answer = doc(SAMPLE);
  now += SNAPSHOT_DUE_MS + 1_000; src.ensure(BTC, () => {}); await tick();
  assert.equal(asked, 5);
  assert.equal(src.levels!.asOf, newer);
  // Levels too old are held but not drawn.
  now = newer + STALE_MS + MIN; src.ensure(BTC, () => {});
  assert.equal(src.state, 'stale');
  // A source that never read the file says it could not.
  const empty = new LiqLevelsSource(async () => { throw new Error('down'); }, () => NOW, () => 'http://127.0.0.1:1/x.json');
  empty.ensure(BTC, () => {});
  await tick();
  assert.equal(empty.state, 'unavailable');
  // A malformed file is a failure, not a level.
  answer = doc(SAMPLE, { v: 9 }); fail = false;
  const strict = new LiqLevelsSource(get, () => NOW, () => 'http://127.0.0.1:8790/v1/btc/liquidations.json');
  strict.ensure(BTC, () => {});
  await tick();
  assert.equal(strict.state, 'unavailable');
  assert.equal(strict.levels, null);
});

test('the file is asked for when the next snapshot can be there: a few asks a snapshot instead of thirty, none while the page is hidden', async () => {
  // The age a snapshot is seen at is held to [0, 55 min] whatever the page's clock says.
  assert.equal(createdOnPageClock(NOW - 9 * MIN, NOW), NOW - 9 * MIN);
  assert.equal(createdOnPageClock(NOW + 10 * MIN, NOW), NOW, 'a clock behind HyperTracker\'s: taken as just created');
  assert.equal(createdOnPageClock(NOW - 5 * 60 * MIN, NOW), NOW - SNAPSHOT_LATE_MS, 'an old one: as late as the schedule knows');
  assert.equal(nextAskAt(NOW, NOW), NOW + SNAPSHOT_DUE_MS);
  assert.equal(nextAskAt(NOW - 40 * MIN, NOW), NOW + MIN, 'due: each minute');
  assert.equal(nextAskAt(NOW - 56 * MIN, NOW), NOW + LATE_EVERY_MS, 'late: every five minutes');
  // Snapshots created at the gaps HyperTracker made 2026-11-04..06, each complete 6 minutes after; the service asks at the held createdAt +
  // 2300 s and every 3 minutes while the next is not complete (schedule.rs); the edge serves a publication a minute after. Asked as the
  // pane's one-second tick does, a tick every 10 s.
  const gaps = [29.7, 27.4, 31.8, 26.3, 30.2, 29.1, 28.6, 31.0, 29.9, 27.1, 30.5, 29.4];
  const created = [Date.UTC(2026, 10, 6, 0, 0)];
  for (const g of gaps) created.push(created.at(-1)! + g * MIN);
  const fetched = [created[0]! + 8.75 * MIN];
  for (let i = 1; i < created.length; i++) {
    let call = created[i - 1]! + 2_300_000;
    while (created[i]! + 6 * MIN > call) call += 180_000;
    fetched.push(call + 5_000);
  }
  // `staleFor`: the snapshot at this index reaches the asks ten minutes late (an edge serving the old copy, as stale-if-error allows).
  let staleFor = -1;
  const latest = (t: number): Record<string, unknown> => {
    let i = 0;
    while (i + 1 < fetched.length && fetched[i + 1]! + MIN + (i + 1 === staleFor ? 10 * MIN : 0) <= t) i++;
    return doc(SAMPLE, { snapshot: { asOf: created[i]! - 35 * MIN, createdAt: created[i]!, fetchedAt: fetched[i]! } });
  };
  // `skew`: the page's clock minus the true time.
  // `step`: the page's clock set back by `by` at `at` (true time), mid-session.
  const simulate = async (skew: number, step?: { at: number; by: number }): Promise<{ asks: number; lag: number[]; now: number }> => {
    let now = fetched[0]! + MIN, asks = 0;
    const src = new LiqLevelsSource(async url => { if (url.includes('hyperliquid')) return []; asks++; return latest(now); }, () => now + skew - (step && now >= step.at ? step.by : 0), () => 'http://127.0.0.1:8790/v1/btc/liquidations.json');
    const lag: number[] = [];
    let held = -1;
    for (; now < fetched.at(-1)! + 3 * MIN; now += 10_000) {
      src.ensure(BTC, () => {}); await tick();
      const f = src.levels?.fetchedAt ?? -1;
      if (f !== held) { held = f; lag.push(now - f - MIN); }
    }
    return { asks, lag, now };
  };
  const right = await simulate(0);
  let { asks, now } = right;
  assert.equal(right.lag.length, created.length, 'every snapshot drawn');
  assert.ok(asks <= 1 + gaps.length * 5, `${asks} asks for ${gaps.length} snapshots (each minute: ${Math.round((now - fetched[0]!) / MIN)})`);
  assert.ok(right.lag.slice(1).every(s => s <= 90_000), `each drawn within 90 s of the edge having it (${right.lag.map(s => Math.round(s / 1000)).join(' s, ')} s)`);
  // A page clock ten minutes behind or ahead: only the first snapshot after the page opened is placed by its clock; from the first one seen
  // appear, each is drawn as promptly as with a right clock, and none is missed.
  for (const skew of [-10 * MIN, 10 * MIN, -36 * MIN, -40 * MIN, -60 * MIN, -180 * MIN, 30 * MIN]) {
    const off = await simulate(skew);
    assert.equal(off.lag.length, created.length, `every snapshot drawn, none skipped (clock ${skew / MIN} min)`);
    assert.ok(off.lag[1]! <= 10 * MIN + 90_000, `the first: late by ten minutes at most (clock ${skew / MIN} min: ${Math.round(off.lag[1]! / 1000)} s)`);
    assert.ok(off.lag.slice(2).every(s => s <= 90_000), `then within 90 s (clock ${skew / MIN} min: ${off.lag.map(s => Math.round(s / 1000)).join(' s, ')} s)`);
    assert.ok(off.asks <= 40 + gaps.length * 5, `${off.asks} asks with the clock ${skew / MIN} min off`);
  }
  // Once the clock's error is learned, a snapshot found after the page was hidden is placed exactly: no lead, no extra asks.
  const clock0 = Date.UTC(2026, 10, 6, 6, 0), behind = -25 * MIN;
  let tt = clock0, served = doc(SAMPLE, { snapshot: { asOf: clock0 - 44 * MIN, createdAt: clock0 - 9 * MIN, fetchedAt: clock0 } }), n = 0;
  const learn = new LiqLevelsSource(async url => { if (url.includes('hyperliquid')) return []; n++; return served; }, () => tt + behind, () => 'http://127.0.0.1:8790/v1/btc/liquidations.json');
  const step = async (to: number): Promise<void> => { for (; tt < to; tt += 10_000) { learn.ensure(BTC, () => {}); await tick(); } };
  // The next is published at 38.4 min past the first's creation; it is seen appear, which teaches the page its clock is 25 minutes behind.
  served = doc(SAMPLE, { snapshot: { asOf: clock0 - 44 * MIN, createdAt: clock0 - 9 * MIN, fetchedAt: clock0 } });
  const second = clock0 - 9 * MIN + 2_304_000, third = second - 8.75 * MIN + 2_304_000;
  await step(second + MIN);
  served = doc(SAMPLE, { snapshot: { asOf: second - 44 * MIN, createdAt: second - 8.75 * MIN, fetchedAt: second } });
  await step(second + 4 * MIN);
  assert.equal(learn.levels!.fetchedAt, second);
  // Hidden from now until well after the third publication: shown again, it is found already there, and placed by the learned offset.
  served = doc(SAMPLE, { snapshot: { asOf: third - 44 * MIN, createdAt: third - 8.75 * MIN, fetchedAt: third } });
  tt = third + 20 * MIN; learn.ensure(BTC, () => {}); await tick();
  assert.equal(learn.levels!.fetchedAt, third);
  const before3 = n;
  // The next can be there 38.3 minutes after the third's creation (28.75 minutes before this read): nothing for 7 minutes, then asked, on
  // time (placed by its age on the page's clock, 25 minutes behind, it would not be asked before about third + 45 minutes).
  await step(third + 27 * MIN);
  assert.equal(n, before3, 'no lead after a hidden stretch once the clock is known');
  await step(third + 30 * MIN);
  assert.ok(n > before3, 'asked when the next is due, by the learned clock');
  // An edge that serves one publication ten minutes late teaches too high an offset; the planned asks that then find each snapshot already
  // there grow a lead until one sees a publication appear again: late for a few snapshots, then on time.
  staleFor = 3;
  const stale = await simulate(0);
  staleFor = -1;
  assert.equal(stale.lag.length, created.length, 'every snapshot drawn after a stale edge');
  assert.ok(stale.lag.slice(8).every(s => s <= 90_000), `on time again within a few snapshots (${stale.lag.map(s => Math.round(s / 1000)).join(' s, ')} s)`);
  // The page's clock set back 33 minutes mid-session (a plan made by the old clock would come half an hour late): none lost, on time again.
  for (const at of [fetched[4]! + 10 * MIN, fetched[7]! - 5 * MIN]) {
    const set = await simulate(0, { at, by: 33 * MIN });
    assert.equal(set.lag.length, created.length, `every snapshot drawn after the clock is set back`);
    assert.ok(set.lag.slice(1).every(s => s <= 5 * MIN), `none more than five minutes late (${set.lag.map(s => Math.round(s / 1000)).join(' s, ')} s)`);
  }
  // The page's clock set back two hours after a plan was made: asked at once, then learned again, never a storm of asks (each ensure an ask).
  let back = 0, now2 = NOW;
  const stepped = new LiqLevelsSource(async url => { if (!url.includes('hyperliquid')) back++; return url.includes('hyperliquid') ? [] : doc(SAMPLE); }, () => now2, () => 'http://127.0.0.1:8790/v1/btc/liquidations.json');
  stepped.ensure(BTC, () => {}); await tick();
  now2 -= 2 * 60 * MIN; stepped.ensure(BTC, () => {}); await tick();
  assert.equal(back, 2, 'a clock set back does not stop the asking');
  for (let k = 0; k < 20 * 60; k++) { now2 += 1_000; stepped.ensure(BTC, () => {}); await tick(); }
  assert.ok(back <= 2 + 16, `${back - 2} asks in the twenty minutes after the step (one a second would be 1,200)`);
  // Published again with a later fetchedAt (the same snapshot): the levels are replaced, and the next ask does not move.
  const created0 = NOW - 10 * MIN;
  let copy = doc(SAMPLE, { snapshot: { asOf: created0 - 35 * MIN, createdAt: created0, fetchedAt: created0 + 9 * MIN } }), copies = 0, t = NOW;
  const again = new LiqLevelsSource(async url => { if (url.includes('hyperliquid')) return []; copies++; return copy; }, () => t, () => 'http://127.0.0.1:8790/v1/btc/liquidations.json');
  again.ensure(BTC, () => {}); await tick();
  t = created0 + SNAPSHOT_DUE_MS + 1_000;
  copy = doc(SAMPLE, { snapshot: { asOf: created0 - 35 * MIN, createdAt: created0, fetchedAt: created0 + 30 * MIN } });
  const v = again.version;
  again.ensure(BTC, () => {}); await tick();
  assert.ok(again.version > v, 'the later copy replaces the held one');
  t += MIN + 1_000; again.ensure(BTC, () => {}); await tick();
  assert.equal(copies, 3, 'still due by its createdAt: asked a minute later, not a wait after the copy');
  // The service stops getting snapshots (HyperTracker's 2.5-hour outage of 2026-11-05): once late, every five minutes.
  const frozen = latest(now), outage = now;
  const quiet = new LiqLevelsSource(async url => { if (url.includes('hyperliquid')) return []; asks++; return frozen; }, () => now, () => 'http://127.0.0.1:8790/v1/btc/liquidations.json');
  asks = 0;
  for (; now < outage + 150 * MIN; now += 10_000) { quiet.ensure(BTC, () => {}); await tick(); }
  assert.ok(asks <= 1 + 19 + 30, `${asks} asks over a 150-minute outage (each minute would be 150)`);
  // A hidden page asks nothing; it asks as it shows again.
  const doc0 = (globalThis as { document?: unknown }).document;
  try {
    (globalThis as { document?: unknown }).document = { hidden: true };
    let n = 0;
    const hidden = new LiqLevelsSource(async url => { if (!url.includes('hyperliquid')) n++; return url.includes('hyperliquid') ? [] : doc(SAMPLE); }, () => NOW, () => 'http://127.0.0.1:8790/v1/btc/liquidations.json');
    hidden.ensure(BTC, () => {}); await tick();
    assert.equal(n, 0, 'hidden: nothing asked');
    (globalThis as { document?: unknown }).document = { hidden: false };
    hidden.ensure(BTC, () => {}); await tick();
    assert.equal(n, 1, 'shown: asked at once');
  } finally { (globalThis as { document?: unknown }).document = doc0; }
});

test('the chart\'s price takes the levels between it and the snapshot\'s mark at once, a margin short of it', async () => {
  const now = NOW;
  const src = new LiqLevelsSource(async url => url.includes('hyperliquid') ? [] : doc(SAMPLE), () => now, () => 'http://127.0.0.1:8790/v1/btc/liquidations.json');
  src.ensure(BTC, () => {});
  await tick();
  // The mark was 100; the chart says 85. Everything down to 95 (85 plus a margin of one bin) has been traded through.
  src.observe(85);
  const s = src.standing()!;
  assert.equal(standingBelow(s, 'long', 1000), 250, 'half of bin 9 gone');
  assert.equal(src.taken()!.long.first[1], AS_OF);
  // Before any candle, Hyperliquid's price is the snapshot's mark.
  assert.equal(src.lastPrice(), 100);
  // A price that is not a number changes nothing.
  src.observe(Number.NaN);
  assert.equal(standingBelow(src.standing()!, 'long', 1000), 250);
});

test('the seam weighs the book against the liquidations each side, ranks level size with book size, and finds walls and voids', () => {
  // Rows of 10 from 0 to 200 with the price at 100: rows 0-9 below, 10-19 above.
  const n = 20, bid = new Array<number>(n).fill(0), ask = new Array<number>(n).fill(0), long = new Array<number>(n).fill(0), short = new Array<number>(n).fill(0);
  for (let i = 0; i < 10; i++) { bid[i] = 100 + i * 10; long[i] = 1 + i; } // below: the bigger the level, the bigger the book (perfect agreement)
  for (let i = 10; i < 20; i++) { ask[i] = 300 - i * 10; short[i] = 1 + i; } // above: the bigger the level, the thinner the book (perfect disagreement)
  const s = seamStats({ row0: 0, step: 10, bid, ask, long, short }, 100, 30);
  // The band: middles within 30 of the price, rows 7-9 below (75, 85, 95) and 10-12 above (105, 115, 125).
  assert.equal(s.below.book, 170 + 180 + 190);
  assert.equal(s.below.liq, 8 + 9 + 10);
  assert.equal(s.above.book, 200 + 190 + 180);
  assert.equal(s.below.bookAll, bid.reduce((a, b) => a + b, 0));
  assert.equal(s.below.n, 3);
  assert.equal(s.below.rho, null, 'three levels in the band are too few');
  assert.equal(s.below.nAll, 10);
  assert.ok(Math.abs(s.below.rhoAll! - 1) < 1e-12);
  assert.ok(Math.abs(s.above.rhoAll! + 1) < 1e-12);
  // The largest level is the top short row (19, 20 dollars): its book (110) against its three neighbours below it (120, 130, 140).
  assert.equal(s.walls[0]!.side, 'short');
  assert.equal(s.walls[0]!.price, 195);
  assert.ok(Math.abs(s.walls[0]!.ratio - 110 / 130) < 1e-12);
  assert.equal(spearman([1, 2, 3], [5, 5, 5]), null, 'a list that does not vary has no correlation');
  assert.ok(Math.abs(spearman([1, 2, 2, 3], [10, 20, 20, 30])! - 1) < 1e-12, 'ties share their rank');
});

test('a one-position diamond wears its side\'s colour, ringed in the page\'s ground, in every theme', () => {
  // A recording canvas: what each closed path was filled and stroked with.
  const marks: { fill: string; stroke: string }[] = [];
  let fillStyle = '', strokeStyle = '', inPath = false;
  const ctx = {
    save() {}, restore() {}, fillRect() {}, moveTo() {}, lineTo() {}, closePath() {},
    beginPath() { inPath = true; },
    stroke() { if (inPath) marks.push({ fill: '', stroke: strokeStyle }); },
    fill() { if (inPath) { marks[marks.length - 1]!.fill = fillStyle; inPath = false; } },
    set fillStyle(v: string) { fillStyle = v; }, get fillStyle() { return fillStyle; },
    set strokeStyle(v: string) { strokeStyle = v; }, get strokeStyle() { return strokeStyle; },
    globalAlpha: 1, lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  const row = (p0: number, side: 'long' | 'short'): LiqRow => {
    const r: LiqRow = { p0, p1: p0 + 10, long: 0, longIso: 0, longWallets: 0, short: 0, shortIso: 0, shortWallets: 0, longTop: 0, shortTop: 0, longOne: false, shortOne: false,
      longFirst: NaN, longGone: NaN, longLeft: 0, shortFirst: NaN, shortGone: NaN, shortLeft: 0 };
    // One position holds 4 of the row's 5 million on this side.
    return Object.assign(r, side === 'long' ? { long: 5e6, longTop: 4e6, longOne: true, longLeft: 5e6 } : { short: 5e6, shortTop: 4e6, shortOne: true, shortLeft: 5e6 });
  };
  const view = new View({ t0: 0, t1: 1, p0: 0, p1: 200 });
  // Terminal's colours: its text is green, which drew a short's colour on the longs' red rows.
  const colors = { long: '#ff3030', short: '#00ff00', text: '#00ff00', muted: '#51b85c', bg: '#000000' };
  paintLiqStripe(ctx, view, 0, 100, 400, [row(50, 'long'), row(150, 'short')], () => 0.9, colors);
  assert.deepEqual(marks, [{ fill: colors.long, stroke: colors.bg }, { fill: colors.short, stroke: colors.bg }]);
});
