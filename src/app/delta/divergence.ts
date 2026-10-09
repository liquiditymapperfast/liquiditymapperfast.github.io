import type { DeltaCandle } from './candles.ts';

/**
 * Divergences between the price and the CVD: two swing highs in a row where the price made the higher one and the CVD the lower (sellers'
 * divergence, "bear"), or two swing lows where the price made the lower one and the CVD the higher (buyers', "bull"). A swing is a candle
 * whose high (low) is beyond the `pivot` candles each side of it, all of them closed, so a swing is confirmed `pivot` candles late and never
 * moves. The CVD is read at the same candles (its high at a swing high, its low at a swing low) and only within one run of it: across a
 * restart or a gap its level means nothing.
 */

/** One candle of the chart: its start and its high and low. */
export interface PriceBar { t: number; high: number; low: number }

export interface Divergence {
  kind: 'bear' | 'bull';
  /** The two swings' candle starts, older first. */
  from: number; to: number;
  priceFrom: number; priceTo: number;
  cvdFrom: number; cvdTo: number;
}

/** The swing highs (or lows) of `values` up to `last` (the newest closed candle): beyond the `k` before, and at least level with the `k` after. */
export function pivots(values: readonly number[], k: number, high: boolean, last: number): number[] {
  const out: number[] = [];
  for (let i = k; i + k <= last; i++) {
    const v = values[i]!;
    let ok = true;
    for (let j = i - k; j < i && ok; j++) ok = high ? v > values[j]! : v < values[j]!;
    for (let j = i + 1; j <= i + k && ok; j++) ok = high ? v >= values[j]! : v <= values[j]!;
    if (ok) out.push(i);
  }
  return out;
}

/** The divergences of `bars` (the chart's candles, oldest first) against `cvd` (the Delta pane's candles), oldest first; closed candles only. */
export function divergences(bars: readonly PriceBar[], cvd: readonly DeltaCandle[], tfMs: number, now: number, k: number): Divergence[] {
  let last = bars.length - 1;
  while (last >= 0 && bars[last]!.t + tfMs > now) last--;
  if (last < 2 * k) return [];
  const at = new Map(cvd.map(c => [c.t, c]));
  const out: Divergence[] = [];
  for (const kind of ['bear', 'bull'] as const) {
    const high = kind === 'bear';
    const swings = pivots(bars.map(b => high ? b.high : b.low), k, high, last);
    for (let n = 1; n < swings.length; n++) {
      const a = bars[swings[n - 1]!]!, b = bars[swings[n]!]!, ca = at.get(a.t), cb = at.get(b.t);
      if (!ca || !cb || ca.run !== cb.run) continue;
      const pa = high ? a.high : a.low, pb = high ? b.high : b.low, va = high ? ca.high : ca.low, vb = high ? cb.high : cb.low;
      if (high ? pb > pa && vb < va : pb < pa && vb > va) out.push({ kind, from: a.t, to: b.t, priceFrom: pa, priceTo: pb, cvdFrom: va, cvdTo: vb });
    }
  }
  return out.sort((x, y) => x.to - y.to || x.from - y.from);
}

/**
 * One divergence drawn: its two swings joined, dots at both, offset away from the candles (above the highs, below the lows), and an optional
 * label at the newer end.
 */
export function paintDivergence(ctx: CanvasRenderingContext2D, d: Divergence, x0: number, y0: number, x1: number, y1: number, color: string, label: string | null): void {
  const off = d.kind === 'bear' ? -5 : 5;
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.95;
  ctx.beginPath(); ctx.moveTo(x0, y0 + off); ctx.lineTo(x1, y1 + off); ctx.stroke();
  for (const [x, y] of [[x0, y0 + off], [x1, y1 + off]] as const) { ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill(); }
  if (label) {
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = d.kind === 'bear' ? 'bottom' : 'top';
    ctx.fillText(label, x1, y1 + off * 2);
  }
  ctx.restore();
}

/** The newest `max` divergences that reach into the window [t0, t1]. */
export function inView(list: readonly Divergence[], t0: number, t1: number, max = 6): Divergence[] {
  return list.filter(d => d.to >= t0 && d.from <= t1).slice(-max);
}
