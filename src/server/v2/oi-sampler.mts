import { fetchOiHistory, fetchOiReading, venueOf, webGet, type Fetcher, type HistoryListing } from '../../shared/history.ts';
import { unitOf, type CoinVenue } from '../../shared/coins.ts';

/**
 * Open interest of the perpetuals the feed manager does not read (it reads Binance's and Hyperliquid's): Bybit, OKX, Bitget and Deribit,
 * in coins, for the aggregated open interest. Each is read once a minute while its book is live; Bybit's and OKX's history is read first
 * and written straight to the history store (two days at 5 minutes, hourly before that to eight days), so their bars reach back at once;
 * a history read that fails is tried again later (backing off to an hour). Bitget's and Deribit's build up from when sampling starts. A
 * live reading goes through the server's own reducer as Binance's does, so the OI route answers it with the stored bars.
 *
 * Bybit and OKX open interest normally arrives on their WebSocket feeds (live-feeds.mts); this sampler is their fallback. While a venue's
 * feed is not live (`setFast`), that venue is read every five seconds instead of once a minute, and back to the minute once the feed
 * returns. Every venue's failures are counted, said in `status()` (the diagnostics route) and logged at most once every ten minutes, so
 * a dead endpoint is never silent.
 */
export const SAMPLED_OI_VENUES: readonly string[] = ['bybit', 'okx', 'bitget', 'deribit'];
export const OI_SAMPLE_MS = 60_000;
/** A sampled venue whose WebSocket OI feed is down is read this often until the feed returns. */
export const OI_FALLBACK_MS = 5_000;
/** History read at start: five-minute bars this far back, hourly ones before them to `HISTORY_HOURLY_MS`. */
const HISTORY_FINE_MS = 2 * 86_400_000, HISTORY_HOURLY_MS = 8 * 86_400_000;
/** History rows written to the store per turn of the event loop. */
const ROWS_PER_TURN = 200;
/** A failed history read is tried again after a minute, doubling to at most an hour. */
const RETRY_MS = 60_000, RETRY_MAX_MS = 3_600_000;
/** Failures of one venue are logged at most this often. */
const OI_LOG_EVERY_MS = 10 * 60_000;

export interface OiSampleMessage { kind: 'openInterest'; instrumentId: string; sourceTimestamp: number | null; observationTimestamp?: number; receivedAt: number; base: number; quality: 'native' | 'sampled'; source?: string }

/** One sampled venue's outcome, for the diagnostics route. */
export interface OiVenueStatus { lastSuccess: number | null; failures: number; lastError: string | null; nextHistoryAt: number | null; fast: boolean }

/**
 * How a perpetual lists its coin, from its own instrument id (`venue:SYMBOL`): its symbol, its unit as the coin list reads it (1000PEPEUSDT and
 * Bybit's SHIB1000USDT count thousands), and Deribit's coin-margined perpetuals (BTC-PERPETUAL, ETH-PERPETUAL; the X_USDC-PERPETUAL ones are linear). Null for an
 * id that names no single perpetual (a spot market's `:spot` suffix).
 */
export function oiListingOf(id: string): HistoryListing | null {
  const parts = id.split(':'); if (parts.length !== 2 || !parts[1]) return null;
  const [venue, symbol] = parts as [string, string];
  // The market's name for the base, then its unit as the coin list reads it (1000PEPE, Bybit's SHIB1000).
  // Bybit's coin-margined perpetuals (BTCUSD, a server's BYBIT_CATEGORY=inverse) count open interest in USD, as Deribit's do.
  const bybitInverse = venue === 'bybit' && /^[A-Z0-9]+USD$/.test(symbol);
  const base = venue === 'okx' ? symbol.split('-')[0]! : venue === 'deribit' ? symbol.replace(/-PERPETUAL$/, '').replace(/_USDC$/, '') : symbol.replace(/(USDT|USDC|USD)$/, '');
  return { symbol, unit: unitOf(base, venue as CoinVenue)[1], ...((venue === 'deribit' && /^[A-Z]+-PERPETUAL$/.test(symbol)) || bybitInverse ? { inverse: true } : {}) };
}

/**
 * The sampler's `record` for a history store: false only while the store has stopped writing (over its budget), so the history is read again
 * later. A row the store already holds is turned away too (a restart reads the history again over what it wrote before), and that is no
 * refusal: taking it as one stopped the read at its oldest row, so the stretch the server was down was never filled in.
 */
export function oiHistoryWriter(history: { persistenceSuspended: boolean; recordOi(message: Record<string, unknown>): unknown }): (message: OiSampleMessage) => boolean {
  return message => { if (history.persistenceSuspended) return false; history.recordOi({ ...message }); return !history.persistenceSuspended; };
}

export class OiSampler {
  #ids: string[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #fastTimer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null; #fastRunning: Promise<void> | null = null; #closed = false;
  /** Each instrument's history: read, or when to try again and how many times it failed. */
  readonly #history = new Map<string, { done: boolean; tries: number; nextAt: number }>();
  /** Per venue: the last outcome, for the diagnostics route and the ten-minute failure log. */
  readonly #status = new Map<string, OiVenueStatus>();
  readonly #logged = new Map<string, number>();
  /** Venues whose WebSocket OI feed is not live: read every five seconds until it returns. */
  #fast = new Set<string>();
  /** When each instrument was last asked (the fast rounds gate on it). */
  readonly #lastAsked = new Map<string, number>();
  readonly #log: (message: string) => void;

  /**
   * `apply` hands a live reading to the server's reducer; `record` writes a history row to the store (false: refused). `get` and `now` are the network and
   * the clock (tests pass fakes). `log` receives the ten-minute failure lines.
   */
  constructor(private apply: (message: OiSampleMessage, venue: string) => void, private record: (message: OiSampleMessage) => unknown,
    private get: Fetcher = webGet, private now: () => number = Date.now, private everyMs = OI_SAMPLE_MS, log: (message: string) => void = message => console.warn(message)) {
    this.#log = log;
  }

  /** What each sampled venue did last, for the diagnostics route. */
  status(): Record<string, OiVenueStatus> {
    const out: Record<string, OiVenueStatus> = {};
    for (const venue of SAMPLED_OI_VENUES) {
      const held = this.#status.get(venue) ?? { lastSuccess: null, failures: 0, lastError: null, nextHistoryAt: null, fast: false };
      out[venue] = { ...held, fast: this.#fast.has(venue) };
    }
    return out;
  }

  /** Venues read every five seconds while their WebSocket OI feed is not live (only Bybit's and OKX's have one). */
  setFast(venues: readonly string[]): void {
    this.#fast = new Set(venues.filter(venue => venue === 'bybit' || venue === 'okx'));
  }

  /** The perpetuals whose book is live: those of the sampled venues are read from now on, the others are let go. */
  sync(ids: readonly string[]): void {
    if (this.#closed) return;
    this.#ids = [...new Set(ids.filter(id => SAMPLED_OI_VENUES.includes(venueOf(id)) && oiListingOf(id) !== null))].sort();
    if (this.#ids.length && !this.#timer) {
      this.#timer = setInterval(() => { void this.round(); }, this.everyMs);
      this.#timer.unref?.();
      this.#fastTimer = setInterval(() => { void this.roundFast(); }, OI_FALLBACK_MS);
      this.#fastTimer.unref?.();
      void this.round();
    } else if (!this.#ids.length && this.#timer) { clearInterval(this.#timer); this.#timer = null; clearInterval(this.#fastTimer!); this.#fastTimer = null; }
  }

  /** One reading of every instrument (after its history, when due); a round under way is the one returned. The timer calls it. */
  round(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#running ??= this.#round().finally(() => { this.#running = null; });
    return this.#running;
  }

  /** One reading of each fast (WebSocket-down) venue; a round under way is the one returned. The fast timer calls it. */
  roundFast(): Promise<void> {
    if (this.#closed || !this.#fast.size) return Promise.resolve();
    this.#fastRunning ??= this.#roundFast().finally(() => { this.#fastRunning = null; });
    return this.#fastRunning;
  }

  async #round(): Promise<void> {
    for (const id of this.#ids) await this.#read(id);
  }

  async #roundFast(): Promise<void> {
    for (const id of this.#ids) {
      const venue = venueOf(id);
      if (!this.#fast.has(venue)) continue;
      if (this.now() - (this.#lastAsked.get(id) ?? 0) < OI_FALLBACK_MS) continue;
      await this.#read(id);
    }
  }

  /** One instrument's history (when due) and its live reading. */
  async #read(id: string): Promise<void> {
    if (this.#closed) return;
    const venue = venueOf(id), listing = oiListingOf(id)!;
    const history = this.#history.get(id) ?? { done: false, tries: 0, nextAt: 0 };
    this.#history.set(id, history);
    const status = this.#statusOf(venue);
    if (!history.done && this.now() >= history.nextAt) {
      try { await this.#readHistory(id, venue, listing); history.done = true; status.nextHistoryAt = null; }
      catch (error) {
        history.tries++; history.nextAt = this.now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (history.tries - 1));
        status.nextHistoryAt = history.nextAt;
        this.#failure(venue, `${venue} open interest history read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.#closed) return;
    // An inverse market's reading keeps its own USD too (`quote`): the coins alone move with the price. The venue's own clock, where the
    // answer carries one, is kept as the sample's source time, so the reading lands in the minute the exchange stamped, not the one it
    // arrived in.
    this.#lastAsked.set(id, this.now());
    try {
      const reading = await fetchOiReading(venue, this.get, listing);
      if (reading !== null && !this.#closed) {
        this.apply({ kind: 'openInterest', instrumentId: id, sourceTimestamp: reading.sourceTimestamp ?? null, receivedAt: this.now(), base: reading.base, ...(reading.quote !== undefined ? { quote: reading.quote } : {}), quality: 'sampled', source: `${venue}-openInterest` }, venue);
        status.lastSuccess = this.now(); status.failures = 0; status.lastError = null;
      }
    } catch (error) { this.#failure(venue, `${venue} open interest sample failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  #statusOf(venue: string): OiVenueStatus {
    let status = this.#status.get(venue);
    if (!status) { status = { lastSuccess: null, failures: 0, lastError: null, nextHistoryAt: null, fast: false }; this.#status.set(venue, status); }
    return status;
  }

  /** Count a failure and log it at most every ten minutes, so a dead endpoint is visible without noise. */
  #failure(venue: string, message: string): void {
    const status = this.#statusOf(venue);
    status.failures++;
    status.lastError = message;
    if (this.now() - (this.#logged.get(venue) ?? -Infinity) >= OI_LOG_EVERY_MS) { this.#logged.set(venue, this.now()); this.#log(message + ` (${status.failures} in a row)`); }
  }

  /** The venue's history, oldest first, written to the store a few hundred rows a turn; throws when the venue could not be read. */
  async #readHistory(id: string, venue: string, listing: HistoryListing): Promise<void> {
    const now = this.now();
    const hourly = await fetchOiHistory(id, 3_600_000, now - HISTORY_HOURLY_MS, now - HISTORY_FINE_MS, this.get, listing);
    const fine = await fetchOiHistory(id, 300_000, now - HISTORY_FINE_MS, now, this.get, listing);
    const firstFine = fine.length ? Number(fine[0]!.start) : Infinity;
    const rows = [...hourly.filter(r => Number(r.start) < firstFine), ...fine];
    for (let i = 0; i < rows.length; i += ROWS_PER_TURN) {
      if (this.#closed) return;
      for (const r of rows.slice(i, i + ROWS_PER_TURN)) {
        const t = Number(r.start);
        // A store that refuses writes (over its budget: `recordOi` answers false) leaves the history to be read again later, not done.
        if (this.record({ kind: 'openInterest', instrumentId: id, sourceTimestamp: t, observationTimestamp: t, receivedAt: now, base: Number(r.close), quality: 'sampled', source: `${venue}-openInterestHistory` }) === false) throw new Error('the history store refused the rows');
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  close(): void { this.#closed = true; if (this.#timer) clearInterval(this.#timer); this.#timer = null; if (this.#fastTimer) clearInterval(this.#fastTimer); this.#fastTimer = null; }
}
