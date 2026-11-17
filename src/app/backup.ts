import { DONE_KEY, handedKey } from './handover.ts';

/**
 * A backup: everything this page keeps in this browser's storage, in one file a person can keep or carry to another browser or computer:
 * the settings, the saved layouts, the scripts, the drawings, their own themes, the coin and the venues (every key `handedKey` lets through:
 * the page's own `hlm-…` and `lmf.…` keys, never the cached coin list or the page's own marks). Not the recorded market history, which lives
 * in IndexedDB and is rebuilt as the page runs.
 *
 * Restoring replaces what the page keeps, all or none, and never mixes a backup into a running page: the backup is left in `sessionStorage`
 * and the page reloads; `takeRestore`, the second thing boot.ts runs (after the hand-over from the old address), writes it before anything
 * reads storage, so no part of the page that is still open can write its own state back over it. Each key's own reader checks what it reads
 * as it always does, so a backup from anywhere is read like a saved page.
 */

export const BACKUP_FORMAT = 'liquiditymapperfast-backup', BACKUP_VERSION = 1;
/** Where a restore waits for the reload (this tab only), and where the reloaded page finds how it went. */
export const PENDING_KEY = 'hlm-restore-pending', RESULT_KEY = 'hlm-restore-result';
/** A browser lets a site keep about 5 MB; a file far larger is something else. */
export const MAX_BACKUP_CHARS = 6_000_000;
/** Set when a restore was written (its time): another tab of the page holds the setup from before and must not write it back (main.ts). */
export const RESTORED_KEY = 'hlm-restored-at';
/**
 * Keys that belong to this browser and never travel: when this browser opened each coin's recordings, by which it deletes the old ones
 * (coin.ts `keepCoinRecordings`; another browser's dates would delete recordings made here), and the restore's own mark.
 */
const LOCAL_ONLY: readonly string[] = ['lmf.coins.opened', RESTORED_KEY];
/** A key a backup holds and a restore replaces: one of the page's own (`handedKey`) that is not this browser's alone. */
export const backedKey = (key: string): boolean => handedKey(key) && !LOCAL_ONLY.includes(key);

type Readable = Pick<Storage, 'length' | 'key' | 'getItem'>;
type Writable = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

/** The page's own keys in `storage`, with their values. */
export function collectItems(storage: Readable): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key === null || !backedKey(key)) continue;
    const value = storage.getItem(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

/** The backup file: a marker, a version, when it was made and the items. */
export function backupFile(items: Readonly<Record<string, string>>, now: number): string {
  return JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, savedAt: now, items }, null, 1);
}

/** The other files the page writes, by their marker: told apart from a backup so the person can be sent to where they are read. */
const OTHER_FILES: Readonly<Record<string, 'layouts' | 'themes' | 'scripts'>> = {
  'liquiditymapperfast-layouts': 'layouts', 'liquiditymapperfast-themes': 'themes', 'liquiditymapperfast-scripts': 'scripts',
};

export type BackupRead =
  | { items: Record<string, string>; savedAt: number }
  | { error: 'not-backup' | 'newer' | 'empty' | 'too-large' }
  | { error: 'other'; kind: 'layouts' | 'themes' | 'scripts' };

/** The items in a backup file, or why it is not one. Every key must be one of the page's own and every value text, or nothing is read. */
export function readBackup(text: string): BackupRead {
  if (text.length > MAX_BACKUP_CHARS) return { error: 'too-large' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { error: 'not-backup' }; }
  if (!raw || typeof raw !== 'object') return { error: 'not-backup' };
  const r = raw as { format?: unknown; version?: unknown; savedAt?: unknown; items?: unknown };
  if (typeof r.format === 'string' && Object.hasOwn(OTHER_FILES, r.format)) return { error: 'other', kind: OTHER_FILES[r.format]! };
  if (r.format !== BACKUP_FORMAT) return { error: 'not-backup' };
  if (typeof r.version !== 'number' || r.version > BACKUP_VERSION) return { error: 'newer' };
  if (!r.items || typeof r.items !== 'object' || Array.isArray(r.items)) return { error: 'not-backup' };
  const items: Record<string, string> = {};
  for (const [key, value] of Object.entries(r.items)) {
    if (!handedKey(key) || typeof value !== 'string') return { error: 'not-backup' };
    // This browser's own bookkeeping in a file from another one is left out, never written.
    if (!backedKey(key)) continue;
    items[key] = value;
  }
  if (!Object.keys(items).length) return { error: 'empty' };
  const savedAt = typeof r.savedAt === 'number' && r.savedAt > 0 && r.savedAt < 32_503_680_000_000 ? r.savedAt : 0;
  return { items, savedAt };
}

/**
 * The page's keys in `storage` made exactly `items`: those it does not name are removed. All or none: when the browser refuses a write (full),
 * every key is put back as it was and false comes back.
 */
export function replaceAll(storage: Writable, items: Readonly<Record<string, string>>): boolean {
  const before = collectItems(storage);
  try {
    for (const key of Object.keys(before)) storage.removeItem(key);
    for (const [key, value] of Object.entries(items)) storage.setItem(key, value);
    return true;
  } catch {
    try {
      for (const key of Object.keys(collectItems(storage))) storage.removeItem(key);
      for (const [key, value] of Object.entries(before)) storage.setItem(key, value);
    } catch { /* storage unavailable: nothing more to put back */ }
    return false;
  }
}

/**
 * Leave a restore for the reload; false when this tab's storage would not hold it (then `replaceAll` is the way, written now). The items are
 * read again from the file's text by `takeRestore`, so what waits is checked twice.
 */
export function queueRestore(session: Pick<Storage, 'setItem'>, text: string): boolean {
  try { session.setItem(PENDING_KEY, text); return true; } catch { return false; }
}

/**
 * At the page's start: a restore left for this load is written (`replaceAll`) and taken away, and how it went is left for the page to say
 * (`restoreResult`). Whether one was written.
 */
export function takeRestore(local: Writable | null = safe('localStorage'), session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safe('sessionStorage')): boolean {
  if (!local || !session) return false;
  let text: string | null = null;
  try { text = session.getItem(PENDING_KEY); session.removeItem(PENDING_KEY); } catch { return false; }
  if (text === null) return false;
  const read = readBackup(text);
  if (!('items' in read)) { try { session.setItem(RESULT_KEY, 'failed'); } catch { /* the page then says nothing */ } return false; }
  // Other tabs of the page hear of it first (`storage` events come in the order of the writes): they stop writing before they see any key change,
  // or one reacting to a key the restore removed (a theme of one's own gone) would write its settings back over the restore (main.ts).
  try { local.setItem(RESTORED_KEY, String(Date.now())); } catch { /* storage full: the replacement below says so */ }
  const ok = replaceAll(local, read.items);
  try { session.setItem(RESULT_KEY, ok ? 'ok' : 'failed'); } catch { /* the page then says nothing */ }
  // A later visit from the old address hands nothing over this setup (handover.ts).
  if (ok) try { if (local.getItem(DONE_KEY) === null) local.setItem(DONE_KEY, String(Date.now())); } catch { /* storage full: the restore stands */ }
  return ok;
}
/** How a restore at this page's start went, once (null: there was none). */
export function restoreResult(session: Pick<Storage, 'getItem' | 'removeItem'> | null = safe('sessionStorage')): 'ok' | 'failed' | null {
  try { const v = session?.getItem(RESULT_KEY) ?? null; session?.removeItem(RESULT_KEY); return v === 'ok' || v === 'failed' ? v : null; } catch { return null; }
}

function safe(name: 'localStorage' | 'sessionStorage'): Storage | null {
  try { return typeof window === 'undefined' ? null : window[name]; } catch { return null; }
}
