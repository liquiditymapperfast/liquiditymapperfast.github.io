import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, LiqHistory, bandIndex, dayText, historyUrls, readDay, readIndex, LIQ_REFUSED } from '../src/app/liq-history.ts';
import { PRESET_BANDS } from '../src/app/depth-settings.ts';
import { FIRST_LEAD_MS, SNAPSHOT_DUE_MS } from '../src/app/liq-schedule.ts';

/** The service's buckets (history.rs): 1/32 % to 5 %, then 5/16 % to 25 %. */
const EDGES = [...Array.from({ length: 160 }, (_, i) => (i + 1) / 32), ...Array.from({ length: 64 }, (_, i) => 5 + (i + 1) * 5 / 16)];
const zeros = (): number[] => new Array(EDGES.length).fill(0);
const row = (fetchedAt: number, at: Record<number, [number, number]> = {}, mark = 100_000): unknown[] => {
  const long = zeros(), short = zeros();
  for (const [i, [l, s]] of Object.entries(at)) { long[Number(i)] = l; short[Number(i)] = s; }
  return [fetchedAt - 2_400_000, fetchedAt - 300_000, fetchedAt, mark, 0, 0, long, short];
};

test('the history lives beside the levels file, and a day is named as the service names it', () => {
  assert.deepEqual(historyUrls('https://levels.hiverust.dev/v1/btc/liquidations.json') && {
    index: historyUrls('https://levels.hiverust.dev/v1/btc/liquidations.json')!.index,
    day: historyUrls('https://levels.hiverust.dev/v1/btc/liquidations.json')!.day('2026-11-05'),
  }, { index: 'https://levels.hiverust.dev/v1/btc/liquidation-history.json', day: 'https://levels.hiverust.dev/v1/btc/liquidation-history/2026-11-05.json' });
  assert.equal(historyUrls(''), null, 'no levels service, no history');
  assert.equal(dayText(Date.UTC(2026, 10, 5, 23, 59)), '2026-11-05');
});

test('every band the pane offers ends on a bucket edge', () => {
  for (const bands of Object.values(PRESET_BANDS)) for (const r of bands) {
    const i = bandIndex(EDGES, r);
    assert.ok(i >= 0 && Math.abs(EDGES[i]! - r * 100) < 1e-9, `±${r * 100} %`);
  }
  assert.equal(bandIndex(EDGES, 0.0001), -1, 'narrower than the first bucket: nothing');
  assert.equal(bandIndex(EDGES, 0.9), EDGES.length - 1, 'wider than the last: all of it');
});

test('the index and the days are checked: a row of the wrong shape is left out, never drawn', () => {
  assert.deepEqual(readIndex({ edges: [0.5, 1], first: 5, last: 9 }), { edges: [0.5, 1], first: 5, last: 9 });
  assert.equal(readIndex({ edges: [1, 0.5] }), null, 'edges must rise');
  assert.equal(readIndex({ edges: [] }), null);
  assert.equal(readIndex(null), null);
  assert.deepEqual(readIndex({ edges: [1], first: 'x' }), { edges: [1], first: null, last: null });
  const good = row(1_000, { 31: [1_000_000, 2_000_000] }), bad = [1, 2, 3, 0, 0, 0, zeros(), zeros()], short = [1, 2, 3, 4, 0, 0, [1], [1]], negative = row(2_000, { 0: [-1, 0] });
  const rows = readDay({ rows: [good, bad, short, negative] }, EDGES);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.long[30], 0); assert.equal(r.long[31], 1_000_000, 'the bucket ending at 1 %'); assert.equal(r.long[EDGES.length - 1], 1_000_000, 'and every wider one');
  assert.equal(r.short[31], 2_000_000);
  // Coins: bucket 31 runs from 0.96875 to 1 %, its middle 0.984375 % from the mark: longs below it, shorts above.
  assert.ok(Math.abs(r.longCoin[31]! - 1_000_000 / (100_000 * (1 - 0.00984375))) < 1e-3);
  assert.ok(Math.abs(r.shortCoin[31]! - 2_000_000 / (100_000 * (1 + 0.00984375))) < 1e-3);
  assert.deepEqual(readDay({ rows: [row(3), row(1), row(2)] }, EDGES).map(x => x.fetchedAt), [1, 2, 3], 'ordered by fetch time');
});

test('the pane asks for the index first, then the days its view needs (with the evening before), each once, today again when due', async () => {
  const asked: string[] = [], day = Date.UTC(2026, 10, 5), now = day + 10 * 3_600_000;
  const answers: Record<string, unknown> = {
    'https://levels.hiverust.dev/v1/btc/liquidation-history.json': { edges: EDGES, first: day - 2 * DAY_MS + 3_600_000, last: now - 600_000 },
    [`https://levels.hiverust.dev/v1/btc/liquidation-history/${dayText(day - DAY_MS)}.json`]: { rows: [row(day - 1_800_000, { 40: [5, 6] })] },
    [`https://levels.hiverust.dev/v1/btc/liquidation-history/${dayText(day)}.json`]: { rows: [row(day + 3_600_000, { 40: [7, 8] }), row(day + 5_400_000)] },
  };
  const h = new LiqHistory(url => { asked.push(url); return url in answers ? Promise.resolve(answers[url]) : Promise.reject(new Error('404')); });
  const settle = () => new Promise(r => setTimeout(r, 0));
  h.ensure(day + 3_000_000, now + 3_600_000, now, () => {});
  assert.deepEqual(asked, ['https://levels.hiverust.dev/v1/btc/liquidation-history.json'], 'nothing but the index before it has come');
  await settle(); await settle();
  h.ensure(day + 3_000_000, now + 3_600_000, now, () => {});
  assert.deepEqual(asked.slice(1).map(u => u.slice(-15)), [`${dayText(day - DAY_MS)}.json`, `${dayText(day)}.json`], 'the day before the view and the day in it, nothing before the history begins');
  await settle(); await settle();
  const inForce = h.rows(day + 3_000_000, now);
  assert.deepEqual(inForce.map(r => r.fetchedAt), [day - 1_800_000, day + 3_600_000, day + 5_400_000], 'the row before the view holds at its left edge');
  h.ensure(day + 3_000_000, now + 3_600_000, now + 10_000, () => {});
  assert.equal(asked.length, 3, 'nothing again within the minute');
  // Today's newest snapshot is hours old (the service has stopped getting them): asked every five minutes, not each minute.
  h.ensure(day + 3_000_000, now + 3_600_000, now + 70_000, () => {});
  assert.equal(asked.length, 3, 'a late snapshot is not asked for each minute');
  h.ensure(day + 3_000_000, now + 3_600_000, now + 5 * 60_000 + 1_000, () => {});
  assert.deepEqual(asked.slice(3).filter(u => !u.endsWith('liquidation-history.json')).map(u => u.slice(-15)), [`${dayText(day)}.json`], 'today again after five minutes; yesterday, read after it ended, never');
});

test('a new UTC day with no snapshot yet is asked when the day before\'s newest says the next can be there, not each minute', async () => {
  const asked: string[] = [], day = Date.UTC(2026, 10, 6), MIN = 60_000;
  // Yesterday's newest was created at 23:52 (published 23:57); the next is published at 00:30:20.
  const index = 'https://levels.hiverust.dev/v1/btc/liquidation-history.json';
  const files: Record<string, unknown> = {
    [index]: { edges: EDGES, first: day - 3 * DAY_MS, last: day - 75_000 },
    [`https://levels.hiverust.dev/v1/btc/liquidation-history/${dayText(day - DAY_MS)}.json`]: { rows: [row(day - 3 * MIN)] },
    [`https://levels.hiverust.dev/v1/btc/liquidation-history/${dayText(day)}.json`]: { rows: [] },
  };
  const h = new LiqHistory(url => { asked.push(url); return Promise.resolve(files[url]); });
  const settle = async (): Promise<void> => { await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); };
  const todays = (): number => asked.filter(u => u.endsWith(`${dayText(day)}.json`)).length;
  const at = async (t: number): Promise<void> => { h.ensure(day - 2 * 3_600_000, t + 3_600_000, t, () => {}); await settle(); };
  await at(day + MIN); await at(day + MIN);
  assert.equal(todays(), 1, 'today read once, empty');
  for (let m = 2; m < 20; m++) await at(day + m * MIN);
  assert.equal(todays(), 1, 'not asked each minute while it is empty');
});

test('today is asked again when its next snapshot can be there, then each minute until it comes', async () => {
  const asked: string[] = [], day = Date.UTC(2026, 10, 5), MIN = 60_000, t0 = day + 10 * 3_600_000;
  // The newest row was published four minutes before the first read, created five minutes before that (`row`): the next can be there
  // SNAPSHOT_DUE_MS after its creation, less the first lead (the first read places it by its age): D minutes on.
  const D = (SNAPSHOT_DUE_MS - FIRST_LEAD_MS) / MIN - 9;
  let rows = [row(t0 - 4 * MIN)];
  const index = 'https://levels.hiverust.dev/v1/btc/liquidation-history.json', today = `https://levels.hiverust.dev/v1/btc/liquidation-history/${dayText(day)}.json`;
  const h = new LiqHistory(url => { asked.push(url); return Promise.resolve(url === index ? { edges: EDGES, first: day + 3_600_000, last: t0 } : { rows }); });
  const settle = async (): Promise<void> => { await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); };
  const todays = (): number => asked.filter(u => u === today).length;
  const at = async (t: number): Promise<void> => { h.ensure(day + 3_600_000, t + 3_600_000, t, () => {}); await settle(); };
  await at(t0); await at(t0);
  assert.equal(todays(), 1);
  for (let m = 1; m < D; m++) await at(t0 + m * MIN);
  assert.equal(todays(), 1, 'not asked before the next snapshot can be there');
  await at(t0 + D * MIN + 1_000);
  assert.equal(todays(), 2, 'asked when due');
  await at(t0 + (D + 1) * MIN + 2_000);
  assert.equal(todays(), 3, 'and each minute after');
  rows = [row(t0 - 4 * MIN), row(t0 + (D + 1) * MIN)];
  await at(t0 + (D + 2) * MIN + 3_000);
  assert.equal(todays(), 4);
  assert.equal(h.rows(day, t0 + DAY_MS).length, 2, 'the new snapshot came');
  // The new row was created five minutes before its fetch (D - 4 minutes on): the one after is due SNAPSHOT_DUE_MS after that.
  for (let m = D + 3; m < D - 4 + SNAPSHOT_DUE_MS / MIN; m++) await at(t0 + m * MIN + 3_000);
  assert.equal(todays(), 4, 'quiet again until the one after can be there');
});

test('a long session lets go of the days farthest from the view, never one the view needs', async () => {
  const day = Date.UTC(2026, 10, 5), asked: string[] = [];
  const h = new LiqHistory(url => { asked.push(url); return Promise.resolve(url.endsWith('liquidation-history.json') ? { edges: EDGES, first: day - 300 * DAY_MS, last: day } : { rows: [] }); });
  const settle = () => new Promise(r => setTimeout(r, 0));
  const view = (from: number, to: number) => { h.ensure(from, to, day + 3_600_000, () => {}); };
  view(day - 119 * DAY_MS, day); await settle(); await settle();
  view(day - 119 * DAY_MS, day); await settle(); await settle();
  view(day - 280 * DAY_MS, day - 161 * DAY_MS); await settle(); await settle();
  const before = asked.length;
  view(day - 280 * DAY_MS, day - 161 * DAY_MS); await settle(); await settle();
  assert.equal(asked.length, before, 'the older window, once read, is not asked again on the next frame');
});

/** A history whose every day answers with no rows, with who may read what given (Plus): what was asked, and with which pass. */
function gated(access: { free: number; pass: string | null; refuse?: (day: string, pass: string | null | undefined) => boolean; why?: string }, index: { first: number; last: number }) {
  const asked: { day: string; pass: string | null | undefined }[] = [];
  const refused: string[] = [];
  const h = new LiqHistory((url, pass) => {
    if (url.endsWith('liquidation-history.json')) return Promise.resolve({ edges: EDGES, ...index });
    const day = url.slice(url.lastIndexOf('/') + 1, -'.json'.length);
    asked.push({ day, pass });
    return access.refuse?.(day, pass) ? Promise.reject(new Error(access.why ?? LIQ_REFUSED)) : Promise.resolve({ rows: [] });
  }, { freeFrom: () => access.free, pass: () => access.pass, refused: pass => { refused.push(pass); } });
  return { h, asked, refusals: () => refused.length, refused };
}
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

test('Plus: the days before the free ones are asked for only with a pass, which goes with the request', async () => {
  const today = Date.UTC(2026, 10, 17), now = today + 10 * 3_600_000, free = today - 7 * DAY_MS, from = today - 12 * DAY_MS;
  const access = { free, pass: null as string | null };
  const { h, asked } = gated(access, { first: today - 20 * DAY_MS, last: now - 600_000 });
  h.ensure(from, now, now, () => {}); await tick();
  h.ensure(from, now, now, () => {}); await tick();
  const freeDays = Array.from({ length: 8 }, (_, i) => dayText(free + i * DAY_MS));
  assert.deepEqual(asked.map(a => a.day), freeDays, 'today and the seven days before it, and none of the days before those');
  assert.ok(asked.every(a => a.pass == null), 'a free day carries no pass');
  assert.equal(h.closedBefore(now), free, 'the pane is told where the closed stretch ends');
  // A pass comes (the Plus page stored one): the newest paid day first, alone; once it is answered the older days of the view, each with
  // the pass; the free ones are not asked again.
  access.pass = 'v1.body.sig'; h.accessChanged();
  asked.length = 0;
  h.ensure(from, now, now, () => {}); await tick();
  assert.deepEqual(asked.map(a => a.day), [dayText(free - DAY_MS)], 'one paid day first: the newest closed one');
  h.ensure(from, now, now, () => {}); await tick();
  const paidDays = Array.from({ length: 6 }, (_, i) => dayText(from - DAY_MS + i * DAY_MS));
  assert.deepEqual([...asked.map(a => a.day)].sort(), paidDays, 'from the evening before the view to the last day before the free ones');
  assert.ok(asked.every(a => a.pass === 'v1.body.sig'));
  assert.equal(h.closedBefore(now), null, 'with a pass nothing is closed');
});

test('Plus: a pass the server refuses is reported and asked for again; a free day it refuses closes with the days before it', async () => {
  const today = Date.UTC(2026, 10, 17), now = today + 10 * 3_600_000, free = today - 7 * DAY_MS, from = today - 9 * DAY_MS;
  // The pass is no good any more (the subscription ended between two renewals).
  const paid = { free, pass: 'v1.old.sig' as string | null, refuse: (_day: string, pass: string | null | undefined) => pass != null };
  const a = gated(paid, { first: today - 20 * DAY_MS, last: now - 600_000 });
  let changed = 0;
  a.h.ensure(from, now, now, () => { changed++; }); await tick();
  a.h.ensure(from, now, now, () => { changed++; }); await tick();
  assert.ok(a.refusals() >= 1, 'told that the pass was refused');
  assert.ok(a.refused.every(pass => pass === 'v1.old.sig'), 'and which one');
  assert.ok(changed >= 1, 'and the pane draws again');
  // The page's clock runs a day behind the server's: the day it calls free is a Plus day there.
  const skewed = { free, pass: null as string | null, refuse: (day: string) => day === dayText(free) };
  const b = gated(skewed, { first: today - 20 * DAY_MS, last: now - 600_000 });
  b.h.ensure(from, now, now, () => {}); await tick();
  b.h.ensure(from, now, now, () => {}); await tick();
  assert.equal(b.refusals(), 0, 'no pass was sent, so none is blamed');
  assert.equal(b.h.closedBefore(now), free + DAY_MS, 'the refused day is closed too');
  b.h.ensure(from, now, now + 120_000, () => {}); await tick();
  assert.equal(b.asked.filter(x => x.day === dayText(free)).length, 1, 'and is not asked for again while that holds');
  // It holds for ten minutes, then the day is asked once more (the clock may have been set right, the server's rule changed).
  b.h.ensure(from, now, now + 11 * 60_000, () => {}); await tick();
  assert.equal(b.asked.filter(x => x.day === dayText(free)).length, 2, 'asked again after ten minutes');
  assert.equal(b.h.closedBefore(now + 11 * 60_000 + 1), free + DAY_MS, 'and closed again when refused again');
  // A pass comes: the refused day is asked for with it at once, not after a failed read's minute.
  skewed.pass = 'v1.new.sig'; b.h.accessChanged();
  b.asked.length = 0;
  b.h.ensure(from, now, now + 11 * 60_000 + 2, () => {}); await tick();
  assert.ok(b.asked.some(x => x.day === dayText(free) && x.pass === 'v1.new.sig'));
});

test('Plus: only the gate\'s own refusal near the free boundary closes anything', async () => {
  const today = Date.UTC(2026, 10, 17), now = today + 10 * 3_600_000, free = today - 7 * DAY_MS, from = today - 9 * DAY_MS;
  const index = { first: today - 20 * DAY_MS, last: now - 600_000 };
  // Some other 403 (a firewall's, a rate limit's) on every day, with and without a pass.
  const other = gated({ free, pass: null, refuse: () => true, why: '403' }, index);
  other.h.ensure(from, now, now, () => {}); await tick();
  other.h.ensure(from, now, now, () => {}); await tick();
  assert.equal(other.h.closedBefore(now), free, 'nothing more is closed than the page\'s own rule says');
  const withPass = gated({ free, pass: 'v1.good.sig', refuse: () => true, why: '403' }, index);
  withPass.h.ensure(from, now, now, () => {}); await tick();
  withPass.h.ensure(from, now, now, () => {}); await tick();
  assert.equal(withPass.refusals(), 0, 'and the pass is not blamed');
  // The gate refusing today's file: no clock is a week off, so the history is not closed for it.
  const broken = gated({ free, pass: null, refuse: day => day === dayText(today) }, index);
  broken.h.ensure(from, now, now, () => {}); await tick();
  broken.h.ensure(from, now, now, () => {}); await tick();
  assert.equal(broken.h.closedBefore(now), free);
  // Two days inside the boundary is still a clock's doing.
  const near = gated({ free, pass: null, refuse: day => day <= dayText(free + DAY_MS) }, index);
  near.h.ensure(from, now, now, () => {}); await tick();
  near.h.ensure(from, now, now, () => {}); await tick();
  assert.equal(near.h.closedBefore(now), free + 2 * DAY_MS);
});

test('Plus: a service with no paid part closes nothing', () => {
  const h = new LiqHistory(() => Promise.resolve({}));
  assert.equal(h.closedBefore(Date.UTC(2026, 10, 17)), null);
});

test('Plus not on sale with the gate live: the newest day before the boundary is asked first, a member\'s days with the pass; the gate\'s refusal closes it and the days before it, held ten minutes', async () => {
  const today = Date.UTC(2026, 10, 17), now = today + 10 * 3_600_000, free = today - 7 * DAY_MS, from = today - 12 * DAY_MS;
  const index = { first: today - 20 * DAY_MS, last: now - 600_000 };
  const access = { free, pass: null as string | null, refuse: (day: string, pass: string | null | undefined) => pass == null && day < dayText(free) };
  const asked: { day: string; pass: string | null | undefined }[] = [];
  const h = new LiqHistory((url, pass) => {
    if (url.endsWith('liquidation-history.json')) return Promise.resolve({ edges: EDGES, ...index });
    const day = url.slice(url.lastIndexOf('/') + 1, -'.json'.length);
    asked.push({ day, pass });
    return access.refuse(day, pass) ? Promise.reject(new Error(LIQ_REFUSED)) : Promise.resolve({ rows: [] });
  }, { freeFrom: () => access.free, onSale: () => false, pass: () => access.pass, refused: () => {} });
  h.ensure(from, now, now, () => {}); await tick();
  assert.equal(h.closedBefore(now), null, 'nothing is closed by the page itself');
  h.ensure(from, now, now, () => {}); await tick();
  const paid = Array.from({ length: 6 }, (_, i) => dayText(from - DAY_MS + i * DAY_MS)), newest = dayText(free - DAY_MS);
  assert.deepEqual(asked.filter(a => a.day < dayText(free)).map(a => a.day), [newest], 'only the newest day before the boundary is asked without a pass');
  assert.equal(h.closedBefore(now), free, 'the gate refused it: closed up to it');
  const count = (day: string): number => asked.filter(a => a.day === day).length;
  for (let m = 1; m <= 9; m++) { h.ensure(from, now, now + m * 60_000, () => {}); await tick(); }
  assert.equal(count(newest), 1, 'not asked again within the ten minutes');
  assert.ok(paid.filter(day => day !== newest).every(day => count(day) === 0), 'and the days before it not at all');
  // The hold is over: only the newest refused day is asked again, and the closed stretch stays while it is on its way and after.
  h.ensure(from, now, now + 11 * 60_000, () => {});
  assert.equal(h.closedBefore(now + 11 * 60_000), free, 'no flicker while the day is asked again');
  await tick();
  assert.equal(count(newest), 2);
  assert.ok(paid.filter(day => day !== newest).every(day => count(day) === 0), 'the older ones are not');
  assert.equal(h.closedBefore(now + 11 * 60_000 + 1), free);
  // A member (a key given as a gift, Plus not on sale): every day before the boundary goes with the pass.
  access.pass = 'v1.gift.sig'; h.accessChanged(); asked.length = 0;
  for (let i = 0; i < 3; i++) { h.ensure(from, now, now + 12 * 60_000, () => {}); await tick(); }
  assert.deepEqual(asked.filter(a => a.day < dayText(free)).map(a => a.day).sort(), paid);
  assert.ok(asked.filter(a => a.day < dayText(free)).every(a => a.pass === 'v1.gift.sig'), 'each with the pass');
  assert.ok(asked.filter(a => a.day >= dayText(free)).every(a => a.pass == null), 'a free day without one');
  assert.equal(h.closedBefore(now + 12 * 60_000), null);
});

test('Plus not on sale and no gate in front: the newest day before the boundary goes first, the older ones once it is served', async () => {
  const today = Date.UTC(2026, 10, 17), now = today + 10 * 3_600_000, free = today - 7 * DAY_MS, from = today - 12 * DAY_MS;
  const asked: string[] = [];
  let open = false;
  const h = new LiqHistory(url => {
    if (url.endsWith('liquidation-history.json')) return Promise.resolve({ edges: EDGES, first: today - 20 * DAY_MS, last: now - 600_000 });
    const day = url.slice(url.lastIndexOf('/') + 1, -'.json'.length);
    asked.push(day);
    // The first read of the newest early day fails on the way (no answer): the older ones keep waiting for it.
    return !open && day === dayText(free - DAY_MS) ? Promise.reject(new Error('network')) : Promise.resolve({ rows: [] });
  }, { freeFrom: () => free, onSale: () => false, pass: () => null, refused: () => {} });
  h.ensure(from, now, now, () => {}); await tick();
  h.ensure(from, now, now, () => {}); await tick();
  const early = (): string[] => asked.filter(day => day < dayText(free));
  assert.deepEqual(early(), [dayText(free - DAY_MS)]);
  h.ensure(from, now, now + 30_000, () => {}); await tick();
  assert.deepEqual(early(), [dayText(free - DAY_MS)], 'a failed read holds the older days back');
  open = true;
  h.ensure(from, now, now + 61_000, () => {}); await tick();
  h.ensure(from, now, now + 62_000, () => {}); await tick();
  assert.deepEqual(early().slice(2).sort(), Array.from({ length: 5 }, (_, i) => dayText(from - DAY_MS + i * DAY_MS)), 'then every older day of the view');
  assert.equal(h.closedBefore(now + 62_000), null);
});

test('Plus: a gate that refuses every pass is asked one day per new pass, not every paid day at once', async () => {
  const today = Date.UTC(2026, 10, 17), now = today + 10 * 3_600_000, free = today - 7 * DAY_MS, from = today - 60 * DAY_MS;
  const access = { free, pass: 'v1.p0.sig' as string | null };
  // The same object, so each new pass below is the one the history reads.
  const { h, asked, refusals } = gated(Object.assign(access, { refuse: (_day: string, pass: string | null | undefined) => pass != null }), { first: today - 90 * DAY_MS, last: now - 600_000 });
  const withPass = (): number => asked.filter(a => a.pass != null).length;
  for (let i = 0; i < 3; i++) { h.ensure(from, now, now, () => {}); await tick(); }
  assert.equal(withPass(), 1, 'one paid day, refused: no other is asked with that pass');
  assert.equal(refusals(), 1);
  // Each renewal brings a pass the gate refuses again: one request each.
  for (let g = 1; g <= 5; g++) {
    access.pass = `v1.p${g}.sig`; h.accessChanged();
    for (let i = 0; i < 3; i++) { h.ensure(from, now, now + g * 60_000, () => {}); await tick(); }
  }
  assert.equal(withPass(), 6, `${withPass()} requests with a pass for six passes`);
  assert.equal(asked.filter(a => a.pass != null).every(a => a.day === dayText(free - DAY_MS)), true, 'always the newest closed day');
});

test('Plus: a paid day the service has no file for (a 404) counts as answered: the other paid days follow, and it waits ten minutes', async () => {
  const today = Date.UTC(2026, 10, 17), now = today + 10 * 3_600_000, free = today - 7 * DAY_MS, from = today - 12 * DAY_MS;
  const newest = dayText(free - DAY_MS);
  const { h, asked } = gated({ free, pass: 'v1.member.sig', why: '404', refuse: day => day === newest }, { first: today - 20 * DAY_MS, last: now - 600_000 });
  const paid = (): string[] => asked.filter(a => a.pass != null).map(a => a.day);
  for (let i = 0; i < 3; i++) { h.ensure(from, now, now, () => {}); await tick(); }
  assert.equal(paid()[0], newest, 'the newest paid day goes first');
  assert.deepEqual(paid().slice(1).sort(), Array.from({ length: 5 }, (_, i) => dayText(from - DAY_MS + i * DAY_MS)), 'its 404 opens the rest');
  for (let m = 1; m <= 9; m++) { h.ensure(from, now, now + m * 60_000, () => {}); await tick(); }
  assert.equal(paid().filter(day => day === newest).length, 1, 'the missing day is not asked again within ten minutes');
  h.ensure(from, now, now + 10 * 60_000 + 1_000, () => {}); await tick();
  assert.equal(paid().filter(day => day === newest).length, 2, 'then it is');
});

test('Plus: a 5xx or no answer for the first paid day keeps the others waiting, a minute at a time', async () => {
  const today = Date.UTC(2026, 10, 17), now = today + 10 * 3_600_000, free = today - 7 * DAY_MS, from = today - 12 * DAY_MS;
  const newest = dayText(free - DAY_MS);
  const { h, asked } = gated({ free, pass: 'v1.member.sig', why: '502', refuse: day => day === newest }, { first: today - 20 * DAY_MS, last: now - 600_000 });
  for (let i = 0; i < 3; i++) { h.ensure(from, now, now, () => {}); await tick(); }
  h.ensure(from, now, now + 61_000, () => {}); await tick();
  assert.deepEqual(asked.filter(a => a.pass != null).map(a => a.day), [newest, newest], 'only the newest, once a minute');
});

test('Plus not on sale: a newest early day the service has no file for (a 404) lets the older days be asked', async () => {
  const today = Date.UTC(2026, 10, 17), now = today + 10 * 3_600_000, free = today - 7 * DAY_MS, from = today - 12 * DAY_MS;
  const asked: string[] = [];
  const h = new LiqHistory(url => {
    if (url.endsWith('liquidation-history.json')) return Promise.resolve({ edges: EDGES, first: today - 20 * DAY_MS, last: now - 600_000 });
    const day = url.slice(url.lastIndexOf('/') + 1, -'.json'.length);
    asked.push(day);
    return day === dayText(free - DAY_MS) ? Promise.reject(new Error('404')) : Promise.resolve({ rows: [] });
  }, { freeFrom: () => free, onSale: () => false, pass: () => null, refused: () => {} });
  for (let i = 0; i < 3; i++) { h.ensure(from, now, now, () => {}); await tick(); }
  const early = asked.filter(day => day < dayText(free));
  assert.equal(early[0], dayText(free - DAY_MS));
  assert.deepEqual(early.slice(1).sort(), Array.from({ length: 5 }, (_, i) => dayText(from - DAY_MS + i * DAY_MS)));
  assert.equal(h.closedBefore(now), null, 'a 404 closes nothing');
});

test('Plus: a refusal not believed waits ten minutes like a believed one, not a minute', async () => {
  const today = Date.UTC(2026, 10, 17), now = today + 10 * 3_600_000, free = today - 7 * DAY_MS, from = today - 2 * DAY_MS;
  // The page's clock is three days behind the server's: the server refuses a day the page calls three days inside the free week.
  const { h, asked } = gated({ free, pass: null, refuse: day => day <= dayText(free + 4 * DAY_MS) }, { first: today - 20 * DAY_MS, last: now - 600_000 });
  const count = (): number => asked.filter(a => a.day === dayText(from - DAY_MS)).length;
  h.ensure(from, now, now, () => {}); await tick();
  h.ensure(from, now, now, () => {}); await tick();
  assert.equal(count(), 1);
  assert.equal(h.closedBefore(now), free, 'not believed: nothing more is closed');
  for (let m = 1; m <= 9; m++) { h.ensure(from, now, now + m * 60_000, () => {}); await tick(); }
  assert.equal(count(), 1, 'not asked again each minute');
  h.ensure(from, now, now + 10 * 60_000 + 1_000, () => {}); await tick();
  assert.equal(count(), 2, 'asked again after ten minutes');
});
