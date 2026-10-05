import type { Palette } from '../theme.ts';

/**
 * 'bookmap': one sequential colormap for size (side is implied by position relative to the mark), opaque cells whose
 * zero colour equals the pane background, log-scaled. 'sides': two hues by side, linear window.
 */
export type HeatStyleId = 'bookmap' | 'sides';
export const HEAT_STYLES: { id: HeatStyleId; label: string; title: string }[] = [
  { id: 'bookmap', label: 'Size', title: 'One colour ramp for size (Bookmap-style); log scale' },
  { id: 'sides', label: 'Sides', title: 'Two hues: bids and asks; linear scale' },
];

type Stop = [number, string];

const DARK: Stop[] = [[0, '#050f1f'], [0.22, '#0a3a66'], [0.42, '#1479b8'], [0.6, '#7fd0f0'], [0.7, '#f4fbff'], [0.8, '#ffe14a'], [0.9, '#ff8a00'], [1, '#e8281c']];
const LIGHT: Stop[] = [[0, '#ffffff'], [0.18, '#d6e6f7'], [0.38, '#7db6e6'], [0.58, '#2a78c4'], [0.74, '#f6c244'], [0.88, '#f0701f'], [1, '#b0102a']];

const hex = (value: string): [number, number, number] => { const n = parseInt(value.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };

export function stopsFor(dark: boolean): Stop[] { return dark ? DARK : LIGHT; }

/** 256×1 RGBA8 lookup table for the 'bookmap' style. */
export function buildLut(dark: boolean): Uint8Array {
  const stops = stopsFor(dark), out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 1; while (k < stops.length - 1 && stops[k]![0] < t) k++;
    const [t0, c0] = stops[k - 1]!, [t1, c1] = stops[k]!;
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0))), a = hex(c0), b = hex(c1);
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(a[c]! + (b[c]! - a[c]!) * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** CSS for the legend bar under the toolbar's contrast slider. */
export function legendBackground(style: HeatStyleId, palette: Palette): string {
  if (style === 'sides') return `linear-gradient(to right, ${palette.askSoft}, ${palette.ask}) top / 100% 50% no-repeat, linear-gradient(to right, ${palette.bidSoft}, ${palette.bid}) bottom / 100% 50% no-repeat`;
  return `linear-gradient(to right, ${stopsFor(palette.dark).map(([t, c]) => `${c} ${Math.round(t * 100)}%`).join(', ')})`;
}
