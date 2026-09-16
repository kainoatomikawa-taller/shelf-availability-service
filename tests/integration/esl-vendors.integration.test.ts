import { describe, expect, it } from 'vitest';
import {
  ESL_VENDORS,
  detectGaps,
  dispatchTasks,
  gapId,
  instant,
  rankGapsForWindow,
  resolveColorLaneMap,
  salesVelocity,
  taskId,
  timeWindow,
  unwrap,
  type ClassifiedFacing,
  type DetectedGap,
  type DispatchTasksResult,
  type EslExpressionMode,
  type EslVendor,
  type FacingId,
  type FacingPass,
  type Instant,
  type RetailerId,
  type SalesVelocity,
  type StoreId,
} from '../../src/index.js';
import { ACME, DAIRY_FRESH, hour } from '../support/fixtures.js';
import { wireFor } from '../support/producer-wire.js';
import {
  ACME_SPEC,
  ACME_STORE,
  OAT_MILK,
  PILOT_NOW,
  RIVAL_SPEC,
  STORE_BY_VENDOR,
  VENDOR_MODELS,
  facingIn,
  facingRef,
  fourRetailerPilot,
  pilotStore,
} from '../support/pilot-fixtures.js';
import { startPilot, type Pilot, type RetailerHarness } from '../support/pilot-harness.js';

/**
 * Integration, per ESL vendor.
 *
 * Each of the five fleets is driven the way a store actually drives it: a
 * detection arrives on the retailer's own topic, the shelf goes empty, the gap is
 * detected and ranked, and `dispatchTasks` expresses the resulting worklist
 * through the fleet adapter the *container* built — which means through
 * `createEslAdapter`, the shipped vendor profile for whatever the gateway
 * declares itself to be, and that vendor's own request body.
 *
 * The unit tests next door already check each vendor's encoder against its API
 * documentation. What they cannot check is the pairing: a profile registered
 * under the wrong vendor, a container handing store B's adapter to store A, a
 * degradation ladder that is right in isolation and wrong once the store's actual
 * model mix is unioned into capabilities. Those only appear when the whole path
 * from a gap to a lit tag is real, which is what this file makes real.
 *
 * Every assertion about what reached the tag is made against the *gateway's*
 * payload — the bytes that vendor's API would receive — never against the
 * adapter's own report of what it did.
 */

const WINDOW = timeWindow(hour(0), hour(24));
const DETECTED_AT: Instant = hour(8);
const DISPATCHED_AT: Instant = hour(9);

/** The field each vendor names its tag and its task reference by. */
const WIRE_FIELDS: {
  readonly [V in EslVendor]: {
    readonly tag: string;
    readonly task: string;
    readonly expiry: string;
  };
} = {
  vusion: { tag: 'labelId', task: 'requestId', expiry: 'lifetimeSeconds' },
  pricer: { tag: 'labelId', task: 'externalRef', expiry: 'ttlSeconds' },
  aperion: { tag: 'tag_uid', task: 'task_ref', expiry: 'expires_at' },
  solum: { tag: 'labelCode', task: 'trackingId', expiry: 'expireAt' },
  hashow: { tag: 'esl_id', task: 'ref', expiry: 'valid_for_ms' },
};

/**
 * The rung each fleet's best deployed tag can actually reach, and the rung its
 * oldest one can.
 *
 * Written out rather than computed, because a table derived from the same
 * capability data the adapter reads would agree with the adapter by construction.
 * These are the answers a retailer would be given when asking what their estate
 * can show — two fleets can do the full pick-to-light, two can light the lane,
 * one can only put the job in text — and they are the reason `degraded` exists.
 */
const EXPECTED_RUNG: {
  readonly [V in EslVendor]: {
    readonly capable: EslExpressionMode;
    readonly floor: EslExpressionMode;
  };
} = {
  vusion: { capable: 'pick_to_light', floor: 'label_badge' },
  pricer: { capable: 'pick_to_light', floor: 'lane_colour_steady' },
  aperion: { capable: 'lane_colour_steady', floor: 'label_badge' },
  hashow: { capable: 'lane_colour_steady', floor: 'mono_indicator' },
  solum: { capable: 'label_badge', floor: 'label_badge' },
};

/** A two-retailer pilot whose first store runs `vendor` on exactly `modelCodes`. */
const pilotRunning = (vendor: EslVendor, modelCodes: readonly string[]): Pilot =>
  startPilot(
    [
      { tenant: ACME_SPEC.tenant, stores: [pilotStore(ACME_STORE, vendor, modelCodes)] },
      RIVAL_SPEC,
    ],
    { now: PILOT_NOW },
  );

const classifiedIn = (retailerId: RetailerId, store: StoreId, position: number): ClassifiedFacing => ({
  retailerId,
  storeId: store,
  facingId: facingIn(store, position),
  classification: DAIRY_FRESH,
});

/** Evenly spaced looks at one facing — enough density to keep it in service scope. */
const passesIn = (
  retailerId: RetailerId,
  store: StoreId,
  position: number,
  count = 4,
): readonly FacingPass[] =>
  Array.from({ length: count }, (_, index) => ({
    retailerId,
    storeId: store,
    facingId: facingIn(store, position),
    at: instant(hour(0) + index * 60 * 60 * 1000),
    source: 'arpalus_detection' as const,
  }));

/** Empties one facing through the real ingestion path and reads the gap off it. */
const emptyShelf = async (
  harness: RetailerHarness,
  store: StoreId,
  positions: readonly number[],
  at: Instant,
): Promise<readonly DetectedGap[]> => {
  await harness.publish(
    'arpalus_detection',
    wireFor(
      'arpalus_detection',
      {
        retailerCode: harness.retailerId,
        storeCode: store,
        facingRefs: positions.map((position) => facingRef(store, position)),
        sku: OAT_MILK,
        observedAt: DETECTED_AT,
        eventRef: `scan-${store}-${positions.join('-')}`,
      },
      'out_of_stock',
    ),
  );

  const gaps: DetectedGap[] = [];
  for (const position of positions) {
    const stored = await harness.facing(facingIn(store, position));
    expect(stored?.state).toBe('out_of_stock');
    gaps.push(
      ...detectGaps({
        facing: stored!,
        classification: DAIRY_FRESH,
        at,
        nextGapId: (entry, kind) => gapId(`${entry.facingId}:${kind}`),
      }),
    );
  }
  return gaps;
};

/**
 * Drives facings from a detection to a dispatched, expressed task.
 *
 * Every step is the shipped one. Nothing about the gap, the ranking or the task
 * is asserted into place: the facing state comes from an ingested Arpalus scan,
 * the gap from the facing, the density from passes over the same window, and the
 * worklist from `rankGapsForWindow`.
 */
const driveToDispatch = async (
  harness: RetailerHarness,
  store: StoreId,
  positions: readonly number[] = [1],
  at: Instant = DISPATCHED_AT,
): Promise<DispatchTasksResult> => {
  const gaps = await emptyShelf(harness, store, positions, at);

  const velocities: ReadonlyMap<FacingId, SalesVelocity> = new Map(
    positions.map((position, index) => [
      facingIn(store, position),
      // Distinct velocities, so the ranking has something real to order on.
      salesVelocity(24 - index * 8),
    ]),
  );

  const ranked = rankGapsForWindow({
    retailerId: harness.retailerId,
    window: WINDOW,
    gaps,
    facings: positions.map((position) => classifiedIn(harness.retailerId, store, position)),
    passes: positions.flatMap((position) => passesIn(harness.retailerId, store, position)),
    salesVelocities: velocities,
  });

  expect(ranked.committed).toHaveLength(positions.length);

  return dispatchTasks(
    { esl: harness.esl(store) },
    {
      retailerId: harness.retailerId,
      lanes: unwrap(resolveColorLaneMap(harness.retailerId)),
      gaps: ranked.committed,
      nextTaskId: (gap) => taskId(`task-${gap.gapId}`),
      at,
    },
  );
};

describe('integration — every ESL vendor, a detected gap to a lit tag', () => {
  for (const vendor of ESL_VENDORS) {
    describe(vendor, () => {
      it('expresses the task through this vendor’s own request body', async () => {
        const pilot = pilotRunning(vendor, [VENDOR_MODELS[vendor].capable]);
        const acme = pilot.retailer(ACME);

        const dispatched = await driveToDispatch(acme, ACME_STORE);
        const entry = dispatched.dispatches[0];

        expect(entry?.result.status).toBe('expressed');
        expect(dispatched.routedElsewhere).toEqual([]);

        const gateway = acme.gateway(ACME_STORE);
        expect(gateway.vendor).toBe(vendor);
        expect(gateway.dispatchCalls).toBe(1);

        const command = gateway.dispatched[0]?.commands[0];
        const fields = WIRE_FIELDS[vendor];

        expect(command).toBeDefined();
        expect(command?.payload[fields.tag]).toBe(command?.tagId);
        expect(String(command?.payload[fields.task])).toContain(entry?.task.taskId);
        // Every fleet is told when to stop, in whichever unit it states expiry in.
        expect(command?.payload[fields.expiry]).toBeTruthy();
      });

      it('reaches the most expressive rung its best deployed tag can manage', async () => {
        const pilot = pilotRunning(vendor, [VENDOR_MODELS[vendor].capable]);
        const acme = pilot.retailer(ACME);

        const dispatched = await driveToDispatch(acme, ACME_STORE);
        const result = dispatched.dispatches[0]?.result;

        expect(result).toMatchObject({
          status: 'expressed',
          mode: EXPECTED_RUNG[vendor].capable,
          degraded: EXPECTED_RUNG[vendor].capable !== 'pick_to_light',
        });
      });

      it('degrades to what its oldest generation can manage, and says that it did', async () => {
        const pilot = pilotRunning(vendor, [VENDOR_MODELS[vendor].floor]);
        const acme = pilot.retailer(ACME);

        const dispatched = await driveToDispatch(acme, ACME_STORE);
        const result = dispatched.dispatches[0]?.result;

        // Still lit, still leased, still a closed loop — one rung lower and
        // reported as such, because that is the number a refresh is funded from.
        expect(result).toMatchObject({
          status: 'expressed',
          mode: EXPECTED_RUNG[vendor].floor,
          degraded: true,
        });
        expect(dispatched.routedElsewhere).toEqual([]);
      });

      it('leases the expression rather than lighting a tag indefinitely', async () => {
        const pilot = pilotRunning(vendor, [VENDOR_MODELS[vendor].capable]);
        const acme = pilot.retailer(ACME);

        const dispatched = await driveToDispatch(acme, ACME_STORE);
        const result = dispatched.dispatches[0]?.result;

        expect(result?.status).toBe('expressed');
        if (result?.status !== 'expressed') return;
        expect(result.expressedAt).toBe(DISPATCHED_AT);
        expect(result.leaseExpiresAt).toBeGreaterThan(DISPATCHED_AT);
      });

      it('clears the lane through the same vendor’s release body', async () => {
        const pilot = pilotRunning(vendor, [VENDOR_MODELS[vendor].capable]);
        const acme = pilot.retailer(ACME);

        const dispatched = await driveToDispatch(acme, ACME_STORE);
        const task = dispatched.dispatches[0]?.task;
        expect(task).toBeDefined();

        const cleared = await acme.esl(ACME_STORE).clear({
          retailerId: acme.retailerId,
          storeId: ACME_STORE,
          taskId: task!.taskId,
          facingId: task!.facingId,
          reason: 'verified',
          requestedAt: hour(12),
        });

        expect(cleared).toEqual({ status: 'cleared', clearedAt: hour(12) });
        const released = acme.gateway(ACME_STORE).released[0]?.commands[0];
        expect(released?.payload[WIRE_FIELDS[vendor].tag]).toBe(released?.tagId);

        // Idempotent: the loop clears on every close, including one the fleet
        // never managed to light, and a second clear must not be an error.
        expect(
          await acme.esl(ACME_STORE).clear({
            retailerId: acme.retailerId,
            storeId: ACME_STORE,
            taskId: task!.taskId,
            facingId: task!.facingId,
            reason: 'verified',
            requestedAt: hour(13),
          }),
        ).toEqual({ status: 'not_expressed' });
      });

      it('routes the task elsewhere when this fleet’s gateway cannot reach its tags', async () => {
        const pilot = startPilot(
          [
            {
              tenant: ACME_SPEC.tenant,
              stores: [
                pilotStore(ACME_STORE, vendor, [VENDOR_MODELS[vendor].capable], {
                  gatewayReachable: false,
                }),
              ],
            },
            RIVAL_SPEC,
          ],
          { now: PILOT_NOW },
        );
        const acme = pilot.retailer(ACME);

        const dispatched = await driveToDispatch(acme, ACME_STORE);

        // A dark fleet is not a lost task: it is a task that has to reach the
        // employee on the handheld list instead, and saying so is the point.
        expect(dispatched.routedElsewhere).toHaveLength(1);
        expect(dispatched.dispatches[0]?.result.status).toBe('unavailable');
        expect(acme.gateway(ACME_STORE).dispatchCalls).toBe(0);
      });
    });
  }
});

describe('integration — five fleets running at once across a four-retailer pilot', () => {
  it('drives each store’s own vendor, and only that vendor', async () => {
    const pilot = fourRetailerPilot();

    for (const vendor of ESL_VENDORS) {
      const { retailer, store } = STORE_BY_VENDOR[vendor];
      const harness = pilot.retailer(retailer.tenant.retailerId);

      const dispatched = await driveToDispatch(harness, store);
      expect(dispatched.dispatches[0]?.result.status).toBe('expressed');

      const gateway = harness.gateway(store);
      expect(gateway.vendor).toBe(vendor);
      expect(gateway.dispatched).toHaveLength(1);
      // The tag the payload named is a tag in this store, not a neighbour's.
      expect(String(gateway.dispatched[0]?.commands[0]?.tagId)).toContain(store);
    }
  });

  it('never lets one retailer’s container build another’s fleet adapter', () => {
    const pilot = fourRetailerPilot();
    const acme = pilot.retailer(ACME);
    const other = pilot.retailers.find((harness) => harness.retailerId !== ACME);

    expect(other).toBeDefined();
    expect(() =>
      acme.container.resolve('eslActuation')(other!.retailerId, ACME_STORE),
    ).toThrow(/container was asked for retailer/);
  });

  it('memoizes one adapter per store, because the adapter holds that store’s leases', () => {
    const pilot = fourRetailerPilot();
    const acme = pilot.retailer(ACME);
    const factory = acme.container.resolve('eslActuation');

    expect(factory(ACME, ACME_STORE)).toBe(factory(ACME, ACME_STORE));
    expect(factory(ACME, ACME_STORE)).not.toBe(
      factory(ACME, ACME_SPEC.stores[1]!.storeId),
    );
  });
});

describe('integration — the worklist that reaches the shelf is the ranked one', () => {
  it('lights the whole committed worklist in rank order through a real fleet', async () => {
    const pilot = fourRetailerPilot();
    const acme = pilot.retailer(ACME);

    // Two facings in one bay go empty in one Arpalus pass, are ranked against
    // each other, and are dispatched as one worklist.
    const dispatched = await driveToDispatch(acme, ACME_STORE, [1, 2]);

    expect(dispatched.dispatches).toHaveLength(2);
    expect(dispatched.dispatches.every((entry) => entry.result.status === 'expressed')).toBe(true);
    // The faster seller is first, and the order the ranking chose survives the
    // store-by-store batching the fleet adapter does on the way to the gateway.
    expect(dispatched.dispatches.map((entry) => entry.task.facingId)).toEqual([
      facingIn(ACME_STORE, 1),
      facingIn(ACME_STORE, 2),
    ]);
    // One gateway call for the whole bay, not one per tag.
    expect(acme.gateway(ACME_STORE).dispatchCalls).toBe(1);
    expect(acme.gateway(ACME_STORE).dispatched[0]?.commands).toHaveLength(2);
  });
});
