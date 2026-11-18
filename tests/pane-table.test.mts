import test from 'node:test';
import assert from 'node:assert/strict';
import { PaneTable, paintTable, placeTable, ratioCell, ratioFigure, sideRatio, type TableCell, type TableRoom, type TableSpec } from '../src/app/panes/pane-table.ts';
import { fundingAt, type FundingNow, type FundingRow } from '../src/app/funding.ts';
import { fundingTableRows } from '../src/app/panes/funding-pane.ts';
import { lsTableRows } from '../src/app/panes/ls-pane.ts';
import { bookNames, depthTableRows, ltHeads, ltRank, ltRowsAt, ltTableRows, oiTableRows } from '../src/app/panes/lower-panes.ts';
import type { LtParts } from '../src/app/lt.ts';
import { deltaRow, deltaTableRows } from '../src/app/panes/delta-pane.ts';
import { tableRowCap } from '../src/app/panes/pane-table.ts';
import { foldCount } from '../src/app/pane-tune.ts';
import type { Market } from '../src/app/store.ts';
import { oiVenuesAt, sumOi, type OiPart } from '../src/app/oi-change.ts';
import type { OiBar } from '../src/app/store.ts';
import type { LsSeries } from '../src/shared/long-short.ts';
import { readSettings } from '../src/app/store.ts';

/** Every character five pixels wide. */
const measure = (text: string): number => text.length * 5;
const room = (over: Partial<TableRoom> = {}): TableRoom => ({ w: 700, h: 140, plotW: 400, axisW: 60, pointing: false, ...over });
const cells = (...texts: string[]): TableCell[] => texts.map(text => ({ text }));
const spec = (rows = 5, minCols = 3): Pick<TableSpec, 'heads' | 'rows' | 'minCols'> => ({ heads: ['', 'Longs', 'Shorts', 'Diff'], minCols, rows: Array.from({ length: rows }, () => cells('name', '123', '456', '+789')) });

test('a table goes beside the plot where it has the room, the last columns going first, and on a plate only under a pointer', () => {
  // Widths 20 + 25 + 30 + 20 = 95, three gaps of 7, two pads of 5: 126 for all four, 99 without the last.
  const four = placeTable(measure, room({ w: 400 + 60 + 130 }), spec())!;
  assert.deepEqual([four.cols, four.left, four.plate, four.width], [4, 404, false, 126]);
  const three = placeTable(measure, room({ w: 400 + 60 + 110 }), spec())!;
  assert.deepEqual([three.cols, three.left, three.plate, three.width], [3, 404, false, 99]);
  assert.equal(placeTable(measure, room({ w: 400 + 60 + 90 }), spec()), null, 'no room beside the plot and no pointer: nothing covers the chart at rest');
  const plate = placeTable(measure, room({ w: 400 + 60 + 90, pointing: true }), spec())!;
  assert.deepEqual([plate.cols, plate.left, plate.plate, plate.width], [4, 6, true, 126], 'under a pointer it goes over the left end, with every column');
  assert.equal(placeTable(measure, room({ w: 150 + 60, plotW: 150, pointing: true }), spec()), null, 'wider than 60 % of the plot: no plate');
  // Columns may go down to `minCols` and no further.
  assert.equal(placeTable(measure, room({ w: 400 + 60 + 72 }), spec(5, 2))!.cols, 2);
  assert.equal(placeTable(measure, room({ w: 400 + 60 + 72 }), spec(5, 3)), null);
});

test('a short pane closes the rows up, then leaves out the titles, then the foot, and past that has no table', () => {
  const at = (h: number) => { const p = placeTable(measure, room({ h }), spec()); return p && [p.rowH, p.titles, p.foot]; };
  assert.deepEqual(at(109), [15, true, true], 'seven lines of 15 and four pixels');
  assert.deepEqual(at(102), [14, true, true]);
  assert.deepEqual(at(88), [12, true, true], 'the lowest row height');
  assert.deepEqual(at(87), [13, false, true], 'without the titles the rows open up again');
  assert.deepEqual(at(64), [12, false, false], 'without the foot');
  assert.equal(at(63), null);
});

test('the columns line up on their right edges, and the rows sit in the middle of the pane', () => {
  const p = placeTable(measure, room({ w: 590 }), spec())!;
  assert.deepEqual(p.rights, [429, 461, 498, 525], 'left 404, pad 5, then each width and a gap of 7');
  assert.deepEqual([p.y0, p.first], [Math.round(70 - 105 / 2), Math.round(70 - 105 / 2) + 15]);
});

test('painting: a lit row, a row under the pointer, the colours, the foot, and only the columns that fit', () => {
  const calls: (string | number)[][] = [];
  const ctx = { fillStyle: '', strokeStyle: '', globalAlpha: 1, textAlign: 'left', fillText: (s: string, x: number, y: number) => calls.push(['text', s, x, y, ctx.fillStyle, ctx.textAlign]), fillRect: (x: number, y: number, w: number, h: number) => calls.push(['rect', x, y, w, h, ctx.globalAlpha]), strokeRect: () => calls.push(['stroke']) };
  const rows: TableCell[][] = [[{ text: 'A' }, { text: '1', color: 'green' }, { text: '2' }], [{ text: 'B' }, { text: '3', color: 'green' }, { text: '4' }]];
  const s: TableSpec = { heads: ['', 'H1', 'H2'], rows, foot: 'then', minCols: 2, focus: 0 };
  const at = { rowH: 15, titles: true, foot: true, cols: 2, left: 10, plate: false, width: 50, y0: 20, first: 35, rights: [20, 40] };
  paintTable(ctx as unknown as CanvasRenderingContext2D, { panel: 'P', line: 'L', text: 'T', muted: 'M' }, at, s, 1);
  assert.deepEqual(calls, [
    ['text', 'H1', 40, 27.5, 'M', 'right'],
    ['rect', 12, 35, 46, 15, 0.1],
    ['text', 'A', 15, 42.5, 'T', 'left'],
    ['text', '1', 40, 42.5, 'green', 'right'],
    ['rect', 12, 50, 46, 15, 0.05],
    ['text', 'B', 15, 57.5, 'M', 'left'],
    ['text', '3', 40, 57.5, 'green', 'right'],
    ['text', 'then', 15, 72.5, 'M', 'left'],
  ]);
  calls.length = 0;
  paintTable(ctx as unknown as CanvasRenderingContext2D, { panel: 'P', line: 'L', text: 'T', muted: 'M' }, { ...at, plate: true, titles: false, foot: false, cols: 3, rights: [20, 40, 60] }, { ...s, focus: -1 }, -1);
  assert.deepEqual(calls.slice(0, 3).map(c => c[0]), ['rect', 'stroke', 'text'], 'on a plate, drawn before its rows');
  assert.ok(calls.some(c => c[1] === '2'), 'with every column');
  assert.ok(!calls.some(c => c[1] === 'H2' || c[1] === 'then'), 'no titles and no foot where they do not fit');
});

test('the pointer over a table: a row lit and chosen by a click or a tap, the click after a tap the same choice; a table with no action takes no row; a cleared one nothing', () => {
  const listeners = new Map<string, (e: unknown) => void>();
  const canvas = { addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn), getBoundingClientRect: () => ({ left: 10, top: 100 }), style: { cursor: '' } };
  let redraws = 0; const chosen: number[] = [];
  const host = { canvas: canvas as unknown as HTMLCanvasElement, left: () => 20, rangeGesture: () => false, invalidate: () => { redraws++; } };
  const ctx = { measureText: (s: string) => ({ width: measure(s) }), fillText: () => undefined, fillRect: () => undefined, strokeRect: () => undefined } as unknown as CanvasRenderingContext2D;
  const palette = { panel: 'P', line: 'L', text: 'T', muted: 'M' }, full: TableSpec = { ...spec(), foot: 'then', focus: -1 };
  const table = new PaneTable(host, row => chosen.push(row));
  const at = table.draw(ctx, palette, room({ w: 590 }), full)!;
  const y = at.first + 2 * at.rowH + 1, inside = at.left + 3;
  assert.equal(table.owns(inside, { y: 100 + y }), true, 'over the table it is the table\'s');
  assert.deepEqual([redraws, canvas.style.cursor], [1, 'pointer'], 'the row is lit, and says it can be clicked');
  listeners.get('click')!({ clientX: 10 + 20 + inside, clientY: 100 + y, pointerType: 'mouse' });
  assert.deepEqual(chosen, [2]);
  assert.equal(table.tap({ x: inside, y }), true);
  assert.deepEqual(chosen, [2, 2]);
  listeners.get('click')!({ clientX: 10 + 20 + inside, clientY: 100 + y, pointerType: 'mouse' });
  assert.deepEqual(chosen, [2, 2], 'the click the browser sends after a tap is not a second choice');
  assert.equal(table.tap({ x: at.left - 5, y }), false, 'beside the table a tap is not the table\'s');
  assert.equal(table.owns(at.left - 5, { y: 100 + y }), false);
  table.clear();
  assert.equal(table.owns(inside, { y: 100 + y }), false, 'not drawn this frame: it takes no pointer');
  // No action: it still owns the pointer over it, so that it can be read, but takes no row and adds no listener.
  listeners.clear();
  const plain = new PaneTable(host);
  plain.draw(ctx, palette, room({ w: 590 }), full);
  assert.equal(listeners.size, 0);
  assert.equal(plain.owns(inside, { y: 100 + y }), true);
  assert.equal(plain.tap({ x: inside, y }), false);
});

test('the tables are on by default, for a save or a layout from before them, and stay off once switched off', () => {
  const on = readSettings({});
  assert.deepEqual([on.fundingTable, on.oiTable, on.lsTable, on.ltTable, on.deltaTable], [true, true, true, true, true]);
  const off = readSettings({ fundingTable: false, oiTable: false, lsTable: false, ltTable: false, deltaTable: false });
  assert.deepEqual([off.fundingTable, off.oiTable, off.lsTable, off.ltTable, off.deltaTable], [false, false, false, false, false]);
});

const H = 3_600_000, T = Date.UTC(2026, 10, 6, 0), MIN = 60_000;

test('what a venue reads at a time: its settled row, the reading now over the interval under way, its newest record after it', () => {
  const rows: FundingRow[] = [{ t: T + 8 * H, rate: 1e-4, per8h: 1e-4, hours: 8 }, { t: T + 16 * H, rate: 2e-4, per8h: 2e-4, hours: 8 }];
  const now: FundingNow = { rate: 3e-4, per8h: 3e-4, hours: 8, next: T + 24 * H, premium: null };
  assert.deepEqual(fundingAt(rows, now, T + 4 * H, T + 20 * H), { row: rows[0], forming: false });
  assert.deepEqual(fundingAt(rows, now, T + 20 * H, T + 20 * H), { row: { t: T + 24 * H, rate: 3e-4, per8h: 3e-4, hours: 8 }, forming: true });
  assert.deepEqual(fundingAt(rows, null, T + 20 * H, T + 20 * H), { row: rows[1], forming: false }, 'a venue that says nothing of the time under way: its newest record');
  assert.deepEqual(fundingAt(rows, now, T - H, T + 20 * H), { row: null, forming: false }, 'before anything is held');
  // The interval under way has settled, its record in before the next reading now: the settled row stands.
  const settled = [...rows, { t: T + 24 * H, rate: 4e-4, per8h: 4e-4, hours: 8 }];
  assert.deepEqual(fundingAt(settled, now, T + 20 * H, T + 25 * H), { row: settled[2], forming: false });
});

const PALETTE = { bid: '#00ff00', ask: '#ff0000', text: '#000000', muted: '#888888' };

test('the Funding table: per eight hours, the yearly rate, the premium where it is held, a dash where a venue says nothing', () => {
  const rows = fundingTableRows([{ name: 'Binance', per8h: 0.0001, premium: -0.0004 }, { name: 'Deribit', per8h: 0, premium: null }, { name: 'OKX', per8h: null, premium: null }], PALETTE);
  assert.deepEqual(rows.map(r => r.map(c => c.text)), [['Binance', '+0.0100%', '+10.95%', '−0.0400%'], ['Deribit', '0.0000%', '0.00%', '–'], ['OKX', '–', '–', '–']]);
  assert.notEqual(rows[0]![1]!.color, rows[0]![3]!.color, 'funding paid by longs and a negative premium in different colours');
  assert.equal(rows[1]![1]!.color, undefined, 'zero has no side');
});

const bar = (t: number, oi: number): OiBar => [t, oi, oi, oi, oi];
test('the OI table: each venue as the sum counts it, its own change, its share, the largest first', () => {
  const parts: OiPart[] = [
    { id: 'bybit:BTCUSDT', bars: [bar(T, 30), bar(T + H, 35)] },
    { id: 'binance:BTCUSDT', bars: [bar(T, 100), bar(T + H, 90)] },
    { id: 'okx:BTC-USDT-SWAP', bars: [bar(T + H, 25)] },
  ];
  const at = oiVenuesAt(parts, H, T + H);
  assert.deepEqual(at.map(v => [v.id, v.oi, v.change]), [['binance:BTCUSDT', 90, -10], ['bybit:BTCUSDT', 35, 5], ['okx:BTC-USDT-SWAP', 25, null]], 'a venue with nothing a bar before has no change, not its whole open interest');
  assert.deepEqual(at.map(v => Math.round(v.share * 150)), [90, 35, 25], 'each one\'s share of the three');
  const sum = sumOi(parts, H);
  assert.equal(at.reduce((n, v) => n + v.oi, 0), sum.bars.find(b => b[0] === T + H)![4], 'the rows add up to the sum at that bar');
  assert.equal(at.reduce((n, v) => n + (v.change ?? 0), 0), sum.change.get(T + H), 'and their changes to its change');
  assert.deepEqual(oiVenuesAt(parts, H, T).map(v => v.id), ['binance:BTCUSDT', 'bybit:BTCUSDT'], 'the order is each one\'s newest reading, at any bar; a venue with nothing yet is left out');
  assert.deepEqual(oiVenuesAt(parts, H, T - 5 * H), [], 'before any reading: no rows');
  // A venue whose reading is carried: read every five minutes on a one-minute chart.
  const sparse: OiPart[] = [{ id: 'a:X', bars: [bar(T, 10), bar(T + 5 * MIN, 12)] }, { id: 'b:X', bars: [bar(T, 1), bar(T + MIN, 1), bar(T + 2 * MIN, 1), bar(T + 3 * MIN, 1), bar(T + 4 * MIN, 1), bar(T + 5 * MIN, 1)] }];
  assert.deepEqual(oiVenuesAt(sparse, MIN, T + 3 * MIN).map(v => [v.id, v.oi, v.change]), [['a:X', 10, 0], ['b:X', 1, 0]], 'its last reading, held');
  assert.deepEqual(oiTableRows(at, PALETTE).map(r => r.map(c => c.text)), [['Binance', '90', '−10', '60%'], ['Bybit', '35', '+5', '23%'], ['OKX', '25', '–', '17%']]);
});

test('the Long/Short table: long, short and their ratio at the moment read, dashes where a venue has no reading', () => {
  const series: LsSeries[] = [
    { id: 'binance:BTCUSDT', population: 'accounts', periodMs: H, status: 'ok', points: [{ t: T, long: 0.556 }] },
    { id: 'bybit:BTCUSDT', population: 'accounts', periodMs: H, status: 'failed', points: [{ t: T, long: 0.4 }] },
    { id: 'okx:BTC-USDT-SWAP', population: 'accounts', periodMs: H, status: 'ok', points: [] },
    { id: 'bitget:BTCUSDT', population: 'accounts', periodMs: H, status: 'stale', points: [{ t: T, long: 0.5 }] },
  ] as unknown as LsSeries[];
  const rows = lsTableRows(series, T + 30 * MIN, PALETTE);
  assert.deepEqual(rows.map(r => r.map(c => c.text)), [['Binance', '55.6%', '44.4%', '1.25'], ['Bybit', '–', '–', '–'], ['OKX', '–', '–', '–'], ['Bitget', '50.0%', '50.0%', '1.00']]);
  assert.deepEqual(rows[3]!.slice(1).map(c => c.color), [PALETTE.muted, PALETTE.muted, PALETTE.muted], 'an earlier reading after a failed update is muted');
  assert.notEqual(rows[0]![1]!.color, PALETTE.muted);
});

test('the Liquidity Tracker table: bids, asks, the imbalance signed, and the share only outside the Per level mode', () => {
  const rows = ltTableRows([{ name: 'Binance', bid: 29_900_000, ask: 40_500_000, share: 0.21 }, { name: '7 others', bid: 44_800_000, ask: 45_900_000, share: 0.26 }, { name: 'Kraken', bid: 0, ask: 0, share: 0 }], PALETTE);
  assert.deepEqual(rows.map(r => r.map(c => c.text)), [['Binance', '29.9M', '40.5M', '−15%', '21%', '1.35×'], ['7 others', '44.8M', '45.9M', '−1%', '26%', '1.02×'], ['Kraken', '0', '0', '0%', '0%', '–']]);
  assert.equal(rows[2]![3]!.color, PALETTE.muted, 'no lean: muted');
  assert.equal(rows[0]![5]!.color, rows[0]![2]!.color, 'the asks lead: the ratio in their colour');
  assert.deepEqual(ltTableRows([{ name: 'OKX', bid: 300, ask: 100, share: null }], PALETTE).map(r => r.map(c => c.text)), [['OKX', '300', '100', '+50%', '3.00×']], 'Per level: no share column');
});

test('the Delta table: buys, sells, the delta signed and the share of the volume', () => {
  const rows = deltaTableRows([{ name: 'Binance', buys: 3_000_000, sells: 1_000_000, delta: 2_000_000, share: 0.8 }, { name: '2 others', buys: 400_000, sells: 600_000, delta: -200_000, share: 0.2 }], PALETTE);
  assert.deepEqual(rows.map(r => r.map(c => c.text)), [['Binance', '3M', '1M', '+2M', '80%', '3.00×'], ['2 others', '400K', '600K', '−200K', '20%', '1.50×']]);
  assert.deepEqual([rows[0]![5]!.color, rows[1]![5]!.color], [rows[0]![1]!.color, rows[1]![2]!.color], 'the ratio in the colour of the side that leads');
  assert.notEqual(rows[0]![3]!.color, rows[1]![3]!.color, 'a buying delta and a selling one in their sides\' colours');
});

test('book names: the venue\'s, and the spot market says so only where two would read the same', () => {
  const markets = [
    { id: 'binance:BTCUSDT', instrumentId: 'binance:BTCUSDT', marketType: 'perpetual' },
    { id: 'binance:BTCUSDT:spot', instrumentId: 'binance:BTCUSDT:spot', marketType: 'spot' },
    { id: 'coinbase:BTC-USD', instrumentId: 'coinbase:BTC-USD', marketType: 'spot' },
    { id: 'bybitspot:BTCUSDT', instrumentId: 'bybitspot:BTCUSDT', marketType: 'spot' },
  ] as unknown as Market[];
  assert.deepEqual(bookNames(['binance:BTCUSDT', 'binance:BTCUSDT:spot', 'coinbase:BTC-USD', 'bybitspot:BTCUSDT'], markets), ['Binance', 'Binance Spot', 'Coinbase', 'Bybit spot']);
});

test('a table of many markets keeps a row each for as many as fit at 13 px with its titles and foot, at most eight', () => {
  assert.deepEqual([40, 56, 69, 82, 108, 134, 400].map(tableRowCap), [0, 2, 3, 4, 6, 8, 8]);
  // Whatever the cap, the rows it allows (with the titles and the foot) fit the pane, so placeTable never leaves the table out for its rows.
  for (let h = 30; h < 300; h++) { const k = tableRowCap(h); if (k) assert.ok(placeTable(measure, room({ h }), spec(k)), `h ${h}, ${k} rows`); }
});

test('a header folds as few of its last controls as leave the figures their room, and all of them where nothing does', () => {
  const widths = [100, 90, 80], key = 22;
  // The row's width with the last k folded: the fixed part, the controls left, the key where one folded.
  const need = (k: number): number => 300 + widths.slice(0, widths.length - k).reduce((a, b) => a + b, 0) + (k ? key : 0);
  assert.equal(foldCount(3, 600, need), 0, 'everything fits');
  assert.equal(foldCount(3, 569, need), 1, 'the last one folds (and the key takes its place)');
  assert.equal(foldCount(3, 450, need), 2);
  assert.equal(foldCount(3, 300, need), 3, 'too narrow even folded: all of them, and the row wraps');
});

/** A series of `windows` windows with each market's parts given row by row (NaN: nothing), its lines their sums (pooled in the Per level mode). */
function ltSeriesOf(rows: number[][][], weights?: number[][][]): { times: Float64Array; bid: Float32Array; ask: Float32Array; parts: LtParts } {
  const owners = rows.length, windows = rows[0]!.length;
  const parts: LtParts = { bid: new Float32Array(owners * windows), ask: new Float32Array(owners * windows) };
  if (weights) { parts.wBid = new Float32Array(owners * windows); parts.wAsk = new Float32Array(owners * windows); }
  const bid = new Float32Array(windows), ask = new Float32Array(windows);
  for (let k = 0; k < windows; k++) {
    let b = 0, a = 0, wb = 0, wa = 0;
    rows.forEach((row, m) => {
      const [x, y] = row[k]!; parts.bid[m * windows + k] = x!; parts.ask[m * windows + k] = y!;
      if (weights) { const [u, v] = weights[m]![k]!; parts.wBid![m * windows + k] = u!; parts.wAsk![m * windows + k] = v!; if (!Number.isNaN(x!)) { wb += u!; wa += v!; } }
      if (!Number.isNaN(x!)) { b += x!; a += y!; }
    });
    bid[k] = weights ? (wb > 0 ? b / wb : 0) : b; ask[k] = weights ? (wa > 0 ? a / wa : 0) : a;
  }
  return { times: Float64Array.from({ length: windows }, (_, k) => k * MIN), bid, ask, parts };
}

test('the Liquidity Tracker table\'s order: the most liquidity on average over the windows each holds, the newest window alone changing nothing much, a market with none left out', () => {
  // Market 1 is a little larger in the newest window, market 0 over the three: market 0 first. Market 2 has nothing at all.
  const s = ltSeriesOf([[[50, 50], [50, 50], [40, 40]], [[30, 30], [30, 30], [45, 45]], [[NaN, NaN], [NaN, NaN], [NaN, NaN]]]);
  assert.deepEqual(ltRank(s.parts, 3, 3, 3), [0, 1]);
  // Market 1 recorded over the last window only, twice market 0's size there: it is not put below for the windows it lacks.
  const late = ltSeriesOf([[[10, 10], [10, 10], [10, 10]], [[NaN, NaN], [NaN, NaN], [20, 20]]]);
  assert.deepEqual(ltRank(late.parts, 3, 2, 3), [1, 0]);
  assert.deepEqual(ltRank(s.parts, 3, 3, 1), [0, 1], 'a replay cut to the first window ranks on that window alone');
  const tie = ltSeriesOf([[[10, 10]], [[10, 10]]]);
  assert.deepEqual(ltRank(tie.parts, 1, 2, 1), [0, 1], 'equal ones keep the markets\' order');
});

test('the Liquidity Tracker table\'s rows: the cap and the rest, a market with nothing in the window left out, and every row as many cells as the heads', () => {
  const s = ltSeriesOf([[[40, 60]], [[30, 30]], [[NaN, NaN]], [[20, 10]], [[5, 5]]]);
  const names = ['A', 'B', 'C', 'D', 'E'], order = ltRank(s.parts, 1, 5, 1);
  const rows = ltRowsAt(s, names, order, 0, 3);
  assert.deepEqual(rows.map(r => [r.name, r.bid, r.ask, r.share]), [['A', 40, 60, 0.5], ['B', 30, 30, 0.3], ['2 others', 25, 15, 0.2]], 'C has nothing there: neither a row nor among the rest');
  assert.equal(ltRowsAt(s, names, order, 0, 4).length, 4, 'all four fit: no rest row');
  assert.deepEqual(ltRowsAt(s, names, order, 0, 0), [], 'no room for a row: no table');
});

test('a Liquidity Tracker window that reads nothing (a size filter no bin passes) draws its table with a share of 0, never a short row', () => {
  // Present everywhere (a book's column with nothing counted is a zero), so the lines read 0 and so do the parts.
  const s = ltSeriesOf([[[0, 0]], [[0, 0]], [[0, 0]]]);
  const rows = ltRowsAt(s, ['A', 'B', 'C'], ltRank(s.parts, 1, 3, 1), 0, 2);
  assert.deepEqual(rows.map(r => r.share), [0, 0], 'a share of the empty lines is 0, not missing');
  const heads = ltHeads(s.parts), cells = ltTableRows(rows, PALETTE);
  assert.equal(heads.length, 6);
  assert.ok(cells.every(r => r.length === heads.length), 'every row has the heads\' columns');
  const ctx = { measureText: (t: string) => ({ width: measure(t) }), fillText: () => undefined, fillRect: () => undefined, strokeRect: () => undefined } as unknown as CanvasRenderingContext2D;
  const spec = { heads, rows: cells, minCols: 3, foot: 'newest 00:00', focus: -1 };
  const at = placeTable(measure, room({ w: 900, h: 140 }), spec)!;
  assert.equal(at.cols, 6);
  assert.doesNotThrow(() => paintTable(ctx, { panel: 'P', line: 'L', text: 'T', muted: 'M' }, at, spec, -1));
});

test('the Per level mode is the series\' own: each market\'s average, the rest pooled over their weights, no share', () => {
  const s = ltSeriesOf([[[400, 50]], [[600, 10]], [[90, 30]]], [[[2, 1]], [[1, 1]], [[3, 2]]]);
  const rows = ltRowsAt(s, ['A', 'B', 'C'], [0, 1, 2], 0, 2);
  assert.deepEqual(rows.map(r => [r.name, r.bid, r.ask, r.share]), [['A', 200, 50, null], ['2 others', 690 / 4, 40 / 3, null]]);
  assert.ok(ltTableRows(rows, PALETTE).every(r => r.length === ltHeads(s.parts).length && r.length === 5), 'five columns, as its heads have');
  const plain = ltSeriesOf([[[400, 50]], [[600, 10]]]);
  assert.ok(ltRowsAt(plain, ['A', 'B'], [0, 1], 0, 2).every(r => r.share !== null), 'without weights: a share on every row, whatever the setting says meanwhile');
});

test('the Delta table has the heads\' six columns on every row', () => {
  const rows = deltaTableRows([{ name: 'A', buys: 0, sells: 0, delta: 0, share: 0 }, { name: '3 others', buys: 1, sells: 2, delta: -1, share: 1 }], PALETTE);
  assert.ok(rows.every(r => r.length === 6));
});

test('the × column: how many times the larger side is the smaller, in its colour, and what it says where a side is empty', () => {
  assert.deepEqual(sideRatio(546, 214), { ratio: 546 / 214, lead: 1 });
  assert.equal(sideRatio(103, 113)!.lead, -1, 'the second side leads');
  assert.equal(sideRatio(100, 100.4)!.lead, 0, 'under 1.005x neither leads');
  assert.equal(sideRatio(100, 100.5)!.lead, 0, 'written 1.00x: neither leads, so no colour on a figure that says even');
  assert.equal(sideRatio(100, 100.6)!.lead, -1);
  assert.deepEqual(sideRatio(5, 0), { ratio: Infinity, lead: 1 }, 'only one side has something');
  assert.equal(sideRatio(0, 0), null); assert.equal(sideRatio(NaN, 3), null); assert.equal(sideRatio(3, Infinity), null); assert.equal(sideRatio(-1, 3), null);
  assert.deepEqual([1, 1.004, 2.5512, 9.994, 9.996, 42.37, 99.96, 999.4, 999.5, 8e13, Infinity].map(ratioFigure), ['1.00×', '1.00×', '2.55×', '9.99×', '10.0×', '42.4×', '100×', '999×', '>999×', '>999×', '∞']);
  assert.deepEqual(ratioCell(546, 214, PALETTE), { text: '2.55×', color: ratioCell(5, 0, PALETTE).color });
  assert.equal(ratioCell(0, 7, PALETTE).text, '∞'); assert.notEqual(ratioCell(0, 7, PALETTE).color, ratioCell(7, 0, PALETTE).color);
  assert.deepEqual(ratioCell(100, 100, PALETTE), { text: '1.00×', color: PALETTE.muted }, 'neither leads: muted');
  assert.deepEqual(ratioCell(0, 0, PALETTE), { text: '–', color: PALETTE.muted });
});

test('the Depth table: bids, asks, their difference and the × column, on both sources, dashes for a band not read', () => {
  const rows = depthTableRows([{ r: 0.0125, bid: 113e6, ask: 103e6 }, { r: 0.2, bid: 546e6, ask: 214e6 }, { r: 0.0025, bid: 0, ask: 2e6 }, { r: 0.05, bid: NaN, ask: NaN }], PALETTE);
  assert.deepEqual(rows.map(r => r.map(c => c.text)), [['±1.25%', '113M', '103M', '+10M', '1.10×'], ['±20%', '546M', '214M', '+332M', '2.55×'], ['±0.25%', '0', '2M', '−2M', '∞'], ['±5%', '–', '–', '–', '–']]);
  assert.equal(rows[1]![4]!.color, rows[1]![1]!.color, 'bids lead: the colour of the bids');
  assert.equal(rows[2]![4]!.color, rows[2]![2]!.color, 'only asks (shorts) there: their colour');
  const spec = { heads: ['', 'Bid', 'Ask', 'Δ', '×'], rows, minCols: 3, foot: 'newest 13:39', focus: -1 };
  assert.equal(placeTable(measure, room({ w: 900, h: 140 }), spec)!.cols, 5, 'with room beside the plot the × column shows');
});

test('a Delta row: a side that traded nothing is 0, not the residue of live seconds added up in doubles, so × says ∞ and the cells stay narrow', () => {
  const gross = 1_234_567.89, delta = gross + 4e-9;
  const r = deltaRow('Thin', delta, gross, 2 * gross);
  assert.deepEqual([r.buys, r.sells, r.share], [gross + 2e-9, 0, 0.5]);
  assert.equal(r.delta, r.buys, 'the delta is the two sides\' difference');
  assert.deepEqual(deltaTableRows([r], PALETTE)[0]!.map(c => c.text), ['Thin', '1.23M', '0', '+1.23M', '50%', '∞']);
  const below = deltaRow('Thin', -gross + 3e-8, gross, gross);
  assert.deepEqual([below.buys, deltaTableRows([below], PALETTE)[0]![5]!.text], [0, '∞'], 'a negative residue too');
  assert.deepEqual(deltaRow('A', 0, 0, 0), { name: 'A', buys: 0, sells: 0, delta: 0, share: 0 });
});

test('a plate keeps every column unless the table lets its last ones go (plateMin), and then only down to that', () => {
  // All four 126 wide, three 99: a plot of 200 takes 120 on a plate.
  const narrow = room({ w: 200 + 60 + 20, plotW: 200, pointing: true });
  assert.equal(placeTable(measure, narrow, spec()), null, 'by default a plate is the whole table or none (the card says it)');
  const plate = placeTable(measure, narrow, { ...spec(), plateMin: 3 })!;
  assert.deepEqual([plate.plate, plate.cols, plate.width], [true, 3, 99], 'the × tables let their last column go');
  assert.equal(placeTable(measure, room({ w: 150 + 60, plotW: 150, pointing: true }), { ...spec(), plateMin: 3 }), null, 'not even plateMin fit: none');
  assert.equal(placeTable(measure, narrow, { ...spec(), plateMin: 1 })!.cols, 3, 'never below minCols');
  const all = placeTable(measure, room({ w: 400 + 60 + 90, pointing: true }), { ...spec(), plateMin: 3 })!;
  assert.equal(all.cols, 4, 'with room on the plate every column stays');
});

test('the × column is the first to go beside the plot in the Liquidity Tracker and Delta tables', () => {
  const lt = ltTableRows([{ name: 'Binance', bid: 29_900_000, ask: 40_500_000, share: 0.21 }], PALETTE), heads = ltHeads({} as LtParts);
  assert.deepEqual(heads.slice(-2), ['Share', '×'], 'Share, then × last');
  assert.equal(ltHeads({ wBid: new Float64Array(0) } as unknown as LtParts).at(-1), '×', 'Per level: × last too');
  const full = placeTable(measure, room({ w: 2000 }), { heads, rows: lt, minCols: 3 })!;
  const less = placeTable(measure, room({ w: 400 + 60 + full.width - 10 }), { heads, rows: lt, minCols: 3 })!;
  assert.deepEqual([full.cols, less.cols], [6, 5], 'Share stays, × goes');
  assert.equal(deltaTableRows([deltaRow('A', 1, 3, 3)], PALETTE)[0]!.length, 6);
});
