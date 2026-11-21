import test from 'node:test';
import assert from 'node:assert/strict';
import { barAt, columnAt, depthCardLines, liqCardLines, liqColumnRows, liqReadRow, ltCardLines, oiCardLines, oiTail, readAt, slotAt } from '../src/app/panes/pane-cards.ts';
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
    assert.equal(liqReadRow(rows, Math.min(now, t1), Math.min(now, t1), HOLD), newest, `with no pointer the table reads the newest snapshot (${what})`);
    assert.equal(liqReadRow(rows, pointer, now, HOLD), 60, `a pointer reads the snapshot in force at its time (${what})`);
    assert.equal(liqReadRow(rows, now + 20 * MIN, now, HOLD), newest, `a pointer past now reads the newest (${what})`);
  }
  // Read at their middles, as before, 26-minute columns left the newest snapshot out of the drawing and the table read the one before it.
  const w = 600, t1 = now + 15 * MIN, t0 = t1 - w * SNAP, mid = (x: number): number => t0 + (x + 0.5) / w * (t1 - t0);
  let x = w - 1;
  while (mid(x) > now) x--;
  assert.ok(rows.filter(r => r.fetchedAt <= mid(x)).length - 1 < newest, 'the old reading of that view was an older snapshot');
});

test('a snapshot stands its hold and no longer in the drawing; a reading past the newest keeps it, a gap between two reads nothing', () => {
  const HOLD = 90 * MIN, rows = [{ fetchedAt: 0 }, { fetchedAt: 30 * MIN }, { fetchedAt: 300 * MIN }, { fetchedAt: 330 * MIN }];
  const now = 600 * MIN, rowAt = liqColumnRows(rows, 0, 600 * MIN, 600, now, HOLD);
  assert.equal(rowAt[100], 1, 'held for its 90 minutes');
  assert.equal(rowAt[200], -1, 'then a gap until the next snapshot');
  assert.equal(rowAt[400], 3);
  assert.equal(rowAt[500], -1, 'the snapshots stopped: past the hold nothing is drawn');
  assert.equal(liqReadRow(rows, 200 * MIN, now, HOLD), -1, 'a pointer in the gap reads nothing');
  assert.equal(liqReadRow(rows, 500 * MIN, now, HOLD), 3, 'at or past the newest snapshot, the reading keeps it (its positions time says how old it is)');
  assert.equal(liqReadRow(rows, now, now, HOLD), 3, 'and so does the newest moment');
  assert.equal(liqReadRow([], now, now, HOLD), -1);
});

test('a replay reads no snapshot after its moment, and nothing is read before a stretch closed to the visitor (Plus)', () => {
  const HOLD = 90 * MIN, rows = Array.from({ length: 20 }, (_, i) => ({ fetchedAt: i * 30 * MIN }));
  const moment = 300 * MIN + 10 * MIN, rowAt = liqColumnRows(rows, 0, 600 * MIN, 120, moment, HOLD);
  let last = -1;
  for (let x = 0; x < 120; x++) if (rowAt[x]! >= 0) last = x;
  assert.equal(rowAt[last], 10, "the replay's newest column draws the snapshot in force at its moment");
  assert.equal(liqReadRow(rows, 500 * MIN, moment, HOLD), 10, 'a pointer later than the moment reads the moment');
  assert.equal(liqReadRow(rows, moment, moment, HOLD), 10);
  const closed = liqColumnRows(rows, 0, 600 * MIN, 120, 600 * MIN, HOLD, 200 * MIN);
  for (let x = 0; x < 120; x++) if ((x + 1) * 5 * MIN < 200 * MIN) assert.equal(closed[x], -1, 'a column read before the closed stretch ends draws nothing');
  assert.equal(liqReadRow(rows, 100 * MIN, 600 * MIN, HOLD, 200 * MIN), -1, 'nor is anything read there');
  assert.equal(liqReadRow(rows, 250 * MIN, 600 * MIN, HOLD, 200 * MIN), 8);
});
