# Plus

Plus is the page's paid part (2026-11): it pays for the servers behind the page and opens what they store. The page stays free and open
source; nothing that the browser works out from the exchanges' public feeds is ever behind it, and only what the site's own servers
store or buy can be (a copy of the code cannot remove a lock the server keeps).

## What is Plus today

| Data | Who |
| --- | --- |
| The live liquidation levels of all traders (the stripe, the column, the phone's Liq tab) | free |
| The levels' history in the Depth pane, today and the 7 UTC days before it | free |
| The levels' history before that | Plus |
| The liquidations of HyperTracker's profitable traders, live and in the history (`/v1/plus/btc/liquidations-groups.json`, `liquidation-history-groups/<day>.json`) | Plus |
| Stop and take-profit levels, live and in the history (`/v1/plus/btc/triggers.json`, `trigger-history/<day>.json`) | Plus |
| The four-hour rollups a Depth view wider than 120 days reads (`/v1/plus/btc/*-4h.json`) | Plus |

Every path under `/v1/plus/` is paid, whatever the day.

## What the levels show (one choice for the page)

`LiqLevelSettings` (`src/app/liq-url.ts`, saved) holds `kind` (`liq`, `stops`, `both`), `takes` and `group` (`all`, `profitable`).
The free view is liquidations of all traders without take profits; anything else is Plus. A save from before reads as the free view, and
any other `group` value as `all`. Without Plus the page draws the free view and keeps the choice, which comes back with Plus (`effectiveView` in
`src/app/liq-view.ts`); the controls show the saved choice with a lock, and pressing a Plus choice opens the Plus panel without changing
it (`liq-menu.ts`).

- **Where it is chosen**: the button at the top of the map's liquidation column (it names what is drawn and opens the menu; a compact map
  has only the 16 px strip and no heading, so there it is chosen in the panel or on the Liq tab), the Liq levels panel, and the title of
  the phone's Liq tab. The stripe, the column, the Liq tab and the Depth pane's Liquidation levels follow it, and the Range summary says
  which kind and group it sums.
- **Groups** are for liquidations only: the stop and take-profit files have none. The one group is HyperTracker's profitable traders:
  the wallets HyperTracker counts as profitable, its four cohorts with a positive all-time perp profit. The page reads that group alone from the groups files (by its name in a history file's `groups`, else
  the first part) and leaves whatever else they hold unread.
- **Both** adds liquidations and stops bin by bin (`sumLevels`); each part is taken away by price from its own snapshot
  (`combineTaken`: the orders' snapshot is often an earlier one). Stops come about one snapshot in two, so in the history a snapshot is
  drawn for both only when it has both parts (joined by `createdAt`; the rollups by their four-hour block), about one an hour.
- **Take profits** close longs with sells above the price and shorts with buys below it, the other way round from liquidations and stops,
  so they are held with their sides swapped and never added to the rest. One look everywhere, dashed strokes (`TAKE_DASH` in
  `liq-levels.ts`): a lane of their own by the live edge (`stripeLanes`: the levels' lane is the one beside the liquidation column, whose
  curve sums them), bars from the column's right edge, bars on the Liq tab, a line in the Depth pane. Coloured by what they do: sells in
  the falling colour. The take profits' lane carries a caption ("Take profits"); the levels' lane needs none, since the column's button
  beside it names what it holds and what the curve adds up, and while take profits show a note under that button says they are not in it.
- **Liq + stops apart**: wherever the page gives a total of both (the stripe's box, the column's reading and its Mirror box, the Liq tab's
  finger), it adds "Total $X = liquidations $Y + stops $Z" (`partStandings`, `partsBetween`, `partsOnTheWay`); the picture stays the
  total. The Depth pane's readout does not split it: its history rows hold the sum only.
- **Stops are never hidden for age**: an orders file older than three hours, or more than about two hours older than the liquidations beside
  it, is said under the legend ("stops as of 14:00").
- **Live files** (`LiqLevelsSource`): the groups and orders files are asked for with the pass when the free file brings a snapshot they do
  not have yet; an answer of an older snapshot (no order file read yet) is asked again two minutes later, three times a snapshot at most.
  The gate's refusal drops the pass (`Plus.refused`); a 503 waits its `Retry-After` (30 s to 15 min), or a minute when the page cannot
  read one; anything else is a failed read (30 s). Every read of the levels service or the gate is given up after 30 s.

`FREE_DAYS` (7) is one constant in `src/app/plus/config.ts`, and one variable of the server's. A day file is free when its UTC day starts
at or after `floor(now / 86,400,000) * 86,400,000 - FREE_DAYS * 86,400,000`.

## The pieces

- **The levels service** (`HyperLiquidMap_Levels`, on hiverust, reached through the Cloudflare tunnel) is the gate: it serves a free
  day and the live files to anyone, and a paid day or file only with a valid pass in `Authorization: Bearer`, which it checks itself
  with the Worker's key (since 2026-11-17; "the gate" below means it). Its refusal is the one this page knows: 403
  `{"error":"plus_required"}`.
- **The Worker** (`HyperLiquidMap_Plus`) answers only `plus.hiverust.dev`; no data request passes through it. It gives a key and a
  pass after a checkout (`POST /v1/pass`), renews a pass for a key
  (`POST /v1/pass/renew`), finds a membership by the receipt's email and invoice number (`POST /v1/restore`), and keeps each
  subscription's state from Paddle's notifications.
- **The page**: `src/app/plus/`.
  - `config.ts`: the free days, the Worker's address, Paddle's client-side token, price ids, prices and portal link.
  - `pass.ts`: the membership as the browser holds it (`localStorage` `lmf.plus`: `{ v, key, pass, until, ended, renews, skew, next }`),
    and its renewal.
  - `panel.ts`: the Plus panel (the Plus button, the lock).
  - `page.ts`, `index.html`, `page.css`, `boot.ts`: the Plus page (`plus/`), the only page with a form or another site's script.
  - `liq-history.ts` asks for a paid day only with a pass (`LiqAccess`), and for the Plus families (groups, orders, rollups) only with
    one; `panes/lower-panes.ts` draws the closed stretch and its lock.
  - `liq-view.ts` (the choice and the view drawn), `liq-menu.ts` (its menu and panel rows), `liq-words.ts` (the words by kind).

## How the page behaves

- **Renewal.** A pass with under six hours left is renewed with the key, at most about once a minute per tab (`next`, kept beside the
  membership, is the wait; tabs share it when they see each other's storage); after a refusal, or a pass that came already near its end
  (the last hours of a membership), the wait is an hour. A server's `Retry-After` is used between one minute and one hour, where the
  server exposes it to the page.
- **One paid file first.** After the pass changes (and at the start) the history asks for one paid file, the newest closed day, and asks
  for the rest only once that one is answered: a gate that refuses every pass, even fresh ones, gets one request per new pass instead of
  every paid day of the view at once. A 4xx other than the refusal and a 429 (a day the service has no file for) counts as answered:
  the rest follow, and that day waits ten minutes. A 5xx, a 429 or no answer keeps the rest waiting, the one file asked again each
  minute.
- **The server's clock.** A grant carries the server's time; where the device's clock is more than five minutes off, a pass's end is
  judged by the server's (`skew`).
- **States** (`Plus.state`): `none`, `on`, `checking` (a key is held, no pass in force yet: the pass ran out or the server was not
  reached) and `ended` (the server refused to renew). Only `ended` is told as an end, and only `none` and `ended` are offered a
  checkout: a member is not sold a second subscription while the membership is on or being checked, nor while a payment made in this
  browser is still being set up.
- **Refusals.** Only the gate's own answer (HTTP 403 with `{"error":"plus_required"}`) says anything about Plus; any other 403 is a
  failed read. With a pass, that pass is dropped and renewed. Without one (the page's clock called the day free, the server's did not),
  the days up to it are closed for ten minutes; a day before the boundary or within two days after it is believed (a clock is off by
  hours or a day). When the ten minutes are over only the newest refused day is asked again, and the days stay closed while it is on its
  way (no flicker); answered, the days from it on open, and the ones before it are asked in turn. A refusal not believed (a day far inside
  the free week: the server's fault) waits ten minutes too.
- **Not on sale.** While `config.ts` holds no token, the page closes no day by itself and hatches nothing until the gate refuses a day: it
  asks for every day, a member's (a key given as a gift) with the pass on every day before the real boundary, as on sale. Without a pass
  the days before the boundary go newest first, and the older ones only once it was served (or answered with a 404): a gate that refuses
  them meets one request. A refusal of any day before the boundary is believed, closes it and the days before it, and is held the usual
  ten minutes. The Plus page still
  takes a key.
- **The Range summary** counts nothing of the closed stretch and calls it part of Plus, not a time without a snapshot.
- **The Plus page's window rule.** `public/_headers` gives `plus/` `Cross-Origin-Opener-Policy: same-origin-allow-popups` (every other
  page: `same-origin`), since a payment method's window has to answer the checkout that opened it. Not yet proved on the live site:
  make a sandbox purchase with PayPal there before selling.

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
