import test from 'node:test';
import assert from 'node:assert/strict';
import { FundingSource, buyerShare, continuousFunding, cutAt, fundingBase, fundingVenueOf, hasPremium, heldPremium, isFundingVenue, readFunding, readFundingNow, readPremium, rowAt } from '../src/app/funding.ts';
import { fundingCardLines, fundingShownAt } from '../src/app/panes/funding-pane.ts';
import type { Fetcher } from '../src/shared/history.ts';

const H = 3_600_000, T = Date.UTC(2026, 10, 6, 0);
const BTC = { symbol: 'BTCUSDT', unit: 1 };
/** What Binance charges for a premium page by the `limit` it asks (measured 2026-11-07): 1 up to 100 candles, 2 up to 500, 5 up to 1,000, 10 above. */
const binanceWeight = (limit: number): number => limit <= 100 ? 1 : limit <= 500 ? 2 : limit <= 1000 ? 5 : 10;
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

test('Binance pages back from now by endTime alone, 500 a page; its interval comes from fundingInfo (a symbol it does not list settles every eight hours)', async () => {
  // As Binance answers `endTime` alone: at most 500 settlements before it whatever `limit` asks (checked live 2026-11-07), oldest first.
  const all = Array.from({ length: 1003 }, (_, i) => ({ symbol: 'BTCUSDT', fundingTime: T + i * 8 * H + 1, fundingRate: '0.0001', markPrice: '75000' }));
  const get = venue(url => url.includes('fundingInfo') ? [{ symbol: 'GTCUSDT', fundingIntervalHours: 4 }] : all.filter(r => r.fundingTime <= Number(/endTime=(\d+)/.exec(url)![1])).slice(-500));
  const { rows, from } = await readFunding('binance', BTC, T, T + 1003 * 8 * H, get);
  assert.equal(rows.length, 1003, 'a full page of 500 asks for the one before it');
  assert.equal(from, T, 'it reached the start asked for');
  assert.ok(rows.every(r => r.hours === 8 && Math.abs(r.per8h - 0.0001) < 1e-12));
  const pages = get.asked.filter(u => u.includes('fundingRate?'));
  assert.equal(pages.length, 3); assert.ok(pages.every(u => !u.includes('startTime')), 'never from a start, which would read the oldest first');
  // A history longer than eight pages: the read says how far back it reached, not the start asked for.
  const long = Array.from({ length: 5_000 }, (_, i) => ({ symbol: 'BTCUSDT', fundingTime: T + i * 8 * H + 1, fundingRate: '0.0001' }));
  const deep = await readFunding('binance', BTC, T, T + 5_000 * 8 * H, venue(url => url.includes('fundingInfo') ? [] : long.filter(r => r.fundingTime <= Number(/endTime=(\d+)/.exec(url)![1])).slice(-500)));
  assert.equal(deep.rows.length, 4_000);
  assert.ok(deep.from > T + 900 * 8 * H, 'eight pages of 500 reach 4,000 settlements back');
});

test('a wide view in the past reads its premium a bounded number of times, the view itself first', async () => {
  // 9,000 one-minute candles ending a day back: more than one read holds with padding, so the padding gives way, never the view.
  const M = 60_000, now = T + 30 * 24 * H, t1 = now - 24 * H, t0 = t1 - 9_000 * M;
  const binance = venue(url => { if (!url.includes('premiumIndexKlines')) return url.includes('fundingRate') ? [] : url.includes('fundingInfo') ? [] : { lastFundingRate: '0.0001', nextFundingTime: now + H };
    const s = Number(/startTime=(\d+)/.exec(url)![1]), e = Number(/endTime=(\d+)/.exec(url)![1]); const out: unknown[] = []; for (let t = Math.ceil(s / M) * M, most = Math.min(1500, Number(/limit=(\d+)/.exec(url)![1])); t < e && out.length < most; t += M) out.push([t, '0', '0', '0', '-0.0001', '0', t + M - 1]); return out; });
  const source = new FundingSource(() => undefined, binance);
  for (let i = 0; i < 20; i++) { source.view('binance', BTC, M, t0, t1, now + i * 1_000); await new Promise(r => setTimeout(r, 5)); }
  const reads = binance.asked.filter(u => u.includes('premiumIndexKlines')).length;
  assert.ok(reads > 0 && reads <= 9, `one read of at most nine pages (eight and one for its margins), then nothing (${reads})`);
  // Wider than one read (8,000 candles): its newest 8,000 are held, up to its right edge.
  const view = source.view('binance', BTC, M, t0, t1, now + 21_000);
  assert.ok(view.premium.some(q => q.t >= t1 - M), 'held to its right edge');
  assert.ok(view.premium[0]!.t <= t1 - 7_998 * M && view.premium[0]!.t >= t1 - 8_001 * M, 'and from 8,000 candles back');
});

test('a past view that alone fills a read, dragged either way, reads only what it lacks half a view ahead; what is held stays bounded', async () => {
  // 10,000 one-minute candles ending fifty days back, dragged a candle at a time with every read landing in between (review round 4: each landing
  // read the view's whole 8,000 candles again, about a read every second candle dragged).
  const M = 60_000, now = T + 60 * 24 * H, width = 10_000 * M, pages = { binance: 0, bybit: 0 }, weight = { binance: 0, bybit: 0 };
  const get = venue(url => {
    const n = (name: string): number => Number(new RegExp(`[?&]${name}=(\\d+)`).exec(url)![1]);
    if (url.includes('premiumIndexKlines')) { pages.binance++; weight.binance += binanceWeight(n('limit')); const out: unknown[] = []; for (let t = Math.ceil(n('startTime') / M) * M; t <= n('endTime') && out.length < Math.min(1500, n('limit')); t += M) out.push([t, '0', '0', '0', '-0.0001', '0', t + M - 1]); return out; }
    if (url.includes('premium-index-price-kline')) { pages.bybit++; const list: unknown[] = []; for (let t = Math.floor(n('end') / M) * M; t >= n('start') && list.length < Math.min(1000, n('limit')); t -= M) list.push([String(t), '0', '0', '0', '-0.0001']); return { retCode: 0, result: { list } }; }
    if (url.includes('fundingInfo') || url.includes('fundingRate?')) return [];
    if (url.includes('premiumIndex?')) return { lastFundingRate: '0.0001', nextFundingTime: now + H };
    if (url.includes('instruments-info')) return { retCode: 0, result: { list: [{ fundingInterval: 480 }] } };
    if (url.includes('funding/history')) return { retCode: 0, result: { list: [] } };
    return { retCode: 0, result: { list: [{ fundingRate: '0.0001', nextFundingTime: String(now + H) }] } };
  });
  const land = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  for (const v of ['binance', 'bybit'] as const) {
    const source = new FundingSource(() => undefined, get);
    let t1 = now - 50 * 24 * H;
    const step = async (by: number): Promise<readonly { t: number }[]> => { t1 += by; source.view(v, BTC, M, t1 - width, t1, now); await land(); return source.view(v, BTC, M, t1 - width, t1, now).premium; };
    // Its newest 8,000 candles (Bybit's eight pages of 1,000 end a candle short of a window that counts both ends, as in the test before).
    const covers = (rows: readonly { t: number }[]): boolean => rows.some(q => q.t <= t1 - 7_998 * M) && rows.some(q => q.t >= t1);
    assert.ok(covers(await step(0)), `${v}: its newest 8,000 candles held`);
    const first = pages[v], firstWeight = weight.binance;
    let rows: readonly { t: number }[] = [];
    for (let i = 0; i < 600; i++) rows = await step(M);
    assert.ok(covers(rows), `${v}: dragged on, still held`);
    for (let i = 0; i < 1_200; i++) rows = await step(-M);
    assert.ok(covers(rows), `${v}: dragged back past where it started, still held`);
    // One read each way, about half a view each, in pages of 1,000 (a page more than measured, so a change of padding by a candle does not fail
    // it; the whole window read again at every landing would be thousands). Binance weighs a page by the candles it asks for.
    assert.ok(pages[v] - first <= 13, `${v}: ${pages[v] - first} pages for 1,800 candles dragged (at most 13; 12 measured)`);
    if (v === 'binance') assert.ok(weight.binance - firstWeight <= 57, `binance: weight ${weight.binance - firstWeight} for 1,800 candles dragged (52 measured; pages of 1,500 cost 80)`);
    // Dragged a long way either way, a read's worth at a time: what is held stays at most three reads' worth, around the view.
    for (const by of [2_000 * M, -2_000 * M]) for (let i = 0; i < 30; i++) {
      rows = await step(by);
      assert.ok(covers(rows) && rows.length <= 3 * 8_000 + 1, `${v}: ${rows.length} candles held after ${i + 1} steps of ${by / M}`);
    }
    // A view wholly after now (on the page's clock, so the newest end counts as fresh): the newest candles are read once, then nothing.
    const live = new FundingSource(() => undefined, get), clock = Math.floor(Date.now() / M) * M, before = pages[v];
    for (let i = 0; i < 10; i++) { live.view(v, BTC, M, clock + 1_000 * M, clock + 11_000 * M, clock); await land(); }
    const held = live.view(v, BTC, M, clock + 1_000 * M, clock + 11_000 * M, clock).premium;
    assert.ok(pages[v] - before <= 6 && held.some(q => q.t >= clock), `${v}: a view after now reads its newest once (${pages[v] - before} pages, 5 measured) and holds it`);
  }
});

test('a replay shows the settlements made and the premium candles closed by its moment, and no funding accruing now however near real time', () => {
  const data = {
    rows: [{ t: T + H, rate: 0.00001, per8h: 0.00008, hours: 1 }, { t: T + 2 * H, rate: 0.00002, per8h: 0.00016, hours: 1 }],
    premium: [{ t: T, p: 0.0001 }, { t: T + H, p: 0.0002 }], premiumMs: H,
    now: { rate: 0.00003, per8h: 0.00024, hours: 1, next: T + 3 * H, premium: 0.0003 },
  };
  // At 1:30 in a replay: the settlement at 1:00 is made; the premium candle of 1:00 has not closed (its value is its end); nothing accrues "now".
  const replay = fundingShownAt(data, T + 1.5 * H, true);
  assert.deepEqual([replay.rows.map(r => r.t), replay.premium.map(q => q.t), replay.forming], [[T + H], [T], null]);
  // At 2:00 the 1:00 candle has closed.
  assert.deepEqual(fundingShownAt(data, T + 2 * H, true).premium.map(q => q.t), [T, T + H]);
  // Live: the candle under way is drawn as it stands, and the funding accruing now is shown.
  const live = fundingShownAt(data, T + 1.5 * H, false);
  assert.deepEqual([live.premium.map(q => q.t), live.forming?.per8h], [[T, T + H], 0.00024]);
});

test('a null or blank figure is no figure: no funding row, no premium, no reading now; a real zero stays', async () => {
  const hl = venue((_url, body) => (body as { type: string }).type === 'fundingHistory'
    ? [{ coin: 'BTC', fundingRate: null, premium: null, time: T + H }, { coin: 'BTC', fundingRate: '0', premium: '', time: T + 2 * H }, { coin: 'BTC', fundingRate: '0.00001', premium: '0.0002', time: T + 3 * H }]
    : [{ universe: [{ name: 'BTC' }] }, [{ funding: null, premium: null }]]);
  const { rows, premium } = await readFunding('hyperliquid', { symbol: 'BTC', unit: 1 }, T, T + 4 * H, hl);
  assert.deepEqual(rows.map(r => [r.t, r.rate]), [[T + 2 * H, 0], [T + 3 * H, 0.00001]], 'null funding is no settlement; "0" is a settlement of zero');
  assert.deepEqual(premium.map(q => [q.t, q.p]), [[T + 2 * H, 0.0002]], 'a null or blank premium is none');
  assert.equal(await readFundingNow('hyperliquid', { symbol: 'BTC', unit: 1 }, hl, T + 30 * 60_000), null, 'null funding now is no reading');
  const binance = venue(() => [[T, '0', '0', '0', null, '0', T + H - 1], [T + H, '0', '0', '0', '-0.0005', '0', T + 2 * H - 1]]);
  assert.deepEqual((await readPremium('binance', BTC, H, T, T + 2 * H, binance)).rows, [{ t: T + H, p: -0.0005 }], 'a null candle close is no premium');
});

test('an hourly settlement missing from the answer is not a two-hour interval; a real change of interval still is one', async () => {
  // Hourly records ending at 1, 2, 4 and 5 (the one at 3 missing): the record at 4 is one hour's, its rate per eight hours not halved.
  const hourly = venue(url => url.includes('instruments-info') ? { result: { list: [{ fundingInterval: 60 }] } }
    : { retCode: 0, result: { list: [5, 4, 2, 1].map(h => ({ fundingRate: '0.0000125', fundingRateTimestamp: String(T + h * H) })) } });
  const { rows } = await readFunding('bybit', { symbol: 'GAP1USDT', unit: 1 }, T, T + 6 * H, hourly);
  assert.deepEqual(rows.map(r => [r.t, r.hours, r.per8h.toFixed(6)]), [1, 2, 4, 5].map(h => [T + h * H, 1, '0.000100']));
  // At the newest end a gap is read as it is until the next settlement lands: a real change from one hour to four there keeps its four
  // (the venue's interval now cannot stand for the gap after it). Each case its own symbol: intervals are cached.
  const newest = venue(url => url.includes('instruments-info') ? { result: { list: [{ fundingInterval: 60 }] } }
    : { retCode: 0, result: { list: [16, 12, 11].map(h => ({ fundingRate: '0.0001', fundingRateTimestamp: String(T + h * H) })) } });
  assert.deepEqual((await readFunding('bybit', { symbol: 'GAP2USDT', unit: 1 }, T, T + 17 * H, newest)).rows.map(r => r.hours), [1, 1, 4]);
  // Every four hours with one settlement missing: still four hours, not eight.
  const four = venue(url => url.includes('instruments-info') ? { result: { list: [{ fundingInterval: 240 }] } }
    : { retCode: 0, result: { list: [16, 12, 4, 0].map(h => ({ fundingRate: '0.0001', fundingRateTimestamp: String(T + 8 * H + h * H) })) } });
  assert.deepEqual((await readFunding('bybit', { symbol: 'GAP3USDT', unit: 1 }, T, T + 30 * H, four)).rows.map(r => r.hours), [4, 4, 4, 4]);
  // A real change from four hours to one: the record that ends the last four-hour interval keeps its four.
  const change = venue(url => url.includes('instruments-info') ? { result: { list: [{ fundingInterval: 60 }] } }
    : { retCode: 0, result: { list: [10, 9, 8, 4, 0].map(h => ({ fundingRate: '0.0001', fundingRateTimestamp: String(T + 8 * H + h * H) })) } });
  assert.deepEqual((await readFunding('bybit', { symbol: 'GAP4USDT', unit: 1 }, T, T + 30 * H, change)).rows.map(r => r.hours), [4, 4, 4, 1, 1]);
  // The same settlement twice in one answer counts once (counted twice, the gaps around it read 0 and the next gap 2 h); a null retCode is no failure.
  const twice = venue(url => url.includes('instruments-info') ? { result: { list: [{ fundingInterval: 60 }] } }
    : { retCode: null, result: { list: [6, 5, 3, 3, 2, 1].map(h => ({ fundingRate: '0.0000125', fundingRateTimestamp: String(T + h * H) })) } });
  assert.deepEqual((await readFunding('bybit', { symbol: 'GAP5USDT', unit: 1 }, T, T + 7 * H, twice)).rows.map(r => r.hours), [1, 1, 1, 1, 1]);
});

test('each settlement at its own interval: a symbol that settled every hour before every four is not read four times too low', async () => {
  const times = [...Array.from({ length: 10 }, (_, i) => T + i * H), ...Array.from({ length: 5 }, (_, i) => T + 13 * H + i * 4 * H)];
  const bybit = venue(url => url.includes('instruments-info') ? { result: { list: [{ fundingInterval: 240 }] } }
    : { retCode: 0, result: { list: [...times].reverse().map(t => ({ fundingRate: '0.0000125', fundingRateTimestamp: String(t) })) } });
  const { rows } = await readFunding('bybit', { symbol: 'LPTUSDT', unit: 1 }, T - H, T + 40 * H, bybit);
  assert.equal(rows.length, 15);
  assert.deepEqual(rows.slice(0, 10).map(r => [r.hours, r.per8h.toFixed(6)]), Array.from({ length: 10 }, () => [1, '0.000100']), 'hourly: ×8');
  assert.deepEqual(rows.slice(10).map(r => [r.hours, r.per8h.toFixed(6)]), Array.from({ length: 5 }, () => [4, '0.000025']), 'every four hours: ×2');
});

test('a premium read says what it reached when its pages run out, forward (Binance) and back (Bybit)', async () => {
  const M = 60_000;
  // As Binance answers: the candles from the first whole minute at or after `startTime`.
  const binance = venue(url => { const s = Number(/startTime=(\d+)/.exec(url)![1]), e = Number(/endTime=(\d+)/.exec(url)![1]); const out: unknown[] = []; for (let t = Math.ceil(s / M) * M, most = Math.min(1500, Number(/limit=(\d+)/.exec(url)![1])); t < e && out.length < most; t += M) out.push([t, '0', '0', '0', '-0.0001', '0', t + M - 1]); return out; });
  const forward = await readPremium('binance', BTC, M, T, T + 20_000 * M, binance);
  assert.equal(forward.rows.length, 9_000, 'nine pages of 1,000 (eight asked for and one for a read\'s margins)');
  assert.equal(forward.from, T); assert.ok(forward.to > T + 8_999 * M && forward.to <= T + 9_000 * M, 'it ends where its pages ended, not at the end asked for');
  assert.equal(forward.cut, false, 'pages that ran out are no failure');
  assert.ok(binance.asked.every(u => u.includes('&limit=1000')), 'never a page of 1,500: Binance weighs it twice a page of 1,000');
  const bybit = venue(url => { const e = Number(/end=(\d+)/.exec(url)![1]), out: unknown[] = []; for (let t = Math.floor(e / M) * M, most = Math.min(1000, Number(/limit=(\d+)/.exec(url)![1])); out.length < most; t -= M) out.push([String(t), '0', '0', '0', '-0.0002']); return { retCode: 0, result: { list: out } }; });
  const back = await readPremium('bybit', BTC, M, T, T + 20_000 * M, bybit);
  assert.equal(back.rows.length, 9_000);
  assert.equal(back.to, T + 20_000 * M); assert.ok(back.from > T + 11_000 * M, 'it starts where its eight pages ended');
  const whole = await readPremium('binance', BTC, M, T, T + 600 * M, binance);
  assert.deepEqual([whole.from, whole.to, whole.rows.length], [T, T + 600 * M, 600], 'read whole: the stretch asked for');
  assert.match(binance.asked.at(-1)!, /&limit=601$/, 'one page, asking for the 601 candle starts in the stretch (both ends count)');
});

test('a premium page asks for the candles its stretch holds and no more; a page that fails after the first keeps what the ones before it read', async () => {
  // Review round 5: every page asked Binance for 1,500 whatever the stretch held, and one failed page threw away the pages before it.
  const M = 60_000, limits = (get: { asked: string[] }): number[] => get.asked.map(u => Number(/limit=(\d+)/.exec(u)![1]));
  const n = (url: string, name: string): number => Number(new RegExp(`[?&]${name}=(\\d+)`).exec(url)![1]);
  // As the venues answer: Binance the candles from `startTime` to `endTime` oldest first, Bybit from `end` back to `start`, both ends counted,
  // at most `limit`; the page numbered `fail` (from 0) answers 503.
  const binance = (fail = -1): Fetcher & { asked: string[] } => { const get = venue(url => {
    if (get.asked.length - 1 === fail) throw Object.assign(new Error('HTTP 503'), { status: 503 });
    const out: unknown[] = []; for (let t = Math.ceil(n(url, 'startTime') / M) * M; t <= n(url, 'endTime') && out.length < n(url, 'limit'); t += M) out.push([t, '0', '0', '0', '-0.0001', '0', t + M - 1]); return out;
  }); return get; };
  const bybit = (fail = -1): Fetcher & { asked: string[] } => { const get = venue(url => {
    if (get.asked.length - 1 === fail) throw Object.assign(new Error('HTTP 503'), { status: 503 });
    const list: unknown[] = []; for (let t = Math.floor(n(url, 'end') / M) * M; t >= n(url, 'start') && list.length < n(url, 'limit'); t -= M) list.push([String(t), '0', '0', '0', '-0.0001']); return { retCode: 0, result: { list } };
  }); return get; };
  // Fifty candles from half a minute in: one page of 50, and none after the one holding the last candle the stretch can have.
  const small = binance(), few = await readPremium('binance', BTC, M, T + 30_000, T + 30_000 + 50 * M, small);
  assert.deepEqual([limits(small), few.rows.length, few.from, few.to], [[50], 50, T + 30_000, T + 30_000 + 50 * M]);
  const smallBack = bybit(), fewBack = await readPremium('bybit', BTC, M, T + 30_000, T + 30_000 + 50 * M, smallBack);
  assert.deepEqual([limits(smallBack), fewBack.rows.length, fewBack.from, fewBack.to], [[50], 50, T + 30_000, T + 30_000 + 50 * M], 'back: none after the one holding the first candle there can be');
  // 2,500 candles: pages of 1,000, 1,000 and the 500 left, either way.
  const wide = binance(), forward = await readPremium('binance', BTC, M, T, T + 2_499 * M, wide);
  assert.deepEqual([limits(wide), forward.rows.length, forward.from, forward.to], [[1000, 1000, 500], 2_500, T, T + 2_499 * M]);
  const wideBack = bybit(), back = await readPremium('bybit', BTC, M, T, T + 2_499 * M, wideBack);
  assert.deepEqual([limits(wideBack), back.rows.length, back.from, back.to], [[1000, 1000, 500], 2_500, T, T + 2_499 * M]);
  // The second page fails: the first page's candles are kept, and the stretch ends where they end.
  const cut = await readPremium('binance', BTC, M, T, T + 2_499 * M, binance(1));
  assert.deepEqual([cut.rows.length, cut.from, cut.to, cut.rows.at(-1)!.t, cut.cut], [1_000, T, T + 999 * M + 1, T + 999 * M, true], 'forward: to just past its newest candle, said to be cut');
  const cutBack = await readPremium('bybit', BTC, M, T, T + 2_499 * M, bybit(1));
  assert.deepEqual([cutBack.rows.length, cutBack.from, cutBack.to, cutBack.rows[0]!.t, cutBack.cut], [1_000, T + 1_500 * M - 1, T + 2_499 * M, T + 1_500 * M, true], 'back: from just before its oldest');
  assert.deepEqual([forward.cut, back.cut], [false, false], 'read whole: not cut');
  // The first page fails: the read fails (asked again a minute later), nothing claimed.
  await assert.rejects(readPremium('binance', BTC, M, T, T + 2_499 * M, binance(0)));
  await assert.rejects(readPremium('bybit', BTC, M, T, T + 2_499 * M, bybit(0)));
});

test('a premium read joins what is held only where the two stretches meet, and what is held is cut at the end away from the read', () => {
  const M = 60_000, candles = (a: number, b: number): { t: number; p: number }[] => Array.from({ length: b - a + 1 }, (_, i) => ({ t: T + (a + i) * M, p: 0 }));
  // Held from 5 s into candle 10 (so from candle 11) through candle 20.
  const held = { rows: candles(11, 20), from: T + 10 * M + 5_000, to: T + 20 * M, at: 0 };
  // Read through candle 9, ending a candle short of what is held: candle 10 is in neither (review round 5: a candle's slack joined them and
  // claimed it). It stands alone, in place of what was held.
  const short = heldPremium(held, { rows: candles(0, 9), from: T, to: T + 9 * M + 5_000 }, M, T + 100 * M);
  assert.deepEqual([short.from, short.to, short.rows.length], [T, T + 9 * M + 5_000, 10]);
  // Read through candle 11, into what is held: one stretch, every candle in it.
  const joined = heldPremium(held, { rows: candles(0, 11), from: T, to: T + 11 * M }, M, T + 100 * M);
  assert.deepEqual([joined.from, joined.to, joined.rows.length], [T, T + 20 * M, 21]);
  assert.ok(joined.rows.every((q, i) => q.t === T + i * M), 'no candle missing');
  // Ending exactly where what is held begins (both count the candle starting there): they meet, one stretch.
  const touching = heldPremium({ rows: candles(10, 20), from: T + 10 * M, to: T + 20 * M, at: 0 }, { rows: candles(0, 10), from: T, to: T + 10 * M }, M, T + 100 * M);
  assert.deepEqual([touching.from, touching.to, touching.rows.length], [T, T + 20 * M, 21]);
  // Three reads' worth (24,000 candles) held at most: a read on the newer side lets the oldest go, one on the older side the newest.
  const full = { rows: candles(0, 23_999), from: T, to: T + 23_999 * M, at: 0 };
  const newer = heldPremium(full, { rows: candles(23_990, 24_999), from: T + 23_990 * M, to: T + 24_999 * M }, M, T + 100_000 * M);
  assert.deepEqual([newer.from, newer.to, newer.rows[0]!.t, newer.rows.length], [T + 999 * M, T + 24_999 * M, T + 999 * M, 24_001]);
  // Cut through its new end, as it is claimed: the candle starting there is kept (review round 6: it was let go and still claimed).
  const older = heldPremium(full, { rows: candles(-1_000, 10), from: T - 1_000 * M, to: T + 10 * M }, M, T + 100_000 * M);
  assert.deepEqual([older.from, older.to, older.rows.at(-1)!.t, older.rows.length], [T - 1_000 * M, T + 23_000 * M, T + 23_000 * M, 24_001]);
});

test('a premium read cut short by a failed page keeps what it read and waits before asking again; a view a read\'s width further back joins what is held', async () => {
  const M = 60_000, now = T + 60 * 24 * H;
  const n = (url: string, name: string): number => Number(new RegExp(`[?&]${name}=(\\d+)`).exec(url)![1]);
  // Review round 6: a later page that failed made the read a success, asked again at once (after a 429, the very next request).
  let failNext = -1, pages = 0;
  const get = venue(url => {
    if (!url.includes('premiumIndexKlines')) return url.includes('premiumIndex?') ? { lastFundingRate: '0.0001', nextFundingTime: now + H } : [];
    if (pages++ === failNext) throw Object.assign(new Error('HTTP 429'), { status: 429 });
    const out: unknown[] = []; for (let t = Math.ceil(n(url, 'startTime') / M) * M; t <= n(url, 'endTime') && out.length < n(url, 'limit'); t += M) out.push([t, '0', '0', '0', '-0.0001', '0', t + M - 1]); return out;
  });
  const land = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const source = new FundingSource(() => undefined, get), t1 = now - 20 * 24 * H, t0 = t1 - 3_000 * M;
  failNext = 1;
  source.view('binance', BTC, M, t0, t1, now); await land();
  const kept = source.view('binance', BTC, M, t0, t1, now).premium, after = pages;
  assert.equal(kept.length, 1_000, 'the first page\'s candles are held');
  for (let i = 0; i < 20; i++) { source.view('binance', BTC, M, t0, t1, now); await land(); }
  assert.equal(pages, after, 'and nothing is asked again before the retry is due');
  // Review round 6: a read asked a few candles past what eight pages hold (the view, its margins and the candle it shares with what is held);
  // Binance, paging from the far end, stopped short of what was held and replaced it. A view of 8,000 candles, off the minute, moved its own
  // width back: the read joins what is held, and moved forward again, nothing is read.
  const wide = new FundingSource(() => undefined, get), right = now - 20 * 24 * H + 30_000, w = 8_000 * M;
  wide.view('binance', BTC, M, right - w, right, now); await land();
  wide.view('binance', BTC, M, right - 2 * w, right - w, now); await land();
  // Both views held as one stretch with no candle missing (the oldest view's partial first candle gives way to the read's budget).
  const both = wide.view('binance', BTC, M, right - 2 * w, right - w, now).premium, first = both[0]!.t, last = both.at(-1)!.t;
  assert.ok(first <= right - 2 * w + 2 * M && last >= right - M && both.length === (last - first) / M + 1, `${both.length} candles held, from ${(first - right) / M} to ${(last - right) / M} min`);
  const back = pages;
  wide.view('binance', BTC, M, right - w, right, now); await land();
  assert.equal(pages, back, 'back where it was: nothing read');
});

test('a read a failed page cuts short: next to what is held, kept apart where it does not reach it and joined where it does; a jump\'s or a live view\'s newest end takes its place', async () => {
  // Review round 7: Binance on a read to the left and Bybit on one to the right page from the far end, and their first page lies in the
  // look-ahead; the second failing, that fragment replaced the stretch drawn and the pane drew no premium for a minute. Round 8: a live view
  // read again after a pause is the opposite case on Bybit, newest first, whose fragment is the live edge.
  const M = 60_000, now = T + 60 * 24 * H, w = 4_000 * M, p = now - 20 * 24 * H, clock = Math.floor(Date.now() / M) * M;
  const n = (url: string, name: string): number => Number(new RegExp(`[?&]${name}=(\\d+)`).exec(url)![1]);
  let pages = 0, failAt = -1;
  const get = venue(url => {
    const premium = url.includes('premiumIndexKlines') || url.includes('premium-index-price-kline');
    if (premium && pages++ === failAt) throw Object.assign(new Error('HTTP 503'), { status: 503 });
    if (url.includes('premiumIndexKlines')) { const out: unknown[] = []; for (let t = Math.ceil(n(url, 'startTime') / M) * M; t <= n(url, 'endTime') && out.length < n(url, 'limit'); t += M) out.push([t, '0', '0', '0', '-0.0001', '0', t + M - 1]); return out; }
    if (url.includes('premium-index-price-kline')) { const list: unknown[] = []; for (let t = Math.floor(n(url, 'end') / M) * M; t >= n(url, 'start') && list.length < n(url, 'limit'); t -= M) list.push([String(t), '0', '0', '0', '-0.0001']); return { retCode: 0, result: { list } }; }
    if (url.includes('fundingInfo') || url.includes('fundingRate?')) return [];
    if (url.includes('premiumIndex?')) return { lastFundingRate: '0.0001', nextFundingTime: now + H };
    if (url.includes('instruments-info')) return { retCode: 0, result: { list: [{ fundingInterval: 480 }] } };
    if (url.includes('funding/history')) return { retCode: 0, result: { list: [] } };
    return { retCode: 0, result: { list: [{ fundingRate: '0.0001', nextFundingTime: String(now + H) }] } };
  });
  const land = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  // Each case: a first view, read whole; then the view the read cut short is for, its second page failing; and what is held after it.
  type View = readonly [t0: number, t1: number, now: number];
  const cases: readonly { what: string; v: 'binance' | 'bybit'; first: View; then: View; held: 'kept' | 'joined' | 'replaced' }[] = [
    { what: 'moved left, Binance reading from the far end', v: 'binance', first: [p - w, p, now], then: [p - w - 3_000 * M, p - 3_000 * M, now], held: 'kept' },
    { what: 'moved right, Bybit reading from the far end', v: 'bybit', first: [p - w, p, now], then: [p - w + 3_000 * M, p + 3_000 * M, now], held: 'kept' },
    { what: 'moved left, Bybit reading from what is held', v: 'bybit', first: [p - w, p, now], then: [p - w - 3_000 * M, p - 3_000 * M, now], held: 'joined' },
    { what: 'moved right, Binance reading from what is held', v: 'binance', first: [p - w, p, now], then: [p - w + 3_000 * M, p + 3_000 * M, now], held: 'joined' },
    { what: 'zoomed out past both sides, Binance', v: 'binance', first: [p - 500 * M, p, now], then: [p - 2_250 * M, p + 2_000 * M, now], held: 'kept' },
    { what: 'zoomed out past both sides, Bybit', v: 'bybit', first: [p - 500 * M, p, now], then: [p - 2_250 * M, p + 2_000 * M, now], held: 'kept' },
    { what: 'a jump far back', v: 'binance', first: [p - w, p, now], then: [p - 50_000 * M - w, p - 50_000 * M, now], held: 'replaced' },
    { what: 'a live view after 20 hours, Bybit reading its newest first', v: 'bybit', first: [clock - 2_000 * M, clock, clock], then: [clock - 800 * M, clock + 1_200 * M, clock + 1_200 * M], held: 'replaced' },
    { what: 'a live view after 20 hours, Binance reading on from what is held', v: 'binance', first: [clock - 2_000 * M, clock, clock], then: [clock - 800 * M, clock + 1_200 * M, clock + 1_200 * M], held: 'joined' },
  ];
  for (const c of cases) {
    const source = new FundingSource(() => undefined, get), show = (view: View) => source.view(c.v, BTC, M, view[0], view[1], view[2]).premium;
    show(c.first); await land();
    const before = show(c.first);
    failAt = pages + 1;
    show(c.then); await land();
    const after = show(c.then), asked = pages, [t0, t1, at] = c.then;
    if (c.held === 'kept') {
      assert.deepEqual([after.length, after[0]?.t, after.at(-1)?.t], [before.length, before[0]!.t, before.at(-1)!.t], `${c.what}: what was held stays`);
      if (before.some(q => q.t >= t0 && q.t <= t1)) assert.ok(after.some(q => q.t >= t0 && q.t <= t1), `${c.what}: drawn where the views overlap`);
    } else if (c.held === 'joined') {
      assert.ok(after.length > before.length && after[0]!.t <= before[0]!.t && after.at(-1)!.t >= before.at(-1)!.t, `${c.what}: joined (${before.length} -> ${after.length})`);
    } else {
      assert.ok(after.length > 0 && !after.some(q => q.t === before[0]!.t), `${c.what}: in place of what was held`);
      if (at - t1 < M) assert.ok(after.at(-1)!.t >= at - M, `${c.what}: the live edge held`);
    }
    for (let i = 0; i < 10; i++) { show(c.then); await land(); }
    assert.equal(pages, asked, `${c.what}: the rest is asked after the wait, not at once`);
  }
});

test('a narrow view dragged fast reads its premium a page ahead, so Binance\'s weight stays small; zoomed out past both sides, one read for both', async () => {
  // Review round 5: a 50-candle view asked again every 25 candles dragged, each a page of 1,500 (weight 10): flicked at 300 candles a second,
  // about 78 of the 2,400 Binance allows a minute every second.
  const M = 60_000, now = T + 60 * 24 * H, width = 50 * M;
  // `reads`: pages that start a read (a page that goes on from the one before starts a millisecond past that one's newest candle).
  let weight = 0, pages = 0, reads = 0;
  const get = venue(url => {
    if (!url.includes('premiumIndexKlines')) return url.includes('premiumIndex?') ? { lastFundingRate: '0.0001', nextFundingTime: now + H } : [];
    const n = (name: string): number => Number(new RegExp(`[?&]${name}=(\\d+)`).exec(url)![1]);
    pages++; weight += binanceWeight(n('limit')); if (n('startTime') % M !== 1) reads++;
    const out: unknown[] = []; for (let t = Math.ceil(n('startTime') / M) * M; t <= n('endTime') && out.length < n('limit'); t += M) out.push([t, '0', '0', '0', '-0.0001', '0', t + M - 1]); return out;
  });
  const land = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const source = new FundingSource(() => undefined, get);
  let t1 = now - 20 * 24 * H, t0 = t1 - width;
  const held = (): readonly { t: number }[] => source.view('binance', BTC, M, t0, t1, now).premium;
  const covers = (rows: readonly { t: number }[]): boolean => rows.some(q => q.t <= t0) && rows.some(q => q.t >= t1);
  // Dragged 3,000 candles on, then 6,000 back, a candle at a time, every read landing in between.
  for (const [by, steps] of [[M, 3_000], [-M, 6_000]] as const) for (let i = 0; i < steps; i++) {
    t1 += by; t0 += by; held(); await land();
    if (!covers(held())) assert.fail(`not held after ${i + 1} steps of ${by / M}`);
  }
  assert.ok(weight <= 43 && pages <= 14, `weight ${weight} in ${pages} pages for 9,000 candles dragged (38 in 13 measured; a page of 1,500 every 25 candles: about 3,600)`);
  // A jump to a narrow view reads it and half a view each side, one small page: the page's worth ahead is for the reads next to what is held
  // (review round 6: a first read of a page each side cost three requests and twenty or thirty times the candles).
  const jump = new FundingSource(() => undefined, get), firstPage = get.asked.length;
  t1 = now - 25 * 24 * H; t0 = t1 - width;
  jump.view('binance', BTC, M, t0, t1, now); await land();
  const jumped = get.asked.slice(firstPage).filter(u => u.includes('premiumIndexKlines')).map(u => Number(/limit=(\d+)/.exec(u)![1]));
  assert.ok(jumped.length === 1 && jumped[0]! <= 110, `one page of the view and its margins (${jumped.join(', ')}; 103 measured, a page each side read about 2,100)`);
  // From a narrow view, zoomed out past what is held on both sides: one read reaches both, and joins what is held.
  const zoom = new FundingSource(() => undefined, get);
  t1 = now - 20 * 24 * H; t0 = t1 - width;
  zoom.view('binance', BTC, M, t0, t1, now); await land();
  const before = reads;
  t0 = t1 - 4_000 * M; t1 += 3_000 * M;
  zoom.view('binance', BTC, M, t0, t1, now); await land();
  const rows = zoom.view('binance', BTC, M, t0, t1, now).premium;
  assert.deepEqual([covers(rows), reads - before], [true, 1], 'one read for both sides, the whole view held');
  const after = pages;
  zoom.view('binance', BTC, M, t0, t1, now); await land();
  assert.equal(pages, after, 'and nothing after');
});

test('Bybit, OKX, Bitget and Deribit: newest first, back to the start; a venue settling every four hours doubles to eight', async () => {
  const bybit = venue(url => url.includes('instruments-info') ? { result: { list: [{ fundingInterval: 240 }] } }
    : { retCode: 0, result: { list: [{ fundingRate: '0.0001', fundingRateTimestamp: String(T + 8 * H) }, { fundingRate: '0.00005', fundingRateTimestamp: String(T + 4 * H) }] } });
  assert.deepEqual((await readFunding('bybit', BTC, T, T + 9 * H, bybit)).rows.map(r => [r.t, r.hours, r.per8h]), [[T + 4 * H, 4, 0.0001], [T + 8 * H, 4, 0.0002]]);
  const okx = venue(() => ({ code: '0', data: [{ fundingTime: String(T + 16 * H), realizedRate: '0.0002' }, { fundingTime: String(T + 8 * H), realizedRate: '0.0001' }] }));
  assert.deepEqual((await readFunding('okx', { symbol: 'BTC-USDT-SWAP', unit: 1 }, T, T + 17 * H, okx)).rows.map(r => [r.t, r.hours, r.per8h]), [[T + 8 * H, 8, 0.0001], [T + 16 * H, 8, 0.0002]], 'the interval read from the gap between settlements');
  const bitget = venue(url => url.includes('current-fund-rate') ? { data: [{ fundingRateInterval: '8' }] } : { data: [{ fundingRate: '0.000045', fundingTime: String(T + 8 * H) }] });
  assert.deepEqual((await readFunding('bitget', BTC, T, T + 9 * H, bitget)).rows.map(r => [r.t, r.per8h]), [[T + 8 * H, 0.000045]]);
  // `interest_8h` is the sum of the last eight hours', here unlike eight times the hour's own: it must not be what is drawn.
  const deribit = venue(() => ({ result: [{ timestamp: T + H, interest_8h: 9e-5, interest_1h: 4e-6 }, { timestamp: T + 2 * H, interest_8h: 8e-5 }] }));
  assert.deepEqual((await readFunding('deribit', { symbol: 'BTC-PERPETUAL', unit: 1, inverse: true }, T, T + 3 * H, deribit)).rows.map(r => [r.t, r.rate, r.per8h, r.hours]), [[T + H, 4e-6, 3.2e-5, 1]], 'continuous: what the hour paid, times eight; an hour that does not say what it paid is no row, whatever its running total');
});

test('the premium per candle (Binance, Bybit), the funding now, and what a malformed answer gives', async () => {
  const binance = venue(() => [[T, '-0.0004', '0', '-0.0007', '-0.00045', '0', T + H - 1], [T + H, '-0.0005', '0', '-0.0007', '-0.00053', '0', T + 2 * H - 1]]);
  assert.deepEqual((await readPremium('binance', BTC, H, T, T + 2 * H, binance)).rows, [{ t: T, p: -0.00045 }, { t: T + H, p: -0.00053 }]);
  assert.match(binance.asked[0]!, /premiumIndexKlines\?symbol=BTCUSDT&interval=1h/);
  const bybit = venue(() => ({ result: { list: [['' + (T + H), '0', '0', '0', '-0.0003'], ['' + T, '0', '0', '0', '-0.0004']] } }));
  assert.deepEqual((await readPremium('bybit', BTC, H, T, T + 2 * H, bybit)).rows, [{ t: T, p: -0.0004 }, { t: T + H, p: -0.0003 }], 'newest first, put oldest first');
  assert.deepEqual((await readPremium('okx', BTC, H, T, T + H, venue(() => []))).rows, [], 'OKX publishes no premium history');
  const hl = venue(() => [{ universe: [{ name: 'ETH' }, { name: 'BTC' }] }, [{}, { funding: '0.0000125', premium: '-0.0002' }]]);
  assert.deepEqual(await readFundingNow('hyperliquid', { symbol: 'BTC', unit: 1 }, hl, T + 30 * 60_000), { rate: 0.0000125, per8h: 0.0001, hours: 1, next: T + H, premium: -0.0002 });
  const okx = venue(() => ({ data: [{ fundingRate: '0.00005', fundingTime: String(T + 8 * H), prevFundingTime: String(T), premium: '-0.00049' }] }));
  assert.deepEqual(await readFundingNow('okx', { symbol: 'BTC-USDT-SWAP', unit: 1 }, okx), { rate: 0.00005, per8h: 0.00005, hours: 8, next: T + 8 * H, premium: -0.00049 });
  assert.equal(await readFundingNow('binance', BTC, venue((url) => url.includes('fundingInfo') ? [] : { lastFundingRate: 'nope' })), null, 'a rate that is not a number is no reading');
  assert.deepEqual((await readFunding('bybit', BTC, T, T + H, venue(() => ({ retCode: 0, result: { list: [{ fundingRate: 'x', fundingRateTimestamp: 'y' }] } })))).rows, []);
});

test('Deribit now: what the hour\'s finished blocks paid; the rate of the moment before the first has landed and where that read fails', async () => {
  const ETH = { symbol: 'ETH-PERPETUAL', unit: 1, inverse: true }, MIN = 60_000, TICKER = { current_funding: 0.000037, mark_price: 2234.31, index_price: 2233.67 };
  const near = (a: number | null | undefined, b: number, what: string): void => assert.ok(a !== null && a !== undefined && Math.abs(a - b) < 1e-12, `${what}: ${a} against ${b}`);
  const deribit = (paid: unknown, result: unknown = TICKER) => venue(url => { if (!url.includes('get_funding_rate_value')) return { result }; if (paid instanceof Error) throw paid; return { result: paid }; });
  const half = deribit(2e-6), now = await readFundingNow('deribit', ETH, half, T + 31 * MIN);
  near(now?.rate, 4e-6, 'six blocks in, having paid 2e-6: 4e-6 an hour');
  near(now?.per8h, 3.2e-5, 'and eight times that per eight hours');
  near(now?.premium, TICKER.mark_price / TICKER.index_price - 1, 'the premium now, the mark over the index');
  assert.deepEqual([now?.hours, now?.next], [1, T + H], 'over the hour under way');
  assert.match(half.asked[0]!, /public\/ticker\?instrument_name=ETH-PERPETUAL$/);
  assert.ok(half.asked[1]!.endsWith(`public/get_funding_rate_value?instrument_name=ETH-PERPETUAL&start_timestamp=${T}&end_timestamp=${T + 30 * MIN}`), half.asked[1]);
  near((await readFundingNow('deribit', ETH, deribit(0), T + 31 * MIN))?.per8h, 0, 'an hour that has paid nothing so far reads zero, not the moment');
  // Deribit as measured: the value is a step function of the end, in whole blocks. A constant rate reads the same at every offset, never sagging through a block.
  const blocks = venue(url => { const m = /start_timestamp=(\d+)&end_timestamp=(\d+)/.exec(url); if (!m) return { result: TICKER }; assert.equal(Number(m[2]) % 1, 0, 'a whole number of milliseconds'); return { result: Math.floor((Number(m[2]) - Number(m[1])) / (5 * MIN)) * 1e-6 }; });
  for (const at of [5 * MIN + 5_000, 7 * MIN + 0.5, 9 * MIN + 59_000, 10 * MIN + 5_000, 14 * MIN + 59_000, 29 * MIN + 59_000, 54 * MIN + 59_000, 59 * MIN + 59_000]) near((await readFundingNow('deribit', ETH, blocks, T + at))?.rate, 1.2e-5, `constant through the blocks, ${at} ms in`);
  const onTheHour = await readFundingNow('deribit', ETH, blocks, T + 60 * MIN);
  near(onTheHour?.per8h, 0.000037, 'on the hour the new hour has no block: the moment');
  assert.equal(onTheHour?.next, T + 2 * H, 'and the step under way is the new hour');
  // A block lands a second or two after it ends: read before that, the blocks before it are what is asked, and before the first has landed nothing is.
  const landing = deribit(1e-6); await readFundingNow('deribit', ETH, landing, T + 10 * MIN + 2_000);
  assert.ok(landing.asked[1]!.endsWith(`end_timestamp=${T + 5 * MIN}`), landing.asked[1]);
  const notYet = deribit(0); near((await readFundingNow('deribit', ETH, notYet, T + 5 * MIN + 2_000))?.per8h, 0.000037, 'the first block not landed: the moment, not a zero');
  assert.equal(notYet.asked.length, 1, 'and the hour so far is not asked');
  const early = deribit(2e-6), first = await readFundingNow('deribit', ETH, early, T + 2 * MIN);
  near(first?.rate, 0.000037 / 8, 'two minutes in: the rate of the moment');
  near(first?.per8h, 0.000037, 'which is already per eight hours');
  assert.equal(early.asked.length, 1, 'and the hour so far is not asked');
  near((await readFundingNow('deribit', ETH, deribit(new Error('no')), T + 31 * MIN))?.per8h, 0.000037, 'a failed read of the hour so far leaves the moment, not no reading');
  near((await readFundingNow('deribit', ETH, deribit('x'), T + 31 * MIN))?.per8h, 0.000037, 'and so does an answer that is no number');
  near((await readFundingNow('deribit', ETH, deribit(2e-6, { current_funding: 0, mark_price: 100, index_price: 100 }), T + 2 * MIN))?.per8h, 0, 'inside its dampener: a reading of zero, not none');
  assert.equal(await readFundingNow('deribit', ETH, deribit(2e-6, { mark_price: 100, index_price: 100 }), T + 2 * MIN), null, 'no rate in the answer is no reading');
  assert.equal((await readFundingNow('deribit', ETH, deribit(2e-6, { current_funding: 0.0001 }), T + 2 * MIN))?.premium, null, 'no mark or index: no premium, the rate still read');
});

test('a view without its premium candles reads the funding and the reading now, and no premium', async () => {
  const get = venue(url => url.includes('fundingInfo') ? [] : url.includes('premiumIndexKlines') ? [] : url.includes('premiumIndex?') ? { lastFundingRate: '0.0001', nextFundingTime: T + 16 * H } : [{ fundingTime: T + 8 * H, fundingRate: '0.0001' }]);
  const source = new FundingSource(() => undefined, get), flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
  source.view('binance', BTC, H, T, T + 10 * H, T + 10 * H, false); await flush();
  assert.ok(get.asked.some(url => url.includes('fundingRate?')), 'its funding is read');
  assert.ok(get.asked.some(url => url.includes('premiumIndex?')), 'and its reading now');
  assert.ok(!get.asked.some(url => url.includes('premiumIndexKlines')), 'not its premium candles');
  const shown = source.view('binance', BTC, H, T, T + 10 * H, T + 10 * H, false);
  assert.deepEqual([shown.rows.map(r => r.t), shown.premium.length], [[T + 8 * H], 0]);
  source.view('binance', BTC, H, T, T + 10 * H, T + 10 * H); await flush();
  assert.ok(get.asked.some(url => url.includes('premiumIndexKlines')), 'the chart\'s own venue reads them');
});

test('the popup names a settlement and a band only where a venue has them', () => {
  const row = { t: T + H, rate: 4e-6, per8h: 3.2e-5, hours: 1 };
  const card = (continuous: boolean, forming: boolean) => fundingCardLines({ time: T + H / 2, venue: 'V', row, forming, premium: null, opens: null, coin: 'BTC', continuous });
  const labels = (continuous: boolean, forming: boolean): (string | undefined)[] => card(continuous, forming).map(line => line.label).filter(Boolean);
  assert.deepEqual(labels(false, false), ['Funding', 'Each settlement', 'APR', 'Settled at']);
  assert.deepEqual(labels(false, true), ['Funding', 'Each settlement', 'APR', 'Settles at']);
  assert.deepEqual(labels(true, false), ['Funding', 'APR'], 'continuous: what the hour paid, settled by nothing');
  assert.deepEqual(labels(true, true), ['Funding', 'APR']);
  const bandSaid = (continuous: boolean): boolean => card(continuous, false).some(line => (line.text ?? '').includes('shaded band'));
  assert.deepEqual([bandSaid(false), bandSaid(true)], [true, false], 'no band is drawn on a continuous venue, so none is spoken of');
});

test('the base rate and its band per venue; which venues have a premium line; the row an interval holds', () => {
  assert.deepEqual(fundingBase('binance'), { base: 0.0001, clamp: 0.0005 });
  assert.deepEqual(fundingBase('deribit'), { base: 0, clamp: 0 }, 'continuous, no base rate: no band drawn');
  assert.deepEqual(['hyperliquid', 'binance', 'bybit', 'okx', 'bitget', 'deribit'].map(v => hasPremium(v as never)), [true, true, true, false, false, false]);
  assert.deepEqual(['hyperliquid', 'binance', 'bybit', 'okx', 'bitget', 'deribit'].map(v => continuousFunding(v as never)), [false, false, false, false, false, true]);
  assert.deepEqual([isFundingVenue('okx'), isFundingVenue('gate'), isFundingVenue(3)], [true, false, false]);
  const rows = [{ t: T + 8 * H, rate: 1, per8h: 1, hours: 8 }, { t: T + 16 * H, rate: 2, per8h: 2, hours: 8 }];
  assert.equal(rowAt(rows, T + 3 * H)?.rate, 1, 'a settlement pays for the eight hours before it');
  assert.equal(rowAt(rows, T + 12 * H)?.rate, 2);
  assert.equal(rowAt(rows, T + 17 * H), null, 'after the newest: none settled yet');
  assert.equal(rowAt(rows, T - H), null);
  // Where a time cuts rows held oldest first (the pane cuts at the moment shown and the view's edges, never filtering every row each paint).
  assert.deepEqual([cutAt(rows, T), cutAt(rows, T + 8 * H), cutAt(rows, T + 8 * H, false), cutAt(rows, T + 20 * H), cutAt([], T)], [0, 1, 0, 2, 0]);
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

test('review: a read further back keeps the held row after a skipped settlement; OKX\'s blank realized rate; a premium beside a null funding', async () => {
  // Every four hours with the settlement at 04:00 of day D missing (as Binance skipped 2026-06-24 04:00Z): the 08:00 record is four hours'.
  const D = Date.UTC(2026, 5, 24), times = [-16, -12, -8, -4, 0, 8, 12, 16, 20, 24, 28].map(h => D + h * H);
  const binance = venue(url => {
    if (url.includes('fundingInfo')) return [{ symbol: 'SKIPUSDT', fundingIntervalHours: 4 }];
    const end = Number(/endTime=(\d+)/.exec(url)![1]);
    return times.filter(t => t <= end).slice(-500).map(t => ({ symbol: 'SKIPUSDT', fundingTime: t, fundingRate: '0.00005' }));
  });
  const source = new FundingSource(() => {}, binance), listing = { symbol: 'SKIPUSDT', unit: 1 }, now = D + 40 * H;
  // A first view whose read starts at the 08:00 record (a day and eight hours back from now), then one further back, ending there.
  source.view('binance', listing, H, D + 38 * H, D + 39 * H, now);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(source.view('binance', listing, H, D + 38 * H, D + 39 * H, now).from, D + 8 * H, 'the first read starts at 08:00');
  source.view('binance', listing, H, D - 40 * H, D + 28 * H, now);
  await new Promise(r => setTimeout(r, 10));
  const rows = source.view('binance', listing, H, D - 40 * H, D + 28 * H, now).rows;
  assert.equal(rows.find(r => r.t === D + 8 * H)?.hours, 4, 'the 08:00 record keeps its four hours across the join');
  // OKX: a blank realized rate gives way to the rate.
  const okx = venue(() => ({ data: [{ fundingTime: String(T + 8 * H), realizedRate: '', fundingRate: '0.0001' }, { fundingTime: String(T), realizedRate: '0.00008', fundingRate: '0.0001' }] }));
  assert.deepEqual((await readFunding('okx', { symbol: 'BTC-USDT-SWAP', unit: 1 }, T - H, T + 9 * H, okx)).rows.map(r => r.rate), [0.00008, 0.0001]);
  // Hyperliquid: a record with null funding still gives its hour's premium.
  const hl = venue(() => [{ coin: 'BTC', fundingRate: null, premium: '0.0003', time: T + H }]);
  const read = await readFunding('hyperliquid', { symbol: 'BTC', unit: 1 }, T, T + 2 * H, hl);
  assert.deepEqual([read.rows.length, read.premium.map(q => [q.t, q.p])], [0, [[T, 0.0003]]]);
});

test('review: after a skipped settlement the next is looked for when the venue\'s interval now says it is due, not ten minutes later', async () => {
  // Every four hours, 04:00 skipped: the newest row (08:00) reads 8 hours; the venue says four. At 12:00:20 the 12:00 record is looked for.
  // (Bybit: its intervals are cached per symbol, Binance's list once for the whole module.)
  const D = Date.UTC(2026, 5, 24), held = [-8, -4, 0, 8].map(h => D + h * H);
  let times = held;
  const bybit = venue(url => {
    if (url.includes('instruments-info')) return { result: { list: [{ fundingInterval: 240 }] } };
    if (url.includes('tickers')) return { retCode: 0, result: { list: [{ fundingRate: '0.00005', nextFundingTime: String(D + 16 * H) }] } };
    const end = Number(/endTime=(\d+)/.exec(url)![1]);
    return { retCode: 0, result: { list: times.filter(t => t <= end).reverse().map(t => ({ fundingRate: '0.00005', fundingRateTimestamp: String(t) })) } };
  });
  const source = new FundingSource(() => {}, bybit), listing = { symbol: 'DUEUSDT', unit: 1 }, first = D + 11 * H + 56 * 60_000;
  source.view('bybit', listing, H, first - 2 * H, first, first);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(source.view('bybit', listing, H, first - 2 * H, first, first).rows.at(-1)?.hours, 8, 'the newest row reads its gap as it is');
  times = [...held, D + 12 * H];
  const reads = (): number => bybit.asked.filter(u => u.includes('funding/history')).length, before = reads(), at = D + 12 * H + 20_000;
  source.view('bybit', listing, H, at - 2 * H, at, at);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(reads(), before + 1, 'looked for 15 s after it was due by the venue\'s four hours');
  const rows = source.view('bybit', listing, H, at - 2 * H, at, at).rows;
  assert.deepEqual(rows.slice(-2).map(r => r.hours), [4, 4], 'and the 08:00 row heals to four hours');
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
