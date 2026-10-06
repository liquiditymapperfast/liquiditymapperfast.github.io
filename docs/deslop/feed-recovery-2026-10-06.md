# Feed recovery after a failed restart (2026-10-06)

## What was seen

Karl's server on :8787 (up 14 h) showed the heatmap still growing while the candles and the mark price stood still at 01:59 UTC,
about 12 h earlier. Reloading the page did not help.

`/api/diagnostics`, `/api/v2/state` and `/api/orderbooks/venues` of the running process showed:

- all seven feed-manager venues (hyperliquid, binance, bybit, okx, bitget, deribit, coinbase) `stopped`, last success within 10 s of 01:59:40 UTC;
- the six self-contained connector venues (binancespot, binanceus, bitmart, bitunix, hitbtc, poloniex) still recording, which is why the map kept growing;
- the mark price frozen (it comes from Hyperliquid's `activeAssetCtx` feed) and the candles ending at 01:59 (the only candle source is the Hyperliquid and Binance kline feeds of the same manager);
- `data/runtime/v2-venues.json` written at 01:59:39.6 UTC, so a Venues dialog Apply reached the server then, and `cryptocom-metadata` reporting `snapshot` at 01:59:45, so a `start()` was running in its metadata phase and never finished: the saved venue selection was untouched.

## Cause

`LiveFeedManager.start()` retires every running feed first, then awaits about twenty metadata requests, and only then opens the new feeds.
An exception between the two (a status or message callback that throws, for instance) rejected `start()` with `running: true` and no feed at all:
no reconnect timer, no retry, nothing that ever opened a feed again. Reproduced with the real manager by throwing from `onStatus` at the 6th and 15th status event
of a start (`feeds 0, specs 14, running true`).

What threw on Karl's server was not found: his server's console is not readable and the restart could not be repeated (a restart with real feeds, a restart during a
simulated outage at seven different moments, and a restart with REST answers of nine bad shapes all finished and recovered). Treat the cause of the throw as open;
the failure it led to is closed.

## Fix

- `start()` records the outcome and, when it fails after the configuration changed, schedules a recovery with the last configuration that finished (backoff 1 s up to 5 min, candle backfill on).
  The error still reaches the caller. A missing transport (never mends) and an invalid configuration (nothing was retired) schedule nothing.
- `checkLiveness()` runs every 30 s (`FEED_WATCHDOG_MS`, 0 turns it off): a start that has run for 3 min is abandoned for a fresh one; a manager with specs and no feed for two checks is restarted.
- `/api/diagnostics` has `feedManager` (running, feed and spec counts, last start with its error text, recoveries and the last reason), and the server logs `[feeds] ...` lines, so the next occurrence names its cause.
- Tests: `tests/live-feed-recovery.test.mts` (8 cases).

Karl's running server still has the old code: it needs a restart (`npm run dev`). On start it re-applies the saved venue selection and backfills 25 h of 1 m candles, so the gap closes.
