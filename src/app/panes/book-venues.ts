import type { Store } from '../store.ts';
import { el } from '../dom.ts';
import { setTip } from '../tip.ts';
import { t } from '../i18n.ts';
import { togglePanel, type Panel } from '../ui.ts';
import { buildBookMarketsPanel } from '../market-picker.ts';

/**
 * The Venues control of the two order-book panes (the Depth pane and the Liquidity Tracker): whose books they add up (book-markets.ts), one
 * choice for both, with Choose… opening the picker while it is Chosen markets, as the OI pane's Venues does. The select and its button are one
 * group, so they fold behind the header's key together (pane-tune.ts) and stand side by side in the key's panel and a phone's sheet.
 */
export class BookVenues {
  readonly root: HTMLElement;
  readonly #select = document.createElement('select');
  readonly #choose = document.createElement('button');
  #panel: Panel | null = null;
  /** The choice the open panel was built for: it is built again only for another one (a pick ticked in it must not rebuild it under the pointer). */
  #built: string = '';
  readonly #build: (tools: HTMLElement, body: HTMLElement) => void;

  constructor(private readonly store: Store) {
    const wrap = el('label', { class: 'ctl', tip: t('Whose order books this pane, the other order-book pane (Depth or Liquidity Tracker) and their sounds add up: every venue switched on inside the Spot / Perp filter, the chart market\'s own book, or the markets you choose.') }, t('Venues'));
    this.#select.append(new Option(t('All switched on'), 'all'), new Option(t('The chart market'), 'chart'), new Option(t('Chosen markets'), 'custom'));
    this.#select.onchange = () => {
      const v = this.#select.value;
      store.set({ bookMarkets: v === 'chart' || v === 'custom' ? v : 'all' });
      if (v === 'custom' && !this.#panel) this.#open();
    };
    wrap.append(this.#select);
    this.#choose.type = 'button'; this.#choose.textContent = t('Choose…'); setTip(this.#choose, t('Pick the markets whose order books are added up.'));
    this.#choose.onclick = () => this.#open();
    this.#build = (_tools, body) => { this.#built = store.state.bookMarkets; buildBookMarketsPanel(store, body, () => this.#panel?.render(this.#build)); };
    this.root = el('span', { class: 'ctl ctl-group book-venues' }, wrap, this.#choose);
    this.sync();
  }

  /** The choice as the settings have it (changed here, in the other pane, a layout or another tab); an open panel follows another choice. */
  sync(): void {
    const mode = this.store.state.bookMarkets;
    if (this.#select.value !== mode) this.#select.value = mode;
    this.#choose.hidden = mode !== 'custom';
    if (this.#panel && this.#built !== mode) this.#panel.render(this.#build);
  }

  /** The picker in a panel by Choose… (or, folded away, by the header's key: `placedBy`). */
  #open(): void {
    this.#choose.hidden = this.store.state.bookMarkets !== 'custom';
    this.#panel = togglePanel(this.#choose, { title: t('Order book markets'), width: 380, align: 'right', onClose: () => { this.#panel = null; } }, this.#build);
  }
}
