import test from 'node:test';
import assert from 'node:assert/strict';
import { LiqLevelsSource, combineTaken, parseLiqGroups, parseLiqLevels, parseTriggers, sumLevels, takenByCandles, liqStanding, type LiqLevels } from '../src/app/liq-levels.ts';
import { DAY_MS, LIQ_HOLD_MS, LiqHistory, MAX_DAYS, bandOnEdge, dayText, familiesFor, readHistRows, readRollup, type LiqAnswer } from '../src/app/liq-history.ts';
import { readLiqLevels, plusUrls } from '../src/app/liq-url.ts';
import { FREE_VIEW, effectiveView, heldBack, isFreeChoice, viewKey, type LiqView } from '../src/app/liq-view.ts';
import { PRESET_BANDS } from '../src/app/depth-settings.ts';
import { changeOf, isPlusChange, liqMenuItems } from '../src/app/liq-menu.ts';
import { BTC } from '../src/shared/coins.ts';
import type { CandleRow } from '../src/app/store.ts';

const MIN = 60_000;
const AS_OF = Date.UTC(2026, 10, 15, 11, 25);
const LEVELS_URL = 'http://127.0.0.1:8791/v1/btc/liquidations.json';
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
const snap = (asOf = AS_OF): Record<string, number> => ({ asOf, createdAt: asOf + 35 * MIN, fetchedAt: asOf + 41 * MIN });

/** The free file (format 2). */
const free = (bins: number[][], asOf = AS_OF): Record<string, unknown> => ({ v: 2, coin: 'BTC', venue: 'hyperliquid', attribution: 'Powered by HyperTracker',
  snapshot: { id: 'x', ...snap(asOf), completedAt: asOf + 40 * MIN }, mark: 100, positions: 10, withLiquidation: 8, longSize: 1, shortSize: 1, step: 10, bins, beyond: { longUsd: 0, shortUsd: 0 } });
/** The groups file (format 1): bins shaped as the free file's. */
const groups = (profitable: number[][], proven: number[][] | null, asOf = AS_OF): Record<string, unknown> => ({ v: 1, coin: 'BTC', venue: 'hyperliquid', attribution: 'Powered by HyperTracker',
  snapshot: { id: 'x', ...snap(asOf), completedAt: asOf + 40 * MIN }, mark: 100, step: 10,
  groups: { profitable: { positions: 3, withLiquidation: 3, longSize: 1, shortSize: 1, bins: profitable, beyond: { longUsd: 0, shortUsd: 0 } },
    proven: proven === null ? null : { positions: 2, withLiquidation: 2, longSize: 1, shortSize: 1, bins: proven, beyond: { longUsd: 0, shortUsd: 0 }, night: '2026-11-14' } } });
/** The orders file (format 1): a bin [k, longWhole, longSized, shortWhole, shortSized, longOrders, shortOrders, longTop, shortTop], `long*` closing longs. */
const triggers = (stops: number[][], takes: number[][], asOf = AS_OF): Record<string, unknown> => ({ v: 1, coin: 'BTC', venue: 'hyperliquid', attribution: 'Powered by HyperTracker',
  snapshot: { ...snap(asOf), ordersAt: asOf }, mark: 100, markFrom: 'positions', step: 10, orders: 9, triggers: 8, entries: 0, unsized: { orders: 0, wallets: 0 },
  stops: { orders: 4, wallets: 4, bins: stops, beyond: { longUsd: 0, shortUsd: 0 }, cut: { longUsd: 0, shortUsd: 0 } },
  takes: { orders: 4, wallets: 4, bins: takes, beyond: { longUsd: 0, shortUsd: 0 }, cut: { longUsd: 0, shortUsd: 0 } } });

// A stop that closes a long below the mark ([80, 90)), one that closes a short above ([120, 130)); a take profit that closes a long above
// ([140, 150): a sell) and one that closes a short below ([60, 70): a buy).
const STOPS = [[8, 300, 100, 0, 0, 2, 0, 300, 0], [12, 0, 0, 50, 150, 0, 3, 0, 100]];
const TAKES = [[6, 0, 0, 0, 70, 0, 1, 0, 70], [14, 40, 20, 0, 0, 2, 0, 40, 0]];

test('the Plus files live beside the levels file, so a local stand-in answers for them too', () => {
  const u = plusUrls('https://levels.hiverust.dev/v1/btc/liquidations.json')!;
  assert.equal(u.groups, 'https://levels.hiverust.dev/v1/plus/btc/liquidations-groups.json');
  assert.equal(u.triggers, 'https://levels.hiverust.dev/v1/plus/btc/triggers.json');
  assert.equal(u.groupsDay('2026-11-15'), 'https://levels.hiverust.dev/v1/plus/btc/liquidation-history-groups/2026-11-15.json');
  assert.equal(u.triggersDay('2026-11-15'), 'https://levels.hiverust.dev/v1/plus/btc/trigger-history/2026-11-15.json');
  assert.deepEqual(u.rollup, { free: 'https://levels.hiverust.dev/v1/plus/btc/liquidation-history-4h.json', groups: 'https://levels.hiverust.dev/v1/plus/btc/liquidation-history-groups-4h.json', triggers: 'https://levels.hiverust.dev/v1/plus/btc/trigger-history-4h.json' });
  assert.equal(plusUrls(LEVELS_URL)!.triggers, 'http://127.0.0.1:8791/v1/plus/btc/triggers.json');
  assert.equal(plusUrls('http://localhost:8790/x.json'), null, 'not the levels file\'s shape: no Plus files');
});

test('the groups file is read field by field: each group as the levels file, the proven traders\' may be null, anything malformed refused whole', () => {
  const g = parseLiqGroups(groups([[8, 0, 120, 0, 0, 1, 0, 120, 0]], [[11, 0, 0, 0, 90, 0, 1, 0, 90]]), 'BTC')!;
  assert.ok(g);
  assert.equal(g.createdAt, AS_OF + 35 * MIN);
  assert.deepEqual([...g.profitable.k], [8]); assert.equal(g.profitable.longCross[0], 120); assert.equal(g.profitable.kind, 'liq');
  assert.deepEqual([...g.proven!.k], [11]); assert.equal(g.proven!.shortCross[0], 90);
  assert.equal(g.night, '2026-11-14');
  const none = parseLiqGroups(groups([[8, 0, 120, 0, 0, 1, 0, 120, 0]], null), 'BTC')!;
  assert.equal(none.proven, null, 'no proven list for the snapshot: null, never a guess');
  assert.equal(parseLiqGroups({ ...groups([], []), v: 2 }, 'BTC'), null, 'another format');
  assert.equal(parseLiqGroups(groups([[8, 0, 120, 0, 0, 1, 0, 999, 0]], []), 'BTC'), null, 'a largest position bigger than its side');
  assert.equal(parseLiqGroups(groups([[9, 0, 1, 0, 0, 1, 0, 1, 0], [8, 0, 1, 0, 0, 1, 0, 1, 0]], []), 'BTC'), null, 'bins out of order');
  assert.equal(parseLiqGroups({ ...groups([], []), groups: { profitable: null, proven: null } }, 'BTC'), null, 'no profitable group');
  assert.equal(parseLiqGroups({ ...groups([], []), coin: 'ETH' }, 'BTC'), null);
  assert.equal(parseLiqGroups({ ...groups([], []), snapshot: { asOf: AS_OF, createdAt: AS_OF - 1, fetchedAt: AS_OF } }, 'BTC'), null, 'times that disagree');
});

test('the orders file: stops keep their sides, take profits are swapped so the side below the mark holds the take profits of shorts', () => {
  const o = parseTriggers(triggers(STOPS, TAKES), 'BTC')!;
  assert.ok(o);
  // Stops: what closes longs (sells) below, in the long side; whole-position orders in the first part, sized ones in the second.
  assert.equal(o.stops.kind, 'stops');
  assert.deepEqual([...o.stops.k], [8, 12]);
  assert.equal(o.stops.longIso[0], 300); assert.equal(o.stops.longCross[0], 100); assert.equal(o.stops.longWallets[0], 2, 'orders counted');
  assert.equal(o.stops.shortIso[1], 50); assert.equal(o.stops.shortCross[1], 150);
  assert.equal(o.stops.positions, 4, 'the part\'s orders');
  // Take profits: the buy that closes a short at [60, 70), below the mark, is on the long side; the sell that closes a long at [140, 150) on the short side.
  assert.equal(o.takes.kind, 'takes');
  assert.equal(o.takes.longCross[0], 70); assert.equal(o.takes.longWallets[0], 1); assert.equal(o.takes.longTop[0], 70);
  assert.equal(o.takes.shortIso[1], 40); assert.equal(o.takes.shortCross[1], 20); assert.equal(o.takes.shortWallets[1], 2);
  assert.equal(o.takes.longIso[1]! + o.takes.longCross[1]!, 0, 'nothing below the mark at [140, 150)');
  assert.equal(parseTriggers({ ...triggers(STOPS, TAKES), takes: null }, 'BTC'), null, 'a kind missing');
  assert.equal(parseTriggers({ ...triggers([[8, 1, 1, 0, 0, 1, 0, 5, 0]], TAKES) }, 'BTC'), null, 'a largest order bigger than its side');
  assert.equal(parseTriggers({ ...triggers(STOPS, TAKES), v: 2 }, 'BTC'), null);
});

/** One-minute candles from `from`: [start, open, high, low, close, volume]. */
const candles = (from: number, path: [number, number][]): CandleRow[] => path.map(([h, l], i) => [Math.floor(from / MIN) * MIN + i * MIN, (h + l) / 2, h, l, (h + l) / 2, 1] as CandleRow);

test('take profits are taken where they trigger: the buys below the mark as the lows reach them, the sells above as the highs do', () => {
  const t = parseTriggers(triggers(STOPS, TAKES), 'BTC')!.takes;
  const taken = takenByCandles(t, candles(AS_OF, [[101, 99], [101, 65]]));
  assert.ok(Number.isFinite(taken.long.first[0]!), 'the take profit of a short at [60, 70) was reached as price fell to 65');
  assert.ok(Number.isNaN(taken.short.first[1]!), 'the one of a long at [140, 150) stands');
});

test('liquidations and stops added together: bin by bin, each part counted from its own snapshot', () => {
  const liq = parseLiqLevels(free([[8, 0, 200, 0, 0, 2, 0, 150, 0], [11, 0, 0, 0, 80, 0, 1, 0, 80]]), 'BTC')!;
  // The stops come from a snapshot an hour older.
  const stops = parseTriggers(triggers(STOPS, TAKES, AS_OF - 60 * MIN), 'BTC')!.stops;
  const sum = sumLevels(liq, stops), s = sum.levels;
  assert.equal(s.kind, 'both');
  assert.deepEqual([...s.k], [8, 11, 12], 'every bin of either');
  assert.equal(s.longIso[0], 200, 'the first part is the liquidations'); assert.equal(s.longCross[0], 400, 'the second the stops');
  assert.equal(s.longWallets[0], 4, 'positions and orders counted together'); assert.equal(s.longTop[0], 300, 'the larger of the two largest');
  assert.equal(s.shortIso[1], 80); assert.equal(s.shortCross[1], 0);
  assert.equal(s.shortIso[2], 0); assert.equal(s.shortCross[2], 200);
  assert.equal(s.asOf, liq.asOf, 'on the liquidations\' snapshot');
  assert.deepEqual([...sum.ia], [0, 1, -1]); assert.deepEqual([...sum.ib], [0, -1, 1]);
  // Price dipped to 85 between the two snapshots, then came back: the stops at [80, 90) were triggered on the way; the liquidation levels
  // there were measured after the dip and still stand.
  const bars = candles(AS_OF - 60 * MIN, [[101, 99], ...Array.from({ length: 20 }, (): [number, number] => [101, 99]), [101, 85], ...Array.from({ length: 60 }, (): [number, number] => [101, 99])]);
  const both = combineTaken(sum, takenByCandles(liq, bars), takenByCandles(stops, bars));
  assert.ok(Number.isFinite(both.long.first[0]!), 'reached');
  assert.ok(Number.isNaN(both.long.gone[0]!), 'not gone: the liquidations there stand');
  // [80, 90) was cut to 85 for the stops: half the bin's width, so half of the stops' 400; the liquidations' 200 stand whole.
  const standing = liqStanding(s, both);
  assert.ok(Math.abs((standing.long[1]! - standing.long[0]!) - (200 + 400 * 0.5)) < 1e-6, `${standing.long[1]! - standing.long[0]!}`);
});

test('one choice for the page: the free view without Plus, the choice kept; old saves read as the free view', () => {
  assert.deepEqual(readLiqLevels(undefined), { on: true, column: true, kind: 'liq', takes: false, group: 'all' });
  assert.deepEqual(readLiqLevels({ on: false, column: true }), { on: false, column: true, kind: 'liq', takes: false, group: 'all' }, 'a save from before the choice');
  assert.deepEqual(readLiqLevels({ kind: 'stops', takes: true, group: 'proven' }), { on: true, column: true, kind: 'stops', takes: true, group: 'proven' });
  assert.deepEqual(readLiqLevels({ kind: 'all', takes: 'yes', group: 'rich' }), { on: true, column: true, kind: 'liq', takes: false, group: 'all' }, 'anything else reads as the free view');
  const chosen = readLiqLevels({ kind: 'both', takes: true, group: 'proven' });
  assert.deepEqual(effectiveView(chosen, false), FREE_VIEW, 'no Plus: the free view is drawn');
  assert.deepEqual(effectiveView(chosen, true), { kind: 'both', takes: true, group: 'proven' });
  assert.deepEqual(effectiveView(readLiqLevels({ kind: 'stops', group: 'proven' }), true), { kind: 'stops', takes: false, group: 'all' }, 'stops have no groups');
  assert.ok(heldBack(chosen, false), 'a Plus choice without Plus is held back (the controls show it locked)');
  assert.ok(!heldBack(chosen, true));
  assert.ok(!heldBack(readLiqLevels({}), false), 'the free view is never held back');
  assert.ok(isFreeChoice(FREE_VIEW) && !isFreeChoice({ kind: 'liq', takes: true, group: 'all' }) && !isFreeChoice({ kind: 'liq', takes: false, group: 'profitable' }));
  assert.equal(viewKey({ kind: 'stops', takes: false, group: 'proven' }), viewKey({ kind: 'stops', takes: false, group: 'all' }), 'the group of stops counts for nothing');
});

/** A levels service as the page reads it: the free file by `get`, the Plus files by `read` (with the pass), every request noted. */
function service(files: Record<string, LiqAnswer | (() => LiqAnswer)>, pass: { value: string | null }, freeDoc: () => unknown = () => free([[8, 0, 100, 0, 0, 1, 0, 100, 0]])) {
  let now = AS_OF + 45 * MIN;
  const asked: { url: string; pass: string | null | undefined }[] = [], refused: string[] = [];
  const src = new LiqLevelsSource(
    async url => { if (url.includes('hyperliquid')) return []; asked.push({ url, pass: undefined }); return freeDoc(); },
    () => now, () => LEVELS_URL,
    async (url, p) => { asked.push({ url, pass: p }); const f = files[url]; if (!f) return { status: 404, body: null }; return typeof f === 'function' ? f() : f; },
    { pass: () => pass.value, refused: p => { refused.push(p); } });
  return { src, asked, refused, at: (t: number) => { now = t; }, now: () => now };
}
const U = plusUrls(LEVELS_URL)!;
const view = (v: Partial<LiqView>): LiqView => ({ ...FREE_VIEW, ...v });

test('the live Plus files are asked for with the pass after the free file, only while the view needs them, and nothing paid without a pass', async () => {
  const pass = { value: null as string | null };
  const s = service({ [U.groups]: { status: 200, body: groups([[7, 0, 50, 0, 0, 1, 0, 50, 0]], [[9, 0, 60, 0, 0, 1, 0, 60, 0]]) }, [U.triggers]: { status: 200, body: triggers(STOPS, TAKES) } }, pass);
  // Free view: the free file alone.
  s.src.ensure(BTC, () => {}); await tick(); s.src.ensure(BTC, () => {}); await tick();
  assert.deepEqual(s.asked.map(a => a.url), [LEVELS_URL]);
  // A Plus view without a pass (it cannot be the effective one, but the source asks nothing paid even so).
  s.src.ensure(BTC, () => {}, view({ group: 'proven' })); await tick();
  assert.deepEqual(s.asked.map(a => a.url), [LEVELS_URL], 'nothing paid without a pass');
  assert.equal(s.src.levels, null, 'and nothing of all traders drawn under a group\'s name');
  // With a pass: the groups file, with it.
  pass.value = 'v1.pass.sig';
  s.src.ensure(BTC, () => {}, view({ group: 'proven' })); await tick();
  assert.deepEqual(s.asked.slice(1), [{ url: U.groups, pass: 'v1.pass.sig' }]);
  assert.equal(s.src.state, 'ready');
  assert.deepEqual([...s.src.levels!.k], [9], 'the proven traders\' levels');
  s.src.ensure(BTC, () => {}, view({ group: 'profitable' })); await tick();
  assert.deepEqual([...s.src.levels!.k], [7], 'the profitable traders\', from the same file');
  assert.equal(s.asked.length, 2, 'not asked again for the same snapshot');
  // Stops: the orders file.
  s.src.ensure(BTC, () => {}, view({ kind: 'stops' })); await tick();
  assert.deepEqual(s.asked.slice(2), [{ url: U.triggers, pass: 'v1.pass.sig' }]);
  assert.equal(s.src.levels!.kind, 'stops');
  assert.equal(s.src.takes, null, 'take profits only when the view shows them');
  // Both, with take profits: the sum and the take-profit layer, from what is held.
  s.src.ensure(BTC, () => {}, view({ kind: 'both', takes: true })); await tick();
  assert.equal(s.asked.length, 3);
  assert.equal(s.src.levels!.kind, 'both');
  assert.deepEqual([...s.src.levels!.k], [8, 12]);
  assert.equal(s.src.levels!.longIso[0], 100); assert.equal(s.src.levels!.longCross[0], 400);
  assert.equal(s.src.takes!.kind, 'takes'); assert.equal(s.src.takesState, 'ready');
  assert.notEqual(s.src.key(), '', 'the key names the view');
  const k = s.src.key();
  s.src.ensure(BTC, () => {}, view({ kind: 'both', takes: true, group: 'proven' })); await tick();
  assert.notEqual(s.src.key(), k, 'another view, another key');
});

test('the gate\'s refusal drops the pass; a 503 waits its Retry-After; an older orders file is asked again a few times; a missing proven list is said', async () => {
  const pass = { value: 'v1.old.sig' as string | null };
  let groupsAnswer: LiqAnswer = { status: 403, body: { error: 'plus_required' } };
  let ordersAnswer: LiqAnswer = { status: 503, body: null, retryAfter: 300 };
  const s = service({ [U.groups]: () => groupsAnswer, [U.triggers]: () => ordersAnswer }, pass);
  const t0 = s.now();
  s.src.ensure(BTC, () => {}, view({ group: 'proven' })); await tick(); await tick();
  assert.deepEqual(s.refused, ['v1.old.sig'], 'the gate\'s own refusal: the pass is reported, by which one');
  assert.equal(s.src.state, 'unavailable');
  // Any other 403 is a failed read: nothing is blamed.
  groupsAnswer = { status: 403, body: { error: 'forbidden' } };
  s.at(t0 + 31_000); s.src.ensure(BTC, () => {}, view({ group: 'proven' })); await tick();
  assert.equal(s.refused.length, 1);
  // A proven list missing for the snapshot: said, not drawn as all traders.
  groupsAnswer = { status: 200, body: groups([[7, 0, 50, 0, 0, 1, 0, 50, 0]], null) };
  s.at(t0 + 62_000); s.src.ensure(BTC, () => {}, view({ group: 'proven' })); await tick();
  assert.equal(s.src.state, 'missing'); assert.equal(s.src.missing(), 'proven'); assert.equal(s.src.levels, null);
  // A 503: not asked again before its Retry-After (300 s).
  s.src.ensure(BTC, () => {}, view({ kind: 'stops' })); await tick();
  const ordersAsks = (): number => s.asked.filter(a => a.url === U.triggers).length;
  assert.equal(ordersAsks(), 1);
  assert.equal(s.src.state, 'missing'); assert.equal(s.src.missing(), 'orders');
  s.at(t0 + 62_000 + 200_000); s.src.ensure(BTC, () => {}, view({ kind: 'stops' })); await tick();
  assert.equal(ordersAsks(), 1, 'within its Retry-After');
  // Then an orders file of an older snapshot (no order file read for the newest yet): kept, said, and asked again a few times, not each frame.
  ordersAnswer = { status: 200, body: triggers(STOPS, TAKES, AS_OF - 3 * 3_600_000) };
  s.at(t0 + 62_000 + 301_000); s.src.ensure(BTC, () => {}, view({ kind: 'stops' })); await tick();
  assert.equal(ordersAsks(), 2);
  assert.equal(s.src.state, 'ready', 'stops are drawn however old');
  assert.ok(s.src.ordersOld(), 'and said to be old');
  for (let i = 1; i <= 6; i++) { s.at(t0 + 62_000 + 301_000 + i * 121_000); s.src.ensure(BTC, () => {}, view({ kind: 'stops' })); await tick(); }
  assert.equal(ordersAsks(), 4, 'three tries for the snapshot, then quiet until the free file brings a new one');
});

/** The service's 224 buckets (history.rs). */
const EDGES = [...Array.from({ length: 160 }, (_, i) => (i + 1) / 32), ...Array.from({ length: 64 }, (_, i) => 5 + (i + 1) * 5 / 16)];
const ROLLUP_EDGES = [0.125, 0.25, 0.3125, 0.5, 0.625, 1, 1.25, 2, 2.5, 5, 10, 20, 25];
const zeros = (n = EDGES.length): number[] => new Array(n).fill(0);
const part = (at: Record<number, [number, number]>, n = EDGES.length): unknown[] => { const l = zeros(n), s = zeros(n); for (const [i, [a, b]] of Object.entries(at)) { l[Number(i)] = a; s[Number(i)] = b; } return [0, 0, l, s]; };
/** A free day row, and a Plus day row (two parts), by the snapshot's fetch time; `createdAt` five minutes before it. */
const freeRow = (fetchedAt: number, at: Record<number, [number, number]>): unknown[] => { const p = part(at); return [fetchedAt - 2_400_000, fetchedAt - 300_000, fetchedAt, 100_000, 0, 0, p[2], p[3]]; };
const plusRow = (fetchedAt: number, a: unknown[] | null, b: unknown[] | null): unknown[] => [fetchedAt - 2_400_000, fetchedAt - 300_000, fetchedAt, 100_000, a, b];

test('history rows of every family are read field by field: a group may be null, a malformed part leaves its row out', () => {
  const rows = readHistRows({ rows: [plusRow(3, part({ 4: [10, 20] }), null), plusRow(1, part({}), [1, 2, [1], [2]]), plusRow(2, part({ 0: [1, 1] }), part({ 1: [5, 5] }))] }, EDGES.length, 'groups');
  assert.deepEqual(rows.map(r => r.fetchedAt), [2, 3], 'the malformed row out, the rest by fetch time');
  assert.equal(rows[1]!.parts[1], null, 'a group without a list');
  assert.equal(rows[1]!.parts[0]!.long[4], 10);
  const roll = readRollup({ hours: 4, edges: ROLLUP_EDGES, rows: [plusRow(5, part({ 9: [1, 2] }, 13), part({}, 13))] }, 'orders')!;
  assert.equal(roll.rows.length, 1); assert.equal(roll.hours, 4); assert.equal(roll.edges.length, 13);
  assert.equal(readRollup({ hours: 4, edges: [2, 1], rows: [] }, 'orders'), null);
  // Every preset band is a whole bucket of the rollups; a band between two of their edges is not.
  for (const bands of Object.values(PRESET_BANDS)) for (const r of bands) assert.ok(bandOnEdge(ROLLUP_EDGES, r) >= 0, `±${r * 100} %`);
  assert.equal(bandOnEdge(ROLLUP_EDGES, 0.004), -1, '±0.4 % reads no rollup bucket');
  assert.deepEqual(familiesFor(FREE_VIEW), ['free']);
  assert.deepEqual(familiesFor(view({ group: 'proven' })), ['groups']);
  assert.deepEqual(familiesFor(view({ kind: 'stops', group: 'proven' })), ['orders']);
  assert.deepEqual(familiesFor(view({ kind: 'both', takes: true })), ['free', 'orders']);
  assert.deepEqual(familiesFor(view({ takes: true, group: 'profitable' })), ['groups', 'orders']);
});

test('the history asks for each choice\'s files (with the pass for every Plus one, none without it), joins both by the snapshot, and reads the rollups for wide views', async () => {
  const day = Date.UTC(2026, 10, 15), now = day + 12 * 3_600_000, index = 'http://127.0.0.1:8791/v1/btc/liquidation-history.json';
  const t1 = day + 3_600_000, t2 = day + 3 * 3_600_000, t3 = day + 5 * 3_600_000;
  const files: Record<string, unknown> = {
    [index]: { edges: EDGES, first: day - 3 * DAY_MS, last: now - 600_000 },
    [`http://127.0.0.1:8791/v1/btc/liquidation-history/${dayText(day)}.json`]: { rows: [freeRow(t1, { 10: [100, 200] }), freeRow(t2, { 10: [300, 400] }), freeRow(t3, { 10: [500, 600] })] },
    [U.groupsDay(dayText(day))]: { rows: [plusRow(t1, part({ 10: [10, 20] }), null), plusRow(t2, part({ 10: [30, 40] }), part({ 10: [3, 4] }))] },
    // Orders for two of the three snapshots: closing longs (sells) at bucket 20, closing shorts (buys) at bucket 30.
    [U.triggersDay(dayText(day))]: { rows: [plusRow(t1, part({ 20: [7, 8] }), part({ 20: [50, 0], 30: [0, 60] })), plusRow(t3, part({ 20: [9, 9] }), part({}))] },
    [U.rollup.free]: { v: 1, coin: 'BTC', hours: 4, edges: ROLLUP_EDGES, rows: [freeRow(t2, {})].map(r => [...r.slice(0, 6), zeros(13).map((_, i) => i === 9 ? 1_000 : 0), zeros(13)]) },
    [U.rollup.triggers]: { v: 1, coin: 'BTC', hours: 4, edges: ROLLUP_EDGES, kinds: ['stops', 'takes'], rows: [plusRow(t2 + 30 * MIN, part({ 9: [11, 0] }, 13), part({}, 13))] },
  };
  const asked: { url: string; pass: string | null | undefined }[] = [];
  const access = { pass: null as string | null, refused: [] as string[] };
  const h = new LiqHistory((url, pass) => { asked.push({ url, pass }); return url in files ? Promise.resolve(files[url]) : Promise.reject(new Error('404')); },
    { freeFrom: () => day - 7 * DAY_MS, pass: () => access.pass, refused: p => { access.refused.push(p); } });
  const settle = async (): Promise<void> => { await tick(); await tick(); };
  // `liqLevelsUrl()` reads the page's address; in Node it is the configured one, so the stand-in's files are found by their paths.
  const path = (u: string): string => u.replace(/^https?:\/\/[^/]+/, '');
  const ask = async (v: LiqView, from = day, to = now): Promise<string[]> => { asked.length = 0; for (let i = 0; i < 3; i++) { h.ensure(from, to, now, () => {}, v); await settle(); } return asked.map(a => path(a.url)); };
  for (const [k, value] of Object.entries(files)) files[`https://levels.hiverust.dev${path(k)}`] = value;

  const freeOnly = await ask(FREE_VIEW);
  assert.ok(freeOnly.every(u => !u.includes('/plus/')), 'the free view asks nothing paid');
  // A Plus view without a pass: nothing paid is asked for.
  const noPass = await ask(view({ kind: 'both', takes: true, group: 'proven' }));
  assert.ok(noPass.every(u => !u.includes('/plus/')), `nothing paid without a pass: ${noPass.join(', ')}`);
  assert.deepEqual(h.rows(day, now, view({ kind: 'stops' })), [], 'and nothing drawn');
  access.pass = 'v1.member.sig'; h.accessChanged();
  // Proven traders: the groups days, each with the pass; a snapshot without a proven list has no row.
  const proven = await ask(view({ group: 'proven' }));
  assert.ok(proven.includes(path(U.groupsDay(dayText(day)))));
  assert.ok(asked.filter(a => a.url.includes('/plus/')).every(a => a.pass === 'v1.member.sig'), 'every Plus file with the pass');
  assert.deepEqual(h.rows(day, now, view({ group: 'proven' })).map(r => r.fetchedAt), [t2]);
  assert.equal(h.rows(day, now, view({ group: 'proven' }))[0]!.long[10], 3);
  assert.deepEqual(h.rows(day, now, view({ group: 'profitable' })).map(r => [r.fetchedAt, r.long[10]]), [[t1, 10], [t2, 30]]);
  // Stops: the orders days.
  await ask(view({ kind: 'stops' }));
  assert.deepEqual(h.rows(day, now, view({ kind: 'stops' })).map(r => [r.fetchedAt, r.long[20], r.short[20]]), [[t1, 7, 8], [t3, 9, 9]]);
  // Both: a row only where the snapshot has both parts, added bucket by bucket.
  await ask(view({ kind: 'both' }));
  const both = h.rows(day, now, view({ kind: 'both' }));
  assert.deepEqual(both.map(r => r.fetchedAt), [t1, t3], 'the snapshot without an order file has no row');
  assert.equal(both[0]!.long[10], 100); assert.equal(both[0]!.long[20], 107, 'liquidations and stops within the bucket, added up');
  assert.equal(both[0]!.short[20], 208);
  // Take profits: sides swapped, so the sells that close longs are above the mark (short) and the buys that close shorts below (long).
  const s = h.series(day, now, view({ takes: true }));
  assert.equal(s.takes!.length, 2);
  assert.equal(s.takes![0]!.short[20], 50, 'take profits of longs above the mark');
  assert.equal(s.takes![0]!.long[30], 60, 'take profits of shorts below it');
  assert.equal(s.takes![0]!.long[20], 0);
  assert.equal(s.holdMs, LIQ_HOLD_MS); assert.equal(s.wide, false);
  // A view wider than MAX_DAYS days with Plus: the rollups, a row per four hours standing four hours and a half.
  const wideFrom = now - (MAX_DAYS + 10) * DAY_MS;
  const wide = await ask(view({ kind: 'both' }), wideFrom, now);
  assert.deepEqual(wide.sort(), [path(U.rollup.free), path(U.rollup.triggers)].sort(), 'one file a family, no day files');
  const ws = h.series(wideFrom, now, view({ kind: 'both' }));
  assert.equal(ws.wide, true); assert.equal(ws.edges!.length, 13); assert.equal(ws.holdMs, 4 * 3_600_000 + LIQ_HOLD_MS);
  assert.equal(ws.rows.length, 1, 'joined within the four-hour block (two snapshots of one block)');
  assert.equal(ws.rows[0]!.long[9], 1_011);
  // Without a pass the same wide view reads days again (the newest MAX_DAYS of them), never a rollup.
  access.pass = null; h.accessChanged();
  const freeWide = await ask(FREE_VIEW, wideFrom, now);
  assert.ok(freeWide.every(u => !u.includes('/plus/')));
});

test('the menu shows the saved choice, tags every Plus choice (locked without Plus), and greys the traders while stops alone are shown', () => {
  const rows = (s: Parameters<typeof liqMenuItems>[0], member: boolean) => Object.fromEntries(liqMenuItems(s, member).map(i => [i.id, i]));
  const free = rows({ kind: 'both', takes: true, group: 'proven' }, false);
  assert.equal(free['kind:both']!.checked, true, 'the saved choice is ticked even without Plus');
  assert.equal(free['kind:both']!.tag, 'Plus'); assert.equal(free['kind:both']!.locked, true);
  assert.equal(free['kind:liq']!.tag, undefined, 'the free choices carry no tag');
  assert.equal(free['group:all']!.tag, undefined);
  assert.equal(free.takes!.checked, true); assert.equal(free.takes!.locked, true);
  assert.equal(free['group:proven']!.checked, true); assert.ok(!free['group:proven']!.disabled);
  assert.ok(free['h:show']!.heading && free['h:traders']!.heading, 'group headings are not choices');
  const member = rows({ kind: 'stops', takes: false, group: 'proven' }, true);
  assert.equal(member['kind:stops']!.locked, false, 'with Plus the tag has no lock');
  assert.ok(member['group:proven']!.disabled && member['group:all']!.disabled, 'stops have no groups: the traders are greyed');
  assert.ok(member['h:no-groups'], 'and a line says why');
  assert.ok(liqMenuItems({ kind: 'stops', takes: false, group: 'all' }, true).at(-1)!.action, 'the last line opens the Guide');
  assert.deepEqual(changeOf('kind:both', { takes: false }), { kind: 'both' });
  assert.deepEqual(changeOf('group:profitable', { takes: false }), { group: 'profitable' });
  assert.deepEqual(changeOf('takes', { takes: true }), { takes: false }, 'the switch flips');
  assert.equal(changeOf('h:show', { takes: false }), null);
  assert.equal(changeOf('kind:rich', { takes: false }), null);
  assert.ok(isPlusChange({ kind: 'stops' }) && isPlusChange({ group: 'proven' }) && isPlusChange({ takes: true }));
  assert.ok(!isPlusChange({ kind: 'liq' }) && !isPlusChange({ group: 'all' }) && !isPlusChange({ takes: false }), 'back towards the free view is never Plus');
});
