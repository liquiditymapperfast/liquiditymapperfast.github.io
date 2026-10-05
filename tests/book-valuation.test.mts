import test from 'node:test';
import assert from 'node:assert/strict';
import { usdBookLevels } from '../src/core/book-valuation.mts';

test('contract book without a documented face value stays out of USD ladders', () => {
  const book = { units: 'contract', bids: [{ price: 100, amount: 2 }], asks: [{ price: 101, amount: 3 }] };
  assert.deepEqual(usdBookLevels(book, { quantityUnit: 'contract', lotSize: 0.0001 }), []);
});

test('contract book with verified face value produces USD rows', () => {
  const book = { units: 'contract', bids: [{ price: 100, amount: 2 }], asks: [{ price: 101, amount: 3 }] };
  const rows = usdBookLevels(book, { quantityUnit: 'contract', contractValue: 0.01, quote: 'USDT' });
  assert.deepEqual(rows.map(({ price, amount, contractAmount, side }) => ({ price, amount, contractAmount, side })), [
    { price: 100, amount: 0.02, contractAmount: 2, side: 'bid' },
    { price: 101, amount: 0.03, contractAmount: 3, side: 'ask' },
  ]);
  assert.ok(Math.abs(rows[0].notionalUsd - 2) < 1e-12);
  assert.ok(Math.abs(rows[1].notionalUsd - 3.03) < 1e-12);
  assert.equal(rows[0].notionalEstimated, true);
  assert.equal(rows[0].valuation.quoteToUsd, 1);
});

test('quote-denominated rows normalize to base and use an explicit stable conversion', () => {
  const rows = usdBookLevels({ units: 'quote', bids: [{ price: 77_000, amount: 125_000 }], asks: [{ price: 77_001, amount: 80_000 }] }, { quantityUnit: 'quote', quote: 'USDT' });
  assert.deepEqual(rows.map(({ price, amount, quoteAmount, notionalUsd }) => ({ price, amount, quoteAmount, notionalUsd })), [
    { price: 77_000, amount: 125_000 / 77_000, quoteAmount: 125_000, notionalUsd: 125_000 },
    { price: 77_001, amount: 80_000 / 77_001, quoteAmount: 80_000, notionalUsd: 80_000 },
  ]);
});

test('non-stable quote fails closed unless a USD conversion is supplied', () => {
  assert.deepEqual(usdBookLevels({ units: 'base', bids: [{ price: 100, amount: 2 }] }, { quantityUnit: 'base', quote: 'BTC' }), []);
  const rows = usdBookLevels({ units: 'base', quote: 'BTC', bids: [{ price: 100, amount: 2 }] }, { quantityUnit: 'base', quote: 'BTC', quoteToUsd: 60_000 });
  assert.equal(rows[0].notionalUsd, 12_000_000);
  assert.equal(rows[0].notionalEstimated, true);
});

test('null and empty source notionals are missing, not authoritative zero', () => {
  const options = { quantityUnit: 'base', quote: 'USDT' };
  const objectRows = usdBookLevels({ units: 'base', bids: [
    { price: 100, amount: 2, notionalUsd: null },
    { price: 100, amount: 2, notionalUsd: '' },
  ] }, options);
  const tupleRows = usdBookLevels({ units: 'base', bids: [[100, 2, null], [100, 2, '']] }, options);
  for (const rows of [objectRows, tupleRows]) {
    assert.deepEqual(rows.map((row) => row.notionalUsd), [200, 200]);
    assert.ok(rows.every((row) => row.notionalEstimated));
  }
});

test('mixed base, linear-contract, inverse-contract, and source-notional rows retain units', () => {
  const rows = usdBookLevels({
    units: 'base', quote: 'USDT', bids: [{ price: 100, amount: 2 }],
  }, { quantityUnit: 'base', quote: 'USDT' });
  const linear = usdBookLevels({ units: 'contract', quote: 'USDT', contractValue: 0.01, bids: [{ price: 100, amount: 2 }] }, { quantityUnit: 'contract', quote: 'USDT', contractValue: 0.01 });
  const inverse = usdBookLevels({ units: 'contract', contractType: 'inverse', quote: 'USD', contractValue: 10, bids: [{ price: 100, amount: 2 }] }, { quantityUnit: 'contract', quote: 'USD', contractValue: 10, contractType: 'inverse' });
  const supplied = usdBookLevels({ units: 'base', bids: [{ price: 100, amount: 2, notionalUsd: 123 }] }, { quantityUnit: 'base' });
  assert.equal(rows[0].amount, 2);
  assert.equal(linear[0].amount, 0.02);
  assert.equal(linear[0].contractAmount, 2);
  assert.equal(inverse[0].amount, 0.2);
  assert.equal(inverse[0].notionalUsd, 20);
  assert.equal(supplied[0].notionalUsd, 123);
  assert.equal(supplied[0].notionalEstimated, false);
});
