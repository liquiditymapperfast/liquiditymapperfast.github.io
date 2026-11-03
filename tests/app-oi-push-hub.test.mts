import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/app/hub.ts';
import { Store, initialState, type CandleRow, type OiBar } from '../src/app/store.ts';
import type { BootstrapState, DataSource, LiveHandlers } from '../src/app/source.ts';
import type { FlowFrame } from '../src/shared/flow.ts';
import { oiTail } from '../src/app/oi-change.ts';

// Open-interest pushes as the hub takes them, against a source whose open-interest answers a test settles when it likes.

const MIN = 60_000;
class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

class FakeSource {
  readonly kind = 'server' as const;
  handlers: LiveHandlers | null = null;
  /** The open-interest questions, in the order asked, each with whether it asked for USD. */
  asked: { usd: boolean; from: number; to: number; resolve(bars: OiBar[]): void }[] = [];
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  constructor(private readonly market: string) {}
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: this.market, markets: [{ instrumentId: this.market, marketType: 'perpetual' }], layers: {}, steps: {}, recorded: {}, columnMs: MIN, timeframes: [], oiReferences: [] };
  }
  connect(handlers: LiveHandlers): { close(): void; tape(on: boolean): void } { this.handlers = handlers; return { close() {}, tape() {} }; }
  candles(): Promise<CandleRow[]> { return new Promise(() => {}); }
  oi(_id: string, _tf: string, from: number, to: number, usd = false): Promise<OiBar[]> { return new Promise(resolve => { this.asked.push({ usd, from, to, resolve }); }); }
  async prints() { return []; }
  async columns() { return { from: 0, to: 0, stepMs: MIN, instruments: [] } as never; }
  async flow(): Promise<FlowFrame> { return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
}

const now0 = Math.floor(Date.now() / MIN) * MIN;
/** Forty one-minute bars up to the minute under way, every one at `close`. */
const history = (close: number): OiBar[] => Array.from({ length: 40 }, (_, i): OiBar => [now0 - (39 - i) * MIN, close, close, close, close]);
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function rig(market: string, candles: CandleRow[] = []) {
  const store = new Store({ ...initialState(), marketId: market, timeframe: '1m', oiMarkets: 'chart', candles }), source = new FakeSource(market);
  const hub = new Hub(store, source as unknown as DataSource);
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  return { hub, store, source, push: (items: unknown[]) => source.handlers!.onOiPush!(items) };
}
/** Ask for open interest and answer it with `bars` once it is asked. */
async function load(r: Awaited<ReturnType<typeof rig>>, bars: OiBar[]): Promise<void> {
  const done = r.hub.loadOi(); await turn();
  r.source.asked.shift()!.resolve(bars); await done;
}

test('a pushed reading moves the newest bar, and one older than the last taken changes nothing', async () => {
  const r = await rig('binance:BTCUSDT');
  await load(r, history(100));
  r.push([{ instrumentId: 'binance:BTCUSDT', t: now0 + 40_000, base: 130 }]);
  assert.deepEqual(r.store.state.oi.at(-1), [now0, 100, 130, 100, 130]);
  r.push([{ instrumentId: 'binance:BTCUSDT', t: now0 + 20_000, base: 90 }]);
  assert.deepEqual(r.store.state.oi.at(-1), [now0, 100, 130, 100, 130], 'an older reading of the same minute is not the close');
  r.push([{ instrumentId: 'okx:BTC-USDT-SWAP', t: now0 + 50_000, base: 1 }]);
  assert.deepEqual(r.store.state.oi.at(-1), [now0, 100, 130, 100, 130], 'another market\'s reading is not this one\'s');
});

test('a load that was asked before a push and answers after it keeps the push', async () => {
  const r = await rig('binance:BTCUSDT');
  await load(r, history(100));
  const done = r.hub.loadOi(); await turn();
  r.push([{ instrumentId: 'binance:BTCUSDT', t: now0 + 30_000, base: 120 }]);
  assert.equal(r.store.state.oi.at(-1)![4], 120, 'shown at once');
  r.source.asked.shift()!.resolve(history(100)); await done;
  assert.equal(r.store.state.oi.at(-1)![4], 120, 'the answer held what the source had when asked; the push is put on it again');
  await load(r, history(100));
  assert.equal(r.store.state.oi.at(-1)![4], 100, 'a load asked after the push is the reconciliation');
});

test('an inverse market\'s push goes in as its USD at the bars\' one price, never as its coins at its own mark', async () => {
  const candles: CandleRow[] = [[now0, 100, 100, 100, 100, 1]];
  const r = await rig('deribit:BTC-PERPETUAL', candles);
  const done = r.hub.loadOi(); await turn();
  const usd = r.source.asked.shift()!;
  assert.equal(usd.usd, true, 'an inverse market is asked for its USD');
  usd.resolve(history(1_000_000)); await done;
  assert.equal(r.store.state.oi.at(-1)![4], 10_000, '1,000,000 USD at 100');
  assert.equal(r.store.state.oiPrice, 100);
  // The price went to 110 and no contract opened: the coins at the mark fell, the USD did not.
  r.push([{ instrumentId: 'deribit:BTC-PERPETUAL', t: now0 + 10_000, base: 1_000_000 / 110, quote: 1_000_000 }]);
  assert.equal(r.store.state.oi.at(-1)![4], 10_000, 'a price move alone changes nothing');
  r.push([{ instrumentId: 'deribit:BTC-PERPETUAL', t: now0 + 20_000, base: 1_010_000 / 110, quote: 1_010_000 }]);
  assert.equal(r.store.state.oi.at(-1)![4], 10_100, '10,000 USD opened is 100 coins at the bars\' price');
  r.push([{ instrumentId: 'deribit:BTC-PERPETUAL', t: now0 + 30_000, base: 9_000 }]);
  assert.equal(r.store.state.oi.at(-1)![4], 10_100, 'without its USD a reading is left for the next load');
});

test("the 20-second refresh reads only the last bars again and puts them on those held; a failed one takes nothing back", async () => {
  const r = await rig('binance:BTCUSDT');
  await load(r, history(100));
  let done = r.hub.loadOi(); await turn();
  const tail = r.source.asked.shift()!;
  assert.equal(tail.from, now0 - MIN, 'from the bar before the last held');
  tail.resolve([[now0 - MIN, 100, 101, 100, 101], [now0, 101, 102, 101, 102]]); await done;
  assert.equal(r.store.state.oi.length, 40);
  assert.deepEqual(r.store.state.oi.slice(-3).map(b => b[4]), [100, 101, 102], 'the held bars before it kept, the last two replaced');
  done = r.hub.loadOi(); await turn();
  r.source.asked.shift()!.resolve([]); await done;
  assert.deepEqual(r.store.state.oi.slice(-2).map(b => b[4]), [101, 102], 'a refresh that brought nothing changes nothing');
});

test('a refresh asked again while its tail is still out is the same load: one question', async () => {
  const r = await rig('binance:BTCUSDT');
  await load(r, history(100));
  const a = r.hub.loadOi(), b = r.hub.loadOi(); await turn();
  assert.equal(a, b);
  assert.equal(r.source.asked.length, 1);
  r.source.asked.shift()!.resolve([]); await a;
});

test("the minute's reload of the same series keeps the refresh to the last bars; another series reads whole", async () => {
  const r = await rig('binance:BTCUSDT');
  // The page's first load of its series (main.ts), then its open interest read whole.
  void r.hub.loadSeries().catch(() => {}); await turn();
  await load(r, history(100));
  void r.hub.loadSeries(true).catch(() => {}); await turn();
  let done = r.hub.loadOi(); await turn();
  const tail = r.source.asked.shift()!;
  assert.equal(tail.from, now0 - MIN, 'still only the last bars');
  tail.resolve([]); await done;
  r.store.set({ timeframe: '5m' });
  void r.hub.loadSeries(true).catch(() => {}); await turn();
  done = r.hub.loadOi(); await turn();
  const whole = r.source.asked.shift()!;
  assert.ok(whole.from < now0 - 400 * 5 * MIN, 'another timeframe is read whole');
  whole.resolve([]); await done;
});

test('an inverse market read before there were candles (its coins at no one price) is read whole again, never only its tail', async () => {
  const r = await rig('deribit:BTC-PERPETUAL');
  await load(r, history(1_000_000));
  assert.equal(r.store.state.oiPrice, 0, 'no candles: no one price');
  const done = r.hub.loadOi(); await turn();
  const again = r.source.asked.shift()!;
  assert.ok(again.from < now0 - 400 * MIN, 'whole');
  again.resolve([]); await done;
});

test('a market whose bars stopped long ago is asked for its last few bars only', async () => {
  const r = await rig('binance:BTCUSDT');
  await load(r, history(100).slice(0, 10));
  const done = r.hub.loadOi(); await turn();
  const tail = r.source.asked.shift()!;
  assert.equal(tail.from, now0 - 6 * MIN, 'six bars back, not from its last bar thirty minutes ago');
  tail.resolve([]); await done;
});

test('oiTail: the tail from its first bar on, the held ones before it and from where they are kept', () => {
  const bar = (t: number, v: number): OiBar => [t, v, v, v, v];
  const held = [bar(1, 1), bar(2, 2), bar(3, 3), bar(4, 4)];
  assert.deepEqual(oiTail(held, [bar(3, 30), bar(4, 40), bar(5, 50)], 3, 2), [bar(2, 2), bar(3, 30), bar(4, 40), bar(5, 50)]);
  assert.deepEqual(oiTail(held, [bar(4, 40)], 3, 0), [bar(1, 1), bar(2, 2), bar(3, 3), bar(4, 40)], 'a tail starting later keeps the held bar before it');
  assert.deepEqual(oiTail(held, [], 3, 2), [bar(2, 2), bar(3, 3), bar(4, 4)], 'nothing read: the held ones');
});

test('when the recordings and the recorded history land (the browser reads them after its feeds start), open interest is read whole again and the flow asked for again', async () => {
  const r = await rig('binance:BTCUSDT');
  await load(r, history(100));
  // The 20-second refresh would read only the newest bars: what the recordings kept further back would never be shown.
  const loads = r.hub.flow.loads;
  r.source.handlers!.onHistory!();
  await turn();
  const asked = r.source.asked.shift();
  assert.ok(asked, 'open interest is asked for again');
  assert.equal(asked.to - asked.from, 501 * MIN, 'whole, not only its last bars');
  asked.resolve(history(200)); await turn();
  assert.deepEqual(r.store.state.oi.at(0), [now0 - 39 * MIN, 200, 200, 200, 200]);
  assert.ok(r.hub.flow.loads > loads, 'the flow held (the live seconds alone) is asked for again');
});
