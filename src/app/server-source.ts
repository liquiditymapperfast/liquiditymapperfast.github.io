import { connectLive, getAbsorption, getBootstrap, getCandles, getColumns, getFlow, getFlowMinutes, getFootprint, getOi, getPrints, getProfile, getRange, getSizes, getValueAreas } from './net.ts';
import type { BootstrapState, DataSource, VenueCatalog, VenueControl, VenueEntry } from './source.ts';
import { stateOfStatus } from './venue-notice.ts';

interface FeedCatalog { maxSelected: number; selectedVenues: string[]; venues: { id: string; name: string; supported: boolean; default?: boolean; status: string }[] }
interface ExtraVenueInfo { id: string; name: string; enabled: boolean; default?: boolean; state: string; lastError: string | null; reconnects: number }
interface ExtraCatalog { venues: ExtraVenueInfo[] }

function extraStatus(v: ExtraVenueInfo): string {
  if (!v.enabled) return 'off';
  if (v.state !== 'live') return v.lastError ? `${v.state}: ${v.lastError}` : v.state;
  return v.reconnects > 0 ? `live, ${v.reconnects} reconnects` : 'live';
}

/** How often the page asks the server which of the chosen venues are not drawing. */
const VENUE_POLL_MS = 10_000;

const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${url} failed (${response.status})`);
  return body;
};

/** The server's venues are two lists: the feed manager's catalogue and the self-contained connectors. The page sees one. */
class ServerVenues implements VenueControl {
  #feed = new Set<string>();
  #selectedFeed = new Set<string>();

  async catalog(): Promise<VenueCatalog> {
    const [feed, extra] = await Promise.all([json<FeedCatalog>('/api/orderbooks/venues'), json<ExtraCatalog>('/api/v2/venues')]);
    this.#feed = new Set(feed.venues.map(v => v.id)); this.#selectedFeed = new Set(feed.selectedVenues);
    const venues: VenueEntry[] = [
      ...feed.venues.map(v => ({ id: v.id, name: v.name, supported: v.supported, recommended: v.default === true, selected: this.#selectedFeed.has(v.id), status: v.status, state: stateOfStatus(v.status) })),
      ...extra.venues.map(v => ({ id: v.id, name: v.name, supported: true, recommended: v.default === true, selected: v.enabled, status: extraStatus(v), state: stateOfStatus(extraStatus(v)) })),
    ];
    // An older server marks only the four venues it used to start (and no connector venue) as default, which is not the recommended set:
    // the current server always says it for the connector venues too, so that is what the Recommended button waits for.
    return { venues, limit: feed.maxSelected, recommendedKnown: extra.venues.some(v => typeof v.default === 'boolean') };
  }

  /** A server cannot push venue changes, so the page asks now and then: a venue that is chosen but has no book gets a chip that says why. */
  watch(listener: (venues: VenueEntry[]) => void): () => void {
    let stopped = false;
    const poll = (): void => { void this.catalog().then(catalog => { if (!stopped) listener(catalog.venues); }, () => { /* the dialog says when the catalogue is unavailable; the chips just wait */ }); };
    const timer = window.setInterval(poll, VENUE_POLL_MS); window.setTimeout(poll, 4_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }

  async apply(selected: readonly string[], product: string): Promise<void> {
    const wanted = new Set(selected);
    const extra = selected.filter(id => !this.#feed.has(id)), feed = selected.filter(id => this.#feed.has(id));
    await json('/api/v2/venues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: extra }) });
    // Changing the feed selection restarts every feed (about 13 s), so an unchanged set is not re-posted.
    if (feed.length !== this.#selectedFeed.size || feed.some(id => !this.#selectedFeed.has(id))) {
      await json('/api/orderbooks/selection', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instrumentId: product, venues: feed }) });
      this.#selectedFeed = new Set(feed.filter(id => wanted.has(id)));
    }
  }
}

/** The local server (`npm run dev:server`): live frames over one WebSocket, history from SQLite behind `/api/v2/*`. */
export class ServerSource implements DataSource {
  readonly kind = 'server' as const;
  readonly venues = new ServerVenues();
  /** The server's answer, plus the open-interest reference the page used to assume. */
  bootstrap = async (): Promise<BootstrapState> => { const boot = await getBootstrap(); return { ...boot, oiReferences: boot.oiReferences ?? ['binance:BTCUSDT'] }; };
  connect: DataSource['connect'] = handlers => connectLive(handlers);
  candles = getCandles;
  oi = getOi;
  prints = getPrints;
  columns = getColumns;
  footprint = getFootprint;
  flow = getFlow;
  flowMinutes = getFlowMinutes;
  sizes = getSizes;
  profile = getProfile;
  range = getRange;
  valueAreas = getValueAreas;
  absorption = getAbsorption;
}
