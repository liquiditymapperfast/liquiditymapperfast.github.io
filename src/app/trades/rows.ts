import { emptyBlock, type Block, type BlockReader } from './blocks.ts';

/**
 * The rows of Trades grouped by time (review round 1, 2026-11-13): a block with something in it (or still forming) is a row of its own, and a
 * run of empty blocks of one kind is one short row, whose words say why it is empty. A run is maximal and cut on the clock every `RUN_MAX`
 * blocks, so the rows are the same whichever way the list is walked and wherever it was scrolled: the painter walks down from the top row,
 * the wheel down or up from the row it is held at, and both land on the same row tops. A settled run is remembered both ways (an hour of
 * quiet seconds is read once, not on every frame).
 */
export type RowKind = 'block' | 'empty' | 'unrecorded' | 'missing';
/** A row: a block (`top` = `bottom`, its start second) or a run of empty blocks, from its newest block's start (`top`) to its oldest's (`bottom`). */
export interface Row { kind: RowKind; top: number; bottom: number }
/** The most blocks one row folds; runs are also cut where a multiple of it begins (clock-aligned). */
export const RUN_MAX = 3600;
/** A run is remembered once its newest block ended this long ago (a late order can still land in a younger one). */
const SETTLED_MS = 120_000;

/** What row a block makes: one with dollars, still forming or mixed is its own; an empty one folds with the empty blocks around it of its kind. */
export function rowKind(b: Block): RowKind {
  if (b.forming || b.buy !== 0 || b.sell !== 0) return 'block';
  if (b.unrecorded) return 'unrecorded';
  if (b.gap) return 'missing';
  return b.partial ? 'block' : 'empty';
}

export class RowWalker {
  /** Settled runs: top -> bottom and bottom -> top (block starts, seconds), under `#key`. */
  readonly #down = new Map<number, { bottom: number; kind: RowKind }>();
  readonly #up = new Map<number, { top: number; kind: RowKind }>();
  /** The settled part of a run whose top is still young: from its newest settled block down (a walk from a newer top jumps it). */
  readonly #skip = new Map<number, { kind: RowKind; bottom: number }>();
  #key = '';
  #b: Block = emptyBlock(0);
  constructor(readonly reader: BlockReader) {}

  /** What the remembered runs were read under (the sources, the size, the side, the unit): they are dropped when it changes. */
  sync(key: string): void { if (key !== this.#key) { this.#key = key; this.#down.clear(); this.#up.clear(); this.#skip.clear(); } }
  #read(s: number, B: number, now: number): Block {
    if (this.#b.vBuy.length !== this.reader.venues) this.#b = emptyBlock(this.reader.venues);
    return this.reader.read(s, B, this.#b, now);
  }
  #keep(top: number, bottom: number, kind: RowKind, B: number, now: number): void {
    if ((top + B) * 1000 + SETTLED_MS >= now || this.reader.tally?.filling) return;
    if (this.#down.size > 20_000) { this.#down.clear(); this.#up.clear(); }
    this.#down.set(top, { bottom, kind }); this.#up.set(bottom, { top, kind });
  }

  /**
   * The row whose top block starts at second `s` (a row's top: the list's newest block, or the block under a row), walking down to `oldest`;
   * `out` gets the top block (the painter draws a block row from it).
   */
  rowFrom(s: number, B: number, now: number, oldest: number, out?: Block): Row | null {
    if (s + B <= oldest) return null;
    const b = out ? this.reader.read(s, B, out, now) : this.#read(s, B, now);
    if (b.unknown) return null;
    const kind = rowKind(b);
    if (kind === 'block') return { kind, top: s, bottom: s };
    const held = this.#down.get(s);
    if (held !== undefined && held.kind === kind) return { kind, top: s, bottom: held.bottom };
    const span = RUN_MAX * B, cut = Math.floor(s / span) * span;
    let e = s, settledAt = NaN;
    while (e - B >= cut && e - B >= oldest) {
      const jump = this.#skip.get(e - B);
      if (jump && jump.kind === kind && jump.bottom >= Math.max(cut, oldest)) { e = jump.bottom; break; }
      const q = this.#read(e - B, B, now);
      if (q.unknown || rowKind(q) !== kind) break;
      e -= B;
      if (Number.isNaN(settledAt) && (e + B) * 1000 + SETTLED_MS < now) settledAt = e;
    }
    this.#keep(s, e, kind, B, now);
    if (!Number.isNaN(settledAt) && settledAt !== s && !this.reader.tally?.filling) {
      if (this.#skip.size > 20_000) this.#skip.clear();
      this.#skip.set(settledAt, { kind, bottom: e });
    }
    return { kind, top: s, bottom: e };
  }
  /** The row under `row` (null where the list ends). */
  below(row: Row, B: number, now: number, oldest: number, out?: Block): Row | null { return this.rowFrom(row.bottom - B, B, now, oldest, out); }
  /** The row over `row`, no newer than the block starting at `newest` (null: `row` is the top). */
  above(row: Row, B: number, now: number, newest: number): Row | null {
    const s = row.top + B;
    if (s > newest) return null;
    const b = this.#read(s, B, now);
    if (b.unknown) return null;
    const kind = rowKind(b);
    if (kind === 'block') return { kind, top: s, bottom: s };
    const held = this.#up.get(s);
    if (held !== undefined && held.kind === kind) return { kind, top: held.top, bottom: s };
    const span = RUN_MAX * B, next = (Math.floor(s / span) + 1) * span;
    let t = s;
    while (t + B < next && t + B <= newest) {
      const q = this.#read(t + B, B, now);
      if (q.unknown || rowKind(q) !== kind) break;
      t += B;
    }
    this.#keep(t, s, kind, B, now);
    return { kind, top: t, bottom: s };
  }
}
