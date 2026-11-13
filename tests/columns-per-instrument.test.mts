import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/app/hub.ts';
import { ColumnHolds, COLUMNS_BEHIND_MS, COLUMNS_FULL_EVERY_MS, COLUMN_STEPS_HELD, columnReach, settledBefore } from '../src/app/column-holds.ts';
import { RecordedColumns, toStore, type ColumnStore } from '../src/app/worker/column-store.ts';
import type { Bounds } from '../src/app/view.ts';
import { Store, initialState } from '../src/app/store.ts';
import type { BootstrapState, DataSource } from '../src/app/source.ts';
import type { ColumnSet, ColumnsFrame } from '../src/app/wire.ts';

/**
 * The recorded columns are asked for instrument by instrument: a book that comes or goes, or a zoom back to a step already held, no longer
 * asks the source for the whole window of every instrument again (measured on a live server: a flap of the book list re-asked 5-27 MB each time).
 */

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 12, 6, 0);

class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; posted: Posted[] = []; /** Everything ever posted (`posted` is cleared by the tests that look at what follows a step). */ all: Posted[] = []; postMessage(message: Posted): void { this.posted.push(message); this.all.push(message); } }
interface Posted { type: string; stepMs?: number; from?: number; ids?: string[] | null; instruments?: { id: string }[] }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

class ColumnSource {
  readonly kind = 'server' as const;
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  asked: { ids: string[]; from: number; to: number; stepMs: number }[] = [];
  hold: Promise<void> | null = null;
  /** The price grid each market is answered on (10 unless told otherwise). */
  grids = new Map<string, number>();
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: 'a:BTC', markets: [{ instrumentId: 'a:BTC' }], layers: {}, steps: {}, recorded: {}, columnMs: MIN, timeframes: [], oiReferences: [] };
  }
  connect(): { close(): void; tape(on: boolean): void } { return { close() {}, tape() {} }; }
  async candles() { return []; }
  async oi() { return []; }
  async prints() { return []; }
  async flow() { return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
  /** The nth call from now (1: the next) throws, once. */
  failIn: number | null = null;
  async columns(ids: string[], from: number, to: number, stepMs: number): Promise<ColumnsFrame> {
    this.asked.push({ ids: [...ids], from, to, stepMs });
    if (this.failIn !== null && --this.failIn === 0) { this.failIn = null; throw new Error('source-down'); }
    if (this.hold) await this.hold;
    return { from, to, stepMs, instruments: ids.filter(id => !this.omit.has(id)).map(id => ({ id, step: this.grids.get(id) ?? 10, times: [], counts: [], samples: [], bins: new Int32Array(0), bid: new Float32Array(0), ask: new Float32Array(0) })) };
  }
  /** Markets the source leaves out of its answers. */
  omit = new Set<string>();
}

/** A hub on a fake source and worker, a clock the test moves, and the books the page lists. */
async function harness(clockAt = T0, ids: string[] = []) {
  const realNow = Date.now;
  const clock = { now: clockAt };
  Date.now = () => clock.now;
  const store = new Store(initialState()), source = new ColumnSource();
  const hub = new Hub(store, source as unknown as DataSource), worker = hub.worker as unknown as FakeWorker;
  worker.onmessage!({ data: { type: 'ready' } });
  await hub.start();
  const books = (list: readonly string[]): void => store.set({ levels: { asOf: clock.now, books: list.map(id => ({ id })) } as never });
  books(ids);
  /** The live view of this many hours on 180 px: columns of 4 min for 6 h, 8 min for 12 h, 16 min for 24 h, 32 min for 48 h. */
  const live = (hours: number) => ({ t0: clock.now - hours * HOUR, t1: clock.now + 10 * MIN, p0: 0, p1: 1 });
  const refresh = async (hours: number): Promise<void> => { hub.invalidateColumns(); await hub.loadColumns(live(hours), 180); };
  const types = () => worker.posted.map(m => m.type === 'columnsUse' || m.type === 'columnsDrop' ? `${m.type}:${m.stepMs! / MIN}${m.ids ? ':' + m.ids.join('+') : ''}` : m.type === 'columns' || m.type === 'columnsTail' ? `${m.type}:${m.stepMs! / MIN}:${m.instruments!.map(s => s.id).join('+')}` : m.type);
  return { clock, store, source, hub, worker, books, live, refresh, types, restore: () => { Date.now = realNow; } };
}
/**
 * The page and the worker are kept in step by messages alone: replay everything posted to the worker into a real `RecordedColumns` and compare
 * it with what the hub believes it holds (`omitted`: books held that have nothing in the worker, a source having left them out of its answer).
 */
function assertMirror(h: Awaited<ReturnType<typeof harness>>, omitted: readonly string[] = []): void {
  const rec = new RecordedColumns(MIN);
  for (const m of h.worker.all) {
    if (m.type === 'columns') rec.set(m.stepMs!, m.instruments as unknown as ColumnSet[]);
    else if (m.type === 'columnsTail') rec.tail(m.stepMs!, m.from!, m.instruments as unknown as ColumnSet[]);
    else if (m.type === 'columnsUse') rec.use(m.stepMs!);
    else if (m.type === 'columnsDrop') rec.drop(m.stepMs!, m.ids!);
  }
  const held = h.hub.heldColumns().map(step => ({ stepMs: step.stepMs, ids: step.ids.filter(id => !omitted.includes(id)).sort() })).filter(step => step.ids.length);
  assert.deepEqual(rec.steps().sort((a, b) => a - b), held.map(step => step.stepMs).sort((a, b) => a - b), 'the steps the worker holds are the ones the page believes it does');
  for (const step of held) assert.deepEqual(rec.ids(step.stepMs).sort(), step.ids, `the books at ${step.stepMs / MIN} min`);
  assert.equal(rec.stepMs, h.hub.columnStepMs, 'the step the worker reads is the one the panes are told');
}
const SIX = 6, TWELVE = 12, DAY = 24, TWO_DAYS = 48;
const ids26 = Array.from({ length: 26 }, (_, i) => `v${i}:BTC`);

test('a book list that flaps 26 -> 25 -> 24 -> 26 asks the source nothing after the first answer', async () => {
  const h = await harness(T0, ids26);
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    assert.equal(h.source.asked.length, 1);
    assert.equal(h.source.asked[0]!.ids.length, 26);
    assert.deepEqual(h.types(), ['columns:4:' + ids26.join('+'), 'columnsUse:4']);
    const version = h.hub.columnsVersion;
    for (const list of [ids26.slice(0, 25), ids26.slice(0, 24), ids26, ids26.slice(1)]) {
      h.books(list);
      await h.hub.loadColumns(h.live(SIX), 180);
    }
    assert.equal(h.source.asked.length, 1, 'no request for a book that goes, or one that comes back');
    assert.equal(h.worker.posted.length, 2, 'and nothing told to the worker: it holds a superset, the panes read the books they ask for');
    assert.equal(h.hub.columnsVersion, version, 'the panes have nothing new to read');
    assertMirror(h);
  } finally { h.restore(); }
});

test('a book never held asks for itself alone, over the reach of the view', async () => {
  const h = await harness(T0, ids26);
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    h.books([...ids26, 'new:BTC']);
    await h.hub.loadColumns(h.live(SIX), 180);
    assert.equal(h.source.asked.length, 2);
    assert.deepEqual(h.source.asked[1], { ids: ['new:BTC'], from: columnReach(h.live(SIX), 4 * MIN).from, to: T0 + MIN, stepMs: 4 * MIN });
    assert.deepEqual(h.types().slice(2), ['columns:4:new:BTC']);
    const version = h.hub.columnsVersion;
    // It is held from now on: it leaves and comes back for nothing, and a refresh asks for all of them in one tail.
    h.books(ids26); await h.hub.loadColumns(h.live(SIX), 180);
    h.books([...ids26, 'new:BTC']); await h.hub.loadColumns(h.live(SIX), 180);
    assert.equal(h.source.asked.length, 2);
    h.clock.now += 30_000; await h.refresh(SIX);
    assert.equal(h.source.asked.length, 3);
    assert.equal(h.source.asked[2]!.ids.length, 27);
    assert.equal(h.source.asked[2]!.from, settledBefore(T0, 4 * MIN));
    assert.ok(h.hub.columnsVersion > version);
    assertMirror(h);
  } finally { h.restore(); }
});

test('a step held is read again with no request, through three steps and back', async () => {
  const h = await harness(T0, ids26.slice(0, 5));
  try {
    const seen: number[] = [];
    for (const hours of [SIX, TWELVE, DAY]) { await h.hub.loadColumns(h.live(hours), 180); seen.push(h.hub.columnStepMs); }
    assert.deepEqual(seen, [4 * MIN, 8 * MIN, 16 * MIN]);
    assert.equal(h.source.asked.length, 3, 'one question to the source per step');
    const version = h.hub.columnsVersion;
    for (const hours of [TWELVE, SIX]) { await h.hub.loadColumns(h.live(hours), 180); seen.push(h.hub.columnStepMs); }
    assert.deepEqual(seen.slice(3), [8 * MIN, 4 * MIN]);
    assert.equal(h.source.asked.length, 3, 'a zoom back asks for nothing');
    assert.deepEqual(h.types().slice(-2), ['columnsUse:8', 'columnsUse:4']);
    assert.equal(h.hub.columnsVersion, version + 2, 'each switch tells the panes');
    // The data of a step is posted before the step is read, and a step is read once all its books are held.
    const order = h.types();
    assert.ok(order.indexOf('columns:8:' + ids26.slice(0, 5).join('+')) < order.indexOf('columnsUse:8'));
    assertMirror(h);
  } finally { h.restore(); }
});

test('a step that was not read is brought up from where it settled when it comes back, and read at once', async () => {
  const h = await harness(T0, ids26.slice(0, 3));
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    await h.hub.loadColumns(h.live(TWELVE), 180);
    // Ten minutes at the wider step, refreshed there; the narrow one is not.
    for (let k = 1; k <= 20; k++) { h.clock.now += 30_000; await h.refresh(TWELVE); }
    const asked = h.source.asked.length;
    h.worker.posted.length = 0;
    await h.hub.loadColumns(h.live(SIX), 180);
    assert.equal(h.source.asked.length, asked + 1);
    assert.deepEqual(h.source.asked.at(-1), { ids: ids26.slice(0, 3), from: settledBefore(T0, 4 * MIN), to: h.clock.now + MIN, stepMs: 4 * MIN }, 'the minutes it missed, not the window');
    assert.deepEqual(h.types(), ['columnsUse:4', 'columnsTail:4:' + ids26.slice(0, 3).join('+')], 'what is there is read at once and the tail follows');
    assertMirror(h);
  } finally { h.restore(); }
});

test('a book away for a while is brought up from where it settled, on its own, with no refresh mark', async () => {
  const h = await harness(T0, ids26.slice(0, 3));
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    h.books(ids26.slice(0, 2));
    for (let k = 1; k <= 6; k++) { h.clock.now += 30_000; await h.refresh(SIX); }
    assert.deepEqual(h.source.asked.at(-1)!.ids, ids26.slice(0, 2), 'the refresh leaves the absent book alone');
    const asked = h.source.asked.length;
    h.books(ids26.slice(0, 3));
    await h.hub.loadColumns(h.live(SIX), 180);
    assert.equal(h.source.asked.length, asked + 1, 'it is behind the others by more than the refresh spacing');
    assert.deepEqual(h.source.asked.at(-1), { ids: [ids26[2]!], from: settledBefore(T0, 4 * MIN), to: h.clock.now + MIN, stepMs: 4 * MIN });
    await h.hub.loadColumns(h.live(SIX), 180);
    assert.equal(h.source.asked.length, asked + 1);
    assert.ok(COLUMNS_BEHIND_MS > 30_000, 'a book only a refresh behind is left to the next mark');
    assertMirror(h);
  } finally { h.restore(); }
});

test('a book is forgotten once its window is an hour old and the view does not list it, and a step not read likewise', async () => {
  const h = await harness(T0, ids26.slice(0, 3));
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    await h.hub.loadColumns(h.live(TWELVE), 180);
    h.worker.posted.length = 0;
    // An hour and a minute on, at the wider step with one book fewer: the narrow step's books are all forgotten, and the book that is gone.
    h.clock.now += COLUMNS_FULL_EVERY_MS + MIN;
    h.books(ids26.slice(0, 2));
    await h.hub.loadColumns(h.live(TWELVE), 180);
    const types = h.types();
    assert.ok(types.includes(`columnsDrop:4:${ids26.slice(0, 3).join('+')}`), types.join(' | '));
    assert.ok(types.includes(`columnsDrop:8:${ids26[2]}`), types.join(' | '));
    assert.ok(!types.includes('columnsDrop:8:' + ids26[0]), 'a book the view lists is not dropped, it is asked for whole again');
    assert.equal(h.source.asked.at(-1)!.ids.length, 2);
    assert.equal(h.source.asked.at(-1)!.from, columnReach(h.live(TWELVE), 8 * MIN).from);
    // The narrow step is gone: coming back to it asks for it whole.
    const asked = h.source.asked.length;
    await h.hub.loadColumns(h.live(SIX), 180);
    assert.equal(h.source.asked.length, asked + 1);
    assert.equal(h.source.asked.at(-1)!.from, columnReach(h.live(SIX), 4 * MIN).from);
    assertMirror(h);
  } finally { h.restore(); }
});

test('only the last few steps are held: the one wanted longest ago is dropped, never the one drawn', async () => {
  const h = await harness(T0, ids26.slice(0, 3));
  try {
    assert.equal(COLUMN_STEPS_HELD, 3);
    for (const hours of [SIX, TWELVE, DAY]) await h.hub.loadColumns(h.live(hours), 180);
    assert.ok(!h.types().some(t => t.startsWith('columnsDrop')), 'three steps fit');
    await h.hub.loadColumns(h.live(TWO_DAYS), 180);
    assert.deepEqual(h.types().filter(t => t.startsWith('columnsDrop')), ['columnsDrop:4'], 'the first, and whole');
    const asked = h.source.asked.length;
    await h.hub.loadColumns(h.live(TWELVE), 180);
    assert.equal(h.source.asked.length, asked, 'the others are still held');
    await h.hub.loadColumns(h.live(SIX), 180);
    assert.equal(h.source.asked.length, asked + 1, 'the dropped one is asked for again');
    assert.deepEqual(h.types().filter(t => t.startsWith('columnsDrop')), ['columnsDrop:4', 'columnsDrop:16'], 'and then the one wanted longest ago');
    assertMirror(h);
  } finally { h.restore(); }
});

test('a market whose price grid changed is asked for whole again, and no other', async () => {
  const h = await harness(T0, ids26.slice(0, 3));
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    h.source.grids.set(ids26[1]!, 20);
    h.clock.now += 30_000; h.worker.posted.length = 0;
    await h.refresh(SIX);
    assert.equal(h.source.asked.length, 3, 'the refresh, and the whole window of the market');
    assert.deepEqual(h.source.asked[2], { ids: [ids26[1]!], from: columnReach(h.live(SIX), 4 * MIN).from, to: h.clock.now + MIN, stepMs: 4 * MIN });
    assert.deepEqual(h.types(), ['columnsTail:4:' + [ids26[0], ids26[2]].join('+'), 'columns:4:' + ids26[1]], 'the others went on with their tail');
    h.clock.now += 30_000; await h.refresh(SIX);
    assert.equal(h.source.asked.at(-1)!.ids.length, 3, 'and the market is refreshed with the rest on its new grid');
    assert.equal(h.worker.posted.at(-1)!.type, 'columnsTail');
    assertMirror(h);
  } finally { h.restore(); }
});

test('a step held is read while another step is still being asked for, and the late answer does not take it back', async () => {
  const h = await harness(T0, ids26.slice(0, 3));
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    await h.hub.loadColumns(h.live(TWELVE), 180);
    let release!: () => void;
    h.source.hold = new Promise(resolve => { release = resolve; });
    const loading = h.hub.loadColumns(h.live(DAY), 180);
    assert.equal(h.hub.columnStepMs, 8 * MIN);
    await h.hub.loadColumns(h.live(SIX), 180);
    assert.equal(h.hub.columnStepMs, 4 * MIN, 'read at once, with the other still on its way');
    release(); await loading; h.source.hold = null;
    assert.equal(h.hub.columnStepMs, 4 * MIN, 'the step asked for before is held now, but it is not the one wanted');
    assert.ok(!h.types().includes('columnsUse:16'));
    await h.hub.loadColumns(h.live(DAY), 180);
    assert.equal(h.hub.columnStepMs, 16 * MIN);
    assertMirror(h);
  } finally { h.restore(); }
});

test('a market the source leaves out of its answer is not asked for again on every frame', async () => {
  const h = await harness(T0, ids26.slice(0, 3));
  try {
    h.source.omit.add(ids26[1]!);
    await h.hub.loadColumns(h.live(SIX), 180);
    for (let k = 0; k < 5; k++) await h.hub.loadColumns(h.live(SIX), 180);
    assert.equal(h.source.asked.length, 1);
    assert.deepEqual(h.types(), ['columns:4:' + [ids26[0], ids26[2]].join('+'), 'columnsUse:4'], 'only what came back is handed to the worker');
    h.clock.now += 30_000; await h.refresh(SIX);
    assert.deepEqual(h.source.asked.at(-1)!.ids, ids26.slice(0, 3), 'and it goes on with the others in the refresh');
    assertMirror(h, [ids26[1]!]);
  } finally { h.restore(); }
});

test('a step the view wants now is not the one dropped to make room, whatever else is being loaded', async () => {
  const h = await harness(T0, ids26.slice(0, 3));
  try {
    for (const hours of [SIX, TWELVE, DAY]) await h.hub.loadColumns(h.live(hours), 180);
    let release!: () => void;
    h.source.hold = new Promise(resolve => { release = resolve; });
    const loading = h.hub.loadColumns(h.live(TWO_DAYS), 180);
    // Meanwhile a zoom back to the first step, panned away from what it holds: it asks for nothing now, and is the one wanted.
    const away = { t0: T0 - 66 * HOUR, t1: T0 - 60 * HOUR, p0: 0, p1: 1 };
    await h.hub.loadColumns(away, 180);
    release(); await loading; h.source.hold = null;
    const drops = h.types().filter(t => t.startsWith('columnsDrop'));
    assert.deepEqual(drops, ['columnsDrop:8'], 'the step wanted longest ago that nothing wants now');
    assert.deepEqual(h.hub.heldColumns().map(s => s.stepMs / MIN).sort((a, b) => a - b), [4, 16, 32]);
    assertMirror(h);
  } finally { h.restore(); }
});

test('a load for a step nobody wants any more stops after the answer it is waiting for, and the step wanted loads next', async () => {
  const h = await harness(T0, [ids26[0]!]);
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    h.books([ids26[0]!, ids26[1]!]);
    h.clock.now += 30_000; h.hub.invalidateColumns();
    let release!: () => void;
    h.source.hold = new Promise(resolve => { release = resolve; });
    const before = h.source.asked.length;
    const loading = h.hub.loadColumns(h.live(SIX), 180);
    assert.equal(h.source.asked.length, before + 1, 'the refresh of the book held, with the whole window of the new one to follow');
    await h.hub.loadColumns(h.live(TWELVE), 180);
    release(); await loading; h.source.hold = null;
    assert.equal(h.source.asked.length, before + 1, 'the whole window of the new book is not asked for at a step nobody wants');
    await h.hub.loadColumns(h.live(TWELVE), 180);
    assert.deepEqual(h.source.asked.at(-1)!.ids, [ids26[0]!, ids26[1]!], 'the step wanted loads at once');
    assert.equal(h.hub.columnStepMs, 8 * MIN);
    assertMirror(h);
  } finally { h.restore(); }
});

test('an answer is judged against the view it was asked for, not the one the pane has moved on to', async () => {
  const h = await harness(T0, ids26.slice(0, 3));
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    const view: Bounds = h.live(TWELVE);
    let release!: () => void;
    h.source.hold = new Promise(resolve => { release = resolve; });
    const loading = h.hub.loadColumns(view, 180);
    view.t0 -= 120 * HOUR; view.t1 -= 120 * HOUR;
    release(); await loading; h.source.hold = null;
    assert.equal(h.hub.columnStepMs, 8 * MIN, 'what was asked for is read, as before');
    assertMirror(h);
  } finally { h.restore(); }
});

test('a step held for only some of the books is read once the others have arrived, not before', async () => {
  const [a, b] = [ids26[0]!, ids26[1]!];
  const h = await harness(T0, [a, b]);
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    await h.hub.loadColumns(h.live(TWELVE), 180);
    // The market's price grid changes: what the narrow step holds for it is forgotten there too.
    h.source.grids.set(b, 20);
    h.clock.now += 30_000; await h.refresh(TWELVE);
    assert.deepEqual(h.hub.heldColumns().find(s => s.stepMs === 4 * MIN)?.ids, [a], 'the narrow step has the book that did not change');
    assert.ok(h.types().includes(`columnsDrop:4:${b}`), h.types().join(' | '));
    let release!: () => void;
    h.source.hold = new Promise(resolve => { release = resolve; });
    const loading = h.hub.loadColumns(h.live(SIX), 180);
    await Promise.resolve();
    assert.equal(h.hub.columnStepMs, 8 * MIN, 'the wide step goes on being read while the narrow one lacks a book');
    const readNarrow = () => h.types().filter(t => t === 'columnsUse:4').length;
    assert.equal(readNarrow(), 1, 'only the first time, when the narrow step was loaded');
    release(); await loading; h.source.hold = null;
    assert.equal(readNarrow(), 2);
    assert.equal(h.hub.columnStepMs, 4 * MIN);
    assertMirror(h);
  } finally { h.restore(); }
});

test('a source that fails half way keeps what it answered, and the rest is asked for again', async () => {
  const [a, b, c] = [ids26[0]!, ids26[1]!, ids26[2]!];
  const h = await harness(T0, [a, b]);
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    h.books([a, b, c]);
    h.clock.now += 30_000; h.hub.invalidateColumns();
    h.source.failIn = 2;
    await assert.rejects(h.hub.loadColumns(h.live(SIX), 180), /source-down/);
    assert.equal(h.source.asked.length, 3, 'the refresh, and the whole window of the new book, which failed');
    assert.deepEqual(h.hub.heldColumns()[0]!.ids.sort(), [a, b], 'the refresh was recorded, the failed book is not held');
    assertMirror(h);
    await h.hub.loadColumns(h.live(SIX), 180);
    assert.deepEqual(h.source.asked.at(-1)!.ids, [c], 'only what failed is asked for again');
    assertMirror(h);
  } finally { h.restore(); }
});

test('what is drawn is not forgotten for being an hour old while another step is being loaded, and is once it is not drawn', async () => {
  const h = await harness(T0, ids26.slice(0, 2));
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    h.clock.now += COLUMNS_FULL_EVERY_MS + MIN;
    let release!: () => void;
    h.source.hold = new Promise(resolve => { release = resolve; });
    const loading = h.hub.loadColumns(h.live(TWELVE), 180);
    assert.ok(!h.types().some(t => t.startsWith('columnsDrop')), 'the step on screen keeps its books while the other loads');
    release(); await loading; h.source.hold = null;
    await h.hub.loadColumns(h.live(TWELVE), 180);
    assert.ok(h.types().includes(`columnsDrop:4:${ids26.slice(0, 2).join('+')}`), 'and goes once the other is read');
    assertMirror(h);
  } finally { h.restore(); }
});

test('a market a source leaves out of a whole answer has nothing in the worker, whatever it held there before', async () => {
  const [a, b] = [ids26[0]!, ids26[1]!];
  const h = await harness(T0, [a, b]);
  try {
    await h.hub.loadColumns(h.live(SIX), 180);
    h.source.omit.add(b);
    h.clock.now += COLUMNS_FULL_EVERY_MS + MIN;
    await h.hub.loadColumns(h.live(SIX), 180);
    assert.ok(h.types().includes(`columnsDrop:4:${b}`), h.types().join(' | '));
    assertMirror(h, [b]);
  } finally { h.restore(); }
});

test('the plan: held books are left alone, refreshes start where each settled, and a view in the past asks for nothing', () => {
  const holds = new ColumnHolds();
  const step = 4 * MIN, view = { t0: T0 - 6 * HOUR, t1: T0 + 10 * MIN, p0: 0, p1: 1 }, reach = columnReach(view, step);
  holds.recordWhole(step, [{ id: 'a', step: 10 }, { id: 'b', step: 10 }], reach, settledBefore(T0, step), T0);
  holds.recordWhole(step, [{ id: 'c', step: 10 }], reach, settledBefore(T0 - 16 * MIN, step), T0);
  assert.deepEqual(holds.plan(['a', 'b', 'c'], view, step, T0, T0, false), []);
  const asks = holds.plan(['a', 'b', 'c', 'd'], view, step, T0, T0, true);
  assert.deepEqual(asks.map(ask => [ask.ids.join('+'), ask.from, ask.tail]), [
    ['a+b', settledBefore(T0, step), true], ['c', settledBefore(T0 - 16 * MIN, step), true], ['d', reach.from, false]], 'a tail for each settling time, then the whole window of the one not held');
  const past = { t0: T0 - 3 * 24 * HOUR, t1: T0 - 2 * 24 * HOUR, p0: 0, p1: 1 };
  holds.recordWhole(step, [{ id: 'a', step: 10 }], columnReach(past, step), settledBefore(T0, step), T0);
  assert.deepEqual(holds.plan(['a'], past, step, T0 + HOUR / 2, T0 + HOUR / 2, true), [], 'a recorded minute does not change');
  assert.deepEqual(holds.plan(['a', 'a'], past, step, T0 + 2 * HOUR, T0 + 2 * HOUR, false).map(ask => ask.ids), [['a']], 'an hour on it is asked for whole again, once');
  assert.equal(holds.covers(['a'], past, step), true);
  assert.equal(holds.covers(['a', 'b'], past, step), false, 'b is held for another window');
  assert.equal(holds.covers(['a'], view, 8 * MIN), false, 'another step holds nothing');
});

test('the worker holds each step apart, reads one, and forgets by instrument or by step', () => {
  const col = (id: string, t: number, bin: number): ColumnSet => ({ id, step: 10, times: [t], counts: [1], samples: [12], bins: Int32Array.of(bin), bid: Float32Array.of(bin * 2), ask: Float32Array.of(bin * 3) });
  const only = (store: ColumnStore | undefined): number[] => store ? [...store.bins] : [];
  const rec = new RecordedColumns(MIN);
  assert.equal(rec.current.size, 0);
  rec.set(4 * MIN, [col('a', 0, 1), col('b', 0, 2)]);
  rec.set(8 * MIN, [col('a', 0, 9)]);
  assert.equal(rec.current.size, 0, 'data posted for a step is not read until the step is');
  rec.use(4 * MIN);
  assert.deepEqual([only(rec.current.get('a')), only(rec.current.get('b'))], [[1], [2]]);
  // A tail goes to its own step, whichever is read, and keeps the instruments it does not name.
  rec.tail(8 * MIN, 8 * MIN, [col('a', 8 * MIN, 5)]);
  rec.set(4 * MIN, [col('c', 0, 3)]);
  assert.deepEqual([...rec.current.keys()].sort(), ['a', 'b', 'c'], 'an upsert keeps the others');
  rec.use(8 * MIN);
  assert.deepEqual(only(rec.current.get('a')), [9, 5], 'the tail joined the columns held at its step');
  assert.deepEqual([...rec.current.get('a')!.times], [0, 8 * MIN]);
  rec.drop(4 * MIN, ['a']);
  rec.use(4 * MIN);
  assert.deepEqual([...rec.current.keys()].sort(), ['b', 'c']);
  rec.drop(4 * MIN, null);
  assert.equal(rec.current.size, 0);
  rec.use(8 * MIN);
  assert.equal(rec.current.size, 1, 'the other step is untouched');
  rec.tail(16 * MIN, 0, [col('z', 0, 4)]);
  rec.use(16 * MIN);
  assert.deepEqual(only(rec.current.get('z')), [4], 'a tail with nothing held at its step is the tail alone');
  assert.equal(rec.stepMs, 16 * MIN);
  assert.deepEqual(toStore(col('z', 0, 4)).times, rec.current.get('z')!.times);
});

test('a book the order-book panes count while it is away from the feed is still loaded, at a step not held before too', async () => {
  // The Depth pane and the Liquidity Tracker count Chosen markets, b's perpetual (book-markets.ts); b's feed reconnects and its book leaves the
  // frame, held in `bookGone` for BOOK_HOLD_MS: the panes still ask for b, so a zoom to another step loads b with the feed's books.
  const h = await harness(T0, ['a:BTC', 'b:BTC']);
  try {
    h.store.set({ markets: [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }, { instrumentId: 'b:BTC', venue: 'b', marketType: 'perpetual' }] as never, bookMarkets: 'custom', bookPicks: ['b/perp'] });
    await h.hub.loadColumns(h.live(SIX), 180);
    h.books(['a:BTC']); h.store.set({ bookGone: { b: h.clock.now - 30_000 } });
    h.source.asked.length = 0;
    await h.hub.loadColumns(h.live(24), 180);
    assert.deepEqual(h.source.asked.map(a => a.ids.join('+')), ['a:BTC+b:BTC'], 'the held book with the feed\'s at the new step');
    // Under All switched on the panes count the feed's books alone, as before.
    h.store.set({ bookMarkets: 'all' }); h.source.asked.length = 0;
    await h.hub.loadColumns(h.live(48), 180);
    assert.deepEqual(h.source.asked.map(a => a.ids.join('+')), ['a:BTC']);
  } finally { h.restore(); }
});
