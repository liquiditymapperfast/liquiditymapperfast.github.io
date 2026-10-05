import { type AdapterOptions, type AdapterDepthBook, type DepthSessionIdentity, type DepthSessionMessageOptions, type DepthSessionResult } from './common.mts';
import type { BybitDepthMessage } from './bybit.mts';
export interface BybitDepthSession extends DepthSessionIdentity { book: AdapterDepthBook | null; }
import { applyBybitDepthUpdate, invalidateBybitDepthState } from './bybit.mts';

/** Create an inert, in-memory Bybit depth session. No transport or I/O is performed. */
export function createBybitDepthSession({ topic, instrumentId, sessionToken }: AdapterOptions): BybitDepthSession {
  if (!topic || !instrumentId || !sessionToken) throw new TypeError('Bybit depth session topic, instrument, and token are required');
  return { topic: String(topic), instrumentId: String(instrumentId), sessionToken: String(sessionToken), status: 'awaiting-snapshot', book: null, invalidated: false };
}

/** Apply a packet only when its topic/session/instrument match this controller. */
export function applyBybitDepthSessionMessage(session: BybitDepthSession, { topic, sessionToken, update }: DepthSessionMessageOptions<BybitDepthMessage> = {}): DepthSessionResult<BybitDepthSession> {
  if (!session || !update) throw new TypeError('Bybit depth session and update are required');
  if (topic !== session.topic) return { session, accepted: false, ignored: true, reason: 'wrong-topic' };
  if (sessionToken !== session.sessionToken) return { session, accepted: false, ignored: true, reason: 'cross-session' };
  if (update.instrumentId !== session.instrumentId) return { session, accepted: false, ignored: true, reason: 'wrong-instrument' };
  if (update.kind === 'depthDelta' && (!session.book || session.status !== 'live' || session.invalidated)) return { session, accepted: false, ignored: true, reason: 'fresh-snapshot-required' };
  const nextBook = update.kind === 'depthSnapshot' ? applyBybitDepthUpdate(session.book ?? update, update) : applyBybitDepthUpdate(session.book!, update);
  if (nextBook.ignored) return { session, accepted: false, ignored: true, reason: 'old-or-duplicate' };
  if (nextBook.resyncRequired) return { session: { ...session, book: nextBook, status: 'resync-required', invalidated: true }, accepted: false, ignored: false, reason: 'resync-required' };
  return { session: { ...session, book: nextBook, status: 'live', invalidated: false }, accepted: true, ignored: false, reason: null };
}

/** Invalidate the current session on disconnect; only a fresh snapshot can restore it. */
export function invalidateBybitDepthSession(session: BybitDepthSession, reason: string = 'disconnect'): BybitDepthSession {
  if (!session) throw new TypeError('Bybit depth session is required');
  const book = session.book ? invalidateBybitDepthState(session.book, reason) : null;
  return { ...session, book, status: 'resync-required', invalidated: true, invalidReason: String(reason) };
}
