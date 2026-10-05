import test from 'node:test';
import assert from 'node:assert/strict';
import { placeTip } from '../src/app/tip.ts';
import { HELP } from '../src/app/help.ts';

const viewport = { w: 1000, h: 700 };

test('a tooltip sits centred under its anchor', () => {
  const at = placeTip({ left: 400, right: 460, top: 40, bottom: 66 }, { w: 200, h: 60 }, viewport);
  assert.equal(at.above, false);
  assert.equal(at.top, 74);
  assert.equal(at.left, 330);
});

test('it flips above when there is no room below, and stays inside the window', () => {
  const low = placeTip({ left: 400, right: 460, top: 650, bottom: 676 }, { w: 200, h: 60 }, viewport);
  assert.equal(low.above, true);
  assert.equal(low.top, 650 - 8 - 60);
  const edge = placeTip({ left: 960, right: 1000, top: 10, bottom: 30 }, { w: 300, h: 40 }, viewport);
  assert.equal(edge.left, 1000 - 8 - 300, 'kept off the right edge');
  const corner = placeTip({ left: 0, right: 20, top: 10, bottom: 30 }, { w: 300, h: 40 }, viewport);
  assert.equal(corner.left, 8, 'kept off the left edge');
});

test('every help topic says what it is and points at a guide section', () => {
  for (const [id, topic] of Object.entries(HELP)) {
    assert.ok(topic.tip.length > 30, `${id} has a real tooltip`);
    assert.ok(topic.tip.length < 420, `${id} tooltip stays short`);
    assert.ok(/^[a-z-]+$/.test(topic.guide), `${id} names a guide section`);
  }
  assert.match(HELP.mirror.tip, /Nothing changes until you hover/, 'Mirror says why clicking it shows nothing');
});
