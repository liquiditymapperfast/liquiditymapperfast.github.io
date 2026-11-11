/**
 * A moving venue for the full book's refresh rule (tests/bybit-full-liveness.test.mts): a price grid whose mid drifts and now and then
 * jumps, in two shapes (a perpetual's whole book, past the guard; spot's, capped at SNAPSHOT_CAP levels a side), answered by replicas
 * that are now and then minutes stale or degraded, and asked now and then with no trade price (a quiet market: the book's own mid).
 *
 * Two properties, judged against an oracle (what a snapshot read now would cover): liveness (wherever a fresh snapshot would add
 * coverage the band needs, the book covers it again within the pace and the failure backoff), and rate (snapshots read per hour).
 * Kept apart from the test so it can be run against any version of the module (the red-first check of the refresh rule).
 */
import type { FullDelta, FullSnapshot } from '../src/shared/bybit-full-book.ts';

export interface BookUnderTest {
  live: boolean; refreshing: boolean; epoch: number; u: number;
  frontiers: { bid: number | null; ask: number | null };
  bids: Map<number, number>; asks: Map<number, number>;
  delta(d: FullDelta, now: number): string;
  snapshot(s: FullSnapshot, epoch: number, now: number): string;
  refreshDue(mid: number, now: number): boolean;
  beginRefresh(now: number): number;
  mid(): number;
}
export interface Rules { BAND: number; GUARD: number; REFRESH_USED: number; SNAPSHOT_CAP: number }
export interface SimResult {
  /** The longest time a side lacked coverage the band needed while a fresh snapshot would have given it. */
  longestDeficitMs: number;
  worst: string;
  /** Snapshots read while live (refreshes and audits), per simulated hour. */
  readsPerHour: number[];
  seen: Record<string, number>;
}

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const STEP_MS = 2_000;

/** A grid: prices are (lo + i) / denom for i below n. A power-of-two denom keeps every price and mid exact (the cross-port trace). */
export interface Grid { denom: number; lo: number; n: number }
export const LARGE: Record<'perp' | 'spot', Grid> = { perp: { denom: 50, lo: 50, n: 150_000 }, spot: { denom: 200, lo: 100_000, n: 200_000 } };

export function simulate(make: () => BookUnderTest, rules: Rules, seed: number, kind: 'perp' | 'spot', hours: number, grids: Record<'perp' | 'spot', Grid> = LARGE): SimResult {
  const r = rng(seed * 7919 + (kind === 'perp' ? 1 : 2));
  const { BAND, GUARD, REFRESH_USED, SNAPSHOT_CAP } = rules;
  // The grid: a perpetual's levels every 0.02 from 1 to 3,000 (its nearest 10,000 reach about a quarter of the price) (a whole book far past the guard, plus a far junk ask); spot's every 0.005
  // from 500 to 1,500, read 10,000 levels a side at most (about 6 % of the price).
  const { denom, lo, n } = grids[kind];
  const price = (i: number): number => (lo + i) / denom;
  const index = (p: number): number => Math.round(p * denom) - lo;
  const size = new Float64Array(n);
  for (let i = 0; i < n; i++) if (r() < 0.8) size[i] = 1 + Math.floor(r() * 9);
  let mid = (index(1000) + lo + 0.5) / denom, u = 0, seq = 0, trend = 0, noise = 1.6;
  const center = (): number => mid;
  /** The venue's answer as it is now: best first, spot's capped. */
  const read = (): FullSnapshot => {
    const b: [number, number][] = [], a: [number, number][] = [], cap = kind === 'spot' ? SNAPSHOT_CAP : Infinity;
    for (let i = index(mid - 0.5 / denom); i >= 0 && b.length < cap; i--) if (size[i]! > 0 && price(i) < mid) b.push([price(i), size[i]!]);
    for (let i = index(mid + 0.5 / denom); i < n && a.length < cap; i++) if (size[i]! > 0 && price(i) > mid) a.push([price(i), size[i]!]);
    if (kind === 'perp') a.push([1e9, 1]);
    return { u, seq, ts: 0, b, a };
  };
  /** Where a snapshot read now would put each frontier (as `#build` does), and so what the band needs covered. */
  const oracle = (): { bid: number; ask: number } => {
    if (kind === 'perp') return { bid: mid * (1 - GUARD), ask: mid * (1 + GUARD) };
    let k = 0, bid = NaN, ask = NaN;
    for (let i = index(mid - 0.5 / denom); i >= 0 && k < SNAPSHOT_CAP; i--) if (size[i]! > 0 && price(i) < mid) { k++; bid = price(i); }
    k = 0;
    for (let i = index(mid + 0.5 / denom); i < n && k < SNAPSHOT_CAP; i++) if (size[i]! > 0 && price(i) > mid) { k++; ask = price(i); }
    return { bid, ask };
  };
  const step = (): FullDelta => {
    const was = mid, b: [number, number][] = [], a: [number, number][] = [];
    // Drift (about 2 % an hour), and about three times an hour a jump of 3 to 12 % (spot's is past its whole reach at the top). The
    // mid stays where the grid holds a snapshot's whole reach: a perpetual's cut, spot's 10,000 levels.
    // Each hour has its own trend, up to 3 % an hour either way (a trending market sets a new high or low every minute).
    // Some hours are clean trends (little noise: a new high or low nearly every minute), others noisy, and some plateaus (no trend,
    // little noise: whatever a jump left uncovered stays uncovered unless a refresh comes).
    if (u % (3_600_000 / STEP_MS) === 0) {
      const regime = r();
      trend = regime < 0.3 ? 0 : (r() * 2 - 1) * 0.03 * mid / (3_600_000 / STEP_MS);
      noise = regime < 0.3 || regime < 0.6 ? 0.1 : 1.6;
    }
    let move = trend + (r() - 0.5) * noise;
    if (r() < (3 * STEP_MS) / 3_600_000) move += (r() < 0.5 ? -1 : 1) * mid * (0.03 + r() * 0.09);
    const [floor, ceiling] = kind === 'perp' ? [300, 1800] : [700, 1300];
    mid = Math.min(ceiling, Math.max(floor, mid + move));
    mid = (Math.floor(mid * denom) + 0.5) / denom;
    // Levels the mid crossed are taken.
    const [from, to] = was < mid ? [index(was - 0.5 / denom) + 1, index(mid - 0.5 / denom)] : [index(mid + 0.5 / denom), index(was + 0.5 / denom) - 1];
    for (let i = Math.max(0, from); i <= Math.min(n - 1, to); i++) if (size[i]! > 0) { size[i] = 0; (was < mid ? a : b).push([price(i), 0]); }
    // Changes near the mid and anywhere.
    for (let k = 0; k < 24; k++) {
      const span = k < 16 ? 0.02 : 0.7, p0 = mid * (1 + (r() * 2 - 1) * span), i = index(p0);
      if (i < 0 || i >= n || price(i) === mid) continue;
      const q = r() < 0.3 ? 0 : 1 + Math.floor(r() * 9);
      if (size[i] === q) continue;
      size[i] = q;
      (price(i) < mid ? b : a).push([price(i), q]);
    }
    return { u: ++u, seq: (seq += 1 + Math.floor(r() * 3)), ts: 0, b, a };
  };
  // Replicas: one answer in ten from one to three minutes back, three in a hundred degraded (whole near the mid, a third beyond), and
  // six in a hundred cut to their nearest levels (a perpetual's to the cap, Bybit's documented limit, spot's to half of it): whole
  // as far as they go, and short.
  const kept: FullSnapshot[] = [];
  const replica = (): FullSnapshot => {
    const x = r();
    if (x < 0.1 && kept.length) return kept[Math.floor(r() * kept.length)]!;
    const s = read();
    if (x < 0.13) {
      const m = s.b.length && s.a.length ? (s.b[0]![0] + s.a[0]![0]) / 2 : mid, near = m * 0.02;
      const thin = (rows: [number, number][]): [number, number][] => rows.filter(([p], i) => Math.abs(p - m) <= near || i % 3 === 0 || i === rows.length - 1);
      return { ...s, b: thin(s.b), a: thin(s.a) };
    }
    if (x < 0.19) {
      const keep = kind === 'perp' ? SNAPSHOT_CAP : Math.floor(SNAPSHOT_CAP / 2);
      return { ...s, b: s.b.slice(0, keep), a: s.a.slice(0, keep) };
    }
    return s;
  };

  const book = make();
  const seen: Record<string, number> = {};
  const readsPerHour: number[] = [];
  const inflight: { s: FullSnapshot; epoch: number; due: number }[] = [];
  const deficitSince = { bid: -1, ask: -1 };
  let longest = 0, worst = '';
  const steps = Math.round((hours * 3_600_000) / STEP_MS);
  for (let k = 0, t = 0; k < steps; k++) {
    t += STEP_MS;
    const d = step();
    if (k % 30 === 0) { kept.push(read()); if (kept.length > 3) kept.shift(); }
    if (book.delta(d, t) !== 'none' && !inflight.some(j => j.epoch === book.epoch)) inflight.push({ s: read(), epoch: book.epoch, due: t });
    if (!book.live && !inflight.some(j => j.epoch === book.epoch)) inflight.push({ s: read(), epoch: book.epoch, due: t + STEP_MS });
    // The connector judges at the last trade; a quiet market (three checks in ten here) at the book's own mid.
    if (book.live && !book.refreshing) {
      const at = r() < 0.3 ? book.mid() : center();
      if (book.refreshDue(at, t)) {
        inflight.push({ s: replica(), epoch: book.beginRefresh(t), due: t + Math.floor(r() * 2) * STEP_MS });
        const hour = Math.floor(t / 3_600_000);
        readsPerHour[hour] = (readsPerHour[hour] ?? 0) + 1;
      }
    }
    for (const job of inflight.splice(0)) {
      if (job.due > t) { inflight.push(job); continue; }
      const result = book.snapshot(job.s, job.epoch, t);
      seen[result] = (seen[result] ?? 0) + 1;
      if (result === 'retry') inflight.push({ s: read(), epoch: book.epoch, due: t + 5 * STEP_MS });
    }
    // Liveness, once a minute: a side the band needs (to a quarter short of a fresh snapshot's reach, at most to the band) that a fresh
    // snapshot would cover further, and the book does not.
    if (!book.live) { deficitSince.bid = deficitSince.ask = -1; continue; }
    if (k % 30 !== 0) continue;
    const o = oracle(), f = book.frontiers, tol = 2 / denom;
    const sides = [
      { name: 'bid' as const, empty: book.bids.size === 0, left: f.bid === null ? Infinity : mid - f.bid, fresh: mid - o.bid },
      { name: 'ask' as const, empty: book.asks.size === 0, left: f.ask === null ? Infinity : f.ask - mid, fresh: o.ask - mid },
    ];
    for (const s of sides) {
      // A fresh snapshot reaching past the band owes the whole band; one short of it (spot's), its reach less the quarter of slack.
      const need = s.fresh >= mid * BAND ? mid * BAND : s.fresh * (1 - REFRESH_USED);
      const left = s.empty ? -Infinity : s.left;
      const short = left < need - tol && s.fresh > left + tol;
      if (!short) { deficitSince[s.name] = -1; continue; }
      if (deficitSince[s.name] < 0) deficitSince[s.name] = t;
      const lasted = t - deficitSince[s.name];
      if (lasted > longest) { longest = lasted; worst = `${kind} seed ${seed}: ${s.name} short for ${Math.round(lasted / 60_000)} min at ${Math.round(t / 60_000)} min (left ${left.toFixed(2)}, needs ${need.toFixed(2)}, a fresh snapshot reaches ${s.fresh.toFixed(2)}, mid ${mid.toFixed(2)})`; }
    }
  }
  return { longestDeficitMs: longest, worst, readsPerHour: Array.from({ length: Math.ceil(hours) }, (_, h) => readsPerHour[h] ?? 0), seen };
}
