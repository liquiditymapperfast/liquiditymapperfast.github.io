import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSY_DAMP, CELL, ENERGY_KNEE, ENERGY_MAX, MAX_FRAME_MS, MAX_WAITING, MAX_WAIT_MS, SLOW_KNEE, SLOW_MAX, SPAWN_BURST, SPAWN_RATE, STRENGTH_MID_GAIN,
  WAVE_STRENGTH_DEFAULT, WHALE_GAIN, WHALE_R, WaveField, admitted, pulseFor, readWaveStrength, strengthGain, type WaveRegion,
} from '../src/app/glass/waves.ts';
import { initialState } from '../src/app/store.ts';

/**
 * How the wave field keeps a busy market from flooding the screen (Karl, 2026-11-06): orders gathered into a few waiting waves, at most
 * SPAWN_RATE started a second, each let in as the field's own reckoning of its energy allows, and the person's Strength drawn on top.
 */

/** A stand-in for WebGL2 that accepts every call and records each substep's pulses as the step shader is given them (cells, bottom-up). */
function fakeGl(): { gl: WebGL2RenderingContext; pulses: { x: number; y: number; amp: number; width: number; side: number }[][]; busy: number[] } {
  const consts = new Map<string, number>(), pulses: { x: number; y: number; amp: number; width: number; side: number }[][] = [], busy: number[] = [];
  const constant = (name: string): number => { if (!consts.has(name)) consts.set(name, consts.size + 1); return consts.get(name)!; };
  let n = 0, src: number[] = [], side: number[] = [];
  const calls: Record<string, (...a: unknown[]) => unknown> = {
    getExtension: () => ({}), getShaderParameter: () => true, getProgramParameter: () => true,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'), getUniformLocation: (_p, name) => name,
    uniform1i: (loc, v) => { if (loc === 'n') n = v as number; },
    uniform1f: (loc, v) => { if (loc === 'busyDamp') busy.push(v as number); },
    uniform4fv: (loc, v) => { if (loc === 'src') src = Array.from(v as Float32Array); },
    uniform1fv: (loc, v) => { if (loc === 'side') side = Array.from(v as Float32Array); },
    // A draw with sources set is a substep of the step shader (the medium's draw sets no `src`).
    drawArrays: () => { if (src.length) pulses.push(Array.from({ length: n }, (_, i) => ({ x: src[i * 4]!, y: src[i * 4 + 1]!, amp: src[i * 4 + 2]!, width: src[i * 4 + 3]!, side: side[i]! }))); },
  };
  const gl = new Proxy({}, {
    get: (_t, name) => typeof name !== 'string' ? undefined : /^[A-Z0-9_]+$/.test(name) ? constant(name) : calls[name] ?? (() => ({})),
  }) as unknown as WebGL2RenderingContext;
  return { gl, pulses, busy };
}

const W = 1600, H = 900;
const started = (pulses: { side: number }[][]): number => pulses.reduce((sum, p) => sum + p.filter(q => q.side < 1.5).length, 0);

test('a flood of orders starts at most SPAWN_RATE waves a second however many come, and a normal day\'s orders start at once', () => {
  const { gl, pulses } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(W, H);
  // 200 orders a second for ten seconds, in batches every 250 ms as the tape sends them, all over the screen.
  let k = 0;
  for (let t = 1_000; t <= 11_000; t += 1000 / 60) {
    if (Math.floor(t / 250) !== Math.floor((t - 1000 / 60) / 250)) for (let i = 0; i < 50; i++, k++) field.order((k * 197) % W, (k * 113) % H, -40_000, 25_000, k % 2 ? 1 : 0, t);
    field.step(t);
  }
  const waves = started(pulses);
  assert.ok(waves <= SPAWN_RATE * 10 + SPAWN_BURST, `${waves} waves from ${k} orders in ten seconds`);
  assert.ok(waves >= SPAWN_RATE * 5, `and the field still shows the market (${waves})`);
  assert.equal(field.orders, k, 'every order was taken');
  assert.ok(field.waiting <= 2 * MAX_WAITING, `and few wait (${field.waiting})`);
  assert.ok(pulses.every(p => p.length <= 16), 'no substep is given more pulses than the shader holds');

  // Three orders a second, apart in time: each starts its own wave on the next frame.
  const calm = fakeGl(), quiet = WaveField.create(calm.gl)!;
  quiet.resize(W, H);
  let orders = 0;
  for (let t = 1_000; t <= 11_000; t += 1000 / 60) {
    if (Math.floor(t / 333) !== Math.floor((t - 1000 / 60) / 333)) { quiet.order(400 + (orders % 5) * 200, 450, 30_000, 25_000, 0, t); orders++; }
    quiet.step(t);
  }
  assert.equal(started(calm.pulses), orders, 'none merged, none dropped');
});

test('orders that come together at one place make one wave, as one order of their summed size', () => {
  const { gl, pulses } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(W, H);
  // Five sells of $50k within a few pixels of each other, in one batch.
  for (let i = 0; i < 5; i++) field.order(800 + i * 3, 400 - i * 2, -50_000, 25_000, 1, 1_000);
  field.step(1_000);
  const sent = pulses.flat().filter(p => p.side < 1.5);
  assert.equal(sent.length, 1, 'one wave');
  const one = pulseFor(250_000, 25_000);
  assert.ok(Math.abs(sent[0]!.amp - one.amp) < 1e-6, `as tall as one $250k order (${sent[0]!.amp.toFixed(3)} against ${one.amp.toFixed(3)})`);
  assert.ok(Math.abs(sent[0]!.width - one.width / CELL) < 1e-6, 'and as wide');
  assert.ok(Math.abs(sent[0]!.x * CELL - 806) < 1e-3 && Math.abs((H - sent[0]!.y * CELL) - 396) < 1e-3, 'where their sizes centre');
  assert.equal(sent[0]!.side, 1, 'a sell\'s');
});

test('a buy and a sell at one place stay two waves; orders far apart never merge: past MAX_WAITING the larger replaces the smallest, the rest are passed over', () => {
  const { gl, pulses } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(W, H);
  field.order(500, 500, 30_000, 25_000, 0, 1_000); field.order(500, 500, -30_000, 25_000, 1, 1_000);
  assert.equal(field.waiting, 2, 'each side its own');
  // Buys waiting at x = 100, 300, 500 (the first) and 700; one as large at x = 1500 joins none and is passed over (Sol: it made a wave at
  // about 1100, where nothing traded); a larger one there takes the smallest's place.
  for (const x of [100, 300, 700]) field.order(x, 500, 30_000, 25_000, 0, 1_000);
  field.order(1_500, 500, 30_000, 25_000, 0, 1_000);
  assert.deepEqual([field.waiting, field.passed], [MAX_WAITING + 1, 1], 'the equal one passed over');
  field.order(1_500, 500, 200_000, 25_000, 0, 1_000);
  assert.deepEqual([field.waiting, field.passed], [MAX_WAITING + 1, 2], 'the larger one in, the smallest out');
  field.step(1_000);
  const first = pulses.flat().filter(p => p.side < 1.5);
  assert.equal(first.length, SPAWN_BURST, 'the first frame starts as many as the bucket holds');
  assert.ok(Math.abs(first[0]!.x * CELL - 1_500) < 1e-3, 'the largest first, where it traded');
  assert.ok(first.every(p => [100, 300, 500, 700, 1_500].some(x => Math.abs(p.x * CELL - x) < 1e-3)), 'and every wave where an order traded');
});

test('the largest order of a batch starts first, whatever its place in the batch, and the rest are not dropped for its sake (Sol)', () => {
  for (const whaleFirst of [false, true]) {
    const { gl, pulses } = fakeGl(), field = WaveField.create(gl)!;
    field.resize(W, H);
    // One batch: 22 buys of $27k at one spot (one wave of their sum, at its height cap) and one $5M buy 120 px away.
    const cluster = (): void => { for (let i = 0; i < 22; i++) field.order(1_400 + (i % 3), 400 + (i % 5), 27_000, 25_000, 0, 1_000); };
    const whale = (): void => field.order(1_400, 520, 5_000_000, 25_000, 0, 1_000);
    if (whaleFirst) { whale(); cluster(); } else { cluster(); whale(); }
    let t = 1_000;
    for (; t < 1_000 + MAX_WAIT_MS && started(pulses) < 2; t += 1000 / 60) field.step(t);
    const sent = pulses.flat().filter(p => p.side < 1.5);
    const big = pulseFor(5_000_000, 25_000);
    assert.ok(Math.abs(sent[0]!.width - big.width / CELL) < 1e-6 && Math.abs(sent[0]!.amp - big.amp) < 1e-6, `the $5M order first, whole (whale ${whaleFirst ? 'first' : 'last'} in the batch)`);
    assert.equal(sent.length, 2, `and the cluster after it, within MAX_WAIT_MS (${Math.round(t - 1_000)} ms)`);
    assert.equal(field.passed, 0, 'nothing passed over');
  }
});

test('a single order of WHALE_R or more always shows: at least WHALE_GAIN of its height while the field is under WHALE_ROOM times its ceiling', () => {
  const { gl, pulses } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(W, H);
  // Two waves of 39 small sells each (a cascade's, none of them a whale) take the field past its ceiling ...
  for (const [x, y] of [[400, 300], [1_200, 600]]) for (let i = 0; i < 39; i++) field.order(x, y, -25_000, 25_000, 1, 1_000);
  field.step(1_000);
  assert.ok(field.energy > ENERGY_MAX && field.energy < ENERGY_MAX * 1.5, `the field is past its ceiling (${field.energy.toFixed(1)})`);
  assert.equal(admitted(field.energy), 0, 'where an ordinary wave goes in not at all');
  // ... and a $5M buy still shows, at WHALE_GAIN of its height, while an ordinary sell waits.
  const before = pulses.flat().length;
  field.order(800, 450, -60_000, 25_000, 1, 1_017); field.order(900, 450, 5_000_000, 25_000, 0, 1_017); field.step(1_017);
  const now = pulses.flat().slice(before).filter(p => p.side < 1.5);
  assert.equal(now.length, 1, 'one wave');
  assert.ok(now[0]!.side === 0 && Math.abs(now[0]!.amp - WHALE_GAIN * pulseFor(5_000_000, 25_000).amp) < 1e-6, `the whale's, at WHALE_GAIN (${now[0]!.amp.toFixed(3)})`);
  assert.equal(WHALE_R * 25_000, 1_000_000, 'a whale is $1M against the $25k that starts a wave');
});

test('waves start within MAX_WAIT_MS of their first order, or not at all, at 30 orders a second at many places', () => {
  const { gl } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(W, H);
  let k = 0;
  for (let t = 1_000; t <= 11_000; t += 1000 / 60) {
    if (Math.floor(t / 250) !== Math.floor((t - 1000 / 60) / 250)) for (let i = 0; i < 8; i++, k++) field.order(100 + (k * 337) % 1400, 100 + (k * 211) % 700, 40_000 * (1 + (k % 7)), 25_000, k % 3 ? 1 : 0, t);
    field.step(t);
  }
  const late = Math.max(...field.delays);
  assert.ok(late <= MAX_WAIT_MS, `the latest of the last waves started ${late.toFixed(0)} ms after its first order`);
  assert.ok(field.started >= SPAWN_RATE * 8, `and the field kept starting them (${field.started})`);
});

test('a field resized, or reset when its glass is switched off, forgets what it reckoned and what waited to start', () => {
  const { gl, pulses } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(W, H);
  field.order(800, 450, 50_000_000, 25_000, 0, 1_000); field.step(1_000);
  for (let i = 0; i < 3; i++) field.order(200 + i * 300, 300, -60_000, 25_000, 1, 1_010);
  assert.ok(field.energy > ENERGY_MAX && field.waiting === 3, 'a full field, waves waiting');
  field.resize(W - 400, H);
  assert.deepEqual([field.energy, field.waiting], [0, 0], 'a new size: an empty field, nothing waiting at the old layout\'s places');
  for (let i = 0; i < 3; i++) field.order(200 + i * 300, 300, -60_000, 25_000, 1, 1_020);
  field.reset();
  const before = pulses.flat().length;
  field.step(1_030); field.step(1_047);
  assert.deepEqual([field.waiting, pulses.flat().length - before], [0, 0], 'reset: nothing fires when it steps again');
});

test('a field that was not stepped for a while forgets what it reckoned: the first wave after it goes in whole and at once', () => {
  const { gl, pulses } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(W, H);
  // A cascade, then the field is no longer stepped (the Tape's glass switched off, its tab left, the page hidden) for a minute.
  let t = 1_000, k = 0;
  for (; t <= 9_000; t += 1000 / 60) {
    if (Math.floor(t / 250) !== Math.floor((t - 1000 / 60) / 250)) for (let i = 0; i < 38; i++, k++) field.order((k * 197) % W, (k * 113) % H, -60_000, 25_000, k % 2 ? 1 : 0, t);
    field.step(t);
  }
  assert.ok(field.slowEnergy > SLOW_KNEE, `a busy field when the stepping stops (${field.slowEnergy.toFixed(1)})`);
  const later = t + 60_000;
  field.order(800, 450, 50_000, 25_000, 0, later);
  assert.deepEqual([field.energy, field.slowEnergy], [0, 0], 'what it reckoned is forgotten');
  const before = pulses.flat().length;
  field.step(later);
  const fresh = pulses.flat().slice(before);
  assert.equal(fresh.length, 1, 'the wave starts at once');
  assert.ok(Math.abs(fresh[0]!.amp - pulseFor(50_000, 25_000).amp) < 1e-6, 'and whole');
});

test('no side starts more than STREAK_MAX waves in a row while the other has some waiting: a crash\'s buys still show beside sells ten times their size', () => {
  const { gl, pulses } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(W, H);
  // 150 orders a second at the live edge for 30 s, in tape batches: sells of $400k and buys of $40k, as many of each.
  let k = 0;
  for (let t = 1_000; t <= 31_000; t += 1000 / 60) {
    if (Math.floor(t / 250) !== Math.floor((t - 1000 / 60) / 250)) {
      for (let i = 0; i < 38; i++, k++) { const sell = k % 2 === 1; field.order(1_400, 100 + (k * 37) % 700, sell ? -400_000 : 40_000, 25_000, sell ? 1 : 0, t); }
    }
    field.step(t);
  }
  const market = pulses.flat().filter(p => p.side < 1.5), buys = market.filter(p => p.side === 0).length;
  assert.ok(buys >= 0.2 * market.length, `buys started ${buys} of ${market.length} waves`);
  assert.ok(market.length - buys > buys, 'and the sells, ten times larger, still the most');
});

test('a quiet field takes a large order whole; a busy one lets new waves in smaller, and none at its ceiling', () => {
  assert.equal(admitted(0), 1); assert.equal(admitted(ENERGY_KNEE), 1);
  assert.equal(admitted(ENERGY_MAX), 0); assert.equal(admitted(ENERGY_MAX * 3), 0);
  for (let e = ENERGY_KNEE; e < ENERGY_MAX; e += 0.25) assert.ok(admitted(e + 0.25) < admitted(e), `less and less past the knee (${e})`);
  // A whale on a still field: its full height, though its energy alone is past the ceiling.
  const { gl, pulses } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(W, H);
  field.order(800, 450, 50_000_000, 25_000, 0, 1_000); field.step(1_000);
  // The card's uniforms are 32-bit floats: heights are compared to a millionth.
  assert.ok(Math.abs(pulses.flat()[0]!.amp - pulseFor(50_000_000, 25_000).amp) < 1e-6, 'the whale keeps its height');
  assert.ok(field.energy > ENERGY_MAX, 'and fills the field past its ceiling');
  // Straight after it, the field lets nothing in; once the whale has faded, a new order goes in whole again.
  field.order(300, 300, 50_000, 25_000, 1, 1_020); field.step(1_020);
  assert.equal(pulses.flat().length, 1, 'nothing more while it is full');
  let t = 1_020;
  for (; field.energy > ENERGY_KNEE; t += 1000 / 60) field.step(t);
  assert.ok(t < 1_020 + 2_000, `the whale fades under the knee within two seconds (${t - 1_020} ms)`);
  field.order(300, 300, 50_000, 25_000, 1, t); field.step(t);
  assert.ok(Math.abs(pulses.flat().at(-1)!.amp - pulseFor(50_000, 25_000).amp) < 1e-6, 'and whole once it has faded under the knee');
});

test('a stream under the fast knee goes in whole at first, but as it lasts the slow average holds it back: smaller waves, the average held between SLOW_KNEE and SLOW_MAX', () => {
  const { gl, pulses } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(W, H);
  // Ten $100k orders a second at distinct places: let in whole they would hold about 15, past the fast knee too.
  const whole = pulseFor(100_000, 25_000).amp;
  const amps = (from: number): number[] => pulses.slice(from).flat().filter(p => p.side < 1.5).map(p => p.amp);
  let k = 0, t = 1_000;
  const run = (until: number): void => { for (; t < until; t += 1000 / 60) { if (Math.floor(t / 100) !== Math.floor((t - 1000 / 60) / 100)) { field.order(100 + (k * 263) % 1400, 100 + (k * 151) % 700, 100_000, 25_000, 0, t); k++; } field.step(t); } };
  run(2_000);
  assert.ok(amps(0).length >= 8 && amps(0).every(a => Math.abs(a - whole) < 1e-6), 'the first second goes in whole');
  run(16_000);
  const mark = pulses.length;
  run(31_000);
  const late = amps(mark);
  assert.ok(field.slowEnergy > SLOW_KNEE && field.slowEnergy < SLOW_MAX, `the average is held past its knee, under its ceiling (${field.slowEnergy.toFixed(2)})`);
  assert.ok(field.energy < ENERGY_KNEE, `while the energy now stays under the fast knee: it is the average that holds it (${field.energy.toFixed(2)})`);
  assert.ok(mean(late) < 0.95 * whole, `and the waves come smaller (${mean(late).toFixed(3)} against ${whole.toFixed(3)} whole)`);
});

test('a busy field damps the market\'s waves more, from nothing at the knee to BUSY_DAMP at the ceiling', () => {
  const { gl, busy } = fakeGl(), field = WaveField.create(gl)!;
  field.resize(W, H);
  field.order(800, 450, 30_000, 25_000, 0, 1_000); field.step(1_000);
  assert.equal(busy.at(-1), 0, 'a quiet field rings as it always did');
  field.order(800, 450, 50_000_000, 25_000, 0, 1_100); field.step(1_100); field.step(1_117);
  assert.ok(Math.abs(busy.at(-1)! - BUSY_DAMP) < 1e-9, `a full one is damped by BUSY_DAMP (${busy.at(-1)})`);
});

/**
 * The step shader run on the processor, one channel (the buys'), as tests/app-waves-energy.test.mts runs it, with the busy damping: enough to
 * compare the field's own reckoning of its energy with the energy its fronts really hold.
 */
function cpuField(): { gl: WebGL2RenderingContext; fronts: () => number } {
  const consts = new Map<string, number>();
  const constant = (name: string): number => { if (!consts.has(name)) consts.set(name, consts.size + 1); return consts.get(name)!; };
  interface Program { src: string; uniforms: Map<string, number | number[]> }
  let current: Program | null = null, cols = 0, rows = 0, speed2 = new Float32Array(0), damp = new Float32Array(0);
  let prev = new Float32Array(0), cur = new Float32Array(0), next = new Float32Array(0);
  const value = (v: unknown): number | number[] => typeof v === 'number' ? v : Array.from(v as ArrayLike<number>);
  const set = (loc: unknown, v: number | number[]): void => { current?.uniforms.set(loc as string, v); };
  const num = (name: string): number => (current!.uniforms.get(name) as number | undefined) ?? 0;
  const arr = (name: string): number[] => current!.uniforms.get(name) as number[];
  const smoothstep = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const medium = (): void => {
    const [cx, cy] = arr('cells') as [number, number], n = num('n'), region = arr('region'), kind = arr('kind'), glassC = num('glassC'), wallC = num('wallC');
    cols = cx; rows = cy; speed2 = new Float32Array(cols * rows); damp = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const fx = x + 0.5, fy = y + 0.5; let speed = 1;
      for (let i = 0; i < n; i++) {
        const [rx, ry, rw, rh] = region.slice(i * 4, i * 4 + 4) as [number, number, number, number];
        if (fx >= rx && fx <= rx + rw && fy >= ry && fy <= ry + rh) speed = kind[i]! > 0.5 ? wallC : Math.min(speed, glassC);
      }
      const edge = Math.min(Math.min(fx, cols - fx), Math.min(fy, rows - fy));
      speed2[y * cols + x] = speed * speed; damp[y * cols + x] = 0.0009 + 0.18 * (1 - smoothstep(0, 7, edge));
    }
    if (prev.length !== cols * rows) { prev = new Float32Array(cols * rows); cur = new Float32Array(cols * rows); next = new Float32Array(cols * rows); }
  };
  const step = (): void => {
    const courant = num('courant'), busy = num('busyDamp'), n = num('n'), src = arr('src'), side = arr('side');
    const was = prev, now = cur, out = next, w = cols, r = rows;
    for (let y = 0; y < r; y++) {
      const up = y + 1 < r ? w : 0, down = y > 0 ? -w : 0, row = y * w;
      for (let x = 0; x < w; x++) {
        const k = row + x, c = now[k]!;
        const lap = now[x + 1 < w ? k + 1 : k]! + now[x > 0 ? k - 1 : k]! + now[k + up]! + now[k + down]! - 4 * c;
        let h = (2 * c - was[k]! + courant * speed2[k]! * lap) * (1 - damp[k]!) * (1 - busy);
        for (let i = 0; i < n; i++) {
          if (side[i]! >= 0.5) continue;
          const dx = x + 0.5 - src[i * 4]!, dy = y + 0.5 - src[i * 4 + 1]!, width = src[i * 4 + 3]!;
          h += src[i * 4 + 2]! * Math.exp(-(dx * dx + dy * dy) / (2 * width * width));
        }
        out[k] = h > 4 ? 4 : h < -4 ? -4 : Math.abs(h) < 1e-12 ? 0 : h;
      }
    }
    prev = now; cur = out; next = was;
  };
  const calls: Record<string, (...a: unknown[]) => unknown> = {
    getExtension: () => ({}), getShaderParameter: () => true, getProgramParameter: () => true,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'), getUniformLocation: (_p, name) => name,
    createShader: () => ({ src: '' }), shaderSource: (s, src) => { (s as { src: string }).src = src as string; },
    createProgram: (): Program => ({ src: '', uniforms: new Map() }), attachShader: (p, s) => { (p as Program).src += (s as { src: string }).src; },
    useProgram: p => { current = p as Program; },
    uniform1f: (l, v) => set(l, value(v)), uniform1i: (l, v) => set(l, value(v)), uniform2f: (l, a, b) => set(l, [a as number, b as number]),
    uniform1fv: (l, v) => set(l, value(v)), uniform4fv: (l, v) => set(l, value(v)),
    clear: () => { prev.fill(0); cur.fill(0); next.fill(0); },
    drawArrays: () => { if (current?.src.includes('uniform float courant')) step(); else if (current?.src.includes('glassC')) medium(); },
  };
  const gl = new Proxy({}, {
    get: (_t, name) => typeof name !== 'string' ? undefined : /^[A-Z0-9_]+$/.test(name) ? constant(name) : calls[name] ?? (() => ({})),
  }) as unknown as WebGL2RenderingContext;
  // What the screen draws the fronts from: how much each cell rose or fell in the last substep, squared and added up.
  const fronts = (): number => { let e = 0; for (let k = 0; k < cur.length; k++) { const d = cur[k]! - prev[k]!; e += d * d; } return e; };
  return { gl, fronts };
}

/** A small desktop: the top bar and the status bar of glass, the flow column's and the book's splitters as walls (CSS px). */
const SW = 640, SH = 360;
const DESK: WaveRegion[] = [
  { x: 0, y: 0, w: SW, h: 32, kind: 'glass' }, { x: 0, y: SH - 10, w: SW, h: 10, kind: 'glass' },
  { x: 100, y: 32, w: 3, h: SH - 42, kind: 'wall' }, { x: 520, y: 32, w: 3, h: SH - 42, kind: 'wall' },
];

/**
 * `seconds` of orders at `rate` a second around a wandering price at the map's live edge, a frame every `frameMs` of the clock: the field's
 * reckoning and the fronts' true energy each frame.
 */
function drive(rate: number, seconds: number, seed: number, frameMs = 1000 / 60): { reckoned: number[]; fronts: number[] } {
  const cpu = cpuField(), field = WaveField.create(cpu.gl)!;
  field.resize(SW, SH); field.setMedium(DESK);
  let s = seed >>> 0; const rnd = (): number => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const reckoned: number[] = [], fronts: number[] = [];
  let next = 1_000, y = SH / 2;
  for (let t = 1_000; t < 1_000 + seconds * 1000; t += frameMs) {
    while (next <= t) {
      y = Math.min(SH - 60, Math.max(60, y + (rnd() - 0.5) * 8));
      field.order(500 + (rnd() - 0.5) * 8, y + (rnd() - 0.5) * 10, 25_000 * Math.pow(Math.max(1e-9, rnd()), -1 / 1.3), 25_000, 0, t);
      next += -Math.log(Math.max(1e-12, rnd())) / rate * 1000;
    }
    field.step(t);
    reckoned.push(field.energy); fronts.push(cpu.fronts());
  }
  return { reckoned, fronts };
}

const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
function correlation(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b); let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += (a[i]! - ma) * (b[i]! - mb); aa += (a[i]! - ma) ** 2; bb += (b[i]! - mb) ** 2; }
  return ab / Math.sqrt(aa * bb);
}

test('the field\'s own reckoning of its energy rises and falls with what its fronts really hold on a calm market, and keeps its scale in a cascade within a factor of two', t => {
  const calm = drive(4, 12, 7), r = correlation(calm.reckoned.slice(30), calm.fronts.slice(30));
  t.diagnostic(`correlation over 12 s of 4 orders a second: ${r.toFixed(3)}`);
  assert.ok(r > 0.9, `the two rise and fall together (${r.toFixed(3)})`);
  // In a cascade the reckoning sits near the ceiling, so a correlation says nothing there; what matters is that a unit it reckons is the same
  // energy on the card as on a calm market, so the ceiling means what it says under load. On this small screen, whose edges take a wave
  // sooner than the desktop's that ENERGY_TAU_MS was measured on, the two differ by most of that factor.
  const flood = drive(150, 12, 7), per = (d: { reckoned: number[]; fronts: number[] }): number => mean(d.fronts.slice(60)) / mean(d.reckoned.slice(60));
  t.diagnostic(`fronts per unit reckoned: ${per(calm).toFixed(4)} calm, ${per(flood).toFixed(4)} in the cascade`);
  assert.ok(per(flood) < per(calm) * 2 && per(flood) > per(calm) / 2, `the same scale within a factor of two (${(per(flood) / per(calm)).toFixed(2)}x)`);
});

test('the reckoning runs on the field\'s own time: at 10 frames a second a cascade holds about what the field believes, as at 60 (Sol)', t => {
  // The fronts' true energy for each unit the field reckons, at 60 frames a second and at 10 (each frame 100 ms of the clock, MAX_FRAME_MS of the field).
  const ratio = (frameMs: number): number => { const { reckoned, fronts } = drive(150, 15, 9, frameMs), from = Math.round(3_000 / frameMs); return mean(fronts.slice(from)) / mean(reckoned.slice(from)); };
  const at60 = ratio(1000 / 60), at10 = ratio(100);
  t.diagnostic(`fronts per unit reckoned: ${at60.toFixed(4)} at 60 frames a second, ${at10.toFixed(4)} at 10 (MAX_FRAME_MS ${MAX_FRAME_MS.toFixed(1)} ms)`);
  assert.ok(at10 < at60 * 1.4 && at10 > at60 / 1.4, `within 40% of each other (${(at10 / at60).toFixed(2)}x)`);
});

test('in a cascade of 150 orders a second the fronts\' median energy stays under an ordinary day\'s 95th percentile, and the reckoning within one wave of the fast ceiling', t => {
  const calm = drive(3, 20, 11), flood = drive(150, 20, 12);
  const sorted = (a: number[]): number[] => [...a].sort((x, y) => x - y), p = (a: number[], q: number): number => sorted(a)[Math.floor(q * (a.length - 1))]!;
  const calmTop = p(calm.fronts.slice(60), 0.95), floodMid = p(flood.fronts.slice(180), 0.5), floodTop = p(flood.fronts.slice(180), 0.95);
  t.diagnostic(`fronts' energy: an ordinary day at its 95th percentile ${calmTop.toFixed(3)}; the cascade at its median ${floodMid.toFixed(3)}, at its 95th ${floodTop.toFixed(3)}`);
  assert.ok(floodMid < calmTop, `the cascade's usual frame holds less than an ordinary day's busiest (${(floodMid / calmTop).toFixed(2)}x)`);
  assert.ok(Math.max(...flood.reckoned.slice(180)) < ENERGY_MAX + pulseFor(1e12, 25_000).amp ** 2 * (pulseFor(1e12, 25_000).width / CELL) ** 2, 'and its reckoning never passes the ceiling by more than one wave');
});

test('the Strength runs from a quarter of the middle\'s gain to four times it, evenly by ratio; a saved one is read within its range', () => {
  assert.equal(strengthGain(0), STRENGTH_MID_GAIN / 4); assert.equal(strengthGain(50), STRENGTH_MID_GAIN); assert.equal(strengthGain(100), STRENGTH_MID_GAIN * 4);
  assert.ok(Math.abs(strengthGain(25) / strengthGain(0) - strengthGain(100) / strengthGain(75)) < 1e-12, 'even steps are even ratios');
  assert.equal(strengthGain(Number.NaN), strengthGain(WAVE_STRENGTH_DEFAULT));
  assert.equal(readWaveStrength(undefined), WAVE_STRENGTH_DEFAULT); assert.equal(readWaveStrength('70'), WAVE_STRENGTH_DEFAULT);
  assert.equal(readWaveStrength(250), 100); assert.equal(readWaveStrength(-3), 0); assert.equal(readWaveStrength(42.4), 42);
});

test('a page opens with the default Strength, or the one it saved', () => {
  const saved = (blob: Record<string, unknown> | null): number => {
    const real = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { innerWidth: 1600, localStorage: { getItem: () => blob ? JSON.stringify(blob) : null, setItem: () => {} } };
    try { return initialState().waveStrength; } finally { if (real === undefined) delete (globalThis as { window?: unknown }).window; else (globalThis as { window?: unknown }).window = real; }
  };
  assert.equal(saved(null), WAVE_STRENGTH_DEFAULT, 'a first visit');
  assert.equal(saved({ material: 'glass' }), WAVE_STRENGTH_DEFAULT, 'a save from before there was a Strength');
  assert.equal(saved({ waveStrength: 80 }), 80, 'a choice');
  assert.equal(saved({ waveStrength: 'loud' }), WAVE_STRENGTH_DEFAULT, 'nonsense');
});
