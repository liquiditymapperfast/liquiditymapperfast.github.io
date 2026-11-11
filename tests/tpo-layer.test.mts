import test from 'node:test';
import assert from 'node:assert/strict';
import { TpoLayer, type TpoFrame } from '../src/app/tpo/layer.ts';
import { TPO_DEFAULTS, type TpoSettings } from '../src/app/tpo/settings.ts';
import { ladder } from '../src/app/tpo/model.ts';
import { View } from '../src/app/view.ts';
import type { AppState, CandleRow } from '../src/app/store.ts';
import type { KeyLevelHistory } from '../src/app/keylevels/history.ts';

// The TPO layer over histories held in memory (no network): what it keeps between frames, what it waits for, what it asks for.

const MIN = 60_000, HALF = 30 * MIN, DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 11, 18, 7);

/** A history the layer reads, with its candles set by the test and every `ensure` recorded. */
class Fake {
  version = 1;
  state: 'idle' | 'loading' | 'ready' | 'unavailable';
  asks: { id: string | undefined; from: number }[] = [];
  heldTo = NOW;
  exhausted = false;
  limited = false;
  covered = Infinity;
  constructor(public id: string, public barMs: number, public bars: CandleRow[], public maxBack = 400 * DAY) { this.state = bars.length ? 'ready' : 'loading'; }
  get heldFrom(): number { return this.bars[0]?.[0] ?? Infinity; }
  get keptFrom(): number { return NOW - this.maxBack - DAY; }
  get knownFrom(): number { return this.bars.length ? Math.min(this.covered, this.heldFrom) : Infinity; }
  reach(from: number): 'yes' | 'coming' | 'never' {
    if (this.knownFrom <= from) return 'yes';
    return this.state === 'unavailable' || this.exhausted || this.limited || from < this.keptFrom ? 'never' : 'coming';
  }
  ensure(target: { id: string } | null, from: number): void { this.asks.push({ id: target?.id, from }); }
}

/** Half hours of a price wandering around 90,000 (a different wander per market and a usual gap), and the days they make. */
function halfHours(from: number, to: number, seed: number, gapBp = 0, range = 60): CandleRow[] {
  const out: CandleRow[] = [], g = 1 + gapBp / 1e4;
  for (let t = Math.ceil(from / HALF) * HALF; t < to; t += HALF) {
    const k = t / HALF, mid = (90_000 + 2_000 * Math.sin(k / 97) + 400 * Math.sin(k / 7 + seed)) * g, half = range * (0.6 + 0.4 * Math.abs(Math.sin(k / 3 + seed)));
    out.push([t, mid - half / 3, mid + half, mid - half, mid + half / 3, 10 + (k % 5)] as unknown as CandleRow);
  }
  return out;
}
function days(from: number, to: number, range: (t: number) => number): CandleRow[] {
  const out: CandleRow[] = [];
  for (let t = Math.floor(from / DAY) * DAY; t < to; t += DAY) out.push([t, 90_000, 90_000 + range(t), 90_000, 90_000, 1000] as unknown as CandleRow);
  return out;
}

const IDS: Record<string, string> = { 'binance/perp': 'binance:BTCUSDT', 'bybit/perp': 'bybit:BTCUSDT', 'coinbase/spot': 'coinbase:BTC-USD', 'okx/perp': 'okx:BTC-USDT-SWAP' };

/** A hub whose histories are made on first ask by `make` (kind, id, bar size), and kept. */
function hub(make: (kind: string, id: string, barMs: number) => Fake) {
  const held = new Map<string, Fake>();
  return {
    held,
    get: (kind: string, id: string, barMs: number): Fake | undefined => held.get(`${kind}|${id}|${barMs}`),
    tpoHistory(id: string, barMs: number, kind: 'main' | 'peer' | 'days'): KeyLevelHistory {
      const key = `${kind}|${id}|${barMs}`;
      let h = held.get(key);
      if (!h) { h = make(kind, id, barMs); held.set(key, h); }
      return h as unknown as KeyLevelHistory;
    },
  };
}
const standard = (kind: string, id: string, barMs: number): Fake => kind === 'days'
  ? new Fake(id, DAY, days(NOW - 475 * DAY, NOW, () => 1800), 475 * DAY)
  : new Fake(id, barMs, halfHours(NOW - (kind === 'peer' ? 62 : 400) * DAY, NOW, id.length, id.startsWith('coinbase') ? -8 : 0), kind === 'peer' ? 62 * DAY : 400 * DAY);

function frame(tpo: Partial<TpoSettings>, view: { t0: number; t1: number }, peerIds: string[] = []): TpoFrame {
  const state = {
    tpo: { ...TPO_DEFAULTS, on: true, rows: { BTC: 20 }, ...tpo }, traded: { zone: 'UTC', sessions: [] }, timeZone: 'utc', range: null,
    marketId: 'binance:BTCUSDT', seriesInstrument: 'binance:BTCUSDT', timeframe: '1h', candles: [], mark: { price: 0 },
  } as unknown as AppState;
  return { state, view: new View({ t0: view.t0, t1: view.t1, p0: 84_000, p1: 96_000 }), pw: 1200, ph: 600, now: NOW, replay: false, peerIds };
}

test('panning by a day or refreshing the newest candles keeps every closed window\'s profile; only the window under way is worked out again', () => {
  for (const tpo of [{ hollow: false }, { source: 'chosen' as const, picks: ['binance/perp', 'bybit/perp', 'coinbase/spot'] }]) {
    const h = hub(standard), layer = new TpoLayer(h, () => {}, Infinity);
    const view = { t0: NOW - 30 * DAY, t1: NOW + DAY };
    const before = new Map(layer.profiles(frame(tpo, view)).map(p => [p.key, p]));
    assert.ok(before.size >= 29, `${before.size} profiles`);
    // A pan: every window still in view is the same profile.
    const panned = layer.profiles(frame(tpo, { t0: view.t0 - DAY / 2, t1: view.t1 - DAY / 2 }));
    assert.ok(panned.filter(p => before.has(p.key)).every(p => p === before.get(p.key)));
    // A refresh of the newest candle of every market (its version moves on): the closed windows keep theirs.
    for (const x of h.held.values()) { if (x.barMs !== HALF) continue; const last = x.bars[x.bars.length - 1]!; x.bars = [...x.bars.slice(0, -1), [last[0], last[1], last[2] + 50, last[3], last[4] + 25, last[5] + 1] as unknown as CandleRow]; x.version++; }
    const after = layer.profiles(frame(tpo, view));
    const changed = after.filter(p => p !== before.get(p.key));
    assert.deepEqual(changed.map(p => p.developing), [true], JSON.stringify(tpo));
  }
});

test('a chosen market that cannot be read neither blanks the windows while it tries again nor holds them back', () => {
  const tpo = { source: 'chosen' as const, picks: ['binance/perp', 'bybit/perp', 'coinbase/spot'] };
  const h = hub((kind, id, barMs) => id === IDS['coinbase/spot'] && kind === 'main' ? Object.assign(new Fake(id, barMs, []), { state: 'unavailable' as const }) : standard(kind, id, barMs));
  const layer = new TpoLayer(h, () => {}, Infinity), view = { t0: NOW - 6 * DAY, t1: NOW + DAY / 4 };
  const drawn = layer.profiles(frame(tpo, view)).length;
  assert.ok(drawn >= 6);
  // Each retry marks it loading again: the windows stay.
  h.get('main', IDS['coinbase/spot']!, HALF)!.state = 'loading';
  assert.equal(layer.profiles(frame(tpo, view)).length, drawn);
  // A market read before that walks further back (its candles not reaching a window yet): the window keeps the profile it had.
  const first = layer.profiles(frame(tpo, view));
  const bybit = h.get('main', IDS['bybit/perp']!, HALF)!, keep = bybit.bars;
  bybit.bars = keep.filter(b => b[0] >= NOW - 3 * DAY); bybit.version++;
  const waiting = layer.profiles(frame(tpo, view));
  assert.equal(waiting.length, first.length);
  assert.ok(waiting.filter(p => p.to <= NOW - 3 * DAY).every(p => first.includes(p)));
  // A market read for the first time: its windows wait for it.
  const fresh = hub((kind, id, barMs) => id === IDS['coinbase/spot'] && kind === 'main' ? new Fake(id, barMs, []) : standard(kind, id, barMs));
  assert.equal(new TpoLayer(fresh, () => {}, Infinity).profiles(frame(tpo, view)).length, 0);
});

test('every window in view is drawn, the newest 400 of a kind at most, from a calendar worked out once', () => {
  const h = hub(standard), layer = new TpoLayer(h, () => {}, Infinity);
  const year = layer.windows(frame({ hollow: false }, { t0: NOW - 500 * DAY, t1: NOW }));
  // As far back as the candles are kept (400 days), and no further.
  assert.ok(year.length >= 399 && year.length <= 402, String(year.length));
  assert.ok(Math.min(...year.map(w => w.from)) >= NOW - 401 * DAY);
  const ten = layer.windows(frame({ hollow: false }, { t0: NOW - 10 * DAY, t1: NOW + DAY }));
  assert.ok(ten.length >= 11 && ten.length <= 12);
  // The latest few up to the right edge still work as before.
  assert.equal(layer.windows(frame({ hollow: false, count: 3 }, { t0: NOW - 10 * DAY, t1: NOW + DAY })).length, 3);
});

test('what is asked for: the blocks\' markets a day before the oldest window, the other venues two months back at most, the days before the right edge', () => {
  const peers = [IDS['bybit/perp']!, IDS['okx/perp']!];
  const h = hub(standard), layer = new TpoLayer(h, () => {}, Infinity);
  // Recent: the other venues are asked from a day before the oldest window.
  const recent = frame({ hollow: true }, { t0: NOW - 5 * DAY, t1: NOW + DAY / 4 }, peers);
  layer.ensure(recent);
  const first = Math.min(...layer.windows(recent).map(w => w.from));
  assert.equal(h.get('main', IDS['binance/perp']!, HALF)!.asks.at(-1)!.from, first - DAY);
  assert.equal(h.get('peer', IDS['bybit/perp']!, HALF)!.asks.at(-1)!.from, first - DAY);
  // Five months back: the chart market as far as the windows, no other venue (their candles reach two months), the days before that edge.
  const old = frame({ hollow: true }, { t0: NOW - 160 * DAY, t1: NOW - 150 * DAY }, peers);
  const peerAsks = h.get('peer', IDS['bybit/perp']!, HALF)!.asks.length;
  layer.ensure(old);
  const oldFirst = Math.min(...layer.windows(old).map(w => w.from));
  assert.equal(h.get('main', IDS['binance/perp']!, HALF)!.asks.at(-1)!.from, oldFirst - DAY);
  assert.equal(h.get('peer', IDS['bybit/perp']!, HALF)!.asks.length, peerAsks);
  const asOf = Math.floor((NOW - 150 * DAY) / (28 * DAY)) * 28 * DAY;
  assert.equal(h.get('days', IDS['binance/perp']!, DAY)!.asks.at(-1)!.from, asOf - 75 * DAY);
  // Chosen markets: each of them, and no other venue.
  const chosen = frame({ source: 'chosen', picks: ['bybit/perp', 'coinbase/spot'], hollow: true }, { t0: NOW - 5 * DAY, t1: NOW + DAY / 4 }, peers);
  const okxAsks = h.get('peer', IDS['okx/perp']!, HALF)!.asks.length;
  layer.ensure(chosen);
  assert.equal(h.get('main', IDS['coinbase/spot']!, HALF)!.asks.at(-1)!.from, first - DAY);
  assert.equal(h.get('peer', IDS['okx/perp']!, HALF)!.asks.length, okxAsks);
});

test('Auto rows for a chart five months back come from the days before its right edge, and the newest size while those load', () => {
  // Days of 900 until four months ago, of 90 since.
  const cut = NOW - 120 * DAY;
  const make = (kind: string, id: string, barMs: number): Fake => kind === 'days' ? new Fake(id, DAY, days(NOW - 475 * DAY, NOW, t => t < cut ? 900 : 90), 475 * DAY) : standard(kind, id, barMs);
  const h = hub(make), layer = new TpoLayer(h, () => {}, Infinity);
  assert.equal(layer.auto(frame({ rows: {} }, { t0: NOW - 5 * DAY, t1: NOW })), ladder(90 / 90));
  assert.equal(layer.auto(frame({ rows: {} }, { t0: NOW - 160 * DAY, t1: NOW - 150 * DAY })), ladder(900 / 90));
  // The days before that edge not held yet: the last size known, not none.
  const late = hub((kind, id, barMs) => kind === 'days' ? new Fake(id, DAY, days(NOW - 40 * DAY, NOW, () => 90), 475 * DAY) : standard(kind, id, barMs)), l2 = new TpoLayer(late, () => {}, Infinity);
  assert.equal(l2.auto(frame({ rows: {} }, { t0: NOW - 5 * DAY, t1: NOW })), 1);
  assert.equal(l2.auto(frame({ rows: {} }, { t0: NOW - 160 * DAY, t1: NOW - 150 * DAY })), 1);
});

test('with hollow marks from the other venues (rows tall enough for cells), a refresh of the newest candles keeps every closed window', () => {
  const peers = [IDS['bybit/perp']!, IDS['okx/perp']!, IDS['coinbase/spot']!];
  const h = hub(standard), layer = new TpoLayer(h, () => {}, Infinity), view = { t0: NOW - 8 * DAY, t1: NOW + DAY / 4 };
  const f = (): TpoFrame => frame({ hollow: true, rows: { BTC: 50 } }, view, peers);
  const before = new Map(layer.profiles(f()).map(p => [p.key, p]));
  assert.ok(before.size >= 8);
  for (const x of h.held.values()) { if (x.barMs !== HALF) continue; const last = x.bars[x.bars.length - 1]!; x.bars = [...x.bars.slice(0, -1), [last[0], last[1], last[2] + 30, last[3], last[4], last[5] + 1] as unknown as CandleRow]; x.version++; }
  const changed = layer.profiles(f()).filter(p => p !== before.get(p.key));
  assert.deepEqual(changed.map(p => p.developing), [true]);
});

test('a frame works out a few profiles at least and leaves the rest for the next, drawing what it had meanwhile', () => {
  const h = hub(standard), layer = new TpoLayer(h, () => {}, 0), view = { t0: NOW - 30 * DAY, t1: NOW + DAY / 4 };
  const all = new TpoLayer(hub(standard), () => {}, Infinity).profiles(frame({ hollow: false }, view)).length;
  let n = layer.profiles(frame({ hollow: false }, view)).length, frames = 1;
  assert.ok(n >= 2 && n < all, `${n} of ${all}`);
  while (n < all && frames < 100) { n = layer.profiles(frame({ hollow: false }, view)).length; frames++; }
  assert.equal(n, all);
  // Another value area share: every window is worked out again, a few a frame, and none blinks out meanwhile.
  assert.equal(layer.profiles(frame({ hollow: false, share: 80 }, view)).length, all);
});

test('a session renamed in place is named anew', () => {
  const h = hub(standard), layer = new TpoLayer(h, () => {}, Infinity), view = { t0: NOW - 3 * DAY, t1: NOW };
  const session = (name: string) => [{ id: 's1', name, zone: 'Europe/London', start: '08:00', end: '17:00', on: true, weekdays: false }];
  const named = (name: string): string[] => {
    const f = frame({ period: 'sessions', hollow: false }, view);
    (f.state as unknown as { traded: { sessions: unknown } }).traded.sessions = session(name);
    f.nameOf = w => `${(f.state as unknown as { traded: { sessions: { name: string }[] } }).traded.sessions[0]!.name} ${w.from}`;
    return layer.windows(f).map(w => w.name);
  };
  assert.ok(named('London').every(n => n.startsWith('London ')));
  assert.ok(named('LDN').every(n => n.startsWith('LDN ')));
});

test('in a zone off the half hour (Kathmandu), every market reading past a window\'s last block judges it: counted on the window\'s own grid', () => {
  const now = Date.UTC(2026, 10, 11, 18, 20), closed = Date.UTC(2026, 10, 11, 18, 15);
  const tpo = { source: 'chosen' as const, picks: ['binance/perp', 'bybit/perp', 'coinbase/spot'], hollow: true };
  const h = hub(standard), layer = new TpoLayer(h, () => {}, Infinity), view = { t0: now - 3 * DAY, t1: now };
  const f = (): TpoFrame => { const x = frame(tpo, view); (x.state as unknown as { traded: { zone: string } }).traded.zone = 'Asia/Kathmandu'; return { ...x, now }; };
  const before = layer.profiles(f()).find(p => p.to === closed);
  assert.ok(before, 'the Kathmandu day that ended at 18:15 UTC');
  // The same candles, read past the end of the window's last block (17:45-18:15): its lone wicks can now be judged.
  for (const x of h.held.values()) x.heldTo = now;
  assert.notEqual(layer.profiles(f()).find(p => p.to === closed), before);
});
