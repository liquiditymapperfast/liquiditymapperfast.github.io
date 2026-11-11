import { BROWSER_VENUES, type BrowserVenue } from '../../shared/venues.ts';
import type { BookConnector, TradeEvent } from '../../shared/connector.ts';
import type { LiquidationEvent } from '../../shared/liquidations.ts';

/**
 * Venues whose trades already arrive another way: the feed manager carries Binance's and Hyperliquid's, and the spot markets of Bybit, OKX
 * and Bitget are connector venues whose own sockets carry them. Running them here as well would open a second socket for the same trades.
 */
const COVERED: ReadonlySet<string> = new Set(['binance', 'hyperliquid', 'bybitspot', 'okxspot', 'bitgetspot']);
/** A venue that is no longer wanted keeps its trade socket this long, so a venue picked off and on again does not reconnect. */
const GRACE_MS = 60_000;

interface Made { book: BookConnector; feeds: BookConnector[]; liquidations?: BookConnector[] }

/**
 * Trades for the flow column, footprint and large-trade bubbles from the venues the feed manager has depth for but no trade feed
 * (Bybit, OKX, Bitget, Deribit, Coinbase) and Binance spot. The browser engine's own connectors do it: where an exchange's book socket
 * also carries its trades, that connector runs (its book is simply not read); where trades have a feed of their own (Binance spot),
 * only that feed runs. A venue is started when the server has a book for the instrument its connectors trade (they are BTC connectors:
 * a server set up for another coin has depth that their trades do not belong to) and stopped a minute after it has none.
 */
export class FlowSources {
  readonly #running = new Map<string, { connectors: BookConnector[]; trades: BookConnector[]; instrument: string; unwantedSince: number }>();
  /** Connectors made but not started: a venue has to be made to tell which instrument it trades, and that one is what starts if the venue is wanted. */
  readonly #spare = new Map<string, Made>();
  /** Venues whose trades another source owns now (full-depth.mts: the Bybit perpetual's own connector): never run here meanwhile. */
  readonly #excluded = new Set<string>();

  constructor(private onTrade: (trade: TradeEvent) => void, private now: () => number = Date.now, private venues: readonly BrowserVenue[] = BROWSER_VENUES, private onLiquidation: (event: LiquidationEvent) => void = () => {}) {}

  get active(): string[] { return [...this.#running.keys()]; }
  /** Each instrument whose trades come from here: whether every connector carrying them is live, and the oldest of their last messages. */
  trades(): Map<string, { live: boolean; lastData: number }> {
    const out = new Map<string, { live: boolean; lastData: number }>();
    for (const run of this.#running.values()) if (run.trades.length) out.set(run.instrument, { live: run.trades.every(c => c.state === 'live'), lastData: Math.min(...run.trades.map(c => c.lastUpdate)) });
    return out;
  }

  /**
   * Whether another source owns a venue's trades: an excluded venue's connectors stop at once (not after the minute's grace) and none starts
   * while it is, so one trade never arrives twice.
   */
  exclude(venueId: string, excluded: boolean): void {
    if (!excluded) { this.#excluded.delete(venueId); return; }
    this.#excluded.add(venueId);
    const run = this.#running.get(venueId);
    if (run) { for (const connector of run.connectors) connector.stop(); this.#running.delete(venueId); }
  }

  /** Start the sources of the venues whose instrument is in `wanted` (the instrument ids the server has a book for) and are not running; stop those that have not been wanted for a minute. */
  sync(wanted: ReadonlySet<string>): void {
    const now = this.now();
    for (const venue of this.venues) {
      if (this.#excluded.has(venue.id)) continue;
      const run = this.#running.get(venue.id);
      if (run) {
        if (wanted.has(run.instrument)) run.unwantedSince = 0;
        else if (!run.unwantedSince) run.unwantedSince = now;
        else if (now - run.unwantedSince >= GRACE_MS) { for (const connector of run.connectors) connector.stop(); this.#running.delete(venue.id); }
        continue;
      }
      const made = this.#spare.get(venue.id) ?? venue.make(); this.#spare.set(venue.id, made);
      // A venue whose trades come another way runs only its liquidation feed, if it has one (one with neither stays made and unstarted).
      const trades = COVERED.has(venue.id) ? [] : made.feeds.length ? made.feeds : [made.book], connectors = [...trades, ...(made.liquidations ?? [])];
      const instrument = made.book.instrumentId;
      if (!connectors.length || !wanted.has(instrument)) continue;
      this.#spare.delete(venue.id);
      // Their books are not read here (the feed manager has the depth), so they read no far book either.
      for (const connector of connectors) { connector.onTrade = this.onTrade; connector.onLiquidation = this.onLiquidation; connector.bookRead = false; connector.start(); }
      this.#running.set(venue.id, { connectors, trades, instrument, unwantedSince: 0 });
    }
  }

  close(): void { for (const run of this.#running.values()) for (const connector of run.connectors) connector.stop(); this.#running.clear(); this.#spare.clear(); }
}
