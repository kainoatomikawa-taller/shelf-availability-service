import type { CategoryId, DepartmentId, StoreId } from './ids';
import type { Instant, Millis, Ratio, TimeWindow } from './time';

/**
 * Whether a category carries a service-level commitment, and why not when it
 * does not.
 *
 * `unmeasured` is kept distinct from `below_revisit_threshold`: a category with
 * no facings or no measured time has not failed the bar, it has not been weighed
 * against it. A departmental table that collapses the two tells a buyer their
 * shelf was judged and found wanting when in fact nobody looked.
 */
export type ServiceLevelScope =
  | { readonly inScope: true; readonly density: number }
  | {
      readonly inScope: false;
      readonly reason: 'below_revisit_threshold';
      readonly density: number;
      readonly required: number;
    }
  | {
      readonly inScope: false;
      readonly reason: 'unmeasured';
      readonly density: null;
      readonly required: number;
    };

export const SERVICE_LEVEL_EXCLUSION_LABELS: Readonly<
  Record<'below_revisit_threshold' | 'unmeasured', string>
> = {
  below_revisit_threshold: 'Below revisit threshold',
  unmeasured: 'Not measured',
};

/**
 * One department's outcome over the report window.
 *
 * This is the row a store manager reads: the department cut exists precisely
 * because a category tells a buyer which shelf is failing while a department
 * tells a manager whose staff to move, and outcome metrics are read by the
 * second far more often than the first.
 *
 * Each figure is nullable independently. A department can have a measured
 * availability index and no resolved-gap rate at all (nothing was detected), and
 * flattening those to zero would invent a failure.
 */
export interface DepartmentalOutcome {
  readonly departmentId: DepartmentId;
  readonly departmentName: string;
  /** `null` for a chain-wide row; set when the outcome is cut per store. */
  readonly storeId: StoreId | null;
  readonly window: TimeWindow;

  readonly availabilityIndex: Ratio | null;
  readonly coverage: Ratio;
  readonly facingCount: number;
  /** Change in the index against the prior equivalent window. `null` without a baseline. */
  readonly availabilityIndexDelta: number | null;

  readonly detectedGaps: number;
  readonly resolvedGapRate: Ratio | null;
  /** Gaps excluded from the rate because their verification window is still open. */
  readonly awaitingVerification: number;

  readonly tasksCreated: number;
  readonly tasksVerified: number;
  readonly tasksOutstanding: number;
  readonly tasksPerLabourHour: number | null;
  readonly reworkRate: Ratio | null;

  /** End-to-end p50, detection to verified. */
  readonly medianDetectionToVerification: Millis | null;

  readonly serviceLevel: ServiceLevelScope;
  readonly computedAt: Instant;
}

/** One category inside a department — the buyer's drill-down. */
export interface CategoryOutcome {
  readonly categoryId: CategoryId;
  readonly categoryName: string;
  readonly departmentId: DepartmentId;
  readonly availabilityIndex: Ratio | null;
  readonly coverage: Ratio;
  readonly detectedGaps: number;
  readonly resolvedGapRate: Ratio | null;
  readonly serviceLevel: ServiceLevelScope;
}

export const departmentalOutcomeKey = (outcome: DepartmentalOutcome): string =>
  outcome.storeId === null
    ? outcome.departmentId
    : `${outcome.storeId}/${outcome.departmentId}`;

export const categoryOutcomeKey = (outcome: CategoryOutcome): string => outcome.categoryId;

/**
 * Departments worst-first, with unmeasured rows last.
 *
 * A department with no index is not "the worst" — it is unranked, and floating
 * it to the top of a worst-first table would send someone to a shelf nobody has
 * evidence about.
 */
export const compareOutcomesByIndex = (a: DepartmentalOutcome, b: DepartmentalOutcome): number => {
  if (a.availabilityIndex === null && b.availabilityIndex === null) return 0;
  if (a.availabilityIndex === null) return 1;
  if (b.availabilityIndex === null) return -1;
  return a.availabilityIndex - b.availabilityIndex;
};

/** Departments carrying a commitment, which is the set the outcome targets apply to. */
export const inServiceLevelScope = (
  outcomes: readonly DepartmentalOutcome[],
): readonly DepartmentalOutcome[] => outcomes.filter((outcome) => outcome.serviceLevel.inScope);
