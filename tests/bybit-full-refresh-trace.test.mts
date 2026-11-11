import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { BAND, FullBook, GUARD, REFRESH_USED, type FullDelta, type FullSnapshot } from '../src/shared/bybit-full-book.ts';
import { simulate, type BookUnderTest, type Grid } from './bybit-full-sim.mts';

/**
 * Every call the connector makes on the full book (delta, snapshot, refreshDue, beginRefresh), with its answer and the book's state
 * after it, on two small simulated venues (a perpetual's whole book and spot's capped one, `snapshotCap` 200) chosen to take every
 * path of the refresh rule: written to tests/fixtures/bybit-full-refresh-trace.json.br (Brotli; `HLM_WRITE_TRACE=1` rewrites it), which the
 * history recorder's Rust port replays call for call (HyperLiquidMap_History, tests/full_book_refresh_trace.rs). Prices sit on
 * power-of-two grids, so every price and mid is exact in both; the state's derived numbers (frontiers, mids) are written as text, which
 * Rust reads with its exact parser.
 */
const root = process.cwd();
const fixturePath = path.join(root, 'tests/fixtures/bybit-full-refresh-trace.json.br');
const CAP = 200;
const GRIDS: Record<'perp' | 'spot', Grid> = { perp: { denom: 1, lo: 1, n: 2_999 }, spot: { denom: 16, lo: 8_000, n: 16_000 } };
const RUNS: { kind: 'perp' | 'spot'; seed: number; hours: number }[] = [{ kind: 'perp', seed: 7, hours: 1.5 }, { kind: 'spot', seed: 9, hours: 1 }];

type Event = unknown[];
const text = (x: number | null): string | null => (x === null ? null : String(x));

function record(kind: 'perp' | 'spot', seed: number, hours: number): Event[] {
  const events: Event[] = [];
  const make = (): BookUnderTest => {
    const b = new FullBook({ snapshotCap: CAP });
    const state = (): unknown[] => [b.live, b.u, b.epoch, text(b.frontiers.bid), text(b.frontiers.ask), b.bids.size, b.asks.size, b.auditing, b.refreshing];
    return {
      get live() { return b.live; }, get refreshing() { return b.refreshing; }, get epoch() { return b.epoch; }, get u() { return b.u; },
      get frontiers() { return b.frontiers; }, get bids() { return b.bids; }, get asks() { return b.asks; },
      delta(d: FullDelta, now: number) { const r = b.delta(d, now); events.push(['d', now, d.u, d.seq, d.b, d.a, r, state()]); return r; },
      snapshot(s: FullSnapshot, epoch: number, now: number) { const r = b.snapshot(s, epoch, now); events.push(['s', now, s.u, s.seq, s.b, s.a, epoch, r, state()]); return r; },
      refreshDue(mid: number, now: number) { const r = b.refreshDue(mid, now); events.push(['r', now, Number.isFinite(mid) ? String(mid) : null, r, state()]); return r; },
      beginRefresh(now: number) { const r = b.beginRefresh(now); events.push(['b', now, r, state()]); return r; },
      mid: () => b.mid(),
    };
  };
  simulate(make, { BAND, GUARD, REFRESH_USED, SNAPSHOT_CAP: CAP }, seed, kind, hours, GRIDS);
  return events;
}

test('bybit full book: every call on two simulated venues, the trace the recorder\'s port replays call for call', () => {
  const now = { cap: CAP, runs: RUNS.map(run => ({ ...run, events: record(run.kind, run.seed, run.hours) })) };
  // The runs take the paths of the refresh rule that matter: refreshes due and extending, audits, and replicas that do not fit.
  const results = new Set<string>(), due = { true: 0, false: 0 };
  for (const run of now.runs) for (const e of run.events) { if (e[0] === 's') results.add(String(e[7])); if (e[0] === 'r') due[e[3] ? 'true' : 'false']++; }
  for (const r of ['seeded', 'extended', 'unchanged']) assert.ok(results.has(r), `${r} in ${[...results].join(', ')}`);
  assert.ok(due.true >= 6 && due.false > 1_000, JSON.stringify(due));
  if (process.env.HLM_WRITE_TRACE === '1') fs.writeFileSync(fixturePath, brotliCompressSync(Buffer.from(JSON.stringify(now))));
  const kept = JSON.parse(brotliDecompressSync(fs.readFileSync(fixturePath)).toString('utf8')) as typeof now;
  assert.deepEqual(kept, JSON.parse(JSON.stringify(now)), 'run with HLM_WRITE_TRACE=1 to rewrite the fixture, then copy it to the recorder');
});
