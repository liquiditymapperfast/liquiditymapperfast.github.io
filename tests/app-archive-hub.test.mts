import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/app/hub.ts';
import { Store, initialState } from '../src/app/store.ts';
import type { BootstrapState, DataSource } from '../src/app/source.ts';
import type { ColumnsFrame } from '../src/app/wire.ts';

/**
 * The hub and the long history's arrivals (Sol's page review, round 2): an arrival is asked for again only inside the window each book's
 * columns were asked for, on the grid they are held on, and a book answered on another grid is asked for whole instead of being spliced.
 */

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 5, 6, 0);

class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; posted: { type: string; from?: number; to?: number; instruments?: { id: string }[] }[] = []; postMessage(message: { type: string }): void { this.posted.push(message); } }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

class ArchiveSource {
  readonly kind = 'server' as const;
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  asked: { from: number; to: number; stepMs: number }[] = [];
  ranges: { ids: string[]; from: number; to: number; stepMs: number; grids?: Readonly<Record<string, number>> }[] = [];
  views: { stepMs: number; windows: { from: number; to: number }[] }[] = [];
  listener: ((change: { level: number; from: number; to: number } | null) => void) | null = null;
  /** The grid whole answers come on, and the one an arrival's question comes on. */
  grid = 10;
  rangeGrid = 10;
  /** A whole question for this book fails (a source that went away halfway through a load). */
  failFor: string | null = null;
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: 'a:BTC', markets: [{ instrumentId: 'a:BTC' }], layers: {}, steps: {}, recorded: {}, columnMs: MIN, timeframes: [], oiReferences: [] };
  }
  connect(): { close(): void; tape(on: boolean): void } { return { close() {}, tape() {} }; }
  async candles() { return []; }
  async oi() { return []; }
  async prints() { return []; }
  async flow() { return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
  #frame(ids: string[], from: number, to: number, stepMs: number, grid: number): ColumnsFrame {
    return { from, to, stepMs, instruments: ids.map(id => ({ id, step: grid, times: [from], counts: [1], samples: [12], bins: Int32Array.of(1), bid: Float32Array.of(1), ask: Float32Array.of(1) })) };
  }
  async columns(ids: string[], from: number, to: number, stepMs: number): Promise<ColumnsFrame> {
    this.asked.push({ from, to, stepMs });
    if (this.failFor && ids.includes(this.failFor)) throw new Error('source gone');
    return this.#frame(ids, from, to, stepMs, this.grid);
  }
  setArchiveListener(listener: (change: { level: number; from: number; to: number } | null) => void): void { this.listener = listener; }
  async archiveRange(ids: string[], from: number, to: number, stepMs: number, grids?: Readonly<Record<string, number>>): Promise<ColumnsFrame> {
    this.ranges.push({ ids, from, to, stepMs, ...(grids ? { grids } : {}) });
    return this.#frame(ids, from, to, stepMs, this.rangeGrid);
  }
  archiveView(stepMs: number, windows: readonly { from: number; to: number }[]): void { this.views.push({ stepMs, windows: windows.map(w => ({ ...w })) }); }
  archiveFirst(): number { return T0 - 30 * DAY; }
  depthSince(): number { return T0 - DAY; }
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

test('an arrival is spliced in only inside what is held, on its grid; one on another grid asks for the book whole', async () => {
  const realNow = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    const store = new Store(initialState()), source = new ArchiveSource();
    const hub = new Hub(store, source as unknown as DataSource), worker = hub.worker as unknown as FakeWorker;
    worker.onmessage!({ data: { type: 'ready' } });
    await hub.start();
    store.set({ levels: { asOf: now, books: [{ id: 'a:BTC' }, { id: 'b:BTC' }] } as never });
    // Three days back, six hours on 180 px: four-minute columns from the long history.
    const view = { t0: T0 - 3 * DAY, t1: T0 - 3 * DAY + 6 * HOUR, p0: 0, p1: 1 }, step = 4 * MIN;
    await hub.loadColumns(view, 180);
    assert.equal(source.asked.length, 1);
    const whole = source.asked[0]!;
    assert.deepEqual(source.views[0], { stepMs: step, windows: [] }, 'the view\'s step told to the long history as the load starts');
    assert.deepEqual(source.views.at(-1), { stepMs: step, windows: [{ from: whole.from, to: whole.to }] }, 'and the window it holds once answered');
    const ranges = (): { from?: number; to?: number }[] => worker.posted.filter(m => m.type === 'columnsRange').map(m => ({ from: m.from, to: m.to }));
    // A pack's range that reaches past both ends of what is held: asked for and spliced inside it.
    source.listener!({ level: 4, from: whole.from - DAY, to: whole.to + DAY }); await settle();
    assert.equal(source.ranges.length, 1);
    assert.deepEqual([source.ranges[0]!.from, source.ranges[0]!.to], [whole.from, whole.to], 'clipped to the window asked for');
    assert.deepEqual(source.ranges[0]!.grids, { 'a:BTC': 10, 'b:BTC': 10 }, 'with the grids the books are held on');
    assert.deepEqual(ranges(), [{ from: whole.from, to: whole.to }]);
    // A range the view has left (a pan since): nothing asked, nothing taken in.
    source.listener!({ level: 4, from: whole.from - 10 * DAY, to: whole.from - 9 * DAY }); await settle();
    assert.equal(source.ranges.length, 1, 'outside what is held: not asked');
    assert.equal(ranges().length, 1);
    // A step not held: nothing.
    source.listener!({ level: 64, from: whole.from, to: whole.to }); await settle();
    assert.equal(source.ranges.length, 1);
    // An arrival answered on another grid: not spliced; the next load asks for the books whole.
    source.rangeGrid = 20;
    source.listener!({ level: 4, from: whole.from, to: whole.to }); await settle();
    assert.equal(ranges().length, 1, 'another grid is not spliced');
    const count = source.asked.length;
    await hub.loadColumns(view, 180);
    assert.equal(source.asked.length, count + 1);
    assert.deepEqual([source.asked.at(-1)!.from, source.asked.at(-1)!.to], [whole.from, whole.to], 'asked for whole again');
  } finally { Date.now = realNow; }
});

test('a hold let go is told to the long history at once, even when no question follows', async () => {
  const realNow = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    const store = new Store(initialState()), source = new ArchiveSource();
    const hub = new Hub(store, source as unknown as DataSource), worker = hub.worker as unknown as FakeWorker;
    worker.onmessage!({ data: { type: 'ready' } });
    await hub.start();
    const books = (ids: string[]): void => store.set({ levels: { asOf: now, books: ids.map(id => ({ id })) } as never });
    books(['a:BTC', 'b:BTC']);
    const v1 = { t0: T0 - 3 * DAY, t1: T0 - 3 * DAY + 6 * HOUR, p0: 0, p1: 1 }, v3 = { ...v1, t0: v1.t0 + DAY, t1: v1.t1 + DAY };
    await hub.loadColumns(v1, 180);
    // 59 minutes on, b has left and the view has moved a day: a is asked for its new window, b keeps its old one.
    now += 59 * MIN; books(['a:BTC']);
    await hub.loadColumns(v3, 180);
    const r1 = source.asked[0]!, r3 = source.asked.at(-1)!;
    assert.equal(source.views.at(-1)!.windows.length, 2, 'both windows held');
    // Two minutes later b's hold is an hour old and swept; a's is fresh: nothing is asked, and the archive hears of it all the same.
    now += 2 * MIN;
    const asked = source.asked.length;
    await hub.loadColumns(v3, 180);
    assert.equal(source.asked.length, asked, 'no question');
    assert.ok(worker.posted.some(m => m.type === 'columnsDrop'), 'b let go');
    assert.deepEqual(source.views.at(-1)!.windows, [{ from: r3.from, to: r3.to }], 'only a\'s window is held now');
    assert.notEqual(r1.from, r3.from);
  } finally { Date.now = realNow; }
});

test('a load cut short by a failed question still tells the long history the windows it replaced', async () => {
  const realNow = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    const store = new Store(initialState()), source = new ArchiveSource();
    const hub = new Hub(store, source as unknown as DataSource);
    (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
    await hub.start();
    const books = (ids: string[]): void => store.set({ levels: { asOf: now, books: ids.map(id => ({ id })) } as never });
    books(['a:BTC']);
    // A live six-hour view: a is held, then refreshed from where it settled.
    const live = { t0: T0 - 6 * HOUR, t1: T0 + 10 * MIN, p0: 0, p1: 1 };
    await hub.loadColumns(live, 180);
    const r1 = source.asked[0]!;
    // Half a minute on, the view pans back half an hour (still inside a's window), b comes, and a's refresh comes on another grid: a is asked
    // for whole at the panned view's window, then b's question fails.
    now += 30_000; hub.invalidateColumns(); books(['a:BTC', 'b:BTC']);
    source.grid = 20; source.failFor = 'b:BTC';
    const panned = { ...live, t0: live.t0 - 30 * MIN, t1: live.t1 - 30 * MIN };
    await assert.rejects(hub.loadColumns(panned, 180), /source gone/);
    const windows = source.views.at(-1)!.windows;
    assert.equal(windows.length, 1);
    assert.notEqual(windows[0]!.from, r1.from, 'the window a holds now, not the one it held');
  } finally { Date.now = realNow; }
});

test('an arrival whose answer comes after a pan is not spliced into the new window', async () => {
  const realNow = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    const store = new Store(initialState()), source = new ArchiveSource();
    const hub = new Hub(store, source as unknown as DataSource), worker = hub.worker as unknown as FakeWorker;
    worker.onmessage!({ data: { type: 'ready' } });
    await hub.start();
    store.set({ levels: { asOf: now, books: [{ id: 'a:BTC' }, { id: 'b:BTC' }] } as never });
    const view = { t0: T0 - 3 * DAY, t1: T0 - 3 * DAY + 6 * HOUR, p0: 0, p1: 1 };
    await hub.loadColumns(view, 180);
    const whole = source.asked[0]!;
    // The arrival's question is under way when the view pans a day on, at the same step.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const answer = source.archiveRange.bind(source);
    source.archiveRange = async (...args) => { await gate; return answer(...args); };
    source.listener!({ level: 4, from: whole.from, to: whole.to }); await settle();
    await hub.loadColumns({ ...view, t0: view.t0 + DAY, t1: view.t1 + DAY }, 180);
    assert.equal(source.asked.length, 2, 'the panned view asked for its own window');
    release(); await settle();
    assert.equal(worker.posted.filter(m => m.type === 'columnsRange').length, 0, 'the old range is not taken into the new window');
  } finally { Date.now = realNow; }
});
