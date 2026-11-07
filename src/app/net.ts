import type { PrintSumsAnswer, SumRow } from '../shared/print-sums.ts';
import { parseLsSeries, type LsMetric, type LsSeries } from '../shared/long-short.ts';
import { COLUMNS_PER_REQUEST } from '../shared/columns.ts';
import { decodeFlowFrame, decodeFlowMinutes, type FlowFrame, type FlowMinutesFrame, type FlowUpdate } from '../shared/flow.ts';
import { parseProfile, parseRange, parseSizes, parseValueAreas, type ProfileAnswer, type RangeAnswer, type SizesAnswer, type ValueAreaAnswer } from '../shared/footprint.ts';
import { parseOiProfile, type OiProfileAnswer } from '../shared/oi-profile.ts';
import { AbsorptionProfile, parseAbsorptionAnswer, parseAbsorptionLive, parseAbsorptionProfile, type AbsorptionAnswer, type AbsorptionProfileAnswer } from '../shared/absorption.ts';
import { parseCoverage, type CoverageAnswer, type CoverageMetric } from '../shared/coverage.ts';
import { fromWire, type Print } from './prints.ts';
import { fromWire as liquidationFromWire, type Liquidation } from '../shared/liquidations.ts';
import { decodeColumns, decodeLevels, decodeLt, decodeTape, frameType, type ColumnsFrame, type LtFrame } from './wire.ts';
import type { CandleRow, OiBar } from './store.ts';
import { parsePriceHistory, priceTimeframeMs, type PriceHistoryAnswer } from '../shared/price-history.ts';
import type { BootstrapState, FootprintResponse, LayersMessage, LiquidationsMessage, LiveHandlers, OiPushMessage, PrintsMessage, TickMessage } from './source.ts';
import { t } from './i18n.ts';

/** `priority`: where the browser puts the request among those waiting for one of its six connections to the server (Fetch Priority; ignored where unknown). */
async function request(path: string, signal?: AbortSignal, priority?: 'high' | 'low'): Promise<Response> {
  const response = await fetch(path, { cache: 'no-store', ...(signal ? { signal } : {}), ...(priority ? { priority } : {}) } as RequestInit);
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response;
}
/** The size lines of a question (USD, see `parseCuts`), whole dollars: none adds nothing, so an older server is asked what it was always asked. */
/** The size lines as asked, to the last digit: a line rounded on the way would count orders the page puts under it (a coin's scaled sizes have cents). */
const cutsParam = (cuts: readonly number[]): string => cuts.length ? `&cuts=${cuts.map(String).join(',')}` : '';
/** Recorded history for one instrument and window, as the footprint draws it, with the orders from each size line in `cuts` where the server has them. */
export async function getFootprint(inst: string, tf: string, from: number, to: number, rowStep: number, cuts: readonly number[] = [], budget?: number, venues = false): Promise<FootprintResponse> {
  return (await request(`/api/v2/footprint?inst=${encodeURIComponent(inst)}&tf=${tf}&from=${Math.floor(from)}&to=${Math.ceil(to)}&rows=${rowStep}${cutsParam(cuts)}${budget ? `&budget=${Math.round(budget)}` : ''}${venues ? '&venues=1' : ''}`)).json() as Promise<FootprintResponse>;
}
export const getBootstrap = async (): Promise<BootstrapState> => (await request('/api/v2/state')).json();
/** A read of candles that has had no answer in this long is given up (a busy server answers in seconds; one that never does would hold a connection). */
const CANDLES_TIMEOUT_MS = 30_000;
export async function getCandles(inst: string, tf: string, from: number, to: number): Promise<CandleRow[]> {
  const body = await (await request(`/api/v2/candles?inst=${encodeURIComponent(inst)}&tf=${tf}&from=${from}&to=${to}`, AbortSignal.timeout(CANDLES_TIMEOUT_MS))).json() as { candles: CandleRow[] };
  return body.candles;
}
export async function getPriceHistory(inst: string, tf: string, from: number, to: number, signal?: AbortSignal): Promise<PriceHistoryAnswer> {
  const response = await request(`/api/v2/price-history?inst=${encodeURIComponent(inst)}&tf=${tf}&from=${from}&to=${to}`, signal);
  return parsePriceHistory(await response.json(), inst, priceTimeframeMs(tf) ?? 0);
}
/** Whale VWAP sums (a server from before them answers 404, which is an error here); rows that are not five finite numbers are dropped. */
export async function getPrintSums(ids: string[], from: number, to: number, minUsd: number, stepMs: number): Promise<PrintSumsAnswer> {
  const body = await (await request(`/api/v2/print-sums?inst=${ids.map(encodeURIComponent).join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}&min=${minUsd}&step=${Math.round(stepMs)}`)).json() as { since?: unknown; rows?: unknown[] };
  const rows = (Array.isArray(body.rows) ? body.rows : []).filter((r): r is SumRow => Array.isArray(r) && r.length === 5 && r.every(x => typeof x === 'number' && Number.isFinite(x)));
  return { since: typeof body.since === 'number' && Number.isFinite(body.since) ? body.since : null, rows };
}
/** Liquidations in a window (a server from before them answers 404, which is an error here). */
export async function getLiquidations(from: number, to: number, minUsd?: number): Promise<Liquidation[]> {
  const min = minUsd !== undefined ? `&min=${Math.floor(minUsd)}` : '';
  const body = await (await request(`/api/v2/liquidations?from=${Math.floor(from)}&to=${Math.ceil(to)}${min}`)).json() as { liquidations?: unknown[] };
  return (body.liquidations ?? []).flatMap(row => { const l = liquidationFromWire(row); return l ? [l] : []; });
}
/** Large trades in [from, to), oldest first (malformed rows dropped). */
export async function getPrints(from: number, to: number, minUsd?: number): Promise<Print[]> {
  const min = minUsd !== undefined && Number.isFinite(minUsd) ? `&min=${Math.round(minUsd)}` : '';
  const body = await (await request(`/api/v2/prints?from=${Math.floor(from)}&to=${Math.ceil(to)}${min}`)).json() as { prints?: unknown[] };
  return (body.prints ?? []).flatMap(row => { const p = fromWire(row); return p ? [p] : []; });
}
export async function getOi(inst: string, tf: string, from: number, to: number, usd = false): Promise<OiBar[]> {
  const body = await (await request(`/api/v2/oi?inst=${encodeURIComponent(inst)}&tf=${tf}&from=${from}&to=${to}${usd ? '&usd=1' : ''}`)).json() as { bars: OiBar[]; usd?: unknown };
  // A server from before USD readings ignores the flag and answers coins: none, rather than coins read as dollars.
  return usd && body.usd !== true ? [] : body.bars;
}
/**
 * A venue's long/short readings for one market (the server reads them from the venue when asked, see shared/long-short.ts); `signal` cancels.
 * `budgetMs`: the server answers within it with what it holds, `pending` while it reads on (a server from before ignores it and waits).
 * Asked at high priority: while a page loads, its history requests hold every connection to the server for seconds each, and a pane's few
 * small answers waited behind them for twenty seconds (2026-10-23); a background question (budget 0, the pane's warming) is asked at low.
 */
export async function getLongShort(inst: string, metric: LsMetric, tf: string, from: number, to: number, signal?: AbortSignal, budgetMs?: number): Promise<LsSeries> {
  const budget = budgetMs === undefined ? '' : `&budget=${Math.max(0, Math.round(budgetMs))}`;
  return parseLsSeries(await (await request(`/api/v2/long-short?inst=${encodeURIComponent(inst)}&metric=${metric}&tf=${tf}&from=${Math.floor(from)}&to=${Math.ceil(to)}${budget}`, signal, budgetMs === 0 ? 'low' : 'high')).json());
}
/** Taker flow per second for the instruments, as the server records it. */
export async function getFlow(ids: string[], from: number, to: number): Promise<FlowFrame> {
  if (!ids.length) return { from, to, instruments: [] };
  return decodeFlowFrame(await (await request(`/api/v2/flow?inst=${ids.map(encodeURIComponent).join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}`)).arrayBuffer());
}
/** Older flow a minute at a time (a server from before it kept them answers 404, which is an error here). */
export async function getFlowMinutes(ids: string[], from: number, to: number): Promise<FlowMinutesFrame> {
  if (!ids.length) return { from, to, instruments: [] };
  return decodeFlowMinutes(await (await request(`/api/v2/flow-minutes?inst=${ids.map(encodeURIComponent).join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}`)).arrayBuffer());
}
/**
 * The trades of the instruments added together by size over each of the last `windows` minutes, in one request (never split: the minutes two
 * answers saw cannot be added). An answer that is not exactly what was asked for (an older server's 404, a page of HTML, a cut-off body) is an error.
 */
export async function getSizes(ids: string[], windows: number[], cuts: readonly number[] = []): Promise<SizesAnswer> {
  const response = await fetch(`/api/v2/sizes?inst=${ids.map(encodeURIComponent).join(',')}&minutes=${windows.join(',')}${cutsParam(cuts)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`sizes failed: ${response.status}`);
  const answer = parseSizes(await response.json().catch(() => null), windows, cuts.length);
  if (!answer) throw new Error('sizes answered with something else');
  return answer;
}
/** Absorption candidates and minutes (see DataSource.absorption); an older server without the route rejects (404). */
export async function getAbsorption(ids: string[], mins: number[], from: number, to: number, limit: number, since: number): Promise<AbsorptionAnswer> {
  const response = await fetch(`/api/v2/absorption?inst=${ids.map(encodeURIComponent).join(',')}&min=${mins.map(m => Math.floor(m)).join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}&limit=${limit}&since=${Math.floor(since)}`, { cache: 'no-store' });
  // The status goes with the error: an older server without the route (404) is not the same as a request that failed.
  if (!response.ok) throw Object.assign(new Error(`absorption failed: ${response.status}`), { status: response.status });
  const answer = parseAbsorptionAnswer(await response.json().catch(() => null), ids);
  if (!answer) throw new Error('absorption answered with something else');
  return answer;
}
/** The most groups of each instrument an older server is asked for, for the absorption column it cannot add up itself (the largest). */
const OLDER_SERVER_GROUPS = 4_000;
/**
 * The absorption column (see DataSource.absorptionProfile). A server from before the route (404) is asked for the groups instead, the
 * largest OLDER_SERVER_GROUPS of each instrument (and the minutes of the last minute only), and they are added up here; `cut` then names
 * the instruments that had more.
 */
export async function getAbsorptionProfile(ids: string[], thresholds: number[], from: number, to: number, rowStep: number): Promise<AbsorptionProfileAnswer> {
  const response = await fetch(`/api/v2/absorption-profile?inst=${ids.map(encodeURIComponent).join(',')}&min=${thresholds.join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}&step=${rowStep}`, { cache: 'no-store' });
  if (response.status === 404) {
    const older = await getAbsorption(ids, thresholds, from, to, OLDER_SERVER_GROUPS, Math.max(Math.ceil(to), Date.now() - 60_000));
    const out = new AbsorptionProfile(new Map(ids.map((id, i) => [id, thresholds[i]!])), from, to, rowStep);
    for (const g of older.groups) out.add(g);
    for (const [id, floor] of Object.entries(older.floors)) out.floor(id, null, floor);
    return out.answer(older.capped);
  }
  if (!response.ok) throw Object.assign(new Error(`absorption profile failed: ${response.status}`), { status: response.status });
  const answer = parseAbsorptionProfile(await response.json().catch(() => null), ids);
  if (!answer) throw new Error('the absorption column answered with something else');
  return answer;
}
/** Traded volume by price for these instruments over [from, to); an older server without the route rejects (404). */
/** When `ids` were recorded (see `CoverageAnswer`). Rejects on a server that does not know the question (an older one). */
export async function getCoverage(ids: string[], metric: CoverageMetric, from: number, to: number): Promise<CoverageAnswer> {
  const response = await fetch(`/api/v2/coverage?inst=${ids.map(encodeURIComponent).join(',')}&metric=${metric}&from=${Math.floor(from)}&to=${Math.ceil(to)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`coverage failed: ${response.status}`);
  const answer = parseCoverage(await response.json().catch(() => null), ids, metric, from, to);
  if (!answer) throw new Error('coverage answered with something else');
  return answer;
}
export async function getProfile(ids: string[], from: number, to: number, rowStep: number): Promise<ProfileAnswer> {
  const response = await fetch(`/api/v2/profile?inst=${ids.map(encodeURIComponent).join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}&step=${rowStep}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`profile failed: ${response.status}`);
  const answer = parseProfile(await response.json().catch(() => null), ids);
  if (!answer) throw new Error('profile answered with something else');
  return answer;
}
/** The change in open interest by price (shared/oi-profile.ts). Rejects on a server that does not know the question (an older one). */
export async function getOiProfile(ids: string[], from: number, to: number, rowStep: number): Promise<OiProfileAnswer> {
  const response = await fetch(`/api/v2/oi-profile?inst=${ids.map(encodeURIComponent).join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}&step=${rowStep}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`oi profile failed: ${response.status}`);
  const answer = parseOiProfile(await response.json().catch(() => null), ids);
  if (!answer) throw new Error('oi profile answered with something else');
  return answer;
}
/** What happened in a selection of the map or of a pane (see `RangeAnswer`). Rejects on a server that does not know the question (an older one). */
export async function getRange(ids: string[], from: number, to: number, band: { p0: number; p1: number } | null, rowStep: number): Promise<RangeAnswer> {
  const prices = band ? `&p0=${band.p0}&p1=${band.p1}` : '';
  const response = await fetch(`/api/v2/range?inst=${ids.map(encodeURIComponent).join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}${prices}&step=${rowStep}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`range failed: ${response.status}`);
  const answer = parseRange(await response.json().catch(() => null), ids);
  if (!answer) throw new Error('range answered with something else');
  return answer;
}
/** The point of control and the value area of each window (see `ValueAreaAnswer`). Rejects on a server that does not know the question (an older one). */
export async function getValueAreas(ids: string[], windows: { from: number; to: number }[], rowStep: number, share: number): Promise<ValueAreaAnswer> {
  const w = windows.map(x => `${Math.floor(x.from)}-${Math.ceil(x.to)}`).join(',');
  const response = await fetch(`/api/v2/value-areas?inst=${ids.map(encodeURIComponent).join(',')}&w=${w}&step=${rowStep}&share=${share}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`value areas failed: ${response.status}`);
  const answer = parseValueAreas(await response.json().catch(() => null), windows.map(x => ({ from: Math.floor(x.from), to: Math.ceil(x.to) })));
  if (!answer) throw new Error('value areas answered with something else');
  return answer;
}
/**
 * Recorded columns for any number of instruments: the server serves a bounded number per request, so longer lists are split and merged.
 * `close`: each window's book at its close (a server from before answers averages, without `at`).
 */
export async function getColumns(ids: string[], from: number, to: number, stepMs: number, close = false): Promise<ColumnsFrame> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += COLUMNS_PER_REQUEST) chunks.push(ids.slice(i, i + COLUMNS_PER_REQUEST));
  const frames = await Promise.all(chunks.map(async chunk => {
    const buffer = await (await request(`/api/v2/columns?inst=${chunk.map(encodeURIComponent).join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}&stepMs=${stepMs}${close ? '&close=1' : ''}`)).arrayBuffer();
    return decodeColumns(buffer);
  }));
  const first = frames[0];
  if (!first) return { from, to, stepMs, instruments: [] };
  return { from: first.from, to: first.to, stepMs: first.stepMs, instruments: frames.flatMap(frame => frame.instruments) };
}

/** The toolbar's text while there is no live connection: a plain "reconnecting" at first, then the address that is not answering. */
export const connectionStatus = (failures: number, host: string): string => failures < 3 ? t('reconnecting') : t('no answer from {host} (retry {n})', { host, n: failures });

/**
 * Live socket with capped exponential reconnect. Binary frames are levels; text frames are ticks, layers, prints and a heartbeat every few
 * seconds. A connection that stays open but goes silent (a stalled server, a dead network path) never fires `onclose`, so silence for
 * `silenceMs` counts as a lost connection and is retried like one, once the server has shown that it sends heartbeats (an older server
 * says nothing while the market is quiet, and a quiet market is not a broken connection).
 */
export function connectLive(handlers: LiveHandlers, { silenceMs = 20_000, pollMs = 5_000, now = () => performance.now() }: { silenceMs?: number; pollMs?: number; now?: () => number } = {}): LiveConnection {
  let socket: WebSocket | null = null, closed = false, attempt = 0, timer: number | undefined, heard = 0, beats = false, tapeOn = false;
  /** Long/short questions on the socket, once its server said it answers them (`hello`): waiting by id, all given up when it closes. */
  let lsReady = false, lsNext = 0;
  // A question its asker gave up is kept here, settled, until its answer comes: the server still counts it among its 16.
  const lsWaiting = new Map<number, { resolve(series: LsSeries): void; reject(error: Error): void; timer: number; given?: boolean; off(): void }>();
  /**
   * Whether this socket's server answers them: unknown while it connects and for `LS_HELLO_MS` after (a question waits for it, up to the
   * caller's limit: while a page loads, HTTP is where its questions wait longest), yes once it said so, no for a server that did not or a
   * socket that is down (its questions go over HTTP at once).
   */
  let lsKnown: 'unknown' | 'yes' | 'no' = 'unknown';
  const lsReadyWaiters = new Set<(ok: boolean) => void>();
  /** Whether this socket's server answers Liquidity Tracker questions (its hello says so), and the ones waiting: frames in, the last one resolves. */
  let ltOk = false, ltNext = 0;
  const ltWaiting = new Map<number, { onFrame(frame: LtFrame): void; resolve(): void; reject(error: Error): void; timer: number; off(): void }>();
  const lsSettle = (known: 'yes' | 'no'): void => { lsKnown = known; lsReady = known === 'yes'; for (const w of lsReadyWaiters) w(lsReady); lsReadyWaiters.clear(); };
  const lsDrop = (why: string): void => {
    lsSettle('no'); ltOk = false;
    for (const w of lsWaiting.values()) { window.clearTimeout(w.timer); w.off(); w.reject(new Error(why)); }
    lsWaiting.clear();
    for (const w of ltWaiting.values()) { window.clearTimeout(w.timer); w.off(); w.reject(new Error(why)); }
    ltWaiting.clear();
  };
  /** Tell the server whether to send the trade dust (again on every new connection). */
  const sayTape = (): void => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'tape', on: tapeOn })); };
  const lost = () => { lsDrop('live-closed'); handlers.onClose(attempt + 1, location.host); if (!closed) timer = window.setTimeout(open, Math.min(10_000, 500 * 2 ** attempt++)); };
  const open = () => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v2/ws`;
    const current = new WebSocket(url); current.binaryType = 'arraybuffer'; socket = current;
    lsKnown = 'unknown';
    current.onopen = () => {
      // A server that has not said it answers long/short questions soon after the socket opens is one from before: HTTP for them.
      window.setTimeout(() => { if (socket === current && lsKnown === 'unknown') lsSettle('no'); }, LS_HELLO_MS);
      attempt = 0; heard = now(); beats = false; if (tapeOn) sayTape(); handlers.onOpen();
    };
    current.onmessage = event => {
      heard = now();
      try {
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data) as { t: string };
          if (message.t === 'hb') beats = true;
          else if (message.t === 'hello') { ltOk = (message as { lt?: unknown }).lt === true; lsSettle((message as { ls?: unknown }).ls === true ? 'yes' : 'no'); }
          else if (message.t === 'lt') {
            // A tracker question's refusal (its frames are binary): the question fails, and the caller reads the columns instead.
            const m = message as { id?: unknown; error?: unknown }, w = typeof m.id === 'number' ? ltWaiting.get(m.id) : undefined;
            if (w) { ltWaiting.delete(m.id as number); window.clearTimeout(w.timer); w.off(); w.reject(new Error(String(m.error ?? 'lt-refused'))); }
          }
          else if (message.t === 'ls') {
            const m = message as { id?: unknown; series?: unknown; error?: unknown }, w = typeof m.id === 'number' ? lsWaiting.get(m.id) : undefined;
            if (w) {
              lsWaiting.delete(m.id as number); window.clearTimeout(w.timer); w.off();
              if (!w.given) try { if (m.error !== undefined) w.reject(new Error(String(m.error))); else w.resolve(parseLsSeries(m.series)); } catch (error) { w.reject(error instanceof Error ? error : new Error(String(error))); }
            }
          }
          else if (message.t === 'tick') handlers.onTick(message as TickMessage); else if (message.t === 'layers') handlers.onLayers(message as LayersMessage);
          else if (message.t === 'prints' && Array.isArray((message as PrintsMessage).items)) handlers.onPrints((message as PrintsMessage).items);
          else if (message.t === 'liquidations' && Array.isArray((message as LiquidationsMessage).items)) handlers.onLiquidations?.((message as LiquidationsMessage).items);
          else if (message.t === 'flow' && Array.isArray((message as { items?: unknown }).items)) handlers.onFlow?.((message as unknown as { items: FlowUpdate[] }).items);
          else if (message.t === 'oi' && Array.isArray((message as OiPushMessage).items)) handlers.onOiPush?.((message as OiPushMessage).items);
          else if (message.t === 'absorption') { const found = parseAbsorptionLive(message); handlers.onAbsorption?.(found.groups, found.minutes); }
        } else {
          const kind = frameType(event.data as ArrayBuffer);
          if (kind === 'tape') { const batch = decodeTape(event.data as ArrayBuffer); if (batch && tapeOn) handlers.onTape?.(batch); }
          else if (kind === 'lt') {
            const frame = decodeLt(event.data as ArrayBuffer), w = ltWaiting.get(frame.id);
            // A frame for a question given up, timed out or refused finds no waiter and is let go.
            if (w) { w.onFrame(frame); if (frame.done) { ltWaiting.delete(frame.id); window.clearTimeout(w.timer); w.off(); w.resolve(); } }
          }
          else handlers.onLevels(decodeLevels(event.data as ArrayBuffer));
        }
      } catch (error) { console.error('live frame rejected', error); }
    };
    current.onclose = lost;
    current.onerror = () => current.close();
  };
  const watchdog = window.setInterval(() => {
    const quiet = socket;
    if (closed || !beats || !quiet || quiet.readyState !== WebSocket.OPEN || now() - heard <= silenceMs) return;
    quiet.onclose = null; quiet.onmessage = null; quiet.close(); // do not wait for a closing handshake the other side may never answer
    lost();
  }, pollMs);
  open();
  return {
    close() { closed = true; window.clearTimeout(timer); window.clearInterval(watchdog); lsDrop('live-closed'); socket?.close(); },
    tape(on) { if (on !== tapeOn) { tapeOn = on; sayTape(); } },
    lsReadyWithin(ms) {
      if (lsKnown !== 'unknown' || closed) return Promise.resolve(lsReady && !closed);
      return new Promise<boolean>(resolve => {
        const done = (ok: boolean): void => { window.clearTimeout(timer); lsReadyWaiters.delete(done); resolve(ok); };
        const timer = window.setTimeout(() => done(false), ms);
        lsReadyWaiters.add(done);
      });
    },
    ltLane(ids, from, to, stepMs, half, onFrame, signal) {
      const live = socket;
      if (!ltOk || !live || live.readyState !== WebSocket.OPEN || ltWaiting.size >= LT_SOCKET_WAITING) return null;
      if (signal?.aborted) return Promise.reject(new Error('cancelled'));
      const id = ++ltNext;
      return new Promise<void>((resolve, reject) => {
        // Given up by its asker, or timed out: the server is told to stop (it frees the slot at once), and a late frame for it finds no waiter.
        const stop = (): void => { if (live.readyState === WebSocket.OPEN) live.send(JSON.stringify({ t: 'lt', id, cancel: true })); };
        const onAbort = (): void => { const w = ltWaiting.get(id); if (w) { ltWaiting.delete(id); window.clearTimeout(w.timer); reject(new Error('cancelled')); stop(); } };
        const off = (): void => signal?.removeEventListener('abort', onAbort);
        const timer = window.setTimeout(() => { ltWaiting.delete(id); off(); reject(new Error('live-timeout')); stop(); }, LT_SOCKET_TIMEOUT_MS);
        ltWaiting.set(id, { onFrame, resolve, reject, timer, off });
        signal?.addEventListener('abort', onAbort, { once: true });
        live.send(JSON.stringify({ t: 'lt', id, inst: ids, from: Math.floor(from), to: Math.ceil(to), stepMs, half }));
      });
    },
    longShort(inst, metric, tf, from, to, budgetMs, signal) {
      const live = socket;
      if (!lsReady || !live || live.readyState !== WebSocket.OPEN || lsWaiting.size >= LS_SOCKET_WAITING) return null;
      if (signal?.aborted) return Promise.reject(new Error('cancelled'));
      const id = ++lsNext;
      return new Promise<LsSeries>((resolve, reject) => {
        const onAbort = (): void => { const w = lsWaiting.get(id); if (w && !w.given) { w.given = true; reject(new Error('cancelled')); } };
        const off = (): void => signal?.removeEventListener('abort', onAbort);
        const timer = window.setTimeout(() => { lsWaiting.delete(id); off(); reject(new Error('live-timeout')); }, LS_SOCKET_TIMEOUT_MS);
        lsWaiting.set(id, { resolve, reject, timer, off });
        signal?.addEventListener('abort', onAbort, { once: true });
        live.send(JSON.stringify({ t: 'ls', id, inst, metric, tf, from: Math.floor(from), to: Math.ceil(to), ...(budgetMs === undefined ? {} : { budget: Math.max(0, Math.round(budgetMs)) }) }));
      });
    },
  };
}

/** The most long/short questions waiting on the live socket, those given up included until answered (the server answers 16 at once); past it they go over HTTP. */
const LS_SOCKET_WAITING = 16;
/** A question not answered on the socket in this long is given up (the pane's round has long ended). */
const LS_SOCKET_TIMEOUT_MS = 60_000;
/** The most Liquidity Tracker questions waiting on the live socket (the server answers four at once), and how long one may take before it is given up. */
const LT_SOCKET_WAITING = 4;
const LT_SOCKET_TIMEOUT_MS = 90_000;
/** How long after its socket opens a server has to say it answers long/short questions there (it says so at once). */
const LS_HELLO_MS = 3_000;
/**
 * The live connection: closed, told whether to send the trade dust, and asked long/short questions on (`longShort`: null where it cannot be,
 * a server from before that never said it answers them, a socket not open, too many waiting: the caller asks over HTTP).
 */
export interface LiveConnection {
  close(): void;
  tape(on: boolean): void;
  /** Whether its server answers long/short questions on it, waiting up to `ms` while that is not known yet (the socket connecting). */
  lsReadyWithin(ms: number): Promise<boolean>;
  longShort(inst: string, metric: LsMetric, tf: string, from: number, to: number, budgetMs?: number, signal?: AbortSignal): Promise<LsSeries> | null;
  /**
   * The Liquidity Tracker of these markets over [from, to) at `stepMs` for one half-life (an index into LT_HALF_LIVES), in frames handed to `onFrame`
   * newest stretch first, settled when the last has come; null where the socket cannot ask it (a server from before, not open, too many waiting).
   */
  ltLane(ids: string[], from: number, to: number, stepMs: number, half: number, onFrame: (frame: LtFrame) => void, signal?: AbortSignal): Promise<void> | null;
}
