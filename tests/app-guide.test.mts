import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS, readingMinutes, wordsIn } from '../src/app/guide/content.ts';
import { parseInline, plain } from '../src/app/guide/markup.ts';
import { SCENES } from '../src/app/guide/figures.ts';
import { HELP } from '../src/app/help.ts';

// The guide may grow with the page: there is no upper limit (it was sixteen minutes, 2026-10-20, and every feature since had to trim something to fit).
// What keeps it from bloating is what each paragraph teaches, which a test cannot judge (content.ts says so where it is written).
test('the guide is long enough to teach the page', () => {
  const words = SECTIONS.reduce((sum, s) => sum + wordsIn(s), 0), minutes = readingMinutes();
  assert.ok(words >= 2200, `${words} words`);
  assert.ok(minutes >= 10, `${minutes} minutes`);
});

test('sections have unique ids and every figure and help link points at something that exists', () => {
  const ids = SECTIONS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'unique section ids');
  for (const id of ids) assert.match(id, /^[a-z-]+$/);
  for (const [name, topic] of Object.entries(HELP)) assert.ok(ids.includes(topic.guide), `the help for ${name} points at the section ${topic.guide}`);
  for (const section of SECTIONS) for (const block of section.blocks) if (block.t === 'fig') assert.ok(block.id in SCENES, `figure ${block.id} exists`);
  assert.deepEqual(Object.keys(SCENES).sort(), [...new Set(SECTIONS.flatMap(s => s.blocks.flatMap(b => (b.t === 'fig' ? [b.id] : []))))].sort(), 'every scene is used');
});

test('the contents list is in groups: the first section starts one, and no group is named twice', () => {
  assert.ok(SECTIONS[0]!.part, 'the first section begins a group');
  const parts = SECTIONS.flatMap(s => (s.part ? [s.part] : []));
  assert.equal(new Set(parts).size, parts.length, 'a group heading is used once');
  assert.ok(parts.length >= 5 && parts.length <= 9, `${parts.length} groups`);
  for (const section of SECTIONS) assert.ok(section.blocks.some(b => b.t === 'p' || b.t === 'list'), `${section.id} has text to show under its title in a search result`);
});

test('a feature with a "?" panel goes to the section of its own (it once pointed at a section that never mentioned it)', () => {
  const have = new Set(SECTIONS.map(s => s.id));
  const wanted: Record<string, string> = { vwap: 'vwap', keyLevels: 'key-levels', range: 'range', script: 'scripts', scriptPane: 'scripts', funding: 'funding', fundingPane: 'funding', ls: 'ls', lsPane: 'ls', delta: 'delta', deltaPane: 'delta', replay: 'goto', stats: 'bar-stats', sounds: 'sounds', depth: 'depth', depthPane: 'depth', oi: 'open-interest', oiPane: 'open-interest', lt: 'lt', ltPane: 'lt', candlePane: 'phones' };
  for (const [topic, id] of Object.entries(wanted)) {
    assert.ok(have.has(id), `a section ${id}`);
    assert.equal(HELP[topic as keyof typeof HELP].guide, id, `the "?" of ${topic} goes to ${id}`);
  }
});

test('the guide says what the user asked it to say', () => {
  const text = SECTIONS.map(s => plain(JSON.stringify(s))).join(' ').toLowerCase();
  assert.match(text, /no history to download/);
  assert.match(text, /recorded/);
  assert.match(text, /dashed line marks the moment the recording began/);
  assert.match(text, /24 hours/);
  assert.match(text, /mirror only shows while you hover/);
  assert.match(text, /unavailable from your location/);
  assert.match(text, /not advice/);
});

test('inline markup turns into parts and never into markup', () => {
  assert.deepEqual(parseInline('a **b** `c` [[Esc]] *d* e'), [
    { kind: 'text', text: 'a ' }, { kind: 'b', text: 'b' }, { kind: 'text', text: ' ' }, { kind: 'code', text: 'c' }, { kind: 'text', text: ' ' },
    { kind: 'kbd', text: 'Esc' }, { kind: 'text', text: ' ' }, { kind: 'i', text: 'd' }, { kind: 'text', text: ' e' },
  ]);
  assert.equal(plain('<b>x</b> **y**'), '<b>x</b> y', 'angle brackets stay text');
  assert.equal(plain('no markup'), 'no markup');
});
