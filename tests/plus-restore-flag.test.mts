// The receipt form while the checkout is closed (src/app/plus/config.ts `offersReceipt`, the checkout recovery, 2026-11-20): offered while Plus
// is on sale and whenever `PLUS_RESTORE` says so. A separate test from the sale gate fails while Plus is on sale with `PLUS_RESTORE` still
// false, so the flag cannot be forgotten when the sale opens (and the receipt then stays if the checkout is ever closed again).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLUS_RESTORE, offersReceipt, plusOnSale } from '../src/app/plus/config.ts';

test('offersReceipt: PLUS_RESTORE or an open sale', () => {
  assert.equal(offersReceipt(true, () => false), true, 'the flag set, the checkout closed: the receipt form shows');
  assert.equal(offersReceipt(false, () => true), true, 'on sale');
  assert.equal(offersReceipt(false, () => false), false, 'neither');
  assert.equal(offersReceipt(), PLUS_RESTORE || plusOnSale(), 'by default, the configuration');
});

test('Plus on sale means PLUS_RESTORE is set: set PLUS_RESTORE to true in src/app/plus/config.ts when the sale opens', () => {
  assert.ok(!plusOnSale() || PLUS_RESTORE, 'Plus is on sale and PLUS_RESTORE is false');
});
