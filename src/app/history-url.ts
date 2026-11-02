/**
 * Where the recorded history is read (hlm-history on hiverust behind a Cloudflare tunnel, 2026-11-02): the address of the coin's folder, with
 * `latest.json` and one file per hour under it. Empty means no service: the page records what it sees from the moment it opens, as it always
 * did.
 */
export const HISTORY_BASE = 'https://history.hiverust.dev/v1';

/**
 * The coins the service records (its folders are named by them, in lower case): BTC with its books and trade side, the others their trade
 * side only (flow, liquidations, open interest, large trades). The same list as hlm-history's `alt_coins` (config/hlm-history.production.json),
 * the twenty most traded after BTC when it was set (2026-11-02).
 */
export const RECORDED_COINS: readonly string[] = ['BTC', 'ETH', 'SOL', 'ZEC', 'HYPE', 'PEPE', 'XRP', 'NEAR', 'TRUMP', 'XPL', 'LIT', 'UNI', 'DOGE', 'BNB', 'PUMP', 'AAVE', 'ENA', 'LINK', 'WLD', 'TRX', 'SUI'];
/**
 * Whether the public address serves the other coins' folders: the tunnel's route passes `/v1/btc` only until it is widened to every coin's
 * folder (hlm-history docs/DEPLOY.md). Until then the other coins read history only from a local stand-in.
 */
export const OTHER_COINS_SERVED = false;
const RECORDED = new Set(RECORDED_COINS);

/**
 * The history address for a coin in use, or '' when there is none: a local service may stand in while testing (`?history=http://127.0.0.1:8791/v1`,
 * or one coin's folder there, `.../v1/btc`, which names the same service), and `?history=off` turns it off.
 */
export function historyUrl(coin: string, search: string = typeof location === 'undefined' ? '' : location.search): string {
  if (!RECORDED.has(coin)) return '';
  const folder = `/${coin.toLowerCase()}`;
  const asked = new URLSearchParams(search).get('history');
  if (asked === 'off') return '';
  if (asked) {
    try {
      const url = new URL(asked);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url.href.replace(/\/+$/, '').replace(/(\/v1)\/[^/]+$/, '$1') + folder;
    } catch { /* not a URL: the configured address stands */ }
  }
  // No service configured (HISTORY_BASE ''), or one that does not serve this coin yet: off, unless a local one stands in above.
  return HISTORY_BASE && (coin === 'BTC' || OTHER_COINS_SERVED) ? HISTORY_BASE + folder : '';
}
