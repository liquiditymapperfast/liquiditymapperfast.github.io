import { t, tn } from '../i18n.ts';
import { price as fmtPrice } from '../format.ts';
import type { View } from '../view.ts';
import { isCoarse } from '../device.ts';
import { ANCHORS, MAX_PER_COIN, MAX_TOTAL, capReached, duplicate as copyOf, exportText, fits, importInto, moved, newDrawing, totalOf, type Anchor, type DrawDoc, type DrawKind, type Drawing } from './model.ts';
import { axisOf, deltaOf, edgeMinFor, handlesOf, hitDrawing, sameHit, withHandleAt, type Handle, type HandleAxis, type Hit, type Projection, type Pt } from './geometry.ts';
import { candleTargets, snapPoint, snapTime, wallTargets, type CandleUnder, type SnapTarget } from './magnet.ts';
import { History } from './history.ts';
import type { DrawStore } from './storage.ts';
import type { DrawSettings } from './settings.ts';

/**
 * The drawing tools' one owner (Karl, 2026-10-28): which tool is armed, the drawing being placed, the one selected, a drag of a handle or a
 * whole drawing, the magnet, Undo, keeping the drawings and the level alerts. The map pane hands it the pointer first and paints what it
 * holds (draw/paint.ts); the bar shows and changes it (draw/bar.ts). It knows the map only through `DrawHost`.
 *
 * Placing is a click (a tap) a point: a press that moves is a pan, never a point, so the map can be moved while a tool is armed. Editing is
 * of the selected drawing only: its handles move its points, its stroke moves it whole, and a zone's inside still pans the map.
 */
export interface DrawHost {
  readonly view: View;
  plotW(): number;
  plotH(): number;
  /** The candle under `x` as the map draws it (its centre's time and x, its prices), or null. */
  candleAt(x: number): CandleUnder | null;
  /** Whether the chart draws closes only (a line): the magnet offers closes alone. */
  closesOnly(): boolean;
  /** The walls of resting liquidity in the heat map's column under `x`. */
  wallsAt(x: number): { p: number; usd: number }[];
  /** The book's row around `price` now: its resting USD by side and the row's size; null where the book is not held (a replay). */
  restingAt(price: number): { bid: number; ask: number; step: number } | null;
  mark(): number;
  coin(): string;
  /** The page's clock (a replay's moment while one plays). */
  now(): number;
  replaying(): boolean;
  settings(): DrawSettings;
  /** Switch the drawings back on (a tool armed while they are hidden). */
  reveal(): void;
  /** A tool is armed: Range and VWAP anchoring, which take the next press too, are put away. */
  disarmOthers(): void;
  /** Centre the map on a stretch of time and prices (Find). */
  focus(box: { t0: number; t1: number; p0: number; p1: number }): void;
  /** Add up what happened in a box with the Range tool (Inspect). */
  inspect(box: { t0: number; t1: number; p0: number; p1: number }): void;
  /** A level with an alert was reached (`key`: the level's own, for its cool-down). */
  alert(text: string, key: string): void;
  redraw(): void;
}

/** The drawing being placed: its kind and the points put so far. */
export interface Draft { kind: DrawKind; points: Anchor[] }
/**
 * Where the next point would go, with the magnet's target when it caught one, and where that is on the plot (the caught candle's own place
 * when it caught a price). `caught`: the magnet moved the point, onto a price or onto a candle's time.
 */
export interface Cursor { at: Anchor; snap: SnapTarget | null; x: number; y: number; caught: boolean }
/**
 * A drag of a handle holds what the handle moves as it was when the press began (the points are told apart by their place, never by which
 * is higher or further left now, so a top edge pulled under the bottom one is still the same point), or of a whole drawing.
 */
type Drag = { mode: 'handle'; id: string; handle: Pick<Handle, 't' | 'p' | 'after'>; before: readonly Drawing[]; original: Drawing } | { mode: 'move'; id: string; from: Pt; away: boolean; before: readonly Drawing[]; original: Drawing };

/** How near a stroke the pointer must be to be on it (px), with a mouse and with a finger. */
const TOL = { mouse: 6, touch: 12 };
/** How far (px) the pointer must leave the spot it pressed on a level or an event line before the magnet takes hold of it: a wobbling press is not a move. */
const AWAY = { mouse: 4, touch: 8 };

export class DrawController {
  #doc: DrawDoc;
  /** A newer page saved the drawings (when this one opened, or since, in another tab): none is shown and nothing is written over them. */
  #newer: boolean;
  readonly #histories = new Map<string, History>();
  #coin = '';
  #drag: Drag | null = null;
  #held: SnapTarget | null = null;
  /** Whether the last pointer was a finger (before any pointer: whether the device is touch first): its handles are further apart (`edgeMinFor`), here and where they are painted. */
  #touch = isCoarse();
  #lastMark = 0;
  tool: DrawKind | null = null;
  /** The points placed so far of a drawing that takes more than one: the map waits rather than following the market while there is one (and while one is dragged). */
  draft: Draft | null = null;
  cursor: Cursor | null = null;
  selected: string | null = null;
  hover: Hit | null = null;
  /** Whether the bar is out (draw/bar.ts). */
  open = false;
  /** What the bar says that is not a step of placing: a failure to save, a cap reached, a file read in. */
  message: { text: string; warn: boolean } | null = null;
  /** The bar redraws (set by the bar). */
  onChange: () => void = () => {};
  /** A note's text box as the painter measures it (set by the painter). */
  noteSize: (d: Drawing) => { w: number; h: number } = () => ({ w: 80, h: 18 });

  constructor(private host: DrawHost, private store: DrawStore) {
    const doc = store.load();
    this.#newer = doc === null; this.#doc = doc ?? { version: 1, coins: {} };
    if (this.#newer) this.message = { text: t('These drawings were saved by a newer version of the page: reload it to see and change them.'), warn: true };
    store.onOtherTab(() => this.#reload());
  }

  // ---- what there is ------------------------------------------------------------------------------------------------------------

  /** This coin's drawings, oldest first (the newest drawn on top). */
  list(): readonly Drawing[] { this.#sync(); return this.#doc.coins[this.#coin] ?? []; }
  /** The drawings painted: none while they are switched off. */
  shown(): readonly Drawing[] { return this.host.settings().shown ? this.list().filter(d => !d.hidden) : []; }
  get(id: string | null): Drawing | null { return id ? this.list().find(d => d.id === id) ?? null : null; }
  get dragging(): boolean { return this.#drag !== null; }
  /** The shortest edge of a zone that has a handle in its middle now, for the pointer in use. */
  get edgeMin(): number { return edgeMinFor(TOL[this.#touch ? 'touch' : 'mouse']); }
  /** Whether a press on the drawing's handles or its stroke would move it: not a locked one, nor any while the drawings are read-only. */
  canDrag(id: string): boolean { const d = this.get(id); return d !== null && !d.locked && !this.readOnly; }
  /** The axes the drag in hand moves (the pointer shows a resize arrow for one), or null when none is. */
  get dragAxis(): HandleAxis | null { const d = this.#drag; return d?.mode === 'handle' ? axisOf(d.handle) : d ? 'both' : null; }
  /** Whether a press on the map places a point (a tool is armed): a double click or a double tap does not recentre then. */
  get placing(): boolean { return this.tool !== null; }
  get canUndo(): boolean { return this.#history().canUndo; }
  get canRedo(): boolean { return this.#history().canRedo; }
  get readOnly(): boolean { return this.#newer || this.host.settings().locked || this.host.replaying(); }
  /** The document, to write to a file. */
  exportText(): string { return exportText(this.#doc); }

  /** Another coin is on the page: what was being placed, dragged or selected belonged to the last one. */
  #sync(): void {
    const coin = this.host.coin();
    if (coin === this.#coin) return;
    this.#coin = coin; this.draft = null; this.cursor = null; this.selected = null; this.hover = null; this.#drag = null; this.#held = null; this.#lastMark = 0;
  }

  /** The timeframe, the market or the chart type changed: a drawing half placed is dropped (its points stay what they are on any chart). */
  contextChanged(): void {
    this.#lastMark = 0;
    if (this.#drag) this.#abortDrag();
    if (this.draft) { this.draft = null; this.cursor = null; this.#changed(); }
  }

  #history(): History {
    this.#sync();
    let h = this.#histories.get(this.#coin);
    if (!h) { h = new History(); this.#histories.set(this.#coin, h); }
    return h;
  }

  #proj(): Projection {
    const v = this.host.view, w = this.host.plotW(), h = this.host.plotH();
    return { x: q => v.xOf(q, w), y: p => v.yOf(p, h), t: x => v.tOf(x, w), p: y => v.pOf(y, h), w, h };
  }

  #changed(): void {
    if (this.selected && !this.shown().some(d => d.id === this.selected)) this.selected = null;
    if (this.hover && !this.shown().some(d => d.id === this.hover!.id)) this.hover = null;
    this.onChange(); this.host.redraw();
  }

  /** Write this coin's list, as a step Undo can take back (`step`) or as part of one still under way (a drag), and keep it. */
  #write(next: readonly Drawing[], step: { before: readonly Drawing[] } | null): void {
    this.#sync();
    const coins = { ...this.#doc.coins };
    if (next.length) coins[this.#coin] = [...next]; else delete coins[this.#coin];
    this.#doc = { version: 1, coins };
    if (!step) return;
    this.#history().push(step.before, next);
    this.#save();
  }

  #save(): void {
    if (this.#newer) return;
    if (!this.store.save(this.#doc)) this.message = { text: t('The drawings could not be kept: this browser\'s storage is full or switched off.'), warn: true };
    else if (this.message?.warn) this.message = null;
  }

  /** Another tab kept its drawings: they are read again, and what was in hand here is let go (its steps no longer fit what is kept). */
  #reload(): void {
    const doc = this.store.load();
    if (!doc) {
      // A newer page wrote them in another tab: this one holds an older copy, which must never be saved over theirs.
      this.#newer = true; this.#doc = { version: 1, coins: {} }; this.#histories.clear(); this.draft = null; this.cursor = null; this.#drag = null; this.selected = null; this.tool = null;
      this.message = { text: t('These drawings were saved by a newer version of the page: reload it to see and change them.'), warn: true };
      this.#changed(); return;
    }
    if (this.#newer) { this.#newer = false; if (this.message?.warn) this.message = null; }
    this.#doc = doc; this.#histories.clear(); this.draft = null; this.cursor = null; this.#drag = null;
    if (this.selected && !this.get(this.selected)) this.selected = null;
    this.#changed();
  }

  // ---- placing ----------------------------------------------------------------------------------------------------------------

  /** Arm a tool: the next clicks place its points. Not while replaying, while the drawings are locked or kept by a newer page. */
  arm(kind: DrawKind): void {
    if (this.host.replaying()) { this.message = { text: t('Drawings are added on the live chart, not during a replay.'), warn: false }; this.onChange(); return; }
    if (this.host.settings().locked) { this.message = { text: t('The drawings are locked: unlock them in Drawings to add one.'), warn: false }; this.onChange(); return; }
    if (this.#newer) { this.onChange(); return; }
    if (!this.host.settings().shown) this.host.reveal();
    this.host.disarmOthers();
    this.tool = kind; this.draft = null; this.cursor = null; this.selected = null; this.message = null;
    this.#changed();
  }

  disarm(): void {
    if (!this.tool && !this.draft) return;
    this.tool = null; this.draft = null; this.cursor = null; this.#held = null;
    this.#changed();
  }

  /** What the next press does, said in the bar: the step of placing, in the words of a mouse or of a finger. */
  hint(touch: boolean): string | null {
    const kind = this.tool; if (!kind) return null;
    const n = this.draft?.points.length ?? 0;
    if (n === 0) {
      if (kind === 'level') return touch ? t('Tap where the level goes.') : t('Click where the level goes.');
      if (kind === 'vline') return touch ? t('Tap the moment to mark.') : t('Click the moment to mark.');
      if (kind === 'note') return touch ? t('Tap the point the note is about.') : t('Click the point the note is about.');
      return touch ? t('Tap the first point.') : t('Click the first point.');
    }
    if (kind === 'zone') return touch ? t('Tap the opposite corner.') : t('Click the opposite corner.');
    if (kind === 'channel' && n === 2) return touch ? t('Tap a point the parallel line passes through.') : t('Click a point the parallel line passes through.');
    return touch ? t('Tap the second point.') : t('Click the second point.');
  }

  /**
   * Where a point placed at `q` goes: the pointer's time and price, or the magnet's target (Alt held: none). `axis` says which of the two the
   * point takes from it: a price alone (the top or bottom of a box, a level), whose catch is the candle under the pointer's x and whose ring
   * stands on that candle, or a time alone (a side of a box, an event line), caught at the candle's centre.
   */
  #anchorAt(q: Pt, kind: DrawKind, alt: boolean, touch: boolean, axis: HandleAxis = 'both'): Cursor {
    const pr = this.#proj(), at: Anchor = { t: pr.t(q.x), p: pr.p(q.y) }, s = this.host.settings();
    const free: Cursor = { at, snap: null, x: q.x, y: q.y, caught: false };
    if (s.magnet === 'off' || alt) { this.#held = null; return free; }
    const candle = this.host.candleAt(q.x);
    if (kind === 'vline' || axis === 't') { const tt = snapTime(q.x, candle, s.magnet, touch); return tt === null ? free : { at: { t: tt, p: at.p }, snap: null, x: pr.x(tt), y: q.y, caught: true }; }
    const targets = [...(candle ? candleTargets(candle, this.host.closesOnly()) : []), ...(s.walls ? wallTargets(this.host.wallsAt(q.x), at.t, q.x, pr.y) : [])];
    const snap = snapPoint(q.y, targets, s.magnet, touch, this.#held);
    this.#held = snap;
    if (!snap) return free;
    if (axis === 'p') return { at: { t: at.t, p: snap.p }, snap, x: snap.x, y: snap.y, caught: true };
    // A level is a price: its time stays where it is placed (where a ray starts); a wall is a price at the time pointed at.
    const tt = kind === 'level' || snap.field === 'wall' ? at.t : snap.t;
    return { at: { t: tt, p: snap.p }, snap, x: snap.x, y: snap.y, caught: true };
  }

  // ---- the pointer ------------------------------------------------------------------------------------------------------------

  /** A press on the map: on a handle or the stroke of the selected drawing it starts a drag (true: the map does not pan). */
  down(q: Pt, touch: boolean): boolean {
    this.#touch = touch;
    if (this.tool || this.readOnly) return false;
    const list = this.list(), hit = hitDrawing(q, this.shown(), this.#proj(), TOL[touch ? 'touch' : 'mouse'], this.selected, this.noteSize);
    if (!hit || hit.id !== this.selected || hit.part === 'inside') return false;
    const d = this.get(hit.id); if (!d || d.locked) return false;
    if (hit.part === 'handle') {
      const h = handlesOf(d, this.#proj(), edgeMinFor(TOL[touch ? 'touch' : 'mouse']))[hit.index]; if (!h) return false;
      this.#drag = { mode: 'handle', id: d.id, handle: { t: h.t, p: h.p, after: h.after }, before: list, original: d };
    } else this.#drag = { mode: 'move', id: d.id, from: q, away: false, before: list, original: d };
    this.#held = null;
    return true;
  }

  /** The pointer moved: a drag moves what it holds (true); otherwise the hover and the next point's preview follow it (false). */
  move(q: Pt, alt: boolean, touch: boolean): boolean {
    this.#touch = touch;
    const drag = this.#drag;
    if (drag) {
      const o = drag.original;
      let next: Drawing;
      if (drag.mode === 'handle') {
        const c = this.#anchorAt(q, o.kind, alt, touch, axisOf(drag.handle));
        this.cursor = c;
        next = withHandleAt(o, drag.handle, c.at);
      } else {
        const { dt, dp } = deltaOf(this.#proj(), drag.from, q);
        next = moved(o, dt, dp);
        // A level moved by its stroke lands where the magnet would put a point at the pointer (a price), an event line on a candle's time, as a
        // point dragged by its handle does; the other drawings move whole, as they were grabbed.
        this.cursor = null;
        if (!drag.away && Math.hypot(q.x - drag.from.x, q.y - drag.from.y) >= AWAY[touch ? 'touch' : 'mouse']) drag.away = true;
        if (drag.away && (o.kind === 'level' || o.kind === 'vline')) {
          const c = this.#anchorAt(q, o.kind, alt, touch, o.kind === 'level' ? 'p' : 't');
          if (c.caught) { next = withHandleAt(next, o.kind === 'level' ? { t: [], p: [0] } : { t: [0], p: [] }, c.at); this.cursor = c; }
        }
      }
      if (fits(next)) this.#write(this.list().map(d => d.id === o.id ? next : d), null);
      this.host.redraw();
      return true;
    }
    if (this.tool) { this.cursor = this.#anchorAt(q, this.tool, alt, touch); this.hover = null; this.host.redraw(); return false; }
    const hover = hitDrawing(q, this.shown(), this.#proj(), TOL[touch ? 'touch' : 'mouse'], this.selected, this.noteSize);
    if (!sameHit(hover, this.hover)) { this.hover = hover; this.host.redraw(); }
    return false;
  }

  /** The pointer left the map: no hover, no preview. */
  leave(): void { if (this.hover || this.cursor) { this.hover = null; if (!this.#drag) this.cursor = null; this.host.redraw(); } }

  /** The press ended: a drag becomes one step Undo can take back (true). */
  up(): boolean {
    const drag = this.#drag; if (!drag) return false;
    this.#drag = null; this.cursor = null; this.#held = null;
    const after = this.list();
    if (after !== drag.before) { this.#history().push(drag.before, after); this.#save(); }
    this.#changed();
    return true;
  }

  /** A drag that did not end (Esc, a lost pointer): the drawing goes back to where it was. */
  #abortDrag(): void {
    const drag = this.#drag; if (!drag) return;
    this.#drag = null; this.cursor = null; this.#held = null;
    this.#write(drag.before, null);
    this.#changed();
  }
  /** The pointer was taken away mid-drag (the browser cancelled it): nothing of the drag is kept. */
  cancelPointer(): void { this.#abortDrag(); }

  /**
   * A click (or a tap) that did not move: with a tool armed it places a point (the last point finishes the drawing); otherwise it selects
   * the drawing under it, or lets the selection go. True when it was the drawing tools' click.
   */
  click(q: Pt, alt: boolean, touch: boolean): boolean {
    this.#touch = touch;
    if (this.#newer) return false;
    if (this.tool) {
      if (this.readOnly) { this.disarm(); return false; }
      const kind = this.tool, c = this.#anchorAt(q, kind, alt, touch), points = [...(this.draft?.points ?? []), c.at];
      // The same point twice (a double click, a shaky tap) is not the next point.
      if (points.length > 1) {
        const pr = this.#proj(), prev = points[points.length - 2]!;
        if (Math.hypot(pr.x(prev.t) - c.x, (kind === 'vline' ? c.y : pr.y(prev.p)) - c.y) < 4) return true;
      }
      if (points.length < ANCHORS[kind]) { this.draft = { kind, points }; this.#held = null; this.#changed(); return true; }
      this.#commit(newDrawing(kind, points));
      return true;
    }
    const hit = hitDrawing(q, this.shown(), this.#proj(), TOL[touch ? 'touch' : 'mouse'], this.selected, this.noteSize);
    if (hit) { if (this.selected !== hit.id) { this.selected = hit.id; this.message = null; this.#changed(); } return true; }
    if (this.selected) { this.selected = null; this.#changed(); }
    return false;
  }

  #commit(d: Drawing): void {
    const before = this.list(), cap = capReached(this.#doc, this.#coin);
    this.draft = null; this.cursor = null; this.#held = null;
    if (!fits(d)) { this.message = { text: t('A drawing needs its points on the chart, at prices above zero.'), warn: true }; this.#changed(); return; }
    if (cap) {
      this.message = { text: cap === 'coin' ? t('This coin has as many drawings as it can keep (100): delete one to add another.') : t('The page keeps 1,000 drawings in all: delete some to add more.'), warn: true };
      this.tool = null; this.#changed(); return;
    }
    this.#write([...before, d], { before });
    this.selected = d.id;
    if (!this.host.settings().keep) this.tool = null;
    this.#changed();
  }

  // ---- editing --------------------------------------------------------------------------------------------------------------

  /** The drawings were switched off (or other settings changed): what cannot be seen is not selected, hovered or being placed. */
  settingsChanged(): void {
    if (this.host.settings().shown) return;
    if (this.selected || this.hover || this.tool) { this.selected = null; this.hover = null; this.tool = null; this.draft = null; this.cursor = null; this.#changed(); }
  }

  /** Change a drawing (its look, its options, its text, a point typed in), as one step; a locked drawing is only unlocked, hidden or shown. */
  update(id: string, patch: Partial<Omit<Drawing, 'id' | 'kind' | 'created'>>): void {
    if (this.readOnly) return;
    const before = this.list(), d = before.find(x => x.id === id); if (!d) return;
    if (d.locked && Object.keys(patch).some(k => k !== 'locked' && k !== 'hidden')) return;
    if (!fits({ ...d, ...patch })) return;
    this.#write(before.map(x => x.id === id ? { ...x, ...patch } : x), { before });
    // A drawing hidden is let go: nothing unseen stays selected (Delete would remove it with nothing on screen).
    if (patch.hidden === true) { if (this.selected === id) this.selected = null; if (this.hover?.id === id) this.hover = null; }
    this.#changed();
  }

  remove(id: string): void {
    if (this.readOnly) return;
    const before = this.list(), d = before.find(x => x.id === id); if (!d || d.locked) return;
    this.#write(before.filter(x => x.id !== id), { before });
    if (this.selected === id) this.selected = null;
    this.#changed();
  }

  /** A copy of a drawing a little later and lower, selected. */
  duplicate(id: string): void {
    if (this.readOnly) return;
    const before = this.list(), d = before.find(x => x.id === id); if (!d) return;
    if (capReached(this.#doc, this.#coin)) { this.message = { text: t('This coin has as many drawings as it can keep (100): delete one to add another.'), warn: true }; this.onChange(); return; }
    const v = this.host.view, dt = (v.t1 - v.t0) * 0.03, dp = (v.p1 - v.p0) * 0.03;
    const copy = [copyOf(d, dt, -dp), copyOf(d, dt, dp), copyOf(d, -dt, -dp), copyOf(d, -dt, dp)].find(fits);
    if (!copy) { this.message = { text: t('A drawing needs its points on the chart, at prices above zero.'), warn: true }; this.onChange(); return; }
    this.#write([...before, copy], { before });
    this.selected = copy.id;
    this.#changed();
  }

  /** Delete this coin's drawings that are not locked, as one step. */
  removeAll(): void {
    if (this.readOnly) return;
    const before = this.list(), kept = before.filter(d => d.locked);
    if (kept.length === before.length) return;
    this.#write(kept, { before });
    if (this.selected && !kept.some(d => d.id === this.selected)) this.selected = null;
    this.#changed();
  }

  /** Whether a coin's list can become `next` within the caps (Undo or Redo after drawings were added since). */
  #room(next: readonly Drawing[]): boolean {
    const now = this.list().length;
    if (next.length <= now) return true;
    if (next.length > MAX_PER_COIN || totalOf(this.#doc) - now + next.length > MAX_TOTAL) {
      this.message = { text: t('That step cannot be taken back: it would keep more drawings than the page can (100 a coin, 1,000 in all).'), warn: true };
      this.onChange(); return false;
    }
    return true;
  }

  undo(): boolean {
    if (this.readOnly) return false;
    const h = this.#history(), peek = h.peekUndo(); if (!peek || !this.#room(peek)) return false;
    const back = h.undo(); if (!back) return false;
    this.#write(back, null); this.#save();
    if (this.selected && !this.get(this.selected)) this.selected = null;
    this.#changed();
    return true;
  }

  redo(): boolean {
    if (this.readOnly) return false;
    const h = this.#history(), peek = h.peekRedo(); if (!peek || !this.#room(peek)) return false;
    const forward = h.redo(); if (!forward) return false;
    this.#write(forward, null); this.#save();
    if (this.selected && !this.get(this.selected)) this.selected = null;
    this.#changed();
    return true;
  }

  /** Read drawings from a file into what is kept, as one step for this coin (and kept for the others); what it did, in words. */
  importText(text: string): string {
    if (this.#newer) return t('These drawings were saved by a newer version of the page: reload it to see and change them.');
    if (this.host.replaying()) return t('Drawings are added on the live chart, not during a replay.');
    if (this.host.settings().locked) return t('The drawings are locked: unlock them in Drawings to add one.');
    const before = this.list(), read = importInto(this.#doc, text);
    if (read.error === 'size') return t('That file is too large to be drawings from this page.');
    if (read.error === 'version') return t('That file was written by a newer version of the page.');
    if (read.error) return t('That file is not drawings from this page.');
    this.#doc = read.doc;
    const after = this.list();
    if (after.length !== before.length) this.#history().push(before, after);
    this.#save(); this.#changed();
    const added = tn(read.added, '{n} drawing added.', '{n} drawings added.');
    return read.skipped ? `${added} ${tn(read.skipped, '{n} left out: a coin keeps 100 and the page 1,000.', '{n} left out: a coin keeps 100 and the page 1,000.')}` : added;
  }

  /** Centre the map on a drawing. */
  find(id: string): void {
    let d = this.get(id); if (!d) return;
    if (d.hidden) { if (this.readOnly) return; this.update(id, { hidden: false }); d = this.get(id); if (!d) return; }
    if (!this.host.settings().shown) this.host.reveal();
    const v = this.host.view, ts = d.points.map(q => q.t), ps = d.points.map(q => q.p);
    const tm = (v.t0 + v.t1) / 2, pm = (v.p0 + v.p1) / 2;
    const time = d.kind === 'level' ? { t0: tm, t1: tm } : { t0: Math.min(...ts), t1: Math.max(...ts) };
    const prices = d.kind === 'vline' ? { p0: pm, p1: pm } : { p0: Math.min(...ps), p1: Math.max(...ps) };
    this.selected = id; this.host.focus({ ...time, ...prices });
    this.#changed();
  }

  /** Add up what happened in a zone, or in a level's row over the time on the map, with the Range tool. */
  inspect(id: string): void {
    const d = this.get(id); if (!d) return;
    if (d.kind === 'zone') {
      const [a, b] = d.points as [Anchor, Anchor];
      this.host.inspect({ t0: Math.min(a.t, b.t), t1: d.extendRight ? this.host.now() : Math.max(a.t, b.t), p0: Math.min(a.p, b.p), p1: Math.max(a.p, b.p) });
    } else if (d.kind === 'level') {
      const p = d.points[0]!.p, v = this.host.view, step = this.host.restingAt(p)?.step ?? (v.p1 - v.p0) / 100;
      this.host.inspect({ t0: v.t0, t1: Math.min(v.t1, this.host.now()), p0: p - step / 2, p1: p + step / 2 });
    }
  }

  /** Esc: a drag goes back, a drawing half placed is dropped, an armed tool is put away, the selection is let go (true when one of them was). */
  cancel(): boolean {
    if (this.#drag) { this.#abortDrag(); return true; }
    if (this.draft) { this.draft = null; this.cursor = null; this.#held = null; this.#changed(); return true; }
    if (this.tool) { this.disarm(); return true; }
    if (this.selected) { this.selected = null; this.#changed(); return true; }
    return false;
  }

  /**
   * The keys the drawing tools take, when no field, editor or window has them: Esc, Delete and Backspace for the drawing selected, and
   * Ctrl+Z (Cmd on a Mac), Ctrl+Shift+Z and Ctrl+Y for Undo and Redo, when there is something to take back or do again.
   */
  key(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'target' | 'defaultPrevented'>, dialogOpen: boolean): boolean {
    const target = e.target as { tagName?: unknown; isContentEditable?: unknown } | null;
    if (e.defaultPrevented || dialogOpen || (target && (target.isContentEditable === true || (typeof target.tagName === 'string' && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))))) return false;
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (e.key === 'Escape' && !mod && !e.altKey) return this.cancel();
    if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && !e.altKey) { const d = this.shown().find(x => x.id === this.selected); if (!d || d.locked || this.readOnly) return false; this.remove(d.id); return true; }
    if (mod && !e.altKey && key === 'z') return e.shiftKey ? this.redo() : this.undo();
    if (mod && !e.altKey && !e.shiftKey && key === 'y') return this.redo();
    return false;
  }

  // ---- alerts ---------------------------------------------------------------------------------------------------------------

  /** The price moved: a level with its alert on that the price crossed or reached sounds (through the page's alerts). */
  markMoved(price: number): void {
    const before = this.#lastMark;
    this.list();
    this.#lastMark = price;
    if (!(before > 0) || !(price > 0) || before === price || this.host.replaying()) return;
    for (const d of this.list()) {
      if (d.kind !== 'level' || !d.alert || d.hidden) continue;
      const p = d.points[0]!.p;
      if ((before < p && price >= p) || (before > p && price <= p)) {
        const at = fmtPrice(p);
        this.host.alert(d.text ? t('Price reached {price}: {label}', { price: at, label: d.text }) : t('Price reached your level at {price}', { price: at }), `level:${d.id}`);
      }
    }
  }
}
