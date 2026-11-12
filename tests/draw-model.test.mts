import test from 'node:test';
import assert from 'node:assert/strict';
import { ANCHORS, DRAW_FILE_FORMAT, MAX_PER_COIN, MAX_TEXT, MAX_UNDO, capReached, duplicate, exportText, fits, flipped, importInto, moved, newDrawing, newId, positionFigures, positionFromClicks, positionSide, readDoc, readDrawing, totalOf, type DrawDoc } from '../src/app/draw/model.ts';
import { History } from '../src/app/draw/history.ts';

const T = Date.UTC(2026, 9, 28, 12);
const at = (k: number, p: number): { t: number; p: number } => ({ t: T + k * 3_600_000, p });

test('a new drawing has exactly its kind\'s points and its kind\'s look; ids are never shared', () => {
  const level = newDrawing('level', [at(0, 81_500), at(1, 1)], T);
  assert.equal(level.points.length, 1, 'a level is one point');
  assert.deepEqual([level.extendLeft, level.extendRight, level.style.color], [true, true, 'blue'], 'across the map, in blue');
  const trend = newDrawing('trend', [at(0, 80_000), at(2, 81_000)], T);
  assert.deepEqual([trend.extendLeft, trend.extendRight], [false, false], 'a segment until set to run on');
  assert.equal(newDrawing('channel', [at(0, 1), at(1, 2), at(2, 3)], T).points.length, ANCHORS.channel);
  const ids = new Set(Array.from({ length: 2000 }, () => newId(T)));
  assert.equal(ids.size, 2000, 'two thousand ids made in one millisecond are all different');
});

test('a saved drawing is read field by field: wrong points drop it, a wrong look falls back to the kind\'s', () => {
  const good = newDrawing('zone', [at(0, 80_000), at(3, 81_000)], T);
  assert.deepEqual(readDrawing(JSON.parse(JSON.stringify(good))), good, 'read back as it was written');
  assert.equal(readDrawing({ ...good, points: [at(0, 80_000)] }), null, 'a zone needs two corners');
  assert.equal(readDrawing({ ...good, points: [at(0, 80_000), { t: T, p: -5 }] }), null, 'a price at or below zero');
  assert.equal(readDrawing({ ...good, points: [at(0, 80_000), { t: Number.NaN, p: 1 }] }), null, 'a time that is not one');
  assert.equal(readDrawing({ ...good, points: [at(0, 80_000), { t: Date.UTC(1999, 0, 1), p: 1 }] }), null, 'a time before any market');
  assert.equal(readDrawing({ ...good, kind: 'pitchfork' }), null, 'a kind this page does not draw');
  assert.equal(readDrawing({ ...good, id: '<script>' }), null, 'an id not of its own form');
  const odd = readDrawing({ ...good, style: { color: 'chartreuse', width: 7, dashed: 'yes' }, text: 'x'.repeat(MAX_TEXT + 50), alert: true })!;
  assert.deepEqual(odd.style, { color: 'blue', width: 2, dashed: false }, 'the zone\'s own look');
  assert.equal(odd.text.length, MAX_TEXT, 'a long text is cut');
  assert.equal(odd.alert, false, 'only a level sounds');
  assert.equal(readDrawing({ ...newDrawing('level', [at(0, 1)], T), alert: true })!.alert, true);
});

test('a document keeps each coin\'s valid drawings once, at most a coin\'s cap, and a newer document is not read at all', () => {
  const a = newDrawing('level', [at(0, 1)], T), b = newDrawing('vline', [at(1, 1)], T + 1);
  const doc = readDoc({ version: 1, coins: { BTC: [b, a, a, { junk: true }], 'bad coin!': [a], ETH: 'no' } })!;
  assert.deepEqual(doc.coins.BTC!.map(d => d.id), [a.id, b.id], 'oldest first, each once, junk dropped');
  assert.deepEqual(Object.keys(doc.coins), ['BTC']);
  assert.equal(readDoc({ version: 3, coins: {} }), null, 'a newer page wrote it: left alone');
  assert.deepEqual(readDoc(null), { version: 1, coins: {} });
  const many = Array.from({ length: MAX_PER_COIN + 5 }, (_, i) => newDrawing('level', [at(i, 1)], T + i));
  assert.equal(readDoc({ version: 1, coins: { BTC: many } })!.coins.BTC!.length, MAX_PER_COIN, 'the newest kept');
  assert.equal(capReached({ version: 1, coins: { BTC: many.slice(0, MAX_PER_COIN) } }, 'BTC'), 'coin');
  assert.equal(capReached({ version: 1, coins: { BTC: many.slice(0, 3) } }, 'BTC'), null);
});

test('a file is read into what is held: after it, new ids where ids are taken, nothing past the caps, nothing from another format', () => {
  const held = newDrawing('level', [at(0, 81_000)], T), doc: DrawDoc = { version: 1, coins: { BTC: [held] } };
  const file = exportText({ version: 1, coins: { BTC: [held, newDrawing('trend', [at(0, 1), at(1, 2)], T + 5)], ETH: [newDrawing('zone', [at(0, 1), at(1, 2)], T)] } });
  const read = importInto(doc, file, T + 10);
  assert.equal(read.error, null); assert.equal(read.added, 3); assert.equal(read.skipped, 0);
  assert.equal(read.doc.coins.BTC!.length, 3);
  assert.equal(new Set(read.doc.coins.BTC!.map(d => d.id)).size, 3, 'the copy of the held drawing got an id of its own');
  assert.equal(doc.coins.BTC!.length, 1, 'what was held is not changed');
  assert.equal(totalOf(read.doc), 4);
  assert.equal(importInto(doc, JSON.stringify({ format: 'something-else', coins: {} })).error, 'format');
  assert.equal(importInto(doc, '{not json').error, 'format');
  assert.equal(importInto(doc, JSON.stringify({ format: DRAW_FILE_FORMAT, version: 9, coins: {} })).error, 'version');
  const full: DrawDoc = { version: 1, coins: { BTC: Array.from({ length: MAX_PER_COIN }, (_, i) => newDrawing('level', [at(i, 1)], T + i)) } };
  const over = importInto(full, file, T);
  assert.deepEqual([over.added, over.skipped], [1, 2], 'only ETH had room');
});

test('moving and copying keep the shape; Undo goes back a step at a time and a new change ends what Redo held', () => {
  const d = newDrawing('trend', [at(0, 100), at(2, 110)], T);
  const m = moved(d, 60_000, 5);
  assert.deepEqual(m.points.map(q => [q.t - d.points[0]!.t, q.p]), [[60_000, 105], [2 * 3_600_000 + 60_000, 115]]);
  const c = duplicate(d, 1, 1, T + 1);
  assert.notEqual(c.id, d.id); assert.equal(c.alert, false);
  const h = new History(), s0: never[] = [], s1 = [d], s2 = [d, c];
  h.push(s0, s1); h.push(s1, s2);
  assert.deepEqual(h.undo(), s1); assert.deepEqual(h.undo(), s0); assert.equal(h.undo(), null);
  assert.deepEqual(h.redo(), s1);
  h.push(s1, [m]);
  assert.equal(h.canRedo, false, 'a new change ends what Redo held');
  for (let i = 0; i < MAX_UNDO + 20; i++) h.push([], [d]);
  let n = 0; while (h.undo()) n++;
  assert.equal(n, MAX_UNDO, 'at most a hundred steps back');
});

test('a position is an entry, its stop and its target: on opposite sides, ending at one time after it starts, or it is not one', () => {
  const H = 3_600_000, p = newDrawing('position', positionFromClicks([at(0, 100), at(2, 95), at(3, 110)], H)!, T);
  assert.deepEqual(p.points, [at(0, 100), at(3, 95), at(3, 110)], 'it ends at the later of the two clicks after the entry');
  assert.equal(positionSide(p), 'long', 'the stop below the entry');
  assert.deepEqual(positionFigures(p), { side: 'long', entry: 100, stop: 95, target: 110, risk: 5, reward: 10, riskPct: 5, rewardPct: 10, ratio: 2 });
  assert.deepEqual(positionFromClicks([at(0, 100), at(1, 104)], H), [at(0, 100), at(1, 104), at(1, 92)], 'while only the stop is placed: a target twice as far on the other side');
  assert.deepEqual(positionFromClicks([at(2, 100), at(1, 95), at(0, 110)], H)!.map(q => q.t), [at(2, 0).t, at(3, 0).t, at(3, 0).t], 'clicked at or before the entry: it lasts the span given');
  assert.deepEqual(positionFromClicks([at(0, 100), at(8, 95), at(4, 110)], H)!.map(q => q.t), [at(0, 0).t, at(4, 0).t, at(4, 0).t], 'it ends where the target was clicked, not at the later click');
  assert.deepEqual(positionFromClicks([at(2, 100), at(2.03, 95), at(2.05, 110)], H, H / 2)!.map(q => q.t), [at(2, 0).t, at(3, 0).t, at(3, 0).t], 'a target a few pixels right of the entry: the span, not a hairline box');
  assert.deepEqual(positionFromClicks([at(0, 100), at(1, 160)], H), [at(0, 100), at(1, 160), at(1, 50)], 'a short with its stop far above: the shape’s target stays above zero, at half the entry');
  assert.equal(positionFromClicks([at(0, 100), at(1, 160), at(2, -5)], H), null, 'a target clicked below zero');
  assert.equal(positionFromClicks([at(0, 100), at(1, 100)], H), null, 'a stop at the entry risks nothing');
  assert.equal(positionFromClicks([at(0, 100), at(1, 95), at(2, 98)], H), null, 'the target on the stop\'s side');
  assert.deepEqual(readDrawing(JSON.parse(JSON.stringify(p))), p, 'read back as it was written');
  for (const [points, why] of [[[at(0, 100), at(3, 95), at(4, 110)], 'stop and target at two times'], [[at(0, 100), at(3, 95), at(3, 98)], 'both on one side'],
    [[at(3, 100), at(3, 95), at(3, 110)], 'ending where it starts'], [[at(0, 100), at(3, 95)], 'two points']] as const) {
    assert.equal(readDrawing({ ...p, points }), null, why);
    assert.equal(fits({ ...p, points: [...points] }), false, why);
  }
  const short = flipped(p);
  assert.deepEqual(short.points, [at(0, 100), at(3, 105), at(3, 90)], 'flipped: as far on the other side');
  assert.equal(positionSide(short), 'short');
  assert.equal(fits(flipped({ ...p, points: [at(0, 100), at(3, 95), at(3, 250)] })), false, 'a target 150 above flips to a price below zero');
});

test('a document holding a position is version 2, which pages from before positions leave alone; without one it stays version 1', () => {
  const level = newDrawing('level', [at(0, 81_000)], T), pos = newDrawing('position', [at(0, 100), at(3, 95), at(3, 110)], T + 1);
  assert.equal(readDoc({ version: 1, coins: { BTC: [level] } })!.version, 1);
  const doc = readDoc({ version: 2, coins: { BTC: [level, pos] } })!;
  assert.equal(doc.version, 2); assert.equal(doc.coins.BTC!.length, 2);
  assert.equal(JSON.parse(exportText(doc)).version, 2, 'its file too');
  assert.equal(JSON.parse(exportText({ version: 2, coins: { BTC: [level] } })).version, 1, 'written as what it holds');
  // The guard of every page before positions (model.ts until 2026-11-12): a document whose version is above 1 is a newer page's, not read.
  const olderPageReads = (raw: { version?: unknown }): boolean => !(typeof raw.version === 'number' && raw.version > 1);
  assert.equal(olderPageReads(JSON.parse(exportText(doc))), false);
  assert.equal(olderPageReads(JSON.parse(exportText({ version: 1, coins: { BTC: [level] } }))), true);
  assert.equal(readDoc({ version: 3, coins: {} }), null, 'a version above this page\'s still is not read');
  const read = importInto({ version: 1, coins: {} }, exportText(doc), T + 5);
  assert.equal(read.error, null); assert.equal(read.added, 2); assert.equal(read.doc.version, 2);
});
