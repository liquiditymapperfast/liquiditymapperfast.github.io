import test from 'node:test';
import assert from 'node:assert/strict';
import { alignRows, chooseFit, sameFit } from '../src/app/ui/fit-grid.ts';

const cells = (...w: number[]) => w.map(width => ({ width }));

test('everything on the identity line when it fits there, a grid of its own when it does not', () => {
  const one = chooseFit(cells(80, 60, 70), 400, 8, 260);
  assert.equal(one.inline, true);
  assert.equal(one.lead, 3);
  assert.equal(one.rows, 0, 'no row under the identity line');
  const grid = chooseFit(cells(80, 60, 70), 400, 8, 200);
  assert.equal(grid.inline, false);
  assert.equal(grid.cols, 3, 'all three side by side under it');
});

test('the first cells join the identity line when that saves a row under it', () => {
  // Seven cells of 100 px in 420 px: three rows of 3 + 3 + 1 under the line, or two once one or two of them sit on the line (210 px free).
  const fit = chooseFit(cells(100, 100, 100, 100, 100, 100, 100), 420, 8, 210);
  assert.equal(fit.rows, 2);
  assert.ok(fit.lead === 1 || fit.lead === 2, `lead ${fit.lead}`);
  assert.equal(fit.spans.slice(0, fit.lead).every(s => s === 1), true);
  // Never more on the line than fits there.
  assert.equal(chooseFit(cells(100, 100, 100, 100, 100, 100, 100), 420, 8, 90).lead, 0);
});

test('the fewest rows that fit, in aligned columns; the last row has no hole: its cells share the spare columns', () => {
  const fit = chooseFit(cells(80, 80, 80, 80, 80, 80, 80), 400, 8);
  assert.equal(fit.cols, 4);
  assert.equal(fit.rows, 2, '4 + 3, never 6 + 1 or 5 + 2 that does not fit');
  assert.deepEqual(fit.spans, [1, 1, 1, 1, 1, 1, 2], 'the last cell takes the column the last row leaves over');
});

test('a lone cell on the last row is avoided when another column count costs no extra row', () => {
  // Four columns fit (424 px) but leave the fifth cell alone; three columns fit in two rows as well, 3 + 2.
  const fit = chooseFit(cells(100, 100, 100, 100, 100), 430, 8);
  assert.equal(fit.rows, 2);
  assert.equal(fit.cols, 3);
  assert.deepEqual(fit.spans, [1, 1, 1, 1, 2]);
});

test('a lone cell is accepted when avoiding it would cost a row', () => {
  // Three cells: two columns give 2 + 1, one column three rows. Fewer rows win.
  const fit = chooseFit(cells(150, 150, 150), 320, 8);
  assert.equal(fit.rows, 2);
  assert.deepEqual(fit.spans, [1, 1, 2], 'and it spans the row, so it reads as one wide control, not a stray');
});

test('a cell that asks for a row gets one, the others are laid out around it', () => {
  const fit = chooseFit([{ width: 300, row: true }, { width: 60 }, { width: 60 }], 280, 8);
  assert.equal(fit.rows, 2);
  assert.equal(fit.spans[0], fit.cols, 'the strip spans every column');
  const flow = chooseFit([{ width: 300, row: true }], 250, 8, 100);
  assert.equal(flow.inline, false);
  assert.equal(flow.rows, 1);
  assert.equal(chooseFit([{ width: 300, row: true }], 250, 8, 320).inline, true, 'and sits on the identity line when it fits there');
});

test('a cell wider than the grid still gets a place, one column; columns take the widest cell of each', () => {
  assert.equal(chooseFit(cells(500, 40), 300, 8).cols, 1);
  // Column widths 200 + 50: two columns need 258 px, which fits 260.
  assert.equal(chooseFit(cells(200, 50, 40, 50), 260, 8).cols, 2);
  assert.equal(chooseFit(cells(200, 50, 40, 50), 250, 8).cols, 1);
});

test('captions of a column take its widest caption, so its controls start together; the column is made wide enough for that', () => {
  const cap = (caption: number, control: number) => ({ width: caption + 5 + control, cap: { caption, gap: 5, control } });
  // Column 1: "Mode" 30 + select 100, "Venue lines" 60 + select 60. Widest cells 135 and 125, but aligned they need 60 + 5 + 100.
  const fit = chooseFit([cap(30, 100), { width: 90 }, cap(60, 60), { width: 90 }], 270, 8);
  assert.equal(fit.cols, 2, '165 + 8 + 90 = 263 fits 270');
  assert.deepEqual(fit.caps, [60, 0, 60, 0]);
  const tight = chooseFit([cap(30, 100), { width: 90 }, cap(60, 60), { width: 90 }], 250, 8);
  assert.equal(tight.cols, 2, 'where the aligned column would not fit, the captions keep their own widths rather than cost a row (135 + 8 + 90)');
  assert.deepEqual(tight.caps, [0, 0, 0, 0]);
  // A last row whose cells span: each caption takes the column it starts in.
  const last = chooseFit([cap(10, 50), cap(20, 50), cap(30, 50), cap(40, 50), cap(25, 50)], 300, 8);
  assert.equal(last.cols, 3);
  assert.deepEqual(last.spans, [1, 1, 1, 1, 2]);
  assert.deepEqual(last.caps, [40, 25, 30, 40, 25], 'the fifth spans the second and third columns and shares the second column\'s caption');
  // A spanning cell wider than its columns widens them rather than spilling out of the grid.
  const wide = chooseFit([{ width: 50 }, { width: 50 }, { width: 200 }], 200, 8);
  assert.equal(wide.cols, 2, '50 + 142 + 8: the second column grows by what the third cell lacks');
  assert.deepEqual(wide.spans, [1, 1, 2]);
});

test('where aligned columns cannot save the rows, the cells are packed row by row instead', () => {
  // 130 + 80 and 150 + 60 fit a row of 220 px, but two aligned columns (150 + 8 + 80) do not: one column would take five rows.
  const fit = chooseFit(cells(130, 80, 150, 60, 120), 220, 8);
  assert.equal(fit.packed, true);
  assert.equal(fit.rows, 3, '130 + 80, 150 + 60, 120');
  assert.equal(chooseFit(cells(100, 100, 100, 100), 220, 8).packed, false, 'two aligned columns do as well: aligned');
});

test('aligned captions that would make even one column wider than the grid are dropped, not spilled past its edge', () => {
  const cap = (caption: number, control: number) => ({ width: caption + 5 + control, cap: { caption, gap: 5, control } });
  // Long captions with short selects and short captions with long selects: each cell fits 240 px, the aligned column (110 + 5 + 150) does not.
  const fit = chooseFit([cap(110, 60), cap(40, 150), cap(100, 70)], 240, 8);
  assert.equal(fit.cols, 1);
  assert.deepEqual(fit.caps, [0, 0, 0]);
});

test('a row cell between plain cells: each run on rows of its own, the counts and spans as the grid places them', () => {
  // [a][ROW][b][c][d], 200 px, two columns of 80: a alone (spanning both), the strip, then b c / d spanning both: four rows.
  const fit = chooseFit([{ width: 80 }, { width: 300, row: true }, { width: 80 }, { width: 80 }, { width: 80 }], 200, 8);
  assert.equal(fit.cols, 2);
  assert.equal(fit.rows, 4);
  assert.deepEqual(fit.spans, [2, 2, 1, 1, 2]);
  // Every run's rows sum to the column count, so no row has a hole and nothing wraps where the chooser did not count a row.
});

test('the deck aligner counts its ways before making them: long rows fall back at once', () => {
  const t0 = Date.now();
  const r = alignRows([new Array(30).fill(40), new Array(15).fill(40)], 4);
  assert.ok(Date.now() - t0 < 500, 'no millions of candidates');
  assert.equal(r.spans[1]!.reduce((a, b) => a + b, 0), 30, 'the short row still fills every column');
  assert.equal(alignRows([[100, 100], [103, 97]], 4).width > alignRows([[100, 100], [103, 97]], 4).natural, true, 'aligning these costs width (the toolbar then only stretches them)');
});

test('nothing to place is an empty grid; two layouts are the same when their columns and spans are', () => {
  assert.equal(chooseFit([], 300, 8).rows, 0);
  assert.equal(sameFit(chooseFit(cells(80, 80), 400, 8), chooseFit(cells(81, 79), 400, 8)), true);
  assert.equal(sameFit(chooseFit(cells(80, 80), 400, 8), chooseFit(cells(80, 80), 100, 8)), false);
});

test('rows of a deck: as many columns as its longest row, each as wide as its widest control; a shorter row\'s spare column where it costs least', () => {
  // The Chart deck: five switches over four. The first of the four spanning two columns costs nothing (110 fits 90 + 4 + 70); the last
  // spanning two would make the first column 110 wide.
  const chart = alignRows([[90, 70, 100, 80, 95], [110, 85, 60, 75]], 4);
  assert.deepEqual(chart.spans, [[1, 1, 1, 1, 1], [2, 1, 1, 1]]);
  assert.deepEqual(chart.cols, [90, 70, 100, 80, 95]);
  assert.equal(chart.width, chart.natural, 'aligned at no cost');
  // When it is all the same, the last control takes the spare column.
  assert.deepEqual(alignRows([[50, 50, 50], [50, 50]], 4).spans[1], [1, 2]);
  // The Alerts deck: one switch over two; the one on its own spans both, and widens the second column if it needs to.
  const alerts = alignRows([[200], [90, 80]], 4);
  assert.deepEqual(alerts.spans, [[2], [1, 1]]);
  assert.deepEqual(alerts.cols, [90, 106], '90 + 4 + 106 = 200');
  // Rows as long as each other whose controls differ: aligning costs width (the Heatmap deck's).
  const heat = alignRows([[96, 96, 104], [120, 60, 100]], 4);
  assert.equal(heat.width - heat.natural, 24, '120 + 96 + 104 against 96 + 96 + 104 (gaps alike), the first column taking the wider of its two');
  assert.deepEqual(alignRows([], 4).cols, [0]);
});
