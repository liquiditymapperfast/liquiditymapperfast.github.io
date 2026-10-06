import type { Print } from '../prints.ts';
import type { Scope } from '../store.ts';

/** A size class of trade. A trade belongs to the highest tier whose threshold it reaches, and sounds only when that tier is on. */
export interface Tier { id: string; name: string; usd: number; on: boolean }

/**
 * What each panel may make a sound about, on top of the large-trade tiers. Each is off until chosen: a sound is for something rare,
 * discrete and worth looking up from another screen for, never for a state (a level, a trend) that is on screen all the time.
 */
export interface PanelSounds {
  /** Flow column: an exchange's cumulative delta moved far more in ten seconds than it usually does (`sensitivity` standard deviations), by at least `usd`. */
  flow: { burst: boolean; usd: number; sensitivity: number };
  /** Bar stats and footprint: a candle closed with a net taker delta of at least `usd` across the enabled venues. */
  bars: { delta: boolean; usd: number };
  /** Order book and heatmap: a wall of at least `usd` appeared near the price, or an established one was pulled without being traded through. */
  book: { wall: boolean; usd: number };
  /** Depth and Liquidity Tracker: the bids against the asks within 1 % of the price tipped past `pct` percent one way. */
  depth: { imbalance: boolean; pct: number };
  /** Open interest: a candle closed with an unusual change in open interest (the sensitivity is Highlights'). */
  oi: { jump: boolean };
}

export const DEFAULT_PANEL_SOUNDS: Readonly<PanelSounds> = Object.freeze({
  flow: { burst: false, usd: 2_000_000, sensitivity: 4 },
  bars: { delta: false, usd: 5_000_000 },
  book: { wall: false, usd: 20_000_000 },
  depth: { imbalance: false, pct: 70 },
  oi: { jump: false },
});

const flag = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;
const bound = (value: unknown, min: number, max: number, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
/** Panel sounds from storage, field by field, clamped. */
export function readPanelSounds(saved: unknown): PanelSounds {
  const o = (saved && typeof saved === 'object' ? saved : {}) as Record<string, Record<string, unknown> | undefined>, d = DEFAULT_PANEL_SOUNDS;
  return {
    flow: { burst: flag(o.flow?.burst, d.flow.burst), usd: Math.round(bound(o.flow?.usd, 100_000, 1_000_000_000, d.flow.usd)), sensitivity: bound(o.flow?.sensitivity, 2, 10, d.flow.sensitivity) },
    bars: { delta: flag(o.bars?.delta, d.bars.delta), usd: Math.round(bound(o.bars?.usd, 100_000, 1_000_000_000, d.bars.usd)) },
    book: { wall: flag(o.book?.wall, d.book.wall), usd: Math.round(bound(o.book?.usd, 500_000, 5_000_000_000, d.book.usd)) },
    depth: { imbalance: flag(o.depth?.imbalance, d.depth.imbalance), pct: Math.round(bound(o.depth?.pct, 30, 95, d.depth.pct)) },
    oi: { jump: flag(o.oi?.jump, d.oi.jump) },
  };
}

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
  /** What each panel may sound about. */
  panels: PanelSounds;
}

/** Smallest threshold a tier may have: the server keeps no trade below this. */
export const MIN_TIER_USD = 25_000;

export const DEFAULT_SOUNDS: Readonly<SoundSettings> = Object.freeze({
  on: false, volume: 0.35, scope: 'all' as Scope, barChime: false, panels: DEFAULT_PANEL_SOUNDS,
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
    panels: readPanelSounds(o.panels),
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

/** What an alert sounds like. Each panel has its own register and wave, so the ear can tell the panel before the eye finds it. */
export type AlertKind = 'flow-burst' | 'bar-delta' | 'wall-appeared' | 'wall-pulled' | 'imbalance' | 'oi-jump';

/**
 * Notes for a panel alert. Buying rises and selling falls (a bid-heavy book rises, an ask-heavy one falls), as the trade sounds do.
 * Flow is a high sine sweep, bars a mid triangle, walls a low sine thud, imbalance three triangle steps, open interest a double tick.
 */
export function alertNotes(kind: AlertKind, side: 'buy' | 'sell' | null, volume: number): Note[] {
  const up = side !== 'sell', v = volume;
  switch (kind) {
    case 'flow-burst': return up
      ? [{ freq: 880, gain: 0.16 * v, decay: 0.3, delay: 0, wave: 'sine' }, { freq: 1318.5, gain: 0.18 * v, decay: 0.45, delay: 0.09, wave: 'sine' }]
      : [{ freq: 1318.5, gain: 0.18 * v, decay: 0.3, delay: 0, wave: 'sine' }, { freq: 880, gain: 0.2 * v, decay: 0.45, delay: 0.09, wave: 'sine' }];
    case 'bar-delta': return up
      ? [{ freq: 523.25, gain: 0.15 * v, decay: 0.45, delay: 0, wave: 'triangle' }, { freq: 783.99, gain: 0.16 * v, decay: 0.6, delay: 0.14, wave: 'triangle' }]
      : [{ freq: 783.99, gain: 0.16 * v, decay: 0.45, delay: 0, wave: 'triangle' }, { freq: 523.25, gain: 0.18 * v, decay: 0.6, delay: 0.14, wave: 'triangle' }];
    case 'wall-appeared': return [{ freq: up ? 164.81 : 130.81, gain: 0.3 * v, decay: 0.5, delay: 0, wave: 'sine' }, { freq: up ? 196 : 98, gain: 0.26 * v, decay: 0.6, delay: 0.12, wave: 'sine' }];
    case 'wall-pulled': return [{ freq: up ? 196 : 98, gain: 0.26 * v, decay: 0.4, delay: 0, wave: 'sine' }, { freq: up ? 130.81 : 82.41, gain: 0.22 * v, decay: 0.6, delay: 0.12, wave: 'sine' }];
    case 'imbalance': return (up ? [392, 493.88, 587.33] : [587.33, 493.88, 392]).map((freq, i) => ({ freq, gain: 0.14 * v, decay: 0.3, delay: i * 0.1, wave: 'triangle' as const }));
    case 'oi-jump': return [{ freq: 1046.5, gain: 0.1 * v, decay: 0.12, delay: 0, wave: 'sine' }, { freq: 1046.5, gain: 0.1 * v, decay: 0.12, delay: 0.11, wave: 'sine' }];
  }
}
