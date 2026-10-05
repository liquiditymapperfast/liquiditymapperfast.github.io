import { BoundedJsonResponseError, DEFAULT_BOUNDED_JSON_RESPONSE_BYTES, DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS, DEFAULT_BOUNDED_JSON_RESPONSE_CHUNK_OVERHEAD_BYTES, DEFAULT_BOUNDED_JSON_RESPONSE_TOKENS, DEFAULT_BOUNDED_JSON_TOKEN_MEMORY_BYTES, readBoundedJsonResponse } from '../core/bounded-json-response.mts';
import type { ProcessMemoryReservation } from './process-memory.mts';
import type { BoundedJsonResponse } from '../core/bounded-json-response.mts';
export interface ExchangeRestRequest { url: string; method?: string; headers?: HeadersInit; body?: BodyInit | null; responseClass?: string; }
export interface ExchangeRestResponse extends BoundedJsonResponse { ok: boolean; status: number; body?: (NonNullable<BoundedJsonResponse['body']> & { cancel?: () => unknown }) | null; }
export interface ExchangeRestTransportOptions {
  fetchImpl?: (url: string, init: RequestInit) => PromiseLike<ExchangeRestResponse>;
  timeoutMs?: unknown; memoryAdmissionWaitMs?: unknown; maxMemoryAdmissionWaiters?: unknown;
  reserveTransientMemory?: ((bytes: number, context: Record<string, unknown>) => ProcessMemoryReservation) | null;
}
interface MemoryWaiter { bytes: number; context: Record<string, unknown>; resolve: (reservation: ProcessMemoryReservation) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> | null; settled: boolean; }
class ExchangeRestMemoryError extends BoundedJsonResponseError {
  declare admission?: unknown; declare admissionWaiters?: number; declare admissionFailure?: string | null;
  declare providerRequestStarted?: boolean; declare parseReservationBytes?: number;
}
class ExchangeRestHttpError extends Error { declare status: number; declare retryable: boolean; declare retryAfterMs?: number; }
type ReservationAttempt = { admitted: true; reservation: ProcessMemoryReservation } | { admitted: false; waitable: boolean; error: ExchangeRestMemoryError };

export const MAX_EXCHANGE_REST_RESPONSE_BYTES = DEFAULT_BOUNDED_JSON_RESPONSE_BYTES;
export const MAX_EXCHANGE_REST_CATALOG_RESPONSE_BYTES = 16_777_216;
export const EXCHANGE_REST_RESPONSE_MEMORY_MULTIPLIER = 2;
export const EXCHANGE_REST_RESPONSE_CHUNK_OVERHEAD_BYTES = DEFAULT_BOUNDED_JSON_RESPONSE_CHUNK_OVERHEAD_BYTES;
export const EXCHANGE_REST_JSON_TOKEN_MEMORY_BYTES = DEFAULT_BOUNDED_JSON_TOKEN_MEMORY_BYTES;
export const MAX_EXCHANGE_REST_MEMORY_ADMISSION_WAITERS = 32;
// A logical allowance for each queued waiter shell (callbacks, Promise, timer,
// and its small request descriptor). This is a retained-state budget, not a
// measurement of V8 or native process memory.
export const EXCHANGE_REST_MEMORY_ADMISSION_WAITER_LOGICAL_BYTES = 4_096;

async function cancelResponseBody(response: ExchangeRestResponse) {
  try { await response?.body?.cancel?.(); } catch { /* preserve the HTTP status error */ }
}

export function createExchangeRestTransport({
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  reserveTransientMemory = null,
  memoryAdmissionWaitMs,
  maxMemoryAdmissionWaiters = 32,
}: ExchangeRestTransportOptions = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Exchange REST transport requires fetch');
  const parsedTimeout = Number(timeoutMs);
  const requestTimeoutMs = Number.isFinite(parsedTimeout) ? Math.max(1_000, Math.trunc(parsedTimeout)) : 12_000;
  const parsedAdmissionWaitMs = Number(memoryAdmissionWaitMs);
  const admissionWaitMs = Number.isFinite(parsedAdmissionWaitMs)
    ? Math.max(0, Math.trunc(parsedAdmissionWaitMs))
    : requestTimeoutMs * 2;
  const parsedWaiterLimit = Number(maxMemoryAdmissionWaiters);
  const memoryAdmissionWaiterLimit = Number.isSafeInteger(parsedWaiterLimit) && parsedWaiterLimit > 0
    ? Math.min(MAX_EXCHANGE_REST_MEMORY_ADMISSION_WAITERS, parsedWaiterLimit)
    : MAX_EXCHANGE_REST_MEMORY_ADMISSION_WAITERS;
  let activeReservations = 0;
  let drainingWaiters = false;
  const memoryWaiters: MemoryWaiter[] = [];

  function processMemoryLimitError(admission: unknown, cause?: unknown, reason: string | null = null) {
    const error = new ExchangeRestMemoryError(
      reason === 'memory-admission-timeout'
        ? 'Timed out waiting for process-memory headroom before Exchange REST request'
        : 'Exchange REST response exceeds available process-memory headroom',
      'PROCESS_MEMORY_LIMIT',
      { cause, retryable: false },
    );
    error.admission = admission ?? null;
    error.admissionWaiters = memoryWaiters.length;
    error.admissionFailure = reason;
    error.providerRequestStarted = false;
    return error;
  }

  function attemptReservation(bytes: number, context: Record<string, unknown>): ReservationAttempt {
    let admission;
    try {
      if (typeof reserveTransientMemory !== 'function') throw new TypeError('Transient memory reservation is unavailable');
      admission = reserveTransientMemory(bytes, context);
    } catch (cause) {
      return { admitted: false, waitable: false, error: processMemoryLimitError(null, cause) };
    }
    if (admission?.admitted !== true || typeof admission.release !== 'function') {
      const reason = admission?.reason;
      const waitable = activeReservations > 0
        && (reason === 'physical-rss-reservation-hard-limit' || reason === 'physical-rss-hard-limit');
      return { admitted: false, waitable, error: processMemoryLimitError(admission) };
    }

    const admitted = admission as ProcessMemoryReservation & { release: () => number };
    activeReservations += 1;
    let released = false;
    return {
      admitted: true,
      reservation: {
        ...admission,
        release() {
          if (released) return 0;
          released = true;
          let result = 0;
          try { result = admitted.release(); }
          finally {
            activeReservations = Math.max(0, activeReservations - 1);
            drainMemoryWaiters();
          }
          return result;
        },
      },
    };
  }

  function clearWaiter(waiter: MemoryWaiter) {
    waiter.settled = true;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.timer = null;
  }

  function drainMemoryWaiters() {
    if (drainingWaiters || typeof reserveTransientMemory !== 'function') return;
    drainingWaiters = true;
    try {
      while (memoryWaiters.length > 0) {
        const waiter = memoryWaiters[0];
        if (waiter.settled) {
          memoryWaiters.shift();
          continue;
        }
        const attempt = attemptReservation(waiter.bytes, waiter.context);
        if (attempt.admitted) {
          memoryWaiters.shift();
          clearWaiter(waiter);
          waiter.resolve(attempt.reservation);
          continue;
        }
        if (attempt.waitable && activeReservations > 0) break;
        memoryWaiters.shift();
        clearWaiter(waiter);
        waiter.reject(attempt.error);
      }
    } finally {
      drainingWaiters = false;
    }
  }

  function enqueueMemoryWaiter(bytes: number, context: Record<string, unknown>, initialError: ExchangeRestMemoryError | null): Promise<ProcessMemoryReservation> {
    return new Promise<ProcessMemoryReservation>((resolve, reject) => {
      if (memoryWaiters.length >= memoryAdmissionWaiterLimit) {
        const error = processMemoryLimitError(initialError?.admission, null, 'memory-admission-queue-full');
        error.admissionWaiters = memoryWaiters.length;
        reject(error);
        return;
      }
      const waiter: MemoryWaiter = { bytes, context, resolve, reject, timer: null, settled: false };
      waiter.timer = setTimeout(() => {
        const index = memoryWaiters.indexOf(waiter);
        if (index < 0 || waiter.settled) return;
        memoryWaiters.splice(index, 1);
        clearWaiter(waiter);
        const error = processMemoryLimitError(initialError?.admission, null, 'memory-admission-timeout');
        error.admissionWaiters = memoryWaiters.length;
        reject(error);
        drainMemoryWaiters();
      }, admissionWaitMs);
      memoryWaiters.push(waiter);
    });
  }

  function acquireTransientMemory(bytes: number, context: Record<string, unknown>): Promise<ProcessMemoryReservation | null> {
    if (typeof reserveTransientMemory !== 'function') return Promise.resolve(null);
    if (memoryWaiters.length > 0) {
      if (admissionWaitMs === 0) return Promise.reject(processMemoryLimitError(null, null, 'memory-admission-disabled'));
      return enqueueMemoryWaiter(bytes, context, null);
    }
    const attempt = attemptReservation(bytes, context);
    if (attempt.admitted) return Promise.resolve(attempt.reservation);
    if (!attempt.waitable || activeReservations === 0) return Promise.reject(attempt.error);
    if (admissionWaitMs === 0) return Promise.reject(processMemoryLimitError(attempt.error.admission, null, 'memory-admission-disabled'));
    return enqueueMemoryWaiter(bytes, context, attempt.error);
  }

  function retainedSnapshot() {
    const memoryAdmissionWaiters = memoryWaiters.reduce((count, waiter) => count + (waiter.settled ? 0 : 1), 0);
    return Object.freeze({
      measurementAvailable: true,
      memoryAdmissionWaiters,
      memoryAdmissionWaiterLimit,
      memoryAdmissionWaiterAllowanceBytes: EXCHANGE_REST_MEMORY_ADMISSION_WAITER_LOGICAL_BYTES,
      memoryAdmissionWaiterLogicalBytes: memoryAdmissionWaiters * EXCHANGE_REST_MEMORY_ADMISSION_WAITER_LOGICAL_BYTES,
    });
  }

  return Object.freeze({
    retainedSnapshot,
    async request(request: ExchangeRestRequest): Promise<unknown> {
      const responseClass = request.responseClass === 'catalog' ? 'catalog' : 'standard';
      const maxBytes = responseClass === 'catalog'
        ? MAX_EXCHANGE_REST_CATALOG_RESPONSE_BYTES
        : MAX_EXCHANGE_REST_RESPONSE_BYTES;
      const maximumTextParts = DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS + 1;
      const reservationBytes = (maxBytes * EXCHANGE_REST_RESPONSE_MEMORY_MULTIPLIER)
        + maximumTextParts * EXCHANGE_REST_RESPONSE_CHUNK_OVERHEAD_BYTES;
      const reservation = await acquireTransientMemory(reservationBytes, {
        kind: 'exchange-rest-json-response',
        responseClass,
        maximumBodyBytes: maxBytes,
      });
      try {
        const response = await fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        if (!response.ok) {
          const error = new ExchangeRestHttpError('HTTP ' + response.status);
          error.status = response.status;
          error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
          const retryAfter = response.headers?.get?.('retry-after');
          if (retryAfter != null) {
            const seconds = Number(retryAfter);
            if (Number.isFinite(seconds)) error.retryAfterMs = seconds * 1_000;
          }
          await cancelResponseBody(response);
          throw error;
        }
        return await readBoundedJsonResponse(response, {
          maxBytes,
          maxChunks: DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS,
          maxJsonTokens: DEFAULT_BOUNDED_JSON_RESPONSE_TOKENS,
          label: 'Exchange REST',
          onBeforeParse: reservation === null ? null : ({ bodyBytes, textPartCount, jsonTokens }) => {
            if (typeof reservation.resize !== 'function') {
              const error = processMemoryLimitError(reservation, null, 'parse-reservation-unavailable');
              error.providerRequestStarted = true;
              throw error;
            }
            const parseReservationBytes = (bodyBytes * EXCHANGE_REST_RESPONSE_MEMORY_MULTIPLIER)
              + (textPartCount * EXCHANGE_REST_RESPONSE_CHUNK_OVERHEAD_BYTES)
              + (jsonTokens * EXCHANGE_REST_JSON_TOKEN_MEMORY_BYTES);
            const resized = reservation.resize(parseReservationBytes);
            if (resized?.admitted !== true) {
              const error = processMemoryLimitError(resized, null, 'parse-reservation-rejected');
              error.parseReservationBytes = parseReservationBytes;
              error.providerRequestStarted = true;
              throw error;
            }
          },
        });
      } finally {
        reservation?.release?.();
      }
    },
  });
}
