import { describe, expect, it } from 'vitest';
import {
  DETECTION_SOURCES,
  DeploymentConfigError,
  deploymentManifest,
  facingId,
  namespacesOf,
  timeWindow,
  type AuditExportScope,
  type FacingId,
  type ReportScope,
  type RetailerId,
  type TimeWindow,
} from '../../src/index.js';
import { DAIRY_FRESH, hour } from '../support/fixtures.js';
import { wireFor } from '../support/producer-wire.js';
import {
  ACME_STORE,
  OAT_MILK,
  PILOT_NOW,
  RIVAL_STORE,
  facingIn,
  facingRef,
  fourRetailerPilot,
  twoRetailerPilot,
} from '../support/pilot-fixtures.js';
import { ACME_TENANT, RIVAL_TENANT } from '../support/tenancy.js';
import { startPilot, type Pilot, type RetailerHarness } from '../support/pilot-harness.js';

/**
 * Strict per-retailer partition isolation, exercised at pilot scale.
 *
 * Two retailers can show that a partition holds; four is where a pooling bug has
 * somewhere non-obvious to hide, because a leak into the *third* tenant is
 * invisible to any test that only ever has one neighbour. Both are run here, and
 * the pilot ceiling of four is the number the deployment planner enforces.
 *
 * Isolation in this service is argued in four places, and each one is checked
 * against a real attempt to cross it rather than against its own configuration:
 *
 *  - **The broker.** A topic belongs to exactly one tenant, and a record naming
 *    somebody else on it — in its envelope or in its partition key — is set aside
 *    rather than filed under whichever name the code happened to read first.
 *  - **The store.** One repository, one ledger and one read model per retailer,
 *    so a query cannot return a row it was never given.
 *  - **The read side.** Reports, exports and sealed artifacts are per partition,
 *    including the negative case: one retailer's artifact id is not a handle on
 *    another retailer's artifact.
 *  - **The wiring.** A container is scoped to one tenant and refuses to build
 *    anything for another, before a single record moves.
 *
 * The sharpest test in the file is the last one: two retailers holding a facing
 * with *the same id*. Every id-keyed lookup in the system is then a chance to
 * return the wrong tenant's shelf, and nothing about the ids themselves prevents
 * it — only the partitioning does.
 */

const DAY = timeWindow(hour(0), hour(24));

const scopeFor = (harness: RetailerHarness, window: TimeWindow = DAY): ReportScope => ({
  retailerId: harness.retailerId,
  storeIds: null,
  productIds: null,
  window,
  granularity: 'period',
  breakdownBy: [],
});

const auditScopeFor = (harness: RetailerHarness): AuditExportScope => ({
  retailerId: harness.retailerId,
  period: DAY,
  productIds: null,
  storeIds: null,
});

/** Empties the first facing of every store this retailer runs. */
const emptyEveryShelf = async (harness: RetailerHarness): Promise<void> => {
  for (const store of harness.spec.stores) {
    await harness.publish(
      'arpalus_detection',
      wireFor(
        'arpalus_detection',
        {
          retailerCode: harness.retailerId,
          storeCode: store.storeId,
          facingRefs: [facingRef(store.storeId, 1)],
          sku: OAT_MILK,
          observedAt: hour(8),
          eventRef: `scan-${store.storeId}`,
        },
        'out_of_stock',
      ),
    );
  }
};

const allFacingIds = (pilot: Pilot): ReadonlyMap<RetailerId, readonly FacingId[]> =>
  new Map(
    pilot.retailers.map((harness) => [
      harness.retailerId,
      harness.repository.all(harness.retailerId).map((facing) => facing.facingId),
    ]),
  );

describe('partition isolation — the broker boundary', () => {
  it('sets aside a record whose envelope names a retailer the topic does not belong to', async () => {
    const pilot = fourRetailerPilot();
    const [acme, rival] = pilot.retailers as [RetailerHarness, RetailerHarness];

    // Rival's own scan, published onto Acme's topic. A misconfigured producer
    // credential or a copied pipeline definition is exactly how this happens.
    const consumed = await acme.publish(
      'arpalus_detection',
      wireFor(
        'arpalus_detection',
        {
          retailerCode: rival.retailerId,
          storeCode: RIVAL_STORE,
          facingRefs: [facingRef(RIVAL_STORE, 1)],
          sku: OAT_MILK,
          observedAt: hour(8),
          eventRef: 'stray-scan',
        },
        'out_of_stock',
      ),
      { key: rival.retailerId },
    );

    expect(consumed.deadLettered).toBe(1);
    expect(consumed.dispositions[0]?.outcome).toMatchObject({
      status: 'dead_lettered',
      reason: 'topic_retailer_mismatch',
    });
    // Nothing reached a partition, so the batch touched none.
    expect(consumed.retailers).toEqual([]);

    // The dead letter is filed under the retailer the envelope *claimed*, in the
    // sink of the tenant whose topic it landed on — and the facing it named is
    // untouched in the partition that actually owns it.
    expect(acme.deadLetters.letters[0]?.retailerId).toBe(rival.retailerId);
    expect(rival.deadLetters.letters).toEqual([]);
    expect((await rival.facing(facingIn(RIVAL_STORE, 1)))?.state).toBe('in_stock');
  });

  it('refuses a record whose key and envelope name different retailers', async () => {
    const pilot = fourRetailerPilot();
    const [acme, rival] = pilot.retailers as [RetailerHarness, RetailerHarness];

    const consumed = await acme.publish(
      'caper_frame',
      wireFor(
        'caper_frame',
        {
          retailerCode: acme.retailerId,
          storeCode: ACME_STORE,
          facingRefs: [facingRef(ACME_STORE, 1)],
          sku: OAT_MILK,
          observedAt: hour(8),
          eventRef: 'misrouted-frame',
        },
        'out_of_stock',
      ),
      { key: rival.retailerId },
    );

    expect(consumed.dispositions[0]?.outcome).toMatchObject({
      status: 'dead_lettered',
      reason: 'partition_key_mismatch',
    });
    // Two agreeing statements of tenancy, not one: the envelope alone would have
    // been accepted here, and honouring the key alone would have filed Acme's
    // shelf under Rival's name.
    expect((await acme.facing(facingIn(ACME_STORE, 1)))?.state).toBe('in_stock');
  });

  it('refuses an unkeyed record rather than inferring the partition from the topic', async () => {
    const pilot = twoRetailerPilot();
    const acme = pilot.retailers[0]!;

    const consumed = await acme.publish(
      'shopper_scan',
      wireFor(
        'shopper_scan',
        {
          retailerCode: acme.retailerId,
          storeCode: ACME_STORE,
          facingRefs: [facingRef(ACME_STORE, 1)],
          sku: OAT_MILK,
          observedAt: hour(8),
          eventRef: 'unkeyed-scan',
        },
        'out_of_stock',
      ),
      { key: null },
    );

    expect(consumed.dispositions[0]?.outcome).toMatchObject({
      status: 'dead_lettered',
      reason: 'partition_key_mismatch',
    });
    expect((await acme.facing(facingIn(ACME_STORE, 1)))?.state).toBe('in_stock');
  });

  it('keeps every consumer inside its own tenant’s topic namespace', () => {
    const pilot = fourRetailerPilot();

    const seen = new Map<string, RetailerId>();
    for (const harness of pilot.retailers) {
      const prefix = namespacesOf(harness.tenant).topicPrefix;

      expect(harness.runtime.consumer.topics).toHaveLength(harness.tenant.sources.length);
      for (const topic of harness.runtime.consumer.topics) {
        expect(topic.startsWith(prefix)).toBe(true);
        // No topic is read by two tenants' consumers.
        expect(seen.has(topic)).toBe(false);
        seen.set(topic, harness.retailerId);
      }
    }

    expect(seen.size).toBe(pilot.retailers.length * DETECTION_SOURCES.length);
  });
});

describe('partition isolation — the store', () => {
  it('holds each retailer’s facings in that retailer’s partition and nowhere else', async () => {
    const pilot = fourRetailerPilot();
    for (const harness of pilot.retailers) await emptyEveryShelf(harness);

    const byRetailer = allFacingIds(pilot);

    for (const harness of pilot.retailers) {
      const mine = byRetailer.get(harness.retailerId) ?? [];
      expect(mine.length).toBeGreaterThan(0);

      // Every facing in my partition is mine...
      for (const facing of harness.repository.all(harness.retailerId)) {
        expect(facing.retailerId).toBe(harness.retailerId);
      }

      // ...and nobody else's partition answers for any of my facing ids.
      for (const other of pilot.retailers) {
        if (other.retailerId === harness.retailerId) continue;
        for (const id of mine) {
          expect(await other.facing(id)).toBeNull();
        }
      }
    }
  });

  it('does not let one retailer’s idempotency key swallow another’s event', async () => {
    const pilot = twoRetailerPilot();
    const [acme, rival] = pilot.retailers as [RetailerHarness, RetailerHarness];

    // The same producer event id in both tenants — two vendors both minting
    // `batch-1` is entirely ordinary, and the ledger's key space is per retailer
    // precisely so the second one is not read as a redelivery of the first.
    for (const harness of [acme, rival]) {
      const store = harness.spec.stores[0]!.storeId;
      const consumed = await harness.publish(
        'arpalus_detection',
        wireFor(
          'arpalus_detection',
          {
            retailerCode: harness.retailerId,
            storeCode: store,
            facingRefs: [facingRef(store, 1)],
            sku: OAT_MILK,
            observedAt: hour(8),
            eventRef: 'batch-1',
          },
          'out_of_stock',
        ),
      );
      expect(consumed.dispositions[0]?.outcome.status).toBe('ingested');
    }

    for (const harness of [acme, rival]) {
      const store = harness.spec.stores[0]!.storeId;
      expect((await harness.facing(facingIn(store, 1)))?.state).toBe('out_of_stock');
    }
  });
});

describe('partition isolation — the read side', () => {
  it('reports, exports and seals per retailer, with no row from a neighbour', async () => {
    const pilot = fourRetailerPilot();
    for (const harness of pilot.retailers) await emptyEveryShelf(harness);

    const byRetailer = allFacingIds(pilot);

    for (const harness of pilot.retailers) {
      const foreign = new Set(
        pilot.retailers
          .filter((other) => other.retailerId !== harness.retailerId)
          .flatMap((other) => byRetailer.get(other.retailerId) ?? []),
      );

      const records = await harness.reporting.availabilityRecords({
        scope: scopeFor(harness),
        sort: 'index_asc',
        minGapCount: null,
        page: { limit: 100, cursor: null },
      });
      expect(records.items.length).toBeGreaterThan(0);
      for (const row of records.items) {
        expect(row.retailerId).toBe(harness.retailerId);
        expect(foreign.has(row.facingId)).toBe(false);
      }

      const exported = await harness.reporting.exportFacingStateLog({
        scope: auditScopeFor(harness),
        page: { limit: 100, cursor: null },
      });
      for (const record of exported.items) {
        expect(record.retailerId).toBe(harness.retailerId);
        expect(foreign.has(record.facingId)).toBe(false);
        for (const transition of record.transitions) {
          expect(transition.eventId).toContain(record.facingId);
        }
      }

      const index = await harness.reporting.availabilityIndex(scopeFor(harness));
      expect(index.retailerId).toBe(harness.retailerId);
      // Facing-time is scored over this retailer's estate only: a pooled index
      // would count every tenant's shelves in one denominator.
      expect(index.overall.facingCount).toBe(
        harness.spec.stores.reduce((total, store) => total + store.facings.length, 0),
      );
    }
  });

  it('will not hand one retailer’s sealed artifact to another', async () => {
    const pilot = fourRetailerPilot();
    const [acme, rival] = pilot.retailers as [RetailerHarness, RetailerHarness];
    await emptyEveryShelf(acme);

    const sealed = await acme.reporting.sealArtifact({
      scope: auditScopeFor(acme),
      format: 'application/json',
      includeActionTrail: false,
    });

    expect(await acme.reporting.getArtifact(acme.retailerId, sealed.artifactId)).not.toBeNull();
    // Same id, wrong partition, and the answer is "no such artifact" rather than
    // somebody else's evidence.
    expect(await rival.reporting.getArtifact(rival.retailerId, sealed.artifactId)).toBeNull();
    expect(await acme.reporting.getArtifact(rival.retailerId, sealed.artifactId)).toBeNull();
  });

  it('refuses a read-model row from another partition instead of pooling it', async () => {
    const pilot = twoRetailerPilot();
    const [acme, rival] = pilot.retailers as [RetailerHarness, RetailerHarness];
    await emptyEveryShelf(rival);

    // A store is a place a cross-tenant row can arrive from — a botched migration,
    // a view missing its predicate — so the adapter re-checks rather than trusts.
    const stray = rival.repository.all(rival.retailerId)[0]!;
    acme.readModel.foreign.push({
      retailerId: stray.retailerId,
      facing: stray,
      classification: DAIRY_FRESH,
    });

    await expect(acme.reporting.availabilityIndex(scopeFor(acme))).rejects.toThrow(
      /from partition/,
    );
  });
});

describe('partition isolation — the wiring', () => {
  it('gives every retailer their own schemas, role, keys, topics and consumer group', () => {
    const pilot = fourRetailerPilot();
    const manifest = deploymentManifest(pilot.deployment);

    const seen = { schemas: new Set<string>(), roles: new Set<string>(), keys: new Set<string>(), groups: new Set<string>() };

    expect(manifest.retailers).toHaveLength(4);
    for (const retailer of manifest.retailers) {
      for (const schema of retailer.schemas) {
        expect(seen.schemas.has(schema)).toBe(false);
        seen.schemas.add(schema);
      }
      for (const key of retailer.keys) {
        expect(seen.keys.has(key)).toBe(false);
        seen.keys.add(key);
      }
      expect(seen.roles.has(retailer.role)).toBe(false);
      seen.roles.add(retailer.role);
      expect(seen.groups.has(retailer.consumerGroup)).toBe(false);
      seen.groups.add(retailer.consumerGroup);

      // Every ACL a retailer holds is scoped inside their own namespace.
      for (const topic of retailer.topics) {
        for (const acl of topic.acls) {
          expect(acl.resource.startsWith(`osa.${retailer.slug}.`)).toBe(true);
        }
      }
    }
  });

  it('scopes each container to one tenant and refuses to build for another', () => {
    const pilot = fourRetailerPilot();

    for (const harness of pilot.retailers) {
      expect(harness.container.tenant.retailerId).toBe(harness.retailerId);

      for (const other of pilot.retailers) {
        if (other.retailerId === harness.retailerId) continue;
        expect(() =>
          harness.container.resolve('eslActuation')(other.retailerId, ACME_STORE),
        ).toThrow(/container was asked for retailer/);
      }
    }
  });

  it('runs the pilot at the size the engagement allows, and refuses anything else', () => {
    expect(twoRetailerPilot().retailers).toHaveLength(2);
    expect(fourRetailerPilot().retailers).toHaveLength(4);

    // One retailer cannot demonstrate isolation — there is nothing to leak into.
    expect(() =>
      startPilot(
        [
          {
            tenant: ACME_TENANT,
            stores: [
              { storeId: ACME_STORE, vendor: 'vusion', modelCodes: ['VUSION_EDGE_3'], facings: [] },
            ],
          },
        ],
        { now: PILOT_NOW },
      ),
    ).toThrow(DeploymentConfigError);
  });
});

describe('partition isolation — two retailers holding the same facing id', () => {
  const SHARED: FacingId = facingId('shared:a1:b1:s1:p1');

  const sharedFacing = {
    facingId: SHARED,
    productId: OAT_MILK,
    classification: DAIRY_FRESH,
    location: { aisle: 'A1', bay: 'B1', shelf: 1, position: 1 },
    capacityUnits: 12,
    initialState: 'in_stock' as const,
  };

  const collidingPilot = (): Pilot =>
    startPilot(
      [
        {
          tenant: ACME_TENANT,
          stores: [
            {
              storeId: ACME_STORE,
              vendor: 'vusion',
              modelCodes: ['VUSION_EDGE_3'],
              facings: [sharedFacing],
            },
          ],
        },
        {
          tenant: RIVAL_TENANT,
          stores: [
            {
              storeId: RIVAL_STORE,
              vendor: 'hashow',
              modelCodes: ['HS-PLUS'],
              facings: [sharedFacing],
            },
          ],
        },
      ],
      { now: PILOT_NOW },
    );

  it('moves only the shelf belonging to the retailer whose producer published', async () => {
    const pilot = collidingPilot();
    const [acme, rival] = pilot.retailers as [RetailerHarness, RetailerHarness];

    await acme.publish(
      'arpalus_detection',
      wireFor(
        'arpalus_detection',
        {
          retailerCode: acme.retailerId,
          storeCode: ACME_STORE,
          facingRefs: [SHARED],
          sku: OAT_MILK,
          observedAt: hour(8),
          eventRef: 'shared-scan',
        },
        'out_of_stock',
      ),
    );

    expect((await acme.facing(SHARED))?.state).toBe('out_of_stock');
    // Same id, different tenant, untouched — and still carrying no history of
    // an event it never saw.
    const theirs = await rival.facing(SHARED);
    expect(theirs?.state).toBe('in_stock');
    expect(theirs?.history.events).toEqual([]);
  });

  it('reports and exports a different answer for each of them', async () => {
    const pilot = collidingPilot();
    const [acme, rival] = pilot.retailers as [RetailerHarness, RetailerHarness];

    await acme.publish(
      'arpalus_detection',
      wireFor(
        'arpalus_detection',
        {
          retailerCode: acme.retailerId,
          storeCode: ACME_STORE,
          facingRefs: [SHARED],
          sku: OAT_MILK,
          observedAt: hour(6),
          eventRef: 'shared-scan',
        },
        'out_of_stock',
      ),
    );

    const mine = await acme.reporting.availabilityIndex(scopeFor(acme));
    const theirs = await rival.reporting.availabilityIndex(scopeFor(rival));

    // Empty from 06:00 to midnight in one partition, full all day in the other.
    expect(mine.overall.index).toBeCloseTo(6 / 24, 12);
    expect(theirs.overall.index).toBe(1);

    const acmeArtifact = await acme.reporting.sealArtifact({
      scope: auditScopeFor(acme),
      format: 'application/json',
      includeActionTrail: false,
    });
    const rivalArtifact = await rival.reporting.sealArtifact({
      scope: auditScopeFor(rival),
      format: 'application/json',
      includeActionTrail: false,
    });

    // Identical scope shape, identical facing id, different evidence — so the
    // artifacts must not be the same bytes, and their ids must not collide.
    expect(rivalArtifact.integrity.contentHash).not.toBe(acmeArtifact.integrity.contentHash);
    expect(rivalArtifact.artifactId).not.toBe(acmeArtifact.artifactId);
  });
});
