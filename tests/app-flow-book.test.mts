import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowBook } from '../src/app/flow-book.ts';
import type { FlowFrame, FlowUpdate } from '../src/shared/flow.ts';

const T0 = 1_800_000_000_000;
const frame = (id: string, t0: number, buy: number[], sell: number[]): FlowFrame => ({ from: t0, to: t0 + buy.length * 1000, instruments: [{ id, t0, buy: Float32Array.from(buy), sell: Float32Array.from(sell) }] });

test('live seconds make a series, and a second sent again replaces what the page had', () => {
  const book = new FlowBook();
  book.apply([['a', T0, 100, 40], ['a', T0 + 1_000, 10, 0]]);
  const s = book.get('a')!;
  assert.equal(s.delta(T0 / 1000, T0 / 1000 + 1), 70);
  book.apply([['a', T0 + 1_000, 30, 5]]);                 // the open second grew
  assert.equal(s.delta(T0 / 1000, T0 / 1000 + 1), 85);
  assert.deepEqual(book.ids, ['a']);
});

test('history replaces the series and the seconds that arrived while it was on the way go on top', () => {
  const book = new FlowBook(); const sec = T0 / 1000;
  assert.deepEqual(book.missing(['a', 'b'], T0 - 60_000), ['a', 'b']);
  book.begin(['a', 'b']);
  book.apply([['a', T0 + 3_000, 7, 0]] as FlowUpdate[]);
  assert.equal(book.get('a'), undefined, 'held, not applied');
  book.load(frame('a', T0, [1, 2, 3], [0, 0, 0]), ['a', 'b'], T0 - 60_000);
  const a = book.get('a')!;
  assert.equal(a.delta(sec, sec + 3), 13, 'history 1+2+3 plus the held second 3');
  assert.equal(book.get('b'), undefined, 'nothing recorded for b: no series until it trades');
  assert.deepEqual(book.missing(['a', 'b'], T0 - 60_000), [], 'neither is asked for again');
  assert.deepEqual(book.missing(['a'], T0 - 3_600_000), ['a'], 'but a longer reach is');
  book.apply([['b', T0 + 9_000, 5, 5]]);
  assert.ok(book.get('b'), 'b appears when it trades');
});

test('a failed request lets the held seconds in and allows another try', () => {
  const book = new FlowBook();
  book.begin(['a']); book.apply([['a', T0, 4, 1]]);
  book.fail(['a']);
  assert.equal(book.get('a')!.delta(T0 / 1000, T0 / 1000), 3);
  assert.deepEqual(book.missing(['a'], T0), ['a']);
});

test('the version moves with every change so a pane knows to draw', () => {
  const book = new FlowBook(); const v = [book.version];
  book.apply([['a', T0, 1, 0]]); v.push(book.version);
  book.begin(['a']); book.load(frame('a', T0, [1], [0]), ['a'], T0); v.push(book.version);
  book.fail(['z']); v.push(book.version);
  assert.deepEqual(v, [0, 1, 2, 3]);
});
