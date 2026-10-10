import type { CandleRow } from '../store.ts';
import type { Palette } from '../theme.ts';
import type { View } from '../view.ts';
import type { BarMarks } from './marks.ts';

/**
 * What runs on from a closed candle's footprint: its stacked imbalances as zones (a band of rows where one side kept outweighing the other
 * diagonally), until a later candle trades into them, and its point of control while no later candle has traded through it (a naked one).
 * Whether a later candle reached them is read from the chart market's candles. Worked out again only when the marks, the candles or the
 * clock's candle change, never per frame.
 */
export interface FootprintRun {
  kind: 'zone' | 'poc';
  /** The zone's side (buy: a stack of buy imbalances, support below; sell: resistance above); none for a point of control. */
  side?: 'buy' | 'sell';
  low: number; high: number;
  /** From the end of its candle to where a later candle reached it, or null while none has (it runs to the right edge). */
  from: number; until: number | null;
}

/** The start of the first candle from `after` whose range reaches into [low, high) (the rows' top edge belongs to the row above), or null. `candles` sorted by start. */
export function reachedAt(low: number, high: number, after: number, candles: readonly CandleRow[]): number | null {
  for (const c of candles) { if (c[0] < after) continue; if (c[3] < high && c[2] >= low) return c[0]; }
  return null;
}

/**
 * The zones and naked points of control of the closed candles marked, the newest `limit`: each zone until reached; each point of control
 * (its row) only while no later candle has traded into it.
 */
export function runsOf(marks: ReadonlyMap<number, BarMarks>, candles: readonly CandleRow[], tfMs: number, step: number, now: number, want: { zones: boolean; pocs: boolean }, limit = 80): FootprintRun[] {
  const out: FootprintRun[] = [];
  const bars = [...marks.entries()].filter(([t]) => t + tfMs <= now).sort((a, b) => b[0] - a[0]);
  for (const [t, m] of bars) {
    if (out.length >= limit) break;
    const from = t + tfMs;
    if (want.zones) for (const z of m.zones) out.push({ kind: 'zone', side: z.side, low: z.low, high: z.high, from, until: reachedAt(z.low, z.high, from, candles) });
    if (want.pocs && m.poc !== null && reachedAt(m.poc, m.poc + step, from, candles) === null) out.push({ kind: 'poc', low: m.poc, high: m.poc + step, from, until: null });
  }
  return out.slice(0, limit);
}

/** The runs, cached: worked out again when the marks (`marksKey`), the chart's candles or the candle under way change. */
export class FootprintRuns {
  #key = '';
  #runs: FootprintRun[] = [];
  get(marksKey: string, marks: ReadonlyMap<number, BarMarks>, candles: readonly CandleRow[], tfMs: number, step: number, now: number, want: { zones: boolean; pocs: boolean }): FootprintRun[] {
    const last = candles[candles.length - 1];
    const key = `${marksKey}|${step}|${tfMs}|${candles.length}|${last ? `${last[0]}|${last[2]}|${last[3]}` : ''}|${Math.floor(now / tfMs)}|${want.zones}|${want.pocs}`;
    if (key !== this.#key) { this.#key = key; this.#runs = runsOf(marks, candles, tfMs, step, now, want); }
    return this.#runs;
  }
}

/**
 * Draw the runs under the candles, faded with the footprint (`alpha`): a zone as a faint band in its side's colour with a firmer top and bottom
 * edge, from its candle to where it was reached (or the right edge); a naked point of control as a dotted line across its row's middle in the
 * profile's colour.
 */
export function paintRuns(ctx: CanvasRenderingContext2D, runs: readonly FootprintRun[], view: View, pw: number, ph: number, p: Palette, alpha: number): void {
  if (!runs.length || alpha <= 0.02) return;
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
  for (const r of runs) {
    const x0 = Math.max(-2, view.xOf(r.from, pw)), x1 = r.until === null ? pw + 2 : Math.min(pw + 2, view.xOf(r.until, pw));
    if (x1 <= x0 || x1 < 0 || x0 > pw) continue;
    const yTop = view.yOf(r.high, ph), yBottom = view.yOf(r.low, ph);
    if (yBottom < 0 || yTop > ph) continue;
    if (r.kind === 'zone') {
      const color = r.side === 'buy' ? p.candleUp : p.candleDown;
      ctx.globalAlpha = 0.14 * alpha; ctx.fillStyle = color; ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop);
      ctx.globalAlpha = 0.6 * alpha; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x0, Math.round(yTop) + 0.5); ctx.lineTo(x1, Math.round(yTop) + 0.5); ctx.moveTo(x0, Math.round(yBottom) - 0.5); ctx.lineTo(x1, Math.round(yBottom) - 0.5); ctx.stroke();
    } else {
      const y = Math.round((yTop + yBottom) / 2) + 0.5;
      ctx.globalAlpha = 0.85 * alpha; ctx.strokeStyle = p.poc; ctx.lineWidth = 1.2; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    }
  }
  ctx.restore(); ctx.globalAlpha = 1; ctx.setLineDash([]);
}
