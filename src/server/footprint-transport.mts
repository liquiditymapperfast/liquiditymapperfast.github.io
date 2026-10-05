import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FootprintStore } from './footprint-store.mts';
import type { ProcessMemoryMonitor, ProcessMemoryReservation } from './process-memory.mts';
import type { FootprintWindowOptions } from '../core/footprint-model.mts';
import { canonicalFootprintDecimal } from '../core/footprint-grouping.mts';
import { FOOTPRINT_FRAME_LIMITS, FOOTPRINT_INTERVALS } from '../core/footprint-frame.mts';

export const FOOTPRINT_TRANSPORT_LIMITS = Object.freeze({
  maxClients: 16, cadenceMs: 100, controlBytes: 16_384, clientControlBytes: 65_536,
  subscriberBytes: 16_384, errorWorkingBytes: 8_192, maxQueryChars: 8_192,
});
type Reason = 'invalid-query' | 'source-unavailable' | 'unavailable' | 'logical-admission-denied' | 'physical-admission-denied'
  | 'projection-unavailable' | 'projection-oversized' | 'client-limit' | 'subscriber-limit' | 'write-failed' | 'closed' | 'method-not-allowed';
const reasons: readonly Reason[] = ['invalid-query', 'source-unavailable', 'unavailable', 'logical-admission-denied', 'physical-admission-denied',
  'projection-unavailable', 'projection-oversized', 'client-limit', 'subscriber-limit', 'write-failed', 'closed', 'method-not-allowed'];
const errorBodies = Object.freeze(Object.fromEntries(reasons.map(reason => [reason, '{"kind":"footprint-unavailable","reason":"' + reason + '"}']))) as Readonly<Record<Reason, string>>;
interface Selection { readonly windowKey: string; readonly options: FootprintWindowOptions }
interface WireOwner {
  readonly id: number; readonly text: string; readonly wireBytes: number; readonly logicalBytes: number;
  readonly physical: ProcessMemoryReservation; readonly terminal: boolean; readonly status: number;
  writeComplete: boolean; drained: boolean;
}
interface Client {
  readonly req: IncomingMessage; readonly res: ServerResponse; readonly stream: boolean; readonly selection: Selection | null;
  pending: WireOwner | null; inflight: WireOwner | null; unsubscribe: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null; dirty: boolean; closed: boolean; writing: boolean; transportComplete: boolean; lastProjectedAtMs: number;
  onClose: () => void; onError: () => void; onDrain: () => void; onFinish: () => void;
}
export interface FootprintTransportReclaim {
  /** Target transport-owned logical bytes; zero is a true no-op. Omission means force shutdown compatibility. */
  readonly targetBytes: number;
}
export interface FootprintTransportOptions {
  readonly store: FootprintStore | null; readonly processMemory: ProcessMemoryMonitor;
  /** Reserves ADDITIONAL bytes over all currently measured owners; invokes mutate at most once. */
  readonly runAdmitted: (bytes: number, mutate: () => boolean) => boolean;
  readonly onOwnersChanged: () => void;
}
function positiveInteger(value: string | null): number {
  if (value === null || !/^[1-9][0-9]{0,15}$/.test(value)) throw new TypeError('invalid-query');
  const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw new TypeError('invalid-query'); return parsed;
}
function selectionFromUrl(url: URL): Selection {
  if (url.search.length > FOOTPRINT_TRANSPORT_LIMITS.maxQueryChars) throw new TypeError('invalid-query');
  const keys = ['instrumentIds', 'from', 'to', 'intervalMs', 'priceStep', 'windowKey'];
  for (const [key] of url.searchParams) if (!keys.includes(key)) throw new TypeError('invalid-query');
  for (const key of keys) if (url.searchParams.getAll(key).length !== 1) throw new TypeError('invalid-query');
  const rawIds = url.searchParams.get('instrumentIds'), grouping = url.searchParams.get('priceStep'), windowKey = url.searchParams.get('windowKey');
  if (!rawIds || rawIds.length > FOOTPRINT_FRAME_LIMITS.maxSources * 193 || grouping === null || grouping.length > 96
    || !windowKey || windowKey.length > FOOTPRINT_FRAME_LIMITS.maxWindowKey || /[\u0000-\u001f\u007f]/.test(windowKey)) throw new TypeError('invalid-query');
  const instrumentIds = rawIds.split(',');
  if (!instrumentIds.length || instrumentIds.length > FOOTPRINT_FRAME_LIMITS.maxSources || new Set(instrumentIds).size !== instrumentIds.length) throw new TypeError('invalid-query');
  for (const id of instrumentIds) if (id.length > 192 || !/^(?:hyperliquid|binance):[A-Za-z0-9._:-]+$/.test(id)) throw new TypeError('invalid-query');
  const fromMs = positiveInteger(url.searchParams.get('from')), toMs = positiveInteger(url.searchParams.get('to')), intervalMs = positiveInteger(url.searchParams.get('intervalMs'));
  if (fromMs % 60_000 || toMs % 60_000 || toMs <= fromMs || toMs - fromMs > FOOTPRINT_FRAME_LIMITS.maxMinutes * 60_000
    || !FOOTPRINT_INTERVALS.includes(intervalMs) || canonicalFootprintDecimal(grouping).key !== grouping) throw new TypeError('invalid-query');
  return Object.freeze({ windowKey, options: Object.freeze({ instrumentIds: Object.freeze(instrumentIds), fromMs, toMs, intervalMs, priceStep: grouping, maxCells: FOOTPRINT_FRAME_LIMITS.maxCells }) });
}
function quotedBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes += 1;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index += 1; }
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}
/** Inert store-owned projection only. Count exact JSON UTF8 before allocating its serialized copy. */
function jsonBytes(value: unknown, maximum: number): number | null {
  let total = 0;
  const add = (bytes: number) => { total += bytes; if (!Number.isSafeInteger(total) || total > maximum) throw new RangeError('projection-oversized'); };
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8) throw new TypeError('projection-unavailable');
    if (node === null) { add(4); return; }
    if (typeof node === 'string') { add(quotedBytes(node)); return; }
    if (typeof node === 'number') { if (!Number.isFinite(node)) throw new TypeError('projection-unavailable'); add(Object.is(node, -0) ? 1 : String(node).length); return; }
    if (typeof node === 'boolean') { add(node ? 4 : 5); return; }
    if (Array.isArray(node)) { add(2); for (let index = 0; index < node.length; index += 1) { if (index) add(1); visit(node[index], depth + 1); } return; }
    if (typeof node !== 'object' || Object.getPrototypeOf(node) !== Object.prototype) throw new TypeError('projection-unavailable');
    const row = node as Record<string, unknown>, keys = Object.keys(row); add(2);
    for (let index = 0; index < keys.length; index += 1) { const key = keys[index]; if (index) add(1); add(quotedBytes(key) + 1); visit(row[key], depth + 1); }
  };
  try { visit(value, 0); return total; } catch { return null; }
}
function unavailableStatus(reason: Reason): number { return reason === 'invalid-query' ? 400 : 503; }
function wireLogicalBytes(text: string, bytes: number): number { return 2_048 + text.length * 2 + bytes * 2; }

/** Dedicated complete-window transport. It never activates providers or imports the HTTP runtime. */
export class FootprintTransport {
  readonly #options: FootprintTransportOptions;
  readonly #clients = new Set<Client>();
  #closed = false; #nextWire = 0; #stagingBytes = 0;
  #publishingClient: Client | null = null;
  #projected = 0; #sent = 0; #coalesced = 0; #denied = 0; #errors = 0;
  constructor(options: FootprintTransportOptions) { this.#options = options; }
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (url.pathname !== '/api/footprint' && url.pathname !== '/api/footprint/stream') return false;
    const stream = url.pathname.endsWith('/stream');
    if (req.method !== 'GET') { this.#unavailable(req, res, stream, 'method-not-allowed', 405); return true; }
    if (this.#closed || !this.#options.store) { this.#unavailable(req, res, stream, this.#closed ? 'closed' : 'unavailable', 503); return true; }
    if (this.#clients.size >= FOOTPRINT_TRANSPORT_LIMITS.maxClients) { this.#unavailable(req, res, stream, 'client-limit', 503); return true; }
    const control = FOOTPRINT_TRANSPORT_LIMITS.clientControlBytes + (stream ? FOOTPRINT_TRANSPORT_LIMITS.subscriberBytes : 0);
    const physical = this.#reserve(control, 'footprint-client');
    if (!physical) { this.#unavailable(req, res, stream, 'physical-admission-denied', 503); return true; }
    let client: Client | null = null, reason: Reason = 'logical-admission-denied';
    try {
      const admitted = this.#admit(control, () => {
        let selection: Selection;
        try { selection = selectionFromUrl(url); } catch { reason = 'invalid-query'; return false; }
        const plan = this.#options.store!.windowPlan(selection.options);
        if (!plan.complete) { reason = 'source-unavailable'; return false; }
        if (this.#closed || this.#clients.size >= FOOTPRINT_TRANSPORT_LIMITS.maxClients) { reason = 'client-limit'; return false; }
        client = this.#client(req, res, stream, selection);
        if (stream) {
          client.unsubscribe = this.#options.store!.subscribe(() => { if (client) this.#dirty(client); });
          if (!client.unsubscribe) { client = null; reason = 'subscriber-limit'; return false; }
        }
        this.#clients.add(client); this.#attach(client);
        if (stream) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        this.#notify();
        return true;
      });
      if (!admitted || !client) { this.#denied += 1; if (client) this.#stop(client, true); this.#unavailable(req, res, stream, reason, unavailableStatus(reason)); return true; }
    } finally { physical.release?.(); }
    const active: Client = client;

    const failure = this.#publish(active);
    if (failure) this.#fail(active, failure, failure === 'projection-oversized' ? 413 : 503);
    return true;
  }
  measure() {
    let pendingBytes = 0, inflightBytes = 0, pendingSlots = 0, inflightSlots = 0, timers = 0, streams = 0, closing = 0;
    for (const client of this.#clients) {
      if (client.pending) { pendingBytes += client.pending.logicalBytes; pendingSlots += 1; }
      if (client.inflight) { inflightBytes += client.inflight.logicalBytes; inflightSlots += 1; }
      timers += Number(client.timer !== null); streams += Number(client.stream); closing += Number(client.closed);
    }
    // An executing publisher still owns its controls on the stack even after
    // native close removes it from the client set. Expose and charge that root.
    const publishingControlBytes = this.#publishingClient && !this.#clients.has(this.#publishingClient)
      ? FOOTPRINT_TRANSPORT_LIMITS.clientControlBytes : 0;
    return { logicalBytes: FOOTPRINT_TRANSPORT_LIMITS.controlBytes + this.#clients.size * FOOTPRINT_TRANSPORT_LIMITS.clientControlBytes + pendingBytes + inflightBytes + this.#stagingBytes + publishingControlBytes,
      clients: this.#clients.size, streams, closing, pendingSlots, inflightSlots, timers, pendingBytes, inflightBytes, stagingBytes: this.#stagingBytes,
      publishingControlBytes, projected: this.#projected, sent: this.#sent, coalesced: this.#coalesced, denied: this.#denied, errors: this.#errors, closed: this.#closed };
  }
  reclaim(options?: FootprintTransportReclaim): number {
    const before = this.measure().logicalBytes;
    if (options === undefined) {
      for (const client of this.#clients) this.#stop(client, true);
      return Math.max(0, before - this.measure().logicalBytes);
    }
    const target = options.targetBytes;
    if (!Number.isSafeInteger(target) || target <= 0) return 0;
    const released = () => Math.max(0, before - this.measure().logicalBytes);
    // Cumulative windows replace one another. Dropping a not-yet-written complete
    // frame preserves native authority and avoids destroying a healthy stream.
    for (const client of this.#clients) {
      if (released() >= target) break;
      if (client.closed || client.pending?.terminal || client === this.#publishingClient) continue;
      const pending = client.pending;
      if (!pending) continue;
      client.pending = null; pending.physical.release?.();
      if (client.timer !== null) clearTimeout(client.timer); client.timer = null;
      client.dirty = true; this.#notify();
      // No retry timer: the next admitted native update supplies a newer full snapshot.
    }
    if (released() >= target) return released();
    // Already-closing roots stay charged until native finish/close, but do not
    // schedule unnecessary additional closes for the same eventual release.
    let scheduled = 0;
    for (const client of this.#clients) if (client.closed) {
      scheduled += FOOTPRINT_TRANSPORT_LIMITS.clientControlBytes + (client.inflight?.logicalBytes ?? 0);
    }
    // Least disruptive release first. The publisher is last, never exempt.
    for (let pass = 0; pass < 3 && released() + scheduled < target; pass += 1) {
      for (const client of this.#clients) {
        if (released() + scheduled >= target) break;
        if (client.closed) continue;
        const rank = client === this.#publishingClient ? 2 : client.inflight ? 1 : 0;
        if (rank !== pass) continue;
        const held = FOOTPRINT_TRANSPORT_LIMITS.clientControlBytes +
          (client.pending?.logicalBytes ?? 0) + (client.inflight?.logicalBytes ?? 0);
        const previous = released();
        this.#stop(client, client.inflight !== null);
        const immediate = released() - previous;
        if (this.#clients.has(client)) scheduled += Math.max(0, held - immediate);
      }
    }
    return released(); // Never report future socket completion as released bytes.
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.reclaim(); } }
  #admit(bytes: number, mutate: () => boolean): boolean {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return false;
    try { return this.#options.runAdmitted(bytes, mutate) === true; } catch { this.#errors += 1; return false; }
  }
  #reserve(bytes: number, kind: string): ProcessMemoryReservation | null {
    try { const reservation = this.#options.processMemory.reserveTransient(bytes, { kind }); return reservation.admitted ? reservation : null; }
    catch { this.#errors += 1; return null; }
  }
  #notify(): void { try { this.#options.onOwnersChanged(); } catch { this.#errors += 1; } }
  #client(req: IncomingMessage, res: ServerResponse, stream: boolean, selection: Selection | null): Client {
    const client: Client = { req, res, stream, selection, pending: null, inflight: null, unsubscribe: null,
      timer: null, dirty: false, closed: false, writing: false, transportComplete: false, lastProjectedAtMs: 0,
      onClose: () => {}, onError: () => {}, onDrain: () => {}, onFinish: () => {} };
    client.onClose = () => { client.transportComplete = true; this.#stop(client, false); if (client.inflight) { client.inflight.writeComplete = true; client.inflight.drained = true; this.#settle(client); } this.#stop(client, false); };
    client.onError = () => { this.#errors += 1; this.#stop(client, true); };
    client.onDrain = () => { if (client.inflight) client.inflight.drained = true; this.#settle(client); };
    client.onFinish = () => { client.transportComplete = true; this.#stop(client, false); if (client.inflight) { client.inflight.writeComplete = true; client.inflight.drained = true; this.#settle(client); } this.#stop(client, false); };
    return client;
  }
  #attach(client: Client): void {
    client.req.once('aborted', client.onError); client.req.once('error', client.onError);
    client.res.once('close', client.onClose); client.res.once('error', client.onError); client.res.once('finish', client.onFinish);
  }
  #dirty(client: Client): void {
    if (client.closed || this.#closed) return;
    client.dirty = true;
    if (client.timer !== null) return;
    const delay = Math.max(0, client.lastProjectedAtMs + FOOTPRINT_TRANSPORT_LIMITS.cadenceMs - Date.now());
    client.timer = setTimeout(() => {
      client.timer = null;
      if (client.closed || !client.dirty) return;
      client.dirty = false; const failure = this.#publish(client);
      if (failure) this.#fail(client, failure, failure === 'projection-oversized' ? 413 : 503);
    }, delay);
    client.timer.unref?.(); this.#notify();
  }
  #publish(client: Client): Reason | null {
    const previous = this.#publishingClient;
    this.#publishingClient = client;
    try { return this.#publishWindow(client); }
    finally { this.#publishingClient = previous; this.#notify(); }
  }
  #publishWindow(client: Client): Reason | null {
    if (client.closed || !client.selection || !this.#options.store) return 'unavailable';
    const plan = this.#options.store.windowPlan(client.selection.options);
    if (!plan.complete || !Number.isSafeInteger(plan.workingBytesUpper) || plan.workingBytesUpper <= 0) return 'projection-unavailable';
    const staging = plan.workingBytesUpper + FOOTPRINT_FRAME_LIMITS.maxWireBytes * 8 + 65_536;
    if (!Number.isSafeInteger(staging)) return 'projection-unavailable';
    const physical = this.#reserve(staging, 'footprint-window-serialization');
    if (!physical) { this.#denied += 1; return 'physical-admission-denied'; }
    let owner: WireOwner | null = null, reason: Reason = 'logical-admission-denied';

    try {
      const admitted = this.#admit(staging, () => {
        if (client.closed || this.#closed || !this.#clients.has(client)) return false;
        this.#stagingBytes += staging;
        try {
          const result = this.#options.store!.project(client.selection!.options, plan.workingBytesUpper);
          if (!result.complete || !result.window) { reason = 'projection-unavailable'; return false; }
          const frame = { kind: 'footprint-snapshot', windowKey: client.selection!.windowKey, receivedAtMs: Date.now(), window: result.window };
          const bytes = jsonBytes(frame, FOOTPRINT_FRAME_LIMITS.maxWireBytes - (client.stream ? 33 : 0));
          if (bytes === null) { reason = 'projection-oversized'; return false; }
          const json = JSON.stringify(frame);
          if (Buffer.byteLength(json, 'utf8') !== bytes) { reason = 'projection-unavailable'; return false; }
          const text = client.stream ? 'event: footprint-snapshot\ndata: ' + json + '\n\n' : json;
          const wireBytes = Buffer.byteLength(text, 'utf8');
          const logicalBytes = wireLogicalBytes(text, wireBytes);
          // Keep projection/serialization workspace separate from queued wire
          // ownership: reclaim may release that wire reentrantly while these
          // local graph/string owners still need their physical peak reservation.
          const wirePhysical = this.#reserve(logicalBytes, 'footprint-wire-ownership');
          if (!wirePhysical) { reason = 'physical-admission-denied'; return false; }
          owner = { id: ++this.#nextWire, text, wireBytes, logicalBytes, physical: wirePhysical,
            terminal: !client.stream, status: 200, writeComplete: false, drained: true };
          const previous = client.pending; client.pending = owner;
          if (previous) { this.#coalesced += 1; previous.physical.release?.(); }
          client.lastProjectedAtMs = Date.now(); this.#projected += 1; this.#notify(); return true;
        } finally { this.#stagingBytes -= staging; }
      });
      if (!admitted || !owner) { this.#denied += 1; return reason; }
      const owned: WireOwner = owner;
      if (owned.physical.resize && owned.physical.resize(owned.logicalBytes).admitted !== true) { this.#denied += 1; return 'physical-admission-denied'; }
      this.#flush(client); return null;
    } finally {
      physical.release?.();
      this.#notify();
    }
  }
  #flush(client: Client): void {
    if (client.closed || client.writing || client.inflight || !client.pending) return;
    const owner = client.pending; client.pending = null; client.inflight = owner; client.writing = true; this.#notify();
    // onOwnersChanged may synchronously coordinate pressure. Never enter native
    // write after that callback retired this client or its transport.
    if (client.closed || (this.#closed && !owner.terminal) || client.res.destroyed || client.res.writableEnded || !this.#clients.has(client)) {
      owner.writeComplete = true; owner.drained = true; client.writing = false;
      this.#stop(client, true); this.#settle(client); return;
    }
    const id = owner.id;
    const complete = (error?: Error | null) => {
      const active = client.inflight; if (!active || active.id !== id) return;
      active.writeComplete = true;
      if (error) { this.#errors += 1; this.#stop(client, true); } else this.#settle(client);
    };
    try {
      if (!client.stream) {
        client.res.writeHead(owner.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': owner.wireBytes });
        client.res.end(owner.text, () => complete());
      } else {
        const writable = client.res.write(owner.text, 'utf8', complete);
        owner.drained = writable !== false;
        if (!owner.drained) client.res.once('drain', client.onDrain);
        if (owner.terminal) client.res.end();
      }
      this.#sent += 1;
    } catch { this.#errors += 1; this.#stop(client, true); }
    finally { client.writing = false; this.#settle(client); }
  }
  #settle(client: Client): void {
    const owner = client.inflight;
    if (client.writing || !owner || !owner.writeComplete || !owner.drained) return;
    client.inflight = null; owner.physical.release?.(); client.res.off('drain', client.onDrain); this.#notify();
    if (owner.terminal || client.closed) this.#stop(client, false); else this.#flush(client);
  }
  #stop(client: Client, destroy: boolean): void {
    if (!client.closed) {
      client.closed = true; client.dirty = false;
      if (client.timer !== null) clearTimeout(client.timer); client.timer = null;
      client.unsubscribe?.(); client.unsubscribe = null;
      client.pending?.physical.release?.(); client.pending = null;
      client.req.off('aborted', client.onError); client.req.off('error', client.onError); client.res.off('drain', client.onDrain);
    }
    if (destroy && !client.res.destroyed) client.res.destroy();
    if (!client.inflight && client.transportComplete) {
      client.res.off('close', client.onClose); client.res.off('error', client.onError); client.res.off('finish', client.onFinish);
      this.#clients.delete(client);
    }
    // A clean idle SSE termination keeps HTTP chunk framing complete. Preserve
    // its request/response/listener/control owners until finish/close confirms it.
    if (!destroy && !client.inflight && !client.res.writableEnded && !client.res.destroyed) {
      try { client.res.end(); } catch { if (!client.res.destroyed) client.res.destroy(); }
    }
    this.#notify();
  }
  #fail(client: Client, reason: Reason, status: number): void {
    if (client.closed) return;
    client.unsubscribe?.(); client.unsubscribe = null;
    if (client.timer !== null) clearTimeout(client.timer); client.timer = null; client.dirty = false;
    client.pending?.physical.release?.(); client.pending = null;
    if (client.inflight) { this.#stop(client, true); return; }
    if (!this.#errorOwner(client, reason, status)) this.#stop(client, true);
  }
  #errorOwner(client: Client, reason: Reason, status: number): boolean {
    const physical = this.#reserve(FOOTPRINT_TRANSPORT_LIMITS.errorWorkingBytes, 'footprint-unavailable');
    if (!physical) return false;
    let committed = false;
    try {
      if (!this.#admit(FOOTPRINT_TRANSPORT_LIMITS.errorWorkingBytes, () => {
        if (client.closed) return false;
        const body = errorBodies[reason], text = client.stream ? 'event: footprint-unavailable\ndata: ' + body + '\n\n' : body;
        const bytes = Buffer.byteLength(text, 'utf8');
        client.pending = { id: ++this.#nextWire, text, wireBytes: bytes, logicalBytes: wireLogicalBytes(text, bytes), physical,
          terminal: true, status, writeComplete: false, drained: true };
        committed = true; this.#notify(); return true;
      })) return false;
      if (client.closed || client.res.destroyed || client.res.writableEnded) return false;
      if (client.stream && !client.res.headersSent) client.res.writeHead(status, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      this.#flush(client); return true;
    } finally { if (!committed) physical.release?.(); }
  }
  #unavailable(req: IncomingMessage, res: ServerResponse, stream: boolean, reason: Reason, status: number): void {
    if (this.#clients.size >= FOOTPRINT_TRANSPORT_LIMITS.maxClients || res.destroyed || res.writableEnded) { res.destroy(); return; }
    const physical = this.#reserve(FOOTPRINT_TRANSPORT_LIMITS.clientControlBytes, 'footprint-unavailable-client');
    if (!physical) { res.destroy(); return; }
    let client: Client | null = null;
    try {
      if (!this.#admit(FOOTPRINT_TRANSPORT_LIMITS.clientControlBytes, () => {
        client = this.#client(req, res, stream, null); this.#clients.add(client); this.#attach(client); this.#notify(); return true;
      }) || !client) { res.destroy(); return; }
    } finally { physical.release?.(); }
    const active: Client = client;
    if (!this.#errorOwner(active, reason, status)) this.#stop(active, true);
  }
}
