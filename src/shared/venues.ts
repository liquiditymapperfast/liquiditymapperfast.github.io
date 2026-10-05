import { BinanceSpotConnector, BookConnector } from './connector.ts';
import { hyperliquidGroupingBoundsDecimal } from '../analytics/hyperliquid-bounds.mts';

/**
 * The venues the browser connects to itself: public order-book and trade feeds, BTC only. Each venue is one book connector plus, where the
 * book's socket does not already carry trades, a feed for them. Sizes are converted to USD here (contract sizes and USD-denominated
 * amounts are venue facts), so everything downstream sees base-coin or USD figures.
 */

const num = (value: unknown): number => Number(value);
const iso = (value: unknown): number => Date.parse(String(value));

/** A feed that only carries executions: it never has a book, but reconnects and reports its state like any connector. */
abstract class TradeFeed extends BookConnector {
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
  readonly id = 'binancespot'; readonly name = 'Binance spot'; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'spot' as const;
  protected url() { return 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade'; }
  protected open() { /* the stream is chosen by the address */ }
}
export class BinancePerpTrades extends BinanceTrades {
  readonly id = 'binance'; readonly name = 'Binance'; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  protected url() { return 'wss://fstream.binance.com/market/ws/btcusdt@aggTrade'; }
  protected open() { /* the stream is chosen by the address */ }
}

/** Binance USD-M perpetual: the diff-depth stream chained on the previous update id (\`pu\`), synchronised with a REST snapshot. */
export class BinancePerpConnector extends BookConnector {
  readonly id = 'binance'; readonly name = 'Binance'; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  #lastUpdateId = 0; #prevU = 0; #synced = false; #buffer: Record<string, unknown>[] = []; #loading = false;
  protected url() { return 'wss://fstream.binance.com/public/ws/btcusdt@depth@100ms'; }
  protected open() { void this.#snapshot(); }
  async #snapshot(): Promise<void> {
    if (this.#loading) return; this.#loading = true;
    try {
      const response = await fetch('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000', { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`);
      const body = this.record(await response.json()); if (!body) throw new Error('snapshot not an object');
      this.seed(num(body.lastUpdateId), this.rows(body.bids), this.rows(body.asks));
    } catch (error) { this.fail(`snapshot failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160)); }
    finally { this.#loading = false; }
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

/** Bybit USDT linear perpetual: orderbook.1000 snapshot then deltas (u counts up by one), and publicTrade on the same socket. */
export class BybitConnector extends BookConnector {
  readonly id = 'bybit'; readonly name = 'Bybit'; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  #u = 0;
  protected url() { return 'wss://stream.bybit.com/v5/public/linear'; }
  protected open(send: (p: unknown) => void) { send({ op: 'subscribe', args: ['orderbook.1000.BTCUSDT', 'publicTrade.BTCUSDT'] }); }
  override keepalive() { return { everyMs: 20_000, frame: () => ({ op: 'ping' }) }; }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); if (!m) return;
    const topic = String(m.topic ?? '');
    if (topic.startsWith('publicTrade.')) {
      for (const item of Array.isArray(m.data) ? m.data : []) {
        const d = this.record(item); if (!d) continue;
        const price = num(d.p), amount = num(d.v), t = num(d.T), side = d.S === 'Buy' ? 'buy' : d.S === 'Sell' ? 'sell' : null;
        if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(d.i), side, price, amount, notionalUsd: price * amount, t });
      }
      return;
    }
    if (topic !== 'orderbook.1000.BTCUSDT') return;
    const d = this.record(m.data); if (!d) return;
    const u = num(d.u);
    if (m.type === 'snapshot') { this.replace(this.bids, this.rows(d.b)); this.replace(this.asks, this.rows(d.a)); this.#u = u; this.touch(); return; }
    if (!this.#u) return; // deltas before the first snapshot
    if (u !== this.#u + 1) { this.fail(`sequence gap ${this.#u} -> ${u}`); return; }
    this.#u = u; this.apply(this.bids, this.rows(d.b)); this.apply(this.asks, this.rows(d.a)); this.touch();
  }
  protected override reset() { super.reset(); this.#u = 0; }
}

// ---- OKX ----------------------------------------------------------------------------------------------------------------------------

/** OKX USDT swap: sizes are contracts (0.01 BTC each, read from the instrument list when it answers); books chain on prevSeqId. */
export class OkxConnector extends BookConnector {
  readonly id = 'okx'; readonly name = 'OKX'; readonly symbol = 'BTC-USDT-SWAP'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  /** BTC per contract. */
  contract = 0.01;
  #seq = -1;
  protected url() { return 'wss://ws.okx.com:8443/ws/v5/public'; }
  protected open(send: (p: unknown) => void) {
    send({ op: 'subscribe', args: [{ channel: 'books', instId: this.symbol }, { channel: 'trades', instId: this.symbol }] });
    void fetch(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${this.symbol}`, { signal: AbortSignal.timeout(10_000) })
      .then(r => r.json() as Promise<{ data?: { ctVal?: string }[] }>).then(body => { const v = num(body.data?.[0]?.ctVal); if (v > 0) this.contract = v; }).catch(() => { /* the documented value stands */ });
  }
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

// ---- Bitget -------------------------------------------------------------------------------------------------------------------------

/** Bitget USDT futures: books snapshot then updates chained on seq/pseq, and trades on the same socket. */
export class BitgetConnector extends BookConnector {
  readonly id = 'bitget'; readonly name = 'Bitget'; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  #seq = 0;
  protected url() { return 'wss://ws.bitget.com/v2/ws/public'; }
  protected open(send: (p: unknown) => void) { send({ op: 'subscribe', args: [{ instType: 'USDT-FUTURES', channel: 'books', instId: this.symbol }, { instType: 'USDT-FUTURES', channel: 'trade', instId: this.symbol }] }); }
  override keepalive() { return { everyMs: 25_000, frame: () => 'ping' }; }
  onMessage(text: string) {
    if (text === 'pong') return;
    const m = this.record(JSON.parse(text)); if (!m) return;
    const channel = this.record(m.arg)?.channel;
    const data = Array.isArray(m.data) ? m.data : [];
    if (channel === 'trade') {
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

// ---- Coinbase -----------------------------------------------------------------------------------------------------------------------

/** Coinbase Exchange BTC-USD: level2_batch (snapshot then l2update changes) and matches. The match side is the maker's, so the taker is the other one. */
export class CoinbaseConnector extends BookConnector {
  readonly id = 'coinbase'; readonly name = 'Coinbase'; readonly symbol = 'BTC-USD'; readonly quote = 'USD'; readonly marketType = 'spot' as const;
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
      if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(m.trade_id), side, price, amount, notionalUsd: price * amount, t });
    }
  }
}

// ---- Deribit ------------------------------------------------------------------------------------------------------------------------

/** Deribit BTC-PERPETUAL: amounts are USD (10 per contract), the grouped top-20 book arrives whole every 100 ms. */
export class DeribitConnector extends BookConnector {
  readonly id = 'deribit'; readonly name = 'Deribit'; readonly symbol = 'BTC-PERPETUAL'; readonly quote = 'USD'; readonly marketType = 'perpetual' as const;
  protected url() { return 'wss://www.deribit.com/ws/api/v2'; }
  protected open(send: (p: unknown) => void) { send({ jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: ['book.BTC-PERPETUAL.none.20.100ms', 'trades.BTC-PERPETUAL.100ms'] } }); }
  protected override usdOf(_price: number, size: number) { return size; }
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
        const price = num(d.price), usd = num(d.amount), t = num(d.timestamp), side = d.direction === 'buy' ? 'buy' : d.direction === 'sell' ? 'sell' : null;
        if (side && price > 0 && usd > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(d.trade_id), side, price, amount: usd / price, notionalUsd: usd, t });
      }
    }
  }
}

// ---- Hyperliquid --------------------------------------------------------------------------------------------------------------------

/** Hyperliquid BTC perpetual: l2Book at two significant figures (20 aggregated bands a side, each named by its lower edge) and trades. */
export class HyperliquidConnector extends BookConnector {
  readonly id = 'hyperliquid'; readonly name = 'Hyperliquid'; readonly symbol = 'BTC-PERP'; readonly quote = 'USD'; readonly marketType = 'perpetual' as const;
  protected override readonly coarse = true;
  protected override band(price: number) { try { const b = hyperliquidGroupingBoundsDecimal(price, 2); return { lo: b.lower, hi: b.upper }; } catch { return { lo: price, hi: price }; } }
  protected url() { return 'wss://api.hyperliquid.xyz/ws'; }
  protected open(send: (p: unknown) => void) {
    send({ method: 'subscribe', subscription: { type: 'l2Book', coin: 'BTC', nSigFigs: 2 } });
    send({ method: 'subscribe', subscription: { type: 'trades', coin: 'BTC' } });
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
        if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: `${t}:BTC:${String(d.tid)}`, side, price, amount, notionalUsd: price * amount, t });
      }
    }
  }
}

// ---- The set ------------------------------------------------------------------------------------------------------------------------

export interface BrowserVenue {
  /** The venue id the picker and the chips use ("binance" is the perpetual, "binancespot" the spot book). */
  id: string; name: string; kind: 'perp' | 'spot';
  /** Part of the set a first visit starts with. */
  recommended: boolean;
  /** The book connector first, then any feed that only carries trades. */
  make(): { book: BookConnector; feeds: BookConnector[] };
}

export const BROWSER_VENUES: readonly BrowserVenue[] = [
  { id: 'binance', name: 'Binance', kind: 'perp', recommended: true, make: () => ({ book: new BinancePerpConnector(), feeds: [new BinancePerpTrades()] }) },
  { id: 'bybit', name: 'Bybit', kind: 'perp', recommended: true, make: () => ({ book: new BybitConnector(), feeds: [] }) },
  { id: 'okx', name: 'OKX', kind: 'perp', recommended: true, make: () => ({ book: new OkxConnector(), feeds: [] }) },
  { id: 'bitget', name: 'Bitget', kind: 'perp', recommended: true, make: () => ({ book: new BitgetConnector(), feeds: [] }) },
  { id: 'hyperliquid', name: 'Hyperliquid', kind: 'perp', recommended: true, make: () => ({ book: new HyperliquidConnector(), feeds: [] }) },
  { id: 'deribit', name: 'Deribit', kind: 'perp', recommended: true, make: () => ({ book: new DeribitConnector(), feeds: [] }) },
  { id: 'binancespot', name: 'Binance spot', kind: 'spot', recommended: true, make: () => ({ book: new BinanceSpotConnector(), feeds: [new BinanceSpotTrades()] }) },
  { id: 'coinbase', name: 'Coinbase', kind: 'spot', recommended: true, make: () => ({ book: new CoinbaseConnector(), feeds: [] }) },
];
