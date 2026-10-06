import { BROWSER_VENUES, type BrowserVenue } from '../../shared/venues.ts';
import type { BookConnector, TradeEvent } from '../../shared/connector.ts';

/** Venues whose trades the feed manager already carries: counting them here as well would count every trade twice. */
const COVERED: ReadonlySet<string> = new Set(['binance', 'hyperliquid']);
/** A venue that is no longer wanted keeps its trade socket this long, so a venue picked off and on again does not reconnect. */
const GRACE_MS = 60_000;

interface Made { book: BookConnector; feeds: BookConnector[] }

/**
 * Trades for the flow column, footprint and large-trade bubbles from the venues the feed manager has depth for but no trade feed
 * (Bybit, OKX, Bitget, Deribit, Coinbase) and Binance spot. The browser engine's own connectors do it: where an exchange's book socket
 * also carries its trades, that connector runs (its book is simply not read); where trades have a feed of their own (Binance spot),
 * only that feed runs. A venue is started when the server has a book for the instrument its connectors trade (they are BTC connectors:
 * a server set up for another coin has depth that their trades do not belong to) and stopped a minute after it has none.
 */
export class FlowSources {
  readonly #running = new Map<string, { connectors: BookConnector[]; instrument: string; unwantedSince: number }>();
  /** Connectors made but not started: a venue has to be made to tell which instrument it trades, and that one is what starts if the venue is wanted. */
  readonly #spare = new Map<string, Made>();

  constructor(private onTrade: (trade: TradeEvent) => void, private now: () => number = Date.now, private venues: readonly BrowserVenue[] = BROWSER_VENUES) {}

  get active(): string[] { return [...this.#running.keys()]; }

  /** Start the sources of the venues whose instrument is in `wanted` (the instrument ids the server has a book for) and are not running; stop those that have not been wanted for a minute. */
  sync(wanted: ReadonlySet<string>): void {
    const now = this.now();
    for (const venue of this.venues) {
      if (COVERED.has(venue.id)) continue;
      const run = this.#running.get(venue.id);
      if (run) {
        if (wanted.has(run.instrument)) run.unwantedSince = 0;
        else if (!run.unwantedSince) run.unwantedSince = now;
        else if (now - run.unwantedSince >= GRACE_MS) { for (const connector of run.connectors) connector.stop(); this.#running.delete(venue.id); }
        continue;
      }
      const made = this.#spare.get(venue.id) ?? venue.make(); this.#spare.set(venue.id, made);
      const instrument = made.book.instrumentId;
      if (!wanted.has(instrument)) continue;
      this.#spare.delete(venue.id);
      const connectors = made.feeds.length ? made.feeds : [made.book];
      for (const connector of connectors) { connector.onTrade = this.onTrade; connector.start(); }
      this.#running.set(venue.id, { connectors, instrument, unwantedSince: 0 });
    }
  }

  close(): void { for (const run of this.#running.values()) for (const connector of run.connectors) connector.stop(); this.#running.clear(); this.#spare.clear(); }
}
