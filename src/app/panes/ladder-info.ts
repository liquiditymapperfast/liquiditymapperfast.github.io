import type { InfoLine } from '../infobox.ts';
import { price as fmtPrice, usd } from '../format.ts';
import { t } from '../i18n.ts';

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
  /** Each venue's part of the level, any order (venues with nothing there left out). */
  venues: readonly { name: string; usd: number }[];
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

/** The popup for a whole level (the block of bars at one price, all venues together or one venue's book). */
export function levelLines(f: LevelFacts): InfoLine[] {
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
    sorted.slice(0, 4).forEach((v, i) => lines.push({ label: v.name, text: `$${usd(v.usd)} · ${total > 0 ? Math.round(v.usd / total * 100) : 0}%`, rule: i === 0 }));
    if (sorted.length > 4) lines.push({ text: t('+{n} more venues', { n: sorted.length - 4 }), color: 'muted' });
  }
  return lines;
}

/** The popup for one venue's part of a level (a coloured cell in a venue's column, or its piece of the bar). */
export function venueCellLines(f: LevelFacts, venue: { name: string; usd: number }): InfoLine[] {
  const ranked = [...f.venues].sort((a, b) => b.usd - a.usd), rank = 1 + ranked.filter(v => v.usd > venue.usd).length;
  const lines: InfoLine[] = [
    { text: venue.name, bold: true },
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
