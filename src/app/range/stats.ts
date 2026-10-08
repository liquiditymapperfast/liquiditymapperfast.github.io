import type { RangeAnswer } from '../../shared/footprint.ts';
import type { AbsorptionMark } from '../absorption.ts';
import type { CellShare } from '../cell-sources.ts';
import type { Print } from '../prints.ts';
import { familyKey, venueOfInstrument } from '../cvd/families.ts';
import { venueLabel } from '../venues.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import { t, tn } from '../i18n.ts';
import { MINUTE, type RangeSelection } from './selection.ts';

/**
 * What the Range panel says about a selection, worked out from what was gathered for it: every number and word here, the panel only lays the
 * lines out. All of it is about one set of instruments (the exchanges switched on, inside the Spot / Perp filter) and the selection's whole
 * minutes.
 *
 * - Market orders: bought and sold inside the selection, the orders behind them where the recording counts them by price, the share of all
 *   the market volume of those minutes that traded inside a box's band, the volume against the same length of time just before, and who
 *   traded it (exchange, spot or perpetual).
 * - Where they were filled: every market order fills resting orders on its own exchange, at the prices it trades at. The prices that took
 *   the most say where the resting orders were that absorbed the market orders.
 * - Absorption marks: the marks of the map inside the selection (above the threshold the map draws them at, as the map judges them
 *   when the figures are taken), what they took against everything traded there, and where.
 * - Resting orders (a box only): the bids and asks that rested inside the box, averaged over its time.
 */
export interface RangeInput {
  sel: RangeSelection;
  /** The recording's answer; null while it is asked for, or when it could not be had (`error`). */
  answer: RangeAnswer | null;
  error: 'older' | 'failed' | null;
  /** Absorption marks inside the selection; null when Absorption is off (none are loaded). */
  marks: readonly AbsorptionMark[] | null;
  /** What each instrument held inside the box, averaged over its time; null for a stretch of time, or before it is known. */
  resting: readonly CellShare[] | null;
  /** The largest market orders the map holds inside the selection (the trade bubbles); null when they are off. */
  prints: readonly Print[] | null;
  kind: (id: string) => 'spot' | 'perp' | null;
  /** The selection reaches outside the map's time window, for which the marks and the large orders are loaded. */
  partial?: boolean;
}

/** One line of the panel. `cells` are its texts; a split's `share` is the buy side's part, 0..1, a row's the length of its bar. */
export interface RangeLine {
  key: string;
  kind: 'title' | 'heading' | 'stat' | 'split' | 'row' | 'note';
  cells: string[];
  share?: number;
  /** A row's bars, buys then sells, each 0..1 of the longest. */
  bars?: [number, number];
  tone?: 'buy' | 'sell' | 'muted';
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const money = (x: number): string => `$${usd(x)}`;
const signed = (x: number): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}$${usd(Math.abs(x))}`;
/** A multiple to one decimal ("×1.8"), or a fraction as a multiple too ("×0.4"). */
const times = (x: number): string => `×${x >= 10 ? Math.round(x) : x.toFixed(1)}`;
const durationText = (ms: number): string => {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 120) return tn(minutes, '{n} min', '{n} min');
  const hours = minutes / 60;
  return hours < 48 ? t('{n} h', { n: Number.isInteger(hours) ? hours : hours.toFixed(1) }) : t('{n} days', { n: (hours / 24).toFixed(1) });
};

/** The selection in words: its minutes (and live), and its prices or "every price". */
export function selectionLines(sel: RangeSelection): RangeLine[] {
  const span = `${clock(sel.t0, true)} – ${clock(sel.t1)} · ${durationText(sel.t1 - sel.t0)}${sel.live ? ` · ${t('live')}` : ''}`;
  const prices = sel.p0 !== null && sel.p1 !== null
    ? `${fmtPrice(sel.p0)} – ${fmtPrice(sel.p1)} (${((sel.p1 - sel.p0) / sel.p0 * 100).toFixed(2)}%)`
    : t('Every price');
  return [{ key: 'when', kind: 'title', cells: [span] }, { key: 'prices', kind: 'note', cells: [prices], tone: 'muted' }];
}

/** Sums of the answer over its instruments. */
function totals(answer: RangeAnswer) {
  const s = { buy: 0, sell: 0, buyN: 0, sellN: 0, countedBuy: 0, countedSell: 0, allBuy: 0, allSell: 0, beforeBuy: 0, beforeSell: 0, minutes: 0, counted: 0, beforeMinutes: 0, countedFrom: null as number | null };
  for (const i of answer.instruments) {
    s.buy += i.band.buy; s.sell += i.band.sell; s.buyN += i.band.buyN; s.sellN += i.band.sellN;
    s.countedBuy += i.countedUsd.buy; s.countedSell += i.countedUsd.sell;
    s.allBuy += i.all.buy; s.allSell += i.all.sell; s.beforeBuy += i.before.buy; s.beforeSell += i.before.sell;
    s.beforeMinutes = Math.max(s.beforeMinutes, i.before.minutes);
    if (i.countedFrom !== null && (s.countedFrom === null || i.countedFrom < s.countedFrom)) s.countedFrom = i.countedFrom;
  }
  // The selection's coverage is that of the instrument that recorded the most of it (a quiet one has minutes without trades, not gaps),
  // and its counted minutes are that instrument's (the most of them, when several recorded as many).
  for (const i of answer.instruments) s.minutes = Math.max(s.minutes, i.minutes);
  for (const i of answer.instruments) if (i.minutes === s.minutes) s.counted = Math.max(s.counted, i.counted);
  return s;
}

/** Every line the panel shows for `input`, in order. */
export function rangeLines(input: RangeInput): RangeLine[] {
  const { sel, answer } = input, box = sel.p0 !== null && sel.p1 !== null, lines: RangeLine[] = [...selectionLines(sel)];
  const windowMinutes = Math.round((sel.t1 - sel.t0) / MINUTE);

  lines.push({ key: 'h-market', kind: 'heading', cells: [t('Market orders')] });
  if (!answer) {
    lines.push({ key: 'market-wait', kind: 'note', tone: 'muted', cells: [input.error === 'older' ? t('The server is older than this page: restart it (npm run dev) for the market orders of a selection.')
      : input.error === 'failed' ? t('The recording could not be read for this selection.') : t('Adding up…')] });
  } else {
    const s = totals(answer), total = s.buy + s.sell;
    if (s.minutes < windowMinutes * 0.9) lines.push({ key: 'coverage', kind: 'note', tone: 'muted', cells: [t('Recorded for {n} of its {total} minutes.', { n: s.minutes, total: windowMinutes })] });
    if (!(total > 0)) lines.push({ key: 'market-none', kind: 'note', tone: 'muted', cells: [box ? t('No market orders traded inside this box.') : t('No market orders in these minutes.')] });
    else {
      lines.push({ key: 'split', kind: 'split', share: s.buy / total, cells: [t('Bought {value}', { value: money(s.buy) }), t('Sold {value}', { value: money(s.sell) })] });
      lines.push({ key: 'delta', kind: 'stat', cells: [t('Delta'), signed(s.buy - s.sell)], tone: s.buy >= s.sell ? 'buy' : 'sell' });
      const orders = orderLine(s, windowMinutes);
      if (orders) lines.push(...orders);
      if (box && s.allBuy + s.allSell > 0) lines.push({ key: 'band', kind: 'stat', cells: [t('Inside the band'), t('{share} of all market volume in these minutes', { share: pct(total / (s.allBuy + s.allSell)) })] });
      const all = s.allBuy + s.allSell, before = s.beforeBuy + s.beforeSell;
      if (before > 0 && s.beforeMinutes >= windowMinutes * 0.9 && s.minutes >= windowMinutes * 0.9) {
        lines.push({ key: 'before', kind: 'stat', cells: [t('Against the {span} before', { span: durationText(sel.t1 - sel.t0) }), t('{ratio} the volume', { ratio: times(all / before) })] });
      }
      const largest = largestPrint(input.prints, sel);
      if (largest) lines.push({ key: 'largest', kind: 'stat', tone: largest.side, cells: [t('Largest order'), `${money(largest.usd)} ${largest.side === 'buy' ? t('buy') : t('sell')} · ${fmtPrice(largest.price)} · ${venueLabel(largest.id)} · ${clock(largest.t)}`] });
      lines.push(...whoLines(answer, input.kind, total));
      lines.push(...filledLines(answer));
    }
  }
  lines.push(...absorptionLines(input, answer ? totals(answer) : null));
  if (box) lines.push(...restingLines(input.resting));
  return lines;
}

/** Orders behind the volume, where the recording counts them: the counts, the average order, and since when they are counted. */
function orderLine(s: ReturnType<typeof totals>, windowMinutes: number): RangeLine[] {
  if (s.counted === 0) return [{ key: 'orders-none', kind: 'note', tone: 'muted', cells: [t('Orders are counted by price in minutes recorded from now on; these minutes have no counts.')] }];
  const out: RangeLine[] = [];
  const avg = (usdSum: number, n: number): string => n > 0 ? money(usdSum / n) : '–';
  out.push({ key: 'orders', kind: 'stat', cells: [t('Orders'), t('{buys} buys · {sells} sells', { buys: s.buyN.toLocaleString('en-US'), sells: s.sellN.toLocaleString('en-US') })] });
  out.push({ key: 'average', kind: 'stat', cells: [t('Average order'), t('{buy} buy · {sell} sell', { buy: avg(s.countedBuy, s.buyN), sell: avg(s.countedSell, s.sellN) })] });
  if (s.counted < windowMinutes && s.countedFrom !== null) out.push({ key: 'orders-from', kind: 'note', tone: 'muted', cells: [t('Orders are counted from {time} on ({n} of {total} minutes).', { time: clock(s.countedFrom), n: s.counted, total: windowMinutes })] });
  return out;
}

/** The largest market order the map holds inside the selection. */
function largestPrint(prints: readonly Print[] | null, sel: RangeSelection): Print | null {
  if (!prints) return null;
  let best: Print | null = null;
  for (const p of prints) {
    if (p.t < sel.t0 || p.t >= sel.t1) continue;
    if (sel.p0 !== null && sel.p1 !== null && (p.price < sel.p0 || p.price >= sel.p1)) continue;
    if (!best || p.usd > best.usd) best = p;
  }
  return best;
}

/** Who traded it: each exchange's buys, sells and share (the six largest, the rest together), and spot against perpetual. */
function whoLines(answer: RangeAnswer, kind: RangeInput['kind'], total: number): RangeLine[] {
  const families = new Map<string, { buy: number; sell: number }>(), lanes = { spot: 0, perp: 0 };
  for (const i of answer.instruments) {
    const v = i.band.buy + i.band.sell; if (!(v > 0)) continue;
    const key = familyKey(venueOfInstrument(i.id)), f = families.get(key) ?? { buy: 0, sell: 0 };
    f.buy += i.band.buy; f.sell += i.band.sell; families.set(key, f);
    const k = kind(i.id); if (k) lanes[k] += v;
  }
  const sorted = [...families].sort((a, b) => (b[1].buy + b[1].sell) - (a[1].buy + a[1].sell));
  const out: RangeLine[] = [{ key: 'h-who', kind: 'heading', cells: [t('By exchange')] }];
  const largest = sorted.length ? sorted[0]![1].buy + sorted[0]![1].sell : 1;
  const row = (key: string, name: string, f: { buy: number; sell: number }): RangeLine => ({ key: `who-${key}`, kind: 'row', cells: [name, money(f.buy), money(f.sell), pct((f.buy + f.sell) / total)], bars: [f.buy / largest, f.sell / largest] });
  out.push({ key: 'who-head', kind: 'row', tone: 'muted', cells: [t('Exchange'), t('Bought'), t('Sold'), t('Share')] });
  for (const [key, f] of sorted.slice(0, 6)) out.push(row(key, venueLabel(key), f));
  const rest = sorted.slice(6);
  if (rest.length) out.push(row('rest', tn(rest.length, '{n} other', '{n} others'), rest.reduce((a, [, f]) => ({ buy: a.buy + f.buy, sell: a.sell + f.sell }), { buy: 0, sell: 0 })));
  if (lanes.spot + lanes.perp > 0) out.push({ key: 'lanes', kind: 'stat', cells: [t('Spot · perpetual'), `${pct(lanes.spot / (lanes.spot + lanes.perp))} · ${pct(lanes.perp / (lanes.spot + lanes.perp))}`] });
  return out;
}

/** Where the market orders were filled: the prices that took the most, with what was bought and sold there and the orders that began there. */
function filledLines(answer: RangeAnswer): RangeLine[] {
  const rows = answer.rows.filter(r => r[1] + r[2] > 0);
  if (!rows.length) return [];
  const top = [...rows].sort((a, b) => (b[1] + b[2]) - (a[1] + a[2])).slice(0, 6), most = top[0]![1] + top[0]![2];
  const counted = answer.instruments.some(i => i.counted > 0);
  const out: RangeLine[] = [{ key: 'h-filled', kind: 'heading', cells: [t('Where they were filled')] },
    { key: 'filled-head', kind: 'row', tone: 'muted', cells: [t('Price'), t('Bought'), t('Sold'), counted ? t('Orders') : ''] }];
  const step = answer.step;
  for (const r of top.sort((a, b) => b[0] - a[0])) {
    const label = fmtPrice(r[0], step);
    out.push({ key: `filled-${r[0]}`, kind: 'row', cells: [label, money(r[1]), money(r[2]), counted ? (r[3] + r[4]).toLocaleString('en-US') : ''], bars: [r[1] / most, r[2] / most] });
  }
  out.push({ key: 'filled-note', kind: 'note', tone: 'muted', cells: [t('Every market order fills resting orders on its own exchange: these are the prices where the most of them were absorbed, in rows of {step}.', { step: fmtPrice(step, step) })] });
  return out;
}

/** The absorption marks inside the selection: what the passive side took, against what traded there, by exchange and by price. */
function absorptionLines(input: RangeInput, s: ReturnType<typeof totals> | null): RangeLine[] {
  const out: RangeLine[] = [{ key: 'h-absorption', kind: 'heading', cells: [t('Absorption marks')] }];
  if (input.marks === null) { out.push({ key: 'abs-off', kind: 'note', tone: 'muted', cells: [t('Absorption is off: switch it on to count its marks here.')] }); return out; }
  const marks = input.marks;
  if (input.partial) out.push({ key: 'abs-partial', kind: 'note', tone: 'muted', cells: [t('The map shows only part of this selection: its absorption marks and its largest order are counted for that part alone.')] });
  if (!marks.length) { out.push({ key: 'abs-none', kind: 'note', tone: 'muted', cells: [t('No absorption marks in this selection.')] }); return out; }
  // A mark's side is the side of the market orders: passive buyers took market sells, passive sellers took market buys.
  const took = { sell: 0, buy: 0 }, byVenue = new Map<string, number>(), byPrice = new Map<number, { usd: number; side: 'buy' | 'sell' }>();
  for (const m of marks) {
    took[m.side] += m.usd;
    const key = familyKey(venueOfInstrument(m.id)); byVenue.set(key, (byVenue.get(key) ?? 0) + m.usd);
    const at = byPrice.get(m.price); if (at) at.usd += m.usd; else byPrice.set(m.price, { usd: m.usd, side: m.side });
  }
  const share = (part: number, of: number | undefined): string => of && of > 0 ? ` (${t('{share} of them', { share: pct(Math.min(1, part / of)) })})` : '';
  if (took.sell > 0) out.push({ key: 'abs-buyers', kind: 'stat', tone: 'buy', cells: [t('Passive buyers took'), `${money(took.sell)} ${t('of market sells')}${share(took.sell, s?.sell)}`] });
  if (took.buy > 0) out.push({ key: 'abs-sellers', kind: 'stat', tone: 'sell', cells: [t('Passive sellers took'), `${money(took.buy)} ${t('of market buys')}${share(took.buy, s?.buy)}`] });
  out.push({ key: 'abs-count', kind: 'stat', cells: [t('Marks'), tn(marks.length, '{n} mark', '{n} marks')] });
  const venues = [...byVenue].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key, v]) => `${venueLabel(key)} ${money(v)}`).join(' · ');
  out.push({ key: 'abs-venues', kind: 'stat', cells: [t('Where'), venues] });
  for (const [price, at] of [...byPrice].sort((a, b) => b[1].usd - a[1].usd).slice(0, 3)) {
    out.push({ key: `abs-price-${price}`, kind: 'stat', tone: at.side === 'sell' ? 'buy' : 'sell', cells: [fmtPrice(price), at.side === 'sell' ? t('{value} taken by passive buyers', { value: money(at.usd) }) : t('{value} taken by passive sellers', { value: money(at.usd) })] });
  }
  out.push({ key: 'abs-note', kind: 'note', tone: 'muted', cells: [t('Only the marks the map draws count: market orders of one side above the absorption threshold at one price within 10 ms.')] });
  return out;
}

/** The resting orders inside a box: bids and asks averaged over its time, and the exchanges that held the most. */
function restingLines(resting: readonly CellShare[] | null): RangeLine[] {
  const out: RangeLine[] = [{ key: 'h-resting', kind: 'heading', cells: [t('Resting orders in the box')] }];
  if (!resting) { out.push({ key: 'rest-wait', kind: 'note', tone: 'muted', cells: [t('Adding up…')] }); return out; }
  let bid = 0, ask = 0; const byVenue = new Map<string, number>();
  for (const c of resting) { bid += c.bid; ask += c.ask; const key = familyKey(venueOfInstrument(c.id)); byVenue.set(key, (byVenue.get(key) ?? 0) + c.bid + c.ask); }
  if (!(bid + ask > 0)) { out.push({ key: 'rest-none', kind: 'note', tone: 'muted', cells: [t('No resting orders were recorded inside this box.')] }); return out; }
  out.push({ key: 'rest-split', kind: 'split', share: bid / (bid + ask), cells: [t('Bids {value}', { value: money(bid) }), t('Asks {value}', { value: money(ask) })] });
  const total = bid + ask, venues = [...byVenue].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key, v]) => `${venueLabel(key)} ${pct(v / total)}`).join(' · ');
  out.push({ key: 'rest-venues', kind: 'stat', cells: [t('Held by'), venues] });
  out.push({ key: 'rest-note', kind: 'note', tone: 'muted', cells: [t('What rested inside the box on average over its time, on the exchanges switched on.')] });
  return out;
}

/** The size of a selection while it is dragged, for the tag beside it: its minutes, and a box's height as a share of its price. */
export function draftLabel(sel: RangeSelection): string {
  const span = durationText(Math.max(MINUTE, sel.t1 - sel.t0));
  return sel.p0 !== null && sel.p1 !== null && sel.p0 > 0 ? `${span} · ${((sel.p1 - sel.p0) / sel.p0 * 100).toFixed(2)}%` : span;
}
