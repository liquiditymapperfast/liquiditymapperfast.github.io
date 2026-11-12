import type { AppState } from '../store.ts';
import type { View } from '../view.ts';
import type { Palette } from '../theme.ts';
import type { LabelBoard } from '../labels.ts';
import type { InfoLine } from '../infobox.ts';
import { t } from '../i18n.ts';
import { clock, price as fmtPrice } from '../format.ts';
import { currentCoin } from '../coin.ts';
import { venueLabel } from '../venues.ts';
import { historyTarget, type HistoryTarget, type KeyLevelHistory } from '../keylevels/history.ts';
import { MAX_BACK_MS } from '../keylevels/levels.ts';
import { LinesCalendar, periodWindows } from '../traded/levels.ts';
import { lastWindows, type ProfileWindow } from '../traded/sessions.ts';
import { vwapTargets } from '../vwap/markets.ts';
import type { ValueLevels } from '../../shared/profile.ts';
import { TIMEFRAMES } from '../../shared/series.ts';
import { autoRows, blockStart, blocksOf, buildProfile, editedWindows, firstBarAt, hollowRows, letterOf, levelsOfProfile, mergeBlocks, overshootOf, trailingGaps, withLive, type Block, type EditedWindow, type Part, type Peer, type TpoProfile } from './model.ts';
import { MAX_TPO_DRAWN, MAX_TPO_IN_VIEW, TPO_REACH_MS, blockMsOf, editScope, type TpoSettings } from './settings.ts';
import { cellAt, paintLit, paintTpo, type TpoGeometry } from './paint.ts';
import type { TpoInfo } from './panel.ts';

/**
 * The TPO on the map (tpo/): which windows it draws (the Volume profile's days, weeks or sessions in its zone, the latest few or every one in
 * view, edited by hand, and a Range's composite), the candles they are read from (the chart market's own where its history can be read, as
 * the key levels', or markets chosen as the VWAP's, kept about thirteen months back: `TPO_REACH_MS`), the daily candles its Auto rows come
 * from (those before the days shown), the other markets' candles that say which blocks stood alone, the profiles worked out from them (kept
 * until what they come from changes), the fold into time and back, and what is under the pointer. The heat pane asks for it each frame
 * (`ensure`, `paint`) and the Volume profile's lines read its levels (`levels`).
 */

const MIN = 60_000, DAY = 86_400_000;
/** How long the fold into time and back takes. */
const FOLD_MS = 240;
/** How far back the calendar is read for the candle size (a window on another daylight-saving offset needs a size that fits it too). */
const BAR_LOOKBACK = TPO_REACH_MS + 7 * DAY;
/** Auto rows are read again from the days before the chart's right edge once it is this far back, on a grid of this step (so panning moves them rarely). */
const AUTO_STEP = 28 * DAY;

/** A market as the panel and the box under the pointer name it: its exchange and its own name for the coin. */
const marketName = (target: HistoryTarget): string => `${venueLabel(target.id)} ${target.listing.symbol}`;

/**
 * Where the blocks worked out for windows ending at `last` stop: after its last block, or after the block under way (on the grid at offset
 * `residue`), whichever is first. A block's end, never the time now, so what they are worked out from is the same from frame to frame.
 */
const spanEnd = (now: number, last: number, residue: number, blockMs: number): number =>
  Math.min(residue + Math.ceil((last - residue) / blockMs) * blockMs, residue + Math.floor((now - residue) / blockMs) * blockMs + blockMs);

/** A gap at any moment: the one at the latest block at or before it that had one (a market's block where the chart market had none). */
function gapLookup(gaps: ReadonlyMap<number, number>): (t: number) => number {
  const times = [...gaps.keys()].sort((a, b) => a - b);
  return t => {
    const exact = gaps.get(t);
    if (exact !== undefined) return exact;
    let a = 0, z = times.length;
    while (a < z) { const m = (a + z) >> 1; if (times[m]! <= t) a = m + 1; else z = m; }
    return a > 0 ? gaps.get(times[a - 1]!)! : 0;
  };
}

export interface TpoHub { tpoHistory(id: string, barMs: number, kind: 'main' | 'peer' | 'days'): KeyLevelHistory }

/** A window drawn: an edited calendar window (`EditedWindow`) or a Range's composite (`base` 'range'), and its name. */
export type TpoWindow = EditedWindow & { name: string };

/** What a frame gives the layer. */
export interface TpoFrame {
  state: AppState; view: View; pw: number; ph: number; now: number; replay: boolean;
  /** The markets switched on inside the Spot / Perp filter (`flowIds`), whose candles judge which blocks stood alone. */
  peerIds: readonly string[];
  /** A calendar window's name as the map writes it (Nov 9, Week, London). */
  nameOf?: (w: ProfileWindow) => string;
}

/** The candle size blocks are built from: the block's own where every window starts and ends on it, else the largest that divides both. */
export function barFor(blockMs: number, windows: readonly { from: number; to: number }[]): number {
  for (const b of [blockMs, 60 * MIN, 30 * MIN, 15 * MIN, 5 * MIN, MIN]) if (b <= blockMs && blockMs % b === 0 && windows.every(w => w.from % b === 0 && w.to % b === 0)) return b;
  return MIN;
}

/** Where a window's blocks fall: its start's offset on the grid of blocks (windows on one offset share their blocks' starts). */
const residueOf = (from: number, blockMs: number): number => ((from % blockMs) + blockMs) % blockMs;

/** A number's bits, for `#spanSig`. */
const F64 = new Float64Array(1), U32 = new Uint32Array(F64.buffer);

/** Once the frame is drawn (a profile left for the next frame asks for it). */
const later = (fn: () => void): void => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn); else setTimeout(fn, 16); };

/** What every window of one frame shares (`#ctx`), worked out once for all of them. */
interface FrameCtx {
  s: TpoSettings; target: HistoryTarget | null; R: number; blockMs: number; barMs: number; main: KeyLevelHistory | null;
  windows: TpoWindow[]; first: number; last: number;
  /** The chosen markets and their histories (none for the chart market's own candles). */
  markets: HistoryTarget[]; hs: KeyLevelHistory[];
  /** What a profile is worked out with beside its candles: kept while a market is on its way again only when this is the same. */
  ident: string;
  /** Rows tall enough for cells (under 1.6 px every profile is drawn compact, which counts each block's own rows: no hollow marks then). */
  cells: boolean;
}

export class TpoLayer {
  #geos: TpoGeometry[] = [];
  #profiles = new Map<string, { key: string; ident: string; hold: string; profile: TpoProfile | null }>();
  /** Each window's hollow rows and the other markets' blocks they were judged on (`#hollowOfWindow`), by window key. */
  #hollowWin = new Map<string, { key: string; byBlock: Map<number, Set<number>>; peers: Peer[]; sig: string }>();
  /** How much of this frame's work is left (`profiles`): past `end`, the windows not worked out yet wait for the next frame. */
  #budget = { end: Infinity, built: 0, deferred: false };
  /** What the windows' names were written for (sessions, zone, page clock): any change writes them again. */
  #namesFor = '';
  /** What a history's candles in a span add up to (`#spanSig`), per history, span and version. */
  #sigs = new Map<string, { version: number; sig: string }>();
  /** Histories that could not be read at all (no candles yet): a window does not wait for them while they try again. */
  #down = new Set<string>();
  /** The calendar of the TPO's kind of window over the whole reach, oldest first, worked out once a day (`#calendarOf`). */
  #calendar: { key: string; list: ProfileWindow[] } | null = null;
  #fold = { target: 0, from: 0, start: 0 };
  /** Auto's row size per coin, period, market and days read (`#asOf`), with the version of the daily candles it was read from. */
  #autoR = new Map<string, { version: string; r: number }>();
  /** The last Auto size known per coin, period and market: drawn with while the days before the chart's right edge are on their way. */
  #autoLast = new Map<string, number>();
  /**
   * How far back a window the lines asked about reaches (`levels`), for the chart market, kind of window and block it was asked on: any
   * other starts again.
   */
  #reach = { id: '', from: Infinity };
  #drawn: { key: string; windows: TpoWindow[]; first: number; last: number } | null = null;
  /** The windows' names by key (`windows`). */
  #names = new Map<string, string>();
  /** The last few windows (a count under How many), picked from a calendar laid out once as the chart pans (`LinesCalendar`). */
  readonly #latest = new LinesCalendar();
  #bar: { key: string; barMs: number } | null = null;

  /**
   * `budgetMs`: how long one frame may spend working out profiles (a first look at a year of windows, or a change of rows, is hundreds of
   * them): the newest first, the rest on the frames after, each drawing as it was until then.
   */
  constructor(private hub: TpoHub, private invalidate: () => void, private budgetMs = 12) {}

  /** The chart market's candles (null where no market of the coin has a history the page can read). */
  #target(state: AppState): HistoryTarget | null { return historyTarget(state.marketId, currentCoin()); }

  /** The markets whose candles make the blocks: the chart market's alone, or the chosen ones this coin is listed on (none: no TPO). */
  #markets(f: TpoFrame, target: HistoryTarget | null): HistoryTarget[] {
    const s = f.state.tpo;
    return s.source === 'chosen' ? vwapTargets('chosen', s.picks, f.state.marketId, currentCoin()) : target ? [target] : [];
  }

  /** The calendar of the TPO's kind of window, in the Volume profile's zone and sessions. */
  #kind(f: TpoFrame): { period: TpoSettings['period']; zone: string; sessions: AppState['traded']['sessions'] } {
    return { period: f.state.tpo.period, zone: f.state.traded.zone, sessions: f.state.traded.sessions };
  }

  /**
   * The calendar of the TPO's kind of window over the whole reach and a week ahead, sorted by start: worked out once a day (a year of a day's
   * windows is hundreds of time-zone conversions, too many for a frame), and sliced for the windows in view.
   */
  #calendarOf(f: TpoFrame): ProfileWindow[] {
    const k = this.#kind(f), key = `${k.period}|${k.zone}|${JSON.stringify(k.sessions)}|${f.state.timeZone}|${Math.floor(f.now / DAY)}`;
    if (this.#calendar?.key !== key) {
      // In two halves: the calendar lays out at most 400 days at a time.
      const mid = f.now - 200 * DAY, byKey = new Map<string, ProfileWindow>();
      for (const w of [...periodWindows(k, f.state.timeZone, f.now - BAR_LOOKBACK, mid), ...periodWindows(k, f.state.timeZone, mid, f.now + 7 * DAY)]) byKey.set(w.key, w);
      this.#calendar = { key, list: [...byKey.values()].sort((a, b) => a.from - b.from) };
    }
    return this.#calendar.list;
  }

  /**
   * The candle size, from the calendar alone (every window the candles reach back to, both daylight-saving offsets among them), so the
   * drawn windows, the lines' windows and the requests always agree on it, however far back the chart is.
   */
  barMs(f: TpoFrame): number {
    const blockMs = blockMsOf(f.state.tpo), list = this.#calendarOf(f), key = `${this.#calendar!.key}|${blockMs}`;
    if (this.#bar?.key !== key) this.#bar = { key, barMs: barFor(blockMs, list) };
    return this.#bar.barMs;
  }

  /**
   * Whether a history has said all it will about the time from `from`: it reaches it, or it never will (the market began later, the venue
   * serves nothing older, the history keeps nothing that old, the next try is a minute off) or could not be read at all: such a market
   * stays down until candles come, though each try marks it loading again, so the windows neither wait for it nor blink with its retries.
   */
  #settled(h: KeyLevelHistory, from: number): boolean {
    const key = `${h.id}|${h.barMs}`;
    if (h.bars.length) this.#down.delete(key); else if (h.state === 'unavailable') this.#down.add(key);
    return h.knownFrom <= from || h.exhausted || h.limited || this.#down.has(key) || from < h.keptFrom || h.reach(from) === 'never';
  }

  /**
   * What a history's candles in [from, to) add up to: how many, where they start, and a sum of their prices and volumes, kept per version.
   * A window's profile is keyed by it, so a refresh of the newest candles, or the candles read further back, leaves the other windows as
   * they are.
   */
  #spanSig(h: KeyLevelHistory, from: number, to: number): string {
    const key = `${h.id}|${h.barMs}|${from}|${to}`, held = this.#sigs.get(key);
    if (held?.version === h.version) return held.sig;
    const bars = h.bars, a = firstBarAt(bars, from), z = firstBarAt(bars, to);
    // Two 32-bit hashes of every number's bits (not a sum, where a high up and a low down by as much would cancel).
    let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
    for (let i = a; i < z; i++) {
      const b = bars[i]!;
      for (let j = 0; j < 6; j++) { F64[0] = b[j] ?? 0; h1 = Math.imul(h1 ^ U32[0]!, 0x01000193); h1 = Math.imul(h1 ^ U32[1]!, 0x01000193); h2 = (Math.imul(h2 ^ U32[1]!, 0x85ebca6b) + U32[0]!) | 0; }
    }
    const sig = `${h.id}:${z - a}:${a < z ? bars[a]![0] : ''}:${h1 >>> 0}:${h2 >>> 0}`;
    if (this.#sigs.size > 8000) this.#sigs.clear();
    this.#sigs.set(key, { version: h.version, sig });
    return sig;
  }

  /** What every window of this frame shares. */
  #ctx(f: TpoFrame): FrameCtx {
    const s = f.state.tpo, target = this.#target(f.state), R = this.rows(f), blockMs = blockMsOf(s), barMs = this.barMs(f);
    const windows = target ? this.windows(f) : [], first = this.#drawn?.first ?? Infinity, last = this.#drawn?.last ?? -Infinity;
    const markets = s.source === 'chosen' ? this.#markets(f, target) : [], hs = markets.map(m => this.hub.tpoHistory(m.id, barMs, 'main'));
    return {
      s, target, R, blockMs, barMs, main: target ? this.hub.tpoHistory(target.id, barMs, 'main') : null, windows, first, last, markets, hs,
      ident: `${target?.id}|${s.source}|${markets.map(m => m.id).join(',')}|${R}|${s.share}|${blockMs}|${barMs}|${s.hollow}|${f.replay}`,
      cells: Math.abs(f.view.yOf(0, f.ph) - f.view.yOf(R, f.ph)) >= 1.6,
    };
  }

  /**
   * For the panel: Auto's row size, whose candles (the chart market's, or the chosen markets'), the block's minutes, the markets whose history
   * begins after the oldest window drawn (named, with where it begins), and since when the other venues mark hollow blocks.
   */
  info(f: TpoFrame): TpoInfo {
    const target = this.#target(f.state), markets = this.#markets(f, target), windows = target ? this.windows(f) : [], barMs = this.barMs(f);
    const first = windows.length ? Math.min(...windows.map(w => w.from)) : Infinity, short: { name: string; from: number }[] = [];
    for (const m of f.state.tpo.source === 'chosen' && target && !markets.some(x => x.id === target.id) ? [target, ...markets] : markets) {
      const h = this.hub.tpoHistory(m.id, barMs, 'main');
      if (h.id === m.id && h.bars.length && (h.exhausted || h.limited) && h.knownFrom > first) short.push({ name: marketName(m), from: h.knownFrom });
    }
    const kept = target ? this.hub.tpoHistory(target.id, barMs, 'main').keptFrom : null;
    return { auto: this.auto(f), market: target ? marketName(target) : null, minutes: Math.round(blockMsOf(f.state.tpo) / MIN), names: markets.map(marketName), short, hollowFrom: f.now - MAX_BACK_MS, keptFrom: kept, chosen: f.state.tpo.source === 'chosen' };
  }

  /**
   * The windows drawn: the last `count` up to the chart's right edge, or every one in view (`count` 0: at most `MAX_TPO_IN_VIEW` of each kind,
   * the newest, never older than the candles are kept, and the one before the left edge, which a merge may join), as edited for this coin,
   * kind and block length, and a Range's composite.
   */
  windows(f: TpoFrame): TpoWindow[] {
    const s = f.state.tpo, v = f.view, coin = currentCoin().coin, blockMs = blockMsOf(s), scope = editScope(coin, s.period, blockMs), all = s.count === 0;
    const r = f.state.range, range = r && !r.draft && r.t1 > r.t0 ? `${r.t0}|${r.t1}` : '';
    const key = `${range}|${s.period}|${s.count}|${blockMs}|${f.state.traded.zone}|${JSON.stringify(f.state.traded.sessions)}|${f.state.timeZone}|${scope}|${(s.splits[scope] ?? []).join(',')}|${(s.merges[scope] ?? []).join(',')}|${all ? Math.floor(v.t0 / MIN) : ''}|${Math.floor(v.t1 / MIN)}|${Math.floor(f.now / MIN)}`;
    if (this.#drawn?.key === key) return this.#drawn.windows;
    const span = s.period === 'week' ? 7 * DAY : DAY, right = Math.min(v.t1, f.now);
    let base: ProfileWindow[];
    if (all) {
      // From the day's calendar: those touching the view (and the one before it), never more than the newest `MAX_TPO_IN_VIEW` of each kind
      // could use, nor older than the candles are kept; `MAX_TPO_DRAWN` in all, the newest.
      const list = this.#calendarOf(f), t0 = Math.max(v.t0 - span, right - (MAX_TPO_IN_VIEW + 1) * span, f.now - TPO_REACH_MS), touching: ProfileWindow[] = [];
      let a = 0, z = list.length;
      while (a < z) { const m = (a + z) >> 1; if (list[m]!.from < t0 - 8 * DAY) a = m + 1; else z = m; }
      for (let i = a; i < list.length && list[i]!.from < right; i++) if (list[i]!.to > t0) touching.push(list[i]!);
      base = lastWindows(touching, MAX_TPO_IN_VIEW, f.now);
      if (base.length > MAX_TPO_DRAWN) base = base.slice(-MAX_TPO_DRAWN);
    } else base = this.#latest.windows({ ...f.state.traded, period: s.period }, f.state.timeZone, right, s.count);
    const byKey = new Map(base.map(w => [w.key, w]));
    // A window's name is a date written in its zone, or a session's name: kept by key, so a pan does not write hundreds of dates again,
    // and written again when a session, the zone or the page's clock changes.
    const namesFor = `${JSON.stringify(f.state.traded.sessions)}|${f.state.traded.zone}|${f.state.timeZone}`;
    if (this.#names.size > 4 * MAX_TPO_DRAWN || namesFor !== this.#namesFor) { this.#names.clear(); this.#namesFor = namesFor; }
    const nameOf = (key: string): string => {
      const w = byKey.get(key);
      if (!w) return '';
      let name = this.#names.get(key);
      if (name === undefined) { name = f.nameOf?.(w) ?? w.name; this.#names.set(key, name); }
      return name;
    };
    const windows: TpoWindow[] = editedWindows(base, s.splits[scope] ?? [], s.merges[scope] ?? [], blockMs).map(w => ({ ...w, name: nameOf(w.base) }));
    // A Range selected on the map: the composite of every block in it, drawn last (over the windows it crosses), from its first whole block.
    if (r && range) {
      const from = Math.floor(r.t0 / blockMs) * blockMs, to = Math.ceil(r.t1 / blockMs) * blockMs;
      if (to - from >= blockMs) windows.push({ key: `range|${from}|${to}`, from, to, base: 'range', members: [], spans: [], name: t('Range') });
    }
    this.#drawn = { key, windows, first: Math.min(...windows.map(w => w.from)), last: Math.max(...windows.map(w => w.to)) };
    return windows;
  }

  /**
   * Ask for what the windows drawn and the lines need: the chart market's candles (its blocks, and the prices chosen markets are moved into),
   * the chosen markets', the daily candles before the chart's right edge, and the other venues' for hollow blocks (two months back at most,
   * and only while a window drawn ends within them).
   */
  ensure(f: TpoFrame): void {
    const s = f.state.tpo, target = this.#target(f.state);
    if (!target) return;
    const windows = this.windows(f);
    if (!windows.length) return;
    const reachId = `${target.id}|${s.period}|${blockMsOf(s)}|${s.source}`;
    if (this.#reach.id !== reachId) this.#reach = { id: reachId, from: Infinity };
    const barMs = this.barMs(f), first = Math.min(this.#reach.from, ...windows.map(w => w.from)), last = Math.max(...windows.map(w => w.to)), load = (): void => this.invalidate();
    // A day before the first window: the other markets' usual gaps are read over the day before each block.
    this.hub.tpoHistory(target.id, barMs, 'main').ensure(target, first - DAY, barMs, load);
    if (s.source === 'chosen') for (const m of this.#markets(f, target)) if (m.id !== target.id) this.hub.tpoHistory(m.id, barMs, 'main').ensure(m, first - DAY, barMs, load);
    this.hub.tpoHistory(target.id, DAY, 'days').ensure(target, (this.#asOf(f) ?? f.now) - 75 * DAY, DAY, load);
    const peersFrom = f.now - MAX_BACK_MS;
    if (s.source === 'chart' && s.hollow && last > peersFrom) for (const peer of this.#peers(f, target)) this.hub.tpoHistory(peer.id, barMs, 'peer').ensure(peer, Math.max(first - DAY, peersFrom), barMs, load);
  }

  /** The other markets on the map, each where its history can be read, the chart market's own left out. */
  #peers(f: TpoFrame, target: HistoryTarget): HistoryTarget[] {
    const coin = currentCoin(), out = new Map<string, HistoryTarget>();
    for (const id of f.peerIds) { const h = historyTarget(id, coin); if (h?.own && h.id !== target.id) out.set(h.id, h); }
    return [...out.values()];
  }

  /** The row size: the one chosen for this coin, else Auto from its last complete days (0 until they are read). */
  rows(f: TpoFrame): number {
    const chosen = f.state.tpo.rows[currentCoin().coin];
    return chosen ? chosen : this.auto(f);
  }

  /**
   * Where Auto rows are read up to: null (now) while the chart's right edge is within `AUTO_STEP` of now, else that edge on a grid of
   * `AUTO_STEP`, so a day a year back gets the rows of its own weeks (a coin's price can be several times what it was) and panning moves them
   * once a month at most.
   */
  #asOf(f: TpoFrame): number | null {
    const right = Math.min(f.view.t1, f.now);
    return right >= f.now - AUTO_STEP ? null : Math.floor(right / AUTO_STEP) * AUTO_STEP;
  }

  /**
   * Auto's row size for this coin and period, from the daily candles before the chart's right edge (`#asOf`); while those are on their way,
   * the last size known for the coin; 0 until any is read.
   */
  auto(f: TpoFrame): number {
    const s = f.state.tpo, coin = currentCoin().coin, target = this.#target(f.state);
    if (!target) return 0;
    const back = this.#asOf(f), at = back ?? f.now, base = `${coin}|${s.period}|${target.id}`, key = `${base}|${back ?? 'now'}`, h = this.hub.tpoHistory(target.id, DAY, 'days');
    // Read once the days it needs are held (a week's 70, a day's 14), or the market began after them.
    if (h.id === target.id && h.bars.length && (h.knownFrom <= at - (s.period === 'week' ? 70 : 15) * DAY || h.exhausted || h.limited)) {
      const version = `${h.version}|${Math.floor(at / DAY)}`, held = this.#autoR.get(key);
      if (held?.version !== version) {
        const r = autoRows(h.bars, at, s.period);
        if (this.#autoR.size > 200) this.#autoR.clear();
        if (r > 0) { this.#autoR.set(key, { version, r }); this.#autoLast.set(base, r); }
      }
    }
    return this.#autoR.get(key)?.r ?? this.#autoLast.get(base) ?? 0;
  }

  /**
   * The chart's own newest price inside the window's block under way (on the window's grid), where the chart shows this very market at a
   * timeframe no longer than a block, and the price now.
   */
  #live(f: TpoFrame, target: HistoryTarget, blockMs: number, from: number): { t: number; h: number; l: number; c: number } | null {
    const state = f.state;
    if (f.replay || !target.own || state.seriesInstrument !== state.marketId) return null;
    const start = blockStart(f.now, from, blockMs), tf = TIMEFRAMES[state.timeframe] ?? Infinity;
    let h = -Infinity, l = Infinity, c = NaN;
    if (tf <= blockMs) for (let i = state.candles.length - 1; i >= 0 && state.candles[i]![0] >= start; i--) { const b = state.candles[i]!; h = Math.max(h, b[2]); l = Math.min(l, b[3]); if (Number.isNaN(c)) c = b[4]; }
    const mark = state.mark.price;
    if (mark > 0) { h = Math.max(h, mark); l = Math.min(l, mark); c = mark; }
    return Number.isFinite(h) && Number.isFinite(c) ? { t: start, h, l, c } : null;
  }

  /**
   * One window's hollow rows and the other markets' blocks and gaps they were judged on, from the window's own candles and the day before
   * (each market's usual gap is read over the day before each block), worked out again only when those candles change or more of its
   * blocks can be judged: a block is judged once the chart market and every other market loaded have read past its end, or ten minutes after
   * it ends with whichever have (one that read early cannot decide alone, and one that stopped reading cannot hold the marks back for ever).
   * The other venues' candles reach two months back: an older window has none.
   */
  #hollowOfWindow(f: TpoFrame, target: HistoryTarget, main: KeyLevelHistory, w: { key: string; from: number; to: number }, residue: number, blockMs: number, barMs: number, R: number): { byBlock: Map<number, Set<number>>; peers: Peer[]; sig: string } | null {
    const none = { byBlock: new Map<number, Set<number>>(), peers: [] as Peer[], sig: '' };
    if (w.to <= f.now - MAX_BACK_MS) return none;
    const peers = this.#peers(f, target).map(p => this.hub.tpoHistory(p.id, barMs, 'peer')).filter(h => h.bars.length);
    const start = w.from - DAY, end = spanEnd(f.now, w.to, residue, blockMs);
    const mineTo = f.replay ? f.now : Math.min(main.heldTo, f.now), heldTo = (h: KeyLevelHistory): number => f.replay ? f.now : Math.min(h.heldTo, f.now);
    const allTo = Math.min(mineTo, ...peers.map(heldTo)), judged = Math.min(mineTo, Math.max(allTo, f.now - 10 * MIN));
    // How many of its blocks can be judged, counted on the window's own grid; in a replay, the moment only while the window is open at it.
    const key = `${R}|${this.#spanSig(main, start, end)}|${peers.map(h => this.#spanSig(h, start, end)).join(',')}|${Math.floor((Math.min(judged, w.to) - residue) / blockMs)}|${f.replay && w.to > f.now ? Math.floor(f.now / barMs) : ''}`;
    const held = this.#hollowWin.get(w.key);
    if (held?.key === key) return held;
    // Past the frame's budget: left for a frame after (null), as the profiles are.
    const budget = this.#budget;
    if (budget.built >= 2 && performance.now() > budget.end) { budget.deferred = true; return null; }
    budget.built++;
    const mine = blocksOf(main.bars, start, end, blockMs, barMs, f.now, f.replay), out: Peer[] = [];
    for (const h of peers) {
      const theirs = new Map(blocksOf(h.bars, start, end, blockMs, barMs, f.now, f.replay).map(b => [b.t, b] as const)), gaps = trailingGaps(mine, theirs, blockMs);
      out.push({ blocks: theirs, gap: t => gaps.get(t) ?? 0, heldTo: heldTo(h) });
    }
    const byBlock = new Map<number, Set<number>>();
    let sig = '';
    for (const b of mine) {
      const blockEnd = b.t + blockMs;
      if (b.t < w.from || blockEnd > mineTo || (blockEnd > allTo && f.now - blockEnd < 10 * MIN)) continue;
      const rows = hollowRows(b, out, R, blockMs);
      if (rows.size) { byBlock.set(b.t, rows); sig += `${b.t}:${[...rows].join(',')};`; }
    }
    // The box under the pointer reads the other markets for a marked block only: those blocks alone are kept (a window of eleven venues'
    // blocks is about 100 KB, and hundreds of windows are drawn).
    const kept: Peer[] = byBlock.size ? out.map(x => ({ blocks: new Map([...byBlock.keys()].flatMap(t => { const b = x.blocks.get(t); return b ? [[t, b] as const] : []; })), gap: x.gap, heldTo: x.heldTo })) : [];
    const next = { key, byBlock, peers: kept, sig };
    if (this.#hollowWin.size > MAX_TPO_DRAWN + 200) this.#hollowWin.clear();
    this.#hollowWin.set(w.key, next);
    return next;
  }

  /**
   * The chosen markets' blocks of one window as one (`mergeBlocks`), from its own candles and the day before (each market's usual gap is
   * read over the day before each block), in the chart market's prices, or, where the chart market has no candles in the window (its
   * history begins later), the first chosen market's that has.
   */
  #mergeWindow(f: TpoFrame, target: HistoryTarget, main: KeyLevelHistory, hs: readonly KeyLevelHistory[], w: { from: number; to: number }, residue: number, blockMs: number, barMs: number, R: number): Block[] {
    const start = w.from - DAY, end = spanEnd(f.now, w.to, residue, blockMs);
    const blocksIn = (h: KeyLevelHistory): Block[] => blocksOf(h.bars, start, end, blockMs, barMs, f.now, f.replay);
    const theirs = hs.filter(h => h.bars.length).map(h => ({ h, blocks: blocksIn(h) }));
    let ref: KeyLevelHistory = main, mine = blocksIn(main);
    if (!mine.some(b => b.t >= w.from)) { const other = theirs.find(x => x.blocks.some(b => b.t >= w.from)); if (other) { ref = other.h; mine = other.blocks; } }
    const parts: Part[] = theirs.map(({ h, blocks }) => {
      const map = new Map(blocks.map(b => [b.t, b] as const));
      return { id: h.id, blocks: map, gap: h === ref ? (): number => 0 : gapLookup(trailingGaps(mine, map, blockMs)), heldTo: f.replay ? f.now : Math.min(h.heldTo, f.now) };
    });
    return mergeBlocks(parts, target.own ? target.id : null, w.from, end, blockMs, R, f.now, f.state.tpo.hollow);
  }

  /**
   * The profile of one window (null until its candles are read, or where nothing traded), keyed by what its own candles add up to: a
   * window is worked out again only when they change. While a market it waits for is on its way again (a retry, a walk further back), it
   * keeps the profile it had from the same markets and rows.
   */
  #profileOf(f: TpoFrame, w: { key: string; from: number; to: number }, c: FrameCtx): TpoProfile | null {
    const { s, target, main, R, blockMs, barMs } = c;
    if (!target || !main || !(R > 0) || (f.replay && w.from > f.now)) return null;
    const held = this.#profiles.get(w.key), budget = this.#budget;
    const waiting = (): TpoProfile | null => {
      if (this.#reach.id === `${target.id}|${s.period}|${blockMs}|${s.source}`) this.#reach.from = Math.min(this.#reach.from, w.from);
      return held?.ident === c.ident ? held.profile : null;
    };
    if (main.id !== target.id || main.barMs !== barMs) return waiting();
    const developing = w.to > f.now, residue = residueOf(w.from, blockMs);
    // What the window's blocks are worked out from (its key), and the blocks, read only when the profile is worked out again.
    let blocksNow: () => Block[], hollowed: { byBlock: Map<number, Set<number>>; sig: string } | null = null, own: boolean, source: string;
    if (s.source === 'chosen') {
      // Drawn once every chosen market, and the chart market they are moved into, has said all it will about this window: a market that
      // comes later would change it.
      const { markets, hs } = c;
      if (!markets.length || hs.some((h, i) => h.id !== markets[i]!.id) || ![main, ...hs].every(h => this.#settled(h, w.from))) return waiting();
      if (!hs.some(h => h.bars.length)) return null;
      const from = w.from - DAY, end = spanEnd(f.now, w.to, residue, blockMs);
      // And how many of its blocks can be judged for lone wicks (`mergeBlocks`: read past by every market, or ten minutes over).
      const readTo = Math.min(...hs.filter(h => h.bars.length).map(h => f.replay ? f.now : Math.min(h.heldTo, f.now))), judged = Math.max(readTo, f.now - 10 * MIN);
      source = `chosen|${[main, ...hs].map(h => this.#spanSig(h, from, end)).join(';')}|${s.hollow ? Math.floor((Math.min(judged, w.to) - residue) / blockMs) : ''}`;
      blocksNow = () => this.#mergeWindow(f, target, main, hs, w, residue, blockMs, barMs, R);
      own = target.own && markets.some(x => x.id === target.id);
    } else {
      if (!main.bars.length || main.knownFrom > w.from) return waiting();
      // Hollow marks need rows tall enough for cells (compact counts every block's own rows, marked or not). A window without marks has
      // the same key with or without them, so crossing that zoom works out again only the windows that have some.
      hollowed = s.hollow && c.cells ? this.#hollowOfWindow(f, target, main, w, residue, blockMs, barMs, R) : null;
      if (s.hollow && c.cells && !hollowed) return held?.hold === `${target.id}|${f.replay}` ? held.profile : null;
      blocksNow = () => blocksOf(main.bars, w.from, w.to, blockMs, barMs, f.now, f.replay);
      own = true;
      source = `chart|${this.#spanSig(main, w.from, w.to)}|${hollowed?.sig ?? ''}`;
    }
    const live = developing && own ? this.#live(f, target, blockMs, w.from) : null;
    const key = `${source}|${w.from}|${w.to}|${developing ? `${Math.floor(f.now / 1000)}|${live ? `${live.t}|${live.h}|${live.l}|${live.c}` : ''}` : ''}`;
    if (held?.key === key && held.ident === c.ident) return held.profile;
    // Past the frame's budget (a few at least each frame), drawn as it was, or not yet, until a frame after.
    if (budget.built >= 2 && performance.now() > budget.end) { budget.deferred = true; return held?.hold === `${target.id}|${f.replay}` ? held.profile : null; }
    budget.built++;
    let blocks = blocksNow();
    if (developing) blocks = withLive(blocks, blockMs, live && live.t >= w.from && live.t < w.to ? live : null);
    const profile = buildProfile(w, blocks, blockMs, R, s.share / 100, f.now, hollowed?.byBlock);
    // Every window in view, and the lines' windows beside them: past that, those no longer drawn go (never the ones drawn, which a window
    // waiting for a market draws as they were).
    if (this.#profiles.size > MAX_TPO_DRAWN + 200) { const drawn = new Set(c.windows.map(x => x.key)); for (const k of this.#profiles.keys()) if (!drawn.has(k)) this.#profiles.delete(k); }
    this.#profiles.set(w.key, { key, ident: c.ident, hold: `${target.id}|${f.replay}`, profile });
    return profile;
  }

  /** The profiles of the windows drawn, oldest first, a Range's composite last. */
  profiles(f: TpoFrame): TpoProfile[] {
    const c = this.#ctx(f), out: (TpoProfile | null)[] = new Array(c.windows.length);
    this.#budget = { end: performance.now() + this.budgetMs, built: 0, deferred: false };
    // Newest first: when not all fit in a frame, the windows at the right edge come first.
    for (let i = c.windows.length - 1; i >= 0; i--) out[i] = this.#profileOf(f, c.windows[i]!, c);
    const deferred = this.#budget.deferred;
    this.#budget = { end: Infinity, built: 0, deferred: false };
    if (deferred) later(() => this.invalidate());
    return out.filter((p): p is TpoProfile => p !== null);
  }

  /**
   * The TPO's point of control and value area of a calendar window (the Volume profile's lines follow them), or null where the TPO cannot
   * say: its candles do not reach it yet, or the window is part of one edited by hand (split or merged), whose lines the TPO draws itself.
   */
  levels(f: TpoFrame, w: ProfileWindow): ValueLevels | null {
    const c = this.#ctx(f);
    if (c.windows.some(x => x.members.includes(w.key) && x.key !== w.key)) return null;
    const p = this.#profileOf(f, w, c);
    return p ? levelsOfProfile(p) : null;
  }

  /** Where a window's profile was drawn in the last frame (for the Volume profile drawn as its outline over it); null where it is not drawn folded. */
  box(key: string): { x0: number; width: number; cw: number } | null {
    const g = this.#geos.find(x => x.profile.key === key);
    if (!g || g.fold > 0.5) return null;
    let max = 0; for (const list of g.rows.values()) max = Math.max(max, list.length);
    return { x0: g.x0, width: max * g.cw, cw: g.cw };
  }

  /** Whether the TPO draws a window of this key now (folded or not). */
  draws(key: string): boolean { return this.#geos.some(x => x.profile.key === key); }

  /** Whether a window drawn is a calendar window as it is (not split, merged or a Range's): the Volume profile's lines can stand for it. */
  plain(key: string): boolean { return this.#drawn?.windows.some(w => w.key === key && w.base === key) ?? false; }

  /** `linesFor(key)`: the Volume profile's lines stand for that window, so the TPO draws none of its own. */
  paint(ctx: CanvasRenderingContext2D, f: TpoFrame, p: Palette, labels: LabelBoard, linesFor: (key: string) => boolean): void {
    const s = f.state.tpo, now = performance.now();
    const target = s.unfold ? 1 : 0;
    if (target !== this.#fold.target) this.#fold = { target, from: this.#foldNow(now), start: now };
    const fold = this.#foldNow(now);
    if (fold !== this.#fold.target) requestAnimationFrame(() => this.invalidate());
    const profiles = this.profiles(f);
    const order = [...profiles].sort((a, b) => b.from - a.from).map(x => x.key);
    const names = new Map(this.windows(f).map(w => [w.key, w.name]));
    this.#geos = paintTpo(ctx, { profiles, settings: s, view: f.view, pw: f.pw, ph: f.ph, p, labels, fold, rank: key => order.indexOf(key), name: x => names.get(x.key) ?? '', now: f.now, linesFor });
  }

  #foldNow(now: number): number {
    const u = Math.min(1, (now - this.#fold.start) / FOLD_MS);
    return this.#fold.from + (this.#fold.target - this.#fold.from) * (u >= 1 ? 1 : u);
  }

  /** The block under (x, y) on the profiles drawn last (`compact`: drawn folded as one bar a row, where only the row is known). */
  hit(x: number, y: number, view: View, ph: number): { profile: TpoProfile; k: number; r: number; compact: boolean } | null {
    const c = cellAt(this.#geos, x, y, view, ph);
    return c ? { profile: c.geo.profile, k: c.k, r: c.r, compact: c.geo.compact && c.geo.fold < 0.5 } : null;
  }

  /** The block under the pointer lit on the pointer's own layer: its cells framed and its time across the map (nothing else is redrawn). */
  paintHit(ctx: CanvasRenderingContext2D, hit: { profile: TpoProfile; k: number; compact: boolean }, view: View, pw: number, ph: number, p: Palette): void {
    const geo = this.#geos.find(g => g.profile === hit.profile);
    if (geo && !hit.compact) paintLit(ctx, geo, hit.k, view, pw, ph, p);
  }

  /** What the box under the pointer says about a block and its row. */
  lines(f: TpoFrame, hit: { profile: TpoProfile; k: number; r: number; compact: boolean }): InfoLine[] {
    const { profile: p, k, r } = hit, b = p.blocks.find(x => x.k === k), R = p.R, target = this.#target(f.state), minutes = Math.round(p.blockMs / MIN);
    const inRow = p.blocks.filter(x => x.ra <= r && r <= x.rz).map(x => letterOf(x.k));
    const out: InfoLine[] = [];
    if (b && !hit.compact) out.push({ text: `${letterOf(k)} · ${clock(b.t, true)} – ${clock(b.t + p.blockMs)}`, bold: true });
    out.push({ label: t('Row'), text: `${fmtPrice(r * R, R)} – ${fmtPrice((r + 1) * R, R)}` });
    out.push({ label: t('Blocks in this row'), text: `${inRow.length} · ${inRow.join(' ')}`, wrap: true });
    if (b && !hit.compact) out.push({ label: t('This block'), text: `${fmtPrice(b.l, R)} – ${fmtPrice(b.h, R)}` });
    out.push(
      { label: t('POC'), text: fmtPrice((p.poc + 0.5) * R, R) },
      { label: t('Value area'), text: `${fmtPrice(p.val * R, R)} – ${fmtPrice((p.vah + 1) * R, R)}` },
    );
    if (p.ibh !== null && p.ibl !== null) out.push({ label: t('Initial balance'), text: `${fmtPrice(p.ibl * R, R)} – ${fmtPrice((p.ibh + 1) * R, R)}` });
    if (r === p.hi && p.top !== 'neither') out.push({ text: t('{call}: holds on {n} of 4 row grids', { call: p.top === 'poor' ? t('Poor high') : t('Tail'), n: p.topVotes }), color: 'muted', wrap: true });
    if (r === p.lo && p.bottom !== 'neither') out.push({ text: t('{call}: holds on {n} of 4 row grids', { call: p.bottom === 'poor' ? t('Poor low') : t('Tail'), n: p.bottomVotes }), color: 'muted', wrap: true });
    if (p.singles.includes(r)) out.push({ text: t('A single print: only one block traded in this row.'), color: 'muted', wrap: true });
    if (b && !hit.compact && b.hollow.has(r) && (b.up || b.down)) {
      // Chosen markets: the one whose wick alone reached this row.
      const side = r > b.z ? b.up : r < b.a ? b.down : undefined;
      if (side) out.push({ text: r > b.z ? t("{market}'s high went {bp} bp past where most of the chosen markets stopped ({price}).", { market: venueLabel(side.id), bp: side.bp.toFixed(1), price: fmtPrice(side.price, R) }) : t("{market}'s low went {bp} bp past where most of the chosen markets stopped ({price}).", { market: venueLabel(side.id), bp: side.bp.toFixed(1), price: fmtPrice(side.price, R) }), color: 'muted', wrap: true });
    }
    const peers = f.state.tpo.source === 'chart' ? this.#hollowWin.get(p.key)?.peers : undefined;
    if (b && peers && target && b.hollow.has(r)) {
      const o = overshootOf({ t: b.t, h: b.h, l: b.l, o: b.l, c: b.h, usd: b.usd, closed: b.closed }, peers, p.blockMs), market = venueLabel(target.id);
      // The side of the row under the pointer: above where most of the market reached is the high's, below it the low's.
      if (o) out.push({ text: r * R >= o.top ? t("{market}'s high went {bp} bp past where most of the market stopped ({price}).", { market, bp: o.up.toFixed(1), price: fmtPrice(o.top, R) }) : t("{market}'s low went {bp} bp past where most of the market stopped ({price}).", { market, bp: o.down.toFixed(1), price: fmtPrice(o.bottom, R) }), color: 'muted', wrap: true });
    }
    const markets = f.state.tpo.source === 'chosen' ? this.#markets(f, target) : [];
    if (markets.length) out.push({ label: t('From'), text: t('{markets}, {n}-minute blocks', { markets: markets.map(m => venueLabel(m.id)).join(' + '), n: minutes }), color: 'muted', wrap: true });
    else if (target) out.push({ label: t('From'), text: t('{market} {symbol}, {n}-minute blocks', { market: venueLabel(target.id), symbol: target.listing.symbol, n: minutes }), color: 'muted' });
    return out;
  }
}
