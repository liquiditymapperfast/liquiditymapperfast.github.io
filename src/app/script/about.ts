import { t } from '../i18n.ts';
import { examples, type ExampleKey } from './examples.ts';
import type { ScriptRecord } from './records.ts';

/**
 * What each script that comes with the page is, said for a person new to it, behind its "?" (a row of the Scripts pane, a line of the map's
 * legend, the Scripts panel's list and its examples): a sentence on what it shows, then short paragraphs on how to read it, what it is good
 * for, what is particular about it and where it stops. A person's own script has none. Each paragraph is a text of its own in the packs,
 * read in the page's language when it is asked for.
 */
const about = (): Readonly<Record<ExampleKey, { tip: string; body: readonly string[] }>> => ({
  'vwap-with-bands': {
    tip: t('The average price of the last 48 candles, weighted by how much traded in each, with a band on either side.'),
    body: [t('The middle line is where money changed hands on average over that window: price above it trades above the recent average deal, below it under. The bands sit 1.8 deviations away (the usual distance of prices from that average), so a price at a band is stretched by the standard of the last candles.'),
      t('Unlike a session VWAP, which starts again each day, it rolls with the candles on any timeframe, and it weighs each candle by what was bought and sold at market (by orders that trade at once) on every exchange the flow column adds up.'),
      t('It needs the trades the page has recorded, so older candles leave a gap. As an average of the past it lags, and a price beyond a band is not by itself a sign that it will turn. The window and the band width are settings.')],
  },
  'stochastic-heat-map': {
    tip: t('Where the close stands in its recent range, over sixteen lookbacks at once: a row of colour each, from 4 candles at the bottom to 210 at the top.'),
    body: [t('Each row is a stochastic: 0 when the close is at its window\'s lowest low, 100 at its highest high. Blue is near the top, red-orange near the bottom, grey the middle; the line is the average of all sixteen.'),
      t('One look shows whether a move is short or broad: when only the bottom rows turn, the move is recent and the longer windows have not followed; a column of one colour means every window agrees, which a stochastic with a single window cannot show.'),
      t('Its colours follow the page\'s theme and stay apart for colour-blind eyes, and an option colours the map\'s candles by the average. It says where price sits in its ranges, not where it goes next: a market can stay blue for a long time while it climbs.')],
  },
  'depth-bands': {
    tip: t('How far a given dollar size of the order book the page recorded reaches from the close, up and down.'),
    body: [t('The upper line is how far up from the close that many dollars of asks reach, on every exchange the map shows added up as one, the lower how far down that many dollars of bids reach. Each candle\'s book is the one recorded in its last minute, as the candle closed.'),
      t('The size is a number of dollars, or a share of what an average candle traded at market. A wide band is a thin book. Unlike Bollinger bands, which measure how far prices moved, it measures how much stands in the way.'),
      t('Candles from before the page\'s recording have no band. Books change all the time, and an order this large would meet orders that are hidden or that move away: it shows the liquidity typically recorded there, not what such an order would pay.')],
  },
  'bar-patterns': {
    tip: t('Labels what each candle did to the range of the one before it, and marks the patterns that follow from that.'),
    body: [t('“in” marks an inside candle (within the range of the one before), “out” an outside one (past both its ends). Arrows mark patterns: a breakout of an inside candle, a failed break (one the next candle took back), a rejection (a long wick past the candle before, closing back inside: hammers and shooting stars) and an engulfing candle.'),
      t('For a breakout or failed break, the dashed line is the break level it went through and the dotted one the next level, the far side of the range it moves into. Point at a mark for its levels, its candle\'s order flow, liquidations and open interest, and where it stood against the day\'s, week\'s and month\'s opens (and the hour\'s, on charts of an hour or less).'),
      t('These describe what candles did: no test has shown that they say where price goes next. A mark on the candle under way can still change; an alert, off by default, sounds when a breakout or failed break forms.')],
  },
  'buyer-and-seller-vwaps': {
    tip: t('Two averages over the last 48 candles: the price aggressive buyers paid and the price aggressive sellers got, each with a band.'),
    body: [t('Aggressive buyers and sellers are market orders, which trade at once against the orders waiting in the book. The buyers\' line weighs each candle\'s typical price by what was bought that way, the sellers\' line by what was sold. Where the buyers\' line is above the sellers\', buying was done at higher prices than selling over the window; where it is below, selling was.'),
      t('A single VWAP blends both sides into one line. Keeping them apart shows which side has been dealing higher up, how far apart the two are, and when they cross. Each band is one deviation of that side\'s prices, a setting.'),
      t('It needs the trades the page has recorded, so older candles leave a gap. A cross describes the window behind it; it has not been tested as a signal.')],
  },
  liquidations: {
    tip: t('Positions the exchanges closed by force, candle by candle: shorts as violet bars up, longs as amber bars down, brighter when unusual.'),
    body: [t('A liquidation happens when a trader\'s margin runs out and the exchange closes the position with a market order: a short is bought back, a long is sold. Heights are compressed, so one cascade does not flatten every other bar.'),
      t('A bar stays dim while the candle\'s liquidations are ordinary and burns to full colour as they reach two deviations above their average of the last 72 candles, so a cascade stands out before you read the axis. The grey line is the net pressure, shorts less longs, smoothed; it brightens when that is unusual too.'),
      t('Only some exchanges publish their liquidations, and Binance only its largest each second, so the bars show fewer than happened. They say which side was forced out, not what comes next.')],
  },
  'volume-anomalies': {
    tip: t('Each candle\'s volume, coloured by whether more was bought or sold at market, and bright where the volume is unusual.'),
    body: [t('Teal where more was bought by market orders (the ones that trade at once), pink where more was sold. A bar is dim while its volume is ordinary and bright when it is far above its usual level: more than two deviations above its average of the last 72 candles. A grey bar marks a candle whose delta, bought less sold, is unusual in the same way.'),
      t('Unusual is judged against the market\'s own recent candles, so the same rule finds the outliers of a quiet night and of a busy session. It is a quick way to find where activity really stepped up and which side drove it; an option colours those candles on the map too.'),
      t('It needs the trades the page has recorded, so older candles have no bars. A burst of volume says that something happened, not which way price goes next.')],
  },
  'cumulative-delta': {
    tip: t('What was bought at market less what was sold, added up candle after candle across the chart: the cumulative volume delta, or CVD.'),
    body: [t('A rising line means more was bought than sold by market orders (the ones that trade at once); a falling one, the opposite. Read its shape against the price: a price that climbs while the line sinks is rising without buying at market behind it, a divergence that has not been tested as a signal.'),
      t('It is the shortest script here, a single line, and a good one to start writing your own from. The Delta pane draws the same sum as candles, with restarts each day or week and its divergences marked.'),
      t('It starts at zero on the chart\'s first candle, so its shape matters, not its level. Candles from before the page recorded trades add nothing.')],
  },
  'spot-and-perpetual-cvd': {
    tip: t('Two cumulative deltas kept apart: one over the spot markets, in blue, and one over the perpetual futures, in amber.'),
    body: [t('Spot is coins bought and sold outright; perpetuals are futures with no expiry, traded with leverage. Each line adds up what was bought less what was sold at market in its own kind of market, on a scale of its own, since perpetuals usually trade far more: compare shapes and directions, not heights.'),
      t('When the two move together, both kinds of market agree. When the perpetual line climbs while spot falls, the buying is in leveraged futures rather than in coins changing hands, or the other way round: it shows which kind of market carries a move.'),
      t('Only the markets of the exchanges switched on count, from when the page recorded their trades; as with any CVD, its level depends on where the chart starts.'),
      t('A label at each line\'s newest value gives its move over the lookback (20 candles) and calls it rising, falling or flat: flat when the move is under a quarter of the line\'s path, candle by candle.')],
  },
  'delta-histogram': {
    tip: t('Each candle\'s delta, what was bought at market less what was sold, as a bar: up in green where buyers led, down in red where sellers did.'),
    body: [t('Unlike the cumulative delta, each bar stands on its own, so it shows the moments rather than the running total: a tall bar is a candle where one side\'s market orders, the ones that trade at once, clearly outweighed the other\'s.'),
      t('Set it against what the price did in the same candle: a large buying delta with little rise means the buying met plenty of sellers waiting in the book; a large delta with a big move means it went through them.'),
      t('It needs the trades the page has recorded, so older candles have no bars. It is in dollars, so the bars grow with the price and with activity.')],
  },
  'buy-share': {
    tip: t('The share of the volume bought at market over the last 20 candles, in percent, with a line at 50 where both sides are even.'),
    body: [t('Above 50, market orders (the ones that trade at once) bought more than they sold over the window; below 50, they sold more. Because it is a share, it reads the same on a quiet day as on a busy one, and on any coin.'),
      t('It is a steady gauge of which side has been the more aggressive; the number of candles is a setting, and a longer window moves more slowly.'),
      t('It counts dollars, not orders, and leaves out how much traded: 55% over a thin hour counts as much as over a frantic one. It needs the trades the page has recorded.')],
  },
});

/** A script's description: its title (the example's own name, whatever the person renamed it to), its lead sentence and its paragraphs. */
export interface ScriptAbout { title: string; tip: string; body: readonly string[] }

/** The description of an example (the starters are examples too). */
export function aboutExample(key: ExampleKey): ScriptAbout {
  const name = examples().find(e => e.key === key)?.name ?? key;
  return { title: name, ...about()[key] };
}

/**
 * The id a script added from an example gets: the example's key, two dashes and a random tail. `newId` never writes two dashes in a row (its
 * name part has every run of other characters as one dash), so a script of a person's own can never carry one, whatever it is called.
 */
export function exampleId(key: ExampleKey, random: () => number = Math.random): string {
  return `${key}--${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`;
}

/** The examples' keys, and the examples by their text: made at the first look (they never change while the page is open). */
let known: { keys: readonly ExampleKey[]; bySource: ReadonlyMap<string, ExampleKey> } | null = null;

/**
 * Which of the page's own scripts a kept one is, or null for a person's own. By its id: a starter's is its key, and one added from an example
 * starts with it (`exampleId`), so either keeps its description when its text, its options or its name are changed, and in a file it is
 * exported to. One added before ids carried the key, or an example's text pasted as a new script, counts while its text is the example's,
 * word for word.
 */
export function builtinOf(r: Pick<ScriptRecord, 'id' | 'source'>): ExampleKey | null {
  known ??= { keys: examples().map(e => e.key), bySource: new Map(examples().map(e => [e.source, e.key])) };
  for (const key of known.keys) if (r.id === key || r.id.startsWith(`${key}--`)) return key;
  return known.bySource.get(r.source) ?? null;
}

/** The description of a kept script, or null for one of a person's own. */
export function aboutScript(r: Pick<ScriptRecord, 'id' | 'source'>): ScriptAbout | null {
  const key = builtinOf(r);
  return key ? aboutExample(key) : null;
}
