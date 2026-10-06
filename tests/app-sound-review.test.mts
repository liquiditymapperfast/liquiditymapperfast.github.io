import test from 'node:test';
import assert from 'node:assert/strict';
import { Coalescer, readSounds, type Note } from '../src/app/sound/rules.ts';
import { Sounds } from '../src/app/sound/sounds.ts';
import { Alerts, type Player } from '../src/app/sound/alerts.ts';
import { WallWatch, bookBins } from '../src/app/sound/alert-rules.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { Store, initialState, type AppState } from '../src/app/store.ts';
import type { Print } from '../src/app/prints.ts';
import type { LevelsFrame } from '../src/app/wire.ts';

// What an independent review found wrong in the sounds, each as the smallest case that shows it.

const print = (t: number, usd: number, side: 'buy' | 'sell' = 'buy'): Print => ({ t, id: 'binance:BTCUSDT', side, price: 100_000, usd });

test('fills further apart than the window are separate events even when nothing drained the first one in between', () => {
  const c = new Coalescer(250);
  c.add(print(1_000, 300_000), 0);
  c.add(print(1_275, 200_000), 275);                        // the timer was late: it is 275 ms after the first, past the window
  c.add(print(1_300, 50_000), 300);                         // and belongs with the second
  const events = c.drain(10_000);
  assert.deepEqual(events.map(e => [e.usd, e.n]), [[300_000, 1], [250_000, 2]], 'it was one event of 500,000');
  assert.deepEqual(c.drain(20_000), []);
  c.add(print(1, 1_000_000), 5_000); c.clear(); assert.deepEqual(c.drain(5_001, true), [], 'cleared');
});

function soundsRig(extra: Record<string, unknown> = {}) {
  const store = new Store(initialState());
  store.set({ sounds: readSounds({ on: true, volume: 1, ...extra }) });
  let queueClock = 0; const T = Date.UTC(2026, 9, 6, 12, 0, 0);
  const sounds = new Sounds(store, () => queueClock, () => T);
  return { store, sounds, T, advance: (ms: number) => { queueClock += ms; } };
}

test('a sweep that was queued is not sounded after the sounds were switched off, or after the timer was held up for seconds', () => {
  const muted = soundsRig();
  muted.sounds.feed([print(muted.T, 1_000_000)]);
  muted.store.set({ sounds: { ...muted.store.state.sounds, on: false } });
  muted.advance(300); muted.sounds.drainNow();
  assert.equal(muted.sounds.log.length, 0, 'switched off while it waited');

  const stalled = soundsRig();
  stalled.sounds.feed([print(stalled.T, 1_000_000)]);
  stalled.advance(10_000); stalled.sounds.drainNow();                                   // the tab was throttled for ten seconds
  assert.equal(stalled.sounds.log.length, 0, 'it is history by then');

  const prompt = soundsRig();
  prompt.sounds.feed([print(prompt.T, 1_000_000)]);
  prompt.advance(300); prompt.sounds.drainNow();
  assert.equal(prompt.sounds.log.length, 1, 'and one that waited a normal quarter second still sounds');
});

// The candle chime and the panel alerts watch the closing of the candle that is on screen; they have to be told apart from what is merely loaded.

function stubBrowser(): () => void {
  const g = globalThis as Record<string, unknown>, saved = { document: g.document, window: g.window };
  g.document = { addEventListener() {} }; g.window = { setInterval: () => 0, clearInterval() {} };
  return () => { g.document = saved.document; g.window = saved.window; };
}
const HOUR = 3_600_000;
const candleRow = (t: number, volume = 1): AppState['candles'][number] => [t, 1, 1, 1, 1, volume, 1];
/** `count` hourly candles ending with the one that starts at `newestStart`; the one before the newest (the one that has closed) has `closedVolume`. */
const candlesUntil = (newestStart: number, count: number, closedVolume: number): AppState['candles'] =>
  Array.from({ length: count }, (_, i) => candleRow(newestStart - (count - 1 - i) * HOUR, i === count - 2 ? closedVolume : 1));

/** The store tells its listeners in a microtask, and merges updates made before it runs: a step of the page's life is one of these. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('the volume chime sounds for a candle that has just closed, not for one that was loaded, one an hour old, or one of another timeframe', async () => {
  const restore = stubBrowser();
  try {
    const hour = Math.floor(Date.UTC(2026, 9, 6, 12, 0, 0) / HOUR) * HOUR;
    const watched = (clockAt: number) => {
      const store = new Store(initialState());
      store.set({ sounds: readSounds({ on: true, volume: 1, barChime: true }), timeframe: '1h', marketId: 'a:BTC' });
      const sounds = new Sounds(store, () => 0, () => clockAt); sounds.start();
      return { store, sounds };
    };
    // fresh: the first load is history, then the next candle opens a few seconds after the hour and the one before it closed far above the rest
    const fresh = watched(hour + HOUR + 3_000);
    fresh.store.set({ candles: candlesUntil(hour, 20, 1) }); await settle();
    assert.equal(fresh.sounds.log.length, 0);
    fresh.store.set({ candles: candlesUntil(hour + HOUR, 21, 1_000) }); await settle();
    assert.equal(fresh.sounds.log.filter(e => e.kind === 'candle').length, 1, 'a fresh close sounds');
    // an hour-old close, discovered when a tab that was asleep gets its next candle (the candle opened at 15:00 and its first tick came at 16:00)
    const late = watched(hour + 4 * HOUR + 3_000);
    late.store.set({ candles: candlesUntil(hour + 2 * HOUR, 22, 1) }); await settle();
    late.store.set({ candles: candlesUntil(hour + 3 * HOUR, 23, 1_000) }); await settle();
    assert.equal(late.sounds.log.filter(e => e.kind === 'candle').length, 0, 'the close was an hour ago');
    // another timeframe loads its own candles: its newest bar differs from the one that was watched, which is not a close
    const switched = watched(hour + HOUR + 3_000);
    switched.store.set({ candles: candlesUntil(hour, 20, 1) }); await settle();
    switched.store.set({ timeframe: '15m', candles: candlesUntil(hour + HOUR, 21, 1_000) }); await settle();
    assert.equal(switched.sounds.log.filter(e => e.kind === 'candle').length, 0, 'a different context starts from scratch');
  } finally { restore(); }
});

class Quiet implements Player { played: Note[][] = []; play(notes: readonly Note[]): boolean { this.played.push([...notes]); return true; } async unlock(): Promise<void> {} }
function alertsRig(clock: () => number, ensure?: (ids: readonly string[], from: number) => void) {
  const state: AppState = initialState();
  state.sounds = readSounds({ on: true, volume: 1, panels: { bars: { delta: true, usd: 3_000_000 }, oi: { jump: true } } });
  state.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }];
  state.show = { ...state.show, cvd: true }; state.timeframe = '1h'; state.marketId = 'a:BTC';
  const flow = new FlowBook(), player = new Quiet(), alerts = new Alerts({ state }, flow, player, clock, ensure);
  return { state, flow, player, alerts };
}
const feedSeconds = (flow: FlowBook, from: number, seconds: number, buy: number, sell: number): void => {
  const items: [string, number, number, number][] = []; for (let i = 0; i < seconds; i++) items.push(['a:BTC', from + i * 1000, buy, sell]); flow.apply(items);
};

test('a full-candle delta is announced only for a candle that closed just now, whole, in the context that is on screen', () => {
  const T0 = Date.UTC(2026, 9, 6, 12, 0, 0), close = T0 + HOUR;                           // the 12:00 candle closes at 13:00
  const before = [candleRow(T0 - HOUR), candleRow(T0)], after = [candleRow(T0 - HOUR), candleRow(T0), candleRow(close)];
  const now = close + 2_000;

  const whole = alertsRig(() => now);                                                    // control: fresh, whole, continuous
  feedSeconds(whole.flow, T0, 3_600, 60_000, 0);                                          // +60k a second for the hour: 216 M
  whole.state.candles = before; whole.alerts.tick(now - 2_000);
  whole.state.candles = after; whole.alerts.tick(now);
  assert.equal(whole.player.played.length, 1, 'whole, fresh and continuous: it sounds');

  const thin = alertsRig(() => now);                                                     // ten seconds of flow announced as the delta of an hour
  feedSeconds(thin.flow, close - 10_000, 10, 600_000, 0);
  thin.state.candles = before; thin.alerts.tick(now - 2_000);
  thin.state.candles = after; thin.alerts.tick(now);
  assert.equal(thin.player.played.length, 0, 'the other 59 minutes and 50 seconds of the candle are not here');

  const asked: [readonly string[], number][] = [];                                       // history that has not come: asked for, and not announced meanwhile
  const waiting = alertsRig(() => now, (ids, from) => { asked.push([ids, from]); });
  feedSeconds(waiting.flow, T0, 3_600, 60_000, 0);
  waiting.state.candles = before; waiting.alerts.tick(now - 2_000);
  assert.deepEqual(asked.at(-1), [['a:BTC'], T0], 'the flow of the open candle is requested from its start, whether or not the column is shown');
  waiting.state.candles = after; waiting.alerts.tick(now);
  assert.equal(waiting.player.played.length, 0, 'it was never loaded from the start of the candle');

  const late = alertsRig(() => close + 3 * HOUR);                                        // an hour-old close
  feedSeconds(late.flow, T0, 3_600, 60_000, 0);
  late.state.candles = before; late.alerts.tick(close + 3 * HOUR - 5_000);
  late.state.candles = after; late.alerts.tick(close + 3 * HOUR);
  assert.equal(late.player.played.length, 0, 'that close was three hours ago');

  const other = alertsRig(() => now);                                                    // another timeframe was loaded
  feedSeconds(other.flow, T0, 3_600, 60_000, 0);
  other.state.candles = before; other.alerts.tick(now - 2_000);
  other.state.timeframe = '15m'; other.state.candles = [candleRow(T0), candleRow(T0 + 15 * 60_000), candleRow(T0 + 30 * 60_000)]; other.alerts.tick(now);
  assert.equal(other.player.played.length, 0, 'that is not a close');
});

test('the open-interest alert reads the same change the pane draws, and only for a fresh close', () => {
  const T0 = Date.UTC(2026, 9, 6, 12, 0, 0), close = T0 + HOUR;
  const bar = (t: number, level: number): AppState['oi'][number] => [t, level, level, level, level];   // one reading per bar: open = close
  const flatUntil = (last: number, count: number): AppState['oi'] => Array.from({ length: count }, (_, i) => bar(last - (count - 1 - i) * HOUR, 100));
  // the 12:00 bar read 250 after bars at 100, so the change it stands for is 150; the 13:00 bar then opens
  const open = [...flatUntil(T0 - HOUR, 19), bar(T0, 250)], closed = [...open, bar(close, 250)];

  const fresh = alertsRig(() => close + 3_000);
  fresh.state.oiInstrument = 'a:BTC';
  fresh.state.oi = open; fresh.alerts.tick(close - 5_000);
  fresh.state.oi = closed; fresh.alerts.tick(close + 3_000);
  assert.equal(fresh.player.played.length, 1, 'a step from 100 to 250 is a change of 150 (close minus open of each bar was 0)');

  const stale = alertsRig(() => close + 3 * HOUR);
  stale.state.oiInstrument = 'a:BTC';
  stale.state.oi = open; stale.alerts.tick(close - 5_000);
  stale.state.oi = closed; stale.alerts.tick(close + 3 * HOUR);
  assert.equal(stale.player.played.length, 0, 'the same step, discovered three hours late, is history');
});

// ---- walls ----------------------------------------------------------------------------------------------------------------------------------------

const MARK = 100_000;
const side = (levels: [number, number][]) => ({ lo: Float64Array.from(levels.map(l => l[0])), hi: Float64Array.from(levels.map(l => l[0])), usd: Float64Array.from(levels.map(l => l[1])) });
const book = (bids: [number, number][], asks: [number, number][] = [[100_100, 100_000]]): LevelsFrame => ({ asOf: 0, books: [{ id: 'a:BTC', venue: 'a', timestamp: 0, coarse: false, bids: side(bids), asks: side(asks) }] });
const watch = () => {
  const w = new WallWatch(), ids = new Set(['a:BTC']);
  return (t: number, f: LevelsFrame, mark = MARK, context = 'a:BTC') => w.update(t, bookBins(f, ids, mark, 0.01), mark, 10_000_000, context);
};
/** A bid wall of 25 M that appeared at 14 s and has stood since. */
function withStandingWall(at: ReturnType<typeof watch>): void {
  for (let t = 0; t <= 12_000; t += 2_000) at(t, book([[99_900, 1_000_000]]));
  at(14_000, book([[99_900, 25_000_000]]));
  for (let t = 16_000; t <= 22_000; t += 2_000) at(t, book([[99_900, 25_000_000]]));
}

test('a wall that is there from the start and goes within the warm-up is not reported as pulled', () => {
  const at = watch();
  at(0, book([[99_900, 25_000_000]]));                                  // there from the first look
  assert.deepEqual(at(6_000, book([[99_900, 100_000]])), [], 'six seconds in, the book is still arriving');
});

test('a wall the price has traded through is not pulled', () => {
  const at = watch(); withStandingWall(at);
  // the price falls through the bid in one step: the level is above the new price, so it is no longer on the bid side at all
  assert.deepEqual(at(24_000, book([[99_000, 100_000]]), 99_500), [], 'it was eaten');
});

test('a wall that goes is reported even while a bigger one stands elsewhere, and the books changing is not a wall going', () => {
  const at = watch(); withStandingWall(at);
  const signals = at(24_000, book([[99_000, 40_000_000]]));            // the 25 M bid is gone, a 40 M one stands far below
  assert.ok(signals.some(s => s.kind === 'pulled' && s.side === 'buy' && s.usd === 25_000_000), JSON.stringify(signals));

  const other = watch(); withStandingWall(other);
  assert.deepEqual(other(24_000, book([[99_000, 100_000]]), MARK, 'b:BTC'), [], 'a venue was switched off: the liquidity left the sum, it was not pulled');
  assert.deepEqual(other(36_000, book([[99_900, 25_000_000]]), MARK, 'b:BTC'), [], 'and the warm-up begins again');
});

test('a long gap between looks is not a wall going', () => {
  const at = watch(); withStandingWall(at);
  assert.deepEqual(at(60_000, book([[99_900, 100_000]])), [], 'nothing was seen for 38 seconds');
});
