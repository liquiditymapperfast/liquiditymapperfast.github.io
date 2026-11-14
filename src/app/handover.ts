/**
 * What a browser saved on the old address, carried over to the new one. The site moved from liquiditymapperfast.github.io to
 * liquiditymapper.com in November 2026, and what a browser keeps (layouts, drawings, scripts, settings, the coin and the venues) belongs to
 * the address it was saved on. The old address's page (`tools/moved-site/`) reads it there and opens the new address with it in the
 * fragment, which no server receives; this module, the first one `boot.ts` loads, takes it before anything reads storage.
 *
 * It is taken only when the page that sent it is the old address (the referrer: no other site can hand anything over), only once per
 * browser, and only into a browser that has no layouts, drawings or scripts here yet, so nothing made here is ever overwritten or mixed
 * with older work: all of it or none. The fragment is always removed. Remove this module once the old address stops handing over.
 */

export const OLD_ORIGIN = 'https://liquiditymapperfast.github.io';
export const PREFIX = '#hlm-handover=';
/** Set once a hand-over was taken (its time), so a later visit from the old address changes nothing. */
export const DONE_KEY = 'hlm-handover-v1';
/** A browser holding any of these has work of its own here: a hand-over would overwrite it, so none is taken. */
export const OWN_WORK = ['hlm-layouts-v1', 'hlm-drawings-v1', 'hlm-scripts-v1'] as const;
/** The longest hand-over read (characters of the fragment); the old page sends none longer. */
export const MAX_CHARS = 2_000_000;

/** The keys a hand-over may write: the page's own (`hlm-…`, `lmf.…`), never the cached coin list, the stale-build marks or the marker. */
export function handedKey(key: string): boolean {
  if (!/^(?:hlm-[a-z0-9][a-z0-9:._-]{0,79}|lmf\.[a-z0-9][a-z0-9._-]{0,79})$/.test(key)) return false;
  return key !== 'lmf.coins' && key !== 'hlm-stale' && key !== 'hlm-stale-reload' && key !== DONE_KEY;
}

/** Text to the fragment's form: UTF-8, then base64 with `-` and `_` and no padding. */
export function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The fragment's form back to text, or null when it is not one. */
export function decode(data: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(data)) return null;
  try {
    const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return null; }
}

/** The items a hand-over carries (`{ v: 1, items: { key: value } }`), or null when it is malformed or carries a key it may not write. */
export function itemsOf(text: string): Record<string, string> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== 1) return null;
  const items = (parsed as { items?: unknown }).items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(items)) {
    if (!handedKey(key) || typeof value !== 'string') return null;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

export type Verdict = { take: Record<string, string> } | { skip: 'none' | 'referrer' | 'done' | 'own-work' | 'malformed' };

/** What to do with the address's fragment `hash`, sent from `referrer`, into a storage where `has(key)` says what is there already. */
export function decide(hash: string, referrer: string, has: (key: string) => boolean): Verdict {
  if (!hash.startsWith(PREFIX)) return { skip: 'none' };
  if (referrer !== OLD_ORIGIN && !referrer.startsWith(`${OLD_ORIGIN}/`)) return { skip: 'referrer' };
  if (has(DONE_KEY)) return { skip: 'done' };
  if (OWN_WORK.some(has)) return { skip: 'own-work' };
  const data = hash.slice(PREFIX.length);
  const text = data.length <= MAX_CHARS ? decode(data) : null;
  const items = text === null ? null : itemsOf(text);
  return items ? { take: items } : { skip: 'malformed' };
}

/** Writes the items, all or none (a full storage puts back what each key held before, its new value removed first to free the room), then the marker; true when they were written. */
export function write(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, items: Record<string, string>, now: number): boolean {
  const before: [string, string | null][] = [];
  try {
    for (const [key, value] of Object.entries(items)) { before.push([key, storage.getItem(key)]); storage.setItem(key, value); }
    storage.setItem(DONE_KEY, String(now));
    return true;
  } catch {
    for (const [key, value] of before.reverse()) {
      try { storage.removeItem(key); if (value !== null) storage.setItem(key, value); } catch { /* storage unavailable: nothing more to put back */ }
    }
    return false;
  }
}

/** Takes a hand-over from the address, if there is one and this is not the old address: the fragment goes in every case, the items only as `decide` says. */
export function takeHandover(): void {
  if (typeof location === 'undefined' || !location.hash.startsWith(PREFIX) || location.origin === OLD_ORIGIN) return;
  const hash = location.hash;
  try { history.replaceState(history.state, '', location.pathname + location.search); } catch { /* the fragment stays in the address; it is still taken once */ }
  try {
    const storage = window.localStorage;
    const verdict = decide(hash, document.referrer, key => storage.getItem(key) !== null);
    if ('take' in verdict) write(storage, verdict.take, Date.now());
  } catch { /* storage unavailable: the page starts as a new visitor's */ }
}
