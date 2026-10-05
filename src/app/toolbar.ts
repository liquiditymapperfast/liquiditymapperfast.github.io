import { TIMEFRAMES } from './hub.ts';
import { PALETTES, THEME_ORDER } from './theme.ts';
import type { Store, AppState, Layer } from './store.ts';
import { usd } from './format.ts';
import { venueLabel } from './panes/ladder-pane.ts';
import { el } from './dom.ts';
import { openVenueDialog } from './venue-dialog.ts';
import { coverage } from './panes/levels-data.ts';
import { SCOPE_OPTIONS, inScope, scopeCounts } from './scope.ts';
import { HIGHLIGHT_LIMITS } from './anomaly.ts';
import { rangeRow, switchRow, note, togglePanel } from './ui.ts';
import { openMenu } from './menu.ts';
import { buildSoundPanel } from './sound/panel.ts';
import type { Sounds } from './sound/sounds.ts';
import type { Panel } from './ui.ts';
import { HEAT_STYLES, legendBackground, type HeatStyleId } from './heatmap/lut.ts';

const LAYERS: [Layer, string][] = [['liquidity', 'Liquidity'], ['liquidation', 'Liquidation'], ['stopLoss', 'Stop loss'], ['takeProfit', 'Take profit']];

/** Assign a form control's value only when it differs: assigning to an open select closes its popup. */
function setValue(control: HTMLSelectElement | HTMLInputElement, value: string): void { if (control.value !== value) control.value = value; }

/** Top bar: market, timeframe, layer, pane toggles, heatmap colour, venues, theme. */
export class Toolbar {
  readonly root = el('header', { class: 'toolbar' });
  #market = el('select', { class: 'market' });
  #timeframes = el('div', { class: 'seg' });
  #layer = el('select');
  #toggles = el('div', { class: 'seg toggles' });
  #chips = el('div', { class: 'chips' });
  #scope = el('div', { class: 'seg scope', title: 'Which markets the liquidity views draw. A filter on the enabled venues: it never switches a venue on or off.' });
  #soundButton = el('button', { class: 'sound-btn', textContent: 'Sound', title: 'Sound notifications' });
  #soundPanel: Panel | null = null;
  #sounds: Sounds | null = null;
  #highlights = el('button', { textContent: 'Highlights', title: 'What stands out: unusual volume, open-interest changes and depth imbalance' });
  #heat = {
    style: el('select', { title: 'Heatmap colouring' }),
    lo: el('i'), hi: el('i'), legend: el('span', { class: 'legend' }),
    contrast: el('input', { type: 'range', min: '0', max: '100', step: '1', title: 'Contrast: right reveals thinner liquidity, left keeps only the biggest walls. Double-click to reset.' }),
    smooth: el('select', { title: 'Vertical smoothing when price rows get thin (zoomed out): Auto smooths with a ~5 px Gaussian below 15 px per row, as Bookmap does, so far walls stay visible; Off draws every row exactly.' }),
    auto: el('button', { textContent: 'Auto', title: 'Auto: the colour window follows the data (recomputed on recenter, market change, zoom and every 10 s). Off: it stays where it is.' }),
  };
  #source = el('select', { title: 'Heatmap source' });
  #theme = el('button', { class: 'theme-btn', title: 'Theme: hover to preview, click to keep' });
  #status = el('span', { class: 'status' });
  #recenter = el('button', { textContent: 'Recenter' });
  onRecenter: () => void = () => {};
  /** Preview a theme without keeping it (`null` puts the saved one back). */
  onPreviewTheme: (id: string | null) => void = () => {};
  onSelectMarket: (id: string) => void = () => {};

  constructor(private store: Store) {
    this.#market.onchange = () => this.onSelectMarket(this.#market.value);
    for (const tf of Object.keys(TIMEFRAMES)) this.#timeframes.append(el('button', { textContent: tf, onclick: () => this.store.set({ timeframe: tf }) }));
    for (const [id, label] of LAYERS) this.#layer.append(new Option(label, id));
    this.#layer.onchange = () => this.store.set({ layer: this.#layer.value as Layer });
    for (const [key, label] of [['profile', 'Profile'], ['depth', 'Depth'], ['oi', 'OI'], ['candles', 'Candles'], ['footprint', 'Footprint'], ['lt', 'LT'], ['mirror', 'Mirror'], ['volume', 'Volume'], ['bubbles', 'Trades']] as const)
      this.#toggles.append(el('button', { textContent: label, onclick: () => this.store.set({ show: { ...this.store.state.show, [key]: !this.store.state.show[key] } }) }));
    for (const [value, label] of SCOPE_OPTIONS) this.#scope.append(el('button', { textContent: label, onclick: () => this.store.set({ scope: value }) }));
    this.#soundButton.onclick = () => {
      const sounds = this.#sounds; if (!sounds) return;
      const build = (tools: HTMLElement, body: HTMLElement): void => buildSoundPanel(this.store, sounds, () => this.#soundPanel?.render(build), tools, body);
      this.#soundPanel = togglePanel(this.#soundButton, { title: 'Sounds', width: 420, align: 'left', onClose: () => { this.#soundPanel = null; } }, build);
    };
    this.#highlights.onclick = () => { togglePanel(this.#highlights, { title: 'Highlights', width: 380, align: 'left' }, (tools, body) => this.#buildHighlights(tools, body)); };
    for (const style of HEAT_STYLES) this.#heat.style.append(Object.assign(new Option(style.label, style.id), { title: style.title }));
    this.#heat.style.onchange = () => this.store.set({ heat: { ...this.store.state.heat, style: this.#heat.style.value as HeatStyleId } });
    this.#heat.contrast.oninput = () => this.store.set({ heat: { ...this.store.state.heat, contrast: Number(this.#heat.contrast.value) } });
    this.#heat.contrast.ondblclick = () => this.store.set({ heat: { ...this.store.state.heat, contrast: 50 } });
    for (const [value, label] of [['auto', 'Smooth: auto'], ['off', 'Smooth: off']] as const) this.#heat.smooth.append(new Option(label, value));
    this.#heat.smooth.onchange = () => this.store.set({ heat: { ...this.store.state.heat, smooth: this.#heat.smooth.value as 'auto' | 'off' } });
    this.#heat.auto.onclick = () => this.store.set({ heat: { ...this.store.state.heat, auto: !this.store.state.heat.auto } });
    this.#heat.legend.append(this.#heat.lo, this.#heat.hi);
    this.#source.onchange = () => this.store.set({ heatmapSource: this.#source.value });
    this.#theme.onclick = () => this.#openThemes();
    this.#recenter.onclick = () => this.onRecenter();
    const venues = el('button', { textContent: 'Venues', onclick: () => void openVenueDialog(() => this.#selectionProduct()) });
    this.root.append(
      el('span', { class: 'brand', textContent: 'LiquidityMapperFast' }), this.#market, venues, this.#source, this.#timeframes, this.#layer, this.#toggles, this.#highlights, this.#soundButton,
      el('span', { class: 'heatctl' }, this.#heat.style, el('span', { class: 'scale' }, this.#heat.legend, this.#heat.contrast), this.#heat.auto, this.#heat.smooth),
      this.#scope, this.#chips, this.#recenter, el('span', { class: 'spacer' }), this.#theme, this.#status);
  }

  /** Update controls from state; `window` is the USD range currently mapped onto the colour ramp. Only touches DOM that changed, so open dropdowns and clicks survive 4 Hz data frames. */
  sync(state: AppState, window: { lo: number; hi: number }): void {
    const instruments = state.markets.filter(m => m.instrumentId);
    const marketKey = instruments.map(m => m.instrumentId).join(',');
    if (this.#market.dataset.key !== marketKey) {
      this.#market.replaceChildren(...instruments.map(m => new Option(`${venueLabel(m.instrumentId ?? '')} · ${m.symbol ?? m.instrumentId} · ${m.marketType ?? ''}`, m.instrumentId)));
      this.#market.dataset.key = marketKey;
    }
    setValue(this.#market, state.marketId);
    [...this.#timeframes.children].forEach(b => b.classList.toggle('on', b.textContent === state.timeframe));
    setValue(this.#layer, state.layer);
    [...this.#toggles.children].forEach((b, i) => b.classList.toggle('on', state.show[(['profile', 'depth', 'oi', 'candles', 'footprint', 'lt', 'mirror', 'volume', 'bubbles'] as const)[i]!]));
    this.#heat.auto.classList.toggle('on', state.heat.auto);
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
      this.#soundButton.title = soundState === 'off' ? 'Sound notifications: off' : soundState === 'locked' ? 'Sound is on but the browser keeps audio locked until you click or press a key on the page' : 'Sound notifications: on';
      this.#soundPanel?.reposition();
    }
    this.#soundButton.classList.toggle('flash', state.lastSound > 0 && Date.now() - state.lastSound < 600);
    if (this.#status.textContent !== state.status) this.#status.textContent = state.status;
    const live = state.connected ? 'live' : 'down';
    if (this.#status.dataset.state !== live) this.#status.dataset.state = live;
    const books = state.levels?.books ?? [];
    const sourceKey = books.map(b => b.id).join(',');
    if (this.#source.dataset.key !== sourceKey) {
      this.#source.replaceChildren(new Option('Heatmap: aggregated', 'aggregated'), ...books.map(b => new Option(`Heatmap: ${venueLabel(b.id)}`, b.id)));
      this.#source.dataset.key = sourceKey;
    }
    setValue(this.#source, books.some(b => b.id === state.heatmapSource) ? state.heatmapSource : 'aggregated');
    const venues = [...new Set(books.map(b => b.venue))];
    const scoped = (v: string) => books.some(b => b.venue === v && inScope(state.scope, state.markets, b.id));
    const counts = scopeCounts(state);
    [...this.#scope.children].forEach((b, i) => { const [value] = SCOPE_OPTIONS[i]!; b.classList.toggle('on', state.scope === value); (b as HTMLElement).title = value === 'all' ? 'Every enabled venue' : `${value === 'spot' ? 'Spot' : 'Perpetual'} venues only (${counts[value]} enabled)`; });
    this.#scope.classList.toggle('inert', state.heatmapSource !== 'aggregated');
    const chipKey = venues.map(v => v + (state.disabledVenues.includes(v) ? '-' : '+') + (scoped(v) ? 's' : 'x')).join(',');
    if (this.#chips.dataset.key !== chipKey) {
      this.#chips.dataset.key = chipKey;
      this.#chips.replaceChildren(...venues.map(v => el('button', { class: (state.disabledVenues.includes(v) ? 'chip off' : 'chip') + (scoped(v) ? '' : ' scoped-out'), textContent: venueLabel(v), title: 'Show / hide this venue',
        onclick: () => { const off = this.store.state.disabledVenues; this.store.set({ disabledVenues: off.includes(v) ? off.filter(x => x !== v) : [...off, v] }); } })));
    }
    this.#scope.title = state.heatmapSource === 'aggregated' ? 'Which markets the liquidity views draw (a filter on the enabled venues; it never switches one on or off)' : 'The heatmap shows a single venue, so this filter only affects the profile, depth, ladder and LT';
    // Tooltips carry each venue's book reach, so a thin book on the map is explained by its feed.
    venues.forEach((v, i) => {
      const cov = coverage(books.find(b => b.venue === v), state.mark.price);
      const title = cov ? `${venueLabel(v)}: ${cov.levels} levels, reaches ${Math.round(cov.bp / 2)} bp each side. Click to show / hide.` : 'Show / hide this venue';
      const chip = this.#chips.children[i] as HTMLElement | undefined;
      if (chip && chip.title !== title) chip.title = title;
    });
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
