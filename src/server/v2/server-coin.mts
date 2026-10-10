import fs from 'node:fs';
import path from 'node:path';
import { BTC, parseCatalogue, scaleOf, type Coin, type Listing } from '../../shared/coins.ts';

/**
 * The coin this server records (`HL_DEFAULT_COIN`, BTC unless set). BTC is built in; another coin is looked up in the coin list
 * (the data folder's own copy, then the built site's, then the repository's), because its markets name it differently
 * (SOL_USDC-PERPETUAL on Deribit, PUMP missing from Bybit's perpetuals) and only the list says how.
 */
export function serverCoin(env: NodeJS.ProcessEnv = process.env): Coin {
  const wanted = String(env.HL_DEFAULT_COIN ?? 'BTC').trim().toUpperCase();
  if (wanted === 'BTC') return BTC;
  const dataDir = env.HISTORY_DB ? path.dirname(path.resolve(env.HISTORY_DB)) : null;
  const files = [dataDir && path.join(dataDir, 'coins.json'), path.join(process.cwd(), 'dist', 'coins.json'), path.join(process.cwd(), 'src', 'app', 'public', 'coins.json')];
  for (const file of files) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const coin = parseCatalogue(JSON.parse(fs.readFileSync(file, 'utf8')))?.coins.find(c => c.coin === wanted);
      if (coin) return coin;
    } catch { /* an unreadable copy: try the next */ }
  }
  throw new Error(`HL_DEFAULT_COIN=${wanted} is not in the coin list`);
}

/**
 * The instrument whose price is the server's mark: the coin's Hyperliquid perpetual, as BTC-PERP is BTC's. A coin Hyperliquid
 * does not list in single coins under its own name (kPEPE) has no mark the server can use, so it is refused rather than mis-sized.
 */
export function markInstrumentIdFor(coin: Coin): string {
  const listing = coin.markets.hyperliquid;
  if (coin.coin !== 'BTC' && (!listing || listing.unit !== 1 || listing.symbol !== coin.coin))
    throw new Error(`${coin.coin} has no Hyperliquid perpetual in single coins under its own name; the server needs one for its price`);
  return `hyperliquid:${coin.coin}-PERP`;
}

/** The feed manager's venues, the setting that names each one's symbol, and the one that switches it on (Binance has none: always on). */
const FEED_VENUES = [
  { venue: 'binance', symbol: 'BINANCE_DEFAULT_SYMBOL', enabled: null },
  { venue: 'bybit', symbol: 'BYBIT_DEFAULT_SYMBOL', enabled: 'BYBIT_ENABLED' },
  { venue: 'okx', symbol: 'OKX_DEFAULT_SYMBOL', enabled: 'OKX_ENABLED' },
  { venue: 'bitget', symbol: 'BITGET_DEFAULT_SYMBOL', enabled: 'BITGET_ENABLED' },
  { venue: 'deribit', symbol: 'DERIBIT_DEFAULT_SYMBOL', enabled: 'DERIBIT_ENABLED' },
  { venue: 'coinbase', symbol: 'COINBASE_DEFAULT_SYMBOL', enabled: 'COINBASE_ENABLED' },
] as const;

/**
 * For a coin other than BTC, write each feed venue's symbol from the coin list into the settings the feed manager reads, switch on
 * the venues that list it in single coins and switch off the rest. Settings already given are kept. BTC is left as it was: its
 * venues come from the saved venue selection.
 */
export function applyServerCoin(coin: Coin, env: NodeJS.ProcessEnv = process.env): void {
  if (coin.coin === 'BTC') return;
  for (const { venue, symbol, enabled } of FEED_VENUES) {
    const listing: Listing | undefined = coin.markets[venue];
    // A listing in thousands (1000PEPEUSDT) would need the feed manager to convert sizes, which it does not.
    const usable = listing != null && listing.unit === 1;
    if (usable) env[symbol] ??= listing.symbol;
    if (enabled) env[enabled] ??= usable ? 'true' : 'false';
  }
}

/** How much smaller than BTC's the size floors are for this coin (the browser engine uses the same scale). */
export const coinScale = (coin: Coin): number => scaleOf(coin);
