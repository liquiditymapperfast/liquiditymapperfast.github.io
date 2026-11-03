import { el } from '../dom.ts';
import { t } from '../i18n.ts';

/**
 * The tour's moving picture of the right-button drag (Karl, 2026-11-03: "a feature that I use all the time ... a visual animation that teaches
 * the visitor how to perform that action"). A mouse with its right button held moves over the real chart, and the chart zooms as it does under a
 * real drag: right and back for time, up and back for price. The page lends the tour its chart (`setTourDemo`, from main.ts), so this folder
 * does not reach into the panes; whatever the picture did to the view is put back when its step is left.
 */
export interface Rect { x: number; y: number; w: number; h: number }
export interface DemoHooks {
  /** The chart's plot on the page, or null when it is not laid out. */
  plotRect(): Rect | null;
  /** The view a right-button drag pressed at `press` and now at `at` gives (plot pixels), from the view before the first call. */
  zoom(press: { x: number; y: number }, at: { x: number; y: number }): void;
  /** Put the view back as it was before the first `zoom`. */
  end(): void;
}
let hooks: DemoHooks | null = null;
/** The page's chart, for the picture to move. */
export function setTourDemo(next: DemoHooks): void { hooks = next; }
/** Whether a chart was lent: without one the step has nothing to show and is left out. */
export const demoReady = (): boolean => hooks !== null && hooks.plotRect() !== null;

/** One turn of the picture (ms): appear, press, right and back, up and back, let go, a rest. */
export const LOOP_MS = 7200;
type Leg = 'time' | 'price' | null;
export interface Pose { dx: number; dy: number; pressed: boolean; leg: Leg; opacity: number }

const ease = (u: number): number => u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
/** Where the hand is `ms` into the loop, as an offset from where it pressed; `reach` is how far it goes right and `rise` how far up (px). */
export function demoPose(ms: number, reach: number, rise: number): Pose {
  const at = ((ms % LOOP_MS) + LOOP_MS) % LOOP_MS;
  const span = (a: number, b: number): number => ease(Math.min(1, Math.max(0, (at - a) / (b - a))));
  const opacity = at < 400 ? at / 400 : at > 6600 ? Math.max(0, 1 - (at - 6600) / 400) : 1;
  const pressed = at >= 700 && at < 6100;
  // Right to 2.0 s, held, back by 3.3 s; up to 4.8 s, held, down by 6.1 s.
  const dx = reach * (span(800, 2000) - span(2300, 3300));
  const dy = -rise * (span(3600, 4800) - span(5100, 6100));
  const leg: Leg = !pressed ? null : at < 3450 ? (at >= 800 ? 'time' : null) : 'price';
  return { dx, dy, pressed, leg, opacity };
}

/** The mouse, its right button lit while held. */
function mouseSvg(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 28 40'); svg.setAttribute('width', '36'); svg.setAttribute('height', '52'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect x="1.5" y="1.5" width="25" height="37" rx="12.5" class="tour-mouse-body"/>'
    + '<path d="M14 1.5 V16" class="tour-mouse-line"/><path d="M1.5 16 H26.5" class="tour-mouse-line"/>'
    + '<path d="M14 1.5 A12.5 12.5 0 0 1 26.5 14 V16 H14 Z" class="tour-mouse-right"/>';
  return svg;
}

/**
 * Play the picture in `layer` (the tour's dialog) over the chart until the returned function is called, which also puts the view back. With reduced
 * motion the hand stands still where it would press, its button held, with the two ways to drag and what each zooms, and the view is not moved.
 */
export function playRightDrag(layer: HTMLElement, reduced: boolean): () => void {
  const lent = hooks;
  if (!lent) return () => {};
  const trail = el('div', { class: 'tour-drag-trail' });
  const word = el('span', { class: 'tour-drag-word' });
  const hand = el('div', { class: 'tour-drag-hand' }, mouseSvg() as unknown as HTMLElement);
  const still = el('div', { class: 'tour-drag-still' }, el('span', { class: 'tour-drag-arrow right', textContent: `→ ${t('Time')}` }), el('span', { class: 'tour-drag-arrow up', textContent: `↑ ${t('Price')}` }));
  const root = el('div', { class: 'tour-drag', ariaHidden: 'true' }, trail, hand, word, ...(reduced ? [still] : []));
  layer.append(root);
  let frame = 0, start = 0, lastZoom = 0, zoomed = false, stopped = false, last = { x: NaN, y: NaN };
  const step = (now: number): void => {
    if (stopped) return;
    frame = requestAnimationFrame(step);
    const plot = lent.plotRect(); if (!plot) { root.hidden = true; return; }
    root.hidden = false;
    // It presses a little left of and under the middle, so both legs stay on the chart.
    const press = { x: Math.round(plot.w * 0.42), y: Math.round(plot.h * 0.56) };
    const reach = Math.min(150, plot.w * 0.24), rise = Math.min(120, plot.h * 0.24);
    if (!start) start = now;
    const pose = reduced ? { dx: 0, dy: 0, pressed: true, leg: null, opacity: 1 } : demoPose(now - start, reach, rise);
    const x = press.x + pose.dx, y = press.y + pose.dy;
    root.style.opacity = String(pose.opacity);
    hand.style.transform = `translate(${plot.x + x - 18}px, ${plot.y + y - 8}px)`;
    hand.classList.toggle('pressed', pose.pressed);
    Object.assign(trail.style, { left: `${plot.x + Math.min(press.x, x)}px`, top: `${plot.y + Math.min(press.y, y)}px`, width: `${Math.abs(x - press.x)}px`, height: `${Math.abs(y - press.y)}px` });
    trail.className = `tour-drag-trail ${pose.leg ?? ''}`;
    word.textContent = pose.leg === 'time' ? `↔ ${t('Time')}` : pose.leg === 'price' ? `↕ ${t('Price')}` : '';
    word.style.transform = `translate(${plot.x + x + 24}px, ${plot.y + y + 22}px)`;
    if (reduced) { still.style.transform = `translate(${plot.x + press.x + 20}px, ${plot.y + press.y - 34}px)`; return; }
    // The chart follows the hand about thirty times a second: a redraw at every frame of a day-long map is more than it needs. Let go, the chart is
    // where the press began, even when the frames that brought the hand back were skipped (a tab hidden in the middle of a leg, Sol 2026-11-03).
    const target = pose.pressed ? { x, y } : press;
    if ((pose.pressed || zoomed) && (target.x !== last.x || target.y !== last.y) && now - lastZoom >= 33) { lent.zoom(press, target); zoomed = true; lastZoom = now; last = target; }
  };
  frame = requestAnimationFrame(step);
  return () => {
    if (stopped) return;
    stopped = true; cancelAnimationFrame(frame); root.remove();
    if (zoomed) lent.end();
  };
}
