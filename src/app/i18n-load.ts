import { LANGUAGES, pickLanguage, savedLanguage, setLanguage, type Pack } from './i18n.ts';

/** The language files, each fetched only when its language is the one in use. */
const packs = import.meta.glob<Pack>('./i18n/*.json', { import: 'default' });

/**
 * Decide the language (the address, then Settings, then the browser) and have its words ready, so the page is built in it from the first
 * frame. A language file that cannot be fetched leaves the page in English rather than not starting.
 */
export async function loadLanguage(): Promise<string> {
  const code = pickLanguage(navigator.languages?.length ? navigator.languages : [navigator.language], LANGUAGES.map(l => l.code), savedLanguage(), new URLSearchParams(window.location.search).get('lang'));
  const load = packs[`./i18n/${code}.json`];
  let spoken = 'en';
  if (code !== 'en' && load) {
    try { setLanguage(code, await load()); spoken = code; } catch (error) { console.error(`The ${code} language file could not be loaded; the page stays in English.`, error); }
  }
  if (spoken === 'en') setLanguage('en');
  document.documentElement.lang = spoken;
  return spoken;
}
