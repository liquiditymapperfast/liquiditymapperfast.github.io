import { TIMEFRAMES, type Hub } from '../hub.ts';
import type { AppState, Store } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton } from '../help.ts';
import { setTip } from '../tip.ts';
import { t } from '../i18n.ts';
import { clock } from '../format.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { kindOf } from '../scope.ts';
import { oiChangeByTime, oiPartsUntil, oiUsdChangeByTime, type OiPart } from '../oi-change.ts';
import { wrapText } from '../text-fit.ts';
import { addTune } from '../pane-tune.ts';
import { LIQUIDATION_RETENTION_MS } from '../../shared/liquidations.ts';
import { BROWSER_RETENTION_MS } from '../../shared/recorder.ts';
import { BAR_CUT_H, BAR_CUT_PX, cutGap } from '../bar-scale.ts';
import { colourRamp, RAMP_STEPS } from '../traded/emphasis.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { liquidationBuckets, type StatInput } from './bar-stats.ts';
import { readAt } from './pane-cards.ts';
import { TimePane, oiSourceText, setText } from './lower-panes.ts';
import type { HeatPane } from './heat-pane.ts';
import type { LiquidationDays } from '../liq-days.ts';
import { alphaOf, buildHistory, cardLines, emphasis, heightOf, preRollMs, rowCap, shareDot, type HistoryModel, type HistoryRow } from '../size-history/model.ts';

/** The gap between the two rows of context (liquidations, open interest) and the six size rows, in px. */
const GROUP_GAP = 8;
/** The share dot's radius, and the thinnest row that has room for it beside its bar (a phone held sideways has thinner ones, without dots). */
const DOT_R = 1.75, DOT_R_MIN = 0.9, DOT_ROW_MIN = 12;

/**
 * The Flow history pane (Karl, 2026-11-20): per candle of the chart's timeframe, the liquidations, the change of open interest and the
 * market orders in six size bands, one row each on the map's time axis, with the most unusual amounts standing out (size-history/model.ts).
 * It counts the markets the footprint and the Bar stats count, and reads the footprint's bars (one load for the three, from the Highlights'
 * length before the view, at least 36 candles and six hours, while this pane shows), the liquidations the Bar stats read (one loader, liq-days.ts) and the OI pane's open
 * interest. Switched on from the flow column's settings, the Bar stats' settings and, on a phone, Settings; never from the top bar.
 */
export class SizeHistoryPane extends TimePane {
  /** Rows, not values: the pointer's height says which row, so it takes no horizontal line. */
  protected override crossY = false;
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  #bars = document.createElement('select');
  /** What the rows were worked out from last, and the result: a pointer move draws them again without working them out. */
  #held: { key: unknown[]; times: number[]; model: HistoryModel } | null = null;
  #liqBuckets: { key: string; value: StatInput['liquidations'] } | null = null;
  #usd: { oi: unknown; parts: unknown; starts: string; price: number; tfMs: number; value: { usd: Map<number, number>; coins: Map<number, number> } } | null = null;
  /** The share dot's radius as last drawn (0: none, the candles too narrow). */
  #dotR = 0;
  /** Whether a row this tall gets share dots as last drawn: the one rule for the drawing and the card. */
  #dotsOn(rowH: number): boolean { return this.#dotR > 0 && rowH >= DOT_ROW_MIN; }
  /** The rows as last drawn, top to bottom (where the pointer's height falls). */
  #layout: { row: number; y: number; h: number }[] = [];

  constructor(host: HTMLElement, store: Store, view: View, private readonly heat: HeatPane, private readonly hub: Hub, private readonly liqDays: LiquidationDays) {
    super(host, store, view, 'sizes');
    this.head.innerHTML = `<strong>${t('Flow history')}</strong><span class="readout"></span>`;
    const title = this.head.querySelector('strong')!;
    title.after(helpButton('sizes'));
    setTip(title, t('Liquidations, open interest\'s change and market orders by size, candle by candle; the most unusual amounts stand out.'));
    const label = document.createElement('label'); label.className = 'ctl'; label.append(t('Bars'));
    setTip(label, t('Each size row as its buys less its sells (Delta), or its buys up and its sells down.'));
    for (const [value, text] of [['delta', t('Delta')], ['split', t('Buys and sells')]] as const) this.#bars.append(new Option(text, value));
    this.#bars.value = store.state.sizeBars;
    this.#bars.onchange = () => store.set({ sizeBars: this.#bars.value === 'split' ? 'split' : 'delta' });
    label.append(this.#bars); this.head.append(label);
    // One slim row on a phone (and where the figures would get too little room): the choice waits behind the settings key (pane-tune.ts).
    addTune(this.head, [label], t('Flow history'), { fold: true });
    liqDays.listen(() => this.invalidate());
  }

  /** Reflect the settings in the header and draw again. */
  settingsChanged(): void { if (this.#bars.value !== this.store.state.sizeBars) this.#bars.value = this.store.state.sizeBars; this.invalidate(); }

  protected override undrawn(): void { this.#lines = null; this.#card.hide(); }

  protected draw(): void {
    this.#lines = null;
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }

  /**
   * Open interest's change in USD and in coins by candle (the OI pane's markets and parts), worked out once per set of readings, parts, price
   * and candle starts. Keyed by the candles' starts, not by the list: the candle under way replaces the list on every update, and its close
   * only turns its own change into dollars, which the next readings (every minute or so) bring again.
   */
  #oi(state: AppState, parts: readonly OiPart[], tfMs: number): { usd: Map<number, number>; coins: Map<number, number> } {
    const held = this.#usd, c = state.candles, starts = `${c.length}|${c[0]?.[0]}|${c[c.length - 1]?.[0]}`;
    if (held && held.oi === state.oi && held.parts === parts && held.starts === starts && held.price === state.oiPrice && held.tfMs === tfMs) return held.value;
    const candles = new Map(c.map(row => [row[0], row] as const));
    const value = { usd: oiUsdChangeByTime(state.oi, parts, tfMs, t => candles.get(t)?.[4], state.oiPrice), coins: oiChangeByTime(state.oi, parts, tfMs) };
    this.#usd = { oi: state.oi, parts, starts, price: state.oiPrice, tfMs, value };
    return value;
  }

  /** The liquidations by candle from the days the shared loader holds, kept while neither the days nor the candles change. */
  #liquidations(ids: readonly string[], times: readonly number[], tfMs: number, coverFrom: number): StatInput['liquidations'] {
    const held = this.liqDays;
    if (ids.join(',') !== held.ids) return undefined;
    const key = `${held.version}|${held.ids}|${times[0]}|${times.length}|${times[times.length - 1]}|${tfMs}|${coverFrom}|${Math.floor(Date.now() / 60_000)}`;
    if (this.#liqBuckets?.key === key) return this.#liqBuckets.value;
    const value = liquidationBuckets(held.days, ids, times, tfMs, coverFrom, Date.now());
    this.#liqBuckets = { key, value };
    return value;
  }

  #message(text: string): void {
    const { ctx } = this, measure = (line: string): number => ctx.measureText(line).width, lines = wrapText(measure, text, Math.max(40, this.plotW - 24), this.h >= 56 ? 3 : 2);
    ctx.save(); ctx.fillStyle = this.palette.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    lines.forEach((line, i) => ctx.fillText(line, 12, this.h / 2 + (i - (lines.length - 1) / 2) * 14)); ctx.restore();
  }

  #paint(): void {
    const { ctx, palette: p, view: v } = this, state = this.store.state, pw = this.plotW, ph = this.h;
    const tfMs = TIMEFRAMES[state.timeframe] ?? 3_600_000, data = this.heat.footprintData, markets = this.heat.footprintMarkets(state);
    const readout = this.head.querySelector('.readout');
    setText(readout, `${markets.length > 1 ? `${t('{n} markets', { n: markets.length })} · ` : ''}${t('square-root heights, each row its own scale')}`);
    this.#layout = [];
    if (!markets.length) { this.#message(t('No markets are counted: switch some on.')); this.#held = null; return; }
    if (!data.holds(markets, state.timeframe)) { this.#held = null; return; }
    // Replay: only the candles that ended by its moment. The candles of the view and one each side, and the baselines' history before it.
    const now = pageNow(), live = !replaying(), until = live ? Infinity : now, from = v.t0 - (state.highlight.on ? preRollMs(state.highlight.length, tfMs) : 0);
    const near = (start: number): boolean => start + tfMs <= until && start + tfMs > from && start < v.t1 + tfMs;
    const starts = new Set<number>();
    for (const c of state.candles) if (near(c[0])) starts.add(c[0]);
    for (const b of data.bars.values()) if (near(b.t)) starts.add(b.t);
    const times = [...starts].sort((a, b) => a - b);
    if (!times.length || !times.some(s => data.bars.has(s))) { this.#message(t('Flow history appears once market orders are recorded for these candles.')); this.#held = null; return; }
    // Liquidations of the markets counted, a UTC day per answer (the shared loader), over the candles held; a candle before the record reaches
    // (a week on a server, a day in a page's own engine, and only since the recording started) is not known.
    const retention = this.hub.source.kind === 'browser' ? BROWSER_RETENTION_MS : LIQUIDATION_RETENTION_MS;
    const liqTo = Math.min(times[times.length - 1]! + tfMs, Date.now()), liqCover = Math.max(Math.ceil((Date.now() - retention) / 60_000) * 60_000, this.hub.recordedSince > 0 ? this.hub.recordedSince : 0);
    let liquidations: StatInput['liquidations'];
    if (this.hub.source.liquidations) { this.liqDays.ensure('sizes', markets.join(','), Math.max(times[0]!, liqCover), liqTo); liquidations = this.#liquidations(markets, times, tfMs, liqCover); }
    // Open interest is the perpetuals': with spot markets alone counted, the row has none (no perpetual's change beside spot flow).
    const perps = markets.some(id => kindOf(state.markets, id) !== 'spot');
    const parts = oiPartsUntil(state.oiParts, tfMs, live ? Infinity : Math.floor(now / tfMs) * tfMs);
    const oiHeld = perps ? this.#oi(state, parts, tfMs) : undefined, oi = oiHeld?.usd, oiJudged = tfMs > 60_000, mode = state.sizeBars, h = state.highlight;
    const key = [data.version, state.oi, parts, state.oiPrice, mode, h.on, h.mult, h.length, liquidations, oi, times[0], times.length, times[times.length - 1], tfMs, Math.floor(now / 60_000), perps];
    let held = this.#held;
    if (!held || held.key.length !== key.length || held.key.some((k, i) => k !== key[i])) {
      const model = buildHistory({ times, bars: times.map(s => data.bars.get(s) ?? null), tfMs, now, mode, ...(liquidations ? { liquidations } : {}), ...(oi ? { oi } : {}), oiJudged, highlight: h });
      held = this.#held = { key, times, model };
    }
    const { model } = held, visible = times.map((_, i) => i).filter(i => times[i]! + tfMs > v.t0 && times[i]! < v.t1);
    if (!visible.length) { this.#message(t('Flow history appears once market orders are recorded for these candles.')); return; }
    // The rows share the height: two of context, a gap, the six size rows; in a short pane the gap and the margins give way first, then the
    // rows thin, so all eight always show (a phone held sideways with LT on gives the pane about 100 px).
    const rows = model.rows, top = ph < 110 ? 1 : 3, gap = ph < 140 ? 2 : GROUP_GAP, rowH = Math.max(2, (ph - 2 * top - gap) / rows.length);
    let y = top;
    this.#layout = rows.map((_, r) => { if (r === 2) y += gap; const at = { row: r, y, h: rowH }; y += rowH; return at; });
    const slot = pw * tfMs / (v.t1 - v.t0), bw = Math.max(1, Math.min(12, 0.7 * slot)), on = h.on;
    // The share dot shrinks with the candles and goes where they are too narrow for it (it would cover its neighbours).
    const dotR = Math.min(DOT_R, (slot - 1) / 2.5) >= DOT_R_MIN ? Math.min(DOT_R, (slot - 1) / 2.5) : 0;
    this.#dotR = dotR;
    // Under the pointer: the candle (any pane's pointer names it, the axis being shared) and, from this pane's own pointer, the row.
    const hv = state.hover, under = hv ? visible.find(i => hv.t >= times[i]! && hv.t < times[i]! + tfMs) ?? -1 : -1;
    const last = visible[visible.length - 1]!, hoverIdx = hv && this.pointer && hv.source === 'sizes' ? readAt(under, hv.t, last, times[last]!) : under;
    if (hoverIdx >= 0 && hoverIdx !== under) this.cursorT = times[hoverIdx]! + tfMs / 2;
    const hoverRow = hv && hv.source === 'sizes' ? this.#layout.find(b => hv.y >= b.y && hv.y < b.y + b.h)?.row ?? -1 : -1;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    // The column under the pointer, lightly, behind the bars.
    if (hoverIdx >= 0) { ctx.save(); ctx.fillStyle = p.text; ctx.globalAlpha = p.dark ? 0.08 : 0.06; ctx.fillRect(v.xOf(times[hoverIdx]!, pw), top, Math.max(1, slot - 1), y - top); ctx.restore(); }
    const ramps = { up: colourRamp(p, p.candleUp), down: colourRamp(p, p.candleDown), flat: colourRamp(p, p.muted) };
    // Liquidations from a day the source cut at its 5,000 largest anywhere in view: the row's name says ≈ (a zero there means none held).
    const liqCutShown = visible.some(i => model.liqCut[i] === 1);
    rows.forEach((row, r) => {
      const band = this.#layout[r]!, mid = Math.round(band.y + band.h / 2) + 0.5, half = Math.max(2, band.h / 2 - 2), cap = rowCap(row, visible);
      ctx.save(); ctx.globalAlpha = 0.6; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(pw, mid); ctx.stroke(); ctx.restore();
      if (r === hoverRow) { ctx.save(); ctx.fillStyle = p.text; ctx.globalAlpha = p.dark ? 0.05 : 0.04; ctx.fillRect(0, band.y, pw, band.h); ctx.restore(); }
      // A size band that took an unusually large part of its candle (model.share) gets a dot past its bar's tip, the taller one's with Buys and
      // sells: only where the bar is not already lit (brightness says its own amount), only on a whole candle, never on too thin a row.
      const marks = row.kind === 'size' && model.share && this.#dotsOn(band.h) ? model.share[row.band!]! : null, tips = new Map<number, { y: number; up: boolean; h: number }>();
      for (const part of row.parts) {
        for (const i of visible) {
          const value = part.values[i]!;
          if (!Number.isFinite(value) || value === 0) continue;
          const up = part.side ? part.side > 0 : value > 0, ramp = row.kind === 'oi' ? ramps.flat : up ? ramps.up : ramps.down;
          const hollow = row.kind === 'size' && model.partial[i] === 1;
          const e = hollow ? 0 : emphasis(part.sigma[i]!, part.flag[i] === 1, h.mult), alpha = hollow ? 0.7 : alphaOf(e, on);
          const { share, cut } = heightOf(value, cap), barH = Math.max(1, half * share), x = v.xOf(times[i]!, pw) + (slot - bw) / 2, by = up ? mid - barH : mid;
          ctx.globalAlpha = alpha;
          if (hollow) { ctx.strokeStyle = ramp[0]!; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, by + 0.5, Math.max(0, bw - 1), Math.max(0, barH - 1)); }
          else { ctx.fillStyle = on ? ramp[Math.round(e * (RAMP_STEPS - 1))]! : ramp[0]!; ctx.fillRect(x, by, bw, barH); }
          ctx.globalAlpha = 1;
          if (cut && barH > BAR_CUT_PX + BAR_CUT_H + 1) cutGap(ctx, x, up ? by + BAR_CUT_PX : by + barH - BAR_CUT_PX - BAR_CUT_H, bw);
          const taller = tips.get(i);
          if (marks && marks.flag[i] === 1 && (!taller || taller.h < barH)) tips.set(i, { y: up ? by : by + barH, up, h: barH });
        }
      }
      if (marks) {
        // In the text's ink, cased in the panel's colour so it reads over a bar the row's edge pushed it onto.
        ctx.save(); ctx.fillStyle = p.text; ctx.strokeStyle = p.panel; ctx.lineWidth = 1;
        for (const [i, tip] of tips) {
          if (!shareDot(model, row, i, h.mult)) continue;
          const cx = v.xOf(times[i]!, pw) + slot / 2, cy = Math.min(band.y + band.h - dotR - 1, Math.max(band.y + dotR + 1, tip.up ? tip.y - dotR - 2 : tip.y + dotR + 2));
          ctx.beginPath(); ctx.arc(cx, cy, dotR, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
        }
        ctx.restore();
      }
    });
    ctx.restore();
    // The rows' names at the left, on the panel's colour so the bars under them stay readable (as tall as a row allows; rows too thin for a
    // name go without, the card under the pointer names them); liquidations from a day the source cut say ≈.
    // A phone 360 px tall held sideways with LT on gives rows of under 6 px: still named, small (a phone's screen draws them at 3x).
    const fontPx = rowH < 7 ? 6 : rowH < 8 ? 7 : rowH < 9 ? 8 : rowH < 12 ? 9 : 10, plate = Math.min(14, Math.max(5, rowH - 1));
    ctx.save(); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`;
    if (rowH >= 5) for (const { row: r, y: ry, h: rh } of this.#layout) {
      const row = rows[r]!, label = row.kind === 'liq' && liqCutShown ? `≈${row.label}` : row.label, w = ctx.measureText(label).width + 10;
      ctx.globalAlpha = 0.88; ctx.fillStyle = p.panel; ctx.fillRect(2, ry + rh / 2 - plate / 2, w, plate); ctx.globalAlpha = 1; ctx.fillStyle = p.muted; ctx.fillText(label, 6, ry + rh / 2 + 0.5);
    }
    ctx.restore();
    // The card of the row and candle under this pane's pointer (or a finger's pin).
    if (hoverIdx >= 0 && hoverRow >= 0 && this.pointer) this.#lines = this.#cardFor(model, hoverRow, hoverIdx, times, tfMs, now, live, perps, state, oiHeld?.coins);
  }

  #cardFor(model: HistoryModel, r: number, i: number, times: readonly number[], tfMs: number, now: number, live: boolean, perps: boolean, state: AppState, coins?: ReadonlyMap<number, number>): InfoLine[] {
    const row: HistoryRow = model.rows[r]!, coin = state.markets.find(m => (m.instrumentId ?? m.id) === state.marketId)?.base ?? '', inCoins = coins?.get(times[i]!);
    return cardLines(model, r, i, {
      time: clock(times[i]!, true), live: live && times[i]! + tfMs > now, judging: state.highlight.on, mult: state.highlight.mult,
      dots: this.#dotsOn(this.#layout.find(b => b.row === r)?.h ?? 0),
      oiSource: row.kind === 'oi' ? oiSourceText(state) : null, oiNote: row.kind !== 'oi' ? null : !perps ? 'spot' : tfMs <= 60_000 ? 'minute' : null,
      oiCoins: row.kind === 'oi' && inCoins !== undefined ? { value: inCoins, coin } : null,
    });
  }
}
