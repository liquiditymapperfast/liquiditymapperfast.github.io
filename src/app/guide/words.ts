/**
 * The guide's words in the language of the page. English is the key, as in `i18n.ts`: `tg('Zoomed out')` is "Zoomed out" until the guide's own
 * pack for the language (`src/app/guide/i18n/<code>.json`, fetched when the guide opens) has another word for it. The guide's text and the
 * words its pictures draw are here, not in the page's packs, so a page that never opens the guide never downloads them. Plain code with nothing
 * to load, so tests import it; `guide.ts` fetches the pack and calls `setGuideWords`.
 */
let words: Readonly<Record<string, string>> = {};

export function setGuideWords(next: Readonly<Record<string, string>>): void { words = next; }

const fill = (text: string, params?: Readonly<Record<string, string | number>>): string => params ? text.replace(/\{(\w+)\}/g, (whole, name: string) => name in params ? String(params[name]) : whole) : text;

/** `text` in the guide's language, with `{name}` replaced from `params`. */
export function tg(text: string, params?: Readonly<Record<string, string | number>>): string {
  const word = words[text];
  return fill(typeof word === 'string' ? word : text, params);
}
