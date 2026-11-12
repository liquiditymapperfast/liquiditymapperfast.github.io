import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionDef } from '../src/app/traded/sessions.ts';
import { TRADED_DEFAULTS, type KindSettings, type LineKind } from '../src/app/traded/settings.ts';
import { LinesCalendar, linesReach, linesWindows } from '../src/app/traded/levels.ts';

const HOUR = 3_600_000, DAY = 86_400_000;
const SESSIONS: SessionDef[] = [
  { id: 'ldn', name: 'London', zone: 'Europe/London', start: '08:00', end: '17:00', on: true, weekdays: false },
  { id: 'us', name: 'US stocks', zone: 'America/New_York', start: '09:30', end: '16:00', on: true, weekdays: true },
  { id: 'night', name: 'Night', zone: 'Asia/Tokyo', start: '22:00', end: '06:00', on: true, weekdays: false },
  { id: 'off', name: 'Off', zone: 'UTC', start: '01:00', end: '02:00', on: false, weekdays: false },
];
const kind = (period: LineKind, zone = 'UTC', count = 5): KindSettings => ({ ...TRADED_DEFAULTS, period, zone, count, sessions: SESSIONS });
const ids = (ws: readonly { key: string; from: number; to: number }[]): string[] => ws.map(w => `${w.key}|${w.to}`);
/**
 * What the chart drew before the calendar, zoomed out: every window from far back (a month further than the reach, so a pick from
 * the reach alone would show), the last `count` of each kind.
 */
const refs = new Map<string, string[]>();
const reference = (k: KindSettings, end: number, count: number): string[] => {
  const key = `${JSON.stringify(k)}|${end}|${count}`;
  let r = refs.get(key);
  if (!r) refs.set(key, r = ids(linesWindows(k, 'utc', end - linesReach(k.period, count) - 31 * DAY, end, end, count)));
  return r;
};

// From late February to now, every 53 hours (each hour of the day in turn), and on and around the 2026 clock changes (New York 8 March and
// 1 November, London 29 March and 25 October): the hour before, at and after the change, and on the midnights after.
const START = Date.UTC(2026, 1, 20), ENDS: number[] = [];
for (let t = START; t < Date.UTC(2026, 10, 12); t += 53 * HOUR + 7 * 60_000) ENDS.push(t);
for (const change of [Date.UTC(2026, 2, 8, 7), Date.UTC(2026, 2, 29, 1), Date.UTC(2026, 9, 25, 1), Date.UTC(2026, 10, 1, 6)]) {
  for (const d of [-HOUR, -1, 0, 1, HOUR, DAY - change % DAY, 2 * DAY - change % DAY]) ENDS.push(change + d);
}
ENDS.sort((a, b) => a - b);

for (const [period, zones, counts] of [
  ['day', ['UTC', 'America/New_York', 'Asia/Kathmandu'], [1, 20]],
  ['week', ['UTC', 'America/New_York'], [1, 5, 20]],
  ['month', ['UTC', 'Australia/Lord_Howe'], [1, 4]],
  ['sessions', ['UTC'], [1, 20]],
] as const) {
  test(`the ${period} calendar picks what a chart zoomed out drew, panned forth and back, at every count`, () => {
    for (const zone of zones) for (const count of counts) {
      const k = kind(period, zone, count), calendar = new LinesCalendar();
      // Forth, then back: the calendar is laid out again as the edge leaves it, and reused inside it.
      for (const end of [...ENDS, ...[...ENDS].reverse()]) assert.deepEqual(ids(calendar.windows(k, 'utc', end, count)), reference(k, end, count), `${period} ${zone} count ${count} at ${new Date(end).toISOString()}`);
      // Laid out again only each time the edge has moved four weeks past what was laid out, either way.
      const most = 2 * Math.ceil((ENDS.at(-1)! - ENDS[0]!) / (28 * DAY)) + 2;
      assert.ok(calendar.layouts <= most, `${period} ${zone} ${count}: laid out ${calendar.layouts} times for ${2 * ENDS.length} frames (at most ${most})`);
    }
  });
}

test('a window that begins exactly at the edge is not drawn yet; a millisecond later it is', () => {
  const k = kind('day'), calendar = new LinesCalendar(), midnight = Date.UTC(2026, 10, 10);
  const at = calendar.windows(k, 'utc', midnight, 3), after = calendar.windows(k, 'utc', midnight + 1, 3);
  assert.equal(at.at(-1)!.to, midnight, 'the last drawn ends where the edge is');
  assert.equal(after.at(-1)!.from, midnight, 'the day that began at the edge, once the edge passes its start');
  assert.deepEqual(ids(at), reference(k, midnight, 3));
  assert.deepEqual(ids(after), reference(k, midnight + 1, 3));
});

test('panning inside one window lays nothing out again and hands back the same windows', () => {
  const k = kind('day', 'America/New_York'), calendar = new LinesCalendar(), noon = Date.UTC(2026, 10, 11, 17);
  const first = calendar.windows(k, 'utc', noon, 5), layouts = calendar.layouts;
  for (let i = 1; i < 60; i++) assert.equal(calendar.windows(k, 'utc', noon + i * 60_000, 5), first, 'the same array a minute later');
  assert.equal(calendar.layouts, layouts);
  assert.notEqual(calendar.windows(k, 'utc', noon + DAY, 5), first, 'the next day changes it');
  assert.equal(calendar.layouts, layouts, 'a day further is still inside what was laid out');
  assert.notEqual(calendar.windows(k, 'utc', noon, 4), first, 'another count is another answer');
});

test('a weekday session gets its whole count however far the chart is zoomed in', () => {
  const k = kind('sessions', 'UTC', 20), now = Date.UTC(2026, 10, 12, 18), calendar = new LinesCalendar();
  const us = calendar.windows(k, 'utc', now, 20).filter(w => w.key.startsWith('session|us|'));
  assert.equal(us.length, 20, 'twenty US sessions, weekends skipped');
  assert.ok(us.every(w => { const d = new Date(w.from).getUTCDay(); return d !== 0 && d !== 6; }));
  // What the old formula looked back zoomed in (count days and three more): fewer than twenty weekdays.
  const old = linesWindows(k, 'utc', now - 20 * DAY - 3 * DAY, now, now, 20).filter(w => w.key.startsWith('session|us|'));
  assert.ok(old.length < 20, `zoomed in it used to find ${old.length}`);
  assert.equal(calendar.windows(k, 'utc', now, 20).filter(w => w.key.startsWith('session|off|')).length, 0, 'a session switched off has none');
});

test('the zone and the sessions are part of the calendar: changing either lays it out again', () => {
  const calendar = new LinesCalendar(), end = Date.UTC(2026, 10, 11, 12);
  const utc = calendar.windows(kind('day', 'UTC'), 'utc', end, 3), n = calendar.layouts;
  const ny = calendar.windows(kind('day', 'America/New_York'), 'utc', end, 3);
  assert.equal(calendar.layouts, n + 1);
  assert.notDeepEqual(ids(ny), ids(utc));
  assert.deepEqual(ids(ny), reference(kind('day', 'America/New_York'), end, 3));
  const page = { ...kind('day', 'page') };
  assert.deepEqual(ids(calendar.windows(page, 'utc', end, 3)), ids(linesWindows(page, 'utc', end - 380 * DAY, end, end, 3)), 'the page zone, on UTC');
  const moved = kind('sessions'), later = { ...moved, sessions: SESSIONS.map(x => x.id === 'ldn' ? { ...x, start: '09:00' } : x) };
  calendar.windows(moved, 'utc', end, 3); const m = calendar.layouts;
  assert.deepEqual(ids(calendar.windows(later, 'utc', end, 3)), reference(later, end, 3));
  assert.equal(calendar.layouts, m + 1, 'a session moved is a new calendar');
});

test('no count, no windows; the reach always holds the count of every kind', () => {
  assert.deepEqual(new LinesCalendar().windows(kind('day'), 'utc', Date.UTC(2026, 10, 11), 0), []);
  for (const period of ['day', 'week', 'month', 'sessions'] as const) {
    const span = (period === 'month' ? 31 : period === 'week' ? 7 : 1) * DAY;
    for (let count = 1; count <= 20; count++) assert.ok(linesReach(period, count) >= Math.ceil(count * 7 / 5) * span + 3 * DAY, `${period} ${count}`);
  }
  // Laid out with its margins, the longest reach stays inside the 400 days the calendar lays out at most.
  assert.ok(linesReach('week', 20) + 2 * 28 * DAY < 400 * DAY);
  assert.ok(linesReach('month', 4) + 2 * 28 * DAY < 400 * DAY);
});
