export interface RetainedFeedBudgetState {
  depthBuffers?: Record<string, unknown>;
  depthBridgePending?: Record<string, unknown>;
  resyncing?: readonly unknown[];
}
export interface RetainedBudgetOptions {
  logicalBytes?: unknown;
  components?: Record<string, unknown>;
  feeds?: RetainedFeedBudgetState | null;
  softLimitBytes?: unknown;
  hardLimitBytes?: unknown;
  previousPressure?: unknown;
}
export interface RetainedBudgetAction {
  type: 'prune' | 'defer' | 'invalidate-resnapshot';
  target: string;
  bytes?: number;
  rows?: number;
  sizeKind?: string;
  safe: boolean;
  failureClosed?: boolean;
  metadataRequired?: boolean;
  requiresRemeasure: boolean;
  reason: string;
}

export const RETAINED_BUDGET_DEFAULTS = Object.freeze({ softLimitBytes: 64 * 1024 * 1024, hardLimitBytes: 128 * 1024 * 1024 });

/** Pure deterministic pressure planner. It returns actions; callers perform them. */
export function planRetainedBudget({ logicalBytes = 0, components = {}, feeds = {}, softLimitBytes = RETAINED_BUDGET_DEFAULTS.softLimitBytes, hardLimitBytes = RETAINED_BUDGET_DEFAULTS.hardLimitBytes, previousPressure = 'none' }: RetainedBudgetOptions = {}) {
  const total = Math.max(0, Number(logicalBytes) || 0);
  const soft = Math.max(1, Number(softLimitBytes) || RETAINED_BUDGET_DEFAULTS.softLimitBytes);
  const hard = Math.max(soft, Number(hardLimitBytes) || RETAINED_BUDGET_DEFAULTS.hardLimitBytes);
  const pressure = total > hard ? 'hard' : total > soft ? 'soft' : 'none';
  const actions: RetainedBudgetAction[] = [];
  const eligible = new Set(Array.isArray(components.eligible) ? components.eligible : []);
  if (pressure !== 'none') for (const key of ['pendingSse', 'history', 'sessionHeatmap', 'oiHistory', 'depthHistory']) if (eligible.has(key) && Number(components[key]) > 0) actions.push({ type: 'prune', target: key, bytes: Number(components[key]), safe: true, failureClosed: key === 'history', metadataRequired: key === 'history', requiresRemeasure: true, reason: 'retained-budget' });
  if (pressure === 'hard') {
    for (const [key, value] of Object.entries(feeds?.depthBuffers ?? {})) {
      const hasBridgeMetadata = feeds?.depthBridgePending && Object.prototype.hasOwnProperty.call(feeds.depthBridgePending, key);
      const hasResyncMetadata = Array.isArray(feeds?.resyncing);
      const bridged = !hasBridgeMetadata || !hasResyncMetadata || feeds!.depthBridgePending![key] === true || feeds!.resyncing!.includes(key);
      actions.push({ type: bridged ? 'defer' : 'invalidate-resnapshot', target: `depthBuffer:${key}`, rows: Number(value) || 0, sizeKind: 'rows-not-bytes', safe: !bridged, requiresRemeasure: true, reason: bridged ? 'active-bridge-or-resync' : 'retained-budget' });
    }
  }
  return { pressure, logicalBytes: total, softLimitBytes: soft, hardLimitBytes: hard, actions, counters: { planned: actions.length, deferredBridges: actions.filter((a) => a.type === 'defer').length, invalidations: actions.filter((a) => a.type === 'invalidate-resnapshot').length, withinBudget: pressure === 'none', recovery: previousPressure !== 'none' && pressure === 'none' } };
}
