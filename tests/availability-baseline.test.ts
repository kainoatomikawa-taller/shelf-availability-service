import { describe, expect, it } from 'vitest';
import {
  CrossRetailerAccessError,
  DAY,
  HOUR,
  compareToBaseline,
  computeAvailabilityIndex,
  confidence,
  establishAvailabilityBaseline,
  instant,
  millis,
  recordSignal,
  timeWindow,
  timelineFor,
  type BaselineFacing,
  type Facing,
  type Instant,
  type MerchandisingClassification,
} from '../src/index.js';
import {
  ACME,
  CEREAL_GROCERY,
  DAIRY_FRESH,
  FRESH,
  GROCERY,
  RIVAL,
  arpalusDetection,
  facingWith,
  hour,
  nextEventId,
} from './support/fixtures.js';

/** Hours from the window anchor, unbounded — the baseline window is a week long. */
const h = (hours: number): Instant => instant(hour(0) + hours * HOUR);

const WEEK = timeWindow(h(0), h(24 * 7));

/** Drives a facing out of stock and back, through the real interpretation path. */
const observe = (facing: Facing, at: Instant, state: 'in_stock' | 'out_of_stock'): Facing =>
  recordSignal(
    facing,
    arpalusDetection({
      observedAt: at,
      facingId: facing.facingId,
      detectedFacings: state === 'in_stock' ? 3 : 0,
      voidRatio: state === 'in_stock' ? confidence(0) : confidence(1),
    }),
    { nextEventId },
  ).facing;

const stocked = (id: string, classification: MerchandisingClassification): BaselineFacing => ({
  facing: facingWith(id, h(0), { initialState: 'in_stock' }),
  classification,
});

const withGap = (
  id: string,
  classification: MerchandisingClassification,
  from: number,
  to: number,
): BaselineFacing => {
  const base = stocked(id, classification);
  return {
    ...base,
    facing: observe(observe(base.facing, h(from), 'out_of_stock'), h(to), 'in_stock'),
  };
};

const establish = (facings: readonly BaselineFacing[], window = WEEK) =>
  establishAvailabilityBaseline({
    retailerId: ACME,
    window,
    facings,
    establishedAt: h(24 * 7),
  });

describe('establishing the retailer prior baseline', () => {
  it('scores the prior on facing-time in stock, not on facings counted', () => {
    // One facing empty for a whole day of the week, one stocked throughout: the
    // prior is 13 of 14 facing-days in stock, not "one of two facings had a gap".
    const baseline = establish([
      withGap('dairy-0', DAIRY_FRESH, 24, 48),
      stocked('dairy-1', DAIRY_FRESH),
    ]);

    expect(baseline.overall.index).toBeCloseTo(13 / 14, 10);
    expect(baseline.overall.facingCount).toBe(2);
    expect(baseline.overall.measuredFacingMillis).toBe(millis(14 * DAY));
    expect(baseline.overall.coverage).toBe(1);
    expect(baseline.status.established).toBe(true);
  });

  it('excludes time nobody could see from both sides of the ratio', () => {
    // A facing opened unknown and only observed halfway through the week: the
    // unseen half is not available time and not unavailable time.
    const unseen = stocked('dairy-2', DAIRY_FRESH);
    const late: BaselineFacing = {
      ...unseen,
      facing: observe(
        facingWith('dairy-2', h(0), { initialState: 'unknown' }),
        h(24 * 3.5),
        'in_stock',
      ),
    };

    const baseline = establish([late]);

    expect(baseline.overall.index).toBe(1);
    expect(baseline.overall.coverage).toBeCloseTo(0.5, 10);
    expect(baseline.overall.unknownFacingMillis).toBe(millis(3.5 * DAY));
  });

  it('refuses to call a baseline established when too little was measured', () => {
    const barelySeen: BaselineFacing = {
      facing: observe(
        facingWith('dairy-3', h(0), { initialState: 'unknown' }),
        h(24 * 6),
        'in_stock',
      ),
      classification: DAIRY_FRESH,
    };

    const baseline = establish([barelySeen]);

    // The number is still published — withholding it just moves the computation
    // into somebody's spreadsheet without the caveat attached.
    expect(baseline.overall.index).toBe(1);
    expect(baseline.status).toEqual({
      established: false,
      shortfalls: ['insufficient_coverage'],
    });
  });

  it('refuses a window shorter than a trading week', () => {
    const baseline = establish([stocked('dairy-0', DAIRY_FRESH)], timeWindow(h(0), h(24)));

    expect(baseline.status.established).toBe(false);
    expect(baseline.status.established === false && baseline.status.shortfalls).toEqual([
      'window_too_short',
    ]);
  });

  it('says nothing was measured rather than scoring an empty estate zero', () => {
    const baseline = establish([]);

    expect(baseline.overall.index).toBeNull();
    expect(baseline.status.established === false && baseline.status.shortfalls).toEqual([
      'too_few_facings',
      'nothing_measured',
    ]);
  });

  it('cuts the prior by department, so a lift can be claimed where it happened', () => {
    const baseline = establish([
      withGap('dairy-0', DAIRY_FRESH, 24, 48),
      stocked('cereal-0', CEREAL_GROCERY),
    ]);

    expect(baseline.byDepartment.map((entry) => entry.departmentId)).toEqual([FRESH, GROCERY]);
    expect(baseline.byDepartment[0]?.point.index).toBeCloseTo(6 / 7, 10);
    expect(baseline.byDepartment[1]?.point.index).toBe(1);
  });

  it('refuses to pool another retailer into the prior', () => {
    const foreign: BaselineFacing = {
      facing: { ...stocked('dairy-0', DAIRY_FRESH).facing, retailerId: RIVAL },
      classification: DAIRY_FRESH,
    };

    expect(() => establish([foreign])).toThrow(CrossRetailerAccessError);
  });
});

describe('measuring against the prior', () => {
  const baseline = establish([withGap('dairy-0', DAIRY_FRESH, 24, 48), stocked('dairy-1', DAIRY_FRESH)]);

  const currentIndex = (facings: readonly BaselineFacing[]) =>
    computeAvailabilityIndex(
      ACME,
      facings.map((entry) => timelineFor(entry.facing, WEEK)),
      WEEK,
    );

  it('reports the lift in index points and relative to the prior', () => {
    const current = currentIndex([stocked('dairy-0', DAIRY_FRESH), stocked('dairy-1', DAIRY_FRESH)]);
    const comparison = compareToBaseline(baseline, current);

    expect(comparison.comparable).toBe(true);
    expect(comparison.baseline).toBeCloseTo(13 / 14, 10);
    expect(comparison.current).toBe(1);
    expect(comparison.delta).toBeCloseTo(1 / 14, 10);
    expect(comparison.relativeLift).toBeCloseTo(1 / 13, 10);
  });

  it('will not compute a lift against a prior that was never established', () => {
    const provisional = establish([stocked('dairy-0', DAIRY_FRESH)], timeWindow(h(0), h(24)));
    const comparison = compareToBaseline(
      provisional,
      currentIndex([stocked('dairy-0', DAIRY_FRESH)]),
    );

    expect(comparison.comparable).toBe(false);
    expect(comparison.delta).toBeNull();
    expect(comparison.relativeLift).toBeNull();
  });
});
