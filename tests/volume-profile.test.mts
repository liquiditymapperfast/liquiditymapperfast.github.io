import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { levelsOf, pointOfControl, valueArea } from '../src/shared/profile.ts';
import { FootprintRecorder, parseProfile, parseValueAreas } from '../src/shared/footprint.ts';
import { dayWindows, fromWall, lastWindows, offsetMs, sessionWindows, weekWindows, type SessionDef } from '../src/app/traded/sessions.ts';
import { TRADED_DEFAULTS, readTraded, resolveZone } from '../src/app/traded/settings.ts';
import { answerLevels, linesWindows, requestStep, touchedAt } from '../src/app/traded/levels.ts';
import { tradedRows } from '../src/app/traded.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

test('the point of control is the busiest row; a tie goes to the row nearest the middle of what traded, then the lower', () => {
  assert.equal(pointOfControl([1, 5, 3]), 1);
  assert.equal(pointOfControl([5, 0, 0, 0, 5, 1]), 4, 'rows 0..5 traded, middle 2.5: row 4 is 1.5 away, row 0 is 2.5');
  assert.equal(pointOfControl([0, 4, 0, 4, 0]), 1, 'equally near the middle: the lower');
  assert.equal(pointOfControl([0, 0]), -1);
  assert.equal(pointOfControl([]), -1);
});

test('the value area grows from the point of control to the busier side until it holds its share', () => {
  // Total 100: POC 40 at row 2; then 25 above (row 3) against 20 below (row 1) -> 65; then 20 below -> 85 >= 70.
  assert.deepEqual(valueArea([5, 20, 40, 25, 10], 0.7), { poc: 2, lo: 1, hi: 3 });
  assert.deepEqual(valueArea([5, 20, 40, 25, 10], 0.4), { poc: 2, lo: 2, hi: 2 }, 'the POC alone holds 40 %');
  // Equal neighbours are taken together.
  assert.deepEqual(valueArea([10, 30, 40, 30, 10], 0.6), { poc: 2, lo: 1, hi: 3 }, 'rows 1 and 3 hold the same, so both go in');
  assert.deepEqual(valueArea([0, 0, 50, 0, 0], 0.7), { poc: 2, lo: 2, hi: 2 }, 'everything in one row');
  assert.deepEqual(valueArea([100, 1, 1], 0.995), { poc: 0, lo: 0, hi: 2 }, 'at the bottom edge it can only grow up');
  assert.equal(valueArea([0, 0], 0.7), null);
  // As prices: POC at the middle of its row, VAL at the bottom of the lowest row, VAH at the top of the highest.
  assert.deepEqual(levelsOf(new Map([[4000, 5], [4001, 20], [4002, 40], [4003, 25], [4004, 10]]), 20, 0.7), { poc: 80_050, val: 80_020, vah: 80_080 });
  assert.equal(levelsOf(new Map(), 20, 0.7), null);
});

test('a zone\'s wall clock becomes an instant across its clock changes: skipped times land after the jump, repeated ones take the first', () => {
  const ny = 'America/New_York';
  assert.equal(offsetMs(ny, Date.UTC(2026, 0, 15, 12)), -5 * HOUR); assert.equal(offsetMs(ny, Date.UTC(2026, 6, 15, 12)), -4 * HOUR);
  assert.equal(fromWall(ny, Date.UTC(2026, 6, 15, 9, 30)), Date.UTC(2026, 6, 15, 13, 30), 'summer: 09:30 in New York is 13:30 UTC');
  // 8 March 2026: 02:00 jumps to 03:00. 02:30 does not exist: it lands at 03:30 EDT (07:30 UTC).
  assert.equal(fromWall(ny, Date.UTC(2026, 2, 8, 2, 30)), Date.UTC(2026, 2, 8, 7, 30));
  // 1 November 2026: 01:30 happens twice: the first is EDT (05:30 UTC).
  assert.equal(fromWall(ny, Date.UTC(2026, 10, 1, 1, 30)), Date.UTC(2026, 10, 1, 5, 30));
  assert.equal(fromWall('UTC', Date.UTC(2026, 4, 1, 8)), Date.UTC(2026, 4, 1, 8));
});

test('days and weeks follow their zone, 23 and 25 hours on the days its clocks change', () => {
  const london = 'Europe/London';
  // 29 March 2026: clocks go forward; 25 October 2026: back.
  const spring = dayWindows(london, Date.UTC(2026, 2, 29, 12), Date.UTC(2026, 2, 29, 13));
  assert.deepEqual(spring.map(w => [w.from, w.to - w.from]), [[Date.UTC(2026, 2, 29, 0), 23 * HOUR]]);
  const autumn = dayWindows(london, Date.UTC(2026, 9, 25, 12), Date.UTC(2026, 9, 25, 13));
  assert.deepEqual(autumn.map(w => [w.from, w.to - w.from]), [[Date.UTC(2026, 9, 24, 23), 25 * HOUR]]);
  assert.equal(dayWindows('UTC', Date.UTC(2026, 9, 7, 22), Date.UTC(2026, 9, 8, 2)).length, 2, 'a window over midnight touches two days');
  const weeks = weekWindows('UTC', Date.UTC(2026, 9, 8), Date.UTC(2026, 9, 9));
  assert.deepEqual(weeks.map(w => [new Date(w.from).toISOString(), w.to - w.from]), [['2026-10-05T00:00:00.000Z', 7 * DAY]], 'Monday to Monday');
});

test('sessions are wall-clock times in their market\'s zone, cross midnight when they end before they start, and can skip weekends', () => {
  const s = (over: Partial<SessionDef>): SessionDef => ({ id: 'a', name: 'X', zone: 'Europe/London', start: '08:00', end: '17:00', on: true, weekdays: false, ...over });
  // London 08:00 is 07:00 UTC in summer and 08:00 UTC in winter.
  assert.equal(sessionWindows([s({})], Date.UTC(2026, 6, 15, 10), Date.UTC(2026, 6, 15, 11))[0]!.from, Date.UTC(2026, 6, 15, 7));
  assert.equal(sessionWindows([s({})], Date.UTC(2026, 11, 15, 10), Date.UTC(2026, 11, 15, 11))[0]!.from, Date.UTC(2026, 11, 15, 8));
  // 22:00 to 02:00 UTC runs past midnight: the one that touches 01:00 began the day before.
  const night = sessionWindows([s({ zone: 'UTC', start: '22:00', end: '02:00' })], Date.UTC(2026, 9, 8, 1), Date.UTC(2026, 9, 8, 1, 30));
  assert.deepEqual(night.map(w => [w.from, w.to]), [[Date.UTC(2026, 9, 7, 22), Date.UTC(2026, 9, 8, 2)]]);
  assert.equal(sessionWindows([s({ zone: 'UTC', start: '00:00', end: '00:00' })], Date.UTC(2026, 9, 8, 5), Date.UTC(2026, 9, 8, 6))[0]!.to - Date.UTC(2026, 9, 8), DAY, 'the same start and end is a whole day');
  // 10 October 2026 is a Saturday.
  assert.equal(sessionWindows([s({ weekdays: true })], Date.UTC(2026, 9, 10, 9), Date.UTC(2026, 9, 10, 10)).length, 0);
  assert.equal(sessionWindows([s({ on: false })], Date.UTC(2026, 9, 8, 9), Date.UTC(2026, 9, 8, 10)).length, 0);
  assert.equal(sessionWindows([s({ zone: 'Nowhere/Atlantis' })], Date.UTC(2026, 9, 8, 9), Date.UTC(2026, 9, 8, 10)).length, 0, 'a zone the browser does not know is left out');
  // The last N of each session, never one that has not begun.
  const two = [s({ id: 'a', zone: 'UTC', start: '01:00', end: '02:00' }), s({ id: 'b', zone: 'UTC', start: '03:00', end: '04:00' })];
  const all = sessionWindows(two, Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 8, 12));
  const last = lastWindows(all, 2, Date.UTC(2026, 9, 8, 1, 30));
  assert.deepEqual(last.map(w => `${w.key.split('|')[1]} ${new Date(w.from).toISOString().slice(5, 13)}`), ['b 10-06T03', 'a 10-07T01', 'b 10-07T03', 'a 10-08T01']);
});

test('saved settings are read field by field: a bad zone, time or count falls back, and session ids stay apart', () => {
  assert.deepEqual(readTraded(undefined), { ...TRADED_DEFAULTS, sessions: TRADED_DEFAULTS.sessions.map(s => ({ ...s })) });
  const r = readTraded({ bars: 'delta', share: 80, rows: 2, period: 'sessions', zone: 'Mars/Olympus', count: 99, sessions: [
    { id: 'x', name: 'A', zone: 'Asia/Tokyo', start: '09:00', end: '18:00' }, { id: 'x', name: 'B', zone: 'UTC', start: '9:00', end: '25:00' }, { id: 'x', name: 'C', zone: 'page', start: '01:00', end: '02:00' },
    { id: 'x', name: 'D', zone: 'UTC', start: '01:00', end: '02:00', on: false, weekdays: true }] });
  assert.deepEqual([r.bars, r.share, r.rows, r.period, r.zone, r.count], ['delta', 80, 2, 'sessions', 'page', 20]);
  assert.deepEqual(r.sessions.map(s => [s.id, s.name, s.on, s.weekdays]), [['x', 'A', true, false], ['xx', 'D', false, true]], 'a 25:00 end and the page zone are not a session');
  assert.equal(readTraded({ share: 71, rows: 3 }).share, 70);
  assert.equal(resolveZone('page', 'utc'), 'UTC'); assert.equal(resolveZone('Asia/Tokyo', 'local'), 'Asia/Tokyo');
});

test('the traded profile says how many orders began on each row, and a page reads an answer with or without the counts', () => {
  const recorder = new FootprintRecorder(null, () => 1_800_000_000_000 + 10 * MIN), T0 = 1_800_000_000_000;
  const fills = [{ instrumentId: 'x:BTC', tradeId: 'a', side: 'buy', price: 85_000, notionalUsd: 40_000, sourceTimestamp: T0 + 1_000 }, { instrumentId: 'x:BTC', tradeId: 'b', side: 'buy', price: 85_012, notionalUsd: 30_000, sourceTimestamp: T0 + 1_000 }];
  recorder.ingest(fills); recorder.countOrders([{ instrumentId: 'x:BTC', side: 'buy', t: T0 + 1_000, usd: 70_000, lo: 85_000, hi: 85_012 }]);
  const answer = JSON.parse(JSON.stringify(recorder.profile(['x:BTC'], T0, T0 + MIN, 10)));
  assert.deepEqual(answer.instruments[0].rows, [[85_000, 40_000, 0], [85_010, 30_000, 0]], 'the rows are three numbers as before: an older page still reads them');
  assert.deepEqual([answer.instruments[0].counts, answer.instruments[0].counted], [[[1, 0], [0, 0]], 1], 'the order began at 85,000; the sweep\'s other row has its volume and no order');
  const parsed = parseProfile(answer, ['x:BTC'])!;
  assert.deepEqual(parsed.instruments[0]!.counts, [[1, 0], [0, 0]]);
  const { counts: _c, counted: _n, ...older } = answer.instruments[0];
  assert.equal(parseProfile({ ...answer, instruments: [older] }, ['x:BTC'])!.instruments[0]!.counts, undefined, 'an older server: no counts, nothing refused');
  assert.equal(parseProfile({ ...answer, instruments: [{ ...answer.instruments[0], counts: [[1, 0]] }] }, ['x:BTC']), null, 'counts that do not line up with the rows');
});

test('value areas are worked out for each window over every price, and the route refuses what it cannot answer', async () => {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 50, heartbeatMs: 500 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, now = Math.floor(Date.now() / MIN) * MIN;
    const at = (id: string, price: number, usd: number, t: number, inst = 'x:BTC') => ({ instrumentId: inst, tradeId: id, side: 'buy', price, notionalUsd: usd, sourceTimestamp: t });
    // First window: most at 85,000; second: most at 86,000, on two instruments added together.
    v2.footprint.ingest([at('1', 85_005, 50_000, now - 50 * MIN), at('2', 85_100, 10_000, now - 50 * MIN), at('3', 86_005, 30_000, now - 10 * MIN), at('4', 86_010, 30_000, now - 9 * MIN, 'y:BTC'), at('5', 85_005, 20_000, now - 9 * MIN)]);
    const windows = [{ from: now - 60 * MIN, to: now - 30 * MIN }, { from: now - 30 * MIN, to: now }];
    const r = await fetch(`${base}/api/v2/value-areas?inst=x:BTC,y:BTC&w=${windows.map(w => `${w.from}-${w.to}`).join(',')}&step=20&share=0.7`);
    assert.equal(r.status, 200);
    const answer = parseValueAreas(await r.json(), windows)!;
    assert.deepEqual(answer.windows.map(w => [w.poc, w.minutes]), [[85_010, 1], [86_010, 2]]);
    assert.deepEqual([answer.windows[0]!.val, answer.windows[0]!.vah], [85_000, 85_020], '50K of the 60K is in the POC row: it alone holds the 70 %');
    const refuse = async (query: string) => { const x = await fetch(`${base}/api/v2/value-areas?${query}`); assert.equal(x.status, 400, query); };
    await refuse(`inst=x:BTC&w=1-2&step=0&share=0.7`); await refuse(`inst=x:BTC&w=2-1&step=20&share=0.7`); await refuse(`inst=x:BTC&w=1-2&step=20&share=1.5`);
    await refuse(`inst=x:BTC&w=0-${9 * DAY}&step=20&share=0.7`);
    await refuse(`inst=x:BTC&w=${Array.from({ length: 25 }, (_, i) => `${i}-${i + 1}`).join(',')}&step=20&share=0.7`);
    assert.equal(parseValueAreas({ ...answer, windows: answer.windows.slice(1) }, windows), null, 'an answer for other windows');
  } finally { v2.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close(); }
});

test('the column asks on a step both its rows and the level rows divide, and the levels do not move when the price axis zooms', () => {
  assert.equal(requestStep(50, 20, 0.5), 10); assert.equal(requestStep(5, 20, 0.5), 5); assert.equal(requestStep(2.5, 20, 0.5), 2.5); assert.equal(requestStep(0.2, 20, 0.5), 0.5, 'never finer than the recording');
  const T0 = 1_800_000_000_000, recorder = new FootprintRecorder(null, () => T0 + 10 * MIN);
  const prices = [84_990, 85_002, 85_004, 85_013, 85_019, 85_021, 85_047, 85_088];
  recorder.ingest(prices.map((price, i) => ({ instrumentId: 'x:BTC', tradeId: String(i), side: i % 2 ? 'sell' : 'buy', price, notionalUsd: 1_000 * (i + 1), sourceTimestamp: T0 + 1_000 + i })));
  // The same levels whether the column's rows are 5, 10 or 50 wide: they are read on rows of 20 from every price.
  const levels = [5, 10, 50].map(display => answerLevels(recorder.profile(['x:BTC'], T0, T0 + MIN, requestStep(display, 20, 0.5)), 20, 0.7));
  assert.deepEqual(levels[1], levels[0]); assert.deepEqual(levels[2], levels[0]);
  assert.equal(levels[0]!.poc, 85_010, 'rows of 20: 85,000-85,020 holds 2+3+4+5 = 14K of 36K');
  // Touched: the first candle after the window whose range reaches the level, half a row either side.
  const candles: [number, number, number, number, number, number][] = [[T0 + 5 * MIN, 0, 85_100, 85_050, 0, 0], [T0 + 6 * MIN, 0, 85_060, 85_015, 0, 0]];
  assert.equal(touchedAt(85_010, T0 + 5 * MIN, candles, 10), T0 + 6 * MIN);
  assert.equal(touchedAt(85_010, T0 + 5 * MIN, candles, 1), null, 'still naked as far as the candles go');
  assert.deepEqual(linesWindows({ ...TRADED_DEFAULTS, period: 'view' }, 'utc', T0, T0 + DAY, T0 + DAY), []);
  assert.equal(linesWindows({ ...TRADED_DEFAULTS, period: 'day', count: 2 }, 'utc', T0 - 5 * DAY, T0, T0).length, 2, 'the last two days that touch the view');
});

test('a band dragged on the traded column adds up to exactly the bars it covers', () => {
  const T0 = 1_800_000_000_000, recorder = new FootprintRecorder(null, () => T0 + 10 * MIN);
  const fills = Array.from({ length: 120 }, (_, i) => ({ instrumentId: i % 3 ? 'x:BTC' : 'y:BTC', tradeId: String(i), side: i % 2 ? 'sell' : 'buy', price: 85_000 + ((i * 37) % 400) + 0.5, notionalUsd: 500 + i * 13, sourceTimestamp: T0 + 2_000 + i * 400 }));
  recorder.ingest(fills);
  const display = 25, step = requestStep(display, 20, 0.5), ids = ['x:BTC', 'y:BTC'];
  const rows = tradedRows(recorder.profile(ids, T0, T0 + 2 * MIN, step), display, 84_900, 85_500);
  // Rows 6 to 9 of the column: the band the drag snaps to.
  const k = 6, n = 4, p0 = (rows.bin0 + k) * display, p1 = (rows.bin0 + k + n) * display;
  const band = recorder.range(ids, T0, T0 + 2 * MIN, { p0, p1 }, display).instruments.reduce((a, i) => ({ buy: a.buy + i.band.buy, sell: a.sell + i.band.sell }), { buy: 0, sell: 0 });
  let buy = 0, sell = 0; for (let i = k; i < k + n; i++) { buy += rows.buy[i]!; sell += rows.sell[i]!; }
  assert.ok(buy + sell > 0, 'the band holds trades');
  assert.ok(Math.abs(band.buy - buy) < 1e-6 && Math.abs(band.sell - sell) < 1e-6, `panel ${band.buy}/${band.sell} against bars ${buy}/${sell}`);
  // And the column has the orders that began on each row when the recording counts them (none here: no orders were counted).
  assert.equal(rows.counted, 1);
});
