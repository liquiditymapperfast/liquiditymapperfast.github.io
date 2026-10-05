
import fs from 'node:fs';
import { ImmutableSessionRowBytesCache } from './immutable-session-row-bytes.mts';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HeatmapRetentionBuffer, type HeatmapRetentionRow as RetainedHeatmapRow } from '../core/heatmap-retention.mts';
import { HEATMAP_CELLS_PER_BUCKET, HISTORY_DEPTH_LEVELS_PER_SIDE, HISTORY_SAMPLE_LIMIT, representationMetadata } from '../core/representation-limits.mts';
import { logicalRetainedBytes, logicalRetainedComponents } from '../core/retained-bytes.mts';
import { mockProviderProvenance } from '../core/mock-provider-provenance.mts';
import { usdBookLevels } from '../core/book-valuation.mts';
import { verifiedBookObservationIntervals } from './observed-segment-projection.mts';
import type { StatementSync, SupportedValueType } from 'node:sqlite';
import type { RuntimeCandle } from '../domain/runtime-state.mts';
import type { PriceAmount } from '../domain/contracts.ts';
import type { RepresentationMetadata } from '../core/representation-limits.mts';
const HEATMAP_COLUMN_NAMES = 'instrument_id,bucket_start,bucket_end,observed_ms,expected_ms,gap_ms,coverage,source_timestamp_min,source_timestamp_max,received_at,source_resolution,source_grouping,grid_epoch,observed_intervals,gap_intervals';
const HEATMAP_CELL_NAMES = 'instrument_id,bucket_start,side,price_low,price_high,mean_amount,mean_notional_usd,peak_amount,peak_notional_usd,observed_ms,expected_ms,gap_ms,coverage,source_timestamp_min,source_timestamp_max,received_at,source_resolution,source_grouping,grid_epoch,observed_intervals,observed_segments';
/** Equal TEXT affinity permits an indexed UNION MERGE instead of sorting native JSON. */
export function heatmapReadViewSql(includeRuns = true): string {
  const columns = 'SELECT '+HEATMAP_COLUMN_NAMES+',CAST(NULL AS TEXT) AS observation_run FROM heatmap_columns';
  const cells = 'SELECT '+HEATMAP_CELL_NAMES+',CAST(NULL AS TEXT) AS observation_run FROM heatmap_cells';
  return 'CREATE TEMP VIEW IF NOT EXISTS heatmap_read_columns AS '+columns+(includeRuns?' UNION ALL SELECT '+HEATMAP_COLUMN_NAMES+',run_id AS observation_run FROM heatmap_observation_columns':'')+';'
    +'CREATE TEMP VIEW IF NOT EXISTS heatmap_read_cells AS '+cells+(includeRuns?' UNION ALL SELECT '+HEATMAP_CELL_NAMES+',run_id AS observation_run FROM heatmap_observation_cells':'')+';'
    +'CREATE TEMP VIEW IF NOT EXISTS heatmap_read_keys AS SELECT instrument_id,bucket_start,bucket_end FROM heatmap_columns'
    +(includeRuns?' UNION ALL SELECT instrument_id,bucket_start,bucket_end FROM heatmap_observation_columns':'')+';';
}
export function heatmapReadSql(sql: string): string {
  if (!/^\s*(SELECT|WITH|EXPLAIN)\b/i.test(sql)) return sql;
  return sql.replace('gap_intervals AS gapIntervalsJson FROM heatmap_columns','gap_intervals AS gapIntervalsJson, observation_run AS observationRun FROM heatmap_columns')
    .replace('observed_segments AS observedSegmentsJson FROM heatmap_cells','observed_segments AS observedSegmentsJson, observation_run AS observationRun FROM heatmap_cells')
    .replace(/\bheatmap_columns\b/g,'heatmap_read_columns').replace(/\bheatmap_cells\b/g,'heatmap_read_cells')
    .replace(/ INDEXED BY heatmap_cells_(?:source_order|global_order)/g,'')
    .replace('viewport_column.bucket_start = heatmap_read_cells.bucket_start AND','viewport_column.bucket_start = heatmap_read_cells.bucket_start AND viewport_column.observation_run IS heatmap_read_cells.observation_run AND');
}

type HistoryRecord = Record<string, unknown>;
interface HistoryStatement {
  run(...parameters: unknown[]): ReturnType<StatementSync['run']>;
  get(...parameters: unknown[]): HistoryRecord | undefined;
  all(...parameters: unknown[]): HistoryRecord[];
  iterate(...parameters: unknown[]): Iterable<HistoryRecord>;
}
function sqlParameter(value: unknown): SupportedValueType {
  if (value === null || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array) return value;
  throw new TypeError('Unsupported SQLite parameter');
}
function historyStatement(statement: StatementSync): HistoryStatement {
  return {
    run: (...parameters) => statement.run(...parameters.map(sqlParameter)),
    get: (...parameters) => { const row: unknown = statement.get(...parameters.map(sqlParameter)); return row == null ? undefined : historyRecord(row); },
    all: (...parameters) => statement.all(...parameters.map(sqlParameter)).map(historyRecord),
    iterate: (...parameters) => iterateHistoryStatement(statement, parameters),
  };
}

function* iterateHistoryStatement(statement: StatementSync, parameters: unknown[]): IterableIterator<HistoryRecord> {
  // Node 22.13 provides this native API; the installed sqlite typings predate it.
  const iterate: unknown = Reflect.get(statement, 'iterate');
  if (typeof iterate !== 'function') throw new Error('SQLite runtime does not support bounded history iteration');
  const rows: unknown = Reflect.apply(iterate, statement, parameters.map(sqlParameter));
  if (rows == null || typeof rows !== 'object' || typeof Reflect.get(rows, Symbol.iterator) !== 'function') throw new Error('SQLite history iterator is invalid');
  for (const row of rows as Iterable<unknown>) yield historyRecord(row);
}
function historyRecord(value: unknown): HistoryRecord { const row=value !== null && typeof value === 'object' ? value as HistoryRecord : {}; if (row.observationRun == null) delete row.observationRun; return row; }
function historyArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function historyError(error: unknown): HistoryRecord { return historyRecord(error); }
interface HistoryInterval { start: number; end: number; }
function heatmapRunId(row: Partial<RetainedHeatmapRow> | HistoryRecord): string {
  return createHash('sha256').update(JSON.stringify([row.instrumentId,row.bucketStart,row.bucketEnd,row.sourceResolution ?? null,row.sourceGrouping ?? null,row.gridEpoch ?? null,
    row.observedMs,row.expectedMs,row.gapMs,row.coverage,row.sourceTimestampMin ?? null,row.sourceTimestampMax ?? null,row.gapIntervals ?? parseIntervals(row.gapIntervalsJson)])).digest('hex');
}
function heatmapCellFingerprint(row: RetainedHeatmapRow): string {
  return JSON.stringify([row.side,row.priceLow,row.priceHigh,row.meanAmount,row.meanNotionalUsd,row.peakAmount,row.peakNotionalUsd,row.cellObservedMs ?? row.observedMs,row.observedIntervals ?? [],row.observedSegments ?? []]);
}
interface HistoryOiObservation { instrumentId?: string; observationTimestamp: number; sourceTimestamp: number | null; receivedAt: number; base: number; quote: number | null; timeBasis: string; quality: string; }
interface HistoryOiBar extends HistoryRecord {
  instrumentId: string; intervalMs: number; bucketStart: number; bucketEnd: number;
  openBase: number; highBase: number; lowBase: number; closeBase: number;
  openQuote: number | null; highQuote: number | null; lowQuote: number | null; closeQuote: number | null;
  sampleCount: number; sourceTimeMin: number | null; sourceTimeMax: number | null;
  receivedAt: number; timeBasis: string; quality: string; firstObservationTimestamp: number; lastObservationTimestamp: number;
  observations: HistoryOiObservation[]; correctionTruncated: boolean; sealedPrefix: boolean;
}
interface HistoryDepthRow extends HistoryRecord {
  instrumentId: string; timestamp: number; receivedAt: number; bestBid: number | null; bestAsk: number | null;
  bidNotional: number; askNotional: number; levelCount: number; inputLevelCount: { bids: number; asks: number };
  bids: [number, number][]; asks: [number, number][]; units: unknown; resolution: unknown;
  resolutionKey: string; bookKey: string; coverage?: unknown; coverageBounds?: unknown; representation?: RepresentationMetadata;
}
interface HistoryQuery { from?: unknown; to?: unknown; limit?: unknown; interval?: unknown; newestFirst?: boolean; timeStepMs?: unknown; projection?: unknown; priceLow?: unknown; priceHigh?: unknown; }
const OI_HISTORY_BOUNDED_TIME_SQL='bucket_end > ? AND bucket_start < ?';
/** Explicit upper bounds use whole persisted-bar overlap; omitted bounds keep
 * the legacy bucket-start query. Both inventory and read share these semantics. */
function oiHistoryQueryWindow(from:unknown,to:unknown):{lower:number;upper:number|null} {
  const candidate=Number(from),lower=Number.isFinite(candidate)?candidate:0;
  if(to==null)return{lower,upper:null};const upper=Number(to);
  if(!Number.isSafeInteger(candidate)||candidate<0||!Number.isSafeInteger(upper)||upper<=candidate)throw new RangeError('OI history window requires safe increasing from/to');
  return{lower,upper};
}
function oiHistoryBarMatches(row:{bucketStart:unknown;bucketEnd:unknown},lower:number,upper:number|null):boolean {
  return upper===null?Number(row.bucketStart)>=lower:Number(row.bucketEnd)>lower&&Number(row.bucketStart)<upper;
}
interface HistoryOptions {
  filePath?: string; retentionDays?: number; depthRetentionDays?: number; heatmapIntervalMs?: number; heatmapPriceStep?: number; heatmapMaxGapMs?: number;
  heatmapMaxClosedRows?: number; heatmapMaxCellsPerBucket?: number; maxCacheBytes?: number; maxMainBytes?: number; maxWalBytes?: number;
  maxSessionHeatmapRows?: number; sessionOnlyHeatmap?: boolean; legacyOiMigrationMaxRows?: number; oiBarIntervalMs?: number; maxPendingOiBars?: number;
  storageWriteGuard?: ((descriptor: { kind: string; rows: RetainedHeatmapRow[]; logicalBytes: number }) => unknown) | null;
}
interface HistoryWriteError { name: unknown; code: unknown; message: unknown; phase?: string; }
interface RestartPayload extends HistoryRecord { markets: HistoryRecord[]; layerSummary: Record<string, unknown>; activeBookKeys: Record<string, unknown>; metadata: Record<string, unknown>; statuses: Record<string, unknown>; feedStatuses: Record<string, unknown>; }
interface SessionHeatmapLoss { key: string; rows: number; reason: string; gap: boolean; }
export interface HistoryDiagnostics {
  snapshotAt?: number; retention: ReturnType<HistoryStore['retentionBudget']> | null; sessionHistory: ReturnType<HistoryStore['sessionHistoryConfig']> | null;
  heatmap: ReturnType<HeatmapRetentionBuffer['stats']> | null; pendingDepth: number | null; sessionRows: number | null; sessionHeatmapLosses: SessionHeatmapLoss[] | null;
  logicalComponents: Record<string, number> | null; logicalBytes: number | null; measurementFresh?: boolean; measurementSnapshotAt?: number | null; snapshotAgeMs?: number | null; lastMeasured?: HistoryRecord;
}


// Scalar page planning is bounded independently of native JSON. Display bins
// never manufacture observations in absent native columns.
const HEATMAP_DISPLAY_PAGE_SQL = `WITH
 args(requested, lower, upper, price_low, price_high, step, page_limit, cell_limit) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?)),
 native_keys AS MATERIALIZED (
  SELECT instrument_id, bucket_start, bucket_end, observation_run FROM heatmap_columns, args
  WHERE (requested IS NULL OR instrument_id = requested) AND bucket_end > lower AND (upper IS NULL OR bucket_start < upper)
  ORDER BY bucket_start, instrument_id LIMIT 20001
 ),
 candidate_keys AS (
  SELECT instrument_id, CASE WHEN bucket_end - bucket_start <= step THEN CAST(bucket_start / step AS INTEGER) * step ELSE bucket_start END AS display_start,
    CASE WHEN bucket_end - bucket_start <= step THEN (CAST(bucket_start / step AS INTEGER) + 1) * step ELSE bucket_end END AS display_end
  FROM native_keys, args
  UNION
  SELECT instrument_id, CAST((bucket_end - 1) / step AS INTEGER) * step, (CAST((bucket_end - 1) / step AS INTEGER) + 1) * step
  FROM native_keys, args WHERE bucket_end - bucket_start <= step
 ),
 display_page AS MATERIALIZED (
  SELECT instrument_id, display_start, display_end FROM candidate_keys, args
  WHERE display_end > lower AND (upper IS NULL OR display_start < upper)
  ORDER BY display_start, instrument_id, display_end LIMIT (SELECT page_limit FROM args)
 ),
 selected_columns AS MATERIALIZED (
  SELECT DISTINCT nk.instrument_id, nk.bucket_start, nk.bucket_end, nk.observation_run FROM native_keys nk, args
  WHERE EXISTS (SELECT 1 FROM display_page dp WHERE dp.instrument_id = nk.instrument_id AND
   ((nk.bucket_end - nk.bucket_start <= step AND nk.bucket_end > dp.display_start AND nk.bucket_start < dp.display_end)
    OR (nk.bucket_end - nk.bucket_start > step AND nk.bucket_start = dp.display_start AND nk.bucket_end = dp.display_end)))
 ),
 selected_cells AS (
  SELECT hc.* FROM heatmap_cells hc INDEXED BY heatmap_cells_global_order
  WHERE hc.bucket_start >= (SELECT MIN(bucket_start) FROM selected_columns) AND hc.bucket_start <= (SELECT MAX(bucket_start) FROM selected_columns)
    AND EXISTS (SELECT 1 FROM selected_columns sc WHERE sc.instrument_id = hc.instrument_id AND sc.bucket_start = hc.bucket_start AND sc.observation_run IS hc.observation_run)
    AND EXISTS (SELECT 1 FROM args WHERE
     ((hc.price_high > hc.price_low AND (price_low IS NULL OR hc.price_high > price_low) AND (price_high IS NULL OR hc.price_low < price_high))
      OR (hc.price_high = hc.price_low AND (price_low IS NULL OR hc.price_low >= price_low) AND (price_high IS NULL OR hc.price_low <= price_high))))
  ORDER BY hc.bucket_start, hc.price_low, hc.instrument_id, hc.side LIMIT (SELECT cell_limit + 1 FROM args)
 ) `;
const HEATMAP_DISPLAY_COLUMN_FIELDS = `hc.instrument_id AS instrumentId, hc.bucket_start AS bucketStart, hc.bucket_end AS bucketEnd,
 hc.observed_ms AS observedMs, hc.expected_ms AS expectedMs, hc.gap_ms AS gapMs, hc.coverage,
 hc.source_timestamp_min AS sourceTimestampMin, hc.source_timestamp_max AS sourceTimestampMax, hc.received_at AS receivedAt,
 hc.source_resolution AS sourceResolution, hc.source_grouping AS sourceGrouping, hc.grid_epoch AS gridEpoch,
 hc.observed_intervals AS observedIntervalsJson, hc.gap_intervals AS gapIntervalsJson, hc.observation_run AS observationRun`;
const HEATMAP_DISPLAY_CELL_FIELDS = `instrument_id AS instrumentId, bucket_start AS bucketStart, side, price_low AS priceLow, price_high AS priceHigh,
 mean_amount AS meanAmount, mean_notional_usd AS meanNotionalUsd, peak_amount AS peakAmount, peak_notional_usd AS peakNotionalUsd,
 observed_ms AS observedMs, expected_ms AS expectedMs, gap_ms AS gapMs, coverage, source_timestamp_min AS sourceTimestampMin,
 source_timestamp_max AS sourceTimestampMax, received_at AS receivedAt, source_resolution AS sourceResolution,
 source_grouping AS sourceGrouping, grid_epoch AS gridEpoch, observed_intervals AS observedIntervalsJson, observed_segments AS observedSegmentsJson, observation_run AS observationRun`;
const HEATMAP_DISPLAY_ESTIMATE_SQL = HEATMAP_DISPLAY_PAGE_SQL + `,
 column_sizes AS (
  SELECT LENGTH(CAST(hc.instrument_id AS BLOB)) + LENGTH(CAST(hc.coverage AS BLOB)) + COALESCE(LENGTH(CAST(hc.source_resolution AS BLOB)),0)
   + COALESCE(LENGTH(CAST(hc.source_grouping AS BLOB)),0) + COALESCE(LENGTH(CAST(hc.grid_epoch AS BLOB)),0) + COALESCE(LENGTH(CAST(hc.observation_run AS BLOB)),0) AS text_bytes,
   COALESCE(LENGTH(CAST(hc.observed_intervals AS BLOB)),0) + COALESCE(LENGTH(CAST(hc.gap_intervals AS BLOB)),0) AS payload_bytes
  FROM heatmap_columns hc JOIN selected_columns sc ON sc.instrument_id=hc.instrument_id AND sc.bucket_start=hc.bucket_start AND sc.observation_run IS hc.observation_run
 ), cell_sizes AS (
  SELECT LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(side AS BLOB)) + LENGTH(CAST(coverage AS BLOB))
   + COALESCE(LENGTH(CAST(source_resolution AS BLOB)),0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)),0)
   + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)),0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0) AS text_bytes,
   COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0) + COALESCE(LENGTH(CAST(observed_segments AS BLOB)),0) AS payload_bytes,
   COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0) AS interval_bytes,
   json_array_length(observed_segments) AS source_segments, json_array_length(observed_intervals) AS intervals,
   expected_ms FROM selected_cells
 ) SELECT
 (SELECT COUNT(*) FROM native_keys) AS nativeKeyCount,
 (SELECT COUNT(*) FROM display_page) AS displayCount,
 (SELECT COUNT(*) FROM column_sizes) AS columnCount,
 COALESCE((SELECT SUM(text_bytes) FROM column_sizes),0) AS columnTextUtf8Bytes,
 COALESCE((SELECT SUM(payload_bytes) FROM column_sizes),0) AS columnPayloadUtf8Bytes,
 COUNT(*) AS count, COALESCE(SUM(text_bytes),0) AS textUtf8Bytes,
 COALESCE(MAX(text_bytes + payload_bytes),0) AS largestCellRowUtf8Bytes,
 COALESCE(MAX(payload_bytes),0) AS largestCellPayloadUtf8Bytes,
 COALESCE(SUM(interval_bytes),0) AS intervalPayloadUtf8Bytes,
 COALESCE(SUM(CASE WHEN expected_ms <= (SELECT step FROM args) THEN 2 * intervals
  ELSE MIN(source_segments, CAST((expected_ms + (SELECT step FROM args) - 1) / (SELECT step FROM args) AS INTEGER) + 2 * intervals + 1) END),0) AS compactSegmentCount
 FROM cell_sizes`;
// The mean estimator must use the same scalar provenance fence as the reader.
// Orphan native JSON remains charged as text/maximum parse ownership, but is not
// decoded merely to count work that cannot contribute to a verified mean.
const HEATMAP_MEAN_MATCHING_PARENT_SQL = `EXISTS (SELECT 1 FROM heatmap_columns native_parent
 WHERE native_parent.instrument_id = selected_cells.instrument_id AND native_parent.bucket_start = selected_cells.bucket_start
 AND native_parent.source_resolution IS selected_cells.source_resolution AND native_parent.source_grouping IS selected_cells.source_grouping
 AND native_parent.grid_epoch IS selected_cells.grid_epoch AND native_parent.observation_run IS selected_cells.observation_run)`;
// BOOK validity is checked by the reader, not inferred from scalar parent
// equality. Allow both paint/unavailable identities and charge unavailable
// interval destinations for every native row until that proof is evaluated.
const HEATMAP_MEAN_DISPLAY_ESTIMATE_SQL = HEATMAP_DISPLAY_ESTIMATE_SQL
 .replace('json_array_length(observed_segments) AS source_segments, json_array_length(observed_intervals) AS intervals',
  `CASE WHEN ${HEATMAP_MEAN_MATCHING_PARENT_SQL} THEN json_array_length(observed_segments) ELSE 0 END AS source_segments,
   CASE WHEN ${HEATMAP_MEAN_MATCHING_PARENT_SQL} THEN json_array_length(observed_intervals) ELSE 0 END AS intervals`)
 .replace('expected_ms FROM selected_cells', `expected_ms,
   json_array(instrument_id,side,price_low,price_high,source_resolution,source_grouping,grid_epoch) AS identity,
   json_array(instrument_id,side,price_low,price_high,source_resolution,source_grouping,grid_epoch,CASE WHEN ${HEATMAP_MEAN_MATCHING_PARENT_SQL} THEN 'paint' ELSE 'unavailable' END) AS classified_identity,
   json_array(side,price_low,price_high,substr(json_array(source_resolution,source_grouping,grid_epoch),1)) AS unavailable_identity,
   json_array(instrument_id,side,coverage,source_resolution,source_grouping,grid_epoch) AS metadata FROM selected_cells`)
 .replace('COUNT(*) AS count, COALESCE(SUM(text_bytes),0)',
  'MIN(COUNT(*),2*COUNT(DISTINCT identity)) AS compactOwnerCellCountBound, COUNT(DISTINCT classified_identity) AS compactCellCount, COALESCE(SUM(source_segments),0) AS nativeSegmentCount, COUNT(*) AS count, COALESCE(SUM(text_bytes),0)')
 .replace(' FROM cell_sizes', `,
   (SELECT COUNT(*) FROM candidate_keys) AS candidateKeyCount,
   COALESCE((SELECT SUM(LENGTH(CAST(instrument_id AS BLOB))+COALESCE(LENGTH(CAST(observation_run AS BLOB)),0)) FROM native_keys),0) AS nativeKeyTextUtf8Bytes,
   COALESCE((SELECT SUM(LENGTH(CAST(instrument_id AS BLOB))) FROM candidate_keys),0) AS candidateKeyTextUtf8Bytes,
   COALESCE((SELECT SUM(LENGTH(CAST(instrument_id AS BLOB))+COALESCE(LENGTH(CAST(observation_run AS BLOB)),0)) FROM selected_columns),0) AS selectedColumnKeyTextUtf8Bytes,
   COALESCE(MAX(MAX(LENGTH(CAST(identity AS BLOB)),LENGTH(CAST(unavailable_identity AS BLOB)))+128),0) AS largestCompactIdentityUtf8Bytes,
   COALESCE(MAX(LENGTH(CAST(metadata AS BLOB))+128),0) AS largestCompactMetadataUtf8Bytes,
   COUNT(*) AS unsupportedCellCount, 2*COUNT(*) AS unsupportedTargetCountBound,
   (SELECT COALESCE(SUM(CASE WHEN json_valid(hc.gap_intervals) THEN json_array_length(hc.gap_intervals)+1 ELSE 1 END),0)
    FROM heatmap_columns hc JOIN selected_columns sc ON sc.instrument_id=hc.instrument_id AND sc.bucket_start=hc.bucket_start AND sc.observation_run IS hc.observation_run) AS bookRunCountBound
   FROM cell_sizes`);

const MIB = 1024 * 1024;
const DEFAULT_MAX_CACHE_BYTES = 256 * MIB;
const DEFAULT_MAX_MAIN_BYTES = 224 * MIB;
const DEFAULT_MAX_WAL_BYTES = 32 * MIB;
const HEATMAP_HISTORY_COLUMN_TEMPORARY_BYTES = 4 * 1024;
const HEATMAP_HISTORY_CELL_TEMPORARY_BYTES = 2 * 1024;
const HEATMAP_HISTORY_PENDING_ROW_TEMPORARY_BYTES = 4 * 1024;
const HEATMAP_HISTORY_SESSION_ROW_TEMPORARY_BYTES = 2 * 1024;
const HEATMAP_HISTORY_JSON_PARSE_MULTIPLIER = 32;
const CANDLE_HISTORY_ROW_TEMPORARY_BYTES = 4 * 1024;
const DEPTH_HISTORY_ROW_TEMPORARY_BYTES = 8 * 1024;
const PROVIDER_HISTORY_ROW_TEMPORARY_BYTES = 4 * 1024;

function addHistoryResponseBytes(total: number, amount: number) {
  const next = total + amount;
  if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(next)) throw new Error('history response byte estimate overflowed');
  return next;
}

function finiteByteBudget(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function priceBounds(rows: readonly (readonly number[] | PriceAmount)[] = []) {
  const prices = (rows ?? []).map((row) => Number(Array.isArray(row) ? row[0] : historyRecord(row).price)).filter((value) => Number.isFinite(value) && value > 0);
  return prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null;
}

function parseIntervals(value: unknown): HistoryInterval[] {
  let rows = value;
  if (typeof value === 'string') { try { rows = JSON.parse(value); } catch { rows = []; } }
  return (Array.isArray(rows) ? rows : []).map((item) => ({ start: Number(item?.start), end: Number(item?.end) })).filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start).sort((a, b) => a.start - b.start);
}

const STATE_MARKET_LIMIT = 256;
const STATE_STATUS_LIMIT = 128;
const STATE_TEXT_LIMIT = 240;
const STATE_PAYLOAD_LIMIT_BYTES = 64 * 1024;
const LEGACY_OI_BATCH_SIZE = 500;
const LEGACY_OI_MAX_ROWS_PER_START = 5_000;
const DEFAULT_OI_BAR_INTERVAL_MS = 60_000;
const OI_BAR_CORRECTION_BUFFER_CAP = 256;
const DEFAULT_MAX_PENDING_OI_BARS = 4_096;

function validOiValue(value: unknown) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function mergeOiBarValues(existing: HistoryOiBar | null, sample: HistoryOiObservation, intervalMs: number): HistoryOiBar | null {
  const observationTimestamp = Number(sample.observationTimestamp);
  const base = Number(sample.base);
  if (!(observationTimestamp > 0) || !Number.isFinite(base)) return null;
  const bucketStart = Math.floor(observationTimestamp / intervalMs) * intervalMs;
  const sourceTimestamp = sample.sourceTimestamp == null ? null : Number(sample.sourceTimestamp);
  const quote = validOiValue(sample.quote);
  const sampleQuality = String(sample.quality ?? (sourceTimestamp == null ? 'sampled' : 'native'));
  const receivedAt = Number(sample.receivedAt);
  const incoming = { observationTimestamp, sourceTimestamp: sourceTimestamp != null && sourceTimestamp > 0 ? sourceTimestamp : null, receivedAt: Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : observationTimestamp, base, quote, timeBasis: sourceTimestamp == null ? 'receipt' : 'exchange', quality: sampleQuality };
  const buffer = Array.isArray(existing?.observations) ? existing.observations.map((row) => ({ ...row })) : [];
  const correctionTruncated = existing?.correctionTruncated === true;
  // A row loaded from SQLite has only a sealed scalar prefix. Keep that
  // prefix marked after the first post-restart sample so later samples never
  // reinterpret the small RAM correction window as the whole bar history.
  const sealedPrefix = existing?.sealedPrefix === true;
  const persistedScalar = Boolean(existing && (sealedPrefix || !buffer.length));
  const existingLast = Number(existing?.lastObservationTimestamp);
  const duplicateIndex = buffer.findIndex((row) => Number(row.observationTimestamp) === observationTimestamp);
  // A durable scalar bar has no raw correction history. Accept only strictly
  // newer observations; stale/duplicate updates are rejected so they cannot
  // rewrite an already sealed open/extreme/count.
  if (persistedScalar && Number.isFinite(existingLast) && observationTimestamp <= existingLast) return null;
  // Once the correction buffer has rolled, an old timestamp may be outside the
  // buffer. Reject it rather than counting a duplicate as a new observation.
  if (correctionTruncated && (duplicateIndex >= 0 || (Number.isFinite(existingLast) && observationTimestamp <= existingLast))) return null;
  if (duplicateIndex >= 0) buffer[duplicateIndex] = incoming;
  else buffer.push(incoming);
  buffer.sort((a, b) => Number(a.observationTimestamp) - Number(b.observationTimestamp));
  const allKnown = !sealedPrefix && !correctionTruncated;
  const knownRows = allKnown ? buffer : null;
  const values = knownRows?.map((row) => Number(row.base)).filter(Number.isFinite) ?? [];
  const quotes = knownRows?.map((row) => row.quote).filter((value) => value != null && Number.isFinite(Number(value))).map(Number) ?? [];
  const sourceTimes = knownRows?.map((row) => Number(row.sourceTimestamp)).filter((value) => Number.isFinite(value) && value > 0) ?? [];
  const first = knownRows?.[0] ?? incoming;
  const last = knownRows?.at(-1) ?? incoming;
  const receivedTimes = knownRows?.map((row) => Number(row.receivedAt)).filter((value) => Number.isFinite(value) && value > 0) ?? [incoming.receivedAt];
  const timeBases = knownRows ? new Set(knownRows.map((row) => String(row.timeBasis ?? (row.sourceTimestamp == null ? 'receipt' : 'exchange')))) : new Set([String(existing?.timeBasis ?? 'unknown'), incoming.timeBasis]);
  const qualities = knownRows?.map((row) => String(row.quality ?? 'native')) ?? [String(existing?.quality ?? 'native'), incoming.quality];
  const next = {
    instrumentId: String(existing?.instrumentId ?? sample.instrumentId), intervalMs, bucketStart,
    bucketEnd: bucketStart + intervalMs,
    openBase: allKnown ? Number(first.base) : Number(existing?.openBase ?? incoming.base),
    highBase: allKnown ? Math.max(...values) : Math.max(Number(existing?.highBase ?? incoming.base), incoming.base),
    lowBase: allKnown ? Math.min(...values) : Math.min(Number(existing?.lowBase ?? incoming.base), incoming.base),
    closeBase: allKnown ? Number(last.base) : incoming.base,
    openQuote: allKnown ? (first.quote == null ? null : Number(first.quote)) : (existing?.openQuote == null ? null : Number(existing.openQuote)),
    highQuote: allKnown ? (quotes.length ? Math.max(...quotes) : null) : (existing?.highQuote == null && incoming.quote == null ? null : Math.max(Number(existing?.highQuote ?? -Infinity), Number(incoming.quote ?? -Infinity))),
    lowQuote: allKnown ? (quotes.length ? Math.min(...quotes) : null) : (existing?.lowQuote == null && incoming.quote == null ? null : Math.min(Number(existing?.lowQuote ?? Infinity), Number(incoming.quote ?? Infinity))),
    closeQuote: allKnown ? (last.quote == null ? null : Number(last.quote)) : (incoming.quote == null ? null : Number(incoming.quote)),
    sampleCount: allKnown ? buffer.length : Number(existing?.sampleCount ?? 0) + (duplicateIndex >= 0 ? 0 : 1),
    sourceTimeMin: allKnown ? (sourceTimes.length ? Math.min(...sourceTimes) : null) : (existing?.sourceTimeMin == null ? incoming.sourceTimestamp : incoming.sourceTimestamp == null ? existing.sourceTimeMin : Math.min(Number(existing.sourceTimeMin), incoming.sourceTimestamp)),
    sourceTimeMax: allKnown ? (sourceTimes.length ? Math.max(...sourceTimes) : null) : (existing?.sourceTimeMax == null ? incoming.sourceTimestamp : incoming.sourceTimestamp == null ? existing.sourceTimeMax : Math.max(Number(existing.sourceTimeMax), incoming.sourceTimestamp)),
    receivedAt: Math.max(...receivedTimes, incoming.receivedAt),
    timeBasis: timeBases.size > 1 ? 'mixed' : [...timeBases][0] ?? 'unknown',
    quality: qualities.includes('gap') ? 'gap' : (Number(existing?.sampleCount ?? 0) + 1 > 1 || qualities.includes('sampled') ? 'sampled' : qualities[0] ?? 'native'),
    firstObservationTimestamp: allKnown ? Number(first.observationTimestamp) : Number(existing?.firstObservationTimestamp ?? existing?.lastObservationTimestamp ?? incoming.observationTimestamp),
    lastObservationTimestamp: allKnown ? Number(last.observationTimestamp) : incoming.observationTimestamp,
    observations: buffer,
    correctionTruncated,
    sealedPrefix,
  };
  if (!correctionTruncated && buffer.length > OI_BAR_CORRECTION_BUFFER_CAP) {
    // Compute the scalar aggregate while all observations are still available,
    // then retain only a RAM correction window. The durable row receives only
    // the scalar aggregate, count, and timestamp provenance.
    next.correctionTruncated = true;
    next.observations = buffer.slice(-OI_BAR_CORRECTION_BUFFER_CAP);
  }
  if (next.correctionTruncated && next.observations.length > OI_BAR_CORRECTION_BUFFER_CAP) {
    next.observations = next.observations.slice(-OI_BAR_CORRECTION_BUFFER_CAP);
  }
  return next;
}

function oiBarKey(instrumentId: string, intervalMs: number, bucketStart: number) {
  return `${instrumentId}|${intervalMs}|${bucketStart}`;
}

function oiBarFromRow(row: HistoryRecord): HistoryOiBar {
  return {
    instrumentId: String(row.instrumentId), intervalMs: Number(row.intervalMs), bucketStart: Number(row.bucketStart), bucketEnd: Number(row.bucketEnd),
    openBase: Number(row.openBase), highBase: Number(row.highBase), lowBase: Number(row.lowBase), closeBase: Number(row.closeBase),
    openQuote: row.openQuote == null ? null : Number(row.openQuote), highQuote: row.highQuote == null ? null : Number(row.highQuote), lowQuote: row.lowQuote == null ? null : Number(row.lowQuote), closeQuote: row.closeQuote == null ? null : Number(row.closeQuote),
    sampleCount: Number(row.sampleCount), sourceTimeMin: row.sourceTimeMin == null ? null : Number(row.sourceTimeMin), sourceTimeMax: row.sourceTimeMax == null ? null : Number(row.sourceTimeMax),
    receivedAt: Number(row.receivedAt), timeBasis: String(row.timeBasis ?? 'unknown'), quality: String(row.quality ?? 'sampled'),
    firstObservationTimestamp: row.firstObservationTimestamp == null ? Number(row.bucketStart) : Number(row.firstObservationTimestamp),
    lastObservationTimestamp: row.lastObservationTimestamp == null ? Number(row.bucketStart) : Number(row.lastObservationTimestamp),
    observations: [], correctionTruncated: false, sealedPrefix: true,
  };
}

function oiBarOutput(row: HistoryRecord) {
  const bar = oiBarFromRow(row);
  return {
    instrumentId: bar.instrumentId, interval: `${Math.max(1, Math.trunc(bar.intervalMs / 60_000))}m`, start: bar.bucketStart, end: bar.bucketEnd,
    observationTimestamp: bar.bucketStart, sourceTimestamp: bar.sourceTimeMax, timeBasis: bar.timeBasis, receivedAt: bar.receivedAt,
    base: bar.closeBase, quote: bar.closeQuote, open: bar.openBase, high: bar.highBase, low: bar.lowBase, close: bar.closeBase,
    quoteOpen: bar.openQuote, quoteHigh: bar.highQuote, quoteLow: bar.lowQuote, quoteClose: bar.closeQuote,
    samples: bar.sampleCount, sampleCount: bar.sampleCount, quality: bar.quality,
  };
}
function shortText(value: unknown) {
  if (value == null) return null;
  const text = String(value);
  return text.length > STATE_TEXT_LIMIT ? text.slice(0, STATE_TEXT_LIMIT) : text;
}
function restartMarkets(markets: unknown) {
  return (Array.isArray(markets) ? markets : []).slice(0, STATE_MARKET_LIMIT).map((market) => {
    const out: HistoryRecord = {};
    for (const key of ['id', 'instrumentId', 'venue', 'exchange', 'symbol', 'nativeSymbol', 'base', 'quote', 'marketType', 'tickSize', 'contractValue', 'contractType', 'inverse', 'quantityUnit', 'settleCoin', 'quoteToUsd', 'quoteUsdRate', 'isFree', 'aggregationId']) {
      if (market?.[key] !== undefined && (typeof market[key] !== 'object' || market[key] === null)) out[key] = typeof market[key] === 'string' ? shortText(market[key]) : market[key];
    }
    return out;
  }).filter((market) => market.instrumentId || market.id);
}
function depthValuationMetadata(value: HistoryRecord): HistoryRecord {
  const result: HistoryRecord = {};
  for (const key of ['valuationStatus', 'contractValue', 'contractType', 'inverse', 'quote', 'quoteToUsd', 'quoteUsdRate']) {
    const item = value[key];
    if (typeof item === 'string') result[key] = shortText(item);
    else if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) result[key] = item;
  }
  return result;
}
function restartStatuses(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, STATE_STATUS_LIMIT).map(([key, status]) => {
    if (!status || typeof status !== 'object' || Array.isArray(status)) return [shortText(key), shortText(status)];
    const out: HistoryRecord = {};
    for (const field of ['state', 'attempt', 'lastError', 'lastSuccess', 'nextRetryAt', 'sourceTimestamp', 'sourceAgeMs', 'sampleCount', 'coverageStart', 'coverageEnd']) {
      if (status[field] !== undefined && (typeof status[field] !== 'object' || status[field] === null)) out[field] = typeof status[field] === 'string' ? shortText(status[field]) : status[field];
    }
    return [shortText(key), out];
  }).filter(([key]) => key));
}
function restartLayerSummary(layerInput: unknown, metaInput: unknown, revisionInput: unknown, sourceInput: unknown) {
  const layers = historyRecord(layerInput), layerMeta = historyRecord(metaInput), revisions = historyRecord(revisionInput), sourceTimes = historyRecord(sourceInput);
  const names = new Set([...Object.keys(layers ?? {}), ...Object.keys(layerMeta ?? {}), ...Object.keys(revisions ?? {})]);
  return Object.fromEntries([...names].slice(0, 32).map((rawName) => {
    const name = shortText(rawName); const rawSourceTime: unknown = sourceTimes?.[rawName]; const sourceTimestamp = rawSourceTime == null || rawSourceTime === '' ? null : (Number.isFinite(Number(rawSourceTime)) && Number(rawSourceTime) > 0 ? Number(rawSourceTime) : null);
    return [name, {
    levelCount: historyArray(layers[rawName]).length,
    inactiveIds: historyArray(layers[rawName]).map(historyRecord).filter(level => level.active === false && level.id != null).slice(0, 256).map(level => shortText(level.id)).filter(Boolean),
    revision: shortText(revisions?.[rawName] ?? historyRecord(layerMeta[rawName]).revision),
    sourceTimestamp,
    complete: historyRecord(layerMeta[rawName]).complete === true || historyRecord(layerMeta[rawName]).complete === 1,
  }];
  }));
}

function boundedRestartPayload(payload: RestartPayload) {
  const clone = { ...payload, markets: [...(payload.markets ?? [])], layerSummary: { ...(payload.layerSummary ?? {}) }, activeBookKeys: { ...(payload.activeBookKeys ?? {}) }, metadata: { ...(payload.metadata ?? {}) }, statuses: { ...(payload.statuses ?? {}) }, feedStatuses: { ...(payload.feedStatuses ?? {}) } };
  const size = () => Buffer.byteLength(JSON.stringify(clone), 'utf8');
  const trimMap = (name: 'layerSummary' | 'activeBookKeys' | 'metadata' | 'statuses' | 'feedStatuses') => {
    const entries = Object.entries(clone[name]); if (entries.length <= 1) return false;
    clone[name] = Object.fromEntries(entries.slice(0, Math.max(1, Math.ceil(entries.length / 2)))); return true;
  };
  while (size() > STATE_PAYLOAD_LIMIT_BYTES) {
    if (clone.markets.length > 1) { clone.markets = clone.markets.slice(0, Math.max(1, Math.ceil(clone.markets.length / 2))); continue; }
    if (trimMap('layerSummary')) continue;
    if (trimMap('activeBookKeys')) continue;
    if (trimMap('metadata')) continue;
    if (trimMap('statuses')) continue;
    if (trimMap('feedStatuses')) continue;
    // The fields above are already individually bounded; keep a scalar-only
    // restart record rather than allowing an adversarial label to grow it.
    clone.markets = []; clone.layerSummary = {}; clone.activeBookKeys = {}; clone.metadata = {}; clone.statuses = {}; clone.feedStatuses = {};
    break;
  }
  return clone;
}

/** Local WAL history. It stores observations and provenance, never secrets. */
export class HistoryStore {
  prepare(sql: string): HistoryStatement { return historyStatement(this.db.prepare(heatmapReadSql(sql))); }
  declare filePath: string;
  declare retentionDays: number;
  declare depthRetentionDays: number;
  declare db: DatabaseSync;
  declare legacyOiMigrationMaxRows: number;
  declare oiBarIntervalMs: number;
  declare maxPendingOiBars: number;
  declare pendingOiBars: Map<string, HistoryOiBar>;
  declare oiPendingDroppedBars: number;
  declare oiWriteStats: { batches: number; bars: number; failedWrites: number; lastError: string | null };
  declare storageLimits: { maxCacheBytes: number; maxMainBytes: number; maxWalBytes: number };
  declare legacyOiMigrationPending: boolean;
  declare heatmap: HeatmapRetentionBuffer;
  declare pendingDepth: Map<string, HistoryDepthRow>;
  declare pendingDepthFailures: HistoryDepthRow[];
  declare pendingDepthAdmissionRejectedRows: number;
  declare retainedDiagnosticsCache: { signature: string; value: HistoryDiagnostics } | null;
  declare depthWriteCount: number;
  declare heatmapWriteStats: { batches: number; columns: number; cells: number; logicalBytes: number; physicalBytesDelta: number; storageGrowthRatio: number; storageGrowthRatioMeasured: boolean; failedWrites: number; lastError: HistoryWriteError | null };
  declare sessionOnlyHeatmap: boolean;
  declare storageWriteGuard: HistoryOptions['storageWriteGuard'];
  declare maxSessionHeatmapRows: number;
  declare sessionHeatmapRows: RetainedHeatmapRow[];
  declare sessionHeatmapRowBytes: ImmutableSessionRowBytesCache;
  declare sessionHeatmapMembershipRevision: number;
  declare heatmapConflictedRuns: Map<string,string>;
  declare heatmapRunTablesReady: boolean;
  declare sessionHeatmapDroppedRows: number;
  declare sessionHeatmapDroppedColumns: number;
  declare sessionHeatmapLosses: SessionHeatmapLoss[];
  declare persistenceSuspended: boolean;
  declare storageStats: ReturnType<HistoryStore['storageUsage']> & { evictedRows: number; checkpointed: boolean; checkpointBusy: boolean; compacted: boolean; overBudget: boolean; needsCompaction: boolean; impossibleBudget: boolean; lastEnforcedAt: number | null; suspensionReason: string | null };
  declare oiBarMigrationPending: boolean;
  declare selectOiBarByKey: HistoryStatement;
  declare selectOiBars: HistoryStatement;
  declare selectOiBarsWindow: HistoryStatement;
  declare selectOiBarsAll: HistoryStatement;
  declare selectOiBarsAllWindow: HistoryStatement;
  declare estimateOiBars: HistoryStatement;
  declare estimateOiBarsWindow: HistoryStatement;
  declare estimateOiBarsAll: HistoryStatement;
  declare estimateOiBarsAllWindow: HistoryStatement;
  declare insertOiBar: HistoryStatement;
  declare insertCrossing: HistoryStatement;
  declare insertLayer: HistoryStatement;
  declare insertState: HistoryStatement;
  declare insertDepth: HistoryStatement;
  declare selectDepthRows: HistoryStatement;
  declare selectDepthRowsAll: HistoryStatement;
  declare estimateDepthRows: HistoryStatement;
  declare estimateDepthRowsAll: HistoryStatement;
  declare selectDepthSummary: HistoryStatement;
  declare selectDepthAtTimestamp: HistoryStatement;
  declare insertHeatmapColumn: HistoryStatement;
  declare insertHeatmapCell: HistoryStatement;
  declare selectHeatmapColumns: HistoryStatement;
  declare selectHeatmapColumnsViewport: HistoryStatement;
  declare selectHeatmapColumnsAll: HistoryStatement;
  declare selectHeatmapColumnsAllViewport: HistoryStatement;
  declare selectHeatmapCells: HistoryStatement;
  declare selectHeatmapCellsViewport: HistoryStatement;
  declare selectHeatmapCellsAll: HistoryStatement;
  declare selectHeatmapCellsAllViewport: HistoryStatement;
  declare estimateHeatmapColumns: HistoryStatement;
  declare estimateHeatmapColumnsViewport: HistoryStatement;
  declare estimateHeatmapColumnsAll: HistoryStatement;
  declare estimateHeatmapColumnsAllViewport: HistoryStatement;
  declare estimateHeatmapCells: HistoryStatement;
  declare estimateHeatmapCellsViewport: HistoryStatement;
  declare estimateHeatmapCellsAll: HistoryStatement;
  declare estimateHeatmapCellsAllViewport: HistoryStatement;
  declare estimateProjectedHeatmapCells: HistoryStatement;
  declare estimateProjectedHeatmapCellsViewport: HistoryStatement;
  declare estimateProjectedHeatmapCellsAll: HistoryStatement;
  declare estimateProjectedHeatmapCellsAllViewport: HistoryStatement;
  declare selectDisplayHeatmapKeys: HistoryStatement;
  declare selectDisplayHeatmapColumns: HistoryStatement;
  declare selectDisplayHeatmapCells: HistoryStatement;
  declare estimateDisplayHeatmap: HistoryStatement;
  declare estimateMeanHeatmap: HistoryStatement;
  declare selectLayerSnapshots: HistoryStatement;
  declare selectLayerSnapshotsAll: HistoryStatement;
  declare estimateLayerSnapshots: HistoryStatement;
  declare estimateLayerSnapshotsAll: HistoryStatement;
  declare selectCandle: HistoryStatement;
  declare selectCandleAllIntervals: HistoryStatement;
  declare selectCandleAll: HistoryStatement;
  declare selectCandleAllByInterval: HistoryStatement;
  declare selectCandleNewest: HistoryStatement;
  declare selectCandleAllIntervalsNewest: HistoryStatement;
  declare selectCandleAllNewest: HistoryStatement;
  declare selectCandleAllByIntervalNewest: HistoryStatement;
  declare estimateCandles: HistoryStatement;
  declare estimateCandlesAllIntervals: HistoryStatement;
  declare estimateCandlesAll: HistoryStatement;
  declare estimateCandlesByInterval: HistoryStatement;
  declare insertCandle: HistoryStatement;
  constructor({ filePath = ':memory:', retentionDays = 30, depthRetentionDays = 7, heatmapIntervalMs = 60_000, heatmapPriceStep = 50, heatmapMaxGapMs = 120_000, heatmapMaxClosedRows = 200_000, heatmapMaxCellsPerBucket = HEATMAP_CELLS_PER_BUCKET, maxCacheBytes = DEFAULT_MAX_CACHE_BYTES, maxMainBytes = DEFAULT_MAX_MAIN_BYTES, maxWalBytes = DEFAULT_MAX_WAL_BYTES, maxSessionHeatmapRows = 20_000, sessionOnlyHeatmap = false, storageWriteGuard = null, legacyOiMigrationMaxRows = LEGACY_OI_MAX_ROWS_PER_START, oiBarIntervalMs = DEFAULT_OI_BAR_INTERVAL_MS, maxPendingOiBars = DEFAULT_MAX_PENDING_OI_BARS }: HistoryOptions = {}) {
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.filePath = filePath; this.retentionDays = retentionDays; this.depthRetentionDays = depthRetentionDays; this.db = new DatabaseSync(filePath);
    this.legacyOiMigrationMaxRows = Math.max(1, Math.min(LEGACY_OI_MAX_ROWS_PER_START, Math.trunc(Number(legacyOiMigrationMaxRows) || LEGACY_OI_MAX_ROWS_PER_START)));
    this.oiBarIntervalMs = Math.max(1_000, Math.min(86_400_000, Math.trunc(Number(oiBarIntervalMs) || DEFAULT_OI_BAR_INTERVAL_MS)));
    this.maxPendingOiBars = Math.max(1, Math.min(65_536, Math.trunc(Number(maxPendingOiBars) || DEFAULT_MAX_PENDING_OI_BARS)));
    this.pendingOiBars = new Map();
    this.oiPendingDroppedBars = 0;
    this.oiWriteStats = { batches: 0, bars: 0, failedWrites: 0, lastError: null };
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.storageLimits = {
      maxCacheBytes: finiteByteBudget(maxCacheBytes, DEFAULT_MAX_CACHE_BYTES),
      maxMainBytes: finiteByteBudget(maxMainBytes, DEFAULT_MAX_MAIN_BYTES),
      maxWalBytes: finiteByteBudget(maxWalBytes, DEFAULT_MAX_WAL_BYTES),
    };
    if (this.storageLimits.maxMainBytes + this.storageLimits.maxWalBytes > this.storageLimits.maxCacheBytes) {
      throw new RangeError('maxMainBytes + maxWalBytes must not exceed maxCacheBytes');
    }
    const existingOiTable = this.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oi_samples'").get();
    const existingOiColumns = existingOiTable ? new Set(this.prepare('PRAGMA table_info(oi_samples)').all().map((row) => String(row.name))) : new Set();
    const legacyOiSchema = Boolean(existingOiTable && !existingOiColumns.has('source_time') && !existingOiColumns.has('time_basis'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oi_samples (
        instrument_id TEXT NOT NULL, source_timestamp INTEGER NOT NULL, source_time INTEGER,
        time_basis TEXT NOT NULL DEFAULT 'exchange', received_at INTEGER NOT NULL,
        base REAL NOT NULL, quote REAL, quality TEXT NOT NULL, PRIMARY KEY (instrument_id, source_timestamp)
      );
      CREATE TABLE IF NOT EXISTS oi_bars (
        instrument_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, bucket_start INTEGER NOT NULL,
        bucket_end INTEGER NOT NULL, open_base REAL NOT NULL, high_base REAL NOT NULL,
        low_base REAL NOT NULL, close_base REAL NOT NULL, open_quote REAL, high_quote REAL,
        low_quote REAL, close_quote REAL, sample_count INTEGER NOT NULL, source_time_min INTEGER,
        source_time_max INTEGER, first_observation_timestamp INTEGER NOT NULL, last_observation_timestamp INTEGER NOT NULL, received_at INTEGER NOT NULL,
        time_basis TEXT NOT NULL, quality TEXT NOT NULL,
        PRIMARY KEY (instrument_id, interval_ms, bucket_start)
      );
      CREATE TABLE IF NOT EXISTS candle_samples (
        instrument_id TEXT NOT NULL, interval TEXT NOT NULL, start_timestamp INTEGER NOT NULL,
        end_timestamp INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL,
        close REAL NOT NULL, volume REAL NOT NULL, source_timestamp INTEGER, received_at INTEGER NOT NULL,
        closed INTEGER NOT NULL, quality TEXT, origin TEXT NOT NULL, payload_json TEXT NOT NULL,
        source_provenance TEXT NOT NULL DEFAULT 'legacy-unverified',
        PRIMARY KEY (instrument_id, interval, start_timestamp)
      );
      CREATE TABLE IF NOT EXISTS layer_snapshots (
        layer TEXT NOT NULL, instrument_id TEXT NOT NULL, revision TEXT NOT NULL, source_timestamp INTEGER NOT NULL,
        received_at INTEGER NOT NULL, complete INTEGER NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY (layer, instrument_id, revision)
      );
      CREATE TABLE IF NOT EXISTS crossing_events (
        level_id TEXT NOT NULL, observed_at INTEGER NOT NULL, layer TEXT, mark_price REAL NOT NULL,
        direction TEXT, provisional INTEGER NOT NULL, PRIMARY KEY (level_id, observed_at)
      );
      CREATE TABLE IF NOT EXISTS state_snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1), as_of INTEGER NOT NULL, saved_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oi_samples_time ON oi_samples(source_timestamp);
      CREATE INDEX IF NOT EXISTS oi_bars_time ON oi_bars(bucket_start);
      CREATE INDEX IF NOT EXISTS candle_samples_time ON candle_samples(start_timestamp);
      CREATE INDEX IF NOT EXISTS crossing_events_time ON crossing_events(observed_at);
      CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    try { this.db.exec("ALTER TABLE oi_samples ADD COLUMN source_time INTEGER"); } catch { /* existing schema */ }
    try { this.db.exec("ALTER TABLE oi_samples ADD COLUMN time_basis TEXT NOT NULL DEFAULT 'exchange'"); } catch { /* existing schema */ }
    try { this.db.exec("ALTER TABLE oi_bars ADD COLUMN first_observation_timestamp INTEGER"); } catch { /* existing schema */ }
    const candleColumns = new Set(this.prepare('PRAGMA table_info(candle_samples)').all().map((column) => String(column.name)));
    if (!candleColumns.has('source_provenance')) this.db.exec("ALTER TABLE candle_samples ADD COLUMN source_provenance TEXT NOT NULL DEFAULT 'legacy-unverified'");
    this.db.exec('CREATE TABLE IF NOT EXISTS oi_samples_quarantine (instrument_id TEXT NOT NULL, observation_timestamp INTEGER, source_timestamp INTEGER, received_at INTEGER, base REAL, quote REAL, quality TEXT, reason TEXT NOT NULL, quarantined_at INTEGER NOT NULL, payload_json TEXT NOT NULL);');
    this.selectOiBarByKey = this.prepare('SELECT instrument_id AS instrumentId, interval_ms AS intervalMs, bucket_start AS bucketStart, bucket_end AS bucketEnd, open_base AS openBase, high_base AS highBase, low_base AS lowBase, close_base AS closeBase, open_quote AS openQuote, high_quote AS highQuote, low_quote AS lowQuote, close_quote AS closeQuote, sample_count AS sampleCount, source_time_min AS sourceTimeMin, source_time_max AS sourceTimeMax, first_observation_timestamp AS firstObservationTimestamp, last_observation_timestamp AS lastObservationTimestamp, received_at AS receivedAt, time_basis AS timeBasis, quality FROM oi_bars WHERE instrument_id = ? AND interval_ms = ? AND bucket_start = ?');
    this.selectOiBars = this.prepare('SELECT instrument_id AS instrumentId, interval_ms AS intervalMs, bucket_start AS bucketStart, bucket_end AS bucketEnd, open_base AS openBase, high_base AS highBase, low_base AS lowBase, close_base AS closeBase, open_quote AS openQuote, high_quote AS highQuote, low_quote AS lowQuote, close_quote AS closeQuote, sample_count AS sampleCount, source_time_min AS sourceTimeMin, source_time_max AS sourceTimeMax, first_observation_timestamp AS firstObservationTimestamp, last_observation_timestamp AS lastObservationTimestamp, received_at AS receivedAt, time_basis AS timeBasis, quality FROM oi_bars WHERE instrument_id = ? AND interval_ms = ? AND bucket_start >= ? ORDER BY bucket_start ASC LIMIT ?');
    this.selectOiBarsWindow = this.prepare('SELECT instrument_id AS instrumentId, interval_ms AS intervalMs, bucket_start AS bucketStart, bucket_end AS bucketEnd, open_base AS openBase, high_base AS highBase, low_base AS lowBase, close_base AS closeBase, open_quote AS openQuote, high_quote AS highQuote, low_quote AS lowQuote, close_quote AS closeQuote, sample_count AS sampleCount, source_time_min AS sourceTimeMin, source_time_max AS sourceTimeMax, first_observation_timestamp AS firstObservationTimestamp, last_observation_timestamp AS lastObservationTimestamp, received_at AS receivedAt, time_basis AS timeBasis, quality FROM oi_bars WHERE instrument_id = ? AND interval_ms = ? AND '+OI_HISTORY_BOUNDED_TIME_SQL+' ORDER BY bucket_start ASC LIMIT ?');
    this.selectOiBarsAll = this.prepare('SELECT instrument_id AS instrumentId, interval_ms AS intervalMs, bucket_start AS bucketStart, bucket_end AS bucketEnd, open_base AS openBase, high_base AS highBase, low_base AS lowBase, close_base AS closeBase, open_quote AS openQuote, high_quote AS highQuote, low_quote AS lowQuote, close_quote AS closeQuote, sample_count AS sampleCount, source_time_min AS sourceTimeMin, source_time_max AS sourceTimeMax, first_observation_timestamp AS firstObservationTimestamp, last_observation_timestamp AS lastObservationTimestamp, received_at AS receivedAt, time_basis AS timeBasis, quality FROM oi_bars WHERE interval_ms = ? AND bucket_start >= ? ORDER BY bucket_start ASC, instrument_id ASC LIMIT ?');
    this.selectOiBarsAllWindow = this.prepare('SELECT instrument_id AS instrumentId, interval_ms AS intervalMs, bucket_start AS bucketStart, bucket_end AS bucketEnd, open_base AS openBase, high_base AS highBase, low_base AS lowBase, close_base AS closeBase, open_quote AS openQuote, high_quote AS highQuote, low_quote AS lowQuote, close_quote AS closeQuote, sample_count AS sampleCount, source_time_min AS sourceTimeMin, source_time_max AS sourceTimeMax, first_observation_timestamp AS firstObservationTimestamp, last_observation_timestamp AS lastObservationTimestamp, received_at AS receivedAt, time_basis AS timeBasis, quality FROM oi_bars WHERE interval_ms = ? AND '+OI_HISTORY_BOUNDED_TIME_SQL+' ORDER BY bucket_start ASC, instrument_id ASC LIMIT ?');
    this.estimateOiBars = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB))), 0) AS instrumentIdUtf8Bytes, COALESCE(SUM(LENGTH(CAST(time_basis AS BLOB))), 0) AS timeBasisUtf8Bytes, COALESCE(SUM(LENGTH(CAST(quality AS BLOB))), 0) AS qualityUtf8Bytes FROM (SELECT instrument_id, time_basis, quality FROM oi_bars WHERE instrument_id = ? AND interval_ms = ? AND bucket_start >= ? ORDER BY bucket_start ASC LIMIT ?)');
    this.estimateOiBarsWindow = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB))), 0) AS instrumentIdUtf8Bytes, COALESCE(SUM(LENGTH(CAST(time_basis AS BLOB))), 0) AS timeBasisUtf8Bytes, COALESCE(SUM(LENGTH(CAST(quality AS BLOB))), 0) AS qualityUtf8Bytes FROM (SELECT instrument_id, time_basis, quality FROM oi_bars WHERE instrument_id = ? AND interval_ms = ? AND '+OI_HISTORY_BOUNDED_TIME_SQL+' ORDER BY bucket_start ASC LIMIT ?)');
    this.estimateOiBarsAll = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB))), 0) AS instrumentIdUtf8Bytes, COALESCE(SUM(LENGTH(CAST(time_basis AS BLOB))), 0) AS timeBasisUtf8Bytes, COALESCE(SUM(LENGTH(CAST(quality AS BLOB))), 0) AS qualityUtf8Bytes FROM (SELECT instrument_id, time_basis, quality FROM oi_bars WHERE interval_ms = ? AND bucket_start >= ? ORDER BY bucket_start ASC, instrument_id ASC LIMIT ?)');
    this.estimateOiBarsAllWindow = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB))), 0) AS instrumentIdUtf8Bytes, COALESCE(SUM(LENGTH(CAST(time_basis AS BLOB))), 0) AS timeBasisUtf8Bytes, COALESCE(SUM(LENGTH(CAST(quality AS BLOB))), 0) AS qualityUtf8Bytes FROM (SELECT instrument_id, time_basis, quality FROM oi_bars WHERE interval_ms = ? AND '+OI_HISTORY_BOUNDED_TIME_SQL+' ORDER BY bucket_start ASC, instrument_id ASC LIMIT ?)');
    this.insertOiBar = this.prepare('INSERT OR REPLACE INTO oi_bars (instrument_id, interval_ms, bucket_start, bucket_end, open_base, high_base, low_base, close_base, open_quote, high_quote, low_quote, close_quote, sample_count, source_time_min, source_time_max, first_observation_timestamp, last_observation_timestamp, received_at, time_basis, quality) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    // Old rows used source_timestamp as their only clock. Promote only rows
    // from that genuinely legacy schema. Modern receipt-time rows also have a
    // null source_time, so selecting them by value alone would corrupt their
    // provenance on every restart. Work is bounded per startup and resumes
    // through migration_state when a legacy table is larger than the cap.
    const priorPending = this.prepare("SELECT value FROM migration_state WHERE key = 'oi-legacy-pending'").get()?.value === '1';
    const priorCutoff = Number(this.prepare("SELECT value FROM migration_state WHERE key = 'oi-legacy-cutoff-rowid'").get()?.value);
    const legacyCutoffRowid = Number.isInteger(priorCutoff) && priorCutoff > 0
      ? priorCutoff
      : (legacyOiSchema ? Number(this.prepare('SELECT MAX(rowid) AS maxRowid FROM oi_samples').get()?.maxRowid ?? 0) : 0);
    if (legacyOiSchema && legacyCutoffRowid > 0) this.prepare("INSERT OR REPLACE INTO migration_state (key, value) VALUES ('oi-legacy-cutoff-rowid', ?)").run(String(legacyCutoffRowid));
    this.legacyOiMigrationPending = legacyOiSchema || priorPending;
    const migrationBatchSize = Math.min(LEGACY_OI_BATCH_SIZE, this.legacyOiMigrationMaxRows);
    const promoteOi = this.prepare(`UPDATE oi_samples SET source_time = source_timestamp, time_basis = 'exchange' WHERE rowid IN (SELECT rowid FROM oi_samples WHERE rowid <= ? AND source_time IS NULL AND source_timestamp > 0 AND (time_basis IS NULL OR time_basis = 'exchange') LIMIT ${migrationBatchSize})`);
    let promoted = 0;
    while (this.legacyOiMigrationPending && promoted < this.legacyOiMigrationMaxRows) {
      this.db.exec('BEGIN');
      let changed = 0;
      try { changed = Number(promoteOi.run(legacyCutoffRowid)?.changes ?? 0); this.db.exec('COMMIT'); }
      catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
      if (changed <= 0) break;
      promoted += changed;
    }
    if (this.legacyOiMigrationPending) {
      this.legacyOiMigrationPending = Boolean(this.prepare("SELECT 1 FROM oi_samples WHERE rowid <= ? AND source_time IS NULL AND source_timestamp > 0 AND (time_basis IS NULL OR time_basis = 'exchange') LIMIT 1").get(legacyCutoffRowid));
      this.prepare("INSERT OR REPLACE INTO migration_state (key, value) VALUES ('oi-legacy-pending', ?)").run(this.legacyOiMigrationPending ? '1' : '0');
    }
    // Migrate malformed legacy OI in small transactions. A corrupt/hostile old
    // database must not turn startup into one unbounded JSON/SQL operation.
    const badOi = this.prepare('SELECT rowid, instrument_id AS instrumentId, source_timestamp AS observationTimestamp, source_time AS sourceTimestamp, received_at AS receivedAt, base, quote, quality FROM oi_samples WHERE source_timestamp <= 0 LIMIT 500');
    const quarantineOi = this.prepare("INSERT INTO oi_samples_quarantine (instrument_id, observation_timestamp, source_timestamp, received_at, base, quote, quality, reason, quarantined_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, 'invalid-observation-timestamp', ?, ?)");
    const deleteOi = this.prepare('DELETE FROM oi_samples WHERE rowid = ?');
    let quarantined = 0;
    while (quarantined < LEGACY_OI_MAX_ROWS_PER_START) {
      const rows = badOi.all(); if (!rows.length) break;
      this.db.exec('BEGIN');
      try { for (const row of rows) quarantineOi.run(row.instrumentId, row.observationTimestamp, row.sourceTimestamp, row.receivedAt, row.base, row.quote, row.quality, Date.now(), JSON.stringify({ instrumentId: row.instrumentId, observationTimestamp: row.observationTimestamp, sourceTimestamp: row.sourceTimestamp, receivedAt: row.receivedAt, base: row.base, quote: row.quote, quality: row.quality })); for (const row of rows) deleteOi.run(row.rowid); this.db.exec('COMMIT'); }
      catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
      quarantined += rows.length;
    }
    this.#migrateOiSamplesToBars();
    this.db.exec('CREATE TABLE IF NOT EXISTS depth_samples (instrument_id TEXT NOT NULL, source_timestamp INTEGER NOT NULL, received_at INTEGER NOT NULL, best_bid REAL, best_ask REAL, bid_notional REAL NOT NULL, ask_notional REAL NOT NULL, level_count INTEGER NOT NULL, complete INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (instrument_id, source_timestamp)); CREATE INDEX IF NOT EXISTS depth_samples_time ON depth_samples(source_timestamp);');
    this.db.exec('CREATE TABLE IF NOT EXISTS heatmap_columns (instrument_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, bucket_end INTEGER NOT NULL, observed_ms INTEGER NOT NULL, expected_ms INTEGER NOT NULL, gap_ms INTEGER NOT NULL, coverage TEXT NOT NULL, source_timestamp_min INTEGER, source_timestamp_max INTEGER, received_at INTEGER, source_resolution TEXT, source_grouping REAL, grid_epoch TEXT, observed_intervals TEXT, gap_intervals TEXT, PRIMARY KEY (instrument_id, bucket_start)); CREATE INDEX IF NOT EXISTS heatmap_columns_time ON heatmap_columns(bucket_start); CREATE TABLE IF NOT EXISTS heatmap_cells (instrument_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, side TEXT NOT NULL, price_low REAL NOT NULL, price_high REAL NOT NULL, mean_amount REAL, mean_notional_usd REAL, peak_amount REAL, peak_notional_usd REAL, observed_ms INTEGER NOT NULL, expected_ms INTEGER NOT NULL, gap_ms INTEGER NOT NULL, coverage TEXT NOT NULL, source_timestamp_min INTEGER, source_timestamp_max INTEGER, received_at INTEGER, source_resolution TEXT, source_grouping REAL, grid_epoch TEXT, observed_intervals TEXT, observed_segments TEXT, PRIMARY KEY (instrument_id, bucket_start, side, price_low)); CREATE INDEX IF NOT EXISTS heatmap_cells_time ON heatmap_cells(bucket_start);');
    // Matching full order prevents a native sorter from retaining JSON during streamed reads.
    this.db.exec('CREATE INDEX IF NOT EXISTS heatmap_cells_source_order ON heatmap_cells(instrument_id, bucket_start, price_low, side); CREATE INDEX IF NOT EXISTS heatmap_cells_global_order ON heatmap_cells(bucket_start, price_low, instrument_id, side);');
    for (const statement of [
      'ALTER TABLE heatmap_columns ADD COLUMN observed_intervals TEXT',
      'ALTER TABLE heatmap_columns ADD COLUMN gap_intervals TEXT',
      'ALTER TABLE heatmap_cells ADD COLUMN observed_intervals TEXT',
      'ALTER TABLE heatmap_cells ADD COLUMN observed_segments TEXT',
    ]) { try { this.db.exec(statement); } catch { /* existing schema */ } }
    this.insertCrossing = this.prepare('INSERT OR IGNORE INTO crossing_events (level_id, observed_at, layer, mark_price, direction, provisional) VALUES (?, ?, ?, ?, ?, ?)');
    this.insertLayer = this.prepare('INSERT OR REPLACE INTO layer_snapshots (layer, instrument_id, revision, source_timestamp, received_at, complete, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.insertState = this.prepare('INSERT OR REPLACE INTO state_snapshots (id, as_of, saved_at, payload_json) VALUES (1, ?, ?, ?)');
    this.insertDepth = this.prepare('INSERT OR REPLACE INTO depth_samples (instrument_id, source_timestamp, received_at, best_bid, best_ask, bid_notional, ask_notional, level_count, complete, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.selectDepthRows = this.prepare('SELECT instrument_id AS instrumentId, source_timestamp AS sourceTimestamp, received_at AS receivedAt, best_bid AS bestBid, best_ask AS bestAsk, bid_notional AS bidNotional, ask_notional AS askNotional, level_count AS levelCount, complete, payload_json AS payloadJson FROM depth_samples WHERE instrument_id = ? AND source_timestamp >= ? ORDER BY source_timestamp ASC, instrument_id ASC LIMIT ?');
    this.selectDepthRowsAll = this.prepare('SELECT instrument_id AS instrumentId, source_timestamp AS sourceTimestamp, received_at AS receivedAt, best_bid AS bestBid, best_ask AS bestAsk, bid_notional AS bidNotional, ask_notional AS askNotional, level_count AS levelCount, complete, payload_json AS payloadJson FROM depth_samples WHERE source_timestamp >= ? ORDER BY source_timestamp ASC, instrument_id ASC LIMIT ?');
    this.estimateDepthRows = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB))), 0) AS textUtf8Bytes, COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, payload_json FROM depth_samples WHERE instrument_id = ? AND source_timestamp >= ? ORDER BY source_timestamp ASC, instrument_id ASC LIMIT ?)');
    this.estimateDepthRowsAll = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB))), 0) AS textUtf8Bytes, COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, payload_json FROM depth_samples WHERE source_timestamp >= ? ORDER BY source_timestamp ASC, instrument_id ASC LIMIT ?)');
    this.selectDepthSummary = this.prepare('SELECT COUNT(*) AS samples, MAX(received_at) AS latestReceivedAt FROM depth_samples WHERE instrument_id = ?');
    this.selectDepthAtTimestamp = this.prepare('SELECT 1 AS present FROM depth_samples WHERE instrument_id = ? AND source_timestamp = ? LIMIT 1');
    // Creating sibling storage is an admitted heatmap write, not an OI-only startup cost.
    this.heatmapRunTablesReady = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='heatmap_observation_columns'").get());
    this.db.exec(heatmapReadViewSql(this.heatmapRunTablesReady));
    this.insertHeatmapColumn = this.prepare('INSERT OR REPLACE INTO heatmap_columns (instrument_id, bucket_start, bucket_end, observed_ms, expected_ms, gap_ms, coverage, source_timestamp_min, source_timestamp_max, received_at, source_resolution, source_grouping, grid_epoch, observed_intervals, gap_intervals) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.insertHeatmapCell = this.prepare('INSERT OR REPLACE INTO heatmap_cells (instrument_id, bucket_start, side, price_low, price_high, mean_amount, mean_notional_usd, peak_amount, peak_notional_usd, observed_ms, expected_ms, gap_ms, coverage, source_timestamp_min, source_timestamp_max, received_at, source_resolution, source_grouping, grid_epoch, observed_intervals, observed_segments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.selectHeatmapColumns = this.prepare('SELECT instrument_id AS instrumentId, bucket_start AS bucketStart, bucket_end AS bucketEnd, observed_ms AS observedMs, expected_ms AS expectedMs, gap_ms AS gapMs, coverage, source_timestamp_min AS sourceTimestampMin, source_timestamp_max AS sourceTimestampMax, received_at AS receivedAt, source_resolution AS sourceResolution, source_grouping AS sourceGrouping, grid_epoch AS gridEpoch, observed_intervals AS observedIntervalsJson, gap_intervals AS gapIntervalsJson FROM heatmap_columns WHERE instrument_id = ? AND bucket_start >= ? ORDER BY bucket_start ASC LIMIT ?');
    this.selectHeatmapColumnsViewport = this.prepare('SELECT instrument_id AS instrumentId, bucket_start AS bucketStart, bucket_end AS bucketEnd, observed_ms AS observedMs, expected_ms AS expectedMs, gap_ms AS gapMs, coverage, source_timestamp_min AS sourceTimestampMin, source_timestamp_max AS sourceTimestampMax, received_at AS receivedAt, source_resolution AS sourceResolution, source_grouping AS sourceGrouping, grid_epoch AS gridEpoch, observed_intervals AS observedIntervalsJson, gap_intervals AS gapIntervalsJson FROM heatmap_columns WHERE instrument_id = ? AND bucket_end > ? AND (? IS NULL OR bucket_start < ?) ORDER BY bucket_start ASC LIMIT ?');
    this.selectHeatmapColumnsAll = this.prepare('SELECT instrument_id AS instrumentId, bucket_start AS bucketStart, bucket_end AS bucketEnd, observed_ms AS observedMs, expected_ms AS expectedMs, gap_ms AS gapMs, coverage, source_timestamp_min AS sourceTimestampMin, source_timestamp_max AS sourceTimestampMax, received_at AS receivedAt, source_resolution AS sourceResolution, source_grouping AS sourceGrouping, grid_epoch AS gridEpoch, observed_intervals AS observedIntervalsJson, gap_intervals AS gapIntervalsJson FROM heatmap_columns WHERE bucket_start >= ? ORDER BY bucket_start ASC, instrument_id ASC LIMIT ?');
    this.selectHeatmapColumnsAllViewport = this.prepare('SELECT instrument_id AS instrumentId, bucket_start AS bucketStart, bucket_end AS bucketEnd, observed_ms AS observedMs, expected_ms AS expectedMs, gap_ms AS gapMs, coverage, source_timestamp_min AS sourceTimestampMin, source_timestamp_max AS sourceTimestampMax, received_at AS receivedAt, source_resolution AS sourceResolution, source_grouping AS sourceGrouping, grid_epoch AS gridEpoch, observed_intervals AS observedIntervalsJson, gap_intervals AS gapIntervalsJson FROM heatmap_columns WHERE bucket_end > ? AND (? IS NULL OR bucket_start < ?) ORDER BY bucket_start ASC, instrument_id ASC LIMIT ?');
    this.selectHeatmapCells = this.prepare('SELECT instrument_id AS instrumentId, bucket_start AS bucketStart, side, price_low AS priceLow, price_high AS priceHigh, mean_amount AS meanAmount, mean_notional_usd AS meanNotionalUsd, peak_amount AS peakAmount, peak_notional_usd AS peakNotionalUsd, observed_ms AS observedMs, expected_ms AS expectedMs, gap_ms AS gapMs, coverage, source_timestamp_min AS sourceTimestampMin, source_timestamp_max AS sourceTimestampMax, received_at AS receivedAt, source_resolution AS sourceResolution, source_grouping AS sourceGrouping, grid_epoch AS gridEpoch, observed_intervals AS observedIntervalsJson, observed_segments AS observedSegmentsJson FROM heatmap_cells INDEXED BY heatmap_cells_source_order WHERE instrument_id = ? AND bucket_start >= ? ORDER BY bucket_start ASC, price_low ASC, side ASC LIMIT ?');
    this.selectHeatmapCellsViewport = this.prepare('SELECT instrument_id AS instrumentId, bucket_start AS bucketStart, side, price_low AS priceLow, price_high AS priceHigh, mean_amount AS meanAmount, mean_notional_usd AS meanNotionalUsd, peak_amount AS peakAmount, peak_notional_usd AS peakNotionalUsd, observed_ms AS observedMs, expected_ms AS expectedMs, gap_ms AS gapMs, coverage, source_timestamp_min AS sourceTimestampMin, source_timestamp_max AS sourceTimestampMax, received_at AS receivedAt, source_resolution AS sourceResolution, source_grouping AS sourceGrouping, grid_epoch AS gridEpoch, observed_intervals AS observedIntervalsJson, observed_segments AS observedSegmentsJson FROM heatmap_cells INDEXED BY heatmap_cells_source_order WHERE instrument_id = ? AND EXISTS (SELECT 1 FROM heatmap_columns AS viewport_column WHERE viewport_column.instrument_id = heatmap_cells.instrument_id AND viewport_column.bucket_start = heatmap_cells.bucket_start AND viewport_column.bucket_end > ?) AND (? IS NULL OR bucket_start < ?) AND ((price_high > price_low AND (? IS NULL OR price_high > ?) AND (? IS NULL OR price_low < ?)) OR (price_high = price_low AND (? IS NULL OR price_low >= ?) AND (? IS NULL OR price_low <= ?))) ORDER BY bucket_start ASC, price_low ASC, side ASC LIMIT ?');
    this.selectHeatmapCellsAll = this.prepare('SELECT instrument_id AS instrumentId, bucket_start AS bucketStart, side, price_low AS priceLow, price_high AS priceHigh, mean_amount AS meanAmount, mean_notional_usd AS meanNotionalUsd, peak_amount AS peakAmount, peak_notional_usd AS peakNotionalUsd, observed_ms AS observedMs, expected_ms AS expectedMs, gap_ms AS gapMs, coverage, source_timestamp_min AS sourceTimestampMin, source_timestamp_max AS sourceTimestampMax, received_at AS receivedAt, source_resolution AS sourceResolution, source_grouping AS sourceGrouping, grid_epoch AS gridEpoch, observed_intervals AS observedIntervalsJson, observed_segments AS observedSegmentsJson FROM heatmap_cells INDEXED BY heatmap_cells_global_order WHERE bucket_start >= ? ORDER BY bucket_start ASC, price_low ASC, instrument_id ASC, side ASC LIMIT ?');
    this.selectHeatmapCellsAllViewport = this.prepare('SELECT instrument_id AS instrumentId, bucket_start AS bucketStart, side, price_low AS priceLow, price_high AS priceHigh, mean_amount AS meanAmount, mean_notional_usd AS meanNotionalUsd, peak_amount AS peakAmount, peak_notional_usd AS peakNotionalUsd, observed_ms AS observedMs, expected_ms AS expectedMs, gap_ms AS gapMs, coverage, source_timestamp_min AS sourceTimestampMin, source_timestamp_max AS sourceTimestampMax, received_at AS receivedAt, source_resolution AS sourceResolution, source_grouping AS sourceGrouping, grid_epoch AS gridEpoch, observed_intervals AS observedIntervalsJson, observed_segments AS observedSegmentsJson FROM heatmap_cells INDEXED BY heatmap_cells_global_order WHERE EXISTS (SELECT 1 FROM heatmap_columns AS viewport_column WHERE viewport_column.instrument_id = heatmap_cells.instrument_id AND viewport_column.bucket_start = heatmap_cells.bucket_start AND viewport_column.bucket_end > ?) AND (? IS NULL OR bucket_start < ?) AND ((price_high > price_low AND (? IS NULL OR price_high > ?) AND (? IS NULL OR price_low < ?)) OR (price_high = price_low AND (? IS NULL OR price_low >= ?) AND (? IS NULL OR price_low <= ?))) ORDER BY bucket_start ASC, price_low ASC, instrument_id ASC, side ASC LIMIT ?');
    this.estimateHeatmapColumns = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(coverage AS BLOB)) + COALESCE(LENGTH(CAST(source_resolution AS BLOB)), 0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)), 0) + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)), 0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0)), 0) AS textUtf8Bytes, COALESCE(SUM(COALESCE(COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0), 0) + COALESCE(COALESCE(LENGTH(CAST(gap_intervals AS BLOB)),0), 0)), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, coverage, source_resolution, source_grouping, grid_epoch, observation_run, observed_intervals, gap_intervals FROM heatmap_columns WHERE instrument_id = ? AND bucket_start >= ? ORDER BY bucket_start ASC LIMIT ?)');
    this.estimateHeatmapColumnsViewport = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(coverage AS BLOB)) + COALESCE(LENGTH(CAST(source_resolution AS BLOB)), 0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)), 0) + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)), 0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0)), 0) AS textUtf8Bytes, COALESCE(SUM(COALESCE(COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0), 0) + COALESCE(COALESCE(LENGTH(CAST(gap_intervals AS BLOB)),0), 0)), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, coverage, source_resolution, source_grouping, grid_epoch, observation_run, observed_intervals, gap_intervals FROM heatmap_columns WHERE instrument_id = ? AND bucket_end > ? AND (? IS NULL OR bucket_start < ?) ORDER BY bucket_start ASC LIMIT ?)');
    this.estimateHeatmapColumnsAll = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(coverage AS BLOB)) + COALESCE(LENGTH(CAST(source_resolution AS BLOB)), 0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)), 0) + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)), 0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0)), 0) AS textUtf8Bytes, COALESCE(SUM(COALESCE(COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0), 0) + COALESCE(COALESCE(LENGTH(CAST(gap_intervals AS BLOB)),0), 0)), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, coverage, source_resolution, source_grouping, grid_epoch, observation_run, observed_intervals, gap_intervals FROM heatmap_columns WHERE bucket_start >= ? ORDER BY bucket_start ASC, instrument_id ASC LIMIT ?)');
    this.estimateHeatmapColumnsAllViewport = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(coverage AS BLOB)) + COALESCE(LENGTH(CAST(source_resolution AS BLOB)), 0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)), 0) + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)), 0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0)), 0) AS textUtf8Bytes, COALESCE(SUM(COALESCE(COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0), 0) + COALESCE(COALESCE(LENGTH(CAST(gap_intervals AS BLOB)),0), 0)), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, coverage, source_resolution, source_grouping, grid_epoch, observation_run, observed_intervals, gap_intervals FROM heatmap_columns WHERE bucket_end > ? AND (? IS NULL OR bucket_start < ?) ORDER BY bucket_start ASC, instrument_id ASC LIMIT ?)');
    this.estimateHeatmapCells = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(side AS BLOB)) + LENGTH(CAST(coverage AS BLOB)) + COALESCE(LENGTH(CAST(source_resolution AS BLOB)), 0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)), 0) + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)), 0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0)), 0) AS textUtf8Bytes, COALESCE(SUM(COALESCE(COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0), 0) + COALESCE(COALESCE(LENGTH(CAST(observed_segments AS BLOB)),0), 0)), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, side, coverage, source_resolution, source_grouping, grid_epoch, observation_run, observed_intervals, observed_segments FROM heatmap_cells WHERE instrument_id = ? AND bucket_start >= ? ORDER BY bucket_start ASC, price_low ASC, side ASC LIMIT ?)');
    this.estimateHeatmapCellsViewport = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(side AS BLOB)) + LENGTH(CAST(coverage AS BLOB)) + COALESCE(LENGTH(CAST(source_resolution AS BLOB)), 0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)), 0) + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)), 0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0)), 0) AS textUtf8Bytes, COALESCE(SUM(COALESCE(COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0), 0) + COALESCE(COALESCE(LENGTH(CAST(observed_segments AS BLOB)),0), 0)), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, side, coverage, source_resolution, source_grouping, grid_epoch, observation_run, observed_intervals, observed_segments FROM heatmap_cells WHERE instrument_id = ? AND EXISTS (SELECT 1 FROM heatmap_columns AS viewport_column WHERE viewport_column.instrument_id = heatmap_cells.instrument_id AND viewport_column.bucket_start = heatmap_cells.bucket_start AND viewport_column.bucket_end > ?) AND (? IS NULL OR bucket_start < ?) AND ((price_high > price_low AND (? IS NULL OR price_high > ?) AND (? IS NULL OR price_low < ?)) OR (price_high = price_low AND (? IS NULL OR price_low >= ?) AND (? IS NULL OR price_low <= ?))) ORDER BY bucket_start ASC, price_low ASC, side ASC LIMIT ?)');
    this.estimateHeatmapCellsAll = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(side AS BLOB)) + LENGTH(CAST(coverage AS BLOB)) + COALESCE(LENGTH(CAST(source_resolution AS BLOB)), 0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)), 0) + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)), 0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0)), 0) AS textUtf8Bytes, COALESCE(SUM(COALESCE(COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0), 0) + COALESCE(COALESCE(LENGTH(CAST(observed_segments AS BLOB)),0), 0)), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, side, coverage, source_resolution, source_grouping, grid_epoch, observation_run, observed_intervals, observed_segments FROM heatmap_cells WHERE bucket_start >= ? ORDER BY bucket_start ASC, price_low ASC, instrument_id ASC, side ASC LIMIT ?)');
    this.estimateHeatmapCellsAllViewport = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(side AS BLOB)) + LENGTH(CAST(coverage AS BLOB)) + COALESCE(LENGTH(CAST(source_resolution AS BLOB)), 0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)), 0) + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)), 0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0)), 0) AS textUtf8Bytes, COALESCE(SUM(COALESCE(COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0), 0) + COALESCE(COALESCE(LENGTH(CAST(observed_segments AS BLOB)),0), 0)), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, side, coverage, source_resolution, source_grouping, grid_epoch, observation_run, observed_intervals, observed_segments FROM heatmap_cells WHERE EXISTS (SELECT 1 FROM heatmap_columns AS viewport_column WHERE viewport_column.instrument_id = heatmap_cells.instrument_id AND viewport_column.bucket_start = heatmap_cells.bucket_start AND viewport_column.bucket_end > ?) AND (? IS NULL OR bucket_start < ?) AND ((price_high > price_low AND (? IS NULL OR price_high > ?) AND (? IS NULL OR price_low < ?)) OR (price_high = price_low AND (? IS NULL OR price_low >= ?) AND (? IS NULL OR price_low <= ?))) ORDER BY bucket_start ASC, price_low ASC, instrument_id ASC, side ASC LIMIT ?)');
    this.estimateProjectedHeatmapCells = this.prepare('WITH selected AS (SELECT LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(side AS BLOB)) + LENGTH(CAST(coverage AS BLOB)) + COALESCE(LENGTH(CAST(source_resolution AS BLOB)), 0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)), 0) + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)), 0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0) AS text_utf8_bytes, COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0) + COALESCE(LENGTH(CAST(observed_segments AS BLOB)),0) AS payload_utf8_bytes, COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0) AS interval_utf8_bytes, json_array_length(observed_segments) AS source_segments, json_array_length(observed_intervals) AS interval_count, expected_ms FROM heatmap_cells WHERE instrument_id = ? AND bucket_start >= ? ORDER BY bucket_start ASC, price_low ASC, side ASC LIMIT ?) SELECT COUNT(*) AS count, COALESCE(SUM(source_segments), 0) AS sourceSegmentCount, COALESCE(SUM(text_utf8_bytes), 0) AS textUtf8Bytes, COALESCE(SUM(payload_utf8_bytes), 0) AS payloadUtf8Bytes, COALESCE(MAX(text_utf8_bytes + payload_utf8_bytes), 0) AS largestCellRowUtf8Bytes, COALESCE(MAX(payload_utf8_bytes), 0) AS largestCellPayloadUtf8Bytes, COALESCE(SUM(interval_utf8_bytes), 0) AS intervalPayloadUtf8Bytes, COALESCE(SUM(CASE WHEN (SELECT SUM(source_segments) FROM selected) > 4096 AND source_segments > 1 THEN MIN(source_segments, CAST((expected_ms + ? - 1) / ? AS INTEGER) + 2 * interval_count + 1) ELSE source_segments END), 0) AS compactSegmentCount FROM selected');
    this.estimateProjectedHeatmapCellsViewport = this.prepare('WITH selected AS (SELECT LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(side AS BLOB)) + LENGTH(CAST(coverage AS BLOB)) + COALESCE(LENGTH(CAST(source_resolution AS BLOB)), 0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)), 0) + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)), 0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0) AS text_utf8_bytes, COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0) + COALESCE(LENGTH(CAST(observed_segments AS BLOB)),0) AS payload_utf8_bytes, COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0) AS interval_utf8_bytes, json_array_length(observed_segments) AS source_segments, json_array_length(observed_intervals) AS interval_count, expected_ms FROM heatmap_cells WHERE instrument_id = ? AND EXISTS (SELECT 1 FROM heatmap_columns AS viewport_column WHERE viewport_column.instrument_id = heatmap_cells.instrument_id AND viewport_column.bucket_start = heatmap_cells.bucket_start AND viewport_column.bucket_end > ?) AND (? IS NULL OR bucket_start < ?) AND ((price_high > price_low AND (? IS NULL OR price_high > ?) AND (? IS NULL OR price_low < ?)) OR (price_high = price_low AND (? IS NULL OR price_low >= ?) AND (? IS NULL OR price_low <= ?))) ORDER BY bucket_start ASC, price_low ASC, side ASC LIMIT ?) SELECT COUNT(*) AS count, COALESCE(SUM(source_segments), 0) AS sourceSegmentCount, COALESCE(SUM(text_utf8_bytes), 0) AS textUtf8Bytes, COALESCE(SUM(payload_utf8_bytes), 0) AS payloadUtf8Bytes, COALESCE(MAX(text_utf8_bytes + payload_utf8_bytes), 0) AS largestCellRowUtf8Bytes, COALESCE(MAX(payload_utf8_bytes), 0) AS largestCellPayloadUtf8Bytes, COALESCE(SUM(interval_utf8_bytes), 0) AS intervalPayloadUtf8Bytes, COALESCE(SUM(CASE WHEN (SELECT SUM(source_segments) FROM selected) > 4096 AND source_segments > 1 THEN MIN(source_segments, CAST((expected_ms + ? - 1) / ? AS INTEGER) + 2 * interval_count + 1) ELSE source_segments END), 0) AS compactSegmentCount FROM selected');
    this.estimateProjectedHeatmapCellsAll = this.prepare('WITH selected AS (SELECT LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(side AS BLOB)) + LENGTH(CAST(coverage AS BLOB)) + COALESCE(LENGTH(CAST(source_resolution AS BLOB)), 0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)), 0) + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)), 0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0) AS text_utf8_bytes, COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0) + COALESCE(LENGTH(CAST(observed_segments AS BLOB)),0) AS payload_utf8_bytes, COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0) AS interval_utf8_bytes, json_array_length(observed_segments) AS source_segments, json_array_length(observed_intervals) AS interval_count, expected_ms FROM heatmap_cells WHERE bucket_start >= ? ORDER BY bucket_start ASC, price_low ASC, instrument_id ASC, side ASC LIMIT ?) SELECT COUNT(*) AS count, COALESCE(SUM(source_segments), 0) AS sourceSegmentCount, COALESCE(SUM(text_utf8_bytes), 0) AS textUtf8Bytes, COALESCE(SUM(payload_utf8_bytes), 0) AS payloadUtf8Bytes, COALESCE(MAX(text_utf8_bytes + payload_utf8_bytes), 0) AS largestCellRowUtf8Bytes, COALESCE(MAX(payload_utf8_bytes), 0) AS largestCellPayloadUtf8Bytes, COALESCE(SUM(interval_utf8_bytes), 0) AS intervalPayloadUtf8Bytes, COALESCE(SUM(CASE WHEN (SELECT SUM(source_segments) FROM selected) > 4096 AND source_segments > 1 THEN MIN(source_segments, CAST((expected_ms + ? - 1) / ? AS INTEGER) + 2 * interval_count + 1) ELSE source_segments END), 0) AS compactSegmentCount FROM selected');
    this.estimateProjectedHeatmapCellsAllViewport = this.prepare('WITH selected AS (SELECT LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(side AS BLOB)) + LENGTH(CAST(coverage AS BLOB)) + COALESCE(LENGTH(CAST(source_resolution AS BLOB)), 0) + COALESCE(LENGTH(CAST(source_grouping AS BLOB)), 0) + COALESCE(LENGTH(CAST(grid_epoch AS BLOB)), 0) + COALESCE(LENGTH(CAST(observation_run AS BLOB)),0) AS text_utf8_bytes, COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0) + COALESCE(LENGTH(CAST(observed_segments AS BLOB)),0) AS payload_utf8_bytes, COALESCE(LENGTH(CAST(observed_intervals AS BLOB)),0) AS interval_utf8_bytes, json_array_length(observed_segments) AS source_segments, json_array_length(observed_intervals) AS interval_count, expected_ms FROM heatmap_cells WHERE EXISTS (SELECT 1 FROM heatmap_columns AS viewport_column WHERE viewport_column.instrument_id = heatmap_cells.instrument_id AND viewport_column.bucket_start = heatmap_cells.bucket_start AND viewport_column.bucket_end > ?) AND (? IS NULL OR bucket_start < ?) AND ((price_high > price_low AND (? IS NULL OR price_high > ?) AND (? IS NULL OR price_low < ?)) OR (price_high = price_low AND (? IS NULL OR price_low >= ?) AND (? IS NULL OR price_low <= ?))) ORDER BY bucket_start ASC, price_low ASC, instrument_id ASC, side ASC LIMIT ?) SELECT COUNT(*) AS count, COALESCE(SUM(source_segments), 0) AS sourceSegmentCount, COALESCE(SUM(text_utf8_bytes), 0) AS textUtf8Bytes, COALESCE(SUM(payload_utf8_bytes), 0) AS payloadUtf8Bytes, COALESCE(MAX(text_utf8_bytes + payload_utf8_bytes), 0) AS largestCellRowUtf8Bytes, COALESCE(MAX(payload_utf8_bytes), 0) AS largestCellPayloadUtf8Bytes, COALESCE(SUM(interval_utf8_bytes), 0) AS intervalPayloadUtf8Bytes, COALESCE(SUM(CASE WHEN (SELECT SUM(source_segments) FROM selected) > 4096 AND source_segments > 1 THEN MIN(source_segments, CAST((expected_ms + ? - 1) / ? AS INTEGER) + 2 * interval_count + 1) ELSE source_segments END), 0) AS compactSegmentCount FROM selected');
    this.selectDisplayHeatmapKeys = this.prepare(HEATMAP_DISPLAY_PAGE_SQL + 'SELECT instrument_id AS instrumentId, display_start AS bucketStart, display_end AS bucketEnd FROM display_page ORDER BY display_start, instrument_id, display_end');
    this.selectDisplayHeatmapColumns = this.prepare(HEATMAP_DISPLAY_PAGE_SQL + 'SELECT ' + HEATMAP_DISPLAY_COLUMN_FIELDS + ' FROM heatmap_columns hc JOIN selected_columns sc ON sc.instrument_id=hc.instrument_id AND sc.bucket_start=hc.bucket_start AND sc.observation_run IS hc.observation_run ORDER BY hc.bucket_start, hc.instrument_id');
    this.selectDisplayHeatmapCells = this.prepare(HEATMAP_DISPLAY_PAGE_SQL + 'SELECT ' + HEATMAP_DISPLAY_CELL_FIELDS + ` FROM heatmap_cells hc INDEXED BY heatmap_cells_global_order
      WHERE bucket_start >= (SELECT MIN(bucket_start) FROM selected_columns) AND bucket_start <= (SELECT MAX(bucket_start) FROM selected_columns)
      AND EXISTS (SELECT 1 FROM selected_columns sc WHERE sc.instrument_id = hc.instrument_id AND sc.bucket_start = hc.bucket_start AND sc.observation_run IS hc.observation_run)
      AND EXISTS (SELECT 1 FROM args WHERE ((hc.price_high > hc.price_low AND (price_low IS NULL OR hc.price_high > price_low) AND (price_high IS NULL OR hc.price_low < price_high))
        OR (hc.price_high = hc.price_low AND (price_low IS NULL OR hc.price_low >= price_low) AND (price_high IS NULL OR hc.price_low <= price_high))))
      ORDER BY bucket_start, price_low, instrument_id, side LIMIT (SELECT cell_limit + 1 FROM args)`);
    this.estimateDisplayHeatmap = this.prepare(HEATMAP_DISPLAY_ESTIMATE_SQL);
    this.estimateMeanHeatmap = this.prepare(HEATMAP_MEAN_DISPLAY_ESTIMATE_SQL);
    this.selectLayerSnapshots = this.prepare('SELECT layer, instrument_id AS instrumentId, revision, source_timestamp AS sourceTimestamp, received_at AS receivedAt, complete, payload_json AS payloadJson FROM layer_snapshots WHERE layer = ? AND instrument_id = ? AND source_timestamp >= ? AND source_timestamp < ? ORDER BY source_timestamp ASC, revision ASC LIMIT ?');
    this.selectLayerSnapshotsAll = this.prepare('SELECT layer, instrument_id AS instrumentId, revision, source_timestamp AS sourceTimestamp, received_at AS receivedAt, complete, payload_json AS payloadJson FROM layer_snapshots WHERE layer = ? AND source_timestamp >= ? AND source_timestamp < ? ORDER BY source_timestamp ASC, instrument_id ASC, revision ASC LIMIT ?');
    this.estimateLayerSnapshots = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(layer AS BLOB)) + LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(revision AS BLOB))), 0) AS textUtf8Bytes, COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS payloadUtf8Bytes FROM (SELECT layer, instrument_id, revision, payload_json FROM layer_snapshots WHERE layer = ? AND instrument_id = ? AND source_timestamp >= ? AND source_timestamp < ? ORDER BY source_timestamp ASC, revision ASC LIMIT ?)');
    this.estimateLayerSnapshotsAll = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(layer AS BLOB)) + LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(revision AS BLOB))), 0) AS textUtf8Bytes, COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS payloadUtf8Bytes FROM (SELECT layer, instrument_id, revision, payload_json FROM layer_snapshots WHERE layer = ? AND source_timestamp >= ? AND source_timestamp < ? ORDER BY source_timestamp ASC, instrument_id ASC, revision ASC LIMIT ?)');
    this.selectCandle = this.prepare('SELECT instrument_id AS instrumentId, interval, start_timestamp AS start, end_timestamp AS end, open, high, low, close, volume, source_timestamp AS sourceTimestamp, source_provenance AS sourceProvenance, received_at AS receivedAt, closed, quality, origin AS source, payload_json AS payloadJson FROM candle_samples WHERE instrument_id = ? AND interval = ? AND start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp ASC LIMIT ?');
    this.selectCandleAllIntervals = this.prepare('SELECT instrument_id AS instrumentId, interval, start_timestamp AS start, end_timestamp AS end, open, high, low, close, volume, source_timestamp AS sourceTimestamp, source_provenance AS sourceProvenance, received_at AS receivedAt, closed, quality, origin AS source, payload_json AS payloadJson FROM candle_samples WHERE instrument_id = ? AND start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp ASC, interval ASC LIMIT ?');
    this.selectCandleAll = this.prepare('SELECT instrument_id AS instrumentId, interval, start_timestamp AS start, end_timestamp AS end, open, high, low, close, volume, source_timestamp AS sourceTimestamp, source_provenance AS sourceProvenance, received_at AS receivedAt, closed, quality, origin AS source, payload_json AS payloadJson FROM candle_samples WHERE start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp ASC, instrument_id ASC, interval ASC LIMIT ?');
    this.selectCandleAllByInterval = this.prepare('SELECT instrument_id AS instrumentId, interval, start_timestamp AS start, end_timestamp AS end, open, high, low, close, volume, source_timestamp AS sourceTimestamp, source_provenance AS sourceProvenance, received_at AS receivedAt, closed, quality, origin AS source, payload_json AS payloadJson FROM candle_samples WHERE interval = ? AND start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp ASC, instrument_id ASC LIMIT ?');
    this.selectCandleNewest = this.prepare('SELECT instrument_id AS instrumentId, interval, start_timestamp AS start, end_timestamp AS end, open, high, low, close, volume, source_timestamp AS sourceTimestamp, source_provenance AS sourceProvenance, received_at AS receivedAt, closed, quality, origin AS source, payload_json AS payloadJson FROM candle_samples WHERE instrument_id = ? AND interval = ? AND start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp DESC LIMIT ?');
    this.selectCandleAllIntervalsNewest = this.prepare('SELECT instrument_id AS instrumentId, interval, start_timestamp AS start, end_timestamp AS end, open, high, low, close, volume, source_timestamp AS sourceTimestamp, source_provenance AS sourceProvenance, received_at AS receivedAt, closed, quality, origin AS source, payload_json AS payloadJson FROM candle_samples WHERE instrument_id = ? AND start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp DESC LIMIT ?');
    this.selectCandleAllNewest = this.prepare('SELECT instrument_id AS instrumentId, interval, start_timestamp AS start, end_timestamp AS end, open, high, low, close, volume, source_timestamp AS sourceTimestamp, source_provenance AS sourceProvenance, received_at AS receivedAt, closed, quality, origin AS source, payload_json AS payloadJson FROM candle_samples WHERE start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp DESC LIMIT ?');
    this.selectCandleAllByIntervalNewest = this.prepare('SELECT instrument_id AS instrumentId, interval, start_timestamp AS start, end_timestamp AS end, open, high, low, close, volume, source_timestamp AS sourceTimestamp, source_provenance AS sourceProvenance, received_at AS receivedAt, closed, quality, origin AS source, payload_json AS payloadJson FROM candle_samples WHERE interval = ? AND start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp DESC LIMIT ?');
    this.estimateCandles = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(interval AS BLOB)) + LENGTH(CAST(source_provenance AS BLOB)) + COALESCE(LENGTH(CAST(quality AS BLOB)), 0) + LENGTH(CAST(origin AS BLOB))), 0) AS textUtf8Bytes, COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, interval, source_provenance, quality, origin, payload_json FROM candle_samples WHERE instrument_id = ? AND interval = ? AND start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp ASC LIMIT ?)');
    this.estimateCandlesAllIntervals = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(interval AS BLOB)) + LENGTH(CAST(source_provenance AS BLOB)) + COALESCE(LENGTH(CAST(quality AS BLOB)), 0) + LENGTH(CAST(origin AS BLOB))), 0) AS textUtf8Bytes, COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, interval, source_provenance, quality, origin, payload_json FROM candle_samples WHERE instrument_id = ? AND start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp ASC, interval ASC LIMIT ?)');
    this.estimateCandlesAll = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(interval AS BLOB)) + LENGTH(CAST(source_provenance AS BLOB)) + COALESCE(LENGTH(CAST(quality AS BLOB)), 0) + LENGTH(CAST(origin AS BLOB))), 0) AS textUtf8Bytes, COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, interval, source_provenance, quality, origin, payload_json FROM candle_samples WHERE start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp ASC, instrument_id ASC, interval ASC LIMIT ?)');
    this.estimateCandlesByInterval = this.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(instrument_id AS BLOB)) + LENGTH(CAST(interval AS BLOB)) + LENGTH(CAST(source_provenance AS BLOB)) + COALESCE(LENGTH(CAST(quality AS BLOB)), 0) + LENGTH(CAST(origin AS BLOB))), 0) AS textUtf8Bytes, COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS payloadUtf8Bytes FROM (SELECT instrument_id, interval, source_provenance, quality, origin, payload_json FROM candle_samples WHERE interval = ? AND start_timestamp >= ? AND start_timestamp < ? ORDER BY start_timestamp ASC, instrument_id ASC LIMIT ?)');
    this.insertCandle = this.prepare('INSERT OR REPLACE INTO candle_samples (instrument_id, interval, start_timestamp, end_timestamp, open, high, low, close, volume, source_timestamp, source_provenance, received_at, closed, quality, origin, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.heatmap = new HeatmapRetentionBuffer({ intervalMs: heatmapIntervalMs, priceStep: heatmapPriceStep, maxGapMs: heatmapMaxGapMs, maxClosedRows: heatmapMaxClosedRows, maxCellsPerBucket: heatmapMaxCellsPerBucket, sourceResolution: 'native', sourceGrouping: heatmapPriceStep });
    this.pendingDepth = new Map();
    this.pendingDepthFailures = [];
    this.pendingDepthAdmissionRejectedRows = 0;
    this.retainedDiagnosticsCache = null;
    this.depthWriteCount = 0;
    this.heatmapWriteStats = { batches: 0, columns: 0, cells: 0, logicalBytes: 0, physicalBytesDelta: 0, storageGrowthRatio: 0, storageGrowthRatioMeasured: true, failedWrites: 0, lastError: null };
    this.sessionOnlyHeatmap = sessionOnlyHeatmap === true;
    this.storageWriteGuard = typeof storageWriteGuard === 'function' ? storageWriteGuard : null;
    this.maxSessionHeatmapRows = Math.max(1, Math.trunc(Number(maxSessionHeatmapRows) || 20_000));
    this.sessionHeatmapRows = [];
    this.sessionHeatmapRowBytes = new ImmutableSessionRowBytesCache();
    this.sessionHeatmapMembershipRevision = 0;
    this.heatmapConflictedRuns = new Map();
    this.sessionHeatmapDroppedRows = 0;
    this.sessionHeatmapDroppedColumns = 0;
    this.sessionHeatmapLosses = [];
    this.persistenceSuspended = false;
    this.storageStats = { ...this.storageUsage(), evictedRows: 0, checkpointed: false, checkpointBusy: false, compacted: false, overBudget: false, needsCompaction: false, impossibleBudget: false, lastEnforcedAt: null, suspensionReason: null };
  }
  #oiSampleFromRawRow(row: HistoryRecord) {
    const observationTimestamp = Number(row?.observationTimestamp);
    if (!(observationTimestamp > 0)) return null;
    const base = Number(row?.base);
    if (!Number.isFinite(base)) return null;
    const basis = String(row?.timeBasis ?? 'exchange');
    const storedSource = row?.sourceTimestamp == null ? null : Number(row.sourceTimestamp);
    const sourceTimestamp = storedSource != null && storedSource > 0 ? storedSource : (basis === 'exchange' ? observationTimestamp : null);
    const receivedAt = Number(row?.receivedAt);
    return {
      instrumentId: String(row.instrumentId),
      observationTimestamp,
      sourceTimestamp,
      receivedAt: Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : observationTimestamp,
      base,
      quote: row?.quote == null ? null : Number(row.quote),
      timeBasis: sourceTimestamp == null ? 'receipt' : basis,
      quality: String(row?.quality ?? (sourceTimestamp == null ? 'sampled' : 'native')),
    };
  }
  #mergeOiBar(sample: HistoryOiObservation) {
    const instrumentId = String(sample?.instrumentId ?? '');
    const observationTimestamp = Number(sample?.observationTimestamp);
    if (!instrumentId || !(observationTimestamp > 0)) return null;
    const bucketStart = Math.floor(observationTimestamp / this.oiBarIntervalMs) * this.oiBarIntervalMs;
    const key = oiBarKey(instrumentId, this.oiBarIntervalMs, bucketStart);
    const pending = this.pendingOiBars.get(key);
    const storedRow = pending ?? this.selectOiBarByKey.get(instrumentId, this.oiBarIntervalMs, bucketStart);
    const existing = pending ? pending : (storedRow ? oiBarFromRow(storedRow) : null);
    const merged = mergeOiBarValues(existing, sample, this.oiBarIntervalMs);
    if (!merged) return null;
    this.pendingOiBars.set(key, merged);
    this.#enforcePendingOiLimit();
    return merged;
  }
  #enforcePendingOiLimit() {
    if (this.pendingOiBars.size <= this.maxPendingOiBars) return;
    const overflow = [...this.pendingOiBars.entries()]
      .sort(([, left], [, right]) => Number(left.bucketStart) - Number(right.bucketStart) || String(left.instrumentId).localeCompare(String(right.instrumentId)))
      .slice(0, this.pendingOiBars.size - this.maxPendingOiBars);
    for (const [key] of overflow) {
      if (this.pendingOiBars.delete(key)) this.oiPendingDroppedBars += 1;
    }
  }
  #writeOiBar(bar: HistoryOiBar) {
    this.insertOiBar.run(
      bar.instrumentId, bar.intervalMs, bar.bucketStart, bar.bucketEnd,
      bar.openBase, bar.highBase, bar.lowBase, bar.closeBase,
      bar.openQuote, bar.highQuote, bar.lowQuote, bar.closeQuote,
      bar.sampleCount, bar.sourceTimeMin, bar.sourceTimeMax,
      Number.isFinite(Number(bar.firstObservationTimestamp)) ? Number(bar.firstObservationTimestamp) : bar.bucketStart,
      Number.isFinite(Number(bar.lastObservationTimestamp)) ? Number(bar.lastObservationTimestamp) : bar.bucketStart,
      bar.receivedAt, bar.timeBasis, bar.quality,
    );
  }
  #migrateOiSamplesToBars() {
    const state = (key: string) => this.prepare('SELECT value FROM migration_state WHERE key = ?').get(key)?.value;
    const setState = (key: string, value: unknown) => this.prepare('INSERT OR REPLACE INTO migration_state (key, value) VALUES (?, ?)').run(key, String(value));
    const priorCutoff = Number(state('oi-bar-cutoff-rowid'));
    const maxRowid = Number(this.prepare('SELECT MAX(rowid) AS maxRowid FROM oi_samples').get()?.maxRowid ?? 0);
    const cutoff = Number.isInteger(priorCutoff) && priorCutoff > 0 ? priorCutoff : maxRowid;
    if (cutoff > 0 && !(Number.isInteger(priorCutoff) && priorCutoff > 0)) setState('oi-bar-cutoff-rowid', cutoff);
    const rows = cutoff > 0
      ? this.prepare('SELECT rowid, instrument_id AS instrumentId, source_timestamp AS observationTimestamp, source_time AS sourceTimestamp, time_basis AS timeBasis, received_at AS receivedAt, base, quote, quality FROM oi_samples WHERE rowid <= ? ORDER BY rowid ASC LIMIT ?').all(cutoff, this.legacyOiMigrationMaxRows)
      : [];
    if (rows.length) {
      const deleteRaw = this.prepare('DELETE FROM oi_samples WHERE rowid = ?');
      this.db.exec('BEGIN');
      try {
        for (const row of rows) {
          const sample = this.#oiSampleFromRawRow(row);
          if (!sample) { deleteRaw.run(row.rowid); continue; }
          this.#mergeOiBar(sample);
          deleteRaw.run(row.rowid);
        }
        for (const bar of this.pendingOiBars.values()) this.#writeOiBar(bar);
        this.db.exec('COMMIT');
        this.pendingOiBars.clear();
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    }
    const remaining = cutoff > 0 && Boolean(this.prepare('SELECT 1 FROM oi_samples WHERE rowid <= ? LIMIT 1').get(cutoff));
    this.oiBarMigrationPending = remaining;
    setState('oi-bar-pending', remaining ? '1' : '0');
    if (this.legacyOiMigrationPending || remaining) setState('oi-legacy-pending', remaining ? '1' : '0');
  }
  flushOiBars({ force = false } = {}) {
    if (this.persistenceSuspended || !this.pendingOiBars.size) return 0;
    const pending = [...this.pendingOiBars.values()];
    const latestByInstrument = new Map();
    for (const bar of pending) latestByInstrument.set(bar.instrumentId, Math.max(Number(latestByInstrument.get(bar.instrumentId) ?? -Infinity), bar.bucketStart));
    const instruments = [...new Set(pending.map((bar) => bar.instrumentId))];
    for (const instrumentId of instruments) {
      const durable = this.prepare('SELECT MAX(bucket_start) AS bucketStart FROM oi_bars WHERE instrument_id = ? AND interval_ms = ?').get(instrumentId, this.oiBarIntervalMs);
      const durableStart = Number(durable?.bucketStart);
      if (Number.isFinite(durableStart)) latestByInstrument.set(instrumentId, Math.max(Number(latestByInstrument.get(instrumentId) ?? -Infinity), durableStart));
    }
    const toWrite = pending.filter((bar) => force || bar.bucketStart < Number(latestByInstrument.get(bar.instrumentId)));
    if (!toWrite.length) return 0;
    try {
      this.db.exec('BEGIN');
      for (const bar of toWrite) this.#writeOiBar(bar);
      this.db.exec('COMMIT');
      for (const bar of toWrite) this.pendingOiBars.delete(oiBarKey(bar.instrumentId, bar.intervalMs, bar.bucketStart));
      this.oiWriteStats.batches += 1;
      this.oiWriteStats.bars += toWrite.length;
      this.oiWriteStats.lastError = null;
      return toWrite.length;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.oiWriteStats.failedWrites += 1;
      this.oiWriteStats.lastError = String(historyError(error).message ?? error);
      return 0;
    }
  }
  /** Physical file usage. In-memory stores report zero and remain RAM-only. */
  storageUsage() {
    if (this.filePath === ':memory:') return { mainBytes: 0, walBytes: 0, shmBytes: 0, journalBytes: 0, totalBytes: 0, pageSize: 0, pageCount: 0, freelistCount: 0, liveBytesEstimate: 0, reclaimableBytes: 0 };
    const size = (suffix = '') => {
      try { return fs.statSync(this.filePath + suffix).size; } catch { return 0; }
    };
    const mainBytes = size(); const walBytes = size('-wal'); const shmBytes = size('-shm'); const journalBytes = size('-journal');
    let pageSize = 0; let pageCount = 0; let freelistCount = 0;
    try {
      pageSize = Number(this.prepare('PRAGMA page_size').get()?.page_size ?? 0);
      pageCount = Number(this.prepare('PRAGMA page_count').get()?.page_count ?? 0);
      freelistCount = Number(this.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0);
    } catch { /* file may be unavailable during shutdown */ }
    const liveBytesEstimate = Math.max(0, (pageCount - freelistCount) * pageSize);
    const reclaimableBytes = Math.max(0, freelistCount * pageSize);
    return { mainBytes, walBytes, shmBytes, journalBytes, totalBytes: mainBytes + walBytes + shmBytes + journalBytes, pageSize, pageCount, freelistCount, liveBytesEstimate, reclaimableBytes };
  }
  retentionBudget() { return this.#retentionSnapshot().retention; }
  // Share only this synchronous report's fresh session measurement. Pending
  // serialization completes first, so its effects cannot stale the measurement.
  #retentionSnapshot(combineSessionMeasurement = false) {
    const heatmap = this.heatmap.stats();
    const pendingRows = [...this.pendingDepthFailures, ...this.pendingDepth.values()];
    const pendingBytes = pendingRows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
    const pendingOiBars = [...this.pendingOiBars.values()];
    const pendingOiBytes = pendingOiBars.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
    const combinedSession = combineSessionMeasurement ? this.sessionHeatmapRowBytes.measureFresh(this.sessionHeatmapRows, { reconcile: true }) : null;
    const measuredSession = combinedSession?.serialized ?? this.sessionHeatmapRowBytes.sum(this.sessionHeatmapRows);
    // Optional immutable sizing must preserve exact legacy measurement on failure.
    const sessionBytes = measuredSession.complete && measuredSession.bytes != null ? measuredSession.bytes
      : this.sessionHeatmapRows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
    if (!measuredSession.complete) this.sessionHeatmapRowBytes.sync([]);
    const retention = {
      mode: 'bounded-ram-plus-durable-summary',
      rawBooksPersisted: false,
      sizeKind: 'serialized-utf8-estimate-plus-record-count-estimate',
      heapBytesMeasured: false,
      heatmap,
      pendingDepth: { rows: pendingRows.length, maxRows: this.#maxPendingDepthRows(), admissionRejectedRows: this.pendingDepthAdmissionRejectedRows, serializedBytesEstimate: pendingBytes },
      oiBars: { intervalMs: this.oiBarIntervalMs, pendingRows: pendingOiBars.length, maxPendingRows: this.maxPendingOiBars, pendingSerializedBytesEstimate: pendingOiBytes, droppedPendingRows: this.oiPendingDroppedBars, migrationPending: this.oiBarMigrationPending === true, writes: { ...this.oiWriteStats } },
      sessionHeatmap: { rows: this.sessionHeatmapRows.length, serializedBytesEstimate: sessionBytes, maxRows: this.maxSessionHeatmapRows, droppedRows: this.sessionHeatmapDroppedRows, droppedColumns: this.sessionHeatmapDroppedColumns },
      enforcedBounds: { maxSessionHeatmapRows: this.maxSessionHeatmapRows, maxPendingDepthRows: this.#maxPendingDepthRows(), maxSources: heatmap.limits?.maxSources ?? null, maxSourceTombstones: heatmap.limits?.maxSourceTombstones ?? null, maxSourceLevels: heatmap.limits?.maxSourceLevels ?? null, maxClosedRows: heatmap.limits?.maxClosedRows ?? null, maxCellsPerBucket: heatmap.limits?.maxCellsPerBucket ?? null },
    };
    // Legacy fallback serialization can change membership. After failure, clear
    // strong sizing owners above and let diagnostics obtain fresh ownership.
    return { retention, sessionMeasure: measuredSession, sessionOwnership: measuredSession.complete ? combinedSession?.ownership ?? null : null };
  }
  #maxPendingDepthRows() { return Math.max(1, Math.trunc(Number(this.heatmap.maxSources) || 64)); }
  #retainedDiagnosticsSignature() {
    const pending = [...this.pendingDepth.values()].map((row) => `${row.instrumentId}:${row.timestamp}:${row.receivedAt}:${row.bids?.length ?? 0}:${row.asks?.length ?? 0}`).sort().join('|');
    const failures = this.pendingDepthFailures.map((row) => `${row.instrumentId}:${row.timestamp}`).sort().join('|');
    const sources = [...this.heatmap.sources.values()].map((source) => `${source.instrumentId}:${source.accepted}:${source.lastTimestamp}:${source.lastReceivedAt}:${source.levels.length}:${source.buckets.size}:${source.bucketMeta.size}:${source.knownLevels.size}:${source.epochBarrier}`).sort().join('|');
    const tombstones = [...this.heatmap.sourceTombstones.values()].map((source) => `${source.instrumentId}:${source.lastTimestamp}:${source.integratedUntil}:${source.epochBarrier}:${source.accepted}`).sort().join('|');
    return `${pending}||${failures}||${sources}||${tombstones}||${this.heatmap.closedRows.length}:${this.heatmap.sourceCapacityRejects}:${this.pendingDepthAdmissionRejectedRows}:${this.sessionHeatmapRows.length}:${this.sessionHeatmapMembershipRevision}:${this.sessionHeatmapRowBytes.membershipRevision}:${this.sessionHeatmapLosses.length}:${this.pendingOiBars.size}`;
  }
  retainedDiagnostics({ cached = false, allowStale = false, reportFreshness = false } = {}): HistoryDiagnostics {
    const report = (snapshot: HistoryDiagnostics, fresh: boolean): HistoryDiagnostics => {
      if (!reportFreshness) return snapshot;
      const snapshotAt = Number.isFinite(Number(snapshot?.snapshotAt)) ? Number(snapshot.snapshotAt) : null;
      const snapshotAgeMs = snapshotAt === null ? null : Math.max(0, Date.now() - snapshotAt);
      if (fresh) return { ...snapshot, measurementFresh: true, measurementSnapshotAt: snapshotAt, snapshotAgeMs };
      return {
        measurementFresh: false,
        measurementSnapshotAt: snapshotAt,
        snapshotAgeMs,
        lastMeasured: {
          retention: snapshot.retention,
          sessionHistory: snapshot.sessionHistory,
          heatmap: snapshot.heatmap,
          pendingDepth: snapshot.pendingDepth,
          sessionRows: snapshot.sessionRows,
          sessionHeatmapLosses: snapshot.sessionHeatmapLosses,
          logicalComponents: snapshot.logicalComponents,
          logicalBytes: snapshot.logicalBytes,
        },
        retention: null,
        sessionHistory: null,
        heatmap: null,
        pendingDepth: null,
        sessionRows: null,
        sessionHeatmapLosses: null,
        logicalComponents: null,
        logicalBytes: null,
      };
    };
    if (cached && allowStale && this.retainedDiagnosticsCache?.value) return report(this.retainedDiagnosticsCache.value, false);
    // Reconcile exact membership before considering cached diagnostics. Mutable
    // caller-owned rows always require the existing fresh whole-graph visitor.
    const { retention, sessionMeasure, sessionOwnership } = this.#retentionSnapshot(!cached);
    const signature = `${this.#retainedDiagnosticsSignature()}||${sessionMeasure.complete ? sessionMeasure.bytes : 'unproved'}`;
    if (cached && sessionMeasure.complete && sessionMeasure.freshRows === 0 && this.retainedDiagnosticsCache?.signature === signature) return report(this.retainedDiagnosticsCache.value, true);
    const immutable = sessionOwnership ?? this.sessionHeatmapRowBytes.logicalOwnership(this.sessionHeatmapRows);
    const logicalComponents = logicalRetainedComponents({
      heatmapSources: { sources: this.heatmap.sources, tombstones: this.heatmap.sourceTombstones },
      heatmapClosedRows: this.heatmap.closedRows,
      pendingDepthFailures: this.pendingDepthFailures,
      pendingDepth: this.pendingDepth,
      pendingOiBars: this.pendingOiBars,
      sessionHeatmapRows: immutable.complete ? immutable.mutableRows : this.sessionHeatmapRows,
      sessionHeatmapRowBytes: immutable.complete ? immutable.mutableCacheOwners : this.sessionHeatmapRowBytes.retainedRoot(),
      heatmapConflictedRuns: this.heatmapConflictedRuns,
      sessionHeatmapLosses: this.sessionHeatmapLosses,
    });
    if (immutable.complete) {
      logicalComponents.sessionHeatmapRows += immutable.sessionLogicalBytesUpper;
      logicalComponents.sessionHeatmapRowBytes += immutable.cacheLogicalBytesUpper;
    }
    logicalComponents.diagnosticsCache = 0;
    const value = { snapshotAt: Date.now(), retention, sessionHistory: this.sessionHistoryConfig(), heatmap: this.heatmap.stats(), pendingDepth: this.pendingDepth.size, sessionRows: this.sessionHeatmapRows.length, sessionHeatmapLosses: this.sessionHeatmapLosses.slice(-100), logicalComponents, logicalBytes: Object.values(logicalComponents).reduce((sum, value) => sum + value, 0) };
    const retainedCache = { signature, value };
    logicalComponents.diagnosticsCache = logicalRetainedBytes(retainedCache);
    value.logicalBytes += logicalComponents.diagnosticsCache;
    this.retainedDiagnosticsCache = retainedCache;
    return report(value, true);
  }
  retainedRamBudget({ cached = false, allowStale = false } = {}) {
    const d = this.retainedDiagnostics({ cached, allowStale });
    return { logicalBytes: Number(d.logicalBytes) || 0, sessionOnlyEvictableBytes: this.sessionOnlyHeatmap === true ? Number(d.logicalComponents?.sessionHeatmapRows ?? 0) : 0, protectedSuspendedBacklogBytes: this.sessionOnlyHeatmap === true ? 0 : Number(d.logicalComponents?.sessionHeatmapRows ?? 0), protectedPendingDepthBytes: Number(d.logicalComponents?.pendingDepth ?? 0), protectedFailureRows: this.pendingDepthFailures.length, activeSequenced: false };
  }
  reclaimRetainedRam({ targetBytes = 0, protectedInstrumentIds = null, maxSourcesToReclaim = null }: { targetBytes?: number; protectedInstrumentIds?: Set<string> | string[] | null; maxSourcesToReclaim?: number | null } = {}) {
    const beforeLogical = Number(this.retainedDiagnostics().logicalBytes) || 0;
    const target = Math.max(0, Number(targetBytes) || 0);
    if (!(target > 0)) return 0;
    const sourceCapacityPass = maxSourcesToReclaim != null;
    const sourceLimit = sourceCapacityPass ? Math.max(0, Math.trunc(Number(maxSourcesToReclaim) || 0)) : Number.POSITIVE_INFINITY;
    if (sourceCapacityPass && (!(protectedInstrumentIds instanceof Set || Array.isArray(protectedInstrumentIds)) || sourceLimit === 0)) return 0;

    if (this.sessionOnlyHeatmap !== true) {
      // Suspended and pending rows remain owned by RAM until a successful
      // durable write. Reclaim only when the persistence path is healthy.
      if (this.persistenceSuspended) return 0;
      if (!(protectedInstrumentIds instanceof Set || Array.isArray(protectedInstrumentIds))) return 0;
      const protectedIds = new Set([...(protectedInstrumentIds ?? [])].map(String));
      const persistClosedRows = (rows: RetainedHeatmapRow[]) => {
        if (!rows.length) return true;
        let written = 0;
        try { written = this.persistHeatmapRows(rows, { alreadyRetained: true }); }
        catch (error) { this.#recordWriteFailure(error, 'reclaim'); return false; }
        if (written !== rows.length) return false;
        this.heatmap.drainClosedRows(rows);
        return true;
      };

      // Drain earlier closed work first so a failed write cannot be confused
      // with the source currently being reclaimed.
      if (!persistClosedRows(this.heatmap.peekClosed().slice())) return 0;
      let currentLogical = Number(this.retainedDiagnostics().logicalBytes) || 0;
      let reclaimedSources = 0;
      const candidates = [...this.heatmap.sources.values()]
        .filter((source) => !protectedIds.has(String(source.instrumentId)))
        .filter((source) => source.lastTimestamp != null && (source.levels.length || source.knownLevels.size || source.buckets.size || source.bucketMeta.size))
        .sort((a, b) => (Number(a.lastReceivedAt ?? a.lastTimestamp) || 0) - (Number(b.lastReceivedAt ?? b.lastTimestamp) || 0) || String(a.instrumentId).localeCompare(String(b.instrumentId)));
      for (const source of candidates) {
        if (beforeLogical - currentLogical >= target || this.persistenceSuspended || reclaimedSources >= sourceLimit) break;
        const reclaimedSource = this.heatmap.reclaimSourceForBudget(source.instrumentId);
        if (!reclaimedSource) continue;
        const rows = this.heatmap.peekClosed().slice();
        if (rows.length !== reclaimedSource.rows || !persistClosedRows(rows)) break;
        reclaimedSources += 1;
        currentLogical = Number(this.retainedDiagnostics().logicalBytes) || 0;
      }
      return Math.max(0, beforeLogical - currentLogical);
    }

    if (sourceCapacityPass) {
      const protectedIds = new Set([...(protectedInstrumentIds ?? [])].map(String));
      const retainClosedRows = (rows: RetainedHeatmapRow[]) => {
        if (!rows.length) return true;
        this.#retainSessionHeatmapRows(rows);
        this.heatmap.drainClosedRows(rows);
        return true;
      };
      if (!retainClosedRows(this.heatmap.peekClosed().slice())) return 0;
      let currentLogical = Number(this.retainedDiagnostics().logicalBytes) || 0;
      let reclaimedSources = 0;
      const candidates = [...this.heatmap.sources.values()]
        .filter((source) => !protectedIds.has(String(source.instrumentId)))
        .filter((source) => source.lastTimestamp != null && (source.levels.length || source.knownLevels.size || source.buckets.size || source.bucketMeta.size))
        .sort((a, b) => (Number(a.lastReceivedAt ?? a.lastTimestamp) || 0) - (Number(b.lastReceivedAt ?? b.lastTimestamp) || 0) || String(a.instrumentId).localeCompare(String(b.instrumentId)));
      for (const source of candidates) {
        if (beforeLogical - currentLogical >= target || reclaimedSources >= sourceLimit) break;
        const reclaimedSource = this.heatmap.reclaimSourceForBudget(source.instrumentId);
        if (!reclaimedSource) continue;
        const rows = this.heatmap.peekClosed().slice();
        if (rows.length !== reclaimedSource.rows || !retainClosedRows(rows)) break;
        reclaimedSources += 1;
        currentLogical = Number(this.retainedDiagnostics().logicalBytes) || 0;
      }
      return Math.max(0, beforeLogical - currentLogical);
    }

    let currentLogical = beforeLogical;
    while (Math.max(0, beforeLogical - currentLogical) < target && this.sessionHeatmapRows.length) {
      const key = this.#sessionHeatmapColumnKey(this.sessionHeatmapRows[0]);
      const column = this.sessionHeatmapRows.filter((row) => this.#sessionHeatmapColumnKey(row) === key);
      this.sessionHeatmapRows = this.sessionHeatmapRows.filter((row) => this.#sessionHeatmapColumnKey(row) !== key);
      this.#reconcileHeatmapConflictOwners();
      this.sessionHeatmapDroppedRows += column.length; this.sessionHeatmapDroppedColumns += 1;
      this.sessionHeatmapLosses.push({ key, rows: column.length, reason: 'retained-budget', gap: true });
      if (this.sessionHeatmapLosses.length > 1000) this.sessionHeatmapLosses.shift();
      currentLogical = Number(this.retainedDiagnostics().logicalBytes) || 0;
    }
    return Math.max(0, beforeLogical - currentLogical);
  }
  sessionHistoryConfig() {
    return { mode: this.sessionOnlyHeatmap ? 'session-only' : 'durable-with-session-fallback', sessionOnly: this.sessionOnlyHeatmap, durableHeatmap: !this.sessionOnlyHeatmap, durableDepth: true, survivesRestart: false, maxRows: this.maxSessionHeatmapRows, restartGap: this.sessionOnlyHeatmap ? 'All heatmap rows are session-only and are discarded on process restart.' : 'Only suspended/failed-write RAM heatmap rows are discarded on process restart; durable closed columns remain available.' };
  }
  storageBudget({ retention = undefined }: { retention?: ReturnType<HistoryStore['retentionBudget']> | null } = {}) {
    const usage = this.storageUsage();
    return { ...usage, limits: { ...this.storageLimits }, overMain: usage.mainBytes > this.storageLimits.maxMainBytes, overWal: usage.walBytes > this.storageLimits.maxWalBytes, overTotal: usage.totalBytes > this.storageLimits.maxCacheBytes, overBudget: this.storageStats.overBudget, needsCompaction: this.storageStats.needsCompaction, impossibleBudget: this.storageStats.impossibleBudget, persistenceSuspended: this.persistenceSuspended, suspensionReason: this.storageStats.suspensionReason, sessionHeatmapRows: this.sessionHeatmapRows.length, sessionHeatmapDroppedRows: this.sessionHeatmapDroppedRows, sessionHeatmapDroppedColumns: this.sessionHeatmapDroppedColumns, maxSessionHeatmapRows: this.maxSessionHeatmapRows, evictedRows: this.storageStats.evictedRows, checkpointed: this.storageStats.checkpointed, checkpointBusy: this.storageStats.checkpointBusy, compacted: this.storageStats.compacted, lastEnforcedAt: this.storageStats.lastEnforcedAt, heatmapWrites: { ...this.heatmapWriteStats }, retention: retention === undefined ? this.retentionBudget() : retention, sessionHistory: this.sessionHistoryConfig() };
  }
  #checkpoint(mode = 'PASSIVE') {
    if (this.filePath === ':memory:') return { ok: false, busy: false };
    try {
      const row = this.prepare('PRAGMA wal_checkpoint(' + mode + ')').get() ?? {};
      return { ok: true, busy: Number(row.busy ?? 0) > 0, logPages: Number(row.log ?? 0), checkpointedPages: Number(row.checkpointed ?? 0) };
    } catch { return { ok: false, busy: true }; }
  }
  #oldestHeatmapBucket() {
    const row = this.prepare('SELECT bucket_start AS bucketStart FROM heatmap_columns ORDER BY bucket_start ASC LIMIT 1').get();
    const cell = this.prepare('SELECT bucket_start AS bucketStart FROM heatmap_cells ORDER BY bucket_start ASC LIMIT 1').get();
    const values = [row?.bucketStart, cell?.bucketStart].map(Number).filter(Number.isFinite);
    return values.length ? Math.min(...values) : null;
  }
  #evictOneOldestBucket() {
    const bucket = this.#oldestHeatmapBucket();
    if (bucket == null) return 0;
    return this.#deleteHeatmapBuckets('=',bucket);
  }
  #deleteHeatmapBuckets(operator:'='|'<',bucket:number):number {
    let removed=0;this.db.exec('BEGIN');try{for(const table of (this.heatmapRunTablesReady ? ['heatmap_cells','heatmap_observation_cells','heatmap_columns','heatmap_observation_columns','heatmap_observation_keys'] : ['heatmap_cells','heatmap_columns']))removed+=Number(this.db.prepare('DELETE FROM '+table+' WHERE bucket_start '+operator+' ?').run(bucket).changes??0);this.db.exec('COMMIT');return removed;}catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }
  #oldestCandidate() {
    const candidates: { table: string; column?: string; timestamp: number }[] = [];
    const heatmap = this.#oldestHeatmapBucket();
    if (heatmap != null) candidates.push({ table: 'heatmap', timestamp: heatmap });
    for (const [table, column] of [['depth_samples', 'source_timestamp'], ['oi_bars', 'bucket_start'], ['candle_samples', 'start_timestamp'], ['layer_snapshots', 'source_timestamp'], ['crossing_events', 'observed_at']]) {
      const row = this.prepare('SELECT ' + column + ' AS timestamp FROM ' + table + ' ORDER BY ' + column + ' ASC LIMIT 1').get();
      const timestamp = Number(row?.timestamp);
      if (Number.isFinite(timestamp)) candidates.push({ table, column, timestamp });
    }
    return candidates.sort((a, b) => a.timestamp - b.timestamp || a.table.localeCompare(b.table))[0] ?? null;
  }
  #evictOldestRows() {
    const candidate = this.#oldestCandidate();
    if (!candidate) return 0;
    if (candidate.table === 'heatmap') return this.#evictOneOldestBucket();
    const sql = 'DELETE FROM ' + candidate.table + ' WHERE rowid IN (SELECT rowid FROM ' + candidate.table + ' WHERE ' + candidate.column + ' <= ? ORDER BY ' + candidate.column + ' ASC LIMIT 256)';
    const result = this.prepare(sql).run(candidate.timestamp);
    return Number(result?.changes ?? 0);
  }
  /**
   * Enforce the bounded local cache policy. Eviction is oldest-first and never
   * touches the singleton configuration snapshot or OI quarantine. VACUUM is
   * optional because it is intentionally off the ingestion path.
   */
  enforceStorageBudget({ compact = false, maxPasses = 64 } = {}) {
    if (this.filePath === ':memory:') return this.storageBudget();
    let usage = this.storageUsage();
    let evicted = 0; let checkpointed = false; let checkpointBusy = false; let compacted = false;
    let checkpoint = this.#checkpoint('PASSIVE');
    checkpointed ||= checkpoint.ok; checkpointBusy ||= checkpoint.busy;
    usage = this.storageUsage();
    if (usage.walBytes > this.storageLimits.maxWalBytes) {
      checkpoint = this.#checkpoint('TRUNCATE');
      checkpointed ||= checkpoint.ok; checkpointBusy ||= checkpoint.busy;
      usage = this.storageUsage();
    }
    const impossibleBudget = this.storageLimits.maxMainBytes < 64 * 1024;
    if (compact && !checkpointBusy && (usage.mainBytes > this.storageLimits.maxMainBytes || usage.totalBytes > this.storageLimits.maxCacheBytes)) {
      try {
        checkpoint = this.#checkpoint('TRUNCATE');
        checkpointed ||= checkpoint.ok; checkpointBusy ||= checkpoint.busy;
        if (!checkpointBusy) { this.db.exec('VACUUM'); compacted = true; }
      } catch { checkpointBusy = true; }
      usage = this.storageUsage();
    }
    const residentOver = () => usage.liveBytesEstimate > this.storageLimits.maxMainBytes || usage.liveBytesEstimate + usage.walBytes + usage.shmBytes + usage.journalBytes > this.storageLimits.maxCacheBytes;
    if (!impossibleBudget && !checkpointBusy && residentOver()) {
      for (let pass = 0; pass < Math.max(1, Math.trunc(maxPasses)); pass += 1) {
        const before = usage.liveBytesEstimate;
        const changes = this.#evictOldestRows();
        if (!(changes > 0)) break;
        evicted += changes;
        checkpoint = this.#checkpoint('PASSIVE');
        checkpointed ||= checkpoint.ok; checkpointBusy ||= checkpoint.busy;
        usage = this.storageUsage();
        if (usage.liveBytesEstimate >= before && checkpointBusy) break;
        if (!residentOver()) break;
      }
    }
    const physicalOverBeforeCompaction = usage.mainBytes > this.storageLimits.maxMainBytes || usage.walBytes > this.storageLimits.maxWalBytes || usage.totalBytes > this.storageLimits.maxCacheBytes;
    if (compact && !checkpointBusy && physicalOverBeforeCompaction && (evicted > 0 || usage.reclaimableBytes > 0)) {
      try {
        checkpoint = this.#checkpoint('TRUNCATE');
        checkpointed ||= checkpoint.ok; checkpointBusy ||= checkpoint.busy;
        if (!checkpointBusy) { this.db.exec('VACUUM'); compacted = true; }
      } catch { checkpointBusy = true; }
      usage = this.storageUsage();
    }
    const overMain = usage.mainBytes > this.storageLimits.maxMainBytes;
    const overWal = usage.walBytes > this.storageLimits.maxWalBytes;
    const overTotal = usage.totalBytes > this.storageLimits.maxCacheBytes;
    const physicalOver = overMain || overWal || overTotal;
    const reclaimableCoversMain = usage.mainBytes - usage.reclaimableBytes <= this.storageLimits.maxMainBytes;
    const needsCompaction = overMain && reclaimableCoversMain;
    // Physical violations remain violations until a checkpoint/compaction has
    // actually brought the file under its limit. Reclaimable pages are useful
    // diagnostics, never permission to keep writing past the hard cap.
    const overBudget = physicalOver;
    const wasSuspended = this.persistenceSuspended;
    this.persistenceSuspended = impossibleBudget || checkpointBusy || overBudget;
    this.storageStats = { ...usage, evictedRows: this.storageStats.evictedRows + evicted, checkpointed, checkpointBusy, compacted, overBudget, needsCompaction, impossibleBudget, suspensionReason: impossibleBudget ? 'config-budget' : checkpointBusy ? 'long-reader-or-checkpoint-busy' : overBudget ? 'storage-budget-exceeded' : null, lastEnforcedAt: Date.now() };
    if (!this.persistenceSuspended && this.sessionHeatmapRows.length) {
      this.#flushSessionHeatmapRows({ maxColumns: 16 });
    }
    return this.storageBudget();
  }
  compactStorage() { return this.enforceStorageBudget({ compact: true, maxPasses: 128 }); }
  writeDepthRow(row: HistoryDepthRow, { retainFailure = true } = {}) {
    if (this.persistenceSuspended) return false;
    try {
      const units = row.units ?? row.representation?.units ?? null;
      const metadata = {
        ...(row.resolutionKey && row.resolutionKey !== 'native' ? { resolution: row.resolution, resolutionKey: row.resolutionKey, bookKey: row.bookKey } : { resolution: row.resolution ?? 'native', resolutionKey: row.resolutionKey ?? 'native', bookKey: row.bookKey ?? `${row.instrumentId}|native` }),
        units,
        ...depthValuationMetadata(row),
        representation: row.representation ?? representationMetadata({ stage: 'depth-history', limitPerSide: HISTORY_DEPTH_LEVELS_PER_SIDE, inputLevelCount: row.inputLevelCount, retainedLevelCount: { bids: row.bids?.length ?? 0, asks: row.asks?.length ?? 0 }, retentionTruncated: Number(row.inputLevelCount?.bids) > (row.bids?.length ?? 0) || Number(row.inputLevelCount?.asks) > (row.asks?.length ?? 0), resolutionKey: row.resolutionKey ?? 'native', resolution: row.resolution ?? 'native', units, coverage: row.coverage ?? 'unknown', coverageBounds: row.coverageBounds ?? null, observedBounds: { bids: priceBounds(row.bids), asks: priceBounds(row.asks) }, sourceTimestamp: row.timestamp }),
      };
      this.insertDepth.run(row.instrumentId, row.timestamp, row.receivedAt, row.bestBid, row.bestAsk, row.bidNotional, row.askNotional, row.levelCount, 1, JSON.stringify({ bids: row.bids, asks: row.asks, ...metadata }));
      this.depthWriteCount += 1;
      return true;
    } catch (error) {
      this.#recordWriteFailure(error, 'depth');
      if (retainFailure) {
        if (!this.pendingDepthFailures.some((item) => item.instrumentId === row.instrumentId && item.timestamp === row.timestamp)) this.pendingDepthFailures.push(row);
        while (this.pendingDepthFailures.length > this.maxSessionHeatmapRows) this.pendingDepthFailures.shift();
      }
      return false;
    }
  }
  flushPendingDepth() {
    const rows = [...this.pendingDepthFailures, ...this.pendingDepth.values()].sort((a, b) => a.timestamp - b.timestamp || a.instrumentId.localeCompare(b.instrumentId));
    if (this.persistenceSuspended) return 0;
    this.pendingDepth.clear();
    this.pendingDepthFailures = [];
    for (const row of rows) this.writeDepthRow(row);
    return rows.length;
  }
  #sessionHeatmapColumnKey(row: RetainedHeatmapRow) {
    return heatmapRunId(row);
  }
  #retainSessionHeatmapRows(rows: RetainedHeatmapRow[], { detachedInternal = false } = {}) {
    if (!rows?.length) return 0;
    this.sessionHeatmapRows.push(...rows);
    this.sessionHeatmapMembershipRevision++;
    while (this.sessionHeatmapRows.length > this.maxSessionHeatmapRows) {
      const oldest = this.sessionHeatmapRows[0];
      const key = this.#sessionHeatmapColumnKey(oldest);
      const before = this.sessionHeatmapRows.length;
      this.sessionHeatmapRows = this.sessionHeatmapRows.filter((row) => this.#sessionHeatmapColumnKey(row) !== key);
      this.#reconcileHeatmapConflictOwners();
      const droppedRows = before - this.sessionHeatmapRows.length;
      if (!(droppedRows > 0)) break;
      this.sessionHeatmapDroppedRows += droppedRows;
      this.sessionHeatmapDroppedColumns += 1;
    }
    this.#reconcileHeatmapConflictOwners();
    if (detachedInternal) {
      // Only closed internal rows are detached from the active integrator.
      // Trim first, so rejected rows never acquire strong cache ownership.
      const retained = new Set(this.sessionHeatmapRows);
      this.sessionHeatmapRowBytes.sealDetachedRows(rows.filter(row => retained.has(row)));
      this.sessionHeatmapRowBytes.sync(this.sessionHeatmapRows);
    }
    return rows.length;
  }
  #reconcileHeatmapConflictOwners(): void {
    this.sessionHeatmapMembershipRevision++;
    if (!this.sessionHeatmapRowBytes.sync(this.sessionHeatmapRows).complete) this.sessionHeatmapRowBytes.sync([]);
    const retained=new Set(this.sessionHeatmapRows.map(heatmapRunId));
    for(const key of this.heatmapConflictedRuns.keys())if(!retained.has(key))this.heatmapConflictedRuns.delete(key);
  }
  #flushSessionHeatmapRows({ maxColumns = 16 } = {}) {
    // Session-only history has no durable destination. Maintenance must leave
    // its bounded RAM rows in place rather than feeding them back through the
    // persistence path and duplicating them.
    if (this.sessionOnlyHeatmap || this.persistenceSuspended || !this.sessionHeatmapRows.length) return 0;
    const columns = new Map();
    for (const row of this.sessionHeatmapRows) {
      const key = this.#sessionHeatmapColumnKey(row);
      const group = columns.get(key);
      if (group) group.push(row);
      else columns.set(key, [row]);
    }
    let flushed = 0;
    let batches = 0;
    for (const [key, rows] of columns) {
      const before = this.storageUsage();
      if (before.mainBytes > this.storageLimits.maxMainBytes || before.walBytes > this.storageLimits.maxWalBytes || before.totalBytes > this.storageLimits.maxCacheBytes) {
        this.persistenceSuspended = true;
        this.storageStats = { ...this.storageStats, ...before, overBudget: true, suspensionReason: 'storage-budget-exceeded', lastEnforcedAt: Date.now() };
        break;
      }
      try {
        // These rows already belong to the bounded session backlog.  A failed
        // retry must leave that ownership unchanged; persistHeatmapRows only
        // captures new rows when its caller has not retained them yet.
        const written = this.persistHeatmapRows(rows, { alreadyRetained: true });
        if (written !== rows.length) {
          if (!this.persistenceSuspended && this.heatmapConflictedRuns.has(key)) { batches += 1;if (batches >= Math.max(1, Math.trunc(maxColumns))) break;continue; }
          this.persistenceSuspended = true;
          if (!this.storageStats.suspensionReason) this.storageStats = { ...this.storageStats, suspensionReason: 'write-error', lastEnforcedAt: Date.now() };
          break;
        }
      } catch {
        this.persistenceSuspended = true;
        this.storageStats = { ...this.storageStats, suspensionReason: 'write-error', lastEnforcedAt: Date.now() };
        break;
      }
      this.sessionHeatmapRows = this.sessionHeatmapRows.filter((row) => this.#sessionHeatmapColumnKey(row) !== key);
      this.#reconcileHeatmapConflictOwners();
      flushed += rows.length;
      batches += 1;
      const after = this.storageUsage();
      if (after.mainBytes > this.storageLimits.maxMainBytes || after.walBytes > this.storageLimits.maxWalBytes || after.totalBytes > this.storageLimits.maxCacheBytes) {
        this.persistenceSuspended = true;
        this.storageStats = { ...this.storageStats, ...after, overBudget: true, suspensionReason: 'storage-budget-exceeded', needsCompaction: after.mainBytes - after.reclaimableBytes <= this.storageLimits.maxMainBytes, lastEnforcedAt: Date.now() };
        break;
      }
      if (batches >= Math.max(1, Math.trunc(maxColumns))) break;
    }
    return flushed;
  }
  #recordWriteFailure(error: unknown, phase = 'transaction') {
    this.persistenceSuspended = true;
    this.heatmapWriteStats.failedWrites += 1;
    this.heatmapWriteStats.lastError = { phase, name: historyError(error).name ?? 'Error', code: historyError(error).code ?? null, message: historyError(error).message ?? String(error) };
    this.storageStats = { ...this.storageStats, suspensionReason: 'write-error' };
  }
  #retainHeatmapWriteFailure(error: unknown, pending: RetainedHeatmapRow[], implicit: boolean, phase = 'transaction', alreadyRetained = false) {
    this.#recordWriteFailure(error, phase);
    if (!alreadyRetained) this.#retainSessionHeatmapRows(pending, { detachedInternal: implicit });
    if (implicit) this.heatmap.drainClosed();
    return 0;
  }
  #ensureHeatmapRunTables(): void {
    if (this.heatmapRunTablesReady) return;
    // Forward-only siblings own only NEW conflicting-key runs; no legacy payload is migrated or copied.
    for (const [legacy,target,primary] of [['heatmap_columns','heatmap_observation_columns','PRIMARY KEY (instrument_id, bucket_start)'],['heatmap_cells','heatmap_observation_cells','PRIMARY KEY (instrument_id, bucket_start, side, price_low)']]) {
      const schema:unknown=this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(legacy);
      const sql=historyRecord(schema).sql;
      if(typeof sql!=='string'||!sql.includes(primary))throw new Error('native heatmap schema is unavailable');
      this.db.exec(sql.replace('CREATE TABLE '+legacy,'CREATE TABLE IF NOT EXISTS '+target).replace(primary,legacy==='heatmap_columns'?'run_id TEXT NOT NULL PRIMARY KEY':'run_id TEXT NOT NULL, PRIMARY KEY (run_id, side, price_low, price_high)'));
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS heatmap_observation_keys (run_id TEXT PRIMARY KEY, instrument_id TEXT NOT NULL, bucket_start INTEGER NOT NULL, content_hash TEXT NOT NULL, legacy_origin INTEGER NOT NULL, book_mask TEXT);'
      +'CREATE INDEX IF NOT EXISTS heatmap_observation_keys_source ON heatmap_observation_keys(instrument_id,bucket_start);'
      +'CREATE INDEX IF NOT EXISTS heatmap_observation_columns_source_order ON heatmap_observation_columns(instrument_id,bucket_start,run_id);'
      +'CREATE INDEX IF NOT EXISTS heatmap_observation_columns_global_order ON heatmap_observation_columns(bucket_start,instrument_id,run_id);'
      +'CREATE INDEX IF NOT EXISTS heatmap_observation_cells_source_order ON heatmap_observation_cells(instrument_id,bucket_start,price_low,side,run_id);'
      +'CREATE INDEX IF NOT EXISTS heatmap_observation_cells_global_order ON heatmap_observation_cells(bucket_start,price_low,instrument_id,side,run_id);');

    this.db.exec('DROP VIEW IF EXISTS heatmap_read_columns; DROP VIEW IF EXISTS heatmap_read_cells; DROP VIEW IF EXISTS heatmap_read_keys;');
    this.db.exec(heatmapReadViewSql());
    this.heatmapRunTablesReady = true;
  }
  persistHeatmapRows(rows: RetainedHeatmapRow[] | null = null, { alreadyRetained = false } = {}) {
    const implicit = rows == null;
    const pending = (rows ?? this.heatmap.peekClosed()).slice();
    if (this.persistenceSuspended || this.sessionOnlyHeatmap) { if (!alreadyRetained) this.#retainSessionHeatmapRows(pending, { detachedInternal: implicit }); if (implicit) this.heatmap.drainClosed(); return 0; }
    if (!pending.length) return 0;
    const logicalBytes = Buffer.byteLength(JSON.stringify(pending)) + pending.length * HEATMAP_HISTORY_PENDING_ROW_TEMPORARY_BYTES;
    const beforeUsage = this.storageUsage();
    let cellCount = 0;
    try { this.storageWriteGuard?.({ kind: 'heatmap', rows: pending, logicalBytes }); } catch (error) {
      this.persistenceSuspended = true;
      this.heatmapWriteStats.failedWrites += 1;
      this.heatmapWriteStats.lastError = { name: historyError(error).name ?? 'Error', code: historyError(error).code ?? null, message: historyError(error).message ?? String(error) };
      this.storageStats = { ...this.storageStats, suspensionReason: 'write-error' };
      if (!alreadyRetained) this.#retainSessionHeatmapRows(pending, { detachedInternal: implicit });
      if (implicit) this.heatmap.drainClosed();
      return 0;
    }
    try { this.#ensureHeatmapRunTables(); } catch (error) { return this.#retainHeatmapWriteFailure(error, pending, implicit, 'schema', alreadyRetained); }
    const runs = new Map<string,{ column:RetainedHeatmapRow; rows:RetainedHeatmapRow[] }>();
    for (const row of pending) { const runId=heatmapRunId(row);const run=runs.get(runId);if(run)run.rows.push(row);else runs.set(runId,{column:row,rows:[row]}); }
    let acceptedRows=0;let writtenColumns=0;const conflicts:RetainedHeatmapRow[]=[];
    const acceptedRunIds:string[]=[];const conflictReasons=new Map<string,string>();let conflictError:HistoryWriteError|null=null;
    try {
      let proofScratch=0;
      const proofSize=this.prepare("SELECT COUNT(*) AS count,COALESCE(MAX(LENGTH(CAST(COALESCE(observed_intervals,'') AS BLOB))+LENGTH(CAST(COALESCE(gap_intervals,'') AS BLOB))),0) AS payloadBytes,COALESCE(MAX(LENGTH(CAST(instrument_id AS BLOB))+LENGTH(CAST(COALESCE(source_resolution,'') AS BLOB))+LENGTH(CAST(COALESCE(grid_epoch,'') AS BLOB))+LENGTH(CAST(COALESCE(observation_run,'') AS BLOB))),0) AS textBytes FROM heatmap_columns WHERE instrument_id=? AND bucket_start < ? AND bucket_end > ?");
      for(const {column} of runs.values()){
        const size=proofSize.get(column.instrumentId,column.bucketEnd,column.bucketStart);
        const count=Number(size?.count);const payload=Number(size?.payloadBytes);const text=Number(size?.textBytes);
        if(![count,payload,text].every(value=>Number.isSafeInteger(value)&&value>=0)||count>HISTORY_SAMPLE_LIMIT)throw new Error('native observation overlap proof exceeds bounded work');
        // Two indexed UNION row heads, one parsed BOOK proof, no retained old-row list.
        proofScratch=Math.max(proofScratch,2*HEATMAP_HISTORY_CELL_TEMPORARY_BYTES+payload*(2*4+HEATMAP_HISTORY_JSON_PARSE_MULTIPLIER)+text*2*4);
      }
      this.storageWriteGuard?.({kind:'heatmap',rows:pending,logicalBytes:addHistoryResponseBytes(logicalBytes,proofScratch)});
    } catch(error){return this.#retainHeatmapWriteFailure(error,pending,implicit,'overlap-proof',alreadyRetained);}
    try { this.db.exec('BEGIN'); } catch (error) {
      return this.#retainHeatmapWriteFailure(error, pending, implicit, 'begin', alreadyRetained);
    }
    try {
      const fingerprint=this.db.prepare('SELECT content_hash AS contentHash FROM heatmap_observation_keys WHERE run_id=?');
      const legacyColumn=this.db.prepare('SELECT '+HEATMAP_DISPLAY_COLUMN_FIELDS.replace(/hc\./g,'').replace(', observation_run AS observationRun','')+' FROM heatmap_columns WHERE instrument_id=? AND bucket_start=?');
      const insertKey=this.db.prepare('INSERT INTO heatmap_observation_keys(run_id,instrument_id,bucket_start,content_hash,legacy_origin,book_mask) VALUES(?,?,?,?,?,?)');
      const insertRunColumn=this.db.prepare('INSERT INTO heatmap_observation_columns('+HEATMAP_COLUMN_NAMES+',run_id) VALUES('+Array(16).fill('?').join(',')+')');
      const insertRunCell=this.db.prepare('INSERT INTO heatmap_observation_cells('+HEATMAP_CELL_NAMES+',run_id) VALUES('+Array(22).fill('?').join(',')+')');
      for(const [runId,run]of runs){
        const column=run.column;
        const candidates=run.rows.filter(row=>row.priceLow!=null&&row.priceHigh!=null&&row.side!=='both').sort((a,b)=>String(a.side).localeCompare(String(b.side))||Number(a.priceLow)-Number(b.priceLow)||Number(a.priceHigh)-Number(b.priceHigh));
        const cells:RetainedHeatmapRow[]=[];let duplicateConflict=false;
        for(const row of candidates){
          const previous=cells.at(-1);
          if(previous&&previous.side===row.side&&previous.priceLow===row.priceLow){
            if(heatmapCellFingerprint(previous)!==heatmapCellFingerprint(row))duplicateConflict=true;
          }else cells.push(row);
        }
        if(duplicateConflict){conflicts.push(...run.rows);conflictReasons.set(runId,'native-observation-run-content-conflict');conflictError={name:'HeatmapObservationConflict',code:'native-observation-run-content-conflict',message:'native observation run contains conflicting duplicate price bands'};continue;}

        const digest=createHash('sha256').update(runId);for(const row of cells)digest.update(heatmapCellFingerprint(row));const contentHash=digest.digest('hex');
        const prior:unknown=fingerprint.get(runId);const priorHash=historyRecord(prior).contentHash;
        if(priorHash!=null){
          if(priorHash===contentHash){acceptedRunIds.push(runId);acceptedRows+=run.rows.length;continue;}
          conflicts.push(...run.rows);conflictReasons.set(runId,'native-observation-run-content-conflict');conflictError={name:'HeatmapObservationConflict',code:'native-observation-run-content-conflict',message:'immutable native observation run has different content'};continue;
        }
        const legacy:unknown=legacyColumn.get(column.instrumentId,column.bucketStart);const priorColumn=historyRecord(legacy);const hasLegacy=legacy!=null;
        let mask:HistoryInterval[]|null=null;try{mask=verifiedBookObservationIntervals({...column,sourceTimestampMin:column.sourceTimestampMin??null,sourceTimestampMax:column.sourceTimestampMax??null});}catch{}
        // Adopt an exact legacy replay using scalar comparisons; no native JSON
        // payload is copied or parsed into a second persistent store.
        if(hasLegacy && heatmapRunId(priorColumn)===runId){
          const owner=[column.instrumentId,column.bucketStart,column.sourceResolution??null,column.sourceGrouping??null,column.gridEpoch??null];
          const ownedCount=Number(historyRecord(this.db.prepare('SELECT COUNT(*) AS count FROM heatmap_cells WHERE instrument_id=? AND bucket_start=? AND source_resolution IS ? AND source_grouping IS ? AND grid_epoch IS ?').get(...owner.map(sqlParameter))).count);
          const matching=this.db.prepare('SELECT 1 FROM heatmap_cells WHERE instrument_id=? AND bucket_start=? AND source_resolution IS ? AND source_grouping IS ? AND grid_epoch IS ? AND side=? AND price_low=? AND price_high=? AND mean_amount IS ? AND mean_notional_usd IS ? AND peak_amount IS ? AND peak_notional_usd IS ? AND observed_ms=? AND observed_intervals IS ? AND observed_segments IS ? LIMIT 1');
          if(ownedCount===cells.length && cells.every(row=>Boolean(matching.get(...[...owner,row.side,row.priceLow,row.priceHigh,row.meanAmount??null,row.meanNotionalUsd??null,row.peakAmount??null,row.peakNotionalUsd??null,row.cellObservedMs??row.observedMs,JSON.stringify(row.observedIntervals??[]),JSON.stringify(row.observedSegments??[])].map(sqlParameter))))){
            insertKey.run(runId,column.instrumentId,column.bucketStart,contentHash,1,mask==null?null:JSON.stringify(mask));acceptedRunIds.push(runId);acceptedRows+=run.rows.length;continue;
          }
        }
        let overlap=false;
        if(mask?.length){
          // Compare exact BOOK masks across overlapping native bucket widths as
          // well as restart siblings. A 25-minute parent must not be counted
          // again by a differently aligned minute bucket.
          const owners=this.prepare('SELECT '+HEATMAP_DISPLAY_COLUMN_FIELDS.replace(/hc\./g,'')+' FROM heatmap_columns WHERE instrument_id=? AND bucket_start < ? AND bucket_end > ? ORDER BY bucket_start ASC LIMIT ?');
          for(const old of owners.iterate(column.instrumentId,column.bucketEnd,column.bucketStart,HISTORY_SAMPLE_LIMIT+1)){
            let oldMask:HistoryInterval[];
            try{oldMask=verifiedBookObservationIntervals({bucketStart:Number(old.bucketStart),bucketEnd:Number(old.bucketEnd),observedMs:Number(old.observedMs),sourceTimestampMin:old.sourceTimestampMin,sourceTimestampMax:old.sourceTimestampMax,gapIntervals:old.gapIntervalsJson,observedIntervals:old.observedIntervalsJson});}catch{continue;}
            if(mask.some(fresh=>oldMask.some(interval=>interval.end>fresh.start&&interval.start<fresh.end))){overlap=true;break;}
          }
        }
        if(overlap){conflicts.push(...run.rows);conflictReasons.set(runId,'native-observation-run-overlap');conflictError={name:'HeatmapObservationConflict',code:'native-observation-run-overlap',message:'native observation run overlaps existing verified BOOK support'};continue;}
        const values=[column.instrumentId,column.bucketStart,column.bucketEnd,column.observedMs,column.expectedMs,column.gapMs,column.coverage,column.sourceTimestampMin,column.sourceTimestampMax,column.receivedAt,column.sourceResolution,column.sourceGrouping,column.gridEpoch,JSON.stringify(column.observedIntervals??[]),JSON.stringify(column.gapIntervals??[])];
        if(hasLegacy)insertRunColumn.run(...values.map(value=>sqlParameter(value??null)),runId);else this.insertHeatmapColumn.run(...values);
        for(const row of cells){const values=[row.instrumentId,row.bucketStart,row.side,row.priceLow,row.priceHigh,row.meanAmount,row.meanNotionalUsd,row.peakAmount,row.peakNotionalUsd,row.cellObservedMs??row.observedMs,row.expectedMs,row.gapMs,row.coverage,row.sourceTimestampMin,row.sourceTimestampMax,row.receivedAt,row.sourceResolution,row.sourceGrouping,row.gridEpoch,JSON.stringify(row.observedIntervals??[]),JSON.stringify(row.observedSegments??[])];if(hasLegacy)insertRunCell.run(...values.map(value=>sqlParameter(value??null)),runId);else this.insertHeatmapCell.run(...values);cellCount++;}
        insertKey.run(runId,column.instrumentId,column.bucketStart,contentHash,hasLegacy?0:1,mask==null?null:JSON.stringify(mask));acceptedRunIds.push(runId);acceptedRows+=run.rows.length;writtenColumns++;
      }
      this.db.exec('COMMIT');
      for(const runId of acceptedRunIds)this.heatmapConflictedRuns.delete(runId);
      for(const [runId,reason] of conflictReasons)this.heatmapConflictedRuns.set(runId,reason);
      if(conflictError)this.heatmapWriteStats.lastError=conflictError;
      const afterUsage = this.storageUsage();
      this.heatmapWriteStats.batches += 1;
      this.heatmapWriteStats.columns += writtenColumns;
      this.heatmapWriteStats.cells += cellCount;
      this.heatmapWriteStats.logicalBytes += logicalBytes;
      this.heatmapWriteStats.physicalBytesDelta += Math.max(0, afterUsage.totalBytes - beforeUsage.totalBytes);
      this.heatmapWriteStats.storageGrowthRatio = this.heatmapWriteStats.logicalBytes > 0
        ? Number((this.heatmapWriteStats.physicalBytesDelta / this.heatmapWriteStats.logicalBytes).toFixed(6))
        : 0;
      if(conflicts.length){if(!alreadyRetained)this.#retainSessionHeatmapRows(conflicts,{detachedInternal:implicit});this.heatmapWriteStats.failedWrites+=conflicts.length;}
      if (implicit) this.heatmap.drainClosed();
    } catch (error) {
      let rollbackError: unknown = null;
      try { this.db.exec('ROLLBACK'); } catch (rollbackFailure) { rollbackError = rollbackFailure; }
      const combined = rollbackError ? Object.assign(new Error(`${historyError(error).message ?? error}; rollback failed: ${historyError(rollbackError).message ?? rollbackError}`), { code: historyError(error).code ?? historyError(rollbackError).code }) : error;
      return this.#retainHeatmapWriteFailure(combined, pending, implicit, rollbackError ? 'rollback' : 'write', alreadyRetained);
    }
    return acceptedRows;
  }
  flushHeatmap() {
    const latest = this.heatmap.latestTimestamp();
    if (latest > 0) this.heatmap.flush(latest);
    return this.persistHeatmapRows();
  }
  recordOi(sample: HistoryRecord | null) {
    if (this.persistenceSuspended) return false;
    // Native feeds may omit an exchange timestamp. Keep that fact on the
    // message, but use receipt time as the durable observation ordering key.
    const rawSource = sample?.sourceTimestamp;
    const sourceTimestamp = rawSource == null ? null : Number(rawSource);
    const observationTimestamp = Number(sample?.observationTimestamp ?? (Number.isFinite(sourceTimestamp) ? sourceTimestamp : sample?.receivedAt));
    if (!sample?.instrumentId || !(observationTimestamp > 0) || !Number.isFinite(Number(sample.base))) return false;
    if (sourceTimestamp != null && !(sourceTimestamp > 0)) return false;
    const receivedAt = Number(sample.receivedAt ?? Date.now());
    if (!(receivedAt > 0)) return false;
    const merged = this.#mergeOiBar({
      instrumentId: String(sample.instrumentId), observationTimestamp,
      sourceTimestamp: Number.isFinite(sourceTimestamp) ? sourceTimestamp : null,
      receivedAt, base: Number(sample.base), quote: sample.quote == null ? null : Number(sample.quote),
      timeBasis: String(sample.timeBasis ?? (Number.isFinite(sourceTimestamp) ? 'exchange' : 'receipt')),
      quality: String(sample.quality ?? (Number.isFinite(sourceTimestamp) ? 'native' : 'sampled')),
    });
    if (!merged) return false;
    this.flushOiBars();
    return true;
  }
  recordCandle(candle: HistoryRecord | null, { receivedAt = Date.now(), source = candle?.source ?? candle?.origin ?? 'live' }: { receivedAt?: unknown; source?: unknown } = {}) {
    if (this.persistenceSuspended) return false;
    // Forming candles remain in the bounded in-memory feed. Only closed native
    // observations become durable restart history; a later closed row upgrades it.
    if (candle?.closed !== true) return false;
    const instrumentId = String(candle?.instrumentId ?? '');
    const interval = String(candle?.interval ?? '');
    const start = Number(candle?.start);
    const end = Number(candle?.end);
    const open = Number(candle?.open);
    const high = Number(candle?.high);
    const low = Number(candle?.low);
    const close = Number(candle?.close);
    const volume = Number(candle?.volume ?? 0);
    const sourceValue = candle?.sourceTimestamp;
    const sourceTimestamp = typeof sourceValue === 'number' || (typeof sourceValue === 'string' && /^\d+(?:\.\d+)?$/.test(sourceValue.trim())) ? Number(sourceValue) : Number.NaN;
    const received = Number(candle?.receivedAt ?? receivedAt);
    if (!instrumentId || !interval || !Number.isFinite(start) || !Number.isFinite(end) || !(end > start) || ![open, high, low, close].every((value) => Number.isFinite(value) && value > 0) || !(low <= open && low <= close && high >= open && high >= close && low <= high) || !Number.isFinite(volume) || volume < 0 || !Number.isFinite(sourceTimestamp) || !(sourceTimestamp > 0) || !Number.isFinite(received)) return false;
    const existing = this.prepare('SELECT closed, origin, source_timestamp AS sourceTimestamp, source_provenance AS sourceProvenance, received_at AS receivedAt FROM candle_samples WHERE instrument_id = ? AND interval = ? AND start_timestamp = ?').get(instrumentId, interval, Math.trunc(start));
    const incomingSource = String(source);
    if (existing?.closed === 1 && candle?.closed !== true) return false;
    const existingSource = existing?.sourceProvenance === 'explicit-provider-end' ? Number(existing.sourceTimestamp) : Number.NaN;
    if (Number.isFinite(existingSource) && sourceTimestamp < existingSource) return false;
    const finalityUpgrade = existing?.closed !== 1 && candle?.closed === true && Number.isFinite(existingSource) && (sourceTimestamp > existingSource || (sourceTimestamp === existingSource && (!Number.isFinite(Number(existing?.receivedAt)) || !Number.isFinite(received) || received >= Number(existing?.receivedAt))));
    const provenanceUpgrade = existing && existing.sourceProvenance !== 'explicit-provider-end' && (!Number.isFinite(Number(existing?.receivedAt)) || received >= Number(existing?.receivedAt));
    if (existing?.origin === 'live' && incomingSource === 'history' && !finalityUpgrade && !provenanceUpgrade) return false;
    if (existing?.origin === incomingSource && Number(existing?.receivedAt) > received) return false;
    // Durable candle rows contain only validated OHLCV/provenance. Never copy
    // provider payloads or high-frequency arrays into the persistent store.
    const durable = { instrumentId, interval, start: Math.trunc(start), end: Math.trunc(end), open, high, low, close, volume, sourceTimestamp: Math.trunc(sourceTimestamp), sourceProvenance: 'explicit-provider-end', receivedAt: Math.trunc(received), closed: candle?.closed === true, quality: candle?.quality == null ? null : String(candle.quality), source: incomingSource };
    this.insertCandle.run(instrumentId, interval, Math.trunc(start), Math.trunc(end), open, high, low, close, volume, Math.trunc(sourceTimestamp), durable.sourceProvenance, Math.trunc(received), durable.closed ? 1 : 0, durable.quality, incomingSource, JSON.stringify(durable));
    return true;
  }
  recordCrossing(event: HistoryRecord | null) {
    if (this.persistenceSuspended) return false; if (!event?.levelId || !Number.isFinite(Number(event.observedAt)) || !Number.isFinite(Number(event.price))) return; this.insertCrossing.run(String(event.levelId), Number(event.observedAt), event.layer ?? null, Number(event.price), event.direction ?? null, event.provisional === false ? 0 : 1); }
  recordLayer(snapshot: HistoryRecord | null) {
    if (this.persistenceSuspended) return false;
    const sourceTimestamp = Number(snapshot?.sourceTimestamp);
    if (!snapshot?.layer || !snapshot.instrumentId || !snapshot.revision || !(sourceTimestamp > 0)) return;
    const receivedAt = Number(snapshot.receivedAt);
    this.insertLayer.run(String(snapshot.layer), String(snapshot.instrumentId), String(snapshot.revision), sourceTimestamp, Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : Date.now(), snapshot.complete === false ? 0 : 1, JSON.stringify(snapshot));
  }
  recordState(stateInput: unknown) {
    const state = historyRecord(stateInput);
    if (this.persistenceSuspended) return false;
    if (!state || !Number.isFinite(Number(state.asOf))) return;
    const payload = {
      asOf: Number(state.asOf), markPrice: Number(state.markPrice), markInstrumentId: shortText(state.markInstrumentId),
      markObserved: state.markObserved !== false, liveMode: state.liveMode === true, dataMode: shortText(state.dataMode ?? 'fixture'),
      markets: restartMarkets(state.markets),
      layerSummary: restartLayerSummary(state.layers, state.layerMeta, state.layerRevisions, state.layerSourceTimestamps),
      activeBookKeys: state.activeBookKeys && typeof state.activeBookKeys === 'object' ? Object.fromEntries(Object.entries(state.activeBookKeys).slice(0, STATE_MARKET_LIMIT).map(([k, v]) => [shortText(k), shortText(v)])) : {},
      // High-frequency books, trades, OI samples and candles have their own
      // bounded stores. Do not duplicate those large arrays in the singleton.
      metadata: restartStatuses(state.metadata),
      statuses: restartStatuses(state.statuses), feedStatuses: restartStatuses(state.feedStatuses),
    };
    this.insertState.run(Number(state.asOf), Date.now(), JSON.stringify(boundedRestartPayload(payload)));
  }
  latestState(): HistoryRecord | null {
    const row = this.prepare('SELECT payload_json AS payload FROM state_snapshots WHERE id = 1').get();
    if (!row?.payload) return null;
    try { const payload: unknown = JSON.parse(String(row.payload)); return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? historyRecord(payload) : null; } catch { return null; }
  }
  listOi(instrumentId: unknown, { from = 0, to = null, limit = 20000 }: HistoryQuery = {}) {
    const {lower,upper}=oiHistoryQueryWindow(from,to);
    const capped = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(300_000, Math.trunc(Number(limit)))) : 20_000;
    const stored = upper===null ? (instrumentId
      ? this.selectOiBars.all(String(instrumentId), this.oiBarIntervalMs, lower, capped)
      : this.selectOiBarsAll.all(this.oiBarIntervalMs, lower, capped)) : (instrumentId
      ? this.selectOiBarsWindow.all(String(instrumentId),this.oiBarIntervalMs,lower,upper,capped)
      : this.selectOiBarsAllWindow.all(this.oiBarIntervalMs,lower,upper,capped));
    const byKey = new Map(stored.map((row) => {
      const output = oiBarOutput(row); return [oiBarKey(output.instrumentId, this.oiBarIntervalMs, Number(row.bucketStart)), output];
    }));
    for (const row of this.pendingOiBars.values()) {
      if (instrumentId && String(row.instrumentId) !== String(instrumentId)) continue;
      if (!oiHistoryBarMatches(row,lower,upper)) continue;
      byKey.set(oiBarKey(row.instrumentId, this.oiBarIntervalMs, row.bucketStart), oiBarOutput(row));
    }
    return [...byKey.values()].sort((a, b) => Number(a.start) - Number(b.start)).slice(0, capped);
  }
  listCandles(instrumentId: unknown = null, { interval = null, from = 0, to = Number.MAX_SAFE_INTEGER, limit = 5_000, newestFirst = false }: HistoryQuery = {}): RuntimeCandle[] {
    const requested = instrumentId == null || instrumentId === '' ? null : String(instrumentId);
    const lower = Number.isFinite(Number(from)) ? Number(from) : 0;
    const upper = Number.isFinite(Number(to)) ? Number(to) : Number.MAX_SAFE_INTEGER;
    const capped = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(5_000, Math.trunc(Number(limit)))) : 5_000;
    const latest = newestFirst === true;
    const rows = requested
      ? interval == null || String(interval) === '' ? (latest ? this.selectCandleAllIntervalsNewest : this.selectCandleAllIntervals).all(requested, lower, upper, capped) : (latest ? this.selectCandleNewest : this.selectCandle).all(requested, String(interval), lower, upper, capped)
      : interval == null || String(interval) === '' ? (latest ? this.selectCandleAllNewest : this.selectCandleAll).all(lower, upper, capped) : (latest ? this.selectCandleAllByIntervalNewest : this.selectCandleAllByInterval).all(String(interval), lower, upper, capped);
    const candles: RuntimeCandle[] = [];
    for (const row of rows) {
      const instrumentId = String(row.instrumentId ?? '');
      const interval = String(row.interval ?? '');
      const start = Number(row.start); const end = Number(row.end);
      const open = Number(row.open); const high = Number(row.high); const low = Number(row.low); const close = Number(row.close);
      const volume = Number(row.volume ?? 0);
      // Persisted rows remain an untrusted boundary, including rows predating the current writer.
      if (!instrumentId || !interval || !Number.isFinite(start) || !Number.isFinite(end) || !(end > start)
        || ![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)
        || !(low <= open && low <= close && high >= open && high >= close && low <= high)
        || !Number.isFinite(volume) || volume < 0) continue;
      const explicit = row.sourceProvenance === 'explicit-provider-end' && Number.isFinite(Number(row.sourceTimestamp)) && Number(row.sourceTimestamp) > 0;
      const candle: RuntimeCandle = { ...row, instrumentId, interval, start, end, open, high, low, close, volume,
        source: String(row.source ?? 'history'), quality: typeof row.quality === 'string' ? row.quality : undefined,
        sourceTimestamp: explicit ? Number(row.sourceTimestamp) : null, sourceProvenance: explicit ? 'explicit-provider-end' : 'legacy-unverified',
        ...(explicit ? {} : { legacyStoredSourceTimestamp: row.sourceTimestamp }), closed: row.closed === 1 };
      // Old payload_json may still claim its inferred end was provider time. Keep it on disk for audit,
      // but return a canonical payload that agrees with the conservative public provenance mapping.
      if (!explicit) candle.payloadJson = JSON.stringify({ ...candle, payloadJson: undefined });
      candles.push(candle);
    }
    return candles;
  }
  prune(now = Date.now()) {
    this.flushPendingDepth();
    this.flushHeatmap();
    this.flushOiBars({ force: true });
    const cutoff = now - this.retentionDays * 86_400_000;
    const depthCutoff = now - this.depthRetentionDays * 86_400_000;
    this.prepare('DELETE FROM oi_bars WHERE bucket_start < ?').run(cutoff);
    this.prepare('DELETE FROM candle_samples WHERE start_timestamp < ?').run(cutoff);
    this.prepare('DELETE FROM layer_snapshots WHERE source_timestamp < ?').run(cutoff);
    this.prepare('DELETE FROM crossing_events WHERE observed_at < ?').run(cutoff);
    this.prepare('DELETE FROM depth_samples WHERE source_timestamp < ?').run(depthCutoff);
    this.#deleteHeatmapBuckets('<',depthCutoff);
    this.enforceStorageBudget({ compact: false });
  }
  close() { this.flushPendingDepth(); this.flushHeatmap(); this.flushOiBars({ force: true }); this.compactStorage(); this.db.close(); }
}
