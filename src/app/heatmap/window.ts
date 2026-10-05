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
