import { el } from './dom.ts';
import { t } from './i18n.ts';
import { note } from './ui.ts';
import { helpButton } from './help.ts';
import { lineSwatch, lowContrast } from './anchors/controls.ts';
import { PALETTES, resolveThemeId, type Palette } from './theme.ts';
import type { ChartType } from './chart-type.ts';
import type { Store } from './store.ts';
import { CANDLE_DIRECTIONS, CANDLE_PARTS, candleInk, hasCandleColors, themeBody, themeEdgeHex, withCandleColor, type CandleColors, type CandleDirection, type CandlePart } from './candle-colours.ts';

/**
 * The Candle colours panel, from the Chart type menu: a rising and a falling candle drawn as the chart draws them, in the colours chosen, and a
 * grid of the body, the border and the wick for each, the theme's until one is chosen. A colour repaints the map (and the two candles here) while
 * it is being picked. Laid out as the Key levels grid is: a row a part, a column a direction.
 */

const PART_NAME: Readonly<Record<CandlePart, () => string>> = { body: () => t('Body'), border: () => t('Border'), wick: () => t('Wick') };
const PART_DESC: Readonly<Record<CandlePart, () => string>> = {
  body: () => t('The candle\'s body. OHLC bars, the price line and its tag are drawn in it too.'),
  border: () => t('The line around the body; on outline candles, the whole outline.'),
  wick: () => t('The line from the body up to the high and down to the low.'),
};
/** Each swatch's name, for a screen reader and its tip. */
const SWATCH_NAME: Readonly<Record<CandleDirection, Readonly<Record<CandlePart, () => string>>>> = {
  up: { body: () => t('Rising candles\' body'), border: () => t('Rising candles\' border'), wick: () => t('Rising candles\' wick') },
  down: { body: () => t('Falling candles\' body'), border: () => t('Falling candles\' border'), wick: () => t('Falling candles\' wick') },
};

/** Filled candles take the theme's edge for their border and wick; outline candles and OHLC bars take the body's colour. The line is drawn as candles here. */
const filledOf = (type: ChartType): boolean => type === 'candles' || type === 'line';

/** The colour a part shows while it has none of its own: what the chart draws it in. */
function shownColor(c: CandleColors, direction: CandleDirection, part: CandlePart, p: Palette, filled: boolean): string {
  const own = c[direction][part];
  if (own) return own;
  const body = c[direction].body ?? themeBody(direction, p);
  return part === 'body' ? body : filled ? themeEdgeHex(p) : body;
}

export function buildCandleColorsPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void): void {
  const state = store.state, p = PALETTES[resolveThemeId(state.theme)] ?? PALETTES.dark!, type = state.chartType, filled = filledOf(type);
  tools.append(helpButton('candles'));
  body.append(note(t('Colours of your own for the candles, in place of the theme\'s. A part left at the theme\'s colour follows the theme.')));
  const preview = candlePreview(p);
  body.append(preview.root);
  preview.paint(state.candleColors, type);
  const set = (direction: CandleDirection, part: CandlePart, color: string | null): void => {
    store.set({ candleColors: withCandleColor(store.state.candleColors, direction, part, color) });
    preview.paint(store.state.candleColors, type);
  };
  const grid = el('div', { class: 'keylevel-grid candle-color-grid', role: 'group', ariaLabel: t('Candle colours') }, el('span'),
    el('span', { class: 'head', textContent: t('Rising') }), el('span', { class: 'head', textContent: t('Falling') }));
  for (const part of CANDLE_PARTS) {
    grid.append(el('span', { class: 'what', tip: PART_DESC[part]() }, el('span', { class: 'name', textContent: PART_NAME[part]() }), el('span', { class: 'desc', textContent: PART_DESC[part]() })));
    for (const direction of CANDLE_DIRECTIONS) {
      const own = state.candleColors[direction][part];
      const swatch = lineSwatch(shownColor(state.candleColors, direction, part, p, filled), own !== undefined, SWATCH_NAME[direction][part](), color => set(direction, part, color), rebuild, `candle-${direction}-${part}`);
      grid.append(el('span', { class: 'cell' }, swatch.swatch, ...(swatch.reset ? [swatch.reset] : [])));
    }
  }
  body.append(grid);
  // What the chart type does with them: the line has no candles, OHLC bars have one colour, outline candles no fill.
  if (type === 'line') body.append(note(t('The chart is drawn as a line now: these colours show on candles and OHLC bars (Chart type, beside the timeframes). The price line\'s tag takes the body colour.')));
  else if (type === 'bars') body.append(note(t('OHLC bars are drawn in the body colour alone.')));
  else if (type === 'outline') body.append(note(t('Outline candles are drawn in the border colour, or in the body colour where the border has none of its own.')));
  else body.append(note(t('While live trades show on the map, candles are drawn as outlines, in the border colour where it has one of its own.')));
  for (const direction of CANDLE_DIRECTIONS) for (const part of CANDLE_PARTS) {
    const own = state.candleColors[direction][part];
    if (own && lowContrast(own, p)) body.append(note(t('{line}: this colour is hard to see on this theme.', { line: SWATCH_NAME[direction][part]() })));
  }
  if (hasCandleColors(state.candleColors)) body.append(el('div', { class: 'session-add' }, el('button', { type: 'button', textContent: t('Reset colours'), tip: t('Every candle colour back to the theme\'s.'),
    onclick: () => { store.set({ candleColors: { up: {}, down: {} } }); rebuild(); } })));
}

/** A rising and a falling candle on the chart's background, drawn as the chart draws them (a line is shown as candles), in the colours given. */
function candlePreview(p: Palette): { root: HTMLElement; paint(c: CandleColors, type: ChartType): void } {
  const NS = 'http://www.w3.org/2000/svg', W = 132, H = 72;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', String(W)); svg.setAttribute('height', String(H)); svg.setAttribute('aria-hidden', 'true');
  const root = el('div', { class: 'candle-preview' });
  root.style.background = p.bg;
  root.append(svg);
  const shape = (name: string, attrs: Record<string, string | number>): SVGElement => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.append(node);
    return node;
  };
  // Two candles: a rising one (open low, close high) and a falling one, each with wicks both ways.
  const CANDLES: readonly { direction: CandleDirection; x: number; open: number; close: number; high: number; low: number }[] = [
    { direction: 'up', x: 40, open: 50, close: 22, high: 10, low: 60 },
    { direction: 'down', x: 92, open: 26, close: 52, high: 14, low: 64 },
  ];
  const paint = (c: CandleColors, type: ChartType): void => {
    svg.replaceChildren();
    for (const k of CANDLES) {
      const top = Math.min(k.open, k.close), bottom = Math.max(k.open, k.close), w = 18;
      if (type === 'bars') {
        const ink = candleInk(c, k.direction, p, false);
        shape('path', { d: `M${k.x} ${k.high}V${k.low}M${k.x - 8} ${k.open}H${k.x}M${k.x} ${k.close}H${k.x + 8}`, stroke: ink.body, 'stroke-width': 2, fill: 'none' });
        continue;
      }
      const filled = filledOf(type), ink = candleInk(c, k.direction, p, filled);
      shape('rect', { x: k.x - 1, y: k.high, width: 2, height: top - k.high, fill: ink.wick });
      shape('rect', { x: k.x - 1, y: bottom, width: 2, height: k.low - bottom, fill: ink.wick });
      if (filled) shape('rect', { x: k.x - w / 2 + 0.75, y: top + 0.75, width: w - 1.5, height: bottom - top - 1.5, fill: ink.body, stroke: ink.border, 'stroke-width': 1.5 });
      else shape('rect', { x: k.x - w / 2 + 0.75, y: top + 0.75, width: w - 1.5, height: bottom - top - 1.5, fill: 'none', stroke: ink.border, 'stroke-width': 1.5 });
    }
  };
  return { root, paint };
}
