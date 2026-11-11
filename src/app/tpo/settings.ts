/**
 * The TPO's settings (Time Price Opportunity, the Market Profile; Karl, 2026-11-10; README "TPO (Market Profile)"): whether it
 * shows; the windows it draws (each day or week in the Volume profile's zone, or its sessions) and how many; the length of a block (the
 * half hour each letter stands for, four hours for a week by default); the size of a row (Auto from the coin's typical day, or a price
 * chosen for that coin); how it is drawn (blocks, letters or Auto by zoom; coloured by the time of the block or by how full the row is);
 * folded into profiles or laid out in time; the value area's share; which marks show; whether the Volume profile's lines follow the
 * TPO's levels; whose candles it is worked out from (the chart market's, or markets chosen as the VWAP's are); and the windows split or
 * merged by hand, per coin, kind of window and block length.
 */
import { readVwapPicks, type VwapSource } from '../vwap/markets.ts';

const DAY = 86_400_000;
/**
 * How far back the TPO's candles are kept (Karl, 2026-11-11: "make it also work with loading historical data"): about thirteen months, so
 * a day a year back or twenty weeks can be drawn. The other venues' candles that mark hollow blocks are read two months back at most (a
 * year of every venue switched on would be hundreds of requests); the daily candles Auto rows come from, a year and the weeks before it.
 */
export const TPO_REACH_MS = 400 * DAY, TPO_DAYS_REACH_MS = 475 * DAY;

export type TpoPeriod = 'day' | 'week' | 'sessions';
export const TPO_PERIODS: readonly TpoPeriod[] = ['day', 'week', 'sessions'];
/** Blocks: letters while a block is tall enough, else plain blocks (`auto`), or always one of the two. */
export type TpoLook = 'auto' | 'blocks' | 'letters';
/** A block's colour: the time of its half hour (early to late), or how many blocks its row holds (thin to full). */
export type TpoColour = 'time' | 'count';
/** Block lengths offered, in minutes (0: by the period, 30 for a day or a session, 240 for a week). */
export const TPO_BLOCKS: readonly number[] = [0, 15, 30, 60, 240];

export interface TpoSettings {
  on: boolean;
  period: TpoPeriod;
  /** Minutes per block, one of `TPO_BLOCKS` (0: the period's own). */
  block: number;
  /** How many of the latest windows up to the chart's right edge are drawn, the one under way among them; 0: every window in view. */
  count: number;
  /** Whose candles: the chart market's (or the one standing in for it), or the markets chosen (`picks`, as the VWAP's: `vwap/markets.ts`). */
  source: VwapSource;
  /** The markets chosen, as exchange and kind (`binance/spot`), at most `MAX_VWAP_MARKETS`: kept when the source is the chart's again. */
  picks: string[];
  look: TpoLook;
  colour: TpoColour;
  /** The value area's share of the TPOs, in percent. */
  share: number;
  /** Laid out in time (each block in its own column at its half hour) instead of folded into the profile. */
  unfold: boolean;
  /** Blocks where only this market's wick went past the rest of the market are drawn hollow (tpo/agreement.ts). */
  hollow: boolean;
  /** The initial balance's bracket, the open and close marks. */
  ib: boolean;
  /** The extremes' calls (tail or poor, with how many row grids agree) and the single prints. */
  calls: boolean;
  /** The few numbers under each profile (range, initial balance, TPOs above and below the point of control). */
  stats: boolean;
  /** While the TPO shows, the Volume profile's lines of the same windows are drawn at the TPO's levels (one set of lines, never two). */
  lines: boolean;
  /** A row's price per coin, where one was chosen (none: Auto). */
  rows: Record<string, number>;
  /**
   * Splits per coin, kind of window and block length (`editScope`): each `moment@window key`, a calendar window cut in two at the block
   * nearest the moment (tpo/model.ts `editedWindows`).
   */
  splits: Record<string, string[]>;
  /** Merges per coin, kind of window and block length: each a calendar window's key, joined from its start to the window that ends there. */
  merges: Record<string, string[]>;
  /** The settings' revision: 2 since every window in view became the default (a count of 5 saved before was the old default). */
  v: number;
}

export const TPO_DEFAULTS: Readonly<TpoSettings> = {
  on: false, period: 'day', block: 0, count: 0, source: 'chart', picks: [], look: 'auto', colour: 'time', share: 70, unfold: false, hollow: true,
  ib: true, calls: true, stats: true, lines: true, rows: {}, splits: {}, merges: {}, v: 2,
};

export const MAX_TPO_COUNT = 20;
/**
 * Every window in view is at most this many of each kind (a session's, a day's: as many days as the candles are kept), and `MAX_TPO_DRAWN`
 * in all (several sessions a day): zoomed out further, the newest of them.
 */
export const MAX_TPO_IN_VIEW = 400, MAX_TPO_DRAWN = 800;
/** The most candles of one market a TPO keeps: a year of half hours, five months of five minutes, four weeks of minutes. */
export const TPO_MAX_BARS = 40_000;
/** Coins whose own rows are kept, and scopes of edits (three per coin), the oldest going first. */
const MAX_COINS = 20;
/** Splits and merges kept per coin. */
const MAX_EDITS = 40;

const flag = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;
const coinKey = (coin: string): boolean => /^[A-Z0-9]{1,20}$/.test(coin);
/** The edits of one coin, kind of window and block length are kept together: a day's split never cuts a week. */
export const editScope = (coin: string, period: TpoPeriod, blockMs: number): string => `${coin}|${period}|${Math.round(blockMs / 60_000)}`;
const scopeKey = (key: string): boolean => /^[A-Z0-9]{1,20}\|(day|week|sessions)\|\d{1,4}$/.test(key);

function edits(saved: unknown, entry: (e: string) => boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!saved || typeof saved !== 'object') return out;
  for (const [scope, list] of Object.entries(saved as Record<string, unknown>).slice(-MAX_COINS * 3)) {
    if (!scopeKey(scope) || !Array.isArray(list)) continue;
    const ok = [...new Set(list.filter((e): e is string => typeof e === 'string' && e.length <= 300 && entry(e)))].slice(-MAX_EDITS);
    if (ok.length) out[scope] = ok;
  }
  return out;
}
const splitEntry = (e: string): boolean => /^\d{10,14}@.+$/.test(e);

/** Settings from storage, field by field: whatever is missing or not valid falls back to the default. */
export function readTpo(saved: unknown): TpoSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof TpoSettings, unknown>>, d = TPO_DEFAULTS;
  const rows: Record<string, number> = {};
  // A row as fine as a billionth of a dollar stays possible (a coin priced in millionths); the profile refuses more than its rows' limit.
  if (s.rows && typeof s.rows === 'object') for (const [coin, v] of Object.entries(s.rows as Record<string, unknown>).slice(-MAX_COINS)) if (coinKey(coin) && typeof v === 'number' && Number.isFinite(v) && v >= 1e-12 && v <= 1e9) rows[coin] = v;
  let count = typeof s.count === 'number' && Number.isInteger(s.count) && s.count >= 0 && s.count <= MAX_TPO_COUNT ? s.count : d.count;
  // Saved before revision 2, a count of 5 was the default nobody chose (the TPO shipped with it on 2026-11-11): every window in view now.
  if (s.v !== 2 && count === 5) count = 0;
  return {
    on: flag(s.on, d.on),
    period: TPO_PERIODS.includes(s.period as TpoPeriod) ? s.period as TpoPeriod : d.period,
    block: typeof s.block === 'number' && TPO_BLOCKS.includes(s.block) ? s.block : d.block,
    count, source: s.source === 'chosen' ? 'chosen' : 'chart', picks: readVwapPicks(s.picks), v: 2,
    look: s.look === 'blocks' || s.look === 'letters' ? s.look : 'auto',
    colour: s.colour === 'count' ? 'count' : 'time',
    share: typeof s.share === 'number' && Number.isFinite(s.share) && s.share >= 50 && s.share <= 90 ? Math.round(s.share) : d.share,
    unfold: flag(s.unfold, d.unfold), hollow: flag(s.hollow, d.hollow), ib: flag(s.ib, d.ib), calls: flag(s.calls, d.calls),
    stats: flag(s.stats, d.stats), lines: flag(s.lines, d.lines), rows, splits: edits(s.splits, splitEntry), merges: edits(s.merges, e => e.length > 0),
  };
}

/** The block length in milliseconds: the one chosen, or the period's own (a week's blocks are four hours: 42 letters a week). */
export const blockMsOf = (s: Pick<TpoSettings, 'block' | 'period'>): number => (s.block > 0 ? s.block : s.period === 'week' ? 240 : 30) * 60_000;

/** The settings with the list `which` of one edit scope (`editScope`) changed by `f` (an empty list is dropped, and the scope with it). */
export function withEdits(s: TpoSettings, which: 'splits' | 'merges', scope: string, f: (list: string[]) => string[]): TpoSettings {
  const list = [...new Set(f([...(s[which][scope] ?? [])]))].slice(-MAX_EDITS);
  const { [scope]: _old, ...others } = s[which];
  return { ...s, [which]: list.length ? { ...others, [scope]: list } : others };
}

/** The settings with a row price chosen for `coin` (0: Auto again). */
export function withRows(s: TpoSettings, coin: string, price: number): TpoSettings {
  const { [coin]: _old, ...others } = s.rows;
  return { ...s, rows: price > 0 ? { ...others, [coin]: price } : others };
}
