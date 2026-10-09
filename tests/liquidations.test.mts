import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BinanceLiquidations, BybitConnector, BybitSpotConnector, DeribitConnector, OkxConnector, OkxSpotConnector } from '../src/shared/venues.ts';
import { LiquidationStream, fromWire, toWire, type Liquidation, type LiquidationEvent, type LiquidationStore } from '../src/shared/liquidations.ts';
import { LiquidationStream as SqliteLiquidations } from '../src/server/v2/liquidations.mts';
import { LiquidationBook, coverageLines, liquidationHidden, liquidationLines, readLiquidations, LIQUIDATION_DEFAULTS } from '../src/app/liquidations.ts';
import { rangeLines, type RangeInput } from '../src/app/range/stats.ts';

// Frames recorded live on 2026-10-09 (scratchpad probe, 20 min): one per venue, as the exchange sent it.
const BINANCE = '{"stream":"!forceOrder@arr","data":{"e":"forceOrder","E":1791565603055,"o":{"s":"BTCUSDT","S":"SELL","o":"LIMIT","f":"IOC","q":"0.190","p":"82338.30","ap":"82651.90","X":"FILLED","l":"0.155","z":"0.190","T":1791565602120,"ps":"BTCUSDT","st":1}}}';
const BYBIT = '{"topic":"allLiquidation.BTCUSDT","type":"snapshot","ts":1791565601482,"data":[{"T":1791565600992,"s":"BTCUSDT","S":"Buy","v":"0.006","p":"82396.90"},{"T":1791565601058,"s":"BTCUSDT","S":"Buy","v":"0.038","p":"82394.30"}]}';
const OKX = '{"arg":{"channel":"liquidation-orders","instType":"SWAP"},"data":[{"details":[{"bkLoss":"0","bkPx":"82655.7","ccy":"","posSide":"long","side":"sell","sz":"8.55","ts":"1791565600771"}],"instFamily":"BTC-USDT","instId":"BTC-USDT-SWAP","instType":"SWAP","uly":"BTC-USDT"}]}';
const OKX_OTHER = '{"arg":{"channel":"liquidation-orders","instType":"SWAP"},"data":[{"details":[{"bkLoss":"0","bkPx":"0.09583","ccy":"","posSide":"short","side":"buy","sz":"19979","ts":"1791565462608"}],"instFamily":"CELO-USDT","instId":"CELO-USDT-SWAP","instType":"SWAP","uly":"CELO-USDT"}]}';

const collect = <C extends { onLiquidation: (e: LiquidationEvent) => void; onMessage(text: string): void }>(connector: C, ...frames: string[]): LiquidationEvent[] => {
  const out: LiquidationEvent[] = []; connector.onLiquidation = e => out.push(e);
  for (const frame of frames) connector.onMessage(frame);
  return out;
};
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));

test('Binance: a forced SELL closes a long, at its average fill price, its filled size; another market\'s and the mark price are not liquidations', () => {
  const [e, ...rest] = collect(new BinanceLiquidations(), BINANCE, BINANCE.replace(/BTCUSDT/g, 'ETHUSDT'), '{"stream":"btcusdt@markPrice@1s","data":{"e":"markPriceUpdate","E":1,"s":"BTCUSDT","p":"82650"}}');
  assert.equal(rest.length, 0);
  assert.equal(e!.instrumentId, 'binance:BTCUSDT'); assert.equal(e!.side, 'long'); assert.equal(e!.kind, 'fill');
  assert.equal(e!.price, 82651.9); assert.equal(e!.amount, 0.19); assert.ok(close(e!.notionalUsd, 82651.9 * 0.19)); assert.equal(e!.t, 1791565602120);
});

test('Bybit: S is the side of the position closed (Buy: a long), p its bankruptcy price; the spot socket does not ask for them', () => {
  const events = collect(new BybitConnector(), BYBIT);
  assert.deepEqual(events.map(e => [e.side, e.kind, e.price, e.amount]), [['long', 'bankruptcy', 82396.9, 0.006], ['long', 'bankruptcy', 82394.3, 0.038]]);
  const subscribed: unknown[] = []; (new BybitSpotConnector() as unknown as { open(send: (p: unknown) => void): void }).open(p => subscribed.push(p));
  assert.ok(!JSON.stringify(subscribed).includes('allLiquidation'));
  const linear: unknown[] = []; (new BybitConnector() as unknown as { open(send: (p: unknown) => void): void }).open(p => linear.push(p));
  assert.ok(JSON.stringify(linear).includes('allLiquidation.BTCUSDT'));
});

test('OKX: posSide is the side closed, sizes are contracts, bkPx is taken as a fill (it was measured at the mark), and only its own market is taken from the channel of every swap', () => {
  const okx = new OkxConnector();
  const [e, ...rest] = collect(okx, OKX, OKX_OTHER);
  assert.equal(rest.length, 0, 'another swap\'s liquidation is not this market\'s');
  assert.equal(e!.instrumentId, 'okx:BTC-USDT-SWAP'); assert.equal(e!.side, 'long'); assert.equal(e!.kind, 'fill');
  assert.ok(close(e!.amount, 8.55 * okx.contract), 'contracts times the contract size'); assert.ok(close(e!.notionalUsd, 82655.7 * 8.55 * okx.contract));
  // A net position says only the forced order's side: a sell closes a long.
  const net = collect(new OkxConnector(), OKX.replace('"posSide":"long"', '"posSide":"net"'));
  assert.equal(net[0]!.side, 'long');
  const spot: unknown[] = []; (new OkxSpotConnector() as unknown as { open(send: (p: unknown) => void): void }).open(p => spot.push(p));
  assert.ok(!JSON.stringify(spot).includes('liquidation-orders'), 'spot has no liquidations');
});

test('Deribit: a flagged fill is a liquidation of the taker (T), the maker (M) or both, and one forced order\'s fills add up to one', () => {
  // The documented format (no forced fill came during the probe): an inverse perpetual sizes in USD.
  const frame = (rows: unknown[]) => JSON.stringify({ jsonrpc: '2.0', method: 'subscription', params: { channel: 'trades.BTC-PERPETUAL.100ms', data: rows } });
  const fill = (id: number, direction: string, price: number, usdAmount: number, t: number, liquidation?: string) => ({ trade_id: String(id), direction, price, amount: usdAmount, timestamp: t, ...(liquidation ? { liquidation } : {}) });
  const events = collect(new DeribitConnector(), frame([
    fill(1, 'sell', 80_000, 50_000, 10, 'T'), fill(2, 'sell', 79_990, 30_000, 10, 'T'), // one forced sell, two fills: a long closed
    fill(3, 'buy', 80_100, 20_000, 11, 'M'), // the maker sold: a long closed, passively
    fill(4, 'buy', 80_200, 10_000, 12, 'MT'), // both: a short (the taker bought) and a long (the maker sold)
    fill(5, 'sell', 80_000, 99_000, 13), // not forced
  ]));
  assert.deepEqual(events.map(e => [e.t, e.side, Math.round(e.notionalUsd)]), [[10, 'long', 80_000], [11, 'long', 20_000], [12, 'short', 10_000], [12, 'long', 10_000]]);
  const first = events[0]!;
  assert.ok(close(first.price, 80_000 / (50_000 / 80_000 + 30_000 / 79_990)), 'the volume-weighted price of its fills');
  assert.equal(first.kind, 'fill');
  // The same fills again, batched differently (a replay after a reconnect): known trade ids add nothing.
  const deribit = new DeribitConnector(), once = collect(deribit, frame([fill(7, 'sell', 80_000, 300, 20, 'T')]));
  assert.deepEqual(collect(deribit, frame([fill(7, 'sell', 80_000, 300, 20, 'T')]), frame([fill(8, 'sell', 80_000, 200, 20, 'T')])).map(e => Math.round(e.notionalUsd)), [200], 'only the new fill');
  assert.equal(once.length, 1);
});

const event = (over: Partial<LiquidationEvent> = {}): LiquidationEvent => ({ instrumentId: 'bybit:BTCUSDT', t: 1_000, side: 'long', price: 80_000, amount: 0.1, notionalUsd: 8_000, kind: 'fill', ...over });

test('a liquidation is kept once, above the floor, and a bankruptcy price is drawn at the last trade within a minute of its own time', () => {
  const stream = new LiquidationStream(null, () => 1_000_000);
  const market = (id: string) => id === 'bybit:BTCUSDT' ? { price: 80_200, at: 1_500 } : null;
  const added = stream.ingest([event(), event(), event({ notionalUsd: 50 }), event({ t: 2_000, kind: 'bankruptcy', price: 79_900 }), event({ instrumentId: 'okx:BTC-USDT-SWAP', t: 3_000, kind: 'bankruptcy', price: 79_800 })], market);
  assert.equal(added.length, 3, 'a repeat and one under the floor are left out');
  assert.deepEqual(added.map(l => [l.price, l.reported, l.kind]), [[80_000, 80_000, 'fill'], [80_200, 79_900, 'bankruptcy'], [79_800, 79_800, 'bankruptcy']], 'no market price known: the reported one');
  // Sent eight minutes late (OKX once did): the last trade is of now, not of the market when it happened.
  const late = stream.ingest([event({ t: 4_000, kind: 'bankruptcy', price: 79_700 })], () => ({ price: 80_200, at: 4_000 + 480_000 }));
  assert.equal(late[0]!.price, 79_700, 'a late report keeps its own price');
  const stale = stream.ingest([event({ t: 200_000, kind: 'bankruptcy', price: 79_600 })], () => ({ price: 80_200, at: 80_000 }));
  assert.equal(stale[0]!.price, 79_600, 'a last trade two minutes before it is not where the market was');
  assert.deepEqual(stream.takeFresh().length, 5); assert.deepEqual(stream.takeFresh(), []);
});

test('a window is answered with its largest when there are more than the limit, from memory and from the store; a restart counts none twice', () => {
  const rows: Liquidation[] = [];
  const store: LiquidationStore = { load: () => [...rows], save: (more, before) => { rows.push(...more); rows.splice(0, rows.length, ...rows.filter(r => r.t >= before)); }, close: () => {} };
  const stream = new LiquidationStream(store, () => 10_000);
  stream.ingest([1, 2, 3, 4, 5].map(i => event({ t: i * 100, notionalUsd: i * 1_000 })));
  assert.deepEqual(stream.query(0, 1_000, 0, 2).map(l => l.usd), [4_000, 5_000], 'the two largest, oldest first');
  assert.deepEqual(stream.query(0, 1_000, 3_000).map(l => l.usd), [3_000, 4_000, 5_000]);
  stream.flush();
  const again = new LiquidationStream(store, () => 10_000);
  assert.deepEqual(again.ingest([event({ t: 300, notionalUsd: 3_000 })]), [], 'the feed sent it again after a restart');
  assert.equal(again.query(0, 1_000).length, 5);
});

test('SQLite keeps them across a restart and answers a window from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-liq-')), file = path.join(dir, 'l.sqlite');
  try {
    const first = new SqliteLiquidations(file, () => 10_000);
    first.ingest([event({ t: 100 }), event({ t: 200, side: 'short', kind: 'bankruptcy', price: 81_000, notionalUsd: 20_000 })], () => ({ price: 80_500, at: 10_000 }));
    first.close();
    const again = new SqliteLiquidations(file, () => 10_000);
    assert.deepEqual(again.query(0, 1_000).map(l => [l.t, l.side, l.price, l.reported, l.kind]), [[100, 'long', 80_000, 80_000, 'fill'], [200, 'short', 80_500, 81_000, 'bankruptcy']]);
    again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the wire row carries every field and a malformed one is dropped', () => {
  const l: Liquidation = { t: 5, id: 'okx:BTC-USDT-SWAP', side: 'short', price: 80_000, usd: 12_345, reported: 80_100, kind: 'bankruptcy' };
  assert.deepEqual(fromWire(toWire(l)), l);
  for (const bad of [null, [], [5, 'x', 'long', 1, 1, 1], [5, 'x', 'both', 1, 1, 1, 'fill'], [5, 'x', 'long', 0, 1, 1, 'fill'], [5, 'x', 'long', 1, 1, 1, 'mark']]) assert.equal(fromWire(bad), null, JSON.stringify(bad));
});

test('the page: settings checked field by field, the side and size filter, and the book without duplicates', () => {
  assert.deepEqual(readLiquidations(undefined), LIQUIDATION_DEFAULTS);
  assert.deepEqual(readLiquidations({ on: false, minUsd: 7_000, side: 'short', scale: 3, labels: false }), { on: false, minUsd: 5_000, side: 'short', scale: 2, labels: false });
  assert.deepEqual(readLiquidations({ side: 'both ways', scale: 'big', minUsd: 1 }), { ...LIQUIDATION_DEFAULTS, minUsd: LIQUIDATION_DEFAULTS.minUsd });
  const l: Liquidation = { t: 5, id: 'bybit:BTCUSDT', side: 'long', price: 80_000, usd: 2_000, reported: 80_000, kind: 'fill' };
  assert.equal(liquidationHidden(l, { ...LIQUIDATION_DEFAULTS, minUsd: 5_000 }), true);
  assert.equal(liquidationHidden(l, { ...LIQUIDATION_DEFAULTS, side: 'short' }), true);
  assert.equal(liquidationHidden(l, LIQUIDATION_DEFAULTS), false);
  const book = new LiquidationBook();
  assert.equal(book.add([l, { ...l }]).length, 1); assert.equal(book.add([l]).length, 0);
});

test('the panel says which venues report liquidations: spot markets and the venues that publish none are said apart', () => {
  const lines = coverageLines([{ venue: 'binance', spot: false }, { venue: 'binance', spot: true }, { venue: 'bybit', spot: false }, { venue: 'okx', spot: false }, { venue: 'hyperliquid', spot: false }, { venue: 'coinbase', spot: true }, { venue: 'bybitspot', spot: true }]);
  assert.deepEqual(lines.map(l => l.text), [
    'Reported: Bybit, OKX.',
    'Only the largest each second: Binance, so a cascade there shows fewer than happened.',
    'Not reported by the exchange: Hyperliquid, Coinbase, Bybit spot.',
  ]);
});

test('the box names the side, the venue, both prices of a bankruptcy report and Binance\'s throttle', () => {
  const bybit = liquidationLines({ t: Date.UTC(2026, 9, 9, 12, 0, 5), id: 'bybit:BTCUSDT', side: 'long', price: 80_200, usd: 125_000, reported: 79_900, kind: 'bankruptcy' });
  assert.equal(bybit[0]!.text, 'LONGS LIQUIDATED  $125K'); assert.equal(bybit[0]!.color, 'sell'); assert.equal(bybit[0]!.mark, 'bybit:BTCUSDT');
  assert.deepEqual(bybit.filter(l => l.label).map(l => l.label), ['Venue', 'Market price', 'Bankruptcy price', 'Time']);
  assert.ok(bybit.some(l => l.text.includes('so it is drawn at the price trading then')));
  const late = liquidationLines({ t: 0, id: 'bybit:BTCUSDT', side: 'long', price: 79_900, usd: 5_000, reported: 79_900, kind: 'bankruptcy' });
  assert.ok(late.some(l => l.text.includes('no trade of this market near that time is known')), 'one drawn at its own bankruptcy price says so');
  const binance = liquidationLines({ t: 0, id: 'binance:BTCUSDT', side: 'short', price: 80_000, usd: 9_000, reported: 80_000, kind: 'fill' });
  assert.equal(binance[0]!.color, 'buy');
  assert.ok(binance.some(l => l.text === 'This exchange reports only its largest liquidation each second.'));
  assert.ok(!binance.some(l => l.label === 'Reported price'), 'a fill price drawn where it was says nothing twice');
});

test('the Range panel counts the liquidations in a selection as part of its market orders, from the smallest the map holds', () => {
  const T = Date.UTC(2026, 9, 9, 12), MIN = 60_000;
  const sel = { t0: T, t1: T + 10 * MIN, p0: null, p1: null, live: false } as RangeInput['sel'];
  const answer: RangeInput['answer'] = { from: T, to: T + 10 * MIN, p0: null, p1: null, step: 10, rows: [], instruments: [{ id: 'bybit:BTCUSDT', minutes: 10, counted: 0, countedFrom: null, band: { buy: 600_000, sell: 400_000, buyN: 0, sellN: 0 }, countedUsd: { buy: 0, sell: 0 }, all: { buy: 600_000, sell: 400_000 }, before: { buy: 0, sell: 0, minutes: 0 } }] };
  const base: RangeInput = { sel, answer, error: null, marks: null, resting: null, prints: null, kind: () => 'perp', liquidationMin: 1_000 };
  const line = (liquidations: Liquidation[] | null) => rangeLines({ ...base, liquidations }).find(l => l.key === 'liquidations');
  assert.equal(line(null), undefined, 'liquidations off: nothing said');
  assert.deepEqual(line([])!.cells, ['Liquidations', 'none reported from $1K']);
  const l = (side: 'long' | 'short', usd: number, at: number): Liquidation => ({ t: T + at * MIN, id: 'bybit:BTCUSDT', side, price: 80_000, usd, reported: 80_000, kind: 'fill' });
  const some = line([l('long', 150_000, 1), l('short', 50_000, 2), l('long', 1e9, 30)])!;
  assert.deepEqual(some.cells, ['Liquidations', '$150K longs · $50K shorts · 20% of all market volume in these minutes (from $1K)'], 'one outside the minutes is left out');
  assert.equal(some.tone, 'sell');
  assert.deepEqual(line([l('long', 150_000, 1), l('short', 500, 2)])!.cells[1], '$150K longs · $0 shorts · 15% of all market volume in these minutes (from $1K)', 'one under the panel\'s smallest is left out');
  // A box: its band holds $60K, but a liquidation counts against every price in those minutes, and a share past 100 % is not said.
  const boxed = { ...base, sel: { ...sel, p0: 79_990, p1: 80_010 }, answer: { ...answer, instruments: [{ ...answer.instruments[0]!, band: { buy: 30_000, sell: 30_000, buyN: 0, sellN: 0 } }] } } as RangeInput;
  assert.match(rangeLines({ ...boxed, liquidations: [l('long', 500_000, 1)] }).find(x => x.key === 'liquidations')!.cells[1]!, /^\$500K longs · \$0 shorts · 50% of all market volume/);
  assert.equal(rangeLines({ ...boxed, liquidations: [l('long', 5e6, 1)] }).find(x => x.key === 'liquidations')!.cells[1], '$5M longs · $0 shorts (from $1K)');
  // One Deribit fill that closed a long and a short (MT): in both totals, but its volume once in the share.
  assert.equal(line([l('long', 100_000, 3), l('short', 100_000, 3)])!.cells[1], '$100K longs · $100K shorts · 10% of all market volume in these minutes (from $1K)');
});
