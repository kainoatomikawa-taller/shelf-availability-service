import { describe, expect, it } from 'vitest';
import {
  assertBusRetentionFits,
  assertNoCrossRetailerTopics,
  assertTopicFitsOnePartition,
  DAY,
  DETECTION_SOURCES,
  deadLetterTopic,
  detectionTopic,
  detectionTopicsFor,
  millis,
  parseDetectionTopic,
  partitionKeyFor,
  planBus,
  planRetailerBus,
  producerPrincipal,
  projectedPeakRecordsPerSecond,
  retailerTopicPrefix,
  standardRetention,
  STANDARD_TOPIC_RETENTION,
  subscriptionsOf,
  type RetailerTenant,
} from '../src/index.js';
import { ACME, RIVAL } from './support/fixtures.js';
import { ACME_SLUG, ACME_TENANT, RIVAL_SLUG, RIVAL_TENANT, TWO_TENANTS } from './support/tenancy.js';

/**
 * The event bus: one topic per source, per retailer.
 *
 * Two things are being established. That the topology a deployment applies
 * actually has a topic for every source each retailer runs — the acceptance
 * criterion — and that no principal, group or topic in it spans two retailers,
 * which is the reason for putting the retailer in the topic name at all.
 */

describe('topic naming', () => {
  it('names a topic by retailer and by source', () => {
    expect(detectionTopic(ACME_SLUG, 'caper_frame')).toBe('osa.acme-grocery.detections.caper_frame');
    expect(deadLetterTopic(ACME_SLUG, 'caper_frame')).toBe(
      'osa.acme-grocery.dead-letters.caper_frame',
    );
    expect(retailerTopicPrefix(ACME_SLUG)).toBe('osa.acme-grocery.');
  });

  it('gives every source its own topic, so one bad producer poisons only itself', () => {
    const topics = detectionTopicsFor(ACME_SLUG);

    expect(topics).toHaveLength(DETECTION_SOURCES.length);
    expect(new Set(topics).size).toBe(DETECTION_SOURCES.length);
  });

  it('reads a topic name back into the retailer and source it encodes', () => {
    expect(parseDetectionTopic('osa.acme-grocery.detections.pos_movement')).toEqual({
      retailer: 'acme-grocery',
      source: 'pos_movement',
    });
  });

  it.each([
    'osa.acme-grocery.detections.weather_feed',
    'osa.acme-grocery.dead-letters.pos_movement',
    'osa.acme-grocery.detections',
    'kafka.acme-grocery.detections.pos_movement',
    'osa.acme.grocery.detections.pos_movement',
  ])('does not read "%s" as one of ours', (topic) => {
    expect(parseDetectionTopic(topic)).toBeNull();
  });

  it('refuses a retailer segment that would silently re-parse as another retailer', () => {
    // `osa.acme.eu.detections.x` has five segments and would parse — as a
    // different retailer — so the grammar refuses the segment rather than the name.
    expect(() => detectionTopic('acme.eu', 'pos_movement')).toThrow(/one lower-case topic segment/);
  });

  it('keys by retailer inside the topic, which is the redundant half of the check', () => {
    expect(partitionKeyFor(ACME)).toBe(ACME);
  });
});

describe('the topology for one retailer', () => {
  const topology = planRetailerBus(ACME_TENANT);

  it('provisions a detection topic and a dead-letter topic for every source it runs', () => {
    const detection = topology.topics.filter((topic) => topic.purpose === 'detection');
    const deadLetters = topology.topics.filter((topic) => topic.purpose === 'dead_letter');

    expect(detection).toHaveLength(DETECTION_SOURCES.length);
    expect(deadLetters).toHaveLength(DETECTION_SOURCES.length);
    for (const source of DETECTION_SOURCES) {
      expect(detection.map((topic) => topic.name)).toContain(detectionTopic(ACME_SLUG, source));
    }
  });

  it('provisions only the sources a retailer actually runs', () => {
    const twoSources: RetailerTenant = {
      ...ACME_TENANT,
      sources: ['pos_movement', 'shopper_scan'],
    };

    const narrow = planRetailerBus(twoSources);

    expect(narrow.topics).toHaveLength(4);
    expect(narrow.subscriptions.map((subscription) => subscription.source)).toEqual([
      'pos_movement',
      'shopper_scan',
    ]);
  });

  it('refuses a retailer that runs no producer at all', () => {
    expect(() => planRetailerBus({ ...ACME_TENANT, sources: [] })).toThrow(
      /declares no detection sources/,
    );
  });

  it('encrypts every topic under the retailer\'s own key', () => {
    for (const topic of topology.topics) {
      expect(topic.encryptionKeyRef).toBe(ACME_TENANT.encryption.dataKeyRef);
    }
  });

  it('gives detection topics one partition, because the key can only ever fill one', () => {
    for (const topic of topology.topics) {
      expect(topic.partitions).toBe(1);
      expect(topic.minInSyncReplicas).toBeLessThan(topic.replicationFactor);
    }
  });

  it('scopes every ACL inside the retailer\'s own namespace', () => {
    for (const topic of topology.topics) {
      for (const acl of topic.acls) {
        expect(acl.resource.startsWith('osa.acme-grocery.')).toBe(true);
      }
    }
  });

  it('gives each producer write on its own topic and read on its own dead letters only', () => {
    const principal = producerPrincipal(ACME_SLUG, 'caper_frame');
    const granted = topology.topics
      .flatMap((topic) => topic.acls.map((acl) => ({ ...acl, topic: topic.name })))
      .filter((acl) => acl.principal === principal);

    expect(granted).toHaveLength(2);
    expect(granted.find((acl) => acl.operation === 'write')?.topic).toBe(
      detectionTopic(ACME_SLUG, 'caper_frame'),
    );
    expect(granted.find((acl) => acl.operation === 'read')?.topic).toBe(
      deadLetterTopic(ACME_SLUG, 'caper_frame'),
    );
  });

  it('gives the retailer their own consumer group, so lag is per retailer', () => {
    expect(topology.consumerGroup).toBe('osa-ingest-acme-grocery');
    expect(planRetailerBus(RIVAL_TENANT).consumerGroup).toBe('osa-ingest-rival-mart');
  });

  it('produces exactly the subscriptions the consumer is wired with', () => {
    for (const subscription of topology.subscriptions) {
      expect(subscription.retailerId).toBe(ACME);
      expect(subscription.topic).toBe(detectionTopic(ACME_SLUG, subscription.source));
    }
  });
});

describe('a topology across retailers', () => {
  const topologies = planBus(TWO_TENANTS);

  it('shares no topic, no principal and no consumer group', () => {
    expect(() => assertNoCrossRetailerTopics(topologies)).not.toThrow();

    const names = topologies.flatMap((topology) => topology.topics.map((topic) => topic.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('hands each consumer only its own retailer\'s subscriptions', () => {
    const subscriptions = subscriptionsOf(topologies);

    expect(subscriptions.filter((s) => s.retailerId === ACME)).toHaveLength(5);
    expect(subscriptions.filter((s) => s.retailerId === RIVAL)).toHaveLength(5);
    for (const subscription of subscriptions) {
      const slug = subscription.retailerId === ACME ? ACME_SLUG : RIVAL_SLUG;
      expect(subscription.topic.startsWith(`osa.${slug}.`)).toBe(true);
    }
  });

  it('refuses one principal granted on two retailers\' streams', () => {
    // The shape of the incident this design exists to prevent: it would work
    // perfectly, forever, and nothing downstream would notice.
    const [acme, rival] = topologies;
    if (acme === undefined || rival === undefined) throw new Error('expected two topologies');
    const leaked = {
      ...rival,
      topics: rival.topics.map((topic, index) =>
        index === 0
          ? {
              ...topic,
              acls: [
                ...topic.acls,
                {
                  principal: producerPrincipal(ACME_SLUG, 'caper_frame'),
                  operation: 'read' as const,
                  resource: topic.name,
                },
              ],
            }
          : topic,
      ),
    };

    expect(() => assertNoCrossRetailerTopics([acme, leaked])).toThrow(
      /granted on both retailer .* and retailer/,
    );
  });

  it('refuses two retailers sharing a consumer group', () => {
    const [acme, rival] = topologies;
    if (acme === undefined || rival === undefined) throw new Error('expected two topologies');

    expect(() =>
      assertNoCrossRetailerTopics([acme, { ...rival, consumerGroup: acme.consumerGroup }]),
    ).toThrow(/lag and offsets would be pooled/);
  });
});

describe('sizing the bus against what it is wired to', () => {
  it('refuses a retailer whose peak will not fit the single partition ordering costs them', () => {
    const enormous: RetailerTenant = {
      ...ACME_TENANT,
      scale: { stores: 4_000, facings: 40_000_000 },
    };

    expect(() => assertTopicFitsOnePartition(enormous)).toThrow(
      /must move to a store-keyed, multi-partition topic/,
    );
  });

  it('projects a pilot-scale retailer comfortably inside the ceiling', () => {
    expect(() => assertTopicFitsOnePartition(ACME_TENANT)).not.toThrow();
    expect(projectedPeakRecordsPerSecond(20_000, 'caper_frame')).toBeLessThan(100);
  });

  it('refuses a bus that retains records past the ledger that deduplicates them', () => {
    const topologies = planBus([ACME_TENANT], {
      // Sixty days on the broker against a thirty-day ledger: a replay would
      // re-ingest every record as new and double the retailer's history.
      detectionRetention: millis(60 * DAY),
    });

    expect(() =>
      assertBusRetentionFits(topologies, () => standardRetention(ACME)),
    ).toThrow(/replay past the ledger would re-ingest every record as new/);
  });

  it('accepts the standard week of topic retention against the standard ledger', () => {
    const topologies = planBus([ACME_TENANT]);

    expect(topologies[0]?.topics[0]?.retention).toBe(STANDARD_TOPIC_RETENTION);
    expect(() =>
      assertBusRetentionFits(topologies, () => standardRetention(ACME)),
    ).not.toThrow();
  });
});
