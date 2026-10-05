# Putting it on the web

The page runs in two ways. **Browser-only** (the default on a static host): each visitor's browser connects to the exchanges' public feeds itself, so nothing needs hosting but the files. **With the local server**: the server holds the sockets, records a week of history to SQLite and serves the page. This note covers publishing the page (GitHub Pages), what changes if a server is made public, and what can and cannot be protected.

## Where it is published

The page is at **https://liquiditymapperfast.github.io/**, built and deployed by `.github/workflows/pages.yml` from `master` of github.com/liquiditymapperfast/liquiditymapperfast.github.io. Setting it up took four steps, all done once: create the repository under the account (a repository named `<account>.github.io` is served at the account's root), set Settings → Pages → Source to **GitHub Actions**, push `master` (the workflow runs on every push to it), and wait for the `Pages` run to finish. Commits are authored with the account's GitHub no-reply address, so no personal email is in the public history. Git Credential Manager remembers one GitHub login per host: pushing as a second account needs the remote written with that username (`https://<account>@github.com/...`) so it asks for that account's sign-in instead of reusing the other one.

## GitHub Pages: no server needed

GitHub Pages serves static files, and the page needs nothing else: `npm run build:site` writes `dist/` (one HTML file, two scripts, two workers' worth of code, one `.wasm`, one stylesheet) with relative URLs, so it works from the site root or from a project path such as `/<repository>/`. `.github/workflows/pages.yml` builds and deploys it once the repository is on GitHub and Pages is set to "GitHub Actions" (nothing runs before that, and nothing has been pushed). Pages serves it over HTTPS, which Web Locks need.

A server stays optional. If one is wanted anyway (a long recorded history for everyone, or the bandwidth-heavy local features), the recommended shape is:

| Piece | Where | Notes |
| --- | --- | --- |
| Page (`dist/`) | GitHub Pages, Cloudflare Pages or the same VPS | static, cacheable |
| Server | a small VPS of its own | TLS in front (Caddy or nginx), `wss://` |
| History | the server's disk | the recorder keeps a fixed window, so disk is bounded |

**Do not run it on the VPS that hosts the trading bots.** That machine holds exchange keys; a public market-data service on it widens what an attacker can reach for no gain. A separate VPS of the smallest class is enough for the data plane (measured: about 80 % of one core at 26 venues, 238 MB; the recommended eight venues need far less).

## Browser-only mode: implemented

Each visitor's browser connects to the exchanges itself, as aggr.trade does. Measured on 2026-10-05 from a headless Chrome page on a foreign origin (`http://127.0.0.1:<port>`, not github.io, which no exchange was seen to treat differently), 9 s per feed:

| Feed | Result |
| --- | --- |
| WebSocket depth: Binance spot and perpetual, Bybit `orderbook.1000`, OKX `books`, Bitget `books`, Coinbase `level2_batch`, Deribit `book`, Hyperliquid `l2Book` | all delivered data (first message in 0.9 to 1.8 s; 3 to 142 messages; Coinbase the heaviest at about 130 KB/s) |
| Hyperliquid trades | delivered |
| REST with CORS: Binance depth snapshots (spot, perpetual), klines, open-interest history; Bybit klines and open interest; OKX and Bitget candles; Coinbase book snapshot; Deribit order book; Hyperliquid `info` POST | all answered 200 and were readable from the page |

WebSockets are not subject to CORS, and these venues' public REST endpoints send CORS headers, with one exception found while building it: **Deribit's `get_tradingview_chart_data` sends none**, so its candles are read over Deribit's JSON-RPC WebSocket instead (the same method; `src/shared/history.ts`). A Pages-hosted client therefore needs no server, no bandwidth bill and no market-data licence of its own (each visitor consumes the feeds directly), and the request guard below does not apply.

How it is built:

- `src/shared/` holds the pure data plane both sources share: connectors (`connector.ts`, `venues.ts`), distance merge, the depth/footprint/print recorders with injectable stores, candle and open-interest history (`history.ts`) and the `Engine` (`engine.ts`) that ties them together. The server's `.mts` files wrap the same code with SQLite stores.
- `src/app/browser/feeds.worker.ts` hosts the engine on its own thread; `src/app/browser-source.ts` is the page's side of it behind the same `DataSource` interface the server source implements. `src/app/browser/idb.ts` keeps 24 hours of recordings in IndexedDB, written by the one tab holding the `lmf-recorder` Web Lock.
- `npm run parity -- [seconds] [port]` compares the browser connectors with a running server's books and executions venue by venue.

What it loses relative to the server:

- **Eight venues, not twenty-six.** Only the recommended set has a browser connector; the other connectors stay with the server.
- **History.** Candles and open interest come from the venues' REST endpoints at once (Binance has 30 days of open-interest history; Hyperliquid's open interest builds up from samples taken while the page is open). The heatmap, footprint and trade bubbles are built from what the tab has seen: they start empty and fill while the page is open, and IndexedDB keeps 24 hours between visits (a background tab records, but a throttled one may record with gaps). The heatmap draws a dashed line where recording began. A hosted recorder remains possible later as an optional history service.
- **A fresh book is shallow where the exchange's snapshot ends.** Binance's USD-M depth snapshot stops at 1000 levels, about $130 (0.16 %) from the touch at BTC's tick, and the stream only reveals a level farther out when it changes. A page that has just opened therefore has a thinner far book than a server that has been running for hours (measured 2026-10-05: within $100 of the best bid the exchange snapshot, the browser engine and the server agree to 0.2 %; at $200 the browser had 47.7M, the server 67.3M). It fills in as levels update, in either mode.
- **HyperTracker layers** (liquidation, stop loss, take profit) need a key that must stay secret, so the layer dropdown lists them as upcoming.
- **Countries.** Binance and some others refuse some countries. A venue that never connects, keeps failing and fails a plain REST request while others work is shown as unavailable from the visitor's location, with a banner saying a VPN set to another country may enable it (verified by pointing the Binance hosts at a closed port in Chrome). The signal is only what the page can observe; an exchange does not say why it refuses.
- **Per-visitor cost.** Each visitor's CPU does the book maintenance; measured numbers are in `docs/deslop/` (phones are out of scope).

## What has to be true before it is public

1. **Bandwidth.** Every client receives a full levels frame about 3.5 times a second, roughly **1.1 MB/s** at all 26 venues (about 95 GB per day per always-on viewer). With the recommended eight venues it is a fraction of that, but a public stream still needs **delta frames and compression** (or a coarser public stream than the one the local page gets) before more than a handful of viewers connect. This is the main engineering cost of going public.
2. **Who may call it.** The server now refuses requests a browser makes on another site's behalf (`src/server/request-guard.mts`): the `Host` must be `localhost`, an IP address or a name listed in `HLM_ALLOWED_HOSTS`, and a browser `Origin` must be the server itself. That is what protects the local app from any web page you visit (a page can make your browser POST to `127.0.0.1`, and a re-pointed DNS name can read the answers). A deployment sets `HLM_ALLOWED_HOSTS=maps.example.com` and serves the page from the same name. A page hosted elsewhere (GitHub Pages) calls the server **cross-origin**, which this guard refuses on purpose; that needs an explicit allow-list of page origins and CORS headers, added deliberately. Venue selection and the other POST routes should also sit behind authentication on a public server (a shared secret header, or only the operator's IP), because today any caller that passes the guard can change which venues are connected.
3. **Exchange terms.** Public market-data feeds usually allow personal use; redistributing them to the public (a hosted map that re-serves the books) can need a licence. Check each exchange's market-data terms before serving other people. Fewer venues also means fewer terms to read.
4. **Remote HyperTracker credentials** stay on the server; nothing in the page needs them.

## "Encrypt the source": what is and is not possible

Code that runs in a browser cannot be encrypted: whatever the browser executes, the person using it can read. Options that exist, from cheapest:

- **Keep the source repository private and publish only the build.** A separate public repository (or branch) receives `dist/`. The page still contains the compiled code, but not the TypeScript, the tests, the notes or the history.
- **Publish no source maps.** `vite build` writes `.js.map` files, which embed the original TypeScript. `HLM_SOURCEMAP=off` turns them off (`HLM_SOURCEMAP=off npx vite build --config vite.config.mts`; in PowerShell set `$env:HLM_SOURCEMAP='off'` first). Do this for any public build and check `dist/assets/` for `.map` files.
- **Minification** (already on) removes names and comments. **Obfuscation** (control-flow flattening, string encryption) makes reading harder but costs speed in exactly the loops that were made fast (rasterising, grouping), and a determined reader still gets through it. The hot loops are already WebAssembly, which is harder to read than JavaScript but is not secret either.
- **Password-gating the whole page** (StatiCrypt encrypts the HTML and asks for a password in the browser) keeps strangers out of the page. Anyone with the password has the code.
- **Keep the valuable logic on the server.** The only thing a browser cannot copy is what it never receives: if some analysis is the part worth protecting, compute it server-side and send the result.

None of this is a reason to avoid GitHub Pages for the page itself. It is a reason not to expect the page to hide how it works.

## Open decisions

- Where the server lives (a new small VPS is recommended) and under which name.
- Whether the public stream is the same as the local one or a coarser, delta-based one.
- Whether the public page needs a password or an allow-list of viewers.
- Which venues to serve publicly (the recommended eight are the ones with the clearest terms and the best feeds).
