/**
 * Keep the screen on. A phone puts its screen to sleep after a minute, and a page that is asleep records nothing (the map has a gap where
 * it was). The Screen Wake Lock API holds the screen on while the page is open; the browser lets it go whenever the page is hidden, so it
 * is asked for again each time the page comes back. Where the browser has no such thing (or refuses it, as battery saver does), nothing happens.
 */
export const wakeLockSupported = (): boolean => typeof navigator !== 'undefined' && 'wakeLock' in navigator;

export class ScreenWake {
  #sentinel: WakeLockSentinel | null = null;
  #wanted = false;

  constructor() {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (this.#wanted && document.visibilityState === 'visible') void this.#acquire(); });
  }

  /** Hold the screen on (or let it sleep again). */
  set(on: boolean): void {
    this.#wanted = on;
    if (on) void this.#acquire(); else void this.#release();
  }

  async #acquire(): Promise<void> {
    if (!wakeLockSupported() || this.#sentinel) return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (!this.#wanted) { void sentinel.release().catch(() => {}); return; }
      this.#sentinel = sentinel;
      sentinel.addEventListener('release', () => { if (this.#sentinel === sentinel) this.#sentinel = null; });
    } catch { /* refused (battery saver, or the page was not visible): it is asked for again when the page next shows */ }
  }

  async #release(): Promise<void> {
    const sentinel = this.#sentinel; this.#sentinel = null;
    try { await sentinel?.release(); } catch { /* already released */ }
  }
}
