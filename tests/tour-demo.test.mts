import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_SPAN_SHARE, TIME_SPAN_MS, zoomedView } from '../src/app/panes/heat-zoom.ts';
import { LOOP_MS, demoPose } from '../src/app/tour/demo.ts';

const HOUR = 3_600_000;
const v0 = { t0: 0, t1: 4 * HOUR, p0: 70_000, p1: 80_000 };

test('a right-button drag: right zooms time in, up zooms price in, about the point pressed, which stays where it was', () => {
  const press = { x: 300, y: 200 }, pw = 600, ph = 400, ref = 75_000;
  assert.deepEqual(zoomedView(v0, press, press, pw, ph, ref), v0, 'no movement, no change');
  const right = zoomedView(v0, press, { x: 420, y: 200 }, pw, ph, ref);
  assert.ok(right.t1 - right.t0 < v0.t1 - v0.t0, 'right: time in');
  assert.equal(right.p1 - right.p0, v0.p1 - v0.p0, 'and price as it was');
  const tPressed = (v: typeof v0): number => v.t0 + press.x / pw * (v.t1 - v.t0);
  assert.ok(Math.abs(tPressed(right) - tPressed(v0)) < 1, 'the moment pressed stays under the press');
  const left = zoomedView(v0, press, { x: 180, y: 200 }, pw, ph, ref);
  assert.ok(left.t1 - left.t0 > v0.t1 - v0.t0, 'left: time out');
  const up = zoomedView(v0, press, { x: 300, y: 80 }, pw, ph, ref);
  assert.ok(up.p1 - up.p0 < v0.p1 - v0.p0, 'up: price in');
  const pPressed = (v: typeof v0): number => v.p0 + (1 - press.y / ph) * (v.p1 - v.p0);
  assert.ok(Math.abs(pPressed(up) - pPressed(v0)) < 1e-6, 'the price pressed stays under the press');
  assert.ok(zoomedView(v0, press, { x: 300, y: 320 }, pw, ph, ref).p1 - v0.p0 > v0.p1 - v0.p0, 'down: price out');
  // Far enough, the floors hold: 30 s of time, the least share of the price.
  const far = zoomedView(v0, press, { x: 300 + 5000, y: 200 - 5000 }, pw, ph, ref);
  assert.equal(far.t1 - far.t0, TIME_SPAN_MS.min);
  assert.ok(Math.abs((far.p1 - far.p0) - ref * PRICE_SPAN_SHARE.min) < 1e-9);
});

test('the tour\'s hand: it presses, goes right and back (time), then up and back (price), lets go and rests, the same every loop', () => {
  const reach = 150, rise = 120;
  const at = (ms: number) => demoPose(ms, reach, rise);
  assert.equal(at(200).pressed, false); assert.ok(at(200).opacity < 1, 'it fades in');
  assert.deepEqual([at(2100).dx, at(2100).dy, at(2100).leg, at(2100).pressed], [reach, -0, 'time', true], 'right, holding the button: time');
  assert.ok(Math.abs(at(3400).dx) < 1e-9, 'back where it pressed');
  assert.deepEqual([at(4900).dy, at(4900).leg], [-rise, 'price'], 'up: price');
  assert.ok(Math.abs(at(6200).dy) < 1e-9 && !at(6200).pressed, 'back down, and the button let go');
  assert.ok(at(7100).opacity < 1, 'it fades out before the next loop');
  for (const ms of [100, 1500, 2700, 4200, 5600, 6900]) assert.deepEqual(at(ms), at(ms + 3 * LOOP_MS), `loop at ${ms}`);
  // It never moves both ways at once, and stays within its reach.
  for (let ms = 0; ms < LOOP_MS; ms += 50) {
    const p = at(ms);
    assert.ok(p.dx === 0 || Math.abs(p.dy) < 1e-9, `${ms}: one axis at a time`);
    assert.ok(p.dx >= 0 && p.dx <= reach && p.dy <= 0 && p.dy >= -rise, `${ms}: within reach`);
  }
});
