import type { FacingId, RetailerId } from '../domain/common/ids.js';
import { assertSinglePartition } from '../domain/common/partition.js';
import type { TimeWindow } from '../domain/common/time.js';
import type { DetectedGap } from '../domain/gap/gap.js';
import {
  rankGaps,
  rankedByDepartment,
  type DepartmentRanking,
  type GapRankingPolicy,
  type RankedGap,
} from '../domain/gap/ranking.js';
import type {
  CategoryCoverage,
  ClassifiedFacing,
  FacingPass,
  PassesPerFacingPerDay,
} from '../domain/merchandising/revisit-density.js';
import { measureCategoryCoverage } from '../domain/merchandising/revisit-density.js';
import type { SalesVelocity } from '../domain/merchandising/sales-velocity.js';
import { categoriesInServiceLevelScope } from '../domain/merchandising/service-level.js';

/**
 * Ranking a store's open gaps for the people who will work them.
 *
 * Revisit density is measured here from the pass stream rather than accepted as
 * an input, which is the point of the use case: the service-level scope a
 * retailer is held to has to follow from traffic that actually happened, not from
 * a number somebody typed into a configuration table and never revisited.
 */
export interface RankGapsRequest {
  /** Partition key. One retailer per ranking — there is no pooled worklist. */
  readonly retailerId: RetailerId;
  /** Half-open window the coverage is measured over. */
  readonly window: TimeWindow;
  readonly gaps: readonly DetectedGap[];
  /** Every facing in the categories under consideration, passed or not. */
  readonly facings: readonly ClassifiedFacing[];
  /** Looks at facings recorded over the window, from the ingested detection stream. */
  readonly passes: readonly FacingPass[];
  /** Measured units/day per facing. A facing absent here has an unknown velocity. */
  readonly salesVelocities: ReadonlyMap<FacingId, SalesVelocity>;
  readonly policy?: GapRankingPolicy;
  /** Overrides the fixed service-level floor. For back-testing the threshold only. */
  readonly threshold?: PassesPerFacingPerDay;
}

export interface RankGapsResult {
  readonly retailerId: RetailerId;
  readonly window: TimeWindow;
  /** Gaps inside service-level scope, best first. */
  readonly committed: readonly RankedGap[];
  /** Gaps whose category falls below the revisit-density floor, best first. */
  readonly excluded: readonly RankedGap[];
  /** The committed list re-cut per department, for a department manager's view. */
  readonly byDepartment: readonly DepartmentRanking[];
  /** Measured coverage per store + category, including categories with no gaps. */
  readonly coverage: readonly CategoryCoverage[];
  /** The subset of `coverage` that qualifies for a service-level commitment. */
  readonly inServiceLevelScope: readonly CategoryCoverage[];
}

/**
 * Measures revisit density, applies the service-level floor, and ranks what is
 * left by department, sales velocity and that density.
 *
 * Pure orchestration over the domain: no clock and no IO, so the same call ranks
 * a live store, replays last Tuesday, or back-tests a different threshold.
 */
export function rankGapsForWindow(request: RankGapsRequest): RankGapsResult {
  const { retailerId, window } = request;

  assertSinglePartition(retailerId, request.gaps, 'rankGapsForWindow');

  const coverage = measureCategoryCoverage({
    retailerId,
    window,
    facings: request.facings,
    passes: request.passes,
  });

  const ranking = rankGaps({
    retailerId,
    coverage,
    gaps: request.gaps.map((gap) => ({
      gap,
      salesVelocity: request.salesVelocities.get(gap.facingId) ?? null,
    })),
    ...(request.policy === undefined ? {} : { policy: request.policy }),
    ...(request.threshold === undefined ? {} : { threshold: request.threshold }),
  });

  return {
    retailerId,
    window,
    committed: ranking.committed,
    excluded: ranking.excluded,
    byDepartment: rankedByDepartment(ranking.committed),
    coverage,
    ...(request.threshold === undefined
      ? { inServiceLevelScope: categoriesInServiceLevelScope(coverage) }
      : { inServiceLevelScope: categoriesInServiceLevelScope(coverage, request.threshold) }),
  };
}
