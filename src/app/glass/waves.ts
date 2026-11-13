import { built, startProgram, uniforms, type Building } from '../gl-build.ts';

/**
 * A field of waves on the card (Karl, 2026-10-17): every large order drops a pulse where it shows, and it runs out across the screen as a
 * real wave, bending where it enters glass (slower there), partly thrown back and partly let through by the splitters and the edges of the
 * panes, and soaked up by the screen's own edges so nothing rings for ever. Buys and sells are two fields in one texture (red and green
 * channels), so their crests keep their colours and pass through each other; the person's own hand on the glass (a pointer moving over it,
 * a key pressed, a splitter dragged: Karl, 2026-11-03, "push more interactions with ... the waves") is a third, in the blue channel, drawn
 * in neither side's colour.
 *
 * The field is the 2D wave equation on a grid a quarter of the screen across (`CELL` CSS px a cell), stepped with leapfrog in substeps of
 * one fixed length (`SUBSTEP_MS`, as many a frame as its time holds), in half-float textures. A pulse's height grows with the square
 * root of the order's size and its width with the size's logarithm, so a larger order makes a taller wave and a longer one, as a larger
 * stone does. It runs only while a pulse is still in it (a few seconds after the last), and needs a card that can draw into half floats;
 * `WaveField.create` says null where it cannot, and the glass keeps its older light then.
 *
 * One class, one instance per WebGL context: the page's glass (glass/ui-glass.ts) and the Tape view's (candle/trail-gl.ts) each have their
 * own; a texture cannot be shared across contexts.
 *
 * A busy market must not flood the screen (Karl, 2026-11-06: on very active days "it throws too many waves ... the entire screen floods").
 * Orders do not start waves one by one: `order` gathers them, side by side, into a few waiting waves, each the orders that came near one
 * place (`MERGE_PX`) added together as one larger order, so the physics above still holds (a wave's height with the root of its size, to
 * the cap). The field starts `SPAWN_RATE` of them a second at most (after a burst of `SPAWN_BURST`), the largest first, each within
 * `MAX_WAIT_MS` of its first order or not at all, so a cascade of hundreds of orders a second is a few large waves rather than hundreds of
 * small ones. Each wave it starts is also scaled by how full the field already is: it keeps an estimate of its own energy (what each wave
 * put in, fading as the damping and the edges take it, `ENERGY_TAU_MS`, on the field's own time), and past a knee a new wave is let in
 * smaller and smaller, down to nothing at a ceiling: the energy now against `ENERGY_KNEE` and `ENERGY_MAX` (a burst), the energy averaged
 * over `SLOW_MS` against `SLOW_KNEE` and `SLOW_MAX` (a cascade that lasts). The fuller it is, the sooner its echoes die (`BUSY_DAMP`). A
 * quiet field takes a large order at its full height, and a whale (`WHALE_R`) always shows. How strongly the waves are drawn is the
 * person's (`waveGain`, the Waves panel's Strength), on top of all this. Whatever the market does, the card's work a frame is the same:
 * the grid's size, at most sixteen substeps, at most MAX_SOURCES pulses in one.
 */

/** CSS px a cell of the field. */
export const CELL = 4;
/** The wave's speed over open screen (CSS px a second); glass is slower by its index. */
export const WAVE_SPEED = 900;
/** The index of the chrome's glass: a wave is this many times slower inside it, and bends where it crosses into it. */
export const GLASS_INDEX = 1.5;
/** A wall's speed against the open screen's (a splitter, a pane's edge): low enough to throw back part of a wave, so it echoes faintly, not as a grid. */
export const WALL_SPEED = 0.55;
/** How long the field runs after its last pulse (ms): by then the edges and the damping have taken it. */
export const RING_MS = 3_200;
const MAX_SOURCES = 16;
/** The most touches moving across one frame (a pointer, a splitter dragged): beyond them the oldest are dropped. */
const MAX_PATHS = 4;

/**
 * One pulse into the field: where (CSS px), how tall (about 1 for a large order), how wide (CSS px), and whose (0 buy, 1 sell, 2 a touch: the
 * person's own hand on the glass, a field of its own in the texture's blue channel, drawn in neither side's colour). With `x2`, `y2` it is a
 * segment from (x, y) to there, as wide either side of it (a splitter pushed along).
 */
export interface WaveSource { x: number; y: number; amp: number; width: number; side: 0 | 1 | 2; x2?: number; y2?: number }
/**
 * A touch that moves across the next frame, from (x0, y0) to (x1, y1) (CSS px): the field adds it once a substep at its place then, so a
 * moving hand leaves one smooth wake (a pulse a frame left a string of beads), `amp` each substep, as wide as `width`.
 */
export interface WavePath { x0: number; y0: number; x1: number; y1: number; amp: number; width: number }
/** A region of the field's medium (CSS px): glass slows a wave, a wall mostly throws it back. */
export interface WaveRegion { x: number; y: number; w: number; h: number; kind: 'glass' | 'wall' }

/**
 * The one length of a substep (ms): four to a 120 Hz frame, eight to a 60 Hz one, as a 120 Hz phone already stepped it; a Courant number
 * of 0.47 at the open screen's speed, well inside the 0.71 that leapfrog allows in 2D.
 *
 * Every substep must be as long as the one before (Karl's iPad, 2026-10-19). Leapfrog keeps a wave's speed only as how far it moved in the
 * last substep, so a substep of another length rescales every speed in the field. The length used to be each frame's time over as many
 * substeps as it needed, and Safari's clock reads whole milliseconds: a 60 Hz frame read 16 ms, then 17, 17, 16 (six substeps of 2.67 ms,
 * then seven of 2.43), a 120 Hz one 8, then 9 (three, then four). Rescaled back and forth in a pattern that repeats, the waves were pumped
 * as a swing is, faster than the damping takes them, until the page was white with them. Chrome's clock reads tenths, so every frame
 * there came to the same substeps, and its waves died down.
 */
export const SUBSTEP_MS = 1000 / 480;
/** The step shader's `courant`: the open screen's Courant number squared, the same for every substep. */
const COURANT = (WAVE_SPEED / CELL / 1000 * SUBSTEP_MS) ** 2;
/**
 * The most a frame steps (ms), sixteen substeps: after a stall the field goes on from where it was rather than running the whole stall at
 * once, and a card that falls behind is not given more to do each frame (a frame of 50 ms used to step 24 substeps, so a card that could
 * not keep up was given half as much again, and fell further behind). Below 30 frames a second the waves run a little slower instead.
 */
export const MAX_FRAME_MS = 1000 / 30;

/** A pulse for an order of `usd` against the size that starts one (`min`): height with the square root, width with the logarithm. */
export function pulseFor(usd: number, min: number): { amp: number; width: number } { return pulseOf(Math.abs(usd) / min); }
/** A pulse for an order `r` times the size that starts one (at least one). */
function pulseOf(r: number): { amp: number; width: number } {
  const k = Math.max(1, r);
  return { amp: Math.min(1.6, 0.35 * Math.sqrt(k)), width: 4 + 3 * Math.log10(k) };
}

/**
 * How many market waves the field starts (`order`): SPAWN_RATE a second of its own time, and up to SPAWN_BURST at once after a quiet spell
 * (so at most SPAWN_BURST + SPAWN_RATE in the first second of a burst, SPAWN_RATE a second after).
 */
export const SPAWN_RATE = 8, SPAWN_BURST = 4;
/** Orders of one side within this distance (CSS px) of a wave still waiting to start join it, as one larger order; farther ones never do. */
export const MERGE_PX = 48;
/**
 * How many waves may wait to start, each side. An order that joins none when they are all taken replaces the smallest of them if it is
 * larger, and is passed over otherwise (its light in the glass still shows it).
 */
export const MAX_WAITING = 4;
/**
 * How long a wave may wait to start (ms of the clock, from its first order): a wave is seen where and about when its orders traded, or not
 * at all. The largest start first, so what ages out is the small.
 */
export const MAX_WAIT_MS = 400;
/**
 * An order this many times the size that starts a wave ($1M against $25k) always shows: it is let in at least at WHALE_GAIN of its height,
 * the largest first, as long as the field holds less than WHALE_ROOM times its ceiling (so a run of them cannot flood it either).
 */
export const WHALE_R = 40, WHALE_GAIN = 0.5, WHALE_ROOM = 1.5;
/**
 * Starts in a row on one side after which the other side's largest waiting wave goes next, if it has one (a whale aside): a side with waves
 * waiting gets at least one start in STREAK_MAX + 1 (about 2 of the 8 a second), so a crash's buys still show beside its far larger sells.
 */
export const STREAK_MAX = 3;
/**
 * How long the field takes to lose all but 1/e of the energy a wave put in (ms): the damping everywhere and the soaking edges together.
 * Measured on the processor stand-in of the step shader on a 1920 x 1080 desktop (the flow column's and the book's splitters, the bars):
 * of 0.7, 1, 1.5 and 2 s, 1.5 s followed the fronts' true energy best, 0.99 correlated over an ordinary day and over a cascade.
 */
export const ENERGY_TAU_MS = 1_500;
/**
 * The field's energy as `order` reckons it: each wave adds its height squared times its width squared (in cells), the energy its pulse puts
 * in, which then fades with ENERGY_TAU_MS of the field's own time. Up to the knee a new wave goes in at its full height; past it, smaller
 * and smaller, and at the ceiling not at all. The knee is about what an ordinary day of a few large orders a second reaches at its 95th
 * percentile, the ceiling about its 99th: a burst is cut at an ordinary day's busiest moment, and a cascade that lasts is held back by the
 * slow average below.
 */
export const ENERGY_KNEE = 12, ENERGY_MAX = 16;
/**
 * The same energy averaged over SLOW_MS of the field's time, and its own knee and ceiling: what holds a cascade back. An ordinary day's
 * fullness comes and goes (a large order, then quiet), a cascade's stays: the fast ceiling above lets an ordinary day's busiest moment
 * through whole, so on its own it held a cascade at that moment's fullness for as long as the cascade lasted, about three times the screen
 * an ordinary day lights on average (Sol). Averaged, an ordinary day passes SLOW_KNEE only for a while after its largest orders (it drew
 * crests on 14% less of the screen than with no limit at all); a cascade is held to SLOW_MAX, about twice an ordinary day's average
 * fullness (measured on the processor stand-in, 1920 x 1080). Below 30 frames a second the field runs slower than the clock (MAX_FRAME_MS a
 * frame), so its waves last longer on the clock and this brake takes longer to act (5 s of the field's time is 15 s at 10 frames a second):
 * a cascade there shows about twice the share. That is the cap on a frame's step, not the governor.
 */
export const SLOW_MS = 5_000, SLOW_KNEE = 6, SLOW_MAX = 8;
/**
 * The damping added to the market's waves (each substep, on top of the medium's) when the field is busy, in proportion to how busy
 * (`busyness`): a busy field forgets its echoes sooner, so its waves are seen where the orders are, not thrown back from every splitter
 * and pane across the screen (Karl: "the waves bounce from many places"). A field under its knees rings as it always did. The energy it
 * takes is reckoned (`energy`), so the ceilings hold as before; what changes is where the light is: the share of the screen a crest is
 * seen on, at the same energy, fell by about two fifths with it on the processor stand-in.
 */
export const BUSY_DAMP = 0.003;
/**
 * How fast the reckoned energy fades at busyness `b` (a share a ms of the field's time). Leapfrog damped by `d` a substep keeps
 * sqrt(1 - d) of a wave's height (a root of x^2 - 2(1 - d)cos(w)x + (1 - d)), so its energy falls by `d` a substep: the damping's rate,
 * not twice it.
 */
const fadeRate = (b: number): number => 1 / ENERGY_TAU_MS + BUSY_DAMP * b / SUBSTEP_MS;

const ramp = (v: number, knee: number, max: number): number => Math.min(1, Math.max(0, (v - knee) / (max - knee)));
/**
 * How busy the field is, from 0 under both knees to 1 at either ceiling: its energy now (`energy`, against ENERGY_KNEE and ENERGY_MAX) or
 * its energy averaged over SLOW_MS (`slow`, against SLOW_KNEE and SLOW_MAX), whichever is the busier.
 */
export function busyness(energy: number, slow = 0): number { return Math.max(ramp(energy, ENERGY_KNEE, ENERGY_MAX), ramp(slow, SLOW_KNEE, SLOW_MAX)); }

/**
 * The share of a new wave's height let in when the field is this busy: all of it under the knees, then less and less, and none at a
 * ceiling. A wave let in at all goes in whole however large, so a single large order on a quiet field keeps its full height and reach (how
 * far a wave runs says how large its order was); a field past a ceiling lets nothing in until it fades, but a whale (WHALE_R).
 */
export function admitted(energy: number, slow = 0): number { return Math.sqrt(1 - busyness(energy, slow)); }

/**
 * A wave waiting to start: the orders gathered into it (`r`, their sizes over the size that starts one, added up; `top`, the largest of
 * them alone), where (their sizes' centre), and since when (its first order, on the clock).
 */
interface Waiting { x: number; y: number; r: number; top: number; born: number }

/** Whether waiting wave `a` starts before `b`: a whale (WHALE_R) before any other, then the larger, then the older. */
function before(a: Waiting, b: Waiting): boolean {
  const wa = a.top >= WHALE_R, wb = b.top >= WHALE_R;
  return wa !== wb ? wa : a.r > b.r || (a.r === b.r && a.born < b.born);
}

/** The waiting wave of one side that starts first (`before`), or null when none waits. */
function bestOf(list: readonly Waiting[]): Waiting | null {
  let best: Waiting | null = null;
  for (const w of list) if (!best || before(w, best)) best = w;
  return best;
}

/**
 * The gain of the middle of the Strength slider, the default (Karl: "by default make it very weak, make the effect fairly weak, or find an
 * ideal"): an ordinary day's crests on about a third of the screen they took before there was a setting, and a cascade's on a little more
 * than an ordinary day's took then (in a browser about 0.7% against 0.39%: up to twice the area at about 1.15 times the brightness; time-averaged share
 * of the screen drawn at alpha 0.03 or more).
 */
export const STRENGTH_MID_GAIN = 0.75;
/**
 * The person's Strength (0 to 100, the Waves panel) as the gain the waves are drawn with: a quarter of the middle's at 0, barely there, and
 * four times it at the top. Even steps of the slider are even ratios, as the eye judges a contrast.
 */
export function strengthGain(strength: number): number {
  const s = Number.isFinite(strength) ? Math.min(100, Math.max(0, strength)) : WAVE_STRENGTH_DEFAULT;
  return STRENGTH_MID_GAIN * 4 ** ((s - 50) / 50);
}
/** The Strength a page starts with: the middle of the slider. */
export const WAVE_STRENGTH_DEFAULT = 50;
/** A saved Strength: a number from 0 to 100 (rounded, held within them), anything else the default. */
export function readWaveStrength(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : WAVE_STRENGTH_DEFAULT;
}

const VERT = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

// One substep: the next height from this one and the last (leapfrog), the neighbours' pull scaled by the medium's speed there, damped a
// little everywhere and much at the screen's edges, and the market's two fields more while the field is busy (`busyDamp`); then the pulses
// of this substep (an order's on a frame's first, a moving touch's on each), each a segment from `src.xy` to `seg.xy` (a point where the
// two are one), its height falling off with the distance from it.
const STEP = `#version 300 es
precision highp float;
uniform sampler2D cur, prev, medium; uniform vec2 texel; uniform float courant, busyDamp;
uniform int n; uniform vec4 src[${MAX_SOURCES}]; uniform vec2 seg[${MAX_SOURCES}]; uniform float side[${MAX_SOURCES}];
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * texel;
  vec4 c = texture(cur, uv), p = texture(prev, uv), m = texture(medium, uv);
  vec4 lap = texture(cur, uv + vec2(texel.x, 0.0)) + texture(cur, uv - vec2(texel.x, 0.0)) + texture(cur, uv + vec2(0.0, texel.y)) + texture(cur, uv - vec2(0.0, texel.y)) - 4.0 * c;
  vec4 next = (2.0 * c - p + courant * m.r * lap) * (1.0 - m.g);
  next.rg *= 1.0 - busyDamp;
  for (int i = 0; i < ${MAX_SOURCES}; i++) {
    if (i >= n) break;
    vec2 a = src[i].xy, ab = seg[i] - a, q = gl_FragCoord.xy - a;
    vec2 d = q - ab * clamp(dot(q, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    float b = src[i].z * exp(-dot(d, d) / (2.0 * src[i].w * src[i].w));
    if (side[i] < 0.5) next.r += b; else if (side[i] < 1.5) next.g += b; else next.b += b;
  }
  o = vec4(clamp(next.rgb, -4.0, 4.0), 1.0);
}`;

// The medium: the speed squared (against the open screen's) in red, the damping in green.
const MEDIUM = `#version 300 es
precision highp float;
uniform vec4 region[24]; uniform float kind[24]; uniform int n; uniform vec2 cells; uniform float glassC, wallC;
out vec4 o;
void main() {
  vec2 c = gl_FragCoord.xy; float speed = 1.0;
  for (int i = 0; i < 24; i++) {
    if (i >= n) break;
    vec4 r = region[i];
    if (c.x >= r.x && c.x <= r.x + r.z && c.y >= r.y && c.y <= r.y + r.w) speed = kind[i] > 0.5 ? wallC : min(speed, glassC);
  }
  // The edges soak a wave up over a few cells, so it does not come back from them.
  float edge = min(min(c.x, cells.x - c.x), min(c.y, cells.y - c.y));
  float damp = 0.0009 + 0.18 * (1.0 - smoothstep(0.0, 7.0, edge));
  o = vec4(speed * speed, damp, 0.0, 1.0);
}`;

export class WaveField {
  readonly gl: WebGL2RenderingContext;
  #step: WebGLProgram; #medium: WebGLProgram;
  #loc = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  /**
   * The programs the card is still building (gl-build.ts) and the uniforms to read from each once built; null once they are. The medium
   * asked for meanwhile is drawn then.
   */
  #building: (readonly [Building, readonly string[]])[] | null;
  #regions: readonly WaveRegion[] = [];
  /** Why the programs did not build, once `built` found it: the field is then never stepped nor alive (its owner drops it). */
  #failure: Error | null = null;
  #tex: WebGLTexture[] = []; #fbo: WebGLFramebuffer[] = [];
  #mediumTex: WebGLTexture; #mediumFbo: WebGLFramebuffer;
  #cols = 1; #rows = 1; #cssH = 1;
  /** Which of the three textures is the last, this and the next step (leapfrog keeps two and writes the third). */
  #i = 0;
  #pending: WaveSource[] = [];
  /** Touches moving across the next frame (`addPath`): each substep takes a piece of each. */
  #paths: WavePath[] = [];
  /** One substep's pulses, as the step shader takes them (kept, not made again every substep). */
  #src = new Float32Array(MAX_SOURCES * 4); #seg = new Float32Array(MAX_SOURCES * 2); #side = new Float32Array(MAX_SOURCES);
  #lastSource = -Infinity;
  #last = 0;
  /** How far the field's time is behind the clock (ms, within half a substep either way): carried to the next frame, never dropped. */
  #carry = 0;
  /** Whether the field has been set back to still since its waves ran out (so nothing stays frozen in it). */
  #still = true;
  /**
   * The waves waiting to start, buys' and sells' (`order`), and the starts the field may still make now (a bucket refilled at SPAWN_RATE a
   * second of the field's time).
   */
  #waiting: [Waiting[], Waiting[]] = [[], []];
  #tokens = SPAWN_BURST;
  /** The side the last market waves started on, and how many in a row (STREAK_MAX). */
  #streakSide: 0 | 1 = 0; #streak = 0;
  /** The field's energy as `order` reckons it, as of the last substep stepped (it fades with the field's time, `fadeRate`). */
  #energy = 0;
  /** The same averaged over SLOW_MS of the field's time (SLOW_KNEE, SLOW_MAX). */
  #slow = 0;
  /** Orders taken, market waves started, orders passed over (a full queue, or too old to start), and how late the last waves started (ms). */
  #orders = 0; #started = 0; #passed = 0;
  #delays: number[] = [];

  /** A field in `gl`, or null where the card cannot draw into half floats (the caller keeps its older light). */
  static create(gl: WebGL2RenderingContext): WaveField | null {
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return null;
    try { return new WaveField(gl); } catch { return null; }
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    // Built beside the page (gl-build.ts): the field is stepped only once `built` finds them done.
    const step = startProgram(gl, VERT, STEP), medium = startProgram(gl, VERT, MEDIUM);
    this.#step = step.program; this.#medium = medium.program;
    this.#building = [[step, ['cur', 'prev', 'medium', 'texel', 'courant', 'busyDamp', 'n', 'src', 'seg', 'side']], [medium, ['region', 'kind', 'n', 'cells', 'glassC', 'wallC']]];
    for (let i = 0; i < 3; i++) { this.#tex.push(this.#texture()); this.#fbo.push(gl.createFramebuffer()!); }
    this.#mediumTex = this.#texture(); this.#mediumFbo = gl.createFramebuffer()!;
    this.resize(4, 4);
    // A card that lists the extension but cannot draw into the texture after all: no field.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo[0]!);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) throw new Error('half floats are not drawable here');
  }

  /**
   * Whether the programs are built and their uniforms read: false while the card still builds them (asked without waiting, gl-build.ts).
   * Throws what failed. The caller steps the field and draws its medium only once it is true.
   */
  built(): boolean {
    if (this.#failure) throw this.#failure;
    const building = this.#building; if (!building) return true;
    try { if (!built(this.gl, building.map(([b]) => b))) return false; }
    catch (error) { this.#failure = error instanceof Error ? error : new Error(String(error)); this.#building = null; throw this.#failure; }
    for (const [b, names] of building) this.#loc.set(b.program, uniforms(this.gl, b.program, names));
    this.#building = null;
    this.setMedium(this.#regions);
    return true;
  }

  /** Whether the programs can be used now (`built`, without waiting); one that failed reads as not built here (`built` says why). */
  #usable(): boolean { try { return this.built(); } catch { return false; } }
  /** Whether the programs failed to build: the field draws nothing, ever. */
  get failed(): boolean { return this.#failure !== null; }

  /** The field's grid: `cols` by `rows` cells, each `CELL` CSS px. */
  get cols(): number { return this.#cols; }
  get rows(): number { return this.#rows; }
  /** The texture of the heights now (red buy, green sell), linear filtered: sample it at (CSS px / CELL) / (cols, rows), y up. */
  get texture(): WebGLTexture { return this.#tex[(this.#i + 1) % 3]!; }
  /** The heights a substep before (`waveFront` reads the two: a front is where the height still rises; the wake a 2D wave leaves is not). */
  get previous(): WebGLTexture { return this.#tex[this.#i]!; }
  /**
   * Whether a pulse is still in the field (the caller keeps drawing while it is): for RING_MS after the last was added, whether it has been
   * stepped in or not. A pulse still waiting then is dropped at the next step: a caller that stopped stepping (its glass switched off) must
   * not be kept drawing by it for ever, nor have it burst out when it steps again.
   */
  alive(now: number): boolean { return this.#failure === null && now - this.#lastSource < RING_MS; }

  /** Size the field for a screen `cssW` by `cssH` CSS px; its waves start again from still. */
  resize(cssW: number, cssH: number): void {
    const cols = Math.max(4, Math.ceil(cssW / CELL)), rows = Math.max(4, Math.ceil(cssH / CELL));
    this.#cssH = cssH;
    if (cols === this.#cols && rows === this.#rows) return;
    this.#cols = cols; this.#rows = rows;
    const gl = this.gl;
    for (const [i, t] of [...this.#tex, this.#mediumTex].entries()) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, cols, rows, 0, gl.RGBA, gl.HALF_FLOAT, null);
      const fbo = i < 3 ? this.#fbo[i]! : this.#mediumFbo;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.setMedium([]);
    // An empty field: what was reckoned in it and what waited to start in it (at the old layout's places) goes with its waves.
    this.#forget();
  }

  /**
   * Everything back to still: the heights, what waits to start and what the field reckoned it held. For a caller that stops stepping (its
   * glass switched off), so nothing queued before fires at old places when it steps again.
   */
  reset(): void {
    this.#pending.length = 0; this.#paths.length = 0; this.#lastSource = -Infinity;
    this.#clear();
  }

  /** The governor's state back to an empty field's: nothing waiting, a full bucket of starts, no energy. */
  #forget(): void { this.#waiting[0].length = 0; this.#waiting[1].length = 0; this.#tokens = SPAWN_BURST; this.#energy = 0; this.#slow = 0; this.#streak = 0; }

  /** What the waves cross (CSS px, top-down): glass that slows them, walls that throw most of them back. */
  setMedium(regions: readonly WaveRegion[]): void {
    this.#regions = regions;
    if (!this.#usable()) return;
    const gl = this.gl, l = this.#loc.get(this.#medium)!, n = Math.min(24, regions.length);
    const r = new Float32Array(24 * 4), k = new Float32Array(24);
    regions.slice(0, 24).forEach((q, i) => {
      // Cells count bottom-up, as the card's rows do.
      r.set([q.x / CELL, (this.#cssH - q.y - q.h) / CELL, q.w / CELL, q.h / CELL], i * 4); k[i] = q.kind === 'wall' ? 1 : 0;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#mediumFbo); gl.viewport(0, 0, this.#cols, this.#rows);
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0]);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.#medium);
    gl.uniform4fv(l.get('region')!, r); gl.uniform1fv(l.get('kind')!, k); gl.uniform1i(l.get('n')!, n);
    gl.uniform2f(l.get('cells')!, this.#cols, this.#rows); gl.uniform1f(l.get('glassC')!, 1 / GLASS_INDEX); gl.uniform1f(l.get('wallC')!, WALL_SPEED);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Orders `order` has taken, market waves started and orders passed over since the field was made: what reached the card against what came. */
  get orders(): number { return this.#orders; }
  get started(): number { return this.#started; }
  get passed(): number { return this.#passed; }
  /** How late the last waves (up to 64) started after their first order (ms of the clock). */
  get delays(): readonly number[] { return this.#delays; }
  /**
   * The field's energy as `order` reckons it (ENERGY_MAX is where it lets nothing more in), as of the last substep stepped. It fades with the
   * field's own time, never the clock's: a card that falls behind steps at most MAX_FRAME_MS a frame, and the waves in it lose only what
   * that time takes (reckoned on the clock, a field drawn at 10 frames a second was believed three times emptier than it was).
   */
  get energy(): number { return this.#energy; }
  /** The energy averaged over SLOW_MS of the field's time: what holds a cascade back. */
  get slowEnergy(): number { return this.#slow; }
  /** How many waves are waiting to start. */
  get waiting(): number { return this.#waiting[0].length + this.#waiting[1].length; }

  /**
   * A market order (or a large change of flow) of `usd` against the size that starts a wave (`min`), at (x, y) CSS px, a buy's or a sell's:
   * gathered into the waiting wave of its side nearest it within MERGE_PX, as more of the same order; or waiting as a wave of its own; or,
   * with MAX_WAITING already waiting, in place of the smallest of them if it is larger, and passed over if not. The next steps start the
   * waiting waves, the largest first, each let in as the field's energy allows (`admitted`).
   */
  order(x: number, y: number, usd: number, min: number, side: 0 | 1, now: number): void {
    if (!(Math.abs(usd) > 0) || !(min > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    // A field no longer stepped (its waves ran out, its glass or tab was left) holds nothing now, whatever it last reckoned: forgotten, so the
    // first waves after it go in whole and at once.
    if (!this.alive(now)) this.#forget();
    const r = Math.max(1, Math.abs(usd) / min), list = this.#waiting[side];
    this.#orders++; this.#lastSource = now; this.#still = false;
    let near: Waiting | null = null, best = Infinity;
    for (const w of list) { const d = Math.hypot(w.x - x, w.y - y); if (d < best) { best = d; near = w; } }
    if (near && best <= MERGE_PX) {
      near.x = (near.x * near.r + x * r) / (near.r + r); near.y = (near.y * near.r + y * r) / (near.r + r); near.r += r; near.top = Math.max(near.top, r);
      return;
    }
    const fresh: Waiting = { x, y, r, top: r, born: now };
    if (list.length < MAX_WAITING) { list.push(fresh); return; }
    let smallest = 0;
    for (let i = 1; i < list.length; i++) if (list[i]!.r < list[smallest]!.r) smallest = i;
    this.#passed++;
    if (list[smallest]!.r < r) list[smallest] = fresh;
  }

  /**
   * How much of a waiting wave's height the field lets in now: `admitted` by its energy, and at least WHALE_GAIN for a single order of
   * WHALE_R or more while the field holds less than WHALE_ROOM times its ceiling.
   */
  #gainFor(w: Waiting): number {
    const g = admitted(this.#energy, this.#slow);
    return w.top >= WHALE_R && this.#energy < ENERGY_MAX * WHALE_ROOM ? Math.max(g, WHALE_GAIN) : g;
  }

  /**
   * Into the next step's pulses: the waiting waves the bucket allows (refilled by `fieldMs`, the time this step advances the field), the
   * largest first (a whale's before any other; no side more than STREAK_MAX in a row while the other has waves waiting), each at the height
   * the field's energy lets in. When the field can take nothing more, they
   * wait, their starts unspent, until it has room or they are older than MAX_WAIT_MS of the clock.
   */
  #start(now: number, fieldMs: number): void {
    this.#tokens = Math.min(SPAWN_BURST, this.#tokens + fieldMs * SPAWN_RATE / 1000);
    for (const list of this.#waiting) for (let i = list.length - 1; i >= 0; i--) if (now - list[i]!.born > MAX_WAIT_MS) { list.splice(i, 1); this.#passed++; }
    while (this.#tokens >= 1 && this.#pending.length < MAX_SOURCES) {
      const best = [bestOf(this.#waiting[0]), bestOf(this.#waiting[1])] as const;
      let from: 0 | 1 = best[1] && (!best[0] || before(best[1], best[0])) ? 1 : 0;
      const other = (1 - from) as 0 | 1, pick0 = best[from];
      if (!pick0) break;
      // STREAK_MAX starts in a row on one side: the other side's best goes next, unless this one is a whale and it is not.
      if (best[other] && this.#streakSide === from && this.#streak >= STREAK_MAX && !(pick0.top >= WHALE_R && best[other]!.top < WHALE_R)) from = other;
      const pick = best[from]!;
      const g = this.#gainFor(pick);
      if (!(g > 0.01)) break;
      const p = pulseOf(pick.r), e = p.amp * p.amp * Math.max(0.8, p.width / CELL) ** 2;
      this.#waiting[from].splice(this.#waiting[from].indexOf(pick), 1);
      this.#tokens -= 1; this.#energy += g * g * e; this.#started++;
      this.#streak = this.#streakSide === from ? this.#streak + 1 : 1; this.#streakSide = from;
      this.#delays.push(now - pick.born); if (this.#delays.length > 64) this.#delays.shift();
      this.#pending.push({ x: pick.x, y: pick.y, amp: p.amp * g, width: p.width, side: from });
    }
  }

  /** A pulse, added on the next step. */
  add(s: WaveSource, now: number): void {
    this.#pending.push(s);
    if (this.#pending.length > MAX_SOURCES) this.#pending.splice(0, this.#pending.length - MAX_SOURCES);
    this.#lastSource = now; this.#still = false;
  }

  /** A touch moving across the next frame (spread over its substeps, a piece each); at most a few at once, the newest kept. */
  addPath(path: WavePath, now: number): void {
    this.#paths.push(path);
    if (this.#paths.length > MAX_PATHS) this.#paths.splice(0, this.#paths.length - MAX_PATHS);
    this.#lastSource = now; this.#still = false;
  }

  /** Step the field to `now` (ms). Leaves the default framebuffer bound and blending off; the caller sets its own viewport after. */
  step(now: number): void {
    if (!this.#usable()) return;
    const gl = this.gl, l = this.#loc.get(this.#step)!;
    // A still field keeps no time: the first frame of the next pulse steps one frame's time, not the whole idle spell (MAX_FRAME_MS).
    if (!this.alive(now)) { this.#pending.length = 0; this.#paths.length = 0; this.#waiting[0].length = 0; this.#waiting[1].length = 0; this.#last = 0; this.#carry = 0; if (!this.#still) this.#clear(); return; }
    // Whole substeps of the one length, to the nearest, and what is left over (either way) goes into the next frame: so frames of 16 and
    // 17 ms are eight substeps each, a second draw in the same millisecond steps none, and a clock that went back (a page woken from the
    // background) steps none either. A pulse waiting for a frame that steps none goes in with the next substep.
    const dt = this.#last ? Math.min(MAX_FRAME_MS, Math.max(0, now - this.#last)) : 16.7; this.#last = now;
    const due = this.#carry + dt, steps = Math.max(0, Math.round(due / SUBSTEP_MS)), fieldMs = steps * SUBSTEP_MS;
    this.#carry = due - fieldMs;
    this.#start(now, fieldMs);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.#cols, this.#rows);
    gl.useProgram(this.#step);
    gl.uniform2f(l.get('texel')!, 1 / this.#cols, 1 / this.#rows); gl.uniform1f(l.get('courant')!, COURANT);
    const busy = busyness(this.#energy, this.#slow);
    gl.uniform1f(l.get('busyDamp')!, BUSY_DAMP * busy);
    gl.uniform1i(l.get('cur')!, 0); gl.uniform1i(l.get('prev')!, 1); gl.uniform1i(l.get('medium')!, 2);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.#mediumTex);
    // A frame that steps none keeps its moving touches for the next one, as it keeps its pulses.
    const paths = steps > 0 ? this.#paths.splice(0) : [];
    const src = this.#src, seg = this.#seg, side = this.#side;
    // The pulses' arrays are sent only for a substep that has any: the shader reads none past `n`, so a substep without leaves them as
    // they were (most substeps have none, and each array sent is a call the page waits on).
    let sentNone = false;
    for (let k = 0; k < steps; k++) {
      const prev = this.#i, cur = (this.#i + 1) % 3, next = (this.#i + 2) % 3;
      let n = 0;
      const put = (x: number, y: number, x2: number, y2: number, amp: number, width: number, who: number): void => {
        if (n >= MAX_SOURCES) return;
        src[n * 4] = x / CELL; src[n * 4 + 1] = (this.#cssH - y) / CELL; src[n * 4 + 2] = amp; src[n * 4 + 3] = Math.max(0.8, width / CELL);
        seg[n * 2] = x2 / CELL; seg[n * 2 + 1] = (this.#cssH - y2) / CELL; side[n] = who; n++;
      };
      if (k === 0) for (const q of this.#pending.splice(0)) put(q.x, q.y, q.x2 ?? q.x, q.y2 ?? q.y, q.amp, q.width, q.side);
      // Each moving touch lays down this substep's piece of its way, so its wake is drawn as it goes.
      for (const w of paths) {
        const f0 = k / steps, f1 = (k + 1) / steps;
        put(w.x0 + (w.x1 - w.x0) * f0, w.y0 + (w.y1 - w.y0) * f0, w.x0 + (w.x1 - w.x0) * f1, w.y0 + (w.y1 - w.y0) * f1, w.amp, w.width, 2);
      }
      if (n > 0) { gl.uniform1i(l.get('n')!, n); gl.uniform4fv(l.get('src')!, src); gl.uniform2fv(l.get('seg')!, seg); gl.uniform1fv(l.get('side')!, side); sentNone = false; }
      else if (!sentNone) { gl.uniform1i(l.get('n')!, 0); sentNone = true; }
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#tex[cur]!);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.#tex[prev]!);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo[next]!);
      // Every cell is written: a tiled card (a phone's) need not read the old heights back in first.
      gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.#i = cur;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    // What the substeps just took from the energy: the field's time they stepped, at the busy damping they were stepped with.
    this.#energy *= Math.exp(-fieldMs * fadeRate(busy));
    this.#slow += (this.#energy - this.#slow) * (1 - Math.exp(-fieldMs / SLOW_MS));
  }

  /** Every height back to zero: the waves have run out, and what little is left must not stay on the screen. Its clock starts again too. */
  #clear(): void {
    const gl = this.gl;
    for (const fbo of this.#fbo) { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.#still = true; this.#last = 0; this.#carry = 0;
    // A still field is empty: the next wave finds a full bucket of starts and no energy left in it.
    this.#forget();
  }

  #texture(): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
}

/**
 * The GLSL a renderer adds to read the field: `waveAt(cssPx)` the two heights there (buy, sell), `waveFront(cssPx)` how fast they rise
 * there (the moving fronts, bright; the slow wake a 2D wave leaves behind them, dark), and `waveSlope(cssPx)` their summed slope, from the
 * textures bound to `waves` and `wavesPrev` with the grid's size in `waveCells` (CSS px are top-down; the field's rows bottom-up). The
 * touches' field has the same three, `touchAt`, `touchFront` and `touchSlope`. The market's waves are drawn `waveGain` times as strong as
 * the field holds them (`strengthGain`, the person's Strength; a renderer that reads them must set it); the touches are the person's own
 * hand, drawn as they are.
 */
export const WAVE_GLSL = `
uniform sampler2D waves, wavesPrev; uniform vec2 waveCells; uniform float waveCssH, waveGain; uniform bool hasWaves;
vec2 waveUv(vec2 p) { return vec2(p.x, waveCssH - p.y) / ${CELL}.0 / waveCells; }
vec2 waveAt(vec2 p) { if (!hasWaves) return vec2(0.0); return texture(waves, waveUv(p)).rg * waveGain; }
vec2 waveFront(vec2 p) { if (!hasWaves) return vec2(0.0); vec2 uv = waveUv(p); return max(texture(waves, uv).rg - texture(wavesPrev, uv).rg, vec2(0.0)) * 3.0 * waveGain; }
vec2 waveSlope(vec2 p) {
  if (!hasWaves) return vec2(0.0);
  vec2 a = waveAt(p + vec2(${CELL}.0, 0.0)) - waveAt(p - vec2(${CELL}.0, 0.0)), b = waveAt(p + vec2(0.0, ${CELL}.0)) - waveAt(p - vec2(0.0, ${CELL}.0));
  return vec2(a.r + a.g, b.r + b.g) * 0.5;
}
float touchAt(vec2 p) { if (!hasWaves) return 0.0; return texture(waves, waveUv(p)).b; }
float touchFront(vec2 p) { if (!hasWaves) return 0.0; vec2 uv = waveUv(p); return max(texture(waves, uv).b - texture(wavesPrev, uv).b, 0.0) * 3.0; }
vec2 touchSlope(vec2 p) {
  if (!hasWaves) return vec2(0.0);
  return vec2(touchAt(p + vec2(${CELL}.0, 0.0)) - touchAt(p - vec2(${CELL}.0, 0.0)), touchAt(p + vec2(0.0, ${CELL}.0)) - touchAt(p - vec2(0.0, ${CELL}.0))) * 0.5;
}`;
