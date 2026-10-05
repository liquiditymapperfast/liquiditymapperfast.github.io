import { AdapterTransportError } from '../adapters/common.mts';

interface RetirableSocket { close?: () => unknown; terminate?: () => unknown; }
interface OpeningSocket extends RetirableSocket {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

/** Retired subscriptions no longer own a protocol close handshake. */
export function retireLiveFeedSocket(socket: RetirableSocket | null | undefined): void {
  try { if (socket?.terminate) socket.terminate(); else socket?.close?.(); }
  catch { try { socket?.close?.(); } catch { /* retirement is best effort */ } }
}

/** ws's request timeout is an inactivity timeout; also bound elapsed opening time. */
export function waitForLiveFeedSocketOpen(socket: OpeningSocket, timeoutMs: number, onFailure: (cause: unknown) => void = () => {}): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('WebSocket handshake timeout must be a positive integer');
  // Error ownership remains until native close, including before a manager binds.
  const guardError = () => {};
  const releaseGuard = () => { socket.removeListener('error', guardError); };
  socket.on('error', guardError);
  socket.once('close', releaseGuard);
  const opened = new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => { clearTimeout(timer); socket.removeListener('open', open); socket.removeListener('error', error); socket.removeListener('close', close); };
    const open = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const error = (cause: unknown) => { if (settled) return; settled = true; cleanup(); try { onFailure(cause); } catch { /* preserve the opening error */ } reject(cause); };
    const close = () => error(new AdapterTransportError('WebSocket closed before opening'));
    const timer = setTimeout(() => {
      error(Object.assign(new AdapterTransportError('Opening handshake has timed out'), { code: 'LIVE_FEED_HANDSHAKE_TIMEOUT' }));
      retireLiveFeedSocket(socket);
    }, timeoutMs);
    socket.once('open', open); socket.once('error', error); socket.once('close', close);
  });
  void opened.catch(() => {});
  return opened;
}

interface OperationCancellation<T> { onCancel?: () => unknown; onLateValue?: (value: T) => unknown; }

/** Generation-owned waits settle on retirement; underlying requests retain their budgets. */
export class LiveFeedOperationScope {
  #cancelled = false;
  #waiters = new Set<() => void>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  get cancelled(): boolean { return this.#cancelled; }
  get pendingCallbacks(): readonly (() => void)[] { return [...this.#waiters]; }
  get pendingTimers(): readonly ReturnType<typeof setTimeout>[] { return [...this.#timers]; }
  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    for (const cancel of [...this.#waiters]) cancel();
    this.#waiters.clear();
  }
  wait<T>(operation: T | PromiseLike<T>, { onCancel, onLateValue }: OperationCancellation<T> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false, cancelled = false;
      const cancel = () => {
        if (settled) return;
        settled = true; cancelled = true; this.#waiters.delete(cancel);
        try { onCancel?.(); } catch { /* preserve retirement */ }
        reject(new AdapterTransportError('Live feed configuration retired'));
      };
      Promise.resolve(operation).then(value => {
        if (settled) { if (cancelled) { try { onLateValue?.(value); } catch { /* late ownership is best effort */ } } return; }
        settled = true; this.#waiters.delete(cancel); resolve(value);
      }, error => {
        if (settled) return;
        settled = true; this.#waiters.delete(cancel); reject(error);
      });
      if (this.#cancelled) cancel(); else this.#waiters.add(cancel);
    });
  }
  delay(delayMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    const pending = new Promise<void>(resolve => { timer = setTimeout(() => { this.#timers.delete(timer); resolve(); }, delayMs); });
    this.#timers.add(timer!);
    return this.wait(pending, { onCancel: () => { clearTimeout(timer); this.#timers.delete(timer); } });
  }
}
