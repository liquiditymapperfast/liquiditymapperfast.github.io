import { STRIDE } from '../tape/ring.ts';
import type { SecondTally, TallyRing } from './tally.ts';

/**
 * Trades grouped by time: a block is `B` whole seconds of every market the view counts, clock-aligned (it starts at a multiple of `B`
 * seconds). Pure (no page): `panes/trades-view.ts` draws the blocks and the inspector reads one.
 *
 * One source per stretch of time (Research_Findings.md, the tape study of 2026-11-13; approved by Karl):
 * - from the tape's covered start (`SecondTally.coveredFrom`) on, the tally: totals of the orders the size filter lets in, counts, the
 *   largest buy and sell, and the reference market's VWAP;
 * - before it, with any size, the page's per-second flow (the Flow lines' data, held for hours at opening): totals and VWAP, no count, and
 *   the largest orders only from the recording ($25K up: its hour before the tape, else the stretch on screen asked of it, `older`);
 * - before it, from $25K up, the recorded orders (prints) the page read, from their own start, with their holes;
 * - before it, under $25K: nothing (a block there is not drawn at all; the list says where the smaller sizes start).
 * A block that mixes sources or holds a hole or reconnect is `partial` (before the tape, a stretch the recording did not listen to: the flow
 * holds zeros for seconds nobody recorded); a block with nothing known is `unknown`.
 */

/** A source's per-second flow of one market: bought and sold over whole seconds [from, to], a second's own VWAP (0: none). */
export interface FlowLike { buy(from: number, to: number): number; sell(from: number, to: number): number; ownPrice(sec: number): number; readonly span: { first: number; last: number } | null }
/** A recorded order (`Print`): time, market, side, VWAP, dollars and the prices it reached. */
export interface PrintLike { t: number; id: string; side: 'buy' | 'sell'; price: number; usd: number; lo?: number; hi?: number }
/**
 * The recording's orders the page holds (oldest first), the stretch [from, to) they cover (`to`: where they were asked up to, the tape's
 * start then), the holes in it, and the size they start at.
 */
export interface RecordedPrints { prints: readonly PrintLike[]; from: number; to: number; holes: readonly (readonly [number, number])[]; minUsd: number }
/**
 * A stretch [from, to) of the recording asked for the blocks on screen before its hour: the largest orders of it an answer carries (oldest
 * first), every order of the stretch from `floor` up among them. It names largest orders, never counts (it is not every order).
 */
export interface OlderPrints { from: number; to: number; prints: readonly PrintLike[]; floor: number }

/** One order named in a block: its dollars (unsigned), time, market, VWAP and the prices it reached; `recorded` when it came from the recording (from $25K). */
export interface NamedOrder { has: boolean; usd: number; t: number; id: string; price: number; lo: number; hi: number; recorded: boolean }
const noOrder = (): NamedOrder => ({ has: false, usd: 0, t: 0, id: '', price: 0, lo: 0, hi: 0, recorded: false });

/** Where a block's figures came from (bits). */
export const FROM = { tape: 1, flow: 2, prints: 4 } as const;

export interface Block {
  s: number; B: number;
  buy: number; sell: number;
  /** Dollars per venue slot (`venues` of the reader), bought and sold. */
  vBuy: Float64Array; vSell: Float64Array;
  /** Orders counted, or -1 where any part of the block has no count (the flow and the recording keep none). */
  n: number;
  topBuy: NamedOrder; topSell: NamedOrder;
  /** The reference market's VWAP in the block's last second that traded, and in the last second before the block (NaN: unknown). */
  refPx: number; refPrev: number;
  from: number;
  /** Part of the block is not covered by its source, or a hole or reconnect falls in it. */
  partial: boolean;
  /** A reconnect or a skipped batch falls in it: orders may be missing (`partial` too). */
  gap: boolean;
  /** Nothing is known of the block (before every source). */
  unknown: boolean;
  /** The whole block lies where nothing was recorded for it (a recording hole, or past the recording's end under a size floor) and holds nothing. */
  unrecorded: boolean;
  /** The block's time has not all passed yet, or it ended less than `SETTLE_MS` ago (a late order may still land in it). */
  forming: boolean; settling: boolean;
}
export const SETTLE_MS = 2_000;

export function emptyBlock(venues: number): Block {
  return { s: 0, B: 1, buy: 0, sell: 0, vBuy: new Float64Array(venues), vSell: new Float64Array(venues), n: 0, topBuy: noOrder(), topSell: noOrder(), refPx: NaN, refPrev: NaN, from: 0, partial: false, gap: false, unknown: true, unrecorded: false, forming: false, settling: false };
}

/**
 * The full bar width of one side, BTC's dollars, for a block of `B` seconds: a square-root length (`barLength`), full at about the week's
 * 99th percentile of one side of a block (Research_Findings.md, the tape study's week of flow: $2.42M a second, $90M a minute, $440M
 * five, $1.25B fifteen), so about 1 % of sides run over and a ten times larger side draws 3.2 times longer. Between the anchors (a custom
 * length) it is interpolated in logs of both. The caller scales it for the coin.
 */
const SCALE_ANCHORS: readonly (readonly [number, number])[] = [[1, 2.5e6], [60, 100e6], [300, 500e6], [900, 1.2e9]];
export function fullScale(B: number): number {
  const a = SCALE_ANCHORS;
  if (B <= a[0]![0]) return a[0]![1] * B;
  for (let i = 1; i < a.length; i++) {
    const [x1, y1] = a[i]!, [x0, y0] = a[i - 1]!;
    if (B <= x1) return Math.exp(Math.log(y0) + (Math.log(y1) - Math.log(y0)) * (Math.log(B / x0) / Math.log(x1 / x0)));
  }
  const [xl, yl] = a[a.length - 1]!;
  return yl * B / xl;
}
/** A side's bar length in px: square root of the dollars against `full`, capped at `width`; a positive side never under 1 px. */
export function barLength(usd: number, full: number, width: number): number {
  if (!(usd > 0) || !(full > 0)) return 0;
  return Math.max(1, Math.min(width, width * Math.sqrt(usd / full)));
}

/** The market rows of one block (the inspector): per market id, dollars bought and sold, and its own move in bp (NaN: unknown). */
export interface MarketRow { id: string; buy: number; sell: number; move: number }

/**
 * Reads blocks from the tally and the history sources. Venue slots are fixed by the caller (`setVenues`: each market id's slot), so a
 * venue keeps its place in the bar from block to block. A settled block of a minute or longer is kept (`#kept`) until the tally starts over
 * or its source changes: hours of seconds are added up once, not on every frame.
 */
export class BlockReader {
  tally: SecondTally | null = null;
  /** Each market's per-second flow (any size), for the time before the tape's covered start, and a count bumped whenever it is loaded. */
  flowOf: ((id: string) => FlowLike | undefined) | null = null;
  flowVersion: () => number = () => 0;
  /** The markets counted (ids), in the order the view lists them. */
  markets: readonly string[] = [];
  recorded: RecordedPrints | null = null;
  /** Older stretches of the recording (any size: the largest orders of blocks before `recorded` starts). */
  older: readonly OlderPrints[] = [];
  /** The reference market (its VWAP change is a block's price change). */
  ref = '';
  /** Exchange times (ms) where orders may be missing (the ring's reconnects and skips: [from, to]); kept blocks key on them. */
  get gaps(): readonly (readonly [number, number])[] { return this.#gaps; }
  set gaps(v: readonly (readonly [number, number])[]) { this.#gaps = v; let k = String(v.length); for (const [a, b] of v) k += `|${a}|${b}`; this.#gapsKey = k; }
  #gaps: readonly (readonly [number, number])[] = []; #gapsKey = '0';
  /** Before the tape: stretches (ms) the recording listened to no market, where the flow's zeros are seconds nobody recorded. */
  holes: readonly (readonly [number, number])[] = [];
  /**
   * From when (ms; Infinity: not known) each market's per-second flow holds every second: the recording listened to it (its coverage
   * record) and the page loaded its history from then (the flow book). From there on, outside the holes, a second its flow holds nothing
   * for was quiet: a market that did not trade for hours is not a gap, and the list does not end at it. A market not known so far back
   * makes a block partial where its flow does not reach, as before (review round 2: one market's record is not another's).
   */
  knownFrom: (id: string) => number = () => Infinity;
  /** A key for what `knownFrom` answers (the view sets it when the coverage record changes; the flow's loads are keyed apart). */
  knownKey = '';
  /** The size filter's dollars (the coin's), 0 any size. */
  minUsd = 0;
  side: 'both' | 'buy' | 'sell' = 'both';
  #slotOfId = new Map<string, number>();
  #slotOfIndex: number[] = [];
  #ringIds = 0;
  venues = 0;
  #kept = new Map<string, Block>();
  #keptKey = '';
  /** Blocks read lately that are not kept yet (settling, young): reused while their seconds' tally revisions and the sources stand. */
  #recent = new Map<number, { block: Block; revs: number; cov: number; ref: number }>();
  /** The markets counted as a set (the recording holds every market's orders; only those counted are added or named). */
  #marketSet = new Set<string>(); #marketsFor: readonly string[] = [];

  /** Fix the venue slots: `slotOf(id)` for every market (ids of one venue share a slot). Drops every kept block. */
  setVenues(count: number, slotOf: (id: string) => number): void {
    this.venues = count; this.#slotOfId.clear(); this.#slotOfIndex = []; this.#ringIds = 0; this.#kept.clear(); this.#recent.clear(); this.version++;
    this.#slotFn = slotOf;
  }
  #slotFn: (id: string) => number = () => 0;
  #slot(id: string): number { let s = this.#slotOfId.get(id); if (s === undefined) { s = this.#slotFn(id); this.#slotOfId.set(id, s); } return s; }
  #slotOfRingIndex(ring: TallyRing, m: number): number {
    while (this.#ringIds < ring.ids.length) { this.#slotOfIndex.push(this.#slot(ring.ids[this.#ringIds]!)); this.#ringIds++; }
    return this.#slotOfIndex[m] ?? -1;
  }
  /** Bumped whenever a source the blocks read may have changed (`forget`, `setVenues`): what is worked out from blocks keys on it. */
  version = 0;
  /** What every block is read from and under, as a key (the tally's start, the size, the side, the reference, the markets, the flow's loads, the gaps, the recording's start). */
  dataKey(): string { return `${this.tally?.resets ?? 0}|${this.minUsd}|${this.side}|${this.ref}|${this.markets.length}|${this.flowVersion()}|${this.#gapsKey}|${this.knownKey}`; }
  /** Forget every kept block (a source changed). */
  forget(): void { this.#kept.clear(); this.#recent.clear(); this.version++; }
  /** The tally's revisions of seconds [from, to) added up (each held second one more): any order counted into them changes it. */
  #revsOf(from: number, to: number): number {
    const t = this.tally!;
    let r = 0;
    for (let sec = from; sec < to; sec++) { const sl = t.slot(sec); if (sl >= 0) r += t.rev(sl) + 1; }
    return r;
  }

  /** The first whole second the tally covers (Infinity: none). */
  coveredSec(): number { const c = this.tally?.coveredFrom() ?? Infinity; return Number.isFinite(c) ? Math.ceil(c / 1000) : Infinity; }
  /** The oldest second any source knows for the current size (the list ends there). */
  oldestSec(): number {
    let oldest = this.coveredSec();
    if (this.minUsd > 0 && (!this.recorded || this.minUsd < this.recorded.minUsd)) return oldest;
    if (this.minUsd > 0) return Math.min(oldest, Math.ceil(this.recorded!.from / 1000));
    for (const id of this.markets) { const span = this.flowOf?.(id)?.span; if (span) oldest = Math.min(oldest, span.first); }
    return oldest;
  }

  /**
   * Read block `s` of `B` seconds into `out` (`now`: the newest exchange time, ms, for forming and settling). A block is kept only once
   * nothing it was read from can still move under it: settled two minutes, the tally not reading back, and wholly on one side of the
   * tape's covered start (which moves while the tally reads back and as the ring wraps); the key carries the flow's loads and the gaps.
   */
  read(s: number, B: number, out: Block, now: number): Block {
    const end = s + B, endMs = end * 1000;
    out.forming = endMs > now; out.settling = !out.forming && endMs + SETTLE_MS > now;
    const key = this.dataKey();
    if (key !== this.#keptKey) { this.#keptKey = key; this.#kept.clear(); this.#recent.clear(); }
    const cov = this.coveredSec();
    const keep = B >= 60 && !out.forming && endMs + 120_000 < now && !this.tally?.filling && (end <= cov || s >= cov);
    if (keep) { const k = this.#kept.get(`${s}|${B}`); if (k) { copyBlock(k, out); return out; } }
    // A block read lately (every frame reads the twenty on screen) and unchanged since: the tally's revisions of its seconds and of those
    // its price change looks back over, the covered start and the sources all as they were. Wholly after the covered start only (before
    // it the flow and the recording are keyed by the sources alone, and those blocks settle into the kept ones).
    // B < 1024 (a block is at most UNIT_MAX_S = 900 seconds), so the slot names one block.
    const slot = s * 1024 + B, forming = out.forming, settling = out.settling;
    // The reference market's index in the ring too: its first order there moves its price before the block from the flow to the tally.
    const revs = !keep && s >= cov && this.tally ? this.#revsOf(s - Math.max(2, B), end) : -1, tr = this.tally?.ring, refAt = tr ? this.#refIndex(tr) : -1;
    if (revs >= 0) {
      const r = this.#recent.get(slot);
      if (r && r.revs === revs && r.cov === cov && r.ref === refAt && r.block.vBuy.length === this.venues) { copyBlock(r.block, out); out.forming = forming; out.settling = settling; return out; }
    }
    this.#compute(s, B, out);
    if (keep) { const copy = emptyBlock(this.venues); copyBlock(out, copy); this.#kept.set(`${s}|${B}`, copy); if (this.#kept.size > 4096) this.#kept.clear(); }
    else if (revs >= 0) {
      if (this.#recent.size > 4096) this.#recent.clear();
      let r = this.#recent.get(slot);
      if (!r || r.block.vBuy.length !== this.venues) this.#recent.set(slot, r = { block: emptyBlock(this.venues), revs, cov, ref: refAt });
      copyBlock(out, r.block); r.revs = revs; r.cov = cov; r.ref = refAt;
    }
    return out;
  }

  #compute(s: number, B: number, out: Block): void {
    const end = s + B, tally = this.tally, ring = tally?.ring ?? null;
    out.s = s; out.B = B; out.buy = 0; out.sell = 0; out.vBuy.fill(0); out.vSell.fill(0); out.n = 0; out.from = 0; out.partial = false; out.gap = false; out.unknown = false; out.unrecorded = false;
    out.topBuy.has = false; out.topSell.has = false; out.refPx = NaN; out.refPrev = NaN;
    const cov = this.coveredSec(), tapeFrom = Math.max(s, cov);
    // The part before the tape's covered start: the flow (any size) or the recording (from its own floor), else unknown.
    let before = false;
    if (s < Math.min(end, cov)) { this.#history(s, Math.min(end, cov), out); before = out.from === 0; }
    if (tapeFrom < end && tally && ring) this.#tape(tally, ring, tapeFrom, end, out);
    if (out.from === 0) { out.unknown = true; out.n = -1; }
    // Part of the block is before every source: what is shown is the rest of it (no count, a dashed foot).
    else if (before) { out.partial = true; out.n = -1; }
    // A reconnect or a skipped batch inside the block: orders may be missing.
    for (const [a, b] of this.#gaps) if (a < end * 1000 && b > s * 1000) { out.partial = true; out.gap = true; break; }
    // Wholly in a stretch nobody recorded, with nothing in it: not a quiet block but an unknown one, which the list folds into one line.
    if (out.from === FROM.flow && out.buy === 0 && out.sell === 0) for (const [a, b] of this.holes) if (a <= s * 1000 && b >= end * 1000) { out.unrecorded = true; break; }
    // Something in it was recorded after all (the tape's part): a partial block, not an unrecorded one.
    if (out.unrecorded && ((out.from & FROM.tape) !== 0 || out.buy !== 0 || out.sell !== 0)) { out.unrecorded = false; out.partial = true; }
    // The reference market's VWAP before the block: its last second that traded, at most max(2 s, B) back.
    out.refPrev = this.#refBefore(s, Math.max(2, B));
  }

  /** The reference market's index in the ring (-1: not met yet), looked up once per ring size. */
  #refIndex(ring: TallyRing): number {
    if (this.#refFor !== `${this.ref}|${ring.ids.length}`) { this.#refFor = `${this.ref}|${ring.ids.length}`; this.#refAt = ring.ids.indexOf(this.ref); }
    return this.#refAt;
  }
  #refFor = ''; #refAt = -1;

  #tape(tally: SecondTally, ring: TallyRing, from: number, end: number, out: Block): void {
    let topB = 0, topBK = -1, topS = 0, topSK = -1, n = 0;
    const markets = tally.markets, refIndex = this.#refIndex(ring);
    // Every second from the covered start is known: one the tally holds no slot for had no order the view counts (a quiet second).
    for (let sec = from; sec < end; sec++) {
      const sl = tally.slot(sec);
      if (sl < 0) continue;
      n += tally.count(sl);
      for (let m = 0; m < markets; m++) {
        const b = tally.buy(m, sl), v = tally.sell(m, sl);
        if (b === 0 && v === 0) continue;
        const slot = this.#slotOfRingIndex(ring, m);
        out.buy += b; out.sell += v;
        if (slot >= 0) { out.vBuy[slot]! += b; out.vSell[slot]! += v; }
      }
      if (tally.topBuy(sl) > topB) { topB = tally.topBuy(sl); topBK = tally.topBuyK(sl); }
      if (tally.topSell(sl) > topS) { topS = tally.topSell(sl); topSK = tally.topSellK(sl); }
      if (refIndex >= 0) { const p = tally.vwap(refIndex, sl); if (p > 0) out.refPx = p; }
    }
    if (out.from !== 0) { out.partial = true; out.n = -1; } else out.n = n;
    out.from |= FROM.tape;
    // The tape's largest unless the part before it (the recording's) named a larger one.
    if (topBK >= 0 && !(out.topBuy.has && out.topBuy.usd >= topB)) readNamed(ring, topBK, out.topBuy);
    if (topSK >= 0 && !(out.topSell.has && out.topSell.usd >= topS)) readNamed(ring, topSK, out.topSell);
  }

  #history(s: number, end: number, out: Block): void {
    const rec = this.recorded;
    if (this.minUsd > 0) {
      // A size floor: only the recording can answer, from its own floor up and over its own stretch. Past its end (the tape began later than
      // it was asked up to: a ring that wrapped) nothing was recorded for this view: not a quiet block.
      if (!rec || this.minUsd < rec.minUsd || end * 1000 <= rec.from) return;
      const t0 = s * 1000, t1 = end * 1000;
      out.from |= FROM.prints; out.n = -1;
      if (t0 >= rec.to) { out.unrecorded = true; return; }
      if (t0 < rec.from || t1 > rec.to) out.partial = true;
      let inHole = false;
      for (const [a, b] of rec.holes) if (a < t1 && b > t0) { out.partial = true; if (a <= t0 && b >= Math.min(t1, rec.to)) inHole = true; break; }
      this.#prints(rec.prints, s, end, out, true);
      if (inHole && out.buy === 0 && out.sell === 0) out.unrecorded = true;
      return;
    }
    // Any size: the flow's totals (the side chosen), the recording's largest orders. A market known from before the block (`knownFrom`)
    // counts whole, quiet seconds included; one whose flow begins inside or after the block leaves that part out (partial).
    let flowed = false, known = false;
    const side = this.side;
    for (const id of this.markets) {
      const f = this.flowOf?.(id), whole = s * 1000 >= this.knownFrom(id);
      if (whole) known = true;
      if (!f?.span) continue;
      if (f.span.first > s && !whole) out.partial = true;
      const a = Math.max(s, f.span.first), z = Math.min(end - 1, f.span.last);
      if (z < a) continue;
      flowed = true;
      const b = side === 'sell' ? 0 : f.buy(a, z), v = side === 'buy' ? 0 : f.sell(a, z), slot = this.#slot(id);
      out.buy += b; out.sell += v;
      if (slot >= 0) { out.vBuy[slot]! += b; out.vSell[slot]! += v; }
      if (id === this.ref) for (let sec = z; sec >= a; sec--) { const p = f.ownPrice(sec); if (p > 0) { out.refPx = p; break; } }
    }
    if (!flowed && !known) return;
    out.from |= FROM.flow; out.n = -1;
    const t0 = s * 1000, t1 = end * 1000, recFrom = rec ? rec.from : Infinity;
    for (const [a, b] of this.holes) if (a < t1 && b > t0) { out.partial = true; break; }
    if (rec && t1 > recFrom) this.#prints(rec.prints, s, end, out, false);
    // Before the recording's hour: a stretch asked for the blocks on screen that holds the whole of this block's part before it.
    if (t0 < recFrom) { const w = olderFor(this.older, t0, Math.min(t1, recFrom)); if (w) this.#prints(w.prints, s, end, out, false); }
  }

  /** The recording's orders in [s, end) seconds (`p` oldest first): added up when `count` (a size floor), and the largest buy and sell named. */
  #prints(p: readonly PrintLike[], s: number, end: number, out: Block, count: boolean): void {
    const t0 = s * 1000, t1 = end * 1000;
    if (this.#marketsFor !== this.markets) { this.#marketsFor = this.markets; this.#marketSet = new Set(this.markets); }
    const counted = this.#marketSet;
    let lo = 0, hi = p.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (p[mid]!.t < t0) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < p.length && p[i]!.t < t1; i++) {
      const o = p[i]!, buy = o.side === 'buy';
      if (o.usd < (count ? this.minUsd : 0) || (this.side === 'buy' && !buy) || (this.side === 'sell' && buy) || !counted.has(o.id)) continue;
      if (count) {
        const slot = this.#slot(o.id);
        if (buy) { out.buy += o.usd; if (slot >= 0) out.vBuy[slot]! += o.usd; } else { out.sell += o.usd; if (slot >= 0) out.vSell[slot]! += o.usd; }
      }
      const named = buy ? out.topBuy : out.topSell;
      if (!named.has || o.usd > named.usd) setNamed(named, o.usd, o.t, o.id, o.price, o.lo ?? o.price, o.hi ?? o.price, true);
    }
  }

  /** The reference market's VWAP in its last second that traded before second `s`, looking back at most `reach` seconds (NaN: none). */
  #refBefore(s: number, reach: number): number {
    const tally = this.tally, ring = tally?.ring, cov = this.coveredSec();
    const refIndex = ring ? this.#refIndex(ring) : -1;
    const flow = this.flowOf?.(this.ref);
    for (let sec = s - 1; sec >= s - reach; sec--) {
      if (sec >= cov && tally && refIndex >= 0) { const sl = tally.slot(sec); if (sl >= 0) { const p = tally.vwap(refIndex, sl); if (p > 0) return p; } continue; }
      const p = flow?.ownPrice(sec) ?? 0;
      if (p > 0) return p;
    }
    return NaN;
  }

  /**
   * The inspector's rows for block `s` of `B` seconds: every market counted with its dollars bought and sold and its own move (its last
   * VWAP in the block against its last before it, no older than max(2 s, B)), largest first. Read on demand (a block shown in full).
   */
  marketRows(s: number, B: number): MarketRow[] {
    const end = s + B, tally = this.tally, ring = tally?.ring ?? null, cov = this.coveredSec(), rows: MarketRow[] = [], split = Math.min(end, Math.max(s, cov));
    // Under a size floor the part before the tape is the recording's orders, counted per market as the block's own totals count them.
    const recorded = new Map<string, [number, number]>(), rec = this.recorded;
    if (this.minUsd > 0 && rec && this.minUsd >= rec.minUsd && split > s) {
      const p = rec.prints, t0 = s * 1000, t1 = split * 1000;
      let lo = 0, hi = p.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (p[mid]!.t < t0) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < p.length && p[i]!.t < t1; i++) {
        const o = p[i]!, buy = o.side === 'buy';
        if (o.usd < this.minUsd || (this.side === 'buy' && !buy) || (this.side === 'sell' && buy)) continue;
        const e = recorded.get(o.id) ?? [0, 0];
        if (buy) e[0] += o.usd; else e[1] += o.usd;
        recorded.set(o.id, e);
      }
    }
    for (const id of this.markets) {
      let buy = recorded.get(id)?.[0] ?? 0, sell = recorded.get(id)?.[1] ?? 0, last = 0, before = 0;
      const m = ring ? ring.ids.indexOf(id) : -1, f = this.flowOf?.(id);
      // Before the tape's covered start: the flow's range sums (any size; under a floor the recording names orders, not markets' totals).
      if (split > s && f?.span && this.minUsd === 0) {
        const a = Math.max(s, f.span.first), z = Math.min(split - 1, f.span.last);
        if (z >= a) { if (this.side !== 'sell') buy += f.buy(a, z); if (this.side !== 'buy') sell += f.sell(a, z); for (let sec = z; sec >= a && !last; sec--) last = f.ownPrice(sec); }
      }
      if (tally && m >= 0) for (let sec = split; sec < end; sec++) { const sl = tally.slot(sec); if (sl >= 0) { buy += tally.buy(m, sl); sell += tally.sell(m, sl); const p = tally.vwap(m, sl); if (p > 0) last = p; } }
      for (let sec = s - 1; sec >= s - Math.max(2, B) && !before; sec--) {
        if (sec >= cov && tally && m >= 0) { const sl = tally.slot(sec); if (sl >= 0) before = tally.vwap(m, sl); }
        else before = f?.ownPrice(sec) ?? 0;
      }
      if (buy === 0 && sell === 0 && !last) continue;
      rows.push({ id, buy, sell, move: last > 0 && before > 0 ? 1e4 * Math.log(last / before) : NaN });
    }
    return rows.sort((a, b) => (b.buy + b.sell) - (a.buy + a.sell));
  }
}

/** The older stretch that holds the whole of [t0, t1) (ms), if one does. */
export function olderFor(older: readonly OlderPrints[], t0: number, t1: number): OlderPrints | undefined {
  for (const w of older) if (w.from <= t0 && w.to >= t1) return w;
  return undefined;
}
function setNamed(o: NamedOrder, usd: number, t: number, id: string, price: number, lo: number, hi: number, recorded: boolean): void {
  o.has = true; o.usd = usd; o.t = t; o.id = id; o.price = price; o.lo = lo; o.hi = hi; o.recorded = recorded;
}
/** Read write `k` of the ring into a named order (left without one when the ring has wrapped past it). */
function readNamed(ring: TallyRing, k: number, o: NamedOrder): void {
  if (k < ring.first || k >= ring.written) return;
  const at = (k % ring.capacity) * STRIDE, d = ring.data, usd = d[at + 2]!;
  setNamed(o, usd < 0 ? -usd : usd, ring.t0 + d[at]!, ring.ids[d[at + 3]!] ?? '', ring.p0 + d[at + 1]!, ring.p0 + d[at + 4]!, ring.p0 + d[at + 5]!, false);
}
export function copyBlock(a: Block, b: Block): void {
  b.s = a.s; b.B = a.B; b.buy = a.buy; b.sell = a.sell; b.vBuy.set(a.vBuy); b.vSell.set(a.vSell); b.n = a.n;
  Object.assign(b.topBuy, a.topBuy); Object.assign(b.topSell, a.topSell);
  b.refPx = a.refPx; b.refPrev = a.refPrev; b.from = a.from; b.partial = a.partial; b.gap = a.gap; b.unknown = a.unknown; b.unrecorded = a.unrecorded; b.forming = a.forming; b.settling = a.settling;
}

// ---- the inspector's notes: facts observed in a block's orders, never who or why ------------------------------------------------------

/** An order of a block as the notes read it. */
export interface NoteOrder { t: number; id: string; venue: string; usd: number }
/** Orders of at least `min` on one side on two or more venues within 5 ms (first to last, no chaining past it), largest total first. */
export interface Coincidence { side: 1 | -1; t: number; usd: number; venues: string[] }
export const COINCIDENCE_MS = 5;
export function coincidences(orders: readonly NoteOrder[], min: number): Coincidence[] {
  const big = orders.filter(o => Math.abs(o.usd) >= min).sort((a, b) => a.t - b.t), out: Coincidence[] = [], used = new Set<NoteOrder>();
  for (let i = 0; i < big.length; i++) {
    const head = big[i]!;
    if (used.has(head)) continue;
    const side = head.usd > 0 ? 1 : -1, group: NoteOrder[] = [];
    for (let j = i; j < big.length && big[j]!.t - head.t <= COINCIDENCE_MS; j++) { const o = big[j]!; if ((o.usd > 0 ? 1 : -1) === side && !used.has(o)) group.push(o); }
    const venues = [...new Set(group.map(o => o.venue))];
    if (venues.length < 2) continue;
    for (const o of group) used.add(o);
    out.push({ side, t: head.t, usd: group.reduce((a, o) => a + Math.abs(o.usd), 0), venues });
  }
  return out.sort((a, b) => b.usd - a.usd);
}
/** Five or more orders on one market and side, each within 1 % of the one before and at most 10 s after it. */
export interface Repeat { id: string; side: 1 | -1; n: number; lo: number; hi: number; ms: number }
/** An order the inspector names: when, where, its signed dollars, VWAP and the prices it reached. */
export interface ScanOrder extends NoteOrder { price: number; lo: number; hi: number }

/**
 * One pass over a block's orders for the inspector, with no object per order (a busy minute holds over 100,000): the `k` largest from
 * `floor` up (the order they were added in breaks a tie, as a stable sort does), the orders from `big` up (all the coincidence note reads),
 * and each market and side's sizes for the repeats note, in growable typed arrays. `repeats()` gives what `repeats()` gives for the same
 * orders. `group` is any small whole number the caller keeps per market (the ring's index; the recording's orders their own).
 */
export class OrderScan {
  largest: ScanOrder[] = [];
  big: NoteOrder[] = [];
  #k = 9; #floor = 0; #bigMin = Infinity;
  #t: Float64Array[] = []; #u: Float64Array[] = []; #n: number[] = []; #ids: string[] = []; #used: number[] = [];
  constructor(private readonly venueOf: (id: string) => string) {}
  reset(k: number, floor: number, big: number): void {
    this.#k = k; this.#floor = floor; this.#bigMin = big; this.largest = []; this.big = [];
    for (const g of this.#used) this.#n[g] = 0;
    this.#used = [];
  }
  add(group: number, id: string, t: number, usd: number, price: number, lo: number, hi: number): void {
    const a = usd < 0 ? -usd : usd;
    if (a >= this.#floor) {
      const L = this.largest, full = L.length >= this.#k;
      if (!full || a > Math.abs(L[L.length - 1]!.usd)) {
        let at = L.length - (full ? 1 : 0);
        while (at > 0 && Math.abs(L[at - 1]!.usd) < a) at--;
        const o: ScanOrder = { t, id, venue: this.venueOf(id), usd, price, lo, hi };
        if (full) L.pop();
        L.splice(at, 0, o);
      }
    }
    if (a >= this.#bigMin) this.big.push({ t, id, venue: this.venueOf(id), usd });
    if (a < 10) return;
    const g = 2 * group + (usd > 0 ? 0 : 1);
    let n = this.#n[g] ?? 0;
    if (n === 0) { this.#used.push(g); this.#ids[g] = id; }
    let ts = this.#t[g], us = this.#u[g];
    if (!ts || !us || n >= ts.length) {
      const grown = Math.max(64, (ts?.length ?? 0) * 2), nt = new Float64Array(grown), nu = new Float64Array(grown);
      if (ts && us) { nt.set(ts.subarray(0, n)); nu.set(us.subarray(0, n)); }
      this.#t[g] = ts = nt; this.#u[g] = us = nu;
    }
    ts[n] = t; us[n] = a; this.#n[g] = ++n;
  }
  repeats(minN = 5, tol = 0.01, gapMs = 10_000): Repeat[] {
    const out: Repeat[] = [];
    for (const g of this.#used) {
      const n = this.#n[g]!, ts = this.#t[g]!, us = this.#u[g]!;
      let sorted = true;
      for (let i = 1; i < n; i++) if (ts[i]! < ts[i - 1]!) { sorted = false; break; }
      let T = ts, U = us;
      if (!sorted) {
        // A stable sort by time (an order a batch delivered late), as `repeats` sorts its lists.
        const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => ts[a]! - ts[b]! || a - b);
        T = Float64Array.from(idx, i => ts[i]!); U = Float64Array.from(idx, i => us[i]!);
      }
      let start = 0;
      for (let i = 1; i <= n; i++) {
        const same = i < n && T[i]! - T[i - 1]! <= gapMs && Math.abs(U[i]! / U[i - 1]! - 1) <= tol;
        if (same) continue;
        if (i - start >= minN) {
          let lo = Infinity, hi = -Infinity;
          for (let j = start; j < i; j++) { const u = U[j]!; if (u < lo) lo = u; if (u > hi) hi = u; }
          out.push({ id: this.#ids[g]!, side: g % 2 === 0 ? 1 : -1, n: i - start, lo, hi, ms: T[i - 1]! - T[start]! });
        }
        start = i;
      }
    }
    return out.sort((a, b) => b.n - a.n);
  }
}
export function repeats(orders: readonly NoteOrder[], minN = 5, tol = 0.01, gapMs = 10_000): Repeat[] {
  const by = new Map<string, NoteOrder[]>(), out: Repeat[] = [];
  for (const o of orders) { if (Math.abs(o.usd) < 10) continue; const k = `${o.id}|${o.usd > 0 ? 1 : -1}`; let list = by.get(k); if (!list) by.set(k, list = []); list.push(o); }
  for (const [k, list] of by) {
    list.sort((a, b) => a.t - b.t);
    let start = 0;
    for (let i = 1; i <= list.length; i++) {
      const same = i < list.length && list[i]!.t - list[i - 1]!.t <= gapMs && Math.abs(Math.abs(list[i]!.usd) / Math.abs(list[i - 1]!.usd) - 1) <= tol;
      if (same) continue;
      if (i - start >= minN) {
        const run = list.slice(start, i), a = run.map(o => Math.abs(o.usd));
        out.push({ id: k.slice(0, k.lastIndexOf('|')), side: k.endsWith('|1') ? 1 : -1, n: run.length, lo: Math.min(...a), hi: Math.max(...a), ms: run[run.length - 1]!.t - run[0]!.t });
      }
      start = i;
    }
  }
  return out.sort((a, b) => b.n - a.n);
}
