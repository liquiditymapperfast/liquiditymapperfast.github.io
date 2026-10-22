import { Hub } from './hub.ts';
import { ServerSource } from './server-source.ts';
import { BrowserSource } from './browser-source.ts';
import { chooseCoin, currentCoin, forCoin, keepCoinRecordings, scaledUsd, type CoinChoice } from './coin.ts';
import { withAnchor } from './vwap/settings.ts';
import type { DataSource } from './source.ts';
import { loadKernels } from './kernels.ts';
import { Store, initialState } from './store.ts';
import { applyTheme } from './theme.ts';
import { UiGlass } from './glass/ui-glass.ts';
import { Sounds } from './sound/sounds.ts';
import { Alerts } from './sound/alerts.ts';
import { Toolbar } from './toolbar.ts';
import { StatusBar } from './statusbar.ts';
import { setTimeZone } from './format.ts';
import { installTips } from './tip.ts';
import { installTouchSelects } from './touch-select.ts';
import { lazy, preload } from './lazy.ts';
import { ScreenWake } from './wake.ts';
import { HeatPane, gutter, leftGutter } from './panes/heat-pane.ts';
import { LadderPane } from './panes/ladder-pane.ts';
import { CvdPane } from './panes/cvd-pane.ts';
import { BarStatsPane, DepthPane, LtPane, OiPane } from './panes/lower-panes.ts';
import { DeltaPane } from './panes/delta-pane.ts';
import { LsPane } from './panes/ls-pane.ts';
import { CandlePane } from './panes/candle-pane.ts';
import { matchShortcut, togglePatch } from './shortcuts.ts';
import { ReplayBar } from './replay/bar.ts';
import { replaying } from './replay/clock.ts';
import { topShown } from './measures/strip.ts';
import { tableHeight } from './panes/bar-stats.ts';
import { Layout } from './layout.ts';
import { Dock } from './dock.ts';
import { RangeTool } from './range/tool.ts';
import { startDevice, onLayoutMode, isPhone } from './device.ts';
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
  toolbar.flow = hub.flow;
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
  const bars = new BarStatsPane(chart, store, heat.view, heat, hub);
  const depth = new DepthPane(chart, store, heat.view, hub);
  const oi = new OiPane(chart, store, heat.view, hub.flow);
  const delta = new DeltaPane(chart, store, heat.view, hub);
  heat.divergences = () => delta.divergences; delta.onDivergences = () => heat.invalidate();
  const ls = new LsPane(chart, store, heat.view, hub);
  const lt = new LtPane(chart, store, heat.view, hub);
  const ladder = new LadderPane(side, store, kernels, hub);
  const cvd = new CvdPane(flowCol, store, hub, heat.view);
  // The phone's Candle view: a tab of its own that fills the area (panes/candle-pane.ts); it counts the markets the map's footprint counts.
  const candle = new CandlePane(main, store, hub, kernels, s => heat.footprintMarkets(s));
  toolbar.tapeFields = () => candle.settingsFields();
  const arrange = new Layout(main, chart, side, [
    { id: 'heat', root: heat.root, min: 240 },
    { id: 'bars', root: bars.root, height: 84, min: 56, head: bars.header },
    { id: 'depth', root: depth.root, height: 132, min: 70, head: depth.header },
    { id: 'oi', root: oi.root, height: 150, min: 60, head: oi.header },
    { id: 'delta', root: delta.root, height: 150, min: 60, head: delta.header },
    { id: 'ls', root: ls.root, height: 120, min: 60, head: ls.header },
    { id: 'lt', root: lt.root, height: 128, min: 70, head: lt.header },
  ], flowCol);
  const lower = () => { depth.invalidate(); oi.invalidate(); delta.invalidate(); ls.invalidate(); lt.invalidate(); bars.invalidate(); cvd.followMap(); };
  // Replay: the map's candle under way is rebuilt from the flow, so flow arriving while paused redraws it too (live, the map has its own pace).
  // The volume profile along the top of the map draws traded volume from the flow too: history that has landed redraws it (a live second
  // does not, `loads`; the map is drawn several times a second while frames come anyway), with the Delta pane hidden as well.
  let stripLoads = hub.flow.loads;
  // The open-interest markets are worked out from the flow and the books on the map, which come after the candles: asked again as they do.
  hub.onFlowChanged = () => { cvd.invalidate(); delta.invalidate(); const landed = stripLoads !== hub.flow.loads; stripLoads = hub.flow.loads; if (replaying() || (landed && topShown(store.state))) heat.invalidate(); hub.refreshOiMarkets(); };
  // A finger on a pane under the map moves the time axis it shares with the map.
  for (const pane of [depth, oi, delta, ls, lt, bars]) pane.useTimeGestures(heat.timeGestures());
  heat.onFrame = lower; heat.onView = lower;
  heat.onTopProfile = () => toolbar.openTradedPanel();
  heat.onArrangedChange = () => toolbar.refreshTradedPanel();
  // The panel says what of the profiles has no room, in the room the map had when it was last drawn.
  toolbar.profileRoom = () => heat.profileRoom();
  // The Range tool: a drag on the map, on a pane under it or across the flow column selects, and its panel adds up what happened there.
  const range = new RangeTool(store, hub); range.anchor = toolbar.rangeButton; range.mapWindow = () => ({ t0: heat.view.t0, t1: heat.view.t1 });
  heat.range = range; cvd.range = range; for (const pane of [depth, oi, delta, ls, lt, bars]) pane.useRange(range);
  toolbar.onRange = () => range.toggle();
  toolbar.onRecenter = () => { heat.fit(); ladder.recenter(); };
  // The countdown under the price tag: a redraw a second when nothing else draws the map.
  window.setInterval(() => heat.tick(), 1_000);
  // Replay (replay/): its bar sits on the map; the map is drawn as it plays and the panes under it follow its frames.
  const replayBar = new ReplayBar(store, { redraw: () => heat.invalidate(), placeAt: t => heat.placeAt(t), live: () => toolbar.onRecenter() });
  heat.root.append(replayBar.root);
  toolbar.goTo = {
    replay: t => replayBar.start(t),
    centre: () => (heat.view.t0 + heat.view.t1) / 2,
    earliest: () => ({ depth: hub.recordedSince > 0 ? hub.recordedSince : null, candles: store.state.candles[0]?.[0] ?? null }),
    go: t => heat.goTo(t),
    live: () => { if (replaying()) replayBar.stop(); else toolbar.onRecenter(); },
  };
  hub.onWhaleChanged = () => toolbar.refreshOpenPanel();
  toolbar.panes = { arrangement: () => arrange.arrangement(), apply: a => arrange.apply(a), defaults: () => arrange.defaults() };
  toolbar.onSelectMarket = id => store.set({ marketId: id });
  toolbar.onVenuesApplied = () => { void hub.refreshMarkets(); window.setTimeout(() => void hub.refreshMarkets(), 15_000); };
  const sounds = new Sounds(store); toolbar.attachSounds(sounds); sounds.start();
  // Sounds the panels may make about what happens in them (flow bursts, walls, the balance, the depth, candle closes); the bursts are also marked on the flow column.
  const alerts = new Alerts(store, hub.flow, sounds.engine, Date.now, (ids, from) => { void hub.ensureFlow(ids, from); }, (ids, from, to) => hub.source.columns(ids, from, to, 60_000));
  toolbar.attachAlerts(alerts); alerts.start();
  alerts.onChange = () => cvd.invalidate(); cvd.events = alerts.bursts;
  hub.onPrints = fresh => { if (replaying()) return; sounds.feed(fresh); cvd.flash(fresh); };
  hub.onPrintsChanged = () => { heat.invalidate(); range.refreshHeld(); };
  // The trade dust: asked for while the bubbles and their Live trades switch are both on; arrivals redraw the dust alone.
  // The Candle view's trail reads the same orders, so they are asked for while it is shown whatever the bubbles' switches say.
  const candleShown = (): boolean => dock.tab === 'candle' && isPhone();
  // The glass around the chart (glass/ui-glass.ts): lit by the large orders where the map shows them.
  const glass = new UiGlass((price, t) => heat.liveSpot(price, t), () => hub.tape);
  cvd.onLargeFlow = (x, y, usd) => glass.pulse(x, y, usd, scaledUsd(100_000), usd > 0 ? 0 : 1);
  const applyMaterial = (): void => {
    glass.setPalette(applyTheme(store.state.theme));
    glass.setOn(store.state.material === 'glass');
    document.documentElement.dataset.material = glass.on ? 'glass' : 'solid';
  };
  // On a phone the Tape keeps the market's orders from the page's opening, whichever tab shows, so the ring runs there always.
  const tapeWanted = (): boolean => (store.state.show.bubbles && store.state.tradeBubbles.live) || candleShown() || store.state.material === 'glass' || isPhone();
  // The map and the book are covered while the Candle tab shows: they draw nothing then, and catch up when they show again.
  const coverPanes = (): void => { const covered = candleShown(); heat.setSuspended(covered); ladder.setSuspended(covered); };
  dock.onChange = () => { candle.setShown(candleShown()); coverPanes(); hub.setTape(tapeWanted()); };
  hub.setTape(tapeWanted());
  hub.onTape = () => { heat.tapeArrived(); candle.tapeArrived(); glass.tapeArrived(); };
  applyMaterial();
  // Trades recovered from a venue's history (the browser engine): no flow burst is sounded over them.
  hub.onRecovered = (id, _from, to) => { alerts.recovered.set(id, Math.max(alerts.recovered.get(id) ?? 0, to)); };
  hub.onLiquidationsChanged = () => { heat.invalidate(); range.refreshHeld(); };
  toolbar.keyHistory = hub.keyHistory;
  toolbar.profileHistory = barMs => hub.profileHistory(barMs);
  toolbar.whaleInfo = () => ({ since: hub.whale?.since ?? null, state: hub.whaleState, browser: source.kind === 'browser' });
  // A click on the map while placing a VWAP anchor: the anchor, for the coin on the page.
  heat.onAnchor = at => { const s = store.state; store.set({ vwap: withAnchor({ ...s.vwap, on: true }, currentCoin().coin, at, Date.now()), vwapAnchoring: false }); };
  hub.onTraded = () => heat.invalidate();
  hub.onAbsorptionChanged = () => { heat.invalidate(); range.refreshHeld(); };
  toolbar.absorptionInfo = () => heat.absorptionThresholdText();
  // Hovering a theme shows it everywhere without saving it; leaving the menu puts the saved one back.
  toolbar.onPreviewTheme = id => { const name = id ?? store.state.theme; glass.setPalette(applyTheme(name)); for (const p of [heat, ladder, depth, oi, delta, ls, lt, bars, cvd, candle]) p.setPalette(name); toolbar.previewTheme(name); };
  heat.onStats = () => toolbar.sync(store.state, heat.window);

  // An address like #guide/mirror opens the guide there.
  const fromAddress = (): void => { if (/^#guide/.test(location.hash)) void lazy(() => import('./guide/guide.ts')).then(m => m?.openFromAddress()); };
  fromAddress(); window.addEventListener('hashchange', fromAddress);

  // The screenshot tool is fetched a few seconds in, so a deploy while the page is open cannot leave it asking for a file that is gone.
  window.setTimeout(() => preload(() => import('./screenshot/editor.ts')), 5_000);

  // The keyboard shortcuts (shortcuts.ts: the table, and when a key is left alone).
  window.addEventListener('keydown', e => {
    const hit = matchShortcut(e, document.querySelector('dialog[open]') !== null);
    if (!hit) return;
    e.preventDefault();
    const a = hit.action;
    if (a.kind === 'timeframe') store.set({ timeframe: a.tf });
    else if (a.kind === 'recenter') toolbar.onRecenter();
    else if (a.kind === 'zoom') heat.zoomStep(a.dir);
    else if (a.kind === 'toggle') { store.set(togglePatch(store.state, a.feature)); toolbar.refreshOpenPanel(); }
    else if (a.kind === 'range') range.toggle();
    else if (a.kind === 'goto') toolbar.openGoTo();
    else if (a.kind === 'screenshot') void lazy(() => import('./screenshot/editor.ts')).then(m => m?.startScreenshot());
    else toolbar.openShortcuts();
  });

  // The profile column and axis are narrower on a phone; everything that aligns to them has to redraw when that changes.
  onLayoutMode(() => { layout(); heat.invalidate(); lower(); toolbar.sync(store.state, heat.window); candle.setShown(candleShown()); coverPanes(); hub.setTape(tapeWanted()); });
  // The columns beside the map: what the corner buttons and the replay bar keep clear of (the map's own pane sets them each frame too).
  const gutters = () => {
    const s = store.state;
    document.documentElement.style.setProperty('--gutter', `${gutter(s)}px`); document.documentElement.style.setProperty('--gutter-left', `${leftGutter(s)}px`);
  };
  const layout = () => {
    const s = store.state;
    gutters();
    depth.root.hidden = !s.show.depth; oi.root.hidden = !s.show.oi; delta.root.hidden = !s.show.delta; ls.root.hidden = !s.show.ls; lt.root.hidden = !s.show.lt; bars.root.hidden = !s.show.stats;
    // The two side panels vanish and return at once: nothing is rebuilt, a hidden column is simply not laid out.
    cvd.root.hidden = !s.show.cvd; ladder.root.hidden = !s.show.book;
    arrange.columns({ flow: s.show.cvd, book: s.show.book });
    arrange.rebuild();
    if (s.show.cvd) cvd.invalidate(); if (s.show.book) ladder.invalidate();
    dock.sync(s.show);
  };

  /** The Bar stats rows the pane was last sized for: which, grouped or not, which kinds folded. */
  let tableShape = `${store.state.barStats.join(',')}|${store.state.barStatOptions.grouped}|${store.state.barStatOptions.folded.join(',')}`;
  store.subscribe((state, changed) => {
    if (changed.has('keepAwake')) wake.set(state.keepAwake);
    // Every time on the page is written from the one setting: say it changed, and have what shows times draw again.
    if (changed.has('timeZone')) { setTimeZone(state.timeZone); heat.invalidate(); lower(); cvd.invalidate(); showStatus(); }
    if (changed.has('theme')) { glass.setPalette(applyTheme(state.theme)); for (const p of [heat, ladder, depth, oi, delta, ls, lt, bars, cvd, candle]) p.setPalette(state.theme); }
    if (changed.has('material')) { applyMaterial(); hub.setTape(tapeWanted()); }
    if (changed.has('cvd')) cvd.settingsChanged();
    if (changed.has('status') || changed.has('connected') || changed.has('mark')) showStatus();
    if (changed.has('show')) layout(); else if (changed.has('traded')) gutters();
    if (changed.has('marketId') || changed.has('timeframe')) void hub.loadSeries(true).then(() => { heat.fit(); lower(); });
    if (changed.has('disabledVenues') || changed.has('heatmapSource') || changed.has('scope')) { heat.dataChanged(); depth.refresh(); lt.refresh(); cvd.refresh(); }
    if (changed.has('markets')) cvd.invalidate();
    // Open interest added up over the venues switched on: another choice of them is another series.
    if (changed.has('oiMarkets') || changed.has('disabledVenues') || changed.has('scope') || changed.has('customMarkets') || (changed.has('markets') && store.state.oiMarkets === 'custom')) void hub.loadOi();
    else if (changed.has('levels') || changed.has('markets') || changed.has('bookGone')) hub.refreshOiMarkets();
    if (changed.has('highlight')) { heat.invalidate(); oi.invalidate(); depth.invalidate(); }
    if (changed.has('absorption') || changed.has('tradeBubbles') || changed.has('liquidations') || changed.has('keyLevels') || changed.has('traded') || changed.has('vwap') || changed.has('vwapAnchoring') || changed.has('footprint') || changed.has('customMarkets') || changed.has('barStatOptions')) heat.invalidate();
    // Placing a VWAP anchor and selecting a Range both take the next press on the map: arming one ends the other.
    if (changed.has('rangeTool') && state.rangeTool && state.vwapAnchoring) store.set({ vwapAnchoring: false });
    if (changed.has('absorption') || changed.has('tradeBubbles') || changed.has('liquidations') || changed.has('show')) range.refreshHeld();
    if (changed.has('tradeBubbles') || changed.has('show')) hub.setTape(tapeWanted());
    if (changed.has('sounds')) heat.invalidate();
    if (changed.has('mark') && state.show.book) ladder.markMoved();
    if (changed.has('levels')) { if (state.show.book) ladder.levelsArrived(); ladder.invalidate(); ladder.syncVenues(); heat.invalidate(); }
    // Replay starting or ending changes what the book, the flow column and the panes show, whether or not new data arrives.
    if (changed.has('replay')) { ladder.invalidate(); cvd.invalidate(); heat.invalidate(); lower(); }
    if (changed.has('layers') || changed.has('layer') || changed.has('candles') || changed.has('mark') || changed.has('heat') || changed.has('show')) heat.invalidate();
    if (changed.has('oi') || changed.has('show')) { oi.invalidate(); bars.invalidate(); }
    if (changed.has('lt') || changed.has('show') || changed.has('sounds')) lt.refresh();
    if (changed.has('sounds')) depth.syncSound();
    // The pane is sized again only when its rows change (which, or grouped and folded), not for every option: a height set by hand stays.
    const shape = `${state.barStats.join(',')}|${state.barStatOptions.grouped}|${state.barStatOptions.folded.join(',')}`;
    if (shape !== tableShape) { tableShape = shape; arrange.setPaneHeight('bars', tableHeight(state.barStats, state.barStatOptions)); }
    if (changed.has('barStatOptions') || changed.has('footprint') || changed.has('barStats')) bars.refresh();
    if (changed.has('grouping') || changed.has('ladderMode') || changed.has('ladderShow') || changed.has('ladderCurves') || changed.has('cvd') || changed.has('pullStack') || changed.has('ladderVenue') || changed.has('ladderVenues') || changed.has('disabledVenues') || changed.has('scope')) { ladder.invalidate(); ladder.syncControls(); }
    if (changed.has('range')) { heat.invalidate(); oi.invalidate(); depth.invalidate(); lt.invalidate(); bars.invalidate(); cvd.invalidate(); }
    if (changed.has('hover')) { heat.invalidate(); oi.invalidate(); delta.invalidate(); ls.invalidate(); depth.invalidate(); lt.invalidate(); bars.invalidate(); cvd.syncHover(); }
    if (changed.has('delta')) delta.settingsChanged();
    if ((changed.has('oi') || changed.has('oiParts')) && topShown(state)) heat.invalidate();
    if (changed.has('marketId')) candle.marketChanged();
    if (['levels', 'mark', 'disabledVenues', 'scope', 'markets', 'footprint', 'customMarkets', 'replay', 'bookGone', 'show'].some(k => changed.has(k as never))) candle.invalidate();
    if (changed.has('lsMetric')) ls.settingsChanged();
    if (['show', 'timeframe', 'marketId', 'disabledVenues', 'scope', 'markets', 'oiMarkets', 'customMarkets', 'oiInstrument', 'oiParts', 'seriesInstrument', 'range'].some(k => changed.has(k as never))) ls.invalidate();
    if (['show', 'candles', 'timeframe', 'marketId', 'disabledVenues', 'scope', 'markets', 'traded', 'timeZone', 'range', 'oi', 'oiInstrument', 'oiParts'].some(k => changed.has(k as never))) delta.invalidate();
    if (['markets', 'marketId', 'timeframe', 'layer', 'show', 'heat', 'theme', 'status', 'connected', 'disabledVenues', 'heatmapSource', 'levels', 'scope', 'sounds', 'soundState', 'lastSound', 'timeZone', 'absorption', 'highlight', 'range', 'rangeTool', 'liquidations', 'keyLevels', 'vwap', 'footprint'].some(k => changed.has(k as never))) toolbar.sync(state, heat.window);
  });

  for (const p of [heat, ladder, depth, oi, delta, ls, lt, bars, cvd, candle]) p.setPalette(store.state.theme);
  layout(); ladder.syncControls(); lt.refresh();
  arrange.setPaneHeight('bars', tableHeight(store.state.barStats, store.state.barStatOptions));
  toolbar.sync(store.state, heat.window);
  await hub.start();
  await hub.loadSeries(true);
  heat.fit(); lower();
  window.setInterval(() => { void hub.loadSeries(true); }, 60_000);
  // Open interest now arrives on the venues' WebSocket streams (and Binance's 2 s REST), so the pane reads it every ten seconds: a change
  // shows within seconds, and the newest bar stops lagging a whole refresh behind.
  window.setInterval(() => { void hub.loadOi(); }, 10_000);
  (window as unknown as { __hlm: unknown }).__hlm = { store, hub, heat, ladder, cvd, candle, sounds, alerts, glass };
}

main().catch(error => {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const hint = /api\/v2/.test(message) ? t('The server is running an older build without the v2 data plane. Restart it (npm run dev) and reload.')
    : /fetch|network/i.test(message) ? t('No answer from {host}. Is the server running (npm run dev), and is this the port it listens on?', { host: location.host })
    : / 403\b/.test(message) ? t('The server refused {host}: it answers localhost and IP addresses only. Open it as http://localhost:{port}, or list this name in HLM_ALLOWED_HOSTS.', { host: location.host, port: location.port || 80 }) : '';
  document.body.append(Object.assign(document.createElement('pre'), { className: 'fatal', textContent: t('Failed to start: {message}', { message }) + (hint ? `\n\n${hint}` : '') }));
});
