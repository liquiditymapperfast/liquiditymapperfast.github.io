import { readColor } from './anchors/anchors.ts';
import { mixHex, type Palette } from './theme.ts';

/**
 * The candles' own colours (a user, 2026-11-11, who built a panel for them in his copy: "Colours of your own, in place of the theme's"):
 * for rising and for falling candles, the body, the border and the wick, each the theme's until one is chosen. The body is a candle's colour
 * wherever it has one colour only: the OHLC bars, the price line and its tag, the legend's figures. On outline candles the border and the
 * wick are the body's unless they have colours of their own; on filled ones they are the theme's edge (white on a dark page, near-black on a
 * light one), as they were before there were colours of one's own. A script that colours a candle (`$price.color`) still colours it.
 */
export type CandleDirection = 'up' | 'down';
export type CandlePart = 'body' | 'border' | 'wick';
export const CANDLE_PARTS: readonly CandlePart[] = ['body', 'border', 'wick'];
export const CANDLE_DIRECTIONS: readonly CandleDirection[] = ['up', 'down'];
export type CandleSideColors = Readonly<Partial<Record<CandlePart, string>>>;
export interface CandleColors { readonly up: CandleSideColors; readonly down: CandleSideColors }
export const CANDLE_COLORS_DEFAULT: CandleColors = Object.freeze({ up: Object.freeze({}), down: Object.freeze({}) });

/** Candle colours as kept or read from a layout file (which can come from anywhere): each part a #rrggbb colour, or the theme's. */
export function readCandleColors(saved: unknown): CandleColors {
  const side = (value: unknown): CandleSideColors => {
    const out: Partial<Record<CandlePart, string>> = {};
    if (value && typeof value === 'object') for (const part of CANDLE_PARTS) { const color = readColor((value as Record<string, unknown>)[part]); if (color) out[part] = color; }
    return out;
  };
  const s = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  return { up: side(s.up), down: side(s.down) };
}

/** Whether any candle colour is one's own. */
export const hasCandleColors = (c: CandleColors): boolean => CANDLE_PARTS.some(part => c.up[part] !== undefined || c.down[part] !== undefined);

/** The colours with one part set (`color`) or given back to the theme (null). */
export function withCandleColor(c: CandleColors, direction: CandleDirection, part: CandlePart, color: string | null): CandleColors {
  const side: Partial<Record<CandlePart, string>> = { ...c[direction] }, own = color === null ? undefined : readColor(color);
  if (own) side[part] = own; else delete side[part];
  return direction === 'up' ? { up: side, down: c.down } : { up: c.up, down: side };
}

/** The theme's edge of a filled candle and its wick, as it is drawn (a little see-through over the heat). */
export const themeEdge = (p: Pick<Palette, 'dark'>): string => p.dark ? 'rgba(255,255,255,0.92)' : 'rgba(18,20,24,0.92)';
/** The same edge as one colour on the page's background, for a colour picker, which takes no transparency. */
export const themeEdgeHex = (p: Pick<Palette, 'dark' | 'bg'>): string => mixHex(p.dark ? '#ffffff' : '#121418', p.bg, 0.08);

/** The theme's colour of a rising or a falling candle. */
export const themeBody = (direction: CandleDirection, p: Pick<Palette, 'candleUp' | 'candleDown'>): string => direction === 'up' ? p.candleUp : p.candleDown;

/** The colour that says a candle's direction where there is one colour only (OHLC bars, the price line and tag, the legend): its body's. */
export const candleTone = (c: CandleColors, direction: CandleDirection, p: Pick<Palette, 'candleUp' | 'candleDown'>): string => c[direction].body ?? themeBody(direction, p);

/** What a candle is drawn in. */
export interface CandleInk { body: string; border: string; wick: string }
/**
 * A candle's colours as drawn: filled (its body filled, the theme's edge around it and as its wick unless they have colours of their own),
 * or as an outline or an OHLC bar (the border and the wick the body's unless they have their own). A script's colour for the candle
 * (`script`, '' for none) is its body, and on an outline or a bar its whole line.
 */
export function candleInk(c: CandleColors, direction: CandleDirection, p: Pick<Palette, 'dark' | 'candleUp' | 'candleDown'>, filled: boolean, script = ''): CandleInk {
  const own = c[direction], body = script || (own.body ?? themeBody(direction, p));
  if (filled) return { body, border: own.border ?? themeEdge(p), wick: own.wick ?? themeEdge(p) };
  return script ? { body, border: script, wick: script } : { body, border: own.border ?? body, wick: own.wick ?? body };
}
