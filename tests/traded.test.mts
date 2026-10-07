import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { FootprintRecorder, parseProfile, type ProfileAnswer } from '../src/shared/footprint.ts';
import { tradedHeader, tradedLines, tradedRowAt, tradedRows } from '../src/app/traded.ts';
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
