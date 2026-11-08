import { TIMEFRAMES } from '../hub.ts';
import type { Store, AppState } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton } from '../help.ts';
import { setTip } from '../tip.ts';
import { t } from '../i18n.ts';
import { addTune } from '../pane-tune.ts';
import { clock } from '../format.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { AXIS_W } from './heat-pane.ts';
import { TimePane, setHtml } from './lower-panes.ts';
import { currentCoin } from '../coin.ts';
import { venueLabel } from '../venues.ts';
import { instrumentIdFor } from '../../shared/coins.ts';
import { FUNDING_VENUES, FundingSource, buyerShare, continuousFunding, cutAt, fundingBase, fundingVenueOf, hasPremium, rowAt, type FundingRow, type FundingVenue, type PremiumRow } from '../funding.ts';
import type { HourOpens, NlnsSource } from '../delta/nlns-source.ts';
import { coinText } from '../delta/nlns.ts';
import { pageNow } from '../replay/clock.ts';
import { fitText } from '../text-fit.ts';

const HOUR = 3_600_000;
/** Settlements a year at one every eight hours: the APR of a rate per eight hours. */
const PER_YEAR = 3 * 365;

/** A rate (a fraction) as a signed percentage: "+0.0100%", "−0.0453%". */
export function rateText(x: number, digits = 4): string { return `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(digits)}%`; }

/**
 * The popup at a time: the funding settled over it, per eight hours and per the venue's own interval, its APR, the premium, and who opened. On a
 * `continuous` venue no settlement stands behind the row and no band is drawn, so neither is named.
 */
export function fundingCardLines(h: { time: number; venue: string; row: FundingRow | null; forming: boolean; premium: number | null; opens: HourOpens | null; coin: string; continuous: boolean }): InfoLine[] {
  const lines: InfoLine[] = [{ text: `${h.venue} · ${clock(h.time, true)}`, bold: true }];
  if (h.row) {
    const tone = h.row.per8h > 0 ? 'buy' : h.row.per8h < 0 ? 'sell' : 'text';
    lines.push({ label: t('Funding'), text: `${rateText(h.row.per8h)} / 8 h`, color: tone, bold: true });
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
  if (!h.continuous) lines.push({ text: t('Per eight hours on every venue. Funding stays at its base rate (dashed) while the premium stays in the shaded band, and follows the premium outside it.'), color: 'muted', wrap: true, rule: true });
  if (h.opens) lines.push({ text: t('Hour by hour, Hyperliquid\'s funding moved with the share of new positions buyers opened at market (measured on every trade of BTC and ETH): context, not a signal.'), color: 'muted', wrap: true });
  return lines;
}

/**
 * The Funding pane (funding.ts): one venue's funding for the chart's coin as steps, each settlement over the interval it paid for, its premium as
 * a line where the venue publishes it, and the band around the base rate where the premium moves while funding stays put, all per eight
 * hours. On Hyperliquid, under it, each hour's share of new positions that buyers opened at market (NL/NS on minute pieces, the model the OI
 * and Delta panes read), set under the funding that hour paid: the link Research OIF-1 measured. Context, not a signal.
 */
export class FundingPane extends TimePane {
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  readonly #venue = document.createElement('select');
  readonly #funding: FundingSource;
  #listed = '';

  /** `nlns`: the NL/NS model the OI and Delta panes read too (delta/nlns-source.ts). */
  constructor(host: HTMLElement, store: Store, view: View, private readonly nlns: NlnsSource) {
    super(host, store, view, 'funding');
    this.#funding = new FundingSource(() => this.invalidate());
    this.head.innerHTML = `<strong>${t('Funding')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('fundingPane'));
    setTip(this.head.querySelector('strong')!, t('A perpetual\'s funding and premium on one venue, per eight hours; on Hyperliquid, under each hour, the share of new positions buyers opened at market.'));
    const wrap = document.createElement('label'); wrap.className = 'ctl'; setTip(wrap, t('Whose funding: the venues that list a perpetual of the chart\'s coin.')); wrap.append(t('Venue'));
    this.#venue.onchange = () => { const v = this.#venue.value; if ((FUNDING_VENUES as readonly string[]).includes(v)) store.set({ fundingVenue: v as FundingVenue }); };
    wrap.append(this.#venue);
    const group = document.createElement('span'); group.className = 'ctl ctl-group'; group.append(wrap); this.head.append(group);
    addTune(this.head, [wrap], t('Funding'));
    this.#syncVenues();
  }

  /** The venues that list a perpetual of the coin, in the menu, and the one shown selected. */
  #syncVenues(): void {
    const markets = currentCoin().markets, listed = FUNDING_VENUES.filter(v => markets[v]);
    const key = listed.join(',');
    if (key !== this.#listed) { this.#listed = key; this.#venue.replaceChildren(...listed.map(v => new Option(venueLabel(v), v))); }
    const shown = fundingVenueOf(this.store.state.fundingVenue, v => !!markets[v]);
    if (shown && this.#venue.value !== shown) this.#venue.value = shown;
  }

  /** Reflect the settings in the header's controls and draw again. */
  settingsChanged(): void { this.#syncVenues(); this.invalidate(); }

  protected draw(): void {
    this.#lines = null;
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }
  protected override undrawn(): void { this.#lines = null; this.#card.hide(); }

  #paint(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state: AppState = this.store.state, now = pageNow();
    const tf = TIMEFRAMES[state.timeframe] ?? HOUR, readout = this.head.querySelector('.readout'), coin = currentCoin();
    this.#syncVenues();
    const venue = fundingVenueOf(state.fundingVenue, x => !!coin.markets[x]);
    const say = (text: string): void => { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(text, 12, ph / 2); setHtml(readout, ''); };
    if (!venue) { say(t('No venue here lists a perpetual of this coin.')); return; }
    const name = venueLabel(venue), data = this.#funding.view(venue, coin.markets[venue]!, tf, v.t0, v.t1, Date.now());
    // Replay: only what had settled by the moment shown, and no funding accruing "now". Cut where `now` falls, not filtered: up to 24,000
    // premium candles are held, and the pane paints with every frame that moves.
    const upTo = <T extends { t: number }>(list: readonly T[]): readonly T[] => { const n = cutAt(list, now); return n < list.length ? list.slice(0, n) : list; };
    const rows = upTo(data.rows), premium = upTo(data.premium), forming = now >= Date.now() - 60_000 ? data.now : null;
    // The funding accruing now pays for the interval that ends at its settlement, whatever has come in of the settlements before it.
    const formEnd = forming ? forming.next ?? now : 0, formStart = forming ? formEnd - forming.hours * HOUR : 0;
    const formShown = !!forming && formEnd >= v.t0 && formStart <= v.t1;
    // Who opened, on Hyperliquid: its perpetual's minute pieces, hour by hour (while it is among the markets the OI pane counts).
    const hl = venue === 'hyperliquid' ? instrumentIdFor('hyperliquid', coin) : null;
    const opens = hl ? this.nlns.hourly(state, hl, v.t0, now) : [];
    const band = venue === 'hyperliquid' && ph >= 90;
    const visRows = rows.filter(r => r.t >= v.t0 && r.t - r.hours * HOUR <= v.t1), visPremium = premium.slice(cutAt(premium, v.t0 - data.premiumMs, false), cutAt(premium, v.t1));
    if (!visRows.length && !visPremium.length && !formShown) { say(data.failed ? t('{venue} did not answer: asked again in a minute.', { venue: name }) : data.loading ? t('Reading funding…') : t('No funding in view.')); return; }
    // Geometry: funding and premium on top, who opened under it (Hyperliquid, a pane tall enough).
    const top = 6, lineBottom = band ? Math.round(ph * 0.62) : ph - 6, bandTop = lineBottom + 10, bandBottom = ph - 4, mid = (bandTop + bandBottom) / 2, half = (bandBottom - bandTop) / 2;
    const { base, clamp } = fundingBase(venue);
    let lo = Math.min(0, base - clamp), hi = Math.max(0, base + clamp);
    for (const r of visRows) { lo = Math.min(lo, r.per8h); hi = Math.max(hi, r.per8h); }
    for (const q of visPremium) { lo = Math.min(lo, q.p); hi = Math.max(hi, q.p); }
    // The premium now only where a premium is drawn: elsewhere it would set a scale for something not on it (a Deribit premium of 0.026 % over steps of 0.01 % left them a third of the height).
    if (forming && formShown) { lo = Math.min(lo, forming.per8h); hi = Math.max(hi, forming.per8h); if (forming.premium !== null && hasPremium(venue)) { lo = Math.min(lo, forming.premium); hi = Math.max(hi, forming.premium); } }
    // A view whose every rate is exactly 0 (Deribit has whole runs of zero hours, and no band to widen the scale) still has a scale.
    const pad = (hi - lo) * 0.08 || 0.0001, min = lo - pad, max = hi + pad;
    const y = (value: number): number => top + (1 - (value - min) / (max - min)) * (lineBottom - top);
    this.scaleAt = at => at <= lineBottom ? rateText(min + (1 - (at - top) / (lineBottom - top)) * (max - min), 3)
      : band && at >= bandTop && at <= bandBottom ? `${Math.round(50 + (mid - at) / half * 50)}%` : null;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    // The band the premium moves in while funding stays at the base rate (none for a venue without one), the base rate (dashed) and zero.
    if (clamp > 0) { ctx.fillStyle = p.text; ctx.globalAlpha = 0.06; ctx.fillRect(0, y(base + clamp), pw, y(base - clamp) - y(base + clamp)); ctx.globalAlpha = 1; }
    ctx.strokeStyle = p.muted; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, Math.round(y(base)) + 0.5); ctx.lineTo(pw, Math.round(y(base)) + 0.5); ctx.stroke(); ctx.setLineDash([]);
    if (base !== 0) { ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, Math.round(y(0)) + 0.5); ctx.lineTo(pw, Math.round(y(0)) + 0.5); ctx.stroke(); }
    // The premium, through each candle's middle, in a hue of its own (the funding steps are the text colour).
    if (visPremium.length) {
      ctx.strokeStyle = p.poc; ctx.lineWidth = 1.25; ctx.beginPath();
      visPremium.forEach((q, i) => { const x = v.xOf(q.t + data.premiumMs / 2, pw); if (i) ctx.lineTo(x, y(q.p)); else ctx.moveTo(x, y(q.p)); });
      ctx.stroke(); ctx.lineWidth = 1;
    }
    // Funding as steps: each settlement over the interval it paid for, joined where one follows the other; the one accruing now dashed.
    ctx.strokeStyle = p.text; ctx.lineWidth = 2; ctx.beginPath();
    let last: FundingRow | null = null;
    for (const r of visRows) {
      const x0 = v.xOf(r.t - r.hours * HOUR, pw), x1 = v.xOf(r.t, pw), yy = y(r.per8h);
      if (last && last.t === r.t - r.hours * HOUR) ctx.lineTo(x0, yy); else ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy); last = r;
    }
    ctx.stroke();
    const newest = rows[rows.length - 1];
    if (forming && formShown) {
      ctx.setLineDash([4, 3]); ctx.globalAlpha = 0.8; ctx.beginPath(); ctx.moveTo(v.xOf(formStart, pw), y(forming.per8h)); ctx.lineTo(v.xOf(formEnd, pw), y(forming.per8h)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 1;
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
    }
    ctx.restore();
    // The scale: the top and bottom of the rates, and the band's even line.
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    ctx.fillText(rateText(max, 3), this.w - AXIS_W + 6, 10); ctx.fillText(rateText(min, 3), this.w - AXIS_W + 6, lineBottom - 4);
    if (band) ctx.fillText('50%', this.w - AXIS_W + 6, mid);
    // Cut to the plot with an ellipsis: some languages say it in half again as many letters (the pane's help says it whole).
    if (band && !opens.length) { ctx.fillStyle = p.muted; ctx.fillText(fitText(s => ctx.measureText(s).width, t('Who opened shows where Hyperliquid\'s minute readings and flow are held (its perpetual counted in the OI pane).'), pw - 16), 8, mid); }
    // Readout and popup: the time under the pointer, else now; past now (the view's room on the right) it stays at now, as the other panes
    // stay at their newest, and the cursor is drawn there.
    const hover = state.hover, at = hover ? Math.min(hover.t, now) : now;
    if (hover && this.pointer && hover.t > at) this.cursorT = at;
    // The funding accruing now over its interval; while a venue says nothing of it, its newest record shows after it.
    const settled = rowAt(rows, at), isForming = !!forming && at >= formStart && at <= formEnd && !(settled && settled.t >= formEnd);
    const row = isForming ? null : settled ?? (!forming && newest && at >= newest.t ? newest : null);
    const shownRow: FundingRow | null = row ?? (isForming && forming ? { t: formEnd, rate: forming.rate, per8h: forming.per8h, hours: forming.hours } : null);
    // The premium under way is the venue's own now, where it says it (the last candle's is up to a candle old).
    const premiumAt = isForming && forming && forming.premium !== null ? forming.premium : premiumNear(premium, data.premiumMs, at);
    const hourOpens = opens.find(h => h.t <= at && at < h.t + HOUR) ?? null;
    if (hover && this.pointer) this.#lines = fundingCardLines({ time: at, venue: name, row: shownRow, forming: isForming, premium: premiumAt, opens: hourOpens, coin: coin.coin, continuous: continuousFunding(venue) });
    const tone = (x: number): string => x > 0 ? 'bid' : x < 0 ? 'ask' : '';
    const parts: string[] = [];
    if (shownRow) parts.push(`${t('Funding')} <b class="${tone(shownRow.per8h)}">${rateText(shownRow.per8h)}</b> / 8 h · APR ${rateText(shownRow.per8h * PER_YEAR, 2)}`);
    if (premiumAt !== null) parts.push(`${t('Premium')} <b class="${tone(premiumAt)}">${rateText(premiumAt)}</b>`);
    const share = hourOpens ? buyerShare(hourOpens) : null;
    if (share !== null) parts.push(`${t('Buyers opened')} <b class="${share > 0.5 ? 'bid' : share < 0.5 ? 'ask' : ''}">${Math.round(share * 100)}%</b>`);
    if (!hasPremium(venue)) parts.push(`<span class="muted">${t('no premium history')}</span>`);
    setHtml(readout, `${parts.join(' · ')} <span class="muted">${name}</span>`);
  }
}

/** The premium of the candle holding `t` (published per candle of `ms`), else the last before it within one candle; null where none is held. */
function premiumNear(rows: readonly PremiumRow[], ms: number, t: number): number | null {
  const q = rows[cutAt(rows, t) - 1];
  return q && t - q.t < 2 * ms ? q.p : null;
}
