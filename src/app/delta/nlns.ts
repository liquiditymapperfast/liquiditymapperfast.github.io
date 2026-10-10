import { t } from '../i18n.ts';
import { clock, usd } from '../format.ts';
import type { InfoLine } from '../infobox.ts';
import type { OiBar } from '../store.ts';
import type { CandleFlow } from './candles.ts';

/**
 * NL/NS: an estimate of who opened and closed positions in each candle. Every position has a long and a short holder, so open interest
 * cannot say which side was new; this assigns each candle's change of open interest to the side that traded at market (the taker delta of
 * the same market, or, where its flow is not recorded, the way its price went). Open interest up with buyers: new longs; up with sellers:
 * new shorts; down with sellers: longs closed; down with buyers: shorts closed. The value `v` is that change signed by the side (new longs
 * and shorts closed are +, new shorts and longs closed are −); its running sum is the net positioning of the side that traded at market.
 */

export type NlnsKind = 'newLongs' | 'newShorts' | 'longsClosed' | 'shortsClosed';
export interface NlnsCandle {
  t: number;
  /** The change of open interest over the candle (coins) and what it was at the candle's start. */
  dOi: number; oiStart: number;
  /** +1 buyers, −1 sellers, 0 neither; `byPrice` when it is the price's way, not the taker delta. */
  side: 1 | -1 | 0; byPrice: boolean;
  v: number; kind: NlnsKind | null;
  /** The running sum of `v` from the last restart, and which run it is in. */
  cum: number; run: number;
}

/** Each candle's change of open interest from the close of the candle before to its own (bars on the chart's timeframe); null across a gap. */
export function oiDeltas(bars: readonly OiBar[], starts: readonly number[], tfMs: number): ({ dOi: number; oiStart: number } | null)[] {
  const close = new Map<number, number>();
  for (const b of bars) close.set(b[0], b[4]);
  return starts.map(t => {
    const before = close.get(t - tfMs), now = close.get(t);
    return before !== undefined && now !== undefined ? { dOi: now - before, oiStart: before } : null;
  });
}

/** The candles: `flows` are the OI market's taker flow per candle (null where not recorded), `priceWay` its price's way (+1, −1, 0). */
export function nlnsCandles(starts: readonly number[], deltas: readonly ({ dOi: number; oiStart: number } | null)[], flows: readonly (CandleFlow | null)[],
  priceWay: readonly number[], keys: readonly number[]): NlnsCandle[] {
  const out: NlnsCandle[] = [];
  let cum = 0, key = NaN, gap = true, run = -1;
  for (let i = 0; i < starts.length; i++) {
    const d = deltas[i];
    if (!d) { gap = true; continue; }
    if (keys[i] !== key || gap) { cum = 0; key = keys[i]!; gap = false; run++; }
    const flow = flows[i], byFlow = flow ? Math.sign(flow.delta) : 0, byPrice = byFlow === 0 ? Math.sign(priceWay[i] ?? 0) : 0;
    const side = (byFlow || byPrice) as 1 | -1 | 0, v = side * Math.abs(d.dOi);
    const kind: NlnsKind | null = side === 0 || d.dOi === 0 ? null : d.dOi > 0 ? (side > 0 ? 'newLongs' : 'newShorts') : (side > 0 ? 'shortsClosed' : 'longsClosed');
    cum += v;
    out.push({ t: starts[i]!, dOi: d.dOi, oiStart: d.oiStart, side, byPrice: byFlow === 0 && byPrice !== 0, v, kind, cum, run });
  }
  return out;
}

/** An amount of coins, signed and short: "+325 BTC", "−1.2M DOGE". */
export function coinText(v: number, coin: string): string {
  const a = Math.abs(v), body = a === 0 ? '0' : a >= 1_000 ? usd(a) : a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(1) : a.toPrecision(2);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${body}${coin ? ` ${coin}` : ''}`;
}

const KIND_TEXT: Record<NlnsKind, () => string> = {
  newLongs: () => t('New longs'), newShorts: () => t('New shorts'), longsClosed: () => t('Longs closed'), shortsClosed: () => t('Shorts closed'),
};

/** The popup of one candle: the change of open interest (and its share of it), what it is read as and from what, and the running sum. */
export function nlnsCardLines(c: NlnsCandle, tf: string, coin: string, market: string): InfoLine[] {
  const share = c.oiStart > 0 ? ` · ${c.dOi >= 0 ? '+' : '−'}${(Math.abs(c.dOi) / c.oiStart * 100).toFixed(2)}%` : '';
  return [
    { text: `${clock(c.t, true)} · ${tf}`, bold: true },
    { label: t('Open interest'), text: `${coinText(c.dOi, coin)}${share}`, bold: true },
    { label: t('Read as'), text: c.kind ? KIND_TEXT[c.kind]() : t('no change'), color: c.v > 0 ? 'buy' : c.v < 0 ? 'sell' : 'text' },
    { label: t('Side'), text: c.side === 0 ? t('neither') : c.byPrice ? (c.side > 0 ? t('price rose (no flow recorded)') : t('price fell (no flow recorded)')) : (c.side > 0 ? t('buyers at market') : t('sellers at market')), color: 'muted' },
    { label: t('Since the start'), text: coinText(c.cum, coin), color: c.cum > 0 ? 'buy' : c.cum < 0 ? 'sell' : 'text' },
    { text: t('An estimate for {market}: the change of open interest given to the side that traded at market.', { market }), color: 'muted' },
  ];
}
