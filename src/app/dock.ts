import { el } from './dom.ts';
import { layoutMode, onLayoutMode } from './device.ts';
import type { AppState } from './store.ts';
import { t } from './i18n.ts';

/**
 * The phone's tab bar. The map is always on screen; the bar picks which one other pane sits beside it (below in portrait, to the right
 * in landscape), or none ("Map" gives the map the whole screen). The panes themselves are the same elements the desktop arranges as a
 * column; the choice is only a `data-tab` attribute on `<main>` that the phone stylesheet reads, so nothing is rebuilt when it changes.
 * A tab exists only while its pane is switched on in Settings (Footprint is what brings the bar-stats pane, "Stats").
 * A handle between the map and the pane resizes it, and the size is remembered per tab and orientation.
 */
export type DockTab = 'map' | 'flow' | 'book' | 'depth' | 'oi' | 'lt' | 'stats';

interface TabSpec { id: DockTab; label: string; tip: string; icon: string; /** The `show` switch that must be on; absent when the pane is always available. */ needs?: keyof AppState['show'] }
const svg = (body: string): string => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const DOCK_TABS: readonly TabSpec[] = [
  { id: 'map', label: t('Map'), tip: t('The heatmap alone, at full size.'),
    icon: svg('<rect x="3.5" y="4" width="17" height="4.4" rx="1.2" fill="currentColor" fill-opacity=".28"/><rect x="3.5" y="10" width="17" height="4.4" rx="1.2" fill="currentColor" fill-opacity=".6"/><rect x="3.5" y="16" width="17" height="4.4" rx="1.2" fill="currentColor" fill-opacity=".16"/>') },
  { id: 'flow', label: t('Flow'), tip: t('Taker flow: what each exchange bought and sold at market, spot and perpetual, biggest first.'), needs: 'cvd',
    icon: svg('<path d="M3.5 17c3-1 4-8 7-8s3 5 5 5 3-8 5-8"/><path d="M3.5 20h17"/>') },
  { id: 'book', label: t('Book'), tip: t('The order book ladder: every price level, with the size resting at each venue.'), needs: 'book',
    icon: svg('<path d="M4 6.5h9M4 11h13M4 15.5h7M4 20h11"/>') },
  { id: 'depth', label: t('Depth'), tip: t('Total bid and ask liquidity near the price, over time.'), needs: 'depth',
    icon: svg('<path d="M3.5 20V15h5V10.5h5V7h7"/><path d="M3.5 20h17"/>') },
  { id: 'oi', label: 'OI', tip: t('Open interest and how it changes with each candle.'), needs: 'oi',
    icon: svg('<path d="M5 20v-4M10 20v-7M15 20v-5M20 20v-9"/><path d="M4 9l5-3 5 2 6-4"/>') },
  { id: 'lt', label: 'LT', tip: t('The Liquidity Tracker: bid and ask liquidity near the price as two lines.'), needs: 'lt',
    icon: svg('<path d="M3.5 9c3-4 5 4 8 0s5-2 9-2"/><path d="M3.5 17c3-4 5 4 8 0s5-2 9-2"/>') },
  { id: 'stats', label: t('Stats'), tip: t('Statistics for each candle, beneath the footprint.'), needs: 'footprint',
    icon: svg('<path d="M5 20V11M12 20V5M19 20V13"/>') },
];

const KEY = 'hlm-dock-tab', SIZE_KEY = 'hlm-dock-size';
/** Thickness of the handle in px (the stylesheet gives it the same). */
const GRIP = 20;
type Axis = 'portrait' | 'landscape';
const read = (): DockTab => { try { const id = window.localStorage.getItem(KEY); return DOCK_TABS.some(t => t.id === id) ? id as DockTab : 'map'; } catch { return 'map'; } };

/** The tabs available for these pane switches, in order. */
export const tabsFor = (show: AppState['show']): DockTab[] => DOCK_TABS.filter(t => !t.needs || show[t.needs]).map(t => t.id);
/** The tab to show: the wanted one when it exists, otherwise the map. */
export const resolveTab = (wanted: DockTab, show: AppState['show']): DockTab => tabsFor(show).includes(wanted) ? wanted : 'map';

/**
 * How big the pane beside the map is: a share of the map area by default (a book needs more rows than a strip of statistics),
 * or the pixels the person dragged it to. The result is a CSS length for `--dock-size`.
 */
export const DEFAULT_SHARE: Readonly<Record<Axis, Readonly<Record<Exclude<DockTab, 'map'>, number>>>> = {
  portrait: { flow: 0.5, book: 0.46, depth: 0.38, oi: 0.38, lt: 0.38, stats: 0.3 },
  landscape: { flow: 0.46, book: 0.46, depth: 0.42, oi: 0.42, lt: 0.42, stats: 0.38 },
};
export const clampSize = (px: number, available: number, axis: Axis): number => Math.round(Math.max(axis === 'portrait' ? 120 : 220, Math.min(available - (axis === 'portrait' ? 150 : 200), px)));

export class Dock {
  readonly root = el('nav', { class: 'dock', role: 'tablist', ariaLabel: t('Panels') });
  /** The handle between the map and the pane; `<main>` holds it so the stylesheet can place it between them. */
  readonly grip = el('div', { class: 'dock-grip', role: 'separator', ariaLabel: t('Resize the panel'), tip: t('Drag to resize the panel. Double-tap to reset it.') }, el('i'));
  #wanted: DockTab = read();
  #tab: DockTab = 'map';
  #buttons = new Map<DockTab, HTMLButtonElement>();
  #sizes: Record<string, number> = {};
  /** Called after the visible pane changed, once the stylesheet has had the new value. */
  onChange: (tab: DockTab) => void = () => {};

  constructor(private main: HTMLElement) {
    try { this.#sizes = JSON.parse(window.localStorage.getItem(SIZE_KEY) ?? '{}') as Record<string, number>; } catch { this.#sizes = {}; }
    for (const spec of DOCK_TABS) {
      const label = el('span', { textContent: spec.label });
      const button = el('button', { type: 'button', class: 'dock-tab', role: 'tab', tip: spec.tip, onclick: () => this.select(spec.id) });
      button.insertAdjacentHTML('afterbegin', spec.icon); button.append(label);
      button.dataset.tab = spec.id;
      this.#buttons.set(spec.id, button); this.root.append(button);
    }
    main.append(this.grip);
    this.#bindGrip();
    onLayoutMode(() => this.#size());
  }

  get tab(): DockTab { return this.#tab; }

  /** Show or hide tabs to match the pane switches; a tab whose pane was switched off falls back to the map. */
  sync(show: AppState['show']): void {
    const available = new Set(tabsFor(show));
    for (const [id, button] of this.#buttons) button.hidden = !available.has(id);
    this.#apply(resolveTab(this.#wanted, show));
  }

  select(tab: DockTab): void {
    // Tapping the tab that is already open closes the pane: the quickest way back to a full-screen map.
    const next = tab === this.#tab && tab !== 'map' ? 'map' : tab;
    this.#wanted = next;
    try { window.localStorage.setItem(KEY, next); } catch { /* storage unavailable */ }
    this.#apply(next);
  }

  #apply(tab: DockTab): void {
    for (const [id, button] of this.#buttons) { const on = id === tab; button.classList.toggle('on', on); button.setAttribute('aria-selected', String(on)); }
    this.main.dataset.tab = tab;
    this.#size();
    if (tab === this.#tab) return;
    this.#tab = tab; this.onChange(tab);
  }

  #axis(): Axis { return layoutMode() === 'phone-landscape' ? 'landscape' : 'portrait'; }
  #key(): string { return `${this.#axis()}.${this.#tab}`; }

  /** Put the pane's size (remembered, or the default share) on `<main>` as `--dock-size`. */
  #size(): void {
    const tab = this.main.dataset.tab as DockTab | undefined;
    if (!tab || tab === 'map') { this.main.style.removeProperty('--dock-size'); return; }
    const axis = this.#axis(), saved = this.#sizes[`${axis}.${tab}`];
    this.main.style.setProperty('--dock-size', saved ? `${saved}px` : `${Math.round(DEFAULT_SHARE[axis][tab] * 100)}%`);
  }

  /** Drag the handle to resize; double-tap it to go back to the default share. */
  #bindGrip(): void {
    let lastTap = 0;
    this.grip.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const now = event.timeStamp;
      if (now - lastTap < 350) { delete this.#sizes[this.#key()]; this.#persist(); this.#size(); lastTap = 0; return; }
      lastTap = now;
      this.grip.setPointerCapture(event.pointerId); this.grip.classList.add('active');
      const axis = this.#axis(), rect = this.main.getBoundingClientRect();
      const move = (e: PointerEvent): void => {
        const available = axis === 'portrait' ? rect.height : rect.width;
        const px = axis === 'portrait' ? rect.bottom - e.clientY : rect.right - e.clientX;
        this.#sizes[this.#key()] = clampSize(px - GRIP / 2, available, axis); this.#size();
      };
      const done = (): void => {
        this.grip.classList.remove('active');
        this.grip.removeEventListener('pointermove', move); this.grip.removeEventListener('pointerup', done); this.grip.removeEventListener('pointercancel', done);
        this.#persist();
      };
      this.grip.addEventListener('pointermove', move); this.grip.addEventListener('pointerup', done); this.grip.addEventListener('pointercancel', done);
    });
  }
  #persist(): void { try { window.localStorage.setItem(SIZE_KEY, JSON.stringify(this.#sizes)); } catch { /* storage unavailable */ } }
}
