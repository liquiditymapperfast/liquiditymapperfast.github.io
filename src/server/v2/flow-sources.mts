import { BROWSER_VENUES, type BrowserVenue } from '../../shared/venues.ts';
import type { BookConnector, TradeEvent } from '../../shared/connector.ts';

/** Venues whose trades the feed manager already carries: counting them here as well would count every trade twice. */
const COVERED: ReadonlySet<string> = new Set(['binance', 'hyperliquid']);
/** A venue that is no longer wanted keeps its trade socket this long, so a venue picked off and on again does not reconnect. */
const GRACE_MS = 60_000;

/**
 * Trades for the flow column, footprint and large-trade bubbles from the venues the feed manager has depth for but no trade feed
 * (Bybit, OKX, Bitget, Deribit, Coinbase) and Binance spot. The browser engine's own connectors do it: where an exchange's book socket
 * also carries its trades, that connector runs (its book is simply not read); where trades have a feed of their own (Binance spot),
 * only that feed runs. A venue is started when it has a book on the server and stopped a minute after it has none.
 */
export class FlowSources {
  readonly #running = new Map<string, { connectors: BookConnector[]; unwantedSince: number }>();

  constructor(private onTrade: (trade: TradeEvent) => void, private now: () => number = Date.now, private venues: readonly BrowserVenue[] = BROWSER_VENUES) {}

  get active(): string[] { return [...this.#running.keys()]; }

  /** Start the sources of `wanted` venues that are not running; stop those that have not been wanted for a minute. */
  sync(wanted: ReadonlySet<string>): void {
    const now = this.now();
    for (const venue of this.venues) {
      if (COVERED.has(venue.id)) continue;
      const run = this.#running.get(venue.id);
      if (wanted.has(venue.id)) {
        if (run) { run.unwantedSince = 0; continue; }
        const made = venue.make(), connectors = made.feeds.length ? made.feeds : [made.book];
        for (const connector of connectors) { connector.onTrade = this.onTrade; connector.start(); }
        this.#running.set(venue.id, { connectors, unwantedSince: 0 });
      } else if (run) {
        if (!run.unwantedSince) run.unwantedSince = now;
        else if (now - run.unwantedSince >= GRACE_MS) { for (const connector of run.connectors) connector.stop(); this.#running.delete(venue.id); }
      }
    }
  }

  close(): void { for (const run of this.#running.values()) for (const connector of run.connectors) connector.stop(); this.#running.clear(); }
}
