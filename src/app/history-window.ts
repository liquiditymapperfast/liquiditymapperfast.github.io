/**
 * How much of the recorded history (app/history-url.ts) a page reads when it opens. A desktop reads the whole day it keeps; a phone reads
 * the last few hours, which cover the map it opens on (about 75 minutes) with room to look back, at a few MB instead of the day's tens of
 * MB on a phone's data plan (Karl, 2026-11-02). A phone cannot be asked whether it is on Wi-Fi (iPhones say nothing about the network), so
 * the phone itself is the sign, and its Settings can ask for the whole day or for none. A browser set to save data reads one hour on a phone
 * and three on a desktop.
 */

import { isCoarse } from './device.ts';

/** A phone's choice: the last few hours (the default), the whole day the page keeps, or nothing. */
export type PhoneHistory = 'recent' | 'day' | 'off';
export const PHONE_HISTORY: readonly PhoneHistory[] = ['recent', 'day', 'off'];
export const readPhoneHistory = (v: unknown): PhoneHistory => PHONE_HISTORY.includes(v as PhoneHistory) ? v as PhoneHistory : 'recent';

/** The hours a phone reads by default. */
export const PHONE_RECENT_HOURS = 3;
/** The hours read where the browser is set to save data: a phone's default, and a desktop's. */
export const SAVE_DATA_PHONE_HOURS = 1;
export const SAVE_DATA_DESKTOP_HOURS = 3;
/** A day: everything the page keeps (shared/recorder.ts BROWSER_RETENTION_MS). */
export const DAY_HOURS = 24;

/** The hours of history to read on opening: 0 reads none. `phone` is a phone held in the hand (`isHandheldPhone`). */
export function historyHours(phone: boolean, choice: PhoneHistory, saveData: boolean): number {
  if (!phone) return saveData ? SAVE_DATA_DESKTOP_HOURS : DAY_HOURS;
  if (choice === 'off') return 0;
  if (choice === 'day') return DAY_HOURS;
  return saveData ? SAVE_DATA_PHONE_HOURS : PHONE_RECENT_HOURS;
}

const HOUR_MS = 3_600_000;
/**
 * Where the import starts: the start of the hour the window's first minute falls in, so the oldest hour is taken whole (the hour file is
 * downloaded whole anyway, and an hour taken is marked read, never read again: a part left out would stay out). A window of the whole day
 * starts where the recordings' retention does.
 */
export function importSince(now: number, hours: number, retentionMs: number): number {
  const span = hours * HOUR_MS;
  return span >= retentionMs ? now - retentionMs : Math.floor((now - span) / HOUR_MS) * HOUR_MS;
}

/**
 * A phone in the hand: a touch screen whose shorter side is a phone's, however it is held. A tablet is not one, upright or sideways (the
 * page's phone arrangement takes a tablet held upright too, so it cannot be the sign: the download would change with the orientation).
 */
export const PHONE_SHORT_SIDE_MAX = 600;
export const handheldPhone = (coarse: boolean, screenWidth: number, screenHeight: number): boolean => coarse && Math.min(screenWidth, screenHeight) < PHONE_SHORT_SIDE_MAX;
export const isHandheldPhone = (): boolean => typeof screen !== 'undefined' && handheldPhone(isCoarse(), screen.width, screen.height);

/** Whether the browser says it is set to save data (Chrome and Edge on Android do; Safari has no way to say so). */
export function savesData(): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { connection?: { saveData?: boolean } };
  return nav?.connection?.saveData === true;
}
