import test from 'node:test';
import assert from 'node:assert/strict';
import { NlnsSource } from '../src/app/delta/nlns-source.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { initialState, type AppState, type OiBar } from '../src/app/store.ts';
import { markHour, reachSpan } from '../src/app/panes/funding-pane.ts';

// The Funding pane's share of new positions buyers opened, hour by hour on Hyperliquid (NlnsSource.hourly), and the dotted mark where it can
// begin (Karl, 2026-11-11: the bars stopped a day back on a chart days wide; on a server they reach a week, the flow minutes it stores).

(globalThis as { Worker?: unknown }).Worker = class { onmessage: unknown = null; postMessage(): void {} };
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Math.floor(1_794_400_000_000 / HOUR) * HOUR + 17 * MIN;
const HL = 'hyperliquid:BTC-PERP', BIN = 'binance:BTCUSDT';

/** A page holding a day of flow a second at a time and a week of minutes before it, and minute readings over `held` for each market. */
function build(kind: 'server' | 'browser', held: Record<string, number>) {
  let seed = 7; const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const ids = Object.keys(held), book = new FlowBook();
  const secFrom = Math.floor((NOW - DAY) / MIN) * MIN, secN = (Math.ceil((NOW + MIN) / MIN) * MIN - secFrom) / 1000;
  book.begin(ids);
  book.load({ from: secFrom, to: NOW + MIN, instruments: ids.map(id => {
    const buy = new Float32Array(secN), sell = new Float32Array(secN), px = new Float32Array(secN);
    for (let i = 0; i < secN; i++) { buy[i] = rnd() * 50_000; sell[i] = rnd() * 50_000; px[i] = 90_000; }
    return { id, t0: secFrom, buy, sell, px };
  }) }, ids, secFrom);
  const mFrom = Math.floor((NOW - 8 * DAY) / (6 * HOUR)) * 6 * HOUR, mTo = Math.ceil((secFrom + 120_000) / HOUR) * HOUR, mN = (mTo - mFrom) / MIN;
  book.loadMinutes({ from: mFrom, to: mTo, instruments: ids.map(id => {
    const buy = new Float32Array(mN), sell = new Float32Array(mN), px = new Float32Array(mN), lo = new Float32Array(mN), hi = new Float32Array(mN);
    for (let i = 0; i < mN; i++) { buy[i] = rnd() * 2_000_000; sell[i] = rnd() * 2_000_000; px[i] = 90_000; lo[i] = -1e5; hi[i] = 1e5; }
    return { id, t0: mFrom, buy, sell, px, lo, hi };
  }) }, ids, mFrom, mTo);
  const hub = { flow: book, source: { kind }, ensureFlow: async () => {}, ensureFlowMinutes: async () => {} };
  const oiFine = ids.map(id => {
    const bars: OiBar[] = []; let v = 50_000;
    for (let t = Math.ceil((NOW - held[id]!) / MIN) * MIN; t <= NOW; t += MIN) { v += (rnd() - 0.5) * 40; bars.push([t, v, v, v, v]); }
    return { id, bars };
  });
  const tf = 900_000;
  const oiParts = oiFine.map(p => { const m = new Map<number, OiBar>(); for (const b of p.bars) { const k = Math.floor(b[0] / tf) * tf; m.set(k, [k, b[1], b[1], b[1], b[4]]); } return { id: p.id, bars: [...m.values()] }; });
  const state: AppState = { ...initialState(), timeframe: '15m', oiParts, oi: oiParts[0]!.bars, oiInstrument: '', oiFine, marketId: BIN, seriesInstrument: BIN };
  return { source: new NlnsSource(hub as never), state };
}

test('the mark is at the first bar, where that is later than the first two hours of the view', () => {
  const view = NOW - 10 * DAY, edge = Math.floor(view / HOUR) * HOUR;
  assert.equal(markHour(NOW - 7 * DAY + 40 * MIN, view), NOW - 7 * DAY + 40 * MIN, 'the bars begin inside the view: marked');
  assert.equal(markHour(undefined, view), null, 'no bars, no mark (the pane says why instead)');
  assert.equal(markHour(edge, view), null, 'the view starts inside what is held: the first bar is at its edge');
  assert.equal(markHour(edge + HOUR, view), null, 'or one hour in, its first hour wanting flow');
  assert.equal(markHour(edge + 2 * HOUR, view), edge + 2 * HOUR);
});

test('the mark says how far back it is: hours rounded up below two days, else days', () => {
  assert.deepEqual(reachSpan(7 * DAY - 40 * MIN), { n: 7, days: true });
  assert.deepEqual(reachSpan(DAY - 40 * MIN), { n: 24, days: false });
  assert.deepEqual(reachSpan(DAY + 30_000), { n: 24, days: false }, 'a day in the first minute of an hour is not 25 hours');
  assert.deepEqual(reachSpan(30 * MIN), { n: 1, days: false });
  assert.deepEqual(reachSpan(2 * HOUR + 30 * MIN), { n: 3, days: false });
  assert.deepEqual(reachSpan(47 * HOUR + 30 * MIN), { n: 2, days: true });
  assert.deepEqual(reachSpan(0), { n: 1, days: false });
});

test('on a server the share reaches a week back, in a page a day, and the mark sits at its first hour', () => {
  for (const [kind, reach] of [['server', 7 * DAY], ['browser', DAY]] as const) {
    const { source, state } = build(kind, { [HL]: 7 * DAY });
    assert.equal(source.fineReach, reach);
    const hours = source.hourly(state, HL, NOW - 10 * DAY, NOW);
    assert.ok(hours.length > 0, kind);
    const from = hours[0]!.t;
    assert.ok(NOW - from > reach - 2 * HOUR && NOW - from <= reach, `${kind}: ${((NOW - from) / HOUR).toFixed(1)} h back`);
    assert.equal(markHour(from, NOW - 10 * DAY), from, `${kind}: marked where the bars begin`);
    // Less held than the reach (a server that started recording two days ago): the bars, and the mark, begin where what is held lets them.
    const short = build(kind, { [HL]: 2 * DAY + 30 * MIN });
    const first = short.source.hourly(short.state, HL, NOW - 10 * DAY, NOW)[0]!.t;
    // The hour after the first reading held where that is inside the reach (a server's week), else after the reach's edge (a page's day).
    const begins = Math.max(Math.ceil((NOW - 2 * DAY - 30 * MIN) / MIN) * MIN, Math.floor((NOW - reach) / MIN) * MIN - MIN);
    assert.equal(first, Math.floor(begins / HOUR) * HOUR + HOUR, `${kind}: the hour after the first reading held, or after the reach`);
    if (kind === 'server') assert.ok(NOW - first < 2 * DAY + 30 * MIN && NOW - first > 2 * DAY - HOUR, 'server: what is held decides');
  }
});

test('the OI and Delta panes keep their day: a week of Hyperliquid minutes held changes nothing in their model', () => {
  // The store holds a week of the Funding pane's market on a server; the model works on its last day, as it did when that was all held.
  const week = build('server', { [BIN]: DAY, [HL]: 7 * DAY }), day = build('server', { [BIN]: DAY, [HL]: 7 * DAY });
  const cut = Math.floor((NOW - DAY) / MIN) * MIN - MIN;
  day.state.oiFine = day.state.oiFine.map(part => ({ ...part, bars: part.bars.filter(b => b[0] >= cut) }));
  assert.ok(week.state.oiFine.find(p => p.id === HL)!.bars.length > 6 * 24 * 60, 'a week held');
  const starts = week.source.starts(week.state, NOW - 3 * DAY, NOW + HOUR, NOW, 'none');
  const a = week.source.model(week.state, starts, NOW, 'none'), b = day.source.model(day.state, starts, NOW, 'none');
  assert.ok(a.some(c => c.fine > 0), 'some candles are worked out minute by minute');
  assert.deepEqual(a, b);
});
