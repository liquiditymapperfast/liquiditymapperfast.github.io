import { el } from './dom.ts';
import { compactBar, onLayoutMode } from './device.ts';
import { scrimFor } from './sheet.ts';
import { EDGE, anchorBox, besideBox, chooseSide, placeOn, type Box, type Side } from './placement.ts';
import { makeDraggable } from './drag.ts';
import { t } from './i18n.ts';
import { sizeText, takeSize, type SizeRule, type SizeWhy } from './sizes.ts';

/**
 * One panel for every settings popover (bar stats, highlights, sounds, ...): a header, optional sticky tools, a scrolling body, and
 * a small set of row builders so every control lines up the same way. Only one panel is open at a time. It opens on the side of its button
 * where it fits (`placement.ts`), and it can be dragged by its title bar (`drag.ts`): a panel that has been moved stays where it was put,
 * also when its contents change, and no longer closes when a press lands outside it (it closes on the x, Escape or its button).
 */
export interface PanelOptions {
  title: string;
  /** Width in px (the panel never exceeds the window). */
  width?: number;
  /** Which edge of the anchor the panel lines up with, or `edge`: against the window's right edge (`placeOn`). */
  align?: 'left' | 'right' | 'edge';
  onClose?: () => void;
  /** A press outside does not close it: a panel about what is on the map, kept open while the person works on the map (as a moved one is). */
  stays?: boolean;
  /**
   * The panel is made wider and taller by its lower corners (a window to read code in). The size it is given is kept in this browser under
   * this name for the next time it opens; a double click on a corner gives back the size it opens at. Not on a phone, where it is a sheet.
   */
  resizable?: string;
}
export interface Panel {
  readonly root: HTMLElement;
  /** Sticky strip under the header (presets, master switches). */
  readonly tools: HTMLElement;
  readonly body: HTMLElement;
  readonly anchor: HTMLElement;
  /** Replace the contents while keeping the scroll position. */
  render(build: (tools: HTMLElement, body: HTMLElement) => void): void;
  reposition(): void;
  /**
   * Place it beside `box` (in window pixels: what it is about, such as a selection on the chart) rather than by its button, until it is given
   * another box or none (`null`: by its button again). The box is taken once: the panel does not follow what it is about as that moves. A
   * panel the person has moved stays where they put it. It briefly lights up where it lands, so the eye finds it.
   */
  placeNear(box: Box | null): void;
  close(): void;
}

let current: Panel | null = null;
export const openedPanel = (): Panel | null => current;
export const closePanel = (): void => current?.close();

/** Where the sizes given to panels by their corners are kept, by the panel's name. */
const PANEL_SIZES_KEY = 'hlm-panel-sizes-v1';
/** The smallest a panel is made by its corners. */
const PANEL_MIN = { width: 320, height: 200 } as const;
type PanelSize = { width: number; height: number };

function readSizes(): Record<string, PanelSize> {
  try { const all: unknown = JSON.parse(window.localStorage.getItem(PANEL_SIZES_KEY) ?? '{}'); return all && typeof all === 'object' && !Array.isArray(all) ? all as Record<string, PanelSize> : {}; } catch { return {}; }
}
function readSize(name: string): PanelSize | null {
  const all = readSizes(), s = Object.hasOwn(all, name) ? all[name] : undefined;
  return s && typeof s === 'object' && Number.isFinite(s.width) && Number.isFinite(s.height) && s.width >= PANEL_MIN.width && s.height >= PANEL_MIN.height ? { width: s.width, height: s.height } : null;
}
function writeSize(name: string, size: PanelSize | null): void {
  const all = readSizes();
  if (size) all[name] = { width: Math.round(size.width), height: Math.round(size.height) }; else delete all[name];
  try { window.localStorage.setItem(PANEL_SIZES_KEY, JSON.stringify(all)); } catch { /* storage unavailable: kept for this visit */ }
}

/**
 * What a panel is placed by: its button, or where that button is folded away behind a pane header's settings key (pane-tune.ts: the Depth
 * pane's Edit... opened from the key's panel) the key; a button with no box would put the panel in the window's corner.
 */
function placedBy(anchor: HTMLElement): HTMLElement {
  if (anchor.getClientRects().length) return anchor;
  const key = anchor.closest('.pane-head')?.querySelector<HTMLElement>(':scope > .tune-btn');
  return key && key.getClientRects().length ? key : anchor;
}

export function openPanel(anchor: HTMLElement, options: PanelOptions, build: (tools: HTMLElement, body: HTMLElement) => void): Panel {
  current?.close();
  const closeButton = el('button', { class: 'panel-x', tip: t('Close (Esc)'), ariaLabel: t('Close'), type: 'button' });
  const head = el('div', { class: 'panel-head' }, el('h3', { textContent: options.title }), closeButton);
  const tools = el('div', { class: 'panel-tools' }), body = el('div', { class: 'panel-body' });
  const grips = options.resizable ? (['left', 'right'] as const).map(side => el('div', { class: `panel-grip ${side}`, tip: t('Drag to size the window; a double click gives back its size') })) : [];
  const root = el('div', { class: 'panel', role: 'dialog' }, head, tools, body, ...grips);
  root.setAttribute('aria-label', options.title);
  const width = options.width ?? 380;
  /** The size given by a corner (kept from an earlier visit), or none: the panel's width and its contents' height. */
  let sized = options.resizable ? readSize(options.resizable) : null;
  document.body.append(root);

  /**
   * The height its contents make it, with no limit on it. (Not `root.scrollHeight`: once a maximum height is set the body shrinks inside the
   * panel and the root reports the height it was cut to, so every later look would find that it fits.)
   */
  const natural = (): number => { const keep = root.style.maxHeight; root.style.maxHeight = 'none'; const height = root.offsetHeight; root.style.maxHeight = keep; return height; };
  /** The side of its button it opened on: chosen when it opens and when the window changes, not on every redraw, so ticking an option cannot make it jump across the button. */
  let side: Side | null = null;
  /** The box it is placed beside instead of its button (`placeNear`), or none. */
  let near: Box | null = null;
  const drag = makeDraggable(root, {
    grabs: target => head.contains(target) && !target.closest('button, a, input, select, textarea'),
    enabled: () => !compactBar(),
    size: () => ({ width: root.offsetWidth, need: natural() }),
  });

  const reposition = (rechoose = false): void => {
    // On a phone the stylesheet makes every panel a bottom sheet, so no inline position or size may be left behind to fight it.
    if (compactBar()) { drag.reset(); side = null; root.style.top = ''; root.style.left = ''; root.style.width = ''; root.style.height = ''; root.style.maxHeight = ''; root.classList.remove('sized'); return; }
    root.classList.toggle('sized', sized !== null);
    root.style.width = `${Math.min(sized?.width ?? width, window.innerWidth - 2 * EDGE)}px`;
    root.style.height = sized ? `${Math.min(sized.height, window.innerHeight - 2 * EDGE)}px` : '';
    if (drag.moved()) { drag.clamp(); return; }
    if (near) {
      const at = besideBox(near, natural(), root.offsetWidth, { width: window.innerWidth, height: window.innerHeight });
      root.style.maxHeight = `${at.maxHeight}px`; root.style.top = `${at.top}px`; root.style.left = `${at.left}px`;
      return;
    }
    // A button of a top-bar deck places its panel by the whole deck: under the button alone the panel hid the deck's other row of buttons.
    const a = placedBy(anchor).getBoundingClientRect(), deck = anchor.closest('fieldset.deck')?.getBoundingClientRect();
    const box = anchorBox({ left: a.left, top: a.top, right: a.right, bottom: a.bottom }, deck ? { left: deck.left, top: deck.top, right: deck.right, bottom: deck.bottom } : null);
    const need = natural(), view = { width: window.innerWidth, height: window.innerHeight };
    if (side === null || rechoose) side = chooseSide(box, need, view);
    const at = placeOn(side, box, need, root.offsetWidth, options.align ?? 'left', view);
    root.style.maxHeight = `${at.maxHeight}px`; root.style.top = `${at.top}px`; root.style.left = `${at.left}px`;
  };
  // On a phone the scrim closes the panel; elsewhere a press outside it does, unless it has been moved: then it is a window the person put somewhere.
  const onPointer = (event: PointerEvent): void => {
    if (compactBar() || drag.moved() || options.stays) return;
    const t = event.target as Node;
    // A menu opened from a control inside the panel (a dropdown) is part of it.
    if (!root.contains(t) && !anchor.contains(t) && !(t instanceof Element && t.closest('.menu'))) panel.close();
  };
  const scrim = scrimFor(root, 59, () => panel.close());
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    const dialog = document.querySelector('dialog[open]');
    if (dialog && !dialog.contains(root)) return;
    // A menu or a dropdown's list opened from a control inside the panel takes its own Escape first, and the panel stays (as the desktop's
    // dropdown did): this listener was added before the menu's, so it would run first and close both.
    if (document.querySelector('.menu')) return;
    event.preventDefault(); panel.close();
  };
  const onResize = (): void => { scrim.sync(); reposition(true); };
  const stopMode = onLayoutMode(onResize);
  const panel: Panel = {
    root, tools, body, anchor,
    render(next) {
      // A control that rebuilds the panel keeps the keyboard where it was when it carries a key of its own (`data-focus`): arrows through a
      // group of round buttons go on from the one just chosen.
      const keep = body.scrollTop, active = document.activeElement, focus = active instanceof HTMLElement && body.contains(active) ? active.dataset.focus : undefined;
      tools.replaceChildren(); body.replaceChildren(); next(tools, body);
      tools.hidden = tools.childElementCount === 0;
      reposition(); body.scrollTop = keep;
      if (focus) [...body.querySelectorAll<HTMLElement>('[data-focus]')].find(x => x.dataset.focus === focus)?.focus({ preventScroll: true });
    },
    reposition: () => reposition(),
    placeNear(box) {
      near = box; reposition(true);
      if (!box || compactBar() || drag.moved()) return;
      // Started again on every new place (a class left on would not run its animation a second time).
      root.classList.remove('arrive'); void root.offsetWidth; root.classList.add('arrive');
    },
    close() {
      if (current !== panel) return;
      current = null; root.remove(); scrim.remove(); anchor.classList.remove('open');
      document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize); stopMode();
      options.onClose?.();
    },
  };
  closeButton.onclick = () => panel.close();
  // A corner takes the panel's edge with it (the left one its left edge, the right one its right), and its foot; the panel stays where it is.
  for (const grip of grips) {
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0 || compactBar()) return;
      event.preventDefault(); event.stopPropagation();
      const r = root.getBoundingClientRect(), fromLeft = grip.classList.contains('left'), id = event.pointerId;
      const start = { x: event.clientX, y: event.clientY, left: r.left, top: r.top, width: r.width, height: r.height };
      let at = { x: start.x, y: start.y }, frame = 0, held = false;
      const apply = (): void => {
        frame = 0;
        if (!held) { held = true; drag.hold(); }
        const vw = window.innerWidth, vh = window.innerHeight, dx = at.x - start.x;
        const most = fromLeft ? start.left + start.width - EDGE : vw - EDGE - start.left, tallest = vh - start.top - EDGE;
        const w = Math.max(Math.min(PANEL_MIN.width, most), Math.min(most, start.width + (fromLeft ? -dx : dx)));
        const h = Math.max(Math.min(PANEL_MIN.height, tallest), Math.min(tallest, start.height + at.y - start.y));
        sized = { width: w, height: h };
        root.classList.add('sized');
        root.style.left = `${fromLeft ? start.left + start.width - w : start.left}px`; root.style.width = `${w}px`; root.style.height = `${h}px`; root.style.maxHeight = `${tallest}px`;
      };
      const move = (e: PointerEvent): void => { if (e.pointerId !== id) return; at = { x: e.clientX, y: e.clientY }; if (!frame) frame = requestAnimationFrame(apply); };
      const end = (e: PointerEvent): void => {
        if (e.pointerId !== id) return;
        if (frame) { cancelAnimationFrame(frame); apply(); }
        root.classList.remove('being-sized');
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
        try { grip.releasePointerCapture(id); } catch { /* never held */ }
        if (!held) return;
        if (sized && options.resizable) writeSize(options.resizable, { width: Math.max(PANEL_MIN.width, sized.width), height: Math.max(PANEL_MIN.height, sized.height) });
        drag.clamp();
      };
      root.classList.add('being-sized');
      try { grip.setPointerCapture(id); } catch { /* the size follows the window's events anyway */ }
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    });
    grip.addEventListener('dblclick', () => {
      if (!options.resizable) return;
      sized = null; writeSize(options.resizable, null); drag.reset(); reposition(true);
    });
  }
  current = panel; anchor.classList.add('open'); scrim.sync();
  panel.render(build);
  document.addEventListener('pointerdown', onPointer, true); document.addEventListener('keydown', onKey, true); window.addEventListener('resize', onResize);
  return panel;
}

/** Open the panel, or close it when this anchor's panel is already open. */
export function togglePanel(anchor: HTMLElement, options: PanelOptions, build: (tools: HTMLElement, body: HTMLElement) => void): Panel | null {
  if (current?.anchor === anchor) { current.close(); return null; }
  return openPanel(anchor, options, build);
}

// ---- row builders --------------------------------------------------------------------------------------------------

export const heading = (text: string): HTMLElement => el('h4', { textContent: text });
export const note = (text: string): HTMLElement => el('p', { class: 'panel-note', textContent: text });

/** A checkbox with a name and, below it, what it means. The whole row is the click target. */
export function checkRow(name: string, description: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
  const box = el('input', { type: 'checkbox', checked }); box.onchange = () => onChange(box.checked);
  return el('label', { class: 'opt', tip: description }, box, el('span', { class: 'name', textContent: name }), el('span', { class: 'desc', textContent: description }));
}

/** An on/off switch with a name and description to its left. */
export function switchRow(name: string, description: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
  const box = el('input', { type: 'checkbox', checked }); box.onchange = () => onChange(box.checked);
  return el('label', { class: 'field', tip: description },
    el('span', { class: 'label' }, el('span', { class: 'name', textContent: name }), el('span', { class: 'desc', textContent: description })),
    el('span', { class: 'switch' }, box, el('i')));
}

export function rangeRow(name: string, description: string, o: { min: number; max: number; step: number; value: number; format?: (value: number) => string }, onInput: (value: number) => void): HTMLElement {
  const format = o.format ?? String;
  const out = el('output', { textContent: format(o.value) });
  const input = el('input', { type: 'range', min: String(o.min), max: String(o.max), step: String(o.step), value: String(o.value) });
  input.oninput = () => { const v = Number(input.value); out.textContent = format(v); onInput(v); };
  return el('label', { class: 'field', tip: description },
    el('span', { class: 'label' }, el('span', { class: 'name', textContent: name }), el('span', { class: 'desc', textContent: description })),
    el('span', { class: 'slider' }, input, out));
}

/** How much room a choice's words need beside a name: a letter counts one, a Chinese, Japanese or Korean character about two. */
const roomFor = (text: string): number => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) >= 0x2e80 ? 2 : 1), 0);

export function selectRow(name: string, description: string, options: readonly [value: string, label: string][], value: string, onChange: (value: string) => void): HTMLElement {
  const select = el('select');
  for (const [v, label] of options) select.append(new Option(label, v));
  select.value = value; select.onchange = () => onChange(select.value);
  // Its key for the keyboard (`data-focus`): a choice that rebuilds the panel leaves the focus on the new select in its place, whether the
  // choice was made with the arrows or in the dropdown's list (menu.ts gives it back there after a choice).
  select.dataset.focus = `select:${name}`;
  // A long choice ("Aggregated: every market switched on") does not fit the 150 px select beside the name: the select takes a line of its own under it (pin-field).
  const row = el('label', { class: 'field', tip: description },
    el('span', { class: 'label' }, el('span', { class: 'name', textContent: name }), el('span', { class: 'desc', textContent: description })), select);
  if (options.some(([, label]) => roomFor(label) > 18)) row.classList.add('pin-field');
  return row;
}

export function numberRow(name: string, description: string, o: { min: number; step: number; value: number; max?: number }, onChange: (value: number) => void): HTMLElement {
  const input = el('input', { type: 'number', min: String(o.min), step: String(o.step), value: String(o.value) });
  if (o.max !== undefined) input.max = String(o.max);
  input.onchange = () => { const v = Number(input.value); if (Number.isFinite(v)) onChange(Math.min(o.max ?? Infinity, Math.max(o.min, v))); };
  return el('label', { class: 'field', tip: description },
    el('span', { class: 'label' }, el('span', { class: 'name', textContent: name }), el('span', { class: 'desc', textContent: description })), input);
}

/**
 * How a size box is set up: the sign that says which side of the size counts (`<` what is under it, `≥` it and over, `≤` it and under), the
 * value (the coin's own USD), the common sizes for its menu, and what it may be (`SizeRule`). `hint` says why a value under `min` was not
 * taken; `none` is the word for 0 when the size may be off.
 */
export interface SizeOptions extends Omit<SizeRule, 'none'> { sign: '<' | '≥' | '≤'; value: number; presets: readonly number[]; hint?: string; none?: string }

/**
 * A size box: the sign, the value written out, and the common sizes in a menu beside it (a native one: a phone shows its own picker). It takes
 * `100k`, `2.5M`, `1,5M`, `$250,000` (`parseSize`); what it does with a size it may not hold is `takeSize`. `say` shows why a value was not
 * taken as typed (null: clear it); without one, the box reports it as the browser reports a field it will not take. `set` writes a value
 * changed elsewhere into the box.
 */
export function sizeControl(name: string, o: SizeOptions, onChange: (usd: number) => void, say?: (why: string | null, value: number) => void): { root: HTMLElement; set: (usd: number) => void } {
  const text = (v: number): string => v === 0 && o.none ? o.none : `$${sizeText(v)}`;
  let current = o.value;
  const input = el('input', { type: 'text', class: 'size-value', value: text(current), ariaLabel: name });
  input.setAttribute('inputmode', 'decimal'); input.spellcheck = false; input.autocomplete = 'off';
  const menu = el('select', { class: 'size-menu', ariaLabel: t('Common sizes'), tip: t('Common sizes') });
  menu.append(new Option('', ''));      // nothing chosen: the menu shows only its arrow
  if (o.none) menu.append(new Option(o.none, '0'));
  for (const p of o.presets) menu.append(new Option(text(p), String(p)));
  const tell = say ?? ((why: string | null): void => { input.setCustomValidity(why ?? ''); if (why) input.reportValidity(); });
  const whyText = (why: SizeWhy | null): string | null => why === null ? null : why === 'bad' ? t('Not a size: write it as 100k, 2.5M or 250000.')
    : why === 'high' ? t('Up to {max}.', { max: text(o.max!) }) : o.hint ?? t('From {min}.', { min: text(o.min) });
  const commit = (v: number, why: SizeWhy | null): void => {
    input.value = text(v); tell(whyText(why), v);
    if (v !== current) { current = v; onChange(v); }
  };
  input.oninput = () => { if (!say) input.setCustomValidity(''); };
  input.onchange = () => { const taken = takeSize(input.value, current, { ...o, none: !!o.none }, o.none); commit(taken.value, taken.why); };
  menu.onchange = () => { const v = Number(menu.value), picked = menu.value !== ''; menu.value = ''; if (picked && Number.isFinite(v)) commit(v, null); };
  const root = el('span', { class: 'size-ctl' }, el('span', { class: 'size-sign', textContent: o.sign }), input, menu);
  return { root, set: v => { if (v !== current || document.activeElement !== input) { current = v; input.value = text(v); } } };
}

/**
 * Why a size row last refused or held a value, kept for a few seconds by the row's name and description: the change it made redraws the
 * panel (each setting's panel is built again from the store), and the reason must still be there to read.
 */
const sizeSaid = new Map<string, { why: string; value: number; until: number }>();
const SAID_MS = 10_000;

/** A settings row holding a size box (see `sizeControl`), with why a value was not taken said under the description. */
export function sizeRow(name: string, description: string, o: SizeOptions, onChange: (usd: number) => void): HTMLElement {
  const key = `${name}|${description}`, kept = sizeSaid.get(key), now = Date.now();
  const said = el('span', { class: 'desc size-hint', hidden: true });
  const show = (why: string | null): void => { said.textContent = why ?? ''; said.hidden = !why; };
  // Only while the box still holds the value the reason was given for: the other size of a pair can move this one.
  if (kept && kept.until > now && kept.value === o.value) show(kept.why); else sizeSaid.delete(key);
  const control = sizeControl(name, o, onChange, (why, value) => { if (why) sizeSaid.set(key, { why, value, until: Date.now() + SAID_MS }); else sizeSaid.delete(key); show(why); });
  return el('label', { class: 'field size-field', tip: description },
    el('span', { class: 'label' }, el('span', { class: 'name', textContent: name }), el('span', { class: 'desc', textContent: description }), said), control.root);
}

/** A row of mutually exclusive choices. */
export function segmented(options: readonly [value: string, label: string][], value: string, onChange: (value: string) => void): HTMLElement {
  const group = el('div', { class: 'seg' });
  for (const [v, label] of options) group.append(el('button', { type: 'button', textContent: label, class: v === value ? 'on' : '', onclick: () => onChange(v) }));
  return group;
}

export const button = (label: string, onclick: () => void, title = '', cls = ''): HTMLButtonElement => el('button', { type: 'button', textContent: label, tip: title, onclick, class: cls });

// ---- reorderable list ----------------------------------------------------------------------------------------------

export interface SortItem { id: string; label: string; title?: string }

/**
 * A short list the user can reorder: drag a row by its grip (the other rows slide out of the way), or focus the grip and press
 * the up / down arrow keys. The number on each row is its position. `x` hides a row.
 */
export function sortableList(items: readonly SortItem[], onReorder: (ids: string[]) => void, onRemove: (id: string) => void): HTMLElement {
  const list = el('div', { class: 'sortable', role: 'list' });
  const ids = items.map(item => item.id), last = items.length - 1;
  const commit = (from: number, to: number, refocus: string): void => {
    const next = [...ids]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved!);
    onReorder(next);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.sortable [data-id="${CSS.escape(refocus)}"] .grip`)?.focus());
  };
  items.forEach((item, index) => {
    const grip = el('button', { type: 'button', class: 'grip', tip: t('Drag to reorder, or press the up and down arrow keys') });
    grip.setAttribute('aria-label', t('Move {item}: drag, or press the up and down arrow keys', { item: item.label }));
    const remove = el('button', { type: 'button', class: 'x', tip: t('Hide {item}', { item: item.label }), onclick: () => onRemove(item.id) });
    remove.setAttribute('aria-label', t('Hide {item}', { item: item.label }));
    const row = el('div', { class: 'srow', tip: item.title ?? '', role: 'listitem' }, grip, el('span', { class: 'idx', textContent: String(index + 1) }), el('b', { textContent: item.label }), remove);
    row.dataset.id = item.id;
    grip.onkeydown = event => {
      if (event.key === 'ArrowUp' && index > 0) { event.preventDefault(); commit(index, index - 1, item.id); }
      else if (event.key === 'ArrowDown' && index < last) { event.preventDefault(); commit(index, index + 1, item.id); }
    };
    grip.onpointerdown = down => {
      if (down.button !== 0) return;
      down.preventDefault();
      const rows = [...list.children] as HTMLElement[], rects = rows.map(r => r.getBoundingClientRect()), h = rects[index]!.height + 3;
      const lowest = rects[0]!.top - rects[index]!.top, highest = rects[last]!.top - rects[index]!.top;
      let to = index;
      grip.setPointerCapture(down.pointerId); row.classList.add('dragging'); list.classList.add('sorting');
      const place = (y: number): void => {
        const dy = Math.min(Math.max(y - down.clientY, lowest), highest);
        row.style.transform = `translateY(${dy}px)`;
        const centre = rects[index]!.top + dy + rects[index]!.height / 2;
        to = index;
        for (let k = 0; k < rows.length; k++) {
          const mid = rects[k]!.top + rects[k]!.height / 2;
          if (k < index && centre < mid) { to = k; break; }
          if (k > index && centre > mid) to = k;
        }
        rows.forEach((other, k) => {
          if (k === index) return;
          const shift = index < to && k > index && k <= to ? -h : index > to && k < index && k >= to ? h : 0;
          other.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      };
      const finish = (commitMove: boolean): void => {
        grip.removeEventListener('pointermove', onMove); grip.removeEventListener('pointerup', onUp); grip.removeEventListener('pointercancel', onCancel);
        document.removeEventListener('keydown', onEscape, true);
        row.classList.remove('dragging'); list.classList.remove('sorting'); rows.forEach(r => { r.style.transform = ''; });
        if (commitMove && to !== index) commit(index, to, item.id);
      };
      const onMove = (event: PointerEvent): void => place(event.clientY);
      const onUp = (): void => finish(true);
      const onCancel = (): void => finish(false);
      const onEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); finish(false); } };
      grip.addEventListener('pointermove', onMove); grip.addEventListener('pointerup', onUp); grip.addEventListener('pointercancel', onCancel);
      document.addEventListener('keydown', onEscape, true);
    };
    list.append(row);
  });
  return list;
}
