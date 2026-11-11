/**
 * The guide's text, as data. Inline markup in any string: `**bold**`, `code` between backticks, and `[[Key]]` for a keyboard key.
 * Figures are named animations drawn by `figures.ts`. The aim is a page that leaves the reader with a working picture of what each part is for.
 * It may grow as the page does (the sixteen minutes it once fitted in were a habit, not a rule): add what a reader needs to understand something,
 * never text to fill a section or a second way of saying what is already said, and leave what is deeper to the "?" panels, which share their text
 * with the tooltips. A section a feature gets is named in that feature's `HELP` entry (`guide:` in `help.ts`), so its "?" panel links here.
 *
 * `part` is the heading the contents list shows above a section: it starts a group of sections, which run on until the next `part`.
 */
export type FigureId = 'anatomy' | 'colours' | 'recording' | 'zoom-price' | 'zoom-time' | 'pan' | 'flow' | 'mirror' | 'footprint';

export type Block =
  | { t: 'p'; text: string }
  | { t: 'list'; items: string[] }
  | { t: 'note'; kind?: 'tip' | 'warn'; text: string }
  | { t: 'fig'; id: FigureId; caption: string }
  | { t: 'keys'; rows: [keys: string, does: string][] };

export interface Section { id: string; title: string; part?: string; blocks: Block[] }

export const SECTIONS: readonly Section[] = [
  {
    id: 'start', title: 'Start here', part: 'The basics',
    blocks: [
      { t: 'p', text: 'LiquidityMapperFast shows you where the orders are. An exchange keeps a list of everyone waiting to buy below the price and everyone waiting to sell above it: the **order book**. This page reads that list from the largest exchanges, adds them together and draws it as a map that moves with the price. Where a lot of size is waiting, the map lights up: those are the **walls** price tends to react to.' },
      { t: 'p', text: 'It is free: nothing to sign up for, and open source. Your browser connects to the exchanges itself. It also asks this site\'s history and levels services for files (the recorded days before you came, and where Hyperliquid\'s positions would be liquidated), and it only asks: nothing you do here is sent anywhere.' },
      { t: 'fig', id: 'anatomy', caption: 'The page at a glance, with two of the panes under the map switched on. Point at a part (hover with a mouse, tap on a touch screen) to see what it is.' },
      { t: 'list', items: [
        '**The chart**: price runs up the side, time runs left to right. The candles show what price did; the coloured map behind them is the order book through time.',
        '**The profile**, the bars at the right edge of the chart, is the order book right now.',
        '**The flow column** at the far left shows what traders did, exchange by exchange.',
        '**The order book** on the far right is the same book as a ladder of prices.',
        '**The panes underneath** (Depth, Open Interest, Delta, Liquidity Tracker, Long/Short, Funding and Bar stats) share the chart\'s time axis. You switch them on with the **Panels** buttons of the toolbar; your own Scripts switch on in the Chart deck.',
        '**The map\'s corner**, on a computer, holds Layouts, Go to, Select (a range), Draw and Recenter. On a phone or tablet Layouts and Range are in Settings, Recenter sits beside the timeframes, Draw is a button at the map\'s top right, and Go to is not offered.',
        '**The toolbar** at the top chooses what to show and how. It is a row of boxes, called decks here: Market, Time, Heatmap, Panels, Chart, Alerts, and the page\'s own (Tour, Guide, Author, Install, Screenshot).',
        'Most buttons of the Chart and Alerts decks are **split buttons**: the button switches the feature on or off, its lamp says which, and the small key joined to its right opens its settings.',
        '**The status bar** along the bottom of a computer\'s window shows the connection, how many exchanges are live, the price, since when the page records, and the **Keys**, clock (Local or UTC), **Language** and **Theme** buttons. On a phone they are in Settings.',
      ] },
      { t: 'note', kind: 'tip', text: 'Short on time? The **Tour** takes a minute: its button is in the toolbar (under Settings on a phone) and at the top of this window. Or read “Reading the map”, “Where the map\'s history comes from” and “Moving around”. Looking for one thing? Type it in the search box at the top of this window.' },
    ],
  },
  {
    id: 'heatmap', title: 'Reading the map',
    blocks: [
      { t: 'p', text: 'Every cell of the map is one price at one moment. Its colour is how much size was waiting there, added up over the exchanges you have switched on: the warmer and brighter, the bigger the order or the stack of orders. Dark and empty means little is there.' },
      { t: 'p', text: 'In the default *Size* style the scale is **logarithmic**: each step along the colour bar is a multiple, not an addition (*Sides* is linear). One gigantic order cannot turn everything else into dust, but a colour says “bigger”, not “twice as big”. The legend in the toolbar shows the dollar range the colours cover.' },
      { t: 'list', items: [
        '**Horizontal streaks are walls**: orders that stay for minutes or hours. Price often stalls, bounces or speeds up when it reaches one.',
        '**Above the price are asks** (sellers waiting), **below are bids** (buyers waiting). The default *Size* style implies the side from the position; *Sides* colours asks pink and bids green.',
        '**A wall that appears or vanishes** means somebody changed their mind. The map records those changes, which one snapshot of the book cannot.',
      ] },
      { t: 'fig', id: 'colours', caption: 'The Contrast slider slides the colour window along the size axis. Right shows thinner liquidity; left keeps only the biggest walls, and the far left pales even those.' },
      { t: 'p', text: '**Auto** keeps that window following the data, so colours do not drift while you pan. **Smooth** blurs the map vertically when price rows get thin, so distant walls stay visible when you zoom out.' },
      { t: 'p', text: 'The **Heatmap** deck in the toolbar chooses the **source**, which is all the exchanges added together or one exchange\'s own map, and holds the colour controls above. Its **Layer** menu is for the liquidity map; stop-loss and take-profit layers are listed there as upcoming. Exchanges do not all publish their books as far from the price: one that looks thin may simply have a book that ends near the price. To see how far an exchange\'s book reaches, point at its line in the order book (in Compact mode), or at its chip in Settings on a phone.' },
      { t: 'note', kind: 'warn', text: 'A wall is an intention, not a fact. Orders can be cancelled at any moment, and some are placed to be seen. The map shows what is resting, never what will trade.' },
    ],
  },
  {
    id: 'recording', title: 'Where the map\'s history comes from',
    blocks: [
      { t: 'p', text: 'This is the most important thing to know about the heatmap. **An exchange only tells you what its order book looks like right now.** None publishes what it looked like an hour ago, so there is no history to download. The map is built by watching the books and writing them down.' },
      { t: 'p', text: 'Two recorders do the watching. **Your browser** does it while the page is open and keeps the last **24 hours** it recorded, so coming back continues the map. **A recorder that runs all day beside this site** does it too: it keeps every minute of Bitcoin\'s books and what was traded on twenty more coins. When the page opens it reads the last day from there at full detail, so a first visit is not empty.' },
      { t: 'p', text: 'Older days are drawn from coarser columns of the same recording, as fine as the zoom allows: Bitcoin\'s go back to the start of November 2026, and Ethereum\'s and Solana\'s are a trial with a coarser grid. The page only reads these files; it sends nothing back.' },
      { t: 'p', text: 'Where no recording reaches, for instance on a coin the recorder does not cover, the coloured part is a thin stripe at the right edge that grows with the minutes. A **dashed line** marks the moment the recording began. Before it the map is left empty: nothing is drawn where nothing was recorded, so every colour on the map is real.' },
      { t: 'fig', id: 'recording', caption: 'A first visit where no recording exists yet, sped up. Colour is what was recorded while the page was open; before the dashed line there is nothing to show.' },
      { t: 'list', items: [
        'Only **one tab records** at a time; another tab shows the live data and the recording so far.',
        'Time with the page closed is filled in from the recorder where it covers the coin; for any other coin it leaves a gap.',
        '**Candles and open interest are different**: they come from each exchange\'s own history, so they are there at once.',
        'The **footprint, trade bubbles, absorption marks and bar stats** are made from the recorded trades, so they have the last day where the recorder covers the coin and start empty elsewhere.',
        'A **phone** reads only the last 3 hours of the recorded history, to start fast. The **History** choice in its Settings picks 3 hours, the whole day or none.',
      ] },
    ],
  },
  {
    id: 'moving', title: 'Moving around',
    blocks: [
      { t: 'p', text: 'On a computer everything is done with the mouse, and nothing needs a click first. While the live candle is on screen the chart follows the market at the zoom you chose, and zooming holds the live edge and the current price still, so the picture swells and shrinks around them instead of sliding. Move the live candle off the screen and the chart stays where you left it; zooming then holds the point under the pointer.' },
      { t: 'keys', rows: [
        ['[[Wheel]] on the chart', 'Zoom **time and price together**, by the same amount, so the picture keeps the shape you gave it'],
        ['[[Wheel]] or drag on the price scale', 'Zoom the **price** axis (drag up zooms in, down zooms out)'],
        ['[[Wheel]] on the time labels along the bottom', 'Zoom the **time** axis'],
        ['[[Shift]] + [[Wheel]]', 'On the chart, zoom the **time** axis alone (on the price scale, time instead of price). [[Alt]] + [[Wheel]] zooms around the pointer'],
        ['Drag', 'Pan both ways. With [[Shift]], pan time only. Moved up or down, the price stays where you put it'],
        ['Right-drag', 'Right or up zooms the time or price axis in; left or down zooms out'],
        ['[[+]], [[−]]', 'Zoom the time axis in or out'],
        ['[[1]] to [[7]]', 'The timeframe: 1m, 5m, 15m, 30m, 1h, 4h, 1d'],
        ['Double-click, [[R]], [[Home]], **Recenter**', 'Back to the live edge, price range fitted'],
        ['**Live**, [[End]]', 'Back to the live candle at the zoom you have'],
      ] },
      { t: 'p', text: 'On a **phone or tablet** the same moves are made with fingers:' },
      { t: 'keys', rows: [
        ['**Drag**', 'Pan both ways. It carries on a little after you lift'],
        ['**Pinch**', 'Sideways zooms **time**, up and down zooms **price**, a diagonal pinch does both; what is under each finger stays under it'],
        ['**Tap**', 'Pins the crosshair and its readout above your finger. Tap again, or drag, to let go'],
        ['**Hold, then drag**', 'Slides the crosshair along without moving the map'],
        ['**Double-tap**', 'Back to the live edge, price range fitted'],
        ['**Live**', 'Back to the live candle at the zoom you have'],
        ['**Drag an axis**', 'Along the price or time scale to zoom it'],
      ] },
      { t: 'fig', id: 'zoom-price', caption: 'Wheel on the price scale: the current price stays put while the scale around it changes.' },
      { t: 'fig', id: 'zoom-time', caption: 'Wheel on the chart: time and price zoom together around the live edge and the current price, which stay put. Candles get wider and the footprint appears.' },
      { t: 'fig', id: 'pan', caption: 'Drag to look around. Once the live candle is off the screen the chart stays where you left it; bring it back into view, or press Live, and it follows again.' },
      { t: 'p', text: 'The panes share the time axis, so what you do to it happens to all of them. Drag the splitters between panes to resize them, and a pane by its grip (⠿) to move it. Sizes and places are remembered.' },
    ],
  },
  {
    id: 'goto', title: 'Go to a moment, and Replay',
    blocks: [
      { t: 'p', text: '**Go to** (in the map\'s corner, or [[G]]) takes the map to a date and time on the page\'s clock, centred at the zoom you have. It says how far back the depth and the candles go: an earlier moment goes to the start of what exists, a later one to the live edge. A phone or tablet does not offer Go to or Replay.' },
      { t: 'p', text: '**Replay from here**, in the same box, plays what was recorded back as if it were live, from the moment you chose, at 1×, 10×, 60× or 300×. A bar on the map has pause, the speed, the moment and **Live**. The map, the candles, the trades, the panes under it and the flow column show only what was known then; what came after is covered.' },
      { t: 'p', text: 'Not everything can be replayed. The order book ladder, the profile column and the dot rows above the flow column\'s exchanges stay out, because the page records the book only as the map\'s minute columns. A candle\'s footprint, bar stats and open interest appear once it has ended. Sounds and alerts stay silent, drawings can be seen but not changed, and a replay that catches up with the present is live again.' },
      { t: 'note', kind: 'tip', text: 'To see how the book stood before a big move, go to the minute before it and press Replay from here: the walls build and vanish as they did.' },
    ],
  },
  {
    id: 'profile', title: 'The profile', part: 'Resting liquidity',
    blocks: [
      { t: 'p', text: 'The bars at the right edge of the chart are the heatmap collapsed into one moment: for every price, the total size waiting there right now. Long bars are walls; pink above the price are asks, green below are bids. It is the quickest way to see the shape of the book, and what **Mirror** works on.' },
    ],
  },
  {
    id: 'order-book', title: 'The order book',
    blocks: [
      { t: 'p', text: 'The ladder on the right is the same book as rows. Each row is a price step; the coloured cells are the exchanges, one column each (BIN, BYB, OKX and so on); the bar at the right is the combined size, with the running total behind it.' },
      { t: 'list', items: [
        '**Mode**: *Aggregated* adds the exchanges together, *Single* gives each its own book, *Compact* (the default) squeezes them.',
        '**Group** is the price step per row. Scroll over the book, pinch it, or drag its price column, to zoom it; drag the book to move it; double-click or double-tap to reset.',
        '**Show** picks levels, the cumulative total, or both.',
        '**Venue lines**, in Compact (off, or the top 3, 5 or 8; 5 at first), draw the running total of each of the largest exchanges on a scale of their own, so you can see which one carries the depth at each distance. Where an exchange\'s book ends (most publish only part of it) its line stops with a short bar and goes on dashed.',
        '**Pull/stack** (off at first) adds a column of how much resting size each row gained or lost over 15 seconds, a minute or five minutes. A row the price traded through is grey: a fill removes size just as a pull does, and the two cannot be told apart.',
        '**Cues**, in the book\'s header, light an exchange\'s cell when the size it shows at a price changes: outward for added depth, back inward for removed. Point at a cell for what changed and what traded meanwhile; it says what was *shown*, never an order.',
        'In the cues\' settings, **Flash** chooses the look of the light and **Sensitivity** how large a change must be to light a cell. **Heat** adds a strip under each cell for how much of it is recent, and **Trade contact** ripples a cell when a large market order reaches it.',
        'Point at a row and its price is drawn across the map and the flow column, so you can see where on the chart that level stands.',
      ] },
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
    id: 'liq-levels', title: 'Liquidation levels',
    blocks: [
      { t: 'p', text: '**Liq levels**, in the Chart deck, draws where Hyperliquid\'s open BTC positions would be liquidated: **longs below the price** in the falling colour, **shorts above it** in the rising one, a row for every $10 of price. A darker row holds more dollars; a crisp edge marks the strongest, and a diamond a row where one position holds at least half. The numbers come from HyperTracker\'s snapshots of every open position, about one every half hour.' },
      { t: 'p', text: 'A snapshot describes the positions about 40 minutes before it can be read. A level that price has traded through since then is gone, whether that happened before you opened the page or while you watch. Positions opened since come with the next snapshot.' },
      { t: 'p', text: 'They sit as a stripe right of the newest candle, so the heatmap keeps its own colours, and the **liquidation column** beside the profile adds them up: in each row what still stands, and faint behind it everything from the price out to that row, which is what would be liquidated if price got there. Point at the column to compare the longs below with the shorts as far above, as **Mirror** does for the book. A switch in the button\'s settings hides the column.' },
      { t: 'p', text: 'Point at the seam between the liquidation column and the profile to weigh the book against the liquidations on each side: what rests against what would be liquidated. The Depth pane can add up the same levels in its bands, and [[Q]] switches them on and off.' },
      { t: 'note', kind: 'warn', text: 'Only Hyperliquid\'s positions are in the snapshots, and only BTC for now. A level is where forced orders *could* start, not a promise: a position can be closed or topped up first, and a trade can reach a level a little before the mark price that liquidates it does.' },
    ],
  },
  {
    id: 'flow', title: 'The flow column', part: 'What traders did',
    blocks: [
      { t: 'p', text: 'The heatmap and the book show what traders **placed**. The column left of the map shows what they **did**, exchange by exchange.' },
      { t: 'p', text: 'Each row has two lines of cumulative volume delta (market buys minus market sells): **blue is spot, amber is perpetual** (the colour-blind themes use two other hues). A rising line means buyers are lifting offers faster than sellers hit bids. The top row adds every exchange; the strip under it is the price, a point a second, from the same trades.' },
      { t: 'fig', id: 'flow', caption: 'The lines grow as trades arrive. Pointing at the column marks the same moment on the map, and the other way round.' },
      { t: 'list', items: [
        'Rows are ranked by volume. Labels sit on the **left**: rank, exchange, net flow, share, and `!5m` when quiet. Every line has its own scale, so compare shapes, not heights.',
        '**Map, 5m ... 24h** sets the span. Map follows the chart, and starts where recording did when that was later (it says so). The gear sets the rows, their heights, **Keep listed** (pin any exchanges you follow) and the sound.',
        '**Spot / Perp** filters the column too, and the top row says how many exchanges the filter leaves out.',
        '**Dot rows** above the exchanges show, on rows of small lamps, whether buyers or sellers were ahead over the last 1, 5, 15 and 60 minutes, and by the size of the orders. The side that is ahead is lit. They are on at first, and not on a phone.',
        'A notice above the rows names every exchange that has flow and is not shown, and why: the Spot / Perp filter or a switched-off exchange (each with a button that puts it right), no trade in the span, or no book on the map yet.',
        '**Bursts**, switched on in the gear, mark with a small triangle ten seconds in which an exchange bought or sold far more at market than it usually does. Only bursts seen while the page is open are marked.',
      ] },
      { t: 'note', text: '**Flow** and **Book** in the toolbar hide or show the side columns, and either one can stand on the other side of the map: drag it by its grip in the title bar. **Layouts**, in the map\'s corner, holds ready-made arrangements and your own. Only exchanges with a trade feed count.' },
    ],
  },
  {
    id: 'chart', title: 'Candles and volume',
    blocks: [
      { t: 'p', text: 'Each candle is one period of price: the thin line is the full range, the body runs from open to close, green when price rose and red when it fell. The buttons at the top (1m to 1d) set the length of a candle, and the footprint, bar stats and open-interest bars follow it. **Volume** bars sit along the bottom, split into what was bought and sold at market; hover one for its shares, its market orders and their average size. Unusually large ones are drawn stronger.' },
      { t: 'p', text: 'Where the recording reaches, a volume bar is what every exchange you have on traded; before it, the bar is the chart market\'s own candle, drawn as an outline. The **chart type** menu, after the timeframes, offers candles, outline candles (so the liquidity under each body shows through), OHLC bars and a line of closes. Averaged or time-free charts such as Heikin Ashi are left out on purpose: the map is about prices that really traded.' },
      { t: 'p', text: 'The dashed **price line** and its tag on the price scale take the colour of the candle under way, and a box under the tag counts down to the candle\'s close. The chart keeps its last 500 candles of each timeframe. Further back it reads the exchange\'s own candles for the view and draws them as candles, or as a line when you zoom out far; the depth and the footprint exist only as far back as they were recorded.' },
      { t: 'p', text: '**Candles**, **Volume** and **Profile** among the Panels buttons hide the candles, the volume bars and the profile column, so the map or a script can stand alone.' },
    ],
  },
  {
    id: 'trades', title: 'Trades, liquidations and absorption',
    blocks: [
      { t: 'p', text: 'Large market orders appear as **bubbles** at the price and time they happened, all the fills of one order together: green for market buys, red for market sells, bigger for bigger (from $25,000). Hover or tap one for its exchange, size and price. The map shows what is waiting; the bubbles show what was actually done.' },
      { t: 'p', text: '**Live trades**, in the Trades panel, draws every market order as a small dot at its own exchange\'s price: the exchanges trade a little apart, so their dots run in parallel bands, and a line runs through the chart market\'s orders. They are kept in the page\'s memory from when it opened, so a reload starts them empty.' },
      { t: 'p', text: '**Liquidations** are positions an exchange closed by force. They are diamonds where the market was, in the sell colour where longs were closed and the buy colour where shorts were. Binance, Bybit, OKX and Deribit publish them (Binance only its largest each second, so a cascade there shows fewer than happened); Hyperliquid, Coinbase and the others publish none. A liquidation is also a market order, so it is among the bubbles too.' },
      { t: 'p', text: '**Absorption** squares mark where one side\'s market orders met resting orders at one price for more than a threshold within 10 ms.' },
      { t: 'p', text: 'A square **below** a level means buyers waiting there took market sells; **above**, sellers waiting there took market buys. The threshold is worked out for each exchange from its own trading, so a busy exchange needs more to be marked than a quiet one.' },
    ],
  },
  {
    id: 'footprint', title: 'The footprint',
    blocks: [
      { t: 'p', text: 'Switch on **Footprint** (Chart deck, or [[F]]) and zoom into the time axis until each candle is wide: the **footprint** appears. At every price inside the candle it shows how much traded **at the bid** (sellers hitting it, the left number) and **at the ask** (buyers lifting it, the right number). Bars show each row\'s volume, coloured where one side was 15% bigger. The heatmap fades as the footprint takes over: both answer the same question at different scales.' },
      { t: 'p', text: '**Delta** is buys minus sells. A candle that rose on mostly sellers\' volume is more fragile than one that rose on buyers\'. The **Bar stats** table under the chart puts a number on it for every candle, and has a section of its own below.' },
      { t: 'p', text: '**Imbalances** compare across rows, as footprint traders read them: a row\'s sells against the buys one row up, and its buys against the sells one row down. Where one is at least 3 times the other (a setting), that half of the row is outlined. In the Footprint panel, a closed candle\'s stacked imbalances can run on to the right as a zone, green below the price as support and red above as resistance, until a later candle trades into it, and its busiest row stays as a dotted line while nothing has traded through it.' },
      { t: 'p', text: '**Count**, in the same panel, chooses whose market orders are added together: every exchange you have on (the default), the chart market alone, or markets you tick yourself.' },
      { t: 'p', text: '**Rejected aggressive buying or selling.** When a candle\'s wick holds more net aggressive buying than any equally tall slice of the rest of the candle, and the candle then closed at least one average range below where those buyers paid, the wick\'s cells where buyers were clearly ahead are outlined in amber and pulse slowly for a dozen candles. Hover them for the numbers. A lower wick works the same way for sellers.' },
      { t: 'fig', id: 'footprint', caption: 'Zooming in reveals the rows, then the imbalances, then a candle with rejected buying.' },
      { t: 'note', kind: 'warn', text: 'This describes a closed candle and says nothing about who holds what. It needs a footprint that holds the candle\'s whole volume (about an hour of recording at 5 minutes, longer at slower timeframes), and nobody has shown that it predicts anything. Treat it as a place to look, never as a signal.' },
    ],
  },
  {
    id: 'bar-stats', title: 'Bar stats: a number per candle',
    blocks: [
      { t: 'p', text: 'The **Bar stats** table under the chart (the **Stats** button in the Panels deck) has one row for each statistic and one cell for each candle, shaded by size. It starts with volume, delta and cumulative delta (cvd). **Stats** in its header opens a list of dozens more, in groups: volume, footprint rows, trades, and candle, open interest and liquidations. Choose the ones you want, drag them into order, or pick a preset (Default, Order flow, All, None).' },
      { t: 'p', text: 'Rows read from the candles and open interest fill candles from before the recording too. Rows read from executions are drawn faint where the recording holds only part of a candle, and the **rec %** row says how much.' },
      { t: 'list', items: [
        '**Click a candle** to pin a card with every statistic for it. [[Shift]] + click pins up to five to read side by side, and [[Esc]] lets go.',
        'The **View** column at the right gives each row over all the candles in view: a sum, a running sum\'s newest value, or a figure worked out from those candles together.',
        '**Cells** can be shaded by size, by how unusual each is against its own recent candles (*Unusual*), drawn as lines, or left as coloured text. **Group rows by kind** folds the rows under headers, and **Export CSV** saves the candles in view.',
      ] },
      { t: 'note', kind: 'tip', text: 'Marks such as “delta vs candle” and “oi × delta” are readings, not proof: open interest cannot say who is long and who is short.' },
    ],
  },
  {
    id: 'volume-profile', title: 'The volume profile',
    blocks: [
      { t: 'p', text: 'The **volume profile** (Chart deck, or [[P]]) adds up what traded at each price: a column beside the map adds it up by price, a band along the top by time, each over what is on the chart. The small key joined to its button opens its settings.' },
      { t: 'p', text: 'Its lines are the **point of control** (POC, the price that traded the most) and the **value area**, the band around it that holds 70% of the volume (a setting), with its top and bottom, **VAH** and **VAL**. They are read on rows of a fixed size, so zooming the price axis does not move them.' },
      { t: 'p', text: '**Where each measure is drawn** is a small grid in the settings: traded volume, the change in open interest, absorption and liquidations, each as a column right of the map, a column left of it (mirrored, so both face the chart) or a band along the top. Any cell can be on, and up to three bands stack. What has no room stays switched on and says so, in the panel and on the map.' },
      { t: 'p', text: '**Traded volume by period** draws days, weeks, months or sessions on the chart over their own time, as lines or bar profiles. Point at a row of a profile for its figures.' },
      { t: 'p', text: '**The previous period\'s levels**: with *Carry the previous period\'s levels* on (it is at first), the previous day\'s, week\'s, month\'s or session\'s point of control and value area are carried across the one under way, long-dashed, fainter and named “Previous …”. They show only where that period can still be worked out.' },
      { t: 'note', text: '**Months** come from 5-minute candles of the most traded market (Binance\'s perpetual, with its spot market where the coin has one), split by their taker buys: an estimate, so they are outlined in the profile colour and labelled ≈ with their source. Today and the last session come from the recorded trades (a day of them on this site); weeks and older days come from candles, marked ≈.' },
      { t: 'p', text: '**Anchored columns.** Under *Columns cover*, *From an anchor* adds every column up from one candle you choose instead of from the left edge of the chart: press *Place the anchor* and click a candle (one for each coin; a dashed line marks it). The columns are worked out again every 5, 15 (the default) or 60 minutes, or at once with *Update now*. Traded volume reaches back up to 21 weeks, as an estimate from candles (≈); liquidations, absorption and open interest reach only as far as they were recorded, and the volume column\'s header says where its numbers begin.' },
      { t: 'p', text: '**Emphasise the bigger side** (on at first) draws the stronger side of each split bar a little stronger and the weaker one fainter, the more one-sided the row is: it says what happened, not what comes next.' },
    ],
  },
  {
    id: 'range', title: 'Range: what traded here',
    blocks: [
      { t: 'p', text: '**Range** answers “what happened in this stretch?”. Press **Select** in the map\'s corner (or [[X]]) and drag across the map for a box (a stretch of time and a band of prices), or across a pane under the map or the flow column for a stretch of time at every price. [[Ctrl]] + drag (⌘ on a Mac) selects at any time, and [[Esc]] cancels. Drag on a profile column, or click one of its rows, to ask about those prices.' },
      { t: 'p', text: 'A panel reports the price move, the market buys and sells, the orders behind them and their average size, where they were filled, the absorption and the resting orders, over the exchanges you have on inside the Spot / Perp filter. It adds open interest, which only perpetuals have and which is always the Open Interest pane\'s, whatever the filter says. A selection that reaches the present stays live.' },
      { t: 'note', text: 'Every market order fills resting orders on its own exchange, so the prices that took the most are where the orders that absorbed them were resting. An order is counted at the price it began at, so a sweep that ran out of a narrow band counts here with only part of its volume.' },
    ],
  },
  {
    id: 'vwap', title: 'VWAP and anchors', part: 'Lines and tools',
    blocks: [
      { t: 'p', text: '**VWAP** is the average price the market traded at, weighted by volume: where buyers and sellers have done business on average. The **VWAP** button (Chart deck, or [[V]]) draws three kinds, which can be on together:' },
      { t: 'list', items: [
        '**Session VWAP** starts again at each day, week or month (or at an hour you choose), with optional ±1σ and ±2σ bands.',
        '**Rolling VWAP** (RVWAP) keeps the last 1, 7, 30, 90, 180 or 365 days up to each moment. The oldest trades drop out as time moves on, so it never restarts, and it is the same line at every timeframe and zoom.',
        '**Anchored VWAP** (AVWAP) keeps everything from a moment you choose, up to four for a coin: press *Place an anchor*, then click the candle (a low, a high, the candle of a news event).',
      ] },
      { t: 'p', text: '**Candles from** says whose candles are added up: *the chart market* (the default), or *chosen markets*, up to six, each exchange\'s spot and perpetual ticked apart and added bar by bar. The bands then keep the spread between the markets, not only their average. A line waits until every market it uses reaches its start, and the panel names one that could not be read or whose history does not reach back far enough.' },
      { t: 'p', text: 'The **whale VWAP** averages only the large market orders that were recorded (the same ones as the trade bubbles, from a size you choose), buys and sells apart.' },
      { t: 'note', kind: 'warn', text: 'Session and anchored lines reach back about two months and rolling ones a year. Hyperliquid serves only its newest 5,000 candles of each size and Bitget about a month of minutes, so a long window on those can be longer than their history.' },
    ],
  },
  {
    id: 'key-levels', title: 'Key levels',
    blocks: [
      { t: 'p', text: '**Key levels** (Chart deck, or [[K]]) draws the levels many traders watch as lines across the map: the previous day\'s high (PDH), low (PDL) and middle (PDM), where the day opened (DO) and how high and low it has traded so far (DH, DL), and the same for the week and the month, with W or M in front.' },
      { t: 'p', text: 'A day starts at midnight in the zone you choose, a week on Monday and a month on the 1st. A previous high, low or middle that the next period never traded through stays on, dotted, until price reaches it. They come from one market\'s hourly candles, read from the exchange about two months back, and the panel names the market.' },
    ],
  },
  {
    id: 'drawing', title: 'Drawing tools',
    blocks: [
      { t: 'p', text: '**Draw** (in the map\'s corner, or [[D]]) brings out a rail of seven tools down the map\'s left edge (along its foot on a phone): a **level** (a line across at one price, or a ray), a **zone** (a box of prices over a stretch of time, which can run on to the right), a **trend line**, a **vertical line** (a moment), a **note**, a **Fib retracement** and a **parallel channel**. Each point is a click (a tap on a phone), and a drag still pans the map, so you can move around while a tool is armed. One drawing, then the tool is put away, unless *Keep the tool* is on.' },
      { t: 'list', items: [
        'A click **selects** a drawing. Its handles move its points and its stroke moves it whole. A zone has eight handles: the middle of its top or bottom moves a price alone, and the middle of a side a time alone.',
        'A small bar beside the selected drawing sets its colour, width, dashes, how far it runs and a label, and has lock, copy and delete. It also gives the figures: a level\'s price, how far the price is from it and what rests in the book\'s row there. A level\'s **alert** sounds when the price reaches it, while Sounds is on.',
        '**The magnet** (Off, Weak or Strong; Weak at first) snaps a point you place or drag to the open, high, low or close of the candle under the pointer, and to walls of resting liquidity in the map\'s column there. Hold [[Alt]] to place a point freely.',
        '**Drawings**, the list button on the rail, lists this coin\'s drawings and holds the magnet, *Show drawings*, *Lock all* and a file to save them all and read them back. [[Delete]] removes the selected drawing, and [[Ctrl]] + [[Z]] undoes.',
      ] },
      { t: 'note', kind: 'tip', text: 'A point is a time and a price, never a candle: another timeframe, a zoom or another market of the coin draws it where you put it. Drawings stay in this browser, each coin\'s apart and outside layouts, and screenshots show them without the handles and the rail.' },
    ],
  },
  {
    id: 'scripts', title: 'Scripts: your own indicators',
    blocks: [
      { t: 'p', text: '**Scripts** are your own indicators. A script is a short program run once for each candle of the chart, oldest first, that draws lines, bars, areas, bands, candles and marks from what it reads: the candle, what was bought and sold at market over the flow column\'s exchanges (or ones it names), the liquidations and the order book. It draws on the map at its own prices, or in a row of its own under the map.' },
      { t: 'list', items: [
        'The **Scripts** button (Chart deck) switches them on, and its settings key opens the Scripts panel. There you write a script, paste one, add one of the **examples**, switch them on one by one, and import or export a file. The page starts with two in the list: **VWAP with bands**, already on and drawn on the map, and **Stochastic heat map**, off.',
        'The language is the one indicator scripts are written in on other charting pages, so most scripts written for them run as they are. The panel lists what is not supported.',
        'A script runs on a thread of its own and can read nothing but those inputs: no page, no network, no storage. One that loops for too long is stopped, and says where.',
        'Scripts read 10,000 of the chart market\'s own candles (2,000 on a phone). *Candles per script* offers 2,000 to 100,000, and more take longer the first time.',
        '**Copy for AI**, in a script\'s editor, puts on the clipboard what an AI assistant needs to write or fix one: the language\'s rules, the script, its errors and what it last drew. The whole language is published as `script-reference.md` at the site\'s root.',
      ] },
      { t: 'note', kind: 'tip', text: 'Scripts stay in this browser. Export writes them to a file and Import reads it back, which is how they move to another browser or device. Where the page has no flow for a candle, a script reads NaN there and nothing is drawn.' },
    ],
  },
  {
    id: 'lower-panes', title: 'The panes underneath', part: 'Panes under the map',
    blocks: [
      { t: 'p', text: 'The panes under the map share its time axis: what you do to the axis happens to all of them, and the pointer draws one crosshair through them and the map, with its value on each scale. The **Panels** buttons in the toolbar show or hide them (the page opens with none), and each has a **?** in its header.' },
      { t: 'list', items: [
        '**Depth** adds up bids and asks within nested distances of the price.',
        '**Open Interest** is the number of contracts currently open, and how it changes.',
        '**Delta** is each candle\'s market buys minus sells, with CVD candles and an estimate of who opened and closed positions (**NL/NS**).',
        '**Liquidity Tracker** (LT) draws bid and ask liquidity near the price as two lines.',
        '**Long/Short** shows the share of each exchange\'s accounts that is net long.',
        '**Funding** shows a perpetual\'s funding and premium.',
        '**Bar stats** and **Scripts**, described above, also stand here.',
      ] },
      { t: 'p', text: 'Where a pane has several things of one kind at one moment, such as every band or every exchange, it reads them in a **table** at the pointer\'s time, or the newest: beside the plot where there is room, otherwise over its left end while you point at the pane. The Table switch in its header hides it.' },
    ],
  },
  {
    id: 'depth', title: 'Depth',
    blocks: [
      { t: 'p', text: 'For every moment, **Depth** adds up the bids and the asks within several distances of the price and draws them as nested rings: asks up in pink, bids down in green, the narrowest band strongest at the centre and the widest lightest. Each band holds the ones inside it. **Bands** chooses the distances (Balanced doubles from ±0.31% to ±5%; Near, Wide or your own); *Detail* draws the square root of the money so a thin inner band shows, and *Units* counts the coin instead of dollars.' },
      { t: 'p', text: 'Click a row of the table to bring that band forward at its own scale. When one side of it is unusually larger than the other over a candle (see “What stands out”), that side\'s edge is drawn thick across the candle: is there more resting liquidity above or below, and is that changing? Its **Source** can also be the liquidation levels, which adds up the same bands for Hyperliquid\'s BTC positions.' },
    ],
  },
  {
    id: 'open-interest', title: 'Open interest',
    blocks: [
      { t: 'p', text: '**Open Interest** is the number of contracts currently open, which is not volume. It rises when positions are opened and falls when they are closed, and it cannot tell you who is long or short. The small bars are its change per candle.' },
      { t: 'p', text: 'By default the perpetuals of every exchange that has them are added together, in coins: Binance, Bybit, OKX, Bitget, Deribit and Hyperliquid. The Spot / Perp filter does not hide them, because spot markets have no open interest. **Venues** can also be the chart market alone, or markets you tick. A candle\'s change is each exchange\'s own change added up, so an exchange whose readings start is not counted as positions opened.' },
      { t: 'p', text: 'The change bars are split by who made them (**Bars: NL/NS**, the default): a rise into new longs (buy colour) and new shorts (sell colour), a fall into shorts and longs closed, lighter. Zoomed out far, the line goes on faint and dashed from Bybit\'s history, which reaches back years, scaled to meet the line: an estimate of the total, marked ≈.' },
    ],
  },
  {
    id: 'delta', title: 'Delta, CVD and who opened',
    blocks: [
      { t: 'p', text: '**Delta** is each candle\'s market buys minus market sells, in dollars, over the exchanges the flow column adds up. As **bars** it is each candle on its own; as **CVD candles** it adds up from the left edge of the chart, or starts again each day or week. A CVD candle opens and closes exactly where the running delta stood; its high and low are sampled sixteen times through the candle, so a wick can be a little short.' },
      { t: 'p', text: '**Divergences** (on at first) join two swing highs where price made the higher high and the CVD the lower one (in the sell colour), or two swing lows where price made the lower low and the CVD the higher one (in the buy colour), on the CVD candles and on the map. They show where buying or selling faded against the price.' },
      { t: 'p', text: '**NL/NS** (the third choice of *Show*) estimates who opened and closed positions. Each candle\'s change of open interest is given to the side that traded at market: up with buyers means new longs, up with sellers new shorts, down with sellers longs closed, down with buyers shorts closed. Bars are solid where positions were opened and hollow where they were closed, and the line is their running sum. *As* switches between one net series and two lines, the longs and the shorts.' },
      { t: 'note', kind: 'warn', text: 'NL/NS is an estimate for one market, not a count, because every position has a long and a short holder. Where the minute readings reach (the last day) it is worked out minute by minute, so a long candle can show longs opened early on and shorts closed later. Neither it nor the divergences have been tested as a signal.' },
    ],
  },
  {
    id: 'lt', title: 'Liquidity Tracker',
    blocks: [
      { t: 'p', text: '**Liquidity Tracker** (LT) draws bid and ask liquidity near the price as two lines, the closest counting most. Bid above ask means more support below the price than resistance above.' },
      { t: 'p', text: 'A level counts fully at the touch and half as much for every half-life further away, in basis points, so thin and distant orders barely move the line. Switch the view to imbalance for one line between −100% and +100%. The options set the half-life, the smallest and largest bin that counts, and whether to average per level.' },
    ],
  },
  {
    id: 'ls', title: 'Long/Short',
    blocks: [
      { t: 'p', text: 'The **Long/Short** pane shows, as each exchange publishes it, the share of its accounts that is net long: Binance, Bitget and Gate (all accounts, or their top traders, chosen by *Series*) and Bybit. There is one line for each exchange, with its mark where the line ends. OKX publishes its ratio only to servers, so the pane shows it as not readable here. Readings come every five minutes at the finest, Binance\'s go back years, and nothing is filled in where an exchange has none.' },
      { t: 'note', kind: 'warn', text: 'These count **accounts**, not coins. Every contract has a long and a short holder, so in coins the two sides are always equal: 1.25 means 1.25 long accounts for each short one, not 25% more BTC long. The exchanges count different people, so the lines are never added together, and none of it has been tested as a signal.' },
    ],
  },
  {
    id: 'funding', title: 'Funding',
    blocks: [
      { t: 'p', text: '**Funding** is what holders of a perpetual pay each other every interval to keep its price near the index: when it is positive, longs pay shorts. The **Funding** pane shows one exchange\'s (Hyperliquid, Binance, Bybit, OKX, Bitget or Deribit, chosen by *Venue*): settled funding as thick steps, the one accruing now dashed, and where the exchange publishes it the **premium** (how far the perpetual\'s price sits from the index) as a thin line.' },
      { t: 'p', text: 'Every rate is per eight hours, so the base rate (0.01%, dashed) and the band where the premium moves while funding stays put are the same on every exchange that has them. Hyperliquid settles every hour, which the pane scales to eight, and Deribit\'s funding is continuous, with no base rate. The table lists every exchange that lists the coin: click a row to show that one.' },
      { t: 'p', text: 'On Hyperliquid, under each hour of the last day, the pane shows the share of new positions that buyers opened at market (NL/NS). Measured on BTC and ETH, funding moved with that share hour by hour. It is context: whether any of it says where the price goes was not tested.' },
    ],
  },
  {
    id: 'highlights', title: 'What stands out', part: 'Alerts',
    blocks: [
      { t: 'p', text: 'One rule decides what is unusual, everywhere on the page: a value stands out when it is more than a chosen number of standard deviations above the average of the bars before it. The defaults are 2σ over the previous 72 bars, and nothing is flagged until a dozen bars exist. It applies to volume, open-interest changes and depth imbalance: what stands out is drawn at full strength and the rest recedes. **Highlights** in the toolbar sets it, or turns it off.' },
      { t: 'p', text: 'The order book shows which side dominates the same way, and the Bar stats\' **Unusual** cells and the chime for unusual volume use the same rule.' },
    ],
  },
  {
    id: 'sounds', title: 'Sounds and Waves',
    blocks: [
      { t: 'p', text: '**Sounds** turn trades into chimes: rising for buys, falling for sells, richer for bigger sweeps. They start switched off: press **Sounds** in the Alerts deck. Four tiers set the sizes (Signal $50k, Surge $150k, Whale $400k, Leviathan $1.5M); Whale and Leviathan are ticked at first. Browsers keep audio locked until you click or press a key on the page once.' },
      { t: 'p', text: 'Under **Per panel** in the Sounds panel, each pane can sound one rare event: a burst of taker flow, a candle closing on a big net delta, a large wall appearing or being pulled, the balance of the book tipping, or an unusual open-interest change. All off until chosen. The same panel has a **Chime on unusual volume**, for a candle that closes on unusually large volume (also off until chosen).' },
      { t: 'p', text: '**Waves** turns the bars and panels around the chart to glass, in any theme, and lets large orders light it: the glass nearest where an order traded lights up and a wave runs across the screen, slowing in the glass and turning back at the splitters. Large changes in the flow column start waves of their own. A busy market holds its waves back, so a cascade never floods the screen, and **Strength**, in the settings key beside the Waves button (Wave strength in a phone\'s Settings), sets how strongly they are drawn.' },
    ],
  },
  {
    id: 'layouts', title: 'Make it yours', part: 'Your page',
    blocks: [
      { t: 'p', text: 'Every panel can be closed, moved and resized, and the whole arrangement can be saved under a name. None of it changes what the page shows, only where things stand.' },
      { t: 'list', items: [
        '**Close** a panel with the × on its title bar. A side column with nothing open leaves a small tab at the window\'s edge that opens it again; the **Panels** buttons in the toolbar do the same, and [[[]] and [[]]] hide or show the left and the right column.',
        '**Move** a panel by dragging its grip in the title bar. The flow column and the order book can stand on either side of the map, or one over the other; the panels under the map change places among themselves. The ⋯ menu on each panel offers the same moves from a keyboard or a touch screen.',
        '**Resize** with the splitters between panels. Double-click a splitter to give back the default size.',
        '**Layouts**, the first button in the map\'s corner (under Settings on a tablet), holds six ready-made arrangements (Default, Map only, Order book, Order flow, Positioning and Everything) and your own, each drawn as a small picture of its panels. A ready-made layout decides which panels are open and how big they are, and Order flow also switches the footprint on: your colours, timeframe and venues stay as they are.',
        '**Save** what is on the screen under a name and apply it from the same panel. Tick “With the chart’s settings” to keep the timeframe, the colours and every switch as well.',
        '**Undo** is offered for a few seconds after applying a layout, hiding a panel or deleting a layout, and puts back only what that did.',
      ] },
      { t: 'note', kind: 'tip', text: 'Layouts live in this browser. **Export** writes them to a file and **Import** reads it back, to use them in another browser. On a phone the panels are tabs, so there is nothing to arrange.' },
    ],
  },
  {
    id: 'venues', title: 'Exchanges, spot and perpetuals',
    blocks: [
      { t: 'p', text: 'By default the map combines eleven markets: the perpetual futures of Binance, Bybit, OKX, Bitget, Hyperliquid and Deribit, and the spot markets of Binance, Coinbase, Bybit, OKX and Bitget. The **Venues** button switches each of them on or off, and its **Choose…** picks which exchanges feed the page, MEXC included, once you press Apply. The choice is kept in your browser.' },
      { t: 'list', items: [
        '**Spot / Perp / Both** filters what the liquidity views draw.',
        'The **Venues** list has a switch for each exchange (the page calls them chips, and a phone shows them in Settings): off leaves its book out of the map, the order book and the flow column without stopping its feed. A dimmed one is hidden by the Spot / Perp filter: click it to show it. An exchange you chose that has no map gets a dashed tag that says why.',
        'The **Heatmap** selector shows a single exchange\'s own map instead of the combined one.',
        'The **market** selector chooses whose candles, footprint and open interest the chart uses.',
      ] },
      { t: 'p', text: 'Some exchanges refuse some countries. If one never connects while the others work, its chip becomes a dashed tag and a banner says it is **unavailable from your location**. A VPN set to another country may enable it; the rest keep working either way.' },
    ],
  },
  {
    id: 'coins', title: 'Coins',
    blocks: [
      { t: 'p', text: 'The **coin** button lists about 150 coins that trade on at least nine of the eleven default markets, the biggest first, with a search. Choosing one reloads the page for that coin, with new connections and recordings, so nothing of the last coin is carried over. The address remembers it (`?coin=ETH`), and so does this browser.' },
      { t: 'list', items: [
        '**Sizes follow the coin.** Every size setting (trade bubbles, liquidations, absorption, sounds, the Liquidity Tracker\'s filter) is set for Bitcoin and scaled to the coin by its trading volume, so one setting serves every coin.',
        '**Not every coin has recorded history.** The recorder keeps Bitcoin\'s books and what was traded on twenty more coins. The others start empty and record in your browser while the page is open (see “Where the map\'s history comes from”).',
        '**Liquidation levels** are Bitcoin only.',
        'A market that does not list the coin shows as such in the **Venues** picker and cannot be ticked.',
      ] },
    ],
  },
  {
    id: 'phones', title: 'On a phone or tablet',
    blocks: [
      { t: 'p', text: 'The page is arranged for the screen it is on. On a phone held upright the top bar has two rows (the coin and Settings above; timeframes and Recenter below), the map fills the width, one pane shows under it, and a **bar of tabs** picks the pane: the **Tape**, the **Flow**, the **Map**, the **Book**, and the panes you switch on in Settings. **Map** gives the chart the whole screen. Held on its side, the pane stands beside the map and the tabs become a rail. A large tablet held sideways (over 1,100 pixels wide) gets the desktop arrangement, with Layouts under Settings; a smaller one gets the phone\'s.' },
      { t: 'list', items: [
        'The **Tape** is every trade since the page opened, as one continuous tape: each row is a price, with what was sold at market on the left and bought on the right, the book resting either side, and the trail of the last seconds of market orders running left behind it. It opens at once, because it fetches nothing.',
        'The **Flow** tab is the flow column made for a phone: the price drawn over the flow of all the exchanges (spot blue, perpetual amber), with a row for each exchange under it. A finger along the chart scrubs it, a tap pins the moment, and two fingers apart or together step to a longer or a shorter span.',
        '**Settings** (the ⋯ button) is a bottom sheet holding every control that does not fit the bar: the pane switches, the heatmap colours, the market and the venues, the alerts, the theme, **Keep screen on** (a sleeping screen stops the recording) and Guide, Screenshot, Author and Install.',
        'The small up-arrow at the right end of the top bar **folds** it away to give the chart the screen, and the strip\'s down-arrow brings it back. A desktop has the same arrow.',
      ] },
      { t: 'note', kind: 'tip', text: 'The gestures are listed under “Moving around”. Every button explains itself when held, and the ? beside a pane says what it is.' },
    ],
  },
  {
    id: 'tools', title: 'Tools, themes and keys',
    blocks: [
      { t: 'p', text: '**Tour** replays the one-minute tour of the page, and **Guide** opens this one; **Author** says who made the page and where the code is. They sit together at the top right of the toolbar, and in Settings on a phone.' },
      { t: 'p', text: '**Search** this guide with the box at its top. It finds sections as you type, forgives a typo, and takes you to the paragraph. Press [[/]] to reach the box.' },
      { t: 'p', text: '**Screenshot** (or [[S]]) freezes the page under a dim layer that says “Select an area”. Drag a region, or click or tap a pane to take all of it (the top bar takes the whole page). Draw on it with the pen, line, arrow, rectangle, highlighter or text, and hide anything private with **pixelate** or **blur**. **Copy** puts the picture on the clipboard; the arrow beside it saves a PNG, and on a phone the share arrow opens the phone\'s own share sheet.' },
      { t: 'p', text: 'The picture is saved with at least two pixels to each pixel of the page (more on a sharper screen), so it stays crisp. **GIF** records the same area for 1 to 15 seconds instead.' },
      { t: 'p', text: 'The **theme** menu (in the status bar; in Settings on a phone) has more than twenty themes, light and dark: hover one to preview it everywhere, click or tap to keep it. **Install** appears when your browser can install this page as an app; an iPhone or iPad has no prompt: choose Share, then Add to Home Screen.' },
      { t: 'p', text: 'The browser tab shows the price too: its title starts with the chart market\'s price and an arrow for the way the candle under way is going, and its icon draws that candle, so a pinned tab still tells you where the price is going. The clock button in the status bar (it reads Local or UTC) switches the page\'s times between your computer\'s time and UTC, and the **Language** button beside it switches the page and this guide between its twelve languages.' },
      { t: 'keys', rows: [
        ['[[S]]', 'Screenshot'],
        ['[[G]]', 'Go to a date and time'],
        ['[[X]]', 'Range: the next drag selects ([[Esc]] cancels)'],
        ['[[D]]', 'Drawing tools'],
        ['[[F]] [[T]] [[L]] [[Q]] [[A]] [[P]] [[K]] [[V]] [[H]]', 'Switch Footprint, Trades, Liquidations, Liquidation levels, Absorption, Volume profile, Key levels, VWAP and Highlights on or off'],
        ['[[?]]', 'All keys'],
        ['[[[]], [[]]]', 'Hide or show the left and the right column'],
        ['[[Esc]]', 'Close a panel, the guide or the screenshot tool'],
      ] },
    ],
  },
  {
    id: 'limits', title: 'Good to know',
    blocks: [
      { t: 'list', items: [
        '**This is not advice**, and it places no orders. It is a way to look at what the order books are doing.',
        '**Nothing here is tested as a signal.** Divergences, NL/NS, rejected buying, absorption and the liquidation levels describe what happened or where forced orders could start. None has been shown to predict what comes next.',
        '**The map is not the whole market.** It shows the exchanges you switched on, and hidden or split orders are not visible.',
        '**A fresh page is shallow far from the price.** The far side fills in over some minutes.',
        '**A phone only records while the page is open and awake.** A sleeping screen leaves a gap in the map; **Keep screen on** in Settings holds it awake. With all eleven markets the page reads about 200 to 300 MB an hour: on a mobile connection, switch some off in **Venues**.',
        '**Nothing you do leaves your machine.** The page talks to the exchanges and, only to read, to this site\'s history and levels services. Recordings live in your browser; clearing the site\'s data erases them.',
        '**If something looks wrong**: check the connection status (the dot at the left of the bottom bar, at the top right on a phone), try Recenter, and if hovering shows nothing, check the Mirror button.',
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
