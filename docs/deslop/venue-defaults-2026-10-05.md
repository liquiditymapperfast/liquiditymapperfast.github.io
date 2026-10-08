# Which venues start by default

Measured 2026-10-05 for BTC; spot extended 2026-10-07 (below). The default used to be every supported venue (26 books, including dead, stale and wall-to-wall shallow ones); it is now the eleven below. An existing install keeps the venues it saved; the Venues picker's **Recommended** button selects this set.

| | Venues |
| --- | --- |
| Perpetuals | Binance, Bybit, OKX, Bitget, Hyperliquid, Deribit |
| Spot | Binance spot, Coinbase, Bybit spot, OKX spot, Bitget spot |

Everything else stays one click away in the picker.

## The rule

A venue starts by default when it is **big** and its **feed is good**:

1. **Big.** Among the largest perpetuals by 24 h BTC volume or open interest, or a large spot market of an exchange whose volume can be checked (spot was Binance and Coinbase only until 2026-10-07, because those were the only large spot markets the app had a connector for). Deribit is the one exception on size (ninth by volume): it is included for its feed (fresh, 23 to 27 bp deep) and because it is where institutional BTC flow and options hedging sit.
2. **Present and fresh.** In the server's own frames 100 % of the time, median age under a second (Hyperliquid, whose aggregated book arrives about every 3 s, is kept as the app's namesake and fifth largest open interest).
3. **More than a touch.** At least about 400 levels or about 20 bp of reach, so the venue adds depth to a heatmap. OKX (7 bp) is the one exception: second by volume and the freshest feed measured.
4. **Not wrong.** The book is not crossed and not stale.

## Measurements

Volume and open interest are each exchange's own public figures (`npm run report:venues -- size`). The book columns are what this app's connections deliver over 12 minutes with every venue enabled, 2 624 frames (`npm run report:venues -- feed 12 8787`), on the build that has the Kraken and Bitfinex fixes below: **levels** after distance merging, **reach** how far from the price the book extends, **updated in** the share of frames in which the venue's book changed, **age** the server's frame time minus the venue's own timestamp (negative: the exchange clock is ahead of this machine; Bitfinex sends no timestamp, so its age reads 0). Reach is mostly a property of what the venue publishes, not of the adapter: the README lists the shallow ones. Hyperliquid's book is 20 aggregated bands per side at two significant figures (about $1 000 each at this price), which is why a few levels reach 2.3 %.

### Perpetuals (24 h BTC volume 44.2B across the venues measured)

| Venue | 24 h volume | Share | Open interest | Levels | Reach bid / ask (bp) | Updated in | Age p50 (ms) | Default |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| Binance | 13.25B | 30.0% | 8.22B | 1676 | 4998 / 4373 | 26% of frames | 527 | **yes** |
| OKX | 6.26B | 14.2% | 2.44B | 118 | 7 / 7 | 99% of frames | 3 | **yes** |
| Gate.io | 5.97B | 13.5% | 4.34B | 82 | 6 / 5 | 92% of frames | 195 |  |
| Bybit | 5.07B | 11.5% | 4.95B | 416 | 22 / 26 | 26% of frames | 488 | **yes** |
| Bitget | 3.21B | 7.3% | 2.69B | 577 | 34 / 48 | 26% of frames | 430 | **yes** |
| MEXC | 3.16B | 7.2% | 4.92B | 8 | 0 / 0 | 84% of frames | 82 |  |
| Hyperliquid | 2.50B | 5.7% | 3.24B | 40 | 234 / 234 | 5% of frames | 3065 | **yes** |
| Bitunix | 2.34B | 5.3% | – | 2140 | 4999 / 4995 | 40% of frames | 296 |  |
| Deribit | 1.16B | 2.6% | 812M | 40 | 23 / 27 | 77% of frames | 80 | **yes** |
| Aster | 554M | 1.3% | – | 22 | 2 / 2 | 99% of frames | 20 |  |
| HTX | 398M | 0.9% | – | 29 | 3 / 2 | 98% of frames | -23 |  |
| Crypto.com | 339M | 0.8% | 521M | 12 | 1 / 1 | 83% of frames | 42 |  |
| dYdX | 4M | 0.0% | 16M | 256 | 600 / 600 | 98% of frames | 0 |  |

### Spot (24 h BTC volume 6.1B across the venues measured)

| Venue | 24 h volume | Share | Levels | Reach bid / ask (bp) | Updated in | Age p50 (ms) | Default |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| Binance spot | 1.35B | 22.1% | 1303 | 4746 / 4019 | 93% of frames | 66 | **yes** |
| Gate.io spot | 653M | 10.7% | no book in this app | | | | |
| MEXC spot | 624M | 10.2% | no book in this app | | | | |
| Bybit spot | 572M | 9.4% | no book in this app | | | | |
| OKX spot | 508M | 8.3% | no book in this app | | | | |
| Coinbase | 455M | 7.4% | 1619 | 2003 / 3593 | 26% of frames | 507 | **yes** |
| HTX spot | 414M | 6.8% | no book in this app | | | | |
| Poloniex | 321M | 5.2% | 31 | 14 / 13 | 99% of frames | 24 |  |
| Phemex | 287M | 4.7% | 1280 | 4996 / 4995 | 0% of frames | 29834 |  |
| KuCoin | 216M | 3.5% | 35 | 2 / 2 | 95% of frames | 76 |  |
| Bitget spot | 212M | 3.5% | no book in this app | | | | |
| Kraken | 189M | 3.1% | 122 | 11 / 11 | 99% of frames | -122 |  |
| Bitstamp | 141M | 2.3% | 163 | 32 / 67 | 91% of frames | 94 |  |
| WhiteBIT | 64M | 1.0% | 114 | 11 / 13 | 44% of frames | 315 |  |
| HitBTC | 58M | 0.9% | 524 | 4997 / 4993 | 52% of frames | 255 |  |
| Bitfinex | 47M | 0.8% | 50 | 7 / 7 | 73% of frames | 0 |  |
| Binance US | 2M | 0.0% | 739 | 4951 / 4957 | 48% of frames | 299 |  |


## Why the others are not default

- **Gate.io and MEXC** are third and sixth by reported volume but publish a handful of levels (Gate.io ±5 bp, MEXC the top 5–8): they would add a thin stripe at the touch and nothing to the walls, at the cost of two more feeds. Reported volume at both is also the hardest to corroborate.
- **Bitunix** has a deep book but is a small exchange with no open-interest figure to check its volume against.
- **Aster, HTX, Crypto.com, KuCoin, Poloniex** publish only 12–35 levels (1–15 bp). **dYdX** and **BitMEX** are empty markets for BTC (4M and 0 of volume).
- **Kraken, Bitfinex, Phemex** were unfit when this was first measured, and two of the three were bugs of this app, not of the venues. Kraken's and Bitfinex's sessions handed the whole book on labelled as an update, which the runtime state merges instead of replacing, so a level that had left the book never left the state: the book grew (Kraken 303 to 1 247 levels in an hour) and crossed by 30 to 70 bp. They now hand on a snapshot, and a regression test (`tests/depth-session-snapshots.test.mts`) fails without the fix. Bitfinex then showed a second fault the growth had hidden: it sends neither a provider timestamp nor a sequence, so its valued book was never refreshed while the level counts stayed the same; the cache key now includes the touch. Both are healthy in the table above (uncrossed, fresh, updating). Phemex's book is only refreshed about every 30 s in this app (the cause is not found), so it sits between 5 and 50 s old and is mildly crossed between refreshes. Independently, the server leaves any book crossed by more than 5 bp off the map and says so in the picker. All three are small (3.1 %, 0.8 % and 4.7 % of spot volume), so none is default.
- **Bitstamp, WhiteBIT, HitBTC, Binance US** are small.

## What the default saves

Server CPU on the same machine, one viewer attached, 60 s windows, no profiler: every venue enabled (26 books) 62 % of one core; the recommended eight 17 %, 3.6 times less, and each frame carries only the enabled books. Memory is dominated by the recorder and the history database and barely moves (242 MB against 233 MB at that point). Measured on the isolated test server with `HLM_DEFAULT_VENUES` unset and the selection switched between the two sets through the picker's own API.

## Caveats

- One venue's numbers are one 12-minute window on one day; volumes move by ±10 % hour to hour and the ranking among the middle venues can swap. Re-run both reports before changing the list.
- "Updated in" reflects the stream each adapter subscribes to (for example Binance's 1 Hz depth stream and a once-a-second re-valuation of very deep books), not what the exchange could send.
- Gate.io, MEXC and HTX spot are large by reported volume and have no connector here; their volume is the hardest to corroborate, which matters more for the flow column (where a trade is counted) than for the map.

## 2026-10-07: Bybit, OKX and Bitget spot

The flow column's spot side covered Binance spot and Coinbase only, about 30 % of the BTC spot volume measured above; Bybit, OKX and Bitget spot add about 21 %. They run as connector venues (book and trades on one socket each, `src/shared/venues.ts`), recommended in the browser and on the server, so a saved choice made before them gains them once. Probe of the three feeds, 150 s, calm market (OKX and Bitget traded little in that window):

| Spot market | Trades (150 s) | Levels | Reach bid / ask (bp) | Depth within 10 bp / 50 bp | Sequence gaps | Crossed | Age p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Bybit spot | 1 002 ($1.38M) | 1000 / 1000 | 91 / 69 | $4.7M / $10.0M | 0 | never | under 0.1 s |
| OKX spot | 83 ($0.17M) | 400 / 400 | 25 / 13 | $11.2M / $13.9M | 0 | never | under 0.1 s |
| Bitget spot | 95 ($0.05M) | 500 / 500 | 63 / 32 | $18.7M / $28.7M | 0 | never | under 0.1 s |

All three pass the rule above. Bybit spot's `seq` names the order its fills belong to, as on the perpetual (926 fills: every seq shared by several fills had one side and one time). Bitget sends its last 50 trades as a snapshot on subscribing; both Bitget connectors leave them out. The three add about 16 % to the data the page receives (12.8 KB/s on top of 78.6 KB/s, measured side by side). The feed manager serves one market per exchange (the perpetual unless `OKX_MARKET_TYPE`, `BYBIT_CATEGORY` or `BITGET_MARKET_TYPE` says spot): a server set to an exchange's spot market should switch the matching spot venue off, or that market is counted twice.
- Hyperliquid's book is the slowest of the default set (about 3 s old); it is kept for its reach and open interest.


## 2026-10-08: MEXC, BloFin and Bitunix

Asked for by a visitor. BTC perpetuals, measured on 2026-10-08 at about 15:20 UTC from each exchange's public REST and a 150 s live probe of every feed beside Bybit and Binance. The window fell in a sharp sell-off (Binance traded $257M in it), so the trade flow is compared as a share of Binance's rather than in dollars.

| | MEXC | BloFin | Bitunix | Yardstick |
| --- | --- | --- | --- | --- |
| 24 h volume | $3.29B | $0.32B | $2.20B | Binance $11.98B, Bybit $5.12B, OKX $6.30B |
| Open interest | 47 033 BTC | 4 272 BTC | not published | Binance 95 888, Bybit 57 939 |
| Trade flow vs Binance, live / reported | 25 % / 27 % | 5.7 % / 2.7 % | 21 % / 18 % | Bybit 52 % / 43 % |
| Liquidity within 10 bp | $14M to $23M | $70M to $108M | $32M to $39M | about $50M each |
| Liquidity within 50 bp | $460M to $485M | about $400M | $64M | OKX $149M |
| Book a page can read | 20 levels a side (`sub.depth.full`), about 4 bp | 400 levels a side, seq-chained, 38 to 79 bp | the whole book, 25 000 levels | |
| Data received | about 20 KB/s (diffs of the deep book) | 29 KB/s | about 1 500 KB/s | the eleven defaults together about 80 KB/s |
| Crossed books, staleness | none, under 1 s | none, under 1 s | none, under 1 s | |
| Trade id, time resolution | id, ms | id, ms | no id, whole seconds | |
| REST readable by a page (CORS) | no | yes | no | |

- **Volume.** Each venue's live trade flow matched its reported share, so the public feeds do not contradict the volume figures.
- **Books out of proportion to trading.** BloFin rests up to twice Binance's liquidity near the price on about 3 % of its volume, and MEXC three to five times Binance's within 50 bp. The map adds books together, so either would dominate its walls without reflecting where trading happens. A comparison of each book's shape with Binance's at the same moment (to look for mirrored books) was inconclusive.
- **MEXC.** Large (third by open interest, 7 % of volume), clean feed, trades with ids. A page cannot read its REST (no snapshot, no candles, no contract size), so the browser takes its best 20 levels and its trades. **Added as an optional venue** (off until chosen; contracts of 0.0001 BTC written into BTC's listing; no reachability probe, so a connection that never comes up is reported as failing rather than as refused for the visitor's country). The server keeps the feed manager's 20-level MEXC book and now takes MEXC's trades through the same connector (FlowSources). A deep book on the server (REST snapshot plus MEXC's conflated diffs, whose versions jump by hundreds per message and so cannot be checked for gaps) is left undone: it would touch the feed manager and bring the heavy far walls onto the map.
- **BloFin.** A clean, browser-friendly feed (OKX's API shape), but about 1 % of perpetual volume with a book that would distort the map. Not added.
- **Bitunix.** Its book socket sends the whole book many times a second (about 1.5 MB/s, twenty times the defaults together), its trades have no id (they cannot be told apart after a reconnect) and whole-second times. Not added to the browser; it stays an optional connector on the server, as before.
- MEXC spot: $0.47B a day, thin (about $2M within 50 bp), protobuf WebSocket. Not added.