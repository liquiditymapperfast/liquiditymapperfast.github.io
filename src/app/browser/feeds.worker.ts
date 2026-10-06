import { BROWSER_RETENTION_MS, Engine } from '../../shared/engine.ts';
import { BROWSER_VENUES } from '../../shared/venues.ts';
import type { ValuedBook } from '../../shared/levels.ts';
import type { Print } from '../../shared/prints.ts';
import { openRecordings, type Recordings } from './idb.ts';
import type { FeedsIn, FeedsOut, RpcCall } from './protocol.ts';
import type { LevelsFrame, SideArrays } from '../wire.ts';

/**
 * The data engine on its own thread: exchange sockets, book valuation, recording and the history requests all run here, and the page
 * receives the same frames and answers a server would send. Nothing in this file talks to a server of ours.
 */

const scope = self as unknown as { postMessage(message: FeedsOut, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<FeedsIn>) => void) | null };
const post = (message: FeedsOut, transfer: Transferable[] = []): void => scope.postMessage(message, transfer);

/** Structured clone keeps a typed array's whole buffer, so a view onto a larger one is copied out first. */
const compact = (array: Float64Array): Float64Array => array.byteLength === array.buffer.byteLength ? array : array.slice();
function side(levels: ValuedBook['bids']): SideArrays {
  const lo = compact(levels.lo);
  // Point levels share one array for both edges; keep it shared so it is sent once.
  return { lo, hi: levels.hi === levels.lo ? lo : compact(levels.hi), usd: compact(levels.usd) };
}
function frameOf(books: readonly ValuedBook[], asOf: number): LevelsFrame {
  return { asOf, books: books.map(b => ({ id: b.instrumentId, venue: b.venue, timestamp: b.timestamp, coarse: b.coarse, bids: side(b.bids), asks: side(b.asks) })) };
}

const withTimeout = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms))]);

let engine: Engine | null = null;
let recordings: Recordings | null = null;
/** Whether this tab holds the role of writing recordings. */
let recording = false;

/** Only one tab records: the lock is held for as long as this worker lives, and the next waiting tab takes over when it ends. */
function claimRecorder(): void {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  const grant = (): void => { recording = true; post({ type: 'recording', recording: true }); };
  if (!locks) { grant(); return; }
  void locks.request('lmf-recorder', () => { grant(); return new Promise<never>(() => {}); }).catch(() => grant());
}

async function init(selected: string[] | null, persist: boolean): Promise<void> {
  if (persist && typeof indexedDB !== 'undefined') {
    try { recordings = await withTimeout(openRecordings(Date.now() - BROWSER_RETENTION_MS, () => recording, error => console.warn('recordings are no longer being saved:', error)), 5_000, 'opening the recordings'); }
    catch (error) { console.warn('recordings are not kept this session:', error); }
    // Ask the browser not to evict the recordings when disk is short (it may decline, and some browsers ask the person).
    void navigator.storage?.persist?.().catch(() => false);
    claimRecorder();
  }
  const next = new Engine({ columns: recordings?.columns ?? null, footprint: recordings?.footprint ?? null, prints: recordings?.prints ?? null, flow: recordings?.flow ?? null });
  next.onLevels = (books, asOf) => post({ type: 'levels', frame: frameOf(books, asOf) });
  next.onTick = tick => post({ type: 'tick', tick });
  next.onPrints = (items: Print[]) => post({ type: 'prints', items });
  next.onFlow = items => post({ type: 'flow', items });
  next.onStatus = venues => post({ type: 'status', venues });
  next.select(selected ?? BROWSER_VENUES.filter(v => v.recommended).map(v => v.id));
  next.start();
  engine = next;
  post({ type: 'ready', persisted: recordings !== null });
}

async function answer(call: RpcCall, run: Engine): Promise<{ result: unknown; transfer: Transferable[] }> {
  switch (call.method) {
    case 'bootstrap': return { result: run.bootstrap(), transfer: [] };
    case 'columns': {
      const frame = run.columns(call.ids, call.from, call.to, call.stepMs);
      return { result: frame, transfer: frame.instruments.flatMap(set => [set.bins.buffer, set.bid.buffer, set.ask.buffer]) };
    }
    case 'footprint': return { result: run.footprint(call.inst, call.tfMs, call.from, call.to, call.rowStep), transfer: [] };
    case 'prints': return { result: run.prints(call.from, call.to), transfer: [] };
    case 'flow': {
      const frame = run.flow(call.ids, call.from, call.to);
      return { result: frame, transfer: frame.instruments.flatMap(series => [series.buy.buffer as ArrayBuffer, series.sell.buffer as ArrayBuffer]) };
    }
    case 'candles': return { result: await run.candles(call.inst, call.tfMs, call.from, call.to), transfer: [] };
    case 'oi': return { result: await run.oi(call.inst, call.tfMs, call.from, call.to), transfer: [] };
  }
}

scope.onmessage = event => {
  const message = event.data;
  if (message.type === 'init') { void init(message.selected, message.persist); return; }
  if (!engine) { if (message.type === 'rpc') post({ type: 'rpc', id: message.id, error: 'the engine has not started' }); return; }
  if (message.type === 'select') engine.select(message.selected);
  else if (message.type === 'flush') { engine.flush(); void recordings?.flush(); }
  else {
    const { id, type: _type, ...call } = message;
    answer(call as RpcCall, engine).then(
      ({ result, transfer }) => post({ type: 'rpc', id, result }, transfer),
      error => post({ type: 'rpc', id, error: error instanceof Error ? error.message : String(error) }),
    );
  }
};
