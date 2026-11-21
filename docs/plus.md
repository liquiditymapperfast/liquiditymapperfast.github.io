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
| The levels of HyperTracker's +PnL traders, live and in the history: their liquidations (`/v1/plus/btc/liquidations-groups.json`, `liquidation-history-groups/<day>.json`), their stops and take profits (`triggers-groups.json`, `trigger-history-groups/<day>.json`, `trigger-history-groups-4h.json`) | Plus |
| Stop and take-profit levels, live and in the history (`/v1/plus/btc/triggers.json`, `trigger-history/<day>.json`) | Plus |
| The four-hour rollups a Depth view wider than 120 days reads (`/v1/plus/btc/*-4h.json`) | Plus |

Every path under `/v1/plus/` is paid, whatever the day.

## What the levels show (one choice for the page)

`LiqLevelSettings` (`src/app/liq-url.ts`, saved) holds three switches, `liq`, `stops` and `takes` (at least one on), and `group` (`all`,
`profitable`), the group of every kind. A save in the older form (`kind`: `liq`, `stops`, `both`, with `takes`) reads as those switches; a
switch present but not a boolean, or anything else, reads as the free view, and any other `group` value as `all`. The free view is
liquidations of all traders without take profits; anything else is Plus. Without Plus the page draws the free view and keeps the choice,
which comes back with Plus (`effectiveView` in `src/app/liq-view.ts`).

- **Where it is chosen**: the Levels control (`src/app/levels-control.ts`), one component in three places: a popover under the button at
  the top of the map's liquidation column (the button names what the curve adds up), a bottom sheet on a phone (under 768 px; the title of
  the Liq tab opens it too), and the Liq levels panel; the Depth pane's Source offers Order book or Levels, with a button that opens the
  same control. Three switches (one always stays on) and Traders (radios). Without Plus the paid choices carry a lock: pressing one opens
  the presentation (below) and changes nothing. The control reads and writes through a small model (`LevelsModel`: the page's settings and
  membership, or the demo's own store). The stripe, the column, the Liq tab and the Depth pane's levels follow the choice, and the Range
  summary says which kinds and group it sums.
- **The curve** adds up the liquidations and the stops that are on. *Liq + stops* adds them bin by bin (`sumLevels`); each part is taken
  away by price from its own snapshot (`combineTaken`: the orders' snapshot is often an earlier one). Stops come about one snapshot in two,
  so in the history a snapshot is drawn for both only when it has both parts (joined by `createdAt`; the rollups by their four-hour block),
  about one an hour.
- **Take profits** close longs with sells above the price and shorts with buys below it, the other way round from liquidations and stops,
  so they are held with their sides swapped and never added to the rest. One look everywhere, dashed strokes (`TAKE_DASH` in
  `liq-levels.ts`): beside the others a lane of their own by the live edge (`stripeLanes`: the levels' lane is the one beside the
  liquidation column, whose curve sums them), bars from the column's right edge, bars on the Liq tab, a line in the Depth pane; on alone
  they are the curve, dashed and never filled. Coloured by what they do: sells in the falling colour. The take profits' lane carries a
  caption ("Take profits"); while take profits show beside the curve, a note under the column's button says they are not in it.
- **The +PnL traders** are one group for every kind: the wallets in HyperTracker's four cohorts with a positive
  all-time perp profit. Their liquidations come from the groups files, their stops and take profits from `triggers-groups.json` and the
  group history files only, never everyone's under their name. A 404 or 503 for those says they are **not available yet** (the note
  under the legend, the column, the boxes, the Liq tab, the Depth pane and the Range summary), asked again after the server's
  `Retry-After` or five minutes; the +PnL traders' liquidations stay drawn alone meanwhile. Every drawing's cache is keyed by its
  layer and order family. The page reads that group alone from the files and leaves whatever else they hold unread.
- **Split** (`LiqLevelSettings.split`: `none`, `kinds`, `groups`; Plus) draws the liquidation column as two sub-columns (`liq-split.ts`,
  `splitPair` in `liq-view.ts`): `kinds` liquidations beside stops of the chosen traders on one shared scale (it turns both kinds on);
  `groups` everyone's chosen kinds beside the +PnL traders', each on its own scale, Traders hidden and never written. A kind a split
  needs switched off keeps the saved split (owner's rule, 2026-11-20; until then every write returned it to `none`): it is drawn as none
  (`splitFor`, the precedent of a map too narrow to split), the levels control keeps it chosen and says what brings it back
  (`keptSplitNote`), with Traders back where the column is drawn as one, and the split is drawn again once the kind is on. The source keeps the right column's view beside the one series and asks both columns'
  files together, whatever the room (`ensure(coin, onChange, view, right)`; the map and the Liq tab ask through `liveAsk`). The map widens the
  column to 2 x 100 px only where the plot keeps `MAP_PLOT_FLOOR` (`liqColumnWidth`, the same rule for `gutterAt`), never on a compact map;
  with less room it draws the fallback (`narrowView`: the two added up, or everyone's) and says "Too narrow to split". The stripe gives each
  column a lane (`stripePlan`, `splitLanes` in `liq-split.ts`): `kinds` wherever it is chosen; `groups` where the column is drawn split or,
  on a desktop map, switched off (`stripeSplitRoom`), else everyone's alone (too narrow, a compact map). The two group lanes each take their
  own colour scale, their captions say kind and group ("Liq + stops · +PnL") and the stripe's box names the group. The +PnL
  traders' lane draws the source's right set alone, its rows kept by that set's key (view, group and order family), and stands on its own
  readiness as their sub-column does; with their orders absent it draws their liquidations alone and the note under the legend says they
  are not available yet. Beside the two group lanes the note is composed from both sets (`stripeNote`, `groupNoteParts`): everyone's note
  with its "as of" named ("All traders: stops as of 14:00"), or everyone's reason, named, where their lane draws nothing; then the +PnL
  traders' positions and stops times wherever they differ from what everyone's part says or their stops are old, or the reason their lane
  draws nothing, each named ("+PnL traders: stops as of 11:00", `ofGroup`). Where both groups' times agree it reads as before. The note
  takes up to four lines of whole phrases (`noteLines`), never down to the volume strip's names: on a short map (a phone held sideways, a
  138 px plot) it takes fewer lines, one at least, and where even that one reaches them the strip leaves the name under it out (`layNote`,
  `StripDraw.clear`). The stripe's captions keep clear of it. The stripe is painted by `paintStripe`
  (`liq-stripe.ts`), which reports what it painted: a lane is given only where
  it can be painted (`LANE_MIN_W`, 2 px: on a thin stripe the take profits' lane narrows, then goes), and only painted lanes are captioned or
  answer the pointer. Every sub-column is captioned; the take profits stay with the left set. The caption plates keep clear of the map's
  corner buttons (whichever it shows: the desktop's row, or a phone's Draw key, `cornerSpan`), the legend, both notes, the volume strip's
  names and each other: in the rows they always stood in where those are clear, else each at the highest free place (a phone held
  sideways; `captionKeepOut`, `placeCaptions`), never past the plot's foot: where one has no room the split's lanes keep theirs and the
  take profits' plate is left out (its lane still answers the pointer). They are painted after the map's lines and bars, so none runs
  across them. The
  phone's Liq tab splits into halves at 2 x 120 px; a finger there reads both halves in a box each, placed together (`placeProbeBoxes`),
  titled with its group under Everyone | +PnL ("Long liquidations and stops · +PnL"), and saying less where the ladder is too
  short for the two whole (`probeDetail`: first without the count, the largest and the other side, then the distance, then the level; a total
  of both keeps its parts). Everything else that draws one series draws the left column's set (`effectiveView`), except the Depth pane:
  Split is the column's and the stripe's choice, never the Depth pane's, which draws the choice as with Split None (`depthView`, owner's rule
  of 2026-11-20): Liquidations | Stops as *Liq + stops* of the chosen traders, and Everyone | +PnL as everyone's levels (the saved
  Traders value is not drawn, nor written). Its bands, header, table, Range summary and levels button all follow it; its tip says the
  Everyone | +PnL case. The Depth plot shares the map's time axis, so a split that widens the column narrows it by the same pixels.
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
  - `pass.ts`: the membership as the browser holds it (`{ key, pass, until, ended, why, renews, skew, next }`): in the Plus database where
    it opens, mirrored to `localStorage` `lmf.plus` / `lmf.plus.gen`, else in `localStorage` alone (below), and its renewal.
  - `plus-db.ts`: the Plus database (IndexedDB `lmf-plus`, store `kv`: `seed`, `member`, `paid:<txn>`, `migrated`) and the gate that
    builds every request that issues a key; `schedule.ts`: when a payment's key is asked for; `request-timeout.ts`: a request given up
    after 20 s in every browser.
  - `panel.ts`: the Plus button's status pop-up (a browser with a key) and the locks' way in (`togglePlus`), which open the presentation.
  - `key.ts`, `key.css`: a key entered in the app (the pop-up, the presentation's access card) or on the Plus page: the renewal call, what
    its answer means, the form and its styles (one file the app and the page both load).
  - `sheet-entry.ts` (what the page fetches on demand: the styles, the demo and `sheet.ts`), `sheet.ts`, `sheet.css`: the presentation
    sheet; `present.ts` and `present.css`: the parts the Plus page shares (the hero, the feature sections, what stays free).
  - `demo/`: the demo (made-up numbers labelled as such, its own store, never the page's settings); `demo-levels.ts` puts the page's own
    levels control on the demo's store.
  - `page.ts`, `index.html`, `page.css`, `boot.ts`: the Plus page (`plus/`), the only page with the checkout or another site's script;
    `page-flow.ts`: a payment's setting-up and the restore by receipt, taken like a key (below), what settles a payment, and the page's
    Reveal and thanks rules; `paid.ts`: the payments waiting here (`paid:<txn>` in the Plus database, below).
  - `liq-history.ts` asks for a paid day only with a pass (`LiqAccess`), and for the Plus families (groups, orders, rollups) only with
    one; `panes/lower-panes.ts` draws the closed stretch and its lock.
  - `liq-view.ts` (the choice and the view drawn), `levels-control.ts` (the Levels control), `liq-words.ts` (the words by kind).

## The presentation, and the key in the app

- **The Plus button** (the toolbar's, a tile of a phone's Settings): a browser without a key opens the presentation; one with a key, a
  small status pop-up: on, "Plus is on in this browser, until <date>.", the key masked (Reveal holds for the key it was pressed for; Copy,
  or the key shown selected where the browser gives no clipboard), Replace key, and Remove from this browser, which asks first and says it
  does not cancel a subscription; ended, when it ended, that everything free stays, and a key field; being checked, the check, or once a
  renewal could not reach the server "Couldn't verify Plus" with Try again. "See what Plus adds" opens the presentation. The keyboard goes
  into the pop-up as it opens and back to the button as it closes; its key form is kept through every redraw.
- **The presentation** is a native `<dialog>` shown open (the page's sign of a dialog on top, which the other sheets, panels and
  shortcuts leave their keys to), 880 px wide at most and 90 % of the window's height, the whole screen under 640 px; the page behind it
  is inert, Tab stays inside, Escape and Close give the focus back to what opened it (else to the toolbar's Plus button). It holds the
  hero, the demo (mounted once the sheet has opened, destroyed as it closes), the three feature sections, the access card (gift keys: the
  key form; once on sale: Subscribe to `https://liquiditymapper.com/plus/`, the one place Paddle's checkout runs, and "Have a key?"; a
  member: until when), what stays free, and the site's terms, privacy and refunds pages. The Plus page opens on the same hero, demo and
  sections, above its key management and restore. While Plus is on sale its buy row is in the hero (Karl, 2026-11-20: one click to the
  checkout): one thin row with the price button ("Get Plus $10 a month", `plus-monthly`, opening the checkout at once), the tax line and
  Paddle's Merchant-of-Record line right under it, and in its place a waiting payment's note and "Set up Plus", or the words of a tab or
  browser that cannot buy (`page-flow.ts` `topRow`); nothing is sold further down. While it is not on sale the hero keeps "Gift keys only
  today" and "Activate a key", and the "Not on sale yet" section stays under it.
- **A key entered in the app** or on the Plus page goes to the renewal (`POST /v1/pass/renew`), in the same masked field with Reveal (the
  page's key box is the app's form, kept through the page's redraws and fresh each time the box comes back).
  Its grant is taken only for the membership it was sent under (`Plus.capture` when it is sent, `Plus.acceptIf` when the grant comes), so a
  removal or another tab's key meanwhile wins; a form given up aborts its request and drops the answer. Try again reads what is kept first
  and gives up when the key changed elsewhere. A key is entered once on each browser and address (the membership is kept per origin). The
  Plus page takes a payment's key and a membership found by the receipt the same way (below). The page's Reveal, and the showing after a
  checkout or a restore, hold for that key only, and so do the thanks after a checkout (`besideMembership`), beside which a payment still
  waiting stays in sight.

## The checkout's recovery (2026-11-20, Option B)

The design and its reviews are in HyperLiquidMap_Plus `docs/checkout-recovery-2026-11-20/` (`page-build-spec.md` is what was built). In
short:

- **One seed per browser.** The Plus database holds a seed, 32 random bytes made once (`plus-db.ts` `readSeed`), sent with every
  `/v1/pass` and `/v1/restore`. The Worker names the key by it (`<sub>.<HMAC(seed, sub)>`), so every request from this browser for one
  subscription gives the same key: two tabs, a press during another tab's setting-up, a lost answer, a late request and a receipt all end
  with it, and that key renews. The seed is never shown, never in a URL, a log, the hand-over or a backup.
- **The modes.** Every tab with IndexedDB starts by opening the database (3 s). Once it opens, the browser moves to it for good: the marker
  `lmf.plus.idb` first, then a one-time import of `lmf.plus` / `lmf.plus.gen`. In IDB mode the database is the authority and every write is
  one transaction (`Plus` commit) that checks the stored baseline `{ seed, gen }` the operation began with (a reset makes a new seed, so an
  answer from before it is never taken) and the tab's revision; `localStorage` is a mirror for synchronous reads and other tabs. Without
  IndexedDB, or when it refuses to open and no marker is set, the membership stays in `localStorage` as before (plain mode). A tab with the
  marker whose database is not open yet or will not open reads the mirror, renews in memory, and takes no key. A tab without the marker
  whose open has not answered after its 3 s stays opening (the controls disabled, no message) and renews the key it shows in memory only,
  so an open that never answers does not stop a member's renewals; a late open adopts the stored membership and stores that pass. A tab
  enters IDB mode only after it has read the stored membership (three tries, else unusable here, showing the mirror until a reload).
- **Who may issue.** Only a tab in IDB mode with the seed read issues: the prices, the checkout (opened only after a seed read), a payment's
  "Set up Plus" and the receipt form. Plain mode says "Plus cannot be bought in this browser. Use another browser; a key bought elsewhere
  works here." in the place of the prices; a tab not ready or unusable here says "Plus cannot be set up in this tab. Reload the page, or use
  another tab." The not-on-sale page is the same in every mode. The bodies of `/v1/pass` and `/v1/restore` are built only by the gate in
  `plus-db.ts`, from the seed read in a transaction (a source test pins it). Every operation that may write the membership (a key, a
  receipt, a payment's grant, Remove) begins with one readwrite transaction that makes the seed if there is none, so each has an epoch; a
  request whose seed differs from the one its operation began with sends nothing. (A browser whose storage is full and that has no seed yet
  therefore refuses key entry in IDB mode with the "cannot be set up in this tab" text.)
- **Nothing of Plus travels.** A hand-over from the old address and a backup never write an `lmf.plus*` key: they are skipped, and the rest
  of the visitor's settings are taken (the old address's page deployed before 2026-11-20 still sends them).
- **A payment's record** (`paid:<txn>` = `{ at }`) is written once when its checkout completes and waits from a day before that time to a
  day after it. Nothing asks for it by itself: loading the page shows it with "Set up Plus" (Try again after this tab's own attempt ended
  without Plus). Before every ask one transaction reads the seed and confirms the record still waits. The asks follow `schedule.ts`: backoff
  3, 4, 6, 9, 13, 20, then 30 s, never sooner than a `Retry-After`, 90 s on the monotonic clock (plus a 10-minute wall-clock guard), at
  most 8; a server wait past the deadline becomes the tab's cooldown. The grant settles its record in the commit's own transaction; a key or
  a receipt's membership settles the records that existed when it began. A record the browser refuses to store stays in the tab, bound to
  the seed read when its checkout opened, and is dropped once the seed differs.
- **A membership this tab could not store** (the commit failed) is held for as long as the tab lives: the key shows with "This browser would
  not keep Plus ...", and for a failure other than a full storage also "Plus could not be saved in this browser just now." with Try again,
  which stores it without a request. Another tab's commit drops it.
- **The receipt** shows while Plus is on sale or `PLUS_RESTORE` (`config.ts`) says so, and its refusal is hedged: "... A payment from the
  last few minutes may not show yet." Set `PLUS_RESTORE` to true when the sale opens (a test fails otherwise).
- **Accepted residual:** a key entered or removed in a tab of the previous build during the switch-over is undone as soon as a new-build tab
  repairs the mirror (the old tab's own reload then adopts the repaired mirror); the member enters the key again in a reloaded tab. The
  update notice offers Reload. A later pass an old tab renewed for the same key is adopted into the database while a new-build tab is open
  to hear it. After a rollback to the previous build, its renewals live in `localStorage` only; when this build returns, the database's
  membership stands, the mirror is written again from it, and one renewal follows if its pass is near its end (checked in Chrome,
  2026-11-20).

## How the page behaves

- **Renewal.** A pass with under six hours left is renewed with the key, at most about once a minute per tab (`next`, kept beside the
  membership, is the wait; tabs share it when they see each other's storage); after a refusal, or a pass that came already near its end
  (the last hours of a membership), the wait is an hour. A server's `Retry-After` is used between one minute and one hour, where the
  server exposes it to the page. In IDB mode the minute is reserved in a transaction before a renewal goes, so all tabs together renew
  about once a minute; a tab whose reservation write fails (a full storage) still renews on its own wait in memory, at most once a minute
  by itself, so Plus does not go off because the browser will not write. Try again clears the wait, the tab's own included.
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
   empty the pages say that Plus is not on sale yet; the Plus page still writes the monthly price (`monthly.usd`, $10 since
   2026-11-20) so Paddle's site review sees what Plus costs, and that price must match the one created in Paddle.
3. The three legal pages (`src/app/public/terms/`, `privacy/`, `refunds/`) name the seller and the contact address
   (`support@liquiditymapper.com`, forwarded by Cloudflare Email Routing); the Plus page's footer names the same address
   (`PLUS_CONTACT`). The prices on the Plus page and in Paddle must say the same.
4. The refund policy (since 2026-11-20, matching Paddle's own buyer terms) refunds any payment, the first or a renewal, in
   full within 14 days, and says a refund ends the subscription. The Plus server does not act on refunds (HyperLiquidMap_Plus
   README, "Refunds and chargebacks"), so a refund is done in Paddle together with cancelling that subscription there.

## Testing without the real services

- `?levels=http://127.0.0.1:<port>/v1/btc/liquidations.json` and `?plus=http://127.0.0.1:<port>/v1` point the page at local
  stand-ins (localhost only).
- The Plus page works on the dev server (`npm run dev:client`, `http://localhost:5173/plus/`) and in the built site
  (`npm run build:site`, then `npm run preview:site`).
- `tests/app-plus.test.mts` covers the pass and its renewal (plain mode); `tests/app-plus-db.test.mts` the Plus database and the
  membership on it; `tests/app-plus-checkout-recovery.test.mts` the payment's setting-up, the receipt and the source rules, against a
  stand-in for the Worker (`tests/plus-server-double.mts`), an in-memory IndexedDB (`tests/plus-db-fake.mts`) and tabs over it
  (`tests/plus-browser-double.mts`); `tests/app-plus-schedule.test.mts` the asking schedule; `tests/app-liq-history.test.mts` what is asked
  for with and without one;
  `tests/app-liq-plus.test.mts` the choice, its files and the groups; `tests/app-plus-popup.test.mts`, `app-plus-review.test.mts`,
  `app-plus-sheet.test.mts`, `app-plus-sheet-review.test.mts`, `app-plus-demo-control.test.mts` and `app-plus-page.test.mts` the pop-up,
  key entry, the presentation and the Plus page (`tests/fake-dom.mts` is the small page they run on).
