/**
 * The Depth pane's bands (`state.depthBands`): nested distances from the price, each band holding every one inside it, drawn as layers from the
 * strongest colour at the centre to the lightest outside. A preset or the person's own list; kept apart from the pane so the store and the tests
 * read it without the pane's weight.
 *
 * Presets double from one band to the next (Balanced is ±0.31 % to ±5 %, Near ±0.125 % to ±2 %, Wide ±1.25 % to ±20 %). On the recorded BTC book of
 * 25 venues (2026-11-05) the ±0.31 % band was about a third of the ±5 % one, so on a linear scale every layer has room; Detail (a square-root
 * scale) gives a thin inner band more where one venue alone, or a thin coin, leaves it a sliver.
 */
export const DEPTH_PRESETS = ['near', 'balanced', 'wide', 'custom'] as const;
export type DepthPreset = (typeof DEPTH_PRESETS)[number];
export const PRESET_BANDS: Readonly<Record<Exclude<DepthPreset, 'custom'>, readonly number[]>> = {
  near: [0.00125, 0.0025, 0.005, 0.01, 0.02],
  balanced: [0.003125, 0.00625, 0.0125, 0.025, 0.05],
  wide: [0.0125, 0.025, 0.05, 0.1, 0.2],
};
/** At most this many bands, each from 0.05 % to 50 % of the price. */
export const MAX_BANDS = 6, MIN_BAND = 0.0005, MAX_BAND = 0.5;

export interface DepthSettings {
  preset: DepthPreset;
  /** The person's own bands (fractions, ascending), used with the Custom preset and kept while another preset is picked. */
  custom: number[];
  /** Linear: heights in proportion to the money. Detail: the square root of it, so a thin inner band shows; the figures stay in money. */
  scale: 'linear' | 'detail';
  /** USD, or the coin (each price bin's USD over its own price, never today's price over old totals). */
  units: 'usd' | 'coin';
  /** The table of the bands' figures at the right of the pane. */
  table: boolean;
  /** One band brought forward: drawn alone with the bands inside it, at its own scale, and the band Highlights judge. Null: all of them. */
  focus: number | null;
}

export const DEPTH_DEFAULT: DepthSettings = { preset: 'balanced', custom: [0.0025, 0.005, 0.01, 0.02, 0.05], scale: 'linear', units: 'usd', table: true, focus: null };

/** What the Depth pane adds up: the order book's resting orders, or the liquidation levels of Hyperliquid's BTC positions (liq-history.ts). */
export type DepthSource = 'book' | 'liq';
/**
 * The Liquidation levels view's own bands. Liquidation levels sit further from the price than resting orders (2026-11-01, two snapshots: nothing
 * within ±0.31 %, about $11M within ±1.25 %, $170M within ±5 %, $730M within ±20 %), so Wide is their default.
 */
export const LIQ_DEFAULT: DepthSettings = { ...DEPTH_DEFAULT, preset: 'wide', custom: [0.01, 0.025, 0.05, 0.1, 0.2] };

/** A list of bands as fractions: finite, within MIN_BAND..MAX_BAND, ascending without repeats, one to MAX_BANDS of them; otherwise null. */
export function cleanBands(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_BANDS) return null;
  const out: number[] = [];
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_BAND || value > MAX_BAND) return null;
    if (out.length && value <= out[out.length - 1]! * (1 + 1e-9)) return null;
    out.push(value);
  }
  return out;
}

/** The settings of a save or a layout, field by field: anything missing or not one of the choices gets its default (`fallback`'s). */
export function readDepthSettings(raw: unknown, fallback: DepthSettings = DEPTH_DEFAULT): DepthSettings {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const custom = cleanBands(o.custom) ?? [...fallback.custom];
  const preset = (DEPTH_PRESETS as readonly unknown[]).includes(o.preset) ? o.preset as DepthPreset : fallback.preset;
  const count = preset === 'custom' ? custom.length : PRESET_BANDS[preset].length;
  const focus = typeof o.focus === 'number' && Number.isInteger(o.focus) && o.focus >= 0 && o.focus < count ? o.focus : null;
  return {
    preset, custom, focus,
    scale: o.scale === 'detail' ? 'detail' : 'linear',
    units: o.units === 'coin' ? 'coin' : 'usd',
    table: typeof o.table === 'boolean' ? o.table : fallback.table,
  };
}

/** The bands the pane draws (fractions, ascending). */
export function bandsOf(s: Pick<DepthSettings, 'preset' | 'custom'>): readonly number[] {
  return s.preset === 'custom' ? s.custom : PRESET_BANDS[s.preset];
}

/** The band Highlights judge and the header reads: the band brought forward, else the widest. */
export function watchedBand(s: DepthSettings): number {
  const count = bandsOf(s).length;
  return s.focus !== null && s.focus < count ? s.focus : count - 1;
}

/** A band as the pane writes it, without the ±: two significant figures under 1 % (0.31, 0.63, 0.13), else up to two decimals (1.25, 2.5, 5). */
export function bandText(r: number): string {
  const pct = r * 100;
  return String(pct < 1 ? Number(pct.toPrecision(2)) : Number(pct.toFixed(2)));
}

/** A band as the editor writes it, so it reads back exactly (0.3125, not the label's 0.31): the percentage without float noise. */
export function bandEditText(r: number): string {
  return String(Number((r * 100).toPrecision(12)));
}

/**
 * Bands typed as percentages ("0.25, 0.5, 1, 2, 5", spaces, commas or semicolons between them, a % allowed) into fractions, sorted; or a reason
 * it cannot be used.
 */
export function parseBands(text: string): { bands: number[] } | { error: 'empty' | 'number' | 'range' | 'count' | 'repeat' } {
  const parts = text.split(/[\s,;]+/).map(p => p.replace(/%$/, '')).filter(p => p !== '');
  if (!parts.length) return { error: 'empty' };
  const values: number[] = [];
  for (const p of parts) {
    if (!/^\d*\.?\d+$/.test(p)) return { error: 'number' };
    const value = Number(p) / 100;
    if (!(value >= MIN_BAND && value <= MAX_BAND)) return { error: 'range' };
    values.push(value);
  }
  if (values.length > MAX_BANDS) return { error: 'count' };
  values.sort((a, b) => a - b);
  for (let i = 1; i < values.length; i++) if (values[i]! <= values[i - 1]! * (1 + 1e-9)) return { error: 'repeat' };
  return { bands: values };
}
