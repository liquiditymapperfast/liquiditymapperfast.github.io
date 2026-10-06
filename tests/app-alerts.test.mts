import test from 'node:test';
import assert from 'node:assert/strict';
import { Cooldowns, ImbalanceWatch, RateCap, WallWatch, bookBins, biggest, imbalanceOf } from '../src/app/sound/alert-rules.ts';
import { Alerts, type Player } from '../src/app/sound/alerts.ts';
import { DEFAULT_PANEL_SOUNDS, alertNotes, readPanelSounds, readSounds, type AlertKind, type Note } from '../src/app/sound/rules.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { initialState, type AppState } from '../src/app/store.ts';
import type { LevelsFrame } from '../src/app/wire.ts';

// ---- Cool-downs and the cap -------------------------------------------------------------------------------------------------------

test('a cool-down is per key and lasts its time; the cap counts every kind together', () => {
  const c = new Cooldowns();
  assert.equal(c.take('a', 0, 1_000), true); assert.equal(c.take('a', 999, 1_000), false); assert.equal(c.take('b', 999, 1_000), true); assert.equal(c.take('a', 1_000, 1_000), true);
  const cap = new RateCap(2, 10_000);
  assert.deepEqual([0, 1_000, 2_000, 10_500].map(t => cap.allow(t)), [true, true, false, true], 'the first two have aged out by 10.5 s');
});

// ---- The book ---------------------------------------------------------------------------------------------------------------------

const MARK = 100_000;
const side = (levels: [number, number][]) => ({ lo: Float64Array.from(levels.map(l => l[0])), hi: Float64Array.from(levels.map(l => l[0])), usd: Float64Array.from(levels.map(l => l[1])) });
function frame(bids: [number, number][], asks: [number, number][], id = 'a:BTC', asOf = 0): LevelsFrame {
  return { asOf, books: [{ id, venue: id.split(':')[0]!, timestamp: asOf, coarse: false, bids: side(bids), asks: side(asks) }] };
}

test('bins add the books of the chosen instruments on the right side of the price, within the range', () => {
  const f: LevelsFrame = { asOf: 0, books: [
    ...frame([[99_990, 1_000_000], [99_000, 5_000_000], [90_000, 9e9], [100_010, 777]], [[100_010, 2_000_000], [101_500, 9e9], [99_000, 555]], 'a:BTC').books,
    ...frame([[99_991, 3_000_000]], [], 'b:BTC').books,
    ...frame([[99_995, 8_000_000]], [], 'c:BTC').books,
  ] };
  const bins = bookBins(f, new Set(['a:BTC', 'b:BTC']), MARK, 0.01);
  assert.equal(bins.bidTotal, 1_000_000 + 5_000_000 + 3_000_000, 'c is not chosen; 90,000 is out of range; a bid above the price is not a bid');
  assert.equal(bins.askTotal, 2_000_000, '101,500 is out of range; an ask below the price is not an ask');
  assert.equal(bins.bid.get(Math.floor(99_990 / bins.bin)), 4_000_000, 'a and b at 99,990 and 99,991 share a 2 bp bin (20 USD wide)');
  const top = biggest(bins);
  assert.equal(top.bid!.usd, 5_000_000, 'the biggest bin is the 5M level at 99,000');
  assert.ok(Math.abs(top.bid!.price - 99_000) < 20);
  assert.ok(Math.abs(imbalanceOf(bins) - (9_000_000 - 2_000_000) / 11_000_000) < 1e-12);
  assert.equal(imbalanceOf(bookBins(null, new Set(), MARK, 0.01)), 0);
});

const wall = (usd: number, price = 99_900): LevelsFrame => frame([[price, usd], [99_000, 100_000]], [[100_100, 100_000]]);

test('a wall that is there at the start is not news; one that appears later, after the book has settled, is', () => {
  const w = new WallWatch(), ids = new Set(['a:BTC']), at = (t: number, f: LevelsFrame) => w.update(t, bookBins(f, ids, MARK, 0.01), MARK, 10_000_000);
  assert.deepEqual(at(0, wall(30_000_000)), [], 'present from the start');
  assert.deepEqual(at(2_000, wall(30_000_000)), []);
  const w2 = new WallWatch(), at2 = (t: number, f: LevelsFrame) => w2.update(t, bookBins(f, ids, MARK, 0.01), MARK, 10_000_000);
  at2(0, wall(1_000_000)); at2(2_000, wall(1_000_000));
  assert.deepEqual(at2(4_000, wall(30_000_000)), [], 'inside the first ten seconds nothing sounds');
  at2(6_000, wall(1_000_000)); at2(12_000, wall(1_000_000));
  const signals = at2(14_000, wall(30_000_000));
  assert.deepEqual(signals.map(s => [s.kind, s.side, s.usd]), [['appeared', 'buy', 30_000_000]]);
  assert.deepEqual(at2(16_000, wall(30_000_000)), [], 'once, not on every look');
});

test('a wall that stood and then vanished is pulled, unless the price came to it', () => {
  const ids = new Set(['a:BTC']);
  const run = (markNow: number) => {
    const w = new WallWatch(), at = (t: number, f: LevelsFrame, mark = MARK) => w.update(t, bookBins(f, ids, mark, 0.01), mark, 10_000_000);
    for (let t = 0; t <= 12_000; t += 2_000) at(t, wall(1_000_000));
    assert.equal(at(14_000, wall(25_000_000)).length, 1, 'appeared');
    for (let t = 16_000; t <= 22_000; t += 2_000) at(t, wall(25_000_000));
    return at(24_000, wall(500_000), markNow);
  };
  assert.deepEqual(run(MARK).map(s => [s.kind, s.side]), [['pulled', 'buy']]);
  assert.deepEqual(run(99_905), [], 'the price is at the wall: it was eaten, not pulled');
});

test('ask walls sound as sells, and a wall must stand five seconds before pulling it counts', () => {
  const ids = new Set(['a:BTC']), w = new WallWatch(), at = (t: number, f: LevelsFrame) => w.update(t, bookBins(f, ids, MARK, 0.01), MARK, 10_000_000);
  const ask = (usd: number) => frame([[99_900, 100_000]], [[100_150, usd]]);
  for (let t = 0; t <= 12_000; t += 2_000) at(t, ask(1_000_000));
  assert.deepEqual(at(14_000, ask(40_000_000)).map(s => [s.kind, s.side]), [['appeared', 'sell']]);
  assert.deepEqual(at(16_000, ask(100_000)), [], 'gone after two seconds: it never stood');
});

test('the balance tips once and must come back before it tips again', () => {
  const w = new ImbalanceWatch();
  // 0.72 again after only 0.5 does not sound (0.5 is not back inside 60 % of the line); after 0.3 it does.
  assert.deepEqual([0.2, 0.5, 0.71, 0.8, 0.5, 0.72, 0.3, 0.72, -0.9, -0.2, -0.8].map(v => w.update(v, 70)), [null, null, 'buy', null, null, null, null, 'buy', null, null, 'sell']);
  // swinging straight from one side to the other is one tip, not two: -0.9 comes right after a tip and does not sound until the balance has come back
});

// ---- Settings and notes -----------------------------------------------------------------------------------------------------------

test('panel sounds are off by default, read field by field, and clamped', () => {
  assert.deepEqual(readPanelSounds(undefined), DEFAULT_PANEL_SOUNDS);
  assert.equal(Object.values(DEFAULT_PANEL_SOUNDS).every(p => Object.values(p).filter(v => typeof v === 'boolean').every(v => v === false)), true, 'every switch is off');
  const p = readPanelSounds({ flow: { burst: true, usd: 5, sensitivity: 99 }, depth: { pct: 12, imbalance: 'yes' }, book: { usd: 1e15 }, extra: 1 });
  assert.deepEqual([p.flow.burst, p.flow.usd, p.flow.sensitivity, p.depth.pct, p.depth.imbalance, p.book.usd], [true, 100_000, 10, 30, false, 5_000_000_000]);
  assert.deepEqual(readSounds({ on: true }).panels, DEFAULT_PANEL_SOUNDS);
});

test('every alert has notes that rise for buying and fall for selling, and none is silent', () => {
  const kinds: AlertKind[] = ['flow-burst', 'bar-delta', 'wall-appeared', 'wall-pulled', 'imbalance', 'oi-jump'];
  const mean = (n: Note[]) => n[0]!.freq - n[n.length - 1]!.freq;
  for (const kind of kinds) {
    const buy = alertNotes(kind, 'buy', 1), sell = alertNotes(kind, 'sell', 1);
    assert.ok(buy.length >= 2 && buy.every(n => n.gain > 0 && n.freq > 0 && n.decay > 0), kind);
    if (kind === 'flow-burst' || kind === 'bar-delta' || kind === 'imbalance') assert.ok(mean(buy) < 0 && mean(sell) > 0, `${kind} buying rises, selling falls`);
    assert.ok(alertNotes(kind, 'buy', 0).every(n => n.gain === 0), `${kind} is silent at volume 0`);
  }
});

// ---- The orchestrator -------------------------------------------------------------------------------------------------------------

class FakePlayer implements Player { played: Note[][] = []; running = true; play(notes: readonly Note[]): boolean { if (!this.running) return false; this.played.push([...notes]); return true; } async unlock(): Promise<void> { this.running = true; } }
const T = Date.UTC(2026, 9, 6, 12, 0, 0);

function rig(over: Partial<ReturnType<typeof readPanelSounds>> = {}, on = true) {
  const state: AppState = initialState();
  state.sounds = readSounds({ on, volume: 1, panels: { ...DEFAULT_PANEL_SOUNDS, ...over } });
  state.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }, { instrumentId: 'aspot:BTC', venue: 'aspot', marketType: 'spot' }];
  state.show = { ...state.show, cvd: true };
  const flow = new FlowBook(), player = new FakePlayer(), alerts = new Alerts({ state }, flow, player, () => T);
  return { state, flow, player, alerts };
}
const feed = (flow: FlowBook, id: string, now: number, seconds: number, buy: number, sell: number) => {
  const items: [string, number, number, number][] = []; for (let i = seconds - 1; i >= 0; i--) items.push([id, now - i * 1000, buy, sell]); flow.apply(items);
};

test('a flow burst is marked on the column, sounds once when the rule is on, and then waits out its cool-down', () => {
  const { flow, player, alerts, state } = rig({ flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } as never);
  state.sounds = readSounds({ on: true, volume: 1, panels: { flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } });
  feed(flow, 'a:BTC', T, 2_000, 30_000, 30_000);
  for (let i = 9; i >= 0; i--) flow.apply([['a:BTC', T - i * 1000, 500_000, 20_000]]);
  alerts.tick(T);
  assert.equal(alerts.bursts.length, 1); assert.equal(alerts.bursts[0]!.family, 'a'); assert.equal(alerts.bursts[0]!.kind, 'perp');
  assert.equal(player.played.length, 1); assert.equal(alerts.log[0]!.kind, 'flow-burst'); assert.equal(alerts.log[0]!.side, 'buy'); assert.equal(alerts.log[0]!.panel, 'flow');
  alerts.tick(T + 5_000);
  assert.equal(player.played.length, 1, 'the same lane does not sound again within 90 s');
});

test('with the rule off the burst is still marked but silent; with sounds off nothing plays', () => {
  const quiet = rig();
  feed(quiet.flow, 'a:BTC', T, 2_000, 30_000, 30_000);
  for (let i = 9; i >= 0; i--) quiet.flow.apply([['a:BTC', T - i * 1000, 3_000_000, 20_000]]);
  quiet.alerts.tick(T);
  assert.equal(quiet.alerts.bursts.length, 1); assert.equal(quiet.player.played.length, 0);
  const off = rig({}, false); off.state.sounds = readSounds({ on: false, panels: { flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } });
  feed(off.flow, 'a:BTC', T, 2_000, 30_000, 30_000);
  for (let i = 9; i >= 0; i--) off.flow.apply([['a:BTC', T - i * 1000, 3_000_000, 20_000]]);
  off.alerts.tick(T);
  assert.equal(off.player.played.length, 0); assert.equal(off.alerts.log.length, 0);
});

test('a series that went quiet two seconds ago is history, not news', () => {
  const { flow, alerts, player, state } = rig();
  state.sounds = readSounds({ on: true, panels: { flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } });
  feed(flow, 'a:BTC', T - 30_000, 2_000, 30_000, 30_000);
  for (let i = 9; i >= 0; i--) flow.apply([['a:BTC', T - 30_000 - i * 1000, 3_000_000, 0]]);
  alerts.tick(T); assert.equal(player.played.length, 0); assert.equal(alerts.bursts.length, 0);
});

test('a candle that closes with a big net delta sounds; the first candle seen, and a small delta, do not', () => {
  const { flow, alerts, player, state } = rig();
  state.sounds = readSounds({ on: true, panels: { bars: { delta: true, usd: 3_000_000 } } });
  state.timeframe = '1m';
  const t0 = Math.floor(T / 60_000) * 60_000;
  feed(flow, 'a:BTC', t0 + 59_000, 60, 100_000, 10_000);                  // 90k/s net for the minute: 5.4M
  state.candles = [[t0 - 60_000, 1, 1, 1, 1, 1], [t0, 1, 1, 1, 1, 1]];
  alerts.tick(T); assert.equal(player.played.length, 0, 'the first candle is history');
  state.candles = [[t0 - 60_000, 1, 1, 1, 1, 1], [t0, 1, 1, 1, 1, 1], [t0 + 60_000, 1, 1, 1, 1, 1]];
  alerts.tick(T + 1_000);
  assert.equal(player.played.length, 1); assert.equal(alerts.log[0]!.kind, 'bar-delta'); assert.equal(alerts.log[0]!.side, 'buy');
  state.candles = [...state.candles, [t0 + 120_000, 1, 1, 1, 1, 1]];
  alerts.tick(T + 2_000);
  assert.equal(player.played.length, 1, 'the next candle had no flow');
});

test('walls and the balance sound from the live book, every two seconds, and the first ten seconds are quiet', () => {
  const { state, alerts, player } = rig();
  state.sounds = readSounds({ on: true, panels: { book: { wall: true, usd: 10_000_000 }, depth: { imbalance: true, pct: 60 } } });
  state.mark = { price: MARK, asOf: T };
  state.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }];
  state.levels = frame([[99_900, 1_000_000]], [[100_100, 1_000_000]], 'a:BTC', T);
  for (let t = 0; t <= 12_000; t += 2_000) { state.levels = { ...state.levels!, asOf: T + t }; alerts.tick(T + t); }
  assert.equal(player.played.length, 0);
  state.levels = { ...frame([[99_900, 30_000_000]], [[100_100, 1_000_000]], 'a:BTC', T + 14_000) };
  alerts.tick(T + 14_000);
  const kinds = alerts.log.map(e => e.kind).sort();
  assert.deepEqual(kinds, ['imbalance', 'wall-appeared'], 'a bid wall of 30M tips the balance and appears at once');
  assert.ok(alerts.log.every(e => e.side === 'buy'));
});

test('no more than four sounds in ten seconds, whatever the kinds', () => {
  const { state, alerts, player, flow } = rig();
  state.sounds = readSounds({ on: true, panels: { flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } });
  for (const id of ['a:BTC', 'b:BTC', 'c:BTC', 'd:BTC', 'e:BTC', 'f:BTC']) {
    feed(flow, id, T, 2_000, 30_000, 30_000);
    for (let i = 9; i >= 0; i--) flow.apply([[id, T - i * 1000, 500_000, 20_000]]);
  }
  alerts.tick(T);
  assert.equal(alerts.bursts.length, 6, 'all six are marked on the column');
  assert.equal(player.played.length, 4, 'but only four make a sound');
});

test('Test plays a sample whatever the switches say', async () => {
  const { alerts, player } = rig({}, false);
  alerts.test('wall-appeared', 'sell');
  await new Promise(r => setImmediate(r));
  assert.equal(player.played.length, 1);
});
