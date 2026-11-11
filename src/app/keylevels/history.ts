import { CANDLE_VENUES, readCandles, type Fetcher } from '../../shared/history.ts';
import { instrumentIdFor, type Coin, type Listing, type MarketVenue } from '../../shared/coins.ts';
import type { CandleRow } from '../store.ts';
import { MAX_BACK_MS } from './levels.ts';

/**
 * The candles the key levels are worked out from (hourly, or finer in a zone off the hour: `barMsFor`), read from the exchange's own history
 * (the server keeps no more than a few weeks of minutes, and a page reading the exchanges itself none): the market on the chart where its
 * history can be read, else the first of the usual ones that lists the coin. One stretch of candles is held, reaching back as far as the chart
 * needs (at most about two months); it is extended back when the chart reaches further, a request of at most MAX_PAGES pages at a time
 * until it gets there or the exchange has nothing older, and its newest bars are asked again every few minutes. `heldTo` is the time the
 * last successful request reached, so a period ending after it is not taken as complete. Bars older than the levels can reach are dropped.
 * Never asked on a frame: `ensure` returns at once while a request is out, and a failed one waits a minute.
 */

const HOUR = 3_600_000, DAY = 86_400_000;
/** How often the newest bars are asked again by default (the developing levels move with the chart's own candles in between). */
const REFRESH_MS = 5 * 60_000;
const RETRY_MS = 60_000;
/** Pages one request may walk back: Coinbase gives 300 bars a page, so two months of half hours take 10. */
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

/**
 * Whose candles the volume profile's days, weeks and sessions are worked out from when they come from candles: the most traded market that
 * lists the coin (Binance's perpetual first), whatever the chart shows, so the lines of one coin do not change with the chart's market.
 */
export function profileTarget(coin: Coin): HistoryTarget | null {
  for (const venue of FALLBACK) {
    const listing = coin.markets[venue], id = instrumentIdFor(venue, coin);
    if (CANDLE_VENUES.includes(venue) && listing && id) return { id, listing, own: false };
  }
  return null;
}

/**
 * The spot market whose candles join the perpetual's in the volume profile: Binance spot beside Binance's perpetual, more of the coin's
 * trading split the same way by its taker buys. Null where the target is another venue's or the coin has no Binance spot market.
 */
export function profileCompanion(coin: Coin, target: HistoryTarget | null): HistoryTarget | null {
  if (!target || !target.id.startsWith('binance:')) return null;
  const listing = coin.markets.binancespot, id = instrumentIdFor('binancespot', coin);
  return CANDLE_VENUES.includes('binancespot') && listing && id ? { id, listing, own: false } : null;
}

export class KeyLevelHistory {
  #key = '';
  #id = '';
  #barMs = HOUR;
  #bars: CandleRow[] = [];
  /**
   * How far back the reads have answered for, bars or none (`CandleRead.coveredFrom`): before the first bar there can be time nobody traded,
   * which a venue answering for a window says. What is not asked again.
   */
  #coveredFrom = Infinity;
  /** The time the last successful request of the newest bars reached. */
  #heldTo = -Infinity;
  /** Set when a page short of its limit said the venue has nothing older: the exchange's history begins there. */
  #exhausted = false;
  /**
   * The market's first bar, as the read that said so held it (`listedFrom`): kept when the bars older than the history keeps are let go, which
   * moves the first bar held on but not the start of the market's trading.
   */
  #listedFrom: number | null = null;
  /** Set when the venue serves no older bars to a page (Bitget's month of minutes, Hyperliquid's newest 5,000): neither a start nor a gap. */
  #limited = false;
  #refreshedAt = 0;
  #pending = false;
  /** Counts the requests made, so a request settling clears only its own `#pending`, never the one a callback has started since. */
  #asks = 0;
  #retryAt = 0;
  /** Bumped whenever the bars change, for the pane's cache. */
  version = 0;
  /** Counts the reads that have settled, answered or failed: what is worked out from `reach` (a failed walk back, a minute's wait) is asked again. */
  settled = 0;
  /** Whether the bars carry their taker buys where the venue reports them (the volume profile's, for its split). */
  withBuy = false;
  state: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle';

  /**
   * `refreshMs`: how often the newest bars are asked again (the VWAP wants them every minute). `maxBackMs`: how far back bars are kept
   * (the key levels' two months; the volume profile's past weeks reach further).
   */
  constructor(private get: Fetcher, private now: () => number = Date.now, private refreshMs: number = REFRESH_MS, private maxBackMs: number = MAX_BACK_MS) {}

  get id(): string { return this.#id; }
  get barMs(): number { return this.#barMs; }
  /** The bars, oldest first. */
  get bars(): readonly CandleRow[] { return this.#bars; }
  /** Where the bars held begin (Infinity while there are none). */
  get heldFrom(): number { return this.#bars[0]?.[0] ?? Infinity; }
  /** Up to when the bars held are known: the time the last successful request of the newest ones was made. */
  get heldTo(): number { return this.#heldTo; }
  /** Whether a page short of its limit said the venue has nothing older: the exchange's history begins where the bars held do. */
  get exhausted(): boolean { return this.#exhausted; }
  /**
   * Where the market's trading begins, where a read reached its first bar (`exhausted`): nothing traded before it. Null where that is not
   * known. Not `heldFrom`, which moves on as old bars are let go: the time between was traded, just not kept (Sol, code review 2026-11-10,
   * round 4: a script's old candles read as before the listing, 0, after six days of keeping 2,000 bars).
   */
  get listedFrom(): number | null { return this.#exhausted ? this.#listedFrom : null; }
  /** Whether the venue serves no older bars to a page: the history cannot be read further back, though the market traded before. */
  get limited(): boolean { return this.#limited; }
  /** The oldest time this history keeps bars of: nothing before it is ever held. */
  get keptFrom(): number { return this.#keptFrom(); }
  /**
   * Where the bars are known from: the first bar, or before it as far back as the reads answered for time nobody traded in (Infinity while
   * nothing is held). A line that starts at or after it is worked out over every bar there was.
   */
  get knownFrom(): number { return this.#bars.length ? Math.min(this.#coveredFrom, this.heldFrom) : Infinity; }

  /**
   * Whether the bars held reach back to `from` (`knownFrom`): 'yes'; 'coming' when they do not yet and may (a request is out, or one can still be
   * asked); 'never' when they will not (the exchange's history begins later or cannot be read further back, nothing could be read at all, or
   * the next try is a minute off).
   */
  reach(from: number): 'yes' | 'coming' | 'never' {
    if (this.knownFrom <= from) return 'yes';
    // Further back than the history keeps bars: it never holds that.
    if (this.state === 'unavailable' || this.#exhausted || this.#limited || from < this.#keptFrom()) return 'never';
    if (this.#pending || this.state === 'loading' || this.state === 'idle') return 'coming';
    return this.now() < this.#retryAt ? 'never' : 'coming';
  }

  /** Make sure `barMs` candles of `target` from `from` are held or on their way; `onLoad` runs when an answer changes them. */
  ensure(target: HistoryTarget | null, from: number, barMs: number, onLoad: () => void): void {
    const key = target ? `${target.id}|${barMs}` : '';
    if (key !== this.#key) { this.#reset(key, target?.id ?? '', barMs); this.version++; }
    if (!target) return;
    const now = this.now();
    if (this.#pending || now < this.#retryAt) return;
    // From the day's start, never from before what the history keeps (bars read there would be let go at once, and asked for again).
    const want = Math.max(Math.floor(from / DAY) * DAY, this.#keptFrom());
    let a: number, b: number, forward = false;
    const first = !this.#bars.length;
    if (first) { a = want; b = now; forward = true; }
    else if (want < this.knownFrom && !this.#exhausted && !this.#limited) { a = want; b = this.knownFrom; }
    else if (now - this.#refreshedAt >= this.refreshMs) { a = this.#bars[this.#bars.length - 1]![0] - 2 * barMs; b = now; forward = true; }
    else return;
    const asked = this.#key, before = this.knownFrom;
    this.#pending = true; if (!this.#bars.length) this.state = 'loading';
    const ask = ++this.#asks;
    // A page that fails after others came keeps them, the next call asking on back from where they reach: on the first load and the walks
    // further back, never on a refresh of the newest bars, where what came could lie apart from what is held and leave a hole.
    const partial = !forward || !this.#bars.length;
    void readCandles(target.id, barMs, a, b, this.get, target.listing, MAX_PAGES, { pageSize: 1500, partial, buy: this.withBuy, now, strict: 'drop' }).then(read => {
      if (asked !== this.#key) return;
      const rows = read.rows;
      if (forward) this.#refreshedAt = this.now();
      if (rows.length) { this.#merge(rows as CandleRow[]); if (forward) this.#heldTo = Math.max(this.#heldTo, b); }
      else if (!this.#bars.length) this.#retryAt = this.now() + RETRY_MS;
      // The first load and the walks back answer for time back to where their pages reached, bars or none; the next call asks on from there.
      // A page short of its limit: the exchange's history begins here; a venue that serves nothing older: as far as it can be read. A walk
      // that got no further (the page ceiling with nothing new, a page that failed first) is not asked again for a minute.
      const covered = this.#coveredFrom;
      if (!forward || first) this.#coveredFrom = Math.max(Math.min(this.#coveredFrom, read.coveredFrom), this.#keptFrom());
      // What the bars are known from is part of what the lines are read from: a read that only answered for quiet time changes them too.
      if (this.#coveredFrom !== covered) this.version++;
      if (read.stop === 'start') { this.#exhausted = true; if (this.#listedFrom === null && this.#bars.length) this.#listedFrom = this.heldFrom; }
      if (read.stop === 'limited') this.#limited = true;
      // A walk back that got no further, whatever it says of itself (the page ceiling with nothing new, a page that failed first, a reach let
      // go at once for being older than the history keeps): not asked again for a minute.
      if (!forward && !(this.knownFrom < before) && !this.#exhausted && !this.#limited) this.#retryAt = this.now() + RETRY_MS;
      this.state = this.#bars.length ? 'ready' : 'unavailable';
      // Settled before it is said: what `onLoad` reads (`reach`) is then the answer's, not "a request is out".
      this.#pending = false; this.settled++;
      onLoad();
    }, () => {
      if (asked !== this.#key) return;
      this.settled++;
      this.#retryAt = this.now() + RETRY_MS;
      this.state = this.#bars.length ? 'ready' : 'unavailable';
      this.#pending = false;
      onLoad();
    }).finally(() => { if (asked === this.#key && ask === this.#asks) this.#pending = false; });
  }

  /** The oldest time the history keeps bars of (a page open for weeks would otherwise keep every bar it ever read). */
  #keptFrom(): number { return this.now() - this.maxBackMs - DAY; }

  #merge(rows: readonly CandleRow[]): void {
    const byStart = new Map<number, CandleRow>(this.#bars.map(r => [r[0], r])), oldest = this.#keptFrom();
    for (const r of rows) if (Number.isFinite(r[0]) && r[2] >= r[3]) byStart.set(r[0], r);
    // A page open for weeks would otherwise keep every bar it ever read: none older than the levels can reach is kept.
    this.#bars = [...byStart.values()].filter(r => r[0] >= oldest).sort((x, y) => x[0] - y[0]);
    // Nor is what was read of the time before: the bars of it are gone.
    this.#coveredFrom = Math.max(this.#coveredFrom, oldest);
    this.version++;
  }

  #reset(key: string, id: string, barMs: number): void {
    this.#key = key; this.#id = id; this.#barMs = barMs; this.#bars = []; this.#coveredFrom = Infinity; this.#heldTo = -Infinity; this.#exhausted = false; this.#listedFrom = null; this.#limited = false;
    this.#refreshedAt = 0; this.#pending = false; this.#retryAt = 0; this.state = id ? 'loading' : 'idle';
  }
}
