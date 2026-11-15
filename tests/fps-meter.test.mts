import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameWindow, JUDGE_AFTER_S, LATE_FACTOR, REFRESH_RATES, bandOf, hitchOf, nextLevel, refreshOf, toneOf, verdictOf, type FrameStats } from '../src/app/fps/model.ts';
import { SEGMENTS, segmentShape, BAR_TONES } from '../src/app/fps/led.ts';
import { LOCAL_COPY, pageAddress, speedReport, type SpeedInfo } from '../src/app/fps/report.ts';

// The status bar's frame-rate meter (2026-11-14): its arithmetic, its digits and its report for an AI assistant.

/** Frame times of a screen at `hz` for `seconds` (from `t0`), with timestamp noise of `sd` ms from a fixed seed, rounded to `round` ms. */
function beats(hz: number, seconds: number, { sd = 0, round = 0, t0 = 0, seed = 7 } = {}): number[] {
  let x = seed; const rnd = (): number => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const out: number[] = [];
  for (let i = 0, n = Math.floor(seconds * hz); i < n; i++) {
    let t = t0 + (i * 1000) / hz;
    if (sd) t += Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd()) * sd;
    if (round) t = Math.round(t / round) * round;
    out.push(t);
  }
  return out.sort((a, b) => a - b);
}
/** Feed frame times to a window (a new one unless given) and read it at the last. */
function feed(times: readonly number[], w = new FrameWindow()): { w: FrameWindow; end: number } {
  let prev: number | null = null;
  for (const t of times) { if (prev !== null) w.push(t, t - prev); prev = t; }
  return { w, end: prev ?? 0 };
}
const hzOf = (times: readonly number[]): number => { const { w, end } = feed(times); return w.stats(end).hz; };

test('an interval counts for the nearest common rate within 8 %, and none when it is no screen\'s frame', () => {
  const at = (hz: number): number => REFRESH_RATES.indexOf(hz);
  assert.equal(bandOf(1000 / 60), at(60));
  assert.equal(bandOf(1000 / 48), at(48), '48 and 50 Hz are closer than 8 %: the nearest wins');
  assert.equal(bandOf(1000 / 50), at(50));
  assert.equal(bandOf(1000 / 144), at(144));
  assert.equal(bandOf(1000 / 480), at(480));
  assert.equal(bandOf(1000 / 540), at(540));
  assert.equal(bandOf(1000 / 170), at(165), 'a 170 Hz screen counts for 165');
  assert.equal(bandOf(1000 / 200), at(200));
  assert.equal(bandOf(1000 / 30), -1, 'no screen here runs at 30');
  assert.equal(bandOf(1.2), -1, 'two callbacks of one frame');
  assert.equal(bandOf(Number.NaN), -1);
  assert.deepEqual([...REFRESH_RATES].sort((a, b) => a - b), [...REFRESH_RATES], 'slowest first');
  // The fastest band holding a tenth wins; too few intervals, or none qualifying, keep the reading before.
  const counts = new Array(REFRESH_RATES.length).fill(0) as number[];
  counts[at(144)] = 12; counts[at(75)] = 88;
  assert.equal(refreshOf(counts, 100), 144, 'one interval in eight at 144 Hz: a 144 Hz screen with a busy page');
  counts[at(144)] = 9; counts[at(75)] = 91;
  assert.equal(refreshOf(counts, 100), 75);
  assert.equal(refreshOf(counts, 20, 120), 120, 'too few intervals yet');
  assert.equal(refreshOf(new Array(REFRESH_RATES.length).fill(0), 100, 90), 90, 'none qualifying');
  // Noise spills some of a fast screen's intervals into the next faster band, never more than stay in its own (review r18).
  const spill = new Array(REFRESH_RATES.length).fill(0) as number[];
  spill[at(165)] = 15; spill[at(144)] = 85;
  assert.equal(refreshOf(spill, 100), 144);
  // The rate already read stays while its band holds 6 %: a page near the threshold does not flip between two readings.
  const near = new Array(REFRESH_RATES.length).fill(0) as number[];
  near[at(144)] = 8; near[at(75)] = 92;
  assert.equal(refreshOf(near, 100, 144), 144, 'kept');
  assert.equal(refreshOf(near, 100, 60), 75, 'not read before: a tenth is needed');
  near[at(144)] = 5; near[at(75)] = 95;
  assert.equal(refreshOf(near, 100, 144), 75, 'under 6 %: given up');
});

test('the screen\'s rate is read from the last minute\'s frames: every common rate, through jitter and rounding, and a page held at 30 still reads red', () => {
  for (const hz of REFRESH_RATES) assert.equal(hzOf(beats(hz, 30)), hz, `${hz} Hz`);
  // The reviewer's failures of the fastest-frames rule (r17): early frames and timestamp noise drifted a long session to a faster rate.
  const early = beats(60, 600, { sd: 0.05 });
  for (let k = 1; k <= 30; k++) { const i = k * 1150; early[i] = early[i - 1]! + 5 + (k % 9); }
  assert.equal(hzOf(early.sort((a, b) => a - b)), 60, '60 Hz with three early frames a minute for ten minutes');
  assert.equal(hzOf(beats(60, 600, { sd: 0.5 })), 60, '60 Hz with 0.5 ms of noise');
  assert.equal(hzOf(beats(144, 300, { sd: 0.15 })), 144, '144 Hz with 0.15 ms of noise');
  assert.equal(hzOf(beats(144, 300, { sd: 0.3 })), 144, '144 Hz with 0.3 ms of noise (read 165 before review r18)');
  assert.equal(hzOf(beats(120, 300, { sd: 0.6 })), 120, '120 Hz with 0.6 ms of noise');
  assert.equal(hzOf(beats(240, 300, { sd: 0.5 })), 240, '240 Hz with 0.5 ms of noise');
  assert.equal(hzOf(beats(144, 60, { round: 1 })), 144, 'timestamps rounded to whole milliseconds');
  assert.equal(hzOf(beats(120, 60, { round: 1 })), 120);
  assert.equal(hzOf(beats(60, 60, { round: 1 })), 60);
  // A page held at 30 frames a second on a 60 Hz screen: no screen runs at 30, so the reading stays 60 and 30 frames show red.
  const { w, end } = feed(beats(30, 60));
  const s = w.stats(end);
  assert.equal(s.hz, 60); assert.equal(toneOf(s.fps!, s.hz), 'red');
  // A busy page on a 144 Hz screen, one or two beats a frame: the one-beat frames, a fifth of them, say 144.
  const busy: number[] = []; let t = 0;
  for (let i = 0; i < 6000; i++) { busy.push(t); t += (1000 / 144) * (i % 5 === 0 ? 1 : 2); }
  assert.equal(hzOf(busy), 144);
});

test('a slower rate on the same screen is learned within a minute; a faster one at once; a restart keeps the reading, another screen learns it again', () => {
  const fast = beats(144, 180), slow = beats(60, 90, { t0: fast[fast.length - 1]! + 1000 / 60 });
  const w = new FrameWindow(); let prev: number | null = null, learned: number | null = null;
  for (const t of [...fast, ...slow]) {
    if (prev !== null) w.push(t, t - prev);
    prev = t;
    if (learned === null && t > fast[fast.length - 1]! && w.stats(t).hz === 60) learned = (t - fast[fast.length - 1]!) / 1000;
  }
  assert.ok(learned !== null && learned <= 60, `144 to 60 Hz learned after ${learned} s (the fastest-frames rule never did)`);
  const { w: w2, end } = feed([...beats(60, 60), ...beats(144, 5, { t0: 60_000 })]);
  assert.equal(w2.stats(end).hz, 144, 'a faster rate within seconds');
  w2.restart(end + 5000);
  assert.equal(w2.stats(end + 5000).hz, 144, 'a hidden tab comes back: the screen is the same');
  w2.restart(end + 6000, true);
  assert.equal(w2.stats(end + 6000).hz, 60, 'another screen: 60 until its rate is seen');
});

test('the panel says nothing of the page until it has watched 20 s, then judges by what three seconds in four reached, never one second', () => {
  const s = (over: Partial<FrameStats>): FrameStats => ({ fps: 60, fpsMinute: 60, fpsMost: 60, hz: 60, worstQuarter: 17, worstMinute: 40, lateMinute: 0, seenSeconds: 60, ...over });
  assert.equal(verdictOf(null), 'measuring');
  assert.equal(verdictOf(s({ fps: null, fpsMinute: null, fpsMost: null, seenSeconds: 0.5 })), 'measuring');
  assert.equal(verdictOf(s({ seenSeconds: JUDGE_AFTER_S - 1 })), 'measuring', 'the first seconds load and build the pictures');
  assert.equal(verdictOf(s({})), 'smooth');
  assert.equal(verdictOf(s({ fps: 12 })), 'smooth', 'a red second in a smooth minute is a blink, not a slow page');
  assert.equal(verdictOf(s({ fpsMinute: 50 })), 'smooth', 'a stall drags the average down, not what three seconds in four reached');
  assert.equal(verdictOf(s({ fpsMost: 40 })), 'struggling');
  assert.equal(verdictOf(s({ fpsMost: 130, hz: 144 })), 'smooth');
  assert.equal(verdictOf(s({ fpsMost: 100, hz: 144 })), 'struggling');
  // On the window: an 8 s stall after 70 s of 60 Hz leaves three seconds in four at 60, smooth, though the minute's average is under 54 (amber).
  const before = beats(60, 70), after = beats(60, 30, { t0: before[before.length - 1]! + 8000 });
  const { w, end } = feed([...before, ...after]);
  const st = w.stats(end);
  assert.equal(st.fpsMost, 60); assert.ok(st.fpsMinute! < 54, `average ${st.fpsMinute}`); assert.equal(verdictOf(st), 'smooth');
  // A page slow a third of the time is struggling.
  const slow = feed([...beats(60, 40), ...beats(30, 20, { t0: 40_000 })]);
  assert.equal(verdictOf(slow.w.stats(slow.end)), 'struggling');
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
  assert.equal(s.fps, 60, 'a second of a 60 Hz screen holds 60 frames (the window is open at its far end)');
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
  stats: { fps: 41, fpsMinute: 44, fpsMost: 46, hz: 144, worstQuarter: 30, worstMinute: 233, lateMinute: 37, seenSeconds: 60 },
  graphics: 'webgl2', gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142',
  screen: { w: 3840, h: 2160, ratio: 1.5 }, window: { w: 2560, h: 1313 }, cores: 16, memoryGb: 8, glass: true, panels: ['flow column', 'order book'], timeframe: '1h',
  url: 'https://liquiditymapper.com/', ...over,
});

test('the report for an AI assistant says what the page measured and what to check, most likely first, for this browser\'s state', () => {
  const r = speedReport(info());
  for (const want of ['41 frames a second in the last second, 44 on average over the last 60 s, at least 46 in three seconds of four', 'about 144 Hz (read from the frames of the last minute)', 'Late frames in the last 60 s: 37', '233 ms', 'NVIDIA GeForce RTX 3080', 'Chrome/142', '3840 x 2160 CSS pixels at 1.5 device pixels each (about 5760 x 3240 device pixels)', 'inside is 2560 x 1313 CSS pixels', '16 processor threads', '8 GB', 'Waves) is on', 'flow column, order book', 'timeframe 1h', 'https://liquiditymapper.com/']) {
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
  // WebGL2 there but unable to draw: acceleration is on, so the driver comes first, then the browser's report; never the acceleration switch.
  const failed = speedReport(info({ graphics: 'failed' }));
  assert.match(failed.split('\n').find(l => l.startsWith('1. '))!, /graphics driver/);
  assert.match(failed.split('\n').find(l => l.startsWith('2. '))!, /chrome:\/\/gpu.*about:support/);
  assert.doesNotMatch(failed, /Hardware \(graphics\) acceleration/);
  // Shift+Esc is Windows' and Linux's; the zoom is not advice (a zoom over 100 % draws fewer pixels, review r17).
  assert.match(r, /Shift\+Esc on Windows and Linux/);
  assert.doesNotMatch(r, /zoom/i);
  // Still measuring, no card named, nothing reported for cores or memory: the report says so plainly, with no empty parentheses.
  const bare = speedReport(info({ stats: { fps: null, fpsMinute: null, fpsMost: null, hz: 60, worstQuarter: 0, worstMinute: 0, lateMinute: 0, seenSeconds: 0.4 }, gpu: null, cores: null, memoryGb: null }));
  assert.match(bare, /still measuring/);
  assert.doesNotMatch(bare, /\(\)|undefined|null/);
});

test('the report names the page\'s address only where it is the public site: a file, a local or private server is a copy', () => {
  assert.equal(pageAddress('liquiditymapper.com', 'https://liquiditymapper.com', '/'), 'https://liquiditymapper.com/');
  assert.equal(pageAddress('www.liquiditymapper.com', 'https://www.liquiditymapper.com', '/'), 'https://www.liquiditymapper.com/');
  assert.equal(pageAddress('liquiditymapperfast.github.io', 'https://liquiditymapperfast.github.io', '/'), 'https://liquiditymapperfast.github.io/');
  for (const host of ['localhost', '127.0.0.1', '192.168.1.20', '', 'notliquiditymapper.com.evil.test']) assert.equal(pageAddress(host, `http://${host}`, '/x/'), LOCAL_COPY, host || 'a file');
  assert.match(speedReport(info({ url: LOCAL_COPY })), /I use LiquidityMapperFast \(a copy of the page on this computer or network\)/);
});
