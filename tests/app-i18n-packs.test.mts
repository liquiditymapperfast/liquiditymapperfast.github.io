import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { LANGUAGES, type Entry } from '../src/app/i18n.ts';
import { appRoot, keysInSource, sources, template } from '../scripts/i18n-keys.mts';

const packsDir = path.join(appRoot, 'i18n');

/** Files that carry the page's words: everything but the guide's long text, the language machinery, workers and brand tables. */
const SKIPPED = /^(format\.ts|guide\/|venues\.ts|i18n|boot\.ts|worker\/|wire\.ts|watermark\.ts|theme\.ts$|browser\/feeds)/;

/** Every English text the page asks to have translated (the calls to t() and tn() in the source, the guide's own chrome included). */
const keysInPage = (): Set<string> => new Set(keysInSource().keys());

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort();
const forms = (entry: Entry): string[] => typeof entry === 'string' ? [entry] : Object.values(entry).filter((v): v is string => typeof v === 'string');

function packs(): Map<string, Record<string, Entry>> {
  const found = new Map<string, Record<string, Entry>>();
  if (!fs.existsSync(packsDir)) return found;
  for (const name of fs.readdirSync(packsDir)) if (/^[a-z]{2}\.json$/.test(name)) found.set(name.slice(0, 2), JSON.parse(fs.readFileSync(path.join(packsDir, name), 'utf8')) as Record<string, Entry>);
  return found;
}

test('the page has words to translate, and every one of them is a plain English sentence', () => {
  const keys = keysInPage();
  assert.ok(keys.size > 350, `only ${keys.size} texts found`);
  for (const key of keys) {
    assert.ok(!/<|>/.test(key), `markup in a key: ${key}`);
  }
});

test('every language the page lists has a pack, and every pack belongs to a listed language', () => {
  const found = packs();
  for (const { code } of LANGUAGES) if (code !== 'en') assert.ok(found.has(code), `no pack for ${code}`);
  for (const code of found.keys()) assert.ok(LANGUAGES.some(l => l.code === code), `a pack for ${code}, which is not listed`);
  assert.ok(!found.has('en'), 'English is the source text and has no pack');
});

test('a pack has no text the page no longer asks for, and says every placeholder the English does', () => {
  const keys = keysInPage();
  for (const [code, pack] of packs()) {
    for (const [key, entry] of Object.entries(pack)) {
      assert.ok(keys.has(key), `${code}: "${key}" is not in the page any more`);
      for (const text of forms(entry)) {
        assert.deepEqual(placeholders(text), placeholders(key), `${code}: placeholders of "${key}"`);
        assert.ok(text.trim().length > 0, `${code}: "${key}" is empty`);
        assert.ok(!/[<>]/.test(text), `${code}: markup in the translation of "${key}"`);
        assert.ok(!/&\w+;|&#/.test(text), `${code}: an entity in the translation of "${key}"`);
      }
    }
  }
});

test('every pack says every text the page asks for (the guide\'s long text is the one thing still in English)', () => {
  const keys = keysInPage();
  for (const [code, pack] of packs()) {
    const missing = [...keys].filter(key => !(key in pack));
    assert.deepEqual(missing.slice(0, 8), [], `${code} lacks ${missing.length} of ${keys.size}`);
  }
});

test('a count that changes the wording has the forms its language needs', () => {
  const keys = keysInPage();
  for (const [code, pack] of packs()) {
    const needed = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const [key, entry] of Object.entries(pack)) {
      if (!keys.has(key) || typeof entry === 'string') continue;
      for (const form of needed) assert.ok(typeof entry[form] === 'string', `${code}: "${key}" lacks the "${form}" form`);
    }
  }
});

/** ---- text the page shows that is not going through t() ---------------------------------------------------------------------------- */

const proseLike = (s: string): boolean => /[A-Za-z]{2}/.test(s) && (/\s/.test(s.trim()) ? /[a-z]{2}/i.test(s) : /^[A-Z][a-z]{2,}/.test(s));
const EXCLUDE = new Set(['chip blocked faulty', 'chip blocked', 'muted blocked', 'LiquidityMapperFast', 'Karl']);
const notText = (s: string): boolean => EXCLUDE.has(s) || /[<>{}]|;[^ ]|^[^ ]*;|=>|^[.#[]|https?:|\.(png|svg|css|json|ts)$|^\d+(\.\d+)?px |monospace|sans-serif|^[a-z]+(-[a-z0-9]+)+( [a-z0-9-]+)*$|^[a-z]+ [a-z]$|^(M|L|C|A|Z)[\d\s.,-]/.test(s) || /^[a-z]+(-[a-z]+)* (current|on|off|v|h|in|open|plain)$/.test(s);
const CALL_SKIP = /(^|\.)(querySelector|querySelectorAll|closest|matches|setProperty|getPropertyValue|addEventListener|removeEventListener|getItem|setItem|removeItem|createElement|createElementNS|getElementById|set|get|has|delete|getAttribute|importScripts|fetch|WebSocket|postMessage|log|warn|error|info|debug|test|includes|startsWith|endsWith|replace|replaceAll|split|join|indexOf|push|Number|String|parseInt|parseFloat|toggle|add|remove|dispatchEvent|Error|URL|Worker|matchMedia|measureText|createLinearGradient|addColorStop|assert|equal|Symbol|RegExp|padStart|padEnd|localeCompare|append|before|after|select|toggleAttribute|animate|requestFullscreen|scrollIntoView|focus|execCommand|canPlayType|decodeURIComponent|encodeURIComponent|JSON\.parse|JSON\.stringify|Intl\.\w+|DOMParser|Date)$/;
const ASSIGN_TEXT = /(^|\.)(textContent|innerText|title|placeholder|ariaLabel|label|text|alt)$/;
const PROP_SKIP = /^(class|type|id|key|role|kind|source|mode|value|rel|href|src|target|name|display|position|color|background|font|cursor|width|height|tag|icon|data|slug|layout|theme|state|status|side|dir|unit|market|scope|marketType|svg|path|html|selector|css|shape|tool|style|format|from|to|variant|tab|section|group|code|tier|anchor|align|origin|channel|event|method|url|endpoint|topic|stat|view|axis|ladderShow|show|sort)$/;

/** Text in the source that a person would read, written outside t(): where a new string forgot to go through it. */
function untranslated(): string[] {
  const found: string[] = [];
  for (const { file, rel } of sources()) {
    if (SKIPPED.test(rel)) continue;
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    (function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
      if (ts.isCallExpression(node) && ['t', 'tn'].includes(node.expression.getText())) return;
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && proseLike(node.text) && !notText(node.text)) {
        const p = node.parent;
        let loud = false;
        if (ts.isPropertyAssignment(p) && p.initializer === node) loud = !PROP_SKIP.test(p.name.getText());
        else if (ts.isCallExpression(p)) { const callee = p.expression.getText(); loud = !CALL_SKIP.test(callee); if (callee.endsWith('setAttribute')) loud = p.arguments[1] === node && /^(aria-label|title|placeholder|alt|aria-description)$/.test(p.arguments[0]?.getText().slice(1, -1) ?? ''); }
        else if (ts.isNewExpression(p)) loud = p.expression.getText() === 'Option' && p.arguments?.[0] === node;
        else if (ts.isBinaryExpression(p)) {
          const op = p.operatorToken.kind;
          if (op === ts.SyntaxKind.EqualsToken) loud = p.right === node && ASSIGN_TEXT.test(p.left.getText());
          else loud = [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.PlusToken].includes(op);
        }
        else if (ts.isConditionalExpression(p) && p.condition !== node) loud = true;
        else if (ts.isArrayLiteralExpression(p) || ts.isReturnStatement(p) || ts.isArrowFunction(p) || ts.isVariableDeclaration(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isPropertyDeclaration(p)) loud = true;
        if (loud) found.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}  ${node.text.slice(0, 70)}`);
      }
      ts.forEachChild(node, visit);
    })(sf);
  }
  return found;
}

/** Words that are deliberately the same in every language: names, abbreviations, the status words a server sends and code reads. */
const ALLOWED = new Set<string>();

test('no text a person reads is left outside t() (add a new sentence to the page the way the others are: t(\'...\'))', () => {
  const left = untranslated().filter(line => !ALLOWED.has(line));
  assert.deepEqual(left, []);
});

test('the template for a new language has every text, and a form for each way that language counts', () => {
  const keys = keysInPage();
  for (const code of ['ru', 'ja', 'es']) {
    const pack = template(code);
    assert.deepEqual(Object.keys(pack).sort(), [...keys].sort(), code);
    const counted = pack['{n} notes'];
    const forms = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    if (forms.length > 1) { assert.ok(typeof counted === 'object'); assert.deepEqual(Object.keys(counted as object).sort(), [...forms].sort(), code); assert.equal((counted as Record<string, string>).one, '{n} note'); }
    else assert.equal(counted, '{n} notes', `${code} counts one way: a plain text`);
  }
});
