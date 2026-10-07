import { ABSORPTION_WINDOW_MS, GROUP_FLOOR_USD, autoThreshold, markedPart, peakOf, type AbsorptionAnswer, type AbsorptionGroup, type AbsorptionMinute } from '../shared/absorption.ts';
import { clock, price as fmtPrice, usd } from './format.ts';
import { venueLabel } from './venues.ts';
import { t, tn } from './i18n.ts';
import type { InfoLine } from './infobox.ts';

/**
 * The page's side of absorption (the rule is in shared/absorption.ts): the threshold each instrument is judged at, and which recorded
 * groups are marks at that threshold. As in the order-flow tools, the threshold that applies now judges the whole history on screen, so
 * changing the settings, or the automatic threshold moving with the market, re-judges every mark.
 */

export interface AbsorptionSettings {
  /** Draw the marks. */
  on: boolean;
  /** `auto`: mean + k standard deviations of the window sums of the last `sdMinutes`, per instrument; `fixed`: `fixedUsd` for every one. */
  mode: 'auto' | 'fixed';
  k: number; sdMinutes: number; fixedUsd: number;
  /** Write the volume beside each mark. */
  volume: boolean;
}
export const ABSORPTION_DEFAULTS: Readonly<AbsorptionSettings> = { on: true, mode: 'auto', k: 10, sdMinutes: 30, fixedUsd: 250_000, volume: true };
export const ABSORPTION_LIMITS = { k: { min: 1.5, max: 50, step: 0.5 }, sdMinutes: { min: 1, max: 1_440 }, fixedUsd: { min: GROUP_FLOOR_USD, max: 1e9 } } as const;

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
/** Saved settings, each field checked (anything else is the default). */
export function readAbsorption(saved: unknown): AbsorptionSettings {
  const s = (saved ?? {}) as Partial<AbsorptionSettings>, d = ABSORPTION_DEFAULTS, L = ABSORPTION_LIMITS;
  return {
    on: typeof s.on === 'boolean' ? s.on : d.on,
    mode: s.mode === 'fixed' ? 'fixed' : 'auto',
    k: Math.round(clamp(s.k, L.k.min, L.k.max, d.k) / L.k.step) * L.k.step,
    sdMinutes: Math.round(clamp(s.sdMinutes, L.sdMinutes.min, L.sdMinutes.max, d.sdMinutes)),
    fixedUsd: clamp(s.fixedUsd, L.fixedUsd.min, L.fixedUsd.max, d.fixedUsd),
    volume: typeof s.volume === 'boolean' ? s.volume : d.volume,
  };
}

/** A mark: the marked part of one group at its instrument's threshold. */
export interface AbsorptionMark { id: string; side: 'buy' | 'sell'; price: number; t0: number; t1: number; usd: number; fills: number; peak: number; threshold: number }

const MINUTE = 60_000;
const keyOf = (g: AbsorptionGroup): string => `${g.id}|${g.side}|${g.price}|${g.t0}`;

/** The recorded groups and minutes the page holds: what the window on screen was answered with, and what the live stream added since. */
export class AbsorptionBook {
  readonly #groups = new Map<string, AbsorptionGroup>();
  readonly #minutes = new Map<string, Map<number, AbsorptionMinute>>();
  /** Each instrument's highest floor over the window last loaded (groups under it may be missing there). */
  floors: Record<string, number> = {};
  /** Per instrument, the largest credit this book let go to stay within `max` (smaller marks of it may be missing too). */
  readonly #letGo = new Map<string, number>();
  /** Bumped whenever anything changes, so a painter can tell its cache is stale. */
  version = 0;
  constructor(private max = 40_000) {}

  get size(): number { return this.#groups.size; }

  add(groups: readonly AbsorptionGroup[]): void {
    if (!groups.length) return;
    for (const g of groups) this.#groups.set(keyOf(g), g);
    if (this.#groups.size > this.max) {
      // The smallest go first (no threshold marks them before the others), down to nine tenths so it is not done again on every live push.
      const sorted = [...this.#groups.entries()].sort((a, b) => peakOf(a[1]) - peakOf(b[1]));
      for (const [key, g] of sorted.slice(0, this.#groups.size - Math.floor(this.max * 0.9))) {
        this.#groups.delete(key); this.#letGo.set(g.id, Math.max(this.#letGo.get(g.id) ?? 0, peakOf(g)));
      }
    }
    this.version++;
  }

  addMinutes(minutes: readonly AbsorptionMinute[]): void {
    if (!minutes.length) return;
    for (const m of minutes) {
      let byTime = this.#minutes.get(m.id); if (!byTime) { byTime = new Map(); this.#minutes.set(m.id, byTime); }
      byTime.set(m.t, m);
      // A settled minute is the newest knowledge of its floor: a live one may raise what the window was loaded with.
      this.floors[m.id] = Math.max(this.floors[m.id] ?? 0, m.floor);
    }
    const cutoff = Date.now() - 25 * 3_600_000;
    for (const byTime of this.#minutes.values()) for (const t of byTime.keys()) if (t < cutoff) byTime.delete(t);
    this.version++;
  }

  /** Take a history answer for a window: its groups and minutes join what is held, and its floors replace the last window's. */
  load(answer: AbsorptionAnswer): void {
    this.floors = { ...answer.floors }; this.#letGo.clear();
    this.add(answer.groups); this.addMinutes(answer.minutes);
    this.version++;
  }

  /**
   * The threshold each instrument is judged at now: the fixed amount, or mean + k standard deviations of the window sums in the complete
   * minutes of the last `sdMinutes` (null for an instrument with none yet: nothing of it is marked).
   */
  thresholds(ids: readonly string[], s: AbsorptionSettings, now: number): Map<string, number | null> {
    const out = new Map<string, number | null>(), end = Math.floor(now / MINUTE) * MINUTE, start = end - s.sdMinutes * MINUTE;
    for (const id of ids) {
      if (s.mode === 'fixed') { out.set(id, s.fixedUsd); continue; }
      const minutes: AbsorptionMinute[] = [];
      for (const [t, m] of this.#minutes.get(id) ?? []) if (t >= start && t < end) minutes.push(m);
      out.set(id, autoThreshold(minutes, s.k));
    }
    return out;
  }

  /** The marks in a window of the map: groups of `ids` that start in [t0 - window, t1] at a price in [p0, p1] and reach their instrument's threshold. */
  marks(ids: readonly string[], thresholds: ReadonlyMap<string, number | null>, t0: number, t1: number, p0: number, p1: number): AbsorptionMark[] {
    const wanted = new Set(ids), out: AbsorptionMark[] = [];
    for (const g of this.#groups.values()) {
      if (!wanted.has(g.id) || g.t0 < t0 - ABSORPTION_WINDOW_MS || g.t0 > t1 || g.price < p0 || g.price > p1) continue;
      const threshold = thresholds.get(g.id);
      if (threshold === null || threshold === undefined || peakOf(g) < threshold) continue;
      const part = markedPart(g, threshold);
      if (part) out.push({ id: g.id, side: g.side, price: g.price, t0: part.t0, t1: part.t1, usd: part.usd, fills: part.fills, peak: part.peak, threshold });
    }
    return out;
  }

  /**
   * Instruments whose threshold is under the floor of the window loaded, or under what this book let go: some of their marks were not
   * kept (the recorder keeps the largest per minute, and this book the largest when it is full).
   */
  incomplete(thresholds: ReadonlyMap<string, number | null>): string[] {
    const out: string[] = [];
    for (const [id, threshold] of thresholds) if (threshold !== null && threshold < Math.max(this.floors[id] ?? GROUP_FLOOR_USD, this.#letGo.get(id) ?? 0)) out.push(id);
    return out;
  }

  /** The lowest threshold of these instruments, never under the recorder's floor: what a history question needs to ask for. */
  static lowest(thresholds: ReadonlyMap<string, number | null>): number {
    let low = Infinity; for (const v of thresholds.values()) if (v !== null && v < low) low = v;
    return Math.max(GROUP_FLOOR_USD, Number.isFinite(low) ? low : GROUP_FLOOR_USD);
  }
}

/** What the passive side did, in words: passive buyers took market sells, passive sellers took market buys. */
export const passiveText = (side: 'buy' | 'sell', amount: number): string => side === 'sell'
  ? t('Passive buyers took ${value} of market sells', { value: usd(amount) })
  : t('Passive sellers took ${value} of market buys', { value: usd(amount) });

/** A time to the millisecond (absorption happens inside a window of a few milliseconds). */
const precise = (time: number): string => `${clock(time, true)}:${String(new Date(time).getSeconds()).padStart(2, '0')}.${String(time % 1000).padStart(3, '0')}`;

/** How the threshold was set, in words. */
export function thresholdText(s: AbsorptionSettings, threshold: number): string {
  return s.mode === 'fixed' ? t('${value}, fixed', { value: usd(threshold) }) : t('${value}: mean + {k} SD of the last {minutes} min', { value: usd(threshold), k: s.k, minutes: s.sdMinutes });
}

/** The box for one or more marks under the pointer (marks drawn as one icon are on one side, and are summed). */
export function markLines(marks: readonly AbsorptionMark[], s: AbsorptionSettings): InfoLine[] {
  const side = marks[0]!.side, total = marks.reduce((a, m) => a + m.usd, 0), lines: InfoLine[] = [];
  lines.push({ text: t('ABSORPTION'), bold: true, color: side === 'sell' ? 'buy' : 'sell' });
  lines.push({ text: passiveText(side, total), wrap: true });
  if (marks.length === 1) {
    const m = marks[0]!, symbol = m.id.split(':').slice(1).join(':');
    lines.push({ label: t('Venue'), text: `${venueLabel(m.id)} ${symbol}`, rule: true }, { label: t('Price'), text: fmtPrice(m.price) });
    lines.push({ label: t('Time'), text: m.t1 > m.t0 ? `${precise(m.t0)} +${m.t1 - m.t0} ms` : precise(m.t0) });
    lines.push({ label: t('Fills'), text: String(m.fills) }, { label: t('Largest window'), text: `$${usd(m.peak)}` });
    lines.push({ label: t('Threshold'), text: thresholdText(s, m.threshold) });
  } else {
    const venues = [...new Set(marks.map(m => venueLabel(m.id)))].join(', ');
    lines.push({ label: t('Marks'), text: tn(marks.length, '{n} mark', '{n} marks'), rule: true }, { label: t('Venue'), text: venues });
    const lo = Math.min(...marks.map(m => m.price)), hi = Math.max(...marks.map(m => m.price));
    lines.push({ label: t('Price'), text: lo === hi ? fmtPrice(lo) : `${fmtPrice(lo)} – ${fmtPrice(hi)}` });
  }
  lines.push({ text: t('Market orders of one side met resting orders at one price within {ms} ms. It marks what traded, not what price did next.', { ms: ABSORPTION_WINDOW_MS }), color: 'muted', wrap: true, rule: true });
  return lines;
}
