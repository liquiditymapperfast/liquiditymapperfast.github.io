/**
 * Where Liquidation levels reads its file, and its setting (kept apart so the store and the toolbar can read them without loading the
 * feature's code).
 */

/** The Chart deck's Liquidation levels: whether they are drawn on the map, and whether the profile column adds them up instead of the book. */
export interface LiqLevelSettings { on: boolean; profile: boolean }
/** A saved setting, checked; what a save from before the feature lacks reads as on (new features start on). */
export function readLiqLevels(saved: unknown): LiqLevelSettings {
  const s = saved && typeof saved === 'object' ? saved as { on?: unknown; profile?: unknown } : {};
  return { on: typeof s.on === 'boolean' ? s.on : true, profile: typeof s.profile === 'boolean' ? s.profile : true };
}

/** The levels service's public address; empty until it exists, and then the Chart deck has no Liquidation levels button. */
export const LIQ_LEVELS_URL = '';

/** The address in use: a local service may stand in while testing (`?levels=http://127.0.0.1:8790/v1/btc/liquidations.json`). */
export function liqLevelsUrl(search: string = typeof location === 'undefined' ? '' : location.search): string {
  const asked = new URLSearchParams(search).get('levels');
  if (asked) {
    try {
      const url = new URL(asked);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url.href;
    } catch { /* not a URL: the configured address stands */ }
  }
  return LIQ_LEVELS_URL;
}
