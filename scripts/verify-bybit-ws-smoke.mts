import { smokeRecord, smokeFrameText } from './smoke-boundaries.mts';
import WebSocket from 'ws';
import {
  BYBIT_LINEAR_WS_URL,
  buildBybitSubscription,
  normalizeBybitDepth,
} from '../src/adapters/bybit.mts';

interface BybitWireObservation {
  op: unknown;
  type: unknown;
  topic: unknown;
  success: unknown;
}
interface BybitSnapshotResult {
  acknowledged: boolean;
  topic: string;
  type: 'snapshot';
  sequence: ReturnType<typeof normalizeBybitDepth>['sequence'];
  bids: number;
  asks: number;
  coverage: ReturnType<typeof normalizeBybitDepth>['coverage'];
  sourceTimestamp: number;
  closeRequestedByScript: true;
  timedOutWaitingForAck?: boolean;
}
interface BybitWsSmokeResult extends BybitSnapshotResult {
  closeObserved: boolean;
  closeCode: number | null;
  closeReason: string;
}

const timeoutMs = 15_000;
const subscription = buildBybitSubscription('depth', { symbol: 'BTCUSDT' });
const startedAt = Date.now();
const observed: BybitWireObservation[] = [];

const result = await new Promise<BybitWsSmokeResult>((resolve, reject) => {
  const socket = new WebSocket(BYBIT_LINEAR_WS_URL);
  let acknowledged = false;
  let snapshotResult: BybitSnapshotResult | null = null;
  let settled = false;
  let closing = false;
  let closeWaitTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => {
    if (snapshotResult) finish(null, { ...snapshotResult, acknowledged, timedOutWaitingForAck: !acknowledged });
    else finish(new Error(`Bybit WebSocket smoke timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  function finish(error: unknown, value?: BybitSnapshotResult) {
    if (settled || closing) return;
    closing = true;
    clearTimeout(timer);
    const complete = (closeCode: number | null = null, closeReason = '', closeObserved = false) => {
      if (settled) return;
      settled = true;
      if (closeWaitTimer !== null) clearTimeout(closeWaitTimer);
      if (error) reject(error);
      else if (value) resolve({ ...value, closeObserved, closeCode, closeReason });
      else reject(new Error('Bybit WebSocket smoke completed without a snapshot'));
    };
    socket.once('close', (code: unknown, reason: unknown) => complete(
      typeof code === 'number' && Number.isInteger(code) ? code : null,
      smokeFrameText(reason ?? ''), true,
    ));
    closeWaitTimer = setTimeout(() => complete(null, 'close event timeout', false), 2_000);
    try { socket.close(); } catch { complete(null, 'close threw', false); }
    if (socket.readyState === WebSocket.CLOSED) {
      const code = smokeRecord(socket).closeCode;
      complete(typeof code === 'number' && Number.isInteger(code) ? code : null, 'already closed', false);
    }
  }

  socket.once('open', () => {
    socket.send(JSON.stringify({ op: subscription.method, args: subscription.args }));
  });
  socket.on('message', raw => {
    try {
      const decoded: unknown = JSON.parse(smokeFrameText(raw));
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new TypeError('Bybit WebSocket frame must be an object');
      const payload = smokeRecord(decoded);
      observed.push({ op: payload.op, type: payload.type, topic: payload.topic, success: payload.success });
      if (payload.op === 'subscribe' && payload.success === true) acknowledged = true;
      if (payload.topic === subscription.topic && payload.type === 'snapshot') {
        const normalized = normalizeBybitDepth(payload, { receivedAt: Date.now() });
        snapshotResult = {
          acknowledged,
          topic: payload.topic,
          type: payload.type,
          sequence: normalized.sequence,
          bids: normalized.bids.length,
          asks: normalized.asks.length,
          coverage: normalized.coverage,
          sourceTimestamp: normalized.sourceTimestamp,
          closeRequestedByScript: true,
        };
        if (acknowledged) finish(null, snapshotResult);
        else setTimeout(() => {
          if (!acknowledged && snapshotResult) finish(null, { ...snapshotResult, acknowledged: false, timedOutWaitingForAck: true });
        }, 2_000);
      }
      if (acknowledged && snapshotResult) finish(null, { ...snapshotResult, acknowledged: true });
    } catch (error) { finish(error); }
  });
  socket.once('error', error => finish(error));
  socket.once('close', (code: unknown, reason: unknown) => {
    if (!settled) finish(new Error(`Bybit WebSocket closed before snapshot: ${code} ${reason}`));
  });
});

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  elapsedMs: Date.now() - startedAt,
  url: BYBIT_LINEAR_WS_URL,
  subscription: subscription.args,
  observed,
  messageCounts: {
    subscribeAcks: observed.filter(message => message.op === 'subscribe' && message.success === true).length,
    snapshots: observed.filter(message => message.topic === subscription.topic && message.type === 'snapshot').length,
    deltas: observed.filter(message => message.topic === subscription.topic && message.type === 'delta').length,
  },
  result,
}, null, 2));