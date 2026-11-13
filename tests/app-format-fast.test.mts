import test from 'node:test';
import assert from 'node:assert/strict';
import { compactUsd, usd } from '../src/app/format.ts';

const intl = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

test('the fast compact form writes what Intl writes: random sizes from $1K to $10 quadrillion, both signs, whole and with cents', () => {
  let seed = 7;
  const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 300_000; i++) {
    const mag = 3 + rand() * 13, raw = 10 ** mag, cents = rand() < 0.5, v = (cents ? raw : Math.round(raw)) * (rand() < 0.2 ? -1 : 1);
    if (Math.abs(v) < 1000) continue;
    assert.equal(compactUsd(v), intl.format(v), String(v));
  }
});

test('the fast compact form at the edges: a tenth\'s ties, the step into the next unit, Float32 sums', () => {
  const edges = [1000, 1049.99, 1050, 1050.0000001, 1149.9999, 1150, 9999, 9999.49, 9999.5, 99_949, 99_950, 999_949.99, 999_950, 999_999, 1e6, 1_050_000,
    1_049_999.999, 9_999_950, 999_950_000, 999_949_999, 1e9, 999_950_000_000, 1e12, 1e15, 2.5e15, 1234.5, 12_345.5, 123_456.7, Math.fround(1234567.8), Math.fround(98765.43)];
  for (const v of edges) for (const s of [1, -1]) assert.equal(compactUsd(v * s), intl.format(v * s), String(v * s));
  for (let k = 1; k < 10_000; k++) { const v = k * 50; if (v >= 1000) assert.equal(compactUsd(v), intl.format(v), String(v)); }
});

test('usd keeps its own forms under a thousand and for nothing', () => {
  assert.equal(usd(0), '0'); assert.equal(usd(999.4), '999'); assert.equal(usd(-12.6), '-13'); assert.equal(usd(Number.NaN), '–'); assert.equal(usd(1_234_567), '1.2M');
});
