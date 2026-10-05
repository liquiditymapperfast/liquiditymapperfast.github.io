# Possible trapped buyers and sellers (footprint)

When the footprint is on, a closed candle whose wick holds more net aggressive buying (or selling) than any equally tall stretch of the rest of the candle, and that then closed far from where those aggressors bought, gets its imbalanced wick cells outlined and slowly pulsing in amber. Hovering them says so:

> **Possible trapped buyers** — $4.1M net aggressive buying in the upper wick, 2.3x a typical candle's net delta; average entry 86,640; the candle closed 1.2 ATR below. If they still hold, they are underwater. Untested pattern, not a forecast.

Code: `src/app/traps.ts` (detector, pure functions; `tests/app-traps.test.mts`), the pulse layer and pop-up in `src/app/panes/heat-pane.ts`, the cell hook in `paintFootprint`. The research behind it, with evidence grades, is `docs/research/trapped-traders-report-2026-10-05.md` (written by a research agent; its URLs and figures have not been checked by hand).

## What it claims and what it does not

**Claims:** a fact about a closed candle (where the net aggressive flow was and how far price then went from it), labelled "possible".

**Does not claim:** that the pattern predicts anything. No peer-reviewed or out-of-sample test of "net aggressive buying in the wick of a candle that closes far lower predicts adverse follow-through for those buyers" was found; the schools of footprint practice disagree about this exact picture (trapped buyers vs. "poor high, price returns"), and some retracement after aggressive buying is the normal expectation (transient price impact). The cue stays "possible" until a study (below) says otherwise.

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
- **A study before any stronger wording.** Rebuild footprints from Binance USD-M `aggTrades` and 5-minute `metrics` (data.binance.vision; large downloads), chronological design / validation / frozen holdout, shape-matched controls plus a permutation null that re-runs the whole detector, a primary endpoint of the 4-bar forward move against the trapped side in ATRs and a co-primary of revisiting the entry within 12 bars (the two theories predict opposite signs), and an effect worth showing of at least 0.1 ATR with a confidence interval excluding zero in a majority of yearly folds (`docs/research/...` section 4 has the design and power numbers). Not started.
