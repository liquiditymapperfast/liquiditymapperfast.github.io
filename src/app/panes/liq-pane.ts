import type { Hub } from '../hub.ts';
import type { Store } from '../store.ts';
import { PALETTES, resolveThemeId, rgb, type Palette } from '../theme.ts';
import { t } from '../i18n.ts';
import { helpButton } from '../help.ts';
import { el } from '../dom.ts';
import { replaying } from '../replay/clock.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import { currentCoin } from '../coin.ts';
import { niceStep } from '../view.ts';
import { paintInfoBox, type InfoLine } from '../infobox.ts';
import { ratioText } from '../mirror.ts';
import { distanceText } from './ladder-info.ts';
import { binsIn, dollarPriceOf, liqProfile, standingBelow, type LiqLevels, type LiqProfile, type LiqStanding } from '../liq-levels.ts';
import { pixelRatio, sharpens } from '../pixel-ratio.ts';

/** How far either side of the price the ladder reaches: the chips under the summary. */
const RANGES = [0.01, 0.025, 0.05, 0.1] as const;
const RANGE_KEY = 'hlm-liq-range';
/** The price axis on the right, the room above and below the outermost row, and the height a row aims for (px). */
const AXIS = 60, PAD = 12, ROW_PX = 4;
/** The fewest ms between two drawings: the price ticks many times a second, the levels change every half hour. */
const PAINT_MS = 200;
/** How far from the price the milestones are marked, as fractions: those that fit the range and stand apart. */
const MILESTONES = [0.0025, 0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1];
const NUM_FONT = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS = 'ui-sans-serif, system-ui, sans-serif';

/** A colour of the palette at an opacity, for gradients and glows. */
function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
}

const pctText = (fraction: number): string => `${Number((fraction * 100).toFixed(2))}%`;

/**
 * The phone's Liq tab (dock.ts, next to the Book): Hyperliquid's BTC liquidation levels as a ladder that fills the screen, centred on the
 * price. Each level is a bar out of the price axis, shorts above in the rising colour and longs below in the falling one; behind them two
 * mountains grow away from the price, everything that would be liquidated if price got that far, read at the marked distances; the
 * largest levels are named. Above it the summary weighs the longs below against the shorts above within the range chosen, and a finger on
 * the ladder reads any price: its distance, what would go on the way there, what sits at that level, and the same distance the other way.
 * The levels are the map's (liq-levels.ts): this pane keeps them fresh while it shows, the map being covered then.
 */
export class LiqPane {
  readonly root = el('div', { class: 'pane liq' });
  #longUsd = el('b', { class: 'liq-usd long' });
  #shortUsd = el('b', { class: 'liq-usd short' });
  #balanceLong = el('i', { class: 'long' });
  #balanceShort = el('i', { class: 'short' });
  #within = el('span', { class: 'liq-within' });
  #ratio = el('span', { class: 'liq-ratio' });
  #summary: HTMLElement;
  #ranges = el('div', { class: 'seg liq-range', role: 'group', ariaLabel: t('Range') });
  #body = el('div', { class: 'liq-body' });
  #canvas = el('canvas');
  #pulse = el('i', { class: 'liq-pulse', ariaHidden: 'true' });
  #foot = el('div', { class: 'liq-foot' });
  #ctx: CanvasRenderingContext2D;
  #palette: Palette = PALETTES.dark!;
  #range: number = RANGES[1];
  #shown = false;
  #timer = 0;
  #paintTimer = 0;
  #lastPaint = 0;
  #w = 0;
  #h = 0;
  #dpr = 1;
  /** The price a finger reads, or null. */
  #probe: number | null = null;
  /** The price the ladder was last drawn around, and its scale, for the finger. */
  #frame: { price: number; span: number } | null = null;

  constructor(parent: HTMLElement, private store: Store, private hub: Hub) {
    try { const saved = Number(window.localStorage.getItem(RANGE_KEY)); if ((RANGES as readonly number[]).includes(saved)) this.#range = saved; } catch { /* storage unavailable */ }
    for (const r of RANGES) {
      const button = el('button', { type: 'button', textContent: `±${pctText(r)}`, onclick: () => this.#setRange(r) });
      button.dataset.range = String(r);
      this.#ranges.append(button);
    }
    this.#markRange();
    const head = el('div', { class: 'pane-head liq-head' },
      el('strong', { textContent: t('Liquidation levels') }),
      el('span', { class: 'liq-sub', textContent: t('BTC · Hyperliquid') }),
      helpButton('liqLevels'));
    this.#summary = el('div', { class: 'liq-sum' },
      el('div', { class: 'liq-side long' }, el('small', { textContent: t('Longs') }), this.#longUsd),
      el('div', { class: 'liq-side short' }, el('small', { textContent: t('Shorts') }), this.#shortUsd),
      el('div', { class: 'liq-balance', ariaHidden: 'true' }, this.#balanceLong, this.#balanceShort),
      el('div', { class: 'liq-meta' }, this.#within, this.#ratio));
    this.#body.append(this.#canvas, this.#pulse);
    this.root.append(head, this.#summary, this.#ranges, this.#body, this.#foot);
    // Until the first drawing has numbers to put in them (a reason shows meanwhile).
    this.#summary.hidden = true; this.#ranges.hidden = true; this.#pulse.hidden = true;
    parent.append(this.root);
    this.#ctx = this.#canvas.getContext('2d')!;
    new ResizeObserver(() => this.#resize()).observe(this.#body);
    sharpens({ resize: () => this.#resize(), paint: () => { if (this.#shown) this.#paint(); } });
    this.#bindTouch();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.#shown) this.#tick(); });
  }

  setPalette(name: string): void { this.#palette = PALETTES[resolveThemeId(name)] ?? PALETTES.dark!; this.invalidate(); }

  /** Shown while its tab is open: it keeps the levels fresh then (the map, covered, does not) and draws; hidden, it does nothing. */
  setShown(on: boolean): void {
    if (on === this.#shown) return;
    this.#shown = on;
    window.clearInterval(this.#timer); this.#timer = 0;
    if (on) { this.#resize(); this.#tick(); this.#timer = window.setInterval(() => this.#tick(), 1000); }
  }

  /** Draw again soon (the price moved, the levels came); at most every PAINT_MS. */
  invalidate(): void {
    if (!this.#shown || this.#paintTimer) return;
    const wait = Math.max(0, PAINT_MS - (performance.now() - this.#lastPaint));
    this.#paintTimer = window.setTimeout(() => { this.#paintTimer = 0; this.#lastPaint = performance.now(); this.#paint(); }, wait);
  }

  #tick(): void {
    const src = this.hub.liqLevels;
    src.ensure(currentCoin(), () => this.invalidate());
    if (src.levels && !replaying()) src.observe(dollarPriceOf(this.store.state));
    this.invalidate();
  }

  #setRange(r: number): void {
    this.#range = r; this.#markRange();
    try { window.localStorage.setItem(RANGE_KEY, String(r)); } catch { /* storage unavailable */ }
    this.invalidate();
  }
  #markRange(): void { for (const b of this.#ranges.children) b.classList.toggle('on', (b as HTMLElement).dataset.range === String(this.#range)); }

  #resize(): void {
    const w = this.#body.clientWidth, h = this.#body.clientHeight;
    if (!w || !h) return;
    this.#dpr = Math.min(pixelRatio(), 2); this.#w = w; this.#h = h;
    this.#canvas.width = Math.round(w * this.#dpr); this.#canvas.height = Math.round(h * this.#dpr);
    this.#canvas.style.width = `${w}px`; this.#canvas.style.height = `${h}px`;
    this.#lastPaint = 0; this.invalidate();
  }

  /** A finger on the ladder reads that price; a tap where it already reads lets go. */
  #bindTouch(): void {
    const priceAt = (e: PointerEvent): number | null => {
      const f = this.#frame; if (!f) return null;
      const y = e.clientY - this.#canvas.getBoundingClientRect().top, mid = this.#h / 2, half = this.#h / 2 - PAD;
      return f.price + (mid - y) / half * f.span;
    };
    let down: { y: number; had: boolean; moved: boolean } | null = null;
    this.#canvas.addEventListener('pointerdown', e => {
      const at = priceAt(e); if (at === null) return;
      down = { y: e.clientY, had: this.#probe !== null && Math.abs(at - this.#probe) / (this.#frame!.span || 1) < 0.04, moved: false };
      try { this.#canvas.setPointerCapture(e.pointerId); } catch { /* a pointer the browser no longer tracks */ }
      if (!down.had) { this.#probe = at; this.invalidate(); }
    });
    this.#canvas.addEventListener('pointermove', e => {
      if (!down) return;
      if (Math.abs(e.clientY - down.y) > 4) down.moved = true;
      const at = priceAt(e); if (at !== null && down.moved) { this.#probe = at; this.invalidate(); }
    });
    const up = (): void => { if (down?.had && !down.moved) { this.#probe = null; this.invalidate(); } down = null; };
    this.#canvas.addEventListener('pointerup', up); this.#canvas.addEventListener('pointercancel', up);
  }

  #paint(): void {
    const ctx = this.#ctx, p = this.#palette, W = this.#w, H = this.#h;
    if (!this.#shown || W < 80 || H < 80) return;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.fillStyle = p.bg; ctx.fillRect(0, 0, W, H);
    const src = this.hub.liqLevels, levels = src.levels, state = this.store.state;
    const why = replaying() ? t('Liquidation levels show the live market only.') : src.state === 'other-coin' ? t('Liquidation levels are for BTC only for now.')
      : !levels ? (src.state === 'unavailable' ? t('Liquidation levels could not be read.') : t('Liquidation levels are loading.'))
      : src.state === 'stale' ? t('Liquidation levels are out of date: the newest are from {time}.', { time: clock(levels.asOf) }) : '';
    const s = why ? null : src.standing();
    if (!s || !levels) { this.#empty(why || t('Liquidation levels are loading.')); return; }
    const live = dollarPriceOf(state), price = live > 0 ? live : src.lastPrice();
    if (!(price > 0)) { this.#empty(t('Liquidation levels are loading.')); return; }
    this.#summary.hidden = false; this.#ranges.hidden = false; this.#pulse.hidden = false;

    const span = price * this.#range, mid = H / 2, half = H / 2 - PAD, xR = W - AXIS, plotW = xR;
    const yOf = (pr: number): number => mid - (pr - price) / span * half;
    const lo = price - span, hi = price + span, step = niceStep(2 * span, Math.max(24, (H - 2 * PAD) / ROW_PX));
    const prof = liqProfile(s, step, lo, hi, price);
    this.#frame = { price, span };

    this.#paintSummary(s, levels, price, lo, hi);
    this.#paintGrid(ctx, p, price, lo, hi, span, yOf, xR, W);
    this.#paintMountains(ctx, p, prof, step, price, yOf, xR, plotW, mid);
    const placed = this.#paintMilestones(ctx, p, s, price, yOf, plotW);
    this.#paintBars(ctx, p, prof, step, levels, yOf, xR, plotW, H, placed);
    this.#paintPrice(ctx, p, price, mid, xR, W);
    if (this.#probe !== null) this.#paintProbe(ctx, p, s, levels, prof, step, price, yOf, xR, W, H);
  }

  /** The summary: the longs that would go below and the shorts above within the range, weighed against each other. */
  #paintSummary(s: LiqStanding, levels: LiqLevels, price: number, lo: number, hi: number): void {
    const longs = Math.max(0, standingBelow(s, 'long', price) - standingBelow(s, 'long', lo));
    const shorts = Math.max(0, standingBelow(s, 'short', hi) - standingBelow(s, 'short', price));
    this.#longUsd.textContent = `$${usd(longs)}`; this.#shortUsd.textContent = `$${usd(shorts)}`;
    const total = longs + shorts, share = total > 0 ? longs / total : 0.5;
    this.#balanceLong.style.flexGrow = String(share); this.#balanceShort.style.flexGrow = String(1 - share);
    this.#within.textContent = t('Within ±{pct} of {price}', { pct: pctText(this.#range), price: fmtPrice(price) });
    const big = Math.max(longs, shorts), small = Math.min(longs, shorts);
    this.#ratio.textContent = big > 0 ? `${longs >= shorts ? t('Longs') : t('Shorts')} ${ratioText(small > 0 ? big / small : Infinity)}` : '';
    this.#ratio.className = `liq-ratio ${longs >= shorts ? 'long' : 'short'}`;
    const late = this.hub.liqLevels.candlesLate() ? ` · ${t('Hyperliquid\'s candles could not be read, so a level price has passed may still show.')}` : '';
    this.#foot.textContent = `${t('Hyperliquid liquidation levels at {time} · Powered by HyperTracker', { time: clock(levels.asOf) })}${late}`;
  }

  /** Nothing to draw: the reason, in the middle, and no summary. */
  #empty(why: string): void {
    const ctx = this.#ctx, p = this.#palette, W = this.#w, H = this.#h;
    this.#summary.hidden = true; this.#ranges.hidden = true; this.#pulse.hidden = true; this.#frame = null;
    this.#foot.textContent = '';
    ctx.fillStyle = p.muted; ctx.font = `13px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const words = why.split(' '), lines: string[] = [];
    let line = '';
    for (const word of words) { const next = line ? `${line} ${word}` : word; if (line && ctx.measureText(next).width > W - 48) { lines.push(line); line = word; } else line = next; }
    if (line) lines.push(line);
    lines.forEach((text, i) => ctx.fillText(text, W / 2, H / 2 + (i - (lines.length - 1) / 2) * 18));
  }

  /** The price axis: nice prices every so often, and faint lines across. */
  #paintGrid(ctx: CanvasRenderingContext2D, p: Palette, price: number, lo: number, hi: number, span: number, yOf: (pr: number) => number, xR: number, W: number): void {
    const labelStep = niceStep(2 * span, 8);
    ctx.font = NUM_FONT; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillStyle = p.panel; ctx.fillRect(xR, 0, W - xR, this.#h);
    ctx.strokeStyle = p.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xR + 0.5, 0); ctx.lineTo(xR + 0.5, this.#h); ctx.stroke();
    for (let q = Math.ceil(lo / labelStep) * labelStep; q <= hi; q += labelStep) {
      const y = Math.round(yOf(q)) + 0.5;
      if (Math.abs(y - yOf(price)) < 14) continue;
      ctx.globalAlpha = 0.35; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(xR, y); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillStyle = p.muted; ctx.fillText(fmtPrice(q), W - 6, y);
    }
  }

  /**
   * The two mountains: from the price outward, everything that would be liquidated if price got that far (shorts above, longs below), as
   * a filled shape brightening away from the axis and a glowing edge.
   */
  #paintMountains(ctx: CanvasRenderingContext2D, p: Palette, prof: LiqProfile, step: number, price: number, yOf: (pr: number) => number, xR: number, plotW: number, mid: number): void {
    const maxCum = Math.max(prof.maxCum, 1), xOf = (cum: number): number => xR - cum / maxCum * plotW * 0.94;
    for (const side of ['short', 'long'] as const) {
      const color = side === 'short' ? p.candleUp : p.candleDown, cum = side === 'short' ? prof.cumShort : prof.cumLong;
      const points: [number, number][] = [[xR, mid]];
      const n = cum.length;
      if (side === 'short') {
        for (let r = 0; r < n; r++) { const top = (prof.row0 + r + 1) * step; if (top > price && cum[r]! >= 0) points.push([xOf(cum[r]!), yOf(top)]); }
      } else {
        for (let r = n - 1; r >= 0; r--) { const bottom = (prof.row0 + r) * step; if (bottom < price && cum[r]! >= 0) points.push([xOf(cum[r]!), yOf(bottom)]); }
      }
      if (points.length < 2) continue;
      const last = points[points.length - 1]!;
      ctx.save();
      const fill = ctx.createLinearGradient(xR, 0, xR - plotW, 0);
      fill.addColorStop(0, rgba(color, 0.03)); fill.addColorStop(0.55, rgba(color, p.dark ? 0.16 : 0.12)); fill.addColorStop(1, rgba(color, p.dark ? 0.34 : 0.26));
      ctx.beginPath(); ctx.moveTo(xR, mid);
      for (const [x, y] of points) ctx.lineTo(x, y);
      ctx.lineTo(xR, last[1]); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      ctx.beginPath(); ctx.moveTo(points[0]![0], points[0]![1]);
      for (const [x, y] of points) ctx.lineTo(x, y);
      ctx.strokeStyle = rgba(color, 0.95); ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
      ctx.shadowColor = rgba(color, p.dark ? 0.75 : 0.45); ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * The milestones: at round distances from the price, a faint line and what would be liquidated getting there, shorts above and longs
   * below, on the left where the mountains reach. Returns the boxes it took, for the level labels to keep clear of.
   */
  #paintMilestones(ctx: CanvasRenderingContext2D, p: Palette, s: LiqStanding, price: number, yOf: (pr: number) => number, plotW: number): { y0: number; y1: number; x1: number }[] {
    const placed: { y0: number; y1: number; x1: number }[] = [], used: number[] = [];
    ctx.save(); ctx.font = `600 10.5px ${SANS}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const d of MILESTONES) {
      // Within an eighth of the range of the price there is rarely anything to say, and the labels would crowd the middle.
      if (d < this.#range / 8) continue;
      if (d > this.#range + 1e-9) break;
      const yUp = yOf(price * (1 + d)), yDown = yOf(price * (1 - d));
      if (Math.abs(yDown - yUp) / 2 < 22 || used.some(u => Math.abs(u - yUp) < 22)) continue;
      used.push(yUp);
      for (const side of ['short', 'long'] as const) {
        const y = side === 'short' ? yUp : yDown, color = side === 'short' ? p.candleUp : p.candleDown;
        const amount = side === 'short' ? standingBelow(s, 'short', price * (1 + d)) - standingBelow(s, 'short', price) : standingBelow(s, 'long', price) - standingBelow(s, 'long', price * (1 - d));
        ctx.globalAlpha = 0.5; ctx.strokeStyle = color; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(plotW, Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
        const tag = `${side === 'short' ? '+' : '−'}${pctText(d)}`, value = `$${usd(Math.max(0, amount))}`;
        ctx.font = `600 10.5px ${SANS}`; const wTag = ctx.measureText(tag).width;
        ctx.font = `700 11.5px ${SANS}`; const wVal = ctx.measureText(value).width;
        const w = wTag + wVal + 18, x = 6, top = y - 9;
        ctx.globalAlpha = p.dark ? 0.82 : 0.9; ctx.fillStyle = p.bg; this.#pill(ctx, x, top, w, 18, 9); ctx.fill();
        ctx.globalAlpha = 0.9; ctx.strokeStyle = rgba(color, 0.55); ctx.lineWidth = 1; this.#pill(ctx, x + 0.5, top + 0.5, w - 1, 17, 8.5); ctx.stroke();
        ctx.globalAlpha = 1; ctx.font = `600 10.5px ${SANS}`; ctx.fillStyle = p.muted; ctx.fillText(tag, x + 7, y);
        ctx.font = `700 11.5px ${SANS}`; ctx.fillStyle = color; ctx.fillText(value, x + 11 + wTag, y);
        placed.push({ y0: top, y1: top + 18, x1: x + w });
      }
    }
    ctx.restore();
    return placed;
  }

  /** The levels: a bar per row out of the price axis, the strongest brighter at their tips; the three largest each side named. */
  #paintBars(ctx: CanvasRenderingContext2D, p: Palette, prof: LiqProfile, step: number, levels: LiqLevels, yOf: (pr: number) => number, xR: number, plotW: number, H: number, placed: { y0: number; y1: number; x1: number }[]): void {
    const maxLevel = Math.max(prof.maxLevel, 1), reach = plotW * 0.6;
    const lenOf = (v: number): number => Math.max(1.5, Math.pow(v / maxLevel, 0.75) * reach);
    const grads = {
      long: this.#barGradient(ctx, p.candleDown, xR, reach), short: this.#barGradient(ctx, p.candleUp, xR, reach),
    };
    const best: Record<'long' | 'short', { r: number; v: number }[]> = { long: [], short: [] };
    ctx.save();
    for (let r = 0; r < prof.long.length; r++) {
      const a = (prof.row0 + r) * step, y0 = yOf(a + step), y1 = yOf(a);
      if (y1 < 0 || y0 > H) continue;
      const h = Math.max(1, y1 - y0 - 1);
      for (const side of ['long', 'short'] as const) {
        const v = side === 'long' ? prof.long[r]! : prof.short[r]!;
        if (v <= 0) continue;
        const len = lenOf(v);
        ctx.fillStyle = grads[side]; ctx.globalAlpha = 1;
        this.#pill(ctx, xR - len, y0, len, h, Math.min(2, h / 2)); ctx.fill();
        best[side].push({ r, v });
      }
    }
    // The largest levels, named beside their bars' tips (and marked when one position holds at least half of the level).
    ctx.textBaseline = 'middle';
    for (const side of ['long', 'short'] as const) {
      const color = side === 'long' ? p.candleDown : p.candleUp;
      const top3 = best[side].sort((a, b) => b.v - a.v).slice(0, 3).filter(b => b.v >= maxLevel * 0.2);
      for (const { r, v } of top3) {
        const a = (prof.row0 + r) * step, y = (yOf(a) + yOf(a + step)) / 2, len = lenOf(v);
        const one = binsIn(levels, side, a, a + step).top >= v * 0.5;
        const text = `${one ? '◆ ' : ''}$${usd(v)}`;
        ctx.font = `700 11.5px ${SANS}`;
        const w = ctx.measureText(text).width + 14, x = Math.max(4, xR - len - w - 6), top = y - 10;
        if (placed.some(b => top < b.y1 && top + 20 > b.y0 && x < b.x1 + 4)) continue;
        ctx.shadowColor = rgba(color, p.dark ? 0.6 : 0.35); ctx.shadowBlur = 10;
        ctx.fillStyle = p.panel; ctx.globalAlpha = 0.95; this.#pill(ctx, x, top, w, 20, 10); ctx.fill();
        ctx.shadowBlur = 0; ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = 1.2; this.#pill(ctx, x + 0.5, top + 0.5, w - 1, 19, 9.5); ctx.stroke();
        ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.fillText(text, x + 7, y + 0.5);
        placed.push({ y0: top, y1: top + 20, x1: x + w });
      }
    }
    ctx.restore();
  }

  #barGradient(ctx: CanvasRenderingContext2D, color: string, xR: number, reach: number): CanvasGradient {
    const g = ctx.createLinearGradient(xR, 0, xR - reach, 0);
    g.addColorStop(0, rgba(color, 0.55)); g.addColorStop(0.6, rgba(color, 0.85)); g.addColorStop(1, rgba(color, 1));
    return g;
  }

  /** The price: a line across, its tag on the axis, and the pulse that says it is live. */
  #paintPrice(ctx: CanvasRenderingContext2D, p: Palette, price: number, mid: number, xR: number, W: number): void {
    ctx.save();
    ctx.strokeStyle = rgba(p.text, 0.65); ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(0, Math.round(mid) + 0.5); ctx.lineTo(xR, Math.round(mid) + 0.5); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = p.text; this.#pill(ctx, xR + 3, mid - 10, W - xR - 6, 20, 4); ctx.fill();
    ctx.fillStyle = p.bg; ctx.font = `700 10.5px ui-monospace, SFMono-Regular, Menlo, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(fmtPrice(price), xR + (W - xR) / 2, mid + 0.5);
    ctx.restore();
    this.#pulse.style.transform = `translate(${xR - 2}px, ${mid}px)`;
  }

  /** What a finger reads at its price: the way there, the level itself, and the same distance the other way. */
  #paintProbe(ctx: CanvasRenderingContext2D, p: Palette, s: LiqStanding, levels: LiqLevels, prof: LiqProfile, step: number, price: number, yOf: (pr: number) => number, xR: number, W: number, H: number): void {
    const at = this.#probe!, y = yOf(at);
    if (y < 0 || y > H) return;
    const side = at >= price ? 'short' : 'long', color = side === 'short' ? p.candleUp : p.candleDown, d = Math.abs(at - price);
    const way = side === 'short' ? standingBelow(s, 'short', at) - standingBelow(s, 'short', price) : standingBelow(s, 'long', price) - standingBelow(s, 'long', at);
    const other = side === 'short' ? standingBelow(s, 'long', price) - standingBelow(s, 'long', price - d) : standingBelow(s, 'short', price + d) - standingBelow(s, 'short', price);
    const r = Math.floor(at / step) - prof.row0, a = (prof.row0 + r) * step;
    const level = r >= 0 && r < prof.long.length ? (side === 'long' ? prof.long[r]! : prof.short[r]!) : 0;
    const { positions, top } = binsIn(levels, side, a, a + step);
    ctx.save();
    ctx.strokeStyle = p.ui; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(xR, Math.round(y) + 0.5); ctx.stroke();
    ctx.fillStyle = p.ui; this.#pill(ctx, xR + 3, y - 10, W - xR - 6, 20, 4); ctx.fill();
    ctx.fillStyle = p.bg; ctx.font = `700 10.5px ui-monospace, SFMono-Regular, Menlo, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(fmtPrice(at), xR + (W - xR) / 2, y + 0.5);
    ctx.restore();
    const lines: InfoLine[] = [
      { text: side === 'long' ? t('Long liquidations') : t('Short liquidations'), color: side === 'long' ? 'sell' : 'buy', bold: true },
      { label: t('Distance'), text: distanceText(at, price) },
      { label: t('If price gets here'), text: `$${usd(Math.max(0, way))}`, bold: true },
      { label: t('At this level'), text: `$${usd(level)}` },
    ];
    if (positions > 0) lines.push({ label: t('Positions'), text: String(positions) });
    if (top > 0 && level > 0) lines.push({ label: t('Largest position'), text: `$${usd(top)}` });
    lines.push({ label: t('Same distance, other side'), text: `$${usd(Math.max(0, other))}`, color: side === 'long' ? 'buy' : 'sell' });
    // The box on the side away from the finger's line, so the line and its bars stay in sight.
    paintInfoBox(ctx, lines, 8, y, { x0: 0, y0: 0, x1: xR, y1: H }, p, { gap: 0, placement: y < H / 2 ? 'down' : 'up', edge: color });
  }

  #pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), Math.max(0, Math.min(r, w / 2, h / 2)));
    else ctx.rect(x, y, w, h);
  }
}
