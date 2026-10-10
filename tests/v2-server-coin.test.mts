import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyServerCoin, markInstrumentIdFor, serverCoin } from '../src/server/v2/server-coin.mts';
import { CONNECTOR_FACTORIES, connectorFactories } from '../src/server/v2/connectors.mts';
import { BTC, type Coin } from '../src/shared/coins.ts';

const PUMP: Coin = { coin: 'PUMP', volumeUsd: 1, price: 0.006, tier: 2, markets: {
  binance: { symbol: 'PUMPUSDT', unit: 1 }, binancespot: { symbol: 'PUMPUSDT', unit: 1 }, okx: { symbol: 'PUMP-USDT-SWAP', unit: 1, contract: 1000 },
  okxspot: { symbol: 'PUMP-USDT', unit: 1 }, bybitspot: { symbol: 'PUMPUSDT', unit: 1 }, hyperliquid: { symbol: 'PUMP', unit: 1 },
  deribit: { symbol: 'PUMP_USDC-PERPETUAL', unit: 1 }, coinbase: { symbol: 'PUMP-USD', unit: 1 },
} };

function listIn(dir: string, coins: Coin[]): void {
  fs.writeFileSync(path.join(dir, 'coins.json'), JSON.stringify({ version: 1, builtAt: 1, lists: {}, coins }));
}

test('the server coin is BTC unless HL_DEFAULT_COIN names a coin of the list, read from the data folder first', () => {
  assert.equal(serverCoin({}), BTC);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmf-coin-'));
  listIn(dir, [PUMP]);
  const env = { HL_DEFAULT_COIN: 'pump', HISTORY_DB: path.join(dir, 'history.sqlite') };
  assert.equal(serverCoin(env).coin, 'PUMP');
  assert.equal(serverCoin(env).markets.deribit?.symbol, 'PUMP_USDC-PERPETUAL');
  assert.throws(() => serverCoin({ HL_DEFAULT_COIN: 'NOTACOIN', HISTORY_DB: path.join(dir, 'history.sqlite') }), /not in the coin list/);
});

test('another coin sets each feed venue from its listings: listed venues on with their own names, unlisted ones off, given settings kept', () => {
  const env: NodeJS.ProcessEnv = { OKX_ENABLED: 'false' };
  applyServerCoin(PUMP, env);
  assert.equal(env.BINANCE_DEFAULT_SYMBOL, 'PUMPUSDT');
  assert.equal(env.DERIBIT_DEFAULT_SYMBOL, 'PUMP_USDC-PERPETUAL');
  assert.equal(env.DERIBIT_ENABLED, 'true');
  assert.equal(env.COINBASE_DEFAULT_SYMBOL, 'PUMP-USD');
  assert.equal(env.BYBIT_ENABLED, 'false', 'Bybit has no PUMP perpetual in the list');
  assert.equal(env.BITGET_ENABLED, 'false');
  assert.equal(env.OKX_ENABLED, 'false', 'a setting already given wins');
  const thousands: Coin = { ...PUMP, coin: 'PEPE', markets: { binance: { symbol: '1000PEPEUSDT', unit: 1000 } } };
  const env2: NodeJS.ProcessEnv = {};
  applyServerCoin(thousands, env2);
  assert.equal(env2.BINANCE_DEFAULT_SYMBOL, undefined, 'a listing in thousands is left to the default: the feed manager does not convert it');
  const btcEnv: NodeJS.ProcessEnv = {};
  applyServerCoin(BTC, btcEnv);
  assert.deepEqual(btcEnv, {}, 'BTC keeps the saved venue selection');
});

test('the mark is the coin\'s Hyperliquid perpetual, and a coin without one under its own name is refused', () => {
  assert.equal(markInstrumentIdFor(BTC), 'hyperliquid:BTC-PERP');
  assert.equal(markInstrumentIdFor(PUMP), 'hyperliquid:PUMP-PERP');
  assert.throws(() => markInstrumentIdFor({ ...PUMP, coin: 'PEPE', markets: { hyperliquid: { symbol: 'kPEPE', unit: 1000 } } }), /Hyperliquid/);
  assert.throws(() => markInstrumentIdFor({ ...PUMP, markets: {} }), /Hyperliquid/);
});

test('connector venues follow the coin: BTC keeps every connector, another coin gets the spot markets that list it under their names', () => {
  assert.equal(connectorFactories(BTC), CONNECTOR_FACTORIES);
  const made = Object.fromEntries(Object.entries(connectorFactories(PUMP)).map(([id, make]) => [id, make().instrumentId]));
  assert.deepEqual(made, { binancespot: 'binancespot:PUMPUSDT', bybitspot: 'bybitspot:PUMPUSDT', okxspot: 'okxspot:PUMP-USDT' });
});
