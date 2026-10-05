import { el } from './dom.ts';
import { note, togglePanel } from './ui.ts';

/**
 * What each part of the page is, in two sizes: a one-sentence tooltip (`tip`) and a short explanation (`body`) behind a "?" button,
 * with the section of the guide that goes further. Tooltips, "?" panels and the guide all read from here so they cannot disagree.
 */
export type HelpId = 'profile' | 'depth' | 'oi' | 'candles' | 'footprint' | 'lt' | 'mirror' | 'volume' | 'bubbles' | 'heatmap' | 'depthPane' | 'oiPane' | 'ltPane' | 'barStats' | 'orderBook';

export interface HelpTopic {
  title: string;
  /** One sentence for the hover tooltip. */
  tip: string;
  /** Short paragraphs for the "?" panel. */
  body: string[];
  /** Section id in the guide. */
  guide: string;
}

export const HELP: Readonly<Record<HelpId, HelpTopic>> = {
  profile: {
    title: 'Profile', guide: 'profile',
    tip: 'The column at the right edge of the chart: how much liquidity is resting at each price right now, added up over the enabled venues. Pink are asks (sellers waiting above), green are bids (buyers waiting below).',
    body: ['The profile is the heatmap collapsed into one moment: for every price, the total size of the orders waiting there right now, summed over the enabled venues. Long bars are walls.',
      'Hover it and the Mirror comparison appears (switch that off with the Mirror button).'],
  },
  depth: {
    title: 'Depth', guide: 'lower-panes',
    tip: 'Show or hide the Depth pane under the chart: total bid and ask liquidity within a chosen distance of the price, over time.',
    body: [],
  },
  oi: {
    title: 'Open interest', guide: 'lower-panes',
    tip: 'Show or hide the Open Interest pane: how many contracts are open, and how that number changes with each candle.',
    body: [],
  },
  candles: {
    title: 'Candles', guide: 'chart',
    tip: 'Draw the price candles. Turn them off to see the heatmap and the trade bubbles without anything on top.',
    body: [],
  },
  footprint: {
    title: 'Footprint', guide: 'footprint',
    tip: 'Zoom in on the candles to see the trades behind them: at each price, how much was sold (left number) and bought (right number). Bars mark prices where one side clearly dominated.',
    body: [],
  },
  lt: {
    title: 'Liquidity Tracker', guide: 'lower-panes',
    tip: 'Show or hide the Liquidity Tracker pane: one line for bid liquidity and one for ask liquidity near the price, so you can see which side is thickening.',
    body: [],
  },
  mirror: {
    title: 'Mirror', guide: 'mirror',
    tip: 'Hover comparison. With it on, pointing at the profile column or the order book compares the liquidity between the price and your pointer with the equal stretch on the other side, and says which side has more. Nothing changes until you hover; that is how it works.',
    body: [],
  },
  volume: {
    title: 'Volume', guide: 'chart',
    tip: 'Volume bars along the bottom of the chart. Unusually large ones are drawn stronger (see Highlights).',
    body: [],
  },
  bubbles: {
    title: 'Trades', guide: 'trades',
    tip: 'Large trades as bubbles: green for market buys, red for market sells, bigger for bigger. Hover one for its venue, size and price.',
    body: [],
  },
  heatmap: {
    title: 'The heatmap', guide: 'heatmap',
    tip: 'Each coloured cell is liquidity resting at a price at a moment: warmer and brighter means more.',
    body: ['Colour shows size on a log scale, so a few huge walls do not hide everything else. The Contrast slider moves the colour window: right shows thinner liquidity, left keeps only the biggest walls. Auto keeps the window following the data.',
      'It is recorded while this page is open: there is no way to fetch what the order books looked like in the past, so the map starts at the moment you opened the page and grows to the right (until it has filled the screen, grey shows the current book copied back: the darker the grey, the bigger the wall, but it is not history).'],
  },
  depthPane: {
    title: 'Depth pane', guide: 'lower-panes',
    tip: 'Total liquidity within a chosen distance of the price, over time. Asks point up (pink), bids point down (green).',
    body: ['For every moment it adds up the bids and the asks within a range of the price (1 % to 20 %, set with Range) and draws them as bars: asks up, bids down.',
      'When one side is unusually larger than the other, compared with the recent past, that bar is drawn stronger (see Highlights). It answers: is there more resting liquidity above or below, and is that changing?'],
  },
  oiPane: {
    title: 'Open interest', guide: 'lower-panes',
    tip: 'Open interest is the number of contracts currently open (not volume). The line is its level, the small bars below are its change per candle.',
    body: ['Open interest counts the contracts that exist right now. It rises when new positions are opened and falls when positions are closed. It does not say who is long or who is short.',
      'Binance gives 30 days of history; some venues only publish a reading now and then, so their line builds up while the page is open. When the market on screen has no open interest, a labelled reference market stands in.'],
  },
  ltPane: {
    title: 'Liquidity Tracker', guide: 'lower-panes',
    tip: 'Two lines: how much bid and how much ask liquidity sits near the price, weighted so that what is closest counts most.',
    body: ['LT-Bid and LT-Ask are the USD size on each side of the combined book of the enabled venues. A level counts fully at the touch and half as much for every half-life further away (measured in basis points), so thin, distant orders barely move the line.',
      'Bid above ask means more support close under the price than resistance above it. Switch the view to imbalance to see (bid - ask) / (bid + ask) as one line between -100 % and +100 %. The options set the half-life, the smallest and largest bin that counts, and whether to average per level.'],
  },
  barStats: {
    title: 'Bar stats', guide: 'footprint',
    tip: 'One row of numbers per statistic under each candle: volume, delta (buys minus sells), cumulative delta and more. Click Stats to choose.',
    body: ['Each row is one statistic, one cell per candle, shaded by size. The defaults are volume, delta (buy volume minus sell volume) and cvd (the running sum of delta).',
      'Press Stats to add statistics such as the point of control, stacked imbalances or trades by size. These come from the executions recorded while the page was open, so they start empty and fill with time.'],
  },
  orderBook: {
    title: 'Order book', guide: 'order-book',
    tip: 'The ladder: every price with the liquidity resting there, one column per venue and a bar for the combined size. Scroll over it to zoom the price step.',
    body: ['Each row is a price step. Pink rows above the price are asks, green rows below are bids. The coloured cells are the venues (their size at that price) and the bar on the right is the combined size, with the running total behind it.',
      'Mode chooses between all venues added together, one venue alone, or a compact view. Group is the price step per row: scroll over the book, or drag its price column, to change it. Hover for the Mirror comparison.'],
  },
};

let openGuide: (section?: string) => void = () => {};
/** The guide registers itself here so a "?" panel can open it at a section without importing it (it is loaded on demand). */
export function setGuideOpener(open: (section?: string) => void): void { openGuide = open; }
export const showGuide = (section?: string): void => openGuide(section);

/** A small "?" button that opens the explanation of `id`; the panel closes with Esc, a click elsewhere, or the same button. */
export function helpButton(id: HelpId): HTMLButtonElement {
  const topic = HELP[id];
  const button = el('button', { type: 'button', class: 'help', textContent: '?', tip: `What is this? ${topic.title}`, ariaLabel: `Explain: ${topic.title}` });
  button.onclick = event => {
    event.stopPropagation();
    togglePanel(button, { title: topic.title, width: 340, align: 'left' }, (_tools, body) => {
      body.classList.add('help-body');
      body.append(el('p', { class: 'lead', textContent: topic.tip }));
      for (const paragraph of topic.body) body.append(note(paragraph));
      body.append(el('button', { type: 'button', class: 'more', textContent: 'More in the guide →', onclick: () => { showGuide(topic.guide); } }));
    });
  };
  return button;
}
