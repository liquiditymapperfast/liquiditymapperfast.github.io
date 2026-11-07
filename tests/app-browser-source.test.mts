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
    say(worker, { type: 'ready' });
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
  say(worker, { type: 'ready' });
  assert.equal(source.saving(later), 'starting', 'ready, but the recordings are still being opened (the engine runs on the live feeds meanwhile)');
  say(worker, { type: 'recordings', persisted: true });
  assert.equal(source.saving(Date.now()), 'starting', 'open, but the recorder role is asked for once they are and takes a moment');
  assert.equal(source.saving(later), 'other', 'a minute on, still without the role: another tab has it');
  say(worker, { type: 'recording', recording: true });
  assert.equal(source.saving(later), 'here');
  say(worker, { type: 'recording', recording: false });
  assert.equal(source.saving(later), 'other', 'the role was handed to another tab');
  say(worker, { type: 'recording', recording: true, failed: true });
  assert.equal(source.saving(later), 'failed', 'a write failed and is being tried again');
  say(worker, { type: 'recording', recording: true });
  assert.equal(source.saving(later), 'here', 'a write went through again: saving works, as it did before the failure');
  say(worker, { type: 'recording', recording: false, failed: true });
  assert.equal(source.saving(later), 'failed', 'its storage stopped, which is not another tab having the role');
  const memory = make();
  say(memory.worker, { type: 'ready' });
  say(memory.worker, { type: 'recordings', persisted: false });
  assert.equal(memory.source.saving(later), 'memory', 'nothing is kept: saving is off or the browser does not allow it');
});

test('the worker is told whether the page is shown, at the start and on every change (it has no document; a hidden page reads no far books)', () => {
  let state = 'hidden', listener: (() => void) | null = null;
  (globalThis as { document?: unknown }).document = { get visibilityState() { return state; }, addEventListener: (_: string, fn: () => void) => { listener = fn; } };
  try {
    const { worker } = make();
    const shown = () => worker.posted.filter(m => m.type === 'visible').map(m => (m as unknown as { shown: boolean }).shown);
    assert.deepEqual(shown(), [false]);
    state = 'visible'; listener!();
    assert.deepEqual(shown(), [false, true]);
  } finally { delete (globalThis as { document?: unknown }).document; }
});

test('a start that expects a listed market does not wait for a price, says every market records from this minute, and the bootstraps after it go on saying so until a market says it itself', async () => {
  const { worker, source } = make();
  say(worker, { type: 'ready', persisted: false });
  const answer = async (recorded: Record<string, { first: number; last: number }>): Promise<void> => {
    await turn();
    const rpc = worker.posted.filter(m => m.type === 'rpc').at(-1)!;
    say(worker, { type: 'rpc', id: rpc.id, result: { asOf: 0, now: 0, markPrice: 0, markInstrumentId: '', markets: [{ instrumentId: 'a:BTC' }, { instrumentId: 'b:BTC' }], steps: {}, recorded, columnMs: 60_000, timeframes: [], oiReferences: [] } });
  };
  const first = source.bootstrap({ prefer: 'a:BTC' }); await answer({});
  const one = await first, start = one.recorded['a:BTC']!.first;
  assert.ok(Math.abs(start - Date.now()) <= 120_000 && start % 60_000 === 0, 'this minute');
  assert.equal(one.recorded['b:BTC']!.first, start);
  const second = source.bootstrap(); await answer({ 'a:BTC': { first: start + 60_000, last: start + 60_000 } });
  const two = await second;
  assert.equal(two.recorded['b:BTC']!.first, start, 'no venue of it live yet: still from the start');
  assert.equal(two.recorded['a:BTC']!.first, start + 60_000, 'its own, once it says it');
});

test('the worker says when the recorded history has landed, and the live handlers are told', () => {
  const { worker, source } = make();
  let told = 0;
  source.connect({ onOpen() {}, onClose() {}, onLevels() {}, onTick() {}, onLayers() {}, onPrints() {}, onHistory: () => { told++; } });
  say(worker, { type: 'ready' });
  say(worker, { type: 'recordings', persisted: true });
  assert.equal(told, 0);
  say(worker, { type: 'history' });
  assert.equal(told, 1);
});

test('the history says whether the map was answered from the newest recordings alone meanwhile, and the handlers hear it (to ask again)', () => {
  const told: boolean[] = [];
  for (const columnsEarly of [true, undefined]) {
    const { worker, source } = make();
    source.connect({ onOpen() {}, onClose() {}, onLevels() {}, onTick() {}, onLayers() {}, onPrints() {}, onHistory: early => { told.push(early === true); } });
    say(worker, { type: 'ready' });
    say(worker, { type: 'history', ...(columnsEarly ? { columnsEarly } : {}) });
  }
  assert.deepEqual(told, [true, false]);
});

test('only the map\'s own load asks to be answered early; drawn from the newest recordings is said until a market list read after the history', async () => {
  const { worker, source } = make();
  say(worker, { type: 'ready' });
  const rpcs = (): { type: string; id?: number; method?: string; early?: boolean }[] => worker.posted.filter(m => m.type === 'rpc');
  const answer = async <T,>(ask: Promise<T>, result: unknown): Promise<T> => { await turn(); say(worker, { type: 'rpc', id: rpcs().at(-1)!.id, result }); return ask; };
  const frame = { from: 0, to: 60_000, stepMs: 60_000, instruments: [], since: { 'a:BTC': 1_000 } }, preview = { ...frame, preview: true };
  // Another reader (the depth pane, the alerts, the scripts): no early answer asked for, and none said.
  await answer(source.columns(['a:BTC'], 0, 60_000, 60_000), frame);
  assert.equal('early' in rpcs().at(-1)!, false);
  assert.equal(source.previewing(), false);
  // The map's load, answered from the live engine (a page that keeps no recordings, which never says the history landed): nothing said.
  await answer(source.columns(['a:BTC'], 0, 60_000, 60_000, false, true), frame);
  assert.equal(rpcs().at(-1)!.early, true);
  assert.equal(source.previewing(), false, 'only a frame the worker marks as answered from the newest recordings');
  // Answered from the newest recordings, before the history.
  await answer(source.columns(['a:BTC'], 0, 60_000, 60_000, false, true), preview);
  assert.equal(source.previewing(), true);
  assert.equal(source.depthSince(['a:BTC']), 1_000);
  say(worker, { type: 'history', columnsEarly: true });
  assert.equal(source.previewing(), true, 'until a market list read after the history says where the recording begins');
  const boot = { asOf: 0, now: 0, markPrice: 1, markInstrumentId: 'a:BTC', markets: [{ instrumentId: 'a:BTC' }], steps: {}, recorded: { 'a:BTC': { first: 5, last: 9 } }, columnMs: 60_000, timeframes: [], oiReferences: [] };
  await answer(source.bootstrap(), boot);
  assert.equal(source.previewing(), false);
  // The load asked again after the history is answered from the day, and says where its run begins.
  await answer(source.columns(['a:BTC'], 0, 60_000, 60_000, false, true), { ...frame, since: { 'a:BTC': 500 } });
  assert.equal(source.previewing(), false);
  assert.equal(source.depthSince(['a:BTC']), 500);
});

test('handlers connected after the history landed are told at once: what was asked before them may predate it', async () => {
  const { worker, source } = make();
  say(worker, { type: 'ready' });
  say(worker, { type: 'history' });
  let told = 0;
  source.connect({ onOpen() {}, onClose() {}, onLevels() {}, onTick() {}, onLayers() {}, onPrints() {}, onHistory: () => { told++; } });
  await turn();
  assert.equal(told, 1);
});
