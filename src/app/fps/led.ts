/**
 * The frame-rate meter's LED window (2026-11-14, Karl: "old school LED panels ... as analog as possible, really an artwork, but at the same
 * time blazing fast"; the glow look). A smoked window in a thin bezel with three slanted seven-segment digits (the unlit segments faintly
 * there, as on a real display), the legends FPS and GPU in silkscreen, a round lamp behind a lens, and a ten-cell bar from green through amber
 * to red. Everything is drawn once into sprites at the screen's pixel ratio; a frame of the meter is a handful of drawImage calls.
 */
import type { Tone } from './model.ts';

/** The window's size in CSS px: it sits in the 25 px status bar. */
export const LED_W = 106, LED_H = 20;
/** What a lamp or a digit shows: the tones, and `idle` for the dashes shown while the meter is still measuring. */
export type LedTone = Tone | 'idle';
const HUE: Record<LedTone, string> = { green: '#46ff82', amber: '#ffb52e', red: '#ff4636', idle: '#55665b' };
/** The hot centre of a lit segment: the hue towards white, as an LED behind its diffuser looks. */
const CORE: Record<LedTone, string> = { green: '#c8ffd9', amber: '#ffe7b8', red: '#ffc2ba', idle: '#7a8a80' };
const UNLIT = 'rgba(170,220,185,0.065)';

/** A digit's cell (CSS px) and where the three cells start; the segments' thickness and the slant (x moves by `SLANT` px per px up). */
const CELL_W = 10, CELL_H = 14, DIGIT_X = [4, 15.5, 27], DIGIT_Y = 3, T = 2.2, SLANT = 0.11;
/** The legends, the lamp and the bar. */
const LEGEND_X = 40.5, LAMP = { x: 60.5, y: 13.6, r: 2.3 }, BAR_X = 67, BAR_STEP = 3.5, CELL = { w: 2.3, y: 5.5, h: 9 };
/** The bar's cells' colours, green to red as a level meter. */
export const BAR_TONES: readonly Tone[] = ['green', 'green', 'green', 'green', 'green', 'green', 'amber', 'amber', 'red', 'red'];

/** The segments a character lights: a to g, as on every seven-segment display. */
export const SEGMENTS: Readonly<Record<string, string>> = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd', '-': 'g', ' ': '',
};

type Pt = [number, number];
/** A segment's outline in its cell (CSS px from the cell's top left, before the slant): a hexagon pointed at both ends, a gap at each joint. */
export function segmentShape(seg: string): Pt[] {
  const h = T / 2, gap = 0.7, l = h + gap, r = CELL_W - h - gap, mid = CELL_H / 2;
  const across = (y: number): Pt[] => [[l, y], [l + h, y - h], [r - h, y - h], [r, y], [r - h, y + h], [l + h, y + h]];
  const down = (x: number, y0: number, y1: number): Pt[] => [[x, y0], [x + h, y0 + h], [x + h, y1 - h], [x, y1], [x - h, y1 - h], [x - h, y0 + h]];
  switch (seg) {
    case 'a': return across(h);
    case 'g': return across(mid);
    case 'd': return across(CELL_H - h);
    case 'f': return down(h, h + gap, mid - gap);
    case 'b': return down(CELL_W - h, h + gap, mid - gap);
    case 'e': return down(h, mid + gap, CELL_H - h - gap);
    case 'c': return down(CELL_W - h, mid + gap, CELL_H - h - gap);
    default: return [];
  }
}

function segPath(ctx: CanvasRenderingContext2D, ox: number, oy: number, seg: string): void {
  const pts = segmentShape(seg); if (!pts.length) return;
  ctx.beginPath();
  pts.forEach(([x, y], i) => { const px = ox + x + (CELL_H / 2 - y) * SLANT, py = oy + y; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
  ctx.closePath();
}

function canvasOf(w: number, h: number, ratio: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas'); c.width = Math.ceil(w * ratio); c.height = Math.ceil(h * ratio);
  const x = c.getContext('2d')!; x.scale(ratio, ratio); return [c, x];
}

/** The glow's blur (CSS px): 5 device pixels on a screen of 1.5, as first built, and the same size at every ratio (review r17: a shadow's blur is in device pixels, the transform does not scale it, so it was thinner on sharper screens). */
const GLOW = 10 / 3;

/** Light `draw`'s shape: a halo of the hue (the glow), the hue itself, then its hot centre a little smaller. */
function lit(x: CanvasRenderingContext2D, tone: LedTone, draw: () => void, core = true): void {
  x.save(); x.shadowColor = HUE[tone]; x.shadowBlur = tone === 'idle' ? 0 : GLOW * x.getTransform().a; x.fillStyle = HUE[tone]; draw(); x.fill(); x.restore();
  if (core && tone !== 'idle') { x.save(); x.globalAlpha = 0.55; x.fillStyle = CORE[tone]; draw(); x.fill(); x.restore(); }
}

export interface LedSprites { ratio: number; base: HTMLCanvasElement; digits: Record<LedTone, Record<string, HTMLCanvasElement>>; lamps: Record<LedTone, HTMLCanvasElement>; cells: Record<Tone, HTMLCanvasElement> }
/** Room a lit sprite leaves around its shape for the glow (CSS px). */
const PAD = 4;

/** Everything the window draws, made once for a pixel ratio. */
export function ledSprites(ratio: number): LedSprites {
  const [base, b] = canvasOf(LED_W, LED_H, ratio);
  // The bezel: a black frame, the smoked window inside it, a hairline of light along the top and a darker one along the foot.
  b.fillStyle = '#020302'; b.beginPath(); b.roundRect(0, 0, LED_W, LED_H, 2); b.fill();
  const glass = b.createLinearGradient(0, 1, 0, LED_H - 1); glass.addColorStop(0, '#161b18'); glass.addColorStop(0.5, '#0b0e0c'); glass.addColorStop(1, '#060807');
  b.fillStyle = glass; b.beginPath(); b.roundRect(1, 1, LED_W - 2, LED_H - 2, 1.5); b.fill();
  b.fillStyle = 'rgba(255, 255, 255, 0.075)'; b.fillRect(2, 1, LED_W - 4, 1);
  b.fillStyle = 'rgba(0, 0, 0, 0.6)'; b.fillRect(2, LED_H - 2, LED_W - 4, 1);
  // The acrylic's reflection: a pale band across the top left, crisp-edged.
  b.fillStyle = 'rgba(255, 255, 255, 0.022)'; b.beginPath(); b.moveTo(1, 1); b.lineTo(46, 1); b.lineTo(30, LED_H - 1); b.lineTo(1, LED_H - 1); b.closePath(); b.fill();
  // The unlit segments, lamp lens and bar cells, as a real display shows them switched off.
  for (const ox of DIGIT_X) for (const s of 'abcdefg') { segPath(b, ox, DIGIT_Y, s); b.fillStyle = UNLIT; b.fill(); }
  b.fillStyle = '#151a16'; b.beginPath(); b.arc(LAMP.x, LAMP.y, LAMP.r + 0.6, 0, Math.PI * 2); b.fill();
  b.fillStyle = '#222924'; b.beginPath(); b.arc(LAMP.x, LAMP.y, LAMP.r, 0, Math.PI * 2); b.fill();
  for (let i = 0; i < 10; i++) { b.fillStyle = UNLIT; b.fillRect(BAR_X + i * BAR_STEP, CELL.y, CELL.w, CELL.h); }
  // The legends, printed on the faceplate.
  b.fillStyle = '#7d867f'; b.font = '700 5.5px ui-sans-serif, system-ui, sans-serif'; b.textBaseline = 'alphabetic';
  b.fillText('FPS', LEGEND_X, 9); b.fillText('GPU', LEGEND_X, 16);
  const tones: LedTone[] = ['green', 'amber', 'red', 'idle'];
  const digits = {} as LedSprites['digits'], lamps = {} as LedSprites['lamps'], cells = {} as LedSprites['cells'];
  for (const tone of tones) {
    digits[tone] = {};
    for (const [ch, segs] of Object.entries(SEGMENTS)) {
      const [c, x] = canvasOf(CELL_W + 2 * PAD + 2, LED_H, ratio);
      for (const s of segs) lit(x, tone, () => segPath(x, PAD, DIGIT_Y, s));
      digits[tone][ch] = c;
    }
    const [lc, lx] = canvasOf(2 * (LAMP.r + PAD), 2 * (LAMP.r + PAD), ratio), o = LAMP.r + PAD;
    lit(lx, tone, () => { lx.beginPath(); lx.arc(o, o, LAMP.r, 0, Math.PI * 2); }, false);
    // The lens's highlight.
    lx.fillStyle = 'rgba(255, 255, 255, 0.8)'; lx.beginPath(); lx.arc(o - 0.7, o - 0.7, 0.7, 0, Math.PI * 2); lx.fill();
    lamps[tone] = lc;
    if (tone !== 'idle') {
      const [cc, cx] = canvasOf(CELL.w + 2 * PAD, CELL.h + 2 * PAD, ratio);
      lit(cx, tone, () => { cx.beginPath(); cx.rect(PAD, PAD, CELL.w, CELL.h); });
      cells[tone] = cc;
    }
  }
  return { ratio, base, digits, lamps, cells };
}

/** What the window shows: three characters, their tone, the lamp's tone (null: off) and the bar's level, 0 to 1. */
export interface LedFace { text: string; tone: LedTone; lamp: LedTone | null; level: number }

/** Draw `face` onto `ctx` (a canvas of LED_W x LED_H CSS px at the sprites' ratio). */
export function drawLed(ctx: CanvasRenderingContext2D, sprites: LedSprites, face: LedFace): void {
  const r = sprites.ratio, at = (v: number): number => Math.round(v * r);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(sprites.base, 0, 0);
  const text = face.text.padStart(3, ' ').slice(-3);
  for (let i = 0; i < 3; i++) { const s = sprites.digits[face.tone][text[i]!] ?? sprites.digits[face.tone][' ']!; ctx.drawImage(s, at(DIGIT_X[i]! - PAD), 0); }
  if (face.lamp) ctx.drawImage(sprites.lamps[face.lamp], at(LAMP.x - LAMP.r - PAD), at(LAMP.y - LAMP.r - PAD));
  const lit = Math.round(Math.max(0, Math.min(1, face.level)) * 10);
  for (let i = 0; i < lit; i++) ctx.drawImage(sprites.cells[BAR_TONES[i]!], at(BAR_X + i * BAR_STEP - PAD), at(CELL.y - PAD));
}
