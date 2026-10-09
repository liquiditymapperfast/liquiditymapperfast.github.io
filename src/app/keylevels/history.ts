import { CANDLE_VENUES, fetchCandles, type Fetcher } from '../../shared/history.ts';
import type { Coin, Listing, MarketVenue } from '../../shared/coins.ts';
import type { CandleRow } from '../store.ts';

/**
 * The hourly candles the key levels are worked out from, read from the exchange's own history (the server keeps no more than a few weeks of
 * minutes, and a page reading the exchanges itself none): the market on the chart where its history can be read, else the first of the usual
 * ones that lists the coin. One stretch of candles is held, reaching back as far as the chart needs (at most about two months); it is extended
 * back when the chart reaches further, and its newest hours are asked again every few minutes. Never asked on a frame: `ensure` returns at once
 * while a request is out, and a failed one waits a minute.
 */

const HOUR = 3_600_000, DAY = 86_400_000;
/** How often the newest hours are asked again (the developing levels move with the chart's own candles in between). */
const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 60_000;
/** The markets tried, in this order, when the chart's own history cannot be read: the most traded first. */
const FALLBACK: readonly MarketVenue[] = ['binance', 'bybit', 'okx', 'hyperliquid', 'bitget', 'binancespot', 'coinbase', 'bybitspot', 'okxspot', 'bitgetspot', 'deribit'];

/** The market the candles are read from, how the coin is listed there, and whether it is the chart's own market. */
export interface HistoryTarget { id: string; listing: Listing; own: boolean }

/**
 * Whose candles the levels come from for a chart showing `chartId`: that market (a server names Binance spot `binance:BTCUSDT:spot`) when its
 * history can be read and the coin is listed there, else the first of FALLBACK that lists it. Null when none does.
 */
export function historyTarget(chartId: string, markets: Coin['markets']): HistoryTarget | null {
  const spot = /^([^:]+):.+:spot$/.exec(chartId);
  const own = spot ? `${spot[1]}spot` : chartId.split(':')[0]!;
  for (const venue of [own, ...FALLBACK]) {
    if (!CANDLE_VENUES.includes(venue)) continue;
    const listing = markets[venue as MarketVenue];
    if (listing) return { id: `${venue}:${listing.symbol}`, listing, own: venue === own };
  }
  return null;
}

export class KeyLevelHistory {
  #id = '';
  #bars: CandleRow[] = [];
  /** The earliest start asked for (so a history that does not reach further is not asked again for it). */
  #askedFrom = Infinity;
  #refreshedAt = 0;
  #pending = false;
  #retryAt = 0;
  /** Bumped whenever the bars change, for the pane's cache. */
  version = 0;
  state: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle';

  constructor(private get: Fetcher, private now: () => number = Date.now) {}

  get id(): string { return this.#id; }
  /** Hourly candles, oldest first. */
  get bars(): readonly CandleRow[] { return this.#bars; }

  /** Make sure candles of `target` from `from` are held or on their way; `onLoad` runs when an answer changes them. */
  ensure(target: HistoryTarget | null, from: number, onLoad: () => void): void {
    if (!target) { if (this.#id) { this.#reset(''); this.version++; } return; }
    if (target.id !== this.#id) { this.#reset(target.id); this.version++; }
    const now = this.now();
    if (this.#pending || now < this.#retryAt) return;
    const want = Math.floor(from / DAY) * DAY;
    let a: number, b: number, forward = false;
    if (!this.#bars.length) { a = want; b = now; forward = true; }
    else if (want < this.#askedFrom) { a = want; b = this.#bars[0]![0]; }
    else if (now - this.#refreshedAt >= REFRESH_MS) { a = this.#bars[this.#bars.length - 1]![0] - 2 * HOUR; b = now; forward = true; }
    else return;
    const id = this.#id;
    this.#pending = true; if (!this.#bars.length) this.state = 'loading';
    void fetchCandles(id, HOUR, a, b, this.get, target.listing).then(rows => {
      if (id !== this.#id) return;
      this.#askedFrom = Math.min(this.#askedFrom, a);
      if (forward) this.#refreshedAt = this.now();
      if (rows.length) this.#merge(rows as CandleRow[]);
      else if (!this.#bars.length) this.#retryAt = this.now() + RETRY_MS;
      this.state = this.#bars.length ? 'ready' : 'unavailable';
      onLoad();
    }, () => {
      if (id !== this.#id) return;
      this.#retryAt = this.now() + RETRY_MS;
      this.state = this.#bars.length ? 'ready' : 'unavailable';
      onLoad();
    }).finally(() => { if (id === this.#id) this.#pending = false; });
  }

  #merge(rows: readonly CandleRow[]): void {
    const byStart = new Map<number, CandleRow>(this.#bars.map(r => [r[0], r]));
    for (const r of rows) if (Number.isFinite(r[0]) && r[2] >= r[3]) byStart.set(r[0], r);
    this.#bars = [...byStart.values()].sort((x, y) => x[0] - y[0]);
    this.version++;
  }

  #reset(id: string): void { this.#id = id; this.#bars = []; this.#askedFrom = Infinity; this.#refreshedAt = 0; this.#pending = false; this.#retryAt = 0; this.state = id ? 'loading' : 'idle'; }
}
