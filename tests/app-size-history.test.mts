import test from 'node:test';
import assert from 'node:assert/strict';
import { BANDS, PLAIN_ALPHA, QUIET_ALPHA, SHARE_MIN_SLOTS, alphaOf, bandLabel, buildHistory, cardLines, emphasis, heightOf, judge, preRollMs, rowCap, shareDot, shareMarks, unusualRows, type HistoryInput } from '../src/app/size-history/model.ts';
import type { Bar } from '../src/app/panes/footprint.ts';
import { DEFAULT_HIGHLIGHT } from '../src/app/anomaly.ts';

const MIN = 60_000, TF = 15 * MIN, T0 = Date.UTC(2026, 10, 20, 0, 0);
const H = { on: true, mult: 2, length: 72 } as const;

/** A bar of a 15-minute candle with these box buys and sells (eight each), recorded over `minutes` of it. */
function bar(i: number, buy: number[], sell: number[], minutes = 15): Bar {
  const b = buy.reduce((a, x) => a + x, 0), s = sell.reduce((a, x) => a + x, 0);
  return { t: T0 + i * TF, rows: [], buyUsd: b, sellUsd: s, minutes, stats: { buyN: 10, sellN: 10, buy, sell } };
}
const boxes = (v: Partial<Record<number, number>>): number[] => Array.from({ length: 8 }, (_, k) => v[k] ?? 0);
const input = (bars: (Bar | null)[], over: Partial<HistoryInput> = {}): HistoryInput => ({
  times: bars.map((_, i) => T0 + i * TF), bars, tfMs: TF, now: T0 + bars.length * TF + MIN, mode: 'delta', oiJudged: true, highlight: H, ...over,
});

test('the six bands are runs of the eight size boxes, named by their dollars', () => {
  assert.deepEqual(BANDS, [[0, 0], [1, 2], [3, 4], [5, 5], [6, 6], [7, 7]]);
  assert.deepEqual(BANDS.map((_, b) => bandLabel(b)), ['< $25K', '$25K–100K', '$100K–500K', '$500K–1M', '$1M–5M', '≥ $5M']);
});

test('a sparse row is judged against its earlier NON-ZERO candles: zeros never flag and never sit in a baseline', () => {
  // Every fifth candle has an order of about $6M, the rest none; one candle holds $30M.
  const values = Array.from({ length: 400 }, (_, i) => i % 5 === 0 ? 6e6 + (i % 7) * 1e5 : 0);
  values[300] = 30e6;
  const j = judge(values, () => true, H);
  for (let i = 0; i < values.length; i++) if (values[i] === 0) { assert.equal(j.flag[i], 0); assert.ok(Number.isNaN(j.sigma[i]!)); }
  assert.equal(j.flag[300], 1, 'the giant stands out against the other large orders');
  const ordinary = values.map((v, i) => i).filter(i => values[i]! > 0 && i !== 300 && i > 80);
  assert.equal(ordinary.filter(i => j.flag[i]).length, 0, 'an ordinary large order is not unusual only because most candles had none');
  // With the zeros in a slot window (the app's rule as it is), every one of them would have flagged.
  const first = values.findIndex(v => v > 0), twelfth = values.map((v, i) => [v, i] as const).filter(([v]) => v > 0)[12]![1];
  assert.equal(j.short[first], 1, 'too few earlier candles with any: not judged yet');
  assert.ok(Number.isFinite(j.sigma[twelfth]!), 'from the thirteenth non-zero candle on it is judged');
  assert.equal(j.seen[twelfth], 12);
});

test('candles not admitted (recorded in part) are neither judged nor in a baseline', () => {
  const values = Array.from({ length: 60 }, () => 100);
  values[40] = 10_000;
  const j = judge(values, i => i !== 40, H);
  assert.ok(Number.isNaN(j.sigma[40]!)); assert.equal(j.flag[40], 0);
  assert.equal(j.seen[41], 40, 'the candle after it counts the forty admitted before it');
});

test('emphasis: nothing below half the multiple, full at the multiple, a flag on a flat baseline full', () => {
  assert.equal(emphasis(0.9, false, 2), 0);
  assert.equal(emphasis(1, false, 2), 0);
  assert.equal(emphasis(2, false, 2), 1);
  assert.equal(emphasis(5, true, 2), 1);
  assert.ok(Math.abs(emphasis(1.5, false, 2) - 0.5) < 1e-12, 'smooth, half at three quarters of the threshold');
  assert.equal(emphasis(0, true, 2), 1, 'flagged with no spread (sigma 0)');
  assert.equal(emphasis(NaN, false, 2), 0);
  assert.equal(emphasis(3, false, 4), 0.5, 'scaled with the Highlights multiple');
  assert.equal(alphaOf(0, true), QUIET_ALPHA); assert.equal(alphaOf(1, true), 1); assert.equal(alphaOf(0.3, false), PLAIN_ALPHA);
});

test('heights grow with the square root of the amount on the row\'s own scale; a lone giant is cut', () => {
  const values = new Float64Array(40).map((_, i) => (i + 1) * 1e6);
  values[39] = 1e10;
  const row = { parts: [{ values }] } as never;
  const cap = rowCap(row, Array.from({ length: 40 }, (_, i) => i));
  assert.ok(cap > 0 && cap < Math.sqrt(1e10), 'the giant does not set the scale');
  assert.equal(heightOf(1e10, cap).cut, true); assert.equal(heightOf(1e10, cap).share, 1);
  const small = heightOf(4e6, cap), larger = heightOf(16e6, cap);
  assert.ok(Math.abs(larger.share / small.share - 2) < 1e-9, 'four times the amount, twice the height');
  assert.deepEqual(heightOf(5, 0), { share: 0, cut: false });
});

test('the rows: liquidations split, open interest by its sign, six bands as delta or as buys and sells', () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i, boxes({ 0: 100, 1: 50, 2: 25, 7: i === 29 ? 9e6 : 0 }), boxes({ 0: 40, 3: 70, 4: 10 })));
  const liq = { buy: new Map(bars.map(b => [b.t, 1000] as const)), sell: new Map(bars.map(b => [b.t, 500] as const)), cut: true, cutStarts: new Set([bars[5]!.t]) };
  const oi = new Map(bars.map((b, i) => [b.t, i % 2 ? 2e6 : -1e6] as const));
  const m = buildHistory(input(bars, { liquidations: liq, oi }));
  assert.deepEqual(m.rows.map(r => r.key), ['liq', 'oi', 'size0', 'size1', 'size2', 'size3', 'size4', 'size5']);
  const [liqRow, oiRow, b0, b1, b2] = m.rows;
  assert.equal(liqRow!.parts.length, 2); assert.equal(liqRow!.parts[0]!.side, 1); assert.equal(liqRow!.parts[1]!.side, -1);
  assert.equal(liqRow!.parts[0]!.values[3], 1000); assert.equal(liqRow!.parts[1]!.values[3], 500);
  assert.equal(m.liqCut[5], 1); assert.equal(m.liqCut[4], 0);
  assert.equal(oiRow!.parts[0]!.values[1], 2e6); assert.equal(oiRow!.parts[0]!.values[2], -1e6);
  assert.equal(b0!.parts[0]!.values[0], 60, '< $25K: 100 bought, 40 sold');
  assert.equal(b1!.parts[0]!.values[0], 75, '$25K-100K: boxes 1 and 2');
  assert.equal(b2!.parts[0]!.values[0], -80, '$100K-500K: boxes 3 and 4 sold');
  assert.equal(m.rows[7]!.parts[0]!.values[29], 9e6);
  assert.equal(m.total[0], 100 + 50 + 25 + 40 + 70 + 10);
  const split = buildHistory(input(bars, { mode: 'split' }));
  assert.equal(split.rows[2]!.parts.length, 2); assert.equal(split.rows[2]!.parts[0]!.values[0], 100); assert.equal(split.rows[2]!.parts[1]!.values[0], 40);
  // Without liquidations or open interest the rows are there, every slot not known.
  assert.ok(Number.isNaN(split.rows[0]!.parts[0]!.values[0]!)); assert.ok(Number.isNaN(split.rows[1]!.parts[0]!.values[0]!));
});

test('a candle recorded in part is not judged and stays out of the baselines; a candle without a bar is not known', () => {
  const bars: (Bar | null)[] = Array.from({ length: 40 }, (_, i) => bar(i, boxes({ 0: 100 + i }), boxes({ 0: 10 }), i === 30 ? 9 : 15));
  bars[35] = null;
  const m = buildHistory(input(bars));
  assert.equal(m.partial[30], 1); assert.ok(Math.abs(m.cover[30]! - 0.6) < 1e-12);
  assert.ok(Number.isNaN(m.rows[2]!.parts[0]!.sigma[30]!), 'not judged');
  assert.ok(Number.isNaN(m.rows[2]!.parts[0]!.values[35]!), 'no bar: not known');
  // Liquidations and open interest are not the recording's: they are judged however much of the candle it holds.
  assert.equal(m.partial[29], 0);
});

test('open interest is not judged on a one-minute chart, and Highlights off judges nothing', () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i, boxes({ 0: 100 }), boxes({ 0: 10 })));
  const oi = new Map(bars.map((b, i) => [b.t, i === 25 ? 1e9 : 1e6 + i] as const));
  assert.ok(buildHistory(input(bars, { oi, oiJudged: true })).rows[1]!.parts[0]!.flag[25] === 1);
  const minute = buildHistory(input(bars, { oi, oiJudged: false }));
  assert.equal(minute.rows[1]!.parts[0]!.flag[25], 0); assert.ok(Number.isNaN(minute.rows[1]!.parts[0]!.sigma[25]!));
  const off = buildHistory(input(bars, { oi, highlight: { ...H, on: false } }));
  assert.ok(off.rows.every(r => r.parts.every(p => p.flag.every(f => f === 0))));
});

test('"k of n size rows unusual" counts a row once, whichever side flags, and only rows judged', () => {
  const bars = Array.from({ length: 40 }, (_, i) => bar(i, boxes({ 0: 100, 3: i === 39 ? 1e7 : 100 }), boxes({ 0: 50, 3: 50, 5: i === 39 ? 1e7 : 50 })));
  const m = buildHistory(input(bars, { mode: 'split' }));
  const k = unusualRows(m, 39);
  assert.equal(k.flagged, 2, 'the $100K-500K buys and the $500K-1M sells');
  assert.equal(k.judged, 3, 'the bands with any orders there: under $25K, $100K-500K and $500K-1M');
});

test('the card says the amounts, how unusual, what it is judged against, and the candle under way', () => {
  const bars = Array.from({ length: 40 }, (_, i) => bar(i, boxes({ 3: i === 39 ? 5e6 : 1e5 + i * 100 }), boxes({ 3: 4e4 })));
  const liq = { buy: new Map(bars.map(b => [b.t, 2000] as const)), sell: new Map(bars.map(b => [b.t, 0] as const)), cut: true, cutStarts: new Set([bars[39]!.t]) };
  const m = buildHistory(input(bars, { liquidations: liq }));
  const ctx = { time: '20 Nov 09:45', live: true, judging: true, oiSource: null, oiNote: null, mult: 2 } as const;
  const size = cardLines(m, 4, 39, ctx).map(l => `${l.label ?? ''}|${l.text}`);
  assert.equal(size[0], '|Market orders $100K–500K');
  assert.ok(size.includes('Candle|20 Nov 09:45 · in progress: amounts so far'));
  assert.ok(size.some(l => l.startsWith('Buys / sells|$5') && l.includes('$40')));
  assert.ok(size.some(l => /^Unusual\|\d+\.\dσ above its baseline$/.test(l)), size.join('\n'));
  assert.ok(size.includes('|Its baseline: the 39 earlier candles with orders of this size'));
  assert.ok(size.includes('Unusual size rows|1 of 1'), size.join('\n'));
  const liqCard = cardLines(m, 0, 39, { ...ctx, live: false }).map(l => `${l.label ?? ''}|${l.text}`);
  assert.ok(liqCard.some(l => l.startsWith('Shorts liquidated|≥ $')), liqCard.join('\n'));
  assert.ok(liqCard.some(l => l.includes('only its largest 5,000 are counted')));
  assert.equal(liqCard.filter(l => l.startsWith('Shorts liquidated|')).length, 1, 'the judgement is named apart from the amount');
  const spot = cardLines(m, 1, 39, { ...ctx, oiNote: 'spot' }).map(l => l.text);
  assert.ok(spot.includes('Only spot markets are counted: they have no open interest.'));
  // A chart market or chosen markets that are all spot: the liquidations row says why it has none, not "$0 liquidated".
  const spotLiq = cardLines(m, 0, 39, { ...ctx, live: false, liqNote: 'spot' }).map(l => `${l.label ?? ''}|${l.text}`);
  assert.ok(spotLiq.includes('|Only spot markets are counted: they have no liquidations.'), spotLiq.join('\n'));
  assert.ok(!spotLiq.some(l => l.startsWith('Shorts liquidated|')), 'no amounts beside the note');
  const partialBars = bars.map((b, i) => i === 20 ? { ...b, minutes: 5 } : b);
  const p = buildHistory(input(partialBars, { liquidations: liq })), lines = cardLines(p, 4, 20, ctx).map(l => `${l.label ?? ''}|${l.text}`);
  assert.ok(lines.includes('Unusual|Not judged: part of the candle was not recorded'), lines.join('\n'));
  assert.ok(lines.some(l => l.startsWith('Recorded|33 %')));
  // Liquidations are not the recording's: their card says nothing of what the recording holds.
  assert.equal(cardLines(p, 0, 20, ctx).some(l => l.label === 'Recorded'), false);
});

test('the words follow the brightness: Not unusual, Close to unusual from three quarters of the multiple, Unusual where the rule flags', () => {
  // Forty candles alternating 100 and 120 (mean 110, sd 10), then 128 (1.8 sigma: lit, not flagged), 112 (about 0.2) and 160 (flagged).
  const values = [...Array.from({ length: 40 }, (_, i) => i % 2 ? 120 : 100), 128, 112, 160];
  const bars = values.map((v, i) => bar(i, boxes({ 0: v }), boxes({ 0: 0 })));
  const m = buildHistory(input(bars)), ctx = { time: 't', live: false, judging: true, oiSource: null, oiNote: null, mult: 2 } as const;
  const label = (i: number): string | undefined => cardLines(m, 2, i, ctx).find(l => /σ/.test(l.text))?.label;
  assert.equal(label(40), 'Close to unusual');
  assert.equal(label(41), 'Not unusual');
  assert.equal(label(42), 'Unusual');
});

test('a closed candle is partial under 95 % of its minutes; the one under way only when more than its minute under way is missing', () => {
  const at = T0 + 30 * TF;
  // Ten minutes into the candle: nine recorded (the tenth not counted yet) is whole; seven recorded is partial.
  const one = buildHistory(input([bar(30, boxes({ 0: 1 }), boxes({ 0: 1 }), 9)], { times: [at], now: at + 9.5 * MIN }));
  assert.equal(one.partial[0], 0);
  const three = buildHistory(input([bar(30, boxes({ 0: 1 }), boxes({ 0: 1 }), 7)], { times: [at], now: at + 9.5 * MIN }));
  assert.equal(three.partial[0], 1);
  // Closed: 14 of 15 minutes is under 95 %, as Bar stats fades it.
  const closed = buildHistory(input([bar(30, boxes({ 0: 1 }), boxes({ 0: 1 }), 14)], { times: [at], now: at + 20 * MIN }));
  assert.equal(closed.partial[0], 1);
});

test('the history before the view: the Highlights length of candles, and at least six hours', () => {
  assert.equal(preRollMs(DEFAULT_HIGHLIGHT.length, MIN), 6 * 3_600_000, 'a one-minute chart: six hours, not 72 minutes');
  assert.equal(preRollMs(72, 3_600_000), 72 * 3_600_000);
});

/**
 * Busy and quiet candles in turn, every size's net the same part of the candle (a sixth, give or take 1 %): an amount swings threefold
 * from one candle to the next while its share hardly moves. `bump` adds to the net of band 2 ($100K-500K) on one candle.
 */
function shareBar(i: number, bump: { at: number; band: number; add: number } | null = null): Bar {
  const scale = i % 2 ? 3 : 1, buy = boxes({}), sell = boxes({});
  BANDS.forEach(([lo], b) => {
    const net = 50 * scale * (1 + 0.01 * (((i * 7 + b) % 3) - 1)) + (bump && bump.at === i && bump.band === b ? bump.add : 0);
    buy[lo] = 100 * scale + net; sell[lo] = 100 * scale;
  });
  return bar(i, buy, sell);
}

test('a size that took an unusually large part of a busy candle is marked; a quiet candle is not judged, whoever dominates it (SHARE-1)', () => {
  // Candle 81 is busy: $100K-500K nets 154.5 where the others net about 150. Its amount is ordinary for its row (it swings 50 to 150),
  // its share (17.1 % against a sixth, give or take a fraction of a percent) is not.
  const bars = Array.from({ length: 90 }, (_, i) => shareBar(i, i === 81 ? { at: 81, band: 2, add: 3 } : i === 82 ? { at: 82, band: 0, add: 50 } : null));
  const m = buildHistory(input(bars));
  assert.equal(m.shareKind, 'net');
  const mark = m.share![2]!;
  assert.equal(mark.flag[81], 1, 'its share stands out');
  assert.ok(Math.abs(mark.value[81]! - 154.5 / 903) < 1e-9, String(mark.value[81]));
  assert.ok(Math.abs(mark.usual[81]! - 1 / 6) < 2e-3, 'against what it usually is on busy candles');
  assert.equal(m.rows[4]!.parts[0]!.flag[81], 0, 'and its amount is not unusual');
  assert.equal(shareDot(m, m.rows[4]!, 81, 2), true, 'nor lit: this is what the dot is for');
  assert.equal(m.share!.filter(s => s.flag[81] === 1).length, 1, 'only that size');
  // Candle 82 is quiet (its six nets add up to well under the median of the candles before it): under $25K nets twice the others there,
  // a large part of a small candle, which says the others stepped away rather than that small orders rushed in. Not judged.
  assert.ok(m.share![0]!.value[82]! > 0.25, 'its share is large');
  assert.equal(m.share![0]!.flag[82], 0, 'but a quiet candle is not judged');
  assert.ok(Number.isNaN(m.share![0]!.usual[82]!));
  // Ordinary candles are not marked: busy or quiet, every share is a sixth.
  for (let i = 20; i < 80; i++) for (const s of m.share!) assert.equal(s.flag[i], 0, `candle ${i}`);
});

test('the share is judged against the same candles wherever the view starts, and needs a dozen judged candles before it', () => {
  const bars = Array.from({ length: 90 }, (_, i) => shareBar(i, { at: 81, band: 2, add: 30 }));
  const whole = buildHistory(input(bars)).share![2]!;
  for (const from of [5, 9]) {
    const later = buildHistory(input(bars.slice(from), { times: bars.slice(from).map(b => b.t) })).share![2]!;
    assert.equal(later.flag[81 - from], whole.flag[81], `a view starting at candle ${from}`);
    assert.equal(later.usual[81 - from], whole.usual[81], 'against the very same shares');
  }
  // The first candles have too few earlier candles for the busy median (12) and the baseline (12 judged ones): none is judged.
  for (let i = 0; i < 12; i++) assert.ok(Number.isNaN(whole.usual[i]!), `candle ${i}`);
});

test('a candle recorded in part is neither judged nor in a share baseline; Highlights off works out no shares', () => {
  const bars = Array.from({ length: 90 }, (_, i) => i === 79 ? { ...shareBar(i), minutes: 6 } : shareBar(i, { at: 81, band: 2, add: 30 }));
  const m = buildHistory(input(bars));
  for (const s of m.share!) { assert.ok(Number.isNaN(s.value[79]!), 'partial: not worked out'); assert.equal(s.flag[79], 0); }
  assert.equal(m.share![2]!.flag[81], 1, 'the candles around it are judged as before');
  assert.equal(buildHistory(input(bars, { highlight: { ...H, on: false } })).share, null);
});

test('with Buys and sells bars a size is judged on its buys plus sells against the candle\'s market orders', () => {
  const bars = Array.from({ length: 90 }, (_, i) => shareBar(i, { at: 81, band: 2, add: 400 }));
  const m = buildHistory(input(bars, { mode: 'split' }));
  assert.equal(m.shareKind, 'volume');
  const mark = m.share![2]!, volume = (300 + 150 + 400) + 300, others = 5 * ((300 + 150) + 300);
  assert.ok(Math.abs(mark.value[81]! - volume / (volume + others)) < 2e-3, String(mark.value[81]));
  assert.equal(mark.flag[81], 1);
});

test('the card gives the share, and where it is unusual what it usually is; the dot is explained where the bar is not lit', () => {
  const ctx = { time: 't', live: false, judging: true, oiSource: null, oiNote: null, mult: 2 } as const;
  const net = buildHistory(input(Array.from({ length: 90 }, (_, i) => shareBar(i, { at: 81, band: 2, add: 3 }))));
  const lines = cardLines(net, 4, 81, ctx);
  const share = lines.find(l => l.label === 'Share of the net');
  assert.equal(share?.text, '17.1% · unusual: usually 16.7%', 'its net, 154.5 of 903 (the others give or take 1 %), to the decimal that tells it from a sixth'); assert.equal(share?.bold, true);
  assert.ok(lines.some(l => l.color === 'muted' && l.text.startsWith('The dot: this size\'s net was an unusually large part')), lines.map(l => l.text).join('\n'));
  const dot = lines.findIndex(l => l.text.startsWith('The dot:')), baseline = lines.findIndex(l => l.text.startsWith('Its baseline'));
  assert.ok(baseline > 0 && dot > baseline, 'under the judgement and what it was judged against, not between them');
  assert.equal(cardLines(net, 4, 80, ctx).find(l => l.label === 'Share of the net')?.bold, undefined, 'an ordinary share is said plainly');
  assert.equal(cardLines(net, 4, 81, { ...ctx, judging: false }).some(l => l.label === 'Share of the net'), false, 'Highlights off: no share judged');
  // Buys and sells: the share of volume carries it, to the decimals that tell it from what it usually is.
  const split = buildHistory(input(Array.from({ length: 90 }, (_, i) => shareBar(i, { at: 81, band: 2, add: 40 })), { mode: 'split' }));
  const vol = cardLines(split, 4, 81, ctx).find(l => l.label === 'Share of volume');
  assert.equal(split.share![2]!.flag[81], 1);
  assert.match(vol?.text ?? '', /^17\.\d% · unusual: usually 16\.\d%$/, vol?.text);
  // A bar lit for its own amount says so itself: its share is still given, the dot is neither drawn nor explained.
  const lit = buildHistory(input(Array.from({ length: 90 }, (_, i) => shareBar(i, { at: 81, band: 2, add: 2_000 }))));
  assert.equal(lit.rows[4]!.parts[0]!.flag[81], 1);
  const litLines = cardLines(lit, 4, 81, ctx);
  assert.ok(litLines.some(l => l.label === 'Share of the net' && l.text.includes('unusual')));
  assert.equal(litLines.some(l => l.text.startsWith('The dot:')), false);
});

test('the share baseline holds only the candles that reach the floor: quiet candles of another make-up never sit in it (review 2026-11-21)', () => {
  // Quiet candles are mostly small orders (under $25K half of them); busy ones a sixth each. On busy candle 81 the small orders take a
  // fifth: unusual against the busy candles (a sixth, give or take a fraction), ordinary against all of them (a third on average).
  const bars = Array.from({ length: 90 }, (_, i) => {
    const busy = i % 2 === 1, buy = boxes({}), sell = boxes({});
    BANDS.forEach(([lo], b) => {
      const jitter = 1 + 0.01 * (((i * 7 + b) % 3) - 1);
      const net = busy ? (i === 81 && b === 0 ? 225 : 150 * jitter) : b === 0 ? 250 * jitter : 50 * jitter;
      buy[lo] = 100 + net; sell[lo] = 100;
    });
    return bar(i, buy, sell);
  });
  const m = buildHistory(input(bars));
  assert.ok(Math.abs(m.share![0]!.value[81]! - 225 / (225 + 5 * 150)) < 3e-3);
  assert.equal(m.share![0]!.flag[81], 1, 'judged against the busy candles alone');
  assert.ok(Math.abs(m.share![0]!.usual[81]! - 1 / 6) < 3e-3, 'whose small orders take a sixth');
});

test('a flat baseline: a share equal to every share before it is not unusual, one above it is', () => {
  // Every busy candle exactly a sixth each (no jitter), quiet candles too; candle 81 the same, candle 83 a little more for band 2.
  const flat = (i: number, extra = 0): Bar => {
    const scale = i % 2 ? 3 : 1, buy = boxes({}), sell = boxes({});
    BANDS.forEach(([lo], b) => { buy[lo] = 100 * scale + 50 * scale + (b === 2 ? extra : 0); sell[lo] = 100 * scale; });
    return bar(i, buy, sell);
  };
  const m = buildHistory(input(Array.from({ length: 90 }, (_, i) => flat(i, i === 83 ? 3 : 0))));
  assert.equal(m.share![2]!.flag[81], 0, 'the same as every one before it');
  assert.equal(m.share![2]!.usual[81], 1 / 6);
  assert.equal(m.share![2]!.flag[83], 1, 'above a flat baseline');
});

test('a candle with no bar inside the window is left out of the floor and the baseline; a short Highlights baseline still judges over 36 candles', () => {
  const bars: (Bar | null)[] = Array.from({ length: 90 }, (_, i) => shareBar(i, { at: 81, band: 2, add: 30 }));
  bars[60] = null; bars[61] = null;
  const m = buildHistory(input(bars));
  assert.ok(Number.isNaN(m.share![2]!.value[60]!));
  assert.equal(m.share![2]!.flag[81], 1, 'judged as before, over the candles that are there');
  // A Highlights baseline of 12 candles: about half of them reach the floor, fewer than the twelve a baseline needs, so the share is taken
  // over 36 candles (SHARE_MIN_SLOTS) and still judged.
  const short = buildHistory(input(bars, { highlight: { ...H, length: 12 } }));
  assert.equal(short.share![2]!.flag[81], 1);
  assert.equal(SHARE_MIN_SLOTS, 36);
  assert.equal(preRollMs(12, 3_600_000), 36 * 3_600_000, 'and the history before the view reaches that far');
});

test('the dot: an unusual share on a whole candle whose bar is not lit past half; the card explains it only where the pane draws it', () => {
  const ctx = { time: 't', live: false, judging: true, oiSource: null, oiNote: null, mult: 2 } as const;
  const m = buildHistory(input(Array.from({ length: 90 }, (_, i) => shareBar(i, { at: 81, band: 2, add: 3 }))));
  const row = m.rows[4]!;
  assert.equal(shareDot(m, row, 81, 2), true);
  assert.equal(shareDot(m, row, 80, 2), false, 'an ordinary share');
  assert.equal(shareDot(m, m.rows[2]!, 81, 2), false, 'another size');
  assert.equal(shareDot({ ...m, partial: m.partial.map((p, i) => i === 81 ? 1 : p) }, row, 81, 2), false, 'a candle recorded in part');
  // Its amount at 1.9 standard deviations: the bar is almost fully lit (the card says Close to unusual), so the dot would only repeat it.
  const at = (z: number) => ({ ...row, parts: row.parts.map(p => ({ ...p, sigma: p.sigma.map((s, i) => i === 81 ? z : s), flag: p.flag })) });
  assert.equal(shareDot(m, at(1.9), 81, 2), false);
  assert.equal(shareDot(m, at(1.6), 81, 2), false, 'past three quarters of the multiple: Close to unusual on the card');
  assert.equal(shareDot(m, at(1.5), 81, 2), false, 'on it too, where the card starts saying so');
  assert.equal(shareDot(m, at(1.4), 81, 2), true, 'short of it: Not unusual');
  assert.equal(shareDot(m, at(2.9), 81, 4), true, 'three quarters of a multiple of 4 is 3');
  assert.ok(cardLines(m, 4, 81, ctx).some(l => l.text.startsWith('The dot: this size\'s net was an unusually large part of the six sizes\' nets counted without their signs')));
  assert.equal(cardLines(m, 4, 81, { ...ctx, dots: false }).some(l => l.text.startsWith('The dot:')), false, 'a row too thin, or candles too narrow, for a dot');
  assert.equal(cardLines(m, 4, 81, { ...ctx, dots: false }).find(l => l.label === 'Share of the net')?.wrap, true, 'the share still said, on a line that wraps');
});

test('shareMarks equals the rule written out plainly (a sort for each candle, two passes for the spread) on random candles at every baseline length', () => {
  let seed = 12345;
  const rand = (): number => { seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0; return seed / 4_294_967_296; };
  for (const [length, mult] of [[12, 2], [24, 1], [72, 2], [150, 4], [36, 1.5]] as const) {
    const n = 400, parts = BANDS.map(() => new Float64Array(n)), admitted = Array.from({ length: n }, () => rand() > 0.04);
    for (let i = 0; i < n; i++) {
      const busy = rand() < 0.5 ? 1 : 3;
      parts.forEach((p, b) => { p[i] = rand() < 0.1 * b ? 0 : busy * (50 + 100 * rand()) * (b === 0 && rand() < 0.3 ? 4 : 1); });
      if (rand() < 0.02) parts[2]![i] = NaN;
    }
    const got = shareMarks(parts, i => admitted[i]!, { mult, length });
    // The rule as the doc says it, with no shortcut.
    const span = Math.max(length, SHARE_MIN_SLOTS), sum = Array.from({ length: n }, (_, i) => {
      if (!admitted[i]) return NaN;
      const s = parts.reduce((a, p) => a + p[i]!, 0);
      return Number.isFinite(s) && s > 0 ? s : NaN;
    });
    parts.forEach((p, b) => {
      for (let i = 0; i < n; i++) {
        const before = sum.slice(Math.max(0, i - span), i).filter(x => x > 0).sort((a, c) => a - c), m = before.length;
        const x0 = sum[i]! > 0 ? p[i]! / sum[i]! : NaN;
        let flag = 0, usual = NaN;
        if (sum[i]! > 0 && m >= 12 && x0 > 0) {
          const floor = m % 2 ? before[m >> 1]! : (before[m / 2 - 1]! + before[m / 2]!) / 2;
          if (sum[i]! >= floor) {
            const base: number[] = [];
            for (let j = Math.max(0, i - span); j < i; j++) { const x = p[j]! / sum[j]!; if (sum[j]! >= floor && x > 0) base.push(x); }
            if (base.length >= 12) {
              const mean = base.reduce((a, x) => a + x, 0) / base.length, sd = Math.sqrt(base.reduce((a, x) => a + (x - mean) ** 2, 0) / base.length);
              usual = mean; flag = x0 > mean + mult * sd ? 1 : 0;
            }
          }
        }
        assert.equal(got[b]!.flag[i], flag, `length ${length}, mult ${mult}, band ${b}, candle ${i}`);
        if (Number.isNaN(usual)) assert.ok(Number.isNaN(got[b]!.usual[i]!), `length ${length}, band ${b}, candle ${i}: not judged`);
        else assert.ok(Math.abs(got[b]!.usual[i]! - usual) < 1e-12, `length ${length}, band ${b}, candle ${i}: ${got[b]!.usual[i]} against ${usual}`);
      }
    });
  }
});

test('with Buys and sells either side lit takes the dot away; a candle exactly at the floor is judged', () => {
  const split = buildHistory(input(Array.from({ length: 90 }, (_, i) => shareBar(i, { at: 81, band: 2, add: 40 })), { mode: 'split' }));
  const row = split.rows[4]!;
  assert.equal(shareDot(split, row, 81, 2), true, 'neither side lit');
  const lit = (side: number) => ({ ...row, parts: row.parts.map((p, k) => k === side ? { ...p, sigma: p.sigma.map((s, i) => i === 81 ? 1.9 : s) } : p) });
  assert.equal(shareDot(split, lit(0), 81, 2), false, 'the buys lit');
  assert.equal(shareDot(split, lit(1), 81, 2), false, 'the sells lit');
  // Every candle the same: each one's sum is the median of the ones before it, and it is judged (at least the usual, not more).
  const even = (i: number): Bar => { const buy = boxes({}), sell = boxes({}); BANDS.forEach(([lo]) => { buy[lo] = 150; sell[lo] = 100; }); return bar(i, buy, sell); };
  const m = buildHistory(input(Array.from({ length: 60 }, (_, i) => even(i))));
  assert.equal(m.share![2]!.usual[50], 1 / 6, 'judged, against a sixth');
  assert.equal(m.share![2]!.flag[50], 0);
});
