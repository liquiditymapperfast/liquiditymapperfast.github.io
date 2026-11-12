/**
 * The fit grid: how a header lays out its controls at any width, from one rule instead of breakpoints.
 *
 * A row reads as ordered when what is in it is alike: the same width, the same height, the same make-up. Controls of different shapes (a
 * short caption over a wide list, a long caption over a short one, buttons of two lengths) can only fill a row by being stretched unevenly,
 * or keep their own widths and leave holes (Karl, 2026-11-02, after both). So a header is made of two kinds of thing that are each alike:
 *
 *  - Keys (`data-fit="key"`: square buttons with a drawn mark, such as the Book's recentre) sit on the identity line, at its right end beside
 *    the menu and the close button. They are children of the header, not cells.
 *  - Cells (a caption with its select, or a strip of buttons) are laid out by this rule:
 *
 *  1. When every cell fits on the identity line beside the name, the header is that one line. Otherwise the cells marked as the line's own
 *     (`data-fit="lead"`, the first ones: the Book's Mode) go there when they fit, all of them or none, and the others take a grid under it.
 *     A lead cell that does not fit takes a whole row of the grid.
 *  2. In the grid a cell that asks for a whole row (`data-fit="row"`: a strip of buttons) gets one. Every other cell is a tile, its caption
 *     above its select: all tiles are as wide as each other, `c` to a row, filling the row from edge to edge.
 *  3. `c` is as many tiles as fit at the widest tile's own width (the wider of its caption and its select), shared out evenly over the rows
 *     that takes (`c` = the tiles over the rows, rounded up): four tiles go 4, then 2 + 2, then 1 + 1 + 1 + 1.
 *
 * A new choice is one more tile, a new action one more key: the rule places it, with no new breakpoint.
 */

/**
 * One cell to place: its width beside the name (px; a caption beside its select), its width as a tile (the wider of its caption and its
 * select; its own width when it has no caption), whether it takes a whole row of its own and whether it belongs on the identity line
 * (`lead`, only the first cells).
 */
export interface FitCell { width: number; tile?: number; row?: boolean; lead?: boolean }
/**
 * The layout chosen: the first `lead` cells on the identity line (`inline`: all of them), the others in a grid of `cols` tiles to a row and
 * `rows` rows (the identity line not counted), and each cell's span (a cell taking a whole row spans `cols`; a cell on the identity line and a
 * tile 1).
 */
export interface FitChoice { lead: number; inline: boolean; cols: number; rows: number; spans: number[] }

/** The grid for `cells` in `avail` px (none of them on the identity line). One tile to a row always fits (a tile wider than it shrinks). */
function gridOf(cells: readonly FitCell[], avail: number, gap: number): Omit<FitChoice, 'lead' | 'inline'> {
  const whole = (c: FitCell): boolean => !!(c.row || c.lead);
  // The runs of tiles between whole-row cells: each starts on a row of its own.
  const runs: number[] = [0];
  for (const c of cells) { if (whole(c)) runs.push(0); else runs[runs.length - 1]! += 1; }
  const filled = runs.filter(n => n > 0), longest = Math.max(0, ...filled), rowCells = cells.filter(whole).length;
  let cols = 1;
  if (longest) {
    const widest = Math.max(...cells.filter(c => !whole(c)).map(c => c.tile ?? c.width));
    cols = Math.max(1, Math.min(longest, Math.floor((avail + gap) / (widest + gap))));
    // Shared out evenly: 4 tiles that fit 3 to a row go 2 + 2, not 3 + 1.
    cols = Math.ceil(longest / Math.ceil(longest / cols));
  }
  const rows = filled.reduce((s, n) => s + Math.ceil(n / cols), 0) + rowCells;
  return { cols, rows, spans: cells.map(c => (whole(c) ? cols : 1)) };
}

/**
 * The layout for `cells` given the grid's width `avail`, the gap between tiles and, where the header has one, the room left on its identity
 * line (`inlineAvail`, null: none) and the gap between cells there (`lineGap`).
 */
export function chooseFit(cells: readonly FitCell[], avail: number, gap: number, inlineAvail: number | null = null, lineGap = gap): FitChoice {
  const n = cells.length;
  // Nothing to place (every cell hidden: the flow column's Time & sales view) is the identity line alone, with no empty grid line under it.
  if (!n) return { lead: 0, inline: true, cols: 1, rows: 0, spans: [] };
  const own = cells.findIndex(c => !c.lead), leads = own < 0 ? n : own;
  // Every cell on the line, then the line's own cells, then none: the first that fits.
  const options = inlineAvail === null ? [0] : [...new Set([n, leads, 0])];
  for (const lead of options) {
    const along = lead ? cells.slice(0, lead).reduce((s, c) => s + c.width, 0) + lineGap * (lead - 1) : 0;
    if (lead && along > inlineAvail!) continue;
    const grid = lead < n ? gridOf(cells.slice(lead), avail, gap) : { cols: 1, rows: 0, spans: [] };
    return { lead, inline: lead === n, cols: grid.cols, rows: grid.rows, spans: [...new Array<number>(lead).fill(1), ...grid.spans] };
  }
  return { lead: 0, inline: false, cols: 1, rows: 0, spans: [] };
}

/** Two choices that lay the cells out the same way. */
export const sameFit = (a: FitChoice | null, b: FitChoice | null): boolean =>
  !!a && !!b && a.lead === b.lead && a.cols === b.cols && a.spans.join() === b.spans.join();

/** A width change smaller than this keeps the layout as it is (a select's text changing must not flip the rows back and forth). */
const REFIT_PX = 4;

/**
 * The rule applied to a header (`head`) on the desktop arrangement: `cells` is the element holding its cells (on a phone it is
 * `display: contents`, and the header keeps the layout it has there). The identity line is every other visible child of the header, its keys
 * among them; the cells that join it are moved out of `cells` into the header (class `fit-lead`), each leaving a mark where it was, and put back
 * from there when they no longer fit or on a phone. The layout is chosen again when `watch` (the pane, whose width the header follows) changes
 * width by more than a few pixels, when a cell or a key appears, goes or changes its text, and when the fonts have loaded.
 */
export class FitGrid {
  #choice: FitChoice | null = null;
  #width = -1;
  #signature = '';
  /** The cells the layout was applied to, in their order. */
  #placed: HTMLElement[] = [];
  /** Their roles (`data-fit`) when it was applied. */
  #roles = '';
  /** The cells on the identity line, in their order, each with the mark it left in `cells`. */
  #leads: { cell: HTMLElement; mark: Comment }[] = [];
  readonly #changes: MutationObserver;
  readonly #observers: { disconnect(): void }[] = [];
  #gone = false;

  constructor(private readonly head: HTMLElement, readonly cells: HTMLElement, watch: HTMLElement = head) {
    cells.classList.add('fit-cells');
    const resize = new ResizeObserver(() => this.refit());
    resize.observe(watch);
    // A change inside a cell, a key or the name is measured again whatever the width (a select's choices, a caption's text, a cell or a key
    // shown or hidden); other changes in the header (a readout's figures) are not the layout's.
    this.#changes = new MutationObserver(records => { if (records.some(r => this.#changed(r) && this.#concerns(r.target))) this.refit(false, true); });
    // The whole header: a cell on the identity line is no longer inside `cells`. What this class changes itself is taken back (#quiet).
    this.#changes.observe(head, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'data-fit'], attributeOldValue: true, characterData: true, characterDataOldValue: true });
    // The arrangement (desktop or phone), the bar, the frame and theme (their faces and sizes) and the language are attributes of the root element.
    this.#changes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-layout', 'data-bar', 'data-frame', 'data-theme', 'lang'] });
    const fonts = (): void => { if (!this.#gone) this.refit(false, true); };
    document.fonts?.addEventListener?.('loadingdone', fonts);
    this.#observers.push({ disconnect: () => document.fonts?.removeEventListener?.('loadingdone', fonts) });
    // A mouse and a finger draw the controls at different sizes (a touch screen's are taller) at the same width: measured again when it changes.
    const pointer = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
    const repoint = (): void => { if (!this.#gone) this.refit(false, true); };
    pointer?.addEventListener?.('change', repoint);
    this.#observers.push({ disconnect: () => pointer?.removeEventListener?.('change', repoint) });
    this.#observers.push(resize, this.#changes);
    void document.fonts?.ready.then(() => { if (!this.#gone) this.refit(true); });
  }

  /** The layout in use (null on a phone, or before the first fit), for tests. */
  get choice(): FitChoice | null { return this.#choice; }

  /** Every cell in its order, the ones on the identity line first (they are always the first ones), and whether each is shown. */
  #all(): HTMLElement[] {
    return [...this.#leads.map(l => l.cell), ...[...this.cells.children].filter((c): c is HTMLElement => c instanceof HTMLElement)];
  }

  /** The keys on the identity line (the header's own children): how many are shown changes the room left there. */
  #keys(): HTMLElement[] {
    return [...this.head.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.fit === 'key');
  }

  static #visible(c: HTMLElement): boolean { return !c.hidden && getComputedStyle(c).display !== 'none'; }

  /** Whether a record changed anything: a pane sets an attribute or a text to what it already was (the Books key's `hidden`, several times a second). */
  #changed(r: MutationRecord): boolean {
    if (r.type === 'attributes') return (r.target as Element).getAttribute(r.attributeName!) !== r.oldValue;
    if (r.type === 'characterData') return r.target.nodeValue !== r.oldValue;
    return true;
  }

  /** Whether a change at `node` can change the layout: the root element, the header itself, its name, a key, or anything in a cell. */
  #concerns(node: Node): boolean {
    if (node === document.documentElement || node === this.head || node === this.cells) return true;
    const el = node instanceof Element ? node : node.parentElement;
    if (!el) return false;
    if (el.closest('strong') && this.head.contains(el)) return true;
    return [...this.#all(), ...this.#keys()].some(c => c.contains(el));
  }

  /** Takes back the records of this class's own changes, so that they do not choose the layout again. */
  #quiet(): void { this.#changes.takeRecords(); }

  /**
   * Chooses the layout again: on a width change of more than a few pixels, on any change `measure` says the cells, the keys or the name had
   * (measured again whatever the width), or always (`force`).
   */
  refit(force = false, measure = false): void {
    const desktop = document.documentElement.dataset.layout === 'desktop';
    if (!desktop) { this.#clear(); return; }
    const width = this.head.clientWidth, all = this.#all(), shown = all.filter(FitGrid.#visible);
    const signature = [...all, ...this.#keys()].map(c => `${c.tagName}:${FitGrid.#visible(c) ? 1 : 0}:${c.textContent?.length ?? 0}:${c.dataset.fit ?? ''}`).join('|');
    if (!force && !measure && this.#choice && signature === this.#signature && Math.abs(width - this.#width) <= REFIT_PX) return;
    this.#signature = signature; this.#width = width;
    // Natural widths: the cells on the identity line where they are (at their own width), the others side by side at their own size, out of
    // the header's flow for the moment of measuring; a caption beside its select, so its width as a tile is the wider of the two.
    this.cells.classList.add('fit-measuring'); this.head.classList.add('fit-measuring-lead');
    const widths = shown.map(c => Math.ceil(c.getBoundingClientRect().width));
    const tiles = shown.map((c, i) => {
      const control = c.tagName === 'LABEL' ? c.lastElementChild : null;
      if (!(control instanceof HTMLElement)) return widths[i]!;
      const w = Math.ceil(control.getBoundingClientRect().width), gap = parseFloat(getComputedStyle(c).columnGap) || 0;
      return Math.max(w, widths[i]! - w - gap);
    });
    // The keys as tall as the selects (each frame and a touch screen draw these at their own height), square.
    const select = shown.map(c => c.querySelector('select')).find(s => s !== null)?.getBoundingClientRect().height ?? 0;
    if (select > 0) {
      const key = `${Math.round(select)}px`;
      if (this.head.style.getPropertyValue('--head-key') !== key) this.head.style.setProperty('--head-key', key);
    }
    this.cells.classList.remove('fit-measuring'); this.head.classList.remove('fit-measuring-lead');
    this.#quiet();
    const style = getComputedStyle(this.head), gap = parseFloat(style.columnGap) || 0;
    const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0), inner = width - pad;
    const cellGap = parseFloat(getComputedStyle(this.cells).columnGap) || gap;
    // The identity line at its natural width: the header laid out for a moment as one line as wide as its content (its keys among it), without
    // the cells, the cells already on the line or the break (every margin, gap and the name's whole text counted, an `auto` margin as nothing).
    this.head.classList.add('fit-measuring-line');
    const line = this.head.clientWidth - pad;
    this.head.classList.remove('fit-measuring-line');
    this.#quiet();
    // Where the name and the keys do not fit on one line (a long name in a narrow column), the keys take a short row of their own under it,
    // at its right end, rather than cut the name.
    this.head.classList.toggle('fit-keys-below', line > inner + 0.5 && this.#keys().some(FitGrid.#visible));
    this.#quiet();
    // The room left beside it, with the gap before the first cell there.
    const room = Math.max(0, inner - line - gap);
    const choice = chooseFit(shown.map((c, i) => ({ width: widths[i]!, tile: tiles[i]!, row: c.dataset.fit === 'row', lead: c.dataset.fit === 'lead' })), inner, cellGap, room, gap);
    // The same cells in the same roles (a cell that now takes a whole row is placed differently in an otherwise equal choice).
    const roles = shown.map(c => c.dataset.fit ?? '').join('|');
    const sameCells = shown.length === this.#placed.length && shown.every((c, i) => c === this.#placed[i]) && roles === this.#roles;
    if (sameFit(choice, this.#choice) && sameCells && !force) return;
    this.#choice = choice; this.#placed = shown; this.#roles = roles;
    // The cells on the identity line: the first `lead` shown ones, with any hidden cell among them (a hidden cell stays where its neighbours are).
    const lastLead = choice.lead ? all.indexOf(shown[choice.lead - 1]!) : -1;
    this.#place(all.slice(0, lastLead + 1));
    this.head.classList.toggle('fit-inline', choice.inline);
    this.head.classList.toggle('fit-has-lead', choice.lead > 0);
    // Tiles as wide as each other, filling the row; a cell that takes a whole row (or a lead cell that did not fit beside the name) spans it.
    this.cells.style.gridTemplateColumns = `repeat(${choice.cols}, minmax(0, 1fr))`;
    shown.forEach((c, i) => {
      if (i >= choice.lead && choice.spans[i]! > 1) c.style.gridColumn = '1 / -1';
      else c.style.removeProperty('grid-column');
    });
    this.#quiet();
  }

  /** Puts `leads` (the first cells, in their order) on the identity line, and every other cell back in its place in `cells`. */
  #place(leads: readonly HTMLElement[]): void {
    const now = this.#leads.map(l => l.cell);
    if (now.length === leads.length && now.every((c, i) => c === leads[i])) return;
    for (const { cell, mark } of this.#leads.splice(0)) { cell.classList.remove('fit-lead'); mark.replaceWith(cell); }
    for (const cell of leads) {
      const mark = document.createComment('fit-lead');
      cell.replaceWith(mark);
      cell.classList.add('fit-lead');
      this.cells.before(cell);
      this.#leads.push({ cell, mark });
    }
  }

  #clear(): void {
    if (!this.#choice) return;
    this.#choice = null; this.#width = -1; this.#signature = ''; this.#placed = []; this.#roles = '';
    this.#place([]);
    this.head.classList.remove('fit-inline', 'fit-has-lead', 'fit-keys-below');
    this.head.style.removeProperty('--head-key');
    this.cells.style.removeProperty('grid-template-columns');
    for (const c of this.cells.children) if (c instanceof HTMLElement) c.style.removeProperty('grid-column');
    this.#quiet();
  }

  disconnect(): void { this.#gone = true; for (const o of this.#observers.splice(0)) o.disconnect(); }
}

/** Every way to give `spare` more columns to `k` controls, those giving them to the last controls first. */
function spreads(k: number, spare: number): number[][] {
  if (k === 1) return [[spare]];
  const out: number[][] = [];
  for (let last = spare; last >= 0; last--) for (const rest of spreads(k - 1, spare - last)) out.push([...rest, last]);
  return out;
}

/** The columns' widths for rows of controls of `widths` spanning `spans` columns each (a control wider than its columns widens the last). */
function columnsOf(widths: readonly (readonly number[])[], spans: readonly (readonly number[])[], n: number, gap: number): number[] {
  const cols = new Array<number>(n).fill(0);
  widths.forEach((r, i) => { let col = 0; r.forEach((w, j) => { if (spans[i]![j] === 1) cols[col] = Math.max(cols[col]!, w); col += spans[i]![j]!; }); });
  widths.forEach((r, i) => {
    let col = 0;
    r.forEach((w, j) => {
      const span = spans[i]![j]!;
      if (span > 1) { const room = cols.slice(col, col + span).reduce((s, c) => s + c, 0) + gap * (span - 1); if (w > room) cols[col + span - 1]! += w - room; }
      col += span;
    });
  });
  return cols;
}

/** Above this many ways to place the spans, the spare columns simply go to each row's last controls. */
const MAX_SPREADS = 4096;

/** How many ways `spreads(k, spare)` has (spare + k - 1 choose k - 1), counted only up to just past `cap`. */
function spreadCount(k: number, spare: number, cap: number): number {
  let n = 1;
  for (let i = 1; i < k; i++) { n = (n * (spare + i)) / i; if (n > cap) return cap + 1; }
  return Math.round(n);
}

/**
 * Rows of controls given as rows (a top-bar deck's): one grid of as many columns as the longest row has controls, each column as wide as the
 * widest control in it, a shorter row's spare columns given to whichever of its controls make the grid narrowest (to its last ones when that is
 * all the same). `widths` are the controls' own widths row by row; the result is each column's width, each control's span, the grid's width
 * and the width of its widest row laid out on its own (`natural`), which is what aligning the columns costs beyond.
 */
export function alignRows(widths: readonly (readonly number[])[], gap: number): { cols: number[]; spans: number[][]; width: number; natural: number } {
  const n = Math.max(1, ...widths.map(r => r.length));
  const natural = Math.max(0, ...widths.map(r => r.reduce((s, w) => s + w, 0) + gap * Math.max(0, r.length - 1)));
  // The ways are counted before any is made: rows of many controls would have millions.
  let count = 1;
  for (const r of widths) { count *= r.length ? spreadCount(r.length, n - r.length, MAX_SPREADS) : 1; if (count > MAX_SPREADS) break; }
  const lastFirst = (k: number, spare: number): number[] => { const s = new Array<number>(k).fill(1); for (let j = 0; j < spare && k; j++) s[k - 1 - (j % k)]! += 1; return s; };
  const options = count > MAX_SPREADS ? widths.map(r => [lastFirst(r.length, n - r.length)]) : widths.map(r => (r.length ? spreads(r.length, n - r.length).map(x => x.map(e => e + 1)) : [[]]));
  const total = (cols: number[]): number => cols.reduce((a, c) => a + c, 0) + gap * (n - 1);
  let best: { cols: number[]; spans: number[][]; width: number } | null = null;
  if (count > MAX_SPREADS) {
    const spans = options.map(o => o[0]!), cols = columnsOf(widths, spans, n, gap);
    best = { cols, spans, width: total(cols) };
  } else {
    for (let index = 0; index < count; index++) {
      let rest = index;
      const spans = options.map(o => { const pick = o[rest % o.length]!; rest = Math.floor(rest / o.length); return pick; });
      const cols = columnsOf(widths, spans, n, gap), width = total(cols);
      if (!best || width < best.width - 0.5) best = { cols, spans, width };
    }
  }
  return { ...best!, natural };
}
