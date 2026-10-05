import test from 'node:test';
import assert from 'node:assert/strict';
import { mayReload } from '../src/app/lazy.ts';

test('a stale page reloads itself once, and not again within half a minute, so a file that is really missing cannot loop', () => {
  assert.equal(mayReload(1_000_000, 0), true, 'never reloaded');
  assert.equal(mayReload(1_000_000, 999_000), false, 'it did a second ago');
  assert.equal(mayReload(1_000_000, 970_001), false);
  assert.equal(mayReload(1_000_000, 969_999), true, 'half a minute later it may try again');
});
