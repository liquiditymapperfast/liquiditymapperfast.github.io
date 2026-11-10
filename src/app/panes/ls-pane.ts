import { TIMEFRAMES, type Hub } from '../hub.ts';
import { oiMarketIds } from '../market-choice.ts';
import type { Store, AppState } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton } from '../help.ts';
import { setTip } from '../tip.ts';
import { t } from '../i18n.ts';
import { clock } from '../format.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { venueLabel } from '../venues.ts';
import { drawVenueMark } from '../venue-marks.ts';
import { AXIS_W, leftGutter } from './heat-pane.ts';
import { TimePane, setHtml } from './lower-panes.ts';
import { PaneTable, tableInk, type TableCell, type TableRoom } from './pane-table.ts';
import type { Palette } from '../theme.ts';
import { addTune } from '../pane-tune.ts';
import { LS_BUDGET_MS, LS_ROUND_MS, LS_SOON_MS, lsFollowDelay, lsLanded, lsMessage, lsReach, lsWindow, type LsHeld } from './ls-window.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { IdbLsShown } from '../browser/ls-store.ts';
import { LS_CHOSEN_VENUES, LS_METRICS, LS_VENUES, lsPopulationOf, lsWindowPeriod, type LsMetric, type LsPoint, type LsPopulation, type LsSeries } from '../../shared/long-short.ts';

const HOUR = 3_600_000;
/** One colour per venue, apart from each other on either theme (the brands' own are black on two of them); the venue's mark ends its line. */
const LINE_COLORS: Readonly<Record<string, string>> = { binance: '#d4a106', bybit: '#e8590c', okx: '#7a5af8', bitget: '#0ca5b8' };
/** A reading stands until the next one, or for this many of its periods after it when none follows (a gap past that breaks the line). */
const HOLD_PERIODS = 3;

/** The markets the pane shows: the OI pane's markets (those it adds together, or its one market) on a venue that publishes a ratio. */
export function lsIds(state: AppState, hub: Hub): string[] {
  const oi = oiMarketIds(state, hub.flow);
  // Gate publishes its long/short ratios but no open interest the page reads: with every market counted (and its chip on) its perpetual
  // joins the lines, where the page's markets have one (a coin Gate does not list has none, and is never asked). Under Spot too, as the
  // other exchanges' perpetuals do (`oiVenueIds`).
  const listed = state.markets.find(m => m.venue === 'gateio' && m.marketType === 'perpetual' && m.instrumentId)?.instrumentId;
  const gate = listed && oi && state.oiMarkets === 'all' && !state.disabledVenues.includes('gateio') ? [listed] : [];
  const ids = [...(oi ?? [state.oiInstrument || state.seriesInstrument || state.marketId]), ...gate];
  const venue = (id: string): number => LS_VENUES.indexOf(id.split(':')[0]!);
  return [...new Set(ids)].filter(id => venue(id) >= 0).sort((a, b) => venue(a) - venue(b));
}

/** The words for who a series counts. */
export function populationText(population: LsPopulation): string {
  return population === 'accounts' ? t('all accounts') : population === 'topAccounts' ? t('top traders, by accounts') : population === 'topPositions' ? t('top traders, by positions') : t('active accounts');
}

/** Where the step of a series' reading `i` ends: at the next reading where it comes within the hold, else a period after it. */
export function stepEnd(s: Pick<LsSeries, 'points' | 'periodMs'>, i: number): number {
  const q = s.points[i]!, next = s.points[i + 1];
  return next && next.t - q.t <= HOLD_PERIODS * s.periodMs ? next.t : q.t + s.periodMs;
}

/** The lowest and highest share over the steps drawn in [t0, t1] (a reading counts while it holds, as the lines are drawn); null when no step is in view. */
export function lsRange(series: readonly Pick<LsSeries, 'points' | 'periodMs'>[], t0: number, t1: number): { lo: number; hi: number } | null {
  let lo = Infinity, hi = -Infinity;
  for (const s of series) s.points.forEach((q, i) => { if (stepEnd(s, i) >= t0 && q.t <= t1) { lo = Math.min(lo, q.long); hi = Math.max(hi, q.long); } });
  return lo <= hi ? { lo, hi } : null;
}

/** The reading of `points` (oldest first) in effect at `time`: the last one at or before it, while its hold lasts. */
export function lsAt(points: readonly LsPoint[], time: number, periodMs: number): LsPoint | null {
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid]!.t <= time) lo = mid + 1; else hi = mid; }
  const p = points[lo - 1];
  return p && time < p.t + HOLD_PERIODS * periodMs ? p : null;
}

/** "55.6 % long · 44.4 % short · L/S 1.25" for a long share. */
export function shareText(long: number): string {
  return t('{long} long · {short} short · L/S {ratio}', { long: `${(long * 100).toFixed(1)}%`, short: `${((1 - long) * 100).toFixed(1)}%`, ratio: (long / (1 - long)).toFixed(2) });
}

/** The popup of one moment: each venue's reading then (or why it has none), and what the numbers count. */
export function lsCardLines(series: readonly LsSeries[], time: number, tf: string): InfoLine[] {
  const lines: InfoLine[] = [{ text: `${clock(time, true)} · ${tf}`, bold: true }];
  let noBitget = false;
  for (const s of series) {
    const label = venueLabel(s.id);
    if (s.status === 'serverOnly') { lines.push({ label, text: t('not readable by a web page'), color: 'muted', mark: s.id }); continue; }
    const p = s.status === 'failed' ? null : lsAt(s.points, time, s.periodMs);
    // A venue still being read (`pending`) has no reading here yet: said so, not "no reading" or "could not be read".
    if (!p && s.pending) { lines.push({ label, text: t('being read'), color: 'muted', mark: s.id }); continue; }
    if (s.status === 'failed') { lines.push({ label, text: t('could not be read'), color: 'muted', mark: s.id }); continue; }
    if (!p && s.id.startsWith('bitget:')) noBitget = true;
    lines.push(p ? { label, text: shareText(p.long), color: p.long > 0.5 ? 'buy' : p.long < 0.5 ? 'sell' : 'text', mark: s.id } : { label, text: t('no reading'), color: 'muted', mark: s.id });
    if (s.status === 'stale') lines.push({ text: t('{venue}: the last update could not be read; these are its earlier readings.', { venue: venueLabel(s.id) }), color: 'muted', wrap: true });
  }
  // Bitget's own limit, said where it has no reading: what it published is not held apart from what the window kept, so it is not placed.
  if (noBitget) lines.push({ text: t('Bitget publishes only its newest 30 readings; an older time has none.'), color: 'muted', wrap: true });
  // Who each line counts, the venues of one population together: "Binance: top traders, by positions · Bybit, OKX: all accounts".
  const groups = new Map<LsPopulation, string[]>();
  for (const s of series) if (s.population) groups.set(s.population, [...(groups.get(s.population) ?? []), venueLabel(s.id)]);
  if (groups.size) lines.push({ text: [...groups].map(([population, venues]) => `${venues.join(', ')}: ${populationText(population)}`).join(' · '), color: 'muted', wrap: true, rule: true });
  // What a ratio means follows who is counted: accounts, or (Binance's top traders by positions) the size they hold.
  if (series.some(s => s.population && s.population !== 'topPositions')) lines.push({ text: t('Accounts as each exchange counts them, not coins: L/S 1.25 is 1.25 long accounts for each short one, not 25 % more BTC long. In coins the two sides are always equal.'), color: 'muted', wrap: true });
  if (series.some(s => s.population === 'topPositions')) lines.push({ text: t('By positions: the share of the top traders\' position size that is long, not of accounts. L/S 1.25 is 1.25 times as much held long as short among them; across the whole market the two sides are always equal.'), color: 'muted', wrap: true });
  return lines;
}

/** The Long/Short pane's table: a venue a row, the long share at `time`, the short share and their ratio; a venue with no reading then has dashes, and one whose last update failed its earlier readings muted, as the readout has them. */
export function lsTableRows(series: readonly LsSeries[], time: number, p: Pick<Palette, 'bid' | 'ask' | 'text' | 'muted'>): TableCell[][] {
  return series.map(s => {
    const q = s.status === 'failed' ? null : lsAt(s.points, time, s.periodMs), name = { text: venueLabel(s.id) }, stale = s.status === 'stale';
    return q ? [name, { text: `${(q.long * 100).toFixed(1)}%`, color: stale ? p.muted : tableInk(p.bid, p) }, { text: `${((1 - q.long) * 100).toFixed(1)}%`, color: stale ? p.muted : tableInk(p.ask, p) }, { text: (q.long / (1 - q.long)).toFixed(2), color: stale ? p.muted : undefined }] : [name, { text: '–' }, { text: '–' }, { text: '–' }];
  });
}

/**
 * The Long/Short pane: the share of each venue's accounts that is net long, as the venue publishes it (shared/long-short.ts), one line per
 * venue around a 50 % line. The venues are the OI pane's markets that publish one; Binance's series is chosen in the header. A pane off by
 * default: nothing new is asked while it is hidden (a read already under way finishes, and so does a long window's reading back through
 * Binance's archive), and its readings are asked for again at most once a minute.
 */
export class LsPane extends TimePane {
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  #series: LsSeries[] = [];
  /** What the series held are of (markets, series, timeframe), the window last asked for and when it was answered; and a round under way. */
  #held: LsHeld | null = null;
  #loading = false; #generation = 0;
  /** Which series and timeframe `#series` are of (each market's lines are kept while those stay, whatever other markets come and go). */
  #seriesOf = '';
  /** Cancels the requests of the round under way that have not answered. */
  #round: AbortController | null = null;
  /** The window the other series (of the venues that follow the one chosen) were last read for in the background, and whether that read is under way. */
  #warmed = ''; #warming: AbortController | null = null;
  /** The round's timers asking a `pending` venue again, and the one drawing the pane when a round that ended with one pending is due again. */
  #followups = new Set<number>(); #soon = 0; #deadline = 0;
  /** What the pane drew from a server's answers, kept in this page (app/browser/ls-store.ts `IdbLsShown`); undefined until first asked. */
  #shown: IdbLsShown | null | undefined;
  #sync: (() => void)[] = [];
  readonly #tableBox = document.createElement('input');
  /** Each venue's exact figures at one moment, on the pane (pane-table.ts). */
  readonly #table = new PaneTable({ canvas: this.canvas, left: () => leftGutter(this.store.state), rangeGesture: () => this.rangeGesture, invalidate: () => this.invalidate() });

  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub) {
    super(host, store, view, 'ls');
    this.head.innerHTML = `<strong>${t('Long/Short')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('lsPane'));
    setTip(this.head.querySelector('strong')!, t('The share of each exchange\'s accounts that is net long, as the exchange publishes it.'));
    const group = document.createElement('span'); group.className = 'ctl ctl-group'; this.head.append(group);
    const wrap = document.createElement('label'); wrap.className = 'ctl'; wrap.append(t('Series'));
    setTip(wrap, t('Which series Binance, OKX, Bitget and Gate show: every account, their top traders counted by account, or their top traders counted by the size of their positions. Bybit publishes one.'));
    const control = document.createElement('select');
    for (const [value, text] of [['accounts', t('All accounts')], ['topAccounts', t('Top traders, accounts')], ['topPositions', t('Top traders, positions')]] as const) control.append(new Option(text, value));
    control.value = store.state.lsMetric;
    control.onchange = () => this.store.set({ lsMetric: control.value as LsMetric });
    const table = document.createElement('label'); table.className = 'ctl'; setTip(table, t('Each venue\'s longs, shorts and their ratio in a table on the pane, at the pointer\'s time or the newest.'));
    this.#tableBox.type = 'checkbox'; this.#tableBox.checked = store.state.lsTable; this.#tableBox.onchange = () => store.set({ lsTable: this.#tableBox.checked });
    table.append(this.#tableBox, t('Table'));
    wrap.append(control); group.append(wrap, table);
    addTune(this.head, [table], t('Long/Short'));
    this.#sync.push(() => { if (control.value !== this.store.state.lsMetric) control.value = this.store.state.lsMetric; });
  }

  /** Reflect the table's switch and draw again (nothing is read for it). */
  tableChanged(): void { this.#tableBox.checked = this.store.state.lsTable; this.invalidate(); }

  /** Reflect the settings in the header and read again (a round under way is for what was shown: dropped). */
  settingsChanged(): void { for (const sync of this.#sync) sync(); this.#generation++; this.#round?.abort(); this.#round = null; this.#warming?.abort(); this.#stopFollowing(); this.#held = null; this.#loading = false; this.invalidate(); }

  #stopFollowing(): void { for (const timer of this.#followups) window.clearTimeout(timer); this.#followups.clear(); window.clearTimeout(this.#soon); this.#soon = 0; window.clearTimeout(this.#deadline); this.#deadline = 0; }

  /**
   * The page's copy of what the pane drew, with a server only: the browser engine keeps its own series (its cache's backing), and a session
   * that keeps nothing (`?persist=0`) keeps none of these either.
   */
  #shownStore(): IdbLsShown | null {
    if (this.#shown === undefined) {
      let keep = true;
      try { keep = new URLSearchParams(window.location.search).get('persist') !== '0'; } catch { /* no address to read: keep */ }
      this.#shown = this.hub.source.kind === 'server' && keep ? new IdbLsShown() : null;
    }
    return this.#shown;
  }

  /**
   * Ask for the readings when `lsWindow` says so (ls-window.ts). What is held stays drawn while the next answer comes (the readings of a wider
   * or narrower window are the same readings); only another series or another timeframe clear it, and a market no longer shown is not drawn.
   * One round at a time: a view that moved meanwhile is looked at again when it lands. Each venue is drawn as it answers (`lsLanded`), and the
   * round ends when all have or after `LS_ROUND_MS`: a venue that never answers costs its own line, never the others'. A question is answered
   * within `LS_BUDGET_MS` with what the source holds; a venue it is still reading (`pending`) is asked again every `LS_FOLLOW_MS` until it has
   * read it, and a round that ends with one still pending is asked again `LS_SOON_MS` later.
   */
  #load(state: AppState, ids: readonly string[], tfMs: number): void {
    const now = Date.now(), of = `${state.lsMetric}|${state.timeframe}`, ident = `${ids.join(',')}|${of}`;
    const ask = lsWindow(this.#held, this.#loading, ident, this.view, tfMs, now, ids.map(id => id.slice(0, id.indexOf(':'))));
    if (!ask) return;
    const { from, to } = ask, generation = ++this.#generation, source = this.hub.source;
    // Another round (other markets, series or timeframe) cancels what the last one still waits for, its background warming included.
    this.#round?.abort(); this.#warming?.abort(); this.#stopFollowing();
    const round = this.#round = new AbortController(), answers = new Map<string, LsSeries>(), settled = new Set<string>();
    // Another series: Bybit publishes one population, so its line stays drawn while the others are read (every line used to blank, the pane
    // looking slow to switch); another timeframe is other readings for all of them.
    if (this.#seriesOf !== of) {
      const sameTimeframe = this.#seriesOf.endsWith(`|${state.timeframe}`);
      this.#series = sameTimeframe ? this.#series.filter(s => s.population === lsPopulationOf(s.id.slice(0, s.id.indexOf(':')), state.lsMetric)) : [];
      this.#seriesOf = of;
    }
    this.#held = { ident, from, to, at: now }; this.#loading = true;
    let over = false;
    const land = (final: boolean): void => {
      if (over || generation !== this.#generation) return;
      this.#series = lsLanded(ids, this.#series, answers, final);
      if (final) {
        over = true; window.clearTimeout(deadline); round.abort(); this.#stopFollowing();
        if (this.#round === round) this.#round = null;
        this.#loading = false;
        const at = Date.now(), pending = ids.some(id => answers.get(id)?.pending);
        if (this.#held) { this.#held.at = at; if (pending) this.#held.soon = at + LS_SOON_MS; }
        // A venue still being read is asked again shortly, the pane drawn then (a chart standing still draws nothing on its own); the other
        // series are warmed once none is, so their reads do not queue before it at the venue.
        if (pending) this.#soon = window.setTimeout(() => { this.#soon = 0; this.invalidate(); }, LS_SOON_MS + 50);
        else this.#warm(ids, state, from, to);
      }
      this.invalidate();
    };
    const deadline = this.#deadline = window.setTimeout(() => land(true), LS_ROUND_MS);
    const shown = this.#shownStore();
    // The line drawn for a venue of this population (an answer, or what was kept), if any.
    const line = (id: string, population: LsPopulation): LsSeries | undefined => this.#series.find(s => s.id === id && s.points.length > 0 && s.population === population);
    const read = (id: string, attempt: number): void => {
      void source.longShort(id, state.lsMetric, state.timeframe, from, to, round.signal, LS_BUDGET_MS)
        .catch((): LsSeries => ({ id, population: null, periodMs: 0, points: [], status: 'failed' }))
        .then(series => {
          if (over || generation !== this.#generation) return;
          answers.set(id, series);
          // Every venue has answered once: a view that moves meanwhile asks its own window at once (that round cancels these follow-ups)
          // rather than wait for a slow venue's last follow-up. Only a moved view can: the minute's refresh counts from the round's start
          // (`held.at`), and the round (`LS_ROUND_MS`, 45 s) ends before it.
          if (answers.size === ids.length) this.#loading = false;
          // A venue's readings as the server answered them, kept for the next time the pane is shown (a final answer: a pending one comes again).
          if (shown && !series.pending && series.points.length && series.population && series.periodMs) shown.add(`${id}|${series.population}|${series.periodMs}`, series.points);
          // Still being read: drawn as it is, asked again a little later each time (each answer is the source's, not a new read); settled
          // once it is not. A pane that is off or a page that is away asks nothing: the round is dropped as it stands (no venue is called
          // failed for it: a slow one is only slow), and the pane drawn again asks a whole round anew.
          if (series.pending) {
            const timer = window.setTimeout(() => {
              this.#followups.delete(timer);
              if (over || generation !== this.#generation) return;
              if (this.root.hidden || document.hidden) drop(); else read(id, attempt + 1);
            }, lsFollowDelay(attempt));
            this.#followups.add(timer);
          } else settled.add(id);
          land(settled.size === ids.length);
        });
    };
    /** The round given up as it stands, its lines kept: nothing more is asked, and the next draw asks a whole round. */
    const drop = (): void => {
      over = true; window.clearTimeout(deadline); round.abort(); this.#stopFollowing();
      if (this.#round === round) this.#round = null;
      this.#loading = false; this.#held = null;
    };
    for (const id of ids) read(id, 0);
    // What was drawn the last time, drawn at once: the server's answers can wait twenty seconds and more behind the page's other requests to
    // it while the page loads. Marked pending (its venue is being read); the answer replaces it, a round that ends without one leaves it stale.
    // Never over a final answer of this round (read, empty or failed: what it says stands), nor over a line that reaches as far (another
    // period's, drawn before this window).
    if (shown) for (const id of ids) {
      const venue = id.slice(0, id.indexOf(':')), population = lsPopulationOf(venue, state.lsMetric), periodMs = lsWindowPeriod(venue, tfMs, from, to);
      if (!population || !periodMs || line(id, population)?.periodMs === periodMs) continue;
      void shown.get(`${id}|${population}|${periodMs}`).then(points => {
        const answer = answers.get(id);
        if (over || generation !== this.#generation || !points || (answer && !answer.pending)) return;
        const inWindow = points.filter(p => p.t >= from - periodMs && p.t < to);
        if (!inWindow.length) return;
        const kept: LsSeries = { id, population, periodMs, points: inWindow, status: 'ok', pending: true }, current = line(id, population);
        if (current && (current.periodMs === periodMs || lsReach(current) >= lsReach(kept))) return;
        this.#series = this.#series.some(s => s.id === id) ? this.#series.map(s => s.id === id ? kept : s) : [...this.#series, kept];
        this.invalidate();
      });
    }
  }

  /**
   * Read the other series for the window just answered, quietly, once a window: the source keeps them (its long/short cache), so switching to
   * one draws at once instead of waiting for the venues' pages. Only Binance's, OKX's and Gate's change with the series; one read at a time,
   * nothing drawn.
   */
  #warm(ids: readonly string[], state: AppState, from: number, to: number): void {
    // Not for a pane that is off or a page that is away.
    if (this.root.hidden || !state.show.ls || document.hidden) return;
    // Keyed by the period each venue's cache takes for this window (shared/long-short.ts `lsWindowPeriod`): a window that crosses into another
    // is another series of the cache, warmed again; one whose end only moved on by minutes is the same.
    const tfMs = TIMEFRAMES[state.timeframe] ?? HOUR, chosen = ids.filter(id => LS_CHOSEN_VENUES.includes(id.slice(0, id.indexOf(':'))));
    const key = `${chosen.map(id => `${id}@${lsWindowPeriod(id.slice(0, id.indexOf(':')), tfMs, from, to)}`).join(',')}|${state.timeframe}|${Math.floor(from / HOUR)}`;
    if (!chosen.length || this.#warming || this.#warmed === key) return;
    // Its own lifetime: cancelled with the pane's settings, and given up with the round's deadline, so it never holds a connection for good.
    const warming = this.#warming = new AbortController(), timer = window.setTimeout(() => warming.abort(), LS_ROUND_MS);
    const source = this.hub.source, others = LS_METRICS.filter(m => m !== state.lsMetric);
    // Asked with no wait (budget 0): the source starts each read and answers at once, so no request holds one of the browser's connections to
    // the server; the reads go on in the source's cache, which is what a switch to the series draws from. Warmed once every series came back
    // read: one cancelled (a new round, the pane's settings, the deadline), failed or still being read (`pending`) is warmed again with the next
    // round, by then from the source's cache (which keeps a failing venue to one question a minute). A source from before the budget waits for
    // the reads, as it always did.
    void Promise.allSettled(chosen.flatMap(id => others.map(metric => source.longShort(id, metric, state.timeframe, from, to, warming.signal, 0))))
      .then(results => { if (!warming.signal.aborted && results.every(r => r.status === 'fulfilled' && r.value.status !== 'failed' && !r.value.pending)) this.#warmed = key; })
      .finally(() => { window.clearTimeout(timer); if (this.#warming === warming) this.#warming = null; });
    // An abort settles the requests at once (their promises reject): the gate opens with it.
    warming.signal.addEventListener('abort', () => { if (this.#warming === warming) this.#warming = null; }, { once: true });
  }

  protected draw(): void {
    this.#lines = null;
    this.#table.clear();
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }
  protected override undrawn(): void { this.#lines = null; this.#table.clear(); this.#card.hide(); }
  protected override ownsPoint(x: number): boolean { return this.#table.owns(x, this.pointer); }

  #paint(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state = this.store.state, now = pageNow();
    const tf = TIMEFRAMES[state.timeframe] ?? HOUR, readout = this.head.querySelector('.readout');
    const ids = lsIds(state, this.hub);
    if (!ids.length) {
      ctx.fillStyle = p.muted; ctx.textAlign = 'left';
      ctx.fillText(t('None of the open-interest markets is on an exchange that publishes a long/short ratio (Binance, Bybit, OKX, Bitget, Gate).'), 12, ph / 2);
      setHtml(readout, ''); return;
    }
    this.#load(state, ids, tf);
    // Replay: only what had been published by the moment shown.
    const series = this.#series.filter(s => ids.includes(s.id)).map(s => replaying() ? { ...s, points: s.points.filter(q => q.t + s.periodMs <= now) } : s);
    const shown = series.filter(s => s.points.length);
    // No step in view (readings held for another time draw nothing here): the pane says why.
    const range = lsRange(shown, v.t0, v.t1), blank = !range;
    const lo = range?.lo ?? 0.45, hi = range?.hi ?? 0.55;
    const pad = Math.max((hi - lo) * 0.1, 0.005), min = lo - pad, max = hi + pad, top = 8, bottom = ph - 8;
    const y = (share: number): number => top + (1 - (share - min) / (max - min)) * (bottom - top);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    // Half long, half short, where it is inside the scale (the scale fits the lines: they move by tenths of a percent).
    if (min < 0.5 && max > 0.5) {
      ctx.strokeStyle = p.muted; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, Math.round(y(0.5)) + 0.5); ctx.lineTo(pw, Math.round(y(0.5)) + 0.5); ctx.stroke(); ctx.setLineDash([]);
    }
    const ends: { id: string; x: number; y: number }[] = [];
    for (const s of shown) {
      // Steps: a reading holds until the next, and a gap longer than its hold breaks the line.
      ctx.strokeStyle = LINE_COLORS[s.id.split(':')[0]!] ?? p.text; ctx.lineWidth = 1.5; ctx.beginPath();
      let last: { x: number; y: number } | null = null, prevEnd = -Infinity;
      for (let i = 0; i < s.points.length; i++) {
        const q = s.points[i]!, end = stepEnd(s, i);
        if (end < v.t0 || q.t > v.t1) { prevEnd = end; continue; }
        const x0 = v.xOf(q.t, pw), x1 = v.xOf(end, pw), yq = y(q.long);
        if (last && prevEnd === q.t) ctx.lineTo(x0, yq); else ctx.moveTo(x0, yq);
        ctx.lineTo(x1, yq); last = { x: x1, y: yq }; prevEnd = end;
      }
      ctx.stroke(); ctx.lineWidth = 1;
      if (last) ends.push({ id: s.id, ...last });
    }
    // Each line's venue mark where it ends, kept apart from the others.
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 14 && Math.abs(ends[i]!.x - ends[i - 1]!.x) < 14) ends[i]!.y = ends[i - 1]!.y + 14;
    for (const e of ends) drawVenueMark(ctx, e.id, Math.min(pw - 8, e.x + 8), Math.max(top + 6, Math.min(bottom - 6, e.y)), 12);
    ctx.restore();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;
    ctx.fillText(pct(hi), this.w - AXIS_W + 6, y(hi)); ctx.fillText(pct(lo), this.w - AXIS_W + 6, y(lo));
    if (min < 0.5 && max > 0.5 && Math.abs(y(0.5) - y(hi)) > 14 && Math.abs(y(0.5) - y(lo)) > 14) ctx.fillText('50%', this.w - AXIS_W + 6, y(0.5));
    if (blank) {
      ctx.textAlign = 'left';
      const message = lsMessage(series, this.#loading);
      ctx.fillText(message === 'reading' ? t('Reading the long/short ratios…') : message === 'failed' ? t('The long/short ratios could not be read just now; trying again in a minute.') : t('No long/short readings for this time.'), 12, ph / 2);
    }
    // Readout and popup: the moment under the pointer, else now; past the newest reading (or over the price axis), the newest, and the cursor there.
    const newest = Math.max(-Infinity, ...shown.map(s => s.points[s.points.length - 1]!.t));
    let time = state.hover ? state.hover.t : Math.min(now, v.t1);
    if (time > newest && Number.isFinite(newest) && shown.every(s => !lsAt(s.points, time, s.periodMs))) { time = newest; if (state.hover && this.pointer) this.cursorT = newest; }
    const hover = state.hover;
    // On a plate the table is the popup; beside the plot the popup says who each line counts.
    const room: TableRoom = { w: this.w, h: ph, plotW: pw, axisW: AXIS_W, pointing: this.pointer !== null };
    const plated = state.lsTable && !blank && this.#table.draw(ctx, p, room, { heads: ['', t('Longs'), t('Shorts'), 'L/S'], minCols: 3, focus: -1, foot: hover ? clock(time, true) : `${t('newest')} ${clock(time)}`, rows: lsTableRows(series, time, p) })?.plate === true;
    if (hover && this.pointer && !plated) this.#lines = lsCardLines(series, time, state.timeframe);
    const parts = series.map(s => {
      const q = lsAt(s.points, time, s.periodMs), name = venueLabel(s.id);
      if (s.status === 'serverOnly') return `<span class="muted">${name} ${t('not readable here')}</span>`;
      if (s.status === 'stale' && q) return `${name} <b class="muted">${pct(q.long)}</b>`;
      return q ? `${name} <b class="${q.long > 0.5 ? 'bid' : q.long < 0.5 ? 'ask' : ''}">${pct(q.long)}</b>` : `<span class="muted">${name} –</span>`;
    });
    setHtml(readout, `${t('long')} ${parts.join(' ')}`);
  }
}
