import { venueLabel } from './venues.ts';

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

/** The mark of an instrument or a venue (`binance:BTCUSDT`, `binancespot`, `binance`): its exchange's style, and whether it is a spot market. */
export function markOf(id: string): MarkStyle & { spot: boolean; family: string } {
  const venue = id.split(':')[0] ?? id, spot = venue.length > 4 && venue.endsWith('spot'), family = spot ? venue.slice(0, -4) : venue;
  const known = VENUE_MARKS[family];
  if (known) return { ...known, spot, family };
  const name = venueLabel(family).replace(/[^A-Za-z0-9]/g, '');
  return { bg: '#5d6470', fg: '#ffffff', text: (name.slice(0, 2) || '?').toUpperCase(), spot, family };
}

/** The monogram's size in a mark `size` px wide: fewer letters, larger. */
export const monogramPx = (size: number, text: string): number => size * (text.length <= 1 ? 0.66 : text.length === 2 ? 0.52 : 0.4);

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const bitmaps = new Map<string, HTMLCanvasElement>();

/** A mark drawn once at `px` device pixels a side (kept for the next frame: a canvas of bubbles draws hundreds a frame). */
function bitmap(id: string, px: number): HTMLCanvasElement {
  const m = markOf(id), key = `${m.family}|${m.spot}|${px}`;
  let canvas = bitmaps.get(key);
  if (canvas) return canvas;
  canvas = document.createElement('canvas'); canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d')!, r = Math.max(1, px * 0.16);
  ctx.fillStyle = m.bg; ctx.beginPath(); ctx.roundRect(0, 0, px, px, r); ctx.fill();
  // A light square on a light page, or a dark one on a dark page, keeps its edge with a hairline in its own ink.
  ctx.strokeStyle = m.fg; ctx.globalAlpha = 0.28; ctx.lineWidth = Math.max(1, px / 16); ctx.beginPath(); ctx.roundRect(ctx.lineWidth / 2, ctx.lineWidth / 2, px - ctx.lineWidth, px - ctx.lineWidth, r); ctx.stroke(); ctx.globalAlpha = 1;
  ctx.fillStyle = m.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${monogramPx(px, m.text)}px ${FONT}`;
  ctx.fillText(m.text, px / 2, px / 2 + px * 0.04);
  if (m.spot) { const s = px * 0.32; ctx.beginPath(); ctx.moveTo(px, px - s); ctx.lineTo(px, px); ctx.lineTo(px - s, px); ctx.closePath(); ctx.fill(); }
  if (bitmaps.size > 400) bitmaps.clear();
  bitmaps.set(key, canvas);
  return canvas;
}

/** Paint the mark of `id`, `size` CSS px a side, centred on (`cx`, `cy`). */
export function drawVenueMark(ctx: CanvasRenderingContext2D, id: string, cx: number, cy: number, size: number): void {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, px = Math.max(8, Math.round(size * dpr));
  ctx.drawImage(bitmap(id, px), Math.round(cx - size / 2), Math.round(cy - size / 2), size, size);
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
