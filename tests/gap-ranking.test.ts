import { describe, expect, it } from 'vitest';
import {
  CrossRetailerAccessError,
  GAP_KINDS,
  MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL,
  STANDARD_GAP_RANKING_POLICY,
  carrotTagId,
  confidence,
  detectGaps,
  evidenceFactor,
  gapId,
  measureCategoryCoverage,
  passesPerFacingPerDay,
  productId,
  rankGaps,
  rankedByDepartment,
  recordSignal,
  salesVelocity,
  taskTypeForGap,
  timeWindow,
  type CategoryCoverage,
  type DetectedGap,
  type Facing,
  type GapKind,
  type GapRankingPolicy,
  type MerchandisingClassification,
  type RankedGap,
  type Signal,
} from '../src/index.js';
import {
  ACME,
  CEREAL_GROCERY,
  DAIRY_FRESH,
  FRESH,
  GROCERY,
  RIVAL,
  arpalusDetection,
  carrotTagLabel,
  classifiedFacings,
  facingWith,
  gap,
  hour,
  nextEventId,
  passesOver,
  planogramRecord,
} from './support/fixtures.js';

const WINDOW = timeWindow(hour(0), hour(24));

/** Re-targets the shared signal fixtures at whichever facing the test built. */
const apply = (facing: Facing, signal: Signal): Facing =>
  recordSignal(facing, { ...signal, facingId: facing.facingId }, { nextEventId }).facing;

const gapsOn = (facing: Facing, classification = DAIRY_FRESH): readonly DetectedGap[] =>
  detectGaps({
    facing,
    classification,
    at: hour(12),
    nextGapId: (target, kind) => gapId(`${target.facingId}:${kind}`),
  });

const kindsOn = (facing: Facing): readonly GapKind[] =>
  gapsOn(facing).map((detected) => detected.detail.kind);

// A category swept often enough to carry a commitment, and one that is not.
const coverage = (
  classification: MerchandisingClassification,
  prefix: string,
  passesPerFacing: number,
): readonly CategoryCoverage[] =>
  measureCategoryCoverage({
    retailerId: ACME,
    window: WINDOW,
    facings: classifiedFacings(prefix, 1, classification),
    passes: passesOver(`${prefix}-0`, passesPerFacing, hour(0), 60 * 1000),
  });

describe('detecting gaps on a facing', () => {
  it('maps every gap kind to the lane that fixes it', () => {
    expect(GAP_KINDS.map(taskTypeForGap)).toEqual([
      'restock_out_of_stock',
      'price_label_correction',
      'planogram_correction',
    ]);
  });

  it('reads an availability gap off the facing state, carrying when it started', () => {
    const empty = apply(
      facingWith('dairy-0', hour(0), { initialState: 'in_stock' }),
      arpalusDetection({ observedAt: hour(3), detectedFacings: 0, voidRatio: confidence(0.9) }),
    );

    const [detected] = gapsOn(empty);
    expect(detected?.detail).toEqual({
      kind: 'availability_gap',
      since: hour(3),
      source: 'arpalus_detection',
    });
    // Detection time and gap age are different facts; a list sorted on the wrong
    // one puts the shelf that emptied at dawn behind the one that emptied a
    // minute ago.
    expect(detected?.detectedAt).toBe(hour(12));
  });

  it('raises a price mismatch from the tag without touching the stock timeline', () => {
    const mispriced = apply(
      facingWith('dairy-0', hour(0), { initialState: 'in_stock' }),
      carrotTagLabel({ observedAt: hour(2), labelState: 'price_mismatch', displayedPriceCents: 499 }),
    );

    expect(mispriced.state).toBe('in_stock');
    expect(kindsOn(mispriced)).toEqual(['price_mismatch']);
  });

  it('raises drift when the slot holds a product the plan does not put there', () => {
    const drifted = apply(
      facingWith('dairy-0', hour(0), { initialState: 'in_stock' }),
      planogramRecord({ observedAt: hour(1), expectedProductId: productId('sku-almond-milk') }),
    );

    expect(gapsOn(drifted).map((detected) => detected.detail)).toEqual([
      {
        kind: 'planogram_drift',
        drift: 'wrong_product',
        planogramVersion: '2026.09',
        expectedProductId: productId('sku-almond-milk'),
        expectedFacings: 3,
        detectedFacings: null,
      },
    ]);
  });

  it('raises drift when vision counts fewer facings than the plan calls for', () => {
    let facing = facingWith('dairy-0', hour(0), { initialState: 'in_stock' });
    facing = apply(facing, planogramRecord({ observedAt: hour(1), expectedFacings: 4 }));
    facing = apply(facing, arpalusDetection({ observedAt: hour(2), detectedFacings: 2 }));

    expect(gapsOn(facing).map((detected) => detected.detail)).toEqual([
      {
        kind: 'planogram_drift',
        drift: 'under_faced',
        planogramVersion: '2026.09',
        expectedProductId: expect.anything(),
        expectedFacings: 4,
        detectedFacings: 2,
      },
    ]);
  });

  it('does not chase drift on a delisted facing', () => {
    // The slot is supposed to look wrong; dispatching an employee to restore a
    // SKU the retailer walked away from is work nobody asked for.
    const delisted = apply(
      facingWith('dairy-0', hour(0), { initialState: 'in_stock' }),
      planogramRecord({
        observedAt: hour(1),
        assortmentStatus: 'discontinued',
        expectedProductId: productId('sku-almond-milk'),
      }),
    );

    expect(kindsOn(delisted)).toEqual([]);
  });

  it('raises every gap a facing carries at once', () => {
    let facing = facingWith('dairy-0', hour(0), { initialState: 'in_stock' });
    facing = apply(facing, arpalusDetection({ observedAt: hour(3), detectedFacings: 0, voidRatio: confidence(0.9) }));
    facing = apply(
      facing,
      carrotTagLabel({ observedAt: hour(4), labelState: 'price_mismatch' }),
    );
    facing = apply(
      facing,
      planogramRecord({ observedAt: hour(5), expectedProductId: productId('sku-almond-milk') }),
    );

    // Two lanes of work at one slot. Collapsing them would lose one of them.
    expect(kindsOn(facing)).toEqual(['availability_gap', 'price_mismatch', 'planogram_drift']);
  });

  it('says so rather than borrowing a source when nothing observed the state', () => {
    const openedEmpty = facingWith('dairy-0', hour(0), { initialState: 'out_of_stock' });
    expect(gapsOn(openedEmpty)[0]?.detail).toMatchObject({ source: null });
  });
});

describe('the evidence factor', () => {
  it('saturates: coverage adjusts confidence, it never manufactures demand', () => {
    expect(evidenceFactor(null)).toBe(0);
    expect(evidenceFactor(passesPerFacingPerDay(0))).toBe(0);
    // Exactly on the floor is half weight, and it approaches but never reaches 1.
    expect(evidenceFactor(MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL)).toBe(0.5);
    expect(evidenceFactor(passesPerFacingPerDay(6))).toBe(0.75);
    expect(evidenceFactor(passesPerFacingPerDay(1_000))).toBeLessThan(1);
  });

  it('is monotonic in density', () => {
    const densities = [1, 2, 4, 8, 16].map((value) => evidenceFactor(passesPerFacingPerDay(value)));
    expect([...densities].sort((a, b) => a - b)).toEqual(densities);
  });
});

describe('ranking gaps by department, sales velocity and revisit density', () => {
  const dairyCoverage = coverage(DAIRY_FRESH, 'dairy', 8);

  it('puts the faster seller first, all else equal', () => {
    const ranking = rankGaps({
      retailerId: ACME,
      coverage: dairyCoverage,
      gaps: [
        { gap: gap('slow', 'dairy-0', DAIRY_FRESH, hour(1)), salesVelocity: salesVelocity(4) },
        { gap: gap('fast', 'dairy-0', DAIRY_FRESH, hour(1)), salesVelocity: salesVelocity(40) },
      ],
    });

    expect(ranking.committed.map((ranked) => ranked.gap.gapId)).toEqual(['fast', 'slow']);
    expect(ranking.committed.map((ranked) => ranked.rank)).toEqual([1, 2]);
  });

  it('lets a department weight overturn a velocity ordering', () => {
    // Fresh loses margin on a faster clock than grocery: a banner says so by
    // weighting the department, and the ranking respects it.
    const policy: GapRankingPolicy = {
      ...STANDARD_GAP_RANKING_POLICY,
      departmentWeights: new Map([
        [FRESH, 4],
        [GROCERY, 1],
      ]),
    };
    const bothCovered = [...coverage(DAIRY_FRESH, 'dairy', 8), ...coverage(CEREAL_GROCERY, 'cereal', 8)];

    const gaps = [
      { gap: gap('cereal', 'cereal-0', CEREAL_GROCERY, hour(1)), salesVelocity: salesVelocity(30) },
      { gap: gap('dairy', 'dairy-0', DAIRY_FRESH, hour(1)), salesVelocity: salesVelocity(10) },
    ];

    expect(
      rankGaps({ retailerId: ACME, coverage: bothCovered, gaps }).committed.map((r) => r.gap.gapId),
    ).toEqual(['cereal', 'dairy']);

    expect(
      rankGaps({ retailerId: ACME, coverage: bothCovered, gaps, policy }).committed.map(
        (r) => r.gap.gapId,
      ),
    ).toEqual(['dairy', 'cereal']);
  });

  it('ranks a gap in a densely revisited category above the same gap in a sparse one', () => {
    // Both categories qualify; the one passed eight times a day has evidence
    // from the last hour, the one passed twice a day may be six hours stale.
    const ranking = rankGaps({
      retailerId: ACME,
      coverage: [...coverage(DAIRY_FRESH, 'dairy', 8), ...coverage(CEREAL_GROCERY, 'cereal', 2)],
      gaps: [
        { gap: gap('sparse', 'cereal-0', CEREAL_GROCERY, hour(1)), salesVelocity: salesVelocity(20) },
        { gap: gap('dense', 'dairy-0', DAIRY_FRESH, hour(1)), salesVelocity: salesVelocity(20) },
      ],
    });

    expect(ranking.committed.map((ranked) => ranked.gap.gapId)).toEqual(['dense', 'sparse']);
    expect(ranking.committed.map((ranked) => ranked.components.revisitDensity)).toEqual([8, 2]);
  });

  it('weights an empty shelf above a mispriced tag at the same velocity', () => {
    const ranking = rankGaps({
      retailerId: ACME,
      coverage: dairyCoverage,
      gaps: [
        {
          gap: gap('price', 'dairy-0', DAIRY_FRESH, hour(1), {
            kind: 'price_mismatch',
            tagId: carrotTagId('tag-551'),
            displayedPriceCents: 499,
          }),
          salesVelocity: salesVelocity(20),
        },
        { gap: gap('void', 'dairy-0', DAIRY_FRESH, hour(1)), salesVelocity: salesVelocity(20) },
      ],
    });

    expect(ranking.committed.map((ranked) => ranked.gap.gapId)).toEqual(['void', 'price']);
  });

  it('shows every factor behind a score, so the order can be argued with', () => {
    const [ranked] = rankGaps({
      retailerId: ACME,
      coverage: dairyCoverage,
      gaps: [{ gap: gap('one', 'dairy-0', DAIRY_FRESH, hour(1)), salesVelocity: salesVelocity(10) }],
    }).committed;

    expect(ranked?.components).toEqual({
      departmentId: FRESH,
      departmentWeight: 1,
      kind: 'availability_gap',
      kindWeight: 1,
      salesVelocity: 10,
      velocityBasis: 'measured',
      revisitDensity: 8,
      evidenceFactor: 0.8,
    });
    expect(ranked?.score).toBeCloseTo(1 * 1 * 10 * 0.8, 10);
  });

  it('flags an unknown velocity instead of inventing one', () => {
    const [ranked] = rankGaps({
      retailerId: ACME,
      coverage: dairyCoverage,
      gaps: [{ gap: gap('silent', 'dairy-0', DAIRY_FRESH, hour(1)), salesVelocity: null }],
    }).committed;

    expect(ranked?.components.velocityBasis).toBe('assumed');
    expect(ranked?.components.salesVelocity).toBe(0);
    expect(ranked?.score).toBe(0);
  });

  it('breaks ties on gap age, then on id, so a re-run never reshuffles the list', () => {
    const tied = [
      { gap: gap('c', 'dairy-0', DAIRY_FRESH, hour(9)), salesVelocity: salesVelocity(10) },
      { gap: gap('a', 'dairy-0', DAIRY_FRESH, hour(2)), salesVelocity: salesVelocity(10) },
      { gap: gap('b', 'dairy-0', DAIRY_FRESH, hour(2)), salesVelocity: salesVelocity(10) },
    ];

    const order = () =>
      rankGaps({ retailerId: ACME, coverage: dairyCoverage, gaps: tied }).committed.map(
        (ranked) => ranked.gap.gapId,
      );

    expect(order()).toEqual(['a', 'b', 'c']);
    expect(order()).toEqual(order());
  });

  it('refuses to pool another retailer into one worklist', () => {
    expect(() =>
      rankGaps({
        retailerId: ACME,
        coverage: dairyCoverage,
        gaps: [
          {
            gap: { ...gap('theirs', 'dairy-0', DAIRY_FRESH, hour(1)), retailerId: RIVAL },
            salesVelocity: salesVelocity(10),
          },
        ],
      }),
    ).toThrow(CrossRetailerAccessError);
  });
});

describe('service-level scope in the ranking', () => {
  it('excludes a category below the fixed floor from the committed list', () => {
    const ranking = rankGaps({
      retailerId: ACME,
      // Dairy is swept eight times a day; cereal only once — below the floor of 2.
      coverage: [...coverage(DAIRY_FRESH, 'dairy', 8), ...coverage(CEREAL_GROCERY, 'cereal', 1)],
      gaps: [
        { gap: gap('sparse', 'cereal-0', CEREAL_GROCERY, hour(1)), salesVelocity: salesVelocity(500) },
        { gap: gap('covered', 'dairy-0', DAIRY_FRESH, hour(1)), salesVelocity: salesVelocity(1) },
      ],
    });

    // Velocity alone would have put the sparse category's gap first; scope is not
    // a scoring factor, it is a gate applied before scoring matters.
    expect(ranking.committed.map((ranked) => ranked.gap.gapId)).toEqual(['covered']);
    expect(ranking.excluded.map((ranked) => ranked.gap.gapId)).toEqual(['sparse']);
    expect(ranking.excluded[0]?.serviceLevel).toEqual({
      inScope: false,
      reason: 'below_revisit_threshold',
      density: 1,
      required: MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL,
    });
  });

  it('excludes a category nothing measured at all, distinguishing it from a sparse one', () => {
    const ranking = rankGaps({
      retailerId: ACME,
      coverage: coverage(DAIRY_FRESH, 'dairy', 8),
      gaps: [
        { gap: gap('unseen', 'cereal-0', CEREAL_GROCERY, hour(1)), salesVelocity: salesVelocity(50) },
      ],
    });

    expect(ranking.committed).toEqual([]);
    expect(ranking.excluded[0]?.serviceLevel).toMatchObject({ reason: 'unmeasured', density: null });
  });

  it('still ranks the excluded gaps — the work is real, the commitment is not', () => {
    const ranking = rankGaps({
      retailerId: ACME,
      coverage: coverage(CEREAL_GROCERY, 'cereal', 1),
      gaps: [
        { gap: gap('slow', 'cereal-0', CEREAL_GROCERY, hour(1)), salesVelocity: salesVelocity(2) },
        { gap: gap('fast', 'cereal-0', CEREAL_GROCERY, hour(1)), salesVelocity: salesVelocity(200) },
      ],
    });

    expect(ranking.committed).toEqual([]);
    expect(ranking.excluded.map((ranked) => ranked.gap.gapId)).toEqual(['fast', 'slow']);
    expect(ranking.excluded.map((ranked) => ranked.rank)).toEqual([1, 2]);
  });

  it('admits a category sitting exactly on the floor', () => {
    const ranking = rankGaps({
      retailerId: ACME,
      coverage: coverage(CEREAL_GROCERY, 'cereal', 2),
      gaps: [
        { gap: gap('edge', 'cereal-0', CEREAL_GROCERY, hour(1)), salesVelocity: salesVelocity(5) },
      ],
    });

    expect(ranking.committed.map((ranked) => ranked.gap.gapId)).toEqual(['edge']);
    expect(ranking.committed[0]?.serviceLevel).toEqual({ inScope: true, density: 2 });
  });
});

describe('the department view', () => {
  it("re-cuts a ranked list per department, ordered by each department's top gap", () => {
    const ranking = rankGaps({
      retailerId: ACME,
      coverage: [...coverage(DAIRY_FRESH, 'dairy', 8), ...coverage(CEREAL_GROCERY, 'cereal', 8)],
      gaps: [
        { gap: gap('cereal-a', 'cereal-0', CEREAL_GROCERY, hour(1)), salesVelocity: salesVelocity(50) },
        { gap: gap('dairy-a', 'dairy-0', DAIRY_FRESH, hour(1)), salesVelocity: salesVelocity(20) },
        { gap: gap('dairy-b', 'dairy-0', DAIRY_FRESH, hour(1)), salesVelocity: salesVelocity(5) },
      ],
    });

    const departments = rankedByDepartment(ranking.committed);
    expect(departments.map((entry) => entry.departmentId)).toEqual([GROCERY, FRESH]);
    expect(departments[1]?.gaps.map((ranked: RankedGap) => ranked.gap.gapId)).toEqual([
      'dairy-a',
      'dairy-b',
    ]);
    // Ranks are per list, so a department view reads 1..n rather than inheriting
    // the position the gap held in the store-wide list.
    expect(departments[1]?.gaps.map((ranked: RankedGap) => ranked.rank)).toEqual([1, 2]);
  });
});
