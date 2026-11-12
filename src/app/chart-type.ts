import { t } from './i18n.ts';

/**
 * How the map draws its price (Karl, 2026-10-28: "candlestick types ... currently we don't have a selector"): filled candles, outlined
 * candles (both ways hollow, so the heat shows through them), OHLC bars, or a line through the closes. Each keeps the contrasting halo that
 * makes the price read over bright heat, and breaks where candles are missing.
 *
 * Not offered, by the reasoning of 2026-10-28 (with two reviewers): Heikin Ashi, whose candles are averages and so sit at prices that never
 * traded, on a map whose whole point is where real prices are; Renko, Kagi, line break, point and figure and range charts, which give up the
 * time axis the heat map is drawn on; area, baseline, HLC area and columns, which fill over the heat.
 */
export type ChartType = 'candles' | 'outline' | 'bars' | 'line';
export const CHART_TYPES: readonly ChartType[] = ['candles', 'outline', 'bars', 'line'];

export const chartTypeName = (c: ChartType): string => ({ candles: t('Candles'), outline: t('Outline candles'), bars: t('OHLC bars'), line: t('Line') })[c];
export const chartTypeTip = (c: ChartType): string => ({
  candles: t('Candles: filled bodies, drawn as outlines while live trades show so the orders inside them stay visible.'),
  outline: t('Outline candles: every body an outline, so the liquidity under the candles shows through.'),
  bars: t('OHLC bars: a line from the low to the high, the open a tick to the left and the close a tick to the right.'),
  line: t('Line: the closes joined, the lightest way to see the price over the heat.'),
})[c];

export const readChartType = (saved: unknown): ChartType => CHART_TYPES.includes(saved as ChartType) ? saved as ChartType : 'candles';

/**
 * The Chart type menu also takes the price off the map (Karl, 2026-11-12: the Panels deck's Candles switch did nothing but show and hide the
 * candles, and the Chart type button never said whether they were drawn). Hidden leaves the heatmap and the trade bubbles with nothing on top
 * and keeps the type for when the price comes back; choosing a type draws the price that way. The button is lit while the price is drawn.
 * Hidden is `show.candles` off, as the switch was, so saved pages and layouts mean what they meant.
 */
export const CHART_HIDDEN = 'hidden';
export type ChartChoice = ChartType | typeof CHART_HIDDEN;
/** The menu's ticked row: the type while the price is drawn, Hidden while it is not. */
export const chartChoiceOf = (chartType: ChartType, shown: boolean): ChartChoice => shown ? chartType : CHART_HIDDEN;
/** A menu row as a choice, or null for any other row (Candle colours) or none. */
export const readChartChoice = (id: string | null): ChartChoice | null => id === CHART_HIDDEN || CHART_TYPES.includes(id as ChartType) ? id as ChartChoice : null;
/**
 * What a choice sets, and only what it changes (a new `show` lays the panes out again): a type draws the price that way, bringing it back
 * from Hidden; Hidden takes it away and leaves the type as it was.
 */
export function chartChoicePatch<S extends { candles: boolean }>(choice: ChartChoice, show: S): { chartType?: ChartType; show?: S } {
  if (choice === CHART_HIDDEN) return show.candles ? { show: { ...show, candles: false } } : {};
  return show.candles ? { chartType: choice } : { chartType: choice, show: { ...show, candles: true } };
}
export const chartChoiceName = (c: ChartChoice): string => c === CHART_HIDDEN ? t('Hidden') : chartTypeName(c);

/** Each type's small drawing for its button (24 x 24, in the stroke of the text around it). */
const GLYPHS: Record<ChartType, string> = {
  candles: '<path d="M8 3v18M16 5v14"/><rect x="5.5" y="7" width="5" height="9" fill="currentColor"/><rect x="13.5" y="9" width="5" height="6" fill="currentColor"/>',
  outline: '<path d="M8 3v4M8 16v5M16 5v4M16 15v4"/><rect x="5.5" y="7" width="5" height="9"/><rect x="13.5" y="9" width="5" height="6"/>',
  bars: '<path d="M8 4v16M5 8h3M8 16h3M16 6v12M13 15h3M16 9h3"/>',
  line: '<path d="M3 17l5-6 4 3 4-7 5 4"/>',
};
export function chartTypeGlyph(c: ChartType): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'chart-type-glyph');
  svg.innerHTML = GLYPHS[c];
  return svg;
}
