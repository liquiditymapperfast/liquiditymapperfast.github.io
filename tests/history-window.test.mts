import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DAY_HOURS, PHONE_RECENT_HOURS, effectiveChoice, handheldPhone, historyHours, importSince, readPhoneHistory } from '../src/app/history-window.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR;

test('a phone reads the last few hours of the recorded history, anything else the day; a choice or a browser saving data changes it', () => {
  // (phone in the hand, choice, saving data)
  assert.equal(historyHours(false, 'auto', false), DAY_HOURS, 'a desktop or a tablet reads the whole day');
  assert.equal(historyHours(true, 'auto', false), PHONE_RECENT_HOURS);
  assert.equal(PHONE_RECENT_HOURS, 3, 'the map a phone opens on spans about 75 minutes: three hours leave room to look back');
  assert.equal(historyHours(false, 'auto', true), 3, 'a browser set to save data reads the last hours, wherever it runs');
  assert.equal(historyHours(true, 'day', true), DAY_HOURS, 'a choice of the day holds, saving data or not');
  assert.equal(historyHours(true, 'off', false), 0, 'and a choice of none reads none');
  assert.equal(historyHours(false, 'recent', false), 3, 'a tablet that chose the last hours reads them');
  assert.equal(DAY_HOURS * HOUR, DAY, 'a day is what the page keeps');
  // What Settings lights is what the next opening reads, in every case (Sol round 3: "Day" lit while three hours loaded).
  for (const phone of [false, true]) for (const saveData of [false, true]) for (const choice of ['auto', 'recent', 'day', 'off'] as const) {
    const lit = effectiveChoice(phone, choice, saveData);
    assert.equal(historyHours(phone, choice, saveData), lit === 'off' ? 0 : lit === 'recent' ? 3 : 24, `${phone} ${choice} ${saveData}`);
  }
});

test('a choice made holds however the device is held or pointed at: a folding phone opened out, a tablet given a mouse', () => {
  // Galaxy Z Fold 5: 344 x 882 folded, 690 x 829 opened (Sol round 2); a mouse makes the primary pointer fine (round 3).
  const folded = handheldPhone(true, 344, 882), open = handheldPhone(true, 690, 829), mouse = handheldPhone(false, 344, 882);
  assert.deepEqual([folded, open, mouse], [true, false, false]);
  for (const choice of ['off', 'recent', 'day'] as const) for (const now of [open, mouse]) assert.equal(historyHours(now, choice, false), historyHours(folded, choice, false), choice);
  assert.equal(historyHours(open, 'off', false), 0);
  assert.equal(effectiveChoice(true, 'auto', false), 'recent', 'Settings lights what applies: the last hours on a phone');
  assert.equal(effectiveChoice(false, 'auto', false), 'day', 'and the day on a tablet');
});

test('the import starts at the start of the oldest hour, so the hour marked read was read whole; a day starts at the retention', () => {
  const now = Date.UTC(2026, 10, 2, 20, 25, 13);
  assert.equal(importSince(now, 3, DAY), Date.UTC(2026, 10, 2, 17), 'three hours back from 20:25 is 17:25: the 17:00 hour is taken whole');
  assert.equal(importSince(now, 1, DAY), Date.UTC(2026, 10, 2, 19));
  assert.equal(importSince(Date.UTC(2026, 10, 2, 20), 3, DAY), Date.UTC(2026, 10, 2, 17), 'on an hour boundary nothing is added');
  assert.equal(importSince(now, 24, DAY), now - DAY, 'a whole day: the retention, not a minute before it');
  assert.equal(importSince(now, 48, DAY), now - DAY);
  for (const hours of [1, 2, 3, 5]) assert.equal(importSince(now, hours, DAY) % HOUR, 0);
});

test('a phone in the hand is a touch screen with a phone\'s short side, however it is held; a tablet is not one', () => {
  assert.equal(handheldPhone(true, 390, 844), true, 'an iPhone upright');
  assert.equal(handheldPhone(true, 844, 390), true, 'and sideways');
  assert.equal(handheldPhone(true, 412, 915), true, 'an Android phone');
  assert.equal(handheldPhone(true, 820, 1180), false, 'an iPad upright: the same as sideways');
  assert.equal(handheldPhone(true, 1180, 820), false);
  assert.equal(handheldPhone(false, 390, 844), false, 'a narrow desktop window has a mouse');
});

test('a saved choice is read back; anything else is the default', () => {
  assert.equal(readPhoneHistory('day'), 'day');
  assert.equal(readPhoneHistory('off'), 'off');
  assert.equal(readPhoneHistory('recent'), 'recent');
  assert.equal(readPhoneHistory('auto'), 'auto');
  for (const junk of [undefined, null, 3, 'week', {}]) assert.equal(readPhoneHistory(junk), 'auto');
});

test('the worker reads only the hours asked for, and none at 0; its recordings keep their day; the setting redraws when chosen', () => {
  const worker = fs.readFileSync('src/app/browser/feeds.worker.ts', 'utf8');
  assert.match(worker, /if \(history && historyHours > 0\)/, 'no hours asked for: no request at all');
  assert.match(worker, /since = importSince\(now, historyHours, BROWSER_RETENTION_MS\)/, 'the import window');
  assert.match(worker, /openRecordings\(database, Date\.now\(\) - BROWSER_RETENTION_MS/, 'retention is not the import window');
  const main = fs.readFileSync('src/app/main.ts', 'utf8');
  assert.match(main, /historyHours\(isHandheldPhone\(\), phoneHistory, savesData\(\)\)/, 'a phone in the hand, not the phone arrangement');
  assert.match(main, /'chartType', 'phoneHistory'\]\.some\(k => changed\.has\(k as never\)\)\) toolbar\.sync/, 'choosing redraws the choice');
  const toolbar = fs.readFileSync('src/app/toolbar.ts', 'utf8');
  assert.match(toolbar, /setAttribute\('aria-pressed', String\(historyNow === choice\)\)/, 'a screen reader hears which is chosen');
  assert.match(toolbar, /effectiveChoice\(isHandheldPhone\(\), state\.phoneHistory, savesData\(\)\)/, 'the choice lit is the one that applies');
  assert.match(toolbar, /\.\.\.\(isCoarse\(\) \|\| this\.store\.state\.phoneHistory !== 'auto' \? \[field\(t\('History'\)/, 'every touch screen can choose, and one that chose keeps the control');
});
