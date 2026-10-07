// Builds the coin list the page offers (src/shared/coins.ts) from the eleven markets' public lists.
//
//   npm run coins -- --out src/app/public/coins.json
//   node build/tools/scripts/coins.mjs --previous https://liquiditymapperfast.github.io/coins.json --fallback src/app/public/coins.json --out dist/coins.json
//
// --previous is the list in use (a file or an address): a market whose list cannot be read today keeps its listings from it. When it cannot
// be read either, --fallback stands in (the list that ships with the code). With neither, a market that fails is simply left out.
import fs from 'node:fs';
import path from 'node:path';
import { buildCatalogue, fetchLists, parseCatalogue, type Catalogue } from '../src/shared/coins.ts';

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function readCatalogue(source: string | undefined): Promise<Catalogue | null> {
  if (!source) return null;
  try {
    const json: unknown = /^https?:/.test(source)
      ? await (await fetch(source, { signal: AbortSignal.timeout(20_000), headers: { 'cache-control': 'no-cache' } })).json()
      : JSON.parse(fs.readFileSync(source, 'utf8'));
    return parseCatalogue(json);
  } catch (error) { console.warn(`could not read ${source}: ${error instanceof Error ? error.message : String(error)}`); return null; }
}

const get = async (url: string, init?: { method: string; headers: Record<string, string>; body: string }): Promise<unknown> => {
  const response = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), 'user-agent': 'liquidity-mapper-fast coin list' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};

const out = arg('out');
if (!out) { console.error('usage: coins --out <file> [--previous <file or URL>] [--fallback <file>]'); process.exit(2); }
const previous = await readCatalogue(arg('previous')) ?? await readCatalogue(arg('fallback'));
const now = Date.now();
const lists = await fetchLists(get, now);
for (const [venue, rows] of Object.entries(lists)) console.log(`${venue.padEnd(12)} ${rows ? `${rows.length} listings` : 'FAILED'}`);
const { catalogue, notes } = buildCatalogue(lists, previous, now);
for (const note of notes) console.log(`note: ${note}`);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify(catalogue) + '\n');
console.log(`${catalogue.coins.length} coins written to ${out}${catalogue.builtAt !== now ? ' (the previous list, unchanged)' : ''}`);
