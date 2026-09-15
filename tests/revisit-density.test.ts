import { describe, expect, it } from 'vitest';
import {
  CrossRetailerAccessError,
  DAY,
  MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL,
  STANDARD_VERIFICATION_RULE,
  categoriesInServiceLevelScope,
  evaluateServiceLevelScope,
  indexCoverage,
  categoryScopeKey,
  measureCategoryCoverage,
  millis,
  plus,
  passesPerFacingPerDay,
  revisitDensity,
  salesVelocityFromPos,
  timeWindow,
  type CategoryCoverage,
  type MerchandisingClassification,
} from '../src/index.js';
import {
  ACME,
  CEREAL_GROCERY,
  DAIRY_FRESH,
  RIVAL,
  classified,
  classifiedFacings,
  facingPass,
  hour,
  passesOver,
  posMovement,
} from './support/fixtures.js';

const DAY_WINDOW = timeWindow(hour(0), hour(24));

const coverageFor = (
  coverages: readonly CategoryCoverage[],
  classification: MerchandisingClassification,
): CategoryCoverage => {
  const found = coverages.find(
    (coverage) => coverage.classification.categoryId === classification.categoryId,
  );
  if (found === undefined) throw new Error('expected coverage for category');
  return found;
};

describe('revisit density — passes per facing per day', () => {
  it('normalises by both the facing count and the length of the window', () => {
    // 40 passes over 10 facings in a day is 4; the same 40 over two days is 2.
    expect(revisitDensity(40, 10, DAY_WINDOW)).toBe(4);
    expect(revisitDensity(40, 10, timeWindow(hour(0), plus(hour(0), millis(2 * DAY))))).toBe(2);
  });

  it('is null rather than zero when there is nothing to divide by', () => {
    expect(revisitDensity(0, 0, DAY_WINDOW)).toBeNull();
    expect(revisitDensity(4, 10, timeWindow(hour(6), hour(6)))).toBeNull();
  });

  it('divides by every facing in the category, not just the ones that were passed', () => {
    // The failure this guards against: one facing of four swept twelve times a
    // day looks like a category with 12 passes/facing/day if the denominator is
    // "facings we saw", and like the 3 it really is if it is "facings there are".
    const coverage = measureCategoryCoverage({
      retailerId: ACME,
      window: DAY_WINDOW,
      facings: classifiedFacings('dairy', 4, DAIRY_FRESH),
      passes: passesOver('dairy-0', 12, hour(0)),
    });

    const dairy = coverageFor(coverage, DAIRY_FRESH);
    expect(dairy.facingCount).toBe(4);
    expect(dairy.facingsPassed).toBe(1);
    expect(dairy.density).toBe(3);
  });

  it('measures each category in a store separately', () => {
    const coverage = measureCategoryCoverage({
      retailerId: ACME,
      window: DAY_WINDOW,
      facings: [
        ...classifiedFacings('dairy', 2, DAIRY_FRESH),
        ...classifiedFacings('cereal', 2, CEREAL_GROCERY),
      ],
      passes: [...passesOver('dairy-0', 6, hour(0)), ...passesOver('cereal-1', 2, hour(0))],
    });

    expect(coverage).toHaveLength(2);
    expect(coverageFor(coverage, DAIRY_FRESH).density).toBe(3);
    expect(coverageFor(coverage, CEREAL_GROCERY).density).toBe(1);
  });

  it('counts only passes inside the half-open window', () => {
    const coverage = measureCategoryCoverage({
      retailerId: ACME,
      window: DAY_WINDOW,
      facings: classifiedFacings('dairy', 1, DAIRY_FRESH),
      passes: [
        facingPass('dairy-0', hour(0)), // the window's first instant: counted
        facingPass('dairy-0', hour(12)),
        facingPass('dairy-0', hour(24)), // the window's end: belongs to the next one
      ],
    });

    expect(coverageFor(coverage, DAIRY_FRESH).passCount).toBe(2);
  });

  it('ignores passes for facings it cannot attribute to a category', () => {
    const coverage = measureCategoryCoverage({
      retailerId: ACME,
      window: DAY_WINDOW,
      facings: classifiedFacings('dairy', 2, DAIRY_FRESH),
      passes: [...passesOver('dairy-0', 4, hour(0)), ...passesOver('unlisted', 20, hour(0))],
    });

    // Attributing the unclassifiable passes to dairy would have inflated exactly
    // the number the retailer is held to.
    expect(coverageFor(coverage, DAIRY_FRESH).passCount).toBe(4);
    expect(coverageFor(coverage, DAIRY_FRESH).density).toBe(2);
  });

  it('refuses to pool another retailer into the measurement', () => {
    expect(() =>
      measureCategoryCoverage({
        retailerId: ACME,
        window: DAY_WINDOW,
        facings: [{ ...classified('dairy-0', DAIRY_FRESH), retailerId: RIVAL }],
        passes: [],
      }),
    ).toThrow(CrossRetailerAccessError);

    expect(() =>
      measureCategoryCoverage({
        retailerId: ACME,
        window: DAY_WINDOW,
        facings: classifiedFacings('dairy', 1, DAIRY_FRESH),
        passes: [{ ...facingPass('dairy-0', hour(1)), retailerId: RIVAL }],
      }),
    ).toThrow(CrossRetailerAccessError);
  });

  it('indexes coverage by store and category for per-gap lookup', () => {
    const coverage = measureCategoryCoverage({
      retailerId: ACME,
      window: DAY_WINDOW,
      facings: classifiedFacings('dairy', 1, DAIRY_FRESH),
      passes: passesOver('dairy-0', 3, hour(0)),
    });
    const indexed = indexCoverage(coverage);

    expect(indexed.get(categoryScopeKey(coverage[0]!.storeId, DAIRY_FRESH))?.density).toBe(3);
    expect(indexed.get(categoryScopeKey(coverage[0]!.storeId, CEREAL_GROCERY))).toBeUndefined();
  });
});

describe('service-level scope — the fixed revisit-density floor', () => {
  it('is fixed at what the verification rule needs to close a loop in a day', () => {
    // Two clean passes within 24h is the rule; a category passed less than twice
    // a day cannot, on average, produce that evidence inside a day.
    expect(MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL).toBe(2);

    // The property that matters, whatever the rule is tuned to: a category
    // sitting exactly on the floor still sees each facing enough times inside the
    // verification window to produce the passes that close a task.
    const passesInsideRuleWindow =
      MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL * (STANDARD_VERIFICATION_RULE.withinMillis / DAY);
    expect(passesInsideRuleWindow).toBeGreaterThanOrEqual(
      STANDARD_VERIFICATION_RULE.requiredConsecutiveCleanPasses,
    );
  });

  const categoryPassed = (passes: number, facings: number): CategoryCoverage =>
    coverageFor(
      measureCategoryCoverage({
        retailerId: ACME,
        window: DAY_WINDOW,
        facings: classifiedFacings('dairy', facings, DAIRY_FRESH),
        passes: passesOver('dairy-0', passes, hour(0), 60 * 1000),
      }),
      DAIRY_FRESH,
    );

  it('admits a category that meets the floor', () => {
    expect(evaluateServiceLevelScope(categoryPassed(8, 4))).toEqual({
      inScope: true,
      density: passesPerFacingPerDay(2),
    });
  });

  it('excludes a category below the floor, saying what it managed and what was needed', () => {
    expect(evaluateServiceLevelScope(categoryPassed(6, 4))).toEqual({
      inScope: false,
      reason: 'below_revisit_threshold',
      density: passesPerFacingPerDay(1.5),
      required: MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL,
    });
  });

  it('separates "not measured" from "measured and too sparse"', () => {
    expect(evaluateServiceLevelScope(null)).toEqual({
      inScope: false,
      reason: 'unmeasured',
      density: null,
      required: MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL,
    });

    // A category with no facings has not failed the bar, it was never weighed
    // against it — and absence of evidence must not read as qualification.
    const emptyCategory: CategoryCoverage = { ...categoryPassed(0, 1), facingCount: 0, density: null };
    expect(evaluateServiceLevelScope(emptyCategory).inScope).toBe(false);
    expect(evaluateServiceLevelScope(emptyCategory)).toMatchObject({ reason: 'unmeasured' });
  });

  it('publishes the qualifying categories as the scope of the commitment', () => {
    const coverage = measureCategoryCoverage({
      retailerId: ACME,
      window: DAY_WINDOW,
      facings: [
        ...classifiedFacings('dairy', 2, DAIRY_FRESH),
        ...classifiedFacings('cereal', 2, CEREAL_GROCERY),
      ],
      passes: [...passesOver('dairy-0', 8, hour(0)), ...passesOver('cereal-0', 2, hour(0))],
    });

    const inScope = categoriesInServiceLevelScope(coverage);
    expect(inScope.map((entry) => entry.classification.categoryId)).toEqual([
      DAIRY_FRESH.categoryId,
    ]);
  });

  it('lets a back-test move the floor without touching the shipped constant', () => {
    const sparse = categoryPassed(2, 4);
    expect(evaluateServiceLevelScope(sparse).inScope).toBe(false);
    expect(evaluateServiceLevelScope(sparse, passesPerFacingPerDay(0.5)).inScope).toBe(true);
    expect(MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL).toBe(2);
  });
});

describe('sales velocity', () => {
  it('reads units per day off a POS movement window', () => {
    // 10 units in an hour is 240 a day.
    expect(salesVelocityFromPos(posMovement({ observedAt: hour(1) }))).toBe(240);
  });

  it('is null for a zero-length window rather than a fabricated rate', () => {
    expect(
      salesVelocityFromPos(
        posMovement({ observedAt: hour(1), windowMillis: millis(0), unitsSold: 4 }),
      ),
    ).toBeNull();
  });
});
