/**
 * Zooming the map's axes with the pointer. The wheel on the chart zooms time, the wheel (or a drag) on the price scale zooms price, and
 * each holds still the thing a person is watching: the live edge for time while the map follows the market, the current price for price.
 * Pure functions, so the rules are tested without a canvas.
 */

/** Where the pointer is on the map's canvas. `plotW` and `plotH` bound the chart itself; right of it are the profile column and the price scale. */
export type MapRegion = 'plot' | 'scale' | 'time';

/** The part of the map under (`x`, `y`): below the plot is the time strip, right of it the profile column and the price scale. */
export function regionAt(x: number, y: number, plotW: number, plotH: number): MapRegion {
  return y > plotH ? 'time' : x > plotW ? 'scale' : 'plot';
}

/** Which axis a wheel turn zooms: the price scale zooms price and the chart and the time strip zoom time; Shift swaps the pair. */
export function wheelAxis(region: MapRegion, shift: boolean): 'time' | 'price' {
  const price = region === 'scale';
  return region === 'time' ? 'time' : price !== shift ? 'price' : 'time';
}

/**
 * The pixel the zoom holds still. Price: the current price while it is on the map (the scale swells and shrinks around it instead of
 * sliding), else the pointer. Time: the live edge while the map follows the market, else the pointer. Alt always holds the pointer.
 */
export function holdPixel(o: { axis: 'time' | 'price'; pointer: number; size: number; alt: boolean; follow: boolean; mark: number; markPixel: number; nowPixel: number }): number {
  const clamp = (x: number): number => Math.max(0, Math.min(o.size, x));
  if (o.alt) return clamp(o.pointer);
  if (o.axis === 'price') return o.mark > 0 && o.markPixel >= 0 && o.markPixel <= o.size ? o.markPixel : clamp(o.pointer);
  return o.follow && o.nowPixel >= 0 && o.nowPixel <= o.size ? o.nowPixel : clamp(o.pointer);
}

/** The shortest and longest time span the map zooms to, and the price span as a share of the current price. */
export const TIME_SPAN_MS = { min: 30_000, max: 400 * 86_400_000 } as const;
export const PRICE_SPAN_SHARE = { min: 1e-4, max: 2 } as const;

/** `factor` (> 1 zooms out) limited so the span from `span` stays within [min, max]. */
export function limitFactor(factor: number, span: number, min: number, max: number): number {
  return !(span > 0) ? 1 : Math.max(min / span, Math.min(max / span, factor));
}
