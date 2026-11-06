/**
 * The liquidation levels' history (hlm-levels `history.rs`, 2026-11-05): every snapshot HyperTracker made of Hyperliquid's BTC positions,
 * reduced to the long and the short dollars at each distance from that snapshot's own mark in fixed buckets, read a UTC day at a time for
 * the Depth pane's Liquidations view. A snapshot comes about every 29 minutes and describes positions some 35 minutes older than it; a row
 * is placed at the moment the service fetched it (`fetchedAt`), when the page could first have shown it.
 *
 * What it says is where the money would be liquidated, as the positions stood: not what was liquidated, and not where price will go.
 */
import { DUE_EVERY_MS, MAX_LEAD_MS, ON_TIME_MS, clockSetBack, nextAskAt, placeSnapshot } from './liq-schedule.ts';
import { liqLevelsUrl } from './liq-url.ts';

export const DAY_MS = 86_400_000;
/** How often the index (what the service holds) is asked again; a day still being written is asked when its next snapshot can be there (`liq-schedule.ts`). */
const INDEX_EVERY_MS = 5 * 60_000;
/** A failed read waits this long before it is asked again. */
const RETRY_MS = 60_000;
/** At most this many days are held: a view wider than that shows the newest of them. */
export const MAX_DAYS = 120;

export interface LiqIndex { edges: readonly number[]; first: number | null; last: number | null }
/**
 * One snapshot: `long[i]` and `short[i]` are the dollars within bucket `i`'s upper edge of the mark (each bucket holds the ones inside it),
 * `longCoin` / `shortCoin` the same in coins, each bucket's dollars over the price at its middle (below the mark for longs, above for shorts).
 */
export interface LiqRow { asOf: number; createdAt: number; fetchedAt: number; mark: number; long: Float32Array; short: Float32Array; longCoin: Float32Array; shortCoin: Float32Array }

/** The history's two addresses beside the levels file's (`…/liquidations.json`), or null when there is no levels service. */
export function historyUrls(levelsUrl: string): { index: string; day: (day: string) => string } | null {
  if (!/\/liquidations\.json$/.test(levelsUrl)) return null;
  const base = levelsUrl.replace(/\/liquidations\.json$/, '/liquidation-history');
  return { index: `${base}.json`, day: (day: string) => `${base}/${day}.json` };
}

/** A UTC day as the service names it (YYYY-MM-DD). */
export const dayText = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The index, checked: edges ascending positive percentages (1 to 1,000 of them), first and last times or null. */
export function readIndex(raw: unknown): LiqIndex | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>, edges = o.edges;
  if (!Array.isArray(edges) || edges.length < 1 || edges.length > 1_000) return null;
  for (let i = 0; i < edges.length; i++) if (typeof edges[i] !== 'number' || !(edges[i] > (i ? edges[i - 1] : 0))) return null;
  const time = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
  return { edges: edges as number[], first: time(o.first), last: time(o.last) };
}

/** A day's rows, checked against the index's buckets: a row of the wrong shape is left out, never drawn. Ordered by fetch time. */
export function readDay(raw: unknown, edges: readonly number[]): LiqRow[] {
  const rows = raw && typeof raw === 'object' ? (raw as { rows?: unknown }).rows : null;
  if (!Array.isArray(rows)) return [];
  const n = edges.length, out: LiqRow[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 8) continue;
    const [asOf, createdAt, fetchedAt, mark, , , long, short] = row as unknown[];
    if (![asOf, createdAt, fetchedAt, mark].every(v => typeof v === 'number' && Number.isFinite(v)) || !((mark as number) > 0)) continue;
    if (!Array.isArray(long) || !Array.isArray(short) || long.length !== n || short.length !== n) continue;
    if (!long.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0) || !short.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) continue;
    const cumL = new Float32Array(n), cumS = new Float32Array(n), coinL = new Float32Array(n), coinS = new Float32Array(n);
    let l = 0, s = 0, lc = 0, sc = 0;
    for (let i = 0; i < n; i++) {
      const mid = ((i ? edges[i - 1]! : 0) + edges[i]!) / 200;
      l += long[i] as number; s += short[i] as number;
      lc += (long[i] as number) / ((mark as number) * Math.max(0.01, 1 - mid)); sc += (short[i] as number) / ((mark as number) * (1 + mid));
      cumL[i] = l; cumS[i] = s; coinL[i] = lc; coinS[i] = sc;
    }
    out.push({ asOf: asOf as number, createdAt: createdAt as number, fetchedAt: fetchedAt as number, mark: mark as number, long: cumL, short: cumS, longCoin: coinL, shortCoin: coinS });
  }
  return out.sort((a, b) => a.fetchedAt - b.fetchedAt);
}

/** The bucket a band of `radius` (a fraction of the price) ends on: the last edge within it, or -1 when the band is narrower than the first bucket. */
export function bandIndex(edges: readonly number[], radius: number): number {
  const pct = radius * 100 * (1 + 1e-9);
  let at = -1;
  for (let i = 0; i < edges.length && edges[i]! <= pct; i++) at = i;
  return at;
}

/**
 * The history as the page holds it: the index, and the days the view has asked for, each read once (the day still being written again when
 * its next snapshot can be there: `due`, from when its newest row was created, `created`, on the page's clock). Kept here so the pane
 * only says which stretch of time it shows and draws what has come.
 */
export class LiqHistory {
  #index: LiqIndex | null = null;
  #indexAt = 0; #indexBusy = false; #indexFailed = 0;
  /** The page's clock when last read, to see it set back. */
  #lastNow = -Infinity;
  /** Counts the clock's steps back: an answer to a read made before one carries the old clock's times and is dropped (it is read again). */
  #steps = 0;
  #days = new Map<number, { rows: LiqRow[]; at: number; busy: boolean; failed: number; newest: number; created: number; lead: number; due: number }>();
  /** The page's clock minus HyperTracker's, once a snapshot was seen appear (`placeSnapshot`). */
  #offset: number | null = null;
  /** Goes up whenever something new has come. */
  version = 0;
  constructor(private get: (url: string) => Promise<unknown> = url => fetch(url, { cache: 'no-cache' }).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))) {}
  get index(): LiqIndex | null { return this.#index; }

  /** Ask for what [t0, t1] needs that is not held (or is due again); `changed` is called when an answer lands. Times are kept as of `now`, when they were asked. */
  ensure(t0: number, t1: number, now: number, changed: () => void): void {
    const urls = historyUrls(liqLevelsUrl()); if (!urls) return;
    // The page's clock went back since it was last read: what the old clock placed and planned is no good (`clockSetBack`), the index's and
    // the failed reads' waits included.
    if (clockSetBack(this.#lastNow, now)) {
      // Every day is read once more: a day the old clock (ahead) counted as read after it ended may not have been, and no read times of the old
      // clock may bracket a snapshot.
      this.#offset = null; this.#indexAt = -Infinity; this.#indexFailed = -Infinity; this.#steps++;
      for (const entry of this.#days.values()) { entry.created = now; entry.lead = MAX_LEAD_MS; entry.due = now; entry.failed = -Infinity; entry.at = -Infinity; }
    }
    this.#lastNow = now;
    if (!this.#indexBusy && now - this.#indexFailed > RETRY_MS && (!this.#index || now - this.#indexAt > INDEX_EVERY_MS)) {
      this.#indexBusy = true;
      const steps = this.#steps;
      this.get(urls.index).then(raw => {
        const index = readIndex(raw);
        if (index) { if (this.#index && this.#index.edges.length !== index.edges.length) this.#days.clear(); this.#index = index; if (steps === this.#steps) this.#indexAt = now; this.version++; changed(); }
        else if (steps === this.#steps) this.#indexFailed = now;
      }, () => { if (steps === this.#steps) this.#indexFailed = now; }).finally(() => { this.#indexBusy = false; });
    }
    const index = this.#index; if (!index || index.first === null || index.last === null) return;
    const lastDay = Math.floor(Math.min(t1, Math.max(index.last, now)) / DAY_MS) * DAY_MS;
    // The day before the view as well: the row in force at its left edge may have come the evening before.
    const firstDay = Math.max(Math.floor(index.first / DAY_MS) * DAY_MS, Math.floor(t0 / DAY_MS) * DAY_MS - DAY_MS, lastDay - (MAX_DAYS - 1) * DAY_MS);
    for (let day = firstDay; day <= lastDay; day += DAY_MS) {
      const held = this.#days.get(day);
      // A day read after it ended (and the hour after, for a late fetch) does not change; one read before that is asked again when its next
      // snapshot can be there (while it has none yet, when the day before's newest says so, else each minute).
      const settled = held !== undefined && held.at >= day + DAY_MS + 3_600_000;
      if (held && (held.busy || now - held.failed < RETRY_MS || settled || now < held.due)) continue;
      const entry = held ?? { rows: [], at: -Infinity, busy: false, failed: 0, newest: -Infinity, created: 0, lead: 0, due: 0 };
      entry.busy = true; this.#days.set(day, entry);
      const edges = index.edges, steps = this.#steps, before = entry.at, onTime = entry.due > 0 && now - entry.due <= ON_TIME_MS && !(entry.failed > entry.at);
      this.get(urls.day(dayText(day))).then(raw => {
        if (this.#index?.edges !== edges || steps !== this.#steps) return;
        entry.rows = readDay(raw, edges); entry.at = now; this.version++;
        const top = entry.rows.reduce<LiqRow | null>((best, row) => !best || row.createdAt > best.createdAt ? row : best, null);
        if (top && top.createdAt > entry.newest) {
          // Seen appear between this read and the one before: placed by when it was published, else by its age (`placeSnapshot`).
          entry.newest = top.createdAt;
          ({ created: entry.created, lead: entry.lead, offset: this.#offset } = placeSnapshot(top.createdAt, top.fetchedAt, before, now, entry.lead, this.#offset, onTime));
        }
        const prev = this.#days.get(day - DAY_MS);
        entry.due = entry.rows.length ? nextAskAt(entry.created, now, entry.lead) : prev && prev.rows.length ? nextAskAt(prev.created, now, prev.lead) : now + DUE_EVERY_MS;
        changed();
      }, () => { entry.failed = now; }).finally(() => { entry.busy = false; });
    }
    // Days outside the view are let go, the farthest first, so a long session does not hold the whole history; a day the view needs never is.
    if (this.#days.size > MAX_DAYS + 4) {
      const away = (day: number): number => day < firstDay ? firstDay - day : day - lastDay;
      for (const day of [...this.#days.keys()].filter(d => d < firstDay || d > lastDay).sort((a, b) => away(b) - away(a))) {
        if (this.#days.size <= MAX_DAYS + 4) break;
        this.#days.delete(day);
      }
    }
  }

  /** The rows held that are in force over [t0, t1]: every row fetched in it, and the last one before it. Ordered by fetch time. */
  rows(t0: number, t1: number): LiqRow[] {
    const all: LiqRow[] = [];
    for (const [day, entry] of this.#days) if (day + DAY_MS > t0 - DAY_MS && day <= t1) all.push(...entry.rows);
    all.sort((a, b) => a.fetchedAt - b.fetchedAt);
    let from = 0;
    while (from + 1 < all.length && all[from + 1]!.fetchedAt <= t0) from++;
    let to = all.length;
    while (to > 0 && all[to - 1]!.fetchedAt > t1) to--;
    return all.slice(from, Math.max(from, to));
  }
}
