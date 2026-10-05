/** Memory-only sparse executed-volume authority. All owners are explicit frozen plain data. */
import { assertFootprintExecution, footprintExecutionBytesUpper, footprintInertArray, footprintOwn, footprintPlainRecord, footprintString, footprintTime, validateFootprintSource, type FootprintExecution, type FootprintSource } from './footprint-execution.mts';
import { addFootprintVolume, canonicalFootprintDecimal, emptyFootprintVolume, footprintGroupingAllowance, footprintTotals, groupFootprintCells, type FootprintCanonicalCell, type FootprintGroupedCell, type FootprintTotals, type FootprintVolume } from './footprint-grouping.mts';

export const FOOTPRINT_MINUTE_MS = 60_000;
export const FOOTPRINT_LIMITS = Object.freeze({ maxBytes: 8 * 1_024 * 1_024, maxCells: 32_768, maxIds: 65_536, maxMinutes: 180, maxSources: 16, maxPacketExecutions: 65_536, maxGaps: 256, maxWindowCells: 8_192 });
export const FOOTPRINT_PREFLIGHT_FIXED_WORKSPACE_BYTES = 4_096;
export const FOOTPRINT_RECLAIM_MAX_WORKING_BYTES = 1_024 * 1_024;
export interface FootprintModelLimits { readonly maxBytes?: number; readonly maxCells?: number; readonly maxIds?: number; readonly maxMinutes?: number; readonly maxGaps?: number }
type Limits = { -readonly [K in keyof typeof FOOTPRINT_LIMITS]: number };
export type FootprintGapReason = 'disconnect' | 'reconnect-unproven' | 'rejected-packet' | 'identity-conflict' | 'restart' | 'capacity' | 'unknown-source-time' | 'coalesced-coverage';
export interface FootprintGap { readonly instrumentId: string; readonly fromMs: number; readonly toMs: number; readonly reason: FootprintGapReason; readonly excludedRecords: number }
export interface FootprintPacket { readonly executions: readonly FootprintExecution[]; readonly gaps?: readonly FootprintGap[] }
interface Fingerprint { readonly executionId: string; readonly eventTimeMs: number; readonly priceKey: string; readonly quantityBase: number; readonly notionalUsd: number; readonly nativeQuantity: number; readonly aggressor: FootprintExecution['aggressor'] }
export interface FootprintMinute {
  readonly start: number; readonly end: number;
  readonly observedFromMs: number; readonly observedToMs: number; readonly startMidMinute: boolean;
  readonly cells: Readonly<Record<string, FootprintCanonicalCell>>;
  readonly ids: Readonly<Record<string, Fingerprint>>;
  readonly totals: FootprintTotals; readonly unknownSideRecords: number; readonly retainedBytesUpper: number; readonly cellCount: number; readonly idCount: number;
}
export interface FootprintSourceState {
  readonly source: FootprintSource; readonly buckets: readonly FootprintMinute[];
  readonly replayBeforeMs: number; readonly highWaterEventTimeMs: number | null;
  readonly gaps: readonly FootprintGap[];
  readonly duplicateRecords: number; readonly lateOutsideRetention: number;
  readonly evictedMinutes: number; readonly evictedRecords: number; readonly retentionCause: 'age' | 'capacity' | null;
}
export interface FootprintState {
  readonly footprintSessionId: string; readonly revision: number;
  readonly sources: Readonly<Record<string, FootprintSourceState>>;
  readonly highWaterEventTimeMs: number | null;
  readonly cellCount: number; readonly idCount: number; readonly retainedBytesUpper: number;
  readonly ownershipBasis: 'conservative-plain-data-upper';
}
export interface FootprintPreflight {
  readonly complete: boolean; readonly reason: string | null;
  readonly footprintSessionId: string; readonly baseRevision: number;
  readonly executionCount: number; readonly gapCount: number;
  readonly candidateBytesUpper: number; readonly executionClonesBytesUpper: number;
  readonly tapeArrayBytesUpper: number; readonly scratchBytesUpper: number;
  /** ADDITIONAL peak, not a replacement for the currently retained model/tape. */
  readonly additionalWorkingBytesUpper: number;
}
export interface FootprintCoverageIssue { readonly instrumentId: string | null; readonly eventTimeMs: number | null; readonly reason: string }
export interface FootprintPreparationResult {
  readonly complete: boolean; readonly reason: string | null;
  readonly prepared: PreparedFootprintPacket | null;
  readonly coverageIssue: FootprintCoverageIssue | null;
}
export interface FootprintCommitResult { readonly committed: boolean; readonly reason: string | null; readonly state: FootprintState }
function safe(value: number): number { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('accounting-overflow'); return value; }
function increase(value: number, amount: number): number { return safe(value + amount); }
function dictionary<T>(): Record<string, T> { return Object.create(null) as Record<string, T>; }
function gapBytes(gap: FootprintGap): number { return 384 + 4 * gap.instrumentId.length + 2 * gap.reason.length; }
function idBytes(row: Fingerprint): number { return 512 + 4 * row.executionId.length + 2 * row.priceKey.length + 2 * row.aggressor.length; }
function equalId(a: Fingerprint, b: FootprintExecution): boolean { return a.eventTimeMs === b.eventTimeMs && a.priceKey === b.priceKey && a.quantityBase === b.quantityBase && a.notionalUsd === b.notionalUsd && a.nativeQuantity === b.nativeQuantity && a.aggressor === b.aggressor; }
function fingerprint(row: FootprintExecution): Fingerprint { return Object.freeze({ executionId: row.executionId, eventTimeMs: row.eventTimeMs, priceKey: row.priceKey, quantityBase: row.quantityBase, notionalUsd: row.notionalUsd, nativeQuantity: row.nativeQuantity, aggressor: row.aggressor }); }
interface MutableMinute { start: number; end: number; observedFromMs: number; observedToMs: number; startMidMinute: boolean; cells: Record<string, FootprintCanonicalCell & FootprintVolume>; ids: Record<string, Fingerprint>; totals: FootprintTotals; unknownSideRecords: number; retainedBytesUpper: number; cellCount: number; idCount: number }
interface MutableSource { source: FootprintSource; buckets: (MutableMinute | FootprintMinute)[]; replayBeforeMs: number; highWaterEventTimeMs: number | null; gaps: FootprintGap[]; duplicateRecords: number; lateOutsideRetention: number; evictedMinutes: number; evictedRecords: number; retentionCause: 'age' | 'capacity' | null }
/** Only private deep-frozen committed buckets are shared. Candidate headers/arrays
 * are detached, and the first admitted write clones that minute's two maps.
 * No public mutable signature, WeakMap, TTL or unmeasured auxiliary owner exists.
 */
function copySource(previous: FootprintSourceState): MutableSource {
  return { ...previous, gaps: [...previous.gaps], buckets: [...previous.buckets] };
}
function copyMinute(previous: FootprintMinute): MutableMinute {
  const cells = dictionary<FootprintCanonicalCell & FootprintVolume>(), ids = dictionary<Fingerprint>();
  // Frozen scalar descendants stay shared until the actual cell is changed.
  for (const key in previous.cells) cells[key] = previous.cells[key];
  for (const key in previous.ids) ids[key] = previous.ids[key];
  return { ...previous, cells, ids };
}
function measureSources(sources: Readonly<Record<string, FootprintSourceState | MutableSource>>, sessionId: string): { bytes: number; cells: number; ids: number } {
  let bytes = 1_024 + sessionId.length * 2, cells = 0, ids = 0;
  for (const [instrumentId, source] of Object.entries(sources)) {
    bytes = increase(bytes, 2_048 + instrumentId.length * 4 + source.source.nativeSymbol.length * 2 + source.source.baseAsset.length * 2);
    // All sealed buckets are immutable owned graphs. Admitted candidate writes
    // update these SAME existing conservative coefficients before publication.
    for (const bucket of source.buckets) {
      bytes = increase(bytes, bucket.retainedBytesUpper);
      cells = increase(cells, bucket.cellCount); ids = increase(ids, bucket.idCount);
    }
    for (const gap of source.gaps) bytes = increase(bytes, gapBytes(gap));
  }
  return { bytes, cells, ids };
}
function seal(sessionId: string, revision: number, sources: Record<string, MutableSource>, highWaterEventTimeMs: number | null): FootprintState {
  for (const source of Object.values(sources)) {
    for (const value of source.buckets) {
      if (Object.isFrozen(value)) continue;
      const bucket = value as MutableMinute;
      const total = emptyFootprintVolume();
      // Same cell order and sum policy as baseline: no numerical-order change.
      for (const cell of Object.values(bucket.cells)) { addFootprintVolume(total, cell); Object.freeze(cell); }
      bucket.totals = footprintTotals(total);
      Object.freeze(bucket.cells); Object.freeze(bucket.ids); Object.freeze(bucket);
    }
    Object.freeze(source.buckets); Object.freeze(source.gaps); Object.freeze(source);
  }
  const measured = measureSources(sources, sessionId);
  return Object.freeze({ footprintSessionId: sessionId, revision, sources: Object.freeze(sources), highWaterEventTimeMs, cellCount: measured.cells, idCount: measured.ids, retainedBytesUpper: measured.bytes, ownershipBasis: 'conservative-plain-data-upper' });
}
function validateGap(value: unknown, sources: FootprintState['sources']): asserts value is FootprintGap {
  const row = footprintPlainRecord(value), instrumentId = footprintString(footprintOwn(row, 'instrumentId'), 'gap-instrument');
  if (!sources[instrumentId]) throw new TypeError('foreign-gap-source');
  const from = footprintTime(footprintOwn(row, 'fromMs'), 'gap-from'), to = footprintTime(footprintOwn(row, 'toMs'), 'gap-to');
  if (!(to > from) || (typeof footprintOwn(row, 'reason') !== 'string' || !['disconnect', 'reconnect-unproven', 'rejected-packet', 'identity-conflict', 'restart', 'capacity', 'unknown-source-time', 'coalesced-coverage'].includes(footprintOwn(row, 'reason') as string))) throw new TypeError('invalid-gap');
  const count = footprintOwn(row, 'excludedRecords');
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > FOOTPRINT_LIMITS.maxPacketExecutions) throw new TypeError('invalid-gap-count');
  const allowed = new Set(['instrumentId', 'fromMs', 'toMs', 'reason', 'excludedRecords']);
  for (const name of Reflect.ownKeys(row)) if (typeof name !== 'string' || !allowed.has(name) || !('value' in (Object.getOwnPropertyDescriptor(row, name) ?? {}))) throw new TypeError('extra-gap-owner');
}
/** All candidate/tape owners remain charged until caller commit-transfer or discard-release. */
export class PreparedFootprintPacket {
  readonly candidate: FootprintState;
  readonly acceptedExecutions: readonly FootprintExecution[];
  readonly baseRevision: number;
  readonly workingBytesUpper: number;
  readonly duplicateRecords: number;
  readonly lateOutsideRetention: number;
  #authority: symbol; #consumed = false;
  constructor(authority: symbol, baseRevision: number, candidate: FootprintState, acceptedExecutions: readonly FootprintExecution[], workingBytesUpper: number, duplicates: number, late: number) {
    this.#authority = authority; this.baseRevision = baseRevision; this.candidate = candidate; this.acceptedExecutions = Object.freeze(acceptedExecutions); this.workingBytesUpper = workingBytesUpper; this.duplicateRecords = duplicates; this.lateOutsideRetention = late; Object.freeze(this);
  }
  consume(authority: symbol): boolean { if (this.#consumed || this.#authority !== authority) return false; this.#consumed = true; return true; }
  discard(): void { this.#consumed = true; }
}
export class FootprintModel {
  readonly limits: Readonly<Limits>;
  #authority = Symbol('footprint-model'); #state: FootprintState;
  constructor({ footprintSessionId, sources, limits = {} }: { footprintSessionId: string; sources: readonly FootprintSource[]; limits?: FootprintModelLimits }) {
    footprintString(footprintSessionId, 'session-id'); footprintInertArray(sources, FOOTPRINT_LIMITS.maxSources);
    if (!sources.length) throw new TypeError('footprint-source-required');
    const applied: Limits = { ...FOOTPRINT_LIMITS };
    for (const name of ['maxBytes', 'maxCells', 'maxIds', 'maxMinutes', 'maxGaps'] as const) {
      const value = limits[name]; if (value !== undefined) { if (!Number.isSafeInteger(value) || value < 1 || value > FOOTPRINT_LIMITS[name]) throw new RangeError('tighten-only-' + name); applied[name] = value; }
    }
    this.limits = Object.freeze(applied);
    const owned = dictionary<MutableSource>();
    for (const source of sources) {
      const detached = validateFootprintSource(source);
      if (owned[detached.instrumentId]) throw new TypeError('one-authoritative-channel-per-instrument');
      owned[detached.instrumentId] = { source: detached, buckets: [], gaps: [], replayBeforeMs: 0, highWaterEventTimeMs: null, duplicateRecords: 0, lateOutsideRetention: 0, evictedMinutes: 0, evictedRecords: 0, retentionCause: null };
    }
    this.#state = seal(footprintSessionId, 0, owned, null);
    if (this.#state.retainedBytesUpper > this.limits.maxBytes) throw new RangeError('initial-owner-capacity');
  }
  retainedSnapshot(): FootprintState { return this.#state; }
  /** First boundary: scalar counts only, BEFORE all row reflection/validation/cloning.
   * Caller proves the native packet's inert array lengths and reserves this peak.
   * Descriptor validation workspace and every preparation owner are included.
   */
  estimatePreparation(executionCount: number, gapCount = 0): FootprintPreflight {
    try {
      if (!Number.isSafeInteger(executionCount) || executionCount < 0 || executionCount > this.limits.maxPacketExecutions || !Number.isSafeInteger(gapCount) || gapCount < 0 || gapCount > this.limits.maxGaps) throw new Error('invalid-scalar-packet-count');
      const candidate = safe(this.#state.retainedBytesUpper + executionCount * 4_096 + gapCount * 1_536);
      const clones = safe(executionCount * 6_144);
      const scratch = safe(FOOTPRINT_PREFLIGHT_FIXED_WORKSPACE_BYTES + executionCount * 384 + gapCount * 128 + (this.#state.idCount + this.#state.cellCount) * 128);
      const tape = safe(256 + 16 * (5_000 + executionCount + 5_000));
      return Object.freeze({ complete: true, reason: null, footprintSessionId: this.#state.footprintSessionId, baseRevision: this.#state.revision, executionCount, gapCount, candidateBytesUpper: candidate, executionClonesBytesUpper: clones, tapeArrayBytesUpper: tape, scratchBytesUpper: scratch, additionalWorkingBytesUpper: safe(candidate + clones + scratch + tape + 1_024) });
    } catch (error) { return Object.freeze({ complete: false, reason: error instanceof Error ? error.message : 'invalid-count', footprintSessionId: this.#state.footprintSessionId, baseRevision: this.#state.revision, executionCount: 0, gapCount: 0, candidateBytesUpper: 0, executionClonesBytesUpper: 0, tapeArrayBytesUpper: 0, scratchBytesUpper: 0, additionalWorkingBytesUpper: 0 }); }
  }
  /** Validating borrowed scalar rows; run under estimatePreparation workspace grant. */
  preflight(packet: FootprintPacket): FootprintPreflight {
    let count = 0, gaps = 0, clones = 0, candidate = this.#state.retainedBytesUpper;
    try {
      const row = footprintPlainRecord(packet), executions = footprintInertArray(footprintOwn(row, 'executions'), this.limits.maxPacketExecutions);
      const gapRows = footprintOwn(row, 'gaps') === undefined ? [] : footprintInertArray(footprintOwn(row, 'gaps'), this.limits.maxGaps);
      for (const name of Reflect.ownKeys(row)) if (name !== 'executions' && name !== 'gaps') throw new TypeError('extra-packet-owner');
      count = executions.length; gaps = gapRows.length;
      for (const execution of executions) {
        assertFootprintExecution(execution);
        const source = this.#state.sources[execution.instrumentId]?.source;
        if (!source) throw new TypeError('foreign-execution-source');
        assertFootprintExecution(execution, source);
        clones = increase(clones, footprintExecutionBytesUpper(execution) + 32);
        candidate = increase(candidate, idBytes(execution) + 512 + execution.priceKey.length * 4 + 768);
      }
      for (const gap of gapRows) { validateGap(gap, this.#state.sources); candidate = increase(candidate, gapBytes(gap)); }
      const scratch = safe(FOOTPRINT_PREFLIGHT_FIXED_WORKSPACE_BYTES + count * 384 + gaps * 128 + (this.#state.idCount + this.#state.cellCount) * 128);
      // Current tape is separately retained; reserve BOTH spread and sliced array slots, no row truncation in this reducer.
      const tape = safe(256 + 16 * (5_000 + count + Math.min(5_000, 5_000 + count)));
      const total = safe(candidate + clones + scratch + tape + 1_024);
      return Object.freeze({ complete: true, reason: null, footprintSessionId: this.#state.footprintSessionId, baseRevision: this.#state.revision, executionCount: count, gapCount: gaps, candidateBytesUpper: candidate, executionClonesBytesUpper: clones, tapeArrayBytesUpper: tape, scratchBytesUpper: scratch, additionalWorkingBytesUpper: total });
    } catch (error) {
      return Object.freeze({ complete: false, reason: error instanceof Error ? error.message : 'invalid-packet', footprintSessionId: this.#state.footprintSessionId, baseRevision: this.#state.revision, executionCount: count, gapCount: gaps, candidateBytesUpper: 0, executionClonesBytesUpper: 0, tapeArrayBytesUpper: 0, scratchBytesUpper: 0, additionalWorkingBytesUpper: 0 });
    }
  }
  /** Called ONLY after global logical/physical grants covering preflight peak. */
  prepare(packet: FootprintPacket, plan: FootprintPreflight, { reservedWorkingBytes }: { reservedWorkingBytes: number }): FootprintPreparationResult {
    let issue: FootprintCoverageIssue | null = null;
    try {
      if (!plan.complete || plan.footprintSessionId !== this.#state.footprintSessionId || plan.baseRevision !== this.#state.revision) throw new Error('stale-or-incomplete-preflight');
      if (!Number.isSafeInteger(reservedWorkingBytes) || reservedWorkingBytes < plan.additionalWorkingBytesUpper) throw new Error('reservation-required-before-prepare');
      const fresh = this.preflight(packet);
      if (!fresh.complete || fresh.additionalWorkingBytesUpper > reservedWorkingBytes || fresh.executionCount !== plan.executionCount || fresh.gapCount !== plan.gapCount) throw new Error(fresh.reason ?? 'input-changed-after-preflight');
      const sources = dictionary<MutableSource>(); for (const [id, source] of Object.entries(this.#state.sources)) sources[id] = copySource(source);
      const accepted: FootprintExecution[] = [];
      let highWater = this.#state.highWaterEventTimeMs, duplicates = 0, late = 0;
      let packetWater = highWater ?? 0; for (const row of packet.executions) packetWater = Math.max(packetWater, row.eventTimeMs);
      const packetAgeFence = Math.max(0, Math.floor(packetWater / FOOTPRINT_MINUTE_MS) * FOOTPRINT_MINUTE_MS - (this.limits.maxMinutes - 1) * FOOTPRINT_MINUTE_MS);
      for (const input of packet.executions) {
        const source = sources[input.instrumentId];
        let previous: Fingerprint | undefined;
        for (const bucket of source.buckets) { previous = bucket.ids[input.executionId]; if (previous) break; }
        if (previous) {
          if (!equalId(previous, input)) { issue = { instrumentId: input.instrumentId, eventTimeMs: input.eventTimeMs, reason: 'identity-conflict' }; throw new Error('identity-conflict'); }
          source.duplicateRecords = increase(source.duplicateRecords, 1); duplicates += 1; continue;
        }
        if (input.eventTimeMs < Math.max(source.replayBeforeMs, packetAgeFence)) { source.lateOutsideRetention = increase(source.lateOutsideRetention, 1); late += 1; continue; }
        const execution = Object.freeze({ ...input }); accepted.push(execution);
        const start = Math.floor(execution.eventTimeMs / FOOTPRINT_MINUTE_MS) * FOOTPRINT_MINUTE_MS;
        const bucketIndex = source.buckets.findIndex(value => value.start === start);
        let bucket: MutableMinute;
        if (bucketIndex < 0) { bucket = { start, end: start + FOOTPRINT_MINUTE_MS, observedFromMs: execution.eventTimeMs, observedToMs: execution.eventTimeMs, startMidMinute: execution.eventTimeMs > start, cells: dictionary(), ids: dictionary(), totals: footprintTotals(emptyFootprintVolume()), unknownSideRecords: 0, retainedBytesUpper: 768, cellCount: 0, idCount: 0 }; source.buckets.push(bucket); }
        else { const prior = source.buckets[bucketIndex]; bucket = Object.isFrozen(prior) ? copyMinute(prior) : prior as MutableMinute; source.buckets[bucketIndex] = bucket; }
        let cell = bucket.cells[execution.priceKey];
        if (!cell) { cell = { ...emptyFootprintVolume(), price: execution.price, priceKey: execution.priceKey }; bucket.cells[execution.priceKey] = cell; bucket.cellCount = increase(bucket.cellCount, 1); bucket.retainedBytesUpper = increase(bucket.retainedBytesUpper, 512 + execution.priceKey.length * 4); }
        else if (Object.isFrozen(cell)) { cell = { ...cell }; bucket.cells[execution.priceKey] = cell; }
        const delta = emptyFootprintVolume(); delta.records = 1;
        if (execution.aggressor === 'buy') { delta.buyBase = execution.quantityBase; delta.buyUsd = execution.notionalUsd; }
        else if (execution.aggressor === 'sell') { delta.sellBase = execution.quantityBase; delta.sellUsd = execution.notionalUsd; }
        else { delta.unknownBase = execution.quantityBase; delta.unknownUsd = execution.notionalUsd; bucket.unknownSideRecords = increase(bucket.unknownSideRecords, 1); }
        addFootprintVolume(cell, delta);
        const ownedId = fingerprint(execution); bucket.ids[execution.executionId] = ownedId; bucket.idCount = increase(bucket.idCount, 1); bucket.retainedBytesUpper = increase(bucket.retainedBytesUpper, idBytes(ownedId));
        bucket.observedFromMs = Math.min(bucket.observedFromMs, execution.eventTimeMs); bucket.observedToMs = Math.max(bucket.observedToMs, execution.eventTimeMs); bucket.startMidMinute = bucket.observedFromMs > start;
        source.highWaterEventTimeMs = Math.max(source.highWaterEventTimeMs ?? execution.eventTimeMs, execution.eventTimeMs); highWater = Math.max(highWater ?? execution.eventTimeMs, execution.eventTimeMs);
      }
      for (const input of packet.gaps ?? []) sources[input.instrumentId].gaps.push(Object.freeze({ instrumentId: input.instrumentId, fromMs: input.fromMs, toMs: input.toMs, reason: input.reason, excludedRecords: input.excludedRecords }));
      const currentMinute = highWater === null ? 0 : Math.floor(highWater / FOOTPRINT_MINUTE_MS) * FOOTPRINT_MINUTE_MS;
      const ageFence = Math.max(0, currentMinute - (this.limits.maxMinutes - 1) * FOOTPRINT_MINUTE_MS);
      const evictBefore = (fence: number, cause: 'age' | 'capacity') => {
        for (const source of Object.values(sources)) {
          const removed = source.buckets.filter(bucket => bucket.start < fence);
          source.buckets = source.buckets.filter(bucket => bucket.start >= fence); if (fence > source.replayBeforeMs) source.retentionCause = cause; source.replayBeforeMs = Math.max(source.replayBeforeMs, fence);
          source.evictedMinutes = increase(source.evictedMinutes, removed.length);
          for (const bucket of removed) source.evictedRecords = increase(source.evictedRecords, bucket.idCount);
          source.gaps = source.gaps.filter(gap => gap.toMs > fence);
        }
      };
      evictBefore(ageFence, 'age');
      for (const source of Object.values(sources)) {
        source.buckets.sort((a, b) => a.start - b.start); source.gaps.sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs);
        while (source.gaps.length > this.limits.maxGaps) {
          const first = source.gaps.shift(), second = source.gaps.shift();
          if (!first || !second) throw new Error('gap-capacity');
          source.gaps.unshift(Object.freeze({ instrumentId: source.source.instrumentId, fromMs: Math.min(first.fromMs, second.fromMs), toMs: Math.max(first.toMs, second.toMs), reason: 'coalesced-coverage', excludedRecords: increase(first.excludedRecords, second.excludedRecords) }));
        }
      }
      let measured = measureSources(sources, this.#state.footprintSessionId);
      while (measured.bytes > this.limits.maxBytes || measured.cells > this.limits.maxCells || measured.ids > this.limits.maxIds) {
        let oldest = Infinity; for (const source of Object.values(sources)) for (const bucket of source.buckets) oldest = Math.min(oldest, bucket.start);
        if (!Number.isFinite(oldest) || oldest >= currentMinute) { issue = { instrumentId: null, eventTimeMs: highWater, reason: 'capacity' }; throw new Error('atomic-current-minute-capacity'); }
        evictBefore(oldest + FOOTPRINT_MINUTE_MS, 'capacity'); measured = measureSources(sources, this.#state.footprintSessionId);
      }
      const candidate = seal(this.#state.footprintSessionId, increase(this.#state.revision, 1), sources, highWater);
      if (candidate.retainedBytesUpper > fresh.candidateBytesUpper) throw new Error('candidate-exceeds-preflight');
      const prepared = new PreparedFootprintPacket(this.#authority, this.#state.revision, candidate, accepted, fresh.additionalWorkingBytesUpper, duplicates, late);
      return Object.freeze({ complete: true, reason: null, prepared, coverageIssue: null });
    } catch (error) { return Object.freeze({ complete: false, reason: error instanceof Error ? error.message : 'invalid-packet', prepared: null, coverageIssue: issue === null ? null : Object.freeze(issue) }); }
  }
  /** Fixed for this call and scalar-only; no row descendants are scanned or cloned. */
  estimateReclaimWorkingBytes(): number {
    let entries = 0, sourceCount = 0;
    for (const source of Object.values(this.#state.sources)) { sourceCount += 1; entries += source.buckets.length + source.gaps.length; }
    const bytes = safe(4_096 + sourceCount * 2_048 + entries * 128);
    if (bytes > FOOTPRINT_RECLAIM_MAX_WORKING_BYTES) throw new Error('reclaim-workspace-capacity');
    return bytes;
  }
  /** Shrink-only whole-minute removal; old frozen row trees are reused, never copied. */
  reclaim(targetBytes: number, { reservedWorkingBytes }: { reservedWorkingBytes: number }): { readonly complete: boolean; readonly reason: string | null; readonly releasedBytes: number; readonly state: FootprintState } {
    const before = this.#state;
    try {
      if (!Number.isSafeInteger(targetBytes) || targetBytes < 0 || targetBytes > before.retainedBytesUpper) throw new Error('shrink-only-reclaim-target');
      if (targetBytes === before.retainedBytesUpper) return Object.freeze({ complete: true, reason: null, releasedBytes: 0, state: before });
      if (!Number.isSafeInteger(reservedWorkingBytes) || reservedWorkingBytes < this.estimateReclaimWorkingBytes()) throw new Error('reclaim-reservation-required');
      const starts: number[] = []; for (const source of Object.values(before.sources)) for (const bucket of source.buckets) starts.push(bucket.start);
      starts.sort((a, b) => a - b); let remaining = before.retainedBytesUpper, fence = 0;
      for (const start of starts) {
        if (start < fence) continue;
        const nextFence = start + FOOTPRINT_MINUTE_MS;
        for (const source of Object.values(before.sources)) {
          const bucket = source.buckets.find(row => row.start === start); if (bucket) remaining -= bucket.retainedBytesUpper;
          for (const gap of source.gaps) if (gap.toMs > fence && gap.toMs <= nextFence) remaining -= gapBytes(gap);
        }
        fence = nextFence; if (remaining <= targetBytes) break;
      }
      if (!fence) return Object.freeze({ complete: true, reason: 'retained-metadata-floor', releasedBytes: 0, state: before });
      const sources = dictionary<FootprintSourceState>(); let bytes = 1_024 + before.footprintSessionId.length * 2, cells = 0, ids = 0;
      for (const [id, previous] of Object.entries(before.sources)) {
        const buckets = previous.buckets.filter(bucket => bucket.start >= fence), gaps = previous.gaps.filter(gap => gap.toMs > fence);
        let removedMinutes = 0, removedRecords = 0;
        for (const bucket of previous.buckets) if (bucket.start < fence) { removedMinutes += 1; removedRecords = increase(removedRecords, bucket.idCount); }
        const source = Object.freeze({ ...previous, buckets: Object.freeze(buckets), gaps: Object.freeze(gaps), replayBeforeMs: Math.max(previous.replayBeforeMs, fence), retentionCause: 'capacity' as const, evictedMinutes: increase(previous.evictedMinutes, removedMinutes), evictedRecords: increase(previous.evictedRecords, removedRecords) });
        sources[id] = source; bytes = increase(bytes, 2_048 + id.length * 4 + source.source.nativeSymbol.length * 2 + source.source.baseAsset.length * 2);
        for (const bucket of buckets) { bytes = increase(bytes, bucket.retainedBytesUpper); cells = increase(cells, bucket.cellCount); ids = increase(ids, bucket.idCount); }
        for (const gap of gaps) bytes = increase(bytes, gapBytes(gap));
      }
      if (bytes >= before.retainedBytesUpper) return Object.freeze({ complete: true, reason: 'retained-metadata-floor', releasedBytes: 0, state: before });
      const state: FootprintState = Object.freeze({ footprintSessionId: before.footprintSessionId, revision: increase(before.revision, 1), sources: Object.freeze(sources), highWaterEventTimeMs: before.highWaterEventTimeMs, cellCount: cells, idCount: ids, retainedBytesUpper: bytes, ownershipBasis: 'conservative-plain-data-upper' });
      this.#state = state;
      return Object.freeze({ complete: true, reason: bytes > targetBytes ? 'retained-metadata-floor' : null, releasedBytes: before.retainedBytesUpper - bytes, state });
    } catch (error) { return Object.freeze({ complete: false, reason: error instanceof Error ? error.message : 'invalid-reclaim', releasedBytes: 0, state: before }); }
  }
  commit(prepared: PreparedFootprintPacket): FootprintCommitResult {
    if (!(prepared instanceof PreparedFootprintPacket) || prepared.baseRevision !== this.#state.revision || prepared.candidate.footprintSessionId !== this.#state.footprintSessionId) return Object.freeze({ committed: false, reason: 'stale-prepared-packet', state: this.#state });
    if (!prepared.consume(this.#authority)) return Object.freeze({ committed: false, reason: 'foreign-or-consumed-preparation', state: this.#state });
    this.#state = prepared.candidate;
    return Object.freeze({ committed: true, reason: null, state: this.#state });
  }
}

export interface FootprintWindowOptions { readonly instrumentIds: readonly string[]; readonly fromMs: number; readonly toMs: number; readonly intervalMs: number; readonly priceStep: number | string; readonly maxCells?: number }
export interface FootprintWindowPlan { readonly complete: boolean; readonly reason: string | null; readonly workingBytesUpper: number }
export interface FootprintBar {
  readonly start: number; readonly end: number; readonly cells: readonly FootprintGroupedCell[]; readonly totals: FootprintTotals | null;
  readonly observedSources: number; readonly selectedSources: number; readonly partial: boolean; readonly gap: boolean;
  readonly unknownSideRecords: number; readonly coverage: readonly { readonly instrumentId: string; readonly observed: boolean; readonly observedFromMs: number | null; readonly observedToMs: number | null; readonly retentionFenceMs: number; readonly continuityUnproven: true; readonly gapCount: number; readonly missingMinutes: number; readonly duplicateRecords: number; readonly lateOutsideRetention: number; readonly evictedMinutes: number; readonly evictedRecords: number; readonly retentionCause: 'age' | 'capacity' | null; readonly usdBasis: FootprintSource['usdBasis'] }[];
  readonly segmentCvdUsd: number | null; readonly segmentCvdSinceMs: number | null;
}
export interface FootprintWindow { readonly footprintSessionId: string; readonly revision: number; readonly intervalMs: number; readonly grouping: string; readonly baseAsset: string; readonly coverageKind: 'locally-observed-only'; readonly deltaKind: 'known-side'; readonly bars: readonly FootprintBar[]; readonly totals: FootprintTotals }
function checkWindow(state: FootprintState, options: FootprintWindowOptions): void {
  const ids = footprintInertArray(options.instrumentIds, FOOTPRINT_LIMITS.maxSources); if (!ids.length) throw new TypeError('window-source-required');
  let base: string | null = null; const seen = new Set<string>();
  for (const id of ids) { if (typeof id !== 'string' || !state.sources[id] || seen.has(id)) throw new TypeError('unknown-or-duplicate-window-source'); seen.add(id); const current = state.sources[id].source.baseAsset; if (base !== null && current !== base) throw new TypeError('common-base-required'); base = current; }
  footprintTime(options.fromMs, 'window-from'); footprintTime(options.toMs, 'window-to');
  if (options.toMs <= options.fromMs || options.toMs - options.fromMs > FOOTPRINT_LIMITS.maxMinutes * FOOTPRINT_MINUTE_MS || options.fromMs % FOOTPRINT_MINUTE_MS || options.toMs % FOOTPRINT_MINUTE_MS || ![60_000, 300_000, 900_000, 1_800_000, 3_600_000].includes(options.intervalMs)) throw new TypeError('whole-minute-bounded-window-required');
  canonicalFootprintDecimal(options.priceStep);
  if (options.maxCells !== undefined && (!Number.isSafeInteger(options.maxCells) || options.maxCells < 1 || options.maxCells > FOOTPRINT_LIMITS.maxWindowCells)) throw new TypeError('tighten-only-window-cells');
}
export function planFootprintWindow(state: FootprintState, options: FootprintWindowOptions): FootprintWindowPlan {
  try { checkWindow(state, options); return Object.freeze({ complete: true, reason: null, workingBytesUpper: safe(4_096 + state.cellCount * 2_048 + Math.ceil((options.toMs - options.fromMs) / options.intervalMs + 1) * (1_024 + options.instrumentIds.length * 384)) }); }
  catch (error) { return Object.freeze({ complete: false, reason: error instanceof Error ? error.message : 'invalid-window', workingBytesUpper: 0 }); }
}
/** Allocation only after projection grant; sparse source gaps remain explicit, never zero-filled history. */
export function projectFootprintWindow(state: FootprintState, options: FootprintWindowOptions, { reservedWorkingBytes }: { reservedWorkingBytes: number }): { readonly complete: boolean; readonly reason: string | null; readonly window: FootprintWindow | null } {
  try {
    const plan = planFootprintWindow(state, options); if (!plan.complete) throw new Error(plan.reason ?? 'invalid-window');
    if (!Number.isSafeInteger(reservedWorkingBytes) || reservedWorkingBytes < plan.workingBytesUpper) throw new Error('window-reservation-required');
    const bars: FootprintBar[] = [], whole = emptyFootprintVolume(); let cellsSeen = 0, cvd = 0, since: number | null = null;
    for (let start = Math.floor(options.fromMs / options.intervalMs) * options.intervalMs; start < options.toMs; start += options.intervalMs) {
      const end = start + options.intervalMs, cells = dictionary<FootprintCanonicalCell & FootprintVolume>();
      const coverage: FootprintBar['coverage'][number][] = [];
      let observedSources = 0, gap = false, unknown = 0;
      for (const id of options.instrumentIds) {
        const source = state.sources[id]; let first: number | null = null, last: number | null = null;
        for (const bucket of source.buckets) if (bucket.start >= options.fromMs && bucket.start < options.toMs && bucket.start >= start && bucket.start < end) {
          first = Math.min(first ?? bucket.observedFromMs, bucket.observedFromMs); last = Math.max(last ?? bucket.observedToMs, bucket.observedToMs); unknown += bucket.unknownSideRecords;
          for (const cell of Object.values(bucket.cells)) { const target = cells[cell.priceKey] ?? (cells[cell.priceKey] = { ...emptyFootprintVolume(), price: cell.price, priceKey: cell.priceKey }); addFootprintVolume(target, cell); }
        }
        const gapCount = source.gaps.filter(issue => issue.fromMs < end && issue.toMs > start).length;
        let missingMinutes = 0; for (let minute = Math.max(start, options.fromMs); minute < Math.min(end, options.toMs); minute += FOOTPRINT_MINUTE_MS) if (!source.buckets.some(bucket => bucket.start === minute)) missingMinutes += 1;
        if (first !== null) observedSources += 1; if (gapCount || missingMinutes || first === null || source.replayBeforeMs > start) gap = true;
        coverage.push(Object.freeze({ instrumentId: id, observed: first !== null, observedFromMs: first, observedToMs: last, retentionFenceMs: source.replayBeforeMs, continuityUnproven: true, gapCount, missingMinutes, duplicateRecords: source.duplicateRecords, lateOutsideRetention: source.lateOutsideRetention, evictedMinutes: source.evictedMinutes, evictedRecords: source.evictedRecords, retentionCause: source.retentionCause, usdBasis: source.source.usdBasis }));
      }
      const canonical = Object.values(cells), grouped = groupFootprintCells(canonical, options.priceStep, { reservedWorkingBytes: footprintGroupingAllowance(canonical.length) });
      cellsSeen += grouped.length; if (cellsSeen > (options.maxCells ?? FOOTPRINT_LIMITS.maxWindowCells)) throw new Error('window-output-capacity');
      const amount = emptyFootprintVolume(); for (const cell of grouped) addFootprintVolume(amount, cell);
      const totals = observedSources ? footprintTotals(amount) : null; addFootprintVolume(whole, amount);
      if (gap || totals === null) { cvd = 0; since = null; } else { since ??= Math.min(...coverage.flatMap(source => source.observedFromMs === null ? [] : [source.observedFromMs])); cvd += totals.deltaUsd; if (!Number.isFinite(cvd)) throw new Error('cvd-overflow'); }
      bars.push(Object.freeze({ start, end, cells: grouped, totals, observedSources, selectedSources: options.instrumentIds.length, partial: gap || unknown > 0 || coverage.some(source => source.observedFromMs !== null && source.observedFromMs > start) || start < options.fromMs || end > options.toMs, gap, unknownSideRecords: unknown, coverage: Object.freeze(coverage), segmentCvdUsd: gap || totals === null ? null : cvd, segmentCvdSinceMs: since }));
    }
    return Object.freeze({ complete: true, reason: null, window: Object.freeze({ footprintSessionId: state.footprintSessionId, revision: state.revision, intervalMs: options.intervalMs, grouping: canonicalFootprintDecimal(options.priceStep).key, baseAsset: state.sources[options.instrumentIds[0]].source.baseAsset, coverageKind: 'locally-observed-only', deltaKind: 'known-side', bars: Object.freeze(bars), totals: footprintTotals(whole) }) });
  } catch (error) { return Object.freeze({ complete: false, reason: error instanceof Error ? error.message : 'invalid-window', window: null }); }
}
