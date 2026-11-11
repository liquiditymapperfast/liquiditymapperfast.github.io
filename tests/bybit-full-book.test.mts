import test from 'node:test';
import assert from 'node:assert/strict';
import { FullBook, GUARD, REFRESH_MIN_MS, SNAPSHOT_CAP, fullSnapshotUrl, fullTopic, parseFullDelta, parseFullSnapshot, type FullDelta, type FullSnapshot } from '../src/shared/bybit-full-book.ts';

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
  // An unreadable frame withdraws the book like a gap does.
  const faulty = seededBook();
  assert.equal(faulty.fault('unreadable book frame', 0), 'snapshot'); assert.equal(faulty.live, false); assert.equal(faulty.buffered, 0);
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
  assert.equal(book.refreshDue(100, REFRESH_MIN_MS), false);
  assert.equal(book.refreshDue(97.6, REFRESH_MIN_MS), false, '7.6 left of 10');
  assert.equal(book.refreshDue(97.4, REFRESH_MIN_MS), true, '7.4 left');
  assert.equal(book.refreshDue(102.6, REFRESH_MIN_MS), true, 'the ask side too');
  assert.equal(book.refreshDue(85, REFRESH_MIN_MS), true, 'a price past the bid frontier (directed distance below zero)');
  assert.equal(book.refreshDue(115, REFRESH_MIN_MS), true, 'and past the ask frontier');
  // A whole linear side cut at GUARD (60 %) lies outside the 50 % band: nothing is due for a long while.
  const whole = seededBook([[99, 1], [1, 1]], [[101, 1], [1e9, 1]]);
  assert.equal(whole.refreshDue(100, 0), false);
  assert.equal(whole.refreshDue(90, 0), false, 'frontier 40 is 55 % below 90: outside the band');
  assert.equal(whole.refreshDue(53, 0), true, 'frontier 40 is 25 % below 53, and 13 of the 60 are left');
  // A side of fewer than SNAPSHOT_CAP levels whose frontier is inside the band may have come cut short: due at once (after the minute).
  const short = seededBook();
  assert.equal(short.refreshDue(100, 0), true);
  short.beginRefresh(0);
  assert.equal(short.refreshDue(100, 1), false, 'not while one is being read');
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
  assert.equal(book.disagreements, 2, '103 differs and 104 is missing from the snapshot');
  // Deltas past the new frontier are still left out; inside it they apply.
  book.delta(delta(9, [], [[108, 2], [109, 1]]), 13);
  assert.equal(book.asks.get(108), 2); assert.equal(book.asks.has(109), false);
});

test('bybit full book: a refresh ahead of the book waits; one that adds nothing or cannot be anchored backs off', () => {
  let book = seededBook();
  let epoch = book.beginRefresh(0);
  assert.equal(book.snapshot(snap(7, B0, [...A0, [106, 6]]), epoch, 0), 'wait');
  book.delta(delta(6, [[99, 6]]), 0); assert.equal(book.refreshing, true);
  book.delta(delta(7, [], [[106, 6]]), 0);
  assert.equal(book.refreshing, false, 'finished once the book reached it'); assert.equal(book.asks.get(106), 6); assert.equal(book.frontiers.ask, 106);

  // Nothing new: unchanged, and the next refresh waits longer each time (a minute, two, four ...).
  book = seededBook();
  epoch = book.beginRefresh(0);
  assert.equal(book.snapshot(snap(5, B0, A0), epoch, 0), 'unchanged');
  assert.equal(book.refreshing, false); assert.equal(book.live, true);
  assert.equal(book.refreshDue(100, REFRESH_MIN_MS - 1), false); assert.equal(book.refreshDue(100, REFRESH_MIN_MS), true);
  epoch = book.beginRefresh(REFRESH_MIN_MS);
  assert.equal(book.snapshot(snap(5, B0, A0), epoch, REFRESH_MIN_MS), 'unchanged');
  assert.equal(book.refreshDue(100, REFRESH_MIN_MS * 2.5), false); assert.equal(book.refreshDue(100, REFRESH_MIN_MS * 3), true);

  // At the live u with another seq, or too far behind the deltas kept: rejected, the live book stays.
  book = seededBook();
  epoch = book.beginRefresh(0);
  assert.equal(book.snapshot(snap(5, B0, A0, 51), epoch, 0), 'rejected');
  book = seededBook(B0, A0, 5, { recentMax: 2 });
  for (let u = 6; u <= 10; u++) book.delta(delta(u), 0);
  epoch = book.beginRefresh(0);
  assert.equal(book.snapshot(snap(7, B0, A0), epoch, 0), 'rejected');
  assert.equal(book.live, true);

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
  const seen = { seeded: 0, extended: 0, unchanged: 0, rejected: 0, retry: 0, wait: 0, compared: 0, lost: 0 };
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed), CAP = 120;
    // The venue: a book on a 0.5 grid around a mid that drifts; snapshots capped at CAP levels a side (Bybit's spot cap).
    const vb = new Map<number, number>(), va = new Map<number, number>();
    let mid = 1000, u = 0, seq = 0;
    for (let i = 1; i <= 150; i++) { vb.set(mid - i * 0.5, 1 + Math.floor(r() * 9)); va.set(mid + i * 0.5, 1 + Math.floor(r() * 9)); }
    const venueSnap = (): FullSnapshot => ({ u, seq, ts: 0, b: [...vb].sort((x, y) => y[0] - x[0]).slice(0, CAP), a: [...va].sort((x, y) => x[0] - y[0]).slice(0, CAP) });
    // Replicas: an answer may come from one up to 20 steps behind, and now and then cut to half its levels.
    const past: FullSnapshot[] = [];
    const replica = (): FullSnapshot => {
      const x = r(), s = x < 0.15 && past.length ? past[Math.floor(r() * past.length)]! : venueSnap();
      return r() < 0.05 ? { ...s, b: s.b.slice(0, CAP / 2) } : s;
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
    const book = new FullBook({ recentMax: 40 });
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
      // Compared whenever the book has caught up with the venue (every delta made so far applied).
      if (book.live && book.u === u) {
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
