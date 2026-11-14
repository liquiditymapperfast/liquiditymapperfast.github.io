import type { Bounds } from '../view.ts';
import { HeatGL, type HeatRenderer, type HeatStyle } from './gl.ts';

/**
 * The heatmap's renderer: WebGL2 where the browser gives the page a WebGL2 context, else the same picture on a 2D canvas (2026-11-14: on a
 * visitor's Chrome on Windows 11 the page stopped at "WebGL2 is required for the heatmap"). A browser can give a page no WebGL2 when
 * hardware acceleration is off, when the graphics card or its driver is blocked, or after the card has failed on the site, and Chrome is
 * withdrawing the software WebGL (SwiftShader) it used to give instead (deprecated since Chrome 130). A canvas that gave WebGL its context
 * before the renderer failed keeps that context and can give no other, so the 2D picture goes on a fresh copy of the element, put in its
 * place: the caller takes the renderer's `canvas`.
 */
export function heatRenderer(canvas: HTMLCanvasElement): HeatRenderer {
  try { return new HeatGL(canvas); } catch (error) {
    console.info(`The heatmap is drawn on a 2D canvas: ${error instanceof Error ? error.message : String(error)}`);
  }
  let target = canvas;
  if (!canvas.getContext('2d')) { target = canvas.cloneNode(false) as HTMLCanvasElement; canvas.replaceWith(target); }
  return new HeatCanvas(target);
}

/** How finely the colouring tables split the colour window: 4,096 steps, a step a small part of one 8-bit level of the picture. */
const STEPS = 4096;

/**
 * The heatmap drawn without WebGL. Each cell of the grid is coloured as the shader colours it (`cellColours`) into an image the size of the
 * grid. The image is coloured again only when the grid, the ramp or the colour window change. Each draw stretches the image over the plot
 * with nearest-neighbour scaling, as the shader reads the nearest cell for each pixel (`heatPlacement`, where the shader puts it to the
 * fraction of a pixel: corners rounded to whole pixels moved the cells a third of a pixel and changed a tenth of the picture, 2026-11-14).
 * The canvas is drawn again only when the picture moves a quarter of a device pixel or more, or anything else it shows changes: while the
 * map follows the market its view moves every frame by a small part of a pixel.
 *
 * The opacity is applied when the image is drawn, not when it is coloured, so a fade (the footprint taking over as the map zooms in) colours
 * nothing again. A cell at alpha `a` (its base alpha `b` times the opacity `o`) shows as the shader leaves it: its colour times `a`, at alpha
 * `a`². The image holds colour times `b` at alpha `b`². Drawn at `globalAlpha` o² it gets alpha b²o² = a², and premultiplied colour c·b³·o².
 * Black at alpha 1 - `o`, painted over it with 'source-atop', scales that colour by `o` and leaves the alpha: c·b³·o³ = c·a·a², the
 * shader's pixel.
 */
export class HeatCanvas implements HeatRenderer {
  readonly kind = '2d' as const;
  readonly #ctx: CanvasRenderingContext2D;
  #lut = new Uint8Array(256 * 4);
  #grid: Float32Array | null = null; #w = 0; #h = 0; #bounds: Bounds | null = null;
  /** The grid coloured at full opacity for `#key`, as an image the size of the grid (`#pixels` its pixels); `#version` counts colourings. */
  #image: HTMLCanvasElement | null = null; #pixels: ImageData | null = null; #key = ''; #version = 0;
  /** What the canvas shows ('' not known, 'clear' nothing), so a draw that would change nothing is skipped. */
  #drawn = '';

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas for the heatmap');
    this.#ctx = ctx;
  }

  setLut(rgba: Uint8Array): void { this.#lut = rgba.slice(); this.#key = ''; }
  /** The page asks for a grid of at most 2,600 cells a side; an image above this would be more than some browsers' canvases hold. */
  get maxSize(): number { return 4096; }
  get coverage(): Bounds | null { return this.#bounds; }

  upload(grid: Float32Array, w: number, h: number, bounds: Bounds): void {
    this.#grid = grid; this.#w = w; this.#h = h; this.#bounds = bounds; this.#key = '';
  }

  resize(width: number, height: number, dpr: number): void {
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.#drawn = ''; }
  }

  clear(): void {
    if (this.#drawn === 'clear') return;
    this.#ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.#ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.#drawn = 'clear';
  }

  draw(view: Bounds, style: HeatStyle): void {
    const grid = this.#grid, b = this.#bounds, w = this.#w, h = this.#h;
    if (!grid || !b || !(w > 0) || !(h > 0)) { this.clear(); return; }
    const key = `${style.mode}|${style.min}|${style.max}|${style.bid}|${style.bidSoft}|${style.ask}|${style.askSoft}`;
    if (key !== this.#key || !this.#image) {
      if (!this.#colour(grid, w, h, { ...style, opacity: 1 })) { this.clear(); return; }
      this.#key = key; this.#version++;
    }
    const W = this.canvas.width, H = this.canvas.height, { x, y, w: dw, h: dh } = heatPlacement(view, b, W, H);
    const o = Math.min(1, Math.max(0, style.opacity));
    if (!(dw > 0) || !(dh > 0) || !(o > 0) || !Number.isFinite(x + y + dw + dh)) { this.clear(); return; }
    const q = (v: number): number => Math.round(v * 4);
    const drawn = `${this.#version}|${q(x)}|${q(y)}|${q(x + dw)}|${q(y + dh)}|${o}|${W}x${H}`;
    if (drawn === this.#drawn) return;
    const ctx = this.#ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = o * o;
    ctx.drawImage(this.#image!, 0, 0, w, h, x, y, dw, dh);
    if (o < 1) { ctx.globalCompositeOperation = 'source-atop'; ctx.globalAlpha = 1 - o; ctx.fillStyle = '#000'; ctx.fillRect(x, y, dw, dh); }
    ctx.restore();
    this.#drawn = drawn;
  }

  /** Colour the grid into the image; false where the browser gives no 2D context for it. */
  #colour(grid: Float32Array, w: number, h: number, style: HeatStyle): boolean {
    const image = this.#image ?? document.createElement('canvas');
    if (image.width !== w || image.height !== h) { image.width = w; image.height = h; }
    const ictx = image.getContext('2d');
    if (!ictx) return false;
    let pixels = this.#pixels;
    if (!pixels || pixels.width !== w || pixels.height !== h) pixels = this.#pixels = new ImageData(w, h);
    cellColours(grid, w, h, style, this.#lut, new Uint32Array(pixels.data.buffer, pixels.data.byteOffset, w * h));
    ictx.putImageData(pixels, 0, 0);
    this.#image = image;
    return true;
  }
}

/**
 * Where the grid's image goes on a plot `width` x `height` device px that shows `view`: the grid covers `bounds`, the image's top row the
 * highest price.
 */
export function heatPlacement(view: Bounds, bounds: Bounds, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const sx = width / (view.t1 - view.t0), sy = height / (view.p1 - view.p0);
  return { x: (bounds.t0 - view.t0) * sx, y: (view.p1 - bounds.p1) * sy, w: (bounds.t1 - bounds.t0) * sx, h: (bounds.p1 - bounds.p0) * sy };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * One cell as the WebGL heatmap leaves it on its canvas (gl.ts), from where its value falls in the colour window: `pos` is 'size''s `s` (the
 * log of the cell's total, 0 at the window's low end and 1 at its top, above 1 for a total above the window) or 'sides''s `a` (its larger
 * side, linear, held at 1); `ask` whether that larger side is the asks. [r, g, b, a] from 0 to 255, not premultiplied: the shader's colour
 * times its alpha, at the alpha squared (blended over a cleared canvas that is not premultiplied, with SRC_ALPHA / ONE_MINUS_SRC_ALPHA).
 * Null where the shader discards the cell. 'size' reads the ramp as the shader's texture does: 256 texels, linear filtering, edges held.
 */
export function shade(style: HeatStyle, lut: Uint8Array, pos: number, ask: boolean): [number, number, number, number] | null {
  if (!(pos > 0)) return null;
  let r: number, g: number, b: number, a: number;
  if (style.mode === 'size') {
    const u = Math.min(pos, 1) * 256 - 0.5, base = Math.floor(u), f = u - base;
    const i0 = Math.min(255, Math.max(0, base)) * 4, i1 = Math.min(255, Math.max(0, base + 1)) * 4;
    r = (lut[i0]! + (lut[i1]! - lut[i0]!) * f) / 255;
    g = (lut[i0 + 1]! + (lut[i1 + 1]! - lut[i0 + 1]!) * f) / 255;
    b = (lut[i0 + 2]! + (lut[i1 + 2]! - lut[i0 + 2]!) * f) / 255;
    const t = clamp01(pos / 0.06);
    a = t * t * (3 - 2 * t) * style.opacity;
  } else {
    const x = Math.min(pos, 1), soft = ask ? style.askSoft : style.bidSoft, strong = ask ? style.ask : style.bid;
    r = soft[0] + (strong[0] - soft[0]) * x; g = soft[1] + (strong[1] - soft[1]) * x; b = soft[2] + (strong[2] - soft[2]) * x;
    a = x ** 0.75 * style.opacity;
  }
  return [r * a * 255, g * a * 255, b * a * 255, a * a * 255];
}

/** `shade` at the middle of each of the window's `STEPS` steps, as 32-bit pixels in the platform's byte order. */
function shadeTable(style: HeatStyle, lut: Uint8Array, ask: boolean): Uint32Array {
  const table = new Uint32Array(STEPS), bytes = new Uint8ClampedArray(table.buffer);
  for (let k = 0; k < STEPS; k++) { const px = shade(style, lut, (k + 0.5) / STEPS, ask); if (px) bytes.set(px, k * 4); }
  return table;
}

/** A number's top 32 bits as a double (sign, 11 exponent bits, 20 of the fraction): for a positive number, rising with its logarithm. */
const SCRATCH = new Float64Array(1), WORDS = new Int32Array(SCRATCH.buffer), HIGH = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
const highWord = (x: number): number => { SCRATCH[0] = x; return WORDS[HIGH]!; };

/**
 * 'size' without a logarithm a cell: the cell's total names its bucket by its top bits as a double (`highWord` without its last `shift`
 * bits: at the least shift, 4,096 buckets an octave, each under a twentieth of a window step wide for a window of 10 octaves), and each
 * bucket from the window's low end up takes the step of its middle value. The buckets stop at the window's top: a total above it is the
 * last bucket, the ramp's top. `from` is the window's low end, where the shader starts to draw.
 */
function sizeBuckets(style: HeatStyle, steps: Uint32Array): { table: Uint32Array; from: number; first: number; shift: number } {
  const lo = Math.log(Math.max(style.min, 1)), hi = Math.log(Math.max(style.max, style.min * 1.0001 + 1)), perLog = STEPS / Math.max(hi - lo, 1e-6);
  const from = Math.exp(lo), top = highWord(Math.exp(hi)), bottom = highWord(from);
  let shift = 8;
  while ((top >> shift) - (bottom >> shift) > 1 << 18) shift++;
  const first = bottom >> shift, n = (top >> shift) - first + 1, table = new Uint32Array(n), last = STEPS - 1;
  for (let j = 0; j < n; j++) {
    // The bucket's middle: its top bits, then a 1 and zeros below them.
    WORDS[HIGH] = ((first + j) << shift) | (1 << (shift - 1)); WORDS[1 - HIGH] = 0;
    const k = (Math.log(SCRATCH[0]!) - lo) * perLog;
    table[j] = k > 0 ? steps[k >= last ? last : k | 0]! : steps[0]!;
  }
  return { table, from, first, shift };
}

/**
 * The grid's cells as 32-bit RGBA pixels (into `out`, `w` x `h`), each `shade` of the cell (the shader's), its value placed in the colour
 * window as the shader places it. Row 0 of the image is the grid's last row: the highest price on top. Each cell takes the pixel of the
 * window step it falls in (a step of 4,096 changes a pixel by a small part of one level), so a colouring costs a table look-up a cell
 * (2026-11-14, Node on Karl's PC: 2,600 x 1,750 cells in about 40 ms; with a logarithm a cell, 'size' took 140-166 ms).
 */
export function cellColours(grid: Float32Array, w: number, h: number, style: HeatStyle, lut: Uint8Array, out = new Uint32Array(w * h)): Uint32Array {
  const size = style.mode === 'size', bids = shadeTable(style, lut, false), asks = size ? bids : shadeTable(style, lut, true), last = STEPS - 1;
  if (size) {
    const { table, from, first, shift } = sizeBuckets(style, bids), end = table.length - 1;
    for (let row = 0; row < h; row++) {
      let o = (h - 1 - row) * w, i = row * w * 2;
      for (let col = 0; col < w; col++, o++, i += 2) {
        const total = grid[i]! + grid[i + 1]!;
        let px = 0;
        if (total > from) { SCRATCH[0] = total; const k = (WORDS[HIGH]! >> shift) - first; px = table[k > end ? end : k]!; }
        out[o] = px;
      }
    }
    return out;
  }
  const min = style.min, perUsd = STEPS / Math.max(style.max - style.min, 1e-6);
  for (let row = 0; row < h; row++) {
    let o = (h - 1 - row) * w, i = row * w * 2;
    for (let col = 0; col < w; col++, o++, i += 2) {
      const bid = grid[i]!, ask = grid[i + 1]!;
      let px = 0;
      if (bid + ask > 0) { const isAsk = ask > bid, k = ((isAsk ? ask : bid) - min) * perUsd; if (k > 0) px = (isAsk ? asks : bids)[k >= last ? last : k | 0]!; }
      out[o] = px;
    }
  }
  return out;
}
