import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOrderbookControlBody } from '../src/server/orderbook-control-body.mts';

test('only bounded native control fields survive body parsing', () => {
  assert.deepEqual(parseOrderbookControlBody('{"instrumentId":"hyperliquid:BTC-PERP","venues":[]}'), { instrumentId: 'hyperliquid:BTC-PERP', venues: [] });
  assert.deepEqual(parseOrderbookControlBody('{"instrumentId":"hyperliquid:BTC-PERP","venues":["binance","okx"]}'), { instrumentId: 'hyperliquid:BTC-PERP', venues: ['binance', 'okx'] });
  for (const invalid of ['null', '[]', '{}', '{',
    '{"instrumentId":"BTC","venues":["binance","binance"]}', '{"instrumentId":"BTC","venues":[],"unknown":true}',
    JSON.stringify({ instrumentId: 'BTC', venues: Array(9).fill('binance') }),
    JSON.stringify({ instrumentId: 'x'.repeat(129), venues: [] }),
    JSON.stringify({ instrumentId: 'BTC', venues: ['<script>'] }),
    JSON.stringify({ instrumentId: 'BTC', venues: ['binance'], extra: 'x'.repeat(5000) })])
    assert.equal(parseOrderbookControlBody(invalid), null, invalid.slice(0, 100));
});
