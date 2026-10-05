export interface RestRequest { method?: unknown; url?: unknown; body?: unknown; [key: string]: unknown }
export interface RestRetryPolicy { maxAttempts: number; maxAttemptsPerWindow: number; windowMs: number; baseDelayMs: number; maxDelayMs: number; jitterRatio: number }
export interface RestAttemptContext { venue: string; key: string; attempt: number }
export interface RestRetryErrorFields { retryable?: unknown; status?: unknown; statusCode?: unknown; retryAfterMs?: unknown; code?: unknown; providerRequestStarted?: unknown }
export interface RestBudgetWindow { startedAt: number; attempts: number }
export interface RestCoordinatorOptions<T> {
  transport?: (request: RestRequest, context?: RestAttemptContext) => T | PromiseLike<T>;
  policies?: Record<string, Partial<RestRetryPolicy>>;
  random?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  now?: () => number;
  onAttempt?: (info: RestAttemptContext & { budget: number }) => unknown;
}

/**
 * Bounded public REST coordinator.
 *
 * It deliberately sits below the feed manager: callers share an in-flight
 * request by key, transient failures use bounded venue-specific retry budgets,
 * and a caller never has to guess whether a retry will spend another request.
 */
export const DEFAULT_REST_POLICIES: Readonly<Record<string, Readonly<RestRetryPolicy>>> = Object.freeze({
  hyperliquid: Object.freeze({ maxAttempts: 3, maxAttemptsPerWindow: 12, windowMs: 60_000, baseDelayMs: 250, maxDelayMs: 4_000, jitterRatio: .2 }),
  binance: Object.freeze({ maxAttempts: 3, maxAttemptsPerWindow: 12, windowMs: 60_000, baseDelayMs: 250, maxDelayMs: 4_000, jitterRatio: .2 }),
  bybit: Object.freeze({ maxAttempts: 3, maxAttemptsPerWindow: 12, windowMs: 60_000, baseDelayMs: 250, maxDelayMs: 4_000, jitterRatio: .2 }),
  okx: Object.freeze({ maxAttempts: 3, maxAttemptsPerWindow: 12, windowMs: 60_000, baseDelayMs: 250, maxDelayMs: 4_000, jitterRatio: .2 }),
  bitget: Object.freeze({ maxAttempts: 3, maxAttemptsPerWindow: 12, windowMs: 60_000, baseDelayMs: 250, maxDelayMs: 4_000, jitterRatio: .2 }),
  default: Object.freeze({ maxAttempts: 2, maxAttemptsPerWindow: 8, windowMs: 60_000, baseDelayMs: 250, maxDelayMs: 2_000, jitterRatio: .2 }),
});

export class RestBudgetError extends Error {
  declare code: string; declare venue: string; declare policy: RestRetryPolicy; declare retryable: boolean;
  constructor(venue: string, policy: RestRetryPolicy) {
    super(`${venue} REST retry budget exhausted`);
    this.name = 'RestBudgetError';
    this.code = 'REST_BUDGET_EXHAUSTED';
    this.venue = venue;
    this.policy = { ...policy };
    this.retryable = false;
  }
}

export function restRequestKey(request: RestRequest | null | undefined, venue: unknown = 'default') {
  return `${String(venue)}|${String(request?.method ?? 'GET')}|${String(request?.url ?? '')}|${String(request?.body ?? '')}`;
}

function policyFor(policies: Record<string, Partial<RestRetryPolicy>>, venue: string): RestRetryPolicy {
  const selected = policies?.[venue] ?? policies?.default ?? DEFAULT_REST_POLICIES.default;
  return {
    ...DEFAULT_REST_POLICIES.default,
    ...(DEFAULT_REST_POLICIES[venue] ?? {}),
    ...(selected ?? {}),
    maxAttempts: Math.max(1, Math.trunc(Number(selected?.maxAttempts ?? DEFAULT_REST_POLICIES[venue]?.maxAttempts ?? 2))),
    maxAttemptsPerWindow: Math.max(1, Math.trunc(Number(selected?.maxAttemptsPerWindow ?? DEFAULT_REST_POLICIES[venue]?.maxAttemptsPerWindow ?? 8))),
    windowMs: Math.max(1, Number(selected?.windowMs ?? DEFAULT_REST_POLICIES[venue]?.windowMs ?? 60_000)),
  };
}

function retryable(cause: unknown) {
  const error = cause as RestRetryErrorFields | null | undefined;
  if (error?.retryable != null) return error.retryable === true;
  const status = Number(error?.status ?? error?.statusCode);
  if (!Number.isFinite(status)) return true; // network/timeout failures
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delayFor(attempt: number, policy: RestRetryPolicy, random: (() => number) | null | undefined, cause: unknown) {
  const error = cause as RestRetryErrorFields | null | undefined;
  const retryAfter = Number(error?.retryAfterMs);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(policy.maxDelayMs, Math.round(retryAfter));
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const ratio = Math.max(0, Number(policy.jitterRatio) || 0);
  const sample = Math.max(0, Math.min(1, Number(random?.() ?? Math.random())));
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(exponential + exponential * ratio * ((sample * 2) - 1))));
}

function wait(schedule: (callback: () => void, delay: number) => unknown, delay: number) {
  return new Promise<void>(resolve => { schedule(resolve, delay); });
}

/**
 * @param {{transport:(request:object, context?:object)=>Promise<unknown>, policies?:object, random?:()=>number, schedule?:(fn:Function,delay:number)=>unknown, now?:()=>number, onAttempt?:(info:object)=>void}} options
 */
export function createRestRequestCoordinator<T = unknown>({ transport, policies = DEFAULT_REST_POLICIES, random = Math.random, schedule = (fn, delay) => setTimeout(fn, delay), now = () => Date.now(), onAttempt = () => {} }: RestCoordinatorOptions<T> = {}) {
  if (typeof transport !== 'function') throw new TypeError('REST transport is required');
  const flights = new Map<string, { request: RestRequest; promise: Promise<T> | null }>();
  const windows = new Map<string, RestBudgetWindow>();

  function consume(venue: string, policy: RestRetryPolicy) {
    const current = windows.get(venue);
    const at = now();
    const window = !current || at - current.startedAt >= policy.windowMs ? { startedAt: at, attempts: 0 } : current;
    if (window.attempts >= policy.maxAttemptsPerWindow) return null;
    window.attempts += 1;
    windows.set(venue, window);
    return window;
  }

  function refund(venue: string, window: RestBudgetWindow) {
    if (windows.get(venue) !== window || window.attempts <= 0) return;
    window.attempts -= 1;
  }

  async function run(request: RestRequest, venue: string, key: string): Promise<T> {
    const policy = policyFor(policies, venue);
    let lastError;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      const spentWindow = consume(venue, policy);
      if (!spentWindow) throw new RestBudgetError(venue, policy);
      onAttempt({ venue, key, attempt, budget: policy.maxAttemptsPerWindow });
      try {
        return await transport!(request, { venue, key, attempt });
      } catch (error) {
        lastError = error;
        // A local process-memory admission failure happens before fetch, so it
        // must not consume the provider's request-rate budget or retry count.
        if ((error as RestRetryErrorFields | null | undefined)?.code === 'PROCESS_MEMORY_LIMIT' && (error as RestRetryErrorFields).providerRequestStarted === false) {
          refund(venue, spentWindow);
          throw error;
        }
        if (attempt >= policy.maxAttempts || !retryable(error)) throw error;
        await wait(schedule, delayFor(attempt, policy, random, error));
      }
    }
    throw lastError ?? new Error('REST request failed');
  }

  function request(request: RestRequest, { venue = 'default', key = restRequestKey(request, venue) }: { venue?: string; key?: string } = {}): Promise<T> {
    const flightKey = `${venue}|${key}`;
    const existing = flights.get(flightKey);
    if (existing) return existing.promise!;
    const flight: { request: RestRequest; promise: Promise<T> | null } = { request, promise: null };
    const pending = run(request, venue, key).finally(() => { if (flights.get(flightKey) === flight) flights.delete(flightKey); });
    flight.promise = pending;
    flights.set(flightKey, flight);
    return pending;
  }

  return Object.freeze({
    request,
    clear() { flights.clear(); windows.clear(); },
    get inFlight() { return flights.size; },
    retainedSnapshot() {
      return {
        inFlightKeys: [...flights.keys()],
        inFlightRequests: [...flights.values()].map(({ request: pendingRequest }) => pendingRequest),
        budgetWindows: windows,
      };
    },
    budgetSnapshot() { return Object.fromEntries([...windows].map(([venue, value]) => [venue, { ...value }])); },
  });
}
