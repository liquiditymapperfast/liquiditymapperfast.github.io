/**
 * Payments made in this browser whose Plus is not set up yet (the Plus page; the checkout recovery, page build spec section 3, 2026-11-20).
 * One record per Paddle transaction in the Plus database (`paid:<txn>` = `{ at }`), beside the seed, so a reset of the database clears
 * both together and a record's transaction is always asked for with the current seed. Written once, when its checkout completes, and never
 * dated again; it waits from a day before that time to a day after it, on this device's clock (best effort), and keeps the prices away
 * meanwhile, so nobody pays twice because the first setting-up failed. Removed by its own grant's commit, by any key or receipt membership
 * committed in this browser (the records that existed when that action began, inside the commit's transaction: `pass.ts`), and when read
 * outside its window. A record the browser refuses to store stays in this tab's memory, bound to the seed read when its checkout opened, and
 * is discarded once the seed differs (it never crosses a reset). Plain mode has no records: it opens no checkout. The page keeps the list in
 * memory, read again after each change, on focus and when another tab says so (`BroadcastChannel('lmf.plus')`), so it draws synchronously.
 */
import { PAID_PREFIX, SEED_KEY, paidAt, paidWaits, type MemoryRecord, type PlusDb } from './plus-db.ts';
import type { PlusChannel } from './pass.ts';

/** A payment waiting here: Paddle's transaction, when its checkout completed, and whether only this tab holds it (its write refused). */
export interface Paid { id: string; at: number; memory: boolean }
const TXN = /^txn_[a-z0-9]{8,64}$/;

export class PaidStore {
  #list: Paid[] = [];
  #memory = new Map<string, MemoryRecord>();
  #ready = false;
  #listeners = new Set<() => void>();
  constructor(private readonly db: PlusDb | null, private readonly now: () => number = Date.now, private readonly channel: PlusChannel | null = null) {}

  /** Every payment still waiting, oldest first, as last read (one outside its window by the clock now is left out). */
  list(): Paid[] { const now = this.now(); return this.#list.filter(p => paidWaits(p.at, now)); }
  /** The payment `id` while it waits, or null. */
  get(id: string): Paid | null { return this.list().find(p => p.id === id) ?? null; }
  /**
   * Whether the payments were read at least once: until then the page offers no prices (a slow first open must not hide a payment still
   * waiting; Sol, code review C2-1).
   */
  get ready(): boolean { return this.#ready; }
  /** The payments only this tab holds (their writes refused): what a key or a receipt taken now settles besides the stored ones. */
  localIds(): string[] { return [...this.#memory.keys()]; }
  /** This tab's own record of `id` (its write was refused), for the gate to check against the seed. */
  memory(id: string): MemoryRecord | null { return this.#memory.get(id) ?? null; }
  /** Told whenever the list changes. */
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  /** The list now; the listeners are told when it changed, or when `told` (the payments became read: an empty list counts; Sol, C3-4). */
  #set(list: Paid[], told = false): void {
    const same = list.length === this.#list.length && list.every((p, i) => p.id === this.#list[i]!.id && p.at === this.#list[i]!.at && p.memory === this.#list[i]!.memory);
    this.#list = list;
    if (!same || told) for (const listener of [...this.#listeners]) listener();
  }

  /**
   * The records read again (each one outside its window removed as it is read), with this tab's memory records of the seed stored now (one of
   * another seed is discarded). A database that cannot be read leaves the list as it was. Whether it was read.
   */
  async refresh(): Promise<boolean> {
    if (!this.db) { const became = !this.#ready; this.#ready = true; this.#set([], became); return true; }
    let read: { stored: Paid[]; seed: unknown };
    try {
      read = await this.db.tx('readwrite', async kv => {
        const now = this.now(), stored: Paid[] = [];
        for (const key of await kv.keys()) {
          if (!key.startsWith(PAID_PREFIX)) continue;
          const id = key.slice(PAID_PREFIX.length), at = paidAt(await kv.get(key));
          if (at === null || !TXN.test(id) || !paidWaits(at, now)) { await kv.delete(key); continue; }
          stored.push({ id, at, memory: false });
        }
        return { stored, seed: await kv.get(SEED_KEY) };
      });
    } catch { return false; }
    const now = this.now(), mine: Paid[] = [];
    for (const [id, record] of this.#memory) {
      if (record.epoch !== read.seed || !paidWaits(record.at, now) || read.stored.some(p => p.id === id)) { this.#memory.delete(id); continue; }
      mine.push({ id, at: record.at, memory: true });
    }
    const became = !this.#ready;
    this.#ready = true;
    this.#set([...read.stored, ...mine].sort((a, b) => a.at - b.at), became);
    return true;
  }
  /**
   * The checkout `id` completed (`epoch`: the seed read just before it opened): its record written now unless one is kept (never dated
   * again). A write the browser refuses keeps it in this tab, bound to `epoch`: this tab's attempt and its button still work.
   */
  async begin(id: string, epoch: string): Promise<void> {
    if (!TXN.test(id)) return;
    const at = this.now();
    let stored = false;
    if (this.db) {
      try {
        await this.db.tx('readwrite', async kv => { const key = `${PAID_PREFIX}${id}`; if (paidAt(await kv.get(key)) === null) await kv.put(key, { at }); });
        stored = true;
      } catch { stored = false; }
    }
    if (!stored && !this.#memory.has(id)) this.#memory.set(id, { at, epoch });
    // The record shows before the attempt's first answer: added now, read again after.
    if (!this.#list.some(p => p.id === id)) this.#set([...this.#list, { id, at, memory: !stored }]);
    if (stored) { try { this.channel?.postMessage({ kind: 'paid' }); } catch { /* other tabs see it on their next focus */ } }
    void this.refresh();
  }
  /** These payments were settled (by a commit, which removed their stored records) or found gone: this tab's own records of them go too. */
  settled(ids: readonly string[]): void {
    for (const id of ids) this.#memory.delete(id);
    if (ids.length) this.#set(this.#list.filter(p => !ids.includes(p.id)));
    void this.refresh();
  }
}
