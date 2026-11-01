import test from 'node:test';
import assert from 'node:assert/strict';
import { grow, placeCard, union, visiblePart, type Rect, type Size } from '../src/app/tour/place.ts';
import { MAX_BODY, MAX_TITLE, stepsFor, type Arrangement } from '../src/app/tour/steps.ts';
import { SELECTORS } from '../src/app/tour/targets.ts';
import { TOUR_VERSION, mark, readRecord, shouldInvite } from '../src/app/tour/record.ts';

const VIEW: Size = { w: 1500, h: 900 }, CARD: Size = { w: 340, h: 170 };
const inside = (p: { x: number; y: number }, card: Size, view: Size, margin = 12): boolean => p.x >= margin && p.y >= margin && p.x + card.w <= view.w - margin && p.y + card.h <= view.h - margin;
const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('a card goes below a wide target when it fits, centred on it and kept inside the window', () => {
  const deck = placeCard({ x: 600, y: 10, w: 260, h: 64 }, CARD, VIEW);
  assert.deepEqual(deck, { x: 560, y: 88, where: 'below' });
  // At the window's right edge it is pulled back in, not centred off the screen (the Tour and Guide buttons).
  const corner = placeCard({ x: 1354, y: 10, w: 109, h: 32 }, CARD, VIEW);
  assert.equal(corner.where, 'below'); assert.equal(corner.x, VIEW.w - 12 - CARD.w);
});

test('a card goes above when there is no room below, and beside a tall target (the side that has room)', () => {
  assert.deepEqual(placeCard({ x: 600, y: 800, w: 200, h: 60 }, CARD, VIEW), { x: 530, y: 616, where: 'above' });
  const flow = placeCard({ x: 0, y: 68, w: 293, h: 813 }, CARD, VIEW), book = placeCard({ x: 1100, y: 68, w: 400, h: 813 }, CARD, VIEW);
  assert.equal(flow.where, 'right'); assert.equal(flow.x, 293 + 14);
  assert.equal(book.where, 'left'); assert.equal(book.x, 1100 - 14 - CARD.w);
});

test('a target as big as the window gets the card inside it at its lower left; nothing to point at gets the middle', () => {
  const map = placeCard({ x: 287, y: 68, w: 820, h: 813 }, CARD, VIEW, 'inside');
  assert.deepEqual(map, { x: 303, y: 695, where: 'inside' });
  const whole = placeCard({ x: 0, y: 0, w: 1500, h: 900 }, CARD, VIEW);
  assert.equal(whole.where, 'inside'); assert.ok(inside(whole, CARD, VIEW));
  const none = placeCard(null, CARD, VIEW);
  assert.equal(none.where, 'center'); assert.equal(none.x, 580); assert.ok(none.y > 12 && none.y < VIEW.h / 2 - CARD.h / 2 + 1, 'a little above the middle');
});

test('the side a step prefers is used when the card fits there, and the first side with room otherwise', () => {
  const small: Rect = { x: 700, y: 400, w: 60, h: 40 };
  for (const side of ['above', 'below', 'left', 'right'] as const) assert.equal(placeCard(small, CARD, VIEW, side).where, side);
  // No room on the left of a target at the window's edge: the next side that has some.
  assert.notEqual(placeCard({ x: 10, y: 400, w: 60, h: 40 }, CARD, VIEW, 'left').where, 'left');
  // A target that is wide and short prefers below, a tall narrow one the sides.
  assert.equal(placeCard({ x: 100, y: 100, w: 500, h: 40 }, CARD, VIEW).where, 'below');
  assert.equal(placeCard({ x: 100, y: 100, w: 60, h: 500 }, CARD, VIEW).where, 'right');
});

test('wherever the target is, the card is on the window, and beside a target it never covers it (3,000 random windows)', () => {
  let seed = 20261031;
  const random = (): number => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < 3000; i++) {
    const view: Size = { w: 360 + Math.floor(random() * 1800), h: 560 + Math.floor(random() * 900) };
    const card: Size = { w: Math.min(340, view.w - 24), h: 120 + Math.floor(random() * 120) };
    const target: Rect = { x: Math.floor(random() * view.w), y: Math.floor(random() * view.h), w: 20 + Math.floor(random() * view.w), h: 20 + Math.floor(random() * view.h) };
    const lit = visiblePart(grow(target, 6), view);
    const prefer = (['auto', 'above', 'below', 'left', 'right', 'inside'] as const)[Math.floor(random() * 6)]!;
    const p = placeCard(lit, card, view, prefer);
    assert.ok(inside(p, card, view), `${JSON.stringify({ view, card, target, prefer, p })}`);
    if (lit && p.where !== 'inside' && p.where !== 'center') assert.ok(!overlap({ x: p.x, y: p.y, w: card.w, h: card.h }, lit), `covers the target: ${JSON.stringify({ view, card, target, prefer, p })}`);
  }
});

test('rectangles: the union of what is lit, the light grown on every side, the part of it the window shows', () => {
  assert.equal(union([]), null);
  assert.deepEqual(union([{ x: 10, y: 10, w: 20, h: 20 }, { x: 50, y: 0, w: 10, h: 15 }]), { x: 10, y: 0, w: 50, h: 30 });
  assert.deepEqual(grow({ x: 10, y: 10, w: 20, h: 20 }, 6), { x: 4, y: 4, w: 32, h: 32 });
  assert.deepEqual(visiblePart({ x: -10, y: -6, w: 100, h: 50 }, { w: 80, h: 40 }), { x: 0, y: 0, w: 80, h: 40 });
  assert.equal(visiblePart({ x: 100, y: 0, w: 10, h: 10 }, { w: 80, h: 40 }), null);
});

const ARRANGEMENTS: Arrangement[] = ['desktop', 'compact', 'phone'];
test('every step is short, points at something the page names, and has its own id; a tour is a few steps ending on the Guide', () => {
  for (const arrangement of ARRANGEMENTS) for (const coarse of [false, true]) {
    const steps = stepsFor(arrangement, coarse), label = `${arrangement}/${coarse ? 'touch' : 'mouse'}`;
    assert.ok(steps.length >= 4 && steps.length <= 10, `${label}: ${steps.length} steps`);
    assert.equal(new Set(steps.map(s => s.id)).size, steps.length, `${label}: ids`);
    for (const step of steps) {
      assert.ok(step.title().length > 0 && step.title().length <= MAX_TITLE, `${label} ${step.id} title: ${step.title()}`);
      for (const tab of [false, true]) assert.ok(step.body(tab).length > 0 && step.body(tab).length <= MAX_BODY, `${label} ${step.id} body (${step.body(tab).length}): ${step.body(tab)}`);
      for (const target of step.targets) assert.ok(target in SELECTORS && SELECTORS[target].length > 0, `${label} ${step.id}: ${target}`);
    }
    assert.deepEqual(steps.filter(s => s.guide).map(s => s.id), [steps.at(-1)!.id], `${label}: only the last step offers the Guide`);
  }
});

test('each arrangement has its own way in: the map on a desktop, the tabs on a phone; layouts only where the page has them', () => {
  assert.deepEqual(stepsFor('desktop', false)[0]!.targets, ['map']);
  assert.deepEqual(stepsFor('compact', true)[0]!.targets, ['map']);
  assert.deepEqual(stepsFor('phone', true)[0]!.targets, ['tabs']);
  assert.ok(stepsFor('desktop', false).some(s => s.id === 'layouts'));
  assert.ok(!stepsFor('compact', true).some(s => s.id === 'layouts') && !stepsFor('phone', true).some(s => s.id === 'layouts'));
  // The words for moving about are the pointer's or the finger's.
  const look = (coarse: boolean): string => stepsFor('desktop', coarse).find(s => s.id === 'look')!.body(false);
  assert.match(look(false), /wheel/i); assert.doesNotMatch(look(false), /pinch|tap/i);
  assert.match(look(true), /pinch/i); assert.doesNotMatch(look(true), /wheel/i);
  // Nothing in the tour says what a phone cannot do.
  for (const s of stepsFor('phone', true)) assert.doesNotMatch(s.body(false), /wheel|hover|point at/i, s.id);
});

test('what the page remembers: a record is read from storage field by field, and the tour is offered once', () => {
  assert.equal(readRecord(null), null); assert.equal(readRecord('x'), null); assert.equal(readRecord({}), null); assert.equal(readRecord({ v: 0 }), null); assert.equal(readRecord({ v: 1.5 }), null);
  assert.deepEqual(readRecord({ v: 1, seen: 5, dismissed: 'x', done: -3, extra: true }), { v: 1, seen: 5 });
  assert.deepEqual(readRecord({ v: 1, seen: 5, dismissed: 7, done: 9 }), { v: 1, seen: 5, dismissed: 7, done: 9 });
  assert.equal(shouldInvite(null), true, 'never offered');
  assert.equal(shouldInvite({ v: TOUR_VERSION, seen: 1 }), false, 'offered once is enough, taken or not');
  assert.equal(shouldInvite({ v: TOUR_VERSION, dismissed: 1 }), false);
  assert.equal(shouldInvite({ v: TOUR_VERSION, done: 1 }), false);
  assert.equal(shouldInvite({ v: 1, seen: 1 }, 2), true, 'a tour rewritten is offered again to one who never finished the old');
  assert.equal(shouldInvite({ v: 1, done: 1 }, 2), false, 'but not to one who did');
});

test('noting an event keeps the others of the same tour, and starts over for an older one', () => {
  const seen = mark(null, 'seen', 10);
  assert.deepEqual(seen, { v: TOUR_VERSION, seen: 10 });
  assert.deepEqual(mark(seen, 'done', 20), { v: TOUR_VERSION, seen: 10, done: 20 });
  assert.deepEqual(mark({ v: 1, seen: 10, dismissed: 11 }, 'seen', 30, 2), { v: 2, seen: 30 });
});
