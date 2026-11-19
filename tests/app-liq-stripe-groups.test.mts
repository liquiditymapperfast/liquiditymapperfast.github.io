// The stripe under Split's Everyone | Profitable (owner, 2026-11-19: one lane there, the left set's, read as a bug): a lane for each column
// where the column is drawn split, everyone's chosen kinds beside the profitable traders', each on its own scale, captioned and named in its
// reading by its group; the profitable traders' lane from their own files alone (absent orders said, never everyone's in their place); every
// lane's rows kept by a key that names its group and order family; and one lane, everyone's, wherever the column is not drawn split.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LiqLevelsSource, type LiqRow, type LiqSet } from '../src/app/liq-levels.ts';
import { paintStripe, type StripeHeld } from '../src/app/liq-stripe.ts';
import { View } from '../src/app/view.ts';
import type { LiqAnswer } from '../src/app/liq-history.ts';
import { plusUrls, readLiqLevels, type LiqLevelSettings } from '../src/app/liq-url.ts';
import { effectiveView, splitPair } from '../src/app/liq-view.ts';
import { splitLanes, stripePlan } from '../src/app/liq-split.ts';
import { dollars, setBoxLines, stripeBoxLines } from '../src/app/liq-box.ts';
import { ordersAbsent } from '../src/app/liq-words.ts';
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
  assert.ok(l.takes!.x1 < l.left.x0 && l.left.x1 < l.right.x0 && l.right.x1 === 400);
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
  assert.match(heat, /this\.#liqLanes = null; this\.#liqRightLane = null;\n    const ask = liveAsk/, 'neither lane answers the pointer before this frame draws it (another coin, a replay)');
  assert.match(heat, /const painted = paintStripe\(ctx, \{ src, plan, pair, x0: this\.#liqStripeLeft\(pw\), pw, ph, view: v, colors: p, held: this\.#liqHeld \}\);/);
  assert.match(heat, /this\.#liqLanes = painted\.lanes; this\.#liqRightLane = painted\.right;\n        if \(painted\.captions\) this\.#paintLaneCaptions\(ctx, painted\.captions, pw\);\n        else if \(painted\.takesLane\) this\.#paintTakesCaption\(ctx, painted\.takesLane, pw\);/);
  assert.match(heat, /if \(replaying\(\)\) return \[\];\n    const held = this\.#liqHeld\.right;\n    if \(right && held && x >= right\.lane\.x0 && x < right\.lane\.x1\) return this\.#laneLines\(state, right\.set, held, y, ph, touch, right\.whose\);\n    if \(!lanes \|\| src\.state !== 'ready'\) return \[\];/);
  assert.match(heat, /inTakes \? lanes\.takesWhose : lanes\.whose\);/);
  assert.match(heat, /return setBoxLines\(found, set, at > 0 \? at : this\.hub\.liqLevels\.lastPriceOf\(levels\), side => shown\(found, side\), whose\);/);
  // The painter's right lane: from the right set, its rows kept by that set's key.
  assert.match(stripe, /const rr = held\.right = laneRows\(\{ key: \(\) => right\.key\(\), takesKey: \(\) => '', taken: \(\) => right\.taken\(\), takesTaken: \(\) => null \}, 'levels', right\.levels,/);
});
