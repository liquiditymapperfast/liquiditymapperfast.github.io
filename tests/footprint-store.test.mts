import test from 'node:test';
import assert from 'node:assert/strict';
import { FootprintStore, initialFootprintSources, } from '../src/server/footprint-store.mts';
import { FIXTURE_MARKETS } from '../src/core/fixture-state.mts';
import { normalizeHyperliquidTrade } from '../src/adapters/hyperliquid.mts';
import { normalizeBinanceAggTrade } from '../src/adapters/binance.mts';
import { logicalRetainedBytes } from '../src/core/retained-bytes.mts';
import type { RuntimeMarket } from '../src/domain/runtime-state.mts';
import type { FootprintWindow, FootprintWindowOptions, PreparedFootprintPacket } from '../src/core/footprint-model.mts';

const minute = 60_000, start = Math.floor(1_780_000_000_000 / minute) * minute;
const ids = { hl: 'hyperliquid:BTC-PERP', linear: 'binance:BTCUSDT', spot: 'binance:BTCUSDT:spot' } as const;
function present<T>(value: T | null | undefined): T { assert.ok(value !== null && value !== undefined); return value; }
function markets(): RuntimeMarket[] { return structuredClone(FIXTURE_MARKETS); }
function market(id: string): RuntimeMarket { return present(markets().find(row => row.instrumentId === id)); }
function store(): FootprintStore { return new FootprintStore(markets(), 'store-regression-session'); }
function hl(tid: number, side: 'B' | 'A' | '???' = 'B', price = 100, amount = 1, time = start + 1, receivedAt = time + 10) {
  return normalizeHyperliquidTrade({ coin: 'BTC', tid, side, time, px: String(price), sz: String(amount) }, { coin: 'BTC', receivedAt });
}
function bn(id: number, sell = false, price = 100, amount = 1, time = start + 1, spot = false, receivedAt = time + 10) {
  return normalizeBinanceAggTrade({ e: 'aggTrade', s: 'BTCUSDT', a: id, T: time, p: String(price), q: String(amount), m: sell }, { symbol: 'BTCUSDT', marketType: spot ? 'spot' : 'perpetual', receivedAt });
}
function projection(authority: FootprintStore, selected: readonly string[] = [ids.linear], toMs = start + minute, maxCells = 8_192): FootprintWindow {
  const options: FootprintWindowOptions = { instrumentIds: selected, fromMs: start, toMs, intervalMs: minute, priceStep: 1, maxCells };
  const plan = authority.windowPlan(options); assert.equal(plan.complete, true, plan.reason ?? '');
  const result = authority.project(options, plan.workingBytesUpper); assert.equal(result.complete, true, result.reason ?? ''); return present(result.window);
}

test('initial source discovery accepts normalized fixture HL BTC, Binance linear/spot with separate native identities', () => {
  const source = initialFootprintSources(FIXTURE_MARKETS);
  assert.deepEqual(source.map(row => row.instrumentId), [ids.hl, ids.linear, ids.spot]);
  assert.deepEqual(source.map(row => row.channel), ['hyperliquid-trades', 'binance-aggTrade', 'binance-aggTrade']);
  assert.deepEqual(source.map(row => row.usdBasis), ['native-usd', 'stablecoin-equivalent', 'stablecoin-equivalent']);
  assert.equal(present(source.find(row => row.instrumentId === ids.hl)).nativeSymbol, 'BTC');
  assert.equal(present(source.find(row => row.instrumentId === ids.spot)).marketType, 'spot');
  assert.equal(Object.isFrozen(source), true); assert.equal(source.every(Object.isFrozen), true);
  const caller = markets(), authority = new FootprintStore(caller, 'detached-market');
  present(caller.find(row => row.instrumentId === ids.linear)).base = 'ETH';
  assert.equal(present(authority.source(ids.linear)).baseAsset, 'BTC');
});
test('ambiguous identities, inverse units, foreign/unregistered families and non-USD quotes remain unsupported', () => {
  const linear = market(ids.linear), hyperliquid = market(ids.hl);
  const invalid: RuntimeMarket[] = [
    { ...linear, id: 'binance:ETHUSDT' }, { ...linear, instrumentId: 'binance:ETHUSDT' },
    { ...linear, nativeSymbol: 'ETHUSDT' }, { ...linear, base: 'ETH' }, { ...linear, quote: 'EUR' },
    { ...linear, quantityUnit: 'contract', contractValue: 100 }, { ...linear, inverse: true },
    { ...linear, family: 'coinm' }, { ...linear, family: 'unregistered-family' },
    { ...linear, marketType: 'delivery' }, { ...linear, marketType: 'spot' },
    { ...hyperliquid, nativeSymbol: 'ETH' }, { ...hyperliquid, base: 'ETH' }, { ...hyperliquid, quote: 'USDC' },
    { ...linear, venue: 'bybit' }, { ...linear, venue: 'mystery', instrumentId: 'mystery:BTCUSDT', id: 'mystery:BTCUSDT' },
    { id: 'binance:BTCUSD_PERP', instrumentId: 'binance:BTCUSD_PERP', nativeSymbol: 'BTCUSD_PERP', venue: 'binance', marketType: 'perpetual', base: 'BTC', quote: 'USD', quantityUnit: 'contract', family: 'coinm', inverse: true, contractValue: 100 }
  ];
  for (const row of invalid) assert.deepEqual(initialFootprintSources([row]), [], JSON.stringify(row));
});
