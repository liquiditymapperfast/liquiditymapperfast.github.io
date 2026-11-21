// Split on a phone (2026-11-19, three leftovers seen in pictures of the live code): the stripe's caption plates kept clear of the corner
// buttons the map really shows (a phone's Draw key, not only the desktop's row), placed at the highest free place without holding a row
// for a plate that stands lower; the note under the legend kept clear of the volume strip's names on a short map; and the finger's two
// boxes on the Liq tab, each titled with its own group and short enough for the two to fit the ladder together.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { captionKeepOut, captionRows, cornerSpan, placeCaptions, placeProbeBoxes, probeBoxesFit, probeDetail, type BoxSize, type CornerEl, type Rect } from '../src/app/liq-split.ts';
import { layNote, noteLines, noteMostLines } from '../src/app/liq-stripe.ts';
import { paintVolumeStrip, stripNamesTop, type StripBar } from '../src/app/measures/volume-strip.ts';
import { volumeBand } from '../src/app/measures/model.ts';
import { PROBE_LEAST, probeBoxLines, probeWrap, type ProbeFacts } from '../src/app/liq-box.ts';
import { layoutInfo, type InfoKind } from '../src/app/infobox.ts';
import { groupName } from '../src/app/liq-view.ts';
import { PALETTES } from '../src/app/theme.ts';
import type { LiqStanding } from '../src/app/liq-levels.ts';

const el = (offsetLeft: number, offsetTop: number, offsetWidth: number, offsetHeight: number, hidden = false): CornerEl => ({ offsetLeft, offsetTop, offsetWidth, offsetHeight, hidden });
const over = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const plate = (x: number, w: number, y: number): Rect => ({ x0: x, x1: x + w, y0: y, y1: y + 15 });

test('the corner buttons are the ones the map shows: the desktop\'s row, or a phone\'s Draw key where the row is not there; their union where both show', () => {
  // A desktop (1,720 px): the row, the phone's key hidden (display: none gives it no width).
  assert.deepEqual(cornerSpan([el(326, 8, 233, 26), el(0, 0, 0, 0)], 0), { x0: 326, y0: 8, x1: 559, y1: 34 });
  // A phone (390 x 844, measured): no row (the compact bar takes it off the map), the Draw key 42 x 36 at the plot's top right.
  assert.deepEqual(cornerSpan([null, el(250, 8, 42, 36)], 0), { x0: 250, y0: 8, x1: 292, y1: 44 });
  // The plot starts after the columns left of the map.
  assert.deepEqual(cornerSpan([null, el(450, 8, 42, 36)], 200), { x0: 250, y0: 8, x1: 292, y1: 44 });
  // Both shown (a desktop arrangement with the compact bar keeps its key; were a row there too, the plates keep clear of both).
  assert.deepEqual(cornerSpan([el(300, 8, 100, 26), el(410, 8, 42, 36)], 0), { x0: 300, y0: 8, x1: 452, y1: 44 });
  assert.equal(cornerSpan([el(300, 8, 100, 26, true), null], 0), null, 'a hidden row is no keep-out');
  assert.equal(cornerSpan([null, null], 0), null);
});

/**
 * A frame measured in the built page (headless Chrome, Liquidations | Stops with take profits, 2026-11-19): the corner buttons, the legend's
 * plate, the "depth recorded from" note and the note under the legend (whose right end the map measures in its 11 px font, a tenth wider
 * than the 10 px it prints in), and the plates' places across, take profits first.
 */
interface Frame { name: string; plot: { w: number; h: number }; corner: (CornerEl | null)[]; legend: { right: number; bottom: number }; history: { x0: number; x1: number; top: number } | null;
  note: { x0: number; x1: number; top: number; bottom: number }; items: { x: number; w: number }[] }
const FRAMES: Frame[] = [
  // 844 x 207, a phone held sideways: a 392 x 138 plot, the Draw key over its top right, the note in one line under the "depth recorded from"
  // note. Before, the Liquidations plate stood at 23 and Stops at 40, under the key.
  { name: '844x207', plot: { w: 392, h: 138 }, corner: [null, el(342, 8, 42, 36)], legend: { right: 242, bottom: 68 }, history: { x0: 232, x1: 351, top: 74 },
    note: { x0: 8, x1: 408, top: 87, bottom: 100 }, items: [{ x: 244, w: 124 }, { x: 301, w: 78 }, { x: 342, w: 48 }] },
  // 390 x 844, upright: the Stops plate started right of the legend and stood at 40, its top under the key (which ends at 44).
  { name: '390x844', plot: { w: 300, h: 678 }, corner: [null, el(250, 8, 42, 36)], legend: { right: 242, bottom: 68 }, history: { x0: 148, x1: 267, top: 74 },
    note: { x0: 8, x1: 218, top: 87, bottom: 113 }, items: [{ x: 158, w: 124 }, { x: 212, w: 78 }, { x: 250, w: 48 }] },
  // 320 x 568 and 375 x 812: the plates already stood under the note, clear of everything; they stay where they were.
  { name: '320x568', plot: { w: 230, h: 402 }, corner: [null, el(180, 8, 42, 36)], legend: { right: 218, bottom: 68 }, history: { x0: 85, x1: 204, top: 74 },
    note: { x0: 8, x1: 218, top: 87, bottom: 113 }, items: [{ x: 92, w: 124 }, { x: 144, w: 78 }, { x: 180, w: 48 }] },
  { name: '375x812', plot: { w: 285, h: 646 }, corner: [null, el(235, 8, 42, 36)], legend: { right: 242, bottom: 68 }, history: { x0: 135, x1: 254, top: 74 },
    note: { x0: 8, x1: 218, top: 87, bottom: 113 }, items: [{ x: 143, w: 124 }, { x: 197, w: 78 }, { x: 235, w: 48 }] },
];
const ranked = (f: Frame): { x: number; w: number; rank: number }[] => f.items.map((it, i) => ({ ...it, rank: i === 0 ? 1 : 0 }));
const keepOf = (f: Frame): Rect[] => captionKeepOut({ corner: cornerSpan(f.corner, 0), legend: f.legend, history: f.history, note: f.note });

test('the stripe\'s caption plates keep clear of a phone\'s Draw key, the legend, both notes and each other, at every measured phone size', () => {
  for (const f of FRAMES) {
    const corner = cornerSpan(f.corner, 0)!, keep = keepOf(f);
    const ys = placeCaptions(ranked(f), keep, 6, 15, f.plot.h);
    assert.ok(ys.every(y => y !== null), `${f.name}: every plate placed`);
    const plates = f.items.map((it, i) => plate(it.x, it.w, ys[i]!));
    plates.forEach((p, i) => {
      assert.ok(!over(p, { x0: corner.x0 - 4, x1: corner.x1 + 4, y0: corner.y0, y1: corner.y1 + 4 }), `${f.name}: plate ${i} at ${p.y0} lies under the Draw key`);
      for (const r of keep) assert.ok(!over(p, r), `${f.name}: plate ${i} at ${p.y0} lies over a keep-out ${JSON.stringify(r)}`);
      plates.slice(0, i).forEach((q, j) => assert.ok(!over(p, q), `${f.name}: plates ${j} and ${i} overlap`));
      assert.ok(p.y1 <= f.plot.h, `${f.name}: plate ${i} inside the plot`);
    });
  }
});

test('the plates keep the rows they always stood in where those are clean; where not, each takes the highest free place, every keep-out checked after every move', () => {
  // Clean rows are kept, the row the legend's plate held at the top included.
  const keep: Rect[] = [{ x0: -Infinity, y0: -Infinity, x1: 120, y1: 80 }], three = [{ x: 100, w: 60 }, { x: 130, w: 60 }, { x: 150, w: 40 }];
  assert.deepEqual(captionRows(three, keep, 6, 15), [80, 23, 40]);
  assert.deepEqual(placeCaptions(three, keep, 6, 15), [80, 23, 40]);
  assert.deepEqual(placeCaptions([{ x: 10, w: 80 }, { x: 60, w: 80 }, { x: 200, w: 50 }], [], 6, 15), [6, 23, 6], 'the second a row down, the third up where it is clear');
  // Rows that put a plate past the plot's foot are not kept, and a plate with no room above the foot is left out (Sol, review 2026-11-20).
  assert.deepEqual(placeCaptions(three, keep, 6, 15, 50), [null, 6, 23]);
  // Pushed under one keep-out into another: the rows leave it there (each keep-out checked once); placed again, it moves on below that one too.
  const two: Rect[] = [{ x0: 0, y0: 30, x1: 300, y1: 45 }, { x0: 0, y0: -Infinity, x1: 300, y1: 32 }];
  assert.deepEqual(captionRows([{ x: 10, w: 50 }], two, 6, 15), [32]);
  assert.deepEqual(placeCaptions([{ x: 10, w: 50 }], two, 6, 15), [45]);
  // The phones, as the page now places them: held sideways the rows put Liquidations over the "depth recorded from" note (65 to 80 over 74
  // to 89) and Stops into the take profits' plate; placed again, Liquidations stands under the Draw key and Stops at the plot's foot, the
  // take profits' plate where the legend sends it. Upright at 390 px the rows put Stops at 82, over the "depth recorded from" note: under the
  // key instead. At 320 and 375 px the rows are clean and kept.
  const at = (name: string): (number | null)[] => { const f = FRAMES.find(g => g.name === name)!; return placeCaptions(ranked(f), keepOf(f), 6, 15, f.plot.h); };
  assert.deepEqual(at('844x207'), [104, 48, 121]);
  assert.deepEqual(at('390x844'), [116, 133, 48]);
  for (const name of ['320x568', '375x812']) { const f = FRAMES.find(g => g.name === name)!; assert.deepEqual(at(name), captionRows(f.items, keepOf(f), 6, 15), `${name}: the rows kept`); }
  assert.deepEqual(at('320x568'), [116, 133, 150]);
});

test('a desktop map\'s plates stay where they stood (1,720 px, Liquidations | Stops), wherever the "depth recorded from" note stands', () => {
  // Measured: the row of corner buttons 326 to 559 by 8 to 34 on a 567 x 772 plot, the legend to 313 by 60, the note under it 66 to 79 and
  // its right end at 434 in the map's measure. The "depth recorded from" note moves with the recording's start: two places seen.
  const base = { corner: cornerSpan([el(326, 8, 233, 26), el(0, 0, 0, 0)], 0), legend: { right: 313, bottom: 60 }, note: { x0: 8, x1: 434, top: 66, bottom: 79 } };
  const items = [{ x: 410, w: 124 }, { x: 471, w: 78 }, { x: 517, w: 48 }];
  for (const [history, rows] of [[{ x0: 380, x1: 499, top: 40 }, [82, 55, 106]], [{ x0: 395, x1: 514, top: 40 }, [82, 106, 123]]] as const) {
    const keep = captionKeepOut({ ...base, history });
    assert.deepEqual(captionRows(items, keep, 6, 15), rows, 'the old rows');
    assert.deepEqual(placeCaptions(items, keep, 6, 15, 772), rows, `unchanged with the note at ${history.x0} to ${history.x1}`);
  }
  // Everyone | +PnL (two lanes, no take profits): unchanged too.
  const groups = [{ x: 419, w: 122 }, { x: 440, w: 125 }], keep = captionKeepOut({ ...base, history: { x0: 395, x1: 514, top: 40 }, note: { x0: 8, x1: 347, top: 66, bottom: 79 } });
  assert.deepEqual(placeCaptions(groups, keep, 6, 15, 772), captionRows(groups, keep, 6, 15));
  assert.deepEqual(placeCaptions(groups, keep, 6, 15, 772), [55, 72]);
});

const measure10 = (words: string): number => words.length * 5.6;
const NOTE = 'Hyperliquid liquidations and stops at 21:45 · Powered by HyperTracker · with take profits';

test('on a short map the note under the legend ends above the volume strip\'s names: fewer lines, one at least (the phone held sideways, 844 x 207)', () => {
  const ph = 138, foot = stripNamesTop(ph, volumeBand(ph)), history = { x0: 196, x1: 334, top: 74 };
  assert.equal(foot, 102, 'the names\' plates start 4 px into the 34 px strip');
  // Under the "depth recorded from" note: one line (87 to 99); the second would run under "Binance 15m candles" (102 to 116).
  const low = layNote(measure10, NOTE, 368, { ph, under: 74, foot, history });
  assert.equal(low.top, 87);
  assert.equal(low.lines.length, 1, JSON.stringify(low.lines));
  // Without it, two lines fit above the names.
  const high = layNote(measure10, NOTE, 368, { ph, under: 74, foot, history: null });
  assert.deepEqual([high.top, high.lines.length], [74, 2]);
  // A tall map, or no strip: the lines as before.
  for (const [h, under] of [[646, 74], [800, 48], [138, 48]] as const) {
    const laid = layNote(measure10, NOTE, 260, { ph: h, under, foot: h, history: null });
    assert.deepEqual(laid.lines, noteLines(measure10, NOTE, 260, noteMostLines(h, under)), `${h}/${under}: unchanged without the strip`);
  }
  // Every map: at least one line, never more than before, and where there is more than one, the last ends above the names.
  for (let h = 90; h <= 700; h += 3) for (const under of [40, 54, 68, 74, 81]) for (const hist of [null, history]) {
    const f = stripNamesTop(h, volumeBand(h)), laid = layNote(measure10, NOTE, 300, { ph: h, under, foot: f, history: hist });
    assert.ok(laid.lines.length >= 1 && laid.lines.length <= noteMostLines(h, under), `${h}/${under}: ${laid.lines.length} lines`);
    if (laid.lines.length > 1) assert.ok(laid.top + 13 * (laid.lines.length - 1) + 12 <= f, `${h}/${under}${hist ? ' under the history note' : ''}: the last line ends above the names`);
    assert.deepEqual(laid.lines.join(' · ').replace('…', '').length > 0, true);
  }
});

/** A canvas that records the strip's names (the text it fills). */
function namesCtx(): { ctx: CanvasRenderingContext2D; texts: string[] } {
  const texts: string[] = [], grad = { addColorStop: () => undefined };
  const ctx = new Proxy({}, {
    get: (_t, k) => k === 'fillText' ? (s: string) => { texts.push(s); } : k === 'measureText' ? (s: string) => ({ width: s.length * 5.6 }) : k === 'createLinearGradient' ? () => grad
      : typeof k === 'string' && /^[a-z]/.test(k) && !['font', 'fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'textAlign', 'textBaseline'].includes(k) ? () => undefined : undefined,
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, texts };
}

test('where even one line of the note would reach the strip\'s names, the strip leaves the name under it out rather than print over the note', () => {
  const bars: StripBar[] = [0, 1, 2, 3].map(i => ({ t: i, x: 20 + i * 30, w: 20, buy: 100, sell: 50, source: 'candle', split: true, exact: true, trades: 0 } as unknown as StripBar));
  const draw = { pw: 392, ph: 120, height: 34, palette: PALETTES.dark!, bars: 'split' as const, emphasis: false, highlights: null, recorded: 'Volume · 15m', candles: 'Binance 15m candles', hovered: -1 };
  const top = stripNamesTop(120, 34);
  const shown = namesCtx(); paintVolumeStrip(shown.ctx, bars, draw);
  assert.deepEqual(shown.texts, ['Binance 15m candles'], 'drawn where nothing is in its way');
  const covered = namesCtx(); paintVolumeStrip(covered.ctx, bars, { ...draw, clear: { x0: 8, x1: 380, y0: top - 2, y1: top + 10 } });
  assert.deepEqual(covered.texts, [], 'left out under the note');
  const beside = namesCtx(); paintVolumeStrip(beside.ctx, bars, { ...draw, clear: { x0: 8, x1: 380, y0: top - 30, y1: top - 1 } });
  assert.deepEqual(beside.texts, ['Binance 15m candles'], 'a note that ends above the names leaves them');
});

/** A standing of `v` dollars in every one-dollar bin from 0 to 200, both sides. */
const standing = (v: number): LiqStanding => {
  const n = 200, long = new Float64Array(n + 1), short = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { long[i + 1] = long[i]! + v; short[i + 1] = short[i]! + v; }
  return { k: Int32Array.from({ length: n }, (_, i) => i), step: 1, long, short };
};
const parts = { liq: standing(41_000), stops: standing(17_000) };
const facts = (at: number): ProbeFacts => {
  const side = at >= 100 ? 'short' : 'long', d = Math.abs(at - 100);
  return { kind: 'both', side, at, price: 100, way: 58_000 * d, other: 58_000 * d, level: 58_000, lo: Math.floor(at), hi: Math.floor(at) + 1, positions: 12, top: 9_000, parts };
};
/** The boxes' text widths at 11 px: a sans label or sentence, bold a little wider, the monospaced values. */
const measure11 = (text: string, bold: boolean, kind: InfoKind): number => text.length * (kind === 'value' ? 6.6 : bold ? 6.4 : 5.9);
const sizeOf = (lines: ReturnType<typeof probeBoxLines>, W: number): BoxSize => { const l = layoutInfo(measure11, lines, probeWrap(W)); return { w: l.width, h: l.height }; };
const titleOf = (lines: ReturnType<typeof probeBoxLines>, W: number): string => layoutInfo(measure11, lines, probeWrap(W)).rows.filter(r => r.bold && r.label === undefined).map(r => r.text).join(' ').replace(/ /g, ' ');

test('under Everyone | +PnL each finger box names its own group; under Liquidations | Stops the kinds name them (no group added)', () => {
  const all = probeBoxLines(facts(110), { whose: groupName('all') }), theirs = probeBoxLines(facts(110), { whose: groupName('profitable') });
  assert.equal(titleOf(all, 330), 'Short liquidations and stops · Everyone');
  assert.equal(titleOf(theirs, 330), 'Short liquidations and stops · +PnL');
  assert.notEqual(titleOf(all, 330), titleOf(theirs, 330));
  assert.equal(titleOf(probeBoxLines(facts(90)), 330), 'Long liquidations and stops', 'no group: the title as before');
  // On the 260 px ladder of a 320 px phone a long title wraps, the group kept with the word before it, and at the detail the two boxes
  // are shown at the box stays on the ladder.
  const two = (d: number): [BoxSize, BoxSize] => [sizeOf(probeBoxLines(facts(110), { detail: d, whose: groupName('all') }), 260), sizeOf(probeBoxLines(facts(110), { detail: d, whose: groupName('profitable') }), 260)];
  const shown = probeDetail(two, 260, 253, PROBE_LEAST);
  for (const g of ['all', 'profitable'] as const) {
    const lines = probeBoxLines(facts(110), { detail: shown, whose: groupName(g) }), rows = layoutInfo(measure11, lines, probeWrap(260)).rows.filter(r => r.bold && r.label === undefined);
    assert.ok(rows.every(r => !/·$/.test(r.text.trim())), `no line ends on the dot: ${JSON.stringify(rows.map(r => r.text))}`);
    assert.ok(rows.some(r => r.text.replace(/ /g, ' ').endsWith(` · ${groupName(g)}`)), `the group named: ${JSON.stringify(rows.map(r => r.text))}`);
    assert.ok(sizeOf(lines, 260).w <= 260 - 4, `${g}: ${sizeOf(lines, 260).w} px wide on a 260 px ladder at detail ${shown}`);
  }
});

test('the finger\'s two boxes on a 320 x 568 phone\'s ladder (260 x 253) say less until they fit together: never one over the other', () => {
  const W = 260, H = 253, whose = [groupName('all'), groupName('profitable')] as const;
  for (let y = 2; y <= H - 2; y += 3) {
    const at = 100 + (H / 2 - y) / (H / 2) * 2.5;
    const lines = (i: 0 | 1, detail: number) => probeBoxLines(facts(at), { detail, whose: whose[i] });
    const sizes = (d: number): [BoxSize, BoxSize] => [sizeOf(lines(0, d), W), sizeOf(lines(1, d), W)];
    const d = probeDetail(sizes, W, H, PROBE_LEAST), s = sizes(d), [p, q] = placeProbeBoxes(s, y, W, H);
    assert.ok(probeBoxesFit(s, W, H), `finger ${y}: detail ${d} fits`);
    assert.ok(p && q && (p.y + s[0].h <= q.y || q.y + s[1].h <= p.y || p.x + s[0].w <= q.x || q.x + s[1].w <= p.x), `finger ${y}: apart at detail ${d} ${JSON.stringify([p, q, s])}`);
    assert.ok(p && q && [[p, s[0]], [q, s[1]]].every(([b, z]) => (b as { x: number; y: number }).x >= 2 && (b as { y: number }).y >= 2 && (b as { x: number }).x + (z as BoxSize).w <= W - 2 && (b as { y: number }).y + (z as BoxSize).h <= H - 2), `finger ${y}: on the ladder`);
  }
  // A ladder with room says everything; the full boxes are what a 390 px phone shows.
  const full = (W: number, H: number): number => probeDetail(d => [sizeOf(probeBoxLines(facts(110), { detail: d, whose: whose[0] }), W), sizeOf(probeBoxLines(facts(110), { detail: d, whose: whose[1] }), W)], W, H, PROBE_LEAST);
  assert.equal(full(330, 520), 0);
  assert.ok(full(260, 253) > 0, 'the 320 px phone says less');
});

test('a shorter finger box drops the count, the largest and the other side first, then the distance, then the level; a total of both keeps its two parts', () => {
  const texts = (d: number): string[] => probeBoxLines(facts(110), { detail: d }).map(l => l.label ?? l.text);
  const full = texts(0);
  assert.ok(full.includes('Positions and orders') && full.includes('Largest position or order') && full.includes('Same distance, other side') && full.includes('Distance'));
  assert.deepEqual(texts(1).filter(x => /Positions and orders|Largest position|Same distance/.test(x)), [], 'detail 1');
  assert.ok(texts(1).includes('Distance') && !texts(2).includes('Distance'), 'detail 2 leaves out the distance');
  assert.ok(texts(2).includes('At this level') && !texts(3).includes('At this level'), 'detail 3 leaves out the level');
  for (let d = 0; d <= PROBE_LEAST; d++) {
    const lines = probeBoxLines(facts(110), { detail: d });
    assert.ok(lines.some(l => l.label === 'If price gets here'), `${d}: the way there always`);
    lines.forEach((l, i) => { if (l.label === 'If price gets here' || l.label === 'At this level') assert.match(lines[i + 1]?.text ?? '', /^Total \$/, `${d}: the parts under ${l.label}`); });
  }
});

test('the map and the Liq tab use these: the keep-out of the corner buttons shown, the plates painted after the lines, the note by the strip, the boxes by detail', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8'), tab = fs.readFileSync('src/app/panes/liq-pane.ts', 'utf8');
  assert.match(heat, /'\.map-tools', '\.map-draw-phone'/, 'both corner elements are read');
  assert.match(heat, /cornerSpan\(/);
  assert.match(heat, /layNote\(measure, note, Math\.max\(40, pw - 24\), \{ ph, under, foot, history: this\.#historyNote \}\)/);
  assert.match(heat, /stripNamesTop\(ph, volumeBand\(ph\)\)/);
  assert.match(heat, /clear: state\.liqLevels\.on && this\.#liqNoteBox \?/);
  // After the price line, before the columns: no line, bar or candle is drawn over a plate.
  const overlay = heat.slice(heat.indexOf('  #paintOverlay(state: AppState): void {'), heat.indexOf('  #paintHoverLayer('));
  const price = overlay.indexOf('// The price line'), plates = overlay.indexOf('this.#paintLiqPlates(ctx'), column = overlay.indexOf('if (liqColumnShown(state)) this.#paintLiqColumn');
  assert.ok(price > 0 && plates > price && column > plates, `plates after the price line, before the columns: ${price} ${plates} ${column}`);
  assert.match(tab, /probeDetail\(/); assert.match(tab, /whose: pair\.split === 'groups'/);
});

// Sol's review of the phone polish (2026-11-20): three P2s, each failing on the code before its fix.
test('Sol 1 (P2): a finger box must fit the ladder\'s height too, side by side and alone; a wide short ladder says less', () => {
  // A 640 x 120 ladder had room across for two 287 x 152 boxes and kept them whole, each taller than the ladder.
  assert.equal(probeBoxesFit([{ w: 287, h: 152 }, { w: 287, h: 152 }], 640, 120), false);
  assert.equal(probeBoxesFit([{ w: 287, h: 56 }, { w: 287, h: 56 }], 640, 120), true);
  assert.equal(probeBoxesFit([{ w: 200, h: 150 }, null], 260, 120), false, 'a box alone taller than the ladder');
  assert.equal(probeBoxesFit([null, { w: 270, h: 60 }], 260, 120), false, 'a box alone wider than the ladder');
  assert.equal(probeBoxesFit([{ w: 200, h: 100 }, null], 260, 120), true);
  const W = 640, H = 120, whose = [groupName('all'), groupName('profitable')] as const;
  for (let y = 2; y <= H - 2; y += 2) {
    const at = 100 + (H / 2 - y) / (H / 2) * 2.5;
    const sizes = (d: number): [BoxSize, BoxSize] => [sizeOf(probeBoxLines(facts(at), { detail: d, whose: whose[0] }), W), sizeOf(probeBoxLines(facts(at), { detail: d, whose: whose[1] }), W)];
    const d = probeDetail(sizes, W, H, PROBE_LEAST), s = sizes(d), [p, q] = placeProbeBoxes(s, y, W, H);
    assert.ok(s.every(z => z.h <= H - 4 && z.w <= W - 4), `finger ${y}: detail ${d} gives boxes inside the ladder ${JSON.stringify(s)}`);
    assert.ok(p && q && [[p, s[0]], [q, s[1]]].every(([b, z]) => (b as { y: number }).y >= 2 && (b as { y: number }).y + (z as BoxSize).h <= H - 2), `finger ${y}: on the ladder`);
    assert.ok(p && q && (p.y + s[0].h <= q.y || q.y + s[1].h <= p.y || p.x + s[0].w <= q.x || q.x + s[1].w <= p.x), `finger ${y}: apart`);
  }
});

test('Sol 2 (P2): the plates keep clear of the volume strip\'s names, which they are painted over', () => {
  // The 392 x 138 landscape frame with the recording starting near x 280: "Volume · 15m" at 272 to 347 by 102 to 116, where the take
  // profits' plate stood (244 to 368 by 104 to 119).
  const f = FRAMES[0]!, names: Rect[] = [{ x0: 272, x1: 347, y0: 102, y1: 116 }];
  const keep = captionKeepOut({ corner: cornerSpan(f.corner, 0), legend: f.legend, history: f.history, note: f.note, names });
  const ys = placeCaptions(ranked(f), keep, 6, 15, f.plot.h);
  ys.forEach((y, i) => { if (y !== null) assert.ok(!over(plate(f.items[i]!.x, f.items[i]!.w, y), names[0]!), `plate ${i} at ${y} over the strip's name`); });
  // Liquidations under the Draw key, Stops under the name; no room is left for the take profits' plate, whose lane still answers the pointer.
  assert.deepEqual(ys, [null, 48, 118]);
  // The note under the legend stays the last keep-out (the old rows check it again), the names before it, 2 px round them.
  assert.deepEqual(keep.at(-2), { x0: 270, x1: 349, y0: 100, y1: 118 });
  assert.equal(keep.at(-1)!.y0, f.note.top);
});

test('Sol 3 (P2): no plate is placed past the plot\'s foot; where one has no room, the split\'s lanes keep theirs and the take profits\' goes', () => {
  // The landscape frame on a 120 px plot: Stops stood at 121, under the time axis that paints over it.
  const f = FRAMES[0]!, keep = keepOf(f);
  assert.deepEqual(placeCaptions(ranked(f), keep, 6, 15, 120), [null, 48, 103]);
  // Everywhere: whatever is placed is inside the plot, clear of the keep-outs and of each other.
  for (const g of FRAMES) for (let ph = 40; ph <= 260; ph += 3) {
    const ys = placeCaptions(ranked(g), keepOf(g), 6, 15, ph), plates = ys.flatMap((y, i) => y === null ? [] : [plate(g.items[i]!.x, g.items[i]!.w, y)]);
    plates.forEach((p, i) => {
      assert.ok(p.y1 <= ph, `${g.name} on ${ph} px: a plate past the foot at ${p.y0}`);
      for (const r of keepOf(g)) assert.ok(!over(p, r), `${g.name} on ${ph} px: over a keep-out`);
      plates.slice(0, i).forEach(q => assert.ok(!over(p, q), `${g.name} on ${ph} px: plates overlap`));
    });
  }
  // A plot with room keeps every plate, in the order given (the frames' own heights above).
  assert.deepEqual(placeCaptions(ranked(f), keep, 6, 15, 138), [104, 48, 121]);
});

test('the strip says where it printed its names, and the map keeps the plates off them and places them after the strip is drawn', () => {
  const bars: StripBar[] = [0, 1, 2, 3].map(i => ({ t: i, x: 20 + i * 30, w: 20, buy: 100, sell: 50, source: 'candle', split: true, exact: true, trades: 0, i: -1 } as StripBar));
  const draw = { pw: 392, ph: 120, height: 34, palette: PALETTES.dark!, bars: 'split' as const, emphasis: false, highlights: null, recorded: 'Volume · 15m', candles: 'Binance 15m candles', hovered: -1 };
  const top = stripNamesTop(120, 34), shown = paintVolumeStrip(namesCtx().ctx, bars, draw);
  assert.deepEqual(shown, [{ x0: 10, x1: 10 + 'Binance 15m candles'.length * 5.6 + 8, y0: top, y1: top + 14 }]);
  assert.deepEqual(paintVolumeStrip(namesCtx().ctx, bars, { ...draw, clear: { x0: 8, x1: 380, y0: top - 2, y1: top + 10 } }), [], 'a name left out is not reported');
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  assert.match(heat, /this\.#stripNames = paintVolumeStrip\(ctx, bars,/);
  assert.match(heat, /names: this\.#stripNames/);
  assert.match(heat, /rank: item\.dashed \? 1 : 0/, 'the take profits\' plate goes first where one must');
});
