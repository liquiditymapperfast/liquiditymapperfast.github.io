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
export type HelpId = 'profile' | 'traded' | 'absorption' | 'depth' | 'oi' | 'candles' | 'footprint' | 'lt' | 'mirror' | 'volume' | 'bubbles' | 'heatmap' | 'depthPane' | 'oiPane' | 'ltPane' | 'stats' | 'orderBook' | 'cvd' | 'trades' | 'book' | 'highlights' | 'sounds' | 'range' | 'liquidations' | 'liqLevels' | 'keyLevels' | 'vwap' | 'tpo' | 'delta' | 'deltaPane' | 'ls' | 'lsPane' | 'funding' | 'fundingPane' | 'replay' | 'candlePane' | 'script' | 'scriptPane';

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
      t('Hover it and the Mirror comparison appears (switch that off with Mirror in the order book\'s Cues panel).')],
  },
  traded: {
    title: t('Volume profile'), guide: 'volume-profile',
    tip: t('Profiles of what traded, beside the map and along the top of the chart: how much was bought and sold at market at each price, and in each stretch of time, over the time on the map. Next to the resting liquidity, it shows which levels have actually changed hands, and when.'),
    body: [t('The point of control is the price that traded the most; the value area is the band around it that holds 70% of the volume (the share is a setting), with its top and bottom the value area high and low (VAH, VAL). They are read from every price that traded, on rows of a fixed size, so zooming the price axis does not move them.'),
      t('In the settings they can be drawn as lines on the chart. The column always adds up what is on the chart; days, weeks, months and sessions you set in any market\'s time zone are drawn on the chart itself, each over its own time, with their lines and names and, for one kind, their profiles. Hover a row for what traded there and the market orders that began at those prices, or the header for the figures of the whole window; drag on the column, or click a row, for everything about those prices in the Range panel.'),
      t('Days, weeks and sessions come from the recording, as far back as it keeps trades (a week; a day on a page that reads the exchanges itself), or from the candles of the most traded market: an estimate, marked ≈, that reaches back months.'),
      t("Months, and days, weeks or sessions worked out from candles, come from the 5-minute candles (one-minute for sessions off the five) of the most traded market, Binance's perpetual with its spot market where the coin has one: each candle's volume spread evenly over its range and split into buys and sells by its taker buys. Those profiles are an estimate, so they are outlined in the profile colour and labelled ≈ with where they come from; where a market's candles do not say who bought, they are drawn grey. Point at a row of any profile on the chart for its figures."),
      t('An order is counted at the price it began at, so a row inside a sweep can have volume and no orders of its own.'),
      t('In the settings a grid sets where each measure is drawn (traded volume, the change in open interest, absorption or liquidations): as a column right or left of the map, the left ones mirrored so both face the chart, or as a band along the top, where the same profile is laid on the time axis: one bar for each stretch, from a second to a day as the zoom allows, growing down from the top, with the busiest stretch as its point of control and the value area around it. Up to three bands stack. What has no room stays switched on and is said, in the panel and on the map. Point at a bar for its figures; click a band\'s header for these settings.'),
      t('The previous day\'s, week\'s, month\'s or session\'s point of control and value area are carried across the one under way, long-dashed and fainter and named "Previous …", whether or not price has traded through them (a switch in the settings). They are drawn only when that period can still be worked out: the recording usually holds no previous week, nor a previous day on a page that reads the exchanges itself; candles reach further and are marked ≈. The older a day, week or session is among those drawn, the fainter its lines and profile.')],
  },
  keyLevels: {
    title: t('Key levels'), guide: 'key-levels',
    tip: t('Lines where the previous day, week and month traded highest and lowest and halfway between, and where the one under way opened: the levels many traders watch.'),
    body: [t('PDH and PDL are the previous day\'s high and low and PDM the middle of the two; DO is where the day opened, and DH and DL how high and low it has traded so far. W and M stand for the week and the month. A day starts at midnight in the zone you choose (the Volume profile\'s), a week on Monday and a month on the 1st.'),
      t('They come from one market\'s hourly candles, read from the exchange: the market on the chart where the page can read its history, else another market of the coin, named in the panel. The hour under way follows the chart\'s own candles. They reach back about two months.'),
      t('A previous high, low or middle that the next period never traded through stays on, dotted, until price reaches it.')],
  },
  replay: {
    title: t('Replay'), guide: 'goto',
    tip: t('Play what was recorded back as if it were live, from a moment you choose in Go to.'),
    body: [t('Replay starts from a moment you choose in Go to (Replay from here) and moves on at the speed chosen: the map, its candles, the trades, the panes under it and the flow column show what was known then, and what came after is covered. Live goes back to now; a replay that catches up goes back on its own.'),
      t('What it cannot show: the order book (recorded a minute at a time as the map\'s columns, not as a ladder), the profile column, and the dot rows above the flow column. The candle under way is rebuilt from the recorded price a second, exact within the last day and a minute at a time before; the footprint, the bar statistics and the open interest of a candle are shown once it has ended. Candles reach back as far as the chart holds them (its last 500), the map as far as depth is recorded. Sounds and alerts are silent.')],
  },
  vwap: {
    title: t('VWAP'), guide: 'vwap',
    tip: t('The average price the market traded at, weighted by volume, since a session began, over the last days or since a moment you choose: where buyers and sellers have done business on average.'),
    body: [t('The session VWAP starts again each day, week or month, in the zone the Volume profile and Key levels use; its bands are one and two standard deviations of the prices traded, weighted by volume.'),
      t('An anchored VWAP (AVWAP) runs from a moment you choose, up to six a coin, as far as ten years back: tick a period\'s start, high or low in the grid (the line follows it, moving to each new high or low, or on to the next period), type a date and an optional time, or click a candle on the map (a drag still pans; Esc cancels).'),
      t('A rolling VWAP (RVWAP) is the average over the last day, week, month, quarter, half year or year up to each moment. Its start moves with time, so the oldest trades drop out, where a session or an anchor keeps every trade since its start. It is worked out from bars of its own (five minutes for a day up to four hours for a year), the newest read again each minute, so it is the same at every timeframe, and it is drawn only where the history holds a whole window.'),
      t('Each bar\'s typical price (its high, low and close) is weighted by its volume, from one market\'s candles read from the exchange, a minute at a time for a day and coarser for longer: the market on the chart where the page can read its history, named in the panel. The bar under way follows the chart\'s own candles.'),
      t('The whale VWAP averages only the large market orders that are recorded (the same orders as the trade bubbles, from the size you choose), buys and sells apart, on the exchanges switched on, since the session began or since the recording did.')],
  },
  tpo: {
    title: t('TPO'), guide: 'tpo',
    tip: t('TPO (Market Profile): each half hour of a day stacked as a block at every price it traded at, so the day folds into the shape of where the market spent its time.'),
    body: [t('Each day, week or session (in the zone the Volume profile uses) is cut into blocks, half an hour each by default, lettered A to Z and then a to z. A block stands at every row its half hour traded at, and the rows are stacked from the window\'s start: the longest row is where price spent the most time, its point of control, and the value area holds 70 % of the blocks around it. The blocks of the first hour make the initial balance (IBH, IBL; the first block, where blocks are an hour or longer); the arrows mark the window\'s first price and its last.'),
      t('At the top and bottom, two or more rows of a single block are a tail: price was there briefly and left. A top or bottom row of two or more blocks is poor: price kept returning without going further. These calls depend on where the row edges fall, so each one is worked out on four row grids, each moved by part of a row, and says how many of the four agree (4/4 is steady, 2/4 could go either way). Single prints are rows of one block between the tails.'),
      t('A block drawn as an outline is one where this market\'s wick went at least a row and 3 bp past the point most of the market\'s volume reached, from the other venues switched on, each moved by its usual gap to this market first: a price that venue printed alone. Rare on the largest markets.'),
      t('U lays the blocks out in time, each half hour in its own column behind its own candles, and folds them back. Right-click a block (on a touch screen, tap it, then tap its box) to split its window there or merge it with the window before or after (kept per coin, kind of window and block length). The candles are the chart market\'s, read from the exchange; the block under way follows the chart\'s own price. While the TPO shows, the Volume profile\'s lines of the same windows follow the TPO\'s levels.'),
      t('Every window in view is drawn (or, under How many, the latest few), back about thirteen months: scroll the chart back to see older days. Zoomed out, each row is one bar as long as its blocks, in the colour of when the market was at that price. Candles from can take markets you tick instead of the chart market: each block then spans where most of their volume traded, and a row only one of them reached is drawn hollow.')],
  },
  delta: {
    title: t('Delta'), guide: 'delta',
    tip: t('A pane under the map: what taker buys outweighed sells by in each candle, and the cumulative delta (CVD) as candles.'),
    body: [],
  },
  deltaPane: {
    title: t('Delta'), guide: 'delta',
    tip: t('What taker buys outweighed sells by in each candle, over the exchanges the flow column adds up.'),
    body: [t('Each candle\'s delta is what was bought at market minus what was sold, in dollars, over the same markets as the flow column\'s ALL VENUES lines (the exchanges switched on, inside Spot / Perp). As bars it is each candle on its own; as CVD candles it adds up from the left edge of the chart, or starts again each day or week, and a dotted line marks where it starts again.'),
      t('A CVD candle opens and closes where the running delta was at the candle\'s start and end. Its high and low are sampled sixteen times through the candle, since the extremes of a sum over several exchanges are not kept, so a wick can be a little short.'),
      t('It comes from the flow the page holds: a day a second at a time, and older minutes where the server keeps them. Candles before that have none. After a stretch with nothing recorded the CVD carries on from where it stopped, past a dotted line: what traded in the stretch is not counted.'),
      t('Divergences join two swing highs in a row where the price made the higher high and the CVD the lower one (in the sell colour, above the highs), or two swing lows where the price made the lower low and the CVD the higher one (in the buy colour, below the lows), on the CVD candles and on the map. A swing must stand beyond the chosen number of closed candles each side, so a divergence appears that many candles after its newer swing, and swings on either side of a restart of the CVD are not compared. They need the chart to show the market\'s own candles. They show where buying or selling faded against the price; they have not been tested as a signal.'),
      t('NL/NS (in Show) estimates who opened and closed positions: each candle\'s change of open interest of the OI pane\'s market, given to the side that traded at market there (its taker delta, or the way its price went where its flow is not recorded). Up with buyers: new longs; up with sellers: new shorts; down with sellers: longs closed; down with buyers: shorts closed. Each candle\'s bar holds all four: above the line what buyers did (new longs solid, next to the line, then shorts closed, lighter), below it what sellers did (new shorts solid, then longs closed, lighter). A bar much larger than the rest is cut at the edge with a gap across it, and the popup gives the numbers. The readout gives the running net since the start, restarting where the CVD does; Longs and shorts draws each side\'s running sum. Every position has a long and a short holder, so this is an estimate, in coins and for that one market; tested against the moves that followed, it is context, not a signal.'),
      t('With the OI pane\'s Venues on All perpetuals (the default), each venue\'s change of open interest is given to the side that traded at market on that venue, and the venues are then added up: one venue\'s buyers say nothing about who opened positions on another.'),
      t('A market\'s change is measured between its own readings and shown in the candle of its new one, given to its takers over the whole stretch since the reading before: a venue read only hourly (older history) changes once an hour, and the popup says so. A candle can hold new longs on one venue and new shorts on another; the popup lists the four parts and reads it as both ways. Deribit counts its open interest in dollars, so it is put in coins at one price, the newest close: a move of the price alone opens and closes nothing.'),
      t('As (with NL/NS shown): Four parts draws each candle\'s bar with all four parts; the running net is in the readout. Longs and shorts draws two lines instead: the running sum of the longs (new longs less longs closed) and of the shorts (new shorts less shorts closed). A rising line is that side adding positions, a falling one that side closing them.'),
      t('Where a venue\'s minute readings and flow cover a candle (the last day, on the venues read every minute or every five), NL/NS works it out minute by minute: each minute\'s change given to that minute\'s takers, added up into the candle. Inside a long candle, longs opened at market early on and shorts closed later are then both seen, where the candle\'s one delta would name only one side. Measured against every Hyperliquid trade on two coins, this named the side that opened more for about 94 % of the rise per 15-minute candle, the candle\'s delta for about 90 %. The popup says how each candle was read.'),
      t('Drag across the pane with Select armed, or Ctrl+drag (Cmd on a Mac), to sum up a stretch of its candles in the Range panel: the recorded delta and its share of the volume, bought and sold, the price over the same candles, how the delta was spread over them, and with NL/NS the same estimated added and reduced as the OI pane.'),
      t('The table reads each market at the candle under the pointer, else the newest: what it bought and sold at market, their difference and its share of the candle\'s volume, beside the chart where there is room, else over its left end while you point at the pane. The most traded markets over the candles in view get a row each; the rest are added up in the last row. With NL/NS shown there is no table: its markets are the OI pane\'s, whose table has each venue.')],
  },
  ls: {
    title: t('Long/Short'), guide: 'ls',
    tip: t('A pane under the map: the share of each exchange\'s accounts that is net long, as the exchanges publish it.'),
    body: [],
  },
  lsPane: {
    title: t('Long/Short'), guide: 'ls',
    tip: t('The share of each exchange\'s accounts that is net long, as the exchange publishes it.'),
    body: [t('Each line is one exchange\'s share of accounts that are net long, as the exchange publishes it, for the open-interest markets (the OI pane\'s Venues) on Binance, Bybit, OKX and Bitget, and Gate\'s perpetual when the OI pane counts every market, with the exchange\'s mark where its line ends. The scale fits the lines, which move by tenths of a percent; the dashed line is 50 %, where it falls inside it.'),
      t('These count accounts (or, for the top traders by positions, the size of their positions) as each exchange classifies them, never coins: every contract has a long and a short holder, so in coins the two sides are always equal. A ratio of 1.25 is 1.25 long accounts for each short one, not 25 % more BTC long. The exchanges count different people, so their lines are not added together.'),
      t('Binance, OKX, Bitget and Gate publish three series each (all accounts, their top traders by accounts, and by positions; the header chooses): Binance for years (its last 30 days from its API, the days before from its daily data archive; COIN-M markets the last 30 days only), OKX its top traders for about 30 days and only to a server (a page cannot read it), Gate for 90 days and more, its top traders being its large holders as Gate counts them, and Bitget its newest 30 readings only, so its line starts there, its top traders being the ones it calls active in English and large traders in Chinese, without saying how it picks them. Bybit publishes one. HTX, Kraken Futures and Bitfinex publish theirs only to servers (no web page may read them), and Hyperliquid publishes none. Readings come every five minutes at the finest and hold until the next; nothing is filled in where an exchange has none. They have not been tested as a signal.'),
      t('The table reads every venue at the pointer\'s time, else the newest: beside the chart where there is room, else over its left end while you point at the pane.')],
  },
  funding: {
    title: t('Funding'), guide: 'funding',
    tip: t('A pane under the map: a perpetual\'s funding and premium on one venue, and on Hyperliquid who opened each hour.'),
    body: [],
  },
  fundingPane: {
    title: t('Funding'), guide: 'funding',
    tip: t('A perpetual\'s funding and premium on one venue, per eight hours; on Hyperliquid, under each hour, the share of new positions buyers opened at market.'),
    body: [t('Funding is what holders of a perpetual pay each other each interval to keep its price near the index: positive, longs pay shorts. It is made of the premium (how far the perpetual\'s price sits from the index) plus a clamp that holds it at a base rate while the premium stays close: 0.01 % per eight hours on Hyperliquid, Binance, Bybit, OKX and Bitget. Every rate here is per eight hours, so the base rate (dashed) and the band around it (shaded, where the premium moves while funding stays at the base rate) are the same on every venue that has them; Deribit\'s funding is continuous and has neither. The popup gives each venue\'s own interval (Hyperliquid settles every hour) and the yearly rate.'),
      t('The thick steps are funding as it settled, each over the interval it paid for, and the dashed step the one accruing now. The thin line is the premium, where the venue publishes its history (Hyperliquid each hour, Binance and Bybit per candle); OKX, Bitget and Deribit show their funding only.'),
      t('On Hyperliquid, under each hour, the share of new positions that buyers opened at market (NL/NS worked out minute by minute, as in the OI and Delta panes): up in the buy colour where buyers opened more than half, down in the sell colour where sellers did. It shows where Hyperliquid\'s minute readings and flow are held (the last day in this browser, the last week on a server, from the dotted mark), with its perpetual among the markets the OI pane counts. Measured on every Hyperliquid trade of BTC and ETH, hour by hour within a day, funding moved with that share (on BTC the premium more so, on ETH about as much), and across days more strongly; on other venues the link was not measured. It is context: whether any of it says where the price goes was not tested.'),
      t('The table reads every venue at the pointer\'s time, else the newest: beside the chart where there is room, else over its left end while you point at the pane.')],
  },
  absorption: {
    title: t('Absorption'), guide: 'trades',
    tip: t('Absorption marks: where market orders of one side met resting orders at one price for more than a threshold within 10 ms. A square below a level means passive buyers took the selling; above, passive sellers took the buying.'),
    body: [t('A dot sits on the level where it happened, and a square beside it shows the resting side: below the level when buyers waiting there took market sells, above it when sellers waiting there took market buys. Hover a square for the exchange, the fills, the largest 10 ms sum and the threshold.'),
      t('The automatic threshold is worked out for each exchange from its own trading: the mean of its 10 ms sums at one price plus a number of standard deviations, over a recent span. A busy exchange therefore needs more to be marked than a quiet one.'),
      t('A square\'s area is in proportion to the volume taken there, the largest mark in view the biggest.')],
  },
  depth: {
    title: t('Depth'), guide: 'depth',
    tip: t('Show or hide the Depth pane under the chart: total bid and ask liquidity within a chosen distance of the price, over time.'),
    body: [],
  },
  oi: {
    title: t('Open interest'), guide: 'open-interest',
    tip: t('Show or hide the Open Interest pane: how many contracts are open, and how that number changes with each candle.'),
    body: [],
  },
  candles: {
    title: t('Chart type'), guide: 'chart',
    tip: t('How the map draws the price: candles, outline candles, OHLC bars or a line, from the Chart type button after the timeframes, lit while the price is drawn. Hidden takes the price off the map, so the heatmap and the trade bubbles show with nothing on top.'),
    body: [t('Pointing at a row of the Chart type menu shows it on the map before it is chosen, and Hidden keeps the type for when the price comes back. The menu\'s last row, Candle colours, gives rising and falling candles a body, border and wick colour of your own; a part left at the theme\'s colour follows the theme.'),
      t('Zoomed out until the candles would be thinner than two pixels, the chart draws longer ones (4h, 1d, up to a week) made of the same candles and the exchange\'s history, and the legend names their length; a candle clicked to place an anchor is the one drawn. A line chart stays a line.')],
  },
  footprint: {
    title: t('Footprint'), guide: 'footprint',
    tip: t('Zoom in on the candles to see the trades behind them: at each price, how much was sold (left number) and bought (right number). Bars mark prices where one side clearly dominated.'),
    body: [t('Every row has a bar as long as its volume, in the colour of the side that traded at least 1.15 times the other there, grey where neither did; the panel\'s Bar width sets how length follows volume. A diagonal imbalance compares across rows, as footprint traders read it: a row\'s sells against the buys one row up (while the bid is at one price, the offer is a row above it), and its buys against the sells one row down. Where one is at least the ratio times the other (3 by default), that half of the row is outlined in its side\'s colour; hover a row for the ratio.'),
      t('Imbalances are read on the rows shown, and the rows grow as you zoom out, so zooming changes which rows stand out. The ratio, the minimum size and the number of stacked rows are the bar statistics\' too, so the strip under the map counts what the cells show.'),
      t('In its panel, a closed candle\'s stacked imbalances can run on as a zone (green from buys, below as support; red from sells, above as resistance) until a later candle trades into it, and its busiest row as a dotted line while no later candle has traded through it (an untouched, or naked, point of control).'),
      t('Count (in its panel) chooses whose market orders are added together: every market switched on (Aggregated), the chart market, or Chosen markets, ticked in a list whatever the venue chips and the Spot / Perp filter say. A choice is an exchange and a kind (Binance perpetual, Coinbase spot), so a layout made on one coin picks the same exchanges\' markets on another; one the coin is not listed on counts nothing, and with none ticked nothing is counted.')],
  },
  lt: {
    title: t('Liquidity Tracker'), guide: 'lt',
    tip: t('Show or hide the Liquidity Tracker pane: one line for bid liquidity and one for ask liquidity near the price, so you can see which side is thickening.'),
    body: [],
  },
  mirror: {
    title: t('Mirror'), guide: 'mirror',
    tip: t('Hover comparison: pointing at the order book, the profile column or the liquidation column compares what stands between the price and your pointer with the equal stretch on the other side, and says which side has more. Nothing changes until you hover.'),
    body: [],
  },
  volume: {
    title: t('Volume'), guide: 'chart',
    tip: t("Volume bars along the bottom, split into bought and sold at market: where the recording reaches, every exchange on in the Spot / Perp filter; before it, the chart's own candle, outlined (Binance's quote volume and trades as reported, others at the typical price, ≈). Hover a bar for its shares and delta, a recorded one for its market orders and their average size. Unusually large ones are stronger (Highlights)."),
    body: [],
  },
  bubbles: {
    title: t('Trades'), guide: 'trades',
    tip: t('Large market orders as bubbles (the fills of one order added together): green for buys, red for sells, the area in proportion to the size, the largest in view the biggest. Hover one for its venue, size and price.'),
    body: [t('Live trades draws every market order as it arrives, as a small dot at its own exchange\'s price: the exchanges trade a little apart, so their dots run in parallel bands. Where dots crowd together their volume adds up, coloured by the side that traded more there. A line runs through the chart market\'s orders (dashed before this page opened, from its prices a second), and the candles turn hollow so nothing hides behind them. New orders flash briefly as they come in.'),
      t('Live trades are kept in this page\'s memory only, from when it opened (a dotted line marks where they begin, and any gap): a reload starts empty, and the oldest go after about an hour and a half of busy trading. The bubbles are recorded as before.')],
  },
  liquidations: {
    title: t('Liquidations'), guide: 'trades',
    tip: t('Positions the exchanges closed by force, as diamonds where the market was: in the sell colour where longs were closed, the buy colour where shorts were, the area in proportion to the size. Hover one for the exchange, the size and the prices.'),
    body: [t('A liquidation is a market order the exchange placed to close a position whose margin ran out, so it is also among the trade bubbles and in the Range panel\'s volume; the diamond says it was forced.'),
      t('Binance, Bybit, OKX and Deribit publish their liquidations; Binance only its largest each second, so a cascade there shows fewer than happened. Hyperliquid, Coinbase and the other exchanges publish none.'),
      t('Bybit reports the price at which the position\'s margin was gone, which can be some way from where the market traded; the diamond is drawn at the price trading when it happened, and the box gives both.')],
  },
  liqLevels: {
    title: t('Liquidation levels'), guide: 'liq-levels',
    tip: t('Where Hyperliquid\'s open BTC positions would be liquidated, from HyperTracker\'s snapshots: longs below the price in the falling colour, shorts above it in the rising one. A level goes once price trades through it.'),
    body: [t('Each row adds up the positions whose liquidation price lies in it, in $10 steps, from HyperTracker\'s snapshots of every open Hyperliquid BTC position, about one every half hour (Powered by HyperTracker). A darker row holds more; a crisp edge marks the strongest, and a diamond a row where one position holds at least half.'),
      t('A snapshot describes the positions about 40 minutes before it can be read, and every level price has traded through since then is gone, even if that happened before the page was opened. Positions opened since come with the next snapshot.'),
      t('They are drawn as a stripe right of the newest candle, so the heatmap keeps its own colours, and their own column beside the profile column adds them up: in each row what still stands, and a curve of everything from the price out to each price, the dollars that go if price gets there. On a computer, point anywhere on the map and the column reads the curve at that price; hover the column itself to compare the longs below with the shorts as far above.'),
      t('Only Hyperliquid\'s positions are known, and only for BTC. A trade can reach a level a few basis points before the mark price that liquidates it, and a position can be closed or topped up before price gets there, so a level is where forced orders could start, not a promise that they will.'),
      t('Point at the line between the liquidation column and the profile column to weigh the book against the liquidations: what rests against what would be liquidated on each side, how level size and book size rank together, and whether the book stands as a wall or thins to a void at the largest levels.')],
  },
  highlights: {
    title: t('Highlights'), guide: 'highlights',
    tip: t('What stands out: unusual volume, open-interest changes and depth imbalance'),
    body: [],
  },
  sounds: {
    title: t('Sounds'), guide: 'sounds',
    tip: t('Sounds for large market orders by size tier, a chime on unusual volume, and one rare event per pane if you choose it. Browsers play sound only after a click on the page.'),
    body: [],
  },
  range: {
    title: t('Range'), guide: 'range',
    tip: t('Range: drag across the map or a pane under it to see what traded there: market buys and sells, the orders behind them, where they were filled, the absorption and the resting orders. Ctrl+drag (Cmd on a Mac) selects at any time.'),
    body: [t('Drag across the map for a box (a stretch of time and a band of prices), or across a pane under the map or the flow column for a stretch of time at every price. A selection covers the whole minutes it touches; one that reaches the present stays live and is added up again every few seconds.'),
      t('Each pane under the map has its own Range button in its header, the dashed box before its menu: press it, then drag across that pane to sum it up in its terms (it lights while it waits for the drag and while the panel shows that pane). The panel opens beside the selection, and stays where you drag it.'),
      t('Everything is about the exchanges switched on inside the Spot / Perp filter, except open interest, which only perpetuals have: it is the OI pane\'s, whatever the filter says. An order is counted at the price it started at, in the minutes recorded since orders were counted by price; the average order is the volume of those minutes over their orders.'),
      t('Every market order fills resting orders on its own exchange, so the prices that took the most are where the resting orders were that absorbed them. The absorption marks and the resting orders are the ones the map draws.'),
      t('On a narrow band the average order leans: a sweep that began inside the band and ran out of it counts here with only part of its volume, one that began outside counts its volume here without the order.'),
      t('A drag across the Open Interest pane holds whole candles and sums up that pane in its own terms: the known change and the line\'s level, what NL/NS estimates was added and reduced, each venue\'s part, and how the stretch compares with the ones held. Show at the top of the panel switches between the map\'s summary and the pane\'s for the same stretch.'),
      t('A drag across the Delta pane does the same in its terms: the recorded taker flow (bought, sold, the delta and its share of the volume), the price over the same candles, the CVD inside a daily or weekly run, how the delta was spread, and with NL/NS the estimated added and reduced.'),
      t('A drag across the Bar stats pane sums up the statistics chosen there, each by its own rule: volumes, dollars and counts added up, ratios worked out from the sums (never averaged candle by candle), the point of control of all the rows together, each CVD\'s change, the marks counted kind by kind, and how much of the stretch the recording holds. A point of control\'s move is per candle only and says so.'),
      t('A drag across the Long/Short pane sums up each venue on its own, grouped by who it counts: its first and last long share and the change in percentage points, the lowest and highest drawn, the time mean, how long the long or the short side was the majority and the longest unbroken stretch, and how much of the stretch its readings cover; venues of one kind are also compared over the moments all of them are drawn, each against itself, with the gap between the highest and the lowest. No share of all venues is given: their populations differ.'),
      t('A drag across the Funding pane sums up the venue it shows: each settlement counts for the interval it paid for, giving the first and last rate per 8 hours and the change in basis points, the lowest and highest, the rate over time, and how long longs or shorts paid; time no settlement covers is said apart (before the loaded history starts, after the newest settlement held, or none held). The funding accruing now is shown apart and not counted, the premium by its completed readings and how many sat in the band where funding holds its base rate, and on Hyperliquid who opened, from the closed hours added up. It gives no amount paid.'),
      t('A drag across the Scripts pane sums up each script drawn there, each of its visible plots of one value a candle in its own values: the first and last value and the change, the lowest and highest, and how many candles had a value, over the closed candles of its last run. Nothing is added up and no unit is named, as a script declares neither; candles, bars and bands are named but not summed up yet, and marks are counted.'),
      t('A drag across the Liquidity Tracker pane sums up its weighted bids and asks over the windows that hold every venue counted, each window counting for the time it overlaps the selection: the time mean, first and last, and the lowest and highest of each side, the mean of the windows\' imbalances and how long bids or asks were heavier. A window missing a venue is left out and said, so the set of venues stays the same, as are an open window and time no window covers.'),
      t('A drag across the Depth pane sums up each band over the columns drawn at this zoom, each counting for the time it overlaps the selection: the mean bids and asks and the first and last column, and the watched band\'s mean imbalance. Only columns holding every venue\'s book are measured; bands are never added together. With Liquidation levels it gives the snapshots in force, when their positions stood and were fetched, and each band\'s first and last levels: potential liquidations, not liquidations that happened.')],
  },
  heatmap: {
    title: t('The heatmap'), guide: 'heatmap',
    tip: t('Each coloured cell is liquidity resting at a price at a moment: warmer and brighter means more.'),
    body: [t('Colour shows size on a log scale, so a few huge walls do not hide everything else. The Contrast slider moves the colour window: right shows thinner liquidity, left keeps only the biggest walls. Auto keeps the window following the data.'),
      t('It is recorded while this page is open: there is no way to fetch what the order books looked like in the past, so the map starts at the moment you opened the page and grows to the right, from a dashed line that says when the recording began.')],
  },
  depthPane: {
    title: t('Depth pane'), guide: 'depth',
    tip: t('Total liquidity within nested distances of the price, over time: the narrowest band strongest at the centre, the widest lightest. Asks point up (pink), bids point down (green).'),
    body: [t('For every moment it adds up the bids and the asks within each band of the price (Bands: Balanced doubles from ±0.31 % to ±5 %; Near, Wide or your own) and draws them as rings, asks up and bids down: each band holds the ones inside it, and the widest band\'s edge is outlined. Scale Detail draws the square root of the money, so a thin inner band shows; Units counts the coin instead of dollars.'),
      t('Venues chooses whose order books the pane adds up: every venue switched on inside the Spot / Perp filter (the default), the chart market\'s own book, or Chosen markets, ticked in its panel (Choose…) whatever the venue chips and the filter say. The Depth pane and the Liquidity Tracker share the choice, and their sounds count the same books.'),
      t('The table reads every band at the pointer\'s time, else the newest: beside the chart where there is room, else over its left end while you point at the pane. Click a row to bring that band forward: it is drawn with the bands inside it at its own scale, and the header and Highlights read it.'),
      t('When one side of the band brought forward (else the widest) is unusually larger than the other over a candle, compared with the candles before it (see Highlights), that side\'s edge is drawn thick across the candle. Zooming and panning do not change it; on a fine timeframe zoomed far out (more than about 500 candles on screen) each pixel column is judged instead. It answers: is there more resting liquidity above or below, and is that changing?'),
      t('Source Liquidation levels adds up the same bands for the liquidation levels of Hyperliquid\'s BTC positions instead: longs that would be liquidated below the price, shorts above, from HyperTracker\'s snapshot about every 30 minutes (the positions are some 35 minutes older), each snapshot standing until the next. Its bands are its own, Wide by default, since these levels sit further from the price than resting orders. It shows where that money sits, not what will be liquidated or where the price will go.'),
      t('The Sound box plays a slow, low swell when, over a recorded minute, the balance goes further one way than in all but the rarest minutes of the hours before: by default the 99th percentile of six hours, within 20 % of the price. The Sounds panel sets the range, how rare and how many hours.')],
  },
  oiPane: {
    title: t('Open interest'), guide: 'open-interest',
    tip: t('Open interest is the number of contracts currently open (not volume). The line is its level, the small bars below are its change per candle.'),
    body: [t('Open interest counts the contracts that exist right now. It rises when new positions are opened and falls when positions are closed. It does not say who is long or who is short.'),
      t('By default (Venues) the perpetuals of every venue switched on are added together, in coins: Binance, Bybit, OKX, Bitget, Deribit and Hyperliquid. Binance and Bybit publish days of history and OKX a day or two; the others only a reading now and then, so their part builds up while they are recorded. A candle\'s change is each venue\'s own change added up, so a venue whose readings start or stop is not counted as positions opened or closed. With The chart market, a labelled reference market stands in when the market on screen has no open interest.'),
      t('With venues added together the line is drawn from those changes too: it ends at the venues\' total now and steps back by each candle\'s change, so it moves exactly as the bars do. Where some venues had no reading yet it is dashed.'),
      t('Zoomed out further back than the readings held (the chart\'s last 500 candles), the line goes on faint and dashed from Bybit\'s own history, which reaches back years, scaled to meet the line where it starts. Bybit is one venue of several, so this part is an estimate of the total (≈), drawn without change bars. It is there while Bybit\'s perpetual is among the markets added together.'),
      t('Venues can also be Chosen markets: the perpetuals ticked in its panel (Choose…, or Markets… in the Delta pane with NL/NS shown), added together whatever the venue chips and the Spot / Perp filter say. NL/NS and the Long/Short pane count the same markets. With none ticked, nothing is counted.'),
      t('Bars on NL/NS (the default) splits each change bar by who made it: a rise into the new longs (buy colour) and new shorts (sell colour) it held, a fall into the shorts closed (buy colour) and longs closed (sell colour), lighter because closed; each part takes as much of the bar as its share of what opened or closed, and grey is what went to no side. It is the Delta pane\'s NL/NS, worked out minute by minute where the minute readings reach, and an estimate: tested against the moves that followed, it is context, not a signal (the Delta pane\'s Four parts shows every part of each candle at full height). Net colours the bars by whether open interest rose or fell. The few changes much larger than all the others are cut at the band\'s edge with a gap across them, so the rest keep their proportions, and each one\'s popup gives its size.'),
      t('The table reads every venue at the pointer\'s time, else the newest: beside the chart where there is room, else over its left end while you point at the pane.'),
      t('In each NL/NS bar the side that made the change is drawn stronger and the other fainter, the more one-sided the more. Drag across the pane with Select armed, or Ctrl+drag (Cmd on a Mac), to sum up a stretch of its candles in the Range panel.')],
  },
  ltPane: {
    title: t('Liquidity Tracker'), guide: 'lt',
    tip: t('Two lines: how much bid and how much ask liquidity sits near the price, weighted so that what is closest counts most.'),
    body: [t("LT-Bid and LT-Ask are the USD size on each side of the books counted (Venues), each venue measured from its own best bid and best ask and the venues then added up: they do not trade at one price (spot in USDT sits a few basis points above the perpetuals, spot in USD below them). A level counts fully at the touch and half as much for every half-life further away (measured in basis points), so thin, distant orders barely move the line."),
      t('Venues chooses whose order books the pane adds up: every venue switched on inside the Spot / Perp filter (the default), the chart market\'s own book, or Chosen markets, ticked in its panel (Choose…) whatever the venue chips and the filter say. The Depth pane and the Liquidity Tracker share the choice, and their sounds count the same books.'),
      t('Bid above ask means more support close under the price than resistance above it. Switch the view to imbalance to see (bid - ask) / (bid + ask) as one line between -100 % and +100 %. The options set the half-life, the smallest and largest bin that counts, and whether to average per level.'),
      t("Each minute is measured at every sample the recording takes, so zooming out shows the average of its minutes, not a different measure. ≈ before the numbers means part of the line was worked out from the minutes' average books instead: when a size filter is set, or for minutes recorded before the tracker was kept. That is an estimate, rougher the further you zoom out."),
      t('The table reads each venue at the pointer\'s time, else the newest: its weighted bids and asks, their imbalance and its share of the two lines, beside the chart where there is room, else over its left end while you point at the pane. The venues with the most liquidity on average over the chart in view get a row each; the rest are added up in the last row. With Per level each row is that venue\'s own average, with no share.')],
  },
  stats: {
    title: t('Bar stats'), guide: 'bar-stats',
    tip: t('A table under the chart: one row per statistic, one cell per candle (volume, delta, cumulative delta and more). Press Stats in its header to choose the rows.'),
    body: [t('Each row is one statistic, one cell per candle, shaded by size. The defaults are volume, delta (buy volume minus sell volume) and cvd (the running sum of delta).'),
      t('Press Stats to add statistics such as the point of control, stacked imbalances or market orders by size. These come from the executions recorded while the page was open, so they start empty and fill with time.'),
      t("It has its own switch and counts the markets the footprint counts (set in either panel). Its point of control and imbalances are read on rows of the size its header shows: the footprint's at this zoom, whether the footprint shows or not."),
      t('The View column, right of the table under the price axis, gives each row over the candles in view: a sum, the newest value of a running sum, or a figure worked out from those candles added together. Point at it to see which.'),
      t('Rows read from the candles and open interest (range, close in range, vol / bp, oi chg, candle delta) fill the candles before the recording too. Rows read from executions are drawn faint where the recording holds only part of a candle (rec % says how much). Order flow picks the rows an order-flow reading starts from; Export CSV saves the candles in view.'),
      t("Click a candle to pin it: a card lists every statistic for that candle until it is clicked again or Esc is pressed. Shift+click pins more candles to compare them side by side (up to five). Cells can be shaded by how unusual each candle is against its own recent ones (Unusual, the Highlights' baseline) or drawn as lines, and rows can be grouped by kind under headers that fold away. CVD from each day's start makes the running sums start again at every day in the chart's time zone.")],
  },
  cvd: {
    title: t('Flow'), guide: 'flow',
    tip: t('The taker-flow column left of the map: for every exchange, how much was bought and sold at market over time (cumulative volume delta), spot in blue and perpetual in amber, biggest exchanges first. The top row adds them all.'),
    body: [t('Passive liquidity (the heatmap and the book) is what traders have placed and may pull; flow is what they have actually done. A line rising means buyers are lifting offers faster than sellers are hitting bids.'),
      t('Rows are ranked by volume over the window you choose and re-ranked now and then. Every line has its own scale, so compare shapes, not heights. The labels are on the left so that the ends of the lines stay clear. Hover a row for its numbers; the gear sets how many exchanges, how tall each row is and when the order changes.'),
      t('A small triangle on a line marks a burst: in ten seconds that exchange bought (up) or sold (down) far more at market than it usually does, judged against its last half hour, and at least the smallest burst. Only bursts seen while the page is open are marked, so a reload clears them. The marks are off until switched on in the gear, which also sets how big and how unusual a burst must be.')],
  },
  trades: {
    title: t('Trades'), guide: 'flow-trades',
    tip: t('The flow column\'s second view: what was bought and sold at market, a block of time per row (a second at first) or each order, newest on top. It holds what this page received and the history it already read, and asks the exchanges for nothing.'),
    body: [t('Each block shows its time and, under it, how far the reference market\'s price moved. Then the dollars bought (▲) over the dollars sold (▼), each with a bar split by exchange, and the largest buy and the largest sell.'),
      t('A bar grows with the square root of its dollars, full at about the busiest one percent of blocks in a week: a side ten times larger draws about three times longer, and › marks one past full.'),
      t('Group by sets what a row is: each order, a second, a minute, five or fifteen minutes, or a length of your own. The size menu leaves out smaller orders before they are added up. Older blocks come from what the page already holds: any size from its per-second record, from $25,000 from its recording, smaller sizes only from when it began listening.'),
      t('In Each order, a bar after the price grows with the square root of the order\'s dollars: full at about the largest order in ten at that size floor ($50,000 from $1,000), a mark past it. The box beside a row gives its scale.'),
      t('Point at the list, or the details beside it, to hold it still, and move away to let it go (scrolled back, it stays); a key at its foot counts what came meanwhile and brings it back to now. The block you point at is marked on the map and the panes, and a click chooses it for the details beside a wide list and takes the map to its time. On a phone a tap opens its details.')],
  },
  book: {
    title: t('Order book'), guide: 'order-book',
    tip: t('Show or hide the order book column at the right of the map.'),
    body: [],
  },
  candlePane: {
    title: t('Tape'), guide: 'phones',
    tip: t('Every trade since the page opened, filling a phone screen: what traded at each price, the order book on both sides, large orders flashing on the rail as they arrive, and the last seconds of trades flowing left behind them.'),
    body: [t('The tape starts when the page opens and runs for as long as it stays open: nothing is fetched first, so it opens at once, and no timeframe ever starts it again. Each row is a price: sold at market on the left, bought on the right, by every market counted, its winning side shown more strongly the more it won, and the row where the most traded is outlined. The header says since when the tape runs, how many markets it counts, and how long the page was hidden: a phone in the background gets no trades, so that time is missing from the tape. Bids rest left of the tape, asks right.'),
      t('The rail at the right lights each row where a large order just arrived, by when it arrived, with the mark of the exchange that sent the largest. The trail is every market order of the last seconds at the time it traded, now at the rail and older to the left: filled dots are buys, rings are sells, larger dots larger orders, and orders from the whale size up carry their exchange\'s mark. Glass lays the book and the tape over the trail as three pieces of glass welded together: the trail shows through the book clearly and through the tape frosted. Bricks makes each of the book\'s bars a block of glass. Drag to move the prices, pinch to zoom, double-tap to reset. Look, in Settings, changes how the trail is drawn, not what it shows.'),
      t('On glass the book follows its liquidity: a row lights up when orders are added there, a shock running out along it, and dims when they are pulled, the shock running back in; a ripple runs along a row when trades reached it. Where the price passed and no trade shows, nothing is called pulled. A large order sends a wave through the glass from where it arrived, slowed by the panes and turned back at the welds. Rows and Pulses, in Settings, change how the rows and these changes are shown.')],
  },
  script: {
    title: t('Scripts'), guide: 'scripts',
    tip: t('Your own indicators, written as scripts over the candles and the taker flow: on the map, or in rows of their own under it.'),
    body: [],
  },
  scriptPane: {
    title: t('Scripts'), guide: 'scripts',
    tip: t('Your own indicators, written as scripts over the candles and the taker flow.'),
    body: [t('A script is a short program that is run once for each candle of the chart, oldest first, and draws lines, bars or bands from what it reads: the candle, what was bought and sold at market over the exchanges of the flow column (or the ones it names with source), and the liquidations. Each script has a row of its own here, with its own scale.'),
      t('Write one, paste one or start from an example in Scripts…. The language is the one indicator scripts are written in on other charting pages, so most such scripts run here as they are; Scripts… lists what is not supported. A script runs on a thread of its own and can read nothing but those inputs: no page, no network, no storage.'),
      t('The taker flow is what the page holds (a day a second at a time, older minutes where the server keeps them): a candle before that reads NaN and draws nothing, and the functions carry on past it.'),
      t('A script runs again at most once a second, and less often when it is slow: four times as long apart as it takes. One that loops too long, or grows too large, is stopped and says where.')],
  },
  orderBook: {
    title: t('Order book'), guide: 'order-book',
    tip: t('The ladder: every price with the liquidity resting there, one column per venue and a bar for the combined size. Scroll over it to zoom the price step.'),
    body: [t('Each row is a price step. Pink rows above the price are asks, green rows below are bids. The coloured cells are the venues (their size at that price) and the bar on the right is the combined size, with the running total behind it.'),
      t('Mode chooses between all venues added together, one venue alone, or a compact view. Group is the price step per row: scroll over the book, or drag its price column, to change it. Hover for the Mirror comparison.'),
      t('In Compact, Venue lines draws the running total of each of the largest venues on its own, over the whole book\'s. The lines share a scale of their own, its full width the largest of them on the rows in view, so they compare with each other; the popup gives a line\'s share of the depth the books show. The venues are ranked by traded volume over the flow column\'s ranking window (a book with no trades held, by its liquidity in view) and kept for a minute; the mark beside each colour in the header names it. Most exchanges publish only part of their book (Bybit about 0.25 % either side of the price): where a venue\'s book ends, a short bar across its line marks the end and the line goes on dashed at the total it reached, since what rests beyond is not published. A book that reaches fewer than three rows from the mark gets no line and the next venue takes its place; the header\'s popup names it. Hover near a line, or its entry in the header, to see it alone with its numbers.'),
      t('Pull/stack (off by default) adds a column after LEVEL USD: how much resting liquidity each row gained (+, stacked) or lost (−, pulled) over the window chosen, from snapshots of every venue\'s book. A venue counts at a row only where its book reached the whole row at both ends, so the edge of its depth moving with the price is not taken for a pull. Rows the price reached in the window are grey: a fill takes liquidity away just as a pull does, and the two cannot be told apart. A venue that reconnects rebuilds its book, which reads as a burst of both. At the finest Group steps the column stays empty: zoom out.'),
      t('Cues light a venue\'s cell when the depth that venue shows at a price changes (the Cues button): the same strength for an addition and a decrease, the light running outward through the cell for an addition and back in for a decrease. A change is the difference between two of that venue\'s own snapshots, measured on the grid its book is merged on and only within about 6 % of the price, so a level that moves between rows because far levels are merged is not taken for a change. Small marks beside the rows keep the last change for a few seconds, and hovering a cell or a mark says what changed and how long ago. Light is limited: a very busy book lights its largest changes and the rest keep their marks. Trade contact ripples a cell when a large market order reaches it. The heat strip under a cell is the share of it that is estimated recent net increase (or its recent change), never the age of an order: the exchanges do not send one.')],
  },
};

/** Open the guide at a section. It is loaded on demand, so the page does not carry it until it is wanted. */
export const showGuide = (section?: string): void => { void lazy(() => import('./guide/guide.ts')).then(m => m?.openGuide(section)); };

/** Start the tour (the quick pass over the page; `tour/tour.ts`). It is loaded on demand, like the guide. */
export const showTour = (options?: import('./tour/tour.ts').TourOptions): void => { void lazy(() => import('./tour/tour.ts')).then(m => m?.startTour(options)); };

/**
 * The tour as the page starts it from its own controls: a top bar folded away is brought back for it, an open invitation put away. The toolbar says how
 * (`setTourStarter`), and the Guide's link takes the tour the same way (the tour alone would point at a folded bar's missing buttons).
 */
let tourStarter: (() => void) | null = null;
export const setTourStarter = (start: () => void): void => { tourStarter = start; };
export const takeTour = (): void => { if (tourStarter) tourStarter(); else showTour(); };

/** What a "?" opens: a title, its lead sentence, short paragraphs, and the section of the guide that goes further (without one, no link). */
export interface Explanation { title: string; tip: string; body: readonly string[]; guide?: string }

/** The round "?" itself, named for what it explains. */
export const questionButton = (title: string): HTMLButtonElement =>
  el('button', { type: 'button', class: 'help', textContent: '?', tip: t('What is this? {topic}', { topic: title }), ariaLabel: t('Explain: {topic}', { topic: title }) });

/** Write an explanation into `body`: its lead sentence, its paragraphs and, where the guide goes further, the way there. */
export function explain(body: HTMLElement, topic: Explanation): void {
  body.classList.add('help-body');
  body.append(el('p', { class: 'lead', textContent: topic.tip }));
  for (const paragraph of topic.body) body.append(note(paragraph));
  const guide = topic.guide;
  if (guide !== undefined) body.append(el('button', { type: 'button', class: 'more', textContent: t('More in the guide →'), onclick: () => { showGuide(guide); } }));
}

/** Open an explanation in a panel of its own beside `anchor`, or close it when it is the one open there. */
export const toggleExplanation = (anchor: HTMLElement, topic: Explanation): void => { togglePanel(anchor, { title: topic.title, width: 340, align: 'left' }, (_tools, body) => explain(body, topic)); };

/** A small "?" button that opens the explanation of `id`; the panel closes with Esc, a click elsewhere, or the same button. */
export function helpButton(id: HelpId): HTMLButtonElement {
  const topic = HELP[id];
  const button = questionButton(topic.title);
  const fill = (body: HTMLElement): void => explain(body, topic);
  // A panel draws its tools again on every change; the new "?" shows as open while its text is still showing below it.
  queueMicrotask(() => { if (button.closest('.panel')?.querySelector(`.help-inline[data-topic="${id}"]`)) button.classList.add('open'); });
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
    toggleExplanation(button, topic);
  };
  return button;
}
