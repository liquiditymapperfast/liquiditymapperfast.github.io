import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { paintAt, pixelRatio, sharpens, sharpScale } from '../src/app/pixel-ratio.ts';
import { capturePageSharp } from '../src/app/screenshot/capture.ts';
import { sources } from '../scripts/i18n-keys.mts';

test('a sharp picture has at least two pixels to a CSS pixel, the screen\'s where it has more, within the size a canvas can take', () => {
  assert.equal(sharpScale(1, 1600, 900), 2, 'a plain screen: twice as sharp');
  assert.equal(sharpScale(1.25, 1920, 1080), 2);
  assert.equal(sharpScale(1.5, 1600, 900), 2);
  assert.equal(sharpScale(2, 1600, 900), null, 'a screen of two already: taken as it shows');
  assert.equal(sharpScale(3, 400, 800), null, 'a phone');
  // A very wide window: no more than keeps the picture within 8192 pixels a side, and none when that is no sharper than the screen.
  assert.equal(sharpScale(1, 6000, 1200), 8192 / 6000);
  assert.equal(sharpScale(1.5, 6000, 1200), null);
  assert.equal(sharpScale(1, 1000, 500, 1500), 1.5, 'the limit is a parameter');
  // A 4K window at one device pixel each: twice as sharp is 33 million pixels, under the 40 million in all; a larger one is held to them.
  assert.equal(sharpScale(1, 3840, 2160), 2);
  assert.ok(Math.abs(sharpScale(1, 5000, 3000)! - Math.sqrt(40e6 / 15e6)) < 1e-12);
});

test('every named pane is sized at the sharp ratio and drawn, then sized and drawn at the screen\'s again; one that throws stops none', () => {
  const log: string[] = [];
  sharpens({ resize: () => log.push(`a resize ${pixelRatio()}`), paint: () => log.push(`a paint ${pixelRatio()}`) });
  sharpens({ resize: () => { throw new Error('x'); }, paint: () => { throw new Error('y'); } });
  sharpens({ resize: () => log.push(`c resize ${pixelRatio()}`), paint: () => log.push(`c paint ${pixelRatio()}`) });
  assert.equal(pixelRatio(), 1, 'the screen\'s (1 where there is no window)');
  paintAt(2);
  assert.equal(pixelRatio(), 2);
  // All are sized before any is drawn: a pane that draws from another's size finds it sized.
  assert.deepEqual(log, ['a resize 2', 'c resize 2', 'a paint 2', 'c paint 2']);
  log.length = 0;
  paintAt(null);
  assert.equal(pixelRatio(), 1);
  assert.deepEqual(log, ['a resize 1', 'c resize 1', 'a paint 1', 'c paint 1']);
});

test('a sharp picture that fails puts every pane back at the screen\'s before the failure goes on', () => {
  const log: string[] = [];
  sharpens({ resize: () => log.push(`resize ${pixelRatio()}`), paint: () => log.push(`paint ${pixelRatio()}`) });
  // In node there is no page to draw, so the picture itself throws, between the sharp drawing and the way back.
  assert.throws(() => capturePageSharp(undefined as unknown as HTMLElement, 2));
  assert.deepEqual(log.filter(l => l.endsWith(' 2')), ['resize 2', 'paint 2']);
  assert.deepEqual(log.slice(-2), ['resize 1', 'paint 1'], 'sized and drawn at the screen\'s again');
  assert.equal(pixelRatio(), 1);
});

test('no module of the page reads the screen\'s pixel ratio for its canvases but through pixelRatio()', () => {
  // A canvas sized from devicePixelRatio itself would stay as sharp as the screen in a sharp picture (pixel-ratio.ts). These read it on purpose:
  // the ratio itself, the picture's own scale and the GIF's plan, and the Guide's figures, drawn in its own dialog.
  const allowed = new Set(['pixel-ratio.ts', 'screenshot/capture.ts', 'screenshot/editor.ts', 'guide/figures.ts']);
  const readers = sources().filter(s => fs.readFileSync(s.file, 'utf8').includes('devicePixelRatio')).map(s => s.rel.split('\\').join('/'));
  assert.deepEqual(readers.filter(r => !allowed.has(r)), []);
  assert.ok(readers.includes('pixel-ratio.ts'), 'the scan sees the page');
});
