import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';

test('the live socket speaks every heartbeat even when nothing else changes, so a client can tell a quiet server from a dead connection', async () => {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 20, heartbeatMs: 120 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const beats: number[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
  socket.on('message', (data: unknown) => {
    try { const message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as { t?: string }; if (message.t === 'hb') beats.push(Date.now()); } catch { /* a binary levels frame */ }
  });
  try {
    await new Promise<void>(resolve => { const timer = setInterval(() => { if (beats.length >= 3) { clearInterval(timer); resolve(); } }, 25); setTimeout(() => { clearInterval(timer); resolve(); }, 3_000); });
    assert.ok(beats.length >= 3, `three heartbeats within three seconds, got ${beats.length}`);
    assert.ok(beats[2]! - beats[0]! >= 150, 'they are spaced by the interval, not sent on every loop');
  } finally {
    socket.terminate(); v2.close();
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
});
