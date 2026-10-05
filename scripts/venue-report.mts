/**
 * The evidence behind the default venues (docs/deslop/venue-defaults-2026-10-05.md), re-runnable:
 *
 *   npm run report:venues -- size                    24 h BTC volume and open interest per venue, from each exchange's public REST API
 *   npm run report:venues -- feed [minutes] [port]   what the running server's own connections deliver: how often each venue's book changes,
 *                                                    how old it is, how many levels and how far from the price it reaches
 *
 * Read-only: no keys, nothing is placed or changed. Both print Markdown tables.
 */
import { decodeLevels } from '../src/app/wire.ts';

const at = (value: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((v, key) => (v !== null && typeof v === 'object' ? (v as Record<string | number, unknown>)[key] : undefined), value);
const num = (value: unknown): number => { const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN; return Number.isFinite(n) ? n : NaN; };
const get = async (url: string, body?: unknown): Promise<unknown> => {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'venue-report/1.0', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
};

interface Size { vol: number; oi: number }
interface Source { venue: string; kind: 'perp' | 'spot'; read: () => Promise<Size> }
const none = NaN;
const perp = (venue: string, read: () => Promise<Size>): Source => ({ venue, kind: 'perp', read });
const spot = (venue: string, read: () => Promise<Size>): Source => ({ venue, kind: 'spot', read });

const SOURCES: Source[] = [
  perp('binance', async () => { const t = await get('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT'), oi = await get('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT'); return { vol: num(at(t, 'quoteVolume')), oi: num(at(oi, 'openInterest')) * num(at(t, 'lastPrice')) }; }),
  perp('bybit', async () => { const t = at(await get('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT'), 'result', 'list', 0); return { vol: num(at(t, 'turnover24h')), oi: num(at(t, 'openInterestValue')) }; }),
  perp('okx', async () => { const t = at(await get('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP'), 'data', 0), oi = at(await get('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP'), 'data', 0), last = num(at(t, 'last')); return { vol: num(at(t, 'volCcy24h')) * last, oi: num(at(oi, 'oiCcy')) * last }; }),
  perp('bitget', async () => { const t = at(await get('https://api.bitget.com/api/v2/mix/market/ticker?productType=USDT-FUTURES&symbol=BTCUSDT'), 'data', 0); return { vol: num(at(t, 'usdtVolume') ?? at(t, 'quoteVolume')), oi: num(at(t, 'holdingAmount')) * num(at(t, 'lastPr')) }; }),
  perp('deribit', async () => { const t = at(await get('https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL'), 'result'); return { vol: num(at(t, 'stats', 'volume_usd')), oi: num(at(t, 'open_interest')) }; }),
  perp('hyperliquid', async () => {
    const [meta, contexts] = await get('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' }) as [unknown, unknown[]];
    const universe = at(meta, 'universe'), index = Array.isArray(universe) ? universe.findIndex(entry => at(entry, 'name') === 'BTC') : -1, c = contexts[index];
    return { vol: num(at(c, 'dayNtlVlm')), oi: num(at(c, 'openInterest')) * num(at(c, 'markPx')) };
  }),
  perp('gateio', async () => { const t = at(await get('https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=BTC_USDT'), 0), c = await get('https://api.gateio.ws/api/v4/futures/usdt/contracts/BTC_USDT'), last = num(at(t, 'last')); return { vol: num(at(t, 'volume_24h_quote')), oi: num(at(t, 'total_size')) * num(at(c, 'quanto_multiplier')) * last }; }),
  perp('mexc', async () => { const t = at(await get('https://contract.mexc.com/api/v1/contract/ticker?symbol=BTC_USDT'), 'data'); return { vol: num(at(t, 'amount24')), oi: num(at(t, 'holdVol')) * 0.0001 * num(at(t, 'lastPrice')) }; }),
  perp('bitunix', async () => ({ vol: num(at(await get('https://fapi.bitunix.com/api/v1/futures/market/tickers?symbols=BTCUSDT'), 'data', 0, 'quoteVol')), oi: none })),
  perp('aster', async () => ({ vol: num(at(await get('https://fapi.asterdex.com/fapi/v1/ticker/24hr?symbol=BTCUSDT'), 'quoteVolume')), oi: none })),
  perp('htx', async () => ({ vol: num(at(await get('https://api.hbdm.com/linear-swap-ex/market/detail/merged?contract_code=BTC-USDT'), 'tick', 'trade_turnover')), oi: none })),
  perp('cryptocom', async () => { const t = at(await get('https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=BTCUSD-PERP'), 'result', 'data', 0); return { vol: num(at(t, 'vv')), oi: num(at(t, 'oi')) * num(at(t, 'a')) }; }),
  perp('dydx', async () => { const t = at(await get('https://indexer.dydx.trade/v4/perpetualMarkets?ticker=BTC-USD'), 'markets', 'BTC-USD'); return { vol: num(at(t, 'volume24H')), oi: num(at(t, 'openInterest')) * num(at(t, 'oraclePrice')) }; }),
  spot('binancespot', async () => ({ vol: num(at(await get('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'), 'quoteVolume')), oi: none })),
  spot('coinbase', async () => { const s = await get('https://api.exchange.coinbase.com/products/BTC-USD/stats'); return { vol: num(at(s, 'volume')) * num(at(s, 'last')), oi: none }; }),
  spot('kraken', async () => { const result = at(await get('https://api.kraken.com/0/public/Ticker?pair=XBTUSD'), 'result'), t = result && typeof result === 'object' ? Object.values(result)[0] : undefined; return { vol: num(at(t, 'v', 1)) * num(at(t, 'c', 0)), oi: none }; }),
  spot('bitstamp', async () => { const t = await get('https://www.bitstamp.net/api/v2/ticker/btcusd/'); return { vol: num(at(t, 'volume')) * num(at(t, 'last')), oi: none }; }),
  spot('okxspot', async () => ({ vol: num(at(await get('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT'), 'data', 0, 'volCcy24h')), oi: none })), // already in USDT for spot
  spot('bybitspot', async () => ({ vol: num(at(await get('https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT'), 'result', 'list', 0, 'turnover24h')), oi: none })),
  spot('kucoin', async () => ({ vol: num(at(await get('https://api.kucoin.com/api/v1/market/stats?symbol=BTC-USDT'), 'data', 'volValue')), oi: none })),
  spot('bitfinex', async () => { const t = await get('https://api-pub.bitfinex.com/v2/ticker/tBTCUSD'); return { vol: num(at(t, 7)) * num(at(t, 6)), oi: none }; }),
  spot('mexcspot', async () => ({ vol: num(at(await get('https://api.mexc.com/api/v3/ticker/24hr?symbol=BTCUSDT'), 'quoteVolume')), oi: none })),
  spot('gatespot', async () => ({ vol: num(at(await get('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT'), 0, 'quote_volume')), oi: none })),
  spot('bitgetspot', async () => ({ vol: num(at(await get('https://api.bitget.com/api/v2/spot/market/tickers?symbol=BTCUSDT'), 'data', 0, 'usdtVolume')), oi: none })),
  spot('htxspot', async () => ({ vol: num(at(await get('https://api.huobi.pro/market/detail/merged?symbol=btcusdt'), 'tick', 'vol')), oi: none })),
  spot('whitebit', async () => { const t = at(await get('https://whitebit.com/api/v4/public/ticker'), 'BTC_USDT'); return { vol: num(at(t, 'base_volume')) * num(at(t, 'last_price')), oi: none }; }),
  spot('phemex', async () => ({ vol: num(at(await get('https://api.phemex.com/md/spot/ticker/24hr?symbol=sBTCUSDT'), 'result', 'turnoverEv')) / 1e8, oi: none })),
  spot('hitbtc', async () => ({ vol: num(at(await get('https://api.hitbtc.com/api/3/public/ticker/BTCUSDT'), 'volume_quote')), oi: none })),
  spot('poloniex', async () => ({ vol: num(at(await get('https://api.poloniex.com/markets/BTC_USDT/ticker24h'), 'amount')), oi: none })),
  spot('bitmart', async () => ({ vol: num(at(await get('https://api-cloud.bitmart.com/spot/quotation/v3/ticker?symbol=BTC_USDT'), 'data', 'qv_24h')), oi: none })),
  spot('binanceus', async () => ({ vol: num(at(await get('https://api.binance.us/api/v3/ticker/24hr?symbol=BTCUSD'), 'quoteVolume')), oi: none })),
];

const money = (v: number): string => !Number.isFinite(v) ? '–' : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${Math.round(v / 1e6)}M` : `${Math.round(v / 1e3)}K`;

async function size(): Promise<void> {
  const rows = await Promise.all(SOURCES.map(async source => { try { return { ...source, ...await source.read(), error: '' }; } catch (error) { return { ...source, vol: NaN, oi: NaN, error: error instanceof Error ? error.message.slice(0, 80) : String(error) }; } }));
  for (const kind of ['perp', 'spot'] as const) {
    const list = rows.filter(row => row.kind === kind).sort((a, b) => (Number.isFinite(b.vol) ? b.vol : -1) - (Number.isFinite(a.vol) ? a.vol : -1));
    const total = list.reduce((sum, row) => sum + (Number.isFinite(row.vol) ? row.vol : 0), 0);
    console.log(`\n### ${kind === 'perp' ? 'Perpetuals' : 'Spot'}, 24 h BTC volume ${money(total)} across the venues measured\n\n| Venue | 24 h volume | Share | Open interest |\n| --- | ---: | ---: | ---: |`);
    for (const row of list) console.log(row.error ? `| ${row.venue} | unavailable: ${row.error} | | |` : `| ${row.venue} | ${money(row.vol)} | ${(100 * row.vol / total).toFixed(1)}% | ${money(row.oi)} |`);
  }
}

interface Tally { frames: number; changed: number; lastTimestamp: number; ages: number[]; levels: number[]; reachBid: number[]; reachAsk: number[]; spread: number[] }
const median = (values: number[]): number => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[sorted.length >> 1]! : NaN; };
const maxOf = (values: Float64Array): number => values.reduce((m, v) => Math.max(m, v), -Infinity);
const minOf = (values: Float64Array): number => values.reduce((m, v) => Math.min(m, v), Infinity);

async function feed(minutes: number, port: number): Promise<void> {
  const tallies = new Map<string, Tally>();
  let frames = 0;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
  socket.binaryType = 'arraybuffer';
  socket.onmessage = event => {
    if (!(event.data instanceof ArrayBuffer)) return;
    let frame; try { frame = decodeLevels(event.data); } catch { return; }
    frames++;
    for (const book of frame.books) {
      let t = tallies.get(book.id);
      if (!t) { t = { frames: 0, changed: 0, lastTimestamp: 0, ages: [], levels: [], reachBid: [], reachAsk: [], spread: [] }; tallies.set(book.id, t); }
      t.frames++; if (t.lastTimestamp && book.timestamp !== t.lastTimestamp) t.changed++;
      t.lastTimestamp = book.timestamp; t.ages.push(frame.asOf - book.timestamp); t.levels.push(book.bids.usd.length + book.asks.usd.length);
      if (!book.bids.usd.length || !book.asks.usd.length) continue;
      // Extremes rather than positions, so the order a venue sends its levels in does not matter.
      const bestBid = maxOf(book.bids.hi), bestAsk = minOf(book.asks.lo), mid = (bestBid + bestAsk) / 2;
      t.spread.push((bestAsk - bestBid) / mid * 1e4); t.reachBid.push((mid - minOf(book.bids.lo)) / mid * 1e4); t.reachAsk.push((maxOf(book.asks.hi) - mid) / mid * 1e4);
    }
  };
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error(`cannot reach ws://127.0.0.1:${port}/api/v2/ws; is the server running?`)); });
  console.error(`watching ${minutes} min on port ${port}…`);
  await new Promise(resolve => setTimeout(resolve, minutes * 60_000));
  socket.close();
  console.log(`\n${frames} frames in ${minutes} min\n\n| Book | Present | Changed in | Age p50 (ms) | Levels | Reach bid / ask (bp) | Spread (bp) |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const [id, t] of [...tallies].sort((a, b) => a[0].localeCompare(b[0])))
    console.log(`| ${id} | ${Math.round(100 * t.frames / frames)}% | ${Math.round(100 * t.changed / Math.max(1, t.frames - 1))}% of frames | ${Math.round(median(t.ages))} | ${Math.round(median(t.levels))} | ${Math.round(median(t.reachBid))} / ${Math.round(median(t.reachAsk))} | ${median(t.spread).toFixed(2)} |`);
}

const [command, a, b] = process.argv.slice(2);
if (command === 'size') await size();
else if (command === 'feed') await feed(Number(a ?? 10), Number(b ?? 8787));
else { console.error('usage: venue-report.mjs size | feed [minutes] [port]'); process.exitCode = 2; }
