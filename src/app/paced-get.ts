import type { Fetcher } from '../shared/history.ts';

/**
 * The exchanges' candle histories asked through one queue per host (2026-11-10: VWAPs over several markets ask many histories at once):
 * at most `perHost` requests out to one host at a time, and after an answer that says too many requests (HTTP 429 or 418, or a venue's
 * own code for it inside a 200: Bybit's retCode 10006 and 10018, OKX's code 50011 and 50061, Bitget's 429) that host is asked nothing for
 * a while, twice as long each time it says so again (10 s, then 20, up to 2 min), and back to the shortest after a request that went
 * through. A request waits its turn and then goes as it would have; one refused fails as before, and the history that asked tries again later.
 */
export interface PacingOptions { perHost?: number; cooldownMs?: number; maxCooldownMs?: number; now?: () => number }

interface Host { running: number; waiting: (() => void)[]; until: number; strikes: number; timer: ReturnType<typeof setTimeout> | null }

const LIMIT_CODES: ReadonlySet<unknown> = new Set([10006, 10018, '50011', '50061', '429']);

/** Whether an answer or an error is a venue saying it was asked too often. */
export function saysTooMany(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { status?: unknown; retCode?: unknown; code?: unknown };
  return v.status === 429 || v.status === 418 || LIMIT_CODES.has(v.retCode) || LIMIT_CODES.has(v.code);
}

export function pacedFetcher(get: Fetcher, o: PacingOptions = {}): Fetcher {
  const perHost = o.perHost ?? 3, cooldown = o.cooldownMs ?? 10_000, longest = o.maxCooldownMs ?? 120_000, now = o.now ?? Date.now;
  const hosts = new Map<string, Host>();
  const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return url; } };
  // A host waits out its cooldown only while something waits for it.
  const next = (h: Host): void => {
    if (h.timer !== null || !h.waiting.length) return;
    const wait = h.until - now();
    if (wait > 0) { h.timer = setTimeout(() => { h.timer = null; next(h); }, wait); return; }
    while (h.running < perHost && h.waiting.length) { h.running++; h.waiting.shift()!(); }
  };
  const strike = (h: Host): void => { h.strikes++; h.until = Math.max(h.until, now() + Math.min(longest, cooldown * 2 ** (h.strikes - 1))); };
  return async (url, init) => {
    const key = hostOf(url);
    let found = hosts.get(key);
    if (!found) { found = { running: 0, waiting: [], until: 0, strikes: 0, timer: null }; hosts.set(key, found); }
    const h = found, signal = init?.signal;
    const aborted = (): unknown => signal?.reason ?? new DOMException('The request was aborted', 'AbortError');
    if (signal?.aborted) throw aborted();
    // A request given up while it waits its turn leaves the queue at once (Sol, code review 2026-11-10), and a cooldown with nothing left
    // waiting stops its timer.
    await new Promise<void>((resolve, reject) => {
      const go = (): void => { signal?.removeEventListener('abort', drop); resolve(); };
      const drop = (): void => {
        const i = h.waiting.indexOf(go); if (i >= 0) h.waiting.splice(i, 1);
        if (!h.waiting.length && h.timer !== null) { clearTimeout(h.timer); h.timer = null; }
        reject(aborted());
      };
      h.waiting.push(go); signal?.addEventListener('abort', drop, { once: true }); next(h);
    });
    try {
      const answer = await get(url, init);
      if (saysTooMany(answer)) strike(h); else h.strikes = 0;
      return answer;
    } catch (error) {
      if (saysTooMany(error)) strike(h);
      throw error;
    } finally { h.running--; next(h); }
  };
}
