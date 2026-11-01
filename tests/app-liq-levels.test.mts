import test from 'node:test';
import assert from 'node:assert/strict';
import { LiqLevelsSource, binsPerRow, heatScale, liqRows, parseLiqLevels, takenByCandles, type LiqLevels } from '../src/app/liq-levels.ts';
import { LIQ_LEVELS_URL, liqLevelsUrl } from '../src/app/liq-url.ts';
import { BTC, type Coin } from '../src/shared/coins.ts';
import type { CandleRow } from '../src/app/store.ts';

const MIN = 60_000;
const AS_OF = Date.UTC(2026, 10, 1, 16, 39, 18);
const NOW = AS_OF + 30 * MIN;

/** A file as the service writes it: bins [k, longIso, longCross, shortIso, shortCross, longWallets, shortWallets, flags]. */
function doc(bins: number[][], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, coin: 'BTC', venue: 'hyperliquid', attribution: 'Powered by HyperTracker', snapshot: { id: 'a52ae475', asOf: AS_OF, completedAt: AS_OF + 300_000, fetchedAt: AS_OF + 600_000 },
    mark: 100, positions: 10, withLiquidation: 8, longSize: 5, shortSize: 5, step: 10, bins, beyond: { longUsd: 0, shortUsd: 0 }, ...over };
}

const SAMPLE = [[8, 100, 50, 0, 0, 3, 0, 0], [9, 0, 200, 0, 0, 2, 0, 1], [11, 0, 0, 300, 0, 0, 1, 2], [12, 0, 0, 0, 40, 0, 2, 0]];
const levels = (): LiqLevels => parseLiqLevels(doc(SAMPLE), 'BTC', NOW)!;
/** One-minute candles from the snapshot's minute: [start, open, high, low, close, volume]. */
const candles = (path: [number, number][]): CandleRow[] => path.map(([h, l], i) => [Math.floor(AS_OF / MIN) * MIN + i * MIN, (h + l) / 2, h, l, (h + l) / 2, 1] as CandleRow);

test('the file is read field by field, and refused whole when any part is off', () => {
  const l = levels();
  assert.equal(l.k.length, 4);
  assert.deepEqual([...l.k], [8, 9, 11, 12]);
  assert.equal(l.longCross[1], 200);
  assert.equal(l.flags[2], 2);
  assert.equal(l.attribution, 'Powered by HyperTracker');
  for (const bad of [
    doc(SAMPLE, { v: 2 }),
    doc(SAMPLE, { coin: 'ETH' }),
    doc([[9, 1, 1, 0, 0, 1, 0, 0], [8, 1, 1, 0, 0, 1, 0, 0]]), // not sorted
    doc([[9, -1, 1, 0, 0, 1, 0, 0]]),
    doc([[9, 1, 1, 0, 0, 1.5, 0, 0]]),
    doc([[9, 1, 1, 0, 0, 1, 0, 4]]),
    doc([[9, 1, 1, 0, 0, 1, 0]]),
    doc(SAMPLE, { step: 0 }),
    doc(SAMPLE, { snapshot: { asOf: NOW + 2 * 3_600_000, fetchedAt: NOW } }),
    { ...doc(SAMPLE), bins: 'x' },
    null, 'text', 42,
  ]) assert.equal(parseLiqLevels(bad, 'BTC', NOW), null, JSON.stringify(bad)?.slice(0, 80));
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

test('rows group whole bins on the fixed grid, add up dollars and wallets, and say when a row is mostly one wallet', () => {
  const l = levels();
  const one = liqRows(l, null, 1, 0, 1000);
  assert.equal(one.length, 4);
  assert.equal(one[1]!.long, 200);
  assert.equal(one[1]!.longOne, true);
  assert.equal(one[0]!.longOne, false);
  // Three bins a row: bins 8 (240..) fall in group 2 ([60, 90)), 9 and 11 in group 3 ([90, 120)), 12 in group 4.
  const three = liqRows(l, null, 3, 0, 1000);
  assert.deepEqual(three.map(r => [r.p0, r.p1]), [[60, 90], [90, 120], [120, 150]]);
  const mid = three[1]!;
  assert.equal(mid.long, 200);
  assert.equal(mid.short, 300);
  assert.equal(mid.longOne, true, 'the flagged bin is the whole long side');
  assert.equal(mid.shortOne, true);
  // Taken: the row's long side is gone once every one of its bins is.
  const tk = takenByCandles(l, candles([[101, 99], [100, 85]]));
  const rows = liqRows(l, tk, 1, 0, 1000);
  assert.ok(Number.isFinite(rows[1]!.longGone));
  assert.equal(rows[1]!.longLeft, 0);
  assert.ok(Number.isNaN(rows[0]!.longGone), 'bin 8 is only half crossed');
  assert.ok(Math.abs(rows[0]!.longLeft - 75) < 1e-9);
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

test('only a local service may stand in for the configured address', () => {
  assert.equal(liqLevelsUrl(''), LIQ_LEVELS_URL);
  assert.equal(liqLevelsUrl('?levels=http://127.0.0.1:8790/v1/btc/liquidations.json'), 'http://127.0.0.1:8790/v1/btc/liquidations.json');
  assert.equal(liqLevelsUrl('?levels=http://localhost:8790/x.json'), 'http://localhost:8790/x.json');
  assert.equal(liqLevelsUrl('?levels=https://evil.example/x.json'), LIQ_LEVELS_URL);
  assert.equal(liqLevelsUrl('?levels=javascript:alert(1)'), LIQ_LEVELS_URL);
});

test('the source asks for the file, says when it cannot, and stays away from other coins', async () => {
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
  await new Promise(r => setTimeout(r, 0));
  assert.equal(src.state, 'ready');
  assert.equal(changed, 1);
  assert.equal(src.levels!.k.length, 4);
  // Within the minute nothing is asked again; after it, a failure keeps the levels held.
  src.ensure(BTC, () => {});
  assert.equal(asked, 1);
  now += 61_000; fail = true;
  src.ensure(BTC, () => {});
  await new Promise(r => setTimeout(r, 0));
  assert.equal(asked, 2);
  assert.equal(src.state, 'ready');
  assert.ok(src.levels);
  // A source that never read the file says it could not.
  const empty = new LiqLevelsSource(async () => { throw new Error('down'); }, () => NOW, () => 'http://127.0.0.1:1/x.json');
  empty.ensure(BTC, () => {});
  await new Promise(r => setTimeout(r, 0));
  assert.equal(empty.state, 'unavailable');
  // A malformed file is a failure, not a level.
  answer = doc(SAMPLE, { v: 9 }); fail = false; now += 61_000;
  const strict = new LiqLevelsSource(get, () => now, () => 'http://127.0.0.1:8790/v1/btc/liquidations.json');
  strict.ensure(BTC, () => {});
  await new Promise(r => setTimeout(r, 0));
  assert.equal(strict.state, 'unavailable');
  assert.equal(strict.levels, null);
});
