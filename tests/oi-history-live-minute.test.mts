import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { normalizeBinanceOpenInterestHistory } from '../src/adapters/binance.mts';
import { aggregateOi, withLiveOi, type OiRow } from '../src/shared/series.ts';

const MIN = 60_000, FIVE = 5 * MIN, HOUR = 3_600_000;
// An hour boundary six hours back: inside the store's retention, and every reading is in the past.
const t0 = Math.floor(Date.now() / HOUR) * HOUR - 6 * HOUR;
const oiAt = (t: number): number => 1_000 + (t - t0) / MIN; // open interest rising one coin a minute

/** What `/api/v2/oi` answers for one market (`oiBarsOf` in `server/v2/api.mts`): the stored bars and the live samples. */
function serverBars(app: ReturnType<typeof createLocalServer>, history: HistoryStore, id: string, tfMs: number): ReturnType<typeof aggregateOi> {
  const stored = history.listOi(id, { from: 0, to: Date.now() + HOUR, limit: 300_000 }) as OiRow[];
  const live = (app.state.oi ?? []).filter(s => s.instrumentId === id) as OiRow[];
  return aggregateOi(withLiveOi(stored, live), tfMs);
}

test("the feed manager's Binance history closes the bar that ends at each reading on the server too, not the bar after it", async () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger({ filePath: ':memory:' }), history });
  try {
    const stamps = Array.from({ length: 25 }, (_, k) => t0 + k * FIVE); // two hours of five-minute rows
    const payload = stamps.map(t => ({ symbol: 'BTCUSDT', sumOpenInterest: String(oiAt(t)), sumOpenInterestValue: '1', timestamp: t }));
    const rows = normalizeBinanceOpenInterestHistory(payload, { receivedAt: Date.now() });
    for (const row of rows) app.applyMessage(row, 'binance');
    history.flushOiBars();
    const id = rows[0]!.instrumentId;
    for (const tf of [FIVE, 15 * MIN, HOUR]) {
      // Until 2026-11-10 the reducer set every sample's observation to its source time: each bar closed one reading (five minutes) early.
      const off = serverBars(app, history, id, tf).filter(b => b[0] >= t0 && b[0] + tf <= stamps.at(-1)!).map(b => b[4] - oiAt(b[0] + tf));
      assert.ok(off.length > 0, `bars at ${tf / MIN}m`);
      assert.deepEqual(off, off.map(() => 0), `each ${tf / MIN}m bar closes with the open interest at its end`);
    }
  } finally { await app.close(); }
});

test('a history reading fills only a minute no live sample is in, so another source a few coins off never replaces the live close', async () => {
  const history = new HistoryStore({ filePath: ':memory:' });
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger({ filePath: ':memory:' }), history });
  try {
    const id = 'binance:BTCUSDT', live = t0 + HOUR, end = live + HOUR;
    // Live samples every 5 s from `live` on, flat at 1000; the history reads 6 coins higher, every five minutes over the whole stretch.
    for (let t = live; t < end; t += 5_000) app.applyMessage({ kind: 'openInterest', instrumentId: id, sourceTimestamp: t, receivedAt: t, base: 1_000, quality: 'native' }, 'binance');
    const payload = Array.from({ length: 25 }, (_, k) => t0 + k * FIVE).map(t => ({ symbol: 'BTCUSDT', sumOpenInterest: '1006', sumOpenInterestValue: '1', timestamp: t }));
    for (const row of normalizeBinanceOpenInterestHistory(payload, { receivedAt: Date.now() })) app.applyMessage(row, 'binance');
    history.flushOiBars();
    const stored = history.listOi(id, { from: 0, to: end + HOUR, limit: 10_000 }) as { start: number; close: number }[];
    const at = (t: number): number | undefined => stored.find(b => b.start === t)?.close;
    assert.equal(at(live + 4 * MIN), 1_000, 'the live minute keeps its live close where a reading at its end would have replaced it');
    assert.equal(at(live + 9 * MIN), 1_000);
    assert.equal(at(end - MIN), 1_000, 'the newest minute too, still waiting to be written when the reading at its end came');
    assert.equal(at(t0 + 4 * MIN), 1_006, 'before the live samples began the reading fills its minute');
    const minutes = serverBars(app, history, id, MIN).filter(b => b[0] >= live && b[0] < end);
    assert.equal(minutes.length, 60);
    assert.ok(minutes.every(b => b[4] === 1_000), 'the one-minute series is flat wherever it was recorded live: no rise and fall at each reading');
  } finally { await app.close(); }
});
