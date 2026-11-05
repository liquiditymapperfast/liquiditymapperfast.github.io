import test from 'node:test';
import assert from 'node:assert/strict';
import { LT_LENGTH } from '../src/shared/lt-sample.ts';
import type { ColumnSet, ColumnsFrame } from '../src/shared/columns.ts';
import { ArchiveColumns, MISSING_FRESH_MS, RETRY_MS, rebin, type TileFetch } from '../src/app/archive/archive-source.ts';
import { headUrl, packMs, packStartOf, packUrl, type TilesInfo } from '../src/app/archive/tiles.ts';
import { encodeTile, type EncColumn } from './archive-encoder.mts';

const MIN = 60_000, BASE = 'https://history.test/v1/btc', SPAN = 32768;
const T0 = Date.UTC(2026, 10, 5);

/** Files served by URL: bytes, a status, or a failure; every request is counted. */
function server(files: Map<string, ArrayBuffer | number | 'fail'>): { fetch: TileFetch; asked: string[] } {
  const asked: string[] = [];
  const fetch: TileFetch = async url => {
    asked.push(url);
    const f = files.get(url);
    if (f === 'fail') throw new Error('network');
    if (f === undefined || typeof f === 'number') return { ok: false, status: typeof f === 'number' ? f : 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => f.slice(0) };
  };
  return { fetch, asked };
}
/** The next `onChange`, or a failure after a second. */
const changed = (a: ArchiveColumns): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no change')), 1_500);
  a.onChange = () => { clearTimeout(timer); resolve(); };
});
const col = (index: number, step = 20, extra: Partial<EncColumn> = {}): EncColumn => ({ index, n: 100 + index, step, bins: [3900, 3901 + index % 3], bid: [1_000 + index, 50_000], ask: [2_000, 75_000 + index], ...extra });
function engineSet(id: string, step: number, times: number[]): ColumnSet {
  const bins = new Int32Array(times.length * 2), bid = new Float32Array(times.length * 2), ask = new Float32Array(times.length * 2);
  times.forEach((_, k) => { bins.set([3900, 3910], k * 2); bid.set([9, 9], k * 2); ask.set([9, 9], k * 2); });
  return { id, step, times, counts: times.map(() => 2), samples: times.map(() => 12), bins, bid, ask };
}
const frame = (stepMs: number, from: number, to: number, sets: ColumnSet[]): ColumnsFrame => ({ from, to, stepMs, instruments: sets });
const info = (through: number, first = T0 - 400 * 86_400_000): TilesInfo => ({ v: 1, levels: [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096], packSpan: SPAN, through, first });

test('the engine answer goes out at once; the packs come meanwhile, and then each window has one owner', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const pack = encodeTile({ level: L, packStart: P, windows: 128, through: P + 2 * len, books: [['a', Array.from({ length: 128 }, (_, i) => col(i))]] });
  const { fetch, asked } = server(new Map([[packUrl(BASE, L, P), pack]]));
  const archive = new ArchiveColumns(BASE, fetch);
  archive.setInfo(info(P + 2 * len));
  // The engine's day begins inside window 100: its first window holds part of its minutes.
  const W0 = P + 100 * step, engine = frame(step, P, P + len, [engineSet('a', 20, [W0, W0 + step, W0 + 2 * step])]);
  const come = changed(archive);
  const first = archive.extend(engine, P, P + len, step);
  assert.equal(first, engine, 'nothing held yet: the engine answer as it was');
  await come;
  assert.deepEqual(asked, [packUrl(BASE, L, P)]);
  const out = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.equal(out.step, 20);
  assert.equal(out.times.length, 101 + 2, 'windows 0-100 from the pack (100 replaces the engine part-window), then the engine from E');
  assert.deepEqual(out.times.slice(0, 2), [P, P + step]);
  assert.deepEqual(out.times.slice(-3), [W0, W0 + step, W0 + 2 * step]);
  assert.equal(new Set(out.times).size, out.times.length, 'never two answers for one window');
  assert.equal(out.samples[100], 200, 'window 100 is the archive one');
  assert.equal(out.samples[101], 12, 'and the engine from E on');
  assert.equal(out.counts.reduce((s, c) => s + c, 0), out.bins.length);
  assert.ok(Math.abs(out.bid[0]! / 1_000 - 1) < 0.005);
  // Each answer is decoded afresh: arrays handed to the worker are not the ones held.
  const again = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.notEqual(again.bins.buffer, out.bins.buffer);
});

test('a question the engine answers from its start (a refresh, a view inside its day) asks nothing of the archive', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const { fetch, asked } = server(new Map());
  const archive = new ArchiveColumns(BASE, fetch);
  archive.setInfo(info(P + 2 * len));
  // A refresh from where the held columns settled: the engine has that window.
  const from = P + 50 * step, engine = frame(step, from, from + 3 * step, [engineSet('a', 20, [from, from + step])]);
  assert.equal(archive.extend(engine, from, from + 3 * step, step), engine);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(asked, []);
});

test('the engine keeps its first window when the archive has none for it', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const pack = encodeTile({ level: L, packStart: P, windows: 128, through: P + 2 * len, books: [['a', Array.from({ length: 100 }, (_, i) => col(i))]] });
  const archive = new ArchiveColumns(BASE, server(new Map([[packUrl(BASE, L, P), pack]])).fetch);
  archive.setInfo(info(P + 2 * len));
  const W0 = P + 100 * step, engine = frame(step, P, P + len, [engineSet('a', 20, [W0, W0 + step])]);
  const come = changed(archive); archive.extend(engine, P, P + len, step); await come;
  const out = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.deepEqual(out.times.slice(-3), [W0 - step, W0, W0 + step]);
  assert.equal(out.samples[out.times.indexOf(W0)], 12);
});

test('a window wider than the page\'s day, under way, is the head\'s as far as the service has folded hours', async () => {
  const L = 2048, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const through = P + 5 * step + 30 * MIN;
  const head = encodeTile({ level: L, packStart: P, windows: 16, head: true, through, books: [['a', [...[0, 1, 2, 3, 4].map(i => col(i)), col(5, 20, { open: true })]]] });
  const archive = new ArchiveColumns(BASE, server(new Map([[headUrl(BASE, L), head]])).fetch);
  archive.setInfo(info(through));
  // The engine's day lies inside window 5.
  const engine = frame(step, P, P + len, [engineSet('a', 20, [P + 5 * step])]);
  const come = changed(archive); archive.extend(engine, P, P + len, step); await come;
  const out = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.deepEqual(out.times, [0, 1, 2, 3, 4, 5].map(i => P + i * step));
  assert.equal(out.samples[5], 105, 'the open window is the head\'s, not the engine\'s part of it');
});

test('a head from a later pack says this one is complete; one from an earlier pack is not used', async () => {
  const L = 32, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const later = encodeTile({ level: L, packStart: P + len, windows: 128, head: true, through: P + len + 3 * step, books: [['a', [col(0)]]] });
  const pack = encodeTile({ level: L, packStart: P, windows: 128, through: P + len, books: [['a', [col(7)]]] });
  const { fetch, asked } = server(new Map<string, ArrayBuffer>([[headUrl(BASE, L), later], [packUrl(BASE, L, P), pack]]));
  const archive = new ArchiveColumns(BASE, fetch);
  // Read when pack P was still the open one.
  archive.setInfo(info(P + 10 * step));
  const engine = frame(step, P, P + len, [engineSet('a', 20, [])]);
  let come = changed(archive); archive.extend(engine, P, P + len, step); await come;
  come = changed(archive); archive.extend(engine, P, P + len, step); await come;
  assert.deepEqual(asked, [headUrl(BASE, L), packUrl(BASE, L, P)]);
  const out = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.deepEqual(out.times, [P + 7 * step]);
  assert.ok(archive.info!.through >= P + len + 3 * step, 'the head moved the watermark on');
  // A head of an earlier pack (a cache's copy from before the rollover) is not this pack's.
  const old = encodeTile({ level: L, packStart: P - len, windows: 128, head: true, through: P - 1, books: [['a', [col(1)]]] });
  const stale = new ArchiveColumns(BASE, server(new Map([[headUrl(BASE, L), old]])).fetch);
  stale.setInfo(info(P + 10 * step));
  come = changed(stale); stale.extend(engine, P, P + len, step); await come;
  assert.equal(stale.extend(engine, P, P + len, step).instruments[0]!.times.length, 0);
});

test('a window on another grid is shared out on the frame\'s, the dollars kept', () => {
  const c = { bins: Int32Array.from([3900, 3901, 3902, 3905]), bid: Float32Array.from([100, 200, 300, 400]), ask: Float32Array.from([10, 0, 30, 5]), step: 20 };
  const to50 = rebin(c, 50), to10 = rebin(c, 10);
  const sum = (a: Float32Array): number => a.reduce((s, v) => s + v, 0);
  for (const r of [to50, to10]) { assert.ok(Math.abs(sum(r.bid) - 1_000) < 1e-3); assert.ok(Math.abs(sum(r.ask) - 45) < 1e-3); }
  // $78,000-78,020 is bin 1560 at $50; $78,040-78,060 straddles 1560 and 1561; $78,100-78,120 is 1562.
  assert.deepEqual([...to50.bins], [1560, 1561, 1562]);
  assert.ok(Math.abs(to50.bid[0]! - (100 + 200 + 300 / 2)) < 1e-3 && Math.abs(to50.bid[1]! - 150) < 1e-3 && Math.abs(to50.bid[2]! - 400) < 1e-3);
  assert.equal(to10.bins.length, 8);
  assert.ok([...to10.bins].every((b, i) => i === 0 || b > to10.bins[i - 1]!));
});

test('archive windows on another grid than the engine\'s are drawn on the engine\'s', async () => {
  const L = 8, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const pack = encodeTile({ level: L, packStart: P, windows: 128, through: P + len, books: [['a', [col(0, 50)]]] });
  const archive = new ArchiveColumns(BASE, server(new Map([[packUrl(BASE, L, P), pack]])).fetch);
  archive.setInfo(info(P + len));
  const engine = frame(step, P, P + len, [engineSet('a', 20, [P + 10 * step])]);
  const come = changed(archive); archive.extend(engine, P, P + len, step); await come;
  const out = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.equal(out.step, 20);
  const first = out.counts[0]!, bids = out.bid.subarray(0, first);
  assert.ok(Math.abs(bids.reduce((s, v) => s + v, 0) - (1_000 + 50_000)) / 51_000 < 0.006);
});

test('the tracker comes only where the window kept it over every sample', async () => {
  const L = 8, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const lt = Array.from({ length: LT_LENGTH }, (_, i) => 0.25 + i);
  const pack = encodeTile({ level: L, packStart: P, windows: 128, through: P + len, books: [['a', [col(0, 20, { ltN: 100, lt }), col(1, 20, { ltN: 40, lt })]]] });
  const archive = new ArchiveColumns(BASE, server(new Map([[packUrl(BASE, L, P), pack]])).fetch);
  archive.setInfo(info(P + len));
  const engine = frame(step, P, P + len, [engineSet('a', 20, [])]);
  const come = changed(archive); archive.extend(engine, P, P + len, step); await come;
  const out = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.ok(out.lt);
  assert.equal(out.lt![0], 0.25, 'window 0 (ltN = n) has its tracker, under one included');
  assert.ok(Number.isNaN(out.lt![LT_LENGTH]!), 'window 1 kept it over 40 of 101 samples: none');
});

test('a file that fails is tried again later, never held as empty; a missing pack is held as none for ten minutes', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const pack = encodeTile({ level: L, packStart: P, windows: 128, through: P + 2 * len, books: [['a', [col(3)]]] });
  const files = new Map<string, ArrayBuffer | number | 'fail'>([[packUrl(BASE, L, P), 'fail'], [packUrl(BASE, L, P + len), 404]]);
  const { fetch, asked } = server(files);
  let now = T0;
  const archive = new ArchiveColumns(BASE, fetch, () => now);
  archive.setInfo(info(P + 2 * len));
  const engine = frame(step, P, P + 2 * len, [engineSet('a', 20, [])]);
  archive.extend(engine, P, P + 2 * len, step);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(asked.length, 2);
  assert.equal(archive.heldBytes, 0);
  // Before its next try, the failed file is not asked again; the missing one is held as none.
  archive.extend(engine, P, P + 2 * len, step);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(asked.length, 2);
  files.set(packUrl(BASE, L, P), pack);
  now += RETRY_MS[0]! + 1;
  const come = changed(archive);
  archive.extend(engine, P, P + 2 * len, step);
  await come;
  assert.equal(asked.length, 3);
  assert.deepEqual(archive.extend(engine, P, P + 2 * len, step).instruments[0]!.times, [P + 3 * step]);
  now += MISSING_FRESH_MS + 1;
  archive.extend(engine, P, P + 2 * len, step);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(asked.filter(u => u === packUrl(BASE, L, P + len)).length, 2, 'the missing pack is asked again after ten minutes');
});

test('the bytes held stay within the budget, the least recently used going first', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const files = new Map<string, ArrayBuffer>();
  for (let k = 0; k < 3; k++) files.set(packUrl(BASE, L, P + k * len), encodeTile({ level: L, packStart: P + k * len, windows: 128, through: P + 3 * len, books: [['a', Array.from({ length: 40 }, (_, i) => col(i))]] }));
  const size = files.get(packUrl(BASE, L, P))!.byteLength;
  const { fetch, asked } = server(files);
  const archive = new ArchiveColumns(BASE, fetch, Date.now, size * 2 + 10);
  archive.setInfo(info(P + 3 * len));
  const engine = frame(step, P, P + 3 * len, [engineSet('a', 20, [])]);
  const come = changed(archive); archive.extend(engine, P, P + 3 * len, step); await come;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(archive.heldBytes <= size * 2 + 10);
  assert.equal(asked.length, 3);
  // The first pack went: asking for it again fetches it.
  archive.extend(frame(step, P, P + len, [engineSet('a', 20, [])]), P, P + len, step);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(asked.length, 4);
});

test('the engine\'s answer passes as it is where the archive has no say', () => {
  const archive = new ArchiveColumns(BASE, server(new Map()).fetch);
  const one = frame(MIN, T0, T0 + 60 * MIN, [engineSet('a', 20, [T0])]);
  assert.equal(archive.extend(one, T0, T0 + 60 * MIN, MIN), one, 'no tiles known');
  archive.setInfo(info(T0));
  assert.equal(archive.extend(one, T0, T0 + 60 * MIN, MIN), one, 'a minute is the hour files\' own');
  const odd = frame(3 * MIN, T0, T0 + 60 * MIN, [engineSet('a', 20, [T0])]);
  assert.equal(archive.extend(odd, T0, T0 + 60 * MIN, 3 * MIN), odd, 'a step the service does not build');
  assert.equal(new ArchiveColumns('', server(new Map()).fetch).extend(one, T0, T0 + 60 * MIN, 2 * MIN), one, 'no service');
});
