# Plus

Plus is the page's paid part (2026-11): it pays for the servers behind the page and opens what they store. The page stays free and open
source; nothing that the browser works out from the exchanges' public feeds is ever behind it, and only what the site's own servers
store or buy can be (a copy of the code cannot remove a lock the server keeps).

## What is Plus today

| Data | Who |
| --- | --- |
| The live liquidation levels (the stripe, the column, the phone's Liq tab) | free |
| The levels' history in the Depth pane, today and the 7 UTC days before it | free |
| The levels' history before that | Plus |

`FREE_DAYS` (7) is one constant in `src/app/plus/config.ts`, and one variable of the server's. A day file is free when its UTC day starts
at or after `floor(now / 86,400,000) * 86,400,000 - FREE_DAYS * 86,400,000`.

## The pieces

- **The levels service** (`HyperLiquidMap_Levels`, on hiverust) serves every file to whoever reaches it; it is reachable only through
  the Cloudflare tunnel.
- **The Worker** (`HyperLiquidMap_Plus`) runs on the routes of the paid paths and on `plus.hiverust.dev`. It lets a free day through,
  answers a paid one only to a valid pass, gives a key and a pass after a checkout (`POST /v1/pass`), renews a pass for a key
  (`POST /v1/pass/renew`), finds a membership by the receipt's email and invoice number (`POST /v1/restore`), and keeps each
  subscription's state from Paddle's notifications.
- **The page**: `src/app/plus/`.
  - `config.ts`: the free days, the Worker's address, Paddle's client-side token, price ids, prices and portal link.
  - `pass.ts`: the membership as the browser holds it (`localStorage` `lmf.plus`: `{ v, key, pass, until }`), and its renewal.
  - `panel.ts`: the Plus panel (the Plus button, the lock).
  - `page.ts`, `index.html`, `page.css`, `boot.ts`: the Plus page (`plus/`), the only page with a form or another site's script.
  - `liq-history.ts` asks for a paid day only with a pass (`LiqAccess`); `panes/lower-panes.ts` draws the closed stretch and its lock.

## Putting Plus on sale

1. In Paddle: a product with a monthly (and a yearly) price, a client-side token, the default payment link set to the Plus page, and
   the notification destination set to the Worker's `/v1/paddle/webhook`.
2. In `src/app/plus/config.ts`: `PADDLE.environment` (`sandbox` or `production`), `token`, `monthly` and `yearly` (`id` and the price
   in dollars before tax, which the Plus page writes), `portal` (Paddle's customer portal link). While the token or the monthly id is
   empty the pages say that Plus is not on sale yet.
3. The three legal pages (`src/app/public/terms/`, `privacy/`, `refunds/`) name the seller and the contact address
   (`support@liquiditymapper.com`, forwarded by Cloudflare Email Routing); the Plus page's footer names the same address
   (`PLUS_CONTACT`). The prices on the Plus page and in Paddle must say the same.

## Testing without the real services

- `?levels=http://127.0.0.1:<port>/v1/btc/liquidations.json` and `?plus=http://127.0.0.1:<port>/v1` point the page at local
  stand-ins (localhost only).
- The Plus page works on the dev server (`npm run dev:client`, `http://localhost:5173/plus/`) and in the built site
  (`npm run build:site`, then `npm run preview:site`).
- `tests/app-plus.test.mts` covers the pass and its renewal; `tests/app-liq-history.test.mts` what is asked for with and without one.
