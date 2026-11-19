// THE SALE GATE (2026-11-19). Plus is not on sale, and must not go on sale yet: the checkout's recovery of a payment whose Plus was not set
// up in this browser (`lmf.plus.paid`, src/app/plus/page-flow.ts and src/app/plus/paid.ts) has open findings in sol-review-final-r2.md, from
// Sol's last review of it. That recovery must be redesigned and reviewed before Plus goes on sale. This test fails as soon as Paddle's
// client-side token or a price id is filled in (src/app/plus/config.ts), so whoever fills them in has to face that first: do the redesign
// and its review, then change this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PADDLE, plusOnSale } from '../src/app/plus/config.ts';

test('the checkout stays gated: no Paddle token and no price id until the checkout recovery is redesigned and reviewed (sol-review-final-r2.md)', () => {
  assert.equal(PADDLE.token, '', 'Paddle\'s client-side token is filled in: the checkout recovery has open findings (sol-review-final-r2.md)');
  assert.equal(PADDLE.monthly.id, '', 'the monthly price id is filled in: the checkout recovery has open findings (sol-review-final-r2.md)');
  assert.equal(PADDLE.yearly.id, '', 'the yearly price id is filled in: the checkout recovery has open findings (sol-review-final-r2.md)');
  assert.equal(plusOnSale(), false, 'Plus is on sale');
});
