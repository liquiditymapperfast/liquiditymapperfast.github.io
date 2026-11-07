import type { Bounds } from '../view.ts';
import { STRIDE, type TapeRing } from './ring.ts';
import { built, startProgram, uniforms, type Building } from '../gl-build.ts';

/**
 * The trade dust on the graphics card: a canvas of its own between the heatmap and the overlay (candles, bubbles and lines stay above it).
 *
 * Every order in view is drawn into an off-screen float picture whose pixels add up the USD bought and sold over them (`#accumulate`: a
 * small disc (1 to 3 CSS px) at the order's time and price, with a hairline from the lowest to the highest price an order that walked the book reached),
 * and that picture is shown in one pass (`#composite`): the colour of the side that bought or sold more there, and an opacity that grows
 * with the logarithm of the volume against fixed sizes of the coin (never against the largest in view, so zooming does not repaint every
 * dot). Where orders crowd together they add up in the pixel instead of hiding each other: volume is never thrown away. Orders that
 * arrived in the last `ACCENT_MS` are drawn once more on top, larger and brighter, fading out (`#accent`).
 *
 * The float picture is wider than the screen (`WIDE`) and is shown shifted by whole pixels, so a map following the live edge (its window
 * moving right a little on every frame) reuses it: it is redrawn whole only when the zoom, the prices in view or the venues shown change, or
 * the window has moved past its end; new orders are added to it as they arrive. The accent is the only thing animated, and only while one
 * is fading.
 */
export const ACCENT_MS = 400;
/** The float picture's width over the screen's, and where the screen starts in it (as shares of the screen's width). */
const WIDE = 1.35, LEAD = 0.05;

const QUAD = `
  // One point sprite around the order: its disc and, for an order that walked the book, its hairline (as far as a sprite reaches).
  float x = (rec0.x - view.x) / (view.y - view.x) * px.x;
  float y = (rec0.y - view.z) / (view.w - view.z) * px.y;
  float ylo = (rec1.y - view.z) / (view.w - view.z) * px.y, yhi = (rec1.z - view.z) / (view.w - view.z) * px.y;
  float a = abs(rec0.z);
  float r = mix(size.x, size.y, clamp(log(max(a, 1.0) / size.z) / log(size.w / size.z), 0.0, 1.0)) * grow;
  bool off = texelFetch(mask, ivec2(int(rec1.x), 0), 0).r > 0.5 || x < -8.0 || x > px.x + 8.0 || max(y, yhi) < -8.0 || min(y, ylo) > px.y + 8.0;
  // The hairline of an order that walked the book is drawn at most 48 device px either side: a sprite as tall as a long walk at a deep
  // zoom would cost the card a quarter of a million pixels per order.
  float reach = min(max(r + 1.0, max(y - ylo, yhi - y) + 1.0), 48.0);
  centre = vec3(x, y, r); span = vec2(ylo, yhi); usd = rec0.z; extent = reach;
  gl_PointSize = 2.0 * reach;
  gl_Position = off ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(vec2(x, y) / px * 2.0 - 1.0, 0.0, 1.0);`;

const COVER = `
  vec2 pix = centre.xy + (vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y) - 0.5) * 2.0 * extent;
  float d = length(pix - centre.xy);
  float disc = clamp(centre.z + 0.5 - d, 0.0, 1.0);
  float stalk = (span.y - span.x > 1.0 && abs(pix.x - centre.x) < 0.6 && pix.y >= span.x && pix.y <= span.y) ? 0.7 : 0.0;
  float cover = max(disc, stalk);
  if (cover <= 0.0) discard;`;

const ACC_VERT = `#version 300 es
layout(location = 0) in vec3 rec0; layout(location = 1) in vec3 rec1;
uniform vec4 view; uniform vec2 px; uniform vec4 size; uniform sampler2D mask; uniform float grow;
out vec3 centre; out vec2 span; out float usd; out float extent;
void main() {${QUAD}
}`;
const ACC_FRAG = `#version 300 es
precision highp float;
in vec3 centre; in vec2 span; in float usd; in float extent; out vec4 color;
uniform float unit;
void main() {${COVER}
  float a = abs(usd) / unit * cover;
  color = usd > 0.0 ? vec4(a, 0.0, cover, 0.0) : vec4(0.0, a, cover, 0.0);
}`;

const FULL_VERT = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const COMP_FRAG = `#version 300 es
precision highp float;
out vec4 color;
uniform sampler2D acc; uniform vec3 bidC, askC, mid, rim; uniform vec4 range; // log low, log high, opacity, floor alpha
uniform float unit; uniform int shift, reach;
void main() {
  ivec2 at = ivec2(int(gl_FragCoord.x) + shift, int(gl_FragCoord.y));
  vec4 v = texelFetch(acc, at, 0);
  float vol = (v.r + v.g) * unit;
  if (vol <= 0.0) {
    // A thin rim in the background's colour around the dust, so dots read over the brightest heatmap colours.
    for (int dy = -reach; dy <= reach; dy++) for (int dx = -reach; dx <= reach; dx++) {
      vec4 n = texelFetch(acc, at + ivec2(dx, dy), 0);
      if (n.r + n.g > 0.0) { color = vec4(rim, 0.6 * range.z); return; }
    }
    discard;
  }
  float share = v.r / (v.r + v.g), lean = abs(2.0 * share - 1.0);
  vec3 c = mix(mid, share >= 0.5 ? bidC : askC, 0.35 + 0.65 * lean);
  float s = clamp((log(vol) - range.x) / (range.y - range.x), 0.0, 1.0);
  color = vec4(c, range.z * mix(range.w, 1.0, s));
}`;
const ACCENT_FRAG = `#version 300 es
precision highp float;
in vec3 centre; in vec2 span; in float usd; in float extent; out vec4 color;
uniform vec3 bidC, askC; uniform float fade;
void main() {${COVER}
  vec3 c = mix(usd > 0.0 ? bidC : askC, vec3(1.0), 0.45);
  color = vec4(c, fade * cover * 0.9);
}`;

export interface DustStyle {
  /** `rim`: the thin edge around the dust (the background's colour). */
  bid: [number, number, number]; ask: [number, number, number]; mid: [number, number, number]; rim: [number, number, number];
  /** Orders this size (USD) and smaller are the smallest dot, `ceilUsd` and larger the largest; `volLo`..`volHi` USD a pixel span the opacity ramp. */
  floorUsd: number; ceilUsd: number; volLo: number; volHi: number;
  opacity: number;
}

/**
 * What the float picture was drawn for: its time at pixel 0 and its milliseconds a pixel, the prices, everything else (`key`), and the
 * orders it holds; redrawn whole when any of it changes or the screen no longer fits inside it.
 */
interface Drawn { t0: number; msPx: number; p0: number; p1: number; key: string; upTo: number; epoch: number }

export class TapeGL {
  readonly gl: WebGL2RenderingContext;
  #acc: WebGLProgram; #comp: WebGLProgram; #accent: WebGLProgram;
  #vao: WebGLVertexArrayObject; #buffer: WebGLBuffer;
  #fbo: WebGLFramebuffer; #tex: WebGLTexture; #mask: WebGLTexture;
  #loc = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  /** The programs the card is still building (gl-build.ts) and the uniforms to read from each once built; null once they are. */
  #building: (readonly [Building, readonly string[]])[] | null;
  /** Records on the card: the write number up to which, and the ring's epoch they were copied for. */
  #uploaded = 0; #uploadedEpoch = -1;
  #drawn: Drawn | null = null;
  /** The screen's size and the float picture's, in device pixels. */
  #size: [number, number] = [0, 0]; #wide = 0;
  /** USD a float unit stands for: 1 with full float, more with half floats (they top out at 65,504). */
  readonly unit: number;
  readonly #halfOnly: boolean;
  #maskKey = '';

  constructor(readonly canvas: HTMLCanvasElement, readonly ring: TapeRing) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true, antialias: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    // A float picture that can be added into: full floats where the card can blend them, half floats otherwise.
    const float = gl.getExtension('EXT_color_buffer_float') !== null, blend32 = float && gl.getExtension('EXT_float_blend') !== null;
    if (!float && gl.getExtension('EXT_color_buffer_half_float') === null) throw new Error('float render targets unavailable');
    this.#halfOnly = !blend32; this.unit = blend32 ? 1 : 10_000;
    // Built beside the page (gl-build.ts): nothing is drawn until `built` finds them done.
    const quad = ['view', 'px', 'size', 'mask', 'grow'];
    const acc = startProgram(gl, ACC_VERT, ACC_FRAG), comp = startProgram(gl, FULL_VERT, COMP_FRAG), accent = startProgram(gl, ACC_VERT, ACCENT_FRAG);
    this.#acc = acc.program; this.#comp = comp.program; this.#accent = accent.program;
    this.#building = [[acc, [...quad, 'unit']], [comp, ['acc', 'bidC', 'askC', 'mid', 'rim', 'range', 'unit', 'shift', 'reach']], [accent, [...quad, 'bidC', 'askC', 'fade']]];
    this.#buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.bufferData(gl.ARRAY_BUFFER, ring.data.byteLength, gl.DYNAMIC_DRAW);
    this.#vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.#vao);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE * 4, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE * 4, 12);
    gl.bindVertexArray(null);
    this.#tex = gl.createTexture()!;
    this.#fbo = gl.createFramebuffer()!;
    this.#mask = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.#mask);
    for (const tex of [this.#tex, this.#mask]) { gl.bindTexture(gl.TEXTURE_2D, tex); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); }
    this.setMask([]);
  }

  /**
   * Whether the programs are built and their uniforms read: false while the card still builds them (asked without waiting, gl-build.ts).
   * Throws what failed. Nothing is drawn before it is true.
   */
  built(): boolean {
    const building = this.#building; if (!building) return true;
    if (!built(this.gl, building.map(([b]) => b))) return false;
    for (const [b, names] of building) this.#loc.set(b.program, uniforms(this.gl, b.program, names));
    this.#building = null;
    return true;
  }

  /** Size the canvas (CSS px times the pixel ratio) and the float picture with it. */
  resize(width: number, height: number, dpr: number): void {
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr)), gl = this.gl;
    if (this.canvas.width === w && this.canvas.height === h && this.#size[0] === w) return;
    this.canvas.width = w; this.canvas.height = h; this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
    const wide = Math.ceil(w * WIDE);
    gl.bindTexture(gl.TEXTURE_2D, this.#tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.#halfOnly ? gl.RGBA16F : gl.RGBA32F, wide, h, 0, gl.RGBA, this.#halfOnly ? gl.HALF_FLOAT : gl.FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.#tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.#size = [w, h]; this.#wide = wide; this.#drawn = null;
  }

  /** The markets not drawn (venues switched off, outside the filter), by the ring's index. */
  setMask(hidden: readonly number[]): void {
    // An empty mask has a key of its own ('-'), as the trail's (candle/trail-gl.ts): compared with '' it never matched, so every frame with
    // no venue hidden sent the mask again and drew every order of the ring afresh instead of only the new ones.
    const key = hidden.join(',') || '-'; if (key === this.#maskKey) return;
    this.#maskKey = key;
    const gl = this.gl, row = new Uint8Array(1024); for (const k of hidden) if (k >= 0 && k < 1024) row[k] = 255;
    gl.bindTexture(gl.TEXTURE_2D, this.#mask); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1024, 1, 0, gl.RED, gl.UNSIGNED_BYTE, row);
    this.#drawn = null;
  }

  /** Copy to the card what the ring wrote since the last call (all of it after a rebase or a clear). */
  #upload(): void {
    const gl = this.gl, ring = this.ring;
    if (this.#uploadedEpoch !== ring.epoch) { this.#uploadedEpoch = ring.epoch; this.#uploaded = ring.first; this.#drawn = null; }
    let from = Math.max(this.#uploaded, ring.first);
    if (from >= ring.written) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    while (from < ring.written) {
      const slot = from % ring.capacity, n = Math.min(ring.written - from, ring.capacity - slot);
      gl.bufferSubData(gl.ARRAY_BUFFER, slot * STRIDE * 4, ring.data, slot * STRIDE, n * STRIDE);
      from += n;
    }
    this.#uploaded = ring.written;
  }

  #uniforms(program: WebGLProgram, view: Bounds, style: DustStyle, dpr: number, grow: number, width: number): Map<string, WebGLUniformLocation | null> {
    const gl = this.gl, l = this.#loc.get(program)!, ring = this.ring;
    gl.useProgram(program);
    // Relative to the ring's bases, in float64 here, so the card never sees an epoch millisecond.
    gl.uniform4f(l.get('view')!, view.t0 - ring.t0, view.t1 - ring.t0, view.p0 - ring.p0, view.p1 - ring.p0);
    gl.uniform2f(l.get('px')!, width, this.#size[1]);
    gl.uniform4f(l.get('size')!, 1 * dpr, 3 * dpr, style.floorUsd, style.ceilUsd);
    gl.uniform1f(l.get('grow')!, grow);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.#mask); gl.uniform1i(l.get('mask')!, 1);
    return l;
  }

  /** Draw the points of write numbers [from, to) (in at most two runs when they wrap round the ring). */
  #instances(from: number, to: number): void {
    const gl = this.gl, ring = this.ring;
    from = Math.max(from, ring.first);
    while (from < to) {
      const slot = from % ring.capacity, n = Math.min(to - from, ring.capacity - slot);
      gl.drawArrays(gl.POINTS, slot, n);
      from += n;
    }
  }

  /** Add the orders [from, to) that may be in view to the float picture (cleared first when `clear`). */
  #accumulate(view: Bounds, style: DustStyle, dpr: number, from: number, to: number, clear: boolean): void {
    // An order is drawn a few pixels either side of its time: the runs are asked for a little wider than the view.
    const pad = (view.t1 - view.t0) * 0.01;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo);
    gl.viewport(0, 0, this.#wide, this.#size[1]);
    if (clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    const l = this.#uniforms(this.#acc, view, style, dpr, 1, this.#wide);
    gl.uniform1f(l.get('unit')!, this.unit);
    gl.bindVertexArray(this.#vao);
    for (const [a, b] of this.ring.runs(view.t0 - pad, view.t1 + pad)) if (b > from && a < to) this.#instances(Math.max(a, from), Math.min(b, to));
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Draw the dust for `view` (`key` names everything else the float picture depends on: the venues shown, the style, the size). Returns
   * whether an accent is still fading, or the programs are still being built (`built`): the caller asks for another frame.
   */
  draw(view: Bounds, style: DustStyle, dpr: number, key: string, now: number): boolean {
    const gl = this.gl, ring = this.ring;
    if (!this.built()) return true;
    // A view with no time or no price range yet (the first frames) has nowhere to put an order.
    if (!(view.t1 > view.t0) || !(view.p1 > view.p0)) { this.clear(); return false; }
    this.#upload();
    const w = this.#size[0], msPx = (view.t1 - view.t0) / w, d = this.#drawn, near = (a: number, b: number): boolean => Math.abs(a - b) <= Math.abs(b) * 1e-9;
    let shift = d ? Math.round((view.t0 - d.t0) / d.msPx) : 0;
    if (!d || d.key !== key || d.epoch !== ring.epoch || !near(d.msPx, msPx) || !near(d.p0, view.p0) || !near(d.p1, view.p1) || shift < 0 || shift + w > this.#wide) {
      const t0 = view.t0 - LEAD * w * msPx;
      this.#drawn = { t0, msPx, p0: view.p0, p1: view.p1, key, upTo: ring.written, epoch: ring.epoch };
      this.#accumulate(this.#wideView(), style, dpr, ring.first, ring.written, true);
      shift = Math.round((view.t0 - t0) / msPx);
    } else if (d.upTo < ring.written) {
      this.#accumulate(this.#wideView(), style, dpr, d.upTo, ring.written, false);
      d.upTo = ring.written;
    }
    gl.viewport(0, 0, this.#size[0], this.#size[1]);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const c = this.#loc.get(this.#comp)!;
    gl.useProgram(this.#comp);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#tex); gl.uniform1i(c.get('acc')!, 0);
    gl.uniform3fv(c.get('bidC')!, style.bid); gl.uniform3fv(c.get('askC')!, style.ask); gl.uniform3fv(c.get('mid')!, style.mid);
    gl.uniform4f(c.get('range')!, Math.log(style.volLo), Math.log(style.volHi), style.opacity, 0.45);
    gl.uniform3fv(c.get('rim')!, style.rim); gl.uniform1i(c.get('reach')!, Math.max(1, Math.round(dpr)));
    gl.uniform1f(c.get('unit')!, this.unit); gl.uniform1i(c.get('shift')!, shift);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // The accent: each recent batch once more, larger and brighter, fading over ACCENT_MS.
    let fading = false;
    for (const a of ring.arrivals) {
      const age = now - a.at; if (age < 0 || age >= ACCENT_MS) continue;
      fading = true;
      const k = 1 - age / ACCENT_MS, l = this.#uniforms(this.#accent, view, style, dpr, 1 + 1.6 * k, w);
      gl.uniform3fv(l.get('bidC')!, style.bid); gl.uniform3fv(l.get('askC')!, style.ask); gl.uniform1f(l.get('fade')!, k * k);
      gl.bindVertexArray(this.#vao); this.#instances(a.from, a.to); gl.bindVertexArray(null);
    }
    return fading;
  }

  /** The window the float picture covers. */
  #wideView(): Bounds { const d = this.#drawn!; return { t0: d.t0, t1: d.t0 + d.msPx * this.#wide, p0: d.p0, p1: d.p1 }; }

  clear(): void { const gl = this.gl; gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); this.#drawn = null; }
}
