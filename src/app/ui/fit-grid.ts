/**
 * The fit grid: how a header lays out its controls at any width, from one rule instead of breakpoints.
 *
 * A header has an identity line (the grip, the name, the "?", a settings key, the menu and the close button) and a set of cells (a caption
 * with its select, or a button), in their order. Each cell's natural width is measured; then:
 *
 *  1. The first cells that fit on the identity line beside it go there (all of them when they all fit: then the header is one line). That
 *     line is there anyway, so what it holds costs no row.
 *  2. The others take a grid of their own under it. A cell that asks for a whole row (`data-fit="row"`: a strip of buttons) gets one; the
 *     others are laid out row by row in `c` aligned columns, every column as wide as its widest cell and stretched so that each row ends flush
 *     at the right. A shorter last row's cells share the columns it leaves over (`span`), so no row has a hole at its end.
 *  3. A caption and its control (`cap`: the caption's width, the gap, the control's) are laid out within their column as the column's others
 *     are: the captions of a column as wide as its widest, so the controls under one another start at the same place, unless that costs a row.
 *  4. Where no column count saves as many rows (a column too narrow for two columns of the widest cells), the cells are packed instead:
 *     row by row in their order, as many as fit, each row stretched to end flush (`packed`), its columns not aligned with the next row's.
 *
 * Of every split between the line and the grid, and every column count that fits, the one with the lowest score is taken:
 *
 *   score = 10 per row under the identity line + 6 when the grid's last row of two or more columns holds a single cell
 *           + 5 x (how empty the grid's emptiest row would be without stretching) + 5 when packed
 *
 * so fewer rows win, a lone cell on the last row is avoided unless it costs another row, and of two equal layouts the evener one wins.
 * A new control is one more cell: the rule places it, with no new breakpoint.
 */

/** One cell to place: its natural width (px) and whether it takes a whole row of its own when it cannot sit on the identity line. */
export interface FitCell { width: number; row?: boolean; cap?: { caption: number; gap: number; control: number } }
/**
 * The layout chosen: the first `lead` cells on the identity line (`inline`: all of them), the others in a grid of `cols` columns and `rows`
 * rows (the identity line not counted); each cell's column span (row cells span all; a cell on the identity line 1) and the width its caption
 * takes (0: as its own).
 */
export interface FitChoice { lead: number; inline: boolean; packed: boolean; cols: number; rows: number; spans: number[]; caps: number[]; score: number }

const ROW_COST = 10, ORPHAN_COST = 6, UNEVEN_COST = 5, PACKED_COST = 5;

/** The best grid for `cells` in `avail` px (none of them on the identity line), the captions of a column aligned when `caps`. */
function gridOf(cells: readonly FitCell[], avail: number, gap: number, withCaps: boolean): Omit<FitChoice, 'lead' | 'inline' | 'packed'> {
  const n = cells.length;
  const plain = cells.map((c, i) => ({ width: c.width, cap: withCaps ? c.cap : undefined, i })).filter((_, i) => !cells[i]!.row), rowCells = n - plain.length;
  const m = plain.length;
  if (!m) return { cols: 1, rows: rowCells, spans: cells.map(() => 1), caps: cells.map(() => 0), score: ROW_COST * rowCells };
  let best: Omit<FitChoice, 'lead' | 'inline' | 'packed'> | null = null;
  for (let cols = m; cols >= 1; cols--) {
    const rows = Math.ceil(m / cols);
    const spans = cells.map(c => (c.row ? 0 : 1));
    const last = m - (rows - 1) * cols, spare = cols - last;
    if (rows > 1 && spare > 0) {
      // The spare columns go to the last row's cells from its end, one each in turn, so the widest stretch is never more than one column.
      for (let s = 0; s < spare; s++) { const k = (rows - 1) * cols + last - 1 - (s % last); spans[plain[k]!.i]! += 1; }
    }
    // The column each cell starts in (a spanning cell of the last row can start further right than k % cols).
    const start = new Array<number>(m);
    for (let k = 0, col = 0; k < m; k++) { if (k % cols === 0) col = 0; start[k] = col; col += spans[plain[k]!.i]!; }
    // Columns as wide as their widest single cell. A column with captioned controls also needs its widest caption (of every cell starting
    // there) beside its widest control, which may be more than its widest cell; a spanning cell widens the last of its columns if it must.
    const widths = new Array<number>(cols).fill(0), capW = new Array<number>(cols).fill(0), ctlW = new Array<number>(cols).fill(0), capGap = new Array<number>(cols).fill(0);
    for (let k = 0; k < m; k++) {
      const c = plain[k]!, col = start[k]!, one = spans[c.i] === 1;
      if (one) widths[col] = Math.max(widths[col]!, c.width);
      if (c.cap) { capW[col] = Math.max(capW[col]!, c.cap.caption); capGap[col] = Math.max(capGap[col]!, c.cap.gap); if (one) ctlW[col] = Math.max(ctlW[col]!, c.cap.control); }
    }
    for (let col = 0; col < cols; col++) if (capW[col]) widths[col] = Math.max(widths[col]!, capW[col]! + capGap[col]! + ctlW[col]!);
    for (let k = 0; k < m; k++) {
      const c = plain[k]!, span = spans[c.i]!, col = start[k]!;
      if (span < 2) continue;
      const own = c.cap ? capW[col]! + capGap[col]! + c.cap.control : c.width;
      const room = widths.slice(col, col + span).reduce((s, w) => s + w, 0) + gap * (span - 1);
      if (own > room) widths[col + span - 1]! += own - room;
    }
    const need = widths.reduce((s, w) => s + w, 0) + gap * (cols - 1);
    if (need > avail && cols > 1) continue;
    let emptiest = 1;
    for (let r = 0; r < rows; r++) {
      const inRow = plain.slice(r * cols, (r + 1) * cols), used = inRow.reduce((s, c) => s + c.width, 0) + gap * (inRow.length - 1);
      emptiest = Math.min(emptiest, avail > 0 ? used / avail : 1);
    }
    const allRows = rows + rowCells, orphan = cols > 1 && rows > 1 && last === 1 ? 1 : 0;
    const score = ROW_COST * allRows + ORPHAN_COST * orphan + UNEVEN_COST * (1 - Math.min(1, emptiest));
    const caps = cells.map(() => 0);
    for (let k = 0; k < m; k++) if (plain[k]!.cap) caps[plain[k]!.i] = capW[start[k]!]!;
    if (!best || score < best.score - 1e-9) best = { cols, rows: allRows, spans: spans.map(s => s || cols), caps, score };
  }
  return best!;
}

/** How many rows `cells` take packed: row by row, as many as fit in `avail`; a row cell on a row of its own. */
function packedRows(cells: readonly FitCell[], avail: number, gap: number): number {
  let rows = 0, used = -1;
  for (const c of cells) {
    if (c.row) { rows++; used = -1; continue; }
    if (used >= 0 && used + gap + c.width <= avail) used += gap + c.width;
    else { rows++; used = c.width; }
  }
  return rows;
}

/**
 * The layout for `cells` given the grid's width `avail`, the gap between cells and, where the header has one, the room left on its identity
 * line (`inlineAvail`, null: none) and the gap between cells there (`lineGap`). A cell wider than the grid still gets a row of its own (it is
 * clipped, as it would be anyway).
 */
export function chooseFit(cells: readonly FitCell[], avail: number, gap: number, inlineAvail: number | null = null, lineGap = gap): FitChoice {
  const n = cells.length;
  if (!n) return { lead: 0, inline: false, packed: false, cols: 1, rows: 0, spans: [], caps: [], score: 0 };
  let best: FitChoice | null = null;
  // More cells on the identity line first, so that of two layouts that score the same the one with the fewer cells under it is kept.
  for (let lead = inlineAvail === null ? 0 : n; lead >= 0; lead--) {
    const along = lead ? cells.slice(0, lead).reduce((s, c) => s + c.width, 0) + lineGap * (lead - 1) : 0;
    if (lead && along > inlineAvail!) continue;
    const rest = cells.slice(lead);
    let grid = { packed: false, cols: 1, rows: 0, spans: [] as number[], caps: [] as number[], score: 0 };
    if (rest.length) {
      const aligned = gridOf(rest, avail, gap, true), plainGrid = gridOf(rest, avail, gap, false);
      grid = { packed: false, ...(aligned.rows <= plainGrid.rows ? aligned : plainGrid) };
      const packed = packedRows(rest, avail, gap);
      if (packed < grid.rows) grid = { packed: true, cols: 1, rows: packed, spans: rest.map(() => 1), caps: rest.map(() => 0), score: ROW_COST * packed + PACKED_COST };
    }
    if (!best || grid.score < best.score - 1e-9) {
      best = { lead, inline: lead === n, packed: grid.packed, cols: grid.cols, rows: grid.rows, spans: [...new Array<number>(lead).fill(1), ...grid.spans], caps: [...new Array<number>(lead).fill(0), ...grid.caps], score: grid.score };
    }
  }
  return best!;
}

/** Two choices that lay the cells out the same way. */
export const sameFit = (a: FitChoice | null, b: FitChoice | null): boolean =>
  !!a && !!b && a.lead === b.lead && a.packed === b.packed && a.cols === b.cols && a.spans.join() === b.spans.join() && a.caps.join() === b.caps.join();

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
  /** The cells on the identity line, in their order, each with the mark it left in `cells`. */
  #leads: { cell: HTMLElement; mark: Comment }[] = [];
  readonly #changes: MutationObserver;
  readonly #observers: { disconnect(): void }[] = [];

  constructor(private readonly head: HTMLElement, readonly cells: HTMLElement, watch: HTMLElement = head) {
    cells.classList.add('fit-cells');
    const resize = new ResizeObserver(() => this.refit());
    resize.observe(watch);
    this.#changes = new MutationObserver(() => this.refit());
    // The whole header: a cell on the identity line is no longer inside `cells`. What this class changes itself is taken back (#quiet).
    this.#changes.observe(head, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'], characterData: true });
    // The arrangement (desktop or phone) is an attribute of the root element.
    this.#changes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-layout'] });
    this.#observers.push(resize, this.#changes);
    void document.fonts?.ready.then(() => this.refit(true));
  }

  /** The layout in use (null on a phone, or before the first fit), for tests. */
  get choice(): FitChoice | null { return this.#choice; }

  /** Every cell in its order, the ones on the identity line first (they are always the first ones), and whether each is shown. */
  #all(): HTMLElement[] {
    return [...this.#leads.map(l => l.cell), ...[...this.cells.children].filter((c): c is HTMLElement => c instanceof HTMLElement)];
  }

  static #visible(c: HTMLElement): boolean { return !c.hidden && getComputedStyle(c).display !== 'none'; }

  /** Takes back the records of this class's own changes, so that they do not choose the layout again. */
  #quiet(): void { this.#changes.takeRecords(); }

  /** Chooses the layout again (`force`: even when nothing it depends on has changed). */
  refit(force = false): void {
    const desktop = document.documentElement.dataset.layout === 'desktop';
    if (!desktop) { this.#clear(); return; }
    const width = this.head.clientWidth, all = this.#all(), shown = all.filter(FitGrid.#visible);
    const signature = all.map(c => `${c.tagName}:${FitGrid.#visible(c) ? 1 : 0}:${c.textContent?.length ?? 0}`).join('|');
    if (!force && this.#choice && signature === this.#signature && Math.abs(width - this.#width) <= REFIT_PX) return;
    this.#signature = signature; this.#width = width;
    // Natural widths: the cells on the identity line where they are (at their own width), the others side by side at their own size, out of
    // the header's flow for the moment of measuring.
    this.cells.classList.add('fit-measuring');
    const widths = shown.map(c => Math.ceil(c.getBoundingClientRect().width));
    // A caption and its control: a label whose last child is its select (the caption is the text before it).
    const caps = shown.map((c, i) => {
      const control = c.tagName === 'LABEL' ? c.lastElementChild : null;
      if (!(control instanceof HTMLElement)) return undefined;
      const w = Math.ceil(control.getBoundingClientRect().width), gap = parseFloat(getComputedStyle(c).columnGap) || 0;
      return { caption: Math.max(0, widths[i]! - w - gap), gap, control: w };
    });
    this.cells.classList.remove('fit-measuring');
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
    const choice = chooseFit(shown.map((c, i) => ({ width: widths[i]!, row: c.dataset.fit === 'row', ...(caps[i] ? { cap: caps[i] } : {}) })), inner, cellGap, room, gap);
    if (sameFit(choice, this.#choice) && !force) return;
    this.#choice = choice;
    // The cells on the identity line: the first `lead` shown ones, with any hidden cell among them (a hidden cell stays where its neighbours are).
    const lastLead = choice.lead ? all.indexOf(shown[choice.lead - 1]!) : -1;
    this.#place(all.slice(0, lastLead + 1));
    this.head.classList.toggle('fit-inline', choice.inline);
    this.cells.classList.toggle('fit-packed', choice.packed);
    if (choice.packed) this.cells.style.removeProperty('grid-template-columns');
    else this.cells.style.gridTemplateColumns = `repeat(${choice.cols}, minmax(max-content, 1fr))`;
    shown.forEach((c, i) => {
      const span = choice.spans[i]!, cap = choice.caps[i]!;
      c.style.gridColumn = i >= choice.lead && span > 1 ? `span ${span}` : '';
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
    this.#choice = null; this.#width = -1; this.#signature = '';
    this.#place([]);
    this.head.classList.remove('fit-inline');
    this.cells.classList.remove('fit-packed');
    this.cells.style.removeProperty('grid-template-columns');
    for (const c of this.cells.children) if (c instanceof HTMLElement) { c.style.removeProperty('grid-column'); c.style.removeProperty('--fit-cap'); }
    this.#quiet();
  }

  disconnect(): void { for (const o of this.#observers) o.disconnect(); }
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

/**
 * Rows of controls given as rows (a top-bar deck's): one grid of as many columns as the longest row has controls, each column as wide as the
 * widest control in it, a shorter row's spare columns given to whichever of its controls make the grid narrowest (to its last ones when that is
 * all the same). `widths` are the controls' own widths row by row; the result is each column's width, each control's span, the grid's width
 * and the width of its widest row laid out on its own (`natural`), which is what aligning the columns costs beyond.
 */
export function alignRows(widths: readonly (readonly number[])[], gap: number): { cols: number[]; spans: number[][]; width: number; natural: number } {
  const n = Math.max(1, ...widths.map(r => r.length));
  const natural = Math.max(0, ...widths.map(r => r.reduce((s, w) => s + w, 0) + gap * Math.max(0, r.length - 1)));
  const options = widths.map(r => (r.length ? spreads(r.length, n - r.length).map(x => x.map(e => e + 1)) : [[]]));
  const count = options.reduce((p, o) => p * o.length, 1);
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
