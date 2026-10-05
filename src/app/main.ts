import { Hub } from './hub.ts';
import { ServerSource } from './server-source.ts';
import { BrowserSource } from './browser-source.ts';
import type { DataSource } from './source.ts';
import { loadKernels } from './kernels.ts';
import { Store, initialState } from './store.ts';
import { applyTheme } from './theme.ts';
import { Sounds } from './sound/sounds.ts';
import { Toolbar } from './toolbar.ts';
import { installTips } from './tip.ts';
import { HeatPane, gutter, setCompactGutters } from './panes/heat-pane.ts';
import { LadderPane } from './panes/ladder-pane.ts';
import { BarStatsPane, DepthPane, LtPane, OiPane } from './panes/lower-panes.ts';
import { enabledStats } from './panes/bar-stats.ts';
import { Layout } from './layout.ts';
import { Dock } from './dock.ts';
import { startDevice, isPhone, onLayoutMode } from './device.ts';
import './styles.css';
import './mobile.css';

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
 * `?source=server` chooses explicitly (`?persist=0` keeps a browser-source session from saving recordings).
 */
async function chooseSource(params: URLSearchParams): Promise<DataSource> {
  const wanted = params.get('source');
  if (wanted === 'server' || (wanted !== 'browser' && await serverAnswers())) return new ServerSource();
  return new BrowserSource(new Worker(new URL('./browser/feeds.worker.ts', import.meta.url), { type: 'module' }), { persist: params.get('persist') !== '0' });
}

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  startDevice();
  setCompactGutters(isPhone());
  const store = new Store(initialState());
  applyTheme(store.state.theme);
  installTips();
  const kernels = await loadKernels();
  const params = new URLSearchParams(location.search);
  const source = await chooseSource(params);
  const hub = new Hub(store, source);

  const toolbar = new Toolbar(store, source.venues);
  const main = document.createElement('main');
  const chart = document.createElement('div'); chart.className = 'chart-col';
  const side = document.createElement('div'); side.className = 'side-col';
  main.append(chart, side);
  const dock = new Dock(main);
  app.append(toolbar.root, main, dock.root);

  const heat = new HeatPane(chart, store, hub, kernels);
  const bars = new BarStatsPane(chart, store, heat.view, heat);
  const depth = new DepthPane(chart, store, heat.view, hub);
  const oi = new OiPane(chart, store, heat.view);
  const lt = new LtPane(chart, store, heat.view, hub);
  const ladder = new LadderPane(side, store, kernels);
  const arrange = new Layout(main, chart, side, [
    { id: 'heat', root: heat.root, min: 240 },
    { id: 'bars', root: bars.root, height: 84, min: 56, head: bars.header },
    { id: 'depth', root: depth.root, height: 132, min: 70, head: depth.header },
    { id: 'oi', root: oi.root, height: 150, min: 60, head: oi.header },
    { id: 'lt', root: lt.root, height: 128, min: 70, head: lt.header },
  ]);
  const lower = () => { depth.invalidate(); oi.invalidate(); lt.invalidate(); bars.invalidate(); };
  // A finger on a pane under the map moves the time axis it shares with the map.
  for (const pane of [depth, oi, lt, bars]) pane.useTimeGestures(heat.timeGestures());
  heat.onFrame = lower; heat.onView = lower;
  toolbar.onRecenter = () => { heat.fit(); ladder.recenter(); };
  toolbar.onSelectMarket = id => store.set({ marketId: id });
  toolbar.onVenuesApplied = () => { void hub.refreshMarkets(); window.setTimeout(() => void hub.refreshMarkets(), 15_000); };
  const sounds = new Sounds(store); toolbar.attachSounds(sounds); sounds.start();
  hub.onPrints = fresh => sounds.feed(fresh);
  hub.onPrintsChanged = () => heat.invalidate();
  // Hovering a theme shows it everywhere without saving it; leaving the menu puts the saved one back.
  toolbar.onPreviewTheme = id => { const name = id ?? store.state.theme; applyTheme(name); for (const p of [heat, ladder, depth, oi, lt, bars]) p.setPalette(name); toolbar.previewTheme(name); };
  heat.onStats = () => toolbar.sync(store.state, heat.window);

  // An address like #guide/mirror opens the guide there.
  const fromAddress = (): void => { if (/^#guide/.test(location.hash)) void import('./guide/guide.ts').then(m => m.openFromAddress()); };
  fromAddress(); window.addEventListener('hashchange', fromAddress);

  // S takes a screenshot (not while typing in a field or when a modifier is held).
  window.addEventListener('keydown', e => {
    if (e.key.toLowerCase() !== 's' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) || document.querySelector('dialog[open]')) return;
    e.preventDefault(); void import('./screenshot/editor.ts').then(m => m.startScreenshot());
  });

  // The profile column and axis are narrower on a phone; everything that aligns to them has to redraw when that changes.
  onLayoutMode(() => { setCompactGutters(isPhone()); layout(); heat.invalidate(); lower(); toolbar.sync(store.state, heat.window); });
  const layout = () => {
    const s = store.state;
    document.documentElement.style.setProperty('--gutter', `${gutter(s)}px`);
    depth.root.hidden = !s.show.depth; oi.root.hidden = !s.show.oi; lt.root.hidden = !s.show.lt; bars.root.hidden = !s.show.footprint;
    arrange.rebuild();
    dock.sync(s.show);
  };

  store.subscribe((state, changed) => {
    if (changed.has('theme')) { applyTheme(state.theme); for (const p of [heat, ladder, depth, oi, lt, bars]) p.setPalette(state.theme); }
    if (changed.has('show')) layout();
    if (changed.has('marketId') || changed.has('timeframe')) void hub.loadSeries(true).then(() => { heat.fit(); lower(); });
    if (changed.has('disabledVenues') || changed.has('heatmapSource') || changed.has('scope')) { heat.dataChanged(); depth.refresh(); lt.refresh(); }
    if (changed.has('highlight')) { heat.invalidate(); oi.invalidate(); depth.invalidate(); }
    if (changed.has('sounds')) heat.invalidate();
    if (changed.has('levels')) { ladder.invalidate(); ladder.syncVenues(); heat.invalidate(); }
    if (changed.has('layers') || changed.has('layer') || changed.has('candles') || changed.has('mark') || changed.has('heat') || changed.has('show')) heat.invalidate();
    if (changed.has('oi') || changed.has('show')) oi.invalidate();
    if (changed.has('lt') || changed.has('show')) lt.refresh();
    if (changed.has('barStatOptions') && !changed.has('barStats')) bars.refresh();
    if (changed.has('barStats')) { arrange.setPaneHeight('bars', 12 + Math.max(1, enabledStats(state.barStats).length) * 24); bars.refresh(); }
    if (changed.has('grouping') || changed.has('ladderMode') || changed.has('ladderShow') || changed.has('ladderVenue') || changed.has('ladderVenues') || changed.has('disabledVenues') || changed.has('scope')) { ladder.invalidate(); ladder.syncControls(); }
    if (changed.has('hover')) { heat.invalidate(); oi.invalidate(); depth.invalidate(); lt.invalidate(); bars.invalidate(); }
    if (['markets', 'marketId', 'timeframe', 'layer', 'show', 'heat', 'theme', 'status', 'connected', 'disabledVenues', 'heatmapSource', 'levels', 'scope', 'sounds', 'soundState', 'lastSound'].some(k => changed.has(k as never))) toolbar.sync(state, heat.window);
  });

  for (const p of [heat, ladder, depth, oi, lt, bars]) p.setPalette(store.state.theme);
  layout(); ladder.syncControls(); lt.refresh();
  arrange.setPaneHeight('bars', 12 + Math.max(1, enabledStats(store.state.barStats).length) * 24);
  toolbar.sync(store.state, heat.window);
  await hub.start();
  await hub.loadSeries(true);
  heat.fit(); lower();
  window.setInterval(() => { void hub.loadSeries(true); }, 60_000);
  // OI is sampled about once a minute on the server; asking more often than that keeps the newest bar from lagging by a whole refresh.
  window.setInterval(() => { void hub.loadOi(); }, 20_000);
  (window as unknown as { __hlm: unknown }).__hlm = { store, hub, heat, ladder, sounds };
}

main().catch(error => {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const hint = /api\/v2/.test(message) ? '\n\nThe server is running an older build without the v2 data plane. Restart it (npm run dev) and reload.'
    : /fetch|network/i.test(message) ? `\n\nNo answer from ${location.host}. Is the server running (npm run dev), and is this the port it listens on?`
    : / 403\b/.test(message) ? `\n\nThe server refused ${location.host}: it answers localhost and IP addresses only. Open it as http://localhost:${location.port || 80}, or list this name in HLM_ALLOWED_HOSTS.` : '';
  document.body.append(Object.assign(document.createElement('pre'), { className: 'fatal', textContent: `Failed to start: ${message}${hint}` }));
});
