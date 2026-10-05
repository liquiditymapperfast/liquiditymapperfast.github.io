import test from 'node:test';
import assert from 'node:assert/strict';
import { bookKey, bookResolutionKey, normalizeBookGrouping, } from '../src/core/book-key.mts';

test('book grouping rejects contradictory native/coarse fields', () => {
  assert.deepEqual(normalizeBookGrouping({ resolution: 'native' }), { resolution: 'native', nSigFigs: null, mantissa: null });
  assert.throws(() => normalizeBookGrouping({ resolution: 'native', nSigFigs: 2 }), /Native/);
  assert.throws(() => normalizeBookGrouping({ resolution: 'coarse' }), /requires/);
  assert.throws(() => normalizeBookGrouping({ resolution: 'coarse', nSigFigs: 4, mantissa: 1 }), /only valid/);
});
