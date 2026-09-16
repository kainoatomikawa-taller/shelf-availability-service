import { describe, expect, it } from 'vitest';
import {
  DETECTION_SOURCES,
  CURRENT_DETECTION_SCHEMA_VERSION,
  type DetectionSource,
  type Instant,
} from '../../src/index.js';
import { hour } from '../support/fixtures.js';
import {
  MOVES_STOCK_TIMELINE,
  arpalusWire,
  caperWire,
  carrotWire,
  posWire,
  shopperWire,
  wireFor,
  type Payload,
  type WireContext,
} from '../support/producer-wire.js';
import {
  ACME_STORE,
  OAT_MILK,
  PILOT_NOW,
  facingIn,
  facingRef,
  twoRetailerPilot,
} from '../support/pilot-fixtures.js';
import type { Pilot, RetailerHarness } from '../support/pilot-harness.js';

/**
 * Integration, per event source.
 *
 * One test body, run five times — once per detection producer — and every run
 * starts from that producer's own bytes on that producer's own topic and ends at
 * the facing ingestion actually stored. Nothing is stubbed between those two
 * points: the record goes through the real `DetectionStreamConsumer` built by
 * `createDetectionConsumer` from the bus topology, the shipped `SourceAdapter`
 * for the topic, the real `DetectionIngestionService` the container wired, and
 * the real domain fold that decides whether the shelf moved.
 *
 * What that buys over the adapter unit tests next door is the wiring itself. A
 * source can decode perfectly and still never reach a facing — a topic nobody
 * subscribed, an adapter missing from the registry, a partition check that
 * rejects the producer's own key — and each of those is invisible to a test that
 * hands a decoded event straight to the use case.
 */

const OBSERVED: Instant = hour(9);

const contextFor = (harness: RetailerHarness, eventRef: string): WireContext => ({
  retailerCode: harness.retailerId,
  storeCode: ACME_STORE,
  facingRefs: [facingRef(ACME_STORE, 1)],
  sku: OAT_MILK,
  observedAt: OBSERVED,
  eventRef,
});

describe('integration — every detection source, producer bytes to stored facing', () => {
  for (const source of DETECTION_SOURCES) {
    describe(source, () => {
      const start = async (): Promise<{ pilot: Pilot; acme: RetailerHarness }> => {
        const pilot = twoRetailerPilot();
        return { pilot, acme: pilot.retailer(pilot.deployment.registry.tenants[0]!.retailerId) };
      };

      it('is subscribed on its own topic inside the retailer’s namespace', async () => {
        const { acme } = await start();
        const topic = acme.topicFor(source);

        expect(topic).toBe(`osa.${acme.tenant.slug}.detections.${source}`);
        expect(acme.runtime.consumer.topics).toContain(topic);
        // One topic per source, and no other tenant's topic anywhere near it.
        expect(
          acme.runtime.consumer.topics.every((name) =>
            name.startsWith(`osa.${acme.tenant.slug}.`),
          ),
        ).toBe(true);
      });

      it('ingests a payload in the producer’s own dialect', async () => {
        const { acme } = await start();
        const consumed = await acme.publish(
          source,
          wireFor(source, contextFor(acme, `evt-${source}-1`), 'in_stock'),
        );

        expect(consumed.deadLettered).toBe(0);
        expect(consumed.dispositions.map((entry) => entry.outcome.status)).toEqual(['ingested']);
        expect(consumed.retailers).toEqual([acme.retailerId]);
        expect(consumed.commitThrough).toBe(consumed.dispositions[0]?.offset);
      });

      it('records the observation on the facing under this source’s own slot', async () => {
        const { acme } = await start();
        await acme.publish(
          source,
          wireFor(source, contextFor(acme, `evt-${source}-2`), 'in_stock'),
        );

        const facing = await acme.facing(facingIn(ACME_STORE, 1));
        const signal = facing?.signals[source] ?? null;

        expect(signal).not.toBeNull();
        expect(signal?.source).toBe(source);
        // The observation instant is the envelope's, not the broker's append time
        // — a scan covers a bay at one instant and is not re-dated on delivery.
        expect(signal?.observedAt).toBe(OBSERVED);
        expect(signal?.retailerId).toBe(acme.retailerId);
      });

      it('carries the producer’s instance and build through to the audit trail', async () => {
        const { acme } = await start();
        await acme.publish(
          source,
          wireFor(source, contextFor(acme, `evt-${source}-3`), 'out_of_stock'),
        );

        const facing = await acme.facing(facingIn(ACME_STORE, 1));
        const signal = facing?.signals[source];
        expect(signal).toBeDefined();

        const provenance = await acme.readModel.signalProvenance(acme.retailerId, [
          signal!.signalId,
        ]);
        const entry = provenance.get(signal!.signalId);

        expect(entry?.instanceId).toBeTruthy();
        expect(entry?.softwareVersion).toBeTruthy();
      });

      it('answers a redelivery with the original acceptance rather than ingesting twice', async () => {
        const { acme } = await start();
        const payload = wireFor(source, contextFor(acme, `evt-${source}-4`), 'out_of_stock');

        const first = await acme.publish(source, payload);
        const second = await acme.publish(source, payload);

        expect(first.dispositions[0]?.outcome.status).toBe('ingested');
        expect(second.dispositions[0]?.outcome.status).toBe('duplicate');

        const facing = await acme.facing(facingIn(ACME_STORE, 1));
        // Whatever this source did to the timeline, it did once.
        expect(facing?.history.events.length ?? 0).toBeLessThanOrEqual(1);
      });

      it('either moves the shelf state or explains why it never could', async () => {
        const { acme } = await start();
        await acme.publish(
          source,
          wireFor(source, contextFor(acme, `evt-${source}-5`), 'out_of_stock'),
        );

        const facing = await acme.facing(facingIn(ACME_STORE, 1));

        if (MOVES_STOCK_TIMELINE[source]) {
          expect(facing?.state).toBe('out_of_stock');
          expect(facing?.history.events).toHaveLength(1);
          expect(facing?.history.events[0]?.cause.source).toBe(source);
          expect(facing?.history.events[0]?.at).toBe(OBSERVED);
        } else {
          // A Carrot Tags sweep reports a label, never what is behind it. The
          // observation is retained; the stock timeline is untouched.
          expect(facing?.state).toBe('in_stock');
          expect(facing?.history.events).toHaveLength(0);
          expect(facing?.signals.carrot_tag_label).not.toBeNull();
        }
      });

      it('stamps the layer-owned schema version, not the producer’s', async () => {
        const { acme } = await start();
        const consumed = await acme.publish(
          source,
          wireFor(source, contextFor(acme, `evt-${source}-6`), 'in_stock'),
        );

        expect(consumed.dispositions[0]?.outcome.status).toBe('ingested');
        const contract = await acme.container
          .resolve('detectionIngestion')
          .describeSchemaContract();
        expect(contract.current).toBe(CURRENT_DETECTION_SCHEMA_VERSION);
      });

      it('dead-letters a payload this producer never sent rather than guessing', async () => {
        const { acme } = await start();
        const consumed = await acme.publish(source, { not: 'a payload this producer sends' });

        expect(consumed.deadLettered).toBe(1);
        expect(consumed.dispositions[0]?.outcome).toMatchObject({
          status: 'dead_lettered',
          reason: 'unsupported_wire_version',
        });
        // Terminal, so one bad build on one topic does not stall that partition.
        expect(consumed.commitThrough).toBe(consumed.dispositions[0]?.offset);
      });
    });
  }
});

describe('integration — the five sources over one facing', () => {
  it('unifies every producer onto one addressable facing', async () => {
    const pilot = twoRetailerPilot();
    const acme = pilot.retailers[0]!;
    const facingId = facingIn(ACME_STORE, 1);

    // Published in the order a store would actually see them over a morning, each
    // one on its own topic through its own adapter.
    for (const [index, source] of DETECTION_SOURCES.entries()) {
      await acme.publish(
        source,
        wireFor(
          source,
          {
            retailerCode: acme.retailerId,
            storeCode: ACME_STORE,
            facingRefs: [facingRef(ACME_STORE, 1)],
            sku: OAT_MILK,
            observedAt: hour(6 + index),
            eventRef: `sweep-${source}`,
          },
          'in_stock',
        ),
      );
    }

    const facing = await acme.facing(facingId);
    const filled = DETECTION_SOURCES.filter((source) => facing?.signals[source] !== null);

    expect(filled).toHaveLength(DETECTION_SOURCES.length);
    // The sixth slot is planogram_record, which is reference data and arrives
    // through a different door — it is not a detection source.
    expect(facing?.signals.planogram_record).toBeNull();
  });

  it('covers a whole bay from one array-source payload', async () => {
    const pilot = twoRetailerPilot();
    const acme = pilot.retailers[0]!;

    const consumed = await acme.publish(
      'arpalus_detection',
      wireFor(
        'arpalus_detection',
        {
          retailerCode: acme.retailerId,
          storeCode: ACME_STORE,
          facingRefs: [facingRef(ACME_STORE, 1), facingRef(ACME_STORE, 2)],
          sku: OAT_MILK,
          observedAt: OBSERVED,
          eventRef: 'bay-scan',
        },
        'out_of_stock',
      ),
    );

    expect(consumed.dispositions[0]?.outcome).toMatchObject({ status: 'ingested' });

    for (const position of [1, 2]) {
      const facing = await acme.facing(facingIn(ACME_STORE, position));
      expect(facing?.state).toBe('out_of_stock');
      expect(facing?.history.events[0]?.at).toBe(OBSERVED);
    }
  });

  it('keeps a label sweep out of the stock timeline even when it reports a fault', async () => {
    const pilot = twoRetailerPilot();
    const acme = pilot.retailers[0]!;

    const consumed = await acme.publish(
      'carrot_tag_label',
      carrotWire(
        {
          retailerCode: acme.retailerId,
          storeCode: ACME_STORE,
          facingRefs: [facingRef(ACME_STORE, 1)],
          sku: OAT_MILK,
          observedAt: OBSERVED,
          eventRef: 'sweep-fault',
        },
        { status: 'PRICE_MISMATCH', price: '7.49', lamp: 'RED' },
      ),
    );

    expect(consumed.dispositions[0]?.outcome).toMatchObject({ status: 'ingested' });

    const facing = await acme.facing(facingIn(ACME_STORE, 1));
    expect(facing?.state).toBe('in_stock');
    expect(facing?.history.events).toHaveLength(0);
    // The vendor's decimal string became integer cents, and its lamp code a lane.
    expect(facing?.signals.carrot_tag_label).toMatchObject({
      labelState: 'price_mismatch',
      displayedPriceCents: 749,
      litLane: 'red',
    });
  });
});

describe('integration — every retailer runs every source it declared', () => {
  it('wires a consumer for each declared source of each retailer in the pilot', () => {
    const pilot = twoRetailerPilot(PILOT_NOW);

    for (const harness of pilot.retailers) {
      const sources = new Set<DetectionSource>(
        harness.runtime.consumer.topics.map(
          (topic) => topic.split('.').at(-1) as DetectionSource,
        ),
      );
      expect([...sources].sort()).toEqual([...harness.tenant.sources].sort());
    }
  });
});


/**
 * The unit and encoding conversions, asserted on the shelf rather than on the field.
 *
 * Each producer sends at least one value that is a *plausible number* if nobody
 * converts it — a void percentage read as a ratio, millimetres read as
 * centimetres, a window read as a duration — so a missed conversion does not
 * crash, it quietly empties or fills a shelf. Every case below is chosen so the
 * unconverted value would produce the opposite call from the converted one, and
 * every assertion is about the resulting facing state, never about the field
 * round-tripping.
 */
describe('integration — a missed conversion would change the shelf, so the shelf is asserted', () => {
  const patchEach = (payload: Payload, key: string, patch: Payload): Payload => ({
    ...payload,
    [key]: (payload[key] as readonly Payload[]).map((entry) => ({ ...entry, ...patch })),
  });

  const start = async (): Promise<RetailerHarness> => twoRetailerPilot().retailers[0]!;

  const context = (harness: RetailerHarness, eventRef: string): WireContext => ({
    retailerCode: harness.retailerId,
    storeCode: ACME_STORE,
    facingRefs: [facingRef(ACME_STORE, 1)],
    sku: OAT_MILK,
    observedAt: OBSERVED,
    eventRef,
  });

  it('reads Arpalus void space as a percentage, not as the ratio it resembles', async () => {
    const acme = await start();

    // 33.5% of the facing is empty and two of three facings are still there: a
    // shelf being worked down, not an empty one. Left unconverted, 33.5 clears
    // the 0.7 void threshold nearly fiftyfold and empties it.
    await acme.publish(
      'arpalus_detection',
      patchEach(arpalusWire(context(acme, 'partial-void'), 'out_of_stock'), 'segments', {
        void_pct: 33.5,
        facings_detected: 2,
      }),
    );

    const facing = await acme.facing(facingIn(ACME_STORE, 1));
    expect(facing?.state).toBe('in_stock');
    expect(facing?.history.events).toHaveLength(0);
    expect(facing?.signals.arpalus_detection?.voidRatio).toBeCloseTo(0.335, 12);
  });

  it('reads Caper gap widths as millimetres, not as the centimetres they resemble', async () => {
    const acme = await start();

    // A 60 mm gap is six centimetres — a fingersbreadth behind an occluded
    // product, and short of the 12 cm a void is called at. Unconverted it is 60,
    // five times the threshold.
    await acme.publish(
      'caper_frame',
      patchEach(caperWire(context(acme, 'narrow-gap'), 'out_of_stock'), 'detections', {
        gapWidthMm: 60,
      }),
    );

    const facing = await acme.facing(facingIn(ACME_STORE, 1));
    expect(facing?.state).toBe('in_stock');
    expect(facing?.history.events).toHaveLength(0);
    expect(facing?.signals.caper_frame?.gapWidthCm).toBe(6);
  });

  it('turns the POS window into a duration observed at its close, not at its open', async () => {
    const acme = await start();

    await acme.publish('pos_movement', posWire(context(acme, 'hourly-batch'), 'out_of_stock'));

    const facing = await acme.facing(facingIn(ACME_STORE, 1));
    const signal = facing?.signals.pos_movement;

    expect(signal?.windowMillis).toBe(60 * 60 * 1000);
    // Sell-through is evidence about the shelf as of the end of the period it
    // covers. Backdating it to the window's open would let a stale reading
    // overwrite a fresher detection in a history ordered by observation time.
    expect(signal?.observedAt).toBe(OBSERVED);
    expect(facing?.history.events[0]?.at).toBe(OBSERVED);
  });

  it('reads a shopper replacement as a substitution, which is out-of-stock evidence', async () => {
    const acme = await start();

    const payload = shopperWire(context(acme, 'replaced-pick'), 'out_of_stock');
    await acme.publish('shopper_scan', {
      ...payload,
      item: { ...(payload['item'] as Payload), result: 'REPLACED' },
    });

    const facing = await acme.facing(facingIn(ACME_STORE, 1));
    expect(facing?.signals.shopper_scan).toMatchObject({ outcome: 'substituted' });
    // A shopper who stood at the shelf and took something else is the strongest
    // out-of-stock evidence this service receives.
    expect(facing?.state).toBe('out_of_stock');
  });

  it('reads Carrot Tags prices as decimal strings in major units', async () => {
    const acme = await start();

    await acme.publish(
      'carrot_tag_label',
      carrotWire(context(acme, 'sweep-price'), { status: 'OK', price: '0.85', lamp: 'OFF' }),
    );

    const facing = await acme.facing(facingIn(ACME_STORE, 1));
    expect(facing?.signals.carrot_tag_label?.displayedPriceCents).toBe(85);
  });
});
