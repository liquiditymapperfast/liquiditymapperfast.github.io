export type RetentionCoverage = 'complete' | 'partial' | 'gap' | 'unknown';
export interface RetentionFields { [key: string]: unknown; }
export interface RetentionInterval { start: number; end: number; }
export interface RetentionObservedSegment extends RetentionInterval { amount: number; notionalUsd: number; }
export interface NormalizedRetentionLevel {
  side: 'bid' | 'ask'; priceLow: number; priceHigh: number; amount: number; notionalUsd: number;
  sourceLevels: number; notionalEstimated: boolean;
}
export interface HeatmapRetentionCell extends NormalizedRetentionLevel {
  weightedAmount: number; weightedNotionalUsd: number; peakAmount: number; peakNotionalUsd: number;
  observedMs: number; observedIntervals: RetentionInterval[]; observedSegments: RetentionObservedSegment[];
}
export interface HeatmapRetentionBucketMeta {
  observedMs: number; completeMs: number; gapMs: number; observedIntervals: RetentionInterval[];
  gapIntervals: RetentionInterval[]; sourceTimestampMin?: number | null; sourceTimestampMax?: number | null;
  receivedAt: number; partial: boolean; coverage: RetentionCoverage; sourceResolution: string;
  sourceGrouping: number; gridEpoch: string;
}
export interface HeatmapRetentionRow extends RetentionFields {
  instrumentId: string; bucketStart: number; bucketEnd: number; priceLow: number | null; priceHigh: number | null;
  side: 'bid' | 'ask' | 'both'; meanAmount: number | null; meanNotionalUsd: number | null;
  peakAmount: number | null; peakNotionalUsd: number | null; observedMs: number; cellObservedMs: number;
  expectedMs: number; gapMs: number; observedIntervals: RetentionInterval[]; gapIntervals: RetentionInterval[];
  observedSegments?: RetentionObservedSegment[]; coverage: RetentionCoverage;
  sourceTimestampMin?: number | null; sourceTimestampMax?: number | null; receivedAt: number | null;
  sourceResolution: string; sourceGrouping: number; gridEpoch: string;
}
export interface HeatmapRetentionTombstone {
  instrumentId: string; lastTimestamp: number | null; integratedUntil: number | null; lastReceivedAt: number | null;
  sourceResolution: string; sourceGrouping: number; priceStep: number; gridEpoch: string;
  epochBarrier: number | null; accepted: number; ignored: number; gaps: number;
}
export interface HeatmapRetentionSource extends HeatmapRetentionTombstone {
  levels: NormalizedRetentionLevel[]; truncated: boolean; knownLevels: Map<string, NormalizedRetentionLevel>;
  buckets: Map<number, Map<string, HeatmapRetentionCell>>; bucketMeta: Map<number, HeatmapRetentionBucketMeta>;
  coverage: RetentionCoverage;
}
export interface HeatmapRetentionOptions {
  intervalMs?: unknown; priceStep?: unknown; maxGapMs?: unknown; maxGapBuckets?: unknown; maxClosedRows?: unknown;
  maxCellsPerBucket?: unknown; maxSourceLevels?: unknown; maxSources?: unknown; maxSourceTombstones?: unknown;
  sourceResolution?: unknown; sourceGrouping?: unknown;
}
export interface HeatmapRetentionIngestOptions {
  sourceTimestamp?: unknown; receivedAt?: unknown; coverage?: unknown; resolution?: unknown; grouping?: unknown;
}
export type HeatmapRetentionIngestResult =
  | { accepted: false; reason: 'source-capacity' | 'invalid-timestamp' | 'out-of-order' }
  | { accepted: true; closed: number; levelCount: number; truncated: boolean; gap?: boolean; epochGap: boolean };
export interface HeatmapRetentionSourceStats {
  activeCells: number; activeLevels: number; activeKnownLevels: number; bucketCount: number; bucketMetaCount: number;
  accepted: number; ignored: number; gaps: number; truncated: boolean; retainedBytesEstimate: number;
  bytesEstimate: number; tombstone?: boolean;
}
export interface HeatmapRetentionStats {
  sizeKind: 'record-count-estimate'; serializedBytesMeasured: false; instruments: number; activeSources: number;
  sourceTombstones: number; sourceCapacityRejects: number; activeCells: number; activeLevels: number;
  activeKnownLevels: number; activeBuckets: number; activeBucketMeta: number; truncatedSources: number;
  closedRows: number; droppedRows: number; retainedBytesEstimate: number; bytesEstimate: number;
  limits: { maxSources: number; maxSourceTombstones: number; maxSourceLevels: number; maxClosedRows: number; maxCellsPerBucket: number };
  sources: Record<string, HeatmapRetentionSourceStats>;
}
interface RetentionBookInput { bids?: Iterable<unknown> | null; asks?: Iterable<unknown> | null; }

function finitePositive(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
function addInterval(intervals: RetentionInterval[], start: unknown, end: unknown): void {
  const left = Number(start); const right = Number(end);
  if (!(Number.isFinite(left) && Number.isFinite(right) && right > left)) return;
  const next = { start: left, end: right };
  const output: RetentionInterval[] = []; let inserted = false;
  for (const current of Array.isArray(intervals) ? intervals : []) {
    const a = Number(current?.start); const b = Number(current?.end);
    if (!(Number.isFinite(a) && Number.isFinite(b) && b > a)) continue;
    if (b < next.start) { output.push({ start: a, end: b }); continue; }
    if (next.end < a) { if (!inserted) { output.push({ ...next }); inserted = true; } output.push({ start: a, end: b }); continue; }
    next.start = Math.min(next.start, a); next.end = Math.max(next.end, b);
  }
  if (!inserted) output.push({ ...next });
  intervals.splice(0, intervals.length, ...output.sort((a, b) => a.start - b.start));
}
function cloneIntervals(intervals: readonly RetentionInterval[] | null | undefined): RetentionInterval[] {
  return (Array.isArray(intervals) ? intervals : []).map((item) => ({ start: Number(item.start), end: Number(item.end) })).filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
}
function addObservedSegment(segments: RetentionObservedSegment[] | null | undefined, start: unknown, end: unknown, level: NormalizedRetentionLevel | null | undefined): void {
  const left = Number(start); const right = Number(end);
  const amount = Number(level?.amount); const notionalUsd = Number(level?.notionalUsd);
  if (!(Number.isFinite(left) && Number.isFinite(right) && right > left && amount > 0 && Number.isFinite(notionalUsd) && notionalUsd >= 0)) return;
  const prior = Array.isArray(segments) ? segments.at(-1) : null;
  if (prior && Number(prior.end) === left && Number(prior.amount) === amount && Number(prior.notionalUsd) === notionalUsd) {
    prior.end = right;
    return;
  }
  segments?.push({ start: left, end: right, amount, notionalUsd });
}
function cloneObservedSegments(segments: readonly RetentionObservedSegment[] | null | undefined): RetentionObservedSegment[] {
  return (Array.isArray(segments) ? segments : []).map((item) => ({ start: Number(item.start), end: Number(item.end), amount: Number(item.amount), notionalUsd: Number(item.notionalUsd) })).filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && Number.isFinite(item.amount) && item.amount > 0 && Number.isFinite(item.notionalUsd) && item.notionalUsd >= 0);
}
function decimalPlaces(value: unknown): number {
  const text = String(value).toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const exponent = exponentText == null ? 0 : Number(exponentText);
  return Math.max(0, Math.min(12, (coefficient.split('.')[1] ?? '').length - exponent));
}
function floorValidatedPriceBucket(price: number, step: number, stepPrecision: number): number {
  const scale = 10 ** Math.max(decimalPlaces(price), stepPrecision);
  const priceInt = Math.round(price * scale);
  const stepInt = Math.max(1, Math.round(step * scale));
  return Math.floor(priceInt / stepInt) * stepInt / scale;
}
function normalizeRows(rows: Iterable<unknown> | null | undefined, side: 'bid' | 'ask', priceStep: number, stepPrecision: number, maxCells: unknown = Number.MAX_SAFE_INTEGER): { cells: NormalizedRetentionLevel[]; truncated: boolean } {
  const cells = new Map<string, NormalizedRetentionLevel>();
  let truncated = false;
  const limit = Math.max(0, Number.isFinite(Number(maxCells)) ? Math.trunc(Number(maxCells)) : Number.MAX_SAFE_INTEGER);
  for (const item of rows ?? []) {
    const row = item as RetentionFields | readonly unknown[] | null | undefined;
    const price = finitePositive(Array.isArray(row) ? row[0] : (row as RetentionFields | null | undefined)?.price);
    const amount = finitePositive(Array.isArray(row) ? row[1] : (row as RetentionFields | null | undefined)?.amount);
    if (price == null || amount == null) continue;
    const lower = floorValidatedPriceBucket(price, priceStep, stepPrecision);
    if (lower == null) continue;
    const upper = lower + priceStep;
    const supplied = Number(Array.isArray(row) ? row[2] : (row as RetentionFields | null | undefined)?.notionalUsd);
    const hasSupplied = Number.isFinite(supplied) && supplied >= 0;
    const notional = hasSupplied ? supplied : price * amount;
    if (!Number.isFinite(notional) || notional < 0) continue;
    const key = side + '|' + lower;
    const existing = cells.get(key);
    if (!existing && cells.size >= limit) { truncated = true; continue; }
    const prior = existing ?? {
      side, priceLow: lower, priceHigh: upper, amount: 0, notionalUsd: 0, sourceLevels: 0,
      notionalEstimated: !hasSupplied,
    };
    prior.amount += amount;
    prior.notionalUsd += notional;
    prior.sourceLevels += 1;
    prior.notionalEstimated ||= !hasSupplied;
    cells.set(key, prior);
  }
  return { cells: [...cells.values()], truncated };
}
function normalizeRetentionLevelsBounded(input: unknown, priceStep: unknown, maxLevels: unknown = Number.MAX_SAFE_INTEGER): { levels: NormalizedRetentionLevel[]; truncated: boolean } {
  const book = input as RetentionBookInput | null | undefined;
  const step = finitePositive(priceStep);
  if (step == null) return { levels: [], truncated: false };
  const limit = Math.max(0, Number.isFinite(Number(maxLevels)) ? Math.trunc(Number(maxLevels)) : Number.MAX_SAFE_INTEGER);
  // The validated grouping step is constant for both sides of this batch.
  // Price-specific precision and the original integer rounding stay per row.
  const stepPrecision = decimalPlaces(step);
  const bids = normalizeRows(book?.bids, 'bid', step, stepPrecision, limit);
  const remaining = Math.max(0, limit - bids.cells.length);
  const asks = normalizeRows(book?.asks, 'ask', step, stepPrecision, remaining);
  return {
    levels: bids.cells.concat(asks.cells).sort((a, b) => a.priceLow - b.priceLow || a.side.localeCompare(b.side)),
    truncated: bids.truncated || asks.truncated,
  };
}
function bucketStart(timestamp: number, intervalMs: number): number {
  return Math.floor(timestamp / intervalMs) * intervalMs;
}
function boundedInteger(value: unknown, fallback: number, minimum: number): number {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= minimum ? numeric : fallback;
}
function compatibleRetentionStep(baseStep: unknown, sourceStep: unknown): number {
  const base = finitePositive(baseStep) ?? 1;
  const source = finitePositive(sourceStep) ?? base;
  if (Math.abs(source - base) <= Math.max(base, source) * 1e-10) return base;
  const ratioBase = base / source;
  const ratioSource = source / base;
  if (ratioBase >= 1 && Math.abs(ratioBase - Math.round(ratioBase)) <= 1e-8) return base;
  if (ratioSource >= 1 && Math.abs(ratioSource - Math.round(ratioSource)) <= 1e-8) return source;
  // The source grid is the only exact boundary available when neither grid
  // evenly coarsens the other. Never split that source cell into a claim of
  // finer precision.
  return source;
}
function coverageValue(value: unknown): RetentionCoverage {
  const text = String(value ?? '').toLowerCase();
  return text === 'complete' ? 'complete' : text === 'partial' ? 'partial' : text === 'gap' ? 'gap' : 'unknown';
}
function coverageRank(value: unknown): number {
  return value === 'complete' ? 2 : value === 'partial' ? 1 : 0;
}
function mergeCoverage(left: unknown, right: unknown): RetentionCoverage {
  const a = coverageValue(left);
  const b = coverageValue(right);
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  if (a === 'gap') return b === 'gap' ? 'gap' : 'partial';
  if (b === 'gap') return 'partial';
  return coverageRank(a) <= coverageRank(b) ? a : b;
}

/**
 * Bounded, timestamp-aware depth retention. Raw books remain in the caller's
 * live state; this buffer stores only grouped time-weighted cells after a
 * source interval closes. Unknown/gap time is never filled with zero.
 */
export class HeatmapRetentionBuffer {
  declare intervalMs: number;
  declare priceStep: number;
  declare maxGapMs: number;
  declare maxGapBuckets: number;
  declare maxClosedRows: number;
  declare maxCellsPerBucket: number;
  declare maxSourceLevels: number;
  declare maxSources: number;
  declare maxSourceTombstones: number;
  declare sourceResolution: string;
  declare sourceGrouping: number;
  declare sources: Map<string, HeatmapRetentionSource>;
  declare sourceTombstones: Map<string, HeatmapRetentionTombstone>;
  declare closedRows: HeatmapRetentionRow[];
  declare droppedRows: number;
  declare sourceCapacityRejects: number;
  constructor({
    intervalMs = 60_000,
    priceStep = 50,
    maxGapMs = 120_000,
    maxGapBuckets = 8,
    maxClosedRows = 200_000,
    maxCellsPerBucket = 2_000,
    maxSourceLevels = 4_000,
    maxSources = 64,
    maxSourceTombstones = null,
    sourceResolution = 'native',
    sourceGrouping = priceStep,
  }: HeatmapRetentionOptions = {}) {
    this.intervalMs = boundedInteger(intervalMs, 60_000, 1_000);
    this.priceStep = finitePositive(priceStep) ?? 50;
    this.maxGapMs = boundedInteger(maxGapMs, this.intervalMs * 2, this.intervalMs);
    this.maxGapBuckets = boundedInteger(maxGapBuckets, 8, 1);
    this.maxClosedRows = boundedInteger(maxClosedRows, 200_000, 1);
    this.maxCellsPerBucket = boundedInteger(maxCellsPerBucket, 2_000, 1);
    this.maxSourceLevels = boundedInteger(maxSourceLevels, 4_000, 1);
    this.maxSources = boundedInteger(maxSources, 64, 1);
    this.maxSourceTombstones = boundedInteger(maxSourceTombstones, Math.max(64, this.maxSources * 16), 1);
    this.sourceResolution = String(sourceResolution || 'native');
    this.sourceGrouping = finitePositive(sourceGrouping) ?? this.priceStep;
    this.sources = new Map<string, HeatmapRetentionSource>();
    this.sourceTombstones = new Map<string, HeatmapRetentionTombstone>();
    this.closedRows = [];
    this.droppedRows = 0;
    this.sourceCapacityRejects = 0;
  }
  #source(instrumentId: unknown): HeatmapRetentionSource | null {
    const key = String(instrumentId);
    let source = this.sources.get(key);
    if (source) return source;
    // The buffer cannot know which instruments are selected or whether a
    // closed row has reached durable storage. Never evict a source here: its
    // caller can retry after the history owner performs a selection-aware,
    // persisted reclamation pass.
    if (this.sources.size >= this.maxSources) return null;
    source = {
      instrumentId: key,
      lastTimestamp: null,
      integratedUntil: null,
      lastReceivedAt: null,
      levels: [],
      truncated: false,
      knownLevels: new Map<string, NormalizedRetentionLevel>(),
      buckets: new Map<number, Map<string, HeatmapRetentionCell>>(),
      bucketMeta: new Map<number, HeatmapRetentionBucketMeta>(),
      priceStep: this.priceStep,
      sourceResolution: this.sourceResolution,
      sourceGrouping: this.sourceGrouping,
      gridEpoch: String(this.sourceResolution) + '|' + String(this.sourceGrouping) + '|' + String(this.priceStep) + '@' + this.intervalMs,
      coverage: 'unknown',
      epochBarrier: null,
      accepted: 0,
      ignored: 0,
      gaps: 0,
    };
    const tombstone = this.sourceTombstones.get(key);
    if (tombstone) {
      source.lastTimestamp = tombstone.lastTimestamp;
      source.integratedUntil = tombstone.integratedUntil;
      source.lastReceivedAt = tombstone.lastReceivedAt;
      source.sourceResolution = tombstone.sourceResolution;
      source.sourceGrouping = tombstone.sourceGrouping;
      source.priceStep = tombstone.priceStep;
      source.gridEpoch = tombstone.gridEpoch;
      source.coverage = 'unknown';
      source.epochBarrier = tombstone.epochBarrier;
      source.accepted = tombstone.accepted;
      source.ignored = tombstone.ignored;
      source.gaps = tombstone.gaps;
      this.sourceTombstones.delete(key);
    }
    this.sources.set(key, source);
    return source;
  }
  rejectSourceCapacity(): { accepted: false; reason: 'source-capacity' } {
    this.sourceCapacityRejects += 1;
    return { accepted: false, reason: 'source-capacity' };
  }
  #meta(source: HeatmapRetentionSource, start: number): HeatmapRetentionBucketMeta {
    let meta = source.bucketMeta.get(start);
    if (!meta) {
      meta = {
        observedMs: 0,
        completeMs: 0,
        gapMs: 0,
        observedIntervals: [],
        gapIntervals: [],
        sourceTimestampMin: null,
        sourceTimestampMax: null,
        receivedAt: 0,
        partial: false,
        coverage: source.coverage,
        sourceResolution: source.sourceResolution,
        sourceGrouping: source.sourceGrouping,
        gridEpoch: source.gridEpoch,
      };
      source.bucketMeta.set(start, meta);
    }
    return meta;
  }
  #rememberLevels(source: HeatmapRetentionSource, levels: readonly NormalizedRetentionLevel[]): void {
    for (const level of levels) {
      const key = level.side + '|' + level.priceLow;
      source.knownLevels.set(key, level);
    }
    while (source.knownLevels.size > this.maxSourceLevels) {
      const first = source.knownLevels.keys().next().value;
      if (first == null) break;
      source.knownLevels.delete(first);
    }
  }
  #integrateSegment(source: HeatmapRetentionSource, from: number, to: number): void {
    let cursor = from;
    while (cursor < to) {
      const start = bucketStart(cursor, this.intervalMs);
      const end = Math.min(to, start + this.intervalMs);
      const duration = end - cursor;
      if (!(duration > 0)) break;
      const meta = this.#meta(source, start);
      meta.observedMs += duration;
      addInterval(meta.observedIntervals, cursor, end);
      if (source.coverage === 'complete') meta.completeMs += duration;
      meta.coverage = mergeCoverage(meta.coverage, source.coverage);
      if (source.truncated) {
        meta.partial = true;
        meta.coverage = mergeCoverage(meta.coverage, 'partial');
      }
      meta.sourceTimestampMin = meta.sourceTimestampMin == null ? cursor : Math.min(meta.sourceTimestampMin, cursor);
      meta.sourceTimestampMax = Math.max(meta.sourceTimestampMax ?? 0, end);
      meta.receivedAt = Math.max(meta.receivedAt, source.lastReceivedAt ?? 0);
      const cells = source.buckets.get(start) ?? new Map<string, HeatmapRetentionCell>();
      if (!source.buckets.has(start)) source.buckets.set(start, cells);
      const active = new Map(source.levels.map((level) => [level.side + '|' + level.priceLow, level]));
      // A complete snapshot is authoritative. An omitted level ended at the
      // snapshot timestamp, so never carry it forward from knownLevels.
      const keys = active.keys();
      for (const key of keys) {
        const level = active.get(key);
        const reference = level;
        if (!reference) continue;
        if (!cells.has(key) && cells.size >= this.maxCellsPerBucket) {
          meta.partial = true;
          meta.coverage = mergeCoverage(meta.coverage, 'partial');
          continue;
        }
        const prior = cells.get(key) ?? {
          ...reference,
          weightedAmount: 0,
          weightedNotionalUsd: 0,
          peakAmount: 0,
          peakNotionalUsd: 0,
          observedMs: 0,
          observedIntervals: [],
          observedSegments: [],
        };
        if (level) {
          prior.observedMs += duration;
          addInterval(prior.observedIntervals, cursor, end);
          addObservedSegment(prior.observedSegments, cursor, end, level);
          prior.weightedAmount += level.amount * duration;
          prior.weightedNotionalUsd += level.notionalUsd * duration;
          prior.peakAmount = Math.max(prior.peakAmount, level.amount);
          prior.peakNotionalUsd = Math.max(prior.peakNotionalUsd, level.notionalUsd);
        }
        cells.set(key, prior);
      }
      cursor = end;
    }
  }
  #markGap(source: HeatmapRetentionSource, from: number, to: number): void {
    const duration = Math.max(0, to - from);
    source.gaps += 1;
    if (!(duration > 0)) return;
    if (duration > this.maxGapBuckets * this.intervalMs) {
      const start = bucketStart(from, this.intervalMs);
      const end = bucketStart(Math.max(from, to - 1), this.intervalMs) + this.intervalMs;
      this.#pushClosed({
        instrumentId: source.instrumentId,
        bucketStart: start,
        bucketEnd: end,
        priceLow: null,
        priceHigh: null,
        side: 'both',
        meanAmount: null,
        meanNotionalUsd: null,
        peakAmount: null,
        peakNotionalUsd: null,
        observedMs: 0,
        cellObservedMs: 0,
        expectedMs: Math.max(this.intervalMs, end - start),
        gapMs: duration,
        observedIntervals: [],
        gapIntervals: [{ start: from, end: to }],
        coverage: 'gap',
        sourceTimestampMin: from,
        sourceTimestampMax: to,
        receivedAt: source.lastReceivedAt,
        sourceResolution: source.sourceResolution,
        sourceGrouping: source.sourceGrouping,
        gridEpoch: source.gridEpoch,
      });
      return;
    }
    let cursor = from;
    while (cursor < to) {
      const start = bucketStart(cursor, this.intervalMs);
      const end = Math.min(to, start + this.intervalMs);
      const meta = this.#meta(source, start);
      meta.gapMs += end - cursor;
      addInterval(meta.gapIntervals, cursor, end);
      meta.partial = true;
      meta.coverage = meta.observedMs > 0 || meta.coverage === 'complete' || meta.coverage === 'partial'
        ? 'partial'
        : 'gap';
      cursor = end;
    }
  }
  #closeBefore(source: HeatmapRetentionSource, cutoff: number): void {
    const starts = new Set([...source.buckets.keys(), ...source.bucketMeta.keys()]);
    for (const start of [...starts].sort((a, b) => a - b)) {
      if (start + this.intervalMs > cutoff) continue;
      const cells = source.buckets.get(start) ?? new Map<string, HeatmapRetentionCell>();
      const meta: HeatmapRetentionBucketMeta = source.bucketMeta.get(start) ?? {
        observedMs: 0,
        completeMs: 0,
        gapMs: 0,
        observedIntervals: [],
        gapIntervals: [],
        receivedAt: 0,
        partial: true,
        coverage: 'unknown',
        sourceResolution: source.sourceResolution,
        sourceGrouping: source.sourceGrouping,
        gridEpoch: source.gridEpoch,
      };
      const coverage = meta.coverage === 'unknown'
        ? 'unknown'
        : meta.gapMs > 0
          ? (meta.observedMs > 0 ? 'partial' : 'gap')
          : meta.coverage === 'partial'
            ? 'partial'
            : meta.observedMs >= this.intervalMs && !meta.partial
              ? 'complete'
              : meta.observedMs > 0 ? 'partial' : 'unknown';
      if (!cells.size) {
        this.#pushClosed({
          instrumentId: source.instrumentId,
          bucketStart: start,
          bucketEnd: start + this.intervalMs,
          priceLow: null,
          priceHigh: null,
          side: 'both',
          meanAmount: null,
          meanNotionalUsd: null,
          peakAmount: null,
          peakNotionalUsd: null,
          observedMs: meta.observedMs,
          cellObservedMs: 0,
          expectedMs: this.intervalMs,
          gapMs: meta.gapMs,
          observedIntervals: cloneIntervals(meta.observedIntervals),
          gapIntervals: cloneIntervals(meta.gapIntervals),
          coverage,
          sourceTimestampMin: meta.sourceTimestampMin,
          sourceTimestampMax: meta.sourceTimestampMax,
          receivedAt: meta.receivedAt,
          sourceResolution: meta.sourceResolution,
          sourceGrouping: meta.sourceGrouping,
          gridEpoch: meta.gridEpoch,
        });
      } else {
        for (const cell of cells.values()) {
          this.#pushClosed({
            instrumentId: source.instrumentId,
            bucketStart: start,
            bucketEnd: start + this.intervalMs,
            priceLow: cell.priceLow,
            priceHigh: cell.priceHigh,
            side: cell.side,
            meanAmount: cell.observedMs > 0 ? cell.weightedAmount / cell.observedMs : null,
            meanNotionalUsd: cell.observedMs > 0 ? cell.weightedNotionalUsd / cell.observedMs : null,
            peakAmount: cell.peakAmount,
            peakNotionalUsd: cell.peakNotionalUsd,
            observedMs: meta.observedMs,
            cellObservedMs: cell.observedMs,
            expectedMs: this.intervalMs,
            gapMs: meta.gapMs,
            observedIntervals: cloneIntervals(cell.observedIntervals),
            observedSegments: cloneObservedSegments(cell.observedSegments),
            gapIntervals: cloneIntervals(meta.gapIntervals),
            coverage,
            sourceTimestampMin: meta.sourceTimestampMin,
            sourceTimestampMax: meta.sourceTimestampMax,
            receivedAt: meta.receivedAt,
            sourceResolution: meta.sourceResolution,
            sourceGrouping: meta.sourceGrouping,
            gridEpoch: meta.gridEpoch,
          });
        }
      }
      source.buckets.delete(start);
      source.bucketMeta.delete(start);
    }
  }
  #pushClosed(row: HeatmapRetentionRow): void {
    this.closedRows.push(row);
    if (this.closedRows.length > this.maxClosedRows) {
      this.closedRows.splice(0, this.closedRows.length - this.maxClosedRows);
      this.droppedRows += 1;
    }
  }
  reclaimSourceForBudget(instrumentId: unknown): { rows: number; boundary: number } | null {
    const key = String(instrumentId);
    const source = this.sources.get(key);
    if (!source || source.lastTimestamp == null || source.epochBarrier != null) return null;
    if (!source.levels.length && !source.knownLevels.size && !source.buckets.size && !source.bucketMeta.size) return null;
    if (this.sourceTombstones.size >= this.maxSourceTombstones && !this.sourceTombstones.has(key)) return null;

    const timestamp = Number(source.lastTimestamp);
    const integratedUntil = Number(source.integratedUntil);
    const from = Math.max(timestamp, Number.isFinite(integratedUntil) ? integratedUntil : timestamp);
    const boundary = bucketStart(timestamp, this.intervalMs) + this.intervalMs;
    if (!(boundary >= from)) return null;

    // Closing a source must not push older canonical rows out of the bounded
    // write queue. Include the final, uncovered tail in the preflight count so
    // the mutation below cannot overflow maxClosedRows.
    const starts = new Set([...source.buckets.keys(), ...source.bucketMeta.keys()]);
    if (from < boundary) starts.add(bucketStart(from, this.intervalMs));
    let requiredRows = 0;
    for (const start of starts) {
      if (start + this.intervalMs > boundary) continue;
      requiredRows += Math.max(1, source.buckets.get(start)?.size ?? 0);
    }
    if (!(requiredRows > 0) || this.closedRows.length + requiredRows > this.maxClosedRows) return null;

    const before = this.closedRows.length;
    if (from < boundary) this.#markGap(source, from, boundary);
    this.#closeBefore(source, boundary);
    const rows = this.closedRows.length - before;

    // Move only continuity metadata into a separately bounded tombstone map.
    // A later rejoin must cross this bucket boundary and start a new observed
    // interval; it cannot overlap the partial column just emitted above.
    this.sourceTombstones.set(key, {
      instrumentId: key,
      lastTimestamp: source.lastTimestamp,
      integratedUntil: boundary,
      lastReceivedAt: source.lastReceivedAt,
      sourceResolution: source.sourceResolution,
      sourceGrouping: source.sourceGrouping,
      priceStep: source.priceStep,
      gridEpoch: source.gridEpoch,
      epochBarrier: boundary,
      accepted: source.accepted,
      ignored: source.ignored,
      gaps: source.gaps,
    });
    source.levels = [];
    source.knownLevels.clear();
    source.buckets.clear();
    source.bucketMeta.clear();
    source.truncated = false;
    source.coverage = 'unknown';
    source.integratedUntil = boundary;
    source.epochBarrier = boundary;
    this.sources.delete(key);
    return { rows, boundary };
  }
  ingest(instrumentId: unknown, book: unknown, { sourceTimestamp, receivedAt = Date.now(), coverage = 'complete', resolution = this.sourceResolution, grouping = this.sourceGrouping }: HeatmapRetentionIngestOptions = {}): HeatmapRetentionIngestResult {
    const source = this.#source(instrumentId);
    if (!source) return this.rejectSourceCapacity();
    const timestamp = Number(sourceTimestamp);
    if (!(timestamp > 0) || !Number.isFinite(timestamp)) {
      source.ignored += 1;
      return { accepted: false, reason: 'invalid-timestamp' };
    }
    const incomingCoverage = coverageValue(coverage);
    const sourceStep = finitePositive(grouping) ?? this.priceStep;
    const effectiveStep = compatibleRetentionStep(this.priceStep, sourceStep);
    const incomingResolution = String(resolution || this.sourceResolution);
    const incomingEpoch = incomingResolution + '|' + sourceStep + '|' + effectiveStep + '@' + this.intervalMs;
    const normalized = normalizeRetentionLevelsBounded(book, effectiveStep, this.maxSourceLevels);
    const levels = normalized.levels;
    if (source.lastTimestamp != null && timestamp < source.lastTimestamp) {
      source.ignored += 1;
      return { accepted: false, reason: 'out-of-order' };
    }
    if (source.epochBarrier != null && timestamp < source.epochBarrier) {
      source.sourceResolution = incomingResolution;
      source.sourceGrouping = sourceStep;
      source.priceStep = effectiveStep;
      source.gridEpoch = incomingEpoch;
      source.levels = levels;
      source.truncated = normalized.truncated;
      source.coverage = incomingCoverage;
      source.lastReceivedAt = Number(receivedAt) > 0 ? Number(receivedAt) : source.lastReceivedAt;
      source.lastTimestamp = timestamp;
      this.#rememberLevels(source, levels);
      source.accepted += 1;
      return { accepted: true, closed: this.closedRows.length, levelCount: levels.length, truncated: normalized.truncated, epochGap: true };
    }
    if (source.epochBarrier != null && timestamp >= source.epochBarrier) {
      source.integratedUntil = Math.max(Number(source.integratedUntil) || 0, source.epochBarrier);
      source.epochBarrier = null;
    }
    const priorTimestamp = source.lastTimestamp;
    const priorCoverage = source.coverage;
    const gridChanged = priorTimestamp != null && source.gridEpoch !== incomingEpoch;
    if (priorTimestamp != null) {
      const duration = timestamp - priorTimestamp;
      const from = Math.max(priorTimestamp, Number(source.integratedUntil) || priorTimestamp);
      if (duration > 0) {
        if (duration <= this.maxGapMs && priorCoverage !== 'unknown') {
          if (from < timestamp) this.#integrateSegment(source, from, timestamp);
        } else {
          this.#markGap(source, Math.max(from, priorTimestamp), timestamp);
        }
      }
      source.integratedUntil = timestamp;
      if (gridChanged) {
        const boundary = bucketStart(timestamp, this.intervalMs) + this.intervalMs;
        if (timestamp % this.intervalMs !== 0) {
          const current = bucketStart(timestamp, this.intervalMs);
          const meta = this.#meta(source, current);
          meta.gapMs += Math.max(0, boundary - timestamp);
          addInterval(meta.gapIntervals, timestamp, boundary);
          meta.partial = true;
          meta.coverage = mergeCoverage(meta.coverage, 'partial');
          this.#closeBefore(source, boundary);
          source.epochBarrier = boundary;
          source.integratedUntil = boundary;
        } else {
          this.#closeBefore(source, timestamp);
        }
      } else {
        this.#closeBefore(source, timestamp);
      }
    }
    if (gridChanged) source.knownLevels.clear();
    source.sourceResolution = incomingResolution;
    source.sourceGrouping = sourceStep;
    source.priceStep = effectiveStep;
    source.gridEpoch = incomingEpoch;
    source.coverage = incomingCoverage;
    source.lastReceivedAt = Number(receivedAt) > 0 ? Number(receivedAt) : source.lastReceivedAt;
    source.levels = levels;
    source.truncated = normalized.truncated;
    this.#rememberLevels(source, levels);
    source.lastTimestamp = timestamp;
    source.integratedUntil = source.integratedUntil == null ? timestamp : source.integratedUntil;
    source.accepted += 1;
    return { accepted: true, closed: this.closedRows.length, levelCount: levels.length, truncated: normalized.truncated, gap: priorTimestamp != null && timestamp - priorTimestamp > this.maxGapMs, epochGap: gridChanged };
  }
  flush(now: unknown = Date.now()): number {
    const timestamp = Number(now);
    if (!(timestamp > 0)) return 0;
    for (const source of this.sources.values()) {
      if (source.lastTimestamp == null) continue;
      // Flush only observations already backed by source time; never extend
      // stale levels or bypass a mid-bucket epoch barrier.
      const cutoff = Math.min(timestamp, Number(source.lastTimestamp));
      if (cutoff > 0) this.#closeBefore(source, cutoff);
    }
    return this.closedRows.length;
  }
  latestTimestamp(): number {
    let latest = 0;
    for (const source of this.sources.values()) latest = Math.max(latest, Number(source.lastTimestamp) || 0);
    return latest;
  }
  peekClosed(): HeatmapRetentionRow[] {
    return this.closedRows;
  }
  drainClosed(): HeatmapRetentionRow[] {
    const rows = this.closedRows;
    this.closedRows = [];
    return rows;
  }
  drainClosedRows(rows: readonly unknown[] = []): number {
    const selected = new Set(Array.isArray(rows) ? rows : []);
    if (!selected.size) return 0;
    const before = this.closedRows.length;
    this.closedRows = this.closedRows.filter((row) => !selected.has(row));
    return before - this.closedRows.length;
  }
  stats(): HeatmapRetentionStats {
    let activeCells = 0;
    let activeKnownLevels = 0;
    let activeLevels = 0;
    let activeBuckets = 0;
    let activeBucketMeta = 0;
    const sources: Record<string, HeatmapRetentionSourceStats> = {};
    for (const source of this.sources.values()) {
      activeKnownLevels += source.knownLevels.size;
      activeLevels += source.levels.length;
      activeBuckets += source.buckets.size;
      activeBucketMeta += source.bucketMeta.size;
      let sourceCells = 0;
      for (const cells of source.buckets.values()) { activeCells += cells.size; sourceCells += cells.size; }
      sources[source.instrumentId] = {
        activeCells: sourceCells,
        activeLevels: source.levels.length,
        activeKnownLevels: source.knownLevels.size,
        bucketCount: source.buckets.size,
        bucketMetaCount: source.bucketMeta.size,
        accepted: source.accepted,
        ignored: source.ignored,
        gaps: source.gaps,
        truncated: source.truncated,
        retainedBytesEstimate: (sourceCells + source.knownLevels.size + source.levels.length + source.buckets.size + source.bucketMeta.size) * 96,
        bytesEstimate: (sourceCells + source.knownLevels.size + source.levels.length + source.buckets.size + source.bucketMeta.size) * 96,
      };
    }
    for (const tombstone of this.sourceTombstones.values()) {
      sources[tombstone.instrumentId] = {
        activeCells: 0,
        activeLevels: 0,
        activeKnownLevels: 0,
        bucketCount: 0,
        bucketMetaCount: 0,
        accepted: tombstone.accepted,
        ignored: tombstone.ignored,
        gaps: tombstone.gaps,
        truncated: false,
        tombstone: true,
        retainedBytesEstimate: 96,
        bytesEstimate: 96,
      };
    }
    return {
      sizeKind: 'record-count-estimate',
      serializedBytesMeasured: false,
      instruments: this.sources.size + this.sourceTombstones.size,
      activeSources: this.sources.size,
      sourceTombstones: this.sourceTombstones.size,
      sourceCapacityRejects: this.sourceCapacityRejects,
      activeCells,
      activeLevels,
      activeBuckets,
      activeBucketMeta,
      truncatedSources: [...this.sources.values()].filter((source) => source.truncated).length,
      activeKnownLevels,
      closedRows: this.closedRows.length,
      droppedRows: this.droppedRows,
      retainedBytesEstimate: (activeCells + activeKnownLevels + activeLevels + activeBuckets + activeBucketMeta + this.closedRows.length + this.sourceTombstones.size) * 96,
      bytesEstimate: (activeCells + activeKnownLevels + activeLevels + activeBuckets + activeBucketMeta + this.closedRows.length + this.sourceTombstones.size) * 96,
      limits: {
        maxSources: this.maxSources,
        maxSourceTombstones: this.maxSourceTombstones,
        maxSourceLevels: this.maxSourceLevels,
        maxClosedRows: this.maxClosedRows,
        maxCellsPerBucket: this.maxCellsPerBucket,
      },
      sources,
    };
  }
}
