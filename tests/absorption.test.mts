import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { AbsorptionRecorder, markedPart, mergeMoments, parseAbsorptionAnswer, parseAbsorptionLive, parseGroup, parseMinute, peakOf, type AbsorptionAnswer, type AbsorptionGroup, type AbsorptionMinute, type AbsorptionStep } from '../src/shared/absorption.ts';
import { AbsorptionRecorder as SqliteAbsorptionRecorder } from '../src/server/v2/absorption.mts';
import { ABSORPTION_DEFAULTS, AbsorptionBook, MARK_MAX_PX, MARK_MIN_PX, NEAR_PX, iconsOf, markLines, markSize, passiveText, readAbsorption, type AbsorptionMark, type MarkIcon } from '../src/app/absorption.ts';
import { BookConnector, type TradeEvent } from '../src/shared/connector.ts';
import { Engine } from '../src/shared/engine.ts';
import type { BrowserVenue } from '../src/shared/venues.ts';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { Hub } from '../src/app/hub.ts';
import { Store, initialState } from '../src/app/store.ts';

const MIN = 60_000, T0 = 1_800_000_000_000, W = 10;
type Side = 'buy' | 'sell';
interface Fill { id: string; t: number; price: number; usd: number; side: Side }
interface Credited { at: number; usd: number; credit: number }

/**
 * The rule worked out the slow way, from its definition: each instrument's fills taken in time order (ties in the order they came), at
 * their own times; each fill's window is every earlier-or-same fill of its side and price no older than the window, and every fill in it
 * is credited the larger of what it had and that sum; runs are fills of one side and price with gaps no longer than the window; and the
 * window sums for the threshold open at a fill and take the fills up to that time plus the window.
 */
function reference(fills: readonly Fill[]): { groups: Map<string, Credited[]>; minutes: Map<string, number[]> } {
  const byInstrument = new Map<string, Fill[]>(), byKey = new Map<string, Credited[]>();
  for (const f of fills) { let list = byInstrument.get(f.id); if (!list) { list = []; byInstrument.set(f.id, list); } list.push(f); }
  for (const list of byInstrument.values()) for (const f of [...list].sort((a, b) => a.t - b.t)) {   // a stable sort: ties keep their order
    const key = `${f.id}|${f.side}|${f.price}`;
    let keyed = byKey.get(key); if (!keyed) { keyed = []; byKey.set(key, keyed); }
    keyed.push({ at: f.t, usd: f.usd, credit: 0 });
  }
  const groups = new Map<string, Credited[]>(), minutes = new Map<string, number[]>();
  for (const [key, list] of byKey) {
    for (let j = 0; j < list.length; j++) {
      const window = list.slice(0, j + 1).filter(x => x.at >= list[j]!.at - W), sum = window.reduce((a, x) => a + x.usd, 0);
      for (const x of window) x.credit = Math.max(x.credit, sum);
    }
    let run: Credited[] = [];
    for (const x of list) { if (run.length && x.at - run[run.length - 1]!.at > W) { groups.set(`${key}|${run[0]!.at}`, run); run = []; } run.push(x); }
    if (run.length) groups.set(`${key}|${run[0]!.at}`, run);
    const id = key.split('|')[0]!;
    let start = -Infinity, sum = 0;
    const close = (): void => { if (sum > 0) { const m = `${id}|${Math.floor(start / MIN) * MIN}`; let sums = minutes.get(m); if (!sums) { sums = []; minutes.set(m, sums); } sums.push(sum); } };
    for (const x of list) { if (x.at <= start + W) sum += x.usd; else { close(); start = x.at; sum = x.usd; } }
    close();
  }
  return { groups, minutes };
}

/** A seeded stream of fills in bursts on two instruments, three prices and both sides, a few delivered up to 200 ms out of order. */
function stream(seed: number, count: number): Fill[] {
  let s = seed >>> 0;
  const rnd = (): number => (s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32;
  const pick = (): { id: string; side: Side; price: number } => ({ id: rnd() < 0.7 ? 'a:BTC' : 'b:BTC', side: rnd() < 0.5 ? 'buy' : 'sell', price: 100 + Math.floor(rnd() * 3) });
  const out: Fill[] = [];
  let t = T0 + 1_000, key = pick();
  while (out.length < count) {
    t += rnd() < 0.4 ? Math.floor(rnd() * 3) : Math.floor(rnd() * 40);
    if (rnd() < 0.003) t += 30_000;
    if (rnd() > 0.6) key = pick();
    const late = rnd() < 0.05 ? Math.floor(rnd() * 200) : 0;
    out.push({ ...key, t: t - late, usd: Math.round(1_000 + rnd() * 30_000) });
  }
  return out;
}

const groupKey = (g: AbsorptionGroup): string => `${g.id}|${g.side}|${g.price}|${g.t0}`;

test('the detector marks exactly what the rule marks, at any threshold, and counts the window sums of every minute', () => {
  for (const seed of [1, 7, 42]) {
    const fills = stream(seed, 4_000);
    let now = 0;
    const recorder = new AbsorptionRecorder(null, () => now, { perMinute: 1e9 });
    const groups: AbsorptionGroup[] = [], minutes: AbsorptionMinute[] = [];
    const take = (): void => { const fresh = recorder.takeFresh(); groups.push(...fresh.groups); minutes.push(...fresh.minutes); };
    fills.forEach((f, i) => { now = f.t + 50; recorder.add(f.id, f.t, f.price, f.usd, f.side); if (i % 50 === 49) { recorder.step(); take(); } });
    now += 10 * MIN; recorder.step(); take();

    const { groups: expected, minutes: sums } = reference(fills);
    const kept = [...expected].filter(([, run]) => Math.max(...run.map(x => x.credit)) >= 25_000);
    assert.deepEqual(groups.map(groupKey).sort(), kept.map(([key]) => key).sort(), `seed ${seed}: the same groups`);
    assert.ok(kept.length > 20, `seed ${seed}: the stream has groups to compare (${kept.length})`);
    for (const g of groups) {
      const run = expected.get(groupKey(g))!;
      assert.equal(peakOf(g), Math.max(...run.map(x => x.credit)));
      for (const threshold of [25_000, 40_000, 60_000, 90_000, 150_000]) {
        const marked = run.filter(x => x.credit >= threshold);
        const want = marked.length ? { usd: marked.reduce((a, x) => a + x.usd, 0), fills: marked.length, t0: Math.min(...marked.map(x => x.at)), t1: Math.max(...marked.map(x => x.at)), peak: peakOf(g) } : null;
        assert.deepEqual(markedPart(g, threshold), want, `seed ${seed}, ${groupKey(g)} at ${threshold}`);
      }
    }
    assert.deepEqual(minutes.map(m => `${m.id}|${m.t}`).sort(), [...sums.keys()].sort(), `seed ${seed}: every minute settled once`);
    for (const m of minutes) {
      const list = sums.get(`${m.id}|${m.t}`)!, mean = list.reduce((a, x) => a + x, 0) / list.length;
      assert.equal(m.n, list.length);
      assert.ok(Math.abs(m.mean - mean) <= 1e-9 * mean, 'mean');
      const m2 = list.reduce((a, x) => a + (x - mean) ** 2, 0);
      assert.ok(Math.abs(m.m2 - m2) <= 1e-9 * Math.max(1, m2), 'squared deviations');
      assert.equal(m.floor, 25_000, 'nothing was left out');
    }
  }
});

test('each minute keeps its largest groups, and the floor says under which credit some may be missing', async () => {
  let now = T0;
  const recorder = new AbsorptionRecorder(null, () => now, { perMinute: 3 });
  [30, 70, 40, 60, 50].forEach((k, i) => { now = T0 + i * 1_000 + 50; recorder.add('a:BTC', T0 + i * 1_000, 100 + i, k * 1_000, 'buy'); });
  now = T0 + 5 * MIN; recorder.step();
  const answer = await recorder.query(['a:BTC'], [25_000], T0, T0 + MIN, 100, T0);
  assert.deepEqual(answer.groups.map(peakOf), [70_000, 60_000, 50_000], 'the three largest, the largest first');
  assert.deepEqual(answer.floors, { 'a:BTC': 40_000 }, 'the larger of the two left out');
});

test('fills are taken in time order at their own times, one inside a settled minute is left out, and a computer clock ahead of the exchange settles nothing early', () => {
  let now = 0;
  const recorder = new AbsorptionRecorder(null, () => now, { perMinute: 100 });
  now = T0 + 10_050; recorder.add('a:BTC', T0 + 10_000, 100, 20_000, 'buy');
  now = T0 + 10_051; recorder.add('a:BTC', T0 + 9_995, 100, 20_000, 'buy');
  // This computer's clock is ten seconds ahead of the exchange's. A quiet pause two seconds before the exchange's minute ends settles nothing.
  now = T0 + 68_000; recorder.add('a:BTC', T0 + 58_000, 101, 1_000, 'sell');
  now += 600; recorder.step();
  now += 400; recorder.add('a:BTC', T0 + 59_000, 102, 1_000, 'sell');
  let fresh = recorder.takeFresh();
  assert.deepEqual(fresh.groups.map(g => [g.price, g.t0, g.steps]), [[100, T0 + 9_995, [[40_000, 40_000, 2, T0 + 9_995, T0 + 10_000]]]], 'the fill delivered second is taken first, at its own time, 5 ms before the other: one window');
  assert.deepEqual(fresh.minutes, [], 'the exchange is still in its minute');
  now += 70_000; recorder.step();
  fresh = recorder.takeFresh();
  assert.deepEqual(fresh.minutes.map(m => [m.t, m.n]), [[T0, 3]], 'one window at 100 and one each at 101 and 102, in one row');
  now += 50; recorder.add('a:BTC', T0 + 59_500, 103, 1_000, 'buy');
  now += 70_000; recorder.step();
  fresh = recorder.takeFresh();
  assert.deepEqual(fresh.minutes, [], 'a fill stamped inside the settled minute is left out: the row is never written twice');
  assert.equal(recorder.lateFills('a:BTC'), 1);
});

test('recent trades a venue sends again when its feed connects, newest first, are not summed as if they met in one window', () => {
  let now = T0 + 20_000;
  const recorder = new AbsorptionRecorder(null, () => now);
  // Ten trades of $20,000 at one price, a second apart, delivered at once and newest first: moved forward, they would be one $200,000 window.
  for (let i = 0; i < 10; i++) recorder.add('a:BTC', T0 + 10_000 - i * 1_000, 100, 20_000, 'sell');
  assert.equal(recorder.lateFills('a:BTC'), 8, 'the two newest are taken in order, each alone; the rest are earlier than what was taken');
  // Live trading after it counts as ever.
  now += 100; recorder.add('a:BTC', T0 + 10_050, 100, 15_000, 'sell'); recorder.add('a:BTC', T0 + 10_055, 100, 15_000, 'sell');
  now += 10 * MIN; recorder.step();
  assert.deepEqual(recorder.takeFresh().groups.map(g => [g.t0, peakOf(g)]), [[T0 + 10_050, 30_000]], 'only the live pair, not the replay');
});

test('two fills 20 ms apart, delivered newest first, are two windows, not one of their sum', () => {
  let now = T0 + 1_050;
  const recorder = new AbsorptionRecorder(null, () => now);
  recorder.add('a:BTC', T0 + 1_020, 100, 15_000, 'buy'); recorder.add('a:BTC', T0 + 1_000, 100, 15_000, 'buy');
  now += 10 * MIN; recorder.step();
  assert.deepEqual(recorder.takeFresh().groups, [], 'each window holds $15,000, under the floor: moved together they would have made $30,000');
  assert.equal(recorder.lateFills('a:BTC'), 0, 'neither is left out: both are taken, in their order');
});

test('a restart knows where settling had got to: a fill sent again for a saved burst starts no second group', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorption-')), db = path.join(dir, 'depth.sqlite');
  let now = T0 + 50;
  const first = new SqliteAbsorptionRecorder(db, () => now);
  first.add('x:BTC', T0, 100, 30_000, 'buy'); first.add('x:BTC', T0 + 5, 100, 30_000, 'buy');
  now = T0 + 5 * MIN; first.close();
  const second = new SqliteAbsorptionRecorder(db, () => now);
  try {
    second.add('x:BTC', T0 + 5, 100, 30_000, 'buy');   // the venue sends the burst's second fill again
    now += 10 * MIN; second.step(); second.flush();
    assert.equal(second.lateFills('x:BTC'), 1);
    const answer = await second.query(['x:BTC'], [25_000], T0 - MIN, T0 + MIN, 10, T0 - MIN);
    assert.deepEqual(answer.groups.map(g => [g.t0, peakOf(g)]), [[T0, 60_000]], 'the saved $60,000 group alone, no $30,000 one beside it');
  } finally { second.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('closing saves the minute still open: a mark found in it is there after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorption-')), db = path.join(dir, 'depth.sqlite');
  let now = T0 + 30_050;
  const first = new SqliteAbsorptionRecorder(db, () => now);
  first.add('x:BTC', T0 + 30_000, 100, 50_000, 'sell');
  now = T0 + 31_000; first.close();   // half a minute in: the minute is not over
  const second = new SqliteAbsorptionRecorder(db, () => now);
  try {
    const answer = await second.query(['x:BTC'], [25_000], T0, T0 + MIN, 10, T0);
    assert.deepEqual(answer.groups.map(g => [g.t0, peakOf(g)]), [[T0 + 30_000, 50_000]]);
    assert.deepEqual(answer.minutes.map(m => [m.t, m.n]), [[T0, 1]], 'the minute as far as it had got');
    second.add('x:BTC', T0 + 40_000, 101, 50_000, 'sell');
    assert.equal(second.lateFills('x:BTC'), 1, 'later in that minute, after the restart: the minute was written, so this is left out');
  } finally { second.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('trades sent again after a restart add nothing: the first row of a minute stands and a group is kept once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorption-')), db = path.join(dir, 'depth.sqlite');
  const fills: [number, number, number][] = [[T0, 100, 30_000], [T0 + 2, 100, 20_000], [T0 + 5_000, 101, 40_000]];
  let now = T0;
  const first = new SqliteAbsorptionRecorder(db, () => now);
  for (const [t, price, usd] of fills) { now = t + 50; first.add('x:BTC', t, price, usd, 'buy'); }
  now = T0 + 5 * MIN; first.close();
  // A restart a little later (memory holds the last two hours), and the venue sends the last two trades again.
  const second = new SqliteAbsorptionRecorder(db, () => now);
  try {
    for (const [t, price, usd] of fills.slice(1)) second.add('x:BTC', t, price, usd, 'buy');
    now += 10 * MIN; second.step();
    assert.deepEqual(second.takeFresh().minutes, [], 'the minute is held: the part sent again does not replace it');
    second.flush();
    const answer = await second.query(['x:BTC'], [25_000], T0 - MIN, T0 + MIN, 10, T0 - MIN);
    assert.deepEqual(answer.groups.map(peakOf), [50_000, 40_000], 'each group once');
    assert.deepEqual(answer.minutes.map(m => [m.t, m.n, m.mean]), [[T0, 2, 45_000]], 'the minute as first recorded (windows of $50,000 and $40,000)');
  } finally { second.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/** The groups a page book holds, as `id|side|price|t0` (every group is a mark at a threshold of 1). */
const heldBy = (book: AbsorptionBook, ids: readonly string[]): string[] =>
  book.marks(ids, new Map(ids.map(id => [id, 1])), 0, Number.MAX_SAFE_INTEGER, 0, 1e9).map(m => `${m.id}|${m.side}|${m.price}|${m.t0}`).sort();

test('a page book keeps what the recorder keeps: of a busy minute the largest, whatever order they were found and sent in', async () => {
  // Twelve groups of one instrument in one minute, found in this order (USD thousands). The stream sends each when it is found; the recorder
  // then lets the two smallest go (30 and 35, sent while they were still among the largest ten). Another instrument in that minute and the
  // same instrument in the next minute are not touched.
  let now = T0; const recorder = new AbsorptionRecorder(null, () => now);
  [60, 30, 90, 40, 120, 50, 80, 35, 110, 70, 100, 45].forEach((k, i) => { now = T0 + i * 1_000 + 300; recorder.add('a:BTC', T0 + i * 1_000, 100 + i, k * 1_000, 'buy'); });
  now = T0 + 20_300; recorder.add('b:BTC', T0 + 20_000, 200, 30_000, 'sell');
  now = T0 + MIN + 1_300; recorder.add('a:BTC', T0 + MIN + 1_000, 300, 26_000, 'sell');
  now = T0 + 3 * MIN; recorder.step(true);
  const sent = recorder.takeFresh().groups;
  assert.equal(sent.length, 14, 'every group was sent while it was among the largest ten');
  const kept = (await recorder.query(['a:BTC', 'b:BTC'], [25_000, 25_000], T0 - MIN, T0 + 3 * MIN, 100, T0)).groups.map(groupKey).sort();
  assert.equal(kept.length, 12, 'the recorder keeps ten of the busy minute');
  // Taken a few at a time as the stream brings them, or all at once in another order: the page holds exactly what the recorder keeps.
  const live = new AbsorptionBook();
  for (let i = 0; i < sent.length; i += 3) live.add(sent.slice(i, i + 3));
  assert.deepEqual(heldBy(live, ['a:BTC', 'b:BTC']), kept);
  const reversed = new AbsorptionBook(); reversed.add([...sent].reverse());
  assert.deepEqual(heldBy(reversed, ['a:BTC', 'b:BTC']), kept, 'in any order');
  // Equal peaks at the tenth place: ten of $30K, then one of $60K. A page that took two of the ten live before the history answer (which
  // brings all ten), then the large one live, keeps the nine the recorder keeps: both settle a tie by one order, not by arrival.
  now = T0 + 10 * MIN; const tied = new AbsorptionRecorder(null, () => now);
  for (let i = 0; i < 10; i++) { now = T0 + 10 * MIN + i * 1_000 + 300; tied.add('a:BTC', T0 + 10 * MIN + i * 1_000, 100 + i, 30_000, 'buy'); }
  now = T0 + 10 * MIN + 10_300; tied.add('a:BTC', T0 + 10 * MIN + 10_000, 200, 60_000, 'buy');
  now = T0 + 13 * MIN; tied.step(true);
  const tiedSent = tied.takeFresh().groups, at = (price: number): AbsorptionGroup => tiedSent.find(g => g.price === price)!;
  const tiedKept = (await tied.query(['a:BTC'], [25_000], T0, T0 + 20 * MIN, 100, T0)).groups.map(groupKey).sort();
  assert.deepEqual([tiedSent.length, tiedKept.length], [11, 10]);
  const page = new AbsorptionBook();
  page.add([at(108), at(109)]); page.add(tiedSent.filter(g => g.price < 200)); page.add([at(200)]);
  assert.deepEqual(heldBy(page, ['a:BTC']), tiedKept, 'a tie at the tenth place is settled as the recorder settles it');
});

test('a full page book lets go first of what the last answer does not claim, then of what the view no longer reaches, and says when it cut the view', () => {
  const g = (id: string, minute: number, peak: number, price: number): AbsorptionGroup => ({ id, side: 'buy', price, t0: T0 + minute * MIN, steps: [[peak, peak, 1, T0 + minute * MIN, T0 + minute * MIN]] });
  const count = (book: AbsorptionBook, id: string): number => heldBy(book, [id]).length;
  const book = new AbsorptionBook(20), ids = ['a:BTC', 'b:BTC', 'c:BTC'];
  // The answer claims a:BTC from $100K and b:BTC from $50K over minutes 10 to 40.
  const claimed = Array.from({ length: 10 }, (_, i) => g('a:BTC', 10 + i, 200_000 + i * 1_000, 100));
  book.load({ groups: claimed, floors: {}, minutes: [], capped: [] }, { from: T0 + 10 * MIN, to: T0 + 40 * MIN, mins: new Map([['a:BTC', 100_000], ['b:BTC', 50_000]]) });
  // The stream brings what it does not claim: from before the window, from after it, of an instrument not asked about, under what was asked.
  book.add([g('a:BTC', 2, 900_000, 100), g('a:BTC', 45, 900_000, 100), g('c:BTC', 15, 900_000, 100), ...Array.from({ length: 8 }, (_, i) => g('a:BTC', 12 + i, 60_000, 200))]);
  // 21 held, room for 20: down to 18, the three oldest of those it does not claim, the largest of all among them.
  assert.equal(book.size, 18);
  const held = heldBy(book, ids);
  assert.ok(!held.includes(`a:BTC|buy|100|${T0 + 2 * MIN}`) && !held.includes(`a:BTC|buy|200|${T0 + 12 * MIN}`) && !held.includes(`a:BTC|buy|200|${T0 + 13 * MIN}`), 'the oldest unclaimed went, however large');
  assert.ok(claimed.every(c => held.includes(groupKey(c))), 'nothing the answer claims');
  assert.equal(book.cut.size, 0);
  // The view moves on to minute 25 and more claimed groups come: everything unclaimed goes, then the claimed the view no longer reaches,
  // the oldest first, and the cover then starts after them (so a view moving back asks again).
  book.needFrom(T0 + 25 * MIN);
  book.add([...Array.from({ length: 10 }, (_, i) => g('a:BTC', 25 + i, 300_000 + i * 1_000, 300)), ...Array.from({ length: 5 }, (_, i) => g('b:BTC', 25 + i, 60_000, 400))]);
  assert.equal(book.size, 18);
  assert.deepEqual([count(book, 'c:BTC'), heldBy(book, ['a:BTC']).filter(k => k.includes('|200|')).length], [0, 0], 'nothing unclaimed is left');
  assert.equal(book.cover!.from, T0 + 16 * MIN + 1, 'minutes 10 to 16 went, the oldest first');
  assert.equal(book.cut.size, 0, 'nothing the view needs went');
  // A burst inside the view, past the room even after the old claimed groups: the smallest the view needs go, and the book says so.
  book.add([...Array.from({ length: 5 }, (_, i) => g('a:BTC', 35 + i, 150_000 + i * 1_000, 500)), ...Array.from({ length: 5 }, (_, i) => g('b:BTC', 30 + i, 55_000 + i * 1_000, 600))]);
  assert.equal(book.size, 18);
  assert.equal(count(book, 'a:BTC'), 15, 'every a:BTC group of the view is held');
  assert.deepEqual([...book.cut], [['b:BTC', 60_000]], 'b:BTC lost groups up to $60K: marks there at a threshold up to that may be missing');
  // The next answer starts again from what it says: nothing cut, or what it cut at its limit (the smallest peak it kept).
  const cover = { from: T0 + 20 * MIN, to: Infinity, mins: new Map([['a:BTC', 100_000]]) };
  book.load({ groups: [], floors: {}, minutes: [], capped: [] }, cover);
  assert.equal(book.cut.size, 0);
  book.load({ groups: [g('a:BTC', 50, 700_000, 700), g('a:BTC', 51, 400_000, 700)], floors: {}, minutes: [], capped: ['a:BTC'] }, cover);
  assert.deepEqual([...book.cut], [['a:BTC', 400_000]]);
});

test('the server store keeps groups and minutes across a restart and answers each instrument from its own threshold, the largest first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorption-')), db = path.join(dir, 'depth.sqlite');
  let now = T0;
  const first = new SqliteAbsorptionRecorder(db, () => now);
  [30, 50, 70, 40, 60].forEach((k, i) => { now = T0 + i * 1_000 + 50; first.add('x:BTC', T0 + i * 1_000, 100 + i, k * 1_000, 'buy'); });
  first.add('y:BTC', T0 + 500, 200, 45_000, 'sell');
  now = T0 + 5 * MIN; first.close();
  // Three hours on, the recorder's memory holds the last two: the store answers.
  now = T0 + 3 * 3_600_000;
  const again = new SqliteAbsorptionRecorder(db, () => now);
  try {
    const all = await again.query(['x:BTC', 'y:BTC'], [25_000, 25_000], T0 - MIN, T0 + MIN, 10, T0 - MIN);
    assert.deepEqual(all.groups.map(g => [g.id, peakOf(g)]), [['x:BTC', 70_000], ['x:BTC', 60_000], ['x:BTC', 50_000], ['x:BTC', 40_000], ['x:BTC', 30_000], ['y:BTC', 45_000]]);
    assert.deepEqual(all.groups[0], { id: 'x:BTC', side: 'buy', price: 102, t0: T0 + 2_000, steps: [[70_000, 70_000, 1, T0 + 2_000, T0 + 2_000]] });
    assert.deepEqual(all.minutes.map(m => [m.id, m.t, m.n]).sort(), [['x:BTC', T0, 5], ['y:BTC', T0, 1]]);
    assert.deepEqual(all.floors, { 'x:BTC': 25_000, 'y:BTC': 25_000 });
    assert.deepEqual(all.capped, []);
    const own = await again.query(['x:BTC', 'y:BTC'], [55_000, 50_000], T0 - MIN, T0 + MIN, 10, T0);
    assert.deepEqual(own.groups.map(g => [g.id, peakOf(g)]), [['x:BTC', 70_000], ['x:BTC', 60_000]], 'each from its own amount');
    assert.deepEqual((await again.query(['x:BTC'], [25_000], T0 - MIN, T0 + MIN, 5, T0)).capped, [], 'exactly the limit is not cut');
    const cut = await again.query(['x:BTC'], [25_000], T0 - MIN, T0 + MIN, 4, T0);
    assert.deepEqual(cut.capped, ['x:BTC']); assert.deepEqual(cut.groups.map(peakOf), [70_000, 60_000, 50_000, 40_000], 'the smallest is the one left out');
  } finally { again.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/api/v2/absorption answers per instrument from its own threshold and refuses what it cannot answer', async () => {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 50, heartbeatMs: 500 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, t = Date.now() - 5_000;
    v2.absorption.add('x:BTC', t, 100, 40_000, 'buy');
    v2.absorption.add('x:BTC', t + 100, 101, 90_000, 'sell');
    v2.absorption.add('y:BTC', t, 100, 60_000, 'sell');
    const get = async (query: string) => { const r = await fetch(`${base}/api/v2/absorption?${query}`); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
    const from = Math.floor(t / MIN) * MIN - MIN, to = from + 3 * MIN, ask = `inst=x:BTC,y:BTC&from=${from}&to=${to}&min=50000,25000`;
    // The server's own pass closes the groups once the instruments have been quiet for a moment.
    let reply = await get(ask);
    for (let i = 0; i < 60 && (reply.body.groups as unknown[]).length < 2; i++) { await new Promise(resolve => setTimeout(resolve, 50)); reply = await get(ask); }
    assert.equal(reply.status, 200);
    assert.equal(reply.body.windowMs, 10); assert.equal(reply.body.floorUsd, 25_000);
    const answer = parseAbsorptionAnswer(reply.body, ['x:BTC', 'y:BTC']);
    assert.ok(answer, 'the shape the page checks for');
    assert.deepEqual(answer!.groups.map(g => [g.id, g.side, peakOf(g)]), [['x:BTC', 'sell', 90_000], ['y:BTC', 'sell', 60_000]], 'x from 50k: its 40k group is not asked for');
    const many = Array.from({ length: 201 }, (_, i) => `i${i}:BTC`).join(',');   // more than one question may name
    for (const query of ['', `inst=${many}`, `inst=x:BTC,y:BTC&min=1,2,3`, `inst=x:BTC&min=-1`, `inst=x:BTC&min=abc`, `inst=x:BTC&limit=0`, `inst=x:BTC&limit=20001`, `inst=x:BTC&limit=1.5`,
      `inst=x:BTC&since=${Date.now() - 26 * 3_600_000}`, `inst=x:BTC&from=${to}&to=${from}`, `inst=x:BTC&from=${to - 9 * 24 * 3_600_000}&to=${to}`]) {
      assert.equal((await get(query)).status, 400, query);
    }
  } finally {
    v2.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
});

/** A connector with no socket: the test says what it trades. */
class Fake extends BookConnector {
  readonly name: string; readonly symbol = 'BTCUSDT'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  constructor(readonly id: string) { super(); this.name = id; }
  override start(): void { this.state = 'connecting'; }
  override stop(): void { this.state = 'stopped'; }
  protected url() { return 'ws://127.0.0.1:1'; }
  protected open() {}
  onMessage() {}
  trade(t: Partial<TradeEvent> & { tradeId: string }) { const price = t.price ?? 100, amount = t.amount ?? 1; this.onTrade({ instrumentId: this.instrumentId, side: 'buy', price, amount, notionalUsd: price * amount, t: Date.now(), ...t }); }
}

test('in the browser, every new fill reaches the detector once and what it finds goes to the page', async () => {
  let now = T0 + 5_000;
  const fakes = new Map<string, Fake>();
  const venues: BrowserVenue[] = [{ id: 'binance', name: 'binance', kind: 'perp', recommended: true, listed: true, probe: { url: 'https://binance.example/ping' }, make: () => { const book = new Fake('binance'); fakes.set('binance', book); return { book, feeds: [] }; } }];
  const engine = new Engine({ venues, now: () => now, ping: async () => true, get: async () => { throw new Error('offline'); } });
  const found: AbsorptionGroup[] = [];
  engine.onAbsorption = fresh => found.push(...fresh.groups);
  engine.select(['binance']);
  const venue = fakes.get('binance')!;
  for (let i = 0; i < 3; i++) venue.trade({ tradeId: `t${i}`, side: 'sell', price: 100, amount: 100, t: T0 + i });
  venue.trade({ tradeId: 't1', side: 'sell', price: 100, amount: 100, t: T0 + 1 });   // replayed after a reconnect: not counted again
  now += 1_000; engine.step(now);
  assert.deepEqual(found.map(g => [g.id, g.side, g.price, g.steps]), [['binance:BTCUSDT', 'sell', 100, [[30_000, 30_000, 3, T0, T0 + 2]]]]);
  const answer = await engine.absorptionHistory(['binance:BTCUSDT'], [25_000], T0 - MIN, T0 + MIN, 10, T0 - MIN);
  assert.equal(answer.groups.length, 1, 'and the history answers it too');
  engine.stop();
});

const minuteOf = (id: string, t: number, sums: number[]): AbsorptionMinute => {
  let acc = { n: 0, mean: 0, m2: 0 };
  for (const s of sums) acc = mergeMoments(acc, { n: 1, mean: s, m2: 0 });
  return { id, t, ...acc, floor: 25_000 };
};

test('the page judges each instrument at its own threshold: the automatic one from the complete minutes of the span, the fixed one the same for all', () => {
  const T = Math.floor(Date.now() / MIN) * MIN, now = T + 30_000, book = new AbsorptionBook();
  book.addMinutes([minuteOf('a:BTC', T - 2 * MIN, [10, 20, 30]), minuteOf('a:BTC', T - MIN, [40]), minuteOf('a:BTC', T, [1e9]), minuteOf('a:BTC', T - 3 * MIN, [1e9])]);
  const auto = { ...ABSORPTION_DEFAULTS, k: 2, sdMinutes: 2 };
  const thresholds = book.thresholds(['a:BTC', 'b:BTC'], auto, now);
  assert.ok(Math.abs(thresholds.get('a:BTC')! - (25 + 2 * Math.sqrt(125))) < 1e-9, 'mean 25 and standard deviation √125 of 10, 20, 30 and 40: the open minute and the one before the span are left out');
  assert.equal(thresholds.get('b:BTC'), null, 'no minutes, no threshold');
  assert.deepEqual([...book.thresholds(['a:BTC', 'b:BTC'], { ...auto, mode: 'fixed', fixedUsd: 300_000 }, now)], [['a:BTC', 300_000], ['b:BTC', 300_000]]);

  const group = (id: string, side: Side, price: number, t0: number, steps: AbsorptionStep[]): AbsorptionGroup => ({ id, side, price, t0, steps });
  book.add([
    group('a:BTC', 'sell', 100, T, [[90, 90, 3, T, T + 4], [50, 120, 5, T, T + 8]]),
    group('a:BTC', 'buy', 105, T + 1_000, [[40, 40, 1, T + 1_000, T + 1_000]]),
    group('a:BTC', 'buy', 300, T, [[500, 500, 1, T, T]]),
    group('a:BTC', 'buy', 100, T - 2 * MIN, [[500, 500, 1, T - 2 * MIN, T - 2 * MIN]]),
    group('b:BTC', 'sell', 100, T, [[1e6, 1e6, 1, T, T]]),
  ]);
  const at = (threshold: number): AbsorptionMark[] => book.marks(['a:BTC', 'b:BTC'], new Map([['a:BTC', threshold], ['b:BTC', null]]), T - MIN, T + MIN, 90, 110);
  assert.deepEqual(at(45), [{ id: 'a:BTC', side: 'sell', price: 100, t0: T, t1: T + 8, usd: 120, fills: 5, peak: 90, threshold: 45 }], 'outside the window or the prices, under the threshold, or without one: not marked');
  assert.deepEqual(at(60).map(m => [m.usd, m.fills, m.t1]), [[90, 3, T + 4]], 'a higher threshold marks only the fills credited that much');
  assert.deepEqual(at(35).map(m => m.price).sort(), [100, 105]);
});

test('saved settings are read field by field, and the box says what a mark means', () => {
  assert.deepEqual(readAbsorption(undefined), ABSORPTION_DEFAULTS);
  assert.deepEqual(readAbsorption({ on: 'yes', mode: 'manual', k: 7.3, sdMinutes: 0, fixedUsd: 5, volume: false }), { on: true, mode: 'auto', k: 7.5, sdMinutes: 1, fixedUsd: 25_000, volume: false });
  assert.equal(readAbsorption({ k: 1_000 }).k, 50); assert.equal(readAbsorption({ k: 1 }).k, 1.5); assert.equal(readAbsorption({ sdMinutes: 99_999 }).sdMinutes, 1_440);
  assert.equal(readAbsorption({ mode: 'fixed', fixedUsd: 400_000 }).fixedUsd, 400_000);

  assert.match(passiveText('sell', 1_200_000), /^Passive buyers took \$1\.2M of market sells$/);
  assert.match(passiveText('buy', 300_000), /^Passive sellers took \$300K of market buys$/);
  const mark: AbsorptionMark = { id: 'bybit:BTCUSDT', side: 'sell', price: 85_000, t0: T0, t1: T0 + 4, usd: 1_200_000, fills: 7, peak: 1_500_000, threshold: 600_000 };
  const one = markLines([mark], { ...ABSORPTION_DEFAULTS });
  assert.equal(one[0]!.text, 'ABSORPTION');
  const text = (lines: typeof one, label: string): string | undefined => lines.find(l => l.label === label)?.text;
  assert.equal(text(one, 'Fills'), '7');
  assert.equal(text(one, 'Threshold'), '$600K: mean + 10 SD of the last 30 min');
  assert.equal(text(markLines([mark], { ...ABSORPTION_DEFAULTS, mode: 'fixed' }), 'Threshold'), '$600K, fixed');
  assert.match(text(one, 'Time')!, /\.000 \+4 ms$/, 'to the millisecond, with the span of the marked fills');
  const two = markLines([mark, { ...mark, id: 'okx:BTC-USDT-SWAP', price: 85_010, usd: 300_000 }], { ...ABSORPTION_DEFAULTS });
  assert.match(two[1]!.text, /^Passive buyers took \$1\.5M of market sells$/, 'marks drawn as one are added up');
  assert.equal(text(two, 'Marks'), '2 marks');
});

test('only well-formed groups, minutes and answers are taken', () => {
  const good = { id: 'a:BTC', side: 'buy', price: 100, t0: T0, steps: [[90, 90, 3, T0, T0 + 4], [50, 120, 5, T0, T0 + 8]] };
  assert.deepEqual(parseGroup(good), good);
  const bad = (change: Record<string, unknown>): AbsorptionGroup | null => parseGroup({ ...good, ...change });
  for (const change of [{ steps: [[50, 50, 2, T0, T0], [90, 120, 5, T0, T0]] }, { steps: [[90, 90, 2.5, T0, T0]] }, { steps: [[90, 90, 2, T0 + 5, T0]] }, { steps: [] }, { steps: [[90, 90, 2, T0]] },
    { steps: [[Number.NaN, 90, 2, T0, T0]] }, { side: 'both' }, { price: 0 }, { id: '' }, { t0: 'soon' }]) {
    assert.equal(bad(change), null, JSON.stringify(change));
  }
  const minute = { id: 'a:BTC', t: T0, n: 3, mean: 20, m2: 200, floor: 25_000 };
  assert.deepEqual(parseMinute(minute), minute);
  for (const change of [{ n: 1.5 }, { n: -1 }, { m2: -1 }, { floor: -1 }, { mean: Infinity }, { id: 3 }]) assert.equal(parseMinute({ ...minute, ...change }), null, JSON.stringify(change));

  const answer = { groups: [good], floors: { 'a:BTC': 25_000 }, minutes: [minute], capped: ['a:BTC', 'z:BTC', 4] };
  assert.deepEqual(parseAbsorptionAnswer(answer, ['a:BTC']), { groups: [good], floors: { 'a:BTC': 25_000 }, minutes: [minute], capped: ['a:BTC'] } as unknown as AbsorptionAnswer);
  assert.equal(parseAbsorptionAnswer({ ...answer, groups: [{ ...good, id: 'z:BTC' }] }, ['a:BTC']), null, 'an instrument nobody asked about');
  assert.equal(parseAbsorptionAnswer({ ...answer, floors: { 'z:BTC': 1 } }, ['a:BTC']), null);
  assert.equal(parseAbsorptionAnswer({ ...answer, minutes: [{ ...minute, n: -1 }] }, ['a:BTC']), null, 'one broken minute refuses the whole answer');
  assert.equal(parseAbsorptionAnswer({ groups: [], minutes: [] }, ['a:BTC']), null);
  assert.deepEqual(parseAbsorptionAnswer({ groups: [], minutes: [], floors: {} }, ['a:BTC'])?.capped, [], 'an answer without the list cut nothing');
  assert.deepEqual(parseAbsorptionLive({ groups: [good, { ...good, price: -1 }], minutes: [minute, null] }), { groups: [good], minutes: [minute] } as unknown as ReturnType<typeof parseAbsorptionLive>, 'live items are taken one by one');
  assert.deepEqual(parseAbsorptionLive(null), { groups: [], minutes: [] });
});

test('the hub asks once per window: again when the window leaves it, a threshold falls under what was asked, or a minute after a refusal', async () => {
  class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  const asked: { ids: string[]; mins: number[]; from: number; to: number; limit: number; since: number; settle: (answer: AbsorptionAnswer | null, status?: number) => void }[] = [];
  const source = { absorption: (ids: string[], mins: number[], from: number, to: number, limit: number, since: number) => new Promise<AbsorptionAnswer>((resolve, reject) => {
    asked.push({ ids, mins, from, to, limit, since, settle: (answer, status = 404) => answer ? resolve(answer) : reject(Object.assign(new Error(String(status)), { status })) });
  }) };
  const hub = new Hub(new Store(initialState()), source as never);
  const realNow = Date.now; let clock = T0 + 30 * MIN + 30_000; Date.now = () => clock;
  const empty: AbsorptionAnswer = { groups: [], floors: {}, minutes: [], capped: [] };
  const live = () => ({ t0: clock - 10 * MIN, t1: clock + MIN, p0: 0, p1: 1 }) as never, back = () => ({ t0: clock - 3 * 3_600_000, t1: clock, p0: 0, p1: 1 }) as never;
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    hub.ensureAbsorption(['a:BTC'], [null], live(), 30);
    hub.ensureAbsorption(['a:BTC'], [null], live(), 30);
    assert.equal(asked.length, 1, 'one request at a time');
    assert.deepEqual(asked[0]!.mins, [Number.MAX_SAFE_INTEGER], 'no threshold yet: only the minutes are asked for');
    assert.equal(asked[0]!.since, Math.floor(clock / MIN) * MIN - 31 * MIN, 'the minutes of the span, and the one before');
    assert.equal(asked[0]!.limit, 4_000);
    asked[0]!.settle(empty); await turn();
    hub.ensureAbsorption(['a:BTC'], [null], live(), 30); assert.equal(asked.length, 1, 'answered, and nothing changed');
    hub.ensureAbsorption(['a:BTC'], [400_000], live(), 30); assert.equal(asked.length, 2, 'the minutes gave a threshold');
    assert.deepEqual(asked[1]!.mins, [300_000], 'a quarter under it');
    assert.equal(asked[1]!.since, clock - 3 * MIN, 'the minutes already held are not asked for again');
    asked[1]!.settle(empty); await turn();
    hub.ensureAbsorption(['a:BTC'], [320_000], live(), 30); assert.equal(asked.length, 2, 'a threshold drifting down a little');
    clock += 5 * MIN; hub.ensureAbsorption(['a:BTC'], [320_000], live(), 30); assert.equal(asked.length, 2, 'at the live edge the stream keeps it current');
    hub.ensureAbsorption(['a:BTC'], [290_000], live(), 30); assert.equal(asked.length, 3, 'a threshold under what was asked');
    asked[2]!.settle(empty); await turn();
    hub.ensureAbsorption(['a:BTC'], [290_000], back(), 30); assert.equal(asked.length, 4, 'a window reaching further back');
    asked[3]!.settle(null); await turn();
    assert.equal(hub.absorptionState, 'unavailable');
    hub.ensureAbsorption(['a:BTC'], [290_000], back(), 30); assert.equal(asked.length, 4, 'a source that refused is left alone for a minute');
    clock += MIN; hub.ensureAbsorption(['a:BTC'], [290_000], back(), 30); assert.equal(asked.length, 5);
    asked[4]!.settle(empty); await turn();
    assert.equal(hub.absorptionState, 'ready');
    hub.ensureAbsorption(['a:BTC', 'b:BTC'], [290_000, null], back(), 30); assert.equal(asked.length, 6, 'other instruments');
    assert.equal(asked[5]!.since, Math.floor(clock / MIN) * MIN - 31 * MIN, 'their minutes from the start of the span');
    // A request that failed is not a server without absorption: it says so differently, and is tried again a minute later.
    asked[5]!.settle(null, 500); await turn();
    assert.equal(hub.absorptionState, 'failed');
    clock += MIN;
    // A map zoomed out over nine days asks from where the recorder's week begins (the server refuses more than eight).
    const wide = { t0: clock - 9 * 86_400_000, t1: clock, p0: 0, p1: 1 } as never;
    hub.ensureAbsorption(['a:BTC'], [290_000], wide, 30); assert.equal(asked.length, 7);
    assert.ok(asked[6]!.to - asked[6]!.from <= 8 * 86_400_000 && asked[6]!.from >= clock - 7 * 86_400_000 - MIN, 'within the week that is kept');
    // An answer cut at the limit says, per instrument, the smallest peak it kept.
    const group = (usd: number): AbsorptionGroup => ({ id: 'a:BTC', side: 'buy', price: 100, t0: clock - usd, steps: [[usd, usd, 1, clock - usd, clock - usd]] });
    asked[6]!.settle({ groups: [group(900_000), group(400_000)], floors: {}, minutes: [], capped: ['a:BTC'] }); await turn();
    assert.equal(hub.absorptionState, 'ready');
    assert.deepEqual([...hub.absorptionCut], [['a:BTC', 400_000]], 'marks are missing only where the threshold is at or under 400K');
    hub.ensureAbsorption(['a:BTC'], [290_000], wide, 30); assert.equal(asked.length, 7, 'and the week is not asked for again on the next frame');
  } finally { Date.now = realNow; }
});

test('the area of a square follows its volume against the largest square in view, so a zoomed-out day of marks is not one size', () => {
  assert.equal(markSize(5e7, 5e7), MARK_MAX_PX, 'the largest in view is the biggest');
  assert.equal(markSize(250_000, 250_000), markSize(5e7, 5e7), 'whatever its dollars');
  assert.ok(Math.abs(markSize(2e7, 4e7) / markSize(5e6, 4e7) - 2) < 1e-9, 'four times the volume, twice the side');
  assert.ok(markSize(1.5e7, 5e7) < markSize(3e7, 5e7) && markSize(3e7, 5e7) < MARK_MAX_PX, '$15M and $30M of a day of $50M marks differ');
  assert.equal(markSize(1, 5e7), MARK_MIN_PX, 'never smaller than can be seen');
  assert.equal(markSize(1e6, 0), MARK_MIN_PX);
});

test('the marks of a window are judged once until the groups or thresholds change, and are what judging every group gives', () => {
  let s = 3; const rnd = (): number => { s = (s * 1_103_515_245 + 12_345) & 0x7fffffff; return s / 0x7fffffff; };
  const T = Math.floor(Date.now() / MIN) * MIN, ids = ['a:BTC', 'b:BTC', 'c:BTC'];
  const groupAt = (t0: number): AbsorptionGroup => { const usd = 20_000 + Math.floor(rnd() * 200_000); return { id: ids[Math.floor(rnd() * 3)]!, side: rnd() < 0.5 ? 'buy' : 'sell', price: 100 + Math.floor(rnd() * 50), t0, steps: [[usd, usd, 1 + Math.floor(rnd() * 5), t0, t0 + 3]] }; };
  // Up to a minute's ten per instrument is tested on its own: here every group stands, so the book is judged against all of them.
  const book = new AbsorptionBook(900, Infinity), all = new Map<string, AbsorptionGroup>();
  const add = (groups: AbsorptionGroup[]): void => { book.add(groups); for (const g of groups) all.set(groupKey(g), g); };
  const thresholds = new Map<string, number | null>([['a:BTC', 50_000], ['b:BTC', 30_000], ['c:BTC', null]]);
  const reference = (t0: number, t1: number, p0: number, p1: number): AbsorptionMark[] => {
    const out: AbsorptionMark[] = [];
    for (const g of all.values()) {
      if (g.t0 < t0 - 10 || g.t0 > t1 || g.price < p0 || g.price > p1) continue;
      const threshold = thresholds.get(g.id); if (threshold === null || threshold === undefined || peakOf(g) < threshold) continue;
      const part = markedPart(g, threshold)!;
      out.push({ id: g.id, side: g.side, price: g.price, t0: part.t0, t1: part.t1, usd: part.usd, fills: part.fills, peak: part.peak, threshold });
    }
    return out;
  };
  const check = (label: string): void => {
    for (const [t0, t1, p0, p1] of [[T, T + 600_000, 0, 1e9], [T + 1_000, T + 2_000, 110, 130], [T + 999, T + 999, 0, 1e9], [T - 5_000, T + 50, 120, 120]] as const)
    {
      const ref = reference(t0, t1, p0, p1);
      assert.deepEqual(book.marks(ids, thresholds, t0, t1, p0, p1), ref, `${label}: ${t0 - T}..${t1 - T}`);
      // The map's order: the largest first, equal ones in the order the groups came (a stable sort of the same marks).
      assert.deepEqual(book.marksByUsd(ids, thresholds, t0, t1, p0, p1), [...ref].sort((a, b) => b.usd - a.usd), `${label} by size: ${t0 - T}..${t1 - T}`);
    }
  };
  // Live groups in time order (with a repeat that updates a group in place), an older window loaded after them, a few the same instant.
  for (let i = 0; i < 200; i++) add([groupAt(T + 1_000 + i * 10)]);
  const again = { ...[...all.values()][5]!, steps: [[90_000, 90_000, 7, T + 1_050, T + 1_052]] as AbsorptionStep[] }; add([again]);
  check('in order');
  const once = book.marks(ids, thresholds, T, T + 600_000, 0, 1e9), twice = book.marks(ids, thresholds, T + 1_000, T + 600_000, 0, 1e9);
  assert.ok(twice.length > 0 && twice.every(m => once.includes(m)), 'the same judged marks, read again for another window');
  // Another caller judging with its own thresholds (the Range panel) does not push the map's out.
  book.marks(ids, new Map(thresholds), T, T + 600_000, 0, 1e9);
  assert.ok(book.marks(ids, thresholds, T, T + 600_000, 0, 1e9).every(m => once.includes(m)), 'the marks the map judged are still kept');
  add(Array.from({ length: 150 }, (_, i) => groupAt(T + i * 7)));
  add(Array.from({ length: 30 }, () => groupAt(T + 999)));
  check('an older window loaded');
  // Past the limit some go (no answer claims any of them here, so the oldest), and what is left is found the same way.
  add(Array.from({ length: 700 }, (_, i) => groupAt(T + 3_000 + i)));
  const kept = new Set<string>(); for (const m of book.marks(ids, new Map(ids.map(id => [id, 0])), 0, Number.MAX_SAFE_INTEGER, 0, 1e9)) kept.add(`${m.id}|${m.side}|${m.price}|${m.t0}`);
  for (const key of [...all.keys()]) if (!kept.has(key)) all.delete(key);
  check('after the smallest were dropped');
});

test('a judged list brought up to date is what judging every group gives, through updates, busy minutes, freed room and thresholds that move', () => {
  let s = 11; const rnd = (): number => { s = (s * 1_103_515_245 + 12_345) & 0x7fffffff; return s / 0x7fffffff; };
  const T = Math.floor(Date.now() / MIN) * MIN, ids = ['a:BTC', 'b:BTC', 'c:BTC'];
  // Equal sizes on purpose (a few dollar values only): the order of equal marks must be the order the groups came.
  const groupAt = (t0: number, price = 100 + Math.floor(rnd() * 8)): AbsorptionGroup => { const usd = [40_000, 60_000, 60_000, 90_000][Math.floor(rnd() * 4)]!; return { id: ids[Math.floor(rnd() * 3)]!, side: rnd() < 0.5 ? 'buy' : 'sell', price, t0, steps: [[usd, usd, 1 + Math.floor(rnd() * 5), t0, t0 + 3]] }; };
  // A small book (room freed now and then) and three groups a minute per instrument (a busy minute lets its smallest go). Every call made to
  // it is made again on a twin built fresh for each check, whose first question judges every group: the reference.
  const make = (): AbsorptionBook => new AbsorptionBook(400, 3), book = make(), calls: ((b: AbsorptionBook) => void)[] = [];
  const call = (f: (b: AbsorptionBook) => void): void => { calls.push(f); f(book); };
  let thresholds = new Map<string, number | null>([['a:BTC', 50_000], ['b:BTC', 30_000], ['c:BTC', null]]);
  const held: AbsorptionGroup[] = [];
  const same = (label: string): void => {
    const twin = make(); for (const f of calls) f(twin);
    const whole = twin.marks(ids, thresholds, 0, Number.MAX_SAFE_INTEGER, 0, 1e9);
    assert.deepEqual(book.marks(ids, thresholds, 0, Number.MAX_SAFE_INTEGER, 0, 1e9), whole, `${label}: in the order the groups came`);
    assert.deepEqual(book.marksByUsd(ids, thresholds, 0, Number.MAX_SAFE_INTEGER, 0, 1e9), [...whole].sort((a, b) => b.usd - a.usd), `${label}: the largest first`);
  };
  same('empty');
  for (let step = 0; step < 400; step++) {
    const r = rnd();
    if (r < 0.45) { const g = groupAt(T + step * 20_000); held.push(g); call(b => b.add([g])); }
    else if (r < 0.6 && held.length) { const g = held[Math.floor(rnd() * held.length)]!, usd = 30_000 + Math.floor(rnd() * 90_000), next = { ...g, steps: [[usd, usd, 2, g.t0, g.t0 + 2]] as AbsorptionStep[] }; call(b => b.add([next])); }
    else if (r < 0.7) { const t0 = T + Math.floor(rnd() * 20) * MIN, batch = Array.from({ length: 5 }, () => groupAt(t0 + Math.floor(rnd() * 50))); call(b => b.add(batch)); }
    else if (r < 0.75) { const m = { id: 'a:BTC', t: T + step * MIN, n: 1, mean: 0, m2: 0, floor: 1_000 }; call(b => b.addMinutes([m])); }
    else if (r < 0.8) { const answer = { groups: Array.from({ length: 90 }, (_, i) => groupAt(T - (i + 1) * MIN)), minutes: [], capped: [], floors: {} } as unknown as AbsorptionAnswer; call(b => b.load(answer)); }
    else if (r < 0.9) {
      // A threshold moves (one instrument's, or all of them, or one gains or loses one), in a new map as the map hands them over.
      const next = new Map(thresholds), pick = ids[Math.floor(rnd() * 3)]!, k = rnd();
      if (k < 0.6) next.set(pick, [null, 35_000, 45_000, 55_000, 70_000][Math.floor(rnd() * 5)]!);
      else if (k < 0.8) for (const id of ids) next.set(id, 30_000 + Math.floor(rnd() * 50_000));
      thresholds = next;
    }
    // Asked now and then, not after every change: bringing up to date spans several versions and thresholds.
    if (rnd() < 0.35) same(`step ${step}`);
  }
  same('at the end');
});

test('a new group, a busy minute letting its smallest go, a threshold that moved: the marks they do not touch are kept, not judged again', () => {
  const T = Math.floor(Date.now() / MIN) * MIN, two = ['a:BTC', 'b:BTC'], th = new Map<string, number | null>([['a:BTC', 10], ['b:BTC', 10]]);
  const all = (b: AbsorptionBook, at: ReadonlyMap<string, number | null> = th): AbsorptionMark[] => b.marks(two, at, 0, Number.MAX_SAFE_INTEGER, 0, 1e9);
  const g = (t0: number, usd: number, price = 100, id = 'a:BTC'): AbsorptionGroup => ({ id, side: 'sell', price, t0, steps: [[usd, usd, 1, t0, t0 + 1]] });
  const book = new AbsorptionBook(1_000, 2);
  book.add([g(T, 50), g(T + 2 * MIN, 60), g(T + 3 * MIN, 30, 100, 'b:BTC')]);
  const first = all(book);
  book.add([g(T + 4 * MIN, 70)]);
  const next = all(book);
  assert.equal(next.length, 4);
  assert.ok(first.every(m => next.includes(m)), 'the marks held before are the same objects: caught up, not judged again');
  // The minute of T holds two: a third larger one makes it let the smallest go.
  book.add([g(T + 1_000, 80, 101), g(T + 2_000, 90, 102)]);
  const after = all(book);
  assert.ok(!after.some(m => m.usd === 50), 'the smallest of the busy minute went');
  assert.ok(next.filter(m => m.usd !== 50).every(m => after.includes(m)), 'the rest are still the same objects');
  // a:BTC's threshold moves: its marks are judged again (b:BTC's stay the same objects), and the values decide, not the map handed over.
  const moved = new Map(th).set('a:BTC', 75), later = all(book, moved);
  assert.deepEqual(later.map(m => m.usd).sort((x, y) => x - y), [30, 80, 90], 'what the moved threshold leaves');
  assert.ok(later.filter(m => m.id === 'b:BTC').every(m => after.includes(m)), 'the other instrument is not judged again');
  assert.ok(all(book, new Map(moved)).every(m => later.includes(m)), 'another map with the same values: nothing judged again');
  // The reference: a book given the same groups, judged whole.
  const twin = new AbsorptionBook(1_000, 2);
  twin.add([g(T, 50), g(T + 2 * MIN, 60), g(T + 3 * MIN, 30, 100, 'b:BTC')]); twin.add([g(T + 4 * MIN, 70)]); twin.add([g(T + 1_000, 80, 101), g(T + 2_000, 90, 102)]);
  assert.deepEqual(all(book, moved), all(twin, moved), 'and what judging every group gives');
});

test('a change of more groups than the log keeps (a long history answer) has a judged list judged whole again, and right', () => {
  const T = Math.floor(Date.now() / MIN) * MIN, ids = ['a:BTC', 'b:BTC'], th = new Map<string, number | null>([['a:BTC', 40_000], ['b:BTC', 60_000]]);
  const answer = (n: number, from: number): AbsorptionAnswer => ({ groups: Array.from({ length: n }, (_, i) => { const usd = 20_000 + (i * 7_919) % 90_000, t0 = from + i * 1_000; return { id: ids[i % 2]!, side: i % 3 ? 'buy' : 'sell', price: 100 + (i % 50), t0, steps: [[usd, usd, 1, t0, t0 + 1]] } as AbsorptionGroup; }), minutes: [], capped: [], floors: {} } as unknown as AbsorptionAnswer);
  // A book of 20,100 groups, so 5,000 changed are under a quarter of it: only the log's bound has them judged whole.
  const first = answer(20_100, T), big = answer(5_000, T - 6_000_000);
  const book = new AbsorptionBook(50_000, Infinity), twin = new AbsorptionBook(50_000, Infinity);
  book.load(first);
  const all = (b: AbsorptionBook, fn: 'marks' | 'marksByUsd'): AbsorptionMark[] => b[fn](ids, th, 0, Number.MAX_SAFE_INTEGER, 0, 1e9);
  const early = all(book, 'marks');
  book.load(big); twin.load(first); twin.load(big);
  assert.deepEqual(all(book, 'marks'), all(twin, 'marks'));
  assert.ok(!early.some(m => all(book, 'marks').includes(m)), 'judged whole: the log keeps no list of 5,000 keys');
  assert.deepEqual(all(book, 'marksByUsd'), all(twin, 'marksByUsd'));
  // Then live groups again: caught up one by one from there.
  const g = { id: 'a:BTC', side: 'buy', price: 120, t0: T + 500_000, steps: [[95_000, 95_000, 1, T + 500_000, T + 500_001]] } as AbsorptionGroup;
  const held = all(book, 'marks'); book.add([g]); twin.add([g]);
  assert.deepEqual(all(book, 'marks'), all(twin, 'marks'));
  assert.ok(held.every(m => all(book, 'marks').includes(m)), 'the marks held before are kept (caught up, not judged whole)');
});

test('marks near each other become one square exactly as comparing each with every square did', () => {
  let s = 9; const rnd = (): number => { s = (s * 1_103_515_245 + 12_345) & 0x7fffffff; return s / 0x7fffffff; };
  const marks: AbsorptionMark[] = Array.from({ length: 3_000 }, (_, i) => ({ id: `v${i % 4}:BTC`, side: rnd() < 0.5 ? 'buy' : 'sell', price: 100 + rnd() * 40, t0: i, t1: i, usd: 1 + Math.floor(rnd() * 40) * 1_000, fills: 1, peak: 1, threshold: 1 }));
  const xOf = (m: AbsorptionMark): number => -30 + (m.price * 97 % 1) * 900, yOf = (m: AbsorptionMark): number => (m.price - 100) * 15 - 20;
  const reference: MarkIcon[] = [];
  for (const m of [...marks].sort((a, b) => b.usd - a.usd)) {
    const x = xOf(m), y = yOf(m);
    if (x < -NEAR_PX || x > 800 + NEAR_PX || y < -NEAR_PX || y > 560 + NEAR_PX) continue;
    const near = reference.find(i => i.side === m.side && Math.abs(i.x - x) < NEAR_PX && Math.abs(i.y - y) < NEAR_PX);
    if (near) { near.usd += m.usd; near.marks.push(m); } else reference.push({ side: m.side, x, y, usd: m.usd, marks: [m] });
  }
  const icons = iconsOf(marks, xOf, yOf, 800, 560);
  assert.ok(icons.some(i => i.marks.length > 3), 'the made-up marks crowd together');
  assert.deepEqual(icons, reference);
  // Given the largest first already (the book's `marksByUsd`, equal sizes in the order given), the same squares without sorting again.
  assert.deepEqual(iconsOf([...marks].sort((a, b) => b.usd - a.usd), xOf, yOf, 800, 560), reference);
  // Off the plot in every direction and a mark with no place: left out, as before.
  assert.deepEqual(iconsOf([{ ...marks[0]!, price: 1e9 }, { ...marks[1]!, price: -1e9 }, { ...marks[2]!, price: Number.NaN }], xOf, yOf, 800, 560), []);
});

test('a question reaching back into a large store does not overflow the stack (the first answers after a restart)', async () => {
  // 300,000 stored minutes: spread into one push they overflowed the stack on the live server right after a restart (2026-10-15).
  const minutes: AbsorptionMinute[] = Array.from({ length: 300_000 }, (_, i) => ({ id: 'binance:BTCUSDT', t: T0 - (300_000 - i) * MIN, n: 1, mean: 0, m2: 0, floor: 1_000 }));
  const store = { load: () => ({ groups: [], minutes: [] }), save: () => {}, query: () => [], minutes: () => minutes, eachHour: async () => {}, close: () => {} };
  const recorder = new AbsorptionRecorder(store, () => T0);
  const answer = await recorder.query(['binance:BTCUSDT'], [0], T0 - 300_000 * MIN, T0, 50, T0 - 300_000 * MIN);
  assert.equal(answer.minutes.length, 300_000);
  assert.equal(answer.floors['binance:BTCUSDT'], 1_000);
});
