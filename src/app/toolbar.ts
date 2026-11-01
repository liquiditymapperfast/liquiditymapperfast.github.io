import { TIMEFRAMES } from './hub.ts';
import { PALETTES, THEME_ORDER } from './theme.ts';
import { AVAILABLE_LAYERS, type Store, type AppState, type Layer } from './store.ts';
import { VPN_HINT, VenueNotice, blockedVenues, idleText, idleVenues } from './venue-notice.ts';
import type { VenueEntry } from './source.ts';
import { clock, usd, zoneName } from './format.ts';
import { venueLabel } from './panes/ladder-pane.ts';
import { el } from './dom.ts';
import { BAR_ZOOM_FLOOR, arrangeBar, type BarFit } from './bar-fit.ts';
import { lazy } from './lazy.ts';
import { setTip } from './tip.ts';
import { InstallButton } from './install.ts';
import { toggleAuthor } from './author.ts';
import { HELP, helpButton, setTourStarter, showGuide, showTour, type HelpId } from './help.ts';
import { openVenueDialog } from './venue-dialog.ts';
import type { VenueControl } from './source.ts';
import { coverage } from './panes/levels-data.ts';
import { SCOPE_OPTIONS, activeIds, chipClick, heatmapSourceOf, kindOf, scopeCounts, scopedOut } from './scope.ts';
import { HIGHLIGHT_LIMITS } from './anomaly.ts';
import { rangeRow, switchRow, note, togglePanel, checkRow, heading, selectRow, numberRow, openedPanel, button, sizeRow } from './ui.ts';
import { SIZE_MAX_USD } from './sizes.ts';
import { GROUP_TITLES, SHORTCUTS, togglePatch, type Feature, type ShortcutGroup } from './shortcuts.ts';
import { buildGallery, newGalleryState } from './layouts/gallery.ts';
import type { LayoutActions } from './layouts/actions.ts';
import { TourInvite } from './tour/invite.ts';
import { clampGoTo, formatDateTime, parseDateTime } from './price-line.ts';
import { ABSORPTION_LIMITS, type AbsorptionSettings } from './absorption.ts';
import { BUBBLE_LIMITS, BUBBLE_MINIMUMS, type BubbleSettings } from './prints.ts';
import { LIQUIDATION_LIMITS, LIQUIDATION_MINIMUMS, coverageLines, type LiquidationSettings } from './liquidations.ts';
import { buildKeyLevelPanel } from './keylevels/panel.ts';
import { buildVwapPanel, type WhaleInfo } from './vwap/panel.ts';
import { buildFootprintPanel } from './footprint/panel.ts';
import type { FlowBook } from './flow-book.ts';
import type { KeyLevelHistory } from './keylevels/history.ts';
import { INLINE_CHIPS, chipPlan, exchangeGroups } from './chips.ts';
import { openMenu } from './menu.ts';
import { buildSoundPanel } from './sound/panel.ts';
import type { Sounds } from './sound/sounds.ts';
import type { Alerts } from './sound/alerts.ts';
import type { Panel } from './ui.ts';
import { HEAT_STYLES, legendBackground, type HeatStyleId } from './heatmap/lut.ts';
import { CONTRAST } from './heatmap/window.ts';
import { CHART_TYPES, chartTypeGlyph, chartTypeName, chartTypeTip, type ChartType } from './chart-type.ts';
import { compactBar, isPhone, onLayoutMode } from './device.ts';
import { openSheet, type Sheet } from './sheet.ts';
import { wakeLockSupported } from './wake.ts';
import { LANGUAGES, language, pickLanguage, saveLanguage, savedLanguage } from './i18n.ts';
import { t, tn } from './i18n.ts';
import { coinChoice, currentCoin, scaledUsd, unscaledUsd } from './coin.ts';
import { buildTradedPanel } from './traded/panel.ts';
import type { ProfileRoom } from './traded/arrange.ts';
import { venueMark } from './venue-marks.ts';
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
const LAYERS: [Layer, string][] = [['liquidity', t('Liquidity')], ['liquidation', t('Liquidation levels')], ['stopLoss', t('Stop loss')], ['takeProfit', t('Take profit')]];
/** A chosen venue that has no book for this long gets a chip saying so (a start-up that is merely slow does not). */
const IDLE_GRACE_MS = 20_000;
/** What the dropdown says next to a layer that cannot be chosen yet. */
const UPCOMING = 'upcoming';

/** The pane switches in the top bar, in order: the two side columns first (they vanish and return at once), then what the map shows. */
const PANE_TOGGLES: readonly (readonly [keyof AppState['show'], string])[] = [['cvd', t('Flow')], ['book', t('Book')], ['profile', t('Profile')], ['depth', t('Depth')], ['oi', 'OI'], ['delta', t('Delta')], ['ls', t('L/S')], ['candles', t('Candles')], ['lt', 'LT'], ['mirror', t('Mirror')], ['volume', t('Volume')], ['stats', t('Stats')]];

/** Assign a form control's value only when it differs: assigning to an open select closes its popup. */
function setValue(control: HTMLSelectElement | HTMLInputElement, value: string): void { if (control.value !== value) control.value = value; }

/** Light or dim a button's lamp (`.led-btn`): it says whether the feature the button opens is on. Written only when it changes. */
function lamp(button: HTMLElement, on: boolean): void { const state = on ? 'on' : 'off'; if (button.dataset.state !== state) button.dataset.state = state; }

/**
 * A split button (Karl, 2026-10-17): `main` switches its feature on or off in one click and its lamp says which; the small key joined to its
 * right, with drawn sliders, opens the feature's settings. The pair is one element, so the deck and the phone's Settings lay it out whole.
 */
function splitButton(main: HTMLButtonElement, key: HTMLButtonElement): HTMLElement { return el('span', { class: 'split' }, main, key); }

/** The settings key of a split button, named for its feature (`Settings: VWAP`) for a tooltip and a screen reader. */
function settingsKey(name: string): HTMLButtonElement {
  const label = `${t('Settings')}: ${name}`;
  return el('button', { type: 'button', class: 'split-cfg', ariaLabel: label, tip: label });
}

/**
 * One deck of the full top bar: a framed group (a fieldset, whose legend sits in the frame line) of up to two rows of controls. Its frame is
 * the theme's (chrome.css): an etched group box on the bevel, a double rule in text mode, a hairline pair in the editor.
 */
function deck(id: string, title: string, ...rows: HTMLElement[][]): HTMLElement {
  const box = el('fieldset', { class: `deck deck-${id}` }, el('legend', { textContent: title }),
    ...rows.filter(r => r.length).map(r => el('div', { class: 'deck-row' }, ...r)));
  box.dataset.deck = id;
  return box;
}

/** Top bar: market, timeframe, layer, pane toggles, heatmap colour, venues, theme. */
export class Toolbar {
  readonly root = el('header', { class: 'toolbar' });
  /** The coin every view shows; choosing another loads the page again for it (app/coin.ts). */
  #coin = el('button', { type: 'button', class: 'coin-btn', textContent: currentCoin().coin, ariaLabel: t('Coin'), tip: t('Coin: which coin every view shows. Choosing another loads the page again for it.'), onclick: () => { void lazy(() => import('./coin-dialog.ts')).then(m => m?.openCoinDialog()); } });
  /** Says once why the page is on BTC when another coin was asked for. */
  #coinNotice = el('div', { class: 'notice info', role: 'status', hidden: true });
  #market = el('select', { class: 'market', ariaLabel: t('Market'), tip: t("Market: whose candles, footprint and open interest the chart shows. The heatmap always combines every enabled venue's book, whatever is chosen here.") });
  #timeframes = el('div', { class: 'seg' });
  #layer = el('select', { ariaLabel: t('Layer'), tip: t('Layer drawn on the map. Liquidity is the order-book heatmap; liquidation, stop-loss and take-profit layers are upcoming (they need data a static page cannot hold a key for).') });
  #toggles = el('div', { class: 'seg toggles' });
  #chips = el('div', { class: 'chips' });
  /** Venues this location cannot reach, beside the live ones, so their absence is explained where it is noticed. */
  #blocked = el('div', { class: 'chips blocked-chips' });
  readonly #notice = new VenueNotice();
  readonly #install = new InstallButton();
  #guide = el('button', { type: 'button', class: 'guide-btn', textContent: t('Guide'), tip: t('The whole story of what everything is and how to use it, with moving pictures. Every button also explains itself on hover.'), onclick: () => { showGuide(); } });
  /** The quick tour (tour/tour.ts), which lights the page a part at a time; beside the Guide, which is the whole story. */
  #tour = el('button', { type: 'button', class: 'tour-btn', textContent: t('Tour'), tip: t('A one-minute tour of the page: what the map shows and where everything is. The Guide goes deeper.'), onclick: () => { this.#sheet?.close(); this.startTour(); } });
  /** Offers the tour once to a visitor who has never been offered it (a notice under the bar). */
  readonly #invite = new TourInvite(() => this.startTour(), () => compactBar() ? t('You can take the tour any time from Settings.') : t('You can take the tour any time with the Tour button at the top right.'));
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
   * The features that are switched on and set in a panel: one button each, whose lamp (`.led-btn`) is lit while the feature is on. The Chart
   * and Alerts decks' are split buttons (`splitButton`: the button switches, its key opens the panel). Trades
   * and Absorption mark market orders on the map, Highlights and Sound point out what is unusual, so they stand in those pairs.
   */
  #trades = el('button', { class: 'led-btn', textContent: t('Trades'), tip: HELP.bubbles.tip });
  /** The settings keys of the Chart deck's split buttons (`splitButton`): each opens its feature's panel, which is placed from the key. */
  #settingsKeys: Record<Exclude<Feature, 'highlights'>, HTMLButtonElement> = {
    trades: settingsKey(t('Trades')), footprint: settingsKey(t('Footprint')), vwap: settingsKey(t('VWAP')), keyLevels: settingsKey(t('Key levels')),
    liquidations: settingsKey(t('Liquidations')), traded: settingsKey(t('Volume profile')), absorption: settingsKey(t('Absorption')),
  };
  /** The Alerts deck's settings keys: Highlights and Sound are switched and set the same way. */
  #alertKeys = { highlights: settingsKey(t('Highlights')), sound: settingsKey(t('Sound')) };
  #alertSplits: { highlights: HTMLElement; sound: HTMLElement } | null = null;
  /** The split buttons themselves (the button and its key), built once the buttons and keys exist. */
  #splits: Record<Exclude<Feature, 'highlights'>, HTMLElement> | null = null;
  #absorption = el('button', { class: 'led-btn', textContent: t('Absorption'), tip: HELP.absorption.tip });
  /** Liquidations on the map (liquidations.ts), set in its panel. */
  #liquidations = el('button', { class: 'led-btn', textContent: t('Liquidations'), tip: HELP.liquidations.tip });
  #liquidationPanel: Panel | null = null;
  /** The previous day's, week's and month's levels (keylevels/), set in its panel. */
  #keyLevels = el('button', { class: 'led-btn', textContent: t('Key levels'), tip: HELP.keyLevels.tip });
  #keyLevelPanel: Panel | null = null;
  /** The footprint (on/off is `show.footprint`), set in its panel: a lamp button since it holds settings, not one of the pane toggles. */
  #footprint = el('button', { class: 'led-btn', textContent: t('Footprint'), tip: HELP.footprint.tip });
  #footprintPanel: Panel | null = null;
  /** The flow book (set by the page once the hub exists): the footprint's market picker puts markets with recorded flow first. */
  flow: FlowBook | null = null;
  /** The VWAP lines (vwap/), set in its panel. */
  #vwap = el('button', { class: 'led-btn', textContent: t('VWAP'), tip: HELP.vwap.tip });
  /**
   * The person's scripts (script/): the lamp is `show.script` (they run and draw: on the map, and in rows under it for those placed there),
   * the key opens the Scripts panel, where they are written and switched on one by one (`onOpenScripts`, set by the page).
   */
  #scripts = el('button', { class: 'led-btn', textContent: t('Scripts'), tip: HELP.script.tip });
  #scriptsKey = settingsKey(t('Scripts'));
  #scriptsSplit = splitButton(this.#scripts, this.#scriptsKey);
  /** The key that opens the Scripts panel: where the panel opens from when nothing was pressed (an agent's draft). */
  get scriptsAnchor(): HTMLElement { return this.#scriptsKey; }
  onOpenScripts: (anchor: HTMLElement) => void = () => {};
  #vwapPanel: Panel | null = null;
  /** What the page knows of the whale sums (set by the page), for the VWAP panel. */
  whaleInfo: () => WhaleInfo | null = () => null;
  /** The key levels' candles (set by the page), for the panel to say whose they are and whether they could be read. */
  keyHistory: KeyLevelHistory | null = null;
  /** The volume profile's candles of one bar size (set by the page), for its panel to say whether they could be read. */
  profileHistory: ((barMs: number) => KeyLevelHistory) | null = null;
  /** The room the map's profiles have (heat-pane.ts `profileRoom`), for the Volume profile panel to say what has none; set by the page. */
  profileRoom: (() => ProfileRoom) | null = null;
  /** Where the page's data comes from (set by the page): a page reading the exchanges itself keeps liquidations only while it is open. */
  sourceKind: 'server' | 'browser' = 'server';
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
  /** Go to a date and time (the map's corner, beside Select; G). */
  #goto = el('button', { type: 'button', class: 'map-goto', textContent: t('Go to'), tip: t('Go to a date and time (keyboard: G)'), onclick: () => this.openGoTo() });
  /** What Go to moves and reads (set by main). */
  goTo: { centre(): number; earliest(): { depth: number | null; candles: number | null }; go(t: number): void; live(): void; replay(t: number): void } | null = null;
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
    smooth: el('select', { ariaLabel: t('Smoothing'), tip: t('Vertical smoothing when price rows get thin (zoomed out): Auto smooths with a ~5 px Gaussian below 15 px per row, so far walls stay visible; Off draws every row exactly.') }),
    auto: el('button', { class: 'led-btn', textContent: t('Auto'), tip: t('Auto: the colour window follows the data (recomputed on recenter, market change, zoom and every 10 s). Off: it stays where it is.') }),
  };
  #source = el('select', { class: 'heat-source', ariaLabel: t('Source'), tip: t('Heatmap source') });
  #theme = el('button', { class: 'theme-btn', tip: t('Theme: hover to preview, click to keep') });
  /** Solid or glass, in any theme (store `material`): a lamp on the full bar, a switch in a phone's Settings. */
  #glass = el('button', { type: 'button', class: 'led-btn glass-btn', textContent: t('Waves'), tip: t('Waves: the bars and panels around the chart turn to glass; large orders and large flow changes light it and send waves across the screen') });
  #glassSwitch = el('input', { type: 'checkbox' });
  /** The page's language: the code of the one in use, and a menu of the others (a language is chosen before the page is built, so choosing one reloads it). */
  /** Which clock the page's times are on: UTC, or the computer's own. */
  #zone = el('button', { class: 'zone-btn' });
  /** The list of keyboard shortcuts (also the ? key); on the status bar, so a phone, which has no keyboard, does not show it. */
  #keys = el('button', { type: 'button', class: 'keys-btn', textContent: t('Keys'), tip: t('Keyboard shortcuts (?)'), onclick: () => this.openShortcuts() });
  /** Layouts, from the map's corner (a compact bar has it in Settings): the layout the screen is showing, the ready-made ones and the person's own (layouts/gallery.ts). `layouts` is set by main. */
  #layoutCorner = el('button', { type: 'button', class: 'map-layout', ariaLabel: t('Layouts'), tip: t('Layouts: choose a ready-made arrangement of the panels, or save your own'), onclick: () => this.#openLayouts(this.#layoutCorner) }, t('Layouts'));
  layouts: LayoutActions | null = null;
  /** The lamp panel open now, with what redraws it. */
  #open: { panel: Panel; redraw: () => void } | null = null;
  #language = el('button', { class: 'language-btn', ariaLabel: t('Language'), tip: t('Language: the page uses the language of your browser unless you choose another here') }, el('span', { textContent: language().toUpperCase() }));
  #status = el('span', { class: 'status', tip: t('Connection to the data source: live when frames are arriving.') });
  #brand = el('span', { class: 'brand', textContent: 'LiquidityMapperFast' });
  #venuesButton: HTMLElement | null = null;
  /** The Venues button's word, and on the full bar how many of the venues with a book are switched on. */
  #venuesLabel = el('span', { textContent: t('Venues') });
  #venuesCount = el('span', { class: 'count' });
  /** The venues with a book now (from the last frame), for the switches the full bar's Venues button opens. */
  #venueList: readonly string[] = [];
  /** Opens the dialog that chooses which exchanges feed the page. */
  #openFeeds: () => void = () => {};
  /** The venues the source last reported, and the ones with a book on the map (chips for chosen venues that have none say why). */
  #entries: readonly VenueEntry[] = [];
  #drawn: ReadonlySet<string> = new Set();
  #idleSince = new Map<string, number>();
  #idleKey = '';
  #heatctl = el('span', { class: 'heatctl' });
  /** The colour ramp and the contrast slider under it: one unit, so the Settings sheet can give it a row of its own. */
  #heatScale = el('span', { class: 'scale' });
  #spacer = el('span', { class: 'spacer' });
  /** Phone only: the button that opens Settings, where every control that does not fit the top bar lives. */
  #more = el('button', { type: 'button', class: 'more-btn', ariaLabel: t('Settings'), tip: t('Settings: panels, heatmap colouring, venues, sound, theme and the guide.') });
  /**
   * Folds the bar away (`state.barCollapsed`), the chart taking its room as a browser's full screen does (Karl, 2026-10-24: "the ability
   * to collapse the header bar ... on an iPad ... to maximize screen space"). Folded, the bar is a thin strip, `#expand`, that brings it
   * back: a tab floating over the top of the screen covered one of the map's buttons or another, whatever the layout.
   */
  #collapse = el('button', { type: 'button', class: 'bar-collapse', ariaLabel: t('Hide the controls'), tip: t('Hide the controls'), ariaExpanded: 'true', onclick: () => this.store.set({ barCollapsed: true }) });
  #expand = el('button', { type: 'button', class: 'bar-expand', ariaLabel: t('Show the controls'), tip: t('Show the controls'), onclick: () => this.store.set({ barCollapsed: false }) });
  #sheet: Sheet | null = null;
  /** Where Recenter lives on the full toolbar's screens: in a corner of the map it acts on, not among the venues (null until the map exists). */
  #mapHost: HTMLElement | null = null;
  /** What the full bar was last fitted to (`#fit`), and the elements that break it into rows where it is. */
  #fitted: BarFit | null = null; #fittedOrder = ''; #deckBreaks: HTMLElement[] = []; #fitFrame = 0;
  /** The full bar's decks in their own order (the one row's); in rows they stand in `ROWS_ORDER` (bar-fit.ts). */
  #decks: HTMLElement[] = [];
  /** Settings' "Keep screen on" switch (only where the browser can hold the screen awake). */
  #awake = el('input', { type: 'checkbox' });
  #recenter = el('button', { textContent: t('Recenter'), tip: t('Jump back to the live edge and fit the price range to the recent candles (keyboard: R, Home, or double-click the chart).') });
  onRecenter: () => void = () => {};
  /** Preview a theme without keeping it (`null` puts the saved one back). */
  onPreviewTheme: (id: string | null) => void = () => {};
  /** Hovering a chart type in its menu draws the map with it without keeping it; leaving the menu puts the kept one back (null). */
  onPreviewChartType: (id: ChartType | null) => void = () => {};
  /** How the map draws its price (chart-type.ts): a cell of the Time deck, beside the timeframes, as a chart's type usually sits. */
  #chartType = el('button', { type: 'button', class: 'chart-type', ariaLabel: t('Chart type') });
  /** The drawing tools' button (draw/bar.ts, set by the page), in the map's corner beside Select. */
  #drawCorner: HTMLElement | null = null;
  setDrawButton(button: HTMLElement): void { this.#drawCorner = button; this.#arrange(); }
  onSelectMarket: (id: string) => void = () => {};
  /** The person applied a venue selection (a server brings the new feeds up some seconds later). */
  onVenuesApplied: () => void = () => {};

  /**
   * What the scripts are doing, on their lamp (set by the Scripts pane): `running` while one that is on waits for its first answer (the first
   * can take a while on a busy page), `error` with the name of one that stopped, '' otherwise. The tip says it.
   */
  setScriptsStatus(note: 'running' | 'error' | '', name: string): void {
    if ((this.#scripts.dataset.note ?? '') !== note) { if (note) this.#scripts.dataset.note = note; else delete this.#scripts.dataset.note; }
    this.#scripts.dataset.tip = note === 'error' ? `${HELP.script.tip} ${t('“{name}” stopped with an error: open Scripts to see it.', { name })}` : note === 'running' ? `${HELP.script.tip} ${t('running…')}` : HELP.script.tip;
  }

  constructor(private store: Store, private venueControl: VenueControl) {
    // The Guide's link to the tour starts it as the Tour button does (the bar unfolded for it).
    setTourStarter(() => this.startTour());
    // A notice that comes, goes, or wraps differently moves the ones under it.
    if (typeof ResizeObserver === 'function') {
      const stack = new ResizeObserver(() => this.#stackNotices());
      for (const notice of [this.#notice.root, this.#coinNotice, this.#invite.root]) stack.observe(notice);
    }
    const missing = coinChoice().notice;
    if (missing) {
      this.#coinNotice.append(el('span', { class: 'notice-mark mark-info', ariaHidden: 'true' }), el('span', { textContent: missing.reason === 'unreadable' ? t('The coin list could not be read, so only BTC is offered.') : t('{coin} is not on the coin list, so the page is on BTC.', { coin: missing.coin }) }),
        el('button', { class: 'notice-close', tip: t('Dismiss'), ariaLabel: t('Dismiss'), onclick: () => { this.#coinNotice.hidden = true; } }));
      this.#coinNotice.hidden = false;
    }
    this.#market.onchange = () => this.onSelectMarket(this.#market.value);
    this.#chartType.onclick = () => {
      const items = CHART_TYPES.map(id => ({ id, label: chartTypeName(id) }));
      openMenu(this.#chartType, items, this.store.state.chartType, { onPreview: id => this.onPreviewChartType(id as ChartType | null), onSelect: id => { this.onPreviewChartType(null); this.store.set({ chartType: id as ChartType }); } }, 'left', { title: t('Chart type') });
    };
    for (const tf of Object.keys(TIMEFRAMES)) this.#timeframes.append(el('button', { textContent: tf, tip: t('{timeframe} candles. The footprint, the bar stats and the open-interest bars follow this too.', { timeframe: TIMEFRAME_NAMES[tf] ?? tf }), onclick: () => this.store.set({ timeframe: tf }) }));
    this.#timeframes.append(this.#chartType);
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
    this.#settingsKeys.trades.onclick = () => {
      const build = (tools: HTMLElement, body: HTMLElement): void => this.#buildTrades(tools, body, () => this.#tradePanel?.render(build));
      this.#tradePanel = this.#track(togglePanel(this.#settingsKeys.trades, { title: t('Trades'), width: 380, align: 'left', onClose: () => { this.#tradePanel = null; } }, build), build);
    };
    this.#trades.onclick = () => this.store.set(togglePatch(this.store.state, 'trades'));
    this.#settingsKeys.footprint.onclick = () => {
      const build = (tools: HTMLElement, body: HTMLElement): void => buildFootprintPanel(this.store, this.flow, tools, body, () => this.#footprintPanel?.render(build));
      this.#footprintPanel = this.#track(togglePanel(this.#settingsKeys.footprint, { title: t('Footprint'), width: 440, align: 'left', onClose: () => { this.#footprintPanel = null; } }, build), build);
    };
    this.#footprint.onclick = () => this.store.set(togglePatch(this.store.state, 'footprint'));
    this.#settingsKeys.vwap.onclick = () => {
      const build = (tools: HTMLElement, body: HTMLElement): void => buildVwapPanel(this.store, tools, body, () => this.#vwapPanel?.render(build), this.whaleInfo);
      this.#vwapPanel = this.#track(togglePanel(this.#settingsKeys.vwap, { title: t('VWAP'), width: 420, align: 'left', stays: true, onClose: () => { this.#vwapPanel = null; if (this.store.state.vwapAnchoring) this.store.set({ vwapAnchoring: false }); } }, build), build);
    };
    this.#vwap.onclick = () => this.store.set(togglePatch(this.store.state, 'vwap'));
    this.#scripts.onclick = () => this.store.set({ show: { ...this.store.state.show, script: !this.store.state.show.script } });
    this.#scriptsKey.onclick = () => this.onOpenScripts(this.#scriptsKey);
    this.#settingsKeys.keyLevels.onclick = () => {
      const build = (tools: HTMLElement, body: HTMLElement): void => buildKeyLevelPanel(this.store, tools, body, () => this.#keyLevelPanel?.render(build), this.keyHistory);
      this.#keyLevelPanel = this.#track(togglePanel(this.#settingsKeys.keyLevels, { title: t('Key levels'), width: 420, align: 'left', onClose: () => { this.#keyLevelPanel = null; } }, build), build);
    };
    this.#keyLevels.onclick = () => this.store.set(togglePatch(this.store.state, 'keyLevels'));
    this.#settingsKeys.liquidations.onclick = () => {
      const build = (tools: HTMLElement, body: HTMLElement): void => this.#buildLiquidations(tools, body, () => this.#liquidationPanel?.render(build));
      this.#liquidationPanel = this.#track(togglePanel(this.#settingsKeys.liquidations, { title: t('Liquidations'), width: 400, align: 'left', onClose: () => { this.#liquidationPanel = null; } }, build), build);
    };
    this.#liquidations.onclick = () => this.store.set(togglePatch(this.store.state, 'liquidations'));
    this.#alertSplits = { highlights: splitButton(this.#highlights, this.#alertKeys.highlights), sound: splitButton(this.#soundButton, this.#alertKeys.sound) };
    const k = this.#settingsKeys;
    this.#splits = {
      trades: splitButton(this.#trades, k.trades), footprint: splitButton(this.#footprint, k.footprint), vwap: splitButton(this.#vwap, k.vwap),
      keyLevels: splitButton(this.#keyLevels, k.keyLevels), liquidations: splitButton(this.#liquidations, k.liquidations),
      traded: splitButton(this.#traded, k.traded), absorption: splitButton(this.#absorption, k.absorption),
    };
    for (const [value, label] of SCOPE_OPTIONS) this.#scope.append(el('button', { textContent: label, onclick: () => this.store.set({ scope: value }) }));
    this.#alertKeys.sound.onclick = () => {
      const sounds = this.#sounds; if (!sounds) return;
      const build = (tools: HTMLElement, body: HTMLElement): void => { tools.append(helpButton('sounds')); buildSoundPanel(this.store, sounds, () => this.#soundPanel?.render(build), tools, body, this.#alerts); };
      this.#soundPanel = this.#track(togglePanel(this.#alertKeys.sound, { title: t('Sounds'), width: 420, align: 'left', onClose: () => { this.#soundPanel = null; } }, build), build);
    };
    this.#soundButton.onclick = () => {
      const on = !this.store.state.sounds.on, sounds = this.#sounds;
      this.store.set({ sounds: { ...this.store.state.sounds, on } });
      // The press is the gesture a browser waits for before it lets a page play sound.
      if (on && sounds) void sounds.engine.unlock().then(() => this.store.set({ soundState: sounds.engine.state }));
    };
    this.#alertKeys.highlights.onclick = () => {
      const build = (tools: HTMLElement, body: HTMLElement): void => { tools.append(helpButton('highlights')); this.#buildHighlights(tools, body); };
      this.#track(togglePanel(this.#alertKeys.highlights, { title: t('Highlights'), width: 380, align: 'left' }, build), build);
    };
    this.#highlights.onclick = () => this.store.set(togglePatch(this.store.state, 'highlights'));
    this.#settingsKeys.traded.onclick = () => {
      const build = (tools: HTMLElement, body: HTMLElement): void => buildTradedPanel(this.store, tools, body, () => this.#tradedPanel?.render(build), () => gridStepFor(this.store.state.mark.price > 0 ? this.store.state.mark.price : 1), { browser: this.sourceKind === 'browser', candles: this.profileHistory, room: () => this.profileRoom?.() ?? null });
      this.#tradedPanel = this.#track(togglePanel(this.#settingsKeys.traded, { title: t('Volume profile'), width: 520, align: 'left', onClose: () => { this.#tradedPanel = null; } }, build), build);
    };
    this.#traded.onclick = () => this.store.set(togglePatch(this.store.state, 'traded'));
    this.#settingsKeys.absorption.onclick = () => {
      const build = (tools: HTMLElement, body: HTMLElement): void => this.#buildAbsorption(tools, body, () => this.#absorptionPanel?.render(build));
      this.#absorptionPanel = this.#track(togglePanel(this.#settingsKeys.absorption, { title: t('Absorption'), width: 400, align: 'left', onClose: () => { this.#absorptionPanel = null; } }, build), build);
    };
    this.#absorption.onclick = () => this.store.set(togglePatch(this.store.state, 'absorption'));
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
    this.#openFeeds = () => void openVenueDialog(this.venueControl, () => this.#selectionProduct(), () => this.onVenuesApplied());
    // On the full bar the venues are no longer chips beside it: the button opens their switches (and, from there, the feeds); on a phone,
    // whose Settings lists every chip, it chooses the feeds.
    const venues = el('button', { class: 'venues-btn', tip: t('Choose which exchanges feed the map. The choice is kept in this browser; nothing changes until you press Apply.'),
      onclick: () => { if (compactBar()) this.#openFeeds(); else this.#openVenueMenu(venues, this.#venueList); } }, this.#venuesLabel, this.#venuesCount);
    this.#heatScale.append(this.#heat.legend, this.#heat.contrast);
    this.#fillHeatControls();
    this.#more.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>';
    this.#more.onclick = () => this.#toggleSheet();
    this.#awake.onchange = () => this.store.set({ keepAwake: this.#awake.checked });
    this.#glass.onclick = () => this.store.set({ material: this.store.state.material === 'glass' ? 'solid' : 'glass' });
    this.#glassSwitch.onchange = () => this.store.set({ material: this.#glassSwitch.checked ? 'glass' : 'solid' });
    const shoot = this.#shot.onclick;
    // The screenshot is of the page, so Settings must be out of the picture before it is taken.
    this.#shot.onclick = event => { if (!this.#sheet) { shoot?.call(this.#shot, event); return; } this.#sheet.close(); requestAnimationFrame(() => requestAnimationFrame(() => { shoot?.call(this.#shot, event); })); };
    this.#venuesButton = venues;
    this.#arrange();
    onLayoutMode(() => { this.#arrange(); });
    // The bar is fitted when it is laid out, and again when what its decks' widths depend on changes: the window, the fonts, the theme and
    // frame, the language. Its own height changing (the fit itself, folding it away) asks again and finds the same answer.
    const refit = (): void => { if (this.#fitFrame) return; this.#fitFrame = requestAnimationFrame(() => { this.#fitFrame = 0; this.#fit(); }); };
    addEventListener('resize', refit);
    void document.fonts?.ready.then(refit);
    new MutationObserver(refit).observe(document.documentElement, { attributes: true, attributeFilter: ['data-frame', 'data-theme', 'data-bar', 'lang'] });
    new ResizeObserver(refit).observe(this.root);
  }

  /**
   * Put every control where the current arrangement wants it. The full toolbar is one wrapping row in its original order; the compact
   * one (a phone, or any screen a finger drives) keeps market, timeframe, status and Settings in a slim top bar and moves the rest into
   * the Settings sheet, grouped by purpose. The same elements move in both directions, so their handlers and state survive a rotation
   * or a window resize.
   */
  /** The heatmap colour controls as the desktop toolbar has them, in one group. */
  #fillHeatControls(): void { this.#heatctl.replaceChildren(this.#heat.style, this.#heatScale, this.#heat.auto, this.#heat.smooth); }

  /** The desktop status bar takes the language and theme buttons (and the connection text) from the top bar. */
  /** Remember the lamp panel just opened (or none) and how to redraw it. */
  #track(panel: Panel | null, build: (tools: HTMLElement, body: HTMLElement) => void): Panel | null {
    this.#open = panel ? { panel, redraw: () => panel.render(build) } : null;
    return panel;
  }

  /** Redraw the lamp panel that is open, after its feature was switched from the keyboard, so its switch says what the lamp does. */
  refreshOpenPanel(): void { if (this.#open && openedPanel() === this.#open.panel) this.#open.redraw(); }
  /** Redraw the Volume profile panel if it is the one open: what of the profiles has no room changed (a resize), and its sketch and note say so. */
  refreshTradedPanel(): void { if (this.#tradedPanel && this.#open?.panel === this.#tradedPanel) this.refreshOpenPanel(); }

  /**
   * The Go to panel: a date and time on the page's clock, the map centred on it at its zoom. It says how far back the depth and the candles
   * reach (the chart holds its last 500 candles), goes to the start of them for an earlier moment and to the live edge for one to come.
   */
  openGoTo(): void {
    const host = this.goTo; if (!host || !this.#goto.isConnected) return;
    const zone = this.store.state.timeZone;
    let message = '';
    const build = (_tools: HTMLElement, body: HTMLElement): void => {
      const input = el('input', { type: 'datetime-local', class: 'goto-time', value: formatDateTime(host.centre(), zone), ariaLabel: t('Date and time') });
      const go = (): void => {
        const asked = parseDateTime(input.value, zone);
        if (asked === null) { message = t('Choose a date and a time.'); panel?.render(build); return; }
        const { depth, candles } = host.earliest(), earliest = [depth, candles].filter((v): v is number => v !== null).reduce<number | null>((a, b) => a === null ? b : Math.min(a, b), null);
        const where = clampGoTo(asked, earliest, Date.now());
        if (where.clamped === 'live') { host.live(); message = t('That is still to come: back at the live edge.'); }
        else { host.go(where.t); message = where.clamped === 'before' ? t('Nothing is held that far back: at the start of what is, {time}.', { time: clock(where.t, true) }) : t('At {time}.', { time: clock(where.t, true) }); }
        panel?.render(build);
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      // Replay from the moment chosen: the same clamp as Go, and nothing to replay from now or later.
      const replay = (): void => {
        const asked = parseDateTime(input.value, zone);
        if (asked === null) { message = t('Choose a date and a time.'); panel?.render(build); return; }
        const { depth, candles } = host.earliest(), earliest = [depth, candles].filter((v): v is number => v !== null).reduce<number | null>((a, b) => a === null ? b : Math.min(a, b), null);
        const where = clampGoTo(asked, earliest, Date.now());
        if (where.clamped === 'live') { message = t('That is still to come: there is nothing to replay yet.'); panel?.render(build); return; }
        host.replay(where.t); panel?.close();
      };
      body.append(el('div', { class: 'goto-row' }, input, button(t('Go'), go, t('Centre the map on this moment')), button(t('Replay from here'), replay, t('Play what was recorded back from this moment, as if it were live'))));
      if (message) body.append(el('p', { class: 'panel-note goto-message', textContent: message }));
      const { depth, candles } = host.earliest();
      body.append(note([depth !== null ? t('Depth is recorded from {time}.', { time: clock(depth, true) }) : '', candles !== null ? t('Candles at this timeframe reach back to {time}.', { time: clock(candles, true) }) : ''].filter(Boolean).join(' ')));
      requestAnimationFrame(() => input.focus());
    };
    const panel = togglePanel(this.#goto, { title: t('Go to'), width: 340, align: 'right', stays: true }, build);
  }

  #openLayouts(anchor: HTMLElement): void {
    const actions = this.layouts; if (!actions) return;
    const ui = newGalleryState();
    // A redraw after the panel was closed (a toast's Undo, a frame later) leaves it closed.
    const build = (_tools: HTMLElement, body: HTMLElement): void => buildGallery(actions, body, () => { if (panel && openedPanel() === panel) panel.render(build); }, ui);
    const panel = togglePanel(anchor, { title: t('Layouts'), width: 560, align: 'right' }, build);
    // The toast of a deleted layout can outlive the panel it was deleted from: its Undo redraws the Layouts panel that is open then.
    actions.onListChanged = () => { if (panel && openedPanel() === panel) panel.render(build); };
  }

  /** The list of keyboard shortcuts, made from the table itself so the two cannot disagree (the status bar's Keys button, and ?). */
  openShortcuts(): void {
    if (!this.#keys.isConnected) return;
    togglePanel(this.#keys, { title: t('Keyboard shortcuts'), width: 380, align: 'right' }, (_tools, body) => {
      const list = el('div', { class: 'keys-list' });
      for (const group of ['timeframe', 'chart', 'show', 'tools'] as ShortcutGroup[]) {
        list.append(heading(GROUP_TITLES[group]));
        const rows = SHORTCUTS.filter(s => s.group === group);
        // The timeframes are one row of key and name pairs; every other shortcut has a row of its own.
        if (group === 'timeframe') list.append(el('div', { class: 'keys-row keys-pairs' }, ...rows.map(s => el('span', {}, el('kbd', { textContent: s.caps[0] ?? '' }), ` ${s.label}`))));
        else for (const s of rows) list.append(el('div', { class: 'keys-row' }, el('span', { class: 'keys-caps' }, ...s.caps.map(cap => el('kbd', { textContent: cap }))), el('span', { textContent: s.label })));
      }
      list.append(note(t('Keys do nothing while you type in a field or a window is open, or with Ctrl, Alt or ⌘ held.')));
      body.append(list);
    });
  }

  hostStatusControls(host: HTMLElement): void { this.#statusHost = host; this.#arrange(); }

  /** Take the tour (the Tour button, the invitation): a bar folded away is brought back for it and folded again after. */
  startTour(): void {
    // The invitation has been answered, whichever button answered it.
    this.#invite.root.hidden = true;
    showTour({ prepare: () => {
      if (!this.store.state.barCollapsed) return () => {};
      this.store.set({ barCollapsed: false });
      // The setting is written as it changes: a tab closed or reloaded in the middle of the tour must not leave the bar unfolded for good.
      const fold = (): void => this.store.set({ barCollapsed: true });
      window.addEventListener('pagehide', fold);
      return () => { window.removeEventListener('pagehide', fold); fold(); };
    } });
  }
  /** Offer the tour to a visitor who has not been offered it; false when something is open over the page and it should be tried again. */
  inviteToTour(): boolean { return this.#invite.offer(); }

  /**
   * The notices lie over the top of the chart, one under the other, each under the one above by what that one measures now: a notice that wraps on a narrow
   * screen (the blocked venues' is three lines on a phone) is taller than the fixed step the stylesheet would give it, and the next would cover its words.
   */
  #stackNotices(): void {
    let top = 4;
    for (const notice of [this.#notice.root, this.#coinNotice, this.#invite.root]) {
      if (notice.hidden) { notice.style.top = ''; continue; }
      notice.style.top = `calc(100% + ${top}px)`;
      top += notice.offsetHeight + 4;
    }
  }

  /** Fold the bar away or bring it back (`state.barCollapsed`): folded, only its strip (`#expand`) and its notices show. */
  setCollapsed(collapsed: boolean): void {
    const held = this.root.contains(document.activeElement);
    this.root.classList.toggle('collapsed', collapsed);
    this.#collapse.setAttribute('aria-expanded', String(!collapsed));
    // A control of the bar that held the focus goes with the fold (the Hide button, or the Tour button after a tour that had unfolded the bar): the arrow that unfolds it takes the focus.
    if (collapsed && held) this.#expand.focus({ preventScroll: true });
  }

  /**
   * Open the Volume profile panel (from a band's header on the map, or a tag of what has no room) and show where each measure is drawn: a
   * band's settings live with the profile's, a click from where it is drawn. An open panel stays and only scrolls there.
   */
  openTradedPanel(): void {
    if (!this.#tradedPanel) this.#settingsKeys.traded.click();
    this.#tradedPanel?.body.querySelector('[data-section="placement"]')?.scrollIntoView({ block: 'start' });
  }

  /** The Tape view's choices (panes/candle-pane.ts `settingsFields`), a section of the phone's Settings; set by the page. */
  tapeFields: (() => [string, HTMLElement][]) | null = null;

  /** Put Recenter in a corner of the map `host` (on the full toolbar; the compact bar keeps it beside the timeframes). */
  placeRecenter(host: HTMLElement): void { this.#mapHost = host; this.#arrange(); }

  #arrange(): void {
    this.#recenter.classList.toggle('map-recenter', !compactBar() && this.#mapHost !== null);
    if (!compactBar()) {
      this.#sheet?.close();
      this.#fillHeatControls();
      const inCorner = this.#mapHost !== null;
      if (inCorner) { this.#mapTools.replaceChildren(this.#layoutCorner, this.#goto, this.#rangeCorner, ...(this.#drawCorner ? [this.#drawCorner] : []), this.#recenter); this.#mapHost!.prepend(this.#mapTools); }
      const host = this.#statusHost;
      // With a status bar the connection state, the language and theme buttons and Waves' lamp live there.
      host?.replaceChildren(this.#keys, this.#zone, this.#language, this.#theme, this.#glass);
      // A console of decks, each a framed group of what belongs together, at most two rows tall, wrapping as whole decks (Karl,
      // 2026-10-16: one wrapping row read as a jumble). The venues are switched from the Venues button, not listed as chips.
      setTip(this.#venuesButton!, t('Venues: switch each exchange on or off for the map, the book and the flow column, or choose which ones feed the page'));
      this.root.classList.add('cockpit');
      const sp = this.#splits!;
      // The name of the page is the last deck's title: what it holds is about the page itself (the guide, the author, installing it). The
      // arrow that folds the bar away sits on that deck's bottom edge, taking no width: room kept for it at the bar's end wrapped this deck
      // onto a second row at 1,600 px, doubling the bar, and the top edge holds the title.
      // Install stands before the screenshot mark, so that the mark keeps its place whether the browser offers installing or not (Install comes in beside Author).
      const tools = deck('tools', 'LiquidityMapperFast', [this.#tour, this.#guide], [this.#author, this.#install.root, this.#shot, ...(host ? [] : [this.#zone, this.#language, this.#theme, this.#glass, this.#status])]);
      tools.append(this.#collapse);
      this.#deckBreaks = []; this.#fitted = null; this.#fittedOrder = '';
      this.#decks = [
        deck('market', t('Market'), [this.#coin, this.#market], [this.#scope, this.#venuesButton!]),
        deck('time', t('Time'), [this.#timeframes], inCorner ? [] : [this.#recenter]),
        deck('heat', t('Heatmap'), [this.#source, this.#layer, this.#heat.style], [this.#heatScale, this.#heat.auto, this.#heat.smooth]),
        deck('panels', t('Panels'), [this.#toggles]),
        // The Range tool is the map corner's Select when the map holds its tools (Karl, 2026-10-27: the deck's Range was the same button twice).
        deck('chart', t('Chart'), [sp.footprint, sp.trades, sp.liquidations, sp.absorption], [sp.traded, sp.keyLevels, sp.vwap, this.#scriptsSplit, ...(inCorner ? [] : [this.#range])]),
        deck('alerts', t('Alerts'), [this.#alertSplits!.highlights], [this.#alertSplits!.sound]),
        tools];
      this.root.replaceChildren(...this.#decks, this.#expand, this.#notice.root, this.#coinNotice, this.#invite.root);
      this.#fit();
      return;
    }
    // A phone has Range in Settings and Recenter beside the timeframes: the map's corner stays clear.
    this.#mapTools.remove();
    setTip(this.#venuesButton!, t('Choose which exchanges feed the map. The choice is kept in this browser; nothing changes until you press Apply.'));
    this.root.classList.remove('cockpit');
    this.#unfit();
    this.root.replaceChildren(
      el('div', { class: 'tb-bar' },
        // The coin alone (Karl, 2026-10-17): the market is chosen in Settings, where the venues are.
        el('div', { class: 'tb-row tb-main' }, this.#brand, this.#coin, this.#spacer, this.#status, this.#more, this.#collapse),
        el('div', { class: 'tb-row tb-time' }, this.#timeframes, this.#recenter)),
      this.#expand, this.#notice.root, this.#coinNotice, this.#invite.root);
  }

  /**
   * Scale the full bar, or break it into rows, to fit its window (`fitBar`, bar-fit.ts). The decks are measured at their own size, the bar
   * laid out as one row at zoom 1 (`.fitting`); what is applied is `--bar-zoom` (the stylesheet's `zoom`), a break before each deck that begins
   * a row, and each deck's own width as how much it grows with its row (`--deck-grow`): the decks of a row grow by one factor, keeping their
   * proportions. Nothing is written when the answer is the one already applied, so a bar that has not changed does not move.
   */
  #fit(): void {
    const bar = this.root;
    // A bar folded away has no decks to measure (they are not laid out): its fit stays, and is right again the moment it unfolds.
    if (!bar.classList.contains('cockpit') || !bar.isConnected || bar.classList.contains('collapsed')) return;
    const decks = this.#decks.filter(d => d.parentElement === bar), ids = decks.map(d => d.dataset.deck ?? ''), style = getComputedStyle(bar);
    const gap = parseFloat(style.columnGap) || 0, pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    // The decks' own widths with the bar scaled by `zoom`, in the bar's own px: text drawn at a fractional zoom is a little wider than the
    // scale alone says (0.3 % for Latte at 0.86, 4 % for Japanese in the text-mode face), enough to push the last deck of a row that just
    // fits onto a row of its own (Karl, 2026-10-27).
    const measure = (zoom: number): { widths: number[]; available: number } => {
      bar.style.setProperty('--fit-zoom', String(zoom)); bar.classList.add('fitting');
      const widths = decks.map(d => d.getBoundingClientRect().width / zoom), available = bar.getBoundingClientRect().width;
      bar.classList.remove('fitting');
      return { widths, available };
    };
    // The bevel frame is not scaled: held, a button's borders go from 1 + 1 px to 2 + 0, and under a fractional zoom those snap apart (1 + 1 px, then 1 + 0:
    // the box loses a pixel when it is pressed or switched on). It takes the two balanced rows at its own size instead.
    const floor = document.documentElement.dataset.frame === 'bevel' ? 1 : BAR_ZOOM_FLOOR;
    const first = measure(1), available = first.available, measured = new Set([1]);
    let widths = first.widths, placed = arrangeBar(ids, widths, gap, pad, available, floor), fit = placed.fit;
    // A scaled bar is measured again at its scale, and fitted with each deck's widest width so far, until the scale it takes is one it was
    // measured at: what it is fitted with is never narrower than what it draws at that scale, so no row it is given overflows. A scale is a
    // hundredth from 1 down to the floor, so this ends within as many measurements (the bound is only a guard).
    for (let tries = 0; tries < 20 && !measured.has(fit.zoom); tries++) {
      const there = measure(fit.zoom).widths; measured.add(fit.zoom);
      widths = widths.map((w, k) => Math.max(w, there[k] ?? 0));
      placed = arrangeBar(ids, widths, gap, pad, available, floor); fit = placed.fit;
    }
    // Its own width is where it starts in its row, not what its contents would ask for (a grid of even columns asks for its widest times
    // their number), and half a pixel under it, so that rounding never moves a deck of a row that just fits onto the next: the row is broken
    // where the fit broke it. Written whenever it changes (a theme or a font can change a deck and not the fit), and only then, so a refit
    // that finds the same answer writes nothing.
    decks.forEach((d, k) => {
      const grow = String(Math.round(widths[k]!)), basis = `${Math.max(0, widths[k]! - 0.5).toFixed(2)}px`;
      if (d.style.getPropertyValue('--deck-grow') !== grow) d.style.setProperty('--deck-grow', grow);
      if (d.style.getPropertyValue('--deck-w') !== basis) d.style.setProperty('--deck-w', basis);
    });
    const was = this.#fitted, order = placed.order.join();
    if (was && was.zoom === fit.zoom && was.breaks.join() === fit.breaks.join() && this.#fittedOrder === order) return;
    this.#fitted = fit; this.#fittedOrder = order;
    bar.style.setProperty('--bar-zoom', String(fit.zoom));
    for (const b of this.#deckBreaks) b.remove();
    this.#deckBreaks = [];
    // The decks in the order taken, moving only those out of place (a deck moved loses the keyboard, which is given back).
    const active = document.activeElement, shown = placed.order.map(k => decks[k]!);
    shown.forEach((d, k) => { const here = bar.children[k]; if (here !== d) bar.insertBefore(d, here ?? null); });
    if (active instanceof HTMLElement && active !== document.activeElement && bar.contains(active)) active.focus({ preventScroll: true });
    for (const k of fit.breaks) {
      const at = shown[k]; if (!at) continue;
      const b = el('span', { class: 'deck-break', ariaHidden: 'true' }); at.before(b); this.#deckBreaks.push(b);
    }
    bar.classList.toggle('wrapped', this.#deckBreaks.length > 0);
  }
  /** The compact bar is not scaled or broken: what the full bar applied is let go. */
  #unfit(): void {
    this.root.style.removeProperty('--bar-zoom'); this.root.classList.remove('fitting', 'wrapped');
    for (const b of this.#deckBreaks) b.remove();
    this.#deckBreaks = []; this.#fitted = null; this.#fittedOrder = '';
  }

  #toggleSheet(): void {
    if (this.#sheet) { this.#sheet.close(); return; }
    // Settings is a list of labelled rows, each control the same element the desktop toolbar holds (see #arrange).
    const field = (label: string, control: HTMLElement, stacked = false): HTMLElement => el('div', { class: stacked ? 'sheet-field stack' : 'sheet-field' }, el('span', { class: 'sheet-label', textContent: label }), control);
    const section = (title: string, children: HTMLElement[], action?: HTMLElement): HTMLElement =>
      el('section', { class: 'sheet-sec' }, el('div', { class: 'sheet-sec-head' }, el('h4', { textContent: title }), ...(action ? [action] : [])), ...children);
    // The sheet's own heading says "Venues", so the button beside it says what it does.
    this.#venuesLabel.textContent = t('Choose…'); this.#venuesCount.hidden = true;
    this.#sheet = openSheet(t('Settings'), body => {
      this.#heatctl.replaceChildren();
      body.append(
        section(t('Tools'), [el('div', { class: 'sheet-tiles' }, this.#tour, this.#range, this.#guide, this.#shot, this.#author, this.#install.root)]),
        section(t('Panels'), [this.#toggles, el('p', { class: 'sheet-note', textContent: t('Depth, OI, Delta, L/S, LT and Stats each add a tab to the bar under the map.') })]),
        // A phone arranges its panes by tab; a touch tablet that keeps the desktop's arrangement has the layouts here, its map's corner being clear of buttons.
        ...(isPhone() ? [] : [section(t('Layouts'), [el('div', { class: 'sheet-tiles' }, button(t('Layouts'), () => { this.#sheet?.close(); this.#openLayouts(this.#more); }, t('Layouts: choose a ready-made arrangement of the panels, or save your own')))])]),
        section(t('Chart'), [el('div', { class: 'sheet-tiles' }, ...(['footprint', 'trades', 'liquidations', 'absorption', 'traded', 'keyLevels', 'vwap'] as const).map(f => this.#splits![f]), this.#scriptsSplit)]),
        // Only a phone has the Tape tab; a touch tablet keeps the desktop's panes and gets this sheet without it.
        ...(this.tapeFields && isPhone() ? [section(t('Tape'), this.tapeFields().map(([label, control]) => field(label, control)), helpButton('candlePane'))] : []),
        section(t('Heatmap'), [
          field(t('Layer'), this.#layer), field(t('Source'), this.#source), field(t('Colours'), this.#heat.style),
          field(t('Contrast'), this.#heatScale, true), field(t('Colour range'), this.#heat.auto), field(t('Smoothing'), this.#heat.smooth)], helpButton('heatmap')),
        section(t('Venues'), [field(t('Market'), this.#market, true), field(t('Markets'), this.#scope, true), el('div', { class: 'sheet-chips' }, this.#chips, this.#blocked)], this.#venuesButton!),
        section(t('Alerts'), [el('div', { class: 'sheet-tiles' }, this.#alertSplits!.highlights, this.#alertSplits!.sound)]),
        section(t('Appearance'), [field(t('Language'), this.#language), field(t('Theme'), this.#theme),
          field(t('Waves'), el('label', { class: 'switch', tip: t('Waves: the bars and panels around the chart turn to glass; large orders and large flow changes light it and send waves across the screen') }, this.#glassSwitch, el('i'))), field(t('Time zone'), this.#zone),
          ...(wakeLockSupported() ? [field(t('Keep screen on'), el('label', { class: 'switch', tip: t('Stops the screen turning off while this page is open. A screen that sleeps stops the recording, and the map then has a gap where it was.') }, this.#awake, el('i')))] : [])]));
    }, () => { this.#sheet = null; this.#more.classList.remove('open'); this.#venuesLabel.textContent = t('Venues'); this.#venuesCount.hidden = false; });
    this.#more.classList.add('open');
  }

  /** Update controls from state; `window` is the USD range currently mapped onto the colour ramp. Only touches DOM that changed, so open dropdowns and clicks survive 4 Hz data frames. */
  sync(state: AppState, window: { lo: number; hi: number }): void {
    const instruments = state.markets.filter(m => m.instrumentId);
    const marketKey = instruments.map(m => m.instrumentId).join(',');
    if (this.#market.dataset.key !== marketKey) {
      // Short on both bars: the phone's has room for about two dozen characters, and the full one's sits in a deck titled Market. So
      // "perpetual" becomes "perp".
      const label = (m: (typeof instruments)[number]): string => {
        const venue = venueLabel(m.instrumentId ?? ''), symbol = String(m.symbol ?? m.instrumentId);
        const kind = m.marketType === 'perpetual' ? t('perpetual') : m.marketType === 'spot' ? t('spot') : m.marketType ?? '';
        // A symbol that already says "PERP" needs no type after it.
        const type = m.marketType === 'perpetual' ? (/perp/i.test(symbol) ? '' : t('perp')) : kind;
        return [venue, symbol, type].filter(Boolean).join(' ');
      };
      this.#market.replaceChildren(...instruments.map(m => new Option(label(m), m.instrumentId)));
      this.#market.dataset.key = marketKey;
    }
    setValue(this.#market, state.marketId);
    [...this.#timeframes.children].forEach(b => { if (b !== this.#chartType) b.classList.toggle('on', b.textContent === state.timeframe); });
    if (this.#chartType.dataset.type !== state.chartType) {
      this.#chartType.dataset.type = state.chartType;
      this.#chartType.replaceChildren(chartTypeGlyph(state.chartType));
      setTip(this.#chartType, `${chartTypeTip(state.chartType)} ${t('Click for the other ways to draw the price.')}`);
    }
    setValue(this.#layer, state.layer);
    this.#toggleButtons.forEach((b, i) => b.classList.toggle('on', state.show[PANE_TOGGLES[i]![0]]));
    lamp(this.#heat.auto, state.heat.auto); lamp(this.#trades, state.show.bubbles); lamp(this.#liquidations, state.liquidations.on); lamp(this.#absorption, state.absorption.on); lamp(this.#highlights, state.highlight.on); lamp(this.#traded, state.show.traded); lamp(this.#keyLevels, state.keyLevels.on); lamp(this.#vwap, state.vwap.on); lamp(this.#scripts, state.show.script); lamp(this.#footprint, state.show.footprint); lamp(this.#range, state.rangeTool || state.range !== null); lamp(this.#rangeCorner, state.rangeTool || state.range !== null);
    if (this.#awake.checked !== state.keepAwake) this.#awake.checked = state.keepAwake;
    lamp(this.#glass, state.material === 'glass');
    if (this.#glassSwitch.checked !== (state.material === 'glass')) this.#glassSwitch.checked = state.material === 'glass';
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
    const sourceKey = books.map(b => b.id).join(',');
    if (this.#source.dataset.key !== sourceKey) {
      // The phone's Settings and the full bar's deck already say "Heatmap" above this choice.
      this.#source.replaceChildren(new Option(t('Aggregated'), 'aggregated'), ...books.map(b => new Option(venueLabel(b.id), b.id)));
      this.#source.dataset.key = sourceKey;
    }
    const shown = heatmapSourceOf(state);
    setValue(this.#source, shown);
    const venues = [...new Set(books.map(b => b.venue))];
    this.#drawn = new Set(venues); this.#showIdle(this.#drawn);
    this.#venueList = venues;
    const count = venues.length ? `${venues.filter(v => !state.disabledVenues.includes(v)).length}/${venues.length}` : '';
    if (this.#venuesCount.textContent !== count) this.#venuesCount.textContent = count;
    const scoped = (v: string) => !scopedOut(state, v);
    const counts = scopeCounts(state);
    [...this.#scope.children].forEach((b, i) => { const [value] = SCOPE_OPTIONS[i]!; b.classList.toggle('on', state.scope === value); setTip(b as HTMLElement, value === 'all' ? t('Every enabled venue') : (value === 'spot' ? t('Spot venues only ({n} enabled)', { n: counts[value] }) : t('Perpetual venues only ({n} enabled)', { n: counts[value] }))); });
    this.#scope.classList.toggle('inert', shown !== 'aggregated');
    // The full bar shows a handful of chips and puts the rest in a menu; the phone's Settings sheet has room for every one.
    const plan = chipPlan(venues, compactBar() ? Infinity : INLINE_CHIPS);
    const chipOf = (v: string): HTMLElement => el('button', { class: (state.disabledVenues.includes(v) ? 'chip off' : 'chip') + (scoped(v) ? '' : ' scoped-out'), tip: t('Show / hide this venue'),
      onclick: () => this.store.set(chipClick(this.store.state, v)) }, venueMark(v, 13), venueLabel(v));
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
      el('button', { type: 'button', textContent: t('Choose…'), tip: t('Choose which exchanges feed the map. The choice is kept in this browser; nothing changes until you press Apply.'), onclick: () => { this.#venueMenu?.close(); this.#openFeeds(); } }),
      el('button', { type: 'button', textContent: t('All on'), tip: t('Show every venue'), onclick: () => this.store.set({ disabledVenues: [] }) }),
      el('button', { type: 'button', textContent: t('All off'), tip: t('Hide every venue'), onclick: () => this.store.set({ disabledVenues: [...venues] }) }));
    body.replaceChildren(note(t('Chips are switches: a venue that is off keeps its book but is left out of the map, the book and the flow column.')));
    // On the full bar the venues that cannot be reached are said here, not beside the button: the bar must not change its width for them.
    if (!compactBar() && this.#blocked.childElementCount) body.append(el('div', { class: 'sheet-chips' }, this.#blocked));
    for (const group of exchangeGroups(venues)) {
      const head = heading(venueLabel(group.key)); head.prepend(venueMark(group.key, 13));
      body.append(head);
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
      ...blocked.map(v => el('span', { class: 'chip blocked', tip: `${v.name}: ${VPN_HINT}` }, el('i', { class: 'chip-mark mark-ban', ariaHidden: 'true' }), v.name)),
      ...shown.map(v => el('span', { class: v.kind === 'faulty' ? 'chip blocked faulty' : 'chip blocked', tip: idleText(v) }, el('i', { class: `chip-mark ${v.kind === 'faulty' ? 'mark-warn' : 'mark-wait'}`, ariaHidden: 'true' }), v.name)));
    if (this.#venuesButton) { const state = this.#blocked.childElementCount ? 'warn' : ''; if ((this.#venuesButton.dataset.state ?? '') !== state) this.#venuesButton.dataset.state = state; }
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
    openMenu(this.#theme, items, this.store.state.theme, { onPreview: id => this.onPreviewTheme(id), onSelect: id => this.store.set({ theme: id, themePicked: true }) });
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
      sizeRow(t('Smallest order'), t('Orders under this are not drawn. Every order from {floor} is recorded, so a lower choice brings them back.', { floor: `$${usd(scaledUsd(BUBBLE_MINIMUMS[0]!))}` }),
        { sign: '≥', value: scaledUsd(b.minUsd), presets: BUBBLE_MINIMUMS.map(scaledUsd), min: scaledUsd(BUBBLE_MINIMUMS[0]!), max: scaledUsd(SIZE_MAX_USD) }, v => set({ minUsd: unscaledUsd(v) })),
      selectRow(t('Side'), t('Both sides, or only the market buys or only the market sells.'), [['both', t('Both')], ['buy', t('Buys only')], ['sell', t('Sells only')]], b.side, v => set({ side: v === 'buy' || v === 'sell' ? v : 'both' })),
      rangeRow(t('Bubble size'), t('Every bubble larger or smaller; their sizes keep their proportions.'), { min: L.scale.min, max: L.scale.max, step: L.scale.step, value: b.scale, format: v => `×${v.toFixed(1)}` }, scale => set({ scale })),
      rangeRow(t('Opacity'), t('How solid the bubbles are: lower lets the map and the candles show through.'), { min: L.opacity.min, max: L.opacity.max, step: L.opacity.step, value: b.opacity, format: v => `${Math.round(v * 100)}%` }, opacity => set({ opacity })),
      switchRow(t('Write the size in large bubbles'), t('Only bubbles big enough to hold the number get one, so zooming out drops them; hover or tap any bubble for its size.'), b.labels, labels => set({ labels })),
      switchRow(t('Show the exchange in each bubble'), t('Its mark in the middle of every bubble large enough to hold it. Hover a bubble and the other venues step back, so the places that venue traded stand out.'), b.marks, marks => set({ marks })),
      switchRow(t('Live trades'), t('Every market order as it arrives, as a dot at its own exchange\'s price (the fills of one order added together), with the chart market\'s price line through them. Kept in this page only: a reload starts empty.'), b.live, live => { set({ live }); rebuild(); }),
    );
    if (b.live) body.append(
      rangeRow(t('Live trades opacity'), t('How strong the dots are. Where orders crowd together their volume adds up, so busy prices show stronger.'), { min: L.liveOpacity.min, max: L.liveOpacity.max, step: L.liveOpacity.step, value: b.liveOpacity, format: v => `${Math.round(v * 100)}%` }, liveOpacity => set({ liveOpacity })),
      switchRow(t('Venue lines'), t('A faint price line for every other exchange too. Their prices differ a little, so the lines stack.'), b.venueLines, venueLines => set({ venueLines })),
    );
    const whale = this.store.state.sounds.tiers[2]?.usd;
    if (whale) body.append(note(t('Orders from the Whale size in Sounds ({value}) get a bright ring.', { value: `$${usd(scaledUsd(whale))}` })));
    body.append(note(t('These settings change only the bubbles: sounds and the flow column\'s dots keep their own sizes.')));
  }

  /** The liquidations' settings: whether they show, the smallest drawn, the side, their size and labels, and which venues report them. */
  #buildLiquidations(tools: HTMLElement, body: HTMLElement, rebuild: () => void): void {
    const s = this.store.state.liquidations, L = LIQUIDATION_LIMITS;
    tools.append(helpButton('liquidations'));
    const set = (change: Partial<LiquidationSettings>): void => { this.store.set({ liquidations: { ...this.store.state.liquidations, ...change } }); };
    body.append(
      switchRow(t('Show liquidations'), t('Positions the exchanges closed by force, where the market was when it happened.'), s.on, on => { set({ on }); rebuild(); }),
      sizeRow(t('Smallest liquidation'), t('Smaller ones are not drawn. Every one from {floor} is recorded, so a lower choice brings them back.', { floor: `$${usd(scaledUsd(LIQUIDATION_MINIMUMS[0]!))}` }),
        { sign: '≥', value: scaledUsd(s.minUsd), presets: LIQUIDATION_MINIMUMS.map(scaledUsd), min: scaledUsd(LIQUIDATION_MINIMUMS[0]!), max: scaledUsd(SIZE_MAX_USD) }, v => set({ minUsd: unscaledUsd(v) })),
      selectRow(t('Side'), t('Both, or only the longs closed (forced selling) or only the shorts closed (forced buying).'), [['both', t('Both')], ['long', t('Longs closed')], ['short', t('Shorts closed')]], s.side, v => set({ side: v === 'long' || v === 'short' ? v : 'both' })),
      rangeRow(t('Size'), t('Every diamond larger or smaller; their sizes keep their proportions.'), { min: L.scale.min, max: L.scale.max, step: L.scale.step, value: s.scale, format: v => `×${v.toFixed(1)}` }, scale => set({ scale })),
      switchRow(t('Write the size beside the larger ones'), t('Only where it fits; hover or tap any diamond for its size.'), s.labels, labels => set({ labels })),
    );
    // Which of the venues switched on report them at all: said here, not on the chart.
    const state = this.store.state, markets = activeIds(state).map(id => ({ venue: id.slice(0, id.indexOf(':')), spot: kindOf(state.markets, id) === 'spot' }));
    for (const line of coverageLines(markets)) body.append(note(line.text));
    if (this.sourceKind !== 'server') body.append(note(t('This page reads the exchanges itself and keeps liquidations only while it is open.')));
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
