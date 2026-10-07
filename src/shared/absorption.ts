/**
 * Absorption: a lot of market volume on one side, at one price, inside a short window. Every one of those fills met a resting order at that
 * price, so the passive side there took all of it (passive buyers took the sells, passive sellers took the buys). The rule is the one the
 * order-flow tools use, and it marks what traded; it does not say what price did afterwards.
 *
 * The rule, per instrument and aggressor side:
 *  - Each fill, when it arrives, looks back over the fills of its side at its price whose time is at or after its own minus the window,
 *    itself included, and adds up their USD. Every fill in that set is credited the larger of what it had and that sum, so a fill keeps the
 *    largest window it ever belonged to (a fill early in a burst is credited when the later fills arrive).
 *  - A fill is marked when its credit reaches the threshold. The threshold is a fixed USD amount, or the mean plus k standard deviations of
 *    the window sums of the recent past: per price and side, a window opens at a fill and takes the fills up to its opening time plus the
 *    window, and the next fill after that opens the next one.
 *
 * Times are the exchange's, never going backwards within an instrument: a fill stamped a little earlier than one already seen (feeds
 * deliver a few milliseconds out of order) counts at the time of that one. A fill stamped more than `LATE_MS` earlier, or inside a minute
 * already settled, is left out: it is history arriving late (some venues send their recent trades again when a feed connects, newest
 * first), and moving it forward would sum trades minutes apart as if they met in one window. Fills arrive here after duplicates are
 * removed (a replayed fill would otherwise add to every sum). A sum does not depend on how a venue splits an order into fills, unlike a
 * size floor on single prints.
 *
 * What is kept: the threshold is the page's to choose, and changing it re-judges the whole history, so the recorder keeps candidates rather
 * than marks. A candidate group is a run of fills at one price and side with gaps no longer than the window, with its largest credit at
 * least `GROUP_FLOOR_USD`; it carries, for each credit level its fills reached, the USD, the fill count and the time span of the fills
 * credited at least that much, so any threshold gives the marked part exactly. Each instrument keeps at most `GROUPS_PER_MINUTE` groups a
 * minute (the largest); when one is left out, that minute's floor rises to its credit, and a threshold under the floor is told it is not
 * complete there. Per minute, the window sums' count, mean and squared deviations are kept for the automatic threshold.
 */

/** The window, in ms (the usual default of absorption indicators). */
export const ABSORPTION_WINDOW_MS = 10;
/** The smallest credit a group must reach to be kept. */
export const GROUP_FLOOR_USD = 25_000;
/** The most groups kept per instrument per minute: the largest. */
export const GROUPS_PER_MINUTE = 10;
/** How far behind an instrument's clock a fill may be stamped and still count (at the clock). Live feeds measured: at most 25 ms. */
export const LATE_MS = 250;
/** The most instruments one history question may name (the page asks about every market it knows). */
export const MAX_ABSORPTION_INSTRUMENTS = 200;
const MINUTE = 60_000;
/** An instrument with nothing new for this long (by the receiving clock) has its runs and windows closed. */
const QUIET_MS = 500;
/** A minute is settled (written, and its floor final) once its instrument's clock, or the receiving clock for a quiet one, is this far past its end. */
const MINUTE_SETTLE_MS = 3_000;
/** Groups and minutes this recent are held in memory to answer the page; older ones are asked of the store. */
const MEMORY_MS = 2 * 3_600_000;
const RETENTION_MS = 7 * 24 * 3_600_000;

/** [credit, USD, fills, first time, last time]: the fills credited at least `credit`, credits falling from row to row (USD and fills add up). */
export type AbsorptionStep = [number, number, number, number, number];
/** A candidate group: instrument, aggressor side, price, its first fill's time, and its steps (the first holds its largest credit). */
export interface AbsorptionGroup { id: string; side: 'buy' | 'sell'; price: number; t0: number; steps: AbsorptionStep[] }
/** One minute of an instrument: the window sums opened in it (count, mean, squared deviations) and the credit under which groups may be missing. */
export interface AbsorptionMinute { id: string; t: number; n: number; mean: number; m2: number; floor: number }
/**
 * The page's question answered: groups (per instrument the largest first), each instrument's highest floor over the window, settled minutes,
 * and the instruments whose groups were cut at the limit (the smallest of them are left out).
 */
export interface AbsorptionAnswer { groups: AbsorptionGroup[]; floors: Record<string, number>; minutes: AbsorptionMinute[]; capped: string[] }

export interface AbsorptionStore {
  /** Groups and minutes since `since`, for what the recorder holds in memory. */
  load(since: number): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] };
  save(groups: AbsorptionGroup[], minutes: AbsorptionMinute[], expireBefore: number): void;
  /** Per instrument of `ids`: its groups whose first time is in [from, to) with a largest credit of at least its `mins` entry, the largest first, at most `limit` (the browser's store answers later). */
  query(ids: readonly string[], mins: readonly number[], from: number, to: number, limit: number): AbsorptionGroup[] | Promise<AbsorptionGroup[]>;
  /** Minutes of `ids` in [from, to). */
  minutes(ids: readonly string[], from: number, to: number): AbsorptionMinute[] | Promise<AbsorptionMinute[]>;
  close(): void;
}

/** The largest credit of a group. */
export const peakOf = (g: AbsorptionGroup): number => g.steps[0]?.[0] ?? 0;

/** Chan's merge of two (count, mean, squared deviations) summaries. */
export function mergeMoments(a: { n: number; mean: number; m2: number }, b: { n: number; mean: number; m2: number }): { n: number; mean: number; m2: number } {
  if (!a.n) return { n: b.n, mean: b.mean, m2: b.m2 };
  if (!b.n) return { n: a.n, mean: a.mean, m2: a.m2 };
  const n = a.n + b.n, d = b.mean - a.mean;
  return { n, mean: a.mean + d * b.n / n, m2: a.m2 + b.m2 + d * d * a.n * b.n / n };
}

/** The automatic threshold from minutes (any order): mean + k standard deviations of every window sum in them; null when there are none. */
export function autoThreshold(minutes: Iterable<{ n: number; mean: number; m2: number }>, k: number): number | null {
  let acc = { n: 0, mean: 0, m2: 0 };
  for (const m of minutes) acc = mergeMoments(acc, m);
  if (!acc.n) return null;
  return acc.mean + k * Math.sqrt(acc.m2 / acc.n);
}

/** The steps of a set of fills (credit, USD, time), counting only credits of at least `floor`. */
export function stepsOf(fills: readonly { credit: number; usd: number; t: number }[], floor: number): AbsorptionStep[] {
  const kept = fills.filter(f => f.credit >= floor).sort((a, b) => b.credit - a.credit);
  const steps: AbsorptionStep[] = [];
  let usd = 0, n = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < kept.length; i++) {
    const f = kept[i]!;
    usd += f.usd; n++; lo = Math.min(lo, f.t); hi = Math.max(hi, f.t);
    if (i === kept.length - 1 || kept[i + 1]!.credit !== f.credit) steps.push([f.credit, usd, n, lo, hi]);
  }
  return steps;
}

/** The marked part of a group at `threshold`: its USD, fills and time span, or null when none of it reaches the threshold. */
export function markedPart(g: AbsorptionGroup, threshold: number): { usd: number; fills: number; t0: number; t1: number; peak: number } | null {
  let found: AbsorptionStep | null = null;
  for (const step of g.steps) { if (step[0] >= threshold) found = step; else break; }
  return found ? { usd: found[1], fills: found[2], t0: found[3], t1: found[4], peak: peakOf(g) } : null;
}

interface Fill { t: number; usd: number; credit: number }
interface Run { side: 'buy' | 'sell'; price: number; fills: Fill[]; last: number }
interface Window { start: number; sum: number }
interface MinuteState { n: number; mean: number; m2: number; floor: number; groups: AbsorptionGroup[] }

class InstrumentState {
  clock = -Infinity;
  lastSeenAt = 0;
  /** The end of the last minute settled: a fill stamped before it is left out (its row is written and final). */
  settledUntil = -Infinity;
  /** Fills left out for being stamped too far behind the clock or inside a settled minute. */
  late = 0;
  /** The fills of the last window, per side and price ("buy|83000.5"): only these can still be in a window. */
  readonly recent = new Map<string, Fill[]>();
  /** The open runs and windows, per side and price. */
  readonly runs = new Map<string, Run>();
  readonly windows = new Map<string, Window>();
  /** Minutes not settled yet. */
  readonly minutes = new Map<number, MinuteState>();
}

/** Detects absorption candidates on every fill and keeps them with the per-minute window statistics (see the module comment). */
export class AbsorptionRecorder {
  readonly #instruments = new Map<string, InstrumentState>();
  #freshGroups: AbsorptionGroup[] = [];
  #freshMinutes: AbsorptionMinute[] = [];
  /** Groups and settled minutes from `#memoryFrom` on (the store holds everything settled; memory answers the recent part). */
  #memoryGroups: AbsorptionGroup[] = [];
  readonly #memoryMinutes = new Map<string, Map<number, AbsorptionMinute>>();
  #memoryFrom: number;
  #unsavedGroups: AbsorptionGroup[] = [];
  #unsavedMinutes: AbsorptionMinute[] = [];
  readonly #store: AbsorptionStore | null;

  readonly windowMs: number;
  readonly #retentionMs: number;
  readonly #perMinute: number;
  readonly #floor: number;

  constructor(store: AbsorptionStore | null = null, private now: () => number = Date.now, { retentionMs = RETENTION_MS, windowMs = ABSORPTION_WINDOW_MS, perMinute = GROUPS_PER_MINUTE, floorUsd = GROUP_FLOOR_USD }: { retentionMs?: number; windowMs?: number; perMinute?: number; floorUsd?: number } = {}) {
    this.#store = store; this.windowMs = windowMs; this.#retentionMs = retentionMs; this.#perMinute = perMinute; this.#floor = floorUsd;
    this.#memoryFrom = store ? now() - MEMORY_MS : -Infinity;
    if (store) {
      const { groups, minutes } = store.load(this.#memoryFrom);
      this.#memoryGroups = groups.filter(g => g.t0 >= this.#memoryFrom);
      for (const m of minutes) this.#remember(m);
    }
  }

  /** One fill, after duplicates were removed. */
  add(id: string, t: number, price: number, usd: number, side: 'buy' | 'sell'): void {
    if (!id || !(price > 0) || !(usd > 0) || !Number.isFinite(t) || (side !== 'buy' && side !== 'sell')) return;
    let s = this.#instruments.get(id); if (!s) { s = new InstrumentState(); this.#instruments.set(id, s); }
    // Also older than what memory answers for: the store holds that time, and a venue sending hours-old trades again must not add to it.
    if (t < s.clock - LATE_MS || t < s.settledUntil || t < this.#memoryFrom) { s.late++; return; }
    s.lastSeenAt = this.now();
    const at = Math.max(t, s.clock); s.clock = at;
    const W = this.windowMs, key = `${side}|${price}`;
    // Runs and windows this fill's time has left behind are complete.
    this.#closePast(id, s, at);
    // The window ending at this fill: same side and price, time at or after its own minus the window, itself included.
    let recent = s.recent.get(key); if (!recent) { recent = []; s.recent.set(key, recent); }
    const fill: Fill = { t: at, usd, credit: 0 };
    recent.push(fill);
    let sum = 0, from = recent.length;
    for (let i = recent.length - 1; i >= 0; i--) { if (recent[i]!.t < at - W) break; sum += recent[i]!.usd; from = i; }
    for (let i = from; i < recent.length; i++) if (recent[i]!.credit < sum) recent[i]!.credit = sum;
    if (from > 0) recent.splice(0, from);   // the clock only moves on: older fills can never be in a window again
    // The run of fills at this price and side (a gap longer than the window has already closed the one before).
    let run = s.runs.get(key);
    if (!run) { run = { side, price, fills: [], last: at }; s.runs.set(key, run); }
    run.fills.push(fill); run.last = at;
    // The window sums for the automatic threshold: start-anchored, the next fill after the window opens the next one.
    const win = s.windows.get(key);
    if (win && at <= win.start + W) win.sum += usd;
    else { if (win) this.#closeWindow(s, win); s.windows.set(key, { start: at, sum: usd }); }
  }

  /** Close what is complete everywhere and settle finished minutes; call it now and then (the engine does, every pass). */
  step(): void {
    const now = this.now();
    for (const [id, s] of this.#instruments) {
      const quiet = now - s.lastSeenAt >= QUIET_MS;
      this.#closePast(id, s, quiet ? Infinity : s.clock);
      // Price levels nobody has traded at for longer than the window hold nothing that can be in a window again.
      for (const [key, recent] of s.recent) if (!recent.length || recent[recent.length - 1]!.t < s.clock - this.windowMs) s.recent.delete(key);
      // A quiet instrument's clock goes on from its last fill by the time that has passed here: the exchange's clock, not this computer's,
      // which may be seconds off (settling on it could close a minute the exchange is still in).
      this.#settleMinutes(id, s, quiet ? s.clock + (now - s.lastSeenAt) : s.clock);
    }
  }

  /** Close the runs and windows that no fill at or after `clock` can join. */
  #closePast(id: string, s: InstrumentState, clock: number): void {
    const W = this.windowMs;
    for (const [key, run] of s.runs) if (run.last < clock - W) { this.#closeRun(id, s, run); s.runs.delete(key); }
    for (const [key, win] of s.windows) if (win.start + W < clock) { this.#closeWindow(s, win); s.windows.delete(key); }
  }

  /** Settle the minutes that ended a while before `clock` and in which no open run or window began: their floor and groups are final. */
  #settleMinutes(id: string, s: InstrumentState, clock: number): void {
    let openFrom = Infinity;
    for (const run of s.runs.values()) openFrom = Math.min(openFrom, run.fills[0]!.t);
    for (const win of s.windows.values()) openFrom = Math.min(openFrom, win.start);
    for (const [t, m] of s.minutes) {
      if (t + MINUTE > clock - MINUTE_SETTLE_MS || t + MINUTE > openFrom) continue;
      const row: AbsorptionMinute = { id, t, n: m.n, mean: m.mean, m2: m.m2, floor: m.floor };
      // The first row of a minute stands: after a restart, trades a venue sends again would otherwise replace a whole minute with a part.
      if (this.#remember(row)) { this.#freshMinutes.push(row); this.#unsavedMinutes.push(row); }
      this.#unsavedGroups.push(...m.groups);
      s.minutes.delete(t); s.settledUntil = Math.max(s.settledUntil, t + MINUTE);
    }
  }

  #minute(s: InstrumentState, t: number): MinuteState {
    const key = Math.floor(t / MINUTE) * MINUTE;
    let m = s.minutes.get(key);
    if (!m) { m = { n: 0, mean: 0, m2: 0, floor: this.#floor, groups: [] }; s.minutes.set(key, m); }
    return m;
  }

  #closeWindow(s: InstrumentState, win: Window): void {
    const m = this.#minute(s, win.start), merged = mergeMoments(m, { n: 1, mean: win.sum, m2: 0 });
    m.n = merged.n; m.mean = merged.mean; m.m2 = merged.m2;
  }

  #closeRun(id: string, s: InstrumentState, run: Run): void {
    let peak = 0; for (const f of run.fills) if (f.credit > peak) peak = f.credit;
    if (peak < this.#floor) return;
    const t0 = run.fills[0]!.t, m = this.#minute(s, t0);
    const group: AbsorptionGroup = { id, side: run.side, price: run.price, t0, steps: stepsOf(run.fills, this.#floor) };
    m.groups.push(group);
    if (m.groups.length > this.#perMinute) {
      // Only the largest are kept; the credit of the one left out is the floor under which this minute may be missing groups.
      m.groups.sort((a, b) => peakOf(b) - peakOf(a));
      const left = m.groups.pop()!;
      m.floor = Math.max(m.floor, peakOf(left));
      if (left === group) return;
      const at = this.#memoryGroups.indexOf(left); if (at >= 0) this.#memoryGroups.splice(at, 1);
    }
    this.#freshGroups.push(group); this.#memoryGroups.push(group);
  }

  /** Hold a settled minute; false when one for that instrument and time is held already (the first stands). */
  #remember(m: AbsorptionMinute): boolean {
    let byTime = this.#memoryMinutes.get(m.id); if (!byTime) { byTime = new Map(); this.#memoryMinutes.set(m.id, byTime); }
    if (byTime.has(m.t)) return false;
    byTime.set(m.t, m);
    return true;
  }

  /** Fills of `id` left out for being stamped too far behind its clock or inside a settled minute. */
  lateFills(id: string): number { return this.#instruments.get(id)?.late ?? 0; }

  /** Groups found and minutes settled since the last call (for the live stream). */
  takeFresh(): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] } {
    const out = { groups: this.#freshGroups, minutes: this.#freshMinutes };
    this.#freshGroups = []; this.#freshMinutes = [];
    return out;
  }

  /** Write what is settled, and let go of memory older than what memory answers for. */
  flush(): void {
    const now = this.now(), memoryFrom = now - MEMORY_MS;
    if (this.#store && memoryFrom > this.#memoryFrom) {
      this.#memoryFrom = memoryFrom;
      this.#memoryGroups = this.#memoryGroups.filter(g => g.t0 >= memoryFrom);
      for (const byTime of this.#memoryMinutes.values()) for (const t of byTime.keys()) if (t < memoryFrom) byTime.delete(t);
    } else if (!this.#store) {
      // Without a store, memory is everything: keep the retention.
      const cutoff = now - this.#retentionMs;
      this.#memoryGroups = this.#memoryGroups.filter(g => g.t0 >= cutoff);
      for (const byTime of this.#memoryMinutes.values()) for (const t of byTime.keys()) if (t < cutoff) byTime.delete(t);
    }
    if (this.#store && (this.#unsavedGroups.length || this.#unsavedMinutes.length)) this.#store.save(this.#unsavedGroups, this.#unsavedMinutes, now - this.#retentionMs);
    this.#unsavedGroups = []; this.#unsavedMinutes = [];
  }
  close(): void { this.step(); this.flush(); this.#store?.close(); }

  /**
   * The page's question for a window [from, to): per instrument, the groups that started in it with a largest credit of at least its
   * `mins` entry (its threshold), the largest first and at most `limit` of them; each instrument's highest floor over the window; and the
   * settled minutes of [since, now] for the automatic threshold. Memory answers from `#memoryFrom` on, the store before that.
   */
  async query(ids: readonly string[], mins: readonly number[], from: number, to: number, limit: number, since: number): Promise<AbsorptionAnswer> {
    const min = new Map(ids.map((id, i) => [id, mins[i] ?? Infinity])), split = Math.max(from, this.#memoryFrom);
    const found: AbsorptionGroup[] = [];
    // One more than the limit, so an instrument with exactly `limit` groups is not reported as cut.
    if (this.#store && from < this.#memoryFrom) found.push(...await this.#store.query(ids, mins, from, Math.min(to, this.#memoryFrom), limit + 1));
    for (const g of this.#memoryGroups) if (g.t0 >= split && g.t0 < to && peakOf(g) >= (min.get(g.id) ?? Infinity)) found.push(g);
    // A group found again (trades sent again after a restart) is one group: the store keeps one row, and memory may hold both.
    const byId = new Map<string, AbsorptionGroup[]>(), keys = new Set<string>();
    for (const g of found) {
      const key = `${g.id}|${g.side}|${g.price}|${g.t0}`; if (keys.has(key)) continue; keys.add(key);
      let list = byId.get(g.id); if (!list) { list = []; byId.set(g.id, list); } list.push(g);
    }
    const groups: AbsorptionGroup[] = [], capped: string[] = [];
    for (const [id, list] of byId) { list.sort((a, b) => peakOf(b) - peakOf(a)); if (list.length > limit) capped.push(id); groups.push(...list.slice(0, limit)); }
    const floors: Record<string, number> = {};
    const raise = (id: string, floor: number): void => { floors[id] = Math.max(floors[id] ?? 0, floor); };
    for (const m of await this.#minutesOf(ids, from, to)) raise(m.id, m.floor);
    for (const [id, s] of this.#instruments) if (min.has(id)) for (const [t, m] of s.minutes) if (t >= from && t < to) raise(id, m.floor);
    return { groups, floors, minutes: await this.#minutesOf(ids, since, Infinity), capped };
  }

  async #minutesOf(ids: readonly string[], from: number, to: number): Promise<AbsorptionMinute[]> {
    const out: AbsorptionMinute[] = [];
    if (this.#store && from < this.#memoryFrom) out.push(...await this.#store.minutes(ids, from, Math.min(to, this.#memoryFrom)));
    for (const id of ids) for (const [t, m] of this.#memoryMinutes.get(id) ?? []) if (t >= Math.max(from, this.#memoryFrom) && t < to) out.push(m);
    return out.sort((a, b) => a.t - b.t);
  }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One group as it comes over the wire or out of storage, checked field by field: the group, or null when it is anything else. */
export function parseGroup(value: unknown): AbsorptionGroup | null {
  const g = value as Partial<AbsorptionGroup> | null;
  if (!g || typeof g.id !== 'string' || !g.id || (g.side !== 'buy' && g.side !== 'sell') || !finite(g.price) || !(g.price > 0) || !finite(g.t0) || !Array.isArray(g.steps) || !g.steps.length) return null;
  let last = Infinity;
  for (const s of g.steps as unknown[]) {
    if (!Array.isArray(s) || s.length !== 5 || !s.every(finite)) return null;
    const [credit, usd, fills, t0, t1] = s as number[];
    if (!(credit! > 0) || credit! > last || !(usd! > 0) || !Number.isInteger(fills) || fills! < 1 || t1! < t0!) return null;
    last = credit!;
  }
  return { id: g.id, side: g.side, price: g.price, t0: g.t0, steps: (g.steps as number[][]).map(s => [s[0]!, s[1]!, s[2]!, s[3]!, s[4]!] as AbsorptionStep) };
}

/** One minute, checked field by field: the minute, or null. */
export function parseMinute(value: unknown): AbsorptionMinute | null {
  const m = value as Partial<AbsorptionMinute> | null;
  if (!m || typeof m.id !== 'string' || !m.id || !finite(m.t) || !finite(m.n) || !Number.isInteger(m.n) || m.n < 0 || !finite(m.mean) || !finite(m.m2) || m.m2 < 0 || !finite(m.floor) || m.floor < 0) return null;
  return { id: m.id, t: m.t, n: m.n, mean: m.mean, m2: m.m2, floor: m.floor };
}

/** A history answer checked against the instruments asked for: groups and minutes of other instruments, or broken ones, are refused whole. */
export function parseAbsorptionAnswer(value: unknown, ids: readonly string[]): AbsorptionAnswer | null {
  const body = value as { groups?: unknown; floors?: unknown; minutes?: unknown } | null;
  if (!body || !Array.isArray(body.groups) || !Array.isArray(body.minutes) || !body.floors || typeof body.floors !== 'object') return null;
  const asked = new Set(ids), groups: AbsorptionGroup[] = [], minutes: AbsorptionMinute[] = [], floors: Record<string, number> = {};
  const listed = (body as { capped?: unknown }).capped;
  const capped = Array.isArray(listed) ? listed.filter((id): id is string => typeof id === 'string' && asked.has(id)) : [];
  for (const item of body.groups as unknown[]) { const g = parseGroup(item); if (!g || !asked.has(g.id)) return null; groups.push(g); }
  for (const item of body.minutes as unknown[]) { const m = parseMinute(item); if (!m || !asked.has(m.id)) return null; minutes.push(m); }
  for (const [id, floor] of Object.entries(body.floors as Record<string, unknown>)) { if (!asked.has(id) || !finite(floor) || floor < 0) return null; floors[id] = floor; }
  return { groups, floors, minutes, capped };
}

/** What the live stream says (groups found, minutes settled), each item checked; broken items are dropped, never drawn. */
export function parseAbsorptionLive(value: unknown): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] } {
  const body = value as { groups?: unknown; minutes?: unknown } | null;
  const groups = Array.isArray(body?.groups) ? (body.groups as unknown[]).flatMap(item => parseGroup(item) ?? []) : [];
  const minutes = Array.isArray(body?.minutes) ? (body.minutes as unknown[]).flatMap(item => parseMinute(item) ?? []) : [];
  return { groups, minutes };
}
