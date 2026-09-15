import type {
  CategoryId,
  DepartmentId,
  FacingId,
  GapId,
  ProductId,
  RetailerId,
  StoreId,
  TaskId,
} from '../domain/common/ids.js';
import { assertSameRetailer, type RetailerPartitioned } from '../domain/common/partition.js';
import {
  DAY,
  HOUR,
  WEEK,
  contains,
  elapsed,
  millis,
  plus,
  timeWindow,
  type Instant,
  type Millis,
  type TimeWindow,
} from '../domain/common/time.js';
import {
  STANDARD_VERIFICATION_RULE,
  type VerificationRule,
} from '../domain/availability/verification.js';
import { gapKindOf, type DetectedGap, type GapKind } from '../domain/gap/gap.js';
import type { Task, TaskTransition } from '../domain/task/task.js';
import type { TaskType } from '../domain/task/task-type.js';
import type {
  DetectionToResolutionPoint,
  DetectionToResolutionReport,
  DurationDistribution,
  ReportBreakdown,
  ReportGranularity,
  ResolvedGapRatePoint,
  ResolvedGapRateReport,
  TaskWorkRatePoint,
  TaskWorkRateReport,
} from '../ports/inbound/reporting.port.js';

/**
 * Outcome metrics, accumulated as the loop runs.
 *
 * The record below is written by the loop itself — one per detected gap, updated
 * as the task it raised moves — rather than reconstructed afterwards by joining
 * task rows back to facing history. That is the difference between a metric the
 * service can stand behind and one that is re-derived by whoever is asking: every
 * stage boundary is stamped by the transition that caused it, at the instant the
 * domain says it happened, and the report is a fold over records that were true
 * when they were written.
 */

/**
 * One gap's journey through the loop.
 *
 * The repeated stages carry two anchors each, and which one a metric uses is a
 * decision, not an accident. Dispatch and response lag are about the *first*
 * dispatch — how long the store took to pick the work up. Resolution and
 * verification lag are about the attempt that actually held, so they anchor on the
 * *last* acknowledgement. Rework is not smeared into either: it is counted in
 * `reopenCount`, where a store manager can see it.
 */
export interface LoopOutcomeRecord extends RetailerPartitioned {
  /** Partition key. Metrics are never pooled across retailers. */
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  readonly productId: ProductId;
  readonly departmentId: DepartmentId;
  readonly categoryId: CategoryId;
  readonly gapId: GapId;
  readonly kind: GapKind;
  /** `null` until the gap is dispatched — a detected gap nobody tasked. */
  readonly taskId: TaskId | null;
  readonly taskType: TaskType | null;
  readonly detectedAt: Instant;
  readonly taskCreatedAt: Instant | null;
  /** First assignment. Dispatch lag is about the first time somebody got it. */
  readonly assignedAt: Instant | null;
  readonly acknowledgedAt: Instant | null;
  /** Latest acknowledgement — the start of the attempt that produced `resolvedAt`. */
  readonly lastAcknowledgedAt: Instant | null;
  /** Latest resolution: the one whose verification is being waited on. */
  readonly resolvedAt: Instant | null;
  readonly verifiedAt: Instant | null;
  /** When the facing returned to stock, however it returned. */
  readonly backInStockAt: Instant | null;
  readonly reopenCount: number;
  readonly terminal: 'verified' | 'cancelled' | 'expired' | null;
}

/** Opens a record the moment a gap is detected, before anything is dispatched. */
export const openOutcome = (gap: DetectedGap): LoopOutcomeRecord => ({
  retailerId: gap.retailerId,
  storeId: gap.storeId,
  facingId: gap.facingId,
  productId: gap.productId,
  departmentId: gap.classification.departmentId,
  categoryId: gap.classification.categoryId,
  gapId: gap.gapId,
  kind: gapKindOf(gap),
  taskId: null,
  taskType: null,
  detectedAt: gap.detectedAt,
  taskCreatedAt: null,
  assignedAt: null,
  acknowledgedAt: null,
  lastAcknowledgedAt: null,
  resolvedAt: null,
  verifiedAt: null,
  backInStockAt: null,
  reopenCount: 0,
  terminal: null,
});

/** Binds the task raised for the gap. */
export const withTask = (record: LoopOutcomeRecord, task: Task): LoopOutcomeRecord => {
  assertSameRetailer(record.retailerId, task, 'withTask');
  return {
    ...record,
    taskId: task.taskId,
    taskType: task.type,
    taskCreatedAt: task.createdAt,
  };
};

/** Folds one lifecycle transition into the record. */
export function withTransition(
  record: LoopOutcomeRecord,
  transition: TaskTransition,
): LoopOutcomeRecord {
  assertSameRetailer(record.retailerId, transition.task, 'withTransition');
  const { at } = transition;

  switch (transition.to) {
    case 'assigned':
      return { ...record, assignedAt: record.assignedAt ?? at };
    case 'acknowledged':
      return {
        ...record,
        acknowledgedAt: record.acknowledgedAt ?? at,
        lastAcknowledgedAt: at,
      };
    case 'awaiting_verification':
      return { ...record, resolvedAt: at };
    case 'verified':
      // A task type that closes on resolution has no separate resolution instant;
      // the moment it was reported done is the moment it was done.
      return {
        ...record,
        resolvedAt: record.resolvedAt ?? at,
        verifiedAt: at,
        terminal: 'verified',
      };
    case 'reopened':
      return { ...record, reopenCount: record.reopenCount + 1 };
    case 'cancelled':
      return { ...record, terminal: 'cancelled' };
    case 'expired':
      return { ...record, terminal: 'expired' };
    case 'created':
    case 'in_progress':
      return record;
  }
}

/** Stamps the facing returning to stock, whoever or whatever put it back. */
export const withBackInStock = (record: LoopOutcomeRecord, at: Instant): LoopOutcomeRecord => ({
  ...record,
  backInStockAt: record.backInStockAt ?? at,
});

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

const EMPTY_DISTRIBUTION: DurationDistribution = {
  sampleSize: 0,
  p50: null,
  p90: null,
  p99: null,
  mean: null,
  max: null,
};

/**
 * Nearest-rank percentile over the samples present.
 *
 * Nearest-rank rather than interpolated: every reported figure is then a latency
 * some gap actually had, which is what a store manager disputing a number wants to
 * be shown. With no samples every figure is `null` — never `0` — for the same
 * reason the availability index is: "nothing happened" and "it was instant" are
 * different answers.
 */
const percentile = (sorted: readonly Millis[], fraction: number): Millis | null => {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
};

export function distributionOf(samples: readonly Millis[]): DurationDistribution {
  if (samples.length === 0) return EMPTY_DISTRIBUTION;

  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, sample) => sum + sample, 0);

  return {
    sampleSize: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    mean: millis(total / sorted.length),
    max: sorted[sorted.length - 1] ?? null,
  };
}

/** A stage's sample for one record, or `null` when the record never reached it. */
const stage = (from: Instant | null, to: Instant | null): Millis | null =>
  from === null || to === null ? null : elapsed(from, to);

const samplesOf = (
  records: readonly LoopOutcomeRecord[],
  of: (record: LoopOutcomeRecord) => Millis | null,
): readonly Millis[] =>
  records.map(of).filter((sample): sample is Millis => sample !== null);

// ---------------------------------------------------------------------------
// Bucketing and breakdowns
// ---------------------------------------------------------------------------

const stepFor = (granularity: ReportGranularity): Millis | null => {
  switch (granularity) {
    case 'hour':
      return HOUR;
    case 'day':
      return DAY;
    case 'week':
      return WEEK;
    case 'period':
      return null;
  }
};

/**
 * Buckets tiling the window, aligned to `window.from` rather than to the epoch.
 *
 * The caller's window is the authority on what period is being reported: aligning
 * to the epoch would emit a partial leading bucket nobody asked for and quietly
 * shift every figure in a report whose window starts mid-hour.
 */
export function bucketsFor(
  window: TimeWindow,
  granularity: ReportGranularity,
): readonly TimeWindow[] {
  const step = stepFor(granularity);
  if (step === null || step === 0) return [window];

  const buckets: TimeWindow[] = [];
  for (let from = window.from; from < window.to; from = plus(from, step)) {
    const to = plus(from, step);
    buckets.push(timeWindow(from, to > window.to ? window.to : to));
  }
  return buckets.length === 0 ? [window] : buckets;
}

/**
 * Dimensions an outcome record can actually be cut by.
 *
 * A narrower type than the port's `ReportDimension` on purpose: `aisle` is a
 * property of a facing's location, not of the loop's own record, and a report that
 * silently returned no aisle breakdown when asked for one would be the same kind
 * of quiet omission the audit export refuses to make.
 */
export type OutcomeDimension = 'store' | 'product' | 'department' | 'category' | 'task_type';

const keyOf = (record: LoopOutcomeRecord, dimension: OutcomeDimension): string | null => {
  switch (dimension) {
    case 'store':
      return record.storeId;
    case 'product':
      return record.productId;
    case 'department':
      return record.departmentId;
    case 'category':
      return record.categoryId;
    case 'task_type':
      return record.taskType;
  }
};

const groupBy = (
  records: readonly LoopOutcomeRecord[],
  dimension: OutcomeDimension,
): ReadonlyMap<string, readonly LoopOutcomeRecord[]> => {
  const grouped = new Map<string, LoopOutcomeRecord[]>();
  for (const record of records) {
    const key = keyOf(record, dimension);
    // A gap nobody tasked has no task type to be cut by; it stays in the overall
    // figure and out of that breakdown rather than being filed under "unknown".
    if (key === null) continue;
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, [record]);
    else existing.push(record);
  }
  return grouped;
};

const breakdownsOf = <T>(
  records: readonly LoopOutcomeRecord[],
  dimensions: readonly OutcomeDimension[],
  value: (slice: readonly LoopOutcomeRecord[]) => T,
): readonly ReportBreakdown<T>[] =>
  dimensions.flatMap((dimension) =>
    [...groupBy(records, dimension)]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, slice]) => ({ dimension, key, label: key, value: value(slice) })),
  );

// ---------------------------------------------------------------------------
// The reports
// ---------------------------------------------------------------------------

export interface OutcomeMetricsInput {
  readonly retailerId: RetailerId;
  /** Reporting window. Records are cohorted by `detectedAt` falling inside it. */
  readonly window: TimeWindow;
  readonly granularity: ReportGranularity;
  readonly records: readonly LoopOutcomeRecord[];
  readonly computedAt: Instant;
  /** Defaults to a department cut — the one a store manager acts on. */
  readonly breakdownBy?: readonly OutcomeDimension[];
  readonly rule?: VerificationRule;
  /**
   * Labour hours the retailer's workforce feed reported for a bucket, or `null`
   * when that feed is not connected.
   *
   * A function of the bucket rather than one figure for the period, because a
   * per-labour-hour rate computed by spreading a week's payroll evenly over its
   * hours would say a store was equally staffed at 3am and at Saturday lunchtime.
   * The service never estimates it: no feed means `null`, not a guess.
   */
  readonly labourHoursFor?: (window: TimeWindow) => number | null;
}

const DEFAULT_DIMENSIONS: readonly OutcomeDimension[] = ['department'];

/**
 * Records detected inside the window, in one partition.
 *
 * Cohorted by detection rather than by completion so both reports describe the
 * same population: "of the gaps we found this week, how many closed and how fast"
 * is answerable; "gaps we found this week" against "closures we saw this week" is
 * two populations and a ratio that means nothing.
 */
const cohort = (input: OutcomeMetricsInput, window: TimeWindow): readonly LoopOutcomeRecord[] =>
  input.records.filter((record) => {
    assertSameRetailer(input.retailerId, record, 'outcome metrics');
    return contains(window, record.detectedAt);
  });

export function detectionToResolutionPoint(
  records: readonly LoopOutcomeRecord[],
  window: TimeWindow,
): DetectionToResolutionPoint {
  return {
    window,
    detectionToTask: distributionOf(
      samplesOf(records, (r) => stage(r.detectedAt, r.taskCreatedAt)),
    ),
    taskToAssignment: distributionOf(samplesOf(records, (r) => stage(r.taskCreatedAt, r.assignedAt))),
    assignmentToAcknowledgement: distributionOf(
      samplesOf(records, (r) => stage(r.assignedAt, r.acknowledgedAt)),
    ),
    acknowledgementToResolution: distributionOf(
      samplesOf(records, (r) => stage(r.lastAcknowledgedAt, r.resolvedAt)),
    ),
    resolutionToVerification: distributionOf(
      samplesOf(records, (r) => stage(r.resolvedAt, r.verifiedAt)),
    ),
    detectionToVerification: distributionOf(
      samplesOf(records, (r) => stage(r.detectedAt, r.verifiedAt)),
    ),
    detectionToBackInStock: distributionOf(
      samplesOf(records, (r) => stage(r.detectedAt, r.backInStockAt)),
    ),
  };
}

/** Stage-by-stage latency through the loop, with the series and breakdowns. */
export function computeDetectionToResolution(
  input: OutcomeMetricsInput,
): DetectionToResolutionReport {
  const overallRecords = cohort(input, input.window);

  return {
    retailerId: input.retailerId,
    window: input.window,
    granularity: input.granularity,
    overall: detectionToResolutionPoint(overallRecords, input.window),
    series: bucketsFor(input.window, input.granularity).map((bucket) =>
      detectionToResolutionPoint(cohort(input, bucket), bucket),
    ),
    breakdowns: breakdownsOf(
      overallRecords,
      input.breakdownBy ?? DEFAULT_DIMENSIONS,
      (slice) => detectionToResolutionPoint(slice, input.window),
    ),
    computedAt: input.computedAt,
  };
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator <= 0 ? null : numerator / denominator;

/**
 * Whether this record's verification window is still open as of the report's
 * cutoff.
 *
 * Measured against `window.to` for every bucket, including buckets deep inside the
 * period: the question is whether the service has had time to see the evidence by
 * the moment the report was cut, not whether it had by the end of some Tuesday in
 * the middle of it.
 */
const awaitsVerification = (
  record: LoopOutcomeRecord,
  cutoff: Instant,
  rule: VerificationRule,
): boolean =>
  record.resolvedAt !== null &&
  record.verifiedAt === null &&
  record.terminal === null &&
  plus(record.resolvedAt, rule.withinMillis) > cutoff;

export function resolvedGapRatePoint(
  records: readonly LoopOutcomeRecord[],
  window: TimeWindow,
  cutoff: Instant,
  rule: VerificationRule,
): ResolvedGapRatePoint {
  const detectedGaps = records.length;
  const taskedGaps = records.filter((record) => record.taskId !== null).length;
  const resolvedGaps = records.filter((record) => record.resolvedAt !== null).length;
  const verifiedGaps = records.filter((record) => record.verifiedAt !== null).length;
  const selfResolvedGaps = records.filter(
    (record) => record.taskId === null && record.backInStockAt !== null,
  ).length;
  const awaitingVerification = records.filter((record) =>
    awaitsVerification(record, cutoff, rule),
  ).length;
  const unresolvedGaps = records.filter(
    (record) =>
      record.verifiedAt === null &&
      record.backInStockAt === null &&
      !awaitsVerification(record, cutoff, rule),
  ).length;

  return {
    window,
    detectedGaps,
    taskedGaps,
    resolvedGaps,
    verifiedGaps,
    selfResolvedGaps,
    unresolvedGaps,
    awaitingVerification,
    taskedGapRate: ratio(taskedGaps, detectedGaps),
    // Gaps whose verification window is still open leave the denominator entirely:
    // a gap detected an hour before the cutoff cannot have produced two clean
    // passes a day apart, and counting it as unresolved understates the rate.
    resolvedGapRate: ratio(verifiedGaps, detectedGaps - awaitingVerification),
  };
}

/** Share of detected gaps that reached a verified resolution, by department. */
export function computeResolvedGapRate(input: OutcomeMetricsInput): ResolvedGapRateReport {
  const rule = input.rule ?? STANDARD_VERIFICATION_RULE;
  const cutoff = input.window.to;
  const overallRecords = cohort(input, input.window);

  return {
    retailerId: input.retailerId,
    window: input.window,
    granularity: input.granularity,
    overall: resolvedGapRatePoint(overallRecords, input.window, cutoff, rule),
    series: bucketsFor(input.window, input.granularity).map((bucket) =>
      resolvedGapRatePoint(cohort(input, bucket), bucket, cutoff, rule),
    ),
    breakdowns: breakdownsOf(overallRecords, input.breakdownBy ?? DEFAULT_DIMENSIONS, (slice) =>
      resolvedGapRatePoint(slice, input.window, cutoff, rule),
    ),
    computedAt: input.computedAt,
  };
}

// ---------------------------------------------------------------------------
// Task work rate
// ---------------------------------------------------------------------------

/**
 * Task throughput for one bucket of the detection cohort.
 *
 * Cohorted by detection, exactly like the other two reports, and that is the
 * decision worth defending. Counting "tasks verified this week" against "tasks
 * created this week" is two populations and a completion rate that can exceed one
 * whenever a busy week follows a quiet one. Asking instead "of the gaps we found
 * in this bucket, how many got raised, worked and closed" gives a figure that
 * means something on its own and can be compared week to week.
 *
 * `outstanding` follows from that: cohort members that were tasked and have not
 * reached a terminal state — still open work from the gaps found in this bucket.
 */
export function taskWorkRatePoint(
  records: readonly LoopOutcomeRecord[],
  window: TimeWindow,
  labourHours: number | null,
): TaskWorkRatePoint {
  const created = records.filter((record) => record.taskCreatedAt !== null).length;
  const resolved = records.filter((record) => record.resolvedAt !== null).length;
  const verified = records.filter((record) => record.verifiedAt !== null).length;
  const reopened = records.reduce((total, record) => total + record.reopenCount, 0);

  return {
    window,
    created,
    assigned: records.filter((record) => record.assignedAt !== null).length,
    acknowledged: records.filter((record) => record.acknowledgedAt !== null).length,
    resolved,
    verified,
    reopened,
    cancelled: records.filter((record) => record.terminal === 'cancelled').length,
    expired: records.filter((record) => record.terminal === 'expired').length,
    outstanding: records.filter((record) => record.taskId !== null && record.terminal === null)
      .length,
    labourHours,
    // Zero labour hours is not a divide-by-zero to be defended against, it is a
    // store that reported no staff; the rate is undefined either way.
    tasksPerLabourHour: labourHours === null || labourHours <= 0 ? null : verified / labourHours,
    completionRate: ratio(verified, created),
    reworkRate: ratio(reopened, resolved),
  };
}

/**
 * Task throughput, completion and rework, with the per-labour-hour rate when the
 * retailer's workforce feed is connected.
 *
 * Breakdown slices carry `labourHours: null` on purpose: payroll arrives per
 * store and per period, not per department, and splitting it pro rata across
 * departments would manufacture a productivity figure for a team whose hours
 * nobody actually reported.
 */
export function computeTaskWorkRate(input: OutcomeMetricsInput): TaskWorkRateReport {
  const labourHoursFor = input.labourHoursFor ?? (() => null);
  const overallRecords = cohort(input, input.window);

  return {
    retailerId: input.retailerId,
    window: input.window,
    granularity: input.granularity,
    overall: taskWorkRatePoint(overallRecords, input.window, labourHoursFor(input.window)),
    series: bucketsFor(input.window, input.granularity).map((bucket) =>
      taskWorkRatePoint(cohort(input, bucket), bucket, labourHoursFor(bucket)),
    ),
    breakdowns: breakdownsOf(overallRecords, input.breakdownBy ?? DEFAULT_DIMENSIONS, (slice) =>
      taskWorkRatePoint(slice, input.window, null),
    ),
    computedAt: input.computedAt,
  };
}

export interface OutcomeMetrics {
  readonly taskWorkRate: TaskWorkRateReport;
  readonly detectionToResolution: DetectionToResolutionReport;
  readonly resolvedGapRate: ResolvedGapRateReport;
}

/**
 * Both outcome metrics over one set of records, in the shapes
 * `TaskPerformanceQueryPort` publishes — so the read side serves the same numbers
 * the loop produced rather than a second implementation of them.
 */
export const computeOutcomeMetrics = (input: OutcomeMetricsInput): OutcomeMetrics => ({
  taskWorkRate: computeTaskWorkRate(input),
  detectionToResolution: computeDetectionToResolution(input),
  resolvedGapRate: computeResolvedGapRate(input),
});
