import test from 'node:test';
import assert from 'node:assert/strict';
import { HeatCanvas, cellColours, heatPlacement, heatRenderer, shade } from '../src/app/heatmap/canvas.ts';
import type { HeatStyle } from '../src/app/heatmap/gl.ts';
import { buildLut } from '../src/app/heatmap/lut.ts';

// The heatmap without WebGL (2026-11-14: a visitor's Chrome gave the page no WebGL2 and the page stopped). The 2D picture must be the
// shader's picture, and a browser without WebGL2 must get it rather than an error.

const STYLE: HeatStyle = { bid: [0.1, 0.7, 0.4], bidSoft: [0.05, 0.25, 0.15], ask: [0.9, 0.2, 0.3], askSoft: [0.35, 0.08, 0.12], min: 5e4, max: 5e7, opacity: 1, mode: 'size' };

/**
 * The fragment shader of gl.ts written out again, blended as WebGL blends it over a cleared canvas (SRC_ALPHA, ONE_MINUS_SRC_ALPHA, RGBA8).
 * Null where the shader discards the cell (a faint cell it draws can still round to nothing).
 */
function shaderPixel(style: HeatStyle, lut: Uint8Array, bid: number, ask: number): number[] | null {
  const total = bid + ask;
  if (!(total > 0)) return null;
  let c: number[], a: number;
  if (style.mode === 'size') {
    const lo = Math.log(Math.max(style.min, 1)), hi = Math.log(Math.max(style.max, style.min * 1.0001 + 1));
    const s = (Math.log(total) - lo) / Math.max(hi - lo, 1e-6);
    if (!(s > 0)) return null;
    // texture(lut, vec2(clamp(s, 0, 1), 0.5)): LINEAR, CLAMP_TO_EDGE, texel i centred on (i + 0.5) / 256.
    const u = Math.min(1, Math.max(0, s)) * 256 - 0.5, i0 = Math.floor(u), f = u - i0;
    const tex = (i: number, ch: number) => lut[Math.min(255, Math.max(0, i)) * 4 + ch]! / 255;
    c = [0, 1, 2].map(ch => tex(i0, ch) * (1 - f) + tex(i0 + 1, ch) * f);
    const t = Math.min(1, Math.max(0, s / 0.06));
    a = t * t * (3 - 2 * t) * style.opacity;
  } else {
    const isAsk = ask > bid, x = Math.min(1, Math.max(0, (Math.max(bid, ask) - style.min) / Math.max(style.max - style.min, 1e-6)));
    if (!(x > 0)) return null;
    const soft = isAsk ? style.askSoft : style.bidSoft, strong = isAsk ? style.ask : style.bid;
    c = [0, 1, 2].map(ch => soft[ch]! + (strong[ch]! - soft[ch]!) * x);
    a = Math.pow(x, 0.75) * style.opacity;
  }
  return [...c.map(v => Math.round(v * a * 255)), Math.round(a * a * 255)];
}

function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x + 0x6d2b79f5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A grid with every kind of cell: empty, one side only, equal sides, below, inside and above the window, and huge. */
function grid(w: number, h: number, seed: number): Float32Array {
  const rnd = seeded(seed), out = new Float32Array(w * h * 2);
  for (let i = 0; i < w * h; i++) {
    const kind = rnd();
    const usd = () => 10 ** (rnd() * 10);
    if (kind < 0.2) continue;
    if (kind < 0.35) out[i * 2] = usd();
    else if (kind < 0.5) out[i * 2 + 1] = usd();
    else if (kind < 0.55) { const v = usd(); out[i * 2] = v; out[i * 2 + 1] = v; }
    else if (kind < 0.57) { out[i * 2] = 1e12; out[i * 2 + 1] = 3e11; }
    else { out[i * 2] = usd(); out[i * 2 + 1] = usd(); }
  }
  return out;
}

test('a cell is shaded as the shader leaves it on its canvas: colour times alpha, at alpha squared', () => {
  const lut = buildLut(true);
  // Above the window: the ramp's top colour at full alpha (the opacity).
  const top = shade({ ...STYLE, opacity: 0.8 }, lut, 3, false)!;
  for (let ch = 0; ch < 3; ch++) assert.ok(Math.abs(top[ch]! - lut[255 * 4 + ch]! * 0.8) < 1e-9);
  assert.ok(Math.abs(top[3]! - 0.64 * 255) < 1e-9);
  // Halfway up the fade-in at the window's low end: smoothstep(0, 0.06, 0.03) = 0.5.
  assert.ok(Math.abs(shade(STYLE, lut, 0.03, false)![3]! - 0.25 * 255) < 1e-9);
  // Sides: halfway between the soft and strong ask colours, at alpha 0.5^0.75.
  const half = shade({ ...STYLE, mode: 'sides' }, lut, 0.5, true)!, a = 0.5 ** 0.75;
  for (let ch = 0; ch < 3; ch++) assert.ok(Math.abs(half[ch]! - (STYLE.askSoft[ch]! + STYLE.ask[ch]!) / 2 * a * 255) < 1e-9);
  assert.ok(Math.abs(half[3]! - a * a * 255) < 1e-9);
  // At or below the window's low end the shader discards the cell.
  assert.equal(shade(STYLE, lut, 0, false), null);
  assert.equal(shade(STYLE, lut, -1, true), null);
  assert.equal(shade(STYLE, lut, Number.NaN, true), null);
});

test('the 2D colouring is the shader\'s picture, cell for cell, in both styles, palettes and at a fade', () => {
  const w = 97, h = 61;
  for (const dark of [true, false]) {
    const lut = buildLut(dark);
    for (const mode of ['size', 'sides'] as const) {
      for (const opacity of [1, 0.8, 0.3]) {
        const style = { ...STYLE, mode, opacity }, g = grid(w, h, 7 + (dark ? 1 : 0)), px = new Uint8Array(cellColours(g, w, h, style, lut).buffer);
        let worst = 0, drawn = 0;
        for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
          const i = row * w + col, want = shaderPixel(style, lut, g[i * 2]!, g[i * 2 + 1]!), o = ((h - 1 - row) * w + col) * 4;
          const got = [px[o]!, px[o + 1]!, px[o + 2]!, px[o + 3]!];
          if (!want) { assert.deepEqual(got, [0, 0, 0, 0], `${mode} ${dark} discarded cell ${row},${col}`); continue; }
          drawn++;
          for (let ch = 0; ch < 4; ch++) worst = Math.max(worst, Math.abs(got[ch]! - want[ch]!));
        }
        assert.ok(drawn > w * h * 0.3, `${mode}: most cells are drawn (${drawn})`);
        assert.ok(worst <= 1, `${mode} dark=${dark} opacity=${opacity}: at most one level from the shader (worst ${worst})`);
      }
    }
  }
});

test('the image\'s top row is the grid\'s last row (the highest price), and it lands on the plot where the shader draws the grid', () => {
  const w = 5, h = 4, g = new Float32Array(w * h * 2);
  g[(0 * w + 3) * 2] = 1e9;
  const px = new Uint32Array(cellColours(g, w, h, STYLE, buildLut(true)));
  assert.notEqual(px[(h - 1) * w + 3], 0);
  assert.equal(px.filter(v => v !== 0).length, 1);
  const view = { t0: 1000, t1: 2000, p0: 100, p1: 200 };
  assert.deepEqual(heatPlacement(view, view, 800, 400), { x: 0, y: 0, w: 800, h: 400 });
  // The page rasters 20 % beyond the view on each side.
  const at = heatPlacement(view, { t0: 800, t1: 2200, p0: 80, p1: 220 }, 800, 400);
  assert.ok(Math.abs(at.x + 160) < 1e-9 && Math.abs(at.y + 80) < 1e-9 && Math.abs(at.w - 1120) < 1e-9 && Math.abs(at.h - 560) < 1e-9);
});

/** A canvas as far as the renderers touch it: `webgl` is what getContext('webgl2') gives. */
function fakeCanvas(webgl: unknown) {
  const ctx2d = { setTransform() {}, clearRect() {} };
  let mode: string | null = null;
  const canvas = {
    replaced: null as unknown,
    width: 300, height: 150,
    getContext(kind: string) {
      if (kind === 'webgl2') { if (mode && mode !== 'webgl2') return null; if (!webgl) return null; mode = 'webgl2'; return webgl; }
      if (kind === '2d') { if (mode && mode !== '2d') return null; mode = '2d'; return ctx2d; }
      return null;
    },
    cloneNode() { return fakeCanvas(null); },
    replaceWith(other: unknown) { canvas.replaced = other; },
    listening: [] as string[],
    addEventListener(type: string) { canvas.listening.push(type); },
  };
  return canvas;
}

test('a browser without WebGL2 gets the heatmap on a 2D canvas, not an error', t => {
  const said: string[] = [];
  t.mock.method(console, 'info', (...args: unknown[]) => { said.push(args.join(' ')); });
  const canvas = fakeCanvas(null);
  const renderer = heatRenderer(canvas as unknown as HTMLCanvasElement);
  assert.ok(renderer instanceof HeatCanvas);
  assert.equal(renderer.cause, 'no-webgl2', 'the page says how to turn acceleration on');
  assert.deepEqual(canvas.listening.sort(), ['contextlost', 'contextrestored'], 'a canvas the browser discards is drawn again');
  assert.equal(renderer.canvas, canvas as unknown as HTMLCanvasElement, 'the same element: it gave WebGL no context');
  assert.equal(canvas.replaced, null);
  assert.equal(said.length, 1);
  assert.match(said[0]!, /2D canvas/);
  assert.equal(renderer.coverage, null);
  assert.equal(renderer.maxSize, 4096);
});

test('a WebGL2 context that cannot draw the heatmap is let go, and the 2D picture takes a fresh element in its place', t => {
  t.mock.method(console, 'info', () => {});
  let lost = false;
  const gl = {
    createShader: () => ({}), shaderSource() {}, compileShader() {}, getShaderParameter: () => false, getShaderInfoLog: () => 'shader refused',
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext() { lost = true; } } : null),
  };
  const canvas = fakeCanvas(gl);
  const renderer = heatRenderer(canvas as unknown as HTMLCanvasElement);
  assert.ok(lost, 'the context is let go');
  assert.ok(renderer instanceof HeatCanvas);
  assert.equal(renderer.cause, 'failed', 'WebGL2 was there: not a matter of turning acceleration on');
  assert.notEqual(renderer.canvas, canvas as unknown as HTMLCanvasElement);
  assert.equal(canvas.replaced, renderer.canvas, 'the fresh element takes the old one\'s place');
});

test('a window wholly below $1 colours every drawn cell at the ramp\'s top, as the shader does, and never throws (review r14)', () => {
  const lut = buildLut(true), w = 31, h = 17, g = grid(w, h, 3);
  for (const [min, max] of [[-5, 0.5], [-1, 1e-9], [-0.001, 0.001], [0, 0]]) {
    const style = { ...STYLE, min, max }, px = new Uint8Array(cellColours(g, w, h, style, lut).buffer);
    let drawn = 0;
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
      const i = row * w + col, want = shaderPixel(style, lut, g[i * 2]!, g[i * 2 + 1]!), o = ((h - 1 - row) * w + col) * 4;
      const got = [px[o]!, px[o + 1]!, px[o + 2]!, px[o + 3]!];
      if (!want) { assert.deepEqual(got, [0, 0, 0, 0], `[${min}, ${max}] cell ${row},${col}`); continue; }
      drawn++;
      for (let ch = 0; ch < 4; ch++) assert.ok(Math.abs(got[ch]! - want[ch]!) <= 1, `[${min}, ${max}] cell ${row},${col}: ${got} against ${want}`);
    }
    assert.ok(drawn > 0, `[${min}, ${max}] draws its cells above $1`);
  }
});
