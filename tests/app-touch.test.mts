import test from 'node:test';
import assert from 'node:assert/strict';
import { GestureRecognizer, axisPinchScale, type GestureHandlers, type PinchInfo, type Pt } from '../src/app/touch.ts';

/** A clock and a timer list that the test advances by hand. */
function rig(handlers: GestureHandlers = {}) {
  let now = 0, next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const log: string[] = [];
  const h: GestureHandlers = {
    down: p => log.push(`down ${p.x},${p.y}`),
    tap: p => log.push(`tap ${p.x},${p.y}`),
    doubleTap: p => log.push(`double ${p.x},${p.y}`),
    hold: p => log.push(`hold ${p.x},${p.y}`),
    holdMove: p => log.push(`holdMove ${p.x},${p.y}`),
    holdEnd: p => log.push(`holdEnd ${p.x},${p.y}`),
    panStart: p => log.push(`panStart ${p.x},${p.y}`),
    pan: (d, p) => log.push(`pan ${d.x},${d.y} -> ${p.x},${p.y}`),
    panEnd: v => log.push(v ? `panEnd ${v.x.toFixed(2)},${v.y.toFixed(2)}` : 'panEnd cancelled'),
    pinchStart: () => log.push('pinchStart'),
    pinch: () => log.push('pinch'),
    pinchEnd: () => log.push('pinchEnd'),
    cancel: () => log.push('cancel'),
    ...handlers,
  };
  const g = new GestureRecognizer(h, {
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: id => { timers.delete(id as number); },
  });
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
  };
  const at = (p: Pt) => p;
  return { g, log, advance, now: () => now, at };
}

test('a quick touch that stays put is a tap', () => {
  const { g, log, advance, now } = rig();
  g.pointerDown(1, { x: 50, y: 60 }, now());
  advance(80);
  g.pointerUp(1, { x: 52, y: 61 }, now());
  assert.deepEqual(log, ['down 50,60', 'tap 52,61']);
  advance(1000);
  assert.equal(log.length, 2, 'the hold timer was cancelled by the lift');
});

test('two taps close in time and place are a tap and then a double tap', () => {
  const { g, log, advance, now } = rig();
  g.pointerDown(1, { x: 50, y: 60 }, now()); advance(60); g.pointerUp(1, { x: 50, y: 60 }, now());
  advance(120);
  g.pointerDown(1, { x: 58, y: 64 }, now()); advance(60); g.pointerUp(1, { x: 58, y: 64 }, now());
  assert.deepEqual(log.filter(l => !l.startsWith('down')), ['tap 50,60', 'double 58,64']);
});

test('two taps far apart, or too far apart in time, are two taps', () => {
  const far = rig();
  far.g.pointerDown(1, { x: 10, y: 10 }, far.now()); far.advance(50); far.g.pointerUp(1, { x: 10, y: 10 }, far.now());
  far.advance(100);
  far.g.pointerDown(1, { x: 200, y: 200 }, far.now()); far.advance(50); far.g.pointerUp(1, { x: 200, y: 200 }, far.now());
  assert.deepEqual(far.log.filter(l => !l.startsWith('down')), ['tap 10,10', 'tap 200,200']);
  const slow = rig();
  slow.g.pointerDown(1, { x: 10, y: 10 }, slow.now()); slow.advance(50); slow.g.pointerUp(1, { x: 10, y: 10 }, slow.now());
  slow.advance(500);
  slow.g.pointerDown(1, { x: 10, y: 10 }, slow.now()); slow.advance(50); slow.g.pointerUp(1, { x: 10, y: 10 }, slow.now());
  assert.deepEqual(slow.log.filter(l => !l.startsWith('down')), ['tap 10,10', 'tap 10,10']);
});

test('a finger kept still becomes a hold, follows the finger, and its lift is not a tap', () => {
  const { g, log, advance, now } = rig();
  g.pointerDown(1, { x: 100, y: 100 }, now());
  advance(300); assert.equal(log.includes('hold 100,100'), false, 'not yet');
  advance(150); assert.ok(log.includes('hold 100,100'));
  g.pointerMove(1, { x: 120, y: 90 }, now());
  g.pointerUp(1, { x: 125, y: 90 }, now());
  assert.deepEqual(log.slice(1), ['hold 100,100', 'holdMove 120,90', 'holdEnd 125,90']);
});

test('wandering inside the slop does not cancel a tap or a hold', () => {
  const { g, log, advance, now } = rig();
  g.pointerDown(1, { x: 100, y: 100 }, now());
  g.pointerMove(1, { x: 104, y: 103 }, now());
  advance(500);
  assert.ok(log.includes('hold 104,103'), 'the hold reports where the finger is now');
});

test('moving past the slop is a pan that reports the whole displacement, then increments', () => {
  const { g, log, advance, now } = rig();
  g.pointerDown(1, { x: 100, y: 100 }, now());
  advance(16); g.pointerMove(1, { x: 120, y: 100 }, now());
  advance(16); g.pointerMove(1, { x: 140, y: 110 }, now());
  assert.deepEqual(log.slice(1, 4), ['panStart 100,100', 'pan 20,0 -> 120,100', 'pan 20,10 -> 140,110']);
  advance(2000);
  assert.equal(log.some(l => l.startsWith('hold')), false, 'a pan never becomes a hold');
});

test('lifting a moving finger gives its velocity; lifting after a rest gives none', () => {
  const fast = rig();
  fast.g.pointerDown(1, { x: 0, y: 0 }, fast.now());
  for (let i = 1; i <= 5; i++) { fast.advance(16); fast.g.pointerMove(1, { x: i * 32, y: 0 }, fast.now()); }
  fast.advance(8); fast.g.pointerUp(1, { x: 160, y: 0 }, fast.now());
  const end = fast.log.at(-1)!;
  assert.match(end, /^panEnd 2\.\d\d,0\.00$/, `about 32 px per 16 ms: ${end}`);
  const rested = rig();
  rested.g.pointerDown(1, { x: 0, y: 0 }, rested.now());
  rested.advance(16); rested.g.pointerMove(1, { x: 40, y: 0 }, rested.now());
  rested.advance(400); rested.g.pointerUp(1, { x: 40, y: 0 }, rested.now());
  assert.equal(rested.log.at(-1), 'panEnd 0.00,0.00');
});

test('a second finger ends a pan and begins a pinch with each axis measured on its own', () => {
  const infos: PinchInfo[] = [];
  const { g, log, advance, now } = rig({ pinchStart: i => infos.push(i), pinch: i => infos.push(i) });
  g.pointerDown(1, { x: 100, y: 100 }, now());
  advance(16); g.pointerMove(1, { x: 130, y: 100 }, now());
  g.pointerDown(2, { x: 230, y: 160 }, now());
  assert.ok(log.includes('panEnd cancelled'), 'the pan is cut short without a fling');
  assert.equal(infos[0]!.start.dx, 100); assert.equal(infos[0]!.start.dy, 60);
  assert.deepEqual(infos[0]!.mid, { x: 180, y: 130 });
  advance(16); g.pointerMove(2, { x: 330, y: 220 }, now());
  const last = infos.at(-1)!;
  assert.equal(last.now.dx, 200); assert.equal(last.now.dy, 120);
  assert.deepEqual(last.startMid, { x: 180, y: 130 }, 'the starting midpoint is kept for the whole pinch');
});

test('after a pinch, the finger left on the glass is ignored until it lifts', () => {
  const { g, log, advance, now } = rig();
  g.pointerDown(1, { x: 100, y: 100 }, now());
  g.pointerDown(2, { x: 200, y: 100 }, now());
  advance(16); g.pointerMove(2, { x: 260, y: 100 }, now());
  g.pointerUp(1, { x: 100, y: 100 }, now());
  const before = log.length;
  advance(16); g.pointerMove(2, { x: 300, y: 140 }, now());
  g.pointerUp(2, { x: 300, y: 140 }, now());
  assert.equal(log.length, before, 'no pan, no tap from the remaining finger');
  assert.ok(log.includes('pinchEnd'));
  // and a fresh touch afterwards works normally
  advance(10); g.pointerDown(3, { x: 10, y: 10 }, now()); advance(40); g.pointerUp(3, { x: 10, y: 10 }, now());
  assert.equal(log.at(-1), 'tap 10,10');
});

test('a hold is ended when a second finger lands', () => {
  const { g, log, advance, now } = rig();
  g.pointerDown(1, { x: 100, y: 100 }, now());
  advance(500);
  g.pointerDown(2, { x: 160, y: 100 }, now());
  assert.ok(log.includes('holdEnd 100,100'));
  assert.ok(log.includes('pinchStart'));
});

test('cancel ends a pan without a fling and forgets the fingers', () => {
  const { g, log, advance, now } = rig();
  g.pointerDown(1, { x: 0, y: 0 }, now()); advance(16); g.pointerMove(1, { x: 50, y: 0 }, now());
  g.pointerCancel(1);
  assert.deepEqual(log.slice(-2), ['panEnd cancelled', 'cancel']);
  assert.equal(g.active, false);
  g.pointerMove(1, { x: 80, y: 0 }, now());
  assert.equal(log.length, 5, 'nothing happens for a finger that is gone');
});

test('without a hold handler a long still touch is just a tap, and nothing is timed', () => {
  const { g, log, advance, now } = rig({ hold: undefined });
  g.pointerDown(1, { x: 5, y: 5 }, now());
  advance(2000);
  g.pointerUp(1, { x: 5, y: 5 }, now());
  assert.deepEqual(log, ['down 5,5', 'tap 5,5']);
});

test('a pinch scales an axis by its own finger separation, and an aligned axis not at all', () => {
  assert.equal(axisPinchScale(100, 200), 2, 'spread to twice the separation: zoom in by two');
  assert.equal(axisPinchScale(100, 50), 0.5);
  assert.equal(axisPinchScale(4, 80), 1, 'fingers lined up on the other axis say nothing about this one');
  assert.equal(axisPinchScale(0, 80), 1);
  const half = axisPinchScale(36, 72);
  assert.ok(half > 1 && half < 2, `a separation between the floor and the ramp is partly applied: ${half}`);
  assert.equal(axisPinchScale(100, 5000), 12, 'one gesture cannot zoom by more than a fixed factor');
  assert.equal(axisPinchScale(100, 0), 0.08);
});
