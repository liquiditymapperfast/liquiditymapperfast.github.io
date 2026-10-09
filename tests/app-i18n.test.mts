import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LANGUAGES, language, pickLanguage, setLanguage, t, tn, type Pack } from '../src/app/i18n.ts';
import { appRoot } from '../scripts/i18n-keys.mts';

const codes = LANGUAGES.map(l => l.code);

test('the browser\'s first language the page speaks is the one chosen, and English when it speaks none', () => {
  assert.equal(pickLanguage(['de-DE', 'en'], codes), 'de');
  assert.equal(pickLanguage(['sv', 'fr-CA', 'en'], codes), 'fr', 'an unsupported language is skipped for the next one');
  assert.equal(pickLanguage(['pt-BR'], codes), 'pt');
  assert.equal(pickLanguage(['zh-TW'], codes), 'zh', 'there is one Chinese pack, and it serves every Chinese tag');
  assert.equal(pickLanguage(['zh-Hant-HK'], codes), 'zh');
  assert.equal(pickLanguage(['sv', 'nb'], codes), 'en');
  assert.equal(pickLanguage([], codes), 'en');
  assert.equal(pickLanguage(['de_AT'], codes), 'de', 'an underscore is a hyphen');
  assert.equal(pickLanguage(['EN-us', 'de'], codes), 'en', 'English first means English, not the next language down');
});

test('a choice in Settings beats the browser, and the address beats both', () => {
  assert.equal(pickLanguage(['de'], codes, 'ja'), 'ja');
  assert.equal(pickLanguage(['de'], codes, 'auto'), 'de', 'auto is following the browser');
  assert.equal(pickLanguage(['de'], codes, 'xx'), 'de', 'a saved language that no longer exists is ignored');
  assert.equal(pickLanguage(['de'], codes, 'ja', 'ko'), 'ko');
  assert.equal(pickLanguage(['de'], codes, 'ja', 'KO'), 'ko', 'case does not matter');
  assert.equal(pickLanguage(['de'], codes, null, 'nope'), 'de');
});

test('t finds the English text in the pack, fills the braces, and leaves what it does not know in English', () => {
  setLanguage('de', { Guide: 'Anleitung', '{n} of {total} shown': '{n} von {total} angezeigt' });
  try {
    assert.equal(language(), 'de');
    assert.equal(t('Guide'), 'Anleitung');
    assert.equal(t('{n} of {total} shown', { n: 3, total: 9 }), '3 von 9 angezeigt');
    assert.equal(t('Settings'), 'Settings', 'a word the pack lacks is English');
    assert.equal(t('{a} and {b}', { a: 'x' }), 'x and {b}', 'a value that was not given stays as it was written');
    assert.equal(t('Price is ${price}', { price: '$5' }), 'Price is $$5', 'a dollar sign in the text or the value is not a replacement pattern');
  } finally { setLanguage('en'); }
  assert.equal(language(), 'en');
  assert.equal(t('Guide'), 'Guide');
});

test('tn picks the form for the count: English has two, Russian has three, and an untranslated count stays English', () => {
  assert.equal(tn(1, '{n} note', '{n} notes'), '1 note');
  assert.equal(tn(2, '{n} note', '{n} notes'), '2 notes');
  assert.equal(tn(0, '{n} note', '{n} notes'), '0 notes');
  setLanguage('ru', { '{n} notes': { one: '{n} нота', few: '{n} ноты', many: '{n} нот', other: '{n} ноты' } });
  try {
    assert.equal(tn(1, '{n} note', '{n} notes'), '1 нота');
    assert.equal(tn(3, '{n} note', '{n} notes'), '3 ноты');
    assert.equal(tn(5, '{n} note', '{n} notes'), '5 нот');
    assert.equal(tn(21, '{n} note', '{n} notes'), '21 нота');
    assert.equal(tn(11, '{n} note', '{n} notes'), '11 нот');
  } finally { setLanguage('en'); }
  setLanguage('de', {});
  try { assert.equal(tn(1, '{n} note', '{n} notes'), '1 note', 'a language with no entry says it in English, one form per count'); } finally { setLanguage('en'); }
  setLanguage('ja', { '{n} notes': '{n} 音' });
  try { assert.equal(tn(1, '{n} note', '{n} notes'), '1 音'); assert.equal(tn(7, '{n} note', '{n} notes'), '7 音'); } finally { setLanguage('en'); }
});

test('tn picks the Ukrainian forms from the real pack: one, few, many and, for a fraction, other', () => {
  const uk = JSON.parse(fs.readFileSync(path.join(appRoot, 'i18n', 'uk.json'), 'utf8')) as Pack;
  setLanguage('uk', uk);
  try {
    const say = (n: number): string => tn(n, '{n} note', '{n} notes');
    assert.equal(say(1), '1 нота');
    assert.equal(say(21), '21 нота');
    assert.equal(say(2), '2 ноти');
    assert.equal(say(24), '24 ноти');
    assert.equal(say(5), '5 нот');
    assert.equal(say(11), '11 нот');
    assert.equal(say(0), '0 нот');
    assert.equal(say(1.5), '1.5 ноти');
  } finally { setLanguage('en'); }
});

test('every language the page lists has a name written in itself, and codes are unique and lower-case', () => {
  assert.equal(codes[0], 'en');
  assert.equal(new Set(codes).size, codes.length);
  for (const l of LANGUAGES) { assert.match(l.code, /^[a-z]{2}$/); assert.ok(l.name.length > 1); }
});
