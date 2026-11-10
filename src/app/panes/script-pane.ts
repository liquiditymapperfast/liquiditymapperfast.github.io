import type { Hub } from '../hub.ts';
import { TIMEFRAMES } from '../hub.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import type { AppState, CandleRow, Store } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton, toggleExplanation } from '../help.ts';
import { setTip } from '../tip.ts';
import { t, tn } from '../i18n.ts';
import { clock, price as fmtPrice } from '../format.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { togglePanel, type Panel } from '../ui.ts';
import { TimePane, setText } from './lower-panes.ts';
import { leftGutter, type ScriptLegendLine } from './heat-pane.ts';
import { el } from '../dom.ts';
import { ScriptHost, type WorkerLike } from '../script/host.ts';
import { ScriptData } from '../script/data.ts';
import { UNREAD_VENUE, analyze, sourcesWith, type Analysis } from '../script/lang/analysis.ts';
import { ScriptSyntaxError, type ScriptError } from '../script/lang/lexer.ts';
import { ROW_DEFAULT, SCRIPT_API, loadScripts, storeScripts, type OptionValue, type ScriptRecord } from '../script/records.ts';
import { starterScripts, updateStarters } from '../script/starter.ts';
import { exampleHeight, examples } from '../script/examples.ts';
import { PLOT_FIELDS, type PlotOut, type ScriptResult, type Warning } from '../script/protocol.ts';
import { MARK_SLOP, MARK_SLOP_TOUCH, markAt, markLines, markText, type DrawnMark } from '../script/marks.ts';
import { AlertNews, fingerprint, type ScriptAlert } from '../script/alert-news.ts';
import { onPlot, paintPlot, plotColorAt, scaleIdOf, scalesOf, shortNumber, visibleRange, yOf, type Frame, type Scale } from '../script/paint.ts';
import { errorText } from '../script/messages.ts';
import { safeColor } from '../script/lang/colors.ts';
import type { BarInputs, SourceFilter } from '../script/inputs.ts';
import { PALETTES } from '../theme.ts';
import { NEW_SCRIPT, unsaved, type ScriptsPanelState } from '../script/panel-state.ts';
import { buildScriptsPanel, panelClosed, refreshStatuses } from '../script/panel.ts';
import type { ScriptBarsState } from '../script/bars.ts';
import { aboutScript, builtinOf } from '../script/about.ts';

/**
 * A script's last answer, the candles it was worked out over (their starts, timeframe and market) and the moment it was worked out at: the
 * replay's moment then, Infinity live, -Infinity for an answer made on the page (a script that does not read).
 */
interface Held { result: ScriptResult; time: Float64Array; tf: number; inst: string; at: number }

/**
 * A script the Scripts panel's list shows on the map while its row is pointed at (`ScriptPane.preview`): one of the person's (`rec:` and its
 * id) or one of the examples (`ex:` and its key), with what it runs and where it draws. `id` is the person's script's own, null for an example.
 */
interface PreviewTarget { key: string; name: string; source: string; options: Record<string, OptionValue>; api: number; place: ScriptRecord['place']; height: number; id: string | null; /** What it runs (`ScriptPane.#contentKey`). */ ck: string }
/**
 * A preview's answer: as a run's (`Held`), with the theme it read, the markets it read over (the scope and the venues switched off, and the
 * page's market list), what the page held when it was asked for (`ScriptData.version`), when it came back (wall clock) and how long its run
 * took in the worker (ms).
 */
interface PreviewHeld extends Held { theme: string; scope: string; markets: unknown; data: number; ranAt: number; took: number }

/** A script worker: the pane's own runs have one, an agent's trials another. */
const spawnScriptWorker = (): WorkerLike => new Worker(new URL('../script/script.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;

/** The replay candle the page is at (a run's inputs stop at the candles closed by then), or -1 live. */
const replayKey = (tf: number): number => replaying() ? Math.floor(pageNow() / tf) : -1;
/** Whether a script reads the taker flow (`vbuy`, `vsell`, `bar.recorded`): its run then asks for the chart market's own candles where the page recorded none. */
const readsFlow = (a: Analysis): boolean => a.inputs.has('vbuy') || a.inputs.has('vsell') || a.inputs.has('recorded');
/** Whether a script reads the liquidations (`lbuy`, `lsell`, or `bar` handed on whole): only then are their days asked for. */
const readsLiquidations = (a: Analysis): boolean => a.inputs.has('lbuy') || a.inputs.has('lsell') || a.inputs.has('bar');

/**
 * How many of an answer's candles may be shown: all of them live; in a replay only those closed by its moment, whatever moment the answer
 * was worked out at (a script's value at a candle depends only on that candle and the ones before it, so those are what a replay run gives).
 */
function shownCount(time: Float64Array, tf: number): number {
  if (!replaying()) return time.length;
  const now = pageNow();
  let lo = 0, hi = time.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (time[m]! + tf <= now) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * The candle a pointer at `at` reads, of the first `shown` of an answer's candles: the one it is over, or right of the newest shown (or over
 * the price axis) the newest, as the built-in panes' popups do (`readAt`): landing on the last candle is a hunt. Never past what may be shown
 * (a replay's moment); a time in a gap between candles reads nothing (-1).
 */
function indexAt(time: Float64Array, tf: number, at: number, shown: number): number {
  let lo = 0, hi = time.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (time[m]! <= at) { i = m; lo = m + 1; } else hi = m - 1; }
  const newest = shown - 1;
  if (i > newest) i = newest;
  return i < 0 || (i < newest && at >= time[i]! + tf) ? -1 : i;
}

/** How many of a script's plots its popup lists (the others are counted). */
const CARD_PLOTS = 6;

/** The Scripts panel's row (`data-preview`, panel.ts) that holds `node`, or null. */
const rowKeyOf = (node: EventTarget | null): string | null => node instanceof Element ? node.closest<HTMLElement>('[data-preview]')?.dataset.preview ?? null : null;

/** How often a script runs at most (ms), and how often it runs again anyway while nothing it reads changes (the candle under way fills in). */
const MIN_INTERVAL = 1_000, REFRESH = 15_000;
/**
 * For this long after the chart's context changes (its timeframe, market, the candles' own timeframe, the venues) a change runs at once,
 * one run at a time: the first answer, and the data that lands after it (the candles, the flow, the exchange's candles, liquidations), are not
 * held behind the second between runs.
 */
const CONTEXT_FAST_MS = 10_000;

/**
 * A script's preview (Karl, 2026-11-04: "make indicators appear in the background when you hover over the script name ... It should be very
 * fast"): while a row of the Scripts panel's list is pointed at, its script is drawn on the map behind the panel, over a plate of the page's
 * colour this opaque that steps the map back so the script reads over the heat map. One that draws in a row of its own is drawn in a band at
 * the map's foot, as tall as its row would be, but no more than this share of the map and no less than PREVIEW_BAND_MIN.
 */
const PREVIEW_DIM = 0.5, PREVIEW_BAND_SHARE = 0.42, PREVIEW_BAND_MIN = 64;
/** The map legend's line of a preview (no script's id can be it: ids are lowercase letters, digits and dashes). */
const PREVIEW_LINE = '+preview';
/** How long a preview stays while the pointer crosses the gap between two rows of the list, so a pointer sweeping down it does not make the map blink. */
const PREVIEW_GAP_MS = 140;
/**
 * A preview pointed at again is worked out again when it is older than the pane's refresh, or (at most once a second) when what it reads has
 * landed since (liquidations, the order book, the exchange's candles): the newest candles, and the depth bands filling in back in time.
 */
const PREVIEW_DATA_MS = 1_000;

/**
 * The Scripts pane: a row for each of the person's scripts that is switched on, each with its own scales, drawn over the map's time axis.
 * The scripts run in a worker of their own (script/script.worker.ts), never on this thread; this pane gathers what they read
 * (script/data.ts), asks for a run at most once a second, and less often when a run takes longer (four times its length apart), so a heavy
 * script cannot keep a core busy. The Scripts… button opens the panel that lists, writes, imports and exports them (script/panel.ts).
 */
export class ScriptPane extends TimePane {
  #records: ScriptRecord[] = updateStarters(loadScripts(undefined, starterScripts));
  #version = 0;
  #host = new ScriptHost({ spawn: spawnScriptWorker });
  #data: ScriptData;
  #analysis = new Map<string, Analysis | ScriptError>();
  /** Each script's last answer; a new map at every run, so what is worked out from it can tell when to work it out again. */
  #held = new Map<string, Held>();
  #warnings = new Map<string, Warning[]>();
  #lastRun = 0; #runMs = 0; #timer = 0; #running = false; #runToken = 0; #starting = false;
  #seen: { candles: unknown; loads: number; data: number; version: number; tf: string; markets: unknown; venues: unknown; scope: string; theme: string } | null = null;
  /** The chart's context the scripts last read, and when it began (`CONTEXT_FAST_MS`). */
  #context = ''; #contextAt = 0;
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  #panel: Panel | null = null;
  /** The marks drawn on the map at its last drawing, and in the pane's rows at theirs: what the pointer finds. */
  #mapMarks: DrawnMark[] = [];
  #rowMarks: DrawnMark[] = [];
  /** The alerts already seen, per chart (`AlertNews`). */
  readonly #alertNews = new AlertNews();
  /** Called with each new alert of a script that is on (the page sounds it through its alerts). */
  onAlert: (alert: ScriptAlert) => void = () => {};
  readonly #ui: ScriptsPanelState = { editing: null, draft: null, message: null, armed: null };
  #button: HTMLButtonElement;

  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub) {
    super(host, store, view, 'script');
    this.#data = new ScriptData(hub, () => this.refresh());
    // Scripts that will run: their worker loads now, while the page's own requests have not yet taken the connections to its server.
    if (store.state.show.script && this.#records.some(r => r.on)) this.#host.warm();
    this.head.innerHTML = `<strong>${t('Scripts')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('scriptPane'));
    setTip(this.head.querySelector('strong')!, t('Your own indicators, written as scripts over the candles and the taker flow.'));
    const group = document.createElement('span'); group.className = 'ctl ctl-group'; this.head.append(group);
    this.#button = document.createElement('button'); this.#button.type = 'button'; this.#button.textContent = t('Scripts…');
    setTip(this.#button, t('Write, switch on and off, import and export your scripts.'));
    this.#button.onclick = () => this.openPanel();
    group.append(this.#button);
    this.root.append(this.#rowTools);
  }

  /** The scripts, in their order. */
  get records(): readonly ScriptRecord[] { return this.#records; }
  /** A script's last answer, its warnings, and what reading it found (or why it could not be read). */
  resultOf(id: string): ScriptResult | null { const held = this.#held.get(id); return held && this.#fresh(held) ? held.result : null; }
  warningsOf(id: string): readonly Warning[] { return this.#warnings.get(id) ?? []; }
  analysisOf(r: ScriptRecord): Analysis | ScriptError { return this.#analyze(r.source); }
  /** The chart a script's last run worked on, as far as it is shown (in a replay, the candles closed by its moment): for Copy for AI. */
  ranOn(id: string): { market: string; timeframe: string; candles: number } | null {
    const held = this.#held.get(id), tf = TIMEFRAMES[this.store.state.timeframe] ?? 3_600_000;
    return held && this.#fresh(held) ? { market: held.inst, timeframe: this.store.state.timeframe, candles: shownCount(held.time, tf) } : null;
  }
  /** Whether Scripts is on: the scripts run and draw. */
  get running(): boolean { return this.store.state.show.script; }
  /**
   * Whether a script is running and reads the candles, or the Scripts panel is open (its rows' previews read them too): the map then asks for
   * some before its left edge (HeatPane.scriptsReading).
   */
  get reading(): boolean { return (this.store.state.show.script && this.#records.some(r => r.on)) || this.#panel !== null; }
  /** The candles the scripts read: the chart's drawn ones (main.ts gives HeatPane.candlesDrawn), its own and the exchange's before them. */
  candlesOf: (state: AppState) => readonly CandleRow[] = state => state.candles;
  /** How many of the chart's candles scripts read (`script/bars.ts`), and how reading them stands (set by the page: `HeatPane.scriptBarsState`). */
  get bars(): number { return this.store.state.scriptBars; }
  setBars(bars: number): void { this.store.set({ scriptBars: bars }); }
  barsState: () => ScriptBarsState = () => ({ state: 'none', have: 0, want: this.store.state.scriptBars, market: '' });
  /** Say in an open Scripts panel how the scripts' candles stand now (they were read on, or are whole). */
  candlesRead(): void { this.#refreshPanel(); }
  /** Switch Scripts on: a script was added or switched on, and should be seen. */
  showScripts(): void { const show = this.store.state.show; if (!show.script) this.store.set({ show: { ...show, script: true } }); }

  /** Keep an answer made here, as a new map (what is worked out from the answers, the candle colours, is worked out again). */
  #setHeld(id: string, held: Held): void { this.#held = new Map(this.#held).set(id, held); this.#heldGen++; this.onMapChanged(); }

  /** Whether a script that is on draws in a row of this pane: the pane is shown only then (and only while Scripts is on). */
  get hasRows(): boolean { return this.#records.some(r => r.on && r.place === 'pane'); }
  /** The buttons beside each row's name (what it is, hide it, open it, switch it off), a layer over the canvas; placed again only when a row moves. */
  #rowTools = el('div', { class: 'script-row-tools' });
  #rowToolsKey = '';

  /** Open a script in the Scripts panel, from `anchor` (a row's or the map legend's button); one being written with changes not saved stays. */
  openScript(id: string, anchor: HTMLElement): void {
    const r = this.#records.find(x => x.id === id); if (!r) return;
    if (!(this.#ui.editing && this.#ui.editing !== id && unsaved(this, this.#ui)) && this.#ui.editing !== id) {
      this.#ui.editing = id; this.#ui.draft = { name: r.name, source: r.source, options: { ...r.options }, place: r.place }; this.#ui.message = null;
    }
    if (this.#panel) this.#panel.render(this.#build); else this.openPanel(anchor);
  }

  /** Hide a script where it is drawn, or show it again: hidden, it still runs and alerts, and its legend line or row stays. */
  toggleHidden(id: string): void {
    this.setRecords(this.#records.map(r => r.id === id ? { ...r, hidden: !r.hidden } : r));
    if (this.#panel && !this.#ui.editing) this.#panel.render(this.#build);
  }

  /** Switch a script off from where it is drawn (it stays in the list, to be switched on again there). */
  switchOff(id: string): void {
    this.setRecords(this.#records.map(r => r.id === id ? { ...r, on: false } : r));
    if (this.#panel && !this.#ui.editing) this.#panel.render(this.#build);
  }

  /** Put each row's buttons beside its name (`places` in the plot's coordinates); nothing changes while no row moved. */
  #placeRowTools(places: readonly { id: string; x: number; y: number }[]): void {
    const dx = this.canvas.offsetLeft + leftGutter(this.store.state), dy = this.canvas.offsetTop;
    const key = `${dx},${dy}|${places.map(p => `${p.id}:${Math.round(p.x)},${Math.round(p.y)}:${this.#hiddenOf(p.id)}:${this.#toolsOf(p.id)}`).join('|')}`;
    if (key === this.#rowToolsKey) return;
    this.#rowToolsKey = key;
    this.#syncTools(this.#rowTools, this.#rowButtons, places, dx, dy);
  }
  #rowButtons = new Map<string, HTMLElement>();

  /** The buttons of the map legend's script lines, a layer the page puts over the map (`places` in the map pane's own pixels). */
  readonly legendTools = el('div', { class: 'script-row-tools script-legend-tools' });
  #legendToolsKey = '';
  placeLegendTools(all: readonly { id: string; x: number; y: number }[]): void {
    // A preview's line has no buttons (`mapLegend`).
    const places = all.filter(p => p.id !== PREVIEW_LINE);
    const key = places.map(p => `${p.id}:${Math.round(p.x)},${Math.round(p.y)}:${this.#hiddenOf(p.id)}:${this.#toolsOf(p.id)}`).join('|');
    if (key === this.#legendToolsKey) return;
    this.#legendToolsKey = key;
    this.#syncTools(this.legendTools, this.#legendButtons, places, 0, 0);
  }
  #legendButtons = new Map<string, HTMLElement>();

  #hiddenOf(id: string): boolean { return this.#records.find(r => r.id === id)?.hidden === true; }
  /** How many buttons a script has beside its name: a "?" first for one of the page's own (`builtinOf`), then the three every script has. */
  #toolsOf(id: string): number { const r = this.#records.find(x => x.id === id); return r && builtinOf(r) ? 4 : 3; }

  /**
   * Each script's buttons, what it is (one of the page's own scripts only), hide or show, open and switch off, at its place (offset by `dx`, `dy`)
   * in `layer`: a script's buttons are made once and moved after, so a panel opened from one keeps its anchor and a focused one keeps the
   * focus; a script no longer listed loses its buttons. The eye says whether the script is hidden. The "?" opens the script's description in a
   * panel of its own, as every "?" outside a panel does; it is added or taken away only when a script's text makes it the page's or not.
   */
  #syncTools(layer: HTMLElement, made: Map<string, HTMLElement>, places: readonly { id: string; x: number; y: number }[], dx: number, dy: number): void {
    const wanted = new Set(places.map(p => p.id));
    for (const [id, box] of made) if (!wanted.has(id)) { box.remove(); made.delete(id); }
    for (const place of places) {
      let box = made.get(place.id);
      if (!box) {
        const hide = el('button', { type: 'button', class: 'script-row-hide' });
        hide.onclick = () => this.toggleHidden(place.id);
        const open = el('button', { type: 'button', class: 'script-row-open', ariaLabel: t('Open this script to change it'), tip: t('Open this script to change it') });
        open.onclick = () => this.openScript(place.id, open);
        const off = el('button', { type: 'button', class: 'script-row-off', textContent: '×', ariaLabel: t('Switch this script off (it stays in Scripts…)'), tip: t('Switch this script off (it stays in Scripts…)') });
        off.onclick = () => this.switchOff(place.id);
        box = el('span', { class: 'script-row-tool' }, hide, open, off);
        made.set(place.id, box); layer.append(box);
      }
      const record = this.#records.find(r => r.id === place.id), about = record ? aboutScript(record) : null;
      const asked = box.querySelector<HTMLButtonElement>('.script-row-about');
      if (about && !asked) {
        const ask = el('button', { type: 'button', class: 'script-row-about', ariaLabel: t('Explain: {topic}', { topic: about.title }), tip: t('What is this? {topic}', { topic: about.title }) });
        ask.onclick = () => { const r = this.#records.find(x => x.id === place.id), now = r ? aboutScript(r) : null; if (now) toggleExplanation(ask, now); };
        box.prepend(ask);
      } else if (!about && asked) asked.remove();
      const hide = box.querySelector<HTMLButtonElement>('.script-row-hide')!, hidden = this.#hiddenOf(place.id);
      if (hide.dataset.hidden !== String(hidden)) {
        hide.dataset.hidden = String(hidden);
        const words = hidden ? t('Show this script') : t('Hide this script (it still runs and alerts)');
        hide.setAttribute('aria-label', words); hide.setAttribute('aria-pressed', String(hidden)); setTip(hide, words);
      }
      box.style.left = `${Math.round(dx + place.x)}px`; box.style.top = `${Math.round(dy + place.y)}px`;
    }
  }

  /**
   * The map legend's lines for the scripts drawn on the map: each one's name, the colour of its first plot, and its values at the candle
   * starting at `at` (null, or right of the newest: the newest shown), or what it is doing (running..., its error); first, the preview of one
   * drawn on the map while its row in the Scripts panel is pointed at (`PREVIEW_LINE`).
   */
  mapLegend(at: number | null, valued = Infinity): ScriptLegendLine[] {
    const state = this.store.state, out: ScriptLegendLine[] = [];
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, p = this.palette, fallbacks = [p.vwap, p.poc, p.level, p.accent, p.bid, p.ask];
    const line = (id: string, name: string, options: Readonly<Record<string, OptionValue>>, res: Extract<ScriptResult, { ok: true }>, time: Float64Array, withValues: boolean, tools: number): ScriptLegendLine => {
      const shown = shownCount(time, tf), i = at === null ? shown - 1 : indexAt(time, tf, at, shown);
      const band = (plot: PlotOut): boolean => (plot.kind === 'brokenarea' || plot.kind === 'cloudarea') && plot.colors !== null;
      const finiteAt = (plot: PlotOut): boolean => i >= 0 && PLOT_FIELDS[plot.kind].some(f => Number.isFinite(plot.fields[f]![i]!));
      // Lines first (they are what a legend reads), then the other plots; bands coloured point by point only when there is nothing else.
      const plots = res.plots.map((plot, j) => ({ plot, j })).filter(({ plot }) => plot.style.visible !== false).sort((a, b) => Number(b.plot.kind === 'line') - Number(a.plot.kind === 'line'));
      const read = plots.filter(({ plot }) => !band(plot) && finiteAt(plot)), from = read.length ? read : plots.filter(({ plot }) => finiteAt(plot));
      // Its colour as it is drawn at this candle (the painter's own choice: a point's colour, the plot's for its kind, the page's for its place).
      const first = from[0] ?? plots[0];
      const color = first ? plotColorAt(first.plot, Math.max(0, i), fallbacks[first.j % fallbacks.length]!, p.candleUp, p.candleDown) : '';
      let text = '';
      if (withValues && i >= 0) {
        const texts = from.slice(0, 3).map(({ plot }) => {
          if (plot.kind === 'mark') return markText(plot, i);
          const fmt = scaleIdOf(plot, options) === 'right' ? (v: number) => fmtPrice(v) : shortNumber;
          return PLOT_FIELDS[plot.kind].map(f => plot.fields[f]![i]!).filter(Number.isFinite).map(fmt).join(' – ');
        });
        text = texts.join(' · ') + (from.length > 3 ? ' …' : '');
      }
      return { id, name, color, text, tone: 'text', tools };
    };
    if (state.show.script) for (const r of this.#records) {
      if (!r.on || r.place !== 'map') continue;
      // A hidden script is listed, muted and with no values, so its eye can show it again.
      const tools = this.#toolsOf(r.id);
      if (r.hidden) { out.push({ id: r.id, name: r.name, color: '', text: '', tone: 'muted', tools }); continue; }
      // Only the first `valued` lines show values (the legend lists a few, and none on a phone): the others are named, not worked out.
      const withValues = out.length < valued;
      const kept = this.#held.get(r.id), held = kept && this.#fresh(kept) ? kept : undefined;
      if (!held) { out.push({ id: r.id, name: r.name, color: '', text: t('running…'), tone: 'muted', tools }); continue; }
      if (!held.result.ok) { out.push({ id: r.id, name: r.name, color: '', text: errorText(held.result.error), tone: 'error', tools }); continue; }
      out.push(line(r.id, r.name, r.options, held.result, held.time, withValues, tools));
    }
    // A preview of a script drawn on the map is named first, with its values, where the eye reads the chart (its newest candles may be under
    // the panel); one that is on is listed already, and stands out on the map. No buttons: it is not one of the scripts on the map.
    const pv = this.#pv, shown = pv?.place === 'map' && !this.#pvOwn(pv) ? this.#pvShown(pv) : null;
    if (pv && shown?.result.ok) out.unshift(line(PREVIEW_LINE, `${pv.name} · ${t('preview')}`, pv.options, shown.result, shown.time, valued > 0, 0));
    return out;
  }

  /** Called when `hasRows` changed: the page lays its panes out again. */
  onRowsChanged: () => void = () => {};
  /** Called with what the scripts are doing, for the Scripts lamp: `running` (one that is on waits for its first answer), `error` and the name of one that stopped, or ''. */
  onStatus: (note: 'running' | 'error' | '', name: string) => void = () => {};
  #statusKey = ''; #rowsKey = '';

  /** Keep `list` as the scripts; false when this browser refused to store it (the list still applies until the page closes). */
  setRecords(list: ScriptRecord[]): boolean {
    const hadRows = this.hasRows;
    // A script whose text, options or version changed has no answer until it runs again: the old one is not drawn meanwhile.
    const was = new Map(this.#records.map(r => [r.id, r]));
    const stale = list.filter(r => { const o = was.get(r.id); return !o || o.source !== r.source || o.api !== r.api || JSON.stringify(o.options) !== JSON.stringify(r.options) || !r.on; });
    if (stale.some(r => this.#held.has(r.id))) { this.#held = new Map(this.#held); for (const r of stale) this.#held.delete(r.id); this.#heldGen++; this.onMapChanged(); }
    this.#records = list;
    this.#version++;
    // A run still waiting for its worker to load holds the old scripts: dropped now, not at the next frame (the worker may load before it).
    this.#host.dropUnsent();
    for (const id of [...this.#held.keys()]) if (!list.some(r => r.id === id)) this.#held.delete(id);
    const kept = storeScripts(list);
    this.#lastRun = 0;
    this.refresh();
    this.#reportStatus();
    if (this.hasRows !== hadRows) this.onRowsChanged();
    return kept;
  }

  /**
   * What the scripts read changed, or a run may be due: draw again and look whether to run, now. A run is not left to a drawing: while only
   * scripts on the map are on the pane is not laid out and draws nothing.
   */
  refresh(): void { this.invalidate(); this.#maybeRun(); if (this.#pv || this.#panel) this.#pvPump(); }

  /** Scripts was switched on or off: off, a run still waiting for its worker to load is dropped; the list's statuses and the lamp follow at once. */
  showChanged(): void {
    if (!this.store.state.show.script) this.#host.dropUnsent();
    this.#refreshPanel(); this.#reportStatus(); this.#maybeRun();
  }

  /**
   * The panel's code is part of the page, never fetched at the first open: on a page whose own requests hold every connection to its server,
   * a fetched panel waited behind them (23 s, and 38 s on a development page, 2026-10-27), and each click made meanwhile opened or closed it
   * once more when it came, so an even number of clicks left it shut. Opened at once, a second click closes it as every settings key does.
   */
  readonly #build = (_tools: HTMLElement, body: HTMLElement): void => {
    buildScriptsPanel(this, body, () => this.#panel?.render(this.#build), this.#ui);
    // Once the panel has its rows (and its scroll) back: the row under the pointer or with the keyboard is found again, and the list's
    // previews not yet worked out are worked out.
    queueMicrotask(() => this.#pvAfterBuild());
  };
  openPanel(anchor: HTMLElement = this.#button): void {
    // Against the window's right edge, over the order book: by its key it covered the map's newest candles, where a row pointed at shows its script.
    this.#panel = togglePanel(anchor, { title: t('Scripts'), width: 520, align: 'edge', onClose: () => { this.#panel = null; panelClosed(this, this.#ui); this.#pvEnd(); }, stays: true, resizable: 'scripts' }, this.#build);
    if (this.#panel) this.#pvWire(this.#panel);
  }
  /** Write the list's statuses again with the latest results, in place (a menu or a switch under the pointer stays); not while a script is being written. */
  #refreshPanel(): void { if (this.#panel && !this.#ui.editing) refreshStatuses(this, this.#panel.body); }

  #analyze(source: string): Analysis | ScriptError {
    let a = this.#analysis.get(source);
    if (!a) {
      try { a = analyze(source); } catch (e) { if (e instanceof ScriptSyntaxError) a = e.info; else throw e; }
      if (this.#analysis.size > 64) this.#analysis.clear();
      this.#analysis.set(source, a);
    }
    return a;
  }

  /** Whether the inputs changed since the last run, and if a run is due, start one. */
  #maybeRun(): void {
    const state = this.store.state;
    const on = this.#records.filter(r => r.on);
    // Nothing to run: a run still waiting for its worker to load is dropped, so the worker never runs scripts switched off meanwhile.
    if (!state.show.script || !on.length) { this.#host.dropUnsent(); return; }
    // A run under way is waited for; one still waiting for its worker to load is replaced by a newer request; one being asked for is not asked twice.
    if (this.#starting || (this.#running && !this.#host.loading)) return;
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    const drawn = this.candlesOf(state);
    const seen = { candles: drawn, loads: this.hub.flow.loads, data: this.#data.version, version: this.#version, tf: state.timeframe, markets: state.markets, venues: state.disabledVenues, scope: state.scope, inst: state.seriesInstrument, replay: replayKey(tf), oi: state.oi, oiParts: state.oiParts, theme: this.#theme, taker: this.hub.candleTaker(tf).version };
    const was = this.#seen, now = Date.now();
    const changed = !was || Object.keys(seen).some(k => (seen as Record<string, unknown>)[k] !== (was as Record<string, unknown>)[k]);
    const context = `${state.timeframe}|${state.candlesTimeframe ?? ''}|${state.marketId}|${state.seriesInstrument}|${state.scope}|${state.disabledVenues.join(',')}`;
    if (context !== this.#context) { this.#context = context; this.#contextAt = now; }
    const settling = now - this.#contextAt < CONTEXT_FAST_MS;
    // Nothing changed: run again at the refresh anyway (the candle under way fills in from the flow), on a timer, so a quiet page still refreshes.
    if (!changed && now - this.#lastRun < REFRESH) { this.#wake(this.#lastRun + REFRESH - now); return; }
    // Another theme (picked, or previewed from the menu) runs at once: until it has run, the pane shows the colours of the theme before.
    // Right after a switch, as soon as what it needs lands, but never closer than twice the time a run takes (a heavy script still leaves room).
    const interval = settling ? this.#runMs * 2 : Math.max(MIN_INTERVAL, this.#runMs * 4), wait = this.#lastRun + interval - now;
    if (wait > 0 && was?.theme === seen.theme) { this.#wake(wait); return; }
    this.#seen = seen;
    this.#starting = true;
    try { this.#run(on); } finally { this.#starting = false; }
  }

  /** Draw again (and so look whether a run is due) in `ms`. */
  #wakeAt = 0;
  #wake(ms: number): void {
    const at = Date.now() + Math.max(50, ms);
    if (this.#timer && this.#wakeAt <= at) return;
    if (this.#timer) window.clearTimeout(this.#timer);
    this.#wakeAt = at;
    this.#timer = window.setTimeout(() => { this.#timer = 0; this.#wakeAt = 0; this.refresh(); }, at - Date.now());
  }

  /** The theme this pane draws in (the one picked, or one previewed from the menu): its scripts read its colours (`theme`). */
  #theme = 'light';
  override setPalette(name: string): void { this.#theme = name; super.setPalette(name); }
  /** Inputs with the colours of the theme the pane draws in. */
  #withTheme(inputs: BarInputs | null): BarInputs | null {
    if (!inputs) return null;
    const p = PALETTES[this.#theme] ?? PALETTES.light!;
    return { ...inputs, theme: { dark: p.dark, background: p.bg, text: p.text, up: p.candleUp, down: p.candleDown } };
  }

  /** What a script reads that the page cannot give it: an option it reads but does not declare that is not set, a set of markets with none. */
  #pageWarnings(a: Analysis, options: Readonly<Record<string, OptionValue>>, markets: ReturnType<ScriptData['markets']>): Warning[] {
    const w: Warning[] = [];
    for (const name of a.read) if (!(name in options)) w.push({ code: 'unset-option', detail: name });
    for (const [k, f] of sourcesWith(a, options)) {
      if (f.venues?.includes(UNREAD_VENUE)) w.push({ code: 'unread-source' });
      else if (k && !markets.get(k)?.length) w.push({ code: 'no-markets', detail: k.replace(/;/g, ', ') });
    }
    if (this.#data.liquidationsCut && (a.inputs.has('lbuy') || a.inputs.has('lsell'))) w.push({ code: 'liquidations-cut' });
    return w;
  }

  /** A worker of its own for the trial runs of an agent in the browser (`tryScript`), made at the first: a trial neither waits behind the
   * pane's runs nor takes their place. One trial at a time. */
  #trialHost: ScriptHost | null = null;
  #trialBusy = false;

  /**
   * Run a script once over the chart as it is, for an agent in the browser (agent/), under the limits of the pane's own runs: nothing is
   * kept, drawn or saved. 'busy' while another trial runs; null while the chart has no candles. `signal` drops a trial not yet started.
   */
  async tryScript(source: string, options: Record<string, OptionValue>, signal?: AbortSignal): Promise<{ result: ScriptResult; warnings: Warning[]; candles: number } | 'busy' | null> {
    // Given up on before it started: never sent (the listener below only drops a trial given up on later).
    signal?.throwIfAborted();
    const a = this.#analyze(source);
    if (!('program' in a)) return { result: { id: 'trial', ok: false, error: a }, warnings: [], candles: 0 };
    if (this.#trialBusy) return 'busy';
    const state = this.store.state, filters = new Map<string, SourceFilter>([['', {}], ...sourcesWith(a, options)]);
    const inputs = this.#withTheme(this.#data.inputs(state, filters, a.inputs.has('oichg'), readsFlow(a), this.candlesOf(state), readsLiquidations(a)));
    if (!inputs) return null;
    const warnings = this.#pageWarnings(a, options, this.#data.markets(state, filters));
    // Counted now: the run hands the inputs' arrays over to the worker, which leaves them empty here.
    const candles = shownCount(inputs.time, inputs.tf);
    const host = this.#trialHost ??= new ScriptHost({ spawn: spawnScriptWorker });
    const depth = a.inputs.has('depth') ? this.#data.depth.sync(state, inputs.time, inputs.tf) : null;
    if (depth) this.#data.depth.deliver(host);
    this.#trialBusy = true;
    const drop = (): void => host.dropUnsent();
    signal?.addEventListener('abort', drop, { once: true });
    try {
      const { results, depthBehind } = await host.run([{ id: 'trial', source, options, api: SCRIPT_API }], inputs, depth ?? undefined);
      if (depthBehind) this.#data.depth.forget(host);
      const result: ScriptResult = results[0] ?? { id: 'trial', ok: false, error: { code: 'no-answer', line: 0, col: 0 } };
      return { result, warnings, candles };
    } finally { this.#trialBusy = false; signal?.removeEventListener('abort', drop); }
  }

  /** Load the trials' worker now (the page offers agent tools): a first trial then does not wait for it. */
  warmTrials(): void { (this.#trialHost ??= new ScriptHost({ spawn: spawnScriptWorker })).warm(); }

  /** Where the Scripts panel opens from when nothing was pressed (an agent's draft): the page sets the top bar's Scripts key. */
  panelAnchor: () => HTMLElement = () => this.#button;

  /**
   * Show a script an agent in the browser wrote as a draft in the Scripts panel, for the person to read and then save or drop: a new script,
   * or new text for one that exists (`id`). Nothing is kept until they press Save. Refused while a script is being written with changes
   * not saved.
   */
  proposeScript(p: { name: string; source: string; place?: 'pane' | 'map'; id?: string }): 'shown' | 'busy' | 'unknown-script' {
    if (this.#ui.editing && unsaved(this, this.#ui)) return 'busy';
    const r = p.id === undefined ? null : this.#records.find(x => x.id === p.id) ?? null;
    if (p.id !== undefined && !r) return 'unknown-script';
    this.#ui.editing = r ? r.id : NEW_SCRIPT;
    this.#ui.draft = { name: p.name || r?.name || '', source: p.source, options: r ? { ...r.options } : {}, place: p.place ?? r?.place ?? 'pane' };
    this.#ui.message = { text: t('An assistant in your browser wrote this script. Read it, then press Save to keep it, or Back to drop it.'), error: false };
    this.#ui.armed = null;
    if (this.#panel) this.#panel.render(this.#build); else this.openPanel(this.panelAnchor());
    return 'shown';
  }

  #run(on: readonly ScriptRecord[]): void {
    const state = this.store.state;
    const filters = new Map<string, SourceFilter>([['', {}]]);
    const runnable: ScriptRecord[] = [];
    for (const r of on) {
      if (r.api > SCRIPT_API) { this.#pageError(r.id, { code: 'newer-api', line: 0, col: 0 }); continue; }
      const a = this.#analyze(r.source);
      if (!('program' in a)) { this.#pageError(r.id, a); continue; }
      // Its markets as its options name them (`exchange=options.venue`): the worker works them out from the same values.
      for (const [k, f] of sourcesWith(a, r.options)) filters.set(k, f);
      runnable.push(r);
    }
    // A look that runs nothing is paced like a run, or a map drawn again for its errors would look again at once, frame after frame.
    if (!runnable.length) { this.#host.dropUnsent(); this.#lastRun = Date.now(); return; }
    // The change in open interest is worked out only for a run in which a script reads it.
    const read = runnable.map(r => this.#analyze(r.source) as Analysis);
    const inputs = this.#withTheme(this.#data.inputs(state, filters, read.some(a => a.inputs.has('oichg')), read.some(readsFlow), this.candlesOf(state), read.some(readsLiquidations)));
    if (!inputs) { this.#host.dropUnsent(); return; }
    // The order book, for a run in which a script reads it: kept up to date, and what the worker lacks of it posted before the run.
    const depth = read.some(a => a.inputs.has('depth')) ? this.#data.depth.sync(state, inputs.time, inputs.tf) : null;
    if (depth) this.#data.depth.deliver(this.#host);
    const markets = this.#data.markets(state, filters);
    for (const r of runnable) this.#warnings.set(r.id, this.#pageWarnings(this.#analyze(r.source) as Analysis, r.options, markets));
    const time = inputs.time.slice(), tf = inputs.tf, inst = state.seriesInstrument, at = replaying() ? pageNow() : Infinity, started = Date.now();
    const token = ++this.#runToken;
    this.#running = true; this.#lastRun = started;
    const version = this.#version, theme = this.#theme;
    void this.#host.run(runnable.map(r => ({ id: r.id, source: r.source, options: r.options, api: r.api })), inputs, depth ?? undefined).then(({ results, ms, depthBehind }) => {
      // A newer request replaced this one before its worker took it: the newer one's answer is the one that counts.
      if (token !== this.#runToken) return;
      this.#running = false;
      // A worker that did not hold the order book it was told of (one started since): it is sent everything, and the run is due again.
      if (depthBehind) { this.#data.depth.forget(this.#host); this.#seen = null; }
      // Dropped before its worker took it (the scripts changed, or were switched off): look again now, or nothing may ask while the map is covered.
      if (!results.length) { this.refresh(); return; }
      // Scripts changed while it ran (edited, switched off, deleted): its answer is stale, and the next run is due at once.
      if (version !== this.#version) { this.refresh(); return; }
      // The oldest candle a run alerts at: the last one closed, or the newest when none is under way.
      const since = time.length ? time[Math.max(0, time.length - (inputs.forming ? 2 : 1))]! : 0;
      // Alerts only from a live answer for the chart as it is now, with Scripts on: one that comes after Scripts was switched off, the chart
      // changed or a replay began says nothing. Taken before the theme is checked: an alert says what the chart did, not in which colours,
      // and the run that replaces one thrown away for its colours may no longer meet it.
      const cur = this.store.state, live = at === Infinity && !replaying() && cur.show.script && cur.seriesInstrument === inst && (TIMEFRAMES[cur.timeframe] ?? 3_600_000) === tf;
      if (live) for (const res of results) { const r = runnable.find(x => x.id === res.id); if (r && res.ok) this.#takeAlerts(r, res, inst, tf, since); }
      // The theme changed while it ran (picked, or previewed from the menu): its colours are the other theme's, and the next run is due.
      if (theme !== this.#theme) { this.refresh(); return; }
      // The run's own time (a worker that waited to load, or never did, is not a slow script): a slow script runs less often, spaced
      // from when it started in its worker.
      this.#runMs = ms; this.#lastRun = Date.now() - ms;
      for (const res of results) this.#held.set(res.id, { result: res, time, tf, inst, at });
      this.#held = new Map(this.#held); this.#heldGen++;
      this.invalidate();
      this.onMapChanged();
      this.#refreshPanel();
      this.#reportStatus();
      // The next look is set now (the refresh timer), not left to a drawing: a map covered by another tab draws nothing.
      this.#maybeRun();
    });
  }

  /** Hand on the new alerts of a script's answer (live answers only: a replay never sounds). */
  #takeAlerts(r: ScriptRecord, res: Extract<ScriptResult, { ok: true }>, inst: string, tf: number, since: number): void {
    const chart = `${r.id}|${fingerprint(`${r.api}|${JSON.stringify(r.options)}|${r.source}`)}|${inst}|${tf}`;
    for (const a of this.#alertNews.take(res, chart, tf, since, Date.now())) {
      this.onAlert({ id: r.id, name: r.name, text: a.text ? `${r.name}: ${a.text}` : r.name, sound: a.sound, key: `${r.id}|${a.site}` });
    }
  }

  /** Keep an error met on the page (a script that does not read, one for a newer page); the same one again changes nothing, so nothing is drawn again for it. */
  #pageError(id: string, error: ScriptError): void {
    const was = this.#held.get(id);
    if (was && was.tf === 0 && !was.result.ok && JSON.stringify(was.result.error) === JSON.stringify(error)) return;
    this.#setHeld(id, { result: { id, ok: false, error }, time: new Float64Array(0), tf: 0, inst: '', at: -Infinity });
  }

  /** Whether an answer may be read now: one for the chart as it is (`#current`), or an error met on the page, which holds everywhere. */
  #fresh(held: Held): boolean { return held.tf === 0 || this.#current(held, TIMEFRAMES[this.store.state.timeframe] ?? 3_600_000); }

  /**
   * Whether an answer is for the chart as it is now: its timeframe, its market, and in a replay one worked out at or before the replay's
   * moment (never a live one, never one from before a rewind: what was read later may differ for the same candles), of which only the
   * candles closed by then are shown (`shownCount`).
   */
  #current(held: Held, tf: number): boolean { return held.tf === tf && held.inst === this.store.state.seriesInstrument && held.at <= (replaying() ? pageNow() : Infinity); }

  /** Tell the lamp what the scripts are doing, when that changed. */
  #reportStatus(): void {
    const state = this.store.state, tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    let note: 'running' | 'error' | '' = '', name = '';
    if (state.show.script) for (const r of this.#records) {
      if (!r.on) continue;
      const held = this.#held.get(r.id), fresh = !!held && this.#current(held, tf);
      // An error met on the page (the script does not read, or is for a newer page: tf 0) holds everywhere; one met in a run, only there.
      if (held && !held.result.ok && (held.tf === 0 || fresh)) { note = 'error'; name = r.name; break; }
      if (!fresh) note = 'running';
    }
    const key = `${note}|${name}`;
    if (key !== this.#statusKey) { this.#statusKey = key; this.onStatus(note, name); }
    // The list's statuses follow, in place, whenever one script's changes (entering a replay, say, leaves its answers waiting for the
    // replay's first run), whether or not the lamp's does.
    let rows = state.show.script ? 'on' : 'off';
    for (const r of this.#records) { const h = this.#held.get(r.id); rows += `|${r.id}:${!h ? '-' : !this.#fresh(h) ? 's' : h.result.ok ? 'o' : 'e'}`; }
    if (rows !== this.#rowsKey) { this.#rowsKey = rows; this.#refreshPanel(); }
  }

  protected draw(): void {
    this.#maybeRun();
    this.#lines = null;
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }
  protected override undrawn(): void { this.#lines = null; this.#card.hide(); }

  #paint(): void {
    const { ctx, palette: p } = this, state = this.store.state, pw = this.plotW, ph = this.h, v = this.view;
    const running = this.#records.filter(r => r.on), on = running.filter(r => r.place === 'pane');
    setText(this.head.querySelector('.readout'), this.#records.length ? tn(running.length, '{n} script on', '{n} scripts on') : '');
    ctx.textBaseline = 'middle';
    this.#reportStatus();
    // The pane is laid out only while a script that is on draws in it (`hasRows`): for a moment after one is switched off it has none.
    if (!on.length) { this.#placeRowTools([]); return; }
    const places: { id: string; x: number; y: number }[] = [];
    const total = on.reduce((s, r) => s + r.height, 0), least = Math.max(1, Math.min(24, Math.floor(ph / on.length)));
    let top = 0;
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    const hv = state.hover;
    const card: InfoLine[] = [];
    const fallbacks = [p.vwap, p.poc, p.level, p.accent, p.bid, p.ask];
    this.#rowMarks = [];
    on.forEach((r, k) => {
      const left = on.length - 1 - k, rowH = left === 0 ? Math.max(least, ph - top) : Math.max(least, Math.min(ph - top - left * least, Math.round(ph * r.height / total)));
      const kept = this.#held.get(r.id), held = kept && this.#fresh(kept) ? kept : undefined;
      if (k > 0) { ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(this.w, top + 0.5); ctx.stroke(); }
      // A row's name stands on a faint plate of the page's colour, so a plot under it does not make it hard to read.
      const label = (text: string, color: string, y: number): number => {
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left';
        const w = Math.min(pw - 8, ctx.measureText(text).width + 8);
        ctx.globalAlpha = 0.78; ctx.fillStyle = p.bg; ctx.fillRect(2, y - 7, w, 14); ctx.globalAlpha = 1;
        ctx.fillStyle = color; ctx.fillText(text, 6, y);
        return w;
      };
      // The row's buttons stand after its name's plate (the name is drawn last, over the plots, so it is measured where it is drawn).
      const tools = (w: number): void => { places.push({ id: r.id, x: Math.min(pw - 44, 2 + w + 4), y: top + 1 }); };
      if (r.hidden) tools(label(`${r.name} · ${t('hidden')}`, p.muted, top + 9));
      else if (!held) tools(label(`${r.name} · ${t('running…')}`, p.muted, top + 9));
      else if (!held.result.ok) { tools(label(r.name, p.text, top + 9)); ctx.save(); ctx.beginPath(); ctx.rect(0, top, pw, rowH); ctx.clip(); label(errorText(held.result.error), p.ask, top + 24); ctx.restore(); }
      else {
        const res = held.result, time = held.time;
        // A run for another timeframe is not drawn over this one: the next run replaces it.
        const shown = shownCount(time, tf), [from, last] = visibleRange(time, v.t0, v.t1, tf), to = Math.min(last, shown - 1);
        if (this.#current(held, tf) && to >= from) {
          const scales = scalesOf(res.plots, r.options, from, to);
          const frame: Frame = { ctx, x: tt => v.xOf(tt, pw), barW: Math.max(1, v.xOf(tf, pw) - v.xOf(0, pw)), tf, time, from, to, top, height: rowH, w: pw, color: p.text, up: p.candleUp, down: p.candleDown };
          res.plots.forEach((plot, j) => {
            const s = scales.get(scaleIdOf(plot, r.options)), fallback = fallbacks[j % fallbacks.length]!;
            if (s) paintPlot({ ...frame, color: fallback, ...(plot.kind === 'mark' ? { marks: box => { this.#rowMarks.push({ box, id: r.id, name: r.name, plot, color: plotColorAt(plot, box.i, fallback, p.candleUp, p.candleDown) }); } } : {}) }, plot, s);
          });
          // The tags of the row's first scale at its right edge: the highest and the lowest in view.
          const first = scales.values().next().value;
          if (first) {
            ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'right'; ctx.fillStyle = p.muted;
            ctx.fillText(shortNumber(first.max), this.w - 4, Math.max(top + 8, yOf(first.max, first, top, rowH)));
            ctx.fillText(shortNumber(first.min), this.w - 4, Math.min(top + rowH - 8, yOf(first.min, first, top, rowH)));
          }
          if (hv) this.#cardLines(card, r, res, time, tf, hv.t, shown);
        }
        const notes = this.warningsOf(r.id).length + res.warnings.length;
        tools(label(notes ? `${r.name} · ${tn(notes, '{n} warning', '{n} warnings')}` : r.name, notes ? p.muted : p.text, top + 9));
      }
      top += rowH;
    });
    this.#placeRowTools(places);
    // A mark under the pointer says what it is, in place of the candle's readout.
    const marked = hv?.source === 'script' ? markAt(this.#rowMarks, v.xOf(hv.t, pw), hv.y, hv.touch ? MARK_SLOP_TOUCH : MARK_SLOP) : null;
    if (marked) this.#lines = markLines(marked, 'text');
    else if (card.length) this.#lines = card;
  }

  /** Called when what the scripts draw on the map changed (the map draws again). */
  onMapChanged: () => void = () => {};
  /** What paintOnMap last drew: the plot's size and each script's scales, for the popup to tell whether the pointer is on a plot. */
  #mapDrawn: { pw: number; ph: number; scripts: Map<string, Map<string, Scale>> } = { pw: 0, ph: 0, scripts: new Map() };
  #candleColors = new Map<number, string>();
  #colorsKey = '';
  #heldGen = 0;

  /** A script's colour for the map's candle starting at `t` (`$price.color = ...`), or '' for the candle's own. */
  candleColorAt(t: number): string {
    if (!this.store.state.show.script) return '';
    const state = this.store.state, key = `${this.#heldGen}|${this.#version}|${state.timeframe}|${state.seriesInstrument}|${replayKey(TIMEFRAMES[state.timeframe] ?? 3_600_000)}`;
    if (this.#colorsKey !== key) { this.#colorsKey = key; this.#rebuildColors(); }
    return this.#candleColors.get(t) ?? '';
  }
  #rebuildColors(): void {
    const out = new Map<number, string>(), tf = TIMEFRAMES[this.store.state.timeframe] ?? 3_600_000;
    for (const r of this.#records) {
      const held = r.on && !r.hidden ? this.#held.get(r.id) : undefined;
      if (!held?.result.ok || !held.result.candleColors || !this.#current(held, tf)) continue;
      const shown = shownCount(held.time, tf);
      held.result.candleColors.forEach((c, i) => { if (c && i < shown) out.set(held.time[i]!, safeColor(c, '')); });
    }
    this.#candleColors = out;
  }

  /**
   * Draw the scripts placed on the map (called by the map, in its plot's coordinates): the plots on the price scale at their prices, the
   * others each on a scale of their own, fitted to what is in view inside their margins, as they would be over a chart's candles.
   */
  paintOnMap(ctx: CanvasRenderingContext2D, pw: number, ph: number): void {
    this.#reportStatus();
    if (this.store.state.show.script) this.#paintMapScripts(ctx, pw, ph); else this.#host.dropUnsent();
    if (this.#panel) this.#pvFollow();
    // A row of the Scripts panel pointed at shows its script over them, whether Scripts is on or off: the examples are looked at before any is on.
    this.#paintPreview(ctx, pw, ph);
  }

  #paintMapScripts(ctx: CanvasRenderingContext2D, pw: number, ph: number): void {
    const state = this.store.state;
    // The map asks for runs too: on a phone the pane is not laid out while another tab shows, and the scripts on the map must still run.
    this.#maybeRun();
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, v = this.view, p = this.palette;
    const fallbacks = [p.vwap, p.poc, p.level, p.accent, p.bid, p.ask];
    this.#mapMarks = [];
    this.#mapDrawn = { pw, ph, scripts: new Map() };
    for (const r of this.#records) {
      if (!r.on || r.hidden || r.place !== 'map') continue;
      const held = this.#held.get(r.id);
      if (!held?.result.ok || !this.#current(held, tf) || !held.time.length) continue;
      const res = held.result, time = held.time, [from, last] = visibleRange(time, v.t0, v.t1, tf), to = Math.min(last, shownCount(time, tf) - 1);
      if (to < from) continue;
      const scales = scalesOf(res.plots.filter(pl => scaleIdOf(pl, r.options) !== 'right'), r.options, from, to);
      scales.set('right', { min: v.p0, max: v.p1, margins: { top: 0, bottom: 0 } });
      this.#mapDrawn.scripts.set(r.id, scales);
      const frame: Frame = { ctx, x: tt => v.xOf(tt, pw), barW: Math.max(1, v.xOf(tf, pw) - v.xOf(0, pw)), tf, time, from, to, top: 0, height: ph, w: pw, color: p.text, up: p.candleUp, down: p.candleDown };
      res.plots.forEach((plot, j) => {
        const s = scales.get(scaleIdOf(plot, r.options)), fallback = fallbacks[j % fallbacks.length]!;
        if (s) paintPlot({ ...frame, color: fallback, ...(plot.kind === 'mark' ? { marks: box => { this.#mapMarks.push({ box, id: r.id, name: r.name, plot, color: plotColorAt(plot, box.i, fallback, p.candleUp, p.candleDown) }); } } : {}) }, plot, s);
      });
    }
  }

  // ---- Previews: a row of the Scripts panel's list, pointed at, shows its script on the map -----------------------------------------------

  /** The previews' own worker: a preview neither waits behind the pane's runs nor takes their place, nor an agent's trials'. */
  #pvHost: ScriptHost | null = null;
  /** The preview shown (null: none), and what has been worked out for the list's rows, by what they run (`#contentKey`). */
  #pv: PreviewTarget | null = null;
  #pvCache = new Map<string, PreviewHeld>();
  /**
   * Whether a run of the previews' worker is out. One at a time, the next chosen here when it comes back (`#pvPump`): the worker's host keeps
   * one request waiting and drops it for a newer one, so a preview pointed at and the list's run asked for there would drop each other.
   */
  #pvBusy = false;
  /** Counts the panel's closings: an answer that comes after the panel closed is not kept. */
  #pvGen = 0;
  #pvTimer = 0; #pvGap = 0;
  /** The row under the pointer, the row one of whose buttons has the keyboard, and where the pointer was last seen over the list (window px). */
  #pvPointer: string | null = null; #pvFocus: string | null = null; #pvAt: { x: number; y: number } | null = null;
  /** Which preview was last drawn and when (performance.now()): for the checks that time how soon a row pointed at shows on the map. */
  previewDrawn: { key: string; at: number } | null = null;

  /**
   * Show the script of the panel's row `key` on the map (`rec:` and a script's id, `ex:` and an example's key), or none (null): at once when
   * its answer is at hand (a script that is on has its own; the list's are worked out as the panel opens), else as soon as it is worked out.
   */
  preview(key: string | null): void {
    const target = key ? this.#pvTargetOf(key) : null, was = this.#pv;
    if (target?.key === was?.key && (!target || this.#contentKey(target) === this.#contentKey(was!))) return;
    this.#pv = target;
    this.#pvPump();
    this.onMapChanged();
  }

  /** The list's rows as previews: the person's scripts, then the examples. */
  #pvTargets(): PreviewTarget[] { return [...this.#records.map(r => this.#recordTarget(r)), ...examples().map(ex => this.#exampleTarget(ex))]; }
  #pvTargetOf(key: string): PreviewTarget | null {
    if (key.startsWith('rec:')) { const r = this.#records.find(x => x.id === key.slice(4)); return r ? this.#recordTarget(r) : null; }
    if (key.startsWith('ex:')) { const ex = examples().find(x => x.key === key.slice(3)); return ex ? this.#exampleTarget(ex) : null; }
    return null;
  }
  #recordTarget(r: ScriptRecord): PreviewTarget {
    let ck = this.#pvKeys.get(r);
    if (ck === undefined) { ck = this.#joinKey(r.api, r.options, r.source); this.#pvKeys.set(r, ck); }
    return { key: `rec:${r.id}`, name: r.name, source: r.source, options: r.options, api: r.api, place: r.place, height: r.height, id: r.id, ck };
  }
  #exampleTarget(ex: ReturnType<typeof examples>[number]): PreviewTarget {
    let ck = this.#pvExampleKeys.get(ex.source);
    if (ck === undefined) { ck = this.#joinKey(SCRIPT_API, {}, ex.source); this.#pvExampleKeys.set(ex.source, ck); }
    return { key: `ex:${ex.key}`, name: ex.name, source: ex.source, options: {}, api: SCRIPT_API, place: ex.place ?? 'pane', height: exampleHeight(ex.source) ?? ROW_DEFAULT, id: null, ck };
  }
  /** What a script runs, as the worker tells one from another: its language version, its options and its text. */
  #joinKey(api: number, options: Readonly<Record<string, OptionValue>>, source: string): string { return `${api}\u0001${JSON.stringify(options)}\u0001${source}`; }
  /**
   * The same, made once for each record (records are replaced, never changed) and each example and kept, so a look at the list does not
   * join and hash every script's text again (a key used again is hashed once); and the id each runs under in the worker (`#pvIdOf`).
   */
  #pvKeys = new WeakMap<ScriptRecord, string>();
  #pvExampleKeys = new Map<string, string>();
  #pvIds = new Map<string, string>();
  #contentKey(target: PreviewTarget): string { return target.ck; }
  /** The id a script runs under in the previews' worker: one of its own text, so the worker keeps what it read of it while it is shown again. */
  #pvIdOf(key: string): string {
    let id = this.#pvIds.get(key);
    if (id === undefined) { if (this.#pvIds.size >= 64) this.#pvIds.clear(); id = `preview-${fingerprint(key)}`; this.#pvIds.set(key, id); }
    return id;
  }

  /** The answer of one of the person's scripts that is on, for the chart as it is (Scripts on): its preview needs no run of its own. */
  #pvOwn(target: PreviewTarget): Held | null {
    if (!target.id || !this.store.state.show.script || !this.#records.some(r => r.id === target.id && r.on)) return null;
    const held = this.#held.get(target.id);
    return held?.result.ok && this.#current(held, TIMEFRAMES[this.store.state.timeframe] ?? 3_600_000) ? held : null;
  }
  /** Whether a preview was worked out for the chart as it is (its timeframe, its market, in a replay its moment) in the colours it is drawn in. */
  #pvCurrent(held: PreviewHeld): boolean { return held.theme === this.#theme && this.#current(held, TIMEFRAMES[this.store.state.timeframe] ?? 3_600_000); }
  /** What a preview draws: the script's own answer when it is on, else the one worked out for it if it is for the chart as it is; null while there is none. */
  #pvShown(target: PreviewTarget): Held | null {
    const kept = this.#pvCache.get(this.#contentKey(target));
    return this.#pvOwn(target) ?? (kept && this.#pvCurrent(kept) ? kept : null);
  }
  /** The markets a preview reads over, as the page has them: the scope and the venues switched off, and the markets it lists. */
  #pvMarkets(): Pick<PreviewHeld, 'scope' | 'markets'> { const s = this.store.state; return { scope: `${s.scope}|${s.disabledVenues.join(',')}`, markets: s.markets }; }
  /**
   * Whether `target` has no preview worth drawing as it is: none for the chart as it is, or one worked out over other markets (Spot, Perp,
   * venues switched; drawn until the new one comes, as a run's answer is). Not a script that is on (its own answer is drawn).
   */
  #pvMissing(target: PreviewTarget): boolean {
    if (this.#pvOwn(target)) return false;
    const had = this.#pvCache.get(this.#contentKey(target)), m = this.#pvMarkets();
    return !had || !this.#pvCurrent(had) || had.scope !== m.scope || had.markets !== m.markets;
  }
  /**
   * How long until the preview shown is worked out again (0: now): at once when it is missing; once the page holds more of what it reads
   * (the newest candles, the depth bands filling in back in time), a second after it came back; at the pane's refresh otherwise. Never sooner
   * than four times its run after it came back, as the pane paces a slow script, so a heavy one cannot keep the worker busy.
   */
  #pvDueIn(target: PreviewTarget): number {
    if (this.#pvOwn(target)) return Infinity;
    const had = this.#pvCache.get(this.#contentKey(target));
    if (!had || this.#pvMissing(target)) return 0;
    return Math.max(0, Math.max(had.data === this.#data.version ? REFRESH : PREVIEW_DATA_MS, 4 * had.took) - (Date.now() - had.ranAt));
  }

  /**
   * The chart's candles as they stood when a look wanted a run and found none to run over (null: it did not): the map's frames look again
   * once they change (`#pvFollow`), not at every frame (a replay held before its first candle closed keeps none for as long as it is held).
   */
  #pvWaitFor: readonly unknown[] | null = null;
  /** What decides whether the chart has candles to run over: its timeframe, its candles' own, the rows the scripts read, a replay's candle. */
  #pvCandles(): readonly unknown[] { const s = this.store.state; return [s.timeframe, s.candlesTimeframe, this.candlesOf(s), replayKey(TIMEFRAMES[s.timeframe] ?? 3_600_000)]; }
  /**
   * Start the next run of the previews' worker, unless one is out: the preview shown when it is due; else, while the panel's list shows,
   * every row whose preview is missing, in one run (not those that read the order book: each would start reading it; they run when pointed
   * at). A preview shown that is fresh is looked at again when it will not be. Called when what is shown, the list, the chart or what the
   * page holds changes, and when a run comes back.
   */
  #pvPump(): void {
    window.clearTimeout(this.#pvTimer); this.#pvTimer = 0;
    this.#pvWaitFor = null;
    if (this.#pvBusy) return;
    const shown = this.#pv, wait = shown ? this.#pvDueIn(shown) : Infinity;
    const start = (targets: readonly PreviewTarget[]): boolean => { const r = this.#pvRun(targets); if (r === 'no-candles') this.#pvWaitFor = this.#pvCandles(); return r === 'started'; };
    if (shown && wait === 0 && start([shown])) return;
    if (this.#panel && !this.#ui.editing) {
      const want = this.#pvTargets().filter(target => { const a = this.#analyze(target.source); return 'program' in a && !a.inputs.has('depth') && this.#pvMissing(target); });
      if (want.length && start(want)) return;
    }
    if (shown && wait > 0 && wait < Infinity) this.#pvTimer = window.setTimeout(() => { this.#pvTimer = 0; this.#pvPump(); }, wait);
  }

  /**
   * Work out the previews of `targets` in one run of the previews' worker, over what the pane's runs read (a script that does not read, or
   * is for a newer page, shows nothing). Kept by what each runs; drawn if it is the one shown. Whether it started, or why not: none of them
   * can run, or the chart has no candles to run them over yet.
   */
  #pvRun(targets: readonly PreviewTarget[]): 'started' | 'nothing' | 'no-candles' {
    const state = this.store.state, filters = new Map<string, SourceFilter>([['', {}]]), ids = new Set<string>();
    const jobs: { key: string; id: string; target: PreviewTarget; a: Analysis }[] = [];
    for (const target of targets) {
      // Each under its id (`#pvIdOf`); two texts that make the same id in one run: the second waits until it is pointed at.
      const key = this.#contentKey(target), id = this.#pvIdOf(key);
      if (target.api > SCRIPT_API || ids.has(id)) continue;
      const a = this.#analyze(target.source);
      if (!('program' in a)) continue;
      for (const [k, f] of sourcesWith(a, target.options)) filters.set(k, f);
      ids.add(id); jobs.push({ key, id, target, a });
    }
    if (!jobs.length) return 'nothing';
    const inputs = this.#withTheme(this.#data.inputs(state, filters, jobs.some(j => j.a.inputs.has('oichg')), jobs.some(j => readsFlow(j.a)), this.candlesOf(state), jobs.some(j => readsLiquidations(j.a))));
    if (!inputs) return 'no-candles';
    const host = this.#pvHost ??= new ScriptHost({ spawn: spawnScriptWorker });
    const depth = jobs.some(j => j.a.inputs.has('depth')) ? this.#data.depth.sync(state, inputs.time, inputs.tf) : null;
    if (depth) this.#data.depth.deliver(host);
    // Taken before the run, which hands the inputs' arrays over to the worker and leaves them empty here.
    const ran: Omit<PreviewHeld, 'result' | 'ranAt' | 'took'> = { time: inputs.time.slice(), tf: inputs.tf, inst: state.seriesInstrument, at: replaying() ? pageNow() : Infinity, theme: this.#theme, ...this.#pvMarkets(), data: this.#data.version };
    const gen = this.#pvGen;
    this.#pvBusy = true;
    void host.run(jobs.map(j => ({ id: j.id, source: j.target.source, options: j.target.options, api: j.target.api })), inputs, depth ?? undefined).then(({ results, ms, depthBehind }) => {
      this.#pvBusy = false;
      if (gen === this.#pvGen) {
        // A worker that did not hold the order book it was told of read none: it is sent everything next time, and those answers are kept as
        // if the page held more since (worked out again a second later, not at once).
        if (depthBehind) this.#data.depth.forget(host);
        const back = Date.now();
        results.forEach((result, k) => { const j = jobs[k]; if (j) this.#pvCache.set(j.key, { ...ran, ...(depthBehind && j.a.inputs.has('depth') ? { data: -1 } : {}), ranAt: back, took: ms, result }); });
        const shown = this.#pv;
        if (shown && jobs.some(j => j.key === this.#contentKey(shown))) this.onMapChanged();
      }
      this.#pvPump();
    });
    return 'started';
  }

  /**
   * What the list's previews were last looked at for while the panel is open: when the chart (its timeframe, market, theme, its candles'
   * timeframe, a replay) or its markets change, or the candles a look found none of change (`#pvWaitFor`), they are looked at again, just
   * after the map's frame (what they read is not gathered inside a drawing).
   */
  #pvChart = ''; #pvChartMarkets: unknown = null; #pvFollowing = 0;
  #pvFollow(): void {
    const s = this.store.state, chart = `${s.timeframe}|${s.candlesTimeframe ?? ''}|${s.seriesInstrument}|${this.#theme}|${replaying() ? 'replay' : 'live'}|${this.#pvMarkets().scope}`;
    const waited = this.#pvWaitFor, landed = waited !== null && this.#pvCandles().some((v, i) => v !== waited[i]);
    if ((chart === this.#pvChart && s.markets === this.#pvChartMarkets && !landed) || this.#pvFollowing) return;
    this.#pvChart = chart; this.#pvChartMarkets = s.markets;
    this.#pvFollowing = window.setTimeout(() => { this.#pvFollowing = 0; if (this.#panel) this.#pvPump(); }, 0);
  }

  /** The row whose script the map shows now (null: none), and the markets its answer was worked out over ('own': the script's own answer), for checks. */
  get previewShown(): string | null { return this.#pv && this.#pvShown(this.#pv) ? this.#pv.key : null; }
  get previewScope(): string | null { const pv = this.#pv; return !pv ? null : this.#pvOwn(pv) ? 'own' : this.#pvCache.get(this.#contentKey(pv))?.scope ?? null; }

  /** The preview shown: the row under the pointer, else the one with the keyboard; none while a script is being written. */
  #pvShow(): void { this.preview(this.#ui.editing ? null : this.#pvPointer ?? this.#pvFocus); }

  /**
   * The list's rows show their scripts while the pointer is on them (a mouse's or a pen's: a finger has no pointing), or while one of their
   * buttons has the keyboard. The panel's body stays while it is open (its rows are built again in it), so it is listened to once.
   */
  #pvWire(panel: Panel): void {
    const body = panel.body;
    (this.#pvHost ??= new ScriptHost({ spawn: spawnScriptWorker })).warm();
    body.addEventListener('pointerover', e => {
      if (e.pointerType === 'touch') return;
      this.#pvAt = { x: e.clientX, y: e.clientY };
      const key = rowKeyOf(e.target);
      window.clearTimeout(this.#pvGap); this.#pvGap = 0;
      if (key || !this.#pvPointer) { this.#pvPointer = key; this.#pvShow(); return; }
      // Between two rows (their gap, a heading): the preview stays a moment, so a pointer going down the list does not make the map blink.
      this.#pvGap = window.setTimeout(() => { this.#pvGap = 0; this.#pvPointer = null; this.#pvShow(); }, PREVIEW_GAP_MS);
    });
    body.addEventListener('pointermove', e => { if (e.pointerType !== 'touch') this.#pvAt = { x: e.clientX, y: e.clientY }; });
    body.addEventListener('pointerleave', e => { if (e.pointerType === 'touch') return; window.clearTimeout(this.#pvGap); this.#pvGap = 0; this.#pvAt = null; this.#pvPointer = null; this.#pvShow(); });
    body.addEventListener('focusin', e => { const at = e.target; this.#pvFocus = at instanceof HTMLElement && at.matches(':focus-visible') ? rowKeyOf(at) : null; this.#pvShow(); });
    body.addEventListener('focusout', e => { if (!(e.relatedTarget instanceof Node && body.contains(e.relatedTarget))) { this.#pvFocus = null; this.#pvShow(); } });
  }

  /** The list was built again (under a pointer that may not move): the rows under the pointer and with the keyboard are found again, and the list's previews worked out. */
  #pvAfterBuild(): void {
    const panel = this.#panel; if (!panel) return;
    const at = this.#pvAt, under = at ? document.elementFromPoint(at.x, at.y) : null, active = document.activeElement;
    this.#pvPointer = under && panel.body.contains(under) ? rowKeyOf(under) : null;
    this.#pvFocus = active instanceof HTMLElement && panel.body.contains(active) && active.matches(':focus-visible') ? rowKeyOf(active) : null;
    this.#pvShow();
    this.#pvPump();
  }

  /**
   * The panel closed: no preview, nothing kept of the list's (an opening works them out again), and an answer still on its way is let go
   * (a run out still holds the worker until it comes back; the next opening's runs wait for it).
   */
  #pvEnd(): void {
    window.clearTimeout(this.#pvTimer); this.#pvTimer = 0; window.clearTimeout(this.#pvGap); this.#pvGap = 0; window.clearTimeout(this.#pvFollowing); this.#pvFollowing = 0;
    this.#pvGen++; this.#pvCache.clear(); this.#pvChart = ''; this.#pvChartMarkets = null; this.#pvWaitFor = null;
    this.#pvPointer = null; this.#pvFocus = null; this.#pvAt = null;
    this.#pvHost?.dropUnsent();
    if (this.#pv) { this.#pv = null; this.onMapChanged(); }
  }

  /**
   * Draw the preview shown over the map, in its plot's coordinates: the map stepped back under a plate of the page's colour, then the script
   * as it would be drawn, on the map at its prices (named in the map's legend, `mapLegend`), or in a band at the map's foot as in a row of its
   * own, named at its top.
   */
  #paintPreview(ctx: CanvasRenderingContext2D, pw: number, ph: number): void {
    const target = this.#pv; if (!target) return;
    const held = this.#pvShown(target);
    if (!held?.result.ok || !held.time.length) return;
    const res = held.result, v = this.view, p = this.palette, tf = held.tf, fallbacks = [p.vwap, p.poc, p.level, p.accent, p.bid, p.ask];
    const [from, last] = visibleRange(held.time, v.t0, v.t1, tf), to = Math.min(last, shownCount(held.time, tf) - 1);
    const band = target.place === 'pane' ? Math.round(Math.max(Math.min(PREVIEW_BAND_MIN, ph), Math.min(target.height, ph * PREVIEW_BAND_SHARE))) : 0, top = band ? ph - band : 0;
    ctx.save();
    ctx.globalAlpha = PREVIEW_DIM; ctx.fillStyle = p.bg; ctx.fillRect(0, 0, pw, ph); ctx.globalAlpha = 1;
    if (band) {
      ctx.globalAlpha = 0.9; ctx.fillStyle = p.bg; ctx.fillRect(0, top, pw, band); ctx.globalAlpha = 1;
      ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(pw, top + 0.5); ctx.stroke();
      ctx.beginPath(); ctx.rect(0, top, pw, band); ctx.clip();
    }
    if (to >= from) {
      const frame: Frame = { ctx, x: tt => v.xOf(tt, pw), barW: Math.max(1, v.xOf(tf, pw) - v.xOf(0, pw)), tf, time: held.time, from, to, top, height: band || ph, w: pw, color: p.text, up: p.candleUp, down: p.candleDown };
      // In a band each scale is fitted to what is in view, as in a row; on the map the price scale is the map's.
      const scales = scalesOf(band ? res.plots : res.plots.filter(pl => scaleIdOf(pl, target.options) !== 'right'), target.options, from, to);
      if (!band) scales.set('right', { min: v.p0, max: v.p1, margins: { top: 0, bottom: 0 } });
      res.plots.forEach((plot, j) => { const s = scales.get(scaleIdOf(plot, target.options)); if (s) paintPlot({ ...frame, color: fallbacks[j % fallbacks.length]! }, plot, s); });
      // A band's highest and lowest in view at its right edge, as a row has them.
      const first = band ? scales.values().next().value : undefined;
      if (first) {
        ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = p.muted;
        ctx.fillText(shortNumber(first.max), pw - 4, Math.max(top + 8, yOf(first.max, first, top, band)));
        ctx.fillText(shortNumber(first.min), pw - 4, Math.min(top + band - 8, yOf(first.min, first, top, band)));
      }
    }
    // A band's name on a faint plate at its top, as a row's is.
    if (band) {
      const text = `${target.name} · ${t('preview')}`, y = top + 9;
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const w = Math.min(pw - 8, ctx.measureText(text).width + 8);
      ctx.globalAlpha = 0.78; ctx.fillStyle = p.bg; ctx.fillRect(2, y - 7, w, 14); ctx.globalAlpha = 1;
      ctx.fillStyle = p.text; ctx.fillText(text, 6, y);
    }
    ctx.restore();
    this.previewDrawn = { key: target.key, at: performance.now() };
  }

  /**
   * The popup of the mark under the pointer on the map (`x`, `y` in the map's plot, as it was last drawn), with its colour for the box's edge
   * and its first line; null where there is none.
   */
  mapMarkAt(x: number, y: number, touch: boolean): { lines: InfoLine[]; color: string; box: { x: number; y: number; w: number; h: number } } | null {
    if (!this.store.state.show.script) return null;
    const m = markAt(this.#mapMarks, x, y, touch ? MARK_SLOP_TOUCH : MARK_SLOP);
    return m ? { lines: markLines(m), color: m.color, box: m.box } : null;
  }

  /**
   * The map's popup lines for the scripts drawn on it that the pointer is on (`at` its time, `y` its height in the map's plot, as the map was
   * last drawn): each one's name, then its plots' values at that candle. Anywhere else on the map a script says nothing, so the popup there
   * stays about what the pointer is over.
   */
  mapHoverLines(at: number, y: number, touch: boolean): InfoLine[] {
    const state = this.store.state, out: InfoLine[] = [];
    if (!state.show.script) return out;
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, { pw, ph, scripts } = this.#mapDrawn, v = this.view, px = v.xOf(at, pw);
    const frame = { x: (tt: number) => v.xOf(tt, pw), barW: Math.max(1, v.xOf(tf, pw) - v.xOf(0, pw)), top: 0, height: ph };
    for (const r of this.#records) {
      if (!r.on || r.hidden || r.place !== 'map') continue;
      const held = this.#held.get(r.id), scales = scripts.get(r.id);
      if (!held?.result.ok || !this.#current(held, tf) || !scales) continue;
      const shown = shownCount(held.time, tf), i = indexAt(held.time, tf, at, shown);
      const res = held.result, slop = touch ? MARK_SLOP_TOUCH + 4 : MARK_SLOP + 2;
      const on = res.plots.some(plot => { const s = scales.get(scaleIdOf(plot, r.options)); return !!s && onPlot(plot, s, { ...frame, time: held.time }, i, px, y, slop); });
      if (on) this.#cardLines(out, r, res, held.time, tf, at, shown, false, true);
    }
    return out;
  }

  /** The popup lines of one script at the candle under the pointer: (the candle's time, first,) its name, then each plot's value there. */
  #cardLines(out: InfoLine[], r: ScriptRecord, res: Extract<ScriptResult, { ok: true }>, time: Float64Array, tf: number, at: number, shown: number, withTime = true, onMap = false): void {
    const i = indexAt(time, tf, at, shown);
    if (i < 0) return;
    if (withTime && !out.length) out.push({ text: clock(time[i]!, true), bold: true });
    out.push({ text: r.name, bold: true, rule: true });
    // A band coloured point by point (a heat map's row) is read by its colour: its bounds say nothing, so it is left out beside plots that
    // carry values. At most a few plots are listed; the others are counted.
    const band = (plot: PlotOut): boolean => (plot.kind === 'brokenarea' || plot.kind === 'cloudarea') && plot.colors !== null;
    // A plot carries values only where it has one here: a line an option left unrun does not hide the bands.
    const valued = res.plots.some(plot => plot.style.visible !== false && !band(plot) && PLOT_FIELDS[plot.kind].some(f => Number.isFinite(plot.fields[f]![i]!)));
    let listed = 0, more = 0;
    res.plots.forEach((plot, j) => {
      if (plot.style.visible === false || (valued && band(plot))) return;
      // A mark reads as its text (its tip is for the mark itself, under the pointer).
      if (plot.kind === 'mark') {
        const said = markText(plot, i);
        if (!said) return;
        if (listed >= CARD_PLOTS) { more++; return; }
        listed++;
        out.push({ label: plot.title || `${plot.kind} ${j + 1}`, text: said });
        return;
      }
      const values = PLOT_FIELDS[plot.kind].map(f => plot.fields[f]![i]!);
      if (!values.some(Number.isFinite)) return;
      // On the map a plot on the price scale is a price, written as the price axis writes one; the others are amounts.
      const fmt = onMap && scaleIdOf(plot, r.options) === 'right' ? (v: number) => fmtPrice(v) : shortNumber;
      const text = values.length === 1 ? fmt(values[0]!) : values.map(fmt).join(plot.kind === 'cloudarea' || plot.kind === 'brokenarea' ? ' – ' : ' / ');
      if (listed >= CARD_PLOTS) { more++; return; }
      listed++;
      out.push({ label: plot.title || `${plot.kind} ${j + 1}`, text, color: values.length === 1 && values[0]! < 0 ? 'sell' : 'text' });
    });
    if (more) out.push({ text: tn(more, '+{n} more plot', '+{n} more plots'), color: 'muted' });
  }
}
