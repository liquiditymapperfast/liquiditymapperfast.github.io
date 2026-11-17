/**
 * The scripts a person keeps: what each is, how it is kept in this browser and written to a file, and how a file or a pasted text is read
 * back. Nothing here runs a script. A file can come from anywhere, so every field is read again (`readScripts`), as an imported layout is.
 */

/** Where the scripts are kept in this browser. */
export const SCRIPTS_KEY = 'hlm-scripts-v1';
/** The marker and version of a scripts file written by Export. */
export const FILE_FORMAT = 'liquiditymapperfast-scripts', FILE_VERSION = 1;
/**
 * The version of the language and of the data a script reads (its words, its functions, the units of its inputs). Each script records the one
 * it was written for, so a later version that changes a meaning can read an older script as it was meant.
 */
export const SCRIPT_API = 3;
export const MAX_SCRIPTS = 20, MAX_NAME = 40, MAX_SOURCE_CHARS = 60_000, MAX_FILE_CHARS = 2_000_000;
/** The tallest and the shortest a script's row in the pane may be (px), and where it starts. */
export const ROW_MIN = 40, ROW_MAX = 600, ROW_DEFAULT = 110;

/** A value of a script's option: what a person sets for it, or a plot's style read from a file. */
export type OptionValue = number | string | boolean | null | OptionValue[] | { [key: string]: OptionValue };

export interface ScriptRecord {
  id: string;
  name: string;
  /** The script's text. */
  source: string;
  /** The values set for its options, by name (`options.length` in the text). */
  options: Record<string, OptionValue>;
  on: boolean;
  /** Hidden: it runs and alerts but draws nothing, and its line in the map legend (or its row) stays, to show it again. */
  hidden?: boolean;
  /** The `SCRIPT_API` it was written for. */
  api: number;
  /** Its row's height in the pane (px). */
  height: number;
  /**
   * Where it draws: a row of its own in the Scripts pane, or on the map, where the plots on the price scale (`priceScaleId` 'right', the
   * default of the scripts' language) are drawn at their prices and the others each on a scale of their own inside their margins.
   */
  place: 'pane' | 'map';
}

/** A name as it is kept: spaces collapsed and trimmed, at most `MAX_NAME` characters; null when nothing is left. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return name ? name : null;
}

/**
 * An option value as it is kept: finite numbers, short texts, true or false, and arrays or plain objects of those a few levels deep (a plot's
 * style, `scaleMargins: { top, bottom }`, comes nested). Anything else is dropped (undefined).
 */
export function readOptionValue(raw: unknown, depth = 0): OptionValue | undefined {
  if (raw === null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.length <= 2_000 ? raw : undefined;
  if (depth >= 3 || typeof raw !== 'object') return undefined;
  if (Array.isArray(raw)) return raw.slice(0, 64).map(v => readOptionValue(v, depth + 1)).filter((v): v is OptionValue => v !== undefined);
  return readOptions(raw, depth + 1);
}

/** The options of a script from storage or a file: at most 200, each name a plain identifier. */
export function readOptions(raw: unknown, depth = 0): Record<string, OptionValue> {
  const out: Record<string, OptionValue> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 200) break;
    if (!/^[A-Za-z_$][\w$]{0,63}$/.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const v = readOptionValue(value, depth);
    if (v !== undefined) { out[key] = v; n++; }
  }
  return out;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A fresh id for a script: its name as letters and digits, and a random tail so two scripts of one name stay apart. */
export function newId(name: string, random: () => number = Math.random): string {
  const slug = name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'script';
  return `${slug}-${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`;
}

/** One script from storage or a file, or null. A missing id is made; the `api` it was written for is kept, a newer one too (it is then not run). */
export function readScript(raw: unknown): ScriptRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const name = cleanName(r.name);
  if (!name || typeof r.source !== 'string' || r.source.length > MAX_SOURCE_CHARS) return null;
  const id = typeof r.id === 'string' && ID_RE.test(r.id) ? r.id : newId(name);
  const api = typeof r.api === 'number' && Number.isInteger(r.api) && r.api >= 1 ? Math.min(r.api, 999) : SCRIPT_API;
  const height = typeof r.height === 'number' && Number.isFinite(r.height) ? Math.max(ROW_MIN, Math.min(ROW_MAX, Math.round(r.height))) : ROW_DEFAULT;
  return { id, name, source: r.source.replace(/\r\n?/g, '\n'), options: readOptions(r.options), on: r.on !== false, ...(r.hidden === true ? { hidden: true } : {}), api, height, place: r.place === 'map' ? 'map' : 'pane' };
}

/** Scripts from storage or a file: the valid ones, at most `MAX_SCRIPTS`, one per id (the later one wins). */
export function readScripts(raw: unknown): ScriptRecord[] {
  let out: ScriptRecord[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const s = readScript(item);
    if (!s) continue;
    out = out.filter(o => o.id !== s.id);
    out.push(s);
  }
  return out.slice(-MAX_SCRIPTS);
}

/** The scripts file: a marker, a version and the scripts. */
export function exportFile(list: readonly ScriptRecord[]): string {
  return JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, scripts: list }, null, 2);
}

/**
 * An indicator as another charting page writes it: `{ name, script, options }`, alone, wrapped as `{ type: 'indicator', data: { ... } }`, or
 * as the indicators of a saved workspace (`states.<pane>.indicators.<id>`). The candles a workspace draws by itself (an indicator that only
 * plots the price) are left out: the map has its own.
 */
function indicatorsIn(raw: unknown): ScriptRecord[] {
  const out: ScriptRecord[] = [];
  const one = (v: unknown): void => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    const r = v as Record<string, unknown>;
    if (typeof r.script !== 'string') return;
    if (/^\s*plotcandlestick\(\s*avg_ohlc\(\s*bar\s*\)\s*\)\s*$/.test(r.script)) return;
    // An indicator on the price scale was drawn over the candles where it was written: it goes on the map here.
    const options = r.options && typeof r.options === 'object' ? r.options as Record<string, unknown> : {};
    const s = readScript({ name: r.displayName ?? r.name ?? r.id, source: r.script, options: r.options, on: true, place: options.priceScaleId === 'right' ? 'map' : 'pane' });
    if (s) out.push(s);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (r.type === 'indicator' && r.data && typeof r.data === 'object') { one({ name: r.name, ...(r.data as Record<string, unknown>) }); return out; }
  if (typeof r.script === 'string') { one(r); return out; }
  const states = r.states;
  if (states && typeof states === 'object') {
    for (const state of Object.values(states as Record<string, unknown>)) {
      const indicators = state && typeof state === 'object' ? (state as Record<string, unknown>).indicators : null;
      if (indicators && typeof indicators === 'object') for (const v of Object.values(indicators as Record<string, unknown>)) one(v);
    }
    return out;
  }
  if (r.indicators && typeof r.indicators === 'object') for (const v of Object.values(r.indicators as Record<string, unknown>)) one(v);
  return out;
}

/**
 * The scripts in a file or a pasted text, or why there are none: a scripts file written by Export, an indicator file or a workspace from another
 * charting page, or else the text itself as one script named `fallbackName`.
 */
export function importText(text: string, fallbackName: string): { scripts: ScriptRecord[] } | { error: 'too-large' | 'empty' | 'newer' } {
  if (text.length > MAX_FILE_CHARS) return { error: 'too-large' };
  const trimmed = text.trim();
  if (!trimmed) return { error: 'empty' };
  if (trimmed.startsWith('{')) {
    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { raw = undefined; }
    if (raw !== undefined) {
      const own = raw && typeof raw === 'object' && (raw as { format?: unknown }).format === FILE_FORMAT;
      // A scripts file of a later version may mean things this page reads otherwise: refused, not read as this version.
      if (own) { const v = (raw as { version?: unknown }).version; if (typeof v !== 'number' || v > FILE_VERSION) return { error: 'newer' }; }
      const scripts = own ? readScripts((raw as { scripts?: unknown }).scripts) : indicatorsIn(raw);
      return scripts.length ? { scripts } : { error: 'empty' };
    }
  }
  if (trimmed.length > MAX_SOURCE_CHARS) return { error: 'too-large' };
  const s = readScript({ name: fallbackName, source: text });
  return s ? { scripts: [s] } : { error: 'empty' };
}

/** `incoming` added to `list` (an id already there is replaced in its place); those that do not fit are counted, not added. */
export function mergeScripts(list: readonly ScriptRecord[], incoming: readonly ScriptRecord[]): { list: ScriptRecord[]; added: number; replaced: number; skipped: number } {
  const out = [...list];
  let added = 0, replaced = 0, skipped = 0;
  for (const s of incoming) {
    const at = out.findIndex(o => o.id === s.id);
    if (at >= 0) { out[at] = s; replaced++; continue; }
    if (out.length >= MAX_SCRIPTS) { skipped++; continue; }
    out.push(s); added++;
  }
  return { list: out, added, replaced, skipped };
}

/**
 * A value for an option a script reads (`options.name`) without declaring it, when nothing set one: guessed from its name as the indicator
 * editors scripts are written in guess it (a `...length` is 14, a `...color` a colour, a `...width` 1, a `show...`/`use...` switch on, a
 * multiplier 2). Null when the name says nothing: the panel then asks for it.
 */
export function inferredOption(name: string): OptionValue | null {
  const n = name.toLowerCase();
  if (/length$|period$|^len$/.test(n)) return 14;
  if (/colou?r$/.test(n)) return n.includes('down') || n.includes('sell') || n.includes('neg') ? '#ef5350' : n.includes('up') || n.includes('buy') || n.includes('pos') ? '#26a69a' : '#4f8ff7';
  if (/width$/.test(n)) return 1;
  if (/^(show|use|toggle|set|enable)[A-Z_]/.test(name)) return true;
  if (/mult|multiplier/.test(n)) return 2;
  return null;
}

/**
 * The scripts kept in this browser. A browser that has never kept any (a first visit, or storage the page cannot reach) gets `starter()`, the
 * scripts a page starts with; one that kept an empty list keeps it, and one that holds something unreadable gets none.
 */
export function loadScripts(storage?: Pick<Storage, 'getItem'> | null, starter: () => ScriptRecord[] = () => []): ScriptRecord[] {
  let raw: string | null = null;
  // Reaching the browser's storage can itself throw (a page whose storage is blocked): inside the guard.
  try { const s = storage === undefined ? globalThis.localStorage : storage; raw = s?.getItem(SCRIPTS_KEY) ?? null; } catch { raw = null; }
  if (raw === null) return starter();
  try { return readScripts(JSON.parse(raw)); } catch { return []; }
}
/** Keep the scripts in this browser; false when storage refused. */
export function storeScripts(list: readonly ScriptRecord[], storage?: Pick<Storage, 'setItem'> | null): boolean {
  try { const s = storage === undefined ? globalThis.localStorage : storage; if (!s) return false; s.setItem(SCRIPTS_KEY, JSON.stringify(list)); return true; } catch { return false; }
}
