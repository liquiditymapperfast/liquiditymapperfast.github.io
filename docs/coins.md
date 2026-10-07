# Coins other than BTC

Built 2026-10-07. The page shows one coin at a time: BTC, or a coin listed on most of the eleven markets the browser reads.

## Which coins

Measured 2026-10-07 from each market's own public list, names matched after units were converted and kept only where the price agreed with the other markets' within 2 %:

| Markets that list the coin | Coins |
| --- | ---: |
| all 11 | 62 |
| 10 or more | 95 |
| 9 or more (the rule) | 147, BTC included |

Deribit (64 of the 147 missing), Hyperliquid (22) and Coinbase (21) are the markets most often missing. The price check took out one real collision: LIT on Binance spot is another token at 0.21 times the price.

A coin enters the list on nine markets and leaves it below eight, so one at the edge does not come and go. A list that reads fewer than six markets, or that would lose more than 30 % of the coins (a market that changed its format), is not used: the previous list stands.

## Units, per market

| Market | How a coin is listed | What the connector does |
| --- | --- | --- |
| Binance, Bybit, Bitget (perpetuals) | `PEPEUSDT`, or `1000PEPEUSDT` / `1000000MOGUSDT` in thousands or millions; Bybit also writes `SHIB1000USDT` | price divided by the unit, sizes multiplied |
| Hyperliquid | `PEPE`, or `kPEPE` in thousands | the same; the instrument is named `kPEPE-PERP` |
| OKX swaps | contracts of `ctVal` coins (0.01 BTC, 10,000,000 PEPE) | listed only with a contract value in its own coin, from the instrument list |
| Deribit | `BTC-PERPETUAL`, `ETH-PERPETUAL` sized in USD; everything else `X_USDC-PERPETUAL` sized in coins (`1000PEPE_USDC-PERPETUAL` in thousands) | BTC keeps its $10 grouped book; the others are read ungrouped (Deribit accepts different groupings per instrument; `book.ETH-PERPETUAL.1.20.100ms` was refused), the best 20 levels a side |
| Spot markets, Coinbase | one coin per unit | nothing |

Candles, open interest and the open-interest samples are converted the same way (`src/shared/history.ts`), so a heatmap, a candle and an open-interest figure for PEPE are all in single PEPE.

## Where the list is built

`src/shared/coins.ts` builds it from parsed JSON (tests pass what each market answered). Three copies:

- **In the repository** (`src/app/public/coins.json`), rebuilt by hand with `npm run coins -- --out src/app/public/coins.json`. It is what a build ships, and the stand-in when nothing newer can be read.
- **On the site**, rebuilt daily by `.github/workflows/pages.yml` (03:17 UTC) on the list the site has now. GitHub's runners are in the US, and Binance and Bybit refuse US addresses (OKX may too; this was not measured from a runner): a market whose list cannot be read keeps its listings from the previous list, and its date in the list's `lists` field says how old they are. Its new listings and delistings then reach the site only through the repository copy. A listing that has gone shows in the page as a market that fails to connect; the others are unaffected. GitHub stops a schedule after 60 days without a push.
- **On the local server**, rebuilt daily into its data folder (`coins.json` beside the history) and served at `/coins.json` in place of the shipped copy; a build that fails keeps the last one and tries again an hour later.

The lists add up to about 4.5 MB (largest: Binance perpetual and Bitget spot, about 1 MB each). Every one answers a page with CORS, but the page never reads them: it reads the one list, about 76 KB (9 KB compressed).

## The server: BTC only

The local server's feed manager serves one market per exchange, and switching its coin means restarting its feeds (about 13 s, and the path behind the dead-feeds incident). So the server stays on BTC, and a page it serves on another coin reads the exchanges itself, exactly as the public site does. What stays BTC-only: the server's 29 venues and its recordings, the HyperTracker layers, and the rejected-aggressive cue's tested scope (`docs/trapped-traders.md`).

## Switching

Choosing a coin loads the page again with `?coin=ETH`: new sockets, a new engine and empty caches, so nothing of the last coin can be drawn on the new one, and one switch is always the last one. The address and this browser remember the coin (`lmf.coin`); BTC is the plain address. A coin that has left the list opens BTC and says so.

The venue choice is one for every coin. A market that does not list the coin shows as "does not list this coin" and cannot be ticked; saving a choice on that coin keeps what the choice said about that market. Saved choices that name an instrument (the venue shown alone on the map, the ladder's venues) are carried to the same market's instrument for the coin.

## Sizes

Every floor the recorders keep and every size setting the person sets is BTC's times a scale:

| Coin's 24 h volume against BTC's | Scale | Example (2026-10-07) |
| --- | ---: | --- |
| 0.4 or more | ×1 | ETH |
| 0.04 to 0.4 | ×0.4 | SOL, XRP, HYPE |
| 0.004 to 0.04 | ×0.1 | DOGE, PEPE, SUI |
| 0.0004 to 0.004 | ×0.04 | SHIB, BONK |
| less | ×0.01 | the smallest |

The scale follows the square root of the volume ratio, on the steps 1, 0.4, 0.1, 0.04, 0.01: trade sizes shrink more slowly than volume. A coin keeps its scale until its ratio is twice past the boundary, and this browser keeps the scale a coin's recordings were made at for as long as it holds them (a day), so one day's recordings never mix two floors. On BTC the scale is 1 and nothing differs from before.

Scaled: the recorded trades (from $25K), absorption groups (from $25K), map cells dropped from a large column (under $10K), the size buckets, the trade-bubble minimums and radius, the absorption fixed size, the sound tiers, the burst, delta and wall alerts, the spot/perp divergence note, the Liquidity Tracker's size filter and the footprint's imbalance minimum. Settings are kept as BTC's and shown scaled, so a setting made on one coin carries to every coin.

The order book's Group steps are BTC's moved by whole decades to the coin's price (ETH: 0.001 to 10). Prices are written with up to ten decimals.

## Recordings

Each coin is recorded in its own IndexedDB database (`lmf-recordings-<COIN>`; BTC keeps `lmf-recordings`, so nothing recorded before is lost), by the one tab holding that coin's lock, so two tabs on two coins both record. A coin not opened for a day has its database removed.

## Checked live

2026-10-07, headless Chrome on a local build: ETH, PEPE, SHIB, DOGE and SOL had 11 of 11 markets live within 40 s, LIT 9 of 9 (Binance spot and Coinbase shown as not listing it). PEPE's books, candle and open interest were in single PEPE on every market (the 1000x listings agreed with the others to the tick).
