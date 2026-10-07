import { PALETTES, chromeFor, mixHex, rgb, type Chrome, type Palette } from '../theme.ts';
import { el } from '../dom.ts';
import { isPhone } from '../device.ts';
import { HoverCard } from '../hovercard.ts';
import { t } from '../i18n.ts';
import type { Store } from '../store.ts';
import type { Hub } from '../hub.ts';
import type { Print } from '../prints.ts';
import type { SizesAnswer } from '../../shared/footprint.ts';
import { GEOMETRY, askedWindows, buildStrip, coverageNote, flashBands, ledRow, percent, rankMinutes, rowAt, rowLines, sizeBands, stripHeight, weightDots, weightText, type Led, type StripData, type StripRow } from '../cvd/strip.ts';

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT = `9px ${SANS}`, FONT_BOLD = `600 9px ${SANS}`;
/** The amber of the Sound button when it is waiting to be unlocked: a row that is not fully recorded is marked with it (a ring, not a dot, so a sell colour that is close to it cannot be mistaken for it). */
const AMBER = '#e6a700';
/** How long the ring stays on a row's leading dot after a trade of its size, as on the Sound button. */
const FLASH_MS = 600;
/** How often the sizes are asked for again while they are known, and how long a failed question waits (an older server never answers it). */
const ASK_EVERY_MS = 5_000, RETRY_MS = 60_000;

const rgba = (hex: string, alpha: number): string => { const [r, g, b] = rgb(hex); return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`; };
const reducedMotion = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** What the strip last drew, for the checks that look at it without reading its pixels. */
export interface StripSnapshot { hidden: boolean; width: number; height: number; data: StripData | null; sizes: 'ready' | 'loading' | 'unavailable' | 'empty'; flashing: number[]; dots: number }

/**
 * The strip of dot rows at the top of the flow column: buys against sells over the last minutes (the flow book) and by trade size (the
 * footprint recorder's statistics, asked of the source once every few seconds). It is an element of its own above the column's canvas, so the
 * rows below it, their scrolling and their hit tests are the same with it or without it. The numbers and the words are `cvd/strip.ts`; this
 * class is the canvas, the pointer, the questions and the one blink: the leading dot of a size row lights for a moment when a trade of that size prints.
 */
export class CvdStrip {
  readonly root = el('div', { class: 'cvd-strip', hidden: true });
  #canvas = document.createElement('canvas');
  #ctx = this.#canvas.getContext('2d')!;
  #card = new HoverCard();
  #palette: Palette = PALETTES.light!;
  #chrome: Chrome = chromeFor(PALETTES.light!);
  #w = 0; #h = 0; #dpr = 1; #frame = 0; #dots = 0;
  /** The instruments the ALL VENUES row is made of (the column sets them whenever it builds its model). */
  #counted: string[] = []; #countedSet = new Set<string>(); #countedKey = '';
  #data: StripData | null = null;
  /** The last sizes answer and what it was asked for; whether a question is out, when the last one went, and whether it failed. */
  #sizes: { key: string; answer: SizesAnswer } | null = null;
  #asking = false; #askedAt = 0; #failed = false;
  #flash = new Map<number, number>(); #flashTimer = 0;
  #disposed = false;

  constructor(private store: Store, private hub: Hub) {
    this.#canvas.setAttribute('role', 'img');
    this.#canvas.setAttribute('aria-label', t('Taker flow and trade sizes, as rows of dots'));
    this.root.append(this.#canvas);
    new ResizeObserver(() => this.#resize()).observe(this.root);
    this.#canvas.addEventListener('pointermove', e => this.#point(e));
    this.#canvas.addEventListener('pointerleave', () => this.#card.hide());
  }

  setPalette(p: Palette): void { this.#palette = p; this.#chrome = chromeFor(p); this.#schedule(); }

  /** The instruments the ALL VENUES row counts: the strip counts the same ones, so the two agree. A different set is a different question. */
  setCounted(ids: readonly string[]): void {
    const key = ids.join(',');
    if (key === this.#countedKey) return;
    this.#counted = [...ids]; this.#countedSet = new Set(ids); this.#countedKey = key;
    this.refresh();
  }

  /** The column was switched on (or a phone turned into a tablet): show the strip now instead of at the next beat. */
  wake(): void { if (this.root.hidden) this.refresh(); }

  /** The numbers have moved on, or a setting, the filter or the venues changed: work the rows out again, ask for the sizes if they are due, and draw. */
  refresh(): void {
    const s = this.store.state, c = s.cvd;
    // A phone's flow pane is half the map's height and has no room for 130 px of dots above its rows: the strip is for the desktop arrangement (a tablet held sideways has it).
    this.root.hidden = !c.strip || isPhone();
    if (this.root.hidden) { this.#card.hide(); return; }
    const windows = askedWindows(rankMinutes(c)), key = this.#key(windows);
    this.#ask(windows, key);
    const known = this.#sizes?.key === key ? this.#sizes.answer : null;
    this.#data = buildStrip({ flow: this.hub.flow, counted: this.#counted, nowSec: Math.floor(Date.now() / 1000), settings: c, scope: s.scope, sizes: known, state: known ? 'ready' : this.#failed ? 'unavailable' : 'loading' });
    this.#h = stripHeight(this.#data.size.rows.length);
    this.#resize();
    this.#schedule();
  }

  #key(windows: readonly number[]): string { return `${this.#countedKey}|${windows.join(',')}`; }

  /** One question at a time: at once for a set not asked about yet, every few seconds for the same one, and slowly after a failure (a server that has no such route). */
  #ask(windows: number[], key: string): void {
    if (this.#asking || !this.#counted.length) return;
    const now = Date.now(), fresh = this.#sizes?.key === key;
    if (now - this.#askedAt < (this.#failed ? RETRY_MS : fresh ? ASK_EVERY_MS : 0)) return;
    this.#asking = true; this.#askedAt = now;
    this.hub.source.sizes([...this.#counted], windows).then(answer => { this.#sizes = { key, answer }; this.#failed = false; }, () => { this.#failed = true; })
      .finally(() => { this.#asking = false; if (!this.#disposed) this.refresh(); });
  }

  /** Trades that printed just now: the leading dot of the row they belong to lights for a moment. Nothing moves when the person asked for less motion or switched the blink off. */
  flash(prints: readonly Print[]): void {
    const c = this.store.state.cvd;
    if (!c.strip || !c.stripBlink || this.root.hidden || document.hidden || reducedMotion()) return;
    const rows = flashBands(sizeBands(c), this.#countedSet, prints), at = performance.now();
    if (!rows.length) return;
    for (const row of rows) this.#flash.set(row, at);
    this.#schedule();
    window.clearTimeout(this.#flashTimer);
    this.#flashTimer = window.setTimeout(() => this.#schedule(), FLASH_MS + 30);
  }

  get snapshot(): StripSnapshot {
    const now = performance.now();
    return { hidden: this.root.hidden, width: this.#w, height: this.#h, data: this.#data, sizes: this.#data?.size.state ?? 'loading', flashing: [...this.#flash].filter(([, at]) => now - at < FLASH_MS).map(([band]) => band), dots: this.#dots };
  }

  dispose(): void { this.#disposed = true; window.clearTimeout(this.#flashTimer); cancelAnimationFrame(this.#frame); this.#card.hide(); }

  // ---- canvas ---------------------------------------------------------------------------------------------------------------------

  #resize(): void {
    const width = Math.floor(this.#canvas.getBoundingClientRect().width), dpr = window.devicePixelRatio || 1;
    if (width < 1 || this.#h < 1) return;
    if (width === this.#w && dpr === this.#dpr && this.#canvas.height === Math.round(this.#h * dpr)) return;
    this.#w = width; this.#dpr = dpr;
    this.#canvas.width = Math.round(width * dpr); this.#canvas.height = Math.round(this.#h * dpr);
    this.#canvas.style.height = `${this.#h}px`;
    this.#schedule();
  }

  #schedule(): void { if (!this.#frame) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#draw(); }); }

  #draw(): void {
    const data = this.#data;
    if (!data || this.root.hidden || this.#w < 120 || this.#h < 1) return;
    const ctx = this.#ctx, g = GEOMETRY, p = this.#palette, ch = this.#chrome, W = this.#w, H = this.#h, now = performance.now(), r = g.dot / 2;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    // The sunken well: dark along the top and left, light along the bottom and right.
    ctx.fillStyle = ch.well; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ch.lo; ctx.fillRect(0, 0, W, 1); ctx.fillRect(0, 0, 1, H);
    ctx.fillStyle = ch.hi; ctx.fillRect(0, H - 1, W, 1); ctx.fillRect(W - 1, 0, 1, H);
    ctx.textBaseline = 'middle';
    const neutral = p.dark ? '#c9d1d9' : '#6b7280';
    // The labels are as wide as the widest one needs (a font or a language can make them longer than the sample's), and the dots take what is left.
    ctx.font = FONT;
    const labelW = [...data.pulse, ...data.size.rows].reduce<number>((widest, row) => Math.max(widest, Math.ceil(ctx.measureText(row.label).width) + 5), g.labelW);
    const left = g.pad + 2, right = W - g.pad - 2, dotsX0 = left + g.lead + labelW, dotsX1 = right - g.valueW;
    // An even number of dots, so that two of them can mark the middle.
    const n = Math.max(10, Math.floor((dotsX1 - dotsX0 + (g.pitch - g.dot)) / g.pitch) & ~1), used = n * g.pitch - (g.pitch - g.dot), x0 = dotsX0 + Math.round((dotsX1 - dotsX0 - used) / 2);
    this.#dots = n;
    let y = g.pad + 1;

    const led = (x: number, cy: number, radius: number, color: string, level: 'on' | 'dim' | 'off', ring: boolean): void => {
      ctx.beginPath(); ctx.arc(x, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = level === 'off' ? mixHex(color, ch.well, 0.9) : level === 'dim' ? mixHex(color, ch.well, 0.66) : color; ctx.fill();
      if (level === 'on' && radius >= 2) { ctx.beginPath(); ctx.arc(x - radius * 0.32, cy - radius * 0.34, radius * 0.3, 0, Math.PI * 2); ctx.fillStyle = rgba(mixHex(color, '#ffffff', 0.6), 0.7); ctx.fill(); }
      if (ring) { ctx.beginPath(); ctx.arc(x, cy, radius + 2, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = rgba(color, 0.35); ctx.stroke(); }
    };
    const colorOf = (dot: Led): string => dot.startsWith('buy') ? p.bid : dot.startsWith('sell') ? p.ask : neutral;
    const levelOf = (dot: Led): 'on' | 'dim' | 'off' => dot.endsWith('-on') ? 'on' : dot.endsWith('-dim') ? 'dim' : 'off';

    const heading = (text: string, note: string, side: string): void => {
      ctx.font = FONT_BOLD; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(text, left, y + g.headH / 2);
      if (note) { ctx.fillStyle = AMBER; ctx.fillText(note, left + ctx.measureText(text).width + 6, y + g.headH / 2); }
      if (side) { ctx.font = FONT; ctx.fillStyle = p.muted; ctx.textAlign = 'right'; ctx.fillText(side, right, y + g.headH / 2); }
      y += g.headH;
    };

    const row = (rowData: StripRow, index: number, flashable: boolean, idle: boolean): void => {
      const cy = y + g.rowH / 2, share = rowData.share, buyAhead = share !== null && share > 0.5, sellAhead = share !== null && share < 0.5;
      // The lead lamp: the side that is ahead; an amber ring (nothing filled) when part of the row's window was not recorded; the ring of the Sound button when a trade of this size just printed.
      const flashing = flashable && now - (this.#flash.get(index) ?? -Infinity) < FLASH_MS;
      const lamp = buyAhead ? p.bid : sellAhead ? p.ask : p.muted;
      if (rowData.partial) { ctx.beginPath(); ctx.arc(left + 4, cy, r - 0.5, 0, Math.PI * 2); ctx.lineWidth = 1.5; ctx.strokeStyle = AMBER; ctx.stroke(); }
      else led(left + 4, cy, r, lamp, share === null ? 'off' : 'on', flashing);
      if (rowData.partial && flashing) { ctx.beginPath(); ctx.arc(left + 4, cy, r + 2, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = rgba(AMBER, 0.35); ctx.stroke(); }
      ctx.font = FONT; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(rowData.label, left + g.lead, cy);
      if (idle) { y += g.rowH; return; }
      if (rowData.partial) ctx.globalAlpha = 0.55;
      const { dots, lead } = ledRow(share, n);
      dots.forEach((dot, i) => led(x0 + i * g.pitch + r, cy, r, colorOf(dot), levelOf(dot), false));
      // The leading edge of the side that is ahead wears a ring: the peak lamp of a level meter.
      if (lead >= 0 && lead < n) { ctx.beginPath(); ctx.arc(x0 + lead * g.pitch + r, cy, r + 2, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = rgba(buyAhead ? p.bid : p.ask, 0.4); ctx.stroke(); }
      ctx.textAlign = 'right';
      if (rowData.weight !== null || rowData.key.startsWith('size:')) {
        // A size row: its share of the volume in ten dots and a number.
        const lit = weightDots(rowData.weight), wx0 = right - 10 * g.pitch + 2;
        for (let i = 0; i < 10; i++) led(wx0 + i * g.pitch + r, cy, r - 0.5, p.muted, i < lit ? 'on' : 'off', false);
        ctx.font = FONT; ctx.fillStyle = p.muted; ctx.fillText(weightText(rowData.weight), wx0 - 4, cy);
      } else {
        ctx.font = FONT_BOLD; ctx.fillStyle = share === null ? p.muted : buyAhead ? p.bid : sellAhead ? p.ask : p.text; ctx.fillText(percent(share), right, cy);
      }
      ctx.globalAlpha = 1;
      y += g.rowH;
    };

    heading(t('TAKER FLOW'), '', data.heading);
    data.pulse.forEach((rowData, i) => row(rowData, i, false, false));
    y += g.groupGap;
    heading(t('TRADE SIZE · USD · {window}', { window: data.window }), data.size.partial && data.size.covered !== null ? coverageNote(data.size.covered, data.size.minutes) : '', t('share of volume'));
    const bands = sizeBands(this.store.state.cvd), top = y, idle = data.size.state === 'unavailable';
    data.size.rows.forEach((rowData, i) => row(rowData, i, (bands[i]?.to ?? 0) >= 1, idle));
    if (idle) {
      ctx.font = FONT; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const text = t('Trade sizes are not available from this server.'), room = right - dotsX0;
      let shown = text; while (shown.length > 4 && ctx.measureText(shown).width > room) shown = `${shown.slice(0, -2)}…`;
      ctx.fillText(shown, dotsX0, top + (y - top) / 2);
    }
  }

  // ---- pointer --------------------------------------------------------------------------------------------------------------------

  #point(e: PointerEvent): void {
    const data = this.#data;
    if (!data || e.pointerType === 'touch') return;
    const hit = rowAt(e.clientY - this.#canvas.getBoundingClientRect().top, data.size.rows.length);
    const row = hit ? (hit.group === 'pulse' ? data.pulse[hit.index] : data.size.rows[hit.index]) : undefined;
    if (row && !(row.key.startsWith('size:') && data.size.state !== 'ready')) this.#card.show(rowLines(row, data), e.clientX, e.clientY); else this.#card.hide();
  }
}
