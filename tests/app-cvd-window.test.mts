import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_WINDOW_MS, flowWindow } from '../src/app/cvd/window.ts';
import { priceFlowId } from '../src/app/cvd/ids.ts';

const HOUR = 3_600_000, NOW = 1_800_000_000_000;

test('the Map span ends at now (the map runs on past it) and starts where the flow does when that is later', () => {
  // a map of 53 hours that runs 8% past now, over 13 minutes of recorded flow
  const span = 53 * HOUR, mapT1 = NOW + span * 0.08, mapT0 = mapT1 - span, earliest = NOW - 13 * 60_000;
  const w = flowWindow({ span: 'map', mapT0, mapT1, now: NOW, earliest });
  assert.equal(w.t1, NOW, 'no future');
  assert.equal(w.t0, Math.floor(earliest / 1000) * 1000, 'trimmed to the recording');
  assert.equal(w.since, earliest, 'and it says so');
});

test('the Map span is the map when the flow covers it, and a map scrolled into the past is left alone', () => {
  const covered = flowWindow({ span: 'map', mapT0: NOW - 4 * HOUR, mapT1: NOW + 20 * 60_000, now: NOW, earliest: NOW - 20 * HOUR });
  assert.deepEqual(covered, { t0: NOW - 4 * HOUR, t1: NOW, since: null });
  const past = flowWindow({ span: 'map', mapT0: NOW - 6 * HOUR, mapT1: NOW - 5 * HOUR, now: NOW, earliest: NOW - 20 * HOUR });
  assert.deepEqual(past, { t0: NOW - 6 * HOUR, t1: NOW - 5 * HOUR, since: null });
  const before = flowWindow({ span: 'map', mapT0: NOW - 9 * HOUR, mapT1: NOW - 8 * HOUR, now: NOW, earliest: NOW - 20 * 60_000 });
  assert.deepEqual(before, { t0: NOW - 9 * HOUR, t1: NOW - 8 * HOUR, since: null }, 'a window wholly before the recording is not moved');
  assert.deepEqual(flowWindow({ span: 'map', mapT0: NOW - HOUR, mapT1: NOW, now: NOW, earliest: Infinity }), { t0: NOW - HOUR, t1: NOW, since: null }, 'no flow yet: nothing to trim to');
});

test('a trimmed window is never shorter than the column can draw, and a late start by a hair is not worth a note', () => {
  const young = flowWindow({ span: 'map', mapT0: NOW - 5 * HOUR, mapT1: NOW, now: NOW, earliest: NOW - 5_000 });
  assert.equal(young.t1 - young.t0, MIN_WINDOW_MS); assert.equal(young.t1, NOW);
  const hair = flowWindow({ span: 'map', mapT0: NOW - HOUR, mapT1: NOW, now: NOW, earliest: NOW - HOUR + 30_000 });
  assert.equal(hair.since, null, 'a few seconds of a hour');
  assert.equal(hair.t0, Math.floor((NOW - HOUR + 30_000) / 1000) * 1000);
});

test('a span chosen by hand keeps its length, ends now, and says when recording began if that was inside it', () => {
  const day = flowWindow({ span: '24h', mapT0: 0, mapT1: 1, now: NOW, earliest: NOW - 13 * 60_000 });
  assert.deepEqual(day, { t0: NOW - 24 * HOUR, t1: NOW, since: NOW - 13 * 60_000 });
  assert.equal(flowWindow({ span: '1h', mapT0: 0, mapT1: 1, now: NOW, earliest: NOW - 3 * HOUR }).since, null, 'recorded all of it');
  assert.equal(flowWindow({ span: '5m', mapT0: 0, mapT1: 1, now: NOW, earliest: Infinity }).since, null);
  assert.equal(flowWindow({ span: '5m', mapT0: 0, mapT1: 1, now: NOW, earliest: NOW + 1 }).since, null, 'flow from the future is nobody\'s news');
});

test('the price comes from the market on screen, or its spot twin under the flow feeds\' name, or from nothing', () => {
  const has = (...ids: string[]) => (id: string) => ids.includes(id);
  assert.equal(priceFlowId(['hyperliquid:BTC-PERP', 'x'], has('hyperliquid:BTC-PERP')), 'hyperliquid:BTC-PERP');
  assert.equal(priceFlowId(['binance:BTCUSDT:spot'], has('binancespot:BTCUSDT')), 'binancespot:BTCUSDT');
  assert.equal(priceFlowId(['binance:BTCUSDT:spot'], has('binance:BTCUSDT:spot', 'binancespot:BTCUSDT')), 'binance:BTCUSDT:spot', 'its own flow first');
  assert.equal(priceFlowId(['', 'okx:BTC-USDT-SWAP'], has('okx:BTC-USDT-SWAP')), 'okx:BTC-USDT-SWAP', 'the next candidate when the first is empty');
  assert.equal(priceFlowId(['mexc:BTC_USDT'], has('hyperliquid:BTC-PERP')), null);
  assert.equal(priceFlowId([], has()), null);
});
