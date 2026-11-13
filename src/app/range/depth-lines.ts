import { clock } from '../format.ts';
import { t, tn } from '../i18n.ts';
import { bandText } from '../depth-settings.ts';
import { durationPair, durationText, spanText } from './oi-lines.ts';
import { valueFormat } from './script-lines.ts';
import type { RangeSelection } from './selection.ts';
import type { GridItem, RangeLine } from './stats.ts';

/** One snapshot of the tracked liquidation levels as the Depth pane holds it: when its positions stood, when it was fetched, its buckets. */
export interface DepthLiqRow { asOf: number; fetchedAt: number; long: ArrayLike<number>; short: ArrayLike<number>; longCoin: ArrayLike<number>; shortCoin: ArrayLike<number> }

/** How long a liquidation levels snapshot holds when no later one comes (the pane's rule). */
export const LIQ_HOLD = 90 * 60_000;

/**
 * What the Depth pane drew last, handed to its Range summary (provider.ts): its display columns (`w` over [t0, t1]) with each band's bids and
 * asks (`bid[x * k + j]`, in dollars and coins), the bands as answered, and what it was asked for. The order book (`book`): how many of the
 * venues asked for had a book column in each display column, whether a price centre could be found there, the book columns' own length and
 * when the answer came back. Liquidation levels (`liq`): the snapshots and the bucket each band reads. The same object while none of that
 * changes.
 */
export interface DepthPaneHeld {
  /** What it was asked for (`depthHeldKey`): the source, the venues (book) and the bands drawn; another is not summed up as this one. */
  key: string;
  source: 'book' | 'liq';
  ids: readonly string[];
  t0: number; t1: number; w: number;
  radii: readonly number[];
  bid: Float32Array; ask: Float32Array; bidCoin: Float32Array; askCoin: Float32Array;
  /** Book: per column, how many of `ids` had a book column touching it (an empty book counts), and 1 where a price centre was found. */
  present: Uint16Array | null; centred: Uint8Array | null;
  /** Book: the book columns' length (ms): a display column's figures are means of the book columns that touch it. */
  stepMs: number;
  /** Book: when the answer came back (the page's clock): a book minute not over by then was read mid-minute. */
  answeredAt: number;
  /** Liquidation levels: the snapshots (oldest first), the bucket each band reads (-1: none), and the bands asked beyond the history's reach. */
  rows: readonly DepthLiqRow[] | null; buckets: readonly number[] | null; omitted: readonly number[];
  /** The units the pane draws in (coins: the chart coin), and the band it watches (its index). */
  coins: boolean; coin: string; focus: number;
}

/** What a Depth snapshot stands for: its source, the venues (the order book's) and the bands. */
export const depthHeldKey = (source: 'book' | 'liq', ids: readonly string[], radii: readonly number[]): string => `${source}|${source === 'book' ? ids.join(',') : ''}|${radii.join(',')}`;

/** One band over the selection: time-weighted means of bids and asks, first and last measured column, and the mean of the columns' imbalances. */
export interface DepthBand { r: number; bid: number; ask: number; firstBid: number; firstAsk: number; lastBid: number; lastAsk: number; imbalance: number | null }

/**
 * The order book over a selection, from the display columns that overlap it (each counting for the time it overlaps): only columns whose book
 * columns all closed by now and by the answer (in a replay, by its moment: a book column is a minute's mean, so one the moment falls inside
 * holds the book after it), that hold every venue asked for and where a price centre was found. The rest of the span (the selection up to
 * now) is said: lacking a venue, no price centre, an unfinished book minute, no book, outside the columns drawn.
 */
export interface DepthStretch {
  span: number; covered: number; lacking: number; uncentred: number; open: number; none: number; outside: number;
  columns: number;
  /** The first measured column's start and the last's end. */
  first: number; last: number;
  bands: DepthBand[];
  settled: boolean;
}

/** A display column's interval. */
const colSpan = (h: Pick<DepthPaneHeld, 't0' | 't1' | 'w'>, x: number): [number, number] => [h.t0 + x / h.w * (h.t1 - h.t0), h.t0 + (x + 1) / h.w * (h.t1 - h.t0)];
/** The time of [a, b) outside the columns the pane holds, [t0, t1). */
const outsideOf = (held: Pick<DepthPaneHeld, 't0' | 't1'>, a: number, b: number): number => Math.max(0, b - a) - Math.max(0, Math.min(b, held.t1) - Math.max(a, held.t0));

export function depthStretch(held: DepthPaneHeld, sel: Pick<RangeSelection, 't0' | 't1'>, now: number): DepthStretch {
  const k = held.radii.length, want = held.ids.length, step = held.stepMs, coins = held.coins, closedBy = Math.min(now, held.answeredAt);
  const bid = coins ? held.bidCoin : held.bid, ask = coins ? held.askCoin : held.ask;
  const end = Math.min(sel.t1, Math.max(sel.t0, now)), span = Math.max(0, end - sel.t0);
  let covered = 0, lacking = 0, uncentred = 0, open = 0, columns = 0, first = NaN, last = NaN, unsettled = false;
  const sumB = new Float64Array(k), sumA = new Float64Array(k), sumI = new Float64Array(k), timeI = new Float64Array(k);
  // First and last: of the measured columns wholly inside the selection where there are any (a column across its edge is a mean that takes
  // in the book minute beyond it), else of those across its edges.
  let xFirstIn = -1, xLastIn = -1, xFirst = -1, xLast = -1;
  for (let x = 0; x < held.w; x++) {
    const [c0, c1] = colSpan(held, x);
    if (c1 <= sel.t0 || c0 >= sel.t1) continue;
    const dt = Math.max(0, Math.min(c1, end) - Math.max(c0, sel.t0));
    // Every book column starting before the column's end touches it: the last of them ends at the next multiple of the step at or after it.
    const lastEnd = step > 0 ? Math.ceil(c1 / step) * step : c1;
    // Begun by the answer: open (an unfinished book minute); begun after it: never read, so no book in what the pane holds.
    if (lastEnd > closedBy) { if (c0 < closedBy) open += dt; unsettled = true; continue; }
    const p = held.present?.[x] ?? 0;
    if (p === 0) continue;
    if (p < want) { lacking += dt; continue; }
    if (!held.centred?.[x]) { uncentred += dt; continue; }
    if (dt <= 0) continue;
    covered += dt; columns++;
    if (xFirst < 0) xFirst = x;
    xLast = x;
    if (c0 >= sel.t0 && c1 <= sel.t1) { if (xFirstIn < 0) xFirstIn = x; xLastIn = x; }
    for (let j = 0; j < k; j++) {
      const b = bid[x * k + j]!, a = ask[x * k + j]!;
      sumB[j]! += dt * b; sumA[j]! += dt * a;
      if (b + a > 0) { sumI[j]! += dt * (b - a) / (b + a); timeI[j]! += dt; }
    }
  }
  const xa = xFirstIn >= 0 ? xFirstIn : xFirst, xb = xLastIn >= 0 ? xLastIn : xLast;
  if (xa >= 0) { first = colSpan(held, xa)[0]; last = colSpan(held, xb)[1]; }
  const at = (x: number, side: Float32Array, j: number): number => x >= 0 ? side[x * k + j]! : NaN;
  const outside = outsideOf(held, sel.t0, end), none = Math.max(0, span - covered - lacking - uncentred - open - outside);
  const bands: DepthBand[] = covered > 0 ? held.radii.map((r, j) => ({ r, bid: sumB[j]! / covered, ask: sumA[j]! / covered, firstBid: at(xa, bid, j), firstAsk: at(xa, ask, j), lastBid: at(xb, bid, j), lastAsk: at(xb, ask, j), imbalance: timeI[j]! > 0 ? sumI[j]! / timeI[j]! : null })) : [];
  return { span, covered, lacking, uncentred, open, none, outside, columns, first, last, bands, settled: !unsettled && sel.t1 <= closedBy };
}

/**
 * The tracked liquidation levels over a selection: the snapshots actually in force in it (each from its fetch until the next fetch, at most
 * 90 minutes, never past now), each band's first and last, and the time no snapshot was in force. Only the part of the selection inside the
 * columns the pane holds is known (its snapshots are those of its view).
 */
export interface DepthLiqStretch {
  span: number; inForce: number; none: number; outside: number;
  rows: DepthLiqRow[];
  bands: { r: number; firstLong: number | null; firstShort: number | null; lastLong: number | null; lastShort: number | null }[];
}
export function depthLiqStretch(held: DepthPaneHeld, sel: Pick<RangeSelection, 't0' | 't1'>, now: number): DepthLiqStretch {
  const end = Math.min(sel.t1, Math.max(sel.t0, now)), span = Math.max(0, end - sel.t0);
  const a = Math.max(sel.t0, held.t0), b = Math.min(end, held.t1), known = Math.max(0, b - a), all = held.rows ?? [];
  let inForce = 0;
  const rows: DepthLiqRow[] = [];
  all.forEach((row, i) => {
    const from = row.fetchedAt, to = Math.min(all[i + 1]?.fetchedAt ?? Infinity, from + LIQ_HOLD, now);
    const overlap = Math.min(to, b) - Math.max(from, a);
    if (overlap > 0) { inForce += overlap; rows.push(row); }
  });
  const coins = held.coins, buckets = held.buckets ?? [], fst = rows[0], lst = rows[rows.length - 1];
  const at = (row: DepthLiqRow | undefined, side: 'long' | 'short', j: number): number | null => {
    const bk = buckets[j] ?? -1; if (!row || bk < 0) return null;
    const v = (coins ? (side === 'long' ? row.longCoin : row.shortCoin) : (side === 'long' ? row.long : row.short))[bk];
    return v === undefined || !Number.isFinite(v) ? null : v;
  };
  const bands = rows.length ? held.radii.map((r, j) => ({ r, firstLong: at(fst, 'long', j), firstShort: at(fst, 'short', j), lastLong: at(lst, 'long', j), lastShort: at(lst, 'short', j) })) : [];
  return { span, inForce, none: Math.max(0, known - inForce), outside: Math.max(0, span - known), rows, bands };
}

const band = (r: number): string => `±${bandText(r)} %`;
/** A share as a signed percentage to a tenth; one written as zero has no sign. */
const pct = (x: number): string => { const v = (Math.abs(x) * 100).toFixed(1); return `${Number(v) === 0 ? '' : x > 0 ? '+' : '−'}${v} %`; };
const toneOf = (x: number): { tone?: 'buy' | 'sell' } => Number((Math.abs(x) * 100).toFixed(1)) === 0 ? {} : x > 0 ? { tone: 'buy' } : { tone: 'sell' };
/** A duration, with a part under a minute said as such rather than dropped. */
const shortDuration = (ms: number): string => ms > 0 && ms < 60_000 ? t('under 1 min') : durationText(ms);
/** A display column's length: seconds under two minutes (zoomed in a column is a few seconds). */
const columnText = (ms: number): string => ms < 120_000 ? t('{n} s', { n: Math.max(1, Math.round(ms / 1000)) }) : durationText(ms);

/**
 * One band's figures written with one scale and precision (so a first and last that differ, and the change between them, read as such): dollars
 * or the coin.
 */
function bandMoney(values: readonly number[], changes: readonly number[], coins: boolean, coin: string): (v: number, signed?: boolean) => string {
  const fin = values.filter(Number.isFinite), lo = fin.length ? Math.min(...fin) : 0, hi = fin.length ? Math.max(...fin) : 0;
  const gaps = changes.map(Math.abs).filter(x => x > 0), change = gaps.length ? Math.min(...gaps) : hi - lo;
  const f = valueFormat(lo, hi, change, fin);
  return (v, signed = false) => {
    const body = f(Math.abs(v)), sign = signed && v !== 0 && /[1-9]/.test(body) ? (v > 0 ? '+' : '−') : '';
    return coins ? `${sign}${t('{n} {coin}', { n: body, coin })}` : `${sign}$${body}`;
  };
}

/**
 * The Depth pane's Range summary (provider.ts). The order book: each band's time mean bids and asks and their first and last measured
 * columns over the display columns holding every venue, each counting for the time it overlaps, and the watched band's mean of the columns'
 * imbalances; these are figures of the columns drawn at this zoom, not of the recording minute by minute. Liquidation levels: the snapshots in
 * force and each band's first and last.
 */
export class DepthRangeSummary {
  #last: { held: DepthPaneHeld | null; sel: RangeSelection; shown: boolean; current: string; second: number; zone: string; empty: string; replay: boolean; lines: RangeLine[] } | null = null;

  /** `empty`: why the pane holds nothing (no venue, liquidation levels for another coin or beyond their reach), or ''. */
  lines(sel: RangeSelection, held: DepthPaneHeld | null, shown: boolean, current: string, now: number, zone = '', empty = '', replay = false): RangeLine[] {
    // To the second: a snapshot's start or a book minute's end can fall at any moment of a replay, which also runs backwards.
    const last = this.#last, second = Math.floor(now / 1000);
    if (last && last.held === held && last.sel === sel && last.shown === shown && last.current === current && last.second === second && last.zone === zone && last.empty === empty && last.replay === replay) return last.lines;
    const lines = this.#lines(sel, held, shown, current, now, empty, replay);
    this.#last = { held, sel, shown, current, second, zone, empty, replay, lines };
    return lines;
  }

  #lines(sel: RangeSelection, held: DepthPaneHeld | null, shown: boolean, current: string, now: number, empty: string, replay: boolean): RangeLine[] {
    const title = (text: string): RangeLine => ({ key: 'dp-title', kind: 'title', cells: [text] });
    const note = (key: string, text: string): RangeLine => ({ key, kind: 'note', tone: 'muted', cells: [text] });
    const span = title(spanText(sel.t0, sel.t1));
    if (empty) return [span, note('dp-none', empty)];
    // What the pane reads while it has nothing for the context now: its own words.
    const reading = current.startsWith('liq|') ? t('The liquidation levels\' history is loading…') : t('Depth history is collecting…');
    if (held && held.key !== current) return [span, shown ? note('dp-wait', reading) : note('dp-stale', t('The Depth pane last drew another source, other venues or other bands: show it to sum up this selection.'))];
    if (!held) return [span, note('dp-none', shown ? reading : t('The Depth pane has not drawn yet: show it to sum up this selection.'))];
    if (sel.t0 >= now) return [span, note('dp-none', t('This selection has not begun yet.'))];
    const lines: RangeLine[] = [title(`${spanText(sel.t0, sel.t1)} · ${durationText(sel.t1 - sel.t0)}${!replay && sel.t1 > now ? ` · ${t('forming')}` : ''}`)];
    if (!shown) lines.push(note('dp-hidden', t('The Depth pane is hidden: these are the columns it last drew.')));
    if (sel.p0 !== null && sel.p1 !== null) lines.push(note('dp-prices', t('Depth bands are measured from each column\'s own price, whatever the selection\'s prices.')));
    if (held.source === 'liq') return this.#liq(lines, held, sel, now, note);
    const s = depthStretch(held, sel, now), focus = Math.min(held.focus, held.radii.length - 1), pxMs = (held.t1 - held.t0) / Math.max(1, held.w);
    lines.push(note('dp-status', [tn(held.ids.length, '{n} venue', '{n} venues'), t('order book'), t('columns of {time} at this zoom', { time: columnText(pxMs) })].join(' · ')));
    if (!s.bands.length) {
      lines.push(note('dp-empty', s.lacking > 0 ? t('No column of this selection holds every venue\'s book.') : s.uncentred > 0 ? t('No column of this selection has a price centre: one side of the book is empty.') : s.outside > 0 && s.outside >= s.span - s.open ? t('{time} of the selection lies outside the columns drawn: bring it into view to measure it.', { time: durationText(s.outside) }) : t('No closed column of the depth history lies in this selection.')));
    } else {
      const f = s.bands[focus]!;
      if (f.imbalance !== null) lines.push({ key: 'dp-focus', kind: 'stat', ...toneOf(f.imbalance), cells: [t('Watched band {band}: mean imbalance', { band: band(f.r) }), pct(f.imbalance)] });
      const items: GridItem[] = s.bands.map((b, j) => {
        const fmt = bandMoney([b.bid, b.ask, b.firstBid, b.lastBid, b.firstAsk, b.lastAsk], [b.lastBid - b.firstBid, b.lastAsk - b.firstAsk], held.coins, held.coin);
        return {
          key: `dp-${j}`, label: band(b.r), value: '',
          tip: t('Each column is weighted by its overlap with the selection. Each band holds the ones inside it.'),
          rows: [
            { label: t('Time mean bids / asks'), value: `${fmt(b.bid)} / ${fmt(b.ask)}` },
            ...(s.columns > 1 ? [
              { label: t('Bids first → last'), value: `${fmt(b.firstBid)} → ${fmt(b.lastBid)} (${fmt(b.lastBid - b.firstBid, true)})`, tone: 'buy' as const },
              { label: t('Asks first → last'), value: `${fmt(b.firstAsk)} → ${fmt(b.lastAsk)} (${fmt(b.lastAsk - b.firstAsk, true)})`, tone: 'sell' as const },
            ] : []),
          ],
        };
      });
      lines.push({ key: 'dp-grid', kind: 'grid', cells: [], grid: items });
      lines.push(note('dp-measured', t('Measured columns: first {first}, last {last}.', { first: clock(s.first, true), last: clock(s.last, true) })));
    }
    if (s.span > 0) {
      const parts = [
        ...(s.lacking > 0 ? [t('lacking a venue: {time}', { time: shortDuration(s.lacking) })] : []),
        ...(s.uncentred > 0 ? [t('no price centre: {time}', { time: shortDuration(s.uncentred) })] : []),
        ...(s.open > 0 ? [t('columns touching an unfinished book window: {time}', { time: shortDuration(s.open) })] : []),
        ...(s.none > 0 ? [t('no book: {time}', { time: shortDuration(s.none) })] : []),
        ...(s.outside > 0 ? [t('outside the columns drawn: {time}', { time: shortDuration(s.outside) })] : []),
      ];
      const pair = durationPair(s.covered, s.span);
      const head = held.ids.length > 1 ? t('All {n} venues represented: {k} of {span}', { n: held.ids.length, k: pair.k, span: pair.n })
        : t('Columns cover {k} of {span}', { k: pair.k, span: pair.n });
      lines.push(note('dp-cover', [head, ...parts].join(' · ')));
    }
    lines.push(note('dp-how', t('Based on the columns drawn at this zoom. Each column is weighted by its overlap with the selection; results can change with zoom, and a column across the selection\'s edge takes in the minute beyond it. Bands overlap and are never added together.')));
    return lines;
  }

  #liq(lines: RangeLine[], held: DepthPaneHeld, sel: RangeSelection, now: number, note: (key: string, text: string) => RangeLine): RangeLine[] {
    const s = depthLiqStretch(held, sel, now), c = held.coins, coin = held.coin;
    lines.push(note('dp-status', [t('Tracked liquidation levels'), tn(s.rows.length, '{n} snapshot in force', '{n} snapshots in force')].join(' · ')));
    if (held.omitted.length) lines.push(note('dp-omitted', t('Beyond the liquidation history\'s reach, left out: {bands}.', { bands: held.omitted.map(band).join(', ') })));
    if (!s.rows.length) lines.push(note('dp-empty', t('No liquidation levels snapshot was in force in this selection.')));
    else {
      const first = s.rows[0]!, lastRow = s.rows[s.rows.length - 1]!;
      lines.push(note('dp-when', s.rows.length > 1
        ? t('First snapshot: positions as of {asOf}, fetched {read}; last: positions as of {asOf2}, fetched {read2}.', { asOf: clock(first.asOf, true), read: clock(first.fetchedAt, true), asOf2: clock(lastRow.asOf, true), read2: clock(lastRow.fetchedAt, true) })
        : t('One snapshot: positions as of {asOf}, fetched {read}.', { asOf: clock(first.asOf, true), read: clock(first.fetchedAt, true) })));
      const items: GridItem[] = s.bands.map((b, j) => {
        const vals = [b.firstLong, b.lastLong, b.firstShort, b.lastShort].filter((v): v is number => v !== null);
        if (!vals.length) return { key: `dp-${j}`, label: band(b.r), value: t('Not in the history\'s buckets') };
        const fmt = bandMoney(vals, [(b.lastLong ?? 0) - (b.firstLong ?? 0), (b.lastShort ?? 0) - (b.firstShort ?? 0)], c, coin);
        const v = (x: number | null): string => x === null ? '–' : fmt(x);
        return {
          key: `dp-${j}`, label: band(b.r), value: '',
          rows: s.rows.length > 1 ? [
            { label: t('Longs first → last'), value: `${v(b.firstLong)} → ${v(b.lastLong)}${b.firstLong !== null && b.lastLong !== null ? ` (${fmt(b.lastLong - b.firstLong, true)})` : ''}`, tone: 'buy' as const },
            { label: t('Shorts first → last'), value: `${v(b.firstShort)} → ${v(b.lastShort)}${b.firstShort !== null && b.lastShort !== null ? ` (${fmt(b.lastShort - b.firstShort, true)})` : ''}`, tone: 'sell' as const },
          ] : [
            { label: t('Longs'), value: v(b.firstLong), tone: 'buy' as const },
            { label: t('Shorts'), value: v(b.firstShort), tone: 'sell' as const },
          ],
        };
      });
      lines.push({ key: 'dp-grid', kind: 'grid', cells: [], grid: items });
    }
    // Coverage, whatever was found: time with no snapshot in force, and time outside the columns drawn (unknown).
    const parts = [
      ...(s.none > 0 ? [t('no snapshot in force: {time}', { time: shortDuration(s.none) })] : []),
      ...(s.outside > 0 ? [t('outside the columns drawn: {time}', { time: shortDuration(s.outside) })] : []),
    ];
    if (s.span > 0) lines.push(note('dp-cover', [t('Snapshots in force for {k} of {span}', (({ k, n }) => ({ k, span: n }))(durationPair(s.inForce, s.span))), ...parts].join(' · ')));
    lines.push(note('dp-how', t('Potential liquidation levels of tracked positions, not liquidations that happened. Snapshots expire after 90 minutes.')));
    return lines;
  }
}
