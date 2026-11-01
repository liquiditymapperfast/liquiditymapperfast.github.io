/** Where the Liquidation levels layer reads its file (kept apart so the store can list the layer without loading the layer's code). */

/** The levels service's public address; empty until it exists, and then the layer is listed as upcoming. */
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
