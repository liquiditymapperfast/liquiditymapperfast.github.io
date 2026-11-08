/**
 * A picture of the page, drawn by walking it: every canvas is copied at its place, and the boxes, borders and text of the ordinary
 * elements are painted around them. This needs no permission prompt (unlike capturing the screen), cannot taint the canvas (unlike
 * serialising the page into an image) and is exact where it matters, because the chart, the order book and the panes are canvases. The
 * toolbar and pane headers are approximated from their computed styles: boxes, borders (each side as the page draws it, so a CSS
 * triangle is a triangle), rounded corners, text, gradients, selects, sliders, SVG drawings (shape by shape), the icons the page draws
 * as a colour seen through a mask picture, turned boxes, and the boxes and text of `::before` and `::after` (placed from their computed
 * styles: the page gives them no box to read), with their outer shadows, background pictures and polygon clips (inset shadows, filters,
 * backdrop blurs, border images and other clips are left out). Every
 * computed length is scaled by the element's CSS zoom (the top bar is zoomed to fit), as the boxes the page gives already are.
 *
 * Three WebGL canvases lose their picture once the screen has shown it (live-canvas.ts): each is asked to draw again just before the
 * walk, which copies it in the same task. Taken a moment later they came out empty: the trade dust was missing from every picture.
 *
 * The same walk serves a moving picture (`paintLayers`): what lies between two canvases is painted once into a layer of its own, and
 * each frame lays the layers and the canvases (as they are by then) over each other in the page's order.
 */
import { drawLiveCanvases } from '../live-canvas.ts';
import { paintAt, sharpScale } from '../pixel-ratio.ts';

export interface Snapshot { canvas: HTMLCanvasElement; /** Canvas pixels per CSS pixel. */ scale: number; width: number; height: number }
export interface Box { x: number; y: number; w: number; h: number }

const num = (value: string): number => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; };

/** The part of `a` inside `b` (null for none); `b` null is no limit. */
export function intersect(a: Box, b: Box | null): Box | null {
  if (!b) return a;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}
const boxOf = (r: DOMRect): Box => ({ x: r.left, y: r.top, w: r.width, h: r.height });

/** Split on commas that are not inside parentheses. */
export function splitTop(text: string): string[] {
  const parts: string[] = []; let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && depth === 0) { parts.push(text.slice(from, i).trim()); from = i + 1; }
  }
  parts.push(text.slice(from).trim());
  return parts.filter(Boolean);
}

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The first `linear-gradient(...)` of a computed `background-image`, as a canvas gradient over `box`, or null. */
export function gradientFor(ctx: Ctx2D, image: string, box: { x: number; y: number; w: number; h: number }): CanvasGradient | null {
  const start = image.indexOf('linear-gradient('); if (start < 0) return null;
  let depth = 0, end = -1;
  for (let i = start + 'linear-gradient'.length; i < image.length; i++) { if (image[i] === '(') depth++; else if (image[i] === ')' && --depth === 0) { end = i; break; } }
  if (end < 0) return null;
  const args = splitTop(image.slice(start + 'linear-gradient('.length, end));
  let angle = 180; // CSS default: to bottom
  const first = args[0] ?? '';
  if (/^to /.test(first)) { const dir = first.slice(3).trim(); angle = dir === 'right' ? 90 : dir === 'left' ? 270 : dir === 'top' ? 0 : 180; args.shift(); }
  else if (/deg$/.test(first)) { angle = num(first); args.shift(); }
  const rad = angle * Math.PI / 180, half = (Math.abs(box.w * Math.sin(rad)) + Math.abs(box.h * Math.cos(rad))) / 2;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, dx = Math.sin(rad) * half, dy = -Math.cos(rad) * half;
  const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  const stops = args.flatMap((stop, i) => {
    const m = /^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(stop); if (!m) return [];
    return [{ at: m[2] !== undefined ? Math.max(0, Math.min(1, num(m[2]) / 100)) : (args.length > 1 ? i / (args.length - 1) : 0), color: m[1]!.trim() }];
  });
  for (const stop of fadeStops(stops)) { try { gradient.addColorStop(stop.at, stop.color); } catch { /* an unparsable colour is skipped */ } }
  return gradient;
}

/** A colour with no alpha left: the same colour, clear. */
export function cleared(color: string): string {
  const rgb = /^rgba?\(\s*([^,\s]+)\s*,\s*([^,\s]+)\s*,\s*([^,\s)]+)/.exec(color);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, 0)`;
  const fn = /^(color|oklab|oklch|lab|lch)\(\s*([^/)]*?)\s*(?:\/[^)]*)?\)$/.exec(color);
  return fn ? `${fn[1]}(${fn[2]} / 0)` : 'transparent';
}

/**
 * Gradient stops as CSS mixes them: a clear stop (`transparent`) fades its neighbours' own colours, where the canvas would fade through
 * black (the phone dock's shade strips came out as dark bands). A clear stop becomes its neighbours' colours made clear, one for each side.
 */
export function fadeStops(stops: readonly { at: number; color: string }[]): { at: number; color: string }[] {
  const out: { at: number; color: string }[] = [];
  stops.forEach((stop, i) => {
    if (!clear(stop.color)) { out.push(stop); return; }
    const before = stops.slice(0, i).reverse().find(s => !clear(s.color)), after = stops.slice(i + 1).find(s => !clear(s.color));
    if (before) out.push({ at: stop.at, color: cleared(before.color) });
    if (after) out.push({ at: stop.at, color: cleared(after.color) });
    if (!before && !after) out.push(stop);
  });
  return out;
}

function roundedPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, radii: number[]): void {
  ctx.beginPath();
  if (radii.some(r => r > 0) && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, radii.map(r => Math.min(r, w / 2, h / 2))); else ctx.rect(x, y, w, h);
}

/**
 * The four sides of a border as the page draws them: each from the box's outer edge to its inner one, mitred at the corners, so a side
 * of no width between two wide ones leaves a triangle (the carets of the coin, theme and language buttons are such borders on an empty
 * box). Top, right, bottom, left; four corners each.
 */
export function borderSides(b: Box, widths: readonly number[]): [number, number][][] {
  const [t = 0, r = 0, btm = 0, l = 0] = widths, x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h, ix0 = x0 + l, iy0 = y0 + t, ix1 = x1 - r, iy1 = y1 - btm;
  return [
    [[x0, y0], [x1, y0], [ix1, iy0], [ix0, iy0]],
    [[x1, y0], [x1, y1], [ix1, iy1], [ix1, iy0]],
    [[x1, y1], [x0, y1], [ix0, iy1], [ix1, iy1]],
    [[x0, y1], [x0, y0], [ix0, iy0], [ix0, iy1]],
  ];
}

/** A computed colour that paints nothing: `transparent`, `rgba(…, 0)`, or one of the newer forms with an alpha of 0 (`color(srgb … / 0)`). */
export const clear = (color: string): boolean => !color || color === 'transparent' || /^rgba\((?:[^,]*,){3}\s*0(?:\.0*)?\)$/.test(color) || /\/\s*0(?:\.0*)?\)$/.test(color);

export interface Shadow { color: string; x: number; y: number; blur: number; spread: number }
/** The outer shadows of a computed `box-shadow` (`rgba(0, 0, 0, 0.28) 3px 3px 0px 0px, …`), the first on top; inset ones are left out. */
export function outerShadows(value: string): Shadow[] {
  if (!value || value === 'none') return [];
  const out: Shadow[] = [];
  for (const part of splitTop(value)) {
    if (/\binset\b/.test(part)) continue;
    const color = /^((?:rgba?|hsla?|color|oklab|oklch|lab|lch)\([^)]*\)|#[0-9a-fA-F]+|[a-zA-Z]+)\s*/.exec(part.trim());
    const rest = (color ? part.trim().slice(color[0].length) : part).trim().split(/\s+/).map(num);
    const [x = 0, y = 0, blur = 0, spread = 0] = rest;
    if (!color || clear(color[1]!)) continue;
    out.push({ color: color[1]!, x, y, blur, spread });
  }
  return out;
}

/**
 * A box's outer shadows, outside the box only (as the page draws them: never under a see-through background), the last one first. The
 * hard ones (the cockpit frame's keys) are the box moved over; a soft one (a lamp's glow) is blurred by the canvas.
 */
function paintShadows(ctx: Ctx2D, box: Box, radii: number[], shadows: readonly Shadow[], z: number): void {
  if (!shadows.length) return;
  // Clipped to the box's surroundings that the shadows can reach, less the box: a clip as large as the page cost twenty times a fill.
  const reach = Math.max(...shadows.map(s => (Math.abs(s.x) + Math.abs(s.y) + Math.max(0, s.spread) + 2 * s.blur) * z)) + 2;
  const t = ctx.getTransform(), kx = Math.hypot(t.a, t.b), ky = Math.hypot(t.c, t.d), far = box.w + 2 * reach + 16;
  ctx.save();
  try {
    ctx.beginPath(); ctx.rect(box.x - reach, box.y - reach, box.w + 2 * reach, box.h + 2 * reach);
    if (radii.some(r => r > 0) && typeof ctx.roundRect === 'function') ctx.roundRect(box.x, box.y, box.w, box.h, radii.map(r => Math.min(r, box.w / 2, box.h / 2))); else ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip('evenodd');
    for (const s of [...shadows].reverse()) {
      const spread = s.spread * z, x = box.x + s.x * z - spread, y = box.y + s.y * z - spread, w = box.w + 2 * spread, h = box.h + 2 * spread;
      if (!(w > 0 && h > 0)) continue;
      if (s.blur <= 0) { roundedPath(ctx, x, y, w, h, radii.map(r => r > 0 ? Math.max(0, r + spread) : 0)); ctx.fillStyle = s.color; ctx.fill(); continue; }
      // The shape is drawn outside the clip and only its shadow is moved back, by the same move on the canvas's pixels (turned with the
      // context): the canvas blurs a shadow, not a shape.
      ctx.shadowColor = s.color; ctx.shadowBlur = s.blur * z * (kx + ky) / 2; ctx.shadowOffsetX = far * t.a; ctx.shadowOffsetY = far * t.b;
      roundedPath(ctx, x - far, y, w, h, radii.map(r => r > 0 ? Math.max(0, r + spread) : 0)); ctx.fillStyle = '#000'; ctx.fill();
      ctx.shadowColor = 'transparent';
    }
  } finally { ctx.restore(); }
}

/** Words of a CSS value split on the spaces outside parentheses (`calc(100% - 7px) 4px` is two). */
export function topWords(text: string): string[] {
  const out: string[] = [];
  let depth = 0, word = '';
  for (const c of text) {
    if (c === '(') depth++; else if (c === ')') depth--;
    if (depth === 0 && /\s/.test(c)) { if (word) out.push(word); word = ''; } else word += c;
  }
  if (word) out.push(word);
  return out;
}

/**
 * A computed length along `of`: a percentage of it, a length (zoomed), or a sum of both as the computed style writes one
 * (`calc(100% - 7px)`, `calc(50% + -0.5px)`). NaN for anything else: what uses it leaves the thing out rather than drawing it at 0.
 */
export function cssLength(value: string, of: number, zoom = 1): number {
  const term = (t: string): number => /^-?[\d.]+(?:e-?\d+)?%$/.test(t) ? of * num(t) / 100 : /^-?[\d.]+(?:e-?\d+)?(?:px)?$/.test(t) ? num(t) * zoom : NaN;
  const s = value.trim(), c = /^calc\((.*)\)$/.exec(s);
  if (!c) return term(s);
  const parts = c[1]!.trim().split(/\s+([+-])\s+/);
  let total = term(parts[0]!);
  for (let i = 1; i < parts.length; i += 2) { const t = term(parts[i + 1] ?? ''); total = parts[i] === '-' ? total - t : total + t; }
  return total;
}

/** Where a layer `dw` × `dh` sits in a box `w` × `h` by the first layer of a computed position (percentages of the room left, lengths, sums). */
function placeLayer(position: string, w: number, h: number, dw: number, dh: number, zoom: number): Box {
  const [pa = '0%', pb = pa] = topWords(splitTop(position)[0] ?? '');
  return { x: cssLength(pa, w - dw, zoom), y: cssLength(pb, h - dh, zoom), w: dw, h: dh };
}

/**
 * Where a gradient layer lies in a box `w` × `h`: a gradient has no size of its own, so `auto` (and `cover`, `contain`) is the whole box in
 * that direction, and lengths are as for a picture (the Classic frame's title bar: an 18 px strip inset 4 px).
 */
export function gradientPlace(size: string, position: string, w: number, h: number, zoom = 1): Box {
  const [sa = 'auto', sb = 'auto'] = topWords(splitTop(size)[0] ?? '');
  const whole = sa === 'cover' || sa === 'contain';
  const dw = whole || sa === 'auto' ? w : cssLength(sa, w, zoom), dh = whole || sb === 'auto' ? h : cssLength(sb, h, zoom);
  return placeLayer(position, w, h, dw, dh, zoom);
}

/** The colour of a gradient whose stops are all one colour (`conic-gradient(var(--face), var(--face))`, a block of colour); null otherwise. */
export function solidGradient(layer: string): string | null {
  const m = /^(?:repeating-)?(?:linear|radial|conic)-gradient\((.*)\)$/.exec(layer.trim()); if (!m) return null;
  const args = splitTop(m[1]!);
  // The first argument may be the gradient's direction or shape rather than a stop.
  if (args.length && /^(to |from |at |circle|ellipse|closest|farthest|-?[\d.]+(deg|turn|rad|grad)\b)/.test(args[0]!)) args.shift();
  const colours = args.map(stop => { const words = topWords(stop); return words.filter(w => !/^-?[\d.]+(%|px|deg|turn)?$/.test(w)).join(' '); }).filter(Boolean);
  return colours.length && colours.every(c => c === colours[0]) ? colours[0]! : null;
}

/** Tiles of background pictures, by picture and size on the canvas's pixels; emptied when it holds this many. */
const tiles = new Map<string, HTMLCanvasElement | OffscreenCanvas>(), MAX_TILES = 64;

/**
 * A box's background layers over its colour, the last layer first, each in its `background-origin` box and clipped to the rounded box:
 * linear gradients and gradients of one colour, placed by `background-size` and `background-position`; and pictures (the Classic frame's
 * check marks, bullets, select arrows and dither), drawn once or tiled as `background-repeat` says, a tile on whole pixels of the canvas so
 * a dither stays a checker. A layer it cannot place (a position it cannot read), a radial or conic gradient of several colours, and a
 * picture not read yet are left out. `background-attachment: fixed` is drawn as if it were not.
 */
function paintBackground(ctx: Ctx2D, box: Box, cs: CSSStyleDeclaration, radii: number[], z: number): void {
  if (!clear(cs.backgroundColor)) { roundedPath(ctx, box.x, box.y, box.w, box.h, radii); ctx.fillStyle = cs.backgroundColor; ctx.fill(); }
  if (!cs.backgroundImage || cs.backgroundImage === 'none') return;
  const layers = splitTop(cs.backgroundImage), sizes = splitTop(cs.backgroundSize || 'auto'), places = splitTop(cs.backgroundPosition || '0% 0%');
  const repeats = splitTop(cs.backgroundRepeat || 'repeat'), origins = splitTop(cs.backgroundOrigin || 'padding-box');
  const finite = (b: Box): boolean => Number.isFinite(b.x + b.y + b.w + b.h) && b.w > 0 && b.h > 0;
  // Layers start on whole pixels of the canvas, as the page lays them: between pixels a check mark or a strip's edge came out blurred.
  // On whole pixels of the canvas, its move included (a GIF's layer starts at the area's corner, rarely on a whole pixel).
  const t = ctx.getTransform(), k = Math.max(1e-3, Math.hypot(t.a, t.b));
  const snapX = (v: number): number => (Math.round(v * k + t.e) - t.e) / k, snapY = (v: number): number => (Math.round(v * k + t.f) - t.f) / k;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!, pick = (list: string[]): string => list[i % list.length]!;
    const origin = pick(origins), area = origin === 'border-box' ? box : innerBox(box, cs, origin !== 'content-box', z);
    if (!(area.w > 0 && area.h > 0)) continue;
    const once = /^no-repeat( no-repeat)?$/.test(pick(repeats));
    const solid = solidGradient(layer), linear = layer.startsWith('linear-gradient(');
    if (solid || linear) {
      const at = gradientPlace(pick(sizes), pick(places), area.w, area.h, z); if (!finite(at)) continue;
      // At least a pixel each way: rounded, a strip thinner than a pixel would vanish.
      const x0 = snapX(area.x + at.x), y0 = snapY(area.y + at.y);
      const rect = once ? { x: x0, y: y0, w: Math.max(1 / k, snapX(area.x + at.x + at.w) - x0), h: Math.max(1 / k, snapY(area.y + at.y + at.h) - y0) } : box;
      const fill = solid ?? gradientFor(ctx, layer, rect); if (!fill) continue;
      ctx.save();
      try { roundedPath(ctx, box.x, box.y, box.w, box.h, radii); ctx.clip(); ctx.fillStyle = fill; ctx.fillRect(rect.x, rect.y, rect.w, rect.h); } finally { ctx.restore(); }
      continue;
    }
    const url = layer.startsWith('url(') ? maskUrl(layer, location.href) : null, picture = url ? pictureOf(url) : null;
    if (!url || !picture) continue;
    const at = maskPlace(pick(sizes), pick(places), area.w, area.h, picture.naturalWidth, picture.naturalHeight, z);
    if (!finite(at)) continue;
    ctx.save();
    try {
      roundedPath(ctx, box.x, box.y, box.w, box.h, radii); ctx.clip();
      const tw = Math.max(1, Math.round(at.w * k)), th = Math.max(1, Math.round(at.h * k));
      // A picture laid once, or one too large to tile (a whole-box picture is not tiled pixel by pixel), is drawn where it lies.
      if (once || tw > MAX_LAYER || th > MAX_LAYER) { ctx.drawImage(picture, snapX(area.x + at.x), snapY(area.y + at.y), at.w, at.h); continue; }
      // Tiled through a pattern of the picture drawn once on whole pixels of the canvas, from a corner on a whole pixel: drawn between
      // pixels, the Classic frame's dither came out a flat grey. Small tiles are kept.
      const key = `${url}|${tw}|${th}`;
      let tile = tiles.get(key);
      if (!tile) {
        tile = surface(tw, th); const tc = context2d(tile); tc.imageSmoothingEnabled = false; tc.drawImage(picture, 0, 0, tw, th);
        if (tw * th <= 256 * 256) { if (tiles.size >= MAX_TILES) tiles.clear(); tiles.set(key, tile); }
      }
      const pattern = ctx.createPattern(tile, 'repeat'); if (!pattern) continue;
      pattern.setTransform(new DOMMatrix([1 / k, 0, 0, 1 / k, snapX(area.x + at.x), snapY(area.y + at.y)]));
      ctx.imageSmoothingEnabled = false; ctx.fillStyle = pattern; ctx.fillRect(box.x, box.y, box.w, box.h);
    } finally { ctx.restore(); }
  }
}

/** A box's background (colour, gradients and pictures) and border, with its rounded corners, over its outer shadows. */
function paintPlainBox(ctx: Ctx2D, box: Box, cs: CSSStyleDeclaration, z: number): void {
  const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(v => num(v) * z);
  paintShadows(ctx, box, radii, outerShadows(cs.boxShadow), z);
  paintBackground(ctx, box, cs, radii, z);
  const widths = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(v => num(v) * z);
  const styles = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
  const colors = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
  const drawn = widths.map((w, i) => w > 0 && styles[i] !== 'none' && styles[i] !== 'hidden' && !clear(colors[i]!));
  if (drawn.every(Boolean) && widths.every(w => w === widths[0]) && colors.every(c => c === colors[0])) {
    const w = widths[0]!; roundedPath(ctx, box.x + w / 2, box.y + w / 2, box.w - w, box.h - w, radii.map(r => Math.max(0, r - w / 2)));
    ctx.strokeStyle = colors[0]!; ctx.lineWidth = w; ctx.setLineDash(styles[0] === 'dashed' ? [4, 3] : styles[0] === 'dotted' ? [1, 2] : []); ctx.stroke(); ctx.setLineDash([]);
  } else if (drawn.some(Boolean)) {
    borderSides(box, widths.map((w, i) => styles[i] === 'none' || styles[i] === 'hidden' ? 0 : w)).forEach((side, i) => {
      if (!drawn[i]) return;
      ctx.beginPath(); side.forEach(([x, y], k) => { if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath();
      ctx.fillStyle = colors[i]!; ctx.fill();
    });
  }
}

/**
 * The first picture of a computed `mask-image` (`url("data:…")`), if the page may read it without spoiling the picture: a `data:` address
 * or one of this page's own. Null for none, and for a mask that is not a picture.
 */
export function maskUrl(image: string, origin: string): string | null {
  const m = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/.exec(image); if (!m) return null;
  const url = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  if (url.startsWith('data:')) return url;
  try { return new URL(url, origin).origin === new URL(origin).origin ? url : null; } catch { return null; }
}

/**
 * Where a mask picture `iw` × `ih` lies in a box `w` × `h` (its border box), from the computed `mask-size` (`contain`, `cover`, `auto` or
 * lengths) and `mask-position` (percentages of the room left, lengths, or sums of both) of its first layer, as for a background picture.
 * A picture of no size of its own is square. Lengths are scaled by the element's `zoom` (the computed style gives them unzoomed). A value
 * it cannot read gives NaN, and the picture is left out.
 */
export function maskPlace(size: string, position: string, w: number, h: number, iw: number, ih: number, zoom = 1): Box {
  const ratio = iw > 0 && ih > 0 ? iw / ih : 1;
  const [sa = 'auto', sb = 'auto'] = topWords(splitTop(size)[0] ?? '');
  let dw: number, dh: number;
  if (sa === 'contain' || sa === 'cover') { dh = sa === 'contain' ? Math.min(h, w / ratio) : Math.max(h, w / ratio); dw = dh * ratio; }
  else if (sa === 'auto' && sb === 'auto') { dw = iw > 0 ? iw * zoom : w; dh = ih > 0 ? ih * zoom : dw / ratio; }
  else if (sb === 'auto') { dw = cssLength(sa, w, zoom); dh = dw / ratio; }
  else if (sa === 'auto') { dh = cssLength(sb, h, zoom); dw = dh * ratio; }
  else { dw = cssLength(sa, w, zoom); dh = cssLength(sb, h, zoom); }
  return placeLayer(position, w, h, dw, dh, zoom);
}

/** The pictures of masks and backgrounds by address: read, being read, or unreadable (null). */
const pictures = new Map<string, HTMLImageElement | Promise<void> | null>();
/** The mask pictures the walks since the last `takeUnread` met before they were read. */
let unread: Promise<void>[] = [];
const takeUnread = (): Promise<void>[] => { const out = unread; unread = []; return out; };

/** The picture at `url` if it is read; otherwise it starts being read (once) and is noted for `capturePageReady`. */
function pictureOf(url: string): HTMLImageElement | null {
  const held = pictures.get(url);
  if (held instanceof HTMLImageElement) return held;
  if (held === null) return null;
  if (held) { unread.push(held); return null; }
  const img = new Image();
  img.src = url;
  const reading = img.decode().then(() => { pictures.set(url, img); }, () => { pictures.set(url, null); });
  pictures.set(url, reading); unread.push(reading);
  return null;
}

/**
 * A box as the page draws it: its background and border, and for a box seen through a mask (the page's icons: a colour shown through a
 * picture), both laid on a layer of their own and cut by the picture where `mask-size` and `mask-position` put it. A mask picture not read
 * yet, or not readable, leaves the box out: drawn whole it was a solid square where the icon should be (the Select key, 2026-11-07).
 */
function paintBox(ctx: Ctx2D, box: Box, cs: CSSStyleDeclaration, z: number): void {
  const image = cs.maskImage && cs.maskImage !== 'none' ? cs.maskImage : (cs.webkitMaskImage || 'none');
  if (image === 'none' || !image.includes('url(')) { paintPlainBox(ctx, box, cs, z); return; }
  const url = maskUrl(image, location.href), picture = url ? pictureOf(url) : null;
  if (!picture || !(box.w > 0 && box.h > 0)) return;
  // The layer is at most MAX_LAYER pixels a side (a huge masked box is cut coarser rather than allocating a picture of its whole size).
  const t = ctx.getTransform(), sx = Math.hypot(t.a, t.b), sy = Math.hypot(t.c, t.d), w = Math.min(MAX_LAYER, Math.ceil(box.w * sx)), h = Math.min(MAX_LAYER, Math.ceil(box.h * sy));
  if (!(w > 0 && h > 0)) return;
  const size = cs.maskSize || cs.webkitMaskSize || 'auto', position = cs.maskPosition || cs.webkitMaskPosition || '0% 0%';
  // The same icon in the same colour at the same size is cut once: drawing the picture again for each walk (a GIF repaints its still
  // layers while it records) doubled the time a walk took.
  const key = [url, w, h, box.w, box.h, z, size, position, cs.backgroundColor, cs.backgroundImage, cs.backgroundSize, cs.backgroundPosition, cs.backgroundRepeat, cs.backgroundOrigin, cs.padding,
    cs.borderRadius, cs.borderWidth, cs.borderStyle, cs.borderColor, cs.boxShadow].join('|');
  let layer = cutIcons.get(key);
  if (!layer) {
    const at = maskPlace(size, position, box.w, box.h, picture.naturalWidth, picture.naturalHeight, z);
    if (!Number.isFinite(at.x + at.y + at.w + at.h)) return;
    const waiting = unread.length;
    layer = surface(w, h); const lc = context2d(layer);
    lc.setTransform(w / box.w, 0, 0, h / box.h, -box.x * w / box.w, -box.y * h / box.h);
    paintPlainBox(lc, box, cs, z);
    lc.setTransform(w / box.w, 0, 0, h / box.h, 0, 0); lc.globalCompositeOperation = 'destination-in';
    lc.drawImage(picture, at.x, at.y, at.w, at.h);
    // A cut that met a background picture not read yet is not kept: kept, it would stay without it.
    if (unread.length === waiting) { if (cutIcons.size >= MAX_CUT_ICONS) cutIcons.clear(); cutIcons.set(key, layer); }
  }
  ctx.drawImage(layer, box.x, box.y, box.w, box.h);
}
/** Masked boxes already cut (see `paintBox`), by everything that changes how they look; emptied when it holds this many. */
const cutIcons = new Map<string, HTMLCanvasElement | OffscreenCanvas>(), MAX_CUT_ICONS = 400, MAX_LAYER = 4096;

/**
 * A computed `clip-path` of a polygon (`polygon(0px 0px, 100% 50%, 0px 100%)`, perhaps with a fill rule first) as its corners in a box
 * `w` × `h` (percentages of the box, lengths zoomed), and its fill rule; null for none; `'other'` for a clip this does not draw (a circle,
 * an inset, a reference), whose box is then left out rather than drawn whole.
 */
export function clipPolygon(value: string, w: number, h: number, zoom = 1): { points: [number, number][]; rule: CanvasFillRule } | null | 'other' {
  if (!value || value === 'none') return null;
  const m = /^polygon\((.*)\)(?:\s+[a-z-]+)?$/.exec(value.trim()); if (!m) return 'other';
  const parts = splitTop(m[1]!);
  let rule: CanvasFillRule = 'nonzero';
  if (parts[0] === 'evenodd' || parts[0] === 'nonzero') rule = parts.shift() as CanvasFillRule;
  const points = parts.map(p => { const [x = '0', y = '0'] = topWords(p.trim()); return [cssLength(x, w, zoom), cssLength(y, h, zoom)] as [number, number]; });
  // A corner it cannot read leaves the clip undrawn (and the box out) rather than drawn with that corner at 0.
  return points.length >= 3 && points.every(([x, y]) => Number.isFinite(x + y)) ? { points, rule } : 'other';
}

/** Paint a box through its `clip-path`: a polygon clips it (the tour keys' play triangle), any other clip leaves it out. */
function clipped(ctx: Ctx2D, box: Box, cs: CSSStyleDeclaration, z: number, paint: () => void): void {
  const clip = clipPolygon(cs.clipPath, box.w, box.h, z);
  if (clip === 'other') return;
  if (!clip) { paint(); return; }
  ctx.save();
  ctx.beginPath(); clip.points.forEach(([x, y], k) => { if (k) ctx.lineTo(box.x + x, box.y + y); else ctx.moveTo(box.x + x, box.y + y); }); ctx.closePath();
  ctx.clip(clip.rule);
  try { paint(); } finally { ctx.restore(); }
}

/** A computed `transform` as the six numbers of a 2D matrix (a 3D one by its 2D part); null for none. */
export function cssMatrix(transform: string): [number, number, number, number, number, number] | null {
  const m = /^matrix(3d)?\(([^)]*)\)$/.exec(transform.trim()); if (!m) return null;
  const v = m[2]!.split(',').map(num);
  return m[1] ? [v[0]!, v[1]!, v[4]!, v[5]!, v[12]!, v[13]!] : (v.length === 6 ? v as [number, number, number, number, number, number] : null);
}

/**
 * Where the box of a turned element starts before its turn: the page gives the box of the turned shape (`bounds`); its size before the turn
 * is `w` × `h`, and the turn `m` is made about `origin` (from the box's corner). Null for a turn that only moves it (the bounds are its box).
 */
export function unturnedCorner(bounds: Box, w: number, h: number, m: readonly number[], origin: readonly [number, number]): { x: number; y: number } | null {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  if (a === 1 && b === 0 && c === 0 && d === 1) return null;
  const [ox, oy] = origin, corners = [[-ox, -oy], [w - ox, -oy], [-ox, h - oy], [w - ox, h - oy]] as const;
  const minX = Math.min(...corners.map(([x, y]) => a * x + c * y + e)), minY = Math.min(...corners.map(([x, y]) => b * x + d * y + f));
  return { x: bounds.x - ox - minX, y: bounds.y - oy - minY };
}

/**
 * How much an element is scaled by CSS `zoom` on it and its ancestors (the top bar is zoomed to fit its row). The boxes the page gives are
 * zoomed, the computed lengths (font sizes, borders, radii, widths, insets) are not: each is multiplied by this. Before it, the bar's text
 * was drawn a tenth too large and its words ran into each other.
 */
const zoomOf = (el: Element): number => { const z = (el as { currentCSSZoom?: number }).currentCSSZoom; return typeof z === 'number' && z > 0 ? z : 1; };

/** A computed `transform` with its move scaled by the zoom (the computed style gives it unzoomed). */
const zoomedMatrix = (transform: string, z: number): number[] | null => { const m = cssMatrix(transform); return m && [m[0], m[1], m[2], m[3], m[4] * z, m[5] * z]; };
/** A computed `transform-origin` as its x and y from the box's corner, zoomed. */
const originOf = (cs: CSSStyleDeclaration, z: number): [number, number] => { const [x = '0', y = '0'] = cs.transformOrigin.split(/\s+/); return [num(x) * z, num(y) * z]; };
/** An element's border box before any turn, from its computed size. */
function borderBoxSize(cs: CSSStyleDeclaration, z: number): { w: number; h: number } | null {
  if (!cs.width || cs.width === 'auto' || !cs.height || cs.height === 'auto') return null;
  if (cs.boxSizing === 'border-box') return { w: num(cs.width) * z, h: num(cs.height) * z };
  const frame = (a: string, b: string, c: string, d: string): number => num(a) + num(b) + num(c) + num(d);
  return { w: (num(cs.width) + frame(cs.paddingLeft, cs.paddingRight, cs.borderLeftWidth, cs.borderRightWidth)) * z, h: (num(cs.height) + frame(cs.paddingTop, cs.paddingBottom, cs.borderTopWidth, cs.borderBottomWidth)) * z };
}

/** Turn the context by `m` (zoomed) about `origin` (zoomed, from the corner of a box whose corner is at `x`, `y`). */
function turn(ctx: Ctx2D, m: readonly number[] | null, origin: readonly [number, number], x: number, y: number): void {
  if (!m) return;
  const cx = x + origin[0], cy = y + origin[1];
  ctx.translate(cx, cy); ctx.transform(m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!); ctx.translate(-cx, -cy);
}

/** A computed font as a canvas font, its size zoomed. */
const fontOf = (cs: CSSStyleDeclaration, z = 1): string => `${cs.fontStyle === 'normal' ? '' : `${cs.fontStyle} `}${cs.fontWeight} ${num(cs.fontSize) * z}px ${cs.fontFamily}`;
/** The letter spacing of a text, where the canvas has it (the brand and the pane titles are spaced out). */
function spaceLetters(ctx: Ctx2D, cs: CSSStyleDeclaration, z: number): void {
  if ('letterSpacing' in ctx) (ctx as { letterSpacing: string }).letterSpacing = cs.letterSpacing && cs.letterSpacing !== 'normal' ? `${num(cs.letterSpacing) * z}px` : '0px';
}

// ---- ::before and ::after ---------------------------------------------------------------------------------------------------------------

/**
 * The text a computed `content` writes: its strings (with their escapes) and `attr(…)` read from the element, in order; null when it writes
 * something else (a counter, a picture, a quote mark), which is left out. `""` writes nothing: the box alone is drawn.
 */
export function contentText(content: string, attr: (name: string) => string | null): string | null {
  let out = '', i = 0;
  const s = content.trim();
  while (i < s.length) {
    const c = s[i]!;
    if (c === ' ') { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < s.length && s[j] !== c; j++) {
        if (s[j] !== '\\') { out += s[j]; continue; }
        const hex = /^[0-9a-fA-F]{1,6} ?/.exec(s.slice(j + 1));
        if (hex) { out += String.fromCodePoint(parseInt(hex[0], 16)); j += hex[0].length; } else { out += s[j + 1] ?? ''; j++; }
      }
      i = j + 1; continue;
    }
    const a = /^attr\(\s*([\w-]+)\s*\)/.exec(s.slice(i));
    if (a) { out += attr(a[1]!) ?? ''; i += a[0].length; continue; }
    return null;
  }
  return out;
}

/**
 * Where each item of a flex line starts along it: `items` in their order (each its size and margins), in a line from `start` of length
 * `size`, with the gap between items and the line's `justify-content`. Items do not grow or shrink here.
 */
export function flexStarts(start: number, size: number, gap: number, justify: string, items: readonly { size: number; before: number; after: number }[]): number[] {
  const n = items.length; if (!n) return [];
  const free = size - items.reduce((sum, it) => sum + it.size + it.before + it.after, 0) - gap * (n - 1);
  let lead = 0, between = 0;
  if (justify === 'center') lead = free / 2;
  else if (['flex-end', 'end', 'right'].includes(justify)) lead = free;
  else if (justify === 'space-between') between = n > 1 ? Math.max(0, free) / (n - 1) : 0;
  else if (justify === 'space-around') { between = Math.max(0, free) / n; lead = between / 2; }
  else if (justify === 'space-evenly') { between = Math.max(0, free) / (n + 1); lead = between; }
  const out: number[] = [];
  let at = start + lead;
  for (const it of items) { out.push(at + it.before); at += it.before + it.size + it.after + gap + between; }
  return out;
}

interface Sides { t: number; r: number; b: number; l: number }
const marginsOf = (cs: CSSStyleDeclaration, z: number): Sides => ({ t: num(cs.marginTop) * z, r: num(cs.marginRight) * z, b: num(cs.marginBottom) * z, l: num(cs.marginLeft) * z });
const paddingsOf = (cs: CSSStyleDeclaration, z: number): Sides => ({ t: num(cs.paddingTop) * z, r: num(cs.paddingRight) * z, b: num(cs.paddingBottom) * z, l: num(cs.paddingLeft) * z });
const bordersOf = (cs: CSSStyleDeclaration, z: number): Sides => {
  const w = (width: string, style: string): number => style === 'none' || style === 'hidden' ? 0 : num(width) * z;
  return { t: w(cs.borderTopWidth, cs.borderTopStyle), r: w(cs.borderRightWidth, cs.borderRightStyle), b: w(cs.borderBottomWidth, cs.borderBottomStyle), l: w(cs.borderLeftWidth, cs.borderLeftStyle) };
};
/** The box inside an element's border (`pad` true) or inside its padding too. */
function innerBox(box: Box, cs: CSSStyleDeclaration, pad: boolean, z: number): Box {
  const b = bordersOf(cs, z), p = pad ? { t: 0, r: 0, b: 0, l: 0 } : paddingsOf(cs, z);
  return { x: box.x + b.l + p.l, y: box.y + b.t + p.t, w: Math.max(0, box.w - b.l - b.r - p.l - p.r), h: Math.max(0, box.h - b.t - b.b - p.t - p.b) };
}

let measurer: CanvasRenderingContext2D | null = null;
/** A font's ascent, descent and x-height, and a text's width in it (with the style's letter spacing), zoomed. */
function metrics(cs: CSSStyleDeclaration, z: number, text = ''): { width: number; ascent: number; descent: number; x: number } {
  const ctx = measurer ??= document.createElement('canvas').getContext('2d');
  if (!ctx) { const size = num(cs.fontSize) * z; return { width: text.length * size * 0.55, ascent: size * 0.8, descent: size * 0.2, x: size * 0.5 }; }
  ctx.font = fontOf(cs, z); spaceLetters(ctx, cs, z);
  const m = ctx.measureText(text || 'x'), x = ctx.measureText('x');
  return { width: text ? m.width : 0, ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent, x: x.actualBoundingBoxAscent };
}

/** The box of an element's first (`before`) or last (`after`) piece of content that the layout places: a character of its text, or a child. */
function edgeContent(host: Element, which: 'before' | 'after'): { box: Box; text: CSSStyleDeclaration | null } | null {
  const nodes = [...host.childNodes]; if (which === 'after') nodes.reverse();
  for (const node of nodes) {
    if (node instanceof Text) {
      const data = node.data;
      let at = which === 'before' ? data.search(/\S/) : data.length - 1;
      if (which === 'after') while (at >= 0 && /\s/.test(data[at]!)) at--;
      if (at < 0) continue;
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 1);
      const r = range.getBoundingClientRect(); if (r.width === 0 && r.height === 0) continue;
      return { box: boxOf(r), text: getComputedStyle(host) };
    }
    if (!(node instanceof Element)) continue;
    const cs = getComputedStyle(node); if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
    const r = node.getBoundingClientRect(); if (r.width === 0 && r.height === 0) continue;
    return { box: boxOf(r), text: null };
  }
  return null;
}

type FlexItem = { size: number; before: number; after: number };
/** The items of a flex box's line besides its `::before` and `::after`: its children that the layout places, and its runs of text. */
function flexItems(host: Element, row: boolean): FlexItem[] {
  const out: FlexItem[] = [];
  let run: Text[] = [];
  const endRun = (): void => {
    if (!run.length) return;
    const range = document.createRange(); range.setStartBefore(run[0]!); range.setEndAfter(run[run.length - 1]!);
    const r = range.getBoundingClientRect(); out.push({ size: row ? r.width : r.height, before: 0, after: 0 }); run = [];
  };
  for (const node of host.childNodes) {
    if (node instanceof Text) { if (node.data.trim()) run.push(node); continue; }
    if (!(node instanceof Element)) continue;
    const cs = getComputedStyle(node); if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
    endRun();
    const r = node.getBoundingClientRect(), m = marginsOf(cs, zoomOf(node));
    out.push({ size: row ? r.width : r.height, before: row ? m.l : m.t, after: row ? m.r : m.b });
  }
  endRun();
  return out;
}

/** Whether a pseudo-element takes a place in its element's line: content that makes a box, shown, and not positioned out of the line. */
function pseudoInLine(cs: CSSStyleDeclaration): boolean {
  return !!cs.content && cs.content !== 'none' && cs.content !== 'normal' && cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed';
}

/** A pseudo-element's own size, from its computed width and height (null where they are `auto`), its padding and its border, zoomed. */
function ownSize(pcs: CSSStyleDeclaration, text: string | null, z: number): { w: number | null; h: number | null; frameW: number; frameH: number } {
  const pb = bordersOf(pcs, z), pp = paddingsOf(pcs, z), frameW = pb.l + pb.r + pp.l + pp.r, frameH = pb.t + pb.b + pp.t + pp.b;
  const sized = (v: string, frame: number): number | null => !v || v === 'auto' ? null : Math.max(frame, num(v) * z + (pcs.boxSizing === 'border-box' ? 0 : frame));
  let w = sized(pcs.width, frameW), h = sized(pcs.height, frameH);
  if (text) {
    const m = metrics(pcs, z, text), line = pcs.lineHeight === 'normal' || !pcs.lineHeight ? m.ascent + m.descent : num(pcs.lineHeight) * z;
    w ??= m.width + frameW; h ??= line + frameH;
  }
  return { w, h, frameW, frameH };
}

/** A pseudo-element's border box on the page, and for one that writes text in a line, where that text's baseline is. */
type PseudoBox = Box & { baseline?: number };

/** Where a box `own` long sits in `room` from `start` when lined up as `how` (`center`, `end`, or the start), with its margins. */
const lineUp = (how: string, start: number, room: number, own: number, m0: number, m1: number): number =>
  how.includes('center') ? start + m0 + (room - own - m0 - m1) / 2 : /end$/.test(how) ? start + room - m1 - own : start + m0;

/**
 * Where an element's `::before` or `::after` lies, worked out from the computed styles the page gives it (it gives no box), for the ways
 * this page places them: absolutely in the nearest positioned box (the help keys' marks, the lamps of the switch keys, the bars of a
 * close ✕), as an item of a flex line (the icons of Layouts, Go to and Recenter) or of a grid (an exchange's mark), as a block, or in a
 * line of text beside the element's first or last character (a status lamp, the carets of the coin and theme keys). `z` is the element's
 * zoom, which its pseudo-elements share.
 */
function pseudoBox(host: Element, hostBox: Box, hcs: CSSStyleDeclaration, pcs: CSSStyleDeclaration, which: 'before' | 'after', text: string | null, z: number): PseudoBox | null {
  const pm = marginsOf(pcs, z), size = ownSize(pcs, text, z), len = (v: string): number => num(v) * z;
  let w = size.w, h = size.h;
  if (pcs.position === 'absolute' || pcs.position === 'fixed') {
    const view = { x: 0, y: 0, w: document.documentElement.clientWidth, h: document.documentElement.clientHeight };
    let cb: Box | null = pcs.position === 'fixed' ? view : null;
    for (let el: Element | null = host; el && !cb; el = el.parentElement) {
      const cs = el === host ? hcs : getComputedStyle(el);
      if (cs.position !== 'static' || cs.transform !== 'none') cb = innerBox(el === host ? hostBox : boxOf(el.getBoundingClientRect()), cs, true, el === host ? z : zoomOf(el));
    }
    cb ??= view;
    const L = pcs.left, R = pcs.right, T = pcs.top, B = pcs.bottom, set = (v: string): boolean => !!v && v !== 'auto';
    w ??= set(L) && set(R) ? Math.max(size.frameW, cb.w - len(L) - len(R) - pm.l - pm.r) : size.frameW;
    h ??= set(T) && set(B) ? Math.max(size.frameH, cb.h - len(T) - len(B) - pm.t - pm.b) : size.frameH;
    const x = set(L) ? cb.x + len(L) + pm.l : set(R) ? cb.x + cb.w - len(R) - pm.r - w : cb.x + pm.l;
    const y = set(T) ? cb.y + len(T) + pm.t : set(B) ? cb.y + cb.h - len(B) - pm.b - h : cb.y + pm.t;
    return { x, y, w, h };
  }
  const inner = innerBox(hostBox, hcs, false, z), hd = hcs.display;
  let box: PseudoBox;
  if (hd.endsWith('flex')) {
    const row = !hcs.flexDirection.startsWith('column');
    const crossAlign = pcs.alignSelf && pcs.alignSelf !== 'auto' && pcs.alignSelf !== 'normal' ? pcs.alignSelf : hcs.alignItems;
    const stretch = crossAlign === 'normal' || crossAlign === 'stretch';
    if (row) { w ??= size.frameW; h ??= stretch ? Math.max(size.frameH, inner.h - pm.t - pm.b) : size.frameH; }
    else { h ??= size.frameH; w ??= stretch ? Math.max(size.frameW, inner.w - pm.l - pm.r) : size.frameW; }
    const mine: FlexItem = { size: row ? w : h, before: row ? pm.l : pm.t, after: row ? pm.r : pm.b };
    // The other pseudo-element takes its place in the line too.
    const other = getComputedStyle(host, which === 'before' ? '::after' : '::before');
    const others: FlexItem[] = [];
    if (pseudoInLine(other)) {
      const o = ownSize(other, contentText(other.content, name => host.getAttribute(name)), z), om = marginsOf(other, z);
      others.push({ size: (row ? o.w : o.h) ?? 0, before: row ? om.l : om.t, after: row ? om.r : om.b });
    }
    const items = which === 'before' ? [mine, ...flexItems(host, row), ...others] : [...others, ...flexItems(host, row), mine];
    const starts = flexStarts(row ? inner.x : inner.y, row ? inner.w : inner.h, len(row ? hcs.columnGap : hcs.rowGap), hcs.justifyContent, items);
    const main = which === 'before' ? starts[0]! : starts[starts.length - 1]!;
    const cross = row ? lineUp(crossAlign, inner.y, inner.h, h, pm.t, pm.b) : lineUp(crossAlign, inner.x, inner.w, w, pm.l, pm.r);
    box = row ? { x: main, y: cross, w, h } : { x: cross, y: main, w, h };
  } else if (hd.endsWith('grid')) {
    const jx = pcs.justifySelf && !['auto', 'normal'].includes(pcs.justifySelf) ? pcs.justifySelf : hcs.justifyItems;
    const ay = pcs.alignSelf && !['auto', 'normal'].includes(pcs.alignSelf) ? pcs.alignSelf : hcs.alignItems;
    w ??= jx.includes('center') || /end$/.test(jx) ? size.frameW : Math.max(size.frameW, inner.w - pm.l - pm.r);
    h ??= ay.includes('center') || /end$/.test(ay) ? size.frameH : Math.max(size.frameH, inner.h - pm.t - pm.b);
    box = { x: lineUp(jx, inner.x, inner.w, w, pm.l, pm.r), y: lineUp(ay, inner.y, inner.h, h, pm.t, pm.b), w, h };
  } else if (/^(block|flex|grid|table|list-item|flow-root)$/.test(pcs.display)) {
    w ??= Math.max(size.frameW, inner.w - pm.l - pm.r); h ??= size.frameH;
    box = { x: inner.x + pm.l, y: which === 'before' ? inner.y + pm.t : inner.y + inner.h - pm.b - h, w, h };
  } else {
    w ??= size.frameW; h ??= size.frameH;
    const next = edgeContent(host, which);
    const x = !next ? inner.x + pm.l : which === 'before' ? next.box.x - pm.r - w : next.box.x + next.box.w + pm.l;
    let y = inner.y + (inner.h - h) / 2, baseline: number | undefined;
    if (next) {
      // The line's baseline, from the character beside it and its font (a child beside it: most of the way down its box).
      const line = next.box, hm = next.text ? metrics(next.text, z) : null;
      const base = hm ? line.y + line.h * hm.ascent / Math.max(1e-6, hm.ascent + hm.descent) : line.y + line.h * 0.8;
      const va = pcs.verticalAlign, fs = num(pcs.fontSize) * z;
      if (va === 'middle') y = base - (hm?.x ?? fs * 0.5) / 2 - h / 2;
      else if (va === 'top' || va === 'text-top') y = line.y + pm.t;
      else if (va === 'bottom' || va === 'text-bottom') y = line.y + line.h - pm.b - h;
      else {
        const shift = va.endsWith('px') ? len(va) : va === 'super' ? fs * 0.33 : va === 'sub' ? -fs * 0.2 : 0;
        // Text sits on the baseline; an empty box sits on it with its bottom margin.
        if (text) { baseline = base - shift; y = baseline - metrics(pcs, z).ascent - bordersOf(pcs, z).t - paddingsOf(pcs, z).t; }
        else y = base - shift - pm.b - h;
      }
    }
    box = { x, y, w, h, ...(baseline === undefined ? {} : { baseline }) };
  }
  if (pcs.position === 'relative') {
    const dx = pcs.left && pcs.left !== 'auto' ? len(pcs.left) : pcs.right && pcs.right !== 'auto' ? -len(pcs.right) : 0;
    const dy = pcs.top && pcs.top !== 'auto' ? len(pcs.top) : pcs.bottom && pcs.bottom !== 'auto' ? -len(pcs.bottom) : 0;
    box.x += dx; box.y += dy; if (box.baseline !== undefined) box.baseline += dy;
  }
  return box;
}

/** Paint an element's `::before` or `::after`: its box (background, border, mask), turned as it is turned, and the text it writes. */
function paintPseudo(painter: Painter, host: Element, hostBox: Box, hcs: CSSStyleDeclaration, which: 'before' | 'after', alpha: number, clip: Box | null, z: number): void {
  const pcs = getComputedStyle(host, `::${which}`), content = pcs.content;
  if (!content || content === 'none' || content === 'normal' || pcs.display === 'none' || pcs.visibility === 'hidden') return;
  const opacity = pcs.opacity === '' ? 1 : num(pcs.opacity); if (opacity <= 0) return;
  const view = intersect(painter.view, clip); if (!view) return;
  // One in its element's line lies in or about its element: an element far outside what is drawn is not measured (a GIF of a small area
  // walked the line of every key on the page).
  const near = (b: Box, by: number): boolean => intersect({ x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by }, view) !== null;
  if (pcs.position !== 'absolute' && pcs.position !== 'fixed' && !near(hostBox, 32)) return;
  let box: PseudoBox | null, text: string | null;
  try { text = contentText(content, name => host.getAttribute(name)); box = pseudoBox(host, hostBox, hcs, pcs, which, text, z); } catch { return; }
  if (!box || !(box.w > 0 && box.h > 0) || !Number.isFinite(box.x + box.y)) return;
  // A turned box stays within its longer side of where it was.
  if (!near(box, Math.max(box.w, box.h))) return;
  const ctx = painter.ctx(), placed = box;
  inState(ctx, alpha * opacity, clip, () => {
    turn(ctx, pcs.transform === 'none' ? null : zoomedMatrix(pcs.transform, z), originOf(pcs, z), placed.x, placed.y);
    clipped(ctx, placed, pcs, z, () => paintBox(ctx, placed, pcs, z));
    if (!text) return;
    const b = bordersOf(pcs, z), p = paddingsOf(pcs, z);
    ctx.font = fontOf(pcs, z); ctx.fillStyle = pcs.color; ctx.textAlign = 'left'; spaceLetters(ctx, pcs, z);
    const shown = pcs.textTransform === 'uppercase' ? text.toUpperCase() : pcs.textTransform === 'lowercase' ? text.toLowerCase() : text;
    if (placed.baseline !== undefined) { ctx.textBaseline = 'alphabetic'; ctx.fillText(shown, placed.x + b.l + p.l, placed.baseline); }
    else { ctx.textBaseline = 'middle'; ctx.fillText(shown, placed.x + b.l + p.l, placed.y + b.t + p.t + (placed.h - b.t - b.b - p.t - p.b) / 2 + 0.5); }
  });
}

/**
 * A select's chosen text and caret, a slider, a check box or a text field's value; its sizes zoomed with it (`z`). A select or check box
 * drawn by the page itself (`appearance: none`, the Classic frame's, whose arrow and tick are background pictures) gets no caret, box or
 * tick of ours.
 */
function paintControl(ctx: Ctx2D, node: Element, rect: DOMRect, cs: CSSStyleDeclaration, z: number): void {
  const pad = (num(cs.paddingLeft) + num(cs.borderLeftWidth)) * z, mid = rect.top + rect.height / 2;
  ctx.font = fontOf(cs, z); ctx.fillStyle = cs.color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  if (node instanceof HTMLSelectElement) {
    ctx.fillText(node.selectedOptions[0]?.text ?? '', rect.left + pad, mid + 0.5, Math.max(0, rect.width - pad - 22 * z));
    if ((cs.appearance || cs.webkitAppearance) === 'none') return;
    ctx.strokeStyle = cs.color; ctx.lineWidth = 1.3 * z; ctx.beginPath();
    ctx.moveTo(rect.right - 14 * z, mid - 2 * z); ctx.lineTo(rect.right - 10.5 * z, mid + 1.5 * z); ctx.lineTo(rect.right - 7 * z, mid - 2 * z); ctx.stroke();
  } else if (node instanceof HTMLInputElement) {
    if (node.type === 'range') {
      const min = num(node.min || '0'), max = num(node.max || '100'), at = max > min ? (num(node.value) - min) / (max - min) : 0;
      const x0 = rect.left + 6 * z, x1 = rect.right - 6 * z;
      ctx.strokeStyle = 'rgba(128,128,128,.55)'; ctx.lineWidth = 3 * z; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x0, mid); ctx.lineTo(x1, mid); ctx.stroke();
      ctx.fillStyle = cs.accentColor && cs.accentColor !== 'auto' ? cs.accentColor : cs.color; ctx.beginPath(); ctx.arc(x0 + (x1 - x0) * at, mid, 5.5 * z, 0, Math.PI * 2); ctx.fill();
    } else if (node.type === 'checkbox') {
      if ((cs.appearance || cs.webkitAppearance) === 'none') return;
      const i = 1.5 * z; ctx.strokeStyle = cs.color; ctx.lineWidth = 1.2 * z; ctx.strokeRect(rect.left + i, rect.top + i, rect.width - 2 * i, rect.height - 2 * i);
      if (node.checked) { ctx.lineWidth = 1.8 * z; ctx.beginPath(); ctx.moveTo(rect.left + 3.5 * z, mid); ctx.lineTo(rect.left + rect.width * 0.42, rect.bottom - 4 * z); ctx.lineTo(rect.right - 3.5 * z, rect.top + 4 * z); ctx.stroke(); }
    } else if (node.value) ctx.fillText(node.value, rect.left + pad, mid + 0.5, Math.max(0, rect.width - 2 * pad));
  }
}

/**
 * Where a walk paints: `ctx` is where boxes and text go now (asked only for something that shows in `view`), `canvas` takes a canvas
 * element where it lies, with the opacity and the clip it is seen through.
 */
interface Painter {
  view: Box;
  ctx(): Ctx2D;
  canvas(node: HTMLCanvasElement, rect: Box, alpha: number, clip: Box | null): void;
}

/** Paint with the walk's opacity and clip, then put the context back as it was. */
function inState(ctx: Ctx2D, alpha: number, clip: Box | null, paint: () => void): void {
  ctx.save(); ctx.globalAlpha = alpha;
  if (clip) { ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip(); }
  // One element that cannot be drawn is left out, never the picture (the context is put back either way).
  try { paint(); } catch { /* left out */ } finally { ctx.restore(); }
}

/**
 * A text node, word by word where the page lays each word, in its element's font (zoomed by `z`). A word never runs wider than the page
 * draws it: where the canvas finds a wider face for the font, it is narrowed to its place rather than running into the next word.
 */
function paintText(painter: Painter, node: Text, cs: CSSStyleDeclaration, alpha: number, clip: Box | null, z: number): void {
  const data = node.data; if (!data.trim()) return;
  const view = intersect(painter.view, clip); if (!view) return;
  const transform = cs.textTransform, range = document.createRange();
  let ctx: Ctx2D | null = null;
  for (const match of data.matchAll(/\S+/g)) {
    range.setStart(node, match.index!); range.setEnd(node, match.index! + match[0].length);
    const rect = range.getBoundingClientRect(); if (rect.width === 0 && rect.height === 0) continue;
    if (!intersect(boxOf(rect), view)) continue;
    if (!ctx) {
      ctx = painter.ctx(); ctx.save(); ctx.globalAlpha = alpha;
      if (clip) { ctx.beginPath(); ctx.rect(clip.x, clip.y, clip.w, clip.h); ctx.clip(); }
      ctx.font = fontOf(cs, z); ctx.fillStyle = cs.color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; spaceLetters(ctx, cs, z);
    }
    const shown = (text: string): string => transform === 'uppercase' ? text.toUpperCase() : transform === 'lowercase' ? text.toLowerCase() : text;
    if (range.getClientRects().length > 1) {
      // A run without spaces that the page wraps over lines (Chinese, Japanese): each character where the page lays it.
      let at = match.index!;
      for (const char of match[0]) {
        range.setStart(node, at); range.setEnd(node, at + char.length); at += char.length;
        const r = range.getBoundingClientRect();
        if ((r.width > 0 || r.height > 0) && intersect(boxOf(r), view)) ctx.fillText(shown(char), r.left, r.top + r.height / 2 + 0.5, r.width + 0.5);
      }
      continue;
    }
    ctx.fillText(shown(match[0]), rect.left, rect.top + rect.height / 2 + 0.5, rect.width + 0.5);
  }
  ctx?.restore();
}

/** How an SVG text's `text-anchor` lines it up on its x, as a canvas `textAlign`. */
export const svgAlign = (anchor: string): CanvasTextAlign => anchor === 'middle' ? 'center' : anchor === 'end' ? 'end' : 'start';
/**
 * An SVG text's `dominant-baseline` as a canvas `textBaseline`. SVG's `middle` is half the x-height above the alphabetic baseline, not the
 * middle of the em box as the canvas's is: it is drawn on the alphabetic baseline and moved up by half the x-height (`paintSvgLeaf`).
 */
export const svgBaseline = (baseline: string): CanvasTextBaseline =>
  baseline === 'central' ? 'middle' : baseline === 'hanging' ? 'hanging' : baseline === 'text-before-edge' ? 'top' : baseline === 'text-after-edge' ? 'bottom' : 'alphabetic';
/** A computed `stroke-dasharray` ("none", "2px, 2px", "2 2") as a canvas line dash (a share of the viewport is not resolved: no dash). */
export const svgDash = (dash: string): number[] => dash && dash !== 'none' && !dash.includes('%') ? dash.split(/[\s,]+/).map(num).filter(n => n >= 0) : [];
/** A computed `fill` or `stroke` that paints a plain colour: not "none", nor a gradient or pattern by reference. */
export const svgPaints = (paint: string): boolean => !!paint && paint !== 'none' && !paint.startsWith('url(');
/** The order fill and stroke are painted in from a computed `paint-order` ("normal", "stroke", "markers stroke fill"): those named first, in their order, then the rest in the normal order. */
export function svgPaintOrder(order: string): ('fill' | 'stroke')[] {
  const named = order.trim() === 'normal' ? [] : order.trim().split(/\s+/).filter((part): part is 'fill' | 'stroke' => part === 'fill' || part === 'stroke');
  return [...named, ...(['fill', 'stroke'] as const).filter(part => !named.includes(part))];
}

/** A shape's outline in its own units; null for one of no size, or an element that is not drawn as a shape here. */
function svgShape(el: SVGGraphicsElement): Path2D | null {
  const p = new Path2D();
  if (el instanceof SVGRectElement) {
    const x = el.x.baseVal.value, y = el.y.baseVal.value, w = el.width.baseVal.value, h = el.height.baseVal.value;
    if (!(w > 0 && h > 0)) return null;
    // An `rx` alone rounds both ways, as does a `ry` alone.
    const rx0 = el.rx.baseVal.value, ry0 = el.ry.baseVal.value, rx = Math.min(w / 2, rx0 > 0 ? rx0 : Math.max(0, ry0)), ry = Math.min(h / 2, ry0 > 0 ? ry0 : Math.max(0, rx0));
    if ((rx > 0 || ry > 0) && typeof p.roundRect === 'function') p.roundRect(x, y, w, h, [{ x: rx, y: ry }]); else p.rect(x, y, w, h);
  } else if (el instanceof SVGLineElement) { p.moveTo(el.x1.baseVal.value, el.y1.baseVal.value); p.lineTo(el.x2.baseVal.value, el.y2.baseVal.value); }
  else if (el instanceof SVGCircleElement) { const r = el.r.baseVal.value; if (!(r > 0)) return null; p.arc(el.cx.baseVal.value, el.cy.baseVal.value, r, 0, Math.PI * 2); }
  else if (el instanceof SVGEllipseElement) { const rx = el.rx.baseVal.value, ry = el.ry.baseVal.value; if (!(rx > 0 && ry > 0)) return null; p.ellipse(el.cx.baseVal.value, el.cy.baseVal.value, rx, ry, 0, 0, Math.PI * 2); }
  else if (el instanceof SVGPolylineElement || el instanceof SVGPolygonElement) {
    const points = el.points; if (points.numberOfItems < 2) return null;
    for (let i = 0; i < points.numberOfItems; i++) { const pt = points.getItem(i); if (i) p.lineTo(pt.x, pt.y); else p.moveTo(pt.x, pt.y); }
    if (el instanceof SVGPolygonElement) p.closePath();
  } else if (el instanceof SVGPathElement) return new Path2D(el.getAttribute('d') ?? '');
  else return null;
  return p;
}

/** One shape or text, filled and stroked from its computed style, placed and turned as the page draws it (`getScreenCTM`). */
function paintSvgLeaf(ctx: Ctx2D, el: SVGGraphicsElement, cs: CSSStyleDeclaration, alpha: number): void {
  const m = el.getScreenCTM(); if (!m) return;
  let text: { content: string; x: number; y: number } | null = null, shape: Path2D | null = null;
  if (el instanceof SVGTextElement) {
    const xs = el.x.baseVal, ys = el.y.baseVal;
    text = { content: el.textContent ?? '', x: xs.numberOfItems ? xs.getItem(0).value : 0, y: ys.numberOfItems ? ys.getItem(0).value : 0 };
    if (!text.content.trim()) return;
  } else if (!(shape = svgShape(el))) return;
  ctx.save();
  try {
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    if (text) {
      ctx.font = fontOf(cs); ctx.direction = cs.direction === 'rtl' ? 'rtl' : 'ltr'; ctx.textAlign = svgAlign(cs.textAnchor); ctx.textBaseline = svgBaseline(cs.dominantBaseline);
      if (cs.dominantBaseline === 'middle') text.y += ctx.measureText('x').actualBoundingBoxAscent / 2;
    }
    for (const part of svgPaintOrder(cs.paintOrder)) {
      if (part === 'fill') {
        if (!svgPaints(cs.fill)) continue;
        ctx.globalAlpha = alpha * (cs.fillOpacity === '' ? 1 : num(cs.fillOpacity)); ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillStyle = cs.fill;
        if (text) ctx.fillText(text.content, text.x, text.y); else ctx.fill(shape!, cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
      } else {
        const width = num(cs.strokeWidth); if (!svgPaints(cs.stroke) || width <= 0) continue;
        ctx.globalAlpha = alpha * (cs.strokeOpacity === '' ? 1 : num(cs.strokeOpacity)); ctx.strokeStyle = 'rgba(0,0,0,0)'; ctx.strokeStyle = cs.stroke;
        ctx.lineWidth = width; ctx.miterLimit = num(cs.strokeMiterlimit) || 4;
        ctx.lineCap = cs.strokeLinecap === 'round' || cs.strokeLinecap === 'square' ? cs.strokeLinecap : 'butt';
        ctx.lineJoin = cs.strokeLinejoin === 'round' || cs.strokeLinejoin === 'bevel' ? cs.strokeLinejoin : 'miter';
        ctx.setLineDash(svgDash(cs.strokeDasharray)); ctx.lineDashOffset = num(cs.strokeDashoffset);
        if (text) ctx.strokeText(text.content, text.x, text.y); else ctx.stroke(shape!);
      }
    }
  } finally { ctx.restore(); }
}

/**
 * An SVG drawing (the Volume profile panel's sketch of the chart), drawn shape by shape from each shape's computed style, where the page
 * puts it and turned as it turns it (`getScreenCTM`: its viewBox and every transform up to the screen). Walked as boxes and text, it came
 * out as its words strewn unturned over the panel and none of its shapes (Karl, 2026-10-20). Drawn: groups and nested drawings, rectangles
 * (rounded too), lines, circles, ellipses, polylines, polygons, paths and texts (one run each), in plain colours with their opacities,
 * dashes, caps, joins and `paint-order`. Left out: `use`, images, gradients, patterns, masks, clip paths and a nested drawing's own clip.
 * A group, or a shape both filled and stroked, seen through an opacity of its own is drawn whole on a layer of `area` (the drawing's box
 * on the page) and laid on once at that opacity, as SVG does: its parts never show through each other. One element that cannot be drawn
 * is left out, never the picture.
 */
function paintSvg(ctx: Ctx2D, node: Element, alpha: number, area: Box): void {
  for (const el of node.children) {
    if (!(el instanceof SVGGraphicsElement)) continue;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const opacity = cs.opacity === '' ? 1 : num(cs.opacity); if (opacity <= 0) continue;
      const group = el instanceof SVGGElement || el instanceof SVGSVGElement;
      const both = !group && svgPaints(cs.fill) && svgPaints(cs.stroke) && num(cs.strokeWidth) > 0;
      if (opacity < 1 && (group || both)) {
        const t = ctx.getTransform(), sx = Math.hypot(t.a, t.b), sy = Math.hypot(t.c, t.d), w = Math.ceil(area.w * sx), h = Math.ceil(area.h * sy);
        if (!(w > 0 && h > 0)) continue;
        const layer = surface(w, h), lc = context2d(layer);
        lc.setTransform(sx, 0, 0, sy, -area.x * sx, -area.y * sy);
        if (group) paintSvg(lc, el, 1, area); else paintSvgLeaf(lc, el, cs, 1);
        ctx.save(); ctx.globalAlpha = alpha * opacity; ctx.drawImage(layer, area.x, area.y, area.w, area.h); ctx.restore();
      } else if (group) paintSvg(ctx, el, alpha * opacity, area);
      else paintSvgLeaf(ctx, el, cs, alpha * opacity);
    } catch { /* an element that cannot be drawn is left out */ }
  }
}

/**
 * A positioned element with a z-index above 0: the page paints it over everything else in its stacking context, wherever it sits in the
 * tree (the bars over the glass: the glass is a z-index 50 child of the body, the bars 52 deep inside it), so it is kept and painted
 * there, after the rest.
 */
interface Raised { node: Element; cs: CSSStyleDeclaration; z: number; order: number; alpha: number; clip: Box | null }
let raisedOrder = 0;

/** Whether an element starts a stacking context of its own (the cases this page uses). */
const stacks = (cs: CSSStyleDeclaration): boolean => (cs.position !== 'static' && cs.zIndex !== 'auto') || num(cs.opacity) < 1 || cs.transform !== 'none' || cs.filter !== 'none' || cs.isolation === 'isolate' || cs.mixBlendMode !== 'normal';
const zOf = (cs: CSSStyleDeclaration): number => cs.position !== 'static' && cs.zIndex !== 'auto' ? num(cs.zIndex) : 0;

function paintRaised(painter: Painter, raised: Raised[]): void {
  for (const r of [...raised].sort((p, q) => p.z - q.z || p.order - q.order)) paintNode(painter, r.node, r.alpha, r.clip, [], r.cs);
}

function paintNode(painter: Painter, node: Element, alpha: number, clip: Box | null, raised: Raised[], cs: CSSStyleDeclaration = getComputedStyle(node)): void {
  if (cs.display === 'none' || cs.visibility === 'hidden' || node.hasAttribute('data-no-capture')) return;
  const opacity = num(cs.opacity); if (opacity <= 0) return;
  const rect = node.getBoundingClientRect(), box = boxOf(rect);
  const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
  // Nothing of a clipping box outside the view can show, and neither can any of its children.
  if (clips && !intersect(box, intersect(painter.view, clip))) return;
  const a = alpha * opacity, z = zoomOf(node);
  let inner = clip;
  if (rect.width > 0 && rect.height > 0) {
    const shows = intersect(box, intersect(painter.view, clip)) !== null;
    if (shows) {
      inState(painter.ctx(), a, clip, () => {
        const ctx = painter.ctx();
        // A turned box (a chevron turned to point another way) is drawn turned: the page gives the bounds of the turned shape.
        const m = cs.transform === 'none' ? null : zoomedMatrix(cs.transform, z), size = m ? borderBoxSize(cs, z) : null, origin = m ? originOf(cs, z) : null;
        const corner = m && size && origin ? unturnedCorner(box, size.w, size.h, m, origin) : null;
        if (corner && size && origin) {
          const own = { ...corner, ...size };
          ctx.save(); turn(ctx, m, origin, corner.x, corner.y);
          try { clipped(ctx, own, cs, z, () => paintBox(ctx, own, cs, z)); } finally { ctx.restore(); }
        } else clipped(ctx, box, cs, z, () => paintBox(ctx, box, cs, z));
        if (node instanceof HTMLSelectElement || node instanceof HTMLInputElement) paintControl(ctx, node, rect, cs, z);
      });
      if (node instanceof HTMLCanvasElement && node.width > 0 && node.height > 0) painter.canvas(node, box, a, clip);
    }
    if (clips) inner = intersect(box, clip) ?? box;
  }
  if (node instanceof HTMLSelectElement || node instanceof HTMLInputElement || node instanceof HTMLCanvasElement) return;
  // An SVG drawing is drawn shape by shape: its shapes have no boxes, and its text is not laid out as an element's is.
  if (node instanceof SVGSVGElement) {
    // Clipped to its own box (an SVG's overflow is hidden) and to whatever clips it on the page.
    if (rect.width > 0 && rect.height > 0 && intersect(box, intersect(painter.view, clip))) { const ctx = painter.ctx(); inState(ctx, 1, inner, () => paintSvg(ctx, node, a, box)); }
    return;
  }
  // `::before` is painted before the children and `::after` after them, as the page paints them (both inside this element's clip).
  const sized = rect.width > 0 && rect.height > 0;
  if (sized) paintPseudo(painter, node, box, cs, 'before', a, inner, z);
  // Children with a z-index above 0 wait for the end of the stacking context they belong to (this one, if it starts one); those below 0
  // come first, the rest in the order of the page.
  const own = stacks(cs) ? [] as Raised[] : raised;
  const items: { child: Node; cs: CSSStyleDeclaration | null; z: number; i: number }[] = [];
  node.childNodes.forEach((child, i) => {
    if (child instanceof Element) { const c = getComputedStyle(child), level = zOf(c); if (level > 0) own.push({ node: child, cs: c, z: level, order: raisedOrder++, alpha: a, clip: inner }); else items.push({ child, cs: c, z: level, i }); }
    else if (child instanceof Text) items.push({ child, cs: null, z: 0, i });
  });
  items.sort((p, q) => p.z - q.z || p.i - q.i);
  for (const { child, cs: c } of items) {
    if (child instanceof Element) paintNode(painter, child, a, inner, own, c!);
    else if (child instanceof Text) paintText(painter, child, cs, a, inner, z);
  }
  if (sized) paintPseudo(painter, node, box, cs, 'after', a, inner, z);
  if (own !== raised) paintRaised(painter, own);
}

/** Elements of the page that are never in its picture: the screenshot tool itself, its notices and tooltips. */
const LEFT_OUT = '.shot, .shot-stage, .shot-toast, .tip';

function walk(painter: Painter, root: HTMLElement): void {
  const raised: Raised[] = [];
  for (const child of root.children) {
    if (child.matches(LEFT_OUT)) continue;
    const cs = getComputedStyle(child), z = zOf(cs);
    if (z > 0) raised.push({ node: child, cs, z, order: raisedOrder++, alpha: 1, clip: null }); else paintNode(painter, child, 1, null, raised, cs);
  }
  paintRaised(painter, raised);
}

/**
 * Draw the page as it is on screen now. Open panels and dialogs are included; tooltips are not (they are hidden by the click that started
 * this). The WebGL canvases that lose their picture draw again first, and are copied before this task ends. `scale` is picture pixels per
 * CSS pixel: the screen's unless a sharp picture asks for more (`capturePageSharp`, which has sized the panes' canvases for it).
 */
export function capturePage(root: HTMLElement = document.body, scale = Math.max(1, Math.min(3, window.devicePixelRatio || 1))): Snapshot {
  takeUnread();
  drawLiveCanvases();
  const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  walk({
    view: { x: 0, y: 0, w: width, h: height },
    ctx: () => ctx,
    canvas: (node, rect, alpha, clip) => inState(ctx, alpha, clip, () => { try { ctx.drawImage(node, rect.x, rect.y, rect.w, rect.h); } catch { /* a tainted or lost canvas is skipped */ } }),
  }, root);
  return { canvas, scale, width, height };
}

/** How long a picture waits for the mask pictures it met before they were read (ms); the icons of a mask still unread are left out. */
const MASK_WAIT_MS = 400;

/**
 * The page sharper than the screen shows it: every pane that can (pixel-ratio.ts) is sized and drawn at `scale`, the page is drawn, and the
 * panes are sized and drawn at the screen's again, all in this task, so the page never shows a frame of it. Its own canvases are as they
 * were afterwards, whatever went wrong. A canvas that is not one of them (the heatmap's raster is its own size) is drawn larger.
 */
export function capturePageSharp(root: HTMLElement, scale: number): Snapshot {
  paintAt(scale);
  try { return capturePage(root, scale); } finally { paintAt(null); }
}

/**
 * The page as `capturePage` draws it, with its icons, and at least two picture pixels to a CSS pixel where the screen has fewer
 * (`sharpScale`; Karl, 2026-11-07: "nice high-resolution images"): a walk that meets a mask picture not read yet (the first picture after the
 * page opens) waits for it, then draws the page again. Later pictures find them read and are drawn once.
 */
export async function capturePageReady(root: HTMLElement = document.body): Promise<Snapshot> {
  const sharp = sharpScale(window.devicePixelRatio || 1, document.documentElement.clientWidth, document.documentElement.clientHeight);
  // A sharp picture that fails (the panes are back at the screen's either way) is taken as the screen shows it rather than not at all.
  const take = (): Snapshot => { if (sharp) { try { return capturePageSharp(root, sharp); } catch (error) { console.warn('the sharp picture failed; taken as the screen shows it:', error); } } return capturePage(root); };
  const first = take(), waiting = takeUnread();
  if (!waiting.length) return first;
  await Promise.race([Promise.allSettled(waiting), new Promise(done => setTimeout(done, MASK_WAIT_MS))]);
  return take();
}

/** A canvas a moving picture copies each frame: where it lies on the page (CSS px), and the opacity and clip it is seen through. */
export interface LiveCanvas { kind: 'canvas'; node: HTMLCanvasElement; rect: Box; alpha: number; clip: Box | null }
/** What lies between two canvases, painted once for the area. */
export interface StillLayer { kind: 'still'; image: HTMLCanvasElement | OffscreenCanvas }
export type Layer = LiveCanvas | StillLayer;

/** A canvas for a picture `w` × `h`, off the page where the browser has them. */
export function surface(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

/** The 2D context of a canvas on or off the page. */
export function context2d(c: HTMLCanvasElement | OffscreenCanvas, options?: CanvasRenderingContext2DSettings): Ctx2D {
  const ctx = c instanceof HTMLCanvasElement ? c.getContext('2d', options) : c.getContext('2d', options);
  if (!ctx) throw new Error('no 2D canvas');
  return ctx;
}

/**
 * The page in `area` (CSS px) as layers at `scale` picture pixels per CSS pixel, in the page's order: the still parts (boxes, borders,
 * text, controls) painted now, the canvases named so a frame can copy them as they are then. The first layer holds the page's background.
 */
export function paintLayers(area: Box, scale: number, root: HTMLElement = document.body): Layer[] {
  // A recording does not wait for mask pictures (the picture it starts from has read them): what its walks meet is not kept.
  takeUnread();
  const w = Math.max(1, Math.round(area.w * scale)), h = Math.max(1, Math.round(area.h * scale));
  const layers: Layer[] = [];
  let current: Ctx2D | null = null;
  const open = (): Ctx2D => {
    if (current) return current;
    const image = surface(w, h), ctx = context2d(image);
    ctx.setTransform(scale, 0, 0, scale, -area.x * scale, -area.y * scale);
    layers.push({ kind: 'still', image }); current = ctx;
    return ctx;
  };
  const base = open();
  base.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff'; base.fillRect(area.x, area.y, area.w, area.h);
  walk({
    view: area,
    ctx: open,
    canvas: (node, rect, alpha, clip) => { if (intersect(rect, intersect(area, clip))) { layers.push({ kind: 'canvas', node, rect, alpha, clip }); current = null; } },
  }, root);
  return layers;
}
