import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowBook } from '../src/app/flow-book.ts';
import { Ranker } from '../src/app/cvd/rank.ts';
import { buildModel, type CvdModel } from '../src/app/cvd/model.ts';
import { CVD_DEFAULTS, readCvd } from '../src/app/cvd/settings.ts';
import { aggregateHover, aggregateLabel, divergence, rowHover, rowLabel, signedUsd, windowName } from '../src/app/cvd/text.ts';
import { hueGap, hueOf, laneColors } from '../src/app/cvd/colors.ts';
import { PALETTES, contrastRatio } from '../src/app/theme.ts';

const NOW = Date.UTC(2026, 9, 6, 12, 30, 0);
const SEC = NOW / 1000;
const kinds: Record<string, 'spot' | 'perp'> = { 'binance:BTCUSDT': 'perp', 'binancespot:BTCUSDT': 'spot', 'coinbase:BTC-USD': 'spot', 'bybit:BTCUSDT': 'perp', 'okx:BTC-USDT-SWAP': 'perp', 'hyperliquid:BTC-PERP': 'perp' };
const kindOf = (id: string) => kinds[id] ?? null;

/** Per second: `buy` and `sell` USD for `seconds` seconds ending at NOW (an instrument that stopped trading `quietFor` seconds ago stops there). */
function feed(book: FlowBook, id: string, buy: number, sell: number, seconds = 7_200, quietFor = 0): void {
  const items: [string, number, number, number][] = [];
  for (let i = seconds - 1; i >= quietFor; i--) items.push([id, (SEC - i) * 1000, buy, sell]);
  book.apply(items);
}
const model = (book: FlowBook, ids: string[], over: Partial<Parameters<typeof buildModel>[0]> = {}): CvdModel => buildModel({
  flow: book, ids, kindOf, t0: NOW - 3_600_000, t1: NOW, columns: 60, now: NOW, settings: { ...CVD_DEFAULTS, span: '1h', rank: '1h' }, ranker: new Ranker(), ...over,
});

function market(): { book: FlowBook; ids: string[] } {
  const book = new FlowBook();
  feed(book, 'binance:BTCUSDT', 60_000, 40_000);          // perp: +20k/s net, 100k/s gross
  feed(book, 'binancespot:BTCUSDT', 12_000, 18_000);      // spot: -6k/s, 30k/s
  feed(book, 'coinbase:BTC-USD', 5_000, 4_000);           // 9k/s
  feed(book, 'bybit:BTCUSDT', 20_000, 30_000);            // 50k/s
  feed(book, 'hyperliquid:BTC-PERP', 1_000, 1_000);       // 2k/s
  return { book, ids: ['binance:BTCUSDT', 'binancespot:BTCUSDT', 'coinbase:BTC-USD', 'bybit:BTCUSDT', 'hyperliquid:BTC-PERP', 'nodata:BTC'] };
}

test('exchanges are ranked by volume, a spot twin shares its exchange, and an instrument with no flow is left out', () => {
  const { book, ids } = market();
  const m = model(book, ids);
  assert.deepEqual(m.rows.map(r => r.key), ['binance', 'bybit', 'coinbase', 'hyperliquid']);
  assert.deepEqual(m.rows.map(r => r.rank), [1, 2, 3, 4]);
  assert.deepEqual(m.rows[0]!.lanes.map(l => l.kind), ['spot', 'perp'], 'spot first, then perp');
  assert.equal(m.instruments, 5);
  assert.ok(Math.abs(m.rows.reduce((s, r) => s + r.share, 0) - 1) < 1e-9, 'all four are shown, so the shares make a whole');
  const perp = m.rows[0]!.lanes[1]!, spot = m.rows[0]!.lanes[0]!;
  assert.equal(perp.delta, 20_000 * 3_600); assert.equal(perp.gross, 100_000 * 3_600); assert.equal(perp.buy, 60_000 * 3_600); assert.equal(perp.sell, 40_000 * 3_600);
  assert.equal(spot.delta, -6_000 * 3_600);
});

test('the top N is strict, the rest are counted as hidden, and a pinned exchange takes the last place', () => {
  const { book, ids } = market();
  const two = model(book, ids, { settings: { ...CVD_DEFAULTS, top: 3 } });
  assert.deepEqual(two.rows.map(r => r.key), ['binance', 'bybit', 'coinbase']); assert.equal(two.hidden, 1);
  const pinned = model(book, ids, { settings: { ...CVD_DEFAULTS, top: 3, pinned: ['hyperliquid'] }, ranker: new Ranker() });
  assert.deepEqual(pinned.rows.map(r => r.key), ['binance', 'bybit', 'hyperliquid']);
  const other = model(book, ids, { settings: { ...CVD_DEFAULTS, top: 3, pinned: ['coinbase', 'hyperliquid'] }, ranker: new Ranker() });
  assert.deepEqual(other.rows.map(r => r.key), ['binance', 'coinbase', 'hyperliquid'], 'any exchange can be the pin, and several at once');
  assert.equal(model(book, ids, { settings: { ...CVD_DEFAULTS, top: 0 } }).rows.length, 4, 'top 0 shows every exchange that traded');
});

test('the ranking window decides the order: a venue big only in the last quarter hour leads the 15 minute ranking', () => {
  const book = new FlowBook();
  feed(book, 'binance:BTCUSDT', 10_000, 10_000, 7_200);                  // steady 20k/s for two hours
  feed(book, 'bybit:BTCUSDT', 1_000, 1_000, 7_200);                      // 2k/s
  const burst: [string, number, number, number][] = []; for (let i = 599; i >= 0; i--) burst.push(['bybit:BTCUSDT', (SEC - i) * 1000, 140_000, 10_000]);   // 150k/s for 10 minutes
  book.apply(burst);
  const ids = ['binance:BTCUSDT', 'bybit:BTCUSDT'];
  assert.equal(model(book, ids, { settings: { ...CVD_DEFAULTS, rank: '1h' } }).rows[0]!.key, 'bybit', 'ten heavy minutes (90M) outweigh 20k/s for the hour (72M)');
  assert.equal(model(book, ids, { settings: { ...CVD_DEFAULTS, rank: '15m' }, ranker: new Ranker() }).rows[0]!.key, 'bybit');
  const wide = new FlowBook(); feed(wide, 'binance:BTCUSDT', 10_000, 10_000, 90_000); feed(wide, 'bybit:BTCUSDT', 1_000, 1_000, 90_000);
  assert.equal(model(wide, ids, { settings: { ...CVD_DEFAULTS, rank: '24h' } }).rows[0]!.key, 'binance');
});

test('the aggregate lines are the sums of the lanes, column for column, and the lanes start at zero when rebased', () => {
  const { book, ids } = market();
  const m = model(book, ids);
  const spotLanes = m.rows.flatMap(r => r.lanes.filter(l => l.kind === 'spot')), perpLanes = m.rows.flatMap(r => r.lanes.filter(l => l.kind === 'perp'));
  for (let c = 0; c < m.columns; c++) {
    const spotSum = spotLanes.reduce((s, l) => s + l.last[c]!, 0), perpSum = perpLanes.reduce((s, l) => s + l.last[c]!, 0);
    assert.ok(Math.abs(m.spot!.last[c]! - spotSum) < 1e-3, `spot column ${c}: ${m.spot!.last[c]} vs ${spotSum}`);
    assert.ok(Math.abs(m.perp!.last[c]! - perpSum) < 1e-3, `perp column ${c}`);
  }
  const lane = m.rows[0]!.lanes[1]!;
  assert.ok(Math.abs(lane.last[0]!) <= 20_000 * 61, 'the first column is within a column of the rebased zero');
  assert.ok(lane.last[59]! > 20_000 * 3_500, 'the last column holds about an hour of net buying');
  const raw = model(book, ids, { settings: { ...CVD_DEFAULTS, rebase: false } }).rows[0]!.lanes[1]!;
  assert.ok(raw.last[0]! > lane.last[0]! + 20_000 * 3_000, 'unrebased, the running total since the history began is higher by what came before the window');
  assert.equal(m.spot!.delta, -6_000 * 3_600 + 1_000 * 3_600 + 0 * 0, 'aggregate window delta over every spot lane (binance spot and coinbase)');
});

test('an exchange with no trade in the last five completed minutes is flagged quiet, only when asked', () => {
  const book = new FlowBook();
  feed(book, 'binance:BTCUSDT', 10_000, 10_000);
  feed(book, 'bybit:BTCUSDT', 10_000, 10_000, 7_200, 700);               // stopped 700 s ago
  const ids = ['binance:BTCUSDT', 'bybit:BTCUSDT'];
  const m = model(book, ids);
  assert.deepEqual(m.rows.map(r => [r.key, r.quiet]), [['binance', false], ['bybit', true]]);
  assert.equal(model(book, ids, { settings: { ...CVD_DEFAULTS, quietFlag: false }, ranker: new Ranker() }).rows.every(r => !r.quiet), true);
});

test('an empty book makes an empty model that still has its geometry', () => {
  const m = model(new FlowBook(), ['binance:BTCUSDT']);
  assert.deepEqual([m.rows.length, m.spot, m.perp, m.hidden, m.columns], [0, null, null, 0, 60]);
});

// ---- Words ------------------------------------------------------------------------------------------------------------------------

test('figures are signed, with a real minus, and a window has a short name', () => {
  assert.equal(signedUsd(12_300_000), '+$12.3M'); assert.equal(signedUsd(-4_100_000), '−$4.1M'); assert.equal(signedUsd(0), '$0'); assert.equal(signedUsd(NaN), '–');
  assert.deepEqual([900, 3_600, 86_400].map(windowName), ['15M', '1H', '1D']);
});

test('a row label fits its height: four lines when roomy, folded lanes when short', () => {
  const { book, ids } = market();
  const m = model(book, ids), row = m.rows[0]!;
  const tall = rowLabel(row, '1H', 90, true);
  assert.equal(tall.length, 4);
  assert.equal(tall[0]!.text, '#1 BINANCE'); assert.equal(tall[0]!.bold, true);
  assert.deepEqual(tall.slice(1, 3).map(l => [l.dot, l.text]), [['spot', 'S −$21.6M'], ['perp', 'P +$72M']]);
  assert.match(tall[3]!.text, /^\d+% · \$/);
  const short = rowLabel(row, '1H', 44, true);
  assert.ok(short.length <= 3 && short[1]!.text.includes('S −$21.6M') && short[1]!.text.includes('P +$72M'), JSON.stringify(short));
  const single = rowLabel(m.rows[2]!, '1H', 90, true);
  assert.equal(single.filter(l => l.dot).length, 1, 'coinbase has one lane');
});

test('the quiet flag shows in the label of a quiet exchange only', () => {
  const book = new FlowBook(); feed(book, 'bybit:BTCUSDT', 1, 1, 7_200, 700); feed(book, 'binance:BTCUSDT', 9, 9);
  const m = model(book, ['bybit:BTCUSDT', 'binance:BTCUSDT']);
  assert.equal(rowLabel(m.rows[1]!, '1H', 90, true)[0]!.text, '#2 BYBIT !5m');
  assert.equal(rowLabel(m.rows[1]!, '1H', 90, false)[0]!.text, '#2 BYBIT');
  assert.equal(rowLabel(m.rows[0]!, '1H', 90, true)[0]!.text, '#1 BINANCE');
});

test('the aggregate label gives each kind and the total over the window, and says so when spot and perps diverge', () => {
  const { book, ids } = market();
  const m = model(book, ids);
  const label = aggregateLabel(m, 100);
  assert.equal(label[0]!.text, 'ALL VENUES');
  assert.deepEqual(label.filter(l => l.dot).map(l => l.dot), ['spot', 'perp']);
  assert.match(label.at(-1)!.text, /^Δ1H [+−]\$/);
  assert.match(divergence(m)!, /Spot is being sold/, 'perps are being bought and spot is being sold in this market');
  const calm = new FlowBook(); feed(calm, 'binance:BTCUSDT', 10_000, 9_000); feed(calm, 'binancespot:BTCUSDT', 10_000, 9_500);
  assert.equal(divergence(model(calm, ['binance:BTCUSDT', 'binancespot:BTCUSDT'])), null, 'both buying: no divergence');
});

test('hover text names the exchange, the lanes and what they did, and a divergence is stated', () => {
  const { book, ids } = market();
  const m = model(book, ids);
  const lines = rowHover(m.rows[0]!, 30, NOW - 1_800_000, '1H');
  assert.equal(lines[0]!.text, 'Binance · #1');
  assert.ok(lines.some(l => l.label === 'Spot CVD here' && /^[+−]\$/.test(l.text)));
  assert.ok(lines.some(l => l.label === 'Perp net, 1H' && l.text === '+$72M'));
  assert.ok(lines.some(l => l.label === 'Share of all volume'));
  const agg = aggregateHover(m, 30, NOW - 1_800_000, '1H');
  assert.equal(agg[0]!.text, 'All venues');
  // perps net +72M+(-)… bybit is net -30k/s: perp delta = (20k - 10k)*3600 = +36M; spot = (-6k+1k)*3600 = -18M: opposite signs
  assert.match(divergence(m)!, /being sold while perpetuals are being bought/);
  assert.ok(agg.some(l => l.wrap && /perpetuals are being bought/.test(l.text)));
  const quietHalf = model(book, ids, { settings: { ...CVD_DEFAULTS, top: 2 }, ranker: new Ranker() });
  assert.ok(aggregateHover(quietHalf, 0, NOW, '1H').some(l => /more venues have traded/.test(l.text)));
});

test('settings read from storage field by field and never come out invalid', () => {
  assert.deepEqual(readCvd(undefined), CVD_DEFAULTS); assert.deepEqual(readCvd('nonsense'), CVD_DEFAULTS);
  const s = readCvd({ span: '4h', rank: '24h', top: 2, heights: 'equal', auto: false, refreshMin: 500, pinned: ['kraken', 'kraken', 7, '', 'okx'], quietFlag: 'yes', rebase: false, extra: 1 });
  assert.deepEqual(s, { span: '4h', rank: '24h', top: 3, heights: 'equal', auto: false, refreshMin: 60, pinned: ['kraken', 'okx'], quietFlag: true, rebase: false });
  assert.deepEqual(readCvd({ pinHyperliquid: true }).pinned, ['hyperliquid'], 'a save from before the list kept Hyperliquid pinned');
  assert.deepEqual(readCvd({ pinHyperliquid: true, pinned: ['okx'] }).pinned, ['okx'], 'the list wins over the old switch');
  assert.deepEqual(readCvd({ pinned: 'okx' }).pinned, [], 'not a list');
  assert.equal(readCvd({ pinned: Array.from({ length: 80 }, (_, i) => `v${i}`) }).pinned.length, 32, 'bounded');
  assert.equal(readCvd({ top: 0 }).top, 0, 'zero means every exchange');
  assert.equal(readCvd({ span: '7d', rank: '5m', heights: 'tall', top: NaN }).span, 'map');
});

test('lane colours stand 3:1 clear of the panel on every theme and are distinct', () => {
  for (const [id, palette] of Object.entries(PALETTES)) {
    const c = laneColors(palette);
    assert.ok(contrastRatio(c.spot, palette.panel) >= 3 - 1e-9, `${id} spot ${contrastRatio(c.spot, palette.panel)}`);
    assert.ok(contrastRatio(c.perp, palette.panel) >= 3 - 1e-9, `${id} perp ${contrastRatio(c.perp, palette.panel)}`);
    assert.notEqual(c.spot, c.perp);
  }
});

test('lane colours are the same blue and amber on every theme, except where a theme\'s buy and sell colours are near them', () => {
  const spots = new Map<string, string>();
  for (const [id, palette] of Object.entries(PALETTES)) {
    const c = laneColors(palette);
    spots.set(id, c.spot);
    for (const line of [c.spot, c.perp]) for (const direction of [palette.bid, palette.ask, palette.candleUp, palette.candleDown]) {
      const a = hueOf(line), b = hueOf(direction);
      if (a !== null && b !== null) assert.ok(hueGap(a, b) >= 25, `${id}: a lane line (${line}) must not look like the theme's buy or sell (${direction}), ${hueGap(a, b).toFixed(0)} degrees apart`);
    }
    const spotHue = hueOf(c.spot)!, perpHue = hueOf(c.perp)!;
    assert.ok(hueGap(spotHue, perpHue) >= 60, `${id}: spot and perpetual are two different hues`);
  }
  const blues = [...spots].filter(([id]) => id !== 'colorblind').map(([, color]) => hueOf(color)!);
  assert.ok(blues.every(h => hueGap(h, hueOf('#3d8bfd')!) < 12), 'blue, give or take the nudge toward the text colour that contrast asks for');
  assert.ok(hueGap(hueOf(spots.get('colorblind')!)!, hueOf('#3d8bfd')!) > 60, 'the colour-blind theme has a hue that is not its buy colour');
});

test('the aggregate label says which kind it is and how many exchanges the filter leaves out', () => {
  const { book, ids } = market();
  const m = model(book, ids);
  assert.equal(aggregateLabel(m, 100)[0]!.text, 'ALL VENUES');
  const spot = aggregateLabel(m, 120, { kind: 'spot', hidden: 6 });
  assert.equal(spot[0]!.text, 'ALL SPOT VENUES'); assert.equal(spot.at(-1)!.text, '6 filtered out'); assert.equal(spot.at(-1)!.tone, 'muted');
  assert.equal(aggregateLabel(m, 120, { kind: 'perp', hidden: 0 })[0]!.text, 'ALL PERP VENUES');
  assert.ok(!aggregateLabel(m, 120, { kind: 'perp', hidden: 0 }).some(l => /hidden/.test(l.text)), 'nothing hidden, nothing said');
  assert.ok(aggregateLabel(m, 60, { kind: 'spot', hidden: 6 }).length <= 4, 'a short row keeps to its height');
});
