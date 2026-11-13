import { clock, usd } from '../format.ts';
import type { LtParts } from '../lt.ts';
import { sizeText } from '../sizes.ts';
import { t, tn } from '../i18n.ts';
import { durationPair, durationText, spanText } from './oi-lines.ts';
import type { RangeSelection } from './selection.ts';
import type { GridItem, RangeLine } from './stats.ts';

/**
 * What the Liquidity Tracker pane drew last, handed to its Range summary (provider.ts): the series as answered, with what it was asked for
 * (the venues, half-life, size filters and mode at the moment of asking, never the controls' later values), and how many of its windows a
 * replay may show. The same object while none of that changes.
 */
export interface LtPaneHeld {
  /** What it was asked for (`ltHeldKey`): another is not summed up as this one. */
  key: string;
  /** The venues asked for, in order (a window holding all of them is comparable with another holding all of them), and their names. */
  ids: readonly string[]; names: readonly string[];
  halfLifeBp: number;
  /** The size filters asked for, as stored (0: none: the key), and as applied to the books (USD, scaled to the coin: what is said). */
  minUsd: number; maxUsd: number; minApplied: number; maxApplied: number;
  /** Per level (`average`): each side's weighted size divided by its levels' summed weights. */
  average: boolean;
  /** The windows' starts, oldest first, each `stepMs` long; bids and asks as drawn (USD). */
  times: Float64Array; bid: Float32Array; ask: Float32Array;
  /**
   * Each venue's part of each window (`LtParts`, in the order of `ids`), NaN where it had nothing: a window holds every venue asked for where
   * none is NaN. Null for one venue (the window is its), or an answer read without them.
   */
  parts: LtParts | null;
  /** Per window: 1 where some column of it was worked out from an average book; null when the answer does not say. */
  approx: Uint8Array | null;
  stepMs: number;
  /** How many of the windows may be shown: all live; in a replay those that had ended by its moment (`shownBy`). */
  shown: number;
  /** In a replay, its moment's minute; else null. */
  replayAt: number | null;
  /** When the answer came back (the page's clock): a window that had not ended by then was read mid-window, and stays open however late it is read. */
  answeredAt: number;
}

/** What a tracker snapshot stands for: the venues, the half-life, the size filters and the mode. */
export const ltHeldKey = (ids: readonly string[], lt: { halfLifeBp: number; minUsd: number; maxUsd: number; average: boolean }): string =>
  `${ids.join(',')}|${lt.halfLifeBp}|${lt.minUsd}|${lt.maxUsd}|${lt.average}`;

/**
 * The tracker over a selection, on the windows that overlap it, each counting for the time it overlaps (ms). Only closed windows holding
 * every venue asked for are measured: a window lacking one has a smaller total for that reason alone. The rest of the measured span (the
 * selection up to now) is said: windows lacking venues, the window under way, and time no window covers. `unverified`: several venues and no
 * parts to tell which each window holds.
 */
export interface LtStretch {
  unverified: boolean;
  /** Per venue (the order of `ids`), the time of the selection's closed windows that lack it. */
  missing: number[];
  t0: number; t1: number;
  /** The selection up to now, and how it splits: covered by eligible windows, by windows lacking venues, by the window under way, by none. */
  span: number; covered: number; lacking: number; forming: number; none: number;
  windows: number;
  /** Time-weighted means of the drawn bids and asks; first and last eligible window; lowest and highest. Null without an eligible window. */
  bid: Side | null; ask: Side | null;
  /** Each window's own imbalance (bid - ask) / (bid + ask), time-weighted, where the total is above zero; first and last; time bids or asks were heavier. */
  imbalance: { mean: number; first: number; last: number; bidHeavier: number; askHeavier: number; defined: number } | null;
  /** Covered time worked out from average books. */
  approx: number;
  /** Every window that overlaps the selection has closed and the selection has ended: the figures will not change with the clock. */
  settled: boolean;
}
export interface Side { mean: number; first: number; last: number; low: number; high: number; firstT: number; lastT: number }

/** The tracker over `sel` from what the pane holds; `now` is the clock's or a replay's moment. */
export function ltStretch(held: LtPaneHeld, sel: Pick<RangeSelection, 't0' | 't1'>, now: number): LtStretch {
  const { times, bid, ask, parts, approx, stepMs: step } = held, owners = held.ids.length, windows = times.length;
  // Every venue asked for has a part in window i (a lane gap or a venue not recorded then is NaN there).
  const full = (i: number): boolean => {
    if (!parts || owners < 2) return true;
    for (let m = 0; m < owners; m++) { const at = m * windows + i; if (Number.isNaN(parts.bid[at]!) || Number.isNaN(parts.ask[at]!)) return false; }
    return true;
  };
  const end = Math.min(sel.t1, Math.max(sel.t0, now)), span = Math.max(0, end - sel.t0);
  // The window under way when the answer came (or now, or at a replay's moment, whichever is earliest), by the clock (windows are the epoch's
  // multiples of the step), and everything after it: open, said whether or not the series holds it (a replay's cut leaves it out; a coarse
  // window whose first minute is not recorded yet is not in the series at all), and never read: a value worked out mid-window does not become
  // a closed window's because time passed.
  const closedBy = Math.min(now, held.answeredAt), openStart = step > 0 ? Math.floor(closedBy / step) * step : closedBy;
  const forming = Math.max(0, Math.min(end, openStart + step) - Math.max(openStart, sel.t0)), missing = new Array<number>(owners).fill(0);
  let covered = 0, lacking = 0, counted = 0, apx = 0;
  let bSum = 0, aSum = 0, iSum = 0, iTime = 0, bidHeavier = 0, askHeavier = 0;
  let bFirst = NaN, bLast = NaN, aFirst = NaN, aLast = NaN, iFirst = NaN, iLast = NaN, firstT = NaN, lastT = NaN;
  let bLow = Infinity, bHigh = -Infinity, aLow = Infinity, aHigh = -Infinity;
  for (let i = 0; i < held.shown && i < times.length; i++) {
    const w0 = times[i]!, w1 = w0 + step;
    if (!Number.isFinite(w0) || w1 <= sel.t0 || w0 >= sel.t1 || w1 > closedBy) continue;
    const dt = Math.max(0, Math.min(w1, end) - Math.max(w0, sel.t0));
    if (!full(i)) {
      lacking += dt;
      for (let m = 0; m < owners && parts; m++) { const at = m * windows + i; if (Number.isNaN(parts.bid[at]!) || Number.isNaN(parts.ask[at]!)) missing[m]! += dt; }
      continue;
    }
    if (dt <= 0) continue;
    const b = bid[i]!, a = ask[i]!;
    covered += dt; counted++;
    if (approx?.[i]) apx += dt;
    bSum += dt * b; aSum += dt * a;
    if (Number.isNaN(bFirst)) { bFirst = b; aFirst = a; firstT = w0; }
    bLast = b; aLast = a; lastT = w0;
    if (b < bLow) bLow = b; if (b > bHigh) bHigh = b;
    if (a < aLow) aLow = a; if (a > aHigh) aHigh = a;
    const total = b + a;
    if (total > 0) {
      const imb = (b - a) / total;
      iSum += dt * imb; iTime += dt;
      if (Number.isNaN(iFirst)) iFirst = imb;
      iLast = imb;
      if (b > a) bidHeavier += dt; else if (a > b) askHeavier += dt;
    }
  }
  const none = Math.max(0, span - covered - lacking - forming);
  const side = (sum: number, first: number, last: number, low: number, high: number): Side | null => covered > 0 ? { mean: sum / covered, first, last, low, high, firstT, lastT } : null;
  return {
    unverified: owners > 1 && !parts, missing, t0: sel.t0, t1: sel.t1, span, covered, lacking, forming, none, windows: counted,
    bid: side(bSum, bFirst, bLast, bLow, bHigh), ask: side(aSum, aFirst, aLast, aLow, aHigh),
    imbalance: iTime > 0 ? { mean: iSum / iTime, first: iFirst, last: iLast, bidHeavier, askHeavier, defined: iTime } : null,
    approx: apx, settled: sel.t1 <= openStart,
  };
}

const money = (x: number): string => `$${usd(x)}`;
/** A signed figure: a sign only where the written figure is not zero. */
const signedMoney = (x: number): string => { const v = usd(Math.abs(x)); return `${v === '0' ? '' : x > 0 ? '+' : '−'}$${v}`; };
/** Decimals for a set of shares (0..1) written as percentages: one, or two where every one of them is under a tenth of a percent. */
const digitsOf = (...xs: number[]): number => xs.every(x => Math.abs(x) * 100 < 0.1) ? 2 : 1;
/** A share as a signed percentage; one written as zero has no sign. */
const pct = (x: number, d = 1): string => { const v = (Math.abs(x) * 100).toFixed(d); return `${Number(v) === 0 ? '' : x > 0 ? '+' : '−'}${v} %`; };
const pp = (x: number, d = 1): string => { const v = (Math.abs(x) * 100).toFixed(d); return t('{n} pp', { n: `${Number(v) === 0 ? '' : x > 0 ? '+' : '−'}${v}` }); };
/** The tone of a signed share: none where it is written as zero. */
const toneOf = (x: number, d = 1): { tone?: 'buy' | 'sell' } => Number((Math.abs(x) * 100).toFixed(d)) === 0 ? {} : x > 0 ? { tone: 'buy' } : { tone: 'sell' };
const share = (part: number, whole: number): string => `${Math.round(part / whole * 100)} %`;
/** A duration, with a part under a minute said as such rather than dropped. */
const shortDuration = (ms: number): string => ms > 0 && ms < 60_000 ? t('under 1 min') : durationText(ms);

/** The venues the selection's windows lacked longest (up to three), by name. */
function lackingNames(s: LtStretch, h: LtPaneHeld): string[] {
  return s.missing.map((time, m) => ({ time, name: h.names[m] ?? h.ids[m] ?? '' })).filter(x => x.time > 0).sort((a, b) => b.time - a.time).slice(0, 3).map(x => x.name);
}

/**
 * The Liquidity Tracker pane's Range summary (provider.ts): the drawn bids and asks over the windows of the selection that hold every venue
 * asked for, each counting for the time it overlaps, and each window's own imbalance. The pane asks for the windows around its view, so a
 * settled result of a closed selection is kept when the view moves away, and is not replaced by one covering less or in coarser windows.
 */
export class LtRangeSummary {
  #kept: { current: string; t0: number; t1: number; replayAt: number | null; at: number; s: LtStretch; held: LtPaneHeld } | null = null;
  #last: { held: LtPaneHeld | null; sel: RangeSelection; shown: boolean; current: string; minute: number; zone: string; empty: string; replay: boolean; lines: RangeLine[] } | null = null;

  /** `empty`: why the pane has no book to read (no venue on, or its Venues choice counts none), or ''; `replay`: whether `now` is a replay's moment. */
  lines(sel: RangeSelection, held: LtPaneHeld | null, shown: boolean, current: string, now: number, zone = '', empty = '', replay = false): RangeLine[] {
    const last = this.#last, minute = Math.floor(now / 60_000);
    if (last && last.held === held && last.sel === sel && last.shown === shown && last.current === current && last.minute === minute && last.zone === zone && last.empty === empty && last.replay === replay) return last.lines;
    const lines = this.#lines(sel, held, shown, current, now, empty, replay);
    this.#last = { held, sel, shown, current, minute, zone, empty, replay, lines };
    return lines;
  }

  #lines(sel: RangeSelection, held: LtPaneHeld | null, shown: boolean, current: string, now: number, empty: string, replay: boolean): RangeLine[] {
    const title = (text: string): RangeLine => ({ key: 'lt-title', kind: 'title', cells: [text] });
    const note = (key: string, text: string): RangeLine => ({ key, kind: 'note', tone: 'muted', cells: [text] });
    const span = title(spanText(sel.t0, sel.t1));
    if (empty) return [span, note('lt-none', empty)];
    // A snapshot of other settings is not this one (the pane keeps drawing the old series while a new half-life or step is read).
    const fresh = held && held.key === current ? held : null;
    const now0 = fresh ? ltStretch(fresh, sel, now) : null;
    // Kept: a settled result of this selection and settings, shown while what is held now says less of it (the view moved away, coarser
    // windows for a wider view). Only in the mode it was worked out in (the page's mode now, whatever is held), and in a replay only at or
    // after the moment it was worked out at.
    const k = this.#kept;
    const same = k !== null && k.current === current && k.t0 === sel.t0 && k.t1 === sel.t1 && k.at <= now && (replay ? k.replayAt !== null && k.replayAt <= now : k.replayAt === null);
    const poorer = (s: LtStretch, h: LtPaneHeld, than: LtStretch, thanHeld: LtPaneHeld): boolean => s.covered < than.covered || (h.stepMs > thanHeld.stepMs && than.covered > 0);
    if (fresh && now0?.settled && now0.covered > 0 && !now0.unverified && !(same && poorer(now0, fresh, k.s, k.held))) this.#kept = { current, t0: sel.t0, t1: sel.t1, replayAt: replay ? now : null, at: now, s: now0, held: fresh };
    const kept = same && (!now0 || poorer(now0, fresh!, k.s, k.held)) ? k : null;
    // Another context: a pane in view is reading the new settings (never "show it" on a pane on screen); a hidden one drew another context.
    if (!fresh && !kept) return [span, held && !shown ? note('lt-stale', t('The Liquidity Tracker last drew other venues, another half-life, size filter or mode: show it to sum up this selection.'))
      : note('lt-none', shown ? t('Liquidity tracker is collecting…') : t('The Liquidity Tracker has not drawn yet: show it to sum up this selection.'))];
    const s = kept?.s ?? now0!, h = kept?.held ?? fresh!, many = h.ids.length > 1;
    if (sel.t0 >= now) return [span, note('lt-none', t('This selection has not begun yet.'))];
    const live = !kept && !replay && sel.t1 > now;
    const lines: RangeLine[] = [title(`${spanText(sel.t0, sel.t1)} · ${durationText(sel.t1 - sel.t0)}${live ? ` · ${t('forming')}` : ''}`)];
    // What it measured: the venues, half-life, mode, filters and windows, as asked.
    const status = [tn(h.ids.length, '{n} venue', '{n} venues'), t('half-life {n} bp', { n: h.halfLifeBp }), h.average ? t('per level') : t('summed across markets'), t('windows of {step}', { step: durationText(h.stepMs) })];
    // The filters as applied to the books (scaled to the coin), written as the controls write them.
    if (h.minUsd > 0) status.push(t('bins ≥ {size}', { size: `$${sizeText(h.minApplied)}` }));
    if (h.maxUsd > 0) status.push(t('bins ≤ {size}', { size: `$${sizeText(h.maxApplied)}` }));
    const at = kept ? kept.replayAt : replay ? now : null;
    if (at !== null) status.push(t('replay: windows ended by {time}', { time: clock(at, true) }));
    lines.push(note('lt-status', status.join(' · ')));
    if (!shown) lines.push(note('lt-hidden', t('The Liquidity Tracker is hidden: these are the windows it last held.')));
    if (sel.p0 !== null && sel.p1 !== null) lines.push(note('lt-prices', t('The tracker weighs each venue\'s book near its own touch, whatever the selection\'s prices.')));
    if (kept) lines.push(note('lt-kept', t('Calculated from windows previously held by the pane.')));
    if (s.unverified) {
      // Several venues and no parts: which venues each window holds is unknown, so no figure can claim a set of venues that stays the same.
      lines.push(note('lt-unverified', t('This answer does not say which venues each window holds, so its windows cannot be compared: nothing is summed up.')));
    } else if (!s.bid || !s.ask) {
      lines.push(note('lt-empty', s.lacking > 0 ? t('No window of this selection holds every venue asked for ({venues} missing).', { venues: lackingNames(s, h).join(', ') }) : t('No closed window of the tracker lies in this selection.')));
    } else {
      const sideTile = (key: 'bid' | 'ask', x: Side): GridItem => ({
        key, label: key === 'bid' ? (h.average ? t('Time mean of bid size per level') : t('Time mean of weighted bids')) : (h.average ? t('Time mean of ask size per level') : t('Time mean of weighted asks')),
        value: money(x.mean), tone: key === 'bid' ? 'buy' : 'sell',
        tip: t('Each included window is weighted by its overlap with the selection.'),
        // One window: its value is all there is (no first and last, no range).
        rows: s.windows < 2 ? [] : [
          { label: t('First → last included window'), value: `${money(x.first)} → ${money(x.last)}` },
          { label: t('Last − first'), value: signedMoney(x.last - x.first) },
          { label: t('Lowest – highest window values'), value: `${money(x.low)} – ${money(x.high)}` },
        ],
      });
      lines.push({ key: 'lt-grid', kind: 'grid', cells: [], grid: [sideTile('bid', s.bid), sideTile('ask', s.ask)] });
      const im = s.imbalance;
      if (im) {
        const d = digitsOf(im.mean, im.first, im.last, im.last - im.first);
        lines.push({ key: 'h-lt-imb', kind: 'heading', cells: [t('Imbalance')] });
        lines.push({ key: 'lt-imb', kind: 'stat', ...toneOf(im.mean, d), cells: [s.windows > 1 ? t('Time mean of the windows\' imbalances') : t('Imbalance of the one window'), pct(im.mean, d)] });
        if (s.windows > 1) {
          lines.push({ key: 'lt-imb-move', kind: 'stat', cells: [t('First → last defined imbalance'), `${pct(im.first, d)} → ${pct(im.last, d)} (${pp(im.last - im.first, d)})`] });
          lines.push({ key: 'lt-imb-bids', kind: 'stat', cells: [t('Time with bids heavier'), `${share(im.bidHeavier, im.defined)} · ${shortDuration(im.bidHeavier)}`] });
          lines.push({ key: 'lt-imb-asks', kind: 'stat', cells: [t('Time with asks heavier'), `${share(im.askHeavier, im.defined)} · ${shortDuration(im.askHeavier)}`] });
          lines.push(note('lt-imb-shares', t('Shares use included time where bids plus asks is above zero. Equal sides count for neither side.')));
        }
        lines.push(note('lt-imb-how', t('Imbalance is (bids − asks) / (bids + asks) in each window; the mean is of those, by time, not of the mean bids and asks.')));
      }
      if (s.approx > 0) lines.push(note('lt-approx', t('≈ {time} of included time uses estimates from average recorded books.', { time: shortDuration(s.approx) })));
    }
    // What the windows cover: only those holding every venue are measured; every part left out is said, however short.
    if (s.span > 0) {
      const parts = [
        ...(s.lacking > 0 ? [t('missing a venue: {time} ({venues})', { time: shortDuration(s.lacking), venues: lackingNames(s, h).join(', ') })] : []),
        ...(s.forming > 0 ? [t('open window excluded: {time}', { time: shortDuration(s.forming) })] : []),
        ...(s.none > 0 ? [t('no window held: {time}', { time: shortDuration(s.none) })] : []),
      ];
      const pair = durationPair(s.covered, s.span);
      const head = s.unverified ? t('Windows cover {k} of {span}', { k: pair.k, span: pair.n })
        : many ? t('Windows holding all {n} venues cover {k} of {span}', { n: h.ids.length, k: pair.k, span: pair.n })
        : t('Windows cover {k} of {span}', { k: pair.k, span: pair.n });
      lines.push(note('lt-cover', [head, ...(s.windows > 0 && !s.unverified ? [tn(s.windows, '{n} included window', '{n} included windows')] : []), ...parts].join(' · ')));
    }
    lines.push(note('lt-how', many ? t('Each included window is weighted by its overlap with the selection. Windows missing a venue are left out, so the set of venues stays the same.')
      : t('Each included window is weighted by its overlap with the selection.')));
    return lines;
  }
}
