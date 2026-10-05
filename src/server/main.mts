import { publicOrderbookVenueCatalog, planPublicOrderbookSelection, PUBLIC_ORDERBOOK_DEFAULT_VENUES } from './public-orderbook-selection.mts';
import type { LiveFeedStartOptions } from './live-feeds.mts';
import type { RuntimeMarket } from '../domain/runtime-state.mts';
import path from 'node:path';
import { createLocalServer } from './http.mts';
import { createExchangeRestTransport } from './rest-transport.mts';
import { LiveFeedManager, configuredCandleInstrumentIds, createWsTransport } from './live-feeds.mts';
import { liveFeedConfiguration } from './live-feed-config.mts';
import { discoverPublicProducts } from './product-discovery.mts';
import { publicMarketFeedOptions, assertPublicMarketFeedSelection } from './public-market-selection.mts';
import { HyperTrackerClient } from '../adapters/hypertracker.mts';
import { hyperTrackerMode, MockHyperTrackerClient } from '../adapters/hypertracker-mock.mts';
import { createMockReferencePrice } from '../core/mock-provider-provenance.mts';
import { DEFAULT_BINANCE_OI_POLL_MS, DEFAULT_REFRESH_MS } from '../core/constants.mts';
import { normalizeHistoryPath, startupFailureRecord } from './startup-diagnostics.mts';
import { installV2, type V2Handle } from './v2/api.mts';
import { restoreFeedSelection, saveFeedSelection } from './feed-selection-store.mts';
import { ORDERBOOK_VENUE_MAX_SELECTED, orderbookVenueStatus } from '../core/orderbook-venue-controls.mts';

type ServerApp = ReturnType<typeof createLocalServer>;
function failureFields(error: unknown): Record<string, unknown> { return error != null && typeof error === 'object' ? error as Record<string, unknown> : {}; }

const live = process.env.ENABLE_LIVE_FEEDS === 'true';
const fixtureTickMs = live ? 0 : Number(process.env.FIXTURE_TICK_MS ?? 1500);
const liveFeedCoreConfig = { ...liveFeedConfiguration(),
  hlBookNsigFigs: process.env.HL_BOOK_NSIG_FIGS == null ? 3 : Number(process.env.HL_BOOK_NSIG_FIGS),
  hlBookMantissa: process.env.HL_BOOK_MANTISSA == null ? null : Number(process.env.HL_BOOK_MANTISSA),
};
const activeCandleInstrumentIds = live ? configuredCandleInstrumentIds(liveFeedCoreConfig) : [];

function seedProviderFixtureHistory(app: ServerApp) {
  if (live || process.env.HLM_SEED_PROVIDER_HISTORY !== 'true') return;
  const instrumentIds = ['hyperliquid:BTC-PERP', 'binance:BTCUSDT'];
  const asOf = Number(app.state?.asOf);
  if (!(asOf > 0) || !app.history?.recordLayer) return;
  const snapshots = 24;
  for (const instrumentId of instrumentIds) for (const [layer, levels] of Object.entries(app.state?.layers || {})) {
    if (!['liquidation', 'stopLoss', 'takeProfit'].includes(layer) || !Array.isArray(levels) || !levels.length) continue;
    for (let index = 0; index < snapshots; index += 1) {
      const sourceTimestamp = asOf - (snapshots - 1 - index) * 60_000;
      const scale = .7 + (index % 5) * .08;
      app.history.recordLayer({
        layer,
        instrumentId,
        revision: `fixture-${instrumentId}-${layer}-${sourceTimestamp}`,
        sourceTimestamp,
        receivedAt: sourceTimestamp + 1,
        validFrom: sourceTimestamp,
        validTo: sourceTimestamp + 60_000,
        observedIntervals: [{ start: sourceTimestamp, end: sourceTimestamp + 60_000 }],
        complete: true,
        coverage: 'provider-fixture',
        levels: levels.map((level) => ({ ...level, sourceTimestamp, notionalUsd: Number(level.notionalUsd || 0) * scale, amount: Number(level.amount || 0) * scale })),
      });
    }
  }
}
const configuredHistoryPath = process.env.HISTORY_DB || path.join(process.cwd(), 'data', 'runtime', 'history.sqlite');
const effectiveHistoryPath = normalizeHistoryPath(configuredHistoryPath);
if (process.env.HISTORY_DB) process.env.HISTORY_DB = effectiveHistoryPath;
const requestedTestFailureStage = String(process.env.HLM_TEST_FAIL_STAGE ?? '').trim();
const failAtRequestedTestStage = (stage: string) => {
  if (requestedTestFailureStage !== stage) return;
  const error = Object.assign(new Error(`requested startup test failure at ${stage}`), { code: 'HLM_TEST_FAILURE' });
  throw error;
};
async function cleanupStartup({ feeds: activeFeeds, app: activeApp }: { feeds: LiveFeedManager | null; app: ServerApp | null }) {
  const errors: { component: string; error: unknown }[] = [];
  publicDiscoveryAbort.abort('local runtime stopped');
  try { activeFeeds?.stop(); } catch (error) { errors.push({ component: 'feeds', error }); }
  try { await activeApp?.close(); } catch (error) { errors.push({ component: 'server', error }); }
  return errors;
}
const publicDiscoveryAbort = new AbortController();
let app: ServerApp | null = null;
let feeds: LiveFeedManager | null = null;
let v2: V2Handle | null = null;
let startupStage = 'history-initialization';
try {
  app = createLocalServer({
    fixtureTickMs,
    liveMode: live,
    activeCandleInstrumentIds,
    restoreState: true,
    persistFixture: !live,
    refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS ?? DEFAULT_REFRESH_MS),
    providerPaths: {
      liquidation: process.env.HYPERTRACKER_LIQUIDATION_PATH,
      orders: process.env.HYPERTRACKER_ORDERS_PATH,
      stopLoss: process.env.HYPERTRACKER_STOP_LOSS_PATH,
      takeProfit: process.env.HYPERTRACKER_TAKE_PROFIT_PATH,
    },
  });
  const runningApp = app;
  startupStage = 'provider-configuration';
  const providerMode = hyperTrackerMode(process.env.HYPERTRACKER_MODE, process.env.ENABLE_HYPERTRACKER);
  if (providerMode === 'mock') {
    runningApp.setProvider(new MockHyperTrackerClient({ referencePrice: createMockReferencePrice(() => runningApp.state) }));
    runningApp.state.statuses.hypertracker = { state: 'mock', source: 'hypertracker-mock', mock: true };
  }
  if (providerMode === 'live') {
    runningApp.setProvider(new HyperTrackerClient({
      token: process.env.HYPERTRACKER_API_KEY,
      baseUrl: process.env.HYPERTRACKER_BASE_URL,
      ledger: runningApp.quota,
      networkEnabled: true,
    }));
  }
  startupStage = 'feed-configuration';
  if (live) {
    const processMemory = runningApp.retainedProviders.processMemory;
    if (!processMemory) throw new Error('Live feeds require the initialized process-memory owner');
    feeds = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: ({ venue, channel, marketType, request }) => createWsTransport({ venue, channel, marketType, request, handshakeTimeoutMs: Math.max(1_000, Number(process.env.LIVE_REQUEST_TIMEOUT_MS ?? 12_000)) }),
    restTransport: createExchangeRestTransport({
      timeoutMs: Math.max(1_000, Number(process.env.LIVE_REQUEST_TIMEOUT_MS ?? 12_000)),
      reserveTransientMemory: (bytes, context) => processMemory.reserveTransient(bytes, context),
    }),
    reserveTransientMemory: (bytes, context) => processMemory.reserveTransient(bytes, context),
    oiPollMs: Number(process.env.OI_POLL_MS ?? DEFAULT_BINANCE_OI_POLL_MS),
    oiHistoryPeriod: process.env.OI_HISTORY_PERIOD ?? '5m',
    oiHistoryLimit: Number(process.env.OI_HISTORY_LIMIT ?? 500),
    candleInterval: process.env.CANDLE_INTERVAL ?? '1m',
    retainedAdmission: runningApp.admitRetainedMutation,
    onMessage: ({ venue, message, retainedMutation }) => runningApp.applyMessage(message, venue, { retainedMutation }),
    onTradeBatch: ({ venue, messages }) => runningApp.applyTradeBatch(messages, venue),
    onStatus: (status) => {
      // These manager events carry the full active selection as control data.
      // The feed manager already retains and measures its status map; keep only
      // the server's admitted active-key representation instead of copying the
      // potentially large selection into feedStatuses as well.
      if (runningApp.applyActiveBookSelectionStatus(status)) return;
      runningApp.applyLiveFeedStatus(status);
    },
    });
    runningApp.retainedProviders.feeds = feeds;
  }
  startupStage = 'fixture-seeding';
  seedProviderFixtureHistory(runningApp);
  startupStage = 'listen';
  const address = await runningApp.start();
  if (address === null || typeof address !== 'object' || typeof address.address !== 'string' || !Number.isInteger(address.port)) throw new Error('Local server did not return a valid TCP address');
  const memoryOnly = String(effectiveHistoryPath).trim() === ':memory:';
  v2 = installV2(runningApp, { dataDir: memoryOnly ? '' : path.dirname(path.resolve(String(effectiveHistoryPath))), persist: !memoryOnly });
  startupStage = 'feed-start';
  failAtRequestedTestStage('feed-start');
  if (feeds) await feeds.start(liveFeedCoreConfig);
  if (feeds) {
    const activeFeeds = feeds;
    let activeFeedOptions: LiveFeedStartOptions = liveFeedCoreConfig;
    const feedSelectionFile = live && !memoryOnly ? path.join(path.dirname(path.resolve(String(effectiveHistoryPath))), 'v2-feed-venues.json') : null;
    const selectOrderbooks = async (product: RuntimeMarket, venues: readonly string[]) => {
      const planned = planPublicOrderbookSelection(product, venues, activeFeedOptions);
      if (!planned.ok) throw new Error(planned.reason);
      if (planned.base !== String(activeFeedOptions.coin ?? 'BTC').toUpperCase())
        throw new Error('Use the market selector to change the reference asset');
      await activeFeeds.start({ ...planned.options, referenceBackfill: false }); activeFeedOptions = planned.options;
      if (typeof product.instrumentId === 'string') saveFeedSelection(feedSelectionFile, { instrumentId: product.instrumentId, venues: [...planned.venues] });
    };
    runningApp.setPublicMarketControls({
      discover: (selection, onRetention) => discoverPublicProducts({ ...selection, onRetention, signal: publicDiscoveryAbort.signal,
        request: (descriptor, context) => fetch(descriptor.url, { method: descriptor.method ?? 'GET', headers: descriptor.headers, body: descriptor.body,
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(1000, Number(process.env.LIVE_REQUEST_TIMEOUT_MS ?? 12000)))]) }) }),
      select: async product => {
        const options = publicMarketFeedOptions(product, activeFeedOptions);
        await activeFeeds.start({ ...options, referenceBackfill: true }); activeFeedOptions = options;
        assertPublicMarketFeedSelection(product, options, activeFeeds.specs.values());
      },
      orderbookCatalog: () => {
        const selectedVenues = activeFeedOptions.selectedOrderbookVenues
          ? [...activeFeedOptions.selectedOrderbookVenues]
          : [...new Set([...activeFeeds.specs.values()].filter(spec => spec.publicDepth || spec.channel === 'l2Book' || spec.channel === 'depth').map(spec => String(spec.venue)))];
        const statuses = activeFeeds.status();
        const degraded = v2?.degradedVenues();
        return { ok: true, maxSelected: ORDERBOOK_VENUE_MAX_SELECTED, selectedVenues, venues: publicOrderbookVenueCatalog().map(venue => {
          const depthStates = [...activeFeeds.specs].filter(([, spec]) => spec.venue === venue.id
            && (spec.publicDepth || spec.channel === 'l2Book' || spec.channel === 'depth'))
            .map(([id]) => statuses[id]?.state).filter((value): value is string => typeof value === 'string');
          // A degraded venue's reason is free text from the feed, so it is bounded here: an over-long one must not make the whole catalogue invalid.
          return { ...venue, status: orderbookVenueStatus({ selected: selectedVenues.includes(venue.id), depthStates, fallback: statuses[venue.id + '-depth']?.state, fault: degraded?.get(venue.id) }) };
        }) };
      },
      selectOrderbooks,
      retire: instrumentIds => {
        const removed = new Set(instrumentIds);
        if ([...activeFeeds.specs.values()].some(spec => typeof spec.instrumentId === 'string' && removed.has(spec.instrumentId))) {
          activeFeeds.stop(); runningApp.resetMarkContinuity('selected-product-no-longer-active');
        }
      },
    });
    // A restart keeps the venues chosen in the dialog; the first run selects the recommended venues (HLM_DEFAULT_VENUES=all selects every supported venue, =configured keeps the flag-configured set).
    if (feedSelectionFile) {
      const supported = publicOrderbookVenueCatalog().filter(venue => venue.supported).map(venue => venue.id);
      void restoreFeedSelection({ file: feedSelectionFile, markets: () => runningApp.state?.markets ?? [],
        select: async (instrumentId, venues) => {
          const market = (runningApp.state?.markets ?? []).find(candidate => candidate.instrumentId === instrumentId);
          if (!market) throw new Error('market ' + instrumentId + ' is not known yet');
          await selectOrderbooks(market, venues);
        },
        defaultVenues: process.env.HLM_DEFAULT_VENUES === 'configured' ? null : process.env.HLM_DEFAULT_VENUES === 'all' ? supported : [...PUBLIC_ORDERBOOK_DEFAULT_VENUES], log: message => console.error('venue selection: ' + message) })
        .then(outcome => { if (outcome !== 'skipped') console.log('venue selection ' + outcome); }, error => console.error('venue selection failed: ' + (error instanceof Error ? error.message : String(error))));
    }
  }
  startupStage = 'provider-polling';
  failAtRequestedTestStage('provider-polling');
  if (providerMode === 'mock') {
    for (const kind of ['liquidation', 'stopLoss', 'takeProfit']) await runningApp.refreshProvider(kind);
    const mockRefreshMs = Number(process.env.REFRESH_INTERVAL_MS ?? 15_000);
    runningApp.startProviderPolling(mockRefreshMs, 'liquidation', { initialDelayMs: Number(process.env.HYPERTRACKER_INITIAL_REFRESH_MS ?? mockRefreshMs) });
  }
  if (providerMode === 'live') runningApp.startProviderPolling(undefined, 'liquidation', { initialDelayMs: Number(process.env.HYPERTRACKER_INITIAL_REFRESH_MS ?? 0) });
  console.log(`LiquidityMapperFast local server listening at http://${address.address}:${address.port}${live ? ' (live feeds enabled)' : ' (fixture feeds)'}`);
  const shutdown = async () => {
    v2?.close();
    const cleanupErrors = await cleanupStartup({ feeds, app });
    for (const { component, error } of cleanupErrors) console.error(JSON.stringify({ event: 'shutdown-cleanup-failed', component, mode: live ? 'live' : 'fixture', message: failureFields(error).message ?? String(error), code: failureFields(error).code ?? null }));
    process.exit(cleanupErrors.length ? 1 : 0);
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  const testShutdownMs = Number(process.env.HLM_TEST_SHUTDOWN_AFTER_MS ?? 0);
  if (testShutdownMs > 0) setTimeout(shutdown, testShutdownMs);
} catch (error) {
  console.error(JSON.stringify(startupFailureRecord(error, { mode: live ? 'live' : 'fixture', historyPath: app?.history?.filePath ?? effectiveHistoryPath, stage: startupStage })));
  if (failureFields(error).code === 'EADDRINUSE') {
    const port = Number(process.env.PORT ?? 8787);
    console.error(`
Port ${port} is already in use, most likely by an earlier LiquidityMapperFast server.
`
      + `  Find it:  netstat -ano | findstr :${port}   (the last column is the PID; Get-CimInstance Win32_Process -Filter "ProcessId=<PID>" shows its command line)
`
      + `  Then stop it, or run this one elsewhere:  $env:PORT=8788; npm run dev
`);
  }
  const cleanupErrors = await cleanupStartup({ feeds, app });
  for (const { component, error: cleanupError } of cleanupErrors) console.error(JSON.stringify({ event: 'startup-cleanup-failed', component, mode: live ? 'live' : 'fixture', message: failureFields(cleanupError).message ?? String(cleanupError), code: failureFields(cleanupError).code ?? null }));
  process.exitCode = 1;
}
