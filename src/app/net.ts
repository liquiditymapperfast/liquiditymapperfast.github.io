import { COLUMNS_PER_REQUEST } from '../shared/columns.ts';
import { decodeFlowFrame, type FlowFrame, type FlowUpdate } from '../shared/flow.ts';
import { parseProfile, parseSizes, type ProfileAnswer, type SizesAnswer } from '../shared/footprint.ts';
import { parseAbsorptionAnswer, parseAbsorptionLive, type AbsorptionAnswer } from '../shared/absorption.ts';
import { fromWire, type Print } from './prints.ts';
import { decodeColumns, decodeLevels, type ColumnsFrame } from './wire.ts';
import type { CandleRow, OiBar } from './store.ts';
import type { BootstrapState, FootprintResponse, LayersMessage, LiveHandlers, PrintsMessage, TickMessage } from './source.ts';
import { t } from './i18n.ts';

async function request(path: string): Promise<Response> {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response;
}
/** Recorded history for one instrument and window, as the footprint draws it. */
export async function getFootprint(inst: string, tf: string, from: number, to: number, rowStep: number): Promise<FootprintResponse> {
  return (await request(`/api/v2/footprint?inst=${encodeURIComponent(inst)}&tf=${tf}&from=${Math.floor(from)}&to=${Math.ceil(to)}&rows=${rowStep}`)).json() as Promise<FootprintResponse>;
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
/** Taker flow per second for the instruments, as the server records it. */
export async function getFlow(ids: string[], from: number, to: number): Promise<FlowFrame> {
  if (!ids.length) return { from, to, instruments: [] };
  return decodeFlowFrame(await (await request(`/api/v2/flow?inst=${ids.map(encodeURIComponent).join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}`)).arrayBuffer());
}
/**
 * The trades of the instruments added together by size over each of the last `windows` minutes, in one request (never split: the minutes two
 * answers saw cannot be added). An answer that is not exactly what was asked for (an older server's 404, a page of HTML, a cut-off body) is an error.
 */
export async function getSizes(ids: string[], windows: number[]): Promise<SizesAnswer> {
  const response = await fetch(`/api/v2/sizes?inst=${ids.map(encodeURIComponent).join(',')}&minutes=${windows.join(',')}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`sizes failed: ${response.status}`);
  const answer = parseSizes(await response.json().catch(() => null), windows);
  if (!answer) throw new Error('sizes answered with something else');
  return answer;
}
/** Absorption candidates and minutes (see DataSource.absorption); an older server without the route rejects (404). */
export async function getAbsorption(ids: string[], mins: number[], from: number, to: number, limit: number, since: number): Promise<AbsorptionAnswer> {
  const response = await fetch(`/api/v2/absorption?inst=${ids.map(encodeURIComponent).join(',')}&min=${mins.map(m => Math.floor(m)).join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}&limit=${limit}&since=${Math.floor(since)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`absorption failed: ${response.status}`);
  const answer = parseAbsorptionAnswer(await response.json().catch(() => null), ids);
  if (!answer) throw new Error('absorption answered with something else');
  return answer;
}
/** Traded volume by price for these instruments over [from, to); an older server without the route rejects (404). */
export async function getProfile(ids: string[], from: number, to: number, rowStep: number): Promise<ProfileAnswer> {
  const response = await fetch(`/api/v2/profile?inst=${ids.map(encodeURIComponent).join(',')}&from=${Math.floor(from)}&to=${Math.ceil(to)}&step=${rowStep}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`profile failed: ${response.status}`);
  const answer = parseProfile(await response.json().catch(() => null), ids);
  if (!answer) throw new Error('profile answered with something else');
  return answer;
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
export const connectionStatus = (failures: number, host: string): string => failures < 3 ? t('reconnecting') : t('no answer from {host} (retry {n})', { host, n: failures });

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
          else if (message.t === 'flow' && Array.isArray((message as { items?: unknown }).items)) handlers.onFlow?.((message as unknown as { items: FlowUpdate[] }).items);
          else if (message.t === 'absorption') { const found = parseAbsorptionLive(message); handlers.onAbsorption?.(found.groups, found.minutes); }
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
