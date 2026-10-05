# Possible trapped buyers and sellers (footprint)

When the footprint is on, a closed candle whose wick holds more net aggressive buying (or selling) than any equally tall stretch of the rest of the candle, and that then closed far from where those aggressors bought, gets its imbalanced wick cells outlined and slowly pulsing in amber. Hovering them says so:

> **Possible trapped buyers** — $4.1M net aggressive buying in the upper wick, 2.3x a typical candle's net delta; average entry 86,640; the candle closed 1.2 ATR below. If they still hold, they are underwater. Not validated for this market and timeframe. Not a forecast.

Code: `src/app/traps.ts` (detector, pure functions; `tests/app-traps.test.mts`), the pulse layer and pop-up in `src/app/panes/heat-pane.ts`, the cell hook in `paintFootprint`. The research behind it, with evidence grades, is `docs/research/trapped-traders-report-2026-10-05.md` (written by a research agent; its URLs and figures have not been checked by hand).

## What it claims and what it does not

**Claims:** a fact about a closed candle (where the net aggressive flow was and how far price then went from it), labelled "possible".

**Does not claim:** that the pattern predicts anything (the offline study below found no reliable direction). No peer-reviewed or out-of-sample test of "net aggressive buying in the wick of a candle that closes far lower predicts adverse follow-through for those buyers" was found; the schools of footprint practice disagree about this exact picture (trapped buyers vs. "poor high, price returns"), and some retracement after aggressive buying is the normal expectation (transient price impact). The cue stays "possible" until a study (below) says otherwise.

## The rule (per closed candle, at a canonical row step)

Notation for the upper wick (the lower wick mirrors it with the sides swapped). `T = max(open, close)`, `Z` = rows whose midpoint is at or above `T`, `D_r` = buy USD minus sell USD in row `r`, `ATR` = mean true range of the 20 candles before.

| Test | Rule | Default |
| --- | --- | --- |
| Wick | `(high - T) / range >= w` and the wick spans at least 3 rows | w = 1/3 |
| Concentration | `D_Z > 0` and `D_Z >=` the net delta of every block of the same number of rows below `T` (all of the rest, if shorter than the wick) | none |
| Magnitude | `D_Z >= k x M`, `M` = median absolute net delta of the previous up to 72 candles (at least 12 with complete footprints) | k = 1 |
| Adverse close | `(entry - close) / ATR >= u`, `entry` = buy-VWAP of the rows in `Z` | u = 1 |
| Complete candle | at least 90 % of the candle's minutes were recorded | |
| Settled | judged 15 s after close (late prints), never while forming | |

**Zoom independence.** The footprint the chart draws is grouped to a zoom-dependent row height. Detection loads its own copy at a canonical step (the finest recorded step times a power of two, so a typical candle spans at most 64 rows) and caches nothing from the display grouping, so a flag does not appear or vanish when the chart is zoomed. The display only decides which drawn rows pulse.

**State.** *Active* (pulses): a trap within 12 candles that no later candle has closed back through (a later close at or above the entry for buyers). *Reclaimed*: price closed back through; a faint still outline. *Static*: older than 12 candles, still outlined faintly. Reduced-motion users get the still outline.

**What it will not flag:** a candle seen only in part (the first after the page opened, or after a feed gap), a market whose chart is showing another market's candles, and the 1d timeframe (the footprint is only kept for a day in the browser and a week on the server, too little to form the baseline; 4h needs the server's week).

## What the offline study found (2026-10-05)

Before any stronger wording, the cue was tested offline. The design was written down before any data was downloaded: Binance USD-M BTCUSDT `aggTrades` (825 days, checksums verified), the shipped detector used unchanged (a frozen copy, with footprints rebuilt from trades bit-identical to the recorder's), chronological design (2021-22) / validation (2023-24H1) / frozen holdout (2024-07 to 2026-09), shape-matched look-alike candles as controls, and a permutation null that re-runs the whole detector. The holdout was evaluated once.

| Endpoint (Binance BTCUSDT perpetual, 15m, default parameters) | Result | Verdict |
| --- | --- | --- |
| **Primary:** price moves against the trapped side over the next 4 bars | +0.81 ATR [+0.22, +1.24], permutation p = 0.28 | **Inconclusive.** Flagged candles themselves do not drift (+0.06 ATR); the estimate is the look-alikes moving back toward their wick |
| **Co-primary:** price comes back to the aggressors' average entry within 3 h | -15.5 pp [-22.6, -4.1], p = 0.006 | **Met, but fragile.** After 62 % of flagged candles against 72 % of look-alikes. The design (-6 pp) and validation (-2 pp) estimates were weak, and the permutation null is centred at +10.5 pp, so a figure nearer -10 pp is the honest one |

- **5m and 1h:** no evidence (none of the 16 secondary tests passed after Holm correction).
- **Not specific to trapped buyers.** Candles with net *selling* in the wick were revisited about as rarely, so the gap is about heavy aggressive flow in a wick, not about concentration or about trapped traders.
- **No tradable edge.** About 0.1 ATR at 15m is 2.5 to 3.9 bp, and flagged candles show no follow-through. Nothing in the study models costs.
- **Power was low** (the smallest detectable effect at 15m was 0.73 ATR and 13 pp), so a clean null was never reachable.
- **Open interest did not help** (exploratory); the leg-split refinement shows no consistent benefit.
- **How often it fires** matches the section below: 1.19 % of candles at 5m, 1.27 % at 15m, 1.12 % at 1h.

So the pop-up says what was tested and nothing more (`trapVerdict` in `src/app/traps.ts`): on Binance BTCUSDT perpetual at 15m, "no reliable direction; these levels were revisited somewhat less often than look-alike candles"; anywhere else, "Not validated for this market and timeframe". The pulse was not made more prominent.

Two things the study found that are still open:

1. **A flag can change after the fact.** `TRAP_PARAMS.freezeMs` is not used, and the window is re-scanned at the current row step every few seconds, so 1.2 to 2.7 % of flags flip when a candle is judged again 12 bars later. Freezing each candle's step at its close plus a minute would fix it.
2. **Binance open-interest timestamps changed meaning on 2024-03-04**: from then on the value stamped T is the snapshot at T + 5 min, so an as-of join leaks five minutes of the future, and the archive holds samples where open interest is exactly 0. Check the live source for both before building the open-interest refinement below.

## When a flag can appear

- **Markets.** Footprints are recorded for Binance perpetual and Hyperliquid on the server (also dYdX and Aster), and for every running venue in the browser; a trap can only appear on a market that has a footprint, and only while the chart is showing that market's own candles.
- **Warm-up.** A flag needs the candle itself plus at least 12 earlier candles with complete footprints. A browser page that has just opened therefore needs about 65 minutes open at 5m, about 3 h 15 min at 15m and about 13 h at 1h (4h and 1d cannot work in the browser, which keeps 24 hours); a server that has been recording for a week has all of them. A quiet chart in the first hours is not a bug. Baselining from Binance klines (taker-buy volume) would remove the wait and is the first follow-up.
- **Server version.** The server must send each bar's recorded-minute count (`minutes`, added with this feature). A server started before that never reports complete candles, so nothing is flagged until it is restarted.
- **Time.** A candle is judged 15 s after it closes, so the newest flag lags the chart by a quarter of a minute.

## Firing rate and the default

Chosen from a pre-registered 27-configuration grid (w in 1/4, 1/3, 1/2; k in 0.5, 1, 2; u in 0.25, 0.5, 1) **by how often it fires and nothing else**: no outcome was looked at. On 21.4 h of recorded Binance perpetual footprints (2026-10-04 15:18 to 2026-10-05 12:39 UTC; 218 eligible 5m candles, 64 eligible 15m candles, 5 eligible 1h candles):

| Excursion u (w = 1/3, k = 1) | 5m flagged | 15m flagged |
| --- | --- | --- |
| 0.25 | 25 (11.5 %) | 9 (14.1 %) |
| 0.5 (the report's value) | 12 (5.5 %) | 5 (7.8 %) |
| **1 (the default)** | **3 (1.4 %)** | **1 (1.6 %)** |

The whole grid ranged from 0.5 % to 14.7 % (5m). At half an ATR the cue would fire roughly every two hours on 5m candles (10 of the 12 flags had been reclaimed by a later close within the sample), which is not a rare enough event for something that pulses. These samples are small; they set the cue's rarity, not its meaning. Reproduce with `fpdata`-style scripts over a copy of a recorded `depth-v2.sqlite` (never the live database).

## Ways it can mislead (read before trusting a flag)

1. **Squeezes and stop runs read as traps.** Buy delta at a high is often forced short covering or liquidations of shorts: those aggressors already left. Without open-interest legs or liquidation data this cannot be told apart.
2. **The flag is defined by a reversal that already happened.** Partial impact reversion and the generic short-horizon reversal in crypto make "price fell after buyers bought the top" common. A SPY test in the research report found a "working" sweep pattern re-crossed 73.7 % of the time against 74.3 % for ordinary moves.
3. **Single-venue flow.** The delta is one market's; it may be one leg of a cross-venue arbitrage.

## Next

- **v1.1, open interest.** For a Binance perpetual footprint at 15m and above, split the candle into the push and the rejection with 1m candles and the 5-minute open-interest history, and reclassify "buying while OI fell" as a short-covering spike (the most valuable OI piece). Mandatory "pending" (latest candle) and "not resolvable" (1-3m candles) states; other venues show OI as context only. Open interest in the browser engine already comes from Binance REST (30 days) and live samples.
- **Baseline from klines.** Binance klines carry taker-buy volume, so a candle's net delta is available over the whole kline history; that would let 1h and 4h work from the first minute in the browser. Not done: it needs the candle series extended in both sources.
- **(Done: see above.) A study before any stronger wording.** Rebuild footprints from Binance USD-M `aggTrades` and 5-minute `metrics` (data.binance.vision; large downloads), chronological design / validation / frozen holdout, shape-matched controls plus a permutation null that re-runs the whole detector, a primary endpoint of the 4-bar forward move against the trapped side in ATRs and a co-primary of revisiting the entry within 12 bars (the two theories predict opposite signs), and an effect worth showing of at least 0.1 ATR with a confidence interval excluding zero in a majority of yearly folds (`docs/research/...` section 4 has the design and power numbers). Not started.
