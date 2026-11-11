import { rowOf, type ValueLevels } from '../../shared/profile.ts';
import type { CandleRow } from '../store.ts';

/**
 * The TPO's arithmetic, pure (tests/tpo.test.mts; the rules were measured in study TPO-1, Research_Results/tpo_agreement_20261110):
 * - blocks: a window cut into blocks of a fixed length (30 minutes), each the high, low, open and close of the candles inside it;
 * - rows: a block holds every row of `R` from its low to its high (as every TPO counts a price touched in the half hour);
 * - the point of control is the row most blocks reached (a tie: the one nearest the middle of the profile, then the lower); the value
 *   area grows from it one row at a time on the larger side until it holds the share (a tie takes both);
 * - the initial balance is the first two blocks' range; tails and poor extremes are read at the profile's top and bottom: two or more rows
 *   with one block each make a tail, a top row with two or more blocks is poor. Those calls depend on where the row edges fall (TPO-1:
 *   moving every row by a fraction of a row changed Binance's own BTC call on 47 % of days at $50 rows), so each is also read with the rows
 *   moved by a quarter, a half and three quarters of a row, and says how many of the four agree;
 * - single prints are rows with one block between the runs of one-block rows at the two extremes.
 */

const DAY = 86_400_000;

/** One block: its start, high, low, open and close, its volume in USD, and whether it is over (a block under way can still grow). */
export interface Block { t: number; h: number; l: number; o: number; c: number; usd: number; closed: boolean }

/**
 * The blocks of [from, to) from candles of `barMs` (start, open, high, low, close, volume in coins), oldest first: a block with no candle
 * is left out (nobody traded, or the history does not reach it). A block is over once its end is at or before `now`. `replay`: candles
 * that end after `now` are not read (one still forming at a replay's moment carries its future high and low); live, the candle under way
 * is the newest price known and is read.
 */
export function blocksOf(bars: readonly CandleRow[], from: number, to: number, blockMs: number, barMs: number, now: number, replay = false): Block[] {
  const out = new Map<number, Block>();
  for (const b of bars) {
    const t = b[0];
    if (t < from || t >= to || t > now || (replay && t + barMs > now)) continue;
    const high = b[2], low = b[3];
    if (!(high >= low) || !(low > 0)) continue;
    const k = from + Math.floor((t - from) / blockMs) * blockMs, usd = (b[5] > 0 ? b[5] : 0) * (high + low + b[4]) / 3;
    const x = out.get(k);
    if (!x) out.set(k, { t: k, h: high, l: low, o: b[1], c: b[4], usd, closed: k + blockMs <= now, last: t } as Block & { last: number });
    else {
      const y = x as Block & { last: number };
      if (high > y.h) y.h = high;
      if (low < y.l) y.l = low;
      if (t >= y.last) { y.c = b[4]; y.last = t; }
      y.usd += usd;
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t).map(({ t, h, l, o, c, usd, closed }) => ({ t, h, l, o, c, usd, closed }));
}

/** A block widened to the chart's own price where it is fresher than the history (the half hour under way between two refreshes). */
export function withLive(blocks: Block[], blockMs: number, live: { t: number; h: number; l: number; c: number } | null): Block[] {
  if (!live || !blocks.length) return blocks;
  const last = blocks[blocks.length - 1]!;
  if (live.t < last.t || live.t >= last.t + blockMs || last.closed) return blocks;
  return [...blocks.slice(0, -1), { ...last, h: Math.max(last.h, live.h), l: Math.min(last.l, live.l), c: live.c }];
}

export type Extreme = 'poor' | 'tail' | 'neither';

/** One block on its rows: its letter's index in the window, its start, its first and last row, its high and low, and the rows drawn hollow. */
export interface BlockRows { k: number; t: number; a: number; z: number; h: number; l: number; usd: number; closed: boolean; hollow: ReadonlySet<number> }

export interface TpoProfile {
  key: string; from: number; to: number; blockMs: number; R: number;
  blocks: BlockRows[];
  /** Blocks per row. */
  counts: Map<number, number>;
  lo: number; hi: number; total: number;
  /** Rows: the point of control, the value area's top and bottom rows. */
  poc: number; vah: number; val: number;
  /** The initial balance's top and bottom rows (null without its blocks). */
  ibh: number | null; ibl: number | null;
  /** The rows of the window's first price and of its last. */
  open: number | null; close: number | null;
  top: Extreme; bottom: Extreme;
  /** How many of the four row grids give the same call (4: steady). */
  topVotes: number; bottomVotes: number;
  singles: number[];
  /** Blocks above and below the point of control's row. */
  above: number; below: number;
  /** The window's high and low prices, its volume in USD. */
  high: number; low: number; usd: number;
  /** The window is under way (its last block can still grow). */
  developing: boolean;
}

/** The point of control and the value area of blocks-per-row counts (rows `lo`..`hi`), as rows. */
export function valueArea(counts: ReadonlyMap<number, number>, lo: number, hi: number, share: number): { poc: number; vah: number; val: number; total: number } {
  const mid = (lo + hi) / 2;
  let poc = lo, best = -1, total = 0;
  for (let r = lo; r <= hi; r++) {
    const c = counts.get(r) ?? 0; total += c;
    if (c > best || (c === best && (Math.abs(r - mid) < Math.abs(poc - mid) || (Math.abs(r - mid) === Math.abs(poc - mid) && r < poc)))) { best = c; poc = r; }
  }
  const target = share * total;
  let acc = counts.get(poc) ?? 0, up = poc + 1, dn = poc - 1, vah = poc, val = poc;
  while (acc < target && (up <= hi || dn >= lo)) {
    const cu = up <= hi ? (counts.get(up) ?? 0) : -1, cd = dn >= lo ? (counts.get(dn) ?? 0) : -1;
    if (cu > cd) { acc += cu; vah = up++; }
    else if (cd > cu) { acc += cd; val = dn--; }
    else { acc += Math.max(0, cu) + Math.max(0, cd); if (up <= hi) vah = up++; if (dn >= lo) val = dn--; }
  }
  return { poc, vah, val, total };
}

/** The calls at the two extremes of blocks read on rows of `R` moved by `phase`, and the runs of one-block rows that touch them. */
function extremes(blocks: readonly Block[], R: number, phase: number): { top: Extreme; bottom: Extreme; topRun: number; botRun: number; counts: Map<number, number>; lo: number; hi: number } {
  const counts = new Map<number, number>();
  let lo = Infinity, hi = -Infinity;
  for (const b of blocks) {
    const a = rowOf(b.l + phase, R), z = rowOf(b.h + phase, R);
    if (a < lo) lo = a; if (z > hi) hi = z;
    for (let r = a; r <= z; r++) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const c = (r: number): number => counts.get(r) ?? 0;
  let topRun = 0; for (let r = hi; r >= lo && c(r) === 1; r--) topRun++;
  let botRun = 0; for (let r = lo; r <= hi && c(r) === 1; r++) botRun++;
  return { top: c(hi) >= 2 ? 'poor' : topRun >= 2 ? 'tail' : 'neither', bottom: c(lo) >= 2 ? 'poor' : botRun >= 2 ? 'tail' : 'neither', topRun, botRun, counts, lo, hi };
}

/** The most rows a window may span (a row far finer than its prices would otherwise make millions). */
export const MAX_TPO_ROWS = 4_000;

/**
 * The profile of one window from its blocks, on rows of `R`, with the value area holding `share` of the TPOs; null when nothing traded or
 * the rows would be too many. `hollow`: per block start, the rows drawn hollow (`hollowRows`).
 */
export function buildProfile(win: { key: string; from: number; to: number }, blocks: readonly Block[], blockMs: number, R: number, share: number, now: number, hollow?: ReadonlyMap<number, ReadonlySet<number>>): TpoProfile | null {
  if (!blocks.length || !(R > 0)) return null;
  const e = extremes(blocks, R, 0);
  if (!Number.isFinite(e.lo) || e.hi - e.lo + 1 > MAX_TPO_ROWS) return null;
  const { counts, lo, hi } = e;
  const area = valueArea(counts, lo, hi, share);
  const none: ReadonlySet<number> = new Set();
  const rows: BlockRows[] = blocks.map(b => ({ k: Math.round((b.t - win.from) / blockMs), t: b.t, a: rowOf(b.l, R), z: rowOf(b.h, R), h: b.h, l: b.l, usd: b.usd, closed: b.closed, hollow: hollow?.get(b.t) ?? none }));
  const first = rows.filter(b => b.k <= 1);
  // The four grids: a call that holds on all of them does not depend on where the row edges fall.
  let topVotes = 0, bottomVotes = 0;
  for (const phase of [0, R / 4, R / 2, 3 * R / 4]) { const x = extremes(blocks, R, phase); if (x.top === e.top) topVotes++; if (x.bottom === e.bottom) bottomVotes++; }
  const singles: number[] = [];
  for (let r = lo; r <= hi; r++) if ((counts.get(r) ?? 0) === 1 && r < hi - e.topRun + 1 && r > lo + e.botRun - 1) singles.push(r);
  let above = 0, below = 0;
  for (const [r, c] of counts) { if (r > area.poc) above += c; else if (r < area.poc) below += c; }
  const last = blocks[blocks.length - 1]!;
  return {
    key: win.key, from: win.from, to: win.to, blockMs, R, blocks: rows, counts, lo, hi, total: area.total,
    poc: area.poc, vah: area.vah, val: area.val,
    ibh: first.length ? Math.max(...first.map(b => b.z)) : null, ibl: first.length ? Math.min(...first.map(b => b.a)) : null,
    open: blocks[0]!.t < win.from + blockMs ? rowOf(blocks[0]!.o, R) : null, close: rowOf(last.c, R),
    top: e.top, bottom: e.bottom, topVotes, bottomVotes, singles, above, below,
    high: Math.max(...blocks.map(b => b.h)), low: Math.min(...blocks.map(b => b.l)), usd: blocks.reduce((s, b) => s + b.usd, 0),
    developing: win.to > now,
  };
}

/** A profile's readings as prices, as the Volume profile's are (shared/profile.ts): the point of control at its row's middle, the value area from the bottom of its lowest row to the top of its highest. */
export const levelsOfProfile = (p: TpoProfile): ValueLevels => ({ poc: (p.poc + 0.5) * p.R, vah: (p.vah + 1) * p.R, val: p.val * p.R });

/** The letter of block `k` of a window: A to Z, then a to z, then again. */
export const letterOf = (k: number): string => { const i = ((k % 52) + 52) % 52; return String.fromCharCode(i < 26 ? 65 + i : 97 + i - 26); };

/** The 1-2-5 price nearest `x` (in proportion). */
export function ladder(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 0;
  const e = Math.floor(Math.log10(x));
  let best = 0, dist = Infinity;
  for (const k of [e - 1, e, e + 1]) for (const m of [1, 2, 5]) { const v = m * 10 ** k, d = Math.abs(Math.log(v / x)); if (d < dist) { dist = d; best = v; } }
  return Number(best.toPrecision(12));
}

/** The rows a person can choose beside Auto: the 1-2-5 prices from a fifth to five times it. */
export function rowChoices(auto: number): number[] {
  const out: number[] = [];
  for (const f of [0.2, 0.5, 1, 2, 5]) { const v = ladder(auto * f); if (v > 0 && !out.includes(v)) out.push(v); }
  return out.sort((a, b) => a - b);
}

/**
 * Auto rows: the 1-2-5 price nearest the median range of the coin's last complete days (at most 14) over `per` rows (90: about 80 to 110 rows
 * a day, where the calls were steadiest in TPO-1); a week's from its weeks the same way. From daily candles, so it is the same on every load.
 */
export function autoRows(days: readonly CandleRow[], now: number, period: 'day' | 'week' | 'sessions', per = 90): number {
  const done = days.filter(b => b[0] + DAY <= now && b[2] > b[3] && b[3] > 0).slice(-(period === 'week' ? 70 : 14));
  if (!done.length) return 0;
  let ranges: number[];
  if (period === 'week') {
    const weeks = new Map<number, { h: number; l: number; n: number }>();
    // Weeks from Monday, as the Volume profile's are (1970-01-05 was a Monday).
    for (const b of done) { const w = Math.floor((b[0] - 4 * DAY) / (7 * DAY)), x = weeks.get(w); if (!x) weeks.set(w, { h: b[2], l: b[3], n: 1 }); else { x.h = Math.max(x.h, b[2]); x.l = Math.min(x.l, b[3]); x.n++; } }
    ranges = [...weeks.values()].filter(x => x.n === 7).map(x => x.h - x.l);
    if (!ranges.length) ranges = done.map(b => (b[2] - b[3]) * 2.5);
  } else ranges = done.map(b => b[2] - b[3]);
  ranges.sort((a, b) => a - b);
  const m = ranges.length % 2 ? ranges[ranges.length >> 1]! : (ranges[ranges.length / 2 - 1]! + ranges[ranges.length / 2]!) / 2;
  return ladder(m / per);
}

/** One other market's blocks for the agreement, and its usual gap to the chart market at each block (bp, `trailingGaps`). */
export interface Peer { blocks: ReadonlyMap<number, Block>; gap: (t: number) => number }

/**
 * Each market's gap to the chart market at the start of each of its blocks: the median, in basis points, of its closes against the chart
 * market's over the day before (its last 48 half hours), so a block is judged on what was known before it. 0 until half a day is known.
 */
export function trailingGaps(mine: readonly Block[], theirs: ReadonlyMap<number, Block>, blockMs: number, windowMs = DAY): Map<number, number> {
  const series: [number, number][] = [];
  for (const b of mine) { const o = theirs.get(b.t); if (o && b.c > 0 && o.c > 0) series.push([b.t, 1e4 * Math.log(o.c / b.c)]); }
  const out = new Map<number, number>();
  for (let i = 0, j = 0; i < series.length; i++) {
    const t = series[i]![0];
    while (j < i && series[j]![0] < t - windowMs) j++;
    const prev = series.slice(j, i).map(x => x[1]).sort((a, b) => a - b), n = prev.length;
    // Half a day of half hours at least (24 blocks of 30 minutes; 3 of 4 hours): fewer say too little of the usual gap.
    const enough = Math.max(3, Math.floor(windowMs / blockMs / 2));
    out.set(t, n >= enough ? (n % 2 ? prev[n >> 1]! : (prev[n / 2 - 1]! + prev[n / 2]!) / 2) : 0);
  }
  return out;
}

/** The smallest overshoot a hollow block needs, in basis points, beside one row (TPO-1: the gaps between venues wander 1-2 bp). */
export const HOLLOW_MIN_BP = 3;

/**
 * The rows of a block of the chart market drawn hollow: where its wick went at least a row and `HOLLOW_MIN_BP` past the point most of the
 * market's volume reached (each market moved by its usual gap first), and only where its range widened there (when the other end falls
 * short of the market by half the overshoot or more, the whole range moved: its gap to the others changed, which is not a wick). Rows wholly
 * past that point. Needs at least three markets with volume.
 */
export function hollowRows(mine: Block, peers: readonly Peer[], R: number): Set<number> {
  const out = new Set<number>();
  const ms: { h: number; l: number; w: number }[] = [{ h: mine.h, l: mine.l, w: mine.usd }];
  for (const p of peers) { const b = p.blocks.get(mine.t); if (!b) continue; const f = Math.exp(-p.gap(mine.t) / 1e4); ms.push({ h: b.h * f, l: b.l * f, w: b.usd }); }
  const total = ms.reduce((s, x) => s + x.w, 0);
  if (ms.length < 3 || !(total > 0)) return out;
  // Walking the highs down from the top until half the volume is counted gives where most of the market reached; the lows likewise.
  let acc = 0, top = NaN; for (const x of [...ms].sort((a, b) => b.h - a.h)) { acc += x.w; if (acc >= total / 2) { top = x.h; break; } }
  acc = 0; let bottom = NaN; for (const x of [...ms].sort((a, b) => a.l - b.l)) { acc += x.w; if (acc >= total / 2) { bottom = x.l; break; } }
  const up = 1e4 * Math.log(mine.h / top), down = 1e4 * Math.log(bottom / mine.l), need = Math.max(1e4 * R / mine.h, HOLLOW_MIN_BP);
  if (up >= need && -down < up / 2) for (let r = rowOf(top, R) + 1; r <= rowOf(mine.h, R); r++) if (r * R >= top) out.add(r);
  if (down >= need && -up < down / 2) for (let r = rowOf(mine.l, R); r < rowOf(bottom, R); r++) if ((r + 1) * R <= bottom) out.add(r);
  return out;
}

/** How far this market's wick went past most of the market in a block, in bp (for the hover; 0 where it did not). */
export function overshootOf(mine: Block, peers: readonly Peer[]): { up: number; down: number; top: number; bottom: number } | null {
  const ms: { h: number; l: number; w: number }[] = [{ h: mine.h, l: mine.l, w: mine.usd }];
  for (const p of peers) { const b = p.blocks.get(mine.t); if (!b) continue; const f = Math.exp(-p.gap(mine.t) / 1e4); ms.push({ h: b.h * f, l: b.l * f, w: b.usd }); }
  const total = ms.reduce((s, x) => s + x.w, 0);
  if (ms.length < 3 || !(total > 0)) return null;
  let acc = 0, top = NaN; for (const x of [...ms].sort((a, b) => b.h - a.h)) { acc += x.w; if (acc >= total / 2) { top = x.h; break; } }
  acc = 0; let bottom = NaN; for (const x of [...ms].sort((a, b) => a.l - b.l)) { acc += x.w; if (acc >= total / 2) { bottom = x.l; break; } }
  return { up: Math.max(0, 1e4 * Math.log(mine.h / top)), down: Math.max(0, 1e4 * Math.log(bottom / mine.l)), top, bottom };
}

/**
 * The windows as a person edited them (per coin): a split moment inside a window cuts it in two there (to the block); a merge joins the
 * window starting at that moment to the one before it. Keys say what was done, so a profile's cache and the lines know an edited window
 * is no longer the calendar's.
 */
export function editedWindows<W extends { key: string; name?: string; from: number; to: number }>(windows: readonly W[], splits: readonly number[], merges: readonly number[], blockMs: number): { key: string; from: number; to: number; base: string }[] {
  let out = windows.map(w => ({ key: w.key, from: w.from, to: w.to, base: w.key }));
  for (const s of splits) {
    const at = out.findIndex(w => s > w.from && s < w.to);
    if (at < 0) continue;
    const w = out[at]!, cut = w.from + Math.round((s - w.from) / blockMs) * blockMs;
    if (cut <= w.from || cut >= w.to) continue;
    out.splice(at, 1, { key: `${w.key}|<${cut}`, from: w.from, to: cut, base: w.base }, { key: `${w.key}|>${cut}`, from: cut, to: w.to, base: w.base });
  }
  for (const m of merges) {
    const at = out.findIndex(w => w.from === m);
    if (at <= 0) continue;
    const a = out[at - 1]!, b = out[at]!;
    if (a.to !== b.from) continue;
    out.splice(at - 1, 2, { key: `${a.key}+${b.key}`, from: a.from, to: b.to, base: a.base });
  }
  out = out.sort((a, b) => a.from - b.from);
  return out;
}
