// Every text of the guide a language pack has to cover, with the English as the starting value, for a new language:
//
//   npm run i18n:guide -- ko > src/app/guide/i18n/ko.json     (then translate the values)
//
// The guide's own words (its sections, captions, key rows and what its pictures draw) live apart from the page's words so that a page that never
// opens the guide never downloads them; tests/app-guide-i18n.test.mts fails until every pack has every text, keeps each text's markup
// (`**bold**`, `*italic*`, `code`, [[Key]] caps, {placeholders}) and has nothing the guide no longer says.
import fs from 'node:fs';
import path from 'node:path';
import { SECTIONS } from '../src/app/guide/content.ts';
import { guideStrings } from '../src/app/guide/strings.ts';

const figures = fs.readFileSync(path.resolve(process.cwd(), 'src', 'app', 'guide', 'figures.ts'), 'utf8');
const out: Record<string, string> = {};
for (const text of guideStrings(SECTIONS, figures)) out[text] = text;
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
