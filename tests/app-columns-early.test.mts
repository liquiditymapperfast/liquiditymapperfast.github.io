import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/app/hub.ts';
import { Store, initialState } from '../src/app/store.ts';
import type { BootstrapState, DataSource, LiveHandlers } from '../src/app/source.ts';
import type { ColumnsFrame } from '../src/app/wire.ts';

/**
 * A returning browser page answers the map's first columns from its newest recordings while the rest of its day is read back
 * (`Engine.preview`). When the history lands saying so (`columnsEarly`), the hub asks for the columns it holds whole again; a history that
 * does not say so asks nothing more of the map.
 */

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 7, 12, 0);

class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; posted: { type: string }[] = []; postMessage(message: { type: string }): void { this.posted.push(message); } }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

/** A source that keeps the live handlers it is given, so the test can say the history has landed. */
class HistorySource {
  readonly kind = 'server' as const;
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  asked: { from: number; to: number; stepMs: number; early: boolean }[] = [];
  handlers: LiveHandlers | null = null;
  /** What the source says of the map's columns (`DataSource.previewing`). */
  drawnFromNewest = false;
  previewing(): boolean { return this.drawnFromNewest; }
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: 'a:BTC', markets: [{ instrumentId: 'a:BTC' }], layers: {}, steps: {}, recorded: {}, columnMs: MIN, timeframes: [], oiReferences: [] };
  }
  connect(handlers: LiveHandlers): { close(): void; tape(on: boolean): void } { this.handlers = handlers; return { close() {}, tape() {} }; }
  async candles() { return []; }
  async oi() { return []; }
  async prints() { return []; }
  async flow() { return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
  async columns(ids: string[], from: number, to: number, stepMs: number, _close = false, early = false): Promise<ColumnsFrame> {
    this.asked.push({ from, to, stepMs, early });
    return { from, to, stepMs, instruments: ids.map(id => ({ id, step: 10, times: [from], counts: [1], samples: [12], bins: Int32Array.of(1), bid: Float32Array.of(1), ask: Float32Array.of(1) })) };
  }
}

test('a history that says the map was answered from the newest recordings asks for its columns whole again; one that does not, nothing', async () => {
  const realNow = Date.now;
  Date.now = () => T0;
  try {
    const store = new Store(initialState()), source = new HistorySource();
    const hub = new Hub(store, source as unknown as DataSource), worker = hub.worker as unknown as FakeWorker;
    worker.onmessage!({ data: { type: 'ready' } });
    await hub.start();
    store.set({ levels: { asOf: T0, books: [{ id: 'a:BTC' }] } as never });
    // A view wholly in the past: once held, a refresh asks nothing (a recorded minute does not change).
    const view = { t0: T0 - 5 * HOUR, t1: T0 - 4 * HOUR, p0: 0, p1: 1 };
    let columns = 0;
    hub.onColumns = () => { columns++; };
    await hub.loadColumns(view, 120);
    assert.equal(source.asked.length, 1);
    assert.equal(source.asked[0]!.early, true, 'the map\'s own load may be answered early');
    await hub.loadColumns(view, 120);
    assert.equal(source.asked.length, 1, 'held: nothing asked');
    source.handlers!.onHistory!(false);
    await hub.loadColumns(view, 120);
    assert.equal(source.asked.length, 1, 'a history that answered nothing early asks nothing more of the map');
    const frames = columns;
    source.handlers!.onHistory!(true);
    assert.equal(columns, frames + 1, 'a frame is asked for, to load them');
    await hub.loadColumns(view, 120);
    assert.equal(source.asked.length, 2, 'asked again');
    assert.deepEqual([source.asked[1]!.from, source.asked[1]!.to], [source.asked[0]!.from, source.asked[0]!.to], 'whole');
  } finally { Date.now = realNow; }
});

test('while the map is drawn from the newest recordings, where the recording began so far is not said to be where its depth begins', async () => {
  const store = new Store(initialState()), source = new HistorySource();
  const hub = new Hub(store, source as unknown as DataSource), worker = hub.worker as unknown as FakeWorker;
  worker.onmessage!({ data: { type: 'ready' } });
  hub.recordedSince = T0 - MIN;
  assert.equal(hub.depthSince(), T0 - MIN);
  source.drawnFromNewest = true;
  assert.equal(hub.depthSince(), 0, 'no "depth recorded from" mark beside columns drawn from before it');
  source.drawnFromNewest = false;
  assert.equal(hub.depthSince(), T0 - MIN);
});
