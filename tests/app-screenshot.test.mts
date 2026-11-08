import test from 'node:test';
import assert from 'node:assert/strict';
import { arrowHead, blockArrow, clampRect, fileName, hitHandle, inside, markPlacement, markText, rectFrom, resizeRect, snapAngle, squareTo, toolbarPlacement, worthKeeping, type Shape } from '../src/app/screenshot/shapes.ts';
import { borderSides, clear, cleared, clipPolygon, contentText, fadeStops, cssLength, cssMatrix, flexStarts, gradientPlace, maskPlace, maskUrl, outerShadows, solidGradient, splitTop, topWords, svgAlign, svgBaseline, svgDash, svgPaintOrder, svgPaints, unturnedCorner } from '../src/app/screenshot/capture.ts';

const screen = { w: 1200, h: 800 };

test('a rectangle dragged in any direction has positive size', () => {
  assert.deepEqual(rectFrom({ x: 100, y: 80 }, { x: 40, y: 20 }), { x: 40, y: 20, w: 60, h: 60 });
  assert.deepEqual(rectFrom({ x: 5, y: 5 }, { x: 5, y: 5 }), { x: 5, y: 5, w: 0, h: 0 });
});

test('a rectangle is kept on screen', () => {
  assert.deepEqual(clampRect({ x: -20, y: 790, w: 100, h: 50 }, screen), { x: 0, y: 750, w: 100, h: 50 });
  assert.deepEqual(clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, screen), { x: 0, y: 0, w: 1200, h: 800 });
});

test('handles are found near their corner and edge points, nearest first', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.equal(hitHandle(r, { x: 103, y: 98 }), 'nw');
  assert.equal(hitHandle(r, { x: 200, y: 101 }), 'n');
  assert.equal(hitHandle(r, { x: 300, y: 150 }), 'e');
  assert.equal(hitHandle(r, { x: 200, y: 150 }), null, 'the middle of the area is not a handle');
});

test('resizing moves only the grabbed edges, keeps a minimum size and stays inside the screen', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(resizeRect(r, 'se', { x: 400, y: 260 }, screen), { x: 100, y: 100, w: 300, h: 160 });
  assert.deepEqual(resizeRect(r, 'w', { x: 60, y: 999 }, screen), { x: 60, y: 100, w: 240, h: 100 }, 'a west edge ignores vertical movement');
  assert.deepEqual(resizeRect(r, 'e', { x: 90, y: 150 }, screen, 12), { x: 100, y: 100, w: 12, h: 100 }, 'cannot collapse');
  assert.equal(resizeRect(r, 'se', { x: 5000, y: 5000 }, screen).w, 1100);
  assert.deepEqual(resizeRect(r, 'nw', { x: 500, y: 500 }, screen, 12), { x: 288, y: 188, w: 12, h: 12 }, 'dragging a corner past the opposite one stops at the minimum');
});

test('inside is inclusive of the edges', () => {
  assert.ok(inside({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 10 }));
  assert.ok(!inside({ x: 0, y: 0, w: 10, h: 10 }, { x: 10.1, y: 5 }));
});

test('the toolbar goes under the selection, flips above, or sits inside when the selection fills the screen', () => {
  const bar = { w: 520, h: 52 };
  assert.deepEqual(toolbarPlacement({ x: 100, y: 100, w: 400, h: 200 }, bar, screen), { x: 8, y: 310 }, 'right-aligned to the selection but kept on screen');
  assert.deepEqual(toolbarPlacement({ x: 600, y: 100, w: 500, h: 200 }, bar, screen), { x: 580, y: 310 });
  assert.equal(toolbarPlacement({ x: 100, y: 500, w: 400, h: 280 }, bar, screen).y, 500 - 10 - 52, 'above when there is no room below');
  const full = toolbarPlacement({ x: 0, y: 0, w: 1200, h: 800 }, bar, screen);
  assert.ok(full.y > 600 && full.y <= 800 - 52 - 8, 'inside the bottom edge');
});

test('an arrow head sits at the tip, symmetric about the shaft', () => {
  const [l, r] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
  assert.ok(l.x < 100 && r.x < 100);
  assert.ok(Math.abs(l.x - r.x) < 1e-9 && Math.abs(l.y + r.y) < 1e-9);
  const [shortL] = arrowHead({ x: 0, y: 0 }, { x: 6, y: 0 }, 8);
  assert.ok(Math.hypot(6 - shortL.x, shortL.y) < 24, 'a short arrow does not get a huge head');
});

test('a click without a drag leaves nothing behind', () => {
  const dot: Shape = { kind: 'rect', a: { x: 5, y: 5 }, b: { x: 6, y: 6 }, color: '#f00', width: 4 };
  assert.ok(!worthKeeping(dot));
  assert.ok(worthKeeping({ kind: 'rect', a: { x: 5, y: 5 }, b: { x: 50, y: 40 }, color: '#f00', width: 4 }));
  assert.ok(!worthKeeping({ kind: 'text', at: { x: 0, y: 0 }, text: '   ', color: '#f00', size: 22 }));
  assert.ok(!worthKeeping({ kind: 'pen', points: [{ x: 1, y: 1 }], color: '#f00', width: 4 }));
  assert.ok(!worthKeeping({ kind: 'pixelate', rect: { x: 0, y: 0, w: 2, h: 40 }, strength: 10 }));
});

test('files are named by date and time', () => {
  assert.equal(fileName(new Date(2026, 9, 5, 14, 3, 7)), 'liquiditymapperfast-2026-10-05-1403-07.png');
});

test('shift keeps a rectangle square and a line on a multiple of 45 degrees', () => {
  assert.deepEqual(squareTo({ x: 10, y: 10 }, { x: 60, y: 30 }), { x: 60, y: 60 });
  assert.deepEqual(squareTo({ x: 10, y: 10 }, { x: -20, y: 25 }), { x: -20, y: 40 });
  const near = snapAngle({ x: 0, y: 0 }, { x: 100, y: 6 });
  assert.ok(Math.abs(near.y) < 1e-9 && Math.abs(near.x - Math.hypot(100, 6)) < 1e-9, 'almost horizontal snaps to horizontal');
  const diagonal = snapAngle({ x: 0, y: 0 }, { x: 50, y: 44 });
  assert.ok(Math.abs(diagonal.x - diagonal.y) < 1e-9, 'almost diagonal snaps to the diagonal');
});

test('commas inside a function do not split a CSS value', () => {
  assert.deepEqual(splitTop('to right, rgb(1, 2, 3) 0%, rgba(4, 5, 6, 0.5) 100%'), ['to right', 'rgb(1, 2, 3) 0%', 'rgba(4, 5, 6, 0.5) 100%']);
  assert.deepEqual(splitTop(''), []);
});

test('the corner mark says the address without its scheme, in the bottom-right corner of a picture that has room for it', () => {
  assert.equal(markText('https://liquiditymapperfast.github.io/'), 'liquiditymapperfast.github.io');
  assert.equal(markText('http://localhost:8787'), 'localhost:8787');
  const at = markPlacement({ w: 800, h: 500 }, 150)!;
  assert.deepEqual(at, { x: 800 - 8 - 164, y: 500 - 8 - 18, w: 164, h: 18 });
  assert.ok(at.x + at.w <= 800 - 8 && at.y + at.h <= 500 - 8, 'inside the picture, a margin from the edge');
});

test('a picture too small to carry the mark without covering what is in it gets none', () => {
  assert.equal(markPlacement({ w: 200, h: 500 }, 150), null, 'too narrow');
  assert.equal(markPlacement({ w: 800, h: 50 }, 150), null, 'too short');
  assert.ok(markPlacement({ w: 400, h: 200 }, 150));
});

test('a block arrow points at where the drag ended, its shaft as wide as set and its head wider, in any direction', () => {
  const outline = blockArrow({ x: 0, y: 0 }, { x: 200, y: 0 }, 40);
  assert.equal(outline.length, 7);
  assert.deepEqual(outline[3], { x: 200, y: 0 }, 'the point');
  assert.deepEqual([outline[0]!.y, outline[6]!.y], [20, -20], 'the shaft is 40 wide at the tail');
  assert.ok(Math.abs(outline[2]!.y - outline[4]!.y - 76) < 1e-9, 'the head is 1.9 times as wide');
  assert.ok(Math.abs(outline[2]!.x - (200 - 54)) < 1e-9, 'the head is 1.25 times the width long, plus 4');
  // A short arrow is at most half head; a diagonal one is the same shape turned.
  const short = blockArrow({ x: 0, y: 0 }, { x: 40, y: 0 }, 40);
  assert.equal(short[1]!.x, 20);
  const diagonal = blockArrow({ x: 10, y: 10 }, { x: 110, y: 110 }, 20), tip = diagonal[3]!;
  assert.ok(Math.abs(tip.x - 110) < 1e-9 && Math.abs(tip.y - 110) < 1e-9);
  assert.deepEqual(blockArrow({ x: 5, y: 5 }, { x: 5, y: 5 }, 20), [], 'nothing for no length');
  assert.ok(!worthKeeping({ kind: 'block', a: { x: 0, y: 0 }, b: { x: 5, y: 0 }, color: '#f00', width: 4, size: 36, fill: 0.2, border: 'color' }));
  assert.ok(worthKeeping({ kind: 'block', a: { x: 0, y: 0 }, b: { x: 50, y: 0 }, color: '#f00', width: 4, size: 36, fill: 0.2, border: 'color' }));
});

test('an SVG drawing is read from its computed styles: where its text lines up, its dashes, and which paints draw', () => {
  assert.equal(svgAlign('middle'), 'center'); assert.equal(svgAlign('end'), 'end'); assert.equal(svgAlign('start'), 'start'); assert.equal(svgAlign(''), 'start');
  assert.equal(svgBaseline('middle'), 'alphabetic', 'drawn on the baseline and moved up by half the x-height'); assert.equal(svgBaseline('central'), 'middle'); assert.equal(svgBaseline('hanging'), 'hanging'); assert.equal(svgBaseline('auto'), 'alphabetic');
  assert.deepEqual(svgDash('none'), []); assert.deepEqual(svgDash('2px, 2px'), [2, 2]); assert.deepEqual(svgDash('4 1.5'), [4, 1.5]); assert.deepEqual(svgDash(''), []);
  assert.deepEqual(svgDash('10%, 5%'), [], 'a share of the viewport is not resolved: drawn solid');
  assert.deepEqual(svgPaintOrder('normal'), ['fill', 'stroke']); assert.deepEqual(svgPaintOrder('stroke'), ['stroke', 'fill']);
  assert.deepEqual(svgPaintOrder('markers stroke fill'), ['stroke', 'fill']); assert.deepEqual(svgPaintOrder('fill markers'), ['fill', 'stroke']);
  assert.equal(svgPaints('rgb(15, 164, 74)'), true); assert.equal(svgPaints('none'), false); assert.equal(svgPaints('url("#g")'), false); assert.equal(svgPaints(''), false);
});

test('a border is drawn side by side as the page draws it: a side of no width between two wide ones leaves a triangle', () => {
  // The coin key's caret: an empty box with a 4 px top border in the text colour and transparent 4 px sides, so a triangle pointing down.
  const [top, right, , left] = borderSides({ x: 10, y: 20, w: 8, h: 4 }, [4, 4, 0, 4]);
  assert.deepEqual(top, [[10, 20], [18, 20], [14, 24], [14, 24]], 'the top side narrows to the middle of its lower edge');
  assert.deepEqual(right, [[18, 20], [18, 24], [14, 24], [14, 24]]);
  assert.deepEqual(left, [[10, 24], [10, 20], [14, 24], [14, 24]]);
  // An ordinary box: each side a band as wide as its border, mitred at the corners.
  const [t2, r2, b2, l2] = borderSides({ x: 0, y: 0, w: 100, h: 50 }, [1, 2, 3, 4]);
  assert.deepEqual(t2, [[0, 0], [100, 0], [98, 1], [4, 1]]);
  assert.deepEqual(r2, [[100, 0], [100, 50], [98, 47], [98, 1]]);
  assert.deepEqual(b2, [[100, 50], [0, 50], [4, 47], [98, 47]]);
  assert.deepEqual(l2, [[0, 50], [0, 0], [4, 1], [4, 47]]);
  assert.equal(clear('rgba(0, 0, 0, 0)'), true); assert.equal(clear('transparent'), true); assert.equal(clear('color(srgb 0.1 0.2 0.3 / 0)'), true);
  assert.equal(clear('rgba(27, 29, 33, 0.5)'), false); assert.equal(clear('rgb(27, 29, 33)'), false); assert.equal(clear('rgba(1, 2, 3, 0.05)'), false);
  // A colour whose last channel is 0 is not clear: the Terminal theme's green keys (rgb(0, 255, 0)) went missing from the picture.
  assert.equal(clear('rgb(0, 255, 0)'), false); assert.equal(clear('rgb(0, 0, 0)'), false); assert.equal(clear('rgba(0, 255, 0, 1)'), false);
  assert.equal(clear('rgba(255, 0, 0, 0.0)'), true); assert.equal(clear('color(srgb 0 1 0)'), false); assert.equal(clear('oklab(0.5 0.1 0 / 0)'), true);
});

test('an icon drawn as a colour through a mask: its picture is read only from this page or a data address, and laid where the CSS puts it', () => {
  const origin = 'https://liquiditymapperfast.github.io/';
  const svg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3C/svg%3E`;
  assert.equal(maskUrl(`url("${svg}")`, origin), svg, 'a data address, quoted as the computed style writes it');
  assert.equal(maskUrl('url("data:image/svg+xml,a\\"b")', origin), 'data:image/svg+xml,a"b', 'escapes are undone');
  assert.equal(maskUrl('url(/icons/x.svg)', origin), '/icons/x.svg');
  assert.equal(maskUrl('url("https://elsewhere.example/x.svg")', origin), null, 'another site would spoil the picture: left out');
  assert.equal(maskUrl('linear-gradient(red, blue)', origin), null);
  // `center / contain`: a square icon in a wider box is as tall as the box, in its middle.
  assert.deepEqual(maskPlace('contain', '50% 50%', 20, 10, 24, 24), { x: 5, y: 0, w: 10, h: 10 });
  assert.deepEqual(maskPlace('cover', '50% 50%', 20, 10, 24, 24), { x: 0, y: -5, w: 20, h: 20 });
  // The classic frame's keys: `0 0 / 11px 9px`.
  assert.deepEqual(maskPlace('11px 9px', '0px 0px', 16, 14, 0, 0), { x: 0, y: 0, w: 11, h: 9 });
  assert.deepEqual(maskPlace('12px auto', '100% 0%', 20, 20, 24, 12), { x: 8, y: 0, w: 12, h: 6 }, 'one length: the other from the picture');
  assert.deepEqual(maskPlace('auto', '0% 0%', 30, 30, 0, 0), { x: 0, y: 0, w: 30, h: 30 }, 'a picture of no size of its own fills the box');
  assert.deepEqual(maskPlace('contain, 4px 4px', '50% 50%, 0px 0px', 10, 10, 1, 1), { x: 0, y: 0, w: 10, h: 10 }, 'the first layer');
});

test('a turned box is drawn turned: its matrix, and where its corner was before the turn', () => {
  assert.equal(cssMatrix('none'), null);
  assert.deepEqual(cssMatrix('matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0)'), [0.707107, 0.707107, -0.707107, 0.707107, 0, 0]);
  assert.deepEqual(cssMatrix('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1)'), [1, 0, 0, 1, 5, 6]);
  // A 10 × 4 box turned a quarter about its middle: its bounds are 4 × 10 around the same middle.
  const corner = unturnedCorner({ x: 103, y: 47, w: 4, h: 10 }, 10, 4, [0, 1, -1, 0, 0, 0], [5, 2])!;
  assert.ok(Math.abs(corner.x - 100) < 1e-9 && Math.abs(corner.y - 50) < 1e-9);
  // Half a turn about the middle leaves the box where it was.
  const half = unturnedCorner({ x: 20, y: 30, w: 8, h: 6 }, 8, 6, [-1, 0, 0, -1, 0, 0], [4, 3])!;
  assert.ok(Math.abs(half.x - 20) < 1e-9 && Math.abs(half.y - 30) < 1e-9);
  assert.equal(unturnedCorner({ x: 0, y: 0, w: 5, h: 5 }, 5, 5, [1, 0, 0, 1, 7, 8], [0, 0]), null, 'a move alone: the bounds are the box');
});

test('the text of a ::before or ::after: its strings and attributes, and nothing for content that is not text', () => {
  const attrs: Record<string, string> = { 'data-mark': 'OK', 'aria-label': 'Settings' };
  const attr = (name: string): string | null => attrs[name] ?? null;
  assert.equal(contentText('""', attr), '', 'an empty string: the box alone');
  assert.equal(contentText('"LMF"', attr), 'LMF');
  assert.equal(contentText('attr(data-mark)', attr), 'OK');
  assert.equal(contentText('"(" attr(aria-label) ")"', attr), '(Settings)');
  assert.equal(contentText('attr(title)', attr), '', 'a missing attribute writes nothing');
  assert.equal(contentText('"\\2715"', attr), '✕', 'a hexadecimal escape');
  assert.equal(contentText('"a\\"b"', attr), 'a"b');
  assert.equal(contentText('counter(item)', attr), null);
  assert.equal(contentText('url("x.png")', attr), null);
});

test('the items of a flex line start where the line justifies them, with their margins and the gap between them', () => {
  // The Layouts key: icon 13, gap 5, text 44, in a line from 7 of length 56 starting at the line's start.
  const items = [{ size: 13, before: 0, after: 0 }, { size: 44, before: 0, after: 0 }];
  assert.deepEqual(flexStarts(7, 56, 5, 'normal', items), [7, 25]);
  assert.deepEqual(flexStarts(7, 56, 5, 'flex-start', items), [7, 25]);
  // Compact: the text has no width, the icon is centred with the gap still counted.
  const compact = [{ size: 13, before: 0, after: 0 }, { size: 0, before: 0, after: 0 }];
  assert.deepEqual(flexStarts(0, 28, 5, 'center', compact), [5, 23]);
  assert.deepEqual(flexStarts(0, 100, 0, 'flex-end', [{ size: 10, before: 2, after: 3 }]), [87]);
  assert.deepEqual(flexStarts(0, 100, 0, 'space-between', [{ size: 10, before: 0, after: 0 }, { size: 10, before: 0, after: 0 }]), [0, 90]);
  assert.deepEqual(flexStarts(0, 100, 0, 'space-around', [{ size: 10, before: 0, after: 0 }, { size: 10, before: 0, after: 0 }]), [20, 70]);
  const evenly = flexStarts(0, 100, 0, 'space-evenly', [{ size: 10, before: 0, after: 0 }, { size: 10, before: 0, after: 0 }]);
  assert.ok(Math.abs(evenly[0]! - 80 / 3) < 1e-9 && Math.abs(evenly[1]! - (2 * 80 / 3 + 10)) < 1e-9, 'space-evenly: three equal spaces');
  assert.deepEqual(flexStarts(0, 100, 4, 'normal', []), []);
});

test('a box keeps its outer shadows, read from the computed box-shadow, the first on top; inset ones and clear ones are left out', () => {
  assert.deepEqual(outerShadows('none'), []);
  assert.deepEqual(outerShadows('rgba(0, 0, 0, 0.28) 3px 3px 0px 0px'), [{ color: 'rgba(0, 0, 0, 0.28)', x: 3, y: 3, blur: 0, spread: 0 }]);
  assert.deepEqual(outerShadows('rgb(15, 164, 74) 0px 0px 6px 1px, rgba(0, 0, 0, 0.5) 0px 1px 0px 0px inset'), [{ color: 'rgb(15, 164, 74)', x: 0, y: 0, blur: 6, spread: 1 }]);
  assert.deepEqual(outerShadows('rgba(0, 0, 0, 0) 2px 2px 4px 0px'), [], 'a clear shadow draws nothing');
  assert.deepEqual(outerShadows('color(srgb 0.1 0.2 0.3 / 0.4) -1px 2px 3px 0px').map(s => [s.color, s.x, s.y, s.blur]), [['color(srgb 0.1 0.2 0.3 / 0.4)', -1, 2, 3]]);
});

test('a polygon clip-path is read as its corners in the box; any other clip leaves the box out', () => {
  // The tour keys' play triangle: an 8 x 10 box clipped to polygon(0 0, 100% 50%, 0 100%).
  assert.deepEqual(clipPolygon('polygon(0px 0px, 100% 50%, 0px 100%)', 8, 10), { points: [[0, 0], [8, 5], [0, 10]], rule: 'nonzero' });
  assert.deepEqual(clipPolygon('polygon(evenodd, 2px 0px, 10px 0px, 10px 4px)', 20, 20, 0.9), { points: [[1.8, 0], [9, 0], [9, 3.6]], rule: 'evenodd' }, 'lengths zoomed');
  assert.equal(clipPolygon('none', 8, 10), null);
  assert.equal(clipPolygon('', 8, 10), null);
  assert.equal(clipPolygon('circle(50% at 50% 50%)', 8, 10), 'other');
  assert.equal(clipPolygon('inset(2px)', 8, 10), 'other');
  assert.equal(clipPolygon('url("#c")', 8, 10), 'other');
  assert.equal(clipPolygon('polygon(0px 0px, 10px 10px)', 8, 10), 'other', 'two corners are no shape');
  // A picture laid at its own size is zoomed with its element (the Classic frame's check marks: an SVG 7 px square).
  assert.deepEqual(maskPlace('auto', '50% 50%', 13, 13, 7, 7, 0.9), { x: (13 - 6.3) / 2, y: (13 - 6.3) / 2, w: 6.3, h: 6.3 });
});

test('a background layer is placed from its computed size and position, sums of a share and a length included', () => {
  assert.deepEqual(topWords('calc(100% - 7px) calc(50% - 0.5px)'), ['calc(100% - 7px)', 'calc(50% - 0.5px)']);
  assert.deepEqual(topWords('  7px   4px '), ['7px', '4px']);
  assert.ok(Math.abs(cssLength('calc(100% - 7px)', 71.67) - 64.67) < 1e-9);
  assert.equal(cssLength('calc(50% + -0.5px)', 14), 6.5);
  assert.equal(cssLength('25%', 80), 20); assert.ok(Math.abs(cssLength('3px', 80, 0.9) - 2.7) < 1e-9, 'a length is zoomed'); assert.equal(cssLength('0', 80), 0);
  assert.ok(Number.isNaN(cssLength('calc(100% - 2em)', 80)), 'a unit it cannot resolve: NaN, so the layer is left out');
  assert.ok(Number.isNaN(cssLength('center', 80)));
  // The Classic frame's select arrow: 7 x 4 at `calc(100% - 7px) calc(50% - 0.5px)` of a 78.67 x 18 box: at its right, not at 0, 0.
  const arrow = maskPlace('7px 4px, 12px calc(100% - 8px), auto', 'calc(100% - 7px) calc(50% - 0.5px), calc(100% - 4px) 4px, 0% 0%', 78.67, 18, 7, 4);
  assert.ok(Math.abs(arrow.x - 64.67) < 1e-9 && Math.abs(arrow.y - 6.5) < 1e-9 && arrow.w === 7 && arrow.h === 4);
  assert.ok(Number.isNaN(maskPlace('7px 4px', 'calc(100% - 1em) 0px', 20, 20, 7, 4).x));
  // A gradient has no size of its own: `auto` is the whole box that way; the Classic title bar is a strip inset 4 px.
  assert.deepEqual(gradientPlace('auto', '0% 0%', 100, 30), { x: 0, y: 0, w: 100, h: 30 });
  assert.deepEqual(gradientPlace('calc(100% - 8px) 18px', '4px 4px', 100, 30), { x: 4, y: 4, w: 92, h: 18 });
  assert.deepEqual(gradientPlace('12px auto', 'calc(100% - 4px) 0px', 100, 30), { x: 84, y: 0, w: 12, h: 30 });
  // A gradient of one colour is that colour; one of several is not drawn as one.
  assert.equal(solidGradient('conic-gradient(rgb(192, 192, 192), rgb(192, 192, 192))'), 'rgb(192, 192, 192)');
  assert.equal(solidGradient('linear-gradient(rgb(1, 2, 3), rgb(1, 2, 3))'), 'rgb(1, 2, 3)');
  assert.equal(solidGradient('linear-gradient(90deg, rgb(1, 2, 3) 0%, rgb(1, 2, 3) 100%)'), 'rgb(1, 2, 3)');
  assert.equal(solidGradient('radial-gradient(circle at 50% 50%, red, blue)'), null);
  assert.equal(solidGradient('url("x.png")'), null);
  // A clip corner it cannot read leaves the box out; a sum it can is drawn.
  assert.deepEqual(clipPolygon('polygon(4px 0px, 100% 0px, calc(100% - 6px) 100%, 0px 100%)', 50, 10), { points: [[4, 0], [50, 0], [44, 10], [0, 10]], rule: 'nonzero' });
  assert.equal(clipPolygon('polygon(0px 0px, 100% 0px, calc(100% - 1em) 100%)', 50, 10), 'other');
});

test('a gradient that fades to clear fades its own colour, as CSS mixes it, not through black', () => {
  assert.equal(cleared('rgb(23, 23, 27)'), 'rgba(23, 23, 27, 0)');
  assert.equal(cleared('rgba(23, 23, 27, 0.8)'), 'rgba(23, 23, 27, 0)');
  assert.equal(cleared('color(srgb 0.1 0.2 0.3 / 0.5)'), 'color(srgb 0.1 0.2 0.3 / 0)');
  // The phone dock's shade strip: the panel colour to transparent.
  assert.deepEqual(fadeStops([{ at: 0, color: 'rgb(23, 23, 27)' }, { at: 1, color: 'rgba(0, 0, 0, 0)' }]), [{ at: 0, color: 'rgb(23, 23, 27)' }, { at: 1, color: 'rgba(23, 23, 27, 0)' }]);
  // A clear stop between two colours fades each side to its own colour: two stops at the same place.
  assert.deepEqual(fadeStops([{ at: 0, color: 'rgb(255, 0, 0)' }, { at: 0.5, color: 'transparent' }, { at: 1, color: 'rgb(0, 0, 255)' }]),
    [{ at: 0, color: 'rgb(255, 0, 0)' }, { at: 0.5, color: 'rgba(255, 0, 0, 0)' }, { at: 0.5, color: 'rgba(0, 0, 255, 0)' }, { at: 1, color: 'rgb(0, 0, 255)' }]);
  assert.deepEqual(fadeStops([{ at: 0, color: 'transparent' }, { at: 1, color: 'transparent' }]), [{ at: 0, color: 'transparent' }, { at: 1, color: 'transparent' }], 'all clear: left as it is');
});
