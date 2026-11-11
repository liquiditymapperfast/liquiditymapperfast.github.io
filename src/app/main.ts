import { Hub, TIMEFRAMES } from './hub.ts';
import { ServerSource } from './server-source.ts';
import { BrowserSource } from './browser-source.ts';
import { chooseCoin, currentCoin, forCoin, keepCoinRecordings, scaledUsd, type CoinChoice } from './coin.ts';
import { instrumentIdFor } from '../shared/coins.ts';
import { MAX_ANCHORS, changeAnchor, putBackAnchor, withAnchor } from './vwap/settings.ts';
import { ruleName } from './anchors/anchors.ts';
import { closeAnchorEditor } from './vwap/panel.ts';
import { forgetDraft } from './anchors/controls.ts';
import { ANCHOR_REACH_MS, candleStartAt } from './vwap/vwap.ts';
import { withProfileAnchor } from './traded/settings.ts';
import { ANCHOR_BAR_MS, PROFILE_ANCHOR_REACH_MS, anchorAt } from './traded/anchor.ts';
import type { DataSource } from './source.ts';
import { loadKernels } from './kernels.ts';
import { Store, autoTheme, initialState, themeChange } from './store.ts';
import { applyTheme } from './theme.ts';
import { UiGlass } from './glass/ui-glass.ts';
import { Sounds } from './sound/sounds.ts';
import { Alerts } from './sound/alerts.ts';
import { Toolbar } from './toolbar.ts';
import { StatusBar } from './statusbar.ts';
import { anchorDate, clock, clockYear, setTimeZone, zoneName } from './format.ts';
import { installTips } from './tip.ts';
import { installClassicSelects, installTouchSelects } from './touch-select.ts';
import { lazy, preload } from './lazy.ts';
import { ScreenWake } from './wake.ts';
import { HeatPane, gutter, gutterAt, leftGutter } from './panes/heat-pane.ts';
import { LadderPane } from './panes/ladder-pane.ts';
import { CvdPane } from './panes/cvd-pane.ts';
import { BarStatsPane, DepthPane, LtPane, OiPane } from './panes/lower-panes.ts';
import { LiqPane } from './panes/liq-pane.ts';
import { setTourDemo } from './tour/demo.ts';
import { liqLevelsUrl } from './liq-url.ts';
import { DeltaPane } from './panes/delta-pane.ts';
import { NlnsSource } from './delta/nlns-source.ts';
import { LsPane } from './panes/ls-pane.ts';
import { FundingPane } from './panes/funding-pane.ts';
import { TabTitle } from './tab-title.ts';
import { ScriptPane } from './panes/script-pane.ts';
import { CandlePane } from './panes/candle-pane.ts';
import { foldPatch, matchShortcut, togglePatch } from './shortcuts.ts';
import { ReplayBar } from './replay/bar.ts';
import { pageNow, replaying } from './replay/clock.ts';
import { DrawController } from './draw/controller.ts';
import { DrawBar } from './draw/bar.ts';
import { browserStore } from './draw/storage.ts';
import { PALETTES } from './theme.ts';
import { openedSheet } from './sheet.ts';
import { dismissToast, toast } from './toast.ts';
import { topShown } from './measures/strip.ts';
import { tableHeight } from './panes/bar-stats.ts';
import { Layout, type LayoutPane } from './layout.ts';
import { LayoutActions } from './layouts/actions.ts';
import { PANE_SHOW_KEY } from './layouts/dock-model.ts';
import { Dock, axisOf, fillsArea } from './dock.ts';
import { RangeTool } from './range/tool.ts';
import { startDevice, onLayoutMode, isCoarse, isPhone, layoutMode, compactBar } from './device.ts';
import './styles.css';
import './mobile.css';
import './chrome.css';
import { t } from './i18n.ts';
import { useMarkets } from './venue-marks.ts';
import { historyHours, isHandheldPhone, savesData, type PhoneHistory } from './history-window.ts';

/** True when the page is being served by the local server (its state endpoint answers with JSON on this very origin). */
async function serverAnswers(): Promise<boolean> {
  try {
    const response = await fetch('api/v2/state', { signal: AbortSignal.timeout(1_500), cache: 'no-store' });
    return response.ok && (response.headers.get('content-type') ?? '').includes('json');
  } catch { return false; }
}
/** A host that only serves files (GitHub Pages): no server answers there, so it is not asked (a round trip of every start, ~0.2 s). */
const fileHost = (): boolean => location.hostname.endsWith('.github.io');

/**
 * Where the data comes from. A static host (GitHub Pages, any file server) has no server behind it, so the page reads the exchanges
 * itself in a worker. Served by the local server, the page uses that server and its recorded history instead. `?source=browser` or
 * `?source=server` chooses explicitly (`?persist=0` keeps a browser-source session from saving recordings). The server records BTC only,
 * so a page on another coin reads the exchanges itself wherever it is served from.
 */
async function chooseSource(params: URLSearchParams, choice: CoinChoice, phoneHistory: PhoneHistory): Promise<DataSource> {
  const wanted = params.get('source');
  if (choice.coin.coin === 'BTC' && (wanted === 'server' || (wanted !== 'browser' && !fileHost() && await serverAnswers()))) return new ServerSource();
  // A phone in the hand reads a few hours of the recorded history, not the day (app/history-window.ts).
  const historyHoursToRead = historyHours(isHandheldPhone(), phoneHistory, savesData(), compactBar());
  return new BrowserSource(new Worker(new URL('./browser/feeds.worker.ts', import.meta.url), { type: 'module' }), { persist: params.get('persist') !== '0', coin: choice.coin, tier: choice.tier, historyHours: historyHoursToRead });
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
  // A theme never picked follows the device's light or dark setting as it changes (a phone at dusk; `autoTheme`).
  if (typeof matchMedia === 'function') matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    const s = store.state, id = autoTheme(isPhone() && isCoarse(), e.matches);
    if (!s.themePicked && id !== s.theme) store.set(themeChange(s, id, false));
  });
  installTips();
  installTouchSelects();
  installClassicSelects();
  const kernels = await loadKernels();
  keepCoinRecordings();
  const source = await chooseSource(params, choice, store.state.phoneHistory);
  const hub = new Hub(store, source, { paced: true });
  const wake = new ScreenWake(); wake.set(store.state.keepAwake);
  // The browser tab says the price: in its title, and its icon is the candle under way (GitHub issue #7).
  new TabTitle(store);

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
  toolbar.setCollapsed(store.state.barCollapsed);
  source.venues.watch?.(entries => statusbar.setVenues(entries));
  const showStatus = (): void => statusbar.update(store.state, hub.recordedSince, source.kind === 'server' ? 'server' : source.saving?.(Date.now()) ?? 'starting');
  window.setInterval(showStatus, 1000);

  const heat = new HeatPane(chart, store, hub, kernels);
  toolbar.placeRecenter(heat.root);
  // The tour's moving picture of the right-button drag moves this chart (tour/demo.ts), and puts its view back when its step is left.
  setTourDemo({ plotRect: () => heat.plotRect(), zoom: (press, at) => heat.demoZoom(press, at), end: () => heat.endDemo() });
  const bars = new BarStatsPane(chart, store, heat.view, heat, hub);
  const depth = new DepthPane(chart, store, heat.view, hub);
  // NL/NS, worked out once and read by the OI pane (its bars by who opened), the Delta pane and the Funding pane.
  const nlns = new NlnsSource(hub);
  const oi = new OiPane(chart, store, heat.view, hub.flow, nlns);
  const delta = new DeltaPane(chart, store, heat.view, hub, nlns);
  heat.divergences = () => delta.divergences; delta.onDivergences = () => heat.invalidate();
  const ls = new LsPane(chart, store, heat.view, hub);
  // A venue's funding and premium, read by the page itself, and on Hyperliquid who opened each hour (NL/NS).
  const funding = new FundingPane(chart, store, heat.view, nlns);
  const lt = new LtPane(chart, store, heat.view, hub);
  const script = new ScriptPane(chart, store, heat.view, hub);
  // Scripts read the candles the chart draws, its own and the exchange's before them, and the map asks for some before its left edge while they
  // run (Karl, 2026-11-03: a script's line began wherever the 500th candle back fell).
  script.candlesOf = state => heat.scriptCandles(state);
  script.barsState = () => heat.scriptBarsState();
  // The scripts' candles from the exchange came in or are whole: the scripts look again, and an open Scripts panel says how they stand.
  heat.onScriptHistory = () => { script.refresh(); script.candlesRead(); };
  heat.scriptsReading = () => script.reading;
  // The scripts placed on the map draw over it, and a script's candle colours (`$price.color`) colour its candles.
  heat.scriptLayer = (ctx, pw, ph) => script.paintOnMap(ctx, pw, ph); heat.candleColor = t => script.candleColorAt(t); script.onMapChanged = () => heat.invalidate();
  heat.scriptHover = (t, y, touch) => script.mapHoverLines(t, y, touch); heat.scriptMarkAt = (x, y, touch) => script.mapMarkAt(x, y, touch);
  // The map's legend lists the scripts drawn on it, each with its buttons (open, switch off) in a layer over the map.
  heat.scriptLegend = (t, valued) => script.mapLegend(t, valued); heat.onScriptLegend = places => script.placeLegendTools(places); heat.root.append(script.legendTools);
  // The Scripts lamp and key in the top bar: the key opens the panel (from the pane's own button too), the lamp says what the scripts do.
  toolbar.onOpenScripts = anchor => script.openPanel(anchor); script.onStatus = (note, name) => toolbar.setScriptsStatus(note, name);
  script.panelAnchor = () => toolbar.scriptsAnchor;
  // Tools an agent in the browser may call (agent/): read the chart and the scripts, try one, show one as a draft. Only a browser with page
  // tools loads them; nothing they do saves a script.
  if ('modelContext' in document) void lazy(() => import('./agent/register.ts')).then(m => { m?.registerAgentTools(store, script); });
  /** Whether the Scripts pane has rows to show: Scripts is on and a script that is on draws in a row (one on the map needs no pane). */
  const scriptRows = (s: typeof store.state): boolean => s.show.script && script.hasRows;
  const ladder = new LadderPane(side, store, kernels, hub);
  const cvd = new CvdPane(flowCol, store, hub, heat.view);
  // The phone's Candle view: a tab of its own that fills the area (panes/candle-pane.ts); it counts the markets the map's footprint counts.
  const candle = new CandlePane(main, store, hub, kernels, s => heat.footprintMarkets(s));
  // The phone's Liq tab: the liquidation ladder, next to the Book (panes/liq-pane.ts).
  const liq = new LiqPane(main, store, hub);
  // Every pane drawn in the page's palette: a theme picked, or previewed by hover, repaints them all (one list, so none is left in the old one).
  const themed = [heat, ladder, depth, oi, delta, ls, funding, lt, bars, script, cvd, candle, liq];
  toolbar.tapeFields = () => candle.settingsFields();
  // The map and the panes under it, top down. Each pane but the map shows while its switch is on (`layout`, by `PANE_SHOW_KEY`), the Scripts
  // pane only for scripts drawn in rows.
  const strip: LayoutPane[] = [
    { id: 'heat', root: heat.root, min: 240 },
    { id: 'bars', root: bars.root, height: 84, min: 56, head: bars.header },
    { id: 'depth', root: depth.root, height: 132, min: 70, head: depth.header },
    { id: 'oi', root: oi.root, height: 150, min: 60, head: oi.header },
    { id: 'delta', root: delta.root, height: 150, min: 60, head: delta.header },
    { id: 'ls', root: ls.root, height: 120, min: 60, head: ls.header },
    { id: 'funding', root: funding.root, height: 140, min: 70, head: funding.header },
    { id: 'lt', root: lt.root, height: 128, min: 70, head: lt.header },
    { id: 'script', root: script.root, height: 220, min: 60, head: script.header, closable: false },
  ];
  const arrange = new Layout(main, chart, { left: flowCol, right: side }, strip, [
    { id: 'cvd', root: cvd.root, head: cvd.controls, title: t('Flow') },
    { id: 'book', root: ladder.root, head: ladder.controls, title: t('Order Book') },
  ]);
  // What the person does to the layout (layouts/actions.ts): the layouts panel, a pane's close button and the edge tab of a closed side pane (the Panels row in the top bar flips the same switches).
  const layouts = new LayoutActions(store, {
    arrangement: () => arrange.arrangement(), apply: a => arrange.apply(a), defaults: () => arrange.defaults(), swapSides: () => arrange.swapSides(),
    env: () => ({ width: window.innerWidth, height: chart.clientHeight || Math.max(400, window.innerHeight - 200), held: scriptRows(store.state) ? ['script' as const] : [] }),
  });
  arrange.onClose = id => layouts.hide(id, arrange.title(id)); arrange.onOpen = id => layouts.setPane(id, true);
  // A desktop folds its side columns to their edge tabs when the map would be left too little plot (layouts/dock-model.ts `chooseFold`).
  arrange.plotAt = paneW => paneW - gutterAt(paneW, store.state);
  toolbar.layouts = layouts;
  const lower = () => { depth.invalidate(); oi.invalidate(); delta.invalidate(); ls.invalidate(); funding.invalidate(); lt.invalidate(); bars.invalidate(); script.invalidate(); cvd.followMap(); };
  // Replay: the map's candle under way is rebuilt from the flow, so flow arriving while paused redraws it too (live, the map has its own pace).
  // The volume profile along the top of the map draws traded volume from the flow too: history that has landed redraws it (a live second
  // does not, `loads`; the map is drawn several times a second while frames come anyway), with the Delta pane hidden as well.
  let stripLoads = hub.flow.loads;
  // The open-interest markets are worked out from the flow and the books on the map, which come after the candles: asked again as they do.
  hub.onFlowChanged = () => { cvd.invalidate(); delta.invalidate(); script.refresh(); const landed = stripLoads !== hub.flow.loads; stripLoads = hub.flow.loads; if (replaying() || (landed && topShown(store.state))) heat.invalidate(); hub.refreshOiMarkets(); };
  // A finger on a pane under the map moves the time axis it shares with the map.
  for (const pane of [depth, oi, delta, ls, funding, lt, bars, script]) pane.useTimeGestures(heat.timeGestures());
  heat.onFrame = lower; heat.onView = lower;
  heat.onTopProfile = () => toolbar.openTradedPanel();
  heat.onArrangedChange = () => toolbar.refreshTradedPanel();
  // The panel says what of the profiles has no room, in the room the map had when it was last drawn.
  toolbar.profileRoom = () => heat.profileRoom();
  toolbar.anchoredWindow = () => heat.anchoredWindow();
  toolbar.updateAnchored = () => heat.updateAnchored();
  toolbar.profileAnchorStart = a => heat.profileAnchorStart(a);
  toolbar.profileAnchorBar = at => heat.profileAnchorBar(at);
  heat.onAnchoredWindow = () => toolbar.refreshTradedPanel();
  // The Range tool: a drag on the map, on a pane under it or across the flow column selects, and its panel adds up what happened there.
  const range = new RangeTool(store, hub); range.anchor = toolbar.rangeButton; range.mapWindow = () => ({ t0: heat.view.t0, t1: heat.view.t1 });
  heat.range = range; cvd.range = range; for (const pane of [depth, oi, delta, ls, funding, lt, bars, script]) pane.useRange(range);
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
    earliest: () => ({ depth: hub.depthSince() > 0 ? hub.depthSince() : null, candles: store.state.candles[0]?.[0] ?? null }),
    go: t => heat.goTo(t),
    live: () => { if (replaying()) replayBar.stop(); else toolbar.onRecenter(); },
  };
  hub.onWhaleChanged = () => toolbar.refreshOpenPanel();
  toolbar.onSelectMarket = id => store.set({ marketId: id });
  toolbar.onVenuesApplied = () => { void hub.refreshMarkets(); window.setTimeout(() => void hub.refreshMarkets(), 15_000); };
  const sounds = new Sounds(store); toolbar.attachSounds(sounds); sounds.start();
  // Sounds the panels may make about what happens in them (flow bursts, walls, the balance, the depth, candle closes); the bursts are also marked on the flow column.
  // The depth sound's baseline (hours of minute columns, read as the page opens) waits for the map's first columns, or 15 s where the map draws
  // none (a phone's Tape): read beside them, its hours held the server and the page's connections and the map came seconds later.
  const mapFirst = Promise.race([hub.columnsArrived, new Promise<void>(resolve => setTimeout(resolve, 15_000))]);
  const alerts = new Alerts(store, hub.flow, sounds.engine, Date.now, (ids, from) => { void hub.ensureFlow(ids, from); }, (ids, from, to) => mapFirst.then(() => hub.source.columns(ids, from, to, 60_000)));
  toolbar.attachAlerts(alerts); alerts.start();
  // A script's alerts sound through the same Sounds switch, cap and list as the panels'.
  script.onAlert = a => alerts.script(Date.now(), a.text, a.sound, a.key);
  alerts.onChange = () => cvd.invalidate(); cvd.events = alerts.bursts;
  // The drawing tools (draw/): levels, zones, lines and notes on the map, each coin's kept in this browser. The map hands them the pointer
  // first and paints them; their bar sits under the map's corner buttons (along its foot on a phone).
  const draw = new DrawController({
    view: heat.view, plotW: () => heat.plotW, plotH: () => heat.plotH,
    candleAt: x => heat.candleAt(x), closesOnly: () => store.state.chartType === 'line', wallsAt: x => heat.wallsAt(x), restingAt: price => heat.restingAt(price),
    mark: () => store.state.mark.price, coin: () => currentCoin().coin, now: pageNow, replaying, settings: () => store.state.draw,
    reveal: () => store.set({ draw: { ...store.state.draw, shown: true } }),
    disarmOthers: () => { if (store.state.rangeTool) range.stop(); if (store.state.vwapAnchoring) store.set({ vwapAnchoring: false }); if (store.state.profileAnchoring) store.set({ profileAnchoring: false }); },
    focus: box => heat.focusOn(box),
    inspect: box => { range.begin({ t: box.t0, p: box.p0 }); range.end({ t: box.t1, p: box.p1 }, false); },
    alert: (text, key) => alerts.drawing(Date.now(), text, key),
    redraw: () => heat.invalidate(),
  }, browserStore());
  heat.draw = draw;
  const drawBar = new DrawBar(draw, {
    settings: () => store.state.draw, setSettings: patch => store.set({ draw: { ...store.state.draw, ...patch } }),
    palette: () => PALETTES[store.state.theme] ?? PALETTES.light!, mark: () => store.state.mark.price, restingAt: price => heat.restingAt(price), replaying, redraw: () => heat.invalidate(),
  });
  heat.root.append(drawBar.rail, drawBar.editor, drawBar.say, drawBar.phoneButton);
  heat.onDrawFrame = f => drawBar.place(f);
  toolbar.setDrawButton(drawBar.button);
  toolbar.onPreviewChartType = id => { heat.previewChartType = id; heat.invalidate(); };
  hub.onPrints = fresh => { if (replaying()) return; sounds.feed(fresh); cvd.flash(fresh); };
  hub.onPrintsChanged = () => { heat.invalidate(); range.refreshHeld(); };
  // The trade dust: asked for while the bubbles and their Live trades switch are both on; arrivals redraw the dust alone.
  // The Candle view's trail reads the same orders, so they are asked for while it is shown whatever the bubbles' switches say.
  const candleShown = (): boolean => dock.tab === 'candle' && isPhone();
  const liqShown = (): boolean => dock.tab === 'liq' && isPhone();
  // The Flow tab fills the area as the Tape does, and the Book held upright: the map is covered under them (what the Flow draws ends now, whatever the map's window is).
  const mapCovered = (): boolean => isPhone() && fillsArea(dock.tab, axisOf(layoutMode()));
  // The glass around the chart (glass/ui-glass.ts): lit by the large orders where the map shows them.
  const glass = new UiGlass((price, t) => heat.liveSpot(price, t), () => hub.tape);
  cvd.onLargeFlow = (x, y, usd) => glass.pulse(x, y, usd, scaledUsd(100_000), usd > 0 ? 0 : 1);
  glass.setStrength(store.state.waveStrength);
  // The chrome turns see-through once the glass can draw behind it: its programs are built beside the page, and it says so itself then.
  const applyMaterial = (): void => {
    glass.setPalette(applyTheme(store.state.theme));
    glass.setOn(store.state.material === 'glass');
    document.documentElement.dataset.material = glass.showing ? 'glass' : 'solid';
  };
  // On a phone the Tape keeps the market's orders from the page's opening, whichever tab shows, so the ring runs there always.
  // The book's cues read the tape for the contact ripples and for what traded beside a change (the hover), so they want it whether or not the ripples are on.
  const tapeWanted = (): boolean => (store.state.show.bubbles && store.state.tradeBubbles.live) || candleShown() || store.state.material === 'glass' || isPhone() || (store.state.show.book && store.state.ladderCues.look !== 'off');
  // The map is covered while a view that fills the area shows, and the book while any tab but its own does (the Tape draws its own): they draw nothing then, and catch up when they show again.
  const coverPanes = (): void => { const covered = mapCovered(); heat.setSuspended(covered); hub.mapCovered = covered; ladder.setSuspended(isPhone() && dock.tab !== 'book'); };
  dock.onChange = () => { candle.setShown(candleShown()); liq.setShown(liqShown()); coverPanes(); hub.setTape(tapeWanted()); };
  hub.setTape(tapeWanted());
  hub.onTape = () => { heat.tapeArrived(); candle.tapeArrived(); glass.tapeArrived(); ladder.tapeArrived(); };
  applyMaterial();
  // Trades recovered from a venue's history (the browser engine): no flow burst is sounded over them.
  hub.onRecovered = (id, _from, to) => { alerts.recovered.set(id, Math.max(alerts.recovered.get(id) ?? 0, to)); };
  hub.onLiquidationsChanged = () => { heat.invalidate(); range.refreshHeld(); };
  // Candles that came after the first frame (an exchange blocked here, the reference market read once known) are framed, unless the map was moved.
  // A refill frames the map only while nobody has moved it since it was last framed: not under a hand, a drawing being placed or a zoom of one's own.
  hub.onSeriesRefilled = () => { if (store.state.followLive && heat.untouched) heat.fit(); lower(); };
  toolbar.keyHistory = hub.keyHistory;
  toolbar.liqSource = hub.liqLevels;
  toolbar.profileHistory = barMs => hub.profileHistory(barMs);
  toolbar.whaleInfo = () => ({ since: hub.whale?.since ?? null, state: hub.whaleState, browser: source.kind === 'browser' });
  toolbar.rollingReach = days => heat.rollingReach(days);
  toolbar.vwapMarkets = () => heat.vwapMarketStates();
  toolbar.ruleStart = rule => heat.ruleStart(rule);
  toolbar.anchorDrawnFrom = (id, at) => heat.anchorDrawnFrom(id, at);
  toolbar.tpoInfo = () => heat.tpoInfo();
  heat.onRollingReach = () => toolbar.refreshOpenPanel();
  // Placing an anchor, the VWAP's or the profile's: where a moment on the map would put it (the start of its candle; the profile's on its five
  // minutes), or why it cannot go there (the empty future, further back than it reaches: a word, and the tool stays armed; it disarmed
  // silently, and a VWAP anchor older than two months was saved and never drawn: a user, 2026-11-10).
  const anchorSpot = (at: number): { start: number } | { refused: string } => {
    // The start of the candle drawn there: zoomed out, a longer one made of the chart's (heat-pane `drawnTf`), as its preview shows.
    const s = store.state, tf = heat.drawnTf(s), now = Date.now(), vwap = s.vwapAnchoring;
    const start = vwap ? candleStartAt(at, tf) : heat.profileAnchorAt(at, s);
    if (start > now) return { refused: t('No candle there yet.') };
    if (start < now - (vwap ? ANCHOR_REACH_MS : PROFILE_ANCHOR_REACH_MS)) return { refused: vwap ? t('Too far back: an anchor reaches ten years.') : t('Too far back: the columns reach two years.') };
    return { start };
  };
  // Put the anchor there: a VWAP one added, or the one being moved (its Move) put there and fixed from now on; the profile's set (one a coin).
  const placeAnchor = (start: number): void => {
    const s = store.state, coin = currentCoin().coin;
    if (s.vwapAnchoring) {
      const vwap = { ...s.vwap, on: true }, move = s.anchorMove;
      // The anchor being moved was removed meanwhile (its row's x, Undo elsewhere): placing stops, said as what happened.
      if (move && !s.vwap.anchors[coin]?.some(a => a.id === move)) { store.set({ vwapAnchoring: false, anchorMove: null, anchorPreview: null }); toast(t('That anchor was removed, so there is nothing to move.')); toolbar.refreshOpenPanel(); return; }
      const next = move ? changeAnchor(vwap, coin, move, { at: start }) : withAnchor(vwap, coin, { at: start }, Date.now());
      // Refused (another anchor starts on that candle, or the coin has six already): said, never a silent disarm (the advisor, 2026-11-11);
      // on a taken candle the tool stays armed for another.
      if (next === vwap) {
        const full = !move && (s.vwap.anchors[coin]?.length ?? 0) >= MAX_ANCHORS;
        if (full) { store.set({ vwapAnchoring: false, anchorMove: null, anchorPreview: null }); toast(t('Up to six anchors: remove one to add another.')); toolbar.refreshOpenPanel(); }
        else { store.set({ anchorPreview: null }); toolbar.anchorHint(t('An anchor starts on that candle already: choose another.')); }
        return;
      }
      // The anchor as it was, read before the store takes the move (the store's state object is changed in place).
      const was = move ? s.vwap.anchors[coin]?.find(a => a.id === move) : undefined;
      store.set({ vwap: next, vwapAnchoring: false, anchorMove: null, anchorPreview: null });
      if (move && was) {
        // A move by a candle has its Undo, as a move by date has (Sol, review round 2); the editor's typed date is let go, or Undo would bring
        // the anchor back to where that draft was typed and the draft with it (round 3).
        closeAnchorEditor(move); forgetDraft(`vwap-anchor-${move}`);
        const now = next.anchors[coin]!.find(a => a.id === move)!;
        const label = was.rule ? ruleName(was.rule) : `${t('AVWAP')} ${anchorDate(was.at!)}`;
        toolbar.refreshOpenPanel();
        toast(t('{line} moved to {time}.', { line: label, time: clockYear(start) }), { ms: 8_000, action: { label: t('Undo'), run: () => {
          const back = putBackAnchor(store.state.vwap, coin, now, was);
          if (back === store.state.vwap) { toast(t('Not undone: the anchor has changed since.')); return; }
          store.set({ vwap: back }); toolbar.refreshOpenPanel();
        } } });
        return;
      }
    } else if (s.profileAnchoring) {
      store.set({ traded: withProfileAnchor({ ...s.traded, columns: 'anchor' }, coin, { at: start }), profileAnchoring: false, anchorPreview: null, show: { ...s.show, traded: true } });
    }
    dismissToast(); toolbar.refreshOpenPanel();
  };
  // A click with a mouse places at once: the dashed line under the pointer showed where.
  heat.onAnchor = at => { const spot = anchorSpot(at); if ('refused' in spot) toolbar.anchorHint(spot.refused); else placeAnchor(spot.start); };
  heat.onProfileAnchor = heat.onAnchor;
  // A tap on a touch screen, or the arrow keys, only shows where (Sol, 2026-11-11: a finger covers the candle it lands on): Place here puts it
  // there, another tap or arrow moves it, Cancel stops.
  const previewAnchor = (at: number): void => {
    const spot = anchorSpot(at);
    if ('refused' in spot) { toolbar.anchorHint(spot.refused); return; }
    store.set({ anchorPreview: spot.start });
    toast(`${clockYear(spot.start)} ${zoneName(store.state.timeZone, spot.start).replace(/-/g, '\u2011')}`, { ms: 120_000, actions: [
      { label: t('Place here'), run: () => placeAnchor(spot.start) },
      { label: t('Cancel'), run: () => store.set({ vwapAnchoring: false, profileAnchoring: false, anchorPreview: null }) },
    ] });
  };
  heat.onAnchorPreview = previewAnchor;
  hub.onTraded = () => heat.invalidate();
  hub.onAbsorptionChanged = () => { heat.invalidate(); range.refreshHeld(); };
  toolbar.absorptionInfo = () => heat.absorptionThresholdText();
  // Hovering a theme shows it everywhere without saving it; leaving the menu puts the saved one back.
  toolbar.onPreviewTheme = id => { const name = id ?? store.state.theme; glass.setPalette(applyTheme(name)); for (const p of themed) p.setPalette(name); toolbar.previewTheme(name); };
  heat.onStats = () => toolbar.sync(store.state, heat.window);

  // An address like #guide/mirror opens the guide there.
  const fromAddress = (): void => { if (/^#guide/.test(location.hash)) void lazy(() => import('./guide/guide.ts')).then(m => m?.openFromAddress()); };
  fromAddress(); window.addEventListener('hashchange', fromAddress);

  // The screenshot tool is fetched a few seconds in, so a deploy while the page is open cannot leave it asking for a file that is gone.
  window.setTimeout(() => preload(() => import('./screenshot/editor.ts')), 5_000);

  // The keyboard shortcuts (shortcuts.ts: the table, and when a key is left alone).
  // Placing an anchor (the VWAP's or the profile's), from the keyboard: Esc stops, the arrows step the candle it would take (from the one under
  // the pointer, or the newest), Enter puts it there. Not while a field, a window or a menu has the keys, nor with a modifier held. It runs
  // before the panels' own keys, so Esc stops the placing and leaves the panel open (a second Esc closes it; Sol, review 2026-11-11).
  window.addEventListener('keydown', e => {
    const placing = store.state.vwapAnchoring || store.state.profileAnchoring, field = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement || document.activeElement instanceof HTMLTextAreaElement;
    if (!placing || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || field || document.querySelector('dialog[open], .menu') !== null) return;
    // The arrows and Enter only where the keyboard is on the page itself, the chart, or a "Click a candle" button: any other control keeps
    // its keys (a pane splitter its arrows, a button or a toast's its Enter; Sol, review round 2). Esc stops placing wherever it is.
    const active = document.activeElement, neutral = !active || active === document.body || active instanceof HTMLCanvasElement || (active instanceof HTMLElement && active.dataset.placing === 'true');
    if (e.key !== 'Escape' && !neutral) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); store.set({ vwapAnchoring: false, profileAnchoring: false, anchorMove: null, anchorPreview: null }); dismissToast(); toolbar.refreshOpenPanel(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); e.stopImmediatePropagation();
      const s = store.state, from = s.anchorPreview ?? (s.hover?.source === 'heat' ? s.hover.t : s.candles.at(-1)?.[0] ?? Date.now());
      // A step is a candle drawn, or the profile's bar there where that is longer (hours past 21 weeks).
      const tf = s.vwapAnchoring ? heat.drawnTf(s) : Math.max(heat.drawnTf(s), ANCHOR_BAR_MS, heat.profileAnchorBar(from));
      previewAnchor(from + (s.anchorPreview === null ? 0 : e.key === 'ArrowLeft' ? -tf : tf));
      return;
    }
    if (e.key === 'Enter' && store.state.anchorPreview !== null) { e.preventDefault(); e.stopImmediatePropagation(); placeAnchor(store.state.anchorPreview); }
  }, true);
  window.addEventListener('keydown', e => {
    // The drawing tools' keys first (Esc, Delete, Undo and Redo), when no field or window has them.
    const inPanel = document.activeElement instanceof HTMLElement && document.activeElement.closest('.panel') !== null;
    if (draw.key(e, document.querySelector('dialog[open]') !== null || openedSheet() !== null || inPanel)) { e.preventDefault(); return; }
    const hit = matchShortcut(e, document.querySelector('dialog[open]') !== null);
    if (!hit) return;
    e.preventDefault();
    const a = hit.action;
    if (a.kind === 'timeframe') store.set({ timeframe: a.tf });
    else if (a.kind === 'recenter') toolbar.onRecenter();
    else if (a.kind === 'now') heat.jumpToNow();
    else if (a.kind === 'zoom') heat.zoomStep(a.dir);
    else if (a.kind === 'toggle') { store.set(togglePatch(store.state, a.feature)); toolbar.refreshOpenPanel(); }
    else if (a.kind === 'fold') { store.set(foldPatch(store.state)); toolbar.refreshOpenPanel(); }
    else if (a.kind === 'column') layouts.toggleColumn(a.side);
    else if (a.kind === 'range') range.toggle();
    else if (a.kind === 'draw') drawBar.toggle();
    else if (a.kind === 'goto') toolbar.openGoTo();
    else if (a.kind === 'screenshot') void lazy(() => import('./screenshot/editor.ts')).then(m => m?.startScreenshot());
    else toolbar.openShortcuts();
  });

  // The profile column and axis are narrower on a phone; everything that aligns to them has to redraw when that changes.
  onLayoutMode(() => { layout(); heat.invalidate(); lower(); drawBar.sync(); toolbar.sync(store.state, heat.window); candle.setShown(candleShown()); liq.setShown(liqShown()); coverPanes(); hub.setTape(tapeWanted()); });
  // The columns beside the map: what the corner buttons and the replay bar keep clear of (the map's own pane sets them each frame too).
  const gutters = () => {
    const s = store.state;
    document.documentElement.style.setProperty('--gutter', `${gutter(s)}px`); document.documentElement.style.setProperty('--gutter-left', `${leftGutter(s)}px`);
  };
  const layout = () => {
    const s = store.state;
    gutters();
    // Every pane under the map follows its switch, by the layouts' own map of them: the Funding pane, left out of a list written out by
    // hand here, showed for everyone whatever its switch said (2026-11-07). The Scripts pane is there only for scripts drawn in rows.
    for (const p of strip) { const key = PANE_SHOW_KEY[p.id]; if (key && p.id !== 'script') p.root.hidden = !s.show[key]; }
    script.root.hidden = !scriptRows(s);
    // The two side panels vanish and return at once: nothing is rebuilt, a hidden column is simply not laid out (a closed one leaves an edge tab).
    arrange.sides({ cvd: s.show.cvd, book: s.show.book });
    arrange.rebuild();
    if (s.show.cvd) cvd.invalidate(); if (s.show.book) ladder.invalidate();
    // The Scripts tab, like its pane, is there only for scripts drawn in rows: those on the map need neither.
    // The Liq tab is there while Liquidation levels are on and have an address to be read from.
    dock.sync({ ...s.show, script: scriptRows(s), liq: s.liqLevels.on && !!liqLevelsUrl() });
  };
  script.onRowsChanged = () => layout();

  /** The Bar stats rows the pane was last sized for: which, grouped or not, which kinds folded. */
  let tableShape = `${store.state.barStats.join(',')}|${store.state.barStatOptions.grouped}|${store.state.barStatOptions.folded.join(',')}`;
  store.subscribe((state, changed) => {
    if (changed.has('keepAwake')) wake.set(state.keepAwake);
    // Every time on the page is written from the one setting: say it changed, and have what shows times draw again.
    if (changed.has('timeZone')) { setTimeZone(state.timeZone); heat.invalidate(); lower(); cvd.invalidate(); showStatus(); }
    if (changed.has('theme')) { glass.setPalette(applyTheme(state.theme)); for (const p of themed) p.setPalette(state.theme); }
    if (changed.has('material')) { applyMaterial(); hub.setTape(tapeWanted()); }
    // The page's glass draws its next frame with the new strength; the Tape's reads it with each frame it draws.
    if (changed.has('waveStrength')) { glass.setStrength(state.waveStrength); candle.invalidate(); }
    if (changed.has('cvd')) cvd.settingsChanged();
    if (changed.has('status') || changed.has('connected') || changed.has('mark')) showStatus();
    if (changed.has('show') || changed.has('liqLevels')) layout(); else if (changed.has('traded')) { gutters(); arrange.refit(); }
    // The map's own columns change with the market too (the liquidation column is BTC's, the price axis as wide as its prices).
    if (changed.has('marketId')) arrange.refit();
    if (changed.has('mark') || changed.has('liqLevels')) liq.invalidate();
    if (changed.has('marketId') || changed.has('timeframe')) {
      // A series kept from before is framed the moment it is shown; one read afresh when it comes (framing it again then would undo a pan made meanwhile).
      let framed = false;
      void hub.loadSeries(true, () => { framed = true; heat.fit(); lower(); }).then(() => { if (!framed) heat.fit(); lower(); });
    }
    if (changed.has('disabledVenues') || changed.has('heatmapSource') || changed.has('scope')) { heat.dataChanged(); depth.refresh(); lt.refresh(); cvd.refresh(); }
    if (changed.has('markets')) cvd.invalidate();
    // Open interest added up over the venues switched on: another choice of them is another series. Not the Spot / Perp filter, which
    // open interest does not follow (`oiFlowIds`).
    if (changed.has('oiMarkets') || changed.has('disabledVenues') || changed.has('customMarkets') || (changed.has('markets') && store.state.oiMarkets === 'custom')) void hub.loadOi();
    else if (changed.has('levels') || changed.has('markets') || changed.has('bookGone')) hub.refreshOiMarkets();
    if (changed.has('highlight')) { heat.invalidate(); oi.invalidate(); depth.invalidate(); }
    if (changed.has('depthBands') || changed.has('liqBands')) depth.settingsChanged();
    if (changed.has('depthSource')) depth.refresh();
    if (changed.has('absorption') || changed.has('tradeBubbles') || changed.has('liquidations') || changed.has('keyLevels') || changed.has('traded') || changed.has('vwap') || changed.has('tpo') || changed.has('vwapAnchoring') || changed.has('profileAnchoring') || changed.has('footprint') || changed.has('customMarkets') || changed.has('barStatOptions')) heat.invalidate();
    // Placing a VWAP anchor, selecting a Range and placing a drawing all take the next press on the map: arming one ends the others.
    if (changed.has('rangeTool') && state.rangeTool && state.vwapAnchoring) store.set({ vwapAnchoring: false });
    // Placing ended, however it ended (placed, Esc, Cancel, another tool): the anchor being moved, if any, is no longer.
    if (changed.has('vwapAnchoring') && !state.vwapAnchoring && state.anchorMove !== null) store.set({ anchorMove: null });
    if ((changed.has('vwapAnchoring') || changed.has('profileAnchoring')) && !state.vwapAnchoring && !state.profileAnchoring && state.anchorPreview !== null) store.set({ anchorPreview: null });
    // The preview line moved by the keys or a tap is drawn at once, not at the pointer's next move (Sol, review 2026-11-11).
    if (changed.has('anchorPreview')) heat.invalidate();
    // Placing ended or begun elsewhere (a toast's Cancel, another tool armed, Esc): the open panel's buttons say so at once (code review).
    if (changed.has('vwapAnchoring') || changed.has('profileAnchoring') || changed.has('anchorMove')) toolbar.refreshOpenPanel();
    // One tool takes the next press on the map at a time: arming the profile anchor ends the VWAP's, the Range tool's and a drawing's, and
    // arming one of those ends it.
    if (changed.has('profileAnchoring') && state.profileAnchoring) { if (state.vwapAnchoring) store.set({ vwapAnchoring: false }); if (state.rangeTool) range.stop(); }
    // On a phone the panel and the Settings sheet cover the map: they make way for the tap that places the anchor.
    if ((changed.has('profileAnchoring') && state.profileAnchoring) || (changed.has('vwapAnchoring') && state.vwapAnchoring)) toolbar.anchorArmed();
    if (((changed.has('rangeTool') && state.rangeTool) || (changed.has('vwapAnchoring') && state.vwapAnchoring)) && state.profileAnchoring) store.set({ profileAnchoring: false });
    if ((changed.has('rangeTool') && state.rangeTool) || (changed.has('vwapAnchoring') && state.vwapAnchoring) || (changed.has('profileAnchoring') && state.profileAnchoring)) draw.disarm();
    if (changed.has('draw')) draw.settingsChanged();
    if (changed.has('draw') || changed.has('theme') || changed.has('replay')) { heat.invalidate(); drawBar.sync(); }
    // A drawing half placed belongs to the chart it was begun on; a level with an alert is watched as the price moves.
    if (changed.has('timeframe') || changed.has('marketId') || changed.has('chartType') || changed.has('replay')) draw.contextChanged();
    if (changed.has('mark')) draw.markMoved(state.mark.price);
    if (changed.has('chartType')) heat.invalidate();
    // The candles' own colours: the map, the book's price row and the Tape view's mark are drawn in them (Sol: nothing else asked for a frame).
    if (changed.has('candleColors')) { heat.invalidate(); ladder.invalidate(); candle.invalidate(); }
    if (changed.has('absorption') || changed.has('tradeBubbles') || changed.has('liquidations') || changed.has('show')) range.refreshHeld();
    if (changed.has('tradeBubbles') || changed.has('show')) hub.setTape(tapeWanted());
    if (changed.has('sounds')) heat.invalidate();
    if (changed.has('mark') && state.show.book) ladder.markMoved();
    if (changed.has('levels')) { if (state.show.book) ladder.levelsArrived(); ladder.invalidate(); ladder.syncVenues(); heat.invalidate(); }
    // The cues' look and heat, and a reconnect (what the book showed before it is not compared with what it shows after).
    if (changed.has('ladderCues')) { ladder.cuesChanged(); hub.setTape(tapeWanted()); }
    if (changed.has('connected') || (changed.has('show') && !state.show.book)) ladder.interrupted();
    // Replay starting or ending changes what the book, the flow column and the panes show, whether or not new data arrives.
    if (changed.has('replay')) { ladder.invalidate(); cvd.invalidate(); heat.invalidate(); lower(); }
    if (changed.has('layers') || changed.has('layer') || changed.has('candles') || changed.has('mark') || changed.has('heat') || changed.has('show')) heat.invalidate();
    if (changed.has('oi') || changed.has('show')) { oi.invalidate(); bars.invalidate(); }
    else if (changed.has('oiReading') || changed.has('oiFine')) oi.invalidate();
    if (changed.has('oiChange') || changed.has('oiTable')) oi.settingsChanged();
    if (changed.has('lsTable')) ls.tableChanged();
    // The minute readings NL/NS works candles out on are read while something shown uses them (`fineWant`), whatever the timeframe.
    if (['show', 'oiChange', 'delta', 'timeframe', 'oiParts', 'oiInstrument', 'fundingVenue'].some(k => changed.has(k as never))) void hub.loadOiFine();
    // A script that reads the change in open interest runs again once it lands, not at its next refresh.
    if (changed.has('oi') || changed.has('oiParts')) script.refresh();
    if (changed.has('show')) script.showChanged();
    if (changed.has('lt') || changed.has('show') || changed.has('sounds')) lt.refresh();
    if (changed.has('sounds')) depth.syncSound();
    // The pane is sized again only when its rows change (which, or grouped and folded), not for every option: a height set by hand stays.
    const shape = `${state.barStats.join(',')}|${state.barStatOptions.grouped}|${state.barStatOptions.folded.join(',')}`;
    if (shape !== tableShape) { tableShape = shape; arrange.setPaneHeight('bars', tableHeight(state.barStats, state.barStatOptions)); }
    if (changed.has('barStatOptions') || changed.has('footprint') || changed.has('barStats')) bars.refresh();
    if (changed.has('grouping') || changed.has('ladderMode') || changed.has('ladderShow') || changed.has('ladderCurves') || changed.has('cvd') || changed.has('pullStack') || changed.has('ladderVenue') || changed.has('ladderVenues') || changed.has('disabledVenues') || changed.has('scope')) { ladder.invalidate(); ladder.syncControls(); }
    if (changed.has('range')) { heat.invalidate(); oi.invalidate(); depth.invalidate(); lt.invalidate(); bars.invalidate(); script.invalidate(); cvd.invalidate(); }
    if (changed.has('hover')) { heat.invalidateHover(); oi.invalidate(); delta.invalidate(); ls.invalidate(); funding.invalidate(); depth.invalidate(); lt.invalidate(); bars.invalidate(); script.invalidate(); cvd.syncHover(); }
    if (changed.has('fundingVenue') || changed.has('fundingTable')) funding.settingsChanged();
    if (['show', 'timeframe', 'oiFine', 'range', 'replay'].some(k => changed.has(k as never))) funding.invalidate();
    // The order book's row under the pointer: the map and the flow column's price strip draw its price.
    if (changed.has('bookHover')) { heat.invalidateHover(); cvd.syncBookHover(); }
    if (changed.has('delta')) delta.settingsChanged();
    if ((changed.has('oi') || changed.has('oiParts')) && topShown(state)) heat.invalidate();
    if (changed.has('marketId')) candle.marketChanged();
    if (['levels', 'mark', 'disabledVenues', 'scope', 'markets', 'footprint', 'customMarkets', 'replay', 'bookGone', 'show'].some(k => changed.has(k as never))) candle.invalidate();
    if (changed.has('lsMetric')) ls.settingsChanged();
    // The panes follow the room the bar leaves or takes by themselves (each watches its own size).
    if (changed.has('barCollapsed')) toolbar.setCollapsed(state.barCollapsed);
    if (['show', 'timeframe', 'marketId', 'disabledVenues', 'scope', 'markets', 'oiMarkets', 'customMarkets', 'oiInstrument', 'oiParts', 'seriesInstrument', 'range'].some(k => changed.has(k as never))) ls.invalidate();
    if (['show', 'candles', 'timeframe', 'marketId', 'disabledVenues', 'scope', 'markets', 'traded', 'timeZone', 'range', 'oi', 'oiInstrument', 'oiParts', 'oiFine'].some(k => changed.has(k as never))) delta.invalidate();
    if (['markets', 'marketId', 'timeframe', 'layer', 'show', 'heat', 'theme', 'status', 'connected', 'disabledVenues', 'heatmapSource', 'levels', 'scope', 'sounds', 'soundState', 'lastSound', 'waveStrength', 'timeZone', 'absorption', 'highlight', 'range', 'rangeTool', 'liquidations', 'keyLevels', 'vwap', 'tpo', 'footprint', 'tabPrice', 'tabIcon', 'chartType', 'phoneHistory'].some(k => changed.has(k as never))) toolbar.sync(state, heat.window);
  });

  for (const p of themed) p.setPalette(store.state.theme);
  layout(); ladder.syncControls(); lt.refresh();
  layouts.seedDefault();
  arrange.setPaneHeight('bars', tableHeight(store.state.barStats, store.state.barStatOptions));
  toolbar.sync(store.state, heat.window);
  // The page opens on the coin's Binance perpetual wherever it is read (`defaultMarket`): its series is asked for as the page starts. Giving
  // the store its market started the load of it (the subscription above): this waits for that one rather than reading the candles again.
  await hub.start(instrumentIdFor('binance', choice.coin) ?? '');
  await hub.loadSeries();
  heat.fit(); lower();
  // A tab saved from the last visit is already showing: what it covers draws nothing from the start, not from the first tap (the dock only tells of a change).
  candle.setShown(candleShown()); liq.setShown(liqShown()); coverPanes();
  // A reload that fails is said (the series on screen stays); the next minute asks again.
  window.setInterval(() => { hub.loadSeries(true).catch((error: unknown) => console.warn('The candles could not be read again:', error)); }, 60_000);
  // Each new open-interest reading is pushed as it lands (Hub.#oiPush); this load is the reconciliation: history, the markets added
  // together, a reading a push missed.
  window.setInterval(() => { void hub.loadOi(); void hub.loadOiFine(); }, 20_000);
  // A visitor the tour was never offered to is offered it once, a moment after the page has drawn (`?tour=0` leaves it out, for pictures and tests). With a window or the
  // Settings sheet open over the page at that moment it asks again every few seconds, for a minute, and records nothing until the offer is on the screen.
  if (new URLSearchParams(location.search).get('tour') !== '0') {
    let asked = 0;
    const offer = (): void => { if (!toolbar.inviteToTour() && ++asked < 12) window.setTimeout(offer, 5_000); };
    window.setTimeout(offer, 2500);
  }
  (window as unknown as { __hlm: unknown }).__hlm = { store, hub, heat, ladder, cvd, candle, sounds, alerts, glass, script };
}

main().catch(error => {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const hint = /api\/v2/.test(message) ? t('The server is running an older build without the v2 data plane. Restart it (npm run dev) and reload.')
    : /fetch|network/i.test(message) ? t('No answer from {host}. Is the server running (npm run dev), and is this the port it listens on?', { host: location.host })
    : / 403\b/.test(message) ? t('The server refused {host}: it answers localhost and IP addresses only. Open it as http://localhost:{port}, or list this name in HLM_ALLOWED_HOSTS.', { host: location.host, port: location.port || 80 }) : '';
  document.body.append(Object.assign(document.createElement('pre'), { className: 'fatal', textContent: t('Failed to start: {message}', { message }) + (hint ? `\n\n${hint}` : '') }));
});
