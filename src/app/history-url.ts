/**
 * Where the recorded map history is read (hlm-history on hiverust behind a Cloudflare tunnel): the address of its folder for this coin,
 * with `latest.json` and one file per hour under it. Empty means no service: the page records what it sees from the moment it opens, as
 * it always did.
 */
export const HISTORY_URL = '';

/** The coins the service records (its folders are named by them, in lower case). */
const RECORDED = new Set(['BTC']);

/**
 * The history address for a coin in use, or '' when there is none: a local service may stand in while testing
 * (`?history=http://127.0.0.1:8791/v1/btc`), and `?history=off` turns it off.
 */
export function historyUrl(coin: string, search: string = typeof location === 'undefined' ? '' : location.search): string {
  if (!RECORDED.has(coin)) return '';
  const asked = new URLSearchParams(search).get('history');
  if (asked === 'off') return '';
  if (asked) {
    try {
      const url = new URL(asked);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url.href.replace(/\/+$/, '');
    } catch { /* not a URL: the configured address stands */ }
  }
  return HISTORY_URL;
}
