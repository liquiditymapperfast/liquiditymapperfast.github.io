import { el } from '../dom.ts';
import { STRIDE, type TapeRing } from '../tape/ring.ts';
import { chromeFor, rgb, type Palette } from '../theme.ts';
import { scaledUsd } from '../coin.ts';
import { CELL, ENERGY_MAX, WAVE_GLSL, WAVE_STRENGTH_DEFAULT, WaveField, pulseFor, strengthGain, type WaveRegion } from './waves.ts';
import { PRESS, PUSH_WIDTH, WAKE_BREAK_MS, WAKE_WIDTH, pushAmp, wakeAmp } from './touch.ts';
import { built, startProgram, uniforms, type Building } from '../gl-build.ts';
import { liveCanvas } from '../live-canvas.ts';
import { pixelRatio, sharpens } from '../pixel-ratio.ts';

/**
 * The Glass material (Karl, 2026-10-16): the bars and panels around the chart become glass, and the market's large orders send light
 * through it. One canvas over the page, under the chrome and above the chart, draws glass only where the chrome is (the top bar, the
 * status bar, the splitters between panes, the panels and menus that open), so nothing is ever drawn over the data. It is not a
 * `backdrop-filter` (AGENTS.md): there is nothing behind the chrome to blur, so the light comes from the trades themselves.
 *
 * A large order lights the glass nearest the place on the map where it traded: the top bar above it, the status bar under it, the
 * splitter beside it at its price (the light gathers there, in the side's colour, as strong as the order is large), then runs out through
 * the glass as one ripple whose colours split a little, as glass splits them. The largest also leave a faint ghost mirrored through the
 * middle of the screen, the reflection a pair of binoculars throws from a bright light. The light reaches the glass's rims in full and
 * stays a breath inside, under the controls, so their text keeps its contrast.
 *
 * Where the card can run it, a field of real waves comes as well (glass/waves.ts, Karl, 2026-10-17): a large order drops a pulse where
 * the map shows it, and the wave runs out across the whole screen, the chart included, as faint lines of light at its crests over the
 * data. The halo above stays with it, never replaced by it (Karl, 2026-10-17: the gathered light, the split ripple and the binocular ghost
 * were the glass's beauty, and the waves alone lost them). It slows and bends in the chrome's glass, which it lights as it crosses (brightest where a crest meets a rim), is partly thrown
 * back by the splitters, and is soaked up at the screen's edges. The flow column's large changes send waves of their own (`pulse`). The
 * orders go to the field as orders (`WaveField.order`), which gathers them and holds a busy market back; how strongly its waves are drawn
 * is the person's Strength (`setStrength`, the Waves panel).
 *
 * It draws when something changes (a spark, a wave, a panel opening or moving, a resize), at most 60 times a second while waves run and
 * 30 while sparks glow, and not at all while the page is hidden. Reduced motion keeps the glass and leaves the light out.
 */

/** Where an order at `price` traded at `t` sits on the screen (window CSS px), or null when the map does not show it. */
export type SpotOf = (price: number, t: number) => { x: number; y: number } | null;

const MAX_SPARKS = 32, MAX_RECTS = 24, LIFE_MS = 2600, FRAME_MS = 33, WAVE_FRAME_MS = 16;
/** The least time between two rings the Strength slider sends while it is moved (ms). */
const PREVIEW_MS = 1_000;
/**
 * The chrome that is glass, how each kind is tinted (the bars and splitters in the face tone, the panels in the panel tone), and what it
 * is to a wave: the bars and panels glass that slows it, the splitters walls that throw most of it back.
 */
const SURFACES: readonly (readonly [string, 'bar' | 'panel', 'glass' | 'wall'])[] = [['.toolbar', 'bar', 'glass'], ['.statusbar', 'bar', 'glass'], ['.splitter', 'bar', 'wall'], ['.dock', 'bar', 'glass'], ['.panel', 'panel', 'glass'], ['.menu', 'panel', 'glass']];
/** How far from the order the light still reaches a piece of glass (CSS px), and how fast it falls off on the way. */
const REACH = 700, FALLOFF = 650;
/** The chrome a hand touches the water through (glass/touch.ts): the glass itself, never the data. */
const HAND_GLASS = SURFACES.map(([selector]) => selector).join(', ');

interface Spark { x: number; y: number; at: number; s: number; c: [number, number, number]; ghost: boolean }
interface Surface { x: number; y: number; w: number; h: number; kind: 'bar' | 'panel'; medium: 'glass' | 'wall'; node: HTMLElement }

const VERT = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float; precision highp int;
uniform vec4 rect; uniform vec2 size; uniform float dpr, now, cap, touchCap; uniform vec3 tint; uniform bool dark;
uniform int n; uniform vec4 spark[${MAX_SPARKS}]; uniform vec4 sparkC[${MAX_SPARKS}]; uniform vec3 buyC, sellC, touchC;
${WAVE_GLSL}
out vec4 color;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 p = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y) / dpr;
  float dl = p.x - rect.x, dr = rect.x + rect.z - p.x, dt = p.y - rect.y, db = rect.y + rect.w - p.y;
  float e = max(0.0, min(min(dl, dr), min(dt, db)));
  vec2 nrm = dl <= min(dr, min(dt, db)) ? vec2(-1.0, 0.0) : dr <= min(dt, db) ? vec2(1.0, 0.0) : dt <= db ? vec2(0.0, -1.0) : vec2(0.0, 1.0);
  float bevel = min(7.0, 0.45 * min(rect.z, rect.w)), s = 1.0 - smoothstep(0.0, bevel, e);
  // Near a rim the glass bends the light: what lights a pixel there comes from further along the surface.
  vec2 q = p - nrm * s * s * bevel * 3.0;
  vec3 glow = vec3(0.0), ring = vec3(0.0);
  for (int i = 0; i < ${MAX_SPARKS}; i++) {
    if (i >= n) break;
    vec4 k = spark[i]; float age = now - k.z;
    if (age < 0.0 || age > ${LIFE_MS}.0) continue;
    vec3 c = sparkC[i].rgb; bool ghost = sparkC[i].a > 0.5;
    float env = (age < 70.0 ? age / 70.0 : exp(-(age - 70.0) / 800.0)) * k.w, d = length(q - k.xy);
    // The light gathered where the order is nearest, spreading as it fades.
    float spread = 18.0 + age * 0.06;
    if (!ghost) glow += c * env * 2.2 * exp(-d * d / (2.0 * spread * spread));
    // One ripple running out through the glass, its colours a little apart.
    float r = age * (ghost ? 0.22 : 0.34), w = ghost ? 7.0 : 4.0, fade = exp(-age / (ghost ? 1200.0 : 950.0)) * k.w * (ghost ? 0.9 : 1.4);
    vec3 band = vec3(exp(-pow((d - r * 0.97) / w, 2.0)), exp(-pow((d - r) / w, 2.0)), exp(-pow((d - r * 1.03) / w, 2.0)));
    ring += mix(c, vec3(1.0), 0.35) * band * fade;
  }
  // The waves crossing the glass: their crests light it in the side's colour (bent at the rims, as the sparks' light is), and their slope
  // tilts the sky it reflects, so the glass is seen to ripple as they pass.
  vec2 wv = waveFront(q), ws = waveSlope(q) + touchSlope(q) * 0.4;
  vec3 waveLight = (buyC * wv.r + sellC * wv.g) / max(wv.r + wv.g, 1e-3) * (1.0 - exp(-(wv.r + wv.g) * 2.5)) * 1.2;
  // The person's own touches light it too, in the page's accent, paled as glass pales a light (neither side's colour: they are no order):
  // thin lines where their crests rise, as light catches the crests of a wake, not a glow over the whole of it.
  vec3 touchLight = mix(touchC, vec3(1.0), 0.35) * smoothstep(0.04, 0.3, touchFront(q)) * 0.9;
  if (!dark) { waveLight = mix(waveLight, vec3(0.0), 0.5); touchLight = mix(touchLight, vec3(0.0), 0.5); }
  // Edge-lit: the light runs to the rims, which glow in full; inside, under the controls, it is held to a breath however many lights
  // overlap (rolled off to at most cap), so their text keeps its contrast. A touch's own light is held to a little more (touchCap): it
  // passes where the hand is, for a moment, and the controls' faces keep most of it off their labels.
  float rim = exp(-e / 3.5);
  vec3 total = glow + ring + waveLight, L = mix(cap * (vec3(1.0) - exp(-total / max(cap, 1e-3))), total, rim);
  L += mix(touchCap * (vec3(1.0) - exp(-touchLight / max(touchCap, 1e-3))), touchLight, rim);
  // The glass: its tint, lighter toward the top (the sky it reflects), a lit upper and left rim, a shaded lower and right one, a frost.
  float sky = (1.0 - clamp(dt / max(rect.w, 1.0), 0.0, 1.0)) * (dark ? 0.05 : 0.035) + clamp(dot(ws, vec2(-0.6, 0.8)), -0.5, 0.5) * (dark ? 0.08 : 0.05);
  vec3 base = tint + vec3(sky) + (hash(floor(p * dpr)) - 0.5) * 0.014;
  float hi = (1.0 - smoothstep(0.0, 1.6, dt)) * (dark ? 0.16 : 0.6) + (1.0 - smoothstep(0.0, 1.6, dl)) * (dark ? 0.07 : 0.35);
  float lo = (1.0 - smoothstep(0.0, 1.6, db)) * (dark ? 0.45 : 0.14) + (1.0 - smoothstep(0.0, 1.6, dr)) * (dark ? 0.25 : 0.08);
  vec3 rgb = mix(base, vec3(1.0), clamp(hi, 0.0, 1.0) * 0.5) * (1.0 - clamp(lo, 0.0, 1.0) * 0.5);
  if (dark) rgb += L;
  else { float a = clamp(max(L.r, max(L.g, L.b)), 0.0, 0.85); rgb = rgb * (1.0 - a * 0.55) + L * 0.55; }
  color = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

// Over the open screen (the chart and its panes): the waves as faint lines of light where their crests are, and a glint where they slope
// toward the light; nothing at all where the field is still.
const OVER = `#version 300 es
precision highp float;
uniform vec2 size; uniform float dpr; uniform bool dark; uniform vec3 buyC, sellC, touchC;
${WAVE_GLSL}
out vec4 color;
void main() {
  vec2 p = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y) / dpr;
  // A ring thins as it spreads (in 2D its height falls with the root of the distance): the tone curve keeps a far one visible and holds
  // a near, strong one to the same faint line. A touch's ring that runs out of the glass over the data is drawn at half its strength.
  vec2 f = waveFront(p);
  float b = f.r, s = f.g, h = touchFront(p) * 0.5, a = 0.18 * (1.0 - exp(-(b + s + h) * 2.5));
  if (a < 0.004) discard;
  vec3 c = (buyC * b + sellC * s + mix(touchC, vec3(1.0), 0.35) * h) / max(b + s + h, 1e-3);
  // On a light page a ripple shows as a slight shadow in the side's colour, as light cannot be added to white.
  color = dark ? vec4(c * a * 1.6, a) : vec4(mix(c, vec3(0.0), 0.55) * a * 1.45, a * 1.45);
}`;

export class UiGlass {
  readonly canvas = el('canvas', { class: 'ui-glass', ariaHidden: 'true' });
  #gl: WebGL2RenderingContext | null = null;
  #prog: WebGLProgram | null = null; #over: WebGLProgram | null = null;
  /**
   * The two programs while the card still builds them beside the page (gl-build.ts): the page stays solid until they are built and the glass
   * can draw (`showing`). `#broken` once one failed: the glass is not tried again.
   */
  #building: readonly [Building, Building] | null = null; #broken = false;
  /** What the page last asked for (`setOn`): glass asked for while the context could not build is turned on when it is given back. */
  #wanted = false;
  #loc = new Map<string, WebGLUniformLocation | null>(); #overLoc = new Map<string, WebGLUniformLocation | null>();
  /** The waves, where the card can run them (null: the sparks' light instead), and the layout its medium was last drawn from. */
  #field: WaveField | null = null; #mediumKey = '';
  /** How strongly the market's waves are drawn (`strengthGain` of the person's Strength). */
  #gain = strengthGain(WAVE_STRENGTH_DEFAULT);
  #on = false; #frame = 0; #last = 0; #poll = 0; #key = '';
  /** The clock the shader's times are counted from, moved up whenever the glass is dark again (a float holds a short time exactly). */
  #base = 0;
  #sparks: Spark[] = [];
  #surfaces: Surface[] = [];
  #seen = 0;
  #palette: Palette | null = null;
  #reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  #observer = new MutationObserver(records => {
    for (const r of records) for (const node of r.addedNodes) if (node instanceof HTMLElement && node.matches('.panel, .menu')) this.#moves.observe(node, { attributes: true, attributeFilter: ['style'] });
    this.schedule();
  });
  #moves = new MutationObserver(() => this.schedule());
  #resize = (): void => { this.#size(); this.schedule(); };
  #visible = (): void => { if (document.hidden) this.#letGo(); else this.schedule(); };
  /** The hand leaves the glass: what it did last is not laid later (a page hidden, a context lost, the glass off). */
  #letGo(): void { this.#hand = null; this.#wakeFrom = null; this.#pushed = null; }
  /**
   * The hand over the glass (glass/touch.ts): where the pointer is (window CSS px, its event's time), and where its wake was last laid to;
   * both null while it is away from the glass. The splitter being dragged, and where its middle line was a frame ago.
   */
  #hand: { x: number; y: number; at: number } | null = null;
  #wakeFrom: { x: number; y: number } | null = null; #laidAt = 0;
  #pushed: { node: HTMLElement; mid: number } | null = null;
  #touching(): boolean { return this.#on && this.#field !== null && !this.#reduced?.matches && !document.hidden; }
  #onMove = (event: PointerEvent): void => {
    if (!this.#touching()) return;
    const over = event.target instanceof Element && event.target.closest(HAND_GLASS) !== null;
    if (!over) { this.#hand = null; this.#wakeFrom = null; return; }
    const was = this.#hand;
    this.#hand = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    // A pointer back after a pause (or from outside the glass) starts its wake where it is now, never with a line from where it last was.
    if (!was || !this.#wakeFrom || event.timeStamp - was.at > WAKE_BREAK_MS) this.#wakeFrom = { x: event.clientX, y: event.clientY };
    this.schedule();
  };
  #onDown = (event: PointerEvent): void => {
    if (!this.#touching() || !(event.target instanceof Element) || !event.target.closest(HAND_GLASS)) return;
    this.#field!.add({ x: event.clientX, y: event.clientY, side: 2, ...PRESS }, performance.now());
    this.schedule();
  };

  constructor(private spotOf: SpotOf, private ring: () => TapeRing | null) {
    liveCanvas(this.canvas, () => { if (this.#on && !document.hidden) this.#draw(performance.now()); });
    // Off, the glass keeps its canvas as it is (sized, it would hold a picture of the whole window for nothing).
    sharpens({ resize: () => { if (this.#on) this.#size(); }, paint: () => { if (this.#on && !document.hidden) this.#draw(performance.now()); } });
    // A card can drop the canvas's context (a driver reset, a phone under memory pressure). The chrome is see-through only over this canvas,
    // so the page turns solid until the context comes back, and then everything is built again.
    this.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      if (this.#frame) cancelAnimationFrame(this.#frame); this.#frame = 0;
      this.#gl = null; this.#prog = null; this.#over = null; this.#building = null; this.#field = null; this.#mediumKey = ''; this.#loc.clear(); this.#overLoc.clear(); this.#letGo();
      if (this.#on) document.documentElement.dataset.material = 'solid';
    });
    // Glass again once its programs are built (`#finish`), and glass asked for while the context was lost is turned on now.
    this.canvas.addEventListener('webglcontextrestored', () => {
      // A card that was reset may build what failed before: it is tried again.
      this.#broken = false;
      if (!this.#wanted) return;
      if (!this.#on) { this.setOn(true); return; }
      if (!this.#ensureGl()) return;
      this.#size(); this.schedule();
    });
  }

  get on(): boolean { return this.#on; }
  /** Whether the glass is on and can draw: the page's chrome turns see-through only then (`html[data-material]`, set by its caller and by `#finish`). */
  get showing(): boolean { return this.#on && this.#prog !== null; }
  /** How many lights are in the glass now, for a look from the console. */
  get lit(): number { return this.#sparks.length; }
  /** Whether waves run with the halo (true), or the halo is the glass's only light (a card that cannot run them). */
  get waves(): boolean { return this.#field !== null; }

  /**
   * A wave from elsewhere on the page (the flow column's large changes): at `x`, `y` (window CSS px), as large as `usd` against `min`, a
   * buy's or a sell's. Nothing without the field, with reduced motion, or while the glass is off.
   */
  pulse(x: number, y: number, usd: number, min: number, side: 0 | 1): void {
    if (!this.#on || !this.#field || this.#reduced?.matches || document.hidden) return;
    this.#field.order(x, y, usd, min, side, performance.now());
    this.schedule();
  }

  /**
   * How strongly the waves are drawn: the person's Strength, 0 to 100 (store `waveStrength`). Moved while the glass shows, it sends a ring
   * from the middle of the screen, a large order's (at most one every PREVIEW_MS), so the slider shows what it does on a quiet market too.
   */
  setStrength(strength: number): void {
    const gain = strengthGain(strength);
    if (gain === this.#gain) return;
    this.#gain = gain;
    const now = performance.now();
    if (this.#on && this.#field && !this.#reduced?.matches && !document.hidden && now - this.#previewAt >= PREVIEW_MS) {
      this.#previewAt = now;
      this.#field.add({ x: window.innerWidth / 2, y: window.innerHeight / 2, side: 0, ...pulseFor(scaledUsd(250_000), scaledUsd(25_000)) }, now);
    }
    this.schedule();
  }
  #previewAt = -Infinity;

  /**
   * What the waves have taken and started, for a look from the console: orders in, waves started, orders passed over, waiting, how full the
   * field is (of ENERGY_MAX) and how late its last waves started (ms after their first order).
   */
  get waveStats(): { orders: number; started: number; passed: number; waiting: number; energy: number; delays: readonly number[] } | null {
    const f = this.#field;
    return f ? { orders: f.orders, started: f.started, passed: f.passed, waiting: f.waiting, energy: f.energy / ENERGY_MAX, delays: [...f.delays] } : null;
  }

  /** Turn the glass on or off (the page's `html[data-material]` is set by its caller, so the chrome turns see-through with it). */
  setOn(on: boolean): void {
    this.#wanted = on;
    this.#switch(on);
  }

  /**
   * The switch itself, leaving what the page asked for as it is: a build that failed turns the glass off here (`#finish`), and the page
   * still asks for glass, so a context given back tries again.
   */
  #switch(on: boolean): void {
    if (on === this.#on) return;
    if (on && !this.#ensureGl()) return;
    this.#on = on;
    if (on) {
      document.body.append(this.canvas);
      this.#size();
      this.#seen = this.ring()?.written ?? 0;
      this.#observer.observe(document.body, { childList: true });
      for (const node of document.querySelectorAll('.panel, .menu')) this.#moves.observe(node, { attributes: true, attributeFilter: ['style'] });
      window.addEventListener('resize', this.#resize);
      document.addEventListener('visibilitychange', this.#visible);
      document.addEventListener('pointermove', this.#onMove, { capture: true, passive: true });
      document.addEventListener('pointerdown', this.#onDown, { capture: true, passive: true });
      // Anything else that moves the chrome (a pane resized, a deck that wraps) is caught by a slow look at where it is.
      this.#poll = window.setInterval(() => { if (this.#layoutKey() !== this.#key) this.schedule(); }, 500);
      this.schedule();
    } else {
      this.canvas.remove();
      for (const node of document.querySelectorAll('.glass-over')) node.classList.remove('glass-over');
      this.#observer.disconnect(); this.#moves.disconnect();
      window.removeEventListener('resize', this.#resize);
      document.removeEventListener('visibilitychange', this.#visible);
      document.removeEventListener('pointermove', this.#onMove, { capture: true });
      document.removeEventListener('pointerdown', this.#onDown, { capture: true });
      this.#letGo();
      window.clearInterval(this.#poll);
      if (this.#frame) cancelAnimationFrame(this.#frame); this.#frame = 0;
      this.#sparks = [];
      // What waited to start must not fire at old places when the glass comes back, nor what the field reckoned it held hold back new waves.
      this.#field?.reset();
    }
  }

  setPalette(p: Palette): void { this.#palette = p; this.schedule(); }

  /** Orders arrived: the large ones send light into the glass nearest the place they traded. */
  tapeArrived(): void {
    const ring = this.ring();
    if (!this.#on || !ring || document.hidden || this.#reduced?.matches) { if (ring) this.#seen = ring.written; return; }
    const p = this.#palette; if (!p) return;
    const min = scaledUsd(25_000), from = Math.max(this.#seen, ring.first, ring.written - 4000), now = performance.now();
    const buy = rgb(p.bid), sell = rgb(p.ask), before = this.#sparks.length;
    let added = false;
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    if (!this.#surfaces.length) this.#surfaces = this.#measure();
    for (let k = from; k < ring.written; k++) {
      const at = (k % ring.capacity) * STRIDE, d = ring.data, usd = d[at + 2]!;
      if (!(Math.abs(usd) >= min)) continue;
      const spot = this.spotOf(ring.p0 + d[at + 1]!, ring.t0 + d[at]!); if (!spot) continue;
      if (this.#field) { this.#field.order(spot.x, spot.y, usd, min, usd > 0 ? 0 : 1, now); added = true; }
      const strength = Math.min(1, 0.35 + 0.3 * Math.log10(Math.abs(usd) / min)), c = usd > 0 ? buy : sell;
      // The glass nearest the order, three pieces at most, each lit by how near it is.
      const near = this.#surfaces.map(r => { const x = Math.max(r.x, Math.min(r.x + r.w, spot.x)), y = Math.max(r.y, Math.min(r.y + r.h, spot.y)); return { x, y, d: Math.hypot(x - spot.x, y - spot.y) }; })
        .filter(q => q.d < REACH).sort((a, b) => a.d - b.d).slice(0, 3);
      for (const q of near) this.#add({ x: q.x, y: q.y, at: now, s: strength * Math.exp(-q.d / FALLOFF), c, ghost: false });
      // The largest leave a ghost through the middle of the screen, where it falls on glass.
      if (strength > 0.65) {
        const gx = cx + (cx - spot.x) * 0.8, gy = cy + (cy - spot.y) * 0.8;
        const hit = this.#surfaces.find(r => gx >= r.x - 40 && gx <= r.x + r.w + 40 && gy >= r.y - 40 && gy <= r.y + r.h + 40);
        if (hit) this.#add({ x: Math.max(hit.x, Math.min(hit.x + hit.w, gx)), y: Math.max(hit.y, Math.min(hit.y + hit.h, gy)), at: now, s: strength * 0.6, c, ghost: true });
      }
    }
    this.#seen = ring.written;
    // Only a new light needs a frame: the ones already in the glass keep their own, and layout changes have theirs.
    if (added || this.#sparks.length !== before || this.#sparks.some(s => s.at === now)) this.schedule();
  }

  #add(s: Spark): void {
    if (!(s.s > 0.03)) return;
    this.#sparks.push(s);
    if (this.#sparks.length > MAX_SPARKS) this.#sparks.splice(0, this.#sparks.length - MAX_SPARKS);
  }

  /** Draw on the next frame (at most one a frame, and at most 30 a second while light is in the glass). */
  schedule(): void {
    if (!this.#on || this.#frame || document.hidden) return;
    this.#frame = requestAnimationFrame(t => {
      this.#frame = 0;
      const pace = this.#field?.alive(t) ? WAVE_FRAME_MS : FRAME_MS;
      if (t - this.#last < pace - 4 && this.#alive(t)) { this.schedule(); return; }
      this.#last = t; this.#draw(t);
      if (this.#alive(t)) this.schedule();
    });
  }

  #alive(now: number): boolean { return this.#sparks.some(s => now - s.at < LIFE_MS) || (this.#field?.alive(now) ?? false); }

  /**
   * What the hand did since the last frame (glass/touch.ts): the pointer's way over the glass as a wake the field spreads over its substeps,
   * and a splitter being dragged as a straight wave along it. Nothing while it rests.
   */
  #layHand(field: WaveField, now: number): void {
    const frameMs = this.#laidAt ? now - this.#laidAt : 0; this.#laidAt = now;
    if (!this.#touching()) { this.#pushed = null; return; }
    const hand = this.#hand, from = this.#wakeFrom;
    if (hand && from) {
      // A move older than a break (the page was hidden, the card lost its context, motion was reduced, between the move and this frame) is
      // the past: the wake starts again from where the hand is, never laid now as if it had just happened (Sol).
      const px = Math.hypot(hand.x - from.x, hand.y - from.y), amp = now - hand.at > WAKE_BREAK_MS ? 0 : wakeAmp(px, frameMs);
      if (amp > 0) field.addPath({ x0: from.x, y0: from.y, x1: hand.x, y1: hand.y, amp, width: WAKE_WIDTH }, now);
      this.#wakeFrom = { x: hand.x, y: hand.y };
    }
    const bar = document.querySelector<HTMLElement>('.splitter.active');
    if (!bar) { this.#pushed = null; return; }
    const r = bar.getBoundingClientRect(), upright = r.height >= r.width, mid = upright ? r.left + r.width / 2 : r.top + r.height / 2;
    const moved = this.#pushed?.node === bar ? mid - this.#pushed.mid : 0, amp = pushAmp(Math.abs(moved), frameMs);
    // The water it pushes is the water before it (the splitter itself is a wall, which would keep most of a wave laid inside it).
    const at = mid + Math.sign(moved) * (PUSH_WIDTH + (upright ? r.width : r.height) / 2);
    if (amp > 0) field.add(upright ? { x: at, y: r.top, x2: at, y2: r.bottom, amp, width: PUSH_WIDTH, side: 2 } : { x: r.left, y: at, x2: r.right, y2: at, amp, width: PUSH_WIDTH, side: 2 }, now);
    this.#pushed = { node: bar, mid };
  }

  /** The context, with its programs started (built beside the page, gl-build.ts; `#finish` reads them once they are). */
  #ensureGl(): boolean {
    if (this.#broken) return false;
    if (this.#gl) return true;
    // No depth buffer: nothing here tests depth, and the card would keep one the page's size for nothing.
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, depth: false });
    if (!gl) { console.info('Glass: WebGL2 is not available here, so the page stays solid.'); return false; }
    // A context lost before its loss was announced throws here: the glass stays off until it is given back (`webglcontextrestored`
    // turns it on then, as `#wanted` says).
    let building: readonly [Building, Building];
    try { building = [startProgram(gl, VERT, FRAG), startProgram(gl, VERT, OVER)]; }
    catch (error) { console.info('Glass: the card is not drawing just now, so the page stays solid.', error); return false; }
    this.#gl = gl; this.#building = building;
    this.#field = WaveField.create(gl);
    if (!this.#field) console.info('Glass: this card cannot run the waves, so the glass takes the sparks\' light.');
    return true;
  }

  /**
   * The programs read once the card has built them, and the page's chrome turned to glass: true once the glass can draw, false while they
   * are still being built (looked at again on the next frame). A program that did not build turns the glass off and leaves the page solid;
   * waves that did not build leave the glass the sparks' light.
   */
  #finish(gl: WebGL2RenderingContext): boolean {
    if (this.#prog) return true;
    const building = this.#building; if (!building) return false;
    try { if (!built(gl, building)) return false; }
    catch (error) { console.info('Glass: the shader did not build, so the page stays solid.', error); this.#broken = true; this.#building = null; this.#switch(false); document.documentElement.dataset.material = 'solid'; return false; }
    try { if (this.#field && !this.#field.built()) return false; }
    catch (error) { this.#field = null; console.info('Glass: this card cannot run the waves, so the glass takes the sparks\' light.', error); }
    const [prog, over] = building;
    for (const [name, at] of uniforms(gl, prog.program, ['rect', 'size', 'dpr', 'now', 'cap', 'touchCap', 'tint', 'dark', 'n', 'spark', 'sparkC', 'buyC', 'sellC', 'touchC', 'waves', 'wavesPrev', 'waveCells', 'waveCssH', 'waveGain', 'hasWaves'])) this.#loc.set(name, at);
    for (const [name, at] of uniforms(gl, over.program, ['size', 'dpr', 'dark', 'buyC', 'sellC', 'touchC', 'waves', 'wavesPrev', 'waveCells', 'waveCssH', 'waveGain', 'hasWaves'])) this.#overLoc.set(name, at);
    this.#prog = prog.program; this.#over = over.program; this.#building = null;
    if (this.#on) document.documentElement.dataset.material = 'glass';
    return true;
  }

  #dpr(): number { return Math.min(pixelRatio(), 1.5); }

  #size(): void {
    const dpr = this.#dpr(), w = Math.max(1, Math.round(window.innerWidth * dpr)), h = Math.max(1, Math.round(window.innerHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    if (this.#field && (this.#field.cols !== Math.max(4, Math.ceil(window.innerWidth / CELL)) || this.#field.rows !== Math.max(4, Math.ceil(window.innerHeight / CELL)))) { this.#field.resize(window.innerWidth, window.innerHeight); this.#mediumKey = ''; }
  }

  /** Where each piece of glass is now (window CSS px); hidden ones and empty ones are left out. */
  #measure(): Surface[] {
    const out: Surface[] = [];
    for (const [selector, kind, medium] of SURFACES) for (const node of document.querySelectorAll<HTMLElement>(selector)) {
      if (out.length >= MAX_RECTS) break;
      const r = node.getBoundingClientRect();
      if (r.width >= 1 && r.height >= 1) out.push({ x: r.left, y: r.top, w: r.width, h: r.height, kind, medium, node });
    }
    return out;
  }

  #layoutKey(): string { return this.#measure().map(r => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`).join(';'); }

  #draw(now: number): void {
    const gl = this.#gl, p = this.#palette; if (!gl || !p) return;
    if (!this.#finish(gl)) { if (this.#building) this.schedule(); return; }
    const prog = this.#prog!;
    this.#size();
    this.#surfaces = this.#measure();
    this.#key = this.#surfaces.map(r => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`).join(';');
    // A panel or menu over a bar is solid: the bar's controls sit above this canvas and would show through it.
    const bars = this.#surfaces.filter(r => r.kind === 'bar');
    for (const r of this.#surfaces) if (r.kind === 'panel') {
      const over = bars.some(b => r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + b.h && r.y + r.h > b.y);
      if (r.node.classList.contains('glass-over') !== over) r.node.classList.toggle('glass-over', over);
    }
    this.#sparks = this.#sparks.filter(s => now - s.at < LIFE_MS);
    if (!this.#sparks.length) this.#base = now;
    // The waves: their medium drawn again when the chrome moved, then stepped to now.
    const field = this.#field;
    if (field) this.#layHand(field, now);
    const waving = field?.alive(now) ?? false;
    if (field) {
      if (this.#key !== this.#mediumKey) { field.setMedium(this.#surfaces.map((r): WaveRegion => ({ x: r.x, y: r.y, w: r.w, h: r.h, kind: r.medium }))); this.#mediumKey = this.#key; }
      field.step(now);
    }
    const W = this.canvas.width, H = this.canvas.height, dpr = this.#dpr(), u = (n: string): WebGLUniformLocation | null => this.#loc.get(n) ?? null;
    const buyC = rgb(p.bid), sellC = rgb(p.ask), touchC = rgb(p.ui);
    gl.viewport(0, 0, W, H); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const bindWaves = (loc: Map<string, WebGLUniformLocation | null>): void => {
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, field ? field.texture : null);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, field ? field.previous : null); gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(loc.get('waves') ?? null, 3); gl.uniform1i(loc.get('wavesPrev') ?? null, 4); gl.uniform1i(loc.get('hasWaves') ?? null, waving ? 1 : 0);
      gl.uniform2f(loc.get('waveCells') ?? null, field?.cols ?? 1, field?.rows ?? 1); gl.uniform1f(loc.get('waveCssH') ?? null, window.innerHeight);
      gl.uniform1f(loc.get('waveGain') ?? null, this.#gain);
      gl.uniform3fv(loc.get('buyC') ?? null, buyC); gl.uniform3fv(loc.get('sellC') ?? null, sellC); gl.uniform3fv(loc.get('touchC') ?? null, touchC);
    };
    // The open screen first, the whole of it, while waves run; the glass is drawn over it where the chrome is.
    if (waving && this.#over) {
      const o = this.#overLoc;
      gl.useProgram(this.#over);
      gl.uniform2f(o.get('size') ?? null, W, H); gl.uniform1f(o.get('dpr') ?? null, dpr); gl.uniform1i(o.get('dark') ?? null, p.dark ? 1 : 0);
      bindWaves(o);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.useProgram(prog);
    bindWaves(this.#loc);
    gl.uniform2f(u('size'), W, H); gl.uniform1f(u('dpr'), dpr); gl.uniform1f(u('now'), now - this.#base); gl.uniform1i(u('dark'), p.dark ? 1 : 0);
    gl.uniform1f(u('cap'), p.dark ? 0.12 : 0.1); gl.uniform1f(u('touchCap'), p.dark ? 0.42 : 0.3);
    const sp = new Float32Array(MAX_SPARKS * 4), sc = new Float32Array(MAX_SPARKS * 4);
    this.#sparks.forEach((s, i) => { sp.set([s.x, s.y, s.at - this.#base, s.s], i * 4); sc.set([s.c[0], s.c[1], s.c[2], s.ghost ? 1 : 0], i * 4); });
    gl.uniform1i(u('n'), this.#sparks.length); gl.uniform4fv(u('spark'), sp); gl.uniform4fv(u('sparkC'), sc);
    const face = rgb(chromeFor(p).face), panel = rgb(p.panel);
    gl.enable(gl.SCISSOR_TEST);
    for (const r of this.#surfaces) {
      const x0 = Math.max(0, Math.floor(r.x * dpr)), x1 = Math.min(W, Math.ceil((r.x + r.w) * dpr)), y0 = Math.max(0, Math.floor(r.y * dpr)), y1 = Math.min(H, Math.ceil((r.y + r.h) * dpr));
      if (x1 <= x0 || y1 <= y0) continue;
      gl.scissor(x0, H - y1, x1 - x0, y1 - y0);
      gl.uniform4f(u('rect'), r.x, r.y, r.w, r.h);
      gl.uniform3fv(u('tint'), r.kind === 'panel' ? panel : face);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.SCISSOR_TEST);
  }
}
