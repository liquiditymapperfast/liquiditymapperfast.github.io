import { el } from '../dom.ts';
import { t, tn } from '../i18n.ts';
import { clockSeconds, price as fmtPrice, usd as pageUsd } from '../format.ts';
import { venueMark, markOf } from '../venue-marks.ts';
import { venueLabel } from '../venues.ts';
import type { Block, Coincidence, MarketRow, Repeat } from '../trades/blocks.ts';

/**
 * The inspector of Trades grouped by time: one block in full, beside the list when the column is wide (the list keeps 367 px, the rest is
 * this), or in a bottom sheet when a finger taps a block on a phone. Page elements, not canvas: it changes at most once a second and must
 * wrap in twelve languages. `inspectorModel` is every word and number (plain data, so tests need no page); `renderInspector` puts it on the
 * page. Facts only: what was traded, where, at what price; never who or why.
 */

export type Tone = 'up' | 'down' | 'flat' | 'muted';
export interface InspectorModel {
  title: string; sub: string;
  ref: { label: string; change: string; tone: Tone } | null;
  moves: string | null;
  markets: { id: string; name: string; buy: string; sell: string }[];
  notes: { text: string; tone: Tone }[];
  largestTitle: string;
  largest: { id: string; side: 'buy' | 'sell'; usd: string; detail: string }[];
}

/** One of a block's largest orders, as the inspector lists it. */
export interface ListedOrder { t: number; id: string; usd: number; price: number; lo: number; hi: number }

export interface InspectorInput {
  block: Block;
  /** 'held' (a block chosen), 'newest' (the newest settled block, followed live). */
  state: 'held' | 'newest';
  /** The block's time as the list writes it (`13:38:28`, `13:38–13:39`). */
  time: string;
  /** Markets counted, and the reference market's id. */
  marketCount: number; ref: string;
  /** The size filter in the coin's dollars (0 any), and the recording's floor (25K for BTC). */
  minUsd: number; recordedFloor: number;
  rows: readonly MarketRow[];
  coincidences: readonly Coincidence[]; repeats: readonly Repeat[];
  largest: readonly ListedOrder[];
  /** Stretches of the block (ms) nobody recorded: its totals miss them. */
  unrecorded?: readonly (readonly [number, number])[];
}

/** Dollars as Trades writes them: the page's way, with cents under a dollar (a thin coin's orders are $0.30, not $0; under a cent, <0.01). */
export const fmtUsd = (v: number): string => v === 0 || Math.abs(v) >= 1 ? pageUsd(v) : Math.abs(v) < 0.005 ? '<0.01' : v.toFixed(2);
/** A positive amount with its dollar sign, under half a cent as "<$0.01" (not "$<0.01"). */
export const money = (v: number): string => v > 0 && v < 0.005 ? '<$0.01' : `$${fmtUsd(v)}`;
/** A market's name as the inspector writes it: the exchange, and "spot" for a spot market. */
export const marketName = (id: string): string => markOf(id).spot ? t('{venue} spot', { venue: venueLabel(markOf(id).family) }) : venueLabel(id);
/** The reference market's name: its kind said either way ("Binance perpetual", "Coinbase spot"), since its price is the block's price. */
export const refName = (id: string): string => markOf(id).spot ? marketName(id) : t('{venue} perpetual', { venue: venueLabel(id) });
const signed = (v: number, dp: number): string => { const r = Number(Math.abs(v).toFixed(dp)); return r === 0 ? (0).toFixed(dp) : `${v > 0 ? '+' : '−'}${r.toFixed(dp)}`; };
const tone = (v: number, dp: number): Tone => Number(Math.abs(v).toFixed(dp)) === 0 ? 'flat' : v > 0 ? 'up' : 'down';
/** A reach in basis points of the order's own price: how far its fills went (0 for one price). */
export const reachBp = (o: { price: number; lo: number; hi: number }): number => o.price > 0 && o.hi >= o.lo ? 1e4 * (o.hi - o.lo) / o.price : 0;

export function inspectorModel(i: InspectorInput): InspectorModel {
  const b = i.block, held = i.state === 'held';
  const title = held ? t('{time} · held', { time: i.time }) : t('{time} · newest settled', { time: i.time });
  const sizes = i.minUsd > 0 ? t('From ${usd}', { usd: fmtUsd(i.minUsd) }) : t('All sizes');
  const parts = [sizes, tn(i.marketCount, '{n} market', '{n} markets')];
  if (b.n >= 0) parts.push(tn(b.n, '{n} order', '{n} orders'));
  else if (b.from === 0) parts.push(t('not recorded'));
  else parts.push(t('orders not counted before the page listened'));
  let ref: InspectorModel['ref'] = null;
  if (Number.isFinite(b.refPx)) {
    const label = t('{market} VWAP {price}', { market: refName(i.ref), price: fmtPrice(b.refPx) });
    if (Number.isFinite(b.refPrev) && b.refPrev > 0) {
      const d = b.refPx - b.refPrev, bp = 1e4 * Math.log(b.refPx / b.refPrev);
      ref = { label, change: t('{dollars} · {bp} bp', { dollars: signed(d, b.B >= 60 ? 0 : 1), bp: signed(bp, 1) }), tone: tone(d, b.B >= 60 ? 0 : 1) };
    } else ref = { label, change: '–', tone: 'muted' };
  }
  const moves = i.rows.map(r => r.move).filter(Number.isFinite).sort((a, b) => a - b);
  const median = moves.length ? (moves[(moves.length - 1) >> 1]! + moves[moves.length >> 1]!) / 2 : NaN;
  const movesText = moves.length >= 2 ? t('Markets\' own moves: median {median} bp, {lo} to {hi}', { median: signed(median, 1), lo: signed(moves[0]!, 1), hi: signed(moves[moves.length - 1]!, 1) }) : null;
  const notes: InspectorModel['notes'] = [];
  for (const [a, z] of (i.unrecorded ?? []).slice(0, 2)) notes.push({ text: t('Not recorded {from}–{to}: the totals miss it', { from: clockSeconds(a), to: clockSeconds(z) }), tone: 'muted' });
  for (const c of i.coincidences.slice(0, 2)) notes.push({ text: t('{arrow} ${usd} within 5 ms on {n} venues ({venues})', { arrow: c.side > 0 ? '▲' : '▼', usd: fmtUsd(c.usd), n: String(c.venues.length), venues: c.venues.map(v => venueLabel(v)).join(', ') }), tone: c.side > 0 ? 'up' : 'down' });
  for (const r of i.repeats.slice(0, 1)) {
    const when = r.ms < 1 ? t('in the same millisecond') : r.ms < 1000 ? t('in {ms} ms', { ms: String(r.ms) }) : t('in {s} s', { s: (r.ms / 1000).toFixed(1) });
    notes.push({ text: r.side > 0 ? t('Repeated size: {market} buys, {n} × about ${usd} {when}', { market: marketName(r.id), n: String(r.n), usd: fmtUsd((r.lo + r.hi) / 2), when }) : t('Repeated size: {market} sells, {n} × about ${usd} {when}', { market: marketName(r.id), n: String(r.n), usd: fmtUsd((r.lo + r.hi) / 2), when }), tone: 'muted' });
  }
  const recorded = b.from !== 0 && !(b.from & 1);
  return {
    title, sub: parts.join(' · '), ref, moves: movesText,
    // The markets that bought or sold within the block's filter (one that traded only under a size floor moves the median, not the table).
    markets: i.rows.filter(r => r.buy > 0 || r.sell > 0).map(r => ({ id: r.id, name: marketName(r.id), buy: money(r.buy), sell: money(r.sell) })),
    notes,
    largestTitle: recorded ? t('Largest recorded orders (from ${usd})', { usd: fmtUsd(i.recordedFloor) }) : t('Largest orders'),
    largest: i.largest.map(o => ({ id: o.id, side: o.usd > 0 ? 'buy' as const : 'sell' as const, usd: `${o.usd > 0 ? '▲' : '▼'} ${money(Math.abs(o.usd))}`, detail: `${clockSeconds(o.t)}.${String(Math.round(((o.t % 1000) + 1000) % 1000)).padStart(3, '0')}  ${fmtPrice(o.price)}  ${t('{bp} bp', { bp: reachBp(o).toFixed(1) })}` })),
  };
}

/** Put a model on the page in `root` (emptied first). */
export function renderInspector(root: HTMLElement, m: InspectorModel): void {
  const parts: HTMLElement[] = [el('div', { class: 'ti-title' }, m.title), el('div', { class: 'ti-sub' }, m.sub)];
  if (m.ref) parts.push(el('div', { class: 'ti-ref' }, el('span', {}, m.ref.label), el('span', { class: `ti-${m.ref.tone}` }, m.ref.change)));
  if (m.moves) parts.push(el('div', { class: 'ti-moves' }, m.moves));
  if (m.markets.length) {
    const head = el('div', { class: 'ti-row ti-head' }, el('span', {}, ''), el('span', {}, t('Bought')), el('span', {}, t('Sold')));
    parts.push(el('div', { class: 'ti-markets' }, head, ...m.markets.map(r => el('div', { class: 'ti-row' },
      el('span', { class: 'ti-name' }, venueMark(r.id, 13), el('span', {}, r.name)), el('span', { class: 'ti-up' }, r.buy), el('span', { class: 'ti-down' }, r.sell)))));
  }
  if (m.notes.length) parts.push(el('div', { class: 'ti-h' }, t('Notes')), ...m.notes.map(n => el('div', { class: `ti-note ti-${n.tone}` }, n.text)));
  if (m.largest.length) parts.push(el('div', { class: 'ti-h' }, m.largestTitle), ...m.largest.map(o => el('div', { class: 'ti-order' },
    venueMark(o.id, 13), el('span', { class: `ti-${o.side === 'buy' ? 'up' : 'down'} ti-usd` }, o.usd), el('span', { class: 'ti-detail' }, o.detail))));
  root.replaceChildren(...parts);
}
