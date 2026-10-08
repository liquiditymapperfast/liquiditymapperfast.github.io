import test from 'node:test';
import assert from 'node:assert/strict';
import { PrintBook, bubbleRadius, fromWire, topPrints, type Print } from '../src/app/prints.ts';
import { Coalescer, DEFAULT_SOUNDS, MIN_TIER_USD, chimeNotes, notesFor, readSounds, tierOf } from '../src/app/sound/rules.ts';

const print = (t: number, usd: number, side: 'buy' | 'sell' = 'buy', id = 'binance:BTCUSDT', price = 85_000): Print => ({ t, id, side, price, usd });

test('wire rows are checked field by field and malformed ones are dropped', () => {
  assert.deepEqual(fromWire([5, 'x:BTC', 'sell', 85_000, 120_000]), { t: 5, id: 'x:BTC', side: 'sell', price: 85_000, usd: 120_000 });
  for (const bad of [null, [], [1, 2, 3], ['5', 'x', 'buy', 1, 1], [5, 'x', 'hold', 1, 1], [5, 'x', 'buy', 0, 1], [5, 'x', 'buy', 1, -1], [NaN, 'x', 'buy', 1, 1]]) assert.equal(fromWire(bad), null, JSON.stringify(bad));
});

test('the print book keeps prints in time order without duplicates when history and the live stream overlap', () => {
  const book = new PrintBook();
  assert.equal(book.add([print(3, 100), print(1, 200)]).length, 2);
  assert.deepEqual(book.items.map(p => p.t), [1, 3]);
  const v = book.version;
  assert.equal(book.add([print(3, 100)]).length, 0, 'the same print again is not new');
  assert.equal(book.version, v, 'and changes nothing');
  assert.equal(book.add([print(2, 50), print(4, 60)]).length, 2);
  assert.deepEqual(book.items.map(p => p.t), [1, 2, 3, 4], 'late prints slot into place');
  const small = new PrintBook(3); small.add([1, 2, 3, 4, 5].map(t => print(t, 10)));
  assert.deepEqual(small.items.map(p => p.t), [3, 4, 5], 'bounded: the oldest go');
  assert.equal(small.add([print(1, 10)]).length, 1, 'a dropped print can come back');
});

test('only the largest prints in the window and price range are drawn, and hidden venues never are', () => {
  const items = [print(1, 500_000), print(2, 30_000), print(3, 900_000, 'sell'), print(4, 60_000, 'buy', 'bybit:BTCUSDT'), print(5, 700_000, 'buy', 'x:BTC', 50_000), print(99, 5_000_000)];
  assert.deepEqual(topPrints(items, 0, 10, 80_000, 90_000, 10).map(p => p.t), [1, 2, 3, 4], 'outside the time or price window is excluded');
  assert.deepEqual(topPrints(items, 0, 10, 80_000, 90_000, 2).map(p => p.usd), [500_000, 900_000], 'the two largest, oldest first');
  assert.deepEqual(topPrints(items, 0, 10, 80_000, 90_000, 10, p => p.id.startsWith('bybit')).map(p => p.t), [1, 2, 3]);
});

test('bubble radius grows with the square root of size inside fixed bounds', () => {
  assert.equal(bubbleRadius(25_000, 1e9), 3, 'never smaller than a dot');
  assert.equal(bubbleRadius(5e6, 5e6), 26, 'the largest in view is the biggest');
  assert.equal(bubbleRadius(50_000, 50_000), bubbleRadius(5e7, 5e7), 'whatever its dollars: sizes are compared with what is in view');
  assert.ok(Math.abs(bubbleRadius(800_000, 3.2e6) / bubbleRadius(200_000, 3.2e6) - 2) < 1e-9, 'four times the size, twice the radius (the area follows the size)');
  assert.ok(bubbleRadius(3e6, 6e7) > 3 && bubbleRadius(3e7, 6e7) > 2 * bubbleRadius(3e6, 6e7), 'a zoomed-out day: millions apart, sizes apart');
  assert.equal(bubbleRadius(1e6, 0), 3);
});

test('a sweep across venues inside the window is one event, and sides are kept apart', () => {
  const c = new Coalescer(250);
  c.add(print(1_000, 300_000, 'buy', 'binance:BTCUSDT'), 0); c.add(print(1_040, 200_000, 'buy', 'bybit:BTCUSDT'), 40); c.add(print(1_090, 150_000, 'buy', 'binance:BTCUSDT'), 90);
  c.add(print(1_100, 800_000, 'sell', 'okx:BTC'), 100);
  assert.deepEqual(c.drain(200), [], 'nothing before the window closes');
  const first = c.drain(260);
  assert.equal(first.length, 1);
  assert.deepEqual([first[0]!.side, first[0]!.usd, first[0]!.n, first[0]!.venues, first[0]!.largest], ['buy', 650_000, 3, 2, 300_000]);
  const second = c.drain(400);
  assert.deepEqual([second[0]!.side, second[0]!.usd], ['sell', 800_000], 'the sell group had its own window');
  assert.deepEqual(c.drain(1_000), []);
  c.add(print(1, 1_000_000), 5_000); assert.equal(c.drain(5_001, true).length, 1, 'force drains early');
});

test('a trade belongs to the highest tier it reaches, which must itself be on to sound', () => {
  const tiers = DEFAULT_SOUNDS.tiers;
  assert.equal(tierOf(10_000, tiers), null);
  assert.equal(tierOf(60_000, tiers)!.tier.id, 'signal');
  assert.equal(tierOf(399_999, tiers)!.tier.id, 'surge');
  assert.equal(tierOf(400_000, tiers)!.index, 2);
  assert.equal(tierOf(9e9, tiers)!.tier.id, 'leviathan', 'the top tier is reachable');
  assert.deepEqual(tiers.filter(t => t.on).map(t => t.id), ['whale', 'leviathan'], 'by default only the big ones make a noise');
});

test('buys climb, sells fall, bigger tiers add notes, and loudness stays bounded', () => {
  const buy = notesFor('buy', 3, 2_000_000, 1_500_000, 0.5), sell = notesFor('sell', 3, 2_000_000, 1_500_000, 0.5);
  assert.equal(buy.length, 4); assert.equal(notesFor('buy', 0, 60_000, 50_000, 1).length, 1);
  assert.ok(buy.every((n, i) => i === 0 || n.freq > buy[i - 1]!.freq), 'rising');
  assert.ok(sell.every((n, i) => i === 0 || n.freq < sell[i - 1]!.freq), 'falling');
  assert.ok(buy.every((n, i) => i === 0 || n.delay > buy[i - 1]!.delay), 'one after another');
  const quiet = notesFor('buy', 2, 400_000, 400_000, 1), loud = notesFor('buy', 2, 40_000_000, 400_000, 1), muted = notesFor('buy', 2, 400_000, 400_000, 0);
  assert.ok(loud[0]!.gain > quiet[0]!.gain && loud[0]!.gain <= 0.35 * 1.15 + 1e-9, 'bigger is louder, within bounds');
  assert.ok(muted.every(n => n.gain === 0), 'volume 0 is silent');
  assert.ok(chimeNotes(1).every(n => n.wave === 'sine') && chimeNotes(1).length === 2, 'the candle chime is neutral');
});

test('saved sound settings are merged over the defaults, clamped, and thresholds stay ascending above the floor', () => {
  assert.deepEqual(readSounds(undefined), { ...DEFAULT_SOUNDS, tiers: DEFAULT_SOUNDS.tiers.map(t => ({ ...t })) });
  const s = readSounds({ on: true, volume: 7, scope: 'spot', tiers: [{ id: 'signal', usd: 1, on: true }, { id: 'surge', usd: 40_000, on: false }, { id: 'whale', usd: 'x' }] });
  assert.equal(s.on, true); assert.equal(s.volume, 1); assert.equal(s.scope, 'spot');
  assert.equal(s.tiers[0]!.usd, MIN_TIER_USD, 'below the server floor is raised to it');
  assert.ok(s.tiers.every((t, i) => i === 0 || t.usd > s.tiers[i - 1]!.usd), 'ascending');
  assert.equal(s.tiers[2]!.usd, 400_000, 'a bad value falls back to the default');
  assert.equal(s.tiers[1]!.on, false); assert.equal(s.tiers[0]!.on, true);
  assert.deepEqual(readSounds({ scope: 'weird', volume: NaN }).scope, 'all');
  assert.equal(readSounds({ volume: NaN }).volume, DEFAULT_SOUNDS.volume);
});
