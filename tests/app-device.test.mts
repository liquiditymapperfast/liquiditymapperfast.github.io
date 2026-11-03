import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutFor, layoutMode, isPhoneLayout, compactBarFor, compactBar, isPhone } from '../src/app/device.ts';

test('a narrow window is a phone, a wide one is a desktop', () => {
  assert.equal(layoutFor(390, 844, true), 'phone');
  assert.equal(layoutFor(360, 640, true), 'phone');
  assert.equal(layoutFor(1920, 1080, false), 'desktop');
  assert.equal(layoutFor(1366, 768, true), 'desktop', 'a touch laptop stays a desktop');
});

test('a tablet up to 1100 px wide gets a phone arrangement either way it is held; a wider one on its side the desktop one', () => {
  // Karl, 2026-11-03 (Chrome's device list): the desktop's columns beside the map (416 px) and the book (350) left these maps 100-220 px.
  assert.equal(layoutFor(820, 1180, true), 'phone', 'iPad Air upright');
  assert.equal(layoutFor(744, 1133, true), 'phone');
  assert.equal(layoutFor(1024, 1366, true), 'phone', 'iPad Pro upright: 1024 px left its map about 220 px');
  assert.equal(layoutFor(912, 1368, true), 'phone', 'Surface Pro 7 upright');
  assert.equal(layoutFor(1024, 768, true), 'phone-landscape', 'iPad Mini on its side: the map left, a pane right');
  assert.equal(layoutFor(829, 690, true), 'phone-landscape', 'Galaxy Z Fold 5 opened on its side');
  assert.equal(layoutFor(720, 540, true), 'phone-landscape', 'Surface Duo on its side');
  assert.equal(layoutFor(1024, 600, true), 'phone-landscape', 'Nest Hub');
  assert.equal(layoutFor(1180, 820, true), 'desktop', 'iPad Air on its side: room for the map, its panes and the book');
  assert.equal(layoutFor(1280, 800, true), 'desktop', 'Nest Hub Max');
  assert.equal(layoutFor(1366, 1024, true), 'desktop', 'iPad Pro on its side');
  assert.equal(layoutFor(820, 1180, false), 'desktop', 'a narrow window with a mouse is just a narrow desktop window');
  assert.equal(layoutFor(1024, 768, false), 'desktop', 'and so is a small one');
  // A split-screen window on a tablet held sideways is upright itself: the phone's arrangement, as before (Sol, 2026-11-03).
  assert.equal(layoutFor(507, 1024, true, true), 'phone');
  assert.equal(layoutFor(700, 1024, true, true), 'phone');
  assert.equal(layoutFor(400, 500, true, true), 'phone', 'a short one too (Sol, round 2)');
});

test('a short touch screen held sideways is the landscape phone', () => {
  assert.equal(layoutFor(844, 390, true), 'phone-landscape');
  assert.equal(layoutFor(568, 320, true), 'phone-landscape', 'the smallest phones too, even though they are narrower than the portrait limit');
  assert.equal(layoutFor(844, 390, false), 'desktop', 'a short window with a mouse is just a short desktop window');
});

test('a keyboard that shrinks the window is not a rotation', () => {
  // Portrait phone, 360 wide, keyboard up leaving 350 px: wider than tall, but the screen is still held upright.
  assert.equal(layoutFor(360, 350, true, false), 'phone');
});

test('only the desktop arrangement is not a phone', () => {
  assert.equal(isPhoneLayout('phone'), true);
  assert.equal(isPhoneLayout('phone-landscape'), true);
  assert.equal(isPhoneLayout('desktop'), false);
  assert.equal(layoutMode(), 'desktop', 'until the page starts it, a window-less environment is a desktop');
  assert.equal(isPhone(), false);
  assert.equal(compactBar(), false);
});

test('the controls are compact on every phone arrangement and on any touch screen, and full only for a mouse on a desktop', () => {
  assert.equal(compactBarFor('phone', false), true, 'a narrow desktop window is still small');
  assert.equal(compactBarFor('phone-landscape', true), true);
  assert.equal(compactBarFor('desktop', true), true, 'a tablet held sideways: panes of the desktop, controls of a finger');
  assert.equal(compactBarFor('desktop', false), false);
});
