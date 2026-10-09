import { Hub } from './hub.ts';
import { ServerSource } from './server-source.ts';
import { BrowserSource } from './browser-source.ts';
import { chooseCoin, currentCoin, forCoin, keepCoinRecordings, type CoinChoice } from './coin.ts';
import { withAnchor } from './vwap/settings.ts';
import type { DataSource } from './source.ts';
import { loadKernels } from './kernels.ts';
import { Store, initialState } from './store.ts';
import { applyTheme } from './theme.ts';
import { Sounds } from './sound/sounds.ts';
import { Alerts } from './sound/alerts.ts';
import { Toolbar } from './toolbar.ts';
import { StatusBar } from './statusbar.ts';
import { setTimeZone } from './format.ts';
import { installTips } from './tip.ts';
import { installTouchSelects } from './touch-select.ts';
import { lazy } from './lazy.ts';
import { ScreenWake } from './wake.ts';
import { HeatPane, gutter } from './panes/heat-pane.ts';
import { LadderPane } from './panes/ladder-pane.ts';
import { CvdPane } from './panes/cvd-pane.ts';
import { BarStatsPane, DepthPane, LtPane, OiPane } from './panes/lower-panes.ts';
import { DeltaPane } from './panes/delta-pane.ts';
import { enabledStats } from './panes/bar-stats.ts';
import { Layout } from './layout.ts';
import { Dock } from './dock.ts';
import { RangeTool } from './range/tool.ts';
import { startDevice, onLayoutMode } from './device.ts';
import './styles.css';
import './mobile.css';
import './chrome.css';
import { t } from './i18n.ts';
import { useMarkets } from './venue-marks.ts';

/** True when the page is being served by the local server (its state endpoint answers with JSON on this very origin). */
async function serverAnswers(): Promise<boolean> {
  try {
    const response = await fetch('api/v2/state', { signal: AbortSignal.timeout(1_500), cache: 'no-store' });
    return response.ok && (response.headers.get('content-type') ?? '').includes('json');
  } catch { return false; }
}

/**
 * Where the data comes from. A static host (GitHub Pages, any file server) has no server behind it, so the page reads the exchanges
 * itself in a worker. Served by the local server, the page uses that server and its recorded history instead. `?source=browser` or
 * `?source=server` chooses explicitly (`?persist=0` keeps a browser-source session from saving recordings). The server records BTC only,
 * so a page on another coin reads the exchanges itself wherever it is served from.
 */
async function chooseSource(params: URLSearchParams, choice: CoinChoice): Promise<DataSource> {
  const wanted = params.get('source');
  if (choice.coin.coin === 'BTC' && (wanted === 'server' || (wanted !== 'browser' && await serverAnswers()))) return new ServerSource();
  return new BrowserSource(new Worker(new URL('./browser/feeds.worker.ts', import.meta.url), { type: 'module' }), { persist: params.get('persist') !== '0', coin: choice.coin, tier: choice.tier });
}

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  startDevice();
  const params = new URLSearchParams(location.search);
  // The coin first: everything after it is built for that coin (BTC needs no list, so a BTC page does not wait for one).
  const choice = await chooseCoin(params);
  const store = new Store(forCoin(initialState(), choice.coin, choice.from));
  useMarkets(() => store.state.markets);
  setTimeZone(store.state.timeZone);
  applyTheme(store.state.theme);
  installTips();
  installTouchSelects();
  const kernels = await loadKernels();
  keepCoinRecordings();
  const source = await chooseSource(params, choice);
  const hub = new Hub(store, source);
  const wake = new ScreenWake(); wake.set(store.state.keepAwake);

  const toolbar = new Toolbar(store, source.venues);
  toolbar.sourceKind = source.kind === 'server' ? 'server' : 'browser';
  const main = document.createElement('main');
  const chart = document.createElement('div'); chart.className = 'chart-col';
  const side = document.createElement('div'); side.className = 'side-col';
  // The flow column (taker flow, active liquidity) sits left of the map, the order book (passive liquidity) right of it.
  const flowCol = document.createElement('div'); flowCol.className = 'flow-col';
  main.append(flowCol, chart, side);
  const dock = new Dock(main);
  // The bar along the bottom (desktop only): connection, venues live, price age, recording, data source, language and theme.
  const statusbar = new StatusBar(source.kind);
  app.append(toolbar.root, main, dock.root, statusbar.root);
  toolbar.hostStatusControls(statusbar.controls);
  source.venues.watch?.(entries => statusbar.setVenues(entries));
  const showStatus = (): void => statusbar.update(store.state, hub.recordedSince, source.kind === 'server' ? 'server' : source.saving?.(Date.now()) ?? 'starting');
  window.setInterval(showStatus, 1000);

  const heat = new HeatPane(chart, store, hub, kernels);
  toolbar.placeRecenter(heat.root);
  const bars = new BarStatsPane(chart, store, heat.view, heat);
  const depth = new DepthPane(chart, store, heat.view, hub);
  const oi = new OiPane(chart, store, heat.view);
  const delta = new DeltaPane(chart, store, heat.view, hub);
  heat.divergences = () => delta.divergences; delta.onDivergences = () => heat.invalidate();
  const lt = new LtPane(chart, store, heat.view, hub);
  const ladder = new LadderPane(side, store, kernels);
  const cvd = new CvdPane(flowCol, store, hub, heat.view);
  const arrange = new Layout(main, chart, side, [
    { id: 'heat', root: heat.root, min: 240 },
    { id: 'bars', root: bars.root, height: 84, min: 56, head: bars.header },
    { id: 'depth', root: depth.root, height: 132, min: 70, head: depth.header },
    { id: 'oi', root: oi.root, height: 150, min: 60, head: oi.header },
    { id: 'delta', root: delta.root, height: 150, min: 60, head: delta.header },
    { id: 'lt', root: lt.root, height: 128, min: 70, head: lt.header },
  ], flowCol);
  const lower = () => { depth.invalidate(); oi.invalidate(); delta.invalidate(); lt.invalidate(); bars.invalidate(); cvd.followMap(); };
  hub.onFlowChanged = () => { cvd.invalidate(); delta.invalidate(); };
  // A finger on a pane under the map moves the time axis it shares with the map.
  for (const pane of [depth, oi, delta, lt, bars]) pane.useTimeGestures(heat.timeGestures());
  heat.onFrame = lower; heat.onView = lower;
  // The Range tool: a drag on the map, on a pane under it or across the flow column selects, and its panel adds up what happened there.
  const range = new RangeTool(store, hub); range.anchor = toolbar.rangeButton; range.mapWindow = () => ({ t0: heat.view.t0, t1: heat.view.t1 });
  heat.range = range; cvd.range = range; for (const pane of [depth, oi, delta, lt, bars]) pane.useRange(range);
  toolbar.onRange = () => range.toggle();
  toolbar.onRecenter = () => { heat.fit(); ladder.recenter(); };
  toolbar.onSelectMarket = id => store.set({ marketId: id });
  toolbar.onVenuesApplied = () => { void hub.refreshMarkets(); window.setTimeout(() => void hub.refreshMarkets(), 15_000); };
  const sounds = new Sounds(store); toolbar.attachSounds(sounds); sounds.start();
  // Sounds the panels may make about what happens in them (flow bursts, walls, the balance, candle closes); the bursts are also marked on the flow column.
  const alerts = new Alerts(store, hub.flow, sounds.engine, Date.now, (ids, from) => { void hub.ensureFlow(ids, from); }); toolbar.attachAlerts(alerts); alerts.start();
  alerts.onChange = () => cvd.invalidate(); cvd.events = alerts.bursts;
  hub.onPrints = fresh => { sounds.feed(fresh); cvd.flash(fresh); };
  hub.onPrintsChanged = () => { heat.invalidate(); range.refreshHeld(); };
  hub.onLiquidationsChanged = () => { heat.invalidate(); range.refreshHeld(); };
  toolbar.keyHistory = hub.keyHistory;
  toolbar.whaleInfo = () => ({ since: hub.whale?.since ?? null, state: hub.whaleState, browser: source.kind === 'browser' });
  // A click on the map while placing a VWAP anchor: the anchor, for the coin on the page.
  heat.onAnchor = at => { const s = store.state; store.set({ vwap: withAnchor({ ...s.vwap, on: true }, currentCoin().coin, at, Date.now()), vwapAnchoring: false }); };
  hub.onTraded = () => heat.invalidate();
  hub.onAbsorptionChanged = () => heat.invalidate();
  toolbar.absorptionInfo = () => heat.absorptionThresholdText();
  // Hovering a theme shows it everywhere without saving it; leaving the menu puts the saved one back.
  toolbar.onPreviewTheme = id => { const name = id ?? store.state.theme; applyTheme(name); for (const p of [heat, ladder, depth, oi, lt, bars, cvd]) p.setPalette(name); toolbar.previewTheme(name); };
  heat.onStats = () => toolbar.sync(store.state, heat.window);

  // An address like #guide/mirror opens the guide there.
  const fromAddress = (): void => { if (/^#guide/.test(location.hash)) void lazy(() => import('./guide/guide.ts')).then(m => m?.openFromAddress()); };
  fromAddress(); window.addEventListener('hashchange', fromAddress);

  // S takes a screenshot (not while typing in a field or when a modifier is held).
  window.addEventListener('keydown', e => {
    if (e.key.toLowerCase() !== 's' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) || document.querySelector('dialog[open]')) return;
    e.preventDefault(); void lazy(() => import('./screenshot/editor.ts')).then(m => m?.startScreenshot());
  });

  // The profile column and axis are narrower on a phone; everything that aligns to them has to redraw when that changes.
  onLayoutMode(() => { layout(); heat.invalidate(); lower(); toolbar.sync(store.state, heat.window); });
  const layout = () => {
    const s = store.state;
    document.documentElement.style.setProperty('--gutter', `${gutter(s)}px`);
    depth.root.hidden = !s.show.depth; oi.root.hidden = !s.show.oi; delta.root.hidden = !s.show.delta; lt.root.hidden = !s.show.lt; bars.root.hidden = !s.show.footprint;
    // The two side panels vanish and return at once: nothing is rebuilt, a hidden column is simply not laid out.
    cvd.root.hidden = !s.show.cvd; ladder.root.hidden = !s.show.book;
    arrange.columns({ flow: s.show.cvd, book: s.show.book });
    arrange.rebuild();
    if (s.show.cvd) cvd.invalidate(); if (s.show.book) ladder.invalidate();
    dock.sync(s.show);
  };

  store.subscribe((state, changed) => {
    if (changed.has('keepAwake')) wake.set(state.keepAwake);
    // Every time on the page is written from the one setting: say it changed, and have what shows times draw again.
    if (changed.has('timeZone')) { setTimeZone(state.timeZone); heat.invalidate(); lower(); cvd.invalidate(); showStatus(); }
    if (changed.has('theme')) { applyTheme(state.theme); for (const p of [heat, ladder, depth, oi, delta, lt, bars, cvd]) p.setPalette(state.theme); }
    if (changed.has('cvd')) cvd.settingsChanged();
    if (changed.has('status') || changed.has('connected') || changed.has('mark')) showStatus();
    if (changed.has('show')) layout();
    if (changed.has('marketId') || changed.has('timeframe')) void hub.loadSeries(true).then(() => { heat.fit(); lower(); });
    if (changed.has('disabledVenues') || changed.has('heatmapSource') || changed.has('scope')) { heat.dataChanged(); depth.refresh(); lt.refresh(); cvd.refresh(); }
    if (changed.has('markets')) cvd.invalidate();
    if (changed.has('highlight')) { heat.invalidate(); oi.invalidate(); depth.invalidate(); }
    if (changed.has('absorption') || changed.has('tradeBubbles') || changed.has('liquidations') || changed.has('keyLevels') || changed.has('traded') || changed.has('vwap') || changed.has('vwapAnchoring') || changed.has('footprint') || changed.has('barStatOptions')) heat.invalidate();
    // Placing a VWAP anchor and selecting a Range both take the next press on the map: arming one ends the other.
    if (changed.has('rangeTool') && state.rangeTool && state.vwapAnchoring) store.set({ vwapAnchoring: false });
    if (changed.has('absorption') || changed.has('tradeBubbles') || changed.has('liquidations') || changed.has('show')) range.refreshHeld();
    if (changed.has('sounds')) heat.invalidate();
    if (changed.has('levels')) { ladder.invalidate(); ladder.syncVenues(); heat.invalidate(); }
    if (changed.has('layers') || changed.has('layer') || changed.has('candles') || changed.has('mark') || changed.has('heat') || changed.has('show')) heat.invalidate();
    if (changed.has('oi') || changed.has('show')) oi.invalidate();
    if (changed.has('lt') || changed.has('show') || changed.has('sounds')) lt.refresh();
    if (changed.has('barStatOptions') && !changed.has('barStats')) bars.refresh();
    if (changed.has('barStats')) { arrange.setPaneHeight('bars', 12 + Math.max(1, enabledStats(state.barStats).length) * 24); bars.refresh(); }
    if (changed.has('grouping') || changed.has('ladderMode') || changed.has('ladderShow') || changed.has('ladderVenue') || changed.has('ladderVenues') || changed.has('disabledVenues') || changed.has('scope')) { ladder.invalidate(); ladder.syncControls(); }
    if (changed.has('range')) { heat.invalidate(); oi.invalidate(); depth.invalidate(); lt.invalidate(); bars.invalidate(); cvd.invalidate(); }
    if (changed.has('hover')) { heat.invalidate(); oi.invalidate(); delta.invalidate(); depth.invalidate(); lt.invalidate(); bars.invalidate(); cvd.syncHover(); }
    if (changed.has('delta')) delta.settingsChanged();
    if (['show', 'candles', 'timeframe', 'marketId', 'disabledVenues', 'scope', 'markets', 'traded', 'timeZone', 'range'].some(k => changed.has(k as never))) delta.invalidate();
    if (['markets', 'marketId', 'timeframe', 'layer', 'show', 'heat', 'theme', 'status', 'connected', 'disabledVenues', 'heatmapSource', 'levels', 'scope', 'sounds', 'soundState', 'lastSound', 'timeZone', 'absorption', 'highlight', 'range', 'rangeTool', 'liquidations', 'keyLevels', 'vwap', 'footprint'].some(k => changed.has(k as never))) toolbar.sync(state, heat.window);
  });

  for (const p of [heat, ladder, depth, oi, lt, bars, cvd]) p.setPalette(store.state.theme);
  layout(); ladder.syncControls(); lt.refresh();
  arrange.setPaneHeight('bars', 12 + Math.max(1, enabledStats(store.state.barStats).length) * 24);
  toolbar.sync(store.state, heat.window);
  await hub.start();
  await hub.loadSeries(true);
  heat.fit(); lower();
  window.setInterval(() => { void hub.loadSeries(true); }, 60_000);
  // OI is sampled about once a minute on the server; asking more often than that keeps the newest bar from lagging by a whole refresh.
  window.setInterval(() => { void hub.loadOi(); }, 20_000);
  (window as unknown as { __hlm: unknown }).__hlm = { store, hub, heat, ladder, cvd, sounds, alerts };
}

main().catch(error => {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const hint = /api\/v2/.test(message) ? t('The server is running an older build without the v2 data plane. Restart it (npm run dev) and reload.')
    : /fetch|network/i.test(message) ? t('No answer from {host}. Is the server running (npm run dev), and is this the port it listens on?', { host: location.host })
    : / 403\b/.test(message) ? t('The server refused {host}: it answers localhost and IP addresses only. Open it as http://localhost:{port}, or list this name in HLM_ALLOWED_HOSTS.', { host: location.host, port: location.port || 80 }) : '';
  document.body.append(Object.assign(document.createElement('pre'), { className: 'fatal', textContent: t('Failed to start: {message}', { message }) + (hint ? `\n\n${hint}` : '') }));
});
