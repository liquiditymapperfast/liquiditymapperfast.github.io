import { t, tn } from '../i18n.ts';
import { el } from '../dom.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import { compactBar, isCoarse } from '../device.ts';
import { togglePanel, switchRow, segmented, heading, note, button, type Panel } from '../ui.ts';
import { DRAW_COLORS, DRAW_WIDTHS, MAX_IMPORT_CHARS, type DrawColor, type DrawKind, type Drawing } from './model.ts';
import { MAGNET_MODES, type MagnetMode } from './magnet.ts';
import { handlesOf, noteBox, type Projection, type Pt } from './geometry.ts';
import type { DrawController } from './controller.ts';
import type { DrawSettings } from './settings.ts';
import { colorOf } from './paint.ts';
import type { Palette } from '../theme.ts';

/**
 * The drawing tools' controls (draw/controller.ts holds what they show), none of them in a screenshot:
 * - the Draw button in the map's corner, beside Select, which brings the tools out;
 * - a rail down the map's left edge under the legend, as charts usually keep their drawing tools (it covers the oldest candles, never the
 *   live edge): the tools, the magnet, Undo and Redo and the list of drawings; along the foot of the map on a phone;
 * - beside the drawing selected, a small bar of its look and options and, under it, its figures (how far the price is from a level and what
 *   rests there in the book now, a zone's height and length);
 * - at the foot of the map, the next step while a drawing is placed (with Cancel), or what went wrong.
 * The Drawings panel holds the settings, the list of this coin's drawings, a file to keep them in and Delete all.
 */

const SVG = 'http://www.w3.org/2000/svg';
/** The small drawings of the controls, in the stroke of the text around them (24 x 24). */
const GLYPHS = {
  level: '<path d="M3 12h18"/><circle cx="8" cy="12" r="1.8"/>',
  trend: '<path d="M5 18L19 6"/><circle cx="5" cy="18" r="1.8"/><circle cx="19" cy="6" r="1.8"/>',
  zone: '<rect x="4" y="7" width="16" height="10" rx="1"/>',
  vline: '<path d="M12 3v18" stroke-dasharray="3 2.5"/>',
  note: '<path d="M4 5h16v10h-9l-4 4v-4H4z"/>',
  fib: '<path d="M4 6h16M4 10.5h16M4 15h16M4 19h16"/><path d="M5 19L19 6" stroke-dasharray="2 2"/>',
  channel: '<path d="M3 15L16 5M8 20L21 10"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4"/><path d="M6 8h3M15 8h3"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>',
  pen: '<path d="M4 20l4.5-1L19 8.5 15.5 5 5 15.5z"/><path d="M13.5 7l3.5 3.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  dashed: '<path d="M3 12h4M10 12h4M17 12h4"/>',
  left: '<path d="M21 12H5M9 8l-4 4 4 4"/>',
  right: '<path d="M3 12h16M15 8l4 4-4 4"/>',
  ray: '<circle cx="5" cy="12" r="1.8"/><path d="M7 12h12M15 8l4 4-4 4"/>',
  leader: '<circle cx="5" cy="18" r="1.8"/><path d="M6.5 16.5L12 10"/><rect x="12" y="4" width="9" height="7" rx="1"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  inspect: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="M15 15l5 5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="1.5"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>',
  trash: '<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeOff: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><path d="M4 4l16 16"/>',
} as const;
type GlyphName = keyof typeof GLYPHS;

function glyph(name: GlyphName): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'draw-glyph');
  svg.innerHTML = GLYPHS[name];
  return svg;
}
const iconButton = (name: GlyphName, label: string, tip: string, cls = 'draw-icon'): HTMLButtonElement => {
  const b = el('button', { type: 'button', class: cls, ariaLabel: label, tip });
  b.append(glyph(name));
  return b;
};

/** The tools in the order the rail offers them: levels and zones first, the map's own question (Karl, 2026-10-28). */
const TOOL_ORDER: readonly DrawKind[] = ['level', 'zone', 'trend', 'vline', 'note', 'fib', 'channel'];
export const toolName = (k: DrawKind): string => ({ level: t('Level'), trend: t('Trend line'), zone: t('Zone'), vline: t('Vertical line'), note: t('Note'), fib: t('Fib retracement'), channel: t('Parallel channel') })[k];
const toolTip = (k: DrawKind): string => ({
  level: t('Level: a line across the map at one price. Its tag on the price axis says the price; selected, it says how far the price is and what rests there in the book now.'),
  trend: t('Trend line: a line between two points, or run on past either end.'),
  zone: t('Zone: a box of prices over a stretch of time. Inspect adds up what traded in it.'),
  vline: t('Vertical line: a moment, across the map and the panes under it.'),
  note: t('Note: a few words pinned to a point, to remember why.'),
  fib: t('Fib retracement: the levels between two swings, at 23.6, 38.2, 50, 61.8 and 78.6 percent of the move.'),
  channel: t('Parallel channel: a line between two points and its parallel through a third.'),
})[k];
const magnetWord = (m: MagnetMode): string => ({ off: t('Off'), weak: t('Weak'), strong: t('Strong') })[m];
/** How often a selected level's figures are taken again as the price and the book move (ms). */
const FIGURES_EVERY_MS = 500;
const colorName = (c: DrawColor): string => ({ ink: t('Ink'), blue: t('Blue'), amber: t('Amber'), purple: t('Purple'), bid: t('Buy colour'), ask: t('Sell colour') })[c];

/** A short name for a drawing in the list: its kind and its price, time or text. */
export function describe(d: Drawing): string {
  if (d.text) return `${toolName(d.kind)}: ${d.text.length > 40 ? `${d.text.slice(0, 39)}…` : d.text}`;
  const [a, b] = d.points;
  switch (d.kind) {
    case 'level': return `${toolName(d.kind)} ${fmtPrice(a!.p)}`;
    case 'zone': return `${toolName(d.kind)} ${fmtPrice(Math.min(a!.p, b!.p))} – ${fmtPrice(Math.max(a!.p, b!.p))}`;
    default: return `${toolName(d.kind)} ${clock(a!.t, true)}`;
  }
}

const pct = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(Math.abs(x) < 1 ? 2 : 1)} %`;
function span(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  if (m < 60) return tn(m, '{n} min', '{n} min');
  const h = Math.floor(m / 60), rest = m % 60;
  if (h < 48) return rest ? t('{h} h {m} min', { h: String(h), m: String(rest) }) : tn(h, '{n} h', '{n} h');
  return tn(Math.round(h / 24), '{n} day', '{n} days');
}

/** What the bar says about a selected drawing: its prices, how far the price is, what rests there now, its height or its move. */
export function readout(d: Drawing, mark: number, resting: { bid: number; ask: number; step: number } | null): string {
  const [a, b, c] = d.points;
  switch (d.kind) {
    case 'level': {
      const p = a!.p, parts = [fmtPrice(p)];
      if (mark > 0) parts.push(t('{pct} from the price', { pct: pct((p - mark) / mark * 100) }));
      if (resting) parts.push(resting.bid + resting.ask > 0 ? t('{usd} resting in the {step} row now', { usd: `$${usd(resting.bid + resting.ask)}`, step: `$${fmtPrice(resting.step, resting.step)}` }) : t('nothing resting in the {step} row now', { step: `$${fmtPrice(resting.step, resting.step)}` }));
      else parts.push(t('the book is not held here'));
      return parts.join(' · ');
    }
    case 'zone': {
      const lo = Math.min(a!.p, b!.p), hi = Math.max(a!.p, b!.p);
      return `${fmtPrice(lo)} – ${fmtPrice(hi)} · ${pct((hi - lo) / lo * 100).slice(1)} · ${d.extendRight ? t('from {time} on', { time: clock(Math.min(a!.t, b!.t), true) }) : span(b!.t - a!.t)}`;
    }
    case 'trend': return t('{from} to {to}: {pct} in {span}', { from: fmtPrice(a!.p), to: fmtPrice(b!.p), pct: pct((b!.p - a!.p) / a!.p * 100), span: span(b!.t - a!.t) });
    case 'fib': return t('{from} to {to}: {pct}', { from: fmtPrice(a!.p), to: fmtPrice(b!.p), pct: pct((b!.p - a!.p) / a!.p * 100) });
    case 'channel': {
      // How far the parallel is from the line through the first two points, in price (the same all along).
      const slope = b!.t !== a!.t ? (b!.p - a!.p) / (b!.t - a!.t) : 0, width = Math.abs(c!.p - (a!.p + slope * (c!.t - a!.t))), mid = (a!.p + b!.p) / 2;
      return t('{from} to {to}, {width} wide ({pct})', { from: fmtPrice(a!.p), to: fmtPrice(b!.p), width: fmtPrice(width), pct: pct(width / mid * 100).slice(1) });
    }
    case 'vline': return clock(a!.t, true);
    case 'note': return '';
  }
}

/**
 * Where a selected drawing's bar goes on the plot (CSS px, before the columns left of the map are added): centred over the part of the
 * drawing in view, above it where there is room under the legend, else below it; inside the plot and right of the rail (`left`) always.
 * Null where none of it is in view.
 */
export function editorPlace(d: Drawing, pr: Projection, size: { w: number; h: number }, top: number, left = 4, note?: { w: number; h: number }): { x: number; y: number } | null {
  const hs: Pt[] = handlesOf(d, pr);
  if (d.kind === 'note' && note) { const b = noteBox(d, pr, note); hs.push({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }); }
  let x0 = Math.min(...hs.map(h => h.x)), x1 = Math.max(...hs.map(h => h.x)), y0 = Math.min(...hs.map(h => h.y)), y1 = Math.max(...hs.map(h => h.y));
  if (d.kind === 'level') { x0 = d.extendLeft ? 0 : Math.max(0, x0); x1 = pr.w; }
  if (d.kind === 'vline') { y0 = top + 30; y1 = top + 30; }
  if (d.kind === 'zone' && d.extendRight) x1 = pr.w;
  x0 = Math.max(0, x0); x1 = Math.min(pr.w, x1);
  if (x1 < 0 || x0 > pr.w || y1 < 0 || y0 > pr.h || x1 < x0) return null;
  const gap = 12, x = Math.max(left, Math.min(pr.w - size.w - 4, (x0 + x1) / 2 - size.w / 2));
  const above = y0 - gap - size.h, below = y1 + gap;
  const low = Math.max(top, below);
  if (above >= top) return { x, y: above };
  if (low + size.h <= pr.h - 4) return { x, y: low };
  const y = Math.max(top, Math.min(pr.h - size.h - 4, (y0 + y1) / 2 - size.h / 2));
  if (x1 + gap + size.w <= pr.w - 4) return { x: x1 + gap, y };
  if (x0 - gap - size.w >= left) return { x: x0 - gap - size.w, y };
  return { x, y: Math.max(top, Math.min(pr.h - size.h - 4, above)) };
}

export interface DrawBarHost {
  settings(): DrawSettings;
  setSettings(patch: Partial<DrawSettings>): void;
  palette(): Palette;
  mark(): number;
  restingAt(price: number): { bid: number; ask: number; step: number } | null;
  replaying(): boolean;
  /** Draw the map again (the rail is placed as the map draws). */
  redraw(): void;
}

/** Where the controls go this frame: the plot's left edge in the pane, its projection, and the legend's foot (the rail starts under it). */
export interface DrawFrame { left: number; pr: Projection; legendBottom: number }

export class DrawBar {
  /** The Draw button for the map's corner (desktop). */
  readonly button = el('button', { type: 'button', class: 'led-btn map-draw', ariaLabel: t('Draw'), tip: t('Drawing tools: levels, zones, trend lines and notes on the map (keyboard: D). A weak magnet lands points on the candles\' prices and on walls of resting liquidity; hold Alt to place freely.') });
  /** The same on a phone, over the map (its corner holds no buttons there). */
  readonly phoneButton = el('button', { type: 'button', class: 'led-btn map-draw-phone', ariaLabel: t('Draw') });
  readonly rail = el('div', { class: 'draw-rail', hidden: true, role: 'toolbar', ariaLabel: t('Drawing tools') });
  readonly editor = el('div', { class: 'draw-editor', hidden: true, role: 'toolbar', ariaLabel: t('The drawing selected') });
  readonly say = el('div', { class: 'draw-say', hidden: true, role: 'status' });
  readonly #controls = el('div', { class: 'draw-controls' });
  readonly #figures = el('div', { class: 'draw-figures' });
  readonly #sayText = el('span', {});
  readonly #cancel = el('button', { type: 'button', class: 'draw-cancel', textContent: t('Cancel'), tip: t('Stop placing this drawing (Esc)') });
  #toolButtons = new Map<DrawKind, HTMLButtonElement>();
  #magnet = el('button', { type: 'button', class: 'draw-icon draw-magnet' });
  #undo = iconButton('undo', t('Undo'), t('Undo (Ctrl+Z, ⌘Z on a Mac)'));
  #redo = iconButton('redo', t('Redo'), t('Redo (Ctrl+Shift+Z or Ctrl+Y)'));
  #listButton = el('button', { type: 'button', class: 'draw-icon draw-list-btn', tip: t('Drawings: this coin\'s list, the settings, a file to keep them in') });
  #panel: Panel | null = null;
  /** The selected drawing the editor was built for, and the controls that follow its fields. */
  #editFor = '';
  #syncEdit: ((d: Drawing) => void)[] = [];
  /** Delete all waits for a second press. */
  #armedDelete = false;
  /** The last frame's places, so a frame that moves nothing writes nothing. */
  #placed = '';
  /** When the selected drawing's figures were last taken (a level's change with the price and the book). */
  #figuresAt = 0;
  /** The rail's and the editor's sizes, kept by a ResizeObserver, so a frame never reads the layout back. */
  #sizes = { railW: 36, railH: 0, editorW: 300, editorH: 56 };

  constructor(private draw: DrawController, private host: DrawBarHost) {
    for (const node of [this.rail, this.editor, this.say]) node.setAttribute('data-no-capture', '');
    this.button.append(glyph('pen'), el('span', { textContent: t('Draw') }));
    this.phoneButton.append(glyph('pen'));
    this.button.onclick = () => this.toggle();
    this.phoneButton.onclick = () => this.toggle();
    for (const kind of TOOL_ORDER) {
      const b = el('button', { type: 'button', class: 'draw-icon draw-tool', ariaLabel: toolName(kind), tip: toolTip(kind) });
      b.append(glyph(kind));
      b.onclick = () => { if (this.draw.tool === kind) this.draw.disarm(); else this.draw.arm(kind); };
      this.#toolButtons.set(kind, b); this.rail.append(b);
    }
    this.#magnet.append(glyph('magnet'), el('span', { class: 'draw-magnet-mode' }));
    this.#magnet.onclick = () => { const m = this.host.settings().magnet; this.host.setSettings({ magnet: MAGNET_MODES[(MAGNET_MODES.indexOf(m) + 1) % MAGNET_MODES.length]! }); this.sync(); };
    this.#undo.onclick = () => this.draw.undo();
    this.#redo.onclick = () => this.draw.redo();
    this.#listButton.append(glyph('list'), el('span', { class: 'draw-count' }));
    this.#listButton.onclick = () => this.#openPanel();
    const close = iconButton('close', t('Close the drawing tools'), t('Close the drawing tools (D); the drawings stay on the map'));
    close.onclick = () => this.toggle(false);
    this.rail.append(el('span', { class: 'draw-sep' }), this.#magnet, this.#undo, this.#redo, this.#listButton, close);
    this.editor.append(this.#controls, this.#figures);
    this.#cancel.onclick = () => this.draw.cancel();
    this.say.append(this.#sayText, this.#cancel);
    this.draw.onChange = () => this.sync();
    if (typeof ResizeObserver === 'function') {
      const measure = new ResizeObserver(() => {
        this.#sizes = { railW: this.rail.offsetWidth || 36, railH: this.rail.offsetHeight, editorW: this.editor.offsetWidth || 300, editorH: this.editor.offsetHeight || 56 };
        this.#placed = ''; this.host.redraw();
      });
      measure.observe(this.rail); measure.observe(this.editor);
    }
    this.sync();
  }

  /** Bring the tools out or put them away (`on` forced, or the other way); put away, any tool armed is disarmed and nothing stays selected. */
  toggle(on = !this.draw.open): void {
    this.draw.open = on;
    if (!on) { this.draw.disarm(); if (this.draw.selected) this.draw.cancel(); this.#panel?.close(); }
    this.sync(); this.host.redraw();
  }

  /** Show what the controller holds: the armed tool, the magnet, Undo and Redo, the count, the selection's bar and the line at the foot. */
  sync(): void {
    const d = this.draw, s = this.host.settings(), open = d.open, phone = compactBar();
    this.rail.hidden = !open;
    for (const node of [this.rail, this.editor, this.say]) node.classList.toggle('phone', phone);
    for (const b of [this.button, this.phoneButton]) { b.dataset.state = open ? 'on' : 'off'; b.setAttribute('aria-pressed', String(open)); }
    for (const [kind, b] of this.#toolButtons) { b.classList.toggle('on', d.tool === kind); b.setAttribute('aria-pressed', String(d.tool === kind)); b.classList.toggle('idle', d.readOnly); }
    (this.#magnet.lastChild as HTMLElement).textContent = magnetWord(s.magnet);
    this.#magnet.classList.toggle('on', s.magnet !== 'off');
    this.#magnet.setAttribute('aria-label', t('Magnet: {mode}', { mode: magnetWord(s.magnet) }));
    this.#magnet.dataset.tip = t('Magnet: {mode}. Weak lands a point on the open, high, low or close of the candle under the pointer when it is within a few pixels, Strong from further, Off never; walls of resting liquidity too while that is on in Drawings. Hold Alt to place freely. Click to change.', { mode: magnetWord(s.magnet) });
    this.#undo.disabled = !d.canUndo || d.readOnly; this.#redo.disabled = !d.canRedo || d.readOnly;
    const n = d.list().length;
    (this.#listButton.lastChild as HTMLElement).textContent = n ? String(n) : '';
    this.#listButton.setAttribute('aria-label', tn(n, '{n} drawing', '{n} drawings'));
    this.#syncSelection();
    this.#figuresAt = 0; this.#syncFigures(performance.now());
    const words = d.message?.text ?? d.hint(isCoarse()) ?? (open && this.host.replaying() ? t('Drawings are shown but not changed during a replay.') : '');
    this.say.hidden = !words;
    this.#sayText.textContent = words;
    this.#cancel.hidden = !d.tool;
    this.say.classList.toggle('warn', d.message?.warn === true);
    this.#placed = '';
    if (this.#panel) this.#panel.render((tools, body) => this.#buildPanel(tools, body));
  }

  /**
   * Put the controls in their places for this frame (the map calls it as it draws): the rail under the legend on the map's left edge, the
   * selected drawing's bar beside it, the line at the foot centred. A phone's stack along the foot of the map is placed by the stylesheet.
   */
  place(f: DrawFrame): void {
    const d = this.draw, sel = d.open ? d.shown().find(x => x.id === d.selected) ?? null : null, phone = compactBar();
    if (sel) this.#syncFigures(performance.now());
    const railRight = this.rail.hidden ? 4 : 6 + this.#sizes.railW + 6, room = `${Math.min(560, Math.max(160, f.pr.w - railRight - 8))}px`;
    const width = phone ? '' : room;
    if (this.editor.style.maxWidth !== width) this.editor.style.maxWidth = width;
    let editor = '';
    if (sel && !phone) {
      const at = editorPlace(sel, f.pr, { w: this.#sizes.editorW, h: this.#sizes.editorH }, f.legendBottom + 6, railRight, sel.kind === 'note' ? d.noteSize(sel) : undefined);
      editor = at ? `${Math.round(f.left + at.x)},${Math.round(at.y)}` : 'none';
    }
    const key = `${f.left}|${Math.round(f.legendBottom)}|${f.pr.w}|${f.pr.h}|${editor}|${phone}|${phone ? `${this.#sizes.railH}|${this.#sizes.editorH}|${this.editor.hidden}` : ''}`;
    if (key === this.#placed) return;
    this.#placed = key;
    if (!phone) {
      this.rail.style.left = `${f.left + 6}px`; this.rail.style.top = `${Math.round(f.legendBottom + 8)}px`;
      this.rail.style.maxHeight = `${Math.max(120, f.pr.h - f.legendBottom - 16)}px`;
      this.say.style.left = `${f.left + f.pr.w / 2}px`; this.say.style.top = `${f.pr.h - 34}px`;
      this.rail.parentElement?.style.removeProperty('--draw-foot');
    } else {
      // A phone: the strip along the map's foot (two rows when it needs them), the selected drawing's bar and the next step stacked over it.
      for (const node of [this.rail, this.say]) { node.style.left = ''; node.style.top = ''; node.style.maxHeight = ''; }
      const over = 28 + (this.rail.hidden ? 0 : this.#sizes.railH) + 6;
      this.editor.style.bottom = `${over}px`;
      this.say.style.bottom = `${over + (!sel ? 0 : this.#sizes.editorH + 6)}px`;
      // The map's Live button (at its foot's right end) stands on the strip and the drawing's bar rather than under them.
      const foot = this.rail.hidden && !sel ? 0 : over + (!sel ? 0 : this.#sizes.editorH + 6);
      if (foot) this.rail.parentElement?.style.setProperty('--draw-foot', `${foot}px`); else this.rail.parentElement?.style.removeProperty('--draw-foot');
    }
    const show = !!sel && editor !== 'none';
    this.editor.hidden = !show;
    if (show && !phone) { const [x, y] = editor.split(',').map(Number); this.editor.style.left = `${x}px`; this.editor.style.top = `${y}px`; }
    else if (phone) { this.editor.style.left = ''; this.editor.style.top = ''; }
  }

  /** The selected drawing's figures, written only when they changed. */
  #syncFigures(now: number): void {
    if (now - this.#figuresAt < FIGURES_EVERY_MS) return;
    this.#figuresAt = now;
    const sel = this.draw.get(this.draw.selected);
    const text = sel ? readout(sel, this.host.mark(), sel.kind === 'level' && !this.host.replaying() ? this.host.restingAt(sel.points[0]!.p) : null) : '';
    if (this.#figures.textContent !== text) this.#figures.textContent = text;
    this.#figures.hidden = !text;
  }

  /** The selected drawing's controls: built when another is selected, updated in place otherwise (a field being typed in keeps its focus). */
  #syncSelection(): void {
    const d = this.draw, sel = d.get(d.selected), key = sel && d.open ? `${sel.id}|${sel.kind}` : '';
    if (key !== this.#editFor) {
      this.#editFor = key; this.#syncEdit = [];
      this.#controls.replaceChildren();
      if (sel && d.open) this.#buildEdit(sel);
    }
    if (!key) this.editor.hidden = true;
    if (sel && key) for (const f of this.#syncEdit) f(sel);
  }

  #buildEdit(first: Drawing): void {
    const d = this.draw, id = first.id, p = this.host.palette();
    const set = (patch: Partial<Drawing>): void => d.update(id, patch);
    const swatches = el('div', { class: 'draw-swatches', role: 'group', ariaLabel: t('Colour') });
    for (const c of DRAW_COLORS) {
      const b = el('button', { type: 'button', class: 'draw-swatch', ariaLabel: colorName(c), tip: colorName(c) });
      b.style.setProperty('--swatch', colorOf(c, p));
      b.onclick = () => { const cur = d.get(id); if (cur) set({ style: { ...cur.style, color: c } }); };
      this.#syncEdit.push(x => { b.classList.toggle('on', x.style.color === c); b.setAttribute('aria-pressed', String(x.style.color === c)); b.style.setProperty('--swatch', colorOf(c, this.host.palette())); b.disabled = x.locked || d.readOnly; });
      swatches.append(b);
    }
    const widths = el('div', { class: 'seg draw-widths', role: 'group', ariaLabel: t('Line width') });
    for (const w of DRAW_WIDTHS) {
      const b = el('button', { type: 'button', textContent: String(w), ariaLabel: t('Line width {n} px', { n: String(w) }), tip: t('Line width {n} px', { n: String(w) }) });
      b.onclick = () => { const cur = d.get(id); if (cur) set({ style: { ...cur.style, width: w } }); };
      this.#syncEdit.push(x => { b.classList.toggle('on', x.style.width === w); b.disabled = x.locked || d.readOnly; });
      widths.append(b);
    }
    // A switch of the drawing's: pressed while it is on, and, but for Lock, not to be changed while the drawing is locked; none while nothing can change.
    const toggle = (name: GlyphName, label: string, tip: string, read: (x: Drawing) => boolean, write: (x: Drawing, on: boolean) => Partial<Drawing>, lockable = true): HTMLButtonElement => {
      const b = iconButton(name, label, tip);
      b.onclick = () => { const cur = d.get(id); if (cur) set(write(cur, !read(cur))); };
      this.#syncEdit.push(x => { b.classList.toggle('on', read(x)); b.setAttribute('aria-pressed', String(read(x))); b.disabled = (lockable && x.locked) || d.readOnly; });
      return b;
    };
    const controls: HTMLElement[] = [swatches, widths, toggle('dashed', t('Dashed'), t('A dashed line'), x => x.style.dashed, (x, on) => ({ style: { ...x.style, dashed: on } }))];
    if (first.kind === 'level') controls.push(toggle('ray', t('Ray'), t('From its point to the right only, rather than across the whole map'), x => !x.extendLeft, (_x, on) => ({ extendLeft: !on })));
    if (first.kind === 'trend' || first.kind === 'channel') controls.push(
      toggle('left', t('Extend left'), t('Run the line on to the left edge of the map'), x => x.extendLeft, (_x, on) => ({ extendLeft: on })),
      toggle('right', t('Extend right'), t('Run the line on to the right edge of the map'), x => x.extendRight, (_x, on) => ({ extendRight: on })));
    if (first.kind === 'zone' || first.kind === 'fib') controls.push(toggle('right', t('Extend right'), t('Run it on to the right edge of the map'), x => x.extendRight, (_x, on) => ({ extendRight: on })));
    if (first.kind === 'note') controls.push(toggle('leader', t('Leader'), t('A line from the note to the point it is about'), x => x.leader, (_x, on) => ({ leader: on })));
    // The text: a note's words, or the label of any other kind; kept when the field is left or Enter is pressed (Esc puts it back).
    const text = el('input', { type: 'text', class: 'draw-text', maxLength: 500, placeholder: first.kind === 'note' ? t('Note') : t('Label'), ariaLabel: first.kind === 'note' ? t('Note') : t('Label') });
    const keep = (): void => { const cur = d.get(id); if (cur && cur.text !== text.value) set({ text: text.value }); };
    text.onchange = keep;
    text.onkeydown = e => { if (e.key === 'Enter') { keep(); text.blur(); } else if (e.key === 'Escape') { text.value = d.get(id)?.text ?? ''; text.blur(); } e.stopPropagation(); };
    this.#syncEdit.push(x => { if (document.activeElement !== text) text.value = x.text; text.disabled = x.locked || d.readOnly; });
    controls.push(text);
    if (first.kind === 'level') controls.push(toggle('bell', t('Alert'), t('Sound when the price reaches this level (through Sound, which must be on)'), x => x.alert, (_x, on) => ({ alert: on })));
    if (first.kind === 'level' || first.kind === 'zone') {
      const inspect = iconButton('inspect', t('Inspect'), first.kind === 'zone' ? t('Inspect: add up what traded in this zone (the Range tool)') : t('Inspect: add up what traded at this level\'s row over the time on the map (the Range tool)'));
      inspect.onclick = () => d.inspect(id);
      controls.push(inspect);
    }
    controls.push(toggle('lock', t('Lock'), t('Locked: it cannot be moved, changed or deleted until unlocked'), x => x.locked, (_x, on) => ({ locked: on }), false));
    const copy = iconButton('copy', t('Copy'), t('A copy of this drawing, a little to the right'));
    copy.onclick = () => d.duplicate(id);
    const remove = iconButton('trash', t('Delete'), t('Delete this drawing (Delete key)'), 'draw-icon danger');
    remove.onclick = () => d.remove(id);
    this.#syncEdit.push(x => { copy.disabled = d.readOnly; remove.disabled = x.locked || d.readOnly; });
    controls.push(copy, remove);
    this.#controls.append(...controls);
  }

  #openPanel(): void {
    this.#armedDelete = false;
    this.#panel = togglePanel(this.#listButton, { title: t('Drawings'), width: 400, align: 'left', stays: true, onClose: () => { this.#panel = null; } }, (tools, body) => this.#buildPanel(tools, body));
  }

  #buildPanel(_tools: HTMLElement, body: HTMLElement): void {
    const d = this.draw, s = this.host.settings();
    body.append(heading(t('Magnet')),
      segmented(MAGNET_MODES.map(m => [m, magnetWord(m)] as [string, string]), s.magnet, v => this.host.setSettings({ magnet: v as MagnetMode })),
      note(t('Weak lands a point on the open, high, low or close of the candle under the pointer within 8 px (14 with a finger), Strong within 20 (28). Alt held places freely.')),
      switchRow(t('Snap to liquidity walls'), t('The magnet also lands on walls of resting liquidity: rows of the heat map holding three times what their column does around them.'), s.walls, on => this.host.setSettings({ walls: on })),
      switchRow(t('Keep the tool'), t('A tool stays armed after each drawing, for several in a row (Esc puts it away).'), s.keep, on => this.host.setSettings({ keep: on })),
      switchRow(t('Show drawings'), t('Draw them on the map. Hidden, they are kept as they are.'), s.shown, on => this.host.setSettings({ shown: on })),
      switchRow(t('Lock all'), t('Nothing can be added, moved, changed or deleted until unlocked.'), s.locked, on => this.host.setSettings({ locked: on })));
    const list = [...d.list()].reverse();
    body.append(heading(tn(list.length, 'This coin: {n} drawing', 'This coin: {n} drawings')));
    if (!list.length) body.append(note(t('None yet. Pick a tool in the rail, then click on the map.')));
    const rows = el('div', { class: 'draw-list' });
    for (const x of list) {
      const name = el('button', { type: 'button', class: 'draw-list-name' + (x.id === d.selected ? ' on' : ''), textContent: describe(x), tip: t('Select it and show it on the map') });
      name.onclick = () => d.find(x.id);
      const eye = iconButton(x.hidden ? 'eyeOff' : 'eye', x.hidden ? t('Show it on the map') : t('Hide it from the map'), x.hidden ? t('Hidden: show it on the map again') : t('Shown: hide it from the map, keeping it'), 'draw-icon draw-action');
      eye.onclick = () => d.update(x.id, { hidden: !x.hidden }); eye.disabled = d.readOnly;
      const lock = el('button', { type: 'button', class: 'draw-action', textContent: x.locked ? t('Unlock') : t('Lock'), disabled: d.readOnly, onclick: () => d.update(x.id, { locked: !x.locked }) });
      const del = el('button', { type: 'button', class: 'draw-action danger', textContent: t('Delete'), disabled: x.locked || d.readOnly, onclick: () => d.remove(x.id) });
      const swatch = el('i', { class: 'draw-list-swatch' }); swatch.style.background = colorOf(x.style.color, this.host.palette());
      rows.append(el('div', { class: 'draw-list-row' + (x.hidden ? ' hidden-one' : '') }, swatch, name, eye, lock, del));
    }
    body.append(rows);
    const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    file.onchange = () => {
      const f = file.files?.[0]; if (!f) return;
      if (f.size > MAX_IMPORT_CHARS) { d.message = { text: t('That file is too large to be drawings from this page.'), warn: true }; this.sync(); file.value = ''; return; }
      void f.text().then(text => {
        const before = d.message, said = d.importText(text), after = d.message, failed = after && after !== before && after.warn ? after.text : '';
        d.message = { text: failed ? `${said} ${failed}` : said, warn: !!failed || d.readOnly }; this.sync();
      });
      file.value = '';
    };
    const save = button(t('Save to a file'), () => { const url = URL.createObjectURL(new Blob([d.exportText()], { type: 'application/json' })); el('a', { href: url, download: 'liquiditymapperfast-drawings.json' }).click(); window.setTimeout(() => URL.revokeObjectURL(url), 10_000); }, t('Every coin\'s drawings, in a file to keep or to read on another computer'));
    const open = button(t('Read a file'), () => file.click(), t('Add the drawings of a file saved here before; nothing held is replaced'));
    const all = button(this.#armedDelete ? t('Press again to delete them') : t('Delete all'), () => { if (this.#armedDelete) { this.#armedDelete = false; d.removeAll(); } else { this.#armedDelete = true; this.sync(); } }, t('Delete this coin\'s drawings that are not locked (Undo takes it back)'), 'danger');
    body.append(el('div', { class: 'draw-files' }, save, open, all, file));
    body.append(note(t('Drawings are kept in this browser, each coin\'s apart, whatever the market and timeframe; layouts do not hold them.')));
  }
}
