import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LANGUAGES } from '../src/app/i18n.ts';
import { SECTIONS } from '../src/app/guide/content.ts';
import { figureStrings, guideStrings, markupOf } from '../src/app/guide/strings.ts';
import { setGuideWords, tg } from '../src/app/guide/words.ts';
import { appRoot } from '../scripts/i18n-keys.mts';

const dir = path.join(appRoot, 'guide', 'i18n');
const figuresSource = fs.readFileSync(path.join(appRoot, 'guide', 'figures.ts'), 'utf8');
const strings = guideStrings(SECTIONS, figuresSource);
const languages = LANGUAGES.filter(l => l.code !== 'en').map(l => l.code);
const pack = (code: string): Record<string, string> => JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8')) as Record<string, string>;

test('the guide has words to translate: its text and what its pictures draw', () => {
  assert.ok(strings.length > 150, `only ${strings.length} texts`);
  assert.ok(strings.includes('The flow column'), 'a section title');
  assert.ok(strings.includes('Zoomed out'), 'a word a picture draws');
  assert.ok(strings.some(s => s.startsWith('The heatmap and the book show what traders')), 'a paragraph');
  assert.equal((figuresSource.match(/\btg\(/g) ?? []).length, figureStrings(figuresSource).length, 'every tg() in the pictures is given a plain literal, so its text can be found');
  assert.ok(!strings.some(s => /<|>/.test(s)), 'no markup in what is translated');
});

test('every language has a guide pack, and it says every text of the guide and nothing the guide no longer says', () => {
  for (const code of languages) {
    assert.ok(fs.existsSync(path.join(dir, `${code}.json`)), `no guide pack for ${code}`);
    const words = pack(code), have = new Set(Object.keys(words)), want = new Set(strings);
    assert.deepEqual(strings.filter(s => !have.has(s)), [], `${code} lacks texts`);
    assert.deepEqual([...have].filter(s => !want.has(s)), [], `${code} has texts the guide no longer says`);
    for (const [key, value] of Object.entries(words)) assert.ok(typeof value === 'string' && value.trim().length > 0, `${code}: "${key.slice(0, 40)}" is empty`);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'en.json')), 'English is the source text and has no pack');
});

test('a translation keeps the markup of its text: bold, italic, code spans, key caps and placeholders', () => {
  for (const code of languages) {
    for (const [key, value] of Object.entries(pack(code))) {
      const a = markupOf(key), b = markupOf(value), where = `${code}: "${key.slice(0, 50)}"`;
      assert.equal(b.bold, a.bold, `${where}: bold marks`);
      assert.equal(b.italic, a.italic, `${where}: italic marks`);
      assert.equal(b.code, a.code, `${where}: code marks`);
      assert.deepEqual(b.placeholders, a.placeholders, `${where}: placeholders`);
      assert.equal(b.keys.length, a.keys.length, `${where}: key caps`);
      // A key cap is a key on the keyboard and stays as written; only the mouse wheel, which is not one, is named in the language.
      a.keys.forEach((cap, i) => { if (cap !== 'Wheel') assert.equal(b.keys[i], cap, `${where}: the key ${cap}`); });
      assert.ok(!/<|>/.test(value), `${where}: markup`);
    }
  }
});

test('a pack is a translation: almost no text is left as it is in English', () => {
  for (const code of languages) {
    const same = Object.entries(pack(code)).filter(([key, value]) => key === value && key.length > 12).map(([key]) => key);
    assert.ok(same.length <= Math.ceil(strings.length * 0.03), `${code} leaves ${same.length} texts in English: ${same.slice(0, 3).join(' | ')}`);
  }
});

test('the guide says a word in its language, fills its placeholders, and keeps English for a word it does not have', () => {
  setGuideWords({ 'Zoomed out': 'Alejado', '{n} min ago': 'hace {n} min' });
  assert.equal(tg('Zoomed out'), 'Alejado');
  assert.equal(tg('{n} min ago', { n: 75 }), 'hace 75 min');
  assert.equal(tg('Hover'), 'Hover');
  assert.equal(tg('{n} min', { n: 3 }), '3 min');
  setGuideWords({});
  assert.equal(tg('Zoomed out'), 'Zoomed out');
});
