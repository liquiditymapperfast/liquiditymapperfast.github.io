import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PADDLE, plusOnSale } from '../src/app/plus/config.ts';

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

test('before the sale opens the Plus page says the monthly price (Karl, 2026-11-20: $10 a month) and offers no checkout', () => {
  assert.equal(PADDLE.monthly.usd, 10, 'the monthly price written on the page');
  assert.equal(plusOnSale(), false, 'still not on sale (the sale gate)');
  const page = read('src/app/plus/page.ts'), branch = page.slice(page.indexOf('function notOnSaleSection()'), page.indexOf('function drawTop('));
  assert.ok(branch.length > 0 && branch.includes('if (!plusOnSale()) {'), 'the not-on-sale section is where it was found');
  assert.match(branch, /PADDLE\.monthly\.usd > 0/, 'the price is written where one is set');
  assert.match(branch, /t\('\{price\} a month', \{ price: money\(PADDLE\.monthly\.usd\) \}\)/, 'in the same words as the price button');
  assert.match(branch, /t\('Plus is being set up, and the checkout opens on this page soon\. Prices are before tax\.'\)/);
  assert.match(branch, /return box;/);
  assert.ok(!/el\('button'/.test(branch), 'no button before the checkout exists');
  for (const lang of ['de', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'ru', 'tr', 'uk', 'zh']) {
    const pack = JSON.parse(read(`src/app/i18n/${lang}.json`)) as Record<string, string>;
    assert.ok(pack['Plus is being set up, and the checkout opens on this page soon. Prices are before tax.'], `${lang}: the sentence is translated`);
  }
});
