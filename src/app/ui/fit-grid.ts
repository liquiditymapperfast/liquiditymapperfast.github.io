/**
 * The fit grid: how a header lays out its controls at any width, from one rule instead of breakpoints.
 *
 * A header has an identity line (the grip, the name, the "?", a settings key, the menu and the close button) and a set of cells (a caption
 * with its select, or a button), in their order. Each cell's natural width is measured; then:
 *
 *  1. When every cell fits on the identity line beside it, the header is that one line. Otherwise the cells marked as the line's own
 *     (`data-fit="lead"`, the first ones: the Book's Mode) go there when they fit, all of them or none, and the others take a grid under it.
 *     Which cells sit on the line therefore changes at two widths at most, not with every few pixels.
 *  2. In the grid a cell that asks for a whole row (`data-fit="row"`: a strip of buttons) gets one; the others are laid out row by row in
 *     `c` aligned columns, each as wide as its widest cell. Every cell keeps its own width (nothing is stretched: a button is as wide as its
 *     label), the rows start at the left edge and a short row simply ends sooner.
 *  3. The fewest rows win, and the columns are as even as those rows allow (`c` = the cells over the rows, rounded up), so the column count
 *     changes only when the number of rows does: six cells go 6, then 3 + 3, then 2 + 2 + 2.
 *  4. A caption and its control (`cap`: the caption's width, the gap, the control's) are laid out within their column: the captions of a
 *     column as wide as its widest, so the controls under one another start at the same place, unless that costs a row.
 *
 * A new control is one more cell: the rule places it, with no new breakpoint.
 */

/**
 * One cell to place: its natural width (px), whether it takes a whole row of its own when it cannot sit on the identity line, whether it
 * belongs on the identity line (`lead`, only the first cells) and its caption, gap and control widths.
 */
export interface FitCell { width: number; row?: boolean; lead?: boolean; cap?: { caption: number; gap: number; control: number } }
/**
 * The layout chosen: the first `lead` cells on the identity line (`inline`: all of them), the others in a grid of `cols` columns and `rows`
 * rows (the identity line not counted); each cell's column span (row cells span all; any other cell 1) and the width its caption takes (0:
 * as its own).
 */
export interface FitChoice { lead: number; inline: boolean; cols: number; rows: number; spans: number[]; caps: number[] }

/** The columns of a grid of `cells` in `cols` columns (their widths and each cell's caption width), with the captions aligned when `withCaps`. */
function columns(cells: readonly FitCell[], runs: readonly number[][], cols: number, withCaps: boolean): { widths: number[]; caps: number[] } {
  const widths = new Array<number>(cols).fill(0), capW = new Array<number>(cols).fill(0), ctlW = new Array<number>(cols).fill(0), capGap = new Array<number>(cols).fill(0);
  const colOf = new Map<number, number>();
  for (const run of runs) run.forEach((i, k) => colOf.set(i, k % cols));
  for (const [i, col] of colOf) {
    const c = cells[i]!;
    widths[col] = Math.max(widths[col]!, c.width);
    if (withCaps && c.cap) { capW[col] = Math.max(capW[col]!, c.cap.caption); capGap[col] = Math.max(capGap[col]!, c.cap.gap); ctlW[col] = Math.max(ctlW[col]!, c.cap.control); }
  }
  // A column with captioned controls needs its widest caption beside its widest control, which may be more than its widest cell.
  for (let col = 0; col < cols; col++) if (capW[col]) widths[col] = Math.max(widths[col]!, capW[col]! + capGap[col]! + ctlW[col]!);
  const caps = cells.map((c, i) => (withCaps && c.cap && colOf.has(i) ? capW[colOf.get(i)!]! : 0));
  return { widths, caps };
}

/**
 * The grid for `cells` in `avail` px (none of them on the identity line): the most columns that fit, of the counts that share the cells
 * out evenly over their rows, with the captions aligned when that fits as well. One column always fits (a cell wider than it shrinks).
 */
function gridOf(cells: readonly FitCell[], avail: number, gap: number): Omit<FitChoice, 'lead' | 'inline'> {
  const n = cells.length, rowCells = cells.filter(c => c.row).length;
  // The runs of plain cells between row cells (indices into `cells`): each starts on a row of its own.
  const runs: number[][] = [[]];
  cells.forEach((c, i) => { if (c.row) runs.push([]); else runs[runs.length - 1]!.push(i); });
  const filled = runs.filter(r => r.length), longest = Math.max(0, ...filled.map(r => r.length));
  const spans = (cols: number): number[] => cells.map(c => (c.row ? cols : 1));
  if (!longest) return { cols: 1, rows: rowCells, spans: spans(1), caps: cells.map(() => 0) };
  for (let cols = longest; cols >= 1; cols--) {
    // Only an even count: 6 cells in 4 columns take two rows as 3 columns do, with a short second row.
    if (Math.ceil(longest / Math.ceil(longest / cols)) !== cols) continue;
    const rows = filled.reduce((s, r) => s + Math.ceil(r.length / cols), 0) + rowCells;
    for (const withCaps of [true, false]) {
      const { widths, caps } = columns(cells, filled, cols, withCaps);
      if (cols > 1 && widths.reduce((s, w) => s + w, 0) + gap * (cols - 1) > avail) continue;
      if (cols === 1 && withCaps && widths[0]! > avail) continue;
      return { cols, rows, spans: spans(cols), caps };
    }
  }
  return { cols: 1, rows: filled.reduce((s, r) => s + r.length, 0) + rowCells, spans: spans(1), caps: cells.map(() => 0) };
}

/**
 * The layout for `cells` given the grid's width `avail`, the gap between cells and, where the header has one, the room left on its identity
 * line (`inlineAvail`, null: none) and the gap between cells there (`lineGap`).
 */
export function chooseFit(cells: readonly FitCell[], avail: number, gap: number, inlineAvail: number | null = null, lineGap = gap): FitChoice {
  const n = cells.length;
  if (!n) return { lead: 0, inline: false, cols: 1, rows: 0, spans: [], caps: [] };
  const own = cells.findIndex(c => !c.lead), leads = own < 0 ? n : own;
  // Every cell on the line, then the line's own cells, then none: the first that fits.
  const options = inlineAvail === null ? [0] : [...new Set([n, leads, 0])];
  for (const lead of options) {
    const along = lead ? cells.slice(0, lead).reduce((s, c) => s + c.width, 0) + lineGap * (lead - 1) : 0;
    if (lead && along > inlineAvail!) continue;
    const rest = cells.slice(lead);
    const grid = rest.length ? gridOf(rest, avail, gap) : { cols: 1, rows: 0, spans: [], caps: [] };
    return { lead, inline: lead === n, cols: grid.cols, rows: grid.rows, spans: [...new Array<number>(lead).fill(1), ...grid.spans], caps: [...new Array<number>(lead).fill(0), ...grid.caps] };
  }
  return { lead: 0, inline: false, cols: 1, rows: 0, spans: [], caps: [] };
}

/** Two choices that lay the cells out the same way. */
export const sameFit = (a: FitChoice | null, b: FitChoice | null): boolean =>
  !!a && !!b && a.lead === b.lead && a.cols === b.cols && a.spans.join() === b.spans.join() && a.caps.join() === b.caps.join();

/** A width change smaller than this keeps the layout as it is (a select's text changing must not flip the rows back and forth). */
const REFIT_PX = 4;

/**
 * The rule applied to a header (`head`) on the desktop arrangement: `cells` is the element holding its cells (on a phone it is
 * `display: contents`, and the header keeps the layout it has there). The identity line is every other visible child of the header; the cells
 * that join it are moved out of `cells` into the header (class `fit-lead`), each leaving a mark where it was, and put back from there when
 * they no longer fit or on a phone. The layout is chosen again when `watch` (the pane, whose width the header follows) changes width by more
 * than a few pixels, when a cell appears, goes or changes its text, and when the fonts have loaded.
 */
export class FitGrid {
  #choice: FitChoice | null = null;
  #width = -1;
  #signature = '';
  /** The cells the layout was applied to, in their order. */
  #placed: HTMLElement[] = [];
  /** The cells on the identity line, in their order, each with the mark it left in `cells`. */
  #leads: { cell: HTMLElement; mark: Comment }[] = [];
  readonly #changes: MutationObserver;
  readonly #observers: { disconnect(): void }[] = [];
  #gone = false;

  constructor(private readonly head: HTMLElement, readonly cells: HTMLElement, watch: HTMLElement = head) {
    cells.classList.add('fit-cells');
    const resize = new ResizeObserver(() => this.refit());
    resize.observe(watch);
    // A change inside a cell or the name is measured again whatever the width (a select's choices, a caption's text, a cell shown or hidden);
    // other changes in the header (a readout's figures) are not the layout's.
    this.#changes = new MutationObserver(records => { if (records.some(r => this.#changed(r) && this.#concerns(r.target))) this.refit(false, true); });
    // The whole header: a cell on the identity line is no longer inside `cells`. What this class changes itself is taken back (#quiet).
    this.#changes.observe(head, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'], attributeOldValue: true, characterData: true, characterDataOldValue: true });
    // The arrangement (desktop or phone), the frame and theme (their faces and sizes) and the language are attributes of the root element.
    this.#changes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-layout', 'data-frame', 'data-theme', 'lang'] });
    const fonts = (): void => { if (!this.#gone) this.refit(false, true); };
    document.fonts?.addEventListener?.('loadingdone', fonts);
    this.#observers.push({ disconnect: () => document.fonts?.removeEventListener?.('loadingdone', fonts) });
    this.#observers.push(resize, this.#changes);
    void document.fonts?.ready.then(() => { if (!this.#gone) this.refit(true); });
  }

  /** The layout in use (null on a phone, or before the first fit), for tests. */
  get choice(): FitChoice | null { return this.#choice; }

  /** Every cell in its order, the ones on the identity line first (they are always the first ones), and whether each is shown. */
  #all(): HTMLElement[] {
    return [...this.#leads.map(l => l.cell), ...[...this.cells.children].filter((c): c is HTMLElement => c instanceof HTMLElement)];
  }

  static #visible(c: HTMLElement): boolean { return !c.hidden && getComputedStyle(c).display !== 'none'; }

  /** Whether a record changed anything: a pane sets an attribute or a text to what it already was (the Books button's `hidden`, several times a second). */
  #changed(r: MutationRecord): boolean {
    if (r.type === 'attributes') return (r.target as Element).getAttribute(r.attributeName!) !== r.oldValue;
    if (r.type === 'characterData') return r.target.nodeValue !== r.oldValue;
    return true;
  }

  /** Whether a change at `node` can change the layout: the root element, the header itself, its name, or anything in a cell. */
  #concerns(node: Node): boolean {
    if (node === document.documentElement || node === this.head || node === this.cells) return true;
    const el = node instanceof Element ? node : node.parentElement;
    if (!el) return false;
    if (el.closest('strong') && this.head.contains(el)) return true;
    return this.#all().some(c => c.contains(el));
  }

  /** Takes back the records of this class's own changes, so that they do not choose the layout again. */
  #quiet(): void { this.#changes.takeRecords(); }

  /**
   * Chooses the layout again: on a width change of more than a few pixels, on any change `measure` says the cells or the name had (measured
   * again whatever the width), or always (`force`).
   */
  refit(force = false, measure = false): void {
    const desktop = document.documentElement.dataset.layout === 'desktop';
    if (!desktop) { this.#clear(); return; }
    const width = this.head.clientWidth, all = this.#all(), shown = all.filter(FitGrid.#visible);
    const signature = all.map(c => `${c.tagName}:${FitGrid.#visible(c) ? 1 : 0}:${c.textContent?.length ?? 0}`).join('|');
    if (!force && !measure && this.#choice && signature === this.#signature && Math.abs(width - this.#width) <= REFIT_PX) return;
    this.#signature = signature; this.#width = width;
    // Natural widths: the cells on the identity line where they are (at their own width), the others side by side at their own size, out of
    // the header's flow for the moment of measuring.
    this.cells.classList.add('fit-measuring'); this.head.classList.add('fit-measuring-lead');
    const widths = shown.map(c => Math.ceil(c.getBoundingClientRect().width));
    // A caption and its control: a label whose last child is its select (the caption is the text before it).
    const caps = shown.map((c, i) => {
      const control = c.tagName === 'LABEL' ? c.lastElementChild : null;
      if (!(control instanceof HTMLElement)) return undefined;
      const w = Math.ceil(control.getBoundingClientRect().width), gap = parseFloat(getComputedStyle(c).columnGap) || 0;
      return { caption: Math.max(0, widths[i]! - w - gap), gap, control: w };
    });
    this.cells.classList.remove('fit-measuring'); this.head.classList.remove('fit-measuring-lead');
    this.#quiet();
    const style = getComputedStyle(this.head), gap = parseFloat(style.columnGap) || 0;
    const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0), inner = width - pad;
    const cellGap = parseFloat(getComputedStyle(this.cells).columnGap) || gap;
    // The identity line at its natural width: the header laid out for a moment as one line as wide as its content, without the cells, the
    // cells already on the line or the break (every margin, gap and the name's whole text counted, an `auto` margin as nothing).
    this.head.classList.add('fit-measuring-line');
    const line = this.head.clientWidth - pad;
    this.head.classList.remove('fit-measuring-line');
    this.#quiet();
    // The room left beside it, with the gap before the first cell there.
    const room = Math.max(0, inner - line - gap);
    const choice = chooseFit(shown.map((c, i) => ({ width: widths[i]!, row: c.dataset.fit === 'row', lead: c.dataset.fit === 'lead', ...(caps[i] ? { cap: caps[i] } : {}) })), inner, cellGap, room, gap);
    const sameCells = shown.length === this.#placed.length && shown.every((c, i) => c === this.#placed[i]);
    if (sameFit(choice, this.#choice) && sameCells && !force) return;
    this.#choice = choice; this.#placed = shown;
    // The cells on the identity line: the first `lead` shown ones, with any hidden cell among them (a hidden cell stays where its neighbours are).
    const lastLead = choice.lead ? all.indexOf(shown[choice.lead - 1]!) : -1;
    this.#place(all.slice(0, lastLead + 1));
    this.head.classList.toggle('fit-inline', choice.inline);
    this.head.classList.toggle('fit-has-lead', choice.lead > 0);
    // Columns as wide as their contents and no wider (a cell that no longer fits shrinks rather than spill past the header's edge), each cell
    // in its column; where a cell takes a whole row, one more column takes up the rest of the width, so that the row reaches the right edge.
    const grid = shown.slice(choice.lead), whole = grid.some(c => c.dataset.fit === 'row'), tracks = [`repeat(${choice.cols}, minmax(0, max-content))`];
    if (whole) tracks.push(`minmax(0, 1fr)`);
    this.cells.style.gridTemplateColumns = tracks.join(' ');
    let col = 0;
    shown.forEach((c, i) => {
      const cap = choice.caps[i]!;
      if (i < choice.lead) c.style.removeProperty('grid-column');
      else if (c.dataset.fit === 'row') { c.style.gridColumn = '1 / -1'; col = 0; }
      else { c.style.gridColumn = String(col + 1); col = (col + 1) % choice.cols; }
      if (cap) c.style.setProperty('--fit-cap', `${cap}px`); else c.style.removeProperty('--fit-cap');
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
    this.#choice = null; this.#width = -1; this.#signature = ''; this.#placed = [];
    this.#place([]);
    this.head.classList.remove('fit-inline', 'fit-has-lead');
    this.cells.style.removeProperty('grid-template-columns');
    for (const c of this.cells.children) if (c instanceof HTMLElement) { c.style.removeProperty('grid-column'); c.style.removeProperty('--fit-cap'); }
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
