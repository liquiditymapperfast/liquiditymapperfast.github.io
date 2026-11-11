import { BROWSER_RETENTION_MS, Engine } from '../../shared/engine.ts';
import { browserVenues, restoreSelection } from '../../shared/venues.ts';
import { setPageShown } from '../../shared/far-book.ts';
import type { Coin } from '../../shared/coins.ts';
import type { Print } from '../../shared/prints.ts';
import { openRecordings, type Recordings, type StoredColumn } from './idb.ts';
import type { FeedsIn, FeedsOut, RpcCall } from './protocol.ts';
import { PREVIEW_MS, waitOf } from './waits.ts';
import { frameOf } from './levels-frame.ts';
import { heldOf, importHistory, readLatest } from './history-import.ts';
import { importSince } from '../history-window.ts';
import type { TilesInfo } from '../archive/tiles.ts';
import { CONTIGUOUS_GAP_MS } from '../../shared/columns.ts';
import { useMergeKernel } from '../../shared/merge.ts';
import { loadKernels } from '../kernels.ts';

/**
 * The data engine on its own thread: exchange sockets, book valuation, recording and the history requests all run here, and the page
 * receives the same frames and answers a server would send. Nothing in this file talks to a server of ours.
 */

// The books' distance merge runs in WebAssembly once the kernels have loaded (until then, and if they never do, in JavaScript: the same
// result either way, shared/merge.ts).
void loadKernels().then(k => useMergeKernel(k.mergeByDistance), () => { /* the JavaScript merge stays */ });

const scope = self as unknown as { postMessage(message: FeedsOut, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<FeedsIn>) => void) | null };
const post = (message: FeedsOut, transfer: Transferable[] = []): void => scope.postMessage(message, transfer);

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

/**
 * Settled once the engine has its recordings and the recorded history (or will have none): the questions about what was recorded wait for
 * it (`HISTORY_WAITS` in browser/waits.ts), so they are answered with the day, not with the seconds since the page opened.
 */
let historyIn!: () => void, historyDone = false;
const historyLanded = new Promise<void>(resolve => { historyIn = resolve; });
/**
 * Settled once the engine holds the newest minutes of the recordings (`Engine.preview`), never when there are none: the map's own load waits
 * for this or the history, whichever comes first (a day takes seconds to read back; the hours the map opens on, a fifth of one).
 */
let previewIn!: () => void;
const previewLanded = new Promise<void>(resolve => { previewIn = resolve; });
/** Whether columns were answered from the newest minutes alone: the history's message says so, and the page asks for them again. */
let columnsEarly = false;

/**
 * The engine starts at once, on the venues' sockets alone, so the book, the price, the trades and the flow move within a second of the
 * page opening; the recordings and the recorded history are read meanwhile and handed to it when they are in (`Engine.attach`).
 */
async function init(selected: string[] | null, known: string[] | null, persist: boolean, coin: Coin, tier: number, database: string, lock: string, history: string, historyHours: number): Promise<void> {
  const keeps = persist && typeof indexedDB !== 'undefined';
  const venues = browserVenues(coin);
  const next = new Engine({ coin, tier, venues, deferred: keeps });
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
  post({ type: 'ready' });
  if (!keeps) { post({ type: 'recordings', persisted: false }); historyDone = true; historyIn(); return; }
  const gridSteps = new Map<string, number>(), tiles: { info: TilesInfo | null; hourBooks: boolean } = { info: null, hourBooks: true };
  // The engine runs whatever becomes of them: a failure here is not the engine's.
  // The newest minutes come first: the map is drawn from them while the rest is read.
  const newest = (columns: StoredColumn[]): void => { if (next.preview({ load: () => columns })) previewIn(); };
  try { await readRecordings(database, lock, history, historyHours, gridSteps, tiles, newest); }
  catch (error) { console.warn('the recordings could not be read:', error); }
  try { next.attach(recordings, gridSteps); }
  catch (error) { console.error('the recordings could not be handed to the engine:', error); }
  // A pass of the live feeds first: the hand-over and the questions held for it each take a moment of this thread.
  setTimeout(() => { historyDone = true; historyIn(); post({ type: 'history', tiles: tiles.info, hourBooks: tiles.hourBooks, ...(columnsEarly ? { columnsEarly: true } : {}) }); }, 0);
}

/**
 * Open the recordings and read the recorded history into them (`gridSteps`: the service's grid for books they hold nothing of; `newest`: the
 * map's newest minutes, given before the rest is read).
 */
async function readRecordings(database: string, lock: string, history: string, historyHours: number, gridSteps: Map<string, number>, tiles: { info: TilesInfo | null; hourBooks: boolean }, newest: (columns: StoredColumn[]) => void): Promise<void> {
  // A write that fails is tried again (the status bar says so meanwhile); only a newer page taking the database over ends the saving here.
  let failing = false;
  const events = {
    failed: (error: unknown, fatal: boolean): void => {
      if (fatal) { console.warn('recordings are no longer being saved:', error); stopRecording(); return; }
      if (!failing) { failing = true; console.warn('a recording could not be saved; trying again:', error); post({ type: 'recording', recording, failed: true }); }
    },
    recovered: (): void => { failing = false; console.info('recordings are being saved again'); post({ type: 'recording', recording }); },
  };
  // The service's latest.json is asked for while the recordings are read back: the import asks it first, and it is in by then.
  const latest = history && historyHours > 0 ? readLatest(history) : null;
  try { recordings = await openRecordings(database, Date.now() - BROWSER_RETENTION_MS, () => recording, events, { since: Date.now() - PREVIEW_MS, take: newest }); }
  catch (error) { console.warn('recordings are not kept this session:', error); }
  post({ type: 'recordings', persisted: recordings !== null });
  if (!recordings) return;
  // Ask the browser not to evict the recordings when disk is short (it may decline, and some browsers ask the person).
  void navigator.storage?.persist?.().catch(() => false);
  claimRecorder(lock);
  // The recorded history (app/history-url.ts): the minutes of the day before this visit, read into the recordings before the engine is given
  // them; a phone reads its last few hours only, from the start of the oldest one (app/history-window.ts). The recordings keep their day either way.
  if (history && historyHours > 0) {
    const kept = recordings, now = Date.now(), since = importSince(now, historyHours, BROWSER_RETENTION_MS), held = heldOf(kept.columns.load(since), kept.coverage.load(since), kept.importedHours()), epoch = kept.writeEpoch();
    const done = await importHistory({ url: history, held, add: columns => kept.importColumns(columns), addRows: rows => kept.importRows(rows), since, now, ...(latest ? { latest } : {}) });
    if (done.error || done.failed) console.warn('recorded history:', done.error ?? `${done.failed} hours could not be read`);
    if (done.read?.length) void kept.markImported(done.read, epoch);
    if (done.columns || done.rows) console.info(`recorded history: ${done.columns} map minutes and ${done.rows} other records from ${done.hours} hours`);
    // A book this page holds nothing of (and was given nothing of in time) records on the service's grid, so the next visit can show
    // the service's minutes with its own.
    for (const [inst, step] of Object.entries(done.steps ?? {})) if (!held.steps.has(inst)) gridSteps.set(inst, step);
    // The long history's tiles, from the same latest.json: the page reads the windows before its day from them (app/archive/).
    tiles.info = done.tiles ?? null;
    // Whether its hours carry the coin's book minutes (book steps named): a coin kept as tiles alone (ETH, SOL) has its day from the tiles too.
    if (tiles.info) tiles.hourBooks = Object.keys(done.steps ?? {}).length > 0;
  }
}

async function answer(call: RpcCall, run: Engine): Promise<{ result: unknown; transfer: Transferable[] }> {
  // The questions held for the history are answered a task each, so the live feeds' passes run between them. The map's own load waits for
  // the newest recordings only, when the page has any (`previewLanded`, browser/waits.ts).
  const wait = historyDone ? 'none' : waitOf(call);
  if (wait !== 'none') { await (wait === 'newest' ? Promise.race([historyLanded, previewLanded]) : historyLanded); await new Promise(resolve => setTimeout(resolve, 0)); }
  switch (call.method) {
    case 'bootstrap': return { result: run.bootstrap(), transfer: [] };
    case 'columns': {
      // The map's load, still waiting for the rest of the recordings: answered from their newest minutes (`Engine.preview`), said so on the
      // frame and with the history, and asked again (any other reader waited for the history above).
      const preview = run.waiting;
      if (preview) columnsEarly = true;
      // With where each book's own minutes begin: the page fills what lies before it from the long history (app/archive/).
      const frame = { ...run.columns(call.ids, call.from, call.to, call.stepMs, call.close === true), since: run.heldSince(call.ids, CONTIGUOUS_GAP_MS), ...(preview ? { preview } : {}) };
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
  if (message.type === 'init') { init(message.selected, message.known, message.persist, message.coin, message.tier, message.database, message.lock, message.history, message.historyHours).catch(error => post({ type: 'failed', error: error instanceof Error ? error.message : String(error) })); return; }
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
