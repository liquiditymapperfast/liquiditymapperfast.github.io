> Research agent report (Opus, 2026-10-05), kept as written. Its URLs, quotations and figures were not checked by hand, and several items are marked `[snippet]` (seen only in a search result). Treat the evidence grades as the agent's.

# Trapped buyers / trapped sellers on the footprint: research report

**Evidence tags**
- **[strong]**: peer-reviewed, large sample, replicated or tested out-of-sample.
- **[moderate]**: a single peer-reviewed study, or a careful preprint with a holdout or placebo test.
- **[weak-folklore]**: vendor or blog material with no controlled test.
- **[snippet]**: I only saw the abstract or a search snippet.

## Bottom line

- **No direct test exists.** I found no peer-reviewed or out-of-sample test of the exact claim: "net aggressive buying concentrated in the wick of a candle that closes far lower predicts adverse follow-through for those buyers." All the academic support is indirect, and practitioner sources contradict each other about this very footprint.
- **What to ship:** a fact-first annotation on closed candles, labelled "possible", computed by a pure function that does not depend on zoom.
- **OI helps only when split at the extreme.** One net OI change per candle cannot tell "new longs at the top" from "new shorts on the way down".
- **OI's most valuable job is a veto.** Buy delta at the top while OI is falling is a short-covering spike, not trapped buyers.

---

## 1. State of the art

### 1a. Practitioner order flow (all [weak-folklore]: definitions only, no published tests found)

- **Trapped traders.** ATAS: "if the price moved against big prints… [trapped traders] will continue to move the market in the direction of loss-making" ([ATAS](https://atas.net/blog/cumulative-delta-indicator/)). Bookmap: buyers "trapped at the highs" when passive sellers absorb them ([Bookmap](https://bookmap.com/blog/trading-tariff-news-with-order-flow-reading-market-reactions-in-real-time)). Neither gives thresholds or statistics.
- **Absorption vs exhaustion.**
  - Absorption: heavy one-sided aggression and little price progress.
  - Exhaustion: aggression thinning out into the extreme ([Bookmap](https://bookmap.com/learning-center/en/supply-demand-setups/supply-demand-setups/absorption-exhaustion)).
  - The user's pattern is the absorption type.
- **Stacked imbalances.** Three or more consecutive diagonal imbalances ([ATAS Learn](https://learn.atas.net/volume-basics/volume-analysis/footprint-patterns)).
- **Unfinished auction.**
  - ATAS calls a high finished when it has "zero bid values at the high"; if both sides traded at the extreme, "price comes back".
  - The article gives no statistics and says there is "no 100% guarantee" ([ATAS](https://atas.net/blog/unfinished-auction-what-it-is-and-how-to-trade-it/)).
  - The test means nothing on merged display rows.
- **Market Profile (Dalton).**
  - "Excess" (a thin tail of single prints) means the auction finished.
  - A "poor high" (heavy volume at the extreme) is weak and likely to be revisited ([glossary](https://www.windotrader.com/market-profile/market-profile-glossary-index/), [ATAS on Dalton](https://atas.net/volume-analysis/analyzing-tpo-5-important-elements-in-jim-daltons-opinion/)).
- **The schools contradict each other.** A heavy, buy-dominant wick means "trapped buyers → lower" to one school and "poor high / unfinished → price returns" to another. Neither has been tested. Section 4 uses this conflict as a test that can tell them apart.
- **Price-action version (Lance Beggs / YTC).** Failed breakouts with buyers' stops below ([YTC](https://yourtradingcoach.org/150-lost-ytc-blog-posts/)).
- **OI × price × CVD tables** ([anomiq](https://anomiq.io/blog/crypto-order-flow-trading/), [Chart Champions](https://chartchampions.com/how-to-read-open-interest-and-delta-in-trading/)). The accounting identity behind them is sound (section 2); using them to predict is untested.
- **Sierra Chart, Jigsaw, Exocharts** implement the same building blocks (bid/ask, delta, imbalance). I found no published tests from them.
- **The one controlled practitioner test I found** ([whaleclues](https://whaleclues.com/academy/stop-hunt-pattern-tested)) [weak-moderate: a blog, on SPY].
  - Wick sweeps of prior-day levels re-crossed within 60 minutes 73.7% of the time, against 74.3% for matched ordinary moves.
  - The fade earned +0.4 bp [−2.6, +3.3].
  - It shows the base-rate trap in a single number.

### 1b. Microstructure (academic)

- **Signed flow moves price at the same time, roughly linearly, with slope ∝ 1/depth.**
  - Kyle (1985) [strong, theory].
  - Cont, Kukanov & Stoikov 2014 (*JFEc*) [strong] ([arXiv](https://arxiv.org/abs/1011.6402)).
  - On BitMEX, trade-flow imbalance beats the order-flow imbalance measure (OFI) at explaining price moves: Silantyev 2019 (*Digital Finance*) [moderate].
  - The common component of signed volume explains about 80% of BTC returns: Makarov & Schoar 2020 (*JFE*) [strong, same-period] ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3171204)).
  - So a buy-dominant candle that closes down is a residual against the normal flow→price mapping. That residual is what "absorption" means.
- **Price impact is partly transient.**
  - Propagator / long-memory order signs: Bouchaud, Farmer & Lillo 2009 [strong] ([arXiv](https://arxiv.org/abs/0809.0822)).
  - After a metaorder ends, impact relaxes to about ⅔ of its peak: Bacry et al. 2015 [strong, equities] ([arXiv](https://arxiv.org/abs/1412.0217)).
  - Inventory price pressure has a half-life of 0.92 days on NYSE: Hendershott & Menkveld 2014 (*JFE*) [strong, equities] ([PDF](https://faculty.haas.berkeley.edu/hender/price_pressures.pdf)).
  - **So some retrace after aggressive buying is the null, not evidence of a trap.**
- **Short-horizon reversal in crypto.**
  - Bitcoin shows both intraday momentum and reversal: Wen et al. 2022 (*NAJEF*) [moderate] ([link](https://www.sciencedirect.com/science/article/abs/pii/S1062940822000833)).
  - A preprint (Aug 2026) finds 15-minute reversal in 90% of 183 Binance pairs, concentrated after moves driven by taker flow. The gross edge is about 1.3 bp against about 5 bp in costs. It uses a permutation null and a frozen holdout [moderate, preprint] ([arXiv 2608.21888](https://arxiv.org/abs/2608.21888)).
  - Red event candles therefore carry a slight upward-drift prior, so controls must match on the candle's own return.
- **The passive side can be informed.**
  - Informed traders often use limit orders: Kaniel & Liu 2006 (*J. Business*) [moderate].
  - Support and resistance coincide with peaks in book depth: Kavajecz & Odders-White 2004 (*RFS*) [moderate-strong] ([PDF](http://technicalanalysis.org.uk/support-and-resistance/KavajeczOdders-White2002.pdf)).
  - This is the best academic basis for "absorption = a large or informed passive seller".
- **VPIN** (Easley, López de Prado & O'Hara 2012, *RFS*).
  - Andersen & Bondarenko 2014 (*JFM*): VPIN peaked *after* the Flash Crash, and its predictive content is mostly trading intensity [strong critique] ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1881731)).
  - In crypto, Roll and VPIN measures do predict BTC/ETH price dynamics: Easley, O'Hara, Yang & Zhang (*JFM*) [moderate] ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4814346)).
  - Not needed for v1.
- **Stop clustering.**
  - Take-profit orders cluster at round numbers (reversals); stop-losses cluster just beyond them (acceleration): Osler 2003 (*JF*) [strong, FX].
  - Price trends run fast once they reach stop clusters: Osler 2005 (*JIMF*) [strong, FX] ([NY Fed](https://www.newyorkfed.org/research/staff_reports/sr150.html)).
  - In 18 cryptocurrencies, buy pressure is abnormal just below round numbers and sell pressure just above [moderate, snippet] ([link](https://www.sciencedirect.com/science/article/abs/pii/S106297692600058X)).
  - So wicks through round numbers are often stop runs, where the aggressors were *forced*, not trapped.

### 1c. Behavioural finance

- **Disposition effect.** Shefrin & Statman 1985 and Odean 1998 [strong]. Also found in BTC on-chain data: Schatzmann & Haslhofer 2023 [moderate] ([arXiv](https://arxiv.org/abs/2010.12415)).
- **Grinblatt & Han 2005 (*JFE*).** A turnover-weighted cost basis drives the capital-gains overhang [strong, monthly equities] ([PDF](https://www-2.rotman.utoronto.ca/facbios/file/momentum_JFE.pdf)). The zone's buy-VWAP P_Z (defined in section 3) is a micro-scale analogy to that cost basis, not evidence for it.
- **Kaustia 2004 (*JFM*).** IPO turnover jumps when price first gets back above the offer price [moderate-strong] ([SSRN](https://www.ssrn.com/abstract=459260)). This supports "break-even supply" when price retests P_Z.
- **Caveat: Ben-David & Hirshleifer 2012 (*RFS*).** The probability of selling is V-shaped in profit, with no jump at zero [strong].
- **Leveraged perp traders are forced out** by stops and liquidation rather than by preference. For them "trapped" means future forced selling (Osler-type cascades).

### 1d. Crypto OI, liquidations and funding

- **Crypto carry.** High carry comes from leveraged trend-chasing by small investors and predicts crash risk, amplified by margin and liquidations: Schmeling, Schrimpf & Todorov, BIS WP 1087 [moderate-strong] ([BIS](https://www.bis.org/publ/work1087.pdf)). It moves slowly and describes a regime.
- **Hong & Yogo 2012 (*JFE*).** OI growth forecasts returns at monthly horizons [strong; the horizon is very different].
- **Seven BTC liquidation cascades (preprint 2607.27070).** Using 5-minute Binance OI, no early-warning variable holds up across events. The one regularity is compression of taker-flow variance (placebo p ≈ 5e-6) [weak-moderate, preprint] ([arXiv](https://arxiv.org/abs/2607.27070)).
- **Unverified [snippet]:**
  - OI change reportedly predicts crashes with odds ratio 1.48 ([Emerald 2026](https://www.emerald.com/sef/article/doi/10.1108/SEF-04-2026-0367/1388748/Systemic-risk-from-financial-leverage-in-digital)).
  - About $19B of OI was reportedly lost in the Oct 2025 cascade ([preprint](https://www.researchgate.net/publication/396645981_Anatomy_of_the_Oct_10-11_2025_Crypto_Liquidation_Cascade_Macroeconomic_Triggers_Market_Microstructure_and_Systemic_Risk_Lessons)).
- **Amberdata blog.** Buying ETH perp after 1-minute long-liquidation prints made +0.01% per trade gross, i.e. a small bounce. No controls, and below costs [weak] ([blog](https://blog.amberdata.io/liquidations-on-perpetual-futures-contracts-as-a-leading-indicator-of-market-movement)).

---

## 2. Open interest math

### 2.1 The identity

For one perp trade of size q (base units) between a taker and a maker:

| What the two sides do | ΔOI |
|---|---|
| Both open | +q |
| Both close | −q |
| One opens, one closes | 0 (position flips split the same way) |

Summing over all trades in a window gives **ΔOI_W = Σ ε_j q_j, with ε_j ∈ [−1, 1], so |ΔOI_W| ≤ Vol_W.** That yields a bounded, scale-free **opening ratio**:

**ρ_W = ΔOI_W / Vol_W ∈ [−1, 1]** = (volume where both sides opened − volume where both sides closed) / volume

- The bound holds only for the **same venue and instrument**, in base units, with aligned timestamps. Fills that bypass the public tape (for example ADL) can break it slightly.
- One equation cannot identify which side opened. ΔOI > 0 during buy-dominant flow is *consistent with* takers opening longs against makers opening shorts. It is not proof, because taker sellers in the same window could be the ones opening.

### 2.2 Split at the extreme

A candle's net ΔOI > 0 could be new longs on the push *or* new shorts on the rejection. A net ΔOI < 0 could be short covering on the push *or* longs flushing on the drop. So split it into legs:

- **t_ext**: time of the extreme, from 1m candles of the same market. Footprint rows carry no time.
- **t_entry**: end of the last 1m bar before t_ext whose low < T, where T = max(O, C). This is when price entered the wick zone.
- **t_exit**: end of the first 1m bar after t_ext whose high < T.
- **Push leg:** ΔOI_U = OI(t_ext) − OI(t_entry).
- **Rejection leg:** ΔOI_D = OI(t_exit) − OI(t_ext).

Measuring from t_entry rather than t_open keeps a long ranging phase before a late spike out of the push leg.

> **Erratum (2026-10-06, review of the shipped detector).** The "Reclassify" row below claims more than open interest can show. Net ΔOI < 0 during buy-dominant flow says that positions closed on net in the window; it does not say that the aggressive buyers in the wick were the ones closing, because opening and closing happen on both sides at once and one equation cannot attribute them (see the second bullet of 2.1). Nothing here has been tested as a predictor either. The app therefore does not reclassify on open interest (`docs/trapped-traders.md`, "Next"): open interest may be shown as aligned, same-venue measured context, and the flag keeps its name. The table is kept as the agent wrote it.

**Regimes for a buy-dominant upper wick that closes far lower:**

| ΔOI_U | ΔOI_D | Reading | Label |
|---|---|---|---|
| ↑ | ↓ | Positions opened into the high; OI fell on the drop (longs exiting) | "possible trapped longs, being flushed" |
| ↑ | ↑ or ~0 | New longs at the high; the drop added shorts | "possible trapped longs, OI suggests still open" |
| ↓ | any | The buying at the high was mostly **closing** (short covering or short liquidations); the aggressors left | **Reclassify: "short-covering spike, rejected"** |
| ~0 | any | Inconclusive | "possible (OI inconclusive)" |

- Trapped sellers are the mirror image: ΔOI_U ↑ means new shorts; ΔOI_U ↓ means long liquidation.
- The size of the trapped inventory cannot be identified, because the OI drop in D may come from older longs. Show the fact ("net OI since the push: +x BTC"), not an estimate.

### 2.3 Resolvability on a 5-minute grid (g = 5 min)

- **Sampling:** OI(t) is an as-of value, meaning the last sample at or before t.
- **Resolvable:** each leg crosses at least one sample boundary.
- **Clean:** each leg is at least 2g long. Shorter legs get the label "coarse".
- **Consequence:** wick legs are short, so clean separation needs timeframes of roughly **30m and up**. 15m is often only "coarse".
- **1–3m candles:** the per-candle OI bars are repeated 5m samples. A per-candle ΔOI of zero is spurious, so show **"OI not resolvable"** instead of computing it.
- **Per-candle ΔOI:** use close_k − close_{k−1}, not close − open. The bar's open is its first sample inside, so close − open drops one interval.
- **The latest candle:** the D leg stays **"pending"** until a sample later than t_exit exists. Never show it as "flat".

### 2.4 Normalisation

- Use **base-coin OI**. USD OI moves mechanically with price.
- Score each leg as a robust z: **z_W = ΔOI_W / (σ̂_g·√n_W)**.
  - σ̂_g = 1.4826·MAD of 5m ΔOI over the trailing 288 samples.
  - n_W = number of 5m intervals in the leg.
  - The √n scaling assumes weak autocorrelation, so check it.
- Report ρ_W as well when OI and volume come from the same venue.
- Labels: "rose" when z ≥ z\*, "fell" when z ≤ −z\*. Use z\* = 1 as a placeholder, and **set the final thresholds from the training split**.

### 2.5 Venue mismatch and missing OI

- **Footprint market is the OI venue's perp** (Binance BTCUSDT): full labels plus the reclassification rule.
- **A different perp** (for example Hyperliquid footprint with Binance OI): context label "Binance perp OI", z only, never a veto. Price is arbitrage-linked; positioning is not.
- **Hyperliquid's own OI:** use it only when live samples sit within g/2 of each leg boundary. Reuse `weakOi`.
- **Spot:** perp OI says nothing about whether spot buyers are leveraged. Show it as context only and never reclassify.
- **No OI:** the detector runs on flow only, and the hover says "OI unavailable".
- **Persist OI on the server.** The REST history covers only the latest month ("Only the data of the latest 1 month is available", [docs](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Open-Interest-Statistics)).

### 2.6 Pitfalls

- **Timestamp semantics** (snapshot vs period end). Verify by cross-correlating ΔOI with signed volume at lags −1, 0 and +1. If unsure, lag OI by one sample.
- **Dated futures** cause expiry drops in aggregated OI.
- **Cash-and-carry basis trades** add OI without any directional view.
- **Opening and closing cancel inside a window.** ΔOI ≈ 0 does not mean nobody opened.
- **Partial view.** One venue holds only a share of BTC positioning.

### 2.7 Liquidations and funding

- **Liquidations would help materially.** Forced flow in the zone separates a squeeze from a trap: zone delta minus liquidations ≈ voluntary aggression.
  - Binance pushes at most one liquidation per symbol per 1000 ms. Per [snippet], since 2026-04-10 that is the *largest* one rather than the latest.
  - So the feed is a lower bound ([Binance](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Liquidation-Order-Streams), [Tardis](https://docs.tardis.dev/historical-data-details/binance-futures)).
- **Funding adds little at candle level.** It is a slow prior on crowding, useful later to split results by regime.

---

## 3. Detection spec

### 3.0 Prerequisites

1. **Make it zoom-independent.**
   - `FootprintData.ensure` loads only the visible window, at a zoom-driven row step. The detector needs its own fetch: the event candles plus L + 20 bars of history.
   - It should run at a **canonical step** s\* = fine·2^k, where k is the smallest integer giving ATR_i/s\* ≤ 64.
   - Cache the result per (instrument, timeframe, t). Display grouping only decides which displayed rows pulse.
2. **Units.** Flow is USD (`buyUsd`, `sellUsd`, row USD). Normalise with footprint sums, never `CandleRow[5]`.
3. **Footprint history.** Retention is 7 days on the server and 24 h in the browser engine.
   - This limits only M, the delta baseline. ATR comes from OHLC, which goes further back.
   - Set L = min(72, available) and require at least 24 bars; otherwise show "baseline warming up".
   - That leaves 4h running with L ≈ 40, and 1d **disabled**, because M cannot be formed.
4. **A closed candle is not final yet.** Late prints still arrive (the client refreshes every 5 s).
   - Evaluate at close + 15 s.
   - Re-evaluate until close + 60 s, then freeze.
   - Never flag a candle that is still forming.

### 3.1 Notation (candle i)

- Rows r at step s\*, with mid m_r; B_r and S_r in USD.
- D_r = B_r − S_r; V_r = B_r + S_r; R = H − L.
- **ATR_i** = mean true range over candles i−20…i−1.
- **M_i** = median of |buyUsd − sellUsd| over candles i−L…i−1.

### 3.2 Trapped buyers (upper wick)

- **Zone:** T = max(O, C); Z = {r : m_r ≥ T}.
- **G1 (geometry):** w = (H − T)/R ≥ **⅓**.
- **G2 (resolution):** |Z| ≥ **3** rows. Otherwise "insufficient resolution", no flag.
- **F1 (concentration, no parameter):**
  - D_Z = Σ_{r∈Z} D_r > 0, and
  - D_Z ≥ max D_b over every contiguous block b of |Z| rows lying entirely below T.
  - If the region below T is shorter than |Z| rows, compare D_Z with D_rest instead.
  - In words: "the wick out-bought every equal-height slice of the rest of the candle".
- **F2 (magnitude):** D_Z ≥ **k_D·M_i**, with k_D = 1.
- **Entry price:** P_Z = Σ_Z B_r m_r / Σ_Z B_r, the buy-VWAP of the zone.
- **E (adverse excursion):** u = (P_Z − C)/ATR_i ≥ **0.5**.
- **Flag** = G1 ∧ G2 ∧ F1 ∧ F2 ∧ E.
- **Pulsing cells:** the rows in Z where `imbalance(B_r, S_r) === 'buy'`, mapped onto the display rows that contain them.

### 3.3 Trapped sellers (mirror)

- T′ = min(O, C); Z = {m_r < T′}; w = (T′ − L)/R ≥ ⅓.
- D_Z < 0, and −D_Z ≥ the max of −D_b over equal-height blocks above T′.
- −D_Z ≥ M_i.
- P_Z = sell-VWAP of the zone; u = (C − P_Z)/ATR_i ≥ 0.5.
- Both flags may fire on the same candle.

### 3.4 Tiers

Every tier says "possible". Tiers describe the evidence, not a probability.

- **T1 "Possible trapped buyers (flow only)":** the default when OI is unavailable, not resolvable, or from another venue.
- **T2 "Possible trapped buyers: OI consistent with new longs":** T1 plus ΔOI_U "rose" (same-venue perp, legs resolvable). Add the D-leg sub-label from 2.2.
- **A separate event, "Short-covering spike, rejected":** ΔOI_U "fell". It gets a distinct marker that does not pulse.
- Use "likely" only after the holdout in section 4 passes.

### 3.5 Lifecycle

States: forming → settling → active → one of reclaimed, retest, extended, expired.

- **Settling:** close + 15–60 s, with OI shown as "pending".
- **Active:** the cells pulse.
- **Reclaimed:** a later candle *closes* above P_Z. Stop pulsing and show a faded "reclaimed hh:mm".
- **Retest:** a wick touches P_Z. Informational; record the sell imbalance at the retest.
- **Extended:** price trades below the event candle's low. Informational.
- **Expired:** after L bars.
- **Pulse limits:** pulse for at most 12 bars, then show a static tint.
- **No outcome claims.** The UI never claims an outcome for recent events, because their follow-through is unknown by construction.

### 3.6 Parameters

| Parameter | Default | Rationale |
|---|---|---|
| w\* | ⅓ | Tercile of the range |
| k_D | 1 | Unit-free: "a typical candle's whole delta, concentrated in the wick" |
| u\* | 0.5 ATR | Half a typical range |
| Minimum zone rows | 3 | Quantisation floor |
| ATR / baseline length | 20 / 72 | 72 = the app's `DEFAULT_HIGHLIGHT.length` |
| OI z\* | 1 | Placeholder until calibrated |

**Pre-registered grid:** w\* ∈ {¼, ⅓, ½}, k_D ∈ {0.5, 1, 2}, u\* ∈ {0.25, 0.5, 1}.
- Select on the design split by **plateau stability**, not by peak.
- Report all 27 configurations on the holdout.

### 3.7 Hover text

> **Possible trapped buyers.** $4.1M net aggressive buying in the upper wick (2.3× a typical candle's delta), average entry $86,640; the candle closed 0.8 ATR below it. If these buyers still hold, they are underwater. *[T2] Binance perp OI rose 0.9% (z = 2.1) during the push, consistent with new longs; it fell on the drop (longs exiting).* Untested pattern; not a forecast.

---

## 4. Honest validation

### 4.1 Data

- **Binance USD-M BTCUSDT `aggTrades`** ([data.binance.vision](https://github.com/binance/binance-public-data)).
  - `is_buyer_maker` = true means the aggressor was a seller.
  - Rebuild footprints at $0.5 rows, then apply s\*.
  - I believe liquidation fills appear as ordinary taker trades. Verify this.
- **`metrics` archive** (`futures/um/daily/metrics/BTCUSDT`): 5-minute `sum_open_interest` (BTC) from 2020-09-01, about 99.9% complete ([dataset card](https://huggingface.co/datasets/Mindbyte-89/btcusdt_perp_metrics_5m_09_2020_to_04_2026)).
- **1m klines** for t_ext, t_entry and t_exit; **spot `aggTrades`** for the spot variant.
- **Optional:**
  - Tardis: OI about every 6 s since 2020-05, plus `forceOrder` (a lower bound). The first day of each month is free ([Tardis](https://docs.tardis.dev/historical-data-details/binance-futures)).
  - Hyperliquid S3 fills and `asset_ctxs`. Requester pays, and "no guarantee of timely updates" ([HL](https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data)).
  - Bybit public trades.
- **Replication:** ETH and SOL perps with identical code and no retuning.

### 4.2 Splits

| Split | Period |
|---|---|
| Design | 2021-01 → 2022-12 |
| Validation | 2023-01 → 2024-06 |
| Frozen holdout | 2024-07 → 2026-06, run once |

- Embargo between splits: at least the longest horizon plus L bars.
- Every baseline is trailing.

### 4.3 Endpoints (pre-registered)

- **Entry:** the **first trade at or after close + 15 s**, which is when the flag first exists. As a simpler variant, use the next bar's open. Report which one.
- **Primary:** 15m candles, horizon 4 bars.
  - y = −(P_{entry+4 bars} − P_entry)/ATR_i, sign-flipped for sellers, so positive means "against the trapped side".
  - Compare the mean y of events with the matched control C1.
- **Co-primary (tells the theories apart):** P(price revisits P_Z within 12 bars), events vs C1.
  - The trapped theory predicts fewer revisits, or rejection on the revisit (sell imbalance at the retest, in line with Kaustia).
  - Unfinished auction / poor high predicts **more** revisits.
- **Secondary (Holm-corrected):**
  - 5m and 1h candles.
  - Horizons of 1 and 12 bars.
  - The candle low breaks within 12 bars (Osler-type cascade).
  - T2 vs T1 vs short-covering spikes. Prediction: T2 strongest, spikes weakest.

### 4.4 Controls and nulls

- **C1, shape-matched (the key control):** passes G1, G2 and E, with zone delta ≥ 0 but **not** dominant (fails F1 or F2).
  - Coarsened exact matching on u, w, R/ATR, candle |delta|/M, the candle's own return, hour of day (4 buckets), ATR/price tercile, and year.
  - This isolates what the footprint adds beyond a shooting-star candle, and it absorbs the generic crypto reversal.
- **C2, opposite sign:** a separate arm. Same geometry, zone delta < 0 (sellers aggressive in the wick). Keep it apart from C1 so strong seller rejections don't contaminate C1.
- **Permutation null:**
  - Keep each row's V_r and permute the row buy-shares β_r = B_r/V_r across the rows of each candle.
  - Rebuild B and S, and **re-run the full detector on the whole population**, so the selection step is inside the null.
  - Recompute event − C1. Use 1,000 permutations; p = (1 + #{null ≥ observed})/1001.
- **Placebo:** shift flags by ±k bars.
- **Confidence intervals:** stationary block bootstrap with one-day blocks, clustered by day.

### 4.5 Effect size and sample size

**Worth showing the user** only if all of these hold:
- the holdout effect is ≥ **0.10 ATR**, with a 95% CI excluding 0, **or** the revisit rate differs by ≥ 5 pp;
- the sign is the same in at least 4 of 5 yearly folds;
- stability = Median_folds − 0.5·Std_folds > 0;
- permutation p < 0.01.

At 15m, 0.1 ATR is probably a few basis points, below taker round-trip cost. Even a real effect is a context aid, not a strategy. Measure this rather than assume it.

**Power** (α = 0.05, 80%):

| Effect size | Formula | n per arm |
|---|---|---|
| 5 pp | 2·7.85·p(1−p)/d² | ≈ 1,570 |
| 3 pp | 2·7.85·p(1−p)/d² | ≈ 4,360 |
| 0.1 ATR, with σ ≈ 1.75 ATR (measure it) | 2·7.85·σ²/d² | ≈ 4,800, times a design effect of 1.5–2 |

- If about 1% of 15m candles flag, that is about 350 events a year.
- A two-year holdout therefore detects only effects of about 0.25 ATR, or 8 pp and up.
- So pre-register pooling: 5m candles, or replication on ETH and SOL.

### 4.6 Leakage checklist

- ATR and M trailing.
- OI joined as-of, with a check at one sample of lag.
- t_ext and t_exit taken only from 1m data at or before the evaluation time.
- Entry after the flag exists.
- Thresholds fixed on the design split.
- Holdout touched once.
- The full surface of 27 configurations reported.

### 4.7 What the UI may claim

- **Before validation:** facts plus "possible", with an "untested pattern" note.
- **After a passing holdout:** measured base rates. For example: "BTC 15m 2024–26: similar events revisited their entry within 3 h X% vs Y% for look-alike candles."

---

## 5. Recommendation

**v1: a pure function, no new feeds.**
- `detectTraps(bars, candles, fine, opts)`, run on closed and settled candles at s\*, with its own baseline fetch.
- Gates G1, G2, F1, F2 and E; the lifecycle from 3.5; pulse on the zone's imbalanced rows; the fact-first hover.
- Timeframes 1m–4h; 1d off.
- Unit tests, including zoom invariance.

**v1.1: OI refinement.**
- Leg-split OI labels only where resolvable: 1m t_entry, t_ext and t_exit available; "clean" mostly at 30m and up; "coarse" at 15m.
- Labels plus the short-covering reclassification only when the footprint market is the OI venue's perp.
- Context-only labels for other perps and spot.
- "Not resolvable" for 1–3m, "pending" for the latest candle.
- The server persists OI beyond 30 days.

**Leave out:**
- Size-bucket stats (per candle only, so they can't be pinned to the zone).
- λ-absorption scores.
- Unfinished-auction markers.
- Funding.
- Inferred liquidations.
- Any continuous "probability".
- Multi-candle zones.
- Sounds.
- Flags on forming candles.

**Top 3 ways this could mislead:**

1. **Squeezes and stop runs labelled as traps.** Buy delta at a high is often forced short covering or short liquidations (Osler stop clusters, round numbers). Those aggressors already exited. Without leg-split OI or liquidation data, this cannot be told apart.
2. **Hindsight and base rate.** The flag is *defined* by a reversal that has already happened. Partial impact reversal (about ⅓ of the peak) and the generic 15m crypto reversal make "price fell after buying the top" normal. The SPY test (73.7% vs 74.3% baseline) shows how a pattern can look as if it works when it is only the base rate. Pulsing adds salience to an untested signal.
3. **Measurement artifacts.** Flags can shift with zoom or row grouping, with a missing baseline, or with late prints. Single-venue delta may be one leg of a cross-venue arbitrage. OI may come from another venue, or be stale or coarse, and pending OI may be shown as flat. The mitigations: the canonical step, the separate baseline fetch, the settle-and-freeze rule, and explicit "not resolvable" and "pending" states.
