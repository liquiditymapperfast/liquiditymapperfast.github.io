import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

test('the Plus page opens on the presentation the app\'s sheet shows: the hero, the demo with the page\'s own levels control, the feature sections and what stays free; no picture', () => {
  const page = read('src/app/plus/page.ts');
  for (const want of [/import '\.\/present\.css';/, /import '\.\.\/levels-control\.css';/, /from '\.\/demo\/index\.ts'/, /mountDemo\(stage, \{ control: demoControl \}\)/, /mountVisuals\(feats\.hosts\)/, /hero\('plus-title'/, /features\(day\)/, /trust\(\)/]) {
    assert.match(page, want);
  }
  assert.ok(!/history\.webp/.test(page) && !fs.existsSync(path.join(process.cwd(), 'src/app/public/plus/history.webp')), 'the static picture is gone');
  // Drawn once at the top, so the demo runs on while the rest of the page (the membership, the prices, the key box) is drawn afresh.
  assert.match(page, /rest\.replaceChildren\(/);
  assert.ok(!/root\.replaceChildren\(el\('main'[\s\S]*?function drawPage/.test(page.slice(page.indexOf('function drawPage'))), 'drawPage never rebuilds the top');
});

test('the Plus page\'s own rules reach only its lower part and its foot, never the demo or the presentation above it', () => {
  const css = read('src/app/plus/page.css');
  // Rules on bare elements of the whole page would restyle the demo's buttons, paragraphs and lists.
  for (const bare of ['button', 'input', 'p', 'ul', 'li', 'h2', 'figure']) assert.ok(!new RegExp(`^\\.plus-page ${bare}\\b`, 'm').test(css), `.plus-page ${bare}`);
  assert.match(css, /^\.plus-rest button \{/m);
  // The variables the shared parts take from the app's styles, which this page does not load.
  assert.match(css, /--radius: 6px;/); assert.match(css, /--mark-check: url\(/);
  // The levels control's styles live in a file of their own that both the app and the page load.
  assert.match(read('src/app/main.ts'), /import '\.\/levels-control\.css';/);
  assert.ok(!/^\.lv \{/m.test(read('src/app/styles.css')) && /^\.lv \{/m.test(read('src/app/levels-control.css')));
});
