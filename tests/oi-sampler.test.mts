import test from 'node:test';
import assert from 'node:assert/strict';
import { OiSampler, oiListingOf, oiHistoryWriter, type OiSampleMessage } from '../src/server/v2/oi-sampler.mts';
import { HistoryStore } from '../src/server/history.mts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchOiHistory, fetchOiReading } from '../src/shared/history.ts';
import { inverseOi } from '../src/app/oi-change.ts';

const NOW = 20 * 86_400_000;

test('the server samples the venues the feed manager does not read, writing their history first, oldest first', async () => {
  const applied: { message: OiSampleMessage; venue: string }[] = [], recorded: OiSampleMessage[] = [], asked: string[] = [];
  const get = async (url: string): Promise<unknown> => {
    asked.push(url);
    if (url.includes('api.bybit.com/v5/market/open-interest')) {
      const end = Number(new URL(url).searchParams.get('endTime')), step = url.includes('intervalTime=1h') ? 3_600_000 : 300_000;
      return { result: { list: Array.from({ length: 3 }, (_, i) => ({ timestamp: String(end - (end % step) - i * step), openInterest: '200', singleOpenInterest: '100' })) } };
    }
    if (url.includes('api.bybit.com/v5/market/tickers')) return { result: { list: [{ openInterest: '246', singleOpenInterest: '123' }] } };
    if (url.includes('deribit.com')) return { result: [{ open_interest: 85_000_000, mark_price: 85_000 }] };
    throw new Error(`not expected: ${url}`);
  };
  const sampler = new OiSampler((message, venue) => applied.push({ message, venue }), message => recorded.push(message), get, () => NOW, 3_600_000);
  sampler.sync(['binance:BTCUSDT', 'hyperliquid:BTC-PERP', 'bybit:BTCUSDT', 'deribit:BTC-PERPETUAL', 'bybitspot:BTCUSDT']);
  await sampler.round();
  assert.ok(!asked.some(url => url.includes('binance.com') || url.includes('hyperliquid')), 'Binance and Hyperliquid are the feed manager\'s');
  assert.ok(recorded.length > 0 && recorded.every(m => m.instrumentId === 'bybit:BTCUSDT' && m.sourceTimestamp !== null), 'Bybit\'s history went to the store (Deribit has none)');
  assert.ok(recorded.every((m, i) => i === 0 || Number(m.sourceTimestamp) > Number(recorded[i - 1]!.sourceTimestamp)), 'oldest first');
  assert.deepEqual(applied.map(a => [a.venue, a.message.instrumentId, a.message.base, a.message.quality]), [['bybit', 'bybit:BTCUSDT', 123, 'sampled'], ['deribit', 'deribit:BTC-PERPETUAL', 1_000, 'sampled']]);
  const before = recorded.length;
  await sampler.round();
  assert.equal(recorded.length, before, 'the history is read once');
  assert.equal(applied.length, 4, 'then a reading a round');
  sampler.sync([]);
  sampler.close();
  await sampler.round();
  assert.equal(applied.length, 4, 'closed: nothing more');
});

test('each instrument is read with its own listing, a spot book is never sampled, and a failed history is tried again later', async () => {
  assert.deepEqual(oiListingOf('bybit:ETHUSDT'), { symbol: 'ETHUSDT', unit: 1 });
  assert.deepEqual(oiListingOf('bybit:1000PEPEUSDT'), { symbol: '1000PEPEUSDT', unit: 1000 });
  assert.deepEqual(oiListingOf('bybit:SHIB1000USDT'), { symbol: 'SHIB1000USDT', unit: 1000 }, 'Bybit writes the thousands after the coin');
  assert.deepEqual(oiListingOf('okx:PEPE-USDT-SWAP'), { symbol: 'PEPE-USDT-SWAP', unit: 1 });
  assert.deepEqual(oiListingOf('deribit:ETH-PERPETUAL'), { symbol: 'ETH-PERPETUAL', unit: 1, inverse: true });
  assert.deepEqual(oiListingOf('deribit:SOL_USDC-PERPETUAL'), { symbol: 'SOL_USDC-PERPETUAL', unit: 1 });
  assert.equal(oiListingOf('bybit:BTCUSDT:spot'), null);
  let clock = NOW, failing = true;
  const asked: string[] = [], recorded: OiSampleMessage[] = [], applied: OiSampleMessage[] = [];
  const get = async (url: string): Promise<unknown> => {
    asked.push(url);
    if (url.includes('open-interest?category')) { if (failing) throw new Error('HTTP 429'); return { result: { list: [{ timestamp: String(clock - (clock % 300_000)), openInterest: '1800', singleOpenInterest: '900' }] } }; }
    if (url.includes('tickers')) return { result: { list: [{ openInterest: '20', singleOpenInterest: '10' }] } };
    throw new Error(url);
  };
  const sampler = new OiSampler(m => applied.push(m), m => recorded.push(m), get, () => clock, 3_600_000);
  sampler.sync(['bybit:ETHUSDT', 'bybit:ETHUSDT:spot']);
  await sampler.round();
  assert.ok(asked.every(url => url.includes('symbol=ETHUSDT')), 'ETH asked for, not BTC');
  assert.deepEqual(applied.map(m => m.instrumentId), ['bybit:ETHUSDT'], 'the spot book is not sampled; the live reading goes on while the history waits');
  assert.equal(recorded.length, 0);
  const tries = asked.length; failing = false;
  await sampler.round();
  assert.equal(asked.length - tries, 1, 'within the minute after a failure only the live reading is asked');
  clock += 61_000; await sampler.round();
  assert.ok(recorded.length > 0, 'the history is read once the wait is over');
  sampler.close();
});

test('history the store refuses (over its budget) is read again later, not taken as done', async () => {
  let clock = NOW, refusing = true;
  const recorded: OiSampleMessage[] = [];
  const get = async (url: string): Promise<unknown> => {
    if (url.includes('open-interest?category')) return { result: { list: [{ timestamp: String(clock - (clock % 300_000)), openInterest: '1800', singleOpenInterest: '900' }] } };
    if (url.includes('tickers')) return { result: { list: [{ openInterest: '20', singleOpenInterest: '10' }] } };
    throw new Error(url);
  };
  const sampler = new OiSampler(() => {}, m => { if (refusing) return false; recorded.push(m); return true; }, get, () => clock, 3_600_000);
  sampler.sync(['bybit:BTCUSDT']);
  await sampler.round();
  assert.equal(recorded.length, 0);
  refusing = false; clock += 61_000; await sampler.round();
  assert.ok(recorded.length > 0, 'written once the store takes rows again');
  sampler.close();
});

test('a history row the store already holds is not a refusal; a store that stopped writing is', () => {
  // A restart: the rows written before come back from the file, and the store turns the same row away.
  const dir = mkdtempSync(join(tmpdir(), 'oi-writer-')), filePath = join(dir, 'history.sqlite');
  const row: OiSampleMessage = { kind: 'openInterest', instrumentId: 'bybit:BTCUSDT', sourceTimestamp: 1_700_000_000_000, observationTimestamp: 1_700_000_000_000, receivedAt: 1_700_000_100_000, base: 50_000, quality: 'sampled' };
  const before = new HistoryStore({ filePath });
  assert.equal(oiHistoryWriter(before)(row), true);
  before.close();
  const history = new HistoryStore({ filePath }), write = oiHistoryWriter(history);
  assert.equal(history.recordOi({ ...row }), false, 'the store turns the same row away');
  assert.equal(write(row), true, 'which the sampler does not take as refused');
  history.persistenceSuspended = true;
  assert.equal(write({ ...row, observationTimestamp: row.observationTimestamp! + 60_000, sourceTimestamp: row.sourceTimestamp! + 60_000 }), false);
  history.close(); rmSync(dir, { recursive: true, force: true });
});

test('Bybit\x27s coin-margined perpetual reads its open interest in USD with its value in coins, and has no history', async () => {
  assert.deepEqual(oiListingOf('bybit:BTCUSD'), { symbol: 'BTCUSD', unit: 1, inverse: true });
  assert.equal(inverseOi('bybit:BTCUSD'), true); assert.equal(inverseOi('bybit:BTCUSDT'), false);
  const asked: string[] = [];
  const get = async (url: string): Promise<unknown> => { asked.push(url); return { retCode: 0, result: { list: [{ symbol: 'BTCUSD', openInterest: '1028908580', openInterestValue: '12504.7', singleOpenInterest: '514454290', singleOpenInterestValue: '6252.35', markPrice: '82281.8' }] } }; };
  assert.deepEqual(await fetchOiReading('bybit', get, oiListingOf('bybit:BTCUSD')!), { base: 6252.35, quote: 514454290 });
  assert.match(asked[0]!, /category=inverse/);
  assert.deepEqual(await fetchOiHistory('bybit:BTCUSD', 300_000, 0, 86_400_000, get, oiListingOf('bybit:BTCUSD')!), []);
  assert.equal(asked.length, 1, 'no history asked');
});

test('Bybit open interest stored as both sides is halved once, and only once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bybit-oi-')), filePath = join(dir, 'history.sqlite');
  const at = 1_700_000_000_000, row = (instrumentId: string, base: number, t: number): OiSampleMessage => ({ kind: 'openInterest', instrumentId, sourceTimestamp: t, observationTimestamp: t, receivedAt: t + 1, base, quality: 'sampled' });
  const before = new HistoryStore({ filePath });
  before.recordOi({ ...row('bybit:BTCUSDT', 60_000, at) }); before.recordOi({ ...row('binance:BTCUSDT', 90_000, at) });
  // A store written before the fix: no mark that the migration ran.
  before.db.exec("DELETE FROM migration_state WHERE key = 'bybit-oi-single'"); before.close();
  const close = (store: HistoryStore, id: string): number => Number((store.listOi(id, { from: 0 }) as { close?: number; base?: number }[]).at(-1)?.close ?? NaN);
  const once = new HistoryStore({ filePath });
  assert.equal(close(once, 'bybit:BTCUSDT'), 30_000, 'halved');
  assert.equal(close(once, 'binance:BTCUSDT'), 90_000, 'other venues untouched');
  once.close();
  const twice = new HistoryStore({ filePath });
  assert.equal(close(twice, 'bybit:BTCUSDT'), 30_000, 'not halved again');
  twice.close(); rmSync(dir, { recursive: true, force: true });
});

test('a reading keeps the venue\'s own clock, failures are counted and logged at most every ten minutes, and fast venues are read every five seconds', async () => {
  let clock = NOW, failing = false;
  const applied: OiSampleMessage[] = [], logs: string[] = [];
  const get = async (url: string): Promise<unknown> => {
    if (url.includes('open-interest?category')) return { result: { list: [] } };
    if (url.includes('tickers')) { if (failing) throw new Error('HTTP 500'); return { result: { list: [{ openInterest: '20', singleOpenInterest: '10' }] }, time: 1_700_000_000_000 }; }
    throw new Error(url);
  };
  const sampler = new OiSampler((message, venue) => applied.push(message), () => {}, get, () => clock, 60_000, message => logs.push(message));
  sampler.sync(['bybit:BTCUSDT']);
  await sampler.round();
  assert.equal(applied[0]!.sourceTimestamp, 1_700_000_000_000, 'the venue\'s own clock rides the sample');
  assert.equal(sampler.status().bybit.lastSuccess, NOW); assert.equal(sampler.status().bybit.failures, 0); assert.equal(sampler.status().bybit.fast, false);
  sampler.setFast(['bybit']);
  assert.equal(sampler.status().bybit.fast, true);
  clock += 5_000; await sampler.roundFast();
  assert.equal(applied.length, 2, 'a fast round reads the venue');
  await sampler.roundFast();
  assert.equal(applied.length, 2, 'not again within five seconds');
  clock += 5_000; failing = true;
  await sampler.roundFast();
  assert.equal(sampler.status().bybit.failures, 1); assert.match(String(sampler.status().bybit.lastError), /500/); assert.equal(logs.length, 1, 'logged once');
  clock += 5_000; await sampler.roundFast();
  assert.equal(sampler.status().bybit.failures, 2); assert.equal(logs.length, 1, 'at most once every ten minutes');
  clock += 10 * 60_000 + 5_000; await sampler.roundFast();
  assert.equal(logs.length, 2, 'logged again after ten minutes');
  sampler.setFast([]);
  assert.equal(sampler.status().bybit.fast, false);
  sampler.close();
});
