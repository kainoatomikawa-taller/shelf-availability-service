import type { Brand } from '../common/brand.js';
import type { FacingId, RetailerId, StoreId } from '../common/ids.js';
import { assertSameRetailer, type RetailerPartitioned } from '../common/partition.js';
import { DAY, contains, windowDuration, type Instant, type TimeWindow } from '../common/time.js';
import type { SignalSource } from '../facing/signals.js';
import {
  categoryScopeKey,
  type CategoryScopeKey,
  type MerchandisingClassification,
} from './classification.js';

/**
 * How often a facing in this category actually gets looked at, in passes per
 * facing per day.
 *
 * The unit matters: "passes per day" alone rewards a big category for being big,
 * and "passes per facing" alone rewards a long measurement window. Normalising by
 * both is what makes the number comparable between a 40-facing dairy door swept
 * by one cart and a 900-facing grocery aisle swept by four.
 */
export type PassesPerFacingPerDay = Brand<number, 'PassesPerFacingPerDay'>;

export const passesPerFacingPerDay = (value: number): PassesPerFacingPerDay => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Revisit density must be a finite, non-negative number, got ${value}`);
  }
  return value as PassesPerFacingPerDay;
};

/** A facing and the category it is merchandised under — the denominator's population. */
export interface ClassifiedFacing extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  readonly classification: MerchandisingClassification;
}

/**
 * One look at one facing by one of the shelf-observing systems.
 *
 * A pass is any observation that put eyes on the facing, whatever it concluded:
 * a frame that saw a full shelf is as much a pass as one that saw a void. Density
 * measures how often we *could* have seen a problem, not how often we did.
 */
export interface FacingPass extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly facingId: FacingId;
  readonly at: Instant;
  readonly source: SignalSource;
}

/** Measured coverage of one category in one store over one window. */
export interface CategoryCoverage extends RetailerPartitioned {
  readonly retailerId: RetailerId;
  readonly storeId: StoreId;
  readonly classification: MerchandisingClassification;
  readonly window: TimeWindow;
  /** Every facing merchandised under the category, passed or not. */
  readonly facingCount: number;
  /** Passes landing inside the window, across all of those facings. */
  readonly passCount: number;
  /** Facings that were passed at least once — coverage breadth, for diagnosis. */
  readonly facingsPassed: number;
  readonly windowDays: number;
  /** `passCount / (facingCount * windowDays)`, or `null` when nothing was measurable. */
  readonly density: PassesPerFacingPerDay | null;
}

export interface MeasureCoverageInput {
  readonly retailerId: RetailerId;
  readonly window: TimeWindow;
  /** The facing population per category. Facings nobody passed belong here too. */
  readonly facings: readonly ClassifiedFacing[];
  readonly passes: readonly FacingPass[];
}

/**
 * Passes per facing per day.
 *
 * `null` rather than `0` when there is nothing to divide by — no facings in the
 * category, or a zero-length window. The same reasoning as the availability
 * index: "we did not measure" is a different answer from "we measured zero", and
 * only one of them should be allowed to fail a threshold.
 */
export function revisitDensity(
  passCount: number,
  facingCount: number,
  window: TimeWindow,
): PassesPerFacingPerDay | null {
  const days = windowDuration(window) / DAY;
  if (facingCount === 0 || days === 0) return null;
  return passesPerFacingPerDay(passCount / (facingCount * days));
}

/**
 * Measures revisit density per category from the facing population and the raw
 * pass stream.
 *
 * The denominator is every facing in the category, not every facing that was
 * passed. That distinction is the whole point of the measure: a category where
 * one facing of four hundred is swept twelve times a day is not covered, and
 * dividing by the facings we happened to see would score it as if it were.
 *
 * Passes outside the window, and passes for facings with no classification, are
 * ignored — an unclassifiable pass cannot be attributed to a category, and
 * silently attributing it to one would inflate exactly the number a retailer is
 * being held to.
 */
export function measureCategoryCoverage(input: MeasureCoverageInput): readonly CategoryCoverage[] {
  const { retailerId, window } = input;

  const scopeOfFacing = new Map<FacingId, CategoryScopeKey>();
  const accumulators = new Map<
    CategoryScopeKey,
    {
      storeId: StoreId;
      classification: MerchandisingClassification;
      facingCount: number;
      passCount: number;
      passedFacings: Set<FacingId>;
    }
  >();

  for (const facing of input.facings) {
    assertSameRetailer(retailerId, facing, 'measureCategoryCoverage');
    const key = categoryScopeKey(facing.storeId, facing.classification);
    scopeOfFacing.set(facing.facingId, key);

    const existing = accumulators.get(key);
    if (existing === undefined) {
      accumulators.set(key, {
        storeId: facing.storeId,
        classification: facing.classification,
        facingCount: 1,
        passCount: 0,
        passedFacings: new Set(),
      });
    } else {
      existing.facingCount += 1;
    }
  }

  for (const pass of input.passes) {
    assertSameRetailer(retailerId, pass, 'measureCategoryCoverage');
    if (!contains(window, pass.at)) continue;

    const key = scopeOfFacing.get(pass.facingId);
    if (key === undefined) continue;

    const accumulator = accumulators.get(key);
    if (accumulator === undefined) continue;
    accumulator.passCount += 1;
    accumulator.passedFacings.add(pass.facingId);
  }

  const windowDays = windowDuration(window) / DAY;

  return [...accumulators.values()].map((accumulator) => ({
    retailerId,
    storeId: accumulator.storeId,
    classification: accumulator.classification,
    window,
    facingCount: accumulator.facingCount,
    passCount: accumulator.passCount,
    facingsPassed: accumulator.passedFacings.size,
    windowDays,
    density: revisitDensity(accumulator.passCount, accumulator.facingCount, window),
  }));
}

/** Indexes measured coverage by store + category, for per-gap lookup. */
export const indexCoverage = (
  coverages: readonly CategoryCoverage[],
): ReadonlyMap<CategoryScopeKey, CategoryCoverage> =>
  new Map(
    coverages.map((coverage) => [
      categoryScopeKey(coverage.storeId, coverage.classification),
      coverage,
    ]),
  );
