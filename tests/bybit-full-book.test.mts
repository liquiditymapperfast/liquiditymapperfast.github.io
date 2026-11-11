import test from 'node:test';
import assert from 'node:assert/strict';
import { ANCHOR_WAIT_MS, AUDIT_DELAY_MS, FullBook, GUARD, MAX_FRAME_ROWS, REFRESH_MIN_MS, SNAPSHOT_CAP, fullSnapshotUrl, fullTopic, parseFullDelta, parseFullSnapshot, type FullDelta, type FullSnapshot } from '../src/shared/bybit-full-book.ts';

const S = 'BTCUSDT';
type Rows = [number, number][];
const delta = (u: number, b: Rows = [], a: Rows = [], seq = u * 10): FullDelta => ({ u, seq, ts: 0, b, a });
const snap = (u: number, b: Rows, a: Rows, seq = u * 10): FullSnapshot => ({ u, seq, ts: 0, b, a });
const frame = (u: number, b: unknown[] = [], a: unknown[] = [], extra: Record<string, unknown> = {}) => ({ topic: fullTopic(S), type: 'delta', ts: 1, data: { s: S, u, seq: u * 10, b, a, ...extra } });
const sides = (book: FullBook) => ({ b: [...book.bids].sort((x, y) => y[0] - x[0]), a: [...book.asks].sort((x, y) => x[0] - y[0]) });
/** A small book around 100: bids 99..95, asks 101..105. */
const B0: Rows = [[99, 1], [98, 2], [97, 3], [96, 4], [95, 5]], A0: Rows = [[101, 1], [102, 2], [103, 3], [104, 4], [105, 5]];

test('bybit full book: the addresses, and frames read whole or not at all', () => {
  assert.equal(fullSnapshotUrl('linear', 'BTCUSDT'), 'https://api.bybit.com/v5/market/full_orderbook?category=linear&symbol=BTCUSDT');
  assert.equal(fullTopic('ETHUSDT'), 'orderbook.full.ETHUSDT');
  assert.deepEqual(parseFullDelta(frame(7, [['99', '1.5']], [['101', '0']]), S), { u: 7, seq: 70, ts: 1, b: [[99, 1.5]], a: [[101, 0]] });
  assert.equal(parseFullDelta({ topic: 'publicTrade.BTCUSDT', data: [] }, S), null, 'another topic is not this book\'s');
  assert.equal(parseFullDelta({ ...frame(7), type: 'snapshot' }, S), 'bad');
  assert.equal(parseFullDelta(frame(7, [], [], { s: 'ETHUSDT' }), S), 'bad');
  assert.equal(parseFullDelta(frame(7, [['99', '1'], ['x', '1']]), S), 'bad', 'one bad row spoils the frame');
  assert.equal(parseFullDelta(frame(7, [['99', '-1']]), S), 'bad');
  assert.equal(parseFullDelta(frame(7, [['0', '1']]), S), 'bad');
  assert.equal(parseFullDelta(frame(0), S), 'bad', 'u starts at 1');
  assert.equal(parseFullDelta(frame(2 ** 60), S), 'bad', 'an unsafe u');
  assert.equal(parseFullDelta(frame(7, [], [], { b: null }), S), 'bad');
  // Only plain decimal strings: a null, a number, an exponent, a sign or an empty string is no row (it would have read as a deletion).
  for (const row of [['99', null], [99, '1'], ['99', 1], ['1e5', '1'], ['99', '-1'], ['+99', '1'], ['', '1'], ['99', ''], ['99.', '1'], ['099', '1']]) {
    assert.equal(parseFullDelta(frame(7, [row]), S), 'bad', JSON.stringify(row));
  }
  assert.deepEqual(parseFullDelta(frame(7, [['0.00001234', '1234567.5'], ['99', '0']]), S), { u: 7, seq: 70, ts: 1, b: [[0.00001234, 1234567.5], [99, 0]], a: [] });
  // A frame of more rows than any Bybit sends is a fault, not a book.
  const many = Array.from({ length: MAX_FRAME_ROWS + 1 }, (_, i) => [String(1 + i), '1']);
  assert.equal(parseFullDelta(frame(7, many), S), 'bad');
});

test('bybit full book: snapshots are checked before use', () => {
  const body = (result: Record<string, unknown>, retCode = 0) => ({ retCode, retMsg: retCode ? 'Invalid symbol' : 'OK', result });
  const ok = { s: S, u: 5, seq: 50, ts: 9, b: [['99', '1'], ['98', '2']], a: [['101', '1'], ['102', '2']] };
  assert.deepEqual(parseFullSnapshot(body(ok), S), { u: 5, seq: 50, ts: 9, b: [[99, 1], [98, 2]], a: [[101, 1], [102, 2]] });
  assert.match(String(parseFullSnapshot(body(ok, 10001), S)), /^retCode 10001/);
  assert.equal(parseFullSnapshot(body({ ...ok, s: 'ETHUSDT' }), S), 'another symbol');
  assert.equal(parseFullSnapshot(body({ ...ok, u: 'x' }), S), 'no sequence');
  assert.equal(parseFullSnapshot(body({ ...ok, b: [['99', '0']] }), S), 'unreadable levels', 'a snapshot has no zero sizes');
  assert.equal(parseFullSnapshot(body({ ...ok, b: [['98', '1'], ['99', '1']] }), S), 'bids out of order');
  assert.equal(parseFullSnapshot(body({ ...ok, a: [['101', '1'], ['101', '2']] }), S), 'asks out of order', 'a repeated price');
  assert.equal(parseFullSnapshot(body({ ...ok, b: [['101', '1']] }), S), 'crossed');
  assert.equal(parseFullSnapshot('<html>', S), 'not an object');
});

/** A live book seeded at `u`: the stream's delta `u` is held first (its anchor), as it is before a snapshot is read. */
function seededBook(b: Rows = B0, a: Rows = A0, u = 5, options: ConstructorParameters<typeof FullBook>[0] = {}): FullBook {
  const book = new FullBook(options);
  book.delta(delta(u), 0);
  assert.equal(book.snapshot(snap(u, b, a), book.epoch, 0), 'seeded');
  return book;
}

test('bybit full book: seeding only on a held delta with the snapshot\'s own (seq, u)', () => {
  // At any delta held: those after it are applied in order.
  for (const at of [10, 11, 12]) {
    const book = new FullBook();
    for (let u = 10; u <= 12; u++) book.delta(delta(u, [[99, u]]), 0);
    assert.equal(book.snapshot(snap(at, B0, A0), book.epoch, 7), 'seeded', `snapshot at ${at}`);
    assert.equal(book.u, 12); assert.equal(book.seq, 120); assert.equal(book.appliedAt, 7);
    assert.equal(book.bids.get(99), at === 12 ? 1 : 12, 'the deltas after the anchor are applied, the anchor itself is in the snapshot');
  }

  // Just before the first delta held, or older: its anchor is not held, so it is read again (Bybit's procedure, strictly).
  let book = new FullBook();
  book.delta(delta(10), 0);
  assert.equal(book.snapshot(snap(9, B0, A0), book.epoch, 0), 'retry');
  assert.equal(book.snapshot(snap(8, B0, A0), book.epoch, 0), 'retry');
  assert.equal(book.live, false);

  // The anchor carries another seq (Bybit: equal u with unequal seq, or the reverse): read again, nothing installed.
  book = new FullBook();
  book.delta(delta(10), 0); book.delta(delta(11), 0);
  assert.equal(book.snapshot(snap(10, B0, A0, 99), book.epoch, 0), 'retry');
  assert.equal(book.live, false); assert.equal(book.bids.size, 0);
  // A delta after the anchor whose seq is not above the snapshot's does not fit.
  book = new FullBook();
  book.delta(delta(10, [], [], 100), 0); book.delta(delta(11, [], [], 100), 0);
  assert.equal(book.snapshot(snap(10, B0, A0, 100), book.epoch, 0), 'retry');

  // Nothing held yet, or ahead of everything held: kept until the stream reaches it, then judged on its anchor.
  book = new FullBook();
  assert.equal(book.snapshot(snap(5, B0, A0), book.epoch, 0), 'wait'); assert.equal(book.waiting, true);
  assert.equal(book.delta(delta(5, [[99, 7]]), 3), 'none');
  assert.equal(book.live, true); assert.equal(book.u, 5); assert.equal(book.bids.get(99), 1, 'the anchor is already in the snapshot');
  assert.equal(book.appliedAt, 3, 'seeded when the anchor arrived, at its time');
  book = new FullBook();
  book.delta(delta(10), 0);
  assert.equal(book.snapshot(snap(12, B0, A0), book.epoch, 0), 'wait');
  assert.equal(book.delta(delta(11), 0), 'none'); assert.equal(book.live, false);
  assert.equal(book.delta(delta(12, [[99, 7]]), 0), 'none');
  assert.equal(book.live, true); assert.equal(book.u, 12);
  book.delta(delta(13, [[99, 8]]), 0); assert.equal(book.bids.get(99), 8);
  // The stream brings the snapshot's u with another seq: no anchor, a new snapshot is wanted.
  book = new FullBook();
  book.delta(delta(10), 0);
  assert.equal(book.snapshot(snap(11, B0, A0, 999), book.epoch, 0), 'wait');
  assert.equal(book.delta(delta(11), 0), 'snapshot'); assert.equal(book.live, false); assert.equal(book.waiting, false);
  // Nothing held, and the stream starts past the snapshot: its anchor never came, a new one is wanted.
  book = new FullBook();
  assert.equal(book.snapshot(snap(5, B0, A0), book.epoch, 0), 'wait');
  assert.equal(book.delta(delta(6), 0), 'snapshot');

  // A gap in the stream while a snapshot waits: the buffer starts again and a new snapshot is wanted.
  book = new FullBook();
  book.delta(delta(10), 0);
  assert.equal(book.snapshot(snap(12, B0, A0), book.epoch, 0), 'wait');
  assert.equal(book.delta(delta(14), 0), 'snapshot');
  assert.equal(book.buffered, 1);

  // The buffer is bounded by frames and by rows: the oldest go, so a snapshot of their time is read again.
  book = new FullBook({ bufferMax: 3 });
  for (let u = 10; u <= 15; u++) book.delta(delta(u), 0);
  assert.equal(book.buffered, 3);
  assert.equal(book.snapshot(snap(11, B0, A0), book.epoch, 0), 'retry');
  book = new FullBook({ bufferRowsMax: 4 });
  for (let u = 10; u <= 13; u++) book.delta(delta(u, [[99, 1], [98, 1]]), 0);
  assert.equal(book.buffered, 2);

  // An answer to a request of an earlier epoch is not this book's.
  book = new FullBook();
  const epoch = book.epoch; book.reset();
  assert.equal(book.snapshot(snap(5, B0, A0), epoch, 0), 'stale');
});

test('bybit full book: live continuity, gaps, a new numbering and seq that goes back', () => {
  const book = seededBook();
  assert.equal(book.delta(delta(5, [[99, 9]]), 0), 'none'); assert.equal(book.bids.get(99), 1, 'a u already held is ignored');
  book.delta(delta(6, [[99, 2]], [[101, 0]]), 4);
  assert.equal(book.bids.get(99), 2); assert.equal(book.asks.has(101), false, 'zero deletes'); assert.equal(book.appliedAt, 4);
  // A price named twice in one delta: the later row wins.
  book.delta(delta(7, [[98, 5], [98, 6]]), 5); assert.equal(book.bids.get(98), 6);
  // seq went back: discarded, u does not move, so the next delta shows the gap.
  assert.equal(book.delta(delta(8, [[99, 3]], [], 1), 6), 'none'); assert.equal(book.u, 7); assert.equal(book.bids.get(99), 2); assert.equal(book.appliedAt, 5);
  const epoch = book.epoch, coverage = book.coverageEpoch;
  assert.equal(book.delta(delta(9), 1_000), 'snapshot');
  assert.equal(book.live, false); assert.equal(book.bids.size, 0, 'a withdrawn book has nothing'); assert.equal(book.epoch, epoch + 1);
  assert.ok(book.coverageEpoch > coverage, 'a withdrawal is a change of coverage');
  assert.match(String(book.lastFault), /sequence gap 7 -> 9/);
  // The gap delta is the new buffer's first: a snapshot anchored on it seeds.
  assert.equal(book.snapshot(snap(9, B0, A0), book.epoch, 2_000), 'seeded'); assert.equal(book.u, 9);
  // A second gap, then u = 1 within the minute: the third resynchronisation asks for a new socket. u = 1 comes before the duplicate rule.
  assert.equal(book.delta(delta(11), 3_000), 'snapshot');
  book.snapshot(snap(11, B0, A0), book.epoch, 4_000); assert.equal(book.live, true);
  assert.equal(book.delta(delta(1), 5_000), 'reconnect');
  assert.equal(book.live, false); assert.equal(book.buffered, 1);
  // After the window the count starts again.
  const fresh = seededBook();
  assert.equal(fresh.delta(delta(7), 0), 'snapshot'); fresh.snapshot(snap(7, B0, A0), fresh.epoch, 0);
  assert.equal(fresh.delta(delta(9), 30_000), 'snapshot'); fresh.snapshot(snap(9, B0, A0), fresh.epoch, 0);
  assert.equal(fresh.delta(delta(11), 70_000), 'snapshot', 'the first of the three is more than a minute old');
  // An unreadable frame withdraws the book like a gap does, and forgets the old sequence watermark: a numbering that starts again after it
  // (low seq) is held, not discarded.
  const faulty = seededBook();
  faulty.delta(delta(6, [], [], 1_000), 0);
  assert.equal(faulty.fault('unreadable book frame', 0), 'snapshot'); assert.equal(faulty.live, false); assert.equal(faulty.buffered, 0);
  faulty.delta(delta(1, [], [], 10), 1); faulty.delta(delta(2, [], [], 20), 2);
  assert.equal(faulty.buffered, 2, 'both frames held');
  assert.equal(faulty.snapshot(snap(2, B0, A0, 20), faulty.epoch, 3), 'seeded');
});

test('bybit full book: coverage epochs are unique across books; a new seed audits on time whatever the earlier refreshes did', () => {
  const one = seededBook(), two = seededBook();
  assert.ok(one.coverageEpoch > 0 && two.coverageEpoch > 0 && one.coverageEpoch !== two.coverageEpoch, 'a book made anew never repeats an earlier number');
  const before = one.coverageEpoch;
  one.delta(delta(7), 0);
  assert.notEqual(one.coverageEpoch, before, 'a withdrawal is a new number');
  // Refreshes that failed push the next one back; a seed after a gap starts clean, so its audit is due AUDIT_DELAY_MS after it.
  const book = seededBook();
  book.snapshot(snap(5, B0, A0), book.beginRefresh(0), 0);                       // the audit, passed
  for (let k = 1; k <= 4; k++) { const at = REFRESH_MIN_MS * 2 ** k; book.snapshot(snap(5, B0, A0), book.beginRefresh(at), at); }
  assert.equal(book.refreshDue(100, REFRESH_MIN_MS * 16 + 1), false, 'paused for a long while');
  const t = REFRESH_MIN_MS * 16 + 1;
  book.delta(delta(9), t); book.snapshot(snap(9, B0, A0), book.epoch, t);
  assert.equal(book.live, true); assert.equal(book.auditing, true);
  assert.equal(book.refreshDue(100, t + AUDIT_DELAY_MS), true, 'the new seed audits on time');
  assert.equal(book.mid(), 100);
  // Progress: held and applied deltas and seeds move it, a repeat of an applied u does not.
  const p = seededBook();
  const at = p.progressAt; p.delta(delta(5), 50);
  assert.equal(p.progressAt, at, 'a repeat is no progress');
  p.delta(delta(6), 60); assert.equal(p.progressAt, 60);
});

test('bybit full book: rows beyond the snapshot\'s frontier are left out, and the frontier stays', () => {
  const book = seededBook();
  assert.deepEqual(book.frontiers, { bid: 95, ask: 105 });
  book.delta(delta(6, [[94, 7], [95, 0], [96.5, 1]], [[106, 7], [105, 0]]), 0);
  assert.equal(book.bids.has(94), false, 'never seen beyond the frontier'); assert.equal(book.asks.has(106), false);
  assert.equal(book.bids.has(95), false); assert.equal(book.bids.get(96.5), 1);
  assert.deepEqual(book.frontiers, { bid: 95, ask: 105 }, 'deleting the edge level does not move the frontier');
  book.delta(delta(7, [[95, 3]]), 0); assert.equal(book.bids.get(95), 3, 'the frontier price itself is inside');
});

test('bybit full book: levels past GUARD of the mid are not kept and the frontier moves in to the cut', () => {
  // Mid 100: bids down to 30 and asks up to 1e9, as Bybit's linear book has.
  const book = seededBook([[99, 1], [50, 1], [41, 1], [39, 1], [30, 1]], [[101, 1], [150, 1], [159, 1], [161, 1], [1e9, 1]]);
  const low = 100 * (1 - GUARD), high = 100 * (1 + GUARD);
  assert.deepEqual(book.frontiers, { bid: low, ask: high });
  assert.deepEqual([...book.bids.keys()].sort((a, b) => b - a), [99, 50, 41]);
  assert.deepEqual([...book.asks.keys()].sort((a, b) => a - b), [101, 150, 159]);
  book.delta(delta(6, [[39.5, 1], [40.5, 1]], [[160.5, 1], [159.5, 1]]), 0);
  assert.equal(book.bids.has(39.5), false); assert.equal(book.bids.get(40.5), 1);
  assert.equal(book.asks.has(160.5), false); assert.equal(book.asks.get(159.5), 1);
});

test('bybit full book: a refresh is due when a frontier inside the band is approached or crossed, or its side may have come cut short', () => {
  // A capped spot-like side (SNAPSHOT_CAP levels) with frontiers at 90 and 110 around a mid of 100: due once a quarter of the 10 is used.
  const bids: Rows = [], asks: Rows = [];
  for (let i = 1; i <= SNAPSHOT_CAP; i++) { bids.push([100 - i * 0.001, 1]); asks.push([100 + i * 0.001, 1]); }
  const book = seededBook(bids, asks);
  assert.deepEqual(book.frontiers, { bid: 90, ask: 110 });
  // First the seed's audit, due AUDIT_DELAY_MS after it whatever the price; passed (the same book), it pauses the next refresh a minute.
  assert.equal(book.refreshDue(100, AUDIT_DELAY_MS - 1), false); assert.equal(book.refreshDue(100, AUDIT_DELAY_MS), true);
  assert.equal(book.snapshot(snap(5, bids, asks), book.beginRefresh(0), 0), 'unchanged'); assert.equal(book.auditing, false);
  assert.equal(book.refreshDue(100, REFRESH_MIN_MS), false);
  // What a snapshot reaches is a share of the price (10 % here): a quarter short of it is 7.32 at 97.6 and 7.29 at 97.2.
  assert.equal(book.refreshDue(97.6, REFRESH_MIN_MS), false, '7.6 left');
  assert.equal(book.refreshDue(97.2, REFRESH_MIN_MS), true, '7.2 left');
  assert.equal(book.refreshDue(102.6, REFRESH_MIN_MS), true, 'the ask side too');
  assert.equal(book.refreshDue(85, REFRESH_MIN_MS), true, 'a price past the bid frontier (directed distance below zero)');
  assert.equal(book.refreshDue(115, REFRESH_MIN_MS), true, 'and past the ask frontier');
  // A whole linear side cut at GUARD (60 %) lies outside the 50 % band: nothing is due for a long while.
  const whole = seededBook([[99, 1], [1, 1]], [[101, 1], [1e9, 1]]);
  assert.equal(whole.refreshDue(100, 0), false);
  assert.equal(whole.refreshDue(90, 0), false, 'frontier 40 is 55 % below 90: outside the band');
  assert.equal(whole.refreshDue(53, 0), true, 'frontier 40 is 25 % below 53, and 13 of the 60 are left');
  // Past the band at its seed, a frontier is due as soon as the band reaches it (50 % above 107 is 160.5), not once a quarter is used.
  assert.equal(whole.refreshDue(106, 0), false, '50 % above 106 is 159: inside the ask frontier 160');
  assert.equal(whole.refreshDue(107, 0), true);
  // The same with a full snapshot's worth of levels inside the cut (the perpetual's): only the band's reach makes it due.
  const longBids: Rows = [], longAsks: Rows = [];
  for (let i = 1; i <= SNAPSHOT_CAP; i++) { longBids.push([99 - i * 0.001, 1]); longAsks.push([101 + i * 0.001, 1]); }
  const full = seededBook([...longBids, [1, 1]], [...longAsks, [1e9, 1]]);
  assert.deepEqual(full.frontiers, { bid: 40, ask: 160 });
  assert.equal(full.refreshDue(100, 0), false); assert.equal(full.refreshDue(106, 0), false);
  assert.equal(full.refreshDue(107, 0), true, 'a quarter of the 60 is not used yet, but the band reaches past 160');
  assert.equal(full.refreshDue(80.1, 0), false, '50 % below 80.1 is 40.05: inside the bid frontier 40');
  assert.equal(full.refreshDue(79.9, 0), true, '50 % below 79.9 is 39.95: past it');
  // A side of fewer than SNAPSHOT_CAP levels whose frontier is inside the band may have come cut short: due at once (after the minute).
  const short = seededBook();
  assert.equal(short.refreshDue(100, 0), true);
  short.beginRefresh(0);
  assert.equal(short.refreshDue(100, 1), false, 'not while one is being read');
});

test('bybit full book: an audit only checks, so a side cut at the guard is not read again each time the mid moves', () => {
  // A linear book whose sides run far past the guard, cut at 40 and 160 around 100.
  const book = seededBook([[99, 1], [50, 1], [1, 1]], [[101, 1], [150, 1], [1e9, 1]]);
  assert.deepEqual(book.frontiers, { bid: 40, ask: 160 });
  // The price rises to 102 before the audit, whose own cut is then at 163.2: the audit passes and adds nothing.
  book.delta(delta(6, [[99, 0], [101.5, 1]], [[101, 0], [102.5, 1]]), 1);
  const seeded = book.coverageEpoch;
  assert.equal(book.refreshDue(102, AUDIT_DELAY_MS), true, "the seed's audit");
  let epoch = book.beginRefresh(AUDIT_DELAY_MS);
  assert.equal(book.snapshot(snap(6, [[101.5, 1], [50, 1], [1, 1]], [[102.5, 1], [150, 1], [1e9, 1]]), epoch, AUDIT_DELAY_MS), 'unchanged');
  assert.equal(book.coverageEpoch, seeded, 'no new coverage'); assert.deepEqual(book.frontiers, { bid: 40, ask: 160 }); assert.equal(book.auditing, false);
  // Nothing is read again while the band stays inside the frontiers.
  for (const minutes of [1, 2, 5, 30]) assert.equal(book.refreshDue(102, AUDIT_DELAY_MS + minutes * REFRESH_MIN_MS), false, `${minutes} min on`);
  // Once the band reaches past the ask frontier, a refresh is due, and it extends to the snapshot's own cut.
  const at = AUDIT_DELAY_MS + REFRESH_MIN_MS;
  assert.equal(book.refreshDue(107, at), true);
  epoch = book.beginRefresh(at);
  assert.equal(book.snapshot(snap(6, [[101.5, 1], [50, 1], [1, 1]], [[102.5, 1], [150, 1], [1e9, 1]]), epoch, at), 'extended');
  assert.equal(book.coverageEpoch, seeded + 1); assert.equal(book.frontiers.ask, 102 * (1 + GUARD)); assert.equal(book.auditing, true);
  // Its audit (a minute on) passes without extending again, though the mid has moved on to 104 and the audit's cut with it.
  book.delta(delta(7, [[101.5, 0], [103.5, 1]], [[102.5, 0], [104.5, 1]]), at + 1);
  assert.equal(book.refreshDue(104, at + REFRESH_MIN_MS), true, "the extension's audit");
  epoch = book.beginRefresh(at + REFRESH_MIN_MS);
  assert.equal(book.snapshot(snap(7, [[103.5, 1], [50, 1], [1, 1]], [[104.5, 1], [150, 1], [1e9, 1]]), epoch, at + REFRESH_MIN_MS), 'unchanged');
  assert.equal(book.coverageEpoch, seeded + 1); assert.equal(book.frontiers.ask, 102 * (1 + GUARD)); assert.equal(book.auditing, false);
  assert.equal(book.refreshDue(104, at + 3 * REFRESH_MIN_MS), false);
});

test('bybit full book: an audit that only checks leaves what the next refresh is judged by as it was', () => {
  // A short seed (five levels a side) whose audit brings a full snapshot: checked, nothing taken, and the short side is still due.
  const book = seededBook();
  const longB: Rows = [...B0], longA: Rows = [...A0];
  for (let i = 1; longB.length < SNAPSHOT_CAP; i++) { longB.push([95 - i * 0.0001, 1]); longA.push([105 + i * 0.0001, 1]); }
  assert.equal(book.refreshDue(100, AUDIT_DELAY_MS), true);
  let epoch = book.beginRefresh(AUDIT_DELAY_MS);
  assert.equal(book.snapshot(snap(5, longB, longA), epoch, AUDIT_DELAY_MS), 'unchanged');
  assert.deepEqual(book.frontiers, { bid: 95, ask: 105 }); assert.equal(book.auditing, false);
  assert.equal(book.refreshDue(100, AUDIT_DELAY_MS + REFRESH_MIN_MS), true, 'the short side is still due');
  epoch = book.beginRefresh(AUDIT_DELAY_MS + REFRESH_MIN_MS);
  assert.equal(book.snapshot(snap(5, longB, longA), epoch, AUDIT_DELAY_MS + REFRESH_MIN_MS), 'extended');
  assert.deepEqual(book.frontiers, { bid: longB.at(-1)![0], ask: longA.at(-1)![0] });
  // A side cut at the guard, audited once the price has moved to 107.25: its distance stays the seed's, so it is due as the band nears.
  const tailB: Rows = [[99, 1]], tailA: Rows = [[101, 1]];
  for (let i = 1; i <= SNAPSHOT_CAP; i++) { tailB.push([99 - i * 0.001, 1]); tailA.push([108 + i * 0.001, 1]); }
  tailB.push([1, 1]); tailA.push([1e9, 1]);
  const moved = seededBook(tailB, tailA);
  assert.deepEqual(moved.frontiers, { bid: 40, ask: 160 });
  moved.delta(delta(6, [[99, 0], [106.5, 1]], [[101, 0]]), 1);
  assert.equal(moved.refreshDue(107.25, AUDIT_DELAY_MS), true);
  epoch = moved.beginRefresh(AUDIT_DELAY_MS);
  assert.equal(moved.snapshot(snap(6, [[106.5, 1], ...tailB.slice(1)], tailA.slice(1)), epoch, AUDIT_DELAY_MS), 'unchanged');
  assert.deepEqual(moved.frontiers, { bid: 40, ask: 160 });
  assert.equal(moved.refreshDue(107.25, AUDIT_DELAY_MS + REFRESH_MIN_MS), true, '50 % above 107.25 is 160.875, past the ask frontier');
});

test('bybit full book: a refresh that adds nothing, or a side left empty, keeps the refresh due', () => {
  // A side cut at the guard, the price moved to 107.25, and a refresh answered by a snapshot from before the move (anchored on an
  // earlier delta, its own cut still at 160): nothing added, and the side keeps the distance its coverage was set at, so it is due
  // again after the pause.
  const tailB: Rows = [[99, 1]], tailA: Rows = [[101, 1]];
  for (let i = 1; i <= SNAPSHOT_CAP; i++) { tailB.push([99 - i * 0.001, 1]); tailA.push([108 + i * 0.001, 1]); }
  tailB.push([1, 1]); tailA.push([1e9, 1]);
  const book = seededBook(tailB, tailA);
  let epoch = book.beginRefresh(AUDIT_DELAY_MS);
  assert.equal(book.snapshot(snap(5, tailB, tailA), epoch, AUDIT_DELAY_MS), 'unchanged', 'the audit passes');
  book.delta(delta(6, [[99, 0], [106.5, 1]], [[101, 0]]), AUDIT_DELAY_MS + 1);
  const at = AUDIT_DELAY_MS + REFRESH_MIN_MS;
  assert.equal(book.refreshDue(107.25, at), true);
  epoch = book.beginRefresh(at);
  assert.equal(book.snapshot(snap(5, tailB, tailA), epoch, at), 'unchanged', 'a snapshot from before the move adds nothing');
  assert.deepEqual(book.frontiers, { bid: 40, ask: 160 });
  assert.equal(book.refreshDue(107.25, at + REFRESH_MIN_MS - 1), false, 'paced');
  assert.equal(book.refreshDue(107.25, at + REFRESH_MIN_MS), true, 'and due again');
  // The same on the bid side, the price fallen to 79.85.
  const lowB: Rows = [[99, 1]], lowA: Rows = [[101, 1]];
  for (let i = 1; i <= SNAPSHOT_CAP; i++) { lowB.push([79.8 - i * 0.001, 1]); lowA.push([101 + i * 0.001, 1]); }
  lowB.push([1, 1]); lowA.push([1e9, 1]);
  const fallen = seededBook(lowB, lowA);
  assert.deepEqual(fallen.frontiers, { bid: 40, ask: 160 });
  epoch = fallen.beginRefresh(AUDIT_DELAY_MS);
  assert.equal(fallen.snapshot(snap(5, lowB, lowA), epoch, AUDIT_DELAY_MS), 'unchanged');
  fallen.delta(delta(6, [[99, 0]], [[79.9, 1]]), AUDIT_DELAY_MS + 1);
  assert.equal(fallen.refreshDue(79.85, at), true, '50 % below 79.85 is 39.925, past the bid frontier');
  epoch = fallen.beginRefresh(at);
  assert.equal(fallen.snapshot(snap(5, lowB, lowA), epoch, at), 'unchanged');
  assert.equal(fallen.refreshDue(79.85, at + REFRESH_MIN_MS), true, 'due again after the pause');
  // A side whose last levels are deleted while the new ones arrive past its frontier (left out): no mid, and still due.
  const empty = seededBook();
  empty.delta(delta(6, [], [[101, 0], [102, 0], [103, 0], [104, 0], [105, 0], [106, 1], [107, 1]]), 1);
  assert.equal(empty.asks.size, 0); assert.ok(Number.isNaN(empty.mid()));
  epoch = empty.beginRefresh(AUDIT_DELAY_MS);
  assert.equal(empty.snapshot(snap(6, B0, [[106, 1], [107, 1]]), epoch, AUDIT_DELAY_MS), 'unchanged', 'the audit only checks');
  assert.equal(empty.refreshDue(empty.mid(), AUDIT_DELAY_MS + REFRESH_MIN_MS), true, 'an empty side is due');
  epoch = empty.beginRefresh(AUDIT_DELAY_MS + REFRESH_MIN_MS);
  assert.equal(empty.snapshot(snap(6, B0, [[106, 1], [107, 1]]), epoch, AUDIT_DELAY_MS + REFRESH_MIN_MS), 'extended');
  assert.deepEqual(sides(empty).a, [[106, 1], [107, 1]]); assert.equal(empty.mid(), (99 + 106) / 2);
});

test('bybit full book: a side that came empty is whole, and empty, out to the guard of the other side\'s best', () => {
  // Without a mid the empty side had no frontier, and every delta on it was taken, to a billion and without end.
  const book = seededBook([[99, 1], [98, 1]], []);
  assert.deepEqual(book.frontiers, { bid: 98, ask: 99 * (1 + GUARD) });
  book.delta(delta(6, [], [[101, 1], [158, 1], [160, 1], [1e9, 1]]), 1);
  assert.deepEqual(sides(book).a, [[101, 1], [158, 1]], 'past the cut nothing is taken');
  // An empty side is due for a refresh (paced), and the refresh brings what lies past the frontier.
  assert.equal(book.refreshDue(100, REFRESH_MIN_MS), true);
});

test('bybit full book: an answer cut to its nearest levels never shrinks what a side is judged to reach', () => {
  // Capped sides of 10,000 levels on a 0.001 grid around 100 (frontiers 90 and 110), the price at 106 before the seed's audit, and
  // the audit cut to its nearest 5,000 levels a side: whole as far as it goes (111 on the ask side, past the frontier 110), short of
  // what the venue holds (a full answer reaches 116). Taken as the side's reach, it left the ask side (4 left of 10 a full snapshot
  // reaches) never due while the price held.
  const grid = (from: number, step: number, count: number): Rows => Array.from({ length: count }, (_, i) => [Math.round((from + step * i) * 1000) / 1000, 1] as [number, number]);
  const book = seededBook(grid(99.999, -0.001, SNAPSHOT_CAP), grid(100.001, 0.001, SNAPSHOT_CAP));
  assert.deepEqual(book.frontiers, { bid: 90, ask: 110 });
  // The jump: asks up to 106 taken, bids from 100 to 105.999 placed.
  book.delta(delta(6, grid(100, 0.001, 6_000), grid(100.001, 0.001, 5_999).map(([p]): [number, number] => [p, 0])), 1);
  assert.equal(book.mid(), (105.999 + 106) / 2);
  let epoch = book.beginRefresh(AUDIT_DELAY_MS);
  assert.equal(book.snapshot(snap(6, grid(105.999, -0.001, 5_000), grid(106, 0.001, 5_001).slice(1)), epoch, AUDIT_DELAY_MS), 'unchanged', 'the cut audit agrees and only checks');
  assert.deepEqual(book.frontiers, { bid: 90, ask: 110 });
  // The price holds: the ask side, 4 left where a full snapshot reaches 10, is due after the pace.
  assert.equal(book.refreshDue(106, AUDIT_DELAY_MS + REFRESH_MIN_MS), true);
  epoch = book.beginRefresh(AUDIT_DELAY_MS + REFRESH_MIN_MS);
  assert.equal(book.snapshot(snap(6, grid(105.999, -0.001, SNAPSHOT_CAP), grid(106.001, 0.001, SNAPSHOT_CAP)), epoch, AUDIT_DELAY_MS + REFRESH_MIN_MS), 'extended');
  assert.equal(book.frontiers.ask, 116);
});

test('bybit full book: a perpetual\'s answer cut to the cap does not shorten what its sides are judged to reach', () => {
  // A whole perpetual book (20,000 dense levels a side and a few far ones: frontiers at the cuts, 40 and 160), the price at 107.25
  // before the seed's audit, and the audit cut to its nearest 10,000 levels a side (Bybit's documented limit, the asks ending near
  // 118): whole as far as it goes and agreeing, but a tenth of what the side was set from. Counted full by the cap, it set the ask
  // reach to 10 %, and the band passing the frontier 160 was never due.
  const grid = (from: number, step: number, count: number): Rows => Array.from({ length: count }, (_, i) => [Math.round((from + step * i) * 1000) / 1000, 1] as [number, number]);
  const bids = [...grid(99.999, -0.001, 20_000), [50, 1], [1, 1]] as Rows, asks = [...grid(100.001, 0.001, 20_000), [130, 1], [150, 1], [170, 1], [1e9, 1]] as Rows;
  const book = seededBook(bids, asks);
  assert.deepEqual(book.frontiers, { bid: 40, ask: 160 });
  // The move: asks below 108 taken, a bid at 106.5.
  book.delta(delta(6, [[106.5, 1]], grid(100.001, 0.001, 7_999).map(([p]): [number, number] => [p, 0])), 1);
  assert.equal(book.mid(), 107.25);
  let epoch = book.beginRefresh(AUDIT_DELAY_MS);
  const cut = snap(6, [[106.5, 1], ...grid(99.999, -0.001, SNAPSHOT_CAP - 1)], grid(108, 0.001, SNAPSHOT_CAP));
  assert.equal(book.snapshot(cut, epoch, AUDIT_DELAY_MS), 'unchanged', 'the cut audit agrees and only checks');
  assert.deepEqual(book.frontiers, { bid: 40, ask: 160 });
  assert.equal(book.refreshDue(107.25, AUDIT_DELAY_MS + REFRESH_MIN_MS), true, '50 % above 107.25 is 160.875, past the ask frontier');
  epoch = book.beginRefresh(AUDIT_DELAY_MS + REFRESH_MIN_MS);
  const whole = snap(6, [[106.5, 1], ...bids], asks.filter(([p]) => p >= 108));
  assert.equal(book.snapshot(whole, epoch, AUDIT_DELAY_MS + REFRESH_MIN_MS), 'extended');
  assert.equal(book.frontiers.ask, 107.25 * (1 + GUARD));
});

test('bybit full book: an answer with no level on either side is no book to seed from', () => {
  // Seeded, it would leave both frontiers open and keep every delta row, to a billion and without end.
  const book = new FullBook();
  book.delta(delta(5), 0);
  assert.equal(book.snapshot(snap(5, [], []), book.epoch, 0), 'retry');
  assert.equal(book.live, false);
  assert.equal(book.snapshot(snap(5, B0, A0), book.epoch, 1), 'seeded', 'the next answer with a book seeds as usual');
});

test('bybit full book: a refresh adds only coverage past the live frontiers; inside, the stream-kept book stays', () => {
  const book = seededBook();
  book.delta(delta(6, [[99, 6]]), 1); book.delta(delta(7, [[98, 7]], [[101, 0]]), 2);
  const epoch = book.beginRefresh(10);
  assert.equal(book.refreshing, true);
  book.delta(delta(8, [[97, 8], [92, 9]], [[107, 1]]), 11);
  // The price moved up: the snapshot (made at u 7) reaches 108 on the ask side and only 96 on the bid side; it also disagrees with the
  // stream-kept book at 103 (a replica's own copy) and lacks 104.
  const before = book.coverageEpoch;
  assert.equal(book.snapshot(snap(7, [[99, 6], [98, 7], [97, 3], [96, 4]], [[102, 2], [103, 30], [105, 5], [106, 6], [107, 7], [108, 8]], 70), epoch, 12), 'extended');
  assert.equal(book.refreshing, false); assert.equal(book.u, 8); assert.equal(book.coverageEpoch, before + 1);
  assert.deepEqual(book.frontiers, { bid: 95, ask: 108 }, 'the bid side keeps its own deeper reach');
  const { b, a } = sides(book);
  assert.deepEqual(b, [[99, 6], [98, 7], [97, 8], [96, 4], [95, 5]], 'inside the window, the stream-kept book; delta 8 at 92 stays beyond the frontier');
  assert.deepEqual(a, [[102, 2], [103, 3], [104, 4], [105, 5], [106, 6], [107, 1], [108, 8]], 'past 105 the snapshot caught up with delta 8; inside, nothing changed');
  assert.deepEqual(book.disagreements, { snapshotOnly: 0, liveOnly: 1, sizes: 1 }, '104 is missing from the snapshot and 103 differs');
  // Deltas past the new frontier are still left out; inside it they apply.
  book.delta(delta(9, [], [[108, 2], [109, 1]]), 13);
  assert.equal(book.asks.get(108), 2); assert.equal(book.asks.has(109), false);
});

test('bybit full book: the seed\'s audit replaces a degraded seed, ignores a degraded audit, and audits again when both differ', () => {
  // A whole book of 1,000 levels a side around 100, and a degraded copy: whole within 2 % of the price, a third of the levels beyond.
  const whole: { b: Rows; a: Rows } = { b: [], a: [] };
  for (let i = 1; i <= 1_000; i++) { whole.b.push([100 - i * 0.01, 1]); whole.a.push([100 + i * 0.01, 1]); }
  const thin = (rows: Rows, keep: (i: number) => boolean): Rows => rows.filter(([p], i) => Math.abs(p - 100) <= 2 || keep(i));
  const degraded = { b: thin(whole.b, i => i % 3 === 0), a: thin(whole.a, i => i % 3 === 0) };
  // Seeded from the degraded answer: the audit (the whole one, at the same (seq, u)) repairs it.
  let book = seededBook(degraded.b, degraded.a);
  assert.equal(book.auditing, true);
  const before = book.coverageEpoch;
  assert.equal(book.snapshot(snap(5, whole.b, whole.a), book.beginRefresh(AUDIT_DELAY_MS), AUDIT_DELAY_MS), 'repaired');
  assert.equal(book.bids.size, 1_000); assert.equal(book.asks.size, 1_000);
  assert.equal(book.auditing, true, 'the repaired book is audited in turn');
  assert.ok(book.coverageEpoch > before, 'a repaired book is new coverage');
  assert.ok(book.disagreements.snapshotOnly > 1_000 && book.disagreements.liveOnly === 0);
  // Seeded from the whole answer: a degraded audit is ignored, and the audit counts as passed.
  book = seededBook(whole.b, whole.a);
  assert.equal(book.snapshot(snap(5, degraded.b, degraded.a), book.beginRefresh(AUDIT_DELAY_MS), AUDIT_DELAY_MS), 'unchanged');
  assert.equal(book.bids.size, 1_000); assert.equal(book.auditing, false);
  // Two degraded answers that lack different levels: nothing is taken, and the audit is due again after the pause.
  const other = { b: thin(whole.b, i => i % 3 === 1), a: thin(whole.a, i => i % 3 === 1) };
  book = seededBook(degraded.b, degraded.a);
  assert.equal(book.snapshot(snap(5, other.b, other.a), book.beginRefresh(AUDIT_DELAY_MS), AUDIT_DELAY_MS), 'unchanged');
  assert.equal(book.auditing, true); assert.equal(book.bids.size, degraded.b.length);
  assert.equal(book.refreshDue(100, AUDIT_DELAY_MS + REFRESH_MIN_MS), true);
  // A few levels that differ (a replica's own) are an ordinary audit: passed, the stream-kept levels stay.
  book = seededBook(whole.b, whole.a);
  const replica = { b: whole.b.filter((_, i) => i !== 500), a: whole.a.map(([p, q], i): [number, number] => [p, i === 7 ? 9 : q]) };
  assert.equal(book.snapshot(snap(5, replica.b, replica.a), book.beginRefresh(AUDIT_DELAY_MS), AUDIT_DELAY_MS), 'unchanged');
  assert.equal(book.auditing, false); assert.equal(book.bids.size, 1_000); assert.equal(book.asks.get(whole.a[7]![0]), 1);
  assert.deepEqual(book.disagreements, { snapshotOnly: 0, liveOnly: 1, sizes: 1 });
});

test('bybit full book: a refresh ahead of the book waits; one that adds nothing or cannot be anchored backs off', () => {
  let book = seededBook();
  let epoch = book.beginRefresh(0);
  assert.equal(book.snapshot(snap(7, B0, [...A0, [106, 6]]), epoch, 0), 'wait');
  book.delta(delta(6, [[99, 6]]), 0); assert.equal(book.refreshing, true);
  book.delta(delta(7, [], [[106, 6]]), 0);
  assert.equal(book.refreshing, false, 'finished once the book reached it'); assert.equal(book.asks.get(106), 6); assert.equal(book.frontiers.ask, 106);

  // The first refresh after a seed is its audit: passed and adding nothing, it pauses the next one a minute only.
  book = seededBook();
  epoch = book.beginRefresh(0);
  assert.equal(book.snapshot(snap(5, B0, A0), epoch, 0), 'unchanged');
  assert.equal(book.refreshing, false); assert.equal(book.live, true); assert.equal(book.auditing, false);
  assert.equal(book.refreshDue(100, REFRESH_MIN_MS - 1), false); assert.equal(book.refreshDue(100, REFRESH_MIN_MS), true);
  // Refreshes that add nothing then wait longer each time (a minute, two, four ...).
  epoch = book.beginRefresh(REFRESH_MIN_MS);
  assert.equal(book.snapshot(snap(5, B0, A0), epoch, REFRESH_MIN_MS), 'unchanged');
  assert.equal(book.refreshDue(100, REFRESH_MIN_MS * 2 - 1), false); assert.equal(book.refreshDue(100, REFRESH_MIN_MS * 2), true);
  epoch = book.beginRefresh(REFRESH_MIN_MS * 2);
  assert.equal(book.snapshot(snap(5, B0, A0), epoch, REFRESH_MIN_MS * 2), 'unchanged');
  assert.equal(book.refreshDue(100, REFRESH_MIN_MS * 4 - 1), false); assert.equal(book.refreshDue(100, REFRESH_MIN_MS * 4), true);

  // At the live u with another seq, or too far behind the deltas kept: rejected, the live book stays.
  book = seededBook();
  epoch = book.beginRefresh(0);
  assert.equal(book.snapshot(snap(5, B0, A0, 51), epoch, 0), 'rejected');
  // Its anchor gone with the recent rows' budget: rejected.
  book = seededBook(B0, A0, 5, { recentRowsMax: 4 });
  for (let u = 6; u <= 8; u++) book.delta(delta(u, [[99, u], [98, u]]), 0);
  epoch = book.beginRefresh(0);
  assert.equal(book.snapshot(snap(6, B0, A0), epoch, 0), 'rejected');
  // Too far behind the deltas kept: rejected.
  book = seededBook(B0, A0, 5, { recentMax: 2 });
  for (let u = 6; u <= 10; u++) book.delta(delta(u), 0);
  epoch = book.beginRefresh(0);
  assert.equal(book.snapshot(snap(7, B0, A0), epoch, 0), 'rejected');
  assert.equal(book.live, true);

  // A refresh snapshot ahead of the book that the stream never reaches is given up after ANCHOR_WAIT_MS, and the next one is paused.
  book = seededBook();
  epoch = book.beginRefresh(0);
  assert.equal(book.snapshot(snap(9, B0, A0), epoch, 0), 'wait');
  assert.equal(book.refreshDue(100, ANCHOR_WAIT_MS), false); assert.equal(book.refreshing, true, 'still waiting at the limit');
  assert.equal(book.refreshDue(100, ANCHOR_WAIT_MS + 1), false); assert.equal(book.refreshing, false, 'given up past it');
  assert.equal(book.refreshDue(100, ANCHOR_WAIT_MS + 1 + REFRESH_MIN_MS), true, 'and the next waits the pause');
  // A request failure from an earlier epoch does not touch the book seeded since: its audit is due on time.
  book = seededBook();
  const old = book.beginRefresh(0);
  book.delta(delta(9), 1); book.snapshot(snap(9, B0, A0), book.epoch, 2);
  book.failRefresh(3, old);
  assert.equal(book.refreshDue(100, 2 + AUDIT_DELAY_MS), true, 'the new seed audits on time');
  // A gap during a refresh ends it with the book; its answer is then stale.
  book = seededBook();
  epoch = book.beginRefresh(0);
  book.delta(delta(9), 0);
  assert.equal(book.snapshot(snap(5, B0, A0), epoch, 0), 'stale');
});


/** A seeded random number generator (mulberry32), so a failure can be replayed. */
function rng(seed: number): () => number {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('bybit full book: against a simulated exchange, the kept book equals the venue\'s inside the frontiers', () => {
  const seen = { seeded: 0, extended: 0, repaired: 0, unchanged: 0, rejected: 0, retry: 0, wait: 0, compared: 0, lost: 0 };
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed), CAP = 120;
    // The venue: a book on a 0.5 grid around a mid that drifts; snapshots capped at CAP levels a side (Bybit's spot cap).
    const vb = new Map<number, number>(), va = new Map<number, number>();
    let mid = 1000, u = 0, seq = 0;
    for (let i = 1; i <= 150; i++) { vb.set(mid - i * 0.5, 1 + Math.floor(r() * 9)); va.set(mid + i * 0.5, 1 + Math.floor(r() * 9)); }
    const venueSnap = (): FullSnapshot => ({ u, seq, ts: 0, b: [...vb].sort((x, y) => y[0] - x[0]).slice(0, CAP), a: [...va].sort((x, y) => x[0] - y[0]).slice(0, CAP) });
    // Replicas: an answer may come from one up to 20 steps behind, now and then cut to half its levels, and now and then degraded (whole
    // within 15 of the mid, a third of the levels beyond: what about one linear answer in twenty is, measured).
    const past: FullSnapshot[] = [];
    const replica = (): FullSnapshot => {
      const x = r(), s = x < 0.15 && past.length ? past[Math.floor(r() * past.length)]! : venueSnap();
      const y = r();
      if (y < 0.05) return { ...s, b: s.b.slice(0, CAP / 2) };
      if (y < 0.15) { const m = s.b.length && s.a.length ? (s.b[0]![0] + s.a[0]![0]) / 2 : 0, thin = (rows: Rows): Rows => rows.filter(([p], i) => Math.abs(p - m) <= 15 || i % 3 === 0 || i === rows.length - 1); return { ...s, b: thin(s.b), a: thin(s.a) }; }
      return s;
    };
    const step = (): FullDelta => {
      mid += (r() - 0.5) * 2;
      const b: Rows = [], a: Rows = [];
      for (let k = 0; k < 6; k++) {
        const bid = Math.round((mid - 0.5 - r() * 90) * 2) / 2, ask = Math.round((mid + 0.5 + r() * 90) * 2) / 2;
        const qb = r() < 0.3 ? 0 : 1 + Math.floor(r() * 9), qa = r() < 0.3 ? 0 : 1 + Math.floor(r() * 9);
        if (qb) vb.set(bid, qb); else vb.delete(bid); b.push([bid, qb]);
        if (qa) va.set(ask, qa); else va.delete(ask); a.push([ask, qa]);
      }
      // Keep the venue uncrossed: levels on the wrong side of the mid go.
      for (const p of [...vb.keys()]) if (p >= mid) { vb.delete(p); b.push([p, 0]); }
      for (const p of [...va.keys()]) if (p <= mid) { va.delete(p); a.push([p, 0]); }
      return { u: ++u, seq: (seq += 1 + Math.floor(r() * 3)), ts: 0, b, a };
    };
    // Its book changes far faster than a real one's far levels (six rows a side every step over some 180 bins), so the audit comes sooner.
    const book = new FullBook({ recentMax: 40, degradedMin: 20, auditDelayMs: 1_000 });
    // The stream reaches the book up to three steps late, so a snapshot (read from the venue as it is) can be ahead of the book.
    const transit: { d: FullDelta; at: number }[] = [];
    const inflight: { s: FullSnapshot; epoch: number; due: number }[] = [];
    const ask = (t: number, epoch: number): void => { inflight.push({ s: replica(), epoch, due: t + Math.floor(r() * 4) * 200 }); };
    let t = 0;
    for (let n = 0; n < 1500; n++) {
      t += 200;
      transit.push({ d: step(), at: t + Math.floor(r() * 4) * 200 });
      past.push(venueSnap()); if (past.length > 20) past.shift();
      while (transit.length && transit[0]!.at <= t) {
        const { d } = transit.shift()!;
        // Now and then a frame is lost (a gap in u).
        if (r() < 0.004) { seen.lost++; continue; }
        if (book.delta(d, t) !== 'none' && !inflight.some(j => j.epoch === book.epoch)) ask(t, book.epoch);
      }
      if (!book.live && !inflight.some(j => j.epoch === book.epoch) && !book.refreshing) ask(t, book.epoch);
      if (book.live && !book.refreshing && book.refreshDue(mid, t)) ask(t, book.beginRefresh(t));
      for (const job of inflight.splice(0)) {
        if (job.due > t) { inflight.push(job); continue; }
        const result = book.snapshot(job.s, job.epoch, t);
        if (result in seen) seen[result as keyof typeof seen]++;
        if (result === 'retry') ask(t, book.epoch);
      }
      // Compared whenever the book has caught up with the venue (every delta made so far applied) and passed its seed's audit.
      if (book.live && book.u === u && !book.auditing) {
        seen.compared++;
        const { bid, ask: askEdge } = book.frontiers;
        for (const [p, q] of vb) if (bid === null || p >= bid) assert.equal(book.bids.get(p), q, `seed ${seed} step ${n}: bid ${p}`);
        for (const [p] of book.bids) assert.ok(vb.has(p), `seed ${seed} step ${n}: extra bid ${p}`);
        for (const [p, q] of va) if (askEdge === null || p <= askEdge) assert.equal(book.asks.get(p), q, `seed ${seed} step ${n}: ask ${p}`);
        for (const [p] of book.asks) assert.ok(va.has(p), `seed ${seed} step ${n}: extra ask ${p}`);
      }
    }
  }
  // The run went through every path it is meant to test.
  for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `${k}: ${JSON.stringify(seen)}`);
});
