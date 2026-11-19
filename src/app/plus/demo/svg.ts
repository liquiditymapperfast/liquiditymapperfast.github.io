/** What the demo's chart and its feature pictures share: making SVG, the amounts, prices and dates as the page writes them, the kinds' samples. */
import { language } from '../../i18n.ts';
import { price, usd } from '../../format.ts';
import { HALF_HOUR_MS, START_MS } from './data.ts';

const SVGNS = 'http://www.w3.org/2000/svg';
type Attrs = Readonly<Record<string, string | number | null | undefined>>;

/** An SVG element with attributes. */
export function sv<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  return node;
}
/** An SVG element appended to `parent`. */
export function add<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs?: Attrs): SVGElementTagNameMap[K] {
  return parent.appendChild(sv(tag, attrs));
}
/** A text element appended to `parent`, with its words. */
export function text(parent: Element, words: string, attrs?: Attrs): SVGTextElement {
  const node = add(parent, 'text', attrs);
  node.textContent = words;
  return node;
}

/** An amount in dollars, short ("7.9M"). */
export const money = (v: number): string => usd(v);
/** A price on the axis ("62,840"). */
export const priceText = (p: number): string => price(Math.round(p), 1);

const formats = new Map<string, Intl.DateTimeFormat>();
function format(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const code = language(), id = `${code}|${key}`;
  let f = formats.get(id);
  if (!f) { f = new Intl.DateTimeFormat(code, { ...options, timeZone: 'UTC' }); formats.set(id, f); }
  return f;
}
/** The made-up history's half hour `hh` as a day ("Oct 28" in English, as each language writes it in the others). */
export const dayLabel = (hh: number): string => format('day', { month: 'short', day: 'numeric' }).format(START_MS + Math.round(hh) * HALF_HOUR_MS);
/** ... and as a day and a time ("Nov 7, 13:00"). */
export const timeLabel = (hh: number): string => format('time', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(START_MS + Math.round(hh) * HALF_HOUR_MS);
/** A distance from the price ("±1.25%"). */
export const bandLabel = (pct: number): string => `±${new Intl.NumberFormat(language(), { style: 'percent', maximumFractionDigits: 2 }).format(pct / 100)}`;

/**
 * A kind's sample, as the legend and the switches show it: two short lines in the side colours (liquidations with a dot, stops with a
 * square, take profits dashed and in the other order, since a take profit above the price closes a long).
 */
export function sample(kind: 'liq' | 'stops' | 'takes'): SVGSVGElement {
  const s = sv('svg', { viewBox: '0 0 24 14', width: 24, height: 14, class: 'pd-smp', 'aria-hidden': 'true' });
  const tp = kind === 'takes', top = tp ? 'pd-a' : 'pd-b', bottom = tp ? 'pd-b' : 'pd-a', x0 = tp ? 1 : 5, dash = tp ? ' pd-dash' : '';
  add(s, 'path', { d: `M${x0} 3.5H23`, class: `pd-smp-ln ${top}${dash}` });
  add(s, 'path', { d: `M${x0} 10.5H23`, class: `pd-smp-ln ${bottom}${dash}` });
  if (kind === 'liq') { add(s, 'circle', { cx: 3, cy: 3.5, r: 2.2, class: `pd-smp-mk ${top}` }); add(s, 'circle', { cx: 3, cy: 10.5, r: 2.2, class: `pd-smp-mk ${bottom}` }); }
  if (kind === 'stops') { add(s, 'rect', { x: 0.8, y: 1.3, width: 4.4, height: 4.4, class: `pd-smp-mk ${top}` }); add(s, 'rect', { x: 0.8, y: 8.3, width: 4.4, height: 4.4, class: `pd-smp-mk ${bottom}` }); }
  return s;
}
