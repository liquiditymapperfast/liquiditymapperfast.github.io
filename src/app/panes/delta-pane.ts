import { TIMEFRAMES, type Hub } from '../hub.ts';
import type { Store, AppState } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton } from '../help.ts';
import { setTip } from '../tip.ts';
import { t, tn } from '../i18n.ts';
import { addTune } from '../pane-tune.ts';
import { clock, usd } from '../format.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { flowLoadIds } from '../cvd/ids.ts';
import { resolveZone } from '../traded/settings.ts';
import { AXIS_W } from './heat-pane.ts';
import { TimePane, setHtml } from './lower-panes.ts';
import { FlowCache, candleStarts, deltaCandles, resetKeys, type CandleFlow, type DeltaCandle } from '../delta/candles.ts';
import { deltaFlows, deltaIds, ensureDeltaFlow } from '../delta/flows.ts';
import { PIVOTS, type DeltaSettings } from '../delta/settings.ts';
import { divergences, inView, paintDivergence, type Divergence } from '../delta/divergence.ts';
import { coinText, nlnsCardLines, type NlnsCandle } from '../delta/nlns.ts';
import type { NlnsSource } from '../delta/nlns-source.ts';
import { venueLabel } from '../venues.ts';
import { togglePanel, type Panel } from '../ui.ts';
import { buildOiMarketsPanel } from '../market-picker.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import type { DeltaPaneHeld } from '../range/delta-lines.ts';
import { BAR_CUT_H, BAR_CUT_PX, barScale, cutGap, partsWithin } from '../bar-scale.ts';

/** Two NL/NS models' candles alike by value (the model is worked out again every second, often to the same figures). */
function sameModel(a: ReadonlyMap<number, NlnsCandle> | null, b: ReadonlyMap<number, NlnsCandle> | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [t, x] of a) {
    const y = b.get(t);
    if (!y || x.dOi !== y.dOi || x.longOpened !== y.longOpened || x.shortOpened !== y.shortOpened || x.longClosed !== y.longClosed || x.shortClosed !== y.shortClosed
      || x.unsidedUp !== y.unsidedUp || x.unsidedDown !== y.unsidedDown || x.byPrice !== y.byPrice || x.fine !== y.fine || x.counted !== y.counted) return false;
  }
  return true;
}

/**
 * What the Delta pane's sums are of (the Range summary's snapshot must be of the same): the coin, the timeframe, what it shows and how, where
 * the CVD starts again and in which zone, the flow column's markets it counts, and (NL/NS) whose open interest.
 */
export function deltaHeldKey(state: AppState, ids: readonly string[]): string {
  const s = state.delta, zone = resolveZone(state.traded.zone, state.timeZone);
  const oi = s.style === 'nlns' ? `|${state.oiParts.length > 1 ? state.oiParts.map(part => part.id).join(',') : state.oiInstrument}` : '';
  return `${state.marketId}|${state.timeframe}|${s.style}|${s.nlns}|${s.reset}|${zone}|${ids.join(',')}${oi}`;
}

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
  #marketsPanel: Panel | null = null;
  /** The candles drawn last. */
  candles: DeltaCandle[] = [];
  /** The price/CVD divergences in view, newest last (the map draws them too); none while the pane is not drawn. */
  divergences: readonly Divergence[] = [];
  /** Called when `divergences` changed, so the map draws them again. */
  onDivergences: () => void = () => {};
  #divKey = '';

  /** `nlns`: the NL/NS model the OI and Funding panes read too (delta/nlns-source.ts). */
  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub, private readonly nlns: NlnsSource) {
    super(host, store, view, 'delta');
    this.head.innerHTML = `<strong>${t('Delta')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('deltaPane'));
    setTip(this.head.querySelector('strong')!, t('What taker buys outweighed sells by in each candle, over the exchanges the flow column adds up.'));
    const d = (): DeltaSettings => this.store.state.delta;
    const patch = (change: Partial<DeltaSettings>): void => this.store.set({ delta: { ...d(), ...change } });
    // One group, so the header's rule that puts its last control at the right edge moves them all together.
    const group = document.createElement('span'); group.className = 'ctl ctl-group'; this.head.append(group);
    const select = (label: string, title: string, options: [string, string][], get: () => string, set: (value: string) => void): HTMLElement => {
      const wrap = document.createElement('label'); wrap.className = 'ctl'; setTip(wrap, title); wrap.append(label);
      const control = document.createElement('select');
      for (const [value, text] of options) control.append(new Option(text, value));
      control.value = get(); control.onchange = () => set(control.value);
      wrap.append(control); group.append(wrap);
      this.#sync.push(() => { if (control.value !== get()) control.value = get(); });
      return wrap;
    };
    select(t('Show'), t('Each candle\'s delta as a bar, the cumulative delta as candles, or NL/NS: the change of open interest given to the side that traded at market.'), [['candles', t('CVD candles')], ['bars', t('Delta bars')], ['nlns', 'NL/NS']], () => d().style, v => patch({ style: v === 'bars' || v === 'nlns' ? v : 'candles' }));
    // NL/NS as each candle's four parts, or the longs' and shorts' sums apart; only while NL/NS is shown. The setting keeps
    // its value 'net' for the four parts (saved pages and layouts read it so).
    const split = select(t('As'), t('NL/NS as each candle\'s four parts (buyers above the line, sellers below; opened solid, closed lighter), or the running sums of the longs and of the shorts as two lines.'), [['net', t('Four parts')], ['split', t('Longs and shorts')]], () => d().nlns, v => patch({ nlns: v === 'split' ? 'split' : 'net' }));
    // Whose open interest NL/NS counts: the OI pane's markets, chosen here too so the OI pane need not be shown.
    const markets = document.createElement('button'); markets.type = 'button'; markets.textContent = t('Markets…');
    setTip(markets, t('Whose open interest NL/NS counts: the OI pane\'s markets, chosen here or in the OI pane.'));
    const build = (_tools: HTMLElement, body: HTMLElement): void => buildOiMarketsPanel(this.store, this.hub.flow, body, () => this.#marketsPanel?.render(build));
    markets.onclick = () => { this.#marketsPanel = togglePanel(markets, { title: t('Open interest markets'), width: 380, align: 'right', onClose: () => { this.#marketsPanel = null; } }, build); };
    group.insertBefore(markets, split.nextSibling);
    const showSplit = (): void => { split.hidden = d().style !== 'nlns'; markets.hidden = d().style !== 'nlns'; };
    showSplit(); this.#sync.push(showSplit);
    const box = document.createElement('label'); box.className = 'ctl'; setTip(box, t('Mark where the price made a higher high and the CVD a lower one, or the price a lower low and the CVD a higher one, here and on the map.'));
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = d().divergence; check.onchange = () => patch({ divergence: check.checked });
    box.append(check, t('Divergences'));
    this.#sync.push(() => { check.checked = d().divergence; });
    const from = select(t('CVD from'), t('Where the cumulative delta starts: the left edge of the chart, or again each day or week (in the Volume profile\'s zone).'), [['none', t('The left edge')], ['day', t('Each day')], ['week', t('Each week')]], () => d().reset, v => patch({ reset: v === 'day' || v === 'week' ? v : 'none' }));
    group.append(box);
    const swing = select(t('Swing'), t('How many candles each side a high or low must stand beyond to count as a swing. A swing is drawn only once that many candles have closed after it.'), PIVOTS.map((n): [string, string] => [String(n), tn(n, '{n} candle', '{n} candles')]), () => String(d().pivot), v => patch({ pivot: (PIVOTS as readonly number[]).includes(Number(v)) ? Number(v) : d().pivot }));
    // Divergences are the CVD's: NL/NS draws none, so its header leaves their two controls out (they wrapped the header onto a third row and
    // took the plot's height for nothing).
    const showCvd = (): void => { box.hidden = d().style === 'nlns'; swing.hidden = d().style === 'nlns'; };
    showCvd(); this.#sync.push(showCvd);
    // On a phone what is shown stays in the row; the rest waits behind the key (pane-tune.ts).
    addTune(this.head, [split, markets, from, box, swing], t('Delta'));
  }

  /** Reflect the settings in the header's controls and draw again. */
  settingsChanged(): void { for (const sync of this.#sync) sync(); this.invalidate(); }

  protected draw(): void {
    this.#lines = null;
    const held = this.#held;
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
    // The Range summary is worked out again only when what the pane holds changed (a pointer move draws it with the same).
    if (this.#held !== held) this.rangeChanged();
  }

  /** What the pane drew last, for the Range summary of a selection made in it (range/delta-lines.ts); null before it drew. */
  get rangeHeld(): DeltaPaneHeld | null { return this.#held; }
  #held: DeltaPaneHeld | null = null;
  /**
   * Keep what this drawing is made of. The candles are worked out afresh on every drawing, so the snapshot is replaced only when what it
   * holds changed: the settings, the candle starts, any candle's flow (the closed ones are the cache's same objects), the price or the model.
   */
  #keep(next: Omit<DeltaPaneHeld, 'candles'> & { candles: readonly DeltaCandle[] }): void {
    const held = this.#held;
    // By value: the candle under way is a new object on every drawing, and NL/NS's model a new array every second.
    const sameFlow = (a: CandleFlow | null | undefined, b: CandleFlow | null | undefined): boolean => a === b || (!!a && !!b && a.delta === b.delta && a.gross === b.gross && a.low === b.low && a.high === b.high);
    const same = held !== null && held.key === next.key && held.mode === next.mode && held.reset === next.reset && held.replayAt === next.replayAt && held.earliest === next.earliest && held.firsts.length === next.firsts.length && held.firsts.every((f, i) => f === next.firsts[i])
      && held.tfMs === next.tfMs && held.markets === next.markets && held.coin === next.coin && held.ownPrice === next.ownPrice && held.priceMarket === next.priceMarket
      && held.candlesPrice === next.candlesPrice && sameModel(held.nlns, next.nlns) && held.whose === next.whose && held.starts.length === next.starts.length
      && held.starts.every((s, i) => s === next.starts[i] && sameFlow(held.raw[i], next.raw[i]) && sameFlow(held.flows[i], next.flows[i]) && held.support[i] === next.support[i]);
    if (same) return;
    this.#held = { ...next, candles: new Map(next.candles.map(c => [c.t, c] as const)) };
  }
  protected override undrawn(): void { this.#lines = null; this.#card.hide(); this.#setDivergences([]); }

  #setDivergences(list: readonly Divergence[]): void {
    const key = list.map(d => `${d.kind}${d.from}-${d.to}`).join(',');
    this.divergences = list;
    if (key !== this.#divKey) { this.#divKey = key; this.onDivergences(); }
  }

  /** Ask the flow book for what candles from `from` need (delta/flows.ts, shared with the volume profile along the top of the map). */
  #ensure(loadIds: string[], from: number, now: number): void { ensureDeltaFlow(this.hub, loadIds, from, now); }

  /** The candles of the view: the flow book asked for what they need, the closed ones worked out once, the open one every time. */
  #candles(state: AppState, now: number): { candles: DeltaCandle[]; starts: number[]; earliest: number | null; flows: (CandleFlow | null)[]; raw: (CandleFlow | null)[]; ids: string[]; support: number[]; firsts: (number | null)[] } {
    const v = this.view, tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, s = state.delta, zone = resolveZone(state.traded.zone, state.timeZone), flow = this.hub.flow;
    const starts = candleStarts(v.t0, v.t1, now, tf, s.reset, zone, undefined, s.style !== 'bars');
    const ids = deltaIds(state, flow), firsts = ids.map(id => flow.track(id)?.first ?? null);
    if (!starts.length) return { candles: [], starts, earliest: null, flows: [], raw: [], ids, support: [], firsts };
    this.#ensure(flowLoadIds(state, flow.ids), starts[0]!, Date.now());
    const { flows, raw, earliest } = deltaFlows(this.#cache, flow, ids, starts, tf, now);
    // How many of the markets each candle counts: a market counts from the candle whose start its flow reaches back to (candleFlow's rule).
    const support = starts.map(start => { const sec = Math.floor(start / 1000) - 1; return firsts.filter(f => f !== null && f <= sec).length; });
    return { candles: deltaCandles(starts, flows, resetKeys(starts, s.reset, zone)), starts, earliest, flows, raw, ids, support, firsts };
  }

  /** The chart's candles, whether they are the coin's own market's, and its name. */
  #price(state: AppState): Pick<DeltaPaneHeld, 'candlesPrice' | 'ownPrice' | 'priceMarket'> {
    const chart = state.seriesInstrument || state.marketId;
    return { candlesPrice: state.candles, ownPrice: state.seriesInstrument === state.marketId, priceMarket: chart ? `${venueLabel(chart)} ${chart.split(':').slice(1).join(':')}` : '' };
  }

  /**
   * NL/NS (delta/nlns.ts, the model shared with the OI and Funding panes): each candle's change of open interest of the OI pane's markets, each
   * market's given to the side that traded at market on it (its own flow, minute by minute where its minute readings reach; the way the price
   * went where none is recorded). Four parts (`nlns` 'net'): each candle's bar holds all four, the buyers' above the line (new longs solid,
   * nearest it, then shorts closed, lighter) and the sellers' below (new shorts solid, then longs closed), the full height of the pane against
   * `barScale` (bar-scale.ts: the few far larger than the rest are cut and marked, their parts in proportion). No line: a running sum on the bars' axis took the
   * scale in any long view and pressed the bars to a few pixels (2026-11-10); the running net is in the readout and the popup, and Longs and
   * shorts (`nlns` 'split') draws each side's running sum. The net bar Four parts replaced drew longs less shorts alone: a candle where both
   * sides opened and closed hundreds of coins could show a sliver. What went to no side (takers even, side unknown) is in the popup, not the
   * bars. In coins; the readout names the market or how many venues are added together.
   */
  #nlnsModel: { model: readonly NlnsCandle[]; byStart: Map<number, NlnsCandle> } | null = null;
  #paintNlns(state: AppState, now: number, readout: Element | null): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, s = state.delta;
    const oiInst = state.oiInstrument;
    const coin = state.markets.find(m => (m.instrumentId ?? m.id) === state.marketId)?.base ?? '';
    const aggregated = state.oiParts.length > 1, count = aggregated ? state.oiParts.length : 1;
    const market = aggregated ? t('{n} venues added together', { n: state.oiParts.length }) : oiInst ? `${venueLabel(oiInst)} ${oiInst.split(':').slice(1).join(':')}` : '';
    const candles = this.nlns.forView(state, v.t0, v.t1, now);
    // The Range summary reads the model this drawing used (its candles by start), never working one out itself.
    if (this.#nlnsModel?.model !== candles) this.#nlnsModel = { model: candles, byStart: new Map(candles.map(c => [c.t, c] as const)) };
    const ids = deltaIds(state, this.hub.flow), asked = this.nlns.starts(state, v.t0, v.t1, now);
    this.#keep({ key: deltaHeldKey(state, ids), mode: 'nlns', tfMs: tf, tf: state.timeframe, reset: s.reset, starts: asked, flows: [], raw: [], candles: [], support: [], markets: ids.length, earliest: null, firsts: [], ...this.#price(state), nlns: this.#nlnsModel.byStart, whose: market, coin, replayAt: replaying() ? Math.floor(now / tf) * tf : null });
    const visible = candles.filter(c => c.t + tf >= v.t0 && c.t <= v.t1);
    if (!visible.length) {
      ctx.fillStyle = p.muted; ctx.textAlign = 'left';
      ctx.fillText(!aggregated && (!oiInst || !state.oi.length) ? t('No open interest for this market.') : t('No change of open interest is held for these candles yet.'), 12, ph / 2);
      setHtml(readout, ''); return;
    }
    // Split: the longs' and the shorts' running sums as two lines on one scale, no bars (what each candle added is in the popup).
    const split = s.nlns === 'split';
    // Four parts: what buyers did (new longs, shorts closed) above the line, what sellers did (new shorts, longs closed) below it.
    const ups = visible.map(c => c.longOpened + c.shortClosed), downs = visible.map(c => c.shortOpened + c.longClosed);
    const cap = split ? 0 : barScale([...ups, ...downs]);
    let lo = 0, hi = 0;
    visible.forEach((c, k) => {
      if (split) { lo = Math.min(lo, c.cumLongs, c.cumShorts); hi = Math.max(hi, c.cumLongs, c.cumShorts); }
      else { lo = Math.min(lo, -Math.min(downs[k]!, cap)); hi = Math.max(hi, Math.min(ups[k]!, cap)); }
    });
    const pad = (hi - lo) * 0.08 || 1, min = lo - pad, max = hi + pad, top = 6, bottom = ph - 6;
    const y = (value: number): number => top + (1 - (value - min) / (max - min)) * (bottom - top);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    ctx.strokeStyle = p.line; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.moveTo(0, Math.round(y(0)) + 0.5); ctx.lineTo(pw, Math.round(y(0)) + 0.5); ctx.stroke(); ctx.globalAlpha = 1;
    // Where the running sums restart: only where they are drawn (Longs and shorts).
    if (split) {
      ctx.strokeStyle = p.muted; ctx.setLineDash([2, 4]); ctx.beginPath();
      for (let i = 1; i < candles.length; i++) {
        const c = candles[i]!;
        if (c.run === candles[i - 1]!.run || c.t + tf < v.t0 || c.t > v.t1) continue;
        const x = Math.round(v.xOf(c.t, pw)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, ph);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    // A running sum, broken where it restarts.
    const line = (value: (c: NlnsCandle) => number, color: string, width: number): void => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
      let run = -1;
      for (const c of visible) { const x = v.xOf(c.t + tf / 2, pw); if (c.run !== run) { ctx.moveTo(x, y(value(c))); run = c.run; } else ctx.lineTo(x, y(value(c))); }
      ctx.stroke(); ctx.lineWidth = 1;
    };
    if (split) {
      line(c => c.cumLongs, p.candleUp, 1.5); line(c => c.cumShorts, p.candleDown, 1.5);
      // Each line named at its right end, the upper one above it and the lower one below.
      const last = visible[visible.length - 1]!, x = Math.min(pw - 4, v.xOf(last.t + tf / 2, pw) - 4), up = last.cumLongs >= last.cumShorts ? 1 : -1;
      // Inside the clip's save, so the font goes back with it.
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'right';
      ctx.fillStyle = p.candleUp; ctx.fillText(t('Longs'), x, Math.max(top + 6, Math.min(bottom - 6, y(last.cumLongs) - 8 * up)));
      ctx.fillStyle = p.candleDown; ctx.fillText(t('Shorts'), x, Math.max(top + 6, Math.min(bottom - 6, y(last.cumShorts) + 8 * up)));
    } else {
      // One side's parts outward from the line, each [coins, colour, opened]: opened solid, closed lighter and outlined where there is room.
      // A side past the scale is drawn to it with each part its share of the side, as the OI pane's bars keep theirs (cut in stacking order,
      // a closed part behind a large opened one vanished: review, 2026-11-10), and a gap across it near its end (the popup gives the sizes).
      const stack = (xl: number, w: number, sign: 1 | -1, parts: readonly (readonly [number, string, boolean])[], total: number): void => {
        const sizes = partsWithin(parts.map(part => part[0]), cap);
        let at = 0;
        for (const [i, [, color, opened]] of parts.entries()) {
          const size = sizes[i]!;
          if (size > 0) {
            const ya = y(sign * at), yb = y(sign * (at + size)), top = Math.min(ya, yb), h = Math.max(1, Math.abs(yb - ya));
            ctx.fillStyle = color; ctx.globalAlpha = opened ? 1 : 0.35; ctx.fillRect(xl, top, w, h);
            if (!opened && w >= 4 && h >= 3) { ctx.globalAlpha = 0.9; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(Math.round(xl) + 0.5, Math.round(top) + 0.5, Math.max(1, Math.round(w) - 1), Math.max(1, Math.round(h) - 1)); }
          }
          at += size;
        }
        ctx.globalAlpha = 1;
        if (total > cap) { const yc = y(sign * cap); cutGap(ctx, xl, sign > 0 ? yc + BAR_CUT_PX : yc - BAR_CUT_PX - BAR_CUT_H, w); }
      };
      visible.forEach((c, k) => {
        const x0 = v.xOf(c.t, pw), x1 = v.xOf(c.t + tf, pw), w = Math.max(1, Math.min((x1 - x0) * 0.7, 40)), xl = (x0 + x1) / 2 - w / 2;
        stack(xl, w, 1, [[c.longOpened, p.candleUp, true], [c.shortClosed, p.candleUp, false]], ups[k]!);
        stack(xl, w, -1, [[c.shortOpened, p.candleDown, true], [c.longClosed, p.candleDown, false]], downs[k]!);
      });
    }
    ctx.restore();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    ctx.fillText(coinText(hi, coin), this.w - AXIS_W + 6, 10); ctx.fillText(coinText(lo, coin), this.w - AXIS_W + 6, ph - 10);
    const hover = state.hover, newest = candles[candles.length - 1]!;
    let shown = newest;
    if (hover) { const under = [...candles].reverse().find(c => c.t <= hover.t); if (under) shown = under; }
    if (hover && this.pointer && shown === newest && hover.t >= newest.t + tf) this.cursorT = newest.t + tf / 2;
    if (hover && this.pointer) this.#lines = nlnsCardLines(shown, state.timeframe, coin, market, count);
    const tone = (x: number): string => x > 0 ? 'bid' : x < 0 ? 'ask' : '';
    const byPrice = visible.some(c => c.byPrice) ? ` · ${t('side by price where no flow is recorded')}` : '';
    const where = `<span class="muted">${aggregated ? market : t('from {venue}', { venue: market })}${byPrice}</span>`;
    // Split: the longs' sum is good for longs when it rises, the shorts' for shorts.
    if (split) setHtml(readout, `NL/NS ${t('since the start')} ${t('Longs')} <b class="${tone(shown.cumLongs)}">${coinText(shown.cumLongs, coin)}</b> ${t('Shorts')} <b class="${tone(-shown.cumShorts)}">${coinText(shown.cumShorts, coin)}</b> ${where}`);
    else setHtml(readout, `NL/NS <b class="${tone(shown.v)}">${coinText(shown.v, coin)}</b> ${t('since the start')} <b class="${tone(shown.cum)}">${coinText(shown.cum, coin)}</b> ${where}`);
  }

  #paint(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state = this.store.state, now = pageNow();
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, s = state.delta, readout = this.head.querySelector('.readout');
    if (s.style === 'nlns') { this.candles = []; this.#setDivergences([]); this.#paintNlns(state, now, readout); return; }
    const { candles, earliest, starts, flows, raw, ids, support, firsts } = this.#candles(state, now);
    this.candles = candles;
    this.#keep({ key: deltaHeldKey(state, ids), mode: s.style === 'bars' ? 'bars' : 'cvd', tfMs: tf, tf: state.timeframe, reset: s.reset, starts, flows, raw, candles, support, markets: ids.length, earliest, firsts, ...this.#price(state), nlns: null, whose: '', coin: '', replayAt: replaying() ? Math.floor(now / tf) * tf : null });
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
