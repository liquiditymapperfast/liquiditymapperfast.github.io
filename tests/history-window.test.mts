import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DAY_HOURS, PHONE_RECENT_HOURS, historyHours, readPhoneHistory } from '../src/app/history-window.ts';

test('a phone reads the last few hours of the recorded history, a desktop the day; Settings and a browser saving data change it', () => {
  assert.equal(historyHours(false, 'recent', false), DAY_HOURS, 'a desktop reads the whole day, whatever a phone chose');
  assert.equal(historyHours(false, 'off', false), DAY_HOURS);
  assert.equal(historyHours(false, 'recent', true), 3, 'a desktop set to save data reads three hours');
  assert.equal(historyHours(true, 'recent', false), PHONE_RECENT_HOURS);
  assert.equal(PHONE_RECENT_HOURS, 3, 'the map a phone opens on spans about 75 minutes: three hours leave room to look back');
  assert.equal(historyHours(true, 'recent', true), 1, 'a phone set to save data reads one hour');
  assert.equal(historyHours(true, 'day', true), DAY_HOURS, 'a phone that asked for the day gets it, saving data or not');
  assert.equal(historyHours(true, 'off', false), 0, 'and one that asked for none reads none');
  assert.equal(DAY_HOURS * 3_600_000, 24 * 3_600_000, 'a day is what the page keeps');
});

test('a saved choice is read back; anything else is the default', () => {
  assert.equal(readPhoneHistory('day'), 'day');
  assert.equal(readPhoneHistory('off'), 'off');
  assert.equal(readPhoneHistory('recent'), 'recent');
  for (const junk of [undefined, null, 3, 'week', {}]) assert.equal(readPhoneHistory(junk), 'recent');
});

test('the worker reads only the hours asked for, and none at 0; its recordings keep their day', () => {
  const worker = fs.readFileSync('src/app/browser/feeds.worker.ts', 'utf8');
  assert.match(worker, /if \(history && historyHours > 0\)/, 'no hours asked for: no request at all');
  assert.match(worker, /since = now - Math\.min\(BROWSER_RETENTION_MS, historyHours \* HOUR_MS\)/, 'the import window, never longer than the day kept');
  assert.match(worker, /openRecordings\(database, Date\.now\(\) - BROWSER_RETENTION_MS/, 'retention is not the import window');
  const main = fs.readFileSync('src/app/main.ts', 'utf8');
  assert.match(main, /historyHours\(isPhone\(\) && isCoarse\(\), phoneHistory, savesData\(\)\)/, 'a phone in the hand: a narrow desktop window reads the day');
});
