import test from 'node:test';
import assert from 'node:assert/strict';
import { FOOTPRINT_REFRESH_MS, FootprintData, readBar, rowCellAt, rowCellLines, venueOrderOf } from '../src/app/panes/footprint.ts';
import type { FootprintResponse } from '../src/app/source.ts';

const H = 3_600_000;
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** A source holding one bar an hour that answers at most `per` bars a question, newest first, and says where it started; every question logged. */
function source(per: number) {
  const asked: { from: number; to: number; budget: number }[] = [], answered: number[] = [];
  const load = async (_inst: string, _tf: string, from: number, to: number, _rows: number, _cuts: readonly number[], budget: number): Promise<FootprintResponse> => {
    asked.push({ from, to, budget });
    const bars = [];
    for (let t = Math.floor((to - 1) / H) * H; t >= from && bars.length < per; t -= H) bars.unshift({ t, rows: [[100, t / H, 1]] as [number, number, number][], buyUsd: t / H, sellUsd: 1, minutes: 60 });
    answered.push(...bars.map(bar => bar.t));
    return { step: 5, fine: 5, bars, from: bars.length ? bars[0]!.t : from };
  };
  return { asked, answered, load };
}

/** performance.now as the test says, for the refresh interval. */
function clock(start: number) {
  let now = start; const real = performance.now.bind(performance);
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true, writable: true });
  return { advance: (ms: number) => { now += ms; }, restore: () => Object.defineProperty(performance, 'now', { value: real, configurable: true, writable: true }) };
}

test('a long view comes in slices, newest first, each bar asked for once; then only the bars that can still change, every refresh', async () => {
  const time = clock(1_000_000);
  try {
    const { asked, answered, load } = source(5), data = new FootprintData(), view = { t0: 10 * H, t1: 20 * H, p0: 0, p1: 1 };
    const sourceNow = 20 * H + 30 * 60_000;
    const step = async () => { data.ensure('a,b', '1h', view, 5, load, () => {}, [], sourceNow); await turn(); };
    await step();
    assert.deepEqual(asked[0], { from: 9 * H, to: 21 * H, budget: 5_000 }, 'the whole view with its margin, within the budget');
    assert.deepEqual([...data.bars.keys()], [16, 17, 18, 19, 20].map(h => h * H), 'the newest part first');
    await step(); await step(); await step();
    assert.deepEqual(asked.slice(1).map(a => [a.from / H, a.to / H]), [[9, 16], [9, 11]], 'then older slices until the view is covered, and nothing more');
    assert.deepEqual([...data.bars.keys()].map(t => t / H), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    assert.equal(new Set(answered).size, answered.length, 'no bar is merged twice: each slice starts where the last one reached');

    time.advance(FOOTPRINT_REFRESH_MS);
    await step();
    assert.deepEqual([asked.at(-1)!.from / H, asked.at(-1)!.to / H], [20, 21], 'the refresh asks for the open bar alone: the ones before it are settled');
    assert.equal(data.bars.size, 12);
    await step();
    assert.equal(asked.length, 4, 'and not again before the next refresh');

    // A view wholly in the past asks nothing on the clock once it is held.
    const past = { t0: 2 * H, t1: 6 * H, p0: 0, p1: 1 }, before = asked.length;
    for (let i = 0; i < 3; i++) { data.ensure('a,b', '1h', past, 5, load, () => {}, [], sourceNow); await turn(); }
    time.advance(FOOTPRINT_REFRESH_MS * 3);
    data.ensure('a,b', '1h', past, 5, load, () => {}, [], sourceNow); await turn();
    assert.deepEqual(asked.slice(before).map(a => [a.from / H, a.to / H]), [[1, 7], [1, 2]], 'its bars in two slices, then nothing');
  } finally { time.restore(); }
});

test('before the markets\' step is known it is asked alone, and the view is then asked on the drawn rows, never on the finest', async () => {
  const asked: { from: number; to: number; rows: number; cuts: number; budget: number; venues: boolean }[] = [];
  const load = async (_i: string, _tf: string, from: number, to: number, rows: number, cuts: readonly number[], budget: number, venues: boolean): Promise<FootprintResponse> => {
    asked.push({ from, to, rows, cuts: cuts.length, budget, venues });
    const bars = []; for (let t = Math.ceil(from / H) * H; t + H <= to; t += H) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60 });
    return { step: rows > 0 ? rows : 0.5, fine: 0.5, bars };
  };
  // As the heat pane does: the row size from the step known before the look (rows 128 times the recorded step at this zoom).
  const data = new FootprintData(), view = { t0: 10 * H, t1: 12 * H, p0: 0, p1: 1 };
  const look = async (tf = '1h') => { data.ensure('a,b', tf, view, data.fine > 0 ? data.fine * 128 : 0, load, () => {}, [100_000], 20 * H); await turn(); };
  await look();
  assert.deepEqual(asked, [{ from: 0, to: 1, rows: 0, cuts: 0, budget: 0, venues: false }], 'the step first, from a window that holds nothing');
  assert.equal(data.fine, 0.5);
  assert.equal(data.bars.size, 0, 'and no bars from it');
  await look();
  assert.deepEqual(asked.slice(1).map(a => [a.from / H, a.to / H, a.rows, a.venues]), [[9, 13, 64, true]], 'then the view once, on the rows drawn');
  assert.deepEqual([...data.bars.keys()].map(t => t / H), [9, 10, 11, 12]);
  await look('4h');
  assert.deepEqual(asked.slice(2).map(a => a.rows), [64], 'another timeframe of the same markets is asked on the rows at once');

  // Markets with nothing recorded have no step: asked it once, then as before (an empty answer), and not again on every look.
  const none: number[][] = [];
  const empty = async (_i: string, _tf: string, from: number, to: number, rows: number): Promise<FootprintResponse> => { none.push([from, to, rows]); return { step: 0, fine: 0, bars: [] }; };
  const fresh = new FootprintData();
  for (let i = 0; i < 4; i++) { fresh.ensure('c', '1h', view, 0, empty, () => {}, [], 20 * H); await turn(); }
  assert.deepEqual(none, [[0, 1, 0], [9 * H, 13 * H, 0]]);
});

test('another row size asks again from the view, and an old source that answers the whole window is taken whole', async () => {
  const asked: number[][] = [];
  const whole = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
    asked.push([from / H, to / H]);
    const bars = []; for (let t = from; t < to; t += H) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60 });
    return { step: 5, fine: 5, bars };
  };
  const data = new FootprintData(), view = { t0: 10 * H, t1: 12 * H, p0: 0, p1: 1 };
  data.ensure('a', '1h', view, 5, whole, () => {}, [], 0); await turn();
  data.ensure('a', '1h', view, 5, whole, () => {}, [], 0); await turn();
  assert.deepEqual(asked, [[9, 13]], 'no `from` in the answer: the whole window was answered');
  data.ensure('a', '1h', view, 10, whole, () => {}, [], 0); await turn();
  assert.deepEqual(asked.at(-1), [9, 13]);
  assert.equal(asked.length, 2);
});

test('a view with more bars than are held for long is not asked for again on every look, and panning right through the past asks from the held end', async () => {
  const time = clock(5_000_000);
  try {
    const M = 60_000, asked: number[][] = [];
    const load = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
      asked.push([from, to]);
      const bars = []; for (let t = from; t < to; t += M) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 1 });
      return { step: 5, fine: 5, bars };
    };
    const data = new FootprintData(), wide = { t0: 0, t1: 4_000 * M, p0: 0, p1: 1 };
    for (let i = 0; i < 4; i++) { data.ensure('a', '1m', wide, 5, load, () => {}, [], 10 * 86_400_000); await turn(); }
    assert.equal(asked.length, 1, 'more than 3 000 bars in view, all past: one question, then none');
    assert.equal(data.bars.size, 4_002);

    // Hourly bars held for [9h, 13h) with the source at 30h; the view moves to [12h, 15h).
    const hourly: number[][] = [];
    const loadH = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
      hourly.push([from / H, to / H]);
      const bars = []; for (let t = from; t < to; t += H) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60 });
      return { step: 5, fine: 5, bars };
    };
    const past = new FootprintData();
    past.ensure('a', '1h', { t0: 10 * H, t1: 12 * H, p0: 0, p1: 1 }, 5, loadH, () => {}, [], 30 * H); await turn();
    past.ensure('a', '1h', { t0: 12 * H, t1: 14 * H, p0: 0, p1: 1 }, 5, loadH, () => {}, [], 30 * H); await turn();
    assert.deepEqual(hourly, [[9, 13], [13, 15]], 'the bars after the held ones, not from the settled time far beyond them');
    assert.deepEqual([...past.bars.keys()].map(t => t / H), [9, 10, 11, 12, 13, 14]);

    past.clear();
    assert.equal(past.bars.size, 0, 'no markets to count: no bars');
  } finally { time.restore(); }
});

test('venue rows read as ids whatever each answer\'s order, a malformed one is left out whole, and the order follows the volume held', () => {
  const row = [[100, 30, 5], [105, 2, 9]] as [number, number, number][];
  const a = readBar({ t: 0, rows: row, buyUsd: 32, sellUsd: 14, venueRows: [[0, 20, 5, 1, 10, 0], [1, 2, 9]] }, 0, ['binance:BTCUSDT', 'bybit:BTCUSDT']);
  const b = readBar({ t: H, rows: row, buyUsd: 32, sellUsd: 14, venueRows: [[1, 20, 5, 0, 10, 0], [0, 2, 9]] }, 0, ['okx:BTC-USDT-SWAP', 'binance:BTCUSDT']);
  assert.deepEqual(a.parts, [[['binance:BTCUSDT', 20, 5], ['bybit:BTCUSDT', 10, 0]], [['bybit:BTCUSDT', 2, 9]]]);
  assert.deepEqual(b.parts?.[0]?.[0], ['binance:BTCUSDT', 20, 5], 'the place in its own answer\'s list');
  assert.equal('venueRows' in a, false, 'held as ids only');
  for (const bad of [[[5, 1, 1], []], [[0, 1], []], [[0, -1, 1], []], [[0, 1, 1]]])
    assert.equal(readBar({ t: 0, rows: row, buyUsd: 0, sellUsd: 0, venueRows: bad as number[][] }, 0, ['binance:BTCUSDT']).parts, undefined, JSON.stringify(bad));
  assert.deepEqual(venueOrderOf([a, b]), ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP']);
});

test('a row\'s popup names its venues, the most volume first, with what each sold, bought and its delta', () => {
  const bar = readBar({ t: 0, rows: [[100, 31, 15]], buyUsd: 31, sellUsd: 15, venueRows: [[0, 20e3, 5e3, 1, 10e3, 0, 2, 1e3, 10e3]] }, 0, ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP']);
  const cell = rowCellAt(bar, 5, 102)!;
  const lines = rowCellLines(cell, bar, 5, '1h', undefined, 3).filter(l => l.mark);
  assert.deepEqual(lines.map(l => l.mark), ['binance:BTCUSDT', 'okx:BTC-USDT-SWAP', 'bybit:BTCUSDT']);
  assert.deepEqual(lines.map(l => l.color), ['buy', 'sell', 'buy']);
});

test('a row only one market traded still says whose it is, and a short pane names fewer venues and puts the rest together', () => {
  const one = readBar({ t: 0, rows: [[100, 5e3, 0]], buyUsd: 5e3, sellUsd: 0, venueRows: [[0, 5e3, 0]] }, 0, ['bybit:BTCUSDT']);
  assert.deepEqual(rowCellLines(rowCellAt(one, 5, 101)!, one, 5, '1h', undefined, 3).filter(l => l.mark).map(l => l.mark), ['bybit:BTCUSDT']);
  const many = readBar({ t: 0, rows: [[100, 30e3, 6e3]], buyUsd: 30e3, sellUsd: 6e3, venueRows: [[0, 10e3, 1e3, 1, 9e3, 2e3, 2, 8e3, 3e3, 3, 3e3, 0]] }, 0, ['a:X', 'b:X', 'c:X', 'd:X']);
  const short = rowCellLines(rowCellAt(many, 5, 101)!, many, 5, '1h', undefined, 4, 1);
  assert.deepEqual(short.filter(l => l.mark).map(l => l.mark), ['a:X']);
  assert.ok(short.some(l => l.label === '3 more venues'), 'the rest together');
  const none = rowCellLines(rowCellAt(many, 5, 101)!, many, 5, '1h', undefined, 4, -1);
  assert.equal(none.length, rowCellLines({ ...rowCellAt(many, 5, 101)!, parts: undefined }, many, 5, '1h', undefined, 4).length, 'too short even for that: the box as it was before venues');
});

test('settled bars still without the sums of the size lines asked are asked again once a minute, a few times, until the sums come', async () => {
  const time = clock(5_000_000);
  try {
    let filled = false;
    const asked: { from: number; to: number }[] = [];
    const load = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
      asked.push({ from, to });
      const bars = [];
      for (let t = Math.floor(from / H) * H; t < to; t += H) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60, stats: { buyN: 1, sellN: 1, buy: [0, 0, 0, 0, 0, 0, 0, 0], sell: [0, 0, 0, 0, 0, 0, 0, 0] }, ...(filled ? { over: [5, 6] } : {}) });
      return { step: 5, fine: 5, bars: bars as never, from };
    };
    const data = new FootprintData(), view = { t0: 10 * H, t1: 14 * H, p0: 0, p1: 1 }, sourceNow = 14 * H + 30 * 60_000;
    const step = async () => { data.ensure('a', '1h', view, 5, load as never, () => {}, [50_000], sourceNow); await turn(); };
    await step();
    assert.ok([...data.bars.values()].every(b => !b.over), 'the server has not filled in the lists yet');
    const before = asked.length;
    time.advance(FOOTPRINT_REFRESH_MS); await step();
    assert.ok(asked.slice(before).every(a => a.from >= 14 * H), 'within the minute only the bars that can still change');
    filled = true; time.advance(60_000); await step(); await step();
    assert.ok(asked.some(a => a.from <= 10 * H && a.to <= 14 * H), 'the settled bars asked again');
    assert.ok([...data.bars.values()].filter(b => b.t < 14 * H).every(b => b.over?.[0] === 5), 'and now with their sums');
  } finally { time.restore(); }
});

test('a size-sum retry that comes back in slices goes on through the older slices', async () => {
  const time = clock(9_000_000);
  try {
    let filled = false;
    const asked: { from: number; to: number }[] = [];
    // Answers at most three bars, newest first, and says where it starts.
    const load = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
      asked.push({ from, to });
      const bars = [];
      for (let t = Math.floor((to - 1) / H) * H; t >= from && bars.length < 3; t -= H) bars.unshift({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60, stats: { buyN: 1, sellN: 1, buy: [0, 0, 0, 0, 0, 0, 0, 0], sell: [0, 0, 0, 0, 0, 0, 0, 0] }, ...(filled ? { over: [5, 6] } : {}) });
      return { step: 5, fine: 5, bars: bars as never, from: bars.length ? bars[0]!.t : from };
    };
    const data = new FootprintData(), view = { t0: 10 * H, t1: 18 * H, p0: 0, p1: 1 }, sourceNow = 18 * H + 30 * 60_000;
    const step = async () => { data.ensure('a', '1h', view, 5, load as never, () => {}, [50_000], sourceNow); await turn(); };
    for (let i = 0; i < 6; i++) await step();
    filled = true; time.advance(60_000);
    for (let i = 0; i < 6; i++) await step();
    assert.ok([...data.bars.values()].filter(b => b.t < 18 * H).every(b => b.over?.[0] === 5), 'every settled bar has its sums, not only the newest slice');
  } finally { time.restore(); }
});

test('every few minutes the refresh reaches back an hour into the settled bars, for trades a venue sent late', async () => {
  const time = clock(20_000_000);
  try {
    const { asked, load } = source(50), data = new FootprintData(), view = { t0: 0, t1: 10 * H, p0: 0, p1: 1 };
    const sourceNow = 10 * H + 30 * 60_000;
    const step = async () => { data.ensure('a', '1h', view, 5, load, () => {}, [], sourceNow); await turn(); };
    await step();
    time.advance(FOOTPRINT_REFRESH_MS); await step();
    assert.equal(asked.at(-1)!.from, 10 * H, 'a refresh: the open bar');
    time.advance(5 * 60_000); await step();
    assert.equal(asked.at(-1)!.from, 9 * H, 'five minutes on: the hour before it too');
    time.advance(FOOTPRINT_REFRESH_MS); await step();
    assert.equal(asked.at(-1)!.from, 10 * H);
  } finally { time.restore(); }
});

test('a view a little behind the live edge, with no bar still under way, is rechecked for late trades too', async () => {
  const time = clock(20_000_000);
  try {
    const { asked, load } = source(50), data = new FootprintData(), view = { t0: 0, t1: 8.5 * H, p0: 0, p1: 1 };
    const sourceNow = 10 * H + 30 * 60_000;
    const step = async () => { data.ensure('a', '1h', view, 5, load, () => {}, [], sourceNow); await turn(); };
    await step();
    const first = asked.length;
    time.advance(FOOTPRINT_REFRESH_MS); await step();
    assert.equal(asked.length, first, 'every bar of the view is settled: nothing to refresh');
    time.advance(5 * 60_000); await step();
    assert.deepEqual([asked.at(-1)!.from, asked.at(-1)!.to], [9 * H, 10 * H], 'five minutes on: the last hour of settled bars');
  } finally { time.restore(); }
});

test('on bars longer than the hour, the late-trade recheck starts on a bar\x27s own start', async () => {
  const time = clock(20_000_000);
  try {
    const { asked, load } = source(50), data = new FootprintData(), view = { t0: 0, t1: 10 * H, p0: 0, p1: 1 };
    const sourceNow = 10 * H + 30 * 60_000;
    const step = async () => { data.ensure('a', '4h', view, 5, load, () => {}, [], sourceNow); await turn(); };
    await step();
    time.advance(5 * 60_000); await step();
    // The bar under way starts at 8 h; an hour before it is inside the bar from 4 h, which is asked whole.
    assert.equal(asked.at(-1)!.from, 4 * H);
  } finally { time.restore(); }
});
