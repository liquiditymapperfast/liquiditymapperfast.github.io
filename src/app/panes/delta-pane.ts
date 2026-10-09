import { TIMEFRAMES, type Hub } from '../hub.ts';
import type { Store, AppState } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton } from '../help.ts';
import { setTip } from '../tip.ts';
import { t, tn } from '../i18n.ts';
import { clock, usd } from '../format.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { kindOf } from '../scope.ts';
import { flowIds, flowLoadIds } from '../cvd/ids.ts';
import { aggregateIds } from '../cvd/model.ts';
import { resolveZone } from '../traded/settings.ts';
import { AXIS_W } from './heat-pane.ts';
import { TimePane, setHtml } from './lower-panes.ts';
import { FlowCache, candleStarts, deltaCandles, resetKeys, unrecorded, type DeltaCandle } from '../delta/candles.ts';
import { PIVOTS, type DeltaSettings } from '../delta/settings.ts';
import { divergences, inView, paintDivergence, type Divergence } from '../delta/divergence.ts';

const HISTORY_CAP_MS = 24 * 3_600_000, MINUTES_FROM_MS = 6 * 3_600_000;
const signed = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${usd(Math.abs(v))}`;

/** The popup for one candle of the pane: its time, its delta and the CVD it closed at. */
export function deltaCardLines(c: DeltaCandle, tf: string): InfoLine[] {
  return [
    { text: `${clock(c.t, true)} · ${tf}`, bold: true },
    { label: t('Delta'), text: signed(c.delta), color: c.delta > 0 ? 'buy' : c.delta < 0 ? 'sell' : 'text', bold: true },
    { label: t('CVD at the close'), text: signed(c.close), color: c.close > 0 ? 'buy' : c.close < 0 ? 'sell' : 'text' },
    { label: t('CVD high and low'), text: `${signed(c.high)} / ${signed(c.low)}`, color: 'muted' },
  ];
}

/**
 * The Delta pane: for each candle of the chart's timeframe, what the taker buys outweighed the sells by over the flow column's ALL VENUES
 * instruments, as bars, or the cumulative delta (CVD) as candles (see delta/candles.ts). The CVD starts at the chart's left edge or restarts
 * each day or week, in the zone the Volume profile uses.
 */
export class DeltaPane extends TimePane {
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  #cache = new FlowCache();
  #sync: (() => void)[] = [];
  /** The candles drawn last. */
  candles: DeltaCandle[] = [];
  /** The price/CVD divergences in view, newest last (the map draws them too); none while the pane is not drawn. */
  divergences: readonly Divergence[] = [];
  /** Called when `divergences` changed, so the map draws them again. */
  onDivergences: () => void = () => {};
  #divKey = '';

  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub) {
    super(host, store, view, 'delta');
    this.head.innerHTML = `<strong>${t('Delta')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('deltaPane'));
    setTip(this.head.querySelector('strong')!, t('What taker buys outweighed sells by in each candle, over the exchanges the flow column adds up.'));
    const d = (): DeltaSettings => this.store.state.delta;
    const patch = (change: Partial<DeltaSettings>): void => this.store.set({ delta: { ...d(), ...change } });
    const select = (label: string, title: string, options: [string, string][], get: () => string, set: (value: string) => void): void => {
      const wrap = document.createElement('label'); wrap.className = 'ctl'; setTip(wrap, title); wrap.append(label);
      const control = document.createElement('select');
      for (const [value, text] of options) control.append(new Option(text, value));
      control.value = get(); control.onchange = () => set(control.value);
      wrap.append(control); this.head.append(wrap);
      this.#sync.push(() => { if (control.value !== get()) control.value = get(); });
    };
    select(t('Show'), t('Each candle\'s delta as a bar, or the cumulative delta as candles.'), [['candles', t('CVD candles')], ['bars', t('Delta bars')]], () => d().style, v => patch({ style: v === 'bars' ? 'bars' : 'candles' }));
    const box = document.createElement('label'); box.className = 'ctl'; setTip(box, t('Mark where the price made a higher high and the CVD a lower one, or the price a lower low and the CVD a higher one, here and on the map.'));
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = d().divergence; check.onchange = () => patch({ divergence: check.checked });
    box.append(check, t('Divergences'));
    this.#sync.push(() => { check.checked = d().divergence; });
    select(t('CVD from'), t('Where the cumulative delta starts: the left edge of the chart, or again each day or week (in the Volume profile\'s zone).'), [['none', t('The left edge')], ['day', t('Each day')], ['week', t('Each week')]], () => d().reset, v => patch({ reset: v === 'day' || v === 'week' ? v : 'none' }));
    this.head.append(box);
    select(t('Swing'), t('How many candles each side a high or low must stand beyond to count as a swing. A swing is drawn only once that many candles have closed after it.'), PIVOTS.map((n): [string, string] => [String(n), tn(n, '{n} candle', '{n} candles')]), () => String(d().pivot), v => patch({ pivot: (PIVOTS as readonly number[]).includes(Number(v)) ? Number(v) : d().pivot }));
  }

  /** Reflect the settings in the header's controls and draw again. */
  settingsChanged(): void { for (const sync of this.#sync) sync(); this.invalidate(); }

  protected draw(): void {
    this.#lines = null;
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }
  protected override undrawn(): void { this.#lines = null; this.#card.hide(); this.#setDivergences([]); }

  #setDivergences(list: readonly Divergence[]): void {
    const key = list.map(d => `${d.kind}${d.from}-${d.to}`).join(',');
    this.divergences = list;
    if (key !== this.#divKey) { this.#divKey = key; this.onDivergences(); }
  }

  /** The candles of the view: the flow book asked for what they need, the closed ones worked out once, the open one every time. */
  #candles(state: AppState, now: number): { candles: DeltaCandle[]; starts: number[]; earliest: number | null } {
    const v = this.view, tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, s = state.delta, zone = resolveZone(state.traded.zone, state.timeZone), flow = this.hub.flow;
    const starts = candleStarts(v.t0, v.t1, now, tf, s.reset, zone);
    if (!starts.length) return { candles: [], starts, earliest: null };
    // The flow the candles need: the seconds the page holds (a day), and the minutes before them, as the flow column asks for them.
    const loadIds = flowLoadIds(state, flow.ids), from = starts[0]!, secondsFrom = Math.max(now - HISTORY_CAP_MS, from - 60_000);
    void this.hub.ensureFlow(loadIds, secondsFrom);
    if (from < secondsFrom - 60_000) {
      let latest = -Infinity;
      for (const id of loadIds) { const first = flow.get(id)?.span?.first; if (first !== undefined && first * 1000 > latest) latest = first * 1000; }
      if (latest === -Infinity && !flow.missing(loadIds, secondsFrom).length) latest = now;
      if (latest > -Infinity) void this.hub.ensureFlowMinutes(loadIds, Math.floor((from - 3_600_000) / MINUTES_FROM_MS) * MINUTES_FROM_MS, Math.ceil((latest + 120_000) / 3_600_000) * 3_600_000);
    }
    const ids = aggregateIds(flow, flowIds(state, flow.ids), id => kindOf(state.markets, id));
    const tracks = ids.flatMap(id => { const track = flow.track(id); return track ? [track] : []; });
    let earliest: number | null = null;
    for (const track of tracks) if (track.first !== null && (earliest === null || track.first * 1000 < earliest)) earliest = track.first * 1000;
    const flows = unrecorded(starts, this.#cache.get(`${ids.join(',')}|${tf}|${flow.loads}`, tracks, starts, tf, now), tf, now);
    return { candles: deltaCandles(starts, flows, resetKeys(starts, s.reset, zone)), starts, earliest };
  }

  #paint(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state = this.store.state, now = Date.now();
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, s = state.delta, readout = this.head.querySelector('.readout');
    const { candles, earliest } = this.#candles(state, now);
    this.candles = candles;
    // Divergences need the chart's candles to be this market's: a borrowed reference series is another market's price.
    const bars = state.seriesInstrument === state.marketId ? state.candles.map(c => ({ t: c[0], high: c[2], low: c[3] })) : [];
    this.#setDivergences(s.divergence && bars.length ? inView(divergences(bars, candles, tf, now, s.pivot), v.t0, v.t1) : []);
    const visible = candles.filter(c => c.t + tf >= v.t0 && c.t <= v.t1);
    if (!visible.length) {
      ctx.fillStyle = p.muted; ctx.textAlign = 'left';
      ctx.fillText(earliest === null ? t('No flow recorded for these candles yet.') : t('Flow is recorded from {time}: the candles before it have none.', { time: clock(earliest, true) }), 12, ph / 2);
      setHtml(readout, ''); return;
    }
    const asBars = s.style === 'bars';
    let lo = 0, hi = 0;
    for (const c of visible) { if (asBars) { lo = Math.min(lo, c.delta); hi = Math.max(hi, c.delta); } else { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); } }
    if (asBars) { const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1; lo = -m; hi = m; }
    const pad = (hi - lo) * 0.08 || 1, min = lo - pad, max = hi + pad, top = 6, bottom = ph - 6;
    const y = (value: number): number => top + (1 - (value - min) / (max - min)) * (bottom - top);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    // Zero, and where the CVD starts again (a day or week, or after a stretch with nothing recorded).
    ctx.strokeStyle = p.line; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.moveTo(0, Math.round(y(0)) + 0.5); ctx.lineTo(pw, Math.round(y(0)) + 0.5); ctx.stroke(); ctx.globalAlpha = 1;
    if (!asBars) {
      ctx.strokeStyle = p.muted; ctx.setLineDash([2, 4]); ctx.beginPath();
      for (let i = 1; i < candles.length; i++) {
        const c = candles[i]!;
        if (c.run === candles[i - 1]!.run || c.t + tf < v.t0 || c.t > v.t1) continue;
        const x = Math.round(v.xOf(c.t, pw)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, ph);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    for (const c of visible) {
      const x0 = v.xOf(c.t, pw), x1 = v.xOf(c.t + tf, pw), slot = x1 - x0, w = Math.max(1, Math.min(slot * 0.7, 40)), xc = (x0 + x1) / 2;
      if (asBars) {
        ctx.fillStyle = c.delta >= 0 ? p.candleUp : p.candleDown;
        const y0 = y(0), y1 = y(c.delta);
        ctx.fillRect(xc - w / 2, Math.min(y0, y1), w, Math.max(1, Math.abs(y1 - y0)));
      } else {
        const up = c.close >= c.open, color = up ? p.candleUp : p.candleDown;
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(xc) + 0.5, y(c.high)); ctx.lineTo(Math.round(xc) + 0.5, y(c.low)); ctx.stroke();
        const yo = y(c.open), yc = y(c.close);
        ctx.fillStyle = color; ctx.fillRect(xc - w / 2, Math.min(yo, yc), w, Math.max(1, Math.abs(yc - yo)));
      }
    }
    // The divergences on the CVD candles (the bars do not show the CVD): its two swings joined.
    if (!asBars) for (const d of this.divergences) paintDivergence(ctx, d, v.xOf(d.from + tf / 2, pw), y(d.cvdFrom), v.xOf(d.to + tf / 2, pw), y(d.cvdTo), d.kind === 'bear' ? p.ask : p.bid, null);
    ctx.restore();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    ctx.fillText(signed(hi), this.w - AXIS_W + 6, 10); ctx.fillText(signed(lo), this.w - AXIS_W + 6, ph - 10);
    // Readout and popup: the candle under the pointer (past the newest, the newest), else the newest.
    const hover = state.hover, newest = candles[candles.length - 1]!;
    let shown = newest;
    if (hover) { const under = [...candles].reverse().find(c => c.t <= hover.t); if (under) shown = under; }
    if (hover && this.pointer && shown === newest && hover.t >= newest.t + tf) this.cursorT = newest.t + tf / 2;
    if (hover && this.pointer) this.#lines = deltaCardLines(shown, state.timeframe);
    const since = earliest !== null && earliest > v.t0 ? ` <span class="muted">${t('flow recorded since {time}', { time: clock(earliest, true) })}</span>` : '';
    setHtml(readout, `Δ <b class="${shown.delta > 0 ? 'bid' : shown.delta < 0 ? 'ask' : ''}">${signed(shown.delta)}</b> ${t('CVD')} <b class="${shown.close > 0 ? 'bid' : shown.close < 0 ? 'ask' : ''}">${signed(shown.close)}</b>${since}`);
  }
}
