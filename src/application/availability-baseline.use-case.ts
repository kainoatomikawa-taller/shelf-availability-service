import type { DepartmentId, RetailerId } from '../domain/common/ids.js';
import { assertSameRetailer, type RetailerPartitioned } from '../domain/common/partition.js';
import { WEEK, windowDuration, type Instant, type Millis, type TimeWindow } from '../domain/common/time.js';
import {
  computeAvailabilityIndex,
  timelineFor,
  type AvailabilityIndex,
  type FacingTimeline,
} from '../domain/availability/availability-index.js';
import type { Facing } from '../domain/facing/facing.js';
import type { MerchandisingClassification } from '../domain/merchandising/classification.js';
import type { AvailabilityIndexPoint } from '../ports/inbound/reporting.port.js';

/**
 * Establishing a retailer's prior baseline.
 *
 * Everything this service claims later — availability lifted by so many points,
 * so many gaps closed — is a comparison against a number measured before the loop
 * was closed. That makes the baseline the most load-bearing figure in the product
 * and the easiest one to quietly get wrong, so it is computed by the same
 * `computeAvailabilityIndex` the live index uses, on the same facing-time in-stock
 * definition, and it refuses to call itself established when the measurement
 * behind it cannot carry the claim.
 *
 *   index = Σ in-stock facing-time / Σ measured facing-time
 *
 * Facing-time, not facing-count, and unknown time excluded from both sides — a
 * baseline computed while half the estate's cameras were dark is not a low
 * baseline, it is an unmeasured one, and the difference is the whole argument
 * about whether the service worked.
 */

/** A facing plus the classification the baseline is cut by. */
export interface BaselineFacing {
  readonly facing: Facing;
  readonly classification: MerchandisingClassification;
}

export interface BaselinePolicy {
  /**
   * Share of the baseline window that must be measured (in stock or out of it)
   * across the estate.
   *
   * Below half, the time nobody could see is larger than the time anybody could,
   * and the unmeasured majority can move the true index further than any
   * improvement the service would go on to claim.
   */
  readonly minCoverage: number;
  /**
   * Shortest window a baseline can be drawn from. A full trading week, because
   * availability has a weekday/weekend shape and any shorter window bakes one part
   * of that shape into the number the retailer is later measured against.
   */
  readonly minWindowMillis: Millis;
  /** Fewest facings a baseline can be drawn from. */
  readonly minFacings: number;
}

export const STANDARD_BASELINE_POLICY: BaselinePolicy = {
  minCoverage: 0.5,
  minWindowMillis: WEEK,
  minFacings: 1,
};

export type BaselineShortfall =
  | 'window_too_short'
  | 'too_few_facings'
  | 'nothing_measured'
  | 'insufficient_coverage';

/**
 * Whether the baseline can carry a claim, and what is missing when it cannot.
 *
 * A provisional baseline is still returned with its index intact. Withholding the
 * number would just mean somebody computes it in a spreadsheet without the
 * qualifier attached; publishing it with the shortfalls named keeps the caveat
 * travelling with the figure.
 */
export type BaselineStatus =
  | { readonly established: true }
  | { readonly established: false; readonly shortfalls: readonly BaselineShortfall[] };

export interface DepartmentBaseline {
  readonly departmentId: DepartmentId;
  readonly point: AvailabilityIndexPoint;
}

export interface RetailerAvailabilityBaseline extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  /** The pre-service window the prior was measured over. */
  readonly window: TimeWindow;
  readonly status: BaselineStatus;
  /** The whole estate as one figure — the prior itself. */
  readonly overall: AvailabilityIndexPoint;
  readonly byDepartment: readonly DepartmentBaseline[];
  /** The domain result the point was projected from, for drill-down. */
  readonly index: AvailabilityIndex;
  readonly establishedAt: Instant;
  readonly policy: BaselinePolicy;
}

/** Projects a computed index onto the reporting port's published point shape. */
export const baselinePoint = (index: AvailabilityIndex): AvailabilityIndexPoint => ({
  window: index.window,
  index: index.index,
  coverage: index.coverage,
  inStockFacingMillis: index.inStockFacingMillis,
  measuredFacingMillis: index.measuredFacingMillis,
  unknownFacingMillis: index.unknownFacingMillis,
  facingCount: index.facingCount,
});

export interface EstablishBaselineRequest {
  /** Partition key. A baseline is always *a retailer's* baseline. */
  readonly retailerId: RetailerId;
  readonly window: TimeWindow;
  readonly facings: readonly BaselineFacing[];
  readonly establishedAt: Instant;
  readonly policy?: BaselinePolicy;
}

const statusOf = (
  index: AvailabilityIndex,
  window: TimeWindow,
  policy: BaselinePolicy,
): BaselineStatus => {
  const shortfalls: BaselineShortfall[] = [];

  if (windowDuration(window) < policy.minWindowMillis) shortfalls.push('window_too_short');
  if (index.facingCount < policy.minFacings) shortfalls.push('too_few_facings');
  if (index.index === null) shortfalls.push('nothing_measured');
  else if (index.coverage < policy.minCoverage) shortfalls.push('insufficient_coverage');

  return shortfalls.length === 0 ? { established: true } : { established: false, shortfalls };
};

/**
 * Computes the retailer's prior baseline over a window, overall and by department.
 *
 * Pure: the facings and the window come in, the prior goes out, so re-establishing
 * a baseline against a corrected history is a re-run rather than an argument.
 */
export function establishAvailabilityBaseline(
  request: EstablishBaselineRequest,
): RetailerAvailabilityBaseline {
  const { retailerId, window } = request;
  const policy = request.policy ?? STANDARD_BASELINE_POLICY;

  const timelines: FacingTimeline[] = [];
  const byDepartment = new Map<DepartmentId, FacingTimeline[]>();

  for (const { facing, classification } of request.facings) {
    assertSameRetailer(retailerId, facing, 'establishAvailabilityBaseline');
    const timeline = timelineFor(facing, window);
    timelines.push(timeline);

    const existing = byDepartment.get(classification.departmentId);
    if (existing === undefined) byDepartment.set(classification.departmentId, [timeline]);
    else existing.push(timeline);
  }

  const index = computeAvailabilityIndex(retailerId, timelines, window);

  return {
    retailerId,
    window,
    status: statusOf(index, window, policy),
    overall: baselinePoint(index),
    byDepartment: [...byDepartment.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([departmentId, members]) => ({
        departmentId,
        point: baselinePoint(computeAvailabilityIndex(retailerId, members, window)),
      })),
    index,
    establishedAt: request.establishedAt,
    policy,
  };
}

/**
 * How far a measured index sits above or below the prior.
 *
 * `comparable` is false whenever the baseline was never established or either side
 * measured nothing — a lift computed against a provisional prior is a number with
 * no claim behind it, and the caller must be able to tell the two apart without
 * reading the baseline's status itself.
 */
export interface BaselineComparison {
  readonly baseline: number | null;
  readonly current: number | null;
  /** `current - baseline`, in index points (0..1), or `null` when not comparable. */
  readonly delta: number | null;
  /** `delta / baseline`, or `null` when the baseline is zero or not comparable. */
  readonly relativeLift: number | null;
  readonly comparable: boolean;
}

export function compareToBaseline(
  baseline: RetailerAvailabilityBaseline,
  current: AvailabilityIndex,
): BaselineComparison {
  assertSameRetailer(baseline.retailerId, current, 'compareToBaseline');

  const prior = baseline.overall.index;
  const measured = current.index;
  const comparable = baseline.status.established && prior !== null && measured !== null;

  if (!comparable || prior === null || measured === null) {
    return { baseline: prior, current: measured, delta: null, relativeLift: null, comparable: false };
  }

  return {
    baseline: prior,
    current: measured,
    delta: measured - prior,
    relativeLift: prior === 0 ? null : (measured - prior) / prior,
    comparable: true,
  };
}
