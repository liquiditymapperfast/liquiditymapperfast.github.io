import { decodeNativeBookWireAliases } from './native-book-wire-aliases.mts';
import type { RuntimeStatus } from '../domain/runtime-state.mts';
import { scanBoundedJsonComplexity } from './bounded-json-response.mts';
import { LIVE_LIQUIDITY_HARD_WIRE_BYTES } from './liquidity-wire-bound.mts';
/** Complete book snapshots use their own epoch and sequence, independent of marks. */
export const LIVE_LIQUIDITY_MAX_FRAME_BYTES = LIVE_LIQUIDITY_HARD_WIRE_BYTES;
export const LIVE_LIQUIDITY_MAX_JSON_DEPTH = 32;
const frameKeys: ReadonlySet<string> = new Set(['sessionId', 'sequence', 'receivedAt', 'emittedAt', 'books', 'booksByKey', 'activeBookKeys', 'bookSelection', 'bookStatuses', 'feedStatuses', 'sourceTimestamps']);
const bookKeys: ReadonlySet<string> = new Set(['bids', 'asks', 'instrumentId', 'bookKey', 'resolutionKey', 'feedId', 'complete', 'gap', 'invalidated', 'resyncRequired', 'invalidReason', 'sequence', 'sourceTimestamp', 'receivedAt', 'resolution', 'nSigFigs', 'mantissa', 'sourceGrouping', 'grouping', 'sourceDepth', 'sourceInterval', 'coverage', 'coverageBounds', 'observedBounds', 'sourceLevelCount', 'retainedLevelCount', 'retentionTruncated', 'representation', 'units', 'contractValue', 'pool', 'sourceKey', 'sourceRevision', 'levelMetadata', 'status']);
