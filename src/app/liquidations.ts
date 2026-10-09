import { LIQUIDATION_COVERAGE, fromWire, type Liquidation } from '../shared/liquidations.ts';
import { TimeBook } from './prints.ts';
import { price as fmtPrice, usd, clock } from './format.ts';
import { venueLabel } from './venues.ts';
import { scaledUsd } from './coin.ts';
import { t } from './i18n.ts';
import type { InfoLine } from './infobox.ts';

export { fromWire, type Liquidation };

/**
 * The page's side of liquidations (the venues' reports are read in shared/liquidations.ts): what is held for the map, how they are drawn,
 * and what is said about the venues that do not report them. A liquidation is also a market order, so it is already among the trade
 * bubbles and in the Range panel's totals; drawn as a diamond on top, it says which of those orders were forced.
 */

/** Liquidations held for drawing. */
export class LiquidationBook extends TimeBook<Liquidation> {
  constructor(max = 20_000) { super(l => `${l.t}|${l.id}|${l.side}|${l.reported}|${Math.round(l.usd * 100)}`, max); }
}

/** Whether they show, the smallest drawn, which side, their size, and their size written beside the larger ones. */
export interface LiquidationSettings { on: boolean; minUsd: number; side: 'both' | 'long' | 'short'; scale: number; labels: boolean }
/** The smallest liquidations a person can choose to see: every one from $100 is recorded. */
export const LIQUIDATION_MINIMUMS: readonly number[] = [100, 1_000, 5_000, 10_000, 25_000, 100_000, 500_000];
export const LIQUIDATION_DEFAULTS: Readonly<LiquidationSettings> = { on: true, minUsd: 1_000, side: 'both', scale: 1, labels: true };
export const LIQUIDATION_LIMITS = { scale: { min: 0.5, max: 2, step: 0.1 } } as const;

/** Saved settings, each field checked (anything else is the default; a minimum that is not one of the choices is the nearest under it). */
export function readLiquidations(saved: unknown): LiquidationSettings {
  const s = (saved ?? {}) as Partial<LiquidationSettings>, d = LIQUIDATION_DEFAULTS, L = LIQUIDATION_LIMITS;
  const min = typeof s.minUsd === 'number' && Number.isFinite(s.minUsd) ? [...LIQUIDATION_MINIMUMS].reverse().find(m => m <= s.minUsd!) ?? d.minUsd : d.minUsd;
  const scale = typeof s.scale === 'number' && Number.isFinite(s.scale) ? Math.round(Math.min(L.scale.max, Math.max(L.scale.min, s.scale)) / L.scale.step) * L.scale.step : d.scale;
  return {
    on: typeof s.on === 'boolean' ? s.on : d.on,
    minUsd: min,
    side: s.side === 'long' || s.side === 'short' ? s.side : 'both',
    scale: Number(scale.toFixed(1)),
    labels: typeof s.labels === 'boolean' ? s.labels : d.labels,
  };
}

/** Whether a liquidation is left out by the settings: under the smallest shown, or on the side that is not. */
export const liquidationHidden = (l: Liquidation, s: LiquidationSettings): boolean => l.usd < scaledUsd(s.minUsd) || (s.side !== 'both' && l.side !== s.side);

/** The half-diagonal of the largest diamond in view, and of the smallest drawn, in px before the size setting. */
export const DIAMOND_MAX_R = 18, DIAMOND_MIN_R = 3.5;
/** A diamond's half-diagonal: its area in proportion to the USD closed, the largest in view the biggest (as the trade bubbles). */
export function diamondRadius(value: number, largest: number): number {
  if (!(largest > 0) || !(value > 0)) return DIAMOND_MIN_R;
  return Math.max(DIAMOND_MIN_R, DIAMOND_MAX_R * Math.sqrt(Math.min(1, value / largest)));
}

/** What each venue reports, in words: every liquidation, at most one a second, or none. */
export function coverageOf(venue: string): 'all' | 'throttled' | 'none' {
  const family = venue.length > 4 && venue.endsWith('spot') ? null : venue;
  return family ? LIQUIDATION_COVERAGE[family] ?? 'none' : 'none';
}

/**
 * The panel's account of the venues switched on: which report liquidations, which report only some (Binance: its largest each second),
 * and which report none, each as one line of venue names (a group with none is left out).
 */
export function coverageLines(markets: readonly { venue: string; spot: boolean }[]): { text: string; muted: boolean }[] {
  const by = { all: new Set<string>(), throttled: new Set<string>(), none: new Set<string>() };
  // A spot market has no liquidations of its own (its venue's perpetual may): it counts as reporting none.
  for (const m of markets) by[m.spot ? 'none' : coverageOf(m.venue)].add(venueLabel(m.venue));
  for (const name of [...by.all, ...by.throttled]) by.none.delete(name);
  const out: { text: string; muted: boolean }[] = [];
  const list = (names: Set<string>): string => [...names].join(', ');
  if (by.all.size) out.push({ text: t('Reported: {venues}.', { venues: list(by.all) }), muted: false });
  if (by.throttled.size) out.push({ text: t('Only the largest each second: {venues}, so a cascade there shows fewer than happened.', { venues: list(by.throttled) }), muted: false });
  if (by.none.size) out.push({ text: t('Not reported by the exchange: {venues}.', { venues: list(by.none) }), muted: true });
  return out;
}

/** The box for a liquidation under the pointer. */
export function liquidationLines(l: Liquidation): InfoLine[] {
  const symbol = l.id.split(':').slice(1).join(':');
  const lines: InfoLine[] = [
    { text: `${l.side === 'long' ? t('LONGS LIQUIDATED') : t('SHORTS LIQUIDATED')}  $${usd(l.usd)}`, bold: true, color: l.side === 'long' ? 'sell' : 'buy', mark: l.id },
    { text: l.side === 'long' ? t('A long position was closed by force: the exchange sold it at market.') : t('A short position was closed by force: the exchange bought it back at market.'), wrap: true },
    { label: t('Venue'), text: `${venueLabel(l.id)} ${symbol}`, rule: true },
    { label: t('Market price'), text: fmtPrice(l.price) },
  ];
  if (l.kind === 'bankruptcy') lines.push({ label: t('Bankruptcy price'), text: fmtPrice(l.reported) });
  else if (Math.abs(l.reported - l.price) > 1e-9 * l.price) lines.push({ label: t('Reported price'), text: fmtPrice(l.reported) });
  lines.push({ label: t('Time'), text: `${clock(l.t, true)}:${String(new Date(l.t).getSeconds()).padStart(2, '0')}` });
  // A bankruptcy price with no trade known near its time (a report that came late) is drawn at that price, and the box says so.
  const placed = Math.abs(l.reported - l.price) > 1e-9 * l.price;
  if (l.kind === 'bankruptcy') lines.push({ text: placed ? t('The exchange reports the price at which the position\'s margin was gone. The forced order filled near the market, so it is drawn at the price trading then.') : t('The exchange reports the price at which the position\'s margin was gone; no trade of this market near that time is known, so it is drawn at that price.'), color: 'muted', wrap: true, rule: true });
  if (coverageOf(l.id.split(':')[0] ?? '') === 'throttled') lines.push({ text: t('This exchange reports only its largest liquidation each second.'), color: 'muted', wrap: true, rule: l.kind !== 'bankruptcy' });
  return lines;
}
