import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSource } from '../src/app/browser-source.ts';

// The page's side of the feeds worker, against a worker that says what a test tells it to.

(globalThis as { addEventListener?: unknown }).addEventListener ??= () => {};
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  posted: { type: string; id?: number }[] = [];
  postMessage(message: { type: string; id?: number }): void { this.posted.push(message); }
}
const make = () => { const worker = new FakeWorker(); return { worker, source: new BrowserSource(worker as unknown as Worker, { persist: false }) }; };
const say = (worker: FakeWorker, data: unknown): void => worker.onmessage!({ data });
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const quiet = async (run: () => Promise<void>): Promise<void> => { const log = console.error; console.error = () => {}; try { await run(); } finally { console.error = log; } };

test('a worker that fails before it is ready rejects what waits on it, and every request after', async () => {
  await quiet(async () => {
    const { worker, source } = make();
    const boot = source.bootstrap(), candles = source.candles('x:BTC', '1m', 0, 1), venues = source.catalog();
    worker.onerror!({ message: 'the script could not be loaded' });
    await assert.rejects(boot, /could not be loaded/);
    await assert.rejects(candles, /could not be loaded/);
    await assert.rejects(venues, /could not be loaded/);
    await assert.rejects(source.candles('x:BTC', '1m', 0, 1), /could not be loaded/, 'a request made later fails at once, not after the ready that never comes');
  });
});

test('an engine that could not start says so, and nothing waits for it', async () => {
  const { worker, source } = make();
  const boot = source.bootstrap();
  say(worker, { type: 'failed', error: 'the engine could not start' });
  await assert.rejects(boot, /could not start/);
  await assert.rejects(source.oi('x:BTC', '1h', 0, 1), /could not start/);
});

test('an error in a worker that was running fails what was outstanding, and the worker is still asked after that', async () => {
  await quiet(async () => {
    const { worker, source } = make();
    say(worker, { type: 'ready', persisted: false });
    const pending = source.candles('x:BTC', '1m', 0, 1);
    await turn();
    assert.equal(worker.posted.filter(m => m.type === 'rpc').length, 1, 'the request was sent');
    worker.onerror!({ message: 'something threw' });
    await assert.rejects(pending, /something threw/);
    const later = source.candles('x:BTC', '1m', 0, 1);
    await turn();
    const sent = worker.posted.filter(m => m.type === 'rpc');
    assert.equal(sent.length, 2, 'it is not refused: the worker may well be fine');
    say(worker, { type: 'rpc', id: sent[1]!.id, result: [] });
    assert.deepEqual(await later, []);
  });
});

test('the source says what becomes of the recordings of this tab: not known yet, here, with another tab, nowhere, or no longer', () => {
  const later = Date.now() + 60_000;
  const { worker, source } = make();
  assert.equal(source.saving(later), 'starting', 'before the worker is ready');
  say(worker, { type: 'ready', persisted: true });
  assert.equal(source.saving(Date.now()), 'starting', 'ready, but the recorder role is asked for as the engine starts and takes a moment');
  assert.equal(source.saving(later), 'other', 'a minute on, still without the role: another tab has it');
  say(worker, { type: 'recording', recording: true });
  assert.equal(source.saving(later), 'here');
  say(worker, { type: 'recording', recording: false });
  assert.equal(source.saving(later), 'other', 'the role was handed to another tab');
  say(worker, { type: 'recording', recording: false, failed: true });
  assert.equal(source.saving(later), 'failed', 'its storage stopped, which is not another tab having the role');
  const memory = make();
  say(memory.worker, { type: 'ready', persisted: false });
  assert.equal(memory.source.saving(later), 'memory', 'nothing is kept: saving is off or the browser does not allow it');
});
