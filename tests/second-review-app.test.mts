import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/app/hub.ts';
import { Store, initialState, type AppState, type CandleRow, type OiBar } from '../src/app/store.ts';
import type { BootstrapState, DataSource, LiveHandlers, TickMessage } from '../src/app/source.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { Alerts, type Player } from '../src/app/sound/alerts.ts';
import { readSounds, type Note } from '../src/app/sound/rules.ts';
import { WallWatch, bookBins } from '../src/app/sound/alert-rules.ts';
import type { LevelsFrame } from '../src/app/wire.ts';
import { flowIds } from '../src/app/cvd/ids.ts';
import { explainMissing } from '../src/app/cvd/missing.ts';
import { depthKey } from '../src/app/panes/pane-cards.ts';
import type { FlowFrame } from '../src/shared/flow.ts';

// What the second outside review found in the page, each as the smallest case that shows it.

const MIN = 60_000, HOUR = 3_600_000;
class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

type Call<T> = { resolve(value: T): void; reject(error: Error): void };
class FakeSource {
  readonly kind = 'server' as const;
  handlers: LiveHandlers | null = null;
  /** Candle requests wait for the test unless an answer for their timeframe was given in advance. */
  candleCalls: (Call<CandleRow[]> & { inst: string; tf: string; from: number; to: number })[] = [];
  auto = new Map<string, CandleRow[]>();
  oiCalls: (Call<OiBar[]> & { inst: string; tf: string })[] = [];
  printCalls: (Call<unknown[]> & { from: number; to: number })[] = [];
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: 'ref:BTC', markets: [{ instrumentId: 'ref:BTC' }], layers: {}, steps: {}, recorded: {}, columnMs: MIN, timeframes: [], oiReferences: [] };
  }
  connect(handlers: LiveHandlers): { close(): void } { this.handlers = handlers; return { close() {} }; }
  candles(inst: string, tf: string, from: number, to: number): Promise<CandleRow[]> {
    const answer = this.auto.get(tf); if (answer) return Promise.resolve(answer);
    return new Promise((resolve, reject) => { this.candleCalls.push({ inst, tf, from, to, resolve, reject }); });
  }
  oi(inst: string, tf: string): Promise<OiBar[]> { return new Promise((resolve, reject) => { this.oiCalls.push({ inst, tf, resolve, reject }); }); }
  prints(from: number, to: number): Promise<unknown[]> { return new Promise((resolve, reject) => { this.printCalls.push({ from, to, resolve, reject }); }); }
  async columns() { return { from: 0, to: 0, stepMs: MIN, instruments: [] } as never; }
  async flow(): Promise<FlowFrame> { return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
}
async function rig(patch: Partial<AppState> = {}) {
  const store = new Store({ ...initialState(), ...patch }), source = new FakeSource();
  const hub = new Hub(store, source as unknown as DataSource);
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  return { hub, store, source, handlers: () => source.handlers! };
}
const tick = (over: Partial<TickMessage> = {}): TickMessage => ({ t: 'tick', price: 100, instrumentId: 'ref:BTC', asOf: 0, candles: {}, ...over });
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const BASE = Date.UTC(2026, 9, 6, 12, 0, 0);

// ---- 3 and 4: a snapshot and the live candle seen while it was on its way -----------------------------------------------------------------------

test('a tick that is older than the snapshot does not put its close on the candle the snapshot has just set', async t => {
  const M = BASE; t.mock.timers.enable({ apis: ['Date'], now: M + 20_000 });
  const { hub, store, source, handlers } = await rig({ marketId: 'ref:BTC', timeframe: '1m', seriesInstrument: 'ref:BTC', candles: [] });
  void hub.loadSeries(true); await turn();
  handlers().onTick(tick({ asOf: M + 20_000, candles: { 'ref:BTC': [M, 100, 100, 100, 100, 10] } }));     // seen while the request is out: close 100, volume 10
  source.candleCalls[0]!.resolve([[M, 100, 111, 99, 110, 20, 1]]); await turn();                          // the snapshot was taken after it: close 110, volume 20
  const last = store.state.candles.at(-1)!;
  assert.deepEqual([last[4], last[5]], [110, 20], 'close 100 with volume 20 is neither');
});

const answer = async (source: FakeSource, row: CandleRow): Promise<void> => { source.candleCalls.at(-1)!.resolve([row]); await turn(); await turn(); };

test('a series that is loaded again keeps what the live stream added to the open candle, and goes on counting from it', async t => {
  const B = Math.floor(BASE / (5 * MIN)) * (5 * MIN), now = B + 3 * MIN + 20_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const { hub, store, source, handlers } = await rig({ marketId: 'ref:BTC', timeframe: '5m', seriesInstrument: 'ref:BTC', candles: [] });
  void hub.loadSeries(true); await turn();
  await answer(source, [B, 1, 1, 1, 1, 100, 1]);                                                         // 90 from the complete minutes and 10 of the one that is live
  handlers().onTick(tick({ asOf: now, candles: { 'ref:BTC': [B + 3 * MIN, 1, 1, 1, 1, 10] } }));          // the first the stream says of that minute
  handlers().onTick(tick({ asOf: now + 500, candles: { 'ref:BTC': [B + 3 * MIN, 1, 3, 1, 2, 30] } }));    // it grows to 30 and the range widens
  assert.equal(store.state.candles.at(-1)![5], 120);
  void hub.loadSeries(true); await turn();                                                               // the minute's refresh
  await answer(source, [B, 1, 2, 1, 2, 105, 1]);                                                         // the venue's own candle is a little behind the stream
  const kept = store.state.candles.at(-1)!;
  assert.deepEqual([kept[2], kept[3], kept[5]], [3, 1, 120], 'the snapshot (high 2, volume 105) took away what the stream had added');
  handlers().onTick(tick({ asOf: now + 1_000, candles: { 'ref:BTC': [B + 3 * MIN, 1, 3, 1, 2, 31] } }));
  assert.equal(store.state.candles.at(-1)![5], 121, 'and the count goes on from 120, not from the snapshot\'s 105');
});

test('a snapshot that is ahead of the stream is counted once: the next tick brings the whole volume of the minute, not an increment', async t => {
  const B = Math.floor(BASE / (5 * MIN)) * (5 * MIN), now = B + 3 * MIN + 20_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const { hub, store, source, handlers } = await rig({ marketId: 'ref:BTC', timeframe: '5m', seriesInstrument: 'ref:BTC', candles: [] });
  void hub.loadSeries(true); await turn();
  await answer(source, [B, 1, 1, 1, 1, 100, 1]);
  handlers().onTick(tick({ asOf: now, candles: { 'ref:BTC': [B + 3 * MIN, 1, 1, 1, 1, 10] } }));
  handlers().onTick(tick({ asOf: now + 500, candles: { 'ref:BTC': [B + 3 * MIN, 1, 1, 1, 1, 30] } }));   // 90 before the live minute and 30 in it
  assert.equal(store.state.candles.at(-1)![5], 120);
  void hub.loadSeries(true); await turn();
  await answer(source, [B, 1, 1, 1, 1, 125, 1]);                                                         // the snapshot has 5 more than the last tick said: the minute went on
  assert.equal(store.state.candles.at(-1)![5], 125);
  handlers().onTick(tick({ asOf: now + 1_000, candles: { 'ref:BTC': [B + 3 * MIN, 1, 1, 1, 1, 35] } }));  // and now the stream says so: the minute has 35
  assert.equal(store.state.candles.at(-1)![5], 125, 'the 5 are in the snapshot and in the tick: counted twice they make 130');
  handlers().onTick(tick({ asOf: now + 1_500, candles: { 'ref:BTC': [B + 3 * MIN, 1, 1, 1, 1, 40] } }));
  assert.equal(store.state.candles.at(-1)![5], 130, 'and it goes on from there');
  // the same again, and the minute after
  void hub.loadSeries(true); await turn();
  await answer(source, [B, 1, 1, 1, 1, 133, 1]);
  handlers().onTick(tick({ asOf: now + 2_000, candles: { 'ref:BTC': [B + 3 * MIN, 1, 1, 1, 1, 43] } }));
  assert.equal(store.state.candles.at(-1)![5], 133, 'every reload that finds the snapshot ahead is counted once, not added to the ones before');
});

test('the same holds for a one minute series, and the snapshot of another timeframe is not taken for the one on screen', async t => {
  const M = BASE; t.mock.timers.enable({ apis: ['Date'], now: M + 20_000 });
  const { hub, store, source } = await rig({ marketId: 'ref:BTC', timeframe: '1m', seriesInstrument: 'ref:BTC', candles: [] });
  void hub.loadSeries(true); await turn();
  await answer(source, [M, 1, 5, 1, 4, 20, 1]);
  store.set({ candles: [[M, 1, 7, 1, 6, 26, 1]] });                                                      // the stream moved the minute on
  void hub.loadSeries(true); await turn();
  await answer(source, [M, 1, 5, 1, 4, 22, 1]);
  const refreshed = store.state.candles.at(-1)!;
  assert.deepEqual([refreshed[2], refreshed[5]], [7, 26], 'a minute does not lose volume or range');
  // a different timeframe at the same start must not borrow the volume of the one that was on screen
  store.set({ timeframe: '5m' });
  void hub.loadSeries(true); await turn();
  await answer(source, [M, 1, 5, 1, 4, 3, 1]);
  assert.equal(store.state.candles.at(-1)![5], 3, 'the one minute candle\'s 26 is not the five minute candle\'s');
});

// ---- 8: open interest for the timeframe that was just left ------------------------------------------------------------------------------------------

test('an open-interest answer for the timeframe that was just left does not fill the new one, and a failed request leaves no candles of the old one', async () => {
  const { hub, store, source } = await rig({ marketId: 'ref:BTC', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });
  source.auto.set('1h', [[BASE, 1, 1, 1, 1, 5, 1]]);
  void hub.loadSeries(true); await turn(); await turn();                                                  // the 1h candles are in and its open interest is being asked for
  assert.equal(source.oiCalls.length, 1);
  store.set({ timeframe: '5m' });
  const failed = hub.loadSeries().catch(() => 'failed'); await turn();                                    // the new timeframe: its candles are being asked for
  source.oiCalls[0]!.resolve([[BASE, 1, 1, 1, 1]]); await turn();                                       // the old answer comes in meanwhile
  assert.deepEqual(store.state.oi, [], 'one hour bars are not the five minute view\'s');
  source.candleCalls[0]!.reject(new Error('the venue did not answer')); await failed;
  assert.equal(store.state.candles.length, 0, 'one hour candles are not left standing under the five minute label');
});

test('open interest goes with the candles it belongs to: another timeframe takes it away, also when that one fails to load, and a refresh of the same series keeps it', async () => {
  const { hub, store, source } = await rig({ marketId: 'ref:BTC', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });
  source.auto.set('1h', [[BASE, 1, 1, 1, 1, 5, 1]]); source.auto.set('5m', [[BASE, 1, 1, 1, 1, 5, 1]]);
  void hub.loadSeries(true); await turn(); await turn();
  source.oiCalls.at(-1)!.resolve([[BASE, 1, 1, 1, 1]]); await turn(); await turn();
  assert.equal(store.state.oi.length, 1, 'the one hour bars are here');
  void hub.loadSeries(true); await turn(); await turn();                                                 // the minute's refresh of the same series
  assert.equal(store.state.oi.length, 1, 'a refresh does not blank the pane while it waits for the same bars again');
  store.set({ timeframe: '5m' });
  void hub.loadSeries(); await turn(); await turn();                                                     // the five minute candles are here, their open interest is not
  assert.deepEqual(store.state.oi, [], 'one hour bars are not the five minute view, whatever it is still waiting for');
  source.oiCalls.at(-1)!.resolve([[BASE, 2, 2, 2, 2]]); await turn(); await turn();
  assert.equal(store.state.oi.length, 1, 'its own bars take their place when they come');
  store.set({ timeframe: '15m' });                                                                       // a timeframe whose candles cannot be had
  const failed = hub.loadSeries().catch(() => 'failed'); await turn();
  source.candleCalls.at(-1)!.reject(new Error('the venue did not answer')); await failed;
  assert.deepEqual([store.state.candles.length, store.state.oi.length, store.state.oiInstrument], [0, 0, ''], 'neither the candles nor the open interest of the five minute view stay under the fifteen minute label');
});

// ---- 9: print history from before a reconnection ----------------------------------------------------------------------------------------------------

test('a print history answer from before a reconnection does not mark the time the stream was down as covered', async () => {
  const { hub, source, handlers } = await rig();
  const now = Date.now(), view = { t0: now - 600_000, t1: now - 1_000, p0: 0, p1: 1 };
  hub.ensurePrints(view); await turn();
  assert.equal(source.printCalls.length, 1);
  handlers().onClose(1, 'host'); handlers().onOpen();                                                    // the stream broke and came back
  source.printCalls[0]!.resolve([]); await turn();                                                       // an answer that was already on its way
  hub.ensurePrints(view); await turn();
  assert.equal(source.printCalls.length, 2, 'the window is fetched again for the time the stream missed');
});

// ---- 10: the depth pane's request ------------------------------------------------------------------------------------------------------------------

test('the depth request is made again when the recorded columns it was waiting for arrive, and for nothing that does not change its answer', () => {
  const key = (over: Partial<{ ids: string[]; t0: number; t1: number; w: number; range: number; columns: number }> = {}): string => {
    const a = { ids: ['a:BTC'], t0: 1_000.4, t1: 2_000.2, w: 800, range: 0.2, columns: 3, ...over };
    return depthKey(a.ids, a.t0, a.t1, a.w, a.range, a.columns);
  };
  assert.notEqual(key({ columns: 4 }), key(), 'columns arrived: the answer was made from fewer');
  for (const over of [{ ids: ['a:BTC', 'b:BTC'] }, { t0: 1_100 }, { t1: 2_100 }, { w: 900 }, { range: 0.1 }]) assert.notEqual(key(over), key(), JSON.stringify(over));
  assert.equal(key({ t0: 1_000.2, t1: 2_000.4 }), key(), 'a fraction of a millisecond of view is not another request');
  // A map following the live edge moves a little every frame: within a column of the answer (here 1000 ms over 400 columns) it is the same request.
  assert.equal(key({ t0: 1_001.9, t1: 2_001.7 }), key(), 'the view moved by less than a column');
  assert.notEqual(key({ t0: 1_003, t1: 2_002.8 }), key(), 'the view moved by a column');
});

// ---- 11: a frame that lists no books ----------------------------------------------------------------------------------------------------------------------

test('a received frame with no books is not the same as no frame yet', () => {
  const markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }, { instrumentId: 'b:BTC', venue: 'b', marketType: 'perpetual' }];
  const state = (levels: AppState['levels']) => ({ markets, disabledVenues: [] as string[], scope: 'all' as const, levels });
  assert.deepEqual(flowIds(state(null), []).sort(), ['a:BTC', 'b:BTC'], 'before the first frame nothing is known: every market stands');
  assert.deepEqual(flowIds(state({ asOf: 0, books: [] }), ['a:BTC']), [], 'the last book has expired: nothing is on the map, and a venue recorded earlier does not come back as a row');
  const missing = explainMissing(state({ asOf: 0, books: [] }), ['a:BTC', 'b:BTC'], new Set(), () => 1);
  assert.deepEqual(missing.map(m => [m.key, m.why]), [['a', 'nobook'], ['b', 'nobook']]);
});

// ---- 5 and 6: the sound alerts ----------------------------------------------------------------------------------------------------------------------------------

class Quiet implements Player { played: Note[][] = []; play(notes: readonly Note[]): boolean { this.played.push([...notes]); return true; } async unlock(): Promise<void> {} }
const candleRow = (t: number): AppState['candles'][number] => [t, 1, 1, 1, 1, 1, 1];

test('a candle delta is not announced when one contributor has only the end of the candle, however full the others are', () => {
  const T0 = Date.UTC(2026, 9, 6, 12, 0, 0), close = T0 + HOUR, now = close + 2_000;
  const state: AppState = initialState();
  state.sounds = readSounds({ on: true, volume: 1, panels: { bars: { delta: true, usd: 3_000_000 } } });
  state.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }, { instrumentId: 'b:BTC', venue: 'b', marketType: 'perpetual' }];
  state.timeframe = '1h'; state.marketId = 'a:BTC';
  const flow = new FlowBook(), player = new Quiet(), alerts = new Alerts({ state }, flow, player, () => now, () => {});
  const frame = (id: string, t0: number, seconds: number, perSecond: number): FlowFrame['instruments'][number] => ({ id, t0, buy: new Float32Array(seconds).fill(perSecond), sell: new Float32Array(seconds) });
  const ask = T0 - 5 * MIN;                                                                                                               // what the page asks for before the candle
  flow.begin(['a:BTC', 'b:BTC']);
  flow.load({ from: ask, to: close, instruments: [frame('a:BTC', T0, 3_600, 1_000), frame('b:BTC', close - 60_000, 60, 100_000)] }, ['a:BTC', 'b:BTC'], ask);   // a: the whole hour; b: its last minute, and that is where the $6M is
  state.candles = [candleRow(T0 - HOUR), candleRow(T0)]; alerts.tick(now - 2_000);
  state.candles = [candleRow(T0 - HOUR), candleRow(T0), candleRow(close)]; alerts.tick(now);
  assert.equal(player.played.length, 0, 'the hour\'s delta without 59 minutes of one of its contributors is not the hour\'s delta');

  // the same candle with b recording from its start sounds: it is the coverage of b that was refused, not the history or the size
  const whole = new Alerts({ state }, flow, new Quiet(), () => now, () => {});
  flow.begin(['a:BTC', 'b:BTC']);
  flow.load({ from: ask, to: close, instruments: [frame('a:BTC', T0, 3_600, 1_000), frame('b:BTC', T0, 3_600, 1_000)] }, ['a:BTC', 'b:BTC'], ask);
  state.candles = [candleRow(T0 - HOUR), candleRow(T0)]; whole.tick(now - 2_000);
  state.candles = [candleRow(T0 - HOUR), candleRow(T0), candleRow(close)]; whole.tick(now);
  assert.equal(whole.log.length, 1, 'with both exchanges whole it sounds');
});

test('a small move of the mark does not make an unchanged wall look pulled', () => {
  const T = Date.UTC(2026, 9, 6, 12, 0, 0);
  const state: AppState = initialState();
  state.sounds = readSounds({ on: true, volume: 1, panels: { book: { wall: true, usd: 10_000_000 } } });
  state.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }];
  let now = T;
  const alerts = new Alerts({ state }, new FlowBook(), new Quiet(), () => now);
  const side = (levels: [number, number][]) => ({ lo: Float64Array.from(levels.map(l => l[0])), hi: Float64Array.from(levels.map(l => l[0])), usd: Float64Array.from(levels.map(l => l[1])) });
  const step = (seconds: number, mark: number, wall: number): void => {
    now = T + seconds * 1_000; state.mark = { price: mark, asOf: now };
    state.levels = { asOf: now, books: [{ id: 'a:BTC', venue: 'a', timestamp: now, coarse: false, bids: side([[99_512.3, wall], [99_000, 100_000]]), asks: side([[100_100, 100_000]]) }] };
    alerts.tick(now);
  };
  for (let s = 0; s <= 12; s += 2) step(s, 100_000, 1_000_000);
  step(14, 100_000, 30_000_000);                                                                          // a 30 M bid wall appears
  for (let s = 16; s <= 22; s += 2) step(s, 100_000, 30_000_000);                                         // and stands
  assert.ok(alerts.log.some(entry => entry.kind === 'wall-appeared'));
  step(24, 100_011, 30_000_000);                                                                          // the mark moves 11 dollars; the wall has not changed
  assert.deepEqual(alerts.log.filter(entry => entry.kind === 'wall-pulled'), [], 'a wall that is where it was is not pulled');
});

test('a mark that crosses a step of the price grid starts the walls over, and does not pull them', () => {
  const side = (levels: [number, number][]) => ({ lo: Float64Array.from(levels.map(l => l[0])), hi: Float64Array.from(levels.map(l => l[0])), usd: Float64Array.from(levels.map(l => l[1])) });
  const book = (wall: number): LevelsFrame => ({ asOf: 0, books: [{ id: 'a:BTC', venue: 'a', timestamp: 0, coarse: false, bids: side([[174_545, wall], [173_000, 100_000]]), asks: side([[176_000, 100_000]]) }] });
  const ids = new Set(['a:BTC']), watch = new WallWatch();
  const at = (seconds: number, mark: number, wall: number) => watch.update(seconds * 1_000, bookBins(book(wall), ids, mark, 0.01), mark, 10_000_000, 'a:BTC');
  assert.equal(bookBins(book(1), ids, 174_990, 0.01).bin, 20); assert.equal(bookBins(book(1), ids, 175_010, 0.01).bin, 50, 'the grid has steps of 20 below 175,000 and of 50 above it');
  const seen: string[] = [];
  for (let s = 0; s <= 24; s += 2) for (const signal of at(s, 174_990, s < 12 ? 1_000_000 : 30_000_000)) seen.push(signal.kind);
  assert.deepEqual(seen, ['appeared']);
  for (let s = 26; s <= 40; s += 2) for (const signal of at(s, 175_010, 30_000_000)) seen.push(signal.kind);
  assert.deepEqual(seen, ['appeared'], 'the level is where it was: only the bin it is counted in changed');
});
