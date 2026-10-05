import type { Print } from '../prints.ts';
import type { Scope } from '../store.ts';

/** A size class of trade. A trade belongs to the highest tier whose threshold it reaches, and sounds only when that tier is on. */
export interface Tier { id: string; name: string; usd: number; on: boolean }

export interface SoundSettings {
  /** Master switch. */
  on: boolean;
  /** 0 to 1. */
  volume: number;
  /** Which markets' trades sound: every enabled venue, or spot only, or perpetual only. */
  scope: Scope;
  tiers: Tier[];
  /** A soft chime when a candle closes with unusually large volume. */
  barChime: boolean;
}

/** Smallest threshold a tier may have: the server keeps no trade below this. */
export const MIN_TIER_USD = 25_000;

export const DEFAULT_SOUNDS: Readonly<SoundSettings> = Object.freeze({
  on: false, volume: 0.35, scope: 'all' as Scope, barChime: false,
  tiers: [
    { id: 'signal', name: 'Signal', usd: 50_000, on: false },
    { id: 'surge', name: 'Surge', usd: 150_000, on: false },
    { id: 'whale', name: 'Whale', usd: 400_000, on: true },
    { id: 'leviathan', name: 'Leviathan', usd: 1_500_000, on: true },
  ],
});

/** Merge a saved object over the defaults: unknown fields dropped, numbers clamped, thresholds kept ascending and above the floor. */
export function readSounds(saved: unknown): SoundSettings {
  const o = saved && typeof saved === 'object' ? saved as Partial<Record<keyof SoundSettings, unknown>> : {};
  const d = DEFAULT_SOUNDS;
  const savedTiers = Array.isArray(o.tiers) ? o.tiers as Partial<Tier>[] : [];
  let floor = MIN_TIER_USD;
  const tiers = d.tiers.map((tier, i) => {
    const s = savedTiers.find(t => t?.id === tier.id) ?? savedTiers[i];
    const usd = typeof s?.usd === 'number' && Number.isFinite(s.usd) ? Math.max(floor, Math.round(s.usd)) : Math.max(floor, tier.usd);
    floor = usd + 1_000;
    return { id: tier.id, name: tier.name, usd, on: typeof s?.on === 'boolean' ? s.on : tier.on };
  });
  return {
    on: typeof o.on === 'boolean' ? o.on : d.on,
    volume: typeof o.volume === 'number' && Number.isFinite(o.volume) ? Math.min(1, Math.max(0, o.volume)) : d.volume,
    scope: o.scope === 'spot' || o.scope === 'perp' ? o.scope : 'all',
    barChime: typeof o.barChime === 'boolean' ? o.barChime : d.barChime,
    tiers,
  };
}

/** One sweep: the prints of one side that landed within the coalescing window, across venues. */
export interface SoundEvent { side: 'buy' | 'sell'; usd: number; n: number; venues: number; largest: number; firstT: number }

/**
 * Merges the fills of one aggressive order that arrive on several venues (or as several fills) into one event, so a sweep is one sound.
 * A group closes `windowMs` after its first print.
 */
export class Coalescer {
  #groups = new Map<'buy' | 'sell', { first: number; usd: number; n: number; venues: Set<string>; largest: number; firstT: number }>();
  constructor(private windowMs = 250) {}
  add(print: Print, now: number): void {
    let g = this.#groups.get(print.side);
    if (!g) { g = { first: now, usd: 0, n: 0, venues: new Set(), largest: 0, firstT: print.t }; this.#groups.set(print.side, g); }
    g.usd += print.usd; g.n++; g.venues.add(print.id.split(':')[0]!); g.largest = Math.max(g.largest, print.usd); g.firstT = Math.min(g.firstT, print.t);
  }
  /** Events whose window has elapsed (all of them with `force`). */
  drain(now: number, force = false): SoundEvent[] {
    const out: SoundEvent[] = [];
    for (const [side, g] of this.#groups) if (force || now - g.first >= this.windowMs) { out.push({ side, usd: g.usd, n: g.n, venues: g.venues.size, largest: g.largest, firstT: g.firstT }); this.#groups.delete(side); }
    return out;
  }
}

/** The tier a size belongs to: the highest threshold it reaches (null below the first). */
export function tierOf(usd: number, tiers: readonly Tier[]): { tier: Tier; index: number } | null {
  let found: { tier: Tier; index: number } | null = null;
  tiers.forEach((tier, index) => { if (usd >= tier.usd) found = { tier, index }; });
  return found;
}

export interface Note { freq: number; gain: number; decay: number; delay: number; wave: 'triangle' | 'sine' }

/** Buys climb (E5 G#5 B5 E6), sells fall (B4 F#4 D4 B3): the contour says the side, the number of notes says the tier. */
const BUY = [659.26, 830.6, 987.76, 1318.52], SELL = [493.88, 369.99, 293.66, 246.94];

/**
 * The notes for one event. `index` is the tier's position (0 = smallest): one note for the first tier, up to four for the fourth.
 * Loudness grows with the square root of how far past its threshold the size is, within a bounded range, and `volume` scales it all.
 */
export function notesFor(side: 'buy' | 'sell', index: number, usd: number, tierUsd: number, volume: number): Note[] {
  const count = Math.min(4, index + 1), ladder = side === 'buy' ? BUY : SELL;
  const loud = Math.min(3, Math.max(1, Math.sqrt(usd / tierUsd)));
  const base = Math.min(0.35, 0.05 + 0.07 * loud) * volume * (side === 'sell' ? 1.2 : 1);
  return Array.from({ length: count }, (_, k) => ({ freq: ladder[k]!, gain: base * (k === count - 1 ? 1.15 : 0.85), decay: 0.22 + 0.06 * index + 0.04 * (loud - 1), delay: k * 0.08, wave: 'triangle' as const }));
}

/** A neutral two-note chime for an unusual candle: it carries no side. */
export function chimeNotes(volume: number): Note[] {
  return [{ freq: 880, gain: 0.1 * volume, decay: 0.35, delay: 0, wave: 'sine' }, { freq: 1174.66, gain: 0.08 * volume, decay: 0.5, delay: 0.12, wave: 'sine' }];
}
