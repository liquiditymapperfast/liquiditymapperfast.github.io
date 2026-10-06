import { contrastRatio, mixHex, rgb, type Palette } from '../theme.ts';

/**
 * The two lines of every row: spot is blue and perpetual is amber, as on aggr.trade, in every theme and whichever way the money moved: the
 * hue says which market, never whether it was buying or selling, so it does not follow a theme's buy and sell colours. Each is pushed
 * toward the page's text colour until it stands 3:1 clear of the panel (a graphic's contrast), so it reads on every theme; the quiet tone
 * is the same line faded.
 *
 * One exception: where a theme's own buy or sell colour sits close to blue or amber (the colour-blind theme is Okabe-Ito blue and orange),
 * a blue or amber line would read as direction there, so that theme gets two other hues from the same colour-blind-safe set.
 */
export interface LaneColors { spot: string; perp: string; spotQuiet: string; perpQuiet: string }

const SPOT = '#3d8bfd', PERP = '#ffb648';
/** Okabe-Ito reddish purple and bluish green: they stay apart from each other and from the blue and orange of a colour-blind theme's buy and sell. */
const SPOT_ALT = '#cc79a7', PERP_ALT = '#009e73';
/** Hues closer than this (degrees) are read as the same colour. */
const NEAR = 30;
const cache = new WeakMap<Palette, LaneColors>();

/** Hue of a #rrggbb colour in degrees, or null for a grey (which has none to confuse). */
export function hueOf(hex: string): number | null {
  const [r, g, b] = rgb(hex), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.08) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
/** The smallest angle between two hues. */
export const hueGap = (a: number, b: number): number => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/** Whether `color` is near the hue of the theme's buy or sell colour. */
export function nearDirection(color: string, p: Pick<Palette, 'bid' | 'ask' | 'candleUp' | 'candleDown'>): boolean {
  const h = hueOf(color); if (h === null) return false;
  return [p.bid, p.ask, p.candleUp, p.candleDown].some(other => { const o = hueOf(other); return o !== null && hueGap(h, o) < NEAR; });
}

function legible(color: string, p: Palette): string {
  let amount = 0, tone = color;
  while (amount < 1 && contrastRatio(tone, p.panel) < 3) { amount = Math.min(1, amount + 0.05); tone = mixHex(color, p.text, amount); }
  return tone;
}

export function laneColors(p: Palette): LaneColors {
  let c = cache.get(p);
  if (!c) {
    const alt = nearDirection(SPOT, p) || nearDirection(PERP, p);
    const spot = legible(alt ? SPOT_ALT : SPOT, p), perp = legible(alt ? PERP_ALT : PERP, p);
    c = { spot, perp, spotQuiet: mixHex(spot, p.panel, 0.6), perpQuiet: mixHex(perp, p.panel, 0.6) }; cache.set(p, c);
  }
  return c;
}
