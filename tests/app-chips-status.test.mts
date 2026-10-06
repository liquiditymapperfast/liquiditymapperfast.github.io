import test from 'node:test';
import assert from 'node:assert/strict';
import { INLINE_CHIPS, chipPlan, exchangeGroups } from '../src/app/chips.ts';
import { STALE_PRICE_MS, age, statusInfo, venueSummary } from '../src/app/statusbar.ts';
import type { VenueEntry } from '../src/app/source.ts';

const names = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);

test('a few venues all get a chip; many get a handful and a menu, and one over the limit just gets its chip', () => {
  assert.deepEqual(chipPlan(names(5), INLINE_CHIPS), { shown: names(5), more: [] });
  assert.equal(chipPlan(names(INLINE_CHIPS + 1), INLINE_CHIPS).more.length, 0, '"+1" would save nothing');
  const many = chipPlan(names(20), INLINE_CHIPS);
  assert.deepEqual(many.shown, names(8)); assert.equal(many.more.length, 12); assert.equal(many.more[0], 'v8');
  assert.deepEqual(chipPlan(names(40), Infinity), { shown: names(40), more: [] }, 'the phone sheet has room for all');
  assert.deepEqual(chipPlan([], 8), { shown: [], more: [] });
});

test('the menu groups a venue with its spot twin and keeps the exchanges in the order they were met', () => {
  assert.deepEqual(exchangeGroups(['hyperliquid', 'binance', 'okx', 'binancespot', 'coinbase', 'binanceus']), [
    { key: 'hyperliquid', venues: ['hyperliquid'] }, { key: 'binance', venues: ['binance', 'binancespot'] }, { key: 'okx', venues: ['okx'] }, { key: 'coinbase', venues: ['coinbase'] }, { key: 'binanceus', venues: ['binanceus'] },
  ]);
});

const entry = (id: string, state: VenueEntry['state'], selected = true): VenueEntry => ({ id, name: id.toUpperCase(), supported: true, recommended: true, selected, status: state ?? '', state });

test('the venue summary counts the chosen venues that are drawing and names the ones in trouble', () => {
  const s = venueSummary([entry('a', 'live'), entry('b', 'live'), entry('c', 'error'), entry('d', 'blocked'), entry('e', 'connecting'), entry('f', 'off', false)]);
  assert.deepEqual([s.live, s.total, s.trouble], [2, 5, ['C', 'D']]);
  assert.deepEqual(venueSummary([]), { live: 0, total: 0, trouble: [] });
});

test('how long ago is said in seconds, minutes or hours', () => {
  assert.deepEqual([0, 45_000, 89_000, 120_000, 3_600_000, 5_400_000, 7 * 3_600_000].map(age), ['0 s', '45 s', '89 s', '2 min', '60 min', '2 h', '7 h']);
});

test('the status says whether the data flows, how many venues are live, how old the price is, and since when it records', () => {
  const now = 1_800_000_000_000, state = { status: 'live', connected: true, mark: { price: 86_263.9, asOf: now - 2_000 }, marketId: 'x' };
  const fine = statusInfo(state, [entry('a', 'live'), entry('b', 'live')], now - 3 * 3_600_000, 'browser', now);
  assert.deepEqual(fine.connection, { text: 'live', state: 'live' });
  assert.deepEqual([fine.venues!.text, fine.venues!.state], ['2 of 2 venues live', 'ok']);
  assert.deepEqual([fine.mark!.text, fine.mark!.stale], ['86,263.9', false], 'a fresh price carries no age');
  assert.match(fine.recording!, /^Recording since \d\d:\d\d$/);
  assert.equal(fine.source, 'This browser');
  const trouble = statusInfo({ ...state, connected: false, status: 'reconnecting', mark: { price: 86_263.9, asOf: now - 12 * 3_600_000 } }, [entry('a', 'live'), entry('b', 'error'), entry('c', 'error')], 0, 'server', now);
  assert.deepEqual(trouble.connection, { text: 'reconnecting', state: 'down' });
  assert.deepEqual([trouble.venues!.text, trouble.venues!.state], ['1 of 3 venues live', 'some']);
  assert.deepEqual([trouble.mark!.text, trouble.mark!.stale], ['86,263.9 · 12 h', true]);
  assert.match(trouble.mark!.tip, /may be down/);
  assert.equal(trouble.recording, null); assert.equal(trouble.source, 'Server');
  assert.equal(statusInfo({ ...state, mark: { price: 0, asOf: 0 } }, [], 0, 'browser', now).mark, null);
  assert.equal(statusInfo(state, [], 0, 'browser', now).venues, null);
  assert.ok(STALE_PRICE_MS >= 10_000);
});
