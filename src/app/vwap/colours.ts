import type { Palette } from '../theme.ts';
import type { VwapColors } from './settings.ts';

/**
 * The VWAP lines' default colours, chosen against the heat map under them (Sol and the advisor, 2026-11-11): the heat ramp runs blue, cyan,
 * white, yellow, orange and red on the dark themes (white, blue, yellow, orange and red on the light ones), so the rolling windows take greens
 * and the anchors violets, hues the heat map never draws, lighter on dark themes and deeper on light ones; the session VWAP keeps the theme's
 * VWAP colour. Every line also keeps its dash pattern, halo and label, so it reads without its colour too. A person can choose any of them
 * instead (the VWAP panel's swatches), and the starter script's magenta is not among them.
 */

const ROLLING_DARK: Record<number, string> = { 1: '#d9f99d', 7: '#a3e635', 30: '#4ade80', 90: '#34d399', 180: '#86efac', 365: '#a7f3d0' };
const ROLLING_LIGHT: Record<number, string> = { 1: '#4d7c0f', 7: '#65a30d', 30: '#15803d', 90: '#047857', 180: '#16a34a', 365: '#065f46' };
// Six apart within the family: lavender, light fuchsia, violet, periwinkle, fuchsia, light purple (on dark themes; none near the heat map's
// white, where two pale lavenders vanished), and their deep counterparts on light ones; each with its own dash too (`paint.ts dashOf`).
const ANCHOR_DARK: readonly string[] = ['#c4b5fd', '#f0abfc', '#a78bfa', '#818cf8', '#e879f9', '#d8b4fe'];
const ANCHOR_LIGHT: readonly string[] = ['#6d28d9', '#a21caf', '#7c3aed', '#4338ca', '#c026d3', '#9333ea'];

/** A rolling window's default colour on this theme. */
export const rollingDefault = (days: number, p: Pick<Palette, 'dark'>): string => (p.dark ? ROLLING_DARK : ROLLING_LIGHT)[days] ?? (p.dark ? '#86efac' : '#15803d');
/** An anchor's default colour on this theme, by the slot it was given when it was made. */
export const anchorDefault = (slot: number, p: Pick<Palette, 'dark'>): string => { const list = p.dark ? ANCHOR_DARK : ANCHOR_LIGHT; return list[((slot % list.length) + list.length) % list.length]!; };

/** The colour a line is drawn in: the one chosen for it, else its default on this theme. */
export function lineColor(line: { kind: string; n: number; slot?: number; color?: string }, colors: VwapColors, p: Pick<Palette, 'dark' | 'vwap'>): string {
  if (line.kind === 'session') return colors.session ?? p.vwap;
  if (line.kind === 'rolling') return colors.rolling[String(line.n)] ?? rollingDefault(line.n, p);
  if (line.kind === 'anchor') return line.color ?? anchorDefault(line.slot ?? line.n - 1, p);
  return p.vwap;
}
