import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AXIS_W, CANDLE_DEFAULTS, RULER_TEXT_Y, COVER_SLACK_MS, FLASH_MS, MAX_FLASHES, MIN_SPAN, RAIL_W, ageTicks, candleLayout, countdownText, coveredMarkets, flashRadius, flashStrength,
  flashes, pocIndex, priceAt, priceSpan, railCells, readCandleSettings, rowEmphasis, rowLean, rowStepFor, splitRow, trailX, yOf, type Arrival,
  PULSE_LIFE_MS, PulseTracker, pulseEnvelope, TapeTally, TAPE_BINS, TapeGaps, ringSlack,
} from '../src/app/candle/model.ts';
import type { CoverageAnswer } from '../src/shared/coverage.ts';
import { binOf } from '../src/shared/footprint.ts';

test('saved settings are read field by field, anything that does not check out falls back to its default', () => {
  assert.deepEqual(readCandleSettings(null), CANDLE_DEFAULTS);
  assert.deepEqual(readCandleSettings({ style: 'beads', trailMs: 30_000, tf: '1m', glass: 'bricks', rows: 'delta', pulse: 'deposit' }), { style: 'beads', trailMs: 30_000, tf: '1m', glass: 'bricks', rows: 'delta', pulse: 'deposit' });
  assert.deepEqual(readCandleSettings({ style: 'neon', trailMs: 45_000, tf: '4h', glass: 'yes', rows: 'sparkle', pulse: 'fireworks' }), CANDLE_DEFAULTS);
  assert.equal(readCandleSettings({ glass: true }).glass, 'panes', 'a glass switch saved on reads as the panes');
  assert.equal(readCandleSettings({ glass: false }).glass, 'off', 'and off as off');
  assert.equal(CANDLE_DEFAULTS.tf, '5m', 'the agreed default: a 5-minute candle, not the map\'s hourly one');
});

test('a row\'s winning side is shown more strongly the more it won, continuously, with no threshold to cross', () => {
  assert.equal(rowLean(30, 10), 0.5); assert.equal(rowLean(0, 8), -1); assert.equal(rowLean(0, 0), 0);
  const even = rowEmphasis(50, 50, 100), slight = rowEmphasis(55, 45, 100), clear = rowEmphasis(80, 20, 100), total = rowEmphasis(100, 0, 100);
  assert.equal(even.side, null); assert.equal(even.lean, 0); assert.equal(even.net, 0);
  assert.equal(slight.side, 'buy'); assert.equal(rowEmphasis(10, 90, 100).side, 'sell');
  assert.ok(slight.lean > 0 && slight.lean < clear.lean && clear.lean < total.lean && total.lean === 1, 'the lean grows with the share');
  assert.ok(slight.net > 0 && slight.net < clear.net && total.net === 1, 'the net grows with the difference against the busiest row\'s');
  assert.ok(rowEmphasis(1.15, 1, 100).lean > 0 && rowEmphasis(1.14, 1, 100).lean > 0, 'nothing jumps at the old 1.15 line');
  assert.ok(Math.abs(rowEmphasis(1.151, 1, 100).lean - rowEmphasis(1.149, 1, 100).lean) < 0.01, 'and nothing changes sharply across it');
  assert.equal(rowEmphasis(10, 0, 0).net, 0, 'no net to compare against');
});

test('the columns run left to right without overlap and the trail ends at the rail', () => {
  for (const [w, h] of [[390, 700], [360, 520], [844, 300]] as const) {
    const l = candleLayout(w, h);
    assert.ok(l.bidX0 < l.bidX1 && l.bidX1 < l.candleX0 && l.candleX0 < l.candleX1 && l.candleX1 < l.askX0 && l.askX0 < l.askX1, `ordered at ${w}`);
    assert.ok(l.askX1 <= l.railX0 && l.railX1 === l.axisX0 && l.axisX1 === w, `the rail and the axis close the row at ${w}`);
    assert.equal(l.axisX1 - l.axisX0, AXIS_W); assert.equal(l.railX1 - l.railX0, RAIL_W);
    assert.ok(l.candleX1 - l.candleX0 >= 96, 'room for two footprint numbers a row');
    assert.equal(l.trailX1, l.railX0, 'now is the rail');
    assert.ok(l.plotY1 < h, 'the age ruler has its strip below the plot');
    assert.ok(l.plotY1 + 4 + 4 < l.plotY1 + RULER_TEXT_Y - 5 && l.plotY1 + RULER_TEXT_Y + 5 + 2 <= h, `the ruler's words sit under its marks, clear of the bottom edge, at ${w}`);
  }
});

test('the prices shown hold the candle and the price, at least a minimum span, and keep the price off the edges', () => {
  const s = priceSpan(81_300, 81_400, 81_350, 0, 600);
  assert.ok(s.p0 < 81_300 && s.p1 > 81_400);
  const quiet = priceSpan(81_349, 81_351, 81_350, 0, 600);
  assert.ok(quiet.p1 - quiet.p0 >= 81_350 * MIN_SPAN - 1e-6, 'a quiet bar is not blown up');
  const panned = priceSpan(81_300, 81_400, 81_350, 0, 600, 1, 10_000);
  const y = yOf(panned, 81_350);
  assert.ok(y >= 59.99 && y <= 540.01, 'a pan cannot push the price past the middle four fifths');
  assert.ok(Math.abs(priceAt(s, yOf(s, 81_333)) - 81_333) < 1e-6, 'yOf and priceAt invert each other');
  const zoomed = priceSpan(81_300, 81_400, 81_350, 0, 600, 0.5);
  assert.ok(zoomed.p1 - zoomed.p0 < s.p1 - s.p0, 'a pinch apart shows fewer prices');
});

test('the footprint row step doubles the recorded one until a row is tall enough, and waits for the recorded step', () => {
  const s = { p0: 81_000, p1: 81_300, y0: 0, y1: 600 };
  assert.equal(rowStepFor(0, s), 0);
  const step = rowStepFor(0.5, s, 16);
  assert.ok(step * 2 >= 16 && step / 0.5 === 2 ** Math.round(Math.log2(step / 0.5)), 'a power of two times the recorded step');
  assert.ok(step * 600 / 300 >= 16 && (step / 2) * 600 / 300 < 16, 'the smallest that reaches 16 px');
});

test('the rail adds arrivals up by row, and the largest flashes, at most a handful, fading with a flashbulb\'s envelope', () => {
  const at = 10_000, a = (price: number, usd: number, dt = 0, inst = 0): Arrival => ({ price, usd, at: at + dt, inst });
  const cells = railCells([a(100.2, 5_000), a(100.7, -30_000, 10, 3), a(101.1, 60_000, 20, 1), a(99.9, 1_000, -5_000)], 1, at - 1000, at + 100);
  assert.equal(cells.length, 2, 'an arrival outside the stretch is left out');
  const row100 = cells.find(c => c.bin === 100)!;
  assert.deepEqual([row100.buy, row100.sell, row100.count, row100.largest, row100.largestInst], [5_000, 30_000, 2, 30_000, 3], 'the largest names its market');
  const orders = [a(100.2, 5_000), a(100.7, -30_000, 10, 3), a(101.1, 60_000, 20, 1), a(99.9, 1_000, -5_000)];
  const lit = flashes(orders, 1, 25_000, at + 30);
  assert.deepEqual(lit.map(c => c.bin), [101, 100], 'largest first');
  assert.ok(lit[0]!.k > 0.9 && lit[0]!.k <= 1);
  assert.deepEqual([lit[1]!.buy, lit[1]!.sell], [0, 30_000], 'a flash counts its large orders alone');
  assert.deepEqual(flashes(orders, 1, 25_000, at + 15 + FLASH_MS).map(x => x.bin), [101], 'a flash is gone once its time has passed, a later one still lit');
  // A small order arriving later in the same row does not light a large one's flash again.
  assert.equal(flashes([a(100.5, 1_000_000), a(100.4, 100, FLASH_MS - 20)], 1, 25_000, at + FLASH_MS + 10).length, 0, 'the large order\'s flash ends on time');
  assert.equal(flashes(Array.from({ length: 20 }, (_, i) => a(100 + i, 50_000 + i)), 1, 25_000, at).length, MAX_FLASHES);
  assert.equal(flashStrength(0), 1); assert.equal(flashStrength(FLASH_MS), 0);
  assert.ok(flashStrength(FLASH_MS / 4) > flashStrength(FLASH_MS / 2) && flashStrength(FLASH_MS / 2) > 0, 'falls off and does not come back');
  assert.equal(flashRadius(10, 25_000, 2e6), 3); assert.equal(flashRadius(5e6, 25_000, 2e6), 9);
  assert.ok(flashRadius(200_000, 25_000, 2e6) > flashRadius(50_000, 25_000, 2e6));
});

test('the trail and its ruler: now at the rail, the window at the left edge, a mark every quarter', () => {
  const l = candleLayout(390, 700);
  assert.equal(trailX(l, 0, 60_000), l.trailX1);
  assert.equal(trailX(l, 60_000, 60_000), l.trailX0);
  assert.equal(trailX(l, 90_000, 60_000), l.trailX0, 'clamped');
  assert.deepEqual(ageTicks(60_000).map(t => t.seconds), [0, 15, 30, 45, 60]);
});

test('a market is judged only when its trades were recorded, live or recovered, from the open of the bar to the answer without a break', () => {
  const bar = 1_000 * 300_000, asOf = bar + 150_000;
  const answer = (spans: Record<string, [number, number][]>, at = asOf): CoverageAnswer => ({ metric: 'trades', from: bar - 300_000, to: bar + 180_000, asOf: at,
    instruments: Object.entries(spans).map(([id, s]) => ({ id, spans: s, recovered: [], seconds: [], held: [] })) });
  const all = ['a', 'b', 'c', 'd'];
  const got = coveredMarkets(answer({
    a: [[bar - 60_000, asOf]],
    b: [[bar - 60_000, bar + 30_000], [bar + 50_000, asOf]],                 // the phone was away for 20 s inside the bar
    c: [[bar + 10_000, asOf]],                                               // recorded from inside the bar only
    d: [[bar - 60_000, bar + 20_000], [bar + 20_000, asOf - COVER_SLACK_MS]], // a recovered stretch joined to the live one, up to the beat
  }), all, bar);
  assert.deepEqual([...got].sort(), ['a', 'd']);
  assert.equal(coveredMarkets(null, all, bar).size, 0, 'no answer (a source that cannot say): nothing is judged');
  assert.equal(coveredMarkets(answer({ a: [[bar - 60_000, bar - 1_000]] }, bar - 1_000), all, bar).size, 0, 'an answer from before the bar opened');
  assert.equal(coveredMarkets(answer({ a: [[bar + 200, bar + 400]] }, bar + 500), all, bar).has('a'), false, 'in the bar\'s first second a market counts only if it was recorded at its open');
  assert.equal(coveredMarkets(answer({ a: [[bar - 5_000, bar + 400]] }, bar + 500), all, bar).has('a'), true);
  assert.equal(coveredMarkets(answer({ z: [[bar - 60_000, asOf]] }), all, bar).size, 0, 'a market not selected does not count');
});

test('a row is split into what the covered markets did, judged, and what the others did, observed', () => {
  const covered = new Set(['a']);
  assert.deepEqual(splitRow(30, 20, [['a', 10, 5], ['b', 20, 15]], covered, ['a', 'b']), { buy: 10, sell: 5, partBuy: 20, partSell: 15 });
  assert.deepEqual(splitRow(30, 20, [['b', 30, 20]], covered, ['a', 'b']), { buy: 0, sell: 0, partBuy: 30, partSell: 20 });
  assert.deepEqual(splitRow(30, 20, undefined, covered, ['a']), { buy: 30, sell: 20, partBuy: 0, partSell: 0 }, 'one market: the row is all its own');
  assert.deepEqual(splitRow(30, 20, undefined, covered, ['a', 'b']), { buy: 0, sell: 0, partBuy: 30, partSell: 20 }, 'several markets with no parts cannot be judged');
  // A partial market selling 900 against a covered one buying 100: the judgement sees the covered 100 bought, never a buy imbalance of the whole row.
  assert.deepEqual(splitRow(100, 900, [['a', 100, 0], ['b', 0, 900]], covered, ['a', 'b']), { buy: 100, sell: 0, partBuy: 0, partSell: 900 });
});

test('the countdown and the point of control', () => {
  assert.equal(countdownText(134_000), '2:14'); assert.equal(countdownText(3_725_000), '1:02:05'); assert.equal(countdownText(-5), '0:00');
  assert.equal(pocIndex([[1, 2, 3], [2, 10, 1], [3, 0, 0]]), 1); assert.equal(pocIndex([]), -1);
});

test('liquidity added and pulled: past the noise only, a pull at a row the price passed is not called one, and a trade marks the row', () => {
  const rows = (entries: [string, number][]) => new Map(entries.map(([k, usd]) => [k, { side: k.startsWith('bid') ? 'bid' as const : 'ask' as const, usd }]));
  const none = new Set<string>();
  const big = new PulseTracker();
  big.frame(0, rows([['ask:100', 50_000], ['ask:101', 50_000]]), none, none, 10_000);
  assert.equal(big.pulses.size, 0, 'a first frame has nothing to compare with');
  big.frame(300, rows([['ask:100', 200_000], ['ask:101', 50_000]]), none, none, 10_000);
  const p = big.pulses.get('ask:100')!;
  assert.ok(p && p.sign === 1 && p.strength > 0.9 && !p.traded, 'a change many times the threshold shows at once');
  assert.equal(p.before, 50_000);
  assert.equal(big.pulses.has('ask:101'), false, 'an unchanged row is calm');

  const small = new PulseTracker();
  small.frame(0, rows([['bid:99', 100_000]]), none, none, 10_000);
  small.frame(300, rows([['bid:99', 95_000]]), none, none, 10_000);
  assert.equal(small.pulses.size, 0, 'a change under the threshold shows nothing');
  small.frame(600, rows([['bid:99', 80_000]]), none, none, 10_000);
  assert.equal(small.pulses.size, 0, 'a moderate change waits for the next frame to agree');
  small.frame(900, rows([['bid:99', 79_000]]), none, none, 10_000);
  assert.equal(small.pulses.get('bid:99')?.sign, -1, 'and shows once it does');

  const touched = new PulseTracker();
  touched.frame(0, rows([['bid:99', 200_000], ['bid:98', 200_000]]), none, none, 10_000);
  touched.frame(300, rows([['bid:99', 20_000], ['bid:98', 20_000]]), new Set(['bid:98']), new Set(['bid:99', 'bid:98']), 10_000);
  assert.equal(touched.pulses.has('bid:99'), false, 'gone where the price passed, with no trade there: not called a pull');
  assert.equal(touched.pulses.get('bid:98')?.traded, true, 'gone where trades reached: marked traded');

  const view = new PulseTracker();
  view.frame(0, rows([['ask:100', 200_000]]), none, none, 10_000);
  view.frame(300, rows([['ask:105', 200_000]]), none, none, 10_000);
  view.frame(600, rows([['ask:100', 200_000]]), none, none, 10_000);
  assert.equal(view.pulses.size, 0, 'a row that left the view and came back is not read as pulled and restacked');

  const once = new PulseTracker();
  once.frame(0, rows([['ask:100', 50_000]]), none, none, 10_000);
  once.frame(250, rows([['ask:100', 200_000]]), none, none, 10_000);
  const first = once.pulses.get('ask:100')!.at;
  for (const t of [500, 750]) once.frame(t, rows([['ask:100', 200_000]]), none, none, 10_000);
  assert.equal(once.pulses.get('ask:100')!.at, first, 'one step in the book is one flash: the frames after it, inside the window, do not renew it');

  const away = new PulseTracker();
  away.frame(0, rows([['bid:99', 100_000]]), none, none, 10_000);
  away.frame(300, rows([['bid:99', 80_000]]), none, none, 10_000);
  away.frame(600, rows([['bid:98', 100_000]]), none, none, 10_000);
  away.frame(900, rows([['bid:99', 100_000], ['bid:98', 100_000]]), none, none, 10_000);
  away.frame(1_200, rows([['bid:99', 0], ['bid:98', 100_000]]), none, none, 10_000);
  assert.equal(away.pulses.size, 0, 'a row that left the view forgets the confirmation it was waiting for');

  const gap = new PulseTracker();
  gap.frame(0, rows([['bid:99', 200_000], ['bid:98', 200_000]]), none, none, 10_000);
  gap.frame(60_000, rows([['bid:99', 20_000], ['bid:98', 400_000]]), none, none, 10_000);
  assert.equal(gap.pulses.size, 0, 'after a gap (the view hidden a minute) what changed meanwhile is not shown as if it had just happened');
  gap.frame(60_300, rows([['bid:99', 20_000], ['bid:98', 900_000]]), none, none, 10_000);
  assert.equal(gap.pulses.get('bid:98')?.sign, 1, 'and changes after it are read again');

  big.frame(300 + PULSE_LIFE_MS + 1, rows([['ask:100', 200_000], ['ask:101', 50_000]]), none, none, 10_000);
  assert.equal(big.pulses.has('ask:100'), false, 'a pulse ends');
  big.reset(); assert.equal(big.pulses.size, 0);
  assert.equal(pulseEnvelope(0), 0); assert.equal(pulseEnvelope(80), 1); assert.ok(pulseEnvelope(300) < 1 && pulseEnvelope(300) > 0); assert.equal(pulseEnvelope(PULSE_LIFE_MS + 1), 0);
});

test('the tape keeps every order since it began, per market, and groups its rows at any doubled step', () => {
  const tape = new TapeTally(1_000);
  assert.equal(tape.range, null); assert.deepEqual(tape.rows(8, null), []);
  tape.add('binance:BTCUSDT', 81_001, 50_000); tape.add('binance:BTCUSDT', 81_003, -20_000); tape.add('okx:BTC-USDT-SWAP', 81_009, 10_000);
  assert.equal(tape.fine, 2, 'a tenth of the price grid at 81K');
  assert.deepEqual(tape.range, { lo: 81_001, hi: 81_009 });
  assert.deepEqual(tape.rows(2, null), [[81_000, 50_000, 0], [81_002, 0, 20_000], [81_008, 10_000, 0]]);
  assert.deepEqual(tape.rows(8, null), [[81_000, 50_000, 20_000], [81_008, 10_000, 0]], 'grouped four fine rows to one');
  assert.deepEqual(tape.rows(8, ['okx:BTC-USDT-SWAP']), [[81_008, 10_000, 0]], 'only the markets asked for');
  tape.add('binance:BTCUSDT', 0, 5); tape.add('binance:BTCUSDT', 81_000, 0); tape.add('binance:BTCUSDT', 81_000, Number.NaN);
  assert.equal(tape.count, 3, 'nothing without a price or a size');
  tape.add('binance:BTCUSDT', 81_004, 1);
  assert.deepEqual(tape.rows(2, null).find(r => r[0] === 81_004), [81_004, 1, 0], 'a new order shows, not a cached answer');
});

test('a trade exactly on a row edge goes in the row above it, where the map footprint puts it, also as the tape ring hands it back', () => {
  assert.equal(Math.floor(4102.4 / 0.1), 41_023, 'plain division puts it a row low');
  assert.equal(binOf(4102.4, 0.1), 41_024, 'the shared rule does not');
  const tape = new TapeTally(0);
  tape.add('m', 4102.4, 1_000);
  assert.equal(tape.fine, 0.1);
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
  assert.ok(near(tape.rows(0.1, null)[0]![0], 4102.4) && near(tape.rows(0.2, null)[0]![0], 4102.4), 'its row starts at its price, at the fine step and doubled');
  // ETH-like prices on every fine edge of $200, exact and as the ring keeps them (a float32 offset from its first price, read back with the
  // slack that offset may lose), and a tick under each edge, which must stay in the row below.
  for (const p0 of [4050.37, 4102.5, 4150, 4249.99]) {
    for (let k = 0; k < 2_000; k++) {
      const edge = Number(((40_500 + k) / 10).toFixed(1)), under = Number(((405_000 + 10 * k - 1) / 100).toFixed(2));
      const off = Math.fround(edge - p0), offUnder = Math.fround(under - p0);
      assert.equal(binOf(edge, 0.1), 40_500 + k, `${edge}`);
      assert.equal(binOf(p0 + off, 0.1, ringSlack(off)), 40_500 + k, `${edge} from the ring at ${p0}`);
      assert.equal(binOf(p0 + offUnder, 0.1, ringSlack(offUnder)), 40_499 + k, `${under} from the ring at ${p0}`);
    }
  }
  // The same through the tape and the rail, with a price as the ring gives it back.
  const p0 = 4102.5, off = Math.fround(4102.4 - p0), read = p0 + off, ringTape = new TapeTally(0);
  assert.ok(read < 4102.4, 'the ring reads this one a hair low');
  ringTape.add('m', read, 1_000, ringSlack(off));
  assert.ok(near(ringTape.rows(0.1, null)[0]![0], 4102.4));
  assert.deepEqual(railCells([{ price: read, usd: 50_000, at: 10, inst: 0, slack: ringSlack(off) }], 0.1, 0, 20).map(c => c.bin), [41_024]);
});

test('the tape keeps a bounded number of bins however far the price walks, and its rows at the view\'s steps are those of every order', () => {
  const tape = new TapeTally(0), orders: { m: string; p: number; usd: number }[] = [];
  let price = 4_000, seed = 7;
  const rand = (): number => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  for (let i = 0; i < 60_000; i++) {
    price = Math.max(500, price * (1 + (rand() - 0.5) * 0.006));
    const p = Math.round(price * 100) / 100, usd = Math.round((rand() - 0.45) * 50_000) || 1, m = i % 3 ? 'binance:ETHUSDT' : 'okx:ETH-USDT-SWAP';
    tape.add(m, p, usd); orders.push({ m, p, usd });
  }
  const range = tape.range!;
  assert.ok((range.hi - range.lo) / tape.fine > TAPE_BINS, 'the walk spans more fine steps than the tape holds bins');
  assert.ok(tape.held <= TAPE_BINS, `${tape.held} bins a market`);
  assert.ok(tape.binWidth > tape.fine, 'so the bins were made wider');
  // Every order's row, added up from scratch, as the tape counted before it had a bound.
  const reference = (step: number, markets: readonly string[] | null): [number, number, number][] => {
    const ratio = Math.max(1, Math.round(step / tape.fine)), out = new Map<number, [number, number]>();
    for (const o of orders) {
      if (markets && !markets.includes(o.m)) continue;
      const row = Math.floor(binOf(o.p, tape.fine) / ratio), r = out.get(row) ?? [0, 0];
      if (o.usd > 0) r[0] += o.usd; else r[1] -= o.usd;
      out.set(row, r);
    }
    return [...out].sort((a, b) => a[0] - b[0]).map(([row, [buy, sell]]) => [row * ratio * tape.fine, buy, sell]);
  };
  // The finest step the view asks for: zoomed in as far as a pinch goes (0.2) on a plot 2,000 px tall.
  const step = rowStepFor(tape.fine, priceSpan(range.lo, range.hi, price, 0, 2_000, 0.2, 0));
  assert.ok(step >= tape.binWidth, `the view's step ${step} is never finer than the bins ${tape.binWidth}`);
  for (const s of [step, 2 * step, 16 * step]) {
    for (const markets of [null, ['binance:ETHUSDT'], ['okx:ETH-USDT-SWAP']]) {
      const got = tape.rows(s, markets), want = reference(s, markets);
      assert.equal(got.length, want.length);
      got.forEach((r, i) => {
        const w = want[i]!;
        assert.equal(r[0], w[0]);
        assert.ok(Math.abs(r[1] - w[1]) < 1e-6 && Math.abs(r[2] - w[2]) < 1e-6, `row ${r[0]} at ${s}`);
      });
    }
  }
});

test('the tape keeps the rows last asked for and adds each new order to them', () => {
  const tape = new TapeTally(0);
  for (let i = 0; i < 500; i++) tape.add(i % 2 ? 'a' : 'b', 81_000 + (i % 50) * 2, i % 3 ? 1_000 : -700);
  const first = tape.rows(8, ['a']);
  assert.equal(tape.rows(8, ['a']), first, 'nothing new: the same answer, not added up again');
  tape.add('a', 81_010, 5_000); tape.add('b', 81_010, 9_999); tape.add('a', 80_000, -3_000);
  const kept = tape.rows(8, ['a']);
  assert.notEqual(kept, first, 'a new order changes it');
  tape.rows(16, null);
  assert.deepEqual(tape.rows(8, ['a']), kept, 'and the rows kept up order by order are those added up afresh');
  assert.deepEqual(kept.find(r => r[0] === 80_000), [80_000, 0, 3_000], 'a row past the ones held before');
});

test('the tape counts as missed the time it was hidden with no orders coming, not the time a hidden window went on receiving them', () => {
  // A phone: suspended in the background, nothing arrives until it shows again.
  const phone = new TapeGaps(0, false);
  phone.arrived(1_000); phone.hide(2_000); phone.show(62_000); phone.arrived(62_300);
  assert.equal(phone.missedMs, 60_000);
  // A desktop window in the phone's arrangement: hidden for a minute, with orders every quarter second all along.
  const desk = new TapeGaps(0, false);
  desk.hide(1_000); for (let t = 1_000; t <= 61_000; t += 250) desk.arrived(t); desk.show(61_000); desk.arrived(61_250);
  assert.equal(desk.missedMs, 0);
  // The screen blinking inside a quiet spell is not a gap.
  const blink = new TapeGaps(0, false);
  blink.arrived(1_000); blink.hide(2_000); blink.show(4_000); blink.arrived(30_000);
  assert.equal(blink.missedMs, 0, 'hidden 2 s inside a quiet 29 s');
  // A page opened in a background tab counts that first stretch.
  const late = new TapeGaps(0, true);
  late.show(40_000); late.arrived(40_500);
  assert.equal(late.missedMs, 40_000);
  // Hidden, and orders come again before it shows: the hidden time up to them, none after.
  const resumed = new TapeGaps(0, false);
  resumed.arrived(0); resumed.hide(1_000); for (let t = 21_000; t <= 30_000; t += 250) resumed.arrived(t); resumed.show(30_000); resumed.arrived(30_250);
  assert.equal(resumed.missedMs, 20_000);
});
