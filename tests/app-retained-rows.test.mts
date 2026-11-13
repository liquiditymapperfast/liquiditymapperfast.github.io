import test from 'node:test';
import assert from 'node:assert/strict';
import { RetainedRows, type RowItem } from '../src/app/panes/retained-rows.ts';

/** A canvas context that records what `plan` does to the canvas: fills and the self-copy (its vertical shift in device pixels). */
function fakeCtx(width: number, height: number) {
  const log: string[] = [];
  const ctx = {
    canvas: { width, height }, fillStyle: '',
    setTransform: () => {},
    fillRect: (x: number, y: number, w: number, h: number) => { log.push(`fill ${x},${y},${w},${h}`); },
    drawImage: (_src: unknown, _sx: number, _sy: number, _sw: number, _sh: number, _dx: number, dy: number) => { log.push(`shift ${dy}`); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}
const rows = (...spec: [string, number, number, boolean?][]): RowItem[] => spec.map(([sig, y, h, fixed]) => ({ sig, y, h, fixed }));
const drawn = (items: RowItem[], draw: boolean[]): string[] => items.filter((_, i) => draw[i]).map(it => it.sig);

test('kept rows: the first frame draws everything; the same rows again draw nothing and do not move the canvas', () => {
  const r = new RetainedRows(), { ctx, log } = fakeCtx(100, 90);
  const a = rows(['a', 0, 30], ['b', 30, 30], ['c', 60, 30]);
  assert.deepEqual(drawn(a, r.plan(ctx, 'L', a, 1, 90, '#000', 90)), ['a', 'b', 'c']);
  assert.equal(log[0], 'fill 0,0,100,90'); assert.equal(r.wholeFrames, 1);
  log.length = 0;
  assert.deepEqual(drawn(a, r.plan(ctx, 'L', a, 1, 90, '#000', 90)), []);
  assert.equal(r.lastShift, 0); assert.ok(!log.some(l => l.startsWith('shift')));
});

test('kept rows: a new row on top shifts the canvas by its height and draws it and the row the shift pushed across the bottom edge', () => {
  const r = new RetainedRows(), { ctx, log } = fakeCtx(100, 90);
  r.plan(ctx, 'L', rows(['a', 0, 30], ['b', 30, 30], ['c', 60, 30]), 1, 90, '#000', 90);
  log.length = 0;
  const b = rows(['n', 0, 24], ['a', 24, 30], ['b', 54, 30], ['c', 84, 30]);
  // `c` now crosses the bottom edge: a browser draws a row crossing an edge otherwise than the same row moved there, so it is drawn.
  assert.deepEqual(drawn(b, r.plan(ctx, 'L', b, 1, 90, '#000', 90)), ['n', 'c']);
  assert.equal(r.lastShift, 24); assert.ok(log.includes('shift 24'));
  // The strip the shift uncovered at the top is cleared before the new row is drawn over it.
  assert.ok(log.includes('fill 0,0,100,24'));
  // Holding still, the cut row is kept.
  assert.deepEqual(drawn(b, r.plan(ctx, 'L', b, 1, 90, '#000', 90)), []);
});

test('kept rows: a scroll draws the rows it moves into or along an edge; a row cut by the top is drawn every frame', () => {
  const r = new RetainedRows(), { ctx } = fakeCtx(100, 90);
  r.plan(ctx, 'L', rows(['a', 0, 30], ['b', 30, 30], ['c', 60, 40]), 1, 90, '#000', 100);
  const up = rows(['a', -10, 30], ['b', 20, 30], ['c', 50, 40]);
  // `a` moved across the top edge, `c` along the bottom one (and shows 10 px it never drew): both drawn; `b` is kept.
  assert.deepEqual(drawn(up, r.plan(ctx, 'L', up, 1, 90, '#000', 90)), ['a', 'c']);
  // `a` is cut by the top now: drawn each frame while it stays there (it is not remembered).
  assert.deepEqual(drawn(up, r.plan(ctx, 'L', up, 1, 90, '#000', 90)), ['a']);
});

test('kept rows: a changed signature, a stretch drawn over (damage) and a fixed banner draw those rows again', () => {
  const r = new RetainedRows(), { ctx } = fakeCtx(100, 90);
  r.plan(ctx, 'L', rows(['a', 0, 30], ['b', 30, 30], ['c', 60, 30]), 1, 90, '#000', 90);
  // A box drawn over b and c this frame: they are drawn again next frame.
  r.damage(40, 70);
  const same = rows(['a', 0, 30], ['b', 30, 30], ['c', 60, 30]);
  assert.deepEqual(drawn(same, r.plan(ctx, 'L', same, 1, 90, '#000', 90)), ['b', 'c']);
  // b changed (the pointer outlines it): only b.
  const outlined = rows(['a', 0, 30], ['b|o', 30, 30], ['c', 60, 30]);
  assert.deepEqual(drawn(outlined, r.plan(ctx, 'L', outlined, 1, 90, '#000', 90)), ['b|o']);
  // A fixed note over the top: drawn every frame, and the rows under it are drawn again the frame after a shift brings others there.
  const noted = rows(['a', 0, 30], ['b|o', 30, 30], ['c', 60, 30], ['x', 0, 22, true]);
  assert.deepEqual(drawn(noted, r.plan(ctx, 'L', noted, 1, 90, '#000', 90)), ['x']);
  const shifted = rows(['n', 0, 24], ['a', 24, 30], ['b|o', 54, 30], ['c', 84, 30], ['x', 0, 22, true]);
  assert.deepEqual(drawn(shifted, r.plan(ctx, 'L', shifted, 1, 90, '#000', 90)), ['n', 'a', 'c', 'x']);
});

test('kept rows: a new look, an edge off the device-pixel grid or a reset draws the whole frame', () => {
  const r = new RetainedRows(), { ctx } = fakeCtx(125, 113);
  const a = rows(['a', 0, 24], ['b', 24, 24]);
  r.plan(ctx, 'L', a, 1.25, 90, '#000', 48);
  assert.deepEqual(drawn(a, r.plan(ctx, 'L2', a, 1.25, 90, '#000', 48)), ['a', 'b']);
  // 26 CSS px at 1.25 is 32.5 device px: off the grid, so no row is kept.
  const off = rows(['a', 0, 26], ['b', 26, 24]);
  r.plan(ctx, 'L2', off, 1.25, 90, '#000', 50);
  assert.deepEqual(drawn(off, r.plan(ctx, 'L2', off, 1.25, 90, '#000', 50)), ['a', 'b']);
  r.reset();
  assert.deepEqual(drawn(a, r.plan(ctx, 'L2', a, 1.25, 90, '#000', 48)), ['a', 'b']);
});

test('kept rows in device pixels (the order list): rows on whole device pixels at any ratio are kept and shifted', () => {
  // The order list lays rows out in device pixels (its ratio's heights rounded: 26 CSS px at 2.625 is 68) and plans at ratio 1.
  const r = new RetainedRows(), { ctx, log } = fakeCtx(1079, 2216);
  const a = rows(['a', 0, 68], ['b', 68, 63], ['c', 131, 79]);
  r.plan(ctx, 'L', a, 1, 2216, '#000', 210);
  log.length = 0;
  const b = rows(['n', 0, 63], ['a', 63, 68], ['b', 131, 63], ['c', 194, 79]);
  assert.deepEqual(drawn(b, r.plan(ctx, 'L', b, 1, 2216, '#000', 273)), ['n']);
  assert.ok(log.includes('shift 63'));
  // Below the rows is cleared from the last row's end.
  assert.ok(log.includes('fill 0,273,1079,1943'));
});
