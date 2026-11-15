/**
 * The frame-rate meter at the left end of the desktop status bar (2026-11-14, Karl: an LED panel of the page's frame rate; on hover what is
 * wrong, on a click how to make the page faster, with a report to copy for an AI assistant). It took over the red dot that said the browser
 * gave no WebGL2: the GPU lamp is that, everywhere the status bar is.
 *
 * It counts the browser's animation frames with its own requestAnimationFrame loop, only while the status bar shows (a desktop) and the tab
 * is shown. Its callback is well under 0.1 ms (25 µs measured, 88 µs under a trace) and each of its four draws a second 0.15 ms, with no
 * measurable effect on late frames on the live page (paired traces, Research_Files/fps_meter_20261114). On a page that would otherwise rest
 * it also keeps the browser making a frame on every beat of the screen: about 10-20 ms of main-thread time a second on a stripped page
 * (review r17). The digits are the frames of the last second, the bar the worst frame of the last quarter second (peak held, falling
 * back), the colour the frame rate against the screen's rate (`fps/model.ts`).
 */
import { el } from '../dom.ts';
import { setTip } from '../tip.ts';
import { t } from '../i18n.ts';
import { togglePanel, button, type Panel } from '../ui.ts';
import { toast } from '../toast.ts';
import { copyText } from '../clipboard.ts';
import { showGuide } from '../help.ts';
import { pixelRatio, sharpens } from '../pixel-ratio.ts';
import { layoutMode, onLayoutMode } from '../device.ts';
import type { Store } from '../store.ts';
import { FrameWindow, JUDGE_AFTER_S, hitchOf, nextLevel, toneOf, verdictOf, type FrameStats, type Tone } from './model.ts';
import { LED_H, LED_W, drawLed, ledSprites, type LedSprites, type LedTone } from './led.ts';
import { openPanels, pageAddress, speedReport, type Graphics, type SpeedInfo } from './report.ts';

/** How often the window is drawn again and the tip rewritten (ms). */
const DRAW_MS = 250;
/** An interval this long with the tab shown is a gap, not a frame (a sleep, a screen switched off, a debugger's pause): the count starts afresh (ms). */
const GAP_MS = 10_000;

/**
 * The screen the page is on, for its rate: its size and, where the browser says it (Chromium), its place among several. A zoom changes the
 * pixel ratio, not the screen: it makes the sprites again and keeps the rate (review r18: it read 60 again, and lost the rate it knew).
 */
const screenKey = (): string => { const s = window.screen as Screen & { availLeft?: number; availTop?: number }; return `${s.width}x${s.height}@${s.availLeft ?? 0},${s.availTop ?? 0}`; };
/** The pixel ratio the window is drawn at (the sprites' cap is 4). */
const ratioNow = (): number => Math.max(1, Math.min(4, pixelRatio()));

export class FpsMeter {
  readonly root = el('div', { class: 'fps-meter', role: 'button', tabIndex: 0 });
  #canvas = el('canvas', { ariaHidden: 'true' });
  #ctx = this.#canvas.getContext('2d')!;
  #sprites: LedSprites | null = null;
  /** Sprites by pixel ratio, two at most: the screen's, and a sharp picture's while one is taken. */
  #spriteSets = new Map<number, LedSprites>();
  #frames = new FrameWindow();
  #graphics: Graphics = 'webgl2';
  #raf = 0; #last = 0; #lastDraw = 0; #level = 0;
  #stats: FrameStats | null = null;
  #screen = ''; #ratio = 0;
  #panel: Panel | null = null;
  /** The panel's parts that follow the meter while it is open: its lines, and what helps with the state it was written for. */
  #live: { rate: HTMLElement; late: HTMLElement; helps: HTMLElement; key: string } | null = null;
  /** The tip last written (it is the meter's accessible description too), so a draw that changes nothing writes nothing. */
  #tip = '';

  constructor(private store: Store) {
    this.root.append(this.#canvas);
    this.root.setAttribute('aria-label', t('Frame rate'));
    this.root.setAttribute('aria-expanded', 'false');
    this.root.addEventListener('click', () => this.#toggle());
    this.root.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.#toggle(); } });
    document.addEventListener('visibilitychange', () => this.#sync());
    onLayoutMode(() => this.#sync());
    this.#size();
    this.#draw();
    this.#sync();
    // A sharp picture of the page (screenshot/capture.ts) sizes and draws the window at its ratio, then at the screen's again.
    sharpens({ resize: () => this.#size(), paint: () => this.#draw() });
  }

  /** How the map draws (`heatmap/canvas.ts`): the lamp is green with WebGL2, red without, amber where WebGL2 could not draw it. */
  setGraphics(graphics: Graphics): void { this.#graphics = graphics; this.#draw(); }

  /** Run the frame loop only where the meter is seen: a desktop's status bar, the tab shown. A loop that comes back starts its count afresh. */
  #sync(): void {
    const on = !document.hidden && layoutMode() === 'desktop';
    if (on && !this.#raf) {
      this.#restart(performance.now());
      this.#raf = requestAnimationFrame(now => this.#tick(now));
    } else if (!on && this.#raf) { cancelAnimationFrame(this.#raf); this.#raf = 0; }
  }

  /** Count afresh from `now` (a gap is not a frame). On another screen its rate is learned again; at another pixel ratio the sprites are made anew. */
  #restart(now: number): void {
    const screen = screenKey(), moved = screen !== this.#screen;
    this.#frames.restart(now, moved);
    if (moved) this.#screen = screen;
    if (ratioNow() !== this.#ratio) this.#size();
    this.#last = 0; this.#level = 0; this.#stats = null;
  }

  #tick(now: number): void {
    this.#raf = 0;
    if (this.#last && now - this.#last > GAP_MS) this.#restart(now);
    else if (this.#last) this.#frames.push(now, now - this.#last);
    this.#last = now;
    if (now - this.#lastDraw >= DRAW_MS) {
      this.#lastDraw = now;
      if (screenKey() !== this.#screen) this.#restart(now);
      else if (ratioNow() !== this.#ratio) this.#size();
      const stats = this.#frames.stats(now);
      this.#stats = stats;
      this.#level = nextLevel(this.#level, hitchOf(stats.worstQuarter, stats.hz));
      this.#draw();
    }
    if (!document.hidden && layoutMode() === 'desktop') this.#raf = requestAnimationFrame(next => this.#tick(next));
  }

  #size(): void {
    const ratio = this.#ratio = ratioNow();
    this.#canvas.width = Math.round(LED_W * ratio); this.#canvas.height = Math.round(LED_H * ratio);
    let sprites = this.#spriteSets.get(ratio);
    if (!sprites) {
      if (this.#spriteSets.size >= 2) this.#spriteSets.clear();
      this.#spriteSets.set(ratio, sprites = ledSprites(ratio));
    }
    this.#sprites = sprites;
  }

  #tone(): LedTone { const s = this.#stats; return s && s.fps !== null ? toneOf(s.fps, s.hz) : 'idle'; }

  #draw(): void {
    if (!this.#sprites) return;
    const s = this.#stats, tone = this.#tone();
    const lamp: LedTone = this.#graphics === 'webgl2' ? 'green' : this.#graphics === 'failed' ? 'amber' : 'red';
    drawLed(this.#ctx, this.#sprites, { text: s && s.fps !== null ? String(Math.min(999, s.fps)) : '---', tone, lamp, level: s && s.fps !== null ? this.#level : 0 });
    const tip = this.#tipText();
    if (tip !== this.#tip) { this.#tip = tip; setTip(this.root, tip); this.root.setAttribute('aria-description', tip); }
    const live = this.#live;
    if (!live) return;
    live.rate.textContent = s ? this.#rateText(s) : t('Measuring the frame rate…'); live.rate.dataset.tone = tone;
    live.late.textContent = s && s.fps !== null ? t('Late frames in the last minute: {n}', { n: s.lateMinute }) : '';
    // What helps follows the meter while the panel is open: written again when the verdict, the graphics or the look changes.
    const key = `${verdictOf(s)}|${this.#graphics}|${this.store.state.material}`;
    if (key !== live.key) { live.key = key; live.helps.replaceChildren(...this.#helps().map(text => el('li', { textContent: text }))); }
  }

  /**
   * What helps here: the graphics' own trouble whatever the frame rate, then by the verdict (`verdictOf`: the minute's average once 20 s
   * are seen; the page's first seconds, loading and building its charts, and a dip of a second, a theme change or the absorption's
   * once-a-minute judging, are not a slow page).
   */
  #helps(): string[] {
    const helps: string[] = [];
    if (this.#graphics === 'no-webgl2') helps.push(t('No graphics acceleration: this browser gives the page no WebGL2, so the page draws more slowly, and Live trades and the Glass look are off. Turn on graphics acceleration in the browser settings (in Chrome: Settings › System › Use graphics acceleration when available) and restart the browser. If it is already on, update the graphics driver.'));
    if (this.#graphics === 'failed') helps.push(t('WebGL2 is there but could not draw the map: update the graphics driver, then restart the browser.'));
    const verdict = verdictOf(this.#stats);
    if (verdict === 'struggling') {
      helps.push(t('On battery, the browser\'s energy saver and the system\'s power mode can hold the page to 30 frames a second: turn them off for the page, or plug in.'));
      if (this.store.state.material === 'glass') helps.push(t('Waves turns the panels to glass and draws them on every frame: switching it off is the lightest look.'));
      helps.push(t('Other tabs and programs that draw (video, games, other charts) share the graphics card: close the ones you do not need.'));
      helps.push(t('A screen set to a low refresh rate holds every page to it (30 Hz on some TVs and older cables): the rate is under Settings › System › Display › Advanced display in Windows, and System Settings › Displays on a Mac.'));
      helps.push(t('Each open panel draws as the market moves: close the ones you do not use.'));
    } else if (verdict === 'measuring') helps.push(t('Measuring: what would help follows after {n} seconds.', { n: JUDGE_AFTER_S }));
    else if (this.#graphics === 'webgl2') helps.push(t('The page runs smoothly here.'));
    return helps;
  }

  #rateText(s: FrameStats): string {
    if (s.fps === null) return t('Measuring the frame rate…');
    const tone: Tone = toneOf(s.fps, s.hz), vars = { fps: s.fps, hz: s.hz };
    return tone === 'green' ? t('{fps} frames a second on a {hz} Hz screen: smooth.', vars)
      : tone === 'amber' ? t('{fps} frames a second on a {hz} Hz screen: some frames come late.', vars)
        : t('{fps} frames a second on a {hz} Hz screen: the page is struggling.', vars);
  }

  #graphicsText(): string {
    return this.#graphics === 'webgl2' ? t('Graphics acceleration is on.')
      : this.#graphics === 'no-webgl2' ? t('No graphics acceleration: the map is drawn without it, more slowly.')
        : t('WebGL2 is there but could not draw the map.');
  }

  #tipText(): string {
    const s = this.#stats;
    return `${s ? this.#rateText(s) : t('Measuring the frame rate…')} ${this.#graphicsText()} ${t('Click for what makes the page faster.')}`;
  }

  #toggle(): void {
    this.#panel = togglePanel(this.root, { title: t('Frame rate'), width: 400, align: 'left', onClose: () => { this.#panel = null; this.#live = null; this.root.setAttribute('aria-expanded', 'false'); } }, (_tools, body) => this.#build(body));
    if (!this.#panel) this.#live = null;
    this.root.setAttribute('aria-expanded', String(!!this.#panel));
  }

  /** The panel: the rate now, the late frames, the graphics; what helps here (only what applies); the report to copy for an AI assistant; the Guide's section. */
  #build(body: HTMLElement): void {
    const rate = el('p', { class: 'fps-rate' }), late = el('p', { class: 'fps-late' }), helps = el('ul', { class: 'fps-helps' });
    this.#live = { rate, late, helps, key: '' };
    const gpu = this.#graphics === 'webgl2' ? `WebGL2${gpuName() ? ` · ${gpuName()}` : ''}` : t('2D canvas (no WebGL2)');
    // The lines are rewritten four times a second, so they are not announced as they change (no aria-live): a screen reader reads them when it gets there.
    body.append(rate, late, el('p', { class: 'fps-gpu', textContent: t('Graphics: {name}', { name: gpu }) }), helps);
    const copy = button(t('Copy for AI'), () => {
      void copyText(speedReport(this.#info())).then(ok => toast(ok ? t('Copied. Paste it into your AI assistant.') : t('This browser did not let the page copy.')));
    }, t('Copy a report of how this page runs, to paste into an AI assistant: the frame rate, your browser, system and graphics card, your screen and window sizes, processor threads and memory, the page\'s settings, and the steps to make it faster'));
    const guide = button(t('More in the guide →'), () => { showGuide('speed'); }, t('Every step in full, for each browser and system, in the Guide'));
    body.append(el('div', { class: 'layout-tools' }, copy, guide));
    this.#draw();
  }

  #info(): SpeedInfo {
    const state = this.store.state, s = this.#stats ?? this.#frames.stats(performance.now());
    const nav = navigator as Navigator & { deviceMemory?: number };
    return {
      stats: s, graphics: this.#graphics, gpu: gpuName(), userAgent: navigator.userAgent,
      screen: { w: window.screen.width, h: window.screen.height, ratio: pixelRatio() }, window: { w: window.innerWidth, h: window.innerHeight },
      cores: navigator.hardwareConcurrency || null, memoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      glass: state.material === 'glass', panels: openPanels(state.show), timeframe: state.timeframe,
      url: pageAddress(location.hostname, location.origin, location.pathname),
    };
  }
}

let gpuCache: string | null | undefined;
/** The graphics card as the browser names it (WebGL's unmasked renderer, else its renderer), read once from a context made and let go at once. */
function gpuName(): string | null {
  if (gpuCache !== undefined) return gpuCache;
  try {
    const c = document.createElement('canvas'), gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return (gpuCache = null);
    const ext = gl.getExtension('WEBGL_debug_renderer_info'), name: unknown = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return (gpuCache = typeof name === 'string' && name ? name : null);
  } catch { return (gpuCache = null); }
}
