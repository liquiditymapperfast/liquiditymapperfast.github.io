export interface RepresentationSideCounts { bids: number | null; asks: number | null }
export interface RepresentationMetadataInput {
  stage?: unknown;
  limitPerSide?: unknown;
  inputLevelCount?: unknown;
  retainedLevelCount?: unknown;
  resolutionKey?: unknown;
  resolution?: unknown;
  grouping?: unknown;
  units?: unknown;
  coverage?: unknown;
  coverageBounds?: unknown;
  observedBounds?: unknown;
  sourceTimestamp?: unknown;
  [key: string]: unknown;
}
export interface RepresentationMetadata {
  stage: string;
  limitPerSide: RepresentationSideCounts | null;
  inputLevelCount: RepresentationSideCounts | null;
  retainedLevelCount: RepresentationSideCounts | null;
  resolutionKey: string | null;
  resolution: string | null;
  grouping: number | null;
  units: string | null;
  coverage: string;
  coverageBounds: unknown;
  observedBounds: unknown;
  sourceTimestamp: number | null;
  [key: string]: unknown;
}

/**
 * Explicit data-shape boundaries between the live book, transport snapshots,
 * bounded history, and the visual ladder.  These are policy limits, not
 * claims about how much depth an exchange actually supplied.
 */
export const DEFAULT_SERVER_BOOK_LEVELS_PER_SIDE = 2_000;
export const COMPACT_BOOK_LEVELS_PER_SIDE = 400;
export const HISTORY_DEPTH_LEVELS_PER_SIDE = 25;
export const HISTORY_SAMPLE_LIMIT = 20_000;
export const HEATMAP_CELLS_PER_BUCKET = 2_000;
export const HEATMAP_CELL_LIMIT = 2_000_000;
export const LADDER_ROWS = 96;
export const COMPACT_LADDER_ROWS = 36;
export const TABLE_ROWS = 32;
export const COMPACT_TABLE_ROWS = 16;

function perSide(value: unknown): RepresentationSideCounts {
  if (value && typeof value === 'object') {
    const side = (candidate: unknown) => Number.isInteger(Number(candidate)) && Number(candidate) >= 0 ? Number(candidate) : null;
    return { bids: side((value as { bids?: unknown }).bids), asks: side((value as { asks?: unknown }).asks) };
  }
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? { bids: numeric, asks: numeric } : { bids: null, asks: null };
}

/** Return a serializable policy description for API diagnostics and UI state. */
export function representationLimits({ serverLevelsPerSide = DEFAULT_SERVER_BOOK_LEVELS_PER_SIDE }: { serverLevelsPerSide?: unknown } = {}) {
  const server = Math.max(1, Math.trunc(Number(serverLevelsPerSide) || DEFAULT_SERVER_BOOK_LEVELS_PER_SIDE));
  return {
    version: 1,
    source: { stage: 'source-book', levelsPerSide: null, inputLevelsPerSide: null, units: 'venue-native' },
    server: { stage: 'server-state', levelsPerSide: server, inputLevelsPerSide: null, units: 'venue-native' },
    compact: { stage: 'compact-state-sse', levelsPerSide: COMPACT_BOOK_LEVELS_PER_SIDE, inputLevelsPerSide: server, units: 'venue-native' },
    history: {
      stage: 'depth-history',
      levelsPerSide: HISTORY_DEPTH_LEVELS_PER_SIDE,
      sampleLimit: HISTORY_SAMPLE_LIMIT,
      // History receives whichever selected server representation is active.
      // It is not guaranteed to receive the compact SSE cap.
      inputLevelsPerSide: null,
      inputStages: ['server-state', 'compact-state-sse'],
      units: 'venue-native',
    },
    heatmap: {
      stage: 'heatmap-history',
      sampleLimit: HISTORY_SAMPLE_LIMIT,
      cellsPerBucket: HEATMAP_CELLS_PER_BUCKET,
      cellLimit: HEATMAP_CELL_LIMIT,
      priceStep: 'configured',
      intervalMs: 'configured',
      units: 'venue-native',
    },
    renderer: {
      stage: 'ladder-renderer',
      ladderRows: LADDER_ROWS,
      compactLadderRows: COMPACT_LADDER_ROWS,
      tableRows: TABLE_ROWS,
      compactTableRows: COMPACT_TABLE_ROWS,
      units: 'usd-equivalent',
    },
  };
}

/**
 * Per-object provenance for one representation boundary.  Counts are kept
 * per side so asymmetric caps and empty sides remain truthful.
 */
export function representationMetadata({
  stage,
  limitPerSide = null,
  inputLevelCount = null,
  retainedLevelCount = null,
  resolutionKey = null,
  resolution = null,
  grouping = null,
  units = 'venue-native',
  coverage = 'unknown',
  coverageBounds = null,
  observedBounds = null,
  sourceTimestamp = null,
  ...extra
}: RepresentationMetadataInput = {}): RepresentationMetadata {
  return {
    stage: String(stage ?? 'unknown'),
    limitPerSide: limitPerSide == null ? null : perSide(limitPerSide),
    inputLevelCount: inputLevelCount == null ? null : perSide(inputLevelCount),
    retainedLevelCount: retainedLevelCount == null ? null : perSide(retainedLevelCount),
    resolutionKey: resolutionKey == null ? null : String(resolutionKey),
    resolution: resolution == null ? null : String(resolution),
    grouping: Number.isFinite(Number(grouping)) && Number(grouping) > 0 ? Number(grouping) : null,
    units: units == null ? null : String(units),
    coverage: String(coverage ?? 'unknown'),
    coverageBounds: coverageBounds ?? null,
    observedBounds: observedBounds ?? null,
    sourceTimestamp: sourceTimestamp == null ? null : Number.isFinite(Number(sourceTimestamp)) ? Number(sourceTimestamp) : null,
    ...extra,
  };
}
