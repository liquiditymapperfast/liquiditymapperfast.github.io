import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DAY_HOURS, PHONE_RECENT_HOURS, handheldPhone, historyHours, importSince, readPhoneHistory } from '../src/app/history-window.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR;

test('a phone reads the last few hours of the recorded history, a desktop the day; Settings and a browser saving data change it', () => {
  assert.equal(historyHours(false, 'recent', false), DAY_HOURS, 'a desktop reads the whole day, whatever a phone chose');
  assert.equal(historyHours(false, 'off', false), DAY_HOURS);
  assert.equal(historyHours(false, 'recent', true), 3, 'a desktop set to save data reads three hours');
  assert.equal(historyHours(true, 'recent', false), PHONE_RECENT_HOURS);
  assert.equal(PHONE_RECENT_HOURS, 3, 'the map a phone opens on spans about 75 minutes: three hours leave room to look back');
  assert.equal(historyHours(true, 'recent', true), 1, 'a phone set to save data reads one hour');
  assert.equal(historyHours(true, 'day', true), DAY_HOURS, 'a phone that asked for the day gets it, saving data or not');
  assert.equal(historyHours(true, 'off', false), 0, 'and one that asked for none reads none');
  assert.equal(DAY_HOURS * HOUR, DAY, 'a day is what the page keeps');
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
  for (const junk of [undefined, null, 3, 'week', {}]) assert.equal(readPhoneHistory(junk), 'recent');
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
  assert.match(toolbar, /setAttribute\('aria-pressed', String\(state\.phoneHistory === choice\)\)/, 'a screen reader hears which is chosen');
  assert.match(toolbar, /\.\.\.\(isHandheldPhone\(\) \? \[field\(t\('History'\)/, 'the control shows where the rule applies');
});
