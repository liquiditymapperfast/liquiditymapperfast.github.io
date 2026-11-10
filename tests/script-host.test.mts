import test from 'node:test';
import assert from 'node:assert/strict';
import { ScriptHost, type WorkerLike } from '../src/app/script/host.ts';
import type { RunRequest, RunResponse, ScriptJob } from '../src/app/script/protocol.ts';
import type { BarInputs } from '../src/app/script/inputs.ts';
import { FULL_RUN_MS } from '../src/app/script/lang/analysis.ts';

class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: RunResponse }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  posted: RunRequest[] = [];
  ended = false;
  postMessage(m: RunRequest): void { this.posted.push(m); }
  terminate(): void { this.ended = true; }
  ready(): void { this.onmessage?.({ data: { t: 'ready' } }); }
  answer(seq: number, ids: string[]): void { this.onmessage?.({ data: { t: 'result', seq, results: ids.map(id => ({ id, ok: true, plots: [], warnings: [], steps: 1, ms: 1 })) } }); }
}

const inputs = (): BarInputs => { const a = new Float64Array(1); return { tf: 60_000, time: a, open: new Float64Array(1), high: new Float64Array(1), low: new Float64Array(1), close: new Float64Array(1), volume: new Float64Array(1), sources: {}, forming: false }; };
const job = (id: string): ScriptJob => ({ id, source: 'line(1)', options: {}, api: 1 });

function rig(autoReady = true) {
  const workers: FakeWorker[] = [], timers: { fn: () => void; ms: number; cleared: boolean }[] = [], clock = { now: 0 };
  const host = new ScriptHost({
    spawn: () => { const w = new FakeWorker(); workers.push(w); queueMicrotask(() => { if (autoReady) w.ready(); }); return w; },
    deadlineMs: 1_000, perScriptMs: 0,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: t => { (t as { cleared: boolean }).cleared = true; },
    now: () => clock.now,
  });
  return { host, workers, timers, clock };
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

test('a run is answered with one result per script, in the order asked', async () => {
  const { host, workers } = rig();
  const p = host.run([job('a'), job('b')], inputs());
  assert.equal(workers.length, 1);
  await tick();
  const sent = workers[0]!.posted[0]!;
  workers[0]!.answer(sent.seq, ['b', 'a']);
  const r = await p;
  assert.deepEqual(r.results.map(x => x.id), ['a', 'b']);
  assert.equal(host.busy, false);
});

test('while a run is under way the newest request waits and an older waiting one is dropped', async () => {
  const { host, workers } = rig();
  const first = host.run([job('a')], inputs());
  await tick();
  const second = host.run([job('b')], inputs());
  const third = host.run([job('c')], inputs());
  assert.deepEqual((await second).results, [], 'overtaken before it started');
  workers[0]!.answer(workers[0]!.posted[0]!.seq, ['a']);
  assert.equal((await first).results[0]!.id, 'a');
  assert.equal(workers[0]!.posted.length, 2);
  workers[0]!.answer(workers[0]!.posted[1]!.seq, ['c']);
  assert.equal((await third).results[0]!.id, 'c');
});

test('a run past its deadline ends its worker, reports every script stopped, and the next run gets a fresh worker', async () => {
  const { host, workers, timers } = rig();
  const p = host.run([job('a'), job('b')], inputs());
  await tick();
  const deadline = timers.find(t => t.ms === 1_000 && !t.cleared)!;
  deadline.fn();
  const r = await p;
  assert.ok(r.results.every(x => !x.ok && x.error.code === 'timeout'));
  assert.equal(workers[0]!.ended, true);
  assert.equal(host.restarts, 1);
  // A late answer from the ended worker changes nothing.
  workers[0]!.answer(1, ['a']);
  const q = host.run([job('a')], inputs());
  assert.equal(workers.length, 2);
  await tick();
  workers[1]!.answer(workers[1]!.posted[0]!.seq, ['a']);
  assert.equal((await q).results[0]!.ok, true);
  assert.ok(timers.filter(t => t.ms === 1_000).every(t => t.cleared || t === deadline), 'an answered run clears its deadline');
});

test('a worker that fails stops its run, and an answer to an older run is ignored', async () => {
  const { host, workers } = rig();
  const p = host.run([job('a')], inputs());
  await tick();
  workers[0]!.answer(999, ['a']);
  assert.equal(host.busy, true);
  workers[0]!.onerror?.(new Error('load'));
  const r = (await p).results;
  assert.equal(!r[0]!.ok && r[0]!.error.code, 'worker-failed');
});

test('the clock of a run starts only once its worker has loaded, and a worker that never loads is given up on', async () => {
  const { host, workers, timers } = rig(false);
  const p = host.run([job('a')], inputs());
  assert.equal(workers[0]!.posted.length, 0, 'nothing is sent before the worker says it has loaded');
  assert.ok(!timers.some(t => t.ms === 1_000), 'no run deadline yet: loading is not running');
  workers[0]!.ready();
  assert.equal(workers[0]!.posted.length, 1);
  assert.ok(timers.some(t => t.ms === 1_000 && !t.cleared));
  workers[0]!.answer(workers[0]!.posted[0]!.seq, ['a']);
  assert.equal((await p).results[0]!.ok, true);
  const second = rig(false);
  const q = second.host.run([job('b')], inputs());
  second.timers.find(t => t.ms !== 1_000)!.fn();
  const r = (await q).results;
  assert.equal(!r[0]!.ok && r[0]!.error.code, 'worker-failed');
  assert.equal(second.workers[0]!.ended, true);
});

test('a run\'s time is counted from when its worker took it: a long wait to load is not a slow script', async () => {
  const { host, workers, timers, clock } = rig(false);
  const p = host.run([job('a')], inputs());
  assert.ok(timers.some(t => t.ms >= 60_000), 'a worker has minutes to load (the page\'s own requests can hold every connection to its server)');
  clock.now = 45_000;
  workers[0]!.ready();
  clock.now = 45_200;
  workers[0]!.answer(workers[0]!.posted[0]!.seq, ['a']);
  assert.equal((await p).ms, 200);
  const q = host.run([job('a')], inputs());
  clock.now = 46_200;
  timers.find(t => t.ms === 1_000 && !t.cleared)!.fn();
  assert.equal((await q).ms, 1_000, 'a run past its deadline took that long');
  const never = rig(false);
  const r = never.host.run([job('b')], inputs());
  never.clock.now = 120_000;
  never.timers.find(t => t.ms !== 1_000)!.fn();
  assert.equal((await r).ms, 0, 'a worker that never loaded ran nothing');
});

test('a run still waiting for its worker to load is replaced by a newer one, or dropped: the worker never runs scripts changed meanwhile', async () => {
  const { host, workers } = rig(false);
  const old = host.run([job('old')], inputs());
  assert.equal(host.loading, true);
  const newer = host.run([job('new')], inputs());
  assert.deepEqual(await old, { results: [], ms: 0 }, 'replaced before its worker took it');
  workers[0]!.ready();
  assert.deepEqual(workers[0]!.posted.map(m => m.jobs.map(j => j.id)), [['new']], 'only the newer scripts are sent');
  assert.equal(host.loading, false);
  workers[0]!.answer(workers[0]!.posted[0]!.seq, ['new']);
  assert.equal((await newer).results[0]!.id, 'new');

  const second = rig(false);
  const off = second.host.run([job('a')], inputs());
  second.host.dropUnsent();
  assert.deepEqual(await off, { results: [], ms: 0 });
  assert.equal(second.host.busy, false);
  second.workers[0]!.ready();
  assert.equal(second.workers[0]!.posted.length, 0, 'switched off before the worker loaded: nothing runs');
  const later = second.host.run([job('b')], inputs());
  assert.equal(second.workers.length, 1, 'the loaded worker is kept for the next run');
  assert.equal(second.workers[0]!.posted.length, 1);
  second.workers[0]!.answer(second.workers[0]!.posted[0]!.seq, ['b']);
  assert.equal((await later).results[0]!.ok, true);
  second.host.dropUnsent();
  assert.equal(second.host.busy, false, 'nothing to drop once a run was taken and answered');

  // A worker whose run was dropped and that then fails to load is let go: the next run gets a fresh worker and does not wait for it.
  const third = rig(false);
  void third.host.run([job('a')], inputs());
  third.host.dropUnsent();
  third.workers[0]!.onerror?.(new Error('load'));
  assert.equal(third.workers[0]!.ended, true);
  void third.host.run([job('b')], inputs());
  assert.equal(third.workers.length, 2);
  third.workers[1]!.ready();
  assert.deepEqual(third.workers[1]!.posted.map(m => m.jobs.map(j => j.id)), [['b']]);
});

test('a worker can be started before any run, and the first run is then sent as soon as it is asked for', async () => {
  const { host, workers } = rig();
  host.warm();
  host.warm();
  assert.equal(workers.length, 1, 'one worker');
  assert.equal(host.busy, false);
  await tick();
  const p = host.run([job('a')], inputs());
  assert.equal(workers[0]!.posted.length, 1, 'already loaded: sent at once');
  workers[0]!.answer(workers[0]!.posted[0]!.seq, ['a']);
  assert.equal((await p).results[0]!.ok, true);
});

test('by default each script of a run has the time of a run from the first candle, the first a little more', async () => {
  const timers: number[] = [];
  const host = new ScriptHost({
    spawn: () => { const w = new FakeWorker(); queueMicrotask(() => w.ready()); return w; },
    setTimer: (_fn, ms) => { timers.push(ms); return {}; }, clearTimer: () => {},
  });
  void host.run([job('a'), job('b')], inputs());
  await tick();
  assert.equal(timers.at(-1), FULL_RUN_MS + 1_500 + FULL_RUN_MS + 100, 'a script stops itself at that time inside the worker (too-slow); the host only ends a worker that hangs');
  host.dispose();
});

test('disposing ends the worker and answers what waited with nothing and no time', async () => {
  const { host, workers } = rig(false);
  const p = host.run([job('a')], inputs());
  host.dispose();
  assert.deepEqual(await p, { results: [], ms: 0 });
  assert.equal(workers[0]!.ended, true);
});

test('a host with no worker has no generation: the depth posted next goes to a fresh worker, so it is sent whole', async () => {
  const { host, workers, timers } = rig();
  const p = host.run([job('a')], inputs());
  await tick();
  const first = host.generation;
  assert.ok(first > 0);
  timers.find(t => t.ms === 1_000 && !t.cleared)!.fn();
  await p;
  assert.equal(workers[0]!.ended, true);
  assert.equal(host.generation, -1, 'its worker ended, none started yet');
  host.post({ t: 'depth', key: '1m', revision: 1, prev: -1, reset: true, books: [], drop: [] });
  assert.equal(workers.length, 2);
  assert.ok(host.generation > first);
});
