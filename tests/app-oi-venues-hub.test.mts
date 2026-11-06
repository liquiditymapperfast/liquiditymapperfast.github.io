import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/app/hub.ts';
import { Store, initialState, type CandleRow, type OiBar } from '../src/app/store.ts';
import { pickOptions } from '../src/app/market-choice.ts';
import type { BootstrapState, DataSource, LiveHandlers } from '../src/app/source.ts';
import type { FlowFrame } from '../src/shared/flow.ts';

// A change of the OI pane's Venues (or of the markets chosen) as the hub takes it, against a source whose open-interest answers a test settles
// when it likes: the old choice's bars are never shown under the new one (Karl, 2026-11-06: a choice looked as if it had not been taken while
// its read waited behind the page's history reads).

const MIN = 60_000;
class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

const MARKETS = ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP'];
class FakeSource {
  readonly kind = 'server' as const;
  handlers: LiveHandlers | null = null;
  /** The open-interest questions, in the order asked. */
  asked: { id: string; resolve(bars: OiBar[]): void }[] = [];
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: MARKETS[0]!, markets: MARKETS.map(instrumentId => ({ instrumentId, marketType: 'perpetual' })), layers: {}, steps: {}, recorded: {}, columnMs: MIN, timeframes: [] } as unknown as BootstrapState;
  }
  connect(handlers: LiveHandlers): { close(): void; tape(on: boolean): void } { this.handlers = handlers; return { close() {}, tape() {} }; }
  candles(): Promise<CandleRow[]> { return new Promise(() => {}); }
  oi(id: string): Promise<OiBar[]> { return new Promise(resolve => { this.asked.push({ id, resolve }); }); }
  async prints() { return []; }
  async columns() { return { from: 0, to: 0, stepMs: MIN, instruments: [] } as never; }
  async flow(): Promise<FlowFrame> { return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
}

const now0 = Math.floor(Date.now() / MIN) * MIN;
/** Forty one-minute bars up to the minute under way, every one at `close`. */
const history = (close: number, n = 40): OiBar[] => Array.from({ length: n }, (_, i): OiBar => [now0 - (n - 1 - i) * MIN, close, close, close, close]);
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function rig() {
  const store = new Store({ ...initialState(), marketId: MARKETS[0]!, timeframe: '1m', oiMarkets: 'chart' }), source = new FakeSource();
  const hub = new Hub(store, source as unknown as DataSource);
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  // The pick of each market (exchange and kind), as the Choose panel ticks it.
  const pick = (id: string): string => pickOptions(store.state, null, [], true).find(option => option.id === id)!.pick;
  /** Choose `ids` (Chosen markets) or 'chart', and ask for open interest as the page does on that change; the load is returned unanswered (in an object: an async function would wait for it). */
  const choose = async (ids: string[] | 'chart'): Promise<{ done: Promise<void> }> => {
    store.set(ids === 'chart' ? { oiMarkets: 'chart' } : { oiMarkets: 'custom', customMarkets: { ...store.state.customMarkets, oi: ids.map(pick) } });
    const done = hub.loadOi(); await turn(); return { done };
  };
  /** Answer every question out with `close` (each market its own level, so a sum tells them apart); a market given `n` 0 answers nothing. */
  const answer = (close: (id: string) => number, n: (id: string) => number = () => 40): void => { for (const q of r.source.asked.splice(0)) q.resolve(history(close(q.id), n(q.id))); };
  const r = { hub, store, source, choose, answer, shown: () => ({ inst: store.state.oiInstrument, parts: store.state.oiParts.map(p => p.id), last: store.state.oi.at(-1)?.[4], reading: store.state.oiReading }) };
  return r;
}
const level = (id: string): number => 100 * (MARKETS.indexOf(id) + 1);

test('a choice of markets the pane holds shows at once, before its read answers', async () => {
  const r = await rig();
  let done = (await r.choose(['binance:BTCUSDT', 'bybit:BTCUSDT'])).done;
  r.answer(level); await done;
  assert.deepEqual(r.shown(), { inst: '', parts: ['binance:BTCUSDT', 'bybit:BTCUSDT'], last: 300, reading: false }, 'two venues added together');
  done = (await r.choose(['bybit:BTCUSDT'])).done;
  assert.deepEqual(r.shown(), { inst: 'bybit:BTCUSDT', parts: [], last: 200, reading: false }, 'one of them alone, from the bars held, while its read is out');
  r.answer(level); await done;
  assert.deepEqual(r.shown(), { inst: 'bybit:BTCUSDT', parts: [], last: 200, reading: false }, 'then from its answer');
  done = (await r.choose('chart')).done;
  assert.deepEqual(r.shown(), { inst: 'binance:BTCUSDT', parts: [], last: 100, reading: false }, 'the chart market, read a moment ago among the venues: at once too');
  r.answer(level); await done;
  assert.deepEqual(r.shown(), { inst: 'binance:BTCUSDT', parts: [], last: 100, reading: false });
});

test('a choice made through others (Chosen markets with none ticked, then a box) is shown from the bars read a moment before', async () => {
  const r = await rig();
  let done = (await r.choose(['binance:BTCUSDT', 'bybit:BTCUSDT'])).done;
  r.answer(level); await done;
  done = (await r.choose([])).done; await done;
  assert.deepEqual(r.shown(), { inst: '', parts: [], last: undefined, reading: false }, 'none ticked: nothing');
  done = (await r.choose(['okx:BTC-USDT-SWAP', 'bybit:BTCUSDT'])).done;
  assert.deepEqual(r.shown(), { inst: '', parts: [], last: undefined, reading: true }, 'OKX was never read: reading');
  r.answer(level); await done;
  done = (await r.choose(['bybit:BTCUSDT'])).done;
  assert.deepEqual(r.shown(), { inst: 'bybit:BTCUSDT', parts: [], last: 200, reading: false }, 'Bybit alone, read a moment ago: at once');
  r.answer(level); await done;
  done = (await r.choose(['binance:BTCUSDT', 'okx:BTC-USDT-SWAP'])).done;
  assert.deepEqual(r.shown(), { inst: '', parts: ['binance:BTCUSDT', 'okx:BTC-USDT-SWAP'], last: 400, reading: false }, 'Binance and OKX, each read a moment ago in another choice: added together at once');
  r.answer(level); await done;
  // The browser's recordings landing make the bars read before them partial: none is shown from them after.
  r.source.handlers!.onHistory!(); await turn(); r.answer(level); await turn();
  done = (await r.choose(['bybit:BTCUSDT'])).done;
  assert.deepEqual(r.shown(), { inst: '', parts: [], last: undefined, reading: true }, 'after the recordings landed: read again first');
  r.answer(level); await done;
});

test('a choice the pane does not hold never shows the old choice under it: cleared and read, the latest choice\'s answer alone is taken', async () => {
  const r = await rig();
  let done = (await r.choose(['binance:BTCUSDT'])).done;
  r.answer(level); await done;
  assert.deepEqual(r.shown(), { inst: 'binance:BTCUSDT', parts: [], last: 100, reading: false });
  const first = (await r.choose(['binance:BTCUSDT', 'okx:BTC-USDT-SWAP'])).done;
  assert.deepEqual(r.shown(), { inst: '', parts: [], last: undefined, reading: true }, 'Binance alone is not shown as the two of them');
  const stale = r.source.asked.splice(0);
  done = (await r.choose(['okx:BTC-USDT-SWAP'])).done;
  assert.deepEqual(r.shown(), { inst: '', parts: [], last: undefined, reading: true }, 'chosen again before the answer: still reading');
  for (const q of stale) q.resolve(history(level(q.id))); await first;
  assert.deepEqual(r.shown(), { inst: '', parts: [], last: undefined, reading: true }, 'the answer to the choice left is not shown, and does not end the reading');
  r.answer(level); await done;
  assert.deepEqual(r.shown(), { inst: 'okx:BTC-USDT-SWAP', parts: [], last: 300, reading: false });
});

test('the same choice read whole again keeps what it shows; a choice that counts nothing ends its reading at once', async () => {
  const r = await rig();
  let done = (await r.choose(['binance:BTCUSDT', 'bybit:BTCUSDT'])).done;
  r.answer(level); await done;
  // The browser's recordings landing ask for open interest whole again (`onHistory`), the same markets.
  r.source.handlers!.onHistory!(); await turn();
  assert.equal(r.source.asked.length, 2, 'read whole again');
  assert.deepEqual(r.shown(), { inst: '', parts: ['binance:BTCUSDT', 'bybit:BTCUSDT'], last: 300, reading: false }, 'kept while it is read');
  r.answer(level); await turn();
  done = (await r.choose([])).done;
  await done;
  assert.deepEqual(r.shown(), { inst: '', parts: [], last: undefined, reading: false }, 'none ticked: nothing counted, nothing being read');
});

test('a weak chart market (few readings) read whole again keeps what it shows, though a new choice would not be shown from it', async () => {
  const r = await rig();
  let done = (await r.choose('chart')).done;
  r.answer(level, () => 10); await done;
  assert.deepEqual(r.shown(), { inst: 'binance:BTCUSDT', parts: [], last: 100, reading: false }, 'ten readings: weak, shown as the best there is');
  r.source.handlers!.onHistory!(); await turn();
  assert.deepEqual(r.shown(), { inst: 'binance:BTCUSDT', parts: [], last: 100, reading: false }, 'the same choice read again: kept, not cleared for being weak');
  r.answer(level, () => 10); await turn();
  // Another choice, then back to the chart market: its bars held are weak (a reference market may stand in), so it is read first.
  done = (await r.choose(['bybit:BTCUSDT'])).done; r.answer(level); await done;
  done = (await r.choose('chart')).done;
  assert.deepEqual(r.shown(), { inst: '', parts: [], last: undefined, reading: true }, 'a new choice is not shown from the weak bars');
  r.answer(level, () => 10); await done;
});

test('a venue that answered nothing is held as nothing: a choice counting it is shown at once from the others', async () => {
  const r = await rig();
  let done = (await r.choose(['binance:BTCUSDT', 'okx:BTC-USDT-SWAP'])).done;
  r.answer(level, id => id.startsWith('okx') ? 0 : 40); await done;
  assert.deepEqual(r.shown(), { inst: 'binance:BTCUSDT', parts: [], last: 100, reading: false }, 'OKX answered nothing: Binance alone');
  done = (await r.choose(['binance:BTCUSDT'])).done; r.answer(level); await done;
  done = (await r.choose(['binance:BTCUSDT', 'okx:BTC-USDT-SWAP'])).done;
  assert.deepEqual(r.shown(), { inst: 'binance:BTCUSDT', parts: [], last: 100, reading: false }, 'the two again: at once, not cleared for the one that answered nothing');
  r.answer(level, id => id.startsWith('okx') ? 0 : 40); await done;
  // Every market of a choice answered nothing a moment ago: nothing to show, so it is read (never the old choice left standing).
  done = (await r.choose(['okx:BTC-USDT-SWAP'])).done;
  assert.deepEqual(r.shown(), { inst: '', parts: [], last: undefined, reading: true }, 'only OKX, which answered nothing: cleared and read');
  r.answer(level, () => 0); await done;
  assert.deepEqual(r.shown(), { inst: '', parts: [], last: undefined, reading: false }, 'it answers nothing again: nothing, and no longer reading');
});

test('bars read more than two minutes ago are not shown for a new choice', async () => {
  const r = await rig(), realNow = Date.now;
  let done = (await r.choose(['binance:BTCUSDT', 'bybit:BTCUSDT'])).done;
  r.answer(level); await done;
  done = (await r.choose([])).done; await done;
  try {
    const later = realNow() + 2 * 60_000 + 1_000;
    Date.now = () => later;
    done = (await r.choose(['bybit:BTCUSDT'])).done;
    assert.deepEqual(r.shown(), { inst: '', parts: [], last: undefined, reading: true }, 'read 2 min 1 s ago: read again first');
    r.answer(level); await done;
  } finally { Date.now = realNow; }
});
