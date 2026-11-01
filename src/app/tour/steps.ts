import { t } from '../i18n.ts';
import type { Prefer } from './place.ts';

/**
 * The tour's steps, as data. A quick pass over the page, not a manual (that is the Guide, which can be as long as it needs): a step is one
 * thing pointed at and a sentence or two about it, and the tour is about a minute whatever the screen. It keeps to what a newcomer meets first
 * and what is only here (the map, moving about it, the panels, making the page one's own); everything deeper is the Guide's.
 */
export type Arrangement = 'desktop' | 'compact' | 'phone';
/** What a step points at: names that `targets.ts` turns into the elements of the page that is on the screen. */
export type TargetId = 'map' | 'market' | 'time' | 'panels' | 'chart' | 'liqLevels' | 'flow' | 'book' | 'layouts' | 'tour' | 'guide' | 'coin' | 'settings' | 'tabs' | 'mapTab';

export interface Step {
  id: string;
  /** What is lit: the union of these. None: the step is a card in the middle of the window. A step whose targets are not on the screen is left out. */
  targets: readonly TargetId[];
  /** The side of the target the card prefers. */
  side: Prefer;
  title: () => string;
  /** What it says; `tab` when what is lit is the edge tab of a pane that is closed, which then says how to open it. */
  body: (tab: boolean) => string;
  /** The last step offers the Guide beside Done. */
  guide?: boolean;
}

/** The most a step may say (characters): a tour that is read, not skimmed past, is one that fits on a card. A test holds every step to it. */
export const MAX_TITLE = 30, MAX_BODY = 200;

/** The steps for an arrangement of the page; `coarse` is a finger rather than a mouse (the words for moving about differ). */
export function stepsFor(arrangement: Arrangement, coarse: boolean): Step[] {
  const map: Step = {
    id: 'map', targets: ['map'], side: 'inside', title: () => t('The map'),
    body: () => t('Behind the candles, colour shows the order book through time. A bright band is a pile of resting orders, where traders wait to buy or sell; the brighter, the bigger. A new page fills in as you watch.'),
  };
  const look: Step = {
    id: 'look', targets: ['map'], side: 'inside', title: () => t('Look around'),
    body: () => coarse
      ? t('Pinch to zoom: sideways for time, up and down for price. Drag to look back in time. Tap anything to read it, and use Recenter to come back to now.')
      : t('The wheel zooms time and price together; drag to look back in time. Point at anything to read it, and press R to come back to now.'),
  };
  const flow: Step = {
    id: 'flow', targets: ['flow'], side: 'auto', title: () => t('Flow'),
    body: tab => tab ? t('Who is buying and selling at market, exchange by exchange. It is closed now: its tab at the edge opens it.') : t('Who is buying and selling at market, exchange by exchange, and when. The same moment is marked on the map.'),
  };
  const book: Step = {
    id: 'book', targets: ['book'], side: 'auto', title: () => t('Order book'),
    body: tab => tab ? t('The live order book as a ladder of prices. It is closed now: its tab at the edge opens it.') : t('The live order book as a ladder of prices: what waits above and below the price right now.'),
  };
  const coin: Step = {
    id: 'coin', targets: ['coin'], side: 'below', title: () => t('Coin'),
    body: () => t('Tap the coin to switch to another one. Every view follows it.'),
  };
  if (arrangement === 'phone') {
    return [
      {
        id: 'tabs', targets: ['tabs'], side: 'above', title: () => t('Views'),
        body: () => t('Each tab in this bar is another view of the same market: Tape, Flow, Map, Book and more. Swipe the bar for the rest.'),
      },
      {
        id: 'map-tab', targets: ['mapTab'], side: 'above', title: () => t('The map'),
        body: () => t('Open Map to see the order book through time. Each bright band is a pile of resting orders. It fills in as you watch; pinch to zoom, drag to look back.'),
      },
      coin,
      {
        id: 'settings', targets: ['settings'], side: 'below', guide: true, title: () => t('Settings'),
        body: () => t('Exchanges, panels, layers and colours are here, and so are the Guide and this tour.'),
      },
    ];
  }
  if (arrangement === 'compact') {
    return [
      map, look, coin, flow, book,
      {
        id: 'settings', targets: ['settings'], side: 'below', guide: true, title: () => t('Settings'),
        body: () => t('Exchanges, panels, layers, colours and Layouts are here, and so are the Guide and this tour.'),
      },
    ];
  }
  return [
    map, look,
    {
      id: 'market', targets: ['market', 'time'], side: 'below', title: () => t('Coin, venues, timeframe'),
      body: () => t('Pick the coin, choose which exchanges feed the map under Venues, and set how long each candle is.'),
    },
    {
      id: 'panels', targets: ['panels'], side: 'below', title: () => t('Panels'),
      body: () => t('Each button shows or hides a panel: Flow, Book, Depth, Open interest, Delta and more. Switch on what you want to watch.'),
    },
    {
      id: 'chart', targets: ['chart'], side: 'below', title: () => t('Layers on the map'),
      body: () => t('Add the footprint, trades, liquidations, key levels or VWAP to the map. The small button beside each one opens its settings.'),
    },
    // Only where the levels have an address: without one there is no button, and a step whose target is not on the screen is left out.
    {
      id: 'liq-levels', targets: ['liqLevels'], side: 'below', title: () => t('Liquidation levels'),
      body: () => t('Where Hyperliquid\'s BTC positions would be liquidated, right of the newest candle. A level goes once price trades through it; their own column adds them up from the price outward.'),
    },
    flow, book,
    {
      id: 'layouts', targets: ['layouts'], side: 'below', title: () => t('Make it yours'),
      body: () => t('Drag a panel by its grip, close one with ×, or pick a ready-made layout here. Save your own to come back to.'),
    },
    {
      id: 'finish', targets: ['tour', 'guide'], side: 'below', guide: true, title: () => t('That is the quick version'),
      body: () => t('The Guide tells the whole story, with moving pictures. Press ? for the keys. The Tour button plays this again.'),
    },
  ];
}
