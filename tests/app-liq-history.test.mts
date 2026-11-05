import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, LiqHistory, bandIndex, dayText, historyUrls, readDay, readIndex } from '../src/app/liq-history.ts';
import { PRESET_BANDS } from '../src/app/depth-settings.ts';

/** The service's buckets (history.rs): 1/32 % to 5 %, then 5/16 % to 25 %. */
const EDGES = [...Array.from({ length: 160 }, (_, i) => (i + 1) / 32), ...Array.from({ length: 64 }, (_, i) => 5 + (i + 1) * 5 / 16)];
const zeros = (): number[] => new Array(EDGES.length).fill(0);
const row = (fetchedAt: number, at: Record<number, [number, number]> = {}, mark = 100_000): unknown[] => {
  const long = zeros(), short = zeros();
  for (const [i, [l, s]] of Object.entries(at)) { long[Number(i)] = l; short[Number(i)] = s; }
  return [fetchedAt - 2_400_000, fetchedAt - 300_000, fetchedAt, mark, 0, 0, long, short];
};

test('the history lives beside the levels file, and a day is named as the service names it', () => {
  assert.deepEqual(historyUrls('https://levels.hiverust.dev/v1/btc/liquidations.json') && {
    index: historyUrls('https://levels.hiverust.dev/v1/btc/liquidations.json')!.index,
    day: historyUrls('https://levels.hiverust.dev/v1/btc/liquidations.json')!.day('2026-11-05'),
  }, { index: 'https://levels.hiverust.dev/v1/btc/liquidation-history.json', day: 'https://levels.hiverust.dev/v1/btc/liquidation-history/2026-11-05.json' });
  assert.equal(historyUrls(''), null, 'no levels service, no history');
  assert.equal(dayText(Date.UTC(2026, 10, 5, 23, 59)), '2026-11-05');
});

test('every band the pane offers ends on a bucket edge', () => {
  for (const bands of Object.values(PRESET_BANDS)) for (const r of bands) {
    const i = bandIndex(EDGES, r);
    assert.ok(i >= 0 && Math.abs(EDGES[i]! - r * 100) < 1e-9, `±${r * 100} %`);
  }
  assert.equal(bandIndex(EDGES, 0.0001), -1, 'narrower than the first bucket: nothing');
  assert.equal(bandIndex(EDGES, 0.9), EDGES.length - 1, 'wider than the last: all of it');
});

test('the index and the days are checked: a row of the wrong shape is left out, never drawn', () => {
  assert.deepEqual(readIndex({ edges: [0.5, 1], first: 5, last: 9 }), { edges: [0.5, 1], first: 5, last: 9 });
  assert.equal(readIndex({ edges: [1, 0.5] }), null, 'edges must rise');
  assert.equal(readIndex({ edges: [] }), null);
  assert.equal(readIndex(null), null);
  assert.deepEqual(readIndex({ edges: [1], first: 'x' }), { edges: [1], first: null, last: null });
  const good = row(1_000, { 31: [1_000_000, 2_000_000] }), bad = [1, 2, 3, 0, 0, 0, zeros(), zeros()], short = [1, 2, 3, 4, 0, 0, [1], [1]], negative = row(2_000, { 0: [-1, 0] });
  const rows = readDay({ rows: [good, bad, short, negative] }, EDGES);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.long[30], 0); assert.equal(r.long[31], 1_000_000, 'the bucket ending at 1 %'); assert.equal(r.long[EDGES.length - 1], 1_000_000, 'and every wider one');
  assert.equal(r.short[31], 2_000_000);
  // Coins: bucket 31 runs from 0.96875 to 1 %, its middle 0.984375 % from the mark: longs below it, shorts above.
  assert.ok(Math.abs(r.longCoin[31]! - 1_000_000 / (100_000 * (1 - 0.00984375))) < 1e-3);
  assert.ok(Math.abs(r.shortCoin[31]! - 2_000_000 / (100_000 * (1 + 0.00984375))) < 1e-3);
  assert.deepEqual(readDay({ rows: [row(3), row(1), row(2)] }, EDGES).map(x => x.fetchedAt), [1, 2, 3], 'ordered by fetch time');
});

test('the pane asks for the index first, then the days its view needs (with the evening before), each once, today again after a minute', async () => {
  const asked: string[] = [], day = Date.UTC(2026, 10, 5), now = day + 10 * 3_600_000;
  const answers: Record<string, unknown> = {
    'https://levels.hiverust.dev/v1/btc/liquidation-history.json': { edges: EDGES, first: day - 2 * DAY_MS + 3_600_000, last: now - 600_000 },
    [`https://levels.hiverust.dev/v1/btc/liquidation-history/${dayText(day - DAY_MS)}.json`]: { rows: [row(day - 1_800_000, { 40: [5, 6] })] },
    [`https://levels.hiverust.dev/v1/btc/liquidation-history/${dayText(day)}.json`]: { rows: [row(day + 3_600_000, { 40: [7, 8] }), row(day + 5_400_000)] },
  };
  const h = new LiqHistory(url => { asked.push(url); return url in answers ? Promise.resolve(answers[url]) : Promise.reject(new Error('404')); });
  const settle = () => new Promise(r => setTimeout(r, 0));
  h.ensure(day + 3_000_000, now + 3_600_000, now, () => {});
  assert.deepEqual(asked, ['https://levels.hiverust.dev/v1/btc/liquidation-history.json'], 'nothing but the index before it has come');
  await settle(); await settle();
  h.ensure(day + 3_000_000, now + 3_600_000, now, () => {});
  assert.deepEqual(asked.slice(1).map(u => u.slice(-15)), [`${dayText(day - DAY_MS)}.json`, `${dayText(day)}.json`], 'the day before the view and the day in it, nothing before the history begins');
  await settle(); await settle();
  const inForce = h.rows(day + 3_000_000, now);
  assert.deepEqual(inForce.map(r => r.fetchedAt), [day - 1_800_000, day + 3_600_000, day + 5_400_000], 'the row before the view holds at its left edge');
  h.ensure(day + 3_000_000, now + 3_600_000, now + 10_000, () => {});
  assert.equal(asked.length, 3, 'nothing again within the minute');
  h.ensure(day + 3_000_000, now + 3_600_000, now + 70_000, () => {});
  assert.deepEqual(asked.slice(3).map(u => u.slice(-15)), [`${dayText(day)}.json`], 'today again after a minute; yesterday, read after it ended, never');
});
