import { TIMEFRAMES } from './hub.ts';
import { PALETTES, THEME_ORDER } from './theme.ts';
import { AVAILABLE_LAYERS, type Store, type AppState, type Layer } from './store.ts';
import { VPN_HINT, VenueNotice, blockedVenues, idleText, idleVenues } from './venue-notice.ts';
import type { VenueEntry } from './source.ts';
import { usd } from './format.ts';
import { venueLabel } from './panes/ladder-pane.ts';
import { el } from './dom.ts';
import { setTip } from './tip.ts';
import { InstallButton } from './install.ts';
import { toggleAuthor } from './author.ts';
import { HELP, helpButton, showGuide, type HelpId } from './help.ts';
import { openVenueDialog } from './venue-dialog.ts';
import type { VenueControl } from './source.ts';
import { coverage } from './panes/levels-data.ts';
import { SCOPE_OPTIONS, chipClick, kindOf, scopeCounts, scopedOut } from './scope.ts';
import { HIGHLIGHT_LIMITS } from './anomaly.ts';
import { rangeRow, switchRow, note, togglePanel } from './ui.ts';
import { openMenu } from './menu.ts';
import { buildSoundPanel } from './sound/panel.ts';
import type { Sounds } from './sound/sounds.ts';
import type { Panel } from './ui.ts';
import { HEAT_STYLES, legendBackground, type HeatStyleId } from './heatmap/lut.ts';
import { CONTRAST } from './heatmap/window.ts';
import { compactBar, onLayoutMode } from './device.ts';
import { openSheet, type Sheet } from './sheet.ts';
import { wakeLockSupported } from './wake.ts';

/** How a timeframe is said in a tooltip. */
const TIMEFRAME_NAMES: Readonly<Record<string, string>> = { '1m': '1-minute', '5m': '5-minute', '15m': '15-minute', '30m': '30-minute', '1h': '1-hour', '4h': '4-hour', '1d': 'Daily' };
const LAYERS: [Layer, string][] = [['liquidity', 'Liquidity'], ['liquidation', 'Liquidation'], ['stopLoss', 'Stop loss'], ['takeProfit', 'Take profit']];
/** A chosen venue that has no book for this long gets a chip saying so (a start-up that is merely slow does not). */
const IDLE_GRACE_MS = 20_000;
/** What the dropdown says next to a layer that cannot be chosen yet. */
const UPCOMING = 'upcoming';

/** Assign a form control's value only when it differs: assigning to an open select closes its popup. */
function setValue(control: HTMLSelectElement | HTMLInputElement, value: string): void { if (control.value !== value) control.value = value; }

/** Top bar: market, timeframe, layer, pane toggles, heatmap colour, venues, theme. */
export class Toolbar {
  readonly root = el('header', { class: 'toolbar' });
  #market = el('select', { class: 'market', ariaLabel: 'Market', tip: "Market: whose candles, footprint and open interest the chart shows. The heatmap always combines every enabled venue's book, whatever is chosen here." });
  #timeframes = el('div', { class: 'seg' });
  #layer = el('select', { ariaLabel: 'Layer', tip: 'Layer drawn on the map. Liquidity is the order-book heatmap; liquidation, stop-loss and take-profit layers are upcoming (they need data a static page cannot hold a key for).' });
  #toggles = el('div', { class: 'seg toggles' });
  #chips = el('div', { class: 'chips' });
  /** Venues this location cannot reach, beside the live ones, so their absence is explained where it is noticed. */
  #blocked = el('div', { class: 'chips blocked-chips' });
  readonly #notice = new VenueNotice();
  readonly #install = new InstallButton();
  #guide = el('button', { type: 'button', class: 'guide-btn', textContent: 'Guide', tip: 'A ten-minute tour of what everything is and how to use it, with moving pictures. Every button also explains itself on hover.', onclick: () => { showGuide(); } });
  #shot = el('button', { type: 'button', class: 'icon-btn', ariaLabel: 'Screenshot', tip: 'Take a picture of the chart (keyboard: S): select an area or click a pane, draw on it, hide anything private with pixelate or blur, then copy or save it.', onclick: () => { void import('./screenshot/editor.ts').then(m => m.startScreenshot()); } });
  #author = el('button', { type: 'button', textContent: 'Author', tip: 'Who made this, and where to find the code. Free, no sign-ups, open source.' });
  #scope = el('div', { class: 'seg scope', tip: 'Which markets the liquidity views draw. A filter on the enabled venues: it never switches a venue on or off.' });
  #soundButton = el('button', { class: 'sound-btn', textContent: 'Sound', tip: 'Sound notifications' });
  #soundPanel: Panel | null = null;
  #sounds: Sounds | null = null;
  #highlights = el('button', { textContent: 'Highlights', tip: 'What stands out: unusual volume, open-interest changes and depth imbalance' });
  #heat = {
    style: el('select', { ariaLabel: 'Colours', tip: `Heatmap colouring. ${HEAT_STYLES.map(s => `${s.label}: ${s.title}.`).join(' ')}` }),
    lo: el('i'), hi: el('i'), legend: el('span', { class: 'legend' }),
    contrast: el('input', { type: 'range', min: String(CONTRAST.min), max: String(CONTRAST.max), step: '1', tip: 'Contrast: right reveals thinner liquidity, left keeps only the biggest walls, and the far left tones even those down. Double-click to reset.' }),
    smooth: el('select', { ariaLabel: 'Smoothing', tip: 'Vertical smoothing when price rows get thin (zoomed out): Auto smooths with a ~5 px Gaussian below 15 px per row, as Bookmap does, so far walls stay visible; Off draws every row exactly.' }),
    auto: el('button', { textContent: 'Auto', tip: 'Auto: the colour window follows the data (recomputed on recenter, market change, zoom and every 10 s). Off: it stays where it is.' }),
  };
  #source = el('select', { ariaLabel: 'Source', tip: 'Heatmap source' });
  #theme = el('button', { class: 'theme-btn', tip: 'Theme: hover to preview, click to keep' });
  #status = el('span', { class: 'status', tip: 'Connection to the data source: live when frames are arriving.' });
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
  #more = el('button', { type: 'button', class: 'more-btn', ariaLabel: 'Settings', tip: 'Settings: panels, heatmap colouring, venues, sound, theme and the guide.' });
  #sheet: Sheet | null = null;
  /** Settings' "Keep screen on" switch (only where the browser can hold the screen awake). */
  #awake = el('input', { type: 'checkbox' });
  #recenter = el('button', { textContent: 'Recenter', tip: 'Jump back to the live edge and fit the price range to the recent candles (keyboard: R, Home, or double-click the chart).' });
  onRecenter: () => void = () => {};
  /** Preview a theme without keeping it (`null` puts the saved one back). */
  onPreviewTheme: (id: string | null) => void = () => {};
  onSelectMarket: (id: string) => void = () => {};
  /** The person applied a venue selection (a server brings the new feeds up some seconds later). */
  onVenuesApplied: () => void = () => {};

  constructor(private store: Store, private venueControl: VenueControl) {
    this.#market.onchange = () => this.onSelectMarket(this.#market.value);
    for (const tf of Object.keys(TIMEFRAMES)) this.#timeframes.append(el('button', { textContent: tf, tip: `${TIMEFRAME_NAMES[tf] ?? tf} candles. The footprint, the bar stats and the open-interest bars follow this too.`, onclick: () => this.store.set({ timeframe: tf }) }));
    for (const [id, label] of LAYERS) {
      const available = AVAILABLE_LAYERS.includes(id), option = new Option(available ? label : `${label} · ${UPCOMING}`, id);
      option.disabled = !available;
      this.#layer.append(option);
    }
    this.#layer.onchange = () => this.store.set({ layer: this.#layer.value as Layer });
    for (const [key, label] of [['profile', 'Profile'], ['depth', 'Depth'], ['oi', 'OI'], ['candles', 'Candles'], ['footprint', 'Footprint'], ['lt', 'LT'], ['mirror', 'Mirror'], ['volume', 'Volume'], ['bubbles', 'Trades']] as const)
      this.#toggles.append(el('button', { textContent: label, tip: HELP[key === 'bubbles' ? 'bubbles' : key as HelpId].tip, onclick: () => this.store.set({ show: { ...this.store.state.show, [key]: !this.store.state.show[key] } }) }));
    for (const [value, label] of SCOPE_OPTIONS) this.#scope.append(el('button', { textContent: label, onclick: () => this.store.set({ scope: value }) }));
    this.#soundButton.onclick = () => {
      const sounds = this.#sounds; if (!sounds) return;
      const build = (tools: HTMLElement, body: HTMLElement): void => buildSoundPanel(this.store, sounds, () => this.#soundPanel?.render(build), tools, body);
      this.#soundPanel = togglePanel(this.#soundButton, { title: 'Sounds', width: 420, align: 'left', onClose: () => { this.#soundPanel = null; } }, build);
    };
    this.#highlights.onclick = () => { togglePanel(this.#highlights, { title: 'Highlights', width: 380, align: 'left' }, (tools, body) => this.#buildHighlights(tools, body)); };
    for (const style of HEAT_STYLES) this.#heat.style.append(new Option(style.label, style.id));
    this.#heat.style.onchange = () => this.store.set({ heat: { ...this.store.state.heat, style: this.#heat.style.value as HeatStyleId } });
    this.#heat.contrast.oninput = () => this.store.set({ heat: { ...this.store.state.heat, contrast: Number(this.#heat.contrast.value) } });
    this.#heat.contrast.ondblclick = () => this.store.set({ heat: { ...this.store.state.heat, contrast: CONTRAST.neutral } });
    for (const [value, label] of [['auto', 'Smooth: auto'], ['off', 'Smooth: off']] as const) this.#heat.smooth.append(new Option(label, value));
    this.#heat.smooth.onchange = () => this.store.set({ heat: { ...this.store.state.heat, smooth: this.#heat.smooth.value as 'auto' | 'off' } });
    this.#heat.auto.onclick = () => this.store.set({ heat: { ...this.store.state.heat, auto: !this.store.state.heat.auto } });
    this.#heat.legend.append(this.#heat.lo, this.#heat.hi);
    this.#source.onchange = () => this.store.set({ heatmapSource: this.#source.value });
    this.#theme.onclick = () => this.#openThemes();
    this.#recenter.onclick = () => this.onRecenter();
    this.#author.onclick = () => { toggleAuthor(this.#author); };
    this.#shot.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3V19H4z"/><circle cx="12" cy="13.4" r="3.3"/></svg>';
    this.venueControl.watch?.(entries => { this.#entries = entries; this.#notice.update(entries); this.#showIdle(this.#drawn); });
    const venues = el('button', { textContent: 'Venues', tip: 'Choose which exchanges feed the map. The choice is kept in this browser; nothing changes until you press Apply.', onclick: () => void openVenueDialog(this.venueControl, () => this.#selectionProduct(), () => this.onVenuesApplied()) });
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

  #arrange(): void {
    if (!compactBar()) {
      this.#sheet?.close();
      this.#fillHeatControls();
      this.root.replaceChildren(this.#brand, this.#market, this.#venuesButton!, this.#source, this.#timeframes, this.#layer, this.#toggles, this.#highlights, this.#soundButton,
        this.#heatctl, this.#scope, this.#chips, this.#blocked, this.#recenter, this.#spacer, this.#install.root, this.#guide, this.#shot, this.#author, this.#theme, this.#status, this.#notice.root);
      return;
    }
    this.root.replaceChildren(
      el('div', { class: 'tb-bar' },
        el('div', { class: 'tb-row tb-main' }, this.#brand, this.#market, this.#spacer, this.#status, this.#more),
        el('div', { class: 'tb-row tb-time' }, this.#timeframes, this.#recenter)),
      this.#notice.root);
  }

  #toggleSheet(): void {
    if (this.#sheet) { this.#sheet.close(); return; }
    // Settings is a list of labelled rows, each control the same element the desktop toolbar holds (see #arrange).
    const field = (label: string, control: HTMLElement, stacked = false): HTMLElement => el('div', { class: stacked ? 'sheet-field stack' : 'sheet-field' }, el('span', { class: 'sheet-label', textContent: label }), control);
    const section = (title: string, children: HTMLElement[], action?: HTMLElement): HTMLElement =>
      el('section', { class: 'sheet-sec' }, el('div', { class: 'sheet-sec-head' }, el('h4', { textContent: title }), ...(action ? [action] : [])), ...children);
    // The sheet's own heading says "Venues", so the button beside it says what it does.
    this.#venuesButton!.textContent = 'Choose…';
    this.#sheet = openSheet('Settings', body => {
      this.#heatctl.replaceChildren();
      body.append(
        section('Tools', [el('div', { class: 'sheet-tiles' }, this.#guide, this.#shot, this.#author, this.#install.root)]),
        section('Show', [this.#toggles, el('p', { class: 'sheet-note', textContent: 'Depth, OI, LT and Footprint each add a tab to the bar under the map.' })]),
        section('Heatmap', [
          field('Layer', this.#layer), field('Source', this.#source), field('Colours', this.#heat.style),
          field('Contrast', this.#heatScale, true), field('Colour range', this.#heat.auto), field('Smoothing', this.#heat.smooth)], helpButton('heatmap')),
        section('Venues', [field('Markets', this.#scope, true), el('div', { class: 'sheet-chips' }, this.#chips, this.#blocked)], this.#venuesButton!),
        section('Alerts', [el('div', { class: 'sheet-tiles' }, this.#highlights, this.#soundButton)]),
        section('Appearance', [field('Theme', this.#theme),
          ...(wakeLockSupported() ? [field('Keep screen on', el('label', { class: 'switch', tip: 'Stops the screen turning off while this page is open. A screen that sleeps stops the recording, and the map then has a gap where it was.' }, this.#awake, el('i')))] : [])]));
    }, () => { this.#sheet = null; this.#more.classList.remove('open'); this.#venuesButton!.textContent = 'Venues'; });
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
        if (!short) return `${venue} · ${symbol} · ${m.marketType ?? ''}`;
        // A symbol that already says "PERP" needs no type after it.
        const type = m.marketType === 'perpetual' ? (/perp/i.test(symbol) ? '' : 'perp') : m.marketType ?? '';
        return [venue, symbol, type].filter(Boolean).join(' ');
      };
      this.#market.replaceChildren(...instruments.map(m => new Option(label(m), m.instrumentId)));
      this.#market.dataset.key = marketKey;
    }
    setValue(this.#market, state.marketId);
    [...this.#timeframes.children].forEach(b => b.classList.toggle('on', b.textContent === state.timeframe));
    setValue(this.#layer, state.layer);
    [...this.#toggles.children].forEach((b, i) => b.classList.toggle('on', state.show[(['profile', 'depth', 'oi', 'candles', 'footprint', 'lt', 'mirror', 'volume', 'bubbles'] as const)[i]!]));
    this.#heat.auto.classList.toggle('on', state.heat.auto);
    if (this.#awake.checked !== state.keepAwake) this.#awake.checked = state.keepAwake;
    setValue(this.#heat.smooth, state.heat.smooth);
    setValue(this.#heat.style, state.heat.style); setValue(this.#heat.contrast, String(state.heat.contrast));
    const legendKey = `${state.heat.style}|${state.theme}`;
    if (this.#heat.legend.dataset.key !== legendKey) { this.#heat.legend.dataset.key = legendKey; this.#heat.legend.style.background = legendBackground(state.heat.style, PALETTES[state.theme] ?? PALETTES.light!); }
    const lo = usd(window.lo), hi = usd(window.hi);
    if (this.#heat.lo.textContent !== lo) this.#heat.lo.textContent = lo;
    if (this.#heat.hi.textContent !== hi) this.#heat.hi.textContent = hi;
    this.#showTheme(state.theme);
    const soundState = !state.sounds.on ? 'off' : state.soundState !== 'running' ? 'locked' : 'on';
    if (this.#soundButton.dataset.state !== soundState) {
      this.#soundButton.dataset.state = soundState;
      setTip(this.#soundButton, soundState === 'off' ? 'Sound notifications: off' : soundState === 'locked' ? 'Sound is on but the browser keeps audio locked until you click or press a key on the page' : 'Sound notifications: on');
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
      const prefix = short ? '' : 'Heatmap: ';
      this.#source.replaceChildren(new Option(`${prefix}${short ? 'Aggregated' : 'aggregated'}`, 'aggregated'), ...books.map(b => new Option(`${prefix}${venueLabel(b.id)}`, b.id)));
      this.#source.dataset.key = sourceKey;
    }
    setValue(this.#source, books.some(b => b.id === state.heatmapSource) ? state.heatmapSource : 'aggregated');
    const venues = [...new Set(books.map(b => b.venue))];
    this.#drawn = new Set(venues); this.#showIdle(this.#drawn);
    const scoped = (v: string) => !scopedOut(state, v);
    const counts = scopeCounts(state);
    [...this.#scope.children].forEach((b, i) => { const [value] = SCOPE_OPTIONS[i]!; b.classList.toggle('on', state.scope === value); setTip(b as HTMLElement, value === 'all' ? 'Every enabled venue' : `${value === 'spot' ? 'Spot' : 'Perpetual'} venues only (${counts[value]} enabled)`); });
    this.#scope.classList.toggle('inert', state.heatmapSource !== 'aggregated');
    const chipKey = venues.map(v => v + (state.disabledVenues.includes(v) ? '-' : '+') + (scoped(v) ? 's' : 'x')).join(',');
    if (this.#chips.dataset.key !== chipKey) {
      this.#chips.dataset.key = chipKey;
      this.#chips.replaceChildren(...venues.map(v => el('button', { class: (state.disabledVenues.includes(v) ? 'chip off' : 'chip') + (scoped(v) ? '' : ' scoped-out'), textContent: venueLabel(v), tip: 'Show / hide this venue',
        onclick: () => this.store.set(chipClick(this.store.state, v)) })));
    }
    setTip(this.#scope, state.heatmapSource === 'aggregated' ? 'Which markets the liquidity views draw (a filter on the enabled venues; it never switches one on or off)' : 'The heatmap shows a single venue, so this filter only affects the profile, depth, ladder and LT');
    // Tooltips carry each venue's book reach, so a thin book on the map is explained by its feed.
    venues.forEach((v, i) => {
      const cov = coverage(books.find(b => b.venue === v), state.mark.price);
      const kind = kindOf(state.markets, books.find(b => b.venue === v)?.id ?? '');
      const title = !scoped(v)
        ? `${venueLabel(v)} is ${kind === 'spot' ? 'a spot' : kind === 'perp' ? 'a perpetual' : 'an unclassified'} venue, so the ${state.scope === 'spot' ? 'Spot' : 'Perp'} filter hides it. Click to show it: the filter goes back to Both.`
        : cov ? `${venueLabel(v)}: ${cov.levels} levels, reaches ${Math.round(cov.bp / 2)} bp each side. Click to show / hide.` : 'Show / hide this venue';
      const chip = this.#chips.children[i] as HTMLElement | undefined;
      if (chip && chip.dataset.tip !== title) setTip(chip, title);
    });
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
  #openThemes(): void {
    const items = THEME_ORDER.map(id => { const p = PALETTES[id]!; return { id, label: p.label, swatch: [p.bg, p.panel, p.text, p.bid, p.ask] }; });
    openMenu(this.#theme, items, this.store.state.theme, { onPreview: id => this.onPreviewTheme(id), onSelect: id => this.store.set({ theme: id }) });
  }

  #buildHighlights(_tools: HTMLElement, body: HTMLElement): void {
    const set = (change: Partial<AppState['highlight']>) => this.store.set({ highlight: { ...this.store.state.highlight, ...change } });
    const h = this.store.state.highlight;
    body.append(
      switchRow('Highlight what stands out', 'Unusual volume, open-interest changes and depth imbalance are drawn at full strength; the rest is dimmed.', h.on, on => set({ on })),
      rangeRow('Sensitivity', 'How far above its recent average something must be: lower flags more, higher flags only the extremes.', { ...HIGHLIGHT_LIMITS.mult, value: h.mult, format: v => `${v}σ` }, mult => set({ mult })),
      rangeRow('Baseline', 'How many preceding bars the average and spread are taken from.', { ...HIGHLIGHT_LIMITS.length, value: h.length, format: v => `${v} bars` }, length => set({ length })),
      note('A bar is flagged when its value exceeds the mean plus the sensitivity times the standard deviation of the bars before it. The bar itself never raises its own threshold, and nothing is flagged until a dozen bars exist.'),
    );
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
