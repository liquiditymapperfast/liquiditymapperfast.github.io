/**
 * How much of the recorded history (app/history-url.ts) a page reads when it opens. A desktop reads the whole day it keeps; a phone reads
 * the last few hours, which cover the map it opens on (about 75 minutes) with room to look back, at a few MB instead of the day's tens of
 * MB on a phone's data plan (Karl, 2026-11-02). A phone cannot be asked whether it is on Wi-Fi (iPhones say nothing about the network), so
 * the phone itself is the sign, and Settings on any touch screen can ask for the last hours, the whole day or none. A browser set to save
 * data reads the last hours too, wherever it runs.
 */

import { isCoarse } from './device.ts';

/** The choice in Settings: `auto` until one is made (a phone the last hours, anything else the day), then the hours, the day or nothing. */
export type PhoneHistory = 'auto' | 'recent' | 'day' | 'off';
export const PHONE_HISTORY: readonly PhoneHistory[] = ['auto', 'recent', 'day', 'off'];
export const readPhoneHistory = (v: unknown): PhoneHistory => PHONE_HISTORY.includes(v as PhoneHistory) ? v as PhoneHistory : 'auto';

/** The last hours: what a phone reads by default. */
export const PHONE_RECENT_HOURS = 3;
/** A day: everything the page keeps (shared/recorder.ts BROWSER_RETENTION_MS). */
export const DAY_HOURS = 24;

/**
 * What the choice comes to here: `auto` is the last hours on a phone in the hand or in a browser set to save data, and the day anywhere
 * else. A choice made holds wherever Settings can change it (`choosable`: the compact bar, whose Settings sheet holds it), however the
 * device is held (a folding phone opened out). Where the desktop's full bar is up there is no Settings sheet, so a choice made does not
 * apply there and the page reads as any desktop does: a choice that could not be changed back would be stuck. Settings lights exactly
 * this, so what it shows is what the next opening reads.
 */
export const effectiveChoice = (phone: boolean, choice: PhoneHistory, saveData: boolean, choosable: boolean): Exclude<PhoneHistory, 'auto'> =>
  choosable && choice !== 'auto' ? choice : phone || saveData ? 'recent' : 'day';

/** The hours of history to read on opening: 0 reads none. `phone` is a phone in the hand (`isHandheldPhone`). */
export function historyHours(phone: boolean, choice: PhoneHistory, saveData: boolean, choosable: boolean): number {
  const chosen = effectiveChoice(phone, choice, saveData, choosable);
  return chosen === 'off' ? 0 : chosen === 'recent' ? PHONE_RECENT_HOURS : DAY_HOURS;
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
