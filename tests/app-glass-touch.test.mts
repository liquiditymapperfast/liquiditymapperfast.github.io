import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_MAX_MS, PUSH_MAX, WAKE_MAX, WAKE_MIN_SPEED, pushAmp, wakeAmp } from '../src/app/glass/touch.ts';
import { SUBSTEP_MS, WaveField } from '../src/app/glass/waves.ts';

test('a hand at rest sends nothing into the water; a moving one leaves a wake that grows with its speed, to a cap', () => {
  assert.equal(wakeAmp(0, 16), 0, 'no move, no wake');
  assert.equal(wakeAmp(WAKE_MIN_SPEED * 16 * 0.9, 16), 0, 'a tremor is no wake');
  const slow = wakeAmp(8, 16), fast = wakeAmp(32, 16);
  assert.ok(slow > 0 && fast > slow, `faster, taller (${slow}, ${fast})`);
  assert.equal(wakeAmp(4_000, 16), WAKE_MAX, 'a flick is held to the cap');
});

test('a first frame after a still spell counts as a long frame, never as no time', () => {
  assert.equal(wakeAmp(20, 10_000), wakeAmp(20, FRAME_MAX_MS), 'a frame a long way after the last is reckoned as the longest one');
  assert.ok(wakeAmp(20, 10_000) > 0, '20 px in that time is still a hand moving');
  assert.equal(wakeAmp(20, 0), 0, 'no time, no speed');
});

test('a splitter pushes the water as fast as it moves, to its cap', () => {
  assert.equal(pushAmp(0, 16), 0);
  assert.ok(pushAmp(6, 16) > 0 && pushAmp(12, 16) > pushAmp(6, 16));
  assert.equal(pushAmp(4_000, 16), PUSH_MAX);
});

/** A stand-in for WebGL2 that accepts every call and records, for each substep, the pulses it was given (their place in cells). */
function recordingGl(): { gl: WebGL2RenderingContext; substeps: { n: number; src: number[]; seg: number[]; side: number[] }[] } {
  const consts = new Map<string, number>(), substeps: { n: number; src: number[]; seg: number[]; side: number[] }[] = [];
  const constant = (name: string): number => { if (!consts.has(name)) consts.set(name, consts.size + 1); return consts.get(name)!; };
  let pending: { n: number; src: number[]; seg: number[]; side: number[] } = { n: 0, src: [], seg: [], side: [] };
  const calls: Record<string, (...a: unknown[]) => unknown> = {
    getExtension: () => ({}), getShaderParameter: () => true, getProgramParameter: () => true,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'), getUniformLocation: (_p, name) => name,
    uniform1i: (loc, v) => { if (loc === 'n') pending.n = v as number; },
    uniform4fv: (loc, v) => { if (loc === 'src') pending.src = Array.from(v as Float32Array); },
    uniform2fv: (loc, v) => { if (loc === 'seg') pending.seg = Array.from(v as Float32Array); },
    uniform1fv: (loc, v) => { if (loc === 'side') pending.side = Array.from(v as Float32Array); },
    drawArrays: () => { if (pending.n > 0) substeps.push(pending); pending = { n: 0, src: [], seg: [], side: [] }; },
  };
  const gl = new Proxy({}, {
    get: (_t, name) => typeof name !== 'string' ? undefined : /^[A-Z0-9_]+$/.test(name) ? constant(name) : calls[name] ?? (() => ({})),
  }) as unknown as WebGL2RenderingContext;
  return { gl, substeps };
}

test('a moving touch is laid down a piece each substep, in the touches\' own channel, end to end along its way', () => {
  const { gl, substeps } = recordingGl(), field = WaveField.create(gl)!;
  field.resize(800, 400);
  field.add({ x: 10, y: 10, amp: 0, width: 4, side: 0 }, 1_000); field.step(1_000);
  substeps.length = 0;
  field.addPath({ x0: 100, y0: 200, x1: 164, y1: 200, amp: 0.1, width: 5 }, 1_016);
  field.step(1_016.7);
  const expected = Math.round(16.7 / SUBSTEP_MS);
  assert.equal(substeps.length, expected, 'every substep of the frame takes a piece');
  const pieces = substeps.map(s => ({ n: s.n, x0: s.src[0]! * 4, x1: s.seg[0]! * 4, side: s.side[0] }));
  for (const piece of pieces) { assert.equal(piece.n, 1, 'one pulse a substep'); assert.equal(piece.side, 2, 'in the touches\' channel'); }
  assert.ok(Math.abs(pieces[0]!.x0 - 100) < 1e-3, 'the first piece starts where the touch was');
  assert.ok(Math.abs(pieces.at(-1)!.x1 - 164) < 1e-3, 'the last ends where it is');
  for (let k = 1; k < pieces.length; k++) assert.ok(Math.abs(pieces[k]!.x0 - pieces[k - 1]!.x1) < 1e-3, 'each piece begins where the one before ended');
  field.step(1_033.4);
  assert.equal(substeps.length, expected, 'a frame later the touch has been laid, and nothing more is');
});

test('a touch keeps the field running as a pulse does, and stops with it', () => {
  const { gl } = recordingGl(), field = WaveField.create(gl)!;
  field.resize(800, 400);
  assert.ok(!field.alive(5_000), 'a still field is still');
  field.addPath({ x0: 0, y0: 0, x1: 10, y1: 0, amp: 0.1, width: 5 }, 5_000);
  assert.ok(field.alive(5_000), 'a touch sets it going');
});
