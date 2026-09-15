import { DAY, millis, type Millis } from '../domain/common/time.js';
import type { RetailerId } from '../domain/common/ids.js';
import {
  DETECTION_SOURCES,
  type DetectionSource,
} from '../ports/inbound/detection-ingestion.port.js';
import {
  deadLetterTopic,
  detectionTopic,
  type DetectionSubscription,
} from '../adapters/inbound/detection-stream/topics.js';
import type { KeyRef } from './encryption.js';
import { horizonOf, type RetentionPolicy } from './retention.js';
import { namespacesOf, TenancyConfigError, type RetailerTenant } from './tenancy.js';

/**
 * The event bus topology: one topic per source, per retailer.
 *
 * Broker-neutral by construction. The port this feeds
 * (`EventStreamConsumerPort`) names no broker, and neither does this: what is
 * declared here is topics, partitions, replication, retention, encryption and
 * ACLs, which is the vocabulary Kafka, Redpanda, MSK and Pub/Sub all have. The
 * thin adapter that applies the topology is where a client library belongs.
 *
 * ### Why the retailer is in the topic name
 *
 * A topic is the smallest unit a broker will authorise, retain and meter
 * separately. Putting the retailer in the name means a producer credential can be
 * scoped to `osa.<retailer>.*` and is then physically unable to publish into
 * another tenant's stream — cross-tenant isolation becomes something the broker
 * enforces on connect rather than something the consumer detects after the fact.
 * The same split gives each retailer their own consumer lag, their own quota and
 * their own retention.
 *
 * ### Why detection topics have one partition
 *
 * Producers key by `retailerId`, and a retailer's topic contains exactly one
 * retailer, so every record on it hashes to the same partition whatever the
 * partition count. Provisioning more would be provisioning empty ones. That is a
 * real ceiling, not a free win — one partition is one consumer's worth of
 * throughput — so `assertTopicFitsOnePartition` projects each tenant's peak load
 * against it and fails the plan rather than letting a pilot discover the limit as
 * consumer lag. The way out, when a retailer outgrows it, is to key by store and
 * raise the partition count; per-facing ordering, which is the ordering the event
 * history actually needs, survives that change and per-retailer ordering was
 * never what the domain required.
 */

export type TopicPurpose = 'detection' | 'dead_letter';

export interface TopicAcl {
  /** The broker principal, one per retailer and role. */
  readonly principal: string;
  readonly operation: 'write' | 'read';
  /** Exactly the topic named, or a prefix ending in `.`. */
  readonly resource: string;
}

export interface TopicSpec {
  readonly name: string;
  readonly retailerId: RetailerId;
  readonly source: DetectionSource;
  readonly purpose: TopicPurpose;
  readonly partitions: number;
  readonly replicationFactor: number;
  /** Writes are acknowledged only once this many replicas hold them. */
  readonly minInSyncReplicas: number;
  readonly retention: Millis;
  readonly cleanupPolicy: 'delete';
  /** The retailer's own key; the broker encrypts this topic's log segments under it. */
  readonly encryptionKeyRef: KeyRef;
  readonly acls: readonly TopicAcl[];
}

export interface RetailerBusTopology {
  readonly retailerId: RetailerId;
  readonly topicPrefix: string;
  readonly consumerGroup: string;
  readonly topics: readonly TopicSpec[];
  /** What the detection-stream consumer is wired with for this retailer. */
  readonly subscriptions: readonly DetectionSubscription[];
}

/**
 * How much a source produces, per facing per day, and how big a record is.
 *
 * Order-of-magnitude figures used only for sizing. They are here rather than in a
 * spreadsheet because the number that matters — whether a tenant fits on one
 * partition — is checked in code, and a check against a figure nobody can find is
 * a check nobody will update.
 */
export interface SourceLoad {
  readonly eventsPerFacingPerDay: number;
  readonly bytesPerEvent: number;
}

export const SOURCE_LOAD: { readonly [S in DetectionSource]: SourceLoad } = {
  // One shopper in ten looks for a given facing on a given day, and only a
  // fraction of those are scanned.
  shopper_scan: { eventsPerFacingPerDay: 0.5, bytesPerEvent: 700 },
  // Fixed cameras re-scoring a facing through the trading day.
  arpalus_detection: { eventsPerFacingPerDay: 12, bytesPerEvent: 900 },
  // The busiest source: every cart that passes a facing yields a frame.
  caper_frame: { eventsPerFacingPerDay: 24, bytesPerEvent: 1_200 },
  // Tag sweeps, plus a label event whenever a tag's state changes.
  carrot_tag_label: { eventsPerFacingPerDay: 4, bytesPerEvent: 600 },
  // One movement window per trading hour, per facing that sold.
  pos_movement: { eventsPerFacingPerDay: 16, bytesPerEvent: 400 },
};

/**
 * Peak-to-average ratio across a trading day.
 *
 * Detections concentrate in trading hours and inside those around the two
 * shopping peaks, so sizing on a daily average would under-provision by roughly
 * this factor at exactly the hours a retailer is watching.
 */
export const PEAK_FACTOR = 4;

/** What one broker partition is planned to absorb, with headroom for a redelivery burst. */
export const PARTITION_RECORD_CEILING = 5_000;

/**
 * Seven days on the broker.
 *
 * The bus is a transport, not the record: everything it carries is written to the
 * retailer's own store on ingestion, and the only thing topic retention buys is
 * the ability to replay a consumer outage. A week covers an outage nobody noticed
 * over a holiday weekend; longer would be a second, unencrypted-at-the-column-level
 * copy of every retailer's shelf data sitting where the retention sweep is not.
 */
export const STANDARD_TOPIC_RETENTION: Millis = millis(7 * DAY);

/** Dead letters are evidence, and are read by a human within days or not at all. */
export const STANDARD_DEAD_LETTER_RETENTION: Millis = millis(14 * DAY);

export interface BusOptions {
  readonly replicationFactor?: number;
  readonly detectionRetention?: Millis;
  readonly deadLetterRetention?: Millis;
}

/** Producer principal for one retailer's one source; never granted anything else. */
export const producerPrincipal = (slug: string, source: DetectionSource): string =>
  `osa-producer-${slug}-${source.replaceAll('_', '-')}`;

export const projectedPeakRecordsPerSecond = (
  facings: number,
  source: DetectionSource,
): number => (facings * SOURCE_LOAD[source].eventsPerFacingPerDay * PEAK_FACTOR) / 86_400;

/**
 * Refuses a tenant whose peak load will not fit the single partition their
 * ordering guarantee costs them.
 *
 * Named remedy in the message on purpose: the answer is a producer-contract
 * change, not a bigger broker, and an operator reading this at 3am should not
 * have to rediscover that.
 */
export function assertTopicFitsOnePartition(tenant: RetailerTenant): void {
  for (const source of tenant.sources) {
    const peak = projectedPeakRecordsPerSecond(tenant.scale.facings, source);
    if (peak > PARTITION_RECORD_CEILING) {
      throw new TenancyConfigError(
        `Retailer "${tenant.retailerId}" projects ${Math.round(peak)} ${source} records/s at peak against a ${PARTITION_RECORD_CEILING}/s single-partition ceiling; ${source} must move to a store-keyed, multi-partition topic before this retailer is onboarded`,
      );
    }
  }
}

/**
 * The topics one retailer owns, and the wiring the consumer needs for them.
 *
 * Built from `tenant.sources` rather than from `DETECTION_SOURCES`, so a retailer
 * running four producers gets four topics and four ACLs instead of a fifth that
 * nothing writes to and nobody reviews.
 */
export const planRetailerBus = (
  tenant: RetailerTenant,
  options: BusOptions = {},
): RetailerBusTopology => {
  assertSourcesAreKnown(tenant);
  assertTopicFitsOnePartition(tenant);

  const namespaces = namespacesOf(tenant);
  const replicationFactor = options.replicationFactor ?? 3;
  const detectionRetention = options.detectionRetention ?? STANDARD_TOPIC_RETENTION;
  const deadLetterRetention = options.deadLetterRetention ?? STANDARD_DEAD_LETTER_RETENTION;

  const topics: TopicSpec[] = [];
  const subscriptions: DetectionSubscription[] = [];

  for (const source of tenant.sources) {
    const detection = detectionTopic(tenant.slug, source);
    const deadLetters = deadLetterTopic(tenant.slug, source);

    topics.push({
      name: detection,
      retailerId: tenant.retailerId,
      source,
      purpose: 'detection',
      partitions: 1,
      replicationFactor,
      // One short of the replication factor: survives a single broker loss
      // without the whole tenant's ingestion stalling on it.
      minInSyncReplicas: Math.max(1, replicationFactor - 1),
      retention: detectionRetention,
      cleanupPolicy: 'delete',
      encryptionKeyRef: tenant.encryption.dataKeyRef,
      acls: [
        { principal: producerPrincipal(tenant.slug, source), operation: 'write', resource: detection },
        { principal: namespaces.consumerGroup, operation: 'read', resource: detection },
      ],
    });

    topics.push({
      name: deadLetters,
      retailerId: tenant.retailerId,
      source,
      purpose: 'dead_letter',
      partitions: 1,
      replicationFactor,
      minInSyncReplicas: Math.max(1, replicationFactor - 1),
      retention: deadLetterRetention,
      cleanupPolicy: 'delete',
      encryptionKeyRef: tenant.encryption.dataKeyRef,
      acls: [
        { principal: namespaces.consumerGroup, operation: 'write', resource: deadLetters },
        // The producer's owner reads their own evidence, and only their own.
        {
          principal: producerPrincipal(tenant.slug, source),
          operation: 'read',
          resource: deadLetters,
        },
      ],
    });

    subscriptions.push({ topic: detection, source, retailerId: tenant.retailerId });
  }

  return {
    retailerId: tenant.retailerId,
    topicPrefix: namespaces.topicPrefix,
    consumerGroup: namespaces.consumerGroup,
    topics,
    subscriptions,
  };
};

const assertSourcesAreKnown = (tenant: RetailerTenant): void => {
  if (tenant.sources.length === 0) {
    throw new TenancyConfigError(
      `Retailer "${tenant.retailerId}" declares no detection sources; a pilot with no producer has nothing to measure`,
    );
  }
  const seen = new Set<DetectionSource>();
  for (const source of tenant.sources) {
    if (!(DETECTION_SOURCES as readonly string[]).includes(source)) {
      throw new TenancyConfigError(
        `Retailer "${tenant.retailerId}" declares unknown detection source "${source}"`,
      );
    }
    if (seen.has(source)) {
      throw new TenancyConfigError(
        `Retailer "${tenant.retailerId}" declares detection source "${source}" twice`,
      );
    }
    seen.add(source);
  }
};

export const planBus = (
  tenants: readonly RetailerTenant[],
  options: BusOptions = {},
): readonly RetailerBusTopology[] => tenants.map((tenant) => planRetailerBus(tenant, options));

/** Every subscription across the deployment, which is what the consumer is constructed with. */
export const subscriptionsOf = (
  topologies: readonly RetailerBusTopology[],
): readonly DetectionSubscription[] => topologies.flatMap((topology) => topology.subscriptions);

/**
 * Refuses a topology where one topic, or one principal, spans two retailers.
 *
 * The ACL half is the one worth the code. A duplicated topic name would show up
 * the first time two consumers fought over it; a principal quietly granted on two
 * retailers' prefixes would work perfectly, forever, and is exactly the shape of
 * the incident this design exists to make impossible.
 */
export function assertNoCrossRetailerTopics(
  topologies: readonly RetailerBusTopology[],
): void {
  const topicOwners = new Map<string, RetailerId>();
  const principalOwners = new Map<string, RetailerId>();
  const groupOwners = new Map<string, RetailerId>();

  for (const topology of topologies) {
    const group = groupOwners.get(topology.consumerGroup);
    if (group !== undefined && group !== topology.retailerId) {
      throw new TenancyConfigError(
        `Consumer group "${topology.consumerGroup}" is shared by retailers "${group}" and "${topology.retailerId}"; lag and offsets would be pooled across tenants`,
      );
    }
    groupOwners.set(topology.consumerGroup, topology.retailerId);

    for (const topic of topology.topics) {
      const owner = topicOwners.get(topic.name);
      if (owner !== undefined) {
        throw new TenancyConfigError(
          `Topic "${topic.name}" is claimed by retailers "${owner}" and "${topic.retailerId}"`,
        );
      }
      topicOwners.set(topic.name, topic.retailerId);

      if (!topic.name.startsWith(topology.topicPrefix)) {
        throw new TenancyConfigError(
          `Topic "${topic.name}" sits outside retailer "${topic.retailerId}"'s namespace "${topology.topicPrefix}"`,
        );
      }

      for (const acl of topic.acls) {
        if (!acl.resource.startsWith(topology.topicPrefix)) {
          throw new TenancyConfigError(
            `ACL for "${acl.principal}" grants ${acl.operation} on "${acl.resource}", outside retailer "${topic.retailerId}"'s namespace`,
          );
        }
        const holder = principalOwners.get(acl.principal);
        if (holder !== undefined && holder !== topic.retailerId) {
          throw new TenancyConfigError(
            `Principal "${acl.principal}" is granted on both retailer "${holder}" and retailer "${topic.retailerId}"; one credential must never reach two tenants' streams`,
          );
        }
        principalOwners.set(acl.principal, topic.retailerId);
      }
    }
  }
}

/**
 * Refuses a bus that outlives the idempotency ledger backing it.
 *
 * The failure this prevents is quiet and expensive: replay a partition whose
 * records are older than the ledger's own horizon and every one of them is a new
 * event again, doubling a retailer's history for that window and moving their
 * availability index with it. The two numbers live in different modules and are
 * set by different concerns, which is exactly why they are compared here.
 */
export function assertBusRetentionFits(
  topologies: readonly RetailerBusTopology[],
  retentionOf: (retailerId: RetailerId) => RetentionPolicy,
): void {
  for (const topology of topologies) {
    const ledger = horizonOf(retentionOf(topology.retailerId), 'ingestion_ledger');
    for (const topic of topology.topics) {
      if (topic.purpose === 'detection' && topic.retention > ledger) {
        throw new TenancyConfigError(
          `Topic "${topic.name}" retains ${topic.retention}ms but retailer "${topic.retailerId}"'s ingestion ledger only keeps ${ledger}ms; a replay past the ledger would re-ingest every record as new`,
        );
      }
    }
  }
}
