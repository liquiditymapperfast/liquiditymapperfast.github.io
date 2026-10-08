import { el } from './dom.ts';
import { lazy } from './lazy.ts';
import { note, openedPanel, togglePanel } from './ui.ts';
import { t } from './i18n.ts';

/**
 * What each part of the page is, in two sizes: a one-sentence tooltip (`tip`) and a short explanation (`body`) behind a "?" button,
 * with the section of the guide that goes further. Tooltips, "?" panels and the guide all read from here so they cannot disagree.
 *
 * Where a "?" goes: every feature that shows something on the chart has one, and one only. A pane has it in its header; a feature a toolbar
 * button opens (Trades, Absorption, Highlights, Sounds) has it in its panel's tool strip; a settings window opened from a pane's header
 * shares that pane's. Windows that only do a job (About, Install, the venue menu, the venue and coin pickers) explain themselves and have none.
 */
export type HelpId = 'profile' | 'traded' | 'absorption' | 'depth' | 'oi' | 'candles' | 'footprint' | 'lt' | 'mirror' | 'volume' | 'bubbles' | 'heatmap' | 'depthPane' | 'oiPane' | 'ltPane' | 'barStats' | 'orderBook' | 'cvd' | 'book' | 'highlights' | 'sounds';

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
    title: t('Profile'), guide: 'profile',
    tip: t('The column at the right edge of the chart: how much liquidity is resting at each price right now, added up over the enabled venues. Pink are asks (sellers waiting above), green are bids (buyers waiting below).'),
    body: [t('The profile is the heatmap collapsed into one moment: for every price, the total size of the orders waiting there right now, summed over the enabled venues. Long bars are walls.'),
      t('Hover it and the Mirror comparison appears (switch that off with the Mirror button).')],
  },
  traded: {
    title: t('Traded volume'), guide: 'profile',
    tip: t('A column beside the profile: how much was bought and sold at market at each price over the time on the map, on the exchanges the flow column counts. Next to the resting liquidity, it shows which levels have actually changed hands.'),
    body: [],
  },
  absorption: {
    title: t('Absorption'), guide: 'trades',
    tip: t('Absorption marks: where market orders of one side met resting orders at one price for more than a threshold within 10 ms. A square below a level means passive buyers took the selling; above, passive sellers took the buying.'),
    body: [t('A dot sits on the level where it happened, and a square beside it shows the resting side: below the level when buyers waiting there took market sells, above it when sellers waiting there took market buys. Hover a square for the exchange, the fills, the largest 10 ms sum and the threshold.'),
      t('The automatic threshold is worked out for each exchange from its own trading: the mean of its 10 ms sums at one price plus a number of standard deviations, over a recent span. A busy exchange therefore needs more to be marked than a quiet one.'),
      t('A square\'s area is in proportion to the volume taken there, the largest mark in view the biggest.')],
  },
  depth: {
    title: t('Depth'), guide: 'lower-panes',
    tip: t('Show or hide the Depth pane under the chart: total bid and ask liquidity within a chosen distance of the price, over time.'),
    body: [],
  },
  oi: {
    title: t('Open interest'), guide: 'lower-panes',
    tip: t('Show or hide the Open Interest pane: how many contracts are open, and how that number changes with each candle.'),
    body: [],
  },
  candles: {
    title: t('Candles'), guide: 'chart',
    tip: t('Draw the price candles. Turn them off to see the heatmap and the trade bubbles without anything on top.'),
    body: [],
  },
  footprint: {
    title: t('Footprint'), guide: 'footprint',
    tip: t('Zoom in on the candles to see the trades behind them: at each price, how much was sold (left number) and bought (right number). Bars mark prices where one side clearly dominated.'),
    body: [],
  },
  lt: {
    title: t('Liquidity Tracker'), guide: 'lower-panes',
    tip: t('Show or hide the Liquidity Tracker pane: one line for bid liquidity and one for ask liquidity near the price, so you can see which side is thickening.'),
    body: [],
  },
  mirror: {
    title: t('Mirror'), guide: 'mirror',
    tip: t('Hover comparison. With it on, pointing at the profile column or the order book compares the liquidity between the price and your pointer with the equal stretch on the other side, and says which side has more. Nothing changes until you hover; that is how it works.'),
    body: [],
  },
  volume: {
    title: t('Volume'), guide: 'chart',
    tip: t('Volume bars along the bottom of the chart. Unusually large ones are drawn stronger (see Highlights).'),
    body: [],
  },
  bubbles: {
    title: t('Trades'), guide: 'trades',
    tip: t('Large market orders as bubbles (the fills of one order added together): green for buys, red for sells, the area in proportion to the size, the largest in view the biggest. Hover one for its venue, size and price.'),
    body: [],
  },
  highlights: {
    title: t('Highlights'), guide: 'highlights',
    tip: t('What stands out: unusual volume, open-interest changes and depth imbalance'),
    body: [],
  },
  sounds: {
    title: t('Sounds'), guide: 'trades',
    tip: t('Sounds for large market orders by size tier, a chime on unusual volume, and one rare event per pane if you choose it. Browsers play sound only after a click on the page.'),
    body: [],
  },
  heatmap: {
    title: t('The heatmap'), guide: 'heatmap',
    tip: t('Each coloured cell is liquidity resting at a price at a moment: warmer and brighter means more.'),
    body: [t('Colour shows size on a log scale, so a few huge walls do not hide everything else. The Contrast slider moves the colour window: right shows thinner liquidity, left keeps only the biggest walls. Auto keeps the window following the data.'),
      t('It is recorded while this page is open: there is no way to fetch what the order books looked like in the past, so the map starts at the moment you opened the page and grows to the right (until it has filled the screen, grey shows the current book copied back: the darker the grey, the bigger the wall, but it is not history).')],
  },
  depthPane: {
    title: t('Depth pane'), guide: 'lower-panes',
    tip: t('Total liquidity within a chosen distance of the price, over time. Asks point up (pink), bids point down (green).'),
    body: [t('For every moment it adds up the bids and the asks within a range of the price (1 % to 20 %, set with Range) and draws them as bars: asks up, bids down.'),
      t('When one side is unusually larger than the other, compared with the recent past, that bar is drawn stronger (see Highlights). It answers: is there more resting liquidity above or below, and is that changing?')],
  },
  oiPane: {
    title: t('Open interest'), guide: 'lower-panes',
    tip: t('Open interest is the number of contracts currently open (not volume). The line is its level, the small bars below are its change per candle.'),
    body: [t('Open interest counts the contracts that exist right now. It rises when new positions are opened and falls when positions are closed. It does not say who is long or who is short.'),
      t('Binance gives 30 days of history; some venues only publish a reading now and then, so their line builds up while the page is open. When the market on screen has no open interest, a labelled reference market stands in.')],
  },
  ltPane: {
    title: t('Liquidity Tracker'), guide: 'lower-panes',
    tip: t('Two lines: how much bid and how much ask liquidity sits near the price, weighted so that what is closest counts most.'),
    body: [t('LT-Bid and LT-Ask are the USD size on each side of the combined book of the enabled venues. A level counts fully at the touch and half as much for every half-life further away (measured in basis points), so thin, distant orders barely move the line.'),
      t('Bid above ask means more support close under the price than resistance above it. Switch the view to imbalance to see (bid - ask) / (bid + ask) as one line between -100 % and +100 %. The options set the half-life, the smallest and largest bin that counts, and whether to average per level.')],
  },
  barStats: {
    title: t('Bar stats'), guide: 'footprint',
    tip: t('One row of numbers per statistic under each candle: volume, delta (buys minus sells), cumulative delta and more. Click Stats to choose.'),
    body: [t('Each row is one statistic, one cell per candle, shaded by size. The defaults are volume, delta (buy volume minus sell volume) and cvd (the running sum of delta).'),
      t('Press Stats to add statistics such as the point of control, stacked imbalances or market orders by size. These come from the executions recorded while the page was open, so they start empty and fill with time.')],
  },
  cvd: {
    title: t('Flow'), guide: 'flow',
    tip: t('The taker-flow column left of the map: for every exchange, how much was bought and sold at market over time (cumulative volume delta), spot in blue and perpetual in amber, biggest exchanges first. The top row adds them all.'),
    body: [t('Passive liquidity (the heatmap and the book) is what traders have placed and may pull; flow is what they have actually done. A line rising means buyers are lifting offers faster than sellers are hitting bids.'),
      t('Rows are ranked by volume over the window you choose and re-ranked now and then. Every line has its own scale, so compare shapes, not heights. The labels are on the left so that the ends of the lines stay clear. Hover a row for its numbers; the gear sets how many exchanges, how tall each row is and when the order changes.')],
  },
  book: {
    title: t('Order book'), guide: 'order-book',
    tip: t('Show or hide the order book column at the right of the map.'),
    body: [],
  },
  orderBook: {
    title: t('Order book'), guide: 'order-book',
    tip: t('The ladder: every price with the liquidity resting there, one column per venue and a bar for the combined size. Scroll over it to zoom the price step.'),
    body: [t('Each row is a price step. Pink rows above the price are asks, green rows below are bids. The coloured cells are the venues (their size at that price) and the bar on the right is the combined size, with the running total behind it.'),
      t('Mode chooses between all venues added together, one venue alone, or a compact view. Group is the price step per row: scroll over the book, or drag its price column, to change it. Hover for the Mirror comparison.')],
  },
};

/** Open the guide at a section. It is loaded on demand, so the page does not carry it until it is wanted. */
export const showGuide = (section?: string): void => { void lazy(() => import('./guide/guide.ts')).then(m => m?.openGuide(section)); };

/** A small "?" button that opens the explanation of `id`; the panel closes with Esc, a click elsewhere, or the same button. */
export function helpButton(id: HelpId): HTMLButtonElement {
  const topic = HELP[id];
  const button = el('button', { type: 'button', class: 'help', textContent: '?', tip: t('What is this? {topic}', { topic: topic.title }), ariaLabel: t('Explain: {topic}', { topic: topic.title }) });
  const fill = (body: HTMLElement): void => {
    body.classList.add('help-body');
    body.append(el('p', { class: 'lead', textContent: topic.tip }));
    for (const paragraph of topic.body) body.append(note(paragraph));
    body.append(el('button', { type: 'button', class: 'more', textContent: t('More in the guide →'), onclick: () => { showGuide(topic.guide); } }));
  };
  button.onclick = event => {
    event.stopPropagation();
    // Inside a panel the explanation opens in that panel, right under its tool strip: as a panel of its own it would close this one (one
    // panel at a time), and with it the button it was to be placed by, so it landed in the corner of the page.
    const panel = button.closest('.panel');
    if (panel) {
      const shown = panel.querySelector(`.help-inline[data-topic="${id}"]`);
      if (shown) shown.remove();
      else { const box = el('div', { class: 'help-inline' }); box.dataset.topic = id; fill(box); panel.querySelector('.panel-body')?.before(box); }
      button.classList.toggle('open', !shown);
      openedPanel()?.reposition();
      return;
    }
    togglePanel(button, { title: topic.title, width: 340, align: 'left' }, (_tools, body) => fill(body));
  };
  return button;
}
