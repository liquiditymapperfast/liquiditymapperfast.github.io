import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameWindow, LATE_FACTOR, REFRESH_RATES, hitchOf, nextLevel, refreshOf, toneOf } from '../src/app/fps/model.ts';
import { SEGMENTS, segmentShape, BAR_TONES } from '../src/app/fps/led.ts';
import { speedReport, type SpeedInfo } from '../src/app/fps/report.ts';

// The status bar's frame-rate meter (2026-11-14): its arithmetic, its digits and its report for an AI assistant.

test('the screen\'s rate is read from the fastest frames, snapped to a common rate, never under 60', () => {
  assert.equal(refreshOf([]), 60, 'nothing seen yet');
  assert.equal(refreshOf(Array(10).fill(16.7)), 60);
  assert.equal(refreshOf([6.9, 6.95, 7, 6.94, 6.93, 7.01, 6.92, 6.96, 6.97, 6.99]), 144);
  assert.equal(refreshOf(Array(10).fill(8.33)), 120);
  assert.equal(refreshOf(Array(10).fill(4.17)), 240);
  // A page held at 30 frames a second is not a 30 Hz screen: it reads as 60, so 30 frames show red, not green.
  assert.equal(refreshOf(Array(10).fill(33.3)), 60);
  assert.equal(toneOf(30, refreshOf(Array(10).fill(33.3))), 'red');
  // A stray short interval (timer jitter) does not move the median of ten.
  assert.equal(refreshOf([2.5, 16.6, 16.7, 16.7, 16.6, 16.7, 16.8, 16.7, 16.6, 16.7]), 60);
  assert.deepEqual([...REFRESH_RATES].sort((a, b) => a - b), [...REFRESH_RATES], 'in order');
});

test('the colour is the frame rate against the screen: green from 90 %, amber from 60 %, red under', () => {
  assert.equal(toneOf(60, 60), 'green');
  assert.equal(toneOf(54, 60), 'green');
  assert.equal(toneOf(53, 60), 'amber');
  assert.equal(toneOf(36, 60), 'amber');
  assert.equal(toneOf(35, 60), 'red');
  assert.equal(toneOf(130, 144), 'green');
  assert.equal(toneOf(100, 144), 'amber', 'on a 144 Hz screen 100 is not smooth');
  assert.equal(toneOf(60, 144), 'red');
});

test('the bar: a frame on time lights nothing, one frame late a third, four frames\' time or more all of it; it falls back slowly', () => {
  assert.equal(hitchOf(1000 / 60, 60), 0);
  assert.ok(Math.round(hitchOf(16.9, 60) * 10) === 0, 'a frame a hair over its time lights no cell');
  assert.ok(Math.abs(hitchOf(1000 / 30, 60) - 1 / 3) < 1e-9);
  assert.equal(hitchOf(200, 60), 1);
  assert.equal(nextLevel(0, 0.5), 0.5, 'a hitch is shown at once');
  assert.ok(Math.abs(nextLevel(0.5, 0) - 0.35) < 1e-9, 'and falls back by 30 % a quarter second');
  assert.equal(nextLevel(0.2, 0.9), 0.9);
});

test('the window counts the last second\'s frames, the late ones of the last minute, and starts afresh after a gap', () => {
  const w = new FrameWindow();
  let now = 1000;
  w.restart(now);
  for (let i = 0; i < 120; i++) { now += 1000 / 60; w.push(now, 1000 / 60); }
  let s = w.stats(now);
  assert.equal(s.hz, 60);
  assert.ok(s.fps! >= 59 && s.fps! <= 61, `fps ${s.fps}`);
  assert.ok(s.fpsMinute! >= 59 && s.fpsMinute! <= 61, `minute ${s.fpsMinute}`);
  assert.equal(s.lateMinute, 0);
  // One frame of 100 ms, then on time again: one late frame, the quarter's worst while it is in the last quarter second.
  now += 100; w.push(now, 100);
  s = w.stats(now);
  assert.equal(s.lateMinute, 1); assert.equal(s.worstQuarter, 100); assert.equal(s.worstMinute, 100);
  for (let i = 0; i < 30; i++) { now += 1000 / 60; w.push(now, 1000 / 60); }
  s = w.stats(now);
  assert.ok(s.worstQuarter < 20, 'out of the last quarter second'); assert.equal(s.worstMinute, 100, 'still in the minute');
  assert.ok((1000 / 60) * LATE_FACTOR < 100);
  // A hidden tab: the clock starts afresh, the gap is not a frame, and no rate is said for the first second.
  now += 30_000; w.restart(now);
  s = w.stats(now);
  assert.equal(s.fps, null); assert.equal(s.lateMinute, 0); assert.equal(s.hz, 60, 'the screen\'s rate is kept');
  // Another screen: its rate is learned again.
  for (let i = 0; i < 70; i++) { now += 1000 / 144; w.push(now, 1000 / 144); }
  assert.equal(w.stats(now).hz, 144);
  w.restart(now, true);
  for (let i = 0; i < 70; i++) { now += 1000 / 60; w.push(now, 1000 / 60); }
  assert.equal(w.stats(now).hz, 60, 'moved to a 60 Hz screen');
  // Bounded: a minute at 240 Hz and more keeps only the last minute.
  const big = new FrameWindow(); let t = 0; big.restart(t);
  for (let i = 0; i < 240 * 90; i++) { t += 1000 / 240; big.push(t, 1000 / 240); }
  const bs = big.stats(t);
  assert.ok(bs.fps! >= 239 && bs.fps! <= 241, `fps ${bs.fps}`); assert.equal(bs.hz, 240);
});

test('every character the meter shows lights real segments, each a closed six-point shape inside its cell', () => {
  for (const [ch, segs] of Object.entries(SEGMENTS)) {
    for (const s of segs) {
      assert.ok('abcdefg'.includes(s), `${ch}: ${s}`);
      const pts = segmentShape(s);
      assert.equal(pts.length, 6, `${ch}: ${s}`);
      for (const [x, y] of pts) assert.ok(x >= 0 && x <= 10 && y >= 0 && y <= 14, `${ch}: ${s} at ${x},${y}`);
    }
  }
  assert.equal(SEGMENTS['8'], 'abcdefg');
  assert.equal(SEGMENTS['-'], 'g', 'the dashes shown while measuring');
  assert.deepEqual(BAR_TONES.slice(0, 6), Array(6).fill('green'));
  assert.equal(BAR_TONES.length, 10); assert.equal(BAR_TONES[9], 'red');
});

const info = (over: Partial<SpeedInfo> = {}): SpeedInfo => ({
  stats: { fps: 41, fpsMinute: 44, hz: 144, worstQuarter: 30, worstMinute: 233, lateMinute: 37, seenSeconds: 60 },
  graphics: 'webgl2', gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142',
  screen: { w: 3840, h: 2160, ratio: 1.5 }, window: { w: 2560, h: 1313 }, cores: 16, memoryGb: 8, glass: true, panels: ['flow column', 'order book'], timeframe: '1h',
  url: 'https://liquiditymapper.com/', ...over,
});

test('the report for an AI assistant says what the page measured and what to check, most likely first, for this browser\'s state', () => {
  const r = speedReport(info());
  for (const want of ['41 frames a second in the last second, 44 on average over the last 60 s', 'about 144 Hz', 'Late frames in the last 60 s: 37', '233 ms', 'NVIDIA GeForce RTX 3080', 'Chrome/142', '3840 x 2160 at 1.5x', '16 processor threads', '8 GB', 'Waves) is on', 'flow column, order book', 'timeframe 1h', 'https://liquiditymapper.com/']) {
    assert.ok(r.includes(want), `says ${want}`);
  }
  // With WebGL2 drawing, the first thing to check is not graphics acceleration.
  const first = r.split('\n').find(l => l.startsWith('1. '))!;
  assert.match(first, /Energy saving/);
  assert.match(r, /switch Waves off/);
  // Without WebGL2, acceleration first, then the browser's graphics report, then the driver.
  const none = speedReport(info({ graphics: 'no-webgl2', glass: false }));
  assert.match(none.split('\n').find(l => l.startsWith('1. '))!, /Hardware \(graphics\) acceleration/);
  assert.match(none.split('\n').find(l => l.startsWith('2. '))!, /chrome:\/\/gpu/);
  assert.match(none.split('\n').find(l => l.startsWith('3. '))!, /graphics driver/);
  assert.match(none, /drawn on the processor/);
  assert.doesNotMatch(none, /switch Waves off/, 'no Glass advice where Glass is off');
  // Still measuring, no card named, nothing reported for cores or memory: the report says so plainly, with no empty parentheses.
  const bare = speedReport(info({ stats: { fps: null, fpsMinute: null, hz: 60, worstQuarter: 0, worstMinute: 0, lateMinute: 0, seenSeconds: 0.4 }, gpu: null, cores: null, memoryGb: null }));
  assert.match(bare, /still measuring/);
  assert.doesNotMatch(bare, /\(\)|undefined|null/);
});
