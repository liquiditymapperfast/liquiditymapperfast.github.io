import test from 'node:test';
import assert from 'node:assert/strict';
import { ANCHOR_BAR_MS, ANCHOR_EVERY, anchorAt, anchorSnapshot, anchorTag, answerFits, snapshotDue } from '../src/app/traded/anchor.ts';
import { TRADED_DEFAULTS, profileAnchorOf, readTraded, withProfileAnchor } from '../src/app/traded/settings.ts';
import { readSettings, type AppState } from '../src/app/store.ts';
import { carriedSettings, completeSettings, settingsOf, settingsToApply } from '../src/app/layouts/layouts.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2, 9, 0);

test('an anchor starts at the candle clicked, on the estimate\'s five minutes', () => {
  assert.equal(anchorAt(T0 + 37 * MIN + 20_000, HOUR), T0, 'an hour\'s candle: its hour');
  assert.equal(anchorAt(T0 + 7 * MIN + 20_000, MIN), T0 + 5 * MIN, 'a minute\'s candle: the five minutes it is in');
  assert.equal(anchorAt(T0 + 7 * MIN, 15 * MIN), T0, 'a quarter hour\'s candle: its quarter');
  assert.equal(anchorAt(T0 + 13 * HOUR, DAY), Date.UTC(2026, 10, 2), 'a day\'s candle: its day');
  assert.equal(ANCHOR_BAR_MS, 5 * MIN);
});

test('the anchored window is held until it is due, then taken again up to the last whole five minutes', () => {
  const key = 'BTC|a|15', a = T0;
  const first = anchorSnapshot(null, key, a, 15, T0 + 2 * HOUR + 3 * MIN);
  assert.deepEqual(first, { key, from: a, to: T0 + 2 * HOUR, at: T0 + 2 * HOUR + 3 * MIN }, 'from the anchor to the last whole five minutes');
  assert.equal(anchorSnapshot(first, key, a, 15, T0 + 2 * HOUR + 17 * MIN), first, 'not due within its fifteen minutes');
  const later = anchorSnapshot(first, key, a, 15, T0 + 2 * HOUR + 18 * MIN);
  assert.equal(later.to, T0 + 2 * HOUR + 15 * MIN, 'due: up to the last whole five minutes then');
  assert.notEqual(anchorSnapshot(first, key, a, 15, T0 + 2 * HOUR + 4 * MIN, true), first, 'Update now takes it again at once');
  assert.notEqual(anchorSnapshot(first, 'BTC|b|15', T0 + HOUR, 15, T0 + 2 * HOUR + 4 * MIN), first, 'another anchor, coin or interval: at once');
  assert.equal(snapshotDue(first, 15), first.at + 15 * MIN);
  // An anchor in the five minutes under way holds nothing yet, and is taken again as soon as five more minutes have ended.
  const empty = anchorSnapshot(null, key, T0 + 2 * HOUR, 60, T0 + 2 * HOUR + 2 * MIN);
  assert.ok(!(empty.to > empty.from));
  assert.equal(snapshotDue(empty, 60), T0 + 2 * HOUR + 5 * MIN);
  assert.equal(anchorSnapshot(empty, key, T0 + 2 * HOUR, 60, T0 + 2 * HOUR + 4 * MIN), empty);
  assert.equal(anchorSnapshot(empty, key, T0 + 2 * HOUR, 60, T0 + 2 * HOUR + 5 * MIN).to, T0 + 2 * HOUR + 5 * MIN);
  assert.deepEqual(ANCHOR_EVERY, [5, 15, 60]);
});

test('the profile\'s anchors are read back checked, one a coin, and kept within what the candle estimate reaches', () => {
  assert.equal(TRADED_DEFAULTS.columns, 'chart'); assert.equal(TRADED_DEFAULTS.every, 15); assert.deepEqual(TRADED_DEFAULTS.anchors, {});
  const s = readTraded({ columns: 'anchor', every: 60, anchors: { BTC: T0 + 2 * MIN, eth: T0, SOL: 'x', XRP: -5 } });
  assert.equal(s.columns, 'anchor'); assert.equal(s.every, 60);
  assert.deepEqual(s.anchors, { BTC: T0 }, 'a coin\'s name in capitals, a time, on five minutes');
  assert.equal(readTraded({ every: 7, columns: 'week' }).every, 15); assert.equal(readTraded({ columns: 'week' }).columns, 'chart');
  const moved = withProfileAnchor(s, 'BTC', T0 + HOUR);
  assert.deepEqual(moved.anchors, { BTC: T0 + HOUR }, 'one a coin: placing it again moves it');
  assert.deepEqual(withProfileAnchor(moved, 'BTC', null).anchors, {});
  const back = 21 * 7 * DAY;
  assert.equal(profileAnchorOf(moved, 'BTC', T0 + 2 * HOUR, back), T0 + HOUR);
  assert.equal(profileAnchorOf(moved, 'BTC', T0 + back + 2 * HOUR, back), null, 'older than the estimate reaches: none');
  assert.equal(profileAnchorOf(moved, 'BTC', T0, back), null, 'not begun yet: none');
  assert.equal(profileAnchorOf(moved, 'ETH', T0 + 2 * HOUR, back), null);
});

test('a layout carries whether the columns are anchored and how often, never the anchors, as with the VWAP\'s', () => {
  const defaults = readSettings({});
  const state = (patch: Partial<AppState>): AppState => ({ ...defaults, ...patch } as AppState);
  const mine = state({ traded: { ...defaults.traded, columns: 'anchor', every: 5, anchors: { BTC: T0 } } });
  const kept = settingsOf(mine);
  assert.ok(!('anchors' in kept.traded!)); assert.equal(kept.traded!.columns, 'anchor'); assert.equal(kept.traded!.every, 5);
  const other = state({ traded: { ...defaults.traded, anchors: { ETH: T0 + HOUR } } });
  assert.deepEqual(settingsToApply(kept, other).traded.anchors, { ETH: T0 + HOUR }, 'the anchors of the chart it is applied to');
  assert.ok(!('anchors' in carriedSettings({ traded: mine.traded } as never).traded!));
  assert.deepEqual(completeSettings({ traded: kept.traded } as never, other).traded!.anchors, { ETH: T0 + HOUR }, 'an Undo leaves them as they are');
});

test('the columns draw only an answer asked for the anchored window they show (Sol, code review 2026-11-10)', () => {
  const s = (from: number, to: number, at = to + MIN, key = 'BTC|a|15') => ({ key, from, to, at });
  const now = s(T0, T0 + 2 * HOUR);
  assert.equal(answerFits(anchorTag(now), now), true);
  assert.equal(answerFits(anchorTag(s(T0, T0 + HOUR)), now), false, 'nor an older snapshot of the same anchor: its total is of another stretch than the one named');
  assert.equal(answerFits(anchorTag(s(T0 - HOUR, T0 + 2 * HOUR)), now), false, 'another anchor (one moved) is not drawn under the new header');
  assert.equal(answerFits(anchorTag(s(T0, T0 + 3 * HOUR)), now), false, 'nor one ending after the window (a replay moved back)');
  assert.equal(answerFits('', now), false, 'nor the chart window\'s');
  assert.equal(answerFits(anchorTag(now), null), false, 'and following the chart, no anchored one');
  assert.equal(answerFits('', null), true);
  assert.equal(answerFits(anchorTag(now), s(T0, T0)), false, 'a window that holds nothing yet draws nothing');
  // A replay before its anchor's first five minutes ended (or before the anchor) has such a window, never none: none is the chart's, whose
  // totals were drawn under the anchor (Sol, code review 2026-11-10, round 3).
  assert.equal(answerFits('', { ...s(T0, T0 - 2 * HOUR, T0 - HOUR, 'replay'), rev: 0 }), false, 'a replay before the anchor draws no chart total');
  assert.notEqual(anchorTag(s(T0, T0 + HOUR, T0 + HOUR + MIN)), anchorTag(s(T0, T0 + HOUR, T0 + HOUR + 2 * MIN)), 'Update now within the same five minutes asks again');
  assert.equal(anchorTag(s(T0, T0 + HOUR, T0 + HOUR + MIN, 'replay')), anchorTag(s(T0, T0 + HOUR, T0 + HOUR + 2 * MIN, 'replay')), 'a replay asks once for its five minutes');
  assert.notEqual(anchorTag({ ...s(T0, T0 + HOUR, T0 + HOUR + MIN, 'replay'), rev: 1 }), anchorTag({ ...s(T0, T0 + HOUR, T0 + HOUR + MIN, 'replay'), rev: 2 }), 'and again at Update now');
});
