import { BinanceDiffDepthConnector, BookConnector, type Market } from './connector.ts';
import { BTC, EARLIER_BROWSER_VENUES, type Coin, type MarketVenue } from './coins.ts';
import { farSource } from './far-book.ts';
import { FullBook, fullSnapshotUrl, fullTopic, parseFullDelta, parseFullSnapshot, type FullAction, type SnapshotResult } from './bybit-full-book.ts';
import { BookSide } from './book-side.ts';
import { hyperliquidBookStep, hyperliquidLevelBounds } from '../analytics/hyperliquid-bounds.mts';

/**
 * The venues the browser connects to itself: public order-book and trade feeds for one coin (BTC unless the page was opened on another).
 * Each venue is one book connector plus, where the book's socket does not already carry trades, a feed for them. Sizes are converted to
 * USD here (contract sizes and USD-denominated amounts are venue facts), so everything downstream sees base-coin or USD figures.
 */

const num = (value: unknown): number => Number(value);
const iso = (value: unknown): number => Date.parse(String(value));

/** BTC on one market, as the page has always read it. */
const btc = (venue: MarketVenue): Market => ({ coin: 'BTC', ...BTC.markets[venue]! });

/** A connector for one coin on one market: the symbol is the market's own name for it. */
abstract class MarketBook extends BookConnector {
  declare protected readonly market: Market;
  constructor(market: Market) { super(market); }
  get symbol(): string { return this.market.symbol; }
}

/** A feed that only carries executions: it never has a book, but reconnects and reports its state like any connector. */
abstract class TradeFeed extends MarketBook {
  /** Executions come in bursts and a quiet minute is normal off-peak. */
  protected override silenceMs() { return 90_000; }
}

// ---- Binance ------------------------------------------------------------------------------------------------------------------------

/** Binance aggregate trades. The two markets differ only by address: spot on stream.binance.com, USD-M futures on the /market path (the legacy /ws path still serves depth but is silent for aggTrade and markPrice). */
abstract class BinanceTrades extends TradeFeed {
  onMessage(text: string) {
    const m = JSON.parse(text) as Record<string, unknown>;
    if (m.e !== 'aggTrade') return;
    const price = num(m.p), amount = num(m.q), t = num(m.T);
    if (!(price > 0) || !(amount > 0) || !Number.isFinite(t)) return;
    // m: the buyer was the maker, so the taker sold.
    this.emitTrade({ tradeId: String(m.a), side: m.m === true ? 'sell' : 'buy', price, amount, notionalUsd: price * amount, t });
    this.touch();
  }
}
export class BinanceSpotTrades extends BinanceTrades {
  readonly id = 'binancespot'; readonly name = 'Binance spot'; readonly quote = 'USDT'; readonly marketType = 'spot' as const;
  constructor(market: Market = btc('binancespot')) { super(market); }
  protected url() { return `wss://stream.binance.com:9443/ws/${this.symbol.toLowerCase()}@aggTrade`; }
  protected open() { /* the stream is chosen by the address */ }
}
export class BinancePerpTrades extends BinanceTrades {
  readonly id = 'binance'; readonly name = 'Binance'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('binance')) { super(market); }
  protected url() { return `wss://fstream.binance.com/market/ws/${this.symbol.toLowerCase()}@aggTrade`; }
  protected open() { /* the stream is chosen by the address */ }
}

/**
 * Binance USD-M liquidations: the forced orders of one market, at most one a second (the largest of that second, so a cascade is
 * undercounted). They can be silent for many minutes, so the same stream also carries the mark price every second: that is what keeps a
 * live socket from being taken for a dead one. `S` is the forced order's side (SELL closes a long) and `ap` its average fill price.
 */
export class BinanceLiquidations extends TradeFeed {
  readonly id = 'binance'; readonly name = 'Binance'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('binance')) { super(market); }
  protected url() { const s = this.symbol.toLowerCase(); return `wss://fstream.binance.com/market/stream?streams=${s}@forceOrder/${s}@markPrice@1s`; }
  protected open() { /* the streams are chosen by the address */ }
  onMessage(text: string) {
    const d = this.record(this.record(JSON.parse(text))?.data); if (!d) return;
    if (d.e === 'forceOrder') {
      const o = this.record(d.o); if (!o || o.s !== this.symbol) return;
      const price = num(o.ap) > 0 ? num(o.ap) : num(o.p), amount = num(o.z) > 0 ? num(o.z) : num(o.q), t = num(o.T);
      const side = o.S === 'SELL' ? 'long' : o.S === 'BUY' ? 'short' : null;
      if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitLiquidation({ t, side, price, amount, notionalUsd: price * amount, kind: 'fill' });
    }
    if (d.e === 'forceOrder' || d.e === 'markPriceUpdate') this.touch();
  }
}

/** Binance USD-M perpetual: the diff-depth stream chained on the previous update id (\`pu\`), synchronised with a REST snapshot. */
export class BinancePerpConnector extends MarketBook {
  readonly id = 'binance'; readonly name = 'Binance'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('binance')) { super(market); }
  #lastUpdateId = 0; #prevU = 0; #synced = false; #buffer: Record<string, unknown>[] = [];
  /** The connection a snapshot request is in flight for (-1: none), so one connection asks once and a retired one's answer is not taken for the next one's (as in the spot connector). */
  #loadingFor = -1;
  protected url() { return `wss://fstream.binance.com/public/ws/${this.symbol.toLowerCase()}@depth@100ms`; }
  protected open() { void this.#snapshot(); }
  async #snapshot(): Promise<void> {
    const generation = this.generation;
    if (this.#loadingFor === generation) return; this.#loadingFor = generation;
    try {
      const response = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${this.symbol}&limit=1000`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`);
      const body = this.record(await response.json()); if (!body) throw new Error('snapshot not an object');
      // An answer for a connection that has since ended or been replaced would put the new one on a book from another moment and call it live.
      if (generation !== this.generation) return;
      this.seed(num(body.lastUpdateId), this.rows(body.bids), this.rows(body.asks));
    } catch (error) { if (generation === this.generation) this.fail(`snapshot failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160)); }
    finally { if (this.#loadingFor === generation) this.#loadingFor = -1; }
  }
  /** Install the REST snapshot and replay the diff events buffered while it loaded. */
  seed(lastUpdateId: number, bids: [number, number][], asks: [number, number][]): void {
    this.#lastUpdateId = lastUpdateId; this.replace(this.bids, bids); this.replace(this.asks, asks);
    this.#synced = false; this.#prevU = 0;
    for (const event of this.#buffer.splice(0)) this.#event(event);
    this.touch();
  }
  onMessage(text: string) {
    const e = this.record(JSON.parse(text)); if (!e || e.e !== 'depthUpdate') return;
    if (!this.#lastUpdateId) { this.#buffer.push(e); if (this.#buffer.length > 5_000) this.fail('snapshot never arrived'); return; }
    this.#event(e);
  }
  #event(e: Record<string, unknown>) {
    const U = num(e.U), u = num(e.u), pu = num(e.pu);
    if (u < this.#lastUpdateId) return;
    if (!this.#synced) {
      // The first event after the snapshot must straddle it: U <= lastUpdateId <= u.
      if (U > this.#lastUpdateId) { this.fail(`snapshot behind stream (${this.#lastUpdateId} < ${U})`); return; }
      this.#synced = true;
    } else if (pu !== this.#prevU) { this.fail(`sequence gap ${this.#prevU} -> ${pu}`); return; }
    this.#prevU = u; this.apply(this.bids, this.rows(e.b)); this.apply(this.asks, this.rows(e.a)); this.touch();
  }
  protected override reset() { super.reset(); this.#lastUpdateId = 0; this.#prevU = 0; this.#synced = false; this.#buffer = []; }
}

// ---- Bybit --------------------------------------------------------------------------------------------------------------------------

/** How long a full-depth snapshot may take (the BTC perpetual's is about 1.4 MB, 420 KB on the wire, read in 0.4-3 s from here). */
const BYBIT_SNAPSHOT_TIMEOUT_MS = 20_000;
/** The first snapshot is asked for this long after subscribing, so a few deltas are held first and it usually bridges at once. */
const BYBIT_SNAPSHOT_FIRST_MS = 500;
/** A snapshot that could not be used is asked for again after a pause that doubles up to this, with up to a quarter more at random. */
const BYBIT_SNAPSHOT_MAX_PAUSE_MS = 10_000;
/** How often the price is compared with the book's frontiers for a refresh (shared/bybit-full-book.ts). */
const BYBIT_REFRESH_LOOK_MS = 5_000;
/** A snapshot ahead of the stream waits this long for its anchor before another is read (the stream pushes every 200 ms on a change). */
const BYBIT_ANCHOR_WAIT_MS = 10_000;
/**
 * The book's own freshness: the stream sends an empty delta (its `u` moving on) when a book is quiet, at most about 5 s apart on every
 * listed market (measured 2026-11-11). A book that has taken no delta for this long has a stalled channel, whatever the trades on the
 * same socket do: it is no longer drawn, and the socket is dropped and connected again.
 */
const BYBIT_BOOK_STALL_MS = 30_000;

/**
 * Bybit: the full-depth book (`orderbook.full.<symbol>` deltas synchronised with the `full_orderbook` snapshot, shared/bybit-full-book.ts),
 * and publicTrade on the same socket. The USDT linear perpetual and spot differ only by address; sizes are coins in both. The perpetual also
 * subscribes `allLiquidation.<symbol>` and `tickers.<symbol>` for open interest: the ticker snapshot that arrives on subscribing carries the
 * whole ticker, each delta only the fields that changed (open interest among them only when it did).
 *
 * The socket and the book are live separately: every frame of a subscribed topic keeps the socket live (trades must keep flowing while the
 * book loads or re-synchronises), and the book is drawn only while it is synchronised. A snapshot that fails is asked for again on the same
 * socket; only a book whose numbering breaks over and over drops the socket. A connector run for its trades alone (`bookRead = false`)
 * subscribes no book and reads no snapshot; spot's then subscribes its ticker, so a quiet market still shows the socket is alive.
 */
abstract class BybitBook extends MarketBook {
  readonly quote = 'USDT';
  protected abstract readonly category: 'linear' | 'spot';
  /** Its sides are `BookSide`s, as every connector's: a full book of 70,000 levels is valued from sorted arrays kept up to date. */
  readonly #full = new FullBook({ makeSide: () => new BookSide() });
  /** The snapshot request out (its connection and epoch: one at a time), and the pause before the next after one that could not be used. */
  #asking: { generation: number; epoch: number } | null = null;
  #pause = 0; #retry: ReturnType<typeof setTimeout> | null = null;
  /** The last traded price and when it came (what a refresh is judged at), and when the frontiers were last looked at. */
  #lastPrice = 0; #lastPriceAt = 0; #lookedAt = 0;
  /**
   * When the book's topic last sent a frame that read (any delta, live or held for a snapshot), or the connection opened: the book
   * channel's own deadline, which holds whether the book is live, loading or withdrawn after a gap.
   */
  #bookFrameAt = 0;
  protected url() { return `wss://stream.bybit.com/v5/public/${this.category}`; }
  /** Topics this market subscribes that carry open interest: the perpetual's ticker (spot has none). */
  protected oiTopics(): string[] { return []; }
  protected open(send: (p: unknown) => void) {
    const s = this.symbol;
    const liveness = this.category === 'spot' && !this.bookRead ? [`tickers.${s}`] : [];
    send({ op: 'subscribe', args: [...(this.bookRead ? [fullTopic(s)] : []), `publicTrade.${s}`, ...(this.category === 'linear' ? [`allLiquidation.${s}`] : []), ...this.oiTopics(), ...liveness] });
    this.#bookFrameAt = Date.now();
    if (this.bookRead) this.#later(BYBIT_SNAPSHOT_FIRST_MS);
  }
  override keepalive() { return { everyMs: 20_000, frame: () => ({ op: 'ping' }) }; }
  /** Drawn only while synchronised and fresh by its own deltas (a quiet book's empty ones included): trades say nothing about the book. */
  protected override bookReady(now: number): boolean { return this.#full.live && now - this.#full.appliedAt <= BYBIT_BOOK_STALL_MS; }
  protected override bookEpoch(): number { return this.#full.coverageEpoch; }
  /**
   * The book channel has stopped: no frame of its topic (not even a quiet book's empty one) for `BYBIT_BOOK_STALL_MS`, while the book
   * was live, loading or withdrawn: other topics keeping the socket alive do not hide it. The socket is dropped and connected again.
   */
  override check(now: number = Date.now()): void {
    super.check(now);
    if (this.bookRead && this.state === 'live' && now - this.#bookFrameAt > BYBIT_BOOK_STALL_MS) this.fail(`book silent ${Math.round(BYBIT_BOOK_STALL_MS / 1000)} s`);
  }
  override bookDetail(): string | null {
    if (!this.bookRead || this.#full.live) return null;
    return this.#full.lastFault ? `book re-synchronising (${this.#full.lastFault})` : 'loading the full book';
  }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); if (!m) return;
    // A refused subscription is a broken connection (an unknown symbol, a topic the venue no longer serves): retried with backoff.
    if (m.op === 'subscribe') { if (m.success === false) this.fail(`subscription refused: ${String(m.ret_msg ?? '')}`.slice(0, 160)); return; }
    const topic = String(m.topic ?? '');
    if (topic === fullTopic(this.symbol)) {
      if (!this.bookRead) return;
      const delta = parseFullDelta(m, this.symbol), now = Date.now();
      const progress = this.#full.progressAt, action = delta === 'bad' ? this.#full.fault('unreadable book frame', now) : delta ? this.#full.delta(delta, now) : 'none';
      // Only a frame that moved the book on (applied, or held for a snapshot) keeps the book channel's deadline: one that repeats a `u`
      // already applied does not, so a stream stuck on old frames is caught.
      if (this.#full.progressAt !== progress) this.#bookFrameAt = now;
      this.#sides(); this.touch(); this.#act(action);
      // A quiet market's book still sends a frame every few seconds: the seed's audit is not left waiting for a trade.
      this.#look();
      return;
    }
    if (topic === `allLiquidation.${this.symbol}`) {
      // `S` is the side of the position closed (Buy: a long), `p` its bankruptcy price (measured 2026-10-09: 0.3 % under the mark for a long).
      for (const item of Array.isArray(m.data) ? m.data : []) {
        const d = this.record(item); if (!d) continue;
        const price = num(d.p), amount = num(d.v), t = num(d.T), side = d.S === 'Buy' ? 'long' : d.S === 'Sell' ? 'short' : null;
        if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitLiquidation({ t, side, price, amount, notionalUsd: price * amount, kind: 'bankruptcy' });
      }
      this.alive();
      return;
    }
    if (topic.startsWith('publicTrade.')) {
      for (const item of Array.isArray(m.data) ? m.data : []) {
        const d = this.record(item); if (!d) continue;
        const price = num(d.p), amount = num(d.v), t = num(d.T), side = d.S === 'Buy' ? 'buy' : d.S === 'Sell' ? 'sell' : null;
        // Every fill of one market order carries the same `seq` (the matching event), so it names the order.
        const order = d.seq === undefined || d.seq === null ? undefined : String(d.seq);
        if (side && price > 0 && amount > 0 && Number.isFinite(t)) { this.emitTrade({ tradeId: String(d.i), side, price, amount, notionalUsd: price * amount, t, ...(order ? { order } : {}) }); this.#lastPrice = price; this.#lastPriceAt = Date.now(); }
      }
      this.alive(); this.#look();
      return;
    }
    if (topic === `tickers.${this.symbol}`) {
      this.alive();
      // Spot's ticker is subscribed only to show a trade-only socket is alive: it carries no open interest.
      if (this.category === 'spot') return;
      const d = this.record(m.data); if (!d || (d.symbol !== undefined && d.symbol !== this.symbol)) return;
      // A delta without the open-interest fields is not a reading (open interest did not change), never a zero; the `single…` figure is
      // one side of every contract, as every other venue reports it. `emitOi` drops a value or time that is not finite and positive.
      const given = (v: unknown): boolean => v !== undefined && v !== null && v !== '';
      const single = given(d.singleOpenInterest) ? num(d.singleOpenInterest) : given(d.openInterest) ? num(d.openInterest) / 2 : null;
      if (single !== null) this.emitOi({ t: num(m.ts), base: single });
    }
  }
  protected override reset() {
    super.reset(); this.#full.reset(); this.#sides();
    this.#asking = null; this.#pause = 0; this.#lastPrice = 0; this.#lastPriceAt = 0; this.#lookedAt = 0; this.#bookFrameAt = Date.now();
    if (this.#retry) clearTimeout(this.#retry); this.#retry = null;
  }

  /** The book's sides are the full book's (replaced whole when a snapshot seeds or a refresh swaps in). */
  #sides(): void { if (this.bids !== this.#full.bids || this.asks !== this.#full.asks) { this.bids = this.#full.bids; this.asks = this.#full.asks; } }
  #act(action: FullAction): void {
    if (action === 'snapshot') this.#ask();
    else if (action === 'reconnect') this.fail(`book: ${this.#full.lastFault ?? 'numbering broken'} (three times in a minute)`.slice(0, 160));
  }
  /** Ask for the snapshot after `ms` (a first ask, or a pause after one that could not be used), on this connection only. */
  #later(ms: number): void {
    if (this.#retry) clearTimeout(this.#retry);
    const generation = this.generation;
    this.#retry = setTimeout(() => { this.#retry = null; if (generation === this.generation && this.state !== 'stopped') this.#ask(); }, ms);
    (this.#retry as { unref?: () => void }).unref?.();
  }
  /** The next pause before asking again: doubling from half a second, at most `BYBIT_SNAPSHOT_MAX_PAUSE_MS`, plus up to a quarter at random. */
  #nextPause(): number { this.#pause = Math.min(BYBIT_SNAPSHOT_MAX_PAUSE_MS, this.#pause ? this.#pause * 2 : 500); return this.#pause * (1 + Math.random() / 4); }
  /** Seed the book from a snapshot (one request out at a time per connection and epoch). */
  #ask(): void {
    if (!this.bookRead || this.#full.live || this.state === 'stopped') return;
    const generation = this.generation, epoch = this.#full.epoch;
    if (this.#asking && this.#asking.generation === generation && this.#asking.epoch === epoch) return;
    if (this.#retry) { clearTimeout(this.#retry); this.#retry = null; }
    void this.#read(generation, epoch, false);
  }
  /** At most every few seconds, on a trade or a book frame: whether the seed's audit is due or the price has come near enough a frontier, and if so read a snapshot. */
  #look(): void {
    const now = Date.now();
    if (!this.bookRead || !this.#full.live || this.#asking || now - this.#lookedAt < BYBIT_REFRESH_LOOK_MS) return;
    this.#lookedAt = now;
    // Judged at the last trade while one came in the last minute, else at the book's own mid (a quiet book trades seldom).
    const mid = this.#lastPrice > 0 && now - this.#lastPriceAt <= 60_000 ? this.#lastPrice : this.#full.mid();
    if (!this.#full.refreshDue(mid, now)) return;
    void this.#read(this.generation, this.#full.beginRefresh(now), true);
  }
  /** One snapshot request, its answer handed to the full book; a seed that could not be used is asked for again after a pause. */
  async #read(generation: number, epoch: number, refresh: boolean): Promise<void> {
    this.#asking = { generation, epoch };
    let result: SnapshotResult | 'failed' = 'failed';
    try {
      // A plain GET without credentials: the answer is public, and a credentialed request would need more of the venue's CORS answer.
      const response = await fetch(fullSnapshotUrl(this.category, this.symbol), { credentials: 'omit', signal: AbortSignal.timeout(BYBIT_SNAPSHOT_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (generation !== this.generation) return;
      const snapshot = parseFullSnapshot(body, this.symbol);
      if (typeof snapshot === 'string') throw new Error(snapshot);
      result = this.#full.snapshot(snapshot, epoch, Date.now());
    } catch (error) {
      if (generation === this.generation && !refresh && epoch === this.#full.epoch) this.#full.lastFault = `snapshot failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 120);
    } finally {
      if (this.#asking?.generation === generation && this.#asking.epoch === epoch) this.#asking = null;
    }
    if (generation !== this.generation || this.state === 'stopped') return;
    if (refresh) {
      // 'rejected' and 'unchanged' already paused the next refresh; 'wait' finishes once the book reaches the snapshot.
      if (result === 'failed') this.#full.failRefresh(Date.now(), epoch);
      if (result === 'extended' || result === 'repaired') { this.#sides(); this.touch(); }
      return;
    }
    if (result === 'seeded') { this.#pause = 0; this.#bookFrameAt = Date.now(); this.#sides(); this.touch(); return; }
    // An answer to an earlier epoch's request schedules nothing: the current epoch asks for its own.
    if (epoch !== this.#full.epoch) return;
    // 'wait': the book seeds itself once the stream reaches the snapshot's anchor; one the stream never brings is read again after a
    // while. 'stale': a newer epoch has asked (or will) for its own.
    if (result === 'wait') this.#later(BYBIT_ANCHOR_WAIT_MS);
    else if (result === 'retry' || result === 'failed') this.#later(this.#nextPause());
  }
}
export class BybitConnector extends BybitBook {
  readonly id = 'bybit'; readonly name = 'Bybit'; readonly marketType = 'perpetual' as const; protected readonly category = 'linear';
  constructor(market: Market = btc('bybit')) { super(market); }
  protected override oiTopics(): string[] { return [`tickers.${this.symbol}`]; }
}
/** Bybit spot. Its `seq` names an order as on the perpetual (measured on BTC/USDT: 103 fills sharing one, never two sides or two times). */
export class BybitSpotConnector extends BybitBook {
  readonly id = 'bybitspot'; readonly name = 'Bybit spot'; readonly marketType = 'spot' as const; protected readonly category = 'spot';
  constructor(market: Market = btc('bybitspot')) { super(market); }
}

// ---- OKX ----------------------------------------------------------------------------------------------------------------------------

/** OKX: books chain on prevSeqId, and trades on the same socket. Sizes are coins times `contract`: 1 on spot, the swap's contract size there. */
abstract class OkxBook extends MarketBook {
  readonly quote = 'USDT';
  /** Coins per unit of size. */
  contract = this.market.contract ?? 1;
  #seq = -1;
  /** Port 443: OKX retires 8443, and since 2026-11 greets each socket there with a notice (64010). */
  protected url() { return 'wss://ws.okx.com/ws/v5/public'; }
  protected open(send: (p: unknown) => void) { send({ op: 'subscribe', args: [{ channel: 'books', instId: this.symbol }, { channel: 'trades', instId: this.symbol }] }); }
  override keepalive() { return { everyMs: 20_000, frame: () => 'ping' }; }
  protected override usdOf(price: number, size: number) { return price * size * this.contract; }
  /** The books channel stops at 400 levels (7 bp on the BTC swap); `books-full` gives 5 000 beyond them. */
  protected override farBook() { return farSource(this.instrumentId); }
  onMessage(text: string) {
    if (text === 'pong') return;
    const m = this.record(JSON.parse(text)); if (!m) return;
    const channel = this.record(m.arg)?.channel;
    const data = Array.isArray(m.data) ? m.data : [];
    if (channel === 'liquidation-orders') {
      // Every swap's liquidations come on this one channel: this market's are the ones whose instId is its own. `posSide` is the side
      // closed (`side` the forced order's, for a net position), `sz` contracts. `bkPx` is named the bankruptcy price, but measured (not
      // documented) on 2026-10-09 it sat within a few basis points of the mark, Bybit's 0.3 % away: taken as where the forced order went, a fill.
      for (const item of data) {
        const x = this.record(item); if (!x || x.instId !== this.symbol) continue;
        for (const detail of Array.isArray(x.details) ? x.details : []) {
          const d = this.record(detail); if (!d) continue;
          const side = d.posSide === 'long' ? 'long' : d.posSide === 'short' ? 'short' : d.side === 'sell' ? 'long' : d.side === 'buy' ? 'short' : null;
          const price = num(d.bkPx), amount = num(d.sz) * this.contract, t = num(d.ts);
          if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitLiquidation({ t, side, price, amount, notionalUsd: price * amount, kind: 'fill' });
        }
      }
      return;
    }
    if (channel === 'trades') {
      for (const item of data) {
        const d = this.record(item); if (!d) continue;
        const price = num(d.px), amount = num(d.sz) * this.contract, t = num(d.ts), side = d.side === 'buy' ? 'buy' : d.side === 'sell' ? 'sell' : null;
        if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(d.tradeId), side, price, amount, notionalUsd: price * amount, t });
      }
      return;
    }
    if (channel === 'open-interest') {
      // The swap's own open-interest channel: `oiCcy` is the open interest in coins and `ts` the exchange's push time. Only this market's
      // frame and rows count: another market's open interest must never be read as this one's.
      if (this.record(m.arg)?.instId !== this.symbol) return;
      for (const item of data) {
        const d = this.record(item); if (!d || (d.instId !== undefined && d.instId !== this.symbol)) continue;
        this.emitOi({ t: num(d.ts), base: num(d.oiCcy) });
      }
      return;
    }
    if (channel !== 'books') return;
    for (const item of data) {
      const d = this.record(item); if (!d) continue;
      const seq = num(d.seqId), prev = num(d.prevSeqId);
      if (m.action === 'snapshot') { this.replace(this.bids, this.rows(d.bids)); this.replace(this.asks, this.rows(d.asks)); this.#seq = seq; this.touch(); continue; }
      if (this.#seq < 0) continue;
      if (prev !== this.#seq && prev !== -1) { this.fail(`sequence gap ${this.#seq} -> ${prev}`); return; }
      this.#seq = seq; this.apply(this.bids, this.rows(d.bids)); this.apply(this.asks, this.rows(d.asks)); this.touch();
    }
  }
  protected override reset() { super.reset(); this.#seq = -1; }
}
/** OKX USDT swap: sizes are contracts (0.01 BTC each; the coin list carries each swap's, and the instrument list is read again when it answers). */
export class OkxConnector extends OkxBook {
  readonly id = 'okx'; readonly name = 'OKX'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('okx')) { super(market); }
  protected override open(send: (p: unknown) => void) {
    super.open(send);
    send({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }, { channel: 'open-interest', instId: this.symbol }] });
    void fetch(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${this.symbol}`, { signal: AbortSignal.timeout(10_000) })
      .then(r => r.json() as Promise<{ data?: { ctVal?: string }[] }>).then(body => { const v = num(body.data?.[0]?.ctVal); if (v > 0) this.contract = v; }).catch(() => { /* the documented value stands */ });
  }
}
/** OKX spot: sizes are coins. */
export class OkxSpotConnector extends OkxBook {
  readonly id = 'okxspot'; readonly name = 'OKX spot'; readonly marketType = 'spot' as const;
  constructor(market: Market = btc('okxspot')) { super(market); }
}

// ---- Bitget -------------------------------------------------------------------------------------------------------------------------

/**
 * Bitget: books snapshot then updates chained on seq/pseq, and trades on the same socket. USDT futures and spot differ only by
 * instType; sizes are coins in both. On subscribing, the trade channel first sends the last 50 trades as a snapshot: they were made before
 * this connection and some were already counted on the last one, so they are left out.
 */
abstract class BitgetBook extends MarketBook {
  readonly quote = 'USDT';
  protected abstract readonly instType: 'USDT-FUTURES' | 'SPOT';
  #seq = 0;
  protected url() { return 'wss://ws.bitget.com/v2/ws/public'; }
  protected open(send: (p: unknown) => void) { send({ op: 'subscribe', args: [{ instType: this.instType, channel: 'books', instId: this.symbol }, { instType: this.instType, channel: 'trade', instId: this.symbol }] }); }
  override keepalive() { return { everyMs: 25_000, frame: () => 'ping' }; }
  onMessage(text: string) {
    if (text === 'pong') return;
    const m = this.record(JSON.parse(text)); if (!m) return;
    const channel = this.record(m.arg)?.channel;
    const data = Array.isArray(m.data) ? m.data : [];
    if (channel === 'trade') {
      if (m.action === 'snapshot') return;
      for (const item of data) {
        const d = this.record(item); if (!d) continue;
        const price = num(d.price), amount = num(d.size), t = num(d.ts), side = d.side === 'buy' ? 'buy' : d.side === 'sell' ? 'sell' : null;
        if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(d.tradeId), side, price, amount, notionalUsd: price * amount, t });
      }
      return;
    }
    if (channel !== 'books') return;
    for (const item of data) {
      const d = this.record(item); if (!d) continue;
      const seq = num(d.seq), pseq = num(d.pseq);
      if (m.action === 'snapshot') { this.replace(this.bids, this.rows(d.bids)); this.replace(this.asks, this.rows(d.asks)); this.#seq = seq; this.touch(); continue; }
      if (!this.#seq) continue;
      if (seq <= this.#seq) continue; // already applied
      if (pseq !== this.#seq) { this.fail(`sequence gap ${this.#seq} -> ${pseq}`); return; }
      this.#seq = seq; this.apply(this.bids, this.rows(d.bids)); this.apply(this.asks, this.rows(d.asks)); this.touch();
    }
  }
  protected override reset() { super.reset(); this.#seq = 0; }
}
export class BitgetConnector extends BitgetBook {
  readonly id = 'bitget'; readonly name = 'Bitget'; readonly marketType = 'perpetual' as const; protected readonly instType = 'USDT-FUTURES';
  constructor(market: Market = btc('bitget')) { super(market); }
}
export class BitgetSpotConnector extends BitgetBook {
  readonly id = 'bitgetspot'; readonly name = 'Bitget spot'; readonly marketType = 'spot' as const; protected readonly instType = 'SPOT';
  constructor(market: Market = btc('bitgetspot')) { super(market); }
}

// ---- Coinbase -----------------------------------------------------------------------------------------------------------------------

/** Coinbase Exchange (BTC-USD and the like): level2_batch (snapshot then l2update changes) and matches. The match side is the maker's, so the taker is the other one. */
export class CoinbaseConnector extends MarketBook {
  readonly id = 'coinbase'; readonly name = 'Coinbase'; readonly quote = 'USD'; readonly marketType = 'spot' as const;
  constructor(market: Market = btc('coinbase')) { super(market); }
  protected url() { return 'wss://ws-feed.exchange.coinbase.com'; }
  protected open(send: (p: unknown) => void) { send({ type: 'subscribe', product_ids: [this.symbol], channels: ['level2_batch', 'matches'] }); }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); if (!m) return;
    if (m.type === 'snapshot') { this.replace(this.bids, this.rows(m.bids)); this.replace(this.asks, this.rows(m.asks)); this.touch(); return; }
    if (m.type === 'l2update') {
      for (const change of Array.isArray(m.changes) ? m.changes : []) {
        if (!Array.isArray(change)) continue;
        const side = change[0] === 'buy' ? this.bids : change[0] === 'sell' ? this.asks : null; if (!side) continue;
        const price = num(change[1]), size = num(change[2]);
        if (!(price > 0) || !Number.isFinite(size)) continue;
        if (size > 0) side.set(price, size); else side.delete(price);
      }
      this.touch(); return;
    }
    if (m.type === 'match' || m.type === 'last_match') {
      const price = num(m.price), amount = num(m.size), t = iso(m.time);
      const side = m.side === 'sell' ? 'buy' : m.side === 'buy' ? 'sell' : null;
      const order = typeof m.taker_order_id === 'string' && m.taker_order_id ? m.taker_order_id : undefined;
      if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(m.trade_id), side, price, amount, notionalUsd: price * amount, t, ...(order ? { order } : {}) });
    }
  }
}

// ---- Deribit ------------------------------------------------------------------------------------------------------------------------

/**
 * Deribit perpetuals. BTC-PERPETUAL: amounts are USD (10 per contract); ETH-PERPETUAL is sized in USD too; the other coins trade as USDC
 * perpetuals sized in coins. The book is the whole of it, ungrouped (`book.<instrument>.100ms`, as the server reads it): a snapshot, then
 * each change chained on the one before (`prev_change_id`), its rows `[new | change | delete, price, amount]`. Measured 2026-10-12 on
 * BTC: about 1 200 levels a side, where the $10 bands it used to take (the best 20 a side) reached about 25 bp.
 */
export class DeribitConnector extends MarketBook {
  readonly id = 'deribit'; readonly name = 'Deribit'; readonly quote = 'USD'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('deribit')) { super(market); }
  /** The trade ids of forced fills already counted: a fill seen again (a replay after a reconnect) must not add to a liquidation twice. */
  readonly #forcedSeen = new Set<string>();
  /** The last change applied to the book (-1: no snapshot yet). */
  #changeId = -1;
  protected url() { return 'wss://www.deribit.com/ws/api/v2'; }
  protected open(send: (p: unknown) => void) { send({ jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: [`book.${this.symbol}.100ms`, `trades.${this.symbol}.100ms`] } }); }
  /**
   * Deribit closes a socket that only listens every 10 minutes (measured 2026-11-01 from hiverust: 23:41:38, 23:51:39, 00:01:41, ...); a
   * small request a minute keeps it open. Its answer carries no `params` and is passed over.
   */
  override keepalive() { return { everyMs: 60_000, frame: () => ({ jsonrpc: '2.0', id: 2, method: 'public/test' }) }; }
  protected override usdOf(price: number, size: number) { return this.market.inverse ? size : price * size; }
  /**
   * A full-book side as [price, amount] rows: a deleted level is 0, which takes it away. A row that cannot be read throws (the frame is
   * then a bad one and the book is taken again): skipping it would leave a level that was changed or deleted standing, and the changes
   * after it would still chain.
   */
  #levels(rows: unknown): [number, number][] {
    if (!Array.isArray(rows)) throw new TypeError('Deribit book side is not a list');
    return rows.map(row => {
      const action = Array.isArray(row) ? row[0] : null, price = Array.isArray(row) ? num(row[1]) : NaN, amount = action === 'delete' ? 0 : Array.isArray(row) ? num(row[2]) : NaN;
      if ((action !== 'new' && action !== 'change' && action !== 'delete') || !(price > 0) || !Number.isFinite(price) || !(amount >= 0) || !Number.isFinite(amount)) throw new TypeError('malformed Deribit book row');
      return [price, amount];
    });
  }
  protected override reset() { super.reset(); this.#changeId = -1; }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); const params = this.record(m?.params); if (!params) return;
    // Only this instrument's channels: another one's book or trades would put its prices here.
    const channel = String(params.channel ?? '');
    if (channel === `book.${this.symbol}.100ms`) {
      const d = this.record(params.data); if (!d) return;
      // Every row is read before anything is applied, so a bad frame changes neither the book nor the change it is at.
      const changeId = num(d.change_id);
      if (!Number.isInteger(changeId)) throw new TypeError('Deribit book frame without a change id');
      if (d.type === 'snapshot') { const bids = this.#levels(d.bids), asks = this.#levels(d.asks); this.replace(this.bids, bids); this.replace(this.asks, asks); this.#changeId = changeId; this.touch(); return; }
      if (d.type !== 'change' || this.#changeId < 0) return; // changes before the first snapshot
      if (num(d.prev_change_id) !== this.#changeId) { this.fail(`sequence gap ${this.#changeId} -> ${String(d.prev_change_id)}`); return; }
      const bids = this.#levels(d.bids), asks = this.#levels(d.asks);
      this.#changeId = changeId; this.apply(this.bids, bids); this.apply(this.asks, asks); this.touch(); return;
    }
    if (channel.startsWith(`trades.${this.symbol}.`)) {
      /** The forced fills of this frame, one entry per forced order (its fills share a time and a side). */
      const forced = new Map<string, { t: number; side: 'long' | 'short'; coins: number; usd: number }>();
      for (const item of Array.isArray(params.data) ? params.data : []) {
        const d = this.record(item); if (!d) continue;
        const price = num(d.price), amount = num(d.amount), t = num(d.timestamp), side = d.direction === 'buy' ? 'buy' : d.direction === 'sell' ? 'sell' : null;
        if (!side || !(price > 0) || !(amount > 0) || !Number.isFinite(t)) continue;
        // A coin-margined perpetual's amount is USD; a USDC one's is coins.
        const coins = this.market.inverse ? amount / price : amount, usd = this.market.inverse ? amount : price * amount;
        this.emitTrade({ tradeId: String(d.trade_id), side, price, amount: coins, notionalUsd: usd, t });
        // The taker's forced order went the trade's way (a sell closes a long); a forced maker order went the other way.
        const flag = typeof d.liquidation === 'string' ? d.liquidation : '';
        const closed: ('long' | 'short')[] = [];
        if (flag.includes('T')) closed.push(side === 'sell' ? 'long' : 'short');
        if (flag.includes('M')) closed.push(side === 'sell' ? 'short' : 'long');
        if (closed.length) {
          const tradeId = String(d.trade_id);
          if (this.#forcedSeen.has(tradeId)) continue;
          this.#forcedSeen.add(tradeId);
          if (this.#forcedSeen.size > 4_000) { const keep = [...this.#forcedSeen].slice(-2_000); this.#forcedSeen.clear(); for (const k of keep) this.#forcedSeen.add(k); }
        }
        for (const which of closed) {
          const key = `${t}|${which}`, sum = forced.get(key) ?? { t, side: which, coins: 0, usd: 0 };
          sum.coins += coins; sum.usd += usd; forced.set(key, sum);
        }
      }
      for (const f of forced.values()) this.emitLiquidation({ t: f.t, side: f.side, price: f.usd / f.coins, amount: f.coins, notionalUsd: f.usd, kind: 'fill' });
    }
  }
}

// ---- Hyperliquid --------------------------------------------------------------------------------------------------------------------

/** Hyperliquid perpetuals: l2Book at three significant figures (20 aggregated bands a side, about $100 wide for BTC: a bid named by its band's lower edge, an ask by its upper edge) and trades. */
/** The server's setting (HL_BOOK_NSIG_FIGS defaults to 3): bands about $100 wide at BTC's price. */
const HL_SIG_FIGS = 3;
export class HyperliquidConnector extends MarketBook {
  readonly id = 'hyperliquid'; readonly name = 'Hyperliquid'; readonly quote = 'USD'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('hyperliquid')) { super(market); }
  /** The instrument is named as the server names it (BTC-PERP); the market's own name for the coin is what it subscribes with. */
  override get symbol(): string { return `${this.market.symbol}-PERP`; }
  protected override get coarse() { return true; }
  /** One step for the whole book, its best bid's (`hyperliquidBookStep`). */
  protected override band(price: number, side: 'bid' | 'ask', touch: { bid: number; ask: number }) {
    try { const b = hyperliquidLevelBounds(price, side, HL_SIG_FIGS, undefined, hyperliquidBookStep(touch.bid, touch.ask, HL_SIG_FIGS)); return { lo: b.lower, hi: b.upper }; } catch { return { lo: price, hi: price }; }
  }
  protected url() { return 'wss://api.hyperliquid.xyz/ws'; }
  protected open(send: (p: unknown) => void) {
    send({ method: 'subscribe', subscription: { type: 'l2Book', coin: this.market.symbol, nSigFigs: HL_SIG_FIGS } });
    send({ method: 'subscribe', subscription: { type: 'trades', coin: this.market.symbol } });
  }
  override keepalive() { return { everyMs: 30_000, frame: () => ({ method: 'ping' }) }; }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); if (!m) return;
    if (m.channel === 'l2Book') {
      // Only this coin's book and trades: another coin's frame would put its prices into this book (and its trades into where it is split).
      const data = this.record(m.data); if (!data || data.coin !== this.market.symbol) return;
      const levels = data.levels;
      if (!Array.isArray(levels) || levels.length < 2) return;
      const side = (rows: unknown): [number, number][] => Array.isArray(rows) ? rows.flatMap(r => { const d = this.record(r); return d ? [[num(d.px), num(d.sz)] as [number, number]] : []; }).filter(([p, q]) => p > 0 && q >= 0) : [];
      this.replace(this.bids, side(levels[0])); this.replace(this.asks, side(levels[1])); this.touch(); return;
    }
    if (m.channel === 'trades') {
      for (const item of Array.isArray(m.data) ? m.data : []) {
        const d = this.record(item); if (!d || d.coin !== this.market.symbol) continue;
        const price = num(d.px), amount = num(d.sz), t = num(d.time), side = d.side === 'B' ? 'buy' : d.side === 'A' ? 'sell' : null;
        // The fills of one market order share its transaction hash (a batch of orders sent in one transaction shares it too: there is no
        // public taker order id); about one row in seven has an all-zero hash, which names nothing.
        const order = typeof d.hash === 'string' && !/^0x0*$/i.test(d.hash) ? d.hash : undefined;
        if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: `${t}:${this.market.symbol}:${String(d.tid)}`, side, price, amount, notionalUsd: price * amount, t, ...(order ? { order } : {}) });
      }
    }
  }
}

// ---- MEXC ---------------------------------------------------------------------------------------------------------------------------

/**
 * MEXC USDT perpetual: the best 20 levels a side, whole on every push (`sub.depth.full`), and trades on the same socket. A deeper book
 * would need MEXC's REST snapshot, which sends no CORS header, so a page cannot read it. Sizes are contracts (0.0001 BTC each; the
 * listing carries the size, as MEXC's contract detail is not readable from a page either).
 */
export class MexcConnector extends MarketBook {
  readonly id = 'mexc'; readonly name = 'MEXC'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('mexc')) { super(market); }
  /** Coins per contract. */
  readonly contract = this.market.contract ?? 1;
  protected url() { return 'wss://contract.mexc.com/edge'; }
  protected open(send: (p: unknown) => void) {
    send({ method: 'sub.depth.full', param: { symbol: this.symbol, limit: 20 } });
    send({ method: 'sub.deal', param: { symbol: this.symbol } });
  }
  override keepalive() { return { everyMs: 15_000, frame: () => ({ method: 'ping' }) }; }
  protected override usdOf(price: number, size: number) { return price * size * this.contract; }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); if (!m) return;
    if (m.channel === 'rs.error') { this.fail(`subscription refused: ${String(m.data ?? '')}`.slice(0, 160)); return; }
    if (m.symbol !== undefined && m.symbol !== this.symbol) return;
    if (m.channel === 'push.depth.full') {
      const d = this.record(m.data); if (!d) return;
      this.replace(this.bids, this.rows(d.bids)); this.replace(this.asks, this.rows(d.asks)); this.touch(); return;
    }
    if (m.channel === 'push.deal') {
      for (const item of Array.isArray(m.data) ? m.data : [m.data]) {
        const d = this.record(item); if (!d) continue;
        // T: the taker's side (1 buy, 2 sell); v: contracts; i: the trade's id.
        const price = num(d.p), amount = num(d.v) * this.contract, t = num(d.t), side = d.T === 1 ? 'buy' : d.T === 2 ? 'sell' : null;
        if (side && price > 0 && amount > 0 && Number.isFinite(t) && d.i !== undefined) this.emitTrade({ tradeId: String(d.i), side, price, amount, notionalUsd: price * amount, t });
      }
    }
  }
}

// ---- Binance spot ---------------------------------------------------------------------------------------------------------------------

/** Binance spot's book: the server's diff-depth connector (shared/connector.ts), for any coin; the deepest spot book (5000 levels a snapshot). */
export class BinanceSpotBook extends BinanceDiffDepthConnector {
  readonly id = 'binancespot'; readonly name = 'Binance spot'; readonly quote = 'USDT';
  declare protected readonly market: Market;
  constructor(market: Market = btc('binancespot')) { super(market); }
  get symbol(): string { return this.market.symbol; }
  protected readonly wsBase = 'wss://stream.binance.com:9443'; protected readonly restBase = 'https://api.binance.com';
  protected override readonly snapshotLimit = 5000;
}

// ---- The set ------------------------------------------------------------------------------------------------------------------------

export interface BrowserVenue {
  /** The venue id the picker and the chips use ("binance" is the perpetual, "binancespot" the spot book). */
  id: string; name: string; kind: 'perp' | 'spot';
  /** Part of the set a first visit starts with. */
  recommended: boolean;
  /** Whether this market lists the coin the page is on: one that does not is shown, and cannot be started. */
  listed: boolean;
  /**
   * A small public REST request that answers when the venue serves this visitor. Exchanges that restrict a country refuse here too (an
   * HTTP error status, or a reply the browser withholds), which is how an unreachable venue is told apart from one that is only slow.
   * Null for a venue with no REST a page can read (MEXC): one that never connects is then reported as failing, not as refusing a country.
   */
  probe: { url: string; init?: { method: string; headers: Record<string, string>; body: string } } | null;
  /** The book connector first, then any feed that only carries trades, and any that only carries liquidations. */
  make(): Made;
}

/** A venue's connectors: its book, the feeds that only carry trades, and those that only carry liquidations (where the others' sockets do not). */
export interface Made { book: BookConnector; feeds: BookConnector[]; liquidations?: BookConnector[] }

const POST_JSON = { method: 'POST', headers: { 'content-type': 'application/json' } } as const;

/** Each market: its name, kind, reachability request and connectors for one coin's listing there. */
const VENUE_SPECS: readonly (Omit<BrowserVenue, 'listed' | 'make'> & { id: MarketVenue; make(market: Market): Made })[] = [
  { id: 'binance', name: 'Binance', kind: 'perp', recommended: true, probe: { url: 'https://fapi.binance.com/fapi/v1/ping' }, make: m => ({ book: new BinancePerpConnector(m), feeds: [new BinancePerpTrades(m)], liquidations: [new BinanceLiquidations(m)] }) },
  { id: 'bybit', name: 'Bybit', kind: 'perp', recommended: true, probe: { url: 'https://api.bybit.com/v5/market/time' }, make: m => ({ book: new BybitConnector(m), feeds: [] }) },
  { id: 'okx', name: 'OKX', kind: 'perp', recommended: true, probe: { url: 'https://www.okx.com/api/v5/public/time' }, make: m => ({ book: new OkxConnector(m), feeds: [] }) },
  { id: 'bitget', name: 'Bitget', kind: 'perp', recommended: true, probe: { url: 'https://api.bitget.com/api/v2/public/time' }, make: m => ({ book: new BitgetConnector(m), feeds: [] }) },
  { id: 'hyperliquid', name: 'Hyperliquid', kind: 'perp', recommended: true, probe: { url: 'https://api.hyperliquid.xyz/info', init: { ...POST_JSON, body: JSON.stringify({ type: 'l2Book', coin: 'BTC' }) } }, make: m => ({ book: new HyperliquidConnector(m), feeds: [] }) },
  { id: 'deribit', name: 'Deribit', kind: 'perp', recommended: true, probe: { url: 'https://www.deribit.com/api/v2/public/get_time' }, make: m => ({ book: new DeribitConnector(m), feeds: [] }) },
  { id: 'binancespot', name: 'Binance spot', kind: 'spot', recommended: true, probe: { url: 'https://api.binance.com/api/v3/ping' }, make: m => ({ book: new BinanceSpotBook(m), feeds: [new BinanceSpotTrades(m)] }) },
  { id: 'coinbase', name: 'Coinbase', kind: 'spot', recommended: true, probe: { url: 'https://api.exchange.coinbase.com/time' }, make: m => ({ book: new CoinbaseConnector(m), feeds: [] }) },
  { id: 'bybitspot', name: 'Bybit spot', kind: 'spot', recommended: true, probe: { url: 'https://api.bybit.com/v5/market/time' }, make: m => ({ book: new BybitSpotConnector(m), feeds: [] }) },
  { id: 'okxspot', name: 'OKX spot', kind: 'spot', recommended: true, probe: { url: 'https://www.okx.com/api/v5/public/time' }, make: m => ({ book: new OkxSpotConnector(m), feeds: [] }) },
  { id: 'bitgetspot', name: 'Bitget spot', kind: 'spot', recommended: true, probe: { url: 'https://api.bitget.com/api/v2/public/time' }, make: m => ({ book: new BitgetSpotConnector(m), feeds: [] }) },
  // Optional (Research_Findings.md, 2026-10-08): large by volume and open interest, but a page gets only its best 20
  // levels, and its resting book is several times heavier than its trading. Last, so the order of the others (and the reference price) is as it was.
  { id: 'mexc', name: 'MEXC', kind: 'perp', recommended: false, probe: null, make: m => ({ book: new MexcConnector(m), feeds: [] }) },
];

/** The markets for one coin: every one of the eleven, each either listing it (and able to start) or not. */
export function browserVenues(coin: Coin = BTC): BrowserVenue[] {
  return VENUE_SPECS.map(({ make, ...spec }) => {
    const listing = coin.markets[spec.id];
    if (!listing) return { ...spec, listed: false, make: () => { throw new Error(`${spec.name} does not list ${coin.coin}`); } };
    const market: Market = { coin: coin.coin, ...listing };
    return { ...spec, listed: true, make: () => make(market) };
  });
}

/** BTC's markets. */
export const BROWSER_VENUES: readonly BrowserVenue[] = browserVenues(BTC);

/**
 * The venues to start for a saved choice: the venues it chose, and every recommended venue it had not seen (one added since, which a
 * person who never opened the picker again would otherwise never get). A recommended venue it had seen and left out stays out. No saved
 * choice: null, the recommended set.
 */
export function restoreSelection(selected: readonly string[] | null, known: readonly string[] | null, venues: readonly Pick<BrowserVenue, 'id' | 'recommended'>[] = BROWSER_VENUES): string[] | null {
  if (!selected) return null;
  const seen = new Set(known ?? EARLIER_BROWSER_VENUES), out = [...selected];
  for (const venue of venues) if (venue.recommended && !seen.has(venue.id) && !out.includes(venue.id)) out.push(venue.id);
  return out;
}
