/**
 * Payments made in this browser whose Plus is not set up yet (the Plus page, `page.ts`): one record per Paddle transaction, written once when
 * its checkout completes and never stamped again, so that a reload asks again and the prices stay away meanwhile (nobody pays twice because
 * the first setting-up failed). Each record keeps the membership's generation when its checkout completed (`Plus.generation`) and whether an
 * answer for it was dropped because the membership changed (`stale`): the page asks again by itself only while neither is so, and otherwise
 * waits for its Try again (Sol, review 2026-11-19). A record is given up a day after its checkout (the receipt's email and invoice number
 * still bring Plus back), and a settlement removes the records it names, never one written after it began. No page here: the tests drive
 * two tabs over one storage.
 */

/** Where the records are kept, in the storage the app shares (the handover leaves it out: `handover.ts`). */
export const PAID_STORE = 'lmf.plus.paid';
/** A record is given up this long after its checkout completed. */
export const PAID_KEEP_MS = 86_400_000;
/** At most this many records are kept (one browser paying more often than this in a day is not a case to keep). */
const PAID_MAX = 8;

/** A payment waiting here: Paddle's transaction, when its checkout completed, the membership's generation then, and whether an answer for it was dropped. */
export interface Paid { id: string; at: number; generation: number; stale: boolean }

type Kept = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const TXN = /^txn_[a-z0-9]{8,64}$/;

/** `localStorage`, or nothing where the browser refuses it: the records then last as long as the tab. */
function kept(): Kept | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** The records in what is kept, the valid ones only. One written before records had a generation (`{ id, at }`) waits for its Try again. */
function readPaid(raw: string | null): Paid[] {
  if (!raw) return [];
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return []; }
  const one = (p: unknown): Paid | null => {
    if (!p || typeof p !== 'object') return null;
    const r = p as { id?: unknown; at?: unknown; generation?: unknown; stale?: unknown };
    if (typeof r.id !== 'string' || !TXN.test(r.id) || typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
    const generation = typeof r.generation === 'number' && Number.isSafeInteger(r.generation) && r.generation >= 0 ? r.generation : -1;
    return { id: r.id, at: r.at, generation, stale: generation < 0 || r.stale === true };
  };
  const list = o && typeof o === 'object' && Array.isArray((o as { paid?: unknown }).paid) ? (o as { paid: unknown[] }).paid : [o];
  const out: Paid[] = [];
  for (const p of list) { const r = one(p); if (r && !out.some(q => q.id === r.id)) out.push(r); }
  return out;
}

export class PaidStore {
  /** The records where the browser keeps nothing (this tab's own). */
  #mem: Paid[] = [];
  constructor(private storage: Kept | null = kept(), private now: () => number = Date.now) {}

  #read(): Paid[] {
    if (!this.storage) return this.#mem;
    try { return readPaid(this.storage.getItem(PAID_STORE)); } catch { return this.#mem; }
  }
  #write(list: Paid[]): void {
    this.#mem = list;
    try {
      if (!this.storage) return;
      if (list.length) this.storage.setItem(PAID_STORE, JSON.stringify({ v: 2, paid: list }));
      else this.storage.removeItem(PAID_STORE);
    } catch { /* kept for this tab only */ }
  }

  /** Every payment still waiting, oldest first. One a day old, or dated over an hour ahead (a clock since set back), is given up as it is read. */
  list(): Paid[] {
    const all = this.#read(), now = this.now();
    const live = all.filter(p => now - p.at <= PAID_KEEP_MS && p.at <= now + 3_600_000);
    if (live.length !== all.length) this.#write(live);
    return live;
  }
  /** The payment `id` while it waits, or null (set up, settled, or given up). */
  get(id: string): Paid | null { return this.list().find(p => p.id === id) ?? null; }
  /** The payments waiting now: what an action that may settle them names when it starts (`settle`). */
  ids(): string[] { return this.list().map(p => p.id); }
  /** The checkout `id` completed under the membership's `generation`: its record, written now unless it is kept already (then as it was). */
  begin(id: string, generation: number): Paid {
    const list = this.list(), known = list.find(p => p.id === id);
    if (known) return known;
    const made: Paid = { id, at: this.now(), generation, stale: false };
    this.#write([...list, made].slice(-PAID_MAX));
    return made;
  }
  /** An answer for `id` was dropped because the membership changed: from now on only its Try again asks for it. */
  markStale(id: string): void {
    const list = this.list();
    if (list.some(p => p.id === id && !p.stale)) this.#write(list.map(p => p.id === id ? { ...p, stale: true } : p));
  }
  /** These payments are settled (set up here, or the visitor took another membership): removed, and only these. */
  settle(ids: readonly string[]): void {
    if (!ids.length) return;
    const list = this.list(), left = list.filter(p => !ids.includes(p.id));
    if (left.length !== list.length) this.#write(left);
  }
}
