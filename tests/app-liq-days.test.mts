import test from 'node:test';
import assert from 'node:assert/strict';
import { LiquidationDays } from '../src/app/liq-days.ts';
import { DAY_MS } from '../src/app/panes/bar-stats.ts';
import { LIQUIDATIONS_PER_ANSWER, type Liquidation } from '../src/shared/liquidations.ts';

// The liquidations by UTC day, one loader for the Bar stats and the Flow history (liq-days.ts): a day is asked once however many panes
// need it, kept while any of them still does, and a pane that stops asking lets its days go after two minutes.

const D0 = Date.UTC(2026, 10, 20);
/** A fake source whose answers wait until `answer` is called, with the days it was asked for. */
function source() {
  const asked: number[] = [], waiting: { from: number; resolve: (rows: Liquidation[]) => void; reject: (e: Error) => void }[] = [];
  return {
    asked, waiting,
    hub: { source: { liquidations: (from: number, _to: number) => new Promise<Liquidation[]>((resolve, reject) => { asked.push(from); waiting.push({ from, resolve, reject }); }) } } as never,
    /** Answer every question waiting, `rows` liquidations each (a full day of the cap when `rows` reaches it). */
    async answer(rows = 3): Promise<void> {
      for (const w of waiting.splice(0)) w.resolve(Array.from({ length: rows }, () => ({ id: 'x', t: w.from, side: 'long', usd: 100 }) as unknown as Liquidation));
      await new Promise(r => setTimeout(r, 0));
    },
  };
}
const withClock = async (t: number, fn: () => Promise<void> | void): Promise<void> => { const real = Date.now; Date.now = () => t; try { await fn(); } finally { Date.now = real; } };

test('two panes needing different stretches share the days, two questions at a time, the newest first', async () => {
  const s = source(), days = new LiquidationDays(s.hub);
  let heard = 0; days.listen(() => heard++);
  await withClock(D0 + 12 * 3_600_000, async () => {
    days.ensure('bars', 'a,b', D0, D0 + DAY_MS);
    days.ensure('sizes', 'a,b', D0 - 3 * DAY_MS, D0 + DAY_MS);
    assert.deepEqual(s.asked, [D0, D0 - DAY_MS], 'today once (both want it), then the day before; two at a time');
    await s.answer();
    days.ensure('sizes', 'a,b', D0 - 3 * DAY_MS, D0 + DAY_MS);
    assert.deepEqual(s.asked.slice(2), [D0 - 2 * DAY_MS, D0 - 3 * DAY_MS]);
    await s.answer();
    // The Bar stats ask for their narrow stretch again: the Flow history's older days are not let go.
    days.ensure('bars', 'a,b', D0, D0 + DAY_MS);
    assert.deepEqual([...days.days.keys()].sort((a, b) => a - b), [D0 - 3 * DAY_MS, D0 - 2 * DAY_MS, D0 - DAY_MS, D0]);
  });
  assert.equal(heard, 4, 'every answer tells the panes');
  assert.ok(days.version >= 4);
});

test('a pane that stops asking lets its days go after two minutes; a day answered to its end is not asked again', async () => {
  const s = source(), days = new LiquidationDays(s.hub), now = D0 + DAY_MS + 3_600_000;
  await withClock(now, async () => { days.ensure('sizes', 'a', D0 - 2 * DAY_MS, D0 + DAY_MS); await s.answer(); days.ensure('sizes', 'a', D0 - 2 * DAY_MS, D0 + DAY_MS); await s.answer(); });
  assert.equal(days.days.size, 3);
  await withClock(now + 60_000, () => { days.ensure('bars', 'a', D0 + DAY_MS, D0 + 2 * DAY_MS); });
  assert.ok(days.days.has(D0 - 2 * DAY_MS), 'a minute later the Flow history still holds its days');
  const before = s.asked.length;
  await withClock(now + 3 * 60_000, () => { days.ensure('bars', 'a', D0 + DAY_MS, D0 + 2 * DAY_MS); });
  assert.equal(days.days.has(D0 - 2 * DAY_MS), false, 'three minutes later they are let go');
  assert.ok(s.asked.slice(before).every(day => day >= D0 + DAY_MS), 'and nothing older is asked for the Bar stats');
});

test('other markets start again: the days held are dropped and an answer still out for the old ones is not taken', async () => {
  const s = source(), days = new LiquidationDays(s.hub);
  await withClock(D0 + 3_600_000, async () => {
    days.ensure('bars', 'a', D0, D0 + DAY_MS);
    const v = days.version;
    days.ensure('bars', 'b', D0, D0 + DAY_MS);
    assert.ok(days.version > v); assert.equal(days.ids, 'b');
    await s.answer();
    assert.equal(days.days.size, 0, 'the answer for "a" is dropped');
    days.ensure('bars', 'b', D0, D0 + DAY_MS);
    await s.answer(LIQUIDATIONS_PER_ANSWER);
    assert.equal(days.days.get(D0)?.cut, true, 'a day of 5,000 is said to be cut');
  });
});
