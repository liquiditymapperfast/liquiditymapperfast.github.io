/**
 * A request to the Plus server given up after `REQUEST_TIMEOUT_MS` in every browser (`design.md` 6.5, 2026-11-20): `AbortSignal.timeout`
 * is missing in some that the page supports, so the signal is an `AbortController` aborted by a timer, which is cleared as soon as the request
 * settles. A caller's own signal (a form closed) aborts it too, through a listener removed at the same time; one already aborted aborts it at
 * once. A request given up this way is a lost answer: the server may still have processed it.
 */

export const REQUEST_TIMEOUT_MS = 20_000;

/** Runs `request` with a signal that aborts after `ms` (a `TimeoutError`) or when `given` aborts (its reason), whichever comes first. */
export async function withTimeout<T>(request: (signal: AbortSignal) => Promise<T>, given?: AbortSignal, ms: number = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const onAbort = (): void => { controller.abort(given?.reason); };
  if (given?.aborted) controller.abort(given.reason);
  else given?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { controller.abort(new DOMException('the Plus server did not answer in time', 'TimeoutError')); }, ms);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timer);
    given?.removeEventListener('abort', onAbort);
  }
}
