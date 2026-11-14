import { ABSORPTION_WINDOW_MS, GROUP_FLOOR_USD, GROUPS_PER_MINUTE, autoThreshold, largerFirst, markedPart, peakOf, type AbsorptionAnswer, type AbsorptionGroup, type AbsorptionMinute } from '../shared/absorption.ts';
import { clock, price as fmtPrice, usd } from './format.ts';
import { venueLabel } from './venues.ts';
import { t, tn } from './i18n.ts';
import { scaledUsd } from './coin.ts';
import type { InfoLine } from './infobox.ts';

/**
 * The page's side of absorption (the rule is in shared/absorption.ts): the threshold each instrument is judged at, and which recorded
 * groups are marks at that threshold. As in the order-flow tools, the threshold that applies now judges the whole history on screen, so
 * changing the settings, or the automatic threshold moving with the market, re-judges every mark.
 */

export interface AbsorptionSettings {
  /** Draw the marks. */
  on: boolean;
  /** `auto`: mean + k standard deviations of the window sums of the last `sdMinutes`, per instrument; `fixed`: `fixedUsd` for every one. */
  mode: 'auto' | 'fixed';
  k: number; sdMinutes: number; fixedUsd: number;
  /** Write the volume beside each mark. */
  volume: boolean;
}
export const ABSORPTION_DEFAULTS: Readonly<AbsorptionSettings> = { on: true, mode: 'auto', k: 10, sdMinutes: 30, fixedUsd: 250_000, volume: true };
export const ABSORPTION_LIMITS = { k: { min: 1.5, max: 50, step: 0.5 }, sdMinutes: { min: 1, max: 1_440 }, fixedUsd: { min: GROUP_FLOOR_USD, max: 1e9 } } as const;

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
/** Saved settings, each field checked (anything else is the default). */
export function readAbsorption(saved: unknown): AbsorptionSettings {
  const s = (saved ?? {}) as Partial<AbsorptionSettings>, d = ABSORPTION_DEFAULTS, L = ABSORPTION_LIMITS;
  return {
    on: typeof s.on === 'boolean' ? s.on : d.on,
    mode: s.mode === 'fixed' ? 'fixed' : 'auto',
    k: Math.round(clamp(s.k, L.k.min, L.k.max, d.k) / L.k.step) * L.k.step,
    sdMinutes: Math.round(clamp(s.sdMinutes, L.sdMinutes.min, L.sdMinutes.max, d.sdMinutes)),
    fixedUsd: clamp(s.fixedUsd, L.fixedUsd.min, L.fixedUsd.max, d.fixedUsd),
    volume: typeof s.volume === 'boolean' ? s.volume : d.volume,
  };
}

/** The side of the largest absorption square in view, and of the smallest any square is drawn at, in px. */
export const MARK_MAX_PX = 20, MARK_MIN_PX = 6;
/**
 * The side of an absorption square in px: its area in proportion to the USD it stands for, the largest square drawn (`largest`) at
 * MARK_MAX_PX, never smaller than MARK_MIN_PX. Compared with what is in view, as the trade bubbles are: zoomed out, the squares drawn are
 * the largest of hours (tens of millions each), and a fixed scale had capped every one of them at one size.
 */
export function markSize(usd: number, largest: number): number {
  if (!(largest > 0) || !(usd > 0)) return MARK_MIN_PX;
  return Math.max(MARK_MIN_PX, MARK_MAX_PX * Math.sqrt(Math.min(1, usd / largest)));
}

/** A mark: the marked part of one group at its instrument's threshold. */
export interface AbsorptionMark { id: string; side: 'buy' | 'sell'; price: number; t0: number; t1: number; usd: number; fills: number; peak: number; threshold: number }

/** Marks of one side closer than this (px) on both axes are drawn as one square. */
export const NEAR_PX = 12;
/** A square on the map: where its first (largest) mark is, and every mark it stands for. */
export interface MarkIcon { side: 'buy' | 'sell'; x: number; y: number; usd: number; marks: AbsorptionMark[] }

/**
 * The marks as squares on a plot `w` x `h` px: the largest first (equal ones in the order given), each joins the first square of its side
 * within NEAR_PX on both axes (its volume added) or starts one where it is; a mark more than NEAR_PX off the plot is left out. Squares never
 * move, so the ones a mark can join are in the 3 x 3 cells of NEAR_PX around it: the same squares as comparing it with every one, in one
 * pass. The cells' squares are linked lists in flat arrays over a grid of the plot and two cells around it, and marks given already the
 * largest first (the book's `marksByUsd`) are not sorted again: on the live page's 27,890 marks in view, 6 ms instead of 24-30.
 */
export function iconsOf(marks: readonly AbsorptionMark[], xOf: (m: AbsorptionMark) => number, yOf: (m: AbsorptionMark) => number, w: number, h: number): MarkIcon[] {
  let sorted = true;
  for (let i = 1; i < marks.length && sorted; i++) if (marks[i]!.usd > marks[i - 1]!.usd) sorted = false;
  const order = sorted ? marks : [...marks].sort((a, b) => b.usd - a.usd);
  const rows = Math.floor((h + NEAR_PX) / NEAR_PX) + 4, cols = Math.floor((w + NEAR_PX) / NEAR_PX) + 4;
  const head = new Int32Array(Math.max(1, cols * rows)).fill(-1), next: number[] = [], ix: number[] = [], iy: number[] = [], buy: boolean[] = [];
  const icons: MarkIcon[] = [];
  for (const m of order) {
    const x = xOf(m), y = yOf(m);
    if (!(x >= -NEAR_PX && x <= w + NEAR_PX && y >= -NEAR_PX && y <= h + NEAR_PX)) continue;
    const cx = Math.floor(x / NEAR_PX) + 2, cy = Math.floor(y / NEAR_PX) + 2, isBuy = m.side === 'buy';
    let joins = -1;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (let j = head[(cx + dx) * rows + cy + dy]!; j >= 0; j = next[j]!) {
        if ((joins < 0 || j < joins) && buy[j] === isBuy && Math.abs(ix[j]! - x) < NEAR_PX && Math.abs(iy[j]! - y) < NEAR_PX) joins = j;
      }
    }
    if (joins >= 0) { const icon = icons[joins]!; icon.usd += m.usd; icon.marks.push(m); continue; }
    const cell = cx * rows + cy;
    next.push(head[cell]!); head[cell] = icons.length; ix.push(x); iy.push(y); buy.push(isBuy);
    icons.push({ side: m.side, x, y, usd: m.usd, marks: [m] });
  }
  return icons;
}

const MINUTE = 60_000;
const keyOf = (g: AbsorptionGroup): string => `${g.id}|${g.side}|${g.price}|${g.t0}`;
/** The instrument and minute a group is kept under, as the recorder keeps it: the minute of its first fill. */
const slotOf = (g: AbsorptionGroup): string => `${g.id}|${Math.floor(g.t0 / MINUTE)}`;

/** A group judged a mark: its key, its place in the book's order (`#seq`), when it started and its mark. */
interface JudgedMark { key: string; seq: number; t0: number; mark: AbsorptionMark }
/** The marks of every group at one set of thresholds: in the book's order, and the largest first (equal ones in the book's order). */
interface Judged { version: number; thresholds: ReadonlyMap<string, number | null>; ids: string; wanted: ReadonlySet<string>; marks: JudgedMark[]; byUsd: JudgedMark[]; at: Map<string, JudgedMark> }
/** The order of `Judged.byUsd`: the largest first, equal ones in the book's order (what a stable sort of the book's order by size gives). */
const byUsd = (a: JudgedMark, b: JudgedMark): number => b.mark.usd - a.mark.usd || a.seq - b.seq;
/** The first place in `list` (ordered by `cmp`) that `x` is not after. */
function lowerBound<T>(list: readonly T[], x: T, cmp: (a: T, b: T) => number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cmp(list[mid]!, x) < 0) lo = mid + 1; else hi = mid; }
  return lo;
}
/** Versions of the book whose changes are remembered (for a judged list to catch up instead of judging every group again). */
const LOG_MAX = 256;
/** The most groups a judged list catches up with one by one (each moves a part of two long lists): past it, every group is judged again. */
const CATCH_UP_KEYS = 512;

/**
 * What the last history answer says the book holds: every group of its instruments that started in [from, to) (`to` is Infinity when the
 * answer reached the live edge, which the stream then keeps current) with a peak of at least what that instrument was asked from.
 */
export interface AbsorptionCover { from: number; to: number; mins: ReadonlyMap<string, number> }

/**
 * The recorded groups and minutes the page holds: what the window on screen was answered with, and what the live stream added since.
 *
 * It holds what the recorder holds. The live stream sends a group when it is found, and the recorder later lets the smallest of a busy
 * minute go (it keeps GROUPS_PER_MINUTE per instrument and minute): the book keeps each instrument's largest of a minute the same way, in the
 * same order (`largerFirst`, which settles equal peaks without regard to arrival), and those are the recorder's, since each of them was among
 * the largest when it was found, so it was sent. A page open through busy hours otherwise marked more than the recording did.
 *
 * And it lets go only of what can be asked for again. Past `max` groups it frees a tenth of its room: first what the last history answer
 * does not claim (`cover`: a group from outside its window, of an instrument it did not ask about, or under the peak its instrument was
 * asked from), the oldest first, which the hub asks for again if the view or a threshold comes to need it; then claimed groups older than
 * the map's view needs (`needFrom`), the oldest first, the cover starting after them so that a view moving back there asks again; and only
 * then claimed groups the view needs, the smallest first, each instrument's largest let go kept in `cut` so the map and the Range panel say
 * its marks may be incomplete. Letting the smallest go across every day held (as it once did) kept large groups of days ago that nobody was
 * looking at and dropped real marks of the hours on screen: a tab open since the day before lost a quarter of a selection's marks.
 */
export class AbsorptionBook {
  readonly #groups = new Map<string, AbsorptionGroup>();
  /** The groups of each instrument and minute (`slotOf`), so that keeping a minute's largest looks at that minute alone. */
  readonly #slots = new Map<string, Map<string, AbsorptionGroup>>();
  readonly #minutes = new Map<string, Map<number, AbsorptionMinute>>();
  #cover: AbsorptionCover | null = null;
  /** Where the map's view starts needing groups (the hub asks a quarter of the view further back than it shows); none before a view. */
  #needFrom = -Infinity;
  /**
   * Instruments whose marks may be missing, each with the largest peak that may be: from an answer cut at its limit (the smallest peak it
   * kept) or from claimed groups this book had to let go. A threshold at or under it may leave marks out.
   */
  readonly cut = new Map<string, number>();
  /**
   * Each instrument's highest minute floor over the window the last history answer covers (`cover`): the base floor, or raised to the peak of a
   * group a busy minute left out. Judged against a threshold as the absorption column judges it (shared/absorption.ts `AbsorptionProfile`), it
   * says where a minute kept only its largest groups and marks may be missing.
   */
  readonly floors = new Map<string, number>();
  /**
   * Every group that is a mark at the thresholds last asked for, with the time it started, in the order the groups came and the largest
   * first: judged whole only when the thresholds (a new map from the caller) or the instruments change; the groups added, changed or let go
   * since are judged into it one by one (`#log`; up to CATCH_UP_KEYS of them), so a frame that only moves the pointer or the map reads a
   * list, and a new live group costs its own judging instead of tens of thousands (on the live page 5-17 ms for each one found, about one a
   * second, a busy minute letting its smallest go as often). Two are kept, the one used last first: the map's and the Range panel's (which
   * judges with its own thresholds now and then) do not push each other out.
   */
  #judged: Judged[] = [];
  /** Each group's place in the order the groups came (`#groups`' own): numbered as it first enters, again if it enters again after going. */
  readonly #seq = new Map<string, number>();
  #nextSeq = 0;
  /** The groups the change under way added, changed or let go (by key), while `add` runs. */
  #touched: string[] | null = null;
  /**
   * What each version changed (the latest LOG_MAX): the keys of the groups added, changed or let go; none for a change that touched no
   * group (minutes); null for more than a judged list would catch up with.
   */
  #log: { version: number; keys: readonly string[] | null }[] = [];
  /** Bumped whenever anything changes, so a painter can tell its cache is stale. */
  version = 0;
  /** Bumped when the minutes change (the automatic threshold reads them): groups alone leave it, so a painter keeps its thresholds. */
  minutesVersion = 0;
  constructor(private max = 40_000, private perMinute = GROUPS_PER_MINUTE) {}

  get size(): number { return this.#groups.size; }
  /** What the last history answer claims the book holds (null before one). */
  get cover(): AbsorptionCover | null { return this.#cover; }
  /** The map's view needs groups from `from` on (the hub says so as the map draws): a full book may let claimed ones before it go first. */
  needFrom(from: number): void { this.#needFrom = from; }

  add(groups: readonly AbsorptionGroup[]): void {
    if (!groups.length) return;
    const crowded = new Set<string>(), touched: string[] = [];
    this.#touched = touched;
    for (const g of groups) {
      const key = keyOf(g), slot = slotOf(g);
      if (!this.#groups.has(key)) this.#seq.set(key, this.#nextSeq++);
      this.#groups.set(key, g); touched.push(key);
      let held = this.#slots.get(slot); if (!held) { held = new Map(); this.#slots.set(slot, held); }
      held.set(key, g);
      if (held.size > this.perMinute) crowded.add(slot);
    }
    for (const slot of crowded) {
      const held = this.#slots.get(slot)!;
      for (const [key, g] of [...held].sort((a, b) => largerFirst(a[1], b[1])).slice(this.perMinute)) this.#drop(key, g);
    }
    if (this.#groups.size > this.max) this.#evict();
    this.#touched = null;
    this.version++;
    this.#note(touched.length <= CATCH_UP_KEYS ? touched : null);
  }
  /** What this version changed, for the judged lists to catch up with (`#log`). */
  #note(keys: readonly string[] | null): void {
    this.#log.push({ version: this.version, keys });
    if (this.#log.length > LOG_MAX) this.#log.splice(0, this.#log.length - LOG_MAX);
  }

  #drop(key: string, g: AbsorptionGroup): void {
    this.#groups.delete(key); this.#seq.delete(key); this.#touched?.push(key);
    const slot = slotOf(g), held = this.#slots.get(slot);
    if (held) { held.delete(key); if (!held.size) this.#slots.delete(slot); }
  }

  /** Free a tenth of the room, in the order the class comment gives, down to nine tenths so it is not done again on every live push. */
  #evict(): void {
    const cover = this.#cover;
    const claims = (g: AbsorptionGroup): boolean => {
      if (!cover || g.t0 < cover.from || g.t0 >= cover.to) return false;
      const min = cover.mins.get(g.id);
      return min !== undefined && peakOf(g) >= min;
    };
    const free: [string, AbsorptionGroup][] = [], old: [string, AbsorptionGroup][] = [], shown: [string, AbsorptionGroup][] = [];
    for (const entry of this.#groups) (!claims(entry[1]) ? free : entry[1].t0 < this.#needFrom ? old : shown).push(entry);
    const byAge = (a: [string, AbsorptionGroup], b: [string, AbsorptionGroup]): number => a[1].t0 - b[1].t0;
    let excess = this.#groups.size - Math.floor(this.max * 0.9);
    for (const [key, g] of free.sort(byAge)) { if (excess <= 0) return; this.#drop(key, g); excess--; }
    for (const [key, g] of old.sort(byAge)) {
      if (excess <= 0) return;
      this.#drop(key, g); excess--;
      // What is still claimed starts after it: the view does not reach back there, and a view that does is not covered and asks again.
      this.#cover = { ...this.#cover!, from: Math.max(this.#cover!.from, g.t0 + 1) };
    }
    for (const [key, g] of shown.sort((a, b) => peakOf(a[1]) - peakOf(b[1]))) {
      if (excess <= 0) return;
      this.#drop(key, g); excess--;
      this.cut.set(g.id, Math.max(this.cut.get(g.id) ?? 0, peakOf(g)));
    }
  }

  addMinutes(minutes: readonly AbsorptionMinute[]): void {
    if (!minutes.length) return;
    for (const m of minutes) {
      let byTime = this.#minutes.get(m.id); if (!byTime) { byTime = new Map(); this.#minutes.set(m.id, byTime); }
      byTime.set(m.t, m);
    }
    const cutoff = Date.now() - 25 * 3_600_000;
    for (const byTime of this.#minutes.values()) for (const t of byTime.keys()) if (t < cutoff) byTime.delete(t);
    this.version++; this.minutesVersion++;
    this.#note([]);
  }

  /**
   * Take a history answer for a window: its groups and minutes join what is held. `cover` is what it was asked for (the hub gives it when the
   * answer belongs to the connection it was asked on), taken before the groups, so a full book never lets the fresh answer go first; it starts
   * a new `cut` with the instruments the answer cut at its limit, each at the smallest peak it kept.
   */
  load(answer: AbsorptionAnswer, cover: AbsorptionCover | null = null): void {
    if (cover) {
      this.#cover = cover; this.cut.clear(); this.floors.clear();
      for (const [id, floor] of Object.entries(answer.floors)) if (Number.isFinite(floor)) this.floors.set(id, floor);
      for (const id of answer.capped) {
        let least = Infinity; for (const g of answer.groups) if (g.id === id) least = Math.min(least, peakOf(g));
        if (Number.isFinite(least)) this.cut.set(id, least);
      }
    }
    this.add(answer.groups); this.addMinutes(answer.minutes);
    this.version++;
    this.#note([]);
  }

  /**
   * The threshold each instrument is judged at now: the fixed amount, or mean + k standard deviations of the window sums in the complete
   * minutes of the last `sdMinutes` (null for an instrument with none yet: nothing of it is marked).
   */
  thresholds(ids: readonly string[], s: AbsorptionSettings, now: number): Map<string, number | null> {
    const out = new Map<string, number | null>(), end = Math.floor(now / MINUTE) * MINUTE, start = end - s.sdMinutes * MINUTE;
    for (const id of ids) {
      if (s.mode === 'fixed') { out.set(id, scaledUsd(s.fixedUsd)); continue; }
      const minutes: AbsorptionMinute[] = [];
      for (const [t, m] of this.#minutes.get(id) ?? []) if (t >= start && t < end) minutes.push(m);
      out.set(id, autoThreshold(minutes, s.k));
    }
    return out;
  }

  /**
   * The marks in a window of the map: groups of `ids` that start in [t0 - window, t1] at a price in [p0, p1] and reach their instrument's
   * threshold. The marks are shared between calls: read them, never change them.
   */
  marks(ids: readonly string[], thresholds: ReadonlyMap<string, number | null>, t0: number, t1: number, p0: number, p1: number): AbsorptionMark[] {
    return this.#within(this.#judge(ids, thresholds).marks, t0, t1, p0, p1);
  }
  /** The same marks, the largest first (equal ones in the order the groups came): what the map lays out as squares (`iconsOf`) without sorting. */
  marksByUsd(ids: readonly string[], thresholds: ReadonlyMap<string, number | null>, t0: number, t1: number, p0: number, p1: number): AbsorptionMark[] {
    return this.#within(this.#judge(ids, thresholds).byUsd, t0, t1, p0, p1);
  }
  #within(list: readonly JudgedMark[], t0: number, t1: number, p0: number, p1: number): AbsorptionMark[] {
    const out: AbsorptionMark[] = [], from = t0 - ABSORPTION_WINDOW_MS;
    for (const { t0: start, mark } of list) if (start >= from && start <= t1 && mark.price >= p0 && mark.price <= p1) out.push(mark);
    return out;
  }
  /** The judged list for these instruments and thresholds, as the book stands now: kept, caught up with the groups added since, or judged whole. */
  #judge(ids: readonly string[], thresholds: ReadonlyMap<string, number | null>): Judged {
    const idsKey = ids.join(',');
    let judged = this.#judged.find(j => j.thresholds === thresholds && j.ids === idsKey);
    if (judged && judged.version !== this.version && !this.#catchUp(judged)) judged = undefined;
    if (!judged) {
      const made: Judged = { version: this.version, thresholds, ids: idsKey, wanted: new Set(ids), marks: [], byUsd: [], at: new Map() };
      for (const [key, g] of this.#groups) { const m = this.#markOf(made, key, g); if (m) { made.marks.push(m); made.at.set(key, m); } }
      made.byUsd = [...made.marks].sort(byUsd);
      judged = made;
    }
    const first = judged;
    this.#judged = [first, ...this.#judged.filter(j => j !== first)].slice(0, 2);
    return first;
  }
  /** Group `g` (kept under `key`) as a mark of `judged`'s thresholds, or null. */
  #markOf(judged: Judged, key: string, g: AbsorptionGroup): JudgedMark | null {
    if (!judged.wanted.has(g.id)) return null;
    const threshold = judged.thresholds.get(g.id);
    if (threshold === null || threshold === undefined || peakOf(g) < threshold) return null;
    const part = markedPart(g, threshold);
    return part ? { key, seq: this.#seq.get(key)!, t0: g.t0, mark: { id: g.id, side: g.side, price: g.price, t0: part.t0, t1: part.t1, usd: part.usd, fills: part.fills, peak: part.peak, threshold } } : null;
  }
  /**
   * Bring `judged` up to the book's version from the log: each group added, changed or let go since it was judged takes its place as the book
   * holds it now (its mark out, its mark now in, in both orders), which is what judging every group again gives, the others being as they
   * were; false, and nothing changed, where the log does not reach back or holds more than CATCH_UP_KEYS groups.
   */
  #catchUp(judged: Judged): boolean {
    const log = this.#log, start = log.findIndex(e => e.version > judged.version);
    if (start < 0 || log[start]!.version !== judged.version + 1) return false;
    const touched = new Set<string>();
    for (let i = start; i < log.length; i++) { const keys = log[i]!.keys; if (keys === null) return false; for (const key of keys) touched.add(key); }
    if (touched.size > CATCH_UP_KEYS) return false;
    for (const key of touched) {
      const now = this.#groups.get(key), was = judged.at.get(key), mark = now ? this.#markOf(judged, key, now) : null;
      if (was) {
        judged.marks.splice(lowerBound(judged.marks, was, (a, b) => a.seq - b.seq), 1);
        judged.byUsd.splice(lowerBound(judged.byUsd, was, byUsd), 1);
        judged.at.delete(key);
      }
      if (mark) {
        judged.marks.splice(lowerBound(judged.marks, mark, (a, b) => a.seq - b.seq), 0, mark);
        judged.byUsd.splice(lowerBound(judged.byUsd, mark, byUsd), 0, mark);
        judged.at.set(key, mark);
      }
    }
    judged.version = this.version;
    return true;
  }

  /** The highest floor of `id` over [from, to): the last answer's (`floors`) with the minutes held there, the live stream's among them. */
  floorIn(id: string, from: number, to: number): number | undefined {
    let top = this.floors.get(id);
    for (const [t, m] of this.#minutes.get(id) ?? []) if (t >= from && t < to && (top === undefined || m.floor > top)) top = m.floor;
    return top;
  }

  /** The lowest threshold of these instruments, never under the recorder's floor: what a history question needs to ask for. */
  static lowest(thresholds: ReadonlyMap<string, number | null>): number {
    let low = Infinity; for (const v of thresholds.values()) if (v !== null && v < low) low = v;
    const floor = scaledUsd(GROUP_FLOOR_USD);
    return Math.max(floor, Number.isFinite(low) ? low : floor);
  }
}

/** What the passive side did, in words: passive buyers took market sells, passive sellers took market buys. */
export const passiveText = (side: 'buy' | 'sell', amount: number): string => side === 'sell'
  ? t('Passive buyers took ${value} of market sells', { value: usd(amount) })
  : t('Passive sellers took ${value} of market buys', { value: usd(amount) });

/** A time to the millisecond (absorption happens inside a window of a few milliseconds). */
const precise = (time: number): string => `${clock(time, true)}:${String(new Date(time).getSeconds()).padStart(2, '0')}.${String(time % 1000).padStart(3, '0')}`;

/** How the threshold was set, in words. */
export function thresholdText(s: AbsorptionSettings, threshold: number): string {
  return s.mode === 'fixed' ? t('${value}, fixed', { value: usd(threshold) }) : t('${value}: mean + {k} SD of the last {minutes} min', { value: usd(threshold), k: s.k, minutes: s.sdMinutes });
}

/** The box for one or more marks under the pointer (marks drawn as one icon are on one side, and are summed). */
export function markLines(marks: readonly AbsorptionMark[], s: AbsorptionSettings): InfoLine[] {
  const side = marks[0]!.side, total = marks.reduce((a, m) => a + m.usd, 0), lines: InfoLine[] = [];
  lines.push({ text: t('ABSORPTION'), bold: true, color: side === 'sell' ? 'buy' : 'sell' });
  lines.push({ text: passiveText(side, total), wrap: true });
  if (marks.length === 1) {
    const m = marks[0]!, symbol = m.id.split(':').slice(1).join(':');
    lines.push({ label: t('Venue'), text: `${venueLabel(m.id)} ${symbol}`, rule: true, mark: m.id }, { label: t('Price'), text: fmtPrice(m.price) });
    lines.push({ label: t('Time'), text: m.t1 > m.t0 ? `${precise(m.t0)} +${m.t1 - m.t0} ms` : precise(m.t0) });
    lines.push({ label: t('Fills'), text: String(m.fills) }, { label: t('Largest window'), text: `$${usd(m.peak)}` });
    lines.push({ label: t('Threshold'), text: thresholdText(s, m.threshold) });
  } else {
    const venues = [...new Set(marks.map(m => venueLabel(m.id)))].join(', ');
    lines.push({ label: t('Marks'), text: tn(marks.length, '{n} mark', '{n} marks', { n: marks.length.toLocaleString('en-US') }), rule: true }, { label: t('Venue'), text: venues });
    const lo = Math.min(...marks.map(m => m.price)), hi = Math.max(...marks.map(m => m.price));
    lines.push({ label: t('Price'), text: lo === hi ? fmtPrice(lo) : `${fmtPrice(lo)} – ${fmtPrice(hi)}` });
  }
  lines.push({ text: t('Market orders of one side met resting orders at one price within {ms} ms. It marks what traded, not what price did next.', { ms: ABSORPTION_WINDOW_MS }), color: 'muted', wrap: true, rule: true });
  return lines;
}
