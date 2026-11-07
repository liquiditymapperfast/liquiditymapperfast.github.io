import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HISTORY_WAITS, PREVIEW_MS, waitOf } from '../src/app/browser/waits.ts';
import type { RpcCall } from '../src/app/browser/protocol.ts';
import { columnReach } from '../src/app/column-holds.ts';

// What the feeds worker's questions wait for while a returning page reads its recordings back: only the map's own load may be answered from
// the newest recordings (it asks again when the history lands); every other reader of columns takes its answer as final.

const columns = (extra: Partial<Extract<RpcCall, { method: 'columns' }>> = {}): RpcCall => ({ method: 'columns', ids: ['a:BTC'], from: 0, to: 60_000, stepMs: 60_000, ...extra });

test('the map\'s own load waits for the newest recordings or the history; any other columns question waits for the history', () => {
  assert.equal(waitOf(columns({ early: true })), 'newest');
  assert.equal(waitOf(columns()), 'history', 'the depth pane, the alerts and the scripts read columns without it');
  assert.equal(waitOf(columns({ early: false })), 'history');
  assert.equal(waitOf(columns({ early: true, close: true })), 'newest');
});

test('the questions about what was recorded wait for the history, the live ones for nothing', () => {
  for (const method of ['footprint', 'prints', 'liquidations', 'printSums', 'sizes', 'profile', 'oiProfile', 'range', 'valueAreas', 'absorption', 'absorptionProfile', 'coverage', 'recover'] as const) {
    assert.ok(HISTORY_WAITS.has(method), method);
    assert.equal(waitOf({ method } as RpcCall), 'history', method);
  }
  for (const method of ['bootstrap', 'candles', 'oi', 'flow'] as const) assert.equal(waitOf({ method } as RpcCall), 'none', method);
  assert.equal(HISTORY_WAITS.size, 14);
});

test('the worker waits as waitOf says, notes a load answered from the newest recordings, and says so with the history', () => {
  const worker = fs.readFileSync('src/app/browser/feeds.worker.ts', 'utf8');
  assert.match(worker, /const wait = historyDone \? 'none' : waitOf\(call\);/);
  assert.match(worker, /wait === 'newest' \? Promise\.race\(\[historyLanded, previewLanded\]\) : historyLanded/);
  assert.match(worker, /const preview = run\.waiting;\s*if \(preview\) columnsEarly = true;/, 'a load answered while the rest is read');
  assert.match(worker, /since: run\.heldSince\(call\.ids, CONTIGUOUS_GAP_MS\), \.\.\.\(preview \? \{ preview \} : \{\}\) \}/, 'and its frame says so');
  assert.match(worker, /post\(\{ type: 'history', [^}]*\.\.\.\(columnsEarly \? \{ columnsEarly: true \} : \{\}\) \}\)/, 'the page is told, to ask again');
  assert.match(worker, /if \(next\.preview\(\{ load: \(\) => columns \}\)\) previewIn\(\);/, 'only newest minutes that hold something answer the map');
  assert.match(worker, /openRecordings\(database, Date\.now\(\) - BROWSER_RETENTION_MS, \(\) => recording, events, \{ since: Date\.now\(\) - PREVIEW_MS, take: newest \}\)/);
});

test('the newest hours read first hold the window the map opens on before the history, with the reach its load asks for', () => {
  const pane = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  assert.match(pane, /span = Math\.max\(75 \* 60_000, \(now - since\) \* 1\.35\);\s*this\.#liveMargin = span \* 0\.08;/, 'the map opens on 75 minutes before the history');
  const MIN = 60_000, now = Date.UTC(2026, 10, 7, 12, 0, 30), span = 75 * MIN, margin = span * 0.08;
  const reach = columnReach({ t0: now + margin - span, t1: now + margin, p0: 0, p1: 1 }, MIN);
  assert.ok(now - reach.from <= PREVIEW_MS, `the load reaches back ${(now - reach.from) / MIN} minutes`);
});
