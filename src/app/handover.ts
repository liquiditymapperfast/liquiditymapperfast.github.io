/**
 * What a browser saved on the old address, carried over to the new one. The site moved from liquiditymapperfast.github.io to
 * liquiditymapper.com in November 2026, and what a browser keeps (layouts, drawings, scripts, settings, the coin and the venues) belongs to
 * the address it was saved on. The old address's page (`moved-site/`) reads it there and opens the new address with it in the fragment,
 * which no server receives; this module, the first thing `boot.ts` runs, takes it before anything reads storage.
 *
 * It is taken only when the page that sent it is the old address (the referrer), only from the address this document was loaded with (the
 * navigation entry: a fragment another window sets later, which keeps the document and its referrer, is never read), only on a plain
 * navigation (not a reload or a step back), only once per browser, and only into a browser that has no layouts, drawings or scripts here
 * yet, so nothing made here is ever overwritten or mixed with older work: all of it or none. The fragment is always removed from the
 * address; a guide section the old address was opened on rides after the data (`~guide/ladder`) and is put back whatever happens to the
 * data. Remove this module once the old address stops handing over.
 */

export const OLD_ORIGIN = 'https://liquiditymapperfast.github.io';
export const PREFIX = '#hlm-handover=';
/** Set once a hand-over was taken (its time), so a later visit from the old address changes nothing. */
export const DONE_KEY = 'hlm-handover-v1';
/** A browser holding any of these has work of its own here: a hand-over would overwrite it, so none is taken. */
export const OWN_WORK = ['hlm-layouts-v1', 'hlm-drawings-v1', 'hlm-scripts-v1'] as const;
/** The longest hand-over read (characters after the prefix); the old page keeps the whole address under 1,000,000 (Firefox's limit is 2^20). */
export const MAX_CHARS = 1_000_000;
/** The most a hand-over unpacks to (bytes): more than a browser lets a site store, and a bound on what a small fragment may inflate to. */
export const MAX_BYTES = 6_000_000;

/** The keys a hand-over may write: the page's own (`hlm-…`, `lmf.…`), never the cached coin list, the stale-build marks or the marker. */
export function handedKey(key: string): boolean {
  if (!/^(?:hlm-[a-z0-9][a-z0-9:._-]{0,79}|lmf\.[a-z0-9][a-z0-9._-]{0,79})$/.test(key)) return false;
  return key !== 'lmf.coins' && key !== 'hlm-stale' && key !== 'hlm-stale-reload' && key !== DONE_KEY;
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromBase64Url = (data: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(data)) return null;
  try {
    const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch { return null; }
};
/** `bytes` through a (de)compression stream, or null past `MAX_BYTES`. */
async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array | null> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { void reader.cancel(); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/**
 * Text to the fragment's form: `z` and deflate-raw where the browser compresses (a settings object shrinks several times), else `j` and the
 * UTF-8 bytes as they are; then base64 with `-` and `_` and no padding. The old page's script does the same.
 */
export async function encode(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  try {
    const packed = typeof CompressionStream === 'function' ? await through(bytes, new CompressionStream('deflate-raw')) : null;
    if (packed) return `z${toBase64Url(packed)}`;
  } catch { /* a browser that has the stream but not this format: the plain form */ }
  return `j${toBase64Url(bytes)}`;
}

/** The fragment's form back to text, or null when it is not one (or this browser cannot unpack it). */
export async function decode(data: string): Promise<string | null> {
  const mode = data[0], bytes = fromBase64Url(data.slice(1));
  if (!bytes) return null;
  try {
    const raw = mode === 'j' ? bytes : mode === 'z' && typeof DecompressionStream === 'function' ? await through(bytes, new DecompressionStream('deflate-raw')) : null;
    if (raw && raw.length <= MAX_BYTES) return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch { /* not UTF-8, or not a deflate stream */ }
  return null;
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

/** The guide section a hand-over fragment names after its data (`…~guide/ladder` gives `#guide/ladder`), or ''. */
export function guideOf(hash: string): string {
  const at = hash.lastIndexOf('~');
  const section = at < 0 ? '' : hash.slice(at + 1);
  return /^guide(?:\/[a-z-]+)?$/.test(section) ? `#${section}` : '';
}

export type Gate = { data: string } | { skip: 'none' | 'not-navigate' | 'referrer' | 'done' | 'own-work' | 'too-long' };

/**
 * Whether the document loaded from `url` by a navigation of `type`, sent from `referrer`, carries a hand-over to read into a storage where
 * `has(key)` says what is there already: the data after the prefix, or why not.
 */
export function gate(url: string, type: string, referrer: string, has: (key: string) => boolean): Gate {
  const at = url.indexOf(PREFIX);
  if (at < 0 || url.indexOf('#') !== at) return { skip: 'none' };
  if (type !== 'navigate') return { skip: 'not-navigate' };
  if (referrer !== OLD_ORIGIN && !referrer.startsWith(`${OLD_ORIGIN}/`)) return { skip: 'referrer' };
  if (has(DONE_KEY)) return { skip: 'done' };
  if (OWN_WORK.some(has)) return { skip: 'own-work' };
  const data = url.slice(at + PREFIX.length).split('~')[0]!;
  return data.length <= MAX_CHARS ? { data } : { skip: 'too-long' };
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

/** The address with its fragment replaced by `hash` (from the whole address, so a path like `//x` stays this origin's). */
export function withHash(href: string, hash: string): string {
  const url = new URL(href);
  url.hash = hash;
  return url.href;
}

/** Takes a hand-over this document was loaded with, if there is one and this is not the old address. */
export async function takeHandover(): Promise<void> {
  if (typeof location === 'undefined' || location.origin === OLD_ORIGIN || !location.hash.startsWith(PREFIX)) return;
  const guide = guideOf(location.hash);
  try {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const storage = window.localStorage;
    const verdict: Gate = entry ? gate(entry.name, entry.type, document.referrer, key => storage.getItem(key) !== null) : { skip: 'none' };
    if ('data' in verdict) {
      const text = await decode(verdict.data);
      const items = text === null ? null : itemsOf(text);
      if (items) write(storage, items, Date.now());
    }
  } catch { /* storage unavailable: the page starts as a new visitor's */ }
  try { history.replaceState(history.state, '', withHash(location.href, guide)); } catch { /* the fragment stays in the address; it is taken once */ }
}
