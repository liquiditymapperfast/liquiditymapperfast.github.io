import { WAVE_GLSL, WAVE_STRENGTH_DEFAULT, WaveField, strengthGain, type WaveRegion } from '../glass/waves.ts';
import { STRIDE, type TapeRing } from '../tape/ring.ts';
import { built, startProgram, uniforms, type Building } from '../gl-build.ts';
import type { TrailStyle } from './model.ts';

/**
 * The Candle view's trade trail and its arrival flashes, on a canvas of their own behind the book and the candle.
 *
 * The trail: every market order of the last `windowMs` (the tape ring the trade dust reads, tape/ring.ts), at its exchange time across the
 * screen (now at `x1`, the window ago at `x0`) and its price on the candle's price axis, sized by its USD on a log scale, buys filled and
 * sells hollow (the shape says the side as well as the colour, so it reads in grey and in the colour-blind palette), dimmer as it ages.
 * The card keeps its own copy of the newest MIRROR orders of the ring, and only orders that arrived since the last frame are copied to it
 * (all of them again after a rebase or a clear): a frame moves the trail by its clock alone, so it flows at the display's rate for the
 * price of a few uniforms and one draw per run of the ring. Moving it only when it had gone a pixel (five times a second across a minute)
 * read as a page running at 5 frames a second on a phone (Karl, Pixel 10, 2026-10-16).
 *
 * The flashes: the rows of the arrival rail that just received a large order (worked out by the pane, candle/model.ts `flashes`), each a
 * short, monotonic fade: a bright core cooling to its side's colour. They are timed by arrival, the trail by exchange time: a batch that
 * arrives late lights the rail now and lands in the trail where it traded.
 *
 * The glass: with `glass` set, the trail is drawn off screen first and copied out through three pieces of glass laid over it, the bid
 * book's, the candle's and the ask book's, welded where they meet (Karl, 2026-10-16). Each piece is a slab with polished, rounded edges:
 * near an edge what is behind it is bent (the copy is read from further in, its three colours a little apart, as a lens separates them),
 * the edges facing the light (top left) are lit and the others shaded, and its body is tinted. The book's pieces are clear, so the trail
 * reads through them; the candle's is thick and frosted, a quarter-size copy blurred with a separable Gaussian, and where the bar was not
 * recorded it is sandblasted milky instead of striped. A weld is a bead of fused glass: what is behind it is bent across it, more or less
 * along its length in the irregular ripple a hand-made seam has, under a bright streak and a dark one. With `bricks` a book piece is glass
 * only inside its bars, each row a block of its own (`setRows`), so the book's shape is the glass's. Done here rather than with CSS
 * `backdrop-filter`, which is costly over canvases (AGENTS.md "Words and look").
 *
 * Three looks over the same encoding: Phosphor (light emitted: added up where orders crowd on a dark page, a soft halo, a camera-flash star
 * on arrivals), Etched (crisp dots and rings, no glow, as if engraved), Beads (small lit spheres and rings with a fixed highlight). On a light
 * page nothing is added: light on white cannot be seen, so every look is drawn over.
 */
export interface FlashSprite { x: number; y: number; r: number; /** Bought USD over bought and sold. */ share: number; /** How lit, 1 to 0. */ k: number }

export interface TrailFrame {
  style: TrailStyle; dark: boolean;
  bid: [number, number, number]; ask: [number, number, number]; mid: [number, number, number];
  /** The exchange time at the trail's right edge (absolute ms) and how far back its left edge is. */
  now: number; windowMs: number;
  /** CSS px: the trail's left (oldest) and right (now) edges, and the plot's top and bottom with the prices there (`p1` at the top). */
  x0: number; x1: number; y0: number; y1: number; p0: number; p1: number;
  /** Orders this size (USD) and smaller are the smallest dot, `ceilUsd` and larger the largest. */
  floorUsd: number; ceilUsd: number;
  opacity: number;
  flashes: readonly FlashSprite[];
  /** The pieces of glass over the trail, or null for none. */
  glass: GlassFrame | null;
}

export interface GlassFrame {
  /** CSS px: the pieces' top and bottom. */
  y0: number; y1: number;
  /** Left to right, CSS px: the bid book's, the candle's and the ask book's; the welds are the gaps between neighbours. */
  pieces: readonly { x0: number; x1: number; candle: boolean }[];
  /** Up to two stretches of the candle nobody recorded (CSS px, top-down), frosted milky. */
  frost: readonly { y0: number; y1: number }[];
  /** The book's pieces are glass only inside their bars (`setRows`). */
  bricks: boolean;
  /** How liquidity added and pulled shows on the book's glass (candle/model.ts `PulseLook`), and the clock its pulses are timed on (ms). */
  pulse: 'off' | 'pressure' | 'deposit'; nowMs: number;
  /**
   * The book's bars are filled here, not on the page's canvas, so a pulse can brighten or dim its row: the fill's opacity and the two
   * sides' colours (0-1 RGB).
   */
  fill: number; bookBid: readonly [number, number, number]; bookAsk: readonly [number, number, number];
  /** How strongly the waves are drawn (glass/waves.ts `strengthGain` of the person's Strength); the default Strength's without one. */
  waveGain?: number;
}

const STYLE_ID: Record<TrailStyle, number> = { phosphor: 0, etched: 1, beads: 2 };
/** The orders the card holds (the newest of the ring): more than two minutes of BTC's busiest second-by-second pace. 3 MiB. */
const MIRROR = 1 << 17;
const MAX_FLASH = 64, FLASH_STRIDE = 5;
/** Texels per device row of the book's rows (`setRows`): the bars, the pulses, the bars before them. */
export const ROW_TEXELS = 3;
/** The frosted copy's scale (a quarter of the screen) and how far apart the blur's taps are, in its pixels. */
const GLASS_DOWN = 4, GLASS_SPREAD = 1.6;

const FULL_VERT = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

/** The small copy: each of its pixels the mean of the 4 x 4 drawn pixels under it (four bilinear taps). */
const DOWN_FRAG = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D src; uniform vec2 small, texel; out vec4 color;
void main() {
  vec2 uv = gl_FragCoord.xy / small;
  color = 0.25 * (texture(src, uv + texel * vec2(-1.0, -1.0)) + texture(src, uv + texel * vec2(1.0, -1.0)) + texture(src, uv + texel * vec2(-1.0, 1.0)) + texture(src, uv + texel * vec2(1.0, 1.0)));
}`;

/** One direction of a 9-tap Gaussian, in five bilinear taps (the weights and offsets of the usual linear-sampling split). */
const BLUR_FRAG = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D src; uniform vec2 size, dir; out vec4 color;
void main() {
  vec2 uv = gl_FragCoord.xy / size, t = dir / size;
  color = texture(src, uv) * 0.2270270270
    + (texture(src, uv + t * 1.3846153846) + texture(src, uv - t * 1.3846153846)) * 0.3162162162
    + (texture(src, uv + t * 3.2307692308) + texture(src, uv - t * 3.2307692308)) * 0.0702702703;
}`;

/**
 * The screen: the trail as drawn, and the pieces of glass over it (see the class's note). Coordinates are the card's (device px, rows bottom
 * up). `piece[i]` is x0, x1, 1 for the candle, and its bevel; `ext` the pieces' bottom and top; `frost` two stretches of the candle
 * (bottom, top each; empty when the bottom is above the top); `rows` per device row from the top, three texels: the bid bar's width, the
 * ask bar's, how far the row's top and bottom are; each side's pulse (its sign times its strength, 2 more when trades reached it) and when it
 * began; each side's bar width before the change. A pulse lights or shades the row's glass by its look (`pulse` 1 pressure, 2 deposit).
 */
const COMP_FRAG = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D scene, small, rows;
uniform vec2 px, ext; uniform float gain, dpr; uniform vec4 piece[3], frost; uniform int count; uniform bool bricks, dark;
uniform vec3 tintC, bidC, askC, bookBid, bookAsk; uniform vec2 tintA; uniform int pulse; uniform float nowMs, fillA; uniform bool hasRows;
${WAVE_GLSL}
out vec4 color;
// A wave's front laid on a colour (premultiplied): added light on a dark page, the side's colour laid over on a light one; held to a faint
// line however strong it is (the tone curve), so it never hides what is under it.
vec4 crest(vec4 c, vec2 wf, float gain) {
  float a = gain * (1.0 - exp(-(wf.r + wf.g) * 2.5));
  if (a < 0.002) return c;
  vec3 col = (bidC * wf.r + askC * wf.g) / max(wf.r + wf.g, 1e-3);
  if (!dark) { a = min(1.0, a * 1.45); col = mix(col, vec3(0.0), 0.55); }
  return dark ? vec4(c.rgb + col * a * 1.6, max(c.a, a)) : vec4(c.rgb * (1.0 - a) + col * a, c.a + a * (1.0 - c.a));
}
// A pulse's envelope: up over 80 ms, then down over about 450 (candle/model.ts pulseEnvelope).
float envelope(float age) { return age < 0.0 || age > 1500.0 ? 0.0 : age < 80.0 ? age / 80.0 : exp(-2.2 * (age - 80.0) / 450.0); }
// The light (premultiplied) and the shade a row's change puts on the book's glass at distance d from the book's inner edge, and how much
// brighter (above 1) or dimmer its bar's fill is: liquidity added lights the row up, pulled dims it (Karl, 2026-10-16).
vec4 pulseLight(bool bid, float d, float wBar, vec4 g1, int row, out float shade, out float fill) {
  shade = 0.0; fill = 1.0;
  float v = bid ? g1.r : g1.g, at = bid ? g1.b : g1.a;
  if (pulse == 0 || v == 0.0) return vec4(0.0);
  // The bars before the change only for a row that has one (most rows have none).
  vec4 g2 = texelFetch(rows, ivec2(2, row), 0); float before = bid ? g2.r : g2.g;
  bool traded = abs(v) > 1.5; float strength = abs(v) - (traded ? 2.0 : 0.0), age = nowMs - at, env = envelope(age) * strength;
  // A pull's outline in Deposit dissolves on its own, slower clock; everything else ends with the envelope.
  bool outline = pulse == 2 && v < 0.0;
  if (env <= 0.002 && !outline) return vec4(0.0);
  vec3 side = bid ? bookBid : bookAsk, glow = mix(side, vec3(1.0), 0.45);
  bool inside = d <= wBar;
  vec4 light = vec4(0.0);
  if (pulse == 1) {
    // Pressure: stacked liquidity compresses into a bright rim at the bar's outer edge, the row lit from inside (and, on a light page, a
    // contact shadow beyond the edge); pulled liquidity leaves the row dimmer and its edge recessed, a darker line with a faint lit bevel
    // just inside it.
    float p = exp(-pow((d - wBar) / (3.5 * dpr), 2.0));
    if (v > 0.0) {
      fill = 1.0 + 1.5 * env;
      light = dark ? vec4(glow * env * p * 1.25, env * p) : vec4(side * env * p * 0.95, env * p * 0.95);
      if (!dark) shade += env * 0.25 * exp(-pow((d - wBar - 2.5 * dpr) / (2.0 * dpr), 2.0));
    } else {
      fill = 1.0 - 0.65 * env;
      shade += env * p * (dark ? 0.75 : 0.45) + (inside && !dark ? env * 0.1 : 0.0);
      float bevel = exp(-pow((d - wBar + 2.0 * dpr) / (1.2 * dpr), 2.0)) * env * (dark ? 0.3 : 0.2);
      light = vec4(vec3(dark ? 1.0 : 0.0) * bevel, bevel);
    }
  } else {
    // Deposit: new liquidity a layer glowing between the old edge and the new one as it fuses in, the row a little brighter; removed, a
    // hollow outline where the edge was, dissolving a little slower, and the row a little dimmer.
    if (v > 0.0) {
      fill = 1.0 + (dark ? 0.5 : 0.9) * env;
      // The layer is denser toward its new face, and fused to the old one along a bright seam; the new face itself lit, so an addition too
      // thin to see as a layer still shows.
      float inLayer = smoothstep(before - 1.0, before + 1.0, d) * (1.0 - smoothstep(wBar - 1.0, wBar + 1.0, d));
      float t = clamp((d - before) / max(wBar - before, 1.0), 0.0, 1.0), a = env * inLayer * (0.22 + 0.4 * t * t);
      float seam = exp(-pow((d - before) / (1.0 * dpr), 2.0)) * env * (wBar - before > 2.0 * dpr ? 0.55 : 0.0);
      float face = exp(-pow((d - wBar) / (1.6 * dpr), 2.0)) * env;
      light = dark ? vec4(glow * (a * 1.1 + seam + face * 0.7), max(a, max(seam, face * 0.7))) : vec4(side * (a * 0.8 + seam * 0.6 + face * 0.75), max(a * 0.8, max(seam * 0.6, face * 0.75)));
    } else {
      fill = 1.0 - 0.5 * env;
      // Slower than the envelope, and down to a trace by the pulse's end (1.5 s), so it fades out rather than vanishing.
      float slow = exp(-max(0.0, age - 80.0) / 380.0) * strength * (age < 0.0 || age > 1500.0 ? 0.0 : 1.0);
      float line = exp(-pow((d - before) / (1.3 * dpr), 2.0)) * slow;
      light = dark ? vec4(glow * line * 0.85, line * 0.85) : vec4(vec3(0.15) * line * 0.7, line * 0.7);
    }
  }
  // The shock: a front of pressure through the row, outward from the book's inner edge to the new edge where liquidity was added, inward
  // from the old edge back to the inner one where it was pulled (Karl, 2026-10-17: a pull sends its wave back as an addition sends one
  // out), as strong as the change and gone within half a second.
  if (env > 0.002) {
    float speed = 0.17 * dpr, front = v > 0.0 ? age * speed : max(before, wBar) - age * speed;
    bool running = v > 0.0 ? front <= wBar + 5.0 * dpr : front >= -1.0 * dpr;
    if (running && d <= max(before, wBar) + 4.0 * dpr) {
      float shock = exp(-pow((d - front) / (2.2 * dpr), 2.0)) * strength * exp(-age / 520.0);
      vec3 sc = v > 0.0 ? glow : mix(side, vec3(1.0), 0.65);
      light += dark ? vec4(sc * shock * 0.85, shock * 0.85) : vec4(side * shock * 0.6, shock * 0.6);
    }
  }
  if (traded) {
    // Trades reached the row: one neutral ripple running out from the book's inner edge, whatever the row's change was.
    float ring = exp(-pow((d - age * 0.11 * dpr) / (3.0 * dpr), 2.0)) * exp(-age / 420.0) * strength;
    light += dark ? vec4(vec3(0.85) * ring * 0.5, ring * 0.5) : vec4(0.0);
    if (!dark) shade += ring * 0.3;
  }
  // A light page has no light to add: a cue's colour is laid over the glass instead, so a deposit reads as deeper colour, not a paler one.
  if (!dark) shade = min(1.0, shade + light.a);
  return light;
}
// A cue laid on the glass: on a dark page its light added; on a light one its colour and shade laid over, the opacity with them, so the
// page behind is covered too (premultiplied).
vec4 lay(vec4 c, vec4 lt, float sh) { return vec4(c.rgb * (1.0 - sh) + lt.rgb, dark ? max(c.a, max(lt.a, sh * 0.5)) : min(1.0, c.a * (1.0 - sh) + sh)); }
vec4 sharp(vec2 p) { return texture(scene, p / px); }
// The blur spread a dot's light thin; the gain gives it back, rolled off softly (a hard clamp left flat, blocky plateaus where trades crowd).
vec4 soft(vec2 p) { return vec4(1.0) - exp(-texture(small, p / px) * gain); }
// The three colours read a little apart where the glass bends the light: a lens's dispersion, strongest at the edges.
vec4 split3(vec2 p, vec2 off, bool blurred) {
  // Where the glass bends nothing (its flat middle with no wave passing) the three are one.
  if (off == vec2(0.0)) return blurred ? soft(p) : sharp(p);
  vec4 a = blurred ? soft(p + off) : sharp(p + off), b = blurred ? soft(p + off * 1.16) : sharp(p + off * 1.16), c = blurred ? soft(p + off * 1.32) : sharp(p + off * 1.32);
  return vec4(a.r, b.g, c.b, max(a.a, max(b.a, c.a)));
}
void main() {
  vec2 f = gl_FragCoord.xy;
  vec4 base = texelFetch(scene, ivec2(f), 0);
  // The waves (glass/waves.ts) read at this point in CSS px, top-down.
  vec2 fc = vec2(f.x, px.y - f.y) / dpr, wfront = waveFront(fc);
  if (count == 0 || f.y < ext.x || f.y > ext.y) { color = crest(base, wfront, 0.18); return; }
  int at = -1;
  for (int i = 0; i < 3; i++) if (i < count && f.x >= piece[i].x && f.x <= piece[i].y) at = i;
  if (at < 0) {
    // A weld between two pieces: a bead of fused glass. What is behind it is bent across it (a cylinder lens: read from the far side),
    // by an amount that ripples irregularly along its length, under a bright streak and a dark one.
    for (int i = 0; i < 2; i++) {
      if (i + 1 >= count || f.x <= piece[i].y || f.x >= piece[i + 1].x) continue;
      float w = piece[i + 1].x - piece[i].y, t = (f.x - piece[i].y) / w, y = f.y / dpr;
      float ripple = 0.6 * sin(y * 0.9 + 1.7 * sin(y * 0.13)) + 0.4 * sin(y * 2.3 + float(i) * 1.9);
      vec4 c = sharp(vec2(f.x + cos(3.14159 * t) * w * (1.1 + 0.45 * ripple), f.y));
      float seamA = dark ? 0.22 : 0.16;
      vec3 seam = dark ? vec3(0.55, 0.8, 0.74) : vec3(0.42, 0.55, 0.52);
      c = c * (1.0 - seamA) + vec4(seam * seamA, seamA);
      float hi = exp(-pow((t - 0.3 - 0.06 * ripple) * 6.5, 2.0)) * (0.5 + 0.3 * ripple) * (dark ? 0.7 : 0.9);
      float lo = exp(-pow((t - 0.78) * 5.5, 2.0)) * (dark ? 0.55 : 0.28);
      c.rgb = c.rgb * (1.0 - lo) + vec3(hi); c.a = max(c.a, max(hi, lo * 0.6));
      color = c; return;
    }
    color = crest(base, wfront, 0.18); return;
  }
  vec4 pc = piece[at];
  bool candle = pc.z > 0.5;
  float x0 = pc.x, x1 = pc.y, yb = ext.x, yt = ext.y, bevel = pc.w;
  vec3 tint = tintC; float ta = candle ? tintA.y : tintA.x;
  bool bid = at == 0;
  vec4 g0 = vec4(0.0), g1 = vec4(0.0); int row = int(px.y - 1.0 - floor(f.y));
  if (!candle && hasRows) { g0 = texelFetch(rows, ivec2(0, row), 0); g1 = texelFetch(rows, ivec2(1, row), 0); }
  float wBar = bid ? g0.r : g0.g, inner = bid ? x1 : x0, d = bid ? inner - f.x : f.x - inner;
  float sh = 0.0, k = 1.0; vec4 lt = vec4(0.0);
  if (!candle && hasRows) lt = pulseLight(bid, d, wBar, g1, row, sh, k);
  bool inBar = !candle && hasRows && wBar > 0.0 && d <= wBar;
  if (!candle && bricks) {
    // A brick: glass only inside the row's bar, from the book's inner edge (next to the candle) out to the bar's length. A pulse's outline
    // where a pulled bar's edge was lies outside it, in the open.
    if (!inBar) { color = crest(lay(base, lt, sh), wfront, 0.18); return; }
    if (bid) x0 = inner - wBar; else x1 = inner + wBar;
    yt = f.y + g0.b; yb = f.y - g0.a;
    bevel = min(bevel, 0.42 * min(wBar, g0.b + g0.a));
    tint = bid ? bookBid : bookAsk; ta = min(0.6, (dark ? 0.2 : 0.24) * k);
  }
  float dl = f.x - x0, dr = x1 - f.x, dt = yt - f.y, db = f.y - yb;
  float e = min(min(dl, dr), min(dt, db));
  vec2 n = dl <= min(dr, min(dt, db)) ? vec2(-1.0, 0.0) : dr <= min(dt, db) ? vec2(1.0, 0.0) : dt <= db ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
  // The rounded edge: 1 at the rim, 0 once the surface is flat. Light is bent toward the slab's inside there, more for a thicker piece.
  float s = 1.0 - smoothstep(0.0, bevel, e);
  vec2 off = -n * s * s * bevel * (candle ? 1.7 : 1.1);
  // A wave passing through the glass bends what is behind it, as a ripple on water does (its slope, in device px, y up).
  vec2 sl = waveSlope(fc); off += vec2(sl.x, -sl.y) * 6.0 * dpr;
  vec4 c = split3(f, off, candle);
  if (candle && ((f.y >= frost.x && f.y <= frost.y) || (f.y >= frost.z && f.y <= frost.w))) {
    // Sandblasted where nothing was recorded: the light scattered into a milky haze, what is behind it barely there.
    c = c * 0.45 + vec4(vec3(dark ? 0.75 : 1.0) * (dark ? 0.14 : 0.3), dark ? 0.14 : 0.3);
  }
  c = c * (1.0 - ta) + vec4(tint * ta, ta);
  // Light from the top left: the rims facing it lit, the others shaded, and a polished line along the very edge.
  float facing = dot(n, normalize(vec2(-1.0, 1.0)));
  float hi = s * s * max(facing, 0.0) * (dark ? 0.3 : 0.55) + (1.0 - smoothstep(0.0, 1.4 * dpr, e)) * (dark ? 0.2 : 0.3);
  float lo = s * s * max(-facing, 0.0) * (dark ? 0.5 : 0.2);
  c.rgb = c.rgb * (1.0 - lo) + vec3(hi); c.a = max(c.a, max(hi, lo * 0.6));
  // The bar's fill, over the glass as the page's canvas would have laid it, brighter or dimmer while its row pulses.
  if (inBar) { float fa = min(0.6, fillA * k); vec3 sc = bid ? bookBid : bookAsk; c = c * (1.0 - fa) + vec4(sc * fa, fa); }
  // The front lights the glass, most where it meets a rim (the light runs to a slab's edges).
  color = crest(lay(c, lt, sh), wfront * (1.0 + 1.5 * (1.0 - smoothstep(0.0, 2.0 * bevel, e))), 0.3);
}`;

const TRAIL_VERT = `#version 300 es
layout(location = 0) in vec3 rec0; layout(location = 1) in vec3 rec1;
uniform float now, win; uniform vec2 xr, yr, pr, px; uniform vec4 size; uniform int style; uniform sampler2D mask;
out vec3 centre; out float usd, fade, fresh, reach; out vec2 span;
void main() {
  float age = now - rec0.x;
  bool hidden = texelFetch(mask, ivec2(int(rec1.x), 0), 0).r > 0.5;
  float x = xr.y - clamp(age / win, 0.0, 1.0) * (xr.y - xr.x);
  float y = yr.x + (pr.y - rec0.y) / (pr.y - pr.x) * (yr.y - yr.x);
  float ylo = yr.x + (pr.y - rec1.y) / (pr.y - pr.x) * (yr.y - yr.x), yhi = yr.x + (pr.y - rec1.z) / (pr.y - pr.x) * (yr.y - yr.x);
  float a = abs(rec0.z);
  float r = mix(size.x, size.y, clamp(log(max(a, 1.0) / size.z) / log(size.w / size.z), 0.0, 1.0));
  // A comet's tail: the last seconds bright, the rest of the window a quiet record that thins out to the left.
  float rel = clamp(age / win, 0.0, 1.0);
  fresh = exp(-max(age, 0.0) / 900.0);
  fade = mix(pow(1.0 - rel, 2.2) * 0.62, 1.0, fresh * 0.75);
  // A walk across the book is a hairline as far as a sprite reaches (24 device px either side): a sprite as tall as a long walk is mostly
  // discarded pixels, and every frame draws all of them.
  float walk = min(max(abs(ylo - y), abs(yhi - y)), 24.0);
  reach = max(style == 0 ? r * 3.2 : r + 1.5, walk + 1.0);
  centre = vec3(x, y, r); usd = rec0.z; span = vec2(min(ylo, yhi), max(ylo, yhi));
  bool off = hidden || age < -1500.0 || age > win || y < -reach || y > px.y + reach;
  gl_PointSize = 2.0 * reach;
  gl_Position = off ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(x / px.x * 2.0 - 1.0, 1.0 - y / px.y * 2.0, 0.0, 1.0);
}`;

/** The shading both programs share: a disc, a ring and a lit sphere, at distance `d` from the centre of a sprite of radius `r`. */
const SHAPES = `
float disc(float d, float r) { return clamp(r + 0.5 - d, 0.0, 1.0); }
float ring(float d, float r, float w) { return clamp(1.0 - abs(d - r + w * 0.5) / (w * 0.5 + 0.5), 0.0, 1.0); }
// A lit bead: a sphere for a buy, a torus seen from above for a sell. Returns light (rgb factor) and coverage.
vec2 bead(vec2 q, float r, bool hollow, out float spec) {
  vec2 n = q / max(r, 0.6); float l = length(n); spec = 0.0;
  vec3 N; float cover;
  if (hollow) {
    float t = (l - 0.64) / 0.36; cover = clamp((1.0 - abs(t)) * r * 0.36 + 0.5, 0.0, 1.0);
    if (cover <= 0.0) return vec2(0.0);
    vec2 dir = l > 0.0 ? n / l : vec2(0.0); N = normalize(vec3(dir * t, sqrt(max(0.0, 1.0 - t * t))));
  } else {
    cover = clamp((1.0 - l) * r + 0.5, 0.0, 1.0);
    if (cover <= 0.0) return vec2(0.0);
    N = normalize(vec3(n, sqrt(max(0.0, 1.0 - l * l))));
  }
  vec3 L = normalize(vec3(-0.45, -0.62, 0.65));
  float diffuse = 0.38 + 0.62 * max(dot(N, L), 0.0);
  spec = pow(max(dot(reflect(-L, N), vec3(0.0, 0.0, 1.0)), 0.0), 22.0);
  return vec2(diffuse, cover);
}`;

const TRAIL_FRAG = `#version 300 es
precision highp float; precision highp int;
in vec3 centre; in float usd, fade, fresh, reach; in vec2 span; out vec4 color;
uniform int style; uniform bool dark; uniform vec3 bidC, askC; uniform float opacity;
${SHAPES}
void main() {
  vec2 pix = centre.xy + (gl_PointCoord - 0.5) * 2.0 * reach;
  vec2 q = pix - centre.xy; float d = length(q), r = centre.z;
  bool sell = usd < 0.0; vec3 c = sell ? askC : bidC;
  float stalk = (span.y - span.x > 1.5 && abs(q.x) < 0.6 && pix.y >= span.x && pix.y <= span.y) ? 0.45 : 0.0;
  float a; vec3 rgb;
  if (style == 0) {
    float core = disc(d, r);
    if (sell) core *= clamp(d - r * 0.45 + 0.5, 0.0, 1.0);
    // On a light page there is no light to add: a crisp core with a darker rim, and only a breath of halo.
    float halo = dark ? exp(-(d * d) / (r * r * 2.8)) * 0.42 : exp(-(d * d) / (r * r * 1.6)) * 0.05;
    float rim = dark ? 0.0 : ring(d, r + 0.4, 1.0) * 0.55;
    a = max(max(core * 0.95, rim) + halo, stalk) * fade * opacity;
    rgb = dark ? mix(c, vec3(1.0), 0.5 * fresh * core) : mix(c, vec3(0.0), 0.12 * core + 0.35 * rim);
  } else if (style == 1) {
    float shape = sell ? ring(d, r + 0.4, 1.1) : disc(d, r);
    a = max(shape, stalk) * fade * opacity;
    rgb = c;
  } else {
    float spec; vec2 lit = bead(q, r + 0.3, sell, spec);
    a = max(lit.y, stalk) * fade * opacity;
    rgb = lit.y > 0.0 ? c * lit.x + vec3(spec * (0.45 + 0.55 * fresh)) : c;
  }
  if (a <= 0.003) discard;
  color = vec4(rgb * a, a);
}`;

const FLASH_VERT = `#version 300 es
layout(location = 0) in vec3 f0; layout(location = 1) in vec2 f1;
uniform vec2 px; uniform int style;
out vec3 centre; out float share, k, reach;
void main() {
  float r = f0.z; k = f1.y; share = f1.x;
  reach = style == 0 ? r * 5.0 : r + 3.0;
  centre = f0;
  gl_PointSize = 2.0 * reach;
  gl_Position = vec4(f0.x / px.x * 2.0 - 1.0, 1.0 - f0.y / px.y * 2.0, 0.0, 1.0);
}`;

const FLASH_FRAG = `#version 300 es
precision highp float; precision highp int;
in vec3 centre; in float share, k, reach; out vec4 color;
uniform int style; uniform bool dark; uniform vec3 bidC, askC, mid;
${SHAPES}
void main() {
  vec2 pix = centre.xy + (gl_PointCoord - 0.5) * 2.0 * reach;
  vec2 q = pix - centre.xy; float d = length(q), r = centre.z;
  float lean = abs(2.0 * share - 1.0); bool sell = share < 0.5;
  vec3 c = mix(mid, sell ? askC : bidC, 0.35 + 0.65 * lean);
  float a; vec3 rgb;
  if (style == 0) {
    // A flashbulb: a white-hot core cooling to the side's colour, a bloom, a faint lens ring and a four-point star, all fading together.
    float core = disc(d, r); if (sell) core *= clamp(d - r * 0.4 + 0.5, 0.0, 1.0);
    float bloom = exp(-(d * d) / (r * r * 5.0));
    float lens = exp(-pow((d - r * 2.7) / 1.1, 2.0)) * 0.22;
    float star = (exp(-abs(q.x) / 0.9) * exp(-abs(q.y) / (r * 1.9)) + exp(-abs(q.y) / 0.9) * exp(-abs(q.x) / (r * 1.9))) * 0.5;
    float light = core + (bloom * 0.7 + lens + star) * (dark ? 1.0 : 0.45);
    a = clamp(light * k, 0.0, 1.0);
    rgb = dark ? mix(c, vec3(1.0), clamp(0.85 * k * core + 0.25 * bloom * k, 0.0, 1.0)) : mix(c, vec3(0.0), 0.15 * core);
  } else if (style == 1) {
    // An engraved mark: a crisp ring, the dominant side's dot inside it for a buy, both fading; no glow.
    float shape = max(ring(d, r + 1.2, 1.3), sell ? 0.0 : disc(d, r * 0.62));
    a = shape * k;
    rgb = c;
  } else {
    // A bead catching the light: its highlight and a rim light fade back to the trail's bead.
    float spec; vec2 lit = bead(q, r, sell, spec);
    float rim = ring(d, r + 1.6, 1.0) * 0.6;
    a = max(lit.y, rim) * k;
    rgb = lit.y > 0.0 ? c * lit.x + vec3(spec * (0.6 + 0.4 * k)) : mix(c, vec3(1.0), dark ? 0.4 : 0.0);
  }
  if (a <= 0.003) discard;
  color = vec4(rgb * a, a);
}`;

export class TrailGL {
  readonly gl: WebGL2RenderingContext;
  #trail: WebGLProgram; #flash: WebGLProgram;
  #trailVao: WebGLVertexArrayObject; #trailBuf: WebGLBuffer;
  #flashVao: WebGLVertexArrayObject; #flashBuf: WebGLBuffer;
  #mask: WebGLTexture; #maskKey = '';
  #down: WebGLProgram; #blur: WebGLProgram; #comp: WebGLProgram;
  /** The book's bars per device row, for the bricks (`setRows`), and the height they were made for. */
  #rows: WebGLTexture; #rowsH = 0;
  /** The pieces' uniforms, reused frame to frame. */
  #pieceBuf = new Float32Array(12);
  /**
   * The trail drawn off screen, its small copy and the blur's other half, for the glass, and whether they have been given the canvas's size
   * (a renderer made again on a canvas already sized, after a lost context came back, still has to).
   */
  #scene: WebGLTexture; #sceneFbo: WebGLFramebuffer; #small: WebGLTexture; #smallFbo: WebGLFramebuffer; #tmp: WebGLTexture; #tmpFbo: WebGLFramebuffer;
  #smallSize: [number, number] = [1, 1]; #sized = false;
  /** The ring's orders on the card: up to which write number, for which of the ring's epochs. */
  #uploaded = 0; #uploadedEpoch = -1;
  #loc = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  /** The programs the card is still building (gl-build.ts) and the uniforms to read from each once built; null once they are. */
  #building: (readonly [Building, readonly string[]])[] | null;
  readonly #flashData = new Float32Array(MAX_FLASH * FLASH_STRIDE);
  #dpr = 1;

  /** The waves in this canvas (glass/waves.ts; null where the card cannot run them), and the pieces its medium was last drawn from. */
  #field: WaveField | null = null; #mediumKey = '';

  constructor(readonly canvas: HTMLCanvasElement, readonly ring: TapeRing) {
    // No depth buffer: nothing here tests depth, and a phone's card would keep one the canvas's size for nothing.
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, depth: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    // Built beside the page (gl-build.ts): asked how they went at once, the five held a phone's page for ~0.6 s, the glass's composite alone
    // ~0.4 s (Research_Findings.md, 2026-11-07). Nothing is drawn until `built` finds them done.
    const building: (readonly [Building, readonly string[]])[] = [
      [startProgram(gl, TRAIL_VERT, TRAIL_FRAG), ['now', 'win', 'xr', 'yr', 'pr', 'px', 'size', 'style', 'mask', 'dark', 'bidC', 'askC', 'opacity']],
      [startProgram(gl, FLASH_VERT, FLASH_FRAG), ['px', 'style', 'dark', 'bidC', 'askC', 'mid']],
      [startProgram(gl, FULL_VERT, DOWN_FRAG), ['src', 'small', 'texel']],
      [startProgram(gl, FULL_VERT, BLUR_FRAG), ['src', 'size', 'dir']],
      [startProgram(gl, FULL_VERT, COMP_FRAG), ['scene', 'small', 'rows', 'px', 'ext', 'gain', 'dpr', 'piece', 'frost', 'count', 'bricks', 'dark', 'tintC', 'bidC', 'askC', 'tintA', 'pulse', 'nowMs', 'hasRows', 'bookBid', 'bookAsk', 'fillA', 'waves', 'wavesPrev', 'waveCells', 'waveCssH', 'waveGain', 'hasWaves']],
    ];
    this.#building = building;
    [this.#trail, this.#flash, this.#down, this.#blur, this.#comp] = building.map(([b]) => b.program) as [WebGLProgram, WebGLProgram, WebGLProgram, WebGLProgram, WebGLProgram];
    this.#field = WaveField.create(gl);
    const texture = (): WebGLTexture => {
      const tex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return tex;
    };
    this.#scene = texture(); this.#small = texture(); this.#tmp = texture();
    const fbo = (tex: WebGLTexture): WebGLFramebuffer => { const f = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return f; };
    this.#sceneFbo = fbo(this.#scene); this.#smallFbo = fbo(this.#small); this.#tmpFbo = fbo(this.#tmp);
    this.#rows = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.#rows);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, ROW_TEXELS, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4 * ROW_TEXELS));
    this.#trailBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#trailBuf); gl.bufferData(gl.ARRAY_BUFFER, MIRROR * STRIDE * 4, gl.DYNAMIC_DRAW);
    this.#trailVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.#trailVao);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE * 4, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE * 4, 12);
    this.#flashBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#flashBuf); gl.bufferData(gl.ARRAY_BUFFER, this.#flashData.byteLength, gl.DYNAMIC_DRAW);
    this.#flashVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.#flashVao);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, FLASH_STRIDE * 4, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, FLASH_STRIDE * 4, 12);
    gl.bindVertexArray(null);
    this.#mask = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.#mask);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.setMask([]);
  }

  /**
   * Whether the programs are built and their uniforms read: false while the card still builds them (asked without waiting, gl-build.ts).
   * Throws what failed. Nothing is drawn before it is true (the pane keeps its solid look meanwhile).
   */
  built(): boolean {
    const building = this.#building; if (!building) return true;
    if (!built(this.gl, building.map(([b]) => b))) return false;
    for (const [b, names] of building) this.#loc.set(b.program, uniforms(this.gl, b.program, names));
    this.#building = null;
    return true;
  }

  /** Size the canvas: CSS px times the pixel ratio (the pane caps it, a glow gains nothing from a phone's third device pixel). */
  resize(width: number, height: number, dpr: number): void {
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
    this.#dpr = dpr;
    if (this.#field && (this.#field.cols !== Math.max(4, Math.ceil(width / 4)) || this.#field.rows !== Math.max(4, Math.ceil(height / 4)))) { this.#field.resize(width, height); this.#mediumKey = ''; }
    if (this.canvas.width === w && this.canvas.height === h && this.#sized) return;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
    const gl = this.gl, sw = Math.max(1, Math.ceil(w / GLASS_DOWN)), sh = Math.max(1, Math.ceil(h / GLASS_DOWN));
    gl.bindTexture(gl.TEXTURE_2D, this.#scene); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const tex of [this.#small, this.#tmp]) { gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); }
    this.#smallSize = [sw, sh]; this.#sized = true;
  }

  /** The device px a frame is drawn at (the pane builds the bricks' rows at it). */
  get dpr(): number { return this.#dpr; }

  /** A wave from where an order arrived (CSS px), as large as `usd` against `min`, a buy's or a sell's; nothing without the field. */
  wave(x: number, y: number, usd: number, min: number, side: 0 | 1): void { this.#field?.order(x, y, usd, min, side, performance.now()); }
  /** Whether a wave still runs (the pane keeps drawing while one does). */
  get waving(): boolean { return this.#field?.alive(performance.now()) ?? false; }

  /**
   * The book's rows per device row from the top, ROW_TEXELS texels of four floats each: the bid bar's width and the ask bar's (device px, 0
   * for none), how far the row's top is and how far its bottom; each side's pulse (sign times strength, 2 more when traded) and its start on
   * the frame's clock; each side's bar width before its change. Sent when the book is drawn, not every frame: a pulse moves by the clock.
   */
  setRows(rows: Float32Array, height: number): void {
    const gl = this.gl, h = Math.max(1, height);
    gl.bindTexture(gl.TEXTURE_2D, this.#rows); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, ROW_TEXELS, h, 0, gl.RGBA, gl.FLOAT, rows.subarray(0, h * 4 * ROW_TEXELS));
    this.#rowsH = height;
  }

  /** The ring's markets not drawn (outside the view's markets), by the ring's index. */
  setMask(hidden: readonly number[]): void {
    const key = hidden.join(',') || '-'; if (key === this.#maskKey) return;
    this.#maskKey = key;
    const gl = this.gl, row = new Uint8Array(1024); for (const k of hidden) if (k >= 0 && k < 1024) row[k] = 255;
    gl.bindTexture(gl.TEXTURE_2D, this.#mask); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1024, 1, 0, gl.RED, gl.UNSIGNED_BYTE, row);
  }

  /**
   * Copy to the card what the ring wrote since the last frame, at the ring's write number modulo MIRROR (only the newest MIRROR orders are
   * held there); everything held again after a rebase or a clear, whose offsets are new.
   */
  #upload(): void {
    const gl = this.gl, ring = this.ring, oldest = Math.max(ring.first, ring.written - MIRROR);
    if (this.#uploadedEpoch !== ring.epoch) { this.#uploadedEpoch = ring.epoch; this.#uploaded = oldest; }
    let from = Math.max(this.#uploaded, oldest);
    if (from >= ring.written) { this.#uploaded = ring.written; return; }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#trailBuf);
    while (from < ring.written) {
      const slot = from % ring.capacity, at = from % MIRROR, n = Math.min(ring.written - from, ring.capacity - slot, MIRROR - at);
      gl.bufferSubData(gl.ARRAY_BUFFER, at * STRIDE * 4, ring.data, slot * STRIDE, n * STRIDE);
      from += n;
    }
    this.#uploaded = ring.written;
  }

  /** Draw the orders timed in [from, to] (absolute ms) that the card holds: the ring's runs there, each in at most two pieces of the copy. */
  #drawHeld(from: number, to: number): void {
    const gl = this.gl, ring = this.ring, oldest = Math.max(ring.first, ring.written - MIRROR);
    for (const [a, b] of ring.runs(from, to)) {
      let k = Math.max(a, oldest);
      while (k < b) { const at = k % MIRROR, n = Math.min(b - k, MIRROR - at); gl.drawArrays(gl.POINTS, at, n); k += n; }
    }
  }

  /** Draw a frame; nothing until the programs are built (`built`, which the pane asks first). */
  draw(f: TrailFrame): void {
    if (!this.built()) return;
    const gl = this.gl, ring = this.ring, dpr = this.#dpr, W = this.canvas.width, H = this.canvas.height;
    // The waves first, in their own buffers: the glass's pieces are glass to them, the welds walls; then the frame as before. Waves whose
    // programs did not build are let go (the glass keeps its other light).
    if (this.#field?.failed) this.#field = null;
    const field = this.#field;
    if (field && f.glass) {
      const g = f.glass, key = `${g.y0},${g.y1},${g.pieces.map(q => `${q.x0},${q.x1}`).join(';')}`;
      if (key !== this.#mediumKey) {
        const regions: WaveRegion[] = g.pieces.map(q => ({ x: q.x0, y: g.y0, w: q.x1 - q.x0, h: g.y1 - g.y0, kind: 'glass' }));
        for (let i = 0; i + 1 < g.pieces.length; i++) regions.push({ x: g.pieces[i]!.x1, y: g.y0, w: Math.max(2, g.pieces[i + 1]!.x0 - g.pieces[i]!.x1), h: g.y1 - g.y0, kind: 'wall' });
        field.setMedium(regions); this.#mediumKey = key;
      }
      field.step(performance.now());
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    // With glass the composite writes every pixel of the screen and clears it just before (`#composite`): cleared here as well, a tiled card
    // (a phone's) would write the cleared screen out and read it back in for the composite.
    const drawn = f.p1 > f.p0 && f.windowMs > 0;
    if (!drawn || !f.glass) gl.clear(gl.COLOR_BUFFER_BIT);
    if (!drawn) return;
    // With glass the trail is drawn off screen, then copied out with the glass's part frosted (`#composite`).
    if (f.glass) { gl.bindFramebuffer(gl.FRAMEBUFFER, this.#sceneFbo); gl.clear(gl.COLOR_BUFFER_BIT); }
    const style = STYLE_ID[f.style], additive = f.dark && f.style === 'phosphor';
    gl.enable(gl.BLEND);
    // Premultiplied colour throughout: light added up where orders crowd (Phosphor on a dark page), otherwise drawn over.
    if (additive) gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (ring.written > 0) {
      this.#upload();
      const l = this.#loc.get(this.#trail)!;
      gl.useProgram(this.#trail);
      // Relative to the ring's bases, in float64 here, so the card never sees an epoch millisecond or a full price.
      gl.uniform1f(l.get('now')!, f.now - ring.t0); gl.uniform1f(l.get('win')!, f.windowMs);
      gl.uniform2f(l.get('xr')!, f.x0 * dpr, f.x1 * dpr); gl.uniform2f(l.get('yr')!, f.y0 * dpr, f.y1 * dpr);
      gl.uniform2f(l.get('pr')!, f.p0 - ring.p0, f.p1 - ring.p0); gl.uniform2f(l.get('px')!, W, H);
      gl.uniform4f(l.get('size')!, 0.9 * dpr, 4 * dpr, f.floorUsd, f.ceilUsd);
      gl.uniform1i(l.get('style')!, style); gl.uniform1i(l.get('dark')!, f.dark ? 1 : 0);
      gl.uniform3fv(l.get('bidC')!, f.bid); gl.uniform3fv(l.get('askC')!, f.ask); gl.uniform1f(l.get('opacity')!, f.opacity);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#mask); gl.uniform1i(l.get('mask')!, 0);
      gl.bindVertexArray(this.#trailVao); this.#drawHeld(f.now - f.windowMs - 1_000, f.now + 2_000); gl.bindVertexArray(null);
    }
    const flashes = f.flashes.slice(0, MAX_FLASH);
    if (flashes.length) {
      flashes.forEach((s, i) => { const at = i * FLASH_STRIDE; this.#flashData[at] = s.x * dpr; this.#flashData[at + 1] = s.y * dpr; this.#flashData[at + 2] = s.r * dpr; this.#flashData[at + 3] = s.share; this.#flashData[at + 4] = s.k; });
      const l = this.#loc.get(this.#flash)!;
      gl.useProgram(this.#flash);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#flashBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#flashData, 0, flashes.length * FLASH_STRIDE);
      gl.uniform2f(l.get('px')!, W, H); gl.uniform1i(l.get('style')!, style); gl.uniform1i(l.get('dark')!, f.dark ? 1 : 0);
      gl.uniform3fv(l.get('bidC')!, f.bid); gl.uniform3fv(l.get('askC')!, f.ask); gl.uniform3fv(l.get('mid')!, f.mid);
      gl.bindVertexArray(this.#flashVao); gl.drawArrays(gl.POINTS, 0, flashes.length); gl.bindVertexArray(null);
    }
    if (f.glass) this.#composite(f.glass, f);
  }

  /** Copy the off-screen trail to the screen through the pieces of glass (CSS px, top-down), the candle's from the blurred small copy. */
  #composite(glass: GlassFrame, f: TrailFrame): void {
    const dark = f.dark;
    const gl = this.gl, dpr = this.#dpr, W = this.canvas.width, H = this.canvas.height, [sw, sh] = this.#smallSize;
    // Each pass below writes every pixel of its target: a tiled card need not read the old ones back in first.
    const fresh = [gl.COLOR_ATTACHMENT0];
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#smallFbo); gl.viewport(0, 0, sw, sh); gl.invalidateFramebuffer(gl.FRAMEBUFFER, fresh);
    const d = this.#loc.get(this.#down)!;
    gl.useProgram(this.#down);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#scene); gl.uniform1i(d.get('src')!, 0);
    gl.uniform2f(d.get('small')!, sw, sh); gl.uniform2f(d.get('texel')!, 1 / W, 1 / H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // The Gaussian: across into the other half, then down back into the small copy.
    const b = this.#loc.get(this.#blur)!;
    gl.useProgram(this.#blur); gl.uniform2f(b.get('size')!, sw, sh); gl.uniform1i(b.get('src')!, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#tmpFbo); gl.invalidateFramebuffer(gl.FRAMEBUFFER, fresh); gl.bindTexture(gl.TEXTURE_2D, this.#small); gl.uniform2f(b.get('dir')!, GLASS_SPREAD, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#smallFbo); gl.invalidateFramebuffer(gl.FRAMEBUFFER, fresh); gl.bindTexture(gl.TEXTURE_2D, this.#tmp); gl.uniform2f(b.get('dir')!, 0, GLASS_SPREAD);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const c = this.#loc.get(this.#comp)!;
    gl.useProgram(this.#comp);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#scene); gl.uniform1i(c.get('scene')!, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.#small); gl.uniform1i(c.get('small')!, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.#rows); gl.uniform1i(c.get('rows')!, 2);
    // The card's rows run bottom-up: a stretch's top is the larger y there.
    const pieces = this.#pieceBuf; pieces.fill(0);
    glass.pieces.slice(0, 3).forEach((q, i) => { pieces.set([q.x0 * dpr, q.x1 * dpr, q.candle ? 1 : 0, (q.candle ? 7 : 4.5) * dpr], i * 4); });
    const fr = [glass.frost[0], glass.frost[1]].map(r => r ? [H - r.y1 * dpr, H - r.y0 * dpr] : [1, 0]).flat();
    gl.uniform4fv(c.get('piece')!, pieces); gl.uniform1i(c.get('count')!, Math.min(3, glass.pieces.length));
    gl.uniform2f(c.get('ext')!, H - glass.y1 * dpr, H - glass.y0 * dpr); gl.uniform4f(c.get('frost')!, fr[0]!, fr[1]!, fr[2]!, fr[3]!);
    gl.uniform1i(c.get('bricks')!, glass.bricks && this.#rowsH === H ? 1 : 0); gl.uniform1i(c.get('dark')!, dark ? 1 : 0);
    gl.uniform1i(c.get('hasRows')!, this.#rowsH === H ? 1 : 0); gl.uniform1i(c.get('pulse')!, glass.pulse === 'pressure' ? 1 : glass.pulse === 'deposit' ? 2 : 0);
    gl.uniform1f(c.get('nowMs')!, glass.nowMs); gl.uniform1f(c.get('fillA')!, glass.fill);
    gl.uniform3fv(c.get('bookBid')!, glass.bookBid); gl.uniform3fv(c.get('bookAsk')!, glass.bookAsk);
    gl.uniform2f(c.get('px')!, W, H); gl.uniform1f(c.get('gain')!, dark ? 3.4 : 2.6); gl.uniform1f(c.get('dpr')!, dpr);
    // Tinted glass: smoky on a dark page, milky on a light one; the candle's thicker piece more so.
    gl.uniform3fv(c.get('tintC')!, dark ? [0.05, 0.06, 0.08] : [1, 1, 1]); gl.uniform2f(c.get('tintA')!, dark ? 0.16 : 0.22, dark ? 0.46 : 0.58);
    gl.uniform3fv(c.get('bidC')!, f.bid); gl.uniform3fv(c.get('askC')!, f.ask);
    const field = this.#field, waving = field?.alive(performance.now()) ?? false;
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, field ? field.texture : null); gl.uniform1i(c.get('waves')!, 3);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, field ? field.previous : null); gl.uniform1i(c.get('wavesPrev')!, 4);
    gl.uniform1i(c.get('hasWaves')!, waving ? 1 : 0); gl.uniform2f(c.get('waveCells')!, field?.cols ?? 1, field?.rows ?? 1); gl.uniform1f(c.get('waveCssH')!, H / dpr);
    gl.uniform1f(c.get('waveGain')!, glass.waveGain ?? strengthGain(WAVE_STRENGTH_DEFAULT));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  clear(): void { const gl = this.gl; gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
}
