import { COLUMNS_PER_REQUEST } from '../shared/columns.ts';
import { fromWire, type Print } from './prints.ts';
import { decodeColumns, decodeLevels, type ColumnsFrame, type LevelsFrame } from './wire.ts';
import type { CandleRow, LayerLevel, Market, OiBar } from './store.ts';

export interface BootstrapState {
  asOf: number; now: number; dataMode: string; markPrice: number; markInstrumentId: string;
  markets: Market[]; layers: Record<string, LayerLevel[]>; steps: Record<string, number>; recorded: Record<string, { first: number; last: number }>; columnMs: number; timeframes: string[];
}
export interface TickMessage { t: 'tick'; price: number; instrumentId: string; asOf: number; candles: Record<string, [number, number, number, number, number, number]> }
export interface LayersMessage { t: 'layers'; layers: Record<string, LayerLevel[]> }
export interface PrintsMessage { t: 'prints'; items: unknown[] }
export interface LiveHandlers {
  /** `failures` counts the connections lost since the last one that worked; `host` is the server being tried. */
  onOpen(): void; onClose(failures: number, host: string): void;
  onLevels(frame: LevelsFrame): void; onTick(tick: TickMessage): void; onLayers(message: LayersMessage): void;
  /** New large trades, as wire rows (check each with `fromWire`). */
  onPrints(items: unknown[]): void;
}

async function request(path: string): Promise<Response> {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response;
}
export const getBootstrap = async (): Promise<BootstrapState> => (await request('/api/v2/state')).json();
export async function getCandles(inst: string, tf: string, from: number, to: number): Promise<CandleRow[]> {
  const body = await (await request(`/api/v2/candles?inst=${encodeURIComponent(inst)}&tf=${tf}&from=${from}&to=${to}`)).json() as { candles: CandleRow[] };
  return body.candles;
}
/** Large trades in [from, to), oldest first (malformed rows dropped). */
export async function getPrints(from: number, to: number): Promise<Print[]> {
  const body = await (await request(`/api/v2/prints?from=${Math.floor(from)}&to=${Math.ceil(to)}`)).json() as { prints?: unknown[] };
  return (body.prints ?? []).flatMap(row => { const p = fromWire(row); return p ? [p] : []; });
}
export async function getOi(inst: string, tf: string, from: number, to: number): Promise<OiBar[]> {
  const body = await (await request(`/api/v2/oi?inst=${encodeURIComponent(inst)}&tf=${tf}&from=${from}&to=${to}`)).json() as { bars: OiBar[] };
  return body.bars;
}
/** Recorded columns for any number of instruments: the server serves a bounded number per request, so longer lists are split and merged. */
export async function getColumns(ids: string[], from: number, to: number, stepMs: number): Promise<ColumnsFrame> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += COLUMNS_PER_REQUEST) chunks.push(ids.slice(i, i + COLUMNS_PER_REQUEST));
  const frames = await Promise.all(chunks.map(async chunk => {
    const buffer = await (await request(`/api/v2/columns?inst=${chunk.map(encodeURIComponent).join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}&stepMs=${stepMs}`)).arrayBuffer();
    return decodeColumns(buffer);
  }));
  const first = frames[0];
  if (!first) return { from, to, stepMs, instruments: [] };
  return { from: first.from, to: first.to, stepMs: first.stepMs, instruments: frames.flatMap(frame => frame.instruments) };
}

/** The toolbar's text while there is no live connection: a plain "reconnecting" at first, then the address that is not answering. */
export const connectionStatus = (failures: number, host: string): string => failures < 3 ? 'reconnecting' : `no answer from ${host} (retry ${failures})`;

/**
 * Live socket with capped exponential reconnect. Binary frames are levels; text frames are ticks, layers, prints and a heartbeat every few
 * seconds. A connection that stays open but goes silent (a stalled server, a dead network path) never fires `onclose`, so silence for
 * `silenceMs` counts as a lost connection and is retried like one, once the server has shown that it sends heartbeats (an older server
 * says nothing while the market is quiet, and a quiet market is not a broken connection).
 */
export function connectLive(handlers: LiveHandlers, { silenceMs = 20_000, pollMs = 5_000, now = () => performance.now() }: { silenceMs?: number; pollMs?: number; now?: () => number } = {}): { close(): void } {
  let socket: WebSocket | null = null, closed = false, attempt = 0, timer: number | undefined, heard = 0, beats = false;
  const lost = () => { handlers.onClose(attempt + 1, location.host); if (!closed) timer = window.setTimeout(open, Math.min(10_000, 500 * 2 ** attempt++)); };
  const open = () => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v2/ws`;
    const current = new WebSocket(url); current.binaryType = 'arraybuffer'; socket = current;
    current.onopen = () => { attempt = 0; heard = now(); beats = false; handlers.onOpen(); };
    current.onmessage = event => {
      heard = now();
      try {
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data) as { t: string };
          if (message.t === 'hb') beats = true;
          else if (message.t === 'tick') handlers.onTick(message as TickMessage); else if (message.t === 'layers') handlers.onLayers(message as LayersMessage);
          else if (message.t === 'prints' && Array.isArray((message as PrintsMessage).items)) handlers.onPrints((message as PrintsMessage).items);
        } else handlers.onLevels(decodeLevels(event.data as ArrayBuffer));
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
  return { close() { closed = true; window.clearTimeout(timer); window.clearInterval(watchdog); socket?.close(); } };
}
