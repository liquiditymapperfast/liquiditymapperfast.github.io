/**
 * Parity check between the browser connectors and the server's feeds, on the same live window:
 *
 *   npm run parity -- [seconds] [port]
 *
 * It starts the browser venues (src/shared/venues.ts) in this process, attaches to a running server's /api/v2/ws, and every two seconds
 * compares each venue's book: best bid and ask, and the USD resting within 0.1 % of the mid on each side (inside the reach of Binance's 1000-level
 * perpetual snapshot, about 0.16 % at BTC's tick: farther out a freshly started engine legitimately holds less than a server that has run for hours). Large trades (25k USD and more)
 * recorded by both are matched by instrument, time, price and size, and their sides must agree. Read-only on both ends.
 */
import { decodeLevels, type LiveBook, type SideArrays } from '../src/app/wire.ts';
import { BROWSER_VENUES } from '../src/shared/venues.ts';
import type { BookConnector, TradeEvent } from '../src/shared/connector.ts';
import { PRINT_FLOOR_USD } from '../src/shared/prints.ts';

const seconds = Number(process.argv[2] ?? 120), port = Number(process.argv[3] ?? 8787);
const WINDOW = 0.001;

const touch = (b: { bids: SideArrays; asks: SideArrays }) => ({ bid: b.bids.hi.reduce((m, v) => Math.max(m, v), -Infinity), ask: b.asks.lo.reduce((m, v) => Math.min(m, v), Infinity) });
function usdWithin(side: SideArrays, mid: number, isBid: boolean): number {
  let sum = 0;
  for (let i = 0; i < side.usd.length; i++) if (isBid ? side.lo[i]! >= mid * (1 - WINDOW) : side.hi[i]! <= mid * (1 + WINDOW)) sum += side.usd[i]!;
  return sum;
}
const median = (values: number[]): number => { const s = [...values].sort((a, b) => a - b); return s.length ? s[s.length >> 1]! : NaN; };

const serverBooks = new Map<string, { book: LiveBook; at: number }>();
const serverPrints = new Map<string, string>();
const keyOf = (id: string, t: number, price: number, usd: number) => `${id}|${t}|${price}|${Math.round(usd)}`;

const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
socket.binaryType = 'arraybuffer';
socket.onmessage = event => {
  if (typeof event.data === 'string') {
    const m = JSON.parse(event.data) as { t?: string; items?: [number, string, 'buy' | 'sell', number, number][] };
    if (m.t === 'prints') for (const [t, id, side, price, usd] of m.items ?? []) serverPrints.set(keyOf(id, t, price, usd), side);
    return;
  }
  const frame = decodeLevels(event.data as ArrayBuffer), now = Date.now();
  for (const book of frame.books) serverBooks.set(book.id, { book, at: now });
};
await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error(`cannot reach ws://127.0.0.1:${port}/api/v2/ws`)); });

const books: BookConnector[] = [], connectors: BookConnector[] = [];
const browserPrints = new Map<string, string>();
const onTrade = (t: TradeEvent) => { if (t.notionalUsd >= PRINT_FLOOR_USD) browserPrints.set(keyOf(t.instrumentId, t.t, t.price, t.notionalUsd), t.side); };
for (const venue of BROWSER_VENUES) {
  const { book, feeds } = venue.make();
  books.push(book);
  for (const c of [book, ...feeds]) { c.onTrade = onTrade; c.start(); connectors.push(c); }
}

interface Tally { samples: number; bid: number[]; ask: number[]; usdBid: number[]; usdAsk: number[]; missing: number }
const tallies = new Map<string, Tally>();
const started = Date.now();
console.error(`comparing ${BROWSER_VENUES.length} venues for ${seconds} s against port ${port}…`);
await new Promise<void>(resolve => {
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - started > 15_000) for (const connector of books) {
      const mine = connector.valued(now), theirs = serverBooks.get(connector.instrumentId);
      const tally = tallies.get(connector.instrumentId) ?? { samples: 0, bid: [], ask: [], usdBid: [], usdAsk: [], missing: 0 };
      tallies.set(connector.instrumentId, tally);
      if (!mine || !theirs || now - theirs.at > 600) { if (connector.status().everLive || theirs) tally.missing++; continue; }
      const a = touch(mine), b = touch(theirs.book), mid = (b.bid + b.ask) / 2;
      tally.samples++;
      tally.bid.push(Math.abs(a.bid - b.bid) / mid * 1e4); tally.ask.push(Math.abs(a.ask - b.ask) / mid * 1e4);
      const [mb, tb, ma, ta] = [usdWithin(mine.bids, mid, true), usdWithin(theirs.book.bids, mid, true), usdWithin(mine.asks, mid, false), usdWithin(theirs.book.asks, mid, false)];
      if (tb > 0) tally.usdBid.push(mb / tb); if (ta > 0) tally.usdAsk.push(ma / ta);
    }
    if (now - started > seconds * 1000) { clearInterval(timer); resolve(); }
  }, 2_000);
});

for (const connector of connectors) connector.stop();
socket.close();

const pct = (v: number) => Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '–';
console.log('\n| Venue | Samples | Missing | Best bid off (bp, median) | Best ask off (bp, median) | USD ±0.1 % bids, browser/server | asks |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
let failed = false;
for (const [id, t] of [...tallies].sort((x, y) => x[0].localeCompare(y[0]))) {
  const bidOff = median(t.bid), askOff = median(t.ask), ub = median(t.usdBid), ua = median(t.usdAsk);
  console.log(`| ${id} | ${t.samples} | ${t.missing} | ${bidOff.toFixed(2)} | ${askOff.toFixed(2)} | ${pct(ub)} | ${pct(ua)} |`);
  if (!t.samples || bidOff > 1 || askOff > 1 || Math.abs(ub - 1) > 0.1 || Math.abs(ua - 1) > 0.1) failed = true;
}
// Large trades: only venues whose trades the server records are comparable.
const comparable = new Set([...serverPrints.keys()].map(k => k.split('|')[0]!));
let matched = 0, wrongSide = 0, serverOnly = 0, browserOnly = 0;
const earliest = started + 10_000;
for (const [key, side] of serverPrints) { const mine = browserPrints.get(key); if (mine === undefined) serverOnly++; else if (mine !== side) wrongSide++; else matched++; }
for (const key of browserPrints.keys()) if (comparable.has(key.split('|')[0]!) && !serverPrints.has(key)) browserOnly++;
console.log(`\nLarge trades on venues both record (${[...comparable].join(', ') || 'none seen'}): ${matched} matched, ${wrongSide} with a different side, ${serverOnly} only on the server, ${browserOnly} only in the browser engine (started ${new Date(earliest).toISOString().slice(11, 19)}).`);
console.log(`Browser-only venues' trades: ${[...new Set([...browserPrints.keys()].map(k => k.split('|')[0]!))].filter(id => !comparable.has(id)).join(', ') || 'none'}.`);
if (wrongSide > 0) failed = true;
process.exit(failed ? 1 : 0);
