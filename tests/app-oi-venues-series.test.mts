import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/app/hub.ts';
import { Store, initialState, type CandleRow, type OiBar } from '../src/app/store.ts';
import { pickOptions } from '../src/app/market-choice.ts';
import type { BootstrapState, DataSource, LiveHandlers } from '../src/app/source.ts';
import type { FlowFrame } from '../src/shared/flow.ts';

// A series shown afresh (another timeframe or chart market, its candles read) clears the open interest: the load that follows shows the bars
// read a moment ago at once, whether the read for it had landed before the candles or was still out, never an empty pane saying there is no
// history while it reads (review rounds 1 and 2 of the OI Venues fix, 2026-11-06).

const MIN = 60_000;
const TF: Record<string, number> = { '1m': MIN, '5m': 5 * MIN, '15m': 15 * MIN };
class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

const MARKETS = ['binance:BTCUSDT', 'bybit:BTCUSDT'];
const candlesFor = (tf: number): CandleRow[] => { const end = Math.floor(Date.now() / tf) * tf; return Array.from({ length: 60 }, (_, i): CandleRow => [end - (59 - i) * tf, 100, 101, 99, 100, 1] as unknown as CandleRow); };
class FakeSource {
  readonly kind = 'server' as const;
  handlers: LiveHandlers | null = null;
  asked: { id: string; tf: string; resolve(bars: OiBar[]): void }[] = [];
  candleAsked: { tf: string; resolve(c: CandleRow[]): void }[] = [];
  /** Candles answered at once, or held until the test answers them (`candleAsked`). */
  autoCandles = true;
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: MARKETS[0]!, markets: MARKETS.map(instrumentId => ({ instrumentId, marketType: 'perpetual' })), layers: {}, steps: {}, recorded: {}, columnMs: MIN, timeframes: [] } as unknown as BootstrapState;
  }
  connect(handlers: LiveHandlers): { close(): void; tape(on: boolean): void } { this.handlers = handlers; return { close() {}, tape() {} }; }
  candles(_id: string, tf: string): Promise<CandleRow[]> { if (this.autoCandles) return Promise.resolve(candlesFor(TF[tf]!)); return new Promise(resolve => { this.candleAsked.push({ tf, resolve }); }); }
  oi(id: string, tf: string): Promise<OiBar[]> { return new Promise(resolve => { this.asked.push({ id, tf, resolve }); }); }
  async prints() { return []; }
  async columns() { return { from: 0, to: 0, stepMs: MIN, instruments: [] } as never; }
  async flow(): Promise<FlowFrame> { return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const history = (close: number, tf: number): OiBar[] => { const end = Math.floor(Date.now() / tf) * tf; return Array.from({ length: 40 }, (_, i): OiBar => [end - (39 - i) * tf, close, close, close, close]); };
const level = (id: string): number => 100 * (MARKETS.indexOf(id) + 1);

/** Both venues chosen (Chosen markets), the 1m series and its open interest loaded. */
async function rig() {
  const store = new Store({ ...initialState(), marketId: MARKETS[0]!, timeframe: '1m', oiMarkets: 'custom' }), source = new FakeSource();
  const hub = new Hub(store, source as unknown as DataSource);
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  const pick = (id: string): string => pickOptions(store.state, null, [], true).find(option => option.id === id)!.pick;
  store.set({ customMarkets: { ...store.state.customMarkets, oi: MARKETS.map(pick) } });
  const answer = (): void => { for (const q of source.asked.splice(0)) q.resolve(history(level(q.id), TF[q.tf]!)); };
  const shown = () => ({ parts: store.state.oiParts.map(p => p.id), last: store.state.oi.at(-1)?.[4], reading: store.state.oiReading });
  await hub.loadSeries(true); await turn(); answer(); await turn();
  return { store, source, hub, answer, shown };
}

test('a series shown afresh wipes the open interest read for it a moment before: the next load shows those bars at once', async () => {
  const { store, source, hub, answer, shown } = await rig();
  // 15m is not kept: its candles are slow. The 20 s clock reads its open interest meanwhile and it lands before the candles do.
  source.autoCandles = false;
  store.set({ timeframe: '15m' }); const series = hub.loadSeries(true); await turn();
  const tick = hub.loadOi(); await turn(); answer(); await tick; await turn();
  assert.deepEqual(shown(), { parts: MARKETS, last: 300, reading: false }, 'read by the clock');
  // The candles land: the series is shown afresh, which wipes the open interest; the load that closes it asks again.
  for (const q of source.candleAsked.splice(0)) q.resolve(candlesFor(TF[q.tf]!));
  await series; await turn();
  assert.equal(source.asked.length, 2, 'asked again');
  assert.deepEqual(shown(), { parts: MARKETS, last: 300, reading: false }, 'shown from what was read a moment ago while it reads, not an empty pane saying there is no history');
  answer(); await turn();
});

test('a series shown afresh while the read of its open interest is still out: the next load does not wait on that read, it shows the bars held', async () => {
  const { store, source, hub, answer, shown } = await rig();
  // Another chart market, the same venues chosen: its open interest is the same venues' bars, read a moment ago at this timeframe.
  source.autoCandles = false;
  store.set({ marketId: MARKETS[1]! }); const series = hub.loadSeries(true); await turn();
  const tick = hub.loadOi(); await turn();
  assert.deepEqual(shown(), { parts: MARKETS, last: 300, reading: false }, 'the clock\'s load shows the bars held, its read out');
  const out = source.asked.splice(0);
  for (const q of source.candleAsked.splice(0)) q.resolve(candlesFor(TF[q.tf]!));
  await series; await turn();
  assert.deepEqual(shown(), { parts: MARKETS, last: 300, reading: false }, 'the candles shown afresh: the bars held again at once, not an empty pane until the read lands');
  for (const q of out) q.resolve(history(level(q.id), TF[q.tf]!)); await tick;
  answer(); await turn();
  assert.deepEqual(shown(), { parts: MARKETS, last: 300, reading: false });
});

test('the page\'s first read under Chosen markets, still out when the first candles land, is the answer: not asked again, shown when it lands', async () => {
  const store = new Store({ ...initialState(), marketId: MARKETS[0]!, timeframe: '1m', oiMarkets: 'custom' }), source = new FakeSource();
  source.autoCandles = false;
  const hub = new Hub(store, source as unknown as DataSource);
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  const pick = (id: string): string => pickOptions(store.state, null, [], true).find(option => option.id === id)!.pick;
  store.set({ customMarkets: { ...store.state.customMarkets, oi: MARKETS.map(pick) } });
  const shown = () => ({ parts: store.state.oiParts.map(p => p.id), last: store.state.oi.at(-1)?.[4], reading: store.state.oiReading });
  const series = hub.loadSeries(true); await turn();
  // The markets landed (main.ts asks for open interest under Chosen markets then): nothing held, so the pane says it is reading.
  const first = hub.loadOi(); await turn();
  const out = source.asked.splice(0);
  assert.deepEqual(shown(), { parts: [], last: undefined, reading: true });
  for (const q of source.candleAsked.splice(0)) q.resolve(candlesFor(TF[q.tf]!));
  await series; await turn();
  assert.equal(source.asked.length, 0, 'the load closing the candles joins the read out instead of queueing behind it');
  for (const q of out) q.resolve(history(level(q.id), TF[q.tf]!)); await first; await turn();
  assert.deepEqual(shown(), { parts: MARKETS, last: 300, reading: false }, 'its answer shown');
});
