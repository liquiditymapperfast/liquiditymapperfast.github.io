import fs from 'node:fs';
import { PUBLIC_ORDERBOOK_VENUE_IDS } from './public-orderbook-selection.mts';

/** The venue set chosen in the Venues dialog, kept on disk so a server restart does not fall back to the four defaults. */
export interface SavedFeedSelection { instrumentId: string; venues: string[] }

export function loadFeedSelection(file: string | null): SavedFeedSelection | null {
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { instrumentId?: unknown; venues?: unknown };
    if (typeof raw.instrumentId !== 'string' || !raw.instrumentId || raw.instrumentId.length > 120 || !Array.isArray(raw.venues)) return null;
    const known = new Set<string>(PUBLIC_ORDERBOOK_VENUE_IDS);
    const venues = [...new Set(raw.venues.filter((id): id is string => typeof id === 'string' && known.has(id)))];
    return venues.length ? { instrumentId: raw.instrumentId, venues } : null;
  } catch { return null; }
}

export function saveFeedSelection(file: string | null, selection: SavedFeedSelection): void {
  if (!file) return;
  try {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(selection));
    fs.renameSync(temp, file);
  } catch { /* read-only data directory: the choice simply does not persist */ }
}

interface MarketLike { instrumentId?: unknown; quote?: unknown; marketType?: unknown }

/** The product venue selection is anchored on: a USDT/USDC-quoted perpetual, else any stable-quoted market. */
export function anchorProduct(markets: readonly MarketLike[]): string | null {
  const stable = (m: MarketLike) => typeof m.instrumentId === 'string' && /^(USDT|USDC)$/i.test(String(m.quote ?? ''));
  const pick = markets.find(m => stable(m) && m.marketType === 'perpetual') ?? markets.find(stable);
  return pick ? String(pick.instrumentId) : null;
}

export interface RestoreOptions {
  file: string | null;
  markets: () => readonly MarketLike[];
  select: (product: string, venues: string[]) => Promise<void>;
  /** Used when nothing is saved; null means leave the configured venues alone. */
  defaultVenues: readonly string[] | null;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Re-apply the saved venue set (or the default one) once market metadata is ready. Selection fails while the market
 * registry is still loading, so it is retried for a while; the result says what happened.
 */
export async function restoreFeedSelection(options: RestoreOptions): Promise<'restored' | 'defaulted' | 'skipped' | 'gave-up'> {
  const saved = loadFeedSelection(options.file);
  const venues = saved ? saved.venues : options.defaultVenues ? [...options.defaultVenues] : null;
  if (!venues) return 'skipped';
  const attempts = options.attempts ?? 18, delay = options.delayMs ?? 5_000, sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let last = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    const product = saved?.instrumentId ?? anchorProduct(options.markets());
    if (product) {
      try { await options.select(product, venues); return saved ? 'restored' : 'defaulted'; }
      catch (error) { last = error instanceof Error ? error.message : String(error); }
    } else last = 'no stable-quoted market is known yet';
    if (attempt < attempts - 1) await sleep(delay);
  }
  options.log?.(`could not apply the ${saved ? 'saved' : 'default'} venue selection: ${last}`);
  return 'gave-up';
}
