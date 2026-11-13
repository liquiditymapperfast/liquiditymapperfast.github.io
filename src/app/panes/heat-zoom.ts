import type { CandleRow } from '../store.ts';

/**
 * Zooming the map's axes with the pointer. The wheel on the chart zooms time and price together, by the same factor, so the picture keeps the
 * shape the person gave it; the wheel (or a drag) on the price scale zooms price alone and the wheel on the time strip time alone. Each axis holds
 * still the thing a person is watching: the live edge for time and the current price for price while the map follows the market (while the live
 * edge is on it), the point under the pointer once it stays where it was left (and always with Alt). Pure functions, so the rules are tested
 * without a canvas. How a recentre frames the price, the current price in the middle, is here too (`fitPrices`), and how the price axis follows
 * the market while the map does (`followPrice`).
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

/**
 * Whether the live edge (`now`) is on the map, its first and last instants included: the map follows the market while it is, at the zoom it has,
 * and stays where it was left once it is not (HeatPane `#settleFollow`, decided when a hand lets go), as TradingView's charts do.
 */
export function liveEdgeShown(view: { t0: number; t1: number }, now: number): boolean {
  return view.t1 > view.t0 && now >= view.t0 && now <= view.t1;
}

/** A pan that moves the price this many pixels up or down, and more up or down than across, moved it on purpose (`holdsPrice`). */
export const PRICE_HOLD_PX = 24;
/**
 * Whether a pan that moved the map (`dx`, `dy`) pixels in all, a gesture's net move, moved the price on purpose: PRICE_HOLD_PX or more up or
 * down, and more up or down than across. A drag along the time axis drifts up or down by tens of pixels without meaning to: counted as a move of
 * the price, it held the price until Live or a recentre, and a trend then took the live candle off a map that went on following it (YRN, 2026-11-06).
 */
export function holdsPrice(dx: number, dy: number): boolean {
  return Math.abs(dy) >= PRICE_HOLD_PX && Math.abs(dy) > Math.abs(dx);
}

/**
 * While the map follows the market, the current price is kept clear of this share of the height at the top and the bottom (`priceClear`): nearer,
 * it is brought back to the middle. A hand that puts it there, or off the map, is looking above or below the price on purpose (`priceHeldAfter`).
 */
export const PRICE_BAND = 0.1;

/** Whether `mark` is clear of the top and bottom tenths of the map (PRICE_BAND), where the map following the market keeps it: false with no price or no view. */
export function priceClear(view: { p0: number; p1: number }, mark: number): boolean {
  const band = (view.p1 - view.p0) * PRICE_BAND;
  return mark > 0 && view.p1 > view.p0 && mark >= view.p0 + band && mark <= view.p1 - band;
}
/** Whether there is a price and it is at the top or bottom tenth of the map or off it, where the following would bring it back to the middle. */
export function priceAtEdge(view: { p0: number; p1: number }, mark: number): boolean {
  return mark > 0 && view.p1 > view.p0 && !priceClear(view, mark);
}

/**
 * Whether the price is held where a hand put it after a pan that moved the map (`dx`, `dy`) pixels in all, given whether the map follows the
 * market, whether the pan left the price at an `edge` (`priceAtEdge`) and whether it was `held` before. Only a pan that moved the price on purpose
 * (`holdsPrice`) while the map follows decides: it holds the price where it left it at an edge or off the map, where the follow would bring it
 * back to the middle at once (a look above or below the price), and lets it go where it left it in the clear, where the follow keeps it on the
 * map as it does a price no hand moved. Any other pan leaves the hold as it was. A hold taken in the clear did nothing then and one thing later:
 * it let a trend take the live candle off a map that went on following it (YRN, 2026-11-06).
 */
export function priceHeldAfter(o: { dx: number; dy: number; follow: boolean; edge: boolean; held: boolean }): boolean {
  return o.follow && holdsPrice(o.dx, o.dy) ? o.edge : o.held;
}

/**
 * One frame of the price axis following the market, while the map follows it and no hand holds the map: the current price is brought back to the
 * middle, the span kept, once it is no longer clear of the top and bottom tenths (`priceClear`), unless a hand holds it where it put it (`held`).
 */
export function followPrice(o: { p0: number; p1: number; mark: number; held: boolean }): { p0: number; p1: number } {
  const span = o.p1 - o.p0;
  if (o.held || !(o.mark > 0) || !(span > 0) || priceClear(o, o.mark)) return { p0: o.p0, p1: o.p1 };
  return { p0: o.mark - span / 2, p1: o.mark + span / 2 };
}

/** The shortest and longest time span the map zooms to, and the price span as a share of the current price. */
export const TIME_SPAN_MS = { min: 30_000, max: 400 * 86_400_000 } as const;
/**
 * The view that shows `box` (a stretch of time, a band of prices): centred on it, at least as wide and tall as the view now and 1.4 times the
 * box. A box without a finite price (a Trades block whose reference market did not trade) moves the time alone and keeps the price window.
 */
export function focusWindow(view: { t0: number; t1: number; p0: number; p1: number }, box: { t0: number; t1: number; p0: number; p1: number }): { t0: number; t1: number; p0: number; p1: number } {
  const span = Math.max(view.t1 - view.t0, (box.t1 - box.t0) * 1.4), tm = (box.t0 + box.t1) / 2;
  if (!Number.isFinite(box.p0) || !Number.isFinite(box.p1)) return { t0: tm - span / 2, t1: tm + span / 2, p0: view.p0, p1: view.p1 };
  const pSpan = Math.max(view.p1 - view.p0, (box.p1 - box.p0) * 1.4), pm = (box.p0 + box.p1) / 2;
  return { t0: tm - span / 2, t1: tm + span / 2, p0: pm - pSpan / 2, p1: pm + pSpan / 2 };
}
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

/** The room a fit leaves above the highest high and below the lowest low of the candles it frames, as a share of their range. */
export const FIT_PAD = 0.18;
/** How much wider than the candles' own frame a fit may make the price axis to keep the current price in its middle. */
export const FIT_WIDEN_MAX = 1.5;

/**
 * The price axis the page opens on, and a recentre gives: the current price (`mark`) in the middle of it, the recent `candles` (the caller's
 * run of them) in view with room above and below them (`FIT_PAD`). The span is the candles' own frame (their range and that room), widened as
 * far as the price needs to stay in the middle with them all in view, but no further than `FIT_WIDEN_MAX` times that frame: after a fall the
 * price sits at the foot of those candles, and keeping all of the move above it would squash the heat map into a thin band, so the end of it
 * farthest from the price is cut and a zoom out or a pan shows it (a pan alone where the span is already the zoom's limit, below) (Karl,
 * 2026-11-06: the charts opened with the price near the bottom of the axis and stayed there).
 * Candles without a range (none, or all at one price): 1 % either side of the price with that room, as before. No price yet (the page frames
 * before its first price on most openings): the newest candle's close stands in for it, which is the price as the candles last saw it, so the
 * axis is right from the first frame and nothing frames it again when the price comes. Nothing to centre on at all: the candles' own frame,
 * centred on them; neither candles nor a price: null, nothing to frame. The span is never more than PRICE_SPAN_SHARE.max times the price (the
 * zoom's own limit), so the axis never goes below zero after a fall that halved the price.
 */
export function fitPrices(candles: readonly CandleRow[], mark: number): { p0: number; p1: number } | null {
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { lo = Math.min(lo, c[3]); hi = Math.max(hi, c[2]); }
  const close = candles.length ? candles[candles.length - 1]![4] : 0;
  const price = mark > 0 && Number.isFinite(mark) ? mark : close > 0 && Number.isFinite(close) ? close : 0;
  if (!(hi > lo)) {
    if (!price) return null;
    lo = price * 0.99; hi = price * 1.01;
  }
  const pad = (hi - lo) * FIT_PAD, frame = hi - lo + 2 * pad;
  if (!price) return { p0: lo - pad, p1: hi + pad };
  // Twice the farther of the candles' extremes from the price, with their room: never less than their frame (the farther one is at least half
  // their range away wherever the price is) unless twice the price is less, as after a fall that halved it.
  const span = Math.min(2 * (Math.max(hi - price, price - lo) + pad), FIT_WIDEN_MAX * frame, PRICE_SPAN_SHARE.max * price);
  return { p0: price - span / 2, p1: price + span / 2 };
}

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
 * Whether the map follows the market after it is decided by where the live edge then is (HeatPane `#settleFollow`), Alt or not.
 */
export interface WheelZoom { time: { factor: number; hold: number } | null; price: { factor: number; hold: number } | null }

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
  return {
    time: axes.includes('time') ? { factor, hold: holdPixel({ ...held, axis: 'time', pointer: o.x, size: o.plotW }) } : null,
    // On the price scale the current price is held whenever it is on the map; on the chart only while the map follows the market.
    price: axes.includes('price') ? { factor, hold: holdPixel({ ...held, axis: 'price', pointer: o.y, size: o.plotH, holdMark: o.region === 'scale' || o.follow }) } : null,
  };
}

/** How fast a right-button drag zooms: exp(0.006 per pixel), so 120 px is about half or twice the span. */
export const DRAG_ZOOM_K = 0.006;

/**
 * The view a right-button drag on the chart gives: pressed at `press` on the view `v0` and now at `at` (plot pixels). Right zooms time in, up zooms
 * price in (left and down zoom out), each about the point pressed, which stays under the pointer's start; time no shorter than 30 s, price no
 * narrower than its share of `ref`. The drag itself and the tour's demonstration of it both use this, so the one shown is the one done.
 */
export function zoomedView(v0: { t0: number; t1: number; p0: number; p1: number }, press: { x: number; y: number }, at: { x: number; y: number }, plotW: number, plotH: number, ref: number): { t0: number; t1: number; p0: number; p1: number } {
  const fx = Math.exp(-(at.x - press.x) * DRAG_ZOOM_K), fy = Math.exp((at.y - press.y) * DRAG_ZOOM_K);
  const ax = Math.min(press.x, plotW) / plotW, ay = Math.min(press.y, plotH) / plotH;
  const tAnchor = v0.t0 + ax * (v0.t1 - v0.t0), pAnchor = v0.p0 + (1 - ay) * (v0.p1 - v0.p0);
  const tSpan = Math.max(TIME_SPAN_MS.min, (v0.t1 - v0.t0) * fx), pSpan = Math.max((v0.p1 - v0.p0) * fy, ref * PRICE_SPAN_SHARE.min);
  const t0 = tAnchor - ax * tSpan, p1 = pAnchor + ay * pSpan;
  return { t0, t1: t0 + tSpan, p0: p1 - pSpan, p1 };
}
