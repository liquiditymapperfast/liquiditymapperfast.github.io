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

test('only the cells marked for the identity line join it, all of them or none; a marked cell that does not fit takes a whole row', () => {
  const marked = [{ width: 100, lead: true }, { width: 100 }, { width: 100 }, { width: 100 }];
  const fit = chooseFit(marked, 420, 8, 210);
  assert.equal(fit.lead, 1, 'the marked cell, not the first two that would fit');
  assert.equal(fit.rows, 1, 'the other three in one row');
  const narrow = chooseFit(marked, 420, 8, 90);
  assert.equal(narrow.lead, 0, 'never more on the line than fits there');
  assert.deepEqual(narrow.spans, [3, 1, 1, 1], 'the mode spans the grid\'s row above the tiles');
  assert.equal(narrow.rows, 2);
  assert.equal(chooseFit(cells(100, 100, 100, 100), 420, 8, 210).lead, 0, 'unmarked cells stay in the grid unless every one fits on the line');
  assert.equal(chooseFit(marked, 420, 8, 430).inline, true);
  const two = [{ width: 100, lead: true }, { width: 100, lead: true }, { width: 100 }];
  assert.equal(chooseFit(two, 420, 8, 150).lead, 0);
  assert.equal(chooseFit(two, 420, 8, 208).lead, 2);
});

test('tiles: as many as fit at the widest tile\'s width, shared out evenly over the rows; all of one width', () => {
  // Four selects whose tiles are at most 110 px: 4 to a row from 464 px, then 2 + 2 (3 would fit but leave one alone), then 1.
  const four = (avail: number) => chooseFit([{ width: 160, tile: 90 }, { width: 170, tile: 80 }, { width: 190, tile: 110 }, { width: 150, tile: 70 }], avail, 8);
  assert.equal(four(464).cols, 4);
  assert.equal(four(463).cols, 2, '3 to a row would leave a lone tile');
  assert.equal(four(463).rows, 2);
  assert.equal(four(228).cols, 2);
  assert.equal(four(227).cols, 1);
  assert.deepEqual(four(464).spans, [1, 1, 1, 1], 'a tile spans one column; the grid makes every column as wide');
  // A tile is as wide as the wider of its caption and its select: the width beside does not count.
  assert.equal(chooseFit([{ width: 300, tile: 100 }, { width: 300, tile: 100 }], 210, 8).cols, 2);
  // Without a tile width, a cell's own width is its tile's.
  assert.equal(chooseFit(cells(100, 100), 210, 8).cols, 2);
  assert.equal(chooseFit(cells(500, 40), 300, 8).cols, 1, 'a tile wider than the grid still gets a place, alone in its row');
});

test('a cell that asks for a row gets one, the tiles are laid out around it', () => {
  const fit = chooseFit([{ width: 300, row: true }, { width: 60 }, { width: 60 }], 280, 8);
  assert.equal(fit.rows, 2);
  assert.equal(fit.spans[0], fit.cols, 'the strip spans every column');
  const flow = chooseFit([{ width: 300, row: true }], 250, 8, 100);
  assert.equal(flow.inline, false);
  assert.equal(flow.rows, 1);
  assert.equal(chooseFit([{ width: 300, row: true }], 250, 8, 320).inline, true, 'and sits on the identity line when it fits there');
  // [a][ROW][b][c][d], 200 px, two tiles of 80 to a row: a, the strip, then b c / d: four rows.
  const runs = chooseFit([{ width: 80 }, { width: 300, row: true }, { width: 80 }, { width: 80 }, { width: 80 }], 200, 8);
  assert.equal(runs.cols, 2);
  assert.equal(runs.rows, 4);
  assert.deepEqual(runs.spans, [1, 2, 1, 1, 1]);
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
  assert.equal(chooseFit([], 300, 8).inline, true, 'a header with every cell hidden is its identity line alone');
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
