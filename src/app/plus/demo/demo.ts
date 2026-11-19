/**
 * The Plus demo: the chart, the history scrubber, the legend, six scenes that play once by themselves, and a levels control, on made-up
 * numbers labelled as such. It keeps its own store (`store.ts`), never the app's settings, and asks nothing of the network.
 *
 * `mountDemo(host, { control })` builds it into `host`. `control(host, store)` is the levels control to put beside the chart (the app's
 * own); without it the demo uses its built-in one (`control.ts`). Either reads and writes the demo's store only.
 *
 * Playing: the tour starts once, the first time the demo is at least 45 % in view, unless the browser asks for reduced motion; reduced
 * motion turned on while it plays by itself stops it (a tour the person started goes on, its motions instant). It pauses while the demo is
 * out of view or the tab is hidden and goes on when it is back, its motions held still meanwhile. Any use of the levels control or the history scrubber
 * stops it (a store change the tour did not make, or a press or key on the control); Play, Play again and the scene buttons drive it by hand.
 * The returned `pause()` stops it as the person's own pause would: it stays stopped until Play, Play again or a scene, and the first autoplay
 * is used up. `destroy()` stops every frame, observer and listener and takes the demo out of `host`.
 *
 * The chart is drawn again only when something it shows changed (a choice moving over 220 ms, none with reduced motion; the history
 * window; a new width).
 */
import { t } from '../../i18n.ts';
import { PLUS_NAME } from '../name.ts';
import { FREE_HH, HH, whenData, type DemoData } from './data.ts';
import { chartHeight, createChart } from './chart.ts';
import { builtInControl } from './control.ts';
import { DEMO_WIN, sameWeights, weightsOf, windowEnd, type Weights } from './model.ts';
import { Player, idleCaption, type SceneStep } from './scenes.ts';
import { createDemoStore, type DemoStore } from './store.ts';
import { add, dayLabel, sample, sv } from './svg.ts';

export type DemoControl = (host: HTMLElement, store: DemoStore) => { destroy(): void };
export interface DemoOptions { control?: DemoControl }
export interface DemoHandle { destroy(): void; pause(): void }

/** How long a change of choice takes on the chart. */
const TWEEN_MS = 220;
/** How long the history window takes to move to a scene chosen by hand (a transition: 180 to 240 ms, none with reduced motion). */
const GLIDE_MS = 240;
/** How much of the demo must be in view for the tour to play. */
const IN_VIEW = 0.45;
/** The scrubber's steps: a day each over the two Plus weeks before the free one. */
const DAYS = 14;

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.append(...children);
  return el;
}
const ICONS = { play: 'M8 5.5v13l10.5-6.5z', pause: 'M8.5 5.5v13M15.5 5.5v13', replay: 'M4.5 12a7.5 7.5 0 1 0 2.3-5.4M4.3 4.4v4.4h4.4' } as const;
function icon(name: keyof typeof ICONS): SVGSVGElement {
  const s = sv('svg', { viewBox: '0 0 24 24', class: `pd-ic pd-ic-${name}`, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  add(s, 'path', { d: ICONS[name], ...(name === 'play' ? { fill: 'currentColor' } : {}) });
  return s;
}

export function mountDemo(host: HTMLElement, opts: DemoOptions = {}): DemoHandle {
  const store = createDemoStore(), chart = createChart();
  /** The made-up numbers: here at once when an earlier mount built them, else a moment after the demo's frame has painted (`whenData`). */
  let data: DemoData | null = null;
  // One query, watched: reduced motion turned on while the demo plays stops what plays by itself (`onMotion`).
  const motionQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = (): boolean => motionQuery?.matches ?? false;
  const now = (): number => performance.now();

  // ---- the page
  const caption = node('p', 'pd-caption', idleCaption());
  caption.setAttribute('aria-live', 'polite');
  const chartBox = node('div', 'pd-chart', chart.svg);
  const win = node('span', 'pd-win');
  const track = node('div', 'pd-track', node('span', 'pd-part pd-part-plus', PLUS_NAME), node('span', 'pd-part pd-part-free', t('Free')), win);
  track.tabIndex = 0;
  track.setAttribute('role', 'slider'); track.setAttribute('aria-label', t('History'));
  track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(DAYS));
  const dates = node('div', 'pd-dates', node('span', '', dayLabel(0)), node('span', '', dayLabel(HH - FREE_HH)), node('span', '', t('Today')));
  dates.setAttribute('aria-hidden', 'true');
  const legend = node('div', 'pd-legend',
    node('span', '', sample('liq'), t('Liquidations')), node('span', '', sample('stops'), t('Stops')), node('span', '', sample('takes'), t('Take profits')));
  const stage = node('figure', 'pd-stage', node('div', 'pd-head', caption, node('span', 'pd-tag', t('Illustrative data'))), chartBox, node('div', 'pd-scrub', track, dates), legend);
  const playLabel = node('span', 'pd-lab');
  const playIcon = icon('play'), pauseIcon = icon('pause');
  const playBtn = node('button', 'pd-btn', playIcon, pauseIcon, playLabel);
  // Not the app's "Replay": that word names its market replay, which several languages translate as a mode (German "Wiedergabe").
  const replayBtn = node('button', 'pd-btn', icon('replay'), node('span', 'pd-lab', t('Play again')));
  replayBtn.setAttribute('aria-label', t('Play again'));
  const scenesBox = node('div', 'pd-scenes');
  scenesBox.setAttribute('role', 'group'); scenesBox.setAttribute('aria-label', t('Scenes'));
  const ctlHost = node('div', 'pd-ctl');
  // The root is the container its width is measured on (a container query never styles the container itself), the grid inside it.
  const root = node('section', 'pd', node('div', 'pd-in', node('div', 'pd-main', stage), node('div', 'pd-play', playBtn, replayBtn, scenesBox), node('div', 'pd-side', ctlHost)));
  root.setAttribute('aria-label', t('Interactive demo'));
  for (const b of [playBtn, replayBtn]) b.type = 'button';

  // ---- what is drawn: the choice moving to the store's, the history window moving to where it was sent. A motion the tour started
  // (`byTour`) is the tour's: it holds still while the tour is paused (`frozen`, the moment it stopped; its clock moves on by the pause when
  // the tour goes on) and is dropped when the person takes over. A motion the person started (a choice, a scene's button) always runs.
  interface Motion { t0: number; byTour: boolean; frozen: number | null }
  let target: Weights = weightsOf(store.get()), weights: Weights = { ...target };
  let tween: (Motion & { from: Weights }) | null = null;
  let scrub = 1, glide: (Motion & { from: number; to: number; ms: number }) | null = null;
  let raf = 0, dirty = true, destroyed = false;
  const live = (m: Motion | null): boolean => m !== null && m.frozen === null;
  const schedule = (): void => { if (!raf && !destroyed) raf = requestAnimationFrame(frame); };
  const aim = (to: Weights, byTour: boolean): void => {
    if (sameWeights(target, to)) return;
    target = to;
    if (reduced()) { weights = { ...to }; tween = null; dirty = true; } else tween = { from: { ...weights }, t0: now(), byTour, frozen: null };
    schedule();
  };
  const stepTween = (at: number): boolean => {
    if (!tween || tween.frozen !== null) return false;
    const f = Math.min(1, (at - tween.t0) / TWEEN_MS), e = 1 - (1 - f) ** 3, from = tween.from;
    weights = { liq: from.liq + (target.liq - from.liq) * e, stop: from.stop + (target.stop - from.stop) * e, tp: from.tp + (target.tp - from.tp) * e,
      grp: from.grp + (target.grp - from.grp) * e, alone: from.alone + (target.alone - from.alone) * e };
    if (f >= 1) tween = null;
    return true;
  };
  const syncScrub = (): void => {
    win.style.left = `${(scrub * 200 / 3).toFixed(3)}%`;
    const end = windowEnd(scrub);
    track.setAttribute('aria-valuenow', String(Math.round(scrub * DAYS)));
    track.setAttribute('aria-valuetext', end >= HH - 1.01 ? t('The last 7 days, free') : t('{start} to {end}, Plus', { start: dayLabel(end - DEMO_WIN), end: dayLabel(end) }));
  };
  const scrubTo = (v: number, ms: number, byTour = false): void => {
    v = clamp(v, 0, 1);
    if (!ms || reduced()) { glide = null; scrub = v; syncScrub(); dirty = true; }
    else glide = { from: scrub, to: v, t0: now(), ms, byTour, frozen: null };
    schedule();
  };
  const stepGlide = (at: number): boolean => {
    if (!glide || glide.frozen !== null) return false;
    const f = Math.min(1, (at - glide.t0) / glide.ms), e = f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2;
    scrub = glide.from + (glide.to - glide.from) * e;
    syncScrub();
    if (f >= 1) glide = null;
    return true;
  };
  const tourMotions = (): Motion[] => [tween, glide].filter((m): m is NonNullable<typeof m> => m !== null && m.byTour);
  /** The tour paused: its motions hold still where they are. */
  const hold = (): void => { const at = now(); for (const m of tourMotions()) if (m.frozen === null) m.frozen = at; };
  /** The tour goes on: its motions go on from where they stopped, their clocks moved on by the pause. */
  const release = (): void => { const at = now(); for (const m of tourMotions()) if (m.frozen !== null) { m.t0 += at - m.frozen; m.frozen = null; } schedule(); };
  /** The person took over: the tour's motions end (the window stays where the tour had moved it; a choice is never left half drawn). */
  const dropTourMotion = (): void => {
    if (glide?.byTour) glide = null;
    if (tween?.byTour) { weights = { ...target }; tween = null; dirty = true; }
  };
  /** Every motion at its end at once (reduced motion turned on). */
  const settle = (): void => {
    if (tween) { weights = { ...target }; tween = null; }
    if (glide) { scrub = glide.to; glide = null; syncScrub(); }
    dirty = true;
  };

  // ---- the caption and the tour
  const setCaption = (s: string): void => {
    if (caption.textContent === s) return;
    caption.textContent = s;
    caption.classList.remove('pd-swap');
    void caption.offsetWidth;
    caption.classList.add('pd-swap');
  };
  // Whose store change is under way: the tour's while it plays (`animate`), the person's when a scene's button applies one at once.
  let applying: '' | 'tour' | 'hand' = '';
  const player = new Player({
    apply(step: SceneStep, animate: boolean) {
      if (step.set) { applying = animate ? 'tour' : 'hand'; try { store.set(step.set); } finally { applying = ''; } }
      if (step.scrub !== undefined) scrubTo(step.scrub, 0, animate);
      if (step.scrubTo !== undefined) scrubTo(step.scrubTo, animate ? step.over ?? GLIDE_MS : GLIDE_MS, animate);
      if (step.caption) setCaption(step.caption());
    },
    idle() { setCaption(idleCaption()); },
  });
  let autoplayed = false, inView = false;
  /** Who set the tour going: the demo by itself (the autoplay) or the person (Play, Play again). */
  let startedBy: '' | 'auto' | 'person' = '';
  const sceneBtns = player.scenes.map((s, i) => {
    const bar = node('b', '');
    const b = node('button', 'pd-scene', node('i', '', bar), node('span', '', s.label()));
    b.type = 'button';
    b.setAttribute('aria-label', t('Scene {n}: {name}', { n: i + 1, name: s.label() }));
    b.addEventListener('click', () => { autoplayed = true; queued = false; dropTourMotion(); player.jump(i); syncPlay(); schedule(); });
    scenesBox.append(b);
    return { b, bar, width: '', current: false };
  });
  /** Play or Play again pressed before the numbers are here: the button shows Pause at once, and the tour starts at its first scene when
   * they arrive. Pause, a scene's button, the person's other use, pause() or destroy() in between cancels it. */
  let queued = false;
  let shownRunning: boolean | null = null, tourRunning = false;
  const syncPlay = (): void => {
    const running = player.running;
    // The tour's own motions follow it: still while it is paused (not at its end, where what is left may finish), on again with it.
    if (running !== tourRunning) { tourRunning = running; if (running) release(); else if (player.pausedBy !== 'end') hold(); }
    const shown = running || queued;
    if (shown !== shownRunning) {
      shownRunning = shown;
      playIcon.style.display = shown ? 'none' : '';
      pauseIcon.style.display = shown ? '' : 'none';
      const words = shown ? t('Pause') : t('Play');
      playLabel.textContent = words;
      playBtn.setAttribute('aria-label', words);
    }
    const cur = player.current();
    sceneBtns.forEach((s, i) => {
      const width = `${(player.progress(i) * 100).toFixed(1)}%`;
      if (width !== s.width) { s.width = width; s.bar.style.width = width; }
      if ((i === cur) !== s.current) { s.current = i === cur; if (s.current) s.b.setAttribute('aria-current', 'step'); else s.b.removeAttribute('aria-current'); }
    });
  };
  /** The person used the controls (`fromControls`, the caption goes back to its invitation) or the history: the tour stops, and one that
   * has not played yet never starts by itself over their choice. */
  const interrupt = (fromControls: boolean): void => {
    autoplayed = true;
    queued = false;
    player.interrupt();
    dropTourMotion();
    if (fromControls) setCaption(idleCaption());
    syncPlay(); schedule();
  };
  playBtn.addEventListener('click', () => {
    autoplayed = true;
    if (player.running || queued) { queued = false; player.pause('user'); }
    else { startedBy = 'person'; if (data) player.resume(now()); else queued = true; }
    syncPlay(); schedule();
  });
  replayBtn.addEventListener('click', () => { autoplayed = true; startedBy = 'person'; if (data) player.start(now()); else queued = true; syncPlay(); schedule(); });

  // ---- frames: only while something moves or the tour plays
  function frame(at: number): void {
    raf = 0;
    if (destroyed) return;
    const moved = stepTween(at), glided = stepGlide(at);
    const was = player.running;
    player.tick(at);
    if (moved || glided) dirty = true;
    if (dirty && data && chart.layout) { chart.draw(data, weights, windowEnd(scrub)); dirty = false; }
    if (was || player.running) syncPlay();
    if (live(tween) || live(glide) || player.running) schedule();
  }

  // ---- the store: the chart follows it; a change the tour did not make is the person's, and stops the tour
  let settingUp = true;
  const unsubscribe = store.subscribe(s => { aim(weightsOf(s), applying === 'tour'); if (!applying && !settingUp) interrupt(true); });
  // What a control does to the store while it is being set up is not the person's doing.
  const control = (opts.control ?? builtInControl)(ctlHost, store);
  settingUp = false;
  ctlHost.addEventListener('pointerdown', () => interrupt(true));
  ctlHost.addEventListener('keydown', e => { if (e.key !== 'Tab' && e.key !== 'Shift' && e.key !== 'Escape') interrupt(true); });

  // ---- the history scrubber: a press, a drag or a key moves the window and stops the tour
  let drag: { grab: number; id: number } | null = null;
  const valueAt = (clientX: number, grab: number): number => { const r = track.getBoundingClientRect(), w = r.width / 3; return clamp((clientX - r.left - grab) / Math.max(1, r.width - w), 0, 1); };
  track.addEventListener('pointerdown', e => {
    interrupt(false);
    const r = track.getBoundingClientRect(), w = r.width / 3, left = r.left + scrub * (r.width - w);
    drag = { grab: e.clientX >= left && e.clientX <= left + w ? e.clientX - left : w / 2, id: e.pointerId };
    try { track.setPointerCapture(e.pointerId); } catch { /* the pointer is gone already */ }
    scrubTo(valueAt(e.clientX, drag.grab), 0);
    e.preventDefault();
  });
  track.addEventListener('pointermove', e => { if (drag && e.pointerId === drag.id) scrubTo(valueAt(e.clientX, drag.grab), 0); });
  const endDrag = (e: PointerEvent): void => { if (drag && e.pointerId === drag.id) drag = null; };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('keydown', e => {
    const day = 1 / DAYS, k = e.key;
    const v = k === 'ArrowLeft' || k === 'ArrowDown' ? scrub - day : k === 'ArrowRight' || k === 'ArrowUp' ? scrub + day
      : k === 'PageDown' ? scrub - 3 * day : k === 'PageUp' ? scrub + 3 * day : k === 'Home' ? 0 : k === 'End' ? 1 : null;
    if (v === null) return;
    e.preventDefault();
    interrupt(false);
    scrubTo(Math.round(clamp(v, 0, 1) * DAYS) / DAYS, 0);
  });

  // ---- size, view and the tab
  // The chart's room is kept from the first frame; the chart itself is laid out once the numbers are here (a quiet empty stage until then).
  const fit = (): void => {
    const w = chartBox.clientWidth;
    if (w < 60) return;
    chartBox.style.height = `${chartHeight(w)}px`;
    if (data && chart.resize(w)) { dirty = true; schedule(); }
  };
  const sizes = new ResizeObserver(fit);
  sizes.observe(chartBox);
  /** In view and the tab shown: autoplay once, or go on after a pause that was the view's; else pause for the view. */
  const consider = (): void => {
    if (inView && !document.hidden) {
      // The autoplay waits for the numbers: a tour over an empty stage would show nothing of its scenes.
      if (!autoplayed && !reduced()) { if (data) { autoplayed = true; startedBy = 'auto'; player.start(now()); } }
      // A tour that started by itself goes on only while motion is welcome; one the person started goes on regardless.
      else if (player.pausedBy === 'view' && (startedBy === 'person' || !reduced())) player.resume(now());
    } else player.pause('view');
    syncPlay(); schedule();
  };
  const views = new IntersectionObserver(entries => {
    const e = entries[entries.length - 1];
    if (!e) return;
    // A demo taller than the window counts as in view once it fills 45 % of the window.
    const room = e.rootBounds?.height ?? window.innerHeight;
    inView = e.isIntersecting && (e.intersectionRatio >= IN_VIEW || (room > 0 && e.intersectionRect.height >= IN_VIEW * room));
    consider();
  }, { threshold: [0, 0.25, IN_VIEW, 0.8, 1] });
  views.observe(root);
  const onVisibility = (): void => consider();
  document.addEventListener('visibilitychange', onVisibility);
  /** Reduced motion turned on: a tour that started by itself stops (and does not come back with the view), and what moves is at its end at once. */
  const onMotion = (): void => {
    if (!reduced()) return;
    if (startedBy !== 'person' && (player.running || player.pausedBy === 'view')) { player.interrupt(); dropTourMotion(); }
    settle();
    syncPlay(); schedule();
  };
  if (motionQuery) { if (typeof motionQuery.addEventListener === 'function') motionQuery.addEventListener('change', onMotion); else motionQuery.addListener(onMotion); }

  host.append(root);
  syncScrub(); syncPlay(); fit(); schedule();
  stage.setAttribute('aria-busy', 'true');
  const stopWaiting = whenData(d => {
    if (destroyed) return;
    data = d;
    stage.removeAttribute('aria-busy');
    fit(); dirty = true;
    // A Play or Play again pressed while loading starts the tour now, at its first scene: after the demo's own readiness above, so a store
    // listener that throws in that first scene still leaves this chart drawn. The start is followed at once (`syncPlay`), so a pause for
    // the view that `consider` applies right after (the tab hidden, the demo under 45 % in view) holds its first motion like any other; both
    // run even when that listener throws (the error goes on to `whenData`, which reports it), unless the listener destroyed the demo.
    try {
      if (queued) { queued = false; player.start(now()); }
    } finally {
      if (!destroyed) { syncPlay(); consider(); }
    }
  });

  return {
    // As the person's own pause: also a tour paused for the view stays paused when the demo comes back into view.
    pause() { autoplayed = true; queued = false; player.interrupt(); syncPlay(); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      sizes.disconnect(); views.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      stopWaiting();
      if (motionQuery) { if (typeof motionQuery.removeEventListener === 'function') motionQuery.removeEventListener('change', onMotion); else motionQuery.removeListener(onMotion); }
      unsubscribe();
      control.destroy();
      root.remove();
    },
  };
}
