import { BybitConnector } from '../../shared/venues.ts';
import { unitOf } from '../../shared/coins.ts';
import type { BookConnector, Market, TradeEvent } from '../../shared/connector.ts';
import type { LiquidationEvent } from '../../shared/liquidations.ts';
import type { ValuedBook } from '../../shared/levels.ts';

/**
 * The Bybit perpetual's full-depth book on the local server (`Research_Findings.md`, 2026-11-11). The feed manager's own Bybit depth is
 * the 1,000-level stream (`src/adapters/bybit.mts`), and its pre-valuation cap (`BOOK_LEVEL_LIMIT`) would cut a full book anyway: so the
 * page's shared connector (`BybitConnector`, shared/venues.ts, with shared/bybit-full-book.ts) owns the configured perpetual here, as it
 * does in the browser. It owns the instrument's book, trades and liquidations; the feed manager keeps everything else it does for Bybit
 * (the market row, metadata, its legacy routes, and open interest from its ticker feed, so `onOi` is left unset here).
 *
 * What is owned follows the feed manager's own Bybit depth spec (`bybit-depth`, which exists only while Bybit is selected): a linear USDT
 * perpetual listed one coin to a unit, the only kind the server records (it records BTC). Anything else keeps the feed manager's book.
 */

/** The feed manager's Bybit depth spec as main.mts reads it (null: Bybit is not selected). */
export interface FullDepthSpec { instrumentId: string; symbol: string; category: string }

/** The market the shared connector is built for, or null when the spec is not one this owner takes (inverse, spot, another quote, a unit). */
export function ownedMarket(spec: FullDepthSpec | null): Market | null {
  if (!spec || spec.category !== 'linear' || !/^[A-Z0-9]+USDT$/.test(spec.symbol) || spec.instrumentId !== `bybit:${spec.symbol}`) return null;
  const [coin, unit] = unitOf(spec.symbol.slice(0, -4), 'bybit');
  return unit === 1 ? { coin, symbol: spec.symbol, unit } : null;
}

export class FullDepthBooks {
  #connector: BookConnector | null = null;
  #key = '';
  /** The last valued book and when (what the chip says, without valuing the book again on every look at the venue list). */
  #last: ValuedBook | null = null; #lastAt = 0;

  constructor(private readonly onTrade: (trade: TradeEvent) => void, private readonly onLiquidation: (event: LiquidationEvent) => void,
    private readonly make: (market: Market) => BookConnector = market => new BybitConnector(market)) {}

  /** The instrument owned now (null: none). */
  get ownedId(): string | null { return this.#connector?.instrumentId ?? null; }

  /**
   * Make, replace or stop the owner for the spec the feed manager runs now. The old connector stops before a replacement starts, so two
   * never hand on the same instrument's trades.
   */
  sync(spec: FullDepthSpec | null): void {
    const market = ownedMarket(spec), key = market ? `${spec!.instrumentId}|${market.symbol}` : '';
    if (key === this.#key) return;
    this.#connector?.stop(); this.#connector = null; this.#key = key; this.#last = null;
    if (!market) return;
    const connector = this.make(market);
    connector.onTrade = this.onTrade; connector.onLiquidation = this.onLiquidation;
    connector.start();
    this.#connector = connector;
  }

  /** The owned book valued on the recorder's grid step for it (null while it loads, re-synchronises or is stale: no fallback is drawn). */
  book(now: number, step?: number): ValuedBook | null {
    this.#last = this.#connector?.valued(now, step) ?? null; this.#lastAt = now;
    return this.#last;
  }

  /** Whether the owned instrument's trade socket is live, and its last message (for the trade coverage). */
  trades(now: number): { live: boolean; lastData: number } | null {
    const c = this.#connector;
    return c ? { live: c.state === 'live', lastData: c.lastUpdate || now } : null;
  }

  /**
   * The owned venue's book state for its chip in the order-book venue list (main.mts): live once the book is drawn, connecting while it
   * loads, error when the socket failed; and what the status line says about the book.
   */
  states(now: number): Map<string, { state: string; detail: string | null }> {
    const c = this.#connector;
    if (!c) return new Map();
    const drawn = this.#last !== null && now - this.#lastAt <= 5_000, detail = c.bookDetail();
    const state = drawn ? 'live' : c.state === 'error' ? 'error' : 'connecting';
    return new Map([[c.id, { state, detail: drawn ? null : detail ?? c.lastError }]]);
  }

  close(): void { this.#connector?.stop(); this.#connector = null; this.#key = ''; this.#last = null; }
}
