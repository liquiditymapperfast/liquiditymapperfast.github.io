import type { ValuedBook, SideLevels } from './levels.ts';
import { gridStepFor } from './grid.ts';
import { mergeByDistance } from './merge.ts';

export type ConnectorState = 'stopped' | 'connecting' | 'live' | 'error';
/**
 * `lastError` clears once the venue is live again; `lastFailure` keeps the reason for the most recent reconnect. `everLive` says the venue
 * has delivered data at least once since it was started, and `failures` counts the connections lost since it last did: a venue that has
 * never been live and keeps failing while others are fine is probably unreachable from here.
 */
export interface ConnectorStatus { state: ConnectorState; lastError: string | null; lastFailure: string | null; lastUpdate: number; reconnects: number; everLive: boolean; failures: number }

/** One executed trade, normalised: `side` is the taker's side, `amount` is in base coin and `notionalUsd` in USD (or the USD stable). */
export interface TradeEvent { instrumentId: string; tradeId: string; side: 'buy' | 'sell'; price: number; amount: number; notionalUsd: number; t: number }

/** Books with at least this many levels are re-valued no more often than the interval below (the recorder samples every 5 s). */
const DEEP_BOOK_LEVELS = 2_000, DEEP_BOOK_INTERVAL_MS = 1_000;

const MAX_LEVELS = 3_000;
/** Default silence after which a feed is treated as dead; thin markets override it (a quiet book is not a broken one). */
const SILENCE_MS = 20_000;
/** How long a new connection may take to deliver its first data (the snapshot arrives on subscribing, so this is generous) before it is dropped and tried again. */
const STARTUP_MS = 30_000;

const num = (value: unknown): number => Number(value);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const rows = (value: unknown): [number, number][] => Array.isArray(value)
  ? value.flatMap(row => Array.isArray(row) ? [[num(row[0]), num(row[1])] as [number, number]] : []).filter(([p, q]) => Number.isFinite(p) && p > 0 && Number.isFinite(q) && q >= 0) : [];

/** A self-contained public order-book connector: owns its socket, reconnects with backoff and keeps a local book. */
export abstract class BookConnector {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly symbol: string;
  abstract readonly quote: string;
  abstract readonly marketType: 'spot' | 'perpetual';
  readonly base = 'BTC';
  protected bids = new Map<number, number>();
  protected asks = new Map<number, number>();
  state: ConnectorState = 'stopped';
  lastError: string | null = null;
  lastFailure: string | null = null;
  lastUpdate = 0;
  reconnects = 0;
  /** Delivered data at least once since start, and connections lost since it last did. */
  everLive = false;
  failures = 0;
  /** Receives every trade the venue sends on this socket; set by whoever records them. */
  onTrade: (trade: TradeEvent) => void = () => {};
  #socket: WebSocket | null = null;
  #ping: ReturnType<typeof setInterval> | null = null;
  #pending: unknown = null;
  #flush: ReturnType<typeof setTimeout> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #watchdog: ReturnType<typeof setInterval> | null = null;
  #attempt = 0;
  /** Bumped whenever a connection ends or a new one starts, so what an old connection left in flight (a REST snapshot, an open event) can tell it is stale. */
  #generation = 0; #connectAt = 0;
  #version = 0; #cachedVersion = -1; #cached: ValuedBook | null = null; #cachedAt = 0;

  get instrumentId(): string { return `${this.id}:${this.symbol}`; }
  protected abstract url(): string;
  /** Send subscription frames once the socket is open. */
  protected abstract open(send: (payload: unknown) => void): void;
  /** Handle one decoded frame (text) and update the local book. May call `fail` to force a reconnect. */
  abstract onMessage(text: string): void;
  /** Frames arrive as text unless a venue compresses them. */
  decode(data: unknown): string | null {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    return null;
  }

  /** How long the feed may stay silent before it is reconnected; the book is withheld a little after that. */
  protected silenceMs(): number { return SILENCE_MS; }
  /** How long a new connection may stay without its first data before it is reconnected. */
  protected startupMs(): number { return STARTUP_MS; }
  /** The connection this is (a counter that changes whenever one ends or begins): work started for an older one must not touch this one. */
  protected get generation(): number { return this.#generation; }
  /** Venues that resend the whole book many times a second only need the newest frame handled once per interval (0 = handle every frame). */
  protected coalesceMs(): number { return 0; }
  /** Application-level keepalive for venues that close idle sockets (WebSocket ping frames are answered by the runtime). */
  keepalive(): { everyMs: number; frame: () => unknown } | null { return null; }

  /** USD value of `size` resting at `price`: base-coin sizes by default; venues that size in contracts or in USD override. */
  protected usdOf(price: number, size: number): number { return price * size; }
  /** Venues that publish aggregated price bands rather than ticks name the band a level belongs to ([lo, hi)); those books are never merged. */
  protected readonly coarse: boolean = false;
  protected band(_price: number): { lo: number; hi: number } { return { lo: _price, hi: _price }; }
  /** Report a trade parsed from this venue's frames. */
  protected emitTrade(trade: Omit<TradeEvent, 'instrumentId'>): void { this.onTrade({ instrumentId: this.instrumentId, ...trade }); }

  status(): ConnectorStatus { return { state: this.state, lastError: this.lastError, lastFailure: this.lastFailure, lastUpdate: this.lastUpdate, reconnects: this.reconnects, everLive: this.everLive, failures: this.failures }; }

  start(): void {
    if (this.state !== 'stopped') return;
    this.#connect();
    this.#watchdog = setInterval(() => this.check(), 5_000);
    this.#watchdog.unref?.();
  }
  /**
   * One look at the feed: a live one that has gone quiet, or a new one that has not delivered its first data in time (an open socket whose
   * subscription was never answered stays "connecting" for ever otherwise), is dropped and reconnected. Public so a test can say what time it is.
   */
  check(now: number = Date.now()): void {
    if (this.state === 'live' && now - this.lastUpdate > this.silenceMs()) this.fail(`no data for ${Math.round(this.silenceMs() / 1000)} s`);
    else if (this.state === 'connecting' && this.#socket !== null && now - this.#connectAt > this.startupMs()) this.fail(`no data ${Math.round(this.startupMs() / 1000)} s after connecting`);
  }
  stop(): void {
    this.state = 'stopped'; this.#generation++; this.reset(); this.#stopPing(); this.#dropPending();
    if (this.#retry) clearTimeout(this.#retry); this.#retry = null;
    if (this.#watchdog) clearInterval(this.#watchdog); this.#watchdog = null;
    const socket = this.#socket; this.#socket = null; try { socket?.close(); } catch { /* already closed */ }
  }
  /** Drop the book and reconnect (sequence gap, bad frame, silence). */
  fail(reason: string): void {
    this.failures++; this.#generation++;
    this.lastError = reason; this.lastFailure = reason; this.reset(); this.#stopPing(); this.#dropPending();
    const socket = this.#socket; this.#socket = null; try { socket?.close(); } catch { /* already closed */ }
    this.#scheduleReconnect();
  }
  protected reset(): void { this.bids.clear(); this.asks.clear(); this.#version++; }
  protected touch(): void { this.lastUpdate = Date.now(); this.#version++; if (this.state === 'connecting') { this.state = 'live'; this.#attempt = 0; this.lastError = null; this.everLive = true; this.failures = 0; } }
  protected replace(side: Map<number, number>, levels: [number, number][]): void { side.clear(); for (const [p, q] of levels) if (q > 0) side.set(p, q); }
  protected apply(side: Map<number, number>, levels: [number, number][]): void { for (const [p, q] of levels) { if (q > 0) side.set(p, q); else side.delete(p); } }
  protected rows = rows;
  protected record = record;

  #connect(): void {
    this.state = 'connecting'; this.#connectAt = Date.now(); this.#generation++;
    try {
      const socket = new WebSocket(this.url()); socket.binaryType = 'arraybuffer'; this.#socket = socket;
      socket.onopen = () => {
        if (this.#socket !== socket) return; // the connection was stopped or replaced while it was opening: it must not subscribe now
        const send = (payload: unknown) => socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload)); // a string is sent as it is (Bitget's "ping")
        this.open(send);
        const ka = this.keepalive();
        if (ka) { this.#stopPing(); this.#ping = setInterval(() => { try { send(ka.frame()); } catch { /* socket closing; onclose handles it */ } }, ka.everyMs); this.#ping.unref?.(); }
      };
      socket.onmessage = event => { if (this.#socket === socket) this.receive(event.data); };
      socket.onerror = () => { if (this.#socket === socket) this.fail('socket error'); };
      socket.onclose = () => { if (this.#socket === socket) this.fail('socket closed'); };
    } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
  }
  /** Entry point for a raw frame: decode and apply it now, or keep only the newest one for the next flush. */
  receive(data: unknown): void {
    const wait = this.coalesceMs();
    if (wait <= 0) { this.#process(data); return; }
    this.#pending = data;
    if (!this.#flush) this.#flush = setTimeout(() => { this.#flush = null; const latest = this.#pending; this.#pending = null; if (latest !== null && this.state !== 'stopped') this.#process(latest); }, wait);
  }
  #process(data: unknown): void {
    try { const text = this.decode(data); if (text !== null) this.onMessage(text); }
    catch (error) { this.fail(`bad frame: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160)); }
  }
  #dropPending(): void { if (this.#flush) clearTimeout(this.#flush); this.#flush = null; this.#pending = null; }
  #stopPing(): void { if (this.#ping) clearInterval(this.#ping); this.#ping = null; }
  #scheduleReconnect(): void {
    if (this.state === 'stopped' || this.#retry) return;
    this.state = 'error'; this.reconnects++;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.#attempt++, 5));
    this.#retry = setTimeout(() => { this.#retry = null; if (this.state !== 'stopped') this.#connect(); }, delay);
    this.#retry.unref?.();
  }

  /** The current book in USD (price x base size, all venues here quote in USD or a USD stable), or null when not fresh and uncrossed. */
  valued(now: number, gridStep?: number): ValuedBook | null {
    if (this.state !== 'live' || now - this.lastUpdate > this.silenceMs() + 10_000) return null;
    if (this.#cachedVersion === this.#version) return this.#cached;
    // A deep book changes on nearly every tick and costs a pass over every level; the map and ladder move slowly, so it is re-valued at most once a second.
    if (this.#cached && this.bids.size + this.asks.size >= DEEP_BOOK_LEVELS && now - this.#cachedAt < DEEP_BOOK_INTERVAL_MS) return this.#cached;
    this.#cachedVersion = this.#version; this.#cachedAt = now;
    const side = (map: Map<number, number>, descending: boolean): SideLevels => {
      const prices = [...map.keys()].sort((a, b) => descending ? b - a : a - b);
      const lo = new Float64Array(prices.length), hi = this.coarse ? new Float64Array(prices.length) : lo, usd = new Float64Array(prices.length);
      prices.forEach((p, i) => { const b = this.coarse ? this.band(p) : null; lo[i] = b ? b.lo : p; if (b) hi[i] = b.hi; usd[i] = this.usdOf(p, map.get(p)!); });
      return { lo, hi, usd };
    };
    let bids = side(this.bids, true), asks = side(this.asks, false);
    if (this.coarse) {
      if (!bids.usd.length || !asks.usd.length) { this.#cached = null; return null; }
      this.#cached = { instrumentId: this.instrumentId, venue: this.id, timestamp: this.lastUpdate, coarse: true, bids, asks };
      return this.#cached;
    }
    if (bids.usd.length && asks.usd.length && bids.lo[0]! < asks.lo[0]!) {
      // Far levels merge into buckets that widen with distance, so a deep book keeps its range inside the level cap.
      const mid = (bids.lo[0]! + asks.lo[0]!) / 2, step = gridStep && gridStep > 0 ? gridStep : gridStepFor(mid);
      bids = mergeByDistance(bids, mid, step, true); asks = mergeByDistance(asks, mid, step, false);
    }
    const cap = (s: SideLevels): SideLevels => s.usd.length <= MAX_LEVELS ? s : { lo: s.lo.subarray(0, MAX_LEVELS), hi: s.lo.subarray(0, MAX_LEVELS), usd: s.usd.subarray(0, MAX_LEVELS) };
    bids = cap(bids); asks = cap(asks);
    if (!bids.usd.length || !asks.usd.length || bids.lo[0]! >= asks.lo[0]!) { this.#cached = null; return null; }
    this.#cached = { instrumentId: this.instrumentId, venue: this.id, timestamp: this.lastUpdate, coarse: false, bids, asks };
    return this.#cached;
  }
}

/** HitBTC spot: orderbook/full snapshot then sequenced updates; quantity 0 deletes a level. */
export class HitbtcConnector extends BookConnector {
  readonly id = 'hitbtc'; readonly name = 'HitBTC'; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'spot' as const;
  #seq = 0;
  protected url() { return 'wss://api.hitbtc.com/api/3/ws/public'; }
  /** BTC/USDT spot on HitBTC is thin enough to sit quiet for tens of seconds. */
  protected override silenceMs() { return 150_000; }
  protected open(send: (p: unknown) => void) { send({ method: 'subscribe', ch: 'orderbook/full', params: { symbols: [this.symbol] }, id: 1 }); }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); if (!m || m.ch !== 'orderbook/full') return;
    const snapshot = this.record(this.record(m.snapshot)?.[this.symbol]), update = this.record(this.record(m.update)?.[this.symbol]);
    if (snapshot) { this.replace(this.bids, this.rows(snapshot.b)); this.replace(this.asks, this.rows(snapshot.a)); this.#seq = num(snapshot.s); this.touch(); return; }
    if (update) {
      const s = num(update.s);
      if (this.#seq && s !== this.#seq + 1) { this.fail(`sequence gap ${this.#seq} -> ${s}`); return; }
      this.#seq = s; this.apply(this.bids, this.rows(update.b)); this.apply(this.asks, this.rows(update.a)); this.touch();
    }
  }
  protected override reset() { super.reset(); this.#seq = 0; }
}

/** Poloniex spot book_lv2: snapshot then updates; quantity 0 deletes a level. */
export class PoloniexConnector extends BookConnector {
  readonly id = 'poloniex'; readonly name = 'Poloniex'; readonly symbol = 'BTC_USDT'; readonly quote = 'USDT'; readonly marketType = 'spot' as const;
  protected url() { return 'wss://ws.poloniex.com/ws/public'; }
  protected open(send: (p: unknown) => void) { send({ event: 'subscribe', channel: ['book_lv2'], symbols: [this.symbol] }); }
  override keepalive() { return { everyMs: 20_000, frame: () => ({ event: 'ping' }) }; }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); if (!m || m.channel !== 'book_lv2' || !Array.isArray(m.data)) return;
    for (const item of m.data) {
      const d = this.record(item); if (!d || d.symbol !== this.symbol) continue;
      if (m.action === 'snapshot') { this.replace(this.bids, this.rows(d.bids)); this.replace(this.asks, this.rows(d.asks)); }
      else { this.apply(this.bids, this.rows(d.bids)); this.apply(this.asks, this.rows(d.asks)); }
      this.touch();
    }
  }
}

/** Bitunix USDT-margined futures depth_books: full snapshots. */
export class BitunixConnector extends BookConnector {
  readonly id = 'bitunix'; readonly name = 'Bitunix'; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  protected url() { return 'wss://fapi.bitunix.com/public/'; }
  protected open(send: (p: unknown) => void) { send({ op: 'subscribe', args: [{ symbol: this.symbol, ch: 'depth_books' }] }); }
  /** Full 1000-level snapshots arrive many times a second; the map samples at 4 Hz. */
  protected override coalesceMs() { return 400; }
  override keepalive() { return { everyMs: 20_000, frame: () => ({ op: 'ping', ping: Math.floor(Date.now() / 1000) }) }; }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); if (!m || m.ch !== 'depth_books' || m.symbol !== this.symbol) return;
    const d = this.record(m.data); if (!d) return;
    this.replace(this.bids, this.rows(d.b)); this.replace(this.asks, this.rows(d.a)); this.touch();
  }
}

/** Binance-style spot venue: diff-depth stream synchronised with a REST snapshot (Binance's documented procedure). */
export abstract class BinanceDiffDepthConnector extends BookConnector {
  readonly marketType = 'spot' as const;
  protected abstract readonly wsBase: string;
  protected abstract readonly restBase: string;
  /** Levels requested with the REST snapshot (the venue's maximum is 5000). */
  protected readonly snapshotLimit: number = 1000;
  #lastUpdateId = 0; #prevU = 0; #synced = false; #buffer: Record<string, unknown>[] = [];
  /** The connection a snapshot request is in flight for (-1: none), so one connection asks once and a retired one's answer is not taken for the next one's. */
  #loadingFor = -1;
  protected url() { return `${this.wsBase}/ws/${this.symbol.toLowerCase()}@depth@100ms`; }
  protected open() { void this.#snapshot(); }
  async #snapshot(): Promise<void> {
    const generation = this.generation;
    if (this.#loadingFor === generation) return; this.#loadingFor = generation;
    try {
      const response = await fetch(`${this.restBase}/api/v3/depth?symbol=${this.symbol}&limit=${this.snapshotLimit}`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`);
      const body = this.record(await response.json()); if (!body) throw new Error('snapshot not an object');
      // An answer for a connection that has since ended or been replaced is not this one's snapshot: seeding it would put the new
      // connection on a book from another moment and call it live.
      if (generation !== this.generation) return;
      this.seed(num(body.lastUpdateId), this.rows(body.bids), this.rows(body.asks));
    } catch (error) { if (generation === this.generation) this.fail(`snapshot failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160)); }
    finally { if (this.#loadingFor === generation) this.#loadingFor = -1; }
  }
  /** Install the REST snapshot and replay any diff events buffered while it loaded. */
  seed(lastUpdateId: number, bids: [number, number][], asks: [number, number][]): void {
    this.#lastUpdateId = lastUpdateId; this.replace(this.bids, bids); this.replace(this.asks, asks);
    this.#synced = false; this.#prevU = 0;
    const pending = this.#buffer.splice(0); for (const event of pending) this.#event(event);
    this.touch();
  }
  onMessage(text: string) {
    const e = this.record(JSON.parse(text)); if (!e || e.e !== 'depthUpdate') return;
    if (!this.#lastUpdateId) { this.#buffer.push(e); if (this.#buffer.length > 5_000) this.fail('snapshot never arrived'); return; }
    this.#event(e);
  }
  /**
   * Binance's procedure: drop what the snapshot (or an earlier event) already covers, require the next range to contain the update after the
   * last applied one, and resynchronise on a gap. A range that overlaps what was applied is applied again (levels carry absolute
   * quantities, so that is harmless) and one that is wholly behind it is ignored: neither is a reason to throw the book away.
   */
  #event(e: Record<string, unknown>) {
    const U = num(e.U), u = num(e.u);
    const applied = this.#synced ? this.#prevU : this.#lastUpdateId;
    if (u <= applied) return;
    if (U > applied + 1) { this.fail(this.#synced ? `sequence gap ${applied} -> ${U}` : `snapshot behind stream (${applied} < ${U})`); return; }
    this.#synced = true;
    this.#prevU = u; this.apply(this.bids, this.rows(e.b)); this.apply(this.asks, this.rows(e.a)); this.touch();
  }
  protected override reset() { super.reset(); this.#lastUpdateId = 0; this.#prevU = 0; this.#synced = false; this.#buffer = []; }
}

/** Binance.US spot. */
export class BinanceUsConnector extends BinanceDiffDepthConnector {
  readonly id = 'binanceus'; readonly name = 'Binance US'; readonly symbol = 'BTCUSD'; readonly quote = 'USD';
  protected readonly wsBase = 'wss://stream.binance.us:9443'; protected readonly restBase = 'https://api.binance.us';
}

/** Binance spot, the deepest spot book: the REST snapshot holds up to 5000 levels at a one-cent tick, and the diff stream keeps adding far ones. */
export class BinanceSpotConnector extends BinanceDiffDepthConnector {
  readonly id = 'binancespot'; readonly name = 'Binance spot'; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT';
  protected readonly wsBase = 'wss://stream.binance.com:9443'; protected readonly restBase = 'https://api.binance.com';
  protected override readonly snapshotLimit = 5000;
}
