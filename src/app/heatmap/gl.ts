import type { Bounds } from '../view.ts';

export interface HeatStyle {
  bid: [number, number, number]; bidSoft: [number, number, number];
  ask: [number, number, number]; askSoft: [number, number, number];
  /** USD window mapped onto the colour ramp: log-scaled for 'bookmap', linear for 'sides'. */
  min: number; max: number; opacity: number; mode: 'bookmap' | 'sides';
}

const VERT = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 uv; out vec4 color;
uniform sampler2D grid;
uniform sampler2D lut;
uniform vec4 view;   // t0, t1, p0, p1 of the screen
uniform vec4 tex;    // t0, t1, p0, p1 covered by the texture
uniform vec4 range;  // min, max, opacity, mode (0 = size ramp, 1 = two hues)
uniform vec3 bidC, bidS, askC, askS;
uniform vec4 fill;   // boundary and sample time (ms from the view origin), enabled, unused
uniform vec3 fillRgb; // the grey the backfilled levels are drawn in
void main() {
  float t = mix(view.x, view.y, uv.x);
  // Before the first recorded column there is no history. With the fill on, the current book is drawn there in grey instead of colour:
  // the same sizes on the same scale (a bigger wall is a darker grey), but never a colour, so what is real and what is backfilled cannot
  // be mistaken for each other. It is a picture, not data, and only this shader ever sees it.
  bool back = fill.z > 0.5 && t < fill.x;
  if (back) t = fill.y;
  float p = mix(view.z, view.w, uv.y);
  vec2 q = vec2((t - tex.x) / (tex.y - tex.x), (p - tex.z) / (tex.w - tex.z));
  if (q.x < 0.0 || q.x >= 1.0 || q.y < 0.0 || q.y >= 1.0) discard;
  ivec2 size = textureSize(grid, 0);
  vec2 v = texelFetch(grid, ivec2(q * vec2(size)), 0).rg;
  float total = v.r + v.g;
  if (total <= 0.0) discard;
  if (range.w < 0.5) {
    // One ramp for size, log-scaled; cells below the window stay background so the ramp's zero colour never shows as a box.
    float lo = log(max(range.x, 1.0)), hi = log(max(range.y, range.x * 1.0001 + 1.0));
    float s = (log(total) - lo) / max(hi - lo, 1e-6);
    if (s <= 0.0) discard;
    if (back) { color = vec4(fillRgb, (0.16 + 0.74 * clamp(s, 0.0, 1.0)) * smoothstep(0.0, 0.06, s) * range.z); return; }
    color = vec4(texture(lut, vec2(clamp(s, 0.0, 1.0), 0.5)).rgb, smoothstep(0.0, 0.06, s) * range.z);
    return;
  }
  bool isAsk = v.g > v.r;
  float a = clamp((max(v.r, v.g) - range.x) / max(range.y - range.x, 1e-6), 0.0, 1.0);
  if (a <= 0.0) discard;
  vec3 c = mix(isAsk ? askS : bidS, isAsk ? askC : bidC, a);
  if (back) { color = vec4(fillRgb, (0.16 + 0.74 * a) * range.z); return; }
  color = vec4(c, pow(a, 0.75) * range.z);
}`;

/** Draws a bid/ask USD grid texture as a colour-mapped heatmap. */
export class HeatGL {
  readonly gl: WebGL2RenderingContext;
  #program: WebGLProgram;
  #texture: WebGLTexture;
  #lut: WebGLTexture;
  #loc: Record<string, WebGLUniformLocation | null> = {};
  #bounds: Bounds | null = null;
  #size: [number, number] = [0, 0];

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is required for the heatmap');
    this.gl = gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader compile failed');
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'program link failed');
    this.#program = program;
    for (const name of ['grid', 'lut', 'view', 'tex', 'range', 'bidC', 'bidS', 'askC', 'askS', 'fill', 'fillRgb']) this.#loc[name] = gl.getUniformLocation(program, name);
    this.#texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.#lut = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.#lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Install the 256×1 RGBA8 colour ramp used by the 'bookmap' style. */
  setLut(rgba: Uint8Array): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.#lut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  get maxSize(): number { return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number; }
  get coverage(): Bounds | null { return this.#bounds; }

  upload(grid: Float32Array, w: number, h: number, bounds: Bounds): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, grid);
    this.#bounds = bounds; this.#size = [w, h];
  }

  resize(width: number, height: number, dpr: number): void {
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  clear(): void {
    const { gl } = this;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** `fill`: before `boundary` (epoch ms) draw the book at `sample` in the grey `rgb`, as a placeholder for history that was never recorded. */
  draw(view: Bounds, style: HeatStyle, fill?: { boundary: number; sample: number; rgb: [number, number, number] } | null): void {
    const { gl } = this;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.#bounds || this.#size[0] === 0) return;
    gl.useProgram(this.#program);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.#lut);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    const b = this.#bounds, l = this.#loc;
    gl.uniform1i(l.grid!, 0); gl.uniform1i(l.lut!, 1);
    // Absolute epoch-ms exceed float32 precision (~2 min at 1.8e12); send everything relative to the view origin.
    gl.uniform4f(l.view!, 0, view.t1 - view.t0, 0, view.p1 - view.p0);
    gl.uniform4f(l.tex!, b.t0 - view.t0, b.t1 - view.t0, b.p0 - view.p0, b.p1 - view.p0);
    gl.uniform4f(l.range!, style.min, style.max, style.opacity, style.mode === 'bookmap' ? 0 : 1);
    gl.uniform4f(l.fill!, fill ? fill.boundary - view.t0 : 0, fill ? fill.sample - view.t0 : 0, fill ? 1 : 0, 0);
    gl.uniform3fv(l.fillRgb!, fill ? fill.rgb : [0.5, 0.5, 0.5]);
    gl.uniform3fv(l.bidC!, style.bid); gl.uniform3fv(l.bidS!, style.bidSoft);
    gl.uniform3fv(l.askC!, style.ask); gl.uniform3fv(l.askS!, style.askSoft);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
