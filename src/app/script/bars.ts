/**
 * How many of the chart's candles scripts read (Karl, 2026-11-10: "at least 10K ... a configuration ... that also lets the user choose even
 * more"): the setting's choices, and the default: 10,000, or 2,000 on a phone, whose page reads less. The chart's market's own candles of the
 * chart's timeframe, read from the exchange once the map has its first data, and handed to the scripts whole (`HeatPane.scriptCandles`): the
 * window functions answer in constant time (2026-11-10), so 10,000 candles run from the first in about a third of a second for the VWAP
 * starter and under two seconds for the heat map starter on this PC; a run from the first candle has ten seconds (`FULL_RUN_MS`).
 */
export const SCRIPT_BARS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 50_000, 100_000];
/** The most a script can read: the last choice, and the longest a window can be (`MAX_WINDOW`). */
export const MOST_SCRIPT_BARS = SCRIPT_BARS[SCRIPT_BARS.length - 1]!;
export const scriptBarsDefault = (phone: boolean): number => phone ? 2_000 : 10_000;
/** A saved choice, or the default where there is none or it is not one of `SCRIPT_BARS`. */
export const readScriptBars = (saved: unknown, phone: boolean): number => SCRIPT_BARS.includes(saved as number) ? saved as number : scriptBarsDefault(phone);

/**
 * How many candles the scripts' first candle moves by at a time: the series runs from `scriptStart`, which stays where it is until there
 * are this many more candles than the setting, so a script runs from its first candle once for so many candles, not at every new one.
 */
export const scriptChunk = (bars: number): number => Math.max(1_000, Math.round(bars / 10));

/** Where the scripts' candles begin: the setting's count of candles back from now, on a chunk's boundary (it moves a chunk at a time). */
export function scriptStart(now: number, tfMs: number, bars: number): number {
  const chunk = scriptChunk(bars) * tfMs;
  return Math.floor((now - bars * tfMs) / chunk) * chunk;
}

/**
 * How the scripts' candles stand, for the Scripts panel: read from the exchange and handed to the scripts ('ready'), being read (`have` of
 * `want` so far), held but fewer than asked because the exchange has no more of this market or serves no older ones ('short'), not read just
 * now and tried again in a minute ('failed'), or not read at all because the chart's market has no history the page can read, or the chart
 * shows another market's candles ('none'). `market` names whose candles they are.
 */
export interface ScriptBarsState { state: 'ready' | 'loading' | 'short' | 'failed' | 'none'; have: number; want: number; market: string }
