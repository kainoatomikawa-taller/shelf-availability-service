import { describe, expect, it } from 'vitest';
import {
  CrossRetailerAccessError,
  LaneMappingError,
  STANDARD_COLOR_LANES,
  dispatchTasks,
  eventId,
  gapId,
  planTasks,
  priorityForRank,
  rankGaps,
  resolveColorLaneMap,
  storeId,
  taskId,
  unwrap,
  type DetectedGap,
  type RankedGap,
  type RetailerColorLanes,
} from '../src/index.js';
import {
  ACME,
  CEREAL_GROCERY,
  DAIRY_FRESH,
  RIVAL,
  fleetCapabilities,
  gap,
  hour,
} from './support/fixtures.js';
import { InMemoryEslFleet } from './support/in-memory-ports.js';

const LANES = unwrap(resolveColorLaneMap(ACME));

/** Ranks gaps the way the worklist does, so positions are the real ones. */
const ranked = (gaps: readonly DetectedGap[]): readonly RankedGap[] =>
  rankGaps({
    retailerId: ACME,
    gaps: gaps.map((entry) => ({ gap: entry, salesVelocity: null })),
    coverage: [],
  }).excluded;

const request = (gaps: readonly RankedGap[], lanes: RetailerColorLanes = LANES) => ({
  retailerId: ACME,
  lanes,
  gaps,
  nextTaskId: (entry: DetectedGap) => taskId(`task-${entry.gapId}`),
  triggeringEventId: () => eventId('evt-oos-1'),
  at: hour(9),
});

const AVAILABILITY = gap('g-avail', 'dairy-0', DAIRY_FRESH, hour(8));
const PRICE = gap('g-price', 'cereal-0', CEREAL_GROCERY, hour(8), {
  kind: 'price_mismatch',
  tagId: 'tag-551' as never,
  displayedPriceCents: 599,
});

describe('creating typed tasks from a ranked worklist', () => {
  it('types each task from its gap kind and puts it on that type’s lane', () => {
    const tasks = planTasks(request(ranked([AVAILABILITY, PRICE])));

    expect(tasks.map((task) => task.type)).toEqual(
      expect.arrayContaining(['restock_out_of_stock', 'price_label_correction']),
    );
    const restock = tasks.find((task) => task.type === 'restock_out_of_stock');
    const price = tasks.find((task) => task.type === 'price_label_correction');
    expect(restock?.lane).toBe(STANDARD_COLOR_LANES.restock_out_of_stock);
    expect(price?.lane).toBe(STANDARD_COLOR_LANES.price_label_correction);
    // Physical-stock work must survive verification; a relabel closes on resolution.
    expect(restock?.requiresVerification).toBe(true);
    expect(price?.requiresVerification).toBe(false);
  });

  it('carries the triggering transition onto the task, so the loop stays traceable', () => {
    const [task] = planTasks(request(ranked([AVAILABILITY])));

    expect(task?.triggeringEventId).toBe(eventId('evt-oos-1'));
    expect(task?.facingId).toBe(AVAILABILITY.facingId);
    expect(task?.state.status).toBe('created');
  });

  it('bands priority by worklist position', () => {
    expect(priorityForRank(1)).toBe('critical');
    expect(priorityForRank(3)).toBe('critical');
    expect(priorityForRank(4)).toBe('high');
    expect(priorityForRank(10)).toBe('high');
    expect(priorityForRank(11)).toBe('normal');
    expect(priorityForRank(26)).toBe('low');
  });

  it('refuses to dispatch a task onto a reserved lane', () => {
    // Green means "pick this for an order" on every tag in the estate. A mapping
    // that reaches this far is corrupt, and one light meaning two things on the
    // same shelf is not something to discover on the floor.
    const corrupt: RetailerColorLanes = {
      retailerId: ACME,
      lanes: { ...STANDARD_COLOR_LANES, restock_out_of_stock: 'green' },
      overriddenTypes: ['restock_out_of_stock'],
    };

    expect(() => planTasks(request(ranked([AVAILABILITY]), corrupt))).toThrow(LaneMappingError);
  });

  it('rejects a gap from another retailer rather than tasking it', () => {
    const foreign: DetectedGap = { ...AVAILABILITY, retailerId: RIVAL, gapId: gapId('g-rival') };

    expect(() => planTasks(request(ranked([foreign])))).toThrow(CrossRetailerAccessError);
  });
});

describe('expressing tasks at the shelf edge', () => {
  it('lights every task on its lane and leases the expression', async () => {
    const fleet = new InMemoryEslFleet(fleetCapabilities());
    const result = await dispatchTasks({ esl: fleet }, request(ranked([AVAILABILITY, PRICE])));

    expect(result.dispatches).toHaveLength(2);
    expect(result.routedElsewhere).toEqual([]);
    expect(fleet.expressions.size).toBe(2);

    const [dispatch] = result.dispatches;
    expect(dispatch?.result.status).toBe('expressed');
    expect(dispatch?.command?.lane).toBe(dispatch?.task.lane);
    // Leased, not set-and-forget: a crashed service leaves dark shelves.
    expect(dispatch?.command?.expiresAt).toBe(hour(13));
  });

  it('degrades to the best rung the fleet supports and says that it did', async () => {
    const fleet = new InMemoryEslFleet(
      fleetCapabilities({ supportedModes: ['mono_indicator', 'none'], renderableColours: [] }),
    );
    const result = await dispatchTasks({ esl: fleet }, request(ranked([AVAILABILITY])));
    const [dispatch] = result.dispatches;

    expect(dispatch?.result.status === 'expressed' && dispatch.result.mode).toBe('mono_indicator');
    expect(dispatch?.result.status === 'expressed' && dispatch.result.degraded).toBe(true);
    // A mono fleet cannot render the lane, and says so rather than implying it did.
    expect(dispatch?.result.status === 'expressed' && dispatch.result.renderedColour).toBeNull();
    expect(dispatch?.routeElsewhere).toBe(false);
  });

  it('routes the task elsewhere without calling a fleet that expresses nothing', async () => {
    const fleet = new InMemoryEslFleet(fleetCapabilities({ supportedModes: ['none'] }));
    const result = await dispatchTasks({ esl: fleet }, request(ranked([AVAILABILITY])));

    expect(fleet.commands).toEqual([]);
    expect(result.routedElsewhere.map((task) => task.taskId)).toEqual([taskId('task-g-avail')]);
    expect(result.dispatches[0]?.result).toEqual({
      status: 'unavailable',
      reason: 'no_supported_mode',
      retryAfter: null,
    });
  });

  it('routes a dark tag elsewhere while the rest of the store stays lit', async () => {
    const fleet = new InMemoryEslFleet(fleetCapabilities());
    fleet.failures.set(AVAILABILITY.facingId, 'tag_offline');

    const result = await dispatchTasks({ esl: fleet }, request(ranked([AVAILABILITY, PRICE])));

    expect(result.routedElsewhere.map((task) => task.facingId)).toEqual([AVAILABILITY.facingId]);
    expect(result.dispatches.filter((entry) => !entry.routeElsewhere)).toHaveLength(1);
  });

  it('respects the fleet’s batch limit rather than overrunning the gateway', async () => {
    const fleet = new InMemoryEslFleet(fleetCapabilities({ batchLimit: 2 }));
    const gaps = ranked(
      Array.from({ length: 5 }, (_, index) =>
        gap(`g-${index}`, `dairy-${index}`, DAIRY_FRESH, hour(8)),
      ),
    );

    const result = await dispatchTasks({ esl: fleet }, request(gaps));

    expect(result.dispatches).toHaveLength(5);
    expect(fleet.batchCalls).toBe(3);
  });

  it('asks each store’s own fleet what it can do', async () => {
    const other = storeId('acme-0099');
    const fleet = new InMemoryEslFleet(fleetCapabilities());
    const gaps = ranked([AVAILABILITY, { ...PRICE, storeId: other }]);

    // The second store has no fleet onboarded here, so describing it throws — the
    // point being that capabilities are resolved per store, never reused.
    await expect(dispatchTasks({ esl: fleet }, request(gaps))).rejects.toThrow(
      `No fleet onboarded for ${ACME}/${other}`,
    );
  });
});
