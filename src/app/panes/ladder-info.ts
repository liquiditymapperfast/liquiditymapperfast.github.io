import type { InfoLine } from '../infobox.ts';
import { price as fmtPrice, usd } from '../format.ts';
import { t, tn } from '../i18n.ts';

/** What is known about one price level of the order book, to say what the pointer is on. */
export interface LevelFacts {
  /** The level's price span: from `low` up one `step`. */
  low: number;
  step: number;
  /** The price the book is centred on. */
  mark: number;
  /** An ask (a seller waiting above the price) or a bid (a buyer waiting below). */
  ask: boolean;
  /** Everything resting at this level, USD. */
  size: number;
  /** The running total from the mark out to and including this level, USD. */
  cumulative: number;
  /** Each venue's part of the level, any order (venues with nothing there left out); `id`, the book's instrument, gives its line the venue's mark. */
  venues: readonly { name: string; usd: number; id?: string }[];
  /** A book that belongs to one venue says which. */
  title?: string;
}

/** How far a level is from the mark: "+0.42% · 36 bp", negative below it. */
export function distanceText(price: number, mark: number): string {
  const d = price - mark, pct = d / mark * 100, bp = Math.abs(d / mark * 1e4);
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  return `${sign}${Math.abs(pct) < 1 ? Math.abs(pct).toFixed(2) : Math.abs(pct).toFixed(1)}% · ${bp < 10 ? bp.toFixed(1) : Math.round(bp)} bp`;
}

const span = (f: LevelFacts): string => `${fmtPrice(f.low, f.step)} – ${fmtPrice(f.low + f.step, f.step)}`;
const side = (f: LevelFacts): InfoLine => ({ label: t('Side'), text: f.ask ? t('Ask: sellers waiting') : t('Bid: buyers waiting'), color: f.ask ? 'above' : 'below' });

/**
 * The popup for a whole level (the block of bars at one price, all venues together or one venue's book), with its venues largest first: the
 * first `limit` of them (the Compact book, with room for every piece in its bar, names them all).
 */
export function levelLines(f: LevelFacts, limit = 4): InfoLine[] {
  const lines: InfoLine[] = [
    { text: f.title ?? t('Order book level'), bold: true },
    { label: t('Price'), text: span(f) },
    side(f),
    { label: t('Size'), text: `$${usd(f.size)}`, bold: true },
    { label: t('From the mark'), text: `$${usd(f.cumulative)}` },
    { label: t('Distance'), text: distanceText(f.low + f.step / 2, f.mark) },
  ];
  if (f.venues.length > 1) {
    const sorted = [...f.venues].sort((a, b) => b.usd - a.usd), total = sorted.reduce((sum, v) => sum + v.usd, 0);
    sorted.slice(0, limit).forEach((v, i) => lines.push({ label: v.name, text: `$${usd(v.usd)} · ${total > 0 ? Math.round(v.usd / total * 100) : 0}%`, rule: i === 0, ...(v.id ? { mark: v.id } : {}) }));
    if (sorted.length > limit) lines.push({ text: t('+{n} more venues', { n: sorted.length - limit }), color: 'muted' });
  }
  return lines;
}

/** The popup for one venue's part of a level (a coloured cell in a venue's column, or its piece of the bar). */
export function venueCellLines(f: LevelFacts, venue: { name: string; usd: number; id?: string }): InfoLine[] {
  const ranked = [...f.venues].sort((a, b) => b.usd - a.usd), rank = 1 + ranked.filter(v => v.usd > venue.usd).length;
  const lines: InfoLine[] = [
    { text: venue.name, bold: true, ...(venue.id ? { mark: venue.id } : {}) },
    { label: t('Price'), text: span(f) },
    side(f),
    { label: t('Size'), text: `$${usd(venue.usd)}`, bold: true },
    { label: t('Share of level'), text: `${f.size > 0 ? Math.round(venue.usd / f.size * 100) : 0}%` },
  ];
  if (f.venues.length > 1) lines.push({ label: t('Rank at this price'), text: t('{rank} of {total}', { rank, total: f.venues.length }) });
  lines.push({ label: t('Distance'), text: distanceText(f.low + f.step / 2, f.mark) });
  lines.push({ label: t('All venues here'), text: `$${usd(f.size)}`, rule: true });
  return lines;
}

/**
 * The popup for the smaller venues' piece at the end of a Compact bar: each of them with its part of the level, so nothing too narrow to draw
 * is out of reach.
 */
export function smallerVenuesLines(f: LevelFacts, venues: readonly { name: string; usd: number; id?: string }[]): InfoLine[] {
  const usdSum = venues.reduce((sum, v) => sum + v.usd, 0);
  const lines: InfoLine[] = [
    { text: tn(venues.length, '{n} smaller venue', '{n} smaller venues'), bold: true },
    { label: t('Price'), text: span(f) },
    side(f),
    { label: t('Size'), text: `$${usd(usdSum)}`, bold: true },
    { label: t('Share of level'), text: `${f.size > 0 ? Math.round(usdSum / f.size * 100) : 0}%` },
  ];
  venues.slice(0, 10).forEach((v, i) => lines.push({ label: v.name, text: `$${usd(v.usd)} · ${f.size > 0 ? Math.round(v.usd / f.size * 100) : 0}%`, rule: i === 0, ...(v.id ? { mark: v.id } : {}) }));
  if (venues.length > 10) lines.push({ text: t('+{n} more venues', { n: venues.length - 10 }), color: 'muted' });
  return lines;
}
