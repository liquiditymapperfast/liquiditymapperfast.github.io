// The page's first script: the language comes before anything is built, because the words are chosen as the page is made.
import { loadLanguage } from './i18n-load.ts';
import { lazy } from './lazy.ts';

await loadLanguage();
// The rest of the page is a file of its own: a page opened before the site was rebuilt asks for one that is gone, and reloads once (see lazy.ts).
await lazy(() => import('./main.ts'));
