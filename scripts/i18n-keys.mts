// The English texts the page asks to have translated (every t('...') and tn(n, 'one', 'other') in src/app), and a template for a new language.
//
//   npm run i18n:template -- ko > src/app/i18n/ko.json     (then translate the values; add { code: 'ko', name: '한국어' } to LANGUAGES in src/app/i18n.ts)
//
// The test in tests/app-i18n-packs.test.mts uses the same extraction, so a text that is added to the page shows up here and fails there until
// every pack has it.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export const appRoot = path.resolve(process.cwd(), 'src', 'app');

export interface Source { rel: string; file: string }

/** Every .ts file of the page, relative to src/app. */
export function sources(root: string = appRoot): Source[] {
  const out: Source[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push({ rel: path.relative(root, file).split(path.sep).join('/'), file });
    }
  };
  walk(root);
  return out;
}

/** The text a call names, when it is a plain string. */
const literal = (node: ts.Node | undefined): string | null => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

/** Each text the page translates; for a count that changes the wording, `one` is its English singular (the key is the plural). */
export function keysInSource(root: string = appRoot): Map<string, { one: string | null }> {
  const keys = new Map<string, { one: string | null }>();
  for (const { file, rel } of sources(root)) {
    if (/^(i18n|boot\.ts)/.test(rel)) continue;
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    (function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 't') { const key = literal(node.arguments[0]); if (key !== null && !keys.has(key)) keys.set(key, { one: null }); }
        else if (node.expression.text === 'tn') { const key = literal(node.arguments[2]); if (key !== null) keys.set(key, { one: literal(node.arguments[1]) }); }
      }
      ts.forEachChild(node, visit);
    })(sf);
  }
  return keys;
}

/** A pack for `code` with every text still in English, and a count's text given a form for each way that language counts. */
export function template(code: string, keys: ReadonlyMap<string, { one: string | null }> = keysInSource()): Record<string, string | Record<string, string>> {
  const forms = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
  const pack: Record<string, string | Record<string, string>> = {};
  for (const [key, { one }] of keys) pack[key] = one !== null && forms.length > 1 ? Object.fromEntries(forms.map(form => [form, form === 'one' ? one : key])) : key;
  return pack;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = process.argv[2];
  if (!code || !/^[a-z]{2}$/.test(code)) { console.error('usage: npm run i18n:template -- <two-letter language code>   (writes a JSON pack to the standard output)'); process.exit(1); }
  process.stdout.write(JSON.stringify(template(code), null, 1) + '\n');
}
