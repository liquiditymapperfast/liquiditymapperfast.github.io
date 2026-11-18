import { PREVIOUS_CVD_SOURCES, PREVIOUS_HEATMAP_SOURCES, PREVIOUS_VWAP_SOURCES } from './starter-previous.ts';
import { t } from '../i18n.ts';
import { ROW_DEFAULT, SCRIPT_API, type ScriptRecord } from './records.ts';

/**
 * A rolling VWAP with bands: the volume-weighted mean of the candles' typical price over the last candles, moving with them (not anchored to a
 * session or to the first candle), and bands some deviations of that price wide. Written to be read: it shows a setting, a name kept from candle
 * to candle and one worked out again, a moving average and three plots on the price scale.
 */
export const VWAP_SOURCE = `// VWAP with bands: the volume-weighted average of the typical price, (high + low + close) / 3, over the last candles.
// It rolls with the candles (it is not anchored to a session), and its bands are that price's deviation around it.

// option(...) is a setting: change it under the text, no need to edit the script.
len = option(type=number, default=48, min=4, step=1, label="Window (candles)")
mult = option(type=number, default=1.8, min=0.2, step=0.1, label="Band width (deviations)")
midColor = option(type=color, default="rgba(255,64,255,0.95)", label="VWAP")
bandColor = option(type=color, default="rgba(255,64,255,0.6)", label="Bands")

// A var is worked out again on every candle. $price.volume is what the candle traded, in coins, as its exchange reports it:
// every candle has it, whether or not this page recorded it, as for the VWAP the chart draws.
var typical = ($price.high + $price.low + $price.close) / 3
var vol = $price.volume
var num = sma(typical * vol, len)
var den = sma(vol, len)
var num2 = sma(typical * typical * vol, len)

// A name set without var keeps its value from candle to candle: mid[1] would be the VWAP one candle back.
// A candle with no volume reported leaves a gap, and the candles after it go on from the others.
mid = den > 0 ? num / den : NaN
var sd = Math.sqrt(Math.max(0, num2 / den - mid * mid))
upper = mid + mult * sd
lower = mid - mult * sd

line(mid, title="VWAP", color=midColor, lineWidth=2)
line(upper, title="+SD", color=bandColor)
line(lower, title="-SD", color=bandColor)
`;

/**
 * A stochastic heat map: where the close stands between the lowest low and the highest high of the last candles, over sixteen windows from a
 * few candles to a couple of hundred, each a row of colour. The rows are sixteen calls each, not a loop: each call of a function such as
 * `stoch` keeps its own history, so a loop would make all windows share one.
 */
export const HEATMAP_SOURCE = `// Stochastic heat map: the stochastic of the close (where it stands between the lowest low and the highest high of the
// last candles, 0 to 100) over sixteen windows, from 4 candles in the bottom row to 210 in the top one. Each row is a colour:
// red-orange where the close is near the bottom of its range, blue near the top, grey at the middle (50). Rows that agree make
// a band of one colour; the line is their average.

scale = option(type=number, default=1, min=0.25, step=0.25, label="Window scale")
smooth = option(type=number, default=3, min=1, step=1, label="Smoothing (candles)")
steps = option(type=checkbox, default=false, label="Twelve steps instead of a smooth scale")
showAverage = option(type=checkbox, default=true, label="Average line")
colorCandles = option(type=checkbox, default=false, label="Colour the candles")

// The colours from 0 to 100, every 10. They follow the page's theme: light ends on a dark chart, dark ends on a light one. Equal
// changes of the reading look equal on both sides (worked out in Oklab, a colour space made for that), and the two sides stay
// apart for colour-blind eyes. The middle is a neutral grey a little off the chart's background, so a neutral reading is not
// mistaken for none.
var ramp = theme.dark
  ? ["#f49884", "#c98272", "#a06c60", "#78574f", "#52423e", "#2e2e2e", "#3d4752", "#4c6279", "#5b7ea3", "#6a9bce", "#79b9fb"]
  : ["#a44937", "#b46959", "#c3897c", "#d1a89f", "#ddc8c3", "#e8e8e8", "#c2cfdd", "#9cb6d3", "#789dc7", "#5284bb", "#2a6bae"]

// A function of your own: the colour of a reading from 0 to 100. With steps on, a reading takes the colour of the middle of its
// step: below 5, 5 to 10, then every 10, 90 to 94, and 94 and over.
function shade(k) {
  // A window without a reading (a candle that was not recorded) draws nothing, rather than the colour of 0.
  if (!isFinite(k)) return "transparent"
  if (steps) k = k < 5 ? 2.5 : k < 10 ? 7.5 : k >= 94 ? 97 : k >= 90 ? 92 : Math.floor(k / 10) * 10 + 5
  return interpolate(k / 100, ramp)
}

// One smoothed stochastic per window. Each call of stoch or ema keeps its own history, which is why there are sixteen lines
// and not a loop: in a loop every window would share one.
var c = $price.close
var h = $price.high
var l = $price.low
var k1 = ema(stoch(c, h, l, 4 * scale), smooth)
var k2 = ema(stoch(c, h, l, 5 * scale), smooth)
var k3 = ema(stoch(c, h, l, 7 * scale), smooth)
var k4 = ema(stoch(c, h, l, 9 * scale), smooth)
var k5 = ema(stoch(c, h, l, 12 * scale), smooth)
var k6 = ema(stoch(c, h, l, 15 * scale), smooth)
var k7 = ema(stoch(c, h, l, 20 * scale), smooth)
var k8 = ema(stoch(c, h, l, 26 * scale), smooth)
var k9 = ema(stoch(c, h, l, 34 * scale), smooth)
var k10 = ema(stoch(c, h, l, 44 * scale), smooth)
var k11 = ema(stoch(c, h, l, 57 * scale), smooth)
var k12 = ema(stoch(c, h, l, 74 * scale), smooth)
var k13 = ema(stoch(c, h, l, 96 * scale), smooth)
var k14 = ema(stoch(c, h, l, 125 * scale), smooth)
var k15 = ema(stoch(c, h, l, 162 * scale), smooth)
var k16 = ema(stoch(c, h, l, 210 * scale), smooth)

// The rows, on a scale of 0 to 100 (each 6.25 high), so the average line stands at its own value over them.
brokenarea({ time: time, lowerValue: 0, higherValue: 6.25, color: shade(k1) })
brokenarea({ time: time, lowerValue: 6.25, higherValue: 12.5, color: shade(k2) })
brokenarea({ time: time, lowerValue: 12.5, higherValue: 18.75, color: shade(k3) })
brokenarea({ time: time, lowerValue: 18.75, higherValue: 25, color: shade(k4) })
brokenarea({ time: time, lowerValue: 25, higherValue: 31.25, color: shade(k5) })
brokenarea({ time: time, lowerValue: 31.25, higherValue: 37.5, color: shade(k6) })
brokenarea({ time: time, lowerValue: 37.5, higherValue: 43.75, color: shade(k7) })
brokenarea({ time: time, lowerValue: 43.75, higherValue: 50, color: shade(k8) })
brokenarea({ time: time, lowerValue: 50, higherValue: 56.25, color: shade(k9) })
brokenarea({ time: time, lowerValue: 56.25, higherValue: 62.5, color: shade(k10) })
brokenarea({ time: time, lowerValue: 62.5, higherValue: 68.75, color: shade(k11) })
brokenarea({ time: time, lowerValue: 68.75, higherValue: 75, color: shade(k12) })
brokenarea({ time: time, lowerValue: 75, higherValue: 81.25, color: shade(k13) })
brokenarea({ time: time, lowerValue: 81.25, higherValue: 87.5, color: shade(k14) })
brokenarea({ time: time, lowerValue: 87.5, higherValue: 93.75, color: shade(k15) })
brokenarea({ time: time, lowerValue: 93.75, higherValue: 100, color: shade(k16) })

// The average in off-white on a dark chart and near-black on a light one: it stands apart from both sides of the scale.
var average = (k1 + k2 + k3 + k4 + k5 + k6 + k7 + k8 + k9 + k10 + k11 + k12 + k13 + k14 + k15 + k16) / 16
if (showAverage) line(average, title="Average", color=theme.dark ? "#f2f2f2" : "#1c1c1c", lineWidth=2)

// $price.color colours the map's candle: here by the average, when switched on.
if (colorCandles) $price.color = shade(average)
`;

/**
 * The cumulative delta of the spot markets and of the perpetuals, apart, with a label at each line's newest value: how far it moved over the
 * lookback and whether that move was straight enough to call rising or falling (a user's script, 2026-11-11, from the example of this name;
 * `renderer.last` keeps its labels when the newest candle has closed, `$` and a Labels switch added). Its labels are tags at the right edge
 * since 2026-11-18 (Karl: plates at the lines' ends covered each other where the lines crossed).
 */
export const CVD_SOURCE = `// Spot and perpetual CVD: the cumulative delta (what was bought at market less what was sold) of the spot markets and of
// the perpetuals, apart, each on a scale of its own. A tag at the right edge, at each line's newest value and in its colour,
// says which it is, how far it has moved over the last candles (the lookback) and where it is heading: rising, falling or flat.
spotColor = option(type=color, default=#2e9bff, label=Spot)
perpColor = option(type=color, default=#ff9f1c, label=Perpetual)
trendLength = option(type=number, default=20, min=2, max=500, step=1, label="Lookback (candles)")
showLabels = option(type=checkbox, default=true, label="Labels")

spotDelta = source(vbuy, type=spot) - source(vsell, type=spot)
perpDelta = source(vbuy, type=perp) - source(vsell, type=perp)
spotCvd = cum(spotDelta)
perpCvd = cum(perpDelta)

// The move: how far each line has come over the lookback, which its label says. The path: how far it travelled candle
// by candle to get there. A line that went straight has a move as long as its path; one that went back and forth, a
// long path and a short move. A move under a quarter of its path counts as flat.
spotMove = spotCvd - last(spotCvd, trendLength + 1)
perpMove = perpCvd - last(perpCvd, trendLength + 1)
spotPath = sum(Math.abs(nz(spotDelta)), trendLength)
perpPath = sum(Math.abs(nz(perpDelta)), trendLength)

// Dollars, short: +$12.3M, -$850K.
function money(x) {
  var a = Math.abs(x), sign = x < 0 ? "-" : "+"
  if (a >= 1e12) return sign + "$" + (a / 1e12).toFixed(2) + "T"
  if (a >= 1e9) return sign + "$" + (a / 1e9).toFixed(2) + "B"
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(1) + "M"
  if (a >= 1e3) return sign + "$" + (a / 1e3).toFixed(0) + "K"
  return sign + "$" + a.toFixed(0)
}
function trendOf(move, path) {
  if (!(path > 0) || Math.abs(move) < 0.25 * path) return "flat"
  return move > 0 ? "rising" : "falling"
}
function arrowOf(word) { return word == "rising" ? "▲" : word == "falling" ? "▼" : "▶" }
function tipOf(name, cvd, move, path, word) {
  var straight = path > 0 ? Math.round(100 * Math.abs(move) / path) : 0
  return name + " CVD over the last " + trendLength + " candles: " + money(move) + ", " + word + "\\nIt travelled " + money(path).slice(1) + " candle by candle, so the move is " + straight + " % straight (under 25 % counts as flat).\\nSince the first candle read: " + money(cvd)
}

line(spotCvd, title=Spot, color=spotColor)
line(perpCvd, title=Perp, color=perpColor, priceScaleId=perp)

// The labels are tags (shape=tag): each stands at the right edge at its line's newest value, and tags that would cover each
// other are moved apart, in the lines' order, with a short leader to the value. They are given on the newest candle only
// (renderer.last), under way or closed: a value that is not a number draws none.
var newest = showLabels && renderer.last
var spotWord = trendOf(spotMove, spotPath), perpWord = trendOf(perpMove, perpPath)
mark({value: newest ? spotCvd : NaN, text: "Spot " + money(spotMove) + " " + arrowOf(spotWord) + " " + spotWord, tip: tipOf("Spot", spotCvd, spotMove, spotPath, spotWord), color: spotColor}, title="Spot label", shape=tag)
mark({value: newest ? perpCvd : NaN, text: "Perp " + money(perpMove) + " " + arrowOf(perpWord) + " " + perpWord, tip: tipOf("Perp", perpCvd, perpMove, perpPath, perpWord), color: perpColor}, title="Perp label", shape=tag, priceScaleId=perp)
`;

/**
 * Strong and weak highs and lows: each swing high and low as a level from its own candle, named strong once the move away from it broke the
 * swing it came from (market structure as its traders read it), ended where price comes back to it. A user's design (2026-11-17), which asked
 * the page to draw the levels itself; rewritten on `level`, so it runs, and anyone can read and change how a level is judged.
 */
export const SWING_SOURCE = `// Strong and weak highs and lows: the price's swing highs and lows as levels, read as traders of market structure read them.
// A swing high (low) is a candle whose high (low) is beyond those of the Swing candles each side of it, so it is known that
// many candles late, and its level is then drawn from the swing candle itself.
//   strong low    the rise away from it went on to break the high it fell from: buyers took over there
//   weak low      the rise from it has not broken that high: the low price is expected to come back for
//   strong high   the fall away from it went on to break the low it rose from
//   weak high     the fall from it has not broken that low
// A weak level turns strong once that break comes. A level is untested until price trades at it again, and runs on to the
// right edge with its name; a tested one ends at the candle that tested it, with a cross, where Tested levels shows them.
// A map of structure, not a forecast.
swing = option(type=number, default=5, min=2, max=50, step=1, label="Swing (candles each side)")
breakBy = option(type=list, default="Close", options=["Close", "Wick"], label="A break counts by the")
tested = option(type=list, default="Hidden", options=["Hidden", "Faint", "Full"], label="Tested levels")
most = option(type=number, default=24, min=1, max=100, step=1, label="Most untested levels")
// Each kind of level: its colour, its line's width and its line's style.
strongHighColor = option(type=color, default="#e5484d", label="Strong high")
strongHighWidth = option(type=list, default=2, options=[1, 1.5, 2, 3, 4], label="Strong high: line width")
strongHighStyle = option(type=list, default="Solid", options=["Solid", "Dashed", "Dotted"], label="Strong high: line style")
weakHighColor = option(type=color, default="rgba(229,72,77,0.65)", label="Weak high")
weakHighWidth = option(type=list, default=1, options=[1, 1.5, 2, 3, 4], label="Weak high: line width")
weakHighStyle = option(type=list, default="Dashed", options=["Solid", "Dashed", "Dotted"], label="Weak high: line style")
strongLowColor = option(type=color, default="#00b386", label="Strong low")
strongLowWidth = option(type=list, default=2, options=[1, 1.5, 2, 3, 4], label="Strong low: line width")
strongLowStyle = option(type=list, default="Solid", options=["Solid", "Dashed", "Dotted"], label="Strong low: line style")
weakLowColor = option(type=color, default="rgba(0,179,134,0.65)", label="Weak low")
weakLowWidth = option(type=list, default=1, options=[1, 1.5, 2, 3, 4], label="Weak low: line width")
weakLowStyle = option(type=list, default="Dashed", options=["Solid", "Dashed", "Dotted"], label="Weak low: line style")
// The names at the right edge: full (Strong high), short (SH) or none; with the price or without; each on a plate of its
// line's colour, or all on plates of one colour.
names = option(type=list, default="Full", options=["Full", "Short", "None"], label="Names")
prices = option(type=checkbox, default=true, label="Price beside the name")
nameColors = option(type=list, default="As the line", options=["As the line", "One colour"], label="Names coloured")
nameColor = option(type=color, default="#e6e1cf", label="Names: the one colour")

function dashes(style) { return style == "Dashed" ? 2 : style == "Dotted" ? 1 : 0 }
// A price as a name shows it: thousands grouped, decimals by its size.
function priceText(p) {
  var s = p.toFixed(p >= 1000 ? 0 : p >= 100 ? 1 : p >= 1 ? 2 : p >= 0.01 ? 4 : 6)
  var dot = s.indexOf("."), whole = dot < 0 ? s : s.slice(0, dot), out = ""
  for (var k = 0; k < whole.length; k++) { if (k > 0 && (whole.length - k) % 3 == 0) out += ","; out += whole.slice(k, k + 1) }
  return dot < 0 ? out : out + s.slice(dot)
}
function nameOf(lv) {
  if (names == "None") return ""
  var name = names == "Short" ? (lv.strong ? "S" : "W") + (lv.high ? "H" : "L") : (lv.strong ? "Strong " : "Weak ") + (lv.high ? "high" : "low")
  return prices ? name + " " + priceText(lv.price) : name
}
var plate = nameColors == "One colour" ? nameColor : ""
// A tested level ends with a cross where Tested levels shows them.
var cross = tested == "Hidden" ? "none" : "cross"
// A level's colour: its kind's, faded into the background once tested where Tested levels is Faint.
function colorOf(lv) {
  var c = lv.high ? (lv.strong ? strongHighColor : weakHighColor) : (lv.strong ? strongLowColor : weakLowColor)
  return !na(lv.testedAt) && tested == "Faint" ? interpolate(0.6, c, theme.background) : c
}
// Draws a level in its kind's plot (a value of NaN takes it away): a call each, so each kind keeps its own line. A tested level
// ends at the candle that tested it, without a name.
function put(lv, value) {
  var point = { value: value, from: lv.start, to: lv.testedAt, text: na(lv.testedAt) ? nameOf(lv) : "", color: colorOf(lv) }
  if (lv.high && lv.strong) level(point, title="Strong highs", color=strongHighColor, lineWidth=Number(strongHighWidth), lineStyle=dashes(strongHighStyle), textColor=plate, endShape=cross)
  else if (lv.high) level(point, title="Weak highs", color=weakHighColor, lineWidth=Number(weakHighWidth), lineStyle=dashes(weakHighStyle), textColor=plate, endShape=cross)
  else if (lv.strong) level(point, title="Strong lows", color=strongLowColor, lineWidth=Number(strongLowWidth), lineStyle=dashes(strongLowStyle), textColor=plate, endShape=cross)
  else level(point, title="Weak lows", color=weakLowColor, lineWidth=Number(weakLowWidth), lineStyle=dashes(weakLowStyle), textColor=plate, endShape=cross)
}
function draw(lv) { put(lv, lv.price) }
function erase(lv) { put(lv, NaN) }
// What the levels drawn can still meet, so a candle that meets none of it skips them: the lowest high and the highest low not yet
// tested, and the prices whose break would make a weak one strong.
function reach() {
  nearHigh = Infinity; nearLow = -Infinity; breakUp = Infinity; breakDown = -Infinity
  for (var k = 0; k < levels.length; k++) {
    var lv = levels[k]
    if (lv.high) { nearHigh = Math.min(nearHigh, lv.price); if (!lv.strong && !na(lv.from)) breakDown = Math.max(breakDown, lv.from) }
    else { nearLow = Math.max(nearLow, lv.price); if (!lv.strong && !na(lv.from)) breakUp = Math.min(breakUp, lv.from) }
  }
}

// The swing size as a whole number of candles, and the candle's start, kept so the swing candle's can be read back.
var span = Math.max(2, Math.min(50, Math.round(nz(swing, 5))))
starts = time
var h = $price.high, l = $price.low, closed = !renderer.forming
// What a break is measured by. A break by the close waits for the candle to close; one by the wick counts as soon as it trades.
var up = breakBy == "Wick" ? h : $price.close, down = breakBy == "Wick" ? l : $price.close, breaks = breakBy == "Wick" || closed
// How far the price went beyond, either way, over the candles since the swing candle (a break may come before the swing is known).
var rose = highest(up, span), fell = lowest(down, span)
var ph = pivot_high(h, span, span), pl = pivot_low(l, span, span)

if (renderer.length == 1) { levels = []; lastHigh = NaN; lastLow = NaN; reach() }
// The levels already drawn: a break of the swing they came from makes a weak one strong, and a trade at its price tests it.
if (h >= nearHigh || l <= nearLow || (breaks && (up > breakUp || down < breakDown))) {
  for (var k = levels.length - 1; k >= 0; k--) {
    var lv = levels[k], was = lv.strong
    if (!lv.strong && breaks && (lv.high ? down < lv.from : up > lv.from)) lv.strong = true
    if (lv.high ? h >= lv.price : l <= lv.price) {
      if (was != lv.strong) { lv.strong = was; erase(lv); lv.strong = true }
      lv.testedAt = time
      if (tested == "Hidden") erase(lv); else draw(lv)
      levels.splice(k, 1)
    } else if (was != lv.strong) { lv.strong = was; erase(lv); lv.strong = true; draw(lv) }
  }
  reach()
}
// A new swing, once the candle that shows it has closed: its level from the swing candle, strong if the price has already broken
// the swing it came from. A low came from the last swing high before it (and a high from the last low), never from the same candle's.
if (closed && (!na(ph) || !na(pl))) {
  var priorHigh = lastHigh, priorLow = lastLow
  if (!na(ph)) {
    var hl = { high: true, price: ph, start: starts[span], from: priorLow, strong: fell < priorLow, testedAt: NaN }
    levels.push(hl); draw(hl); lastHigh = ph
  }
  if (!na(pl)) {
    var ll = { high: false, price: pl, start: starts[span], from: priorHigh, strong: rose > priorHigh, testedAt: NaN }
    levels.push(ll); draw(ll); lastLow = pl
  }
  // The oldest untested levels go first past the most drawn.
  while (levels.length > most) { erase(levels[0]); levels.splice(0, 1) }
  reach()
}
`;

/** The ids of the scripts a page starts with. */
export const STARTER_ID = 'vwap-with-bands', HEATMAP_ID = 'stochastic-heat-map', CVD_ID = 'spot-and-perpetual-cvd', SWING_ID = 'strong-and-weak-highs-and-lows';

/**
 * The scripts a page starts with before it has kept any: the rolling VWAP with its bands on the map, on (Karl, 2026-10-28: shown to every
 * visitor), and the stochastic heat map in a row under the map, off until switched on (it was on from 2026-10-27; a row under the map takes
 * height from it), and the spot and perpetual CVD with its tags in a row, off (a user's, 2026-11-11), and the strong and weak highs and lows
 * on the map, off (a user's, 2026-11-17), so the Scripts panel opens on four to read, change and learn from.
 * Deleting one keeps the list as it is left; its example brings it back. A browser that already kept a list keeps it as it is, but for an
 * untouched heat map of an earlier version (`updateStarters`).
 */
export function starterScripts(): ScriptRecord[] {
  return [
    { id: STARTER_ID, name: t('VWAP with bands'), source: VWAP_SOURCE, options: {}, on: true, api: SCRIPT_API, height: ROW_DEFAULT, place: 'map' },
    { id: HEATMAP_ID, name: t('Stochastic heat map'), source: HEATMAP_SOURCE, options: {}, on: false, api: SCRIPT_API, height: 160, place: 'pane' },
    { id: CVD_ID, name: t('Spot and perpetual CVD'), source: CVD_SOURCE, options: {}, on: false, api: SCRIPT_API, height: ROW_DEFAULT, place: 'pane' },
    { id: SWING_ID, name: t('Strong and weak highs and lows'), source: SWING_SOURCE, options: {}, on: false, api: SCRIPT_API, height: ROW_DEFAULT, place: 'map' },
  ];
}

/**
 * The options the heat map had before 2026-10-27 that it no longer has, with their values then: its colours, now the theme's. A save in
 * the editor wrote these defaults down even when nobody touched them.
 */
const OLD_HEATMAP_OPTIONS: Readonly<Record<string, string>> = { lowColor: 'rgb(41,121,255)', midColor: 'rgba(128,128,128,0.12)', highColor: 'rgb(255,152,0)', lineColor: 'rgb(213,0,249)' };

/**
 * A kept list with the heat map as an earlier version of the page wrote it (its text the same, its old colours as they were) gets the
 * current one, so a change to the starter reaches the browsers that kept it; its other options stay and the old colours go. One the person
 * edited, or coloured, stays as it is.
 */
export function updateStarters(list: ScriptRecord[]): ScriptRecord[] {
  return list.map(r => {
    // An untouched VWAP with bands, the starter or a copy added from the examples: the current text, its settings as they were.
    if (PREVIOUS_VWAP_SOURCES.includes(r.source.replace(/\r\n?/g, '\n'))) return { ...r, source: VWAP_SOURCE, api: Math.max(r.api, SCRIPT_API) };
    // An untouched spot and perpetual CVD from before its tags (without labels, or with labels at the lines' ends): the current one, its
    // colours and switches kept (its "?" describes the labels by its id).
    if (PREVIOUS_CVD_SOURCES.includes(r.source.replace(/\r\n?/g, '\n'))) return { ...r, source: CVD_SOURCE, api: Math.max(r.api, SCRIPT_API) };
    if (r.id !== HEATMAP_ID || !PREVIOUS_HEATMAP_SOURCES.includes(r.source.replace(/\r\n?/g, '\n'))) return r;
    const old = Object.keys(r.options).filter(k => Object.prototype.hasOwnProperty.call(OLD_HEATMAP_OPTIONS, k));
    if (old.some(k => r.options[k] !== OLD_HEATMAP_OPTIONS[k])) return r;
    // Its new text reads `theme`, which version 2 brought: a page older than that says so rather than run it.
    return { ...r, source: HEATMAP_SOURCE, api: Math.max(r.api, SCRIPT_API), options: Object.fromEntries(Object.entries(r.options).filter(([k]) => !old.includes(k))) };
  });
}
