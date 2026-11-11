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
import { linesWindows, periodWindows } from '../traded/levels.ts';
import type { ProfileWindow } from '../traded/sessions.ts';
import type { ValueLevels } from '../../shared/profile.ts';
import { TIMEFRAMES } from '../../shared/series.ts';
import { autoRows, blockStart, blocksOf, buildProfile, editedWindows, hollowRows, letterOf, levelsOfProfile, overshootOf, trailingGaps, withLive, type Block, type EditedWindow, type Peer, type TpoProfile } from './model.ts';
import { blockMsOf, editScope, type TpoSettings } from './settings.ts';
import { cellAt, paintLit, paintTpo, type TpoGeometry } from './paint.ts';

/**
 * The TPO on the map (tpo/): which windows it draws (the Volume profile's days, weeks or sessions in its zone, edited by hand, and a Range's
 * composite), the candles they are read from (the chart market's own where its history can be read, as the key levels'), the daily candles
 * its Auto rows come from, the other markets' candles that say which blocks stood alone, the profiles worked out from them (kept until what
 * they come from changes), the fold into time and back, and what is under the pointer. The heat pane asks for it each frame (`ensure`,
 * `paint`) and the Volume profile's lines read its levels (`levels`).
 */

const MIN = 60_000, DAY = 86_400_000;
/** How long the fold into time and back takes. */
const FOLD_MS = 240;
/** How far back the calendar is read for the candle size (a window on another daylight-saving offset needs a size that fits it too). */
const BAR_LOOKBACK = 70 * DAY;

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

export class TpoLayer {
  #geos: TpoGeometry[] = [];
  #profiles = new Map<string, { key: string; profile: TpoProfile | null }>();
  /** The hollow rows and the other markets' blocks, per grid offset (`residueOf`). */
  #hollow = new Map<number, { key: string; byBlock: Map<number, Set<number>>; peers: Peer[] }>();
  #fold = { target: 0, from: 0, start: 0 };
  #autoR = new Map<string, number>();
  /**
   * How far back a window the lines asked about reaches (`levels`), for the chart market, kind of window and block it was asked on: any
   * other starts again.
   */
  #reach = { id: '', from: Infinity };
  #drawn: { key: string; windows: TpoWindow[] } | null = null;
  #bar: { key: string; barMs: number } | null = null;

  constructor(private hub: TpoHub, private invalidate: () => void) {}

  /** The chart market's candles (null where no market of the coin has a history the page can read). */
  #target(state: AppState): HistoryTarget | null { return historyTarget(state.marketId, currentCoin()); }

  /** The calendar of the TPO's kind of window, in the Volume profile's zone and sessions. */
  #kind(f: TpoFrame): { period: TpoSettings['period']; zone: string; sessions: AppState['traded']['sessions'] } {
    return { period: f.state.tpo.period, zone: f.state.traded.zone, sessions: f.state.traded.sessions };
  }

  /**
   * The candle size, from the calendar alone (the windows of the last ten weeks, both daylight-saving offsets among them), so the drawn
   * windows, the lines' windows and the requests always agree on it.
   */
  barMs(f: TpoFrame): number {
    const blockMs = blockMsOf(f.state.tpo), k = this.#kind(f), day = Math.floor(f.now / DAY);
    const key = `${blockMs}|${k.period}|${k.zone}|${JSON.stringify(k.sessions)}|${f.state.timeZone}|${day}`;
    if (this.#bar?.key !== key) this.#bar = { key, barMs: barFor(blockMs, periodWindows(k, f.state.timeZone, f.now - BAR_LOOKBACK, f.now + 7 * DAY)) };
    return this.#bar.barMs;
  }

  /** For the panel: Auto's row size, whose candles, the block's minutes. */
  info(f: TpoFrame): { auto: number; market: string | null; minutes: number } {
    const target = this.#target(f.state);
    return { auto: this.auto(f), market: target ? `${venueLabel(target.id)} ${target.listing.symbol}` : null, minutes: Math.round(blockMsOf(f.state.tpo) / MIN) };
  }

  /** The windows drawn: the last `count` up to the chart's right edge, as edited for this coin, kind and block length, and a Range's composite. */
  windows(f: TpoFrame): TpoWindow[] {
    const s = f.state.tpo, v = f.view, coin = currentCoin().coin, blockMs = blockMsOf(s), scope = editScope(coin, s.period, blockMs);
    const r = f.state.range, range = r && !r.draft && r.t1 > r.t0 ? `${r.t0}|${r.t1}` : '';
    const key = `${range}|${s.period}|${s.count}|${blockMs}|${f.state.traded.zone}|${JSON.stringify(f.state.traded.sessions)}|${f.state.timeZone}|${scope}|${(s.splits[scope] ?? []).join(',')}|${(s.merges[scope] ?? []).join(',')}|${Math.floor(v.t1 / MIN)}|${Math.floor(f.now / MIN)}`;
    if (this.#drawn?.key === key) return this.#drawn.windows;
    const span = s.period === 'week' ? 7 * DAY : DAY, right = Math.min(v.t1, f.now);
    const base = linesWindows({ ...f.state.traded, period: s.period, count: s.count }, f.state.timeZone, right - (s.count + 1) * span - 3 * DAY, right, f.now, s.count);
    const byKey = new Map(base.map(w => [w.key, w]));
    const nameOf = (key: string): string => { const w = byKey.get(key); return w ? f.nameOf?.(w) ?? w.name : ''; };
    const windows: TpoWindow[] = editedWindows(base, s.splits[scope] ?? [], s.merges[scope] ?? [], blockMs).map(w => ({ ...w, name: nameOf(w.base) }));
    // A Range selected on the map: the composite of every block in it, drawn last (over the windows it crosses), from its first whole block.
    if (r && range) {
      const from = Math.floor(r.t0 / blockMs) * blockMs, to = Math.ceil(r.t1 / blockMs) * blockMs;
      if (to - from >= blockMs) windows.push({ key: `range|${from}|${to}`, from, to, base: 'range', members: [], spans: [], name: t('Range') });
    }
    this.#drawn = { key, windows };
    return windows;
  }

  /** Ask for what the windows drawn and the lines need: the chart market's candles, its daily candles, and the other markets' for hollow blocks. */
  ensure(f: TpoFrame): void {
    const s = f.state.tpo, target = this.#target(f.state);
    if (!target) return;
    const windows = this.windows(f);
    if (!windows.length) return;
    const reachId = `${target.id}|${s.period}|${blockMsOf(s)}`;
    if (this.#reach.id !== reachId) this.#reach = { id: reachId, from: Infinity };
    const barMs = this.barMs(f), first = Math.min(this.#reach.from, ...windows.map(w => w.from));
    // A day before the first window: the other markets' usual gaps are read over the day before each block.
    this.hub.tpoHistory(target.id, barMs, 'main').ensure(target, first - DAY, barMs, () => this.invalidate());
    this.hub.tpoHistory(target.id, DAY, 'days').ensure(target, f.now - 75 * DAY, DAY, () => this.invalidate());
    if (s.hollow) for (const peer of this.#peers(f, target)) this.hub.tpoHistory(peer.id, barMs, 'peer').ensure(peer, first - DAY, barMs, () => this.invalidate());
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

  /** Auto's row size for this coin and period (0 until its daily candles are read). */
  auto(f: TpoFrame): number {
    const s = f.state.tpo, coin = currentCoin().coin, target = this.#target(f.state);
    if (!target) return 0;
    const key = `${coin}|${s.period}|${target.id}`, h = this.hub.tpoHistory(target.id, DAY, 'days');
    if (h.id === target.id && h.bars.length) { const r = autoRows(h.bars, f.now, s.period); if (r > 0) this.#autoR.set(key, r); }
    return this.#autoR.get(key) ?? 0;
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
   * The other markets' blocks and gaps and the rows drawn hollow, on the grid of windows starting at offset `residue` (worked out again when
   * any of their candles change), over the windows drawn and the day before them. A block is judged once its end is known to every history
   * that judges it.
   */
  #hollowOf(f: TpoFrame, target: HistoryTarget, main: KeyLevelHistory, barMs: number, blockMs: number, R: number, residue: number, first: number): { byBlock: Map<number, Set<number>>; peers: Peer[] } {
    const peers = this.#peers(f, target).map(p => this.hub.tpoHistory(p.id, barMs, 'peer')).filter(h => h.bars.length);
    const start = residue + Math.floor((Math.max(main.heldFrom, first - DAY) - residue) / blockMs) * blockMs;
    const key = `${main.id}|${main.version}|${barMs}|${blockMs}|${R}|${start}|${f.replay ? Math.floor(f.now / barMs) : ''}|${peers.map(h => `${h.id}:${h.version}`).join(',')}`;
    const held = this.#hollow.get(residue);
    if (held?.key === key) return held;
    const end = f.now + blockMs, mine = blocksOf(main.bars, start, end, blockMs, barMs, f.now, f.replay), out: Peer[] = [];
    for (const h of peers) {
      const theirs = new Map(blocksOf(h.bars, start, end, blockMs, barMs, f.now, f.replay).map(b => [b.t, b] as const)), gaps = trailingGaps(mine, theirs, blockMs);
      out.push({ blocks: theirs, gap: t => gaps.get(t) ?? 0, heldTo: f.replay ? f.now : Math.min(h.heldTo, f.now) });
    }
    // A block is judged once the chart market and every other market loaded have read past its end, or ten minutes after it ends with
    // whichever have (one that read early cannot decide alone, and one that stopped reading cannot hold the marks back for ever).
    const byBlock = new Map<number, Set<number>>(), mineTo = f.replay ? f.now : Math.min(main.heldTo, f.now);
    const allTo = Math.min(mineTo, ...out.map(x => x.heldTo ?? Infinity));
    for (const b of mine) {
      const end = b.t + blockMs;
      if (b.t < first || end > mineTo || (end > allTo && f.now - end < 10 * MIN)) continue;
      const rows = hollowRows(b, out, R, blockMs); if (rows.size) byBlock.set(b.t, rows);
    }
    const next = { key, byBlock, peers: out };
    if (this.#hollow.size > 4) this.#hollow.clear();
    this.#hollow.set(residue, next);
    return next;
  }

  /** The profile of one window (null until its candles are read, or where nothing traded). */
  #profileOf(f: TpoFrame, w: { key: string; from: number; to: number }): TpoProfile | null {
    const s = f.state.tpo, target = this.#target(f.state), R = this.rows(f);
    if (!target || !(R > 0) || (f.replay && w.from > f.now)) return null;
    const blockMs = blockMsOf(s), barMs = this.barMs(f), main = this.hub.tpoHistory(target.id, barMs, 'main');
    if (main.id !== target.id || main.barMs !== barMs || !main.bars.length || main.knownFrom > w.from) { if (this.#reach.id === `${target.id}|${s.period}|${blockMs}`) this.#reach.from = Math.min(this.#reach.from, w.from); return null; }
    // Hollow rows are worked out for the windows drawn only (a window the lines ask about needs none: its levels count blocks, not marks),
    // so the work and its cache do not move with every window the lines read.
    const residue = residueOf(w.from, blockMs), first = Math.min(...this.windows(f).map(x => x.from));
    const hollowed = s.hollow ? this.#hollowOf(f, target, main, barMs, blockMs, R, residue, first) : null;
    const developing = w.to > f.now, live = developing ? this.#live(f, target, blockMs, w.from) : null;
    const key = `${main.id}|${main.version}|${w.from}|${w.to}|${R}|${s.share}|${blockMs}|${barMs}|${s.hollow ? this.#hollow.get(residue)?.key ?? '' : 'off'}|${developing ? `${Math.floor(f.now / 1000)}|${live ? `${live.t}|${live.h}|${live.l}|${live.c}` : ''}` : ''}|${f.replay}`;
    const held = this.#profiles.get(w.key);
    if (held?.key === key) return held.profile;
    let blocks: Block[] = blocksOf(main.bars, w.from, w.to, blockMs, barMs, f.now, f.replay);
    if (developing) blocks = withLive(blocks, blockMs, live && live.t >= w.from && live.t < w.to ? live : null);
    const profile = buildProfile(w, blocks, blockMs, R, s.share / 100, f.now, hollowed?.byBlock);
    if (this.#profiles.size > 200) this.#profiles.clear();
    this.#profiles.set(w.key, { key, profile });
    return profile;
  }

  /** The profiles of the windows drawn, oldest first, a Range's composite last. */
  profiles(f: TpoFrame): TpoProfile[] {
    const out: TpoProfile[] = [];
    for (const w of this.windows(f)) { const p = this.#profileOf(f, w); if (p) out.push(p); }
    return out;
  }

  /**
   * The TPO's point of control and value area of a calendar window (the Volume profile's lines follow them), or null where the TPO cannot
   * say: its candles do not reach it yet, or the window is part of one edited by hand (split or merged), whose lines the TPO draws itself.
   */
  levels(f: TpoFrame, w: ProfileWindow): ValueLevels | null {
    if (this.windows(f).some(x => x.members.includes(w.key) && x.key !== w.key)) return null;
    const p = this.#profileOf(f, w);
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

  /** The block under (x, y) on the profiles drawn last (`outline`: drawn as its outline alone, where only the row is known). */
  hit(x: number, y: number, view: View, ph: number): { profile: TpoProfile; k: number; r: number; outline: boolean } | null {
    const c = cellAt(this.#geos, x, y, view, ph);
    return c ? { profile: c.geo.profile, k: c.k, r: c.r, outline: c.geo.outline } : null;
  }

  /** The block under the pointer lit on the pointer's own layer: its cells framed and its time across the map (nothing else is redrawn). */
  paintHit(ctx: CanvasRenderingContext2D, hit: { profile: TpoProfile; k: number; outline: boolean }, view: View, pw: number, ph: number, p: Palette): void {
    const geo = this.#geos.find(g => g.profile === hit.profile);
    if (geo && !hit.outline) paintLit(ctx, geo, hit.k, view, pw, ph, p);
  }

  /** What the box under the pointer says about a block and its row. */
  lines(f: TpoFrame, hit: { profile: TpoProfile; k: number; r: number; outline: boolean }): InfoLine[] {
    const { profile: p, k, r } = hit, b = p.blocks.find(x => x.k === k), R = p.R, target = this.#target(f.state), minutes = Math.round(p.blockMs / MIN);
    const inRow = p.blocks.filter(x => x.a <= r && r <= x.z).map(x => letterOf(x.k));
    const out: InfoLine[] = [];
    if (b && !hit.outline) out.push({ text: `${letterOf(k)} · ${clock(b.t, true)} – ${clock(b.t + p.blockMs)}`, bold: true });
    out.push({ label: t('Row'), text: `${fmtPrice(r * R, R)} – ${fmtPrice((r + 1) * R, R)}` });
    out.push({ label: t('Blocks in this row'), text: `${inRow.length} · ${inRow.join(' ')}`, wrap: true });
    if (b && !hit.outline) out.push({ label: t('This block'), text: `${fmtPrice(b.l, R)} – ${fmtPrice(b.h, R)}` });
    out.push(
      { label: t('POC'), text: fmtPrice((p.poc + 0.5) * R, R) },
      { label: t('Value area'), text: `${fmtPrice(p.val * R, R)} – ${fmtPrice((p.vah + 1) * R, R)}` },
    );
    if (p.ibh !== null && p.ibl !== null) out.push({ label: t('Initial balance'), text: `${fmtPrice(p.ibl * R, R)} – ${fmtPrice((p.ibh + 1) * R, R)}` });
    if (r === p.hi && p.top !== 'neither') out.push({ text: t('{call}: holds on {n} of 4 row grids', { call: p.top === 'poor' ? t('Poor high') : t('Tail'), n: p.topVotes }), color: 'muted', wrap: true });
    if (r === p.lo && p.bottom !== 'neither') out.push({ text: t('{call}: holds on {n} of 4 row grids', { call: p.bottom === 'poor' ? t('Poor low') : t('Tail'), n: p.bottomVotes }), color: 'muted', wrap: true });
    if (p.singles.includes(r)) out.push({ text: t('A single print: only one block traded in this row.'), color: 'muted', wrap: true });
    const peers = this.#hollow.get(residueOf(p.from, p.blockMs))?.peers;
    if (b && peers && target && b.hollow.has(r)) {
      const o = overshootOf({ t: b.t, h: b.h, l: b.l, o: b.l, c: b.h, usd: b.usd, closed: b.closed }, peers, p.blockMs), market = venueLabel(target.id);
      // The side of the row under the pointer: above where most of the market reached is the high's, below it the low's.
      if (o) out.push({ text: r * R >= o.top ? t("{market}'s high went {bp} bp past where most of the market stopped ({price}).", { market, bp: o.up.toFixed(1), price: fmtPrice(o.top, R) }) : t("{market}'s low went {bp} bp past where most of the market stopped ({price}).", { market, bp: o.down.toFixed(1), price: fmtPrice(o.bottom, R) }), color: 'muted', wrap: true });
    }
    if (target) out.push({ label: t('From'), text: t('{market} {symbol}, {n}-minute blocks', { market: venueLabel(target.id), symbol: target.listing.symbol, n: minutes }), color: 'muted' });
    return out;
  }
}
