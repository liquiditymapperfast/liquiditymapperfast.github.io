import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutFor, layoutMode, isPhoneLayout } from '../src/app/device.ts';

test('a narrow window is a phone, a wide one is a desktop', () => {
  assert.equal(layoutFor(390, 844, true), 'phone');
  assert.equal(layoutFor(360, 640, true), 'phone');
  assert.equal(layoutFor(1920, 1080, false), 'desktop');
  assert.equal(layoutFor(1366, 768, true), 'desktop', 'a touch laptop stays a desktop');
});

test('tablets keep the desktop arrangement in both orientations', () => {
  assert.equal(layoutFor(820, 1180, true), 'desktop');
  assert.equal(layoutFor(1180, 820, true), 'desktop');
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
});
