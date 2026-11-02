/**
 * How much of the recorded history (app/history-url.ts) a page reads when it opens. A desktop reads the whole day it keeps; a phone reads
 * the last few hours, which cover the map it opens on (about 75 minutes) with room to look back, at a few MB instead of the day's tens of
 * MB on a phone's data plan (Karl, 2026-11-02). A phone cannot be asked whether it is on Wi-Fi (iPhones say nothing about the network), so
 * the phone itself is the sign, and its Settings can ask for the whole day or for none. A browser set to save data reads one hour on a phone
 * and three on a desktop.
 */

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

/** The hours of history to read on opening: 0 reads none. `phone` is a phone held in the hand (a touch screen in the phone's arrangement). */
export function historyHours(phone: boolean, choice: PhoneHistory, saveData: boolean): number {
  if (!phone) return saveData ? SAVE_DATA_DESKTOP_HOURS : DAY_HOURS;
  if (choice === 'off') return 0;
  if (choice === 'day') return DAY_HOURS;
  return saveData ? SAVE_DATA_PHONE_HOURS : PHONE_RECENT_HOURS;
}

/** Whether the browser says it is set to save data (Chrome and Edge on Android do; Safari has no way to say so). */
export function savesData(): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { connection?: { saveData?: boolean } };
  return nav?.connection?.saveData === true;
}
