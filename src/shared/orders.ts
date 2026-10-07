/**
 * Market orders rebuilt from their fills.
 *
 * A market order that takes several resting orders is reported by most exchanges as one trade per resting order it filled: Bybit, Bitget,
 * Deribit, Coinbase and Hyperliquid send every fill, while Binance and OKX send one row per order and price. A size floor or a size bucket
 * applied to each row therefore misses most large orders on the first group (measured 2026-10-07: on Bybit and Deribit about two thirds
 * of the USD in large one-price bursts arrived as fills under $25,000). Prints, sounds and size statistics count orders instead.
 *
 * The fills of one order share the venue's order key where the venue names one (Coinbase's taker order id, Bybit's `seq`, Hyperliquid's
 * transaction hash), and otherwise the exchange's millisecond: a matching engine stamps all the fills of one order with one time. Two orders
 * on the same side in the same millisecond of a venue without a key are taken for one; the price span and the fill count say what was merged.
 * Hyperliquid publishes no taker order id: its hash names the signed transaction, which may batch several orders of one account, so there a
 * batch of same-side orders sent together counts as one order.
 */

/** A fill as the recorders receive it; `order` (or a Hyperliquid row's `hash`) is the venue's own key for the order it belongs to. */
export interface FillLike {
  instrumentId?: unknown; tradeId?: unknown; side?: unknown; price?: unknown; amount?: unknown; notionalUsd?: unknown;
  sourceTimestamp?: unknown; receivedAt?: unknown; order?: unknown; hash?: unknown;
}

/** One market order: its first fill's time and id, the volume-weighted price of its fills, the prices it reached and how many fills it took. */
export interface MarketOrder {
  instrumentId: string; tradeId: string; side: 'buy' | 'sell';
  t: number; price: number; lo: number; hi: number; usd: number; fills: number;
}

/** An order is complete once this long has passed (by the receiving clock) without another of its fills. */
export const ORDER_QUIET_MS = 150;
const SEEN_MAX = 30_000;

/** The venue's key for the order a fill belongs to, or null when it names none (an all-zero Hyperliquid hash names none). */
export function venueOrderKey(fill: FillLike): string | null {
  const raw = fill.order ?? fill.hash;
  if (raw === undefined || raw === null) return null;
  const key = String(raw);
  return key === '' || /^0x0*$/i.test(key) ? null : key;
}

interface Open { key: string; order: MarketOrder; base: number; at: number }
/** A fill the builder took: instrument, taker side, price, USD and exchange time. */
export interface TakenFill { instrumentId: string; side: 'buy' | 'sell'; price: number; usd: number; t: number }

/**
 * Collects fills into market orders. Each instrument has at most one order open: a fill with another key closes it, and so does a quiet
 * spell (`drain`). Fills are taken once each (a feed that replays after a reconnect, or a list that is handed over again every pass, is
 * deduplicated by trade id per instrument).
 */
export class OrderBuilder {
  readonly #open = new Map<string, Open>();
  readonly #seen = new Map<string, Set<string>>();
  #done: MarketOrder[] = [];

  constructor(private now: () => number = Date.now, private quietMs = ORDER_QUIET_MS) {}

  /** Take fills not seen before; returns them, normalised (the absorption detector takes the same fills, once each). */
  add(fills: Iterable<FillLike>): TakenFill[] {
    const taken: TakenFill[] = [];
    for (const fill of fills) {
      const id = String(fill.instrumentId ?? ''), tradeId = String(fill.tradeId ?? '');
      const price = Number(fill.price), usd = Number(fill.notionalUsd ?? Number(fill.amount) * price);
      const t = Number(fill.sourceTimestamp ?? fill.receivedAt), side = String(fill.side).toLowerCase();
      if (!id || !tradeId || !(price > 0) || !(usd > 0) || !Number.isFinite(t) || (side !== 'buy' && side !== 'sell')) continue;
      let seen = this.#seen.get(id); if (!seen) { seen = new Set(); this.#seen.set(id, seen); }
      if (seen.has(tradeId)) continue;
      seen.add(tradeId);
      if (seen.size > SEEN_MAX) { const keep = [...seen].slice(-SEEN_MAX / 3); seen.clear(); for (const k of keep) seen.add(k); }
      const key = `${side}|${venueOrderKey(fill) ?? `t${t}`}`, open = this.#open.get(id), base = usd / price;
      if (open && open.key === key) {
        const o = open.order;
        o.usd += usd; o.fills++; o.lo = Math.min(o.lo, price); o.hi = Math.max(o.hi, price); o.t = Math.min(o.t, t);
        open.base += base; o.price = o.usd / open.base; open.at = this.now();
      } else {
        if (open) this.#done.push(open.order);
        this.#open.set(id, { key, base, at: this.now(), order: { instrumentId: id, tradeId, side, t, price, lo: price, hi: price, usd, fills: 1 } });
      }
      taken.push({ instrumentId: id, side, price, usd, t });
    }
    return taken;
  }

  /** The orders that are complete (closed by another order, or quiet for long enough), oldest first; with `all`, the open ones too. */
  drain(all = false): MarketOrder[] {
    const now = this.now();
    for (const [id, open] of this.#open) if (all || now - open.at >= this.quietMs) { this.#done.push(open.order); this.#open.delete(id); }
    const out = this.#done; this.#done = [];
    return out.sort((a, b) => a.t - b.t);
  }
}

/** An order in the row form the print stream takes (its id is its first fill's, so a replayed fill cannot print it twice). */
export function orderRow(o: MarketOrder): { instrumentId: string; tradeId: string; side: 'buy' | 'sell'; price: number; notionalUsd: number; sourceTimestamp: number; lo: number; hi: number; fills: number } {
  return { instrumentId: o.instrumentId, tradeId: o.tradeId, side: o.side, price: o.price, notionalUsd: o.usd, sourceTimestamp: o.t, lo: o.lo, hi: o.hi, fills: o.fills };
}
