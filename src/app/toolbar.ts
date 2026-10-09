import { TIMEFRAMES } from './hub.ts';
import { PALETTES, THEME_ORDER } from './theme.ts';
import { AVAILABLE_LAYERS, type Store, type AppState, type Layer } from './store.ts';
import { VPN_HINT, VenueNotice, blockedVenues, idleText, idleVenues } from './venue-notice.ts';
import type { VenueEntry } from './source.ts';
import { usd, zoneName } from './format.ts';
import { venueLabel } from './panes/ladder-pane.ts';
import { el } from './dom.ts';
import { lazy } from './lazy.ts';
import { setTip } from './tip.ts';
import { InstallButton } from './install.ts';
import { toggleAuthor } from './author.ts';
import { HELP, helpButton, showGuide, type HelpId } from './help.ts';
import { openVenueDialog } from './venue-dialog.ts';
import type { VenueControl } from './source.ts';
import { coverage } from './panes/levels-data.ts';
import { SCOPE_OPTIONS, chipClick, heatmapSourceOf, kindOf, scopeCounts, scopedOut } from './scope.ts';
import { HIGHLIGHT_LIMITS } from './anomaly.ts';
import { rangeRow, switchRow, note, togglePanel, checkRow, heading, selectRow, numberRow } from './ui.ts';
import { ABSORPTION_LIMITS, type AbsorptionSettings } from './absorption.ts';
import { BUBBLE_LIMITS, BUBBLE_MINIMUMS, type BubbleSettings } from './prints.ts';
import { INLINE_CHIPS, chipPlan, exchangeGroups } from './chips.ts';
import { openMenu } from './menu.ts';
import { buildSoundPanel } from './sound/panel.ts';
import type { Sounds } from './sound/sounds.ts';
import type { Alerts } from './sound/alerts.ts';
import type { Panel } from './ui.ts';
import { HEAT_STYLES, legendBackground, type HeatStyleId } from './heatmap/lut.ts';
import { CONTRAST } from './heatmap/window.ts';
import { compactBar, onLayoutMode } from './device.ts';
import { openSheet, type Sheet } from './sheet.ts';
import { wakeLockSupported } from './wake.ts';
import { LANGUAGES, language, pickLanguage, saveLanguage, savedLanguage } from './i18n.ts';
import { t, tn } from './i18n.ts';
import { coinChoice, currentCoin, scaledUsd, unscaledUsd } from './coin.ts';
import { buildTradedPanel } from './traded/panel.ts';
import { gridStepFor } from '../shared/grid.ts';

/** How a timeframe is said in a tooltip. */
const TIMEFRAME_NAMES: Readonly<Record<string, string>> = { '1m': t('1-minute'), '5m': t('5-minute'), '15m': t('15-minute'), '30m': t('30-minute'), '1h': t('1-hour'), '4h': t('4-hour'), '1d': t('Daily') };
/** Why the Spot or Perp filter hides a venue, in the words for that venue's kind (a venue of the other kind, or one that is neither). */
function hiddenByFilter(venue: string, kind: 'spot' | 'perp' | null, scope: string): string {
  const back = scope === 'spot';
  if (kind === 'perp' && back) return t('{venue} is a perpetual venue, so the Spot filter hides it. Click to show it: the filter goes back to Both.', { venue });
  if (kind === 'spot') return t('{venue} is a spot venue, so the Perp filter hides it. Click to show it: the filter goes back to Both.', { venue });
  return back ? t('{venue} is an unclassified venue, so the Spot filter hides it. Click to show it: the filter goes back to Both.', { venue }) : t('{venue} is an unclassified venue, so the Perp filter hides it. Click to show it: the filter goes back to Both.', { venue });
}
const LAYERS: [Layer, string][] = [['liquidity', t('Liquidity')], ['liquidation', t('Liquidation')], ['stopLoss', t('Stop loss')], ['takeProfit', t('Take profit')]];
/** A chosen venue that has no book for this long gets a chip saying so (a start-up that is merely slow does not). */
const IDLE_GRACE_MS = 20_000;
/** What the dropdown says next to a layer that cannot be chosen yet. */
const UPCOMING = 'upcoming';

/** The pane switches in the top bar, in order: the two side columns first (they vanish and return at once), then what the map shows. */
const PANE_TOGGLES: readonly (readonly [keyof AppState['show'], string])[] = [['cvd', t('Flow')], ['book', t('Book')], ['profile', t('Profile')], ['depth', t('Depth')], ['oi', 'OI'], ['candles', t('Candles')], ['footprint', t('Footprint')], ['lt', 'LT'], ['mirror', t('Mirror')], ['volume', t('Volume')]];

/** Assign a form control's value only when it differs: assigning to an open select closes its popup. */
function setValue(control: HTMLSelectElement | HTMLInputElement, value: string): void { if (control.value !== value) control.value = value; }

/** Light or dim a button's lamp (`.led-btn`): it says whether the feature the button opens is on. Written only when it changes. */
function lamp(button: HTMLElement, on: boolean): void { const state = on ? 'on' : 'off'; if (button.dataset.state !== state) button.dataset.state = state; }

/** Top bar: market, timeframe, layer, pane toggles, heatmap colour, venues, theme. */
export class Toolbar {
  readonly root = el('header', { class: 'toolbar' });
  /** The coin every view shows; choosing another loads the page again for it (app/coin.ts). */
  #coin = el('button', { type: 'button', class: 'coin-btn', textContent: currentCoin().coin, ariaLabel: t('Coin'), tip: t('Coin: which coin every view shows. Choosing another loads the page again for it.'), onclick: () => { void lazy(() => import('./coin-dialog.ts')).then(m => m?.openCoinDialog()); } });
  /** Says once why the page is on BTC when another coin was asked for. */
  #coinNotice = el('div', { class: 'notice', role: 'status', hidden: true });
  #market = el('select', { class: 'market', ariaLabel: t('Market'), tip: t("Market: whose candles, footprint and open interest the chart shows. The heatmap always combines every enabled venue's book, whatever is chosen here.") });
  #timeframes = el('div', { class: 'seg' });
  #layer = el('select', { ariaLabel: t('Layer'), tip: t('Layer drawn on the map. Liquidity is the order-book heatmap; liquidation, stop-loss and take-profit layers are upcoming (they need data a static page cannot hold a key for).') });
  #toggles = el('div', { class: 'seg toggles' });
  #chips = el('div', { class: 'chips' });
  /** Venues this location cannot reach, beside the live ones, so their absence is explained where it is noticed. */
  #blocked = el('div', { class: 'chips blocked-chips' });
  readonly #notice = new VenueNotice();
  readonly #install = new InstallButton();
  #guide = el('button', { type: 'button', class: 'guide-btn', textContent: t('Guide'), tip: t('A ten-minute tour of what everything is and how to use it, with moving pictures. Every button also explains itself on hover.'), onclick: () => { showGuide(); } });
  #shot = el('button', { type: 'button', class: 'icon-btn', ariaLabel: t('Screenshot'), tip: t('Take a picture of the chart (keyboard: S): select an area or click a pane, draw on it, hide anything private with pixelate or blur, then copy or save it.'), onclick: () => { void lazy(() => import('./screenshot/editor.ts')).then(m => m?.startScreenshot()); } });
  #author = el('button', { type: 'button', textContent: t('Author'), tip: t('Who made this, and where to find the code. Free, no sign-ups, open source.') });
  #scope = el('div', { class: 'seg scope', tip: t('Which markets the liquidity views draw. A filter on the enabled venues: it never switches a venue on or off.') });
  #soundButton = el('button', { class: 'led-btn sound-btn', textContent: t('Sound'), tip: t('Sound notifications') });
  #soundPanel: Panel | null = null;
  #sounds: Sounds | null = null;
  /** Where the language and theme buttons live on a desktop screen (the status bar), or null. */
  #statusHost: HTMLElement | null = null;
  #venueMenu: Panel | null = null;
  #alerts: Alerts | null = null;
  /**
   * The features that are switched on and set in a panel: one button each, whose lamp (`.led-btn`) is lit while the feature is on. Trades
   * and Absorption mark market orders on the map, Highlights and Sound point out what is unusual, so they stand in those pairs.
   */
  #trades = el('button', { class: 'led-btn', textContent: t('Trades'), tip: HELP.bubbles.tip });
  #absorption = el('button', { class: 'led-btn', textContent: t('Absorption'), tip: HELP.absorption.tip });
  #highlights = el('button', { class: 'led-btn', textContent: t('Highlights'), tip: t('What stands out: unusual volume, open-interest changes and depth imbalance') });
  /** The volume profile: the traded-volume column beside the book profile and the point-of-control lines on the chart, set in its panel (traded/panel.ts). */
  #traded = el('button', { class: 'led-btn', textContent: t('Volume profile'), tip: HELP.traded.tip });
  #tradedPanel: Panel | null = null;
  /** The Range tool: lit while it is armed or a selection is shown (range/tool.ts). */
  #range = el('button', { class: 'led-btn', textContent: t('Range'), tip: HELP.range.tip });
  onRange: () => void = () => {};
  /**
   * The same tool from the map's own corner, beside Recenter, where a person looking at the map finds it (the toolbar's Range button is easy to
   * miss). Its lamp follows the toolbar's.
   */
  #rangeCorner = el('button', { type: 'button', class: 'led-btn map-select', ariaLabel: t('Select an area'), tip: t('Select an area and add up what traded there: drag across the map for a box, or across a pane under it for a stretch of time. Ctrl+drag (Cmd on a Mac) selects at any time.') },
    el('i', { class: 'select-glyph', ariaHidden: 'true' }), t('Select'));
  /** The map's top-right corner: Select and Recenter, side by side. */
  #mapTools = el('div', { class: 'map-tools' });
  /** The Range button, which its panel opens beside. */
  get rangeButton(): HTMLElement { return this.#range; }
  /** The show/hide buttons of the panes, in the order of `PANE_TOGGLES`. */
  #toggleButtons: HTMLButtonElement[] = [];
  #tradePanel: Panel | null = null;
  #absorptionPanel: Panel | null = null;
  /** The threshold each venue is judged at now, in words (set by the page, which knows the venues and the recorded minutes). */
  absorptionInfo: () => string = () => '';
  #heat = {
    style: el('select', { ariaLabel: t('Colours'), tip: `${t('Heatmap colouring.')} ${HEAT_STYLES.map(s => `${s.label}: ${s.title}.`).join(' ')}` }),
    lo: el('i'), hi: el('i'), legend: el('span', { class: 'legend' }),
    contrast: el('input', { type: 'range', min: String(CONTRAST.min), max: String(CONTRAST.max), step: '1', tip: t('Contrast: right reveals thinner liquidity, left keeps only the biggest walls, and the far left tones even those down. Double-click to reset.') }),
    smooth: el('select', { ariaLabel: t('Smoothing'), tip: t('Vertical smoothing when price rows get thin (zoomed out): Auto smooths with a ~5 px Gaussian below 15 px per row, as Bookmap does, so far walls stay visible; Off draws every row exactly.') }),
    auto: el('button', { class: 'led-btn', textContent: t('Auto'), tip: t('Auto: the colour window follows the data (recomputed on recenter, market change, zoom and every 10 s). Off: it stays where it is.') }),
  };
  #source = el('select', { ariaLabel: t('Source'), tip: t('Heatmap source') });
  #theme = el('button', { class: 'theme-btn', tip: t('Theme: hover to preview, click to keep') });
  /** The page's language: the code of the one in use, and a menu of the others (a language is chosen before the page is built, so choosing one reloads it). */
  /** Which clock the page's times are on: UTC, or the computer's own. */
  #zone = el('button', { class: 'zone-btn' });
  #language = el('button', { class: 'language-btn', ariaLabel: t('Language'), tip: t('Language: the page uses the language of your browser unless you choose another here') }, el('span', { textContent: language().toUpperCase() }));
  #status = el('span', { class: 'status', tip: t('Connection to the data source: live when frames are arriving.') });
  #brand = el('span', { class: 'brand', textContent: 'LiquidityMapperFast' });
  #venuesButton: HTMLElement | null = null;
  /** The venues the source last reported, and the ones with a book on the map (chips for chosen venues that have none say why). */
  #entries: readonly VenueEntry[] = [];
  #drawn: ReadonlySet<string> = new Set();
  #idleSince = new Map<string, number>();
  #idleKey = '';
  #heatctl = el('span', { class: 'heatctl' });
  /** The colour ramp and the contrast slider under it: one unit, so the Settings sheet can give it a row of its own. */
  #heatScale = el('span', { class: 'scale' });
  #heatHelp = helpButton('heatmap');
  #spacer = el('span', { class: 'spacer' });
  /** Phone only: the button that opens Settings, where every control that does not fit the top bar lives. */
  #more = el('button', { type: 'button', class: 'more-btn', ariaLabel: t('Settings'), tip: t('Settings: panels, heatmap colouring, venues, sound, theme and the guide.') });
  #sheet: Sheet | null = null;
  /** Where Recenter lives on the full toolbar's screens: in a corner of the map it acts on, not among the venues (null until the map exists). */
  #mapHost: HTMLElement | null = null;
  /** Settings' "Keep screen on" switch (only where the browser can hold the screen awake). */
  #awake = el('input', { type: 'checkbox' });
  #recenter = el('button', { textContent: t('Recenter'), tip: t('Jump back to the live edge and fit the price range to the recent candles (keyboard: R, Home, or double-click the chart).') });
  onRecenter: () => void = () => {};
  /** Preview a theme without keeping it (`null` puts the saved one back). */
  onPreviewTheme: (id: string | null) => void = () => {};
  onSelectMarket: (id: string) => void = () => {};
  /** The person applied a venue selection (a server brings the new feeds up some seconds later). */
  onVenuesApplied: () => void = () => {};

  constructor(private store: Store, private venueControl: VenueControl) {
    const missing = coinChoice().notice;
    if (missing) {
      this.#coinNotice.append(el('span', { class: 'notice-mark', textContent: 'ⓘ', ariaHidden: 'true' }), el('span', { textContent: missing.reason === 'unreadable' ? t('The coin list could not be read, so only BTC is offered.') : t('{coin} is not on the coin list, so the page is on BTC.', { coin: missing.coin }) }),
        el('button', { class: 'notice-close', tip: t('Dismiss'), ariaLabel: t('Dismiss'), onclick: () => { this.#coinNotice.hidden = true; } }));
      this.#coinNotice.hidden = false;
    }
    this.#market.onchange = () => this.onSelectMarket(this.#market.value);
    for (const tf of Object.keys(TIMEFRAMES)) this.#timeframes.append(el('button', { textContent: tf, tip: t('{timeframe} candles. The footprint, the bar stats and the open-interest bars follow this too.', { timeframe: TIMEFRAME_NAMES[tf] ?? tf }), onclick: () => this.store.set({ timeframe: tf }) }));
    for (const [id, label] of LAYERS) {
      const available = AVAILABLE_LAYERS.includes(id), option = new Option(available ? label : `${label} · ${UPCOMING}`, id);
      option.disabled = !available;
      this.#layer.append(option);
    }
    this.#layer.onchange = () => this.store.set({ layer: this.#layer.value as Layer });
    for (const [key, label] of PANE_TOGGLES) {
      const button = el('button', { textContent: label, tip: HELP[key as HelpId].tip, onclick: () => this.store.set({ show: { ...this.store.state.show, [key]: !this.store.state.show[key] } }) });
      this.#toggleButtons.push(button); this.#toggles.append(button);
    }
    this.#trades.onclick = () => {
      const build = (tools: HTMLElement, body: HTMLElement): void => this.#buildTrades(tools, body, () => this.#tradePanel?.render(build));
      this.#tradePanel = togglePanel(this.#trades, { title: t('Trades'), width: 380, align: 'left', onClose: () => { this.#tradePanel = null; } }, build);
    };
    for (const [value, label] of SCOPE_OPTIONS) this.#scope.append(el('button', { textContent: label, onclick: () => this.store.set({ scope: value }) }));
    this.#soundButton.onclick = () => {
      const sounds = this.#sounds; if (!sounds) return;
      const build = (tools: HTMLElement, body: HTMLElement): void => { tools.append(helpButton('sounds')); buildSoundPanel(this.store, sounds, () => this.#soundPanel?.render(build), tools, body, this.#alerts); };
      this.#soundPanel = togglePanel(this.#soundButton, { title: t('Sounds'), width: 420, align: 'left', onClose: () => { this.#soundPanel = null; } }, build);
    };
    this.#highlights.onclick = () => { togglePanel(this.#highlights, { title: t('Highlights'), width: 380, align: 'left' }, (tools, body) => { tools.append(helpButton('highlights')); this.#buildHighlights(tools, body); }); };
    this.#traded.onclick = () => {
      const build = (tools: HTMLElement, body: HTMLElement): void => buildTradedPanel(this.store, tools, body, () => this.#tradedPanel?.render(build), () => gridStepFor(this.store.state.mark.price > 0 ? this.store.state.mark.price : 1));
      this.#tradedPanel = togglePanel(this.#traded, { title: t('Volume profile'), width: 520, align: 'left', onClose: () => { this.#tradedPanel = null; } }, build);
    };
    this.#absorption.onclick = () => {
      const build = (tools: HTMLElement, body: HTMLElement): void => this.#buildAbsorption(tools, body, () => this.#absorptionPanel?.render(build));
      this.#absorptionPanel = togglePanel(this.#absorption, { title: t('Absorption'), width: 400, align: 'left', onClose: () => { this.#absorptionPanel = null; } }, build);
    };
    for (const style of HEAT_STYLES) this.#heat.style.append(new Option(style.label, style.id));
    this.#heat.style.onchange = () => this.store.set({ heat: { ...this.store.state.heat, style: this.#heat.style.value as HeatStyleId } });
    this.#heat.contrast.oninput = () => this.store.set({ heat: { ...this.store.state.heat, contrast: Number(this.#heat.contrast.value) } });
    this.#heat.contrast.ondblclick = () => this.store.set({ heat: { ...this.store.state.heat, contrast: CONTRAST.neutral } });
    for (const [value, label] of [['auto', t('Smooth: auto')], ['off', t('Smooth: off')]] as const) this.#heat.smooth.append(new Option(label, value));
    this.#heat.smooth.onchange = () => this.store.set({ heat: { ...this.store.state.heat, smooth: this.#heat.smooth.value as 'auto' | 'off' } });
    this.#heat.auto.onclick = () => this.store.set({ heat: { ...this.store.state.heat, auto: !this.store.state.heat.auto } });
    this.#heat.legend.append(this.#heat.lo, this.#heat.hi);
    this.#source.onchange = () => this.store.set({ heatmapSource: this.#source.value });
    this.#theme.onclick = () => this.#openThemes();
    this.#language.onclick = () => this.#openLanguages();
    this.#zone.onclick = () => this.store.set({ timeZone: this.store.state.timeZone === 'utc' ? 'local' : 'utc' });
    this.#recenter.onclick = () => this.onRecenter();
    // On a phone the button is in Settings, which would cover the map the selection is dragged on.
    this.#range.onclick = () => { this.#sheet?.close(); this.onRange(); };
    this.#rangeCorner.onclick = () => this.onRange();
    this.#author.onclick = () => { toggleAuthor(this.#author); };
    this.#shot.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3V19H4z"/><circle cx="12" cy="13.4" r="3.3"/></svg>';
    this.venueControl.watch?.(entries => { this.#entries = entries; this.#notice.update(entries); this.#showIdle(this.#drawn); });
    const venues = el('button', { textContent: t('Venues'), tip: t('Choose which exchanges feed the map. The choice is kept in this browser; nothing changes until you press Apply.'), onclick: () => void openVenueDialog(this.venueControl, () => this.#selectionProduct(), () => this.onVenuesApplied()) });
    this.#heatScale.append(this.#heat.legend, this.#heat.contrast);
    this.#fillHeatControls();
    this.#more.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>';
    this.#more.onclick = () => this.#toggleSheet();
    this.#awake.onchange = () => this.store.set({ keepAwake: this.#awake.checked });
    const shoot = this.#shot.onclick;
    // The screenshot is of the page, so Settings must be out of the picture before it is taken.
    this.#shot.onclick = event => { if (!this.#sheet) { shoot?.call(this.#shot, event); return; } this.#sheet.close(); requestAnimationFrame(() => requestAnimationFrame(() => { shoot?.call(this.#shot, event); })); };
    this.#venuesButton = venues;
    this.#arrange();
    onLayoutMode(() => { this.#arrange(); });
  }

  /**
   * Put every control where the current arrangement wants it. The full toolbar is one wrapping row in its original order; the compact
   * one (a phone, or any screen a finger drives) keeps market, timeframe, status and Settings in a slim top bar and moves the rest into
   * the Settings sheet, grouped by purpose. The same elements move in both directions, so their handlers and state survive a rotation
   * or a window resize.
   */
  /** The heatmap colour controls as the desktop toolbar has them, in one group. */
  #fillHeatControls(): void { this.#heatctl.replaceChildren(this.#heatHelp, this.#heat.style, this.#heatScale, this.#heat.auto, this.#heat.smooth); }

  /** The desktop status bar takes the language and theme buttons (and the connection text) from the top bar. */
  hostStatusControls(host: HTMLElement): void { this.#statusHost = host; this.#arrange(); }

  /** Put Recenter in a corner of the map `host` (on the full toolbar; the compact bar keeps it beside the timeframes). */
  placeRecenter(host: HTMLElement): void { this.#mapHost = host; this.#arrange(); }

  #arrange(): void {
    this.#recenter.classList.toggle('map-recenter', !compactBar() && this.#mapHost !== null);
    if (!compactBar()) {
      this.#sheet?.close();
      this.#fillHeatControls();
      const inCorner = this.#mapHost !== null;
      if (inCorner) { this.#mapTools.replaceChildren(this.#rangeCorner, this.#recenter); this.#mapHost!.prepend(this.#mapTools); }
      const host = this.#statusHost;
      // With a status bar the connection state and the language and theme buttons live there.
      host?.replaceChildren(this.#zone, this.#language, this.#theme);
      this.root.replaceChildren(this.#brand, this.#coin, this.#market, this.#venuesButton!, this.#source, this.#timeframes, this.#layer, this.#toggles, this.#trades, this.#absorption, this.#traded, this.#highlights, this.#soundButton, this.#range,
        this.#heatctl, this.#scope, this.#chips, this.#blocked, ...(inCorner ? [] : [this.#recenter]), this.#spacer, this.#install.root, this.#guide, this.#shot, this.#author, ...(host ? [] : [this.#zone, this.#language, this.#theme, this.#status]), this.#notice.root, this.#coinNotice);
      return;
    }
    // A phone has Range in Settings and Recenter beside the timeframes: the map's corner stays clear.
    this.#mapTools.remove();
    this.root.replaceChildren(
      el('div', { class: 'tb-bar' },
        el('div', { class: 'tb-row tb-main' }, this.#brand, this.#coin, this.#market, this.#spacer, this.#status, this.#more),
        el('div', { class: 'tb-row tb-time' }, this.#timeframes, this.#recenter)),
      this.#notice.root, this.#coinNotice);
  }

  #toggleSheet(): void {
    if (this.#sheet) { this.#sheet.close(); return; }
    // Settings is a list of labelled rows, each control the same element the desktop toolbar holds (see #arrange).
    const field = (label: string, control: HTMLElement, stacked = false): HTMLElement => el('div', { class: stacked ? 'sheet-field stack' : 'sheet-field' }, el('span', { class: 'sheet-label', textContent: label }), control);
    const section = (title: string, children: HTMLElement[], action?: HTMLElement): HTMLElement =>
      el('section', { class: 'sheet-sec' }, el('div', { class: 'sheet-sec-head' }, el('h4', { textContent: title }), ...(action ? [action] : [])), ...children);
    // The sheet's own heading says "Venues", so the button beside it says what it does.
    this.#venuesButton!.textContent = t('Choose…');
    this.#sheet = openSheet(t('Settings'), body => {
      this.#heatctl.replaceChildren();
      body.append(
        section(t('Tools'), [el('div', { class: 'sheet-tiles' }, this.#range, this.#guide, this.#shot, this.#author, this.#install.root)]),
        section(t('Show'), [this.#toggles, el('div', { class: 'sheet-tiles' }, this.#trades, this.#absorption, this.#traded), el('p', { class: 'sheet-note', textContent: t('Depth, OI, LT and Footprint each add a tab to the bar under the map.') })]),
        section(t('Heatmap'), [
          field(t('Layer'), this.#layer), field(t('Source'), this.#source), field(t('Colours'), this.#heat.style),
          field(t('Contrast'), this.#heatScale, true), field(t('Colour range'), this.#heat.auto), field(t('Smoothing'), this.#heat.smooth)], helpButton('heatmap')),
        section(t('Venues'), [field(t('Markets'), this.#scope, true), el('div', { class: 'sheet-chips' }, this.#chips, this.#blocked)], this.#venuesButton!),
        section(t('Alerts'), [el('div', { class: 'sheet-tiles' }, this.#highlights, this.#soundButton)]),
        section(t('Appearance'), [field(t('Language'), this.#language), field(t('Theme'), this.#theme), field(t('Time zone'), this.#zone),
          ...(wakeLockSupported() ? [field(t('Keep screen on'), el('label', { class: 'switch', tip: t('Stops the screen turning off while this page is open. A screen that sleeps stops the recording, and the map then has a gap where it was.') }, this.#awake, el('i')))] : [])]));
    }, () => { this.#sheet = null; this.#more.classList.remove('open'); this.#venuesButton!.textContent = t('Venues'); });
    this.#more.classList.add('open');
  }

  /** Update controls from state; `window` is the USD range currently mapped onto the colour ramp. Only touches DOM that changed, so open dropdowns and clicks survive 4 Hz data frames. */
  sync(state: AppState, window: { lo: number; hi: number }): void {
    const instruments = state.markets.filter(m => m.instrumentId);
    const short = compactBar(), marketKey = instruments.map(m => m.instrumentId).join(',') + (short ? '|short' : '');
    if (this.#market.dataset.key !== marketKey) {
      // The phone's top bar has room for about two dozen characters, so "perpetual" becomes "perp".
      const label = (m: (typeof instruments)[number]): string => {
        const venue = venueLabel(m.instrumentId ?? ''), symbol = String(m.symbol ?? m.instrumentId);
        const kind = m.marketType === 'perpetual' ? t('perpetual') : m.marketType === 'spot' ? t('spot') : m.marketType ?? '';
        if (!short) return `${venue} · ${symbol} · ${kind}`;
        // A symbol that already says "PERP" needs no type after it.
        const type = m.marketType === 'perpetual' ? (/perp/i.test(symbol) ? '' : t('perp')) : kind;
        return [venue, symbol, type].filter(Boolean).join(' ');
      };
      this.#market.replaceChildren(...instruments.map(m => new Option(label(m), m.instrumentId)));
      this.#market.dataset.key = marketKey;
    }
    setValue(this.#market, state.marketId);
    [...this.#timeframes.children].forEach(b => b.classList.toggle('on', b.textContent === state.timeframe));
    setValue(this.#layer, state.layer);
    this.#toggleButtons.forEach((b, i) => b.classList.toggle('on', state.show[PANE_TOGGLES[i]![0]]));
    lamp(this.#heat.auto, state.heat.auto); lamp(this.#trades, state.show.bubbles); lamp(this.#absorption, state.absorption.on); lamp(this.#highlights, state.highlight.on); lamp(this.#traded, state.show.traded); lamp(this.#range, state.rangeTool || state.range !== null); lamp(this.#rangeCorner, state.rangeTool || state.range !== null);
    if (this.#awake.checked !== state.keepAwake) this.#awake.checked = state.keepAwake;
    setValue(this.#heat.smooth, state.heat.smooth);
    setValue(this.#heat.style, state.heat.style); setValue(this.#heat.contrast, String(state.heat.contrast));
    const legendKey = `${state.heat.style}|${state.theme}`;
    if (this.#heat.legend.dataset.key !== legendKey) { this.#heat.legend.dataset.key = legendKey; this.#heat.legend.style.background = legendBackground(state.heat.style, PALETTES[state.theme] ?? PALETTES.light!); }
    const lo = usd(window.lo), hi = usd(window.hi);
    if (this.#heat.lo.textContent !== lo) this.#heat.lo.textContent = lo;
    if (this.#heat.hi.textContent !== hi) this.#heat.hi.textContent = hi;
    this.#showTheme(state.theme);
    this.#showZone(state.timeZone);
    const soundState = !state.sounds.on ? 'off' : state.soundState !== 'running' ? 'locked' : 'on';
    if (this.#soundButton.dataset.state !== soundState) {
      this.#soundButton.dataset.state = soundState;
      setTip(this.#soundButton, soundState === 'off' ? t('Sound notifications: off') : soundState === 'locked' ? t('Sound is on but the browser keeps audio locked until you click or press a key on the page') : t('Sound notifications: on'));
      this.#soundPanel?.reposition();
    }
    this.#soundButton.classList.toggle('flash', state.lastSound > 0 && Date.now() - state.lastSound < 600);
    if (this.#status.textContent !== state.status) this.#status.textContent = state.status;
    const live = state.connected ? 'live' : 'down';
    if (this.#status.dataset.state !== live) this.#status.dataset.state = live;
    const books = state.levels?.books ?? [];
    const sourceKey = books.map(b => b.id).join(',') + (short ? '|short' : '');
    if (this.#source.dataset.key !== sourceKey) {
      // The phone's Settings already says "Heatmap" above this choice.
      const prefix = short ? '' : `${t('Heatmap:')} `;
      this.#source.replaceChildren(new Option(`${prefix}${short ? t('Aggregated') : t('aggregated')}`, 'aggregated'), ...books.map(b => new Option(`${prefix}${venueLabel(b.id)}`, b.id)));
      this.#source.dataset.key = sourceKey;
    }
    const shown = heatmapSourceOf(state);
    setValue(this.#source, shown);
    const venues = [...new Set(books.map(b => b.venue))];
    this.#drawn = new Set(venues); this.#showIdle(this.#drawn);
    const scoped = (v: string) => !scopedOut(state, v);
    const counts = scopeCounts(state);
    [...this.#scope.children].forEach((b, i) => { const [value] = SCOPE_OPTIONS[i]!; b.classList.toggle('on', state.scope === value); setTip(b as HTMLElement, value === 'all' ? t('Every enabled venue') : (value === 'spot' ? t('Spot venues only ({n} enabled)', { n: counts[value] }) : t('Perpetual venues only ({n} enabled)', { n: counts[value] }))); });
    this.#scope.classList.toggle('inert', shown !== 'aggregated');
    // The full bar shows a handful of chips and puts the rest in a menu; the phone's Settings sheet has room for every one.
    const plan = chipPlan(venues, compactBar() ? Infinity : INLINE_CHIPS);
    const chipOf = (v: string): HTMLElement => el('button', { class: (state.disabledVenues.includes(v) ? 'chip off' : 'chip') + (scoped(v) ? '' : ' scoped-out'), textContent: venueLabel(v), tip: t('Show / hide this venue'),
      onclick: () => this.store.set(chipClick(this.store.state, v)) });
    const chipKey = venues.map(v => v + (state.disabledVenues.includes(v) ? '-' : '+') + (scoped(v) ? 's' : 'x')).join(',') + '|' + plan.shown.length;
    if (this.#chips.dataset.key !== chipKey) {
      this.#chips.dataset.key = chipKey;
      const more = plan.more.length ? [el('button', { class: 'chip more-chip', textContent: `+${plan.more.length}`, tip: t('{n} more venues: click to show or hide each one', { n: plan.more.length }), onclick: event => this.#openVenueMenu(event.currentTarget as HTMLElement, venues) })] : [];
      this.#chips.replaceChildren(...plan.shown.map(chipOf), ...more);
      this.#venueMenu?.render((tools, body) => this.#buildVenueMenu(tools, body, venues));
    }
    setTip(this.#scope, shown === 'aggregated' ? t('Which markets the liquidity views draw (a filter on the enabled venues; it never switches one on or off)') : t('The heatmap shows a single venue, so this filter only affects the profile, depth, ladder and LT'));
    // Tooltips carry each venue's book reach, so a thin book on the map is explained by its feed.
    plan.shown.forEach((v, i) => {
      const cov = coverage(books.find(b => b.venue === v), state.mark.price);
      const kind = kindOf(state.markets, books.find(b => b.venue === v)?.id ?? '');
      const title = !scoped(v)
        ? hiddenByFilter(venueLabel(v), kind, state.scope)
        : cov ? t('{venue}: {levels} levels, reaches {bp} bp each side. Click to show / hide.', { venue: venueLabel(v), levels: cov.levels, bp: Math.round(cov.bp / 2) }) : t('Show / hide this venue');
      const chip = this.#chips.children[i] as HTMLElement | undefined;
      if (chip && chip.dataset.tip !== title) setTip(chip, title);
    });
  }

  /** Every venue that has a book, grouped by exchange, each a switch: what the chips do, for all of them at once. */
  #openVenueMenu(anchor: HTMLElement, venues: readonly string[]): void {
    this.#venueMenu = togglePanel(anchor, { title: t('Venues on the map'), width: 300, align: 'left', onClose: () => { this.#venueMenu = null; } }, (tools, body) => this.#buildVenueMenu(tools, body, venues));
  }
  #buildVenueMenu(tools: HTMLElement, body: HTMLElement, venues: readonly string[]): void {
    tools.replaceChildren(
      el('button', { type: 'button', textContent: t('All on'), tip: t('Show every venue'), onclick: () => this.store.set({ disabledVenues: [] }) }),
      el('button', { type: 'button', textContent: t('All off'), tip: t('Hide every venue'), onclick: () => this.store.set({ disabledVenues: [...venues] }) }));
    body.replaceChildren(note(t('Chips are switches: a venue that is off keeps its book but is left out of the map, the book and the flow column.')));
    for (const group of exchangeGroups(venues)) {
      body.append(heading(venueLabel(group.key)));
      for (const v of group.venues) body.append(checkRow(venueLabel(v), scopedOut(this.store.state, v) ? t('Hidden by the Spot / Perp filter') : t('Show on the map'), !this.store.state.disabledVenues.includes(v), () => { this.store.set(chipClick(this.store.state, v)); }));
    }
  }

  /**
   * Chips beside the venue chips for the venues a person chose that are not on the map: refused by this location, failing, left off the
   * map as faulty, or (after a short wait, so a normal start does not flicker) still connecting.
   */
  #showIdle(drawn: ReadonlySet<string>): void {
    const now = Date.now(), idle = idleVenues(this.#entries, drawn);
    for (const id of [...this.#idleSince.keys()]) if (!idle.some(v => v.id === id)) this.#idleSince.delete(id);
    for (const v of idle) if (!this.#idleSince.has(v.id)) this.#idleSince.set(v.id, now);
    const shown = idle.filter(v => v.kind === 'faulty' || now - (this.#idleSince.get(v.id) ?? now) >= IDLE_GRACE_MS);
    const blocked = blockedVenues(this.#entries), key = blocked.map(v => v.id).join(',') + '|' + shown.map(v => `${v.id}:${v.kind}:${v.status}`).join(',');
    if (key === this.#idleKey) return;
    this.#idleKey = key;
    this.#blocked.replaceChildren(
      ...blocked.map(v => el('span', { class: 'chip blocked', textContent: `⊘ ${v.name}`, tip: `${v.name}: ${VPN_HINT}` })),
      ...shown.map(v => el('span', { class: v.kind === 'faulty' ? 'chip blocked faulty' : 'chip blocked', textContent: `${v.kind === 'faulty' ? '⚠' : '…'} ${v.name}`, tip: idleText(v) })));
  }

  /** The sound engine the Sounds panel controls. */
  attachSounds(sounds: Sounds): void { this.#sounds = sounds; }
  attachAlerts(alerts: Alerts): void { this.#alerts = alerts; }

  /** Redraw the parts of the toolbar that depend on the palette (the legend ramp) for a previewed theme. */
  previewTheme(id: string): void {
    this.#heat.legend.dataset.key = `${this.store.state.heat.style}|${id}`;
    this.#heat.legend.style.background = legendBackground(this.store.state.heat.style, PALETTES[id] ?? PALETTES.light!);
  }
  #showTheme(id: string): void {
    const p = PALETTES[id] ?? PALETTES.light!;
    if (this.#theme.dataset.theme === id) return;
    this.#theme.dataset.theme = id;
    const swatch = el('span', { class: 'swatch' }, ...[p.bg, p.panel, p.bid, p.ask].map(color => { const dot = el('i'); dot.style.background = color; return dot; }));
    this.#theme.replaceChildren(swatch, el('span', { textContent: p.label }));
  }
  /** The zone button says the clock the page is on, and what a click does (the name of the computer's own zone is part of it). */
  #showZone(zone: AppState['timeZone']): void {
    if (this.#zone.dataset.zone === zone) return;
    this.#zone.dataset.zone = zone;
    this.#zone.textContent = zone === 'utc' ? 'UTC' : t('Local');
    setTip(this.#zone, zone === 'utc'
      ? t('Times are shown in UTC. Click to show them in your computer\'s time ({zone}).', { zone: zoneName('local') })
      : t('Times are shown in your computer\'s time ({zone}). Click to show them in UTC.', { zone: zoneName('local') }));
  }
  /** Choose the page's language, or let the browser's preference decide. The page is then built again in it. */
  #openLanguages(): void {
    const saved = savedLanguage(), codes = LANGUAGES.map(l => l.code);
    const browser = LANGUAGES.find(l => l.code === pickLanguage(navigator.languages?.length ? navigator.languages : [navigator.language], codes))?.name ?? LANGUAGES[0]!.name;
    const items = [{ id: 'auto', label: `${t('Automatic')} · ${browser}` }, ...LANGUAGES.map(l => ({ id: l.code, label: l.name }))];
    openMenu(this.#language, items, saved, {
      onPreview: () => {},
      onSelect: id => {
        if (id === saved) return;
        saveLanguage(id);
        // An address that names a language (?lang=) would override what was just chosen, so it goes.
        const url = new URL(window.location.href);
        if (url.searchParams.has('lang')) { url.searchParams.delete('lang'); window.location.replace(url); } else window.location.reload();
      },
    }, 'right', { title: t('Language') });
  }

  #openThemes(): void {
    const items = THEME_ORDER.map(id => { const p = PALETTES[id]!; return { id, label: p.label, swatch: [p.bg, p.panel, p.text, p.bid, p.ask] }; });
    openMenu(this.#theme, items, this.store.state.theme, { onPreview: id => this.onPreviewTheme(id), onSelect: id => this.store.set({ theme: id }) });
  }

  #buildHighlights(_tools: HTMLElement, body: HTMLElement): void {
    const set = (change: Partial<AppState['highlight']>) => this.store.set({ highlight: { ...this.store.state.highlight, ...change } });
    const h = this.store.state.highlight;
    body.append(
      switchRow(t('Highlight what stands out'), t('Unusual volume, open-interest changes and depth imbalance are drawn at full strength; the rest is dimmed.'), h.on, on => set({ on })),
      rangeRow(t('Sensitivity'), t('How far above its recent average something must be: lower flags more, higher flags only the extremes.'), { ...HIGHLIGHT_LIMITS.mult, value: h.mult, format: v => `${v}σ` }, mult => set({ mult })),
      rangeRow(t('Baseline'), t('How many preceding bars the average and spread are taken from.'), { ...HIGHLIGHT_LIMITS.length, value: h.length, format: v => tn(v, '{n} bar', '{n} bars') }, length => set({ length })),
      note(t('A bar is flagged when its value exceeds the mean plus the sensitivity times the standard deviation of the bars before it. The bar itself never raises its own threshold, and nothing is flagged until a dozen bars exist.')),
    );
  }

  /** The trade bubbles' settings: whether they show, the smallest order and the side drawn, their size and opacity, and size labels. */
  #buildTrades(tools: HTMLElement, body: HTMLElement, rebuild: () => void): void {
    const b = this.store.state.tradeBubbles, L = BUBBLE_LIMITS;
    tools.append(helpButton('bubbles'));
    const set = (change: Partial<BubbleSettings>): void => { this.store.set({ tradeBubbles: { ...this.store.state.tradeBubbles, ...change } }); };
    body.append(
      switchRow(t('Show trade bubbles'), t('Large market orders where they traded, the fills of one order added together.'), this.store.state.show.bubbles, on => { this.store.set({ show: { ...this.store.state.show, bubbles: on } }); rebuild(); }),
      selectRow(t('Smallest order'), t('Orders under this are not drawn. Every order from {floor} is recorded, so a lower choice brings them back.', { floor: `$${usd(scaledUsd(BUBBLE_MINIMUMS[0]!))}` }), BUBBLE_MINIMUMS.map(v => [String(v), `$${usd(scaledUsd(v))}`] as [string, string]), String(b.minUsd), v => set({ minUsd: Number(v) })),
      selectRow(t('Side'), t('Both sides, or only the market buys or only the market sells.'), [['both', t('Both')], ['buy', t('Buys only')], ['sell', t('Sells only')]], b.side, v => set({ side: v === 'buy' || v === 'sell' ? v : 'both' })),
      rangeRow(t('Bubble size'), t('Every bubble larger or smaller; their sizes keep their proportions.'), { min: L.scale.min, max: L.scale.max, step: L.scale.step, value: b.scale, format: v => `×${v.toFixed(1)}` }, scale => set({ scale })),
      rangeRow(t('Opacity'), t('How solid the bubbles are: lower lets the map and the candles show through.'), { min: L.opacity.min, max: L.opacity.max, step: L.opacity.step, value: b.opacity, format: v => `${Math.round(v * 100)}%` }, opacity => set({ opacity })),
      switchRow(t('Write the size in large bubbles'), t('Only bubbles big enough to hold the number get one, so zooming out drops them; hover or tap any bubble for its size.'), b.labels, labels => set({ labels })),
    );
    const whale = this.store.state.sounds.tiers[2]?.usd;
    if (whale) body.append(note(t('Orders from the Whale size in Sounds ({value}) get a bright ring.', { value: `$${usd(scaledUsd(whale))}` })));
    body.append(note(t('These settings change only the bubbles: sounds and the flow column\'s dots keep their own sizes.')));
  }

  /** The absorption settings: whether the marks show, how the threshold is set, and the threshold each venue is judged at now. */
  #buildAbsorption(tools: HTMLElement, body: HTMLElement, rebuild: () => void): void {
    const a = this.store.state.absorption, L = ABSORPTION_LIMITS;
    tools.append(helpButton('absorption'));
    const set = (change: Partial<AbsorptionSettings>, again = false): void => { this.store.set({ absorption: { ...this.store.state.absorption, ...change } }); if (again) rebuild(); };
    body.append(
      switchRow(t('Show absorption marks'), t('Squares where market orders of one side met resting orders at one price for more than the threshold within 10 ms.'), a.on, on => set({ on })),
      selectRow(t('Threshold'), t('Automatic follows each venue: the mean plus a number of standard deviations of its recent window sums. Fixed is one USD size for every venue.'), [['auto', t('Automatic')], ['fixed', t('Fixed size')]], a.mode, mode => set({ mode: mode === 'fixed' ? 'fixed' : 'auto' }, true)),
    );
    if (a.mode === 'auto') body.append(
      rangeRow(t('Standard deviations'), t('Higher marks fewer, only the largest. The usual setting is 10.'), { min: L.k.min, max: L.k.max, step: L.k.step, value: a.k, format: v => `${v} SD` }, k => set({ k })),
      numberRow(t('Over the last (minutes)'), t('How far back the window sums the threshold is taken from reach. The threshold is worked out again every minute.'), { min: L.sdMinutes.min, max: L.sdMinutes.max, step: 1, value: a.sdMinutes }, sdMinutes => set({ sdMinutes })),
    );
    else body.append(numberRow(t('Size (USD)'), t('A window sum at one price must reach this to be marked, on every venue.'), { min: scaledUsd(L.fixedUsd.min), step: scaledUsd(25_000), value: scaledUsd(a.fixedUsd) }, fixedUsd => set({ fixedUsd: unscaledUsd(fixedUsd) })));
    body.append(switchRow(t('Write the volume beside each mark'), t('The USD taken at that level, added up over the marks drawn as one.'), a.volume, volume => set({ volume })));
    const now = this.absorptionInfo();
    body.append(note(now ? t('Thresholds now: {list}', { list: now }) : t('The thresholds appear once a minute of trading has been recorded.')));
    body.append(note(t('The threshold that applies now judges every mark on the map, so changing it, or the market moving it, redraws the history. Each venue is judged at its own threshold. A mark says what traded, not what price did next.')));
  }

  /** The server anchors venue selection on a USDT/USDC-quoted product; prefer the current market, else the first such market. */
  #selectionProduct(): string {
    const { markets, marketId } = this.store.state;
    const stable = (m: { quote?: string }) => /^(USDT|USDC)$/i.test(String(m.quote ?? ''));
    const current = markets.find(m => (m.instrumentId ?? m.id) === marketId);
    if (current && stable(current)) return marketId;
    return markets.find(m => stable(m) && m.marketType === 'perpetual')?.instrumentId ?? markets.find(stable)?.instrumentId ?? marketId;
  }
}
