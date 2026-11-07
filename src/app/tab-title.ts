import type { AppState, Store } from './store.ts';
import { price as fmtPrice } from './format.ts';
import { currentCoin } from './coin.ts';

/**
 * The browser tab says the price (GitHub issue #7, 2026-11-03: "I keep it open in a tab"). Its title starts with the chart market's price and
 * which way the candle under way is going (▲ up from its open, ▼ down, as the chart colours it), and its icon becomes that candle drawn small:
 * a pinned tab, or one of many, shows no title, and the icon still says where the price is going. Each has its own switch (Settings), both on.
 *
 * Written from the price as it comes (the store's `mark`), never from a frame: a tab in the background draws nothing, and that is where its title
 * is read. The title at most once a second and the icon every few seconds, each only when what it says changed; switched off, the page's own
 * title and icon come back. (Safari keeps the icon it first read: there the title alone moves.)
 */

/** How often the title and the icon are written at most. */
const TITLE_MS = 1_000, ICON_MS = 3_000;
const ICON_PX = 32;
/** The site's short name after the price (Karl, 2026-11-07: "use the abbreviation LMF"); without a price the page's own title, the whole name, stays. */
const SHORT_NAME = 'LMF';

/** What the tab says: the price, which way the candle under way goes (null: no candle of this market under way), and the coin. */
export interface TabQuote { price: number; up: boolean | null; coin: string; step: number; candle: { open: number; high: number; low: number; close: number } | null }

/** The chart market's quote from the state: its price now and its candle under way (only when the chart's candles are that market's). */
export function tabQuote(state: Pick<AppState, 'mark' | 'candles' | 'markets' | 'marketId' | 'seriesInstrument'>, coin: string): TabQuote | null {
  const price = state.mark.price;
  if (!(price > 0) || !Number.isFinite(price)) return null;
  const market = state.markets.find(m => (m.instrumentId ?? m.id) === state.marketId), last = state.candles[state.candles.length - 1];
  // The candle under way is the chart's newest, its close the price now; a borrowed series (another market's) says nothing of this one's.
  const own = !state.seriesInstrument || state.seriesInstrument === state.marketId;
  const candle = own && last && last[1] > 0 ? { open: last[1], high: Math.max(last[2], price), low: Math.min(last[3], price), close: price } : null;
  return { price, up: candle ? price >= candle.open : null, coin: market?.base ?? coin, step: market?.tickSize ?? 0, candle };
}

/** The tab's title: "75,903.4 ▲ BTC · LMF", or the page's own title without a price. */
export function tabTitle(quote: TabQuote | null, base: string): string {
  if (!quote) return base;
  return `${fmtPrice(quote.price, quote.step)}${quote.up === null ? '' : quote.up ? ' ▲' : ' ▼'} ${quote.coin} · ${SHORT_NAME}`;
}

/** The candle the icon draws, in whole pixels of a `px` square, and its colour: what the icon says, so it is drawn again only when this changes. */
export function iconCandle(candle: NonNullable<TabQuote['candle']>, px = ICON_PX): { up: boolean; wick: [number, number]; body: [number, number] } {
  const pad = Math.round(px * 0.12), span = candle.high - candle.low, h = px - 2 * pad;
  const y = (v: number): number => span > 0 ? Math.round(pad + (1 - (v - candle.low) / span) * h) : Math.round(px / 2);
  const top = Math.min(y(candle.open), y(candle.close)), bottom = Math.max(y(candle.open), y(candle.close));
  // A body never thinner than two pixels: a candle that has not moved is still a candle.
  return { up: candle.close >= candle.open, wick: [y(candle.high), y(candle.low)], body: bottom - top >= 2 ? [top, bottom] : [Math.max(pad, top - 1), Math.max(pad, top - 1) + 2] };
}

export class TabTitle {
  readonly #base = document.title;
  readonly #link: HTMLLinkElement | null = document.querySelector('link[rel="icon"]');
  readonly #href = this.#link?.getAttribute('href') ?? null;
  readonly #type = this.#link?.getAttribute('type') ?? null;
  #canvas: HTMLCanvasElement | null = null;
  #iconKey = '';
  #titleAt = 0; #iconAt = 0;
  #timer = 0;

  constructor(private readonly store: Store) {
    store.subscribe((_state, changed) => {
      if (changed.has('mark') || changed.has('candles') || changed.has('marketId') || changed.has('markets') || changed.has('tabPrice') || changed.has('tabIcon')) this.#schedule(changed.has('tabPrice') || changed.has('tabIcon'));
    });
    this.#write();
  }

  /** Write now when the last write is old enough (or a switch moved), else once when it is. */
  #schedule(now: boolean): void {
    if (this.#timer) return;
    const wait = now ? 0 : Math.max(0, TITLE_MS - (Date.now() - this.#titleAt));
    if (!wait) { this.#write(); return; }
    this.#timer = window.setTimeout(() => { this.#timer = 0; this.#write(); }, wait);
  }

  /** Never throws: it runs among the store's listeners, and a canvas a hardened browser refuses (no `toDataURL`) must not stop the others. */
  #write(): void {
    this.#titleAt = Date.now();
    try {
      const state = this.store.state, quote = tabQuote(state, currentCoin().coin);
      const title = state.tabPrice ? tabTitle(quote, this.#base) : this.#base;
      if (document.title !== title) document.title = title;
      this.#icon(state.tabIcon ? quote?.candle ?? null : null);
    } catch { /* the title and icon stay as they were */ }
  }

  /** The icon: the candle under way (at most every ICON_MS, only when it looks different), or the page's own icon back. */
  #icon(candle: TabQuote['candle']): void {
    const link = this.#link;
    if (!link) return;
    if (!candle) {
      if (this.#iconKey) { this.#iconKey = ''; if (this.#href !== null) link.setAttribute('href', this.#href); if (this.#type !== null) link.setAttribute('type', this.#type); }
      return;
    }
    const now = Date.now();
    if (this.#iconKey && now - this.#iconAt < ICON_MS) return;
    const shape = iconCandle(candle), key = `${shape.up}|${shape.wick.join(',')}|${shape.body.join(',')}`;
    if (key === this.#iconKey) return;
    this.#iconKey = key; this.#iconAt = now;
    const canvas = this.#canvas ??= Object.assign(document.createElement('canvas'), { width: ICON_PX, height: ICON_PX });
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    // A dark rounded square under the candle, so it reads on a light tab strip and a dark one alike.
    ctx.clearRect(0, 0, ICON_PX, ICON_PX);
    ctx.fillStyle = '#16191d'; ctx.beginPath(); ctx.roundRect(0, 0, ICON_PX, ICON_PX, 7); ctx.fill();
    const colour = shape.up ? '#2fd07a' : '#ff5a52', mid = ICON_PX / 2;
    ctx.fillStyle = colour;
    ctx.fillRect(mid - 1.5, shape.wick[0], 3, Math.max(1, shape.wick[1] - shape.wick[0]));
    ctx.fillRect(mid - 7, shape.body[0], 14, shape.body[1] - shape.body[0]);
    link.setAttribute('type', 'image/png'); link.setAttribute('href', canvas.toDataURL('image/png'));
  }
}
