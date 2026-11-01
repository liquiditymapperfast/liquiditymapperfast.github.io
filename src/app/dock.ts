import { el } from './dom.ts';
import { layoutMode, onLayoutMode, type LayoutMode } from './device.ts';
import type { AppState } from './store.ts';
import { t } from './i18n.ts';

/**
 * The phone's tab bar. Most tabs keep the map on screen and pick which one other pane sits beside it (below in portrait, to the right
 * in landscape), or none ("Map" gives the map the whole screen). The panes themselves are the same elements the desktop arranges as a
 * column; the choice is only a `data-tab` attribute on `<main>` that the phone stylesheet reads, so nothing is rebuilt when it changes.
 * A tab exists only while its pane is switched on in Settings.
 * A handle between the map and the pane resizes it, and the size is remembered per tab and orientation. A tab with no share in the
 * orientation (`DEFAULT_SHARE`) has no map beside it: it fills the area, so it has no handle. The Tape and the Flow view fill it both
 * ways, and so does the Book held upright (twice the price rows, Karl 2026-10-26); held sideways the Book stays beside the map.
 *
 * The order is the order of the bar (Karl, 2026-10-26: the tab a phone opens on is the leftmost): what has been traded (Tape, Flow), what
 * rests in the book and what would be forced out of it (Map, Book, Liq, Depth), then the figures worked out from both (OI, Delta, L/S,
 * Stats). The Liquidity Tracker has no tab on a phone: Liq took its place beside the Book (Karl, 2026-11-01).
 */
export type DockTab = 'map' | 'candle' | 'flow' | 'book' | 'liq' | 'depth' | 'oi' | 'delta' | 'ls' | 'stats' | 'script';

/** The pane switches a tab can need: the `show` ones, and `liq` (Liquidation levels on, with an address to read them from). */
export type TabNeeds = AppState['show'] & { liq?: boolean };
interface TabSpec { id: DockTab; label: string; tip: string; icon: string; /** The switch that must be on; absent when the pane is always available. */ needs?: keyof TabNeeds }
const svg = (body: string): string => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const DOCK_TABS: readonly TabSpec[] = [
  // The Tape view takes the whole area instead of sitting beside the map (panes/candle-pane.ts).
  { id: 'candle', label: t('Tape'), tip: t('Every trade since the page opened, the trades coming in and the book around them, made for a phone.'),
    icon: svg('<path d="M12 3v4M12 17v4"/><rect x="8" y="7" width="8" height="10" rx="1"/><path d="M9.5 10h2M12.5 12.5h2M9.5 15h2" stroke-width="1.5"/>') },
  // The Flow view fills the area too: the price over the taker flow of every exchange, and a row for each (panes/cvd-pane.ts).
  { id: 'flow', label: t('Flow'), tip: t('Taker flow: what each exchange bought and sold at market, spot and perpetual, biggest first.'), needs: 'cvd',
    icon: svg('<path d="M3.5 17c3-1 4-8 7-8s3 5 5 5 3-8 5-8"/><path d="M3.5 20h17"/>') },
  { id: 'map', label: t('Map'), tip: t('The heatmap alone, at full size.'),
    icon: svg('<rect x="3.5" y="4" width="17" height="4.4" rx="1.2" fill="currentColor" fill-opacity=".28"/><rect x="3.5" y="10" width="17" height="4.4" rx="1.2" fill="currentColor" fill-opacity=".6"/><rect x="3.5" y="16" width="17" height="4.4" rx="1.2" fill="currentColor" fill-opacity=".16"/>') },
  { id: 'book', label: t('Book'), tip: t('The order book ladder: every price level, with the size resting at each venue.'), needs: 'book',
    icon: svg('<path d="M4 6.5h9M4 11h13M4 15.5h7M4 20h11"/>') },
  // The liquidation ladder fills the area held upright, as the Book does (panes/liq-pane.ts).
  { id: 'liq', label: t('Liq'), tip: t('Liquidation levels: where Hyperliquid\'s BTC positions would be liquidated, and how much would go if price got there.'), needs: 'liq',
    icon: svg('<path d="M4 12h16" stroke-dasharray="2 2.4"/><path d="M20 5.5h-9M20 8.5h-5M20 15.5h-7M20 18.5h-11"/>') },
  { id: 'depth', label: t('Depth'), tip: t('Total bid and ask liquidity near the price, over time.'), needs: 'depth',
    icon: svg('<path d="M3.5 20V15h5V10.5h5V7h7"/><path d="M3.5 20h17"/>') },
  { id: 'oi', label: 'OI', tip: t('Open interest and how it changes with each candle.'), needs: 'oi',
    icon: svg('<path d="M5 20v-4M10 20v-7M15 20v-5M20 20v-9"/><path d="M4 9l5-3 5 2 6-4"/>') },
  { id: 'delta', label: t('Delta'), tip: t('What taker buys outweighed sells by in each candle, and the cumulative delta.'), needs: 'delta',
    icon: svg('<path d="M5 20V12M9.7 20V8M14.3 20v-6M19 20V5"/><path d="M3.5 12h17" stroke-dasharray="2 2.5"/>') },
  { id: 'ls', label: t('L/S'), tip: t('The share of each exchange\'s accounts that is net long, as the exchange publishes it.'), needs: 'ls',
    icon: svg('<path d="M3.5 12h17" stroke-dasharray="2 2.5"/><path d="M3.5 9h5v-2h5v3h7"/><path d="M3.5 16h6v1.5h4v-2h7"/>') },
  { id: 'stats', label: t('Stats'), tip: t('The Bar stats table: a row of numbers per statistic, a cell per candle.'), needs: 'stats',
    icon: svg('<path d="M5 20V11M12 20V5M19 20V13"/>') },
  { id: 'script', label: t('Scripts'), tip: t('Your own indicators, written as scripts over the candles and the taker flow.'), needs: 'script',
    icon: svg('<path d="M8.5 7 4 12l4.5 5M15.5 7 20 12l-4.5 5M13.5 5l-3 14"/>') },
];


/**
 * The tab a phone opens on is the Tape (Karl, 2026-10-17); a desktop has the map. Only a tab that was tapped is saved, and the key is new
 * with that choice, so a phone that kept the Map from before opens on the Tape once and keeps whatever is chosen after.
 */
const KEY = 'hlm-dock-tab-v3', SIZE_KEY = 'hlm-dock-size';
/** Thickness of the handle in px (the stylesheet gives it the same). */
const GRIP = 20;
type Axis = 'portrait' | 'landscape';
/** The tab shown when none was ever chosen: the map on a desktop, the Tape on a phone. */
export const defaultTab = (mode: LayoutMode): DockTab => mode === 'desktop' ? 'map' : 'candle';
/** The tab that was last tapped, or null: then the default of the layout the page is in NOW applies, so a window that becomes a phone's (a browser's phone view, a rotated tablet) opens on the Tape too, not only a page loaded as one. */
const read = (): DockTab | null => { try { const id = window.localStorage.getItem(KEY); return DOCK_TABS.some(t => t.id === id) ? id as DockTab : null; } catch { return null; } };

/** The tabs available for these pane switches, in order. */
export const tabsFor = (show: TabNeeds): DockTab[] => DOCK_TABS.filter(t => !t.needs || show[t.needs]).map(t => t.id);
/** The tab to show: the wanted one when it exists, otherwise the map. */
export const resolveTab = (wanted: DockTab, show: TabNeeds): DockTab => tabsFor(show).includes(wanted) ? wanted : 'map';

/**
 * How big the pane beside the map is: a share of the map area by default (a book needs more rows than a strip of statistics),
 * or the pixels the person dragged it to. The result is a CSS length for `--dock-size`.
 */
export const DEFAULT_SHARE: Readonly<Record<Axis, Readonly<Partial<Record<DockTab, number>>>>> = {
  portrait: { depth: 0.38, oi: 0.38, delta: 0.38, ls: 0.34, stats: 0.3, script: 0.4 },
  landscape: { book: 0.46, liq: 0.46, depth: 0.42, oi: 0.42, delta: 0.42, ls: 0.4, stats: 0.38, script: 0.42 },
};
/** The orientation of the phone arrangement the dock sizes for. */
export const axisOf = (mode: LayoutMode): Axis => mode === 'phone-landscape' ? 'landscape' : 'portrait';
/** Whether a tab fills the area in place of the map in this orientation (the map alone is the map, not a view that covers it). */
export const fillsArea = (tab: DockTab, axis: Axis): boolean => tab !== 'map' && DEFAULT_SHARE[axis][tab] === undefined;
export const clampSize = (px: number, available: number, axis: Axis): number => Math.round(Math.max(axis === 'portrait' ? 120 : 220, Math.min(available - (axis === 'portrait' ? 150 : 200), px)));

export class Dock {
  readonly root = el('nav', { class: 'dock', role: 'tablist', ariaLabel: t('Panels') });
  /** The handle between the map and the pane; `<main>` holds it so the stylesheet can place it between them. */
  readonly grip = el('div', { class: 'dock-grip', role: 'separator', ariaLabel: t('Resize the panel'), tip: t('Drag to resize the panel. Double-tap to reset it.') }, el('i'));
  /** The mark under the open tab (the top of its button upright, its edge on the rail): it slides to the tab chosen instead of jumping. */
  readonly ink = el('i', { class: 'dock-ink', ariaHidden: 'true' });
  #wanted: DockTab | null = read();
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
    this.root.append(this.ink);
    main.append(this.grip);
    this.#bindGrip();
    onLayoutMode(() => { this.#size(); this.#moveInk(false); });
    // The bar's own size changes with the window, the tabs shown and the language (a longer word), and the mark follows the button it is under.
    new ResizeObserver(() => this.#moveInk(false)).observe(this.root);
  }

  get tab(): DockTab { return this.#tab; }

  /** Show or hide tabs to match the pane switches; a tab whose pane was switched off falls back to the map. */
  sync(show: TabNeeds): void {
    const available = new Set(tabsFor(show));
    for (const [id, button] of this.#buttons) button.hidden = !available.has(id);
    this.#apply(resolveTab(this.#wanted ?? defaultTab(layoutMode()), show));
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
    const changed = tab !== this.#tab;
    this.#tab = tab; this.#moveInk(changed);
    if (changed) this.onChange(tab);
  }

  /**
   * Put the mark under the open tab: where its button starts and how long it is, on the bar's own axis (across upright, down the rail held
   * sideways). `slide`: only a tab that was chosen moves it with the transition; a new window size, tab list or the first showing just places it.
   */
  #moveInk(slide: boolean): void {
    const on = this.#buttons.get(this.#tab);
    // A desktop does not show the bar at all (no layout, no box): nothing to place, and the first look when it does comes with the next size change.
    if (!on || on.hidden || !on.offsetParent) return;
    const sideways = this.#axis() === 'landscape';
    // The transition belongs to the style the change lands in, so the class and the numbers change together.
    this.ink.classList.toggle('slide', slide);
    this.ink.style.setProperty('--ink-at', `${sideways ? on.offsetTop : on.offsetLeft}px`);
    this.ink.style.setProperty('--ink-len', `${sideways ? on.offsetHeight : on.offsetWidth}px`);
  }

  #axis(): Axis { return axisOf(layoutMode()); }
  #key(): string { return `${this.#axis()}.${this.#tab}`; }

  /** Put the pane's size (remembered, or the default share) on `<main>` as `--dock-size`. */
  #size(): void {
    const tab = this.main.dataset.tab as DockTab | undefined;
    // The map alone and the views that fill the area (the Tape, the Flow, the Book held upright) have no pane beside them to size.
    const axis = this.#axis(), share = tab ? DEFAULT_SHARE[axis][tab] : undefined;
    if (!tab || tab === 'map' || share === undefined) { this.main.style.removeProperty('--dock-size'); return; }
    const saved = this.#sizes[`${axis}.${tab}`];
    this.main.style.setProperty('--dock-size', saved ? `${saved}px` : `${Math.round(share * 100)}%`);
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
