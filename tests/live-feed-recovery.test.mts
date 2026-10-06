import type { LiveFeedSocket, LiveFeedTransportOptions, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';

// A feed manager that has retired its old feeds and then fails must come back by itself: a server that sat with no feed
// for twelve hours (candles frozen, seven venues stopped) is the failure these tests keep out.

class FakeSocket implements LiveFeedSocket {
  spec: LiveFeedTransportOptions; closed = false;
  onMessage: ((raw: unknown) => void) | undefined; onClose: ((reason: unknown) => void) | undefined; onError: ((error: unknown) => void) | undefined;
  constructor(spec: LiveFeedTransportOptions) { this.spec = spec; }
  async open() { /* connects at once */ }
  send() { /* nothing to say */ }
  close() { this.closed = true; }
}

interface Rig { manager: LiveFeedManager; logs: string[]; failNext: () => void; hangRest: (on: boolean) => void }

function rig(overrides: { startTimeoutMs?: number } = {}): Rig {
  const logs: string[] = [];
  let armed = false, gate: Promise<void> = Promise.resolve(), open: () => void = () => {};
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: async spec => new FakeSocket(spec),
    // While the gate is closed every request waits, as one waits on a dead connection; opening it lets them all finish.
    restTransport: { request: async () => { await gate; return {}; } },
    oiPollMs: 0, reconnectBaseMs: 20, reconnectMaxMs: 60, transportIdleMs: 0,
    startTimeoutMs: overrides.startTimeoutMs,
    log: message => logs.push(message),
    // The first status of the Hyperliquid metadata request throws once: an error out of the middle of start(), after the old feeds are gone.
    onStatus: (status: LiveFeedStatusEvent) => { if (armed && status.id === 'hl-metadata') { armed = false; throw new Error('boom in the middle of start'); } },
  });
  return { manager, logs, failNext: () => { armed = true; }, hangRest: on => { if (on) gate = new Promise<void>(resolve => { open = resolve; }); else open(); } };
}

const until = async (what: string, ok: () => boolean, ms = 4_000) => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const config = { hlBookResolutions: [{}] };

test('a start that throws after retiring the old feeds is retried with the last good configuration', async () => {
  const { manager, logs, failNext } = rig();
  await manager.start(config);
  assert.ok(manager.feeds.size > 0, 'the first start opens feeds');
  failNext();
  await assert.rejects(manager.start(config), /boom in the middle of start/);
  assert.equal(manager.feeds.size, 0, 'the failed start left no feed (the state that used to last forever)');
  assert.equal(manager.startDiagnostics().recoveryPending, true);
  assert.equal(manager.startDiagnostics().lastStart?.ok, false);
  assert.match(String(manager.startDiagnostics().lastStart?.error), /boom/);
  await until('the recovery to reopen the feeds', () => manager.feeds.size > 0 && manager.startDiagnostics().lastStart?.ok === true);
  const after = manager.startDiagnostics();
  assert.equal(after.recoveries, 1);
  assert.equal(after.recoveryPending, false);
  assert.ok(logs.some(line => /feed start failed/.test(line)) && logs.some(line => /feeds restarted/.test(line)), logs.join(' | '));
  manager.stop();
});

test('a newer start takes over from a pending recovery', async () => {
  const { manager, failNext } = rig();
  await manager.start(config);
  failNext();
  await assert.rejects(manager.start(config));
  assert.equal(manager.startDiagnostics().recoveryPending, true);
  await manager.start(config);
  assert.equal(manager.startDiagnostics().recoveryPending, false, 'the new start cancels the timer');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(manager.startDiagnostics().recoveries, 0, 'and nothing restarts behind it');
  assert.ok(manager.feeds.size > 0);
  manager.stop();
});

test('a rejected configuration leaves the running feeds alone', async () => {
  const { manager } = rig();
  await manager.start(config);
  const before = manager.feeds.size;
  await assert.rejects(manager.start({ binanceFamily: 'coinm', binanceMarketType: 'spot' }), /does not|Unsupported/i);
  assert.equal(manager.feeds.size, before, 'validation fails before any feed is retired');
  assert.equal(manager.startDiagnostics().recoveryPending, false);
  manager.stop();
});

test('a manager without a transport arms no recovery: that never mends itself', async () => {
  const manager = new LiveFeedManager({ networkEnabled: true, restTransport: { request: async () => ({}) }, oiPollMs: 0, reconnectBaseMs: 20, reconnectMaxMs: 60 });
  await assert.rejects(manager.start(config), /transportFactory/);
  assert.equal(manager.startDiagnostics().recoveryPending, false);
  assert.equal(manager.startDiagnostics().lastStart?.ok, false);
  manager.stop();
});

test('the liveness check restarts a manager that has specs and no feed', async () => {
  const { manager } = rig();
  await manager.start(config);
  manager.feeds.clear();
  manager.checkLiveness();
  assert.equal(manager.startDiagnostics().recoveryPending, false, 'one empty look is not enough');
  manager.checkLiveness();
  assert.equal(manager.startDiagnostics().recoveryPending, true);
  await until('the feeds to come back', () => manager.feeds.size > 0 && manager.startDiagnostics().recoveries === 1);
  assert.equal(manager.startDiagnostics().lastRecovery?.reason, 'no feed is open');
  manager.stop();
});

test('a start that runs too long is abandoned for a fresh one', async () => {
  const { manager, hangRest } = rig({ startTimeoutMs: 60 });
  hangRest(true);
  const stuck = manager.start(config).catch(() => 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok((manager.startDiagnostics().startingForMs ?? 0) >= 60, 'the start is still waiting on its metadata');
  hangRest(false);
  manager.checkLiveness();
  await until('the second start to open feeds', () => manager.feeds.size > 0 && manager.startDiagnostics().lastStart?.ok === true);
  assert.equal(manager.startDiagnostics().recoveries, 1);
  assert.equal(manager.startDiagnostics().lastRecovery?.reason, 'start timed out');
  await stuck;
  manager.stop();
});

test('a healthy manager and a stopped one are left alone', async () => {
  const { manager } = rig();
  await manager.start(config);
  for (let index = 0; index < 5; index++) manager.checkLiveness();
  assert.equal(manager.startDiagnostics().recoveryPending, false);
  assert.equal(manager.startDiagnostics().recoveries, 0);
  manager.stop();
  manager.feeds.clear();
  for (let index = 0; index < 5; index++) manager.checkLiveness();
  assert.equal(manager.startDiagnostics().recoveryPending, false, 'a manager that was stopped on purpose stays stopped');
});

test('stop() cancels a pending recovery', async () => {
  const { manager, failNext } = rig();
  await manager.start(config);
  failNext();
  await assert.rejects(manager.start(config));
  assert.equal(manager.startDiagnostics().recoveryPending, true);
  manager.stop();
  assert.equal(manager.startDiagnostics().recoveryPending, false);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(manager.feeds.size, 0, 'no feed reopens after stop()');
});
