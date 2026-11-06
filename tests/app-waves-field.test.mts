import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FRAME_MS, RING_MS, SUBSTEP_MS, WaveField } from '../src/app/glass/waves.ts';

/**
 * A stand-in for a WebGL2 context that accepts every call: its constants are numbers, shaders and framebuffers always succeed, a uniform's
 * location is its name, and the calls the field's steps make are counted (each substep is one draw; `n` is how many pulses one takes).
 */
function fakeGl(): { gl: WebGL2RenderingContext; draws: () => number; pulses: number[] } {
  const consts = new Map<string, number>(), pulses: number[] = [];
  let draws = 0;
  const constant = (name: string): number => { if (!consts.has(name)) consts.set(name, consts.size + 1); return consts.get(name)!; };
  const calls: Record<string, (...a: unknown[]) => unknown> = {
    getExtension: () => ({}), getShaderParameter: () => true, getProgramParameter: () => true,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'), getUniformLocation: (_p, name) => name,
    drawArrays: () => { draws++; }, uniform1i: (loc, v) => { if (loc === 'n' && (v as number) > 0) pulses.push(v as number); },
  };
  const gl = new Proxy({}, {
    get: (_t, name) => typeof name !== 'string' ? undefined : /^[A-Z0-9_]+$/.test(name) ? constant(name) : calls[name] ?? (() => ({})),
  }) as unknown as WebGL2RenderingContext;
  return { gl, draws: () => draws, pulses };
}

const pulse = { x: 40, y: 40, amp: 1, width: 6, side: 0 as const };

test('a pulse queued while the field is not stepped keeps it alive only for its ring time, and is dropped then, not burst out later', () => {
  const { gl, pulses } = fakeGl(), field = WaveField.create(gl)!;
  assert.ok(field, 'the stand-in passes for a card that draws into half floats');
  field.resize(400, 300);
  field.add(pulse, 1_000);
  assert.ok(field.alive(1_000 + RING_MS - 1), 'alive while it may still ring');
  assert.ok(!field.alive(1_000 + RING_MS + 1), 'and not after, though it was never stepped in (the Tape with its glass switched off)');
  field.step(60_000);
  field.add({ ...pulse, side: 1 }, 60_010); field.step(60_020);
  assert.deepEqual(pulses, [1], 'the stale pulse went; the new one is stepped in alone');
});

test('after a still spell the first step of a new pulse is one frame long, not the whole spell', () => {
  const { gl, draws } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(400, 300);
  field.add(pulse, 0);
  for (let t = 0; t <= RING_MS + 100; t += 16) field.step(t);
  assert.ok(!field.alive(RING_MS + 100), 'the field has gone still');
  // Minutes later (the page's glass draws only when something changes), a new pulse.
  field.add(pulse, 300_000);
  const before = draws(); field.step(300_000);
  assert.equal(draws() - before, Math.round(16.7 / SUBSTEP_MS), 'one frame of substeps, not the MAX_FRAME_MS of a stale clock');
});

test('a long pause steps as a short one, not the whole pause at once, and no frame steps more than sixteen substeps', () => {
  const { gl, draws } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(400, 300);
  field.add(pulse, 100); field.step(100);
  field.add(pulse, 1_100);
  const before = draws(); field.step(1_100);
  assert.equal(draws() - before, Math.round(MAX_FRAME_MS / SUBSTEP_MS), 'a second away steps one long frame');
  assert.equal(Math.round(MAX_FRAME_MS / SUBSTEP_MS), 16, 'of sixteen substeps: a card that falls behind is not given more to do each frame');
  // Frames of 50 ms, a card that cannot keep up: each steps sixteen, never the 24 its time would hold.
  for (let t = 1_150; t < 1_600; t += 50) { field.add(pulse, t); const was = draws(); field.step(t); assert.ok(draws() - was <= 17, `${draws() - was} substeps in a 50 ms frame`); }
});
