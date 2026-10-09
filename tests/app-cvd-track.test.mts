import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowMinutes, FlowRecorder, FlowSeries } from '../src/shared/flow.ts';
import { FlowTrack } from '../src/app/cvd/track.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { buildModel } from '../src/app/cvd/model.ts';
import { Ranker } from '../src/app/cvd/rank.ts';
import { CVD_DEFAULTS } from '../src/app/cvd/settings.ts';

const MIN = 60_000, HOURS = 6, S0 = 1_800_000_000;   // S0: a whole minute, in seconds

/** Six hours of made-up trading, a buy and a sell most seconds at a wandering price, recorded the way the server records it. */
function recording(): { recorder: FlowRecorder; buy: Float64Array; sell: Float64Array; px: Float64Array } {
  let s = 5; const rnd = (): number => { s = (s * 1_103_515_245 + 12_345) & 0x7fffffff; return s / 0x7fffffff; };
  const n = HOURS * 3_600, buy = new Float64Array(n), sell = new Float64Array(n), px = new Float64Array(n);
  const recorder = new FlowRecorder(null, () => (S0 + n) * 1000, 36 * 3_600_000);
  const trades = [];
  let price = 80_000;
  for (let i = 0; i < n; i++) {
    price += (rnd() - 0.5) * 20;
    if (rnd() < 0.15) continue;   // a second nothing traded in
    const b = Math.round(rnd() * 50_000), q = Math.round(rnd() * 50_000), p = Math.round(price);
    buy[i] = b; sell[i] = q; px[i] = p;
    trades.push({ instrumentId: 'x:BTC', tradeId: `b${i}`, side: 'buy', price: p, notionalUsd: b, sourceTimestamp: (S0 + i) * 1000 + 100 });
    trades.push({ instrumentId: 'x:BTC', tradeId: `s${i}`, side: 'sell', price: p, notionalUsd: q, sourceTimestamp: (S0 + i) * 1000 + 600 });
  }
  recorder.ingest(trades);
  return { recorder, buy, sell, px };
}

/** The running delta at the end of second `S0 + i`, added up straight from the trades. */
const truth = (buy: Float64Array, sell: Float64Array): Float64Array => { const out = new Float64Array(buy.length); let d = 0; for (let i = 0; i < buy.length; i++) { d += buy[i]! - sell[i]!; out[i] = d; } return out; };

/** The page's seconds from `fromSec` on (17 s past a minute, as a ring that has rolled starts), and its minutes for all six hours. */
function pageOf(recorder: FlowRecorder, fromSec: number): { seconds: FlowSeries; minutes: FlowMinutes } {
  const frame = recorder.frame(['x:BTC'], fromSec * 1000, (S0 + HOURS * 3_600) * 1000).instruments[0]!, skip = fromSec - frame.t0 / 1000;
  const seconds = new FlowSeries(); seconds.load(fromSec, frame.buy.subarray(skip), frame.sell.subarray(skip), frame.px!.subarray(skip));
  return { seconds, minutes: new FlowMinutes(recorder.minutes(['x:BTC'], S0 * 1000, (S0 + HOURS * 3_600) * 1000).instruments[0]!) };
}

const close = (a: number, b: number, label: string): void => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)) + 0.01, `${label}: ${a} vs ${b}`);

test('the minutes before the seconds and the seconds make one running delta, with no step where they meet', () => {
  const { recorder, buy, sell } = recording(), real = truth(buy, sell);
  const from = S0 + 4 * 3_600 + 17, { seconds, minutes } = pageOf(recorder, from), track = new FlowTrack(seconds, minutes);
  assert.equal(track.join, S0 + 4 * 3_600 + 60, 'the seconds take over at their first whole minute');
  assert.equal(track.first, S0, 'the line begins where the minutes do');
  const at = (sec: number): number => track.cumDelta(sec) - track.cumDelta(S0 - 1);
  // Before the join the line is the running delta at every minute's end; after it, at every second.
  for (let m = S0 + 60; m <= track.join!; m += 60) close(at(m - 1), real[m - 1 - S0]!, `minute ending ${m - S0}`);
  for (let sec = track.join!; sec < S0 + HOURS * 3_600; sec += 7) close(at(sec), real[sec - S0]!, `second ${sec - S0}`);
});

test('a window across the join draws each column from what holds it: minutes before, seconds after, the same slices as before', () => {
  const { recorder, buy, sell, px } = recording(), real = truth(buy, sell);
  const { seconds, minutes } = pageOf(recorder, S0 + 4 * 3_600 + 17), track = new FlowTrack(seconds, minutes), join = track.join!;
  const columns = HOURS * 60, out = new Float64Array(columns * 3), base = track.cumDelta(S0 - 1);
  track.decimate(S0, S0 + HOURS * 3_600, columns, out);
  for (let c = 0; c < columns; c++) {
    const a = S0 + c * 60, b = a + 60;
    let lo = Infinity, hi = -Infinity; for (let s = a; s < b; s++) { lo = Math.min(lo, real[s - S0]!); hi = Math.max(hi, real[s - S0]!); }
    if (b <= join) { close(out[c * 3]! - base, lo, `low of minute ${c}`); close(out[c * 3 + 1]! - base, hi, `high of minute ${c}`); close(out[c * 3 + 2]! - base, real[b - 1 - S0]!, `last of minute ${c}`); }
    else { const own = new Float64Array(3); seconds.decimate(a, b, 1, own); assert.deepEqual([...out.subarray(c * 3, c * 3 + 3)], [...own], `column ${c} is the seconds'`); }
  }
  // Inside the seconds the track is the seconds, exactly.
  const inside = new Float64Array(30), own = new Float64Array(30);
  track.decimate(join + 600, join + 3_000, 10, inside); seconds.decimate(join + 600, join + 3_000, 10, own);
  assert.deepEqual([...inside], [...own]);
  // The price: the minute's last before the join, the second's after.
  const lastPriced = (to: number): number => { for (let s = to; s >= S0; s--) if (px[s - S0]! > 0) return px[s - S0]!; return NaN; };
  assert.equal(track.priceAt(S0 + 3_600 + 59), lastPriced(S0 + 3_600 + 59));
  assert.equal(track.priceAt(join + 1_234), seconds.priceAt(join + 1_234));
  const prices = new Float64Array(columns); track.priceColumns(S0, S0 + HOURS * 3_600, columns, prices);
  assert.equal(prices[30], lastPriced(S0 + 31 * 60 - 1));
});

test('minutes that stop short of the seconds are not joined, and minutes alone still draw', () => {
  const { recorder } = recording(), { seconds } = pageOf(recorder, S0 + 4 * 3_600 + 17);
  const short = new FlowMinutes(recorder.minutes(['x:BTC'], S0 * 1000, (S0 + 3_600) * 1000).instruments[0]!), track = new FlowTrack(seconds, short);
  assert.equal(track.join, null, 'a gap between them would be drawn as if nothing traded');
  const a = new Float64Array(30), b = new Float64Array(30);
  track.decimate(S0, S0 + HOURS * 3_600, 10, a); seconds.decimate(S0, S0 + HOURS * 3_600, 10, b);
  assert.deepEqual([...a], [...b], 'seconds alone');
  const alone = new FlowTrack(undefined, short), out = new Float64Array(12);
  alone.decimate(S0, S0 + 2 * 3_600, 4, out);
  assert.equal(alone.first, S0);
  assert.ok(Number.isFinite(out[2]!) && Number.isFinite(out[11]!), 'and past the last minute the line holds its last value');
  assert.equal(out[11], out[5]);
});

test('the column model draws a window older than the seconds from the minutes, without a gap at its start', () => {
  const { recorder } = recording(), book = new FlowBook(), from = S0 + 5 * 3_600;
  book.load(recorder.frame(['x:BTC'], from * 1000, (S0 + HOURS * 3_600) * 1000), ['x:BTC'], from * 1000);
  const settings = { ...CVD_DEFAULTS, rank: '1h' as const }, now = (S0 + HOURS * 3_600) * 1000;
  const run = (): ReturnType<typeof buildModel> => buildModel({ flow: book, ids: ['x:BTC'], kindOf: () => 'perp', t0: S0 * 1000, t1: now, columns: 120, now, settings, ranker: new Ranker() });
  const before = run();
  assert.ok(Number.isNaN(before.rows[0]!.lanes[0]!.last[0]!), 'seconds alone start an hour before the end');
  assert.deepEqual(book.minutesMissing(['x:BTC'], S0 * 1000, from * 1000), ['x:BTC']);
  book.loadMinutes(recorder.minutes(['x:BTC'], S0 * 1000, from * 1000 + 2 * MIN), ['x:BTC'], S0 * 1000, from * 1000 + 2 * MIN);
  assert.deepEqual(book.minutesMissing(['x:BTC'], S0 * 1000, from * 1000), [], 'asked for is held');
  const after = run(), lane = after.rows[0]!.lanes[0]!;
  assert.ok([...lane.last].every(v => Number.isFinite(v)), 'every column has a value');
  assert.ok([...after.perp!.last].every(v => Number.isFinite(v)), 'the aggregate too');
  assert.equal(after.perp!.last[119], lane.last[119], 'one instrument: the aggregate is its line');
});

test('a minute leaving memory keeps its totals for older windows, until the store would forget it', () => {
  let now = S0 * 1000 + 30_000;
  const recorder = new FlowRecorder(null, () => now, 10 * MIN, 60 * MIN);
  recorder.ingest([
    { instrumentId: 'x:BTC', tradeId: 'a', side: 'buy', price: 80_000, notionalUsd: 900, sourceTimestamp: S0 * 1000 + 2_000 },
    { instrumentId: 'x:BTC', tradeId: 'b', side: 'sell', price: 80_010, notionalUsd: 1_500, sourceTimestamp: S0 * 1000 + 40_000 },
  ]);
  const read = (): number[] => { const m = recorder.minutes(['x:BTC'], S0 * 1000, now).instruments[0]; return m ? [m.t0, m.buy[0]!, m.sell[0]!, m.px[0]!, m.lo[0]!, m.hi[0]!] : []; };
  const want = [S0 * 1000, 900, 1_500, 80_010, -600, 900];
  assert.deepEqual(read(), want, 'from memory');
  now += 20 * MIN; recorder.flush();
  assert.deepEqual(recorder.frame(['x:BTC'], S0 * 1000, now).instruments, [], 'memory no longer holds the seconds');
  assert.deepEqual(read(), want, 'the minute reads the same from what was kept');
  now += 60 * MIN; recorder.flush();
  assert.deepEqual(read(), [], 'past the store\'s keep it is gone');
});

test('an instrument with only older minutes counts in the aggregate, and never takes the place of one that trades now', () => {
  const { recorder } = recording(), book = new FlowBook(), now = (S0 + HOURS * 3_600) * 1000, from = S0 + 5 * 3_600;
  // x:BTC trades now (seconds for the last hour, minutes before); old:BTC, a market of the same exchange family and kind, has only older minutes.
  book.load(recorder.frame(['x:BTC'], from * 1000, now), ['x:BTC'], from * 1000);
  const old = recorder.minutes(['x:BTC'], S0 * 1000, (S0 + 3_600) * 1000).instruments[0]!;
  book.loadMinutes({ from: S0 * 1000, to: now, instruments: [recorder.minutes(['x:BTC'], S0 * 1000, from * 1000 + 2 * MIN).instruments[0]!, { ...old, id: 'y:BTC' }, { ...old, id: 'xspot:BTC' }] }, ['x:BTC', 'y:BTC', 'xspot:BTC'], S0 * 1000, from * 1000 + 2 * MIN);
  const run = (ids: string[]): ReturnType<typeof buildModel> => buildModel({ flow: book, ids, kindOf: () => 'perp', t0: S0 * 1000, t1: now, columns: 120, now, settings: { ...CVD_DEFAULTS, rank: '1h' }, ranker: new Ranker() });
  const one = run(['x:BTC']), both = run(['x:BTC', 'y:BTC']);
  assert.deepEqual(both.rows.map(r => r.key), ['x'], 'a row is an exchange that trades now');
  assert.notDeepEqual([...both.perp!.last.subarray(0, 20)], [...one.perp!.last.subarray(0, 20)], 'the older minutes of y count in the aggregate');
  const added = [...both.perp!.last.subarray(70)].map((v, i) => Math.round(v - one.perp!.last[70 + i]!));
  assert.ok(added.every(v => v === added[0]), 'after its minutes end its running delta holds where it ended');
  assert.deepEqual(both.counted, ['x:BTC'], 'the dot rows still count what trades now');
  // xspot is the x family (the alias) and the same kind here: the market that trades now keeps the place.
  const family = run(['xspot:BTC', 'x:BTC']);
  assert.deepEqual([...family.perp!.last], [...one.perp!.last], 'x, not xspot, is the family\'s line');
});
