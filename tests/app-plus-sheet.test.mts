import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sheetKey } from '../src/app/plus/modal.ts';
import { SITE_LEGAL, SITE_PLUS, availability } from '../src/app/plus/present.ts';
import { plusOnSale } from '../src/app/plus/config.ts';

const src = (file: string): string => fs.readFileSync(path.join(process.cwd(), 'src/app/plus', file), 'utf8');

test('the sheet keeps the keyboard inside it and Escape closes it: Tab from the last control to the first, Shift+Tab from the first to the last', () => {
  assert.equal(sheetKey('Escape', false, 3, 9), 'close');
  assert.equal(sheetKey('Escape', true, -1, 0), 'close', 'from anywhere');
  assert.deepEqual(sheetKey('Tab', false, 8, 9), { focus: 0 }, 'the last control: round to the first');
  assert.deepEqual(sheetKey('Tab', true, 0, 9), { focus: 8 }, 'the first, backwards: to the last');
  assert.deepEqual(sheetKey('Tab', false, -1, 9), { focus: 0 }, 'the sheet itself (just opened): to the first control');
  assert.equal(sheetKey('Tab', false, 4, 9), null, 'in the middle the browser moves it');
  assert.equal(sheetKey('Enter', false, 4, 9), null);
  assert.equal(sheetKey('Tab', false, -1, 0), null, 'nothing to focus: nothing done');
});

test('the presentation is fetched only when it first opens: the pop-up and the locks import it on demand, never with the page', () => {
  const panel = src('panel.ts');
  assert.ok(!/import[^;]*from '\.\/sheet(-entry)?\.ts'/.test(panel), 'no static import of the sheet');
  assert.match(panel, /import\('\.\/sheet-entry\.ts'\)/, 'a dynamic import');
  assert.match(src('sheet-entry.ts'), /import '\.\/sheet\.css';/, 'its styles come with it');
  for (const file of fs.readdirSync(path.join(process.cwd(), 'src/app')).filter(f => f.endsWith('.ts'))) {
    assert.ok(!/from '\.\/plus\/(sheet|sheet-entry|demo\/index)\.ts'/.test(fs.readFileSync(path.join(process.cwd(), 'src/app', file), 'utf8')), `${file} imports the sheet statically`);
  }
});

test('buying and the pages a seller owes are on the site itself, from any copy of the app; the pill says gift keys while Plus is not on sale', () => {
  assert.equal(SITE_PLUS, 'https://liquiditymapper.com/plus/');
  assert.deepEqual(SITE_LEGAL, { terms: 'https://liquiditymapper.com/terms/', privacy: 'https://liquiditymapper.com/privacy/', refunds: 'https://liquiditymapper.com/refunds/' });
  if (!plusOnSale()) assert.equal(availability(), 'Gift keys only today');
  // The +PnL traders are described in the page's one wording, never by how membership is decided.
  assert.match(src('present.ts'), /the wallets in HyperTracker\\'s four cohorts with a positive all-time perp profit/);
});
