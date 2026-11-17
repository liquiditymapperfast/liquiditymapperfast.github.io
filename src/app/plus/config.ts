/**
 * Plus, the paid tier (2026-11): what the page has to know about it. The page stays free and open source; Plus pays for the servers behind
 * it and opens what they store. What is free and what is Plus is decided by the server (a Worker in front of the levels service, the
 * `HyperLiquidMap_Plus` project): the page only knows the rule so that it can say it, and never asks for what it would be refused.
 */

export const DAY_MS = 86_400_000;
/** The liquidation levels' history is free for today and this many UTC days before it; what is older is Plus. */
export const FREE_DAYS = 7;
/** The first moment whose liquidation history is free at `now`: the start of the UTC day `FREE_DAYS` before today's (the server's rule). */
export const freeFrom = (now: number): number => Math.floor(now / DAY_MS) * DAY_MS - FREE_DAYS * DAY_MS;

/** Where passes are given and renewed (the Worker's own address). */
export const PLUS_API = 'https://plus.hiverust.dev/v1';

/**
 * Paddle's side of the checkout (Paddle is the seller of record): the client-side token and the price ids are public by design. While the
 * token or the monthly price is empty Plus is not on sale, and the pages say so instead of offering a checkout. `usd` is each price before
 * tax, written on the Plus page (the checkout shows the buyer's own currency and tax); `portal` is Paddle's page where a subscriber ends
 * the subscription or changes the card.
 */
export interface PlusPrice { readonly id: string; readonly usd: number }
export const PADDLE: { readonly environment: 'sandbox' | 'production'; readonly token: string; readonly portal: string; readonly monthly: PlusPrice; readonly yearly: PlusPrice } = {
  environment: 'sandbox', token: '', portal: '', monthly: { id: '', usd: 0 }, yearly: { id: '', usd: 0 },
};
export const plusOnSale = (): boolean => PADDLE.token !== '' && PADDLE.monthly.id !== '';
/** How many keys a subscription holds at most (the server's limit): a newer one replaces the oldest, and no more are given within a day. */
export const PLUS_KEYS = 5;
/** Where a buyer writes about the page itself (billing questions go to Paddle, the seller of record). */
export const PLUS_CONTACT = 'support@liquiditymapper.com';

/** The page that sells Plus and restores it on another device, beside the app (the only page with a form or another site's script). */
export const PLUS_PAGE = 'plus/';
/** The pages a seller owes its buyers, beside the app. */
export const LEGAL = { terms: 'terms/', privacy: 'privacy/', refunds: 'refunds/' } as const;

let read: { search: string; url: string } | null = null;

/**
 * The address in use: a local stand-in may answer while testing (`?plus=http://127.0.0.1:8799/v1`), as for the levels file
 * (`liq-url.ts`). Read again only when the page's address changes.
 */
export function plusApi(search: string = typeof location === 'undefined' ? '' : location.search): string {
  if (read?.search !== search) read = { search, url: urlFrom(search) };
  return read.url;
}

function urlFrom(search: string): string {
  const asked = new URLSearchParams(search).get('plus');
  if (asked) {
    try {
      const url = new URL(asked);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url.href.replace(/\/$/, '');
    } catch { /* not a URL: the configured address stands */ }
  }
  return PLUS_API;
}
