import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HiddenGaps, MERGE_GAP_MS, MERGE_SPAN_MS, TNS_GAP_MS, SEAM_SLACK_MS, TNS_HOLE_MS, TnsBook, recordedStretch, readFlowView, type TnsLine, type TnsRow } from '../src/app/tns/model.ts';
import type { Print } from '../src/app/prints.ts';
import { LAYOUT_KEYS, readSettings } from '../src/app/store.ts';

const order = (t: number, id: string, side: 'buy' | 'sell', price: number, usd: number, extra: Partial<Print> = {}): Print => ({ t, id, side, price, usd, ...extra });
const all = () => true;
const rowsOf = (book: TnsBook, o: Partial<Parameters<TnsBook['rows']>[0]> = {}): TnsLine[] => book.rows({ minUsd: 100_000, side: 'both', merge: true, shown: all, ...o });
const onlyRows = (lines: TnsLine[]): TnsRow[] => lines.filter((l): l is TnsRow => l.k === 'row');

test('the view is the flow unless a save says Trades; a save that named Time & sales or All trades opens on Trades', () => {
  assert.equal(readFlowView('trades'), 'trades');
  assert.equal(readFlowView('tns'), 'trades');
  assert.equal(readFlowView('all'), 'trades');
  assert.equal(readFlowView('tape'), 'flow');
  assert.equal(readFlowView(undefined), 'flow');
});

test('a saved page and a layout carry the view and Trades\' settings, and no longer Time & sales\'', () => {
  assert.ok((LAYOUT_KEYS as readonly string[]).includes('flowView') && (LAYOUT_KEYS as readonly string[]).includes('trades'));
  assert.ok(!(LAYOUT_KEYS as readonly string[]).includes('tns'));
  const s = readSettings({ flowView: 'tns', tns: { minUsd: 50_000, side: 'buy', merge: true } } as Parameters<typeof readSettings>[0]);
  assert.equal(s.flowView, 'trades');
  assert.ok(!('tns' in s));
  // A layout saved before the views existed opens on the flow.
  assert.equal(readSettings({}).flowView, 'flow');
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

test('Trades reaches the recording only through the page\'s callback (the source\'s own recording, never an exchange)', () => {
  const view = fs.readFileSync('src/app/panes/trades-view.ts', 'utf8');
  assert.doesNotMatch(view, /source\.|fetch\(|\.prints\(|recentPrints/, 'the view asks no source itself (its history goes through `recorded`, set by the page)');
  assert.match(view, /void this\.recorded\(seam, want\)/);
  const main = fs.readFileSync('src/app/main.ts', 'utf8');
  assert.match(main, /cvd\.trades\.recorded = \(until, minUsd\) => hub\.recentPrints\(/);
});

test('the recording covered from its first moment, with holes where no market was recorded; one venue reconnecting is no hole', () => {
  const M = 60_000, until = 10 * M;
  // One market reconnected for a minute while another kept recording: no hole.
  assert.deepEqual(recordedStretch([[[2 * M, 5 * M], [6 * M, until]], [[2 * M, until]]], 0, until, 5_000), { since: 2 * M, holes: [] });
  // No market recorded between 5 and 8 min (no page open): a hole, and the list starts at the first recorded moment.
  assert.deepEqual(recordedStretch([[[2 * M, 5 * M], [8 * M, until]], [[1 * M, 4 * M], [8 * M, until]]], 0, until, 5_000), { since: M, holes: [[5 * M, 8 * M]] });
  // The server passes over holes under its limit (its loop pausing); the browser does not.
  const stall = [[[M, 5 * M], [5 * M + 20_000, until]]] as const;
  assert.deepEqual(recordedStretch(stall, 0, until, TNS_HOLE_MS.server)?.holes, []);
  assert.deepEqual(recordedStretch(stall, 0, until, TNS_HOLE_MS.browser)?.holes, [[5 * M, 5 * M + 20_000]]);
  // A recording that stops before the page opened ends with a hole up to it; nothing recorded is null.
  assert.deepEqual(recordedStretch([[[M, 7 * M]]], 0, until, 5_000)?.holes, [[7 * M, until]]);
  assert.equal(recordedStretch([[[3 * M, until]]], 4 * M, until, 5_000)?.since, 4 * M, 'never before the window');
  assert.equal(recordedStretch([], 0, until, 5_000), null);
});

test('the orders the recording held go before the live ones, in time order with its holes, each once; a fill replaces the one before', () => {
  const id = 'binance:BTCUSDT', book = new TnsBook(100_000);
  const live = order(100_500, id, 'buy', 71_000, 150_000);
  book.add([live]);
  const first = [order(90_000, id, 'sell', 70_900, 200_000), order(80_000, id, 'buy', 70_800, 300_000), order(70_000, id, 'buy', 70_700, 400_000), { ...live }];
  assert.equal(book.prefill(first, 75_000, [[85_000, 88_000]]), 2, 'one from before Since is left out, and the live one is the stream\'s');
  assert.equal(book.since, 75_000);
  const kinds = (b: TnsBook): string => rowsOf(b, { merge: false }).map(l => l.k === 'gap' ? `gap:${l.why}` : String(l.t)).join(',');
  assert.equal(kinds(book), '100500,90000,gap:unrecorded,80000', 'newest first; the hole between the recorded orders where it fell');
  assert.equal(book.orders, 3);
  // An order past the seam and its slack is the stream's to send, never the recording's.
  assert.equal(book.prefill([order(100_000 + SEAM_SLACK_MS, id, 'buy', 71_000, 500_000)], 75_000), 0);
  assert.equal(book.orders, 1, 'a fill replaces the one before it (each answer is the whole of its window)');
  // The next fill (the smallest order lowered): its own orders and holes, the live orders untouched.
  assert.equal(book.prefill([...first, order(86_000, id, 'sell', 70_850, 30_000)], 75_000, [[95_000, 100_000]]), 3);
  assert.equal(kinds(book), '100500,gap:unrecorded,90000,80000', 'its holes replace the first\'s; $30K is under the rows\' $100K');
  assert.equal(book.orders, 4);
  const gap = rowsOf(book).find(l => l.k === 'gap');
  assert.ok(gap?.k === 'gap' && gap.ms === 5_000 && gap.at === 100_000);
});

test('the seam is when the stream opened, with a few seconds of slack: what the stream had not sent yet is the recording\'s', () => {
  const id = 'okx:BTC-USDT-SWAP', book = new TnsBook(100_000);
  book.open(103_000);
  assert.equal(book.since, 103_000, 'before any fill the list holds every order from the stream\'s opening');
  book.add([order(103_200, id, 'buy', 71_000, 150_000)]);
  assert.equal(book.prefill([order(101_500, id, 'buy', 71_000, 150_000), order(103_200, id, 'buy', 71_000, 150_000), order(104_000, id, 'sell', 71_000, 150_000)], 95_000), 2);
  assert.deepEqual(onlyRows(rowsOf(book, { merge: false })).map(r => r.t), [103_200, 104_000, 101_500], 'the stream\'s own order once; the recording\'s after it in the list');
  assert.equal(book.since, 95_000);
});

test('a list whose live orders were let go to the hold never claims the recording\'s start; a reconnect before any live order is kept', () => {
  const id = 'binance:BTCUSDT', book = new TnsBook(100_000, 3);
  book.add([101_000, 102_000, 103_000, 104_000].map(t => order(t, id, 'buy', 70_000, 200_000)));
  assert.equal(book.since, 102_000, 'the oldest kept once the hold let one go');
  book.prefill([], 40_000);
  assert.equal(book.since, 102_000, 'an empty fill does not move Since back over what was dropped');
  const fresh = new TnsBook(100_000);
  fresh.gap('reconnect', 100_200);
  fresh.prefill([order(90_000, id, 'buy', 70_000, 200_000)], 80_000);
  fresh.add([order(101_000, id, 'sell', 70_000, 200_000)]);
  assert.deepEqual(rowsOf(fresh).map(l => l.k === 'gap' ? l.why : 'row'), ['row', 'reconnect', 'row'], 'the line sits between the recording and the live orders');
});

test('a hole\'s line covers only where the recording holds no order: the open minute\'s orders, the next stretch\'s early stamps, a pause full of orders', () => {
  const id = 'binance:BTCUSDT', S = 1_000, M = 60 * S;
  const seam = 30 * M;
  const at = (b: TnsBook): { at: number; ms: number }[] => rowsOf(b).flatMap(l => l.k === 'gap' ? [{ at: l.at, ms: l.ms }] : []);
  // The history service's hour ends at a minute (its coverage) but holds orders into the next one, up to when its piece was written.
  const open = new TnsBook(seam);
  open.prefill([order(27 * M + 50 * S, id, 'buy', 70_000, 200_000), order(28 * M + 10 * S, id, 'sell', 70_000, 200_000), order(28 * M + 55 * S, id, 'buy', 70_000, 200_000)],
    20 * M, [[28 * M, seam]], TNS_HOLE_MS.browser);
  assert.deepEqual(at(open), [{ at: seam, ms: seam - (28 * M + 55 * S) }], 'from the open minute\'s last order up to the seam');
  const lines = rowsOf(open).map(l => l.k === 'gap' ? 'gap' : String((l as TnsRow).t));
  assert.deepEqual(lines, ['gap', String(28 * M + 55 * S), String(28 * M + 10 * S), String(27 * M + 50 * S)], 'every order below the line is older than its start');
  // Between two visits: the first visit's open minute, and the second's first order stamped a moment before its coverage starts.
  const between = new TnsBook(seam);
  between.prefill([order(10 * M + 20 * S, id, 'buy', 70_000, 200_000), order(15 * M - 300, id, 'buy', 70_000, 200_000), order(16 * M, id, 'sell', 70_000, 200_000)],
    5 * M, [[10 * M, 15 * M]], TNS_HOLE_MS.browser);
  assert.deepEqual(at(between), [{ at: 15 * M - 300, ms: 15 * M - 300 - (10 * M + 20 * S) }], 'the longest stretch with no order, not cut to nothing by the early stamp');
  // The server's loop paused for three minutes but its feeds lost nothing: no stretch of the pause without an order is long enough.
  const pause = new TnsBook(seam);
  pause.prefill(Array.from({ length: 12 }, (_, i) => order(10 * M + i * 15 * S, id, 'buy', 70_000, 200_000)), 5 * M, [[10 * M, 13 * M]], TNS_HOLE_MS.server);
  assert.deepEqual(at(pause), [], 'a pause full of orders is no hole');
  // A quiet patch inside the minute the recording was cut in is no hole: the line is the part after that minute's last order, even when shorter.
  const quiet = new TnsBook(28 * M + 61 * S);
  const busy = [0, 4, 8, 12, 16, 20, 36, 40, 44, 48, 52].map(s => order(28 * M + s * S, id, s % 8 ? 'buy' : 'sell', 70_000, 200_000));
  quiet.prefill(busy, 20 * M, [[28 * M, 28 * M + 61 * S]], TNS_HOLE_MS.browser);
  assert.deepEqual(at(quiet), [{ at: 28 * M + 61 * S, ms: 9 * S }], 'from 28:52 to the seam, not the 16 s without an order from 28:20 to 28:36');
  // A hole running past the seam ends at it, and an order exactly at a hole's end is listed above the line.
  const past = new TnsBook(seam);
  past.prefill([order(27 * M, id, 'buy', 70_000, 200_000)], 20 * M, [[28 * M, 40 * M]], TNS_HOLE_MS.browser);
  assert.deepEqual(at(past), [{ at: seam, ms: 2 * M }]);
  const edge = new TnsBook(seam);
  edge.prefill([order(27 * M, id, 'buy', 70_000, 200_000), order(29 * M, id, 'sell', 70_000, 200_000)], 20 * M, [[28 * M, 29 * M]], TNS_HOLE_MS.browser);
  assert.deepEqual(rowsOf(edge).map(l => l.k === 'gap' ? `gap ${l.at - l.ms}-${l.at}` : String((l as TnsRow).t)), [String(29 * M), `gap ${28 * M}-${29 * M}`, String(27 * M)]);
  // A hole holding no order is the hole, whatever the shortest one.
  const empty = new TnsBook(seam);
  empty.prefill([order(9 * M, id, 'buy', 70_000, 200_000), order(14 * M, id, 'buy', 70_000, 200_000)], 5 * M, [[10 * M, 13 * M]], TNS_HOLE_MS.server);
  assert.deepEqual(at(empty), [{ at: 13 * M, ms: 3 * M }]);
  // Too short once the orders are counted: no line (here the browser's 5 s).
  const short = new TnsBook(seam);
  short.prefill([order(10 * M + 2 * S, id, 'buy', 70_000, 200_000), order(10 * M + 6 * S, id, 'buy', 70_000, 200_000)], 5 * M, [[10 * M, 10 * M + 9 * S]], TNS_HOLE_MS.browser);
  assert.deepEqual(at(short), []);
});

test('two holes with no row between them are two lines, and a gap before the first live order follows the recording', () => {
  const id = 'binance:BTCUSDT', book = new TnsBook(100_000);
  book.prefill([order(80_000, id, 'buy', 70_000, 200_000), order(86_000, id, 'buy', 70_000, 30_000), order(92_000, id, 'buy', 70_000, 200_000)], 75_000, [[84_000, 85_000], [88_000, 90_000]]);
  assert.deepEqual(rowsOf(book).map(l => l.k), ['row', 'gap', 'gap', 'row'], 'the $30K order between them is filtered out, both holes still shown');
  book.gap('reconnect', 100_500);
  book.add([order(101_000, id, 'sell', 70_000, 200_000)]);
  assert.deepEqual(rowsOf(book).map(l => l.k === 'gap' ? l.why : 'row'), ['row', 'reconnect', 'row', 'unrecorded', 'unrecorded', 'row']);
});

test('the recording is asked through the source it asks anyway, once, and again only for a smaller size than was asked', () => {
  const hub = fs.readFileSync('src/app/hub.ts', 'utf8');
  assert.match(hub, /async recentPrints\(/);
  assert.match(hub, /this\.source\.coverage\(/);
  assert.match(hub, /TNS_HOLE_MS\[this\.source\.kind\]/);
  assert.match(hub, /rows\.length < PRINTS_PER_ANSWER/, 'an answer cut at its largest orders is never used as a full list');
  const view = fs.readFileSync('src/app/panes/trades-view.ts', 'utf8'), asks = fs.readFileSync('src/app/trades/asks.ts', 'utf8');
  assert.match(view, /recordedDue\(ask, seam, want, Date\.now\(\)\)/);
  assert.match(asks, /want < a\.min \|\| Math\.abs\(seam - a\.askedAt\) > RECORDED_AGAIN_MS/, 'asked again for a smaller size, or once the seam moved on');
});
