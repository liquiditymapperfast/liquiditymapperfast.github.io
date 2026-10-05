import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { BinanceSpotConnector, BinanceUsConnector, BitmartConnector, BitunixConnector, BookConnector, HitbtcConnector, PoloniexConnector } from '../src/server/v2/connectors.mts';
import { ExtraVenues } from '../src/server/v2/venues.mts';

const live = <T extends BookConnector>(c: T): T => { c.state = 'connecting'; return c; };
const msg = (o: unknown) => JSON.stringify(o);
const poloniexSnapshot = msg({ channel: 'book_lv2', action: 'snapshot', data: [{ symbol: 'BTC_USDT', asks: [['101', '1']], bids: [['100', '1']] }] });

test('HitBTC applies sequenced updates, deletes zero-quantity levels and discards the book on a gap', () => {
  const c = live(new HitbtcConnector());
  c.onMessage(msg({ ch: 'orderbook/full', snapshot: { BTCUSDT: { t: 1, s: 10, a: [['101', '2'], ['102', '1']], b: [['100', '3'], ['99', '1']] } } }));
  assert.equal(c.state, 'live');
  c.onMessage(msg({ ch: 'orderbook/full', update: { BTCUSDT: { t: 2, s: 11, a: [['101', '0.00']], b: [['100', '5']] } } }));
  const book = c.valued(Date.now())!;
  assert.deepEqual([...book.asks.lo], [102]);
  assert.deepEqual([...book.bids.usd], [500, 99]);
  assert.equal(book.venue, 'hitbtc');
  assert.equal(book.instrumentId, 'hitbtc:BTCUSDT');
  c.onMessage(msg({ ch: 'orderbook/full', update: { BTCUSDT: { t: 3, s: 13, a: [], b: [] } } }));
  assert.equal(c.valued(Date.now()), null);
  assert.match(c.lastError ?? '', /sequence gap 11 -> 13/);
  c.stop();
});

test('Poloniex applies updates, removes quantity 0 and ignores other symbols', () => {
  const c = live(new PoloniexConnector());
  c.onMessage(msg({ channel: 'book_lv2', action: 'snapshot', data: [{ symbol: 'BTC_USDT', asks: [['101', '1']], bids: [['100', '2'], ['98', '1']] }] }));
  c.onMessage(msg({ channel: 'book_lv2', action: 'update', data: [{ symbol: 'BTC_USDT', asks: [['103', '4']], bids: [['98', '0']] }] }));
  const book = c.valued(Date.now())!;
  assert.deepEqual([...book.asks.lo], [101, 103]);
  assert.deepEqual([...book.bids.lo], [100]);
  c.onMessage(msg({ channel: 'book_lv2', action: 'update', data: [{ symbol: 'ETH_USDT', asks: [['1', '1']], bids: [] }] }));
  assert.deepEqual([...c.valued(Date.now())!.asks.lo], [101, 103]);
  c.stop();
});

test('BitMart decodes deflate-raw frames and replaces the whole book on each push', () => {
  const c = live(new BitmartConnector());
  const frame = deflateRawSync(Buffer.from(msg({ table: 'spot/depth50', data: [{ symbol: 'BTC_USDT', asks: [['101', '1']], bids: [['100', '2']] }] })));
  const buf = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer;
  c.onMessage(c.decode(buf)!);
  assert.deepEqual([...c.valued(Date.now())!.bids.usd], [200]);
  c.onMessage(msg({ table: 'spot/depth50', data: [{ symbol: 'BTC_USDT', asks: [['102', '1']], bids: [['99', '1']] }] }));
  const book = c.valued(Date.now())!;
  assert.deepEqual([...book.asks.lo], [102]);
  assert.deepEqual([...book.bids.lo], [99]);
  c.stop();
});

test('Bitunix keeps full snapshots and rejects a crossed book', () => {
  const c = live(new BitunixConnector());
  c.onMessage(msg({ ch: 'depth_books', symbol: 'BTCUSDT', data: { b: [['100', '1']], a: [['101', '1']] } }));
  assert.ok(c.valued(Date.now()));
  c.onMessage(msg({ ch: 'depth_books', symbol: 'BTCUSDT', data: { b: [['102', '1']], a: [['101', '1']] } }));
  assert.equal(c.valued(Date.now()), null);
  c.stop();
});

test('Binance US syncs the diff stream to the snapshot: buffered events replay, stale ones drop, gaps discard', () => {
  const c = live(new BinanceUsConnector());
  const ev = (U: number, u: number, b: [string, string][], a: [string, string][]) => msg({ e: 'depthUpdate', U, u, b, a });
  c.onMessage(ev(95, 99, [['100', '9']], []));
  c.onMessage(ev(100, 103, [['100', '4']], [['101', '0']]));
  c.seed(100, [[100, 1], [99, 1]], [[101, 1], [102, 2]]);
  const book = c.valued(Date.now())!;
  assert.deepEqual([...book.bids.usd], [400, 99]);
  assert.deepEqual([...book.asks.lo], [102]);
  c.onMessage(ev(104, 104, [], [['103', '1']]));
  assert.deepEqual([...c.valued(Date.now())!.asks.lo], [102, 103]);
  c.onMessage(ev(106, 106, [], []));
  assert.equal(c.valued(Date.now()), null);
  assert.match(c.lastError ?? '', /sequence gap 104 -> 106/);
  c.stop();
});

test('Binance spot merges tick-size levels so far walls survive inside the level cap', () => {
  const c = live(new BinanceSpotConnector());
  const bids: [number, number][] = [], asks: [number, number][] = [];
  for (let i = 0; i < 4000; i++) { bids.push([86_737 - i * 0.01, 0.01]); asks.push([86_737.01 + i * 0.01, 0.01]); }
  bids.push([85_000, 30], [70_000, 12]); asks.push([88_000, 20], [95_000, 8]);
  c.seed(1, bids, asks);
  const book = c.valued(Date.now())!;
  assert.ok(book, 'a one-cent spread must not read as a crossed book');
  assert.ok(book.bids.lo[0]! < book.asks.lo[0]!, 'bids step down and asks step up from the mark');
  assert.equal(book.bids.lo[0]! % 1, 0, 'the touch merges into one-dollar buckets (grid step 20, finest width 1)');
  assert.ok(book.bids.usd.length < 200, `4000 one-cent bids became ${book.bids.usd.length} buckets`);
  assert.ok(book.bids.lo.some(p => p === 85_000) && book.bids.lo.some(p => p === 70_000), 'walls far below survive');
  assert.ok(book.asks.lo.some(p => p >= 88_000 && p < 88_004) && book.asks.lo.some(p => p >= 95_000 && p < 95_020), 'walls far above survive');
  const total = (side: Float64Array) => side.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total(book.bids.usd) - bids.reduce((a, [p, q]) => a + p * q, 0)) < 1, 'nothing is lost by merging');
  c.stop();
});

test('stale books are withheld', () => {
  const c = live(new PoloniexConnector());
  c.onMessage(poloniexSnapshot);
  assert.ok(c.valued(Date.now()));
  assert.equal(c.valued(Date.now() + 60_000), null);
  c.stop();
});

test('ExtraVenues enables, lists, persists and ignores unknown venues', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-venues-'));
  const file = path.join(dir, 'v2-venues.json');
  class Fake extends PoloniexConnector {
    override start() { this.state = 'connecting'; this.onMessage(poloniexSnapshot); }
    override stop() { this.state = 'stopped'; }
  }
  try {
    const venues = new ExtraVenues(file, { poloniex: () => new Fake() });
    assert.equal(venues.list().length, 1);
    assert.equal(venues.list()[0]!.enabled, false);
    assert.equal(venues.books(Date.now()).length, 0);
    venues.setEnabled(['poloniex', 'nonsense']);
    assert.equal(venues.enabledCount, 1);
    assert.equal(venues.books(Date.now()).length, 1);
    assert.deepEqual(venues.markets().map(m => m.instrumentId), ['poloniex:BTC_USDT']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { enabled: ['poloniex'], known: ['poloniex'] });
    const again = new ExtraVenues(file, { poloniex: () => new Fake() });
    assert.equal(again.enabledCount, 1);
    again.setEnabled([]);
    assert.equal(again.books(Date.now()).length, 0);
    assert.equal(again.list()[0]!.state, 'stopped');
    again.close();
    venues.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('venues that close idle sockets send an application-level ping; others rely on ping frames', () => {
  const polo = new PoloniexConnector().keepalive();
  assert.ok(polo && polo.everyMs <= 25_000);
  assert.deepEqual(polo.frame(), { event: 'ping' });
  const bitunix = new BitunixConnector().keepalive();
  assert.ok(bitunix && bitunix.everyMs <= 25_000);
  const frame = bitunix.frame() as { op: string; ping: number };
  assert.equal(frame.op, 'ping');
  assert.ok(Math.abs(frame.ping - Date.now() / 1000) < 5, 'unix seconds');
  assert.equal(new HitbtcConnector().keepalive(), null);
});

test('a thin market may stay quiet without losing its book, a busy one may not', () => {
  const quiet = live(new HitbtcConnector());
  quiet.onMessage(msg({ ch: 'orderbook/full', snapshot: { BTCUSDT: { t: 1, s: 10, a: [['101', '2']], b: [['100', '3']] } } }));
  assert.ok(quiet.valued(Date.now() + 60_000), 'one quiet minute is not a dead feed');
  assert.equal(quiet.valued(Date.now() + 200_000), null);
  const busy = live(new PoloniexConnector());
  busy.onMessage(poloniexSnapshot);
  assert.equal(busy.valued(Date.now() + 40_000), null);
  quiet.stop(); busy.stop();
});

test('a failure keeps its reason after the venue is live again', () => {
  const c = live(new PoloniexConnector());
  c.onMessage(poloniexSnapshot);
  assert.equal(c.status().lastFailure, null);
  c.fail('socket closed');
  assert.equal(c.status().lastFailure, 'socket closed');
  c.stop();
});

test('snapshot venues keep only the newest frame per interval and stop cleanly', async () => {
  class Quick extends BitunixConnector { protected override coalesceMs() { return 25; } }
  const frame = (bid: string, ask: string) => msg({ ch: 'depth_books', symbol: 'BTCUSDT', data: { b: [[bid, '1']], a: [[ask, '1']] } });
  const c = live(new Quick());
  c.receive(frame('100', '101')); c.receive(frame('110', '111')); c.receive(frame('120', '121'));
  assert.equal(c.valued(Date.now()), null, 'nothing is applied before the interval ends');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual([...c.valued(Date.now())!.bids.lo], [120], 'only the newest of the three frames was applied');
  c.receive(frame('130', '131')); c.stop();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(c.state, 'stopped', 'a frame queued before stop is dropped');
  const busy = live(new PoloniexConnector());
  busy.receive(poloniexSnapshot);
  assert.ok(busy.valued(Date.now()), 'diff venues apply every frame immediately');
  busy.stop();
});

test('a curated default starts only the named venues and flags them, and a later addition outside it stays off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-venues-curated-'));
  const file = path.join(dir, 'v2-venues.json');
  class Fake extends PoloniexConnector {
    constructor(id: string) { super(); Object.defineProperty(this, 'id', { value: id }); }
    override start() { this.state = 'connecting'; } override stop() { this.state = 'stopped'; }
  }
  const set = (...ids: string[]) => Object.fromEntries(ids.map(id => [id, () => new Fake(id)]));
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')) as { enabled: string[]; known: string[] };
  try {
    const first = new ExtraVenues(file, set('a', 'b', 'c'), ['b', 'gone']);
    assert.deepEqual(first.list().filter(v => v.enabled).map(v => v.id), ['b'], 'only the named venue starts, and an unknown id in the list is ignored');
    assert.deepEqual(first.list().filter(v => v.default).map(v => v.id), ['b'], 'the picker can tell which ones are recommended');
    assert.equal(fs.existsSync(file), false, 'the default is not written until the user chooses');
    first.setEnabled(['a']);
    first.close();
    // Two venues arrive in a later build: the recommended one starts once, the other waits to be chosen.
    const second = new ExtraVenues(file, set('a', 'b', 'c', 'd', 'e'), ['b', 'd']);
    assert.deepEqual(saved().enabled, ['a', 'd'], 'the saved choice stays, d is new and recommended, e is new and not, b was seen and left off');
    assert.deepEqual(second.list().filter(v => v.default).map(v => v.id), ['b', 'd']);
    second.close();
    assert.equal(new ExtraVenues(null, set('a', 'b'), true).enabledCount, 2, 'true still means every connector');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fresh install starts every connector venue when asked to, a saved choice (even an empty one) wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-venues-default-'));
  const file = path.join(dir, 'v2-venues.json');
  class Fake extends PoloniexConnector { override start() { this.state = 'connecting'; } override stop() { this.state = 'stopped'; } }
  try {
    const first = new ExtraVenues(file, { a: () => new Fake(), b: () => new Fake() }, true);
    assert.equal(first.enabledCount, 2, 'nothing saved: all on');
    assert.equal(fs.existsSync(file), false, 'the default is not written until the user chooses');
    first.setEnabled([]);
    first.close();
    const second = new ExtraVenues(file, { a: () => new Fake(), b: () => new Fake() }, true);
    assert.equal(second.enabledCount, 0, 'the saved empty choice is respected');
    second.close();
    // A venue added by a later build starts once, then the user's choice applies to it as well.
    const third = new ExtraVenues(file, { a: () => new Fake(), b: () => new Fake(), c: () => new Fake() }, true);
    assert.equal(third.enabledCount, 1, 'a and b were seen and left off, c is new so it starts');
    assert.deepEqual((JSON.parse(fs.readFileSync(file, 'utf8')) as { enabled: string[]; known: string[] }).enabled, ['c']);
    third.close();
    fs.writeFileSync(file, JSON.stringify({ enabled: ['a'] }));
    const older = new ExtraVenues(file, { a: () => new Fake(), b: () => new Fake(), c: () => new Fake() }, true);
    assert.equal(older.enabledCount, 1, 'a file from before `known` existed counts every current id of a custom set as seen');
    older.close();
    fs.writeFileSync(file, JSON.stringify({ enabled: ['a'], known: ['a', 'b'] }));
    const fourth = new ExtraVenues(file, { a: () => new Fake(), b: () => new Fake(), c: () => new Fake() }, true);
    assert.deepEqual((JSON.parse(fs.readFileSync(file, 'utf8')) as { enabled: string[]; known: string[] }).enabled, ['a', 'c'], 'b was seen and left off, c is new so it starts');
    assert.deepEqual((JSON.parse(fs.readFileSync(file, 'utf8')) as { enabled: string[]; known: string[] }).known, ['a', 'b', 'c'], 'the new venue is now known');
    fourth.close();
    const optedOut = new ExtraVenues(file, { a: () => new Fake(), b: () => new Fake(), c: () => new Fake(), d: () => new Fake() }, false);
    assert.equal(optedOut.enabledCount, 2, 'HLM_DEFAULT_VENUES=configured leaves new venues off (a and c stay as saved, d is not added)');
    optedOut.close();
    assert.equal(new ExtraVenues(null, { a: () => new Fake() }, false).enabledCount, 0, 'tests and memory-only servers keep them off');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
