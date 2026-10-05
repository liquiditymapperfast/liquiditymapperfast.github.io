# LiquidityMapperFast

A local market-map workbench for one asset across many venues: a liquidity heatmap built from recorded order-book depth, a price profile, an aggregated order-book ladder, depth and open-interest panes, and a footprint of executed volume. The look follows the reference screenshots in `example_images/` (a local folder, not in git); a right-hand profile column and an OI row complete it.

The default venues are the largest ones whose public order book is also deep, fresh and reliable: Binance, Bybit, OKX, Bitget, Hyperliquid and Deribit perpetuals, plus Coinbase and Binance spot (`docs/deslop/venue-defaults-2026-10-05.md` has the measurements and the rule; Gate.io and MEXC are big by volume but publish only a few levels). The Venues picker offers 26 (the 20 feed venues plus Binance spot, Binance US, HitBTC, Poloniex, BitMart and Bitunix, which run on small self-contained connectors) and up to 32 feed venues can be enabled; its Recommended button ticks the default set, and nothing changes until Apply. The choice is saved beside the history database (`v2-feed-venues.json` for the feed venues, `v2-venues.json` for the connector venues) and restored when the server restarts, so an existing install keeps its venues until Recommended is applied; on the first run the recommended venues are selected (`HLM_DEFAULT_VENUES=all` selects every supported venue and starts every connector, `HLM_DEFAULT_VENUES=configured` keeps the venues set by the `*_ENABLED` flags and starts no connector venue instead). A fresh start needs about 30 s before market metadata allows the selection to apply. Everything runs locally against public exchange feeds; nothing is placed, hosted or sent anywhere. Optional HyperTracker credentials stay on the server.

## Run

```powershell
cd C:\dev\Python\Hivemind\Hivemind\HyperLiquidMap
npm install
npm run dev          # build + live public feeds on http://127.0.0.1:8787
npm run dev:fixture  # offline demo feeds
```

`PORT`, `HISTORY_DB` (SQLite; the depth recorder writes `depth-v2.sqlite` beside it) and `QUOTA_FILE` choose where state lives. To try a change without disturbing a running instance, start a second server on another `PORT` with its own `HISTORY_DB`. The server answers only requests addressed to `localhost` or an IP address and, for a browser, only from its own page, so another website you visit cannot drive it (`HLM_ALLOWED_HOSTS=name1,name2` adds public names for a deliberate deployment; `docs/deployment.md` covers going public, GitHub Pages and what can be protected). `HLM_SOURCEMAP=off` leaves source maps out of a published build.

`npm test` builds and runs the Node suite, `npm run typecheck` runs the three strict TypeScript projects, `npm run test:wasm` runs the Rust kernel tests, and `npm run build:wasm` regenerates the committed WASM glue (needs `wasm32-unknown-unknown` and `wasm-bindgen-cli` 0.2.129).

## Using it

| Gesture | Effect |
| --- | --- |
| Wheel | Zoom the price axis about the pointer |
| Shift + wheel | Zoom the time axis about the pointer |
| Drag / Shift+drag | Pan both axes / time only |
| Double-click, `R`, `Home`, Recenter | Return to the live edge |
| Right-drag | Right / up zoom the time / price axis in; left / down zoom out |
| Order book: wheel, drag the price column, drag the book, double-click | The wheel zooms the book about the pointer by changing the price step per row (the Group select follows; Auto shows the step it is using); dragging the price column up zooms in and down zooms out; dragging the book moves it; double-click returns to Auto and the mark. Shift + wheel still scrolls Single mode sideways |
| Splitters, pane grips | Resize the order-book column and the lower panes; drag a pane's grip to reorder; sizes persist |
| Hover (profile column or order book) | Mirror: the band from the mark to the pointer and the equally wide band on the other side are framed with border lines in each side's colour and labelled with their cumulative size and distance, the rest dims, and a box says what each band holds and which side has more ("Opposite side has 1.13x more"); move outward to watch the balance change. In Single mode the order book compares within the hovered venue's book. The chart itself shows no comparison. Toggle with Mirror |
| Hover | Shared time cursor across chart, depth and OI; price and liquidity readout on the chart |

The toolbar selects the market, timeframe (1m–1d), layer (Liquidity, Liquidation, Stop loss, Take profit), heatmap source (aggregated or one venue), Spot / Perp / Both, per-venue visibility chips, heatmap colour (Size ramp or two-hue Sides style, a legend showing the USD range with one Contrast slider, Auto, Smooth auto / off), the Profile / Depth / OI / Candles / Footprint / LT / Mirror / Volume / Trades toggles, Highlights, Sound and the theme menu (hover a theme to preview it, click to keep it). The ladder offers Aggregated, Single and Compact modes, a grouping step and Levels / Cumulative / both. Liquidation, stop-loss and take-profit layers come from HyperTracker; without credentials they are labelled mock data.

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
- **Contrast** is one slider: it slides the colour window along the size axis (right shows thinner liquidity, left keeps only the biggest walls; double-click resets). The window comes from the 15th and 96th percentiles of the non-empty cells (Bookmap's auto-contrast defaults); in Auto it is recomputed on recentering, a market or venue change, a 2x zoom and every 10 s, so colours do not drift while you pan. Auto off freezes it.
- **LT row** (optional, toolbar toggle): LT-Bid and LT-Ask are the USD size on each side of the aggregated enabled venues, weighted by 2^(-d / half-life) with d the distance in basis points from that side's touch (Bookmap's exponentially decaying weights; basis points rather than ticks so venues with different tick sizes agree). Options: half-life, min / max bin size, per-level average, lines or imbalance view. It is computed in the raster worker from the recorded minute columns plus the live column, so changing a setting recomputes the whole visible history at once (`src/app/lt.ts`, unit-tested).

## Footprint

With the Footprint toggle on and the chart zoomed in, each candle slides to the left of its slot as a solid candle and the rows of executed volume appear to its right (design after the footprint screenshots in `example_images/`). A row prints sell volume (market sells hitting bids) then buy volume (buys lifting asks) in compact form (13.4M, 407.0k). A bar anchored at the column's left edge appears only where one side is at least 1.15 times the other; it is red for sellers and green for buyers and sized by the larger side against the largest in view. The heatmap dims behind it and the footprint fades in and out with zoom (thresholds in `FOOTPRINT_POLICY`). Below the chart the Bar stats strip prints per-candle statistics aligned to the candle slots (see below).

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

The Spot / Perp / Both control filters the enabled venues for the heatmap, profile, aggregated ladder, depth, LT and mirror. It never switches a venue on or off (chips that fall outside the filter are dimmed), it says so when it selects nothing, and executions (footprint, bubbles) are not filtered. Spot books show the walls that stand out far from the price; Binance spot (5000-level snapshot plus the diff stream) and Coinbase (full book) are the deep ones.

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
