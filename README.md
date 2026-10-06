# LiquidityMapperFast

**Open it: https://liquiditymapperfast.github.io/** — free, no sign-up, MIT licence. The **Guide** button inside explains everything in about ten minutes.

A market-map workbench for one asset across many venues. It runs entirely in the browser: the page reads the exchanges' public feeds itself, in a Web Worker, so it works from any static host (GitHub Pages included) with no server. A local server remains as an optional source with a week of recorded history. The workbench draws a liquidity heatmap built from recorded order-book depth, a price profile, an aggregated order-book ladder, depth and open-interest panes, and a footprint of executed volume. The look follows the reference screenshots in `example_images/` (a local folder, not in git); a right-hand profile column and an OI row complete it.

The default venues are the largest ones whose public order book is also deep, fresh and reliable: Binance, Bybit, OKX, Bitget, Hyperliquid and Deribit perpetuals, plus Coinbase and Binance spot (`docs/deslop/venue-defaults-2026-10-05.md` has the measurements and the rule; Gate.io and MEXC are big by volume but publish only a few levels). **In the browser** the Venues picker offers exactly these eight (each has a connector in `src/shared/venues.ts`) and the choice is kept in this browser's localStorage. **With the local server** the picker offers 26 (the 20 feed venues plus Binance spot, Binance US, HitBTC, Poloniex, BitMart and Bitunix, which run on small self-contained connectors) and up to 32 feed venues can be enabled; its Recommended button ticks the default set, and nothing changes until Apply. The choice is saved beside the history database (`v2-feed-venues.json` for the feed venues, `v2-venues.json` for the connector venues) and restored when the server restarts, so an existing install keeps its venues until Recommended is applied; on the first run the recommended venues are selected (`HLM_DEFAULT_VENUES=all` selects every supported venue and starts every connector, `HLM_DEFAULT_VENUES=configured` keeps the venues set by the `*_ENABLED` flags and starts no connector venue instead). A fresh start needs about 30 s before market metadata allows the selection to apply. Everything reads public exchange feeds from your own machine (the browser, or the local server); no order is placed and nothing is sent to any service of ours. Optional HyperTracker credentials stay on the server, which is why those layers are listed as upcoming in the browser-only page.

## Run

```powershell
cd C:\dev\Python\Hivemind\Hivemind\HyperLiquidMap
npm install
npm run dev:client   # the page alone, reading the exchanges from your browser: http://localhost:5173
npm run build:site   # typecheck + the static site in dist/ (HLM_SOURCEMAP=off leaves out source maps)
npm run preview:site # serve dist/ to look at it
npm run dev          # build + local server with a week of recorded history on http://127.0.0.1:8787
npm run dev:fixture  # the server with offline demo feeds
```

**Which source the page uses.** A static host has no server behind it, so the page reads the exchanges itself (`src/app/browser-source.ts`, the engine in `src/shared/engine.ts` running in `src/app/browser/feeds.worker.ts`). Served by the local server, the page finds `api/v2/state` on its own origin and uses the server instead, with its recorded history. `?source=browser` or `?source=server` forces one; `?persist=0` stops a browser session from keeping recordings. The browser keeps the last 24 hours of recorded depth, executions and large trades in IndexedDB, written by one tab at a time (a Web Lock), and the heatmap marks where its recording begins: a page can only record while it is open. See `docs/deployment.md` for publishing.

`PORT`, `HISTORY_DB` (SQLite; the depth recorder writes `depth-v2.sqlite` beside it) and `QUOTA_FILE` choose where state lives. To try a change without disturbing a running instance, start a second server on another `PORT` with its own `HISTORY_DB`. The server answers only requests addressed to `localhost` or an IP address and, for a browser, only from its own page, so another website you visit cannot drive it (`HLM_ALLOWED_HOSTS=name1,name2` adds public names for a deliberate deployment; `docs/deployment.md` covers going public, GitHub Pages and what can be protected). `HLM_SOURCEMAP=off` leaves source maps out of a published build.

`npm test` builds and runs the Node suite, `npm run typecheck` runs the three strict TypeScript projects, `npm run test:wasm` runs the Rust kernel tests, and `npm run build:wasm` regenerates the committed WASM glue (needs `wasm32-unknown-unknown` and `wasm-bindgen-cli` 0.2.129).

## Using it

| Gesture | Effect |
| --- | --- |
| Wheel | Zoom the price axis about the current price while the map follows the market (so it swells and shrinks around the price instead of sliding); Alt + wheel zooms about the pointer, and so does the wheel on a map you have moved by hand |
| Shift + wheel | Zoom the time axis about the pointer |
| Drag / Shift+drag | Pan both axes / time only |
| Double-click, `R`, `Home`, Recenter | Return to the live edge |
| Right-drag | Right / up zoom the time / price axis in; left / down zoom out |
| Order book: wheel, drag the price column, drag the book, double-click | The wheel zooms the book about the current price (Alt + wheel, or a book you have scrolled off the price, zooms about the pointer) by changing the price step per row (the Group select follows; Auto shows the step it is using); dragging the price column up zooms in and down zooms out; dragging the book moves it; double-click returns to Auto and the mark. Shift + wheel still scrolls Single mode sideways |
| Splitters, pane grips | Resize the order-book column and the lower panes; drag a pane's grip to reorder; sizes persist |
| Hover (profile column or order book) | Mirror: the band from the mark to the pointer and the equally wide band on the other side are framed with border lines in each side's colour and labelled with their cumulative size and distance, the rest dims, and a box says what each band holds and which side has more ("Opposite side has 1.13x more"); move outward to watch the balance change. In Single mode the order book compares within the hovered venue's book. The chart itself shows no comparison. Toggle with Mirror |
| Hover | Shared time cursor across chart, depth and OI; price and liquidity readout on the chart |
| Hover (order-book cell or bar) | A box says that venue's size, its share of the level, its rank at the price and its distance from the mark; over the USD column or a plain bar it says the whole level with the venues behind it. The Mirror's box steps aside while the pointer is directly on one (its band stays) and returns anywhere else |
| Hover (footprint row) | The row is boxed and a card gives its price span, what was sold and bought, the delta, which side was heavier and by how much, its share of the candle, whether it is the point of control, and the candle's own volume and delta (a trade bubble or a trapped-traders pop-up takes precedence) |
| Hover (bar-stats cell) | The cell is boxed and its candle's column and its row are tinted; a card says the statistic, the candle, the value, the candle before, where it ranks among the candles in view, whether it was flagged unusual, and what the statistic means |

The toolbar selects the market, timeframe (1m–1d), layer (Liquidity, Liquidation, Stop loss, Take profit), heatmap source (aggregated or one venue), Spot / Perp / Both, per-venue visibility chips, heatmap colour (Size ramp or two-hue Sides style, a legend showing the USD range with one Contrast slider, Auto, Smooth auto / off), the Profile / Depth / OI / Candles / Footprint / LT / Mirror / Volume / Trades toggles, Highlights, Sound and the theme menu (hover a theme to preview it, click to keep it). The ladder offers Aggregated, Single and Compact modes, a grouping step and Levels / Cumulative / both. The Liquidation, Stop loss and Take profit layers are listed as upcoming (disabled): they need HyperTracker data, which a static page cannot hold a key for.

A venue that never connects, keeps failing and fails a plain request while others work is shown as unavailable from the visitor's location: a dashed chip, a dismissible banner and a status in the Venues dialog say that a VPN set to another country may enable it.

The chips are the venues that have a book on the map. A venue that was chosen but has none gets a dashed chip of its own, so it never just disappears from the toolbar: a red-tinted one (warning mark) for a venue that is failing or, on a server, left off the map because its book is crossed (a feed fault: "book crossed by 123 bp"), a grey one (ellipsis) for one that has been connecting for more than 20 s. Hovering it says why. A server cannot push these changes, so the page asks it every 10 s.

**Help is built in.** Every control has a tooltip (`src/app/tip.ts`), and a **?** beside each pane explains it (`src/app/help.ts` holds the text both use). The **Guide** button opens a ten-minute tour with a contents list and moving pictures (`src/app/guide/`; an address like `#guide/mirror` opens it at a section). **Screenshot** (or `S`) freezes the page, lets you drag a region or click a pane, draw on it, pixelate or blur anything private, then copy or save a PNG (`src/app/screenshot/`; it draws the page itself, so nothing is asked of the browser). **Install** appears when the browser can install the page as an app, and **Author** says who made it.

On a young recording the empty left of the heatmap is filled with the current book in grey (darker grey for bigger walls) so the map reads from the first second; grey is never history, and real colour starts at the dashed line.

## Phones and tablets

The page is arranged for the screen it is on. `src/app/device.ts` decides once, never from the user agent, and puts two attributes on `<html>` that `src/app/mobile.css` reads:

| Attribute | Values | Meaning |
| --- | --- | --- |
| `data-layout` | `phone`, `phone-landscape`, `desktop` | How the panes are arranged. A window up to 640 px wide, or a touch screen held upright up to 900 px (a tablet in portrait), is `phone`; a touch screen held sideways and up to 520 px tall is `phone-landscape`; everything else, a tablet held sideways included, is `desktop` |
| `data-bar` | `compact`, `full` | How the controls are arranged. `compact` on every phone arrangement and on any touch-first screen |

- **Phone (portrait):** a two-row top bar (market, status and Settings above; timeframes and recentre below), the map, one pane at a time under it, and a tab bar (Map, Book, Depth, OI, LT, Stats; a tab exists while its switch is on in Settings). Tapping the open tab, or **Map**, gives the chart the whole screen. The handle between the map and the pane resizes it (remembered per tab and orientation; a double tap resets it). **Landscape:** one top row, the pane beside the map, the tabs as a rail along the edge. The panes are the same elements the desktop arranges as a column, so nothing is rebuilt when the tab changes (`src/app/dock.ts`), and a phone never writes the desktop's saved pane sizes.
- **Settings** (the **⋯** button) is a bottom sheet of labelled rows holding every control that does not fit the bar: the pane switches, the heatmap colours and contrast, the venues, Highlights, Sound, the theme, Keep screen on, and Guide, Screenshot, Author and Install. Panels and menus become bottom sheets with a scrim; a dropdown opens the page's own menu (`src/app/touch-select.ts`) in the chosen theme instead of the system's list, and nothing makes an iPhone zoom in.
- **Gestures** (`src/app/touch.ts` recognises them from pointer positions; the recogniser is pure and tested): drag pans and carries on after the lift; pinch zooms time with the horizontal separation of the fingers and price with the vertical one, about the midpoint, so what is under each finger stays under it; dragging along an axis zooms it; tap pins the crosshair and its readout above the finger (tap again, or drag, to let go); holding then dragging scrubs it; double-tap recentres. The panes under the map share the time axis, so a drag or pinch there moves the map's time; the order book scrolls, pinches to zoom its grouping, pins Mirror on a tap and resets on a double tap. Holding any control shows its tooltip without pressing it.
- **Screenshot** works by finger (larger handles, buttons that wrap, a Share button where the browser has a share sheet). **Keep screen on** uses the Screen Wake Lock API, because a sleeping screen stops the recording. **Install:** Chrome and Edge give a prompt; iPhone and iPad get an Add to Home Screen explanation.
- **Cost:** with the default eight venues the page receives about 47 to 74 KB/s of exchange data (165 to 260 MB an hour); on a 4x CPU slowdown the main thread uses about 13 % of a core with every frame on time (`docs/deslop/performance-2026-10-05.md`). The heatmap canvas is capped at 2 device pixels per CSS pixel on touch screens.
- **Testing:** the layouts are exercised in Chrome with a phone's size, touch events and device pixel ratio over CDP (`Emulation.setDeviceMetricsOverride` with `mobile: true`, `Input.dispatchTouchEvent`). That is Chrome, not Safari: the first real-device check is the published site over HTTPS (a LAN address over plain HTTP loses Web Locks and the clipboard).

## How it works

```
exchange feeds ─▶ LiveFeedManager ─▶ reducers (src/server/http.mts) ─▶ state
                                                                         │
                       ┌────────────────────────────────────────────────┤
                       ▼                                                ▼
        v2 recorder (src/server/v2)                          /api/v2/ws live levels
   minute columns on a shared price grid                      (binary, ~4 Hz) + ticks
   SQLite, 7-day window, footprint recorder                              │
                       │                                                 │
                       ▼                                                 ▼
          /api/v2/columns (binary) ─▶ raster worker + Rust/WASM ─▶ WebGL2 texture ─▶ chart
```

- **Valued levels** (`levels.mts`): every venue book is converted to USD (contract face value, quote conversion) with the price band each level represents; Hyperliquid's aggregated levels are lower-edge grid bands.
- **Depth recorder** (`recorder.mts`): every 5 s each fresh book is spread onto a shared 1-2-5 price grid (about 0.02 % of price) and averaged per minute; stale books leave gaps rather than being carried forward. Columns are sparse (only non-empty bins), bid and ask separate, persisted to SQLite and kept for seven days.
- **Kernels** (`crates/hlm-kernels`): `raster_columns` turns recorded columns into a price-by-time grid (price-conserving, averaged over observed time only); `spread_levels` groups live levels for the profile, ladder and the live edge of the heatmap. The same spreading exists in TypeScript on the server and a test checks the two agree.
- **Rendering**: the worker rasterises a window 20 % larger than the view; the shader samples it with a view-relative transform, so pan and zoom stay smooth on the old texture until the next raster arrives.

## Heatmap colour and the Liquidity Tracker

- **Size style** (default, after Bookmap): one sequential colour ramp encodes size on a log scale; bid or ask is implied by position relative to the mark. Cells below the window stay background. **Sides style** uses two hues by side on a linear window.
- **Contrast** is one slider (-100 to 100, 50 = the baseline): it slides the colour window along the size axis (right shows thinner liquidity, left keeps only the biggest walls, and the far left tones even those down, which is what many venues added together need, because their walls are huge; double-click resets). The window moves by up to three quarters of its own width to the right and 2.25 widths to the left (`src/app/heatmap/window.ts`). The window comes from the 15th and 96th percentiles of the non-empty cells (Bookmap's auto-contrast defaults); in Auto it is recomputed on recentering, a market or venue change, a 2x zoom and every 10 s, so colours do not drift while you pan. Auto off freezes it.
- **LT row** (optional, toolbar toggle): LT-Bid and LT-Ask are the USD size on each side of the aggregated enabled venues, weighted by 2^(-d / half-life) with d the distance in basis points from that side's touch (Bookmap's exponentially decaying weights; basis points rather than ticks so venues with different tick sizes agree). Options: half-life, min / max bin size, per-level average, lines or imbalance view. It is computed in the raster worker from the recorded minute columns plus the live column, so changing a setting recomputes the whole visible history at once (`src/app/lt.ts`, unit-tested).

## Footprint

With the Footprint toggle on and the chart zoomed in, each candle slides to the left of its slot as a solid candle and the rows of executed volume appear to its right (design after the footprint screenshots in `example_images/`). A row prints sell volume (market sells hitting bids) then buy volume (buys lifting asks) in compact form (13.4M, 407.0k). A bar anchored at the column's left edge appears only where one side is at least 1.15 times the other; it is red for sellers and green for buyers and sized by the larger side against the largest in view. The heatmap dims behind it and the footprint fades in and out with zoom (thresholds in `FOOTPRINT_POLICY`). Below the chart the Bar stats strip prints per-candle statistics aligned to the candle slots (see below).

### Possible trapped buyers and sellers

On a closed candle whose wick holds more net aggressive buying (or selling) than any equally tall stretch of the rest of the candle, and that then closed at least one ATR beyond the aggressors' average entry, the wick's imbalanced cells are outlined in amber and, for twelve candles, slowly pulse (still, not pulsing, with reduced motion or once price closes back through the entry). Hovering them says what was found and what is not known. It is a fact about the candle, labelled "possible": the pattern has not been tested as a predictor. It judges only settled candles whose footprint is complete, at a row step that does not change with the zoom, and needs the candles and footprint of the same market. `docs/trapped-traders.md` has the rule, the firing rates behind its defaults, the ways it can mislead and what a proper study would take.

### Bar stats

The strip shows volume, delta and cumulative delta by default. The **Stats** button in its header opens a panel to choose any of the following, reorder them by dragging a row by its dots (or focus the dots and press the up / down arrow keys), hide them with ×, or apply a preset (Default, All, None); the strip grows one row per statistic, and choice, order and options persist in the browser.

| Group | Statistics |
| --- | --- |
| Volume | vol, delta, cvd, delta %, buy vol, sell vol |
| Footprint rows | max buy, max sell, poc (point of control, the row with most volume), imb # (diagonal imbalances), stacked (runs of adjacent imbalanced rows) |
| Trades | trades, buys, sells, avg trade, delta retail, delta whales, cvd retail, cvd whales |
| Market | range (high − low), OI change |

Options: cell style (filled and shaded by magnitude on a log scale between the visible 2nd and 99th percentile, or text only coloured by sign), OI change in base coin or USD, imbalance ratio (default 3: a level counts when it is at least that many times the opposite volume one row away), minimum imbalance USD, stacked row count, and the retail/whale limits by trade-size bucket (0, 25k, 50k, 100k, 250k, 500k, 1M, 5M USD; retail up to bucket 2 and whales from bucket 5 by default).

cvd sums the bars loaded for the view. Trade counts and size buckets are recorded by the server from the moment this feature was installed, so earlier bars show `–` for the Trades group; like all executions they are recorded only while the server runs.

## What stands out

One rule decides it everywhere: a value stands out when it exceeds the mean plus *k* standard deviations of the bars before it (default k = 2, baseline 72 bars; the bar itself never raises its own threshold, and nothing is flagged until a dozen bars exist). The **Highlights** panel sets k, the baseline and a master switch for every pane at once.

- **Volume** is a histogram along the bottom of the chart (toggle Volume): ordinary bars are dim, unusual ones are at full strength with a cap, a dashed line shows the threshold, a faint column marks the bar's slot up the whole chart, and the candle gets a glowing ring. The header line says how many sigma above its baseline the hovered candle is.
- **Depth** puts asks above the centre line and bids below it, as on the chart and in the order book, and draws the side with more liquidity brighter and the other dimmer, in proportion to the imbalance, and the readout names it ("asks +3.2%").
- **Order book** shows which side dominates the same way: at each row the bids and asks within that distance of the mark are compared (cumulative, the same comparison as the depth map), and the row's bars are drawn stronger when its side holds more and fainter when the other does, in proportion to the imbalance. A slim bar under the header shows bids against asks within the visible range as shares of their sum. Both follow the Highlights switch, and the zoom (wheel, price column) changes the distance they are read over.
- **Open interest** is drawn as a level: a step line carried forward from each sample, a dashed continuation to the newest candle, dots at real samples, and below it the change between samples with unusually large changes at full strength. If the market has no OI history (only Binance and Hyperliquid report it) a reference perp's series stands in, labelled. It refreshes every 20 s and says how old the newest sample is.
- **Trades** (toggle Trades) puts bubbles on the chart at the time and price of each large trade (at least $25k), sized by notional, coloured by the side that took liquidity, only the biggest few hundred in view, with a glow for whale-size trades.

## Spot, perpetual or both

The Spot / Perp / Both control filters the enabled venues for the heatmap, profile, aggregated ladder, depth, LT and mirror. It never switches a venue on or off (chips that fall outside the filter are dimmed; a click on a dimmed chip shows that venue, which means the filter goes back to Both and the venue is switched on), it says so when it selects nothing, and executions (footprint, bubbles) are not filtered. Spot books show the walls that stand out far from the price; Binance spot (5000-level snapshot plus the diff stream) and Coinbase (full book) are the deep ones.

## Far liquidity

Zoomed out to a few percent either side of the price a heatmap has two problems: the venues' books have to reach that far, and thin walls become a pixel or less. Both are handled.

- **Reach.** Every book is merged into buckets that widen with distance from the mark (about 0.4 % of it): fine at the touch, then up to the recorder's grid step (always a whole-number divisor of it, so a bucket never straddles a recorded bin), then power-of-two multiples out to 16 steps, recorded in the bin of the bucket's farthest member. Levels beyond 50 % of the mark are dropped. This replaced a nearest-first cap of 2000 levels per side that stopped Coinbase's asks at +2.5 % while its sparse bids reached -20 %. `BOOK_LEVEL_LIMIT` (default 10,000) is the raw cap before merging.
- **Visibility.** Once price rows are under 15 px tall the raster is smoothed vertically with a Gaussian about 5 px wide (Bookmap's Auto rule; three box passes in the wasm kernel), so a thin wall becomes a visible band. Toolbar: Smooth auto / off.
- **Colour window** is taken from the visible raster only (15th and 96th percentiles of non-empty cells), so far walls are judged against the far book, not the dense touch.

Bookmap keeps the full depth of the book for every slice and smooths for display; here the recorder keeps distance-adaptive buckets and drops bins under $10k, which holds a week of history for all venues to about 0.5 GB (68 MB a day; most venues sit at a few thousand bytes per minute, the deepest at about 10 KB).

## Trades and sound

The server keeps every venue trade of $25k or more (deduplicated, SQLite, one week), broadcasts them as they arrive and serves them by time window. Sounds have their own **Sound** panel, not the bar stats: a sound is a live event, bar stats are retrospective aggregates.

- A sweep that fills on several venues within a quarter of a second is one event. Its size selects a tier (Signal $50k, Surge $150k, Whale $400k, Leviathan $1.5M; thresholds are editable and stay ascending above $25k) and it sounds only if that tier is on (Whale and Leviathan by default). Buys rise in pitch and sells fall; a higher tier adds notes (one to four) and loudness.
- One AudioContext with a compressor, at most eight voices (extra notes are dropped, not queued), scheduled on the audio clock. Browsers keep audio locked until a click or key press, so the button shows an amber dot until then. Trades that arrive more than 2.5 s late (a throttled background tab catching up) are ignored.
- Options: volume, which venues count (all / spot / perp), a Test button per tier and side, and an optional chime when a candle closes on unusual volume. There is no liquidation sound: the feeds carry no real liquidation events.
- The decisions are recorded in `window.__hlm.sounds.log` so they can be tested without listening.

## Themes

Light, Latte, Dark, Darker, Midnight, Mocha, Colour-blind safe and Terminal. Midnight follows Tokyo Night and Mocha / Latte follow Catppuccin; Colour-blind safe uses the Okabe-Ito blue and orange. A test enforces text contrast of 7:1, muted text 4.5:1 and 3:1 for accents and the buy / sell colours on both background and panel. Saved choices from earlier ids still resolve.

## Look

One window language across the page (`src/app/chrome.css`, loaded last): square corners, one crisp outline, raised controls lit from the top left and pressed ones the other way round, windows with a title bar and a hard shadow, the black-filled "on" state, and glyphs that are drawn rather than typed (the close crosses, the `?` marks, the language globe) so they sit in the middle of their box whatever the font. The tones are derived per theme in `src/app/theme.ts` (`chromeFor`, tested for edge visibility and text legibility) and `BEVEL` there dials the whole style back (0 is flat). Soft shadows, pill shapes and blur are not used: they cost the most to paint over canvases that repaint all the time.

## Languages

English, Spanish, German, French, Portuguese, Italian, Russian, Turkish, Chinese, Japanese and Korean, chosen from the browser's preference, `?lang=xx`, or the Language button. See `docs/languages.md` for how it works, why the browser's own translation is not enough, what is not translated and how to add one. The packs were written by an AI assistant and have not been reviewed by native speakers.

## Limits

- Venue books differ in how far from the mark they reach, which is what makes a venue look thin on the map, not the level count. Measured on BTC (October 2026, after distance merging): Coinbase about 35 % each side, Binance spot about 41 %, HitBTC, Phemex and Binance US up to the 50 % limit, Bitget about 75 bp, Bybit about 47 bp (it subscribes to `orderbook.1000`), Hyperliquid about 470 bp in 20 aggregated bands, and the venues that only publish a shallow book (MEXC, Crypto.com, HTX, Aster, KuCoin 1-4 bp; Gate.io, Bitfinex, OKX, Kraken 5-11 bp, Poloniex 13 bp; Bitstamp about 30-70 bp) stop within a few dozen basis points whatever the cap, because merging cannot recover depth a venue never sends. The ladder shades rows beyond a venue's reach in Single mode, and each venue chip's tooltip states its reach. BitMEX currently serves empty books to this connection.
- The Liquidity Tracker has no per-order data: its size filter applies to a venue's aggregated size at one price bin.
- The server is single-threaded: with 24 venues it needs roughly half a core (see `docs/deslop/baseline-2026-10-04.md`). If it saturates, heavy API calls time out and executions are missed, which shows up as gaps in the footprint. Feed sockets run without per-message compression for that reason, so they use more bandwidth.
- Depth history starts when the recorder first runs; nothing is back-filled. Footprint likewise records only trades seen while the server is running.
- Open interest history comes from the server's own samples plus public history where the venue offers it; the public history is five-minute resolution, the server's own samples are one-minute.
- The history store (candles and open interest) stops writing while its file is over its 224 MiB budget; the OI endpoint then serves live samples newer than the stored bars, but history stays short until the file is pruned.
- Far-liquidity history builds up over time: a zoomed-out spot view is only as deep as the hours recorded since the full-depth books were recorded.

## Performance and history of this codebase

The previous implementation spent most of its CPU on memory accounting (client frame time 133 ms under interaction, server 90 % busy in byte estimation, history responses rejected by a 761 MB estimate). The measurements, method and what replaced it are in [docs/deslop/baseline-2026-10-04.md](./docs/deslop/baseline-2026-10-04.md). Agent and contributor rules, including the Rust/WASM policy, are in [AGENTS.md](./AGENTS.md).

## Licence

MIT, see [LICENSE](./LICENSE). Free to use, change and share.
