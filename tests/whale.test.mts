import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrintSums, WHALE_BANDS_USD } from '../src/shared/print-sums.ts';
import { PrintStream as SqlitePrints } from '../src/server/v2/prints.mts';
import { PrintStream } from '../src/shared/prints.ts';
import { whaleSeries } from '../src/app/vwap/vwap.ts';
import { readVwap, VWAP_DEFAULTS } from '../src/app/vwap/settings.ts';

const MIN = 60_000;
const T = Date.UTC(2026, 9, 9, 12);
const order = (t: number, side: 'buy' | 'sell', price: number, usd: number, id = 'binance:BTCUSDT', key = `${t}${side}${usd}`) =>
  ({ instrumentId: id, tradeId: key, side, price, notionalUsd: usd, sourceTimestamp: t });

test('an order lands in the highest size band it reaches, and a sum from a band adds that band and the larger ones, in coins as well as dollars', () => {
  const sums = new PrintSums();
  assert.deepEqual([99_999, 100_000, 249_999, 250_000, 1_000_000, 9e6].map(u => sums.bandOf(u)), [-1, 0, 0, 1, 2, 3], 'an order on an edge is in the band it starts');
  sums.add({ t: T, id: 'a', side: 'buy', price: 80_000, usd: 250_000 });
  sums.add({ t: T + 10_000, id: 'a', side: 'buy', price: 80_400, usd: 1_005_000 });
  sums.add({ t: T + 20_000, id: 'a', side: 'sell', price: 79_900, usd: 150_000 });
  sums.add({ t: T + MIN, id: 'b', side: 'sell', price: 79_800, usd: 2_000_000 });
  sums.add({ t: T, id: 'a', side: 'buy', price: 80_000, usd: 50_000 }); // under the smallest band: not a whale
  const all = sums.query(['a', 'b'], T, T + 2 * MIN, 100_000, MIN)!;
  assert.equal(all.since, T);
  assert.deepEqual(all.rows.map(r => [r[0], Math.round(r[1]), +r[2].toFixed(6), Math.round(r[3]), +r[4].toFixed(6)]),
    [[T, 1_255_000, +(250_000 / 80_000 + 1_005_000 / 80_400).toFixed(6), 150_000, +(150_000 / 79_900).toFixed(6)], [T + MIN, 0, 0, 2_000_000, +(2_000_000 / 79_800).toFixed(6)]]);
  const big = sums.query(['a'], T, T + 2 * MIN, 1_000_000, MIN)!;
  assert.deepEqual(big.rows.map(r => Math.round(r[1])), [1_005_000], 'from $1M: only the band from $1M up');
  assert.deepEqual(sums.query(['a', 'b'], T, T + 2 * MIN, 100_000, 2 * MIN)!.rows.length, 1, 'two minutes in one step');
  assert.equal(sums.query(['a'], T, T + MIN, 300_000, MIN), null, 'a size that is not a band edge');
  sums.expire(T + MIN);
  assert.deepEqual(sums.query(['a', 'b'], 0, Infinity, 100_000, MIN)!.rows.map(r => r[0]), [T + MIN], 'the minutes before the cut are gone');
});

test('the sums the server rebuilds from SQLite when it starts are the ones it kept while the orders arrived', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-whale-')), file = path.join(dir, 'p.sqlite');
  const now = () => T + 10 * MIN;
  try {
    const first = new SqlitePrints(file, now);
    first.ingest([order(T, 'buy', 80_000, 300_000), order(T + 5_000, 'sell', 79_950, 1_200_000), order(T + MIN, 'buy', 80_100, 120_000, 'okx:BTC-USDT-SWAP'), order(T + MIN, 'buy', 80_100, 30_000)]);
    const live = first.printSums(['binance:BTCUSDT', 'okx:BTC-USDT-SWAP'], T, T + 5 * MIN, 100_000, MIN);
    first.close();
    const again = new SqlitePrints(file, now);
    assert.deepEqual(again.printSums(['binance:BTCUSDT', 'okx:BTC-USDT-SWAP'], T, T + 5 * MIN, 100_000, MIN), live);
    assert.equal(live!.rows.length, 2);
    again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // A stream without a store counts what it holds in memory.
  const memory = new PrintStream(null, () => T);
  memory.ingest([order(T, 'sell', 80_000, 5_000_000)]);
  assert.deepEqual(memory.printSums(['binance:BTCUSDT'], T, T + MIN, 5_000_000, MIN)!.rows.map(r => Math.round(r[3])), [5_000_000]);
  // A coin that trades a tenth of BTC's volume has its bands scaled with its floor.
  assert.deepEqual(new PrintStream(null, () => T, undefined, 2_500).sums.bands, WHALE_BANDS_USD.map(b => b / 10));
});

test('the whale lines are the running dollars over coins of each side, from where they are asked to start', () => {
  const rows: [number, number, number, number, number][] = [[T, 200_000, 2.5, 0, 0], [T + MIN, 0, 0, 100_000, 1.25], [T + 2 * MIN, 400_000, 4.9, 0, 0]];
  const { buys, sells } = whaleSeries(rows, T, T + 3 * MIN);
  assert.deepEqual(buys.map(p => [p.t, +p.vwap.toFixed(2)]), [[T, 80_000], [T + MIN, 80_000], [T + 2 * MIN, +(600_000 / 7.4).toFixed(2)]]);
  assert.deepEqual(sells.map(p => [p.t, p.vwap]), [[T + MIN, 80_000], [T + 2 * MIN, 80_000]], 'a side begins at its first order');
  assert.deepEqual(whaleSeries(rows, T + MIN, T + 3 * MIN).buys.map(p => p.t), [T + 2 * MIN], 'from the recording\'s start when that is later');
});

test('the whale settings are read with the rest: off by default, from $1M, a size only when it is a band', () => {
  assert.deepEqual([VWAP_DEFAULTS.whale, VWAP_DEFAULTS.whaleUsd], [false, 1_000_000]);
  assert.deepEqual([readVwap({ whale: true, whaleUsd: 250_000 }).whale, readVwap({ whaleUsd: 250_000 }).whaleUsd], [true, 250_000]);
  assert.equal(readVwap({ whaleUsd: 300_000 }).whaleUsd, 1_000_000);
});
