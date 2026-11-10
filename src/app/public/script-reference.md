# LiquidityMapperFast script language (version 2)

Scripts are the indicators people write for LiquidityMapperFast, a liquidity heat map that runs in the browser. This is the whole language, for people and for AI assistants. A machine-readable form is at https://liquiditymapperfast.github.io/scripts.json.

To write or fix a script with an assistant: open the script in the Scripts panel (the ≡ beside Scripts in the Chart deck), press Copy for AI, paste into the assistant, paste its answer back and press Check, then Save. The copied text carries the script, its errors with their codes, and what it last drew.

## Rules

- A script is JavaScript-shaped code run once for each candle of the chart, oldest first, drawing plots from what it reads.
- Statements: var, let, const, if / else, for (;;), while, do ... while, break, continue, function name(...) { ... }, return; expressions as in JavaScript, arrow functions and ternaries included. As in JavaScript, a line break ends a statement only where the next line cannot carry it on: x = 1 followed by a line + 2 is x = 3, and a line that starts with ( or [ carries on the line before it. Two statements on one line need a semicolon; end a statement with one when the next line starts with an operator or a bracket.
- A name assigned without var, let or const anywhere in the script (x = ...) keeps its value from candle to candle and starts at 0; x[1] is its value one candle back (x[n], n candles back; the first candle reads itself). Such names are one name whatever their case. A var, let or const starts again each candle.
- Plot calls, option(...), source(...) and alert(...) take named arguments: line(x, title="CVD", color=red, lineWidth=2); a bare word as a named value is a text (title=CVD). Every other function takes its arguments by position only, and ignores a named one: write sma(x, 20), not sma(x, length=20).
- A plot's named arguments are its style, read once, at its first call: what changes from candle to candle goes in its values, by position or in a point object (a mark's text, tip and colour: mark(v, text, tip, colour) or mark({value: v, text: t, color: c}); a line's colour: line({value: x, color: c})).
- Plots are line, area, histogram, baseline, candlestick, plotbar, cloudarea, brokenarea, mark (each also as plotline, plothistogram, ...). Each takes title=, priceScaleId=, scaleMargins={top: 0.1, bottom: 0.1} and visible=, and the style its kind reads (see Plots: a candlestick has upColor and downColor, not color); a kind ignores the style it does not read. lineWidth is 1 to 6; lineStyle is 0 solid, 1 dotted, 2 dashed, 3 long dashes, 4 sparse dots. A point can be an object: line({time: time, value: x, color: c}) colours that candle's point.
- A script draws in a row of its own under the map, or on the map, where plots on the default price scale (priceScaleId right) stand at their prices and the others on scales of their own; the Draw setting in its panel chooses. $price.color colours the map's candles.
- A candle whose flow is known neither from the recording nor from Binance's own candles, or whose liquidations were not recorded (no candle reports them), reads NaN: the functions skip it (they do not take it as 0) and a plot draws nothing there. Use nz(x) where 0 is meant.
- Each call of a function with a history (sma, ema, cum, ...) keeps its own: call them at fixed places, not in a loop over windows (a loop would share one).
- Lengths may be any expression (sma(x, options.length)); a window shorter than its length uses the values there are.

## Inputs

| Name | What it is |
|---|---|
| `time` | The candle's start, in seconds since 1970 (UTC). |
| `vbuy` | Dollars bought at market (taker buys) in the candle, over the markets the script reads (see source). Where the page did not record the flow (before it was opened, or in a gap), the candles of the Binance markets among them say it, spot and perpetual added up, as far back as the script reads (Binance's candles report who bought; no other exchange's do): those markets only, not all of them, so the numbers are smaller there; bar.recorded tells which. NaN where neither is known (a set with no Binance market, or a Binance candle not read). |
| `vsell` | Dollars sold at market (taker sells) in the candle, likewise. |
| `lbuy` | Dollars of short positions liquidated in the candle (bought back by force), over the markets the script reads. |
| `lsell` | Dollars of long positions liquidated in the candle (sold by force). |
| `oichg` | Dollars of open interest opened (+) or closed (-) in the candle, over the perpetuals the OI pane adds up (its Venues setting), at the candle's close; NaN where open interest was not read. source(...) does not change it. Also bar.oichg. |
| `cbuy` | Trade counts are not recorded here: cbuy and csell always read NaN. |
| `csell` | See cbuy. |
| `$price` | The chart's candle: $price.open, .high, .low, .close, .volume (the chart market's own volume, in coins), .time (seconds). Setting $price.color = "<colour>" colours the map's candle. |
| `bar` | The same candle and flow as one object: bar.open, .high, .low, .close, .volume, .vbuy, .vsell, .lbuy, .lsell, .oichg, .timestamp (seconds), and .recorded: 1 where vbuy and vsell were recorded on this page, 0 where they come from the Binance markets' own candles, NaN where neither is known. |
| `renderer` | renderer.length is the number of candles so far, this one included; renderer.timestamp the candle's start (seconds), renderer.timeframe its length (seconds); renderer.forming is true on the candle still under way (the newest, until it closes) and false on every closed one. |
| `theme` | The page's colours, read-only: theme.dark (whether the chart's background is dark), theme.background, theme.text, theme.up and theme.down (its candles' colours), as colour texts. A script coloured from them follows the theme the person picks, and runs again when it changes. |
| `options` | options.name is the value of the option called name (declared with option(...) or set in the panel). |
| `fns` | fns[k] is the k-th call of a function that keeps a history (sma, ema, cum, ...), counted in the order they are written; fns[k].state = {} starts it again. |

## Other names

| Name | What it is |
|---|---|
| `option(...)` | Declares a setting shown in the panel: name = option(default=14, type=number\|color\|checkbox\|text\|list\|range, label="...", min=, max=, step=, options=[...]). |
| `source(x, ...)` | Reads x over a set of markets: source(vbuy, type=spot\|perp, exchange=BINANCE, quote=USDT). Several values in one filter: exchange=BINANCE+BYBIT. Without source, x reads over the flow column's ALL VENUES markets. |
| `askdepth(usd) / biddepth(usd)` | The price at which usd dollars of the order book are passed going out from the candle's close: askdepth up through the asks, biddepth down through the bids, over every book the heat map adds up (source(askdepth(x), exchange=BINANCE) reads some of them). Each candle's book is the one the page recorded at its close: its last minute (a minute is the mean of the samples taken in it), or the latest minute recorded inside the candle where its last was not (never another candle's); the candle under way reads its minute under way. Each recorded bin's dollars are spread evenly over its prices. The close for 0; NaN for a size that is not a number or below 0, where no book of the set was recorded for the candle (before the recording, which reaches a day back in a browser and a week on a server, or more than 1,000 candles back), and where the books hold less than usd on that side. askdepth(x) - close is how far a market buy of x dollars would have moved the price had the book stood still. A server from before reads each candle's book averaged over the candle instead (depthatclose() is false there): a price a candle with a move in it went through held bids part of the time and asks the rest, so the side the price came from reads thin; depthabove and depthbelow do not have that. A call walks the book's bins out to the size: a few steps for most sizes, more for one far into the book. |
| `depthabove(usd) / depthbelow(usd)` | As askdepth and biddepth, over every dollar recorded at each price, bids and asks alike: the price at which usd dollars of the book are passed going up (down) from the close. At a candle's close nearly the same as askdepth (biddepth): they differ in the bin that holds the close, and where the price moved within the last minute, whose prices held some of the other side's orders too. Where the books are averages over the candle (a server from before), the band that reads the book's usual depth instead of a side the averaging thinned. |
| `depthatclose()` | Whether the books read at this candle are their books at its close (true), as the page and an up-to-date server record them, or averages over the candle (false: a server from before); NaN where no book of the set has depth for the candle. It says how the book was sampled, not how fresh it is: where a candle's last minute was not recorded, its latest recorded minute stands in. The Depth bands example reads askdepth and biddepth where it is true, depthabove and depthbelow where not. |
| `depthbooks()` | How many order books of the set read (see askdepth) have their depth recorded for the candle: 0 where none was. |
| `alert(text, sound=, when=)` | An alert: the page lists text and makes a sound, through its Sounds switch (off: nothing happens) and the cap on how many alerts come at once. Only the candle under way and the last closed one alert; each call alerts once a candle, never for what was already there when the script started, and one call at most every 20 s. sound is chime (the default), rise, fall, tick or none (listed, silent). when=bar (the default) alerts as soon as the call runs in the candle; when=close once the candle has closed with the call made. A replay never alerts. |
| `nz(x, y)` | x, or y (default 0) when x is NaN, undefined or null. |
| `na(x)` | Whether x is NaN, undefined or null. |
| `rgb(r, g, b) / rgba(r, g, b, a)` | A colour text. Colours are also CSS texts ("#ff9900", "rgba(0,170,140,0.5)") or names (red, teal, transparent, ...). |
| `Math` | abs, max, min, sqrt, pow, log, log10, log2, log1p, exp, expm1, floor, ceil, round, trunc, sign, cbrt, hypot, sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, random; PI, E, LN2, LN10, LOG2E, LOG10E, SQRT2, SQRT1_2. |
| `Number, String, Boolean, Array, Object` | In part as in JavaScript: Number(x), Number.isFinite, Number.isNaN, Number.isInteger, Number.parseFloat, Number.parseInt and its constants (EPSILON, MAX_SAFE_INTEGER, ...); String(x), Boolean(x); new Array(n), Array.isArray, Array.from; Object.keys, Object.values. Texts have slice, substring, toUpperCase, indexOf, includes, split, replace (plain text), padStart, ...; arrays have push, pop, slice, splice, concat, indexOf, join, map, filter, reduce, find, some, every, sort, ...; numbers have toFixed and toPrecision. |
| `Date` | Date.now() and Date.UTC(year, month, day, hours, minutes, seconds) give milliseconds since 1970 (month 0 is January). new Date(ms) takes one number of milliseconds (or a date), not a text and not a year and a month: write new Date(Date.UTC(2026, 0, 1)), or new Date(time * 1000) for the candle. A date has getTime, toISOString, getUTCFullYear, getUTCMonth, getUTCDate, getUTCDay, getUTCHours, getUTCMinutes, getUTCSeconds, and the same without UTC in the browser's time zone. |
| `isFinite, isNaN, parseFloat, parseInt, Infinity, NaN, undefined` | As in JavaScript, except that parseInt reads base 10 unless given a base: parseInt("ff", 16) is 255, and parseInt("0x10") is 0, not 16. |

## Functions with a history

Each call in the text keeps its own history.

| Call | What it gives |
|---|---|
| `cum(x)` | The running sum of x since the first candle. |
| `sum(x, length)` | The sum of the last length values of x, this candle included (fewer while fewer exist). |
| `sma(x, length)` | The average of the last length values of x (of those there are, while fewer exist). |
| `cma(x, length)` | The average of x and the function's own last length - 1 answers (an average of itself). |
| `ema(x, length)` | The exponential average: each value weighs 2 / (length + 1); the first value starts it. |
| `rma(x, length)` | The running (Wilder) average: each value weighs 1 / length. |
| `highest(x, length)` | The highest of the last length values of x, this candle included. |
| `lowest(x, length)` | The lowest of the last length values of x, this candle included. |
| `linreg(x, length)` | The least-squares line over the last length values of x, at this candle. |
| `last(x, length)` | The oldest of the last length values: x as it was length - 1 candles ago once there are that many (last(x, 2) is the candle before). |
| `stoch(close, high, low, length)` | Where close stands between the lowest low and the highest high of the last length candles, 0 to 100. |
| `pivot_high(x, left, right)` | A swing high: the value right candles ago when it is higher than the left before it and the right after it, else NaN. |
| `pivot_low(x, left, right)` | A swing low, likewise. |
| `avg(a, b, ...)` | The average of the values given, the elements of an array given counted one by one. Each is made a number as Number(x) would (true is 1, null 0, "9" 9); those that come out NaN or infinite (undefined, a text that is not a number) are left out. |
| `avg_ohlc(bar)` | The chart's candle as {open, high, low, close}, for candlestick(...). |
| `avg_ohlc_with_gaps(bar)` | The same as avg_ohlc. |
| `avg_close(bar)` | The chart's close. |
| `heikinashi(bar)` | Heikin-Ashi candles of the chart's: the close is the average of the four prices, the open the middle of the previous one. |
| `avg_heikinashi(bar)` | The same as heikinashi. |
| `ohlc(x)` | A candle of a value: it opens where the previous candle of x closed and closes at x. |
| `cum_ohlc(x)` | A candle of a running sum: it opens where the sum stood and closes with x added (a CVD candle). |
| `interpolate(ratio, colour1, colour2, ...)` | The colour at ratio (0 to 1) along the colours given. |

## Plots

Every kind also takes title, priceScaleId, scaleMargins, visible; the style keys of the other kinds do nothing in it.

| Kind | Calls | Fields of a point | Style it reads | What it draws |
|---|---|---|---|---|
| line | `plotline(...)`, `line(...)` | value | color (or lineColor), lineWidth, lineStyle, lineType (0 straight, 1 steps) | A line through one value a candle; with lineType=1 each value is a level across its own candle, joined straight to the next (a value on one candle alone draws its level). |
| area | `plotarea(...)`, `area(...)` | value | color (or lineColor), lineWidth, lineStyle, topColor, bottomColor | A line with the area under it filled. |
| histogram | `plothistogram(...)`, `histogram(...)` | value | color, base | A bar a candle, from base (default 0) to the value. |
| baseline | `plotbaseline(...)`, `baseline(...)` | value | baseValue (or base), topLineColor, bottomLineColor, topFillColor1, bottomFillColor1, lineWidth, lineStyle | A line coloured above and below baseValue, with the areas filled. |
| candlestick | `plotcandlestick(...)`, `candlestick(...)` | open, high, low, close | upColor, downColor | Candles from {open, high, low, close} (avg_ohlc, ohlc, cum_ohlc, heikinashi). |
| bar | `plotbar(...)`, `bar_plot(...)` | open, high, low, close | upColor, downColor | Bars (a tick left for the open, right for the close) from {open, high, low, close}. |
| cloudarea | `plotcloudarea(...)`, `cloudarea(...)` | lowerValue, higherValue | positiveColor, negativeColor, higherLineColor (or positiveLineColor), lowerLineColor (or negativeLineColor), higherLineWidth, lowerLineWidth, higherLineStyle, lowerLineStyle | The area between two values, cloudarea(lower, higher), filled and edged. |
| brokenarea | `plotbrokenarea(...)`, `brokenarea(...)` | lowerValue, higherValue | color | A band from lowerValue to higherValue a candle, without joining candles (a row of colour per candle: heat maps). |
| mark | `mark(...)`, `plotmark(...)` | value | color, textColor, shape (label, text, dot, circle, square, diamond, triangleUp, triangleDown, arrowUp, arrowDown, cross), position (above, below, at: above or below stands a few pixels clear of the value), offset (pixels further off the value, to stack marks of two plots at one candle), size (0.6 to 2.5) | A mark at a value, on the candles where the call gives one: mark(value, text, tip, colour), or mark({value: v, text: t, tip: s, color: c}). text (up to 24 characters) is shown on the chart; tip (up to 600, a new line with \n) is what the pointer on the mark reads, with the script's name. A value that is not a number draws no mark there. Where marks would cover one another, a label is drawn as a dot and a text alone is left out, so they read when zoomed in. |

## Markets

source(x, exchange=...) takes these exchange names: BINANCE, BINANCE_FUTURES, BINANCE_US, OKEX, OKX, HUOBI, HTX, GATEIO, GATE, CRYPTOCOM, KRAKEN, KRAKEN_FUTURES, BITFINEX, BITSTAMP, COINBASE, BITMEX, DERIBIT, DYDX, HYPERLIQUID, BYBIT, BITGET, KUCOIN, MEXC, PHEMEX, POLONIEX, WHITEBIT, ASTER. type= is spot or perp; quote= is the quote currency (USDT, USDC, USD, ...). A filter can also be an option: exchange=options.venue.

## Not supported

- try, catch, throw, switch, class, this, import, export, async, await, yield, delete, with
- for ... of and for ... in (use for (var i = 0; i < a.length; i++))
- the spread syntax ... and regular expressions (replace takes plain text)
- new, except new Date(...) and new Array(n)
- single markets by name (EXCHANGE:pair): read markets with source(x, exchange=..., type=..., quote=...)
- trade counts: cbuy and csell read NaN
- the series, utils and vars objects of chart libraries, and price-scale or series calls
- Pine Script: no //@version, no ta.*, no plot(), no close / high / low as bare names (use $price.close), no := (use =)

## Limits

At most 20 scripts of 60,000 characters, 64 plots and 24 different sets of markets a script (the unfiltered one counted); about 40,000 steps a candle; 10 s a run from the first candle and 2.5 s a live update of the newest candles; arrays of 1,000,000 elements and texts of 100,000 characters. A run that passes them stops with its line and column.

## Errors

An error stops the script and says its line and column. Each code below is what Copy for AI and the panel report; X stands for the name or the text the error is about.

### unexpected-end

The script ends before this is complete. Met while the script is read, before it runs: nothing is drawn.

Meets it:

```js
line(sma($price.close, 20)
```

Put right:

```js
line(sma($price.close, 20))
```

### expected

Expected X here. Met while the script is read, before it runs: nothing is drawn.

Meets it:

```js
if ($price.close > 0 {
  line(1)
}
```

Put right:

```js
if ($price.close > 0) {
  line(1)
}
```

### expected-end

Two statements on one line: put a line break or a semicolon between them. Met while the script is read, before it runs: nothing is drawn.

Meets it:

```js
var a = 1 var b = 2
line(a + b)
```

Put right:

```js
var a = 1; var b = 2
line(a + b)
```

### expected-name

A name was expected here. Met while the script is read, before it runs: nothing is drawn.

Meets it:

```js
var = 3
line(3)
```

Put right:

```js
var three = 3
line(three)
```

### unterminated-string

A text is not closed with its quote. Met while the script is read, before it runs: nothing is drawn.

Meets it:

```js
line(1, title="CVD)
```

Put right:

```js
line(1, title="CVD")
```

### unterminated-comment

A comment is not closed. Met while the script is read, before it runs: nothing is drawn.

Meets it:

```js
/* the delta
line(vbuy - vsell)
```

Put right:

```js
/* the delta */
line(vbuy - vsell)
```

### unexpected-char

This character cannot be read: X Met while the script is read, before it runs: nothing is drawn.

Meets it:

```js
line(vbuy @ vsell)
```

Put right:

```js
line(vbuy - vsell)
```

### bad-number

This number cannot be read. Met while the script is read, before it runs: nothing is drawn.

Meets it:

```js
line(1e)
```

Put right:

```js
line(1e3)
```

### unexpected

Unexpected X here. Met while the script is read, before it runs: nothing is drawn.

Meets it:

```js
var x = )
line(x)
```

Put right:

```js
var x = 1
line(x)
```

### bad-assignment

Only a name, a member or an element can be set. Met while the script is read, before it runs: nothing is drawn.

Meets it:

```js
1 = level
line(level)
```

Put right:

```js
level = 1
line(level)
```

### unsupported

X is not part of the script language. Met while the script is read, before it runs: nothing is drawn.

Meets it:

```js
switch (renderer.length) {}
line(1)
```

Put right:

```js
if (renderer.length > 0) {}
line(1)
```

### too-deep

Nested too deeply. Met while the script is read or while it runs. Reading stops it at brackets or blocks nested about a hundred deep, or at one expression chaining more than 400 operators, calls or members; a run stops it at calls nested deeper than 200 (a function that calls itself without end).

Meets it:

```js
function f(n) { return f(n + 1) }
line(f(0))
```

Put right:

```js
function f(n) { return n >= 10 ? n : f(n + 1) }
line(f(0))
```

### too-many-sources

Too many different sets of markets: at most 24. Met while the script is read, before it runs: nothing is drawn. A set is one combination of filters (exchange, type, quote). A script has at most 24 sets, the unfiltered one (what x reads without source) always counted among them: 23 source(...) filters that differ.

Meets it:

```js
// 24 different filters:
line(source(vbuy, exchange=BINANCE, quote=USDT))
line(source(vbuy, exchange=BINANCE, quote=USDC))
// ... and so on, to
line(source(vbuy, exchange=KRAKEN, quote=EUR))
```

Put right:

```js
// at most 23 filters: drop one, or read a wider set (quote= left out reads every quote currency)
line(source(vbuy, exchange=BINANCE))
```

### too-many-plots

Too many plots: at most 64. Met while the script runs, at the candle where it happens. Met as the run starts, before the first candle, so nothing is drawn; Check does not count plots. Each plot call written in the text is one plot (a call in a loop is still one).

Meets it:

```js
// 65 plot calls:
line(1)
line(2)
// ... and so on, to
line(65)
```

Put right:

```js
// at most 64 plot calls
line(1)
```

### unknown-name

X is not defined. Met while the script runs, at the candle where it happens.

Meets it:

```js
line(sma(close, 20))
```

Put right:

```js
line(sma($price.close, 20))
```

### not-callable

X is not a function. Met while the script runs, at the candle where it happens.

Meets it:

```js
var n = 3
line(n())
```

Put right:

```js
var n = 3
line(n)
```

### no-member

Cannot read X of nothing (undefined or null). Met while the script runs, at the candle where it happens.

Meets it:

```js
var p = null
line(p.close)
```

Put right:

```js
var p = $price
line(p.close)
```

### read-only

X cannot be set. Met while the script runs, at the candle where it happens.

Meets it:

```js
$price.close = 1
line(1)
```

Put right:

```js
$price.color = "red"
line(1)
```

### const

X is a constant and cannot be set. Met while the script runs, at the candle where it happens.

Meets it:

```js
const k = 1
k = 2
line(k)
```

Put right:

```js
var k = 1
k = 2
line(k)
```

### redeclared

X is declared twice. Met while the script runs, at the candle where it happens.

Meets it:

```js
const a = 1
const a = 2
line(a)
```

Put right:

```js
const a = 1
const b = 2
line(a + b)
```

### bad-jump

A break, continue or return outside the loop or function it belongs to. Met while the script runs, at the candle where it happens.

Meets it:

```js
break
line(1)
```

Put right:

```js
line(1)
```

### budget

Stopped: the script took too many steps (a loop that never ends?). Met while the script runs, at the candle where it happens.

Meets it:

```js
while (true) {}
line(1)
```

Put right:

```js
var i = 0
while (i < 10) i++
line(i)
```

### too-large

Stopped: an array or a text grew too large. Met while the script runs, at the candle where it happens.

Meets it:

```js
var s = "x".padStart(20000)
line(s.length)
```

Put right:

```js
var s = "x".padStart(200)
line(s.length)
```

### too-slow

Stopped: the script took too long. Met while the script runs, at the candle where it happens. The run took longer than its time: 10 s for a run from the first candle (the chart opened, the script changed), 2.5 s for a live update of the newest candles; each candle on its own stayed within its steps. Work less a candle, or keep in a kept name what an earlier candle worked out. The example below takes about 30,000 steps a candle: it meets the limit on a chart of 2,000 candles.

Meets it:

```js
var s = 0
for (var i = 0; i < 10000; i++) s = s + Math.sqrt(i)
line(s)
```

Put right:

```js
var s = 0
for (var i = 0; i < 50; i++) s = s + Math.sqrt(i)
line(s)
```

### timeout

Stopped: the run took too long and was ended. Caused by the page, not by the script.

### worker-failed

The scripts could not be run here. Caused by the page, not by the script.

### internal

The scripts could not be run here. Caused by the page, not by the script.

### no-answer

The scripts could not be run here. Caused by the page, not by the script.

### newer-api

This script was written for a newer version of the script language: update the page to run it. Caused by the page, not by the script.

## Warnings

A warning does not stop the script.

- `no-counts`: Trade counts (cbuy, csell) are not recorded here: they read NaN.
- `unknown-reference`: X names no series here: it reads nothing.
- `unsupported-member`: X is not available here: it reads nothing.
- `no-plots`: The script draws nothing: add a plot such as line(...) or histogram(...).
- `no-markets`: No market on the page matches X: it reads 0.
- `unset-option`: Option X is not set: give it a value below.
- `unread-source`: A source(...) names its markets with something only the run can work out: it reads 0. Name them with a word, an option or options.name.
- `liquidations-cut`: Some days held more liquidations than the source answers: the smallest are missing from lbuy and lsell.
- `long-window`: Line X: this needs X, but scripts read only X. Raise Candles per script (up to 100,000 candles) or use a longer timeframe.

## A complete script

```js
// The cumulative delta of the spot markets, with its 20-candle average.
len = option(type=number, default=20, min=2, label="Average (candles)")
var delta = source(vbuy, type=spot) - source(vsell, type=spot)
total = total + nz(delta)
line(total, title="Spot CVD", color="rgb(46,155,255)")
line(sma(total, len), title="Average", color="rgba(128,128,128,0.8)")
```
