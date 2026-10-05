import test from 'node:test';
import assert from 'node:assert/strict';
import { planRetainedBudget } from '../src/core/retained-budget.mts';

test('retained budget planner reports no pressure and recovery', () => {
  const result = planRetainedBudget({ logicalBytes: 10, components: { history: 100 } });
  assert.equal(result.pressure, 'none'); assert.equal(result.counters.withinBudget, true); assert.equal(result.counters.recovery, false); assert.deepEqual(result.actions, []);
});

test('soft pressure plans only rehydratable history/session pruning', () => {
  const result = planRetainedBudget({ logicalBytes: 70, softLimitBytes: 64, hardLimitBytes: 128, components: { history: 20, pendingSse: 5, sessionHeatmap: 7, eligible: ['history', 'pendingSse', 'sessionHeatmap'] } });
  assert.equal(result.pressure, 'soft'); assert.deepEqual(result.actions.map((a) => a.target), ['pendingSse', 'history', 'sessionHeatmap']); assert.equal(result.actions[0].requiresRemeasure, true);
});

test('populated components stay protected unless explicitly eligible', () => {
  const result = planRetainedBudget({ logicalBytes: 70, softLimitBytes: 64, hardLimitBytes: 128, components: { history: 20, pendingSse: 5, sessionHeatmap: 7 } });
  assert.equal(result.pressure, 'soft');
  assert.deepEqual(result.actions, []);
});

test('hard pressure invalidates safe depth buffers and defers active bridges', () => {
  const result = planRetainedBudget({ logicalBytes: 140, softLimitBytes: 64, hardLimitBytes: 128, components: { history: 20, eligible: ['history'] }, feeds: { depthBuffers: { safe: 10, bridge: 11 }, depthBridgePending: { safe: false, bridge: true }, resyncing: [] } });
  assert.equal(result.pressure, 'hard'); assert.equal(result.counters.invalidations, 1); assert.equal(result.counters.deferredBridges, 1);
  assert.equal((result.actions.find((a) => a.target === 'depthBuffer:safe'))!.type, 'invalidate-resnapshot');
  assert.equal((result.actions.find((a) => a.target === 'depthBuffer:bridge'))!.type, 'defer');
  assert.equal((result.actions.find((a) => a.target === 'depthBuffer:safe'))!.sizeKind, 'rows-not-bytes');
});

test('hard pressure defers an in-flight resync and missing sync metadata', () => {
  const result = planRetainedBudget({ logicalBytes: 140, softLimitBytes: 64, hardLimitBytes: 128, feeds: { depthBuffers: { resync: 12, unknown: 4 }, depthBridgePending: { resync: false }, resyncing: ['resync'] } });
  assert.equal((result.actions.find((a) => a.target === 'depthBuffer:resync'))!.type, 'defer');
  assert.equal((result.actions.find((a) => a.target === 'depthBuffer:unknown'))!.type, 'defer');
});
