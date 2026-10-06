// The page's first script: the language comes before anything is built, because the words are chosen as the page is made.
import { loadLanguage } from './i18n-load.ts';

await loadLanguage();
await import('./main.ts');
