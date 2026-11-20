// The profile column's Mirror box stands beside the profile column (Karl, 2026-11-20: hovering the book's cumulative column popped the box up
// at the map's edge, a whole liquidation column away from the pointer).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mirrorLines, mirrorStats, paintMirrorBox } from '../src/app/mirror.ts';
import { PALETTES } from '../src/app/theme.ts';
import { INFO, measureInfoBox } from '../src/app/infobox.ts';
import { readLiqLevels } from '../src/app/liq-url.ts';
import { initialState, type AppState } from '../src/app/store.ts';
import { PROFILE_STRIP_W, PROFILE_W, liqSplitDrawn, profileBoxFrame, profileColumnW, setCompactGutters } from '../src/app/panes/heat-pane.ts';
import { SPLIT_COLUMN_W } from '../src/app/liq-split.ts';
import { plus } from '../src/app/plus/pass.ts';

const DAY = 86_400_000;
const standInPass = (exp: number): string => `v1.${Buffer.from(JSON.stringify({ sub: 'standin', exp })).toString('base64url')}.sig`;
function withPlus<T>(run: () => T): T {
  const now = Date.now();
  plus().accept({ key: 'standin-key-0123456789', pass: standInPass(now + 23 * 3_600_000), until: now + 20 * DAY });
  try { return run(); } finally { plus().forget(); }
}
/** A canvas that measures six pixels a character and draws nothing. */
const ctx = new Proxy({}, { get: (_t, k) => k === 'measureText' ? (s: string) => ({ width: s.length * 6 }) : () => {}, set: () => true }) as unknown as CanvasRenderingContext2D;
const p = PALETTES.terminal!;
const pick = (): string => p.text;
/** Karl's box: the bids side hovered 12,100 below 58,979.9. */
const lines = mirrorLines(mirrorStats(58_979.9, 46_879.9, 152.8e6, 412e6)!, { above: 'Asks', below: 'Bids' });
const stateWith = (liq: Partial<{ column: boolean; split: 'kinds' }>): AppState => {
  const base = initialState();
  return { ...base, show: { ...base.show, profile: true, mirror: true, traded: false },
    liqLevels: readLiqLevels({ column: liq.column ?? true, liq: true, stops: liq.split === 'kinds', ...(liq.split ? { split: liq.split } : {}) }) } as AppState;
};
const PW = 487, PH = 876, HEAD = 85;
/** The box for a pointer on the profile column at `y`, as the map draws it (`#paintProfile`), on a map `ph` tall under a heading `head` tall. */
function boxAt(state: AppState, y: number, placement: 'down' | 'up', pw = PW, ph = PH, head = HEAD, shown = lines): { rect: { x: number; y: number; w: number; h: number }; frame: ReturnType<typeof profileBoxFrame> } {
  const frame = profileBoxFrame(state, pw, ph, head, measureInfoBox(ctx, shown).h);
  const rect = paintMirrorBox(ctx, shown, frame.x, y, frame.bounds, p, pick, placement)!;
  return { rect, frame };
}

test('beside a liquidation column the box stands against the profile column\'s left edge, over the liquidation column, not at the map\'s edge', () => {
  setCompactGutters(false, 1500);
  try {
    const state = stateWith({});
    const columnLeft = PW + PROFILE_W, columnRight = columnLeft + profileColumnW(state);
    for (const [y, placement] of [[700, 'up'], [200, 'down'], [440, 'up']] as const) {
      const { rect, frame } = boxAt(state, y, placement);
      assert.equal(frame.x, columnLeft, 'pointing at the profile column');
      const right = rect.x + rect.w;
      assert.ok(right <= columnLeft - 2, `never over the profile column, its band or the price axis (right edge ${right})`);
      assert.ok(right >= columnLeft - 14 - 2, `right beside the column hovered (right edge ${right}, column at ${columnLeft})`);
      assert.ok(right > PW, 'over the liquidation column, not left of it at the map\'s edge');
      assert.ok(rect.x >= 0 && right < columnRight, 'inside the window');
    }
  } finally { setCompactGutters(false, 2000); }
});

test('over the liquidation column the box keeps below that column\'s heading, whose button and History link lie over the canvas', () => {
  setCompactGutters(false, 1500);
  try {
    const state = stateWith({});
    for (const y of [4, 30, 60]) {
      const { rect } = boxAt(state, y, 'down');
      assert.ok(rect.y >= HEAD, `a pointer at ${y}: the box starts at ${rect.y}, below the heading`);
    }
    // A short map keeps the whole heading clear where the box fits under it: a split's heading is 97 px (the History link at 77-93 px), on a
    // 218 px map (Sol, review 2026-11-20: a cap at a third of the map put the box's first line under the link).
    for (const y of [4, 60, 150]) {
      const { rect } = boxAt(state, y, 'down', PW, 218, 97);
      assert.ok(rect.y >= 97 && rect.y + rect.h <= 218, `a pointer at ${y} on a 218 px map: the box spans ${rect.y}-${rect.y + rect.h}`);
    }
    // Too short for that: the box keeps inside the plot, from its top as before, and never runs under the time axis (a 140 px map pane
    // leaves a 118 px plot; the box with its "outside the data" line is 88 px tall).
    const clipped = mirrorLines(mirrorStats(58_979.9, 46_879.9, 152.8e6, 412e6, true)!, { above: 'Asks', below: 'Bids' });
    for (const y of [4, 60, 110]) {
      const { rect, frame } = boxAt(state, y, 'down', PW, 118, 97, clipped);
      assert.equal(frame.bounds.y0, 0);
      assert.ok(rect.y >= 2 && rect.y + rect.h <= 118 - 2, `a pointer at ${y} on a 118 px map: the box spans ${rect.y}-${rect.y + rect.h}`);
    }
  } finally { setCompactGutters(false, 2000); }
});

test('beside a split liquidation column (Plus) the box still stands against the profile column', () => {
  withPlus(() => {
    setCompactGutters(false, 1500);
    try {
      const state = stateWith({ split: 'kinds' });
      assert.equal(liqSplitDrawn(state), true, 'the column is drawn split here');
      const { rect, frame } = boxAt(state, 700, 'up');
      assert.equal(frame.x, PW + SPLIT_COLUMN_W);
      const right = rect.x + rect.w;
      assert.ok(right <= frame.x - 2 && right >= frame.x - 16, `right beside the profile column (right edge ${right}, column at ${frame.x})`);
    } finally { setCompactGutters(false, 2000); }
  });
});

test('a compact map\'s two strips: the box stays where it was, inside the map against its edge, one 16 px strip from the book\'s', () => {
  setCompactGutters(true, 390);
  try {
    const state = stateWith({});
    assert.equal(profileColumnW(state), PROFILE_STRIP_W);
    const pw = 390 - 58 - 2 * PROFILE_STRIP_W;
    const { rect, frame } = boxAt(state, 500, 'up', pw);
    assert.deepEqual(frame, { x: pw + PROFILE_STRIP_W, bounds: { x0: 0, y0: 0, x1: pw, y1: PH } }, 'no heading on the strip; not a sliver over the liquidation strip');
    const right = rect.x + rect.w;
    assert.equal(right, pw - 2, 'against the map\'s edge, beside the strips');
    assert.ok(rect.x >= 0);
  } finally { setCompactGutters(false, 2000); }
});

test('with no liquidation column the box is where it always was: against the map\'s edge, beside the profile column', () => {
  setCompactGutters(false, 1500);
  try {
    const state = stateWith({ column: false });
    const { rect, frame } = boxAt(state, 700, 'up');
    assert.deepEqual(frame, { x: PW, bounds: { x0: 0, y0: 0, x1: PW, y1: PH } }, 'the frame the map always gave it');
    assert.equal(rect.x + rect.w, PW - 14, 'the usual gap from the pointer\'s side');
    assert.equal(rect.y + rect.h, 700 - 14);
    assert.ok(rect.h > INFO.pad);
  } finally { setCompactGutters(false, 2000); }
});

test('the map draws the profile column\'s box in that frame', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  const start = heat.indexOf('  #paintProfile(ctx'), end = heat.indexOf('\n  }\n', start);
  assert.ok(start > 0 && end > start);
  const body = heat.slice(start, end);
  assert.match(body, /const frame = profileBoxFrame\(state, pw, ph, this\.#liqHeadH, measureInfoBox\(ctx, box\.lines\)\.h\);/);
  assert.match(body, /paintMirrorBox\(ctx, box\.lines, frame\.x, box\.y, frame\.bounds,/);
});
