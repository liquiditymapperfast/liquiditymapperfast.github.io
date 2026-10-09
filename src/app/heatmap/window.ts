/**
 * The colour window: which cell sizes (USD) the colour ramp spans. Its baseline comes from the percentiles of the cells on screen
 * (the page's own auto-contrast), and the Contrast slider slides it along the size axis, so the same ramp is spent on thinner liquidity
 * (to the right) or only on the biggest walls (to the left).
 */
export interface SizeWindow { lo: number; hi: number }

/**
 * The slider: 50 is the baseline, 100 slides the window down by three quarters of its own width (the log of hi / lo) to reach thinner
 * liquidity, 0 slides it up by the same, and below 0 it keeps going the same way, so the biggest walls come out paler and paler
 * (the original range stopped at 0, which was not far enough when many venues are added together and the walls are huge).
 */
export const CONTRAST = { min: -100, max: 100, neutral: 50 } as const;

/** A contrast value as the slider can hold it; anything else (a saved value from somewhere unexpected) is the neutral one. */
export function clampContrast(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(CONTRAST.min, Math.min(CONTRAST.max, Math.round(n))) : CONTRAST.neutral;
}

/** The window for a baseline and a slider position (a placeholder window until there is a baseline to move). */
export function colourWindow(baseline: SizeWindow | null, contrast: number): SizeWindow {
  if (!baseline) return { lo: 1, hi: 2 };
  const shift = -((clampContrast(contrast) - CONTRAST.neutral) / CONTRAST.neutral) * Math.log(baseline.hi / baseline.lo) * 0.75;
  return { lo: baseline.lo * Math.exp(shift), hi: baseline.hi * Math.exp(shift) };
}

/** The window taken from the cells on screen, and the view it was taken for: when (`at`, `since`: the last new view) and the price span. */
export interface Baseline extends SizeWindow { at: number; since: number; spanP: number }

/** How long a new view's baseline keeps following the cells while its history loads, and how often Auto blends it toward them after that. */
export const SETTLE_MS = 15_000, BLEND_MS = 10_000;

/**
 * The baseline after a raster with percentiles `s`. A new view (`force`: recentred, another market, venues or size; or a price span 2x off
 * the baseline's) takes a new one, with Auto off too: a cell holds every price of its row, so cell sizes follow the zoom, and a window kept
 * from another view saturates everything or nothing. It follows the cells for `SETTLE_MS` after that, while the view's history loads (the
 * first raster can hold little more than the live column). Then Auto blends it halfway toward the cells every `BLEND_MS`; Auto off holds it.
 */
export function nextBaseline(b: Baseline | null, s: { p15: number; p96: number }, o: { auto: boolean; force: boolean; spanP: number; now: number }): Baseline | null {
  if (!(s.p96 > 0)) return b;
  const hi = s.p96, lo = Math.max(1, Math.min(s.p15, hi / 4));
  const zoomed = b !== null && o.spanP > 0 && b.spanP > 0 && Math.abs(Math.log(o.spanP / b.spanP)) > Math.LN2;
  if (!b || o.force || zoomed) return { lo, hi, at: o.now, since: o.now, spanP: o.spanP };
  if (o.now - b.since < SETTLE_MS) return { ...b, lo, hi, at: o.now };
  if (!o.auto || o.now - b.at <= BLEND_MS) return b;
  const blend = (from: number, to: number): number => Math.exp(Math.log(from) * 0.5 + Math.log(to) * 0.5);
  return { ...b, lo: blend(b.lo, lo), hi: blend(b.hi, hi), at: o.now };
}
