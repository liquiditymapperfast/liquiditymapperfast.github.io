import test from 'node:test';
import assert from 'node:assert/strict';
import { PaneTable, paintTable, placeTable, type TableCell, type TableRoom, type TableSpec } from '../src/app/panes/pane-table.ts';
import { fundingAt, type FundingNow, type FundingRow } from '../src/app/funding.ts';
import { fundingTableRows } from '../src/app/panes/funding-pane.ts';
import { lsTableRows } from '../src/app/panes/ls-pane.ts';
import { oiTableRows } from '../src/app/panes/lower-panes.ts';
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
  assert.deepEqual([on.fundingTable, on.oiTable, on.lsTable], [true, true, true]);
  const off = readSettings({ fundingTable: false, oiTable: false, lsTable: false });
  assert.deepEqual([off.fundingTable, off.oiTable, off.lsTable], [false, false, false]);
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
