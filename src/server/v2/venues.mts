import fs from 'node:fs';
import { BookConnector, CONNECTOR_FACTORIES, type ConnectorStatus } from './connectors.mts';
import type { ValuedBook } from './levels.mts';

export interface ExtraVenue extends ConnectorStatus {
  id: string; name: string; instrumentId: string; symbol: string; quote: string; marketType: 'spot' | 'perpetual'; enabled: boolean;
  /** Part of the recommended set (what a first run starts and the picker's Recommended button selects). */
  default: boolean;
}

/** Connector venues that existed before the saved choice recorded which venues it had seen. */
const EARLIER_VENUES = ['binanceus', 'hitbtc', 'poloniex', 'bitmart', 'bitunix'];

/**
 * The connector venues a first run starts: Binance spot, the largest spot book and the best feed measured
 * (`docs/deslop/venue-defaults-2026-10-05.md`). The other connectors are small, so they wait in the Venues picker.
 */
export const RECOMMENDED_EXTRA_VENUES: readonly string[] = ['binancespot'];

/** Venues served by self-contained connectors (the aggr.trade exchanges the feed manager does not cover). Enablement is persisted. */
export class ExtraVenues {
  readonly #all = new Map<string, BookConnector>(Object.entries(CONNECTOR_FACTORIES).map(([id, make]) => [id, make()]));
  readonly #enabled = new Set<string>();
  readonly #defaults: ReadonlySet<string>;

  /**
   * `defaultOn` names the venues to start when no choice is saved yet (`true`: every connector; `false`: none, as in tests and
   * memory-only servers). A venue of that set added by a later build, one the saved choice predates, also starts once so new
   * recommended sources appear without a visit to the dialog; other new venues wait to be chosen.
   */
  constructor(private file: string | null = null, factories: Record<string, () => BookConnector> = CONNECTOR_FACTORIES, defaultOn: boolean | readonly string[] = false) {
    if (factories !== CONNECTOR_FACTORIES) { this.#all.clear(); for (const [id, make] of Object.entries(factories)) this.#all.set(id, make()); }
    this.#defaults = new Set(defaultOn === true ? this.#all.keys() : defaultOn === false ? [] : defaultOn.filter(id => this.#all.has(id)));
    let restored = false;
    try {
      const saved = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as { enabled?: unknown; known?: unknown } : null;
      if (Array.isArray(saved?.enabled)) {
        const enabled = saved.enabled.filter((id): id is string => typeof id === 'string');
        // Files written before `known` existed predate the venues added since; for a custom set every current id counts as known.
        const known = new Set(Array.isArray(saved.known) ? saved.known.filter((id): id is string => typeof id === 'string') : factories === CONNECTOR_FACTORIES ? EARLIER_VENUES : [...this.#all.keys()]);
        const added = [...this.#defaults].filter(id => !known.has(id));
        this.setEnabled([...enabled, ...added], added.length > 0);
        restored = true;
      }
    } catch { /* unreadable preference file: fall back to the default */ }
    if (!restored && this.#defaults.size) this.setEnabled([...this.#defaults], false);
  }

  list(): ExtraVenue[] {
    return [...this.#all.values()].map(c => ({ id: c.id, name: c.name, instrumentId: c.instrumentId, symbol: c.symbol, quote: c.quote, marketType: c.marketType, enabled: this.#enabled.has(c.id), default: this.#defaults.has(c.id), ...c.status() }));
  }
  get enabledCount(): number { return this.#enabled.size; }

  /** Start newly enabled connectors, stop the rest, and remember the choice. Unknown ids are ignored. */
  setEnabled(ids: readonly string[], persist = true): void {
    const wanted = new Set(ids.filter(id => this.#all.has(id)));
    for (const [id, connector] of this.#all) {
      if (wanted.has(id)) { if (!this.#enabled.has(id)) { this.#enabled.add(id); connector.start(); } }
      else if (this.#enabled.delete(id)) connector.stop();
    }
    if (persist && this.file) { try { fs.writeFileSync(this.file, JSON.stringify({ enabled: [...this.#enabled], known: [...this.#all.keys()] })); } catch { /* read-only data dir */ } }
  }

  books(now: number): ValuedBook[] {
    const out: ValuedBook[] = [];
    for (const id of this.#enabled) { const book = this.#all.get(id)!.valued(now); if (book) out.push(book); }
    return out;
  }
  /** Market rows in the shape of the server's market registry, for the market selector. */
  markets(): Record<string, unknown>[] {
    return [...this.#enabled].map(id => { const c = this.#all.get(id)!; return { id: c.instrumentId, instrumentId: c.instrumentId, venue: c.id, exchange: c.id, symbol: c.symbol, nativeSymbol: c.symbol,
      base: c.base, quote: c.quote, marketType: c.marketType, quantityUnit: 'base', isFree: true }; });
  }
  close(): void { for (const id of [...this.#enabled]) this.#all.get(id)!.stop(); this.#enabled.clear(); }
}
