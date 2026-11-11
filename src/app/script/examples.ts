import { t } from '../i18n.ts';
import type { ScriptRecord } from './records.ts';
import { CVD_ID, CVD_SOURCE, HEATMAP_ID, HEATMAP_SOURCE, STARTER_ID, VWAP_SOURCE } from './starter.ts';

/** Each example's key, the same in every language: the starters' ids, and the start of the id of a script added from an example (about.ts). */
export type ExampleKey = typeof STARTER_ID | typeof HEATMAP_ID | typeof CVD_ID | 'depth-bands' | 'bar-patterns' | 'buyer-and-seller-vwaps' | 'liquidations' | 'volume-anomalies' | 'cumulative-delta' | 'delta-histogram' | 'buy-share';

/** Scripts to start from, written for this page: the three a page starts with first, then the others. */
export function examples(): { key: ExampleKey; name: string; source: string; place?: ScriptRecord['place'] }[] {
  return [
    { key: STARTER_ID, name: t('VWAP with bands'), source: VWAP_SOURCE, place: 'map' },
    { key: HEATMAP_ID, name: t('Stochastic heat map'), source: HEATMAP_SOURCE },
    { key: CVD_ID, name: t('Spot and perpetual CVD'), source: CVD_SOURCE },
    // How far a size of the recorded order books reaches from the close, up and down: the asks above it and the bids below it.
    { key: 'depth-bands', name: t('Depth bands'), place: 'map', source: `// Depth bands: how far a given number of dollars of the order book reaches from the close, on the books the page recorded.
// Above the close, the price at which that many dollars of the book are passed going up; below it, going down. It shows
// the liquidity typically recorded near the price, not what a market order of that size would pay.
// A wide band is a thin book: the same money moves the price further. Each candle's book is the one recorded at its close
// (its last minute), on every exchange the heat map shows, added up as one book.

// The size: a number of dollars, or a share of what an average candle traded at market (the band then means the same
// on a quiet day and a busy one, and on any coin; it widens with the timeframe, as candles trade more). On Bitcoin's
// books added up, $250M reached about 0.2 % from the close on 2026-10-30 at every timeframe.
size = option(type=number, default=250000000, min=100000, step=1000000, label="Size ($)")
byVolume = option(type=checkbox, default=false, label="Size from the volume")
share = option(type=number, default=0.1, min=0.01, step=0.01, label="Share of a candle's volume")
len = option(type=number, default=20, min=1, step=1, label="Volume window (candles)")
fill = option(type=color, default="rgba(128,128,128,0.08)", label="Fill")

// askdepth(x) and biddepth(x) are prices: the asks above the close, the bids below it; NaN where the book was not
// recorded for the candle, or holds less than x. depthatclose() is false where the books are averages over the candle (a
// server from before): there a move within the candle reads the side the price came from as thin, so depthabove(x) and
// depthbelow(x), which count every dollar recorded at each price, stand in.
var usd = byVolume ? share * sma(vbuy + vsell, len) : size
var atclose = depthatclose()
var upper = atclose ? askdepth(usd) : depthabove(usd)
var lower = atclose ? biddepth(usd) : depthbelow(usd)
// The lines in the theme's ink: the heat map under them is drawn in the page's own two colours, which would hide lines of either.
var ink = theme.dark ? "#f2f2f2" : "#1c1c1c"
cloudarea(lower, upper, positiveColor=fill, negativeColor=fill, higherLineColor=ink, lowerLineColor=ink, higherLineWidth=2, lowerLineWidth=2, title="Depth bands")
` },
    // What each candle did to the range of the one before (inside, outside, up, down), and the patterns that follow from it (breakout,
    // failed break, rejection, outside close) marked where they happen, with their levels and what the order flow did there when pointed at.
    { key: 'bar-patterns', name: t('Bar patterns'), source: `// Bar patterns: what each candle did to the range of the candle before it, and the few patterns that follow from that,
// marked where they happen, with what the order flow did there.
//
// A candle can do four things to the range before it: stay inside it (in), go past both ends (out), or go past one
// end, the high (up) or the low (down). A candle is compared only with the one just before it in time. From that:
//   Breakout       a candle stayed inside the one before, and the next broke out of it and closed outside it: a quiet
//                  range gave way.
//   Failed break   a candle broke out of the one before, and the next went back past the far end of that breakout candle
//                  and closed beyond it: whoever followed the break is now on the wrong side of it.
//   Rejection      a candle went past the end before, closed back inside, and its wick on that side is at least twice
//                  the rest of the candle: the prices beyond were refused.
//   Outside        a candle went past both ends of the one before and closed beyond one of them.
// A breakout and a failed break each have a break level (the price they went through) and a next level: the far side of
// the range before. Point at a mark to read them, whether the next level was reached in that candle, what was bought
// and sold at market, the liquidations, the change in open interest, and where the day's, week's and month's opens
// stood (UTC, the week from Monday; the hour's too on charts shorter than an hour). These describe what candles did. No
// test has shown that they say where price goes next. The candle under way is marked as it stands and can change; an
// alert waits for the close.

showRange = option(type=checkbox, default=true, label="Mark inside and outside candles")
showAll = option(type=checkbox, default=false, label="Mark up and down candles too")
showPatterns = option(type=checkbox, default=true, label="Mark patterns")
showEveryFail = option(type=checkbox, default=false, label="Every failed break (frequent), not only after an inside or outside candle")
showLevels = option(type=checkbox, default=true, label="Draw the break and next levels")
showWaiting = option(type=checkbox, default=true, label="After an inside candle, show its break levels until the candle under way goes past them")
paint = option(type=checkbox, default=false, label="Colour inside and outside candles")
sound = option(type=checkbox, default=false, label="Alert when a breakout or failed break closes")

hi = $price.high
lo = $price.low
op = $price.open
cl = $price.close
stamp = time

// The colours follow the page's theme: up and down as its candles are, and the words in and out in its text colour, dimmer for in.
var upColor = theme.up
var downColor = theme.down
var quiet = interpolate(0.7, theme.background, theme.text)
var loud = theme.text

// A candle is compared with the one just before it in time, both with prices: the first candle, and the one after a gap in
// the chart's candles, have nothing to compare with.
var follows = stamp - stamp[1] == renderer.timeframe && hi >= lo && hi[1] >= lo[1]
// What it did to the range before: 1 inside, 3 outside, 2 up, -2 down; 0 with nothing to compare with.
var tookHigh = follows && hi > hi[1]
var tookLow = follows && lo < lo[1]
move = !follows ? 0 : tookHigh && tookLow ? 3 : tookHigh ? 2 : tookLow ? -2 : 1
var IN = 1, OUT = 3, UP = 2, DOWN = -2

function group(s) {
  var parts = s.split(".")
  var w = parts[0], out = ""
  while (w.length > 3) { out = "," + w.slice(w.length - 3) + out; w = w.slice(0, w.length - 3) }
  return w + out + (parts.length > 1 ? "." + parts[1] : "")
}
function px(x) { return group(x.toFixed(x >= 1000 ? 0 : x >= 100 ? 1 : x >= 1 ? 2 : x >= 0.01 ? 4 : 6)) }
function usd(x) {
  var a = Math.abs(x)
  var s = a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : a >= 1e3 ? (a / 1e3).toFixed(0) + "K" : a.toFixed(0)
  return (x < 0 ? "-$" : "$") + s
}
function list(words) { return words.length < 2 ? words.join("") : words.slice(0, words.length - 1).join(", ") + " and " + words[words.length - 1] }

// The opens of the hour, day, week (from Monday) and month under way, in UTC, from the chart's own candles: known only once
// the chart reaches back to the candle where that period began.
var days = Math.floor(time / 86400)
var dayStart = days * 86400
var weekStart = (days - (days + 3) % 7) * 86400
var hourStart = Math.floor(time / 3600) * 3600
if (time == hourStart) { hOpen = op; hAt = hourStart }
if (time == dayStart) {
  dOpen = op; dAt = dayStart
  if (new Date(time * 1000).getUTCDate() == 1) { mOpen = op; mAt = dayStart }
}
if (time == weekStart) { wOpen = op; wAt = weekStart }

// Where a price stands against those opens, as one or two short sentences beginning with \`what\`.
function opens(price, what) {
  var over = [], under = [], at = [], unknown = []
  function one(name, open, since, start) {
    if (since != start) unknown.push(name)
    else if (price > open) over.push(name)
    else if (price < open) under.push(name)
    else at.push(name)
  }
  var date = new Date(time * 1000)
  if (renderer.timeframe < 3600) one("hour", hOpen, hAt, hourStart)
  one("day", dOpen, dAt, dayStart)
  one("week", wOpen, wAt, weekStart)
  one("month", mOpen, mAt, Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000)
  var where = []
  if (over.length) where.push("above the " + list(over) + " open" + (over.length > 1 ? "s" : ""))
  if (under.length) where.push("below the " + list(under) + " open" + (under.length > 1 ? "s" : ""))
  if (at.length) where.push("at the " + list(at) + " open" + (at.length > 1 ? "s" : ""))
  var lines = []
  if (where.length) lines.push(what + " " + where.join(", ") + ".")
  if (unknown.length) lines.push("The " + list(unknown) + " open" + (unknown.length > 1 ? "s are" : " is") + " not on the chart.")
  return lines.join("\\n")
}

// What was traded at market and liquidated in this candle, over the venues the flow column adds up (where this page did not
// record them, Binance's markets alone, from their own candles: bar.recorded is 0 there), and the change in open interest over
// the venues the OI pane adds up.
function flow() {
  var out = []
  var lead = " led by " + usd(Math.abs(vbuy - vsell)) + " (bought at market " + usd(vbuy) + ", sold " + usd(vsell) + ")"
  if (isNaN(vbuy) || isNaN(vsell)) out.push("Market orders were not recorded in this candle")
  else if (bar.recorded == 0) out.push("On Binance alone, " + (vbuy >= vsell ? "buyers" : "sellers") + lead)
  else out.push((vbuy >= vsell ? "Buyers" : "Sellers") + lead)
  if (!isNaN(lbuy) && !isNaN(lsell)) out.push(lbuy > 0 || lsell > 0 ? "Liquidated: shorts " + usd(lbuy) + ", longs " + usd(lsell) : "No liquidations recorded")
  if (!isNaN(oichg)) out.push("Open interest " + (oichg >= 0 ? "rose by " + usd(oichg) + " (positions opened)" : "fell by " + usd(-oichg) + " (positions closed)"))
  return out.join("\\n")
}

// The pattern this candle completes upward (rising = 1) or downward (rising = 0), or null: its name, what happened, the level it
// broke and the next level (NaN where it has none). At most one of the two directions fits a candle.
var m1 = move[1], m2 = move[2]
function pattern(rising) {
  var dir = rising ? UP : DOWN, against = rising ? DOWN : UP
  var closedBeyond = rising ? cl > hi[1] : cl < lo[1]
  // Past both ends of the candle before, and closed beyond one of them.
  if (move == OUT && closedBeyond) return { name: "Outside", what: "It went past both ends of the candle before and closed " + (rising ? "above its high (" + px(hi[1]) : "below its low (" + px(lo[1])) + ").", level: NaN, next: NaN }
  // Past one end of the candle before, closed back inside, and a wick on that side at least twice the rest of the candle.
  var range = hi - lo, wick = rising ? Math.min(op, cl) - lo : hi - Math.max(op, cl)
  if (range > 0 && wick * 3 >= range * 2 && (rising ? tookLow && cl > lo[1] : tookHigh && cl < hi[1]))
    return { name: "Rejection", what: "It went " + (rising ? "below the low (" + px(lo[1]) : "above the high (" + px(hi[1])) + ") of the candle before and closed back inside, with " + (rising ? "a lower" : "an upper") + " wick " + Math.round(100 * wick / range) + "% of the candle: the prices " + (rising ? "below" : "above") + " were refused.", level: NaN, next: NaN }
  // One end only, and a close beyond it.
  if (move != dir || !closedBeyond) return null
  var next = rising ? hi[2] : lo[2]
  // The candle before stayed inside the one before it.
  if (m1 == IN) return { name: "Breakout", what: "The candle before stayed inside the one before it. This one broke " + (rising ? "above" : "below") + " the inside candle's " + (rising ? "high" : "low") + " and closed " + (rising ? "above" : "below") + " it.", level: rising ? hi[1] : lo[1], next: next }
  // The candle before broke out of the one before it, and this one went back past its far end.
  if (m1 == against && (showEveryFail || m2 == IN || m2 == OUT)) return { name: "Failed break", what: "The candle before broke " + (rising ? "below" : "above") + (m2 == IN ? " an inside candle (a pause)" : m2 == OUT ? " an outside candle" : " the one before it") + ". This one went back " + (rising ? "above the high" : "below the low") + " of the candle before and closed " + (rising ? "above" : "below") + " it: the break failed.", level: rising ? hi[1] : lo[1], next: next }
  return null
}

var found = null, rising = 1
if (showPatterns) { found = pattern(1); if (!found) { found = pattern(0); rising = 0 } }

if (found) {
  var tint = rising ? upColor : downColor
  var levelled = !isNaN(found.level)
  var more = levelled && !isNaN(found.next) && found.next != found.level
  var lines = [found.what]
  if (renderer.forming) lines.push("Still under way: this can change.")
  if (levelled) {
    lines.push("Break level " + px(found.level) + (more ? "; next level " + px(found.next) + " (the " + (rising ? "high" : "low") + " two candles back), " + ((rising ? hi >= found.next : lo <= found.next) ? "reached" : "not reached: the furthest " + px(rising ? hi : lo)) + (renderer.forming ? " so far" : "") : ""))
  }
  lines.push(flow())
  lines.push(opens(levelled ? found.level : cl, levelled ? "Break level" : "Close"))
  var sign = found.name + (rising ? " ↑" : " ↓")
  // Below the candle for a pattern up, above it for one down.
  if (rising) mark({value: lo, text: sign, tip: lines.join("\\n"), color: tint}, title="Pattern up", position=below, offset=2, shape=label)
  else mark({value: hi, text: sign, tip: lines.join("\\n"), color: tint}, title="Pattern down", position=above, offset=2, shape=label)
  if (levelled && showLevels) {
    line({value: found.level, color: tint}, title="Break level", lineType=1, lineStyle=2, lineWidth=1)
    if (more) line({value: found.next, color: tint}, title="Next level", lineType=1, lineStyle=1, lineWidth=1)
  }
  if (sound && levelled) alert(sign + " closed " + (rising ? "above " : "below ") + px(found.level), sound=rising ? "rise" : "fall", when=close)
}

// The candle under way, right after an inside candle and not yet past either end of it: the two levels it would break out at.
if (showWaiting && renderer.forming && m1 == IN && move == IN) {
  line(hi[1], title="Breakout up at", lineType=1, lineStyle=2, color=upColor)
  line(lo[1], title="Breakout down at", lineType=1, lineStyle=2, color=downColor)
  mark({value: hi[1], text: "waiting", tip: "The candle before stayed inside the one before it, and this one is still within it. A breakout needs a close above " + px(hi[1]) + " or below " + px(lo[1]) + ", without going past the other end.\\n" + flow(), color: quiet}, title="Waiting", position=above, shape=text, size=0.9)
}

// Each candle's word under it: inside and outside, and up and down when asked for. A candle with a pattern says it there.
if (!found && ((showRange && (move == IN || move == OUT)) || (showAll && move != 0))) {
  var what = move == IN ? "Inside: it stayed within the high (" + px(hi[1]) + ") and the low (" + px(lo[1]) + ") of the candle before."
    : move == OUT ? "Outside: it went past both the high (" + px(hi[1]) + ") and the low (" + px(lo[1]) + ") of the candle before, and " + (cl > hi[1] ? "closed above that high." : cl < lo[1] ? "closed below that low." : "closed between them.")
    : move == UP ? "Up: it went above the high of the candle before (" + px(hi[1]) + ") and held its low, and " + (cl > hi[1] ? "closed above that high." : "did not close above it.")
    : "Down: it went below the low of the candle before (" + px(lo[1]) + ") and held its high, and " + (cl < lo[1] ? "closed below that low." : "did not close below it.")
  mark({value: lo, text: move == IN ? "in" : move == OUT ? "out" : move == UP ? "up" : "down", tip: what + (renderer.forming ? "\\nStill under way: this can change." : ""), color: move == IN ? quiet : move == OUT ? loud : move == UP ? upColor : downColor}, title="Candle", position=below, shape=text, size=0.85)
}

if (paint && move == IN) $price.color = quiet
if (paint && move == OUT) $price.color = loud
`, place: 'map' },
    // The volume-weighted prices of aggressive buyers and of aggressive sellers over the last candles, each with its band, on the map.
    { key: 'buyer-and-seller-vwaps', name: t('Buyer and seller VWAPs'), source: `// Buyer and seller VWAPs: the average price aggressive buyers paid (what was bought at market, weighted by its dollars)
// and the average price aggressive sellers got, over the last candles, each with a band one deviation wide. Where the
// buyers' line is above the sellers', buying came in at higher prices than selling; where it is below, selling led.

len = option(type=number, default=48, min=2, step=1, label="Window (candles)")
mult = option(type=number, default=1, min=0.1, step=0.1, label="Band width (deviations)")
buyColor = option(type=color, default="rgb(0,170,140)", label="Buyers")
sellColor = option(type=color, default="rgb(230,60,110)", label="Sellers")
buyFill = option(type=color, default="rgba(0,170,140,0.10)", label="Buyers' band")
sellFill = option(type=color, default="rgba(230,60,110,0.10)", label="Sellers' band")

var typical = ($price.high + $price.low + $price.close) / 3

var bought = sum(vbuy, len)
var buyers = sum(typical * vbuy, len) / bought
var buyersSpread = Math.sqrt(Math.max(0, sum(typical * typical * vbuy, len) / bought - buyers * buyers))

var sold = sum(vsell, len)
var sellers = sum(typical * vsell, len) / sold
var sellersSpread = Math.sqrt(Math.max(0, sum(typical * typical * vsell, len) / sold - sellers * sellers))

cloudarea(buyers - mult * buyersSpread, buyers + mult * buyersSpread, positiveColor=buyFill, negativeColor=buyFill, higherLineColor=buyFill, lowerLineColor=buyFill)
cloudarea(sellers - mult * sellersSpread, sellers + mult * sellersSpread, positiveColor=sellFill, negativeColor=sellFill, higherLineColor=sellFill, lowerLineColor=sellFill)
line(buyers, title="Buyers", color=buyColor, lineWidth=2)
line(sellers, title="Sellers", color=sellColor, lineWidth=2)
`, place: 'map' },
    // Liquidations as a cascade reads: shorts liquidated up, longs down, heights compressed so one cascade does not flatten the rest,
    // and each bar as bright as the candle's liquidations are unusual against the last candles; the line is the net pressure.
    { key: 'liquidations', name: t('Liquidations'), source: `// Liquidations: shorts liquidated (forced buys) up in violet, longs liquidated (forced sells) down in amber. Heights are
// compressed so one cascade does not flatten every other bar. A bar is dim while the candle's liquidations are ordinary
// and burns to full as they become unusual against the last candles, so a cascade reads before you look at the axis.
// The line is the net pressure, brightening as it becomes unusual too.

compression = option(type=number, default=0.5, min=0.1, step=0.05, label="Height compression (1 = linear)")
win = option(type=number, default=72, min=10, step=1, label="Baseline window (candles)")
cascadeZ = option(type=number, default=2, min=0.5, step=0.1, label="Cascade at (deviations)")
pressureLen = option(type=number, default=21, min=1, step=1, label="Pressure smoothing (candles)")
dimAlpha = option(type=number, default=0.26, min=0.02, step=0.02, label="Quiet opacity")
showPressure = option(type=checkbox, default=true, label="Net pressure line")
markCandles = option(type=checkbox, default=false, label="Colour cascade candles")

var SHORT_RGB = "150,105,255"
var LONG_RGB = "255,196,64"
var PRESSURE_RGB = "130,130,150"

// A colour from a hue: at the quiet opacity while z is at or under 0, at full once it reaches the gate.
function heat(rgb, z, gate, floor) {
  var d = Math.min(1, Math.max(0, z) / Math.max(gate, Number.EPSILON))
  return "rgba(" + rgb + "," + (floor + (1 - floor) * d).toFixed(3) + ")"
}

// lbuy is the dollars of shorts liquidated in the candle (their positions were bought back), lsell the longs.
var shorts = lbuy
var longs = lsell
var up = Math.pow(shorts, compression)
var down = Math.pow(longs, compression)

// How unusual the candle's liquidations are: deviations from their average over the window.
var total = shorts + longs
var mean = sma(total, win)
var spread = Math.sqrt(Math.max(0, sma(total * total, win) - mean * mean))
var z = spread > Number.EPSILON ? (total - mean) / spread : 0

histogram({ time: time, value: up, color: heat(SHORT_RGB, z, cascadeZ, dimAlpha) }, title="Shorts liquidated")
histogram({ time: time, value: -down, color: heat(LONG_RGB, z, cascadeZ, dimAlpha) }, title="Longs liquidated")

var pressure = ema(up - down, pressureLen)
var pMean = sma(pressure, win)
var pSpread = Math.sqrt(Math.max(0, sma(pressure * pressure, win) - pMean * pMean))
var pZ = pSpread > Number.EPSILON ? Math.abs((pressure - pMean) / pSpread) : 0
if (showPressure) line({ time: time, value: pressure, color: heat(PRESSURE_RGB, pZ, 2, 0.3) }, title="Net pressure", lineWidth=2)

if (markCandles && z > cascadeZ) $price.color = shorts >= longs ? "rgb(150,105,255)" : "rgb(255,196,64)"
` },
    // Each candle's volume by the side that led it, dim while ordinary and bright when unusual, with a mark where its delta is unusual
    // too.
    { key: 'volume-anomalies', name: t('Volume anomalies'), source: `// Volume anomalies: each candle's volume, in the buy colour where more was bought at market and the sell colour where more
// was sold. A bar is dim while its volume is ordinary and bright when it is more than Threshold deviations above its average
// over the last candles. A grey bar marks a candle whose delta (bought less sold) is unusual in the same way.

length = option(type=number, default=72, min=5, step=1, label="Baseline window (candles)")
mult = option(type=number, default=2, min=0.5, step=0.1, label="Threshold (deviations)")
upColor = option(type=color, default="rgba(0,190,165,0.25)", label="Bought")
downColor = option(type=color, default="rgba(235,40,130,0.25)", label="Sold")
upBright = option(type=color, default="rgb(0,190,165)", label="Bought, unusual")
downBright = option(type=color, default="rgb(235,40,130)", label="Sold, unusual")
deltaColor = option(type=color, default="rgba(128,128,128,0.8)", label="Unusual delta")
showDelta = option(type=checkbox, default=true, label="Mark unusual delta")
colorCandles = option(type=checkbox, default=false, label="Colour unusual candles")

var volume = vbuy + vsell
var delta = vbuy - vsell
var bought = vbuy > vsell

// Unusual: more than mult deviations above the average over the window.
var vMean = sma(volume, length)
var vSpread = Math.sqrt(Math.max(0, sma(volume * volume, length) - vMean * vMean))
var unusual = volume > vMean + mult * vSpread
var size = Math.abs(delta)
var dMean = sma(size, length)
var dSpread = Math.sqrt(Math.max(0, sma(size * size, length) - dMean * dMean))

histogram({ time: time, value: volume, color: unusual ? (bought ? upBright : downBright) : (bought ? upColor : downColor) }, title="Volume")
if (showDelta && size > dMean + mult * dSpread) histogram({ time: time, value: size, color: deltaColor }, title="Delta")

if (colorCandles && unusual) $price.color = bought ? upBright : downBright
` },
    { key: 'cumulative-delta', name: t('Cumulative delta'), source: '// What was bought at market less what was sold, added up candle after candle.\nline(cum(vbuy - vsell), title=CVD)\n' },
    { key: 'delta-histogram', name: t('Delta histogram'), source: '// Each candle\'s delta, in the buy colour where buyers led and the sell colour where sellers did.\nup = option(type=color, default=rgb(38,166,154), label=Buys)\ndown = option(type=color, default=rgb(239,83,80), label=Sells)\nvar delta = vbuy - vsell\nhistogram({ time: time, value: delta, color: delta > 0 ? up : down }, title=Delta)\n' },
    { key: 'buy-share', name: t('Buy share'), source: '// The share of the volume bought at market over the last candles, in percent.\nlength = option(default=20, min=1, label=Candles)\nline(100 * sum(vbuy, length) / sum(vbuy + vsell, length), title="Buy share %")\nline(50, color=rgba(128,128,128,0.6), title=Even)\n' },
  ];
}

/** A row's height in the pane for an example (the heat map's sixteen rows need room). */
export const exampleHeight = (source: string): number | undefined => source === HEATMAP_SOURCE ? 160 : undefined;
