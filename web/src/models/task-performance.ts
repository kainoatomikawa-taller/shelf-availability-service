import type { ReportEnvelope } from './scope';
import type { Millis, Ratio, TimeWindow } from './time';

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
   * Labour hours the retailer's workforce feed reported, or `null` when that
   * feed is not connected. The service does not estimate it, and neither does
   * the dashboard — a null renders as "no labour feed", never as zero.
   */
  readonly labourHours: number | null;
  /** `verified / labourHours`, or `null` without a labour feed. */
  readonly tasksPerLabourHour: number | null;
  /** `verified / created` — how much of what was raised actually got closed. */
  readonly completionRate: Ratio | null;
  /** `reopened / resolved` — how much reported work did not hold. */
  readonly reworkRate: Ratio | null;
}

export type TaskWorkRateReport = ReportEnvelope<TaskWorkRatePoint>;

// ---------------------------------------------------------------------------
// Resolved-gap rate
// ---------------------------------------------------------------------------

/**
 * How many detected gaps actually got closed.
 *
 * The denominator is the trap. A gap detected an hour before the window ends
 * cannot have completed a 24-hour verification, so counting it as unresolved
 * understates the rate: gaps still inside their verification window are reported
 * in `awaitingVerification` and excluded from `resolvedGapRate` entirely. Any
 * component showing this number must show `awaitingVerification` beside it, or
 * the exclusion becomes invisible and the figure looks inflated next to a
 * naively computed one.
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
  readonly taskedGapRate: Ratio | null;
  /** `verifiedGaps / (detectedGaps - awaitingVerification)`. `null` when the denominator is zero. */
  readonly resolvedGapRate: Ratio | null;
}

export type ResolvedGapRateReport = ReportEnvelope<ResolvedGapRatePoint>;

/** The denominator the rate was actually computed over, for the footnote beside it. */
export const resolvedGapRateDenominator = (point: ResolvedGapRatePoint): number =>
  Math.max(0, point.detectedGaps - point.awaitingVerification);

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

/** The stages of the closed loop, in the order a gap travels through them. */
export type LoopStage =
  | 'detectionToTask'
  | 'taskToAssignment'
  | 'assignmentToAcknowledgement'
  | 'acknowledgementToResolution'
  | 'resolutionToVerification';

export const LOOP_STAGES = [
  'detectionToTask',
  'taskToAssignment',
  'assignmentToAcknowledgement',
  'acknowledgementToResolution',
  'resolutionToVerification',
] as const satisfies readonly LoopStage[];

/**
 * Who owns each stage. This is the whole point of the stage split: a slow
 * end-to-end number is four different problems with four different owners, and a
 * dashboard that cannot attribute it just starts an argument.
 */
export const LOOP_STAGE_LABELS: Readonly<Record<LoopStage, string>> = {
  detectionToTask: 'Detection → task',
  taskToAssignment: 'Task → assignment',
  assignmentToAcknowledgement: 'Assignment → acknowledgement',
  acknowledgementToResolution: 'Acknowledgement → resolution',
  resolutionToVerification: 'Resolution → verification',
};

export const LOOP_STAGE_OWNERS: Readonly<Record<LoopStage, string>> = {
  detectionToTask: 'Detection pipeline',
  taskToAssignment: 'Dispatch',
  assignmentToAcknowledgement: 'Store team',
  acknowledgementToResolution: 'Store team',
  resolutionToVerification: 'Shelf coverage',
};

/** Stage-by-stage latency through the closed loop. */
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

export type DetectionToResolutionReport = ReportEnvelope<DetectionToResolutionPoint>;

/**
 * The stage contributing the most p50 latency.
 *
 * `null` when no stage has a p50 — a window with no completed loops has nothing
 * to attribute, and guessing at one would point a store manager at an innocent
 * team.
 */
export const slowestStage = (
  point: DetectionToResolutionPoint,
): { readonly stage: LoopStage; readonly p50: Millis } | null =>
  LOOP_STAGES.reduce<{ readonly stage: LoopStage; readonly p50: Millis } | null>((worst, stage) => {
    const p50 = point[stage].p50;
    if (p50 === null) return worst;
    return worst === null || p50 > worst.p50 ? { stage, p50 } : worst;
  }, null);
