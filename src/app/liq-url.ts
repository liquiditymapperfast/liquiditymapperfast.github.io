/**
 * Where Liquidation levels reads its file, and its setting (kept apart so the store and the toolbar can read them without loading the
 * feature's code).
 */

/** The Chart deck's Liquidation levels: whether they are drawn on the map, and whether their own column stands beside the profile column. */
export interface LiqLevelSettings { on: boolean; column: boolean }
/** A saved setting, checked; what a save from before the feature lacks reads as on (new features start on). */
export function readLiqLevels(saved: unknown): LiqLevelSettings {
  const s = saved && typeof saved === 'object' ? saved as { on?: unknown; column?: unknown } : {};
  return { on: typeof s.on === 'boolean' ? s.on : true, column: typeof s.column === 'boolean' ? s.column : true };
}

/**
 * The levels service's public address: hlm-levels on hiverust behind a Cloudflare tunnel (2026-11-01). Empty would mean no service, and then the
 * Chart deck has no Liquidation levels button.
 */
export const LIQ_LEVELS_URL = 'https://levels.hiverust.dev/v1/btc/liquidations.json';

let read: { search: string; url: string } | null = null;

/**
 * The address in use: a local service may stand in while testing (`?levels=http://127.0.0.1:8790/v1/btc/liquidations.json`). Read again only
 * when the page's address changes: the map's layout asks for it with every frame.
 */
export function liqLevelsUrl(search: string = typeof location === 'undefined' ? '' : location.search): string {
  if (read?.search !== search) read = { search, url: urlFrom(search) };
  return read.url;
}

function urlFrom(search: string): string {
  const asked = new URLSearchParams(search).get('levels');
  if (asked) {
    try {
      const url = new URL(asked);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url.href;
    } catch { /* not a URL: the configured address stands */ }
  }
  return LIQ_LEVELS_URL;
}
