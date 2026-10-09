import { venueLabel } from '../venues.ts';
import { venueOfInstrument } from '../cvd/families.ts';

/**
 * The Compact book's bar, split into the venues that make up each level: what is drawn and what the pointer finds on it come from here.
 *
 * The venues keep one order on every row (`rankVenues`: the most liquidity in view first), so a venue's piece stays in its place and can be
 * followed down the column. A piece too narrow to see joins the smaller venues' piece at the end of the bar, so a dozen hairlines do not
 * become noise; the pointer still finds each of them by name.
 */
export interface BarPiece {
  /** The venue, or null for the smaller venues together. */
  id: string | null;
  usd: number;
  x: number; w: number;
  /** Its place in the venue order (the shade alternates with it); -1 for the smaller venues. */
  rank: number;
  /** The venues in the smaller venues' piece, largest first (empty for a venue's own piece). */
  merged: { id: string; usd: number }[];
}

/**
 * Split a level's bar: `values[k]` is the part of venue `ids[k]` (the venues in their fixed order). A venue whose part would be at least `minPx`
 * wide is a piece of its own, in that order; the narrower ones are one piece at the end. Widths are in proportion to `maxLevel` over `barW`.
 */
export function barPieces(ids: readonly string[], values: readonly number[], maxLevel: number, barX: number, barW: number, minPx: number): BarPiece[] {
  const out: BarPiece[] = [], small: { id: string; usd: number }[] = [];
  const scale = maxLevel > 0 ? barW / maxLevel : 0;
  let x = barX;
  ids.forEach((id, k) => {
    const v = values[k] ?? 0; if (!(v > 0)) return;
    const w = v * scale;
    if (w < minPx) { small.push({ id, usd: v }); return; }
    out.push({ id, usd: v, x, w, rank: k, merged: [] }); x += w;
  });
  if (small.length) {
    const usd = small.reduce((sum, s) => sum + s.usd, 0);
    out.push({ id: null, usd, x, w: usd * scale, rank: -1, merged: small.sort((a, b) => b.usd - a.usd) });
  }
  return out;
}

/** The piece under `x`, or null (past the bar's end, or on nothing). */
export const pieceAt = (pieces: readonly BarPiece[], x: number): BarPiece | null => pieces.find(p => x >= p.x && x < p.x + Math.max(1, p.w)) ?? null;

/** The venues in the order the bar keeps them: the most liquidity first (`total(id)`), and of two equal the one first in `ids`. */
export function rankVenues(ids: readonly string[], total: (id: string) => number): string[] {
  return ids.map((id, i) => ({ id, i, v: total(id) })).sort((a, b) => b.v - a.v || a.i - b.i).map(e => e.id);
}

/**
 * Short names for narrow labels, one each: three letters would make five venues 'BIT' (Bitget, Bitstamp, Bitfinex, BitMEX, Bitunix). A venue
 * missing here falls back to its first three letters.
 */
export const VENUE_CODES: Readonly<Record<string, string>> = {
  aster: 'AST', binance: 'BIN', binanceus: 'BUS', bitfinex: 'BFX', bitget: 'BGT', bitmart: 'BMT', bitmex: 'BMX', bitstamp: 'BST', bitunix: 'BTU',
  bybit: 'BYB', coinbase: 'CB', cryptocom: 'CRO', deribit: 'DRB', dydx: 'DYD', gateio: 'GATE', hitbtc: 'HIT', htx: 'HTX', hyperliquid: 'HL', kraken: 'KRK',
  kucoin: 'KUC', mexc: 'MEXC', okx: 'OKX', phemex: 'PHX', poloniex: 'POL', whitebit: 'WBT',
};

/** A venue's short name for a narrow label, and "·S" for a spot market ("BIN", "BIN·S"). */
export function venueCode(id: string): string {
  const venue = venueOfInstrument(id), spot = venue.length > 4 && venue.endsWith('spot'), family = spot ? venue.slice(0, -4) : venue;
  return `${VENUE_CODES[family] ?? venueLabel(family).slice(0, 3).toUpperCase()}${spot ? '·S' : ''}`;
}

/**
 * The label that fits a piece `width` px wide, the most it can say: the venue's name and size, its code and size, its name, its code; null
 * when not even the code fits. `measure` gives a text's width in px; `pad` is kept clear at each end.
 */
export function pieceLabel(id: string, size: string, width: number, measure: (text: string) => number, pad = 4): string | null {
  const name = venueLabel(venueOfInstrument(id)), code = venueCode(id);
  for (const text of [`${name} ${size}`, `${code} ${size}`, name, code]) if (measure(text) + 2 * pad <= width) return text;
  return null;
}
