import { CANDLE_VENUES, fetchCandles, type Fetcher } from '../../shared/history.ts';
import { instrumentIdFor, type Coin, type Listing, type MarketVenue } from '../../shared/coins.ts';
import type { CandleRow } from '../store.ts';

/**
 * The candles the key levels are worked out from (hourly, or finer in a zone off the hour: `barMsFor`), read from the exchange's own history
 * (the server keeps no more than a few weeks of minutes, and a page reading the exchanges itself none): the market on the chart where its
 * history can be read, else the first of the usual ones that lists the coin. One stretch of candles is held, reaching back as far as the chart
 * needs (at most about two months); it is extended back when the chart reaches further, until the exchange has nothing older, and its newest
 * bars are asked again every few minutes. Never asked on a frame: `ensure` returns at once while a request is out, and a failed one waits a
 * minute.
 */

const HOUR = 3_600_000, DAY = 86_400_000;
/** How often the newest bars are asked again (the developing levels move with the chart's own candles in between). */
const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 60_000;
/** Pages one request may walk back: OKX gives 100 bars a page, so two months of hours take 15. */
const MAX_PAGES = 24;
/** The markets tried, in this order, when the chart's own history cannot be read: the most traded first. */
const FALLBACK: readonly MarketVenue[] = ['binance', 'bybit', 'okx', 'hyperliquid', 'bitget', 'binancespot', 'coinbase', 'bybitspot', 'okxspot', 'bitgetspot', 'deribit'];

/** The market the candles are read from, how the coin is listed there, and whether it is the chart's own market. */
export interface HistoryTarget { id: string; listing: Listing; own: boolean }

/**
 * Whose candles the levels come from for a chart showing `chartId`: that very market when its history can be read (a server names Binance
 * spot `binance:BTCUSDT:spot`), else the first of FALLBACK that lists the coin. Another market of the chart's venue (OKX spot under `okx`, a
 * coin-margined contract under `binance`) is not the chart's own. Null when no market of the coin has a history this page can read.
 */
export function historyTarget(chartId: string, coin: Coin): HistoryTarget | null {
  const spot = /^([^:]+):(.+):spot$/.exec(chartId);
  const chart = spot ? `${spot[1]}spot:${spot[2]}` : chartId;
  const venues = [chart.split(':')[0]!, ...FALLBACK];
  for (let i = 0; i < venues.length; i++) {
    const venue = venues[i]!, listing = coin.markets[venue as MarketVenue], id = instrumentIdFor(venue, coin);
    if (!CANDLE_VENUES.includes(venue) || !listing || !id || (i === 0 && id !== chart)) continue;
    return { id, listing, own: id === chart };
  }
  return null;
}

export class KeyLevelHistory {
  #key = '';
  #id = '';
  #barMs = HOUR;
  #bars: CandleRow[] = [];
  /** The earliest start asked for (so a history that does not reach further is not asked again for it). */
  #askedFrom = Infinity;
  /** Set when asking further back brought nothing older: the exchange's history begins there. */
  #exhausted = false;
  #refreshedAt = 0;
  #pending = false;
  #retryAt = 0;
  /** Bumped whenever the bars change, for the pane's cache. */
  version = 0;
  state: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle';

  constructor(private get: Fetcher, private now: () => number = Date.now) {}

  get id(): string { return this.#id; }
  get barMs(): number { return this.#barMs; }
  /** The bars, oldest first. */
  get bars(): readonly CandleRow[] { return this.#bars; }
  /** Where the bars held begin (Infinity while there are none). */
  get heldFrom(): number { return this.#bars[0]?.[0] ?? Infinity; }

  /** Make sure `barMs` candles of `target` from `from` are held or on their way; `onLoad` runs when an answer changes them. */
  ensure(target: HistoryTarget | null, from: number, barMs: number, onLoad: () => void): void {
    const key = target ? `${target.id}|${barMs}` : '';
    if (key !== this.#key) { this.#reset(key, target?.id ?? '', barMs); this.version++; }
    if (!target) return;
    const now = this.now();
    if (this.#pending || now < this.#retryAt) return;
    const want = Math.floor(from / DAY) * DAY;
    let a: number, b: number, forward = false;
    if (!this.#bars.length) { a = want; b = now; forward = true; }
    else if (want < this.#askedFrom && !this.#exhausted) { a = want; b = this.#bars[0]![0]; }
    else if (now - this.#refreshedAt >= REFRESH_MS) { a = this.#bars[this.#bars.length - 1]![0] - 2 * barMs; b = now; forward = true; }
    else return;
    const asked = this.#key, before = this.heldFrom;
    this.#pending = true; if (!this.#bars.length) this.state = 'loading';
    void fetchCandles(target.id, barMs, a, b, this.get, target.listing, MAX_PAGES).then(rows => {
      if (asked !== this.#key) return;
      this.#askedFrom = Math.min(this.#askedFrom, a);
      if (forward) this.#refreshedAt = this.now();
      if (rows.length) this.#merge(rows as CandleRow[]);
      else if (!this.#bars.length) this.#retryAt = this.now() + RETRY_MS;
      if (!forward && !(this.heldFrom < before)) this.#exhausted = true;
      this.state = this.#bars.length ? 'ready' : 'unavailable';
      onLoad();
    }, () => {
      if (asked !== this.#key) return;
      this.#retryAt = this.now() + RETRY_MS;
      this.state = this.#bars.length ? 'ready' : 'unavailable';
      onLoad();
    }).finally(() => { if (asked === this.#key) this.#pending = false; });
  }

  #merge(rows: readonly CandleRow[]): void {
    const byStart = new Map<number, CandleRow>(this.#bars.map(r => [r[0], r]));
    for (const r of rows) if (Number.isFinite(r[0]) && r[2] >= r[3]) byStart.set(r[0], r);
    this.#bars = [...byStart.values()].sort((x, y) => x[0] - y[0]);
    this.version++;
  }

  #reset(key: string, id: string, barMs: number): void {
    this.#key = key; this.#id = id; this.#barMs = barMs; this.#bars = []; this.#askedFrom = Infinity; this.#exhausted = false;
    this.#refreshedAt = 0; this.#pending = false; this.#retryAt = 0; this.state = id ? 'loading' : 'idle';
  }
}
