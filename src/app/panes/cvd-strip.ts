import { PALETTES, chromeFor, mixHex, rgb, type Chrome, type Palette } from '../theme.ts';
import { el } from '../dom.ts';
import { isPhone } from '../device.ts';
import { HoverCard } from '../hovercard.ts';
import { t } from '../i18n.ts';
import type { Store } from '../store.ts';
import type { Hub } from '../hub.ts';
import type { Print } from '../prints.ts';
import type { SizesAnswer } from '../../shared/footprint.ts';
import { SIZE_FLOOR_USD } from '../sizes.ts';
import { GEOMETRY, askedWindows, bandCuts, buildStrip, coverageNote, flashBands, ledRow, percent, rankMinutes, rowAt, rowLines, sizeBands, stripHeight, weightDots, weightText, type Led, type StripData, type StripRow } from '../cvd/strip.ts';
import { replaying } from '../replay/clock.ts';
import { pixelRatio, sharpens } from '../pixel-ratio.ts';

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

/** How a colour's dots are painted: lit, dimmed and off (mixed toward the well), the shine on a lit one, and its rings. */
interface Tones { dim: string; off: string; shine: string; ring: string; bead: string }
/** Circles painted alike (a fill or a stroke of one colour and width, at one alpha): their centres and radii, three numbers each. */
interface Circles { fill: boolean; style: string; width: number; alpha: number; at: number[] }
/**
 * Circles gathered by how they are painted, then painted one path each, layer over layer (the dots, their shine, the light running along a
 * row, the rings). Circles painted alike never overlap, so one path paints them as their own fills did.
 */
class CircleBatch {
  readonly #layers: Map<string, Circles>[] = [new Map(), new Map(), new Map(), new Map()];
  /** The alpha of the circles added next (a row not fully recorded is drawn faint). */
  alpha = 1;
  add(layer: 0 | 1 | 2 | 3, fill: boolean, style: string, width: number, x: number, y: number, radius: number): void {
    const alpha = this.alpha, key = alpha === 1 && width === 0 ? style : `${style}|${alpha}|${width}`, map = this.#layers[layer]!;
    let c = map.get(key); if (!c) { c = { fill, style, width, alpha, at: [] }; map.set(key, c); }
    c.at.push(x, y, radius);
  }
  /** Paint what was added, and start empty. */
  paint(ctx: CanvasRenderingContext2D): void {
    for (const layer of this.#layers) {
      for (const c of layer.values()) {
        ctx.globalAlpha = c.alpha; ctx.beginPath();
        const at = c.at;
        for (let i = 0; i < at.length; i += 3) { const x = at[i]!, y = at[i + 1]!, radius = at[i + 2]!; ctx.moveTo(x + radius, y); ctx.arc(x, y, radius, 0, Math.PI * 2); }
        if (c.fill) { ctx.fillStyle = c.style; ctx.fill(); } else { ctx.lineWidth = c.width; ctx.strokeStyle = c.style; ctx.stroke(); }
      }
      layer.clear();
    }
    ctx.globalAlpha = 1; this.alpha = 1;
  }
}
/**
 * A row as the still picture drew it, for what the frames draw over it: its lamp's ring when a trade of its size prints (`flash`: its index
 * among the size rows, -1 for a row that does not blink), the light running along it, and its bead.
 */
interface RowDrawn { key: string; cy: number; lamp: string; partial: boolean; flash: number; lead: number; buyAhead: boolean; idle: boolean }

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
  /**
   * The abacus (Karl, 2026-10-17): where each row's leading ring sits now and how fast it moves, so it slides to a new share on a spring
   * with a little overshoot instead of jumping, and when the strip last drew (the spring's clock).
   */
  #beads = new Map<string, { x: number; v: number }>(); #lastDraw = 0;
  #disposed = false;
  /**
   * The strip as it stands between two refreshes (`#paintStill`: the well, the headings, each row's lamp, label, dots and numbers), what
   * it was painted for, and its rows; each frame copies it and draws only what moves over it (the light running along a row, the rings).
   * Drawn whole on every frame, its ~700 dots each a fill with its colour mixed afresh, the strip was the page's busiest canvas after the
   * map with trades printing (3.8% of the main thread, Research_Findings.md, 2026-11-07); its rows change once a second.
   */
  #still = document.createElement('canvas');
  #stillCtx = this.#still.getContext('2d')!;
  #stillFor: { data: StripData; palette: Palette; w: number; h: number; dpr: number; left: number; x0: number; n: number } | null = null;
  #rowsDrawn: RowDrawn[] = [];
  #batch = new CircleBatch();
  #tones = new Map<string, Tones>();

  constructor(private store: Store, private hub: Hub) {
    this.#canvas.setAttribute('role', 'img');
    this.#canvas.setAttribute('aria-label', t('Taker flow and market order sizes, as rows of dots'));
    this.root.append(this.#canvas);
    new ResizeObserver(() => this.#resize()).observe(this.root);
    sharpens({ resize: () => this.#resize(), paint: () => { if (!this.root.hidden) this.#draw(); } });
    this.#canvas.addEventListener('pointermove', e => this.#point(e));
    this.#canvas.addEventListener('pointerleave', () => this.#card.hide());
  }

  setPalette(p: Palette): void { this.#palette = p; this.#chrome = chromeFor(p); this.#tones.clear(); this.#schedule(); }

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
    // Replay: the sizes are counted on the server's clock, the flow rows end now: neither is the replay's moment.
    this.root.hidden = !c.strip || isPhone() || replaying();
    if (this.root.hidden) { this.#card.hide(); return; }
    const windows = askedWindows(rankMinutes(c)), cuts = bandCuts(sizeBands(c)), key = this.#key(windows, cuts);
    this.#ask(windows, cuts, key);
    const known = this.#sizes?.key === key ? this.#sizes.answer : null;
    this.#data = buildStrip({ flow: this.hub.flow, counted: this.#counted, nowSec: Math.floor(Date.now() / 1000), settings: c, scope: s.scope, sizes: known, state: known ? 'ready' : this.#failed ? 'unavailable' : 'loading' });
    this.#h = stripHeight(this.#data.size.rows.length);
    this.#resize();
    this.#schedule();
  }

  /** An answer is for these instruments, windows and size lines: one for other lines splits the orders somewhere else. */
  #key(windows: readonly number[], cuts: readonly number[]): string { return `${this.#countedKey}|${windows.join(',')}|${cuts.join(',')}`; }

  /** One question at a time: at once for a set not asked about yet, every few seconds for the same one, and slowly after a failure (a server that has no such route). */
  #ask(windows: number[], cuts: number[], key: string): void {
    // After the map's first columns on the server's page (`Hub.mapFirst`).
    if (this.#asking || !this.#counted.length || this.hub.mapFirst()) return;
    const now = Date.now(), fresh = this.#sizes?.key === key;
    if (now - this.#askedAt < (this.#failed ? RETRY_MS : fresh ? ASK_EVERY_MS : 0)) return;
    this.#asking = true; this.#askedAt = now;
    this.hub.source.sizes([...this.#counted], windows, cuts).then(answer => { this.#sizes = { key, answer }; this.#failed = false; }, () => { this.#failed = true; })
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
    const width = Math.floor(this.#canvas.getBoundingClientRect().width), dpr = pixelRatio();
    if (width < 1 || this.#h < 1) return;
    if (width === this.#w && dpr === this.#dpr && this.#canvas.height === Math.round(this.#h * dpr)) return;
    this.#w = width; this.#dpr = dpr;
    this.#canvas.width = Math.round(width * dpr); this.#canvas.height = Math.round(this.#h * dpr);
    this.#canvas.style.height = `${this.#h}px`;
    this.#schedule();
  }

  #schedule(): void { if (!this.#frame) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#draw(); }); }

  /** How a colour's dots are painted, worked out once a palette. */
  #tonesOf(color: string): Tones {
    let tone = this.#tones.get(color);
    if (!tone) { const well = this.#chrome.well; tone = { dim: mixHex(color, well, 0.66), off: mixHex(color, well, 0.9), shine: rgba(mixHex(color, '#ffffff', 0.6), 0.7), ring: rgba(color, 0.35), bead: rgba(color, 0.4) }; this.#tones.set(color, tone); }
    return tone;
  }

  /** A frame: the still picture (painted again first when the rows, the palette or the size changed), and what moves over it. */
  #draw(): void {
    const data = this.#data;
    if (!data || this.root.hidden || this.#w < 120 || this.#h < 1) return;
    const now = performance.now(), still = reducedMotion(), dt = Math.min(50, Math.max(0, now - (this.#lastDraw || now))) / 1000;
    this.#lastDraw = now;
    const was = this.#stillFor;
    if (!was || was.data !== data || was.palette !== this.#palette || was.w !== this.#w || was.h !== this.#h || was.dpr !== this.#dpr) this.#paintStill(data);
    const ctx = this.#ctx, g = GEOMETRY, p = this.#palette, r = g.dot / 2, { left, x0, n } = this.#stillFor!, batch = this.#batch;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height); ctx.drawImage(this.#still, 0, 0);
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    let moving = false;
    for (const row of this.#rowsDrawn) {
      const printed = row.flash >= 0 ? this.#flash.get(row.flash) : undefined, flashing = printed !== undefined && now - printed < FLASH_MS;
      // The ring of the Sound button on the lead lamp when a trade of this size just printed (amber on a row not fully recorded).
      batch.alpha = 1;
      if (flashing) batch.add(3, false, this.#tonesOf(row.partial ? AMBER : row.lamp).ring, 2, left + 4, row.cy, r + 2);
      if (row.idle) continue;
      batch.alpha = row.partial ? 0.55 : 1;
      // A trade of this size just printed: a light runs along the row from its lamp, over the dots.
      if (flashing && !still) {
        const at = (now - printed) / FLASH_MS * (n + 2) - 1, fade = 1 - (now - printed) / FLASH_MS;
        for (let i = Math.max(0, Math.floor(at - 2)); i <= Math.min(n - 1, Math.ceil(at + 2)); i++) {
          const k = Math.max(0, 1 - Math.abs(i - at) / 2) * fade; if (k <= 0) continue;
          batch.add(2, true, rgba(mixHex(row.lamp, '#ffffff', 0.45), 0.75 * k), 0, x0 + i * g.pitch + r, row.cy, r + 1);
        }
        moving = true;
      }
      // The leading edge of the side that is ahead wears a ring: the peak lamp of a level meter. It slides to a new place as an abacus bead
      // does, on a spring that overshoots a little and settles.
      const lead = row.lead;
      if (lead >= 0 && lead < n) {
        const bead = this.#beads.get(row.key) ?? { x: lead, v: 0 };
        if (still || Math.abs(bead.x - lead) > n) { bead.x = lead; bead.v = 0; }
        else {
          const w = 18, zeta = 0.55;
          bead.v += (-w * w * (bead.x - lead) - 2 * zeta * w * bead.v) * dt; bead.x += bead.v * dt;
          if (Math.abs(bead.x - lead) < 0.01 && Math.abs(bead.v) < 0.05) { bead.x = lead; bead.v = 0; } else moving = true;
        }
        this.#beads.set(row.key, bead);
        batch.add(3, false, this.#tonesOf(row.buyAhead ? p.bid : p.ask).bead, 2, x0 + bead.x * g.pitch + r, row.cy, r + 2);
      }
    }
    batch.paint(ctx);
    if (moving) this.#schedule();
  }

  /**
   * The strip as it stands between two refreshes, on a canvas of its own: the well, the headings, and each row's lamp, label, dots and
   * numbers. Painted when the rows change (once a second), the palette or the size; each frame copies it and draws what moves over it.
   */
  #paintStill(data: StripData): void {
    const W = this.#w, H = this.#h, dpr = this.#dpr, canvas = this.#still, ctx = this.#stillCtx, batch = this.#batch;
    const width = Math.round(W * dpr), height = Math.round(H * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const g = GEOMETRY, p = this.#palette, ch = this.#chrome, r = g.dot / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
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
    const rows: RowDrawn[] = [];
    let y = g.pad + 1;

    const led = (x: number, cy: number, radius: number, color: string, level: 'on' | 'dim' | 'off'): void => {
      const tone = this.#tonesOf(color);
      batch.add(0, true, level === 'off' ? tone.off : level === 'dim' ? tone.dim : color, 0, x, cy, radius);
      if (level === 'on' && radius >= 2) batch.add(1, true, tone.shine, 0, x - radius * 0.32, cy - radius * 0.34, radius * 0.3);
    };
    const colorOf = (dot: Led): string => dot.startsWith('buy') ? p.bid : dot.startsWith('sell') ? p.ask : neutral;
    const levelOf = (dot: Led): 'on' | 'dim' | 'off' => dot.endsWith('-on') ? 'on' : dot.endsWith('-dim') ? 'dim' : 'off';

    const heading = (text: string, note: string, side: string): void => {
      ctx.font = FONT_BOLD; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(text, left, y + g.headH / 2);
      if (note) { ctx.fillStyle = AMBER; ctx.fillText(note, left + ctx.measureText(text).width + 6, y + g.headH / 2); }
      if (side) { ctx.font = FONT; ctx.fillStyle = p.muted; ctx.textAlign = 'right'; ctx.fillText(side, right, y + g.headH / 2); }
      y += g.headH;
    };

    const row = (rowData: StripRow, flash: number, idle: boolean): void => {
      const cy = y + g.rowH / 2, share = rowData.share, buyAhead = share !== null && share > 0.5, sellAhead = share !== null && share < 0.5;
      // The lead lamp: the side that is ahead; an amber ring (nothing filled) when part of the row's window was not recorded.
      const lamp = buyAhead ? p.bid : sellAhead ? p.ask : p.muted;
      batch.alpha = 1;
      if (rowData.partial) batch.add(3, false, AMBER, 1.5, left + 4, cy, r - 0.5);
      else led(left + 4, cy, r, lamp, share === null ? 'off' : 'on');
      ctx.font = FONT; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(rowData.label, left + g.lead, cy);
      const { dots, lead } = idle ? { dots: [], lead: -1 } : ledRow(share, n);
      rows.push({ key: rowData.key, cy, lamp, partial: rowData.partial, flash, lead, buyAhead, idle });
      if (idle) { y += g.rowH; return; }
      if (rowData.partial) { ctx.globalAlpha = 0.55; batch.alpha = 0.55; }
      dots.forEach((dot, i) => led(x0 + i * g.pitch + r, cy, r, colorOf(dot), levelOf(dot)));
      ctx.textAlign = 'right';
      if (rowData.weight !== null || rowData.key.startsWith('size:')) {
        // A size row: its share of the volume in ten dots and a number.
        const lit = weightDots(rowData.weight), wx0 = right - 10 * g.pitch + 2;
        for (let i = 0; i < 10; i++) led(wx0 + i * g.pitch + r, cy, r - 0.5, p.muted, i < lit ? 'on' : 'off');
        ctx.font = FONT; ctx.fillStyle = p.muted; ctx.fillText(weightText(rowData.weight), wx0 - 4, cy);
      } else {
        ctx.font = FONT_BOLD; ctx.fillStyle = share === null ? p.muted : buyAhead ? p.bid : sellAhead ? p.ask : p.text; ctx.fillText(percent(share), right, cy);
      }
      ctx.globalAlpha = 1; batch.alpha = 1;
      y += g.rowH;
    };

    heading(t('TAKER FLOW'), '', data.heading);
    data.pulse.forEach(rowData => row(rowData, -1, false));
    y += g.groupGap;
    heading(t('ORDER SIZE · USD · {window}', { window: data.window }), data.size.partial && data.size.covered !== null ? coverageNote(data.size.covered, data.size.minutes) : '', t('share of volume'));
    const bands = sizeBands(this.store.state.cvd), top = y, idle = data.size.state === 'unavailable';
    // A row that holds orders from the floor up can blink (the print stream starts there); the row of the orders under it cannot.
    data.size.rows.forEach((rowData, i) => row(rowData, bands[i] !== undefined && (bands[i]!.hi === null || bands[i]!.hi! > SIZE_FLOOR_USD) ? i : -1, idle));
    if (idle) {
      ctx.font = FONT; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const text = t('Order sizes are not available from this server.'), room = right - dotsX0;
      let shown = text; while (shown.length > 4 && ctx.measureText(shown).width > room) shown = `${shown.slice(0, -2)}…`;
      ctx.fillText(shown, dotsX0, top + (y - top) / 2);
    }
    batch.paint(ctx);
    this.#rowsDrawn = rows;
    this.#stillFor = { data, palette: p, w: W, h: H, dpr, left, x0, n };
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
