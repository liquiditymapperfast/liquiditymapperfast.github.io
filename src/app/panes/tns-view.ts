import { el } from '../dom.ts';
import { t, tn } from '../i18n.ts';
import { clockSeconds, price as fmtPrice, usd } from '../format.ts';
import { venueMark } from '../venue-marks.ts';
import { venueLabel } from '../venues.ts';
import { instrumentShown } from '../cvd/ids.ts';
import { scaledUsd, unscaledUsd } from '../coin.ts';
import { SIZE_MAX_USD } from '../sizes.ts';
import { selectRow, sizeRow, switchRow, togglePanel, type Panel } from '../ui.ts';
import { replaying } from '../replay/clock.ts';
import { isPhone } from '../device.ts';
import { setHtml } from './lower-panes.ts';
import { HiddenGaps, TnsBook, TNS_FLOOR_USD, TNS_MINIMUMS, TNS_ROWS, type TnsLine, type TnsRow, type TnsSettings } from '../tns/model.ts';
import type { Print } from '../prints.ts';
import type { Store } from '../store.ts';

const esc = (s: string): string => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
/** The size bar's scale: from the list's smallest order to this many times it (log), so the bar says how big against the floor. */
const BAR_DECADES = 2;
/** Below this width the time column goes (the rows keep the exchange, side, price and size). */
const NARROW_PX = 250;

/**
 * Time & sales, the flow column's second view: the large market orders as they arrive, newest on top (the arithmetic is `tns/model.ts`).
 * The orders come from the live stream the page has anyway (the trade bubbles' orders), after those the page's own recording holds for up
 * to the hour before (asked of the recording when the list first shows, never of an exchange); where some may be missing (nothing was
 * recorded, the stream broke, the page was in the background) a line says so. Pointing at the list holds it still (new rows are counted, not
 * shown) and draws the order's moment on the map and the panes; a click takes the map there.
 */
export class TnsView {
  readonly root = el('div', { class: 'tns', hidden: true });
  #bar = el('div', { class: 'tns-bar' });
  #floor = el('select', { class: 'tns-floor', ariaLabel: t('Smallest order') });
  #since = el('span', { class: 'tns-since' });
  #list = el('div', { class: 'tns-list', role: 'list' });
  #pill = el('button', { type: 'button', class: 'tns-pill', hidden: true });
  #empty = el('div', { class: 'tns-empty', hidden: true });
  #book = new TnsBook(Date.now());
  #gaps = new HiddenGaps(Date.now(), document.hidden);
  #shown = false; #frame = 0;
  /** Held still (a mouse pointer is on the list, or it is scrolled down): the rows drawn stay, and the newer ones are counted. */
  #held = false;
  /** A mouse or pen is over the list (a finger has no hover: a tap would leave the list held, so a touch screen holds it by scrolling alone). */
  #pointerIn = false;
  /** The key of the newest row when the list was held, to count the rows above it. */
  #heldTop: string | null = null;
  #lines: TnsLine[] = [];
  #drawn = '';
  #marks = new Map<string, string>();
  #panel: Panel | null = null;
  #narrow = false;
  #resize: ResizeObserver;
  #visibility = (): void => { if (document.hidden) this.#gaps.hide(Date.now()); else this.#gaps.show(Date.now()); };
  /** Take the map to an order (set by the page). */
  onGoTo: (at: number, price: number) => void = () => {};
  /** The orders the recording holds for its unbroken stretch up to now (set by the page: `Hub.recentPrints`, a local read). */
  prefill: ((until: number, minUsd: number) => Promise<{ prints: Print[]; from: number; holes: [number, number][]; minHole: number } | null>) | null = null;
  /** The smallest order the last fill asked for (the coin's dollars): a lower one asks again, as the recording holds smaller orders too. */
  #filledMin = Infinity;
  /** Whether the list was filled from the recording: not yet, being asked, or done (asked again when its smallest order is lowered). */
  #filled: 'no' | 'asking' | 'done' = 'no';
  /** The source has opened its stream (the markets are known): before that a question would name no market and come back empty. */
  #sourceReady = false;

  constructor(private store: Store) {
    this.#bar.append(this.#floor, this.#since);
    this.root.append(this.#bar, this.#empty, this.#list, this.#pill);
    this.#floor.onchange = () => { const v = Number(this.#floor.value); if (Number.isFinite(v) && v > 0) this.#set({ minUsd: unscaledUsd(v) }); };
    this.#pill.onclick = () => { this.#list.scrollTop = 0; this.#pointerIn = false; this.#release(); };
    this.#list.addEventListener('pointerenter', e => { if (e.pointerType === 'touch') return; this.#pointerIn = true; this.#hold(); });
    this.#list.addEventListener('pointerleave', () => { this.#pointerIn = false; this.#hover(null); if (!this.#holds()) this.#release(); });
    this.#list.addEventListener('scroll', () => { if (this.#holds()) this.#hold(); else this.#release(); }, { passive: true });
    this.#list.addEventListener('pointerover', e => { if (e.pointerType !== 'touch') this.#hover(this.#rowAt(e.target)); });
    // On a phone the map is another tab: a tap there would move it unseen and off Live (a long press shows the row's details instead).
    this.#list.addEventListener('click', e => { const row = this.#rowAt(e.target); if (row && !replaying() && !isPhone()) this.onGoTo(row.t, row.price); });
    document.addEventListener('visibilitychange', this.#visibility);
    this.#resize = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0, narrow = w > 0 && w < NARROW_PX;
      if (narrow !== this.#narrow) { this.#narrow = narrow; this.root.classList.toggle('narrow', narrow); }
    });
    this.#resize.observe(this.root);
    this.#syncFloor();
  }

  dispose(): void { this.#resize.disconnect(); document.removeEventListener('visibilitychange', this.#visibility); if (this.#frame) cancelAnimationFrame(this.#frame); }

  /** Orders that arrived on the live stream (every one, including those the page's own book already held from a history answer). */
  take(prints: readonly Print[]): void {
    if (!prints.length) return;
    const missed = this.#gaps.arrived(Date.now());
    if (missed > 0) this.#book.gap('hidden', Date.now(), missed);
    if (this.#book.add(prints)) this.invalidate();
  }
  /** The stream opened: the list can be filled now if it shows (a page that opens on the list showed it before the markets were known). */
  sourceReady(): void {
    if (this.#sourceReady) return;
    // The live orders begin now; the recording's orders are asked for up to here (the seconds before the stream opened are the recording's).
    this.#sourceReady = true; this.#book.open(Date.now()); this.invalidate();
    if (this.#shown && this.#filled === 'no') this.#fill();
  }
  /**
   * Fill the list from the recording, at its own smallest order (a busy hour from $25K is more than one answer holds, from $100K it is not).
   * In the browser the answer waits until the recordings are read back (`browser/waits.ts`), so one is enough. A failed answer leaves the
   * live list as it is.
   */
  #fill(): void {
    if (!this.prefill || !this.#sourceReady || this.#filled === 'asking') return;
    this.#filled = 'asking';
    const min = scaledUsd(this.store.state.tns.minUsd);
    this.prefill(this.#book.seam, min).then(got => {
      if (!got) return;
      this.#filledMin = min; this.#book.prefill(got.prints, got.from, got.holes, got.minHole); this.#drawn = ''; this.invalidate();
    }, () => undefined).finally(() => {
      this.#filled = 'done';
      // The smallest order was lowered while this was being asked: ask again at it (compared with what was asked, not `#filledMin`,
      // which a null answer leaves at its start and would make every answer ask again).
      if (this.#shown && scaledUsd(this.store.state.tns.minUsd) < min) { this.#filled = 'no'; this.#fill(); }
    });
  }
  /** The stream dropped: orders may be missing until it is back. (Another coin reloads the page, so the list never has to start again.) */
  streamBroke(): void { this.#book.gap('reconnect', Date.now()); this.invalidate(); }

  setShown(shown: boolean): void {
    if (shown === this.#shown) return;
    this.#shown = shown; this.root.hidden = !shown;
    // Filled from the recording the first time it shows: a page that never opens the list never reads it.
    if (shown && this.#filled === 'no') this.#fill();
    // Hidden, the list loses its scroll and the pointer with no event to say so: it is not held when it comes back.
    if (!shown) { this.#hover(null); this.#panel?.close(); this.#pointerIn = false; this.#list.scrollTop = 0; this.#release(false); }
    this.invalidate();
  }
  /** The list's own settings changed: the rows are made again, from the top (rows held under the old filter would mislead). */
  refresh(): void {
    this.#syncFloor(); this.#list.scrollTop = 0; this.#release(false); this.#drawn = ''; this.invalidate();
    // A smaller order than the recording was asked for: it holds those too, so the list is filled again at the new smallest order.
    if (this.#filled === 'done' && scaledUsd(this.store.state.tns.minUsd) < this.#filledMin) { this.#filled = 'no'; if (this.#shown) this.#fill(); }
  }
  /** Something the rows are written with changed (the venues, the whale size, the time zone, a replay): drawn again, a hold kept (it draws on release). */
  redraw(): void { this.#syncFloor(); this.#drawn = ''; this.invalidate(); }
  invalidate(): void { if (!this.#frame && this.#shown) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#render(); }); }

  /** What the last frame drew, for the checks that look at the list without reading the page. */
  get snapshot(): { rows: number; gaps: number; held: boolean; waiting: number; since: number; orders: number } {
    return { rows: this.#lines.filter(l => l.k === 'row').length, gaps: this.#lines.filter(l => l.k === 'gap').length, held: this.#held, waiting: this.#waiting(), since: this.#book.since, orders: this.#book.orders };
  }

  /** The settings panel (the column's settings key opens it in this view). */
  openSettings(anchor: HTMLElement): void {
    this.#panel = togglePanel(anchor, { title: t('Time & sales'), width: 360, align: 'left', onClose: () => { this.#panel = null; } }, (_tools, body) => this.#build(body));
  }
  #build(body: HTMLElement): void {
    const s = this.store.state.tns;
    body.append(
      sizeRow(t('Smallest order'), t('Orders under this are not listed. The page keeps its last 5,000 orders from {floor}, so a lower choice brings back the ones it holds.', { floor: `$${usd(scaledUsd(TNS_FLOOR_USD))}` }),
        { sign: '≥', value: scaledUsd(s.minUsd), presets: TNS_MINIMUMS.map(scaledUsd), min: scaledUsd(TNS_FLOOR_USD), max: scaledUsd(SIZE_MAX_USD) }, v => this.#set({ minUsd: unscaledUsd(v) })),
      selectRow(t('Side'), t('Both sides, or only the market buys or only the market sells.'), [['both', t('Both')], ['buy', t('Buys only')], ['sell', t('Sells only')]], s.side, v => this.#set({ side: v === 'buy' || v === 'sell' ? v : 'both' })),
      switchRow(t('One row for a burst'), t('Orders on one exchange and side within half a second of each other (for at most three seconds) are one row, its size added up and its price their average weighted by size; ×16 says how many.'), s.merge, merge => this.#set({ merge })),
    );
  }
  #set(change: Partial<TnsSettings>): void { this.store.set({ tns: { ...this.store.state.tns, ...change } }); }

  /** The floor's menu: the common sizes for this coin, and the one chosen when it is none of them. */
  #syncFloor(): void {
    const chosen = scaledUsd(this.store.state.tns.minUsd), sizes = TNS_MINIMUMS.map(scaledUsd);
    if (!sizes.some(v => Math.abs(v - chosen) <= 1e-6 * chosen)) sizes.push(chosen);
    sizes.sort((a, b) => a - b);
    const key = sizes.join(',');
    if (this.#floor.dataset.sizes !== key) {
      this.#floor.dataset.sizes = key;
      this.#floor.replaceChildren(...sizes.map(v => new Option(`≥ $${usd(v)}`, String(v))));
    }
    const match = sizes.find(v => Math.abs(v - chosen) <= 1e-6 * chosen) ?? chosen;
    this.#floor.value = String(match);
  }

  /** What holds the list: a mouse on it, or rows scrolled down. */
  #holds(): boolean { return this.#pointerIn || this.#list.scrollTop > 0; }
  #hold(): void {
    // An empty list has nothing to keep still: the first rows come in under the pointer.
    // Nor rows about to be made again (a refresh before its frame): those on screen are the old filter's.
    if (this.#held || !this.#drawn || !this.#lines.some(l => l.k === 'row')) return;
    this.#held = true; this.#heldTop = this.#lines.find(l => l.k === 'row')?.key ?? null;
  }
  #release(draw = true): void {
    if (!this.#held) return;
    this.#held = false; this.#heldTop = null; this.#pill.hidden = true;
    if (draw) { this.#drawn = ''; this.invalidate(); }
  }
  /** The rows newer than the newest one drawn when the list was held. */
  #waiting(): number {
    if (!this.#held) return 0;
    const lines = this.#rows();
    if (this.#heldTop === null) return lines.filter(l => l.k === 'row').length;
    const at = lines.findIndex(l => l.key === this.#heldTop);
    return (at < 0 ? lines : lines.slice(0, at)).filter(l => l.k === 'row').length;
  }

  #rows(): TnsLine[] {
    const state = this.store.state, s = state.tns;
    return this.#book.rows({ minUsd: scaledUsd(s.minUsd), side: s.side, merge: s.merge, shown: instrumentShown(state) });
  }

  #render(): void {
    if (!this.#shown) return;
    // Since: the oldest order held, or, when the list stops at its row limit before it, the oldest row drawn.
    const all = this.#rows(), cut = all.length >= TNS_ROWS, oldest = cut ? [...all].reverse().find((l): l is TnsRow => l.k === 'row') : undefined;
    const time = clockSeconds(oldest ? oldest.t : this.#book.since);
    this.#since.textContent = replaying() ? t('Not the replay: live orders since {time}', { time }) : t('Since {time}', { time });
    // A hold whose cause went without an event (a scroll reset, a pointer that never left) ends here.
    if (this.#held && !this.#holds()) this.#release(false);
    if (this.#held) {
      const n = this.#waiting();
      this.#pill.hidden = n === 0;
      if (n) this.#pill.textContent = t('Paused · {n} new ↑', { n: String(n) });
      return;
    }
    const lines = this.#lines = all;
    const rows = lines.filter((l): l is TnsRow => l.k === 'row');
    this.#empty.hidden = rows.length > 0;
    const state = this.store.state, floor = scaledUsd(state.tns.minUsd);
    if (!rows.length) this.#empty.textContent = t('Waiting for an order of {size} or more. Orders appear here as they trade, after those this page already recorded.', { size: `$${usd(floor)}` });
    const whale = scaledUsd(state.sounds.tiers.find(tier => tier.id === 'whale')?.usd ?? 400_000);
    const replay = replaying();
    this.root.classList.toggle('replaying', replay);
    const html = lines.map((l, i) => l.k === 'gap' ? this.#gapHtml(l) : this.#rowHtml(l, i, floor, whale, replay)).join('');
    if (html !== this.#drawn) { this.#drawn = html; setHtml(this.#list, html); }
    // A pointer already resting on the list when its first rows came (or when they were made again) holds them from now.
    if (this.#holds()) this.#hold();
  }

  #gapHtml(g: Extract<TnsLine, { k: 'gap' }>): string {
    const time = clockSeconds(g.at), long = g.ms < 60_000 ? t('{n} s', { n: Math.max(1, Math.round(g.ms / 1000)) }) : tn(Math.round(g.ms / 60_000), '{n} min', '{n} min');
    const words = g.why === 'reconnect' ? t('The stream dropped at {time}: orders may be missing here.', { time })
      : g.why === 'unrecorded' ? t('Nothing was recorded from {from} to {to}: orders may be missing here.', { from: clockSeconds(g.at - g.ms), to: time })
      : t('The page was in the background for {long} until {time}: orders may be missing here.', { long, time });
    return `<div class="tns-gap" role="listitem">${esc(words)}</div>`;
  }

  #rowHtml(r: TnsRow, i: number, floor: number, whale: number, replay: boolean): string {
    const buy = r.side === 'buy', venue = venueLabel(r.id), market = r.id.slice(r.id.indexOf(':') + 1);
    const w = Math.max(4, Math.min(100, 100 * Math.log10(Math.max(1, r.usd / floor)) / BAR_DECADES));
    const span = r.orders > 1 ? t('{n} orders in {s} s, between {lo} and {hi}', { n: String(r.orders), s: ((r.last - r.t) / 1000).toFixed(1), lo: fmtPrice(r.lo), hi: fmtPrice(r.hi) }) : '';
    // A replay shows another moment, so a click there does nothing and the tip does not offer it.
    const tip = [`${buy ? t('BUY') : t('SELL')} $${usd(r.usd)} · ${venue} ${market}`, span, replay || isPhone() ? '' : t('Click to show it on the map')].filter(Boolean).join('\n');
    const mark = this.#marks.get(r.id) ?? (() => { const html = venueMark(r.id, 14).outerHTML; this.#marks.set(r.id, html); return html; })();
    // The size's bar runs in from the row's right edge behind the price and the size, so it has the room to tell sizes apart.
    return `<div class="tns-row ${buy ? 'buy' : 'sell'}${r.usd >= whale ? ' whale' : ''}" role="listitem" data-i="${i}" data-tip="${esc(tip)}" style="--w:${(w / 100).toFixed(3)}"><i class="tns-size"></i>`
      + `<span class="tns-t">${clockSeconds(r.t)}</span>${mark}<span class="tns-sd" aria-label="${esc(buy ? t('Buy') : t('Sell'))}">${buy ? '▲' : '▼'}</span>`
      + `<span class="tns-p">${fmtPrice(r.price)}</span>`
      + `<span class="tns-u">${r.orders > 1 ? `<em>×${r.orders}</em>` : ''}<b>$${usd(r.usd)}</b></span></div>`;
  }

  #rowAt(target: EventTarget | null): TnsRow | null {
    const node = target instanceof Element ? target.closest<HTMLElement>('.tns-row') : null, i = node ? Number(node.dataset.i) : NaN;
    const line = Number.isInteger(i) ? this.#lines[i] : undefined;
    return line?.k === 'row' ? line : null;
  }
  /** The order pointed at: its moment drawn on the map and the panes (the shared pointer), or none. */
  #hover(row: TnsRow | null): void {
    const hover = this.store.state.hover;
    // A replay shows another moment: a live order's time would point past its clock.
    if (!row || replaying()) { if (hover?.source === 'tns') this.store.set({ hover: null }); return; }
    if (hover?.source === 'tns' && hover.t === row.t) return;
    this.store.set({ hover: { t: row.t, price: row.price, y: 0, source: 'tns' } });
  }
}
