/**
 * The far book: a venue whose WebSocket sends only the levels near the price, but whose REST book goes much deeper, is read from REST
 * every so often and those levels are drawn beyond the WebSocket's (measured 2026-10-12, BTC): OKX's `books` channel stops at 400 levels
 * (7 bp on the swap, 25 bp on spot) while `books-full` gives 5 000 (about 90 bp and 130 bp); Aster's stream sends the best 20 levels and its
 * REST depth 1 000 (about 200 bp). The WebSocket book stays the authority wherever it reaches: a REST level is used only strictly beyond the
 * WebSocket book's deepest level on its side, as it is when the book is valued, and a snapshot older than `FAR_STALE_MS` is not used.
 */

/** How often a far book is read, and how old one may be before it is no longer used. */
export const FAR_EVERY_MS = 15_000, FAR_STALE_MS = 60_000;
/** The first read after a book goes live (its WebSocket book comes first). */
const FAR_FIRST_MS = 3_000;
const FAR_TIMEOUT_MS = 10_000;

/** Levels as listed (price, size in the venue's own unit: the same as its WebSocket book's), bids best first, asks best first. */
export interface FarBook { bids: [number, number][]; asks: [number, number][]; at: number }
export interface FarSource { url: string; parse(body: unknown): Omit<FarBook, 'at'> | null }

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** Rows as two numbers each (OKX adds two more fields to each), positive price and size only. */
function levels(value: unknown): [number, number][] | null {
  if (!Array.isArray(value)) return null;
  const out: [number, number][] = [];
  for (const row of value) {
    if (!Array.isArray(row)) continue;
    const price = Number(row[0]), size = Number(row[1]);
    if (price > 0 && Number.isFinite(price) && size > 0 && Number.isFinite(size)) out.push([price, size]);
  }
  return out;
}
const both = (bids: unknown, asks: unknown): Omit<FarBook, 'at'> | null => {
  const b = levels(bids), a = levels(asks);
  // Best first on each side, whatever order the venue sent them in.
  return b && a && (b.length || a.length) ? { bids: b.sort((x, y) => y[0] - x[0]), asks: a.sort((x, y) => x[0] - y[0]) } : null;
};

/**
 * Where the far book of an instrument (`venue:symbol`, the symbol as the venue lists it) is read, or null for a venue without one. OKX's
 * `books-full` answers with CORS open, so a browser reads it too; Aster is read by the server only.
 */
export function farSource(instrumentId: string): FarSource | null {
  const cut = instrumentId.indexOf(':'), venue = instrumentId.slice(0, cut), symbol = instrumentId.slice(cut + 1);
  if (cut <= 0 || !symbol) return null;
  if (venue === 'okx' || venue === 'okxspot') return {
    url: `https://www.okx.com/api/v5/market/books-full?instId=${encodeURIComponent(symbol)}&sz=5000`,
    parse: body => { const m = record(body), d = record(Array.isArray(m?.data) ? m.data[0] : null); return m && String(m.code) === '0' && d ? both(d.bids, d.asks) : null; },
  };
  if (venue === 'aster') return {
    url: `https://fapi.asterdex.com/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=1000`,
    parse: body => { const m = record(body); return m ? both(m.bids, m.asks) : null; },
  };
  return null;
}

/** The far book's levels strictly beyond `edge` (the WebSocket book's deepest price on that side), in the far book's order; none when `edge` is not a price. */
export function beyond(rows: readonly [number, number][], edge: number, side: 'bid' | 'ask'): [number, number][] {
  if (!(edge > 0) || !Number.isFinite(edge)) return [];
  return side === 'bid' ? rows.filter(([p]) => p < edge) : rows.filter(([p]) => p > edge);
}

/**
 * Whether the page is shown. Where the connectors run beside the page, its own document says; in the feeds worker (no document) the page
 * tells it (`setPageShown`, from browser-source.ts). A hidden page's books are not drawn, so its far books are not read.
 */
let shownFlag = true;
export function setPageShown(shown: boolean): void { shownFlag = shown; }
export function pageShown(): boolean {
  const doc = (globalThis as { document?: { visibilityState?: string } }).document;
  return doc ? doc.visibilityState !== 'hidden' : shownFlag;
}

/** The far book when it may be used: read within `FAR_STALE_MS` of `now`. */
export const freshFar = (far: FarBook | null, now: number): FarBook | null => far && now - far.at <= FAR_STALE_MS ? far : null;

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Reads one far book every `FAR_EVERY_MS` while `wanted()` says so (the book is live, the page is shown), one request at a time. A failed
 * read keeps the last snapshot until it ages out. `onFresh` is told when a new snapshot is held.
 */
export class FarPoller {
  latest: FarBook | null = null;
  /** When the reader last did anything: started, looked whether it was wanted, or finished a read (well or not). See `idleMs`. */
  #lastTick = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #busy = false; #stopped = true;
  /** Bumped by every start and stop, so a read begun before them neither keeps its answer nor schedules a second round of reads. */
  #run = 0;
  /** Ends the read in flight at once (its request aborted, its timers cleared): `stop` calls it. */
  #cancel: (() => void) | null = null;
  constructor(private readonly source: FarSource, private readonly wanted: () => boolean, private readonly onFresh: () => void = () => {},
    private readonly fetcher: Fetch = (url, init) => fetch(url, init), private readonly clock: () => number = Date.now, private readonly timeoutMs = FAR_TIMEOUT_MS) {}

  start(): void { if (!this.#stopped) return; this.#stopped = false; this.#run++; this.#lastTick = this.clock(); this.#schedule(FAR_FIRST_MS, this.#run); }
  /**
   * How long since the reader last did anything. A working reader ticks at least every `FAR_EVERY_MS` (a read that fails ticks too, so
   * an exchange that is down does not count); one whose reads stopped grows without end, and the server replaces it.
   */
  idleMs(now: number): number { return now - this.#lastTick; }
  stop(): void { this.#stopped = true; this.#run++; this.latest = null; if (this.#timer) clearTimeout(this.#timer); this.#timer = null; this.#cancel?.(); this.#cancel = null; }

  #schedule(ms: number, run: number): void {
    if (this.#stopped || run !== this.#run) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.poll(); }, ms);
    (this.#timer as { unref?: () => void }).unref?.();
  }
  /** One read now (when wanted and none in flight), then the next one scheduled. Public so a test can drive it. */
  async poll(): Promise<void> {
    const run = this.#run;
    if (this.#stopped) return;
    if (this.#busy) { this.#schedule(FAR_EVERY_MS, run); return; }
    this.#lastTick = this.clock();
    if (!this.wanted()) { this.#schedule(FAR_FIRST_MS, run); return; }
    this.#busy = true;
    // One deadline for the whole read, body included, and the read given up a second after it whatever it does: a read that never
    // settled would keep `#busy` set for good, so no further read was made (the live server went hours without OKX's and Aster's deep
    // books, 2026-10-15, while a fresh one read them; the cause was never established). The request is aborted however the read ends, so an
    // error answer whose body is never read does not hold its connection.
    const abort = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined, giveUp: ReturnType<typeof setTimeout> | undefined, end: (v: null) => void = () => {};
    this.#cancel = () => { abort.abort(); end(null); };
    try {
      deadline = setTimeout(() => abort.abort(), this.timeoutMs); (deadline as { unref?: () => void }).unref?.();
      const read = (async () => { const response = await this.fetcher(this.source.url, { signal: abort.signal }); return response.ok ? this.source.parse(await response.json()) : null; })();
      read.catch(() => { /* a read given up may still fail later: never an unhandled rejection */ });
      // Not unref'd: while a read is out this timer is what ends it, so it holds the process for that second (`stop` ends it sooner).
      const parsed = await Promise.race([read, new Promise<null>(resolve => { end = resolve; giveUp = setTimeout(() => resolve(null), this.timeoutMs + 1_000); })]);
      if (parsed && run === this.#run) { this.latest = { ...parsed, at: this.clock() }; this.onFresh(); }
    } catch { /* the last snapshot stands until it ages out */ }
    finally { abort.abort(); clearTimeout(deadline); clearTimeout(giveUp); this.#busy = false; if (run === this.#run) { this.#cancel = null; this.#lastTick = this.clock(); } }
    this.#schedule(FAR_EVERY_MS, run);
  }
}
