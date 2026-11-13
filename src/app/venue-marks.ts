import { venueLabel } from './venues.ts';
import { pixelRatio } from './pixel-ratio.ts';

/**
 * A small mark for each exchange, drawn here: a square in the exchange's brand colour with a monogram in its ink colour, and a notch in the
 * corner for a spot market. The page draws its own marks (no logo files): the colours say which exchange it is at a glance, the letters
 * settle it, and an exchange missing from the table still gets a plain one from its name.
 *
 * The same mark is painted on canvases (`drawVenueMark`, cached as a bitmap per size) and set in the page (`venueMark`).
 */
export interface MarkStyle { bg: string; fg: string; text: string }

export const VENUE_MARKS: Readonly<Record<string, MarkStyle>> = {
  aster: { bg: '#f2c69b', fg: '#24160a', text: 'AS' },
  binance: { bg: '#f0b90b', fg: '#1e2026', text: 'B' },
  binanceus: { bg: '#f0b90b', fg: '#1e2026', text: 'US' },
  bitfinex: { bg: '#0b1e2b', fg: '#16b157', text: 'BF' },
  bitget: { bg: '#00c2d4', fg: '#06232a', text: 'BG' },
  bitmart: { bg: '#22252e', fg: '#23c686', text: 'BM' },
  bitmex: { bg: '#e8463f', fg: '#ffffff', text: 'BX' },
  bitstamp: { bg: '#14a05a', fg: '#ffffff', text: 'BS' },
  bitunix: { bg: '#1f1f1f', fg: '#b5f23d', text: 'BU' },
  bybit: { bg: '#17181e', fg: '#f7a600', text: 'BY' },
  coinbase: { bg: '#0052ff', fg: '#ffffff', text: 'C' },
  cryptocom: { bg: '#103f68', fg: '#ffffff', text: 'CR' },
  deribit: { bg: '#11c0a0', fg: '#052a23', text: 'D' },
  dydx: { bg: '#6966ff', fg: '#ffffff', text: 'dY' },
  gateio: { bg: '#2354e6', fg: '#ffffff', text: 'G' },
  hitbtc: { bg: '#0b71b9', fg: '#ffffff', text: 'HB' },
  htx: { bg: '#1e3c8c', fg: '#ffffff', text: 'HX' },
  hyperliquid: { bg: '#97fce4', fg: '#04201a', text: 'HL' },
  kraken: { bg: '#5741d9', fg: '#ffffff', text: 'K' },
  kucoin: { bg: '#24ae8f', fg: '#04261d', text: 'KC' },
  mexc: { bg: '#2f5ff0', fg: '#ffffff', text: 'MX' },
  okx: { bg: '#000000', fg: '#ffffff', text: 'OK' },
  phemex: { bg: '#1b1b1f', fg: '#c7f25a', text: 'PX' },
  poloniex: { bg: '#0f6b5c', fg: '#ffffff', text: 'PO' },
  whitebit: { bg: '#ececec', fg: '#111111', text: 'WB' },
};

type MarketLike = { instrumentId?: string | undefined; id?: string | undefined; marketType?: string | undefined };
/** Where the page's market list is read from (`useMarkets`), and the spot instruments of each list as it was read. */
let marketsOf: () => readonly MarketLike[] = () => [];
const spotSets = new WeakMap<readonly MarketLike[], ReadonlySet<string>>();
/**
 * The source should hand back the same list while it holds (the page's store does): `marksKey` asks `markOf` for every mark a frame, and
 * a list made afresh each time would have its spot set worked out again each time.
 */
export function useMarkets(source: () => readonly MarketLike[]): void { marketsOf = source; }
/**
 * The instruments the market list says are spot, and the venues all of whose markets are (Coinbase, Kraken): most spot markets carry no
 * "spot" in their venue (`binance:BTCUSDT:spot`, `coinbase:BTC-USD`), so the alias alone missed them. Read from the list as it is now, so
 * whatever draws a mark first after the list changes already has it.
 */
function spotIds(): ReadonlySet<string> {
  const markets = marketsOf();
  let set = spotSets.get(markets);
  if (set) return set;
  const ids = new Set<string>(), venues = new Map<string, boolean>();
  for (const m of markets) {
    const id = m.instrumentId ?? m.id; if (!id) continue;
    const spot = m.marketType === 'spot', venue = id.split(':')[0]!;
    if (spot) ids.add(id);
    venues.set(venue, (venues.get(venue) ?? true) && spot);
  }
  for (const [venue, all] of venues) if (all) ids.add(venue);
  spotSets.set(markets, set = ids);
  return set;
}
let lastSpots: ReadonlySet<string> | null = null, spotEpoch = 0;
/** A count that moves whenever the marks may look different (the market list's spot set changed): a canvas keeping marks draws them again. */
export function marksEpoch(): number {
  const spots = spotIds();
  if (spots !== lastSpots) { lastSpots = spots; spotEpoch++; }
  return spotEpoch;
}

/** The mark of an instrument or a venue (`binance:BTCUSDT`, `binancespot`, `binance`): its exchange's style, and whether it is a spot market. */
export function markOf(id: string): MarkStyle & { spot: boolean; family: string } {
  const venue = id.split(':')[0] ?? id, alias = venue.length > 4 && venue.endsWith('spot'), family = alias ? venue.slice(0, -4) : venue;
  const spot = alias || spotIds().has(id);
  const known = VENUE_MARKS[family];
  if (known) return { ...known, spot, family };
  const name = venueLabel(family).replace(/[^A-Za-z0-9]/g, '');
  return { bg: '#5d6470', fg: '#ffffff', text: (name.slice(0, 2) || '?').toUpperCase(), spot, family };
}

/** The monogram's size in a mark `size` px wide: fewer letters, larger. */
export const monogramPx = (size: number, text: string): number => size * (text.length <= 1 ? 0.66 : text.length === 2 ? 0.52 : 0.4);

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const bitmaps = new Map<string, HTMLCanvasElement>();

/** Each id's bitmap by size, for the spot list it was made under: a mark asked for again is one lookup, no id parsing or key string. */
const byId = new Map<number, Map<string, HTMLCanvasElement>>();
let byIdFor: ReadonlySet<string> | null = null;

/** A mark drawn once at `px` device pixels a side (kept for the next frame: a canvas of bubbles draws hundreds a frame). */
function bitmap(id: string, px: number): HTMLCanvasElement {
  const spots = spotIds();
  if (spots !== byIdFor) { byId.clear(); byIdFor = spots; }
  let sized = byId.get(px);
  if (!sized) byId.set(px, sized = new Map());
  const held = sized.get(id);
  if (held) return held;
  const m = markOf(id), key = `${m.family}|${m.spot}|${px}`;
  let canvas = bitmaps.get(key);
  if (canvas) { sized.set(id, canvas); return canvas; }
  canvas = document.createElement('canvas'); canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d')!, r = Math.max(1, px * 0.16);
  ctx.fillStyle = m.bg; ctx.beginPath(); ctx.roundRect(0, 0, px, px, r); ctx.fill();
  // A light square on a light page, or a dark one on a dark page, keeps its edge with a hairline in its own ink.
  ctx.strokeStyle = m.fg; ctx.globalAlpha = 0.28; ctx.lineWidth = Math.max(1, px / 16); ctx.beginPath(); ctx.roundRect(ctx.lineWidth / 2, ctx.lineWidth / 2, px - ctx.lineWidth, px - ctx.lineWidth, r); ctx.stroke(); ctx.globalAlpha = 1;
  ctx.fillStyle = m.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${monogramPx(px, m.text)}px ${FONT}`;
  ctx.fillText(m.text, px / 2, px / 2 + px * 0.04);
  if (m.spot) { const s = px * 0.32; ctx.beginPath(); ctx.moveTo(px, px - s); ctx.lineTo(px, px); ctx.lineTo(px - s, px); ctx.closePath(); ctx.fill(); }
  if (bitmaps.size > 400) { bitmaps.clear(); byId.clear(); }
  bitmaps.set(key, canvas);
  (byId.get(px) ?? byId.set(px, new Map()).get(px)!).set(id, canvas);
  return canvas;
}

/** Where a mark `size` CSS px a side centred on `c` starts: on a whole CSS pixel, which is where `drawVenueMark` puts it. */
export const markCorner = (c: number, size: number): number => Math.round(c - size / 2);

/** Paint the mark of `id`, `size` CSS px a side, centred on (`cx`, `cy`); a painter that knows its pixel ratio passes it (`dpr`). */
export function drawVenueMark(ctx: CanvasRenderingContext2D, id: string, cx: number, cy: number, size: number, dpr = pixelRatio()): void {
  const px = Math.max(8, Math.round(size * dpr));
  ctx.drawImage(bitmap(id, px), markCorner(cx, size), markCorner(cy, size), size, size);
}

/** A mark as `drawVenueMark` paints it: centred on (`x`, `y`) CSS px, `size` a side, at opacity `a` (0 to 1). */
export interface PaintedMark { id: string; x: number; y: number; size: number; a: number }

/**
 * What `marks` put on a canvas: each one's corner on whole pixels (`markCorner`), its size, its bitmap (its exchange, spot or not, at the
 * pixel ratio) and its opacity in 255ths, the steps a canvas lays it in. Two lists with the same key paint the same pixels.
 */
export function marksKey(marks: readonly PaintedMark[]): string {
  let key = String(pixelRatio());
  for (const m of marks) key += `;${m.id}|${markOf(m.id).spot ? 's' : ''}|${m.size}|${markCorner(m.x, m.size)}|${markCorner(m.y, m.size)}|${Math.round(Math.min(1, Math.max(0, m.a)) * 255)}`;
  return key;
}

/**
 * Marks on a canvas of their own, painted again only when what lands on it changes (`marksKey`). The Tape's trail marks move a few pixels a
 * second and a canvas painted again every frame is one the browser sends to the card and composes every frame (Karl, 2026-11-12, the
 * phone's Tape). `begin` gets the canvas ready (cleared when something is on it), `draw` paints one mark.
 */
export class MarkLayer {
  #key: string | null = null; #drawn = false;
  /** The canvas was cleared (sized): the next `paint` paints what it is given. */
  reset(): void { this.#key = null; this.#drawn = false; }
  /** Paint `marks` unless the canvas shows them already; true when it painted (or cleared). */
  paint(marks: readonly PaintedMark[], begin: (clear: boolean) => void, draw: (mark: PaintedMark) => void): boolean {
    const key = marksKey(marks);
    if (key === this.#key) return false;
    this.#key = key;
    if (!marks.length && !this.#drawn) return false;
    begin(this.#drawn);
    for (const m of marks) draw(m);
    this.#drawn = marks.length > 0;
    return true;
  }
}

/**
 * The mark of `id` as an element of the page, `size` px a side. It reads as decoration (the name beside it says the same), so its monogram is
 * drawn by the stylesheet from `data-mark` and adds no text to the button or the row it sits in.
 */
export function venueMark(id: string, size = 14): HTMLElement {
  const m = markOf(id), el = document.createElement('i');
  el.className = `venue-mark${m.spot ? ' spot' : ''}`;
  el.setAttribute('aria-hidden', 'true');
  el.dataset.mark = m.text;
  el.style.setProperty('--mark-bg', m.bg); el.style.setProperty('--mark-fg', m.fg);
  el.style.width = el.style.height = `${size}px`; el.style.fontSize = `${monogramPx(size, m.text)}px`;
  return el;
}
