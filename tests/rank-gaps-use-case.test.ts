import { describe, expect, it } from 'vitest';
import {
  CrossRetailerAccessError,
  DetectionIngestionService,
  MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL,
  confidence,
  detectGaps,
  eventId,
  gapId,
  passesFromDetectionEvent,
  passesPerFacingPerDay,
  rankGapsForWindow,
  salesVelocity,
  salesVelocityFromPos,
  signalId,
  timeWindow,
  type DetectedGap,
  type FacingId,
  type SalesVelocity,
} from '../src/index.js';
import {
  ACME,
  CEREAL_GROCERY,
  DAIRY_FRESH,
  FRESH,
  GROCERY,
  RIVAL,
  arpalusObservation,
  classified,
  detectionEvent,
  facingIdOf,
  facingWith,
  gap,
  hour,
  passesOver,
  posObservation,
} from './support/fixtures.js';
import { InMemoryFacingRepository, InMemoryIngestionLedger } from './support/in-memory-ports.js';

const WINDOW = timeWindow(hour(0), hour(24));

const velocities = (entries: readonly [string, number][]): ReadonlyMap<FacingId, SalesVelocity> =>
  new Map(entries.map(([facing, units]) => [facingIdOf(facing), salesVelocity(units)]));

describe('ranking a store’s gaps for a window', () => {
  const request = {
    retailerId: ACME,
    window: WINDOW,
    facings: [classified('dairy-0', DAIRY_FRESH), classified('cereal-0', CEREAL_GROCERY)],
    gaps: [
      gap('dairy-gap', 'dairy-0', DAIRY_FRESH, hour(4)),
      gap('cereal-gap', 'cereal-0', CEREAL_GROCERY, hour(4)),
    ] as readonly DetectedGap[],
    salesVelocities: velocities([
      ['dairy-0', 12],
      ['cereal-0', 60],
    ]),
  };

  it('measures the density it ranks on, rather than being told it', () => {
    const result = rankGapsForWindow({
      ...request,
      passes: [...passesOver('dairy-0', 8, hour(0)), ...passesOver('cereal-0', 1, hour(0))],
    });

    expect(result.coverage.map((entry) => entry.density)).toEqual(
      expect.arrayContaining([8, 1]),
    );
    // Cereal sells five times faster, and is still out of scope: a category
    // passed once a day cannot produce the two clean passes that close a task.
    expect(result.committed.map((ranked) => ranked.gap.gapId)).toEqual(['dairy-gap']);
    expect(result.excluded.map((ranked) => ranked.gap.gapId)).toEqual(['cereal-gap']);
    expect(result.inServiceLevelScope.map((entry) => entry.classification.categoryId)).toEqual([
      DAIRY_FRESH.categoryId,
    ]);
  });

  it('admits both categories once the sparse one is swept often enough', () => {
    const result = rankGapsForWindow({
      ...request,
      passes: [...passesOver('dairy-0', 8, hour(0)), ...passesOver('cereal-0', 4, hour(0))],
    });

    // Now that both qualify, velocity and department decide the order.
    expect(result.committed.map((ranked) => ranked.gap.gapId)).toEqual([
      'cereal-gap',
      'dairy-gap',
    ]);
    expect(result.excluded).toEqual([]);
    expect(result.byDepartment.map((entry) => entry.departmentId)).toEqual([GROCERY, FRESH]);
  });

  it('back-tests a different floor without moving the shipped one', () => {
    const passes = [...passesOver('dairy-0', 8, hour(0)), ...passesOver('cereal-0', 1, hour(0))];

    const asShipped = rankGapsForWindow({ ...request, passes });
    const looser = rankGapsForWindow({
      ...request,
      passes,
      threshold: passesPerFacingPerDay(1),
    });

    expect(asShipped.committed).toHaveLength(1);
    expect(looser.committed).toHaveLength(2);
    expect(looser.inServiceLevelScope).toHaveLength(2);
    expect(MIN_REVISIT_DENSITY_FOR_SERVICE_LEVEL).toBe(2);
  });

  it('refuses a gap from another retailer before it measures anything', () => {
    expect(() =>
      rankGapsForWindow({
        ...request,
        gaps: [{ ...gap('theirs', 'dairy-0', DAIRY_FRESH, hour(4)), retailerId: RIVAL }],
        passes: [],
      }),
    ).toThrow(CrossRetailerAccessError);
  });
});

describe('the loop end to end: detection stream to worklist', () => {
  it('ranks what the ingested signals actually produced', async () => {
    // Nothing below is asserted into place: the facing state comes from ingested
    // signals, the gaps from the facing, the density from the same passes that
    // carried those signals, and the velocity from the POS window.
    const repository = new InMemoryFacingRepository([
      facingWith('dairy-0', hour(0), { initialState: 'in_stock' }),
    ]);
    const service = new DetectionIngestionService({
      facings: repository,
      ledger: new InMemoryIngestionLedger(),
      now: () => hour(12),
      nextSignalId: (envelope, source, index) => signalId(`${envelope.eventId}:${source}:${index}`),
      nextEventId: (facing) => eventId(`${facing.facingId}:${facing.history.events.length + 1}`),
    });

    const sellThrough = detectionEvent('pos_movement', hour(5), [
      posObservation('dairy-0', { unitsSold: 5, expectedUnitsSold: 20 }),
    ]);
    const voidPass = detectionEvent('arpalus_detection', hour(6), [
      arpalusObservation('dairy-0', { detectedFacings: 0, voidRatio: confidence(0.95) }),
    ]);

    const outcomes = await service.ingestBatch({ retailerId: ACME, events: [sellThrough, voidPass] });
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['accepted', 'accepted']);

    const dairy = await repository.load(ACME, facingIdOf('dairy-0'));
    expect(dairy?.state).toBe('out_of_stock');
    expect(dairy?.history.events).toHaveLength(1);

    const gaps = detectGaps({
      facing: dairy!,
      classification: DAIRY_FRESH,
      at: hour(12),
      nextGapId: (facing, kind) => gapId(`${facing.facingId}:${kind}`),
    });
    expect(gaps.map((detected) => detected.detail.kind)).toEqual(['availability_gap']);

    const pos = dairy!.signals.pos_movement;
    const velocity = pos === null ? null : salesVelocityFromPos(pos);
    expect(velocity).toBe(120); // 5 units in an hour

    const result = rankGapsForWindow({
      retailerId: ACME,
      window: WINDOW,
      gaps,
      facings: [classified('dairy-0', DAIRY_FRESH)],
      // The same detection traffic that fed the facing model feeds the density.
      passes: [
        ...passesOver('dairy-0', 6, hour(0)),
        ...passesFromDetectionEvent(sellThrough),
        ...passesFromDetectionEvent(voidPass),
      ],
      salesVelocities: new Map([[facingIdOf('dairy-0'), velocity!]]),
    });

    expect(result.coverage[0]?.density).toBe(8);
    expect(result.committed).toHaveLength(1);
    expect(result.committed[0]?.components).toMatchObject({
      departmentId: FRESH,
      kind: 'availability_gap',
      salesVelocity: 120,
      velocityBasis: 'measured',
      revisitDensity: 8,
    });
    expect(result.committed[0]?.serviceLevel).toEqual({ inScope: true, density: 8 });
  });
});
