import type { Palette } from './theme.ts';

const NAME = 'LiquidityMapperFast';
const FONT = 'ui-sans-serif, system-ui, sans-serif';
let widthAt100 = 0;

/** Size of the name that spans about half the chart, within sensible limits. */
function nameSize(ctx: CanvasRenderingContext2D, width: number): number {
  if (!widthAt100) { ctx.font = `700 100px ${FONT}`; widthAt100 = ctx.measureText(NAME).width || 1; }
  return Math.max(14, Math.min(72, Math.floor(width * 0.5 / (widthAt100 / 100))));
}

/**
 * A barely visible mark on the chart's background: the product name, and under it the market and timeframe. It is too faint to
 * distract (a few percent opacity in the text colour of the theme) but a screenshot still says where it came from.
 */
export function paintWatermark(ctx: CanvasRenderingContext2D, palette: Pick<Palette, 'text' | 'dark'>, width: number, height: number, subtitle: string): void {
  if (width < 240 || height < 140) return;
  const size = nameSize(ctx, width);
  ctx.save();
  ctx.globalAlpha = palette.dark ? 0.04 : 0.045; ctx.fillStyle = palette.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `700 ${size}px ${FONT}`; ctx.fillText(NAME, width / 2, height / 2 - size * 0.3);
  if (subtitle) { ctx.font = `600 ${Math.round(size * 0.4)}px ${FONT}`; ctx.fillText(subtitle, width / 2, height / 2 + size * 0.5); }
  ctx.restore();
}
