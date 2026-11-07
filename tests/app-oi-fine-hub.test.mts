import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/app/hub.ts';
import { Store, initialState, type CandleRow, type OiBar } from '../src/app/store.ts';
import type { BootstrapState, DataSource, LiveHandlers } from '../src/app/source.ts';
import type { FlowFrame } from '../src/shared/flow.ts';

// The minute readings NL/NS works candles out on (Hub.loadOiFine, store oiFine) as the page asks for them: kept across a timeframe switch,
// which clears the bars on screen for a moment (review round 2, 2026-11-07: they were let go and a day of minutes read again on every switch),
// and let go when nothing that uses them is shown.

const MIN = 60_000, TF: Record<string, number> = { '15m': 900_000, '5m': 300_000 };
class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

const MARKET = 'binance:BTCUSDT', now0 = Math.floor(Date.now() / MIN) * MIN;
class FakeSource {
  readonly kind = 'server' as const;
  handlers: LiveHandlers | null = null;
  /** Every open-interest question, by timeframe. */
  asked: { id: string; tf: string; from: number; to: number }[] = [];
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: MARKET, markets: [{ instrumentId: MARKET, marketType: 'perpetual' }], layers: {}, steps: {}, recorded: {}, columnMs: MIN } as unknown as BootstrapState;
  }
  connect(handlers: LiveHandlers): { close(): void; tape(on: boolean): void } { this.handlers = handlers; return { close() {}, tape() {} }; }
  async candles(_inst: string, tf: string): Promise<CandleRow[]> { const ms = TF[tf] ?? 3_600_000; return Array.from({ length: 50 }, (_, i): CandleRow => [Math.floor(now0 / ms) * ms - (49 - i) * ms, 100, 101, 99, 100, 5]); }
  async oi(id: string, tf: string, from: number, to: number): Promise<OiBar[]> {
    this.asked.push({ id, tf, from, to });
    const ms = tf === '1m' ? MIN : TF[tf] ?? 3_600_000, n = tf === '1m' ? 60 : 30;
    return Array.from({ length: n }, (_, i): OiBar => { const t = Math.floor(now0 / ms) * ms - (n - 1 - i) * ms, v = 1_000 + i; return [t, v, v, v, v]; });
  }
  async prints() { return []; }
  async columns() { return { from: 0, to: 0, stepMs: MIN, instruments: [] } as never; }
  async flow(): Promise<FlowFrame> { return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30));

test('the minute readings stay through a timeframe switch, and go when nothing that uses them is shown', async () => {
  const store = new Store({ ...initialState(), marketId: MARKET, timeframe: '15m', oiMarkets: 'chart' }), source = new FakeSource();
  store.state.show = { ...store.state.show, oi: true };
  const hub = new Hub(store, source as unknown as DataSource);
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  await hub.loadSeries(true); await hub.loadOi().catch(() => undefined); await hub.loadOiFine(); await settle();
  assert.equal(store.state.oiChange, 'who', 'the OI pane splits its bars by who unless set otherwise');
  assert.deepEqual(store.state.oiFine.map(part => [part.id, part.bars.length]), [[MARKET, 60]], 'read on a 15-minute chart');
  const minuteReads = (): number => source.asked.filter(q => q.tf === '1m').length, before = minuteReads();
  // A timeframe switch as the page makes it: the bars on screen are cleared for the new timeframe's read, and the minute readings asked for.
  store.set({ timeframe: '5m' });
  const load = hub.loadSeries(false);
  assert.equal(store.state.oi.length, 0, 'the bars on screen are cleared while the new timeframe is read');
  await hub.loadOiFine();
  assert.equal(store.state.oiFine.length, 1, 'the minute readings are kept meanwhile');
  await load; await hub.loadOi().catch(() => undefined); await hub.loadOiFine(); await settle();
  assert.equal(minuteReads(), before, 'and are not read again: they do not depend on the timeframe');
  assert.equal(store.state.oiFine[0]!.bars.length, 60);
  // Nothing that uses them: the OI pane closed (the Delta pane is not on NL/NS, the Funding pane is off).
  store.set({ show: { ...store.state.show, oi: false } });
  await hub.loadOiFine();
  assert.equal(store.state.oiFine.length, 0, 'let go');
  // A one-minute chart: the candle is the minute, none are wanted.
  store.set({ show: { ...store.state.show, oi: true }, timeframe: '1m' });
  await hub.loadOiFine();
  assert.equal(store.state.oiFine.length, 0);
});

test('an inverse market\'s minutes take the bars\' price at each whole read; markets no longer wanted go at once, the Funding pane keeping Hyperliquid\'s alone', async () => {
  // Review round 3 (2026-11-07): an inverse market's minutes kept the price they were first read at all session, drifting from the bars'; and
  // the Funding pane alone kept every counted market's minutes, each push repainting three panes for nothing.
  const realNow = Date.now;
  let clock = now0;
  Date.now = () => clock;
  try {
    const DERIBIT = 'deribit:BTC-PERPETUAL', HL = 'hyperliquid:BTC-PERP', bars: OiBar[] = [[now0 - 15 * MIN, 1, 1, 1, 1], [now0, 2, 2, 2, 2]];
    const parts = (deribitAt: number) => [{ id: MARKET, bars }, { id: DERIBIT, bars, usdAt: deribitAt }, { id: HL, bars }];
    const store = new Store({ ...initialState(), marketId: MARKET, timeframe: '15m', oiMarkets: 'chart' }), source = new FakeSource();
    const hub = new Hub(store, source as unknown as DataSource);
    (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
    await hub.start();
    const ids = (): string[] => store.state.oiFine.map(part => part.id), deribit = () => store.state.oiFine.find(part => part.id === DERIBIT)!;
    store.set({ show: { ...store.state.show, oi: true }, oi: bars, oiInstrument: '', oiParts: parts(50_000) });
    await hub.loadOiFine();
    assert.deepEqual(ids(), [MARKET, DERIBIT, HL]);
    // The fake answers each market's open interest as 1,000 and up; Deribit's is USD, put in coins at the bars' price.
    assert.deepEqual([deribit().usdAt, deribit().bars[0]![4]], [50_000, 1_000 / 50_000]);
    // The bars on screen read again at a new price: the next whole read of the minutes (OI_WHOLE_MS on) takes it.
    store.set({ oiParts: parts(55_000) });
    clock += 10 * MIN;
    await hub.loadOiFine();
    assert.deepEqual([deribit().usdAt, deribit().bars[0]![4]], [55_000, 1_000 / 55_000]);
    // A market no longer counted goes at once (before the read for the markets left).
    store.set({ oiParts: parts(55_000).filter(part => part.id !== MARKET) });
    let load = hub.loadOiFine();
    assert.deepEqual(ids(), [DERIBIT, HL]);
    await load;
    // Only the Funding pane (on Hyperliquid, the first venue listing BTC) wants minutes: Hyperliquid's perpetual alone stays, counted or not.
    store.set({ show: { ...store.state.show, oi: false, funding: true } });
    load = hub.loadOiFine();
    assert.deepEqual(ids(), [HL]);
    await load;
    store.set({ oiParts: [], oiInstrument: MARKET, oi: bars });
    await hub.loadOiFine();
    assert.deepEqual(ids(), [HL], 'Hyperliquid no longer counted: its minutes stay for the Funding pane');
    store.set({ show: { ...store.state.show, funding: false } });
    await hub.loadOiFine();
    assert.equal(store.state.oiFine.length, 0, 'nothing wants them');
  } finally {
    Date.now = realNow;
  }
});
