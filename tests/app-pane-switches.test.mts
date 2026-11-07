import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PANE_SHOW_KEY, STRIP_PANES } from '../src/app/layouts/dock-model.ts';

/**
 * The panes under the map show only while their switch is on. The page hid them from a list written out by hand, and the Funding pane,
 * missing from it, showed for everyone whatever its switch said (2026-11-07). Now every pane of the strip is hidden by its switch.
 */
test('every pane under the map follows its switch, the Funding pane included', () => {
  const main = fs.readFileSync('src/app/main.ts', 'utf8');
  const block = main.slice(main.indexOf('const strip: LayoutPane[] = ['), main.indexOf('const arrange = new Layout('));
  const ids = [...block.matchAll(/\{ id: '([a-z]+)', root: /g)].map(m => m[1]!);
  assert.deepEqual(ids, ['heat', ...STRIP_PANES.map(p => p.id)], 'the page\'s strip is the layouts\' strip, in its order');
  for (const id of ids) if (id !== 'heat') assert.ok(id in PANE_SHOW_KEY, `${id} has a switch`);
  assert.match(main, /for \(const p of strip\) \{ const key = PANE_SHOW_KEY\[p\.id\]; if \(key && p\.id !== 'script'\) p\.root\.hidden = !s\.show\[key\]; \}/, 'each is hidden by it');
  assert.doesNotMatch(main, /depth\.root\.hidden = !s\.show\.depth/, 'no list written out by hand');
});

test('a theme previewed by hover repaints every pane, the Funding pane included', () => {
  const main = fs.readFileSync('src/app/main.ts', 'utf8');
  assert.match(main, /const themed = \[heat, ladder, depth, oi, delta, ls, funding, lt, bars, script, cvd, candle, liq\];/);
  assert.equal(main.match(/for \(const p of themed\) p\.setPalette\(/g)?.length, 3, 'the preview, a picked theme and the first paint');
});
