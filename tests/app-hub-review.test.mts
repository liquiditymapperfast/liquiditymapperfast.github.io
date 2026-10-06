import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub, mergeLive } from '../src/app/hub.ts';
import { Store, initialState, type CandleRow } from '../src/app/store.ts';
import type { BootstrapState, DataSource, LiveHandlers, TickMessage } from '../src/app/source.ts';
import type { FlowFrame } from '../src/shared/flow.ts';

// The hub as the page runs it, against a source and a worker that say what a test tells them to.

const MIN = 60_000, HOUR = 3_600_000;
class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

interface Rig { hub: Hub; store: Store; handlers: () => LiveHandlers; source: FakeSource }
class FakeSource {
  readonly kind = 'server' as const;
  handlers: LiveHandlers | null = null;
  /** The answers to candle requests, in the order they were asked: a test settles them in whatever order it likes. */
  asked: { resolve(rows: CandleRow[]): void }[] = [];
  flowCalls = 0;
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: 'ref:BTC', markets: [{ instrumentId: 'ref:BTC' }, { instrumentId: 'sel:BTC' }], layers: {}, steps: {}, recorded: {}, columnMs: MIN, timeframes: [], oiReferences: [] };
  }
  connect(handlers: LiveHandlers): { close(): void } { this.handlers = handlers; return { close() {} }; }
  candles(): Promise<CandleRow[]> { return new Promise(resolve => { this.asked.push({ resolve }); }); }
  async oi() { return []; }
  async prints() { return []; }
  async columns() { return { from: 0, to: 0, stepMs: MIN, instruments: [] } as never; }
  async flow(): Promise<FlowFrame> { this.flowCalls++; return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
}
async function rig(patch: Partial<ReturnType<typeof initialState>> = {}): Promise<Rig> {
  const store = new Store({ ...initialState(), ...patch }), source = new FakeSource();
  const hub = new Hub(store, source as unknown as DataSource);
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  return { hub, store, source, handlers: () => source.handlers! };
}
const tick = (over: Partial<TickMessage> = {}): TickMessage => ({ t: 'tick', price: 100, instrumentId: 'ref:BTC', asOf: 10 * HOUR, candles: {}, ...over });
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('a market that is not the reference has its mark moved by its own live candle, while that is fresh', async () => {
  const { store, handlers } = await rig({ marketId: 'sel:BTC' });
  assert.equal(store.state.mark.price, 100, 'it starts at the price the server gave for the reference');
  handlers().onTick(tick({ candles: { 'sel:BTC': [10 * HOUR - 30_000, 10, 22, 9, 21, 5] } }));
  assert.equal(store.state.mark.price, 21, 'the market on screen traded to 21, and its mark stayed where it was');
  handlers().onTick(tick({ asOf: 10 * HOUR + 5 * MIN, candles: { 'sel:BTC': [10 * HOUR - 30_000, 10, 22, 9, 15, 5] } }));
  assert.equal(store.state.mark.price, 21, 'a candle that is minutes old is not a price of now');
});

test('a market with no history starts its series from the live candle', async () => {
  const { store, handlers } = await rig({ marketId: 'sel:BTC', timeframe: '1m', candles: [] });
  handlers().onTick(tick({ candles: { 'sel:BTC': [10 * HOUR, 10, 12, 9, 11, 3] } }));
  assert.deepEqual(store.state.candles.map(c => [c[0], c[4], c[5]]), [[10 * HOUR, 11, 3]]);
});

test('a live candle of a coarser timeframe is the sum of its minutes, not the biggest of them', () => {
  const track = { current: null };
  const open: CandleRow[] = [[10 * HOUR, 10, 10, 10, 10, 0, 1]];                         // the loaded five minute candle has nothing yet
  let candles = mergeLive(open, [10 * HOUR, 10, 11, 10, 11, 9], 5 * MIN, track);
  candles = mergeLive(candles, [10 * HOUR + MIN, 11, 12, 11, 12, 5], 5 * MIN, track);
  candles = mergeLive(candles, [10 * HOUR + 2 * MIN, 12, 12, 11, 11, 4], 5 * MIN, track);
  assert.equal(candles.length, 1); assert.equal(candles[0]![5], 18, 'nine, five and four (it showed 9)');
  candles = mergeLive(candles, [10 * HOUR + 2 * MIN, 12, 13, 11, 13, 6], 5 * MIN, track);
  assert.equal(candles[0]![5], 20, 'the minute still open grows by what it adds');
  assert.deepEqual([candles[0]![2], candles[0]![3], candles[0]![4]], [13, 10, 13]);
  // a candle that already held part of the first live minute is not counted twice for it
  const loaded: CandleRow[] = [[10 * HOUR, 10, 10, 10, 10, 14, 1]];                      // 8 from before, and 6 of the minute now live
  const again = { current: null };
  const first = mergeLive(loaded, [10 * HOUR + 3 * MIN, 10, 10, 10, 10, 6], 5 * MIN, again);
  assert.equal(first[0]![5], 14);
  assert.equal(mergeLive(first, [10 * HOUR + 3 * MIN, 10, 10, 10, 10, 9], 5 * MIN, again)[0]![5], 17, 'three more in the same minute');
  assert.equal(mergeLive(first, [10 * HOUR + 4 * MIN, 10, 10, 10, 10, 2], 5 * MIN, again)[0]![5], 19, 'and the next minute adds its own');
  // and a one minute candle goes on being replaced by its own later, bigger self
  assert.equal(mergeLive([[0, 1, 1, 1, 1, 5, 1]], [0, 1, 1, 1, 1, 7], MIN, { current: null })[0]![5], 7);
});

test('an older request for the series does not put its answer over a newer one, and the live candle seen meanwhile is kept', async () => {
  const { hub, store, source, handlers } = await rig({ marketId: 'ref:BTC', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });
  const row = (close: number): CandleRow => [10 * HOUR, 1, 1, 1, close, 1, 1];
  void hub.loadSeries(true);                                                              // asked first
  await turn();
  void hub.loadSeries(true);                                                              // asked again, by a forced reload
  await turn();
  assert.equal(source.asked.length, 2);
  handlers().onTick(tick({ candles: { 'ref:BTC': [10 * HOUR + 5 * MIN, 1, 1, 1, 300, 1] } }));
  source.asked[1]!.resolve([row(200)]); await turn();
  assert.equal(store.state.candles.at(-1)![4], 300, 'the newer answer, brought up to date with the live candle');
  source.asked[0]!.resolve([row(100)]); await turn();
  assert.equal(store.state.candles.at(-1)![4], 300, 'the older answer arrives last and rewinds nothing (it set the close back to 100)');
});

test('when the live stream comes back after a break, the flow history is asked for again', async () => {
  const { hub, handlers, source } = await rig();
  await hub.ensureFlow(['ref:BTC'], 9 * HOUR);
  await hub.ensureFlow(['ref:BTC'], 9 * HOUR);
  assert.equal(source.flowCalls, 1, 'once it is there it is not asked for again');
  handlers().onOpen();
  await hub.ensureFlow(['ref:BTC'], 9 * HOUR);
  assert.equal(source.flowCalls, 1, 'the first open has nothing to repair');
  handlers().onClose(1, 'host'); handlers().onOpen();
  await hub.ensureFlow(['ref:BTC'], 9 * HOUR);
  assert.equal(source.flowCalls, 2, 'the seconds missed while it was down come with the history');
});
