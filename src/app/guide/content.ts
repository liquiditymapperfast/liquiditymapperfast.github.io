/**
 * The guide's text, as data. Inline markup in any string: `**bold**`, `code` between backticks, and `[[Key]]` for a keyboard key.
 * Figures are named animations drawn by `figures.ts`. The aim is a page that can be read in ten to fifteen minutes and leaves the reader
 * with a working picture of what each part is for; anything deeper lives in the "?" panels, which share their text with the tooltips.
 */
export type FigureId = 'anatomy' | 'colours' | 'recording' | 'zoom-price' | 'zoom-time' | 'pan' | 'mirror' | 'footprint';

export type Block =
  | { t: 'p'; text: string }
  | { t: 'list'; items: string[] }
  | { t: 'note'; kind?: 'tip' | 'warn'; text: string }
  | { t: 'fig'; id: FigureId; caption: string }
  | { t: 'keys'; rows: [keys: string, does: string][] };

export interface Section { id: string; title: string; blocks: Block[] }

export const SECTIONS: readonly Section[] = [
  {
    id: 'start', title: 'Start here',
    blocks: [
      { t: 'p', text: 'LiquidityMapperFast shows you where the orders are. An exchange keeps a list of everyone waiting to buy below the price and everyone waiting to sell above it: the **order book**. This page reads that list from the largest exchanges, adds them together and draws it as a map that moves with the price. Where a lot of size is waiting, the map lights up. Those are the **walls** that price tends to react to.' },
      { t: 'p', text: 'It is free: nothing to sign up for, open source, and no server of its own. Your browser connects to the exchanges directly, and nothing you do here is sent anywhere.' },
      { t: 'fig', id: 'anatomy', caption: 'The page at a glance. Point at a part (hover with a mouse, tap on a touch screen) to see what it is.' },
      { t: 'list', items: [
        '**The chart**: price runs up the side, time runs left to right. The candles show what price did; the coloured map behind them is the order book through time.',
        '**The profile**, the bars at the right edge of the chart, is the order book right now.',
        '**The order book** on the far right is the same book as a ladder of prices.',
        '**The panes underneath** (Depth, Open Interest, Liquidity Tracker, Bar stats) share the chart\'s time axis.',
        '**The toolbar** at the top chooses what to show and how.',
      ] },
      { t: 'note', kind: 'tip', text: 'Short on time? Read “Reading the map”, “Why the map fills in as you watch” and “Moving around”.' },
    ],
  },
  {
    id: 'heatmap', title: 'Reading the map',
    blocks: [
      { t: 'p', text: 'Every cell of the map is one price at one moment. Its colour is how much size was waiting there, added up over the exchanges you have switched on: the warmer and brighter, the bigger the order or the stack of orders. Dark and empty means little is there.' },
      { t: 'p', text: 'The scale is **logarithmic**: each step along the colour bar is a multiple, not an addition. One gigantic order cannot turn everything else into dust, but a colour says “bigger”, not “twice as big”. The legend in the toolbar shows the dollar range the colours cover.' },
      { t: 'list', items: [
        '**Horizontal streaks are walls**: orders that stay for minutes or hours. Price often stalls, bounces or speeds up when it reaches one.',
        '**Above the price are asks** (sellers waiting), **below are bids** (buyers waiting). The default *Size* style implies the side from the position; *Sides* colours asks pink and bids green.',
        '**A wall that appears or vanishes** means somebody changed their mind. The map records those changes, which one snapshot of the book cannot.',
      ] },
      { t: 'fig', id: 'colours', caption: 'The Contrast slider slides the colour window along the size axis. Right shows thinner liquidity; left keeps only the biggest walls, and the far left pales even those.' },
      { t: 'p', text: '**Auto** keeps that window following the data (it is recomputed when you recentre, change market, zoom, and every ten seconds), so colours do not drift while you pan. **Smooth** blurs the map vertically when price rows get thin, so distant walls stay visible when you zoom out.' },
      { t: 'note', kind: 'warn', text: 'A wall is an intention, not a fact. Orders can be cancelled at any moment, and some are placed to be seen. The map shows what is resting, never what will trade.' },
    ],
  },
  {
    id: 'recording', title: 'Why the map fills in as you watch',
    blocks: [
      { t: 'p', text: 'This is the most important thing to know about the heatmap. **An exchange only tells you what its order book looks like right now.** None publishes what it looked like an hour ago, so there is no history to download. The map is built by watching the book and writing it down, locally, in your browser, from the moment you open the page.' },
      { t: 'p', text: 'So on a first visit the coloured part is a thin stripe at the right edge that grows with the minutes. To make the map readable from the first second, the part before the stripe is filled in **grey**: today\'s book copied back in time, on the same scale (a darker grey is a bigger wall). Grey is never history. It only shows where the walls are now. Real colour starts at the dashed line, and the grey shrinks as recorded data takes its place.' },
      { t: 'fig', id: 'recording', caption: 'A first visit, sped up. Grey is the current book copied back; colour is what was recorded while the page was open.' },
      { t: 'list', items: [
        'The page keeps the last **24 hours** of what it recorded in your browser, so coming back continues the map. It records only while a page is open, so time with the page closed leaves a gap.',
        'Only **one tab records** at a time; another tab shows the live data and the recording so far.',
        '**Candles and open interest are different**: they come from each exchange\'s own history, so they are there at once (Binance has 30 days of open interest; Hyperliquid\'s builds up while the page is open).',
        'The **footprint, trade bubbles and bar stats** are recorded like the map, so they also start empty.',
      ] },
      { t: 'note', kind: 'tip', text: 'A page left open in a background tab keeps recording, though browsers slow hidden tabs and a long-hidden one may record with small gaps.' },
    ],
  },
  {
    id: 'moving', title: 'Moving around',
    blocks: [
      { t: 'p', text: 'On a computer everything is done with the mouse, and nothing needs a click first. While the chart follows the market, zooming holds the live edge (time) or the current price (price) still, so the picture swells and shrinks around it instead of sliding.' },
      { t: 'keys', rows: [
        ['[[Wheel]] on the chart', 'Zoom the **time** axis'],
        ['[[Wheel]] or drag on the price scale', 'Zoom the **price** axis (drag up zooms in, down zooms out)'],
        ['[[Shift]] + [[Wheel]]', 'Zoom the other axis. [[Alt]] + [[Wheel]] zooms around the pointer'],
        ['Drag', 'Pan both ways. With [[Shift]], pan time only'],
        ['Right-drag', 'Right or up zooms the time or price axis in; left or down zooms out'],
        ['Double-click, [[R]], [[Home]], **Recenter**', 'Back to the live edge, price range fitted'],
      ] },
      { t: 'p', text: 'On a **phone or tablet** the map sits on top and the bar at the bottom picks the pane under it (beside it when the phone is on its side): the order book, depth, open interest, the tracker or the statistics. Drag the handle between them to resize it; **Map** gives the chart the whole screen, and everything else is behind the **⋯** button. The same moves are made with fingers:' },
      { t: 'keys', rows: [
        ['**Drag**', 'Pan both ways. It carries on a little after you lift'],
        ['**Pinch**', 'Sideways zooms **time**, up and down zooms **price**, a diagonal pinch does both; what is under each finger stays under it'],
        ['**Tap**', 'Pins the crosshair and its readout above your finger. Tap again, or drag, to let go'],
        ['**Hold, then drag**', 'Slides the crosshair along without moving the map'],
        ['**Double-tap**', 'Back to the live edge, price range fitted'],
        ['**Drag an axis**', 'Along the price or time scale to zoom it'],
        ['**Hold a button**', 'Shows what it does, without pressing it'],
      ] },
      { t: 'fig', id: 'zoom-price', caption: 'Wheel on the price scale: the current price stays put while the scale around it changes.' },
      { t: 'fig', id: 'zoom-time', caption: 'Wheel on the chart: the live edge stays put while time zooms. Candles get wider and the footprint appears.' },
      { t: 'fig', id: 'pan', caption: 'Drag to look around. Panning stops the chart following the live edge; Recenter starts it again.' },
      { t: 'p', text: 'The panes share the time axis, so what you do to it happens to all of them. Drag the splitters between panes, and the grip (⠿) in a pane\'s header to reorder it. Sizes are remembered.' },
    ],
  },
  {
    id: 'profile', title: 'The profile',
    blocks: [
      { t: 'p', text: 'The bars at the right edge of the chart are the heatmap collapsed into one moment: for every price, the total size waiting there right now. Long bars are walls; pink above the price are asks, green below are bids. It is the quickest way to see the shape of the book, and what **Mirror** works on.' },
    ],
  },
  {
    id: 'order-book', title: 'The order book',
    blocks: [
      { t: 'p', text: 'The ladder on the right is the same book as rows. Each row is a price step; the coloured cells are the exchanges, one column each (BIN, BYB, OKX and so on); the bar at the right is the combined size, with the running total behind it.' },
      { t: 'list', items: [
        '**Mode**: *Aggregated* adds the exchanges together, *Single* gives each its own book, *Compact* squeezes them.',
        '**Group** is the price step per row. Scroll over the book, pinch it, or drag its price column, to zoom it; drag the book to move it; double-click or double-tap to reset.',
        '**Show** picks levels, the cumulative total, or both.',
      ] },
    ],
  },
  {
    id: 'flow', title: 'The flow column',
    blocks: [
      { t: 'p', text: 'The column left of the map is the active half of the picture: the heatmap and the book show what traders **placed**; this shows what they **did**, exchange by exchange.' },
      { t: 'p', text: 'Each row\'s two lines are cumulative volume delta (market buys minus market sells): **blue is spot, amber is perpetual**. A rising line means buyers are lifting offers faster than sellers hit bids. The top row adds all exchanges; the price is under it.' },
      { t: 'list', items: [
        'Labels sit on the **left**, clear of the line ends: rank, exchange, net flow, share of volume, `!5m` when quiet.',
        'Each line has its own scale: compare shapes, not heights. **Map, 5m ... 24h** sets the span; the gear sets the rows shown, their heights and the re-ranking.',
        'Hover a row for its numbers.',
      ] },
      { t: 'note', text: '**Flow** and **Book** in the toolbar hide or show the side columns. On the local server only exchanges with a trade feed there count; `?source=browser` counts all.' },
    ],
  },
  {
    id: 'mirror', title: 'Mirror: which side has more?',
    blocks: [
      { t: 'p', text: 'Mirror answers one question: *is there more on this side of the price, or the other?* Point at a price in the profile or the order book. The band between the price and your pointer is outlined, and so is the equal band on the other side. A box adds up both and says which is bigger. Move outward and watch the balance change with distance.' },
      { t: 'fig', id: 'mirror', caption: 'The pointer moves away from the price. The box compares the two bands as they grow.' },
      { t: 'note', kind: 'warn', text: 'Mirror only shows while you hover, so the **Mirror** button in the toolbar changes nothing you can see until you point at the profile or the order book. If hovering stops showing the box, check that button: its state is saved between visits. On a touch screen, tap the profile or the order book to pin the box there, and tap again to let go.' },
    ],
  },
  {
    id: 'chart', title: 'Candles and volume',
    blocks: [
      { t: 'p', text: 'Each candle is one period of price: the thin line is the full range, the body runs from open to close, green when price rose and red when it fell. The buttons at the top (1m to 1d) set the length of a candle, and the footprint, bar stats and open-interest bars follow it. **Volume** bars sit along the bottom, and unusually large ones are drawn stronger.' },
    ],
  },
  {
    id: 'trades', title: 'Trades and sound',
    blocks: [
      { t: 'p', text: 'Large trades appear as **bubbles** at the price and time they happened: green for market buys, red for market sells, bigger for bigger (from $25,000). Hover or tap one for its exchange, size and price. The map shows what is waiting; the bubbles show what was actually done.' },
      { t: 'p', text: '**Sound** turns trades into chimes: rising for buys, falling for sells, richer for bigger sweeps. Four tiers set the sizes (Signal $50k, Surge $150k, Whale $400k, Leviathan $1.5M); the two largest are on by default. Browsers keep audio locked until you click or press a key on the page once.' },
      { t: 'p', text: 'Under **Per panel** in the Sounds panel, each pane can sound one rare event (a flow burst, a big-delta candle, a wall, the book tipping, an unusual open-interest change). All off until chosen.' },
    ],
  },
  {
    id: 'footprint', title: 'The footprint',
    blocks: [
      { t: 'p', text: 'Zoom into the time axis until each candle is wide and the **footprint** appears. At every price inside the candle it shows how much traded **at the bid** (sellers hitting it, the left number) and **at the ask** (buyers lifting it, the right number). A bar marks a row where one side was at least 15% bigger. The heatmap fades as the footprint takes over: both answer the same question at different scales.' },
      { t: 'p', text: '**Delta** is buys minus sells. A candle that rose on mostly sellers\' volume is more fragile than one that rose on buyers\'. The strip under the chart (**Bar stats**) shows one number per candle, by default volume, delta and cumulative delta (cvd). **Stats** adds more.' },
      { t: 'p', text: '**Rejected aggressive buying or selling.** When a candle\'s wick holds more net aggressive buying than any equally tall slice of the rest of the candle, and the candle then closed at least one average range below where those buyers paid, the wick\'s busiest cells glow amber and slowly pulse. Hover them for the numbers. A lower wick works the same way for sellers.' },
      { t: 'fig', id: 'footprint', caption: 'Zooming in reveals the rows, then the imbalances, then a candle with rejected buying.' },
      { t: 'note', kind: 'warn', text: 'This describes a closed candle and says nothing about who holds what. It needs a footprint that holds the candle\'s whole volume (about an hour of recording at 5 minutes, longer at slower timeframes), and nobody has shown that it predicts anything. Treat it as a place to look, never as a signal.' },
    ],
  },
  {
    id: 'lower-panes', title: 'The panes underneath',
    blocks: [
      { t: 'list', items: [
        '**Depth** adds up bids and asks within a distance of the price (1% to 20%, set with Range) and draws asks up in pink and bids down in green. When one side is unusually larger, that bar is drawn stronger.',
        '**Open Interest** is the number of contracts currently open, which is not volume. It rises when positions are opened and falls when they are closed, and it cannot tell you who is long or short. The small bars are its change per candle.',
        '**Liquidity Tracker** (LT) draws bid and ask liquidity near the price as two lines, weighted so that what is closest counts most: a level counts fully at the touch and half as much for every half-life further away. Bid above ask means more support just under the price than resistance above it.',
        '**Bar stats** is the strip of numbers per candle described above.',
      ] },
      { t: 'p', text: 'Each has a **?** in its header, and the toolbar buttons (Depth, OI, LT, Footprint) show or hide them.' },
    ],
  },
  {
    id: 'venues', title: 'Exchanges, spot and perpetuals',
    blocks: [
      { t: 'p', text: 'The map combines up to eight exchanges: the perpetual futures of Binance, Bybit, OKX, Bitget, Hyperliquid and Deribit, and the spot markets of Coinbase and Binance. Their public books are both large and deep. **Venues** switches any of them on or off, and the choice is kept in your browser.' },
      { t: 'list', items: [
        '**Spot / Perp / Both** filters what the liquidity views draw. It never switches an exchange on or off.',
        'The **chips** show or hide one exchange\'s contribution without stopping its feed. A chip that is dimmed is one the Spot / Perp filter is hiding: click it to show it. An exchange you chose that has no map gets a dashed chip that says why on hover.',
        'The **Heatmap** selector shows a single exchange\'s own map instead of the combined one.',
        'The **market** selector chooses whose candles, footprint and open interest the chart uses.',
      ] },
      { t: 'p', text: 'Some exchanges refuse some countries. If one never connects while the others work, its chip becomes a dashed tag and a banner says it is **unavailable from your location**. A VPN set to another country may enable it; the rest keep working either way.' },
    ],
  },
  {
    id: 'highlights', title: 'What stands out',
    blocks: [
      { t: 'p', text: 'One rule decides what is unusual, everywhere on the page: a value stands out when it is more than a chosen number of standard deviations above the average of the bars before it. The defaults are 2σ over the previous 72 bars, and nothing is flagged until a dozen bars exist. It applies to volume, open-interest changes and depth imbalance: what stands out is drawn at full strength and the rest recedes. **Highlights** in the toolbar sets it, or turns it off.' },
    ],
  },
  {
    id: 'tools', title: 'Screenshot, themes and install',
    blocks: [
      { t: 'p', text: '**Screenshot** (or [[S]]) freezes the page under a dim layer that says “Select an area”. Drag a region, or click or tap a pane to take all of it (the top bar takes the whole page). Draw on it with the pen, line, arrow, rectangle, highlighter or text, and hide anything private with **pixelate** or **blur**. **Copy** puts the picture on the clipboard; the arrow beside it saves a PNG, and on a phone the share arrow opens the phone\'s own share sheet.' },
      { t: 'p', text: 'The **theme** menu has eight themes: hover one to preview it everywhere, click or tap to keep it. **Install** appears when your browser can install this page as an app with its own window and icon; other browsers offer it in their menu. An iPhone or iPad has no prompt: choose Share, then Add to Home Screen (the button says so).' },
      { t: 'keys', rows: [
        ['[[S]]', 'Screenshot'],
        ['[[R]], [[Home]]', 'Back to the live edge'],
        ['[[Esc]]', 'Close a panel, the guide or the screenshot tool'],
      ] },
    ],
  },
  {
    id: 'limits', title: 'Good to know',
    blocks: [
      { t: 'list', items: [
        '**This is not advice**, and it places no orders. It is a way to look at what the order books are doing.',
        '**The map is not the whole market.** It shows the exchanges you switched on, and hidden or split orders are not visible.',
        '**A fresh page is shallow far from the price.** Binance\'s depth snapshot reaches only about 0.16% from the price and farther levels appear as they change, so the far side fills in over some minutes.',
        '**A phone only records while the page is open and awake.** A sleeping screen, or another app in front, leaves a gap in the map; **Keep screen on** in Settings holds it awake. With the default eight exchanges the page reads about 50 to 75 KB of exchange data a second, which is 175 to 260 MB an hour: on a mobile connection, switch some off in **Venues**.',
        '**Nothing leaves your machine.** The page talks to the exchanges and to nobody else. Recordings live in your browser; clearing the site\'s data erases them.',
        '**If something looks wrong**: check the connection status at the top right, look for a dashed “unavailable” tag, try Recenter, and if hovering shows nothing, check the Mirror button.',
      ] },
    ],
  },
];

/** Words of readable text in a section (a figure counts as its caption). */
export function wordsIn(section: Section): number {
  const strip = (text: string): string => text.replace(/\*\*|\[\[|\]\]|`|\*/g, ' ');
  const count = (text: string): number => strip(text).split(/\s+/).filter(Boolean).length;
  let n = count(section.title);
  for (const block of section.blocks) {
    if (block.t === 'p' || block.t === 'note') n += count(block.text);
    else if (block.t === 'list') n += block.items.reduce((sum, item) => sum + count(item), 0);
    else if (block.t === 'fig') n += count(block.caption);
    else n += block.rows.reduce((sum, [keys, does]) => sum + count(keys) + count(does), 0);
  }
  return n;
}

/** About how long the whole guide takes: reading at 220 words a minute, plus a quarter of a minute to watch each figure. */
export function readingMinutes(sections: readonly Section[] = SECTIONS): number {
  const words = sections.reduce((sum, s) => sum + wordsIn(s), 0), figures = sections.reduce((sum, s) => sum + s.blocks.filter(b => b.t === 'fig').length, 0);
  return Math.round(words / 220 + figures * 0.25);
}
