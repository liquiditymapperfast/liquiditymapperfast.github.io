import { TIMEFRAMES } from '../hub.ts';
import type { Store, AppState } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton } from '../help.ts';
import { setTip } from '../tip.ts';
import { t, tn } from '../i18n.ts';
import { addTune } from '../pane-tune.ts';
import { clock } from '../format.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { AXIS_W, leftGutter } from './heat-pane.ts';
import { TimePane, setHtml } from './lower-panes.ts';
import { PaneTable, placeTable, tableInk, type TableCell, type TableRoom } from './pane-table.ts';
import { mixHex, type Palette } from '../theme.ts';
import type { Pt } from '../touch.ts';
import { currentCoin } from '../coin.ts';
import { VENUE_LINE, venueLabel } from '../venues.ts';
import { drawVenueMark } from '../venue-marks.ts';
import { instrumentIdFor } from '../../shared/coins.ts';
import { FUNDING_VENUES, FundingSource, buyerShare, continuousFunding, cutAt, fundingAt, fundingBase, fundingIn, fundingMedian, fundingTail, fundingVenueOf, hasPremium, medianIn, medianNeeds, rowStart, showsEvery, type FundingNow, type FundingRow, type FundingVenue, type FundingView, type MedianStep, type PremiumRow, type VenueFunding } from '../funding.ts';
import type { HourOpens, NlnsSource } from '../delta/nlns-source.ts';
import { coinText } from '../delta/nlns.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { fitText } from '../text-fit.ts';
import { fundingHeldKey, type FundingPaneHeld } from '../range/funding-lines.ts';

const HOUR = 3_600_000;
/** Settlements a year at one every eight hours: the APR of a rate per eight hours. */
const PER_YEAR = 3 * 365;
/** How strongly the area between the funding and zero is filled, in the buy colour above zero and the sell colour below. */
const SIGN_FILL = 0.13;
/** The base rate per eight hours every venue but Deribit holds funding at: drawn dashed, and kept on the scale, with every venue shown. */
const BASE = fundingBase('hyperliquid').base;

/**
 * Where the Funding pane marks that its share begins (pure): the first hour drawn (`NlnsSource.hourly`), where that is later than the view's
 * first two hours; else null (the view starts inside what is held, or a bar is missing only at its edge). The first bar, not a reach worked out
 * from the clock: the bars also wait for flow (older minutes still on their way, a server that recorded less flow than open interest), and in
 * a replay the readings are those held before it began (review, 2026-11-11).
 */
export function markHour(firstBar: number | undefined, viewStart: number): number | null {
  return firstBar !== undefined && firstBar > Math.floor(viewStart / HOUR) * HOUR + HOUR ? firstBar : null;
}

/**
 * A span back from now as the Funding pane's mark says it (pure): whole hours rounded up below two days, else days rounded. Two minutes come
 * off first: the readings reach a minute or so past a whole hour (`#fine`'s cut), which would make a day "25 hours" in an hour's first minute.
 */
export function reachSpan(ms: number): { n: number; days: boolean } {
  const hours = Math.max(1, Math.ceil((ms - 2 * 60_000) / HOUR));
  return hours >= 48 ? { n: Math.round(hours / 24), days: true } : { n: hours, days: false };
}

/** A rate (a fraction) as a signed percentage: "+0.0100%", "−0.0453%". */
export function rateText(x: number, digits = 4): string { return `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(digits)}%`; }

/**
 * The rate scale's ticks (pure): round values (1, 2, 2.5 or 5 times a power of ten) from `min` to `max`, at least `gapPx` apart over `px`
 * pixels, zero exactly where it falls, and the decimals of a percentage their step needs. A scale that said only its top and bottom left the
 * sign of everything between to be worked out (Karl, 2026-11-17: which side is positive?).
 */
export function rateTicks(min: number, max: number, px: number, gapPx = 26): { values: number[]; digits: number } {
  const span = max - min;
  if (!(span > 0) || !(px > 0)) return { values: [], digits: 2 };
  const raw = span / Math.max(1, Math.floor(px / gapPx)), p10 = 10 ** Math.floor(Math.log10(raw));
  const steps = [p10 / 10, p10, p10 * 10].flatMap(e => [1, 2, 2.5, 5].map(m => m * e)), at = (s: number): number[] => {
    const out: number[] = [];
    for (let k = Math.ceil(min / s - 1e-9); k * s <= max + s * 1e-9; k++) out.push(k === 0 ? 0 : k * s);
    return out;
  };
  // The finest step that keeps `gapPx` between ticks; where that leaves a single tick (a low pane: 0.1 % over 63 px said only "0%"), a finer
  // one down to 14 px apart, so the scale always shows a value either side of a line.
  let step = steps.find(s => s >= raw * (1 - 1e-9)) ?? 10 * p10;
  for (const s of steps.filter(x => x < step).reverse()) { if (at(step).length >= 2 || s * px / span < 14) break; step = s; }
  const values = at(step);
  const pct = step * 100;
  let digits = 0;
  while (digits < 6 && Math.abs(Math.round(pct * 10 ** digits) - pct * 10 ** digits) > 1e-6) digits++;
  return { values, digits };
}
/** The crosshair's value at a height (pure): three decimals of a percentage, four on a scale under 0.01 % tall; no sign where it rounds to zero. */
export function tagText(x: number, span: number): string {
  const digits = span < 0.0001 ? 4 : 3;
  return rateText(Number((x * 100).toFixed(digits)) === 0 ? 0 : x, digits);
}
/** A tick's text: zero as "0%", the rest signed. */
export const tickText = (x: number, digits: number): string => x === 0 ? '0%' : rateText(x, digits);

/** Who pays whom at a rate: positive, longs pay shorts. */
const payerText = (per8h: number): string | null => per8h > 0 ? t('Longs pay shorts') : per8h < 0 ? t('Shorts pay longs') : null;

/**
 * The popup at a time: the funding settled over it, per eight hours and per the venue's own interval, its APR, the premium, and who opened. On a
 * `continuous` venue no settlement stands behind the row and no band is drawn, so neither is named.
 */
export function fundingCardLines(h: { time: number; venue: string; row: FundingRow | null; forming: boolean; premium: number | null; opens: HourOpens | null; coin: string; continuous: boolean; band?: boolean }): InfoLine[] {
  const lines: InfoLine[] = [{ text: `${h.venue} · ${clock(h.time, true)}`, bold: true }];
  if (h.row) {
    const tone = h.row.per8h > 0 ? 'buy' : h.row.per8h < 0 ? 'sell' : 'text', payer = payerText(h.row.per8h);
    lines.push({ label: t('Funding'), text: `${rateText(h.row.per8h)} / 8 h`, color: tone, bold: true });
    if (payer) lines.push({ text: payer, color: 'muted' });
    if (h.row.hours !== 8 && !h.continuous) lines.push({ label: t('Each settlement'), text: `${rateText(h.row.rate, 5)} / ${h.row.hours} h` });
    lines.push({ label: 'APR', text: rateText(h.row.per8h * PER_YEAR, 2) });
    if (!h.continuous) lines.push({ label: h.forming ? t('Settles at') : t('Settled at'), text: clock(h.row.t, true), color: 'muted' });
  }
  if (h.premium !== null) lines.push({ label: t('Premium'), text: rateText(h.premium), color: h.premium > 0 ? 'buy' : h.premium < 0 ? 'sell' : 'text' });
  if (h.opens) {
    const share = buyerShare(h.opens);
    if (share !== null) lines.push({ label: t('Buyers opened'), text: `${Math.round(share * 100)}%`, color: share > 0.5 ? 'buy' : share < 0.5 ? 'sell' : 'text', bold: true, rule: true });
    lines.push({ label: t('New longs'), text: coinText(h.opens.longOpened, h.coin), color: 'buy' }, { label: t('New shorts'), text: coinText(h.opens.shortOpened, h.coin), color: 'sell' });
  }
  // Only where the band's dotted lines are drawn (a venue with a premium line: on OKX and Bitget it would speak of lines not there).
  if (!h.continuous && h.band !== false) lines.push({ text: t('Per eight hours on every venue. Funding stays at its base rate (dashed) while the premium stays between the dotted lines, and follows the premium outside them.'), color: 'muted', wrap: true, rule: true });
  if (h.opens) lines.push({ text: t('Hour by hour, Hyperliquid\'s funding moved with the share of new positions buyers opened at market (measured on every trade of BTC and ETH): context, not a signal.'), color: 'muted', wrap: true });
  return lines;
}

/** One venue's line in the every-venue popup: its id (for its mark), its name and its rate there (null: none held for that time). */
export interface VenueRate { id: string; name: string; per8h: number | null; forming: boolean }

/** The popup with every venue shown: the median, then each venue with its mark, the rate accruing now marked as such. */
export function fundingAllCardLines(h: { time: number; median: { per8h: number } | null; venues: readonly VenueRate[]; need: number }): InfoLine[] {
  const tone = (x: number): 'buy' | 'sell' | 'text' => x > 0 ? 'buy' : x < 0 ? 'sell' : 'text';
  const lines: InfoLine[] = [{ text: `${t('Every venue')} · ${clock(h.time, true)}`, bold: true }];
  if (h.median) {
    lines.push({ label: t('Median'), text: `${rateText(h.median.per8h)} / 8 h`, color: tone(h.median.per8h), bold: true });
    const payer = payerText(h.median.per8h); if (payer) lines.push({ text: payer, color: 'muted' });
    lines.push({ label: 'APR', text: rateText(h.median.per8h * PER_YEAR, 2) });
  }
  h.venues.forEach((v, i) => lines.push({ label: v.name, mark: v.id, ...(i === 0 && h.median ? { rule: true } : {}), ...(v.per8h === null ? { text: '–', color: 'muted' as const } : { text: `${rateText(v.per8h)}${v.forming ? ` ${t('(now)')}` : ''}`, color: tone(v.per8h) }) }));
  lines.push({ text: t('Per eight hours. The thick line is the median of the venues with a rate at that time, drawn where at least {n} have one; dashed, a rate still accruing counts.', { n: h.need }), color: 'muted', wrap: true, rule: true });
  return lines;
}

/** One venue in the table: its name, its funding per eight hours and its premium at the moment read (null: not read, or not said by the venue); `ink`: its name in its line's colour. */
export interface FundingReading { name: string; per8h: number | null; premium: number | null; ink?: string }

/** The Funding pane's table: a venue a row, its funding per eight hours, the yearly rate of that, and its premium where it is held. */
export function fundingTableRows(readings: readonly FundingReading[], p: Pick<Palette, 'bid' | 'ask' | 'text'>): TableCell[][] {
  const ink = (x: number | null): string | undefined => x ? tableInk(x > 0 ? p.bid : p.ask, p) : undefined;
  return readings.map(r => [{ text: r.name, color: r.ink }, { text: r.per8h === null ? '–' : rateText(r.per8h), color: ink(r.per8h) }, { text: r.per8h === null ? '–' : rateText(r.per8h * PER_YEAR, 2) }, { text: r.premium === null ? '–' : rateText(r.premium), color: ink(r.premium) }]);
}

/** A venue's premium at `at`: the one it gives now over the interval under way, else the candle or hour held there. */
const premiumRead = (now: FundingNow | null, forming: boolean, premium: readonly PremiumRow[], ms: number, at: number): number | null => forming && now && now.premium !== null ? now.premium : premiumNear(premium, ms, at);

/** A line's key in the header's readout: a short stroke in its colour (`thin` for the premium's thinner line). */
const key = (color: string, thin = false): string => `<i class="key${thin ? ' thin' : ''}" style="color:${color}"></i>`;

/**
 * The Funding pane (funding.ts): one venue's funding for the chart's coin as steps, each settlement over the interval it paid for, its premium as
 * a line where the venue publishes it, and the dotted edges of the band around the base rate where the premium moves while funding stays put,
 * all per eight hours, on a signed scale with zero drawn and the area between the funding and zero filled by its sign. On Hyperliquid, under
 * it, each hour's share of new positions that buyers opened at market (NL/NS on minute pieces, the model the OI and Delta panes read), set
 * under the funding that hour paid: the link Research OIF-1 measured. Context, not a signal. With every venue picked, each venue's funding as a
 * thin line in its colour and their median as the thick one (no premium, band or who opened: those are one venue's). The table beside it
 * reads every venue that lists the coin at one moment (pane-table.ts), and a click on a row shows that venue.
 */
export class FundingPane extends TimePane {
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  readonly #venue = document.createElement('select');
  readonly #funding: FundingSource;
  #listed = '';
  readonly #tableBox = document.createElement('input');
  /** The venues the table's rows were drawn for. */
  #tableVenues: readonly FundingVenue[] = [];
  readonly #table = new PaneTable({ canvas: this.canvas, left: () => leftGutter(this.store.state), rangeGesture: () => this.rangeGesture, invalidate: () => this.invalidate() }, row => { const venue = this.#tableVenues[row]; if (venue) this.store.set({ fundingVenue: venue }); });

  /** `nlns`: the NL/NS model the OI and Delta panes read too (delta/nlns-source.ts). */
  constructor(host: HTMLElement, store: Store, view: View, private readonly nlns: NlnsSource) {
    super(host, store, view, 'funding');
    this.#funding = new FundingSource(() => this.invalidate());
    this.head.innerHTML = `<strong>${t('Funding')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('fundingPane'));
    setTip(this.head.querySelector('strong')!, t('A perpetual\'s funding and premium on one venue, or every venue\'s funding with their median, per eight hours; on Hyperliquid, under each hour, the share of new positions buyers opened at market.'));
    const wrap = document.createElement('label'); wrap.className = 'ctl'; setTip(wrap, t('Whose funding: every venue with their median, or one of the venues that list a perpetual of the chart\'s coin.')); wrap.append(t('Venue'));
    this.#venue.onchange = () => { const v = this.#venue.value; if (v === 'all' || (FUNDING_VENUES as readonly string[]).includes(v)) store.set({ fundingVenue: v as FundingVenue | 'all' }); };
    wrap.append(this.#venue);
    const table = document.createElement('label'); table.className = 'ctl'; setTip(table, t('Every venue\'s funding in a table on the pane, at the pointer\'s time or the newest. Click a row to show that venue.'));
    this.#tableBox.type = 'checkbox'; this.#tableBox.checked = store.state.fundingTable; this.#tableBox.onchange = () => store.set({ fundingTable: this.#tableBox.checked });
    table.append(this.#tableBox, t('Table'));
    const group = document.createElement('span'); group.className = 'ctl ctl-group'; group.append(wrap, table); this.head.append(group);
    addTune(this.head, [wrap, table], t('Funding'), { fold: true });
    this.#syncVenues();
  }

  /** The venues that list a perpetual of the coin, in the menu after "Every venue", and the one shown selected. */
  #syncVenues(): void {
    const markets = currentCoin().markets, listed = FUNDING_VENUES.filter(v => markets[v]);
    const key = listed.join(',');
    if (key !== this.#listed) { this.#listed = key; this.#venue.replaceChildren(...(listed.length >= 2 ? [new Option(t('Every venue'), 'all')] : []), ...listed.map(v => new Option(venueLabel(v), v))); }
    const shown = showsEvery(this.store.state.fundingVenue, listed.length) ? 'all' : fundingVenueOf(this.store.state.fundingVenue, v => !!markets[v]);
    if (shown && this.#venue.value !== shown) this.#venue.value = shown;
  }

  /** Reflect the settings in the header's controls and draw again. */
  settingsChanged(): void { this.#syncVenues(); this.#tableBox.checked = this.store.state.fundingTable; this.invalidate(); }

  /** What the pane drew last, for the Range summary of a selection made in it (range/funding-lines.ts); null with no venue for the coin, or every venue shown. */
  get rangeHeld(): FundingPaneHeld | null { return this.#rangeHeld; }
  #rangeHeld: FundingPaneHeld | null = null;
  /** What `#rangeHeld` was made from: the source's arrays (replaced whenever a read lands), the replay's cut of them, the reading now, the hours of who opened. */
  #rangeOf: { key: string; rows: readonly FundingRow[]; nRows: number; premium: readonly PremiumRow[]; nPremium: number; premiumMs: number; now: FundingNow | null; opens: readonly HourOpens[] | null; flags: string; replayAt: number | null } | null = null;
  /** The context the pane shows now (the venue resolved as the paint resolves it), or null where no venue lists the coin. */
  rangeKey(state: AppState): string | null {
    const coin = currentCoin(), venue = fundingVenueOf(state.fundingVenue, x => !!coin.markets[x]);
    if (!venue) return null;
    return this.showsEvery(state) ? fundingHeldKey(state, 'all', '') : fundingHeldKey(state, venue, coin.markets[venue]!.symbol);
  }
  /** Whether the pane draws every venue: picked, and two or more venues list the coin (one alone is drawn as itself). */
  showsEvery(state: Pick<AppState, 'fundingVenue'>): boolean {
    const coin = currentCoin();
    return showsEvery(state.fundingVenue, FUNDING_VENUES.filter(x => coin.markets[x]).length);
  }
  /** Keep what this drawing is made of: the same object while none of it changes (a pointer move draws the pane again with it). */
  #keep(state: AppState, venue: FundingVenue, symbol: string, coin: string, data: FundingView, rows: readonly FundingRow[], premium: readonly PremiumRow[], forming: FundingNow | null, opens: readonly HourOpens[] | null, now: number): void {
    const replayAt = replaying() ? Math.floor(now / 60_000) * 60_000 : null, key = fundingHeldKey(state, venue, symbol), flags = `${data.loading}|${data.failed}|${data.from}`;
    // The source replaces its arrays whenever a read lands (a correction inside them included); a replay cuts them, so their lengths count too.
    const of = this.#rangeOf;
    if (of && this.#rangeHeld && of.key === key && of.rows === data.rows && of.nRows === rows.length && of.premium === data.premium && of.nPremium === premium.length
      && of.premiumMs === data.premiumMs && of.now === forming && of.opens === opens && of.flags === flags && of.replayAt === replayAt) return;
    this.#rangeOf = { key, rows: data.rows, nRows: rows.length, premium: data.premium, nPremium: premium.length, premiumMs: data.premiumMs, now: forming, opens, flags, replayAt };
    this.#rangeHeld = { key, venue, coin, tf: state.timeframe, rows, readFrom: data.from ?? null, premium, premiumMs: data.premiumMs, forming, opens, loading: data.loading, failed: data.failed, replayAt };
  }

  protected draw(): void {
    this.#lines = null;
    this.#table.clear();
    const rangeHeld = this.#rangeHeld;
    this.#paint();
    // The Range summary is worked out again only for new readings (a pointer move draws the pane from the same snapshot).
    if (this.#rangeHeld !== rangeHeld) this.rangeChanged();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }
  protected override undrawn(): void { this.#lines = null; this.#table.clear(); this.#card.hide(); }
  protected override ownsPoint(x: number): boolean { return this.#table.owns(x, this.pointer); }
  protected override ownsPress(x: number): boolean { return this.#table.takesPress(x, this.pointer); }
  protected override claimTap(p: Pt): boolean { return this.#table.tap(p); }

  /**
   * Every venue listing the coin at the moment read: the chart's own venue as it is drawn, the others with their funding and the reading now alone (their premium
   * candles are the costly read). Placed first with typical figures: where it would not fit, the other venues are not asked. Where it went, or null.
   * With every venue shown (`all`: their views, already asked, and the median), each name is in its line's colour and the median is the last row.
   */
  #drawTable(venue: FundingVenue | null, shown: FundingView | null, tf: number, at: number, now: number, pointed: boolean, all?: { views: ReadonlyMap<FundingVenue, FundingView>; venues: readonly VenueFunding[]; median: { per8h: number } | null }): ReturnType<PaneTable['draw']> {
    const { ctx, palette: p, view: v } = this, coin = currentCoin(), room: TableRoom = { w: this.w, h: this.h, plotW: this.plotW, axisW: AXIS_W, pointing: this.pointer !== null };
    const listed = FUNDING_VENUES.filter(x => coin.markets[x]), heads = ['', t('Funding'), 'APR', t('Premium')], minCols = 2;
    // One venue: a row that repeats the header; no table, and the popup stays.
    if (listed.length < 2) return null;
    const sample = listed.map(x => ({ name: venueLabel(x), per8h: 0.0001, premium: -0.0004 }));
    if (all) sample.push({ name: t('Median'), per8h: 0.0001, premium: -0.0004 });
    if (!placeTable(text => ctx.measureText(text).width, room, { heads, minCols, rows: fundingTableRows(sample, p) })) return null;
    // With every venue shown, each is read by `fundingIn`, as the median, its popup and its line read it; names in their line's colour, mixed
    // towards the text so that amber and teal read at this size.
    const readings = listed.map((x, i): FundingReading => {
      const data = all?.views.get(x) ?? (x === venue && shown ? shown : this.#funding.view(x, coin.markets[x]!, tf, v.t0, v.t1, Date.now(), false)), held = fundingShownAt(data, now, replaying());
      const { row, forming } = fundingAt(held.rows, held.forming, at, now), every = all?.venues[i], read = every ? fundingIn(every.rows, every.forming, at, now) : null;
      return { name: venueLabel(x), per8h: (every ? read?.per8h : row?.per8h) ?? null, premium: premiumRead(held.forming, every ? !!read?.forming : forming, held.premium, data.premiumMs, at), ...(all ? { ink: mixHex(VENUE_LINE[x] ?? p.text, p.text, 0.35) } : {}) };
    });
    if (all) readings.push({ name: t('Median'), per8h: all.median?.per8h ?? null, premium: null, ink: p.text });
    this.#tableVenues = listed;
    return this.#table.draw(ctx, p, room, { heads, minCols, focus: all ? readings.length - 1 : listed.indexOf(venue!), foot: pointed ? clock(at, true) : `${t('newest')} ${clock(at)}`, rows: fundingTableRows(readings, p) });
  }

  /**
   * The rate scale from `min` to `max` over [top, bottom]: faint lines at round values, zero solid and darker (Karl, 2026-11-17: make zero
   * obvious), the base rate dashed where it is not zero, and the values on the scale. Lines inside the plot's clip; the labels are drawn after it.
   */
  #scale(y: (value: number) => number, min: number, max: number, top: number, bottom: number, base: number): () => void {
    const { ctx, palette: p } = this, pw = this.plotW, ticks = rateTicks(min, max, bottom - top);
    ctx.strokeStyle = p.line; ctx.globalAlpha = 0.45; ctx.beginPath();
    for (const value of ticks.values) if (value !== 0) { const yy = Math.round(y(value)) + 0.5; ctx.moveTo(0, yy); ctx.lineTo(pw, yy); }
    ctx.stroke(); ctx.globalAlpha = 1;
    if (base !== 0) { ctx.strokeStyle = p.muted; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, Math.round(y(base)) + 0.5); ctx.lineTo(pw, Math.round(y(base)) + 0.5); ctx.stroke(); ctx.setLineDash([]); }
    if (min < 0 && max > 0) { ctx.strokeStyle = p.text; ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.moveTo(0, Math.round(y(0)) + 0.5); ctx.lineTo(pw, Math.round(y(0)) + 0.5); ctx.stroke(); ctx.globalAlpha = 1; }
    return () => {
      ctx.textAlign = 'left';
      for (const value of ticks.values) {
        const yy = y(value); if (yy < 4 || yy > this.h - 4) continue;
        ctx.fillStyle = value === 0 ? p.text : p.muted; ctx.fillText(tickText(value, ticks.digits), this.w - AXIS_W + 6, yy);
      }
    };
  }

  /** The area between steps and zero, by sign: the buy colour above, the sell colour below (lighter for the rate still accruing). */
  #signFill(y: (value: number) => number, steps: readonly { x0: number; x1: number; per8h: number; forming?: boolean }[]): void {
    const { ctx, palette: p } = this, y0 = y(0);
    for (const s of steps) {
      if (!s.per8h || s.x1 <= s.x0) continue;
      const yy = y(s.per8h);
      ctx.fillStyle = s.per8h > 0 ? p.bid : p.ask; ctx.globalAlpha = s.forming ? SIGN_FILL / 2 : SIGN_FILL;
      ctx.fillRect(s.x0, Math.min(y0, yy), s.x1 - s.x0, Math.abs(yy - y0));
    }
    ctx.globalAlpha = 1;
  }

  /** A dot where the cursor's time meets a line. */
  #dot(x: number, y: number, color: string): void {
    const { ctx, palette: p } = this;
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = p.bg; ctx.stroke(); ctx.lineWidth = 1;
  }

  #paint(): void {
    const { ctx, palette: p } = this, ph = this.h, state: AppState = this.store.state;
    const readout = this.head.querySelector('.readout'), coin = currentCoin();
    this.#syncVenues();
    const venue = fundingVenueOf(state.fundingVenue, x => !!coin.markets[x]);
    if (!venue) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(t('No venue here lists a perpetual of this coin.'), 12, ph / 2); setHtml(readout, ''); this.#rangeHeld = null; this.#rangeOf = null; return; }
    if (this.showsEvery(state)) this.#paintAll(); else this.#paintOne(venue);
  }

  /** Every venue's funding as a thin step line in its colour, their median thick, on the signed scale; the table names the lines. */
  #paintAll(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state: AppState = this.store.state, now = pageNow();
    const tf = TIMEFRAMES[state.timeframe] ?? HOUR, readout = this.head.querySelector('.readout'), coin = currentCoin();
    // The Range summary sums up one venue: with every venue shown it says so (main.ts), and holds no snapshot.
    this.#rangeHeld = null; this.#rangeOf = null;
    const listed = FUNDING_VENUES.filter(x => coin.markets[x]), views = new Map<FundingVenue, FundingView>();
    // Each venue's settlements and the rate accruing now, without its premium candles (the costly read); a venue that fails costs its own line only.
    const shown = listed.map(x => { const data = this.#funding.view(x, coin.markets[x]!, tf, v.t0, v.t1, Date.now(), false); views.set(x, data); return { id: x, data, ...fundingShownAt(data, now, replaying()) }; });
    const need = medianNeeds(listed.length), venues = shown.map(s => ({ rows: s.rows, forming: s.forming })), median = this.#medianOf(venues, shown.map(x => x.data.rows), v.t0, v.t1, now, need);
    const hover = state.hover, at = hover ? Math.min(hover.t, now) : now;
    // Scale: zero, the base rate, and every venue's steps in view: its settlements, then its rate under way (`fundingTail`: the rate now, or in a replay the newest record carried to the clock), dashed.
    const top = 6, bottom = ph - 6;
    let lo = Math.min(0, BASE), hi = Math.max(0, BASE), any = false;
    const drawn = shown.map(s => {
      const steps: { x0: number; x1: number; per8h: number; forming: boolean; t0: number; t1: number }[] = [];
      for (let i = cutAt(s.rows, v.t0, false); i < s.rows.length; i++) { const r = s.rows[i]!, start = rowStart(s.rows, i); if (start > v.t1) break; steps.push({ x0: v.xOf(start, pw), x1: v.xOf(r.t, pw), per8h: r.per8h, forming: false, t0: start, t1: r.t }); }
      const tail = fundingTail(s.rows, s.forming, now);
      if (tail && tail.end > tail.start && tail.end >= v.t0 && tail.start <= v.t1) steps.push({ x0: v.xOf(tail.start, pw), x1: v.xOf(tail.end, pw), per8h: tail.per8h, forming: true, t0: tail.start, t1: tail.end });
      for (const st of steps) { lo = Math.min(lo, st.per8h); hi = Math.max(hi, st.per8h); any = true; }
      return { id: s.id, steps };
    });
    if (!any) {
      if (state.fundingTable && this.#drawTable(null, null, tf, at, now, !!hover, { views, venues, median: medianIn(venues, at, now, need) })?.plate) { setHtml(readout, ''); return; }
      ctx.fillStyle = p.muted; ctx.textAlign = 'left';
      const failed = shown.filter(s => s.data.failed).map(s => venueLabel(s.id));
      const said = shown.some(s => s.data.loading) ? t('Reading funding…') : failed.length === shown.length ? t('{venue} did not answer: asked again in a minute.', { venue: failed.join(', ') }) : t('No funding in view.');
      ctx.fillText(fitText(text => ctx.measureText(text).width, said, pw - 24), 12, ph / 2); setHtml(readout, '');
      return;
    }
    // A floor under the scale's span: a view of tiny rates (Deribit's) would otherwise ask for more decimals than the ticks are given.
    const pad = Math.max((hi - lo) * 0.08, 0.00001), min = lo - pad, max = hi + pad;
    const y = (value: number): number => top + (1 - (value - min) / (max - min)) * (bottom - top);
    this.scaleAt = yy => tagText(min + (1 - (yy - top) / (bottom - top)) * (max - min), max - min);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    const labels = this.#scale(y, min, max, top, bottom, BASE);
    const medianSteps = median.map(s => ({ x0: v.xOf(s.t0, pw), x1: v.xOf(s.t1, pw), per8h: s.per8h, forming: s.forming }));
    this.#signFill(y, medianSteps);
    // Each venue thin in its colour, the rate under way dashed; its mark where it ends (at the plot's edge where it ends beyond it), kept apart from the others.
    const ends: { id: string; x: number; y: number }[] = [];
    for (const d of drawn) {
      if (!d.steps.length) continue;
      ctx.strokeStyle = VENUE_LINE[d.id] ?? p.muted; ctx.lineWidth = 1.25; ctx.globalAlpha = 0.85;
      for (const forming of [false, true]) {
        ctx.setLineDash(forming ? [4, 3] : []); ctx.beginPath();
        let lastT = NaN;
        for (const st of d.steps) { if (st.forming !== forming) continue; const yy = y(st.per8h); if (st.t0 === lastT) ctx.lineTo(st.x0, yy); else ctx.moveTo(st.x0, yy); ctx.lineTo(st.x1, yy); lastT = st.t1; }
        ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.lineWidth = 1;
      const last = d.steps[d.steps.length - 1]!;
      // In a replay a carried line ends at the moment shown, and right of it the mask covers the plot: the mark stays left of it (review round 2).
      if (last.x1 > -8) ends.push({ id: d.id, x: Math.min(pw - 8, last.x1 + 8, replaying() ? v.xOf(now, pw) - 8 : Infinity), y: y(last.per8h) });
    }
    // The median, thick in the text colour over them: joined where one step follows the next, dashed where a rate under way counts.
    ctx.strokeStyle = p.text; ctx.lineWidth = 2.5;
    for (const forming of [false, true]) {
      ctx.setLineDash(forming ? [5, 3] : []); ctx.beginPath();
      let lastT = NaN;
      median.forEach((s, i) => { if (s.forming !== forming) return; const m = medianSteps[i]!, yy = y(s.per8h); if (s.t0 === lastT) ctx.lineTo(m.x0, yy); else ctx.moveTo(m.x0, yy); ctx.lineTo(m.x1, yy); lastT = s.t1; });
      ctx.stroke();
    }
    ctx.setLineDash([]); ctx.lineWidth = 1;
    ends.sort((a, b) => a.y - b.y);
    const near = (a: { x: number }, b: { x: number }): boolean => Math.abs(a.x - b.x) < 14;
    // Down, then pushed past the bottom pulled back up from it, so the marks do not pile on one row there; again until nothing moves ("near" is
    // not transitive: a dense cluster needs more than one sweep each way), a few times at most.
    for (let round = 0; round < 6; round++) {
      const before = ends.map(e => e.y).join();
      for (let i = 1; i < ends.length; i++) for (let j = 0; j < i; j++) { const e = ends[i]!, o = ends[j]!; if (near(e, o) && Math.abs(e.y - o.y) < 14) e.y = o.y + 14; }
      for (let i = ends.length - 1; i >= 0; i--) { const e = ends[i]!; e.y = Math.min(e.y, bottom - 6); for (let j = ends.length - 1; j > i; j--) { const o = ends[j]!; if (near(e, o) && Math.abs(o.y - e.y) < 14) e.y = o.y - 14; } }
      if (ends.map(e => e.y).join() === before) break;
    }
    for (const e of ends) drawVenueMark(ctx, e.id, e.x, Math.max(top + 6, Math.min(bottom - 6, e.y)), 12);
    // The median at the time read, from the venues there (not from the line drawn for the view, which ends where the view does).
    const medianNow = medianIn(venues, at, now, need);
    if (hover && this.pointer && medianNow) this.#dot(v.xOf(at, pw), y(medianNow.per8h), p.text);
    ctx.restore();
    labels();
    if (hover && this.pointer && hover.t > at) this.cursorT = at;
    // A table drawn takes the popup's place, as on every pane with one; the left tag stays unless the table is on a plate there.
    const placed = state.fundingTable ? this.#drawTable(null, null, tf, at, now, !!hover, { views, venues, median: medianNow }) : null;
    this.leftTag = placed?.plate !== true;
    if (hover && this.pointer && !placed) {
      this.#lines = fundingAllCardLines({ time: at, median: medianNow, need, venues: shown.map(s => { const r = fundingIn(s.rows, s.forming, at, now); return { id: s.id, name: venueLabel(s.id), per8h: r?.per8h ?? null, forming: r?.forming ?? false }; }) });
    }
    const tone = (x: number): string => x > 0 ? 'bid' : x < 0 ? 'ask' : '';
    setHtml(readout, medianNow
      ? `${key(p.text)}${t('Median')} <b class="${tone(medianNow.per8h)}">${rateText(medianNow.per8h)}</b> / 8 h · APR ${rateText(medianNow.per8h * PER_YEAR, 2)} <span class="muted">${t('{n} of {m} venues', { n: medianNow.n, m: listed.length })}</span>`
      : `<span class="muted">${t('Too few venues for a median here.')}</span>`);
  }

  /**
   * The median line, worked out for a window half a view wider than the view on each side and used again while the view stays inside it (and
   * is not zoomed in to under a quarter of the view it was worked out for), the venues' readings, the count needed and the minute unchanged. A pointer move draws the pane again,
   * and a map following the live edge (or a replay playing) moves the view a little every frame: keyed on the view itself it was worked out again
   * every frame, up to 14 ms on a view of months (review round 3). The clip leaves out what lies outside the view. Keyed on the source's arrays
   * and the lengths shown of them: a replay's cut is a new slice every frame (round 2).
   */
  #medianMemo: { key: unknown[]; w0: number; w1: number; steps: MedianStep[] } | null = null;
  #medianOf(venues: readonly VenueFunding[], sources: readonly (readonly FundingRow[])[], t0: number, t1: number, now: number, need: number): MedianStep[] {
    const key: unknown[] = [need, Math.floor(now / 60_000), ...venues.flatMap((x, i) => [sources[i], x.rows.length, x.forming])];
    const memo = this.#medianMemo, span = t1 - t0;
    if (memo && t0 >= memo.w0 && t1 <= memo.w1 && span * 8 >= memo.w1 - memo.w0 && memo.key.length === key.length && memo.key.every((k, i) => k === key[i])) return memo.steps;
    const w0 = t0 - span / 2, w1 = t1 + span / 2, steps = fundingMedian(venues, w0, w1, now, need);
    this.#medianMemo = { key, w0, w1, steps };
    return steps;
  }

  #paintOne(venue: FundingVenue): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state: AppState = this.store.state, now = pageNow();
    const tf = TIMEFRAMES[state.timeframe] ?? HOUR, readout = this.head.querySelector('.readout'), coin = currentCoin();
    const say = (text: string): void => { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(text, 12, ph / 2); setHtml(readout, ''); };
    const name = venueLabel(venue), data = this.#funding.view(venue, coin.markets[venue]!, tf, v.t0, v.t1, Date.now());
    // Replay: only what had settled by the moment shown, and no funding accruing "now".
    const { rows, premium, forming } = fundingShownAt(data, now, replaying());
    // The funding accruing now pays for the interval that ends at its settlement, whatever has come in of the settlements before it.
    const formEnd = forming ? forming.next ?? now : 0, formStart = forming ? formEnd - forming.hours * HOUR : 0;
    const formShown = !!forming && formEnd >= v.t0 && formStart <= v.t1;
    // Who opened, on Hyperliquid: its perpetual's minute pieces, hour by hour (while it is among the markets the OI pane counts).
    const hl = venue === 'hyperliquid' ? instrumentIdFor('hyperliquid', coin) : null;
    const opens = hl ? this.nlns.hourly(state, hl, v.t0, now) : [];
    const band = venue === 'hyperliquid' && ph >= 90;
    // The Range summary's snapshot, before any early return below (an empty or failed view publishes that, not the last venue's).
    this.#keep(state, venue, coin.markets[venue]!.symbol, coin.coin, data, rows, premium, forming, hl ? opens : null, now);
    const visIdx: number[] = []; rows.forEach((r, i) => { if (r.t >= v.t0 && rowStart(rows, i) <= v.t1) visIdx.push(i); });
    const visRows = visIdx.map(i => rows[i]!), visPremium = premium.slice(cutAt(premium, v.t0 - data.premiumMs, false), cutAt(premium, v.t1));
    const hover = state.hover, at = hover ? Math.min(hover.t, now) : now;
    if (!visRows.length && !visPremium.length && !formShown) {
      // The other venues stay in reach: a click on a row that does not answer is no way to lose the table. On a plate the table stands where the words would.
      if (state.fundingTable && this.#drawTable(venue, data, tf, at, now, !!hover)?.plate) { setHtml(readout, ''); return; }
      say(data.failed ? t('{venue} did not answer: asked again in a minute.', { venue: name }) : data.loading ? t('Reading funding…') : t('No funding in view.'));
      return;
    }
    // Geometry: funding and premium on top, who opened under it (Hyperliquid, a pane tall enough).
    const top = 6, lineBottom = band ? Math.round(ph * 0.62) : ph - 6, bandTop = lineBottom + 10, bandBottom = ph - 4, mid = (bandTop + bandBottom) / 2, half = (bandBottom - bandTop) / 2;
    // The premium's band only where a premium line is drawn: the band is where the premium moves while funding stays at base, and on OKX and
    // Bitget, with no premium history, it only squeezed their steps into a third of the height.
    const { base, clamp: rawClamp } = fundingBase(venue), clamp = hasPremium(venue) ? rawClamp : 0;
    let lo = Math.min(0, base - clamp), hi = Math.max(0, base + clamp);
    for (const r of visRows) { lo = Math.min(lo, r.per8h); hi = Math.max(hi, r.per8h); }
    for (const q of visPremium) { lo = Math.min(lo, q.p); hi = Math.max(hi, q.p); }
    // The premium now only where a premium is drawn: elsewhere it would set a scale for something not on it (a Deribit premium of 0.026 % over steps of 0.01 % left them a third of the height).
    if (forming && formShown) { lo = Math.min(lo, forming.per8h); hi = Math.max(hi, forming.per8h); if (forming.premium !== null && hasPremium(venue)) { lo = Math.min(lo, forming.premium); hi = Math.max(hi, forming.premium); } }
    // A view whose every rate is exactly 0 (Deribit has whole runs of zero hours, and no band to widen the scale) still has a scale.
    // A floor under the scale's span, as with every venue: tiny rates (Deribit's) would ask for more decimals than the ticks are given.
    const pad = Math.max((hi - lo) * 0.08, 0.00001), min = lo - pad, max = hi + pad;
    const y = (value: number): number => top + (1 - (value - min) / (max - min)) * (lineBottom - top);
    this.scaleAt = at => at <= lineBottom ? tagText(min + (1 - (at - top) / (lineBottom - top)) * (max - min), max - min)
      : band && at >= bandTop && at <= bandBottom ? `${Math.round(50 + (mid - at) / half * 50)}%` : null;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    // The scale (round values, zero, the base rate dashed), then the funding's sign as a fill between it and zero.
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, lineBottom + 2); ctx.clip();
    const labels = this.#scale(y, min, max, top, lineBottom, base);
    const steps: { x0: number; x1: number; per8h: number; forming?: boolean }[] = visIdx.map(i => ({ x0: v.xOf(rowStart(rows, i), pw), x1: v.xOf(rows[i]!.t, pw), per8h: rows[i]!.per8h }));
    if (forming && formShown) steps.push({ x0: v.xOf(formStart, pw), x1: v.xOf(formEnd, pw), per8h: forming.per8h, forming: true });
    this.#signFill(y, steps);
    // The band the premium moves in while funding stays at the base rate: its two edges, dotted in the premium's colour (a shaded box read as
    // "inside positive, outside negative", Karl 2026-11-17), named inside where the words fit whole.
    if (clamp > 0) {
      const yTop = Math.round(y(base + clamp)) + 0.5, yBottom = Math.round(y(base - clamp)) + 0.5;
      ctx.strokeStyle = p.poc; ctx.globalAlpha = 0.7; ctx.setLineDash([1, 3]); ctx.beginPath(); ctx.moveTo(0, yTop); ctx.lineTo(pw, yTop); ctx.moveTo(0, yBottom); ctx.lineTo(pw, yBottom); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      const room = pw * 0.8, inside = yBottom - yTop;
      if (inside >= 30) {
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        const label = [t('Premium between the dotted lines: funding stays at the base rate'), t('Premium band')].find(text => ctx.measureText(text).width <= room);
        if (label) { ctx.fillStyle = p.poc; ctx.textAlign = 'left'; ctx.fillText(label, 8, yTop + 8); }
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      }
    }
    // The premium, through each candle's middle, in a hue of its own (the funding steps are the text colour).
    if (visPremium.length) {
      ctx.strokeStyle = p.poc; ctx.lineWidth = 1.25; ctx.beginPath();
      visPremium.forEach((q, i) => { const x = v.xOf(q.t + data.premiumMs / 2, pw); if (i) ctx.lineTo(x, y(q.p)); else ctx.moveTo(x, y(q.p)); });
      ctx.stroke(); ctx.lineWidth = 1;
    }
    // Funding as steps: each settlement over the interval it paid for, joined where one follows the other; the one accruing now dashed.
    ctx.strokeStyle = p.text; ctx.lineWidth = 2; ctx.beginPath();
    let last: FundingRow | null = null;
    for (const i of visIdx) {
      const r = rows[i]!, start = rowStart(rows, i), x0 = v.xOf(start, pw), x1 = v.xOf(r.t, pw), yy = y(r.per8h);
      if (last && last.t === start) ctx.lineTo(x0, yy); else ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy); last = r;
    }
    ctx.stroke();
    if (forming && formShown) {
      ctx.setLineDash([4, 3]); ctx.globalAlpha = 0.8; ctx.beginPath(); ctx.moveTo(v.xOf(formStart, pw), y(forming.per8h)); ctx.lineTo(v.xOf(formEnd, pw), y(forming.per8h)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 1;
    // Where the cursor's time meets the funding and the premium.
    const { row: shownRow, forming: isForming } = fundingAt(rows, forming, at, now);
    // The premium under way is the venue's own now, where it says it (the last candle's is up to a candle old).
    const premiumAt = premiumRead(forming, isForming, premium, data.premiumMs, at);
    if (hover && this.pointer) {
      const xc = v.xOf(at, pw);
      if (premiumAt !== null && hasPremium(venue)) this.#dot(xc, y(premiumAt), p.poc);
      if (shownRow) this.#dot(xc, y(shownRow.per8h), p.text);
    }
    ctx.restore();
    // Who opened, each hour under the funding it paid: up in the buy colour where buyers opened more than half the new positions, down in the
    // sell colour where sellers did, as far as the share is from even.
    if (band) {
      ctx.strokeStyle = p.line; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(0, Math.round(mid) + 0.5); ctx.lineTo(pw, Math.round(mid) + 0.5); ctx.stroke(); ctx.globalAlpha = 1;
      for (const h of opens) {
        const share = buyerShare(h); if (share === null || h.t + HOUR < v.t0 || h.t > v.t1) continue;
        // The hour under way is lighter: its share is of what has opened so far.
        const x0 = v.xOf(h.t, pw), x1 = v.xOf(h.t + HOUR, pw), len = Math.max(1, Math.abs(share - 0.5) * 2 * half);
        ctx.fillStyle = share >= 0.5 ? p.candleUp : p.candleDown; ctx.globalAlpha = h.t + HOUR > now ? 0.4 : 0.8;
        ctx.fillRect(x0 + 0.5, share >= 0.5 ? mid - len : mid, Math.max(1, x1 - x0 - 1), len);
      }
      ctx.globalAlpha = 1;
      // Where who opened begins (`markHour`: a day back in a page, a week on a server, later where less is held): a dotted mark across the band
      // and, left of it, how far back that is, so the empty band before it reads as out of reach, not as nobody opening (Karl, 2026-11-11: the
      // bars stopped a day back on a chart days wide, with nothing to say why).
      const markT = markHour(opens[0]?.t, v.t0), rx = markT === null ? -1 : Math.round(v.xOf(markT, pw)) + 0.5;
      if (markT !== null && rx > 0 && rx < pw) {
        ctx.strokeStyle = p.muted; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(rx, bandTop); ctx.lineTo(rx, bandBottom); ctx.stroke(); ctx.setLineDash([]);
        // The whole label where it fits, else the span alone, else nothing (cut with an ellipsis it said only "Who opened…").
        const { n, days } = reachSpan(now - markT), room = rx - 12;
        const label = (days ? [t('Who opened: the last {n} days', { n }), t('last {n} days', { n })] : [tn(n, 'Who opened: the last {n} hour', 'Who opened: the last {n} hours'), tn(n, 'last {n} hour', 'last {n} hours')])
          .find(text => ctx.measureText(text).width <= room);
        if (label) { ctx.fillStyle = p.muted; ctx.textAlign = 'right'; ctx.fillText(label, rx - 6, mid); }
      }
    }
    ctx.restore();
    // The scale's values, and the band's even line.
    labels();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    if (band) ctx.fillText('50%', this.w - AXIS_W + 6, mid);
    // Cut to the plot with an ellipsis: some languages say it in half again as many letters (the pane's help says it whole).
    if (band && !opens.length) { ctx.fillStyle = p.muted; ctx.fillText(fitText(s => ctx.measureText(s).width, t('Who opened shows where Hyperliquid\'s minute readings and flow are held (its perpetual counted in the OI pane).'), pw - 16), 8, mid); }
    // Readout and popup: the time under the pointer, else now; past now (the view's room on the right) it stays at now, as the other panes
    // stay at their newest, and the cursor is drawn there.
    if (hover && this.pointer && hover.t > at) this.cursorT = at;
    const hourOpens = opens.find(h => h.t <= at && at < h.t + HOUR) ?? null;
    // A table drawn takes the popup's place, as on every pane with one (Table off brings back who opened and when it settled); the left tag stays
    // unless the table is on a plate there.
    const placed = state.fundingTable ? this.#drawTable(venue, data, tf, at, now, !!hover) : null;
    this.leftTag = placed?.plate !== true;
    if (hover && this.pointer && !placed) this.#lines = fundingCardLines({ time: at, venue: name, row: shownRow, forming: isForming, premium: premiumAt, opens: hourOpens, coin: coin.coin, continuous: continuousFunding(venue), band: hasPremium(venue) });
    const tone = (x: number): string => x > 0 ? 'bid' : x < 0 ? 'ask' : '';
    const parts: string[] = [];
    if (shownRow) parts.push(`${key(p.text)}${t('Funding')} <b class="${tone(shownRow.per8h)}">${rateText(shownRow.per8h)}</b> / 8 h · APR ${rateText(shownRow.per8h * PER_YEAR, 2)}`);
    if (premiumAt !== null) parts.push(`${hasPremium(venue) ? key(p.poc, true) : ''}${t('Premium')} <b class="${tone(premiumAt)}">${rateText(premiumAt)}</b>`);
    const share = hourOpens ? buyerShare(hourOpens) : null;
    if (share !== null) parts.push(`${t('Buyers opened')} <b class="${share > 0.5 ? 'bid' : share < 0.5 ? 'ask' : ''}">${Math.round(share * 100)}%</b>`);
    if (!hasPremium(venue)) parts.push(`<span class="muted">${t('no premium history')}</span>`);
    setHtml(readout, `${parts.join(' · ')} <span class="muted">${name}</span>`);
  }
}

/** What had been published by `now`: cut where it falls, not filtered, as up to 24,000 premium candles are held and the pane paints with every frame that moves. */
function upTo<T extends { t: number }>(list: readonly T[], now: number): readonly T[] { const n = cutAt(list, now); return n < list.length ? list.slice(0, n) : list; }

/**
 * What the pane shows of a venue's funding at `now` (its paint and its table alike): the settlements made by then; the premium readings, in a
 * replay only those whose candle (or hour) had closed by its moment (a candle is stamped at its start, its close its last value: cut at its start,
 * a replay showed the value the candle ended on before it had); and the funding accruing now, live only (a replay a few seconds behind real
 * time showed today's reading at its moment).
 */
export function fundingShownAt(data: Pick<FundingView, 'rows' | 'premium' | 'premiumMs' | 'now'>, now: number, replay: boolean): { rows: readonly FundingRow[]; premium: readonly PremiumRow[]; forming: FundingNow | null } {
  return { rows: upTo(data.rows, now), premium: upTo(data.premium, replay ? now - data.premiumMs : now), forming: replay ? null : data.now };
}

/** The premium of the candle holding `t` (published per candle of `ms`), else the last before it within one candle; null where none is held. */
function premiumNear(rows: readonly PremiumRow[], ms: number, t: number): number | null {
  const q = rows[cutAt(rows, t) - 1];
  return q && t - q.t < 2 * ms ? q.p : null;
}
