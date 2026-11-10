import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { levelsOf, pointOfControl, valueArea } from '../src/shared/profile.ts';
import type { CandleRow } from '../src/app/store.ts';
import { FootprintRecorder, parseProfile, parseValueAreas } from '../src/shared/footprint.ts';
import { dayWindows, fromWall, lastWindows, offsetMs, sessionWindows, weekWindows, type SessionDef } from '../src/app/traded/sessions.ts';
import { TRADED_DEFAULTS, chartKinds, linesCount, linesSource, readTraded, recordedCount, resolveZone } from '../src/app/traded/settings.ts';
import { answerLevels, candleAnswer, candleBarMs, candleLevels, candleLevelsByRow, linesWindows, loadedColumnWanted, mergeCandleProfiles, recordedShare, recordedWindows, recordingStart, requestStep, touchedAt, windowKind, windowLabel, windowZone } from '../src/app/traded/levels.ts';
import { TradeCoverage, recordedMinutes } from '../src/shared/coverage.ts';
import { tradedRows } from '../src/app/traded.ts';
import { initialState } from '../src/app/store.ts';

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
  assert.deepEqual([r.bars, r.share, r.rows, r.lines, r.zone, r.count], ['delta', 80, 2, ['sessions'], 'page', 20], 'a saved period is drawn on the chart');
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
  assert.deepEqual(linesWindows({ ...TRADED_DEFAULTS, period: 'day', count: 0 }, 'utc', T0, T0 + DAY, T0 + DAY), []);
  assert.equal(linesWindows({ ...TRADED_DEFAULTS, period: 'day', count: 2 }, 'utc', T0 - 5 * DAY, T0, T0).length, 2, 'the last two days that touch the view');
});

test('days, weeks and sessions are windows of their zone, the last ones up to the chart\'s right edge, named by their date', () => {
  const at = (day: number, hh = 0, mm = 0): number => Date.UTC(2026, 9, day, hh, mm);   // October 2026: the 12th is a Monday
  const base = { ...TRADED_DEFAULTS, zone: 'UTC' }, now = at(14, 15, 30);
  const last = (k: Parameters<typeof linesWindows>[0], t0: number, t1: number, at: number) => linesWindows({ ...k, count: 1 }, 'utc', t0, t1, at).at(-1)!;
  // A day, and a week from Monday, in the zone; the chart's right edge past the clock counts as now.
  const day = last({ ...base, period: 'day' }, now - DAY, now + 5 * MIN, now), week = last({ ...base, period: 'week' }, now - 8 * DAY, now + DAY, now);
  assert.deepEqual([day.from, day.to], [at(14), at(15)]);
  assert.deepEqual([week.from, week.to], [at(12), at(19)]);
  // A day of a zone whose clocks change is 25 hours long on the day they go back.
  const berlin = last({ ...base, zone: 'Europe/Berlin', period: 'day' }, at(25), at(25, 12), at(25, 12));
  assert.deepEqual([berlin.from, berlin.to], [at(24, 22), at(25, 23)]);
  // Sessions: each session's own, named after it; one switched off is not drawn.
  const def = (id: string, start: string, end: string, on = true): SessionDef => ({ id, name: id, zone: 'UTC', start, end, on, weekdays: false });
  const sessions = [def('asia', '00:00', '09:00'), def('london', '07:00', '16:00'), def('ny', '12:00', '21:00', false)];
  assert.deepEqual(linesWindows({ ...base, period: 'sessions', sessions, count: 1 }, 'utc', at(14), now, now).map(w => w.name).sort(), ['asia', 'london']);
  const labelled = (w: typeof day, kind: string): string => windowLabel({ ...w, key: `${kind}|x|${w.from}`, name: '' }, t => new Date(t).toISOString().slice(5, 10), 'Week');
  assert.deepEqual([labelled(day, 'day'), labelled(week, 'week'), windowLabel({ key: 'session|asia|1', name: 'Asia', from: at(14), to: at(14, 9) }, () => '10-14', 'Week'), labelled(day, 'session')], ['10-14', 'Week 10-12', 'Asia 10-14', '10-14']);
  // A session's date is read in its own zone: Tokyo's midnight of the 15th is still the 14th in UTC.
  const tokyo = { ...base, period: 'sessions' as const, sessions: [{ ...def('tk', '00:00', '09:00'), zone: 'Asia/Tokyo', name: 'Tokyo' }] };
  const tk = last(tokyo, at(14, 12), at(14, 16), at(14, 16));
  assert.equal(tk.from, at(14, 15), 'midnight of the 15th in Tokyo');
  assert.equal(windowZone(tk, tokyo, 'utc'), 'Asia/Tokyo');
  assert.equal(windowZone(day, base, 'utc'), 'UTC', 'a day: the zone days start in');
  assert.equal(windowZone(tk, { ...tokyo, sessions: [] }, 'utc'), 'UTC', 'a session no longer in the list: the zone days start in');
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

test('a profile read in slices with the event loop let go between is the answer read in one go, and value areas over hours built first lose or double no minute', async () => {
  const T0 = 1_800_000_000_000, recorder = new FootprintRecorder(null, () => T0 + 20 * HOUR), ids = ['x:BTC', 'y:BTC'];
  // 600 fills 100 s apart: about seventeen hours, across three of the six-hour slices the reads are made in.
  const fills = Array.from({ length: 600 }, (_, i) => ({ instrumentId: ids[i % 2]!, tradeId: String(i), side: i % 3 ? 'sell' : 'buy', price: 85_000 + ((i * 37) % 400) + 0.5, notionalUsd: 500 + i * 13, sourceTimestamp: T0 + 5_000 + i * 100_000 }));
  recorder.ingest(fills);
  const inside = (from: number, to: number): number => fills.filter(f => { const m = Math.floor(f.sourceTimestamp / MIN) * MIN; return m >= from && m < to; }).reduce((sum, f) => sum + f.notionalUsd, 0);
  // A window that starts before the recording, one that reaches past the newest minute (a week not over yet), and one inside it.
  for (const [from, to] of [[T0 - HOUR, T0 + 30 * HOUR], [T0 + 7 * HOUR + 13 * MIN, T0 + 8 * DAY], [T0 + 2 * HOUR, T0 + 11 * HOUR]] as const) {
    const sliced = await recorder.profileYielding(ids, from, to, 20), whole = recorder.profile(ids, from, to, 20);
    assert.deepEqual(sliced, whole, `profile ${from}-${to}`);
    const volume = whole.instruments.reduce((sum, i) => sum + i.rows.reduce((s, r) => s + r[1] + r[2], 0), 0);
    assert.ok(volume > 0 && Math.abs(volume - inside(from, to)) < 1e-6, `every minute of ${from}-${to} once: ${volume} against ${inside(from, to)}`);
  }
  const windows = [{ from: T0, to: T0 + 13 * HOUR }, { from: T0 + 2 * HOUR, to: T0 + 40 * HOUR }];
  const before = recorder.valueAreas(ids, windows, 20, 0.7);
  // The route builds the ended hours first (`prepare`) and then reads them added together: the same answer as minute by minute.
  await recorder.prepare(ids, windows[0]!.from, windows[1]!.to, HOUR);
  const areas = recorder.valueAreas(ids, windows, 20, 0.7);
  assert.deepEqual(areas, before);
  windows.forEach((w, i) => assert.ok(Math.abs(areas.windows[i]!.total - inside(w.from, w.to)) < 1e-6, `window ${i}: ${areas.windows[i]!.total} against ${inside(w.from, w.to)}`));
});

test('each month: calendar months of the zone, named by month, worked out from candles only, as many as the candles reach', () => {
  const base = { ...TRADED_DEFAULTS, period: 'month' as const, zone: 'UTC', count: 9 };
  const oct20 = Date.UTC(2026, 9, 20, 12), months = linesWindows(base, 'utc', Date.UTC(2026, 6, 15), oct20, oct20);
  assert.deepEqual(months.map(w => new Date(w.from).toISOString().slice(0, 10)), ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'], 'every month that touches the chart, the open one last');
  assert.equal(new Date(months[1]!.to).toISOString().slice(0, 10), '2026-09-01', 'August runs to the 1st of September');
  assert.equal(windowLabel(months[3]!, () => 'Oct 1', 'Week', () => 'Oct 2026'), 'Oct 2026');
  assert.equal(linesSource({ period: 'month', source: 'recorded' }), 'candles', 'no month fits the recording');
  assert.equal(linesSource({ period: 'week', source: 'recorded' }), 'recorded');
  assert.equal(recordedCount('month', 7 * DAY), 0);
  assert.equal(linesCount(base, 7 * DAY), 4, 'twenty weeks of candles hold four whole months');
  assert.deepEqual(readTraded({ period: 'month' }).lines, ['month'], 'a month the columns added up is drawn on the chart');
});

test('a profile over whole hours, read from the hours added together, is the same as its half hours read minute by minute, order counts too', () => {
  const T0 = 1_800_000_000_000, recorder = new FootprintRecorder(null, () => T0 + 5 * HOUR), id = 'x:BTC';
  // Orders are counted from the first minute on, so every minute counts them by price.
  recorder.countOrders([{ instrumentId: id, side: 'buy', t: T0 + 500, usd: 1, lo: 85_000, hi: 85_000 }]);
  const fills = Array.from({ length: 240 }, (_, i) => ({ instrumentId: id, tradeId: String(i), side: i % 3 ? 'sell' : 'buy', price: 85_000 + ((i * 53) % 300) + 0.5, notionalUsd: 1_000 + i * 7, sourceTimestamp: T0 + 1_000 + i * 45_000 }));
  recorder.ingest(fills);
  recorder.countOrders(fills.map(f => ({ instrumentId: id, side: f.side as 'buy' | 'sell', t: f.sourceTimestamp, usd: f.notionalUsd, lo: f.price, hi: f.price })));
  const whole = recorder.profile([id], T0, T0 + 3 * HOUR, 20).instruments[0]!;
  const sum = new Map<number, number[]>();
  for (let a = T0; a < T0 + 3 * HOUR; a += 30 * MIN) {
    const part = recorder.profile([id], a, a + 30 * MIN, 20).instruments[0]!;
    part.rows.forEach(([price, buy, sell], r) => { const c = sum.get(price) ?? [0, 0, 0, 0]; c[0]! += buy; c[1]! += sell; c[2]! += part.counts![r]![0]; c[3]! += part.counts![r]![1]; sum.set(price, c); });
  }
  const halves = [...sum].sort((a, b) => a[0] - b[0]);
  assert.deepEqual(whole.rows.map(r => r[0]), halves.map(h => h[0]));
  whole.rows.forEach(([, buy, sell], r) => { const h = halves[r]![1]!; assert.ok(Math.abs(buy - h[0]!) < 1e-6 && Math.abs(sell - h[1]!) < 1e-6, `row ${r} USD`); assert.deepEqual(whole.counts![r], [h[2], h[3]], `row ${r} orders`); });
  assert.ok(whole.counts!.some(c => c[0] + c[1] > 0), 'the orders were counted');
});

test('the volume profile is off unless chosen: a save from before it had settings reads as off, a later choice stays; a first visit on a desktop has it, for its column (the profile along the top is off by default since 10-28)', () => {
  const g = globalThis as { window?: unknown }, had = g.window;
  const saved = (value: unknown): void => { g.window = { innerWidth: 1920, localStorage: { getItem: () => JSON.stringify(value) } }; };
  try {
    // Defaults revision 3: the measure strip, on for every desktop since revision 2, is the profile along the top, which shows with the Volume profile.
    saved({}); assert.equal(initialState().show.traded, true, 'a first visit on a desktop');
    saved({ defaultsRev: 3, show: { traded: true } }); assert.equal(initialState().show.traded, false, 'the old default of the column, saved before');
    saved({ defaultsRev: 3, show: { traded: true }, traded: {} }); assert.equal(initialState().show.traded, true, 'switched on since');
    saved({ defaultsRev: 3, show: { traded: false }, traded: {} }); assert.equal(initialState().show.traded, false);
  } finally { g.window = had; }
});

test('from the recording only what it still holds is offered: as many days or sessions as days kept, the week under way, none on a page that keeps a day', () => {
  assert.deepEqual((['day', 'week', 'sessions'] as const).map(p => recordedCount(p, 7 * DAY)), [7, 1, 7]);
  assert.deepEqual((['day', 'week', 'sessions'] as const).map(p => recordedCount(p, DAY)), [1, 0, 1]);
  assert.equal(linesCount({ ...TRADED_DEFAULTS, period: 'week', count: 5 }, 7 * DAY), 1, 'the previous weeks are no longer recorded');
  assert.equal(linesCount({ ...TRADED_DEFAULTS, period: 'week', count: 5, source: 'candles' }, 7 * DAY), 5, 'candles reach back');
  assert.equal(readTraded({}).source, 'recorded', 'a save from before the choice');
  assert.equal(readTraded({ source: 'candles' }).source, 'candles'); assert.equal(readTraded({ source: 'tea leaves' }).source, 'recorded');
  // Profiles on the chart: one kind or none; a save from when they followed the columns' period keeps them for that period.
  assert.equal(readTraded({}).profiles, null, 'none until chosen (the days\' lines are on, their profiles not)');
  assert.equal(readTraded({ profiles: 'week' }).profiles, 'week'); assert.equal(readTraded({ profiles: 'year' }).profiles, null);
  assert.deepEqual([readTraded({ period: 'day', pastProfiles: true }).lines, readTraded({ period: 'day', pastProfiles: true }).profiles], [['day'], 'day']);
  assert.equal(readTraded({ period: 'view', pastProfiles: true }).profiles, null, 'what is on the chart had no profiles of its own');
  assert.equal(readTraded({ period: 'day', pastProfiles: true, profiles: null }).profiles, null, 'a choice of none, once saved, stands');
  assert.equal(readTraded({}).tags, true, 'a save from before the tags names its lines on the axis'); assert.equal(readTraded({ tags: false }).tags, false);
  // Other periods' lines beside the columns' own: kept in their order, each once, nothing unknown; a save from before draws the columns' alone.
  assert.deepEqual(readTraded({}).lines, ['day'], 'each day on the chart, until chosen otherwise');
  assert.deepEqual(readTraded({ lines: [] }).lines, [], 'none, once chosen');
  assert.equal(TRADED_DEFAULTS.windowLines, true, 'the chart window\'s lines on by default'); assert.equal(readTraded({}).windowLines, true);
  assert.equal(readTraded({ windowLines: false }).windowLines, false, 'and off once chosen, whatever periods are drawn'); assert.equal(readTraded({ lines: ['day'] }).windowLines, true);
  assert.deepEqual(readTraded({ lines: ['month', 'day', 'month', 'year'] }).lines, ['day', 'month']);
  assert.deepEqual(readTraded({ lines: 'day' }).lines, ['day'], 'not a list: the default');
  assert.deepEqual(chartKinds({ lines: ['day', 'week'], profiles: 'month' }), ['day', 'week', 'month'], 'the profiles\' kind is worked out even with its lines off');
  assert.deepEqual(chartKinds({ lines: ['day'], profiles: 'day' }), ['day'], 'each once');
  assert.deepEqual(chartKinds({ lines: [], profiles: null }), []);
  assert.deepEqual(readTraded({ period: 'week', lines: ['day', 'week'] }).lines, ['day', 'week'], 'a saved period already among the lines is there once');
  assert.deepEqual(['day|UTC|1', 'week|UTC|1', 'month|UTC|1', 'session|s1|1'].map(key => windowKind({ key })), ['day', 'week', 'month', 'sessions']);
  // Weeks in UTC on Sunday 2026-10-18: this week began on the 12th, inside the seven days; the week of the 5th did not.
  const now = Date.UTC(2026, 9, 18, 15), weeks = linesWindows({ ...TRADED_DEFAULTS, period: 'week', zone: 'UTC', count: 5, source: 'candles' }, 'utc', now - 30 * DAY, now, now);
  assert.equal(weeks.length, 5);
  assert.deepEqual(recordedWindows(weeks, now, 7 * DAY).map(w => new Date(w.from).toISOString().slice(0, 10)), ['2026-10-12']);
  assert.equal(linesWindows({ ...TRADED_DEFAULTS, period: 'week' }, 'utc', now - 30 * DAY, now, now, 0).length, 0, 'none asked, none drawn');
  // Without the source's own estimate, a window is judged by the minutes of its best-recorded venue.
  assert.equal(recordedShare({ from: 0, to: 100 * MIN, minutes: 45 }, 50 * MIN), 0.9);
  assert.equal(recordedShare({ from: 0, to: 100 * MIN, minutes: 45, covered: 0.3 }, 50 * MIN), 0.3);
});

test('candles give a value area with each bar\'s volume spread evenly over its range, and say how many of the window\'s bars were there', () => {
  const B = 5 * MIN, T = 1_800_000_000_000 - (1_800_000_000_000 % B);
  // Bars in coins: 10 at 85,000-85,040, 1 at 85,100 (no range), 1 at 84,900-85,000, and one before the window.
  const bars: [number, number, number, number, number, number][] = [[T, 0, 85_040, 85_000, 85_020, 10], [T + B, 0, 85_100, 85_100, 85_100, 1], [T + 2 * B, 0, 85_000, 84_900, 84_950, 1], [T - B, 0, 90_000, 80_000, 85_000, 1_000]];
  const r = candleLevels(bars, T, T + 3 * B, B, 20, 0.7, T + 3 * B);
  assert.equal(r.covered, 1, 'the bar before the window does not count');
  // 850,200 USD spread over 85,000-85,040 is two rows of 425,100 (with 85,100 and the low bar about 16 % of the volume): the 70 % is those two rows.
  assert.deepEqual([r.levels!.val, r.levels!.vah], [85_000, 85_040]);
  assert.ok(r.levels!.poc === 85_010 || r.levels!.poc === 85_030, `POC ${r.levels!.poc}`);
  // The estimate a past window's profile on the chart draws: USD by row index on the step, the bar outside the window in none of them.
  const usd = [...r.rows.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(usd - (10 * (85_040 + 85_000 + 85_020) / 3 + 85_100 + (85_000 + 84_900 + 84_950) / 3)) < 1e-6, `rows hold ${usd}`);
  assert.ok(Math.abs(r.rows.get(85_000 / 20)! - 10 * 85_020 / 2) < 1e-6, 'the first bar\'s half on 85,000-85,020');
  assert.equal(r.rows.get(85_100 / 20), 85_100, 'a bar with no range on its one row');
  assert.ok(![...r.rows.keys()].some(k => k < 84_900 / 20 || k > 85_100 / 20), 'nothing from the bar before the window');
  // A bar missing; and the candles known only to inside the second bar: the window under way is worked out to there.
  assert.equal(candleLevels([bars[0]!, bars[2]!], T, T + 3 * B, B, 20, 0.7, T + 3 * B).covered, 2 / 3);
  assert.equal(candleLevels(bars, T, T + 3 * B, B, 20, 0.7, T + B + 30_000).covered, 1, 'one bar ended by then, and it is there');
  assert.equal(candleLevels([], T, T + 3 * B, B, 20, 0.7, T + 3 * B).levels, null);
  assert.equal(r.buys, null, 'candles that do not say who bought: no split');
  // With taker buys (Binance): each bar's bought part spread as its volume is.
  const split = bars.map(b => [...b, 0, b[5] * 0.75] as [number, number, number, number, number, number, number, number]);
  const s = candleLevels(split, T, T + 3 * B, B, 20, 0.7, T + 3 * B);
  assert.ok(s.buys, 'split');
  for (const [k, usd] of s.rows) assert.ok(Math.abs(s.buys!.get(k)! - usd * 0.75) < 1e-6, `row ${k}: three quarters bought`);
  assert.equal(candleLevels([split[0]!, bars[1]!, split[2]!], T, T + 3 * B, B, 20, 0.7, T + 3 * B).buys, null, 'one bar without them: no split at all');
  // The perpetual's and the spot market's together: rows and buys added up, levels read from the sum.
  const both = mergeCandleProfiles(s, s, 20, 0.7);
  for (const [k, usd] of s.rows) { assert.ok(Math.abs(both.rows.get(k)! - 2 * usd) < 1e-6); assert.ok(Math.abs(both.buys!.get(k)! - 2 * s.buys!.get(k)!) < 1e-6); }
  assert.deepEqual(both.levels, s.levels, 'twice the same: the same levels');
  assert.equal(mergeCandleProfiles(s, r, 20, 0.7).buys, null, 'one without buys: none');
  const session = (start: string, on = true) => ({ id: 's', name: 'S', zone: 'UTC', start, end: '18:00', on, weekdays: false });
  assert.equal(candleBarMs({ period: 'week', sessions: [session('09:17')] }), B, 'days and weeks start on five minutes');
  assert.equal(candleBarMs({ period: 'sessions', sessions: [session('09:30'), session('13:17')] }), MIN, 'a session at :17');
  assert.equal(candleBarMs({ period: 'sessions', sessions: [session('09:30'), session('13:17', false)] }), B, 'one switched off does not count');
});

test('a value area counts an instrument named twice once and says how much of the window the recording holds, weighting each venue by its volume', () => {
  const T0 = 1_800_000_000_000 - (1_800_000_000_000 % HOUR), now = T0 + 3 * HOUR, recorder = new FootprintRecorder(null, () => now);
  const at = (inst: string, id: string, price: number, usd: number, t: number) => ({ instrumentId: inst, tradeId: id, side: 'buy', price, notionalUsd: usd, sourceTimestamp: t });
  // a: a trade every minute for three hours at 85,000; b: ten times bigger, at 86,000, only in the last hour.
  const fills = [];
  for (let m = 0; m < 180; m++) fills.push(at('a:BTC', 'a' + m, 85_001, 1_000, T0 + m * MIN + 1_000));
  for (let m = 120; m < 180; m++) fills.push(at('b:BTC', 'b' + m, 86_001, 10_000, T0 + m * MIN + 1_000));
  recorder.ingest(fills);
  const w = [{ from: T0, to: T0 + 3 * HOUR }];
  const once = recorder.valueAreas(['a:BTC', 'b:BTC'], w, 20, 0.7), twice = recorder.valueAreas(['a:BTC', 'a:BTC', 'b:BTC'], w, 20, 0.7);
  assert.deepEqual(twice.windows, once.windows, 'a named twice weighs as once');
  assert.equal(once.asOf, now);
  // Without a record of when each was listened to, the minutes with trades: b looks recorded for an hour, and its 600K stands for 1.8M.
  assert.equal(once.windows[0]!.covered!.toFixed(4), ((180_000 + 600_000) / (180_000 + 1_800_000)).toFixed(4));
  // With the coverage record saying b was listened to all along (quiet before), the window is whole.
  assert.equal(recorder.valueAreas(['a:BTC', 'b:BTC'], w, 20, 0.7, () => 180).windows[0]!.covered, 1);
  // A venue recorded in none of it, or never, says nothing of its part: the share is not known.
  assert.equal(recorder.valueAreas(['a:BTC', 'b:BTC'], w, 20, 0.7, id => id === 'a:BTC' ? 180 : 0).windows[0]!.covered, 0);
  assert.equal(recorder.valueAreas(['a:BTC', 'c:BTC'], w, 20, 0.7).windows[0]!.covered, 0);
  // The window under way: its share is of the time so far, on the same basis for every venue (half a minute in, half a minute recorded).
  let clock = now + 30_000;
  const later = new FootprintRecorder(null, () => clock);
  later.ingest([at('a:BTC', 'x', 85_001, 1_000, now + 10_000)]);
  const open = () => later.valueAreas(['a:BTC'], [{ from: now, to: now + HOUR }], 20, 0.7, (_id, from, to) => (to - from) / MIN).windows[0]!.covered;
  assert.equal(open(), 1);
  clock = now + 60_000; assert.equal(open(), 1, 'nor when the next minute begins');
  // The ended hours read added together give what the minutes do (the profile column reads minutes).
  const levels = answerLevels(recorder.profile(['a:BTC', 'b:BTC'], T0, T0 + 3 * HOUR, 20), 20, 0.7)!;
  assert.deepEqual([once.windows[0]!.poc, once.windows[0]!.vah, once.windows[0]!.val], [levels.poc, levels.vah, levels.val]);
  assert.equal(parseValueAreas({ ...once, windows: [{ ...once.windows[0], covered: 1.5 }] }, w), null, 'a share above 1');
  assert.equal(parseValueAreas({ ...once, asOf: 'now' }, w), null);
  const { covered: _c, ...older } = once.windows[0]!, { asOf: _a, ...olderAnswer } = once;
  assert.equal(parseValueAreas({ ...olderAnswer, windows: [older] }, w)!.windows[0]!.covered, undefined, 'an older server: no share, nothing refused');
});

test('the minutes recorded come from the coverage record: a quiet minute listened to counts, one nobody recorded does not, one held from before the record counts', () => {
  const T0 = 1_800_000_000_000 - (1_800_000_000_000 % HOUR), coverage = new TradeCoverage(null, () => T0 + HOUR);
  coverage.recovered('a:BTC', T0 + 10 * MIN, T0 + 20 * MIN);
  coverage.recovered('a:BTC', T0 + 30 * MIN, T0 + 30 * MIN + 30_000);
  // Minutes with trades: two from before a's record began (counted), one inside a stretch (not twice), one in a gap since (not counted).
  const held = new Set([T0 + 2 * MIN, T0 + 3 * MIN, T0 + 15 * MIN, T0 + 40 * MIN]);
  assert.equal(recordedMinutes(coverage, 'a:BTC', T0, T0 + HOUR, t => held.has(t)), 2 + 10 + 0.5);
  assert.equal(recordedMinutes(coverage, 'b:BTC', T0, T0 + HOUR, t => held.has(t)), 4, 'no record at all: every minute held is from before it');
  assert.equal(recordedMinutes(coverage, 'b:BTC', T0, T0 + HOUR, () => false), 0);
  assert.equal(recordedMinutes(coverage, 'a:BTC', T0 + HOUR, T0, () => true), 0);
});

test('the column shows the candles instead of the recording when the recording holds under nine tenths of its window, never both added', () => {
  // Karl, 2026-10-24: zoomed out to months, the column showed only the last days, with nothing for the rest that the page had loaded.
  const from = 1_000 * DAY, to = from + 100 * DAY;
  assert.equal(loadedColumnWanted(null, from, to), false, 'the recording holds all of the window');
  assert.equal(loadedColumnWanted(from - DAY, from, to), false, 'it began before the window');
  assert.equal(loadedColumnWanted(from + 5 * DAY, from, to), false, 'it misses 5 % of the window: still the recording, which says "since"');
  assert.equal(loadedColumnWanted(from + 10 * DAY + MIN, from, to), true, 'it misses more than a tenth');
  assert.equal(loadedColumnWanted(to - 8 * DAY, from, to), true, 'eight days of a hundred: the candles');
  assert.equal(loadedColumnWanted(to + DAY, from, to), true, 'it begins after the window ends: nothing recorded in it');
  assert.equal(loadedColumnWanted(from, to, to), false, 'an empty window asks for nothing');
});

test('a candle estimate becomes the answer the column reads: rows on its step, buys and sells, one instrument there for the whole window', () => {
  const step = 10, bars = [[0, 100, 120, 100, 110, 5, 0, 2], [300_000, 110, 130, 110, 125, 5, 0, 5]] as unknown as CandleRowLike[];
  const profile = candleLevels(bars as never, 0, 600_000, 300_000, step, 0.7, 600_000);
  const { answer, split } = candleAnswer(profile.rows, profile.buys, step, 0, 600_000);
  assert.equal(split, true);
  const inst = answer.instruments[0]!;
  assert.deepEqual([answer.from, answer.to, inst.step, inst.first, inst.earliest], [0, 600_000, step, 0, 0], 'there for the whole window');
  const total = inst.rows.reduce((a, [, b, s]) => a + b + s, 0), spread = [...profile.rows.values()].reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(total - spread) < 1e-6, 'every dollar of the estimate is in the rows');
  assert.ok(inst.rows.every(([low]) => low % step === 0), 'rows start on the step');
  assert.deepEqual(inst.rows.map(r => r[0]), [...inst.rows.map(r => r[0])].sort((a, b) => a - b), 'in order of price');
  // The column's own readers take it: rows on its display grid, and levels over every price.
  const rows = tradedRows(answer, 20, 90, 140);
  assert.ok(Math.abs(rows.total - spread) < 1e-6);
  assert.equal(rows.partial, false, 'it is not read as a recording that began late');
  assert.ok(answerLevels(answer, step, 0.7) !== null);
  // Without taker buys a row's volume is whole on one side, said by `split`.
  const noSplit = candleAnswer(profile.rows, null, step, 0, 600_000);
  assert.equal(noSplit.split, false); assert.ok(noSplit.answer.instruments[0]!.rows.every(([, , sold]) => sold === 0));
  // Nothing traded: an instrument with no rows, not a crash.
  assert.deepEqual(candleAnswer(new Map(), null, step, 0, 600_000).answer.instruments[0]!.rows, []);
});
type CandleRowLike = readonly number[];

test('where the recording begins for the column does not depend on the window an answer was asked for, nor on instruments it does not count', () => {
  const MIN = 60_000, DAY = 86_400_000, to = 1_000 * DAY, from = to - 30 * DAY, asked = to - 8 * DAY, win = { from, to };
  const held = (...earliest: (number | null)[]): { id: string; earliest: number | null }[] => earliest.map((e, i) => ({ id: `v${i}:BTC`, earliest: e }));
  // A month on the map: the recording can be asked about eight days at most, and that is where it begins whatever answer is held.
  assert.equal(recordingStart(win, asked, held(from - DAY, from - 2 * DAY), 0), asked, 'the asked span, from venues recorded long before');
  assert.equal(recordingStart(win, asked, held(to - 3 * DAY, from - DAY), 0), to - 3 * DAY, 'the latest venue to start recording');
  assert.equal(recordingStart(win, asked, held(to - 3 * DAY, null), 0), to - 3 * DAY, 'a venue with nothing recorded is not a start');
  // Nothing recorded at all: the recording begins after the window ends, and the candles are wanted wherever they hold it.
  assert.equal(recordingStart(win, asked, held(null, null), 0), to);
  assert.equal(recordingStart({ from: to - DAY, to }, to - DAY, held(null), 0), to, 'a short window too');
  // No answer held yet (or none for what is counted): where the hub knows the recording began, else the asked span alone.
  assert.equal(recordingStart(win, asked, null, to - 2 * DAY), to - 2 * DAY);
  assert.equal(recordingStart(win, asked, [], 0), asked, 'an answer with no instruments says nothing');
  assert.equal(recordingStart({ from: to - DAY, to }, to - DAY, null, 0), null);
  assert.equal(recordingStart({ from: to - DAY, to }, to - DAY, null, to - 5 * DAY), null, 'the recording holds all of the day');
  // The minute's slack the column has always had: a start within a minute of the window's is its start.
  assert.equal(recordingStart({ from: to - DAY, to }, to - DAY, held(to - DAY + 30_000), 0), null);
  assert.equal(recordingStart({ from: to - DAY, to }, to - DAY, held(to - DAY + 2 * MIN), 0), to - DAY + 2 * MIN);
  // After a scope or a chip changed, the held answer is for the old instruments until the new one lands: only the ones counted now speak.
  const old = [{ id: 'old:BTC', earliest: to - 2 * DAY }, { id: 'kept:BTC', earliest: from - DAY }];
  assert.equal(recordingStart(win, asked, old, 0, ['kept:BTC']), asked, 'the old venue that is no longer counted does not set the start');
  assert.equal(recordingStart(win, asked, old, 0, ['old:BTC', 'kept:BTC']), to - 2 * DAY, 'counted again, it does');
  assert.equal(recordingStart(win, asked, old, to - 3 * DAY, ['new:BTC']), to - 3 * DAY, 'none of the answer counted: as if none were held, the hub says');
  assert.equal(recordingStart({ from: to - DAY, to }, to - DAY, [{ id: 'old:BTC', earliest: to - 2 * MIN }], 0, ['new:BTC']), null, 'and without the hub: the recording is taken to hold the day');
});

test('the estimate in flat arrays gives the row by row estimate: the same rows, the same sums, the same levels', () => {
  let seed = 11;
  const rnd = (): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const B = 5 * MIN, T = 1_800_000_000_000 - (1_800_000_000_000 % B);
  for (const [step, taker] of [[20, true], [5, false], [0.5, true], [0.25, true], [7.3, true]] as const) {
    const bars: number[][] = [];
    let p = 85_000;
    for (let k = 0; k < 400; k++) {
      p *= 1 + (rnd() - 0.5) * 0.004;
      // Some bars with no range, some on row boundaries, some with no volume, and one with no taker side where the others have it.
      const flat = rnd() < 0.08, onRow = rnd() < 0.1;
      const low = onRow ? Math.round(p / step) * step : p * (1 - rnd() * 0.002);
      const high = flat ? low : onRow ? low + step * Math.ceil(rnd() * 30) : p * (1 + rnd() * 0.002);
      const volume = rnd() < 0.05 ? 0 : 1 + rnd() * 40, row = [T + k * B, p, high, low, (high + low) / 2, volume];
      if (taker) row.push(0, k === 77 && step === 7.3 ? NaN : volume * rnd());
      bars.push(row);
    }
    const rows = bars as unknown as Parameters<typeof candleLevels>[0], from = T + 3 * B, to = T + 380 * B;
    const fast = candleLevels(rows, from, to, B, step, 0.7, to), slow = candleLevelsByRow(rows, from, to, B, step, 0.7, to);
    assert.deepEqual([...fast.rows.keys()].sort((a, b) => a - b), [...slow.rows.keys()].sort((a, b) => a - b), `rows at $${step}`);
    for (const [k, v] of slow.rows) assert.ok(Math.abs(fast.rows.get(k)! - v) <= 1e-9 * Math.max(1, v), `row ${k} at $${step}: ${fast.rows.get(k)} vs ${v}`);
    assert.equal(fast.buys === null, slow.buys === null, 'buys only where every bar says them');
    if (fast.buys && slow.buys) for (const [k, v] of slow.buys) assert.ok(Math.abs(fast.buys.get(k)! - v) <= 1e-9 * Math.max(1, v));
    assert.deepEqual(fast.levels, slow.levels);
    assert.equal(fast.covered, slow.covered);
  }
});

test('the two candle estimates read the same value area on a near tie, whatever their last digits (Sol, 2026-11-10)', () => {
  // Rows that hold the same volume to the last digit or two: compared exactly, the value area low was 105 one way and 104 the other.
  const BAR = 300_000, tuples: [number, number, number][] = [[103, 105, 1], [105, 111, 1.8], [106, 108, 1.8], [104, 107, 0.6], [105, 109, 1.6]];
  const bars = tuples.map(([low, high, usd], i): CandleRow => { const mid = (low + high) / 2; return [i * BAR, mid, high, low, mid, usd / mid]; });
  const fast = candleLevels(bars, 0, 5 * BAR, BAR, 1, 0.7, 5 * BAR), slow = candleLevelsByRow(bars, 0, 5 * BAR, BAR, 1, 0.7, 5 * BAR);
  assert.deepEqual(fast.levels, slow.levels);
  assert.deepEqual(slow.levels, { poc: 106.5, val: 104, vah: 109 });
});
