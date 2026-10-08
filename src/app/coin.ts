import { BTC, ONLY_BTC, SCALES, instrumentIdFor, parseCatalogue, type Catalogue, type Coin } from '../shared/coins.ts';
import { BROWSER_RETENTION_MS } from '../shared/recorder.ts';
import type { AppState } from './store.ts';

/**
 * The coin the page is on. It is chosen once, before anything is built, and stays for the page's life: choosing another loads the page again
 * with `?coin=` (new sockets, recorders and caches, so nothing of the last coin is carried over). Size thresholds (trade bubbles,
 * absorption, sounds, the size strip) are kept as BTC's and multiplied by the coin's scale where they are used, so one setting serves
 * every coin.
 */

/** The last coin chosen, the last coin list read, and when each coin was last open with the size tier its recordings were made at. */
const LAST_KEY = 'lmf.coin', LIST_KEY = 'lmf.coins', OPENED_KEY = 'lmf.coins.opened';
/** The coin whose instruments the saved choices name (they were made on it, or moved to it by `forCoin`). */
const SAVED_ON_KEY = 'lmf.coin.saved';
const COIN_NAME = /^[A-Z0-9]{1,15}$/;
/** How often an open page says its coin is still open (the tier and the recordings stay while it is). */
const STILL_OPEN_MS = 10 * 60_000;

export interface CoinChoice {
  coin: Coin;
  /** The tier its size floors are kept at: the list's, unless this browser holds recordings of the coin made at another. */
  tier: number;
  /** Why the page is not on the coin that was asked for: it is not on the list, or no list could be read. Null when it is. */
  notice: { coin: string; reason: 'missing' | 'unreadable' } | null;
  /** The coin the saved instrument choices were made on, when it is not this one (`forCoin` moves them from it). */
  from: Coin | null;
}

let chosen: CoinChoice = { coin: BTC, tier: 0, notice: null, from: null };
let list: Catalogue | null = null;

export const currentCoin = (): Coin => chosen.coin;
export const coinChoice = (): CoinChoice => chosen;
/** The size thresholds' multiplier for the coin on screen (1 for BTC). */
export const sizeScale = (): number => SCALES[chosen.tier] ?? 1;
/** A BTC-sized USD threshold as it applies to the coin on screen (six significant figures, so it reads cleanly). */
export const scaledUsd = (usd: number): number => { const s = sizeScale(); return s === 1 ? usd : Number((usd * s).toPrecision(6)); };
/** A threshold typed in for the coin on screen, kept as the BTC-sized one it stands for (see scaledUsd). */
export const unscaledUsd = (usd: number): number => { const s = sizeScale(); return s === 1 ? usd : Math.round(usd / s); };

/** Where a coin's recordings are kept in this browser: BTC's database keeps its old name, so nothing recorded before is lost. */
export const recordingsName = (coin: string): string => coin === 'BTC' ? 'lmf-recordings' : `lmf-recordings-${coin}`;
/** The lock that lets one tab at a time record a coin: two tabs on different coins each record their own. */
export const recorderLockName = (coin: string): string => coin === 'BTC' ? 'lmf-recorder' : `lmf-recorder-${coin}`;

function readJson(key: string): unknown { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } }
function writeJson(key: string, value: unknown): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode or full: kept for this visit only */ } }

/** The coin list: the page's own copy (same origin, rebuilt daily), else the last one this browser read, else BTC alone. Read once. */
export async function loadCatalogue(): Promise<Catalogue> {
  if (list) return list;
  try {
    const response = await fetch('coins.json', { cache: 'no-cache', signal: AbortSignal.timeout(6_000) });
    const fresh = response.ok ? parseCatalogue(await response.json()) : null;
    if (fresh) { writeJson(LIST_KEY, fresh); list = fresh; return fresh; }
  } catch { /* the saved copy below */ }
  list = parseCatalogue(readJson(LIST_KEY)) ?? ONLY_BTC;
  return list;
}

type Opened = Record<string, { at: number; tier: number }>;
function opened(): Opened {
  const value = readJson(OPENED_KEY), out: Opened = {};
  if (value && typeof value === 'object') for (const [coin, v] of Object.entries(value as Record<string, unknown>)) {
    const at = Number((v as { at?: unknown })?.at), tier = Number((v as { tier?: unknown })?.tier);
    if (at > 0 && Number.isInteger(tier) && tier >= 0 && tier < SCALES.length) out[coin] = { at, tier };
  }
  return out;
}

/**
 * The tier a coin's recordings are kept at. While this browser holds recordings of it (it was open within the retention), the tier they
 * were made at stands, so one day's recordings never mix two floors; after that the list's tier is taken.
 */
export function tierFor(coin: Coin, now: number, seen: Opened = opened()): number {
  if (coin.coin === 'BTC') return 0;
  const last = seen[coin.coin];
  return last && now - last.at < BROWSER_RETENTION_MS ? last.tier : coin.tier;
}

/** The coin asked for in the address, else the last one chosen here, else BTC. */
export function requestedCoin(params: URLSearchParams): string {
  const asked = (params.get('coin') ?? '').trim().toUpperCase();
  if (COIN_NAME.test(asked)) return asked;   // anything else in the address is not a coin, and is not repeated on the page
  const last = readJson(LAST_KEY);
  return typeof last === 'string' && COIN_NAME.test(last) ? last : 'BTC';
}

/**
 * Settle the coin for this page. BTC needs no list (it is built in), so a BTC page does not wait for one; another coin is looked up in the
 * list, and when it is not there (it left the list, or no list could be read) the page opens on BTC and says why.
 */
export async function chooseCoin(params: URLSearchParams, now = Date.now()): Promise<CoinChoice> {
  const asked = requestedCoin(params);
  let coin: Coin = BTC, notice: CoinChoice['notice'] = null;
  if (asked !== 'BTC') {
    const catalogue = await loadCatalogue(), found = catalogue.coins.find(c => c.coin === asked);
    if (found) coin = found;
    // A list that holds BTC alone is one that could not be read: the coin may well be on the real one.
    else notice = { coin: asked, reason: catalogue.coins.length > 1 ? 'missing' : 'unreadable' };
  }
  const savedOn = readJson(SAVED_ON_KEY), madeOn = typeof savedOn === 'string' && COIN_NAME.test(savedOn) ? savedOn : 'BTC';
  const from = madeOn === coin.coin ? null : madeOn === 'BTC' ? BTC : (list ?? parseCatalogue(readJson(LIST_KEY)))?.coins.find(c => c.coin === madeOn) ?? null;
  const seen = opened(), tier = tierFor(coin, now, seen);
  chosen = { coin, tier, notice, from };
  writeJson(SAVED_ON_KEY, coin.coin);
  // Kept for the next visit unless the list could not be read (the coin asked for stays the one to try again).
  if (notice?.reason !== 'unreadable') writeJson(LAST_KEY, coin.coin);
  seen[coin.coin] = { at: now, tier }; writeJson(OPENED_KEY, seen);
  // The address names the coin, so a reload or a bookmark comes back to it (BTC is the plain address).
  const url = new URL(location.href);
  if (coin.coin === 'BTC') url.searchParams.delete('coin'); else url.searchParams.set('coin', coin.coin);
  if (url.href !== location.href && notice?.reason !== 'unreadable') history.replaceState(history.state, '', url);
  return chosen;
}

/** Keep saying the coin is open (so its tier and recordings are not treated as stale), and remove recordings of coins not opened for a day. */
export function keepCoinRecordings(now: () => number = Date.now): void {
  const touch = (): void => { const seen = opened(); seen[chosen.coin.coin] = { at: now(), tier: chosen.tier }; writeJson(OPENED_KEY, seen); };
  window.setInterval(touch, STILL_OPEN_MS);
  addEventListener('pagehide', touch);
  // A coin last open more than a day ago has nothing left inside the retention: its database goes (BTC's is pruned in place and stays).
  window.setTimeout(() => {
    const seen = opened(), current = chosen.coin.coin;
    for (const [coin, { at }] of Object.entries(seen)) {
      if (coin === 'BTC' || coin === current || now() - at < BROWSER_RETENTION_MS + STILL_OPEN_MS) continue;
      try { indexedDB.deleteDatabase(recordingsName(coin)); } catch { /* storage unavailable: nothing to remove */ }
      delete seen[coin];
    }
    writeJson(OPENED_KEY, seen);
  }, 30_000);
}

/**
 * Saved choices that name an instrument (the venue shown alone on the map, the ladder's venues) name it for the coin they were made on
 * (`from`). Each one that is that coin's instrument on a market is carried to the same market's instrument for this coin; anything else (a
 * server's own instrument, a market this coin is not listed on) stays as it was, and the page treats it as a market with no book. On the
 * coin they were made on, nothing moves.
 */
export function forCoin<S extends Pick<AppState, 'heatmapSource' | 'ladderVenue' | 'ladderVenues'>>(state: S, coin: Coin, from: Coin | null): S {
  if (!from || from.coin === coin.coin) return state;
  const move = (id: string): string => { const venue = id.split(':')[0]!; return id === instrumentIdFor(venue, from) ? instrumentIdFor(venue, coin) ?? id : id; };
  return { ...state, heatmapSource: state.heatmapSource === 'aggregated' ? state.heatmapSource : move(state.heatmapSource), ladderVenue: state.ladderVenue ? move(state.ladderVenue) : state.ladderVenue, ladderVenues: state.ladderVenues.map(move) };
}

/** Open the page on another coin (the page loads again; see the top of this file). */
export function switchCoin(coin: string): void {
  if (coin === chosen.coin.coin) return;
  writeJson(LAST_KEY, coin);
  const url = new URL(location.href);
  if (coin === 'BTC') url.searchParams.delete('coin'); else url.searchParams.set('coin', coin);
  location.assign(url.href);
}
