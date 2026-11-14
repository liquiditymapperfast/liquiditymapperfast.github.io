import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { FootprintRecorder, parseProfile, type ProfileAnswer } from '../src/shared/footprint.ts';
import { periodRowLines, tradedFigures, tradedHeader, tradedLines, tradedNetLine, tradedRowAt, tradedRows, tradedRowsHeld } from '../src/app/traded.ts';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { Hub } from '../src/app/hub.ts';
import { Store, initialState } from '../src/app/store.ts';

const MIN = 60_000, T0 = 1_800_000_000_000;
const fill = (inst: string, tradeId: string, side: 'buy' | 'sell', price: number, usd: number, t: number) => ({ instrumentId: inst, tradeId, side, price, notionalUsd: usd, sourceTimestamp: t });

test('the recorder answers the traded volume by price over a window, per instrument, and says how far back it has recorded', () => {
  const recorder = new FootprintRecorder(null, () => T0 + 10 * MIN);
  recorder.ingest([
    fill('a:BTC', '1', 'buy', 85_000.2, 1_000, T0 - 5 * MIN),     // before the window: not counted, but the recording reaches back to it
    fill('a:BTC', '2', 'buy', 85_000.2, 2_000, T0 + 1_000),
    fill('a:BTC', '3', 'sell', 85_004.9, 3_000, T0 + MIN + 1_000),
    fill('a:BTC', '4', 'buy', 85_010, 4_000, T0 + 2 * MIN),
    fill('b:BTC', '5', 'sell', 85_001, 7_000, T0 + 3 * MIN),
  ]);
  const answer = recorder.profile(['a:BTC', 'b:BTC', 'none:BTC'], T0, T0 + 5 * MIN, 5);
  const [a, b, none] = answer.instruments;
  assert.equal(a!.step, 5, 'a whole multiple of the recorded step (0.5)');
  assert.deepEqual(a!.rows, [[85_000, 2_000, 3_000], [85_010, 4_000, 0]], '85,000.2 and 85,004.9 share the row from 85,000; the fill before the window is left out');
  assert.equal(a!.minutes, 3); assert.equal(a!.first, T0); assert.equal(a!.earliest, T0 - 5 * MIN);
  assert.deepEqual(b!.rows, [[85_000, 0, 7_000]]);
  assert.deepEqual(none, { id: 'none:BTC', step: 0, rows: [], minutes: 0, first: null, earliest: null });
  assert.deepEqual(parseProfile(JSON.parse(JSON.stringify(answer)), ['a:BTC', 'b:BTC', 'none:BTC']), answer, 'what comes out of JSON is the answer');
});

test('a profile answer that is not exactly what was asked for is refused', () => {
  const good: ProfileAnswer = { from: T0, to: T0 + MIN, instruments: [{ id: 'a:BTC', step: 5, rows: [[85_000, 1, 2]], minutes: 1, first: T0, earliest: T0 }] };
  const bad = (change: (a: ProfileAnswer) => void): ProfileAnswer | null => { const copy = JSON.parse(JSON.stringify(good)) as ProfileAnswer; change(copy); return parseProfile(copy, ['a:BTC']); };
  assert.ok(parseProfile(good, ['a:BTC']));
  assert.equal(parseProfile(null, ['a:BTC']), null); assert.equal(parseProfile({ error: 'not found' }, ['a:BTC']), null);
  assert.equal(bad(a => { a.instruments[0]!.id = 'z:BTC'; }), null, 'an instrument nobody asked about');
  assert.equal(bad(a => { a.instruments[0]!.rows[0]![1] = -1; }), null, 'negative volume');
  assert.equal(bad(a => { (a.instruments[0]!.rows[0] as unknown as number[]).push(4); }), null, 'a row of four numbers');
  assert.equal(bad(a => { a.instruments[0]!.minutes = 1.5; }), null);
  assert.equal(bad(a => { (a.instruments[0] as unknown as { first: unknown }).first = 'soon'; }), null);
});

test('rows of every instrument go onto the column\'s grid where their middle falls, and the busiest row is the point of control', () => {
  const answer: ProfileAnswer = { from: T0, to: T0 + 60 * MIN, instruments: [
    { id: 'a:BTC', step: 5, rows: [[85_000, 100, 0], [85_005, 0, 50], [85_020, 10, 10]], minutes: 60, first: T0, earliest: T0 - 60 * MIN },
    { id: 'b:BTC', step: 2, rows: [[85_002, 30, 0], [85_098, 1, 1]], minutes: 60, first: T0, earliest: T0 - 30 * MIN },
  ] };
  const rows = tradedRows(answer, 10, 84_995, 85_030);
  assert.equal(rows.bin0, 8_499);
  // 85,000-85,010 holds a's two rows (middles 85,002.5 and 85,007.5) and b's row with middle 85,003: 130 bought, 50 sold
  const i = tradedRowAt(rows, 85_004);
  assert.equal(rows.buy[i], 130); assert.equal(rows.sell[i], 50);
  assert.equal(rows.poc, i); assert.equal(rows.max, 180);
  assert.equal(rows.total, 200, 'b\'s row at 85,098 is outside the prices on the map');
  assert.equal(rows.partial, false, 'both recordings reach back before the window');
  assert.equal(rows.recordedSince, T0 - 30 * MIN, 'every instrument is recorded from the later of the two first minutes');
  assert.equal(tradedRowAt(rows, 90_000), -1);
  const [head, sub] = tradedHeader(rows);
  assert.equal(head, 'TRADED 200'); assert.match(sub, /^ROW MAX 180$/);
  const lines = tradedLines(rows, i);
  assert.deepEqual(lines.map(l => l.label ?? null), [null, 'Bought at market', 'Sold at market', 'Delta', 'Share of volume']);
  assert.equal(lines[3]!.text, '+$80'); assert.equal(lines[3]!.color, 'buy'); assert.equal(lines[4]!.text, '90.0 %');
  const later = tradedRows({ ...answer, from: T0 - 45 * MIN }, 10, 84_995, 85_030);
  assert.equal(later.partial, true, 'a window that starts before one of the instruments was recorded');
  assert.match(tradedHeader(later)[1], /^since /);
  assert.ok(tradedLines(later, i).some(l => l.text.startsWith('Recorded since')));
  assert.equal(tradedLines(rows, tradedRowAt(rows, 85_013))[1]!.text, 'Nothing traded at these prices in this window.');
});

test('/api/v2/profile answers the window and refuses what it cannot answer', async () => {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 50, heartbeatMs: 500 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, now = Date.now();
    v2.footprint.ingest([fill('x:BTC', 'p1', 'buy', 85_000, 50_000, now), fill('x:BTC', 'p2', 'sell', 85_100, 20_000, now)]);
    const get = async (query: string) => { const r = await fetch(`${base}/api/v2/profile?${query}`); return { status: r.status, body: await r.json() as unknown }; };
    const from = Math.floor(now / MIN) * MIN, ok = await get(`inst=x:BTC,y:BTC&from=${from}&to=${from + MIN}&step=50`);
    assert.equal(ok.status, 200);
    const answer = parseProfile(ok.body, ['x:BTC', 'y:BTC']);
    assert.ok(answer, 'the shape the page checks for');
    assert.deepEqual(answer!.instruments[0]!.rows, [[85_000, 50_000, 0], [85_100, 0, 20_000]]);
    for (const query of ['', `inst=x:BTC&from=${from}&to=${from + MIN}`, `inst=x:BTC&from=${from}&to=${from + MIN}&step=0`, `inst=x:BTC&from=${from}&to=${from - 1}&step=5`,
      `inst=x:BTC&from=0&to=${from}&step=5`, `inst=${Array.from({ length: 49 }, (_, i) => `i${i}:BTC`).join(',')}&step=5`]) {
      assert.equal((await get(query)).status, 400, query);
    }
  } finally {
    v2.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
});

test('the hub asks one question at a time, again only when it changes or every five seconds at the live edge, and waits a minute after a refusal', async () => {
  class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  const asked: { ids: string[]; from: number; to: number; step: number; settle: (ok: boolean) => void }[] = [];
  const source = { profile: (ids: string[], from: number, to: number, step: number) => new Promise<ProfileAnswer>((resolve, reject) => {
    asked.push({ ids, from, to, step, settle: ok => ok ? resolve({ from, to, instruments: [] }) : reject(new Error('404')) });
  }) };
  const hub = new Hub(new Store(initialState()), source as never);
  const realNow = Date.now; let clock = T0; Date.now = () => clock;
  try {
    const turn = () => new Promise<void>(resolve => setImmediate(resolve));
    hub.ensureTraded(['a:BTC'], T0, T0 + MIN, 5, true);
    hub.ensureTraded(['a:BTC'], T0, T0 + MIN, 10, true);
    assert.equal(asked.length, 1, 'one request at a time');
    asked[0]!.settle(true); await turn();
    assert.ok(hub.traded); assert.equal(hub.traded!.step, 5);
    hub.ensureTraded(['a:BTC'], T0, T0 + MIN, 5, true); assert.equal(asked.length, 1, 'the same question is not asked again at once');
    clock += 5_000; hub.ensureTraded(['a:BTC'], T0, T0 + MIN, 5, true); assert.equal(asked.length, 2, 'at the live edge it is asked again after five seconds');
    asked[1]!.settle(true); await turn();
    clock += 5_000; hub.ensureTraded(['a:BTC'], T0, T0 + MIN, 5, false); assert.equal(asked.length, 2, 'a map moved away from the live edge does not refresh');
    hub.ensureTraded(['a:BTC'], T0, T0 + MIN, 10, false); assert.equal(asked.length, 3, 'a new step is a new question');
    asked[2]!.settle(false); await turn();
    assert.equal(hub.tradedState, 'unavailable');
    hub.ensureTraded(['a:BTC'], T0, T0 + 2 * MIN, 10, false); assert.equal(asked.length, 3, 'a source that refused is left alone for a minute');
    clock += 60_000; hub.ensureTraded(['a:BTC'], T0, T0 + 2 * MIN, 10, false); assert.equal(asked.length, 4);
  } finally { Date.now = realNow; }
});

test('an answer says which window it was asked for, and a window that ended after it was last asked is asked once more', async () => {
  class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  const asked: { settle: () => void }[] = [];
  const source = { profile: (_ids: string[], from: number, to: number) => new Promise<ProfileAnswer>(resolve => { asked.push({ settle: () => resolve({ from, to, instruments: [] }) }); }) };
  const hub = new Hub(new Store(initialState()), source as never);
  const realNow = Date.now; let clock = T0; Date.now = () => clock;
  try {
    const turn = () => new Promise<void>(resolve => setImmediate(resolve));
    const open = { tag: 'session|s1|1', settled: false }, over = { tag: 'session|s1|1', settled: true };
    // The session is under way: asked, and its answer is the session's (a day that began at the same time has another tag).
    hub.ensureTraded(['a:BTC'], T0, T0 + 8 * MIN, 5, true, open);
    asked[0]!.settle(); await turn();
    assert.equal(hub.traded!.tag, 'session|s1|1');
    // It ends: its end is the question's end already, so nothing in the question changed, but what was held was read while it was open.
    clock += 2_000; hub.ensureTraded(['a:BTC'], T0, T0 + 8 * MIN, 5, false, over);
    assert.equal(asked.length, 2, 'one last question once it is over');
    asked[1]!.settle(); await turn();
    clock += 600_000; hub.ensureTraded(['a:BTC'], T0, T0 + 8 * MIN, 5, false, over);
    assert.equal(asked.length, 2, 'and no more');
    // A window that was over when it was first asked is asked once.
    hub.ensureTraded(['a:BTC'], T0 - 86_400_000, T0 - 86_400_000 + 8 * MIN, 5, false, { tag: 'day|UTC|1', settled: true });
    asked[2]!.settle(); await turn();
    hub.ensureTraded(['a:BTC'], T0 - 86_400_000, T0 - 86_400_000 + 8 * MIN, 5, false, { tag: 'day|UTC|1', settled: true });
    assert.equal(asked.length, 3);
    assert.equal(hub.traded!.tag, 'day|UTC|1');
    // The session that covers the same hours has the same bounds and its own tag: a new question, or the column would wait for an answer that never comes.
    hub.ensureTraded(['a:BTC'], T0 - 86_400_000, T0 - 86_400_000 + 8 * MIN, 5, false, { tag: 'session|utc|1', settled: true });
    assert.equal(asked.length, 4);
    asked[3]!.settle(); await turn();
    assert.equal(hub.traded!.tag, 'session|utc|1');
    // What is on the chart has no tag, and moving off the live edge never asks for a last time.
    hub.ensureTraded(['a:BTC'], T0, T0 + MIN, 5, true);
    asked[4]!.settle(); await turn();
    assert.equal(hub.traded!.tag, '');
    clock += 600_000; hub.ensureTraded(['a:BTC'], T0, T0 + MIN, 5, false);
    assert.equal(asked.length, 5);
  } finally { Date.now = realNow; }
});

test('an empty selection clears the traded column, and an answer still on its way for the last one is not drawn', async () => {
  class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  const asked: { settle: (ok: boolean) => void }[] = [];
  const answer: ProfileAnswer = { from: T0, to: T0 + MIN, instruments: [{ id: 'a:BTC', step: 5, rows: [[85_000, 50_000, 0]], minutes: 1, first: T0, earliest: T0 }] };
  const source = { profile: () => new Promise<ProfileAnswer>((resolve, reject) => { asked.push({ settle: ok => ok ? resolve(answer) : reject(new Error('404')) }); }) };
  const hub = new Hub(new Store(initialState()), source as never);
  let changed = 0; hub.onTraded = () => { changed++; };
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  hub.ensureTraded(['a:BTC'], T0, T0 + MIN, 5, false);
  asked[0]!.settle(true); await turn();
  assert.ok(hub.traded, 'the answer is held');
  hub.ensureTraded([], T0, T0 + MIN, 5, false);
  assert.equal(hub.traded, null, 'no instruments: nothing is drawn'); assert.equal(changed, 2);
  hub.ensureTraded(['a:BTC'], T0, T0 + 2 * MIN, 5, false);   // asked again,
  hub.ensureTraded([], T0, T0 + 2 * MIN, 5, false);          // and the selection empties before the answer comes
  asked[1]!.settle(true); await turn();
  assert.equal(hub.traded, null, 'the answer that came late is not drawn');
});

test('the header\'s box gives the whole window in numbers: sides, levels, mean, median, how much lies either side of the point of control, the price now', () => {
  // Rows of 10 from 85,000: 100 bought at 85,000, 300 (200 + 100) at 85,010, 100 sold at 85,020, and 100 sold at 85,040.
  const answer: ProfileAnswer = { from: T0, to: T0 + 60 * MIN, instruments: [
    { id: 'a:BTC', step: 10, rows: [[85_000, 100, 0], [85_010, 200, 100], [85_020, 0, 100], [85_040, 0, 100]], minutes: 60, first: T0, earliest: T0 - 60 * MIN },
  ] };
  const rows = tradedRows(answer, 10, 85_000, 85_049);
  assert.equal(tradedNetLine(rows), 'Δ $0 · 0.0 %', 'bought 300, sold 300: no side');
  const lines = tradedFigures(rows, { poc: 85_010, vah: 85_020, val: 85_000 }, 85_031, 'Oct 19');
  const value = (label: string): string | undefined => lines.find(l => l.label === label)?.text;
  assert.equal(lines[0]!.text, 'Oct 19');
  assert.equal(value('Bought at market'), '$300'); assert.equal(value('Sold at market'), '$300');
  assert.equal(value('Value area'), '85,000 – 85,020');
  // Middles 85,005 (100), 85,015 (300), 85,025 (100), 85,045 (100): 51,092,000 / 600.
  assert.equal(value('Weighted mean price'), '85,020');
  assert.equal(value('Median price'), '85,015', 'half of the 600 is reached in the second row');
  assert.equal(value('Above the point of control'), '33.3 %'); assert.equal(value('Below the point of control'), '16.7 %');
  assert.equal(value('Price now'), '85,031.0 · Above the value area', 'as the price axis writes it');
  assert.deepEqual(tradedFigures(tradedRows({ ...answer, instruments: [] }, 10, 85_000, 85_049), null, 0, 'Oct 19').map(l => l.text), ['Oct 19', 'Nothing traded at these prices in this window.']);
});

test('a period profile\'s row says whose it is, its prices, its two sides where they are known, its share, where it stands and where an estimate comes from', () => {
  const levels = { poc: 85_000, vah: 85_100, val: 84_900 };
  const split = periodRowLines({ name: '≈ Oct', low: 85_000, high: 85_020, step: 20, buy: 750, sell: 250, total: 10_000, split: true, levels, source: 'Binance 5-minute candles: an estimate.' });
  assert.equal(split[0]!.text, '≈ Oct'); assert.equal(split[0]!.bold, true);
  assert.ok(split.some(l => l.color === 'buy' && l.text === '$750'), 'bought'); assert.ok(split.some(l => l.color === 'sell' && l.text === '$250'), 'sold');
  assert.ok(split.some(l => l.text === '+$500'), 'the difference'); assert.ok(split.some(l => l.text === '10.0 %'), 'the share of the period');
  assert.ok(split.some(l => l.text === 'Point of control'), 'where it stands'); assert.equal(split[split.length - 1]!.color, 'muted', 'the source last');
  const grey = periodRowLines({ name: '≈ Oct', low: 86_000, high: 86_020, step: 20, buy: 300, sell: 0, total: 10_000, split: false, levels, source: null });
  assert.ok(!grey.some(l => l.color === 'buy' || l.color === 'sell'), 'no sides where the candles do not say');
  assert.ok(grey.some(l => l.text === '$300'), 'its whole volume'); assert.ok(grey.some(l => l.text === 'Above the value area'));
});

test('an estimate whose candles do not say who bought has one volume: its boxes give no bought, sold or delta', () => {
  const answer: ProfileAnswer = { from: T0, to: T0 + 60 * MIN, instruments: [
    { id: 'candles', step: 10, rows: [[85_000, 100, 0], [85_010, 300, 0], [85_020, 100, 0]], minutes: 60, first: T0, earliest: T0 },
  ] };
  const rows = tradedRows(answer, 10, 85_000, 85_029), levels = { poc: 85_010, vah: 85_020, val: 85_000 };
  const labels = (lines: { label?: string }[]): string[] => lines.flatMap(l => l.label ? [l.label] : []);
  const row = tradedLines(rows, 1, levels, undefined, null, false);
  assert.ok(labels(row).includes('Volume')); assert.equal(row.find(l => l.label === 'Volume')?.text, '$300');
  assert.ok(!labels(row).some(l => ['Bought at market', 'Sold at market', 'Delta', 'Orders begun here'].includes(l)), 'no sides on a row');
  assert.equal(row.find(l => l.label === 'Share of volume')?.text, '60.0 %', 'the share of the whole stays');
  const whole = tradedFigures(rows, levels, 85_011, 'Oct 19', undefined, null, false);
  assert.equal(whole.find(l => l.label === 'Volume')?.text, '$500');
  assert.ok(!labels(whole).some(l => ['Bought at market', 'Sold at market', 'Delta'].includes(l)), 'no sides in the whole');
  assert.ok(labels(whole).includes('Point of control'), 'the levels stay');
  // A split estimate, or the recording, keeps its sides as before.
  assert.ok(labels(tradedLines(rows, 1, levels)).includes('Bought at market'));
  assert.ok(labels(tradedFigures(rows, levels, 85_011, 'Oct 19')).includes('Delta'));
});

test('the traded column keeps its rows for the same answer, step and window, and makes them again for any other (the map asks on every frame)', () => {
  const T = 1_800_000_000_000, M = 60_000;
  const answer: ProfileAnswer = { from: T, to: T + M, instruments: [{ id: 'a:BTC', step: 5, rows: [[85_000, 1, 2], [85_005, 3, 0], [85_100, 0, 4]], minutes: 1, first: T, earliest: T }] };
  const rows = tradedRowsHeld(answer, 5, 84_990, 85_200);
  assert.deepEqual(rows, tradedRows(answer, 5, 84_990, 85_200), 'what tradedRows makes');
  assert.equal(tradedRowsHeld(answer, 5, 84_990, 85_200), rows, 'kept: the same object');
  assert.notEqual(tradedRowsHeld(answer, 10, 84_990, 85_200), rows, 'another step');
  const moved = tradedRowsHeld(answer, 5, 84_995, 85_200);
  assert.deepEqual(moved, tradedRows(answer, 5, 84_995, 85_200), 'another window');
  const next: ProfileAnswer = { ...answer, instruments: [{ ...answer.instruments[0]!, rows: [[85_000, 9, 9]] }] };
  assert.equal(tradedRowsHeld(next, 5, 84_995, 85_200).total, 18, 'a new answer (new data) is read afresh');
});
