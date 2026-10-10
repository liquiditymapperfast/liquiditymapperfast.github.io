import test from 'node:test';
import assert from 'node:assert/strict';
import { SHORTCUTS, matchShortcut, togglePatch, type Feature, type KeyPress } from '../src/app/shortcuts.ts';
import type { AppState } from '../src/app/store.ts';

const press = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({ key, code: extra.code ?? `Key${key.toUpperCase()}`, ctrlKey: false, metaKey: false, altKey: false, repeat: false, target: { tagName: 'CANVAS' }, ...extra });
const kind = (e: KeyPress, dialog = false) => { const s = matchShortcut(e, dialog); return s ? s.action.kind === 'toggle' ? `toggle:${s.action.feature}` : s.action.kind === 'timeframe' ? `tf:${s.action.tf}` : s.action.kind : null; };

test('letters by what they type, digits by where they are, and the keys that need a modifier on some layouts', () => {
  assert.equal(kind(press('f')), 'toggle:footprint');
  assert.equal(kind(press('F')), 'toggle:footprint', 'Caps Lock or Shift: the same letter');
  assert.equal(kind(press('r')), 'recenter');
  assert.equal(kind(press('Home', { code: 'Home' })), 'recenter');
  assert.equal(kind(press('1', { code: 'Digit1' })), 'tf:1m');
  assert.equal(kind(press('&', { code: 'Digit1' })), 'tf:1m', 'AZERTY types & on the 1 key');
  assert.equal(kind(press('7', { code: 'Numpad7' })), 'tf:1d');
  assert.equal(kind(press('8', { code: 'Digit8' })), null);
  assert.equal(kind(press('?', { code: 'Slash' })), 'list', 'whatever Shift it took to type');
  assert.equal(kind(press('+', { code: 'NumpadAdd' })), 'zoom');
  assert.equal(kind(press('=', { code: 'Equal' })), 'zoom', 'the + key without Shift on a US keyboard');
});

test('a key is left alone while typing, with a window open, with a modifier, or once something else used it', () => {
  assert.equal(kind(press('r', { ctrlKey: true })), null, 'Ctrl+R reloads the page and does nothing else');
  assert.equal(kind(press('s', { metaKey: true })), null);
  assert.equal(kind(press('f', { ctrlKey: true, altKey: true })), null, 'AltGr types a character on many layouts');
  assert.equal(kind(press('f', { target: { tagName: 'INPUT' } })), null);
  assert.equal(kind(press('f', { target: { tagName: 'SELECT' } })), null, 'a select takes letters to choose its options');
  assert.equal(kind(press('f', { target: { tagName: 'DIV', isContentEditable: true } })), null);
  assert.equal(kind(press('f'), true), null, 'the coin picker or the screenshot editor is open');
  assert.equal(kind(press('Home', { code: 'Home', defaultPrevented: true })), null, 'a menu moved to its first row');
});

test('a switch does not flip back and forth while its key is held; zoom repeats', () => {
  assert.equal(kind(press('f', { repeat: true })), null);
  assert.equal(kind(press('-', { code: 'Minus', repeat: true })), 'zoom');
});

test('no two shortcuts share a key, and every switch has one', () => {
  const seen = new Set<string>();
  for (const s of SHORTCUTS) for (const k of [...(s.codes ?? []).map(c => `code:${c}`), ...(s.keys ?? []).map(k => `key:${k}`)]) { assert.ok(!seen.has(k), k); seen.add(k); }
  const features: Feature[] = ['footprint', 'trades', 'liquidations', 'absorption', 'traded', 'keyLevels', 'vwap', 'highlights'];
  assert.deepEqual(SHORTCUTS.flatMap(s => s.action.kind === 'toggle' ? [s.action.feature] : []).sort(), [...features].sort());
  assert.ok(!seen.has('key:m'), 'M is the Mirror toggle on the toolbar: not taken');
});

test('a switch flips its own feature and nothing else', () => {
  const state = { show: { footprint: false, bubbles: true, traded: false, mirror: true }, liquidations: { on: false, min: 1 }, absorption: { on: true }, keyLevels: { on: false }, vwap: { on: false }, highlight: { on: true } } as unknown as AppState;
  assert.deepEqual(togglePatch(state, 'footprint'), { show: { footprint: true, bubbles: true, traded: false, mirror: true } });
  assert.deepEqual(togglePatch(state, 'trades'), { show: { footprint: false, bubbles: false, traded: false, mirror: true } });
  assert.deepEqual(togglePatch(state, 'liquidations'), { liquidations: { on: true, min: 1 } });
  assert.deepEqual(togglePatch(state, 'highlights'), { highlight: { on: false } });
});
