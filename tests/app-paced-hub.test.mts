import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/app/hub.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { ScriptData } from '../src/app/script/data.ts';
import { Store, initialState } from '../src/app/store.ts';
import type { BootstrapState, DataSource, LiveHandlers } from '../src/app/source.ts';
import type { ColumnsFrame } from '../src/app/wire.ts';
import { PRINTS_PER_ANSWER } from '../src/shared/prints.ts';

/**
 * The page's hub paces its reads (`paced`, Research_Findings.md): a column step is asked for once the view has rested on it; on the server's
 * page the map's first columns come before the other history; the bubbles wait for the live stream to open. A hub built without the option
 * asks at once, as every other test's does.
 */

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 7, 12, 0);

class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

class PacedSource {
  readonly kind = 'server' as const;
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  asked: { stepMs: number }[] = [];
  oiAsked = 0; printsAsked = 0;
  hold: Promise<void> | null = null;
  handlers: LiveHandlers | null = null;
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: 'a:BTC', markets: [{ instrumentId: 'a:BTC' }], layers: {}, steps: {}, recorded: {}, columnMs: MIN, timeframes: [], oiReferences: [] };
  }
  connect(handlers: LiveHandlers): { close(): void; tape(on: boolean): void } { this.handlers = handlers; return { close() {}, tape() {} }; }
  async candles() { return []; }
  async oi() { this.oiAsked++; return []; }
  async prints() { this.printsAsked++; return []; }
  async flow() { return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
  async columns(ids: string[], from: number, to: number, stepMs: number): Promise<ColumnsFrame> {
    this.asked.push({ stepMs });
    if (this.hold) await this.hold;
    return { from, to, stepMs, instruments: ids.map(id => ({ id, step: 10, times: [], counts: [], samples: [], bins: new Int32Array(0), bid: new Float32Array(0), ask: new Float32Array(0) })) };
  }
}

async function harness(paced: boolean) {
  const realNow = Date.now;
  const clock = { now: T0 };
  Date.now = () => clock.now;
  const store = new Store(initialState()), source = new PacedSource();
  const hub = new Hub(store, source as unknown as DataSource, { paced });
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  store.set({ levels: { asOf: clock.now, books: [{ id: 'a:BTC' }, { id: 'b:BTC' }] } as never });
  /** The live view of this many hours on 180 px: columns of 4 min for 6 h, 8 min for 12 h, 16 min for 24 h, 32 min for 48 h. */
  const live = (hours: number) => ({ t0: clock.now - hours * HOUR, t1: clock.now + 10 * MIN, p0: 0, p1: 1 });
  return { clock, store, source, hub, live, restore: () => { Date.now = realNow; } };
}
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('a zoom that passes column steps asks only for the step it rests on (the page\'s hub)', async () => {
  const h = await harness(true);
  try {
    await h.hub.loadColumns(h.live(6), 180);
    assert.deepEqual(h.source.asked.map(a => a.stepMs / MIN), [4], 'the map\'s first columns are asked for at once');
    // A wheel turn: 12 h and 24 h within a moment of each other.
    await h.hub.loadColumns(h.live(12), 180);
    await h.hub.loadColumns(h.live(24), 180);
    assert.equal(h.source.asked.length, 1, 'nothing while the zoom passes the steps');
    await wait(260);
    await h.hub.loadColumns(h.live(24), 180);
    assert.deepEqual(h.source.asked.map(a => a.stepMs / MIN), [4, 16], 'the step it rested on, and not the one it passed');
  } finally { h.restore(); }
});

test('a zoom that widens the window at the step held waits too (its first wheel steps), then asks once (the page\'s hub)', async () => {
  const h = await harness(true);
  try {
    const live = (minutes: number) => ({ t0: h.clock.now - minutes * MIN, t1: h.clock.now + 10 * MIN, p0: 0, p1: 1 });
    await h.hub.loadColumns(live(246), 180);   // 256 minutes on 180 px: 4-minute columns, held from 374 minutes back
    await wait(260);                           // the step has long held
    await h.hub.loadColumns(live(492), 180);   // twice the span, still 4-minute columns, now reaching past what is held
    assert.deepEqual(h.source.asked.map(a => a.stepMs / MIN), [4], 'nothing while the span is still changing');
    await wait(260);
    await h.hub.loadColumns(live(492), 180);
    assert.deepEqual(h.source.asked.map(a => a.stepMs / MIN), [4, 4], 'the wider window, once the zoom has held');
  } finally { h.restore(); }
});

test('a load out when the zoom moves on is finished, and the step the view rests on is asked next (the page\'s hub)', async () => {
  const h = await harness(true);
  try {
    await h.hub.loadColumns(h.live(6), 180);
    let release!: () => void;
    h.source.hold = new Promise<void>(resolve => { release = resolve; });
    await h.hub.loadColumns(h.live(24), 180); await wait(260);
    const load = h.hub.loadColumns(h.live(24), 180);   // 16 min, held by the source
    await turn();
    await h.hub.loadColumns(h.live(48), 180); await wait(260);
    await h.hub.loadColumns(h.live(48), 180);
    assert.deepEqual(h.source.asked.map(a => a.stepMs / MIN), [4, 16], 'nothing more while a load is out');
    release(); await load; h.source.hold = null;
    await h.hub.loadColumns(h.live(48), 180);
    assert.deepEqual(h.source.asked.map(a => a.stepMs / MIN), [4, 16, 32], 'the step the view rests on, once the load out is done');
  } finally { h.restore(); }
});

test('a hub built without pacing asks for every step at once, as before', async () => {
  const h = await harness(false);
  try {
    await h.hub.loadColumns(h.live(6), 180);
    await h.hub.loadColumns(h.live(12), 180);
    await h.hub.loadColumns(h.live(24), 180);
    assert.deepEqual(h.source.asked.map(a => a.stepMs / MIN), [4, 8, 16]);
  } finally { h.restore(); }
});

test('on the server\'s page open interest and the bubbles wait for the map\'s first columns', async () => {
  const h = await harness(true);
  try {
    h.source.handlers!.onOpen();
    h.store.set({ oiMarkets: 'chart' });   // the chart market's own open interest: one read, whatever the venues
    const view = { t0: T0 - 6 * HOUR, t1: T0, p0: 0, p1: 1e6 } as never;
    const oi = h.hub.loadOi();
    h.hub.ensurePrints(view);
    await turn();
    assert.equal(h.source.oiAsked, 0, 'no open interest before the map\'s columns');
    assert.equal(h.store.state.oiReading, true, 'the pane says it is reading meanwhile, not that there is no history');
    assert.equal(h.source.printsAsked, 0, 'no bubbles before the map\'s columns');
    await h.hub.loadColumns(h.live(6), 180);
    assert.ok(h.hub.columnsVersion > 0, 'the map has its columns');
    await oi;
    assert.ok(h.source.oiAsked > 0, 'open interest is read once they are in');
    assert.equal(h.store.state.oiReading, false, 'and the read ends it');
    h.hub.ensurePrints(view);
    assert.equal(h.source.printsAsked, 1, 'and the bubbles');
  } finally { h.restore(); }
});

test('a map covered by a phone\'s tab asks for no columns, so nothing waits for them', async () => {
  const h = await harness(true);
  try {
    h.store.set({ oiMarkets: 'chart' });
    assert.equal(h.hub.mapFirst(), true, 'on the server\'s page, before the map\'s columns');
    h.hub.mapCovered = true;
    assert.equal(h.hub.mapFirst(), false, 'covered: nothing waits');
    await h.hub.loadOi();
    assert.ok(h.source.oiAsked > 0, 'open interest is read at once');
  } finally { h.restore(); }
});

test('another coin\'s books are asked for at once, though the zoom that framed them changed the span (the page\'s hub)', async () => {
  const h = await harness(true);
  try {
    await h.hub.loadColumns(h.live(6), 180);
    await wait(260);
    h.store.set({ levels: { asOf: T0, books: [{ id: 'x:ETH' }, { id: 'y:ETH' }] } as never });
    await h.hub.loadColumns(h.live(12), 180);   // the new coin's view, framed afresh
    assert.deepEqual(h.source.asked.map(a => a.stepMs / MIN), [4, 8], 'no wait: nothing of these books is on the map');
  } finally { h.restore(); }
});

test('the bubbles are not asked for while the live stream opens for the first time (their answer would cover nothing)', async () => {
  const h = await harness(true);
  try {
    await h.hub.loadColumns(h.live(6), 180);
    const view = { t0: T0 - 6 * HOUR, t1: T0, p0: 0, p1: 1e6 } as never;
    h.hub.ensurePrints(view); await turn();
    assert.equal(h.source.printsAsked, 0, 'the stream is still opening');
    h.source.handlers!.onOpen();
    h.hub.ensurePrints(view); await turn();
    h.hub.ensurePrints(view); await turn();
    assert.equal(h.source.printsAsked, 1, 'asked once the stream is open, and the window then held');
  } finally { h.restore(); }
});

test('flow minutes: an answer that begins later than asked ends the asking further back; one that begins as asked does not', () => {
  const minutes = (from: number, to: number) => ({ from, to, instruments: [] });
  const book = new FlowBook(), DAY = 24 * HOUR, to = T0;
  // The server keeps eight days: asked for twenty, it answers from eight days before `to`.
  book.loadMinutes(minutes(to - 8 * DAY, to), ['a'], to - 20 * DAY, to);
  assert.deepEqual(book.minutesMissing(['a'], to - 30 * DAY, to), [], 'nothing older than what it keeps is asked for again');
  assert.deepEqual(book.minutesMissing(['a'], to - 30 * DAY, to + HOUR), ['a'], 'a later end is asked for');
  const other = new FlowBook();
  other.loadMinutes(minutes(to - 2 * DAY, to), ['a'], to - 2 * DAY, to);
  assert.deepEqual(other.minutesMissing(['a'], to - 3 * DAY, to), ['a'], 'an answer as long as asked says nothing of what is older');
});

test('a script that reads neither liquidations nor flow asks for neither; one that reads them does', () => {
  const asked = { liquidations: 0, flow: 0 };
  const hub = {
    flow: new FlowBook(), recordedSince: 0,
    source: { kind: 'server', liquidations: async () => { asked.liquidations++; return []; } },
    ensureFlow: async () => { asked.flow++; }, ensureFlowMinutes: async () => {},
  };
  const now = Date.now(), start = Math.floor(now / HOUR) * HOUR;
  const candles = Array.from({ length: 30 }, (_, i) => [start - (29 - i) * HOUR, 100, 101, 99, 100, 5] as const);
  const state = { ...initialState(), timeframe: '1h', candles } as never;
  const data = new ScriptData(hub as never, () => {}), filters = new Map([['', {}]]);
  assert.ok(data.inputs(state, filters, false, false, candles as never, false));
  assert.deepEqual(asked, { liquidations: 0, flow: 0 }, 'a VWAP\'s chart reads nothing for them');
  data.inputs(state, filters, false, false, candles as never, true);
  assert.ok(asked.liquidations > 0, 'liquidations, for a script that reads them');
  data.inputs(state, filters, false, true, candles as never, false);
  assert.ok(asked.flow > 0, 'the flow, for a script that reads it');
});

test('Time & sales fills from the recording at the list\'s own smallest order, after the map\'s first columns, halving a cut answer on one coverage', async () => {
  const h = await harness(true);
  try {
    let coverageAsked = 0, cut = 1;
    const asked: { from: number; to: number; minUsd: number | undefined }[] = [];
    const src = h.source as unknown as Record<string, unknown>;
    src.coverage = async (ids: string[], _metric: string, from: number, to: number) => {
      coverageAsked++;
      return { metric: 'trades', from, to, asOf: to, instruments: ids.map(id => ({ id, spans: [[from, to]], recovered: [], seconds: [], held: [] })) };
    };
    src.prints = async (from: number, to: number, minUsd?: number) => {
      asked.push({ from, to, minUsd });
      // The first answer is cut at its largest orders; the narrower one is whole.
      return cut-- > 0 ? Array.from({ length: PRINTS_PER_ANSWER }, (_, i) => ({ t: from + i, id: 'a:BTC', side: 'buy', price: 100, usd: 1e6 })) : [{ t: to - 10_000, id: 'a:BTC', side: 'buy', price: 100, usd: 2e5 }];
    };
    h.source.handlers!.onOpen();
    const fill = h.hub.recentPrints(['a:BTC'], HOUR, h.clock.now, 100_000);
    await turn();
    assert.equal(coverageAsked, 0, 'nothing before the map\'s first columns (the server\'s page)');
    await h.hub.loadColumns(h.live(6), 180);
    const got = await fill;
    assert.equal(coverageAsked, 1, 'one coverage question for every window tried');
    assert.deepEqual(asked.map(a => a.minUsd), [100_000, 100_000], 'at the list\'s own smallest order, never the recording\'s BTC floor');
    assert.ok(asked[1]!.from > asked[0]!.from, 'a cut answer halves the window');
    assert.equal(got?.prints.length, 1);
    assert.equal(got?.from, asked[1]!.from);
    assert.equal(got?.minHole, 2 * 60_000, 'the server\'s shortest hole goes with the answer, for the list to apply after counting the orders in each');
  } finally { h.restore(); }
});
