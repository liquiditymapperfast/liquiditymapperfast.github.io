import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutFor, layoutMode, isPhoneLayout, compactBarFor, compactBar, isPhone } from '../src/app/device.ts';

test('a narrow window is a phone, a wide one is a desktop', () => {
  assert.equal(layoutFor(390, 844, true), 'phone');
  assert.equal(layoutFor(360, 640, true), 'phone');
  assert.equal(layoutFor(1920, 1080, false), 'desktop');
  assert.equal(layoutFor(1366, 768, true), 'desktop', 'a touch laptop stays a desktop');
});

test('a tablet held upright gets the phone arrangement, held sideways the desktop one', () => {
  assert.equal(layoutFor(820, 1180, true), 'phone', 'portrait: too narrow for the desktop\'s two columns');
  assert.equal(layoutFor(744, 1133, true), 'phone');
  assert.equal(layoutFor(1180, 820, true), 'desktop', 'landscape: room for the map, its panes and the book');
  assert.equal(layoutFor(1024, 1366, true), 'desktop', 'a large tablet upright is wide enough as it is');
  assert.equal(layoutFor(820, 1180, false), 'desktop', 'a narrow window with a mouse is just a narrow desktop window');
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
