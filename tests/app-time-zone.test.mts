import test from 'node:test';
import assert from 'node:assert/strict';
import { clock, dayOfMonth, setTimeZone, timeZone, zoneName, zoneOffsetMs, type TimeZone } from '../src/app/format.ts';
import { timeTicks } from '../src/app/panes/heat-pane.ts';
import { fileName } from '../src/app/screenshot/shapes.ts';

// The clock the page's times are on: the computer's own or UTC. The tests do not depend on the zone of the machine they run on.

const on = (zone: TimeZone, run: () => void): void => { setTimeZone(zone); try { run(); } finally { setTimeZone('local'); } };
const two = (n: number): string => String(n).padStart(2, '0');
/** 23:30 UTC on 6 October: another calendar day in every zone east of UTC+0:30. */
const LATE = Date.UTC(2026, 9, 6, 23, 30);

test('UTC writes the UTC clock and the computer\'s own writes its wall clock, by the same functions', () => {
  on('utc', () => {
    assert.equal(timeZone(), 'utc');
    assert.equal(clock(LATE), '23:30');
    assert.equal(clock(LATE, true), 'Oct 6 23:30');
    assert.equal(dayOfMonth(LATE), 6);
    assert.equal(zoneOffsetMs(LATE), 0);
    assert.equal(zoneName(), 'UTC');
  });
  on('local', () => {
    const d = new Date(LATE);
    assert.equal(clock(LATE), `${two(d.getHours())}:${two(d.getMinutes())}`);
    assert.equal(clock(LATE, true), `Oct ${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`);
    assert.equal(dayOfMonth(LATE), d.getDate());
    assert.equal(zoneOffsetMs(LATE), -d.getTimezoneOffset() * 60_000);
    assert.ok(zoneName().length > 0, 'the label always says something');
  });
  assert.equal(zoneName('utc'), 'UTC', 'the name of a zone can be asked for without switching to it');
  setTimeZone('bogus' as never); assert.equal(timeZone(), 'local', 'a saved value that is neither is the computer\'s clock');
});

test('the time axis puts its ticks on the clock the labels are written in', () => {
  const t0 = Date.UTC(2026, 9, 6, 10, 7), t1 = t0 + 4 * 3_600_000;
  for (const zone of ['utc', 'local'] as const) on(zone, () => {
    const ticks = timeTicks(t0, t1, 960, 96), step = ticks[1]! - ticks[0]!;
    assert.ok(ticks.length >= 3 && step >= 60_000);
    for (const t of ticks) assert.equal((t + zoneOffsetMs(t)) % step, 0, `${zone}: the tick at ${clock(t)} is on a multiple of ${step / 60_000} minutes of the wall clock`);
  });
});

test('a screenshot is named by the clock the page is on', () => {
  const when = new Date(Date.UTC(2026, 9, 5, 14, 3, 7));
  assert.equal(fileName(when, true), 'liquiditymapperfast-2026-10-05-1403-07.png');
  assert.equal(fileName(new Date(2026, 9, 5, 14, 3, 7)), 'liquiditymapperfast-2026-10-05-1403-07.png', 'by default the computer\'s own');
});
