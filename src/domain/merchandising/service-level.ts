import { STANDARD_VERIFICATION_RULE } from '../availability/verification.js';
import { DAY } from '../common/time.js';
import type { CategoryCoverage, PassesPerFacingPerDay } from './revisit-density.js';
import { passesPerFacingPerDay } from './revisit-density.js';

/**
 * The fixed floor a department/category must clear to carry a service-level
 * commitment: **two passes per facing per day**.
 *
 * Not a tuning knob, and deliberately not part of any retailer-supplied policy —
 * it is derived from what the closed loop physically needs. The verification rule
 * closes a task on two consecutive clean passes within 24 hours, so a category
 * whose facings are passed fewer than twice a day cannot, on average, produce the
 * evidence that closes a single task inside a day. Committing to a service level
 * there would be selling a loop that cannot close.
 *
 * Anything below the floor is still detected, still ranked and still worked — it
 * is excluded from the *commitment*, not from the service.
 */
export const MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL: PassesPerFacingPerDay = passesPerFacingPerDay(
  STANDARD_VERIFICATION_RULE.requiredConsecutiveCleanPasses /
    (STANDARD_VERIFICATION_RULE.withinMillis / DAY),
);

/**
 * Whether a category is inside service-level scope, and why not when it is not.
 *
 * `unmeasured` is kept distinct from `below_revisit_threshold`: a category with
 * no facings or a zero-length window has not failed the bar, it has not been
 * weighed against it, and a retailer reading the exclusion list needs to know
 * which of those happened.
 */
export type ServiceLevelScope =
  | { readonly inScope: true; readonly density: PassesPerFacingPerDay }
  | {
      readonly inScope: false;
      readonly reason: 'below_revisit_threshold';
      readonly density: PassesPerFacingPerDay;
      readonly required: PassesPerFacingPerDay;
    }
  | {
      readonly inScope: false;
      readonly reason: 'unmeasured';
      readonly density: null;
      readonly required: PassesPerFacingPerDay;
    };

/**
 * Applies the fixed floor to one category's measured coverage.
 *
 * `null` coverage — no measurement for the category at all — is treated the same
 * as an unmeasured measurement: out of scope, reason `unmeasured`. Absence of
 * evidence must never read as qualification.
 */
export function evaluateServiceLevelScope(
  coverage: CategoryCoverage | null,
  threshold: PassesPerFacingPerDay = MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL,
): ServiceLevelScope {
  const density = coverage?.density ?? null;

  if (density === null) {
    return { inScope: false, reason: 'unmeasured', density: null, required: threshold };
  }
  if (density < threshold) {
    return { inScope: false, reason: 'below_revisit_threshold', density, required: threshold };
  }
  return { inScope: true, density };
}

/** Categories that clear the floor, for publishing the scope of a commitment. */
export const categoriesInServiceLevelScope = (
  coverages: readonly CategoryCoverage[],
  threshold: PassesPerFacingPerDay = MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL,
): readonly CategoryCoverage[] =>
  coverages.filter((coverage) => evaluateServiceLevelScope(coverage, threshold).inScope);
