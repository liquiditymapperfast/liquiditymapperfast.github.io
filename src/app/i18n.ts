/**
 * The words on the page, in the language of the person using it.
 *
 * The English text is the key: `t('Guide')` is "Guide" unless the loaded language pack has another word for it. Text with a number or a
 * name in it says where that goes in braces (`t('{n} of {total} shown', { n, total })`), and a count that changes the wording goes through
 * `tn`. A pack is a plain JSON file in `i18n/`, one per language (see `docs/languages.md`); a word it does not have stays English, so a
 * half-finished pack never leaves a hole.
 *
 * This module is plain code with nothing to load, so anything can import it, tests included. Which language is chosen, and fetching its
 * file, happens before the page is built (`i18n-load.ts`, started by `boot.ts`).
 */

/** What a pack says for one English text: a string, or a string for each plural form of a count (`one`, `few`, `many`, `other`). */
export type Entry = string | Readonly<Partial<Record<Intl.LDMLPluralRule, string>>>;
export type Pack = Readonly<Record<string, Entry>>;
export type Params = Readonly<Record<string, string | number>>;

export interface Language {
  code: string;
  /** The language's name in itself, which is how a person looking for it recognises it. */
  name: string;
}

/** Every language the page can speak, English first. Adding one is a file in `i18n/` and a line here. */
export const LANGUAGES: readonly Language[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'pt', name: 'Português' },
  { code: 'it', name: 'Italiano' },
  { code: 'ru', name: 'Русский' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'zh', name: '中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
];

let pack: Pack = {};
let current = 'en';
let rules = new Intl.PluralRules('en');

/** Start speaking `code` with the words in `words` (nothing for English, which is the text in the source). */
export function setLanguage(code: string, words: Pack = {}): void {
  current = code;
  pack = words;
  try { rules = new Intl.PluralRules(code); } catch { rules = new Intl.PluralRules('en'); }
}

/** The language in use. */
export const language = (): string => current;

const fill = (text: string, params?: Params): string => params ? text.replace(/\{(\w+)\}/g, (whole, name: string) => name in params ? String(params[name]) : whole) : text;

/** `text` in the current language, with `{name}` replaced from `params`. */
export function t(text: string, params?: Params): string {
  const entry = pack[text];
  return fill(typeof entry === 'string' ? entry : text, params);
}

/**
 * A count that changes the wording: `tn(n, '{n} note', '{n} notes')`. `{n}` is the count. The English forms are the key (the second is
 * how the pack finds it); a language with more forms than English (Russian has three) lists each of its own in the pack.
 */
export function tn(count: number, one: string, other: string, params: Params = {}): string {
  const entry = pack[other];
  // A word the pack does not have is English, whose two forms are the two texts given.
  const text = typeof entry === 'object' ? entry[rules.select(count)] ?? entry.other : typeof entry === 'string' ? entry : count === 1 ? one : other;
  return fill(text ?? other, { n: count, ...params });
}

/** Languages by what a person asked for, most specific first. `zh-TW` and `zh-Hans` both mean the one Chinese pack there is. */
const candidates = (tag: string): string[] => {
  const full = tag.toLowerCase().replace(/_/g, '-'), base = full.split('-')[0] ?? full;
  return full === base ? [full] : [full, base];
};

/**
 * Which language to speak. A language asked for in the address (`?lang=de`) wins, then the one chosen in Settings, then the first of the
 * browser's own preferences (its languages in order) that the page speaks, then English.
 */
export function pickLanguage(browser: readonly string[], available: readonly string[], saved: string | null = null, asked: string | null = null): string {
  const has = (code: string): boolean => available.includes(code);
  for (const wanted of [asked, saved]) {
    const code = wanted?.toLowerCase();
    if (code && code !== 'auto' && has(code)) return code;
  }
  for (const tag of browser) for (const code of candidates(tag)) if (has(code)) return code;
  return 'en';
}

const KEY = 'hlm-lang';

/** What the person chose in Settings: a language code, or `auto` (follow the browser) when they have not chosen. */
export function savedLanguage(): string {
  try { return window.localStorage.getItem(KEY) ?? 'auto'; } catch { return 'auto'; }
}

export function saveLanguage(choice: string): void {
  try { if (choice === 'auto') window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, choice); } catch { /* storage unavailable: the choice lasts until the page is reloaded */ }
}
