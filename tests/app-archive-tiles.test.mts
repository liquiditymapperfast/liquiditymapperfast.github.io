import test from 'node:test';
import assert from 'node:assert/strict';
import { LT_LENGTH } from '../src/shared/lt-sample.ts';
import { decodeTile, headUrl, levelOfUsd, packMs, packStartOf, packStarts, packUrl, packWindows, parseTilesInfo, usdOfLevel } from '../src/app/archive/tiles.ts';
import { encodeTile } from './archive-encoder.mts';

const MIN = 60_000;
/** 2026-11-05T00:00Z, a multiple of 32,768 minutes? No: packs are aligned by the arithmetic under test. */
const T0 = Date.UTC(2026, 10, 5);

test('levels: nothing under a dollar, then within half a percent of the dollars, saturating at 65535', () => {
  assert.equal(levelOfUsd(0), 0);
  assert.equal(levelOfUsd(0.99), 0);
  assert.equal(levelOfUsd(-5), 0);
  assert.equal(levelOfUsd(Number.NaN), 0);
  assert.equal(levelOfUsd(1), 1);
  assert.equal(usdOfLevel(0), 0);
  assert.equal(usdOfLevel(1), 1);
  for (const usd of [1.004, 7.5, 999, 12_345.6, 3.2e6, 4.5e8, 7.7e9]) {
    const back = usdOfLevel(levelOfUsd(usd));
    assert.ok(Math.abs(back / usd - 1) <= 0.00500001, `${usd} -> ${back}`);
  }
  assert.equal(levelOfUsd(1e300), 65535);
});

test('packs: up to 128 windows, at most 32,768 minutes, aligned since the epoch', () => {
  assert.deepEqual([2, 4, 64, 256, 512, 1024, 2048, 4096].map(l => packWindows(l, 32768)), [128, 128, 128, 128, 64, 32, 16, 8]);
  assert.equal(packMs(2, 32768), 256 * MIN);
  assert.equal(packMs(4096, 32768), 32768 * MIN);
  const t = T0 + 17 * MIN, start = packStartOf(t, 8, 32768);
  assert.equal(start % packMs(8, 32768), 0);
  assert.ok(start <= t && t < start + packMs(8, 32768));
  const starts = packStarts(T0, T0 + 3 * packMs(16, 32768), 16, 32768);
  assert.equal(starts.length, T0 % packMs(16, 32768) === 0 ? 3 : 4);
  assert.ok(starts.every((s, i) => i === 0 || s - starts[i - 1]! === packMs(16, 32768)));
  assert.equal(packUrl('https://h/v1/btc', 16, 1_793_000_000_000), 'https://h/v1/btc/t/16/1793000000000.bin');
  assert.equal(packUrl('https://h/v1/btc', 16, 0), 'https://h/v1/btc/t/16/0000000000000.bin');
  assert.equal(headUrl('https://h/v1/btc', 4096), 'https://h/v1/btc/t/4096/head.bin');
});

test('latest.json tiles: read when whole, refused otherwise', () => {
  const good = { v: 1, levels: [4, 2, 8, 4096], packSpan: 32768, through: T0, first: T0 - 86_400_000 };
  assert.deepEqual(parseTilesInfo(good), { ...good, levels: [2, 4, 8, 4096] });
  assert.equal(parseTilesInfo(undefined), null);
  assert.equal(parseTilesInfo({ ...good, v: 2 }), null);
  assert.equal(parseTilesInfo({ ...good, levels: [3] }), null);
  assert.equal(parseTilesInfo({ ...good, packSpan: 1000 }), null);
  assert.equal(parseTilesInfo({ ...good, first: T0 + 1 }), null, 'first after through');
  assert.deepEqual(parseTilesInfo({ ...good, levels: [2, 3, 8192, 1] })?.levels, [2], 'only levels the service builds');
});

test('a file reads back as written: windows by index, bins by delta, levels to dollars, the tracker exact and only where it was kept', () => {
  const lt = Array.from({ length: LT_LENGTH }, (_, i) => i % 4 >= 2 ? 0.37 + i : 1_250_000.5 + i);
  const start = packStartOf(T0, 32, 32768);
  const bytes = encodeTile({
    level: 32, packStart: start, windows: 128, head: true, through: start + 40 * 32 * MIN,
    books: [
      ['binance:BTCUSDT', [
        { index: 3, n: 384, step: 20, bins: [3900, 3901, 3905, -2], bid: [15_000, 0.5, 2.5e6, 0], ask: [0, 1, 7.1e5, 12], ltN: 384, lt },
        { index: 0, n: 12, step: 20, bins: [], bid: [], ask: [] },
      ]],
      ['okx:BTC-USDT-SWAP', [{ index: 39, n: 100, step: 50, bins: [1570], bid: [3e7], ask: [1], open: true, cut: true }]],
    ],
  });
  const file = decodeTile(bytes)!;
  assert.ok(file);
  assert.equal(file.level, 32); assert.equal(file.packStart, start); assert.equal(file.windows, 128); assert.equal(file.head, true);
  assert.equal(file.through, start + 40 * 32 * MIN);
  const binance = file.books.get('binance:BTCUSDT')!;
  assert.deepEqual(binance.map(c => c.t), [start, start + 3 * 32 * MIN], 'sorted by time');
  const c = binance[1]!;
  assert.deepEqual([...c.bins], [3900, 3901, 3905, -2]);
  assert.equal(c.n, 384); assert.equal(c.step, 20); assert.equal(c.ltN, 384);
  assert.ok(Math.abs(c.bid[0]! / 15_000 - 1) < 0.005 && c.bid[1] === 0 && c.bid[3] === 0);
  assert.equal(c.ask[1], 1);
  assert.deepEqual([...c.lt!], lt.map(v => Math.fround(v)), 'the tracker is f32 as written, weight sums under one included');
  assert.equal(binance[0]!.lt, undefined, 'no tracker without ltN');
  const okx = file.books.get('okx:BTC-USDT-SWAP')![0]!;
  assert.equal(okx.t, start + 39 * 32 * MIN); assert.equal(okx.open, true); assert.equal(okx.cut, true); assert.equal(okx.step, 50);
  assert.equal(binance[1]!.open, false);
});

test('a file that is not one, or is cut short, is refused', () => {
  const bytes = encodeTile({ level: 2, packStart: 0, windows: 128, through: 0, books: [['a', [{ index: 0, n: 1, step: 1, bins: [1, 2], bid: [5, 6], ask: [7, 8], ltN: 1 }]]] });
  assert.ok(decodeTile(bytes));
  assert.equal(decodeTile(bytes.slice(0, bytes.byteLength - 1)), null, 'cut in the tracker');
  assert.equal(decodeTile(bytes.slice(0, 20)), null, 'cut in the header');
  const wrong = new Uint8Array(bytes.slice(0)); wrong[0] = 0x58;
  assert.equal(decodeTile(wrong.buffer), null, 'magic');
  const version = new Uint8Array(bytes.slice(0)); version[4] = 2;
  assert.equal(decodeTile(version.buffer), null, 'a later version');
  const index = encodeTile({ level: 2, packStart: 0, windows: 4, through: 0, books: [['a', [{ index: 4, n: 1, step: 1, bins: [], bid: [], ask: [] }]]] });
  assert.equal(decodeTile(index), null, 'a window past the pack');
});
