import { el } from './dom.ts';
import { openSheet, type Sheet } from './sheet.ts';
import { togglePanel, type Panel } from './ui.ts';
import { isPhone } from './device.ts';
import { t } from './i18n.ts';

/**
 * A pane's header is one row (Karl, 2026-11-13: "mostly we should design the panels to have one row"): its name, its figures (the readout,
 * which takes the room between the name and the controls) and its controls.
 *
 * On a phone (Karl, 2026-10-26: three rows of small selects left a third of the screen to the chart) the row holds its title, the choice that
 * is changed all the time and a key that opens the rest as a sheet. The elements named as `rest` are the ones that wait in the sheet; any other
 * control of the header stays in the row.
 *
 * On a desktop (`fold`, the panes under the map) every control stays in the row while the figures keep at least `READOUT_MIN_PX` beside them;
 * where they would not, the last of the `rest` controls fold behind the same key, one at a time from the right end, until they do (the key
 * then opens those in a panel). So a narrower window takes settings out of the row, which are changed now and then, rather than the figures,
 * which are read all the time, or a second row from the chart: the Liquidity Tracker's controls need about 930 px, and at a 1,600 px window
 * its pane is 862 px wide (2026-11-13), where it took three rows. Folding is worked out again whenever the header or a control in it changes
 * size, never while the panel is open.
 *
 * Either way the controls are the pane's own elements, moved into the sheet or the panel while it is open and put back where they were when it
 * closes, so nothing is rebuilt and each keeps its handlers and its state.
 */
const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>';

/** The least room a pane's figures keep beside its controls on a desktop before the last controls fold behind the key (px). */
export const READOUT_MIN_PX = 280;

export interface Tune { readonly key: HTMLButtonElement; readonly open: () => Sheet | null; readonly sheet: () => Sheet | null; /** The controls folded behind the key on a desktop, from the right end. */ readonly folded: () => readonly HTMLElement[] }

/**
 * How many of the last `rest` controls fold so that the row fits: the fewest whose folding leaves `need(k)` (the row's width with the last `k`
 * folded, the key counted where `k` > 0) within `avail`; all of them where none does (the row then wraps, as it did before).
 */
export function foldCount(count: number, avail: number, need: (k: number) => number): number {
  for (let k = 0; k <= count; k++) if (need(k) <= avail) return k;
  return count;
}

export function addTune(head: HTMLElement, rest: readonly HTMLElement[], title: string, options: { fold?: boolean } = {}): Tune {
  head.classList.add('tuned');
  for (const node of rest) node.classList.add('rest');
  let sheet: Sheet | null = null, panel: Panel | null = null, folded = 0;
  /** The controls folded now: the last `folded` of `rest`. */
  const behind = (): HTMLElement[] => rest.slice(rest.length - folded);
  // Each control leaves a mark where it was, so it goes back to the same place whatever else changed in the row meanwhile.
  const lift = (nodes: readonly HTMLElement[]): (() => void) => {
    const holes = nodes.map(node => { const hole = document.createComment(''); node.replaceWith(hole); return hole; });
    return () => holes.forEach((hole, i) => hole.replaceWith(nodes[i]!));
  };
  const open = (): Sheet | null => {
    if (sheet) return sheet;
    if (options.fold && !isPhone()) {
      // A desktop: the controls folded away, in a panel by the key (a second press, or a press elsewhere, closes it).
      const nodes = behind();
      if (!nodes.length) return null;
      let back: (() => void) | null = null;
      panel = togglePanel(key, { title, width: 300, align: 'right', onClose: () => { back?.(); back = null; panel = null; key.classList.remove('open'); fit(); } }, (_tools, body) => {
        back ??= lift(nodes);
        body.classList.add('tune-body', 'tune-panel'); body.append(...nodes);
      });
      if (panel) key.classList.add('open');
      return null;
    }
    const back = lift(rest);
    sheet = openSheet(title, body => { body.classList.add('tune-body'); for (const node of rest) body.append(node); }, () => {
      back();
      sheet = null; key.classList.remove('open');
    });
    key.classList.add('open');
    return sheet;
  };
  const key = el('button', { type: 'button', class: 'tune-btn', ariaLabel: t('Settings'), tip: t('Settings'), onclick: () => { if (sheet) sheet.close(); else if (panel) panel.close(); else open(); } });
  key.insertAdjacentHTML('afterbegin', ICON);
  head.append(key);

  /** Fold as few of the last controls as leave the figures their room (a desktop only; nothing folds on a phone, where the sheet holds them all). */
  const fit = (): void => {
    if (!options.fold || panel || sheet) return;
    const set = (k: number): void => { folded = k; rest.forEach((node, i) => node.classList.toggle('folded', i >= rest.length - k)); head.classList.toggle('folding', behind().some(node => !node.hidden)); };
    if (isPhone()) { if (folded || head.classList.contains('folding')) set(0); return; }
    const avail = head.getBoundingClientRect().width;
    if (avail <= 0) return;
    const gap = parseFloat(getComputedStyle(head).columnGap) || 0;
    head.classList.add('tune-measuring');
    // The row's width with the last k folded, at its controls' own widths (none shrinks), with the figures' least room.
    const need = (k: number): number => { set(k); return head.getBoundingClientRect().width + gap + READOUT_MIN_PX; };
    const k = foldCount(rest.length, avail, need);
    head.classList.remove('tune-measuring');
    set(k);
  };
  if (options.fold) {
    let frame = 0;
    const later = (): void => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; fit(); }); };
    // The header's size (the window, the columns beside the panes) and every control's (a theme's frame, a choice shown or hidden).
    const watch = new ResizeObserver(later);
    watch.observe(head);
    for (const child of head.children) if (child !== key) watch.observe(child);
    for (const node of rest) watch.observe(node);
  }
  return { key, open, sheet: () => sheet, folded: behind };
}
