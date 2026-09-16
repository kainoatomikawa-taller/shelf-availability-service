import { SHELF_STATES, SIGNAL_SOURCES } from '../models/enums';
import type { RetailerId } from '../models/ids';
import type { Page, PageCursor } from '../models/paging';
import { REPORT_DIMENSIONS, REPORT_GRANULARITIES } from '../models/scope';
import type { ReportBreakdown, ReportEnvelope } from '../models/scope';
import type {
  AvailabilityIndexPoint,
  AvailabilityRecord,
  FacingLocation,
} from '../models/availability';
import type {
  DetectionToResolutionPoint,
  DurationDistribution,
  ResolvedGapRatePoint,
  TaskWorkRatePoint,
} from '../models/task-performance';
import type { Decoder } from './decode';
import {
  at,
  decodeArray,
  decodeCount,
  decodeEnum,
  decodeId,
  decodeInstant,
  decodeMillis,
  decodeNullable,
  decodeNumber,
  decodeRatio,
  decodeString,
  decodeTimeWindow,
  field,
} from './decode';

const decodeRetailerId = decodeId<RetailerId>('RetailerId');
const decodeGranularity = decodeEnum(REPORT_GRANULARITIES, 'ReportGranularity');
const decodeDimension = decodeEnum(REPORT_DIMENSIONS, 'ReportDimension');
const decodeShelfState = decodeEnum(SHELF_STATES, 'ShelfState');
const decodeSignalSource = decodeEnum(SIGNAL_SOURCES, 'SignalSource');

const nullableRatio = decodeNullable(decodeRatio);
const nullableMillis = decodeNullable(decodeMillis);
const nullableNumber = decodeNullable(decodeNumber);

/**
 * The envelope every report shares.
 *
 * Decoded once, generically, so the four reports cannot drift in how they read
 * `overall` / `series` / `breakdowns` — the shape they have in common is the
 * shape the chart and table components are written against.
 */
export const decodeReportEnvelope =
  <P>(decodePoint: Decoder<P>): Decoder<ReportEnvelope<P>> =>
  (raw, path) => ({
    retailerId: decodeRetailerId(field(raw, 'retailerId', path), at(path, 'retailerId')),
    window: decodeTimeWindow(field(raw, 'window', path), at(path, 'window')),
    granularity: decodeGranularity(field(raw, 'granularity', path), at(path, 'granularity')),
    overall: decodePoint(field(raw, 'overall', path), at(path, 'overall')),
    series: decodeArray(decodePoint)(field(raw, 'series', path), at(path, 'series')),
    breakdowns: decodeArray(decodeBreakdown(decodePoint))(
      field(raw, 'breakdowns', path),
      at(path, 'breakdowns'),
    ),
    computedAt: decodeInstant(field(raw, 'computedAt', path), at(path, 'computedAt')),
  });

const decodeBreakdown =
  <P>(decodePoint: Decoder<P>): Decoder<ReportBreakdown<P>> =>
  (raw, path) => ({
    dimension: decodeDimension(field(raw, 'dimension', path), at(path, 'dimension')),
    key: decodeString(field(raw, 'key', path), at(path, 'key')),
    label: decodeString(field(raw, 'label', path), at(path, 'label')),
    value: decodePoint(field(raw, 'value', path), at(path, 'value')),
  });

/** A paged listing. The cursor is passed straight back through, never inspected. */
export const decodePage =
  <T>(decodeItem: Decoder<T>): Decoder<Page<T>> =>
  (raw, path) => ({
    items: decodeArray(decodeItem)(field(raw, 'items', path), at(path, 'items')),
    nextCursor: decodeNullable(decodeId<PageCursor>('PageCursor'))(
      field(raw, 'nextCursor', path),
      at(path, 'nextCursor'),
    ),
    totalEstimate: decodeNullable(decodeCount)(
      field(raw, 'totalEstimate', path),
      at(path, 'totalEstimate'),
    ),
  });

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export const decodeAvailabilityIndexPoint: Decoder<AvailabilityIndexPoint> = (raw, path) => ({
  window: decodeTimeWindow(field(raw, 'window', path), at(path, 'window')),
  // `null` and `0` mean opposite things here: nothing measured versus everything
  // measured and every facing empty. `decodeNullable` keeps them apart.
  index: nullableRatio(field(raw, 'index', path), at(path, 'index')),
  coverage: decodeRatio(field(raw, 'coverage', path), at(path, 'coverage')),
  inStockFacingMillis: decodeMillis(
    field(raw, 'inStockFacingMillis', path),
    at(path, 'inStockFacingMillis'),
  ),
  measuredFacingMillis: decodeMillis(
    field(raw, 'measuredFacingMillis', path),
    at(path, 'measuredFacingMillis'),
  ),
  unknownFacingMillis: decodeMillis(
    field(raw, 'unknownFacingMillis', path),
    at(path, 'unknownFacingMillis'),
  ),
  facingCount: decodeCount(field(raw, 'facingCount', path), at(path, 'facingCount')),
});

const decodeFacingLocation: Decoder<FacingLocation> = (raw, path) => ({
  aisle: decodeString(field(raw, 'aisle', path), at(path, 'aisle')),
  bay: decodeString(field(raw, 'bay', path), at(path, 'bay')),
  shelf: decodeCount(field(raw, 'shelf', path), at(path, 'shelf')),
  position: decodeCount(field(raw, 'position', path), at(path, 'position')),
});

export const decodeAvailabilityRecord: Decoder<AvailabilityRecord> = (raw, path) => ({
  retailerId: decodeRetailerId(field(raw, 'retailerId', path), at(path, 'retailerId')),
  storeId: decodeId<AvailabilityRecord['storeId']>('StoreId')(
    field(raw, 'storeId', path),
    at(path, 'storeId'),
  ),
  facingId: decodeId<AvailabilityRecord['facingId']>('FacingId')(
    field(raw, 'facingId', path),
    at(path, 'facingId'),
  ),
  productId: decodeId<AvailabilityRecord['productId']>('ProductId')(
    field(raw, 'productId', path),
    at(path, 'productId'),
  ),
  location: decodeFacingLocation(field(raw, 'location', path), at(path, 'location')),
  window: decodeTimeWindow(field(raw, 'window', path), at(path, 'window')),
  stateAtWindowStart: decodeShelfState(
    field(raw, 'stateAtWindowStart', path),
    at(path, 'stateAtWindowStart'),
  ),
  stateAtWindowEnd: decodeShelfState(
    field(raw, 'stateAtWindowEnd', path),
    at(path, 'stateAtWindowEnd'),
  ),
  inStockMillis: decodeMillis(field(raw, 'inStockMillis', path), at(path, 'inStockMillis')),
  outOfStockMillis: decodeMillis(field(raw, 'outOfStockMillis', path), at(path, 'outOfStockMillis')),
  unknownMillis: decodeMillis(field(raw, 'unknownMillis', path), at(path, 'unknownMillis')),
  measuredMillis: decodeMillis(field(raw, 'measuredMillis', path), at(path, 'measuredMillis')),
  coverage: decodeRatio(field(raw, 'coverage', path), at(path, 'coverage')),
  index: nullableRatio(field(raw, 'index', path), at(path, 'index')),
  gapCount: decodeCount(field(raw, 'gapCount', path), at(path, 'gapCount')),
  contributingSources: decodeArray(decodeSignalSource)(
    field(raw, 'contributingSources', path),
    at(path, 'contributingSources'),
  ),
});

// ---------------------------------------------------------------------------
// Task work rate
// ---------------------------------------------------------------------------

export const decodeTaskWorkRatePoint: Decoder<TaskWorkRatePoint> = (raw, path) => ({
  window: decodeTimeWindow(field(raw, 'window', path), at(path, 'window')),
  created: decodeCount(field(raw, 'created', path), at(path, 'created')),
  assigned: decodeCount(field(raw, 'assigned', path), at(path, 'assigned')),
  acknowledged: decodeCount(field(raw, 'acknowledged', path), at(path, 'acknowledged')),
  resolved: decodeCount(field(raw, 'resolved', path), at(path, 'resolved')),
  verified: decodeCount(field(raw, 'verified', path), at(path, 'verified')),
  reopened: decodeCount(field(raw, 'reopened', path), at(path, 'reopened')),
  cancelled: decodeCount(field(raw, 'cancelled', path), at(path, 'cancelled')),
  expired: decodeCount(field(raw, 'expired', path), at(path, 'expired')),
  outstanding: decodeCount(field(raw, 'outstanding', path), at(path, 'outstanding')),
  // Nullable, not zero-defaulted: no workforce feed is not the same as no hours
  // worked, and the service refuses to estimate it rather than guessing.
  labourHours: nullableNumber(field(raw, 'labourHours', path), at(path, 'labourHours')),
  tasksPerLabourHour: nullableNumber(
    field(raw, 'tasksPerLabourHour', path),
    at(path, 'tasksPerLabourHour'),
  ),
  completionRate: nullableRatio(field(raw, 'completionRate', path), at(path, 'completionRate')),
  reworkRate: nullableRatio(field(raw, 'reworkRate', path), at(path, 'reworkRate')),
});

// ---------------------------------------------------------------------------
// Resolved-gap rate
// ---------------------------------------------------------------------------

export const decodeResolvedGapRatePoint: Decoder<ResolvedGapRatePoint> = (raw, path) => ({
  window: decodeTimeWindow(field(raw, 'window', path), at(path, 'window')),
  detectedGaps: decodeCount(field(raw, 'detectedGaps', path), at(path, 'detectedGaps')),
  taskedGaps: decodeCount(field(raw, 'taskedGaps', path), at(path, 'taskedGaps')),
  resolvedGaps: decodeCount(field(raw, 'resolvedGaps', path), at(path, 'resolvedGaps')),
  verifiedGaps: decodeCount(field(raw, 'verifiedGaps', path), at(path, 'verifiedGaps')),
  selfResolvedGaps: decodeCount(field(raw, 'selfResolvedGaps', path), at(path, 'selfResolvedGaps')),
  unresolvedGaps: decodeCount(field(raw, 'unresolvedGaps', path), at(path, 'unresolvedGaps')),
  awaitingVerification: decodeCount(
    field(raw, 'awaitingVerification', path),
    at(path, 'awaitingVerification'),
  ),
  taskedGapRate: nullableRatio(field(raw, 'taskedGapRate', path), at(path, 'taskedGapRate')),
  resolvedGapRate: nullableRatio(field(raw, 'resolvedGapRate', path), at(path, 'resolvedGapRate')),
});

// ---------------------------------------------------------------------------
// Detection to resolution
// ---------------------------------------------------------------------------

export const decodeDurationDistribution: Decoder<DurationDistribution> = (raw, path) => ({
  sampleSize: decodeCount(field(raw, 'sampleSize', path), at(path, 'sampleSize')),
  p50: nullableMillis(field(raw, 'p50', path), at(path, 'p50')),
  p90: nullableMillis(field(raw, 'p90', path), at(path, 'p90')),
  p99: nullableMillis(field(raw, 'p99', path), at(path, 'p99')),
  mean: nullableMillis(field(raw, 'mean', path), at(path, 'mean')),
  max: nullableMillis(field(raw, 'max', path), at(path, 'max')),
});

export const decodeDetectionToResolutionPoint: Decoder<DetectionToResolutionPoint> = (
  raw,
  path,
) => {
  const stage = (key: string): DurationDistribution =>
    decodeDurationDistribution(field(raw, key, path), at(path, key));
  return {
    window: decodeTimeWindow(field(raw, 'window', path), at(path, 'window')),
    detectionToTask: stage('detectionToTask'),
    taskToAssignment: stage('taskToAssignment'),
    assignmentToAcknowledgement: stage('assignmentToAcknowledgement'),
    acknowledgementToResolution: stage('acknowledgementToResolution'),
    resolutionToVerification: stage('resolutionToVerification'),
    detectionToVerification: stage('detectionToVerification'),
    detectionToBackInStock: stage('detectionToBackInStock'),
  };
};
