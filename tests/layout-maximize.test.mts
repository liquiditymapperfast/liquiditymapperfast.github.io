import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canMaximize, columnKey, savedHeight, staysMaximized } from '../src/app/layouts/maximize.ts';
import { SHORTCUTS, matchShortcut, type KeyPress } from '../src/app/shortcuts.ts';

const column = (open: string[]) => ['heat', 'bars', 'oi', 'delta'].map(id => ({ id, open: open.includes(id) }));

test('a pane is maximized only where it covers another: the map alone, a pane switched off and a phone change nothing (Karl, 2026-11-17)', () => {
  assert.equal(canMaximize('heat', column(['heat', 'oi']), false), true, 'the map over the OI pane');
  assert.equal(canMaximize('oi', column(['heat', 'oi']), false), true, 'the OI pane over the map');
  assert.equal(canMaximize('heat', column(['heat']), false), false, 'the map alone: a double click recentres it instead');
  assert.equal(canMaximize('delta', column(['heat', 'oi']), false), false, 'a pane whose switch is off');
  assert.equal(canMaximize('oi', column(['heat', 'oi']), true), false, 'a phone shows one pane at a time');
  assert.equal(canMaximize('book', column(['heat', 'oi']), false), false, 'not a pane of the column');
});

test('a maximized pane gives the column back when a pane is opened, closed or moved, and only then', () => {
  const then = columnKey(column(['heat', 'oi', 'delta']));
  assert.equal(staysMaximized('oi', then, columnKey(column(['heat', 'oi', 'delta']))), true, 'Candles or the footprint switched: the same panes');
  assert.equal(staysMaximized('oi', then, columnKey(column(['heat', 'oi']))), false, 'Delta closed');
  assert.equal(staysMaximized('oi', then, columnKey(column(['heat', 'delta']))), false, 'the maximized pane itself closed');
  assert.equal(staysMaximized('oi', then, columnKey(column(['heat', 'bars', 'oi', 'delta']))), false, 'Bar stats opened');
  assert.equal(staysMaximized('oi', then, 'heat,delta,oi'), false, 'moved');
  assert.equal(staysMaximized(null, '', ''), false, 'nothing maximized');
});

test('a maximized pane is saved at the height it comes back at, never at the column\'s', () => {
  assert.equal(savedHeight({ maxed: true, shown: 712, own: 150, initial: 150 }), 150);
  assert.equal(savedHeight({ maxed: true, shown: 712, initial: 132 }), 132, 'never resized: its first height');
  assert.equal(savedHeight({ maxed: true, shown: 712, fitted: 712, own: 180, initial: 150 }), 180);
  // The rules from before maximize, unchanged.
  assert.equal(savedHeight({ maxed: false, shown: 120, fitted: 120, own: 150, initial: 150 }), 150, 'shrunk to fit the window: its own height');
  assert.equal(savedHeight({ maxed: false, shown: 121, fitted: 120, own: 150, initial: 150 }), 150, 'within a pixel');
  assert.equal(savedHeight({ maxed: false, shown: 140, fitted: 120, own: 150, initial: 150 }), 140, 'resized by hand since');
  assert.equal(savedHeight({ maxed: false, shown: 140, initial: 150 }), 140);
});

test("Z maximizes the pane under the pointer (tmux's key for zooming a pane; M is Mirror's), and is no letter another shortcut has", () => {
  const press: KeyPress = { key: 'z', code: 'KeyZ', ctrlKey: false, metaKey: false, altKey: false, repeat: false, target: { tagName: 'CANVAS' } };
  assert.equal(matchShortcut(press, false)?.action.kind, 'maximize');
  assert.equal(matchShortcut({ ...press, key: 'Z' }, false)?.action.kind, 'maximize');
  assert.equal(matchShortcut({ ...press, target: { tagName: 'INPUT' } }, false), null, 'typing in a field');
  assert.equal(SHORTCUTS.filter(s => s.keys?.includes('z')).length, 1);
});

test('the map\'s double click maximizes on its plot only, and recentres on its axes or with nothing to cover', () => {
  // Read from the source (the pane needs a page to run): the plot test comes before the recentre, and asks the layout through onMaximize.
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  const handler = heat.slice(heat.indexOf("el.addEventListener('dblclick'"), heat.indexOf('bindTouch(el, new GestureRecognizer'));
  assert.match(handler, /at\.x >= 0 && at\.x < this\.plotW && at\.y >= 0 && at\.y < this\.plotH && this\.onMaximize\(\)\) return;\s+this\.fit\(\);/);
  assert.match(handler, /!this\.store\.state\.rangeTool/, 'not while Range is armed');
  const main = fs.readFileSync('src/app/main.ts', 'utf8');
  assert.match(main, /heat\.onMaximize = \(\) => arrange\.toggleMax\('heat'\);/);
});

test('panes covered by a maximized one draw nothing and put their cards away, but Delta keeps drawing the map\'s divergences under a maximized map', () => {
  // Read from the source: the cards are top-layer popovers, drawn they floated over the maximized chart (review r1); Delta's drawing works
  // out the CVD divergences the map draws (review r2).
  const lower = fs.readFileSync('src/app/panes/lower-panes.ts', 'utf8');
  assert.match(lower, /invalidate\(\): void \{ if \(!this\.#frame && !this\.#hidden && !this\.#covered\)/);
  assert.match(lower, /if \(this\.#pinned\) this\.#unpin\(\);\r?\n\s+this\.undrawn\(\);/);
  const main = fs.readFileSync('src/app/main.ts', 'utf8');
  assert.match(main, /const covers = \{ bars, depth, oi, delta, ls, funding, lt, script \} as const;/);
  assert.match(main, /id !== null && id !== pid && !\(pid === 'delta' && id === 'heat'\)/);
});
