# Putting it on the web

Today the app is local by design: the server listens on `127.0.0.1`, connects to the exchanges' public feeds from your machine, records to a local SQLite file and serves the page that reads it. This note covers what changes when the page is public (GitHub Pages, a VPS), and what can and cannot be protected.

## GitHub Pages: possible, with a server elsewhere or with none

GitHub Pages serves static files. The client (`dist/`: one HTML file, one script, one worker, one `.wasm`, one stylesheet) is exactly that and hosts fine. The **server cannot**: it holds the exchange WebSockets, the recorder and the SQLite history, and streams to the page over `/api/v2/ws`. A Pages site therefore needs a server somewhere else, and the page must be told where. Today every URL is relative (`/api/v2/...`, `ws://<this host>/api/v2/ws`), so a Pages build needs one small change: an API base address read from a `<meta>` tag or a query parameter. It is a 20-line change; it is not made yet because nothing here decides where the server will live.

Recommended shape:

| Piece | Where | Notes |
| --- | --- | --- |
| Page (`dist/`) | GitHub Pages, Cloudflare Pages or the same VPS | static, cacheable |
| Server | a small VPS of its own | TLS in front (Caddy or nginx), `wss://` |
| History | the server's disk | the recorder keeps a fixed window, so disk is bounded |

**Do not run it on the VPS that hosts the trading bots.** That machine holds exchange keys; a public market-data service on it widens what an attacker can reach for no gain. A separate VPS of the smallest class is enough for the data plane (measured: about 80 % of one core at 26 venues, 238 MB; the recommended eight venues need far less).

## Browser-only mode: no server at all

The alternative to hosting a server is to let each visitor's browser connect to the exchanges itself, as aggr.trade does. That is possible here. Measured on 2026-10-05 from a headless Chrome page on a foreign origin (`http://127.0.0.1:<port>`, not github.io, which no exchange was seen to treat differently), 9 s per feed:

| Feed | Result |
| --- | --- |
| WebSocket depth: Binance spot and perpetual, Bybit `orderbook.1000`, OKX `books`, Bitget `books`, Coinbase `level2_batch`, Deribit `book`, Hyperliquid `l2Book` | all delivered data (first message in 0.9 to 1.8 s; 3 to 142 messages; Coinbase the heaviest at about 130 KB/s) |
| Hyperliquid trades | delivered |
| REST with CORS: Binance depth snapshots (spot, perpetual), klines, open-interest history; Bybit klines and open interest; OKX and Bitget candles; Coinbase book snapshot; Deribit order book; Hyperliquid `info` POST | all answered 200 and were readable from the page |

WebSockets are not subject to CORS, and these venues' public REST endpoints send CORS headers. A Pages-hosted client would therefore need no server, no bandwidth bill and no market-data licence of its own (each visitor consumes the feeds directly), and the request guard above would not apply.

What it takes and what it loses:

- **A browser data source.** The client today reads one server API (`/api/v2/state`, the binary `/api/v2/ws` frames and the history endpoints). The adapters (`src/adapters/`), the valuation and merge (`src/server/v2/levels.mts`, `merge.mts`) and the recorder are plain TypeScript and can run in a Web Worker; the live-feed manager (3 400 lines, Node sockets, REST resync for Binance sequencing, checksum sessions) has to be rewritten as a slimmer browser feed layer for the eight default venues. The server stays as the other source behind the same interface: the page uses it when it exists (local use, full history) and the browser source when it does not (Pages).
- **History.** Candles and open interest come back immediately from the REST endpoints above. The heatmap, footprint and trade bubbles are built from what the tab has seen: they start empty and fill while the page is open (a recorder in IndexedDB can keep them between visits, but a background tab is throttled, so it records in gaps). A hosted recorder remains possible later as an optional history service.
- **Cannot move to the browser:** the HyperTracker layers (liquidation, stop loss, take profit), whose key must stay secret; they would be absent or labelled mock.
- **Per-visitor limits.** Binance refuses some countries (the same as for the server today); each visitor's CPU does the book maintenance (the server uses about 17 % of a core for the eight venues, so a worker handles it on a desktop; phones are out of scope).

Suggested order: (1) the data-source interface with the current server behind it; (2) live-only browser source for Binance spot and perpetual, Coinbase and Bybit with REST candles and open interest; (3) the remaining venues; (4) the IndexedDB recorder.

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
