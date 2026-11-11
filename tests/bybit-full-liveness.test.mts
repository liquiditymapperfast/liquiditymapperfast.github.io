import test from 'node:test';
import assert from 'node:assert/strict';
import { BAND, FullBook, GUARD, REFRESH_USED, SNAPSHOT_CAP } from '../src/shared/bybit-full-book.ts';
import { simulate } from './bybit-full-sim.mts';

/**
 * The refresh rule against a moving venue (tests/bybit-full-sim.mts): a perpetual's whole book and spot's capped one, trends and jumps,
 * replicas minutes stale or degraded, quiet markets judged at the book's own mid. Red on every earlier rule (the minute loop of
 * 44a59776; the stale baselines of b44ada20, e80587dd and 0ec91820: sides short for 41 to 94 minutes), measured 2026-11-11.
 */
test('bybit full book: against a moving venue, a side the band needs is covered again within the pace, and snapshots stay few', () => {
  const rules = { BAND, GUARD, REFRESH_USED, SNAPSHOT_CAP };
  // The pace is a minute; failed refreshes back off 1, 2, 4, 8 and then 15 minutes: 30 minutes, and a margin.
  const LAG_MS = 35 * 60_000, READS_PER_HOUR = 30;
  for (const kind of ['perp', 'spot'] as const) {
    for (let seed = 1; seed <= 6; seed++) {
      const res = simulate(() => new FullBook(), rules, seed, kind, 10);
      assert.ok(res.longestDeficitMs <= LAG_MS, res.worst);
      assert.ok(Math.max(...res.readsPerHour) <= READS_PER_HOUR, `${kind} seed ${seed}: reads per hour ${res.readsPerHour.join(' ')}`);
      assert.ok((res.seen.extended ?? 0) > 0, `${kind} seed ${seed} extended its coverage: ${JSON.stringify(res.seen)}`);
    }
  }
});
