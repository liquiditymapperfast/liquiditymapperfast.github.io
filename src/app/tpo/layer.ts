import type { AppState, CandleRow } from '../store.ts';
import type { View } from '../view.ts';
import type { Palette } from '../theme.ts';
import type { LabelBoard } from '../labels.ts';
import type { InfoLine } from '../infobox.ts';
import { t } from '../i18n.ts';
import { clock, price as fmtPrice } from '../format.ts';
import { currentCoin } from '../coin.ts';
import { venueLabel } from '../venues.ts';
import { historyTarget, type HistoryTarget, type KeyLevelHistory } from '../keylevels/history.ts';
import { linesWindows } from '../traded/levels.ts';
import type { ProfileWindow } from '../traded/sessions.ts';
import type { ValueLevels } from '../../shared/profile.ts';
import { autoRows, blocksOf, buildProfile, editedWindows, hollowRows, letterOf, levelsOfProfile, overshootOf, trailingGaps, withLive, type Block, type Peer, type TpoProfile } from './model.ts';
import { blockMsOf, type TpoSettings } from './settings.ts';
import { cellAt, paintTpo, type TpoGeometry } from './paint.ts';

/**
 * The TPO on the map (tpo/): which windows it draws (the Volume profile's days, weeks or sessions in its zone, edited by hand per coin), the
 * candles they are read from (the chart market's own where its history can be read, as the key levels'), the daily candles its Auto rows
 * come from, the other markets' candles that say which blocks stood alone, the profiles worked out from them (kept until what they come
 * from changes), the fold into time and back, and what is under the pointer. The heat pane asks for it each frame (`ensure`, `paint`) and
 * the Volume profile's lines read its levels (`levels`).
 */

const MIN = 60_000, DAY = 86_400_000;
/** How long the fold into time and back takes. */
const FOLD_MS = 240;

export interface TpoHub { tpoHistory(id: string, barMs: number, kind: 'main' | 'peer' | 'days'): KeyLevelHistory }

/** What a frame gives the layer. */
export interface TpoFrame {
  state: AppState; view: View; pw: number; ph: number; now: number; replay: boolean;
  /** The markets switched on inside the Spot / Perp filter (`flowIds`), whose candles judge which blocks stood alone. */
  peerIds: readonly string[];
}

/** The candle size blocks are built from: the block's own where every window starts on it, else the largest that divides both. */
export function barFor(blockMs: number, windows: readonly { from: number; to: number }[]): number {
  for (const b of [blockMs, 60 * MIN, 30 * MIN, 15 * MIN, 5 * MIN, MIN]) if (b <= blockMs && blockMs % b === 0 && windows.every(w => w.from % b === 0 && w.to % b === 0)) return b;
  return MIN;
}

export class TpoLayer {
  #geos: TpoGeometry[] = [];
  #profiles = new Map<string, { key: string; profile: TpoProfile | null }>();
  #hollow: { key: string; byBlock: Map<number, Set<number>>; peers: Peer[] } | null = null;
  #fold = { target: 0, from: 0, start: 0 };
  #autoR = new Map<string, number>();
  #reach = Infinity;
  #drawn: { key: string; windows: { key: string; from: number; to: number; base: string; name: string }[] } | null = null;
  lit: { key: string; k: number } | null = null;

  constructor(private hub: TpoHub, private invalidate: () => void) {}

  /** The chart market's candles (null where no market of the coin has a history the page can read). */
  #target(state: AppState): HistoryTarget | null { return historyTarget(state.marketId, currentCoin()); }

  /** For the panel: Auto's row size, whose candles, the block's minutes. */
  info(f: TpoFrame): { auto: number; market: string | null; minutes: number } {
    const target = this.#target(f.state);
    return { auto: this.auto(f), market: target ? `${venueLabel(target.id)} ${target.listing.symbol}` : null, minutes: Math.round(blockMsOf(f.state.tpo) / MIN) };
  }

  /** The windows drawn: the last `count` up to the chart's right edge, as edited for this coin. */
  windows(f: TpoFrame): { key: string; from: number; to: number; base: string; name: string }[] {
    const s = f.state.tpo, v = f.view, coin = currentCoin().coin, blockMs = blockMsOf(s);
    const r = f.state.range, range = r && !r.draft && r.t1 > r.t0 ? `${r.t0}|${r.t1}` : '';
    const key = `${range}|${s.period}|${s.count}|${blockMs}|${f.state.traded.zone}|${JSON.stringify(f.state.traded.sessions)}|${f.state.timeZone}|${coin}|${(s.splits[coin] ?? []).join(',')}|${(s.merges[coin] ?? []).join(',')}|${Math.floor(v.t1 / MIN)}|${Math.floor(f.now / MIN)}`;
    if (this.#drawn?.key === key) return this.#drawn.windows;
    const span = s.period === 'week' ? 7 * DAY : DAY, right = Math.min(v.t1, f.now);
    const base = linesWindows({ ...f.state.traded, period: s.period, count: s.count }, f.state.timeZone, right - (s.count + 1) * span - 3 * DAY, right, f.now, s.count);
    const names = new Map(base.map(w => [w.key, w.name]));
    const windows = editedWindows(base, s.splits[coin] ?? [], s.merges[coin] ?? [], blockMs).map(w => ({ ...w, name: names.get(w.base) ?? '' }));
    // A Range selected on the map: the composite of every block in it, drawn last (over the windows it crosses), from its first whole block.
    if (r && range) {
      const from = Math.floor(r.t0 / blockMs) * blockMs, to = Math.ceil(r.t1 / blockMs) * blockMs;
      if (to - from >= blockMs) windows.push({ key: `range|${from}|${to}`, from, to, base: 'range', name: t('Range') });
    }
    this.#drawn = { key, windows };
    return windows;
  }

  /** Ask for what the windows drawn and the lines need: the chart market's candles, its daily candles, and the other markets' for hollow blocks. */
  ensure(f: TpoFrame): void {
    const s = f.state.tpo, target = this.#target(f.state);
    if (!target) return;
    const windows = this.windows(f), blockMs = blockMsOf(s);
    if (!windows.length) return;
    const barMs = barFor(blockMs, windows), first = Math.min(this.#reach, ...windows.map(w => w.from));
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
    const s = f.state.tpo, coin = currentCoin().coin;
    const target = this.#target(f.state); if (!target) return 0;
    const key = `${coin}|${s.period}|${target.id}`, h = this.hub.tpoHistory(target.id, DAY, 'days');
    if (h.id === target.id && h.bars.length) { const r = autoRows(h.bars, f.now, s.period); if (r > 0) this.#autoR.set(key, r); }
    return this.#autoR.get(key) ?? 0;
  }

  /** The chart's own newest price inside the block under way, where the chart shows this very market at a timeframe no longer than a block. */
  #live(f: TpoFrame, target: HistoryTarget, blockMs: number): { t: number; h: number; l: number; c: number } | null {
    const state = f.state;
    if (f.replay || !target.own || state.seriesInstrument !== state.marketId || !state.candles.length) return null;
    const last = state.candles[state.candles.length - 1]!, start = Math.floor(last[0] / blockMs) * blockMs;
    let h = -Infinity, l = Infinity;
    for (let i = state.candles.length - 1; i >= 0 && state.candles[i]![0] >= start; i--) { h = Math.max(h, state.candles[i]![2]); l = Math.min(l, state.candles[i]![3]); }
    const mark = state.mark.price;
    if (mark > 0) { h = Math.max(h, mark); l = Math.min(l, mark); }
    return Number.isFinite(h) ? { t: last[0], h, l, c: mark > 0 ? mark : last[4] } : null;
  }

  /** Blocks per other market and each one's usual gap, then the rows drawn hollow, per block start (worked out when any candles change). */
  #hollowOf(f: TpoFrame, target: HistoryTarget, main: KeyLevelHistory, barMs: number, blockMs: number, R: number): { byBlock: Map<number, Set<number>>; peers: Peer[] } {
    const peers = this.#peers(f, target).map(p => this.hub.tpoHistory(p.id, barMs, 'peer')).filter(h => h.bars.length);
    const from = main.heldFrom, key = `${main.id}|${main.version}|${barMs}|${blockMs}|${R}|${f.replay ? Math.floor(f.now / barMs) : ''}|${peers.map(h => `${h.id}:${h.version}`).join(',')}`;
    if (this.#hollow?.key === key) return this.#hollow;
    const mine = blocksOf(main.bars, from, f.now + blockMs, blockMs, barMs, f.now, f.replay);
    const out: Peer[] = [];
    for (const h of peers) {
      const theirs = new Map(blocksOf(h.bars, from, f.now + blockMs, blockMs, barMs, f.now, f.replay).map(b => [b.t, b] as const)), gaps = trailingGaps(mine, theirs, blockMs);
      out.push({ blocks: theirs, gap: t => gaps.get(t) ?? 0 });
    }
    const byBlock = new Map<number, Set<number>>();
    // Over blocks only: the block under way can still reach further, and a market's history refreshed every minute lags its live price.
    for (const b of mine) if (b.closed) { const rows = hollowRows(b, out, R); if (rows.size) byBlock.set(b.t, rows); }
    this.#hollow = { key, byBlock, peers: out };
    return this.#hollow;
  }

  /** The profile of one window (null until its candles are read, or where nothing traded). */
  #profileOf(f: TpoFrame, w: { key: string; from: number; to: number }): TpoProfile | null {
    const s = f.state.tpo, target = this.#target(f.state), R = this.rows(f);
    if (!target || !(R > 0) || (f.replay && w.from > f.now)) return null;
    const blockMs = blockMsOf(s), windows = this.windows(f), barMs = barFor(blockMs, windows.some(x => x.key === w.key) ? windows : [w]);
    const main = this.hub.tpoHistory(target.id, barMs, 'main');
    if (main.id !== target.id || main.barMs !== barMs || !main.bars.length || main.knownFrom > w.from) { this.#reach = Math.min(this.#reach, w.from); return null; }
    const hollow = s.hollow ? this.#hollowOf(f, target, main, barMs, blockMs, R).byBlock : undefined;
    const developing = w.to > f.now, live = developing ? this.#live(f, target, blockMs) : null;
    const key = `${main.version}|${R}|${s.share}|${blockMs}|${barMs}|${this.#hollow?.key ?? ''}|${developing ? `${Math.floor(f.now / 1000)}|${live ? `${live.h}|${live.l}|${live.c}` : ''}` : ''}|${f.replay}`;
    const held = this.#profiles.get(w.key);
    if (held?.key === key) return held.profile;
    let blocks: Block[] = blocksOf(main.bars, w.from, w.to, blockMs, barMs, f.now, f.replay);
    if (developing) blocks = withLive(blocks, blockMs, live);
    const profile = buildProfile(w, blocks, blockMs, R, s.share / 100, f.now, hollow);
    if (this.#profiles.size > 200) this.#profiles.clear();
    this.#profiles.set(w.key, { key, profile });
    return profile;
  }

  /** The profiles of the windows drawn, oldest first. */
  profiles(f: TpoFrame): TpoProfile[] {
    const out: TpoProfile[] = [];
    for (const w of this.windows(f)) { const p = this.#profileOf(f, w); if (p) out.push(p); }
    return out;
  }

  /**
   * The TPO's point of control and value area of a calendar window (the Volume profile's lines follow them), or null where the TPO cannot
   * say (its candles do not reach it yet, or the window is one edited by hand).
   */
  levels(f: TpoFrame, w: ProfileWindow): ValueLevels | null {
    if (this.windows(f).some(x => x.base === w.key && x.key !== w.key)) return null;
    const p = this.#profileOf(f, w);
    return p ? levelsOfProfile(p) : null;
  }

  /** Where a window's profile was drawn in the last frame (for the Volume profile drawn as its outline over it). */
  box(key: string): { x0: number; width: number; cw: number } | null {
    const g = this.#geos.find(x => x.profile.key === key);
    if (!g || g.fold > 0.5) return null;
    let max = 0; for (const list of g.rows.values()) max = Math.max(max, list.length);
    return { x0: g.x0, width: max * g.cw, cw: g.cw };
  }

  paint(ctx: CanvasRenderingContext2D, f: TpoFrame, p: Palette, labels: LabelBoard, linesElsewhere: boolean): void {
    const s = f.state.tpo, now = performance.now();
    const target = s.unfold ? 1 : 0;
    if (target !== this.#fold.target) { this.#fold = { target, from: this.#foldNow(now), start: now }; }
    const fold = this.#foldNow(now);
    if (fold !== this.#fold.target) requestAnimationFrame(() => this.invalidate());
    const profiles = this.profiles(f);
    const order = [...profiles].sort((a, b) => b.from - a.from).map(x => x.key);
    const names = new Map(this.windows(f).map(w => [w.key, w.name]));
    this.#geos = paintTpo(ctx, { profiles, settings: s, view: f.view, pw: f.pw, ph: f.ph, p, labels, fold, lit: this.lit, rank: key => order.indexOf(key), name: x => names.get(x.key) ?? '', now: f.now, linesElsewhere });
  }

  #foldNow(now: number): number {
    const u = Math.min(1, (now - this.#fold.start) / FOLD_MS);
    return this.#fold.from + (this.#fold.target - this.#fold.from) * (u >= 1 ? 1 : u);
  }

  /** The block under (x, y) on the profiles drawn last. */
  hit(x: number, y: number, view: View, ph: number): { profile: TpoProfile; k: number; r: number } | null {
    const c = cellAt(this.#geos, x, y, view, ph);
    return c ? { profile: c.geo.profile, k: c.k, r: c.r } : null;
  }

  /** What the box under the pointer says about a block and its row. */
  lines(f: TpoFrame, hit: { profile: TpoProfile; k: number; r: number }): InfoLine[] {
    const { profile: p, k, r } = hit, b = p.blocks.find(x => x.k === k), R = p.R, target = this.#target(f.state);
    if (!b) return [];
    const inRow = p.blocks.filter(x => x.a <= r && r <= x.z).map(x => letterOf(x.k));
    const out: InfoLine[] = [
      { text: `${letterOf(k)} · ${clock(b.t, true)} – ${clock(b.t + p.blockMs)}`, bold: true },
      { label: t('Row'), text: `${fmtPrice(r * R, R)} – ${fmtPrice((r + 1) * R, R)}` },
      { label: t('Half hours in this row'), text: `${inRow.length} · ${inRow.join(' ')}`, wrap: true },
      { label: t('This half hour'), text: `${fmtPrice(b.l, R)} – ${fmtPrice(b.h, R)}` },
      { label: t('POC'), text: fmtPrice((p.poc + 0.5) * R, R) },
      { label: t('Value area'), text: `${fmtPrice(p.val * R, R)} – ${fmtPrice((p.vah + 1) * R, R)}` },
    ];
    if (p.ibh !== null && p.ibl !== null) out.push({ label: t('Initial balance'), text: `${fmtPrice(p.ibl * R, R)} – ${fmtPrice((p.ibh + 1) * R, R)}` });
    if (r === p.hi && p.top !== 'neither') out.push({ text: t('{call}: holds on {n} of 4 row grids', { call: p.top === 'poor' ? t('Poor high') : t('Tail'), n: p.topVotes }), color: 'muted', wrap: true });
    if (r === p.lo && p.bottom !== 'neither') out.push({ text: t('{call}: holds on {n} of 4 row grids', { call: p.bottom === 'poor' ? t('Poor low') : t('Tail'), n: p.bottomVotes }), color: 'muted', wrap: true });
    if (p.singles.includes(r)) out.push({ text: t('A single print: only one half hour traded in this row.'), color: 'muted', wrap: true });
    const peers = this.#hollow?.peers;
    if (peers && target) {
      const o = overshootOf({ t: b.t, h: b.h, l: b.l, o: b.l, c: b.h, usd: b.usd, closed: b.closed }, peers);
      const market = venueLabel(target.id);
      if (o && b.hollow.has(r)) out.push({ text: o.up >= o.down ? t("{market}'s high went {bp} bp past where most of the market stopped ({price}).", { market, bp: o.up.toFixed(1), price: fmtPrice(o.top, R) }) : t("{market}'s low went {bp} bp past where most of the market stopped ({price}).", { market, bp: o.down.toFixed(1), price: fmtPrice(o.bottom, R) }), color: 'muted', wrap: true });
    }
    if (target) out.push({ label: t('From'), text: t('{market} {symbol}, {n}-minute blocks', { market: venueLabel(target.id), symbol: target.listing.symbol, n: Math.round(p.blockMs / MIN) }), color: 'muted' });
    return out;
  }
}

export type { CandleRow };
