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
  /**
   * What the open panel shows (the choice, the picks, whether books are listed yet, and the market list they were listed from): it is built
   * again when that changes elsewhere (the other pane, a layout, another coin), not for a box ticked in it, which says so before the store
   * changes (a rebuild would lose the list's scroll), nor for a book leaving the feed for a moment.
   */
  #built = '';
  #builtMarkets: unknown = null;
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
    this.#build = (_tools, body) => {
      this.#built = this.#shown(); this.#builtMarkets = store.state.markets;
      buildBookMarketsPanel(store, body, () => this.#panel?.render(this.#build), picks => { this.#built = this.#shown(picks); });
    };
    this.root = el('span', { class: 'ctl ctl-group book-venues' }, wrap, this.#choose);
    this.sync();
  }

  /** The choice as the settings have it (changed here, in the other pane, a layout or another tab); an open panel follows. */
  sync(): void {
    const mode = this.store.state.bookMarkets;
    if (this.#select.value !== mode) this.#select.value = mode;
    this.#choose.hidden = mode !== 'custom';
    this.follow();
  }

  /** An open panel built for another choice, other picks or other books (another coin) is built again; safe at every draw. */
  follow(): void { if (this.#panel && (this.#shown() !== this.#built || (this.store.state.bookMarkets === 'custom' && this.store.state.markets !== this.#builtMarkets))) this.#panel.render(this.#build); }

  #shown(picks: readonly string[] = this.store.state.bookPicks): string {
    const s = this.store.state;
    return s.bookMarkets === 'custom' ? `custom|${picks.join(',')}|${s.levels?.books.length ? 'listed' : 'none'}` : s.bookMarkets;
  }

  /**
   * The picker in a panel, placed by the whole control (the select stays in view whatever the choice: Choose… hides while it is not Chosen
   * markets, and a panel placed by a button with no box would go to the window's corner), or folded away by the header's key (`placedBy`).
   */
  #open(): void {
    this.#choose.hidden = this.store.state.bookMarkets !== 'custom';
    this.#panel = togglePanel(this.root, { title: t('Order book markets'), width: 380, align: 'right', onClose: () => { this.#panel = null; this.#choose.classList.remove('open'); } }, this.#build);
    // Choose… lit while its picker is open, as a button that opens a panel is (the panel is placed by the whole control).
    this.#choose.classList.toggle('open', this.#panel !== null);
  }
}
