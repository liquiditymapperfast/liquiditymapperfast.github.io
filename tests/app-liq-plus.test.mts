import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LiqLevelsSource, binsIn, dollarPriceOf, parseTriggerGroups, combineTaken, laneRows, liqCurves, liqProfile, liqRows, onTheWay, parseLiqGroups, parseLiqLevels, parseTriggers, partsBetween, partsOnTheWay, standingBelow, sumLevels, takenByCandles, liqStanding, type LaneRows, type LiqLevels, type LiqRow, type LiqStanding } from '../src/app/liq-levels.ts';
import { DAY_MS, LIQ_HOLD_MS, LiqHistory, MAX_DAYS, bandOnEdge, dayText, familiesFor, readHistRows, readRollup, retryAfterSeconds, webFetch, type LiqAnswer } from '../src/app/liq-history.ts';
import { readLiqLevels, plusUrls } from '../src/app/liq-url.ts';
import { FREE_VIEW, curveOf, effectiveSplit, effectiveView, heldBack, isFreeChoice, levelsDescription, levelsSummary, pairKey, splitPair, takesBeside, viewKey, type LiqView } from '../src/app/liq-view.ts';
import { PRESET_BANDS } from '../src/app/depth-settings.ts';
import { controlListeners, paidPart, popoverPlace, pressGroup, pressPart, shownChoice, trapStep } from '../src/app/levels-control.ts';
import { holdPanelControl, releaseLiqLevelPanel } from '../src/app/liq-panel.ts';
import { Store, initialState, readSettings } from '../src/app/store.ts';
import { carriedSettings } from '../src/app/layouts/layouts.ts';
import { columnNotes, liqNote, liqWhy, ordersAbsent, readFailed, splitAmounts, splitText, takesLeftOut } from '../src/app/liq-words.ts';
import { dollars, mirrorSplits, probeBoxLines, readingTexts, stripeBoxLines } from '../src/app/liq-box.ts';
import { usd } from '../src/app/format.ts';
import { DepthRangeSummary, depthHeldKey, type DepthPaneHeld } from '../src/app/range/depth-lines.ts';
import { LiqPane } from '../src/app/panes/liq-pane.ts';
import { plus } from '../src/app/plus/pass.ts';
import type { InfoLine } from '../src/app/infobox.ts';
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
  assert.deepEqual(u.rollup, { free: 'https://levels.hiverust.dev/v1/plus/btc/liquidation-history-4h.json', groups: 'https://levels.hiverust.dev/v1/plus/btc/liquidation-history-groups-4h.json', triggers: 'https://levels.hiverust.dev/v1/plus/btc/trigger-history-4h.json', triggersGroups: 'https://levels.hiverust.dev/v1/plus/btc/trigger-history-groups-4h.json' });
  assert.equal(plusUrls(LEVELS_URL)!.triggers, 'http://127.0.0.1:8791/v1/plus/btc/triggers.json');
  assert.equal(plusUrls('http://localhost:8790/x.json'), null, 'not the levels file\'s shape: no Plus files');
});

test('the groups file is read for the profitable traders alone: whatever else its groups hold is left unread, the profitable group checked field by field', () => {
  const g = parseLiqGroups(groups([[8, 0, 120, 0, 0, 1, 0, 120, 0]], [[11, 0, 0, 0, 90, 0, 1, 0, 90]]), 'BTC')!;
  assert.ok(g);
  assert.equal(g.createdAt, AS_OF + 35 * MIN);
  assert.deepEqual([...g.profitable.k], [8]); assert.equal(g.profitable.longCross[0], 120); assert.equal(g.profitable.kind, 'liq');
  const held = (x: object): string[] => Object.keys(x).filter(k => !['asOf', 'createdAt', 'fetchedAt'].includes(k)).sort();
  assert.deepEqual(held(g), ['mark', 'profitable', 'step'], 'a second group the server still sends is neither read nor kept');
  // As the server sends it now (a null second group), as it will (no such key), and with anything at all there: the same.
  const plain = groups([[8, 0, 120, 0, 0, 1, 0, 120, 0]], null);
  for (const body of [plain, { ...plain, groups: { profitable: (plain.groups as Record<string, unknown>).profitable } }, { ...plain, groups: { ...(plain.groups as Record<string, unknown>), proven: 'not a group', other: [1, 2] } }]) {
    const r = parseLiqGroups(body, 'BTC');
    assert.ok(r); assert.deepEqual([...r.profitable.k], [8]); assert.deepEqual(held(r), ['mark', 'profitable', 'step']);
  }
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
  assert.deepEqual(readLiqLevels(undefined), { on: true, column: true, liq: true, stops: false, takes: false, group: 'all', split: 'none' });
  assert.deepEqual(readLiqLevels({ on: false, column: true }), { on: false, column: true, liq: true, stops: false, takes: false, group: 'all', split: 'none' }, 'a save from before the choice');
  assert.deepEqual(readLiqLevels({ liq: false, stops: true, takes: true, group: 'profitable', split: 'none' }), { on: true, column: true, liq: false, stops: true, takes: true, group: 'profitable', split: 'none' });
  // A group the page no longer offers, saved before (in the settings or a layout): everyone's, never the profitable traders'.
  assert.deepEqual(readLiqLevels({ liq: true, stops: false, takes: true, group: 'proven' }), { on: true, column: true, liq: true, stops: false, takes: true, group: 'all', split: 'none' });
  assert.deepEqual(readLiqLevels({ liq: true, stops: true, group: 'Proven' }).group, 'all');
  assert.deepEqual(readLiqLevels({ kind: 'all', takes: 'yes', group: 'rich' }), { on: true, column: true, liq: true, stops: false, takes: false, group: 'all', split: 'none' }, 'anything else reads as the free view');
  const chosen = readLiqLevels({ liq: true, stops: true, takes: true, group: 'profitable' });
  assert.deepEqual(effectiveView(chosen, false), FREE_VIEW, 'no Plus: the free view is drawn');
  assert.deepEqual(effectiveView(chosen, true), { liq: true, stops: true, takes: true, group: 'profitable' });
  assert.deepEqual(effectiveView(readLiqLevels({ liq: false, stops: true, group: 'profitable' }), true), { liq: false, stops: true, takes: false, group: 'profitable' }, "the group is every kind's");
  assert.ok(heldBack(chosen, false), 'a Plus choice without Plus is held back (the controls show it locked)');
  assert.ok(!heldBack(chosen, true));
  assert.ok(!heldBack(readLiqLevels({}), false), 'the free view is never held back');
  assert.ok(isFreeChoice(FREE_VIEW) && !isFreeChoice({ liq: true, stops: false, takes: true, group: 'all' }) && !isFreeChoice({ liq: true, stops: false, takes: false, group: 'profitable' }));
  assert.notEqual(viewKey({ liq: false, stops: true, takes: false, group: 'profitable' }), viewKey({ liq: false, stops: true, takes: false, group: 'all' }), "the profitable traders' stops are another view");
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
  s.src.ensure(BTC, () => {}, view({ group: 'profitable' })); await tick();
  assert.deepEqual(s.asked.map(a => a.url), [LEVELS_URL], 'nothing paid without a pass');
  assert.equal(s.src.levels, null, 'and nothing of all traders drawn under a group\'s name');
  // With a pass: the groups file, with it.
  pass.value = 'v1.pass.sig';
  s.src.ensure(BTC, () => {}, view({ group: 'profitable' })); await tick();
  assert.deepEqual(s.asked.slice(1), [{ url: U.groups, pass: 'v1.pass.sig' }]);
  assert.equal(s.src.state, 'ready');
  assert.deepEqual([...s.src.levels!.k], [7], 'the profitable traders\' levels, the second group of the file left unread');
  s.src.ensure(BTC, () => {}, view({ group: 'profitable' })); await tick();
  assert.equal(s.asked.length, 2, 'not asked again for the same snapshot');
  // Stops: the orders file.
  s.src.ensure(BTC, () => {}, view({ liq: false, stops: true })); await tick();
  assert.deepEqual(s.asked.slice(2), [{ url: U.triggers, pass: 'v1.pass.sig' }]);
  assert.equal(s.src.levels!.kind, 'stops');
  assert.equal(s.src.takes, null, 'take profits only when the view shows them');
  // Both, with take profits: the sum and the take-profit layer, from what is held.
  s.src.ensure(BTC, () => {}, view({ liq: true, stops: true, takes: true })); await tick();
  assert.equal(s.asked.length, 3);
  assert.equal(s.src.levels!.kind, 'both');
  assert.deepEqual([...s.src.levels!.k], [8, 12]);
  assert.equal(s.src.levels!.longIso[0], 100); assert.equal(s.src.levels!.longCross[0], 400);
  assert.equal(s.src.takes!.kind, 'takes'); assert.equal(s.src.takesState, 'ready');
  assert.notEqual(s.src.key(), '', 'the key names the view');
  const k = s.src.key();
  s.src.ensure(BTC, () => {}, view({ liq: true, stops: true, takes: true, group: 'profitable' })); await tick();
  assert.notEqual(s.src.key(), k, 'another view, another key');
});

test('the gate\'s refusal drops the pass; a 503 waits its Retry-After; an older orders file is asked again a few times', async () => {
  const pass = { value: 'v1.old.sig' as string | null };
  let groupsAnswer: LiqAnswer = { status: 403, body: { error: 'plus_required' } };
  let ordersAnswer: LiqAnswer = { status: 503, body: null, retryAfter: 300 };
  const s = service({ [U.groups]: () => groupsAnswer, [U.triggers]: () => ordersAnswer }, pass);
  const t0 = s.now();
  s.src.ensure(BTC, () => {}, view({ group: 'profitable' })); await tick(); await tick();
  assert.deepEqual(s.refused, ['v1.old.sig'], 'the gate\'s own refusal: the pass is reported, by which one');
  assert.equal(s.src.state, 'unavailable');
  // Any other 403 is a failed read: nothing is blamed.
  groupsAnswer = { status: 403, body: { error: 'forbidden' } };
  s.at(t0 + 31_000); s.src.ensure(BTC, () => {}, view({ group: 'profitable' })); await tick();
  assert.equal(s.refused.length, 1);
  // Then a file whose second group is null, as the server sends it now: the profitable traders, drawn.
  groupsAnswer = { status: 200, body: groups([[7, 0, 50, 0, 0, 1, 0, 50, 0]], null) };
  s.at(t0 + 62_000); s.src.ensure(BTC, () => {}, view({ group: 'profitable' })); await tick();
  assert.equal(s.src.state, 'ready'); assert.deepEqual([...s.src.levels!.k], [7]);
  // A 503: not asked again before its Retry-After (300 s).
  s.src.ensure(BTC, () => {}, view({ liq: false, stops: true })); await tick();
  const ordersAsks = (): number => s.asked.filter(a => a.url === U.triggers).length;
  assert.equal(ordersAsks(), 1);
  assert.equal(s.src.state, 'missing'); assert.equal(s.src.missing(), 'orders');
  s.at(t0 + 62_000 + 200_000); s.src.ensure(BTC, () => {}, view({ liq: false, stops: true })); await tick();
  assert.equal(ordersAsks(), 1, 'within its Retry-After');
  // Then an orders file of an older snapshot (no order file read for the newest yet): kept, said, and asked again a few times, not each frame.
  ordersAnswer = { status: 200, body: triggers(STOPS, TAKES, AS_OF - 3 * 3_600_000) };
  s.at(t0 + 62_000 + 301_000); s.src.ensure(BTC, () => {}, view({ liq: false, stops: true })); await tick();
  assert.equal(ordersAsks(), 2);
  assert.equal(s.src.state, 'ready', 'stops are drawn however old');
  assert.ok(s.src.ordersOld(), 'and said to be old');
  for (let i = 1; i <= 6; i++) { s.at(t0 + 62_000 + 301_000 + i * 121_000); s.src.ensure(BTC, () => {}, view({ liq: false, stops: true })); await tick(); }
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

test('history rows of every family are read field by field; of the groups only the profitable traders\' part is read, and a malformed one leaves its row out', () => {
  const rows = readHistRows({ rows: [plusRow(3, part({ 4: [10, 20] }), null), plusRow(1, part({}), [1, 2, [1], [2]]), plusRow(2, part({ 0: [1, 1] }), part({ 1: [5, 5] })), plusRow(4, [1, 2, [1], [2]], part({}))] }, EDGES.length, 'groups');
  assert.deepEqual(rows.map(r => r.fetchedAt), [1, 2, 3], 'the row whose profitable part is malformed out; whatever follows that part is not read at all');
  assert.ok(rows.every(r => r.parts.length === 1), 'one part a row: nothing else kept');
  assert.equal(rows[2]!.parts[0]!.long[4], 10);
  // Rows of five, as the server will send them once it drops the null; and the part found by its name where the file names its groups.
  assert.equal(readHistRows({ rows: [plusRow(5, part({ 2: [3, 3] }), null).slice(0, 5)] }, EDGES.length, 'groups')[0]!.parts[0]!.long[2], 3);
  const named = readHistRows({ groups: ['proven', 'profitable'], rows: [plusRow(6, part({ 1: [9, 9] }), part({ 2: [7, 7] }))] }, EDGES.length, 'groups');
  assert.equal(named[0]!.parts[0]!.long[2], 7, 'at the place the names give the profitable traders');
  assert.deepEqual(readHistRows({ groups: ['profitable', 'proven'], rows: [plusRow(7, part({ 3: [4, 4] }), null).slice(0, 5)] }, EDGES.length, 'groups').map(r => r.parts[0]!.long[3]), [4]);
  assert.deepEqual(readHistRows({ groups: ['other'], rows: [plusRow(8, part({}), part({}))] }, EDGES.length, 'groups'), [], 'names without the profitable traders: no rows, never another group\'s');
  const roll = readRollup({ hours: 4, edges: ROLLUP_EDGES, rows: [plusRow(5, part({ 9: [1, 2] }, 13), part({}, 13))] }, 'orders')!;
  assert.equal(roll.rows.length, 1); assert.equal(roll.hours, 4); assert.equal(roll.edges.length, 13);
  assert.equal(readRollup({ hours: 4, edges: [2, 1], rows: [] }, 'orders'), null);
  // Every preset band is a whole bucket of the rollups; a band between two of their edges is not.
  for (const bands of Object.values(PRESET_BANDS)) for (const r of bands) assert.ok(bandOnEdge(ROLLUP_EDGES, r) >= 0, `±${r * 100} %`);
  assert.equal(bandOnEdge(ROLLUP_EDGES, 0.004), -1, '±0.4 % reads no rollup bucket');
  assert.deepEqual(familiesFor(FREE_VIEW), ['free']);
  assert.deepEqual(familiesFor(view({ group: 'profitable' })), ['groups']);
  assert.deepEqual(familiesFor(view({ liq: false, stops: true, group: 'profitable' })), ['orderGroups'], "the profitable traders' own orders");
  assert.deepEqual(familiesFor(view({ liq: true, stops: true, takes: true })), ['free', 'orders']);
  assert.deepEqual(familiesFor(view({ takes: true, group: 'profitable' })), ['groups', 'orderGroups']);
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
  const noPass = await ask(view({ liq: true, stops: true, takes: true, group: 'profitable' }));
  assert.ok(noPass.every(u => !u.includes('/plus/')), `nothing paid without a pass: ${noPass.join(', ')}`);
  assert.deepEqual(h.rows(day, now, view({ liq: false, stops: true })), [], 'and nothing drawn');
  access.pass = 'v1.member.sig'; h.accessChanged();
  // The profitable traders: the groups days, each with the pass; their part of each row, whatever else the row holds.
  const profitable = await ask(view({ group: 'profitable' }));
  assert.ok(profitable.includes(path(U.groupsDay(dayText(day)))));
  assert.ok(asked.filter(a => a.url.includes('/plus/')).every(a => a.pass === 'v1.member.sig'), 'every Plus file with the pass');
  assert.deepEqual(h.rows(day, now, view({ group: 'profitable' })).map(r => [r.fetchedAt, r.long[10]]), [[t1, 10], [t2, 30]]);
  // Stops: the orders days.
  await ask(view({ liq: false, stops: true }));
  assert.deepEqual(h.rows(day, now, view({ liq: false, stops: true })).map(r => [r.fetchedAt, r.long[20], r.short[20]]), [[t1, 7, 8], [t3, 9, 9]]);
  // Both: a row only where the snapshot has both parts, added bucket by bucket.
  await ask(view({ liq: true, stops: true }));
  const both = h.rows(day, now, view({ liq: true, stops: true }));
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
  const wide = await ask(view({ liq: true, stops: true }), wideFrom, now);
  assert.deepEqual(wide.sort(), [path(U.rollup.free), path(U.rollup.triggers)].sort(), 'one file a family, no day files');
  const ws = h.series(wideFrom, now, view({ liq: true, stops: true }));
  assert.equal(ws.wide, true); assert.equal(ws.edges!.length, 13); assert.equal(ws.holdMs, 4 * 3_600_000 + LIQ_HOLD_MS);
  assert.equal(ws.rows.length, 1, 'joined within the four-hour block (two snapshots of one block)');
  assert.equal(ws.rows[0]!.long[9], 1_011);
  // Without a pass the same wide view reads days again (the newest MAX_DAYS of them), never a rollup.
  access.pass = null; h.accessChanged();
  const freeWide = await ask(FREE_VIEW, wideFrom, now);
  assert.ok(freeWide.every(u => !u.includes('/plus/')));
});

test('the levels control: three switches with one always on, Traders only with liquidations, and without Plus the paid choices open Plus and change nothing', () => {
  const both = { liq: true, stops: true, takes: false, group: 'all' } as const;
  assert.deepEqual(pressPart(both, 'takes', true), { change: { takes: true } });
  assert.deepEqual(pressPart(both, 'liq', true), { change: { liq: false } }, 'the stops stay on');
  assert.equal(pressPart({ liq: false, stops: true, takes: false, group: 'all' }, 'stops', true), 'last', 'the last kind on cannot be switched off');
  assert.equal(pressPart({ liq: false, stops: false, takes: true, group: 'all' }, 'takes', true), 'last');
  assert.deepEqual(pressPart({ liq: false, stops: false, takes: true, group: 'all' }, 'liq', true), { change: { liq: true } });
  // Without Plus: stops, take profits and the profitable traders open Plus and change nothing; liquidations and everyone stay usable.
  for (const part of ['stops', 'takes'] as const) assert.equal(pressPart(both, part, false), 'plus', part);
  assert.equal(pressGroup(both, 'profitable', false), 'plus');
  assert.equal(pressPart(both, 'liq', false), 'last', 'the free view is liquidations alone: its switch is the one on');
  assert.deepEqual(pressGroup({ liq: false, stops: true, takes: false, group: 'profitable' }, 'all', false), { change: { group: 'all' } }, 'everyone stays usable');
  assert.deepEqual(shownChoice({ liq: false, stops: true, takes: true, group: 'profitable' }, false), FREE_VIEW, 'without Plus it shows what is drawn');
  assert.deepEqual(shownChoice({ liq: false, stops: true, takes: true, group: 'profitable' }, true), { liq: false, stops: true, takes: true, group: 'profitable' });
  // The group is every kind's: the profitable traders' stops and take profits have files of their own.
  assert.deepEqual(pressGroup({ liq: false, stops: true, takes: true, group: 'all' }, 'profitable', true), { change: { group: 'profitable' } });
  assert.deepEqual(pressGroup(both, 'profitable', true), { change: { group: 'profitable' } });
  assert.ok(paidPart('stops') && paidPart('takes') && !paidPart('liq'));
  // The live line and the full description say what the curve sums, the take-profit bars beside it, whose.
  assert.equal(levelsSummary({ liq: true, stops: true, takes: true, group: 'profitable' }), 'Curve: Liq + stops · TP bars · Profitable');
  assert.equal(levelsSummary({ liq: false, stops: false, takes: true, group: 'all' }), 'Curve: Take profits');
  assert.equal(levelsSummary({ liq: false, stops: true, takes: true, group: 'all' }), 'Curve: Stops · TP bars');
  assert.equal(levelsSummary(FREE_VIEW), 'Curve: Liquidations');
  assert.equal(levelsDescription({ liq: true, stops: true, takes: true, group: 'profitable' }), 'Curve: Liquidation and stop levels. Take-profit bars shown. Traders: Profitable.');
  assert.equal(levelsDescription({ liq: false, stops: false, takes: true, group: 'all' }), 'Curve: Take-profit levels. Traders: Everyone.');
});

test('a saved choice in an older form reads as the three switches; anything else, a save from before the choice too, as the free view; every way back goes through the reader', () => {
  const on = { on: true, column: true }, freeView = { ...on, liq: true, stops: false, takes: false, group: 'all', split: 'none' };
  assert.deepEqual(readLiqLevels({ kind: 'liq', takes: true, group: 'profitable', split: 'none' }), { ...on, liq: true, stops: false, takes: true, group: 'profitable', split: 'none' });
  assert.deepEqual(readLiqLevels({ kind: 'stops', takes: false, group: 'all', split: 'none' }), { ...on, liq: false, stops: true, takes: false, group: 'all', split: 'none' });
  assert.deepEqual(readLiqLevels({ kind: 'both', takes: true, group: 'all', on: false }), { on: false, column: true, liq: true, stops: true, takes: true, group: 'all', split: 'none' });
  assert.deepEqual(readLiqLevels({ kind: 'everything', takes: true, group: 'profitable' }), freeView, 'an unknown kind: the free view');
  assert.deepEqual(readLiqLevels({ liq: false, stops: false, takes: false, group: 'profitable' }), freeView, 'none on: the free view');
  assert.deepEqual(readLiqLevels({ liq: 'yes', stops: 1 }), freeView);
  assert.deepEqual(readLiqLevels('garbage'), freeView);
  assert.deepEqual(readLiqLevels({ liq: false, stops: false, takes: true }), { ...on, liq: false, stops: false, takes: true, group: 'all', split: 'none' }, 'take profits alone are a choice');
  // A saved page, a saved layout or a layouts file (readSettings), and a backup or the old address's hand-over (they write the save, then the page reads it).
  assert.deepEqual(readSettings({ liqLevels: { kind: 'both', takes: true } }).liqLevels, { ...on, liq: true, stops: true, takes: true, group: 'all', split: 'none' });
  assert.deepEqual(carriedSettings({ liqLevels: { kind: 'stops' } } as never).liqLevels, { ...on, liq: false, stops: true, takes: false, group: 'all', split: 'none' });
  assert.deepEqual(readSettings({ liqLevels: { liq: false, stops: false, takes: false } }).liqLevels, freeView);
});

test('the seven combinations: the curve sums the liquidations and stops that are on, take profits are bars beside them, or alone a curve of their own', async () => {
  const pass = { value: 'v1.pass.sig' as string | null };
  const s = service({ [U.groups]: { status: 200, body: groups([[7, 0, 50, 0, 0, 1, 0, 50, 0]], null) }, [U.triggers]: { status: 200, body: triggers(STOPS, TAKES) } }, pass);
  const all = view({ liq: true, stops: true, takes: true });
  s.src.ensure(BTC, () => {}, all); await tick(); s.src.ensure(BTC, () => {}, all); await tick();
  const cases: [Partial<LiqView>, string, boolean][] = [
    [{ liq: true, stops: false, takes: false }, 'liq', false], [{ liq: false, stops: true, takes: false }, 'stops', false], [{ liq: false, stops: false, takes: true }, 'takes', false],
    [{ liq: true, stops: true, takes: false }, 'both', false], [{ liq: true, stops: false, takes: true }, 'liq', true], [{ liq: false, stops: true, takes: true }, 'stops', true],
    [{ liq: true, stops: true, takes: true }, 'both', true],
  ];
  for (const [v, curve, beside] of cases) {
    const vw = view(v), name = JSON.stringify(v);
    assert.equal(curveOf(vw), curve, name); assert.equal(takesBeside(vw), beside, name);
    s.src.ensure(BTC, () => {}, vw); await tick();
    assert.equal(s.src.state, 'ready', name);
    assert.equal(s.src.levels!.kind, curve, `the curve sums what is on: ${name}`);
    assert.equal(s.src.takes?.kind ?? null, beside ? 'takes' : null, `take profits beside the curve only with liquidations or stops: ${name}`);
    assert.deepEqual(familiesFor(vw), [...(vw.liq ? ['free'] : []), ...(vw.stops || vw.takes ? ['orders'] : [])], name);
  }
  // Take profits alone: the order file's take profits, sides swapped (those of shorts are buys below the mark, on the long side).
  s.src.ensure(BTC, () => {}, view({ liq: false, stops: false, takes: true })); await tick();
  assert.deepEqual([...s.src.levels!.k], [6, 14]);
  assert.equal(s.src.levels!.longCross[0], 70, 'bin 6 below the mark: the take profit of a short (a buy), on the long side');
  assert.ok(s.src.standing(), 'their curve stands like any other');
  assert.equal(s.src.takesState, 'off', 'nothing beside them');
});

/** A triggers-groups.json body: triggers.json's two parts inside groups.profitable. */
const triggerGroups = (stops: number[][], takes: number[][]): Record<string, unknown> => {
  const b = triggers(stops, takes) as Record<string, unknown>;
  return { ...b, stops: undefined, takes: undefined, markFrom: 'orders', groups: { profitable: { unsized: 0, stops: b.stops, takes: b.takes } } };
};

test('the profitable traders\' stops and take profits come from their own file, never everyone\'s under their name', async () => {
  const pass = { value: 'v1.pass.sig' as string | null };
  const MINE_STOPS = [[9, 40, 0, 0, 0, 1, 0, 40, 0]];
  const s = service({ [U.groups]: { status: 200, body: groups([[7, 0, 50, 0, 0, 1, 0, 50, 0]], null) }, [U.triggers]: { status: 200, body: triggers(STOPS, TAKES) }, [U.triggersGroups]: { status: 200, body: triggerGroups(MINE_STOPS, TAKES) } }, pass);
  const mine = view({ liq: false, stops: true, group: 'profitable' });
  s.src.ensure(BTC, () => {}, mine); await tick(); s.src.ensure(BTC, () => {}, mine); await tick();
  const urls = s.asked.map(a => a.url);
  assert.ok(urls.includes(U.triggersGroups), 'their own file, with the pass');
  assert.ok(!urls.includes(U.triggers), 'everyone\'s orders are not even asked for');
  assert.equal(s.src.state, 'ready');
  assert.deepEqual([...s.src.levels!.k], [9], 'their stops alone');
  // Liq + stops: their liquidations and their stops added up; take profits beside them are theirs too.
  s.src.ensure(BTC, () => {}, view({ liq: true, stops: true, takes: true, group: 'profitable' })); await tick();
  assert.deepEqual([...s.src.levels!.k], [7, 9]);
  assert.equal(s.src.takes!.kind, 'takes'); assert.ok(!s.src.ordersAbsent());
  assert.equal(parseTriggerGroups({ ...triggerGroups(MINE_STOPS, TAKES), groups: { profitable: { stops: null, takes: null } } }, 'BTC'), null, 'a malformed group is refused whole');
  assert.equal(parseTriggerGroups({ ...triggerGroups(MINE_STOPS, TAKES), groups: [] }, 'BTC'), null);
  assert.equal(parseTriggerGroups(triggers(STOPS, TAKES), 'BTC'), null, 'everyone\'s file is not theirs');
});

test('where the server has no profitable orders (404 or 503) they are not available yet: nothing drawn for them, and said in the column, its reading and the box', async () => {
  for (const answer of [{ status: 404, body: null }, { status: 503, body: null, retryAfter: 300 }] as LiqAnswer[]) {
    const pass = { value: 'v1.pass.sig' as string | null };
    const s = service({ [U.groups]: { status: 200, body: groups([[7, 0, 50, 0, 0, 1, 0, 50, 0]], null) }, [U.triggers]: { status: 200, body: triggers(STOPS, TAKES) }, [U.triggersGroups]: answer }, pass);
    const stopsOnly = view({ liq: false, stops: true, group: 'profitable' });
    s.src.ensure(BTC, () => {}, stopsOnly); await tick(); s.src.ensure(BTC, () => {}, stopsOnly); await tick();
    assert.equal(s.src.state, 'missing', String(answer.status)); assert.equal(s.src.missing(), 'profitable-orders');
    assert.equal(s.src.levels, null, 'nothing drawn for them');
    assert.equal(liqWhy(s.src, null), ordersAbsent());
    assert.ok(!s.asked.some(a => a.url === U.triggers), 'and never everyone\'s in their place');
    // Liq + stops + take profits: their liquidations alone are drawn, the rest is said, nothing borrowed.
    const all = view({ liq: true, stops: true, takes: true, group: 'profitable' });
    s.src.ensure(BTC, () => {}, all); await tick();
    assert.equal(s.src.state, 'ready'); assert.equal(s.src.levels!.kind, 'liq'); assert.deepEqual([...s.src.levels!.k], [7]);
    assert.ok(s.src.ordersAbsent()); assert.equal(s.src.takes, null); assert.equal(s.src.takesState, 'missing');
    assert.ok(liqNote(s.src, all, AS_OF).includes(ordersAbsent()), 'the note under the legend says it');
    assert.deepEqual(columnNotes(all, true, false, s.src.ordersAbsent()), [ordersAbsent()], 'and the column under its button');
    // Everyone's view is untouched by it.
    s.src.ensure(BTC, () => {}, view({ liq: true, stops: true })); await tick();
    assert.equal(s.src.levels!.kind, 'both'); assert.ok(!s.src.ordersAbsent());
  }
});

test('the history reads take profits alone from the orders, and the profitable traders\' orders from their own days (said as not available where the server has none)', async () => {
  const day = Date.UTC(2026, 10, 15), now = day + 12 * 3_600_000, index = 'https://levels.hiverust.dev/v1/btc/liquidation-history.json';
  const t1 = day + 3_600_000, t3 = day + 5 * 3_600_000;
  const files: Record<string, unknown> = {
    [index]: { edges: EDGES, first: day - 3 * DAY_MS, last: now - 600_000 },
    [U.triggersDay(dayText(day))]: { rows: [plusRow(t1, part({ 20: [7, 8] }), part({ 20: [50, 0], 30: [0, 60] })), plusRow(t3, part({ 20: [9, 9] }), part({}))] },
  };
  const host = (u: string): string => u.replace(/^https?:\/\/[^/]+/, 'https://levels.hiverust.dev');
  for (const [k, value] of Object.entries(files)) files[host(k)] = value;
  const h = new LiqHistory(url => url in files ? Promise.resolve(files[url]) : Promise.reject(new Error('404')), { freeFrom: () => day - 7 * DAY_MS, pass: () => 'v1.member.sig', refused: () => {} });
  const ask = async (v: LiqView): Promise<void> => { for (let i = 0; i < 3; i++) { h.ensure(day, now, now, () => {}, v); await tick(); await tick(); } };
  // Take profits alone: a row for each snapshot of the order file, sides swapped (the sells that close longs above the mark).
  const alone = view({ liq: false, takes: true });
  assert.deepEqual(familiesFor(alone), ['orders']);
  await ask(alone);
  const s = h.series(day, now, alone);
  assert.deepEqual(s.rows.map(r => r.fetchedAt), [t1, t3], 'take profits alone have their own rows');
  assert.equal(s.rows[0]!.short[20], 50); assert.equal(s.rows[0]!.long[30], 60);
  assert.equal(s.takes, null, 'and no overlay beside them');
  // The profitable traders' stops: their own days; none on the server: not available, and nothing of everyone's.
  const mine = view({ liq: false, stops: true, group: 'profitable' });
  assert.deepEqual(familiesFor(mine), ['orderGroups']);
  await ask(mine);
  assert.deepEqual(h.rows(day, now, mine), [], 'nothing drawn from everyone\'s orders');
  assert.ok(h.ordersAbsent(mine, day, now), 'said as not available yet');
  assert.ok(!h.ordersAbsent(view({ liq: false, stops: true }), day, now), 'everyone\'s view is not');
  // Once the server has their days, those rows are read.
  files[host(U.triggersGroupsDay(dayText(day)))] = { v: 1, coin: 'BTC', day: dayText(day), groups: ['profitable'], kinds: ['stops', 'takes'], rows: [plusRow(t3, part({ 20: [2, 3] }), part({}))] };
  const fresh = new LiqHistory(url => url in files ? Promise.resolve(files[url]) : Promise.reject(new Error('404')), { freeFrom: () => day - 7 * DAY_MS, pass: () => 'v1.member.sig', refused: () => {} });
  for (let i = 0; i < 3; i++) { fresh.ensure(day, now, now, () => {}, mine); await tick(); await tick(); }
  assert.deepEqual(fresh.rows(day, now, mine).map(r => [r.fetchedAt, r.long[20], r.short[20]]), [[t3, 2, 3]]);
  assert.ok(!fresh.ordersAbsent(mine, day, now));
});

test('the take-profit overlay is never cached across its two modes: alone they are the rows, beside the curve an overlay, in days and in the 4-hour history', async () => {
  const day = Date.UTC(2026, 10, 15), now = day + 12 * 3_600_000, index = 'https://levels.hiverust.dev/v1/btc/liquidation-history.json';
  const t1 = day + 3_600_000, t3 = day + 5 * 3_600_000;
  const files: Record<string, unknown> = {
    [index]: { edges: EDGES, first: day - 3 * DAY_MS, last: now - 600_000 },
    [`https://levels.hiverust.dev/v1/btc/liquidation-history/${dayText(day)}.json`]: { rows: [freeRow(t1, { 10: [100, 200] }), freeRow(t3, { 10: [500, 600] })] },
    [U.triggersDay(dayText(day))]: { rows: [plusRow(t1, part({ 20: [7, 8] }), part({ 20: [50, 0], 30: [0, 60] })), plusRow(t3, part({ 20: [9, 9] }), part({ 30: [0, 5] }))] },
    [U.rollup.free]: { v: 1, coin: 'BTC', hours: 4, edges: ROLLUP_EDGES, rows: [freeRow(t1, {})].map(r => [...r.slice(0, 6), zeros(13).map((_, i) => i === 9 ? 1_000 : 0), zeros(13)]) },
    [U.rollup.triggers]: { v: 1, coin: 'BTC', hours: 4, edges: ROLLUP_EDGES, kinds: ['stops', 'takes'], rows: [plusRow(t1 + 30 * MIN, part({ 9: [11, 0] }, 13), part({ 9: [0, 22] }, 13))] },
  };
  const host = (u: string): string => u.replace(/^https?:\/\/[^/]+/, 'https://levels.hiverust.dev');
  for (const [k, value] of Object.entries(files)) files[host(k)] = value;
  const h = new LiqHistory(url => url in files ? Promise.resolve(files[url]) : Promise.reject(new Error('404')), { freeFrom: () => day - 7 * DAY_MS, pass: () => 'v1.member.sig', refused: () => {} });
  const alone = view({ liq: false, takes: true }), beside = view({ liq: true, takes: true });
  for (const [from, label] of [[day, 'days'], [now - (MAX_DAYS + 10) * DAY_MS, '4-hour history']] as const) {
    const ask = async (v: LiqView): Promise<void> => { for (let i = 0; i < 3; i++) { h.ensure(from, now, now, () => {}, v); await tick(); await tick(); } };
    // Alone, then beside the liquidations: the overlay is there, once.
    await ask(alone);
    const a = h.series(from, now, alone);
    assert.ok(a.rows.length > 0, `${label}: take profits alone have rows`); assert.deepEqual(a.takes, null, `${label}: and no overlay`);
    await ask(beside);
    const b = h.series(from, now, beside);
    assert.ok(b.takes && b.takes.length > 0, `${label}: beside the liquidations the overlay is there after take profits alone`);
    // And back: alone again has no overlay, and beside again the same overlay, not doubled.
    assert.deepEqual(h.series(from, now, alone).takes, null);
    assert.equal(h.series(from, now, beside).takes!.length, b.takes!.length, `${label}: never doubled`);
  }
});

test('every write of the levels\' setting keeps one kind on, and a present switch that is not a boolean is the free view, never a paid one', async () => {
  const store = new Store(initialState()), on = { on: true, column: true };
  store.set({ liqLevels: { ...store.state.liqLevels, liq: false, stops: false, takes: false } });
  assert.deepEqual(store.state.liqLevels, { ...on, liq: true, stops: false, takes: false, group: 'all', split: 'none' }, 'all three off, written by code: the free view');
  store.set({ liqLevels: { ...store.state.liqLevels, liq: false, takes: true } });
  assert.equal(curveOf(store.state.liqLevels), 'takes'); assert.equal(store.state.liqLevels.takes, true, 'take profits alone stay a choice');
  const free = { ...on, liq: true, stops: false, takes: false, group: 'all', split: 'none' };
  assert.deepEqual(readLiqLevels({ liq: 'invalid', stops: true, takes: true, group: 'profitable' }), free, 'a malformed switch: the free view');
  assert.deepEqual(readLiqLevels({ liq: true, stops: 1 }), free);
  assert.deepEqual(readLiqLevels({ liq: false, stops: true }), { ...on, liq: false, stops: true, takes: false, group: 'all', split: 'none' }, 'a missing switch is off');
  assert.deepEqual(carriedSettings({ liqLevels: { liq: 'yes', stops: true, takes: true, group: 'profitable' } } as never).liqLevels, free, 'nor through a layout');
});

test('take profits alone are read as take profits: the finger\'s box in the order sides\' colours', () => {
  const box = (side: 'long' | 'short') => probeBoxLines({ kind: 'takes', side, at: side === 'long' ? 90 : 110, price: 100, way: 1_000, other: 500, level: 200, lo: 80, hi: 90, positions: 1, top: 0, parts: null });
  assert.deepEqual([box('long')[0]!.text, box('long')[0]!.color], ['Take profits of shorts', 'buy'], 'below the price: the buys that close shorts');
  assert.deepEqual([box('short')[0]!.text, box('short')[0]!.color], ['Take profits of longs', 'sell']);
  assert.equal(box('long').at(-1)!.color, 'sell', 'the other side is the sells');
  const liq = probeBoxLines({ kind: 'liq', side: 'long', at: 90, price: 100, way: 1_000, other: 500, level: 200, lo: 80, hi: 90, positions: 1, top: 0, parts: null });
  assert.equal(liq[0]!.color, 'sell', 'long liquidations stay sells');
});

test('a control dropped ends both its listeners, and the panel drops the control it held each time it draws afresh or closes', () => {
  const live = { store: 0, plus: 0 };
  const store = { subscribe: () => { live.store++; return () => { live.store--; }; } }, membership = { subscribe: () => { live.plus++; return () => { live.plus--; }; } };
  const offs = Array.from({ length: 10 }, () => controlListeners(store, membership, () => {}, () => {}));
  assert.deepEqual(live, { store: 10, plus: 10 });
  for (const off of offs) { off(); off(); }
  assert.deepEqual(live, { store: 0, plus: 0 }, 'every listener gone, a second destroy harmless');
  // The panel: ten drawings, then closed; only the newest is held at any time, and none after.
  for (let i = 0; i < 10; i++) holdPanelControl({ destroy: controlListeners(store, membership, () => {}, () => {}) });
  assert.deepEqual(live, { store: 1, plus: 1 }, 'each drawing drops the control before it');
  releaseLiqLevelPanel();
  assert.deepEqual(live, { store: 0, plus: 0 }, 'closed: no listener survives');
});

test('the bottom sheet keeps the focus inside it: Tab from the last control goes to the first, Shift+Tab from the first to the last', () => {
  assert.equal(trapStep(5, 4, false), 0); assert.equal(trapStep(5, 0, true), 4);
  assert.equal(trapStep(5, 2, false), null, 'between them the browser steps on'); assert.equal(trapStep(5, 2, true), null);
  assert.equal(trapStep(5, -1, false), 0, 'from the sheet itself: the first control'); assert.equal(trapStep(5, -1, true), 4);
  assert.equal(trapStep(0, -1, false), null);
});

test('the popover goes under its button, inside the window, and above it where there is no room below', () => {
  const win = { w: 1000, h: 800 };
  assert.deepEqual(popoverPlace({ left: 100, top: 40, bottom: 66 }, { w: 312, h: 300 }, win), { left: 100, top: 72 });
  assert.deepEqual(popoverPlace({ left: 900, top: 40, bottom: 66 }, { w: 312, h: 300 }, win), { left: 680, top: 72 }, 'shifted in from the right edge');
  assert.deepEqual(popoverPlace({ left: 100, top: 700, bottom: 726 }, { w: 312, h: 300 }, win), { left: 100, top: 394 }, 'above');
});

test('the note says when the orders are well behind the liquidations, and why a view draws nothing; both on two grids is not added up', async () => {
  const pass = { value: 'v1.pass.sig' as string | null };
  let orders: unknown = triggers(STOPS, TAKES, AS_OF - 3 * 3_600_000);
  const s = service({ [U.groups]: { status: 200, body: groups([[7, 0, 50, 0, 0, 1, 0, 50, 0]], null) }, [U.triggers]: () => ({ status: 200, body: orders }) }, pass);
  const both = view({ liq: true, stops: true, takes: true });
  s.src.ensure(BTC, () => {}, both); await tick(); s.src.ensure(BTC, () => {}, both); await tick();
  assert.equal(s.src.state, 'ready');
  const note = liqNote(s.src, both, s.src.levels!.asOf);
  assert.match(note, /^Hyperliquid liquidations and stops at /);
  assert.match(note, /stops and take profits as of /, note);
  assert.doesNotMatch(note, /with take profits/, 'said once');
  assert.match(liqNote(s.src, view({ liq: true, stops: true }), s.src.levels!.asOf), / · stops as of /);
  // Orders of the same snapshot: nothing more to say than that take profits are drawn.
  const fresh = service({ [U.triggers]: { status: 200, body: triggers(STOPS, TAKES) } }, pass);
  fresh.src.ensure(BTC, () => {}, both); await tick(); fresh.src.ensure(BTC, () => {}, both); await tick();
  assert.doesNotMatch(liqNote(fresh.src, both, fresh.src.levels!.asOf), /as of/);
  assert.match(liqNote(fresh.src, both, fresh.src.levels!.asOf), / · with take profits$/);
  // The orders on another grid than the liquidations: not added up, said as orders that could not be read.
  orders = { ...triggers(STOPS, TAKES), step: 5 };
  const grid = service({ [U.triggers]: () => ({ status: 200, body: orders }) }, pass);
  grid.src.ensure(BTC, () => {}, both); await tick(); grid.src.ensure(BTC, () => {}, both); await tick();
  assert.equal(grid.src.levels, null);
  assert.equal(grid.src.state, 'unavailable');
  assert.equal(liqWhy(grid.src, grid.src.asOfs().liq), 'Stop levels could not be read.');
});

test('Liq + stops apart: each part what still stands of it, the two always adding up to the total the page shows, row by row and on the way', async () => {
  const pass = { value: 'v1.pass.sig' as string | null };
  // Liquidations of longs at [80, 90) and shorts at [110, 120); the orders' stops at [80, 90) and [120, 130).
  const s = service({ [U.triggers]: { status: 200, body: triggers(STOPS, TAKES) } }, pass, () => free([[8, 0, 200, 0, 0, 2, 0, 150, 0], [11, 0, 0, 0, 80, 0, 1, 0, 80]]));
  const both = view({ liq: true, stops: true });
  s.src.ensure(BTC, () => {}, both); await tick(); s.src.ensure(BTC, () => {}, both); await tick();
  assert.equal(s.src.state, 'ready');
  const parts = s.src.partStandings()!, total = s.src.standing()!;
  assert.ok(parts, 'both: the parts are there');
  for (const [side, lo, hi] of [['long', 80, 90], ['long', 60, 100], ['short', 110, 130], ['short', 100, 125]] as const) {
    const p = partsBetween(parts, side, lo, hi), sum = standingBelow(total, side, hi) - standingBelow(total, side, lo);
    assert.ok(Math.abs(p.liq + p.stops - sum) < 1e-6, `${side} [${lo}, ${hi}): ${p.liq} + ${p.stops} = ${sum}`);
  }
  assert.deepEqual(partsBetween(parts, 'long', 80, 90), { liq: 200, stops: 400 });
  const price = 100;
  for (const at of [85, 70, 115, 128, 140]) {
    const p = partsOnTheWay(parts, price, at)!, way = onTheWay(total, price, at)!;
    assert.ok(Math.abs(p.liq + p.stops - way.usd) < 1e-6, `to ${at}`);
  }
  assert.equal(partsOnTheWay(parts, price, price), null, 'nothing to say at the price itself');
  // A view of one kind has no parts.
  s.src.ensure(BTC, () => {}, view({ liq: false, stops: true })); await tick();
  assert.equal(s.src.partStandings(), null);
  assert.equal(splitText({ liq: 200_500_000, stops: 130_100_000 }), 'Total $330.6M = liquidations $200.5M + stops $130.1M', 'the total is the parts added');
});

test('under the column\'s button: the group where the button had no room for it, first, then that the take profits are not in the curve', () => {
  assert.equal(takesLeftOut(), 'Take profits not included');
  const profitable = { liq: true, stops: false, takes: true, group: 'profitable' } as const;
  assert.deepEqual(columnNotes(profitable, false, true), ['Profitable traders', 'Take profits not included'], 'both: the group line first');
  assert.deepEqual(columnNotes(profitable, true, true), ['Take profits not included'], 'the group already on the button: not said twice');
  assert.deepEqual(columnNotes({ liq: true, stops: true, takes: false, group: 'profitable' }, false, false), ['Profitable traders']);
  assert.deepEqual(columnNotes({ liq: true, stops: false, takes: false, group: 'all' }, false, false), [], 'everyone: nothing to add');
  assert.deepEqual(columnNotes({ liq: false, stops: true, takes: false, group: 'profitable' }, false, true), ['Profitable traders', 'Take profits not included'], "the profitable traders' stops are theirs too");
});

test('a split writes its three amounts in the total\'s unit and precision, the parts adding up to the total as printed', () => {
  // Sol's case: two parts of 1.04M each made "Total $2.1M = liquidations $1M + stops $1M".
  assert.deepEqual(splitAmounts(2_080_000, 1_040_000, 1_040_000), ['2.1M', '1.1M', '1M'], 'the step left over goes to one part, the first on a tie');
  assert.equal(splitText({ liq: 1_040_000, stops: 1_040_000 }), 'Total $2.1M = liquidations $1.1M + stops $1M');
  // Across the units' edges: the parts take the total's unit, whatever their own size.
  assert.deepEqual(splitAmounts(999_940, 600_000, 399_940), ['999.9K', '600K', '399.9K']);
  assert.deepEqual(splitAmounts(999_960, 600_000, 399_960), ['1M', '0.6M', '0.4M'], '999.96K prints as 1M, so do its parts\' unit');
  assert.deepEqual(splitAmounts(999_940_000, 500_000_000, 499_940_000), ['999.9M', '500M', '499.9M']);
  assert.deepEqual(splitAmounts(999_960_000, 700_000_000, 299_960_000), ['1B', '0.7B', '0.3B']);
  assert.deepEqual(splitAmounts(512, 300.4, 211.6), ['512', '300', '212'], 'whole dollars under $1,000');
  assert.deepEqual(splitAmounts(2_100_000, 2_060_000, 40_000), ['2.1M', '2.1M', '0'], 'a part too small for the total\'s precision reads 0, never more than the total');
  assert.deepEqual(splitAmounts(0, 0, 0), ['0', '0', '0']);
  // Whatever the amounts, the parts read back in the total's unit add up to it exactly.
  const read = (text: string): number => { const m = /^(\d+(?:\.\d)?)([KMBT]?)$/.exec(text)!; return Math.round(Number(m[1]) * 10); };
  for (let i = 1; i < 4_000; i++) {
    const a = (i * 7_919) % 1_000_003 * 1_137.7, b = (i * 104_729) % 999_983 * 911.3, [t, pa, pb] = splitAmounts(a + b, a, b);
    if (t === '0') continue;
    const unit = /[KMBT]$/.exec(t)?.[0] ?? '';
    for (const part of [pa, pb]) assert.ok(part === '0' || part.endsWith(unit) && (unit !== '' || /^\d+$/.test(part)), part + ' in ' + t);
    const n = (x: string): number => x === '0' ? 0 : read(x.replace(/[KMBT]$/, '') + unit);
    assert.equal(n(pa) + n(pb), read(t), t + ' = ' + pa + ' + ' + pb);
  }
  // The total said is the figure the line above says, when there is one: the parts are its shares.
  assert.equal(splitText({ liq: 996_000, stops: 0 }, 1_000_000), 'Total $1M = liquidations $1M + stops $0');
});

/** A levels service holding liquidations and stops on one grid, the view Liq + stops. */
async function bothService() {
  const pass = { value: 'v1.pass.sig' as string | null };
  // Liquidations of longs at [80, 90) and shorts at [110, 120); stops closing longs at [80, 90) and shorts at [120, 130).
  const stops = [[8, 1_300_000, 740_000, 0, 0, 2, 0, 1_300_000, 0], [12, 0, 0, 520_000, 520_000, 0, 3, 0, 520_000]];
  const s = service({ [U.triggers]: { status: 200, body: triggers(stops, TAKES) } }, pass, () => free([[8, 0, 1_040_000, 0, 0, 2, 0, 900_000, 0], [11, 0, 0, 0, 2_500_000, 0, 1, 0, 2_500_000]]));
  const both = view({ liq: true, stops: true });
  s.src.ensure(BTC, () => {}, both); await tick(); s.src.ensure(BTC, () => {}, both); await tick();
  assert.equal(s.src.state, 'ready');
  return s.src;
}
const lineAfter = (lines: InfoLine[], label: string): { figure: InfoLine; next: InfoLine | undefined } => {
  const i = lines.findIndex(l => l.label === label);
  assert.ok(i >= 0, label);
  return { figure: lines[i]!, next: lines[i + 1] };
};

test('the stripe\'s box and the phone\'s finger write every amount in dollars', async () => {
  const src = await bothService(), levels = src.levels!, rows = liqRows(levels, src.taken(), 1, 0, 200);
  const row = rows.find(r => r.p0 === 80)!;
  // Liquidations alone (no parts): the level, the way there, the largest and the two parts, each with its "$".
  const plain = stripeBoxLines(row, 'liq', 100, src.standing(), null, side => row[side + 'Left' as 'longLeft'] > 0);
  for (const label of ['At this level', 'If price gets here']) assert.match(lineAfter(plain, label).figure.text, /^\$\d/, label);
  assert.match(plain.find(l => l.label === 'Largest position')!.text, /^\$\d[\d.]*[KMB]? \(\d+%\)$/);
  assert.match(plain.find(l => l.label === 'Isolated / cross margin')!.text, /^\$\S+ \/ \$\S+$/);
  // A level partly gone: both of its amounts in dollars.
  const part: LiqRow = { ...row, longLeft: row.long * 0.5 };
  assert.match(lineAfter(stripeBoxLines(part, 'liq', 100, src.standing(), null, () => true), 'At this level').figure.text, /^\$\S+ of \$\S+$/);
  // The phone's finger.
  const probe = probeBoxLines({ kind: 'liq', side: 'long', at: 85, price: 100, way: 2_080_000, other: 300_000, level: 1_040_000, lo: 80, hi: 90, positions: 2, top: 900_000, parts: null });
  for (const label of ['If price gets here', 'At this level', 'Largest position', 'Same distance, other side']) assert.match(probe.find(l => l.label === label)!.text, /^\$\d/, label);
  assert.equal(dollars(1_040_000), '$1M');
});

test('under each total of Liq + stops, its parts add up to the figure the line above says, as printed: stripe, column, Mirror, phone', async () => {
  const src = await bothService(), levels = src.levels!, standing = src.standing()!, parts = src.partStandings()!, price = 100;
  const total = (split: string | undefined): string => /^Total (\$\S+) = /.exec(split ?? '')?.[1] ?? 'none';
  // The stripe's box: under "At this level" (the figure said first) and under "If price gets here".
  let checked = 0;
  for (const row of liqRows(levels, src.taken(), 1, 0, 200)) {
    const lines = stripeBoxLines(row, 'both', price, standing, parts, side => row[side + 'Left' as 'longLeft'] > 0);
    for (const label of ['At this level', 'If price gets here']) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.label !== label) continue;
        const figure = lines[i]!.text.split(' ')[0]!, next = lines[i + 1];
        assert.ok(next?.label === undefined && next.text.startsWith('Total '), 'a split under ' + label);
        assert.equal(total(next.text), figure, label + ' at ' + row.p0); checked++;
      }
    }
    // A row partly gone: the split adds up to what still stands, said first.
    const part: LiqRow = { ...row, longLeft: row.long * 0.6, shortLeft: row.short * 0.6 };
    const gone = stripeBoxLines(part, 'both', price, standing, parts, side => part[side + 'Left' as 'longLeft'] > 0);
    const at = lineAfter(gone, 'At this level');
    assert.equal(total(at.next?.text), at.figure.text.split(' ')[0], 'partly gone');
  }
  assert.equal(checked, 6, 'three rows, two splits each');
  // Those figures, written out: the parts add up as printed (3.08M of 1.04M and 2.04M is $3.1M = $1M + $2.1M).
  const first = stripeBoxLines(liqRows(levels, src.taken(), 1, 0, 200)[0]!, 'both', price, standing, parts, () => true);
  assert.equal(lineAfter(first, 'At this level').next?.text, 'Total $3.1M = liquidations $1M + stops $2.1M');
  // The column's reading at the pointer, at prices both ways.
  for (const at of [70, 75, 85, 105, 115, 125, 140]) {
    const way = onTheWay(standing, price, at)!, r = readingTexts(way, price, at, parts);
    assert.equal(total(r.split ?? undefined), dollars(way.usd), 'reading at ' + at);
    assert.ok(r.full.endsWith('· ' + dollars(way.usd)) && r.short.endsWith(dollars(way.usd)));
  }
  // The Mirror box: each side's total over the same distance both ways.
  for (const d of [5, 15, 25, 35]) {
    const below = Math.max(0, standingBelow(standing, 'long', price) - standingBelow(standing, 'long', price - d));
    const above = Math.max(0, standingBelow(standing, 'short', price + d) - standingBelow(standing, 'short', price));
    const m = mirrorSplits(parts, price, d, below, above);
    assert.equal(total(m.long), dollars(below), 'Mirror below, ' + d); assert.equal(total(m.short), dollars(above), 'Mirror above, ' + d);
  }
  // The phone's finger: under "If price gets here" and under "At this level".
  for (const at of [75, 85, 115, 125]) {
    const side = at >= price ? 'short' : 'long', lo = Math.floor(at / 10) * 10, hi = lo + 10;
    const way = side === 'short' ? standingBelow(standing, 'short', at) - standingBelow(standing, 'short', price) : standingBelow(standing, 'long', price) - standingBelow(standing, 'long', at);
    const level = Math.max(0, standingBelow(standing, side, hi) - standingBelow(standing, side, lo));
    const lines = probeBoxLines({ kind: 'both', side, at, price, way, other: 0, level, lo, hi, positions: 1, top: 0, parts });
    const w = lineAfter(lines, 'If price gets here');
    assert.equal(total(w.next?.text), w.figure.text, 'phone way at ' + at);
    if (level > 0) { const l = lineAfter(lines, 'At this level'); assert.equal(total(l.next?.text), l.figure.text, 'phone level at ' + at); }
  }
  assert.equal(usd(0), '0');
});

test('a level partly gone says what still stands wherever that prints differently, and its split adds up to what stands, never to the whole', () => {
  // Sol's case (round 2): a $999.94M level, 0.4 % of it gone, printed "Total $999.9M = liquidations $500M + stops $499.9M".
  const liqLeft = 500_000_000 * 0.996, stopsLeft = 499_940_000 * 0.996;
  const standing = (v: number): LiqStanding => ({ k: Int32Array.from([8]), step: 10, long: Float64Array.from([0, v]), short: Float64Array.from([0, 0]) });
  const parts = { liq: standing(liqLeft), stops: standing(stopsLeft) };
  const row = (left: number): LiqRow => ({ p0: 80, p1: 90, long: 999_940_000, longIso: 500_000_000, longWallets: 9, short: 0, shortIso: 0, shortWallets: 0, longTop: 1e8, shortTop: 0,
    longOne: false, shortOne: false, longFirst: NaN, longGone: NaN, longLeft: left, shortFirst: NaN, shortGone: NaN, shortLeft: 0 });
  const box = stripeBoxLines(row(liqLeft + stopsLeft), 'both', 100, null, parts, side => side === 'long');
  const at = box.findIndex(l => l.label === 'At this level');
  assert.equal(box[at]!.text, '$995.9M of $999.9M', 'what stands, of the whole');
  assert.equal(box[at + 1]!.text, 'Total $995.9M = liquidations $498M + stops $497.9M', 'the parts of what stands');
  // Gone by less than moves the printed figure: the whole is said, the split is of what stands, and it reads the same figure.
  const sliver = 999_930_000, few = { liq: standing(sliver * 0.5), stops: standing(sliver * 0.5) };
  const near = stripeBoxLines(row(sliver), 'both', 100, null, few, side => side === 'long'), n = near.findIndex(l => l.label === 'At this level');
  assert.equal(near[n]!.text, '$999.9M');
  assert.equal(near[n + 1]!.text, 'Total $999.9M = liquidations $500M + stops $499.9M');
});

test('a split never prints NaN: a part that is not a finite amount of at least nothing counts as nothing', () => {
  assert.deepEqual(splitAmounts(100, NaN, 20), ['100', '0', '100'], 'Sol\'s probe: was 100 = 1 + 0');
  assert.deepEqual(splitAmounts(100, Infinity, 20), ['100', '0', '100'], 'Sol\'s probe: was 100 = NaN + NaN');
  assert.deepEqual(splitAmounts(100, -5, 20), ['100', '0', '100']);
  assert.deepEqual(splitAmounts(2_100_000, NaN, NaN), ['2.1M', '0', '0'], 'parts of nothing stay nothing');
  assert.deepEqual(splitAmounts(NaN, 5, 20), ['–', '5', '20'], 'no total to print: each said alone');
  assert.deepEqual(splitAmounts(Infinity, NaN, -Infinity), ['–', '0', '0']);
  for (const v of [NaN, Infinity, -Infinity, -1, 0, 5e6]) for (const w of [NaN, Infinity, -2, 0, 3e6]) for (const total of [NaN, 0, 8e6]) {
    assert.ok(!splitAmounts(total, v, w).join(' ').includes('NaN'), [total, v, w].join(' '));
    assert.ok(!splitText({ liq: v, stops: w }, total).includes('NaN'));
  }
});

// Sol's review of a002e459..d5a6b43f (round 2). Everyone's orders and the profitable traders' come from one order file, so the two families
// carry the same snapshot times; everyone's amounts are ten times theirs and their counts five times (Sol's probe: 100 against 10).
const FAM = {
  all: { liq: [[9, 0, 100, 0, 0, 5, 0, 100, 0], [11, 0, 0, 0, 100, 0, 5, 0, 100]], stops: [[8, 100, 0, 0, 0, 5, 0, 100, 0], [12, 0, 0, 100, 0, 0, 5, 0, 100]],
    takes: [[6, 0, 0, 0, 100, 0, 5, 0, 100], [14, 100, 0, 0, 0, 5, 0, 100, 0]] },
  profitable: { liq: [[9, 0, 10, 0, 0, 1, 0, 10, 0], [11, 0, 0, 0, 10, 0, 1, 0, 10]], stops: [[8, 10, 0, 0, 0, 1, 0, 10, 0], [12, 0, 0, 10, 0, 0, 1, 0, 10]],
    takes: [[6, 0, 0, 0, 10, 0, 1, 0, 10], [14, 10, 0, 0, 0, 1, 0, 10, 0]] },
};
/** A levels service with both families of every Plus file and a pass (`over` replaces a file's answer). */
function familyService(over: Record<string, LiqAnswer | (() => LiqAnswer)> = {}, freeDoc: () => unknown = () => free(FAM.all.liq)) {
  return service({ [U.groups]: { status: 200, body: groups(FAM.profitable.liq, null) }, [U.triggers]: { status: 200, body: triggers(FAM.all.stops, FAM.all.takes) },
    [U.triggersGroups]: { status: 200, body: triggerGroups(FAM.profitable.stops, FAM.profitable.takes) }, ...over }, { value: 'v1.pass.sig' }, freeDoc);
}
const show = async (s: ReturnType<typeof service>, v: Partial<LiqView>): Promise<void> => {
  for (let i = 0; i < 3; i++) { s.src.ensure(BTC, () => {}, view(v)); await tick(); }
  assert.equal(s.src.state, 'ready', JSON.stringify(v));
};
/** Everyone, then the profitable traders, then everyone again: the group, everyone's amount or theirs, and the count. */
const BOTH_WAYS = [['all', 100, 5], ['profitable', 10, 1], ['all', 100, 5]] as const;
/** The map's prices in view and its height: a $10 bin is 100 px tall, so a row is a bin. */
const SCREEN = { p0: 50, p1: 160 }, PH = 1_100;
const rowAt = (rows: readonly LiqRow[], p: number): LiqRow => { const r = rows.find(x => x.p0 <= p && p < x.p1); assert.ok(r, `a row at ${p}`); return r; };

test('every key a drawing of the levels is kept by names the order family: everyone\'s take profits and the profitable traders\', of one order file, never share one (Sol, round 2)', async () => {
  const s = familyService(), key: string[] = [], takes: string[] = [];
  for (const [group] of BOTH_WAYS) {
    await show(s, { liq: true, stops: true, takes: true, group });
    key.push(s.src.key()); takes.push(s.src.takesKey());
  }
  assert.equal(s.src.takes!.asOf, AS_OF, 'the two families carry the same snapshot times');
  for (const [name, k] of [['key', key], ['takesKey', takes]] as const) {
    assert.notEqual(k[0], k[1], `${name}: Everyone to Profitable`); assert.notEqual(k[1], k[2], `${name}: Profitable to Everyone`);
    assert.equal(k[0], k[2], `${name}: Everyone again is the same drawing`);
  }
});

test('the stripe follows the order family both ways: its take profits\' lane and its levels\' lane, kept from frame to frame as the map keeps them', async () => {
  for (const v of [{ liq: true, takes: true }, { liq: true, stops: true, takes: true }, { liq: false, stops: true, takes: true }]) {
    const s = familyService(), name = JSON.stringify(v);
    let takes: LaneRows | null = null, levels: LaneRows | null = null;
    for (const [group, amount, count] of BOTH_WAYS) {
      await show(s, { ...v, group });
      takes = laneRows(s.src, 'takes', s.src.takes!, SCREEN, PH, takes); levels = laneRows(s.src, 'levels', s.src.levels!, SCREEN, PH, levels);
      // The take profits of longs (sells above the price) and of shorts (buys below it), the view's group's.
      assert.equal(rowAt(takes.rows, 145).short, amount, `${name} ${group}: take profits of longs`); assert.equal(rowAt(takes.rows, 145).shortWallets, count);
      assert.equal(rowAt(takes.rows, 65).long, amount, `${name} ${group}: take profits of shorts`);
      // The levels' lane: their liquidations, their stops, or both.
      if (v.liq) assert.equal(rowAt(levels.rows, 95).long, amount, `${name} ${group}: liquidations`);
      if (v.stops) assert.equal(rowAt(levels.rows, 85).long, amount, `${name} ${group}: stops`);
    }
  }
});

test('the stripe\'s box follows the order family both ways: what it says at a level is the view\'s group\'s', async () => {
  const s = familyService();
  let takes: LaneRows | null = null, levels: LaneRows | null = null;
  for (const [group, amount, count] of BOTH_WAYS) {
    await show(s, { liq: true, takes: true, group });
    takes = laneRows(s.src, 'takes', s.src.takes!, SCREEN, PH, takes); levels = laneRows(s.src, 'levels', s.src.levels!, SCREEN, PH, levels);
    const box = stripeBoxLines(rowAt(takes.rows, 145), 'takes', 100, s.src.takesStanding(), null, side => side === 'short');
    assert.equal(lineAfter(box, 'At this level').figure.text, dollars(amount), `${group}: the take profit's level`);
    assert.equal(lineAfter(box, 'Orders').figure.text, String(count), `${group}: its orders`);
    assert.equal(lineAfter(box, 'If price gets here').figure.text, dollars(amount));
    const liq = stripeBoxLines(rowAt(levels.rows, 95), 'liq', 100, s.src.standing(), null, side => side === 'long');
    assert.equal(lineAfter(liq, 'At this level').figure.text, dollars(amount), `${group}: the liquidation level`);
    assert.equal(lineAfter(liq, 'Positions').figure.text, String(count));
  }
});

test('the liquidation column follows the order family both ways: its curve, its take-profit bars, its reading at the pointer and its notes', async () => {
  const s = familyService();
  for (const [group, amount] of BOTH_WAYS) {
    await show(s, { liq: true, takes: true, group });
    // Rows of $10 from $50: [90, 100) is the fifth, [60, 70) the second, [140, 150) the tenth.
    const prof = liqProfile(s.src.standing()!, 10, 50, 160, 100), tprof = liqProfile(s.src.takesStanding()!, 10, 50, 160, 100);
    assert.equal(prof.long[4], amount, `${group}: the liquidations' bar`); assert.equal(liqCurves(prof, 100).long.at(-1)!.usd, amount, `${group}: the curve`);
    assert.equal(tprof.short[9], amount, `${group}: take profits of longs`); assert.equal(tprof.long[1], amount, `${group}: take profits of shorts`);
    assert.equal(readingTexts(onTheWay(s.src.standing()!, 100, 85)!, 100, 85, null).short, `▼ ${dollars(amount)}`, `${group}: the reading`);
    assert.deepEqual(columnNotes(view({ liq: true, takes: true, group }), true, true, s.src.ordersAbsent()), ['Take profits not included']);
  }
});

test('the phone\'s Liq tab follows the order family both ways: its totals, its finger and its take-profit bars', async () => {
  const s = familyService(), price = 100, lo = 50, hi = 150;
  for (const [group, amount, count] of BOTH_WAYS) {
    // Take profits alone: the totals are theirs (those of shorts below the price, of longs above), and so is what the finger reads.
    await show(s, { liq: false, takes: true, group });
    const st = s.src.standing()!;
    assert.equal(standingBelow(st, 'long', price) - standingBelow(st, 'long', lo), amount, `${group}: below`);
    assert.equal(standingBelow(st, 'short', hi) - standingBelow(st, 'short', price), amount, `${group}: above`);
    assert.equal(liqProfile(st, 10, lo, hi, price).short[9], amount, `${group}: the finger's level`);
    assert.deepEqual(binsIn(s.src.levels!, 'short', 140, 150), { positions: count, top: amount }, `${group}: its orders and the largest`);
    // Beside the liquidations: their dashed bars, on the levels' scale.
    await show(s, { liq: true, takes: true, group });
    const tprof = liqProfile(s.src.takesStanding()!, 10, lo, hi, price);
    assert.equal(tprof.short[9], amount, `${group}: bars above`); assert.equal(tprof.long[1], amount, `${group}: bars below`);
  }
});

/** One snapshot of every history family, everyone's amounts ten times the profitable traders' (1,000 against 100), in days and in the rollups. */
function familyHistory() {
  const day = Date.UTC(2026, 10, 15), now = day + 12 * 3_600_000, t = day + 3 * 3_600_000, roll = (v: number): number[] => zeros(13).map((_, i) => i === 9 ? v : 0);
  const host = (u: string): string => u.replace(/^https?:\/\/[^/]+/, 'https://levels.hiverust.dev');
  const files: Record<string, unknown> = {};
  const put = (u: string, body: unknown): void => { files[host(u)] = body; };
  put('https://x/v1/btc/liquidation-history.json', { edges: EDGES, first: day - 3 * DAY_MS, last: now - 600_000 });
  put(`https://x/v1/btc/liquidation-history/${dayText(day)}.json`, { rows: [freeRow(t, { 10: [1_000, 1_000] })] });
  put(U.groupsDay(dayText(day)), { groups: ['profitable'], rows: [plusRow(t, part({ 10: [100, 100] }), null)] });
  put(U.triggersDay(dayText(day)), { kinds: ['stops', 'takes'], rows: [plusRow(t, part({ 20: [1_000, 1_000] }), part({ 30: [1_000, 1_000] }))] });
  put(U.triggersGroupsDay(dayText(day)), { groups: ['profitable'], kinds: ['stops', 'takes'], rows: [plusRow(t, part({ 20: [100, 100] }), part({ 30: [100, 100] }))] });
  put(U.rollup.free, { hours: 4, edges: ROLLUP_EDGES, rows: [[...freeRow(t, {}).slice(0, 6), roll(1_000), roll(1_000)]] });
  put(U.rollup.groups, { hours: 4, edges: ROLLUP_EDGES, groups: ['profitable'], rows: [plusRow(t, part({ 9: [100, 100] }, 13), null)] });
  put(U.rollup.triggers, { hours: 4, edges: ROLLUP_EDGES, kinds: ['stops', 'takes'], rows: [plusRow(t, part({ 9: [1_000, 1_000] }, 13), part({ 9: [1_000, 1_000] }, 13))] });
  put(U.rollup.triggersGroups, { hours: 4, edges: ROLLUP_EDGES, groups: ['profitable'], kinds: ['stops', 'takes'], rows: [plusRow(t, part({ 9: [100, 100] }, 13), part({ 9: [100, 100] }, 13))] });
  const h = new LiqHistory(url => url in files ? Promise.resolve(files[url]) : Promise.reject(new Error('404')), { freeFrom: () => day - 7 * DAY_MS, pass: () => 'v1.member.sig', refused: () => {} });
  const ask = async (v: LiqView, from = day): Promise<void> => { for (let i = 0; i < 3; i++) { h.ensure(from, now, now, () => {}, v); await tick(); await tick(); } };
  return { h, ask, files, put, day, now, t, wideFrom: now - (MAX_DAYS + 10) * DAY_MS };
}
const HISTORY_WAYS = [['all', 1_000], ['profitable', 100], ['all', 1_000]] as const;

test('the Depth pane\'s history follows the order family both ways, in days and in the 4-hour history (its memos keyed by the family): its levels and its take profits', async () => {
  const f = familyHistory();
  for (const [from, label, bucket] of [[f.day, 'days', 20], [f.wideFrom, '4-hour history', 9]] as const) {
    for (const [group, amount] of HISTORY_WAYS) {
      const v = view({ liq: true, stops: true, takes: true, group });
      await f.ask(v, from);
      const s = f.h.series(from, f.now, v);
      assert.equal(s.wide, label !== 'days');
      // Liquidations and stops added up from the mark out (the stops' bucket holds both), the take profits beside them with their sides swapped.
      assert.equal(s.rows.at(-1)!.long[bucket], 2 * amount, `${label} ${group}: liquidations and stops`);
      assert.equal(s.takes!.at(-1)!.long[label === 'days' ? 30 : 9], amount, `${label} ${group}: take profits`);
    }
  }
});

test('the Depth pane\'s Range summary follows the order family both ways: it sums the snapshot of the view drawn, never another family\'s', async () => {
  const f = familyHistory(), summary = new DepthRangeSummary(), sel = { t0: f.t - 600_000, t1: f.t + 1_800_000, p0: null, p1: null, live: false, draft: false };
  const held = (v: LiqView): DepthPaneHeld => ({ key: depthHeldKey('liq', [], [0.01], viewKey(v)), source: 'liq', ids: [], t0: f.day, t1: f.now, w: 100, radii: [0.01],
    bid: new Float32Array(100), ask: new Float32Array(100), bidCoin: new Float32Array(100), askCoin: new Float32Array(100), present: null, centred: null, stepMs: 0, answeredAt: Infinity,
    rows: f.h.series(f.day, f.now, v).rows, buckets: [20], omitted: [], view: v, holdMs: LIQ_HOLD_MS, wide: false, coins: false, coin: 'BTC', focus: 0 });
  const longs = (lines: ReturnType<DepthRangeSummary['lines']>): string | undefined => lines.find(l => l.key === 'dp-grid')?.grid?.[0]?.rows?.find(r => r.label === 'Longs')?.value;
  let before: DepthPaneHeld | null = null;
  for (const [group, amount] of HISTORY_WAYS) {
    const v = view({ liq: true, stops: true, group });
    await f.ask(v);
    const mine = held(v), lines = summary.lines(sel, mine, true, mine.key, f.now);
    assert.equal(longs(lines), `$${(2 * amount).toLocaleString('en-US')}`, `${group}: the snapshot's liquidations and stops`);
    assert.equal(lines.some(l => l.cells[0]?.includes('Profitable traders')), group === 'profitable', `${group}: whose`);
    // The snapshot drawn for the other family is not summed up under this one's: the summary waits for its own.
    if (before) assert.ok(summary.lines(sel, before, true, mine.key, f.now).some(l => l.key === 'dp-wait'), `${group}: the other family's snapshot waits`);
    before = mine;
  }
});

test('a 404 or 503 for the profitable traders\' orders after a good answer drops them from the drawing, and it stays so until a valid answer comes (Sol, round 2)', async () => {
  for (const status of [404, 503]) {
    let asOf = AS_OF, mine: LiqAnswer | null = { status: 200, body: triggerGroups(FAM.profitable.stops, FAM.profitable.takes) };
    const s = familyService({ [U.groups]: () => ({ status: 200, body: groups(FAM.profitable.liq, null, asOf) }), [U.triggersGroups]: () => { if (!mine) throw new Error('offline'); return mine; } }, () => free(FAM.all.liq, asOf));
    const all = view({ liq: true, stops: true, takes: true, group: 'profitable' }), ensure = async (v = all): Promise<void> => { for (let i = 0; i < 3; i++) { s.src.ensure(BTC, () => {}, v); await tick(); } };
    await show(s, all);
    assert.equal(s.src.levels!.kind, 'both'); assert.ok(s.src.takes);
    const before = { key: s.src.key(), version: s.src.version };
    let lane = laneRows(s.src, 'levels', s.src.levels!, SCREEN, PH, null);
    assert.equal(rowAt(lane.rows, 85).long, 10, 'their stops drawn');
    // A newer snapshot comes, and their orders' file answers 404 or 503.
    mine = { status, body: null, ...(status === 503 ? { retryAfter: 300 } : {}) };
    asOf = AS_OF + 30 * MIN; s.at(s.now() + 2 * 3_600_000);
    await ensure();
    assert.ok(s.src.ordersAbsent(), `${status}: said as not available yet`);
    assert.equal(s.src.state, 'ready'); assert.equal(s.src.levels!.kind, 'liq', `${status}: their liquidations alone`);
    assert.equal(s.src.takes, null, `${status}: their take profits no longer drawn`); assert.equal(s.src.takesState, 'missing'); assert.equal(s.src.takesKey(), '');
    assert.notEqual(s.src.key(), before.key, `${status}: the drawing's key changed`); assert.ok(s.src.version > before.version);
    lane = laneRows(s.src, 'levels', s.src.levels!, SCREEN, PH, lane);
    assert.equal(lane.rows.find(r => r.p0 === 80), undefined, `${status}: their stops gone from the levels' lane`);
    s.src.ensure(BTC, () => {}, view({ liq: false, stops: true, group: 'profitable' }));
    assert.equal(s.src.state, 'missing'); assert.equal(liqWhy(s.src, null), ordersAbsent(), `${status}: stops alone say why`);
    // Asked again after the wait: still not available while the answer is out, and after a failed read.
    mine = null; s.at(s.now() + 6 * MIN); s.src.ensure(BTC, () => {}, all);
    assert.ok(s.src.ordersAbsent(), `${status}: while asked again`);
    await ensure();
    assert.ok(s.src.ordersAbsent(), `${status}: after a failed read`); assert.equal(s.src.takes, null);
    // A valid answer: drawn again.
    mine = { status: 200, body: triggerGroups(FAM.profitable.stops, FAM.profitable.takes) }; s.at(s.now() + 6 * MIN);
    await ensure();
    assert.ok(!s.src.ordersAbsent(), `${status}: available again`); assert.equal(s.src.levels!.kind, 'both'); assert.ok(s.src.takes);
  }
});

/** A history reader whose profitable traders' orders' files answer as `answer` says (a body, or a failed read of that status), each ask counted. */
function absentHistory(answer: (url: string) => unknown | { fail: number; retryAfter?: number }) {
  const f = familyHistory(), asks = new Map<string, number>();
  const h = new LiqHistory(url => {
    asks.set(url, (asks.get(url) ?? 0) + 1);
    if (/trigger-history-groups/.test(url)) {
      const a = answer(url) as { fail?: number; retryAfter?: number } | undefined;
      if (a && typeof a.fail === 'number') return Promise.reject(Object.assign(new Error(String(a.fail)), a.retryAfter !== undefined ? { retryAfter: a.retryAfter } : {}));
      return Promise.resolve(a);
    }
    return url in f.files ? Promise.resolve(f.files[url]) : Promise.reject(new Error('404'));
  }, { freeFrom: () => f.day - 7 * DAY_MS, pass: () => 'v1.member.sig', refused: () => {} });
  const ask = async (v: LiqView, now: number, from = f.day): Promise<void> => { for (let i = 0; i < 3; i++) { h.ensure(from, f.now, now, () => {}, v); await tick(); await tick(); } };
  const dayUrl = `https://levels.hiverust.dev/v1/plus/btc/trigger-history-groups/${dayText(f.day)}.json`, rollUrl = 'https://levels.hiverust.dev/v1/plus/btc/trigger-history-groups-4h.json';
  return { ...f, h, ask, asks: (url: string): number => asks.get(url) ?? 0, dayUrl, rollUrl };
}
const MINE_STOPS = view({ liq: false, stops: true, group: 'profitable' });

test('the profitable traders\' orders\' history answering 404 or 503 is not available yet, asked again when the server says or in five minutes, and read once it comes, by the same reader (Sol, round 2)', async () => {
  for (const [label, fail, retryAfter, waitMs] of [['404', 404, undefined, 5 * 60_000], ['503 with Retry-After 120', 503, 120, 120_000], ['503 without it', 503, undefined, 5 * 60_000]] as const) {
    for (const [from, wide] of [['days', false], ['4-hour history', true]] as const) {
      let served: unknown = null;
      const r = absentHistory(() => served ?? { fail, retryAfter }), start = r.now, url = wide ? r.rollUrl : r.dayUrl, at = wide ? r.wideFrom : r.day, name = `${label}, ${from}`;
      await r.ask(MINE_STOPS, start, at);
      assert.equal(r.asks(url), 1, `${name}: asked`);
      assert.ok(r.h.ordersAbsent(MINE_STOPS, at, r.now), `${name}: not available yet`);
      assert.ok(r.h.series(at, r.now, MINE_STOPS).ordersAbsent, `${name}: and the series says so`);
      await r.ask(MINE_STOPS, start + waitMs - 5_000, at);
      assert.equal(r.asks(url), 1, `${name}: not asked again before the wait`);
      await r.ask(MINE_STOPS, start + waitMs + 1_000, at);
      assert.equal(r.asks(url), 2, `${name}: asked again once it is over`);
      // The file comes: the same reader reads it after the next wait.
      served = wide ? { hours: 4, edges: ROLLUP_EDGES, groups: ['profitable'], kinds: ['stops', 'takes'], rows: [plusRow(r.t, part({ 9: [100, 100] }, 13), part({ 9: [100, 100] }, 13))] }
        : { groups: ['profitable'], kinds: ['stops', 'takes'], rows: [plusRow(r.t, part({ 20: [100, 100] }), part({ 30: [100, 100] }))] };
      await r.ask(MINE_STOPS, start + 2 * waitMs + 2_000, at);
      assert.equal(r.asks(url), 3, `${name}: asked once more`);
      assert.ok(!r.h.ordersAbsent(MINE_STOPS, at, r.now), `${name}: available`);
      assert.equal(r.h.series(at, r.now, MINE_STOPS).rows.at(-1)!.long[wide ? 9 : 20], 100, `${name}: their stops drawn`);
    }
  }
});

test('missing profitable orders never erase their liquidations\' history: Liq + stops draws them alone and says the orders are missing, in days and in the 4-hour history; a file without such rows is not missing (Sol, round 2)', async () => {
  let served: unknown = null;
  const r = absentHistory(() => served ?? { fail: 404 });
  for (const [from, label, bucket] of [[r.day, 'days', 10], [r.wideFrom, '4-hour history', 9]] as const) {
    const both = view({ liq: true, stops: true, group: 'profitable' }), beside = view({ liq: true, takes: true, group: 'profitable' });
    await r.ask(both, r.now, from); await r.ask(beside, r.now, from); await r.ask(MINE_STOPS, r.now, from);
    assert.ok(r.h.shape(both).edges, `${label}: not loading`);
    const s = r.h.series(from, r.now, both);
    assert.ok(s.rows.length > 0, `${label}: their liquidations drawn`); assert.equal(s.rows.at(-1)!.long[bucket], 100, `${label}: alone`);
    assert.ok(s.ordersAbsent, `${label}: and the stops said missing`);
    const b = r.h.series(from, r.now, beside);
    assert.ok(b.rows.length > 0 && b.ordersAbsent, `${label}: take profits beside their liquidations are said missing`); assert.deepEqual(b.takes, []);
    const alone = r.h.series(from, r.now, MINE_STOPS);
    assert.deepEqual(alone.rows, [], `${label}: stops alone draw nothing`); assert.ok(r.h.ordersAbsent(MINE_STOPS, from, r.now), `${label}: and say why`);
  }
  // A day file that holds no row of theirs (a 200): not missing, so Liq + stops keeps saying no snapshot has both.
  served = { groups: ['profitable'], kinds: ['stops', 'takes'], rows: [] };
  const both = view({ liq: true, stops: true, group: 'profitable' });
  await r.ask(both, r.now + 6 * 60_000);
  const s = r.h.series(r.day, r.now, both);
  assert.deepEqual(s.rows, [], 'no snapshot with both parts'); assert.ok(!s.ordersAbsent, 'and nothing missing');
});

test('the Depth pane\'s Range summary says the profitable traders\' orders are missing beside what it sums, never as a stretch without snapshots (Sol, round 2)', async () => {
  const r = absentHistory(() => ({ fail: 503, retryAfter: 300 })), summary = new DepthRangeSummary(), sel = { t0: r.t - 600_000, t1: r.t + 1_800_000, p0: null, p1: null, live: false, draft: false };
  const held = (v: LiqView, rows: NonNullable<DepthPaneHeld['rows']>, absent: boolean): DepthPaneHeld => ({ key: depthHeldKey('liq', [], [0.01], viewKey(v)), source: 'liq', ids: [], t0: r.day, t1: r.now, w: 100, radii: [0.01],
    bid: new Float32Array(100), ask: new Float32Array(100), bidCoin: new Float32Array(100), askCoin: new Float32Array(100), present: null, centred: null, stepMs: 0, answeredAt: Infinity,
    rows, buckets: [20], omitted: [], view: v, holdMs: LIQ_HOLD_MS, wide: false, coins: false, coin: 'BTC', focus: 0, ordersAbsent: absent });
  const both = view({ liq: true, stops: true, group: 'profitable' });
  await r.ask(both, r.now);
  const s = r.h.series(r.day, r.now, both), mine = held(both, s.rows, s.ordersAbsent), lines = summary.lines(sel, mine, true, mine.key, r.now);
  assert.ok(lines.some(l => l.key === 'dp-absent' && l.cells[0] === ordersAbsent()), 'said beside what is summed');
  assert.ok(lines.some(l => l.key === 'dp-grid'), 'their liquidations summed');
  const alone = held(MINE_STOPS, [], true), none = summary.lines(sel, alone, true, alone.key, r.now);
  assert.ok(none.some(l => l.key === 'dp-absent'), 'stops alone: said');
  assert.ok(!none.some(l => l.key === 'dp-empty'), 'not as a selection without snapshots');
  const empty = held(MINE_STOPS, [], false);
  assert.ok(summary.lines(sel, empty, true, empty.key, r.now).some(l => l.key === 'dp-empty' && /No stop levels snapshot/.test(l.cells[0] ?? '')), 'a file without their rows keeps the old words');
});

test('the profitable traders\' orders\' history is read only from a file that names them, by their place, and refused whole otherwise (Sol, round 2)', () => {
  const kinds = ['stops', 'takes'], mine = (g: number[]): unknown[] => plusRow(g[0]!, part({ 20: [g[1]!, 0] }), part({ 30: [0, g[1]!] }));
  const read = (doc: unknown) => readHistRows(doc, EDGES.length, 'orderGroups');
  // As the levels service writes it: their cells, stops then take profits, at their place among the groups named.
  const ok = read({ v: 1, coin: 'BTC', groups: ['profitable'], kinds, rows: [mine([2, 7]), mine([1, 5])] })!;
  assert.deepEqual(ok.map(r => [r.fetchedAt, r.parts[0]!.long[20], r.parts[1]!.short[30]]), [[1, 5, 5], [2, 7, 7]], 'read, ordered by fetch time');
  const second = read({ groups: ['other', 'profitable'], kinds, rows: [[1, 1, 1, 100_000, part({ 20: [1, 0] }), part({}), part({ 20: [9, 0] }), part({ 30: [0, 8] })]] })!;
  assert.deepEqual([second[0]!.parts[0]!.long[20], second[0]!.parts[1]!.short[30]], [9, 8], 'the cells at their place, the other group\'s left unread');
  // Everyone's file (no group named), a file of everyone (`all`), of another group, of other kinds, or of kinds in another order: refused whole.
  const rows = [mine([1, 5])];
  assert.equal(read({ kinds, rows }), null, 'everyone\'s trigger history names no group');
  assert.equal(read({ groups: ['all'], kinds, rows }), null, 'everyone is not the profitable traders');
  assert.equal(read({ groups: ['other'], kinds, rows }), null);
  assert.equal(read({ groups: 'profitable', kinds, rows }), null);
  assert.equal(read({ groups: ['profitable', 'profitable'], kinds, rows }), null, 'named twice: no place');
  assert.equal(read({ groups: ['profitable'], rows }), null, 'no kinds');
  assert.equal(read({ groups: ['profitable'], kinds: ['takes', 'stops'], rows }), null, 'the kinds in another order');
  assert.equal(read({ groups: ['profitable'], kinds: ['stops'], rows }), null);
  // A valid row beside a malformed one: nothing of the file, never part of it.
  for (const bad of [[3, 3, 3, 100_000, part({}), [0, 0, [1], [2]]], [3, 3, 3, 100_000, part({})], [3, 3, 3, 0, part({}), part({})], [3, 'x', 3, 100_000, part({}), part({})], [3, 3, 3, 100_000, part({}), part({}), part({})],
    [3, 3, 3, 100_000, part({}), [-1, 0, zeros(), zeros()]], 'row']) {
    assert.equal(read({ groups: ['profitable'], kinds, rows: [mine([1, 5]), bad] }), null, JSON.stringify(bad).slice(0, 60));
  }
  assert.deepEqual(read({ groups: ['profitable'], kinds, rows: [] }), [], 'a day without their rows is read, empty');
  // The rollup: the same rule.
  assert.equal(readRollup({ hours: 4, edges: ROLLUP_EDGES, kinds, rows: [plusRow(5, part({ 9: [1, 2] }, 13), part({}, 13))] }, 'orderGroups'), null, 'everyone\'s rollup is not theirs');
  assert.equal(readRollup({ hours: 4, edges: ROLLUP_EDGES, groups: ['profitable'], kinds, rows: [plusRow(5, part({ 9: [1, 2] }, 13), part({}, 13))] }, 'orderGroups')!.rows.length, 1);
});

test('the history never draws a file of everyone\'s orders, or a partly malformed one, under the profitable traders\' name, in days or in the 4-hour history (Sol, round 2)', async () => {
  const f = familyHistory();
  // Everyone's day and rollup where theirs are asked for (no group named), and their day with a malformed row beside a valid one.
  f.put(U.triggersGroupsDay(dayText(f.day)), { kinds: ['stops', 'takes'], rows: [plusRow(f.t, part({ 20: [1_000, 1_000] }), part({ 30: [1_000, 1_000] }))] });
  f.put(U.rollup.triggersGroups, { hours: 4, edges: ROLLUP_EDGES, groups: ['all'], kinds: ['stops', 'takes'], rows: [plusRow(f.t, part({ 9: [1_000, 1_000] }, 13), part({ 9: [1_000, 1_000] }, 13))] });
  f.put(U.triggersGroupsDay(dayText(f.day - DAY_MS)), { groups: ['profitable'], kinds: ['stops', 'takes'], rows: [plusRow(f.t - DAY_MS, part({ 20: [5, 5] }), part({})), [1, 2, 3, 100_000, part({}), [0, 0, [1], [2]]]] });
  for (const [from, label] of [[f.day - DAY_MS, 'days'], [f.wideFrom, '4-hour history']] as const) {
    const stops = view({ liq: false, stops: true, group: 'profitable' }), both = view({ liq: true, stops: true, takes: true, group: 'profitable' });
    await f.ask(stops, from); await f.ask(both, from);
    assert.deepEqual(f.h.series(from, f.now, stops).rows, [], `${label}: nothing of everyone's stops, nothing of a partly malformed file`);
    const s = f.h.series(from, f.now, both);
    assert.deepEqual(s.rows, [], `${label}: no snapshot with both their liquidations and their stops`); assert.deepEqual(s.takes, [], `${label}: no take profits`);
  }
});

test('a saved levels setting in the older form with a switch that is not a boolean is the free view, in settings and in layouts (Sol, round 2)', () => {
  const on = { on: true, column: true }, free = { ...on, liq: true, stops: false, takes: false, group: 'all', split: 'none' };
  assert.deepEqual(readLiqLevels({ kind: 'stops', takes: 'invalid', group: 'profitable' }), free, 'Sol\'s case: was the profitable traders\' stops');
  assert.deepEqual(readLiqLevels({ kind: 'liq', takes: 1, group: 'profitable' }), free);
  assert.deepEqual(readLiqLevels({ kind: 'both', takes: null }), free);
  assert.deepEqual(readLiqLevels({ kind: 'both', takes: true, liq: 'yes' }), free, 'a switch of the newer form beside the older one');
  assert.deepEqual(readLiqLevels({ kind: 'stops', takes: false, group: 'profitable' }), { ...on, liq: false, stops: true, takes: false, group: 'profitable', split: 'none' }, 'booleans: read as before');
  assert.deepEqual(readLiqLevels({ kind: 'stops', group: 'profitable' }), { ...on, liq: false, stops: true, takes: false, group: 'profitable', split: 'none' }, 'a missing switch is off');
  assert.deepEqual(readSettings({ liqLevels: { kind: 'stops', takes: 'invalid', group: 'profitable' } }).liqLevels, free, 'nor in a saved page');
  assert.deepEqual(carriedSettings({ liqLevels: { kind: 'stops', takes: 'invalid', group: 'profitable' } } as never).liqLevels, free, 'nor through a layout');
  assert.deepEqual(carriedSettings({ liqLevels: { kind: 'both', takes: 0 } } as never).liqLevels, free);
});

// Sol's review, round 3.

/**
 * A stand-in page for one pane in Node: elements that keep their classes, text and children, a 2D context that draws nothing, and the page's
 * timers held for the test to run, so a frame can be drawn without the second's tick (as the page does after a change of the setting). The
 * Liq tab's range is `range` (±10% unless said), its ladder `height` high.
 */
function standInPage(width = 390, drawn?: { texts: { t: string; x: number; y: number }[]; lines: { x: number; y: number }[]; rects?: { x: number; y: number; w: number; h: number }[] }, range = '0.1', height = 640) {
  const g = globalThis as unknown as Record<string, unknown>, saved = { document: g.document, window: g.window, ResizeObserver: g.ResizeObserver };
  // Draws nothing; given `drawn`, it keeps the texts, the line ends and the outlined boxes drawn, and measures a text at 6 px a character.
  const ctx: unknown = new Proxy(function () { /* draws nothing */ }, { get: (_t, k) => k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined
    : drawn && k === 'fillText' ? (t: unknown, x: number, y: number) => { drawn.texts.push({ t: String(t), x, y }); return ctx; }
    : drawn && k === 'lineTo' ? (x: number, y: number) => { drawn.lines.push({ x, y }); return ctx; }
    : drawn && k === 'strokeRect' ? (x: number, y: number, w: number, h: number) => { drawn.rects?.push({ x, y, w, h }); return ctx; }
    : drawn && k === 'measureText' ? (t: unknown) => ({ width: String(t).length * 6 }) : ctx, apply: () => ctx, set: () => true });
  class StandIn {
    children: (StandIn | string)[] = []; dataset: Record<string, string> = {}; style: Record<string, string> = {}; className = ''; hidden = false;
    clientWidth = width; clientHeight = height; width = 0; height = 0;
    #text: string | null = null;
    constructor(readonly tagName: string) {}
    #classes(): string[] { return this.className.split(/\s+/).filter(Boolean); }
    readonly classList = {
      add: (...names: string[]): void => { this.className = [...new Set([...this.#classes(), ...names])].join(' '); },
      remove: (...names: string[]): void => { this.className = this.#classes().filter(c => !names.includes(c)).join(' '); },
      toggle: (name: string, on?: boolean): boolean => { const want = on ?? !this.#classes().includes(name); if (want) this.classList.add(name); else this.classList.remove(name); return want; },
      contains: (name: string): boolean => this.#classes().includes(name),
    };
    get textContent(): string { return this.#text ?? this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
    set textContent(value: string) { this.#text = String(value); this.children = []; }
    append(...nodes: (StandIn | string)[]): void { this.children.push(...nodes); }
    setAttribute(): void { /* not read */ }
    getAttribute(): null { return null; }
    readonly listeners = new Map<string, ((e: unknown) => void)[]>();
    addEventListener(type: string, fn: (e: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    /** The first element at or below this one with the tag `tag`. */
    findTag(tag: string): StandIn | null {
      if (this.tagName.toLowerCase() === tag) return this;
      for (const c of this.children) { const hit = typeof c === 'string' ? null : c.findTag(tag); if (hit) return hit; }
      return null;
    }
    removeEventListener(): void { /* no events */ }
    closest(): null { return null; }
    querySelector(): null { return null; }
    getContext(): unknown { return ctx; }
    getBoundingClientRect(): { top: number; left: number; width: number; height: number } { return { top: 0, left: 0, width: this.clientWidth, height: this.clientHeight }; }
    setPointerCapture(): void { /* no pointer */ }
    /** The first element at or below this one holding every class of `names`. */
    find(names: string): StandIn | null {
      if (names.split(' ').every(n => this.#classes().includes(n))) return this;
      for (const c of this.children) { const hit = typeof c === 'string' ? null : c.find(names); if (hit) return hit; }
      return null;
    }
  }
  const timeouts = new Map<number, () => void>(), intervals = new Map<number, () => void>();
  let ids = 0;
  g.document = { createElement: (tag: string) => new StandIn(tag), addEventListener() { /* none */ }, removeEventListener() { /* none */ }, hidden: false };
  g.window = { devicePixelRatio: 1, localStorage: { getItem: (key: string) => key === 'hlm-liq-range' ? range : null, setItem() { /* kept nowhere */ }, removeItem() { /* kept nowhere */ } },
    setTimeout: (fn: () => void) => { timeouts.set(++ids, fn); return ids; }, clearTimeout: (id: number) => { timeouts.delete(id); },
    setInterval: (fn: () => void) => { intervals.set(++ids, fn); return ids; }, clearInterval: (id: number) => { intervals.delete(id); } };
  g.ResizeObserver = class { observe(): void { /* sized once */ } disconnect(): void { /* nothing held */ } };
  const parent = new StandIn('div');
  return {
    parent,
    /** The frames waiting (the pane's `invalidate`), not the tick. */
    frames(): void { for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn(); } },
    /** The second's tick. */
    tick(): void { for (const fn of [...intervals.values()]) fn(); },
    text: (names: string): string | undefined => parent.find(names)?.textContent,
    restore(): void { g.document = saved.document; g.window = saved.window; g.ResizeObserver = saved.ResizeObserver; },
  };
}
/** A pass the page reads as one in force until `exp` (its signature is the server's business). */
const standInPass = (exp: number): string => `v1.${Buffer.from(JSON.stringify({ sub: 'standin', exp })).toString('base64url')}.sig`;
/** Both families' levels around the price (100): stops of longs at [90, 100) and of shorts at [100, 110), everyone's ten times theirs. */
const NEAR = {
  all: { liq: [[9, 0, 100, 0, 0, 5, 0, 100, 0]], stops: [[9, 100, 0, 0, 0, 5, 0, 100, 0], [10, 0, 0, 100, 0, 0, 5, 0, 100]], takes: [[10, 100, 0, 0, 0, 5, 0, 100, 0]] },
  profitable: { liq: [[9, 0, 10, 0, 0, 1, 0, 10, 0]], stops: [[9, 10, 0, 0, 0, 1, 0, 10, 0], [10, 0, 0, 10, 0, 0, 1, 0, 10]], takes: [[10, 10, 0, 0, 0, 1, 0, 10, 0]] },
};

test('the phone\'s Liq tab draws a new choice from its first frame, never the last tick\'s source under the new caption, both ways (Sol, round 3)', async () => {
  const page = standInPage(), now = Date.now();
  plus().accept({ key: 'standin-key-0123456789', pass: standInPass(now + 23 * 3_600_000), until: now + 20 * DAY_MS });
  try {
    const s = service({ [U.groups]: { status: 200, body: groups(NEAR.profitable.liq, null) }, [U.triggers]: { status: 200, body: triggers(NEAR.all.stops, NEAR.all.takes) },
      [U.triggersGroups]: { status: 200, body: triggerGroups(NEAR.profitable.stops, NEAR.profitable.takes) } }, { value: 'v1.pass.sig' }, () => free(NEAR.all.liq));
    const store = new Store(initialState());
    const choose = (group: 'all' | 'profitable'): void => store.set({ liqLevels: { ...store.state.liqLevels, liq: false, stops: true, takes: false, group } });
    const settle = async (): Promise<void> => { for (let i = 0; i < 3; i++) { page.tick(); await tick(); } page.frames(); };
    choose('all');
    const pane = new LiqPane(page.parent as never, store, { liqLevels: s.src } as never);
    pane.setShown(true);
    await settle();
    // Both families held, as after a visit to each.
    choose('profitable'); await settle(); choose('all'); await settle();
    assert.equal(page.text('liq-sub'), 'BTC · Hyperliquid'); assert.equal(page.text('liq-usd long'), '$100');
    // The choice changes: the page draws the tab again at once (main.ts), before the next tick.
    choose('profitable'); pane.invalidate(); page.frames();
    assert.equal(page.text('liq-sub'), 'Profitable traders · BTC · Hyperliquid');
    assert.equal(page.text('liq-usd long'), '$10', 'their stops below the price from the first frame');
    assert.equal(page.text('liq-usd short'), '$10', 'and above it');
    choose('all'); pane.invalidate(); page.frames();
    assert.equal(page.text('liq-sub'), 'BTC · Hyperliquid'); assert.equal(page.text('liq-usd long'), '$100', 'everyone\'s again from the first frame');
    pane.setShown(false);
  } finally { plus().forget(); page.restore(); }
});

/** A history reader over `files` (by path on the levels host), each ask counted; anything not there answers 404. */
function historyOf(files: Record<string, unknown>, day: number) {
  const host = (u: string): string => u.replace(/^https?:\/\/[^/]+/, 'https://levels.hiverust.dev'), asks = new Map<string, number>(), held: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(files)) held[host(k)] = v;
  const h = new LiqHistory(url => { asks.set(url, (asks.get(url) ?? 0) + 1); return url in held ? Promise.resolve(held[url]) : Promise.reject(new Error('404')); },
    { freeFrom: () => day - 7 * DAY_MS, pass: () => 'v1.member.sig', refused: () => {} });
  return { h, put: (u: string, body: unknown): void => { held[host(u)] = body; }, asks: (u: string): number => asks.get(host(u)) ?? 0 };
}

test('a day whose profitable orders are missing still says so after midnight, while its last snapshot is in force (Sol, round 3)', async () => {
  const day = Date.UTC(2026, 10, 15), yesterday = day - DAY_MS, late = day - 10 * MIN, now = day + 30 * MIN, t0 = day + 5 * MIN, t1 = day + 20 * MIN;
  const kinds = ['stops', 'takes'];
  // Yesterday's orders are not on the server (404); today's are a valid file with no row yet; yesterday's 23:50 liquidations are in force at 00:05.
  const { h } = historyOf({
    'https://x/v1/btc/liquidation-history.json': { edges: EDGES, first: yesterday - DAY_MS, last: now - 60_000 },
    [U.groupsDay(dayText(yesterday))]: { groups: ['profitable'], rows: [plusRow(late, part({ 10: [100, 100] }), null)] },
    [U.groupsDay(dayText(day))]: { groups: ['profitable'], rows: [] },
    [U.triggersGroupsDay(dayText(day))]: { groups: ['profitable'], kinds, rows: [] },
  }, day);
  const both = view({ liq: true, stops: true, group: 'profitable' }), stops = view({ liq: false, stops: true, group: 'profitable' });
  for (const v of [both, stops]) for (let i = 0; i < 3; i++) { h.ensure(t0, t1, now, () => {}, v); await tick(); await tick(); }
  const s = h.series(t0, t1, both);
  assert.deepEqual(s.rows.map(r => r.fetchedAt), [late], 'yesterday\'s liquidations alone, in force after midnight');
  assert.ok(s.ordersAbsent, 'and the missing orders said there');
  const alone = h.series(t0, t1, stops);
  assert.deepEqual(alone.rows, []); assert.ok(!alone.ordersAbsent, 'their stops alone: nothing of the missing day stands in the stretch, and the day it lies on has its file');
  // Past the hold of yesterday's last snapshot, only today counts.
  assert.ok(!h.series(day + 3 * 3_600_000, day + 4 * 3_600_000, both).ordersAbsent, 'a stretch no snapshot of yesterday reaches');
});

test('a wide view whose rollup could not be read says so instead of loading, keeps asking, and draws once a valid file comes (Sol, round 3)', async () => {
  const f = familyHistory(), both = view({ liq: true, stops: true, group: 'profitable' }), roll = U.rollup.triggersGroups;
  const asks = new Map<string, number>(), count = (u: string): number => asks.get(u.replace(/^https?:\/\/[^/]+/, 'https://levels.hiverust.dev')) ?? 0;
  // Everyone's rollup where theirs is asked for (no group named): refused whole, every time it is read.
  f.put(roll, { hours: 4, edges: ROLLUP_EDGES, kinds: ['stops', 'takes'], rows: [plusRow(f.t, part({ 9: [1_000, 1_000] }, 13), part({}, 13))] });
  const h = new LiqHistory(url => { asks.set(url, (asks.get(url) ?? 0) + 1); return url in f.files ? Promise.resolve(f.files[url]) : Promise.reject(new Error('404')); },
    { freeFrom: () => f.day - 7 * DAY_MS, pass: () => 'v1.member.sig', refused: () => {} });
  const ask = async (now: number): Promise<void> => { for (let i = 0; i < 3; i++) { h.ensure(f.wideFrom, f.now, now, () => {}, both); await tick(); await tick(); } };
  await ask(f.now);
  assert.equal(h.shape(both).edges, null, 'nothing to draw from');
  assert.equal(h.shape(both).failed, 'orderGroups', 'their orders\' rollup could not be read: said, not loading');
  assert.equal(readFailed(h.shape(both).failed!, both), 'Stop levels could not be read.');
  assert.equal(readFailed('orderGroups', view({ liq: true, takes: true, group: 'profitable' })), 'Take-profit levels could not be read.');
  assert.equal(readFailed('groups', both), 'Liquidation levels could not be read.');
  const first = count(roll);
  await ask(f.now + 61_000);
  assert.equal(count(roll), first + 1, 'asked again a minute on'); assert.equal(h.shape(both).failed, 'orderGroups');
  // Their own rollup comes: drawn, nothing failed.
  f.put(roll, { hours: 4, edges: ROLLUP_EDGES, groups: ['profitable'], kinds: ['stops', 'takes'], rows: [plusRow(f.t, part({ 9: [100, 100] }, 13), part({}, 13))] });
  await ask(f.now + 122_000);
  assert.equal(h.shape(both).failed, null); assert.ok(h.shape(both).edges);
  assert.equal(h.series(f.wideFrom, f.now, both).rows.at(-1)!.long[9], 200, 'their liquidations and stops added');
});

/** The page's `fetch` answering each address as `answer` says (a status, a JSON body, a Retry-After header), each ask counted, until `restore`. */
function stubFetch(answer: (url: string) => { status: number; body?: unknown; retryAfter?: string }) {
  const real = globalThis.fetch, asks = new Map<string, number>();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asks.set(url, (asks.get(url) ?? 0) + 1);
    const a = answer(url);
    return new Response(a.body === undefined ? 'not there' : JSON.stringify(a.body), { status: a.status, headers: a.retryAfter === undefined ? {} : { 'retry-after': a.retryAfter } });
  }) as typeof fetch;
  return { asks: (url: string): number => asks.get(url) ?? 0, restore: (): void => { globalThis.fetch = real; } };
}
const inMinutes = (m: number): string => new Date(Date.now() + m * MIN).toUTCString();

test('a Retry-After header is read as delta-seconds or an HTTP date, and anything else as none (Sol, round 3)', async () => {
  let header: string | undefined;
  const stub = stubFetch(() => ({ status: 503, ...(header === undefined ? {} : { retryAfter: header }) }));
  try {
    const read = async (h: string | undefined): Promise<number | undefined> => { header = h; return (await webFetch('https://levels.hiverust.dev/v1/plus/btc/triggers-groups.json')).retryAfter; };
    const near = (got: number | undefined, want: number, what: string): void => assert.ok(got !== undefined && Math.abs(got - want) <= 2, `${what}: ${got} for ${want}`);
    near(await read(inMinutes(10)), 600, 'an HTTP date ten minutes on');
    near(await read('120'), 120, 'delta-seconds');
    near(await read(' 300 '), 300, 'delta-seconds with spaces around');
    assert.equal(await read('0'), 0, 'now: the caller\'s shortest wait applies');
    assert.equal(await read(new Date(Date.now() - 60_000).toUTCString()), 0, 'a date already past: now');
    assert.equal(await read(new Date(Date.now() + 600_000).toUTCString().replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (.+) GMT$/, (_m, d, n, mo, y, t) => `${({ Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' } as Record<string, string>)[d]}, ${n}-${mo}-${String(y).slice(2)} ${t} GMT`)), undefined, 'the obsolete RFC 850 form: its two-digit year names no century, so none');
    for (const bad of ['0x10', '1e3', '10.5', '-5', '1 2', 'soon', '', 'Wed, 21 Oct 2015 07:28:00']) assert.equal(await read(bad), undefined, `${JSON.stringify(bad)} is not a Retry-After`);
    assert.equal(await read(undefined), undefined, 'none said');
    assert.equal(retryAfterSeconds('Wed Oct 21 07:28:00 2015', Date.UTC(2015, 9, 21, 7, 18)), 600, 'asctime, read as GMT');
  } finally { stub.restore(); }
});

test('the profitable traders\' live orders, days and rollup wait what an HTTP-date Retry-After says, not the five-minute fallback (Sol, round 3)', async () => {
  const day = Date.UTC(2026, 10, 15), wideFrom = day + 12 * 3_600_000 - (MAX_DAYS + 10) * DAY_MS;
  const tooBusy = (url: string): boolean => /triggers-groups|trigger-history-groups/.test(url);
  const stub = stubFetch(url => tooBusy(url) ? { status: 503, retryAfter: inMinutes(10) }
    : /liquidation-history\.json$/.test(url) ? { status: 200, body: { edges: EDGES, first: day - 3 * DAY_MS, last: day + 12 * 3_600_000 } }
    : /liquidation-history-groups-4h/.test(url) ? { status: 200, body: { hours: 4, edges: ROLLUP_EDGES, groups: ['profitable'], rows: [] } }
    : /liquidation-history-groups\//.test(url) ? { status: 200, body: { groups: ['profitable'], rows: [] } } : { status: 404 });
  try {
    // Live: the source's own read (`webFetch`), its clock moved by the test.
    let now = AS_OF + 45 * MIN;
    const src = new LiqLevelsSource(async url => url.includes('hyperliquid') ? [] : free(FAM.all.liq), () => now, () => LEVELS_URL, undefined, { pass: () => 'v1.pass.sig', refused: () => {} });
    const mine = view({ liq: false, stops: true, group: 'profitable' }), live = (): number => stub.asks(U.triggersGroups);
    for (let i = 0; i < 3; i++) { src.ensure(BTC, () => {}, mine); await tick(); await tick(); }
    assert.equal(live(), 1); assert.ok(src.ordersAbsent());
    now += 5 * MIN + 1_000; src.ensure(BTC, () => {}, mine); await tick();
    assert.equal(live(), 1, 'live: not asked again at the fallback\'s five minutes');
    now += 5 * MIN; src.ensure(BTC, () => {}, mine); await tick();
    assert.equal(live(), 2, 'live: asked again once the ten minutes are over');
    // Days and the rollup: the history's own read.
    for (const [from, url] of [[day, `https://levels.hiverust.dev/v1/plus/btc/trigger-history-groups/${dayText(day)}.json`], [wideFrom, 'https://levels.hiverust.dev/v1/plus/btc/trigger-history-groups-4h.json']] as const) {
      const h = new LiqHistory(undefined, { freeFrom: () => day - 7 * DAY_MS, pass: () => 'v1.member.sig', refused: () => {} }), at = day + 12 * 3_600_000;
      const ask = async (when: number): Promise<void> => { for (let i = 0; i < 3; i++) { h.ensure(from, day + 12 * 3_600_000, when, () => {}, mine); await tick(); await tick(); await tick(); } };
      await ask(at);
      const asked = stub.asks(url);
      assert.ok(asked >= 1 && h.ordersAbsent(mine, from, day + 12 * 3_600_000), url);
      await ask(at + 5 * MIN + 1_000);
      assert.equal(stub.asks(url), asked, `${url}: not asked again at five minutes`);
      await ask(at + 10 * MIN + 2_000);
      assert.equal(stub.asks(url), asked + 1, `${url}: asked again after ten`);
    }
  } finally { stub.restore(); }
});

test('a split is saved with the levels: absent reads as none, liquidations beside stops needs both, everyone beside the profitable traders needs one of them, on every write', () => {
  const on = { on: true, column: true };
  assert.equal(readLiqLevels({ liq: true, stops: true }).split, 'none', 'a save from before the split');
  assert.equal(readLiqLevels({ liq: true, stops: true, split: 'sideways' }).split, 'none', 'anything else');
  assert.deepEqual(readLiqLevels({ liq: true, stops: true, takes: true, group: 'profitable', split: 'kinds' }), { ...on, liq: true, stops: true, takes: true, group: 'profitable', split: 'kinds' });
  assert.equal(readLiqLevels({ liq: true, stops: false, split: 'kinds' }).split, 'none', 'liquidations beside stops with one of them off: none');
  assert.equal(readLiqLevels({ kind: 'both', split: 'kinds' }).split, 'kinds', 'an older form of both kinds keeps it');
  assert.equal(readLiqLevels({ liq: false, stops: true, split: 'groups' }).split, 'groups');
  assert.equal(readLiqLevels({ liq: false, stops: false, takes: true, split: 'groups' }).split, 'none', 'take profits alone are never split');
  assert.equal(readLiqLevels({ liq: 'x', stops: true, split: 'kinds' }).split, 'none', 'a malformed choice is the free view');
  // Every write goes through the reader: a kind switched off returns the split to none, whoever writes it.
  const store = new Store(initialState());
  store.set({ liqLevels: { ...store.state.liqLevels, liq: true, stops: true, split: 'kinds' } });
  assert.equal(store.state.liqLevels.split, 'kinds');
  store.set({ liqLevels: { ...store.state.liqLevels, stops: false } });
  assert.equal(store.state.liqLevels.split, 'none', 'stops off: none');
  assert.equal(carriedSettings({ liqLevels: { liq: true, stops: false, split: 'kinds' } } as never).liqLevels?.split, 'none', 'nor through a layout');
});

test('the pair a split draws, the one series everywhere else, and a split without Plus held back', () => {
  const kinds = readLiqLevels({ liq: true, stops: true, takes: true, group: 'profitable', split: 'kinds' });
  assert.deepEqual(splitPair(kinds, true), { split: 'kinds', left: { liq: true, stops: false, takes: true, group: 'profitable' }, right: { liq: false, stops: true, takes: false, group: 'profitable' } },
    'liquidations then stops, of the chosen traders; take profits with the left one');
  assert.deepEqual(effectiveView(kinds, true), { liq: true, stops: false, takes: true, group: 'profitable' }, 'one series: the left column\'s set');
  const groups = readLiqLevels({ liq: true, stops: true, takes: true, group: 'profitable', split: 'groups' });
  assert.deepEqual(splitPair(groups, true), { split: 'groups', left: { liq: true, stops: true, takes: true, group: 'all' }, right: { liq: true, stops: true, takes: false, group: 'profitable' } },
    'everyone then the profitable traders, of the chosen kinds; the saved group is not drawn');
  assert.deepEqual(effectiveView(groups, true), { liq: true, stops: true, takes: true, group: 'all' }, 'one series: everyone\'s, never a hidden group');
  assert.equal(splitPair(groups, false), null, 'no Plus: nothing split');
  assert.deepEqual(effectiveView(groups, false), FREE_VIEW);
  assert.equal(effectiveSplit(groups, false), 'none');
  const liqOnly = readLiqLevels({ liq: true, split: 'groups' });
  assert.ok(effectiveView(liqOnly, true).group === 'all' && isFreeChoice(effectiveView(liqOnly, true)), 'the left set of a split can look free');
  assert.ok(!isFreeChoice(liqOnly) && heldBack(liqOnly, false), 'but the split is Plus: held back without it, kept, shown locked');
  assert.notEqual(pairKey(splitPair(kinds, true)), pairKey(splitPair(groups, true)));
  assert.equal(pairKey(null), '');
});

test('a split asks for both columns\' files together, each once, and the right column of the profitable traders never borrows everyone\'s orders', async () => {
  const pass = { value: 'v1.pass.sig' as string | null };
  const MINE_STOPS = [[9, 40, 0, 0, 0, 1, 0, 40, 0]];
  // Everyone beside the profitable traders, liquidations and stops: the free file, the groups' and both orders' files, each once.
  const s = service({ [U.groups]: { status: 200, body: groups([[7, 0, 50, 0, 0, 1, 0, 50, 0]], null) }, [U.triggers]: { status: 200, body: triggers(STOPS, TAKES) }, [U.triggersGroups]: { status: 200, body: triggerGroups(MINE_STOPS, TAKES) } }, pass);
  const pair = splitPair(readLiqLevels({ liq: true, stops: true, split: 'groups' }), true)!;
  s.src.ensure(BTC, () => {}, pair.left, pair.right); await tick(); s.src.ensure(BTC, () => {}, pair.left, pair.right); await tick();
  const urls = s.asked.map(a => a.url);
  for (const u of [U.groups, U.triggers, U.triggersGroups]) assert.equal(urls.filter(x => x === u).length, 1, u);
  assert.equal(s.src.state, 'ready'); assert.equal(s.src.levels!.kind, 'both'); assert.deepEqual([...s.src.levels!.k], [8, 12], 'left: everyone\'s liquidations and stops');
  const right = s.src.right!;
  assert.equal(right.state, 'ready'); assert.equal(right.levels!.kind, 'both'); assert.deepEqual([...right.levels!.k], [7, 9], 'right: the profitable traders\' own');
  assert.ok(right.standing() && right.taken() && right.key() !== '' && right.key() !== s.src.key());
  // Liquidations beside stops of the profitable traders, their orders not on the server: the left column stands, the right says why.
  const absent = service({ [U.groups]: { status: 200, body: groups([[7, 0, 50, 0, 0, 1, 0, 50, 0]], null) }, [U.triggers]: { status: 200, body: triggers(STOPS, TAKES) } }, pass);
  const kinds = splitPair(readLiqLevels({ liq: true, stops: true, group: 'profitable', split: 'kinds' }), true)!;
  absent.src.ensure(BTC, () => {}, kinds.left, kinds.right); await tick(); absent.src.ensure(BTC, () => {}, kinds.left, kinds.right); await tick();
  assert.equal(absent.src.state, 'ready'); assert.deepEqual([...absent.src.levels!.k], [7], 'left: their liquidations');
  assert.equal(absent.src.right!.state, 'missing'); assert.equal(absent.src.right!.missing(), 'profitable-orders'); assert.equal(absent.src.right!.levels, null);
  assert.equal(liqWhy(absent.src.right!, null), ordersAbsent(), 'right: not available yet');
  assert.ok(!absent.asked.some(a => a.url === U.triggers), 'everyone\'s orders never asked for in their place');
  // No split again: no right column, nothing more asked.
  const before = absent.asked.length;
  absent.src.ensure(BTC, () => {}, kinds.left, null); await tick();
  assert.equal(absent.src.right, null); assert.equal(absent.asked.length, before);
});

test('every pane asks for a split the same way: the map and the Liq tab asking in turn change nothing, a new right column does', async () => {
  const pass = { value: 'v1.pass.sig' as string | null };
  const s = service({ [U.groups]: { status: 200, body: groups([[7, 0, 50, 0, 0, 1, 0, 50, 0]], null) }, [U.triggers]: { status: 200, body: triggers(STOPS, TAKES) } }, pass);
  const pair = splitPair(readLiqLevels({ liq: true, stops: true, split: 'kinds' }), true)!;
  // The map, then the Liq tab, then the map: one ask, the same view and right column each time (the files arrive meanwhile).
  for (let i = 0; i < 4; i++) { s.src.ensure(BTC, () => {}, pair.left, pair.right); await tick(); }
  assert.equal(s.src.state, 'ready'); assert.equal(s.src.right?.state, 'ready');
  const settled = s.src.version;
  for (let i = 0; i < 4; i++) s.src.ensure(BTC, () => {}, pair.left, pair.right);
  assert.equal(s.src.version, settled, 'asking again for the same changes nothing');
  s.src.ensure(BTC, () => {}, pair.left, null);
  assert.equal(s.src.version, settled + 1, 'no right column any more: one change');
  // Both panes ask through one helper, never with a view of their own.
  const read = (f: string): string => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  for (const f of ['src/app/panes/heat-pane.ts', 'src/app/panes/liq-pane.ts']) {
    const src = read(f);
    assert.match(src, /liveAsk\((?:state|this\.store\.state)\.liqLevels\)/, f);
    // Every ask passes the one series and the right column of the same ask, never a view of its own.
    const asks = src.match(/\.ensure\(currentCoin\(\)[^;]*;/g) ?? [];
    assert.equal(asks.length, 1, `${f}: one place that asks`);
    assert.match(asks[0]!, /, (?:ask|a)\.view, (?:ask|a)\.right\)/, f);
  }
});

// Sol's review, round 4.

test('the phone\'s Liq tab draws the view in force when a frame\'s ask for a Plus file finds the membership let go in another tab (Sol, round 4)', async () => {
  const page = standInPage(), now = Date.now();
  plus().accept({ key: 'standin-key-0123456789', pass: standInPass(now + 23 * 3_600_000), until: now + 20 * DAY_MS });
  try {
    // The groups file holds an older snapshot than the free file, so it is asked for again two minutes on, by whichever frame comes first; that
    // ask reads the membership again (Plus.pass) and finds it gone.
    let letGo = false;
    const access = { get value(): string { if (letGo) { letGo = false; plus().forget(); } return 'v1.pass.sig'; } };
    const s = service({ [U.groups]: { status: 200, body: groups(NEAR.profitable.liq, null, AS_OF) } }, access, () => free(NEAR.all.liq, AS_OF + 30 * MIN));
    const store = new Store(initialState());
    store.set({ liqLevels: { ...store.state.liqLevels, liq: true, stops: false, takes: false, group: 'profitable' } });
    const pane = new LiqPane(page.parent as never, store, { liqLevels: s.src } as never);
    pane.setShown(true);
    for (let i = 0; i < 3; i++) { page.tick(); await tick(); }
    page.frames();
    assert.equal(page.text('liq-sub'), 'Profitable traders · BTC · Hyperliquid'); assert.equal(page.text('liq-usd long'), '$10');
    letGo = true; s.at(s.now() + 2 * MIN + 1_000); pane.invalidate(); page.frames();
    assert.equal(page.text('liq-sub'), 'BTC · Hyperliquid', 'Plus gone: the free view');
    assert.equal(page.text('liq-usd long'), '$100', 'and everyone\'s levels under it in that same frame, never the profitable traders\'');
    pane.setShown(false);
  } finally { plus().forget(); page.restore(); }
});

test('a missing day\'s snapshot replaced before the stretch begins is not said: the complete one drawn is the next day\'s (Sol, round 4)', async () => {
  const day = Date.UTC(2026, 10, 15), yesterday = day - DAY_MS, late = day - 10 * MIN, first = day + MIN, now = day + 30 * MIN, t0 = day + 5 * MIN, t1 = day + 20 * MIN;
  const kinds = ['stops', 'takes'];
  // Yesterday's orders are not on the server (404); today's first snapshot, at 00:01, has their liquidations, stops and take profits.
  const { h } = historyOf({
    'https://x/v1/btc/liquidation-history.json': { edges: EDGES, first: yesterday - DAY_MS, last: now - 60_000 },
    [U.groupsDay(dayText(yesterday))]: { groups: ['profitable'], rows: [plusRow(late, part({ 10: [100, 100] }), null)] },
    [U.groupsDay(dayText(day))]: { groups: ['profitable'], rows: [plusRow(first, part({ 10: [50, 50] }), null)] },
    [U.triggersGroupsDay(dayText(day))]: { groups: ['profitable'], kinds, rows: [plusRow(first, part({ 20: [7, 7] }), part({ 30: [3, 3] }))] },
  }, day);
  const all = view({ liq: true, stops: true, takes: true, group: 'profitable' });
  for (let i = 0; i < 3; i++) { h.ensure(t0, t1, now, () => {}, all); await tick(); await tick(); }
  const s = h.series(t0, t1, all);
  assert.deepEqual(s.rows.map(r => r.fetchedAt), [first], 'today\'s complete snapshot alone is drawn');
  assert.deepEqual(s.takes!.map(r => r.fetchedAt), [first], 'and its take profits');
  assert.ok(!s.ordersAbsent, 'nothing of the missing day stands in 00:05-00:20: not said');
  // From midnight to 00:01 yesterday's last snapshot still stands (its liquidations alone): said there.
  assert.ok(h.series(day, day + 30_000, all).ordersAbsent, 'the half minute yesterday\'s snapshot is drawn');
});

test('an RFC 850 date, whose two-digit year names no century, is no Retry-After: the caller\'s own wait, never the 30-second floor of a year read as 1950 (Sol, round 4)', async () => {
  const now = Date.UTC(2026, 10, 19, 12);
  for (const year of ['50', '49', '26', '76', '00']) assert.equal(retryAfterSeconds(`Sunday, 06-Nov-${year} 08:49:37 GMT`, now), undefined, `-${year}`);
  assert.equal(retryAfterSeconds('Sun, 06 Nov 2050 08:49:37 GMT', now), (Date.UTC(2050, 10, 6, 8, 49, 37) - now) / 1_000, 'the same date with its four-digit year is read');
  // A 503 saying it so: the profitable traders' live orders wait the fallback's five minutes, not 30 seconds.
  const stub = stubFetch(url => /triggers-groups/.test(url) ? { status: 503, retryAfter: 'Sunday, 06-Nov-50 08:49:37 GMT' } : { status: 404 });
  try {
    let at = AS_OF + 45 * MIN;
    const src = new LiqLevelsSource(async url => url.includes('hyperliquid') ? [] : free(FAM.all.liq), () => at, () => LEVELS_URL, undefined, { pass: () => 'v1.pass.sig', refused: () => {} });
    const mine = view({ liq: false, stops: true, group: 'profitable' });
    for (let i = 0; i < 3; i++) { src.ensure(BTC, () => {}, mine); await tick(); await tick(); }
    assert.equal(stub.asks(U.triggersGroups), 1); assert.ok(src.ordersAbsent());
    at += 31_000; src.ensure(BTC, () => {}, mine); await tick();
    assert.equal(stub.asks(U.triggersGroups), 1, 'not asked again after 30 seconds');
    at += 5 * MIN; src.ensure(BTC, () => {}, mine); await tick();
    assert.equal(stub.asks(U.triggersGroups), 2, 'asked again after the fallback');
  } finally { stub.restore(); }
});

test('the phone\'s Liq tab under a split: halves at a phone\'s width, named by the split; narrower, what the split falls back to, said in the foot', async () => {
  for (const [width, split, title, sub, foot, long] of [
    [390, 'kinds', 'Liq | Stops', 'Profitable traders · BTC · Hyperliquid', null, '$10'],
    [300, 'kinds', 'Liq | Stops', 'Profitable traders · BTC · Hyperliquid', 'Too narrow to split: Liq + stops', '$20'],
    [300, 'groups', 'Everyone | Profitable', 'Liquidation and stop levels · BTC · Hyperliquid', 'Too narrow to split: Everyone', '$200'],
  ] as const) {
    const page = standInPage(width), now = Date.now();
    plus().accept({ key: 'standin-key-0123456789', pass: standInPass(now + 23 * 3_600_000), until: now + 20 * DAY_MS });
    try {
      const s = service({ [U.groups]: { status: 200, body: groups(NEAR.profitable.liq, null) }, [U.triggers]: { status: 200, body: triggers(NEAR.all.stops, NEAR.all.takes) },
        [U.triggersGroups]: { status: 200, body: triggerGroups(NEAR.profitable.stops, NEAR.profitable.takes) } }, { value: 'v1.pass.sig' }, () => free(NEAR.all.liq));
      const store = new Store(initialState());
      store.set({ liqLevels: { ...store.state.liqLevels, liq: true, stops: true, takes: false, group: 'profitable', split } });
      const pane = new LiqPane(page.parent as never, store, { liqLevels: s.src } as never);
      pane.setShown(true);
      for (let i = 0; i < 4; i++) { page.tick(); await tick(); }
      page.frames();
      const name = `${split} at ${width} px`;
      assert.equal(page.text('liq-title'), title, name); assert.equal(page.text('liq-sub'), sub, name);
      const said = page.text('liq-foot') ?? '';
      if (foot) assert.ok(said.startsWith(`${foot} · `), `${name}: ${said}`); else assert.ok(!said.includes('Too narrow'), `${name}: ${said}`);
      // The summary weighs what is drawn as one series: the left half (their liquidations), or the fallback (theirs added up; everyone's).
      assert.equal(page.text('liq-usd long'), long, name);
      pane.setShown(false);
    } finally { plus().forget(); page.restore(); }
  }
});

/** The phone's Liq tab at a phone's width with a split chosen, on the stand-in page; `files` are the Plus answers. */
async function tabWith(files: Record<string, LiqAnswer>, lv: Partial<import('../src/app/liq-url.ts').LiqLevelSettings>, freeDoc: () => unknown = () => free(NEAR.all.liq),
  drawn?: { texts: { t: string; x: number; y: number }[]; lines: { x: number; y: number }[]; rects?: { x: number; y: number; w: number; h: number }[] }, range?: string, height?: number) {
  const page = standInPage(390, drawn, range, height), now = Date.now();
  plus().accept({ key: 'standin-key-0123456789', pass: standInPass(now + 23 * 3_600_000), until: now + 20 * DAY_MS });
  const s = service(files, { value: 'v1.pass.sig' }, freeDoc);
  const store = new Store(initialState());
  store.set({ liqLevels: { ...store.state.liqLevels, ...lv } });
  const pane = new LiqPane(page.parent as never, store, { liqLevels: s.src } as never);
  pane.setShown(true);
  for (let i = 0; i < 4; i++) { page.tick(); await tick(); }
  page.frames();
  return { page, src: s.src, store, pane, done: (): void => { pane.setShown(false); plus().forget(); page.restore(); } };
}

test('Sol 2 (P2): the phone\'s right half says the profitable traders\' stops are not on the server, though their liquidations stand and are drawn', async () => {
  // Everyone | Profitable, liquidations and stops: the profitable traders' order files answer 404.
  const t = await tabWith({ [U.groups]: { status: 200, body: groups(NEAR.profitable.liq, null) }, [U.triggers]: { status: 200, body: triggers(NEAR.all.stops, NEAR.all.takes) } },
    { liq: true, stops: true, takes: false, group: 'all', split: 'groups' });
  try {
    const right = t.src.right!;
    assert.equal(right.state, 'ready', 'their liquidations stand'); assert.equal(right.ordersAbsent(), true);
    assert.equal(t.page.text('liq-title'), 'Everyone | Profitable');
    assert.ok((t.page.text('liq-foot') ?? '').includes(ordersAbsent()), `the foot says so: ${t.page.text('liq-foot')}`);
    assert.equal(t.page.text('liq-usd long'), '$200', 'the summary is everyone\'s, the left half');
  } finally { t.done(); }
});

test('Sol 3 (P2): the phone\'s halves stand on their own: everyone\'s stops loading never hide the profitable traders\' half that is ready', async () => {
  // Everyone | Profitable, stops alone: everyone's order file answers 503, the profitable traders' own answers.
  const t = await tabWith({ [U.triggers]: { status: 503, body: null }, [U.triggersGroups]: { status: 200, body: triggerGroups(NEAR.profitable.stops, NEAR.profitable.takes) } },
    { liq: false, stops: true, takes: false, group: 'all', split: 'groups' });
  try {
    assert.notEqual(t.src.state, 'ready', 'the left half has nothing yet'); assert.equal(t.src.right!.state, 'ready', 'the right half is ready');
    const foot = t.page.text('liq-foot') ?? '';
    assert.match(foot, /Profitable traders' stop orders at \d\d:\d\d/, `the right half's note: ${foot}`);
    assert.ok(foot.length > 0, 'not the empty tab');
  } finally { t.done(); }
});

// Sol's review of Split, round 2: the phone's right-only path (everyone's stops not read, the profitable traders' ready).
const RIGHT_ONLY = { files: { [U.triggers]: { status: 503, body: null }, [U.triggersGroups]: { status: 200, body: triggerGroups(NEAR.profitable.stops, NEAR.profitable.takes) } } as Record<string, LiqAnswer>,
  lv: { liq: false, stops: true, takes: false, group: 'all' as const, split: 'groups' as const } };

test('Sol r2-1 (P2): the chart\'s price takes the right half\'s levels away on the tab\'s tick, though the left half has none', async () => {
  const t = await tabWith(RIGHT_ONLY.files, RIGHT_ONLY.lv);
  try {
    const right = t.src.right!, longs = (): number => { const st = right.standing()!; return standingBelow(st, 'long', 1_000) - standingBelow(st, 'long', 0); };
    assert.equal(t.src.levels, null, 'the left half has nothing'); assert.equal(right.state, 'ready');
    assert.equal(longs(), 10, 'their stops of longs at 90-100 stand');
    // The chart's market priced in dollars, and the price falls through their band.
    t.store.set({ markets: [{ id: 'standin-btc-usd', quote: 'USD' }] as never, marketId: 'standin-btc-usd', mark: { ...t.store.state.mark, price: 70 } });
    assert.equal(dollarPriceOf(t.store.state), 70);
    t.page.tick(); await tick();
    assert.equal(longs(), 0, 'gone once price has traded through them');
  } finally { t.done(); }
});

test('Sol r2-2 (P2): with the left half out of date and no chart price, the ladder is centred on the right half\'s mark, not the left snapshot\'s', async () => {
  // Liquidations beside stops: everyone's liquidations four hours old marked at 80 (out of date), their stops fresh, marked at 100.
  const t = await tabWith({ [U.triggers]: { status: 200, body: triggers(NEAR.all.stops, NEAR.all.takes) } }, { liq: true, stops: true, takes: false, group: 'all', split: 'kinds' },
    () => ({ ...free(NEAR.all.liq, AS_OF - 210 * MIN), mark: 80 }));
  try {
    assert.equal(t.src.state, 'stale', 'the left half is out of date'); assert.equal(t.src.right!.state, 'ready');
    assert.equal(t.src.lastPrice(), 80, 'the left snapshot\'s mark');
    assert.equal(t.pane.framePrice, 100, 'the axis is the right half\'s');
  } finally { t.done(); }
});

test('Sol r2-3 (P2): a finger on a right-only ladder draws its line and its price\'s tag, not only the box', async () => {
  const drawn = { texts: [] as { t: string; x: number; y: number }[], lines: [] as { x: number; y: number }[] };
  const t = await tabWith(RIGHT_ONLY.files, RIGHT_ONLY.lv, () => free(NEAR.all.liq), drawn);
  try {
    const price = t.pane.framePrice!;
    assert.ok(price > 0, 'drawn around a price');
    const canvas = (t.page.parent as unknown as { findTag(tag: string): { listeners: Map<string, ((e: unknown) => void)[]> } | null }).findTag('canvas')!;
    drawn.texts.length = 0; drawn.lines.length = 0;
    // A finger 120 px above the middle of the 640 px ladder.
    canvas.listeners.get('pointerdown')![0]!({ clientY: 200, pointerId: 1 });
    t.page.frames();
    const xR = 390 - 60, tagX = xR + (390 - xR) / 2;
    const tags = drawn.texts.filter(e => Math.abs(e.x - tagX) < 0.5).map(e => e.t);
    assert.equal(new Set(tags).size, 2, `the price's tag and the finger's: ${JSON.stringify(tags)}`);
    assert.ok(drawn.lines.some(l => l.x === xR && Math.abs(l.y - 200.5) < 1), 'the finger\'s line across to the axis');
  } finally { t.done(); }
});

// The phone's halves keep their labels clear of what is written at their tops (2026-11-19): a label under a half's caption, or under the lines
// saying its orders are missing, was hidden by them.
const drawnOf = (): { texts: { t: string; x: number; y: number }[]; lines: { x: number; y: number }[] } => ({ texts: [], lines: [] });
/** The halves at 390 px: the axis takes 60, the two share the rest either side of a 6 px gap. */
const HALF = { left: { x0: 0, x1: 162 }, right: { x0: 168, x1: 330 } };
/** One more frame of the tab, its texts only. */
const redrawn = (t: { pane: LiqPane; page: { frames(): void } }, drawn: { texts: unknown[] }): void => { drawn.texts.length = 0; t.pane.invalidate(); t.page.frames(); };

test('the phone\'s halves leave out a range\'s own milestone at the top edge, where the captions are, and keep the one at the bottom', async () => {
  // ±10% (a milestone of its own): liquidations beside stops, both standing.
  const drawn = drawnOf();
  const t = await tabWith({ [U.triggers]: { status: 200, body: triggers(NEAR.all.stops, NEAR.all.takes) } }, { liq: true, stops: true, takes: false, group: 'all', split: 'kinds' },
    () => free(NEAR.all.liq), drawn);
  try {
    assert.equal(t.src.state, 'ready'); assert.equal(t.src.right!.state, 'ready');
    redrawn(t, drawn);
    const halvesWith = (tag: string): number => new Set(drawn.texts.filter(e => e.t === tag).map(e => e.x < HALF.left.x1 ? 'left' : 'right')).size;
    assert.equal(halvesWith('+10%'), 0, `the top edge's, under the captions: ${JSON.stringify(drawn.texts.filter(e => e.t === '+10%'))}`);
    assert.equal(halvesWith('−10%'), 2, 'the bottom edge\'s, in each half');
    assert.equal(halvesWith('+7.5%'), 2, 'and the next one in, clear of the captions, in each');
  } finally { t.done(); }
});

test('a largest level\'s label that would lie under a half\'s caption is left out, as one under a milestone is; one in the clear is drawn', async () => {
  // ±2.5% (no milestone at the edge): everyone's liquidations, the shorts' at 102.4-102.5 just under the top, where the left caption is, and
  // the longs' at 98.4-98.5, in the clear.
  const drawn = drawnOf();
  const doc = (): unknown => ({ ...free([[984, 0, 100, 0, 0, 5, 0, 100, 0], [1024, 0, 0, 0, 100, 0, 5, 0, 100]]), step: 0.1 });
  const t = await tabWith({ [U.triggers]: { status: 200, body: triggers(NEAR.all.stops, NEAR.all.takes) } }, { liq: true, stops: true, takes: false, group: 'all', split: 'kinds' },
    doc, drawn, '0.025');
  try {
    assert.equal(t.src.state, 'ready'); assert.equal(t.pane.framePrice, 100);
    redrawn(t, drawn);
    const labels = drawn.texts.filter(e => /^(◆ )?\$/.test(e.t) && e.x < HALF.left.x1);
    assert.deepEqual(labels.filter(e => e.y < 40), [], `nothing under the caption: ${JSON.stringify(labels)}`);
    assert.ok(labels.some(e => e.y > 500 && e.y < 530), `the longs' label, in the clear: ${JSON.stringify(labels)}`);
  } finally { t.done(); }
});

test('a largest level\'s label that would lie under the lines saying a half\'s orders are missing is left out too', async () => {
  // Everyone | Profitable, liquidations and stops, ±10%: the profitable traders' order files answer 404, and their liquidations' largest row
  // is at 109.0-109.1, under those lines.
  const drawn = drawnOf();
  const theirs = { ...groups([[1090, 0, 0, 0, 100, 0, 5, 0, 100]], null), step: 0.1 };
  const t = await tabWith({ [U.groups]: { status: 200, body: theirs }, [U.triggers]: { status: 200, body: triggers(NEAR.all.stops, NEAR.all.takes) } },
    { liq: true, stops: true, takes: false, group: 'all', split: 'groups' }, () => free(NEAR.all.liq), drawn);
  try {
    const right = t.src.right!;
    assert.equal(right.state, 'ready'); assert.equal(right.ordersAbsent(), true);
    redrawn(t, drawn);
    const note = drawn.texts.filter(e => e.x === HALF.right.x0 + 6 && e.y >= 32);
    assert.ok(note.length >= 2, `the lines are there: ${JSON.stringify(note)}`);
    const bottom = Math.max(...note.map(e => e.y)) + 7;
    const under = drawn.texts.filter(e => /^(◆ )?\$/.test(e.t) && e.x >= HALF.right.x0 && e.x < HALF.right.x1 && e.y < bottom + 10);
    assert.deepEqual(under, [], `nothing under the caption or the lines: ${JSON.stringify(under)}`);
  } finally { t.done(); }
});

test('a finger on the phone\'s halves: each box kept on the ladder, the left half\'s from its left and the right half\'s to its right, one beside the other', async () => {
  // Liquidations beside stops, both standing; a finger 120 px above the middle, where both halves read (each box wider than its half).
  const drawn = drawnOf();
  const t = await tabWith({ [U.triggers]: { status: 200, body: triggers(NEAR.all.stops, NEAR.all.takes) } }, { liq: true, stops: true, takes: false, group: 'all', split: 'kinds' },
    () => free(NEAR.all.liq), drawn);
  try {
    const canvas = (t.page.parent as unknown as { findTag(tag: string): { listeners: Map<string, ((e: unknown) => void)[]> } | null }).findTag('canvas')!;
    drawn.texts.length = 0;
    canvas.listeners.get('pointerdown')![0]!({ clientY: 200, pointerId: 1 });
    t.page.frames();
    const xR = 390 - 60;
    // Each box: its title, then its rows to the last one's value (labels from the box's left, values to its inner right edge).
    const starts = drawn.texts.flatMap((e, i) => e.t === 'Distance' ? [i] : []);
    assert.equal(starts.length, 2, 'a box for each half');
    const boxes = starts.map(i => {
      const end = drawn.texts.findIndex((e, j) => j > i && e.t === 'Same distance, other side'), rows = drawn.texts.slice(i - 1, end + 2);
      return { title: rows[0]!, rows, top: Math.min(...rows.map(e => e.y)), bottom: Math.max(...rows.map(e => e.y)) };
    });
    for (const [n, b] of boxes.entries()) for (const e of b.rows) assert.ok(e.x >= 0 && e.x <= xR, `box ${n}: "${e.t}" at ${e.x}, off the ladder`);
    assert.ok(boxes[1]!.top > boxes[0]!.bottom || boxes[1]!.bottom < boxes[0]!.top, `one beside the other, not over it: ${JSON.stringify(boxes.map(b => [b.top, b.bottom]))}`);
    assert.ok(boxes[1]!.title.x > boxes[0]!.title.x, 'the right half\'s further right');
  } finally { t.done(); }
});

test('a finger dragged down the phone\'s halves, at three heights, in both splits: both boxes on the ladder at every step, never one over the other (Sol, review 2026-11-19)', async () => {
  const xR = 390 - 60;
  for (const height of [480, 640, 844]) for (const split of ['kinds', 'groups'] as const) {
    // Liquidations and stops on: beside each other (kinds), or added up, everyone's beside the profitable traders' (groups: the longer boxes).
    const drawn = { ...drawnOf(), rects: [] as { x: number; y: number; w: number; h: number }[] };
    const t = await tabWith({ [U.groups]: { status: 200, body: groups(NEAR.profitable.liq, null) }, [U.triggers]: { status: 200, body: triggers(NEAR.all.stops, NEAR.all.takes) },
      [U.triggersGroups]: { status: 200, body: triggerGroups(NEAR.profitable.stops, NEAR.profitable.takes) } }, { liq: true, stops: true, takes: false, group: 'all', split }, () => free(NEAR.all.liq), drawn, undefined, height);
    try {
      const canvas = (t.page.parent as unknown as { findTag(tag: string): { listeners: Map<string, ((e: unknown) => void)[]> } | null }).findTag('canvas')!;
      const fire = (type: string, y: number): void => { for (const fn of canvas.listeners.get(type) ?? []) fn({ clientY: y, pointerId: 1 }); };
      // Put down in the middle and dragged from the top to the bottom, a frame at each step; the outlined boxes are the finger's.
      fire('pointerdown', height / 2); fire('pointermove', height / 2 + 10);
      let steps = 0;
      for (let y = 1; y < height; y += 7) {
        fire('pointermove', y); drawn.rects.length = 0; t.page.frames();
        const where = `${split} at ${height} px, the finger at ${y}`, boxes = drawn.rects;
        assert.equal(boxes.length, 2, `${where}: a box for each half`);
        for (const b of boxes) assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= xR && b.y + b.h <= height, `${where}: off the ladder ${JSON.stringify(b)}`);
        const [p, q] = boxes as [typeof boxes[0], typeof boxes[0]];
        assert.ok(p.y + p.h <= q.y || q.y + q.h <= p.y || p.x + p.w <= q.x || q.x + q.w <= p.x, `${where}: one over the other ${JSON.stringify(boxes)}`);
        steps++;
      }
      assert.ok(steps > height / 8, `${split} at ${height} px: ${steps} steps`);
    } finally { t.done(); }
  }
});
