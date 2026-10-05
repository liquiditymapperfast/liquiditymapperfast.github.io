import { planRetainedBudget } from '../core/retained-budget.mts';
export interface ServerRamLimits { softLimitBytes?: unknown; hardLimitBytes?: unknown; }
export interface RetainedReclaimContext { pressure: string; reason: string; logicalBytes: number | null; reservedBytes: number; targetBytes: number; }
export interface RetainedParticipant { available?: boolean; enforceable?: boolean; measure: (options: { cached: boolean }) => unknown; reclaim?: (context: RetainedReclaimContext) => unknown; }
interface RetainedEntry { name: string; participant: RetainedParticipant; priority: number; }
export interface RetainedAdmission { admitted: boolean; enforced: boolean; bytes: number; reservedBytes: number; reason: string | null; context: Record<string, unknown>; missingParticipants?: string[]; unclassifiedParticipants?: string[]; unmeasuredParticipants?: string[]; measurementError?: string | null; logicalBytes?: number | null; accountedLogicalBytes?: number | null; hardLimitBytes?: number; }
interface AdmissionCounters { attempts: number; admitted: number; rejected: number; released: number; last: RetainedAdmission | null; }
export interface RetainedMeasurement { logicalBytes: number | null; measurementAvailable: boolean; [key: string]: unknown; }
export interface RetainedBudgetSnapshot {
  logicalBytes: number | null; partialLogicalBytes: number | null; reservedBytes: number; accountedLogicalBytes: number | null;
  participants: Record<string, RetainedMeasurement>; enforcedParticipants: string[]; missingParticipants: string[];
  optionalParticipants: string[]; unclassifiedParticipants: string[]; ownershipComplete: boolean;
  unenforceableRequiredParticipants: string[]; unmeasuredParticipants: string[]; measurementComplete: boolean; measurementError: string | null;
  limits: { softLimitBytes: number; hardLimitBytes: number }; enforcementScope: string; physicalRamMeasured: boolean;
  enforcementEligible: boolean; hardLimitSatisfied: boolean; byteBudgetEnforced: boolean; admission: AdmissionCounters;
}
interface RetainedAction { participant: string; targetBytes: number; reclaimedBytes: number; reason: string; }
export interface PublishedRetainedBudget extends RetainedBudgetSnapshot {
  snapshotAt: number; snapshotStale: boolean; pressure: string; pressureKnown: boolean; coordinationReason: string | null;
  actions: RetainedAction[]; counters: ReturnType<typeof planRetainedBudget>['counters'] & { reclaimedBytes: number };
}
interface SnapshotOptions { cached?: boolean; measurements?: Record<string, unknown> | null; }
interface CoordinatorOptions extends ServerRamLimits { byteBudgetEnforced?: boolean; requiredParticipants?: readonly unknown[]; optionalParticipants?: readonly unknown[]; }

export const SERVER_RAM_LIMITS = Object.freeze({
  softLimitBytes: 64 * 1024 * 1024,
  hardLimitBytes: 128 * 1024 * 1024,
});

function finitePositiveLimit(value: unknown, fallback: number): number {
  try {
    const numeric = Number(value);
    const integer = Math.trunc(numeric);
    return Number.isFinite(numeric) && numeric > 0 && Number.isSafeInteger(integer)
      ? Math.max(1, integer)
      : fallback;
  } catch {
    return fallback;
  }
}

/** Normalize process-wide retained-RAM limits at every configuration boundary. */
export function normalizeServerRamLimits({ softLimitBytes, hardLimitBytes }: ServerRamLimits = {}) {
  const soft = finitePositiveLimit(softLimitBytes, SERVER_RAM_LIMITS.softLimitBytes);
  const hard = finitePositiveLimit(hardLimitBytes, SERVER_RAM_LIMITS.hardLimitBytes);
  return { softLimitBytes: soft, hardLimitBytes: Math.max(soft, hard) };
}

/** Deterministic coordinator. Participants are measured and reclaimed in fixed priority order. */
export class RetainedBudgetCoordinator {
  declare softLimitBytes: number; declare hardLimitBytes: number; declare byteBudgetEnforced: boolean;
  declare requiredParticipants: Set<string>; declare optionalParticipants: Set<string>;
  declare participants: Map<string, RetainedEntry>; declare running: boolean; declare last: PublishedRetainedBudget | null;
  declare diagnosticsRevision: number; declare reservedBytes: number; declare admission: AdmissionCounters;
  constructor({ softLimitBytes = SERVER_RAM_LIMITS.softLimitBytes, hardLimitBytes = SERVER_RAM_LIMITS.hardLimitBytes, byteBudgetEnforced = false, requiredParticipants = [], optionalParticipants = [] }: CoordinatorOptions = {}) {
    const limits = normalizeServerRamLimits({ softLimitBytes, hardLimitBytes });
    this.softLimitBytes = limits.softLimitBytes;
    this.hardLimitBytes = limits.hardLimitBytes;
    this.byteBudgetEnforced = byteBudgetEnforced;
    this.requiredParticipants = new Set(requiredParticipants.map(String));
    this.optionalParticipants = new Set(optionalParticipants.map(String));
    const overlappingParticipants = [...this.requiredParticipants].filter((name) => this.optionalParticipants.has(name));
    if (overlappingParticipants.length > 0) throw new TypeError('retained budget participants cannot be both required and optional: ' + overlappingParticipants.join(', '));
    this.participants = new Map(); this.running = false; this.last = null; this.diagnosticsRevision = 0; this.reservedBytes = 0; this.admission = { attempts: 0, admitted: 0, rejected: 0, released: 0, last: null };
  }
  snapshot({ cached = false, measurements = null }: SnapshotOptions = {}): RetainedBudgetSnapshot {
    const registered = [...this.participants.values()].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    const missingParticipants = [...this.requiredParticipants].filter((name) => !this.participants.has(name) || this.participants.get(name)?.participant.available === false);
    const unclassifiedParticipants = registered.map(({ name }) => name)
      .filter((name) => !this.requiredParticipants.has(name) && !this.optionalParticipants.has(name));
    const measures: Record<string, RetainedMeasurement> = {};
    const unmeasuredParticipants: string[] = [];
    let logicalBytes = 0;
    let aggregateMeasurementValid = true;
    for (const { name, participant } of registered) {
      let value: unknown;
      try {
        value = measurements && Object.prototype.hasOwnProperty.call(measurements, name)
          ? measurements[name]
          : participant.measure({ cached: cached === true });
      } catch {
        value = null;
      }
      const measuredBytes = value && typeof value === 'object' ? (value as { logicalBytes?: unknown }).logicalBytes : undefined;
      const measurementAvailable = typeof measuredBytes === 'number'
        && Number.isSafeInteger(measuredBytes)
        && measuredBytes >= 0;
      if (!measurementAvailable) unmeasuredParticipants.push(name);
      measures[name] = {
        ...(value && typeof value === 'object' ? value : {}),
        logicalBytes: measurementAvailable ? Number(measuredBytes) : null,
        measurementAvailable,
      };
      if (measurementAvailable) {
        if (!Number.isSafeInteger(logicalBytes + Number(measuredBytes))) aggregateMeasurementValid = false;
        else logicalBytes += Number(measuredBytes);
      }
    }
    const complete = this.requiredParticipants.size > 0 && missingParticipants.length === 0 && unclassifiedParticipants.length === 0;
    const measurementComplete = missingParticipants.length === 0 && unclassifiedParticipants.length === 0 && unmeasuredParticipants.length === 0 && aggregateMeasurementValid;
    if (!aggregateMeasurementValid) logicalBytes = Number.MAX_SAFE_INTEGER;
    const enforceableParticipants = this.byteBudgetEnforced && complete ? registered.filter(({ participant }) => participant.available !== false && participant.enforceable === true && typeof participant.reclaim === 'function').map(({ name }) => name) : [];
    const enforcedSet = new Set(enforceableParticipants);
    const unenforceableRequiredParticipants = [...this.requiredParticipants].filter((name) => !enforcedSet.has(name));
    const enforcementEligible = this.byteBudgetEnforced && complete && measurementComplete && unenforceableRequiredParticipants.length === 0;
    const reservedBytes = Math.max(0, Number(this.reservedBytes) || 0);
    const accountedLogicalBytes = measurementComplete ? logicalBytes + reservedBytes : null;
    const measurementError = !aggregateMeasurementValid
      ? 'logical-byte-total-overflow'
      : unmeasuredParticipants.length
        ? 'participant-measurement-unavailable'
        : unclassifiedParticipants.length
          ? 'participant-classification-incomplete'
          : null;
    return { logicalBytes: measurementComplete ? logicalBytes : null, partialLogicalBytes: measurementComplete ? null : logicalBytes, reservedBytes, accountedLogicalBytes, participants: measures, enforcedParticipants: enforceableParticipants, missingParticipants, optionalParticipants: registered.map(({ name }) => name).filter((name) => this.optionalParticipants.has(name)), unclassifiedParticipants, ownershipComplete: complete, unenforceableRequiredParticipants, unmeasuredParticipants, measurementComplete, measurementError, limits: { softLimitBytes: this.softLimitBytes, hardLimitBytes: this.hardLimitBytes }, enforcementScope: 'logical-retained-state-admission-only', physicalRamMeasured: false, enforcementEligible, hardLimitSatisfied: complete && measurementComplete && Number(accountedLogicalBytes) <= this.hardLimitBytes, byteBudgetEnforced: enforcementEligible && Number(accountedLogicalBytes) <= this.hardLimitBytes, admission: { ...this.admission } };
  }
  publishSnapshot(snapshot: RetainedBudgetSnapshot, { actions, reclaimedBytes, coordinationReason }: { actions?: RetainedAction[]; reclaimedBytes?: number; coordinationReason?: string } = {}): PublishedRetainedBudget {
    const reservedBytes = Math.max(0, Number(this.reservedBytes) || 0);
    const publishedActions = Array.isArray(actions) ? actions : this.last?.actions ?? [];
    const publishedReclaimedBytes = Number.isFinite(reclaimedBytes) ? Number(reclaimedBytes) : Number(this.last?.counters?.reclaimedBytes ?? 0);
    const publishedCoordinationReason = typeof coordinationReason === 'string' ? coordinationReason : this.last?.coordinationReason ?? null;
    const accountedLogicalBytes = snapshot.measurementComplete && Number.isSafeInteger(Number(snapshot.logicalBytes) + reservedBytes)
      ? Number(snapshot.logicalBytes) + reservedBytes
      : null;
    const measurementComplete = snapshot.measurementComplete && accountedLogicalBytes !== null;
    const measurementError = snapshot.measurementError ?? (snapshot.measurementComplete && !measurementComplete ? 'logical-byte-total-overflow' : null);
    const pressureKnown = snapshot.ownershipComplete && measurementComplete;
    const pressurePlan = planRetainedBudget({
      logicalBytes: Number(pressureKnown ? accountedLogicalBytes : snapshot.partialLogicalBytes),
      softLimitBytes: this.softLimitBytes,
      hardLimitBytes: this.hardLimitBytes,
      components: {},
    });
    this.last = {
      ...snapshot,
      snapshotAt: Date.now(),
      snapshotStale: false,
      reservedBytes,
      accountedLogicalBytes: measurementComplete ? accountedLogicalBytes : null,
      measurementComplete,
      measurementError,
      hardLimitSatisfied: snapshot.ownershipComplete && measurementComplete && Number(accountedLogicalBytes) <= this.hardLimitBytes,
      byteBudgetEnforced: snapshot.enforcementEligible && measurementComplete && Number(accountedLogicalBytes) <= this.hardLimitBytes,
      admission: { ...this.admission },
      pressure: pressureKnown ? pressurePlan.pressure : 'unknown',
      pressureKnown,
      coordinationReason: publishedCoordinationReason,
      actions: pressureKnown ? publishedActions : [],
      counters: {
        ...pressurePlan.counters,
        ...(pressureKnown ? {} : { planned: 0, withinBudget: false }),
        reclaimedBytes: publishedReclaimedBytes,
      },
    };
    this.diagnosticsRevision += 1;
    return this.last;
  }
  invalidateSnapshot() {
    if (this.last) this.last = { ...this.last, snapshotStale: true };
    this.diagnosticsRevision += 1;
    return this.last;
  }
  /**
   * Reserve logical serialized bytes before a retained allocation is applied.
   * Reservations are synchronous and must be released immediately after the
   * mutation commits. Missing required participants fail closed so a caller
   * cannot claim a hard cap while one owner is unavailable.
   */
  reserve(bytes: unknown, context: Record<string, unknown> = {}, { measurements = null }: SnapshotOptions = {}): RetainedAdmission {
    const numeric = (typeof bytes === 'number' || (typeof bytes === 'string' && bytes.trim() !== '')) ? Number(bytes) : Number.NaN;
    if (!Number.isSafeInteger(numeric) || numeric < 0) {
      const result = { admitted: false, enforced: this.byteBudgetEnforced, bytes: 0, reservedBytes: this.reservedBytes, reason: 'invalid-bytes', context };
      this.admission.attempts += 1;
      this.admission.last = result;
      this.admission.rejected += 1;
      return result;
    }
    const requested = numeric;
    this.admission.attempts += 1;
    // Reservation admission is the fail-closed boundary. A caller that has
    // already walked the current retained graph can provide those participant
    // measurements here; all omitted participants are measured fresh. This
    // avoids repeating the same graph walk while still rejecting stale caches.
    let before = this.snapshot({ cached: false, measurements });
    if (!this.byteBudgetEnforced) {
      const result = { admitted: true, enforced: false, bytes: requested, reservedBytes: this.reservedBytes, reason: 'budget-disabled', context };
      this.admission.last = result;
      this.admission.admitted += 1;
      this.publishSnapshot(before);
      return result;
    }
    const rejectIncompleteOwnership = (snapshot: RetainedBudgetSnapshot): RetainedAdmission | null => {
      let result: RetainedAdmission | null = null;
      if (snapshot.unclassifiedParticipants.length > 0) {
        result = { admitted: false, enforced: true, bytes: requested, reservedBytes: this.reservedBytes, reason: 'unclassified-retained-owner', unclassifiedParticipants: snapshot.unclassifiedParticipants, context };
      } else if (snapshot.unmeasuredParticipants.length > 0 || snapshot.measurementError === 'logical-byte-total-overflow' || snapshot.measurementError === 'participant-measurement-unavailable') {
        result = { admitted: false, enforced: true, bytes: requested, reservedBytes: this.reservedBytes, reason: 'participant-measurement-unavailable', unmeasuredParticipants: snapshot.unmeasuredParticipants, measurementError: snapshot.measurementError, context };
      } else if (!snapshot.enforcementEligible) {
        result = { admitted: false, enforced: true, bytes: requested, reservedBytes: this.reservedBytes, reason: 'required-participant-unavailable', missingParticipants: [...snapshot.missingParticipants, ...snapshot.unenforceableRequiredParticipants], context };
      }
      if (!result) return null;
      this.admission.last = result;
      this.admission.rejected += 1;
      this.publishSnapshot(snapshot);
      return result;
    };
    const incompleteOwnership = rejectIncompleteOwnership(before);
    if (incompleteOwnership) return incompleteOwnership;
    if (Number(before.accountedLogicalBytes) + requested > this.hardLimitBytes) {
      this.coordinate();
      before = this.snapshot({ cached: false });
      const incompleteAfterReclaim = rejectIncompleteOwnership(before);
      if (incompleteAfterReclaim) return incompleteAfterReclaim;
    }
    if (Number(before.accountedLogicalBytes) + requested > this.hardLimitBytes) {
      const result = { admitted: false, enforced: true, bytes: requested, reservedBytes: this.reservedBytes, reason: 'hard-limit', logicalBytes: before.logicalBytes, accountedLogicalBytes: before.accountedLogicalBytes, hardLimitBytes: this.hardLimitBytes, context };
      this.admission.last = result;
      this.admission.rejected += 1;
      this.publishSnapshot(before);
      return result;
    }
    if (requested > 0) this.reservedBytes += requested;
    const result = { admitted: true, enforced: true, bytes: requested, reservedBytes: this.reservedBytes, reason: null, context };
    this.admission.last = result;
    this.admission.admitted += 1;
    this.publishSnapshot(before);
    return result;
  }
  release(bytes: unknown) {
    const numeric = (typeof bytes === 'number' || (typeof bytes === 'string' && bytes.trim() !== '')) ? Number(bytes) : Number.NaN;
    if (!Number.isSafeInteger(numeric) || numeric < 0) return 0;
    const requested = numeric;
    const released = Math.min(this.reservedBytes, requested);
    this.reservedBytes -= released;
    this.admission.released += released;
    // The retained allocation may have changed while the reservation was
    // held, so the last measured owner totals are no longer current.
    this.invalidateSnapshot();
    return released;
  }
  coordinate({ targetLogicalRatio = null, targetLogicalBytes = null, reason = 'logical-budget' }: { targetLogicalRatio?: unknown; targetLogicalBytes?: unknown; reason?: string } = {}) {
    if (this.running) return { ...(this.last ?? { pressure: 'in-progress', actions: [], counters: {} }), recursionGuard: true, inProgress: true };
    this.running = true;
    try {
      let before = this.snapshot({ cached: false });
      const ratio = typeof targetLogicalRatio === 'number' && Number.isFinite(targetLogicalRatio) && targetLogicalRatio > 0 && targetLogicalRatio < 1
        ? targetLogicalRatio
        : null;
      const ratioTarget = ratio !== null && Number.isSafeInteger(before.accountedLogicalBytes)
        ? Math.floor(Number(before.accountedLogicalBytes) * ratio)
        : this.softLimitBytes;
      const fixedTarget = typeof targetLogicalBytes === 'number' && Number.isSafeInteger(targetLogicalBytes) && targetLogicalBytes >= 0
        ? targetLogicalBytes
        : ratioTarget;
      const targetBytes = Math.min(this.softLimitBytes, fixedTarget);
      const coordinationReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 96) : 'logical-budget';
      const actions: RetainedAction[] = [];
      let reclaimedBytes = 0;
      const ordered = [...this.participants.values()].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
      if (before.enforcementEligible) for (const entry of ordered) {
        if (Number(before.accountedLogicalBytes) <= targetBytes) break;
        const participantBytes = before.participants[entry.name]?.logicalBytes;
        if (!Number.isSafeInteger(participantBytes) || Number(participantBytes) <= 0) continue;
        if (entry.participant.available === false || entry.participant.enforceable !== true || typeof entry.participant.reclaim !== 'function') continue;
        const reclaimTargetBytes = Math.max(0, Number(before.accountedLogicalBytes) - targetBytes);
        const pressure = Number(before.accountedLogicalBytes) > this.hardLimitBytes ? 'hard' : Number(before.accountedLogicalBytes) > this.softLimitBytes ? 'soft' : 'none';
        const reclaimed = Math.max(0, Number(entry.participant.reclaim({ pressure, reason: coordinationReason, logicalBytes: before.logicalBytes, reservedBytes: before.reservedBytes, targetBytes: reclaimTargetBytes })) || 0);
        reclaimedBytes += reclaimed;
        actions.push({ participant: entry.name, targetBytes: reclaimTargetBytes, reclaimedBytes: reclaimed, reason: coordinationReason });
        before = this.snapshot({ cached: false });
      }
      return this.publishSnapshot(before, { actions, reclaimedBytes, coordinationReason });
    } finally { this.running = false; }
  }
}
