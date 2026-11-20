import type { Hub } from '../hub.ts';
import type { Store } from '../store.ts';
import { PALETTES, rgb, type Palette, paletteOf } from '../theme.ts';
import { t } from '../i18n.ts';
import { helpButton } from '../help.ts';
import { el } from '../dom.ts';
import { replaying } from '../replay/clock.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import { currentCoin } from '../coin.ts';
import { niceStep } from '../view.ts';
import { measureInfoBox, paintInfoBox, type InfoLine } from '../infobox.ts';
import { ratioText } from '../mirror.ts';
import { binsIn, dollarPriceOf, liqProfile, standingBelow, TAKE_DASH, type LiqLevels, type LiqProfile, type LiqSet, type LiqStanding } from '../liq-levels.ts';
import { curveOf, groupName, groupTitle, heldBack, kindName, kindTitle, liveAsk, liveSplit, liveView, narrowView, plusOn, viewKey, type LiqPair, type LiqView } from '../liq-view.ts';
import { liqNote, liqWhy, narrowNote, ordersAbsent, sideTitle, splitName, subNames } from '../liq-words.ts';
import { ladderSplitFits, placeProbeBoxes, probeDetail, splitScales, type BoxSize } from '../liq-split.ts';
import { PROBE_LEAST, probeBoxLines, probeWrap, type ProbeFacts } from '../liq-box.ts';
import { toggleLevels } from '../levels-control.ts';
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
/** A box a label keeps clear of: its top, its bottom and its right end (each starts at the left of its ladder or half). */
type Placed = { y0: number; y1: number; x1: number };

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
  /** What the two totals are: longs and shorts, or with take profits alone, the take profits of shorts (buys below) and of longs (sells above). */
  #longLabel = el('small', { textContent: t('Longs') });
  #shortLabel = el('small', { textContent: t('Shorts') });
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
  /** The title, which says what is shown and opens the menu that chooses it (`liq-menu.ts`), and the line beside it (whose, where). */
  #title = el('button', { type: 'button', class: 'liq-title' });
  #sub = el('span', { class: 'liq-sub' });
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
    // The title opens the levels control: a bottom sheet on a phone, a popover on a wider screen.
    this.#title.setAttribute('aria-haspopup', 'dialog'); this.#title.setAttribute('aria-expanded', 'false');
    this.#title.onclick = () => { toggleLevels(this.#title, this.store); };
    const head = el('div', { class: 'pane-head liq-head' }, this.#title, this.#sub, helpButton('liqLevels'));
    this.#syncHead();
    this.#summary = el('div', { class: 'liq-sum' },
      el('div', { class: 'liq-side long' }, this.#longLabel, this.#longUsd),
      el('div', { class: 'liq-side short' }, this.#shortLabel, this.#shortUsd),
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

  setPalette(name: string): void { this.#palette = paletteOf(name); this.invalidate(); }

  /** The price the ladder was last drawn around (its axis's centre), or null while it draws nothing. */
  get framePrice(): number | null { return this.#frame?.price ?? null; }

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

  /** The title says what is shown (a lock while a Plus choice is held back), the line beside it whose levels and where. */
  #syncHead(view: LiqView = liveView(this.store.state.liqLevels), pair: LiqPair | null = null): void {
    const s = this.store.state.liqLevels, title = pair ? splitName(pair.split) : kindTitle(curveOf(view));
    if (this.#title.textContent !== title) this.#title.textContent = title;
    this.#title.classList.toggle('locked', heldBack(s, plusOn()));
    // Under a split, what both halves share: whose levels (liquidations beside stops of the profitable traders), or what both add up.
    const shared = pair ? (pair.split === 'kinds' ? (pair.left.group !== 'all' ? groupTitle(pair.left.group) : '') : kindTitle(curveOf(pair.left))) : view.group !== 'all' ? groupTitle(view.group) : '';
    const sub = shared ? `${shared} · ${t('BTC · Hyperliquid')}` : t('BTC · Hyperliquid');
    if (this.#sub.textContent !== sub) this.#sub.textContent = sub;
  }

  /**
   * The levels kept fresh for the setting as it is now, the source turned to it: each second (`#tick`) and before every frame, so a frame drawn
   * for a change of the setting reads the new choice's levels, not those the last tick left (Sol, review 2026-11-19, round 3: the profitable
   * traders' caption stood over everyone's levels until the next tick).
   */
  #ensure(): { view: LiqView; right: LiqView | null } {
    type Ask = { view: LiqView; right: LiqView | null };
    const key = (a: Ask): string => `${viewKey(a.view)}|${a.right ? viewKey(a.right) : ''}`;
    const ask = (a: Ask): Ask => { this.hub.liqLevels.ensure(currentCoin(), () => this.invalidate(), a.view, a.right); return a; };
    // Asking for a Plus file reads the membership again and can find it let go in another tab: the source is then turned to the views in force
    // now (the one series and a split's right column, the map's same ask: `liveAsk`), and the frame draws those throughout (Sol, review
    // 2026-11-19, round 4).
    const asked = ask(liveAsk(this.store.state.liqLevels)), now = liveAsk(this.store.state.liqLevels);
    return key(now) === key(asked) ? asked : ask(now);
  }

  #tick(): void {
    const src = this.hub.liqLevels;
    this.#ensure();
    // The chart's price takes levels away from every set held, a split's right half's too, whether or not the left half has levels (Sol,
    // review 2026-11-19, round 2): never for another coin's price.
    if (!replaying() && src.state !== 'off' && src.state !== 'other-coin') src.observe(dollarPriceOf(this.store.state));
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
    const asked = this.#ensure(), view = asked.view;
    const src = this.hub.liqLevels, state = this.store.state;
    // A split (the right column asked for this frame): two halves where the tab has room for them, else what the split falls back to
    // (`narrowView`: liquidations and stops added up, or everyone's levels), said under the summary.
    const pair = asked.right ? liveSplit(state.liqLevels) : null, halves = !!pair && ladderSplitFits(W - AXIS);
    const fallback = pair && !halves ? narrowView(pair) : null;
    const one: LiqSet = fallback && pair?.split === 'kinds' ? src.setOf(fallback) : src, levels = one.levels;
    this.#syncHead(view, pair);
    const why = replaying() ? t('Liquidation levels show the live market only.') : src.state === 'other-coin' ? t('Liquidation levels are for BTC only for now.')
      : !levels || one.state !== 'ready' ? liqWhy(one, one.asOfs().liq) || t('Liquidation levels are loading.') : '';
    const s = why ? null : one.standing();
    // A split in halves stands half by half: one half loading or missing never hides the other (Sol, review 2026-11-19).
    const right = pair && halves ? src.right : null, rWhy = right ? (replaying() ? t('Liquidation levels show the live market only.') : !right.levels || right.state !== 'ready' ? liqWhy(right, right.asOfs().liq) || t('Liquidation levels are loading.') : '') : '';
    const rs = right && !rWhy ? right.standing() : null;
    if ((!s || !levels) && !rs) { this.#empty(why || t('Liquidation levels are loading.')); return; }
    // The price from the chart, else from the levels: the left set's, or the right half's where only it stands.
    const live = dollarPriceOf(state), price = live > 0 ? live : s && levels ? src.lastPriceOf(levels) : rs && right?.levels ? src.lastPriceOf(right.levels) : NaN;
    if (!(price > 0)) { this.#empty(t('Liquidation levels are loading.')); return; }
    this.#summary.hidden = false; this.#ranges.hidden = false; this.#pulse.hidden = false;

    const span = price * this.#range, mid = H / 2, half = H / 2 - PAD, xR = W - AXIS, plotW = xR;
    const yOf = (pr: number): number => mid - (pr - price) / span * half;
    const lo = price - span, hi = price + span, step = niceStep(2 * span, Math.max(24, (H - 2 * PAD) / ROW_PX));
    const prof = s ? liqProfile(s, step, lo, hi, price) : null;
    // The take profits, where shown: dashed bars on the same scale, never added to the levels (they sit on the other side of the price).
    const ts = s && src.takesState === 'ready' ? src.takesStanding() : null, tprof = ts ? liqProfile(ts, step, lo, hi, price) : null;
    this.#frame = { price, span };

    // The foot's note: under a split of liquidations beside stops both are drawn (in halves, or added up), so it says both; a fallback says so.
    const both = pair?.split === 'kinds' ? narrowView(pair) : null;
    const note = { src: both ? { ...src.setOf(both), takesState: src.takesState } : src, view: both ?? view, first: fallback ? narrowNote(pair!.split === 'kinds' ? kindName('both') : groupName('all')) : '' };
    if (pair && halves && right) {
      // The summary weighs the one series (the left half) where it stands; else it goes, and the foot says why beside the right half's note.
      if (s && levels) this.#paintSummary(s, levels, price, lo, hi, view, { ...note, last: right.ordersAbsent() && !note.src.ordersAbsent() ? ordersAbsent() : '' });
      else {
        this.#summary.hidden = true;
        const late = src.candlesLate() ? ` · ${t('Hyperliquid\'s candles could not be read, so a level price has passed may still show.')}` : '';
        this.#foot.textContent = `${why} · ${liqNote({ ...right, takesState: 'off' }, right.view, right.levels!.asOf)}${late}`;
      }
      this.#paintGrid(ctx, p, price, lo, hi, span, yOf, xR, W);
      this.#paintHalves(ctx, p, pair, s && levels && prof ? { s, levels, prof, tprof, why: '' } : { why }, right, rs ? { s: rs, levels: right.levels!, why: '' } : { why: rWhy }, step, price, lo, hi, yOf, xR, mid, W, H);
      return;
    }
    if (!s || !levels || !prof) { this.#empty(why || t('Liquidation levels are loading.')); return; }
    this.#paintSummary(s, levels, price, lo, hi, view, note);
    this.#paintGrid(ctx, p, price, lo, hi, span, yOf, xR, W);
    this.#paintMountains(ctx, p, prof, step, price, yOf, xR, plotW, mid);
    const placed = this.#paintMilestones(ctx, p, s, price, yOf, plotW);
    this.#paintBars(ctx, p, prof, step, levels, yOf, xR, plotW, H, placed, tprof);
    this.#paintPrice(ctx, p, price, mid, xR, W);
    if (this.#probe !== null) {
      // The box on the side away from the finger's line, so the line and its bars stay in sight.
      const read = this.#probeReading(ctx, p, s, levels, prof, step, price, yOf, xR, W, H, one);
      if (read) paintInfoBox(ctx, probeBoxLines(read.facts), 8, read.y, { x0: 0, y0: 0, x1: xR, y1: H }, p, { gap: 0, placement: read.y < H / 2 ? 'down' : 'up', edge: read.color });
    }
  }

  /**
   * A split as two halves of the ladder, side by side (`ladderSplitFits`): the left set (liquidations, or everyone's levels) left of the
   * divider, the right set (stops, or the profitable traders') right of it, each grown out of its own right edge as the ladder grows out of the
   * price axis, with its own mountains, milestones and largest levels, on one scale (liquidations beside stops, so a bar compares across) or
   * one each (everyone's are many times the profitable traders'), and captioned at its top. The take profits go with the left half. A half
   * with nothing to draw says why. A finger reads both halves at its price. Its milestones and largest levels keep clear of its caption and of
   * the lines under it that say its orders are missing: one that would lie under them is left out, as a range's own milestone at the top edge
   * is (2026-11-19).
   */
  #paintHalves(ctx: CanvasRenderingContext2D, p: Palette, pair: LiqPair, leftHas: { s?: LiqStanding; levels?: LiqLevels; prof?: LiqProfile; tprof?: LiqProfile | null; why: string },
    right: LiqSet, rightHas: { s?: LiqStanding; levels?: LiqLevels; why: string }, step: number, price: number,
    lo: number, hi: number, yOf: (pr: number) => number, xR: number, mid: number, W: number, H: number): void {
    const prof = leftHas.prof ?? null, tprof = leftHas.tprof ?? null, rprof = rightHas.s ? liqProfile(rightHas.s, step, lo, hi, price) : null, gap = 6, cut = Math.floor((xR - gap) / 2);
    const halves = [{ x0: 0, x1: cut }, { x0: cut + gap, x1: xR }] as const;
    const [left, other] = splitScales({ maxLevel: Math.max(prof?.maxLevel ?? 0, tprof?.maxLevel ?? 0), maxCum: prof?.maxCum ?? 0 }, { maxLevel: rprof?.maxLevel ?? 0, maxCum: rprof?.maxCum ?? 0 }, pair.split === 'kinds');
    /** Why a half has nothing, centred in it. */
    const reason = (h: { x0: number; x1: number }, why: string): void => {
      const hw = h.x1 - h.x0;
      ctx.save(); ctx.fillStyle = p.muted; ctx.font = `12px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const lines: string[] = []; let line = '';
      for (const word of why.split(' ')) { const next = line ? `${line} ${word}` : word; if (line && ctx.measureText(next).width > hw - 16) { lines.push(line); line = word; } else line = next; }
      if (line) lines.push(line);
      lines.forEach((text, i) => ctx.fillText(text, h.x0 + hw / 2, H * 0.25 + i * 16));
      ctx.restore();
    };
    // Each half's caption and, where its orders are missing, the lines under it that say so, laid out first: the boxes its milestones and
    // largest levels keep clear of.
    ctx.save();
    const heads = subNames(pair).map((name, i) => {
      const h = halves[i as 0 | 1], set = i === 0 ? this.hub.liqLevels : right, lines: string[] = [];
      ctx.font = `600 11px ${SANS}`;
      const w = Math.min(h.x1 - h.x0 - 8, ctx.measureText(name).width + 12), keep: Placed[] = [{ y0: 4, y1: 22, x1: h.x0 + 4 + w }];
      if (set.ordersAbsent() && (i === 0 ? leftHas.s : rightHas.s)) {
        ctx.font = `10.5px ${SANS}`;
        const room = h.x1 - h.x0 - 12; let line = '';
        for (const word of ordersAbsent().split(' ')) { const next = line ? `${line} ${word}` : word; if (line && ctx.measureText(next).width > room) { lines.push(line); line = word; } else line = next; }
        if (line) lines.push(line);
        lines.splice(3);
        keep.push({ y0: 22, y1: 32 + (lines.length - 1) * 13 + 7, x1: h.x0 + 6 + Math.max(...lines.map(l => ctx.measureText(l).width)) });
      }
      return { name, w, lines, keep };
    });
    ctx.restore();
    // Left half: the left set (and the take profits), or why it has none.
    const a = halves[0], aw = a.x1 - a.x0;
    if (leftHas.s && leftHas.levels && prof) {
      this.#paintMountains(ctx, p, prof, step, price, yOf, a.x1, aw, mid, left.maxCum);
      const placedA = this.#paintMilestones(ctx, p, leftHas.s, price, yOf, a.x1, a.x0, heads[0]!.keep);
      this.#paintBars(ctx, p, prof, step, leftHas.levels, yOf, a.x1, aw, H, placedA, tprof, left.maxLevel, a.x0);
    } else reason(a, leftHas.why || t('Liquidation levels are loading.'));
    // Right half: the right set, or why it has none.
    const b = halves[1], bw = b.x1 - b.x0;
    if (rightHas.s && rightHas.levels && rprof) {
      this.#paintMountains(ctx, p, rprof, step, price, yOf, b.x1, bw, mid, other.maxCum);
      const placedB = this.#paintMilestones(ctx, p, rightHas.s, price, yOf, b.x1, b.x0, heads[1]!.keep);
      this.#paintBars(ctx, p, rprof, step, rightHas.levels, yOf, b.x1, bw, H, placedB, null, other.maxLevel, b.x0);
    } else reason(b, rightHas.why || t('Liquidation levels are loading.'));
    // The divider, and each half's caption at its top, with the lines under it.
    ctx.save();
    ctx.strokeStyle = p.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cut + gap / 2 + 0.5, 0); ctx.lineTo(cut + gap / 2 + 0.5, H); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    heads.forEach(({ name, w, lines }, i) => {
      const h = halves[i as 0 | 1];
      ctx.font = `600 11px ${SANS}`;
      ctx.globalAlpha = 0.92; ctx.fillStyle = p.panel; this.#pill(ctx, h.x0 + 4, 4, w, 18, 4); ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = p.line; this.#pill(ctx, h.x0 + 4.5, 4.5, w - 1, 17, 4); ctx.stroke();
      ctx.fillStyle = p.text; ctx.fillText(name, h.x0 + 10, 13.5, w - 12);
      ctx.font = `10.5px ${SANS}`; ctx.fillStyle = p.muted;
      lines.forEach((text, n) => ctx.fillText(text, h.x0 + 6, 32 + n * 13));
    });
    ctx.restore();
    this.#paintPrice(ctx, p, price, mid, xR, W);
    if (this.#probe !== null) {
      // The line and the price's tag once, by the first half that reads (the right one where the left has nothing), and a box for each half,
      // measured and placed together (`placeProbeBoxes`): on the ladder, never one over the other. Each names its group where the halves are
      // two groups (both say "Liq + stops" there), and both say less where the ladder is too short for the two whole (`probeDetail`: a
      // 320 x 568 phone's 253 px ladder held two 150 to 170 px boxes one over the other).
      const leftReads = !!(leftHas.s && leftHas.levels && prof);
      const reads = [leftHas.s && leftHas.levels && prof ? this.#probeReading(ctx, p, leftHas.s, leftHas.levels, prof, step, price, yOf, xR, W, H, this.hub.liqLevels, true) : null,
        rightHas.s && rightHas.levels && rprof ? this.#probeReading(ctx, p, rightHas.s, rightHas.levels, rprof, step, price, yOf, xR, W, H, right, !leftReads) : null] as const;
      const y = reads[0]?.y ?? reads[1]?.y;
      if (y !== undefined) {
        const names = pair.split === 'groups' ? [groupName(pair.left.group), groupName(pair.right.group)] as const : [null, null] as const, wrapAt = probeWrap(xR);
        const linesOf = (i: 0 | 1, detail: number): InfoLine[] | null => { const read = reads[i]; return read ? probeBoxLines(read.facts, { detail, whose: pair.split === 'groups' ? names[i] : null }) : null; };
        const sizeOf = (lines: InfoLine[] | null): BoxSize | null => lines ? measureInfoBox(ctx, lines, wrapAt) : null, measured: [BoxSize | null, BoxSize | null][] = [];
        const sizesAt = (d: number): [BoxSize | null, BoxSize | null] => measured[d] ??= [sizeOf(linesOf(0, d)), sizeOf(linesOf(1, d))];
        const detail = probeDetail(sizesAt, xR, H, PROBE_LEAST);
        const lines = [linesOf(0, detail), linesOf(1, detail)] as const, at = placeProbeBoxes(sizesAt(detail), y, xR, H);
        reads.forEach((read, i) => { const to = at[i], shown = lines[i]; if (read && to && shown) paintInfoBox(ctx, shown, to.x, to.y, { x0: 0, y0: 0, x1: xR, y1: H }, p, { at: to, edge: read.color, wrapAt }); });
      }
    }
  }

  /** The summary: the longs that would go below and the shorts above within the range, weighed against each other. */
  #paintSummary(s: LiqStanding, levels: LiqLevels, price: number, lo: number, hi: number, view: LiqView, note?: { src: Parameters<typeof liqNote>[0]; view: LiqView; first: string; last?: string }): void {
    const longs = Math.max(0, standingBelow(s, 'long', price) - standingBelow(s, 'long', lo));
    const shorts = Math.max(0, standingBelow(s, 'short', hi) - standingBelow(s, 'short', price));
    this.#longUsd.textContent = `$${usd(longs)}`; this.#shortUsd.textContent = `$${usd(shorts)}`;
    const total = longs + shorts, share = total > 0 ? longs / total : 0.5;
    this.#balanceLong.style.flexGrow = String(share); this.#balanceShort.style.flexGrow = String(1 - share);
    this.#within.textContent = t('Within ±{pct} of {price}', { pct: pctText(this.#range), price: fmtPrice(price) });
    // Take profits alone: their own names, the order sides' colours (the buys below in the rising colour), bids against asks.
    const alone = levels.kind === 'takes', below = alone ? sideTitle('takes', 'long') : t('Longs'), above = alone ? sideTitle('takes', 'short') : t('Shorts');
    if (this.#longLabel.textContent !== below) this.#longLabel.textContent = below;
    if (this.#shortLabel.textContent !== above) this.#shortLabel.textContent = above;
    this.#summary.classList.toggle('takes', alone);
    const big = Math.max(longs, shorts), small = Math.min(longs, shorts);
    this.#ratio.textContent = big > 0 ? `${longs >= shorts ? alone ? t('bids') : t('Longs') : alone ? t('asks') : t('Shorts')} ${ratioText(small > 0 ? big / small : Infinity)}` : '';
    this.#ratio.className = `liq-ratio ${longs >= shorts ? 'long' : 'short'}`;
    const src = this.hub.liqLevels, late = src.candlesLate() ? ` · ${t('Hyperliquid\'s candles could not be read, so a level price has passed may still show.')}` : '';
    const said = note ? liqNote(note.src, note.view, levels.asOf) : liqNote(src, view, levels.asOf);
    this.#foot.textContent = `${note?.first ? `${note.first} · ` : ''}${said}${note?.last ? ` · ${note.last}` : ''}${late}`;
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
  #paintMountains(ctx: CanvasRenderingContext2D, p: Palette, prof: LiqProfile, step: number, price: number, yOf: (pr: number) => number, xR: number, plotW: number, mid: number, scale?: number): void {
    const maxCum = Math.max(scale ?? prof.maxCum, 1), xOf = (cum: number): number => xR - cum / maxCum * plotW * 0.94, alone = this.#takesAlone();
    for (const side of ['short', 'long'] as const) {
      const color = this.#color(p, side), cum = side === 'short' ? prof.cumShort : prof.cumLong;
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
      // Take profits on alone: their edge alone, dashed, never filled (the map's column draws them so too).
      if (!alone) { ctx.fillStyle = fill; ctx.fill(); }
      if (alone) ctx.setLineDash(TAKE_DASH as number[]);
      ctx.beginPath(); ctx.moveTo(points[0]![0], points[0]![1]);
      for (const [x, y] of points) ctx.lineTo(x, y);
      ctx.strokeStyle = rgba(color, 0.95); ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
      ctx.shadowColor = rgba(color, p.dark ? 0.75 : 0.45); ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Whether the levels are take profits on alone (drawn as take profits, the buys below the price in the rising colour). */
  #takesAlone(): boolean { return this.hub.liqLevels.levels?.kind === 'takes'; }
  /** A side's colour: the longs' (below the price) the falling colour, the shorts' the rising one; take profits on alone the other way round. */
  #color(p: Palette, side: 'long' | 'short'): string { return (side === 'long') !== this.#takesAlone() ? p.candleDown : p.candleUp; }

  /**
   * The milestones: at round distances from the price, a faint line and what would be liquidated getting there, shorts above and longs
   * below, on the left where the mountains reach. Returns the boxes it took, for the level labels to keep clear of, after `keepOut`'s (a
   * split half's caption and the lines under it): a milestone that would lie under one of those is left out.
   */
  #paintMilestones(ctx: CanvasRenderingContext2D, p: Palette, s: LiqStanding, price: number, yOf: (pr: number) => number, plotW: number, x0 = 0, keepOut: Placed[] = []): Placed[] {
    const placed: Placed[] = [...keepOut], used: number[] = [];
    ctx.save(); ctx.font = `600 10.5px ${SANS}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const d of MILESTONES) {
      // Within an eighth of the range of the price there is rarely anything to say, and the labels would crowd the middle.
      if (d < this.#range / 8) continue;
      if (d > this.#range + 1e-9) break;
      const yUp = yOf(price * (1 + d)), yDown = yOf(price * (1 - d));
      if (Math.abs(yDown - yUp) / 2 < 22 || used.some(u => Math.abs(u - yUp) < 22)) continue;
      used.push(yUp);
      for (const side of ['short', 'long'] as const) {
        const y = side === 'short' ? yUp : yDown, color = this.#color(p, side);
        if (keepOut.some(b => y - 9 < b.y1 && y + 9 > b.y0 && x0 + 6 < b.x1 + 4)) continue;
        const amount = side === 'short' ? standingBelow(s, 'short', price * (1 + d)) - standingBelow(s, 'short', price) : standingBelow(s, 'long', price) - standingBelow(s, 'long', price * (1 - d));
        ctx.globalAlpha = 0.5; ctx.strokeStyle = color; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(plotW, Math.round(y) + 0.5); ctx.stroke(); ctx.setLineDash([]);
        const tag = `${side === 'short' ? '+' : '−'}${pctText(d)}`, value = `$${usd(Math.max(0, amount))}`;
        ctx.font = `600 10.5px ${SANS}`; const wTag = ctx.measureText(tag).width;
        ctx.font = `700 11.5px ${SANS}`; const wVal = ctx.measureText(value).width;
        const w = wTag + wVal + 18, x = x0 + 6, top = y - 9;
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
  #paintBars(ctx: CanvasRenderingContext2D, p: Palette, prof: LiqProfile, step: number, levels: LiqLevels, yOf: (pr: number) => number, xR: number, plotW: number, H: number, placed: { y0: number; y1: number; x1: number }[], takes: LiqProfile | null = null, scale?: number, x0 = 0): void {
    const maxLevel = Math.max(scale ?? Math.max(prof.maxLevel, takes?.maxLevel ?? 0), 1), reach = plotW * 0.6;
    const lenOf = (v: number): number => Math.max(1.5, Math.pow(v / maxLevel, 0.75) * reach);
    const grads = {
      long: this.#barGradient(ctx, this.#color(p, 'long'), xR, reach), short: this.#barGradient(ctx, this.#color(p, 'short'), xR, reach),
    };
    const best: Record<'long' | 'short', { r: number; v: number }[]> = { long: [], short: [] }, alone = this.#takesAlone();
    ctx.save();
    for (let r = 0; r < prof.long.length; r++) {
      const a = (prof.row0 + r) * step, y0 = yOf(a + step), y1 = yOf(a);
      if (y1 < 0 || y0 > H) continue;
      const h = Math.max(1, y1 - y0 - 1);
      for (const side of ['long', 'short'] as const) {
        const v = side === 'long' ? prof.long[r]! : prof.short[r]!;
        if (v <= 0) continue;
        const len = lenOf(v);
        if (alone) {
          // Take profits on alone: dashed, as beside the others.
          ctx.globalAlpha = 0.95; ctx.strokeStyle = this.#color(p, side); ctx.lineWidth = h; ctx.setLineDash(TAKE_DASH as number[]); ctx.lineDashOffset = 0;
          ctx.beginPath(); ctx.moveTo(xR, y0 + h / 2); ctx.lineTo(xR - Math.max(3, len), y0 + h / 2); ctx.stroke(); ctx.setLineDash([]);
        } else {
          ctx.fillStyle = grads[side]; ctx.globalAlpha = 1;
          this.#pill(ctx, xR - len, y0, len, h, Math.min(2, h / 2)); ctx.fill();
        }
        best[side].push({ r, v });
      }
    }
    // The take profits: dashed bars on the same scale (`TAKE_DASH`, the map's and the Depth pane's look), the dashes on one pattern from the
    // price axis, by what the orders do (those of shorts are buys, the rising colour; those of longs sells).
    if (takes) {
      ctx.globalAlpha = 0.95; ctx.setLineDash(TAKE_DASH as number[]); ctx.lineDashOffset = 0;
      for (let r = 0; r < takes.long.length; r++) {
        const a = (takes.row0 + r) * step, y0 = yOf(a + step), y1 = yOf(a);
        if (y1 < 0 || y0 > H) continue;
        const h = Math.max(1, y1 - y0 - 1);
        for (const [v, color] of [[takes.long[r]!, p.candleUp], [takes.short[r]!, p.candleDown]] as const) {
          if (!(v > 0)) continue;
          const len = Math.max(3, lenOf(v));
          ctx.strokeStyle = color; ctx.lineWidth = h; ctx.beginPath(); ctx.moveTo(xR, y0 + h / 2); ctx.lineTo(xR - len, y0 + h / 2); ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }
    // The largest levels, named beside their bars' tips (and marked when one position holds at least half of the level).
    ctx.textBaseline = 'middle';
    for (const side of ['long', 'short'] as const) {
      const color = this.#color(p, side);
      const top3 = best[side].sort((a, b) => b.v - a.v).slice(0, 3).filter(b => b.v >= maxLevel * 0.2);
      for (const { r, v } of top3) {
        const a = (prof.row0 + r) * step, y = (yOf(a) + yOf(a + step)) / 2, len = lenOf(v);
        const one = binsIn(levels, side, a, a + step).top >= v * 0.5;
        const text = `${one ? '◆ ' : ''}$${usd(v)}`;
        ctx.font = `700 11.5px ${SANS}`;
        const w = ctx.measureText(text).width + 14, x = Math.max(x0 + 4, xR - len - w - 6), top = y - 10;
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

  /**
   * What a finger reads at its price in one set: the way there, the level itself, and the same distance the other way, as the figures of its
   * box (`probeBoxLines`) and its edge colour at the finger's height (null off the ladder). Draws the line across and the price's tag on the
   * axis where `decorate`.
   */
  #probeReading(ctx: CanvasRenderingContext2D, p: Palette, s: LiqStanding, levels: LiqLevels, prof: LiqProfile, step: number, price: number, yOf: (pr: number) => number, xR: number, W: number, H: number,
    set: Pick<LiqSet, 'partStandings'> = this.hub.liqLevels, decorate = true): { facts: ProbeFacts; color: string; y: number } | null {
    const at = this.#probe!, y = yOf(at);
    if (y < 0 || y > H) return null;
    const side = at >= price ? 'short' : 'long', color = this.#color(p, side), d = Math.abs(at - price);
    const way = side === 'short' ? standingBelow(s, 'short', at) - standingBelow(s, 'short', price) : standingBelow(s, 'long', price) - standingBelow(s, 'long', at);
    const other = side === 'short' ? standingBelow(s, 'long', price) - standingBelow(s, 'long', price - d) : standingBelow(s, 'short', price + d) - standingBelow(s, 'short', price);
    const r = Math.floor(at / step) - prof.row0, a = (prof.row0 + r) * step;
    const level = r >= 0 && r < prof.long.length ? (side === 'long' ? prof.long[r]! : prof.short[r]!) : 0;
    const { positions, top } = binsIn(levels, side, a, a + step);
    // The line across and the price's tag on the axis, once a frame (`decorate`: the first half of a split that reads draws them).
    if (decorate) {
      ctx.save();
      ctx.strokeStyle = p.ui; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(xR, Math.round(y) + 0.5); ctx.stroke();
      ctx.fillStyle = p.ui; this.#pill(ctx, xR + 3, y - 10, W - xR - 6, 20, 4); ctx.fill();
      ctx.fillStyle = p.bg; ctx.font = `700 10.5px ui-monospace, SFMono-Regular, Menlo, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtPrice(at), xR + (W - xR) / 2, y + 0.5);
      ctx.restore();
    }
    // What it says is `probeBoxLines`'s from these figures; Liq + stops gives each total with its two parts under it.
    const parts = levels.kind === 'both' ? set.partStandings() : null;
    return { facts: { kind: levels.kind, side, at, price, way, other, level, lo: a, hi: a + step, positions, top, parts }, color, y };
  }

  #pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), Math.max(0, Math.min(r, w / 2, h / 2)));
    else ctx.rect(x, y, w, h);
  }
}
