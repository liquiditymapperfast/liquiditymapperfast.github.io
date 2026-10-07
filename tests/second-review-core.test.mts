import test from 'node:test';
import assert from 'node:assert/strict';
import { BinancePerpConnector } from '../src/shared/venues.ts';
import { FootprintRecorder, type FootprintMinuteRow, type FootprintStore } from '../src/shared/footprint.ts';
import { PrintStream, type Print, type PrintStore } from '../src/shared/prints.ts';
import { aggregateOi, withLiveOi } from '../src/shared/series.ts';
import { LiveFeedManager, type LiveFeedSocket, type LiveFeedTransportOptions } from '../src/server/live-feeds.mts';
import { FlowSources } from '../src/server/v2/flow-sources.mts';

// What the second outside review found in the shared engine and the server, each as the smallest case that shows it.

const MIN = 60_000;
const T0 = Math.floor(Date.UTC(2026, 9, 6, 12, 0, 0) / MIN) * MIN;
/** Record fills and count each as a market order of one fill, as the order builder does for a venue that reports orders whole. */
const recordOrders = (recorder: FootprintRecorder, rows: { instrumentId: string; tradeId: string; side: 'buy' | 'sell'; price?: unknown; notionalUsd: number; sourceTimestamp: number }[]): void => {
  recorder.ingest(rows); recorder.countOrders(rows.map(r => ({ instrumentId: r.instrumentId, side: r.side, t: r.sourceTimestamp, usd: r.notionalUsd })));
};

// ---- 2: a snapshot that an ended Binance perpetual connection asked for ---------------------------------------------------------------------------------

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = ''; sent: unknown[] = []; closed = false;
  onopen: (() => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(payload: unknown): void { this.sent.push(payload); }
  close(): void { this.closed = true; }
}
type Answer = (body: unknown) => void;
async function withFakes(run: (net: { snapshots: Answer[]; sockets: FakeSocket[] }) => Promise<void> | void): Promise<void> {
  const realSocket = globalThis.WebSocket, realFetch = globalThis.fetch;
  FakeSocket.all = [];
  const snapshots: Answer[] = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = (() => new Promise(resolve => { snapshots.push(body => resolve({ ok: true, status: 200, json: async () => body } as Response)); })) as typeof fetch;
  try { await run({ snapshots, sockets: FakeSocket.all }); } finally { globalThis.WebSocket = realSocket; globalThis.fetch = realFetch; FakeSocket.all = []; }
}
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const snapshot = (id: number) => ({ lastUpdateId: id, bids: [['100', '1']], asks: [['101', '1']] });

test('Binance perpetual: a snapshot asked for by a connection that has ended is not the next connection\'s, and neither is its failure', async () => {
  await withFakes(async ({ snapshots, sockets }) => {
    const c = new BinancePerpConnector();
    c.start(); sockets[0]!.onopen?.();
    assert.equal(snapshots.length, 1, 'the first connection asks for its snapshot');
    c.stop(); c.start(); sockets[1]!.onopen?.();
    assert.equal(snapshots.length, 2, 'the second connection asks for its own, though the first is still in flight (one shared flag stopped it)');
    snapshots[0]!(snapshot(500));                                    // the old answer comes in first
    await settle();
    assert.equal(c.state, 'connecting', 'it is not the new connection\'s snapshot, so the connection is not live yet');
    snapshots[1]!(snapshot(900)); await settle();
    assert.equal(c.state, 'live'); assert.equal(c.failures, 0);
    c.stop();
  });
  await withFakes(async ({ snapshots, sockets }) => {
    const c = new BinancePerpConnector();
    c.start(); sockets[0]!.onopen?.();
    const old = snapshots[0]!;
    c.stop(); c.start(); sockets[1]!.onopen?.();
    old(null);                                                       // the old request fails (a body that is not a snapshot)
    await settle();
    assert.equal(c.failures, 0, 'the retired request\'s error is not this connection\'s');
    snapshots[1]!(snapshot(1)); await settle();
    assert.equal(c.state, 'live');
    c.stop();
  });
});

// ---- 7: a footprint row that waits in a queue ----------------------------------------------------------------------------------------------------------------

test('a footprint minute queued for writing keeps the statistics it had when it was queued, so a late trade cannot make them disagree with the rows', () => {
  let now = T0 + 10_000;
  const queued: FootprintMinuteRow[] = [];
  const store: FootprintStore = { load: () => [], save: rows => { queued.push(...rows); }, close: () => {} };   // the browser's store keeps the row until its delayed write
  const recorder = new FootprintRecorder(store, () => now);
  recordOrders(recorder, [{ instrumentId: 'x:BTC', tradeId: '1', side: 'buy', price: 85_000, notionalUsd: 100, sourceTimestamp: T0 + 5_000 }]);
  now = T0 + MIN + 1_000; recorder.flush();
  recordOrders(recorder, [{ instrumentId: 'x:BTC', tradeId: '2', side: 'buy', price: 85_000, notionalUsd: 25, sourceTimestamp: T0 + 30_000 }]);     // late, into the minute that was queued
  const row = queued[0]!;
  const rows = row.bins.reduce((sum, bin) => sum + bin[1] + bin[2], 0), stats = row.stats ? row.stats.buy.reduce((a, b) => a + b, 0) + row.stats.sell.reduce((a, b) => a + b, 0) : 0;
  assert.equal(rows, 100); assert.equal(stats, 100, `the rows hold ${rows} and the statistics ${stats} (and ${row.stats?.buyN} trades)`);
  assert.equal(row.stats?.buyN, 1);
});

// ---- 12: the watchdog's timer -----------------------------------------------------------------------------------------------------------------------------------

class QuietSocket implements LiveFeedSocket {
  spec: LiveFeedTransportOptions; closed = false;
  onMessage: ((raw: unknown) => void) | undefined; onClose: ((reason: unknown) => void) | undefined; onError: ((error: unknown) => void) | undefined;
  constructor(spec: LiveFeedTransportOptions) { this.spec = spec; }
  async open() { /* connects at once */ }
  send() { /* nothing to say */ }
  close() { this.closed = true; }
}

test('the watchdog has one timer, also after it has restarted a start that ran too long, and none once the manager is stopped', async () => {
  const timers = new Set<{ fn: () => void; ms: number }>();
  let clock = 0, open: () => void = () => {};
  const gate = new Promise<void>(resolve => { open = resolve; });
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: async spec => new QuietSocket(spec), restTransport: { request: async () => { await gate; return {}; } },
    oiPollMs: 0, reconnectBaseMs: 20, reconnectMaxMs: 60, transportIdleMs: 0, startWatchdogMs: 7_777, startTimeoutMs: 10, now: () => clock,
    schedule: (fn, ms) => { const timer = { fn: fn as () => void, ms }; timers.add(timer); return timer; }, cancel: timer => { timers.delete(timer as { fn: () => void; ms: number }); },
  });
  const watchdogs = (): { fn: () => void; ms: number }[] => [...timers].filter(timer => timer.ms === 7_777);
  const stuck = manager.start({ hlBookResolutions: [{}] }).catch(() => 'cancelled');            // the first start waits on its requests
  assert.equal(watchdogs().length, 1, 'armed with the first start');
  clock += 100;                                                                                  // it has run longer than it may
  const [due] = watchdogs()!; timers.delete(due!); due!.fn();                                    // the watchdog fires and restarts it
  assert.equal(watchdogs().length, 1, 'one watchdog timer, not the two a recovery used to leave');
  manager.stop();
  assert.equal(watchdogs().length, 0, 'and none left over after stop');
  open(); await stuck;
});

// ---- 13: open interest inside the last stored minute -------------------------------------------------------------------------------------------------

test('a live open-interest sample inside the last stored minute still moves that minute\'s bar', () => {
  const stored = [{ start: T0, open: 100, high: 100, low: 100, close: 100 }];                   // persistence stopped after the observation at second 10
  const live = [{ observationTimestamp: T0 + 10_000, base: 100 }, { observationTimestamp: T0 + 30_000, base: 200 }];
  const bars = aggregateOi(withLiveOi(stored, live), MIN);
  assert.deepEqual(bars.at(-1), [T0, 100, 200, 100, 200], 'close and high 200 (they stayed at 100)');
});

// ---- 14: the print history at the edge of what memory holds -------------------------------------------------------------------------------------

test('a large print that memory dropped is still in the storage query when it shares its millisecond with the oldest print memory kept', () => {
  const kept: Print[] = [];
  const store: PrintStore = {
    load: (_since, limit) => kept.slice(-limit),
    save: rows => { kept.push(...rows); kept.sort((a, b) => a.t - b.t); },
    query: (from, to, minUsd, limit) => kept.filter(p => p.t >= from && p.t < to && p.usd >= minUsd).slice(-limit),
    close: () => {},
  };
  const stream = new PrintStream(store, () => T0 + 3_600_000, 7 * 24 * 3_600_000);
  // 20,001 prints: the first two share a millisecond, so memory (the newest 20,000) keeps one of them and drops the other.
  stream.ingest(Array.from({ length: 20_001 }, (_, i) => ({ instrumentId: 'x:BTC', tradeId: String(i), side: 'buy', price: 85_000, notionalUsd: 200_000 + i, sourceTimestamp: T0 + Math.max(0, i - 1) })));
  stream.flush();
  const all = stream.query(T0 - 1, T0 + 100_000, 25_000, 100_000);
  assert.equal(all.length, 20_001, `every print is reachable (${all.length}): the dropped one sat on the boundary millisecond`);
});

// ---- 15: a flow source belongs to an instrument, not to a venue --------------------------------------------------------------------------------

test('trade sources are started for the instrument the server has depth for, not for a venue that happens to share its name', () => {
  const started: string[] = [];
  const connector = (id: string) => ({ instrumentId: id, onTrade: undefined as unknown, start: () => { started.push(id); }, stop: () => { started.splice(started.indexOf(id), 1); } });
  const venue = { id: 'bybit', name: 'Bybit', kind: 'perpetual', recommended: true, make: () => ({ book: connector('bybit:BTCUSDT'), feeds: [] as unknown[] }) };
  const sources = new FlowSources(() => {}, () => 0, [venue] as never);
  sources.sync(new Set(['bybit:ETHUSDT']));
  assert.deepEqual(started, [], 'the server has depth for ETHUSDT: BTC trades would be counted with it');
  sources.sync(new Set(['bybit:BTCUSDT']));
  assert.deepEqual(started, ['bybit:BTCUSDT']);
  sources.close();
});
