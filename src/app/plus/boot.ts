// The Plus page's first script: its language first, as on the app (`../boot.ts`), then the page.
import { loadLanguage } from '../i18n-load.ts';

await loadLanguage();
await import('./page.ts');
