import { venueLabel } from '../venues.ts';
import { clock } from '../format.ts';
import { t, tn } from '../i18n.ts';
import { durationText, signedCoins, spanText } from './oi-lines.ts';
import type { RangeSelection } from './selection.ts';
import type { GridItem, RangeLine } from './stats.ts';
import { cutAt, fundingBase, rowStart, type FundingNow, type FundingRow, type FundingVenue, type PremiumRow } from '../funding.ts';
import type { HourOpens } from '../delta/nlns-source.ts';

const HOUR = 3_600_000;

/**
 * What the Funding pane drew last, handed to its Range summary (provider.ts): the venue it shows and, as painted, its settlements (made by the
 * moment shown), premium readings (closed by it in a replay), the funding accruing now (live only) and on Hyperliquid who opened each hour. The
 * same object while none of that changes.
 */
export interface FundingPaneHeld {
  /** What it was drawn for (`fundingHeldKey`): the chart market, timeframe and the venue and listing shown. */
  key: string;
  venue: FundingVenue; coin: string; tf: string;
  rows: readonly FundingRow[];
  /** How far back the settlements were read (time before it is not read), or null before any read answered. */
  readFrom: number | null;
  premium: readonly PremiumRow[]; premiumMs: number;
  /** The funding accruing now, live only. */
  forming: FundingNow | null;
  /** Hyperliquid: the share of new positions opened by each side, hour by hour, as the pane drew it; null elsewhere. */
  opens: readonly HourOpens[] | null;
  loading: boolean; failed: boolean;
  /** In a replay, its moment, else null. */
  replayAt: number | null;
}

/** The context a Funding snapshot stands for. */
export const fundingHeldKey = (state: { marketId: string; timeframe: string }, venue: string, symbol: string): string => `${state.marketId}|${state.timeframe}|${venue}|${symbol}`;

/** Settled funding over the selection, its premium readings and who opened. Durations in ms; rates per 8 hours. */
export interface FundingStretch {
  t0: number; t1: number;
  /** The venue and coin it was worked out for (a kept result keeps them). */
  venue: FundingVenue; coin: string;
  /** Time the settlements held represent, and the rest of the selection by why: before the read reaches, after the newest settlement held, between. Together the span. */
  covered: number; span: number; unread: number; afterNewest: number; gaps: number;
  rows: number; hours: number[];
  first: { t: number; per8h: number; start: number } | null; last: { t: number; per8h: number } | null;
  low: number | null; high: number | null; mean: number | null;
  positive: number; negative: number; zero: number; longestNegative: number;
  /** The settlement times inside, the premium readings' and the opening hours' (what a kept result is compared by). */
  times: number[]; premiumTimes: number[]; openTimes: number[];
  /** Completed premium readings wholly inside, with how many sat inside, below and above the band where funding holds its base rate (none: no band). */
  premium: { n: number; first: number; last: number; mean: number; low: number; high: number; band: { lo: number; hi: number; inside: number; below: number; above: number } | null } | null;
  /** Hyperliquid: closed hours wholly inside, added up. */
  opens: { hours: number; long: number; short: number } | null;
  /** The funding accruing now, where its interval reaches into the selection and it has not expired (live only). */
  forming: FundingNow | null;
  settled: boolean;
}

/** Disjoint ordered intervals inside [A, B) not covered by `pieces` (themselves disjoint and ordered). */
function complement(pieces: readonly [number, number][], A: number, B: number): [number, number][] {
  const out: [number, number][] = [];
  let at = A;
  for (const [from, to] of pieces) { if (from > at) out.push([at, Math.min(from, B)]); at = Math.max(at, to); }
  if (at < B) out.push([at, B]);
  return out.filter(([a, b]) => b > a);
}
const overlap = (a: number, b: number, c: number, d: number): number => Math.max(0, Math.min(b, d) - Math.max(a, c));

/** The selection [A, B) over what the pane drew: settlements by the time they represent, premium by its closed readings, openings by whole hours. */
export function fundingStretch(held: FundingPaneHeld, sel: Pick<RangeSelection, 't0' | 't1'>, now: number): FundingStretch {
  const clockAt = held.replayAt ?? now, A = sel.t0, B = Math.min(sel.t1, clockAt), span = Math.max(0, B - A);
  let covered = 0, weighted = 0, positive = 0, negative = 0, zero = 0, longest = 0, run = 0, runEnd = -Infinity, rows = 0;
  let low: number | null = null, high: number | null = null, first: FundingStretch['first'] = null, last: FundingStretch['last'] = null;
  const hours = new Set<number>(), times: number[] = [], pieces: [number, number][] = [];
  held.rows.forEach((r, i) => {
    const start = rowStart(held.rows, i), from = Math.max(A, start), to = Math.min(B, r.t), dt = to - from;
    if (!(dt > 0)) return;
    covered += dt; weighted += dt * r.per8h; rows++; hours.add(r.hours); times.push(r.t); pieces.push([from, to]);
    low = low === null ? r.per8h : Math.min(low, r.per8h); high = high === null ? r.per8h : Math.max(high, r.per8h);
    first ??= { t: r.t, per8h: r.per8h, start }; last = { t: r.t, per8h: r.per8h };
    if (r.per8h > 0) positive += dt; else if (r.per8h < 0) negative += dt; else zero += dt;
    run = r.per8h < 0 ? (runEnd === from ? run + dt : dt) : 0; runEnd = to;
    longest = Math.max(longest, run);
  });
  // The rest of the selection, by why: before the read reaches, after the newest settlement held, between (their sum is what is not covered).
  const readFrom = held.readFrom ?? Infinity, newest = held.rows.length ? held.rows[held.rows.length - 1]!.t : -Infinity;
  let unread = 0, afterNewest = 0;
  const rest = complement(pieces, A, B);
  for (const [a, b] of rest) { unread += overlap(a, b, -Infinity, readFrom); afterNewest += overlap(a, b, Math.max(newest, readFrom), Infinity); }
  const gaps = rest.reduce((x, [a, b]) => x + (b - a), 0) - unread - afterNewest;
  // Premium: completed readings whose whole period lies inside, and where they sat against the band of the base rate.
  const inside = held.premium.filter(q => q.t >= A && q.t + held.premiumMs <= B), { base, clamp } = fundingBase(held.venue);
  const band = clamp > 0 ? { lo: base - clamp, hi: base + clamp } : null;
  const premium = inside.length ? {
    n: inside.length, first: inside[0]!.p, last: inside[inside.length - 1]!.p, mean: inside.reduce((x, q) => x + q.p, 0) / inside.length,
    low: Math.min(...inside.map(q => q.p)), high: Math.max(...inside.map(q => q.p)),
    band: band ? { ...band, inside: inside.filter(q => q.p >= band.lo && q.p <= band.hi).length, below: inside.filter(q => q.p < band.lo).length, above: inside.filter(q => q.p > band.hi).length } : null,
  } : null;
  // Openings: closed hours wholly inside; amounts added up (a share of the sums, never a mean of hourly shares).
  const closedHours = held.opens ? held.opens.filter(h => h.t >= A && h.t + HOUR <= B && h.t + HOUR <= clockAt) : [];
  const opens = held.opens ? { hours: closedHours.length, long: closedHours.reduce((x, h) => x + h.longOpened, 0), short: closedHours.reduce((x, h) => x + h.shortOpened, 0) } : null;
  // The reading now: live only, unexpired (its settlement still ahead), and its interval reaching into the selection.
  const f = held.forming, formEnd = f ? f.next ?? clockAt : 0;
  const forming = f && held.replayAt === null && (f.next === null || f.next > clockAt) && formEnd > A && formEnd - f.hours * HOUR < B ? f : null;
  // Settled: a closed selection the settlements held reach past at its end and the read reaches before its start, nothing being read.
  const settled = !held.loading && sel.t1 <= clockAt && newest >= B && readFrom <= A;
  return { t0: A, t1: B, venue: held.venue, coin: held.coin, covered, span, unread, afterNewest, gaps: Math.max(0, gaps), rows, hours: [...hours].sort((a, b) => a - b), first, last, low, high,
    mean: covered > 0 ? weighted / covered : null, positive, negative, zero, longestNegative: longest, times, premiumTimes: inside.map(q => q.t), openTimes: closedHours.map(h => h.t),
    premium, opens, forming, settled };
}

/** A rate (or premium) as a signed percent: four decimals, more (up to seven) where four would show a rate that is not none as 0 (Deribit's hourly records). */
const rate = (x: number): string => { let d = 4; while (d < 7 && x !== 0 && Number(Math.abs(x * 100).toFixed(d)) === 0) d++; return `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)}%`; };
/** A change of rate in basis points per eight hours: "unchanged" for none, the digits that show it otherwise, under 0.001 bp in words. */
function bp(x: number): string {
  if (x === 0) return t('unchanged');
  const v = x * 10_000; let d = 1;
  while (d < 3 && Number(Math.abs(v).toFixed(d)) === 0) d++;
  if (Number(Math.abs(v).toFixed(d)) === 0) return v > 0 ? t('increase under 0.001 bp') : t('decrease under 0.001 bp');
  return t('{n} bp', { n: `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}` });
}
const share = (part: number, of: number): string => of > 0 ? `${Math.round(part / of * 100)}%` : '–';

/**
 * The Funding pane's Range summary (provider.ts): the venue shown, its settled funding over the selection by the time each settlement represents
 * (never an amount paid), the funding accruing now apart, its completed premium readings against the base-rate band and on Hyperliquid who
 * opened, by whole hours. A settled closed result is kept while the pane holds less of it.
 */
export class FundingRangeSummary {
  #kept: { current: string; t0: number; t1: number; replayAt: number | null; at: number; s: FundingStretch } | null = null;
  #last: { held: FundingPaneHeld | null; sel: RangeSelection; shown: boolean; current: string; minute: number; zone: string; noVenue: boolean; lines: RangeLine[] } | null = null;

  /** `noVenue`: no venue lists a perpetual of the coin (the pane holds nothing). */
  lines(sel: RangeSelection, held: FundingPaneHeld | null, shown: boolean, current: string, now: number, zone = '', noVenue = false): RangeLine[] {
    const last = this.#last, minute = Math.floor(now / 60_000);
    if (last && last.held === held && last.sel === sel && last.shown === shown && last.current === current && last.minute === minute && last.zone === zone && last.noVenue === noVenue) return last.lines;
    const lines = this.#lines(sel, held, shown, current, now, noVenue);
    this.#last = { held, sel, shown, current, minute, zone, noVenue, lines };
    return lines;
  }

  #lines(sel: RangeSelection, held: FundingPaneHeld | null, shown: boolean, current: string, now: number, noVenue: boolean): RangeLine[] {
    const title = (text: string): RangeLine => ({ key: 'fd-title', kind: 'title', cells: [text] });
    const note = (key: string, text: string): RangeLine => ({ key, kind: 'note', tone: 'muted', cells: [text] });
    if (noVenue) return [title(spanText(sel.t0, sel.t1)), note('fd-none', t('No venue here lists a perpetual of this coin.'))];
    if (held && held.key !== current) return [title(spanText(sel.t0, sel.t1)), note('fd-stale', t('The Funding pane last drew another market, timeframe or venue: show it to sum up this selection.'))];
    const now0 = held ? fundingStretch(held, sel, now) : null;
    // Kept: a settled result of this selection and context, shown while what is held now lacks some of its settlements, premium readings or
    // opening hours (a settlement held with another interval is a correction, not a loss); only in the same mode and not from later in a replay.
    const replayAt = held?.replayAt ?? null, k = this.#kept;
    const same = k !== null && k.current === current && k.t0 === sel.t0 && k.t1 === sel.t1 && k.at <= now
      && (held === null || (replayAt === null ? k.replayAt === null : k.replayAt !== null && k.replayAt <= replayAt));
    // Whether the pane still holds each of the kept result's times (a correction that moves a settlement's interval out of the selection is not a
    // loss: the pane holds it still); a binary search, as up to 24,000 premium readings can be held.
    const holds = (list: readonly { t: number }[], time: number): boolean => { const i = cutAt(list, time) - 1; return i >= 0 && list[i]!.t === time; };
    const lacks = (then: readonly number[], list: readonly { t: number }[]): boolean => then.some(x => !holds(list, x));
    const poorer = (than: FundingStretch): boolean => !!held && (lacks(than.times, held.rows) || lacks(than.premiumTimes, held.premium) || lacks(than.openTimes, held.opens ?? []));
    if (held && now0?.settled && !(same && poorer(k.s))) this.#kept = { current, t0: sel.t0, t1: sel.t1, replayAt, at: now, s: now0 };
    const kept = same && (!now0 || poorer(k.s)) ? k : null;
    if (!held && !kept) return [title(spanText(sel.t0, sel.t1)), note('fd-none', shown ? t('Reading funding…') : t('The Funding pane has not drawn this market yet: show it to sum up this selection.'))];
    const s = kept?.s ?? now0!, venue = s.venue, continuous = venue === 'deribit';
    if (!(s.t1 > s.t0)) return [title(spanText(sel.t0, sel.t1)), note('fd-none', t('This selection has not begun yet.'))];
    const live = !kept && replayAt === null && sel.t1 > now;
    const lines: RangeLine[] = [title(`${spanText(s.t0, s.t1)} · ${durationText(s.t1 - s.t0)}${live ? ` · ${t('forming')}` : ''}`)];
    const status: string[] = [venueLabel(venue), t('funding rates per 8 hours')];
    if (replayAt !== null && !kept) status.push(t('replay: settlements made by {time}', { time: clock(replayAt, true) }));
    lines.push(note('fd-status', status.join(' · ')));
    if (!shown) lines.push(note('fd-hidden', t('The Funding pane is hidden: these are the readings it last held.')));
    if (sel.p0 !== null && sel.p1 !== null) lines.push(note('fd-prices', t('Funding and who opened are for the whole market, at all prices.')));
    if (kept) lines.push(note('fd-kept', t('As worked out while the pane held these readings.')));
    if (held?.failed) lines.push(note('fd-failed', t('{venue} did not answer: asked again in a minute.', { venue: venueLabel(held.venue) })));
    else if (held?.loading && !kept) lines.push(note('fd-reading', t('Reading funding…')));
    // Settled funding: each settlement over the interval it paid for (Deribit: each hour's net record; its funding is paid all the time).
    lines.push({ key: 'h-fd-rows', kind: 'heading', cells: [continuous ? t('Completed hourly funding') : t('Settled funding')] });
    const uncovered = [
      ...(s.unread >= 60_000 ? [{ label: t('Before the read reaches'), value: durationText(s.unread) }] : []),
      ...(s.afterNewest >= 60_000 ? [{ label: continuous ? t('After the newest hourly record held') : t('After the newest settlement held'), value: durationText(s.afterNewest) }] : []),
      ...(s.gaps >= 60_000 ? [{ label: continuous ? t('No hourly record held') : t('No settlement held'), value: durationText(s.gaps) }] : []),
    ];
    if (!s.first || !s.last) {
      lines.push(note('fd-rows-none', t('No settlement held represents this selection.')));
      if (uncovered.length) lines.push({ key: 'fd-grid', kind: 'grid', cells: [], grid: [{ key: 'fd-rows', label: venueLabel(venue), value: '', rows: uncovered }] });
    } else {
      const flat = s.low === s.high, tone = (x: number) => x > 0 ? { tone: 'buy' as const } : x < 0 ? { tone: 'sell' as const } : {};
      if (flat) lines.push({ key: 'fd-rate', kind: 'stat', ...tone(s.first.per8h), cells: [continuous ? t('Hourly net rate') : t('Settled rate'), t('{rate} throughout the represented time', { rate: rate(s.first.per8h) })] });
      else lines.push({ key: 'fd-rate', kind: 'stat', ...(s.last.per8h > s.first.per8h ? { tone: 'buy' as const } : s.last.per8h < s.first.per8h ? { tone: 'sell' as const } : {}),
        cells: [continuous ? t('First → last hourly net rate') : t('First → last settled rate'), `${rate(s.first.per8h)} → ${rate(s.last.per8h)} · ${bp(s.last.per8h - s.first.per8h)}`] });
      if (s.rows === 1 && !continuous) lines.push(note('fd-one', t('Settled at {end} for the interval from {start}.', { start: clock(s.first.start, true), end: clock(s.first.t, true) })));
      const sides: { label: string; value: string; tone?: 'buy' | 'sell' }[] = [];
      const of = (ms: number): string => t('{time} · {share} of the represented time', { time: durationText(ms), share: share(ms, s.covered) });
      if (s.positive > 0) sides.push({ label: continuous ? t('Positive hourly net rate') : t('Positive settled rate'), value: of(s.positive), tone: 'buy' });
      if (s.negative > 0) sides.push({ label: continuous ? t('Negative hourly net rate') : t('Negative settled rate'), value: of(s.negative), tone: 'sell' });
      if (s.zero > 0) sides.push({ label: continuous ? t('Zero hourly net rate') : t('Zero rate'), value: of(s.zero) });
      if (s.longestNegative > 0 && s.longestNegative < s.negative) sides.push({ label: continuous ? t('Longest run of negative hourly records') : t('Longest run of negative settled rates'), value: durationText(s.longestNegative) });
      const items: GridItem[] = [{
        key: 'fd-rows', label: venueLabel(venue), value: '', tip: t('Each settlement counts for the interval it paid for, as the steps draw it; the share of time is of the time the settlements represent.'),
        rows: [
          ...(flat ? [] : [{ label: t('Lowest – highest rate'), value: `${rate(s.low!)} – ${rate(s.high!)}` }, { label: t('Time-weighted mean rate'), value: rate(s.mean!), ...tone(s.mean!) }]),
          ...sides,
          { label: continuous ? t('Time represented by hourly records') : t('Time represented by settlements'), value: t('{k} of {n}', { k: durationText(s.covered), n: durationText(s.span) }) },
          ...uncovered,
        ],
        note: continuous ? tn(s.rows, '{n} completed hourly record', '{n} completed hourly records')
          : `${tn(s.rows, '{n} settlement represents part or all of this selection', '{n} settlements represent part or all of this selection')} · ${t('{list} intervals', { list: s.hours.map(h => t('{n} h', { n: h })).join(', ') })}`,
      }];
      lines.push({ key: 'fd-grid', kind: 'grid', cells: [], grid: items });
    }
    // The funding accruing now: apart, never in the settled figures.
    if (s.forming && !kept) {
      const f = s.forming;
      lines.push({ key: 'fd-now', kind: 'stat', ...(f.per8h > 0 ? { tone: 'buy' as const } : f.per8h < 0 ? { tone: 'sell' as const } : {}), cells: [continuous ? t('Current-hour funding estimate') : t('Indicative funding now'), rate(f.per8h)] });
      lines.push(note('fd-now-note', continuous ? t('Next hourly record due at {time}; funding is paid continuously. Not counted above.', { time: clock(f.next ?? s.t1, true) })
        : f.next !== null ? t('Settles at {time}; not counted above.', { time: clock(f.next, true) }) : t('Not counted above.')));
    }
    // Premium: the venue's completed readings wholly inside (candle closes; Hyperliquid's hourly), as samples, and against the base-rate band.
    if (s.premium) {
      const p = s.premium, b = p.band;
      lines.push({ key: 'h-fd-premium', kind: 'heading', cells: [t('Premium index')] });
      lines.push({ key: 'fd-premium-grid', kind: 'grid', cells: [], grid: [{
        key: 'fd-premium', label: venue === 'hyperliquid' ? t('Completed hourly readings') : t('Completed candle closes'), value: '',
        rows: [
          { label: t('First → last reading'), value: `${rate(p.first)} → ${rate(p.last)}` },
          { label: t('Mean of the readings'), value: rate(p.mean), ...(p.mean > 0 ? { tone: 'buy' as const } : p.mean < 0 ? { tone: 'sell' as const } : {}) },
          { label: t('Lowest – highest reading'), value: `${rate(p.low)} – ${rate(p.high)}` },
          ...(b ? [
            { label: t('Base-rate premium band'), value: `${rate(b.lo)} – ${rate(b.hi)}` },
            { label: t('Readings inside the band'), value: t('{k} of {n}', { k: b.inside, n: p.n }) },
            { label: t('Readings below / above it'), value: `${b.below} / ${b.above}` },
          ] : []),
        ],
        note: `${tn(p.n, '{n} completed reading', '{n} completed readings')}${b ? ` · ${t('Inside the band funding settles at the base rate; readings are samples, not time spent.')}` : ''}`,
      }] });
    }
    // Who opened (Hyperliquid): the sided additions of the closed hours added up; a share of the sums.
    if (s.opens && held) {
      lines.push({ key: 'h-fd-opens', kind: 'heading', cells: [t('Who opened (estimate)')] });
      const all = s.opens.long + s.opens.short, amount = (x: number): string => signedCoins(x, s.coin).replace(/^\+/, '');
      if (all > 0) {
        lines.push({ key: 'fd-opens', kind: 'split', share: s.opens.long / all, cells: [t('Buyer-led OI additions {amount}', { amount: amount(s.opens.long) }), t('Seller-led OI additions {amount}', { amount: amount(s.opens.short) })] });
        lines.push({ key: 'fd-opens-share', kind: 'stat', cells: [t('Buyers\' share of sided additions'), `${Math.round(s.opens.long / all * 100)}%`] });
      } else lines.push(note('fd-opens-none', s.opens.hours ? t('No sided additions estimated in these hours.') : held.opens && !held.opens.length
        ? t('Who opened shows where Hyperliquid\'s minute readings and flow are held (its perpetual counted in the OI pane).') : t('No closed hour of who opened lies wholly inside this selection.')));
      if (held.opens?.length) lines.push(note('fd-opens-note', t('{hours} held. Share of sided positive OI additions, estimated from minute open interest and taker flow; not counted openings.', { hours: tn(s.opens.hours, '{n} closed hourly estimate', '{n} closed hourly estimates') })));
    }
    lines.push(note('fd-sign', t('Positive funding: longs pay shorts. Negative funding: shorts pay longs.')));
    return lines;
  }
}
