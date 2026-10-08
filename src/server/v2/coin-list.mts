import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { buildCatalogue, fetchLists, parseCatalogue, type Catalogue, type ListFetcher } from '../../shared/coins.ts';

const DAY_MS = 86_400_000, RETRY_MS = 3_600_000;
/** The first build waits this long after a start, so it does not add to the feeds coming up. */
const FIRST_MS = 60_000;

const defaultGet: ListFetcher = async (url, init) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

function read(file: string): Catalogue | null {
  try { return parseCatalogue(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

/**
 * The coin list the page offers (shared/coins.ts), built by this server once a day from the markets' own lists and kept in the data folder,
 * so a server left running for weeks does not go on offering the list it was built with. Until its first build, and whenever one fails,
 * the last one it built stands, and before any, the copy that came with the page (dist/coins.json, served as a plain file).
 */
export class CoinList {
  #text: string | null = null;
  #builtAt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #building = false;

  constructor(private readonly file: string, private readonly shipped: string, private readonly get: ListFetcher = defaultGet, private readonly now: () => number = Date.now) {
    const saved = read(file);
    if (saved) { this.#text = JSON.stringify(saved); this.#builtAt = saved.builtAt; }
  }

  /** Build when the saved list is a day old (a minute after start at the soonest), then every day, and an hour after a build that failed. */
  start(due = Math.max(FIRST_MS, this.#builtAt + DAY_MS - this.now())): void {
    this.#timer = setTimeout(() => { void this.refresh().then(built => { if (this.#timer) this.start(built ? DAY_MS : RETRY_MS); }); }, due);
    this.#timer.unref?.();
  }

  /**
   * Read the markets' lists and build the day's list on the last one (a list that could not be read keeps its listings from it). True when a
   * new list was built; when too little could be read, the list served stays as it was.
   */
  async refresh(): Promise<boolean> {
    if (this.#building) return false;
    this.#building = true;
    try {
      const now = this.now(), previous = read(this.file) ?? read(this.shipped);
      const { catalogue, notes, fresh } = buildCatalogue(await fetchLists(this.get, now), previous, now);
      for (const note of notes) console.warn(`coin list: ${note}`);
      if (!fresh) return false;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const text = JSON.stringify(catalogue), temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, text); fs.renameSync(temp, this.file);
      this.#text = text; this.#builtAt = now;
      return true;
    } catch (error) { console.warn('coin list: not rebuilt:', error instanceof Error ? error.message : String(error)); return false; }
    finally { this.#building = false; }
  }

  /** Answer GET /coins.json with the list this server built; false when it has none yet (the page's own copy is served instead). */
  send(res: ServerResponse): boolean {
    if (!this.#text) return false;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(this.#text);
    return true;
  }

  close(): void { if (this.#timer) clearTimeout(this.#timer); this.#timer = null; }
}
