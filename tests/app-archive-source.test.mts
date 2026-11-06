import test from 'node:test';
import assert from 'node:assert/strict';
import { LT_LENGTH } from '../src/shared/lt-sample.ts';
import type { ColumnSet, ColumnsFrame } from '../src/shared/columns.ts';
import { ArchiveColumns, FETCH_DEADLINE_MS, HEAD_FRESH_MS, MAX_FILE_BYTES, MAX_REBIN_BINS, MISSING_FRESH_MS, RETRY_MS, depthSinceOf, rebin, type ArchiveChange, type Schedule, type TileFetch, type TileResponse } from '../src/app/archive/archive-source.ts';
import { headUrl, packMs, packStartOf, packUrl, type TilesInfo } from '../src/app/archive/tiles.ts';
import { columnStepFor } from '../src/app/column-holds.ts';
import { encodeTile, type EncColumn } from './archive-encoder.mts';

const MIN = 60_000, HOUR = 3_600_000, BASE = 'https://history.test/v1/btc', SPAN = 32768;
const T0 = Date.UTC(2026, 10, 5);

type Served = ArrayBuffer | number | 'fail' | 'hang' | { bytes: ArrayBuffer; length: number };
/** Files served by URL: bytes, a status, a failure, a request that never answers, or one announcing its length; every request counted. */
function server(files: Map<string, Served>): { fetch: TileFetch; asked: string[] } {
  const asked: string[] = [];
  const fetch: TileFetch = async url => {
    asked.push(url);
    const f = files.get(url);
    if (f === 'fail') throw new Error('network');
    if (f === 'hang') return new Promise<TileResponse>(() => undefined);
    if (f === undefined || typeof f === 'number') return { ok: false, status: typeof f === 'number' ? f : 404, arrayBuffer: async () => new ArrayBuffer(0) };
    if (!(f instanceof ArrayBuffer)) return { ok: true, status: 200, headers: { get: (n: string) => n === 'content-length' ? String(f.length) : null }, arrayBuffer: async () => f.bytes.slice(0) };
    return { ok: true, status: 200, arrayBuffer: async () => f.slice(0) };
  };
  return { fetch, asked };
}
/** Timers run by hand: `fire(ms)` runs every timer due within `ms` of now (in order), as if that much time had passed. */
function clock(start = T0): { now: () => number; schedule: Schedule; advance: (ms: number) => void } {
  let now = start;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    schedule: (run, ms) => { const timer = { at: now + ms, run, live: true }; timers.push(timer); return () => { timer.live = false; }; },
    advance: ms => {
      now += ms;
      for (const timer of timers.filter(t => t.live && t.at <= now).sort((a, b) => a.at - b.at)) { timer.live = false; timer.run(); }
    },
  };
}
const settle = (ms = 20): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
/** The next `onChange`, or a failure after a second and a half. */
const changed = (a: ArchiveColumns): Promise<ArchiveChange> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no change')), 1_500);
  a.onChange = change => { clearTimeout(timer); resolve(change); };
});
/** A window of 24 samples (any level holds that many: 2 minutes hold up to 36). */
const col = (index: number, step = 20, extra: Partial<EncColumn> = {}): EncColumn => ({ index, n: 24, step, bins: [3900, 3901 + index % 3], bid: [1_000 + index, 50_000], ask: [2_000, 75_000 + index], ...extra });
function engineSet(id: string, step: number, times: number[]): ColumnSet {
  const bins = new Int32Array(times.length * 2), bid = new Float32Array(times.length * 2), ask = new Float32Array(times.length * 2);
  times.forEach((_, k) => { bins.set([3900, 3910], k * 2); bid.set([9, 9], k * 2); ask.set([9, 9], k * 2); });
  return { id, step, times, counts: times.map(() => 2), samples: times.map(() => 12), bins, bid, ask };
}
/** An engine answer: its columns, and where each book's own run of minutes begins (`since`). */
const frame = (stepMs: number, from: number, to: number, sets: ColumnSet[], since: Record<string, number>): ColumnsFrame => ({ from, to, stepMs, instruments: sets, since });
const info = (through: number, first = T0 - 400 * 86_400_000): TilesInfo => ({ v: 1, levels: [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096], packSpan: SPAN, through, first });

test('the engine answer goes out at once; the packs come meanwhile, and then each window has one owner', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const pack = encodeTile({ level: L, packStart: P, windows: 128, through: P + 2 * len, books: [['a', Array.from({ length: 128 }, (_, i) => col(i))]] });
  const { fetch, asked } = server(new Map([[packUrl(BASE, L, P), pack]]));
  const archive = new ArchiveColumns(BASE, fetch);
  archive.setInfo(info(P + 2 * len));
  await changed(archive);
  // The engine's own minutes begin 3 minutes into window 100: that window is the archive's, the next ones the engine's.
  const W0 = P + 100 * step, engine = frame(step, P, P + len, [engineSet('a', 20, [W0, W0 + step, W0 + 2 * step])], { a: W0 + 3 * MIN });
  const come = changed(archive);
  assert.equal(archive.extend(engine, P, P + len, step), engine, 'nothing held yet: the engine answer as it was');
  const change = await come;
  assert.deepEqual(change, { level: L, from: P, to: P + len }, 'the arrival names its range');
  assert.deepEqual(asked, [packUrl(BASE, L, P)]);
  const out = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.equal(out.step, 20);
  assert.equal(out.times.length, 101 + 2, 'windows 0-100 from the pack (100 replaces the engine part-window), then the engine from E');
  assert.deepEqual(out.times.slice(-3), [W0, W0 + step, W0 + 2 * step]);
  assert.equal(new Set(out.times).size, out.times.length, 'never two answers for one window');
  assert.equal(out.samples[100], 24, 'window 100 is the archive one');
  assert.equal(out.samples[101], 12, 'and the engine from E on');
  assert.equal(out.counts.reduce((s, c) => s + c, 0), out.bins.length);
  const again = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.notEqual(again.bins.buffer, out.bins.buffer, 'decoded afresh for each answer');
});

test('a refresh and a whole question give each window the same owner (the head\'s window under way stays the archive\'s)', async () => {
  const L = 2048, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const through = P + 5 * step + 30 * MIN;
  const head = encodeTile({ level: L, packStart: P, windows: 16, head: true, through, books: [['a', [...[0, 1, 2, 3, 4].map(i => col(i)), col(5, 20, { open: true, n: 995 })]]] });
  const archive = new ArchiveColumns(BASE, server(new Map([[headUrl(BASE, L), head]])).fetch);
  archive.setInfo(info(through));
  await changed(archive);
  // The engine holds the last day: a part of window 5 (Sol's case: the refresh drew $9 of it in place of the head's window).
  const since = P + 5 * step + 20 * HOUR, now = since + 24 * HOUR;
  const whole = frame(step, P, P + len, [engineSet('a', 20, [P + 5 * step])], { a: since });
  const come = changed(archive); archive.extend(whole, P, P + len, step); await come;
  const a = archive.extend(whole, P, P + len, step).instruments[0]!;
  assert.deepEqual(a.times, [0, 1, 2, 3, 4, 5].map(i => P + i * step));
  assert.equal(a.samples[5], 995, 'the window under way is the head\'s');
  // A refresh from where the held windows settled (the start of window 5): the same owner.
  const tail = frame(step, P + 5 * step, now, [engineSet('a', 20, [P + 5 * step])], { a: since });
  const b = archive.extend(tail, P + 5 * step, now, step).instruments[0]!;
  assert.deepEqual(b.times, [P + 5 * step]);
  assert.equal(b.samples[0], 995, 'the refresh keeps the head\'s window, not the engine\'s part of it');
});

test('a refresh of the engine\'s own day asks nothing of the archive', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const { fetch, asked } = server(new Map());
  const archive = new ArchiveColumns(BASE, fetch);
  archive.setInfo(info(P + 2 * len));
  const from = P + 50 * step, engine = frame(step, from, from + 3 * step, [engineSet('a', 20, [from, from + step])], { a: P + 20 * step });
  assert.equal(archive.extend(engine, from, from + 3 * step, step), engine);
  await settle();
  assert.deepEqual(asked, []);
});

test('the engine\'s windows are drawn where the archive has none (not fetched yet, or none at all)', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const pack = encodeTile({ level: L, packStart: P, windows: 128, through: P + 2 * len, books: [['a', Array.from({ length: 100 }, (_, i) => col(i))]] });
  const archive = new ArchiveColumns(BASE, server(new Map([[packUrl(BASE, L, P), pack]])).fetch);
  archive.setInfo(info(P + 2 * len));
  const W0 = P + 100 * step, engine = frame(step, P, P + len, [engineSet('a', 20, [W0, W0 + step])], { a: W0 + 3 * MIN });
  const come = changed(archive);
  assert.deepEqual(archive.extend(engine, P, P + len, step).instruments[0]!.times, [W0, W0 + step], 'before the pack comes: the engine\'s');
  await come;
  const out = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.deepEqual(out.times.slice(-3), [W0 - step, W0, W0 + step]);
  assert.equal(out.samples[out.times.indexOf(W0)], 12, 'window 100 is not in the pack: the engine\'s');
});

test('a gap in the engine near now leaves the archive its watermark, the engine the rest', async () => {
  const L = 2, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const through = P + 60 * step;
  const head = encodeTile({ level: L, packStart: P, windows: 128, head: true, through, books: [['a', Array.from({ length: 60 }, (_, i) => col(i))]] });
  const archive = new ArchiveColumns(BASE, server(new Map([[headUrl(BASE, L), head]])).fetch);
  archive.setInfo(info(through));
  await changed(archive);
  // The engine's newest run starts after the watermark (a gap near now); it holds windows 50-79 and 90-99.
  const times = [...Array.from({ length: 30 }, (_, i) => P + (50 + i) * step), ...Array.from({ length: 10 }, (_, i) => P + (90 + i) * step)];
  const engine = frame(step, P, P + len, [engineSet('a', 20, times)], { a: P + 90 * step });
  const come = changed(archive); archive.extend(engine, P, P + len, step); await come;
  const out = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.equal(out.times.filter(t => t < through).length, 60, 'windows to the watermark from the head');
  assert.ok(out.samples.slice(0, 60).every(n => n === 24));
  assert.deepEqual(out.times.slice(60), times.filter(t => t >= through), 'after it, the engine\'s, its gap included');
});

test('a head from a later pack says this one is complete; one from an earlier pack is not used', async () => {
  const L = 32, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const later = encodeTile({ level: L, packStart: P + len, windows: 128, head: true, through: P + len + 3 * step, books: [['a', [col(0)]]] });
  const pack = encodeTile({ level: L, packStart: P, windows: 128, through: P + len, books: [['a', [col(7)]]] });
  const { fetch, asked } = server(new Map<string, Served>([[headUrl(BASE, L), later], [packUrl(BASE, L, P), pack]]));
  const archive = new ArchiveColumns(BASE, fetch);
  archive.setInfo(info(P + 10 * step));
  await changed(archive);
  const engine = frame(step, P, P + len, [engineSet('a', 20, [])], { a: Infinity });
  let come = changed(archive); archive.extend(engine, P, P + len, step);
  assert.deepEqual(await come, { level: L, from: P, to: P + 2 * len }, 'the head\'s arrival names the pack it was asked for (complete now) with its own');
  assert.ok(archive.info!.through >= P + len + 3 * step, 'and moves the watermark on at once');
  come = changed(archive); archive.extend(engine, P, P + len, step); await come;
  assert.deepEqual(asked, [headUrl(BASE, L), packUrl(BASE, L, P)]);
  assert.deepEqual(archive.extend(engine, P, P + len, step).instruments[0]!.times, [P + 7 * step]);
  assert.ok(archive.info!.through >= P + len + 3 * step, 'the head moved the watermark on');
  const old = encodeTile({ level: L, packStart: P - len, windows: 128, head: true, through: P - 1, books: [['a', [col(1)]]] });
  const stale = new ArchiveColumns(BASE, server(new Map([[headUrl(BASE, L), old]])).fetch);
  stale.setInfo(info(P + 10 * step));
  await changed(stale);
  stale.extend(engine, P, P + len, step); await settle(50);
  assert.equal(stale.extend(engine, P, P + len, step).instruments[0]!.times.length, 0);
});

test('rebin keeps the dollars, and ends for any grids, giving nothing for grids too far apart', () => {
  const c = { bins: Int32Array.from([3900, 3901, 3902, 3905]), bid: Float32Array.from([100, 200, 300, 400]), ask: Float32Array.from([10, 0, 30, 5]), step: 20 };
  const sum = (a: Float32Array): number => a.reduce((s, v) => s + v, 0);
  for (const r of [rebin(c, 50), rebin(c, 10)]) { assert.ok(Math.abs(sum(r.bid) - 1_000) < 1e-3); assert.ok(Math.abs(sum(r.ask) - 45) < 1e-3); }
  assert.deepEqual([...rebin(c, 50).bins], [1560, 1561, 1562]);
  for (const [s0, s1] of [[1e308, 20], [20, 1e-300], [20, 0], [Number.NaN, 20], [20, Infinity], [1e6, 1e-3]]) {
    const r = rebin({ ...c, step: s0! }, s1!);
    assert.equal(r.bins.length, 0, `${s0} -> ${s1}`);
  }
  // Wide but allowed ratios stay bounded.
  const many = { bins: Int32Array.from({ length: 5_000 }, (_, i) => i * 3), bid: new Float32Array(5_000).fill(1), ask: new Float32Array(5_000).fill(1), step: 500 };
  const r = rebin(many, 1);
  assert.ok(r.bins.length <= MAX_REBIN_BINS);
});

test('archive windows on another grid than the engine\'s are drawn on the engine\'s', async () => {
  const L = 8, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const pack = encodeTile({ level: L, packStart: P, windows: 128, through: P + len, books: [['a', [col(0, 50)]]] });
  const archive = new ArchiveColumns(BASE, server(new Map([[packUrl(BASE, L, P), pack]])).fetch);
  archive.setInfo(info(P + len));
  await changed(archive);
  const engine = frame(step, P, P + len, [engineSet('a', 20, [P + 10 * step])], { a: P + 10 * step });
  const come = changed(archive); archive.extend(engine, P, P + len, step); await come;
  const out = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.equal(out.step, 20);
  assert.ok(Math.abs(out.bid.subarray(0, out.counts[0]!).reduce((s, v) => s + v, 0) - 51_000) / 51_000 < 0.006);
});

test('the tracker comes only where the window kept it over every sample', async () => {
  const L = 8, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const lt = Array.from({ length: LT_LENGTH }, (_, i) => 0.25 + i);
  const pack = encodeTile({ level: L, packStart: P, windows: 128, through: P + len, books: [['a', [col(0, 20, { n: 100, ltN: 100, lt }), col(1, 20, { n: 101, ltN: 40, lt })]]] });
  const archive = new ArchiveColumns(BASE, server(new Map([[packUrl(BASE, L, P), pack]])).fetch);
  archive.setInfo(info(P + len));
  await changed(archive);
  const engine = frame(step, P, P + len, [engineSet('a', 20, [])], { a: Infinity });
  const come = changed(archive); archive.extend(engine, P, P + len, step); await come;
  const out = archive.extend(engine, P, P + len, step).instruments[0]!;
  assert.equal(out.lt![0], 0.25);
  assert.ok(Number.isNaN(out.lt![LT_LENGTH]!));
});

test('a file that fails is tried again on a timer while the view needs it, never held as empty', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const pack = encodeTile({ level: L, packStart: P, windows: 128, through: P + 2 * len, books: [['a', [col(3)]]] });
  const files = new Map<string, Served>([[packUrl(BASE, L, P), 'fail']]);
  const { fetch, asked } = server(files), c = clock();
  const archive = new ArchiveColumns(BASE, fetch, c.now, undefined, c.schedule);
  archive.setInfo(info(P + 2 * len));
  await changed(archive);
  archive.view(step, [{ from: P, to: P + len }]);
  const engine = frame(step, P, P + len, [engineSet('a', 20, [])], { a: Infinity });
  archive.extend(engine, P, P + len, step); await settle();
  assert.equal(asked.length, 1); assert.equal(archive.heldBytes, 0);
  archive.extend(engine, P, P + len, step); await settle();
  assert.equal(asked.length, 1, 'not again before its next try');
  files.set(packUrl(BASE, L, P), pack);
  const come = changed(archive);
  c.advance(RETRY_MS[0]! + 100);
  assert.deepEqual(await come, { level: L, from: P, to: P + len }, 'tried again on its own, and its range said');
  assert.equal(asked.length, 2);
});

test('a missing pack and a head are asked again when they go stale, if the view still needs them', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const files = new Map<string, Served>([[packUrl(BASE, L, P), 404], [headUrl(BASE, L), encodeTile({ level: L, packStart: P + len, windows: 128, head: true, through: P + len + step, books: [['a', [col(0)]]] })]]);
  const { fetch, asked } = server(files), c = clock();
  const archive = new ArchiveColumns(BASE, fetch, c.now, undefined, c.schedule);
  archive.setInfo(info(P + len + step));
  await changed(archive);
  archive.view(step, [{ from: P, to: P + 2 * len }]);
  const engine = frame(step, P, P + 2 * len, [engineSet('a', 20, [])], { a: Infinity });
  archive.extend(engine, P, P + 2 * len, step); await settle();
  assert.equal(asked.filter(u => u === packUrl(BASE, L, P)).length, 1);
  assert.equal(asked.filter(u => u === headUrl(BASE, L)).length, 1);
  files.set(packUrl(BASE, L, P), encodeTile({ level: L, packStart: P, windows: 128, through: P + len, books: [['a', [col(2)]]] }));
  const come = changed(archive);
  c.advance(MISSING_FRESH_MS + 100); await settle();
  assert.equal(asked.filter(u => u === packUrl(BASE, L, P)).length, 2, 'the missing pack, asked again with no question from the page');
  assert.ok(asked.filter(u => u === headUrl(BASE, L)).length >= 2, 'and the head');
  assert.deepEqual(await come, { level: L, from: P, to: P + 2 * len });
  assert.equal(HEAD_FRESH_MS, 10 * MIN);
  // A view that moved elsewhere no longer needs them: no more asks.
  archive.view(step, [{ from: P - 4 * len, to: P - 3 * len }]);
  const before = asked.filter(u => u === headUrl(BASE, L)).length;
  c.advance(HEAD_FRESH_MS + 100); await settle();
  assert.equal(asked.filter(u => u === headUrl(BASE, L)).length, before);
});

test('a request that never answers is given up at the deadline, its slot freed and the file tried again', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const files = new Map<string, Served>();
  for (let k = 0; k < 5; k++) files.set(packUrl(BASE, L, P + k * len), 'hang');
  const { fetch, asked } = server(files), c = clock();
  const archive = new ArchiveColumns(BASE, fetch, c.now, undefined, c.schedule);
  archive.setInfo(info(P + 6 * len));
  await changed(archive);
  archive.view(step, [{ from: P, to: P + 5 * len }]);
  const engine = frame(step, P, P + 5 * len, [engineSet('a', 20, [])], { a: Infinity });
  archive.extend(engine, P, P + 5 * len, step); await settle();
  assert.equal(asked.length, 4, 'four at once; the fifth waits for a slot');
  c.advance(FETCH_DEADLINE_MS + 1); await settle();
  assert.equal(asked.length, 5, 'the stalled four given up: the fifth goes');
  files.set(packUrl(BASE, L, P), encodeTile({ level: L, packStart: P, windows: 128, through: P + len, books: [['a', [col(1)]]] }));
  c.advance(RETRY_MS[0]! + 100); await settle();
  assert.ok(asked.filter(u => u === packUrl(BASE, L, P)).length >= 2, 'tried again after the failure');
});

test('a file too large is refused before it is kept; the files a view needs stay over the budget and do not ask for themselves again', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const big = encodeTile({ level: L, packStart: P, windows: 128, through: P + 3 * len, books: [['a', [col(1)]]] });
  const files = new Map<string, Served>([[packUrl(BASE, L, P), { bytes: big, length: MAX_FILE_BYTES + 1 }]]);
  for (let k = 1; k < 3; k++) files.set(packUrl(BASE, L, P + k * len), encodeTile({ level: L, packStart: P + k * len, windows: 128, through: P + 3 * len, books: [['a', Array.from({ length: 40 }, (_, i) => col(i))]] }));
  const { fetch, asked } = server(files);
  const size = (files.get(packUrl(BASE, L, P + len)) as ArrayBuffer).byteLength;
  const archive = new ArchiveColumns(BASE, fetch, Date.now, size);
  archive.setInfo(info(P + 3 * len));
  await changed(archive);
  archive.view(step, [{ from: P, to: P + 3 * len }]);
  const engine = frame(step, P, P + 3 * len, [engineSet('a', 20, [])], { a: Infinity });
  archive.extend(engine, P, P + 3 * len, step); await settle(100);
  assert.equal(archive.heldBytes, 2 * size, 'the oversized pack is not kept; the two the view needs are, over a one-pack budget');
  const out = archive.extend(engine, P, P + 3 * len, step).instruments[0]!;
  assert.equal(out.times.length, 80);
  for (let i = 0; i < 3; i++) { archive.extend(engine, P, P + 3 * len, step); await settle(30); }
  assert.equal(asked.filter(u => u !== packUrl(BASE, L, P)).length, 2, 'no pack asked for again: nothing the view needs was let go');
  assert.equal(MAX_FILE_BYTES, 16 << 20);
});

test('a body with no Content-Length is read only up to the cap: an endless one is refused, its request ended, nothing kept', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  let pulled = 0, cancelled = false;
  const endless = new ReadableStream<Uint8Array>({ pull: c => { pulled++; c.enqueue(new Uint8Array(1 << 20)); }, cancel: () => { cancelled = true; } });
  let signal: AbortSignal | null = null;
  const fetch: TileFetch = async (_url, init) => { signal = init.signal; return { ok: true, status: 200, body: endless, arrayBuffer: async () => { throw new Error('read whole'); } }; };
  const c = clock(), archive = new ArchiveColumns(BASE, fetch, c.now, undefined, c.schedule);
  archive.setInfo(info(P + 2 * len));
  await changed(archive);
  archive.extend(frame(step, P, P + len, [engineSet('a', 20, [])], { a: Infinity }), P, P + len, step); await settle(100);
  assert.ok(pulled <= 18, `stopped at the cap (${pulled} MB pulled)`);
  assert.ok(cancelled && signal!.aborted, 'the body cancelled and the request ended');
  assert.equal(archive.heldBytes, 0);
});

test('what the view needs follows the windows it holds, whatever asked last: a question elsewhere at the level unpins nothing', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const { fetch, asked } = server(new Map()), c = clock();
  const archive = new ArchiveColumns(BASE, fetch, c.now, undefined, c.schedule);
  archive.setInfo(info(P + 2 * len));
  await changed(archive);
  archive.view(step, [{ from: P, to: P + len }]);
  archive.extend(frame(step, P, P + len, [engineSet('a', 20, [])], { a: Infinity }), P, P + len, step); await settle();
  // A whole question for another book from elsewhere, or a pane's bars, at the same level: answered and fetched, needed by nothing held.
  archive.extend(frame(step, P - 3 * len, P - 2 * len, [engineSet('b', 20, [])], { b: Infinity }), P - 3 * len, P - 2 * len, step); await settle();
  c.advance(MISSING_FRESH_MS + 100); await settle();
  assert.equal(asked.filter(u => u === packUrl(BASE, L, P)).length, 2, 'the held window\'s missing pack, asked again after its ten minutes');
  assert.equal(asked.filter(u => u === packUrl(BASE, L, P - 3 * len)).length, 1, 'the other one fetched once, never again');
});

test('the view\'s level only: a live minute view lets timers lapse, coming back asks for what went stale, a late answer changes nothing', async () => {
  const L = 16, step = L * MIN, P = packStartOf(T0, L, SPAN), len = packMs(L, SPAN);
  const { fetch, asked } = server(new Map()), c = clock();
  const archive = new ArchiveColumns(BASE, fetch, c.now, undefined, c.schedule);
  archive.setInfo(info(P + 2 * len));
  await changed(archive);
  const held = [{ from: P, to: P + len }], engine = frame(step, P, P + len, [engineSet('a', 20, [])], { a: Infinity });
  archive.view(step, held);
  archive.extend(engine, P, P + len, step); await settle();
  const count = (): number => asked.filter(u => u === packUrl(BASE, L, P)).length;
  archive.view(MIN, held);
  c.advance(MISSING_FRESH_MS + 100); await settle();
  assert.equal(count(), 1, 'the live view needs no tiles: the timer lapses');
  archive.view(step, held); await settle();
  assert.equal(count(), 2, 'back at the level: the stale file asked again at once');
  // A whole answer for the level that comes after the view went back to minutes does not bring the level back.
  archive.view(MIN, []);
  archive.extend(engine, P, P + len, step);
  c.advance(MISSING_FRESH_MS + 100); await settle();
  assert.equal(count(), 2, 'a late answer leaves the view where it is');
  archive.view(step, [{ from: P - 4 * len, to: P - 3 * len }]); await settle();
  assert.equal(count(), 2, 'a window that was let go needs nothing');
});

test('the engine\'s answer passes as it is where the archive has no say', () => {
  const archive = new ArchiveColumns(BASE, server(new Map()).fetch);
  const one = frame(MIN, T0, T0 + 60 * MIN, [engineSet('a', 20, [T0])], { a: T0 });
  assert.equal(archive.extend(one, T0, T0 + 60 * MIN, MIN), one, 'no tiles known');
  archive.setInfo(info(T0));
  assert.equal(archive.extend(one, T0, T0 + 60 * MIN, MIN), one, 'a minute is the hour files\' own');
  const odd = frame(3 * MIN, T0, T0 + 60 * MIN, [engineSet('a', 20, [T0])], { a: T0 });
  assert.equal(archive.extend(odd, T0, T0 + 60 * MIN, 3 * MIN), odd, 'a step the service does not build');
});

test('a coin kept as tiles from eight minutes: its finest step is eight, its old ranges draw from the tiles there, two and four minutes are the engine\'s', async () => {
  const levels = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096], step = 8 * MIN;
  const start = packStartOf(T0, 8, SPAN), len = packMs(8, SPAN);
  const pack = encodeTile({ level: 8, packStart: start, windows: 128, through: start + len, books: [['a', [col(0, 0.5), col(1, 0.5)]]] });
  const { fetch, asked } = server(new Map([[packUrl(BASE, 8, start), pack]]));
  const archive = new ArchiveColumns(BASE, fetch);
  assert.equal(archive.minStepMs(), null, 'nothing known yet');
  archive.setInfo({ ...info(start + 2 * len, start), levels });
  await changed(archive);
  assert.equal(archive.minStepMs(), step);
  const now = start + 3 * 86_400_000;
  assert.equal(columnStepFor({ t0: start, t1: start + 2 * HOUR }, 1_500, archive.first(), now - HOUR, now, archive.minStepMs()!), step);
  const from = start, to = start + 4 * step;
  const empty = frame(step, from, to, [engineSet('a', 0.5, [])], { a: Infinity });
  const came = changed(archive);
  assert.equal(archive.extend(empty, from, to, step), empty, 'the pack is not here yet');
  await came;
  assert.deepEqual(asked, [packUrl(BASE, 8, start)]);
  const drawn = archive.extend(empty, from, to, step).instruments[0]!;
  assert.deepEqual(drawn.times, [start, start + step], 'the two windows of the tiles');
  for (const finer of [2 * MIN, 4 * MIN]) {
    const f = frame(finer, from, to, [engineSet('a', 0.5, [])], { a: Infinity });
    assert.equal(archive.extend(f, from, to, finer), f, `${finer / MIN} minutes: a level the coin does not have`);
  }
});

test('the step rule looks at every book: one with only a phone\'s hours makes a twelve-hour-old view two minutes', () => {
  const now = T0 + 30 * HOUR, held = new Map([['a', now - 24 * HOUR], ['b', now - 3 * HOUR]]);
  assert.equal(depthSinceOf(held, ['a', 'b']), now - 3 * HOUR);
  assert.equal(depthSinceOf(held, ['a', 'c']), Infinity, 'a book the engine holds none of');
  assert.equal(depthSinceOf(new Map(), ['a']), null, 'nothing said yet');
  const view = { t0: now - 13 * HOUR, t1: now - 11 * HOUR };
  assert.equal(columnStepFor(view, 1_500, now - 30 * 86_400_000, depthSinceOf(held, ['a', 'b'])!, now), 2 * MIN);
  assert.equal(columnStepFor(view, 1_500, now - 30 * 86_400_000, depthSinceOf(held, ['a'])!, now), MIN, 'with the 24-hour book alone, a minute');
});
