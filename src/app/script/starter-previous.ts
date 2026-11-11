/**
 * The heat map's text as earlier versions of the page wrote it into a browser (`updateStarters`, starter.ts): one that still reads exactly
 * so is brought to the current version. Kept as written, never edited.
 */
export const PREVIOUS_HEATMAP_SOURCES: readonly string[] = [
  // 2026-10-27, master ede02cb to 9e10f5d: blue, a see-through grey and orange, in sRGB, the same on every theme.
  `// Stochastic heat map: the stochastic of the close (where it stands between the lowest low and the highest high of the
// last candles, 0 to 100) over sixteen windows, from 4 candles in the bottom row to 210 in the top one. Each row is a colour:
// warm near the top of its range, cool near the bottom. Rows that agree make a band of one colour; the line is their average.

scale = option(type=number, default=1, min=0.25, step=0.25, label="Window scale")
smooth = option(type=number, default=3, min=1, step=1, label="Smoothing (candles)")
lowColor = option(type=color, default="rgb(41,121,255)", label="Low")
midColor = option(type=color, default="rgba(128,128,128,0.12)", label="Middle")
highColor = option(type=color, default="rgb(255,152,0)", label="High")
lineColor = option(type=color, default="rgb(213,0,249)", label="Average")
showAverage = option(type=checkbox, default=true, label="Average line")
colorCandles = option(type=checkbox, default=false, label="Colour the candles")

// A function of your own: the colour of a reading from 0 to 100, from Low through Middle to High.
function shade(k) {
  return interpolate(k / 100, lowColor, midColor, highColor)
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

var average = (k1 + k2 + k3 + k4 + k5 + k6 + k7 + k8 + k9 + k10 + k11 + k12 + k13 + k14 + k15 + k16) / 16
if (showAverage) line(average, title="Average", color=lineColor, lineWidth=2)

// $price.color colours the map's candle: here by the average, when switched on.
if (colorCandles) $price.color = shade(average)
`,
];

/** The VWAP with bands as earlier versions wrote it into a browser (`updateStarters`): one that still reads exactly so is brought to the
 * current version. Kept as written, never edited. */
export const PREVIOUS_VWAP_SOURCES: readonly string[] = [
  // 2026-10-26 to 2026-10-28, master 249b08f to 3290195: weighted by the flow recorded on the page (vbuy + vsell), so a page that had not
  // recorded the last 48 candles (the public site, which reads the exchanges from the browser) drew nothing.
  `// VWAP with bands: the volume-weighted average of the typical price, (high + low + close) / 3, over the last candles.
// It rolls with the candles (it is not anchored to a session), and its bands are that price's deviation around it.

// option(...) is a setting: change it under the text, no need to edit the script.
len = option(type=number, default=48, min=4, step=1, label="Window (candles)")
mult = option(type=number, default=1.8, min=0.2, step=0.1, label="Band width (deviations)")
midColor = option(type=color, default="rgba(255,64,255,0.95)", label="VWAP")
bandColor = option(type=color, default="rgba(255,64,255,0.6)", label="Bands")

// A var is worked out again on every candle. vbuy and vsell are the dollars bought and sold at market in the candle.
var typical = ($price.high + $price.low + $price.close) / 3
var vol = vbuy + vsell
var num = sma(typical * vol, len)
var den = sma(vol, len)
var num2 = sma(typical * typical * vol, len)

// A name set without var keeps its value from candle to candle: mid[1] would be the VWAP one candle back.
// Where the flow was not recorded, vbuy reads NaN: with no volume to weigh by, the lines leave a gap there.
mid = den > 0 ? num / den : NaN
var sd = Math.sqrt(Math.max(0, num2 / den - mid * mid))
upper = mid + mult * sd
lower = mid - mult * sd

line(mid, title="VWAP", color=midColor, lineWidth=2)
line(upper, title="+SD", color=bandColor)
line(lower, title="-SD", color=bandColor)
`,
];

/**
 * The spot and perpetual CVD example as the page wrote it into a browser before its labels (2026-10-27 to 2026-11-11, `updateStarters`): a copy
 * that still reads exactly so becomes the labelled one. Kept as written, never edited.
 */
// Under a `source:` property, as the examples keep their scripts: a script's text is not a sentence of the page.
const PLAIN_CVD = { source: `// The cumulative delta of the spot markets and of the perpetuals, apart.
spotColor = option(type=color, default=#2e9bff, label=Spot)
perpColor = option(type=color, default=#ff9f1c, label=Perpetual)
spotDelta = source(vbuy, type=spot) - source(vsell, type=spot)
perpDelta = source(vbuy, type=perp) - source(vsell, type=perp)
line(cum(spotDelta), title=Spot, color=spotColor)
line(cum(perpDelta), title=Perp, color=perpColor, priceScaleId=perp)
` };
export const PREVIOUS_CVD_SOURCES: readonly string[] = [PLAIN_CVD.source];
