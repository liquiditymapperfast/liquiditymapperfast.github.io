import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { ARCHIVE_DAYS, ArchiveMemo, LongShortCache, LsNoMarket, VENUE_WAITING_MAX, fetchLongShort, lsPeriodAtLeast, lsPeriodOf, lsPopulationOf, lsReading, lsWindowPeriod, parseLsSeries, shareOfRatio, zipText } from '../src/shared/long-short.ts';
import { lsAt, lsCardLines, lsIds, lsRange, stepEnd } from '../src/app/panes/ls-pane.ts';
import { fetchOiHistory, webGet, type Fetcher } from '../src/shared/history.ts';
import { LAYOUT_KEYS, readSettings, type CandleRow } from '../src/app/store.ts';
import { atOnePrice } from '../src/app/oi-change.ts';

const M = 60_000, H = 3_600_000, NOW = Date.UTC(2026, 9, 13, 18, 50);

/** A fake venue: answers by the URL's start, and keeps every URL it was asked. */
function fake(answers: Record<string, (url: URL) => unknown>): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  const get = (async (raw: string) => {
    asked.push(raw);
    const url = new URL(raw), hit = Object.keys(answers).find(prefix => raw.startsWith(prefix));
    if (!hit) throw new Error(`no answer for ${raw}`);
    return answers[hit]!(url);
  }) as Fetcher & { asked: string[] };
  get.asked = asked;
  return get;
}

test('a reading must add up: shares to 1 and the ratio to long over short, within the rounding; never a made-up 50 %', () => {
  assert.deepEqual(lsReading(1, 0.5564, 0.4436, 1.2543), { t: 1, long: 0.5564 }, "Binance's own numbers");
  assert.equal(lsReading(1, 0.6, 0.3), null, 'shares that do not add up to 1');
  assert.equal(lsReading(1, 0.6, 0.4, 2), null, 'a ratio that is not long over short');
  assert.equal(lsReading(1, NaN), null);
  assert.equal(lsReading(1, 1), null, 'all long is not a share a venue gives');
  assert.equal(lsReading(0, 0.5), null, 'no time');
  assert.ok(Math.abs(shareOfRatio(1.25) - 0.5556) < 1e-4, 'L/S 1.25 is 55.6 % long');
});

test("each venue's period: the longest no longer than the candle, five minutes at the finest", () => {
  assert.deepEqual([lsPeriodOf('binance', M), lsPeriodOf('binance', H), lsPeriodOf('bybit', 2 * H), lsPeriodOf('okx', 15 * M), lsPeriodOf('okx', 7 * 24 * H), lsPeriodOf('hyperliquid', H)],
    [5 * M, H, H, 5 * M, 24 * H, null]);
});

test("the venues' answers as they come (measured 2026-10-13): Binance pages back from endTime, Bybit newest first, OKX a ratio, Bitget its 30 periods", async () => {
  const row = (t: number) => ({ symbol: 'BTCUSDT', longAccount: '0.5564', longShortRatio: '1.2543', shortAccount: '0.4436', timestamp: t });
  const get = fake({
    'https://fapi.binance.com/futures/data/globalLongShortAccountRatio': url => {
      const end = Number(url.searchParams.get('endTime'));
      // Two full pages and a short one, oldest first as Binance sends them.
      const n = end > NOW - 1_000 * 5 * M ? 500 : 20;
      return Array.from({ length: n }, (_, i) => row(Math.floor(end / (5 * M)) * 5 * M - (n - 1 - i) * 5 * M));
    },
    'https://api.bybit.com/v5/market/account-ratio': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.594', sellRatio: '0.406', timestamp: String(NOW - 10 * M) }, { buyRatio: '0.5945', sellRatio: '0.4055', timestamp: String(NOW - 15 * M) }] } }),
    'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract': () => ({ code: '0', data: [[String(NOW - 10 * M), '1.2192867221330219'], [String(NOW - 15 * M), 'x']] }),
    'https://api.bitget.com/api/v2/mix/market/account-long-short': () => ({ code: '00000', data: [{ longAccountRatio: '0.6174', shortAccountRatio: '0.3826', longShortAccountRatio: '1.6136', ts: String(NOW - 10 * M) }] }),
  });
  const { points: binance } = await fetchLongShort('binance', 'BTCUSDT', 'accounts', 5 * M, NOW - 3 * 24 * H, NOW, get, NOW);
  assert.ok(binance.length > 500 && binance.every((p, i) => i === 0 || p.t > binance[i - 1]!.t), 'pages joined, oldest first, no repeats');
  assert.equal(get.asked.filter(u => u.includes('binance')).length, 2, 'until a page is short');
  assert.deepEqual((await fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, get, NOW)).points.map(p => p.long), [0.5945, 0.594]);
  const { points: okx } = await fetchLongShort('okx', 'BTC-USDT-SWAP', 'accounts', 5 * M, NOW - H, NOW, get, NOW);
  assert.equal(okx.length, 1, 'a ratio that is not a number is left out'); assert.ok(Math.abs(okx[0]!.long - 0.5494) < 1e-3);
  assert.deepEqual((await fetchLongShort('bitget', 'BTCUSDT', 'topAccounts', 5 * M, NOW - H, NOW, get, NOW)).points.map(p => p.long), [0.6174]);
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'topPositions', 5 * M, NOW - H, NOW, get, NOW), /no such series/, "only Binance publishes its top traders'");
  // Binance's API keeps 30 days: nothing older is asked of it (the archive below reads USD-M's days before; COIN-M has none).
  const old = fake({ 'https://dapi.binance.com/': () => [] });
  await fetchLongShort('binance', 'BTCUSD_PERP', 'topAccounts', H, NOW - 60 * 24 * H, NOW - 40 * 24 * H, old, NOW);
  assert.equal(old.asked.length, 0);
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, fake({ 'https://api.bybit.com/': () => ({ retCode: 10001, retMsg: 'bad' }) }), NOW), /bybit/, 'a changed API fails, not empty');
});

const D = 24 * H, ARCHIVE_HEAD = 'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio';
/** A daily archive file as Binance publishes it: one CSV in a zip, deflated (or stored), an extra field in its local header only. */
function archiveZip(csv: string, method: 0 | 8 = 8): Uint8Array {
  const name = Buffer.from('BTCUSDT-metrics.csv'), extra = Buffer.alloc(9), raw = Buffer.from(csv), data = method === 8 ? deflateRawSync(raw) : raw;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(method, 10); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + extra.length + data.length, 16);
  return new Uint8Array(Buffer.concat([local, name, extra, data, dir, name, end]));
}
const archiveDate = (url: URL): number => Date.parse(`${/metrics-(\d{4}-\d\d-\d\d)\.zip$/.exec(url.pathname)![1]}T00:00:00Z`);
/**
 * A fake archive: day d's file holds create_time d 00:00 .. 23:55 in no order, as Binance writes them; every account's ratio says which row
 * and day it is (1 + row/1000 + days since `base`/10), its top traders' are 2 (by accounts) and 3 (by positions). Days in `missing` and before
 * `first` have no file (404).
 */
function archiveFake(base: number, first: number, missing: ReadonlySet<number> = new Set(), fail?: number) {
  return (url: URL): Uint8Array => {
    const day = archiveDate(url);
    if (day === fail) throw Object.assign(new Error('HTTP 503'), { status: 503 });
    if (missing.has(day) || day < first) throw Object.assign(new Error('HTTP 404'), { status: 404 });
    const rows = Array.from({ length: 288 }, (_, i) => (i * 97) % 288).map(i => `${new Date(day + i * 5 * M).toISOString().slice(0, 19).replace('T', ' ')},BTCUSDT,1,1,2.0,3.0,${(1 + i / 1000 + (day - base) / D / 10).toFixed(8)},1.0`);
    return archiveZip([ARCHIVE_HEAD, ...rows].join('\n'));
  };
}
const ratioShare = (ratio: number): number => ratio / (1 + ratio);

test("Binance before its API's 30 days: its daily archive, a row the API's reading five minutes on, a midnight from the day before's file", async () => {
  const jul1 = Date.UTC(2026, 6, 1), get = fake({ 'https://data.binance.vision/': archiveFake(jul1, Date.UTC(2026, 5, 20), new Set([Date.UTC(2026, 6, 10)])) });
  const daily = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, jul1 + D, jul1 + 4 * D, get, NOW);
  assert.deepEqual(daily.points.map(p => p.t), [0, 1, 2, 3].map(i => jul1 + i * D), 'the midnights of the window and the one before it');
  // July 2's midnight is July 1's last row (23:55, row 287); July 1's is June 30's.
  assert.ok(Math.abs(daily.points[1]!.long - ratioShare(1.287)) < 1e-9 && Math.abs(daily.points[0]!.long - ratioShare(1.187)) < 1e-9);
  assert.equal(daily.from, jul1 + D, 'read back to the window');
  assert.deepEqual(get.asked.map(u => u.slice(-14, -4)), ['2026-07-04', '2026-07-03', '2026-07-02', '2026-07-01', '2026-06-30'], 'the days it needs, newest first, none of the API');
  assert.ok(get.asked.every(u => u.startsWith('https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-')));
  const fourHourly = await fetchLongShort('binance', 'BTCUSDT', 'accounts', 4 * H, jul1 + D, jul1 + 2 * D, get, NOW);
  assert.deepEqual(fourHourly.points.map(p => (p.t - jul1) / H), [20, 24, 28, 32, 36, 40, 44], 'every fourth hour, the one before the window too');
  const fine = await fetchLongShort('binance', 'BTCUSDT', 'accounts', 5 * M, jul1 + D, jul1 + D + H, get, NOW);
  assert.equal(fine.points.length, 13, 'five-minute readings: every row');
  // July 10 has no file: July 11's midnight is missing, never filled in.
  const gap = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, Date.UTC(2026, 6, 9), Date.UTC(2026, 6, 13), get, NOW);
  assert.deepEqual(gap.points.map(p => new Date(p.t).getUTCDate()), [8, 9, 10, 12]);
  assert.equal(gap.from, Date.UTC(2026, 6, 9), 'a day with no file is read all the same');
  // The archive begins on June 20: a window across it holds what there is, and one before it is read, with nothing.
  const start = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, Date.UTC(2026, 5, 10), Date.UTC(2026, 5, 25), get, NOW);
  assert.deepEqual([start.points.map(p => new Date(p.t).getUTCDate()), start.from], [[21, 22, 23, 24], Date.UTC(2026, 5, 10)]);
  const before = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 10), get, NOW);
  assert.deepEqual([before.points, before.from], [[], Date.UTC(2026, 5, 1)]);
  // Each series its own column.
  const top = await fetchLongShort('binance', 'BTCUSDT', 'topPositions', D, jul1 + D, jul1 + 2 * D, get, NOW);
  assert.deepEqual(top.points.map(p => p.long), [0.75, 0.75], 'top traders by positions: 3 long for each short');
  assert.ok((await fetchLongShort('binance', 'BTCUSDT', 'topAccounts', D, jul1 + D, jul1 + 2 * D, get, NOW)).points.every(p => Math.abs(p.long - 2 / 3) < 1e-9));
});

test("the archive: a long window is read a stretch at a time, newest first; a file that fails or is not of its form leaves the archive's days unclaimed", async () => {
  const get = fake({ 'https://data.binance.vision/': archiveFake(Date.UTC(2026, 0, 1), Date.UTC(2025, 0, 1)) });
  const from = Date.UTC(2026, 0, 1), to = Date.UTC(2026, 6, 20), r = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, from, to, get, NOW);
  const oldest = Date.UTC(2026, 6, 19) - (ARCHIVE_DAYS - 1) * D;
  assert.equal(get.asked.length, ARCHIVE_DAYS, 'one read takes the newest days only');
  assert.equal(r.from, oldest + 5 * M, 'and says how far back it reached: the oldest day read, from its first row');
  assert.equal(r.points[0]!.t, oldest + D, "that day's own midnight is the day before's");
  // One file failing (the other days read), a file of another form, or no zip at all: none of the window's days is claimed (a window this old
  // has no API readings, so the answer reaches back only to where the API's days begin, after the window), and nothing is drawn.
  const unclaimed = async (answer: (url: URL) => unknown): Promise<[number, boolean]> => {
    const r = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, from, from + 5 * D, fake({ 'https://data.binance.vision/': answer }), NOW);
    return [r.points.length, r.from >= from + 5 * D];
  };
  assert.deepEqual(await unclaimed(archiveFake(from, from, new Set(), from + 2 * D)), [0, true]);
  assert.deepEqual(await unclaimed(() => archiveZip('create_time,symbol,sum_open_interest\n2026-01-01 00:00:00,BTCUSDT,1')), [0, true]);
  assert.deepEqual(await unclaimed(() => new Uint8Array([1, 2, 3])), [0, true]);
  await assert.rejects(zipText(new Uint8Array([1, 2, 3])), /not a zip/);
  assert.equal(await zipText(archiveZip('a,b\n1,2', 0)), 'a,b\n1,2', 'a stored file too');
});

test("the archive meets the API's 30 days: one series, the API's own reading where both have one", async () => {
  const api = (url: URL) => {
    const end = Number(url.searchParams.get('endTime')), limit = Number(url.searchParams.get('limit'));
    return Array.from({ length: limit }, (_, i) => ({ symbol: 'BTCUSDT', longAccount: '0.5000', shortAccount: '0.5000', longShortRatio: '1.0000', timestamp: Math.floor(end / D) * D - (limit - 1 - i) * D }));
  };
  const get = fake({ 'https://fapi.binance.com/futures/data/globalLongShortAccountRatio': api, 'https://data.binance.vision/': archiveFake(NOW - 400 * D, NOW - 400 * D) });
  const r = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, NOW - 40 * D, NOW, get, NOW);
  const days = r.points.map(p => p.t);
  assert.ok(days.every((t, i) => i === 0 || t - days[i - 1]! === D) && days[0]! <= NOW - 40 * D && days[days.length - 1]! >= NOW - 2 * D, 'every midnight, unbroken');
  const apiFrom = Math.min(...r.points.filter(p => p.long === 0.5).map(p => p.t));
  assert.ok(apiFrom <= NOW - 29 * D && r.points.filter(p => p.t < apiFrom).every(p => p.long !== 0.5), "the archive's before the API's, the API's where both answer");
  assert.equal(r.from, NOW - 40 * D);
  assert.ok(get.asked.some(u => u.includes('fapi.binance.com')) && get.asked.some(u => u.includes('data.binance.vision')));
});

/** Binance's API as it answers: `limit` daily readings back from `endTime`, every one 50 % long. */
const dailyApi = (url: URL) => {
  const end = Number(url.searchParams.get('endTime')), limit = Number(url.searchParams.get('limit'));
  return Array.from({ length: limit }, (_, i) => ({ symbol: 'BTCUSDT', longAccount: '0.5000', shortAccount: '0.5000', longShortRatio: '1.0000', timestamp: Math.floor(end / D) * D - (limit - 1 - i) * D }));
};

test("an archive that fails, or has no file on days the API shows trading on, leaves the API's readings and claims none of its days", async () => {
  const failing = fake({ 'https://fapi.binance.com/': dailyApi, 'https://data.binance.vision/': archiveFake(NOW - 400 * D, NOW - 400 * D, new Set(), Math.floor((NOW - 35 * D) / D) * D) });
  const memo = new ArchiveMemo(), r = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, NOW - 60 * D, NOW, failing, NOW, memo);
  assert.ok(r.points.length >= 29 && r.points.every(p => p.long === 0.5), "the API's days, none of the archive's");
  assert.deepEqual([r.from, memo.cooling('BTCUSDT', NOW + 59_000), memo.cooling('BTCUSDT', NOW + 61_000), memo.cooling('ETHUSDT', NOW)], [NOW - 29 * D, true, false, false], 'held from where the API reaches; this market left alone a minute');
  const archiveAsked = () => failing.asked.filter(u => u.includes('data.binance.vision')).length, asked = archiveAsked();
  await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, NOW - 60 * D, NOW, failing, NOW + 30_000, memo);
  assert.equal(archiveAsked(), asked, 'left alone for a minute');
  await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, NOW - 60 * D, NOW, failing, NOW + 61_000, memo);
  assert.ok(archiveAsked() > asked && archiveAsked() < 2 * asked, 'then asked again, for the day that failed (the others are kept)');
  // Gone or moved: not one file, the API trading on those days, and not the file of three days ago either.
  const moved = new ArchiveMemo(), r2 = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, NOW - 60 * D, NOW, fake({ 'https://fapi.binance.com/': dailyApi, 'https://data.binance.vision/': archiveFake(NOW, NOW + 400 * D) }), NOW, moved);
  assert.deepEqual([r2.from, moved.cooling('BTCUSDT', NOW)], [NOW - 29 * D, true]);
  // The API's first reading the midnight after the read's newest day is that day's last row: it traded then, so its file was missing.
  const today = Math.floor(NOW / D) * D, edge = new ArchiveMemo();
  const r4 = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, NOW - 60 * D, NOW, fake({ 'https://fapi.binance.com/': url => dailyApi(url).filter(row => row.timestamp >= today - 28 * D), 'https://data.binance.vision/': archiveFake(NOW, NOW + 400 * D) }), NOW, edge);
  assert.deepEqual([r4.from, edge.cooling('BTCUSDT', NOW)], [NOW - 29 * D, true]);
  // A market listed ten days ago has no file before it and no API reading either: the window is read, with nothing in it before.
  const young = new ArchiveMemo(), r3 = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, NOW - 60 * D, NOW, fake({ 'https://fapi.binance.com/': url => dailyApi(url).slice(-10), 'https://data.binance.vision/': archiveFake(NOW, NOW + 400 * D) }), NOW, young);
  assert.deepEqual([r3.from, young.cooling('BTCUSDT', NOW), r3.points.length], [NOW - 60 * D, false, 10]);
});

test('a window older than the API with no file in it is before the archive only when the archive holds the market: else unclaimed, and read again', async () => {
  let back = false;
  const archive = archiveFake(NOW - 400 * D, NOW - 400 * D), get = fake({ 'https://data.binance.vision/': url => { if (!back) throw Object.assign(new Error('HTTP 404'), { status: 404 }); return archive(url); } });
  const memo = new ArchiveMemo(), from = NOW - 200 * D, to = NOW - 150 * D, files = () => get.asked.length;
  const r = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, from, to, get, NOW, memo);
  assert.deepEqual([r.points.length, r.from, memo.cooling('BTCUSDT', NOW)], [0, to, true], 'nothing claimed of the window, the market left alone a minute');
  const asked = files();
  await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, from, to, get, NOW + 30_000, memo);
  assert.equal(files(), asked, 'not asked within the minute');
  back = true;
  const again = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, from, to, get, NOW + 61_000, memo);
  assert.ok(files() > asked && again.from === from && again.points.length === 51, 'its days asked again, not taken from the memo, and read');
  // Before the archive begins, the archive holding the market (a file read for it): read, with nothing in it.
  const early = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, NOW - 900 * D, NOW - 850 * D, get, NOW + 62_000, memo);
  assert.deepEqual([early.points, early.from], [[], NOW - 900 * D]);
});

test('the archive holds a market on a look at its file of three days ago, at most a minute old: not because a file was read once', async () => {
  let gone = false, lookFails = false;
  const today = Math.floor(NOW / D) * D, archive = archiveFake(NOW - 400 * D, NOW - 400 * D);
  const get = fake({ 'https://data.binance.vision/': url => {
    const day = archiveDate(url);
    if (day === today - 3 * D && lookFails) throw Object.assign(new Error('HTTP 503'), { status: 503 });
    // A day's file is out the next morning: nothing yet for today or yesterday.
    if (gone || day > today - 2 * D) throw Object.assign(new Error('HTTP 404'), { status: 404 });
    return archive(url);
  } });
  const memo = new ArchiveMemo();
  const early = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, NOW - 900 * D, NOW - 850 * D, get, NOW, memo);
  assert.deepEqual([early.points, early.from], [[], NOW - 900 * D], 'before the archive begins, in a fresh session');
  assert.equal((await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, NOW - 200 * D, NOW - 150 * D, get, NOW + 61_000, memo)).points.length, 51);
  // Gone a moment after a good read: a window with no file is not "before the archive" for the file read then.
  gone = true;
  const after = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, NOW - 300 * D, NOW - 250 * D, get, NOW + 122_000, memo);
  assert.deepEqual([after.points.length, after.from], [0, NOW - 250 * D], 'unclaimed');
  // A look that fails is no evidence either.
  gone = false; lookFails = true;
  const failedLook = await fetchLongShort('binance', 'BTCUSDT', 'accounts', D, NOW - 950 * D, NOW - 920 * D, get, NOW + 300_000, memo);
  assert.deepEqual([failedLook.points.length, failedLook.from], [0, NOW - 920 * D]);
});

test('the archive reaches a day into the API\'s days: the day the API begins is read from both', async () => {
  const get = fake({ 'https://fapi.binance.com/': () => [], 'https://data.binance.vision/': archiveFake(NOW - 400 * D, NOW - 400 * D) });
  await fetchLongShort('binance', 'BTCUSDT', 'accounts', H, NOW - 31 * D, NOW - 29 * D + 2 * H, get, NOW);
  const day = new Date(NOW - 29 * D).toISOString().slice(0, 10);
  assert.ok(get.asked.some(u => u.endsWith(`-metrics-${day}.zip`)), `${day} asked of the archive too`);
});

test("the cache reads a long archive window on by itself once no question waits, a read at a time, each day's file once", async () => {
  const get = fake({ 'https://fapi.binance.com/futures/data/': () => [], 'https://data.binance.vision/': archiveFake(NOW - 400 * D, NOW - 400 * D) });
  const cache = new LongShortCache(get, true, () => NOW), from = NOW - 250 * D;
  // The days from the one holding the reading before the window to the one holding the API's oldest (29 days back).
  const days = (Math.floor((NOW - 29 * D - 1 - 5 * M) / D) - Math.floor((from - D - 5 * M) / D)) + 1, archive = () => get.asked.filter(u => u.includes('data.binance.vision'));
  assert.ok(days > 2 * ARCHIVE_DAYS, 'three reads');
  const first = await cache.series('binance:BTCUSDT', 'accounts', D, from, NOW, 0);
  assert.equal(first.pending, true, 'a question that does not wait');
  for (let i = 0; i < 400 && archive().length < days; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(archive().length, days, 'every day of the window, and no more');
  assert.equal(new Set(archive()).size, days, 'no day asked twice');
  const after = await cache.series('binance:BTCUSDT', 'accounts', D, from, NOW, 0);
  assert.deepEqual([after.status, after.pending], ['ok', undefined], 'the whole window held, without another question');
  assert.ok(after.points[0]!.t <= from && after.points.length >= 220, `${after.points.length} midnights`);
  // The pane reads the other series after the one shown: from the same days' files, kept, none fetched again.
  const top = await cache.series('binance:BTCUSDT', 'topPositions', D, from, NOW);
  assert.deepEqual([top.status, archive().length, top.points.length], ['ok', days, after.points.length]);
  assert.ok(top.points.every(p => p.long === 0.75));
  // A question that waits reads on in its own turns: the window whole in one answer, each day once (no read started beside it).
  const waited = fake({ 'https://fapi.binance.com/futures/data/': () => [], 'https://data.binance.vision/': archiveFake(NOW - 400 * D, NOW - 400 * D) });
  const one = await new LongShortCache(waited, true, () => NOW).series('binance:BTCUSDT', 'accounts', D, from, NOW);
  const files = waited.asked.filter(u => u.includes('data.binance.vision'));
  assert.deepEqual([one.status, one.pending, files.length, new Set(files).size], ['ok', undefined, days, days]);
});

test('a window wider than one question reaches (twenty years) is read back to where the archive begins: each day once, the API once, then still', async () => {
  const get = fake({ 'https://fapi.binance.com/futures/data/': () => [], 'https://data.binance.vision/': archiveFake(NOW - 400 * D, NOW - 400 * D) });
  // A cap: a read that never ends (each answered at once) fails here instead of spinning the test.
  const capped: Fetcher = async (url, init) => { if (get.asked.length >= 3_000) throw new Error('too many requests'); return get(url, init); };
  const cache = new LongShortCache(capped, true, () => NOW), from = NOW - 20 * 365 * D, files = () => get.asked.filter(u => u.includes('data.binance.vision'));
  let answer = await cache.series('binance:BTCUSDT', 'accounts', D, from, NOW, 0);
  for (let i = 0; i < 600 && (answer.pending || answer.status !== 'ok'); i++) { await new Promise(resolve => setTimeout(resolve, 10)); answer = await cache.series('binance:BTCUSDT', 'accounts', D, from, NOW, 0); }
  assert.deepEqual([answer.status, answer.pending], ['ok', undefined], 'the whole window held');
  const asked = files().length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(files().length, asked, 'and nothing read after');
  assert.equal(new Set(files()).size, asked, 'no day asked twice');
  assert.ok(asked <= 5 * ARCHIVE_DAYS + 1, `${asked} files: back to the archive's first day, one read of none before it, one look at a recent day`);
  assert.equal(get.asked.filter(u => u.includes('fapi')).length, 1, 'the API asked for its own days once, not once a read');
  assert.ok(answer.points.length > 360 && answer.points[0]!.t >= NOW - 402 * D);
});

test('a question that waits keeps its own bound (four reads): nothing reads on beside it, and nothing after it', async () => {
  const get = fake({ 'https://fapi.binance.com/futures/data/': () => [], 'https://data.binance.vision/': archiveFake(NOW - 800 * D, NOW - 800 * D) });
  const answer = await new LongShortCache(get, true, () => NOW).series('binance:BTCUSDT', 'accounts', D, NOW - 700 * D, NOW);
  const files = () => get.asked.filter(u => u.includes('data.binance.vision')).length;
  assert.deepEqual([answer.status, files()], ['stale', 4 * ARCHIVE_DAYS], 'four reads of a seven-read window, said as not all read');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(files(), 4 * ARCHIVE_DAYS);
});

test('a series let go of while its archive is read (the cache over its bound) is not read on', async () => {
  const get = fake({ 'https://fapi.binance.com/futures/data/': () => [], 'https://data.binance.vision/': archiveFake(NOW - 400 * D, NOW - 400 * D) });
  const cache = new LongShortCache(get, true, () => NOW, 1), btc = () => get.asked.filter(u => u.includes('/BTCUSDT/')).length;
  await cache.series('binance:BTCUSDT', 'accounts', D, NOW - 250 * D, NOW, 0);
  await cache.series('binance:ETHUSDT', 'accounts', D, NOW - 250 * D, NOW, 0);
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(btc(), ARCHIVE_DAYS, 'its read under way finished, and no other');
});

test('webGet answers a .zip with its bytes, anything else with its JSON, and a 404 with its status', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => String(url).endsWith('.zip') ? new Response(new Uint8Array([80, 75, 5, 6])) : String(url).includes('missing') ? new Response('', { status: 404 }) : new Response('{"a":1}')) as typeof fetch;
  try {
    const bytes = await webGet('https://data.binance.vision/x.zip');
    assert.ok(bytes instanceof Uint8Array && bytes[0] === 80 && bytes.length === 4);
    assert.deepEqual(await webGet('https://fapi.binance.com/x'), { a: 1 });
    await assert.rejects(webGet('https://data.binance.vision/missing.json'), (error: unknown) => (error as { status?: number }).status === 404);
  } finally { globalThis.fetch = real; }
});

test('Bitget: each series its own endpoint and fields (2026-10-21), a day is 1Dutc, and the cache asks it at most once a second', async () => {
  const get = fake({
    'https://api.bitget.com/api/v2/mix/market/long-short': () => ({ code: '00000', data: [{ longRatio: '0.6965', shortRatio: '0.3035', longShortRatio: '2.2948', ts: String(NOW - 10 * M) }] }),
    'https://api.bitget.com/api/v2/mix/market/account-long-short': () => ({ code: '00000', data: [{ longAccountRatio: '0.6906', shortAccountRatio: '0.3094', longShortAccountRatio: '2.232', ts: String(NOW - 10 * M) }] }),
    'https://api.bitget.com/api/v2/mix/market/position-long-short': () => ({ code: '00000', data: [{ longPositionRatio: '0.4922', shortPositionRatio: '0.5078', longShortPositionRatio: '0.9692', ts: String(NOW - 10 * M) }] }),
  });
  assert.deepEqual((await fetchLongShort('bitget', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, get, NOW)).points.map(p => p.long), [0.6965], 'all users');
  assert.deepEqual((await fetchLongShort('bitget', 'BTCUSDT', 'topPositions', 5 * M, NOW - H, NOW, get, NOW)).points.map(p => p.long), [0.4922], 'its big traders by position');
  assert.equal(lsPopulationOf('bitget', 'topPositions'), 'topPositions', 'Bitget follows the series chosen');
  await fetchLongShort('bitget', 'BTCUSDT', 'topAccounts', 24 * H, NOW - 40 * 24 * H, NOW, get, NOW);
  assert.ok(get.asked.at(-1)!.endsWith('period=1Dutc'), 'Bitget refuses 1d');
  // Three series asked at once (a round and its warming): one request a second, never two within the venue's gap.
  const times: number[] = [];
  const timed = fake({ 'https://api.bitget.com/': url => { times.push(Date.now()); const path = url.pathname.split('/').pop(); return { code: '00000', data: path === 'long-short' ? [{ longRatio: '0.6', shortRatio: '0.4', longShortRatio: '1.5', ts: String(NOW - 10 * M) }] : path === 'account-long-short' ? [{ longAccountRatio: '0.6', shortAccountRatio: '0.4', longShortAccountRatio: '1.5', ts: String(NOW - 10 * M) }] : [{ longPositionRatio: '0.6', shortPositionRatio: '0.4', longShortPositionRatio: '1.5', ts: String(NOW - 10 * M) }] }; } });
  const cache = new LongShortCache(timed, true, () => NOW, 48, 10_000, 20_000, { bitget: 150 });
  const answers = await Promise.all((['accounts', 'topAccounts', 'topPositions'] as const).map(m => cache.series('bitget:BTCUSDT', m, 5 * M, NOW - H, NOW)));
  assert.deepEqual(answers.map(a => a.status), ['ok', 'ok', 'ok']);
  assert.ok(times.length === 3 && times[1]! - times[0]! >= 140 && times[2]! - times[1]! >= 140, `spaced: ${times.map(t => t - times[0]!).join(', ')}`);
});

/** A fake Bitget answering every series in its own shape, recording what went out and when. */
function bitgetFake(): Fetcher & { asked: string[]; sent: { what: string; at: number }[] } {
  const sent: { what: string; at: number }[] = [];
  const get = fake({ 'https://api.bitget.com/': url => {
    const path = url.pathname.split('/').pop()!, ts = String(NOW - 10 * M);
    sent.push({ what: `${path}@${url.searchParams.get('period')}`, at: Date.now() });
    return { code: '00000', data: [path === 'long-short' ? { longRatio: '0.6', shortRatio: '0.4', longShortRatio: '1.5', ts } : path === 'account-long-short' ? { longAccountRatio: '0.6', shortAccountRatio: '0.4', longShortAccountRatio: '1.5', ts } : { longPositionRatio: '0.6', shortPositionRatio: '0.4', longShortPositionRatio: '1.5', ts }] };
  } });
  return Object.assign(get, { sent });
}

test('Bitget pacing: one lane, first come first served, a gap from the request that really went out, even after the page was busy', async () => {
  const get = bitgetFake(), cache = new LongShortCache(get, true, () => NOW, 48, 10_000, 20_000, { bitget: 100 });
  const id = 'bitget:BTCUSDT', asked = [cache.series(id, 'accounts', 5 * M, NOW - H, NOW), cache.series(id, 'topAccounts', 5 * M, NOW - H, NOW), cache.series(id, 'topPositions', 5 * M, NOW - H, NOW)];
  // The page busy for longer than the queue's gaps: timers set for the later two would all fire at once, and a request asked now went first.
  const until = Date.now() + 350; while (Date.now() < until) { /* busy */ }
  asked.push(cache.series(id, 'accounts', 15 * M, NOW - H, NOW));
  assert.deepEqual((await Promise.all(asked)).map(a => a.status), ['ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(get.sent.map(s => s.what), ['long-short@5m', 'account-long-short@5m', 'position-long-short@5m', 'long-short@15m'], 'in the order asked');
  for (let i = 1; i < get.sent.length; i++) assert.ok(get.sent[i]!.at - get.sent[i - 1]!.at >= 95, `a gap apart: ${get.sent.map(s => s.at - get.sent[0]!.at).join(', ')}`);
});

test('Bitget pacing: at most VENUE_WAITING_MAX wait for their turn; one more fails at once instead of going out long after its round', async () => {
  const get = bitgetFake(), cache = new LongShortCache(get, true, () => NOW, 48, 10_000, 20_000, { bitget: 20 });
  const id = 'bitget:BTCUSDT', asked: Promise<{ status: string }>[] = [];
  for (const tf of [5 * M, 15 * M, 30 * M, H]) for (const m of ['accounts', 'topAccounts', 'topPositions'] as const) asked.push(cache.series(id, m, tf, NOW - 2 * H, NOW));
  const statuses = (await Promise.all(asked)).map(a => a.status);
  assert.equal(statuses.filter(s => s === 'ok').length, VENUE_WAITING_MAX);
  assert.equal(statuses.filter(s => s === 'failed').length, 12 - VENUE_WAITING_MAX, 'the rest read as failed, asked again with the minute');
  assert.equal(get.sent.length, VENUE_WAITING_MAX);
});

test('the popup says Bitget publishes only its newest 30 readings where it has none, without placing where they begin', () => {
  const bitget = (points: { t: number; long: number }[]) => ({ id: 'bitget:BTCUSDT', population: 'accounts' as const, periodMs: 5 * M, points, status: 'ok' as const });
  const say = (s: ReturnType<typeof bitget>, at: number) => lsCardLines([s], at, '5m').map(l => l.text).join('\n');
  assert.match(say(bitget([{ t: NOW - 10 * M, long: 0.6 }]), NOW - 2 * H), /newest 30 readings/);
  assert.doesNotMatch(say(bitget([{ t: NOW - 10 * M, long: 0.6 }]), NOW - 8 * M), /newest 30 readings/, 'not where it has a reading');
  assert.match(say(bitget([]), NOW), /newest 30 readings/, 'an answer with none for the window too');
});

test('the cache: one request per series at a time, the newest stretch again at most once a period, OKX server only in a page, failures reported', async () => {
  let now = NOW;
  const get = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(NOW - 5 * M) }] } }) });
  const cache = new LongShortCache(get, true, () => now);
  const [a, b] = await Promise.all([cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW), cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW)]);
  assert.equal(get.asked.length, 1, 'two questions at once share one request');
  assert.deepEqual([a.status, a.population, a.periodMs, a.points.length, b.points.length], ['ok', 'accounts', 5 * M, 1, 1]);
  now += 2 * M; await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW);
  assert.equal(get.asked.length, 1, 'not due yet');
  now += 4 * M; await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW);
  assert.equal(get.asked.length, 2, 'a period later, the newest stretch again');
  assert.equal((await cache.series('okx:BTC-USDT-SWAP', 'accounts', 5 * M, NOW - H, NOW)).status, 'serverOnly');
  assert.equal((await cache.series('hyperliquid:BTC', 'accounts', 5 * M, NOW - H, NOW)).status, 'unsupported');
  const broken = new LongShortCache(fake({}), false, () => now);
  const failed = await broken.series('binance:BTCUSDT', 'topPositions', 5 * M, NOW - H, NOW);
  assert.deepEqual([failed.status, failed.population, failed.points], ['failed', 'topPositions', []]);
});

test('over the wire: a series of the wrong shape is an error, a reading out of range or order is dropped', () => {
  assert.throws(() => parseLsSeries({ id: 'x', status: 'great', population: null, periodMs: 0, points: [] }));
  const s = parseLsSeries({ id: 'binance:BTCUSDT', population: 'accounts', periodMs: 300_000, status: 'ok', points: [{ t: 2, long: 0.55 }, { t: 1, long: 0.56 }, { t: 3, long: 1.2 }, { t: 4, long: 0.57 }] });
  assert.deepEqual(s.points, [{ t: 2, long: 0.55 }, { t: 4, long: 0.57 }]);
});

test('a reading holds until the next, and for three periods after the newest; nothing before the first', () => {
  const points = [{ t: 0, long: 0.55 }, { t: 5 * M, long: 0.56 }];
  assert.deepEqual([lsAt(points, -1, 5 * M), lsAt(points, 3 * M, 5 * M)?.long, lsAt(points, 19 * M, 5 * M)?.long, lsAt(points, 20 * M, 5 * M)], [null, 0.55, 0.56, null]);
});

test('the Binance series is a saved setting and a layout setting: only the three it publishes, all accounts by default; the pane is off by default', () => {
  assert.deepEqual([readSettings({}).lsMetric, readSettings({ lsMetric: 'topPositions' }).lsMetric, readSettings({ lsMetric: 'whales' }).lsMetric], ['accounts', 'topPositions', 'accounts']);
  assert.equal(readSettings({}).show.ls, false);
  assert.ok((LAYOUT_KEYS as readonly string[]).includes('lsMetric'));
});

test("Binance's top-trader choice is Binance's alone: the other venues still read their accounts", async () => {
  const get = fake({
    'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(NOW - 5 * M) }] } }),
    'https://fapi.binance.com/futures/data/topLongShortPositionRatio': () => [{ longAccount: '0.61', shortAccount: '0.39', longShortRatio: '1.5641', timestamp: NOW - 5 * M }],
  });
  const cache = new LongShortCache(get, true, () => NOW);
  const bybit = await cache.series('bybit:BTCUSDT', 'topPositions', 5 * M, NOW - H, NOW), binance = await cache.series('binance:BTCUSDT', 'topPositions', 5 * M, NOW - H, NOW);
  assert.deepEqual([bybit.status, bybit.population, binance.status, binance.population], ['ok', 'accounts', 'ok', 'topPositions']);
});

test('open-interest history that answers an error fails, so the sampler tries again, instead of reading as none', async () => {
  const listing = { symbol: 'BTCUSDT', unit: 1 };
  await assert.rejects(fetchOiHistory('bybit:BTCUSDT', H, NOW - 24 * H, NOW, fake({ 'https://api.bybit.com/': () => ({ retCode: 10006, retMsg: 'Too many visits' }) }), listing), /bybit/);
  await assert.rejects(fetchOiHistory('okx:BTC-USDT-SWAP', H, NOW - 24 * H, NOW, fake({ 'https://www.okx.com/': () => ({ code: '50011', msg: 'Too Many Requests', data: [] }) }), { symbol: 'BTC-USDT-SWAP', unit: 1 }), /okx/);
  await assert.rejects(fetchOiHistory('binance:BTCUSDT', H, NOW - 24 * H, NOW, fake({ 'https://fapi.binance.com/': () => ({ code: -1003, msg: 'Too many requests' }) }), listing), /binance/);
  assert.deepEqual(await fetchOiHistory('bybit:BTCUSDT', H, NOW - 24 * H, NOW, fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [] } }) }), listing), [], 'an empty list is none');
});

test('a question for an older window asked while a newer one is read gets its window too, after waiting its turn', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const get = fake({ 'https://api.bybit.com/': async url => {
    const end = Number(url.searchParams.get('endTime'));
    if (end > NOW - H) await gate;
    // Five-minute readings, newest first, for the 24 periods (two hours) before `endTime`: a request for the newest stretch does not reach the older window.
    return { retCode: 0, result: { list: Array.from({ length: 24 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.floor(end / (5 * M)) * 5 * M - (i + 1) * 5 * M) })) } };
  } });
  const cache = new LongShortCache(get, true, () => NOW);
  const newer = cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW);
  const older = cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 3 * H, NOW - 2 * H);
  release();
  const [a, b] = await Promise.all([newer, older]);
  assert.equal(a.status, 'ok');
  assert.deepEqual([b.status, b.points.length > 0], ['ok', true], 'the older window was read once the newer request was answered');
});

test('the scale and the readout follow the steps as drawn: a reading holds until the next, and past the newest the newest stands', () => {
  const s = { points: [{ t: 0, long: 0.6 }, { t: 15 * M, long: 0.62 }], periodMs: 5 * M };
  assert.deepEqual([stepEnd(s, 0), stepEnd(s, 1)], [15 * M, 20 * M], 'the first holds until the second (within three periods), the last one period');
});

test('a long window held only as far as its pages reached; a pane shown again after a pause reads the readings it missed', async () => {
  // A venue with a full page for every question: twelve pages of five-minute readings reach about 21 days back.
  const full = (end: number) => ({ retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.floor(end / (5 * M)) * 5 * M - (i + 1) * 5 * M) })) } });
  const deep = await fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - 29 * 24 * H, NOW, fake({ 'https://api.bybit.com/': url => full(Number(url.searchParams.get('endTime'))) }), NOW);
  assert.ok(deep.from > NOW - 22 * 24 * H && deep.from < NOW - 20 * 24 * H, 'it says where its pages stopped');
  let now = NOW;
  const get = fake({ 'https://api.bybit.com/': url => { const end = Number(url.searchParams.get('endTime')); return { retCode: 0, result: { list: Array.from({ length: 30 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.min(Math.floor(end / (5 * M)), Math.floor(now / (5 * M))) * 5 * M - (i + 1) * 5 * M) })) } }; } });
  const cache = new LongShortCache(get, true, () => now);
  await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW);
  now = NOW + H; // the pane was hidden for an hour
  const after = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW + 50 * M, NOW + H);
  const gap = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW, NOW + H);
  assert.equal(after.status, 'ok');
  assert.ok(gap.points.some(p => p.t === NOW + 30 * M), 'the readings of the hour it was hidden are held');
});

test("the one price for an inverse market's coins can be the Range selection's own", () => {
  const candles: CandleRow[] = [[0, 0, 0, 0, 50_000, 0], [H, 0, 0, 0, 100_000, 0]];
  assert.deepEqual(atOnePrice([[0, 20, 20, 20, 20]], candles, 50_000).map(b => b[4]), [20]);
  assert.deepEqual(atOnePrice([[0, 20, 20, 20, 20]], candles).map(b => b[4]), [10]);
  assert.deepEqual(atOnePrice([[0, 20, 20, 20, 20]], [], 50_000).map(b => b[4]), [20], 'no candles to convert by: as they are');
});

test('a window older than the cache holds gets its readings, and a changed answer fails rather than reading as empty', async () => {
  const full = (end: number) => ({ retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.floor(end / (5 * M)) * 5 * M - (i + 1) * 5 * M) })) } });
  const cache = new LongShortCache(fake({ 'https://api.bybit.com/': url => full(Number(url.searchParams.get('endTime'))) }), false, () => NOW);
  const old = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 40 * 24 * H, NOW - 39 * 24 * H);
  assert.deepEqual([old.status, old.points.length], ['ok', 289], 'forty days back: a day of five-minute readings and the one before it, which holds at its start');
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW)).status, 'ok', 'and the newest after it');
  const changed = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', time: String(NOW - 5 * M) }] } }) });
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, changed, NOW), /unknown shape/);
});

test('a refresh that fails after a good answer says so, with the readings held from before', async () => {
  let now = NOW, failing = false;
  const get = fake({ 'https://api.bybit.com/': () => { if (failing) throw new Error('HTTP 503'); return { retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(NOW - 10 * M) }] } }; } });
  const cache = new LongShortCache(get, true, () => now);
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW + H)).status, 'ok');
  failing = true; now += 6 * M;
  const after = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW + H);
  assert.deepEqual([after.status, after.points.length], ['stale', 1]);
  assert.equal(parseLsSeries(after).status, 'stale', 'and the wire carries it');
});

test('a long window on a fine chart takes a coarser period: one question reaches across it and the series keeps all of it', async () => {
  const full = (url: URL) => { const end = Number(url.searchParams.get('endTime')), p = url.searchParams.get('period') === '1d' ? 24 * H : url.searchParams.get('period') === '1h' ? H : url.searchParams.get('period') === '30min' ? 30 * M : 5 * M;
    return { retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.floor(end / p) * p - (i + 1) * p) })) } }; };
  const get = fake({ 'https://api.bybit.com/': full });
  const cache = new LongShortCache(get, false, () => NOW);
  const month = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 40 * 24 * H, NOW);
  assert.deepEqual([month.status, month.periodMs], ['ok', 24 * H], 'forty days use daily readings instead of 1,920 half-hourly readings');
  assert.ok(month.points[0]!.t <= NOW - 40 * 24 * H + 24 * H && month.points.length >= 40 && month.points.length <= 42, 'the whole daily window, oldest included');
  assert.equal(get.asked.length, 1, 'the history arrives in one page');
  assert.ok(Number(new URL(get.asked[0]!).searchParams.get('limit')) <= 42, 'only the daily readings needed are requested');
  const asked = get.asked.length;
  await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 40 * 24 * H, NOW);
  assert.equal(get.asked.length, asked, 'asked again at once: nothing more to read');
  assert.equal(lsPeriodAtLeast('bybit', 28.8 * M), 30 * M);
});

test('a good answer after a failure clears it: readings read back after a failed try are not called stale', async () => {
  let now = NOW, failOlder = true;
  const get = fake({ 'https://api.bybit.com/': url => {
    const end = Number(url.searchParams.get('endTime'));
    if (end < NOW - 30 * M && failOlder) throw new Error('HTTP 503');
    return { retCode: 0, result: { list: Array.from({ length: 60 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.floor(end / (5 * M)) * 5 * M - (i + 1) * 5 * M) })) } };
  } });
  const cache = new LongShortCache(get, false, () => now);
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - H, NOW)).status, 'ok');
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 4 * H, NOW - 3 * H)).status, 'failed');
  failOlder = false; now += 61_000;
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 4 * H, NOW - 3 * H)).status, 'ok');
});

test('a page that never answers fails its request at the deadline, so the series is never stuck: the questions after it are answered', async () => {
  // On the live server two series' one request never settled (2026-10-15): every later question for Bybit's and OKX's hourly BTC readings waited for good.
  let now = NOW, hang = true;
  const asked: string[] = [];
  const get: Fetcher = async raw => {
    asked.push(raw);
    if (hang) return new Promise<never>(() => {});
    return { retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(NOW - 2 * H) }] } };
  };
  const cache = new LongShortCache(get, false, () => now, 48, 10_000, 30);
  const started = Date.now();
  const [a, b] = await Promise.all([cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H), cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H)]);
  assert.deepEqual([a.status, b.status, asked.length], ['failed', 'failed', 1], 'both questions answered, one request');
  assert.ok(Date.now() - started < 2_000, 'at the deadline, not never');
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H)).status, 'failed', 'within a minute of the failure: answered at once');
  assert.equal(asked.length, 1);
  hang = false; now += 61_000;
  const after = await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H);
  assert.deepEqual([after.status, after.points.length, asked.length], ['ok', 1, 2], 'a minute on, read again');
});

test('a window inside the period under way is held: asked again at once, the venue is not', async () => {
  const get = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(Math.floor(NOW / H) * H - H) }] } }) });
  const cache = new LongShortCache(get, false, () => NOW);
  // A chart zoomed in on the last minutes: the window asked begins inside the hour under way.
  const from = Math.floor(NOW / H) * H;
  await cache.series('bybit:BTCUSDT', 'accounts', H, from, NOW + H);
  const first = get.asked.length;
  assert.equal(first, 1, 'one request for the first question');
  await Promise.all([1, 2, 3].map(() => cache.series('bybit:BTCUSDT', 'accounts', H, from, NOW + H)));
  assert.equal(get.asked.length, first, 'none for the next ones (each asked the venue again, twice, before)');
});

test('a reading published after an empty stretch was held is read by the next refresh, also for a window reaching back from it', async () => {
  // Hourly readings, each published once its hour is over; it is 18:50.
  let now = Date.UTC(2026, 9, 13, 18, 50);
  const get = fake({ 'https://api.bybit.com/': url => {
    const last = Math.floor(Math.min(Number(url.searchParams.get('endTime')), now - H) / H) * H;
    return { retCode: 0, result: { list: Array.from({ length: 48 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(last - i * H) })) } };
  } });
  const cache = new LongShortCache(get, false, () => now);
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 13, h, m);
  await cache.series('bybit:BTCUSDT', 'accounts', H, at(18, 45), at(19, 50));
  const back = await cache.series('bybit:BTCUSDT', 'accounts', H, at(18, 30), at(18, 40));
  assert.ok(!back.points.some(p => p.t === at(18)), 'the 18:00 reading is not out yet');
  const asked = get.asked.length;
  now = at(19, 51);
  const later = await cache.series('bybit:BTCUSDT', 'accounts', H, at(18, 30), at(18, 40));
  assert.ok(later.points.some(p => p.t === at(18)), 'an hour on, the 18:00 reading is read and given');
  assert.ok(get.asked.length > asked);
});

test('a window inside or after the period under way claims nothing before it: a window reaching back from it reads what it needs', async () => {
  const now = Date.UTC(2026, 9, 13, 18, 50);
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 13, h, m);
  const venue = () => fake({ 'https://api.bybit.com/': url => {
    const last = Math.floor(Math.min(Number(url.searchParams.get('endTime')), now - H) / H) * H;
    return { retCode: 0, result: { list: Array.from({ length: 48 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(last - i * H) })) } };
  } });
  // A chart zoomed in on the live edge, then one a little further back: the 17:00 reading holds into its window.
  const live = new LongShortCache(venue(), false, () => now);
  await live.series('bybit:BTCUSDT', 'accounts', H, at(18, 45), at(19, 50));
  assert.ok((await live.series('bybit:BTCUSDT', 'accounts', H, at(17, 55), at(18, 50))).points.some(p => p.t === at(17)));
  // A view in the future (nothing to read), then one before it.
  const ahead = new LongShortCache(venue(), false, () => now);
  await ahead.series('bybit:BTCUSDT', 'accounts', H, at(20), at(21));
  assert.ok((await ahead.series('bybit:BTCUSDT', 'accounts', H, at(17, 55), at(18, 40))).points.some(p => p.t === at(17)));
  // Asked again, neither goes back to the venue.
  const get = venue(), again = new LongShortCache(get, false, () => now);
  await again.series('bybit:BTCUSDT', 'accounts', H, at(18, 45), at(19, 50));
  const asked = get.asked.length;
  await again.series('bybit:BTCUSDT', 'accounts', H, at(18, 45), at(19, 50));
  await again.series('bybit:BTCUSDT', 'accounts', H, at(20), at(21));
  assert.equal(get.asked.length, asked);
});

test('five questions at once for different windows each get their own window read', async () => {
  // Five-minute readings for years, full pages of 500 (about 42 hours) back from endTime, each answered a little later: every window two
  // days further back needs a request of its own.
  const get = fake({ 'https://api.bybit.com/': async url => {
    await new Promise(r => setTimeout(r, 2));
    const last = Math.floor(Math.min(Number(url.searchParams.get('endTime')), NOW - 5 * M) / (5 * M)) * 5 * M;
    return { retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(last - i * 5 * M) })) } };
  } });
  const cache = new LongShortCache(get, false, () => NOW), D = 24 * H;
  const windows = [0, 2, 4, 6, 8].map(k => ({ from: NOW - (k + 1) * D, to: NOW - k * D }));
  const answers = await Promise.all(windows.map(w => cache.series('bybit:BTCUSDT', 'accounts', 5 * M, w.from, w.to)));
  answers.forEach((a, i) => assert.ok(a.status === 'ok' && a.points.some(p => p.t >= windows[i]!.from && p.t < windows[i]!.to), `window ${i + 1} read (it was answered empty without being read)`));
  // Past what a question waits for (64 requests), a window not read says it could not be read: never "no readings".
  const many = new LongShortCache(get, false, () => NOW);
  const far = Array.from({ length: 70 }, (_, k) => ({ from: NOW - (2 * k + 1) * D, to: NOW - 2 * k * D }));
  const got = await Promise.all(far.map(w => many.series('bybit:BTCUSDT', 'accounts', 5 * M, w.from, w.to)));
  assert.ok(got.every((a, i) => a.status === 'failed' || (a.status === 'ok' && a.points.some(p => p.t >= far[i]!.from && p.t < far[i]!.to))), 'read, or said to be unread');
  assert.ok(got.some(a => a.status === 'failed') && !got.some(a => a.status === 'empty'));
});

test('the pane draws nothing, and says why, when no step of the readings held is in view', () => {
  const s = { points: [{ t: 0, long: 0.6 }, { t: H, long: 0.62 }], periodMs: H };
  assert.deepEqual(lsRange([s], 0, 30 * M), { lo: 0.6, hi: 0.6 });
  assert.deepEqual(lsRange([s], 30 * M, 3 * H), { lo: 0.6, hi: 0.62 }, 'a step that began before the view and holds into it counts');
  assert.equal(lsRange([s], 10 * H, 20 * H), null, 'readings held for another time');
  assert.equal(lsRange([], 0, H), null);
});

test('a window that ended a little before the live edge is read on at once for one that reaches past it, not a period later', async () => {
  // Five-minute readings, each published once its five minutes are over; it is 18:51.
  const now = Date.UTC(2026, 9, 13, 18, 51), at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 13, h, m, s);
  const get = fake({ 'https://api.bybit.com/': url => {
    const last = Math.floor(Math.min(Number(url.searchParams.get('endTime')), now - 5 * M) / (5 * M)) * 5 * M;
    return { retCode: 0, result: { list: Array.from({ length: 60 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(last - i * 5 * M) })) } };
  } });
  const cache = new LongShortCache(get, false, () => now);
  await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, at(17, 50), at(18, 42, 30));
  const next = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, at(18, 46), at(18, 49));
  assert.ok(next.points.some(p => p.t === at(18, 45)), 'the 18:45 reading, out since 18:50, is given (it was "empty" until the next period)');
  const asked = get.asked.length;
  await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, at(18, 46), at(18, 56));
  assert.equal(get.asked.length, asked, 'at the live edge, once a period still');
});

test('an answer that lost a field its readings are checked with fails as a changed API, rather than reading as none', async () => {
  const bybit = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ buyRatio: '0.6', sellRat: '0.4', timestamp: String(NOW - 5 * M) }] } }) });
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, bybit, NOW), /unknown shape/);
  const binance = fake({ 'https://fapi.binance.com/': () => [{ longAccount: '0.6', shortAccount: '0.4', ratio: '1.5', timestamp: NOW - 5 * M }] });
  await assert.rejects(fetchLongShort('binance', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, binance, NOW), /unknown shape/);
  const bitget = fake({ 'https://api.bitget.com/': () => ({ code: '00000', data: [{ longAccountRatio: '0.6', longShortAccountRatio: '1.5', ts: String(NOW - 5 * M) }] }) });
  await assert.rejects(fetchLongShort('bitget', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, bitget, NOW), /unknown shape/);
});

test('a reading with no valid time in a full page does not end the paging: the older pages are still read', async () => {
  const get = fake({ 'https://api.bybit.com/': url => {
    const last = Math.floor(Math.min(Number(url.searchParams.get('endTime')), NOW) / (5 * M)) * 5 * M - 5 * M;
    return { retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: i === 250 ? '0' : String(last - i * 5 * M) })) } };
  } });
  const { points } = await fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - 3 * 24 * H, NOW, get, NOW);
  assert.ok(points[0]!.t < NOW - 2 * 24 * H, 'the readings of the third day back were read (paging stopped at the bad row before)');
  const timeless = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: Array.from({ length: 500 }, () => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: 'x' })) } }) });
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - 3 * 24 * H, NOW, timeless, NOW), /no reading time/, 'a full page that cannot be paged on fails');
});

test('a read on past what is held whose pages run out before it leaves the hole unclaimed: a window in it is read', async () => {
  // Five-minute readings, 500 a page of which the oldest 100 carry no valid time: twelve pages reach about 16.7 days back.
  const get = fake({ 'https://api.bybit.com/': url => {
    const last = Math.floor(Math.min(Number(url.searchParams.get('endTime')), NOW) / (5 * M)) * 5 * M - 5 * M;
    return { retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: i >= 400 ? 'x' : String(last - i * 5 * M) })) } };
  } });
  const cache = new LongShortCache(get, false, () => NOW), D = 24 * H;
  await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 18 * D, NOW - 17.5 * D);
  await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - D, NOW + 5 * M);
  const hole = await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 17.4 * D, NOW - 17 * D);
  assert.deepEqual([hole.status, hole.points.some(p => p.t >= NOW - 17.4 * D && p.t < NOW - 17 * D)], ['ok', true], 'read (it answered "empty", the hole claimed as held)');
});

test('a failure pauses the series for a minute from when it failed, however long its pages took', async () => {
  let now = NOW, calls = 0;
  // Each page takes a minute and a quarter of the clock, and the second never answers.
  const get: Fetcher = async () => { calls++; now += 75_000; if (calls > 1) return new Promise<never>(() => {}); return { retCode: 0, result: { list: Array.from({ length: 500 }, (_, i) => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(NOW - (i + 1) * 5 * M) })) } }; };
  const cache = new LongShortCache(get, false, () => now, 48, 10_000, 30);
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', 5 * M, NOW - 3 * 24 * H, NOW)).status, 'failed');
  assert.equal(calls, 2, 'one request of two pages, not asked again at once though it began more than a minute before it failed');
});

test("the chart's period only where it fits the window, and an answer that lost its share fields fails", async () => {
  const get = fake({ 'https://www.okx.com/': url => ({ code: '0', data: Array.from({ length: 100 }, (_, i) => [String(Number(url.searchParams.get('end')) - (i + 1) * (url.searchParams.get('period') === '1H' ? H : 5 * M)), '1.2']) }) });
  const okx = await new LongShortCache(get, false, () => NOW).series('okx:BTC-USDT-SWAP', 'accounts', 30 * M, NOW - 15 * 24 * H, NOW);
  assert.equal(okx.periodMs, H, 'fifteen days on OKX: hourly (its five-minute readings would be 4,320, past what a question reaches)');
  const renamed = fake({ 'https://api.bybit.com/': () => ({ retCode: 0, result: { list: [{ longShare: '0.6', timestamp: String(NOW - 5 * M) }] } }) });
  await assert.rejects(fetchLongShort('bybit', 'BTCUSDT', 'accounts', 5 * M, NOW - H, NOW, renamed, NOW), /unknown shape/);
});

test('a coin-margined market is read where its venue publishes it: Binance COIN-M by its pair, Bybit inverse by its category', async () => {
  const t = NOW - 10 * M;
  const get = fake({
    'https://dapi.binance.com/futures/data/topLongShortPositionRatio': () => [{ pair: 'BTCUSD', longPosition: '0.6811', shortPosition: '0.3189', longShortRatio: '2.1358', timestamp: t }],
    'https://api.bybit.com/v5/market/account-ratio': url => ({ retCode: 0, result: { list: url.searchParams.get('category') === 'inverse' ? [{ symbol: 'BTCUSD', buyRatio: '0.6547', sellRatio: '0.3453', timestamp: String(t) }] : [] } }),
  });
  const binance = await fetchLongShort('binance', 'BTCUSD_PERP', 'topPositions', 5 * M, t - H, t + M, get, NOW);
  assert.deepEqual(binance.points, [{ t, long: 0.6811 }]);
  assert.equal(new URL(get.asked[0]!).searchParams.get('pair'), 'BTCUSD');
  const bybit = await fetchLongShort('bybit', 'BTCUSD', 'accounts', 5 * M, t - H, t + M, get, NOW);
  assert.deepEqual(bybit.points, [{ t, long: 0.6547 }]);
});

test('the popup explains a ratio by who it counts: accounts, or the top traders\x27 position size', async () => {

  const point = [{ t: NOW - 5 * M, long: 0.6 }];
  const text = (series: Parameters<typeof lsCardLines>[0]) => lsCardLines(series, NOW, '5m').map(l => l.text).join('\n');
  const positions = text([{ id: 'binance:BTCUSDT', population: 'topPositions', periodMs: 5 * M, points: point, status: 'ok' }]);
  assert.match(positions, /position size/); assert.doesNotMatch(positions, /long accounts for each short one/);
  const accounts = text([{ id: 'bybit:BTCUSDT', population: 'accounts', periodMs: 5 * M, points: point, status: 'ok' }]);
  assert.match(accounts, /long accounts for each short one/); assert.doesNotMatch(accounts, /position size/);
});

test('OKX reads its top traders by accounts and by positions from their own endpoints, the shares from its ratio', async () => {
  const get = fake({ 'https://www.okx.com/api/v5/rubik/stat/contracts/': url => ({ code: '0', data: [[String(NOW - 5 * M), url.pathname.includes('position') ? '0.99' : '1.0574561403508772']] }) });
  const positions = await fetchLongShort('okx', 'BTC-USDT-SWAP', 'topPositions', 5 * M, NOW - H, NOW, get, NOW);
  assert.ok(get.asked.at(-1)!.includes('/long-short-position-ratio-contract-top-trader?'));
  assert.ok(Math.abs(positions.points[0]!.long - 0.99 / 1.99) < 1e-9);
  await fetchLongShort('okx', 'BTC-USDT-SWAP', 'topAccounts', 5 * M, NOW - H, NOW, get, NOW);
  assert.ok(get.asked.at(-1)!.includes('/long-short-account-ratio-contract-top-trader?'));
  assert.equal(lsPopulationOf('okx', 'topPositions'), 'topPositions', 'OKX follows the series chosen');
  assert.equal(lsPopulationOf('bybit', 'topPositions'), 'accounts', 'Bybit publishes one');
});

test('Gate: every series from one answer, its counts or sizes checked against its ratio, paged forward; a coin it does not list publishes none', async () => {
  // Gate's own answer for BTC_USDT (2026-10-21), the fields read.
  const row = (t: number) => ({ time: t / 1000, lsr_account: 1.0164918488563124, long_users: 16087, short_users: 15826, top_lsr_account: 0.6266666666666667, top_long_account: 47, top_short_account: 75, top_lsr_size: 1.221354101019112, top_long_size: 32945851, top_short_size: 26974856 });
  const get = fake({ 'https://api.gateio.ws/api/v4/futures/usdt/contract_stats': url => { const from = Number(url.searchParams.get('from')) * 1000; return [row(from), row(from + 5 * M)].filter(r => r.time * 1000 < NOW); } });
  const all = await fetchLongShort('gateio', 'BTC_USDT', 'accounts', 5 * M, NOW - 10 * M, NOW, get, NOW);
  assert.ok(Math.abs(all.points[0]!.long - 16087 / (16087 + 15826)) < 1e-9, 'users holding long against short');
  assert.ok(get.asked[0]!.includes('contract=BTC_USDT') && get.asked[0]!.includes('interval=5m') && get.asked[0]!.includes(`from=${(NOW - 15 * M) / 1000}`), 'from the period before the window, in seconds');
  const top = await fetchLongShort('gateio', 'BTC_USDT', 'topAccounts', 5 * M, NOW - 10 * M, NOW, get, NOW);
  assert.ok(Math.abs(top.points[0]!.long - 47 / 122) < 1e-9, 'large holders by account: mostly short');
  const size = await fetchLongShort('gateio', 'BTC_USDT', 'topPositions', 5 * M, NOW - 10 * M, NOW, get, NOW);
  assert.ok(Math.abs(size.points[0]!.long - 32945851 / (32945851 + 26974856)) < 1e-9);
  const missing = fake({ 'https://api.gateio.ws/': () => ({ label: 'CONTRACT_NOT_FOUND' }) });
  await assert.rejects(fetchLongShort('gateio', 'NOPE_USDT', 'accounts', 5 * M, NOW - H, NOW, missing, NOW), LsNoMarket);
  const cache = new LongShortCache(missing, false, () => NOW);
  assert.equal((await cache.series('gateio:NOPE_USDT', 'accounts', 5 * M, NOW - H, NOW)).status, 'unsupported', 'not a failure to read');
  // Gate says so with a 400: `webGet` keeps the body on its error.
  const http400 = fake({ 'https://api.gateio.ws/': () => { throw Object.assign(new Error('HTTP 400'), { status: 400, body: '{"label":"CONTRACT_NOT_FOUND"}' }); } });
  await assert.rejects(fetchLongShort('gateio', 'NOPE_USDT', 'accounts', 5 * M, NOW - H, NOW, http400, NOW), LsNoMarket);
  const other400 = fake({ 'https://api.gateio.ws/': () => { throw Object.assign(new Error('HTTP 400'), { status: 400, body: '{"label":"INVALID_PARAM_VALUE"}' }); } });
  await assert.rejects(fetchLongShort('gateio', 'BTC_USDT', 'accounts', 5 * M, NOW - H, NOW, other400, NOW), (e: unknown) => !(e instanceof LsNoMarket), 'any other error is a failure');
});

test('Gate: a market listed after it was not is published once it answers; a full page that does not move on fails, never held as read', async () => {
  let now = NOW, listed = false;
  const row = (t: number) => ({ time: t / 1000, lsr_account: 1.5, long_users: 600, short_users: 400 });
  const get = fake({ 'https://api.gateio.ws/': url => listed ? [row(Number(url.searchParams.get('from')) * 1000)] : { label: 'CONTRACT_NOT_FOUND' } });
  const cache = new LongShortCache(get, false, () => now);
  assert.equal((await cache.series('gateio:NEW_USDT', 'accounts', 5 * M, NOW - H, NOW)).status, 'unsupported');
  listed = true; now += 2 * M;
  const after = await cache.series('gateio:NEW_USDT', 'accounts', 5 * M, NOW - H, now);
  assert.equal(after.status, 'ok', 'asked again after the minute, and published');
  // 1,000 readings asked; the venue gives the same 500 again and again.
  const same = Array.from({ length: 500 }, (_, i) => row(NOW - 1000 * 5 * M + i * 5 * M));
  const stuck = fake({ 'https://api.gateio.ws/': () => same });
  await assert.rejects(fetchLongShort('gateio', 'BTC_USDT', 'accounts', 5 * M, NOW - 1000 * 5 * M, NOW, stuck, NOW), /does not move on/);
  assert.equal(stuck.asked.length, 2, 'the second page shows it: no twelve requests');
  // One overflowing time in a full page ("1e400" is Infinity) moves nothing: the cursor follows the valid times and the window is read to
  // its end, so an older stretch of it is held, not answered empty unread.
  const pages = fake({ 'https://api.gateio.ws/': url => {
    const from = Number(url.searchParams.get('from')) * 1000;
    return Array.from({ length: 500 }, (_, i) => i === 250 ? { ...row(from + i * 5 * M), time: '1e400' } : row(from + i * 5 * M)).filter(r => r.time === '1e400' || Number(r.time) * 1000 < NOW);
  } });
  const held = new LongShortCache(pages, false, () => NOW);
  const whole = await held.series('gateio:BTC_USDT', 'accounts', 5 * M, NOW - 1000 * 5 * M, NOW);
  assert.equal(whole.status, 'ok');
  // Two full pages (one bad time each), then the short page at the live edge.
  assert.equal(pages.asked.length, 3, 'read on past the overflowing time');
  assert.ok(whole.points.length >= 997, `the whole window read (${whole.points.length})`);
  const older = await held.series('gateio:BTC_USDT', 'accounts', 5 * M, NOW - 700 * 5 * M, NOW - 600 * 5 * M);
  assert.equal(older.status, 'ok'); assert.equal(pages.asked.length, 3, 'held, not asked again');
});

test('Gate through the real fetcher: its 400 saying CONTRACT_NOT_FOUND is a market it does not list', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"label":"CONTRACT_NOT_FOUND"}', { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    await assert.rejects(fetchLongShort('gateio', 'NOPE_USDT', 'accounts', 5 * M, NOW - H, NOW, webGet, NOW), LsNoMarket);
  } finally { globalThis.fetch = real; }
});

test('the period of a window is what the cache reads it in: the chart\'s own, coarser for a long window, daily from 30 days', () => {
  const D = 24 * H;
  assert.equal(lsWindowPeriod('binance', H, NOW - 20 * D, NOW), H);
  assert.equal(lsWindowPeriod('binance', H, NOW - 30 * D, NOW), D);
  assert.equal(lsWindowPeriod('gateio', 15 * M, NOW - 20 * D, NOW), 15 * M, 'Gate keeps 2,000 readings a window like Binance: 20 days fit fifteen-minutely');
  assert.equal(lsWindowPeriod('bitget', 15 * M, NOW - 20 * D, NOW), 2 * H, 'Bitget, with 288 a window, takes two-hourly readings');
  assert.equal(lsWindowPeriod('hyperliquid', H, NOW - D, NOW), 0);
});

/** A venue whose answers wait until the test lets them go: `release()` answers every request asked so far. */
function gated(answer: (url: URL) => unknown): Fetcher & { asked: string[]; release(): void } {
  const asked: string[] = [], waiting: (() => void)[] = [];
  const get = (async (raw: string) => {
    asked.push(raw);
    await new Promise<void>(resolve => waiting.push(resolve));
    return answer(new URL(raw));
  }) as Fetcher & { asked: string[]; release(): void };
  get.asked = asked;
  get.release = () => { for (const go of waiting.splice(0)) go(); };
  return get;
}
const bybitRows = (times: number[]) => ({ retCode: 0, result: { list: times.map(t => ({ buyRatio: '0.6', sellRatio: '0.4', timestamp: String(t) })) } });
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('with a wait budget the cache answers at once with what it holds, pending, and the read goes on for the next question', async () => {
  // A busy server took longer than the pane's round to read a venue, and the pane drew it a minute later (2026-10-23).
  let now = NOW;
  const get = gated(() => bybitRows([NOW - 2 * H, NOW - H]));
  const cache = new LongShortCache(get, false, () => now);
  const started = Date.now(), first = await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H, 20);
  assert.ok(Date.now() - started < 1_000, 'within about the budget');
  assert.deepEqual([first.status, first.points.length, first.pending, get.asked.length], ['empty', 0, true, 1], 'nothing held yet: empty, still being read');
  const again = await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H, 20);
  assert.deepEqual([again.pending, get.asked.length], [true, 1], 'asked again while it reads: the same read, no second request');
  get.release(); await settle();
  const read = await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H, 20);
  assert.deepEqual([read.status, read.points.length, read.pending, get.asked.length], ['ok', 2, undefined, 1], 'the read it went on with');
  // The refresh of the newest stretch an hour on: what is held is answered at once, pending, and the new reading follows.
  now += H + M;
  const refresh = await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + 2 * H, 20);
  assert.deepEqual([refresh.status, refresh.points.length, refresh.pending, get.asked.length], ['ok', 2, true, 2], 'held readings at once, the refresh under way');
  get.release(); await settle();
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + 2 * H, 20)).pending, undefined);
});

test('a budget of nothing starts the read and answers at once; without a budget the question waits for the read, as before', async () => {
  const get = gated(() => bybitRows([NOW - H]));
  const cache = new LongShortCache(get, false, () => NOW);
  const now0 = await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H, 0);
  assert.deepEqual([now0.pending, get.asked.length], [true, 1], 'the read started, the answer at once');
  let waited = false;
  const full = cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H).then(s => { waited = true; return s; });
  await settle(); assert.equal(waited, false, 'no budget: it waits');
  get.release();
  const s = await full;
  assert.deepEqual([s.status, s.points.length, s.pending], ['ok', 1, undefined]);
});

test('a read that fails after the budget ran out is reported to the next question as failed, never as pending for good', async () => {
  let fail = true;
  const waiting: (() => void)[] = [];
  const get: Fetcher = async () => { await new Promise<void>(resolve => waiting.push(resolve)); if (fail) throw new Error('down'); return bybitRows([NOW - H]); };
  const cache = new LongShortCache(get, false, () => NOW);
  assert.equal((await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H, 10)).pending, true);
  for (const go of waiting.splice(0)) go(); await settle();
  const after = await cache.series('bybit:BTCUSDT', 'accounts', H, NOW - 24 * H, NOW + H, 10);
  assert.deepEqual([after.status, after.pending], ['failed', undefined], 'the failure, paused for a minute');
  fail = false;
});

test('over the wire: pending is kept only when it is true', () => {
  const base = { id: 'bybit:BTCUSDT', population: 'accounts', periodMs: H, status: 'ok', points: [{ t: NOW, long: 0.6 }] };
  assert.equal(parseLsSeries({ ...base, pending: true }).pending, true);
  assert.equal('pending' in parseLsSeries(base), false);
  assert.equal('pending' in parseLsSeries({ ...base, pending: 'yes' }), false);
});

test('the lines follow the OI pane\'s markets under Spot too, Gate\'s perpetual with them (spot markets have no long/short ratio)', () => {
  const market = (id: string, marketType: 'spot' | 'perpetual') => ({ id, instrumentId: id, venue: id.split(':')[0]!, marketType });
  const markets = [market('binance:BTCUSDT', 'perpetual'), market('binancespot:BTCUSDT', 'spot'), market('okx:BTC-USDT-SWAP', 'perpetual'), market('gateio:BTC_USDT', 'perpetual')];
  const hub = { flow: { ids: markets.map(m => m.instrumentId), get: () => ({ empty: false }), track: () => undefined } } as never;
  const base = { markets, disabledVenues: [] as string[], scope: 'all', levels: null, oiMarkets: 'all', customMarkets: { footprint: [], oi: [] }, oiInstrument: '', seriesInstrument: '', marketId: 'binance:BTCUSDT' };
  const both = lsIds(base as never, hub);
  assert.deepEqual(both, ['binance:BTCUSDT', 'okx:BTC-USDT-SWAP', 'gateio:BTC_USDT']);
  assert.deepEqual(lsIds({ ...base, scope: 'spot' } as never, hub), both, 'Spot: the same lines, Gate\'s included');
  assert.deepEqual(lsIds({ ...base, scope: 'spot', disabledVenues: ['gateio'] } as never, hub), ['binance:BTCUSDT', 'okx:BTC-USDT-SWAP'], 'Gate switched off stays out');
});
