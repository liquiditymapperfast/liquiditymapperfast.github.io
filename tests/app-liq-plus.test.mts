import test from 'node:test';
import assert from 'node:assert/strict';
import { LiqLevelsSource, combineTaken, liqRows, onTheWay, parseLiqGroups, parseLiqLevels, parseTriggers, partsBetween, partsOnTheWay, standingBelow, sumLevels, takenByCandles, liqStanding, type LiqLevels, type LiqRow, type LiqStanding } from '../src/app/liq-levels.ts';
import { DAY_MS, LIQ_HOLD_MS, LiqHistory, MAX_DAYS, bandOnEdge, dayText, familiesFor, readHistRows, readRollup, type LiqAnswer } from '../src/app/liq-history.ts';
import { readLiqLevels, plusUrls } from '../src/app/liq-url.ts';
import { FREE_VIEW, effectiveView, heldBack, isFreeChoice, viewKey, type LiqView } from '../src/app/liq-view.ts';
import { PRESET_BANDS } from '../src/app/depth-settings.ts';
import { changeOf, isPlusChange, liqMenuItems } from '../src/app/liq-menu.ts';
import { columnNotes, liqNote, liqWhy, splitAmounts, splitText, takesLeftOut } from '../src/app/liq-words.ts';
import { dollars, mirrorSplits, probeBoxLines, readingTexts, stripeBoxLines } from '../src/app/liq-box.ts';
import { usd } from '../src/app/format.ts';
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
  assert.deepEqual(u.rollup, { free: 'https://levels.hiverust.dev/v1/plus/btc/liquidation-history-4h.json', groups: 'https://levels.hiverust.dev/v1/plus/btc/liquidation-history-groups-4h.json', triggers: 'https://levels.hiverust.dev/v1/plus/btc/trigger-history-4h.json' });
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
  assert.deepEqual(readLiqLevels(undefined), { on: true, column: true, kind: 'liq', takes: false, group: 'all' });
  assert.deepEqual(readLiqLevels({ on: false, column: true }), { on: false, column: true, kind: 'liq', takes: false, group: 'all' }, 'a save from before the choice');
  assert.deepEqual(readLiqLevels({ kind: 'stops', takes: true, group: 'profitable' }), { on: true, column: true, kind: 'stops', takes: true, group: 'profitable' });
  // A group the page no longer offers, saved before (in the settings or a layout): everyone's, never the profitable traders'.
  assert.deepEqual(readLiqLevels({ kind: 'liq', takes: true, group: 'proven' }), { on: true, column: true, kind: 'liq', takes: true, group: 'all' });
  assert.deepEqual(readLiqLevels({ kind: 'both', group: 'Proven' }).group, 'all');
  assert.deepEqual(readLiqLevels({ kind: 'all', takes: 'yes', group: 'rich' }), { on: true, column: true, kind: 'liq', takes: false, group: 'all' }, 'anything else reads as the free view');
  const chosen = readLiqLevels({ kind: 'both', takes: true, group: 'profitable' });
  assert.deepEqual(effectiveView(chosen, false), FREE_VIEW, 'no Plus: the free view is drawn');
  assert.deepEqual(effectiveView(chosen, true), { kind: 'both', takes: true, group: 'profitable' });
  assert.deepEqual(effectiveView(readLiqLevels({ kind: 'stops', group: 'profitable' }), true), { kind: 'stops', takes: false, group: 'all' }, 'stops have no groups');
  assert.ok(heldBack(chosen, false), 'a Plus choice without Plus is held back (the controls show it locked)');
  assert.ok(!heldBack(chosen, true));
  assert.ok(!heldBack(readLiqLevels({}), false), 'the free view is never held back');
  assert.ok(isFreeChoice(FREE_VIEW) && !isFreeChoice({ kind: 'liq', takes: true, group: 'all' }) && !isFreeChoice({ kind: 'liq', takes: false, group: 'profitable' }));
  assert.equal(viewKey({ kind: 'stops', takes: false, group: 'profitable' }), viewKey({ kind: 'stops', takes: false, group: 'all' }), 'the group of stops counts for nothing');
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
  s.src.ensure(BTC, () => {}, view({ kind: 'both', takes: true, group: 'profitable' })); await tick();
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
  assert.deepEqual(familiesFor(view({ kind: 'stops', group: 'profitable' })), ['orders']);
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
  const noPass = await ask(view({ kind: 'both', takes: true, group: 'profitable' }));
  assert.ok(noPass.every(u => !u.includes('/plus/')), `nothing paid without a pass: ${noPass.join(', ')}`);
  assert.deepEqual(h.rows(day, now, view({ kind: 'stops' })), [], 'and nothing drawn');
  access.pass = 'v1.member.sig'; h.accessChanged();
  // The profitable traders: the groups days, each with the pass; their part of each row, whatever else the row holds.
  const profitable = await ask(view({ group: 'profitable' }));
  assert.ok(profitable.includes(path(U.groupsDay(dayText(day)))));
  assert.ok(asked.filter(a => a.url.includes('/plus/')).every(a => a.pass === 'v1.member.sig'), 'every Plus file with the pass');
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
  const free = rows({ kind: 'both', takes: true, group: 'profitable' }, false);
  assert.equal(free['kind:both']!.checked, true, 'the saved choice is ticked even without Plus');
  assert.equal(free['kind:both']!.tag, 'Plus'); assert.equal(free['kind:both']!.locked, true);
  assert.equal(free['kind:liq']!.tag, undefined, 'the free choices carry no tag');
  assert.equal(free['group:all']!.tag, undefined);
  assert.equal(free.takes!.checked, true); assert.equal(free.takes!.locked, true);
  assert.equal(free['group:profitable']!.checked, true); assert.ok(!free['group:profitable']!.disabled);
  assert.deepEqual(Object.keys(free).filter(id => id.startsWith('group:')), ['group:all', 'group:profitable'], 'Traders: everyone or the profitable traders');
  assert.ok(free['h:show']!.heading && free['h:traders']!.heading, 'group headings are not choices');
  const member = rows({ kind: 'stops', takes: false, group: 'profitable' }, true);
  assert.equal(member['kind:stops']!.locked, false, 'with Plus the tag has no lock');
  assert.ok(member['group:profitable']!.disabled && member['group:all']!.disabled, 'stops have no groups: the traders are greyed');
  assert.ok(member['h:no-groups'], 'and a line says why');
  assert.ok(liqMenuItems({ kind: 'stops', takes: false, group: 'all' }, true).at(-1)!.action, 'the last line opens the Guide');
  assert.deepEqual(changeOf('kind:both', { takes: false }), { kind: 'both' });
  assert.deepEqual(changeOf('group:profitable', { takes: false }), { group: 'profitable' });
  assert.deepEqual(changeOf('takes', { takes: true }), { takes: false }, 'the switch flips');
  assert.equal(changeOf('h:show', { takes: false }), null);
  assert.equal(changeOf('kind:rich', { takes: false }), null);
  assert.ok(isPlusChange({ kind: 'stops' }) && isPlusChange({ group: 'profitable' }) && isPlusChange({ takes: true }));
  assert.equal(changeOf('group:proven', { takes: false }), null, 'a group the page does not offer is no change');
  assert.ok(!isPlusChange({ kind: 'liq' }) && !isPlusChange({ group: 'all' }) && !isPlusChange({ takes: false }), 'back towards the free view is never Plus');
});

test('the note says when the orders are well behind the liquidations, and why a view draws nothing; both on two grids is not added up', async () => {
  const pass = { value: 'v1.pass.sig' as string | null };
  let orders: unknown = triggers(STOPS, TAKES, AS_OF - 3 * 3_600_000);
  const s = service({ [U.groups]: { status: 200, body: groups([[7, 0, 50, 0, 0, 1, 0, 50, 0]], null) }, [U.triggers]: () => ({ status: 200, body: orders }) }, pass);
  const both = view({ kind: 'both', takes: true });
  s.src.ensure(BTC, () => {}, both); await tick(); s.src.ensure(BTC, () => {}, both); await tick();
  assert.equal(s.src.state, 'ready');
  const note = liqNote(s.src, both, s.src.levels!.asOf);
  assert.match(note, /^Hyperliquid liquidations and stops at /);
  assert.match(note, /stops and take profits as of /, note);
  assert.doesNotMatch(note, /with take profits/, 'said once');
  assert.match(liqNote(s.src, view({ kind: 'both' }), s.src.levels!.asOf), / · stops as of /);
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
  const both = view({ kind: 'both' });
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
  s.src.ensure(BTC, () => {}, view({ kind: 'stops' })); await tick();
  assert.equal(s.src.partStandings(), null);
  assert.equal(splitText({ liq: 200_500_000, stops: 130_100_000 }), 'Total $330.6M = liquidations $200.5M + stops $130.1M', 'the total is the parts added');
});

test('under the column\'s button: the group where the button had no room for it, first, then that the take profits are not in the curve', () => {
  assert.equal(takesLeftOut(), 'Take profits not included');
  const profitable = { kind: 'liq', takes: true, group: 'profitable' } as const;
  assert.deepEqual(columnNotes(profitable, false, true), ['Profitable traders', 'Take profits not included'], 'both: the group line first');
  assert.deepEqual(columnNotes(profitable, true, true), ['Take profits not included'], 'the group already on the button: not said twice');
  assert.deepEqual(columnNotes({ kind: 'both', takes: false, group: 'profitable' }, false, false), ['Profitable traders']);
  assert.deepEqual(columnNotes({ kind: 'liq', takes: false, group: 'all' }, false, false), [], 'everyone: nothing to add');
  assert.deepEqual(columnNotes({ kind: 'stops', takes: false, group: 'profitable' }, false, true), ['Take profits not included'], 'stops have no group');
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
  const both = view({ kind: 'both' });
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
