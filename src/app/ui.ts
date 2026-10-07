import { el } from './dom.ts';
import { compactBar, onLayoutMode } from './device.ts';
import { scrimFor } from './sheet.ts';
import { EDGE, chooseSide, placeOn, type Side } from './placement.ts';
import { makeDraggable } from './drag.ts';
import { t } from './i18n.ts';

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
  /** Which edge of the anchor the panel lines up with. */
  align?: 'left' | 'right';
  onClose?: () => void;
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
  close(): void;
}

let current: Panel | null = null;
export const openedPanel = (): Panel | null => current;
export const closePanel = (): void => current?.close();

export function openPanel(anchor: HTMLElement, options: PanelOptions, build: (tools: HTMLElement, body: HTMLElement) => void): Panel {
  current?.close();
  const closeButton = el('button', { class: 'panel-x', tip: t('Close (Esc)'), ariaLabel: t('Close'), type: 'button' });
  const head = el('div', { class: 'panel-head' }, el('h3', { textContent: options.title }), closeButton);
  const tools = el('div', { class: 'panel-tools' }), body = el('div', { class: 'panel-body' });
  const root = el('div', { class: 'panel', role: 'dialog' }, head, tools, body);
  root.setAttribute('aria-label', options.title);
  const width = options.width ?? 380;
  document.body.append(root);

  /**
   * The height its contents make it, with no limit on it. (Not `root.scrollHeight`: once a maximum height is set the body shrinks inside the
   * panel and the root reports the height it was cut to, so every later look would find that it fits.)
   */
  const natural = (): number => { const keep = root.style.maxHeight; root.style.maxHeight = 'none'; const height = root.offsetHeight; root.style.maxHeight = keep; return height; };
  /** The side of its button it opened on: chosen when it opens and when the window changes, not on every redraw, so ticking an option cannot make it jump across the button. */
  let side: Side | null = null;
  const drag = makeDraggable(root, {
    grabs: target => head.contains(target) && !target.closest('button, a, input, select, textarea'),
    enabled: () => !compactBar(),
    size: () => ({ width: root.offsetWidth, need: natural() }),
  });

  const reposition = (rechoose = false): void => {
    // On a phone the stylesheet makes every panel a bottom sheet, so no inline position or size may be left behind to fight it.
    if (compactBar()) { drag.reset(); side = null; root.style.top = ''; root.style.left = ''; root.style.width = ''; root.style.maxHeight = ''; return; }
    root.style.width = `${Math.min(width, window.innerWidth - 2 * EDGE)}px`;
    if (drag.moved()) { drag.clamp(); return; }
    const a = anchor.getBoundingClientRect(), box = { left: a.left, top: a.top, right: a.right, bottom: a.bottom };
    const need = natural(), view = { width: window.innerWidth, height: window.innerHeight };
    if (side === null || rechoose) side = chooseSide(box, need, view);
    const at = placeOn(side, box, need, root.offsetWidth, options.align ?? 'left', view);
    root.style.maxHeight = `${at.maxHeight}px`; root.style.top = `${at.top}px`; root.style.left = `${at.left}px`;
  };
  // On a phone the scrim closes the panel; elsewhere a press outside it does, unless it has been moved: then it is a window the person put somewhere.
  const onPointer = (event: PointerEvent): void => {
    if (compactBar() || drag.moved()) return;
    const t = event.target as Node;
    // A menu opened from a control inside the panel (a dropdown) is part of it.
    if (!root.contains(t) && !anchor.contains(t) && !(t instanceof Element && t.closest('.menu'))) panel.close();
  };
  const scrim = scrimFor(root, 59, () => panel.close());
  const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') panel.close(); };
  const onResize = (): void => { scrim.sync(); reposition(true); };
  const stopMode = onLayoutMode(onResize);
  const panel: Panel = {
    root, tools, body, anchor,
    render(next) {
      const keep = body.scrollTop;
      tools.replaceChildren(); body.replaceChildren(); next(tools, body);
      tools.hidden = tools.childElementCount === 0;
      reposition(); body.scrollTop = keep;
    },
    reposition: () => reposition(),
    close() {
      if (current !== panel) return;
      current = null; root.remove(); scrim.remove(); anchor.classList.remove('open');
      document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize); stopMode();
      options.onClose?.();
    },
  };
  closeButton.onclick = () => panel.close();
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

export function selectRow(name: string, description: string, options: readonly [value: string, label: string][], value: string, onChange: (value: string) => void): HTMLElement {
  const select = el('select');
  for (const [v, label] of options) select.append(new Option(label, v));
  select.value = value; select.onchange = () => onChange(select.value);
  return el('label', { class: 'field', tip: description },
    el('span', { class: 'label' }, el('span', { class: 'name', textContent: name }), el('span', { class: 'desc', textContent: description })), select);
}

export function numberRow(name: string, description: string, o: { min: number; step: number; value: number; max?: number }, onChange: (value: number) => void): HTMLElement {
  const input = el('input', { type: 'number', min: String(o.min), step: String(o.step), value: String(o.value) });
  if (o.max !== undefined) input.max = String(o.max);
  input.onchange = () => { const v = Number(input.value); if (Number.isFinite(v)) onChange(Math.min(o.max ?? Infinity, Math.max(o.min, v))); };
  return el('label', { class: 'field', tip: description },
    el('span', { class: 'label' }, el('span', { class: 'name', textContent: name }), el('span', { class: 'desc', textContent: description })), input);
}

/** A row of mutually exclusive choices. */
export function segmented(options: readonly [value: string, label: string][], value: string, onChange: (value: string) => void): HTMLElement {
  const group = el('div', { class: 'seg' });
  for (const [v, label] of options) group.append(el('button', { type: 'button', textContent: label, class: v === value ? 'on' : '', onclick: () => onChange(v) }));
  return group;
}

export const button = (label: string, onclick: () => void, title = ''): HTMLButtonElement => el('button', { type: 'button', textContent: label, tip: title, onclick });

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
