import type { FacingId, ProductId, RetailerId, StoreId } from '../../domain/common/ids.js';
import type { RetailerPartitioned } from '../../domain/common/partition.js';
import type { Instant, Millis, TimeWindow } from '../../domain/common/time.js';
import type { FacingLocation } from '../../domain/facing/facing.js';
import type { ShelfState } from '../../domain/facing/shelf-state.js';
import type { SignalSource } from '../../domain/facing/signals.js';
import type { TaskType } from '../../domain/task/task-type.js';
import type { Page, PageRequest } from '../common/paging.js';

/**
 * Reporting and query boundary — the read side of the service.
 *
 * Types only: no behaviour lives here.
 *
 * Every query is scoped to exactly one retailer. That is not a convenience for
 * the caller, it is the same no-cross-retailer-pooling rule the domain enforces
 * on its aggregates, applied to the read model: there is no shape in this module
 * that can express a question spanning two retailers.
 */

/** Rollup grain for a time series. `period` returns a single bucket for the whole window. */
export type ReportGranularity = 'hour' | 'day' | 'week' | 'period';

/**
 * How a report is broken down beyond the overall figure.
 *
 * `department` and `category` are two cuts of the same merchandising hierarchy
 * and both are here on purpose: a category tells a buyer which shelf is failing,
 * a department tells a store manager whose staff to move, and outcome metrics are
 * read by the second far more often than the first.
 */
export type ReportDimension =
  | 'store'
  | 'product'
  | 'department'
  | 'category'
  | 'aisle'
  | 'task_type';

export interface ReportScope extends RetailerPartitioned {
  /** Partition key. Required — there is no all-retailers query. */
  readonly retailerId: RetailerId;
  /** `null` covers every store in the partition. */
  readonly storeIds: readonly StoreId[] | null;
  /** `null` covers every SKU. */
  readonly productIds: readonly ProductId[] | null;
  /** Half-open `[from, to)`, matching the domain's window semantics. */
  readonly window: TimeWindow;
  readonly granularity: ReportGranularity;
  readonly breakdownBy: readonly ReportDimension[];
}

/** One labelled slice of a breakdown. */
export interface ReportBreakdown<T> {
  readonly dimension: ReportDimension;
  /** Dimension member: a store id, product id, department, category, aisle or task type. */
  readonly key: string;
  readonly label: string;
  readonly value: T;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * One bucket of the availability index.
 *
 * Carries the numerator and denominator alongside the ratio so buckets can be
 * re-aggregated by the caller without re-querying, and so a figure computed from
 * a sliver of measured time is visibly untrustworthy rather than silently
 * confident. `index` is `null` — never `0` — when nothing was measured.
 */
export interface AvailabilityIndexPoint {
  readonly window: TimeWindow;
  readonly index: number | null;
  readonly coverage: number;
  readonly inStockFacingMillis: Millis;
  readonly measuredFacingMillis: Millis;
  readonly unknownFacingMillis: Millis;
  readonly facingCount: number;
}

export interface AvailabilityIndexReport extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly window: TimeWindow;
  readonly granularity: ReportGranularity;
  /** The whole window as one bucket. */
  readonly overall: AvailabilityIndexPoint;
  readonly series: readonly AvailabilityIndexPoint[];
  readonly breakdowns: readonly ReportBreakdown<AvailabilityIndexPoint>[];
  readonly computedAt: Instant;
}

/**
 * Per-facing availability over the window — the row-level record the index rolls
 * up from, and the level retailers drill to when they dispute a number.
 */
export interface AvailabilityRecord extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  readonly productId: ProductId;
  readonly location: FacingLocation;
  readonly window: TimeWindow;
  readonly stateAtWindowStart: ShelfState;
  readonly stateAtWindowEnd: ShelfState;
  readonly inStockMillis: Millis;
  readonly outOfStockMillis: Millis;
  readonly unknownMillis: Millis;
  readonly measuredMillis: Millis;
  readonly coverage: number;
  readonly index: number | null;
  /** Out-of-stock transitions observed in the window. */
  readonly gapCount: number;
  /** Sources that contributed evidence, for judging how well observed the facing was. */
  readonly contributingSources: readonly SignalSource[];
}

/** Ordering for availability record listings. Worst-first is the operational default. */
export type AvailabilityRecordSort =
  | 'index_asc'
  | 'index_desc'
  | 'out_of_stock_millis_desc'
  | 'gap_count_desc'
  | 'coverage_asc';

export interface AvailabilityRecordQuery {
  readonly scope: ReportScope;
  readonly sort: AvailabilityRecordSort;
  /** `null` returns every facing in scope. */
  readonly minGapCount: number | null;
  readonly page: PageRequest;
}

/** Read port for availability figures and the records behind them. */
export interface AvailabilityQueryPort {
  /** Availability index (facing-time in stock) for the scope. */
  availabilityIndex(scope: ReportScope): Promise<AvailabilityIndexReport>;

  /** Per-facing availability records, paged. */
  availabilityRecords(query: AvailabilityRecordQuery): Promise<Page<AvailabilityRecord>>;
}

// ---------------------------------------------------------------------------
// Task work rate
// ---------------------------------------------------------------------------

/** Task counts by lifecycle outcome for one bucket. */
export interface TaskWorkRatePoint {
  readonly window: TimeWindow;
  readonly created: number;
  readonly assigned: number;
  readonly acknowledged: number;
  readonly resolved: number;
  readonly verified: number;
  readonly reopened: number;
  readonly cancelled: number;
  readonly expired: number;
  /** Still open at the end of the bucket. */
  readonly outstanding: number;
  /**
   * Labour hours the retailer's workforce feed reported for the scope, or `null`
   * when that feed is not connected. The service does not estimate it.
   */
  readonly labourHours: number | null;
  /** `verified / labourHours`, or `null` without a labour feed. */
  readonly tasksPerLabourHour: number | null;
  /** `verified / created` — how much of what was raised actually got closed. */
  readonly completionRate: number | null;
  /** `reopened / resolved` — how much reported work did not hold. */
  readonly reworkRate: number | null;
}

export interface TaskWorkRateReport extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly window: TimeWindow;
  readonly granularity: ReportGranularity;
  readonly overall: TaskWorkRatePoint;
  readonly series: readonly TaskWorkRatePoint[];
  readonly breakdowns: readonly ReportBreakdown<TaskWorkRatePoint>[];
  readonly computedAt: Instant;
}

// ---------------------------------------------------------------------------
// Resolved-gap rate
// ---------------------------------------------------------------------------

/**
 * How many detected gaps actually got closed.
 *
 * The denominator is the trap this shape is built to avoid. A gap detected an
 * hour before the window ends cannot possibly have completed a 24-hour
 * verification, so counting it as unresolved understates the rate. Gaps whose
 * verification window is still open are therefore reported separately in
 * `awaitingVerification` and excluded from `resolvedGapRate` entirely.
 */
export interface ResolvedGapRatePoint {
  readonly window: TimeWindow;
  /** Out-of-stock transitions detected in the bucket. */
  readonly detectedGaps: number;
  /** Detected gaps that became a task. */
  readonly taskedGaps: number;
  /** Tasked gaps an employee reported resolved. */
  readonly resolvedGaps: number;
  /** Resolved gaps that passed the two-clean-passes rule. */
  readonly verifiedGaps: number;
  /** Returned to stock without a task — incidental restock, not closed-loop work. */
  readonly selfResolvedGaps: number;
  /** Still out of stock at the end of the bucket. */
  readonly unresolvedGaps: number;
  /** Resolved but still inside the verification window; excluded from the rate. */
  readonly awaitingVerification: number;
  /** `taskedGaps / detectedGaps` — how much of what was seen got dispatched. */
  readonly taskedGapRate: number | null;
  /**
   * `verifiedGaps / (detectedGaps - awaitingVerification)`. `null` when the
   * denominator is zero.
   */
  readonly resolvedGapRate: number | null;
}

export interface ResolvedGapRateReport extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly window: TimeWindow;
  readonly granularity: ReportGranularity;
  readonly overall: ResolvedGapRatePoint;
  readonly series: readonly ResolvedGapRatePoint[];
  readonly breakdowns: readonly ReportBreakdown<ResolvedGapRatePoint>[];
  readonly computedAt: Instant;
}

// ---------------------------------------------------------------------------
// Detection to resolution
// ---------------------------------------------------------------------------

/**
 * Latency distribution for one stage. Percentiles, not just a mean: the tail is
 * what a store manager experiences, and an average hides it.
 */
export interface DurationDistribution {
  readonly sampleSize: number;
  readonly p50: Millis | null;
  readonly p90: Millis | null;
  readonly p99: Millis | null;
  readonly mean: Millis | null;
  readonly max: Millis | null;
}

/**
 * Stage-by-stage latency through the closed loop, so a slow number can be
 * attributed rather than argued about: detection lag, dispatch lag, employee
 * response and verification lag are four different problems with four different
 * owners.
 */
export interface DetectionToResolutionPoint {
  readonly window: TimeWindow;
  /** Out-of-stock transition to task creation. */
  readonly detectionToTask: DurationDistribution;
  /** Task creation to assignment. */
  readonly taskToAssignment: DurationDistribution;
  /** Assignment to employee acknowledgement. */
  readonly assignmentToAcknowledgement: DurationDistribution;
  /** Acknowledgement to the employee reporting the work done. */
  readonly acknowledgementToResolution: DurationDistribution;
  /** Resolution to the second clean pass that verified it. */
  readonly resolutionToVerification: DurationDistribution;
  /** End to end: detection to verified. The headline closed-loop number. */
  readonly detectionToVerification: DurationDistribution;
  /** Shelf time lost: detection to the facing returning to stock, however it returned. */
  readonly detectionToBackInStock: DurationDistribution;
}

export interface DetectionToResolutionReport extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly window: TimeWindow;
  readonly granularity: ReportGranularity;
  readonly overall: DetectionToResolutionPoint;
  readonly series: readonly DetectionToResolutionPoint[];
  readonly breakdowns: readonly ReportBreakdown<DetectionToResolutionPoint>[];
  readonly computedAt: Instant;
}

/** Read port for how well the loop is closing, as opposed to how stocked the shelf is. */
export interface TaskPerformanceQueryPort {
  /** Task throughput, completion and rework, with per-labour-hour rate when available. */
  taskWorkRate(scope: ReportScope): Promise<TaskWorkRateReport>;

  /** Share of detected gaps that reached a verified resolution. */
  resolvedGapRate(scope: ReportScope): Promise<ResolvedGapRateReport>;

  /** Stage-by-stage latency from detection through verification. */
  detectionToResolution(scope: ReportScope): Promise<DetectionToResolutionReport>;
}

/** Convenience surface for callers that need the whole read side. */
export interface ReportingPort extends AvailabilityQueryPort, TaskPerformanceQueryPort {
  /** Task types in scope for the retailer, for building breakdown filters. */
  reportableTaskTypes(retailerId: RetailerId): Promise<readonly TaskType[]>;
}
