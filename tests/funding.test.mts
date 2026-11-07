import test from 'node:test';
import assert from 'node:assert/strict';
import { FundingSource, buyerShare, fundingBase, fundingVenueOf, hasPremium, isFundingVenue, readFunding, readFundingNow, readPremium, rowAt } from '../src/app/funding.ts';
import type { Fetcher } from '../src/shared/history.ts';

const H = 3_600_000, T = Date.UTC(2026, 10, 6, 0);
const BTC = { symbol: 'BTCUSDT', unit: 1 };
/** A venue that answers each URL (and Hyperliquid's posted body) from a table, and counts what it was asked. */
function venue(answer: (url: string, body: unknown) => unknown): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  const get = (async (url: string, init?: { body?: string }) => { asked.push(url + (init?.body ? ` ${init.body}` : '')); return answer(url, init?.body ? JSON.parse(init.body) : undefined); }) as Fetcher & { asked: string[] };
  get.asked = asked;
  return get;
}

test('Hyperliquid: hourly funding put per eight hours, each record\'s premium the hour before it, oldest first', async () => {
  const get = venue((_url, body) => (body as { type: string }).type === 'fundingHistory'
    ? [{ coin: 'BTC', fundingRate: '0.0000125', premium: '-0.0001', time: T + H + 12 }, { coin: 'BTC', fundingRate: '0.00002', premium: '0.0006', time: T + 2 * H + 30 }]
    : null);
  const { rows, premium } = await readFunding('hyperliquid', { symbol: 'BTC', unit: 1 }, T, T + 3 * H, get);
  assert.deepEqual(rows.map(r => [r.t, r.rate, r.per8h, r.hours]), [[T + H, 0.0000125, 0.0001, 1], [T + 2 * H, 0.00002, 0.00016, 1]], 'stamped a few ms past the hour: put on the minute; ×8');
  assert.deepEqual(premium.map(q => [q.t, q.p]), [[T, -0.0001], [T + H, 0.0006]], 'the premium of the hour each record settles');
  assert.equal(get.asked.length, 1, 'fewer than 500 records: one page');
});

test('Binance pages forward from the start; its interval comes from fundingInfo (a symbol it does not list settles every eight hours)', async () => {
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ symbol: 'BTCUSDT', fundingTime: from + i * 8 * H + 1, fundingRate: '0.0001', markPrice: '75000' }));
  const get = venue(url => url.includes('fundingInfo') ? [{ symbol: 'GTCUSDT', fundingIntervalHours: 4 }]
    : url.includes(`startTime=${T}&`) ? page(T, 1000) : page(T + 1000 * 8 * H, 3));
  const { rows } = await readFunding('binance', BTC, T, T + 1003 * 8 * H, get);
  assert.equal(rows.length, 1003, 'a full page asks for the next, starting after the newest of the last');
  assert.ok(rows.every(r => r.hours === 8 && Math.abs(r.per8h - 0.0001) < 1e-12));
  assert.equal(get.asked.filter(u => u.includes('fundingRate?')).length, 2);
});

test('Bybit, OKX, Bitget and Deribit: newest first, back to the start; a venue settling every four hours doubles to eight', async () => {
  const bybit = venue(url => url.includes('instruments-info') ? { result: { list: [{ fundingInterval: 240 }] } }
    : { retCode: 0, result: { list: [{ fundingRate: '0.0001', fundingRateTimestamp: String(T + 8 * H) }, { fundingRate: '0.00005', fundingRateTimestamp: String(T + 4 * H) }] } });
  assert.deepEqual((await readFunding('bybit', BTC, T, T + 9 * H, bybit)).rows.map(r => [r.t, r.hours, r.per8h]), [[T + 4 * H, 4, 0.0001], [T + 8 * H, 4, 0.0002]]);
  const okx = venue(() => ({ code: '0', data: [{ fundingTime: String(T + 16 * H), realizedRate: '0.0002' }, { fundingTime: String(T + 8 * H), realizedRate: '0.0001' }] }));
  assert.deepEqual((await readFunding('okx', { symbol: 'BTC-USDT-SWAP', unit: 1 }, T, T + 17 * H, okx)).rows.map(r => [r.t, r.hours, r.per8h]), [[T + 8 * H, 8, 0.0001], [T + 16 * H, 8, 0.0002]], 'the interval read from the gap between settlements');
  const bitget = venue(url => url.includes('current-fund-rate') ? { data: [{ fundingRateInterval: '8' }] } : { data: [{ fundingRate: '0.000045', fundingTime: String(T + 8 * H) }] });
  assert.deepEqual((await readFunding('bitget', BTC, T, T + 9 * H, bitget)).rows.map(r => [r.t, r.per8h]), [[T + 8 * H, 0.000045]]);
  const deribit = venue(() => ({ result: [{ timestamp: T + H, interest_8h: 3.2e-5, interest_1h: 4e-6 }] }));
  assert.deepEqual((await readFunding('deribit', { symbol: 'BTC-PERPETUAL', unit: 1, inverse: true }, T, T + 2 * H, deribit)).rows.map(r => [r.t, r.rate, r.per8h, r.hours]), [[T + H, 4e-6, 3.2e-5, 1]], 'continuous: the eight-hour rate as it says');
});

test('the premium per candle (Binance, Bybit), the funding now, and what a malformed answer gives', async () => {
  const binance = venue(() => [[T, '-0.0004', '0', '-0.0007', '-0.00045', '0', T + H - 1], [T + H, '-0.0005', '0', '-0.0007', '-0.00053', '0', T + 2 * H - 1]]);
  assert.deepEqual(await readPremium('binance', BTC, H, T, T + 2 * H, binance), [{ t: T, p: -0.00045 }, { t: T + H, p: -0.00053 }]);
  assert.match(binance.asked[0]!, /premiumIndexKlines\?symbol=BTCUSDT&interval=1h/);
  const bybit = venue(() => ({ result: { list: [['' + (T + H), '0', '0', '0', '-0.0003'], ['' + T, '0', '0', '0', '-0.0004']] } }));
  assert.deepEqual(await readPremium('bybit', BTC, H, T, T + 2 * H, bybit), [{ t: T, p: -0.0004 }, { t: T + H, p: -0.0003 }], 'newest first, put oldest first');
  assert.deepEqual(await readPremium('okx', BTC, H, T, T + H, venue(() => [])), [], 'OKX publishes no premium history');
  const hl = venue(() => [{ universe: [{ name: 'ETH' }, { name: 'BTC' }] }, [{}, { funding: '0.0000125', premium: '-0.0002' }]]);
  assert.deepEqual(await readFundingNow('hyperliquid', { symbol: 'BTC', unit: 1 }, hl, T + 30 * 60_000), { rate: 0.0000125, per8h: 0.0001, hours: 1, next: T + H, premium: -0.0002 });
  const okx = venue(() => ({ data: [{ fundingRate: '0.00005', fundingTime: String(T + 8 * H), prevFundingTime: String(T), premium: '-0.00049' }] }));
  assert.deepEqual(await readFundingNow('okx', { symbol: 'BTC-USDT-SWAP', unit: 1 }, okx), { rate: 0.00005, per8h: 0.00005, hours: 8, next: T + 8 * H, premium: -0.00049 });
  assert.equal(await readFundingNow('binance', BTC, venue((url) => url.includes('fundingInfo') ? [] : { lastFundingRate: 'nope' })), null, 'a rate that is not a number is no reading');
  assert.deepEqual((await readFunding('bybit', BTC, T, T + H, venue(() => ({ retCode: 0, result: { list: [{ fundingRate: 'x', fundingRateTimestamp: 'y' }] } })))).rows, []);
});

test('the base rate and its band per venue; which venues have a premium line; the row an interval holds', () => {
  assert.deepEqual(fundingBase('binance'), { base: 0.0001, clamp: 0.0005 });
  assert.deepEqual(fundingBase('deribit'), { base: 0, clamp: 0 }, 'continuous, no base rate: no band drawn');
  assert.deepEqual(['hyperliquid', 'binance', 'bybit', 'okx', 'bitget', 'deribit'].map(v => hasPremium(v as never)), [true, true, true, false, false, false]);
  assert.deepEqual([isFundingVenue('okx'), isFundingVenue('gate'), isFundingVenue(3)], [true, false, false]);
  const rows = [{ t: T + 8 * H, rate: 1, per8h: 1, hours: 8 }, { t: T + 16 * H, rate: 2, per8h: 2, hours: 8 }];
  assert.equal(rowAt(rows, T + 3 * H)?.rate, 1, 'a settlement pays for the eight hours before it');
  assert.equal(rowAt(rows, T + 12 * H)?.rate, 2);
  assert.equal(rowAt(rows, T + 17 * H), null, 'after the newest: none settled yet');
  assert.equal(rowAt(rows, T - H), null);
});

test('a read says how far back it reached; an answer that says it failed fails the read; the venue shown, and the share buyers opened', async () => {
  // Bybit, paged back from now: eight full pages of a four-hour symbol reach 1,600 settlements back, not the 480 days asked for.
  const now = T + 1_000 * 24 * H;
  const page = (end: number) => ({ retCode: 0, result: { list: Array.from({ length: 200 }, (_, i) => ({ fundingRate: '0.0001', fundingRateTimestamp: String(Math.floor(end / (4 * H)) * 4 * H - i * 4 * H) })) } });
  const bybit = venue(url => url.includes('instruments-info') ? { result: { list: [{ fundingInterval: 240 }] } } : page(Number(/endTime=(\d+)/.exec(url)![1])));
  const read = await readFunding('bybit', BTC, now - 480 * 24 * H, now, bybit);
  assert.equal(read.rows.length, 1_600);
  assert.ok(read.from > now - 480 * 24 * H && Math.abs(read.from - read.rows[0]!.t) <= 4 * H, 'held from the oldest settlement read, not from the start asked for');
  // Hyperliquid paged forward: read from as far back as its pages reach from now, so the newest are always in.
  const hl = venue(() => []);
  assert.equal((await readFunding('hyperliquid', { symbol: 'BTC', unit: 1 }, now - 400 * 24 * H, now, hl)).from, now - 8 * 500 * H);
  await assert.rejects(readFunding('bybit', BTC, T, T + H, venue(url => url.includes('instruments-info') ? { result: { list: [{ fundingInterval: 480 }] } } : { retCode: 10001, retMsg: 'params error', result: {} })), /bybit-no-funding/);
  await assert.rejects(readFunding('okx', { symbol: 'X-USDT-SWAP', unit: 1 }, T, T + H, venue(() => ({ code: '51001', msg: 'Instrument ID does not exist', data: [] }))), /okx-no-funding/);
  await assert.rejects(readFunding('bitget', BTC, T, T + H, venue(() => { throw new Error('HTTP 451'); })), /HTTP 451/, 'a venue that does not answer fails the read');
  await assert.rejects(readFunding('bybit', { symbol: 'NEWUSDT', unit: 1 }, T, T + H, venue(() => { throw new Error('HTTP 403'); })), /HTTP 403/, 'an interval that cannot be read fails the read, not taken for eight hours');
  const listed = (v: string) => v !== 'hyperliquid';
  assert.deepEqual([fundingVenueOf('okx', listed), fundingVenueOf('hyperliquid', listed), fundingVenueOf('', () => true), fundingVenueOf('', () => false)], ['okx', 'binance', 'hyperliquid', null]);
  assert.deepEqual([buyerShare({ longOpened: 30, shortOpened: 10 }), buyerShare({ longOpened: 0, shortOpened: 0 })], [0.75, null]);
});

test('a settlement that is due is looked for soon after, again until it is in; a failed venue says so', async () => {
  let rows = [{ coin: 'BTC', fundingRate: '0.0000125', premium: '0', time: T + 12 * H }];
  const get = venue((_url, body) => (body as { type: string }).type === 'fundingHistory' ? rows : null);
  const source = new FundingSource(() => undefined, get), listing = { symbol: 'BTC', unit: 1 };
  source.view('hyperliquid', listing, H, T, T + 12 * H + 55 * 60_000, T + 12 * H + 55 * 60_000);
  await new Promise(r => setTimeout(r, 10));
  const reads = () => get.asked.filter(u => u.includes('fundingHistory')).length, first = reads();
  source.view('hyperliquid', listing, H, T, T + 13 * H, T + 13 * H + 5_000);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(reads(), first, 'five seconds after 13:00: not yet');
  rows = [...rows, { coin: 'BTC', fundingRate: '0.00002', premium: '0', time: T + 13 * H + 20 }];
  const after = source.view('hyperliquid', listing, H, T, T + 13 * H, T + 13 * H + 20_000);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(reads(), first + 1, 'fifteen seconds after: looked for'); assert.equal(after.rows.length, 1);
  assert.equal(source.view('hyperliquid', listing, H, T, T + 13 * H, T + 13 * H + 21_000).rows.length, 2, 'and in');
  const down = new FundingSource(() => undefined, venue(() => { throw new Error('HTTP 503'); }));
  down.view('binance', BTC, H, T, T + H, T + H);
  await new Promise(r => setTimeout(r, 10));
  const view = down.view('binance', BTC, H, T, T + H, T + H);
  assert.deepEqual([view.loading, view.failed], [false, true]);
});

test('the source reads what a view needs once, says when it lands, and reads the newest again only when it is old', async () => {
  let changes = 0;
  // The hour's record is in (it settled at 2:00) and the next is not due until 3:00.
  const get = venue((url, body) => body ? [{ coin: 'BTC', fundingRate: '0.0000125', premium: '0', time: T + 2 * H + 12 }] : url.includes('metaAndAssetCtxs') ? null : null);
  const source = new FundingSource(() => { changes++; }, get);
  const listing = { symbol: 'BTC', unit: 1 }, now = T + 2 * H + 10 * 60_000;
  const first = source.view('hyperliquid', listing, H, T, now, now);
  assert.equal(first.loading, true);
  await new Promise(r => setTimeout(r, 10));
  const second = source.view('hyperliquid', listing, H, T, now, now);
  assert.equal(second.loading, false); assert.equal(second.rows.length, 1); assert.ok(changes >= 1);
  const reads = get.asked.filter(u => u.includes('fundingHistory')).length;
  source.view('hyperliquid', listing, H, T, now, now + 60_000);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(get.asked.filter(u => u.includes('fundingHistory')).length, reads, 'a minute later: what is held stands');
});
