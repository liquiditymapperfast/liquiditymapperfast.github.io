/**
 * Zooming the map's axes with the pointer. The wheel on the chart zooms time and price together, by the same factor, so the picture keeps the
 * shape the person gave it; the wheel (or a drag) on the price scale zooms price alone and the wheel on the time strip time alone. Each axis holds
 * still the thing a person is watching: the live edge for time and the current price for price while the map follows the market, the point under
 * the pointer once it has been moved by hand (and always with Alt). Pure functions, so the rules are tested without a canvas.
 */

/**
 * Where the pointer is on the map's canvas, in the plot's coordinates. `plotW` and `plotH` bound the chart itself; right of it are the profile
 * column and the price scale, left of it (negative x) the volume profile columns placed there.
 */
export type MapRegion = 'plot' | 'scale' | 'time';

/**
 * The part of the map under (`x`, `y`): below the plot is the time strip; right of it the profile column and the price scale, and left of it
 * the columns placed there, which zoom price as the columns on the right do.
 */
export function regionAt(x: number, y: number, plotW: number, plotH: number): MapRegion {
  return y > plotH ? 'time' : x > plotW || x < 0 ? 'scale' : 'plot';
}

/**
 * The axes a wheel turn zooms: on the chart both, time only with Shift (what the wheel did there before it zoomed both); on the price scale price, time
 * with Shift; on the time strip time, whatever the keys.
 */
export function wheelAxes(region: MapRegion, shift: boolean): readonly ('time' | 'price')[] {
  if (region === 'time') return ['time'];
  if (region === 'scale') return [shift ? 'time' : 'price'];
  return shift ? ['time'] : ['time', 'price'];
}

/**
 * The pixel the zoom holds still. Price: the current price while it is on the map (the scale swells and shrinks around it instead of
 * sliding), else the pointer; `holdMark: false` takes the pointer even then (a chart moved by hand, where the point under the pointer is what is
 * being looked at). Time: the live edge while the map follows the market, else the pointer. Alt always holds the pointer.
 */
export function holdPixel(o: { axis: 'time' | 'price'; pointer: number; size: number; alt: boolean; follow: boolean; mark: number; markPixel: number; nowPixel: number; holdMark?: boolean }): number {
  const clamp = (x: number): number => Math.max(0, Math.min(o.size, x));
  if (o.alt) return clamp(o.pointer);
  if (o.axis === 'price') return (o.holdMark ?? true) && o.mark > 0 && o.markPixel >= 0 && o.markPixel <= o.size ? o.markPixel : clamp(o.pointer);
  return o.follow && o.nowPixel >= 0 && o.nowPixel <= o.size ? o.nowPixel : clamp(o.pointer);
}

/** The shortest and longest time span the map zooms to, and the price span as a share of the current price. */
export const TIME_SPAN_MS = { min: 30_000, max: 400 * 86_400_000 } as const;
export const PRICE_SPAN_SHARE = { min: 1e-4, max: 2 } as const;

/**
 * `factor` (> 1 zooms out) limited so the span from `span` stays within [min, max]. A limit stops a turn that would take the span past it and never
 * reverses one: a span already past a limit (a chart framed wider than the price limit, a flat pair narrower than it) is held where it is by a turn
 * further out, and goes on by a turn the other way as asked, instead of being driven back by the turn it is not in the way of.
 */
export function limitFactor(factor: number, span: number, min: number, max: number): number {
  if (!(span > 0)) return 1;
  return factor < 1 ? Math.min(1, Math.max(min / span, factor)) : Math.max(1, Math.min(max / span, factor));
}

/** The price the span limits are a share of: the current price, or the middle of the view before there is one. */
export const priceRef = (mark: number, p0: number, p1: number): number => mark > 0 ? mark : Math.max(1e-9, Math.abs(p0 + p1) / 2);

/** How far one turn of the wheel zooms (> 1 zooms out): exp(0.0016 per pixel), a line counted as 33 pixels and a page as the plot's height, a turn at most 240 pixels. */
export function wheelFactor(deltaY: number, deltaMode: number, plotH: number): number {
  const lines = deltaMode === 1 ? 33 : deltaMode === 2 ? plotH : 1;
  return Math.exp(Math.sign(deltaY) * Math.min(Math.abs(deltaY * lines), 240) * 0.0016);
}

/** One wheel turn on the map: where the pointer is and what the map shows now. Pixels are the plot's (`x` 0 at its left edge, `y` 0 at its top). */
export interface WheelInput {
  region: MapRegion; shift: boolean; alt: boolean; follow: boolean;
  deltaY: number; deltaMode: number;
  x: number; y: number; plotW: number; plotH: number;
  view: { t0: number; t1: number; p0: number; p1: number };
  /** The current price, and the pixel row it is drawn at and the pixel column `now` is drawn at. */
  mark: number; markY: number; nowX: number;
}
/**
 * What a wheel turn does: for each axis it zooms, by how much (> 1 zooms out) and the pixel it holds still. The two factors are the same when both zoom.
 * `unfollow`: the turn holds the pointer (Alt) on a map that follows the market, so it is taken off the live point, as a drag takes it: the map would
 * otherwise slide with the market, and bring the current price back to the middle of the scale, from under the pointer.
 */
export interface WheelZoom { time: { factor: number; hold: number } | null; price: { factor: number; hold: number } | null; unfollow: boolean }

/**
 * The zoom of one wheel turn. When both axes zoom they take the same factor, so the picture keeps the shape the person gave it (the time and the
 * price a pixel stands for change in step), and the factor is held to the tighter of the two axes' limits: one axis at its limit stops both,
 * rather than the shape changing as the other goes on. The price is held at the current price while the map follows the market, else at the pointer.
 */
export function wheelZoom(o: WheelInput): WheelZoom {
  const axes = wheelAxes(o.region, o.shift), raw = wheelFactor(o.deltaY, o.deltaMode, o.plotH), v = o.view, ref = priceRef(o.mark, v.p0, v.p1);
  const time = limitFactor(raw, v.t1 - v.t0, TIME_SPAN_MS.min, TIME_SPAN_MS.max), price = limitFactor(raw, v.p1 - v.p0, ref * PRICE_SPAN_SHARE.min, ref * PRICE_SPAN_SHARE.max);
  const both = axes.length === 2, factor = both ? (raw < 1 ? Math.max(time, price) : Math.min(time, price)) : axes[0] === 'time' ? time : price;
  const held = { follow: o.follow, alt: o.alt, mark: o.mark, markPixel: o.markY, nowPixel: o.nowX };
  const zoomed = factor !== 1;
  return {
    unfollow: o.alt && o.follow && zoomed,
    time: axes.includes('time') ? { factor, hold: holdPixel({ ...held, axis: 'time', pointer: o.x, size: o.plotW }) } : null,
    // On the price scale the current price is held whenever it is on the map; on the chart only while the map follows the market.
    price: axes.includes('price') ? { factor, hold: holdPixel({ ...held, axis: 'price', pointer: o.y, size: o.plotH, holdMark: o.region === 'scale' || o.follow }) } : null,
  };
}
