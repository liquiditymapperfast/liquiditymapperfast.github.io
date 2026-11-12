import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HiddenGaps, MERGE_GAP_MS, MERGE_SPAN_MS, TNS_DEFAULTS, TNS_GAP_MS, TnsBook, readFlowView, readTns, type TnsLine, type TnsRow } from '../src/app/tns/model.ts';
import type { Print } from '../src/app/prints.ts';
import { LAYOUT_KEYS, readSettings } from '../src/app/store.ts';

const order = (t: number, id: string, side: 'buy' | 'sell', price: number, usd: number, extra: Partial<Print> = {}): Print => ({ t, id, side, price, usd, ...extra });
const all = () => true;
const rowsOf = (book: TnsBook, o: Partial<Parameters<TnsBook['rows']>[0]> = {}): TnsLine[] => book.rows({ minUsd: 100_000, side: 'both', merge: true, shown: all, ...o });
const onlyRows = (lines: TnsLine[]): TnsRow[] => lines.filter((l): l is TnsRow => l.k === 'row');

test('the settings read back field by field; the view is the flow unless a save says Time & sales', () => {
  assert.deepEqual(readTns(undefined), TNS_DEFAULTS);
  assert.deepEqual(readTns({ minUsd: 250_000, side: 'sell', merge: false }), { minUsd: 250_000, side: 'sell', merge: false });
  // Under the recording's floor, not a number, or a side that does not exist: the default.
  assert.deepEqual(readTns({ minUsd: 10_000, side: 'up', merge: 'yes' }), TNS_DEFAULTS);
  assert.deepEqual(readTns({ minUsd: Number.NaN }), TNS_DEFAULTS);
  assert.equal(readFlowView('tns'), 'tns');
  assert.equal(readFlowView('tape'), 'flow');
  assert.equal(readFlowView(undefined), 'flow');
});

test('a saved page and a layout carry the view and the list settings', () => {
  assert.ok((LAYOUT_KEYS as readonly string[]).includes('flowView') && (LAYOUT_KEYS as readonly string[]).includes('tns'));
  const s = readSettings({ flowView: 'tns', tns: { minUsd: 50_000, side: 'buy', merge: true } });
  assert.equal(s.flowView, 'tns');
  assert.deepEqual(s.tns, { minUsd: 50_000, side: 'buy', merge: true });
  // A layout saved before the views existed opens on the flow, at the defaults.
  const old = readSettings({});
  assert.equal(old.flowView, 'flow');
  assert.deepEqual(old.tns, TNS_DEFAULTS);
});

test('newest on top, filtered by size, side and the exchanges shown', () => {
  const book = new TnsBook(0);
  book.add([order(1_000, 'binance:BTCUSDT', 'buy', 71_000, 150_000), order(2_000, 'okx:BTC-USDT-SWAP', 'sell', 70_990, 90_000), order(3_000, 'bybit:BTCUSDT', 'sell', 70_980, 400_000)]);
  assert.deepEqual(onlyRows(rowsOf(book)).map(r => r.id), ['bybit:BTCUSDT', 'binance:BTCUSDT'], 'under $100K left out, the newest first');
  assert.deepEqual(onlyRows(rowsOf(book, { minUsd: 25_000 })).map(r => r.id), ['bybit:BTCUSDT', 'okx:BTC-USDT-SWAP', 'binance:BTCUSDT']);
  assert.deepEqual(onlyRows(rowsOf(book, { side: 'buy' })).map(r => r.id), ['binance:BTCUSDT']);
  assert.deepEqual(onlyRows(rowsOf(book, { shown: id => !id.startsWith('bybit') })).map(r => r.id), ['binance:BTCUSDT']);
});

test('an order arriving twice is listed once (the stream and a history answer can both carry it)', () => {
  const book = new TnsBook(0), p = order(1_000, 'binance:BTCUSDT', 'buy', 71_000, 150_000);
  assert.equal(book.add([p]), 1);
  assert.equal(book.add([{ ...p }]), 0);
  assert.equal(onlyRows(rowsOf(book)).length, 1);
});

test('a burst on one exchange and side is one row, its size added up and its price weighted by size', () => {
  const book = new TnsBook(0), id = 'binance:BTCUSDT';
  book.add([
    order(10_000, id, 'sell', 71_000, 200_000),
    order(10_000 + MERGE_GAP_MS, id, 'sell', 70_900, 600_000, { lo: 70_850, hi: 70_950, n: 9 }),
    order(10_100, 'okx:BTC-USDT-SWAP', 'sell', 70_990, 300_000), // another exchange: a row of its own
    order(10_200, id, 'buy', 71_010, 300_000), // the other side: a row of its own
  ]);
  const rows = onlyRows(rowsOf(book));
  assert.equal(rows.length, 3);
  const burst = rows.find(r => r.id === id && r.side === 'sell')!;
  assert.equal(burst.orders, 2);
  assert.equal(burst.usd, 800_000);
  // Weighted by coins: 800,000 / (200,000 / 71,000 + 600,000 / 70,900).
  assert.ok(Math.abs(burst.price - 800_000 / (200_000 / 71_000 + 600_000 / 70_900)) < 1e-9);
  assert.equal(burst.lo, 70_850); assert.equal(burst.hi, 71_000);
  assert.equal(burst.t, 10_000); assert.equal(burst.last, 10_000 + MERGE_GAP_MS);
  // Off: every order a row.
  assert.equal(onlyRows(rowsOf(book, { merge: false })).length, 4);
});

test('a burst stops at the gap and at the span, and an order arriving out of time order still joins its row', () => {
  const book = new TnsBook(0), id = 'binance:BTCUSDT';
  // A chain every 400 ms joins until the row is MERGE_SPAN_MS long, then a new row starts.
  const chain = Array.from({ length: 12 }, (_, i) => order(20_000 + i * 400, id, 'buy', 71_000, 150_000));
  book.add(chain);
  const rows = onlyRows(rowsOf(book));
  assert.ok(rows.length >= 2, 'a long burst becomes more than one row');
  for (const r of rows) assert.ok(r.last - r.t <= MERGE_SPAN_MS);
  assert.equal(rows.reduce((n, r) => n + r.orders, 0), 12);
  // A pause longer than MERGE_GAP_MS starts a new row.
  const two = new TnsBook(0);
  two.add([order(1_000, id, 'buy', 71_000, 150_000), order(1_000 + MERGE_GAP_MS + 1, id, 'buy', 71_000, 150_000)]);
  assert.equal(onlyRows(rowsOf(two)).length, 2);
  // Arrival order is not time order: an order stamped a little before the row's first still joins it.
  const late = new TnsBook(0);
  late.add([order(5_000, id, 'sell', 71_000, 150_000)]);
  late.add([order(4_800, id, 'sell', 71_010, 150_000)]);
  const [row] = onlyRows(rowsOf(late));
  assert.equal(row!.orders, 2); assert.equal(row!.t, 4_800); assert.equal(row!.last, 5_000);
  // A late order inside the row's span joins it however far it is from the newest one (review r1: it was compared with the last alone).
  const inside = new TnsBook(0);
  inside.add([1_000, 1_400, 1_800, 2_200].map(at => order(at, id, 'buy', 71_000, 150_000)));
  inside.add([order(1_100, id, 'buy', 71_000, 150_000)]);
  assert.deepEqual(onlyRows(rowsOf(inside)).map(r => r.orders), [5]);
  // And one before the first, within the gap, as long as the span stays under the limit.
  const before = new TnsBook(0);
  before.add([order(1_000, id, 'buy', 71_000, 150_000), order(1_400, id, 'buy', 71_000, 150_000)]);
  before.add([order(800, id, 'buy', 71_000, 150_000)]);
  assert.deepEqual(onlyRows(rowsOf(before)).map(r => [r.orders, r.t, r.last]), [[3, 800, 1_400]]);
  // A far-late order is a row of its own and leaves the lane's open row open: the next order in time still joins it.
  const far = new TnsBook(0);
  far.add([order(3_000, id, 'buy', 71_000, 150_000)]); far.add([order(1_000, id, 'buy', 71_000, 150_000)]); far.add([order(3_200, id, 'buy', 71_000, 150_000)]);
  assert.deepEqual(onlyRows(rowsOf(far)).map(r => [r.orders, r.t]), [[1, 1_000], [2, 3_000]]);
  const tooLong = new TnsBook(0);
  tooLong.add([order(1_000, id, 'buy', 71_000, 150_000), order(1_000 + MERGE_SPAN_MS, id, 'buy', 71_000, 150_000)]);
  assert.equal(onlyRows(rowsOf(tooLong)).length, 2, 'two orders a whole span apart are two rows');
});

test('a gap is listed where it fell, closes the bursts open across it, and only after a row', () => {
  const book = new TnsBook(0), id = 'binance:BTCUSDT';
  book.gap('reconnect', 500); // nothing before it: nothing to say
  book.add([order(1_000, id, 'buy', 71_000, 150_000)]);
  book.gap('reconnect', 1_100);
  book.add([order(1_200, id, 'buy', 71_000, 150_000)]);
  const lines = rowsOf(book);
  assert.deepEqual(lines.map(l => l.k), ['row', 'gap', 'row'], 'the burst does not reach across the gap');
  // Two gaps with no order between them are one, the reconnect kept and the time missed added.
  const two = new TnsBook(0);
  two.add([order(1_000, id, 'buy', 71_000, 150_000)]);
  two.gap('hidden', 2_000, 60_000); two.gap('reconnect', 3_000);
  const gaps = rowsOf(two).filter(l => l.k === 'gap');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.k === 'gap' && gaps[0]!.why, 'reconnect');
  assert.equal(gaps[0]!.k === 'gap' && gaps[0]!.ms, 60_000);
  // The row limit never leaves a gap as the oldest line.
  const cut = new TnsBook(0);
  cut.add([order(1_000, id, 'buy', 71_000, 150_000)]);
  cut.gap('reconnect', 1_100);
  cut.add([order(5_000, id, 'sell', 71_000, 150_000)]);
  assert.deepEqual(rowsOf(cut, { limit: 2 }).map(l => l.k), ['row']);
});

test('bounded: the oldest orders go past the hold, and the rows past the limit', () => {
  const book = new TnsBook(0, 50), id = 'binance:BTCUSDT';
  book.add(Array.from({ length: 80 }, (_, i) => order(i * 1_000, id, i % 2 ? 'buy' : 'sell', 71_000, 150_000)));
  assert.equal(book.orders, 50);
  const rows = onlyRows(rowsOf(book, { merge: false }));
  assert.equal(rows.length, 50);
  assert.equal(rows[0]!.t, 79_000); assert.equal(rows[rows.length - 1]!.t, 30_000);
  assert.equal(book.since, 30_000, 'the list says since when it holds every order: the oldest kept once the hold is full');
  // An order that was dropped is new again (its key went with it), as the stream would not send it twice anyway.
  assert.equal(book.add([order(0, id, 'sell', 71_000, 150_000)]), 1);
  assert.equal(onlyRows(rowsOf(book, { merge: false, limit: 7 })).length, 7);
});

test('the page in the background is a gap only when no order came for a while (a desktop goes on receiving)', () => {
  const g = new HiddenGaps(0, false);
  g.hide(1_000); g.show(61_000);
  assert.equal(g.arrived(61_500), 60_000, 'a minute hidden with nothing arriving');
  const busy = new HiddenGaps(0, false);
  busy.hide(1_000);
  assert.equal(busy.arrived(2_000), 0, 'orders kept coming while hidden');
  assert.equal(busy.arrived(2_000 + TNS_GAP_MS - 1), 0);
  busy.show(40_000);
  assert.equal(busy.arrived(40_100), 0, 'orders kept coming: no stretch without orders past the limit');
});

test('the list is wired to every order the stream sends, and asks for nothing', () => {
  const hub = fs.readFileSync('src/app/hub.ts', 'utf8');
  // Every live order goes to the list, the ones the book already held included, and after the book's own work (an error there skips nothing).
  assert.match(hub, /const fresh = this\.prints\.add\(live\);\r?\n\s*if \(fresh\.length\) \{[^\n]*\}\r?\n\s*\/\/[^\n]*\r?\n\s*if \(live\.length\) this\.onLivePrints\(live\);/);
  const view = fs.readFileSync('src/app/panes/tns-view.ts', 'utf8');
  assert.doesNotMatch(view, /source\.|fetch\(|\.prints\(/, 'Time & sales never asks a source');
});
