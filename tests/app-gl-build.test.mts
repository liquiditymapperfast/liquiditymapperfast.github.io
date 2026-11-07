import test from 'node:test';
import assert from 'node:assert/strict';
import { built, startProgram } from '../src/app/gl-build.ts';
import { CELL, WaveField } from '../src/app/glass/waves.ts';

/**
 * A stand-in for a WebGL2 context whose programs are built when the test says (`finish`), as a card building them on threads of its own:
 * until then COMPLETION_STATUS_KHR answers false. `parallel: false` is a card without the extension; `lose` answers null to everything, as
 * a lost context does, and `restore` gives the context back without the extension switched on (asked about then, its constant is null, as
 * an unknown enum's answer); `broken` fails the fragment shader. What was asked of it is counted.
 */
function fakeGl(opts: { parallel?: boolean; broken?: boolean } = {}): { gl: WebGL2RenderingContext; finish: () => void; lose: () => void; restore: () => void; asked: Map<string, number>; draws: () => number; medium: () => unknown } {
  const consts = new Map<string, number>(), asked = new Map<string, number>();
  const constant = (name: string): number => { if (!consts.has(name)) consts.set(name, consts.size + 1); return consts.get(name)!; };
  let done = false, lost = false, enabled = false, draws = 0, medium: unknown = null;
  const ask = (name: string): void => { asked.set(name, (asked.get(name) ?? 0) + 1); };
  const calls: Record<string, (...a: unknown[]) => unknown> = {
    getExtension: (name) => {
      if (name !== 'KHR_parallel_shader_compile') return {};
      ask('getExtension'); if (opts.parallel === false || lost) return null;
      enabled = true; return { COMPLETION_STATUS_KHR: constant('COMPLETION_STATUS_KHR') };
    },
    createShader: (type) => lost ? null : ({ type, src: '' }), shaderSource: (s, src) => { (s as { src: string }).src = src as string; },
    getShaderParameter: (s) => { ask('COMPILE_STATUS'); return lost ? null : !(opts.broken && (s as { type: number }).type === constant('FRAGMENT_SHADER')); },
    getShaderInfoLog: () => 'ERROR: 0:3: syntax error',
    getProgramParameter: (_p, what) => {
      if (lost) return null;
      if (what === constant('COMPLETION_STATUS_KHR')) { ask('COMPLETION_STATUS_KHR'); return enabled ? done : null; }
      ask('LINK_STATUS'); return !opts.broken;
    },
    getProgramInfoLog: () => 'link failed',
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'), getUniformLocation: (_p, name) => name,
    drawArrays: () => { draws++; }, uniform4fv: (loc, v) => { if (loc === 'region') medium = v; },
  };
  const gl = new Proxy({}, {
    get: (_t, name) => typeof name !== 'string' ? undefined : /^[A-Z0-9_]+$/.test(name) ? constant(name) : calls[name] ?? (() => ({})),
  }) as unknown as WebGL2RenderingContext;
  return { gl, finish: () => { done = true; }, lose: () => { lost = true; }, restore: () => { lost = false; enabled = false; }, asked, draws: () => draws, medium: () => medium };
}

test('a program being built is asked about without waiting: not built, and its link status is not asked until the card says it is done', () => {
  const card = fakeGl(), p = startProgram(card.gl, 'v', 'f');
  assert.equal(built(card.gl, [p]), false);
  assert.equal(card.asked.get('LINK_STATUS'), undefined, 'the link status (which waits for the card) is left alone while it builds');
  assert.equal(card.asked.get('COMPILE_STATUS'), undefined, 'and so is each shader\'s');
  card.finish();
  assert.equal(built(card.gl, [p]), true);
});

test('a program that did not build throws the failing shader\'s log; a lost context reads as not built, never as failed', () => {
  const broken = fakeGl({ broken: true }), p = startProgram(broken.gl, 'v', 'f');
  broken.finish();
  assert.throws(() => built(broken.gl, [p]), /syntax error/);
  const card = fakeGl(), q = startProgram(card.gl, 'v', 'f');
  card.finish(); card.lose();
  assert.equal(built(card.gl, [q]), false);
});

test('a card without the extension is answered at once, as before (the status it asks for waits there)', () => {
  const card = fakeGl({ parallel: false }), p = startProgram(card.gl, 'v', 'f');
  assert.equal(built(card.gl, [p]), true);
  assert.equal(card.asked.get('LINK_STATUS'), 1);
});

test('the waves are not stepped while their programs are built, and the medium asked for meanwhile is drawn once they are', () => {
  const card = fakeGl(), field = WaveField.create(card.gl)!;
  assert.ok(field, 'a field is made at once, its programs still building');
  field.resize(400, 300);
  field.setMedium([{ x: 0, y: 0, w: 400, h: 32, kind: 'glass' }]);
  field.add({ x: 40, y: 40, amp: 1, width: 6, side: 0 }, 1_000);
  field.step(1_016);
  assert.equal(card.draws(), 0, 'nothing drawn while the card builds');
  assert.equal(field.built(), false);
  card.finish();
  assert.equal(field.built(), true);
  assert.equal(card.draws(), 1, 'the medium, drawn once built');
  assert.deepEqual([...(card.medium() as Float32Array).slice(0, 4)], [0, (300 - 32) / CELL, 400 / CELL, 32 / CELL], 'from the regions asked for while it was built');
});

test('a context given back has the extension switched on again with its next program, so that program is seen built', () => {
  const card = fakeGl(), first = startProgram(card.gl, 'v', 'f');
  card.lose(); assert.equal(built(card.gl, [first]), false, 'lost: not built, not failed');
  card.restore();
  const again = startProgram(card.gl, 'v', 'f');
  card.finish();
  assert.equal(built(card.gl, [again]), true, 'a cached switch of the old context would leave it "building" for ever');
  assert.equal(card.asked.get('getExtension'), 2);
});

test('a card that never says a program is done is asked plainly after a few seconds', () => {
  const card = fakeGl(), p = startProgram(card.gl, 'v', 'f');
  assert.equal(built(card.gl, [p]), false);
  assert.equal(built(card.gl, [{ ...p, startedAt: performance.now() - 5_000 }]), true, 'past the patience, the link status itself answers');
});

test('waves whose programs did not build stay failed: never alive, never rebuilt, and their owner can tell', () => {
  const card = fakeGl({ broken: true }), field = WaveField.create(card.gl)!;
  card.finish();
  field.add({ x: 40, y: 40, amp: 1, width: 6, side: 0 }, 1_000);
  field.step(1_016);
  assert.equal(field.failed, true);
  assert.equal(field.alive(1_016), false, 'a failed field keeps no loop going');
  const asked = card.asked.get('LINK_STATUS');
  field.step(1_033); field.setMedium([]);
  assert.equal(card.asked.get('LINK_STATUS'), asked, 'not built again on every frame');
  assert.throws(() => field.built(), /syntax error/, 'and it says why');
});

test('without the extension (or past the patience) a lost context reads as not built, and a program cannot be started on one', () => {
  const card = fakeGl({ parallel: false }), p = startProgram(card.gl, 'v', 'f');
  card.lose();
  assert.equal(built(card.gl, [p]), false, 'the link status answers null: not built, not failed');
  assert.throws(() => startProgram(card.gl, 'v', 'f'), /context lost/);
  const patient = fakeGl(), q = startProgram(patient.gl, 'v', 'f');
  patient.lose();
  assert.equal(built(patient.gl, [{ ...q, startedAt: performance.now() - 5_000 }]), false, 'past the patience too');
});
