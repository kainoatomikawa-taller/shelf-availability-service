import type { DepartmentId, RetailerId } from '../common/ids.js';
import { assertSameRetailer } from '../common/partition.js';
import { categoryScopeKey } from '../merchandising/classification.js';
import type { CategoryCoverage, PassesPerFacingPerDay } from '../merchandising/revisit-density.js';
import { indexCoverage } from '../merchandising/revisit-density.js';
import type { SalesVelocity } from '../merchandising/sales-velocity.js';
import { ZERO_VELOCITY } from '../merchandising/sales-velocity.js';
import {
  MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL,
  evaluateServiceLevelScope,
  type ServiceLevelScope,
} from '../merchandising/service-level.js';
import { gapKindOf, type DetectedGap, type GapKind } from './gap.js';

/**
 * The tunable half of the ranking.
 *
 * Department weights are configuration with a neutral default because the
 * platform does not own the retailer's taxonomy: one banner's "fresh" is another
 * banner's four departments, and a shipped table of names would be wrong
 * everywhere it was not written. What the platform does own is the *shape* — a
 * weight per department, applied the same way for everyone.
 */
export interface GapRankingPolicy {
  /** Per-department multiplier. A banner that loses margin fastest in fresh sets it highest. */
  readonly departmentWeights: ReadonlyMap<DepartmentId, number>;
  /** Applied to a department the retailer has not weighted. Neutral, never zero. */
  readonly defaultDepartmentWeight: number;
  /** Relative pull of each kind of gap at equal velocity and coverage. */
  readonly kindWeights: Readonly<Record<GapKind, number>>;
  /**
   * Velocity assumed when the POS feed has said nothing about this facing.
   *
   * Zero by default, matching the same refusal to invent numbers that keeps
   * `labourHours` nullable in the reporting port: an unknown-velocity gap sinks
   * to the bottom of the list and is visibly flagged `assumed`, rather than being
   * silently handed a plausible-looking rate nobody measured.
   */
  readonly assumedSalesVelocityWhenUnknown: SalesVelocity;
}

export const STANDARD_GAP_RANKING_POLICY: GapRankingPolicy = {
  departmentWeights: new Map(),
  defaultDepartmentWeight: 1,
  kindWeights: {
    // An empty shelf is a lost sale every time somebody reaches for it. A wrong
    // price is a trust and compliance problem that costs on a slower clock, and
    // drift is the slowest of the three — it degrades the shelf rather than
    // emptying it.
    availability_gap: 1,
    price_mismatch: 0.6,
    planogram_drift: 0.4,
  },
  assumedSalesVelocityWhenUnknown: ZERO_VELOCITY,
};

/** One gap plus everything the ranking needs to know about it. */
export interface GapRankingInput {
  readonly gap: DetectedGap;
  /** Measured units/day at this facing, or `null` when the POS feed is silent. */
  readonly salesVelocity: SalesVelocity | null;
}

/** Every factor that produced a score, kept so a ranking can be argued with. */
export interface GapScoreComponents {
  readonly departmentId: DepartmentId;
  readonly departmentWeight: number;
  readonly kind: GapKind;
  readonly kindWeight: number;
  readonly salesVelocity: SalesVelocity;
  /** Whether the velocity was measured or fell back to the policy's assumption. */
  readonly velocityBasis: 'measured' | 'assumed';
  readonly revisitDensity: PassesPerFacingPerDay | null;
  /** `density / (density + threshold)` — see `evidenceFactor`. */
  readonly evidenceFactor: number;
}

export interface RankedGap {
  readonly gap: DetectedGap;
  /** 1-based position within the list this gap was returned in. */
  readonly rank: number;
  readonly score: number;
  readonly components: GapScoreComponents;
  readonly serviceLevel: ServiceLevelScope;
}

export interface DepartmentRanking {
  readonly departmentId: DepartmentId;
  readonly gaps: readonly RankedGap[];
}

/**
 * How much the measured revisit density lets us stand behind this gap.
 *
 *   evidenceFactor = density / (density + threshold)
 *
 * Saturating and monotonic: zero coverage contributes nothing, a category sitting
 * exactly on the service-level floor scores 0.5, and a category swept six times a
 * day scores 0.75. It never reaches 1, so no amount of camera traffic lets a slow
 * seller outrank a fast one on coverage alone — density adjusts confidence in the
 * gap, it does not manufacture demand.
 *
 * Why density belongs in the score at all: the gap has already been detected, so
 * density is not about finding it. It is how fresh the evidence is and how fast
 * the loop can close. A void in a category passed twelve times a day was seen
 * within the hour and will be re-verified within the hour; the same void in a
 * category passed twice a day may have been fixed six hours ago by a shopper, and
 * dispatching an employee to it is a coin flip.
 */
export const evidenceFactor = (
  density: PassesPerFacingPerDay | null,
  threshold: PassesPerFacingPerDay = MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL,
): number => {
  if (density === null || density === 0) return 0;
  return density / (density + threshold);
};

export interface RankGapsInput {
  readonly retailerId: RetailerId;
  readonly gaps: readonly GapRankingInput[];
  /** Measured coverage per store + category. Anything unlisted counts as unmeasured. */
  readonly coverage: readonly CategoryCoverage[];
  readonly policy?: GapRankingPolicy;
  readonly threshold?: PassesPerFacingPerDay;
}

export interface GapRanking {
  readonly retailerId: RetailerId;
  /** Gaps in categories that clear the revisit-density floor, best first. */
  readonly committed: readonly RankedGap[];
  /**
   * Gaps in categories below the floor, best first among themselves.
   *
   * Returned rather than dropped: the work is still real, it is the *commitment*
   * that is off. A retailer reading only `committed` is reading the service level;
   * one reading both is reading the store.
   */
  readonly excluded: readonly RankedGap[];
}

const score = (components: GapScoreComponents): number =>
  components.departmentWeight *
  components.kindWeight *
  components.salesVelocity *
  components.evidenceFactor;

/**
 * Orders gaps within one list.
 *
 * Score first, then the older gap — a shelf that has been empty since opening
 * beats one that emptied a minute ago at the same score — then gap id, so the
 * order is total and a re-run never reshuffles the list under a picker's hands.
 */
const byPriority = (a: RankedGap, b: RankedGap): number => {
  if (a.score !== b.score) return b.score - a.score;
  if (a.gap.detectedAt !== b.gap.detectedAt) return a.gap.detectedAt - b.gap.detectedAt;
  return a.gap.gapId.localeCompare(b.gap.gapId);
};

const numbered = (gaps: readonly RankedGap[]): readonly RankedGap[] =>
  [...gaps].sort(byPriority).map((ranked, index) => ({ ...ranked, rank: index + 1 }));

/**
 * Ranks detected gaps by department, sales velocity and measured revisit density,
 * and splits off the categories that do not qualify for a service-level
 * commitment.
 *
 *   score = departmentWeight x kindWeight x salesVelocityUnitsPerDay x evidenceFactor
 *
 * Every term is reported back in `components`, because a store manager who
 * disagrees with the order needs to see which factor put a gap where it is —
 * a ranking nobody can argue with is a ranking nobody trusts.
 *
 * Pure and single-partition: gaps from another retailer are rejected rather than
 * pooled into one list.
 */
export function rankGaps(input: RankGapsInput): GapRanking {
  const policy = input.policy ?? STANDARD_GAP_RANKING_POLICY;
  const threshold = input.threshold ?? MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL;
  const coverageByScope = indexCoverage(input.coverage);

  const committed: RankedGap[] = [];
  const excluded: RankedGap[] = [];

  for (const { gap, salesVelocity } of input.gaps) {
    assertSameRetailer(input.retailerId, gap, 'rankGaps');

    const coverage = coverageByScope.get(categoryScopeKey(gap.storeId, gap.classification)) ?? null;
    const serviceLevel = evaluateServiceLevelScope(coverage, threshold);
    const departmentId = gap.classification.departmentId;
    const kind = gapKindOf(gap);

    const components: GapScoreComponents = {
      departmentId,
      departmentWeight:
        policy.departmentWeights.get(departmentId) ?? policy.defaultDepartmentWeight,
      kind,
      kindWeight: policy.kindWeights[kind],
      salesVelocity: salesVelocity ?? policy.assumedSalesVelocityWhenUnknown,
      velocityBasis: salesVelocity === null ? 'assumed' : 'measured',
      revisitDensity: coverage?.density ?? null,
      evidenceFactor: evidenceFactor(coverage?.density ?? null, threshold),
    };

    // `rank` is assigned once the list is sorted; 0 is a placeholder that never
    // escapes this function.
    const ranked: RankedGap = { gap, rank: 0, score: score(components), components, serviceLevel };
    (serviceLevel.inScope ? committed : excluded).push(ranked);
  }

  return {
    retailerId: input.retailerId,
    committed: numbered(committed),
    excluded: numbered(excluded),
  };
}

/**
 * Re-cuts a ranked list by department, each department's gaps re-ranked within
 * it, departments ordered by their top gap's score.
 *
 * The flat list is what a picker works; this is what a department manager reads.
 */
export function rankedByDepartment(gaps: readonly RankedGap[]): readonly DepartmentRanking[] {
  const grouped = new Map<DepartmentId, RankedGap[]>();

  for (const ranked of gaps) {
    const existing = grouped.get(ranked.components.departmentId);
    if (existing === undefined) {
      grouped.set(ranked.components.departmentId, [ranked]);
    } else {
      existing.push(ranked);
    }
  }

  return [...grouped.entries()]
    .map(([departmentId, members]) => ({ departmentId, gaps: numbered(members) }))
    .sort((a, b) => {
      const top = (ranking: DepartmentRanking): number => ranking.gaps[0]?.score ?? 0;
      const diff = top(b) - top(a);
      return diff !== 0 ? diff : a.departmentId.localeCompare(b.departmentId);
    });
}
