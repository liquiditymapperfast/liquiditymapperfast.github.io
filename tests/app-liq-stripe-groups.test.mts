// The stripe under Split's Everyone | Profitable (owner, 2026-11-19: one lane there, the left set's, read as a bug): a lane for each column
// where the column is drawn split, everyone's chosen kinds beside the profitable traders', each on its own scale, captioned and named in its
// reading by its group; the profitable traders' lane from their own files alone (absent orders said, never everyone's in their place); every
// lane's rows kept by a key that names its group and order family; and one lane, everyone's, wherever the column is not drawn split.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LANE_MIN_W, LiqLevelsSource, TAKE_DASH, dashPhase, stripeLanes, takeDashOffset, type Lane, type LiqRow, type LiqSet } from '../src/app/liq-levels.ts';
import { noteLines, noteMostLines, paintStripe, stripeNote, type StripeHeld } from '../src/app/liq-stripe.ts';
import { clock } from '../src/app/format.ts';
import { View } from '../src/app/view.ts';
import type { LiqAnswer } from '../src/app/liq-history.ts';
import { plusUrls, readLiqLevels, type LiqLevelSettings } from '../src/app/liq-url.ts';
import { effectiveView, narrowView, splitPair, type LiqPair, type LiqView } from '../src/app/liq-view.ts';
import { splitLanes, stripePlan } from '../src/app/liq-split.ts';
import { dollars, setBoxLines, stripeBoxLines } from '../src/app/liq-box.ts';
import { liqNote, liqWhy, ordersAbsent } from '../src/app/liq-words.ts';
import { initialState, type AppState } from '../src/app/store.ts';
import { liqSplitDrawn, setCompactGutters, stripeSplitRoom } from '../src/app/panes/heat-pane.ts';
import { plus } from '../src/app/plus/pass.ts';
import type { InfoLine } from '../src/app/infobox.ts';
import { BTC } from '../src/shared/coins.ts';

const MIN = 60_000, DAY = 86_400_000;
const AS_OF = Date.UTC(2026, 10, 15, 11, 25);
const LEVELS_URL = 'http://127.0.0.1:8791/v1/btc/liquidations.json';
const U = plusUrls(LEVELS_URL)!;
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
const snap = (asOf = AS_OF): Record<string, number> => ({ asOf, createdAt: asOf + 35 * MIN, fetchedAt: asOf + 41 * MIN });
const free = (bins: number[][]): Record<string, unknown> => ({ v: 2, coin: 'BTC', venue: 'hyperliquid', attribution: 'Powered by HyperTracker',
  snapshot: { id: 'x', ...snap(), completedAt: AS_OF + 40 * MIN }, mark: 100, positions: 10, withLiquidation: 8, longSize: 1, shortSize: 1, step: 10, bins, beyond: { longUsd: 0, shortUsd: 0 } });
const groups = (profitable: number[][]): Record<string, unknown> => ({ v: 1, coin: 'BTC', venue: 'hyperliquid', attribution: 'Powered by HyperTracker',
  snapshot: { id: 'x', ...snap(), completedAt: AS_OF + 40 * MIN }, mark: 100, step: 10,
  groups: { profitable: { positions: 3, withLiquidation: 3, longSize: 1, shortSize: 1, bins: profitable, beyond: { longUsd: 0, shortUsd: 0 } } } });
const triggers = (stops: number[][], takes: number[][]): Record<string, unknown> => ({ v: 1, coin: 'BTC', venue: 'hyperliquid', attribution: 'Powered by HyperTracker',
  snapshot: { ...snap(), ordersAt: AS_OF }, mark: 100, markFrom: 'positions', step: 10, orders: 9, triggers: 8, entries: 0, unsized: { orders: 0, wallets: 0 },
  stops: { orders: 4, wallets: 4, bins: stops, beyond: { longUsd: 0, shortUsd: 0 }, cut: { longUsd: 0, shortUsd: 0 } },
  takes: { orders: 4, wallets: 4, bins: takes, beyond: { longUsd: 0, shortUsd: 0 }, cut: { longUsd: 0, shortUsd: 0 } } });
const triggerGroups = (stops: number[][], takes: number[][]): Record<string, unknown> => {
  const b = triggers(stops, takes);
  return { ...b, stops: undefined, takes: undefined, markFrom: 'orders', groups: { profitable: { unsized: 0, stops: b.stops, takes: b.takes } } };
};

// Everyone's amounts ten times the profitable traders' ($1M against $100K, large enough to be drawn) and their counts five times, in every
// family (one snapshot, the same times): a liquidation of longs at [90, 100) and of shorts at [110, 120), a stop of longs at [80, 90) and of
// shorts at [120, 130), take profits at [60, 70) (of shorts) and [140, 150) (of longs).
const E = 1_000_000, P = 100_000;
/** A family's bins: [k, longIso, longCross, shortIso, shortCross, longCount, shortCount, longTop, shortTop], `usd` dollars and `n` each. */
const family = (usd: number, n: number) => ({
  liq: [[9, 0, usd, 0, 0, n, 0, usd, 0], [11, 0, 0, 0, usd, 0, n, 0, usd]], stops: [[8, usd, 0, 0, 0, n, 0, usd, 0], [12, 0, 0, usd, 0, 0, n, 0, usd]],
  takes: [[6, 0, 0, 0, usd, 0, n, 0, usd], [14, usd, 0, 0, 0, n, 0, usd, 0]],
});
const FAM = { all: family(E, 5), profitable: family(P, 1) };
/** A levels service with both families of every file and a pass, as the page reads it (`over` replaces a file's answer). */
function familyService(over: Record<string, LiqAnswer> = {}) {
  const files: Record<string, LiqAnswer> = { [U.groups]: { status: 200, body: groups(FAM.profitable.liq) }, [U.triggers]: { status: 200, body: triggers(FAM.all.stops, FAM.all.takes) },
    [U.triggersGroups]: { status: 200, body: triggerGroups(FAM.profitable.stops, FAM.profitable.takes) }, ...over };
  const src = new LiqLevelsSource(async url => url.includes('hyperliquid') ? [] : free(FAM.all.liq), () => AS_OF + 45 * MIN, () => LEVELS_URL,
    async url => files[url] ?? { status: 404, body: null }, { pass: () => 'v1.pass.sig', refused: () => {} });
  return src;
}
const setting = (lv: Partial<LiqLevelSettings>): LiqLevelSettings => readLiqLevels({ liq: true, stops: true, takes: true, ...lv });
/** The page asks for a choice as every pane does (`liveAsk` with Plus): the one series and a split's right column. */
async function show(src: LiqLevelsSource, s: LiqLevelSettings): Promise<void> {
  for (let i = 0; i < 3; i++) { src.ensure(BTC, () => {}, effectiveView(s, true), splitPair(s, true)?.right ?? null); await tick(); }
}

/** The map's prices in view and its height: a $10 bin is 100 px tall, so a row is a bin. */
const SCREEN = { p0: 50, p1: 160 }, PH = 1_100;
const rowAt = (rows: readonly LiqRow[], p: number): LiqRow => { const r = rows.find(x => x.p0 <= p && p < x.p1); assert.ok(r, `a row at ${p}`); return r; };
/** Each lane's rows as the pane keeps them from frame to frame (`#liqHeld`). */
type Held = StripeHeld;
const VIEW = new View({ t0: 0, t1: 1, ...SCREEN }), COLORS = { candleUp: 'up', candleDown: 'down', text: 'text', muted: 'muted', bg: 'bg' };
/** A 2D context that records the x span of everything painted on it (rectangles, strokes and fills), and no-ops the rest. */
function recorder(): { ctx: CanvasRenderingContext2D; spans: { x0: number; x1: number }[] } {
  const spans: { x0: number; x1: number }[] = [];
  let path: number[] = [];
  const own: Record<string | symbol, unknown> = {
    fillRect: (x: number, _y: number, w: number) => { spans.push({ x0: x, x1: x + w }); },
    beginPath: () => { path = []; }, moveTo: (x: number) => { path.push(x); }, lineTo: (x: number) => { path.push(x); },
    stroke: () => { if (path.length) spans.push({ x0: Math.min(...path), x1: Math.max(...path) }); },
    fill: () => { if (path.length) spans.push({ x0: Math.min(...path), x1: Math.max(...path) }); },
    measureText: (s: string) => ({ width: s.length * 6 }), getLineDash: () => [],
  };
  const ctx = new Proxy(own, { get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => { o[k] = v; return true; } });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, spans };
}
/**
 * One frame of the stripe painted by the map's own painter (`paintStripe`, which `HeatPane.#paintLiquidationLevels` calls) on a recording
 * context, live edge at `x0` and plot edge at `pw`: the plan, what was painted (the pane's hover lanes and captions), where, and each lane's
 * rows kept in `held` from frame to frame.
 */
function frame(src: LiqLevelsSource, s: LiqLevelSettings, drawn: boolean, held: Held, x0 = 100, pw = 400) {
  const pair = splitPair(s, true), plan = stripePlan(pair, drawn), { ctx, spans } = recorder();
  const painted = paintStripe(ctx, { src, plan, pair, x0, pw, ph: PH, view: VIEW, colors: COLORS, held });
  const right: LiqSet | null = plan.two ? src.right : null;
  return { plan, right, painted, spans, drew: { left: !!painted?.lanes, takes: !!painted?.lanes?.takes, right: !!painted?.right } };
}
const after = (lines: InfoLine[], label: string): string => { const l = lines.find(x => x.label === label); assert.ok(l, label); return l.text; };
const titles = (lines: InfoLine[]): string[] => lines.filter(l => l.bold && l.rule).map(l => l.text);

test('the stripe\'s plan: Everyone | Profitable draws two lanes where the column is drawn split, captioned by kind and group, each reading naming its group; else one lane, everyone\'s', () => {
  const groupsPair = (lv: Partial<LiqLevelSettings>) => splitPair(setting({ ...lv, split: 'groups' }), true)!;
  assert.deepEqual(stripePlan(groupsPair({}), true), { two: true, captions: ['Liq + stops · Everyone', 'Liq + stops · Profitable'], takes: 'Take profits · Everyone',
    whose: ['Everyone', 'Profitable'], takesWhose: 'Everyone', standalone: true }, 'the take profits stay with the left set, everyone\'s');
  assert.deepEqual(stripePlan(groupsPair({ stops: false, takes: false }), true).captions, ['Liquidations · Everyone', 'Liquidations · Profitable'], 'one kind on: its name');
  assert.deepEqual(stripePlan(groupsPair({ liq: false, takes: false }), true).captions, ['Stops · Everyone', 'Stops · Profitable']);
  // The saved Traders value is not drawn: profitable or not, the left lane is everyone's.
  assert.deepEqual(stripePlan(groupsPair({ group: 'profitable' }), true).captions, ['Liq + stops · Everyone', 'Liq + stops · Profitable']);
  // Too narrow to split (or a compact map): one lane, everyone's, as before.
  assert.deepEqual(stripePlan(groupsPair({}), false), { two: false, captions: ['Liq + stops · Everyone'], takes: 'Take profits · Everyone', whose: [null, null], takesWhose: null, standalone: false });
  // Liquidations | Stops is unchanged: two lanes wherever chosen, captioned by kind (and whose, where not everyone's), nothing named in the box.
  for (const drawn of [true, false]) {
    assert.deepEqual(stripePlan(splitPair(setting({ split: 'kinds' }), true), drawn), { two: true, captions: ['Liquidations', 'Stops'], takes: 'Take profits · Everyone', whose: [null, null], takesWhose: null, standalone: false });
    assert.deepEqual(stripePlan(splitPair(setting({ split: 'kinds', group: 'profitable' }), true), drawn).captions, ['Liquidations · Profitable', 'Stops · Profitable']);
  }
  assert.deepEqual(stripePlan(null, true), { two: false, captions: [], takes: null, whose: [null, null], takesWhose: null, standalone: false }, 'no split: one lane, no captions');
  // Two lanes beside the take profits' by the live edge, in the column's order, never outside the stripe.
  const l = splitLanes(100, 400, true);
  assert.ok(l.takes!.x1 < l.left.x0 && l.left.x1 < l.right!.x0 && l.right!.x1 === 400);
});

test('the two group lanes\' keys name their group and order family, and each lane draws its own family\'s rows on its own scale', async () => {
  const src = familyService(), s = setting({ split: 'groups' });
  await show(src, s);
  const held: Held = { levels: null, takes: null, right: null }, f = frame(src, s, true, held), right = f.right!;
  assert.equal(src.state, 'ready'); assert.equal(right.state, 'ready'); assert.deepEqual(f.drew, { left: true, takes: true, right: true });
  assert.match(src.key(), /^111\|all\|orders\|/, 'the left lane: everyone\'s view and everyone\'s orders');
  assert.match(src.takesKey(), /^111\|all\|orders\|takes\|/, 'their take profits');
  assert.match(right.key(), /^110\|profitable\|orderGroups\|/, 'the right lane: the profitable traders\' view and their own orders');
  assert.ok(held.levels!.key.startsWith(`${src.key()}|`) && held.right!.key.startsWith(`${right.key()}|`), 'each lane\'s memo is kept by its set\'s key');
  assert.notEqual(held.levels!.key, held.right!.key);
  // Everyone's liquidations and stops on the left, the profitable traders' on the right, each its own family's.
  assert.equal(rowAt(held.levels!.rows, 95).long, E); assert.equal(rowAt(held.levels!.rows, 85).long, E); assert.equal(rowAt(held.levels!.rows, 115).short, E);
  assert.equal(rowAt(held.right!.rows, 95).long, P); assert.equal(rowAt(held.right!.rows, 85).long, P); assert.equal(rowAt(held.right!.rows, 115).short, P);
  assert.equal(rowAt(held.takes!.rows, 145).short, E, 'the take profits are everyone\'s, with the left set');
  // Each lane's colour strength is its own: each lane's strongest rows at full strength, though the profitable traders' are ten times smaller.
  assert.equal(held.levels!.heat(E), held.right!.heat(P));
  assert.ok(held.right!.heat(P) > 0 && held.levels!.heat(P) < held.right!.heat(P) / 2, 'on everyone\'s scale theirs would be faint');
});

test('a switch Everyone <-> Profitable both ways, through the split and out of it: each lane\'s rows and its reading follow the family, never the one before', async () => {
  const src = familyService(), held: Held = { levels: null, takes: null, right: null };
  // [setting, the left lane's group and amount at [90, 100), the right lane's (null: one lane), the right lane's price row, its reading's group]
  const steps: [Partial<LiqLevelSettings>, string, number, number | null, number, string | null][] = [
    [{ group: 'all', split: 'none' }, 'all', E, null, 95, null],
    [{ group: 'all', split: 'groups' }, 'all', E, P, 95, 'Profitable'],
    [{ group: 'profitable', split: 'none' }, 'profitable', P, null, 95, null],
    [{ group: 'profitable', split: 'groups' }, 'all', E, P, 95, 'Profitable'],
    [{ group: 'profitable', split: 'none' }, 'profitable', P, null, 95, null],
    // Liquidations | Stops of everyone, then Everyone | Profitable, then Liquidations | Stops of the profitable traders: the right lane's
    // memo goes from everyone's stops to the profitable traders' levels and to their stops, and back.
    [{ group: 'all', split: 'kinds' }, 'all', E, E, 85, null],
    [{ group: 'all', split: 'groups' }, 'all', E, P, 95, 'Profitable'],
    [{ group: 'profitable', split: 'kinds' }, 'profitable', P, P, 85, null],
    [{ group: 'profitable', split: 'groups' }, 'all', E, P, 95, 'Profitable'],
    [{ group: 'all', split: 'kinds' }, 'all', E, E, 85, null],
    [{ group: 'all', split: 'none' }, 'all', E, null, 95, null],
  ];
  for (const [lv, group, amount, rightAmount, at, rightWhose] of steps) {
    const s = setting(lv), name = JSON.stringify(lv);
    await show(src, s);
    const f = frame(src, s, true, held);
    assert.equal(f.plan.two, rightAmount !== null, `${name}: lanes`);
    assert.equal(src.view.group, group, `${name}: the left lane's group`);
    const left = rowAt(held.levels!.rows, 95);
    assert.equal(left.long, amount, `${name}: the left lane at [90, 100)`);
    const kind = src.levels!.kind, box = stripeBoxLines(left, kind, 100, src.standing(), kind === 'both' ? src.partStandings() : null, side => side === 'long', f.plan.whose[0]);
    assert.equal(after(box, 'At this level'), dollars(amount), `${name}: the left lane's reading`);
    assert.equal(after(box, kind === 'liq' ? 'Positions' : 'Positions and orders'), String(amount === E ? 5 : 1), `${name}: its count`);
    const title = kind === 'liq' ? 'Long liquidations' : 'Long liquidations and stops';
    assert.deepEqual(titles(box), [f.plan.whose[0] ? `${title} · ${f.plan.whose[0]}` : title], `${name}: its group named under Everyone | Profitable only`);
    if (rightAmount === null) { assert.equal(f.right, null, `${name}: no right lane`); continue; }
    assert.ok(f.drew.right, `${name}: the right lane drew`);
    const r = rowAt(held.right!.rows, at), rb = setBoxLines(r, f.right!, 100, side => side === 'long', f.plan.whose[1]);
    assert.equal(r.long, rightAmount, `${name}: the right lane at ${at}`);
    assert.equal(after(rb, 'At this level'), dollars(rightAmount), `${name}: the right lane's reading`);
    assert.equal(titles(rb)[0], rightWhose ? `Long liquidations and stops · ${rightWhose}` : 'Stops of longs', `${name}: the right lane's title`);
    assert.ok(!rb.some(l => l.text === ordersAbsent()), `${name}: their orders are there`);
  }
});

test('the profitable traders\' orders absent (404 or 503): their lane draws their liquidations alone, says not available yet, and never shows everyone\'s', async () => {
  for (const answer of [{ status: 404, body: null }, { status: 503, body: null, retryAfter: 300 }] as LiqAnswer[]) {
    const src = familyService({ [U.triggersGroups]: answer }), s = setting({ split: 'groups' });
    await show(src, s);
    const held: Held = { levels: null, takes: null, right: null }, f = frame(src, s, true, held), right = f.right!;
    assert.equal(right.state, 'ready', String(answer.status)); assert.equal(right.levels!.kind, 'liq'); assert.ok(right.ordersAbsent());
    assert.match(right.key(), /^110\|profitable\|orderGroups\|/);
    // Their liquidations only: nothing at everyone's stops' rows, and every dollar in the lane is theirs (10 + 10).
    assert.equal(rowAt(held.right!.rows, 95).long, P);
    assert.ok(!held.right!.rows.some(r => (r.p0 <= 85 && 85 < r.p1 && r.long > 0) || (r.p0 <= 125 && 125 < r.p1 && r.short > 0)), 'no stops drawn');
    assert.equal(held.right!.rows.reduce((a, r) => a + r.long + r.short, 0), 2 * P);
    const box = setBoxLines(rowAt(held.right!.rows, 95), right, 100, side => side === 'long', f.plan.whose[1]);
    assert.deepEqual(titles(box), ['Long liquidations · Profitable']); assert.equal(after(box, 'At this level'), dollars(P));
    assert.equal(box.at(-1)!.text, ordersAbsent(), 'the reading says it');
    assert.equal(f.plan.captions[1], 'Liq + stops · Profitable', 'captioned as the sub-column is');
    // Everyone's lane is untouched: their liquidations and stops, their take profits, nothing said missing.
    assert.equal(rowAt(held.levels!.rows, 85).long, E); assert.ok(!src.ordersAbsent()); assert.equal(rowAt(held.takes!.rows, 145).short, E);
    // Stops alone: their lane draws nothing, is still captioned (`standalone`) and the note says why; everyone's stops stand.
    const stops = setting({ liq: false, takes: false, split: 'groups' });
    await show(src, stops);
    const g = frame(src, stops, true, held);
    assert.equal(g.right!.state, 'missing'); assert.equal(g.right!.missing(), 'profitable-orders'); assert.equal(g.right!.levels, null);
    assert.deepEqual(g.drew, { left: true, takes: false, right: false }); assert.ok(g.plan.standalone);
    assert.deepEqual(g.plan.captions, ['Stops · Everyone', 'Stops · Profitable']);
    assert.equal(rowAt(held.levels!.rows, 85).long, E);
  }
});

test('the profitable traders\' lane stands on its own: everyone\'s orders not there yet never hide it', async () => {
  const src = familyService({ [U.triggers]: { status: 503, body: null, retryAfter: 60 } }), s = setting({ liq: false, takes: false, split: 'groups' });
  await show(src, s);
  const held: Held = { levels: null, takes: null, right: null }, f = frame(src, s, true, held);
  assert.notEqual(src.state, 'ready', 'everyone\'s stops not there');
  assert.deepEqual(f.drew, { left: false, takes: false, right: true });
  assert.equal(rowAt(held.right!.rows, 85).long, P, 'the profitable traders\' stops');
  assert.ok(f.plan.standalone);
});

const standInPass = (exp: number): string => `v1.${Buffer.from(JSON.stringify({ sub: 'standin', exp })).toString('base64url')}.sig`;
function withPlus<T>(run: () => T): T {
  const now = Date.now();
  plus().accept({ key: 'standin-key-0123456789', pass: standInPass(now + 23 * 3_600_000), until: now + 20 * DAY });
  try { return run(); } finally { plus().forget(); }
}

test('too narrow to split or on a compact map: the stripe keeps one lane, everyone\'s, beside the column\'s note; with the column off a desktop map keeps both lanes', async () => {
  const state = { ...initialState(), show: { ...initialState().show, traded: false, profile: true }, liqLevels: setting({ split: 'groups' }) } as AppState;
  const off = { ...state, liqLevels: { ...state.liqLevels, column: false } } as AppState;
  const roomAt = (compact: boolean, paneW: number, st: AppState = state): boolean => { setCompactGutters(compact, paneW); return stripeSplitRoom(st); };
  withPlus(() => {
    try {
      assert.equal(roomAt(false, 1400), true, 'a wide desktop: two lanes');
      assert.equal(liqSplitDrawn(state), true, 'beside the split column');
      assert.equal(roomAt(false, 600), false, 'too narrow');
      assert.equal(roomAt(true, 400), false, 'a compact map');
      // The column off: nothing falls back to one series there, and Liquidations | Stops draws its two lanes too.
      assert.equal(roomAt(false, 1400, off), true, 'the column off, wide');
      assert.equal(liqSplitDrawn(off), false, 'though no split column is drawn');
      assert.equal(roomAt(false, 600, off), true, 'the column off, narrow: no column needs the room');
      assert.equal(roomAt(true, 400, off), false, 'a compact map with the column off: one lane, as the phone draws it');
    } finally { setCompactGutters(false, 2000); }
  });
  const src = familyService(), s = setting({ split: 'groups' }), held: Held = { levels: null, takes: null, right: null };
  await show(src, s);
  const f = frame(src, s, false, held);
  assert.equal(f.plan.two, false); assert.equal(f.right, null); assert.deepEqual(f.plan.captions, ['Liq + stops · Everyone']);
  assert.equal(rowAt(held.levels!.rows, 95).long, E, 'everyone\'s'); assert.equal(held.right, null, 'no right lane drawn');
  assert.deepEqual(titles(stripeBoxLines(rowAt(held.levels!.rows, 95), 'both', 100, src.standing(), src.partStandings(), side => side === 'long', f.plan.whose[0])), ['Long liquidations and stops']);
});

test('the map draws the stripe through its painter and takes only what it painted: the plan from the room for two lanes, the reading routed to the painted right lane first', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8'), stripe = fs.readFileSync('src/app/liq-stripe.ts', 'utf8');
  assert.match(heat, /plan = stripePlan\(pair, stripeSplitRoom\(state\)\);\n    let note = stripeNote\(src, view, pair, plan\);/);
  assert.match(heat, /export const stripeSplitRoom = \(state: AppState\): boolean => liqSplitDrawn\(state\) \|\| \(!COMPACT && !state\.liqLevels\.column\);/);
  assert.match(heat, /this\.#liqLanes = null; this\.#liqRightLane = null; this\.#liqNoteBox = null;\n    const ask = liveAsk/, 'neither lane answers the pointer before this frame draws it (another coin, a replay)');
  assert.match(heat, /const painted = paintStripe\(ctx, \{ src, plan, pair, x0: this\.#liqStripeLeft\(pw\), pw, ph, view: v, colors: p, held: this\.#liqHeld \}\);/);
  assert.match(heat, /this\.#liqLanes = painted\.lanes; this\.#liqRightLane = painted\.right;\n        if \(painted\.captions\) this\.#placeLiqCaptions\(ctx, painted\.captions, pw\);\n        else if \(painted\.takesLane\) this\.#placeLiqCaptions\(ctx, \[\{ lane: painted\.takesLane, words: t\('Take profits'\), dashed: true \}\], pw\);/);
  assert.match(heat, /if \(replaying\(\)\) return \[\];\n    const held = this\.#liqHeld\.right;\n    if \(right && held && x >= right\.lane\.x0 && x < right\.lane\.x1\) return this\.#laneLines\(state, right\.set, held, y, ph, touch, right\.whose\);\n    if \(!lanes \|\| src\.state !== 'ready'\) return \[\];/);
  assert.match(heat, /inTakes \? lanes\.takesWhose : lanes\.whose\);/);
  assert.match(heat, /return setBoxLines\(found, set, at > 0 \? at : this\.hub\.liqLevels\.lastPriceOf\(levels\), side => shown\(found, side\), whose\);/);
  // The painter's right lane: from the right set, its rows kept by that set's key.
  assert.match(stripe, /const rr = held\.right = laneRows\(\{ key: \(\) => right\.key\(\), takesKey: \(\) => '', taken: \(\) => right\.taken\(\), takesTaken: \(\) => null \}, 'levels', right\.levels,/);
});

// Sol's review of af817444..62a84ce3, round 1 (P3): a thin stripe gave lanes the painter skips (1 px at 9 and 10 px), captioned and answering
// the pointer though nothing was painted there.
test('every lane the stripe gives can be painted: a sweep of 0 to 40 px with and without take profits, both layouts', () => {
  const ok = (l: Lane | null, x0: number, right: number): boolean => l === null || (l.x1 - l.x0 >= LANE_MIN_W && l.x0 >= x0 && l.x1 <= right);
  for (let w = 0; w <= 40; w++) for (const takes of [true, false]) {
    const x0 = 100, right = 100 + w, s = splitLanes(x0, right, takes), u = stripeLanes(x0, right, takes), name = `${w} px ${takes ? 'with' : 'without'} take profits`;
    if (w >= 2 * LANE_MIN_W + 2) {
      for (const l of [s.takes, s.left, s.right]) assert.ok(ok(l, x0, right), `${name}: split ${JSON.stringify(s)}`);
      assert.ok(s.right && s.left.x1 + 2 <= s.right.x0 && (!s.takes || s.takes.x1 + 2 <= s.left.x0), `${name}: in order, 2 px apart`);
    } else assert.deepEqual([s.takes, s.right], [null, null], `${name}: one lane where two cannot be painted`);
    if (w >= LANE_MIN_W) for (const l of [u.takes, u.levels]) assert.ok(ok(l, x0, right), `${name}: unsplit ${JSON.stringify(u)}`);
  }
  // The widths that broke: 9 px drops the take profits' lane, 10 px narrows it, the two lanes of levels always paintable.
  assert.deepEqual(splitLanes(391, 400, true), { takes: null, left: { x0: 391, x1: 394 }, right: { x0: 396, x1: 400 } });
  assert.deepEqual(splitLanes(390, 400, true), { takes: { x0: 390, x1: 392 }, left: { x0: 394, x1: 396 }, right: { x0: 398, x1: 400 } });
  assert.deepEqual(splitLanes(100, 400, true), { takes: { x0: 100, x1: 190 }, left: { x0: 192, x1: 295 }, right: { x0: 297, x1: 400 } }, 'a wide stripe as before');
});

test('the painter at 9, 10, 11 and more px: every lane it reports (the hover lanes) was painted and is paintable, and only those are captioned, in both splits', async () => {
  const src = familyService();
  for (const split of ['groups', 'kinds'] as const) {
    const s = setting({ split });
    await show(src, s);
    for (const w of [9, 10, 11, 12, 30, 300]) {
      const held: Held = { levels: null, takes: null, right: null }, f = frame(src, s, true, held, 400 - w, 400), p = f.painted!, name = `${split} ${w} px`;
      assert.ok(p && p.lanes && p.right, `${name}: both lanes of levels painted`);
      assert.equal(!!p.lanes.takes, w >= 10, `${name}: the take profits' lane from 10 px`);
      const lanes = [p.lanes.levels, p.lanes.takes, p.right.lane].filter((l): l is Lane => !!l);
      for (const l of lanes) {
        assert.ok(l.x1 - l.x0 >= LANE_MIN_W, `${name}: ${JSON.stringify(l)} paintable`);
        assert.ok(f.spans.some(sp => sp.x0 >= l.x0 && sp.x1 <= l.x1 && sp.x1 > sp.x0), `${name}: ${JSON.stringify(l)} painted`);
      }
      // Nothing is painted outside the lanes reported, and nothing is captioned that was not painted.
      assert.ok(f.spans.every(sp => lanes.some(l => sp.x0 >= l.x0 - 0.5 && sp.x1 <= l.x1 + 0.5)), `${name}: every mark inside a reported lane`);
      assert.ok(p.captions!.every(c => lanes.includes(c.lane)), `${name}: captions only over painted lanes`);
      assert.equal(p.captions!.length, lanes.length, `${name}: each painted lane captioned`);
    }
  }
});

test('a lane with nothing to paint has no caption and answers no pointer: the profitable traders\' lane without their stops, everyone\'s lane without theirs', async () => {
  const absent = familyService({ [U.triggersGroups]: { status: 404, body: null } }), stops = setting({ liq: false, takes: false, split: 'groups' });
  await show(absent, stops);
  const a = frame(absent, stops, true, { levels: null, takes: null, right: null });
  assert.ok(a.painted?.lanes && !a.painted.right, 'only everyone\'s stops painted');
  assert.deepEqual(a.painted.captions!.map(c => c.words), ['Stops · Everyone']);
  const busy = familyService({ [U.triggers]: { status: 503, body: null, retryAfter: 60 } });
  await show(busy, stops);
  const b = frame(busy, stops, true, { levels: null, takes: null, right: null });
  assert.ok(b.painted && !b.painted.lanes && b.painted.right, 'only the profitable traders\' stops painted');
  assert.deepEqual(b.painted.captions!.map(c => c.words), ['Stops · Profitable']);
});

// Sol's review of af817444..62a84ce3, round 1 (P2): the profitable traders' orders hours old drew with no word of their age (the note was
// everyone's alone). Each family's file aged on its own: snapshot times moved together, as the parsers require.
const HOUR = 3_600_000;
const aged = <T extends Record<string, unknown>>(body: T, ms: number): T => {
  const s = body.snapshot as Record<string, number>;
  return { ...body, snapshot: { ...s, asOf: s.asOf! - ms, createdAt: s.createdAt! - ms, fetchedAt: s.fetchedAt! - ms, ...(s.ordersAt !== undefined ? { ordersAt: s.ordersAt - ms } : {}) } };
};
const ordersOf = (ms: number): LiqAnswer => ({ status: 200, body: aged(triggerGroups(FAM.profitable.stops, FAM.profitable.takes), ms) });
/** The note as 62a84ce3 composed it: the left set's (or the sum's) note or why nothing stands, then the absent profitable orders beside their lane. */
function noteBefore(src: LiqLevelsSource, view: LiqView, pair: LiqPair | null, two: boolean): string {
  const both = pair?.split === 'kinds' ? narrowView(pair) : null, said = both ? { ...src.setOf(both), takesState: src.takesState } : src;
  const note = src.levels && src.state === 'ready' ? liqNote(said, both ?? view, src.levels.asOf) : liqWhy(src, src.asOfs().liq) || 'Liquidation levels are loading.';
  return two && pair?.split === 'groups' && src.right?.ordersAbsent() ? `${note} · ${ordersAbsent()}` : note;
}
const noteOf = (src: LiqLevelsSource, s: LiqLevelSettings, drawn = true): string => stripeNote(src, effectiveView(s, true), splitPair(s, true), stripePlan(splitPair(s, true), drawn));

test('beside the two group lanes the note says the profitable traders\' own times, named, wherever they are not what everyone\'s part says', async () => {
  // Their orders four hours old, everyone's current: their stops still drawn, and their age said.
  const old = familyService({ [U.triggersGroups]: ordersOf(4 * HOUR) }), s = setting({ split: 'groups' });
  await show(old, s);
  assert.ok(frame(old, s, true, { levels: null, takes: null, right: null }).painted?.right, 'their lane still draws');
  assert.equal(noteOf(old, s), `${liqNote(old, effectiveView(s, true), AS_OF)} · Profitable traders: stops as of ${clock(AS_OF - 4 * HOUR)}`);
  // Stops alone, theirs an hour behind (not old by the three-hour rule, but not the time everyone's part says).
  const behind = familyService({ [U.triggersGroups]: ordersOf(HOUR) }), stops = setting({ liq: false, takes: false, split: 'groups' });
  await show(behind, stops);
  assert.equal(noteOf(behind, stops), `Hyperliquid stop orders at ${clock(AS_OF)} · Powered by HyperTracker · Profitable traders: stops as of ${clock(AS_OF - HOUR)}`);
  // Their positions an hour behind everyone's (the groups file lagging the levels file).
  const lag = familyService({ [U.groups]: { status: 200, body: aged(groups(FAM.profitable.liq), HOUR) } }), liq = setting({ stops: false, takes: false, split: 'groups' });
  await show(lag, liq);
  assert.equal(noteOf(lag, liq), `Hyperliquid liquidation levels at ${clock(AS_OF)} · Powered by HyperTracker · Profitable traders: positions as of ${clock(AS_OF - HOUR)}`);
  // Both families' orders four hours old: each group's "as of" named.
  const both = familyService({ [U.triggers]: { status: 200, body: aged(triggers(FAM.all.stops, FAM.all.takes), 4 * HOUR) }, [U.triggersGroups]: ordersOf(4 * HOUR) });
  await show(both, s);
  const t4 = clock(AS_OF - 4 * HOUR);
  assert.equal(noteOf(both, s), `Hyperliquid liquidations and stops at ${clock(AS_OF)} · Powered by HyperTracker · All traders: stops and take profits as of ${t4} · Profitable traders: stops as of ${t4}`);
});

test('beside the two group lanes a lane with nothing names its group\'s reason; everyone\'s and the profitable traders\' status each said', async () => {
  const stops = setting({ liq: false, takes: false, split: 'groups' });
  // Everyone's orders not there yet: their reason named, the profitable traders' stops and their time.
  const busy = familyService({ [U.triggers]: { status: 503, body: null, retryAfter: 60 } });
  await show(busy, stops);
  assert.equal(noteOf(busy, stops), `All traders: Stop levels are not ready yet. · Profitable traders: stops as of ${clock(AS_OF)}`);
  // No groups for this snapshot: the profitable traders' reason, named.
  const none = familyService({ [U.groups]: { status: 503, body: null, retryAfter: 60 } }), liq = setting({ stops: false, takes: false, split: 'groups' });
  await show(none, liq);
  assert.equal(noteOf(none, liq), `${liqNote(none, effectiveView(liq, true), AS_OF)} · Profitable traders: No trader groups for this snapshot yet.`);
  // Their orders absent: said once (it names them), their liquidations drawn alone.
  const absent = familyService({ [U.triggersGroups]: { status: 404, body: null } }), s = setting({ split: 'groups' });
  await show(absent, s);
  assert.equal(noteOf(absent, s), `${liqNote(absent, effectiveView(s, true), AS_OF)} · ${ordersAbsent()}`);
});

test('the note is what it was wherever both groups\' times agree and in every other mode, aged files included', async () => {
  const views: Partial<LiqLevelSettings>[] = [{}, { takes: false }, { stops: false }, { liq: false, takes: false }, { stops: false, takes: false }];
  const services = [familyService(), familyService({ [U.triggersGroups]: ordersOf(4 * HOUR) }), familyService({ [U.triggersGroups]: { status: 404, body: null } }),
    familyService({ [U.triggers]: { status: 200, body: aged(triggers(FAM.all.stops, FAM.all.takes), 4 * HOUR) } })];
  const modes = [[{ split: 'none', group: 'all' }, true], [{ split: 'none', group: 'profitable' }, true], [{ split: 'kinds', group: 'all' }, true],
    [{ split: 'kinds', group: 'profitable' }, false], [{ split: 'groups' }, false]] as const;
  for (const [n, src] of services.entries()) for (const v of views) for (const [lv, drawn] of modes) {
    const s = setting({ ...v, ...lv }), pair = splitPair(s, true), name = `${n} ${JSON.stringify(s)} ${drawn}`;
    await show(src, s);
    assert.equal(noteOf(src, s, drawn), noteBefore(src, effectiveView(s, true), pair, stripePlan(pair, drawn).two), name);
  }
  // Two group lanes, both families on the same snapshot and nothing missing: the same words as before.
  const same = familyService();
  for (const v of views) {
    const s = setting({ ...v, split: 'groups' });
    await show(same, s);
    assert.equal(noteOf(same, s), noteBefore(same, effectiveView(s, true), splitPair(s, true), true), JSON.stringify(v));
  }
});

test('the note\'s lines: whole parts as far as each line goes, the old two lines wherever they held it, more where two groups\' times need them', () => {
  const measure = (s: string): number => s.length * 6;
  const old = (note: string, room: number): string[] => {
    const parts = note.split(' · ');
    let first = parts[0] ?? '', i = 1;
    while (i < parts.length && measure(`${first} · ${parts[i]}`) <= room) { first = `${first} · ${parts[i]}`; i++; }
    return [first, parts.slice(i).join(' · ')].filter(Boolean);
  };
  const note = 'Hyperliquid liquidations and stops at 11:25 · Powered by HyperTracker · All traders: stops and take profits as of 07:25 · Profitable traders: stops as of 07:25';
  for (const room of [2000, 700, 400, 300, 290]) {
    const lines = noteLines(measure, note, room), parts = note.split(' · ');
    assert.ok(lines.every(l => measure(l) <= room), `${room}: every line fits`);
    assert.deepEqual(lines.join(' · ').split(' · '), parts, `${room}: every part whole`);
    if (old(note, room).every(l => measure(l) <= room)) assert.deepEqual(lines, old(note, room), `${room}: as before where the old two lines held it`);
  }
  assert.equal(noteLines(measure, note, 290).length, 4, 'four lines where needed');
  assert.ok(noteLines(measure, note, 60).at(-1)!.endsWith('…'), 'a part wider than the room alone is cut');
});

test('a short map gives the note fewer lines, so the stripe\'s captions keep their room below it (Sol, review 2026-11-19)', () => {
  assert.equal(noteMostLines(138, 48), 2, 'the 138 px phone map: two lines, as the note always had');
  assert.equal(noteMostLines(800, 48), 4, 'a tall map: four');
  for (let ph = 60; ph <= 900; ph++) for (let under = 20; under <= 90; under += 7) {
    const most = noteMostLines(ph, under);
    assert.ok(most >= 2 && most <= 4, `${ph}/${under}: two to four lines`);
    // Past the two lines the note always had, a line is given only where the history note's line, the note and three captions still fit.
    if (most > 2) assert.ok(under + 13 + 13 * most + 3 + 3 * 17 <= ph, `${ph}/${under}: ${most} lines leave the captions their room`);
  }
  const pane = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  // `layNote` lays it out in `noteMostLines`, then fewer where the volume strip's names stand (tests/app-liq-split-phone.test.mts).
  assert.match(pane, /layNote\(measure, note, Math\.max\(40, pw - 24\), \{ ph, under, foot, history: this\.#historyNote \}\)/, 'the pane lays the note out by the map\'s height');
});

test('a thin take profits\' lane starts on a dash, so it is never all gap; a wider one keeps the plot\'s one pattern (Sol, review 2026-11-19)', () => {
  const period = TAKE_DASH.reduce((a, b) => a + b, 0), on = TAKE_DASH[0]!;
  // Canvas dashes: the pattern starts `offset` into itself at the stroke's start, so a pixel `d` from the start is inked where (d + offset) mod period < on.
  const inked = (offset: number, w: number): number => { let n = 0; for (let d = 0; d < w; d++) if ((d + offset) % period < on) n++; return n; };
  for (let x0 = 0; x0 < 60; x0++) for (let w = LANE_MIN_W; w <= 20; w++) {
    const offset = takeDashOffset(x0, w);
    assert.ok(inked(offset, w) > 0, `x0 ${x0}, w ${w}: some of the lane is inked`);
    if (w >= period) assert.equal(offset, dashPhase(x0), `x0 ${x0}, w ${w}: on the plot's pattern`);
  }
  assert.equal(inked(dashPhase(390), 2), 0, 'the case Sol found: on the plot\'s pattern a 2 px lane at 390 would be all gap');
  const levels = fs.readFileSync('src/app/liq-levels.ts', 'utf8');
  assert.match(levels, /ctx\.lineDashOffset = takeDashOffset\(x0, w\)/, 'the stripe\'s painter takes that offset');
});
