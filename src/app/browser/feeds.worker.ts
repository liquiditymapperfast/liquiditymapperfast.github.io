import { BROWSER_RETENTION_MS, Engine } from '../../shared/engine.ts';
import { browserVenues, restoreSelection } from '../../shared/venues.ts';
import { setPageShown } from '../../shared/far-book.ts';
import type { Coin } from '../../shared/coins.ts';
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
  return { asOf, books: books.map(b => ({ id: b.instrumentId, venue: b.venue, timestamp: b.timestamp, coarse: b.coarse, bids: side(b.bids), asks: side(b.asks), ...(b.touch ? { touch: b.touch } : {}) })) };
}

let engine: Engine | null = null;
let recordings: Recordings | null = null;
/** Whether this tab holds the role of writing recordings. */
let recording = false;

/** Lets go of the recorder role (set while this worker holds it). */
let giveUpRecorder: (() => void) | null = null;
/** Set when this tab's storage has stopped working: it takes no recorder role from then on, even one it was already waiting in line for. */
let storageFailed = false;

/**
 * Only one tab records: the lock is held for as long as this worker lives, and the next waiting tab takes over when it ends. A tab asks
 * for it only when it can write (see `init`), and gives it up when its storage stops working, so a tab that cannot record never keeps one
 * that can from it.
 */
function claimRecorder(lock: string): void {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  const grant = (): void => { recording = true; post({ type: 'recording', recording: true }); };
  if (!locks) { grant(); return; }
  void locks.request(lock, () => {
    if (storageFailed) return undefined;   // the lock is handed straight on
    grant(); return new Promise<void>(resolve => { giveUpRecorder = resolve; });
  }).catch(() => { if (!storageFailed) grant(); });
}
function stopRecording(): void {
  storageFailed = true;
  giveUpRecorder?.(); giveUpRecorder = null;
  recording = false;
  // Said whether or not this tab held the role: a tab waiting in line for it must not be taken for one whose turn has not come.
  post({ type: 'recording', recording: false, failed: true });
}

async function init(selected: string[] | null, known: string[] | null, persist: boolean, coin: Coin, tier: number, database: string, lock: string): Promise<void> {
  if (persist && typeof indexedDB !== 'undefined') {
    // A write that fails is tried again (the status bar says so meanwhile); only a newer page taking the database over ends the saving here.
    let failing = false;
    const events = {
      failed: (error: unknown, fatal: boolean): void => {
        if (fatal) { console.warn('recordings are no longer being saved:', error); stopRecording(); return; }
        if (!failing) { failing = true; console.warn('a recording could not be saved; trying again:', error); post({ type: 'recording', recording, failed: true }); }
      },
      recovered: (): void => { failing = false; console.info('recordings are being saved again'); post({ type: 'recording', recording }); },
    };
    try { recordings = await openRecordings(database, Date.now() - BROWSER_RETENTION_MS, () => recording, events); }
    catch (error) { console.warn('recordings are not kept this session:', error); }
    if (recordings) {
      // Ask the browser not to evict the recordings when disk is short (it may decline, and some browsers ask the person).
      void navigator.storage?.persist?.().catch(() => false);
      claimRecorder(lock);
    }
  }
  const venues = browserVenues(coin);
  const next = new Engine({ coin, tier, venues, columns: recordings?.columns ?? null, footprint: recordings?.footprint ?? null, prints: recordings?.prints ?? null, flow: recordings?.flow ?? null, absorption: recordings?.absorption ?? null, coverage: recordings?.coverage ?? null, liquidations: recordings?.liquidations ?? null, oi: recordings?.oi ?? null });
  next.onLevels = (books, asOf) => post({ type: 'levels', frame: frameOf(books, asOf) });
  next.onTick = tick => post({ type: 'tick', tick });
  next.onPrints = (items: Print[]) => post({ type: 'prints', items });
  next.onLiquidations = items => post({ type: 'liquidations', items });
  next.onFlow = items => post({ type: 'flow', items });
  next.onOiLive = (instrumentId, reading) => post({ type: 'oi', instrumentId, t: reading.t, base: reading.base, ...(reading.quote !== undefined ? { quote: reading.quote } : {}) });
  next.onTape = batch => post({ type: 'tape', batch }, [batch.inst.buffer, batch.t.buffer, batch.price.buffer, batch.usd.buffer, batch.lo.buffer, batch.hi.buffer]);
  next.onAbsorption = found => post({ type: 'absorption', groups: found.groups, minutes: found.minutes });
  next.onStatus = venues => post({ type: 'status', venues });
  next.onRecovered = (id, from, to) => post({ type: 'recovered', id, from, to });
  next.select(restoreSelection(selected, known, venues) ?? venues.filter(v => v.recommended).map(v => v.id));
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
    case 'footprint': return { result: run.footprint(call.inst, call.tfMs, call.from, call.to, call.rowStep, call.cuts ?? [], call.budget, call.venues === true), transfer: [] };
    case 'prints': return { result: run.prints(call.from, call.to, call.minUsd), transfer: [] };
    case 'liquidations': return { result: run.liquidations(call.from, call.to, call.minUsd), transfer: [] };
    case 'printSums': return { result: run.printSums(call.ids, call.from, call.to, call.minUsd, call.stepMs), transfer: [] };
    case 'flow': {
      const frame = run.flow(call.ids, call.from, call.to);
      return { result: frame, transfer: frame.instruments.flatMap(series => [series.buy.buffer as ArrayBuffer, series.sell.buffer as ArrayBuffer]) };
    }
    case 'sizes': return { result: run.sizes(call.ids, call.windows, call.cuts ?? []), transfer: [] };
    case 'profile': return { result: run.profile(call.ids, call.from, call.to, call.rowStep), transfer: [] };
    case 'oiProfile': return { result: await run.oiProfile(call.ids, call.from, call.to, call.rowStep), transfer: [] };
    case 'range': return { result: run.range(call.ids, call.from, call.to, call.band, call.rowStep), transfer: [] };
    case 'valueAreas': return { result: run.valueAreas(call.ids, call.windows, call.rowStep, call.share), transfer: [] };
    case 'absorption': return { result: await run.absorptionHistory(call.ids, call.mins, call.from, call.to, call.limit, call.since), transfer: [] };
    case 'absorptionProfile': return { result: await run.absorptionProfile(call.ids, call.thresholds, call.from, call.to, call.step), transfer: [] };
    case 'candles': return { result: await run.candles(call.inst, call.tfMs, call.from, call.to), transfer: [] };
    case 'oi': return { result: await run.oi(call.inst, call.tfMs, call.from, call.to, call.usd === true), transfer: [] };
    case 'coverage': return { result: run.coverage(call.ids, call.metric, call.from, call.to), transfer: [] };
    case 'recover': return { result: await run.recover({ ids: call.ids, windows: call.windows }), transfer: [] };
  }
}

scope.onmessage = event => {
  const message = event.data;
  if (message.type === 'visible') { setPageShown(message.shown); return; }
  if (message.type === 'init') { init(message.selected, message.known, message.persist, message.coin, message.tier, message.database, message.lock).catch(error => post({ type: 'failed', error: error instanceof Error ? error.message : String(error) })); return; }
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
