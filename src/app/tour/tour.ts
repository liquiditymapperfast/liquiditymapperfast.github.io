import { el } from '../dom.ts';
import { t } from '../i18n.ts';
import { compactBar, isCoarse, isPhone, onLayoutMode } from '../device.ts';
import { showGuide } from '../help.ts';
import { closeMenus } from '../menu.ts';
import { closeSheet } from '../sheet.ts';
import { closePanel } from '../ui.ts';
import { grow, placeCard, visiblePart } from './place.ts';
import { findAll, rectOf } from './targets.ts';
import { stepsFor, type Arrangement } from './steps.ts';
import { record } from './record.ts';

/**
 * The tour: a modal over the page that lights one thing at a time and says in a sentence or two what it is for. Modal, so that the page under it
 * is inert (the keys, the wheel and the mouse do nothing to it) and Esc, Tab and the focus behave as in the guide; the light is a hole in a dim
 * layer that glides from one step to the next. It is loaded when it is first wanted (the Tour button, the invitation, the guide's link).
 * The steps are `steps.ts`, where a step's card goes `place.ts`, what is remembered `record.ts`.
 */
const PAD = 6, POLL_MS = 500;
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface TourOptions {
  /** Bring back what the tour needs on the screen (the top bar when it is folded away); returns how to put it back. */
  prepare?: () => () => void;
}

let state: 'idle' | 'starting' | 'running' = 'idle';

/**
 * Close what is open over the page (a panel, a menu, the guide, the settings sheet): the tour points at the page itself. Each is closed by its own
 * door, not by a key pressed for it: an Escape would reach the chart as well and cancel the drawing someone has begun, or unpin the Bar stats.
 */
function clearTheWay(): void {
  document.querySelector<HTMLElement>('dialog.guide .guide-x')?.click();
  closeSheet(); closePanel(); closeMenus();
}

export function startTour(options: TourOptions = {}): void {
  if (state !== 'idle') return;
  state = 'starting';
  let restore = (): void => {};
  try {
    clearTheWay();
    restore = options.prepare?.() ?? restore;
  } catch (error) { state = 'idle'; console.error('The tour could not be shown:', error); return; }
  // A top bar that was folded away takes a frame or two to be laid out again.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { begin(restore); } catch (error) { state = 'idle'; restore(); console.error('The tour could not be shown:', error); }
  }));
}

function begin(restore: () => void): void {
  // Once more: the guide, whose words were still being fetched when the tour was asked for, may have opened in these frames.
  clearTheWay();
  const arrangement: Arrangement = isPhone() ? 'phone' : compactBar() ? 'compact' : 'desktop';
  const steps = stepsFor(arrangement, isCoarse()).filter(step => !step.targets.length || rectOf(step.targets) !== null);
  if (!steps.length) { state = 'idle'; restore(); return; }
  let index = 0, signature = '', frame = 0;

  const hole = el('div', { class: 'tour-hole' });
  const count = el('span', { class: 'tour-count' }), dots = el('ol', { class: 'tour-dots' });
  dots.setAttribute('aria-hidden', 'true');
  const title = el('h2', { class: 'tour-title', id: 'tour-title' }), body = el('p', { class: 'tour-body', id: 'tour-body' });
  const skip = el('button', { type: 'button', class: 'tour-skip', textContent: t('Skip the tour'), onclick: () => end('left') });
  const guide = el('button', { type: 'button', class: 'tour-guide', textContent: t('Open the Guide'), onclick: () => { end('done'); showGuide(); } });
  const back = el('button', { type: 'button', class: 'tour-back', textContent: t('Back'), onclick: () => go(-1) });
  const next = el('button', { type: 'button', class: 'tour-next', onclick: () => { if (index === steps.length - 1) end('done'); else go(1); } });
  const words = el('div', {}, title, body);
  words.setAttribute('aria-live', 'polite');
  const card = el('div', { class: 'tour-card' }, el('div', { class: 'tour-top' }, count, dots), words,
    el('div', { class: 'tour-actions' }, el('span', { class: 'tour-side' }, skip, guide), el('span', { class: 'tour-nav' }, back, next)));
  const dialog = el('dialog', { class: 'tour', ariaLabel: t('Tour') }, hole, card);
  dialog.setAttribute('aria-labelledby', 'tour-title'); dialog.setAttribute('aria-describedby', 'tour-body');

  /** What the card says at the step shown. */
  function render(): void {
    const step = steps[index]!, last = index === steps.length - 1;
    count.textContent = t('{n} of {total}', { n: index + 1, total: steps.length });
    const tab = findAll(step.targets).some(node => node.classList.contains('edge-tab'));
    title.textContent = step.title(); body.textContent = step.body(tab);
    dots.replaceChildren(...steps.map((_, i) => el('li', { class: i === index ? 'on' : i < index ? 'past' : '' })));
    back.hidden = index === 0; next.textContent = last ? t('Done') : t('Next');
    guide.hidden = !step.guide; skip.hidden = last && step.guide === true;
  }

  /** The light and the card at the step shown, for where its target is now; nothing is written when neither has moved. */
  function place(): void {
    const step = steps[index]!, rect = step.targets.length ? rectOf(step.targets) : null;
    const view = { w: innerWidth, h: innerHeight }, lit = rect ? visiblePart(grow(rect, PAD), view) : null;
    const size = { w: card.offsetWidth, h: card.offsetHeight };
    const signed = [lit ? `${lit.x},${lit.y},${lit.w},${lit.h}` : 'none', size.w, size.h, view.w, view.h].join('|');
    if (signed === signature) return;
    signature = signed;
    const at = placeCard(lit, size, view, step.side);
    card.style.left = `${at.x}px`; card.style.top = `${at.y}px`;
    // A step with nothing to point at is a hole of no size: the whole window dims, the card in the middle.
    if (lit) Object.assign(hole.style, { left: `${lit.x}px`, top: `${lit.y}px`, width: `${lit.w}px`, height: `${lit.h}px` });
    else Object.assign(hole.style, { left: '50%', top: '38%', width: '0px', height: '0px' });
  }
  const relayout = (): void => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); }); };

  function show(): void {
    const step = steps[index]!;
    // A target the window does not show all of (a tab in a row that scrolls) is brought into view first.
    for (const node of findAll(step.targets)) { const r = node.getBoundingClientRect(); if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) node.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    render(); signature = ''; place();
    next.focus({ preventScroll: true });
  }

  /** To the next step in `dir` whose target is on the screen; past the last one the tour is done. */
  function go(dir: 1 | -1): void {
    for (let i = index + dir; i >= 0 && i < steps.length; i += dir) {
      if (!steps[i]!.targets.length || rectOf(steps[i]!.targets)) { index = i; show(); return; }
    }
    if (dir === 1) end('done');
  }

  // What the tour keeps running while it is up (a timer, two listeners): set once it is showing, and all of it taken down by `dispose`.
  let poll = 0, stopMode: () => void = () => {}, over = false;
  dialog.addEventListener('cancel', event => { event.preventDefault(); end('left'); });
  dialog.addEventListener('keydown', event => {
    // Esc leaves the tour (the dialog's own `cancel`) and goes no further: the page's other Esc listeners unpin the Bar stats and put a drawing tool away.
    if (event.key === 'Escape') { event.stopPropagation(); return; }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    // Tab goes round the card's buttons (a modal's own order would leave the page for the browser's controls after the last).
    if (event.key === 'Tab') {
      const stops = [...card.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.hidden), first = stops[0], last = stops[stops.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); if (index < steps.length - 1) go(1); }
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); if (index > 0) go(-1); }
  });

  /** Take this tour down: its timer, its listeners, its dialog. Once, whichever way it ends or fails to begin. */
  function dispose(): void {
    if (over) return;
    over = true;
    window.clearInterval(poll); window.removeEventListener('resize', relayout); if (frame) cancelAnimationFrame(frame); stopMode();
    if (dialog.open) dialog.close();
    dialog.remove();
  }
  function end(how: 'done' | 'left'): void {
    if (over) return;
    dispose(); state = 'idle'; restore();
    // The focus goes back to what started the tour; where that is gone (the invitation, the Settings sheet) the Tour button takes it, or Settings where the Tour
    // button lives in the sheet (a compact bar), not the top of the page. (A bar that `restore` folds again is laid out a moment later: the toolbar then moves the
    // focus from the Tour button to the arrow that unfolds it, `setCollapsed`.)
    const held = document.activeElement;
    if (!held || held === document.body) [...document.querySelectorAll<HTMLElement>('.tour-btn, .more-btn, .bar-expand')].find(node => node.getClientRects().length > 0)?.focus({ preventScroll: true });
    record(how === 'done' ? 'done' : 'dismissed');
  }

  document.body.append(dialog);
  // The first step is placed where it stands: the glide is for the move from one step to the next.
  dialog.classList.add('settling');
  try {
    dialog.showModal();
    state = 'running';
    poll = window.setInterval(() => {
      const step = steps[index]!;
      if (step.targets.length && !rectOf(step.targets)) go(1); else place();
    }, POLL_MS);
    stopMode = onLayoutMode(() => end('left'));
    window.addEventListener('resize', relayout);
    show();
  } catch (error) { dispose(); throw error; }
  if (!reducedMotion()) requestAnimationFrame(() => requestAnimationFrame(() => dialog.classList.remove('settling'))); else dialog.classList.remove('settling');
}
