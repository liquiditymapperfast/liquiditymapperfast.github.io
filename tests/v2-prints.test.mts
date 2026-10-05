import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PRINT_FLOOR_USD, PrintStream, toWire } from '../src/server/v2/prints.mts';

const MIN = 60_000, T0 = 1_800_000_000_000;
const trade = (tradeId: string, side: string, usd: number, t: number, instrumentId = 'x:BTC') => ({ instrumentId, tradeId, side, price: 85_000, notionalUsd: usd, sourceTimestamp: t });

test('only trades at or above the floor are kept, each venue trade id once, oldest first', () => {
  const stream = new PrintStream(null, () => T0);
  const added = stream.ingest([trade('1', 'buy', PRINT_FLOOR_USD, T0 + 3), trade('2', 'sell', PRINT_FLOOR_USD - 1, T0 + 2), trade('3', 'sell', 1_000_000, T0 + 1), trade('1', 'buy', 5_000_000, T0 + 9)]);
  assert.deepEqual(added.map(p => [p.t - T0, p.side, p.usd]), [[1, 'sell', 1_000_000], [3, 'buy', PRINT_FLOOR_USD]], 'a repeated trade id and a small trade are dropped');
  assert.deepEqual(stream.ingest([trade('3', 'sell', 1_000_000, T0 + 1)]), [], 'already seen');
  assert.equal(stream.ingest([trade('3', 'sell', 1_000_000, T0 + 1, 'y:BTC')]).length, 1, 'ids are per instrument');
  assert.deepEqual(stream.ingest([{ instrumentId: 'x:BTC', tradeId: 'q', side: 'hold', price: 1, notionalUsd: 9e9, sourceTimestamp: T0 }, { tradeId: 'r', side: 'buy', price: 1, notionalUsd: 9e9 }, trade('s', 'buy', NaN, T0)]), [], 'malformed rows are ignored');
});

test('fresh prints are handed out once and the wire form is compact', () => {
  const stream = new PrintStream(null, () => T0);
  stream.ingest([trade('a', 'buy', 100_000, T0)]);
  const fresh = stream.takeFresh();
  assert.equal(fresh.length, 1); assert.deepEqual(toWire(fresh[0]!), [T0, 'x:BTC', 'buy', 85_000, 100_000]);
  assert.deepEqual(stream.takeFresh(), []);
});

test('queries select a window and a size, and keep the newest when there are too many', () => {
  const stream = new PrintStream(null, () => T0 + 10 * MIN);
  stream.ingest(Array.from({ length: 10 }, (_, i) => trade(String(i), i % 2 ? 'sell' : 'buy', 30_000 + i * 10_000, T0 + i * MIN)));
  assert.equal(stream.query(T0, T0 + 10 * MIN).length, 10);
  assert.deepEqual(stream.query(T0 + 2 * MIN, T0 + 5 * MIN).map(p => (p.t - T0) / MIN), [2, 3, 4], 'from is inclusive, to exclusive');
  assert.ok(stream.query(T0, T0 + 10 * MIN, 100_000).every(p => p.usd >= 100_000));
  assert.deepEqual(stream.query(T0, T0 + 10 * MIN, PRINT_FLOOR_USD, 3).map(p => (p.t - T0) / MIN), [7, 8, 9], 'the newest survive a limit');
});

test('prints survive a restart, older ones come from the database, and expired ones are dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-prints-'));
  const file = path.join(dir, 'p.sqlite');
  try {
    let now = T0;
    const first = new PrintStream(file, () => now);
    first.ingest([trade('a', 'buy', 200_000, T0 - 8 * 24 * 3_600_000), trade('b', 'sell', 300_000, T0 - 30 * MIN), trade('c', 'buy', 400_000, T0 - 5 * MIN)]);
    first.flush();
    const db = new DatabaseSync(file);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM prints').get() as { n: number }).n, 2, 'the week-old print was pruned on write');
    db.close();
    first.close();
    now += MIN;
    const again = new PrintStream(file, () => now);
    assert.deepEqual(again.query(T0 - 40 * MIN, T0).map(p => [p.id, p.side, p.usd]), [['x:BTC', 'sell', 300_000], ['x:BTC', 'buy', 400_000]]);
    assert.deepEqual(again.takeFresh(), [], 'reloaded prints are history, not news');
    assert.deepEqual(again.ingest([trade('c', 'buy', 400_000, T0 - 5 * MIN)]), [], 'a trade the feed repeats after a restart is recognised by its content');
    assert.equal(again.ingest([trade('d', 'buy', 400_000, T0)]).length, 1, 'a genuinely new one is not');
    again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
