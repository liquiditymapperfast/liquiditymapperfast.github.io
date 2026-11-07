import test from 'node:test';
import assert from 'node:assert/strict';
import { coinText, minuteOpens, nlnsCardLines, nlnsModel, nlnsWhoLines, whoParts, withLead, type NlnsMarket } from '../src/app/delta/nlns.ts';
import { fetchOiReading } from '../src/shared/history.ts';
import { quoteRows } from '../src/shared/series.ts';
import { atOnePrice, inverseOi } from '../src/app/oi-change.ts';
import { readDelta } from '../src/app/delta/settings.ts';
import type { CandleRow, OiBar } from '../src/app/store.ts';

const M = 60_000, H = 3_600_000, T = Date.UTC(2026, 9, 9, 10);
const flow = (delta: number) => ({ delta, low: Math.min(0, delta), high: Math.max(0, delta), gross: Math.abs(delta) + 1 });
/** One reading a bar: open = close. */
const bar = (t: number, oi: number): OiBar => [t, oi, oi, oi, oi];
const none = new Map<number, number>();
const keys = (starts: readonly number[]) => starts.map(() => 0);

test('the four readings: open interest up or down, given to buyers or sellers at market', () => {
  const starts = [T, T + H, T + 2 * H, T + 3 * H];
  const market: NlnsMarket = { bars: [bar(T - H, 100), bar(T, 110), bar(T + H, 118), bar(T + 2 * H, 114), bar(T + 3 * H, 108)], flows: [flow(5e6), flow(-3e6), flow(-1e6), flow(2e6)] };
  const c = nlnsModel(starts, [market], none, keys(starts), H);
  assert.deepEqual(c.map(x => [x.kind, x.v, x.cum]), [['newLongs', 10, 10], ['newShorts', -8, 2], ['longsClosed', -4, -2], ['shortsClosed', 6, 4]]);
  assert.deepEqual(c.map(x => [x.longs, x.shorts]), [[10, 0], [0, 8], [-4, 0], [0, -6]]);
  assert.deepEqual(c.map(x => [x.cumLongs, x.cumShorts]), [[10, 0], [10, 8], [6, 8], [6, 2]]);
  assert.ok(c.every(x => !x.byPrice && !x.coarse && x.counted === 1 && x.covered === 1));
});

test('venues are each read first, then added: new longs on one and new shorts on another both show, as both sides', () => {
  const starts = [T, T + H];
  const a: NlnsMarket = { bars: [bar(T, 100), bar(T + H, 110)], flows: [null, flow(5)] };
  const b: NlnsMarket = { bars: [bar(T, 200), bar(T + H, 210)], flows: [null, flow(-5)] };
  const [first, c] = nlnsModel(starts, [a, b], none, keys(starts), H);
  assert.equal(first!.kind, null, 'the first readings have nothing before them');
  assert.deepEqual([c!.dOi, c!.longOpened, c!.shortOpened, c!.longs, c!.shorts, c!.v, c!.kind, c!.counted], [20, 10, 10, 10, 10, 0, 'mixed', 2]);
  const lines = nlnsCardLines(c!, '1h', 'BTC', '2 venues added together', 2);
  assert.deepEqual(lines.slice(1, 5).map(l => [l.label, l.text]), [['Open interest', '+20 BTC · +6.67%'], ['Read as', 'Both ways'], ['New longs', '+10 BTC'], ['New shorts', '+10 BTC']]);
  // New longs beside shorts closed: the longs side twice, though open interest did not move.
  const closing: NlnsMarket = { bars: [bar(T, 200), bar(T + H, 190)], flows: [null, flow(5)] };
  const [, d] = nlnsModel(starts, [a, closing], none, keys(starts), H);
  assert.deepEqual([d!.dOi, d!.v, d!.kind], [0, 20, 'newLongs']);
});

test('recorded flow that came out even goes to neither side; flow not recorded leaves the chart\'s closes to decide, and says so', () => {
  const starts = [T, T + H, T + 2 * H];
  const bars = [bar(T, 100), bar(T + H, 110), bar(T + 2 * H, 115)];
  const closes = new Map([[T, 50_000], [T + H, 49_000], [T + 2 * H, 49_500]]);
  const c = nlnsModel(starts, [{ bars, flows: [null, flow(0), null] }], closes, keys(starts), H);
  assert.deepEqual(c.map(x => [x.kind, x.unassigned, x.v, x.byPrice]), [[null, 0, 0, false], [null, 10, 0, false], ['newLongs', 0, 5, true]]);
  assert.equal(nlnsCardLines(c[1]!, '1h', 'BTC', 'Binance BTCUSDT')[2]!.text, 'takers even');
  // No flow and no closes (the chart's candles are another market's): neither side, and not taken for takers even.
  const blind = nlnsModel(starts, [{ bars, flows: [null, null, null] }], none, keys(starts), H);
  assert.deepEqual(blind.map(x => [x.unassigned, x.unknown]), [[0, 0], [0, 10], [0, 5]]);
  assert.equal(nlnsCardLines(blind[1]!, '1h', 'BTC', 'Binance BTCUSDT')[2]!.text, 'side unknown');
});

test('flow over only part of a reading\'s stretch does not decide it: the price does, or no side', () => {
  // An hourly reading on a 15-minute chart, flow recorded for the first quarter only (buyers) and selling as the price fell.
  const Q = H / 4, starts = [T, T + Q, T + 2 * Q, T + 3 * Q, T + H];
  const bars = [bar(T, 100), bar(T + H, 110)], flows = [null, flow(50), null, null, null];
  const closes = new Map([[T, 50_000], [T + H, 49_000]]);
  const [byPrice] = nlnsModel(starts, [{ bars, flows }], closes, keys(starts), Q, H).slice(-1);
  assert.deepEqual([byPrice!.kind, byPrice!.byPrice], ['newShorts', true], 'the price fell: new shorts, not the first quarter\'s buyers');
  const [blind] = nlnsModel(starts, [{ bars, flows }], none, keys(starts), Q, H).slice(-1);
  assert.deepEqual([blind!.kind, blind!.unknown], [null, 10]);
  // Recorded over the whole stretch, the takers decide.
  const [whole] = nlnsModel(starts, [{ bars, flows: [null, flow(50), flow(-10), flow(5), flow(1)] }], closes, keys(starts), Q, H).slice(-1);
  assert.deepEqual([whole!.kind, whole!.byPrice], ['newLongs', false]);
});

test('a venue read hourly on a one-minute chart: its change lands in the candle of its new reading, given to its takers over the whole hour', () => {
  const starts = Array.from({ length: 61 }, (_, i) => T + i * M);
  // Buyers for the first half hour, sellers twice as heavy for the second: the hour's takers sold.
  const flows = starts.map((_, i) => i === 0 ? null : flow(i <= 30 ? 1 : -2));
  const c = nlnsModel(starts, [{ bars: [bar(T, 1_000), bar(T + H, 1_050)], flows }], none, keys(starts), M);
  assert.equal(c.length, 61, 'every minute between the readings is covered: the reading holds');
  assert.ok(c.slice(0, 60).every(x => x.v === 0 && x.kind === null));
  assert.deepEqual([c[60]!.kind, c[60]!.v, c[60]!.coarse], ['newShorts', -50, true]);
  assert.ok(nlnsCardLines(c[60]!, '1m', 'BTC', 'Bybit BTCUSDT').some(l => /whole stretch/.test(l.text)));
});

test('readings further apart than the hold are a gap: no change across it, and the sums start again after it; a new day starts again', () => {
  const starts = [T, T + H, T + 2 * H, T + 3 * H, T + 4 * H, T + 5 * H];
  const bars = [bar(T, 100), bar(T + H, 110), bar(T + 5 * H, 150)];
  const c = nlnsModel(starts, [{ bars, flows: starts.map(() => flow(1)) }], none, keys(starts), H);
  assert.deepEqual(c.map(x => [x.t, x.v, x.run]), [[T, 0, 0], [T + H, 10, 0], [T + 2 * H, 0, 0], [T + 3 * H, 0, 0], [T + 5 * H, 0, 1]], 'held two hours after the reading at 1h, not at 4h; four hours between readings is no change');
  const daily = nlnsModel(starts.slice(0, 3), [{ bars: [bar(T, 100), bar(T + H, 110), bar(T + 2 * H, 120)], flows: [flow(1), flow(1), flow(1)] }], none, [0, 0, 1], H);
  assert.deepEqual(daily.map(x => x.cum), [0, 10, 10]);
});

test('an inverse market\'s open interest is put at one price: a move of the price alone opens and closes nothing', () => {
  assert.deepEqual(['deribit:BTC-PERPETUAL', 'deribit:BTC_USDC-PERPETUAL', 'binance:BTCUSDT'].map(inverseOi), [true, false, false]);
  // $1M of contracts throughout, read as coins at each reading's price.
  const candles: CandleRow[] = [[T, 0, 0, 0, 50_000, 0], [T + H, 0, 0, 0, 55_000, 0], [T + 3 * H, 0, 0, 0, 40_000, 0]];
  const bars = [bar(T - H, 1), bar(T, 1e6 / 50_000), bar(T + H, 1e6 / 55_000), bar(T + 2 * H, 1e6 / 55_000), bar(T + 3 * H, 1e6 / 40_000)];
  const at = atOnePrice(bars, candles);
  assert.equal(at.length, 4, 'the bar before the first candle is left out');
  for (const b of at) assert.ok(Math.abs(b[4] - 1e6 / 40_000) < 1e-9, 'every reading at the newest close');
  assert.equal(atOnePrice(bars, []), bars, 'no candles: as they are');
});

test('the words: coins, signed and short; the popup gives the share of open interest, both sides\' sums and names the market', () => {
  assert.deepEqual([coinText(325.4, 'BTC'), coinText(-1_234_567, 'DOGE'), coinText(0.042, 'BTC'), coinText(0, '')], ['+325 BTC', '−1.2M DOGE', '+0.042 BTC', '0']);
  const [, c] = nlnsModel([T, T + H], [{ bars: [bar(T, 92_000), bar(T + H, 92_092)], flows: [null, flow(-1)] }], none, [0, 0], H);
  const lines = nlnsCardLines(c!, '1h', 'BTC', 'Binance BTCUSDT');
  assert.deepEqual(lines.slice(1, 4).map(l => [l.label, l.text]), [['Open interest', '+92 BTC · +0.10%'], ['Read as', 'New shorts'], ['New shorts', '+92 BTC']]);
  assert.deepEqual(lines.slice(4, 7).map(l => [l.label, l.text]), [['Longs', '0 BTC · since the start 0 BTC'], ['Shorts', '+92 BTC · since the start +92 BTC'], ['Net', '−92 BTC · since the start −92 BTC']]);
  assert.match(lines[lines.length - 1]!.text, /Binance BTCUSDT/);
  assert.equal(readDelta({ style: 'nlns' }).style, 'nlns');
  assert.deepEqual([readDelta({}).nlns, readDelta({ nlns: 'split' }).nlns, readDelta({ nlns: 'both' }).nlns], ['net', 'split', 'net'], 'net by default; split kept; anything else net');
});

test('a 4-hour or daily chart: bars a candle apart are consecutive readings, not a gap', () => {
  const D = 24 * H, starts = [T, T + D, T + 2 * D];
  const c = nlnsModel(starts, [{ bars: [bar(T, 100), bar(T + D, 120), bar(T + 2 * D, 110)], flows: [null, flow(5), flow(-5)] }], none, keys(starts), D);
  assert.deepEqual(c.map(x => [x.kind, x.v]), [[null, 0], ['newLongs', 20], ['longsClosed', -10]]);
  assert.ok(c.every(x => !x.coarse), 'a candle apart is not coarse');
});

test('a reading whose stretch began before the view is given to the takers of the whole stretch, wherever the view starts', () => {
  // Hourly readings on a one-minute chart: buyers for 50 minutes (+1 each), sellers for the last 10 (−2 each): the hour's takers bought (+30).
  const flowAt = (t: number) => t > T && t <= T + H ? flow(t <= T + 50 * M ? 1 : -2) : null;
  const bars = [bar(T, 1_000), bar(T + H, 1_050)];
  const read = (from: number) => {
    const starts = Array.from({ length: (T + H - from) / M + 1 }, (_, i) => from + i * M);
    const lead = withLead(starts, starts.map(() => 0), M);
    return nlnsModel(lead.all, [{ bars, flows: lead.all.map(flowAt) }], none, lead.keys, M).filter(x => x.t >= starts[0]!);
  };
  for (const from of [T, T + 30 * M, T + 50 * M]) {
    const last = read(from).at(-1)!;
    assert.deepEqual([last.t, last.kind, last.v, last.cum], [T + H, 'newLongs', 50, 50], `view from ${(from - T) / M} min`);
  }
});

/** Minute readings and minute flow from `from` for `n` minutes: `oiAt(k)` the reading at minute k (null: none), `deltaAt(k)` the takers (null: not recorded). */
function minutes(from: number, n: number, oiAt: (k: number) => number | null, deltaAt: (k: number) => number | null) {
  const starts = Array.from({ length: n }, (_, k) => from + k * M);
  const bars = starts.flatMap((t, k) => { const v = oiAt(k); return v === null ? [] : [bar(t, v)]; });
  return { starts, bars, flows: starts.map((_, k) => { const d = deltaAt(k); return d === null ? null : flow(d); }) };
}

test('minute pieces: an hour whose takers sold on balance, but whose rise came from longs opened at market early in it', () => {
  // The hour from T: ten minutes of buyers opening +10 each (+100), then sellers closing 30 of it; the hour's takers sold on balance (−100).
  const oiAt = (k: number) => k < 60 ? 1_000 : k < 70 ? 1_000 + (k - 59) * 10 : k < 100 ? 1_100 - (k - 69) : 1_070;
  const deltaAt = (k: number) => k < 60 ? 0 : k < 70 ? 1 : k < 100 ? -3 : -1;
  const fine = minutes(T - H, 120, oiAt, deltaAt);
  const starts = [T - H, T], hourly = [bar(T - H, 1_000), bar(T, 1_070)], flows = [flow(0), flow(10 - 90 - 20)];
  const [, coarse] = nlnsModel(starts, [{ bars: hourly, flows }], none, keys(starts), H, H, T + H);
  assert.deepEqual([coarse!.shortOpened, coarse!.longOpened, coarse!.fine], [70, 0, 0], 'one reading for the hour: its takers sold, so the rise was new shorts');
  const [, c] = nlnsModel(starts, [{ bars: hourly, flows, fine }], none, keys(starts), H, H, T + H);
  assert.deepEqual([c!.longOpened, c!.longClosed, c!.shortOpened, c!.shortClosed, c!.dOi, c!.oiStart, c!.fine, c!.counted], [100, 30, 0, 0, 70, 1_000, 1, 1]);
  assert.ok(nlnsCardLines(c!, '1h', 'BTC', 'Hyperliquid BTC').some(l => /Minute by minute/.test(l.text)));
});

test('minute pieces add up to the candle\'s own change; a venue read every five minutes gives its steps to the five minutes\' takers', () => {
  // Every fifth minute a reading (a venue's five-minute history), the takers alternating, over three hours.
  const oiAt = (k: number) => k % 5 === 0 ? 500 + ((k * 7) % 23) - (k % 3) : null, deltaAt = (k: number) => (k % 4) - 1.5;
  const fine = minutes(T - H, 240, oiAt, deltaAt);
  const starts = [T - H, T, T + H, T + 2 * H];
  // The candle's bar holds its last reading, as the bars on the chart's timeframe do.
  const hourly = starts.map(s => { const inside = fine.bars.filter(b => b[0] >= s && b[0] < s + H); return bar(s, inside[inside.length - 1]![4]); });
  const flows = starts.map(() => flow(1));
  const coarse = nlnsModel(starts, [{ bars: hourly, flows }], none, keys(starts), H, H, T + 3 * H);
  const pieces = nlnsModel(starts, [{ bars: hourly, flows, fine }], none, keys(starts), H, H, T + 3 * H);
  for (let i = 1; i < starts.length; i++) {
    assert.equal(pieces[i]!.fine, 1, `hour ${i} from its minutes`);
    assert.ok(Math.abs(pieces[i]!.dOi - coarse[i]!.dOi) < 1e-9, `hour ${i}: the pieces add up to the hour's change`);
    const c = pieces[i]!;
    assert.ok(Math.abs(c.longOpened + c.shortOpened + c.unsidedUp - c.longClosed - c.shortClosed - c.unsidedDown - c.dOi) < 1e-9, `hour ${i}: the parts add up to the change`);
  }
  assert.equal(pieces[0]!.fine, 0, 'the first hour: its minute readings do not begin before it');
});

test('minute pieces stand for a candle only where they reach it whole: flow missing in a piece, readings that stop, a one-minute chart', () => {
  const oiAt = (k: number) => 1_000 + k, deltaAt = (k: number) => k === 75 ? null : 1;
  const fine = minutes(T - H, 180, oiAt, deltaAt);
  const starts = [T - H, T, T + H], hourly = [bar(T - H, 1_059), bar(T, 1_119), bar(T + H, 1_179)], flows = starts.map(() => flow(-1));
  const c = nlnsModel(starts, [{ bars: hourly, flows, fine }], none, keys(starts), H, H, T + 2 * H);
  assert.deepEqual(c.map(x => [x.fine, x.longOpened, x.shortOpened]), [[0, 0, 0], [0, 0, 60], [1, 60, 0]], 'the hour with a minute of flow missing keeps its one reading (sellers); the next is worked out minute by minute');
  // Readings that stop twenty minutes before the hour's end say nothing of its last twenty minutes.
  const stopped = minutes(T - H, 160, oiAt, () => 1);
  const [, , late] = nlnsModel(starts, [{ bars: hourly, flows, fine: stopped }], none, keys(starts), H, H, T + 2 * H);
  assert.equal(late!.fine, 0);
  // On a one-minute chart the candle is the minute: no pieces.
  const m = fine.starts.slice(60, 70), mFlows = m.map(() => flow(1)), mBars = fine.bars.filter(b => b[0] >= m[0]! - M && b[0] <= m[m.length - 1]!);
  assert.ok(nlnsModel(m, [{ bars: mBars, flows: mFlows, fine }], none, keys(m), M, H, T + 2 * H).every(x => x.fine === 0));
});

test('minute readings that fall silent longer than the hold do not stand for the candle they resume in: its change would be counted nowhere', () => {
  // Readings every minute until 02:04, none until 04:10 (126 minutes), then every minute again: the hour from 04:00 holds the jump across the silence.
  const H2 = T + 2 * H, H4 = T + 4 * H;
  const fine = minutes(T, 6 * 60, k => (T + k * M <= H2 + 4 * M || T + k * M >= H4 + 10 * M) ? 1_000 + k : null, () => 1);
  const starts = [T + 3 * H, H4, T + 5 * H], hourly = [bar(T + 3 * H, 1_000 + 124), bar(H4, 1_000 + 299), bar(T + 5 * H, 1_000 + 359)];
  const [, four, five] = nlnsModel(starts, [{ bars: [bar(H2, 1_000 + 124), ...hourly], flows: starts.map(() => flow(1)), fine }], none, keys(starts), H, undefined, T + 6 * H);
  assert.deepEqual([four!.fine, four!.dOi], [0, 175], 'the reading per candle: the whole step since the hour before');
  assert.deepEqual([five!.fine, five!.dOi, five!.longOpened], [1, 60, 60], 'the next hour from its minutes again');
});

test('who made a change, for the OI pane: the parts of a rise and of a fall, the popup lines, and the opening of one market hour by hour', () => {
  const c = nlnsModel([T, T + H], [{ bars: [bar(T, 100), bar(T + H, 130)], flows: [null, flow(5)] }], none, [0, 0], H)[1]!;
  assert.deepEqual(whoParts(c, true), { buy: 30, sell: 0, none: 0 });
  assert.deepEqual(whoParts({ ...c, longClosed: 4, shortClosed: 6, unsidedDown: 2 }, false), { buy: 6, sell: 4, none: 2 }, 'a fall: shorts closed are the buyers\' part');
  const lines = nlnsWhoLines({ ...c, unassigned: 3, fine: 1, counted: 2 }, 'BTC');
  assert.deepEqual(lines.slice(0, 2).map(l => [l.label, l.text]), [['New longs', '+30 BTC'], ['Takers even', '+3.0 BTC']]);
  assert.ok(lines[0]!.rule, 'set apart from the lines above it');
  assert.ok(lines.some(l => /Minute by minute for 1 of 2 venues/.test(l.text)));
  // An hour of one market from its minutes: buyers opened 40, sellers 20.
  const fine = minutes(T - H, 2 * 60, k => k < 60 ? 500 : k < 100 ? 500 + (k - 59) : 540 + Math.min(20, k - 99), k => k < 60 ? 0 : k < 100 ? 1 : -1);
  const [, hour] = minuteOpens([T - H, T], fine, H, T + H);
  assert.deepEqual(hour, { longOpened: 40, shortOpened: 20 });
});

test('an inverse market keeps its own USD with each reading; stored bars and samples give it in place of coins', async () => {
  const get = (async () => ({ result: [{ open_interest: 1_000_000, mark_price: 50_000 }] })) as never;
  assert.deepEqual(await fetchOiReading('deribit', get, { symbol: 'BTC-PERPETUAL', unit: 1, inverse: true }), { base: 20, quote: 1_000_000 });
  assert.deepEqual(await fetchOiReading('deribit', get, { symbol: 'BTC_USDC-PERPETUAL', unit: 1 }), { base: 1_000_000 }, 'a linear market reads coins only');
  const rows = quoteRows([{ start: T, open: 20, close: 18, quoteOpen: 1e6, quoteHigh: 1e6, quoteLow: 1e6, quoteClose: 1e6 }, { start: T + H, close: 19 }, { observationTimestamp: T + 2 * H, base: 18.2, quote: 1e6 }, { observationTimestamp: T + 3 * H, base: 18 }]);
  assert.deepEqual(rows.map(r => [Number(r.start ?? r.observationTimestamp), Number(r.close ?? r.base)]), [[T, 1e6], [T + 2 * H, 1e6]], 'rows without USD are left out');
});
