import test from 'node:test';
import assert from 'node:assert/strict';
import { paintAt, pixelRatio, sharpens, sharpScale } from '../src/app/pixel-ratio.ts';

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
