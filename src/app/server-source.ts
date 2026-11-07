import { connectLive, type LiveConnection, getAbsorption, getAbsorptionProfile, getBootstrap, getCandles, getColumns, getCoverage, getFlow, getFlowMinutes, getFootprint, getLiquidations, getLongShort, getOi, getOiProfile, getPriceHistory, getPrintSums, getPrints, getProfile, getRange, getSizes, getValueAreas } from './net.ts';
import type { BootstrapState, DataSource, VenueCatalog, VenueControl, VenueEntry } from './source.ts';
import { stateOfStatus } from './venue-notice.ts';
import { currentCoin } from './coin.ts';
import { PriceHistoryCache, priceListing, priceTimeframeMs, type PriceHistoryAnswer } from '../shared/price-history.ts';
import { webGet } from '../shared/history.ts';

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

/** How long a long/short question waits for the live socket to say whether it answers them (it connects as the page loads). */
const LS_SOCKET_WAIT_MS = 4_000;

/** The local server (`npm run dev:server`): live frames over one WebSocket, history from SQLite behind `/api/v2/*`. */
export class ServerSource implements DataSource {
  readonly kind = 'server' as const;
  readonly venues = new ServerVenues();
  /** The server's answer, plus the open-interest reference the page used to assume. */
  bootstrap = async (): Promise<BootstrapState> => { const boot = await getBootstrap(); return { ...boot, oiReferences: boot.oiReferences ?? ['binance:BTCUSDT'] }; };
  /** The live connection, once connected: long/short questions are asked on it where its server answers them there. */
  #live: LiveConnection | null = null;
  #setConnected!: (live: LiveConnection) => void;
  readonly #connected = new Promise<LiveConnection>(resolve => { this.#setConnected = resolve; });
  connect: DataSource['connect'] = handlers => { const live = this.#live = connectLive(handlers); this.#setConnected(live); return live; };
  candles = getCandles;
  readonly #price = new PriceHistoryCache(webGet);
  /**
   * The white price line's history, read by the page from the exchange itself (as the VWAP's and the profiles' candles are), the server's
   * route only where that cannot (a venue it cannot read, a read that failed). Through the server it waited behind the page's other history
   * requests for one of the browser's six connections to it: a zoom out set off a burst of them and the line's request ran 25 s and gave
   * up, where the same window read from Binance takes 0.4 s (measured 2026-10-24; the VWAP's candles, which go straight there, were
   * all in within 0.5 s of the same zoom).
   */
  priceHistory = async (inst: string, tf: string, from: number, to: number, signal?: AbortSignal): Promise<PriceHistoryAnswer> => {
    const target = priceListing(currentCoin(), inst), tfMs = priceTimeframeMs(tf);
    let held: PriceHistoryAnswer | null = null;
    if (target && tfMs) {
      try {
        const answer = await this.#price.series(target, tfMs, from, to);
        if (answer.status === 'ok' || answer.status === 'empty') return answer;
        held = answer;
      } catch { /* the server's route below */ }
    }
    // A read that failed (a window the page's cache holds only some of, the exchange refusing): the server's cache may hold the whole of it. What
    // the page holds still stands, marked stale, where the server cannot answer either.
    try { return await getPriceHistory(inst, tf, from, to, signal); } catch (error) { if (held?.status === 'stale') return held; throw error; }
  };
  oi = getOi;
  /**
   * On the live socket where the server answers there: a page's HTTP requests to the server wait behind its history requests for one of the
   * browser's six connections, twenty seconds and more while it loads (2026-10-23). Over HTTP otherwise (a server from before, no socket).
   */
  longShort: DataSource['longShort'] = async (inst, metric, tf, from, to, signal, budgetMs) => {
    // While the socket connects (a page loading, even before it is opened) a question waits a little for it rather than join the HTTP queue.
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const live = this.#live ?? await Promise.race([this.#connected, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), LS_SOCKET_WAIT_MS); })]);
    clearTimeout(timer);
    const onSocket = live && await live.lsReadyWithin(Math.max(0, LS_SOCKET_WAIT_MS - (Date.now() - started))) ? live.longShort(inst, metric, tf, from, to, budgetMs, signal) : null;
    if (!onSocket) return getLongShort(inst, metric, tf, from, to, signal, budgetMs);
    // A socket that closed under it, or a server that had too many at once: asked over HTTP instead. Given up by its asker: not asked again.
    return onSocket.catch((error: unknown) => {
      if (signal?.aborted || (error instanceof Error && error.message === 'cancelled')) throw error;
      return getLongShort(inst, metric, tf, from, to, signal, budgetMs);
    });
  };
  /** On the live socket where the server answers it there (a page's HTTP requests wait behind its history requests); otherwise it rejects, and the pane reads the columns. */
  ltLane: NonNullable<DataSource['ltLane']> = async (ids, from, to, stepMs, half, onFrame, signal) => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const live = this.#live ?? await Promise.race([this.#connected, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), LS_SOCKET_WAIT_MS); })]);
    clearTimeout(timer);
    const asked = live && await live.lsReadyWithin(Math.max(0, LS_SOCKET_WAIT_MS - (Date.now() - started))) ? live.ltLane(ids, from, to, stepMs, half, onFrame, signal) : null;
    if (!asked) throw new Error('unsupported');
    return asked;
  };
  prints = getPrints;
  liquidations = getLiquidations;
  printSums = getPrintSums;
  columns = getColumns;
  footprint = getFootprint;
  flow = getFlow;
  flowMinutes = getFlowMinutes;
  sizes = getSizes;
  profile = getProfile;
  oiProfile = getOiProfile;
  range = getRange;
  valueAreas = getValueAreas;
  absorption = getAbsorption;
  absorptionProfile = getAbsorptionProfile;
  coverage = getCoverage;
}
