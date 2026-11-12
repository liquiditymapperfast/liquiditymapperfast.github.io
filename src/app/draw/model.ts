/**
 * The drawings a person puts on the map (Karl, 2026-10-28: "a full suite of analysis tools ... minimalistic but the most useful"): the kinds,
 * what each is made of, and the rules a saved one must pass. Pure, so every rule here is tested (tests/draw-model.test.mts).
 *
 * A drawing is anchored in time and price, never in candles, so another timeframe, zoom or market of the same coin draws it where it was
 * put. Its time is UTC milliseconds and its price the coin's price; a vertical line's price and a level's time only place their handles.
 */

/**
 * The kinds: a level across the map at one price (or a ray to the right from its anchor), a trend line between two points (a segment, or run
 * on past either end), a zone between two corners, a vertical line at a moment, a note pinned to a point, a Fibonacci retracement between two
 * swings, a parallel channel (a line between two points and its parallel through a third) and a position (an entry, its stop and its
 * target over a stretch of time: a long when the stop is below the entry, a short when it is above; an X request of 2026-11-12, which
 * reverses the round of 2026-10-28 that had left positions out as a trading platform's tool).
 */
export type DrawKind = 'level' | 'trend' | 'zone' | 'vline' | 'note' | 'fib' | 'channel' | 'position';
export const DRAW_KINDS: readonly DrawKind[] = ['level', 'trend', 'zone', 'vline', 'note', 'fib', 'channel', 'position'];
/**
 * How many points each kind is placed with, one click or tap each, and keeps. A position is placed by its entry, its stop and its target
 * and kept as [entry at its start, stop at its end, target at its end] (`positionFromClicks`).
 */
export const ANCHORS: Readonly<Record<DrawKind, number>> = { level: 1, trend: 2, zone: 2, vline: 1, note: 1, fib: 2, channel: 3, position: 3 };

export interface Anchor { t: number; p: number }

/**
 * The colours a drawing can take: the theme's text colour, three hues that read on every theme and are none of the map's own colours, the
 * theme's point-of-control purple, and its buy and sell colours (theme.ts), so a drawing reads on every theme.
 */
export type DrawColor = 'ink' | 'blue' | 'amber' | 'purple' | 'bid' | 'ask';
export const DRAW_COLORS: readonly DrawColor[] = ['ink', 'blue', 'amber', 'purple', 'bid', 'ask'];
export const DRAW_WIDTHS = [1, 2, 3] as const;
export type DrawWidth = (typeof DRAW_WIDTHS)[number];
export interface DrawStyle { color: DrawColor; width: DrawWidth; dashed: boolean }

export interface Drawing {
  /** Given once, never changed (`newId`). */
  id: string;
  kind: DrawKind;
  /** `ANCHORS[kind]` of them, in the order they were placed. */
  points: Anchor[];
  style: DrawStyle;
  /** A line runs on past its first point (left) and past its last (right); a level with no left is a ray from its anchor to the right. */
  extendLeft: boolean;
  extendRight: boolean;
  /** A note's text, and the label other kinds may carry (empty: none). */
  text: string;
  /** A note's line from its text to the point it marks. */
  leader: boolean;
  /** Cannot be moved, edited or deleted until unlocked; still selectable. */
  locked: boolean;
  hidden: boolean;
  /** A level that sounds when the price reaches it (through the page's Sound switch). */
  alert: boolean;
  /** When it was made (ms): the order the list shows them in. */
  created: number;
}

/** How many drawings a coin keeps, how many in all, how long a text may be, and how many steps back Undo goes. */
export const MAX_PER_COIN = 100, MAX_TOTAL = 1000, MAX_TEXT = 500, MAX_UNDO = 100;
/** A time that can be on the chart: from the first exchange to well beyond the page's life. */
const T_MIN = Date.UTC(2009, 0, 1), T_MAX = Date.UTC(2100, 0, 1);

/** A level runs across the whole map; a trend line, a zone, a Fibonacci and a channel end at their points; a note has its line to its point. */
const DEFAULTS: Readonly<Record<DrawKind, Pick<Drawing, 'extendLeft' | 'extendRight' | 'leader' | 'style'>>> = {
  level: { extendLeft: true, extendRight: true, leader: false, style: { color: 'blue', width: 1, dashed: false } },
  trend: { extendLeft: false, extendRight: false, leader: false, style: { color: 'ink', width: 2, dashed: false } },
  zone: { extendLeft: false, extendRight: false, leader: false, style: { color: 'blue', width: 2, dashed: false } },
  vline: { extendLeft: false, extendRight: false, leader: false, style: { color: 'ink', width: 1, dashed: true } },
  note: { extendLeft: false, extendRight: false, leader: true, style: { color: 'amber', width: 1, dashed: false } },
  fib: { extendLeft: false, extendRight: false, leader: false, style: { color: 'purple', width: 1, dashed: false } },
  channel: { extendLeft: false, extendRight: false, leader: false, style: { color: 'blue', width: 1, dashed: false } },
  // Drawn in the theme's rising and falling colours whatever its own; the style is kept for the list's swatch and a future choice.
  position: { extendLeft: false, extendRight: false, leader: false, style: { color: 'ink', width: 1, dashed: false } },
};

/**
 * Whether a position's points make one: its stop and its target at one time after its entry's, and on opposite sides of the entry, neither
 * at it (a risk of nothing has no ratio). The one rule placing, every change and reading a saved one go by (`fits`).
 */
export function positionOk(points: readonly Anchor[]): boolean {
  const [e, s, g] = points;
  if (!e || !s || !g || points.length !== 3) return false;
  return s.t === g.t && s.t > e.t && e.p > 0 && s.p > 0 && g.p > 0 && s.p !== e.p && g.p !== e.p && (s.p < e.p) === (g.p > e.p);
}

/** A long (the stop below the entry) or a short (above it). */
export const positionSide = (d: Pick<Drawing, 'points'>): 'long' | 'short' => d.points[1]!.p < d.points[0]!.p ? 'long' : 'short';

/**
 * A position from the points clicked: the entry (its time is where the position starts), the stop, and the target (or, while only the stop
 * is placed, a target twice as far as the stop on the other side, to show the shape). It ends where the target was clicked (the stop while
 * there is none), or `span` after the entry when that is less than `min` after it (at or before it, or a few pixels right of an upright
 * gesture, which would make a box too narrow to take hold of). Null when the stop is at the entry, the target on the stop's side or a price
 * at or below zero.
 */
export function positionFromClicks(clicks: readonly Anchor[], span: number, min = 0): Anchor[] | null {
  const [e, s, g] = clicks;
  if (!e || !s || !(span > 0)) return null;
  // The shape's target, twice as far as the stop, stays above zero for a short with a stop far above its entry (half the entry at most).
  const target = g ? g.p : s.p < e.p ? e.p + 2 * (e.p - s.p) : Math.max(e.p - 2 * (s.p - e.p), e.p / 2), last = (g ?? s).t, end = last - e.t >= Math.max(min, Number.MIN_VALUE) ? last : e.t + Math.max(span, min);
  const points = [{ t: e.t, p: e.p }, { t: end, p: s.p }, { t: end, p: target }];
  return positionOk(points) ? points : null;
}

/** What a position says: its side, prices, how far its stop (the risk) and its target (the reward) are from the entry, and their ratio. */
export interface PositionFigures { side: 'long' | 'short'; entry: number; stop: number; target: number; risk: number; reward: number; riskPct: number; rewardPct: number; ratio: number }
export function positionFigures(d: Pick<Drawing, 'points'>): PositionFigures {
  const [e, s, g] = d.points as [Anchor, Anchor, Anchor];
  const risk = Math.abs(e.p - s.p), reward = Math.abs(g.p - e.p);
  return { side: positionSide(d), entry: e.p, stop: s.p, target: g.p, risk, reward, riskPct: risk / e.p * 100, rewardPct: reward / e.p * 100, ratio: risk > 0 ? reward / risk : NaN };
}

/** A position turned the other way: its stop and its target as far from the entry on the other side (a long becomes a short). */
export function flipped(d: Drawing): Drawing {
  const [e, s, g] = d.points as [Anchor, Anchor, Anchor];
  return { ...d, points: [{ ...e }, { t: s.t, p: 2 * e.p - s.p }, { t: g.t, p: 2 * e.p - g.p }] };
}

/** The retracement's levels, as shares of the move from its second point back toward its first (0 at the second, 1 at the first). */
export const FIB_RATIOS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

let counter = 0;
/** A new id: the time, a counter and a random part, so two drawings never share one, even made in two tabs in the same millisecond. */
export function newId(now: number = Date.now()): string {
  counter = (counter + 1) % 1_679_616;
  return `d${now.toString(36)}${counter.toString(36).padStart(4, '0')}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`;
}

/** A new drawing of `kind` on `points`, in the kind's own look. */
export function newDrawing(kind: DrawKind, points: readonly Anchor[], now: number = Date.now()): Drawing {
  const d = DEFAULTS[kind];
  return { id: newId(now), kind, points: points.slice(0, ANCHORS[kind]).map(q => ({ t: q.t, p: q.p })), style: { ...d.style }, extendLeft: d.extendLeft, extendRight: d.extendRight, text: '', leader: d.leader, locked: false, hidden: false, alert: false, created: now };
}

/** The same drawing moved by `dt` and `dp` (every point by the same amount, so its shape stays). */
export function moved(d: Drawing, dt: number, dp: number): Drawing {
  return { ...d, points: d.points.map(q => ({ t: q.t + dt, p: q.p + dp })) };
}

/** A copy of a drawing under a new id, a little later and lower than the original, so it is seen apart from it. */
export function duplicate(d: Drawing, dt: number, dp: number, now: number = Date.now()): Drawing {
  return { ...moved(d, dt, dp), id: newId(now), created: now, alert: false };
}

const ID = /^d[0-9a-z]{4,24}$/;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const flag = (v: unknown, fallback: boolean): boolean => typeof v === 'boolean' ? v : fallback;

/** One saved point, checked: a time on the chart and a price above zero; null for anything else. */
function readAnchor(raw: unknown): Anchor | null {
  const a = raw as { t?: unknown; p?: unknown } | null;
  if (!a || typeof a !== 'object' || !finite(a.t) || !finite(a.p) || a.t < T_MIN || a.t > T_MAX || !(a.p > 0)) return null;
  return { t: a.t, p: a.p };
}

/**
 * One saved drawing, checked field by field: a known kind with exactly its number of points, each a time on the chart and a price above
 * zero, and an id of its own form; anything else is dropped (null). Its look falls back to the kind's where a field is not one of the choices.
 */
export function readDrawing(raw: unknown): Drawing | null {
  const s = raw as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !ID.test(s.id) || !DRAW_KINDS.includes(s.kind as DrawKind)) return null;
  const kind = s.kind as DrawKind;
  if (!Array.isArray(s.points) || s.points.length !== ANCHORS[kind]) return null;
  const points: Anchor[] = [];
  for (const q of s.points) { const a = readAnchor(q); if (!a) return null; points.push(a); }
  if (kind === 'position' && !positionOk(points)) return null;
  const d = DEFAULTS[kind], style = (s.style && typeof s.style === 'object' ? s.style : {}) as Record<string, unknown>;
  return {
    id: s.id, kind, points,
    style: {
      color: DRAW_COLORS.includes(style.color as DrawColor) ? style.color as DrawColor : d.style.color,
      width: DRAW_WIDTHS.includes(style.width as DrawWidth) ? style.width as DrawWidth : d.style.width,
      dashed: flag(style.dashed, d.style.dashed),
    },
    extendLeft: flag(s.extendLeft, d.extendLeft), extendRight: flag(s.extendRight, d.extendRight),
    text: typeof s.text === 'string' ? s.text.slice(0, MAX_TEXT) : '',
    leader: flag(s.leader, d.leader), locked: flag(s.locked, false), hidden: flag(s.hidden, false),
    // Only a level sounds.
    alert: kind === 'level' && flag(s.alert, false),
    created: finite(s.created) ? s.created : 0,
  };
}

/**
 * Whether a drawing can be kept as it is: every point a time on the chart and a price above zero, and a position one (`positionOk`): what
 * `readDrawing` will read back.
 */
export const fits = (d: Pick<Drawing, 'points' | 'kind'>): boolean => d.points.every(q => readAnchor(q) !== null) && (d.kind !== 'position' || positionOk(d.points));

/**
 * The drawings kept, by coin. Version 2 is a document that holds a position: a page from before positions reads a document of a version
 * above 1 as a newer page's, shows none of it and writes nothing over it, where it would have dropped the positions it does not know at its
 * next save. Without one the document stays version 1, which every page reads.
 */
export interface DrawDoc { version: 1 | 2; coins: Record<string, Drawing[]> }
export const DRAW_DOC_VERSION = 2;
/** The version a document is written as: 2 when it holds a position, else 1. */
export const versionOf = (coins: Readonly<Record<string, readonly Drawing[]>>): 1 | 2 => Object.values(coins).some(list => list.some(d => d.kind === 'position')) ? 2 : 1;
const COIN = /^[A-Za-z0-9._-]{1,24}$/;

/**
 * A saved document, checked: a newer version than this page reads is not read at all (null, so nothing of it is overwritten by mistake: the
 * caller keeps it as it is); a coin's list keeps its valid drawings, each id once, at most `MAX_PER_COIN`, oldest first.
 */
export function readDoc(raw: unknown): DrawDoc | null {
  const s = raw as { version?: unknown; coins?: unknown } | null;
  if (!s || typeof s !== 'object') return { version: 1, coins: {} };
  if (finite(s.version) && s.version > DRAW_DOC_VERSION) return null;
  const coins: Record<string, Drawing[]> = {};
  if (s.coins && typeof s.coins === 'object') {
    for (const [coin, list] of Object.entries(s.coins as Record<string, unknown>)) {
      if (!COIN.test(coin) || coin.startsWith('__') || !Array.isArray(list)) continue;
      const seen = new Set<string>(), kept: Drawing[] = [];
      for (const item of list) { const d = readDrawing(item); if (d && !seen.has(d.id)) { seen.add(d.id); kept.push(d); } }
      if (kept.length) coins[coin] = kept.sort((a, b) => a.created - b.created).slice(-MAX_PER_COIN);
    }
  }
  return { version: versionOf(coins), coins };
}

/** How many drawings a document holds in all. */
export const totalOf = (doc: DrawDoc): number => Object.values(doc.coins).reduce((n, list) => n + list.length, 0);

/** Why a coin cannot take `adding` more drawings (its own cap or the document's), or null when it can. */
export function capReached(doc: DrawDoc, coin: string, adding = 1): 'coin' | 'total' | null {
  if ((doc.coins[coin]?.length ?? 0) + adding > MAX_PER_COIN) return 'coin';
  if (totalOf(doc) + adding > MAX_TOTAL) return 'total';
  return null;
}

/** The file drawings are written to and read back from. */
export const DRAW_FILE_FORMAT = 'liquiditymapperfast-drawings';
export const MAX_IMPORT_CHARS = 4 * 1_048_576;

/**
 * Drawings read from a file, added to what a document holds: each coin's after its own, each with a new id where its id is taken, nothing
 * past the caps (the answer says how many were left out and why). A file of another format, or of a newer version, adds nothing.
 */
export function importInto(doc: DrawDoc, text: string, now: number = Date.now()): { doc: DrawDoc; added: number; skipped: number; error: 'format' | 'version' | 'size' | null } {
  if (text.length > MAX_IMPORT_CHARS) return { doc, added: 0, skipped: 0, error: 'size' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { doc, added: 0, skipped: 0, error: 'format' }; }
  const file = raw as { format?: unknown; version?: unknown } | null;
  if (!file || typeof file !== 'object' || file.format !== DRAW_FILE_FORMAT) return { doc, added: 0, skipped: 0, error: 'format' };
  const read = readDoc(raw);
  if (!read) return { doc, added: 0, skipped: 0, error: 'version' };
  const coins: Record<string, Drawing[]> = Object.fromEntries(Object.entries(doc.coins).map(([c, list]) => [c, [...list]]));
  const taken = new Set(Object.values(coins).flatMap(list => list.map(d => d.id)));
  let added = 0, skipped = 0, total = totalOf(doc);
  for (const [coin, list] of Object.entries(read.coins)) {
    const into = Object.hasOwn(coins, coin) ? coins[coin]! : (coins[coin] = []);
    for (const d of list) {
      if (into.length >= MAX_PER_COIN || total >= MAX_TOTAL) { skipped++; continue; }
      const id = taken.has(d.id) ? newId(now) : d.id;
      taken.add(id); into.push({ ...d, id }); added++; total++;
    }
    if (!into.length) delete coins[coin];
  }
  return { doc: { version: versionOf(coins), coins }, added, skipped, error: null };
}

/** A document as a file to keep: its format, version and the drawings. */
export function exportText(doc: DrawDoc): string {
  return JSON.stringify({ format: DRAW_FILE_FORMAT, version: versionOf(doc.coins), coins: doc.coins });
}
