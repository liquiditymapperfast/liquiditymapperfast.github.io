import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { FlowRecorder } from '../src/server/v2/flow.mts';
import { decodeFlowFrame } from '../src/shared/flow.ts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';

const MIN = 60_000, T0 = 1_800_000_000_000;
const trade = (id: string, side: string, usd: number, t: number, inst = 'x:BTC') => ({ instrumentId: inst, tradeId: id, side, price: 85_000, notionalUsd: usd, sourceTimestamp: t });

test('recorded flow survives a restart and what is past retention is dropped on write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-flow-'));
  const file = path.join(dir, 'f.sqlite');
  try {
    let now = T0 + 30_000;
    const first = new FlowRecorder(file, () => now);
    first.ingest([trade('1', 'buy', 1_000, T0 + 1_000), trade('2', 'sell', 250, T0 + 1_400), trade('3', 'buy', 40, T0 + 59_000)]);
    now = T0 + 2 * MIN; first.flush();
    first.close();
    const db = new DatabaseSync(file);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM flow_minutes').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT length(data) AS n FROM flow_minutes').get() as { n: number }).n, 720, 'one minute is 180 Float32 values: buys, sells and prices');
    db.close();
    const again = new FlowRecorder(file, () => now);
    const series = again.frame(['x:BTC'], T0, T0 + MIN).instruments[0]!;
    assert.equal(series.buy[1], 1_000); assert.equal(series.sell[1], 250); assert.equal(series.buy[59], 40);
    assert.equal(series.px![1], 85_000, 'the price of the second came back with it'); assert.equal(series.px![2], 0);
    assert.deepEqual(again.take(), [], 'reloaded minutes are history, not news');
    now = T0 + 8 * 24 * 3_600_000;
    again.ingest([trade('9', 'buy', 5, now)]); now += MIN; again.flush(); again.close();
    const check = new DatabaseSync(file);
    assert.equal((check.prepare('SELECT COUNT(*) AS n FROM flow_minutes WHERE t = ?').get(T0) as { n: number }).n, 0, 'the week-old minute was pruned');
    check.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the server pushes the seconds that changed, and answers a history request in bytes', async () => {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 20, heartbeatMs: 500 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const pushed: [string, number, number, number, number?][] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
  socket.on('message', (data: unknown) => {
    try { const message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as { t?: string; items?: [string, number, number, number, number?][] }; if (message.t === 'flow') pushed.push(...message.items!); } catch { /* a binary levels frame */ }
  });
  try {
    await new Promise<void>((resolve, reject) => { socket.on('open', () => resolve()); socket.on('error', reject); });
    const now = Date.now();
    (app.state as unknown as { trades: unknown[] }).trades.push(trade('a', 'buy', 5_000, now), trade('b', 'sell', 2_000, now));
    await new Promise<void>(resolve => { const timer = setInterval(() => { if (pushed.length) { clearInterval(timer); resolve(); } }, 20); setTimeout(() => { clearInterval(timer); resolve(); }, 3_000); });
    assert.ok(pushed.length >= 1, 'a flow message arrived');
    assert.equal(pushed.reduce((sum, [, , buy]) => sum + buy, 0) > 0, true);
    const second = Math.floor(now / 1000) * 1000;
    const last = [...pushed].reverse().find(item => item[1] === second);
    assert.deepEqual(last, ['x:BTC', second, 5_000, 2_000, 85_000], 'absolute totals for the second, and its price');
    const response = await fetch(`http://127.0.0.1:${port}/api/v2/flow?inst=x:BTC,missing:BTC&from=${now - MIN}&to=${now + MIN}`);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    const frame = decodeFlowFrame(await response.arrayBuffer());
    assert.deepEqual(frame.instruments.map(i => i.id), ['x:BTC'], 'an instrument with nothing recorded is left out');
    const series = frame.instruments[0]!;
    assert.equal(series.buy.reduce((a, b) => a + b, 0), 5_000); assert.equal(series.sell.reduce((a, b) => a + b, 0), 2_000);
    assert.equal(series.buy[Math.floor((now - series.t0) / 1000)], 5_000);
    assert.equal(series.px![Math.floor((now - series.t0) / 1000)], 85_000);
  } finally {
    socket.terminate(); v2.close();
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
});

test('a database written before prices were kept still loads, and its minutes have no price', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-flow-old-'));
  const file = path.join(dir, 'old.sqlite');
  try {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE flow_minutes (inst TEXT NOT NULL, t INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (inst, t));');
    const data = new Uint8Array(480), floats = new Float32Array(data.buffer); floats[2] = 700; floats[60 + 2] = 100;
    db.prepare('INSERT INTO flow_minutes (inst, t, data) VALUES (?, ?, ?)').run('x:BTC', T0, data);
    db.close();
    const recorder = new FlowRecorder(file, () => T0 + 2 * MIN);
    const series = recorder.frame(['x:BTC'], T0, T0 + MIN).instruments[0]!;
    assert.equal(series.buy[2], 700); assert.equal(series.sell[2], 100); assert.ok(series.px!.every(v => v === 0));
    recorder.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
