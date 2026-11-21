import test from 'node:test';
import assert from 'node:assert/strict';
import { barAt, columnAt, depthCardLines, liqCardLines, liqColumnRows, liqReading, liqRowAt, ltCardLines, oiCardLines, oiTail, readAt, readsBooksNow, slotAt } from '../src/app/panes/pane-cards.ts';
import { layoutInfo } from '../src/app/infobox.ts';

const MIN = 60_000;
const by = (lines: ReturnType<typeof depthCardLines>, label: string) => lines.find(line => line.label === label);

test('the column under the pointer: each column owns its start and not its end, and outside the series there is none', () => {
  assert.equal(columnAt(1_000, 2_000, 10, 1_000), 0);
  assert.equal(columnAt(1_000, 2_000, 10, 1_099), 0);
  assert.equal(columnAt(1_000, 2_000, 10, 1_100), 1);
  assert.equal(columnAt(1_000, 2_000, 10, 1_999), 9);
  assert.equal(columnAt(1_000, 2_000, 10, 2_000), -1);
  assert.equal(columnAt(1_000, 2_000, 10, 999), -1);
  assert.equal(columnAt(2_000, 1_000, 10, 1_500), -1, 'an empty or reversed window has no columns');
});

test('a Liquidity Tracker point is found by its slot, and the gaps between points have none', () => {
  const times = [0, MIN, 2 * MIN, 10 * MIN];
  assert.equal(slotAt(times, MIN, 30_000), 0);
  assert.equal(slotAt(times, MIN, MIN), 1);
  assert.equal(slotAt(times, MIN, 3 * MIN - 1), 2);
  assert.equal(slotAt(times, MIN, 3 * MIN), -1, 'recording had stopped');
  assert.equal(slotAt(times, MIN, 10 * MIN + 59_000), 3);
  assert.equal(slotAt(times, MIN, -1), -1);
  assert.equal(slotAt([], MIN, 0), -1);
});

test('an open-interest bar is the last that has started; only the newest holds on past its own slot', () => {
  const bars = [[0], [MIN], [5 * MIN]];
  assert.equal(barAt(bars, MIN, 30_000), 0);
  assert.equal(barAt(bars, MIN, 90_000), 1);
  assert.equal(barAt(bars, MIN, 3 * MIN), -1, 'between samples, nothing was measured');
  assert.equal(barAt(bars, MIN, 5 * MIN + 10 * MIN), 2, 'the newest level stands until the next sample');
  assert.equal(barAt(bars, MIN, -5), -1);
});

test('the depth popup gives every band, the watched one in bold with how its sides compare, and where the moment ranks', () => {
  const bands = [{ r: 0.003125, bid: 10_000_000, ask: 4_000_000 }, { r: 0.0125, bid: 20_000_000, ask: 8_000_000 }, { r: 0.05, bid: 30_000_000, ask: 10_000_000 }];
  const lines = depthCardLines({ time: Date.UTC(2026, 9, 6, 12, 30), bands, watched: 2, units: 'usd', coin: 'BTC', rank: 3, of: 120 });
  assert.equal(lines[0]!.text, 'Depth'); assert.equal(lines[0]!.bold, true);
  assert.deepEqual(['±0.31%', '±1.25%', '±5%'].map(label => by(lines, label)!.text), ['$10M · $4M', '$20M · $8M', '$30M · $10M'], 'bids · asks, a line a band');
  assert.deepEqual(['±0.31%', '±1.25%', '±5%'].map(label => by(lines, label)!.bold), [false, false, true], 'the watched band is the bold one');
  assert.equal(by(lines, 'Δ')!.text, '+$20M'); assert.equal(by(lines, 'Δ')!.color, 'below', 'bids lead in the watched band');
  assert.deepEqual([by(lines, 'Imbalance')!.text, by(lines, 'Imbalance')!.color], ['bids +50.0%', 'below']);
  assert.deepEqual([by(lines, 'Ratio')!.text, by(lines, 'Ratio')!.color], ['bids 3.00×', 'below'], 'how many times the larger side is the smaller');
  assert.equal(by(lines, 'Rank in view')!.text, '3 of 120');
  const last = lines.at(-1)!;
  assert.deepEqual([last.color, last.wrap, last.rule], ['muted', true, true], 'the last line says what the numbers are');

  const inner = depthCardLines({ time: 0, bands, watched: 0, units: 'usd', coin: 'BTC', rank: null, of: 1 });
  assert.equal(by(inner, 'Δ')!.text, '+$6M', 'the band brought forward is the one compared');
  assert.equal(by(inner, 'Rank in view'), undefined, 'a rank among one is not said');
  const coins = depthCardLines({ time: 0, bands: [{ r: 0.01, bid: 100, ask: 300 }], watched: 0, units: 'coin', coin: 'BTC', rank: 1, of: 2 });
  assert.equal(by(coins, '±1%')!.text, '100 BTC · 300 BTC'); assert.equal(by(coins, 'Δ')!.text, '−200 BTC'); assert.equal(by(coins, 'Δ')!.color, 'above');
  const fraction = depthCardLines({ time: 0, bands: [{ r: 0.01, bid: 0.01, ask: 0.005 }], watched: 0, units: 'coin', coin: 'BTC', rank: 1, of: 2 });
  assert.equal(by(fraction, '±1%')!.text, '0.01 BTC · 0.005 BTC', 'a fraction of a coin is not 0'); assert.equal(by(fraction, 'Δ')!.text, '+0.005 BTC');
});

test('the Liquidity Tracker popup says what it was worked out with', () => {
  const lines = ltCardLines({ time: 0, bid: 8_000_000, ask: 12_000_000, halfLifeBp: 25, venues: 7 });
  assert.equal(lines[0]!.text, 'Liquidity Tracker');
  assert.deepEqual([by(lines, 'Bid')!.color, by(lines, 'Ask')!.color], ['below', 'above']);
  assert.equal(by(lines, 'Δ')!.text, '−$4M'); assert.equal(by(lines, 'Δ')!.color, 'above');
  assert.deepEqual([by(lines, 'Ratio')!.text, by(lines, 'Ratio')!.color], ['asks 1.50×', 'above']);
  assert.equal(by(lines, 'Half-life')!.text, '25 bp'); assert.equal(by(lines, 'Venues')!.text, '7');
  assert.equal(lines.at(-1)!.rule, true);
  assert.equal(by(ltCardLines({ time: 0, bid: 0, ask: 0, halfLifeBp: 10, venues: 0 }), 'Imbalance'), undefined, 'no liquidity: no balance to speak of');
  assert.equal(by(ltCardLines({ time: 0, bid: 5, ask: 5, halfLifeBp: 10, venues: 1 }), 'Ratio'), undefined, 'even: no ratio line');
});

test('the open-interest popup has the level and the step, and only the lines that have something to say', () => {
  const full = oiCardLines({ time: 0, level: 12_345.6, change: 150, before: -20, rank: 2, of: 40, sigma: 3.456, source: 'from Binance BTCUSDT', staleMin: null });
  assert.equal(full[0]!.text, 'Open Interest');
  assert.equal(by(full, 'Open interest')!.text, '12,346', 'as the pane readout writes it: whole units'); assert.equal(by(full, 'Open interest')!.bold, true);
  assert.deepEqual([by(full, 'Δ')!.text, by(full, 'Δ')!.color], ['+150', 'below']);
  assert.equal(by(full, 'Candle before')!.text, '−20');
  assert.equal(by(full, 'Rank in view')!.text, '2 of 40');
  assert.equal(by(full, 'Unusual')!.text, '3.5σ above its baseline');
  assert.ok(full.some(line => line.text === 'from Binance BTCUSDT' && line.color === 'muted'));
  const first = oiCardLines({ time: 0, level: 100, change: null, before: null, rank: null, of: 0, sigma: null, source: null, staleMin: 7 });
  assert.equal(by(first, 'Δ'), undefined, 'the first bar has no bar before it to be compared with');
  assert.equal(by(first, 'Unusual'), undefined);
  assert.ok(first.some(line => line.text === 'last sample 7 min ago' && line.color === 'above'));
});

test('every popup fits the box: no line is left without text, and a long sentence is wrapped, not run off the side', () => {
  const measure = (text: string): number => text.length * 6;
  for (const lines of [
    depthCardLines({ time: 0, bands: [{ r: 0.003125, bid: 1, ask: 2 }, { r: 0.05, bid: 3, ask: 4 }], watched: 1, units: 'usd', coin: 'BTC', rank: 1, of: 2 }),
    ltCardLines({ time: 0, bid: 1, ask: 2, halfLifeBp: 10, venues: 3 }),
    oiCardLines({ time: 0, level: 1, change: 1, before: 1, rank: 1, of: 2, sigma: 2, source: 'from X', staleMin: 1 }),
  ]) {
    assert.ok(lines.every(line => line.text.length > 0));
    const laid = layoutInfo(measure, lines);
    assert.ok(laid.width <= 250 + 16 + 8, `the box is ${laid.width} px wide`);
  }
});

test('looking at the past, the open-interest line carries the last visible level to the edge instead of joining the newest value', () => {
  assert.deepEqual(oiTail(10, 9, 700, 800), { x: 700, live: true }, 'the newest sample is on screen: the line ends at its centre');
  assert.deepEqual(oiTail(10, 4, 700, 800), { x: 800, live: false }, 'the newest is further right than the view: hold the level to the edge');
});

test("right of the newest point, or over the price axis, the popup keeps showing the newest value; a gap between points still shows none", () => {
  const times = [0, 60, 120, 300];   // a gap from 180 to 300
  const read = (t: number): number => readAt(slotAt(times, 60, t), t, times.length - 1, times[times.length - 1]);
  assert.equal(read(70), 1, "under the pointer");
  assert.equal(read(200), -1, "in a gap: nothing");
  assert.equal(read(330), 3, "on the newest");
  assert.equal(read(10_000), 3, "far right of it: still the newest");
  assert.equal(readAt(-1, 5, -1, undefined), -1, "no data, nothing");
  assert.equal(readAt(2, 10_000, 3, 300), 2, "a point under the pointer wins");
});

test('the liquidation levels popup names the larger side and how many times the other it is, and says nothing where both are empty', () => {
  const bands = [{ r: 0.0125, bid: 0, ask: 3_000_000 }, { r: 0.05, bid: 25_000_000, ask: 10_000_000 }];
  const lines = liqCardLines({ asOf: 0, bands, watched: 1, units: 'usd', coin: 'BTC' });
  assert.deepEqual([by(lines, 'Ratio')!.text, by(lines, 'Ratio')!.color], ['longs 2.50×', 'below']);
  assert.equal(by(liqCardLines({ asOf: 0, bands, watched: 0, units: 'usd', coin: 'BTC' }), 'Ratio')!.text, 'shorts ∞', 'no longs in the band: only shorts');
  assert.equal(by(liqCardLines({ asOf: 0, bands: [{ r: 0.01, bid: 0, ask: 0 }], watched: 0, units: 'usd', coin: 'BTC' }), 'Ratio'), undefined);
});

test('the Depth pane reads the liquidation levels at a moment, never at a column: the newest snapshot, and the one at a pointer, are the same at any zoom (Karl, 2026-11-21)', () => {
  // Snapshots every 26 minutes for two days; now is 8 minutes after the newest was fetched.
  const SNAP = 26 * MIN, HOLD = 90 * MIN, first = 1_000 * MIN;
  const rows = Array.from({ length: 110 }, (_, i) => ({ fetchedAt: first + i * SNAP }));
  const newest = rows.length - 1, now = rows[newest]!.fetchedAt + 8 * MIN, pointer = rows[60]!.fetchedAt + 5 * MIN;
  // Columns of 2 minutes, of a snapshot's spacing and of 3 hours, the view ending anywhere in the next half hour (the map's margin).
  for (const col of [2 * MIN, SNAP, 180 * MIN]) for (let margin = 0; margin < 30 * MIN; margin += 3 * MIN) {
    const w = 600, t1 = now + margin, t0 = t1 - w * col, rowAt = liqColumnRows(rows, t0, t1, w, now, HOLD);
    let last = -1;
    for (let x = 0; x < w; x++) if (rowAt[x]! >= 0) last = x;
    const what = `columns of ${col / MIN} min, view ending ${margin / MIN} min after now`;
    assert.equal(rowAt[last], newest, `the newest column draws the newest snapshot (${what})`);
    assert.ok(t0 + last / w * (t1 - t0) <= now && now <= t0 + (last + 1) / w * (t1 - t0), `it is the column holding now (${what})`);
    for (let x = last + 1; x < w; x++) assert.equal(rowAt[x], -1, 'nothing is drawn past now');
    assert.deepEqual(liqReading(rows, null, { pointer: null, t1: t1, until: now, holdMs: HOLD }), { row: newest, take: -1, at: now }, `with no pointer the table reads the newest snapshot (${what})`);
    assert.equal(liqReading(rows, null, { pointer: pointer, t1: t1, until: now, holdMs: HOLD }).row, 60, `a pointer reads the snapshot in force at its time (${what})`);
    assert.deepEqual(liqReading(rows, null, { pointer: now + 20 * MIN, t1: t1, until: now, holdMs: HOLD }), { row: newest, take: -1, at: now }, `a pointer past now reads the newest moment (${what})`);
  }
  // Read at their middles, as before, 26-minute columns left the newest snapshot out of the drawing and the table read the one before it.
  const w = 600, t1 = now + 15 * MIN, t0 = t1 - w * SNAP, mid = (x: number): number => t0 + (x + 0.5) / w * (t1 - t0);
  let x = w - 1;
  while (mid(x) > now) x--;
  assert.ok(rows.filter(r => r.fetchedAt <= mid(x)).length - 1 < newest, 'the old reading of that view was an older snapshot');
});

test('a snapshot stands its hold and no longer: a pointer in a gap reads nothing wherever the view ends, the newest moment keeps the newest snapshot', () => {
  const HOLD = 90 * MIN, rows = [{ fetchedAt: 0 }, { fetchedAt: 30 * MIN }, { fetchedAt: 300 * MIN }, { fetchedAt: 330 * MIN }];
  const now = 600 * MIN, rowAt = liqColumnRows(rows, 0, 600 * MIN, 600, now, HOLD);
  assert.equal(rowAt[100], 1, 'held for its 90 minutes');
  assert.equal(rowAt[200], -1, 'then a gap until the next snapshot');
  assert.equal(rowAt[400], 3);
  assert.equal(rowAt[500], -1, 'the snapshots stopped: past the hold nothing is drawn');
  // The rows a view holds end at its end (the history gives every row fetched in it and the last before it): the reading of a pointer in the
  // gap must not depend on whether the view reaches the next snapshot (review 2026-11-21).
  for (const [held, t1] of [[rows.slice(0, 2), 250 * MIN], [rows, 600 * MIN]] as const) assert.equal(liqReading(held, null, { pointer: 200 * MIN, t1: t1, until: now, holdMs: HOLD }).row, -1, 'a pointer in the gap reads nothing');
  assert.equal(liqReading(rows, null, { pointer: 500 * MIN, t1: 600 * MIN, until: now, holdMs: HOLD }).row, -1, 'nor in the stretch after the snapshots stopped');
  assert.equal(liqReading(rows, null, { pointer: null, t1: 600 * MIN, until: now, holdMs: HOLD }).row, 3, 'the newest moment keeps the newest snapshot, its positions time saying how old it is');
  assert.equal(liqReading(rows, null, { pointer: now, t1: 650 * MIN, until: now, holdMs: HOLD }).row, 3, 'and so does a pointer at now or past it');
  assert.equal(liqReading(rows, null, { pointer: null, t1: 320 * MIN, until: now, holdMs: HOLD }).row, 2, 'a view ending before now reads its own end');
  assert.equal(liqReading([], null, { pointer: null, t1: 600 * MIN, until: now, holdMs: HOLD }).row, -1);
  assert.equal(liqRowAt(rows, 120 * MIN, HOLD), 1);
  assert.equal(liqRowAt(rows, 121 * MIN, HOLD), -1, 'a hold is 90 minutes to the millisecond');
});

test('take profits are read at the same moment as the levels and only while they stand: an orders file that lags prints none (review 2026-11-21)', () => {
  const HOLD = 90 * MIN, rows = Array.from({ length: 12 }, (_, i) => ({ fetchedAt: i * 26 * MIN })), now = 11 * 26 * MIN + 5 * MIN;
  const takes = [{ fetchedAt: 0 }, { fetchedAt: 52 * MIN }, { fetchedAt: 104 * MIN }];
  assert.deepEqual(liqReading(rows, takes, { pointer: null, t1: now, until: now, holdMs: HOLD }), { row: 11, take: -1, at: now }, 'the newest take profits are three hours old: not beside the levels of now');
  assert.deepEqual(liqReading(rows, takes, { pointer: 110 * MIN, t1: now, until: now, holdMs: HOLD }), { row: 4, take: 2, at: 110 * MIN }, 'where they stand they are read with the levels');
  const kept = [{ fetchedAt: 0 }, { fetchedAt: 26 * MIN }];
  assert.deepEqual(liqReading(kept, kept, { pointer: null, t1: 300 * MIN, until: 300 * MIN, holdMs: HOLD }), { row: 1, take: -1, at: 300 * MIN }, 'the levels are kept past their hold, the take profits are not');
});

test('a replay reads no snapshot after its moment; nothing closed to the visitor (Plus) is drawn or read, a view wholly closed included', () => {
  const HOLD = 90 * MIN, rows = Array.from({ length: 20 }, (_, i) => ({ fetchedAt: i * 30 * MIN }));
  const moment = 300 * MIN + 10 * MIN, rowAt = liqColumnRows(rows, 0, 600 * MIN, 120, moment, HOLD);
  let last = -1;
  for (let x = 0; x < 120; x++) if (rowAt[x]! >= 0) last = x;
  assert.equal(rowAt[last], 10, "the replay's newest column draws the snapshot in force at its moment");
  assert.equal(liqReading(rows, null, { pointer: 500 * MIN, t1: 600 * MIN, until: moment, holdMs: HOLD }).row, 10, 'a pointer later than the moment reads the moment');
  assert.equal(liqReading(rows, null, { pointer: null, t1: 600 * MIN, until: moment, holdMs: HOLD }).row, 10);
  // Closed until 200 minutes; the history still holds the rows before (a pass that lapsed): none of them is drawn or read.
  const closed = liqColumnRows(rows, 0, 600 * MIN, 120, 600 * MIN, HOLD, 200 * MIN);
  for (let x = 0; x < 41; x++) assert.equal(closed[x], -1, `column ${x}: read before the boundary, or from the row fetched at 180 minutes`);
  assert.equal(closed[41], 7, 'the column ending at 210 minutes draws the first row fetched after the boundary');
  assert.equal(liqReading(rows, null, { pointer: 100 * MIN, t1: 600 * MIN, until: 600 * MIN, holdMs: HOLD, closedTo: 200 * MIN }).row, -1, 'nor is anything read before the boundary');
  assert.equal(liqReading(rows, null, { pointer: 205 * MIN, t1: 600 * MIN, until: 600 * MIN, holdMs: HOLD, closedTo: 200 * MIN }).row, -1, 'nor a closed row standing after it');
  assert.equal(liqReading(rows, null, { pointer: 250 * MIN, t1: 600 * MIN, until: 600 * MIN, holdMs: HOLD, closedTo: 200 * MIN }).row, 8);
  // A view wholly closed: its boundary lies past the view's end, so its last column, which ends at the view's end, is closed too.
  const wholly = liqColumnRows(rows, 0, 150 * MIN, 60, 600 * MIN, HOLD, 200 * MIN);
  assert.ok(wholly.every(i => i === -1), 'nothing of a wholly closed view is drawn');
  assert.equal(liqReading(rows, null, { pointer: null, t1: 150 * MIN, until: 600 * MIN, holdMs: HOLD, closedTo: 200 * MIN }).row, -1, 'nor read');
});

test('the books now are read while they are fresh and the view reaches the live edge; the table also when pointing at the column holding now or past the newest', () => {
  const now = 1_000 * MIN, base = { liveAt: now - 5_000, until: now, t1: now + 20 * MIN, replay: false, pointer: null, nowColumnStart: now - 30 * MIN, pastNewest: false };
  assert.deepEqual(readsBooksNow(base), { header: true, table: true });
  assert.deepEqual(readsBooksNow({ ...base, liveAt: now - 3 * MIN }), { header: false, table: false }, 'a stream that stopped leaves the worker its last books: not read past two minutes');
  assert.deepEqual(readsBooksNow({ ...base, liveAt: null }), { header: false, table: false }, 'no live books');
  assert.deepEqual(readsBooksNow({ ...base, t1: now - 3 * MIN }), { header: false, table: false }, 'a view that ends before now reads its own newest column');
  assert.deepEqual(readsBooksNow({ ...base, replay: true }), { header: false, table: false }, 'a replay reads its own moment');
  assert.deepEqual(readsBooksNow({ ...base, pointer: now - 10 * MIN }), { header: true, table: true }, 'pointing inside the column that holds now');
  assert.deepEqual(readsBooksNow({ ...base, pointer: now - 40 * MIN }), { header: true, table: false }, 'pointing at an earlier column reads that column');
  assert.deepEqual(readsBooksNow({ ...base, pointer: now - 40 * MIN, pastNewest: true }), { header: true, table: true }, 'past the newest column with data, the newest');
});
