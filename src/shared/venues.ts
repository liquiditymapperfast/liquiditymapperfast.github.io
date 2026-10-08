import { BinanceDiffDepthConnector, BookConnector, type Market } from './connector.ts';
import { BTC, EARLIER_BROWSER_VENUES, type Coin, type MarketVenue } from './coins.ts';
import { hyperliquidGroupingBoundsDecimal } from '../analytics/hyperliquid-bounds.mts';

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

/**
 * Bybit: orderbook.1000 snapshot then deltas (u counts up by one), and publicTrade on the same socket. The USDT linear perpetual and spot
 * differ only by address; sizes are coins in both.
 */
abstract class BybitBook extends MarketBook {
  readonly quote = 'USDT';
  protected abstract readonly category: 'linear' | 'spot';
  #u = 0;
  protected url() { return `wss://stream.bybit.com/v5/public/${this.category}`; }
  protected open(send: (p: unknown) => void) { send({ op: 'subscribe', args: [`orderbook.1000.${this.symbol}`, `publicTrade.${this.symbol}`] }); }
  override keepalive() { return { everyMs: 20_000, frame: () => ({ op: 'ping' }) }; }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); if (!m) return;
    const topic = String(m.topic ?? '');
    if (topic.startsWith('publicTrade.')) {
      for (const item of Array.isArray(m.data) ? m.data : []) {
        const d = this.record(item); if (!d) continue;
        const price = num(d.p), amount = num(d.v), t = num(d.T), side = d.S === 'Buy' ? 'buy' : d.S === 'Sell' ? 'sell' : null;
        // Every fill of one market order carries the same `seq` (the matching event), so it names the order.
        const order = d.seq === undefined || d.seq === null ? undefined : String(d.seq);
        if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(d.i), side, price, amount, notionalUsd: price * amount, t, ...(order ? { order } : {}) });
      }
      return;
    }
    if (topic !== `orderbook.1000.${this.symbol}`) return;
    const d = this.record(m.data); if (!d) return;
    const u = num(d.u);
    if (m.type === 'snapshot') { this.replace(this.bids, this.rows(d.b)); this.replace(this.asks, this.rows(d.a)); this.#u = u; this.touch(); return; }
    if (!this.#u) return; // deltas before the first snapshot
    if (u !== this.#u + 1) { this.fail(`sequence gap ${this.#u} -> ${u}`); return; }
    this.#u = u; this.apply(this.bids, this.rows(d.b)); this.apply(this.asks, this.rows(d.a)); this.touch();
  }
  protected override reset() { super.reset(); this.#u = 0; }
}
export class BybitConnector extends BybitBook {
  readonly id = 'bybit'; readonly name = 'Bybit'; readonly marketType = 'perpetual' as const; protected readonly category = 'linear';
  constructor(market: Market = btc('bybit')) { super(market); }
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
  protected url() { return 'wss://ws.okx.com:8443/ws/v5/public'; }
  protected open(send: (p: unknown) => void) { send({ op: 'subscribe', args: [{ channel: 'books', instId: this.symbol }, { channel: 'trades', instId: this.symbol }] }); }
  override keepalive() { return { everyMs: 20_000, frame: () => 'ping' }; }
  protected override usdOf(price: number, size: number) { return price * size * this.contract; }
  onMessage(text: string) {
    if (text === 'pong') return;
    const m = this.record(JSON.parse(text)); if (!m) return;
    const channel = this.record(m.arg)?.channel;
    const data = Array.isArray(m.data) ? m.data : [];
    if (channel === 'trades') {
      for (const item of data) {
        const d = this.record(item); if (!d) continue;
        const price = num(d.px), amount = num(d.sz) * this.contract, t = num(d.ts), side = d.side === 'buy' ? 'buy' : d.side === 'sell' ? 'sell' : null;
        if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(d.tradeId), side, price, amount, notionalUsd: price * amount, t });
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
 * Deribit perpetuals. BTC-PERPETUAL: amounts are USD (10 per contract), and the book arrives whole every 100 ms as 20 bands a side grouped
 * by $10 (the server's setting). ETH-PERPETUAL is sized in USD too; the other coins trade as USDC perpetuals sized in coins. Their books
 * come ungrouped (the groupings Deribit accepts differ per instrument): the best 20 levels a side, whole every 100 ms.
 */
export class DeribitConnector extends MarketBook {
  readonly id = 'deribit'; readonly name = 'Deribit'; readonly quote = 'USD'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('deribit')) { super(market); }
  /** $10 bands for BTC, as the server reads it; single levels for the rest. */
  readonly #group = this.market.symbol === 'BTC-PERPETUAL' ? '10' : 'none';
  protected override get coarse() { return this.#group !== 'none'; }
  /** A grouped level is named by the middle of its $10 band. */
  protected override band(price: number) { return { lo: price - 5, hi: price + 5 }; }
  protected url() { return 'wss://www.deribit.com/ws/api/v2'; }
  protected open(send: (p: unknown) => void) { send({ jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: [`book.${this.symbol}.${this.#group}.20.100ms`, `trades.${this.symbol}.100ms`] } }); }
  protected override usdOf(price: number, size: number) { return this.market.inverse ? size : price * size; }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); const params = this.record(m?.params); if (!params) return;
    const channel = String(params.channel ?? '');
    if (channel.startsWith('book.')) {
      const d = this.record(params.data); if (!d) return;
      this.replace(this.bids, this.rows(d.bids)); this.replace(this.asks, this.rows(d.asks)); this.touch(); return;
    }
    if (channel.startsWith('trades.')) {
      for (const item of Array.isArray(params.data) ? params.data : []) {
        const d = this.record(item); if (!d) continue;
        const price = num(d.price), amount = num(d.amount), t = num(d.timestamp), side = d.direction === 'buy' ? 'buy' : d.direction === 'sell' ? 'sell' : null;
        if (!side || !(price > 0) || !(amount > 0) || !Number.isFinite(t)) continue;
        // A coin-margined perpetual's amount is USD; a USDC one's is coins.
        if (this.market.inverse) this.emitTrade({ tradeId: String(d.trade_id), side, price, amount: amount / price, notionalUsd: amount, t });
        else this.emitTrade({ tradeId: String(d.trade_id), side, price, amount, notionalUsd: price * amount, t });
      }
    }
  }
}

// ---- Hyperliquid --------------------------------------------------------------------------------------------------------------------

/** Hyperliquid perpetuals: l2Book at three significant figures (20 aggregated bands a side, about $100 wide for BTC, each named by its lower edge) and trades. */
/** The server's setting (HL_BOOK_NSIG_FIGS defaults to 3): bands about $100 wide at BTC's price. */
const HL_SIG_FIGS = 3;
export class HyperliquidConnector extends MarketBook {
  readonly id = 'hyperliquid'; readonly name = 'Hyperliquid'; readonly quote = 'USD'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('hyperliquid')) { super(market); }
  /** The instrument is named as the server names it (BTC-PERP); the market's own name for the coin is what it subscribes with. */
  override get symbol(): string { return `${this.market.symbol}-PERP`; }
  protected override get coarse() { return true; }
  protected override band(price: number) { try { const b = hyperliquidGroupingBoundsDecimal(price, HL_SIG_FIGS); return { lo: b.lower, hi: b.upper }; } catch { return { lo: price, hi: price }; } }
  protected url() { return 'wss://api.hyperliquid.xyz/ws'; }
  protected open(send: (p: unknown) => void) {
    send({ method: 'subscribe', subscription: { type: 'l2Book', coin: this.market.symbol, nSigFigs: HL_SIG_FIGS } });
    send({ method: 'subscribe', subscription: { type: 'trades', coin: this.market.symbol } });
  }
  override keepalive() { return { everyMs: 30_000, frame: () => ({ method: 'ping' }) }; }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); if (!m) return;
    if (m.channel === 'l2Book') {
      const levels = this.record(m.data)?.levels;
      if (!Array.isArray(levels) || levels.length < 2) return;
      const side = (rows: unknown): [number, number][] => Array.isArray(rows) ? rows.flatMap(r => { const d = this.record(r); return d ? [[num(d.px), num(d.sz)] as [number, number]] : []; }).filter(([p, q]) => p > 0 && q >= 0) : [];
      this.replace(this.bids, side(levels[0])); this.replace(this.asks, side(levels[1])); this.touch(); return;
    }
    if (m.channel === 'trades') {
      for (const item of Array.isArray(m.data) ? m.data : []) {
        const d = this.record(item); if (!d) continue;
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
  /** The book connector first, then any feed that only carries trades. */
  make(): { book: BookConnector; feeds: BookConnector[] };
}

const POST_JSON = { method: 'POST', headers: { 'content-type': 'application/json' } } as const;

/** Each market: its name, kind, reachability request and connectors for one coin's listing there. */
const VENUE_SPECS: readonly (Omit<BrowserVenue, 'listed' | 'make'> & { id: MarketVenue; make(market: Market): { book: BookConnector; feeds: BookConnector[] } })[] = [
  { id: 'binance', name: 'Binance', kind: 'perp', recommended: true, probe: { url: 'https://fapi.binance.com/fapi/v1/ping' }, make: m => ({ book: new BinancePerpConnector(m), feeds: [new BinancePerpTrades(m)] }) },
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
  // Optional (docs/deslop/venue-defaults-2026-10-05.md, 2026-10-08): large by volume and open interest, but a page gets only its best 20
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
