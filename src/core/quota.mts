export interface QuotaRequest { at: number; cost: number; label: string; [key: string]: string | number | boolean }
export interface QuotaState { day: string; used: number; requests: QuotaRequest[] }
export type QuotaRetainedAdmission = (state: QuotaState, commit: () => boolean, reject: () => void) => unknown;
export type QuotaSpendRejection = 'invalid-request' | 'request-history-capacity' | 'token-budget' | 'retained-budget' | 'clock-regression' | 'automatic-budget';
export interface QuotaRamBudget {
  logicalBytes: number; requests: number; maximumRequests: number; serializedBytes: number;
  maximumSerializedBytes: number; entryOverheadBytes: number; accounting: 'bounded-json-bytes-plus-entry-overhead';
}
export interface QuotaLedgerOptions { limit?: unknown; state?: unknown; filePath?: string | null; now?: number }

export interface QuotaEligibilityOptions { automatic?: boolean }
export type QuotaEligibilityReason = 'ready' | 'invalid-request' | 'invalid-ledger' | 'clock-regression'
  | 'request-history-capacity' | 'token-budget' | 'automatic-budget' | 'cost-exceeds-limit';
export interface QuotaEligibility {
  eligible: boolean;
  nextEligibleAt: number | null;
  reason: QuotaEligibilityReason;
  day: string | null;
  remaining: number | null;
  automaticRemaining: number | null;
  resetAt: number | null;
  basis: 'local-utc-day-ledger';
}
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { DAILY_PROVIDER_TOKEN_BUDGET } from './constants.mts';

export const MAX_QUOTA_LEDGER_REQUESTS = 256;
export const MAX_QUOTA_LEDGER_FILE_BYTES = 256 * 1024;
export const MAX_QUOTA_LEDGER_LABEL_BYTES = 128;
const MAX_QUOTA_LEDGER_META_FIELDS = 8;
const MAX_QUOTA_LEDGER_META_KEY_BYTES = 32;
const MAX_QUOTA_LEDGER_META_STRING_BYTES = 64;
const MAX_QUOTA_LEDGER_RECORD_BYTES = 1024;
const QUOTA_LEDGER_BASE_OVERHEAD_BYTES = 256;
const QUOTA_LEDGER_REQUEST_OVERHEAD_BYTES = 128;
const MAX_QUOTA_LEDGER_READ_CHUNK_BYTES = 16 * 1024;

export function dayKey(now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) throw new TypeError('invalid quota clock');
  return new Date(now).toISOString().slice(0, 10);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validDayKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value + 'T00:00:00.000Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function normalizeRequest(value: unknown): QuotaRequest | null {
  if (!isPlainObject(value)) return null;
  const { at, cost, label } = value;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0) return null;
  if (typeof label !== 'string' || !label.trim() || Buffer.byteLength(label, 'utf8') > MAX_QUOTA_LEDGER_LABEL_BYTES) return null;
  const metadata = Object.entries(value).filter(([key]) => key !== 'at' && key !== 'cost' && key !== 'label');
  if (metadata.length > MAX_QUOTA_LEDGER_META_FIELDS) return null;
  const request: QuotaRequest = { at, cost, label };
  for (const [key, entry] of metadata) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || Buffer.byteLength(key, 'utf8') > MAX_QUOTA_LEDGER_META_KEY_BYTES) return null;
    if (typeof entry === 'string') {
      if (Buffer.byteLength(entry, 'utf8') > MAX_QUOTA_LEDGER_META_STRING_BYTES) return null;
    } else if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) return null;
    } else if (typeof entry !== 'boolean') {
      return null;
    }
    request[key] = entry;
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_QUOTA_LEDGER_RECORD_BYTES) return null;
  return request;
}

function validState(value: unknown): QuotaState | null {
  if (!isPlainObject(value) || !validDayKey(value.day) || typeof value.used !== 'number' || !Number.isSafeInteger(value.used) || value.used < 0) return null;
  if (!Array.isArray(value.requests) || value.requests.length > MAX_QUOTA_LEDGER_REQUESTS) return null;
  const requests: QuotaRequest[] = [];
  let requestCostTotal = 0;
  for (const entry of value.requests) {
    const request = normalizeRequest(entry);
    if (!request) return null;
    requestCostTotal += request.cost;
    if (!Number.isSafeInteger(requestCostTotal)) return null;
    requests.push(request);
  }
  if (requestCostTotal !== value.used) return null;
  const state = { day: value.day, used: value.used, requests };
  try {
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') > MAX_QUOTA_LEDGER_FILE_BYTES) return null;
  } catch {
    return null;
  }
  return state;
}

function ledgerRamBudget(state: unknown): QuotaRamBudget {
  const normalized = validState(state);
  if (!normalized) throw new Error('invalid quota ledger state for retained-memory measurement');
  const serializedBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  const logicalBytes = QUOTA_LEDGER_BASE_OVERHEAD_BYTES
    + (serializedBytes * 2)
    + (normalized.requests.length * QUOTA_LEDGER_REQUEST_OVERHEAD_BYTES);
  if (!Number.isSafeInteger(logicalBytes)) throw new Error('quota ledger retained-memory measurement overflow');
  return {
    logicalBytes,
    requests: normalized.requests.length,
    maximumRequests: MAX_QUOTA_LEDGER_REQUESTS,
    serializedBytes,
    maximumSerializedBytes: MAX_QUOTA_LEDGER_FILE_BYTES,
    entryOverheadBytes: QUOTA_LEDGER_REQUEST_OVERHEAD_BYTES,
    accounting: 'bounded-json-bytes-plus-entry-overhead',
  };
}

/**
 * Small UTC-day token ledger. Persisted and in-memory request history have
 * fixed bounds; server-owned ledgers also pass every growth mutation through
 * the shared logical-RAM and process-RSS admission boundary.
 */
export class QuotaLedger {
  declare limit: number;
  declare filePath: string | null;
  declare state: QuotaState;
  #retainedAdmission: QuotaRetainedAdmission | null = null;
  #lastSpendRejection: QuotaSpendRejection | null = null;

  constructor({ limit = DAILY_PROVIDER_TOKEN_BUDGET, state, filePath = null, now = Date.now() }: QuotaLedgerOptions = {}) {
    const numericLimit = Number(limit);
    const integerLimit = Math.trunc(numericLimit);
    this.limit = Number.isFinite(numericLimit) && Number.isSafeInteger(integerLimit)
      ? Math.max(0, integerLimit)
      : DAILY_PROVIDER_TOKEN_BUDGET;
    this.filePath = filePath === ':memory:' ? null : filePath;
    if (state !== undefined) {
      this.state = validState(state)!;
      if (!this.state) throw new Error('invalid quota ledger state; refusing to reset usage');
    } else {
      this.state = this.#read() ?? { day: dayKey(now), used: 0, requests: [] };
    }
    this.#roll(now);
  }

  get lastSpendRejection() { return this.#lastSpendRejection; }

  #read() {
    if (!this.filePath) return null;
    let descriptor: number;
    try {
      descriptor = fs.openSync(this.filePath, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') return null;
      throw new Error('Provider quota ledger is unreadable; refusing to reset usage (' + (error as { message: unknown }).message + ')', { cause: error });
    }

    try {
      const stat = fs.fstatSync(descriptor);
      if (!Number.isSafeInteger(stat.size) || stat.size <= 0) throw new Error('invalid quota ledger file size');
      if (stat.size > MAX_QUOTA_LEDGER_FILE_BYTES) throw new Error('quota ledger file exceeds the ' + MAX_QUOTA_LEDGER_FILE_BYTES + '-byte limit');
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      while (totalBytes <= MAX_QUOTA_LEDGER_FILE_BYTES) {
        const remaining = MAX_QUOTA_LEDGER_FILE_BYTES + 1 - totalBytes;
        const chunk = Buffer.allocUnsafe(Math.min(MAX_QUOTA_LEDGER_READ_CHUNK_BYTES, remaining));
        const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        totalBytes += bytesRead;
        if (totalBytes > MAX_QUOTA_LEDGER_FILE_BYTES) throw new Error('quota ledger file grew beyond the ' + MAX_QUOTA_LEDGER_FILE_BYTES + '-byte limit while reading');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
      const value = validState(JSON.parse(text));
      if (!value) throw new Error('invalid or oversized quota ledger state');
      return value;
    } catch (error) {
      throw new Error('Provider quota ledger is unreadable; refusing to reset usage (' + (error as { message: unknown }).message + ')', { cause: error });
    } finally {
      fs.closeSync(descriptor);
    }
  }

  #write(state: QuotaState) {
    if (!this.filePath) return;
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_QUOTA_LEDGER_FILE_BYTES) {
      throw new Error('Provider quota ledger exceeds the ' + MAX_QUOTA_LEDGER_FILE_BYTES + '-byte limit');
    }
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temp = this.filePath + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, serialized, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temp, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
  }

  #commitState(nextState: unknown) {
    const normalized = validState(nextState);
    if (!normalized) throw new Error('invalid or oversized quota ledger state; refusing to commit');
    this.#write(normalized);
    this.state = normalized;
    return true;
  }

  #roll(now: number) {
    const day = dayKey(now);
    // The durable day is a high-water mark. Moving the clock backwards must
    // neither reset charged requests nor grant a second allowance for a day.
    if (day < this.state.day) return false;
    if (day > this.state.day) this.#commitState({ day, used: 0, requests: [] });
    return true;
  }

  spend(cost: unknown, label: unknown, now = Date.now(), meta: unknown = {}) {
    this.#lastSpendRejection = null;
    if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0 || !Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999 || typeof label !== 'string' || !label.trim()) {
      this.#lastSpendRejection = 'invalid-request';
      return false;
    }
    if (!isPlainObject(meta)) {
      this.#lastSpendRejection = 'invalid-request';
      return false;
    }
    const requestCandidate: Record<string, unknown> = { at: now, cost, label };
    for (const [key, value] of Object.entries(meta)) {
      if (key === 'at' || key === 'cost' || key === 'label') {
        this.#lastSpendRejection = 'invalid-request';
        return false;
      }
      requestCandidate[key] = value;
    }
    const request = normalizeRequest(requestCandidate);
    if (!request) {
      this.#lastSpendRejection = 'invalid-request';
      return false;
    }
    if (!this.#roll(now)) {
      this.#lastSpendRejection = 'clock-regression';
      return false;
    }
    if (this.state.requests.length >= MAX_QUOTA_LEDGER_REQUESTS) {
      this.#lastSpendRejection = 'request-history-capacity';
      return false;
    }
    if (cost > this.limit - this.state.used) {
      this.#lastSpendRejection = 'token-budget';
      return false;
    }
    if (meta.automatic === true) {
      const automaticUsed = this.state.requests.reduce((sum, request) => sum + (request.automatic === true ? request.cost : 0), 0);
      if (automaticUsed + cost > Math.floor(this.limit / 2)) {
        this.#lastSpendRejection = 'automatic-budget';
        return false;
      }
    }
    const candidate = validState({
      day: this.state.day,
      used: this.state.used + cost,
      requests: [...this.state.requests, request],
    });
    if (!candidate) {
      this.#lastSpendRejection = 'request-history-capacity';
      return false;
    }
    const commit = () => {
      this.#commitState(candidate);
      this.#lastSpendRejection = null;
      return true;
    };
    if (!this.#retainedAdmission) return commit();
    let admitted;
    try {
      admitted = this.#retainedAdmission(candidate, commit, () => {
        this.#lastSpendRejection = 'retained-budget';
      });
    } catch (error) {
      this.#lastSpendRejection = 'retained-budget';
      throw error;
    }
    if (admitted === true) return true;
    if (!this.#lastSpendRejection) this.#lastSpendRejection = 'retained-budget';
    return false;
  }

  /**
   * Read-only local eligibility forecast. This does not roll the durable day,
   * reserve quota, change lastSpendRejection, or verify provider entitlement.
   * Source, physical-memory and transport admission may still reject a request.
   */
  eligibility(cost: unknown, now = Date.now(), options: QuotaEligibilityOptions = {}): QuotaEligibility {
    const invalid = (reason: QuotaEligibilityReason): QuotaEligibility => ({
      eligible: false, nextEligibleAt: null, reason, day: null, remaining: null,
      automaticRemaining: null, resetAt: null, basis: 'local-utc-day-ledger',
    });
    if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0
        || !Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999 || !isPlainObject(options)) return invalid('invalid-request');
    const automatic = options.automatic === undefined ? false : options.automatic;
    if (typeof automatic !== 'boolean') return invalid('invalid-request');
    const current = validState(this.state);
    if (!current || !Number.isSafeInteger(this.limit) || this.limit < 0) return invalid('invalid-ledger');
    const clockDay = dayKey(now), forward = clockDay > current.day;
    const day = forward ? clockDay : current.day;
    const used = forward ? 0 : current.used;
    const requests = forward ? [] : current.requests;
    const automaticUsed = requests.reduce((sum, request) => sum + (request.automatic === true ? request.cost : 0), 0);
    const automaticLimit = Math.floor(this.limit / 2);
    const remaining = Math.max(0, this.limit - used);
    const automaticRemaining = Math.max(0, Math.min(remaining, automaticLimit - automaticUsed));
    const dayStart = Date.parse(day + 'T00:00:00.000Z');
    const nextDayStart = dayStart + 86_400_000;
    const resetAt = Number.isSafeInteger(nextDayStart) && nextDayStart <= 253_402_300_799_999 ? nextDayStart : null;
    const base = { day, remaining, automaticRemaining, resetAt, basis: 'local-utc-day-ledger' as const };
    if (cost > this.limit) return { ...base, eligible: false, nextEligibleAt: null, reason: 'cost-exceeds-limit' };
    if (automatic && cost > automaticLimit) return { ...base, eligible: false, nextEligibleAt: null, reason: 'automatic-budget' };
    const quotaReason: QuotaEligibilityReason | null = requests.length >= MAX_QUOTA_LEDGER_REQUESTS ? 'request-history-capacity'
      : cost > this.limit - used ? 'token-budget' : automatic && cost > automaticLimit - automaticUsed ? 'automatic-budget' : null;
    if (clockDay < current.day) return {
      ...base, eligible: false, nextEligibleAt: quotaReason ? resetAt : dayStart, reason: 'clock-regression',
    };
    if (quotaReason) return { ...base, eligible: false, nextEligibleAt: resetAt, reason: quotaReason };
    return { ...base, eligible: true, nextEligibleAt: now, reason: 'ready' };
  }

  retainedRamBudget(candidateState: unknown = this.state): QuotaRamBudget { return ledgerRamBudget(candidateState); }

  snapshot(now = Date.now()) {
    this.#roll(now);
    const requests = this.state.requests.map((request) => ({ ...request }));
    return { day: this.state.day, limit: this.limit, used: this.state.used, remaining: Math.max(0, this.limit - this.state.used), requests };
  }
}

export function providerRequestAllowed(kind: unknown) { return new Set(['heatmap', 'liquidation', 'stopLoss', 'takeProfit', 'segments', 'positionMetrics', 'positions', 'orders', 'snapshot', 'manual']).has(kind as string); }
